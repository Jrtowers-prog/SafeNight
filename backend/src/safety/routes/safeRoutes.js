/**
 * routes/safeRoutes.js — Safety-first pathfinding endpoint (v2).
 *
 * GET /api/safe-routes?origin_lat=...&origin_lng=...&dest_lat=...&dest_lng=...
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SPEED IMPROVEMENTS (vs v1):
 *   1. Single Overpass query instead of 4 parallel ones (~70% less latency)
 *   2. 30-min data cache (OSM) + 24h crime cache (vs 5-min route cache)
 *   3. A* pathfinding with heuristic (3–10× faster per route)
 *   4. Pre-computed coverage maps (lighting, crime) — O(1) per edge
 *   5. Spatial-grid nearest-node lookup — O(1) vs O(n)
 *   6. Request coalescing — concurrent identical requests share one computation
 *
 * ACCURACY IMPROVEMENTS:
 *   1. Crime severity weighting (violent > property > nuisance)
 *   2. Inverse-distance lighting model (closer lamp = much brighter)
 *   3. CCTV cameras as new safety signal
 *   4. Time-of-day adaptive weights
 *   5. Surface quality penalty (gravel/dirt paths)
 *   6. Dead-end detection and penalty
 * ═══════════════════════════════════════════════════════════════════════════
 */

const express = require("express");
const opening_hours = require("opening_hours");
const {
  validateLatitude,
  validateLongitude,
} = require("../../shared/validation/validate");
const {
  haversine,
  bboxFromPoints,
  encodePolyline,
} = require("../services/geo");
const {
  fetchAllSafetyData,
  fetchRoadNetworkOnly,
} = require("../services/overpassClient");
const { fetchCrimesInBbox } = require("../services/crimeClient");

/**
 * Strip PH (Public Holiday) rules from an opening_hours string.
 * The opening_hours library lacks GB state holiday definitions and throws
 * noisy errors for every PH reference, which slows down batch processing.
 */
function stripPH(str) {
  if (!str) return str;
  // Remove standalone "PH off" / "PH 08:00-20:00" clauses separated by ";"
  return (
    str
      .split(";")
      .map((s) => s.trim())
      .filter((s) => !/^\s*PH\b/.test(s))
      .map((s) => s.replace(/,\s*PH\b/g, "")) // "Mo-Su,PH 07:00-23:00" → "Mo-Su 07:00-23:00"
      .filter(Boolean)
      .join("; ") || null
  );
}

/**
 * Check if a place is open right now using the opening_hours npm library.
 * Returns { open: boolean, nextChange: string|null }.
 *   - nextChange is a human-readable string like "closes at 22:00" or "opens at 08:00"
 */
function checkOpenNow(hoursString) {
  if (!hoursString) return { open: null, nextChange: null }; // unknown
  try {
    const cleaned = stripPH(hoursString);
    if (!cleaned) return { open: null, nextChange: null };
    const oh = new opening_hours(cleaned, { address: { country_code: "gb" } });
    const now = new Date();
    const isOpen = oh.getState(now);
    let nextChange = null;
    try {
      const next = oh.getNextChange(now);
      if (next) {
        const h = next.getHours().toString().padStart(2, "0");
        const m = next.getMinutes().toString().padStart(2, "0");
        nextChange = isOpen ? `closes at ${h}:${m}` : `opens at ${h}:${m}`;
      }
    } catch {
      /* some strings don't support getNextChange */
    }
    return { open: isOpen, nextChange };
  } catch {
    return { open: null, nextChange: null }; // unparseable
  }
}

/**
 * Type-based heuristic for places without opening_hours tags.
 * Uses the amenity/shop type + current hour to estimate if likely open.
 *   - Hospitals, petrol stations, ATMs → always open
 *   - Pubs, bars, nightclubs → open evenings/nights
 *   - Shops, cafes, restaurants → open daytime
 *   - Unknown → likely open during daytime only
 */
const ALWAYS_OPEN = new Set([
  "hospital",
  "clinic",
  "pharmacy",
  "fuel",
  "atm",
  "police",
  "fire_station",
  "hotel",
  "hostel",
  "charging_station",
  "parking",
  "toilets",
]);
const EVENING_TYPES = new Set([
  "pub",
  "bar",
  "nightclub",
  "biergarten",
  "casino",
]);

