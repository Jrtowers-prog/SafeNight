import { env } from '@/src/config/env';
import { AppError } from '@/src/types/errors';
import type {
  DirectionsRoute,
  LatLng,
  NavigationStep,
  PlaceDetails,
  PlacePrediction,
} from '@/src/types/geo';
import { decodePolyline } from '@/src/utils/polyline';
import {
  directionsRateLimiter,
  placesAutocompleteRateLimiter,
  placesDetailsRateLimiter,
} from '@/src/utils/rateLimiter';

// ---------------------------------------------------------------------------
// Directions result cache — avoids duplicate API calls for same origin/dest
// ---------------------------------------------------------------------------
interface DirectionsCache {
  data: DirectionsRoute[];
  timestamp: number;
}
const directionsCache = new Map<string, DirectionsCache>();
const DIRECTIONS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const directionsKey = (o: LatLng, d: LatLng) =>
  `${o.latitude.toFixed(5)},${o.longitude.toFixed(5)}-${d.latitude.toFixed(5)},${d.longitude.toFixed(5)}`;

type GooglePlacesAutocompleteResponse = {
  status: string;
  error_message?: string;
  predictions: Array<{
    place_id: string;
    description: string;
    category?: string | null;
    place_type?: string | null;
    structured_formatting?: {
      main_text?: string;
      secondary_text?: string;
    };
    address?: {
      house_number?: string | null;
      road?: string | null;
      neighbourhood?: string | null;
      city?: string | null;
      county?: string | null;
      postcode?: string | null;
      country?: string | null;
    };
    lat?: number;
    lng?: number;
  }>;
};

type GooglePlaceDetailsResponse = {
  status: string;
  error_message?: string;
  result?: {
    place_id: string;
    name: string;
    geometry?: {
      location?: {
        lat: number;
        lng: number;
      };
    };
  };
};

type GoogleDirectionsResponse = {
  status: string;
  error_message?: string;
  routes: Array<{
    summary?: string;
    overview_polyline?: {
      points?: string;
    };
    legs?: Array<{
      distance?: {
        value?: number;
      };
      duration?: {
        value?: number;
      };
      steps?: Array<{
        html_instructions?: string;
        distance?: { value?: number };
        duration?: { value?: number };
        start_location?: { lat: number; lng: number };
        end_location?: { lat: number; lng: number };
        maneuver?: string;
      }>;
    }>;
  }>;
};

const BACKEND_API_BASE = env.apiBaseUrl;
const GEOCODE_API_BASE = env.geocodeApiUrl;

const fetchJson = async <T>(url: string): Promise<T> => {
  try {
    const endpoint = url.replace(BACKEND_API_BASE, '').replace(GEOCODE_API_BASE, '').split('?')[0];
    console.log(`[OSM] 🌐 Backend call → ${endpoint}`);
    const response = await fetch(url);

    if (!response.ok) {
      throw new AppError(
        'osm_http_error',
        `OSM request failed with status ${response.status}`
      );
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('osm_network_error', 'Network error', error);
  }
};

export const fetchPlacePredictions = async (
  input: string,
  options?: {
    locationBias?: LatLng;
    radiusMeters?: number;
    limit?: number;
    subscriptionTier?: string;
  }
): Promise<PlacePrediction[]> => {
  const trimmedInput = input.trim();

  if (!trimmedInput) {
    return [];
  }

  // Build backend proxy URL
  let url = `${GEOCODE_API_BASE}/api/geocode/autocomplete?input=${encodeURIComponent(trimmedInput)}`;

  if (options?.locationBias && options.radiusMeters) {
    url += `&lat=${options.locationBias.latitude}&lng=${options.locationBias.longitude}&radius=${options.radiusMeters}`;
  }

  if (options?.limit && Number.isFinite(options.limit) && options.limit > 0) {
    url += `&limit=${Math.floor(options.limit)}`;
  }

  if (options?.subscriptionTier) {
    url += `&subscription_tier=${encodeURIComponent(options.subscriptionTier)}`;
  }

  // Rate limit autocomplete calls
  return placesAutocompleteRateLimiter.execute(async () => {

  const data = await fetchJson<GooglePlacesAutocompleteResponse>(url);

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new AppError(
      'osm_places_autocomplete_error',
      data.error_message ?? `Google Places Autocomplete failed: ${data.status}`
    );
  }

  return data.predictions.map((prediction) => ({
    placeId: prediction.place_id,
    primaryText: prediction.structured_formatting?.main_text ?? prediction.description,
    secondaryText: prediction.structured_formatting?.secondary_text,
    fullText: prediction.description,
    category: prediction.category ?? undefined,
    placeType: prediction.place_type ?? undefined,
    address: prediction.address
      ? {
          houseNumber: prediction.address.house_number ?? undefined,
          road: prediction.address.road ?? undefined,
          neighbourhood: prediction.address.neighbourhood ?? undefined,
          city: prediction.address.city ?? undefined,
          county: prediction.address.county ?? undefined,
          postcode: prediction.address.postcode ?? undefined,
          country: prediction.address.country ?? undefined,
        }
      : undefined,
    location: prediction.lat != null && prediction.lng != null
      ? { latitude: prediction.lat, longitude: prediction.lng }
      : undefined,
    source: 'osm' as const,
  }));
  }); // end rate limiter
};

