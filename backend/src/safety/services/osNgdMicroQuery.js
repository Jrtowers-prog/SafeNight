/**
 * osNgdMicroQuery.js — Verify uncertain street-light segments using tiny OS NGD queries.
 *
 * Instead of querying a large bbox for every route, we only query small bboxes
 * around segments where OSM light coverage is uncertain. This minimizes API cost
 * while filling data gaps.
 */

const { fetchOsStreetLightsOnly } = require('./osNgdClient');
const { fastDistance } = require('./geo');
const { createSafetyCacheStore } = require('./cacheStore');
const {
  queryBySegment,
  upsert,
  upsertBatch,
  normalizeToCacheRecord,
  normalizeBatch,
} = require('./lightsCacheClient');

const MICRO_QUERY_BUDGET_PER_ROUTE = Math.max(0, Number(process.env.OS_NGD_MICRO_QUERY_BUDGET_PER_ROUTE || 8)); // base cluster budget per route
const MICRO_QUERY_MAX_DYNAMIC_BUDGET = Math.max(
  MICRO_QUERY_BUDGET_PER_ROUTE,
  Number(process.env.OS_NGD_MICRO_QUERY_MAX_DYNAMIC_BUDGET || 20),
);
const MICRO_QUERY_CELL_SIZE_M = Math.max(
  60,
  Number(process.env.OS_NGD_MICRO_QUERY_CELL_SIZE_M || 120),
);
const MICRO_QUERY_MIN_SPACING_M = Math.max(
  50,
  Number(process.env.OS_NGD_MICRO_QUERY_MIN_SPACING_M || 120),
);
const SEGMENT_VERIFY_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const verifyCache = createSafetyCacheStore({
  namespace: 'os-ngd-verify',
  ttlMs: SEGMENT_VERIFY_CACHE_TTL_MS,
  maxEntries: 200,
});

function toSegmentMidpointNode(edge, osmNodes) {
  const nA = osmNodes.get(edge.from);
  const nB = osmNodes.get(edge.to);
  if (!nA || !nB) return null;
  return {
    lat: (nA.lat + nB.lat) / 2,
    lon: (nA.lng + nB.lng) / 2,
    type: 'node',
    tags: {},
  };
}

function toCacheDecisionValue(status, reason) {
  if (status === 'lit') {
    return { confidentLit: true, reason: reason || 'verified_by_os_ngd' };
  }
  if (status === 'unlit') {
    return { confidentLit: false, reason: reason || 'no_lights_in_os_ngd' };
  }
  return { confidentLit: null, reason: reason || 'uncertain' };
}

async function persistSegmentDecision(seg, osmNodes, litStatus, reason) {
  try {
    const midpointNode = toSegmentMidpointNode(seg.edge, osmNodes);
    if (!midpointNode) return;
    const record = normalizeToCacheRecord(midpointNode, 'os_ngd', {
      litStatus,
      confidence: litStatus === 'uncertain' ? 0.5 : 0.9,
      confidenceReason: reason,
    });
    if (record) {
      await upsert(record);
    }
  } catch {
    // Best-effort persistence; do not fail routing.
  }
}

function mapPersistentRecordToVerification(record) {
  if (!record) return null;
  const source = String(record.source || '');
  if (!source.startsWith('os_ngd')) return null;
  const status = record.lit_status;
  if (!status || status === 'unknown') return null;
  return {
    lit_status: status,
    confidence: typeof record.confidence === 'number' ? record.confidence : 0.9,
    reason: record.confidence_reason || 'cached_os_ngd_verification',
  };
}

/**
 * Compute a tight bbox around a segment with buffer.
 */
function segmentBbox(edge, osmNodes, bufferM = 30) {
  const nA = osmNodes.get(edge.from);
  const nB = osmNodes.get(edge.to);
  if (!nA || !nB) return null;

  const bufferDeg = bufferM / 111320;
  return {
    south: Math.min(nA.lat, nB.lat) - bufferDeg,
    west: Math.min(nA.lng, nB.lng) - bufferDeg,
    north: Math.max(nA.lat, nB.lat) + bufferDeg,
    east: Math.max(nA.lng, nB.lng) + bufferDeg,
  };
}

