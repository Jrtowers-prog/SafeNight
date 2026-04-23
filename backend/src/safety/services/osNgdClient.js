/**
 * osNgdClient.js — OS NGD API client for OS-replaceable safety signals.
 *
 * Fetches ONLY signals that OS can authoritatively provide:
 *   - Road Link, Path Link (geometry & connectivity)
 *   - Pavement Link (sidewalk presence & width)
 *   - Street Light features (pole locations)
 *   - RAMI Restrictions & Hazards
 *
 * Does NOT fetch: CCTV, open places, transit stops — these remain OSM-only.
 *
 * Transforms OS NGD GeoJSON into Overpass-like { elements: [...] } shape
 * so the existing graph builder consumes it without changes.
 */

const { createSafetyCacheStore } = require('./cacheStore');
const { checkCap, reconcile, OsCapExceededError } = require('./osSpendGuard');
const {
  estimateNgdFeatureTransactions,
  estimateSpendGbp,
  confirmFeatureTransactions,
} = require('./osTransactionEstimator');
const { hashIdempotencyKey } = require('./osUsageLedger');

function getOsApiKey() {
  return (process.env.OS_API_KEY || '').trim();
}

function getOsEnabled() {
  return !!getOsApiKey();
}

const OS_NGD_FEATURES_URL = (process.env.OS_NGD_FEATURES_URL || 'https://api.os.uk/features/ngd/ofa/v1/collections').trim();
const OS_PLAN_MODE = (process.env.OS_PLAN_MODE || 'premium').trim().toLowerCase();
const OS_THROTTLE_TXNS_PER_MINUTE = Math.max(
  1,
  Number(process.env.OS_THROTTLE_TXNS_PER_MINUTE || (OS_PLAN_MODE === 'development' ? 50 : 600)),
);
const OS_COLLECTION_RESOLVE_TTL_MS = Math.max(
  60_000,
  Number(process.env.OS_COLLECTION_RESOLVE_TTL_MS || 60 * 60 * 1000),
);
const OS_COLLECTION_VERSION_STRATEGY = (process.env.OS_COLLECTION_VERSION_STRATEGY || 'latest').trim().toLowerCase();

const DEFAULT_COLLECTION_IDS = {
  roadlink: 'trn-ntwk-roadlink-1',
  pathlink: 'trn-ntwk-pathlink-1',
  streetlight: 'trn-fts-streetlight-1',
};

// Cache for OS NGD data (same TTL as Overpass data)
const OS_DATA_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const osDataCache = createSafetyCacheStore({
  namespace: 'os-ngd-data',
  ttlMs: OS_DATA_CACHE_TTL,
  maxEntries: 50,
});

// In-memory throttle: token bucket
const THROTTLE_WINDOW_MS = 60_000;
let throttleTokens = OS_THROTTLE_TXNS_PER_MINUTE;
let throttleLastRefill = Date.now();

let collectionsSnapshotCache = {
  expiresAt: 0,
  ids: null,
  inFlight: null,
};
const collectionIdCache = new Map();

function refillThrottle() {
  const now = Date.now();
  const elapsed = now - throttleLastRefill;
  if (elapsed >= THROTTLE_WINDOW_MS) {
    throttleTokens = OS_THROTTLE_TXNS_PER_MINUTE;
    throttleLastRefill = now;
  }
}

function consumeThrottleToken() {
  refillThrottle();
  if (throttleTokens <= 0) return false;
  throttleTokens -= 1;
  return true;
}

function osCacheKey(bbox, suffix = '') {
  const r = (v) => Math.round(v * 500) / 500;
  const base = `${r(bbox.south)},${r(bbox.west)},${r(bbox.north)},${r(bbox.east)}`;
  return suffix ? `${base}:${suffix}` : base;
}

function bboxContains(outer, inner) {
  if (!outer || !inner) return false;
  return (
    outer.south <= inner.south &&
    outer.west <= inner.west &&
    outer.north >= inner.north &&
    outer.east >= inner.east
  );
}

