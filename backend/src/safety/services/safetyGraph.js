
/**
 * safetyGraph.js — Optimised safety-first walking graph + pathfinding.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * SPEED OPTIMISATIONS (vs v1):
 *   1. A* with haversine heuristic — 3–10× faster than plain Dijkstra
 *      by focusing the search toward the destination
 *   2. Spatial-grid findNearestNode — O(1) instead of O(n) brute force
 *   3. Pre-computed coverage maps — lighting/crime/place density is
 *      computed once across a grid, then sampled per-edge, eliminating
 *      thousands of individual findNearby calls
 *   4. fastDistance() for proximity checks — 5× faster than haversine
 *   5. Numeric spatial-grid keys — faster hash than string keys
 *
 * ACCURACY IMPROVEMENTS (vs v1):
 *   1. Crime severity weighting — violent crimes penalised 3× more
 *      than shoplifting (robbery=1.0, shoplifting=0.2)
 *   2. Inverse-distance lighting — lamp 5m away = much brighter than
 *      one 45m away (uses 1/d² falloff)
 *   3. CCTV cameras — new safety factor from OSM surveillance data
 *   4. Time-of-day awareness — crime weight increases after midnight,
 *      open-place weight adjusts for likelihood of being open
 *   5. Surface quality — unpaved paths penalised (scarier at night)
 *   6. Dead-end detection — segments leading to dead-ends penalised
 *      (harder to escape dangerous situation)
 * ═══════════════════════════════════════════════════════════════════════
 */

const { haversine, fastDistance, buildSpatialGrid, findNearby, countNearby } = require('./geo');
const { scoreFromCache } = require('./lightsCacheClient');
const { SAFETY_LEVEL_STANDARD, SAFETY_LEVEL_EXTRA } = require('./safetyLevels');
const opening_hours_lib = require('opening_hours');

const ENABLE_PLACE_OPENING_HOURS_PARSE = process.env.SAFE_ROUTES_PARSE_PLACE_OPENING_HOURS === '1';
const DEBUG_SAFE_ROUTES = process.env.SAFE_ROUTES_DEBUG === '1';
const debugLog = DEBUG_SAFE_ROUTES ? (...args) => console.log(...args) : () => {};

function createSearchCancelledError(message = 'Route search cancelled.') {
  const err = new Error(message);
  err.code = 'SEARCH_CANCELLED';
  err.statusCode = 409;
  return err;
}

function throwIfCancelled(shouldCancel) {
  if (typeof shouldCancel === 'function' && shouldCancel()) {
    throw createSearchCancelledError('Route search cancelled during graph computation.');
  }
}

// ── Road hierarchy scoring ──────────────────────────────────────────────────
const ROAD_TYPE_SCORES = {
  trunk: 0.90,
  primary: 0.95,
  secondary: 0.85,
  tertiary: 0.75,
  unclassified: 0.55,
  residential: 0.50,
  living_street: 0.55,
  service: 0.40,
  pedestrian: 0.60,
  cycleway: 0.35,
  footway: 0.25,
  path: 0.15,
  steps: 0.10,
  track: 0.10,
};

const WALKABLE_HIGHWAYS = new Set(Object.keys(ROAD_TYPE_SCORES));

// ── Time-adaptive weights ───────────────────────────────────────────────────
// Weights shift based on time of day (late night = crime matters more)
// Standard level has no CCTV or place data, so those weights are dropped and the
// remaining weights are rescaled to sum to 1 (keeps scores on the same scale).
function getWeights(hour, level = SAFETY_LEVEL_EXTRA) {
  const base = getBaseWeights(hour);
  if (level !== SAFETY_LEVEL_STANDARD) return base;

  const { cctv, openPlaces, ...rest } = base;
  const total = Object.values(rest).reduce((sum, w) => sum + w, 0);
  const scaled = Object.fromEntries(
    Object.entries(rest).map(([k, w]) => [k, w / total]),
  );
  return { ...scaled, cctv: 0, openPlaces: 0 };
}

function getBaseWeights(hour) {
  // hour = 0–23
  const h = typeof hour === 'number' && hour >= 0 && hour <= 23 ? hour : new Date().getHours();
  const isLateNight = h >= 0 && h < 5;   // midnight–5am
  const isEvening = h >= 18 || h < 0;     // 6pm–midnight

  if (isLateNight) {
    return {
      roadType: 0.22,
      lighting: 0.28,     // lighting matters most late night
      crimeRate: 0.25,    // crime matters more
      cctv: 0.08,         // CCTV is a reassurance factor
      openPlaces: 0.07,   // fewer places open, less weight
      gpsTraffic: 0.10,
    };
  }
  if (isEvening) {
    return {
      roadType: 0.23,
      lighting: 0.25,
      crimeRate: 0.22,
      cctv: 0.07,
      openPlaces: 0.12,
      gpsTraffic: 0.11,
    };
  }
  // Daytime fallback (shouldn't normally be used — app is for night)
  return {
    roadType: 0.25,
    lighting: 0.15,
    crimeRate: 0.20,
    cctv: 0.05,
    openPlaces: 0.15,
    gpsTraffic: 0.20,
  };
}