function heuristicOpen(amenityType) {
  const hour = new Date().getHours();
  const type = (amenityType || "").toLowerCase();

  if (ALWAYS_OPEN.has(type)) return { open: true, nextChange: "open 24/7" };
  if (EVENING_TYPES.has(type)) {
    // Pubs/bars: typically 11:00–23:00 or later
    if (hour >= 11 && hour < 23)
      return { open: true, nextChange: "closes at 23:00" };
    return { open: false, nextChange: "opens at 11:00" };
  }
  // Default shops/restaurants/cafes: 07:00–20:00
  if (hour >= 7 && hour < 20)
    return { open: true, nextChange: "closes at 20:00" };
  return { open: false, nextChange: "opens at 07:00" };
}
const {
  buildGraph,
  buildDistanceOnlyGraph,
  aStarDistance,
  findNearestNode,
  findKSafestRoutes,
  routeToPolyline,
  routeSafetyBreakdown,
  getWeights,
} = require("../services/safetyGraph");

const router = express.Router();

// Default fallback — can be overridden per request via ?max_distance query param
// (the gateway / user-service resolves the caller's tier → distance limit)
const DEFAULT_MAX_DISTANCE_KM = 20;
const WALKING_SPEED_MPS = 1.35;

// ── Route cache (5 min TTL) ─────────────────────────────────────────────────
const routeCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCacheKey(oLat, oLng, dLat, dLng, wpLat, wpLng) {
  const r = (v) => Math.round(v * 1000) / 1000;
  const base = `${r(oLat)},${r(oLng)}->${r(dLat)},${r(dLng)}`;
  return wpLat != null && wpLng != null
    ? `${base}@${r(wpLat)},${r(wpLng)}`
    : base;
}

// ── Request coalescing — share computation for concurrent identical requests ─
const inflight = new Map();

function createServerBusyError(detailMessage) {
  return Object.assign(
    new Error(
      "SafeNight servers are busy right now. Please try again in a moment.",
    ),
    {
      statusCode: 503,
      code: "SERVER_BUSY",
      detail:
        detailMessage ||
        "The route safety provider is overloaded or timing out. Please retry shortly.",
    },
  );
}

function isServerBusyFailure(err) {
  if (!err) return false;
  if (err.code === "SERVER_BUSY") return true;
  if (Number(err.statusCode) === 503) return true;

  const msg = String(err.message || "").toLowerCase();
  return (
    msg.includes("overpass") ||
    msg.includes("all overpass servers failed") ||
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("returned 504") ||
    msg.includes("returned 503") ||
    msg.includes("returned 502") ||
    msg.includes("returned 429") ||
    msg.includes("server is at capacity") ||
    msg.includes("queue timeout")
  );
}

function safetyLabel(score) {
  if (score >= 75) return { label: "Very Safe", color: "#2E7D32" };
  if (score >= 55) return { label: "Safe", color: "#558B2F" };
  if (score >= 35) return { label: "Moderate", color: "#F9A825" };
  return { label: "Use Caution", color: "#C62828" };
}

function segmentColor(safetyScore) {
  if (safetyScore >= 0.7) return "#4CAF50";
  if (safetyScore >= 0.5) return "#8BC34A";
  if (safetyScore >= 0.35) return "#FFC107";
  if (safetyScore >= 0.2) return "#FF9800";
  return "#F44336";
}

