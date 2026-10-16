/**
 * routes/geocode.js — Nominatim-backed geocoding endpoints.
 *
 * Endpoints:
 *   GET /api/geocode/autocomplete   — place search / forward geocoding
 *   GET /api/geocode/details        — resolve a placeId → lat/lng
 *   GET /api/geocode/reverse        — lat/lng → address
 *
 * All three use an in-process LRU-style TTL cache so repeated lookups
 * (same search query, same pin location) return instantly without
 * hitting Nominatim's 1 req/sec rate limit.
 *
 * Cache sizes (conservative memory footprint):
 *   autocomplete : 500 entries, 5 min TTL
 *   details      : 1000 entries, 60 min TTL
 *   reverse      : 1000 entries, 60 min TTL
 */

const express = require('express');
const {
  validateTextInput,
  validatePlaceId,
  validateLatitude,
  validateLongitude,
  validatePositiveNumber,
} = require('../../shared/validation/validate');

const router = express.Router();

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const OVERPASS_BASE = process.env.OVERPASS_BASE || 'https://overpass-api.de/api/interpreter';
const USER_AGENT = process.env.OSM_USER_AGENT || 'SafeNightHome/1.0 (geocode-service)';
const DEFAULT_AUTOCOMPLETE_LIMIT = 80;
const MAX_UPSTREAM_AUTOCOMPLETE_LIMIT = 120;
const CITY_BIAS_CACHE_TTL_MS = 60 * 60 * 1000;
const FREE_LOCAL_SEARCH_RADIUS_M = 8047; // 5 miles for free tier
const PAID_LOCAL_SEARCH_RADIUS_M = 16093; // 10 miles for paid tiers
const LOCAL_BUSINESS_RADIUS_M = PAID_LOCAL_SEARCH_RADIUS_M;
const OVERPASS_DEFAULT_RADIUS_M = 4500;
const OVERPASS_ENRICHMENT_ENABLED =
  process.env.OVERPASS_ENRICHMENT_ENABLED === '1' ||
  (process.env.OVERPASS_ENRICHMENT_ENABLED !== '0' && process.env.NODE_ENV !== 'test');
const BRAND_ENRICHMENT_ENABLED =
  process.env.BRAND_ENRICHMENT_ENABLED === '1' ||
  (process.env.BRAND_ENRICHMENT_ENABLED !== '0' && process.env.NODE_ENV !== 'test');

const OVERPASS_AMENITY_WHITELIST = new Set([
  'fuel',
  'charging_station',
  'parking',
  'parking_entrance',
  'restaurant',
  'fast_food',
  'cafe',
  'pub',
  'bar',
  'pharmacy',
  'hospital',
  'clinic',
  'doctors',
  'school',
  'university',
  'college',
  'library',
  'townhall',
  'community_centre',
  'bank',
  'atm',
  'post_office',
]);

const OVERPASS_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'near',
  'nearby',
  'in',
  'at',
  'to',
  'for',
  'me',
  'my',
  'station',
]);

const BRAND_EXPANSIONS = [
  {
    pattern: /\b(co[\s-]?op|coop)\b/i,
    queries: ['co-op food', 'co op food', 'coop food store', 'co-op convenience'],
  },
  {
    pattern: /\btesco\b/i,
    queries: ['tesco store', 'tesco express', 'tesco superstore', 'tesco extra'],
  },
  {
    pattern: /\bsainsbury'?s?\b/i,
    queries: ['sainsburys local', 'sainsburys supermarket'],
  },
  {
    pattern: /\basda\b/i,
    queries: ['asda superstore', 'asda express'],
  },
  {
    pattern: /\bmorrisons?\b/i,
    queries: ['morrisons daily', 'morrisons supermarket'],
  },
  {
    pattern: /\besso\b/i,
    queries: ['esso fuel station', 'esso petrol station', 'esso service station'],
  },
  {
    pattern: /\bshell\b/i,
    queries: ['shell fuel station', 'shell petrol station', 'shell service station'],
  },
  {
    pattern: /\bbp\b/i,
    queries: ['bp fuel station', 'bp petrol station', 'bp service station'],
  },
  {
    pattern: /\baldi\b/i,
    queries: ['aldi supermarket'],
  },
  {
    pattern: /\blidl\b/i,
    queries: ['lidl supermarket'],
  },
  {
    pattern: /\bwaitrose\b/i,
    queries: ['waitrose supermarket'],
  },
  {
    pattern: /\bboots\b/i,
    queries: ['boots pharmacy', 'boots store'],
  },
  {
    pattern: /\bsuperdrug\b/i,
    queries: ['superdrug pharmacy', 'superdrug store'],
  },
];

const BRAND_BOOST_CHAINS = [
  { name: 'tesco', aliases: ['tesco', 'tesco express', 'tesco extra', 'tesco superstore'] },
  { name: 'co-op', aliases: ['co op', 'co-op', 'coop', 'co op food', 'co-op food', 'coop food'] },
  { name: 'sainsburys', aliases: ['sainsbury', 'sainsburys', 'sainsbury s', 'sainsburys local'] },
  { name: 'asda', aliases: ['asda'] },
  { name: 'morrisons', aliases: ['morrisons', 'morrisons daily'] },
  { name: 'aldi', aliases: ['aldi'] },
  { name: 'lidl', aliases: ['lidl'] },
  { name: 'waitrose', aliases: ['waitrose'] },
  { name: 'marks and spencer', aliases: ['m&s', 'marks and spencer', 'm and s'] },
  { name: 'spar', aliases: ['spar'] },
  { name: 'nisa', aliases: ['nisa'] },
  { name: 'iceland', aliases: ['iceland'] },
  { name: 'one stop', aliases: ['one stop', 'onestop'] },
  { name: 'esso', aliases: ['esso'] },
  { name: 'shell', aliases: ['shell'] },
  { name: 'bp', aliases: ['bp', 'b p'] },
  { name: 'jet', aliases: ['jet'] },
  { name: 'gulf', aliases: ['gulf'] },
  { name: 'texaco', aliases: ['texaco'] },
  { name: 'applegreen', aliases: ['applegreen'] },
  { name: 'mcdonalds', aliases: ['mcdonalds', 'mcdonald', 'mcdonald'] },
  { name: 'kfc', aliases: ['kfc', 'kentucky fried chicken'] },
  { name: 'burger king', aliases: ['burger king'] },
  { name: 'subway', aliases: ['subway'] },
  { name: 'greggs', aliases: ['greggs'] },
  { name: 'starbucks', aliases: ['starbucks'] },
  { name: 'costa', aliases: ['costa', 'costa coffee'] },
  { name: 'pret', aliases: ['pret', 'pret a manger'] },
];