// ── Coverage maps ───────────────────────────────────────────────────────────
// Pre-compute density grids so edge scoring is O(1) per edge.
// Cell size ~25m for fine granularity.
const COVERAGE_CELL_DEG = 0.0005; // ~56m – halved resolution to save memory/CPU

/**
 * Build a lighting coverage map using inverse-distance-squared weighting.
 * Each cell gets a "brightness" value 0–1 based on nearby lamps.
 */
function buildLightingCoverage(lightNodes, litWayNodePositions, bbox, shouldCancel) {
  const rows = Math.ceil((bbox.north - bbox.south) / COVERAGE_CELL_DEG);
  const cols = Math.ceil((bbox.east - bbox.west) / COVERAGE_CELL_DEG);
  const grid = new Float32Array(rows * cols); // flat 2D array

  const LAMP_RADIUS = 60; // metres — effective illumination range
  const LAMP_RADIUS_DEG = LAMP_RADIUS / 111320;
  let iterations = 0;

  // Stamp each lamp's influence into the grid
  for (const lamp of lightNodes) {
    if ((iterations & 1023) === 0) throwIfCancelled(shouldCancel);
    const rMin = Math.max(0, Math.floor((lamp.lat - LAMP_RADIUS_DEG - bbox.south) / COVERAGE_CELL_DEG));
    const rMax = Math.min(rows - 1, Math.ceil((lamp.lat + LAMP_RADIUS_DEG - bbox.south) / COVERAGE_CELL_DEG));
    const cMin = Math.max(0, Math.floor((lamp.lng - LAMP_RADIUS_DEG - bbox.west) / COVERAGE_CELL_DEG));
    const cMax = Math.min(cols - 1, Math.ceil((lamp.lng + LAMP_RADIUS_DEG - bbox.west) / COVERAGE_CELL_DEG));

    for (let r = rMin; r <= rMax; r++) {
      for (let c = cMin; c <= cMax; c++) {
        const cellLat = bbox.south + (r + 0.5) * COVERAGE_CELL_DEG;
        const cellLng = bbox.west + (c + 0.5) * COVERAGE_CELL_DEG;
        if (
          Math.abs(cellLat - lamp.lat) > LAMP_RADIUS_DEG ||
          Math.abs(cellLng - lamp.lng) > LAMP_RADIUS_DEG
        ) {
          iterations += 1;
          continue;
        }
        const d = fastDistance(lamp.lat, lamp.lng, cellLat, cellLng);
        if (d < LAMP_RADIUS) {
          // Inverse-distance-squared falloff: light at 5m >> light at 50m
          const intensity = Math.min(1.0, 1.0 / (1 + (d / 12) ** 2));
          const idx = r * cols + c;
          grid[idx] = Math.min(1.0, grid[idx] + intensity);
        }
        iterations += 1;
      }
    }
  }

  // Mark lit-way positions
  for (const pos of litWayNodePositions) {
    if ((iterations & 1023) === 0) throwIfCancelled(shouldCancel);
    const r = Math.floor((pos.lat - bbox.south) / COVERAGE_CELL_DEG);
    const c = Math.floor((pos.lng - bbox.west) / COVERAGE_CELL_DEG);
    if (r >= 0 && r < rows && c >= 0 && c < cols) {
      grid[r * cols + c] = Math.min(1.0, grid[r * cols + c] + 0.7);
    }
    iterations += 1;
  }

  return { grid, rows, cols, bbox };
}

/**
 * Build a crime severity density map.
 * Each cell accumulates severity-weighted crime density.
 */
function buildCrimeCoverage(crimes, bbox, shouldCancel) {
  const rows = Math.ceil((bbox.north - bbox.south) / COVERAGE_CELL_DEG);
  const cols = Math.ceil((bbox.east - bbox.west) / COVERAGE_CELL_DEG);
  const grid = new Float32Array(rows * cols);

  const CRIME_RADIUS = 120; // metres — crime influence radius
  const CRIME_RADIUS_DEG = CRIME_RADIUS / 111320;
  let iterations = 0;

  for (const crime of crimes) {
    if ((iterations & 1023) === 0) throwIfCancelled(shouldCancel);
    const rMin = Math.max(0, Math.floor((crime.lat - CRIME_RADIUS_DEG - bbox.south) / COVERAGE_CELL_DEG));
    const rMax = Math.min(rows - 1, Math.ceil((crime.lat + CRIME_RADIUS_DEG - bbox.south) / COVERAGE_CELL_DEG));
    const cMin = Math.max(0, Math.floor((crime.lng - CRIME_RADIUS_DEG - bbox.west) / COVERAGE_CELL_DEG));
    const cMax = Math.min(cols - 1, Math.ceil((crime.lng + CRIME_RADIUS_DEG - bbox.west) / COVERAGE_CELL_DEG));

    const severity = crime.severity || 0.4;

    for (let r = rMin; r <= rMax; r++) {
      for (let c = cMin; c <= cMax; c++) {
        const cellLat = bbox.south + (r + 0.5) * COVERAGE_CELL_DEG;
        const cellLng = bbox.west + (c + 0.5) * COVERAGE_CELL_DEG;
        if (
          Math.abs(cellLat - crime.lat) > CRIME_RADIUS_DEG ||
          Math.abs(cellLng - crime.lng) > CRIME_RADIUS_DEG
        ) {
          iterations += 1;
          continue;
        }
        const d = fastDistance(crime.lat, crime.lng, cellLat, cellLng);
        if (d < CRIME_RADIUS) {
          // Distance-weighted severity: closer crime = more impact
          const impact = severity / (1 + (d / 30) ** 1.5);
          grid[r * cols + c] += impact;
        }
        iterations += 1;
      }
    }
  }

  return { grid, rows, cols, bbox };
}

