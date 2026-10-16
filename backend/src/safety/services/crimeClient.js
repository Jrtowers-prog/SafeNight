/**
 * crimeClient.js — UK Police API client with crime-type weighting.
 *
 * ACCURACY IMPROVEMENTS:
 *   • Categorises crimes by severity (violent > property > nuisance)
 *   • Returns severity weight with each crime for distance-weighted scoring
 *   • 24-hour cache — crime data only updates monthly
 *   • Handles API limits gracefully
 */

const POLICE_API_BASE = 'https://data.police.uk/api';

const { createSafetyCacheStore } = require('./cacheStore');

// ── Crime severity weights ──────────────────────────────────────────────────
// Higher = more impact on safety score. Violent crimes matter MUCH more.
const CRIME_SEVERITY = {
  'violent-crime':          1.0,   // Most dangerous
  'robbery':                1.0,
  'sexual-offences':        1.0,
  'possession-of-weapons':  0.9,
  'public-order':           0.7,
  'criminal-damage-arson':  0.6,
  'burglary':               0.5,
  'vehicle-crime':          0.4,
  'drugs':                  0.4,
  'theft-from-the-person':  0.8,   // Direct threat to pedestrians
  'bicycle-theft':          0.3,
  'shoplifting':            0.2,
  'other-theft':            0.3,
  'anti-social-behaviour':  0.3,
  'other-crime':            0.4,
  'unknown':                0.4,
};

// ── Crime data cache (24h — data updates monthly) ───────────────────────────
const CRIME_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const crimeCacheStore = createSafetyCacheStore({
  namespace: 'crime-data',
  ttlMs: CRIME_CACHE_TTL,
  maxEntries: 30,
});
const backgroundRefreshInflight = new Map();
const liveFetchInProgress = new Set();

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return raw === '1' || String(raw).toLowerCase() === 'true';
}

const SAFE_ROUTES_ALLOW_STALE_CACHE = envFlag('SAFE_ROUTES_ALLOW_STALE_CACHE', true);
const SAFE_ROUTES_MAX_STALE_MS = envInt('SAFE_ROUTES_MAX_STALE_MS', 10 * 60 * 1000);
const CRIME_MAX_STALE_MS = envInt('SAFE_ROUTES_CRIME_MAX_STALE_MS', SAFE_ROUTES_MAX_STALE_MS);
const CRIME_STALE_FETCH_GRACE_MS = envInt('SAFE_ROUTES_CRIME_STALE_FETCH_GRACE_MS', 1200);

function crimeCacheKey(bbox) {
  const r = (v) => Math.round(v * 200) / 200; // ~550m grid
  return `crime:${r(bbox.south)},${r(bbox.west)},${r(bbox.north)},${r(bbox.east)}`;
}

function emitSourceMeta(onSourceMeta, meta) {
  if (typeof onSourceMeta !== 'function') return;
  try {
    onSourceMeta(meta);
  } catch {
    // No-op: observability callbacks should never break request flow.
  }
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve({ timedOut: true });
  }

  let timeoutHandle;
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });

  return Promise.race([
    promise
      .then((value) => ({ timedOut: false, value, error: null }))
      .catch((error) => ({ timedOut: false, value: null, error })),
    timeoutPromise,
  ]).finally(() => clearTimeout(timeoutHandle));
}

/**
 * Fetch street-level crimes within a bounding box.
 * Returns array of { lat, lng, category, severity, month }.
 */