const FUEL_BRAND_NAMES = new Set(['esso', 'shell', 'bp', 'jet', 'gulf', 'texaco', 'applegreen']);

const CATEGORY_EXPANSIONS = [
  {
    pattern: /\b(shop|shops|store|stores|mall|shopping)\b/i,
    queries: ['shop', 'supermarket', 'convenience store'],
  },
  {
    pattern: /\b(restaurant|restaurants|food|eat|dining|takeaway|takeout|cafe|coffee|pub|bar)\b/i,
    queries: ['restaurant', 'cafe', 'takeaway', 'pub'],
  },
  {
    pattern: /\b(fuel|petrol|gas\s*station|filling\s*station|charging|ev\s*charging)\b/i,
    queries: ['fuel station', 'petrol station', 'charging station'],
  },
  {
    pattern: /\b(pharmacy|chemist|drugstore)\b/i,
    queries: ['pharmacy', 'chemist'],
  },
  {
    pattern: /\b(hospital|clinic|doctor|gp)\b/i,
    queries: ['hospital', 'clinic', 'doctor surgery'],
  },
  {
    pattern: /\b(school|schools|university|college|academy|campus)\b/i,
    queries: ['school', 'university', 'college'],
  },
  {
    pattern: /\b(public\s*place|public\s*places|community\s*centre|community\s*center|library|town\s*hall|civic)\b/i,
    queries: ['community centre', 'library', 'town hall'],
  },
  {
    pattern: /\b(bank|atm|cash\s*machine)\b/i,
    queries: ['bank', 'atm'],
  },
  {
    pattern: /\b(hotel|lodging|accommodation)\b/i,
    queries: ['hotel', 'guest house'],
  },
];

// ─── Simple TTL cache ────────────────────────────────────────────────────────

function makeTTLCache(maxSize, ttlMs) {
  const store = new Map();

  function get(key) {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.ts > ttlMs) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function set(key, value) {
    // Evict oldest if at capacity
    if (store.size >= maxSize) {
      store.delete(store.keys().next().value);
    }
    store.set(key, { value, ts: Date.now() });
  }

  return { get, set };
}

const autocompleteCache = makeTTLCache(500, 5 * 60 * 1000);   // 5 min
const detailsCache      = makeTTLCache(1000, 60 * 60 * 1000); // 60 min
const reverseCache      = makeTTLCache(1000, 60 * 60 * 1000); // 60 min
const cityBiasCache     = makeTTLCache(1000, CITY_BIAS_CACHE_TTL_MS);

// ─── Nominatim rate limiter (≥ 300 ms between calls) ────────────────────────

let lastNominatimCall = 0;
const nominatimThrottle = async () => {
  if (process.env.NODE_ENV === 'test') {
    return;
  }
  const elapsed = Date.now() - lastNominatimCall;
  if (elapsed < 300) {
    await new Promise((r) => setTimeout(r, 300 - elapsed));
  }
  lastNominatimCall = Date.now();
};

// API call counters (diagnostic only)
const calls = { autocomplete: 0, details: 0, reverse: 0 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Detect whether the input looks like a UK street address
 * (starts with a house number, e.g. "431 Eggbuckland Road").
 */
function looksLikeAddress(input) {
  return parseAddressQuery(input) !== null;
}

function parseAddressQuery(input) {
  const q = String(input || '').trim();
  if (!q) return null;

  // Accept both "431 Eggbuckland Road" and "431, Eggbuckland Road" forms.
  const match = q.match(/^(\d+[a-z]?)\s*,?\s+(.+)$/i);
  if (!match) return null;

  const houseNumber = String(match[1] || '').trim();
  const street = String(match[2] || '').replace(/\s+/g, ' ').trim();
  if (!houseNumber || !street) return null;

  return { houseNumber, street };
}

function normalizeAddressToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}

function roadMatchesAddressQuery(candidateRoad, queryStreet) {
  const road = normalizeTextForBrand(candidateRoad);
  const query = normalizeTextForBrand(queryStreet);
  if (!road || !query) return false;
  if (road.includes(query) || query.includes(road)) return true;

  const queryTokens = tokenize(query).filter((token) => token.length > 2);
  if (queryTokens.length === 0) return false;
  return queryTokens.every((token) => road.includes(token));
}

function resultMatchesExactAddress(r, addressQuery) {
  if (!addressQuery) return false;

  const addr = r.address || {};
  const queryHouse = normalizeAddressToken(addressQuery.houseNumber);
  const resultHouse = normalizeAddressToken(addr.house_number);
  if (!queryHouse || !resultHouse || queryHouse !== resultHouse) return false;

  const queryStreet = addressQuery.street;
  const road = addr.road || '';
  if (roadMatchesAddressQuery(road, queryStreet)) return true;

  // Fallback: match against display text when road field is sparse.
  return roadMatchesAddressQuery(r.display_name || '', queryStreet);
}

function getNormalizedRoadForAddressResult(r) {
  const addr = r.address || {};
  return String(addr.road || r.display_name || '');
}