/**
 * Sample a coverage grid at a lat/lng position. Returns 0–1 (clamped).
 */
function sampleCoverage(coverage, lat, lng) {
  const r = Math.floor((lat - coverage.bbox.south) / COVERAGE_CELL_DEG);
  const c = Math.floor((lng - coverage.bbox.west) / COVERAGE_CELL_DEG);
  if (r < 0 || r >= coverage.rows || c < 0 || c >= coverage.cols) return 0;
  return coverage.grid[r * coverage.cols + c];
}

// ═══════════════════════════════════════════════════════════════════════════════
// GRAPH BUILDING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a walking graph from raw OSM data with pre-computed coverage maps.
 *
 * Uses coverage maps for lighting and crime (O(1) per edge) instead of
 * per-edge findNearby calls (which were thousands of spatial lookups).
 */
async function buildGraph(roadData, lightData, cctvData, placeData, transitData, crimes, bbox, options = {}) {
  const shouldCancel = options && typeof options.shouldCancel === 'function'
    ? options.shouldCancel
    : null;
  const hour = options.hour != null ? options.hour : new Date().getHours();
  const weights = getWeights(hour, options?.level);

  // 1. Index all OSM nodes by ID
  const osmNodes = new Map();
  let workCounter = 0;
  for (const el of roadData.elements) {
    if ((workCounter & 2047) === 0) throwIfCancelled(shouldCancel);
    if (el.type === 'node') {
      osmNodes.set(el.id, { lat: el.lat, lng: el.lon, id: el.id });
    }
    workCounter += 1;
  }

  // 2. Build coverage maps (batch pre-computation)
  const lightNodes = [];
  const litWayNodePositions = [];
  const litWayNodeIds = new Set();
  if (lightData) {
    for (const el of lightData.elements) {
      if ((workCounter & 2047) === 0) throwIfCancelled(shouldCancel);
      if (el.type === 'node' && el.tags?.highway === 'street_lamp') {
        lightNodes.push({ lat: el.lat, lng: el.lon });
      }
      if (el.type === 'way' && el.tags?.lit === 'yes' && el.nodes) {
        for (const nid of el.nodes) {
          litWayNodeIds.add(nid);
          const n = osmNodes.get(nid);
          if (n) litWayNodePositions.push({ lat: n.lat, lng: n.lng });
        }
      }
      workCounter += 1;
    }
  }

  debugLog(`[graph] Building lighting coverage map (${lightNodes.length} lamps)...`);
  const lightCoverage = buildLightingCoverage(lightNodes, litWayNodePositions, bbox, shouldCancel);

  debugLog(`[graph] Building crime coverage map (${crimes.length} crimes)...`);
  const crimeCoverage = buildCrimeCoverage(crimes, bbox, shouldCancel);

  // 3. Build spatial grids for CCTV, places, transit (still need proximity)
  const cctvNodes = [];
  if (cctvData) {
    for (const el of cctvData.elements) {
      if ((workCounter & 2047) === 0) throwIfCancelled(shouldCancel);
      if (el.type === 'node' && el.lat && el.lon) {
        cctvNodes.push({ lat: el.lat, lng: el.lon });
      }
      workCounter += 1;
    }
  }
  const cctvGrid = buildSpatialGrid(cctvNodes);

  const placeNodes = [];
  if (placeData) {
    const hour = new Date().getHours();
    for (const el of placeData.elements) {
      if ((workCounter & 2047) === 0) throwIfCancelled(shouldCancel);
      const lat = el.lat || el.center?.lat;
      const lng = el.lon || el.center?.lon;
      if (lat && lng) {
        const hoursRaw = el.tags?.opening_hours || '';
        let isOpen = null;
        // 1) Optional: parse OSM opening_hours when explicitly enabled.
        if (ENABLE_PLACE_OPENING_HOURS_PARSE && hoursRaw) {
          try {
            const cleaned = hoursRaw
              .split(';').map(s => s.trim())
              .filter(s => !/^\s*PH\b/.test(s))
              .map(s => s.replace(/,\s*PH\b/g, ''))
              .filter(Boolean).join('; ');
            if (cleaned) {
              const oh = new opening_hours_lib(cleaned, { address: { country_code: 'gb' } });
              isOpen = oh.getState(new Date());
            }
          } catch { isOpen = null; }
        }
        // 2) Fall back to time-of-day heuristic
        if (isOpen === null) {
          const type = (el.tags?.amenity || el.tags?.shop || '').toLowerCase();
          const always = ['hospital','clinic','pharmacy','fuel','atm','police','fire_station','hotel','hostel','parking','toilets'];
          const evening = ['pub','bar','nightclub','biergarten','casino','restaurant','fast_food','food_court','ice_cream','cafe'];
          const extendedShops = ['convenience','supermarket','kiosk','mall'];
          if (always.includes(type)) isOpen = true;
          else if (evening.includes(type)) isOpen = hour >= 10 && hour < 24;
          else if (extendedShops.includes(type)) isOpen = hour >= 6 && hour < 23;
          else isOpen = hour >= 7 && hour < 20;
        }
        if (!isOpen) continue;
        placeNodes.push({
          lat, lng,
          amenity: el.tags?.amenity,
          opening_hours: hoursRaw,
        });
      }
      workCounter += 1;
    }
  }
  const placeGrid = buildSpatialGrid(placeNodes);

  const transitNodes = [];
  if (transitData) {
    for (const el of transitData.elements) {
      if (el.type === 'node' && el.lat && el.lon) {
        transitNodes.push({ lat: el.lat, lng: el.lon });
      }
    }
  }
  const transitGrid = buildSpatialGrid(transitNodes);

  // 4. Build node spatial grid for O(1) nearest-node lookup
  const nodeArray = [];
  for (const [id, node] of osmNodes) {
    if ((workCounter & 4095) === 0) throwIfCancelled(shouldCancel);
    nodeArray.push({ lat: node.lat, lng: node.lng, id });
    workCounter += 1;
  }
  const nodeGrid = buildSpatialGrid(nodeArray, 'lat', 'lng', 0.001); // ~110m cells

  // 5. Detect dead-end nodes (degree = 1)
  const nodeDegree = new Map();

  // 6. Build edges from ways
  const edges = [];
  const adjacency = new Map();

  for (const el of roadData.elements) {
    if ((workCounter & 1023) === 0) throwIfCancelled(shouldCancel);
    if (el.type !== 'way' || !el.nodes || !el.tags?.highway) continue;
    const highway = el.tags.highway;
    if (!WALKABLE_HIGHWAYS.has(highway)) continue;

    const wayTags = el.tags;
    const nodeIds = el.nodes;

    for (let i = 0; i < nodeIds.length - 1; i++) {
      if ((workCounter & 1023) === 0) throwIfCancelled(shouldCancel);
      const nA = osmNodes.get(nodeIds[i]);
      const nB = osmNodes.get(nodeIds[i + 1]);
      if (!nA || !nB) continue;
      const edgeIdx = edges.length;

      const dist = fastDistance(nA.lat, nA.lng, nB.lat, nB.lng);
      if (dist < 0.5) continue;

      const midLat = (nA.lat + nB.lat) / 2;
      const midLng = (nA.lng + nB.lng) / 2;

      // ── Score each factor ──

      // Road type
      const roadScore = ROAD_TYPE_SCORES[highway] || 0.3;

      // Lighting — cache-first, then coverage map
      let lightScore = sampleCoverage(lightCoverage, midLat, midLng);
      const edgeLightCache = options.lightsCacheByEdgeIdx?.get(edgeIdx) || null;

      // Check cache for this segment (best effort, non-blocking)
      if (edgeLightCache) {
        const cached = scoreFromCache(edgeLightCache);
        if (cached) {
          lightScore = cached.score;
        }
      }

      // Override with explicit way tags (tags are ground truth)
      if (wayTags.lit === 'yes') lightScore = Math.max(lightScore, 0.90);
      if (wayTags.lit === 'no') lightScore = Math.min(lightScore, 0.10);
      if (wayTags.lit === 'limited') lightScore = Math.max(lightScore, 0.40);

      // Hard cap for verified-unlit segments
      const isVerifiedUnlit = edgeLightCache?.lit_status === 'unlit' && (edgeLightCache.confidence || 0) >= 0.8;
      if (isVerifiedUnlit) {
        lightScore = Math.min(lightScore, 0.05);
      }

      lightScore = Math.max(0.0, Math.min(1.0, lightScore));

      // Crime — sample from severity-weighted coverage map
      const crimeDensity = sampleCoverage(crimeCoverage, midLat, midLng);
      const crimeScore = Math.max(0, 1.0 - Math.min(1.0, crimeDensity * 0.5));

      // CCTV — nearby surveillance cameras
      const nearbyCctv = countNearby(cctvGrid, midLat, midLng, 80);
      const cctvScore = Math.min(1.0, nearbyCctv * 0.4);

      // Open places — activity within 80m
      const nearbyPlaces = countNearby(placeGrid, midLat, midLng, 80);
      // At night, apply a discount — many places will be closed
      const nightDiscount = (hour >= 22 || hour < 6) ? 0.4 : (hour >= 18 ? 0.7 : 1.0);
      const placeScore = Math.min(1.0, nearbyPlaces * 0.15 * nightDiscount);

      // Foot traffic proxy
      const nearbyTransit = countNearby(transitGrid, midLat, midLng, 150);
      let trafficScore = (ROAD_TYPE_SCORES[highway] || 0.3) * 0.7 +
        Math.min(0.3, nearbyTransit * 0.1) + 0.1;
      if (wayTags.sidewalk && wayTags.sidewalk !== 'no') {
        trafficScore = Math.min(1.0, trafficScore + 0.15);
      }
      trafficScore = Math.min(1.0, trafficScore);

      // Surface penalty — unpaved is scarier at night (graded)
      const surface = wayTags.surface;
      const SURFACE_PENALTIES = {
        gravel: 0.04,
        dirt: 0.06,
        grass: 0.04,
        mud: 0.12,
        sand: 0.08,
        earth: 0.06,
      };
      const surfacePenalty = SURFACE_PENALTIES[surface] || 0;
      const verifiedUnlitPenalty = isVerifiedUnlit
        ? Math.min(0.18, 0.08 + ((edgeLightCache.confidence || 0) * 0.12))
        : 0;

      // ── Combine into single safety score ──
      const safetyScore = Math.max(0.01,
        weights.roadType * roadScore +
        weights.lighting * lightScore +
        weights.crimeRate * crimeScore +
        weights.cctv * cctvScore +
        weights.openPlaces * placeScore +
        weights.gpsTraffic * trafficScore -
        surfacePenalty -
        verifiedUnlitPenalty
      );

      // Extra metadata for frontend
      const hasSidewalk = !!(wayTags.sidewalk && wayTags.sidewalk !== 'no');
      const surfaceType = surface || 'paved';
      const roadName = wayTags.name || '';
      const maxspeed = wayTags.maxspeed || '';
      const isTunnel = wayTags.tunnel === 'yes';
      const litTag = wayTags.lit || null;
      const isLit = litTag === 'yes';
      edges.push({
        idx: edgeIdx,
        from: nodeIds[i],
        to: nodeIds[i + 1],
        distance: dist,
        highway,
        safetyScore,
        roadScore,
        lightScore,
        crimeScore,
        cctvScore,
        placeScore,
        trafficScore,
        penalty: 0,
        hasSidewalk,
        surfaceType,
        roadName,
        nearbyCctvCount: nearbyCctv,
        nearbyTransitCount: nearbyTransit,
        surfacePenalty,
        maxspeed,
        isTunnel,
        isLit,
        litTag,
      });

      // Bidirectional adjacency
      if (!adjacency.has(nodeIds[i])) adjacency.set(nodeIds[i], []);
      if (!adjacency.has(nodeIds[i + 1])) adjacency.set(nodeIds[i + 1], []);
      adjacency.get(nodeIds[i]).push({ edgeIdx, neighborId: nodeIds[i + 1] });
      adjacency.get(nodeIds[i + 1]).push({ edgeIdx, neighborId: nodeIds[i] });

      // Track node degree for dead-end detection
      nodeDegree.set(nodeIds[i], (nodeDegree.get(nodeIds[i]) || 0) + 1);
      nodeDegree.set(nodeIds[i + 1], (nodeDegree.get(nodeIds[i + 1]) || 0) + 1);
      workCounter += 1;
    }
    workCounter += 1;
  }

  // 7. Apply dead-end penalty — edges leading to degree-1 nodes are less safe
  // Context-aware: darker dead-ends penalised more than well-lit ones
  for (const edge of edges) {
    if ((workCounter & 2047) === 0) throwIfCancelled(shouldCancel);
    const fromDeg = nodeDegree.get(edge.from) || 0;
    const toDeg = nodeDegree.get(edge.to) || 0;
    const isDeadEnd = fromDeg <= 1 || toDeg <= 1;
    if (isDeadEnd) {
      const lightFactor = 1 - (edge.lightScore || 0);
      const deadEndPenalty = 0.02 + (0.08 * lightFactor);
      edge.safetyScore = Math.max(0.01, edge.safetyScore - deadEndPenalty);
    }
    edge.isDeadEnd = isDeadEnd;
    workCounter += 1;
  }

  return { osmNodes, edges, adjacency, nodeGrid, weights, cctvNodes, transitNodes, nodeDegree, edgeConfidences: [] };
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEAREST NODE (spatial grid — O(1) instead of O(n))
// ═══════════════════════════════════════════════════════════════════════════════

function findNearestNode(nodeGrid, adjacency, lat, lng, maxDist = 500) {
  const nearby = findNearby(nodeGrid, lat, lng, maxDist);
  // Return the nearest node that is actually in the graph (has adjacency)
  for (const item of nearby) {
    if (adjacency.has(item.id)) return item.id;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// A* PATHFINDING (replaces plain Dijkstra — 3-10× faster)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A* search that minimises cost = distance / safetyMultiplier.
 *
 * Uses haversine-to-destination as admissible heuristic, which focuses
 * the search toward the goal instead of expanding in all directions.
 * For safety routing, we divide the heuristic by max possible safety (1.0)
 * to keep it admissible (never overestimates).
 */
function isHazardEdge(edge, allowHazards = false) {
  if (allowHazards) return false;
  // Hard constraints: obvious hazards we should avoid by default
  const speed = parseInt(edge.maxspeed, 10);
  const isHighSpeedNoSidewalk = Number.isFinite(speed) && speed >= 50 && !edge.hasSidewalk;
  const isUnlitTunnel = edge.isTunnel && !edge.isLit;
  return isHighSpeedNoSidewalk || isUnlitTunnel;
}

function aStarSafety(osmNodes, edges, adjacency, startId, endId, maxDistM, options = {}) {
  if (!adjacency.has(startId) || !adjacency.has(endId)) {
    debugLog(`[A*] ❌ Start or end not in adjacency: start=${adjacency.has(startId)}, end=${adjacency.has(endId)}`);
    return null;
  }

  const endNode = osmNodes.get(endId);
  if (!endNode) {
    debugLog(`[A*] ❌ End node not in osmNodes`);
    return null;
  }

  const sNode = osmNodes.get(startId);
  if (!sNode) {
    debugLog(`[A*] ❌ Start node not in osmNodes`);
    return null;
  }

  debugLog(`[A*] Start neighbors: ${adjacency.get(startId)?.length}, End neighbors: ${adjacency.get(endId)?.length}, maxDist: ${maxDistM}m`);

  const gScore = new Map();
  const fScore = new Map();
  const realDist = new Map();
  const prev = new Map();
  const closed = new Set();

  gScore.set(startId, 0);
  realDist.set(startId, 0);

  const h0 = sNode ? fastDistance(sNode.lat, sNode.lng, endNode.lat, endNode.lng) : 0;
  fScore.set(startId, h0);

  const heap = new MinHeap();
  heap.push(startId, h0);

  while (heap.size > 0) {
    const { id: current } = heap.pop();

    if (closed.has(current)) continue;
    closed.add(current);

    if (current === endId) break;

    const currentG = gScore.get(current) ?? Infinity;
    const neighbors = adjacency.get(current);
    if (!neighbors) continue;

    for (const { edgeIdx, neighborId } of neighbors) {
      if (closed.has(neighborId)) continue;

      const edge = edges[edgeIdx];
      if (isHazardEdge(edge, options.allowHazards)) continue;

      const confidencePenalty = (options.edgeConfidences && options.edgeConfidences[edgeIdx])
        ? Math.min(0.1, (1 - options.edgeConfidences[edgeIdx].score) * 0.1)
        : 0;
      const effectiveSafety = Math.max(0.05, edge.safetyScore - edge.penalty - confidencePenalty);
      const edgeCost = edge.distance / effectiveSafety;
      const tentativeG = currentG + edgeCost;
      const newRealDist = (realDist.get(current) || 0) + edge.distance;

      if (newRealDist > maxDistM * 1.5) continue;

      if (tentativeG < (gScore.get(neighborId) ?? Infinity)) {
        gScore.set(neighborId, tentativeG);
        realDist.set(neighborId, newRealDist);
        prev.set(neighborId, { prevNode: current, edgeIdx });

        // Heuristic: remaining distance / max possible safety (1.0)
        const nNode = osmNodes.get(neighborId);
        const h = nNode ? fastDistance(nNode.lat, nNode.lng, endNode.lat, endNode.lng) : 0;
        const f = tentativeG + h;
        fScore.set(neighborId, f);
        heap.push(neighborId, f);
      }
    }
  }

  if (!prev.has(endId) && startId !== endId) {
    debugLog(`[A*] ❌ No path found. Visited ${closed.size} nodes, heap size at end: ${heap.size}`);
    return null;
  }

  // Reconstruct path
  const path = [];
  const usedEdges = [];
  let node = endId;
  while (node !== startId) {
    path.push(node);
    const p = prev.get(node);
    if (!p) return null;
    usedEdges.push(p.edgeIdx);
    node = p.prevNode;
  }
  path.push(startId);
  path.reverse();
  usedEdges.reverse();

  let totalDist = 0;
  let totalWeightedSafety = 0;
  for (const eIdx of usedEdges) {
    const e = edges[eIdx];
    totalDist += e.distance;
    totalWeightedSafety += e.safetyScore * e.distance;
  }

  return {
    path,
    edges: usedEdges,
    totalDist,
    avgSafety: totalDist > 0 ? totalWeightedSafety / totalDist : 0,
  };
}

/**
 * Generate K diverse routes using iterative penalty + A*.
 */
function findKSafestRoutes(osmNodes, edges, adjacency, startId, endId, maxDistM, k = 5, options = {}) {
  const routes = [];
  const penaltyIncrement = 0.15;

  for (const e of edges) e.penalty = 0;

  for (let i = 0; i < k + 3; i++) {
    const route = aStarSafety(osmNodes, edges, adjacency, startId, endId, maxDistM, options);
    if (!route) break;

    const isDuplicate = routes.some((existing) => {
      const overlap = countEdgeOverlap(existing.edges, route.edges);
      return overlap > 0.85;
    });

    if (!isDuplicate) {
      routes.push(route);
      if (routes.length >= k) break;
    }

    for (const eIdx of route.edges) {
      edges[eIdx].penalty += penaltyIncrement;
    }
  }

  for (const e of edges) e.penalty = 0;
  routes.sort((a, b) => b.avgSafety - a.avgSafety);
  return routes;
}

function countEdgeOverlap(edgesA, edgesB) {
  const setA = new Set(edgesA);
  let overlap = 0;
  for (const e of edgesB) if (setA.has(e)) overlap++;
  return edgesB.length > 0 ? overlap / edgesB.length : 0;
}

/**
 * Convert a route (list of node IDs) to a polyline [{lat, lng}, ...].
 */
function routeToPolyline(osmNodes, path) {
  const points = [];
  for (const nid of path) {
    const node = osmNodes.get(nid);
    if (node) points.push({ lat: node.lat, lng: node.lng });
  }
  return points;
}

/**
 * Compute detailed per-segment safety breakdown for a route.
 */
function routeSafetyBreakdown(edges, usedEdgeIdxs, weights, edgeConfidences = null) {
  let totalDist = 0;
  let weightedRoad = 0, weightedLight = 0, weightedCrime = 0;
  let weightedCctv = 0, weightedPlace = 0, weightedTraffic = 0;
  const roadTypes = {};
  const edgeRisks = [];
  let uncertainLength = 0;

  for (const eIdx of usedEdgeIdxs) {
    const e = edges[eIdx];
    const d = e.distance;
    totalDist += d;
    weightedRoad += e.roadScore * d;
    weightedLight += e.lightScore * d;
    weightedCrime += e.crimeScore * d;
    weightedCctv += (e.cctvScore || 0) * d;
    weightedPlace += e.placeScore * d;
    weightedTraffic += e.trafficScore * d;
    roadTypes[e.highway] = (roadTypes[e.highway] || 0) + d;
    edgeRisks.push(e.safetyScore);
    if (edgeConfidences && edgeConfidences[eIdx]?.needsVerification) {
      uncertainLength += d;
    }
  }

  if (totalDist === 0) {
    return {
      roadType: 0, lighting: 0, crime: 0, cctv: 0, openPlaces: 0,
      traffic: 0, overall: 0, roadTypes: {}, mainRoadRatio: 0,
      riskVector: { mean: 0, p95: 0, max: 0, uncertainty: 0 },
    };
  }

  const mainRoadDist =
    (roadTypes.primary || 0) + (roadTypes.secondary || 0) +
    (roadTypes.tertiary || 0) + (roadTypes.trunk || 0);

  const roadTypePct = {};
  for (const [type, dist] of Object.entries(roadTypes)) {
    roadTypePct[type] = Math.round((dist / totalDist) * 100);
  }

  const w = weights || getWeights(new Date().getHours());

  const meanSafety = totalDist > 0
    ? (weightedRoad + weightedLight + weightedCrime + weightedCctv + weightedPlace + weightedTraffic) / totalDist
    : 0;
  const sortedRisks = [...edgeRisks].sort((a, b) => a - b);
  const p95Index = Math.floor(sortedRisks.length * 0.95);
  const p95 = sortedRisks.length > 0 ? sortedRisks[Math.min(p95Index, sortedRisks.length - 1)] : 0;
  const maxRisk = sortedRisks.length > 0 ? sortedRisks[sortedRisks.length - 1] : 0;
  const uncertainRatio = totalDist > 0 ? uncertainLength / totalDist : 0;

  // Uncertainty penalty: small deduction for unverified segments (capped at 0.1)
  const UNCERTAINTY_LAMBDA = 0.1;
  const uncertaintyPenalty = Math.min(0.1, UNCERTAINTY_LAMBDA * uncertainRatio);

  const overall = Math.max(0,
    w.roadType * (weightedRoad / totalDist) +
    w.lighting * (weightedLight / totalDist) +
    w.crimeRate * (weightedCrime / totalDist) +
    w.cctv * (weightedCctv / totalDist) +
    w.openPlaces * (weightedPlace / totalDist) +
    w.gpsTraffic * (weightedTraffic / totalDist) -
    uncertaintyPenalty
  );

  return {
    roadType: weightedRoad / totalDist,
    lighting: weightedLight / totalDist,
    crime: weightedCrime / totalDist,
    cctv: weightedCctv / totalDist,
    openPlaces: weightedPlace / totalDist,
    traffic: weightedTraffic / totalDist,
    overall,
    roadTypes: roadTypePct,
    mainRoadRatio: mainRoadDist / totalDist,
    riskVector: {
      mean: meanSafety,
      p95,
      max: maxRisk,
      uncertainty: uncertainRatio,
    },
  };
}

// ── Min-Heap ────────────────────────────────────────────────────────────────
class MinHeap {
  constructor() {
    this.data = [];
    this.size = 0;
  }

  push(id, priority) {
    this.data[this.size] = { id, priority };
    this.size++;
    this._bubbleUp(this.size - 1);
  }

  pop() {
    if (this.size === 0) return null;
    const min = this.data[0];
    this.size--;
    if (this.size > 0) {
      this.data[0] = this.data[this.size];
      this._sinkDown(0);
    }
    return min;
  }

  _bubbleUp(i) {
    const data = this.data;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (data[i].priority >= data[parent].priority) break;
      const tmp = data[i]; data[i] = data[parent]; data[parent] = tmp;
      i = parent;
    }
  }

  _sinkDown(i) {
    const data = this.data;
    const n = this.size;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && data[left].priority < data[smallest].priority) smallest = left;
      if (right < n && data[right].priority < data[smallest].priority) smallest = right;
      if (smallest === i) break;
      const tmp = data[i]; data[i] = data[smallest]; data[smallest] = tmp;
      i = smallest;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISTANCE-ONLY GRAPH & A* (Phase 1 corridor discovery)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a lightweight distance-only graph from road data.
 * No coverage maps, no safety scoring — just the walking network topology.
 * Used in Phase 1 to discover the shortest walking corridor quickly.
 */
function buildDistanceOnlyGraph(roadData) {
  const osmNodes = new Map();
  for (const el of roadData.elements) {
    if (el.type === 'node') {
      osmNodes.set(el.id, { lat: el.lat, lng: el.lon, id: el.id });
    }
  }

  const nodeArray = [];
  for (const [id, node] of osmNodes) {
    nodeArray.push({ lat: node.lat, lng: node.lng, id });
  }
  const nodeGrid = buildSpatialGrid(nodeArray, 'lat', 'lng', 0.001);

  const edges = [];
  const adjacency = new Map();

  for (const el of roadData.elements) {
    if (el.type !== 'way' || !el.nodes || !el.tags?.highway) continue;
    if (!WALKABLE_HIGHWAYS.has(el.tags.highway)) continue;

    const nodeIds = el.nodes;
    for (let i = 0; i < nodeIds.length - 1; i++) {
      const nA = osmNodes.get(nodeIds[i]);
      const nB = osmNodes.get(nodeIds[i + 1]);
      if (!nA || !nB) continue;
      const dist = fastDistance(nA.lat, nA.lng, nB.lat, nB.lng);
      if (dist < 0.5) continue;

      const edgeIdx = edges.length;
      edges.push({ from: nodeIds[i], to: nodeIds[i + 1], distance: dist });

      if (!adjacency.has(nodeIds[i])) adjacency.set(nodeIds[i], []);
      if (!adjacency.has(nodeIds[i + 1])) adjacency.set(nodeIds[i + 1], []);
      adjacency.get(nodeIds[i]).push({ edgeIdx, neighborId: nodeIds[i + 1] });
      adjacency.get(nodeIds[i + 1]).push({ edgeIdx, neighborId: nodeIds[i] });
    }
  }

  return { osmNodes, edges, adjacency, nodeGrid };
}

/**
 * Distance-only A* — finds the shortest walking path by distance.
 * No safety scoring — purely minimises total metres walked.
 * Used in Phase 1 to trace the walking corridor shape.
 */
function aStarDistance(osmNodes, edges, adjacency, startId, endId, maxDistM) {
  if (!adjacency.has(startId) || !adjacency.has(endId)) return null;

  const endNode = osmNodes.get(endId);
  const sNode = osmNodes.get(startId);
  if (!endNode || !sNode) return null;

  const gScore = new Map();
  const prev = new Map();
  const closed = new Set();

  gScore.set(startId, 0);
  const h0 = fastDistance(sNode.lat, sNode.lng, endNode.lat, endNode.lng);
  const heap = new MinHeap();
  heap.push(startId, h0);

  while (heap.size > 0) {
    const { id: current } = heap.pop();
    if (closed.has(current)) continue;
    closed.add(current);
    if (current === endId) break;

    const currentG = gScore.get(current) ?? Infinity;
    const neighbors = adjacency.get(current);
    if (!neighbors) continue;

    for (const { edgeIdx, neighborId } of neighbors) {
      if (closed.has(neighborId)) continue;

      const edge = edges[edgeIdx];
      const tentativeG = currentG + edge.distance;
      if (tentativeG > maxDistM) continue;

      if (tentativeG < (gScore.get(neighborId) ?? Infinity)) {
        gScore.set(neighborId, tentativeG);
        prev.set(neighborId, { prevNode: current });
        const nNode = osmNodes.get(neighborId);
        const h = nNode ? fastDistance(nNode.lat, nNode.lng, endNode.lat, endNode.lng) : 0;
        heap.push(neighborId, tentativeG + h);
      }
    }
  }

  if (!prev.has(endId) && startId !== endId) return null;

  // Reconstruct path
  const path = [];
  let node = endId;
  while (node !== startId) {
    path.push(node);
    const p = prev.get(node);
    if (!p) return null;
    node = p.prevNode;
  }
  path.push(startId);
  path.reverse();

  let totalDist = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = osmNodes.get(path[i]);
    const b = osmNodes.get(path[i + 1]);
    if (a && b) totalDist += fastDistance(a.lat, a.lng, b.lat, b.lng);
  }

  return { path, totalDist };
}

module.exports = {
  buildGraph,
  buildDistanceOnlyGraph,
  aStarDistance,
  findNearestNode,
  aStarSafety,
  findKSafestRoutes,
  routeToPolyline,
  routeSafetyBreakdown,
  getWeights,
  ROAD_TYPE_SCORES,
  WALKABLE_HIGHWAYS,
  isHazardEdge,
};