export const fetchPlaceDetails = async (placeId: string): Promise<PlaceDetails> => {
  const url = `${GEOCODE_API_BASE}/api/geocode/details?place_id=${encodeURIComponent(placeId)}`;

  return placesDetailsRateLimiter.execute(async () => {

  const data = await fetchJson<GooglePlaceDetailsResponse>(url);

  if (data.status !== 'OK' || !data.result?.geometry?.location) {
    throw new AppError(
      'google_place_details_error',
      data.error_message ?? `Google Place Details failed: ${data.status}`
    );
  }

  return {
    placeId: data.result.place_id,
    name: data.result.name,
    location: {
      latitude: data.result.geometry.location.lat,
      longitude: data.result.geometry.location.lng,
    },
  };
  }); // end rate limiter
};

// ---------------------------------------------------------------------------
// Helpers – generate diverse walking routes
// ---------------------------------------------------------------------------

/** Perpendicular nudges along the STRAIGHT origin→destination line so extra
 *  API calls explore nearby parallel streets. Only uses the direct line
 *  (never actual route geometry) so waypoints cannot create route loops.
 *  `scalePct` controls nudge distance (0.03 = 3 %, 0.12 = 12 %).
 *  `fractions` controls where along the line to place offsets. */
const generateOffsetWaypoints = (
  origin: LatLng,
  dest: LatLng,
  scalePct: number,
  fractions: number[] = [0.5],
): LatLng[] => {
  const dLat = dest.latitude - origin.latitude;
  const dLng = dest.longitude - origin.longitude;
  const len = Math.sqrt(dLat * dLat + dLng * dLng);
  if (len < 0.0001) return [];
  const scale = len * scalePct;
  const pLat = (-dLng / len) * scale;
  const pLng = (dLat / len) * scale;

  const pts: LatLng[] = [];
  for (const frac of fractions) {
    const lat = origin.latitude + dLat * frac;
    const lng = origin.longitude + dLng * frac;
    pts.push({ latitude: lat + pLat, longitude: lng + pLng });
    pts.push({ latitude: lat - pLat, longitude: lng - pLng });
  }
  return pts;
};

/** Estimate how "path-heavy" a set of routes is from their summaries.
 *  Returns 0 (all main roads) to 1 (all paths). */
const pathHeaviness = (routes: DirectionsRoute[]): number => {
  if (routes.length === 0) return 0;
  let pathHits = 0;
  let mainHits = 0;
  for (const r of routes) {
    const s = r.summary ?? '';
    if (/\b(path|trail|footpath|footway|alley|steps|track)\b/i.test(s)) pathHits++;
    if (/\b[ABM]\d|\b(road|street|ave|avenue|boulevard|drive)\b/i.test(s)) mainHits++;
  }
  const total = pathHits + mainHits;
  return total > 0 ? pathHits / total : 0.5;
};

/** Drop routes whose distance AND duration are within 5 %/8 % of an already-kept route */
const deduplicateRoutes = (routes: DirectionsRoute[]): DirectionsRoute[] => {
  const unique: DirectionsRoute[] = [];
  for (const r of routes) {
    const dup = unique.some((u) => {
      const avgD = (u.distanceMeters + r.distanceMeters) / 2 || 1;
      const avgT = (u.durationSeconds + r.durationSeconds) / 2 || 1;
      return (
        Math.abs(u.distanceMeters - r.distanceMeters) / avgD < 0.05 &&
        Math.abs(u.durationSeconds - r.durationSeconds) / avgT < 0.08
      );
    });
    if (!dup) unique.push(r);
  }
  return unique;
};

