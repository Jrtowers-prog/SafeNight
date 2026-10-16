const {
  checkOpenNow,
  heuristicOpen,
  safetyLabel,
  segmentColor,
} = require("./safeRoutesUtils");
const { collectRoutePOIs } = require("./safeRoutesPoiCollector");
const { encodePolyline } = require("../services/geo");
const {
  routeToPolyline,
  routeSafetyBreakdown,
} = require("../services/safetyGraph");
const {
  buildRouteLightGapSpans,
} = require("../services/lightConfidenceEngine");

const WALKING_SPEED_MPS = 1.35;
const DEFAULT_RESPONSE_POLICY = {
  verbosity: "full",
  poiCaps: {
    cctv: 200,
    transit: 200,
    deadEnds: 200,
    lights: 200,
    places: 200,
    crimes: 200,
  },
};

function normalizeResponsePolicy(responsePolicy) {
  const verbosity = responsePolicy?.verbosity === "compact" ? "compact" : "full";
  const mergedPoiCaps = {
    ...DEFAULT_RESPONSE_POLICY.poiCaps,
    ...(responsePolicy?.poiCaps || {}),
  };

  const poiCaps = {};
  for (const [category, value] of Object.entries(mergedPoiCaps)) {
    poiCaps[category] = Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : DEFAULT_RESPONSE_POLICY.poiCaps[category];
  }

  return {
    verbosity,
    poiCaps,
  };
}

function distanceSqFromOrigin(point, oLat, oLng) {
  const dLat = point.lat - oLat;
  const dLng = point.lng - oLng;
  return dLat * dLat + dLng * dLng;
}

function limitCategoryPois(points, cap, oLat, oLng) {
  if (!Array.isArray(points)) return [];
  if (!Number.isFinite(cap) || cap < 1) return [];
  if (points.length <= cap) return points;

  return points
    .map((point, index) => ({
      point,
      index,
      distanceSq: distanceSqFromOrigin(point, oLat, oLng),
    }))
    .sort((a, b) => a.distanceSq - b.distanceSq || a.index - b.index)
    .slice(0, cap)
    .map((entry) => entry.point);
}

function limitRoutePois(routePOIs, poiCaps, oLat, oLng) {
  return {
    cctv: limitCategoryPois(routePOIs?.cctv, poiCaps.cctv, oLat, oLng),
    transit: limitCategoryPois(routePOIs?.transit, poiCaps.transit, oLat, oLng),
    deadEnds: limitCategoryPois(routePOIs?.deadEnds, poiCaps.deadEnds, oLat, oLng),
    lights: limitCategoryPois(routePOIs?.lights, poiCaps.lights, oLat, oLng),
    places: limitCategoryPois(routePOIs?.places, poiCaps.places, oLat, oLng),
    crimes: limitCategoryPois(routePOIs?.crimes, poiCaps.crimes, oLat, oLng),
  };
}

function applyLightingOverride(label, color, score100, lightingPct) {
  if (!Number.isFinite(lightingPct)) {
    return { label, color };
  }

  if (lightingPct <= 20 && score100 >= 55) {
    return { label: "Use Caution", color: "#C62828" };
  }

  if (lightingPct <= 35 && score100 >= 75) {
    return { label: "Moderate", color: "#F9A825" };
  }

  return { label, color };
}

function buildUncertaintyBoxes(route, edges, osmNodes, edgeConfidences) {
  const boxes = [];
  const bufferDeg = 30 / 111320;
  for (const edgeIdx of route.edges || []) {
    const conf = edgeConfidences?.[edgeIdx];
    if (!conf?.needsVerification) continue;
    const edge = edges?.[edgeIdx];
    if (!edge) continue;
    const from = osmNodes.get(edge.from);
    const to = osmNodes.get(edge.to);
    if (!from || !to) continue;
    boxes.push({
      south: Math.min(from.lat, to.lat) - bufferDeg,
      west: Math.min(from.lng, to.lng) - bufferDeg,
      north: Math.max(from.lat, to.lat) + bufferDeg,
      east: Math.max(from.lng, to.lng) + bufferDeg,
    });
  }
  return boxes;
}

function buildLightUncertaintySpans(route, edges, osmNodes, edgeConfidences) {
  return buildRouteLightGapSpans(route, edges, osmNodes, edgeConfidences, {
    lowThreshold: 0.58,
    continueThreshold: 0.72,
    minSpanDistance: 90,
  }).map((span) => {
    const startNode = osmNodes.get(span.startNodeId);
    const endNode = osmNodes.get(span.endNodeId);
    if (!startNode || !endNode) return null;

    return {
      start: { lat: startNode.lat, lng: startNode.lng },
      end: { lat: endNode.lat, lng: endNode.lng },
      edgeCount: span.edgeCount,
      distance: span.distance,
      reason: span.reason === 'explicit_dark_span' ? 'explicit_dark' : 'light_uncertain',
      confidence: span.confidence,
    };
  }).filter(Boolean);
}