/**
 * Group nearby uncertain segments into clusters for batch querying.
 * Uses simple distance-based clustering.
 */
function clusterSegments(uncertainSegments, osmNodes, maxClusterRadiusM = 100) {
  const clusters = [];
  const assigned = new Set();

  for (let i = 0; i < uncertainSegments.length; i++) {
    if (assigned.has(i)) continue;

    const seg = uncertainSegments[i];
    const nA = osmNodes.get(seg.edge.from);
    const nB = osmNodes.get(seg.edge.to);
    if (!nA || !nB) continue;
    const midLat = (nA.lat + nB.lat) / 2;
    const midLng = (nA.lng + nB.lng) / 2;

    const cluster = [seg];
    assigned.add(i);

    for (let j = i + 1; j < uncertainSegments.length; j++) {
      if (assigned.has(j)) continue;
      const other = uncertainSegments[j];
      const oA = osmNodes.get(other.edge.from);
      const oB = osmNodes.get(other.edge.to);
      if (!oA || !oB) continue;
      const oMidLat = (oA.lat + oB.lat) / 2;
      const oMidLng = (oA.lng + oB.lng) / 2;

      if (fastDistance(midLat, midLng, oMidLat, oMidLng) <= maxClusterRadiusM) {
        cluster.push(other);
        assigned.add(j);
      }
    }

    clusters.push(cluster);
  }

  return clusters;
}

/**
 * Compute union bbox for a cluster of segments.
 */
function clusterBbox(cluster, osmNodes, bufferM = 30) {
  let minLat = Infinity, maxLat = -Infinity;
  let minLng = Infinity, maxLng = -Infinity;

  for (const seg of cluster) {
    const nA = osmNodes.get(seg.edge.from);
    const nB = osmNodes.get(seg.edge.to);
    if (!nA || !nB) continue;
    minLat = Math.min(minLat, nA.lat, nB.lat);
    maxLat = Math.max(maxLat, nA.lat, nB.lat);
    minLng = Math.min(minLng, nA.lng, nB.lng);
    maxLng = Math.max(maxLng, nA.lng, nB.lng);
  }

  if (!Number.isFinite(minLat)) return null;

  const bufferDeg = bufferM / 111320;
  return {
    south: minLat - bufferDeg,
    west: minLng - bufferDeg,
    north: maxLat + bufferDeg,
    east: maxLng + bufferDeg,
  };
}

function segmentCellPlan(edge, osmNodes, cellSizeM = MICRO_QUERY_CELL_SIZE_M) {
  const bbox = segmentBbox(edge, osmNodes, 30);
  if (!bbox) return null;

  const center = bboxCenter(bbox);
  const latStepDeg = cellSizeM / 111320;
  const lngScale = Math.max(0.2, Math.cos((center.lat * Math.PI) / 180));
  const lngStepDeg = cellSizeM / (111320 * lngScale);

  const latIndex = Math.floor(center.lat / latStepDeg);
  const lngIndex = Math.floor(center.lng / lngStepDeg);

  return {
    cellKey: `${latStepDeg.toFixed(7)}:${lngStepDeg.toFixed(7)}:${latIndex}:${lngIndex}`,
    centerLat: center.lat,
    centerLng: center.lng,
    bbox,
  };
}

function candidateBoundingBox(candidate, osmNodes, bufferM = 30) {
  if (candidate?.bbox) {
    return candidate.bbox;
  }

  if (Array.isArray(candidate?.edgeIdxs) && candidate.edgeIdxs.length > 0) {
    let minLat = Infinity;
    let minLng = Infinity;
    let maxLat = -Infinity;
    let maxLng = -Infinity;

    for (const edgeIdx of candidate.edgeIdxs) {
      const edge = candidate.edgeIdx === edgeIdx ? candidate.edge : candidate.edge;
      if (!edge) continue;
      const nA = osmNodes.get(edge.from);
      const nB = osmNodes.get(edge.to);
      if (!nA || !nB) continue;
      minLat = Math.min(minLat, nA.lat, nB.lat);
      minLng = Math.min(minLng, nA.lng, nB.lng);
      maxLat = Math.max(maxLat, nA.lat, nB.lat);
      maxLng = Math.max(maxLng, nA.lng, nB.lng);
    }

    if (Number.isFinite(minLat)) {
      const bufferDeg = bufferM / 111320;
      return {
        south: minLat - bufferDeg,
        west: minLng - bufferDeg,
        north: maxLat + bufferDeg,
        east: maxLng + bufferDeg,
      };
    }
  }

  if (candidate?.edge) {
    return segmentBbox(candidate.edge, osmNodes, bufferM);
  }

  return null;
}