/** Score a route summary – named / numbered roads rank higher (main roads) */
const mainRoadScore = (summary?: string): number => {
  if (!summary) return 0;
  let score = 0;
  // A-roads, B-roads, M-roads, numbered routes (e.g. A386, B3214)
  if (/\b[ABM]\d/i.test(summary)) score += 3;
  // Named "Road", "Street", "Avenue" etc. – indicates an actual named road vs footpath
  if (/\b(road|street|ave|avenue|boulevard|blvd|highway|hwy|drive|lane|way)\b/i.test(summary)) score += 2;
  // Penalise paths/trails/footways
  if (/\b(path|trail|footpath|footway|alley|steps|track)\b/i.test(summary)) score -= 3;
  return score;
};

/** Parse one Directions REST response into route objects */
const parseDirectionsResponse = (
  data: GoogleDirectionsResponse,
  idOffset: number,
): DirectionsRoute[] => {
  if (data.status !== 'OK') return [];
  return data.routes.map((route, i) => {
    const encodedPolyline = route.overview_polyline?.points ?? '';
    if (!encodedPolyline) return null!;
    const legs = route.legs ?? [];
    // Extract turn-by-turn steps from all legs
    const steps: NavigationStep[] = legs.flatMap((leg) =>
      (leg.steps ?? []).map((s) => ({
        instruction: s.html_instructions ?? '',
        distanceMeters: s.distance?.value ?? 0,
        durationSeconds: s.duration?.value ?? 0,
        startLocation: {
          latitude: s.start_location?.lat ?? 0,
          longitude: s.start_location?.lng ?? 0,
        },
        endLocation: {
          latitude: s.end_location?.lat ?? 0,
          longitude: s.end_location?.lng ?? 0,
        },
        maneuver: s.maneuver,
      }))
    );
    return {
      id: `route-${idOffset + i}`,
      distanceMeters: legs.reduce((t, l) => t + (l.distance?.value ?? 0), 0),
      durationSeconds: legs.reduce((t, l) => t + (l.duration?.value ?? 0), 0),
      encodedPolyline,
      path: decodePolyline(encodedPolyline),
      steps,
      summary: route.summary,
    };
  }).filter(Boolean);
};
// ─────────────────────────────────────────────────────────────────────────────
// Smart route comparison: Car ETA vs Walking ETA with safety validation
// ─────────────────────────────────────────────────────────────────────────────

const WALKING_SPEED_MS = 1.4; // ~5 km/h typical walking speed

/**
 * Calculate estimated walking time for a route based on distance.
 * Assumes average walking speed of ~1.4 m/s (5 km/h)
 */
const calculateWalkingTime = (distanceMeters: number): number => {
  return Math.round(distanceMeters / WALKING_SPEED_MS);
};

export type SmartRoute = DirectionsRoute & {
  mode: 'car' | 'walking';
  carETASeconds: number;
  walkingETASeconds: number;
  reason?: string;
};

/**
 * Fetch smart routes: compares car routes (with calculated walking time)
 * against walking routes. If walking time is within 40% of car route walking time,
 * prefers walking. Otherwise uses car if a walking path exists.
 */
