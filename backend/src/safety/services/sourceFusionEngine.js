/**
 * sourceFusionEngine.js — Source selection and blending for safety data.
 *
 * NEW PRIORITY (local-OSM-first):
 *   1. Local OSM ingestion (port 3006) — primary for ALL signals
 *   2. Overpass live API — secondary fallback if local OSM unavailable
 *   3. OS NGD — last-resort gap-fill for street lights ONLY (micro-queries)
 *
 * Previously: OS NGD was primary, Overpass was fallback.
 */

const { fetchAllSafetyData, fetchRoadNetworkOnly } = require('./overpassClient');
const {
  isOsmIngestionAvailable,
  fetchLocalOsmSafetyData,
  fetchLocalOsmRoadNetwork,
  fetchLocalOsmOnlySafetyData,
} = require('./osmIngestionClient');

const DEBUG_SOURCE_FUSION = process.env.SAFE_ROUTES_DEBUG === '1';

function logDecision(event, details) {
  if (!DEBUG_SOURCE_FUSION) return;
  console.log(`[source-fusion] ${event}`, JSON.stringify(details));
}

/**
 * Fetch road network with LOCAL-OSM-FIRST policy.
 */
async function fetchRoadNetwork(bbox, options = {}) {
  const { signal = null, routeKey = '' } = options;

  // 1. Try local OSM ingestion first
  if (await isOsmIngestionAvailable()) {
    try {
      const localData = await fetchLocalOsmRoadNetwork(bbox, { signal });
      if (localData.elements.length > 0) {
        logDecision('road_network', { source: 'local_osm', elementCount: localData.elements.length });
        return localData;
      }
    } catch (err) {
      logDecision('road_network', { source: 'local_osm_failed', reason: err.message });
      // Fall through to Overpass
    }
  }

  // 2. Fallback: Overpass road network only
  const overpassData = await fetchRoadNetworkOnly(bbox, { signal });
  logDecision('road_network', { source: 'osm', elementCount: overpassData.elements.length });
  return { ...overpassData, _sourceMeta: { source: 'osm', reason: 'local-osm-unavailable-fallback' } };
}

/**
 * Fetch all safety data with LOCAL-OSM-FIRST policy.
 */
async function fetchSafetyData(bbox, options = {}) {
  const {
    signal = null,
    onSourceMeta = null,
    routeKey = '',
  } = options;

  // 1. Try local OSM ingestion first
  if (await isOsmIngestionAvailable()) {
    try {
      const localFull = await fetchLocalOsmSafetyData(bbox, { signal, onSourceMeta });
      logDecision('safety_data', {
        source: 'local_osm',
        roadCount: localFull.roads.elements.length,
        lightCount: localFull.lights.elements.length,
      });
      return {
        ...localFull,
        _sourceMeta: {
          roads: { source: 'local_osm', reason: 'local-osm-primary' },
          lights: { source: 'local_osm', reason: 'local-osm-primary' },
          cctv: { source: 'local_osm', reason: 'local-osm-primary' },
          places: { source: 'local_osm', reason: 'local-osm-primary' },
          transit: { source: 'local_osm', reason: 'local-osm-primary' },
        },
      };
    } catch (err) {
      logDecision('safety_data', { source: 'local_osm_failed', reason: err.message });
      // Fall through to Overpass
    }
  }

  // 2. Fallback: Overpass
  const fullOverpass = await fetchAllSafetyData(bbox, { signal, onSourceMeta });
  logDecision('safety_data', { source: 'osm', reason: 'local-osm-unavailable-full-fallback' });
  return {
    ...fullOverpass,
    _sourceMeta: {
      roads: { source: 'osm', reason: 'local-osm-unavailable-full-fallback' },
      lights: { source: 'osm', reason: 'local-osm-unavailable-full-fallback' },
      cctv: { source: 'osm', reason: 'osm-only-signal' },
      places: { source: 'osm', reason: 'osm-only-signal' },
      transit: { source: 'osm', reason: 'osm-only-signal' },
    },
  };
}

/**
 * Fetch only OSM-only safety signals (CCTV, open places, transit).
 * This is a lighter Overpass query that skips roads and lights.
 * Kept for backwards compat — now rarely used since local OSM covers these.
 */
async function fetchOsmOnlySafetyData(bbox, options = {}) {
  const { signal = null } = options;
  const { south, west, north, east } = bbox;
  const b = `${south},${west},${north},${east}`;

  const cctvQuery = `
    node["man_made"="surveillance"](${b});
    out body;
  `;

  const placesQuery = `
    (
      node["amenity"](${b});
      node["shop"](${b});
      node["leisure"](${b});
      node["tourism"](${b});
      way["amenity"](${b});
      way["shop"](${b});
    );
    out center;
  `;

  const transitQuery = `
    (
      node["highway"="bus_stop"](${b});
      node["public_transport"="stop_position"](${b});
      node["public_transport"="platform"](${b});
    );
    out body;
  `;

  const { overpassQuery } = require('./overpassClient');

  const [cctv, places, transit] = await Promise.all([
    overpassQuery(cctvQuery, 30, signal).catch(() => ({ elements: [] })),
    overpassQuery(placesQuery, 30, signal).catch(() => ({ elements: [] })),
    overpassQuery(transitQuery, 30, signal).catch(() => ({ elements: [] })),
  ]);

  return {
    cctv,
    places,
    transit,
  };
}

module.exports = {
  fetchRoadNetwork,
  fetchSafetyData,
  fetchOsmOnlySafetyData,
};
