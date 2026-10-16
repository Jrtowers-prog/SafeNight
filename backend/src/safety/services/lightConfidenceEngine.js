/**
 * lightConfidenceEngine.js — Per-segment street-light confidence scoring.
 *
 * OSM street-light coverage is volunteer-mapped and patchy. This module
 * distinguishes "genuinely unlit" from "not yet mapped" so we can flag
 * uncertain segments for OS NGD micro-query verification.
 */

const { fastDistance, findNearby } = require('./geo');

const CONFIDENCE_THRESHOLDS = {
  LIT: 0.6,      // score >= 0.6 → treat as lit
  UNLIT: 0.2,    // score <= 0.2 → treat as unlit
};

const URBAN_HIGHWAYS = new Set([
  'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'living_street', 'pedestrian',
]);

const RURAL_HIGHWAYS = new Set([
  'track', 'path', 'footway', 'cycleway', 'steps',
]);

/**
 * Compute light-coverage confidence for a single road segment (edge).
 *
 * @param {Object} way — the parent OSM way with tags
 * @param {Object} edge — { from, to, distance, highway, ... }
 * @param {Map} osmNodes — id → { lat, lng }
 * @param {Array} nearbyLightNodes — street_lamp nodes within 50m of this segment
 * @param {Array} adjacentWays — connected ways (for continuity heuristic)
 * @returns {Object} { score, reason, needsVerification }
 */
function computeLightConfidence(
  way,
  edge,
  osmNodes,
  nearbyLightNodes,
  adjacentWays,
  probePoint = null,
) {
  const tags = way.tags || {};
  const highway = edge.highway || tags.highway;

  // ── Base score from explicit tagging ──
  let score = 0;
  let reason = '';

  if (tags.lit === 'yes') {
    return { score: 1.0, reason: 'explicit_lit_yes', needsVerification: false };
  }
  if (tags.lit === 'no') {
    return { score: 0.0, reason: 'explicit_lit_no', needsVerification: true };
  }

  // Unknown lit tag — need inference
  score = 0.3; // neutral starting point
  reason = 'inferred';

  const nA = osmNodes.get(edge.from);
  const nB = osmNodes.get(edge.to);
  if (!nA || !nB) {
    return { score: 0, reason: 'missing_nodes', needsVerification: false };
  }

  const midLat = probePoint?.lat ?? (nA.lat + nB.lat) / 2;
  const midLng = probePoint?.lng ?? (nA.lng + nB.lng) / 2;

  // ── Modifier signals ──

  // +0.3: nearby street_lamp nodes within 30m (direct evidence)
  const lampsWithin30m = nearbyLightNodes.filter((lamp) => {
    return fastDistance(midLat, midLng, lamp.lat, lamp.lng) <= 30;
  }).length;
  if (lampsWithin30m > 0) {
    score += 0.3;
    reason += ',nearby_lamps';
  }

  // +0.2: urban road classification (more likely lit)
  if (URBAN_HIGHWAYS.has(highway)) {
    score += 0.2;
    reason += ',urban_road';
  }

  // -0.2: rural road classification (less likely lit)
  if (RURAL_HIGHWAYS.has(highway)) {
    score -= 0.2;
    reason += ',rural_road';
  }

  // +0.2: adjacent segments have lit=yes (continuity)
  const adjacentLit = (adjacentWays || []).some((w) => w.tags?.lit === 'yes');
  if (adjacentLit) {
    score += 0.2;
    reason += ',adjacent_lit';
  }

  // Clamp to [0, 1]
  score = Math.max(0.0, Math.min(1.0, score));

  // ── Interpretation ──
  const needsVerification =
    score > CONFIDENCE_THRESHOLDS.UNLIT && score < CONFIDENCE_THRESHOLDS.LIT;

  if (score >= CONFIDENCE_THRESHOLDS.LIT) {
    reason = reason || 'confident_lit';
  } else if (score <= CONFIDENCE_THRESHOLDS.UNLIT) {
    reason = reason || 'confident_unlit';
  } else {
    reason = reason || 'uncertain';
  }

  return { score, reason, needsVerification };
}

function sampleEdgeProbePoints(osmNodes, edge, fractions = [0.25, 0.5, 0.75]) {
  const nA = osmNodes.get(edge.from);
  const nB = osmNodes.get(edge.to);
  if (!nA || !nB) return [];

  return fractions.map((fraction) => ({
    lat: nA.lat + (nB.lat - nA.lat) * fraction,
    lng: nA.lng + (nB.lng - nA.lng) * fraction,
  }));
}