export const fetchSmartDirections = async (
  origin: LatLng,
  destination: LatLng
): Promise<SmartRoute[]> => {
  try {
    console.log(`[🧠 smartDirections] Starting smart route comparison...`);
    
    // Fetch car and walking routes IN PARALLEL (both free OSRM calls)
    const carBase = `${BACKEND_API_BASE}/api/directions?origin_lat=${origin.latitude}&origin_lng=${origin.longitude}&dest_lat=${destination.latitude}&dest_lng=${destination.longitude}&mode=driving`;
    const walkBase = `${BACKEND_API_BASE}/api/directions?origin_lat=${origin.latitude}&origin_lng=${origin.longitude}&dest_lat=${destination.latitude}&dest_lng=${destination.longitude}&mode=walking`;

    console.log(`[🧠 smartDirections] Fetching car + walking routes in parallel...`);
    const [carData, walkData] = await Promise.all([
      directionsRateLimiter.execute(() => fetchJson<GoogleDirectionsResponse>(carBase)),
      directionsRateLimiter.execute(() => fetchJson<GoogleDirectionsResponse>(walkBase)),
    ]);
    const carRoutes = carData.status === 'OK' ? parseDirectionsResponse(carData, 0) : [];
    const walkRoutes = walkData.status === 'OK' ? parseDirectionsResponse(walkData, 10) : [];
    console.log(`[🧠 smartDirections] Got ${carRoutes.length} car + ${walkRoutes.length} walking routes`);

    if (carRoutes.length === 0 && walkRoutes.length === 0) {
      throw new AppError('directions_error', 'No routes found');
    }

    // Convert to smart routes
    const smartRoutes: SmartRoute[] = [];

    // Add car routes with walking time calculation
    carRoutes.forEach((route, idx) => {
      const walkingTime = calculateWalkingTime(route.distanceMeters);
      smartRoutes.push({
        ...route,
        id: `car-route-${idx}`,
        mode: 'car',
        carETASeconds: route.durationSeconds,
        walkingETASeconds: walkingTime,
        reason: 'car_route',
      });
    });

    // Add walking routes
    walkRoutes.forEach((route, idx) => {
      smartRoutes.push({
        ...route,
        id: `walk-route-${idx}`,
        mode: 'walking',
        carETASeconds: 0, // N/A for walking
        walkingETASeconds: route.durationSeconds,
        reason: 'walking_route',
      });
    });

    // Smart comparison logic
    if (carRoutes.length > 0 && walkRoutes.length > 0) {
      const bestCar = carRoutes[0];
      const bestWalk = walkRoutes[0];
      const carWalkTime = calculateWalkingTime(bestCar.distanceMeters);
      const walkTime = bestWalk.durationSeconds;

      console.log(
        `[smartDirections] 🚗 Car distance: ${(bestCar.distanceMeters / 1000).toFixed(1)}km (${(carWalkTime / 60).toFixed(0)}min if walked) vs ` +
        `🚶 Walking: ${(bestWalk.distanceMeters / 1000).toFixed(1)}km (${(walkTime / 60).toFixed(0)}min actual)`
      );

      // For a WALKING APP: Walking routes are always primary
      // Car routes shown only as secondary options for reference
      console.log(`[smartDirections] 🚶 WALKING APP MODE: Prioritizing actual walking routes`);
      return [
        ...smartRoutes.filter((r) => r.mode === 'walking'),
        ...smartRoutes.filter((r) => r.mode === 'car'),
      ];
    }

    // Default: sort by walking time (best first)
    smartRoutes.sort((a, b) => a.walkingETASeconds - b.walkingETASeconds);
    console.log(`[🧠 smartDirections] ✅ Returning ${smartRoutes.length} smart routes (sorted by walking time)`);
    smartRoutes.forEach((r, i) => {
      console.log(`  Route ${i + 1}: ${r.mode.toUpperCase()} - 🚶 ${(r.walkingETASeconds / 60).toFixed(0)}min walk, ${(r.distanceMeters / 1000).toFixed(1)}km`);
    });
    
    // For a walking app, always prioritize actual walking routes first
    // Only include car routes as alternatives if user explicitly needs them
    const walkingFirst = [
      ...smartRoutes.filter((r) => r.mode === 'walking'),
      ...smartRoutes.filter((r) => r.mode === 'car'),
    ];
    
    return walkingFirst;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('smart_directions_error', 'Failed to fetch smart directions', error);
  }
};
export const fetchDirections = async (
  origin: LatLng,
  destination: LatLng
): Promise<DirectionsRoute[]> => {
  // Check directions cache first
  const cacheKey = directionsKey(origin, destination);
  const cachedResult = directionsCache.get(cacheKey);
  if (cachedResult && Date.now() - cachedResult.timestamp < DIRECTIONS_CACHE_TTL) {
    console.log(`[OSM] ✅ Directions CACHE HIT (${cachedResult.data.length} routes)`);
    return cachedResult.data;
  }

  const base = `${BACKEND_API_BASE}/api/directions?origin_lat=${origin.latitude}&origin_lng=${origin.longitude}&dest_lat=${destination.latitude}&dest_lng=${destination.longitude}&mode=walking`;

  // 1. Primary request – gets up to ~3 alternatives (rate limited)
  const baseData = await directionsRateLimiter.execute(() => fetchJson<GoogleDirectionsResponse>(base));
  if (baseData.status !== 'OK') {
    throw new AppError(
        'osm_directions_error',
        baseData.error_message ?? `OSM Directions failed: ${baseData.status}`
    );
  }
  const baseRoutes = parseDirectionsResponse(baseData, 0);

  // 2. Offset waypoints AND driving-discovery IN PARALLEL
  //    All calls are free (OSRM) — maximise throughput
  const heaviness = pathHeaviness(baseRoutes);
  const offsetPct = 0.03 + heaviness * 0.07; // 3 %–10 %, gentle to avoid loops
  const offsets = generateOffsetWaypoints(origin, destination, offsetPct).slice(0, 2);

  // Fire offset requests + driving request concurrently
  const drivingUrl = `${BACKEND_API_BASE}/api/directions?origin_lat=${origin.latitude}&origin_lng=${origin.longitude}&dest_lat=${destination.latitude}&dest_lng=${destination.longitude}&mode=driving`;

  const [extras, drivingRoutes] = await Promise.all([
    // Offset waypoints
    Promise.all(
      offsets.map((wp, i) =>
        directionsRateLimiter.execute(() =>
          fetchJson<GoogleDirectionsResponse>(
            `${base}&waypoints=${encodeURIComponent(`via:${wp.latitude},${wp.longitude}`)}`
          )
        )
          .then((d) => parseDirectionsResponse(d, (i + 1) * 10))
          .catch(() => [] as DirectionsRoute[])
      )
    ).then((arr) => arr.flat()),

    // Drive-then-walk main-road discovery
    directionsRateLimiter.execute(() => fetchJson<GoogleDirectionsResponse>(drivingUrl))
      .then(async (drivingData) => {
        if (drivingData.status !== 'OK') return [];
        const drivePath = parseDirectionsResponse(drivingData, 0)[0]?.path ?? [];
        if (drivePath.length < 6) return [];
        // Sample points at 25 %, 50 %, 75 % of the driving path
        const viaPoints = [0.25, 0.5, 0.75].map((frac) => {
          const idx = Math.min(Math.floor(frac * drivePath.length), drivePath.length - 1);
          return drivePath[idx];
        });
        const viaStr = viaPoints.map((p) => `via:${p.latitude},${p.longitude}`).join('|');
        return directionsRateLimiter.execute(() =>
          fetchJson<GoogleDirectionsResponse>(
            `${base}&waypoints=${encodeURIComponent(viaStr)}`
          )
        ).then((d) => parseDirectionsResponse(d, 200)).catch(() => [] as DirectionsRoute[]);
      })
      .catch(() => [] as DirectionsRoute[]),
  ]);

  // 3. Merge, deduplicate
  let merged = deduplicateRoutes([...baseRoutes, ...extras, ...drivingRoutes]);

  // 4. REMOVED — retry offsets generated up to 8 extra Directions API calls
  //    per search. With steps 1-3 we typically get 3-5 diverse routes already.

  // 5. Drop routes that detour too far, sort sensibly
  const shortest = Math.min(...merged.map((r) => r.distanceMeters));
  const reasonable = merged.filter((r) => r.distanceMeters <= shortest * 1.6);
  reasonable.sort((a, b) => {
    const distDiff = a.distanceMeters - b.distanceMeters;
    if (Math.abs(distDiff) > shortest * 0.05) return distDiff;
    return mainRoadScore(b.summary) - mainRoadScore(a.summary);
  });
  const result = reasonable.slice(0, 5).map((r, i) => ({ ...r, id: `route-${i}` }));

  // Cache the result
  directionsCache.set(cacheKey, { data: result, timestamp: Date.now() });
  return result;
};

export const buildStaticMapUrl = (params: {
  origin?: LatLng | null;
  destination?: LatLng | null;
  encodedPolyline?: string | null;
  width: number;
  height: number;
  scale?: number;
}): string | null => {
  const { origin, destination, encodedPolyline, width, height, scale = 2 } = params;

  const queryParts: string[] = [
    `width=${Math.max(1, Math.round(width))}`,
    `height=${Math.max(1, Math.round(height))}`,
    `scale=${scale}`,
  ];

  if (origin) {
    queryParts.push(`origin_lat=${origin.latitude}`);
    queryParts.push(`origin_lng=${origin.longitude}`);
  }

  if (destination) {
    queryParts.push(`dest_lat=${destination.latitude}`);
    queryParts.push(`dest_lng=${destination.longitude}`);
  }

  if (encodedPolyline) {
    queryParts.push(`polyline=${encodeURIComponent(encodedPolyline)}`);
  }

  return `${BACKEND_API_BASE}/api/staticmap?${queryParts.join('&')}`;
};