function segmentCellPlanForCandidate(candidate, osmNodes, cellSizeM = MICRO_QUERY_CELL_SIZE_M) {
  const bbox = candidateBoundingBox(candidate, osmNodes, 30);
  if (!bbox) return null;

  const center = bboxCenter(bbox);
  const latStepDeg = cellSizeM / 111320;
  const lngScale = Math.max(0.2, Math.cos((center.lat * Math.PI) / 180));
  const lngStepDeg = cellSizeM / (111320 * lngScale);

  const latIndex = Math.floor(center.lat / latStepDeg);
  const lngIndex = Math.floor(center.lng / lngStepDeg);

  return {
    cellKey: `${latStepDeg.toFixed(7)}:${lngStepDeg.toFixed(7)}:${latIndex}:${lngIndex}`,
    centerLat: center.lat,
    centerLng: center.lng,
    bbox,
  };
}

function groupSegmentsByCell(segments, osmNodes) {
  const cells = new Map();

  for (const seg of segments) {
    const plan = (seg?.bbox || Array.isArray(seg?.edgeIdxs))
      ? segmentCellPlanForCandidate(seg, osmNodes)
      : segmentCellPlan(seg.edge, osmNodes);
    if (!plan) continue;

    const existing = cells.get(plan.cellKey);
    if (existing) {
      existing.cluster.push(seg);
      if (seg.routeKey) existing.routeKeys.add(seg.routeKey);
      existing.totalLength += seg.edge.distance || 0;
      existing.minConfidence = Math.min(
        existing.minConfidence,
        Number.isFinite(seg.confidence) ? seg.confidence : 1,
      );
      if (!existing.representative || (seg.confidence ?? 1) < (existing.representative.confidence ?? 1)) {
        existing.representative = seg;
      }
      continue;
    }

    cells.set(plan.cellKey, {
      cellKey: plan.cellKey,
      bbox: plan.bbox,
      centerLat: plan.centerLat,
      centerLng: plan.centerLng,
      cluster: [seg],
      routeKeys: new Set(seg.routeKey ? [seg.routeKey] : []),
      totalLength: seg.edge?.distance || seg.distance || 0,
      minConfidence: Number.isFinite(seg.confidence) ? seg.confidence : 1,
      representative: seg,
    });
  }

  return [...cells.values()];
}

function bboxCenter(bbox) {
  return {
    lat: (bbox.south + bbox.north) / 2,
    lng: (bbox.west + bbox.east) / 2,
  };
}

function bboxArea(bbox) {
  const width = Math.max(0, bbox.east - bbox.west);
  const height = Math.max(0, bbox.north - bbox.south);
  return width * height;
}

function bboxIntersectionArea(a, b) {
  const west = Math.max(a.west, b.west);
  const south = Math.max(a.south, b.south);
  const east = Math.min(a.east, b.east);
  const north = Math.min(a.north, b.north);
  if (east <= west || north <= south) return 0;
  return (east - west) * (north - south);
}

function bboxOverlapRatio(a, b) {
  const intersection = bboxIntersectionArea(a, b);
  if (intersection <= 0) return 0;
  const minArea = Math.max(1e-12, Math.min(bboxArea(a), bboxArea(b)));
  return intersection / minArea;
}

function unionBbox(a, b) {
  return {
    south: Math.min(a.south, b.south),
    west: Math.min(a.west, b.west),
    north: Math.max(a.north, b.north),
    east: Math.max(a.east, b.east),
  };
}

