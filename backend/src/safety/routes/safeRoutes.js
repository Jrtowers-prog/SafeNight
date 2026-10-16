
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
const {
  haversine,
  bboxFromPoints,
  buildSpatialGrid,
} = require("../services/geo");
const { fetchAllSafetyData } = require("../services/overpassClient");
const {
  SAFETY_LEVEL_STANDARD,
  SAFETY_LEVEL_EXTRA,
} = require("../services/safetyLevels");
const { fetchCrimesInBbox } = require("../services/crimeClient");
const {
  fetchRoadNetwork: fetchLocalOsmRoadNetwork,
  fetchSafetyData: fetchLocalOsmSafetyData,
} = require("../services/sourceFusionEngine");
const {
  recordRouteLatency,
  recordSourceDecision,
  recordLightVerification,
  recordOsNgdGapFill,
} = require("../services/osMetrics");
const {
  createCancellationToken,
  logSearchCancellation,
  registerActiveSearch,
  estimateRequestLoadUnits,
  enqueueComputeJob,
  waitWithCancellation,
  formatWaitMmSs,
} = require("./safeRoutesRuntime");
const {
  createSafeRoutesOrchestrator,
} = require("./safeRoutesOrchestrator");
const {
  parseRouteRequest,
  buildOutOfRangeMessage,
  buildOutOfRangePayload,
} = require("./safeRoutesRequestPolicy");
const { buildRouteResponses } = require("./safeRoutesResponseFormatter");
const { buildSafeRoutesMeta } = require("./safeRoutesMetaBuilder");
const { findRouteCandidates } = require("./safeRoutesCandidateFinder");
const {
  buildGraph,
  buildDistanceOnlyGraph,
  aStarDistance,
  findNearestNode,
  findKSafestRoutes,
} = require("../services/safetyGraph");
const {
  computeSampledLightConfidence,
  mergeVerifiedLights,
  calculateRouteUncertainty,
  buildRouteLightGapSpans,
  CONFIDENCE_THRESHOLDS,
} = require("../services/lightConfidenceEngine");
const { verifyLightGaps } = require("../services/osNgdMicroQuery");

const router = express.Router();

// Default fallback — can be overridden per request via ?max_distance query param
// (the gateway / user-service resolves the caller's tier → distance limit)
const DEFAULT_MAX_DISTANCE_KM = 20;
const ENABLE_RESPONSE_OPENING_HOURS_PARSE =
  process.env.SAFE_ROUTES_PARSE_RESPONSE_OPENING_HOURS === "1";
const DEBUG_SAFE_ROUTES = process.env.SAFE_ROUTES_DEBUG === "1";
const debugLog = DEBUG_SAFE_ROUTES ? (...args) => console.log(...args) : () => {};
const debugLogger = DEBUG_SAFE_ROUTES
  ? console
  : { log: () => {}, warn: () => {}, error: () => {} };

// Missing → "extra" (unchanged default). Anything other than the two levels → null.
function parseSafetyLevel(value) {
  if (value == null || value === "") return SAFETY_LEVEL_EXTRA;
  return value === SAFETY_LEVEL_STANDARD || value === SAFETY_LEVEL_EXTRA
    ? value
    : null;
}

function isServerBusyError(err) {
  if (!err) return false;
  if (err.statusCode === 503 || err.isServerBusy || err.code === "UPSTREAM_UNAVAILABLE") {
    return true;
  }

  const msg = String(err.message || "");
  return (
    /Overpass .* returned (403|429|5\d\d)/i.test(msg) ||
    /Overpass .* timed out/i.test(msg) ||
    /All Overpass servers failed/i.test(msg)
  );
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const { resolveSafeRoutesRequest, hasInflightRequest } = createSafeRoutesOrchestrator({
  computeSafeRoutes,
  estimateRequestLoadUnits,
  enqueueComputeJob,
  waitWithCancellation,
  formatWaitMmSs,
  cacheTtlMs: CACHE_TTL_MS,
});

// ── GET /api/safe-routes ────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const cancelToken = createCancellationToken();
  const activeSearch = registerActiveSearch(req, cancelToken);
  let requestSettled = false;
  const sendJson = (statusCode, payload) => {
    requestSettled = true;
    return res.status(statusCode).json(payload);
  };
  if (activeSearch.stale) {
    logSearchCancellation("http_stale_response", {
      userKey: activeSearch.userKey,
      searchId: activeSearch.searchId,
      searchSeq: activeSearch.searchSeq,
    });
    return sendJson(409, {
      error: "SEARCH_CANCELLED",
      message:
        "This route search is older than another active search on your account.",
    });
  }
  req.on("close", () => {
    if (requestSettled) return;
    logSearchCancellation("http_client_disconnected", {
      userKey: activeSearch.userKey,
      searchId: activeSearch.searchId,
      searchSeq: activeSearch.searchSeq,
    });
    cancelToken.cancel(
      "Route search was cancelled because the client disconnected.",
    );
  });

  try {
    const parsedRequest = parseRouteRequest(
      req,
      DEFAULT_MAX_DISTANCE_KM,
      haversine,
    );
    if (!parsedRequest.ok) {
      return sendJson(400, { error: parsedRequest.error });
    }

    // ── Optional safety level: "extra" (default) or "standard" (faster) ──
    const safetyLevel = parseSafetyLevel(req.query.safety_level);
    if (!safetyLevel) {
      return sendJson(400, {
        error: "INVALID_SAFETY_LEVEL",
        message: "safety_level must be 'standard' or 'extra'.",
      });
    }

    const {
      oLat,
      oLng,
      dLat,
      dLng,
      wpLat,
      wpLng,
      straightLineDist,
      straightLineKm,
      maxDistanceKm,
      departureHour,
      allowHazards,
      responsePolicy,
    } = parsedRequest.value;

    if (straightLineKm > maxDistanceKm) {
      return sendJson(
        400,
        buildOutOfRangePayload({
          oLat,
          oLng,
          dLat,
          dLng,
          straightLineKm,
          maxDistanceKm,
        }),
      );
    }

    const { result } = await resolveSafeRoutesRequest({
      oLat,
      oLng,
      dLat,
      dLng,
      straightLineDist,
      straightLineKm,
      maxDistanceKm,
      wpLat,
      wpLng,
      departureHour,
      allowHazards,
      responsePolicy,
      cancelToken,
      safetyLevel,
    });

    requestSettled = true;
    res.json(result);
  } catch (err) {
    if (err?.code === "SEARCH_CANCELLED") {
      logSearchCancellation("http_cancelled_response", {
        userKey: activeSearch.userKey,
        searchId: activeSearch.searchId,
        searchSeq: activeSearch.searchSeq,
        reason: err.message,
      });
      if (!res.headersSent) {
        return sendJson(409, {
          error: "SEARCH_CANCELLED",
          message: err.message,
        });
      }
      return;
    }

    if (err.code === 'OS_CAP_EXCEEDED' || err.name === 'OsCapExceededError') {
      console.error(`[safe-routes] 🚫 OS cap exceeded — returning maintenance message`);
      if (!res.headersSent) {
        return sendJson(503, {
          error: "SERVICE_UNAVAILABLE",
          message: err.message,
        });
      }
      return;
    }

    if (isServerBusyError(err)) {
      console.warn(`[safe-routes] ⚠️ Server busy / upstream unavailable:`, err?.message || err);
      if (!res.headersSent) {
        return sendJson(503, {
          error: "SERVER_BUSY",
          message: "Our routing providers are temporarily busy. Please retry in a moment.",
          detail:
            "This is usually temporary (mapping or crime data provider overload). Please try again shortly.",
        });
      }
      return;
    }

    console.error(`[safe-routes] ❌ Error:`, err);
    if (!res.headersSent) {
      sendJson(500, {
        error: "INTERNAL_ERROR",
        message: "Something went wrong on our end while computing your route.",
        detail:
          "This is usually a temporary issue with one of our data sources (OpenStreetMap or the Police crime API). Please wait a moment and try again.",
      });
    }
  } finally {
    activeSearch.release();
  }
});