function buildGeneralUncertaintyBoxes(route, edges, osmNodes, edgeConfidences) {
  const boxes = [];
  const routeEdges = route.edges || [];
  const sparseHighways = new Set(['footway', 'path', 'steps', 'track', 'cycleway']);
  let current = null;

  const isSparseContext = (edge) => {
    if (!edge) return false;
    const nearbyContext = (edge.nearbyTransitCount || 0) + (edge.nearbyCctvCount || 0);
    const placeScore = Number(edge.placeScore || 0);
    const trafficScore = Number(edge.trafficScore || 0);
    const roadName = String(edge.roadName || '');
    return (
      nearbyContext === 0 &&
      placeScore < 0.15 &&
      trafficScore < 0.35 &&
      sparseHighways.has(edge.highway) &&
      roadName.length === 0
    );
  };

  const flush = () => {
    if (!current) return;
    if (!Number.isFinite(current.minLat)) {
      current = null;
      return;
    }
    const bufferDeg = 30 / 111320;
    boxes.push({
      south: current.minLat - bufferDeg,
      west: current.minLng - bufferDeg,
      north: current.maxLat + bufferDeg,
      east: current.maxLng + bufferDeg,
      reason: 'sparse_context',
      edgeCount: current.edgeCount,
      distance: Math.round(current.distance),
      confidence: Math.round((current.confidence ?? 0) * 100) / 100,
    });
    current = null;
  };

  for (const edgeIdx of routeEdges) {
    const conf = edgeConfidences?.[edgeIdx];
    const edge = edges?.[edgeIdx];
    if (!edge || !conf) {
      flush();
      continue;
    }

    const isLightIssue = conf.needsVerification || conf.reason === 'explicit_lit_no';
    if (isLightIssue || !isSparseContext(edge)) {
      flush();
      continue;
    }

    const from = osmNodes.get(edge.from);
    const to = osmNodes.get(edge.to);
    if (!from || !to) {
      flush();
      continue;
    }

    if (!current) {
      current = {
        minLat: Infinity,
        minLng: Infinity,
        maxLat: -Infinity,
        maxLng: -Infinity,
        edgeCount: 0,
        distance: 0,
        confidence: 1,
      };
    }

    current.minLat = Math.min(current.minLat, from.lat, to.lat);
    current.minLng = Math.min(current.minLng, from.lng, to.lng);
    current.maxLat = Math.max(current.maxLat, from.lat, to.lat);
    current.maxLng = Math.max(current.maxLng, from.lng, to.lng);
    current.edgeCount += 1;
    current.distance += edge.distance || 0;
    current.confidence = Math.min(current.confidence, Number.isFinite(conf.score) ? conf.score : 1);
  }

  flush();
  return boxes;
}

function buildCompactRoutePayload({
  route,
  idx,
  score100,
  label,
  color,
  breakdown,
  routeStats,
  limitedRoutePOIs,
  durationSec,
  queryFootprints,
  uncertaintyBoxes,
  lightUncertaintySpans,
  generalUncertaintyBoxes,
}) {
  return {
    routeIndex: idx,
    isSafest: idx === 0,
    overview_polyline: route.overview_polyline,
    summary: route.summary,
    distance: route.legs[0]?.distance,
    duration: route.legs[0]?.duration,
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
    },
    routeStats: {
      deadEnds: routeStats.deadEnds,
      sidewalkPct: routeStats.sidewalkPct,
      unpavedPct: routeStats.unpavedPct,
      transitStopsNearby: routeStats.transitStopsNearby,
      cctvCamerasNearby: routeStats.cctvCamerasNearby,
      estimatedDurationSec: durationSec,
    },
    routePOIs: limitedRoutePOIs,
    queryFootprints,
    lightUncertaintySpans,
    generalUncertaintyBoxes,
    uncertaintyBoxes,
  };
}

function collectLightNodes(lightElements) {
  const lightNodes = [];
  for (const el of lightElements || []) {
    if (
      el.type === "node" &&
      el.tags?.highway === "street_lamp" &&
      el.lat &&
      el.lon
    ) {
      lightNodes.push({ lat: el.lat, lng: el.lon });
    }
  }
  return lightNodes;
}