function resultMatchesStreetAddress(r, addressQuery) {
  if (!addressQuery) return false;
  const road = getNormalizedRoadForAddressResult(r);
  return roadMatchesAddressQuery(road, addressQuery.street);
}

function resultHasHouseNumber(r) {
  const addr = r.address || {};
  return Boolean(normalizeAddressToken(addr.house_number));
}

function isAddressResult(r) {
  const addr = r.address || {};
  if (resultHasHouseNumber(r) && addr.road) return true;

  // Fallback for sparse address payloads where display_name starts with a door number.
  return /^\s*\d+[a-z]?\b/i.test(String(r.display_name || ''));
}

function parseHouseNumberNumeric(value) {
  const token = String(value || '').trim().match(/^(\d+)/);
  return token ? Number(token[1]) : null;
}

function predictionClassificationForResult(r) {
  if (isAddressResult(r)) {
    return { category: 'address', placeType: 'address' };
  }
  return {
    category: r.class || null,
    placeType: r.type || null,
  };
}

function looksLikeParkingQuery(input) {
  return /\b(parking|car\s*park|garage|park\s*&\s*ride|park and ride|multi[-\s]?storey)\b/i.test(
    input.trim()
  );
}

function looksLikeBusinessQuery(input) {
  const q = String(input || '').trim();
  if (!q) return false;
  if (looksLikeAddress(q) || looksLikeSpecificPostcode(q)) return false;

  // Branded POI queries are usually short and rarely include numbers.
  const tokens = tokenize(q);
  if (tokens.length > 6) return false;
  if (/\d/.test(q)) return false;
  return true;
}

function getCategoryQueryExpansions(input) {
  const q = String(input || '').trim();
  if (!q) return [];

  const normalized = q.toLowerCase();
  const expanded = new Set();

  for (const bucket of CATEGORY_EXPANSIONS) {
    if (!bucket.pattern.test(q)) continue;
    for (const term of bucket.queries) {
      if (term.toLowerCase() === normalized) continue;
      expanded.add(term);
    }
  }

  // Keep query fan-out conservative for latency.
  return Array.from(expanded).slice(0, 4);
}

function getBrandQueryExpansions(input) {
  const q = String(input || '').trim();
  if (!q) return [];

  const normalized = q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const expanded = new Set();

  for (const bucket of BRAND_EXPANSIONS) {
    if (!bucket.pattern.test(q)) continue;
    for (const term of bucket.queries) {
      const termNorm = String(term).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (termNorm === normalized) continue;
      expanded.add(term);
    }
  }

  // Keep fan-out conservative.
  return Array.from(expanded).slice(0, 4);
}

