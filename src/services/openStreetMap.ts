import { env, requireOsmUserAgent } from '@/src/config/env';
import { AppError } from '@/src/types/errors';
import type { DirectionsRoute, LatLng, PlaceDetails, PlacePrediction } from '@/src/types/geo';
import type { NominatimLookupResult, NominatimSearchResult, OsrmRouteResponse } from '@/src/types/osm';
import { decodePolyline } from '@/src/utils/polyline';

const NOMINATIM_BASE_URL = env.osmBaseUrl;
const OSRM_BASE_URL = env.osrmBaseUrl;
const GEOCODE_API_BASE = env.geocodeApiUrl;

const buildHeaders = (): HeadersInit => {
  const headers: Record<string, string> = {
    'User-Agent': requireOsmUserAgent(),
  };

  if (env.osmEmail) {
    headers.From = env.osmEmail;
  }

  return headers;
};

const fetchJson = async <T>(url: string, options?: RequestInit): Promise<T> => {
  // AbortSignal.timeout() is NOT available in React Native — use AbortController + setTimeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const endpoint = url.split('?')[0].replace(NOMINATIM_BASE_URL, 'Nominatim').replace(OSRM_BASE_URL, 'OSRM');
    console.log(`[OSM] 🌐 API call → ${endpoint}`);
    const response = await fetch(url, {
      ...options,
      headers: {
        ...(options?.headers ?? {}),
        ...buildHeaders(),
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      if (response.status === 504) {
        throw new AppError(
          'osm_timeout_error',
          'Request timed out. The routing server may be overloaded. Please try again.'
        );
      }
      throw new AppError(
        'osm_http_error',
        `OpenStreetMap request failed with status ${response.status}`
      );
    }

    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    const body = await response.text();
    const trimmed = body.trim();

    if (!trimmed) {
      throw new AppError('osm_parse_error', 'OpenStreetMap response was empty');
    }

    const looksJson =
      contentType.includes('application/json') ||
      contentType.includes('json') ||
      trimmed.startsWith('{') ||
      trimmed.startsWith('[');

    if (!looksJson) {
      throw new AppError('osm_parse_error', 'OpenStreetMap response was not JSON');
    }

    return JSON.parse(trimmed) as T;
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof AppError) {
      throw error;
    }
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new AppError('osm_timeout_error', 'Request timed out. Please try again.');
    }

    throw new AppError('osm_network_error', 'Network error', error);
  }
};

const metersToLatDegrees = (meters: number): number => meters / 111_320;

const metersToLonDegrees = (meters: number, latitude: number): number => {
  const latRadians = (latitude * Math.PI) / 180;
  const metersPerDegree = 111_320 * Math.cos(latRadians);
  if (!metersPerDegree) {
    return metersToLatDegrees(meters);
  }

  return meters / metersPerDegree;
};

const buildViewbox = (location: LatLng, radiusMeters: number): string => {
  const latDelta = metersToLatDegrees(radiusMeters);
  const lonDelta = metersToLonDegrees(radiusMeters, location.latitude);

  const left = location.longitude - lonDelta;
  const right = location.longitude + lonDelta;
  const top = location.latitude + latDelta;
  const bottom = location.latitude - latDelta;

  return `${left},${top},${right},${bottom}`;
};

const splitDisplayName = (displayName: string): { primary: string; secondary?: string } => {
  const parts = displayName.split(',').map((part) => part.trim()).filter(Boolean);

  if (parts.length <= 1) {
    return { primary: displayName };
  }

  return {
    primary: parts[0] ?? displayName,
    secondary: parts.slice(1).join(', '),
  };
};

const parseLatLng = (lat: string, lon: string): LatLng | null => {
  const latitude = Number(lat);
  const longitude = Number(lon);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return { latitude, longitude };
};

const formatOsmPlaceId = (osmType?: string, osmId?: number): string => {
  if (!osmType || !osmId) {
    return `osm:${osmId ?? 'unknown'}`;
  }

  return `${osmType}:${osmId}`;
};

const buildLookupId = (placeId: string): string | null => {
  const [type, id] = placeId.split(':');

  if (!id) {
    return null;
  }

  const upperType =
    type === 'node' ? 'N' : type === 'way' ? 'W' : type === 'relation' ? 'R' : null;

  if (!upperType) {
    return null;
  }

  return `${upperType}${id}`;
};