function mergeOverlappingClusterEntries(clusterEntries) {
  const merged = [];

  for (const entry of clusterEntries) {
    let mergedInto = null;
    const entryCenter = bboxCenter(entry.bbox);

    for (const existing of merged) {
      const existingCenter = bboxCenter(existing.bbox);
      const overlap = bboxOverlapRatio(entry.bbox, existing.bbox);
      const dist = fastDistance(entryCenter.lat, entryCenter.lng, existingCenter.lat, existingCenter.lng);
      if (overlap >= 0.25 || dist <= MICRO_QUERY_MIN_SPACING_M) {
        mergedInto = existing;
        break;
      }
    }

    if (!mergedInto) {
      merged.push({
        cluster: [...entry.cluster],
        bbox: entry.bbox,
        routeKeys: new Set(entry.routeKeys || []),
      });
      continue;
    }

    const seenEdgeIdx = new Set(mergedInto.cluster.map((seg) => seg.edgeIdx));
    for (const seg of entry.cluster) {
      if (!seenEdgeIdx.has(seg.edgeIdx)) {
        mergedInto.cluster.push(seg);
        seenEdgeIdx.add(seg.edgeIdx);
      }
    }
    for (const routeKey of entry.routeKeys || []) {
      mergedInto.routeKeys.add(routeKey);
    }
    mergedInto.bbox = unionBbox(mergedInto.bbox, entry.bbox);
  }

  return merged;
}

function clusterPriorityScore(entry) {
  return (1 - entry.minConfidence) * 1000 + entry.totalLength;
}