// ── GET /api/safe-routes/stream (SSE progress, low-overhead) ──────────────
router.get("/stream", async (req, res) => {
  let closed = false;
  let keepAliveTimer = null;
  const cancelToken = createCancellationToken();
  const activeSearch = registerActiveSearch(req, cancelToken);

  if (activeSearch.stale) {
    logSearchCancellation("sse_stale_response", {
      userKey: activeSearch.userKey,
      searchId: activeSearch.searchId,
      searchSeq: activeSearch.searchSeq,
    });
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    res.write("event: error\n");
    res.write(
      `data: ${JSON.stringify({ code: "SEARCH_CANCELLED", message: "This route search is older than another active search on your account.", pct: 0 })}\n\n`,
    );
    return res.end();
  }

  const cleanup = () => {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  };

  req.on("close", () => {
    closed = true;
    logSearchCancellation("sse_client_disconnected", {
      userKey: activeSearch.userKey,
      searchId: activeSearch.searchId,
      searchSeq: activeSearch.searchSeq,
    });
    cancelToken.cancel(
      "Route search was cancelled because the client disconnected.",
    );
    activeSearch.release();
    cleanup();
  });

  cancelToken.onCancel((reason) => {
    if (closed) return;
    logSearchCancellation("sse_cancel_signal", {
      userKey: activeSearch.userKey,
      searchId: activeSearch.searchId,
      searchSeq: activeSearch.searchSeq,
      reason,
    });
    send("error", { code: "SEARCH_CANCELLED", message: reason, pct: 0 });
    closed = true;
    cleanup();
    try {
      res.end();
    } catch {
      // ignore
    }
    activeSearch.release();
  });

  const send = (event, data) => {
    if (closed) return;
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Client disconnected
    }
  };

  try {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    keepAliveTimer = setInterval(() => {
      if (closed) return;
      try {
        res.write(": keepalive\n\n");
      } catch {
        // ignore write failures
      }
    }, 15000);

    send("phase", {
      phase: "init",
      message: "Starting route analysis…",
      pct: 20,
    });

    const parsedRequest = parseRouteRequest(
      req,
      DEFAULT_MAX_DISTANCE_KM,
      haversine,
    );
    if (!parsedRequest.ok) {
      send("error", { message: parsedRequest.error, pct: 0 });
      return res.end();
    }

    const safetyLevel = parseSafetyLevel(req.query.safety_level);
    if (!safetyLevel) {
      send("error", {
        error: "INVALID_SAFETY_LEVEL",
        message: "safety_level must be 'standard' or 'extra'.",
        pct: 0,
      });
      return res.end();
    }

    const {
      oLat,
      oLng,
      dLat,
      dLng,
      wpLat,
      wpLng,
      straightLineDist,
      straightLineKm,
      maxDistanceKm,
      responsePolicy,
    } = parsedRequest.value;

    if (straightLineKm > maxDistanceKm) {
      send("error", {
        message: buildOutOfRangeMessage(straightLineKm, maxDistanceKm),
        pct: 0,
      });
      return res.end();
    }

    if (
      hasInflightRequest({
        oLat,
        oLng,
        dLat,
        dLng,
        wpLat,
        wpLng,
        responsePolicy,
        safetyLevel,
      })
    ) {
      send("phase", {
        phase: "coalesced",
        message: "Joining active route computation…",
        pct: 20,
      });
    }

    const onProgress = (phase, message, pct) => {
      send("phase", { phase, message, pct });
    };

    const { source } = await resolveSafeRoutesRequest({
      oLat,
      oLng,
      dLat,
      dLng,
      straightLineDist,
      straightLineKm,
      maxDistanceKm,
      wpLat,
      wpLng,
      responsePolicy,
      onProgress,
      cancelToken,
      safetyLevel,
    });

    if (source === "cache") {
      send("phase", {
        phase: "cache_hit",
        message: "Using cached route analysis…",
        pct: 96,
      });
    }

    send("done", { pct: 100, message: "Routes ready!" });
    cleanup();
    activeSearch.release();
    res.end();
  } catch (err) {
    if (err?.code === "SEARCH_CANCELLED") {
      logSearchCancellation("sse_cancelled_response", {
        userKey: activeSearch.userKey,
        searchId: activeSearch.searchId,
        searchSeq: activeSearch.searchSeq,
        reason: err.message,
      });
      send("error", { code: "SEARCH_CANCELLED", message: err.message, pct: 0 });
      cleanup();
      activeSearch.release();
      return res.end();
    }

    if (isServerBusyError(err)) {
      send("error", {
        code: "SERVER_BUSY",
        message: "Our routing providers are temporarily busy. Please retry in a moment.",
        pct: 0,
      });
      cleanup();
      activeSearch.release();
      return res.end();
    }

    send("error", {
      message:
        err?.message || "Something went wrong while streaming route progress.",
      pct: 0,
    });
    cleanup();
    activeSearch.release();
    res.end();
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
  departureHour = null,
  allowHazards = false,
  cancelToken = null,
  onProgress = null,
  responsePolicy = null,
  safetyLevel = SAFETY_LEVEL_EXTRA,
) {
  cancelToken?.throwIfCancelled?.();
  const upstreamAbortController = new AbortController();
  const cancelUnsub = cancelToken?.onCancel?.(() => {
    try {
      upstreamAbortController.abort();
    } catch {
      // ignore abort errors
    }
  });

  const progress = (phase, message, pct) => {
    if (typeof onProgress !== "function") return;
    if (cancelToken?.isCancelled?.()) return;
    try {
      onProgress(phase, message, pct);
    } catch {
      // no-op: progress is best-effort
    }
  };

  progress("start", "Preparing route analysis…", 20);
  debugLog(
    `[safe-routes] 🔍 Computing: ${oLatV},${oLngV} → ${dLatV},${dLngV} (${straightLineKm.toFixed(1)} km)`,
  );

  try {
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
      cancelToken?.throwIfCancelled?.();
      progress("phase1", "Discovering walking corridor…", 28);
      debugLog(`[safe-routes] 🛤️  Phase 1: Discovering walking corridor...`);
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

      try {
        const roadData = await fetchLocalOsmRoadNetwork(initialBbox, {
          signal: upstreamAbortController.signal,
          routeKey: `${oLatV},${oLngV}->${dLatV},${dLngV}`,
        });
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
      } catch (err) {
        if (err?.code === "SEARCH_CANCELLED") throw err;
        if (isServerBusyError(err)) {
          console.warn(
            `[safe-routes] ⚠️ Phase 1 degraded (${String(err?.message || err).slice(0, 180)}). Continuing with straight-line corridor.`,
          );
          shortestPath = null;
          distGraph = null;
          progress("phase1_degraded", "Skipping corridor discovery due to upstream delay…", 36);
        } else {
          throw err;
        }
      }
      phase1Time = Date.now() - t0p1;
      cancelToken?.throwIfCancelled?.();
      progress("phase1_done", "Walking corridor discovered.", 38);
      debugLog(
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
      progress(
        "phase1_skipped",
        "Skipping corridor discovery for short route.",
        34,
      );
      debugLog(
        `[safe-routes] ⏩ Phase 1: skipped (${Math.round(straightLineDist)}m < ${SKIP_PHASE1_DIST}m)`,
      );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 2 — Build corridor bbox + fetch safety data
    // Smaller buffers to reduce data volume and processing time.
    // ═══════════════════════════════════════════════════════════════════════
    const corridorBufferM = Math.max(
      700,
      Math.min(1000, straightLineDist * 0.3),
    );

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
    cancelToken?.throwIfCancelled?.();
    progress("phase2", "Fetching safety data in route corridor…", 50);
    debugLog(
      `[safe-routes] 📐 Phase 2: Corridor from ${corridorPoints.length} waypoints + ${corridorBufferM}m buffer`,
    );

    // ── Fetch ALL safety data within the corridor ───────────────────────
    debugLog(
      `[safe-routes] 📡 Fetching safety data in corridor (Overpass + Crime)...`,
    );
    const t0 = Date.now();

    const dataSources = {
      localOsm: null,
      overpass: null,
      crime: null,
    };
    let allData;
    let crimes;
    try {
      [allData, crimes] = await Promise.all([
        fetchLocalOsmSafetyData(bbox, {
          signal: upstreamAbortController.signal,
          routeKey: `${oLatV},${oLngV}->${dLatV},${dLngV}`,
          onSourceMeta: (meta) => {
            dataSources.localOsm = meta;
          },
        }),
        fetchCrimesInBbox(bbox, {
          signal: upstreamAbortController.signal,
          onSourceMeta: (meta) => {
            dataSources.crime = meta;
          },
        }),
      ]);
      if (allData._sourceMeta) {
        recordSourceDecision(allData._sourceMeta.roads?.source || 'osm');
      }
    } catch (err) {
      // Re-throw cap exceeded errors — they should not fall back
      if (err.code === 'OS_CAP_EXCEEDED' || err.name === 'OsCapExceededError') {
        throw err;
      }
      // Local OSM failed — fallback to Overpass
      console.warn(`[safe-routes] Local OSM safety data failed, falling back to Overpass: ${err.message}`);
      [allData, crimes] = await Promise.all([
        fetchAllSafetyData(bbox, {
          signal: upstreamAbortController.signal,
          level: safetyLevel,
          onSourceMeta: (meta) => {
            dataSources.overpass = meta;
          },
        }),
        fetchCrimesInBbox(bbox, {
          signal: upstreamAbortController.signal,
          onSourceMeta: (meta) => {
            dataSources.crime = meta;
          },
        }),
      ]);
      allData._sourceMeta = {
        lights: { source: 'osm', reason: 'local-osm-failed-overpass-fallback' },
      };
      recordSourceDecision('osm_fallback');
    }

    // Standard level skips CCTV, places and transit. The local OSM path doesn't
    // take a level, so strip here too.
    if (safetyLevel === SAFETY_LEVEL_STANDARD) {
      allData = {
        ...allData,
        cctv: { elements: [] },
        places: { elements: [] },
        transit: { elements: [] },
      };
    }

    let dataTime = Date.now() - t0;
    cancelToken?.throwIfCancelled?.();
    progress("phase2_done", "Safety data loaded.", 66);
    debugLog(`[safe-routes] 📡 Corridor data fetched in ${dataTime}ms`);

    let roadCount = allData.roads.elements.filter(
      (e) => e.type === "way",
    ).length;
    let nodeCount = allData.roads.elements.filter(
      (e) => e.type === "node",
    ).length;
    debugLog(
      `[safe-routes] 📊 Data: ${roadCount} roads, ${nodeCount} nodes, ${crimes.length} crimes, ${allData.lights.elements.length} lights, ${allData.cctv.elements.length} CCTV`,
    );

    // ── 6b. Extract light & place node positions for POI markers ────────
    // ── 7. Build safety-weighted graph (with coverage maps) ─────────────
    const computeGraphAndCandidates = async (dataset) => {
      debugLog(`[safe-routes] 🏗️  Building graph + coverage maps...`);
      cancelToken?.throwIfCancelled?.();
      progress("graph_build", "Building safety graph…", 74);
      const t1 = Date.now();
      const graph = await buildGraph(
        dataset.roads,
        dataset.lights,
        dataset.cctv,
        dataset.places,
        dataset.transit,
        crimes,
        bbox,
        {
          shouldCancel: () => cancelToken?.isCancelled?.() === true,
          hour: departureHour,
          level: safetyLevel,
          lightsCacheByEdgeIdx: dataset.lightsCacheByEdgeIdx || null,
        },
      );
      const graphTime = Date.now() - t1;
      cancelToken?.throwIfCancelled?.();
      progress("graph_ready", "Running safest path search…", 82);
      debugLog(
        `[safe-routes] 📊 Graph: ${graph.osmNodes.size} nodes, ${graph.edges.length} edges (built in ${graphTime}ms)`,
      );

      if (graph.edges.length === 0) {
        throw Object.assign(
          new Error(
            "We found roads in this area but none of them are walkable (they may all be motorways or private roads). Try a destination in a more pedestrian-friendly area.",
          ),
          { statusCode: 404, code: "NO_WALKING_NETWORK", roadCount },
        );
      }

      const startNode = findNearestNode(graph.nodeGrid, graph.adjacency, oLatV, oLngV);
      const endNode = findNearestNode(graph.nodeGrid, graph.adjacency, dLatV, dLngV);

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

      debugLog(
        `[safe-routes] 🔎 A* pathfinding (start=${startNode}, end=${endNode})...`,
      );
      cancelToken?.throwIfCancelled?.();
      progress("pathfind", "Computing route candidates…", 86);
      const t2 = Date.now();
      const maxRouteDist = straightLineDist * 2.5;
      const rawRoutes = findRouteCandidates({
        wpLat,
        wpLng,
        nodeGrid: graph.nodeGrid,
        adjacency: graph.adjacency,
        startNode,
        endNode,
        osmNodes: graph.osmNodes,
        edges: graph.edges,
        maxRouteDist,
        findNearestNode,
        findKSafestRoutes,
        logger: debugLogger,
        allowHazards,
        edgeConfidences: graph.edgeConfidences,
      });

      const pathfindTime = Date.now() - t2;
      cancelToken?.throwIfCancelled?.();
      progress("pathfind_done", "Scoring and formatting route options…", 89);
      debugLog(
        `[safe-routes] 🔎 A* found ${rawRoutes.length} routes in ${pathfindTime}ms`,
      );

      return {
        ...graph,
        rawRoutes,
        graphTime,
        pathfindTime,
      };
    };

    let {
      osmNodes,
      edges,
      adjacency,
      nodeGrid,
      weights,
      cctvNodes,
      transitNodes,
      nodeDegree,
      rawRoutes,
      graphTime,
      pathfindTime,
    } = await computeGraphAndCandidates(allData);

    // ── Light confidence scoring & OS NGD gap verification ──────────────
    let edgeConfidences = [];
    let verifiedLights = [];
    let verificationFootprints = [];
    let lightVerificationStatus = 'not_needed';

    if (rawRoutes.length > 0) {
      const computeEdgeConfidencesForCurrentGraph = () => {
        const lightNodes = [];
        for (const el of allData.lights.elements) {
          if (el.type === 'node' && el.lat && el.lon) {
            lightNodes.push({ lat: el.lat, lng: el.lon });
          }
        }
        const lightGrid = buildSpatialGrid(lightNodes, 'lat', 'lng', 0.0003); // ~33m cells

        return edges.map((edge) => {
          const nA = osmNodes.get(edge.from);
          const nB = osmNodes.get(edge.to);
          if (!nA || !nB) return { score: 0, reason: 'missing_nodes', needsVerification: false };
          return computeSampledLightConfidence(
            { tags: { highway: edge.highway, lit: edge.litTag || undefined } },
            edge,
            osmNodes,
            lightGrid,
            [], // adjacent ways would need graph traversal; skip for now
            { searchRadiusMetres: 50, sampleFractions: [0.25, 0.5, 0.75] },
          );
        });
      };

      const shouldVerifyEdge = (conf) => {
        if (!conf) return false;
        if (conf.needsVerification) return true;
        if (conf.reason === 'explicit_lit_no') return true;
        return Number.isFinite(conf.score) && conf.score <= CONFIDENCE_THRESHOLDS.UNLIT;
      };

      edgeConfidences = computeEdgeConfidencesForCurrentGraph();

      // Check all candidate routes for uncertain or explicitly dark segments.
      const verificationCandidates = new Map();
      let explicitDarkRouteCount = 0;
      let inferredDarkRouteCount = 0;
      for (const route of rawRoutes) {
        const uncertainty = calculateRouteUncertainty(route.edges, edges, edgeConfidences);
        const lightGapSpans = buildRouteLightGapSpans(route, edges, osmNodes, edgeConfidences, {
          lowThreshold: 0.58,
          continueThreshold: 0.72,
          minSpanDistance: 90,
        });
        const hasExplicitDarkSegment = route.edges.some(
          (edgeIdx) => edgeConfidences[edgeIdx]?.reason === 'explicit_lit_no',
        );
        const hasInferredDarkSegment = route.edges.some((edgeIdx) => {
          const conf = edgeConfidences[edgeIdx];
          return conf && conf.reason !== 'explicit_lit_no' && Number.isFinite(conf.score) && conf.score <= CONFIDENCE_THRESHOLDS.UNLIT;
        });
        if (hasExplicitDarkSegment) {
          explicitDarkRouteCount += 1;
        }
        if (hasInferredDarkSegment) {
          inferredDarkRouteCount += 1;
        }
        if (lightGapSpans.length > 0) {
          for (const span of lightGapSpans) {
            const key = `span:${span.edgeIdxs[0]}:${span.edgeIdxs[span.edgeIdxs.length - 1]}`;
            if (!verificationCandidates.has(key)) {
              verificationCandidates.set(key, {
                edgeIdx: span.edgeIdx,
                edge: edges[span.edgeIdx],
                edgeIdxs: span.edgeIdxs,
                bbox: span.bbox,
                confidence: span.confidence,
                reason: span.reason,
                routeKey: `${oLatV},${oLngV}->${dLatV},${dLngV}`,
                spanDistance: span.distance,
              });
            }
          }
        } else if (uncertainty.uncertainRatio > 0.15 || hasExplicitDarkSegment || hasInferredDarkSegment) {
          for (const eIdx of route.edges) {
            if (shouldVerifyEdge(edgeConfidences[eIdx])) {
              const key = `edge:${eIdx}`;
              if (!verificationCandidates.has(key)) {
                verificationCandidates.set(key, {
                  edgeIdx: eIdx,
                  edge: edges[eIdx],
                  confidence: edgeConfidences[eIdx]?.score ?? 0,
                  reason: edgeConfidences[eIdx]?.reason || 'unknown',
                  routeKey: `${oLatV},${oLngV}->${dLatV},${dLngV}`,
                });
              }
            }
          }
        }
      }

      const candidateVerifyCount = edgeConfidences.reduce(
        (count, conf) => count + (shouldVerifyEdge(conf) ? 1 : 0),
        0,
      );
      debugLog(
        `[safe-routes] 💡 Light verification gate: routes=${rawRoutes.length}, explicitDarkRoutes=${explicitDarkRouteCount}, inferredDarkRoutes=${inferredDarkRouteCount}, candidateEdges=${candidateVerifyCount}, routedCandidates=${verificationCandidates.size}`,
      );

      if (verificationCandidates.size > 0) {
        lightVerificationStatus = 'in_progress';
        progress("light_verify", "Verifying street lighting data…", 90);

        const uncertainSegments = [...verificationCandidates.values()]
          .filter((seg) => !!seg.edge);

        debugLog(
          `[safe-routes] 💡 Verifying ${uncertainSegments.length} candidate light segments via OS NGD...`,
        );

        recordLightVerification(uncertainSegments.length, 0);

        try {
          const verification = await verifyLightGaps(
            uncertainSegments,
            osmNodes,
            { signal: upstreamAbortController.signal, routeKey: `${oLatV},${oLngV}->${dLatV},${dLngV}` },
          );

          verifiedLights = verification.verifiedLights;
          verificationFootprints = verification.queryFootprints || [];
          const verifiedDarkCacheByEdgeIdx = new Map();
          for (const [edgeIdx, verified] of verification.verifiedSegments.entries()) {
            if (verified?.lit_status !== 'unlit') continue;
            if (!edges[edgeIdx]) continue;
            verifiedDarkCacheByEdgeIdx.set(edgeIdx, {
              source: 'os_ngd',
              lit_status: 'unlit',
              confidence: typeof verified.confidence === 'number' ? verified.confidence : 0.9,
              confidence_reason: verified.reason || 'no_lights_in_os_ngd',
            });
          }

          debugLog(
            `[safe-routes] 💡 OS NGD verification results: verifiedLights=${verifiedLights.length}, verifiedDarkEdges=${verifiedDarkCacheByEdgeIdx.size}`,
          );
          if (verification?.stats) {
            debugLog(
              `[safe-routes] 💡 OS NGD verification stats: memHits=${verification.stats.memoryCacheHits}, persistentHits=${verification.stats.persistentCacheHits}, persisted=${verification.stats.persistedDecisions}, cells=${verification.stats.totalCellsBeforeDedup || 0}->${verification.stats.totalCellsAfterDedup || 0}, queriedCells=${verification.stats.queriedClusters}, skippedByBudget=${verification.stats.skippedClustersBudget}`,
            );
          }

          if (verifiedLights.length > 0 || verifiedDarkCacheByEdgeIdx.size > 0) {
            recordOsNgdGapFill();
          }

          if (verifiedLights.length > 0 || verifiedDarkCacheByEdgeIdx.size > 0) {
            allData.lights.elements = mergeVerifiedLights(
              allData.lights.elements,
              verifiedLights,
            );
            // Rebuild graph with verified lights and confirmed-dark cache entries.
            ({
              osmNodes, edges, adjacency, nodeGrid, weights,
              cctvNodes, transitNodes, nodeDegree,
            } = await computeGraphAndCandidates({
              ...allData,
              lightsCacheByEdgeIdx: verifiedDarkCacheByEdgeIdx,
            }));
            // Re-run pathfinding
            const maxRouteDist = straightLineDist * 2.5;
            rawRoutes = findRouteCandidates({
              wpLat, wpLng,
              nodeGrid, adjacency,
              startNode: findNearestNode(nodeGrid, adjacency, oLatV, oLngV),
              endNode: findNearestNode(nodeGrid, adjacency, dLatV, dLngV),
              osmNodes, edges,
              maxRouteDist,
              findNearestNode,
              findKSafestRoutes,
              logger: debugLogger,
              allowHazards,
              edgeConfidences,
            });
            edgeConfidences = computeEdgeConfidencesForCurrentGraph();
            lightVerificationStatus = 'verified';
          } else {
            lightVerificationStatus = 'no_gaps_found';
            debugLog('[safe-routes] 💡 OS NGD returned no new verified lighting changes');
          }
        } catch (verifyErr) {
          if (verifyErr?.code === 'SEARCH_CANCELLED') {
            debugLog(`[safe-routes] 💡 Light verification cancelled: ${verifyErr.message}`);
          } else {
            console.warn(`[safe-routes] Light verification failed: ${verifyErr.message}`);
          }
          lightVerificationStatus = 'failed';
        }
      } else {
        debugLog('[safe-routes] 💡 Light verification skipped: no route edges met the uncertainty threshold');
      }
    }

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

    const responseRoutes = buildRouteResponses({
      rawRoutes,
      osmNodes,
      edges,
      weights,
      cctvNodes,
      transitNodes,
      nodeDegree,
      crimes,
      allData,
      oLat: oLatV,
      oLng: oLngV,
      dLat: dLatV,
      dLng: dLngV,
      enableOpeningHoursParse: ENABLE_RESPONSE_OPENING_HOURS_PARSE,
      responsePolicy,
      edgeConfidences,
      straightLineDist,
      verificationFootprints,
    });

    const routeSegmentDebug = rawRoutes.map((route, idx) => {
      let uncertainSegments = 0;
      let explicitDarkSegments = 0;
      for (const edgeIdx of route.edges) {
        const conf = edgeConfidences?.[edgeIdx];
        if (conf?.needsVerification) uncertainSegments += 1;
        if (conf?.reason === 'explicit_lit_no') explicitDarkSegments += 1;
      }
      return {
        routeIndex: idx,
        segments: route.edges.length,
        explicitDarkSegments,
        uncertainSegments,
      };
    });
    console.log(
      `[safe-routes] 📐 Path segments: ${routeSegmentDebug
        .map((r) => `r${r.routeIndex}=segments:${r.segments},dark:${r.explicitDarkSegments},uncertain:${r.uncertainSegments}`)
        .join(' | ')}`,
    );

    const elapsed = Date.now() - startTime;
    recordRouteLatency(elapsed);
    cancelToken?.throwIfCancelled?.();
    progress("finalize", "Finalizing route output…", 90);
    debugLog(
      `[safe-routes] 🏁 Done in ${elapsed}ms (corridor:${phase1Time}ms, data:${dataTime}ms, graph:${graphTime}ms, A*:${pathfindTime}ms, recorrection:${recorrectionMs}ms) — ${responseRoutes.length} routes, safest: ${responseRoutes[0]?.safety?.score}`,
    );

    return {
      status: "OK",
      routes: responseRoutes,
      meta: buildSafeRoutesMeta({
        straightLineKm,
        maxDistanceKm,
        responseRoutes,
        roadCount,
        crimes,
        allData,
        elapsed,
        phase1Time,
        dataTime,
        graphTime,
        pathfindTime,
        recorrectionMs,
        dataSources,
        lightVerificationStatus,
        verifiedLightsCount: verifiedLights.length,
      }),
    };
  } finally {
    if (typeof cancelUnsub === "function") cancelUnsub();
  }
}

module.exports = router;
```I resolved the `safeRoutes.js` conflicts by keeping `main`'s modular structure and adding `safety_level` on top, as you chose. Nothing is committed. The file is on disk at `backend/src/safety/routes/safeRoutes.js`, and your uncommitted `_sourceMeta` change is preserved.

**Decisions I made:**
- **Incoming branch:** I matched the conflict to `upstream/feature/safety-level-toggle-rebased`. A three-way merge against it reproduces the same 10 conflicts as your paste.
- **Overpass mirror logic:** I kept `main`'s version and did not port the incoming cooldown/mirror rework. Porting it would change routing behaviour beyond this conflict, so please check whether you want it.
- **Standard level:** It drops CCTV, places and transit, and rescales the scoring weights, as the incoming branch does. I also strip those categories after the fetch, because the local-OSM path doesn't take a level.
- **New module:** `services/safetyLevels.js` holds the level constants. An existing integration test mocks `overpassClient` without them, and that made every request return 400.

**Other files changed:** `routes/safeRoutesOrchestrator.js` (level in the cache key and passed through), `services/overpassClient.js` (level option, standard query, split-fallback handling), `services/safetyGraph.js` (level-aware weights), and the new `services/safetyLevels.js`.

**Verification:** `node --check` passes on all changed files and there are no conflict markers. `jest tests/unit/safety tests/integration/safety` passes: 30 suites, 177 tests. I did not run the app or hit the live Overpass API.

```javascript
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
const {
  haversine,
  bboxFromPoints,
  buildSpatialGrid,
} = require("../services/geo");
const { fetchAllSafetyData } = require("../services/overpassClient");
const {
  SAFETY_LEVEL_STANDARD,
  SAFETY_LEVEL_EXTRA,
} = require("../services/safetyLevels");
const { fetchCrimesInBbox } = require("../services/crimeClient");
const {
  fetchRoadNetwork: fetchLocalOsmRoadNetwork,
  fetchSafetyData: fetchLocalOsmSafetyData,
} = require("../services/sourceFusionEngine");
const {
  recordRouteLatency,
  recordSourceDecision,
  recordLightVerification,
  recordOsNgdGapFill,
} = require("../services/osMetrics");
const {
  createCancellationToken,
  logSearchCancellation,
  registerActiveSearch,
  estimateRequestLoadUnits,
  enqueueComputeJob,
  waitWithCancellation,
  formatWaitMmSs,
} = require("./safeRoutesRuntime");
const {
  createSafeRoutesOrchestrator,
} = require("./safeRoutesOrchestrator");
const {
  parseRouteRequest,
  buildOutOfRangeMessage,
  buildOutOfRangePayload,
} = require("./safeRoutesRequestPolicy");
const { buildRouteResponses } = require("./safeRoutesResponseFormatter");
const { buildSafeRoutesMeta } = require("./safeRoutesMetaBuilder");
const { findRouteCandidates } = require("./safeRoutesCandidateFinder");
const {
  buildGraph,
  buildDistanceOnlyGraph,
  aStarDistance,
  findNearestNode,
  findKSafestRoutes,
} = require("../services/safetyGraph");
const {
  computeSampledLightConfidence,
  mergeVerifiedLights,
  calculateRouteUncertainty,
  buildRouteLightGapSpans,
  CONFIDENCE_THRESHOLDS,
} = require("../services/lightConfidenceEngine");
const { verifyLightGaps } = require("../services/osNgdMicroQuery");

const router = express.Router();

// Default fallback — can be overridden per request via ?max_distance query param
// (the gateway / user-service resolves the caller's tier → distance limit)
const DEFAULT_MAX_DISTANCE_KM = 20;
const ENABLE_RESPONSE_OPENING_HOURS_PARSE =
  process.env.SAFE_ROUTES_PARSE_RESPONSE_OPENING_HOURS === "1";
const DEBUG_SAFE_ROUTES = process.env.SAFE_ROUTES_DEBUG === "1";
const debugLog = DEBUG_SAFE_ROUTES ? (...args) => console.log(...args) : () => {};
const debugLogger = DEBUG_SAFE_ROUTES
  ? console
  : { log: () => {}, warn: () => {}, error: () => {} };

// Missing → "extra" (unchanged default). Anything other than the two levels → null.
function parseSafetyLevel(value) {
  if (value == null || value === "") return SAFETY_LEVEL_EXTRA;
  return value === SAFETY_LEVEL_STANDARD || value === SAFETY_LEVEL_EXTRA
    ? value
    : null;
}

function isServerBusyError(err) {
  if (!err) return false;
  if (err.statusCode === 503 || err.isServerBusy || err.code === "UPSTREAM_UNAVAILABLE") {
    return true;
  }

  const msg = String(err.message || "");
  return (
    /Overpass .* returned (403|429|5\d\d)/i.test(msg) ||
    /Overpass .* timed out/i.test(msg) ||
    /All Overpass servers failed/i.test(msg)
  );
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const { resolveSafeRoutesRequest, hasInflightRequest } = createSafeRoutesOrchestrator({
  computeSafeRoutes,
  estimateRequestLoadUnits,
  enqueueComputeJob,
  waitWithCancellation,
  formatWaitMmSs,
  cacheTtlMs: CACHE_TTL_MS,
});

// ── GET /api/safe-routes ────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const cancelToken = createCancellationToken();
  const activeSearch = registerActiveSearch(req, cancelToken);
  let requestSettled = false;
  const sendJson = (statusCode, payload) => {
    requestSettled = true;
    return res.status(statusCode).json(payload);
  };
  if (activeSearch.stale) {
    logSearchCancellation("http_stale_response", {
      userKey: activeSearch.userKey,
      searchId: activeSearch.searchId,
      searchSeq: activeSearch.searchSeq,
    });
    return sendJson(409, {
      error: "SEARCH_CANCELLED",
      message:
        "This route search is older than another active search on your account.",
    });
  }
  req.on("close", () => {
    if (requestSettled) return;
    logSearchCancellation("http_client_disconnected", {
      userKey: activeSearch.userKey,
      searchId: activeSearch.searchId,
      searchSeq: activeSearch.searchSeq,
    });
    cancelToken.cancel(
      "Route search was cancelled because the client disconnected.",
    );
  });

  try {
    const parsedRequest = parseRouteRequest(
      req,
      DEFAULT_MAX_DISTANCE_KM,
      haversine,
    );
    if (!parsedRequest.ok) {
      return sendJson(400, { error: parsedRequest.error });
    }

    // ── Optional safety level: "extra" (default) or "standard" (faster) ──
    const safetyLevel = parseSafetyLevel(req.query.safety_level);
    if (!safetyLevel) {
      return sendJson(400, {
        error: "INVALID_SAFETY_LEVEL",
        message: "safety_level must be 'standard' or 'extra'.",
      });
    }

    const {
      oLat,
      oLng,
      dLat,
      dLng,
      wpLat,
      wpLng,
      straightLineDist,
      straightLineKm,
      maxDistanceKm,
      departureHour,
      allowHazards,
      responsePolicy,
    } = parsedRequest.value;

    if (straightLineKm > maxDistanceKm) {
      return sendJson(
        400,
        buildOutOfRangePayload({
          oLat,
          oLng,
          dLat,
          dLng,
          straightLineKm,
          maxDistanceKm,
        }),
      );
    }

    const { result } = await resolveSafeRoutesRequest({
      oLat,
      oLng,
      dLat,
      dLng,
      straightLineDist,
      straightLineKm,
      maxDistanceKm,
      wpLat,
      wpLng,
      departureHour,
      allowHazards,
      responsePolicy,
      cancelToken,
      safetyLevel,
    });

    requestSettled = true;
    res.json(result);
  } catch (err) {
    if (err?.code === "SEARCH_CANCELLED") {
      logSearchCancellation("http_cancelled_response", {
        userKey: activeSearch.userKey,
        searchId: activeSearch.searchId,
        searchSeq: activeSearch.searchSeq,
        reason: err.message,
      });
      if (!res.headersSent) {
        return sendJson(409, {
          error: "SEARCH_CANCELLED",
          message: err.message,
        });
      }
      return;
    }

    if (err.code === 'OS_CAP_EXCEEDED' || err.name === 'OsCapExceededError') {
      console.error(`[safe-routes] 🚫 OS cap exceeded — returning maintenance message`);
      if (!res.headersSent) {
        return sendJson(503, {
          error: "SERVICE_UNAVAILABLE",
          message: err.message,
        });
      }
      return;
    }

    if (isServerBusyError(err)) {
      console.warn(`[safe-routes] ⚠️ Server busy / upstream unavailable:`, err?.message || err);
      if (!res.headersSent) {
        return sendJson(503, {
          error: "SERVER_BUSY",
          message: "Our routing providers are temporarily busy. Please retry in a moment.",
          detail:
            "This is usually temporary (mapping or crime data provider overload). Please try again shortly.",
        });
      }
      return;
    }

    console.error(`[safe-routes] ❌ Error:`, err);
    if (!res.headersSent) {
      sendJson(500, {
        error: "INTERNAL_ERROR",
        message: "Something went wrong on our end while computing your route.",
        detail:
          "This is usually a temporary issue with one of our data sources (OpenStreetMap or the Police crime API). Please wait a moment and try again.",
      });
    }
  } finally {
    activeSearch.release();
  }
});

// ── GET /api/safe-routes/stream (SSE progress, low-overhead) ──────────────
router.get("/stream", async (req, res) => {
  let closed = false;
  let keepAliveTimer = null;
  const cancelToken = createCancellationToken();
  const activeSearch = registerActiveSearch(req, cancelToken);

  if (activeSearch.stale) {
    logSearchCancellation("sse_stale_response", {
      userKey: activeSearch.userKey,
      searchId: activeSearch.searchId,
      searchSeq: activeSearch.searchSeq,
    });
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    res.write("event: error\n");
    res.write(
      `data: ${JSON.stringify({ code: "SEARCH_CANCELLED", message: "This route search is older than another active search on your account.", pct: 0 })}\n\n`,
    );
    return res.end();
  }

  const cleanup = () => {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  };

  req.on("close", () => {
    closed = true;
    logSearchCancellation("sse_client_disconnected", {
      userKey: activeSearch.userKey,
      searchId: activeSearch.searchId,
      searchSeq: activeSearch.searchSeq,
    });
    cancelToken.cancel(
      "Route search was cancelled because the client disconnected.",
    );
    activeSearch.release();
    cleanup();
  });

  cancelToken.onCancel((reason) => {
    if (closed) return;
    logSearchCancellation("sse_cancel_signal", {
      userKey: activeSearch.userKey,
      searchId: activeSearch.searchId,
      searchSeq: activeSearch.searchSeq,
      reason,
    });
    send("error", { code: "SEARCH_CANCELLED", message: reason, pct: 0 });
    closed = true;
    cleanup();
    try {
      res.end();
    } catch {
      // ignore
    }
    activeSearch.release();
  });

  const send = (event, data) => {
    if (closed) return;
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Client disconnected
    }
  };

  try {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    keepAliveTimer = setInterval(() => {
      if (closed) return;
      try {
        res.write(": keepalive\n\n");
      } catch {
        // ignore write failures
      }
    }, 15000);

    send("phase", {
      phase: "init",
      message: "Starting route analysis…",
      pct: 20,
    });

    const parsedRequest = parseRouteRequest(
      req,
      DEFAULT_MAX_DISTANCE_KM,
      haversine,
    );
    if (!parsedRequest.ok) {
      send("error", { message: parsedRequest.error, pct: 0 });
      return res.end();
    }

    const safetyLevel = parseSafetyLevel(req.query.safety_level);
    if (!safetyLevel) {
      send("error", {
        error: "INVALID_SAFETY_LEVEL",
        message: "safety_level must be 'standard' or 'extra'.",
        pct: 0,
      });
      return res.end();
    }

    const {
      oLat,
      oLng,
      dLat,
      dLng,
      wpLat,
      wpLng,
      straightLineDist,
      straightLineKm,
      maxDistanceKm,
      responsePolicy,
    } = parsedRequest.value;

    if (straightLineKm > maxDistanceKm) {
      send("error", {
        message: buildOutOfRangeMessage(straightLineKm, maxDistanceKm),
        pct: 0,
      });
      return res.end();
    }

    if (
      hasInflightRequest({
        oLat,
        oLng,
        dLat,
        dLng,
        wpLat,
        wpLng,
        responsePolicy,
        safetyLevel,
      })
    ) {
      send("phase", {
        phase: "coalesced",
        message: "Joining active route computation…",
        pct: 20,
      });
    }

    const onProgress = (phase, message, pct) => {
      send("phase", { phase, message, pct });
    };

    const { source } = await resolveSafeRoutesRequest({
      oLat,
      oLng,
      dLat,
      dLng,
      straightLineDist,
      straightLineKm,
      maxDistanceKm,
      wpLat,
      wpLng,
      responsePolicy,
      onProgress,
      cancelToken,
      safetyLevel,
    });

    if (source === "cache") {
      send("phase", {
        phase: "cache_hit",
        message: "Using cached route analysis…",
        pct: 96,
      });
    }

    send("done", { pct: 100, message: "Routes ready!" });
    cleanup();
    activeSearch.release();
    res.end();
  } catch (err) {
    if (err?.code === "SEARCH_CANCELLED") {
      logSearchCancellation("sse_cancelled_response", {
        userKey: activeSearch.userKey,
        searchId: activeSearch.searchId,
        searchSeq: activeSearch.searchSeq,
        reason: err.message,
      });
      send("error", { code: "SEARCH_CANCELLED", message: err.message, pct: 0 });
      cleanup();
      activeSearch.release();
      return res.end();
    }

    if (isServerBusyError(err)) {
      send("error", {
        code: "SERVER_BUSY",
        message: "Our routing providers are temporarily busy. Please retry in a moment.",
        pct: 0,
      });
      cleanup();
      activeSearch.release();
      return res.end();
    }

    send("error", {
      message:
        err?.message || "Something went wrong while streaming route progress.",
      pct: 0,
    });
    cleanup();
    activeSearch.release();
    res.end();
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
  departureHour = null,
  allowHazards = false,
  cancelToken = null,
  onProgress = null,
  responsePolicy = null,
  safetyLevel = SAFETY_LEVEL_EXTRA,
) {
  cancelToken?.throwIfCancelled?.();
  const upstreamAbortController = new AbortController();
  const cancelUnsub = cancelToken?.onCancel?.(() => {
    try {
      upstreamAbortController.abort();
    } catch {
      // ignore abort errors
    }
  });

  const progress = (phase, message, pct) => {
    if (typeof onProgress !== "function") return;
    if (cancelToken?.isCancelled?.()) return;
    try {
      onProgress(phase, message, pct);
    } catch {
      // no-op: progress is best-effort
    }
  };

  progress("start", "Preparing route analysis…", 20);
  debugLog(
    `[safe-routes] 🔍 Computing: ${oLatV},${oLngV} → ${dLatV},${dLngV} (${straightLineKm.toFixed(1)} km)`,
  );

  try {
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
      cancelToken?.throwIfCancelled?.();
      progress("phase1", "Discovering walking corridor…", 28);
      debugLog(`[safe-routes] 🛤️  Phase 1: Discovering walking corridor...`);
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

      try {
        const roadData = await fetchLocalOsmRoadNetwork(initialBbox, {
          signal: upstreamAbortController.signal,
          routeKey: `${oLatV},${oLngV}->${dLatV},${dLngV}`,
        });
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
      } catch (err) {
        if (err?.code === "SEARCH_CANCELLED") throw err;
        if (isServerBusyError(err)) {
          console.warn(
            `[safe-routes] ⚠️ Phase 1 degraded (${String(err?.message || err).slice(0, 180)}). Continuing with straight-line corridor.`,
          );
          shortestPath = null;
          distGraph = null;
          progress("phase1_degraded", "Skipping corridor discovery due to upstream delay…", 36);
        } else {
          throw err;
        }
      }
      phase1Time = Date.now() - t0p1;
      cancelToken?.throwIfCancelled?.();
      progress("phase1_done", "Walking corridor discovered.", 38);
      debugLog(
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
      progress(
        "phase1_skipped",
        "Skipping corridor discovery for short route.",
        34,
      );
      debugLog(
        `[safe-routes] ⏩ Phase 1: skipped (${Math.round(straightLineDist)}m < ${SKIP_PHASE1_DIST}m)`,
      );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 2 — Build corridor bbox + fetch safety data
    // Smaller buffers to reduce data volume and processing time.
    // ═══════════════════════════════════════════════════════════════════════
    const corridorBufferM = Math.max(
      700,
      Math.min(1000, straightLineDist * 0.3),
    );

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
    cancelToken?.throwIfCancelled?.();
    progress("phase2", "Fetching safety data in route corridor…", 50);
    debugLog(
      `[safe-routes] 📐 Phase 2: Corridor from ${corridorPoints.length} waypoints + ${corridorBufferM}m buffer`,
    );

    // ── Fetch ALL safety data within the corridor ───────────────────────
    debugLog(
      `[safe-routes] 📡 Fetching safety data in corridor (Overpass + Crime)...`,
    );
    const t0 = Date.now();

    const dataSources = {
      localOsm: null,
      overpass: null,
      crime: null,
    };
    let allData;
    let crimes;
    try {
      [allData, crimes] = await Promise.all([
        fetchLocalOsmSafetyData(bbox, {
          signal: upstreamAbortController.signal,
          routeKey: `${oLatV},${oLngV}->${dLatV},${dLngV}`,
          onSourceMeta: (meta) => {
            dataSources.localOsm = meta;
          },
        }),
        fetchCrimesInBbox(bbox, {
          signal: upstreamAbortController.signal,
          onSourceMeta: (meta) => {
            dataSources.crime = meta;
          },
        }),
      ]);
      if (allData._sourceMeta) {
        recordSourceDecision(allData._sourceMeta.roads?.source || 'osm');
      }
    } catch (err) {
      // Re-throw cap exceeded errors — they should not fall back
      if (err.code === 'OS_CAP_EXCEEDED' || err.name === 'OsCapExceededError') {
        throw err;
      }
      // Local OSM failed — fallback to Overpass
      console.warn(`[safe-routes] Local OSM safety data failed, falling back to Overpass: ${err.message}`);
      [allData, crimes] = await Promise.all([
        fetchAllSafetyData(bbox, {
          signal: upstreamAbortController.signal,
          level: safetyLevel,
          onSourceMeta: (meta) => {
            dataSources.overpass = meta;
          },
        }),
        fetchCrimesInBbox(bbox, {
          signal: upstreamAbortController.signal,
          onSourceMeta: (meta) => {
            dataSources.crime = meta;
          },
        }),
      ]);
      allData._sourceMeta = {
        lights: { source: 'osm', reason: 'local-osm-failed-overpass-fallback' },
      };
      recordSourceDecision('osm_fallback');
    }

    // Standard level skips CCTV, places and transit. The local OSM path doesn't
    // take a level, so strip here too.
    if (safetyLevel === SAFETY_LEVEL_STANDARD) {
      allData = {
        ...allData,
        cctv: { elements: [] },
        places: { elements: [] },
        transit: { elements: [] },
      };
    }

    let dataTime = Date.now() - t0;
    cancelToken?.throwIfCancelled?.();
    progress("phase2_done", "Safety data loaded.", 66);
    debugLog(`[safe-routes] 📡 Corridor data fetched in ${dataTime}ms`);

    let roadCount = allData.roads.elements.filter(
      (e) => e.type === "way",
    ).length;
    let nodeCount = allData.roads.elements.filter(
      (e) => e.type === "node",
    ).length;
    debugLog(
      `[safe-routes] 📊 Data: ${roadCount} roads, ${nodeCount} nodes, ${crimes.length} crimes, ${allData.lights.elements.length} lights, ${allData.cctv.elements.length} CCTV`,
    );

    // ── 6b. Extract light & place node positions for POI markers ────────
    // ── 7. Build safety-weighted graph (with coverage maps) ─────────────
    const computeGraphAndCandidates = async (dataset) => {
      debugLog(`[safe-routes] 🏗️  Building graph + coverage maps...`);
      cancelToken?.throwIfCancelled?.();
      progress("graph_build", "Building safety graph…", 74);
      const t1 = Date.now();
      const graph = await buildGraph(
        dataset.roads,
        dataset.lights,
        dataset.cctv,
        dataset.places,
        dataset.transit,
        crimes,
        bbox,
        {
          shouldCancel: () => cancelToken?.isCancelled?.() === true,
          hour: departureHour,
          level: safetyLevel,
          lightsCacheByEdgeIdx: dataset.lightsCacheByEdgeIdx || null,
        },
      );
      const graphTime = Date.now() - t1;
      cancelToken?.throwIfCancelled?.();
      progress("graph_ready", "Running safest path search…", 82);
      debugLog(
        `[safe-routes] 📊 Graph: ${graph.osmNodes.size} nodes, ${graph.edges.length} edges (built in ${graphTime}ms)`,
      );

      if (graph.edges.length === 0) {
        throw Object.assign(
          new Error(
            "We found roads in this area but none of them are walkable (they may all be motorways or private roads). Try a destination in a more pedestrian-friendly area.",
          ),
          { statusCode: 404, code: "NO_WALKING_NETWORK", roadCount },
        );
      }

      const startNode = findNearestNode(graph.nodeGrid, graph.adjacency, oLatV, oLngV);
      const endNode = findNearestNode(graph.nodeGrid, graph.adjacency, dLatV, dLngV);

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

      debugLog(
        `[safe-routes] 🔎 A* pathfinding (start=${startNode}, end=${endNode})...`,
      );
      cancelToken?.throwIfCancelled?.();
      progress("pathfind", "Computing route candidates…", 86);
      const t2 = Date.now();
      const maxRouteDist = straightLineDist * 2.5;
      const rawRoutes = findRouteCandidates({
        wpLat,
        wpLng,
        nodeGrid: graph.nodeGrid,
        adjacency: graph.adjacency,
        startNode,
        endNode,
        osmNodes: graph.osmNodes,
        edges: graph.edges,
        maxRouteDist,
        findNearestNode,
        findKSafestRoutes,
        logger: debugLogger,
        allowHazards,
        edgeConfidences: graph.edgeConfidences,
      });

      const pathfindTime = Date.now() - t2;
      cancelToken?.throwIfCancelled?.();
      progress("pathfind_done", "Scoring and formatting route options…", 89);
      debugLog(
        `[safe-routes] 🔎 A* found ${rawRoutes.length} routes in ${pathfindTime}ms`,
      );

      return {
        ...graph,
        rawRoutes,
        graphTime,
        pathfindTime,
      };
    };

    let {
      osmNodes,
      edges,
      adjacency,
      nodeGrid,
      weights,
      cctvNodes,
      transitNodes,
      nodeDegree,
      rawRoutes,
      graphTime,
      pathfindTime,
    } = await computeGraphAndCandidates(allData);

    // ── Light confidence scoring & OS NGD gap verification ──────────────
    let edgeConfidences = [];
    let verifiedLights = [];
    let verificationFootprints = [];
    let lightVerificationStatus = 'not_needed';

    if (rawRoutes.length > 0) {
      const computeEdgeConfidencesForCurrentGraph = () => {
        const lightNodes = [];
        for (const el of allData.lights.elements) {
          if (el.type === 'node' && el.lat && el.lon) {
            lightNodes.push({ lat: el.lat, lng: el.lon });
          }
        }
        const lightGrid = buildSpatialGrid(lightNodes, 'lat', 'lng', 0.0003); // ~33m cells

        return edges.map((edge) => {
          const nA = osmNodes.get(edge.from);
          const nB = osmNodes.get(edge.to);
          if (!nA || !nB) return { score: 0, reason: 'missing_nodes', needsVerification: false };
          return computeSampledLightConfidence(
            { tags: { highway: edge.highway, lit: edge.litTag || undefined } },
            edge,
            osmNodes,
            lightGrid,
            [], // adjacent ways would need graph traversal; skip for now
            { searchRadiusMetres: 50, sampleFractions: [0.25, 0.5, 0.75] },
          );
        });
      };

      const shouldVerifyEdge = (conf) => {
        if (!conf) return false;
        if (conf.needsVerification) return true;
        if (conf.reason === 'explicit_lit_no') return true;
        return Number.isFinite(conf.score) && conf.score <= CONFIDENCE_THRESHOLDS.UNLIT;
      };

      edgeConfidences = computeEdgeConfidencesForCurrentGraph();

      // Check all candidate routes for uncertain or explicitly dark segments.
      const verificationCandidates = new Map();
      let explicitDarkRouteCount = 0;
      let inferredDarkRouteCount = 0;
      for (const route of rawRoutes) {
        const uncertainty = calculateRouteUncertainty(route.edges, edges, edgeConfidences);
        const lightGapSpans = buildRouteLightGapSpans(route, edges, osmNodes, edgeConfidences, {
          lowThreshold: 0.58,
          continueThreshold: 0.72,
          minSpanDistance: 90,
        });
        const hasExplicitDarkSegment = route.edges.some(
          (edgeIdx) => edgeConfidences[edgeIdx]?.reason === 'explicit_lit_no',
        );
        const hasInferredDarkSegment = route.edges.some((edgeIdx) => {
          const conf = edgeConfidences[edgeIdx];
          return conf && conf.reason !== 'explicit_lit_no' && Number.isFinite(conf.score) && conf.score <= CONFIDENCE_THRESHOLDS.UNLIT;
        });
        if (hasExplicitDarkSegment) {
          explicitDarkRouteCount += 1;
        }
        if (hasInferredDarkSegment) {
          inferredDarkRouteCount += 1;
        }
        if (lightGapSpans.length > 0) {
          for (const span of lightGapSpans) {
            const key = `span:${span.edgeIdxs[0]}:${span.edgeIdxs[span.edgeIdxs.length - 1]}`;
            if (!verificationCandidates.has(key)) {
              verificationCandidates.set(key, {
                edgeIdx: span.edgeIdx,
                edge: edges[span.edgeIdx],
                edgeIdxs: span.edgeIdxs,
                bbox: span.bbox,
                confidence: span.confidence,
                reason: span.reason,
                routeKey: `${oLatV},${oLngV}->${dLatV},${dLngV}`,
                spanDistance: span.distance,
              });
            }
          }
        } else if (uncertainty.uncertainRatio > 0.15 || hasExplicitDarkSegment || hasInferredDarkSegment) {
          for (const eIdx of route.edges) {
            if (shouldVerifyEdge(edgeConfidences[eIdx])) {
              const key = `edge:${eIdx}`;
              if (!verificationCandidates.has(key)) {
                verificationCandidates.set(key, {
                  edgeIdx: eIdx,
                  edge: edges[eIdx],
                  confidence: edgeConfidences[eIdx]?.score ?? 0,
                  reason: edgeConfidences[eIdx]?.reason || 'unknown',
                  routeKey: `${oLatV},${oLngV}->${dLatV},${dLngV}`,
                });
              }
            }
          }
        }
      }

      const candidateVerifyCount = edgeConfidences.reduce(
        (count, conf) => count + (shouldVerifyEdge(conf) ? 1 : 0),
        0,
      );
      debugLog(
        `[safe-routes] 💡 Light verification gate: routes=${rawRoutes.length}, explicitDarkRoutes=${explicitDarkRouteCount}, inferredDarkRoutes=${inferredDarkRouteCount}, candidateEdges=${candidateVerifyCount}, routedCandidates=${verificationCandidates.size}`,
      );

      if (verificationCandidates.size > 0) {
        lightVerificationStatus = 'in_progress';
        progress("light_verify", "Verifying street lighting data…", 90);

        const uncertainSegments = [...verificationCandidates.values()]
          .filter((seg) => !!seg.edge);

        debugLog(
          `[safe-routes] 💡 Verifying ${uncertainSegments.length} candidate light segments via OS NGD...`,
        );

        recordLightVerification(uncertainSegments.length, 0);

        try {
          const verification = await verifyLightGaps(
            uncertainSegments,
            osmNodes,
            { signal: upstreamAbortController.signal, routeKey: `${oLatV},${oLngV}->${dLatV},${dLngV}` },
          );

          verifiedLights = verification.verifiedLights;
          verificationFootprints = verification.queryFootprints || [];
          const verifiedDarkCacheByEdgeIdx = new Map();
          for (const [edgeIdx, verified] of verification.verifiedSegments.entries()) {
            if (verified?.lit_status !== 'unlit') continue;
            if (!edges[edgeIdx]) continue;
            verifiedDarkCacheByEdgeIdx.set(edgeIdx, {
              source: 'os_ngd',
              lit_status: 'unlit',
              confidence: typeof verified.confidence === 'number' ? verified.confidence : 0.9,
              confidence_reason: verified.reason || 'no_lights_in_os_ngd',
            });
          }

          debugLog(
            `[safe-routes] 💡 OS NGD verification results: verifiedLights=${verifiedLights.length}, verifiedDarkEdges=${verifiedDarkCacheByEdgeIdx.size}`,
          );
          if (verification?.stats) {
            debugLog(
              `[safe-routes] 💡 OS NGD verification stats: memHits=${verification.stats.memoryCacheHits}, persistentHits=${verification.stats.persistentCacheHits}, persisted=${verification.stats.persistedDecisions}, cells=${verification.stats.totalCellsBeforeDedup || 0}->${verification.stats.totalCellsAfterDedup || 0}, queriedCells=${verification.stats.queriedClusters}, skippedByBudget=${verification.stats.skippedClustersBudget}`,
            );
          }

          if (verifiedLights.length > 0 || verifiedDarkCacheByEdgeIdx.size > 0) {
            recordOsNgdGapFill();
          }

          if (verifiedLights.length > 0 || verifiedDarkCacheByEdgeIdx.size > 0) {
            allData.lights.elements = mergeVerifiedLights(
              allData.lights.elements,
              verifiedLights,
            );
            // Rebuild graph with verified lights and confirmed-dark cache entries.
            ({
              osmNodes, edges, adjacency, nodeGrid, weights,
              cctvNodes, transitNodes, nodeDegree,
            } = await computeGraphAndCandidates({
              ...allData,
              lightsCacheByEdgeIdx: verifiedDarkCacheByEdgeIdx,
            }));
            // Re-run pathfinding
            const maxRouteDist = straightLineDist * 2.5;
            rawRoutes = findRouteCandidates({
              wpLat, wpLng,
              nodeGrid, adjacency,
              startNode: findNearestNode(nodeGrid, adjacency, oLatV, oLngV),
              endNode: findNearestNode(nodeGrid, adjacency, dLatV, dLngV),
              osmNodes, edges,
              maxRouteDist,
              findNearestNode,
              findKSafestRoutes,
              logger: debugLogger,
              allowHazards,
              edgeConfidences,
            });
            edgeConfidences = computeEdgeConfidencesForCurrentGraph();
            lightVerificationStatus = 'verified';
          } else {
            lightVerificationStatus = 'no_gaps_found';
            debugLog('[safe-routes] 💡 OS NGD returned no new verified lighting changes');
          }
        } catch (verifyErr) {
          if (verifyErr?.code === 'SEARCH_CANCELLED') {
            debugLog(`[safe-routes] 💡 Light verification cancelled: ${verifyErr.message}`);
          } else {
            console.warn(`[safe-routes] Light verification failed: ${verifyErr.message}`);
          }
          lightVerificationStatus = 'failed';
        }
      } else {
        debugLog('[safe-routes] 💡 Light verification skipped: no route edges met the uncertainty threshold');
      }
    }

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

    const responseRoutes = buildRouteResponses({
      rawRoutes,
      osmNodes,
      edges,
      weights,
      cctvNodes,
      transitNodes,
      nodeDegree,
      crimes,
      allData,
      oLat: oLatV,
      oLng: oLngV,
      dLat: dLatV,
      dLng: dLngV,
      enableOpeningHoursParse: ENABLE_RESPONSE_OPENING_HOURS_PARSE,
      responsePolicy,
      edgeConfidences,
      straightLineDist,
      verificationFootprints,
    });

    const routeSegmentDebug = rawRoutes.map((route, idx) => {
      let uncertainSegments = 0;
      let explicitDarkSegments = 0;
      for (const edgeIdx of route.edges) {
        const conf = edgeConfidences?.[edgeIdx];
        if (conf?.needsVerification) uncertainSegments += 1;
        if (conf?.reason === 'explicit_lit_no') explicitDarkSegments += 1;
      }
      return {
        routeIndex: idx,
        segments: route.edges.length,
        explicitDarkSegments,
        uncertainSegments,
      };
    });
    console.log(
      `[safe-routes] 📐 Path segments: ${routeSegmentDebug
        .map((r) => `r${r.routeIndex}=segments:${r.segments},dark:${r.explicitDarkSegments},uncertain:${r.uncertainSegments}`)
        .join(' | ')}`,
    );

    const elapsed = Date.now() - startTime;
    recordRouteLatency(elapsed);
    cancelToken?.throwIfCancelled?.();
    progress("finalize", "Finalizing route output…", 90);
    debugLog(
      `[safe-routes] 🏁 Done in ${elapsed}ms (corridor:${phase1Time}ms, data:${dataTime}ms, graph:${graphTime}ms, A*:${pathfindTime}ms, recorrection:${recorrectionMs}ms) — ${responseRoutes.length} routes, safest: ${responseRoutes[0]?.safety?.score}`,
    );

    return {
      status: "OK",
      routes: responseRoutes,
      meta: buildSafeRoutesMeta({
        straightLineKm,
        maxDistanceKm,
        responseRoutes,
        roadCount,
        crimes,
        allData,
        elapsed,
        phase1Time,
        dataTime,
        graphTime,
        pathfindTime,
        recorrectionMs,
        dataSources,
        lightVerificationStatus,
        verifiedLightsCount: verifiedLights.length,
      }),
    };
  } finally {
    if (typeof cancelUnsub === "function") cancelUnsub();
  }
}

module.exports = router;