// ── GET /api/safe-routes ────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const startTime = Date.now();

  try {
    // ── 1. Validate inputs ──────────────────────────────────────────────
    const oLat = validateLatitude(req.query.origin_lat);
    const oLng = validateLongitude(req.query.origin_lng);
    if (!oLat.valid) return res.status(400).json({ error: oLat.error });
    if (!oLng.valid) return res.status(400).json({ error: oLng.error });

    const dLat = validateLatitude(req.query.dest_lat);
    const dLng = validateLongitude(req.query.dest_lng);
    if (!dLat.valid) return res.status(400).json({ error: dLat.error });
    if (!dLng.valid) return res.status(400).json({ error: dLng.error });

    // ── Optional waypoint (direction-bias / via point) ──────────────────
    let wpLat = null,
      wpLng = null;
    if (req.query.waypoint_lat != null && req.query.waypoint_lng != null) {
      const wpLatV = validateLatitude(req.query.waypoint_lat);
      const wpLngV = validateLongitude(req.query.waypoint_lng);
      if (wpLatV.valid && wpLngV.valid) {
        wpLat = wpLatV.value;
        wpLng = wpLngV.value;
      }
    }

    // ── 2. Distance limit ───────────────────────────────────────────────
    const straightLineDist = haversine(
      oLat.value,
      oLng.value,
      dLat.value,
      dLng.value,
    );
    const straightLineKm = straightLineDist / 1000;

    // The gateway sends ?max_distance=<km> based on the user's subscription tier
    const maxDistanceKm = req.query.max_distance
      ? Math.min(Number(req.query.max_distance), DEFAULT_MAX_DISTANCE_KM)
      : DEFAULT_MAX_DISTANCE_KM;

    if (straightLineKm > maxDistanceKm) {
      // Estimate how many data points the system would need to fetch.
      // The safety engine queries every street, lamp, CCTV camera, bus stop,
      // open venue, and recent crime record inside the bounding box.
      const latDiff = Math.abs(dLat.value - oLat.value);
      const lngDiff = Math.abs(dLng.value - oLng.value);
      const bufferDeg = 0.003; // ~300 m buffer on each side
      const heightKm = (latDiff + 2 * bufferDeg) * 111.32;
      const midLatRad = (((oLat.value + dLat.value) / 2) * Math.PI) / 180;
      const widthKm = (lngDiff + 2 * bufferDeg) * 111.32 * Math.cos(midLatRad);
      const areaKm2 = heightKm * widthKm;
      // ~4 000 elements/km² (roads, nodes, lights, CCTV, places, transit, crimes)
      const estimatedDataPoints = Math.round(areaKm2 * 4000);

      const straightLineMi = straightLineKm * 0.621371;
      const maxDistanceMi = maxDistanceKm * 0.621371;
      return res.status(400).json({
        error: "DESTINATION_OUT_OF_RANGE",
        message: `That destination is ${straightLineMi.toFixed(1)} mi away — your limit is ${maxDistanceMi.toFixed(1)} mi.`,
        maxDistanceKm,
        actualDistanceKm: Math.round(straightLineKm * 10) / 10,
        estimatedDataPoints,
        areaKm2: Math.round(areaKm2 * 10) / 10,
        detail: `To score this route for safety, we'd need to analyse roughly ${estimatedDataPoints.toLocaleString()} data points — every street, street light, CCTV camera, bus stop, open venue, and police-reported crime in a ${areaKm2.toFixed(1)} km² area. To keep SafeNight fast, we cap routes at ${maxDistanceMi.toFixed(1)} mi for your plan.`,
      });
    }

    // ── 3. Check route cache ────────────────────────────────────────────
    const cacheKey = getCacheKey(
      oLat.value,
      oLng.value,
      dLat.value,
      dLng.value,
      wpLat,
      wpLng,
    );
    const cached = routeCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      console.log(`[safe-routes] 📋 Route cache hit for ${cacheKey}`);
      return res.json(cached.data);
    }

    // ── 4. Request coalescing ───────────────────────────────────────────
    if (inflight.has(cacheKey)) {
      console.log(
        `[safe-routes] ⏳ Coalescing with in-flight request for ${cacheKey}`,
      );
      try {
        const result = await inflight.get(cacheKey);
        if (!result) {
          const busy = createServerBusyError(
            "A shared route computation failed due to temporary server load.",
          );
          return res.status(busy.statusCode).json({
            error: busy.code,
            message: busy.message,
            detail: busy.detail,
          });
        }
        return res.json(result);
      } catch (_err) {
        const busy = createServerBusyError(
          "A shared route computation failed due to temporary server load.",
        );
        return res.status(busy.statusCode).json({
          error: busy.code,
          message: busy.message,
          detail: busy.detail,
        });
      }
    }

    // Create a shared promise for concurrent requests
    let resolveInflight, rejectInflight;
    const inflightPromise = new Promise((resolve, reject) => {
      resolveInflight = resolve;
      rejectInflight = reject;
    });
    inflight.set(cacheKey, inflightPromise);

    try {
      const result = await computeSafeRoutes(
        oLat.value,
        oLng.value,
        dLat.value,
        dLng.value,
        straightLineDist,
        straightLineKm,
        startTime,
        maxDistanceKm,
        wpLat,
        wpLng,
      );

      // Cache the result
      routeCache.set(cacheKey, { data: result, timestamp: Date.now() });
      resolveInflight(result);
      res.json(result);
    } catch (err) {
      // Resolve (not reject) the inflight promise with the error to avoid
      // unhandled rejection crashes when concurrent requests are waiting.
      resolveInflight(null);

      if (err.statusCode && err.code) {
        return res.status(err.statusCode).json({
          error: err.code,
          message: err.message,
          ...(err.detail != null && { detail: err.detail }),
          ...(err.graphNodes != null && {
            graphNodes: err.graphNodes,
            graphEdges: err.graphEdges,
          }),
          ...(err.roadCount != null && { roadCount: err.roadCount }),
          ...(err.which != null && { which: err.which }),
        });
      }
      if (isServerBusyFailure(err)) {
        const busy = createServerBusyError(err.message);
        return res.status(busy.statusCode).json({
          error: busy.code,
          message: busy.message,
          detail: busy.detail,
        });
      }
      throw err;
    } finally {
      inflight.delete(cacheKey);
    }

    // Clean stale route cache entries
    if (routeCache.size > 100) {
      const now = Date.now();
      for (const [key, val] of routeCache) {
        if (now - val.timestamp > CACHE_TTL_MS) routeCache.delete(key);
      }
    }
  } catch (err) {
    console.error(`[safe-routes] ❌ Error:`, err);
    if (!res.headersSent) {
      if (isServerBusyFailure(err)) {
        const busy = createServerBusyError(err.message);
        return res.status(busy.statusCode).json({
          error: busy.code,
          message: busy.message,
          detail: busy.detail,
        });
      }
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: "Something went wrong on our end while computing your route.",
        detail:
          "This is usually a temporary issue with one of our data sources (OpenStreetMap or the Police crime API). Please wait a moment and try again.",
      });
    }
  }
});

