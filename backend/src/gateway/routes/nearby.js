/**
 * routes/nearby.js — Proxy endpoint for nearby places via Overpass (OSM).
 *
 * 100% FREE — no API key needed. Uses Overpass API to find amenities,
 * shops, and leisure places with human activity.
 *
 * Rate limit: 5 requests per minute (enforced server-side).
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  validateLatitude,
  validateLongitude,
  validatePositiveNumber,
} = require('../../shared/validation/validate');

const router = express.Router();

const OVERPASS_URL = process.env.OVERPASS_API_URL || 'https://overpass-api.de/api/interpreter';

// ─── Rate limiter: 30 nearby-search requests per minute per IP ─────────
const nearbyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Nearby search rate limit exceeded — max 30 per minute.' },
});

// ─── In-memory cache ─────────────────────────────────────────────────────────
const nearbyCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_SIZE = 200;

let overpassCalls = 0;
let backendCacheHits = 0;
let totalRequests = 0;

const cacheKey = (lat, lng, radius) =>
  `${Number(lat).toFixed(3)},${Number(lng).toFixed(3)},${radius}`;

const pruneCache = () => {
  const now = Date.now();
  for (const [key, entry] of nearbyCache) {
    if (now - entry.timestamp > CACHE_TTL_MS) nearbyCache.delete(key);
  }
  if (nearbyCache.size > MAX_CACHE_SIZE) {
    const entries = [...nearbyCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    for (let i = 0; i < entries.length / 2; i++) nearbyCache.delete(entries[i][0]);
  }
};

// ─── GET /api/places/nearby ──────────────────────────────────────────────────
router.get('/', nearbyLimiter, async (req, res) => {
  try {
    const latResult = validateLatitude(req.query.lat);
    const lngResult = validateLongitude(req.query.lng);
    if (!latResult.valid) return res.status(400).json({ error: latResult.error });
    if (!lngResult.valid) return res.status(400).json({ error: lngResult.error });

    let radius = 200;
    if (req.query.radius) {
      const radiusResult = validatePositiveNumber(req.query.radius, 'radius', 500);
      if (radiusResult.valid) radius = radiusResult.value;
    }

    pruneCache();
    const ck = cacheKey(latResult.value, lngResult.value, radius);
    const cached = nearbyCache.get(ck);
    if (cached) {
      backendCacheHits++;
      totalRequests++;
      console.log(`[places/nearby] ✅ Cache HIT for ${ck} | Totals: ${totalRequests} requests, ${overpassCalls} Overpass calls, ${backendCacheHits} cache hits`);
      return res.json(cached.data);
    }

    // Build Overpass query for amenities, schools, and public places
    const around = `(around:${radius},${latResult.value},${lngResult.value})`;
    const query = `[out:json][timeout:10];(
      node["amenity"~"restaurant|cafe|bar|pub|fast_food|nightclub|cinema|theatre|pharmacy|hospital|clinic|school|university|college|library|townhall|community_centre|bank|marketplace"]${around};
      node["shop"]${around};
      node["leisure"~"fitness_centre|sports_centre|swimming_pool"]${around};
      way["amenity"~"restaurant|cafe|bar|pub|fast_food|nightclub|cinema|theatre|pharmacy|hospital|clinic|school|university|college|library|townhall|community_centre|bank|marketplace"]${around};
      way["shop"]${around};
    );out center tags qt 50;`;

    const response = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    });

    const data = await response.json();
    overpassCalls++;
    totalRequests++;
    console.log(`[places/nearby] 🌐 Overpass call #${overpassCalls} for ${ck} | ${(data.elements || []).length} elements`);

    const results = (data.elements || [])
      .map((el) => {
        const tags = el.tags || {};
        const name = tags.name || tags['name:en'] || tags.brand || '';
        if (!name) return null;

        const lat = el.lat || el.center?.lat;
        const lon = el.lon || el.center?.lon;
        if (lat == null || lon == null) return null;

        const types = [];
        if (tags.amenity) types.push(tags.amenity);
        if (tags.shop) types.push('shop', tags.shop);
        if (tags.leisure) types.push(tags.leisure);

        return {
          place_id: `osm-${el.type}-${el.id}`,
          name,
          location: { lat, lng: lon },
          types,
          open_now: true,
          business_status: 'OPERATIONAL',
        };
      })
      .filter(Boolean);

    const responsePayload = {
      status: results.length > 0 ? 'OK' : 'ZERO_RESULTS',
      results,
      count: results.length,
    };

    nearbyCache.set(ck, { data: responsePayload, timestamp: Date.now() });
    console.log(`[places/nearby] Cache MISS — stored ${ck} (${results.length} results)`);
    res.json(responsePayload);
  } catch (err) {
    console.error('[places/nearby] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