function computeSampledLightConfidence(
  way,
  edge,
  osmNodes,
  nearbyLightGrid,
  adjacentWays,
  options = {},
) {
  const sampleFractions = Array.isArray(options.sampleFractions) && options.sampleFractions.length > 0
    ? options.sampleFractions
    : [0.25, 0.5, 0.75];
  const searchRadiusMetres = Number.isFinite(options.searchRadiusMetres) && options.searchRadiusMetres > 0
    ? options.searchRadiusMetres
    : 50;

  const probePoints = sampleEdgeProbePoints(osmNodes, edge, sampleFractions);
  if (probePoints.length === 0) {
    return { score: 0, reason: 'missing_nodes', needsVerification: false };
  }

  const sampleResults = probePoints.map((probePoint) => {
    const nearbyLightNodes = findNearby(
      nearbyLightGrid,
      probePoint.lat,
      probePoint.lng,
      searchRadiusMetres,
    );
    return computeLightConfidence(
      way,
      edge,
      osmNodes,
      nearbyLightNodes,
      adjacentWays,
      probePoint,
    );
  });

  const score = Math.min(...sampleResults.map((result) => result.score));
  const needsVerification = sampleResults.some((result) => result.needsVerification);
  const explicitDarkSample = sampleResults.find((result) => result.reason === 'explicit_lit_no');
  const uncertainSample = sampleResults.find((result) => result.needsVerification);

  return {
    score,
    reason:
      explicitDarkSample?.reason ||
      uncertainSample?.reason ||
      sampleResults[0].reason ||
      'uncertain',
    needsVerification,
  };
}

/**
 * Build a list of uncertain segments that need OS NGD verification.
 *
 * @param {Array} edges — graph edges
 * @param {Array} edgeConfidences — parallel array of { score, reason, needsVerification }
 * @returns {Array} uncertain segments with their edge index and bbox
 */
function buildVerificationQueue(edges, edgeConfidences) {
  const uncertain = [];
  for (let i = 0; i < edges.length; i++) {
    const conf = edgeConfidences[i];
    if (conf && conf.needsVerification) {
      uncertain.push({
        edgeIdx: i,
        edge: edges[i],
        confidence: conf.score,
        reason: conf.reason,
      });
    }
  }
  return uncertain;
}

/**
 * Compute a tight bbox around a segment with a buffer.
 *
 * @param {Object} edge — { from, to }
 * @param {Map} osmNodes — id → { lat, lng }
 * @param {number} bufferM — buffer in metres (default 30)
 * @returns {Object} { south, west, north, east }
 */
function segmentBbox(edge, osmNodes, bufferM = 30) {
  const nA = osmNodes.get(edge.from);
  const nB = osmNodes.get(edge.to);
  if (!nA || !nB) return null;

  const bufferDeg = bufferM / 111320;
  const minLat = Math.min(nA.lat, nB.lat) - bufferDeg;
  const maxLat = Math.max(nA.lat, nB.lat) + bufferDeg;
  const minLng = Math.min(nA.lng, nB.lng) - bufferDeg;
  const maxLng = Math.max(nA.lng, nB.lng) + bufferDeg;

  return {
    south: minLat,
    west: minLng,
    north: maxLat,
    east: maxLng,
  };
}

/**
 * Merge OS NGD verified lights into local OSM light data.
 * Deduplicates by proximity (< 30m).
 *
 * @param {Array} localLights — existing light elements from local OSM
 * @param {Array} verifiedLights — OS NGD light points from micro-queries
 * @returns {Array} merged, deduplicated light elements
 */
function mergeVerifiedLights(localLights, verifiedLights) {
  const merged = [...localLights];
  const existingPositions = new Set();

  // Index existing light positions
  for (const el of localLights) {
    if (el.lat && el.lon) {
      existingPositions.add(`${el.lat.toFixed(6)},${el.lon.toFixed(6)}`);
    }
  }

  for (const v of verifiedLights) {
    if (!v.lat || !v.lon) continue;

    // Check if already exists within 30m
    const isDuplicate = localLights.some((existing) => {
      if (!existing.lat || !existing.lon) return false;
      return fastDistance(existing.lat, existing.lon, v.lat, v.lon) < 30;
    });

    if (!isDuplicate) {
      merged.push(v);
    }
  }

  return merged;
}

/**
 * Calculate what percentage of a route's length is uncertain.
 *
 * @param {Array} routeEdges — edge indices in the route
 * @param {Array} edges — full edge list
 * @param {Array} edgeConfidences — parallel array of confidence objects
 * @returns {Object} { uncertainRatio, uncertainLengthM, totalLengthM }
 */
function calculateRouteUncertainty(routeEdges, edges, edgeConfidences) {
  let totalLength = 0;
  let uncertainLength = 0;

  for (const eIdx of routeEdges) {
    const edge = edges[eIdx];
    const conf = edgeConfidences[eIdx];
    totalLength += edge.distance;
    if (conf && conf.needsVerification) {
      uncertainLength += edge.distance;
    }
  }

  return {
    uncertainRatio: totalLength > 0 ? uncertainLength / totalLength : 0,
    uncertainLengthM: uncertainLength,
    totalLengthM: totalLength,
  };
}