function makeIdempotencyKey(api, bbox, routeKey = '') {
  const day = new Date().toISOString().slice(0, 10);
  const bboxHash = osCacheKey(bbox);
  return hashIdempotencyKey(api, routeKey, bboxHash, day);
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fetchCollectionsSnapshot() {
  const now = Date.now();
  if (collectionsSnapshotCache.ids && now < collectionsSnapshotCache.expiresAt) {
    return collectionsSnapshotCache.ids;
  }
  if (collectionsSnapshotCache.inFlight) {
    return collectionsSnapshotCache.inFlight;
  }

  const url = new URL(OS_NGD_FEATURES_URL);
  url.searchParams.set('key', getOsApiKey());

  collectionsSnapshotCache.inFlight = (async () => {
    const resp = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SafeNight/1.0 (safety-service; contact: support@safenight.app)',
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OS collections lookup failed ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    const ids = Array.isArray(data?.collections)
      ? data.collections.map((entry) => entry?.id).filter((id) => typeof id === 'string')
      : [];

    collectionsSnapshotCache = {
      expiresAt: Date.now() + OS_COLLECTION_RESOLVE_TTL_MS,
      ids,
      inFlight: null,
    };
    return ids;
  })();

  try {
    return await collectionsSnapshotCache.inFlight;
  } catch (err) {
    collectionsSnapshotCache.inFlight = null;
    throw err;
  }
}

function chooseLatestVersionedCollectionId(prefix, ids) {
  const pattern = new RegExp(`^${escapeForRegExp(prefix)}-(\\d+)$`);
  let latestId = null;
  let latestVersion = -1;

  for (const id of ids) {
    const match = pattern.exec(id);
    if (!match) continue;
    const version = Number(match[1]);
    if (!Number.isFinite(version)) continue;
    if (version > latestVersion) {
      latestVersion = version;
      latestId = id;
    }
  }

  return latestId;
}

async function resolveCollectionId(prefix, fallbackId) {
  if (OS_COLLECTION_VERSION_STRATEGY === 'pinned') {
    return fallbackId;
  }

  const now = Date.now();
  const cached = collectionIdCache.get(prefix);
  if (cached && now < cached.expiresAt) {
    return cached.id;
  }

  try {
    const ids = await fetchCollectionsSnapshot();
    const latest = chooseLatestVersionedCollectionId(prefix, ids);
    const resolved = latest || fallbackId;

    collectionIdCache.set(prefix, {
      id: resolved,
      expiresAt: now + OS_COLLECTION_RESOLVE_TTL_MS,
    });

    if (latest && latest !== fallbackId) {
      console.log(`[os-ngd] Using latest collection for ${prefix}: ${latest}`);
    }

    return resolved;
  } catch (err) {
    console.warn(`[os-ngd] Collection lookup failed for ${prefix}; using fallback ${fallbackId}: ${err.message}`);
    collectionIdCache.set(prefix, {
      id: fallbackId,
      expiresAt: now + Math.min(OS_COLLECTION_RESOLVE_TTL_MS, 5 * 60 * 1000),
    });
    return fallbackId;
  }
}

/**
 * Build OGC API Features bbox parameter value.
 * Order is west,south,east,north (lon,lat,lon,lat) in WGS84.
 */
function buildBboxParam(bbox) {
  const { south, west, north, east } = bbox;
  return `${west},${south},${east},${north}`;
}

async function fetchNgdCollection(collectionId, bbox, options = {}) {
  if (!getOsEnabled()) {
    throw new Error('OS API not enabled (missing OS_API_KEY)');
  }

  const { signal = null, routeKey = '' } = options;

  // Throttle check
  if (!consumeThrottleToken()) {
    const err = new Error('OS API throttled');
    err.code = 'UPSTREAM_UNAVAILABLE';
    err.statusCode = 503;
    err.isServerBusy = true;
    throw err;
  }

  // Cap guard check
  const projectedTransactions = estimateNgdFeatureTransactions(bbox);
  const projectedSpend = estimateSpendGbp('os-ngd-features', projectedTransactions);
  await checkCap(projectedSpend);

  const idempotencyKey = makeIdempotencyKey(collectionId, bbox, routeKey);

  const bboxParam = buildBboxParam(bbox);
  const url = new URL(`${OS_NGD_FEATURES_URL}/${collectionId}/items`);
  url.searchParams.set('bbox', bboxParam);
  url.searchParams.set('bbox-crs', 'http://www.opengis.net/def/crs/OGC/1.3/CRS84');
  url.searchParams.set('limit', '100');
  url.searchParams.set('key', getOsApiKey());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const abortFromParent = () => controller.abort();
  if (signal) signal.addEventListener('abort', abortFromParent, { once: true });

  let resp;
  try {
    resp = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/geo+json',
        'User-Agent': 'SafeNight/1.0 (safety-service; contact: support@safenight.app)',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abortFromParent);
  }

  if (resp.status === 429) {
    const err = new Error('OS API throttled (429)');
    err.code = 'UPSTREAM_UNAVAILABLE';
    err.statusCode = 503;
    err.isServerBusy = true;
    throw err;
  }
  if (resp.status >= 500) {
    const err = new Error(`OS API error ${resp.status}`);
    err.code = 'UPSTREAM_UNAVAILABLE';
    err.statusCode = 503;
    err.isServerBusy = true;
    throw err;
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OS API error ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  const features = Array.isArray(data.features) ? data.features : [];

  // Reconcile spend
  const confirmedTransactions = confirmFeatureTransactions(features.length);
  const confirmedSpend = estimateSpendGbp('os-ngd-features', confirmedTransactions);
  await reconcile({
    api: 'os-ngd-features',
    transactionType: 'feature_request',
    confirmedTransactions,
    confirmedSpendGbp: confirmedSpend,
    idempotencyKey,
    requestContext: { collectionId, bboxHash: osCacheKey(bbox), featureCount: features.length },
  });

  return features;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA TRANSFORMATION: OS NGD → Overpass-like shape
// ═══════════════════════════════════════════════════════════════════════════════

const ROAD_CLASSIFICATION_TO_HIGHWAY = {
  'A Road': 'primary',
  'B Road': 'secondary',
  'Minor Road': 'unclassified',
  'Local Road': 'residential',
  'Private Road': 'service',
  'Pedestrianised Street': 'pedestrian',
  'Cycleway': 'cycleway',
  'Footpath': 'footway',
  'Bridleway': 'path',
  'Track': 'track',
};

const FORMOFWAY_TO_HIGHWAY = {
  'Dual Carriageway': 'primary',
  'Single Carriageway': 'secondary',
  'Slip Road': 'service',
  'Roundabout': 'tertiary',
  'Traffic Island Link': 'service',
  'Enclosed Traffic Area Link': 'service',
};

function mapRoadLinkToHighway(properties) {
  const form = properties?.formofway;
  const classification = properties?.roadclassification;
  if (form && FORMOFWAY_TO_HIGHWAY[form]) return FORMOFWAY_TO_HIGHWAY[form];
  if (classification && ROAD_CLASSIFICATION_TO_HIGHWAY[classification]) {
    return ROAD_CLASSIFICATION_TO_HIGHWAY[classification];
  }
  return 'unclassified';
}

function mapPathLinkToHighway(properties) {
  const type = properties?.pathtype;
  if (type === 'Footpath') return 'footway';
  if (type === 'Bridleway') return 'path';
  if (type === 'Cycleway') return 'cycleway';
  if (type === 'Steps') return 'steps';
  return 'path';
}

function transformRoadLinkFeature(feature) {
  const props = feature.properties || {};
  const geom = feature.geometry;
  if (!geom || geom.type !== 'LineString' || !Array.isArray(geom.coordinates)) return null;

  const highway = mapRoadLinkToHighway(props);
  const tags = { highway };

  if (props.name) tags.name = props.name;
  if (props.presenceofpavement === 'True' || props.presenceofpavement === true) {
    tags.sidewalk = 'both';
  }
  if (props.presenceofstreetlight_coverage === 'WellLit' || props.presenceofstreetlight_coverage === 'PartiallyLit') {
    tags.lit = 'yes';
  }
  if (props.presenceofcyclelane === 'True' || props.presenceofcyclelane === true) {
    tags.cycleway = 'lane';
  }
  if (props.presenceofbuslane === 'True' || props.presenceofbuslane === true) {
    tags.busway = 'lane';
  }

  // Generate synthetic OSM node IDs from coordinates
  const nodes = [];
  const elements = [];
  for (const [lng, lat] of geom.coordinates) {
    const nodeId = `os_${lat.toFixed(6)}_${lng.toFixed(6)}`.replace(/[-.]/g, '_');
    nodes.push(nodeId);
    elements.push({
      type: 'node',
      id: nodeId,
      lat,
      lon: lng,
    });
  }

  elements.push({
    type: 'way',
    id: feature.id || `os_road_${nodes[0]}`,
    nodes,
    tags,
  });

  return elements;
}

function transformPathLinkFeature(feature) {
  const props = feature.properties || {};
  const geom = feature.geometry;
  if (!geom || geom.type !== 'LineString' || !Array.isArray(geom.coordinates)) return null;

  const highway = mapPathLinkToHighway(props);
  const tags = { highway };

  if (props.name) tags.name = props.name;
  if (props.presenceofstreetlight_coverage === 'WellLit' || props.presenceofstreetlight_coverage === 'PartiallyLit') {
    tags.lit = 'yes';
  }
  if (props.surface) tags.surface = props.surface;

  const nodes = [];
  const elements = [];
  for (const [lng, lat] of geom.coordinates) {
    const nodeId = `os_${lat.toFixed(6)}_${lng.toFixed(6)}`.replace(/[-.]/g, '_');
    nodes.push(nodeId);
    elements.push({
      type: 'node',
      id: nodeId,
      lat,
      lon: lng,
    });
  }

  elements.push({
    type: 'way',
    id: feature.id || `os_path_${nodes[0]}`,
    nodes,
    tags,
  });

  return elements;
}

function transformStreetLightFeature(feature) {
  const geom = feature.geometry;
  if (!geom || geom.type !== 'Point' || !Array.isArray(geom.coordinates)) return null;
  const [lng, lat] = geom.coordinates;

  return [{
    type: 'node',
    id: feature.id || `os_light_${lat.toFixed(6)}_${lng.toFixed(6)}`.replace(/[-.]/g, '_'),
    lat,
    lon: lng,
    tags: { highway: 'street_lamp' },
  }];
}

function transformPavementLinkFeature(feature) {
  // Pavement links augment road links; we skip standalone geometry
  // and instead use them to enrich road link sidewalk tags.
  return null;
}

function transformRamiRestrictionFeature(feature) {
  const props = feature.properties || {};
  // If restriction bans pedestrians, we could filter later.
  // For now, skip adding geometry; just note restriction.
  return null;
}

function mergeFeaturesIntoElements(features, collectionId) {
  const allElements = [];
  for (const feature of features) {
    let transformed = null;
    if (collectionId.includes('roadlink')) {
      transformed = transformRoadLinkFeature(feature);
    } else if (collectionId.includes('pathlink')) {
      transformed = transformPathLinkFeature(feature);
    } else if (collectionId.includes('streetlight')) {
      transformed = transformStreetLightFeature(feature);
    } else if (collectionId.includes('pavementlink')) {
      transformed = transformPavementLinkFeature(feature);
    } else if (collectionId.includes('restriction')) {
      transformed = transformRamiRestrictionFeature(feature);
    }
    if (transformed) {
      for (const el of transformed) {
        el._source = 'os';
        el._sourceReason = `os-ngd:${collectionId}`;
      }
      allElements.push(...transformed);
    }
  }
  return allElements;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch road network (Road Link + Path Link) from OS NGD.
 * Returns { elements: [...] } in Overpass-like shape.
 */
async function fetchOsRoadNetwork(bbox, options = {}) {
  if (!getOsEnabled()) {
    throw new Error('OS API not enabled (missing OS_API_KEY)');
  }

  const cacheKey = osCacheKey(bbox, 'roads');
  const cached = await osDataCache.get(cacheKey);
  if (cached) {
    console.log('[os-ngd] 📋 Road network cache hit');
    return cached;
  }

  const [roadCollectionId, pathCollectionId] = await Promise.all([
    resolveCollectionId('trn-ntwk-roadlink', DEFAULT_COLLECTION_IDS.roadlink),
    resolveCollectionId('trn-ntwk-pathlink', DEFAULT_COLLECTION_IDS.pathlink),
  ]);

  const [roadLinks, pathLinks] = await Promise.all([
    fetchNgdCollection(roadCollectionId, bbox, options).catch((err) => {
      console.warn(`[os-ngd] RoadLink fetch failed: ${err.message}`);
      return [];
    }),
    fetchNgdCollection(pathCollectionId, bbox, options).catch((err) => {
      console.warn(`[os-ngd] PathLink fetch failed: ${err.message}`);
      return [];
    }),
  ]);

  const elements = [
    ...mergeFeaturesIntoElements(roadLinks, roadCollectionId),
    ...mergeFeaturesIntoElements(pathLinks, pathCollectionId),
  ];

  const result = { elements };
  await osDataCache.set(cacheKey, result);
  console.log(`[os-ngd] ✅ Road network: ${elements.length} elements from OS`);
  return result;
}

/**
 * Fetch OS-replaceable safety data:
 *   - Road Link + Path Link (roads)
 *   - Street Light (lights)
 *   - Pavement Link metadata (skipped, used via roadlink enrichment)
 *   - RAMI Restrictions (skipped for now, minimal safety impact)
 *
 * Returns { roads, lights, cctv, places, transit } where:
 *   - roads and lights come from OS
 *   - cctv, places, transit are empty (filled by OSM caller)
 */
async function fetchOsSafetyData(bbox, options = {}) {
  if (!getOsEnabled()) {
    throw new Error('OS API not enabled (missing OS_API_KEY)');
  }

  const {
    preloadedRoads = null,
    preloadedRoadsBbox = null,
  } = options;

  const cacheKey = osCacheKey(bbox, 'safety');
  const cached = await osDataCache.get(cacheKey);
  if (cached) {
    console.log('[os-ngd] 📋 Safety data cache hit');
    return cached;
  }

  const streetLightCollectionId = await resolveCollectionId(
    'trn-fts-streetlight',
    DEFAULT_COLLECTION_IDS.streetlight,
  );

  const canReusePreloadedRoads =
    preloadedRoads &&
    Array.isArray(preloadedRoads.elements) &&
    preloadedRoads.elements.length > 0 &&
    bboxContains(preloadedRoadsBbox, bbox);

  const roadNetworkPromise = canReusePreloadedRoads
    ? Promise.resolve(preloadedRoads)
    : fetchOsRoadNetwork(bbox, options).catch((err) => {
        if (err instanceof OsCapExceededError) throw err;
        console.warn(`[os-ngd] Road network fetch failed: ${err.message}`);
        return { elements: [] };
      });

  if (canReusePreloadedRoads) {
    console.log('[os-ngd] ♻️ Reusing preloaded OS road network for safety fetch');
  }

  const [roadNetwork, streetLights] = await Promise.all([
    roadNetworkPromise,
    fetchNgdCollection(streetLightCollectionId, bbox, options).catch((err) => {
      if (err instanceof OsCapExceededError) throw err;
      console.warn(`[os-ngd] StreetLight fetch failed: ${err.message}`);
      return [];
    }),
  ]);

  const lightElements = mergeFeaturesIntoElements(streetLights, streetLightCollectionId);

  const result = {
    roads: roadNetwork,
    lights: { elements: lightElements },
    cctv: { elements: [] },
    places: { elements: [] },
    transit: { elements: [] },
  };

  await osDataCache.set(cacheKey, result);
  console.log(
    `[os-ngd] ✅ Safety data: ${roadNetwork.elements.length} road elements, ${lightElements.length} lights from OS`
  );
  return result;
}

function __resetForTests() {
  osDataCache.clearMemory();
  collectionIdCache.clear();
  collectionsSnapshotCache = {
    expiresAt: 0,
    ids: null,
    inFlight: null,
  };
  // Reset throttle to allow fresh tests — read from current env
  const planMode = (process.env.OS_PLAN_MODE || 'premium').trim().toLowerCase();
  throttleTokens = Math.max(1, Number(process.env.OS_THROTTLE_TXNS_PER_MINUTE || (planMode === 'development' ? 50 : 600)));
  throttleLastRefill = Date.now();
}

/**
 * Fetch only street lights from OS NGD for a small bbox.
 * Used by the micro-query gap-fill system.
 */
async function fetchOsStreetLightsOnly(bbox, options = {}) {
  if (!getOsEnabled()) {
    throw new Error('OS API not enabled (missing OS_API_KEY)');
  }

  const { signal = null, routeKey = '' } = options;
  const streetLightCollectionId = await resolveCollectionId(
    'trn-fts-streetlight',
    DEFAULT_COLLECTION_IDS.streetlight,
  );

  const streetLights = await fetchNgdCollection(streetLightCollectionId, bbox, { signal, routeKey });
  const lightElements = mergeFeaturesIntoElements(streetLights, streetLightCollectionId);

  console.log(`[os-ngd] 💡 Micro-query: ${lightElements.length} lights in small bbox`);
  return { elements: lightElements };
}

module.exports = {
  fetchOsRoadNetwork,
  fetchOsSafetyData,
  fetchOsStreetLightsOnly,
  get OS_ENABLED() { return getOsEnabled(); },
  OsCapExceededError,
  __resetForTests,
};