function normalizeTextForBrand(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function paddedIncludesAlias(normalizedText, alias) {
  const a = normalizeTextForBrand(alias);
  if (!a) return false;
  const padded = ` ${normalizedText} `;
  return padded.includes(` ${a} `);
}

function getBrandBoostContext(input) {
  const normalizedInput = normalizeTextForBrand(input);
  if (!normalizedInput) {
    return { explicitBrandQuery: false, chains: [] };
  }

  const tokens = tokenize(normalizedInput);
  const chains = BRAND_BOOST_CHAINS.filter((chain) =>
    chain.aliases.some((alias) => paddedIncludesAlias(normalizedInput, alias))
  );

  return {
    explicitBrandQuery: chains.length > 0 && tokens.length <= 4,
    chains,
  };
}

function normalizeSubscriptionTier(rawTier) {
  const tier = String(rawTier || '').trim().toLowerCase();
  if (!tier || tier === 'free') return 'free';
  if (['pro', 'premium', 'paid', 'plus', 'team', 'enterprise'].includes(tier)) {
    return 'paid';
  }
  return 'paid';
}

function getTierRadiusCapMeters(tier) {
  return tier === 'free' ? FREE_LOCAL_SEARCH_RADIUS_M : PAID_LOCAL_SEARCH_RADIUS_M;
}

function resolveAutocompleteRadiusMeters(radiusRaw, tier) {
  const cap = getTierRadiusCapMeters(tier);
  if (radiusRaw == null || radiusRaw === '') return cap;

  const parsed = Number(radiusRaw);
  if (!Number.isFinite(parsed) || parsed <= 0) return cap;

  return Math.min(Math.floor(parsed), cap);
}

function isFuelLikeQuery(input) {
  return /\b(fuel|petrol|gas\s*station|filling\s*station|charging|ev\s*charging)\b/i.test(
    String(input || '').trim()
  );
}

function shouldKeepOverpassPOI(element, input, context) {
  const tags = element?.tags || {};
  const amenity = String(tags.amenity || '').toLowerCase();
  const shop = String(tags.shop || '').toLowerCase();
  const tourism = String(tags.tourism || '').toLowerCase();
  const leisure = String(tags.leisure || '').toLowerCase();

  if (!amenity && !shop && !tourism && !leisure) return false;
  if (amenity && !OVERPASS_AMENITY_WHITELIST.has(amenity)) {
    // Keep unknown amenities only when they strongly match the query text.
    const fallback = `${tags.name || ''} ${tags.brand || ''} ${tags.operator || ''} ${amenity}`.toLowerCase();
    if (!tokenize(input).some((t) => t.length > 2 && fallback.includes(t))) {
      return false;
    }
  }

  const searchable = `${
    tags.name || ''
  } ${tags.brand || ''} ${tags.operator || ''} ${amenity} ${shop} ${tourism} ${leisure}`.toLowerCase();

  const queryTokens = tokenize(input).filter(
    (token) => token.length > 2 && !OVERPASS_STOPWORDS.has(token)
  );

  if (context.fuelLike) {
    const isFuelCategory = amenity === 'fuel' || amenity === 'charging_station';
    if (!isFuelCategory) return false;
    if (queryTokens.length === 0) return true;
    return queryTokens.some((token) => searchable.includes(token));
  }

  if (queryTokens.length === 0) return true;

  const tokenHit = queryTokens.some((token) => searchable.includes(token));
  if (tokenHit) return true;

  if (context.parkingLike && amenity.includes('parking')) return true;
  if (context.fuelLike && (amenity === 'fuel' || amenity === 'charging_station')) return true;

  if (context.categoryLike) {
    if (/(restaurant|cafe|takeaway|pub|bar)/.test(input) && /(restaurant|cafe|fast_food|pub|bar)/.test(`${amenity} ${shop}`)) {
      return true;
    }
    if (/(shop|store|mall|shopping|supermarket|convenience)/.test(input) && Boolean(shop)) {
      return true;
    }
    if (/(pharmacy|chemist|drugstore)/.test(input) && /pharmacy/.test(`${amenity} ${shop}`)) {
      return true;
    }
  }

  return false;
}

async function overpassSearchNearby(locationBias, input, context) {
  if (!locationBias) return [];
  try {
    const radiusCap = Number.isFinite(context.searchRadiusMeters)
      ? context.searchRadiusMeters
      : LOCAL_BUSINESS_RADIUS_M;
    const radius = Math.min(
      radiusCap,
      context.fuelLike || context.parkingLike
        ? radiusCap
        : Math.max(OVERPASS_DEFAULT_RADIUS_M, Math.floor(radiusCap * 0.75))
    );

    const query = `[out:json][timeout:18];
(
  nwr(around:${radius},${locationBias.lat},${locationBias.lng})["amenity"];
  nwr(around:${radius},${locationBias.lat},${locationBias.lng})["shop"];
  nwr(around:${radius},${locationBias.lat},${locationBias.lng})["tourism"];
);
out center tags;`;

    await nominatimThrottle();
    calls.autocomplete++;
    console.log('[geocode/autocomplete] 🌐 Overpass enrichment call');
    const response = await fetch(OVERPASS_BASE, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'text/plain;charset=UTF-8',
      },
      body: query,
    });
  
    const data = await parseUpstreamJsonOrNull(response, 'Overpass');
    if (!data) return [];
    const elements = Array.isArray(data?.elements) ? data.elements : [];

    return elements
      .filter((element) => shouldKeepOverpassPOI(element, input, context))
      .map((element) => {
        const tags = element.tags || {};
        const lat = safeNumber(element.lat ?? element.center?.lat);
        const lon = safeNumber(element.lon ?? element.center?.lon);
        if (lat == null || lon == null) return null;

        const placeName = String(tags.name || tags.brand || tags.operator || '').trim();
        const className = tags.shop ? 'shop' : tags.amenity ? 'amenity' : tags.tourism ? 'tourism' : 'place';
        const typeName = tags.shop || tags.amenity || tags.tourism || 'poi';

        const display = [
          placeName || typeName,
          tags['addr:street'],
          tags['addr:city'] || tags['addr:town'] || tags['addr:village'],
          tags['addr:postcode'],
        ]
          .filter(Boolean)
          .join(', ');

        return {
          osm_type: element.type || 'node',
          osm_id: element.id,
          class: className,
          type: String(typeName),
          lat: String(lat),
          lon: String(lon),
          display_name: display || placeName || typeName,
          name: placeName || typeName,
          importance: 0.25,
          address: {
            road: tags['addr:street'] || null,
            city: tags['addr:city'] || tags['addr:town'] || tags['addr:village'] || null,
            postcode: tags['addr:postcode'] || null,
            country: tags['addr:country'] || null,
            amenity: tags.amenity || null,
            shop: tags.shop || null,
          },
        };
      })
      .filter(Boolean);
  } catch (error) {
    console.log(`[geocode/autocomplete] ⚠️ Overpass enrichment failed: ${error?.message || error}`);
    return [];
  }
}

// Treat fully-formed UK postcodes as explicit cross-city intent.
function looksLikeSpecificPostcode(input) {
  const q = String(input || '').trim();
  return /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(q);
}

