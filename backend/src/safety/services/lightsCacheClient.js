/**
 * lightsCacheClient.js — Persistent street-light cache via Supabase.
 *
 * Cache-first lookup for lighting data. Falls back to local OSM / Overpass / OS NGD
 * on miss, then persists results for future requests.
 */

const { encode: geohashEncode } = require('./geohash');
const { fastDistance } = require('./geo');

const GEOHASH_PRECISION = 6; // ~0.61km x 0.61km
const CACHE_TTL_DAYS = 7;

// Lazy-load Supabase client to avoid crashing when env vars are missing (tests)
function getSupabase() {
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
  const supabaseServiceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!supabaseUrl || !supabaseServiceRoleKey) return null;

  const { supabase } = require('../../user/lib/supabase');
  return supabase;
}

/**
 * Query lights_cache by geohash for a fresh record.
 */
async function queryByGeohash(geohash) {
  try {
    const supabase = getSupabase();
    if (!supabase) return null;

    const { data, error } = await supabase
      .from('lights_cache')
      .select('*')
      .eq('geohash', geohash)
      .gt('expires_at', new Date().toISOString())
      .order('confidence', { ascending: false })
      .limit(1);

    if (error) {
      console.warn(`[lights-cache] Query error: ${error.message}`);
      return null;
    }
    return data?.[0] || null;
  } catch (err) {
    console.warn(`[lights-cache] Query exception: ${err.message}`);
    return null;
  }
}

/**
 * Query cache for a road segment (uses midpoint geohash).
 */
async function queryBySegment(edge, osmNodes) {
  const nA = osmNodes.get(edge.from);
  const nB = osmNodes.get(edge.to);
  if (!nA || !nB) return null;

  const midLat = (nA.lat + nB.lat) / 2;
  const midLon = (nA.lng + nB.lng) / 2;
  const geohash = geohashEncode(midLat, midLon, GEOHASH_PRECISION);
  return queryByGeohash(geohash);
}

/**
 * Query multiple geohashes at once (for route batching).
 */
async function queryByGeohashes(geohashes) {
  if (!geohashes || geohashes.length === 0) return [];

  try {
    const supabase = getSupabase();
    if (!supabase) return [];

    const { data, error } = await supabase
      .from('lights_cache')
      .select('*')
      .in('geohash', [...new Set(geohashes)])
      .gt('expires_at', new Date().toISOString());

    if (error) {
      console.warn(`[lights-cache] Batch query error: ${error.message}`);
      return [];
    }
    return data || [];
  } catch (err) {
    console.warn(`[lights-cache] Batch query exception: ${err.message}`);
    return [];
  }
}

/**
 * Increment hit counter for a cached record (best effort).
 */
async function incrementHit(id) {
  try {
    const supabase = getSupabase();
    if (!supabase) return;
    await supabase.rpc('increment_light_hit', { row_id: id });
  } catch (err) {
    // Silent fail — hit counting is not critical
  }
}

/**
 * Upsert a single normalized record into lights_cache.
 */
async function upsert(record) {
  return upsertBatch([record]);
}

/**
 * Batch upsert multiple records (more efficient).
 * Uses the Supabase RPC that mirrors the table's partial unique indexes.
 */
async function upsertBatch(records) {
  if (!records || records.length === 0) return;

  try {
    const supabase = getSupabase();
    if (!supabase) return;

    const { error } = await supabase.rpc('upsert_light_records', {
      records,
    });

    if (error) {
      console.warn(`[lights-cache] Batch upsert error: ${error.message}`);
    }
  } catch (err) {
    console.warn(`[lights-cache] Batch upsert exception: ${err.message}`);
  }
}

/**
 * Normalize OSM/OS NGD light elements into lights_cache records.
 */
function normalizeToCacheRecord(element, source, options = {}) {
  const {
    litStatus = 'unknown',
    confidence = 0.5,
    confidenceReason = '',
    lampCount = 0,
  } = options;

  const lat = element.lat;
  const lon = element.lon;
  if (lat == null || lon == null) return null;

  const geohash = geohashEncode(lat, lon, GEOHASH_PRECISION);
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const numericId = Number(element.id);

  return {
    source,
    osm_id: Number.isFinite(numericId) ? numericId : null,
    osm_type: element.type || null,
    lat,
    lon,
    geohash,
    lit_status: litStatus,
    confidence,
    confidence_reason: confidenceReason,
    lamp_count: lampCount,
    tags: element.tags || {},
    fetched_at: now,
    updated_at: now,
    expires_at: expires,
    route_hit_count: 1,
  };
}

/**
 * Normalize multiple light elements into cache records.
 */
function normalizeBatch(elements, source, defaultStatus = 'lit') {
  const records = [];
  for (const el of elements) {
    const status = el.tags?.lit === 'no' ? 'unlit'
      : el.tags?.lit === 'limited' ? 'limited'
      : defaultStatus;

    const record = normalizeToCacheRecord(el, source, {
      litStatus: status,
      confidence: status === 'lit' ? 0.8 : status === 'unlit' ? 0.9 : 0.5,
      confidenceReason: el.tags?.lit ? `explicit_${el.tags.lit}` : 'inferred',
    });
    if (record) records.push(record);
  }
  return records;
}

/**
 * Compute light score for a segment using cached data.
 * Returns { score, source, confidence, reason } or null if no cache hit.
 */
function scoreFromCache(cachedRecord) {
  if (!cachedRecord) return null;

  const status = cachedRecord.lit_status;
  const conf = cachedRecord.confidence || 0.5;

  let score;
  switch (status) {
    case 'lit':
      score = 0.7 + (conf * 0.3); // 0.70 - 1.00
      break;
    case 'limited':
      score = 0.4 + (conf * 0.2); // 0.40 - 0.60
      break;
    case 'unlit':
      score = Math.min(0.15, conf * 0.15); // 0.00 - 0.15
      break;
    case 'unknown':
    default:
      return null; // fall through to coverage map
  }

  return {
    score: Math.max(0.0, Math.min(1.0, score)),
    source: cachedRecord.source,
    confidence: conf,
    reason: cachedRecord.confidence_reason || status,
  };
}

module.exports = {
  queryByGeohash,
  queryBySegment,
  queryByGeohashes,
  incrementHit,
  upsert,
  upsertBatch,
  normalizeToCacheRecord,
  normalizeBatch,
  scoreFromCache,
  GEOHASH_PRECISION,
  CACHE_TTL_DAYS,
};