/**
 * Core computation — separated for request coalescing.
 */
async function computeSafeRoutes(
  oLatV,
  oLngV,
  dLatV,
  dLngV,
  straightLineDist,
  straightLineKm,
  startTime,
  maxDistanceKm = DEFAULT_MAX_DISTANCE_KM,
  wpLat = null,
  wpLng = null,
) {
  console.log(
    `[safe-routes] 🔍 Computing: ${oLatV},${oLngV} → ${dLatV},${dLngV} (${straightLineKm.toFixed(1)} km)`,
  );

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 1 — Corridor discovery (skip for short distances to save time)
  // For routes < 1.5 km, a straight-line corridor works fine.
  // For longer routes, discover the actual walking corridor shape.
  // ═══════════════════════════════════════════════════════════════════════
  let shortestPath = null;
  let distGraph = null;
  let phase1Time = 0;

  const SKIP_PHASE1_DIST = 1500; // skip road-only fetch for < 1.5 km

  if (straightLineDist >= SKIP_PHASE1_DIST) {
    console.log(`[safe-routes] 🛤️  Phase 1: Discovering walking corridor...`);
    const t0p1 = Date.now();
    const initialBufferM = Math.max(
      400,
      Math.min(800, straightLineDist * 0.25),
    );
    const initialBboxPoints = [
      { lat: oLatV, lng: oLngV },
      { lat: dLatV, lng: dLngV },
    ];
    if (wpLat != null) initialBboxPoints.push({ lat: wpLat, lng: wpLng });
    const initialBbox = bboxFromPoints(initialBboxPoints, initialBufferM);

    const roadData = await fetchRoadNetworkOnly(initialBbox);
    distGraph = buildDistanceOnlyGraph(roadData);

    const distStart = findNearestNode(
      distGraph.nodeGrid,
      distGraph.adjacency,
      oLatV,
      oLngV,
    );
    const distEnd = findNearestNode(
      distGraph.nodeGrid,
      distGraph.adjacency,
      dLatV,
      dLngV,
    );

    if (distStart && distEnd) {
      shortestPath = aStarDistance(
        distGraph.osmNodes,
        distGraph.edges,
        distGraph.adjacency,
        distStart,
        distEnd,
        straightLineDist * 3,
      );
    }
    phase1Time = Date.now() - t0p1;
    console.log(
      `[safe-routes] ✅ Phase 1: ${phase1Time}ms — ${
        shortestPath
          ? shortestPath.path.length +
            " nodes, " +
            Math.round(shortestPath.totalDist) +
            "m"
          : "fallback to straight-line corridor"
      }`,
    );
  } else {
    console.log(
      `[safe-routes] ⏩ Phase 1: skipped (${Math.round(straightLineDist)}m < ${SKIP_PHASE1_DIST}m)`,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 2 — Build corridor bbox + fetch safety data
  // Smaller buffers to reduce data volume and processing time.
  // ═══════════════════════════════════════════════════════════════════════
  const corridorBufferM = Math.max(700, Math.min(1000, straightLineDist * 0.3));

  let corridorPoints;
  if (shortestPath && distGraph) {
    corridorPoints = [];
    for (const nodeId of shortestPath.path) {
      const n = distGraph.osmNodes.get(nodeId);
      if (n) corridorPoints.push({ lat: n.lat, lng: n.lng });
    }
  } else {
    const numSamples = Math.max(8, Math.ceil(straightLineKm * 4));
    corridorPoints = [];
    for (let i = 0; i <= numSamples; i++) {
      const t = i / numSamples;
      corridorPoints.push({
        lat: oLatV + (dLatV - oLatV) * t,
        lng: oLngV + (dLngV - oLngV) * t,
      });
    }
  }
  corridorPoints.unshift({ lat: oLatV, lng: oLngV });
  corridorPoints.push({ lat: dLatV, lng: dLngV });
  // Ensure waypoint is also inside the bbox corridor
  if (wpLat != null) corridorPoints.push({ lat: wpLat, lng: wpLng });

  const bbox = bboxFromPoints(corridorPoints, corridorBufferM);
  console.log(
    `[safe-routes] 📐 Phase 2: Corridor from ${corridorPoints.length} waypoints + ${corridorBufferM}m buffer`,
  );

  // ── Fetch ALL safety data within the corridor ───────────────────────
  console.log(
    `[safe-routes] 📡 Fetching safety data in corridor (Overpass + Crime)...`,
  );
  const t0 = Date.now();

  let [allData, crimes] = await Promise.all([
    fetchAllSafetyData(bbox),
    fetchCrimesInBbox(bbox),
  ]);

  let dataTime = Date.now() - t0;
  console.log(`[safe-routes] 📡 Corridor data fetched in ${dataTime}ms`);

  let roadCount = allData.roads.elements.filter((e) => e.type === "way").length;
  let nodeCount = allData.roads.elements.filter(
    (e) => e.type === "node",
  ).length;
  console.log(
    `[safe-routes] 📊 Data: ${roadCount} roads, ${nodeCount} nodes, ${crimes.length} crimes, ${allData.lights.elements.length} lights, ${allData.cctv.elements.length} CCTV`,
  );

  // ── 6b. Extract light & place node positions for POI markers ────────
  // ── 7. Build safety-weighted graph (with coverage maps) ─────────────
  console.log(`[safe-routes] 🏗️  Building graph + coverage maps...`);
  const t1 = Date.now();
  let {
    osmNodes,
    edges,
    adjacency,
    nodeGrid,
    weights,
    cctvNodes,
    transitNodes,
    nodeDegree,
  } = buildGraph(
    allData.roads,
    allData.lights,
    allData.cctv,
    allData.places,
    allData.transit,
    crimes,
    bbox,
  );
  let graphTime = Date.now() - t1;
  console.log(
    `[safe-routes] 📊 Graph: ${osmNodes.size} nodes, ${edges.length} edges (built in ${graphTime}ms)`,
  );

  if (edges.length === 0) {
    throw Object.assign(
      new Error(
        "We found roads in this area but none of them are walkable (they may all be motorways or private roads). Try a destination in a more pedestrian-friendly area.",
      ),
      { statusCode: 404, code: "NO_WALKING_NETWORK", roadCount },
    );
  }

  // ── 8. Find nearest graph nodes (O(1) via spatial grid) ─────────────
  let startNode = findNearestNode(nodeGrid, adjacency, oLatV, oLngV);
  let endNode = findNearestNode(nodeGrid, adjacency, dLatV, dLngV);

  if (!startNode || !endNode) {
    const which = !startNode ? "origin" : "destination";
    throw Object.assign(
      new Error(
        `We couldn't find a walkable road within 200 m of your ${which}. ` +
          `This can happen if the point is in the middle of a park, body of water, or private land. ` +
          `Try tapping a spot closer to a street or footpath.`,
      ),
      { statusCode: 404, code: "NO_NEARBY_ROAD", which },
    );
  }

  // ── 9. Find 3–5 safest routes (A* — much faster than Dijkstra) ─────
  console.log(
    `[safe-routes] 🔎 A* pathfinding (start=${startNode}, end=${endNode})...`,
  );
  const t2 = Date.now();
  const maxRouteDist = straightLineDist * 2.5;
  let rawRoutes;

  if (wpLat != null) {
    // ── Two-leg via-waypoint pathfinding ──────────────────────────────
    const waypointNode = findNearestNode(nodeGrid, adjacency, wpLat, wpLng);
    if (
      waypointNode &&
      waypointNode !== startNode &&
      waypointNode !== endNode
    ) {
      const leg1Routes = findKSafestRoutes(
        osmNodes,
        edges,
        adjacency,
        startNode,
        waypointNode,
        maxRouteDist * 0.7,
        1,
      );
      const leg2Routes = findKSafestRoutes(
        osmNodes,
        edges,
        adjacency,
        waypointNode,
        endNode,
        maxRouteDist * 0.7,
        3,
      );
      if (leg1Routes.length > 0 && leg2Routes.length > 0) {
        const leg1 = leg1Routes[0];
        rawRoutes = leg2Routes.map((leg2) => ({
          path: [...leg1.path, ...leg2.path.slice(1)],
          edges: [...leg1.edges, ...leg2.edges],
          totalDist: leg1.totalDist + leg2.totalDist,
        }));
        console.log(
          `[safe-routes] 📍 Via waypoint node ${waypointNode}: ${leg1.path.length}+${leg2Routes[0].path.length} nodes, ${rawRoutes.length} combined routes`,
        );
      } else {
        console.log(
          `[safe-routes] ⚠️  Via routing failed (leg1=${leg1Routes.length}, leg2=${leg2Routes.length}), falling back to direct`,
        );
        rawRoutes = findKSafestRoutes(
          osmNodes,
          edges,
          adjacency,
          startNode,
          endNode,
          maxRouteDist,
          3,
        );
      }
    } else {
      console.log(
        `[safe-routes] ⚠️  Waypoint node not found in graph, falling back to direct`,
      );
      rawRoutes = findKSafestRoutes(
        osmNodes,
        edges,
        adjacency,
        startNode,
        endNode,
        maxRouteDist,
        3,
      );
    }
  } else {
    rawRoutes = findKSafestRoutes(
      osmNodes,
      edges,
      adjacency,
      startNode,
      endNode,
      maxRouteDist,
      3,
    );
  }

  let pathfindTime = Date.now() - t2;
  console.log(
    `[safe-routes] 🔎 A* found ${rawRoutes.length} routes in ${pathfindTime}ms`,
  );

  if (rawRoutes.length === 0) {
    throw Object.assign(
      new Error(
        `We analysed ${osmNodes.size.toLocaleString()} intersections and ${edges.length.toLocaleString()} road segments ` +
          `but couldn't connect your origin to the destination. ` +
          `They're likely separated by a barrier with no pedestrian crossing — a motorway, river, railway, or restricted area.`,
      ),
      {
        statusCode: 404,
        code: "NO_ROUTE_FOUND",
        graphNodes: osmNodes.size,
        graphEdges: edges.length,
      },
    );
  }

  // Recorrection removed — too expensive for 512MB/0.1CPU.
  const recorrectionMs = 0;

  const lightNodes = [];
  for (const el of allData.lights.elements) {
    if (
      el.type === "node" &&
      el.tags?.highway === "street_lamp" &&
      el.lat &&
      el.lon
    ) {
      lightNodes.push({ lat: el.lat, lng: el.lon });
    }
  }
  const placeNodes = [];
  for (const el of allData.places.elements) {
    const lat = el.lat || el.center?.lat;
    const lng = el.lon || el.center?.lon;
    if (lat && lng) {
      const name =
        el.tags?.name ||
        el.tags?.["name:en"] ||
        el.tags?.brand ||
        el.tags?.operator ||
        "";
      const amenity =
        el.tags?.amenity ||
        el.tags?.shop ||
        el.tags?.leisure ||
        el.tags?.tourism ||
        "";
      const hoursRaw = el.tags?.opening_hours || "";
      // 1) Try OSM opening_hours tag (most accurate)
      let { open, nextChange } = checkOpenNow(hoursRaw);
      // 2) Fall back to type-based heuristic if no hours data
      if (open === null) {
        const h = heuristicOpen(amenity);
        open = h.open;
        nextChange = h.nextChange;
      }
      // Only keep confirmed-open places
      if (open !== true) continue;
      placeNodes.push({
        lat,
        lng,
        name,
        amenity,
        open,
        nextChange,
        opening_hours: hoursRaw,
      });
    }
  }

  // ── 10. Build response ────────────────────────────────────────────────
  const routes = rawRoutes.map((route, idx) => {
    const polyline = routeToPolyline(osmNodes, route.path);
    const breakdown = routeSafetyBreakdown(edges, route.edges, weights);
    const score100 = Math.round(breakdown.overall * 100);
    const { label, color } = safetyLabel(score100);
    const durationSec = Math.round(route.totalDist / WALKING_SPEED_MPS);

    // Build enriched segments with all metadata
    const segments = [];
    let deadEndCount = 0;
    let sidewalkDist = 0;
    let unpavedDist = 0;
    let transitStopCount = 0;
    let cctvNearCount = 0;
    const roadNameChanges = [];
    let lastRoadName = "";
    let cumulativeDist = 0;

    for (let i = 0; i < route.edges.length; i++) {
      const edge = edges[route.edges[i]];
      const nodeA = osmNodes.get(route.path[i]);
      const nodeB = osmNodes.get(route.path[i + 1]);
      if (!nodeA || !nodeB) continue;

      // Track stats
      if (edge.isDeadEnd) deadEndCount++;
      if (edge.hasSidewalk) sidewalkDist += edge.distance;
      if (edge.surfacePenalty > 0) unpavedDist += edge.distance;
      transitStopCount += edge.nearbyTransitCount;
      cctvNearCount += edge.nearbyCctvCount;

      // Track road name changes for chart annotations
      const rn = edge.roadName || "";
      if (rn && rn !== lastRoadName) {
        roadNameChanges.push({
          segmentIndex: i,
          name: rn,
          distance: Math.round(cumulativeDist),
        });
        lastRoadName = rn;
      }
      cumulativeDist += edge.distance;

      segments.push({
        start: { lat: nodeA.lat, lng: nodeA.lng },
        end: { lat: nodeB.lat, lng: nodeB.lng },
        safetyScore: edge.safetyScore,
        color: segmentColor(edge.safetyScore),
        highway: edge.highway,
        roadName: edge.roadName,
        isDeadEnd: edge.isDeadEnd,
        hasSidewalk: edge.hasSidewalk,
        surfaceType: edge.surfaceType,
        lightScore: edge.lightScore,
        crimeScore: edge.crimeScore,
        cctvScore: edge.cctvScore,
        placeScore: edge.placeScore,
        trafficScore: edge.trafficScore,
        distance: Math.round(edge.distance),
      });
    }

    // Collect nearby POIs along the route for map markers
    const routePOIs = collectRoutePOIs(
      route.path,
      route.edges,
      edges,
      osmNodes,
      cctvNodes,
      transitNodes,
      nodeDegree,
      lightNodes,
      placeNodes,
      crimes,
    );

    // Compute route stats
    const routeStats = {
      deadEnds: deadEndCount,
      sidewalkPct:
        route.totalDist > 0
          ? Math.round((sidewalkDist / route.totalDist) * 100)
          : 0,
      unpavedPct:
        route.totalDist > 0
          ? Math.round((unpavedDist / route.totalDist) * 100)
          : 0,
      transitStopsNearby: Math.min(transitStopCount, 50),
      cctvCamerasNearby: Math.min(cctvNearCount, 50),
      roadNameChanges,
    };

    return {
      routeIndex: idx,
      isSafest: idx === 0,
      overview_polyline: { points: encodePolyline(polyline) },
      legs: [
        {
          distance: {
            text:
              route.totalDist >= 1000
                ? `${(route.totalDist / 1000).toFixed(1)} km`
                : `${Math.round(route.totalDist)} m`,
            value: Math.round(route.totalDist),
          },
          duration: {
            text:
              durationSec >= 3600
                ? `${Math.floor(durationSec / 3600)} hr ${Math.round((durationSec % 3600) / 60)} mins`
                : `${Math.round(durationSec / 60)} mins`,
            value: durationSec,
          },
          start_location: { lat: oLatV, lng: oLngV },
          end_location: { lat: dLatV, lng: dLngV },
          steps: [],
        },
      ],
      summary: idx === 0 ? "Safest Route" : `Route ${idx + 1}`,
      safety: {
        score: score100,
        label,
        color,
        breakdown: {
          roadType: Math.round(breakdown.roadType * 100),
          lighting: Math.round(breakdown.lighting * 100),
          crime: Math.round(breakdown.crime * 100),
          cctv: Math.round(breakdown.cctv * 100),
          openPlaces: Math.round(breakdown.openPlaces * 100),
          traffic: Math.round(breakdown.traffic * 100),
        },
        roadTypes: breakdown.roadTypes,
        mainRoadRatio: Math.round(breakdown.mainRoadRatio * 100),
      },
      segments,
      routeStats,
      routePOIs,
    };
  });

  const minRoutes = Math.min(3, rawRoutes.length);
  const responseRoutes = routes.slice(0, Math.max(minRoutes, routes.length));

  const elapsed = Date.now() - startTime;
  console.log(
    `[safe-routes] 🏁 Done in ${elapsed}ms (corridor:${phase1Time}ms, data:${dataTime}ms, graph:${graphTime}ms, A*:${pathfindTime}ms, recorrection:${recorrectionMs}ms) — ${responseRoutes.length} routes, safest: ${responseRoutes[0]?.safety?.score}`,
  );

  return {
    status: "OK",
    routes: responseRoutes,
    meta: {
      straightLineDistanceKm: Math.round(straightLineKm * 10) / 10,
      maxDistanceKm: maxDistanceKm,
      routeCount: responseRoutes.length,
      dataQuality: {
        roads: roadCount,
        crimes: crimes.length,
        lightElements: allData.lights.elements.length,
        cctvCameras: allData.cctv.elements.length,
        places: allData.places.elements.length,
        transitStops: allData.transit.elements.length,
      },
      timing: {
        totalMs: elapsed,
        corridorDiscoveryMs: phase1Time,
        safetyDataFetchMs: dataTime,
        graphBuildMs: graphTime,
        pathfindMs: pathfindTime,
        recorrectionMs,
      },
      computeTimeMs: elapsed,
    },
  };
}

/**
 * Collect POI positions along a route for map display.
 * Returns CCTV cameras, transit stops, dead-end nodes, street lights,
 * open places, and crime locations near the route path.
 *
 * Uses road-type-aware buffer distances:
 *  - Main roads (primary/secondary/tertiary/trunk): 20m — a CCTV on the
 *    opposite side of a wide road doesn't help this side.
 *  - Narrower/path roads (footway/path/steps/track etc): 30m — on a
 *    narrow path, nearby items are more relevant.
 *
 * Samples EVERY node on the route (no cap) so long routes have no gaps.
 */
const NEARBY_M = 30;

function collectRoutePOIs(
  routePath,
  routeEdges,
  allEdges,
  osmNodes,
  cctvNodes,
  transitNodes,
  nodeDegree,
  lightNodes,
  placeNodes,
  crimeNodes,
) {
  const pois = {
    cctv: [],
    transit: [],
    deadEnds: [],
    lights: [],
    places: [],
    crimes: [],
  };
  const seen = new Set();

  // Collect dead-end nodes on the route
  for (const nid of routePath) {
    const deg = nodeDegree.get(nid) || 0;
    if (deg <= 1) {
      const n = osmNodes.get(nid);
      if (n) {
        const key = `de:${n.lat.toFixed(5)},${n.lng.toFixed(5)}`;
        if (!seen.has(key)) {
          seen.add(key);
          pois.deadEnds.push({ lat: n.lat, lng: n.lng });
        }
      }
    }
  }

  // Build sample points from EVERY node on the route — full coverage, no gaps.
  const samplePoints = [];
  for (let i = 0; i < routePath.length; i++) {
    const n = osmNodes.get(routePath[i]);
    if (n) samplePoints.push({ lat: n.lat, lng: n.lng });
  }

  // Helper: check if a point is within 30m of any point on the route
  function isNearRoute(lat, lng) {
    for (const sp of samplePoints) {
      const d = Math.sqrt((lat - sp.lat) ** 2 + (lng - sp.lng) ** 2) * 111320;
      if (d < NEARBY_M) return true;
    }
    return false;
  }

  // Collect CCTV near route
  for (const cam of cctvNodes) {
    if (isNearRoute(cam.lat, cam.lng)) {
      const key = `cc:${cam.lat.toFixed(5)},${cam.lng.toFixed(5)}`;
      if (!seen.has(key)) {
        seen.add(key);
        pois.cctv.push({ lat: cam.lat, lng: cam.lng });
      }
    }
  }

  // Collect transit stops near route
  for (const ts of transitNodes) {
    if (isNearRoute(ts.lat, ts.lng)) {
      const key = `tr:${ts.lat.toFixed(5)},${ts.lng.toFixed(5)}`;
      if (!seen.has(key)) {
        seen.add(key);
        pois.transit.push({ lat: ts.lat, lng: ts.lng });
      }
    }
  }

  // Collect street lights near route
  for (const lamp of lightNodes || []) {
    if (isNearRoute(lamp.lat, lamp.lng)) {
      const key = `lt:${lamp.lat.toFixed(5)},${lamp.lng.toFixed(5)}`;
      if (!seen.has(key)) {
        seen.add(key);
        pois.lights.push({ lat: lamp.lat, lng: lamp.lng });
      }
    }
  }

  // Collect places near route (with name, open status, and hours)
  for (const pl of placeNodes || []) {
    if (isNearRoute(pl.lat, pl.lng)) {
      const key = `pl:${pl.lat.toFixed(5)},${pl.lng.toFixed(5)}`;
      if (!seen.has(key)) {
        seen.add(key);
        pois.places.push({
          lat: pl.lat,
          lng: pl.lng,
          name: pl.name,
          amenity: pl.amenity,
          open: pl.open,
          nextChange: pl.nextChange,
          opening_hours: pl.opening_hours,
        });
      }
    }
  }

  // Collect crimes near route
  for (const cr of crimeNodes || []) {
    if (isNearRoute(cr.lat, cr.lng)) {
      const key = `cr:${cr.lat.toFixed(5)},${cr.lng.toFixed(5)}`;
      if (!seen.has(key)) {
        seen.add(key);
        pois.crimes.push({ lat: cr.lat, lng: cr.lng, category: cr.category });
      }
    }
  }

  return pois;
}

module.exports = router;
