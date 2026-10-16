/**
 * osmIngestionClient.js — Query the local OSM ingestion service instead of Overpass.
 *
 * The osm-ingestion service (port 3006) hosts pre-filtered UK OSM data:
 *   - Roads, paths, cycleways (ways)
 *   - Street lamps, CCTV, amenities, transit stops (nodes)
 *
 * This client queries its /data/bbox endpoint and transforms the response
 * into the same { roads, lights, cctv, places, transit } shape that the
 * safety service expects, so it's a drop-in replacement for Overpass.
 */

const OSM_INGESTION_URL = (process.env.OSM_INGESTION_URL || 'http://localhost:3006').trim();
const OSM_INGESTION_TIMEOUT_MS = Math.max(1000, Number(process.env.OSM_INGESTION_TIMEOUT_MS || 8000));

const LOCAL_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
const localCache = new Map();

function cacheKey(bbox) {
  const r = (v) => Math.round(v * 500) / 500;
  return `${r(bbox.south)},${r(bbox.west)},${r(bbox.north)},${r(bbox.east)}`;
}

function getCached(key) {
  const entry = localCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > LOCAL_CACHE_TTL_MS) {
    localCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key, data) {
  localCache.set(key, { ts: Date.now(), data });
  // Simple LRU: cap at 50 entries
  if (localCache.size > 50) {
    const first = localCache.keys().next().value;
    localCache.delete(first);
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Local OSM ingestion timeout')), ms)
    ),
  ]);
}

/**
 * Check if the local OSM ingestion service is available.
 */
async function isOsmIngestionAvailable() {
  try {
    const resp = await withTimeout(
      fetch(`${OSM_INGESTION_URL}/health`, { method: 'GET' }),
      2000,
    );
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Transform a local OSM feature into Overpass-like element shape.
 */
function toOverpassElement(feature) {
  const base = {
    type: feature.type,
    id: feature.id,
    tags: feature.tags || {},
  };

  if (feature.type === 'node') {
    base.lat = feature.lat;
    base.lon = feature.lon;
  } else if (feature.type === 'way') {
    base.nodes = feature.nodes || [];
    // Compute center for ways that have bbox
    if (feature.bbox) {
      base.center = {
        lat: (feature.bbox.minLat + feature.bbox.maxLat) / 2,
        lon: (feature.bbox.minLon + feature.bbox.maxLon) / 2,
      };
    }
  }

  return base;
}

/**
 * Classify features into the categories the safety service expects.
 */
function classifyFeatures(ways, nodes) {
  const roadElements = [];
  const lightElements = [];
  const cctvElements = [];
  const placeElements = [];
  const transitElements = [];

  const roadWayNodeIds = new Set();
  const lightWayNodeIds = new Set();

  // Classify ways
  for (const f of ways || []) {
    const el = toOverpassElement(f);

    if (el.tags?.highway) {
      roadElements.push(el);
      if (el.nodes) for (const nid of el.nodes) roadWayNodeIds.add(nid);
    }
    if (el.tags?.lit === 'yes') {
      lightElements.push(el);
      if (el.nodes) for (const nid of el.nodes) lightWayNodeIds.add(nid);
    }
    if (el.tags?.amenity || el.tags?.shop) {
      placeElements.push(el);
    }
  }

  // Classify nodes
  for (const f of nodes || []) {
    const el = toOverpassElement(f);

    if (roadWayNodeIds.has(el.id)) roadElements.push(el);
    if (lightWayNodeIds.has(el.id)) lightElements.push(el);
    if (el.tags?.highway === 'street_lamp') lightElements.push(el);
    if (el.tags?.man_made === 'surveillance') cctvElements.push(el);
    if (
      el.tags?.amenity ||
      el.tags?.shop ||
      el.tags?.leisure ||
      el.tags?.tourism
    ) {
      placeElements.push(el);
    }
    if (
      el.tags?.highway === 'bus_stop' ||
      el.tags?.public_transport === 'stop_position' ||
      el.tags?.public_transport === 'platform'
    ) {
      transitElements.push(el);
    }
  }

  return {
    roads: { elements: roadElements },
    lights: { elements: lightElements },
    cctv: { elements: cctvElements },
    places: { elements: placeElements },
    transit: { elements: transitElements },
  };
}

/**
 * Fetch all safety data from the local OSM ingestion service.
 * Returns the same shape as overpassClient.fetchAllSafetyData.
 */
async function fetchLocalOsmSafetyData(bbox, options = {}) {
  const { signal = null, onSourceMeta = null } = options;
  const key = cacheKey(bbox);

  const cached = getCached(key);
  if (cached) {
    if (typeof onSourceMeta === 'function') {
      onSourceMeta({ source: 'local_osm', stale: false, cached: true });
    }
    return cached;
  }

  const { south, west, north, east } = bbox;
  const url = `${OSM_INGESTION_URL}/data/bbox?south=${south}&west=${west}&north=${north}&east=${east}`;

  const fetchPromise = (async () => {
    const resp = await fetch(url, {
      method: 'GET',
      signal,
      headers: { Accept: 'application/json' },
    });

    if (!resp.ok) {
      throw new Error(`Local OSM ingestion returned ${resp.status}`);
    }

    const data = await resp.json();
    const classified = classifyFeatures(data.ways, data.nodes);

    const totalElements =
      classified.roads.elements.length +
      classified.lights.elements.length +
      classified.cctv.elements.length +
      classified.places.elements.length +
      classified.transit.elements.length;

    console.log(
      `[osm-ingestion] ✅ Local data: ${totalElements} elements (${classified.roads.elements.length} roads, ${classified.lights.elements.length} lights, ${classified.cctv.elements.length} CCTV, ${classified.places.elements.length} places, ${classified.transit.elements.length} transit)`,
    );

    setCached(key, classified);
    return classified;
  })();

  const result = await withTimeout(fetchPromise, OSM_INGESTION_TIMEOUT_MS);

  if (typeof onSourceMeta === 'function') {
    onSourceMeta({ source: 'local_osm', stale: false, cached: false });
  }

  return result;
}

/**
 * Fetch only the road network from local OSM ingestion.
 */
async function fetchLocalOsmRoadNetwork(bbox, options = {}) {
  const full = await fetchLocalOsmSafetyData(bbox, options);
  return {
    ...full.roads,
    _sourceMeta: { source: 'local_osm', reason: 'local-osm-road-network' },
  };
}

/**
 * Fetch only OSM-only signals (CCTV, places, transit) from local ingestion.
 */
async function fetchLocalOsmOnlySafetyData(bbox, options = {}) {
  const full = await fetchLocalOsmSafetyData(bbox, options);
  return {
    cctv: full.cctv,
    places: full.places,
    transit: full.transit,
  };
}

function __resetForTests() {
  localCache.clear();
}

module.exports = {
  isOsmIngestionAvailable,
  fetchLocalOsmSafetyData,
  fetchLocalOsmRoadNetwork,
  fetchLocalOsmOnlySafetyData,
  __resetForTests,
};