function parseAutocompleteLimit(limitRaw) {
  if (limitRaw == null || limitRaw === '') {
    return { valid: true, value: null };
  }

  const normalized = String(limitRaw).trim();
  if (!/^\d+$/.test(normalized)) {
    return { valid: false, error: `Invalid limit: ${limitRaw}` };
  }

  const validated = validatePositiveNumber(Number(normalized), 'limit');
  if (!validated.valid) return validated;

  return { valid: true, value: Math.floor(validated.value) };
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function distanceMeters(a, b) {
  const earthRadius = 6371000;
  const latDelta = toRadians(b.lat - a.lat);
  const lngDelta = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(latDelta / 2) * Math.sin(latDelta / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(lngDelta / 2) * Math.sin(lngDelta / 2);
  return 2 * earthRadius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function tokenize(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function parseUpstreamJsonOrNull(response, sourceLabel) {
  if (!response) {
    console.log(`[geocode/autocomplete] ⚠️ ${sourceLabel} returned no response`);
    return null;
  }

  const status = Number.isFinite(response.status) ? response.status : 'unknown';
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();

  if (response.ok === false) {
    console.log(`[geocode/autocomplete] ⚠️ ${sourceLabel} returned ${status}`);
    return null;
  }

  let body = '';
  let hasTextBody = false;
  if (typeof response.text === 'function') {
    try {
      body = await response.text();
      hasTextBody = true;
    } catch {
      body = '';
    }
  }

  if (hasTextBody && (!body || !body.trim())) return null;

  if (!hasTextBody && typeof response.json === 'function') {
    const looksJson = contentType.includes('application/json') || contentType.includes('json');
    if (!looksJson && contentType) {
      console.log(
        `[geocode/autocomplete] ⚠️ ${sourceLabel} returned non-JSON payload (status ${status}, content-type: ${contentType || 'unknown'})`
      );
      return null;
    }

    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  if (!body || !body.trim()) return null;

  const trimmed = body.trim();
  const looksJson =
    contentType.includes('application/json') ||
    contentType.includes('json') ||
    trimmed.startsWith('{') ||
    trimmed.startsWith('[');

  if (!looksJson) {
    console.log(
      `[geocode/autocomplete] ⚠️ ${sourceLabel} returned non-JSON payload (status ${status}, content-type: ${contentType || 'unknown'})`
    );
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    console.log(
      `[geocode/autocomplete] ⚠️ ${sourceLabel} returned invalid JSON (status ${status}, content-type: ${contentType || 'unknown'})`
    );
    return null;
  }
}

function normalizeLocalityName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^city\s+of\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLocalityFromAddress(address = {}) {
  return (
    address.city ||
    address.town ||
    address.village ||
    address.municipality ||
    address.city_district ||
    null
  );
}

async function resolveBiasLocality(locationBias) {
  if (!locationBias) return null;

  const cacheKey = `${locationBias.lat.toFixed(4)},${locationBias.lng.toFixed(4)}`;
  const cached = cityBiasCache.get(cacheKey);
  if (cached !== undefined) return cached;

  await nominatimThrottle();
  calls.reverse++;
  const url = `${NOMINATIM_BASE}/reverse?format=jsonv2&lat=${locationBias.lat}&lon=${locationBias.lng}&addressdetails=1`;
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  const data = await parseUpstreamJsonOrNull(response, 'Nominatim reverse');
  const locality = normalizeLocalityName(extractLocalityFromAddress(data?.address || {}));
  const resolved = locality || null;
  cityBiasCache.set(cacheKey, resolved);
  return resolved;
}

function filterResultsToLocality(results, localityToken) {
  if (!localityToken) return results;
  return results.filter((r) => {
    const addr = r.address || {};
    const locality = normalizeLocalityName(extractLocalityFromAddress(addr));
    if (locality && locality === localityToken) return true;

    const county = normalizeLocalityName(addr.county || '');
    if (county && county === localityToken) return true;

    const display = normalizeLocalityName(r.display_name || '');
    if (display && display.includes(localityToken)) return true;

    return false;
  });
}

function filterResultsWithinRadius(results, locationBias, radiusMeters) {
  if (!locationBias || !Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    return results;
  }

  return results.filter((r) => {
    const lat = safeNumber(r.lat);
    const lng = safeNumber(r.lon);
    if (lat == null || lng == null) return false;
    return distanceMeters(locationBias, { lat, lng }) <= radiusMeters;
  });
}

/**
 * Build a human-friendly primary label from a Nominatim address object.
 * Prioritises: house_number + road  →  amenity/shop/tourism name → display_name[0]
 */
function buildMainText(r) {
  const addr = r.address || {};

  // Named place (amenity, shop, pub, university, etc.)
  const placeName =
    addr.amenity || addr.shop || addr.tourism || addr.leisure ||
    addr.office || addr.building || addr.university ||
    addr.college || addr.school || addr.hospital || addr.hotel;

  // House-number address
  if (addr.house_number && addr.road) {
    const base = `${addr.house_number} ${addr.road}`;
    return placeName ? `${placeName}, ${base}` : base;
  }

  // Named place without a specific number
  if (placeName) return placeName;

  // Road only
  if (addr.road) return addr.road;

  // Fall back to name field or first part of display_name
  return r.name || r.display_name.split(',')[0];
}

/**
 * Build a short secondary label: neighbourhood / suburb / town / city + postcode.
 */
function buildSecondaryText(r) {
  const addr = r.address || {};
  const parts = [
    addr.neighbourhood || addr.suburb || addr.quarter,
    addr.town || addr.village || addr.city || addr.county,
    addr.postcode,
  ].filter(Boolean);
  return parts.join(', ') || r.display_name.split(',').slice(1, 4).join(',').trim();
}

/**
 * Deduplicate Nominatim results by osm_id, then sort: results that contain
 * the query text in their name/road rank higher than generic address hits.
 */
function dedupeAndRank(results, input, context) {
  const seen = new Set();
  const unique = [];
  for (const r of results) {
    const key = `${r.osm_type}-${r.osm_id}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(r);
    }
  }
  const lc = input.toLowerCase();
  const tokens = tokenize(input);

  const scored = unique.map((r) => {
    const text = `${r.display_name || ''} ${(r.name || '')}`.toLowerCase();
    const addr = r.address || {};
    const classification = `${r.class || ''} ${r.type || ''}`.toLowerCase();
    const normalizedText = normalizeTextForBrand(
      `${r.display_name || ''} ${r.name || ''} ${addr.brand || ''} ${addr.shop || ''} ${addr.amenity || ''}`
    );

    let score = parseFloat(r.importance || 0) * 2;

    if (text === lc) score += 6;
    else if (text.startsWith(lc)) score += 4;
    else if (text.includes(lc)) score += 2;

    const matchingTokens = tokens.filter((token) => token.length > 2 && text.includes(token)).length;
    if (tokens.length > 0) {
      score += (matchingTokens / tokens.length) * 2.5;
    }

    if (context.addressLike && addr.house_number && addr.road) {
      score += 3;
    }

    if (context.addressQuery) {
      const queryHouse = normalizeAddressToken(context.addressQuery.houseNumber);
      const resultHouse = normalizeAddressToken(addr.house_number);
      const hasRoadMatch = roadMatchesAddressQuery(
        addr.road || r.display_name || '',
        context.addressQuery.street
      );

      if (resultHouse && queryHouse === resultHouse) {
        score += hasRoadMatch ? 12 : 6;
      } else if (hasRoadMatch && !resultHouse) {
        // De-prioritize road-level pins when user asked for a specific door number.
        score -= 4;
      } else if (hasRoadMatch) {
        score -= 2;
      }

      // Prefer nearby house numbers on the same road when exact number is unavailable.
      if (hasRoadMatch && resultHouse && queryHouse !== resultHouse) {
        const queryNumeric = parseHouseNumberNumeric(queryHouse);
        const resultNumeric = parseHouseNumberNumeric(resultHouse);
        if (queryNumeric != null && resultNumeric != null) {
          const diff = Math.abs(queryNumeric - resultNumeric);
          score += Math.max(0, 4 - diff / 25);
        }
      }
    }

    if (
      context.parkingLike &&
      (/parking|car park/.test(text) || /parking/.test(classification) || /parking/.test(`${addr.amenity || ''}`.toLowerCase()))
    ) {
      score += 4;
    }

    if (context.fuelLike) {
      if (/\bfuel\b/.test(classification)) score += 4;
      else if (/charging_station/.test(classification)) score += 2;
      else score -= 1;
    }

    if (context.brandBoost?.explicitBrandQuery && context.brandBoost.chains.length > 0) {
      let chainHits = 0;
      const fuelBrandQuery = context.brandBoost.chains.some((chain) => FUEL_BRAND_NAMES.has(chain.name));
      const isFuelResult = /\bfuel\b/.test(classification) || /charging_station/.test(classification);
      for (const chain of context.brandBoost.chains) {
        const hit = chain.aliases.some((alias) => paddedIncludesAlias(normalizedText, alias));
        if (!hit) continue;

        chainHits += 1;
        score += 7;

        if (/shop|supermarket|convenience|retail/.test(classification)) {
          score += 1.5;
        }

        if (FUEL_BRAND_NAMES.has(chain.name) && /\bfuel\b/.test(classification)) {
          score += 3;
        }
      }

      if (fuelBrandQuery) {
        if (isFuelResult) score += 4;
        else score -= 4;
      }

      if (chainHits === 0) {
        score -= 1.5;
      }
    }

    if (context.locationBias) {
      const lat = safeNumber(r.lat);
      const lng = safeNumber(r.lon);
      if (lat != null && lng != null) {
        const meters = distanceMeters(context.locationBias, { lat, lng });
        if (meters <= 1000) score += 3;
        else if (meters <= 3000) score += 2;
        else if (meters <= 8000) score += 1;
        else if (meters > 20000) score -= 0.5;
      }
    }

    return { r, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;

    const aLat = safeNumber(a.r.lat);
    const aLng = safeNumber(a.r.lon);
    const bLat = safeNumber(b.r.lat);
    const bLng = safeNumber(b.r.lon);
    if (context.locationBias && aLat != null && aLng != null && bLat != null && bLng != null) {
      const aDistance = distanceMeters(context.locationBias, { lat: aLat, lng: aLng });
      const bDistance = distanceMeters(context.locationBias, { lat: bLat, lng: bLng });
      if (aDistance !== bDistance) return aDistance - bDistance;
    }

    return parseFloat(b.r.importance || 0) - parseFloat(a.r.importance || 0);
  });

  return scored.map((entry) => entry.r);
}

/**
 * Fire a single Nominatim search and return the raw JSON array.
 * Applies the shared rate limiter before each call.
 */
async function nominatimSearch(params) {
  await nominatimThrottle();
  calls.autocomplete++;
  const url = `${NOMINATIM_BASE}/search?${new URLSearchParams(params).toString()}`;
  console.log(`[geocode/autocomplete] 🌐 Nominatim call #${calls.autocomplete} → ${url.replace(NOMINATIM_BASE, '')}`);
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  const data = await parseUpstreamJsonOrNull(response, 'Nominatim');
  return Array.isArray(data) ? data : [];
}

// ─── GET /api/geocode/autocomplete ────────────────────────────────────────────
// Query: input, lat?, lng?, radius?
router.get('/autocomplete', async (req, res) => {
  try {
    const inputResult = validateTextInput(req.query.input);
    if (!inputResult.valid) return res.status(400).json({ error: inputResult.error });

    const input = inputResult.value;
    const subscriptionTier = normalizeSubscriptionTier(
      req.query.subscription_tier || req.query.subscriptionTier || req.query.tier
    );
    const localSearchRadiusMeters = resolveAutocompleteRadiusMeters(
      req.query.radius,
      subscriptionTier
    );
    const limitResult = parseAutocompleteLimit(req.query.limit);
    if (!limitResult.valid) return res.status(400).json({ error: limitResult.error });
    const requestedLimit = limitResult.value;
    const effectiveLimit = requestedLimit ?? DEFAULT_AUTOCOMPLETE_LIMIT;

    // Location bias viewbox
    let viewbox = null;
    let locationBias = null;
    if (req.query.lat && req.query.lng) {
      const latR = validateLatitude(req.query.lat);
      const lngR = validateLongitude(req.query.lng);
      if (!latR.valid) return res.status(400).json({ error: latR.error });
      if (!lngR.valid) return res.status(400).json({ error: lngR.error });
      locationBias = { lat: latR.value, lng: lngR.value };
      // Keep the bbox aligned with subscription search radius policy.
      const offset = Math.max(
        0.05,
        Math.min(0.22, localSearchRadiusMeters / 111000 + 0.02)
      );
      viewbox = `${lngR.value - offset},${latR.value + offset},${lngR.value + offset},${latR.value - offset}`;
    }

    const hasSpecificPostcode = looksLikeSpecificPostcode(input);
    const businessLike = looksLikeBusinessQuery(input);
    const parkingLike = looksLikeParkingQuery(input);
    const fuelLike = isFuelLikeQuery(input);
    const categoryExpansions = getCategoryQueryExpansions(input);
    const categoryLike = categoryExpansions.length > 0;
    const brandBoost = getBrandBoostContext(input);
    const brandExpansions = BRAND_ENRICHMENT_ENABLED
      ? getBrandQueryExpansions(input)
      : [];
    const brandLike = brandExpansions.length > 0 || brandBoost.explicitBrandQuery;
    const enforceCityScope = Boolean(locationBias) && !hasSpecificPostcode;
    const forceLocalBounds =
      Boolean(locationBias) &&
      !hasSpecificPostcode &&
      (businessLike || parkingLike || categoryLike || fuelLike || brandLike);
    const cityScopeToken = enforceCityScope
      ? await resolveBiasLocality(locationBias)
      : null;

    const cacheKey = `${input}|${viewbox ?? ''}|${requestedLimit ?? 'all'}|${cityScopeToken ?? ''}|${hasSpecificPostcode ? 'pc' : 'nopc'}|${forceLocalBounds ? 'bounded' : 'unbounded'}|${subscriptionTier}|${localSearchRadiusMeters}`;
    const cached = autocompleteCache.get(cacheKey);
    if (cached) {
      console.log(`[geocode/autocomplete] 💾 Cache hit → "${input.substring(0, 30)}"`);
      return res.json(cached);
    }

    // ── Build query list ────────────────────────────────────────────────────
    // We always run a free-text search. For address-style queries we ALSO run
    // a structured search (housenumber + street) which finds door numbers
    // that plain free-text often misses.

    const upstreamLimit = Math.min(
      Math.max(effectiveLimit * 3, DEFAULT_AUTOCOMPLETE_LIMIT),
      MAX_UPSTREAM_AUTOCOMPLETE_LIMIT
    );
    const addressLike = looksLikeAddress(input);
    const addressQuery = parseAddressQuery(input);

    const baseParams = {
      format: 'json',
      addressdetails: '1',
      limit: String(upstreamLimit),
      countrycodes: 'gb',       // UK-focused; remove if you need global
      'accept-language': 'en',
    };
    if (viewbox) {
      baseParams.viewbox = viewbox;
      baseParams.bounded = forceLocalBounds ? '1' : '0';
    }

    const searches = [
      // 1. Free-text search — finds named places ("Plymouth University"),
      //    roads, postcodes, and partial addresses
      nominatimSearch({ ...baseParams, q: input }),
    ];

    const shouldUseOverpassEnrichment =
      OVERPASS_ENRICHMENT_ENABLED &&
      Boolean(locationBias) &&
      (businessLike || parkingLike || categoryLike || fuelLike || brandLike);

    if (addressLike) {
      // 2. Structured address search — split "431 Eggbuckland Road" into
      //    housenumber=431  street=Eggbuckland Road  for precise door-level hits
      const houseNumber = addressQuery?.houseNumber;
      const street = addressQuery?.street;
      if (houseNumber && street) {
      searches.push(
        nominatimSearch({ ...baseParams, housenumber: houseNumber, street, limit: String(Math.max(effectiveLimit + 2, 10)) })
      );
      }
    }

    if (parkingLike) {
      searches.push(
        nominatimSearch({
          ...baseParams,
          q: `${input} car park`,
          limit: String(Math.max(effectiveLimit + 2, 10)),
        })
      );
    }

    for (const categoryQ of categoryExpansions) {
      searches.push(
        nominatimSearch({
          ...baseParams,
          q: categoryQ,
          limit: String(Math.max(effectiveLimit + 4, 12)),
        })
      );
    }

    if (brandLike) {
      for (const brandQ of brandExpansions) {
        searches.push(
          nominatimSearch({
            ...baseParams,
            q: brandQ,
            limit: String(Math.max(effectiveLimit + 6, 14)),
          })
        );
      }
    }

    if (shouldUseOverpassEnrichment) {
      searches.push(
        overpassSearchNearby(locationBias, input, {
          businessLike,
          parkingLike,
          categoryLike,
          fuelLike,
          searchRadiusMeters: localSearchRadiusMeters,
        })
      );
    }

    // Run all queries in parallel (rate limiter serialises them internally)
    const rawArrays = await Promise.all(searches);
    const ranked = dedupeAndRank(rawArrays.flat(), input, {
      locationBias,
      parkingLike,
      fuelLike,
      addressLike,
      addressQuery,
      brandBoost,
    });
    const scoped = enforceCityScope
      ? filterResultsToLocality(ranked, cityScopeToken)
      : ranked;

    let mergedBase = scoped;

    if (addressQuery && mergedBase.length > 0) {
      const exactAddressMatches = mergedBase.filter((r) =>
        resultMatchesExactAddress(r, addressQuery)
      );
      const numberedStreetMatches = mergedBase.filter(
        (r) => resultMatchesStreetAddress(r, addressQuery) && resultHasHouseNumber(r)
      );
      const streetOnlyMatches = mergedBase.filter((r) => resultMatchesStreetAddress(r, addressQuery));

      if (exactAddressMatches.length > 0) {
        mergedBase = exactAddressMatches;
        console.log('[geocode/autocomplete] 🏠 Exact address filter enabled');
      } else if (numberedStreetMatches.length > 0) {
        mergedBase = numberedStreetMatches;
        console.log('[geocode/autocomplete] 🏠 Numbered-address fallback enabled');
      } else if (streetOnlyMatches.length > 0) {
        // Keep same-street candidates only, and avoid business/POI entries.
        mergedBase = streetOnlyMatches.filter((r) => !['amenity', 'shop', 'tourism', 'leisure'].includes(String(r.class || '').toLowerCase()));
        if (mergedBase.length === 0) {
          mergedBase = streetOnlyMatches;
        }
        console.log('[geocode/autocomplete] 🏠 Street-address fallback enabled');
      }
    }

    if (enforceCityScope && !cityScopeToken && locationBias && (businessLike || parkingLike || fuelLike || brandLike)) {
      const nearby = filterResultsWithinRadius(
        ranked,
        locationBias,
        localSearchRadiusMeters
      );
      if (nearby.length > 0) {
        mergedBase = nearby;
        console.log('[geocode/autocomplete] 📍 Nearby-radius fallback enabled for brand/business/category/fuel query');
      }
    }

    if (
      enforceCityScope &&
      mergedBase.length === 0 &&
      ranked.length > 0 &&
      (businessLike || parkingLike || categoryLike || fuelLike || brandLike)
    ) {
      // Avoid dead-end ZERO_RESULTS for common POI/brand searches where locality metadata is sparse.
      mergedBase = ranked;
      console.log('[geocode/autocomplete] ↩️ Locality fallback enabled for brand/business/category/fuel query');
    }

    const merged = requestedLimit == null
      ? mergedBase
      : mergedBase.slice(0, requestedLimit);

    const predictions = merged.map((r) => {
      const classification = predictionClassificationForResult(r);
      return ({
      place_id: `osm-${r.osm_type}-${r.osm_id}`,
      description: r.display_name,
      category: classification.category,
      place_type: classification.placeType,
      structured_formatting: {
        main_text: buildMainText(r),
        secondary_text: buildSecondaryText(r),
      },
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      address: {
        house_number: r.address?.house_number || null,
        road: r.address?.road || null,
        neighbourhood: r.address?.neighbourhood || r.address?.suburb || null,
        city: r.address?.city || r.address?.town || r.address?.village || null,
        county: r.address?.county || null,
        postcode: r.address?.postcode || null,
        country: r.address?.country || null,
      },
    });
    });

    const payload = {
      status: predictions.length > 0 ? 'OK' : 'ZERO_RESULTS',
      predictions,
    };

    if (predictions.length === 0 && (businessLike || parkingLike || categoryLike)) {
      console.log('[geocode/autocomplete] 🚫 Skip caching ZERO_RESULTS for business/category/parking query');
    } else {
      autocompleteCache.set(cacheKey, payload);
    }
    console.log(`[geocode/autocomplete] 📦 ${predictions.length} results (cached)`);
    res.json(payload);
  } catch (err) {
    console.error('[geocode/autocomplete] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/geocode/details ─────────────────────────────────────────────────
// Query: place_id (format: osm-<type>-<id>)
router.get('/details', async (req, res) => {
  try {
    const placeIdResult = validatePlaceId(req.query.place_id);
    if (!placeIdResult.valid) return res.status(400).json({ error: placeIdResult.error });

    const placeId = placeIdResult.value;
    const cached = detailsCache.get(placeId);
    if (cached) {
      console.log(`[geocode/details] 💾 Cache hit → "${placeId}"`);
      return res.json(cached);
    }

    const osmMatch = placeId.match(/^osm-(node|way|relation)-(\d+)$/);
    let url;
    if (osmMatch) {
      const [, osmType, osmId] = osmMatch;
      const typeChar = osmType === 'node' ? 'N' : osmType === 'way' ? 'W' : 'R';
      url = `${NOMINATIM_BASE}/lookup?format=json&osm_ids=${typeChar}${osmId}&addressdetails=1`;
    } else {
      url = `${NOMINATIM_BASE}/search?format=json&q=${encodeURIComponent(placeId)}&limit=1&addressdetails=1`;
    }

    await nominatimThrottle();
    calls.details++;
    console.log(`[geocode/details] 🌐 Nominatim call #${calls.details} → "${placeId}"`);

    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    const data = await parseUpstreamJsonOrNull(response, 'Nominatim details');
    const result = Array.isArray(data) ? data[0] : data;

    if (!result || !result.lat || !result.lon) {
      return res.json({ status: 'NOT_FOUND', result: null });
    }

    const payload = {
      status: 'OK',
      result: {
        place_id: placeId,
        name: result.name || result.display_name?.split(',')[0] || '',
        geometry: {
          location: {
            lat: parseFloat(result.lat),
            lng: parseFloat(result.lon),
          },
        },
      },
    };

    detailsCache.set(placeId, payload);
    console.log(`[geocode/details] 📦 Found "${payload.result.name}" (cached)`);
    res.json(payload);
  } catch (err) {
    console.error('[geocode/details] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/geocode/reverse ─────────────────────────────────────────────────
// Query: lat, lng
// Converts a map pin (lat/lng) into a human-readable address.
router.get('/reverse', async (req, res) => {
  try {
    const latResult = validateLatitude(req.query.lat);
    const lngResult = validateLongitude(req.query.lng);
    if (!latResult.valid) return res.status(400).json({ error: latResult.error });
    if (!lngResult.valid) return res.status(400).json({ error: lngResult.error });

    const lat = latResult.value;
    const lng = lngResult.value;

    // Round to ~11 m precision to improve cache hit ratio
    const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    const cached = reverseCache.get(cacheKey);
    if (cached) {
      console.log(`[geocode/reverse] 💾 Cache hit → (${lat.toFixed(4)}, ${lng.toFixed(4)})`);
      return res.json(cached);
    }

    const url = `${NOMINATIM_BASE}/reverse?format=jsonv2&lat=${lat}&lon=${lng}`;

    await nominatimThrottle();
    calls.reverse++;
    console.log(`[geocode/reverse] 🌐 Nominatim call #${calls.reverse} → (${lat.toFixed(4)}, ${lng.toFixed(4)})`);

    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    const data = await parseUpstreamJsonOrNull(response, 'Nominatim reverse');

    if (!data || data.error || !data.lat || !data.lon) {
      return res.json({ status: 'NOT_FOUND', result: null });
    }

    const payload = {
      status: 'OK',
      result: {
        place_id: `osm-${data.osm_type}-${data.osm_id}`,
        name: data.display_name,
        geometry: {
          location: {
            lat: parseFloat(data.lat),
            lng: parseFloat(data.lon),
          },
        },
      },
    };

    reverseCache.set(cacheKey, payload);
    console.log(`[geocode/reverse] 📦 "${data.display_name?.substring(0, 40)}" (cached)`);
    res.json(payload);
  } catch (err) {
    console.error('[geocode/reverse] Error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /api/geocode/stats ───────────────────────────────────────────────────
router.get('/stats', (_req, res) => {
  res.json({
    nominatimCalls: calls,
    cacheSize: {
      autocomplete: autocompleteCache._size?.() ?? '—',
      details: detailsCache._size?.() ?? '—',
      reverse: reverseCache._size?.() ?? '—',
    },
  });
});

module.exports = router;