function selectDistributedClusters(candidates, budget) {
  if (budget <= 0 || candidates.length === 0) return [];

  const selected = [];
  const remaining = [...candidates];

  while (selected.length < budget && remaining.length > 0) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const cCenter = bboxCenter(candidate.bbox);
      const priority = clusterPriorityScore(candidate);
      const candidateRouteKeys = new Set(candidate.routeKeys || []);

      let spacingBonus = 0;
      let tooClose = false;
      for (const chosen of selected) {
        const chosenCenter = bboxCenter(chosen.bbox);
        const distance = fastDistance(cCenter.lat, cCenter.lng, chosenCenter.lat, chosenCenter.lng);
        const overlap = bboxOverlapRatio(candidate.bbox, chosen.bbox);
        const sameRoute = (chosen.routeKeys || []).some((routeKey) => candidateRouteKeys.has(routeKey));
        if (sameRoute && (distance < MICRO_QUERY_MIN_SPACING_M * 2 || overlap > 0.02)) {
          tooClose = true;
          break;
        }
        if (distance < MICRO_QUERY_MIN_SPACING_M && overlap > 0.05) {
          tooClose = true;
          break;
        }
        spacingBonus += Math.min(200, distance);
      }
      if (tooClose) continue;

      const score = priority + spacingBonus;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) {
      remaining.sort((a, b) => clusterPriorityScore(b) - clusterPriorityScore(a));
      selected.push(remaining.shift());
      continue;
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

function setVerificationForSegment(verifiedSegments, seg, result) {
  if (Array.isArray(seg?.edgeIdxs) && seg.edgeIdxs.length > 0) {
    for (const edgeIdx of seg.edgeIdxs) {
      verifiedSegments.set(edgeIdx, result);
    }
    return;
  }

  if (Number.isInteger(seg?.edgeIdx)) {
    verifiedSegments.set(seg.edgeIdx, result);
  }
}

/**
 * Verify uncertain light segments using OS NGD micro-queries.
 *
 * @param {Array} uncertainSegments — edges needing verification
 * @param {Map} osmNodes — node id → { lat, lng }
 * @param {Object} options — { signal, routeKey }
 * @returns {Object} { verifiedLights: Array, verifiedSegments: Map<edgeIdx, {confidence, reason}> }
 */
async function verifyLightGaps(uncertainSegments, osmNodes, options = {}) {
  const { signal = null, routeKey = '' } = options;

  if (!uncertainSegments || uncertainSegments.length === 0) {
    return { verifiedLights: [], verifiedSegments: new Map() };
  }

  // Check cache first
  const verifiedSegments = new Map();
  const queryFootprints = [];
  const pendingCells = [];
  const stats = {
    memoryCacheHits: 0,
    persistentCacheHits: 0,
    persistedDecisions: 0,
    queriedClusters: 0,
    skippedClustersBudget: 0,
    totalCellsBeforeDedup: uncertainSegments.length,
    totalCellsAfterDedup: 0,
  };

  const cellEntries = groupSegmentsByCell(uncertainSegments, osmNodes);
  stats.totalCellsAfterDedup = cellEntries.length;

  for (const cell of cellEntries) {
    const cacheKey = cell.cellKey;
    if (cacheKey) {
      console.log(`[os-ngd-micro] Checking cache for cell ${cacheKey} before OS query`);
      const cached = await verifyCache.get(cacheKey);
      if (cached !== null) {
        stats.memoryCacheHits += 1;
        console.log(`[os-ngd-micro] Cache hit (memory) for cell ${cacheKey}`);
        const resolved = cached.confidentLit == null
          ? {
              lit_status: 'uncertain',
              confidence: 0.5,
              reason: cached.reason || 'cached_uncertain',
            }
          : {
              lit_status: cached.confidentLit ? 'lit' : 'unlit',
              confidence: 0.9,
              reason: cached.reason,
            };
        for (const seg of cell.cluster) {
          setVerificationForSegment(verifiedSegments, seg, resolved);
        }
        continue;
      }

      // Supabase-backed persistent cache lookup (best effort)
      console.log(`[os-ngd-micro] Checking persistent cache for cell ${cacheKey}`);
      const persistentRecord = await queryBySegment(cell.representative.edge, osmNodes);
      const persistent = mapPersistentRecordToVerification(persistentRecord);
      if (persistent) {
        stats.persistentCacheHits += 1;
        console.log(`[os-ngd-micro] Cache hit (Supabase) for cell ${cacheKey}`);
        for (const seg of cell.cluster) {
          setVerificationForSegment(verifiedSegments, seg, persistent);
        }
        const cachedValue = toCacheDecisionValue(persistent.lit_status, persistent.reason);
        await verifyCache.set(cacheKey, cachedValue);
        continue;
      }

      console.log(`[os-ngd-micro] Cache miss for cell ${cacheKey}; querying OS NGD`);
    }
    pendingCells.push(cell);
  }

  if (pendingCells.length === 0) {
    return { verifiedLights: [], verifiedSegments, queryFootprints, stats };
  }

  // Cluster segments for efficient batching
  const clusters = pendingCells;
  const clusterEntries = clusters
    .map((cluster) => ({ ...cluster }))
    .filter((entry) => !!entry.bbox);
  const mergedClusterEntries = mergeOverlappingClusterEntries(clusterEntries);

  // Respect budget: only query top clusters by total segment length
  const clustersWithLength = mergedClusterEntries.map((entry) => ({
    cluster: entry.cluster,
    bbox: entry.bbox,
    centerLat: bboxCenter(entry.bbox).lat,
    centerLng: bboxCenter(entry.bbox).lng,
    routeKeys: [...(entry.routeKeys || [])],
    totalLength: entry.cluster.reduce((sum, seg) => sum + (seg.edge.distance || 0), 0),
    minConfidence: entry.cluster.reduce(
      (min, seg) => Math.min(min, Number.isFinite(seg.confidence) ? seg.confidence : 1),
      1,
    ),
  }));
  clustersWithLength.sort((a, b) => clusterPriorityScore(b) - clusterPriorityScore(a));

  const dynamicBudget = Math.max(
    MICRO_QUERY_BUDGET_PER_ROUTE,
    Math.ceil(pendingCells.length / 10),
  );
  const budget = Math.min(MICRO_QUERY_MAX_DYNAMIC_BUDGET, dynamicBudget);
  const clustersToQuery = selectDistributedClusters(clustersWithLength, budget);
  const selectedClusterSet = new Set(clustersToQuery);
  const skippedClusters = clustersWithLength.filter((entry) => !selectedClusterSet.has(entry));
  stats.queriedClusters = clustersToQuery.length;
  stats.skippedClustersBudget = skippedClusters.length;
  stats.totalClustersBeforeMerge = clusters.length;
  stats.totalClustersAfterMerge = clustersWithLength.length;

  const verifiedLights = [];
  const queryPromises = [];

  for (const { cluster, bbox, cellKey, centerLat, centerLng } of clustersToQuery) {
    if (!bbox) continue;

    const queryPromise = (async () => {
      try {
        const result = await fetchOsStreetLightsOnly(bbox, { signal, routeKey });
        return { cluster, result, bbox, cellKey, centerLat, centerLng };
      } catch (err) {
        console.warn(`[os-ngd-micro] Query failed: ${err.message}`);
        return { cluster, result: { elements: [] }, error: err, bbox, cellKey, centerLat, centerLng };
      }
    })();

    queryPromises.push(queryPromise);
  }

  const queryResults = await Promise.all(queryPromises);

  for (const { cluster, result, error, bbox, cellKey, centerLat, centerLng } of queryResults) {
    queryFootprints.push({
      cellKey,
      south: bbox.south,
      west: bbox.west,
      north: bbox.north,
      east: bbox.east,
      centerLat,
      centerLng,
      segmentCount: cluster.length,
      status: error ? 'failed' : 'queried',
    });

    if (error) {
      // Mark all segments in this cluster as unverified (keep uncertain)
      for (const seg of cluster) {
        setVerificationForSegment(verifiedSegments, seg, {
          lit_status: 'uncertain',
          confidence: 0.5,
          reason: 'os_ngd_query_failed',
        });
      }
      continue;
    }

    // For each segment in cluster, check if any lights are nearby
    for (const seg of cluster) {
      const spanBox = candidateBoundingBox(seg, osmNodes, 30);
      if (!spanBox) continue;
      const midLat = (spanBox.south + spanBox.north) / 2;
      const midLng = (spanBox.west + spanBox.east) / 2;

      const lightsNearby = (result.elements || []).filter((el) => {
        if (!el.lat || !el.lon) return false;
        return fastDistance(midLat, midLng, el.lat, el.lon) <= 40;
      });

      const hasLights = lightsNearby.length > 0;

      if (hasLights) {
        setVerificationForSegment(verifiedSegments, seg, {
          lit_status: 'lit',
          confidence: 0.9,
          reason: 'verified_by_os_ngd',
        });
        verifiedLights.push(...lightsNearby);
        if (cellKey) {
          await verifyCache.set(cellKey, { confidentLit: true, reason: 'verified_by_os_ngd' });
        }
        await persistSegmentDecision(cluster[0], osmNodes, 'lit', 'verified_by_os_ngd');
        stats.persistedDecisions += 1;
      } else {
        setVerificationForSegment(verifiedSegments, seg, {
          lit_status: 'unlit',
          confidence: 0.9,
          reason: 'no_lights_in_os_ngd',
        });
        if (cellKey) {
          await verifyCache.set(cellKey, { confidentLit: false, reason: 'no_lights_in_os_ngd' });
        }
        await persistSegmentDecision(cluster[0], osmNodes, 'unlit', 'no_lights_in_os_ngd');
        stats.persistedDecisions += 1;
      }
    }
  }

  if (verifiedLights.length > 0) {
    const records = normalizeBatch(verifiedLights, 'os_ngd', 'lit');
    if (records.length > 0) {
      console.log(`[os-ngd-micro] Persisting ${records.length} verified lights to cache`);
      await upsertBatch(records);
    }
  }

  // Mark remaining clusters (over budget) as unverified
  for (const { cluster } of skippedClusters) {
    for (const seg of cluster) {
      setVerificationForSegment(verifiedSegments, seg, {
        lit_status: 'uncertain',
        confidence: 0.5,
        reason: 'verification_budget_exhausted',
      });
      const skippedCellKey = Array.isArray(seg.edgeIdxs)
        ? segmentCellPlanForCandidate(seg, osmNodes)?.cellKey || null
        : segmentCellPlan(seg.edge, osmNodes)?.cellKey || null;
      if (skippedCellKey) {
        await verifyCache.set(skippedCellKey, {
          confidentLit: null,
          reason: 'verification_budget_exhausted',
        });
      }
      await persistSegmentDecision(cluster[0], osmNodes, 'uncertain', 'verification_budget_exhausted');
      stats.persistedDecisions += 1;
    }
  }

  return { verifiedLights, verifiedSegments, queryFootprints, stats };
}

function __resetForTests() {
  verifyCache.clearMemory();
}

module.exports = {
  verifyLightGaps,
  clusterSegments,
  clusterBbox,
  segmentBbox,
  __resetForTests,
};