async function fetchCrimesInBbox(bbox, options = {}) {
  const { signal = null, onSourceMeta = null } = options;
  const key = crimeCacheKey(bbox);
  const cacheEntry = await crimeCacheStore.getWithMeta(key, {
    allowStale: SAFE_ROUTES_ALLOW_STALE_CACHE,
    maxStaleMs: CRIME_MAX_STALE_MS,
  });

  if (cacheEntry && cacheEntry.stale === false) {
    console.log(`[crimeClient] 📋 Fresh cache hit (${cacheEntry.data.length} crimes, age=${cacheEntry.ageMs}ms, layer=${cacheEntry.cacheLayer})`);
    emitSourceMeta(onSourceMeta, {
      source: 'cache_fresh',
      stale: false,
      cacheAgeMs: cacheEntry.ageMs,
      cacheLayer: cacheEntry.cacheLayer,
    });
    return cacheEntry.data;
  }

  const { south, west, north, east } = bbox;
  const poly = [
    `${south},${west}`,
    `${south},${east}`,
    `${north},${east}`,
    `${north},${west}`,
  ].join(':');

  const fetchAndCacheLiveData = async (liveSignal = signal) => {
    liveFetchInProgress.add(key);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const abortFromParent = () => controller.abort();
    if (liveSignal) liveSignal.addEventListener('abort', abortFromParent, { once: true });

    try {
      const resp = await fetch(
        `${POLICE_API_BASE}/crimes-street/all-crime?poly=${poly}`,
        { signal: controller.signal },
      );

      if (resp.status === 503) {
        console.warn('[crimeClient] Police API returned 503 — skipping');
        return [];
      }
      if (!resp.ok) {
        const text = await resp.text();
        console.warn(`[crimeClient] Police API ${resp.status}: ${text.slice(0, 200)}`);
        return [];
      }

      const crimes = await resp.json();
      if (!Array.isArray(crimes)) return [];

      const result = crimes
        .filter((c) => c.location?.latitude && c.location?.longitude)
        .map((c) => {
          const category = c.category || 'unknown';
          return {
            lat: parseFloat(c.location.latitude),
            lng: parseFloat(c.location.longitude),
            category,
            severity: CRIME_SEVERITY[category] || 0.4,
            month: c.month || '',
          };
        });

      await crimeCacheStore.set(key, result);
      return result;
    } finally {
      clearTimeout(timer);
      if (liveSignal) liveSignal.removeEventListener('abort', abortFromParent);
      liveFetchInProgress.delete(key);
    }
  };

  const scheduleBackgroundRefresh = () => {
    if (liveFetchInProgress.has(key)) return;
    if (backgroundRefreshInflight.has(key)) return;

    const refreshPromise = (async () => {
      try {
        await fetchAndCacheLiveData(null);
        console.log('[crimeClient] ♻️ Background refresh completed');
      } catch (err) {
        console.warn(`[crimeClient] ⚠️ Background refresh failed: ${String(err?.message || err).slice(0, 180)}`);
      } finally {
        backgroundRefreshInflight.delete(key);
      }
    })();

    backgroundRefreshInflight.set(key, refreshPromise);
  };

  if (!cacheEntry) {
    try {
      const live = await fetchAndCacheLiveData(signal);
      emitSourceMeta(onSourceMeta, {
        source: 'live',
        stale: false,
        cacheAgeMs: null,
        cacheLayer: null,
      });
      return live;
    } catch (err) {
      if (err.name === 'AbortError') {
        if (signal?.aborted) {
          throw err;
        }
        console.warn('[crimeClient] Police API timed out');
      } else {
        console.warn('[crimeClient] Police API error:', err.message);
      }
      emitSourceMeta(onSourceMeta, {
        source: 'live_error',
        stale: false,
        cacheAgeMs: null,
        cacheLayer: null,
      });
      return [];
    }
  }

  const livePromise = fetchAndCacheLiveData(signal);
  const liveResult = await withTimeout(livePromise, CRIME_STALE_FETCH_GRACE_MS);

  if (!liveResult.timedOut && !liveResult.error) {
    emitSourceMeta(onSourceMeta, {
      source: 'live',
      stale: false,
      cacheAgeMs: null,
      cacheLayer: null,
    });
    return liveResult.value;
  }

  if (!liveResult.timedOut && liveResult.error) {
    if (liveResult.error.name === 'AbortError' && signal?.aborted) {
      throw liveResult.error;
    }

    console.warn(
      `[crimeClient] ⚠️ Live fetch failed, serving stale cache (age=${cacheEntry.ageMs}ms, layer=${cacheEntry.cacheLayer}): ${String(liveResult.error?.message || liveResult.error).slice(0, 180)}`,
    );
    scheduleBackgroundRefresh();
    emitSourceMeta(onSourceMeta, {
      source: 'cache_stale',
      stale: true,
      cacheAgeMs: cacheEntry.ageMs,
      cacheLayer: cacheEntry.cacheLayer,
      staleFallbackReason: 'live_error',
      backgroundRefreshTriggered: true,
    });
    return cacheEntry.data;
  }

  console.warn(
    `[crimeClient] 🕒 Serving stale cache after ${CRIME_STALE_FETCH_GRACE_MS}ms live wait (age=${cacheEntry.ageMs}ms, layer=${cacheEntry.cacheLayer})`,
  );
  scheduleBackgroundRefresh();
  emitSourceMeta(onSourceMeta, {
    source: 'cache_stale',
    stale: true,
    cacheAgeMs: cacheEntry.ageMs,
    cacheLayer: cacheEntry.cacheLayer,
    staleFallbackReason: 'live_slow',
    backgroundRefreshTriggered: true,
  });
  livePromise.catch((err) => {
    if (err.name === 'AbortError' && signal?.aborted) return;
    console.warn(`[crimeClient] ⚠️ Live request after stale fallback failed: ${String(err?.message || err).slice(0, 180)}`);
  });
  return cacheEntry.data;
}

function __resetForTests() {
  crimeCacheStore.clearMemory();
  backgroundRefreshInflight.clear();
  liveFetchInProgress.clear();
}

module.exports = { fetchCrimesInBbox, CRIME_SEVERITY, __resetForTests };