function collectOpenPlaceNodes(placeElements, enableOpeningHoursParse) {
  const placeNodes = [];
  for (const el of placeElements || []) {
    const lat = el.lat || el.center?.lat;
    const lng = el.lon || el.center?.lon;
    if (!lat || !lng) continue;

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

    let open = null;
    let nextChange = null;

    if (enableOpeningHoursParse && hoursRaw) {
      const parsed = checkOpenNow(hoursRaw);
      open = parsed.open;
      nextChange = parsed.nextChange;
    }

    if (open === null) {
      const heuristic = heuristicOpen(amenity);
      open = heuristic.open;
      nextChange = heuristic.nextChange;
    }

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

  return placeNodes;
}

function buildRouteResponses({
  rawRoutes,
  osmNodes,
  edges,
  weights,
  cctvNodes,
  transitNodes,
  nodeDegree,
  crimes,
  allData,
  oLat,
  oLng,
  dLat,
  dLng,
  enableOpeningHoursParse,
  responsePolicy,
  edgeConfidences = null,
  straightLineDist = 0,
  verificationFootprints = [],
}) {
  const normalizedResponsePolicy = normalizeResponsePolicy(responsePolicy);
  const lightNodes = collectLightNodes(allData?.lights?.elements);
  const placeNodes = collectOpenPlaceNodes(
    allData?.places?.elements,
    enableOpeningHoursParse,
  );

  const routes = rawRoutes.map((route, idx) => {
    const polyline = routeToPolyline(osmNodes, route.path);
    const breakdown = routeSafetyBreakdown(edges, route.edges, weights, edgeConfidences);
    const score100 = Math.round(breakdown.overall * 100);
    const lightingPct = Math.round((breakdown.lighting || 0) * 100);
    const baseLabel = safetyLabel(score100);
    const { label, color } = applyLightingOverride(
      baseLabel.label,
      baseLabel.color,
      score100,
      lightingPct,
    );
    const durationSec = Math.round(route.totalDist / WALKING_SPEED_MPS);
    const detourRatio = straightLineDist > 0 ? route.totalDist / straightLineDist : 0;

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

      if (edge.isDeadEnd) deadEndCount++;
      if (edge.hasSidewalk) sidewalkDist += edge.distance;
      if (edge.surfacePenalty > 0) unpavedDist += edge.distance;
      transitStopCount += edge.nearbyTransitCount;
      cctvNearCount += edge.nearbyCctvCount;

      const roadName = edge.roadName || "";
      if (roadName && roadName !== lastRoadName) {
        roadNameChanges.push({
          segmentIndex: i,
          name: roadName,
          distance: Math.round(cumulativeDist),
        });
        lastRoadName = roadName;
      }
      cumulativeDist += edge.distance;

      const edgeColor = edge.lightScore <= 0.2
        ? "#C62828"
        : edge.lightScore <= 0.35
          ? "#F9A825"
          : segmentColor(edge.safetyScore);

      segments.push({
        start: { lat: nodeA.lat, lng: nodeA.lng },
        end: { lat: nodeB.lat, lng: nodeB.lng },
        safetyScore: edge.safetyScore,
        color: edgeColor,
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

    const routePOIs = collectRoutePOIs(
      route.path,
      osmNodes,
      cctvNodes,
      transitNodes,
      nodeDegree,
      lightNodes,
      placeNodes,
      crimes,
    );
    const limitedRoutePOIs = limitRoutePois(
      routePOIs,
      normalizedResponsePolicy.poiCaps,
      oLat,
      oLng,
    );
    const uncertaintyBoxes = buildUncertaintyBoxes(
      route,
      edges,
      osmNodes,
      edgeConfidences,
    );
    const lightUncertaintySpans = buildLightUncertaintySpans(
      route,
      edges,
      osmNodes,
      edgeConfidences,
    );
    const generalUncertaintyBoxes = buildGeneralUncertaintyBoxes(
      route,
      edges,
      osmNodes,
      edgeConfidences,
    );

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

    const fullRoutePayload = {
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
          start_location: { lat: oLat, lng: oLng },
          end_location: { lat: dLat, lng: dLng },
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
        riskVector: breakdown.riskVector
          ? {
              mean: Math.round(breakdown.riskVector.mean * 100) / 100,
              p95: Math.round(breakdown.riskVector.p95 * 100) / 100,
              max: Math.round(breakdown.riskVector.max * 100) / 100,
              uncertainty: Math.round(breakdown.riskVector.uncertainty * 100) / 100,
              detourRatio: Math.round(detourRatio * 100) / 100,
            }
          : null,
        caution: breakdown.riskVector && breakdown.riskVector.max < 0.2 && breakdown.riskVector.uncertainty > 0.15
          ? 'Includes unverified or high-risk segments'
          : null,
      },
      segments,
      routeStats,
      routePOIs: limitedRoutePOIs,
      queryFootprints: verificationFootprints,
      lightUncertaintySpans,
      generalUncertaintyBoxes,
      uncertaintyBoxes,
    };

    if (normalizedResponsePolicy.verbosity === "compact") {
      return buildCompactRoutePayload({
        route: fullRoutePayload,
        idx,
        score100,
        label,
        color,
        breakdown,
        routeStats,
        limitedRoutePOIs,
        durationSec,
        queryFootprints: verificationFootprints,
        lightUncertaintySpans,
        generalUncertaintyBoxes,
        uncertaintyBoxes,
      });
    }

    return fullRoutePayload;
  });

  const minRoutes = Math.min(3, rawRoutes.length);
  return routes.slice(0, Math.max(minRoutes, routes.length));
}

module.exports = {
  collectLightNodes,
  collectOpenPlaceNodes,
  buildRouteResponses,
};
