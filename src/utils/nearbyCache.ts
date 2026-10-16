/**
 * nearbyCache.ts
 *
 * Shared module-level cache for OPEN PLACES near route segments.
 * Uses Overpass API (OpenStreetMap) instead of Google Places Nearby —
 * completely FREE with no API key required.
 *
 * Both safetyMapData.ts and safety.ts import this so they never make
 * duplicate API calls for the same area.
 *
 * Key: rounded lat/lng (3 decimal places ≈ ~110m) + radius
 * TTL: 5 minutes
 */

import { queueOverpassQuery } from '@/src/utils/overpassQueue';

export interface NearbyPlace {
  place_id: string;
  name: string;
  location: { lat: number; lng: number } | null;
  types: string[];
  open_now: boolean;        // Overpass can't tell real-time status — assumed true for amenities
  business_status: string;
}

interface CacheEntry {
  results: NearbyPlace[];
  timestamp: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<NearbyPlace[]>>();

// ─── API call tracking ──────────────────────────────────────────────────────
let totalApiCalls = 0;
let cacheHits = 0;
let inflightHits = 0;

/** Round to 3 decimals (~110m) so nearby coordinates share results */
const cacheKey = (lat: number, lng: number, radius: number): string =>
  `${lat.toFixed(3)},${lng.toFixed(3)},${radius}`;

// ─── Overpass query builder ─────────────────────────────────────────────────

/**
 * Build an Overpass QL query that finds amenities, shops, and leisure places
 * within `radius` metres of (lat, lng).
 *
 * Targets places with human activity — the key safety signal:
 *   • amenity: restaurant, cafe, bar, pub, fast_food, nightclub, cinema,
 *              theatre, pharmacy, hospital, clinic, school, university,
 *              college, library, townhall, community_centre, bank,
 *              marketplace, etc.
 *   • shop: any shop (supermarket, convenience, etc.)
 *   • leisure: fitness_centre, sports_centre, swimming_pool
 */
const buildOverpassQuery = (lat: number, lng: number, radius: number): string => {
  const around = `(around:${radius},${lat},${lng})`;
  return `[out:json][timeout:10];(node["amenity"~"restaurant|cafe|bar|pub|fast_food|nightclub|cinema|theatre|pharmacy|hospital|clinic|school|university|college|library|townhall|community_centre|bank|marketplace|food_court|ice_cream|biergarten"]${around};node["shop"]${around};node["leisure"~"fitness_centre|sports_centre|swimming_pool"]${around};way["amenity"~"restaurant|cafe|bar|pub|fast_food|nightclub|cinema|theatre|pharmacy|hospital|clinic|school|university|college|library|townhall|community_centre|bank|marketplace|food_court|ice_cream|biergarten"]${around};way["shop"]${around};way["leisure"~"fitness_centre|sports_centre|swimming_pool"]${around};);out center tags qt 50;`;
};

// ─── Overpass element → NearbyPlace ─────────────────────────────────────────

const toNearbyPlace = (element: any): NearbyPlace | null => {
  const tags = element.tags ?? {};
  const name = tags.name ?? tags['name:en'] ?? tags.brand ?? '';

  // Skip unnamed features — they're not useful as safety markers
  if (!name) return null;

  // Nodes have lat/lon directly; ways use center
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (lat == null || lon == null) return null;

  const types: string[] = [];
  if (tags.amenity) types.push(tags.amenity);
  if (tags.shop) types.push('shop', tags.shop);
  if (tags.leisure) types.push(tags.leisure);
  if (tags.cuisine) types.push(tags.cuisine);

  return {
    place_id: `osm-${element.type}-${element.id}`,
    name,
    location: { lat, lng: lon },
    types,
    // Overpass doesn't know real-time opening status.
    // We assume amenities exist = human activity nearby — that's
    // the safety signal we care about.
    open_now: true,
    business_status: 'OPERATIONAL',
  };
};



// ─── Main exported function ──────────────────────────────────────────────────

/**
 * Fetch nearby open places for a single point using Overpass (OSM).
 * Results are cached and de-duplicated — concurrent calls for the
 * same rounded location will share a single API request.
 *
 * 🆓 Completely FREE — no Google API calls, no API key needed.
 */
export const fetchNearbyPlacesCached = async (
  lat: number,
  lng: number,
  radius = 300,
): Promise<NearbyPlace[]> => {
  const key = cacheKey(lat, lng, radius);

  // 1. Check memory cache
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    cacheHits++;
    console.log(`[nearbyCache] ✅ CACHE HIT for ${key} (${cached.results.length} results) | calls: ${totalApiCalls}, cache: ${cacheHits}, dedup: ${inflightHits}`);
    return cached.results;
  }

  // 2. De-duplicate in-flight requests
  const existing = inflight.get(key);
  if (existing) {
    inflightHits++;
    console.log(`[nearbyCache] 🔄 IN-FLIGHT DEDUP for ${key} | calls: ${totalApiCalls}, cache: ${cacheHits}, dedup: ${inflightHits}`);
    return existing;
  }

  // 3. Make the Overpass request (no rate limiter needed — Overpass is free)
  totalApiCalls++;
  console.log(`[nearbyCache] 🌐 OVERPASS CALL #${totalApiCalls} → ${key} | Total: ${totalApiCalls} calls, ${cacheHits} cache hits, ${inflightHits} dedup hits`);

  const promise = (async (): Promise<NearbyPlace[]> => {
    try {
      const query = buildOverpassQuery(lat, lng, radius);
      const data = await queueOverpassQuery(query, 8_000, `nearby ${key}`);

      if (!data?.elements) return [];

      const places: NearbyPlace[] = [];
      const seenIds = new Set<string>();

      for (const element of data.elements) {
        const place = toNearbyPlace(element);
        if (!place || seenIds.has(place.place_id)) continue;
        seenIds.add(place.place_id);
        places.push(place);
      }

      return places;
    } catch (err) {
      console.warn('[nearbyCache] Overpass fetch failed:', err);
      return [];
    }
  })();

  inflight.set(key, promise);

  try {
    const results = await promise;
    cache.set(key, { results, timestamp: Date.now() });
    console.log(`[nearbyCache] 📦 OVERPASS #${totalApiCalls} returned ${results.length} places for ${key}`);
    return results;
  } finally {
    inflight.delete(key);
  }
};

/** Clear the cache (useful for testing) */
export const clearNearbyCache = (): void => {
  cache.clear();
};