function buildEdgeSpanBbox(edgeIdxs, edges, osmNodes, bufferM = 30) {
  if (!Array.isArray(edgeIdxs) || edgeIdxs.length === 0) return null;

  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;

  for (const edgeIdx of edgeIdxs) {
    const edge = edges[edgeIdx];
    if (!edge) continue;
    const fromNode = osmNodes.get(edge.from);
    const toNode = osmNodes.get(edge.to);
    if (!fromNode || !toNode) continue;

    minLat = Math.min(minLat, fromNode.lat, toNode.lat);
    minLng = Math.min(minLng, fromNode.lng, toNode.lng);
    maxLat = Math.max(maxLat, fromNode.lat, toNode.lat);
    maxLng = Math.max(maxLng, fromNode.lng, toNode.lng);
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

function buildRouteLightGapSpans(route, edges, osmNodes, edgeConfidences, options = {}) {
  const routeEdges = route?.edges || [];
  const lowThreshold = Number.isFinite(options.lowThreshold) ? options.lowThreshold : 0.58;
  const continueThreshold = Number.isFinite(options.continueThreshold) ? options.continueThreshold : 0.72;
  const minSpanDistance = Number.isFinite(options.minSpanDistance) ? options.minSpanDistance : 90;
  const spans = [];

  let current = null;

  const flush = () => {
    if (!current) return;
    if (current.distance < minSpanDistance && !current.hasExplicitDark && !current.hasVerificationRisk) {
      current = null;
      return;
    }

    const bbox = buildEdgeSpanBbox(current.edgeIdxs, edges, osmNodes);
    if (!bbox) {
      current = null;
      return;
    }

    spans.push({
      edgeIdxs: [...current.edgeIdxs],
      edgeIdx: current.edgeIdxs[0],
      startNodeId: current.startNodeId,
      endNodeId: current.endNodeId,
      edgeCount: current.edgeIdxs.length,
      distance: Math.round(current.distance),
      bbox,
      confidence: Math.round((Math.min(current.minConfidence ?? 1, current.minLightScore ?? 1)) * 100) / 100,
      lightScore: Math.round((current.minLightScore ?? 0) * 100) / 100,
      reason: current.hasExplicitDark ? 'explicit_dark_span' : current.hasVerificationRisk ? 'light_uncertain_span' : 'dark_span',
    });
    current = null;
  };

  for (const edgeIdx of routeEdges) {
    const edge = edges?.[edgeIdx];
    const conf = edgeConfidences?.[edgeIdx];
    if (!edge) {
      flush();
      continue;
    }

    const lightScore = Number.isFinite(edge.lightScore) ? edge.lightScore : null;
    const explicitDark = conf?.reason === 'explicit_lit_no' || edge.litTag === 'no' || edge.isLit === false;
    const verificationRisk = !!(conf?.needsVerification || (conf?.reason !== 'explicit_lit_no' && Number.isFinite(conf?.score) && conf.score <= CONFIDENCE_THRESHOLDS.LIT));
    const startsGap = explicitDark || verificationRisk || (lightScore !== null && lightScore <= lowThreshold);
    const continuesGap = current && (explicitDark || verificationRisk || (lightScore !== null && lightScore <= continueThreshold));

    if (!startsGap && !continuesGap) {
      flush();
      continue;
    }

    const fromNode = osmNodes.get(edge.from);
    const toNode = osmNodes.get(edge.to);
    if (!fromNode || !toNode) {
      flush();
      continue;
    }

    if (!current) {
      current = {
        edgeIdxs: [],
        startNodeId: edge.from,
        endNodeId: edge.to,
        distance: 0,
        minConfidence: Number.isFinite(conf?.score) ? conf.score : (lightScore ?? 1),
        minLightScore: lightScore ?? 1,
        hasExplicitDark: explicitDark,
        hasVerificationRisk: verificationRisk,
      };
    }

    current.edgeIdxs.push(edgeIdx);
    current.endNodeId = edge.to;
    current.distance += edge.distance || 0;
    current.minConfidence = Math.min(current.minConfidence, Number.isFinite(conf?.score) ? conf.score : (lightScore ?? 1));
    current.minLightScore = Math.min(current.minLightScore, lightScore ?? 1);
    current.hasExplicitDark = current.hasExplicitDark || explicitDark;
    current.hasVerificationRisk = current.hasVerificationRisk || verificationRisk;
  }

  flush();
  return spans;
}

module.exports = {
  computeLightConfidence,
  computeSampledLightConfidence,
  sampleEdgeProbePoints,
  buildVerificationQueue,
  segmentBbox,
  mergeVerifiedLights,
  calculateRouteUncertainty,
  buildEdgeSpanBbox,
  buildRouteLightGapSpans,
  CONFIDENCE_THRESHOLDS,
};