export const fetchPlacePredictions = async (
  input: string,
  options?: { limit?: number; locationBias?: LatLng; radiusMeters?: number }
): Promise<PlacePrediction[]> => {
  const trimmedInput = input.trim();

  if (!trimmedInput) {
    return [];
  }

  const limit = options?.limit ?? 5;
  const params = new URLSearchParams({
    format: 'jsonv2',
    q: trimmedInput,
    addressdetails: '1',
    limit: String(limit),
    dedupe: '1',
  });

  if (options?.locationBias && options.radiusMeters) {
    params.set('viewbox', buildViewbox(options.locationBias, options.radiusMeters));
    params.set('bounded', '1');
  }

  if (env.osmEmail) {
    params.set('email', env.osmEmail);
  }

  const url = `${NOMINATIM_BASE_URL}/search?${params.toString()}`;
  const data = await fetchJson<NominatimSearchResult[]>(url);

  return data
    .map((result) => {
      const location = parseLatLng(result.lat, result.lon);
      if (!location) {
        return null;
      }

      const nameParts = splitDisplayName(result.display_name);

      return {
        placeId: formatOsmPlaceId(result.osm_type, result.osm_id),
        primaryText: nameParts.primary,
        secondaryText: nameParts.secondary,
        fullText: result.display_name,
        location,
        source: 'osm',
      } as PlacePrediction;
    })
    .filter((item): item is PlacePrediction => item !== null);
};

export const fetchPlaceDetails = async (placeId: string): Promise<PlaceDetails> => {
  const lookupId = buildLookupId(placeId);

  if (!lookupId) {
    throw new AppError('osm_place_id_error', 'Invalid place identifier');
  }

  const params = new URLSearchParams({
    format: 'jsonv2',
    osm_ids: lookupId,
  });

  if (env.osmEmail) {
    params.set('email', env.osmEmail);
  }

  const url = `${NOMINATIM_BASE_URL}/lookup?${params.toString()}`;
  const data = await fetchJson<NominatimLookupResult[]>(url);
  const result = data[0];

  if (!result) {
    throw new AppError('osm_place_details_error', 'Place lookup returned no results');
  }

  const location = parseLatLng(result.lat, result.lon);

  if (!location) {
    throw new AppError('osm_place_details_error', 'Invalid coordinates from lookup');
  }

  return {
    placeId,
    name: result.display_name,
    location,
    source: 'osm',
  };
};

export const reverseGeocode = async (location: LatLng): Promise<PlaceDetails | null> => {
  // Route through the geocode microservice so the result is cached and
  // Nominatim’s 1 req/sec limit is enforced server-side instead of per-client.
  try {
    const url = `${GEOCODE_API_BASE}/api/geocode/reverse?lat=${location.latitude}&lng=${location.longitude}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    const body = await response.text();
    const trimmed = body.trim();

    if (!trimmed) {
      return null;
    }

    const looksJson =
      contentType.includes('application/json') ||
      contentType.includes('json') ||
      trimmed.startsWith('{') ||
      trimmed.startsWith('[');

    if (!looksJson) {
      return null;
    }

    const data = JSON.parse(trimmed) as {
      status: string;
      result: {
        place_id: string;
        name: string;
        geometry: { location: { lat: number; lng: number } };
      } | null;
    };

    if (data.status !== 'OK' || !data.result) return null;

    return {
      placeId: data.result.place_id,
      name: data.result.name,
      location: {
        latitude: data.result.geometry.location.lat,
        longitude: data.result.geometry.location.lng,
      },
      source: 'osm',
    };
  } catch {
    return null;
  }
};

export const fetchDirections = async (
  origin: LatLng,
  destination: LatLng
): Promise<DirectionsRoute[]> => {
  // TODO: Replace public OSRM with a dedicated routing backend for production scale.
  // Using 'foot' profile which calculates routes for pedestrians at ~5 km/h walking speed
  const url = `${OSRM_BASE_URL}/route/v1/foot/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}?alternatives=true&overview=full&geometries=polyline&steps=false`;

  const data = await fetchJson<OsrmRouteResponse>(url);

  if (data.code !== 'Ok' || !data.routes) {
    throw new AppError(
      'osm_directions_error',
      data.message ?? `Routing failed: ${data.code ?? 'unknown'}`
    );
  }

  return data.routes.slice(0, 5).map((route, index) => {
    const encodedPolyline = route.geometry ?? '';

    if (!encodedPolyline) {
      throw new AppError('osm_directions_error', 'Missing route geometry');
    }

    // Duration is already in seconds for walking speed from OSRM
    return {
      id: `route-${index}`,
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      encodedPolyline,
      path: decodePolyline(encodedPolyline),
      summary: undefined,
    };
  });
};
