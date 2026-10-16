import { env } from '@/src/config/env';
import { AppError } from '@/src/types/errors';
import type { LatLng } from '@/src/types/geo';
import type {
  CrimeIncident,
  OverpassApiResponse,
  OverpassHighwayStats,
  PoliceCrimeApiItem,
  SafetySummary,
} from '@/src/types/safety';
import { fetchNearbyPlacesCached } from '@/src/utils/nearbyCache';
import { queueOverpassRequest } from '@/src/utils/overpassQueue';

/**
 * Progress callback type for safety analysis
 */
export type SafetyProgressCallback = (message: string, progress?: number) => void;

type BoundingBox = {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
};

const POLICE_BASE_URL = env.policeApiBaseUrl;

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

const fetchJson = async <T>(url: string, options?: RequestInit): Promise<T> => {
  try {
    const label = url.includes('police') ? 'Police API' : url.split('?')[0].slice(-40);
    console.log(`[Safety] 🌐 API call → ${label}`);
    const response = await fetch(url, options);

    if (!response.ok) {
      throw new AppError('safety_http_error', `Safety request failed: ${response.status}`);
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('safety_network_error', 'Network error', error);
  }
};

const fetchJsonWithTimeout = async <T>(
  url: string,
  options?: RequestInit,
  timeoutMs = 8000,
): Promise<T> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const label = url.includes('police') ? 'Police API' : url.split('?')[0].slice(-40);
    console.log(`[Safety] 🌐 API call → ${label}`);
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) throw new AppError('safety_http_error', `Safety request failed: ${response.status}`);
    return (await response.json()) as T;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new AppError('safety_timeout', 'Request timed out');
    throw new AppError('safety_network_error', 'Network error', error);
  }
};

// ---------------------------------------------------------------------------
// Geo math
// ---------------------------------------------------------------------------

const metersToLatDegrees = (meters: number): number => meters / 111_320;

const metersToLonDegrees = (meters: number, latitude: number): number => {
  const latRadians = (latitude * Math.PI) / 180;
  const metersPerDegree = 111_320 * Math.cos(latRadians);
  if (!metersPerDegree) {
    return metersToLatDegrees(meters);
  }

  return meters / metersPerDegree;
};

const haversineDistance = (point1: LatLng, point2: LatLng): number => {
  const R = 6_371_000;
  const lat1 = (point1.latitude * Math.PI) / 180;
  const lat2 = (point2.latitude * Math.PI) / 180;
  const deltaLat = ((point2.latitude - point1.latitude) * Math.PI) / 180;
  const deltaLng = ((point2.longitude - point1.longitude) * Math.PI) / 180;

  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
};

// ---------------------------------------------------------------------------
// Spatial grid – O(1) proximity lookups (replaces O(n×m) brute-force)
// ---------------------------------------------------------------------------

/** ~111 m lat, ~70 m lng at UK latitudes */
const GRID_CELL_SIZE_DEG = 0.001;

interface SpatialGrid<T> {
  cells: Map<string, T[]>;
  cellSize: number;
}

const gridKey = (lat: number, lng: number, cellSize: number): string => {
  const row = Math.floor(lat / cellSize);
  const col = Math.floor(lng / cellSize);
  return `${row},${col}`;
};

const buildSpatialGrid = <T>(
  items: T[],
  getCoord: (item: T) => LatLng | undefined,
  cellSize: number = GRID_CELL_SIZE_DEG,
): SpatialGrid<T> => {
  const cells = new Map<string, T[]>();
  for (const item of items) {
    const coord = getCoord(item);
    if (!coord) continue;
    const key = gridKey(coord.latitude, coord.longitude, cellSize);
    let bucket = cells.get(key);
    if (!bucket) {
      bucket = [];
      cells.set(key, bucket);
    }
    bucket.push(item);
  }
  return { cells, cellSize };
};

/** Return items in the cell containing (lat, lng) AND its 8 neighbours. */
const queryGrid = <T>(grid: SpatialGrid<T>, lat: number, lng: number): T[] => {
  const results: T[] = [];
  const row = Math.floor(lat / grid.cellSize);
  const col = Math.floor(lng / grid.cellSize);
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const bucket = grid.cells.get(`${row + dr},${col + dc}`);
      if (bucket) results.push(...bucket);
    }
  }
  return results;
};

// ---------------------------------------------------------------------------
// Simple in-memory cache (keyed by route path hash)
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const cache = new Map<string, CacheEntry<unknown>>();

/** Simple hash of a LatLng[] – first/last points + length. */
const hashPath = (path: LatLng[]): string => {
  if (path.length === 0) return 'empty';
  const first = path[0];
  const last = path[path.length - 1];
  return `${first.latitude.toFixed(5)},${first.longitude.toFixed(5)}-${last.latitude.toFixed(5)},${last.longitude.toFixed(5)}-${path.length}`;
};

const getCached = <T>(key: string): T | null => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
};

const setCache = <T>(key: string, data: T): void => {
  cache.set(key, { data, timestamp: Date.now() });
};

// ---------------------------------------------------------------------------
// Route segmentation
// ---------------------------------------------------------------------------

type RouteSegment = {
  id: number;
  start: LatLng;
  end: LatLng;
  center: LatLng;
  length: number;
};

const splitRouteIntoSegments = (path: LatLng[], segmentLengthMeters: number): RouteSegment[] => {
  try {
    if (path.length < 2) return [];

    const segments: RouteSegment[] = [];
    let segmentId = 0;
    let currentDistance = 0;
    let segmentStart = path[0];
    let segmentStartIndex = 0;

    for (let i = 1; i < path.length; i++) {
      const distance = haversineDistance(path[i - 1], path[i]);
      currentDistance += distance;

      if (currentDistance >= segmentLengthMeters) {
        const segmentEnd = path[i];

        segments.push({
          id: segmentId,
          start: segmentStart,
          end: segmentEnd,
          center: {
            latitude: (segmentStart.latitude + segmentEnd.latitude) / 2,
            longitude: (segmentStart.longitude + segmentEnd.longitude) / 2,
          },
          length: currentDistance,
        });

        segmentId += 1;
        currentDistance = 0;
        segmentStart = segmentEnd;
        segmentStartIndex = i;
      }
    }

    // Add final segment if there's remaining distance
    if (currentDistance > 0 && segmentStartIndex < path.length - 1) {
      const segmentEnd = path[path.length - 1];
      segments.push({
        id: segmentId,
        start: segmentStart,
        end: segmentEnd,
        center: {
          latitude: (segmentStart.latitude + segmentEnd.latitude) / 2,
          longitude: (segmentStart.longitude + segmentEnd.longitude) / 2,
        },
        length: currentDistance,
      });
    }

    return segments;
  } catch (error) {
    console.error('[Safety] splitRouteIntoSegments: Error:', error);
    return [];
  }
};

// ---------------------------------------------------------------------------
// Path simplification — keep only every Nth point so the bbox stays tight
// and the route doesn't generate an unreasonably large Overpass query area.
// ---------------------------------------------------------------------------

const simplifyPath = (path: LatLng[], maxPoints = 60): LatLng[] => {
  if (path.length <= maxPoints) return path;
  const step = (path.length - 1) / (maxPoints - 1);
  const simplified: LatLng[] = [];
  for (let i = 0; i < maxPoints - 1; i++) {
    simplified.push(path[Math.round(i * step)]);
  }
  simplified.push(path[path.length - 1]); // always keep last point
  return simplified;
};

// ---------------------------------------------------------------------------
// Bounding box helpers
// ---------------------------------------------------------------------------

const computeBoundingBox = (path: LatLng[], bufferMeters: number): BoundingBox | null => {
  try {
    if (path.length === 0) return null;

    let minLat = path[0].latitude;
    let maxLat = path[0].latitude;
    let minLng = path[0].longitude;
    let maxLng = path[0].longitude;

    for (const point of path) {
      if (point.latitude < minLat) minLat = point.latitude;
      if (point.latitude > maxLat) maxLat = point.latitude;
      if (point.longitude < minLng) minLng = point.longitude;
      if (point.longitude > maxLng) maxLng = point.longitude;
    }

    const midLat = (minLat + maxLat) / 2;
    const latBuffer = metersToLatDegrees(bufferMeters);
    const lonBuffer = metersToLonDegrees(bufferMeters, midLat);

    return {
      minLat: minLat - latBuffer,
      maxLat: maxLat + latBuffer,
      minLng: minLng - lonBuffer,
      maxLng: maxLng + lonBuffer,
    };
  } catch (error) {
    console.error('[Safety] computeBoundingBox: Error:', error);
    return null;
  }
};

const buildPolygonFromBoundingBox = (bbox: BoundingBox): string =>
  `${bbox.minLat},${bbox.minLng}:${bbox.minLat},${bbox.maxLng}:${bbox.maxLat},${bbox.maxLng}:${bbox.maxLat},${bbox.minLng}`;

const getRecentMonthDate = (monthsAgo: number): string => {
  const now = new Date();
  now.setMonth(now.getMonth() - monthsAgo);
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
};

/**
 * Fetch all crimes for the entire route in a single API call
 */
export const fetchCrimesForRoute = async (
  path: LatLng[],
  bufferMeters = 75
): Promise<CrimeIncident[]> => {
  try {
    const cacheKey = `crimes:${hashPath(path)}`;
    const cached = getCached<CrimeIncident[]>(cacheKey);
    if (cached) return cached;

    const bbox = computeBoundingBox(path, bufferMeters);

    if (!bbox) {
      return [];
    }

    const polygon = buildPolygonFromBoundingBox(bbox);
    const dateParam = getRecentMonthDate(1);
    const url = `${POLICE_BASE_URL}/crimes-street/all-crime?poly=${encodeURIComponent(polygon)}&date=${dateParam}`;

    const data = await fetchJsonWithTimeout<unknown>(url, undefined, 8000);

    // Validate response is an array
    if (!Array.isArray(data)) {
      console.warn('[Safety] fetchCrimesForRoute: Response is not an array');
      return [];
    }

    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
    const cutoffYearMonth = `${twelveMonthsAgo.getFullYear()}-${String(twelveMonthsAgo.getMonth() + 1).padStart(2, '0')}`;

    const crimes = (data as PoliceCrimeApiItem[])
      .map((crime) => {
        const latitude = Number(crime.location?.latitude);
        const longitude = Number(crime.location?.longitude);

        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          return null;
        }

        const crimeMonth = crime.month ?? '';
        if (crimeMonth && crimeMonth < cutoffYearMonth) {
          return null;
        }

        return {
          category: crime.category ?? 'unknown',
          month: crimeMonth,
          location: {
            latitude,
            longitude,
          },
        } as CrimeIncident;
      })
      .filter((item): item is CrimeIncident => item !== null);

    setCache(cacheKey, crimes);
    return crimes;
  } catch (error) {
    console.error('[Safety] fetchCrimesForRoute: Error:', error);
    return [];
  }
};

export const fetchCrimesForSegment = async (
  segment: RouteSegment,
  bufferMeters = 75
): Promise<CrimeIncident[]> => {
  try {
    const bbox = computeBoundingBox([segment.start, segment.end], bufferMeters);

    if (!bbox) {
      return [];
    }

    const polygon = buildPolygonFromBoundingBox(bbox);
    const dateParam = getRecentMonthDate(1);
    const url = `${POLICE_BASE_URL}/crimes-street/all-crime?poly=${encodeURIComponent(polygon)}&date=${dateParam}`;

    const data = await fetchJson<unknown>(url);

    if (!Array.isArray(data)) return [];

    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
    const cutoffYearMonth = `${twelveMonthsAgo.getFullYear()}-${String(twelveMonthsAgo.getMonth() + 1).padStart(2, '0')}`;

    return (data as PoliceCrimeApiItem[])
      .map((crime) => {
        const latitude = Number(crime.location?.latitude);
        const longitude = Number(crime.location?.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
        const crimeMonth = crime.month ?? '';
        if (crimeMonth && crimeMonth < cutoffYearMonth) return null;
        return {
          category: crime.category ?? 'unknown',
          month: crimeMonth,
          location: { latitude, longitude },
        } as CrimeIncident;
      })
      .filter((item): item is CrimeIncident => item !== null);
  } catch (error) {
    console.error('[Safety] fetchCrimesForSegment: Error for segment', segment.id, ':', error);
    return [];
  }
};

type RoadWayData = {
  id: number;
  highway: string;
  lit: 'yes' | 'no' | 'unknown';
  isWellLit: boolean;
  name?: string;
  center?: LatLng;
};

/**
 * Fetch all highways for the entire route in a single API call
 */
export const fetchHighwaysForRoute = async (
  path: LatLng[],
  bufferMeters = 20
): Promise<{ stats: OverpassHighwayStats; ways: RoadWayData[] }> => {
  const emptyResult = {
    stats: {
      totalHighways: 0,
      unlitCount: 0,
      wellLitCount: 0,
      unknownLitCount: 0,
      byHighway: {} as Record<string, number>,
      roadSegments: [],
    },
    ways: [] as RoadWayData[],
  };

  try {
    if (path.length === 0) return emptyResult;

    const cacheKey = `highways:${hashPath(path)}`;
    const cached = getCached<{ stats: OverpassHighwayStats; ways: RoadWayData[] }>(cacheKey);
    if (cached) return cached;

    // Simplify the path so we don't create an absurdly large bounding box
    const simplified = simplifyPath(path, 60);
    const bbox = computeBoundingBox(simplified, bufferMeters);
    if (!bbox) return emptyResult;

    // Check if bbox is too large (> ~0.1° in both directions ≈ 10 km)
    const bboxArea = (bbox.maxLat - bbox.minLat) * (bbox.maxLng - bbox.minLng);

    // For very large areas use only the most common highway types
    const highwayFilter = bboxArea > 0.01
      ? '"highway"~"^(residential|living_street|secondary|tertiary|primary)$"'
      : '"highway"~"^(footway|path|pedestrian|steps|residential|living_street|secondary|tertiary|primary)$"';

    const query = `
      [out:json][timeout:15];
      (
        way[${highwayFilter}](${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng});
      );
      out tags center qt;
    `;

    const params = new URLSearchParams({ data: query });
    let response: any;
    try {
      response = await queueOverpassRequest<any>(params.toString(), 12000, 'highways');
    } catch {
      // Retry with a much smaller query — residential & primary only
      const fallbackQuery = `
        [out:json][timeout:10];
        (
          way["highway"~"^(residential|primary|secondary)$"](${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng});
        );
        out tags center qt;
      `;
      const fallbackParams = new URLSearchParams({ data: fallbackQuery });
      response = await queueOverpassRequest<any>(fallbackParams.toString(), 8000, 'highways-fallback');
    }

    const stats: OverpassHighwayStats = {
      totalHighways: 0,
      unlitCount: 0,
      wellLitCount: 0,
      unknownLitCount: 0,
      byHighway: {},
      roadSegments: [],
    };

    const ways: RoadWayData[] = [];

    for (const element of (response.elements ?? [])) {
      if (element.type !== 'way' || !element.tags) continue;

      const highway = element.tags.highway ?? 'unknown';
      const litValue = element.tags.lit;
      let lit: 'yes' | 'no' | 'unknown' = 'unknown';
      let isWellLit = false;

      if (litValue === 'yes' || litValue === 'night') {
        lit = 'yes';
        isWellLit = true;
        stats.wellLitCount += 1;
      } else if (litValue === 'no' || litValue === 'disused') {
        lit = 'no';
        stats.unlitCount += 1;
      } else {
        stats.unknownLitCount += 1;
      }

      stats.totalHighways += 1;
      stats.byHighway[highway] = (stats.byHighway[highway] ?? 0) + 1;

      const wayData: RoadWayData = {
        id: element.id ?? 0,
        highway,
        lit,
        isWellLit,
        name: element.tags.name,
      };

      if (element.center) {
        wayData.center = {
          latitude: element.center.lat,
          longitude: element.center.lon,
        };
      }

      ways.push(wayData);

      stats.roadSegments.push({
        id: element.id ?? 0,
        roadType: highway,
        lit,
        isWellLit,
        name: element.tags.name,
      });
    }

    const result = { stats, ways };
    setCache(cacheKey, result);
    return result;
  } catch (error) {
    console.error('[Safety] fetchHighwaysForRoute: Error:', error);
    return emptyResult;
  }
};

export const fetchHighwaysForSegment = async (
  segment: RouteSegment,
  bufferMeters = 15
): Promise<OverpassHighwayStats> => {
  const emptyStats: OverpassHighwayStats = {
    totalHighways: 0,
    unlitCount: 0,
    wellLitCount: 0,
    unknownLitCount: 0,
    byHighway: {},
    roadSegments: [],
  };

  try {
    const bbox = computeBoundingBox([segment.start, segment.end], bufferMeters);
    if (!bbox) return emptyStats;

    const query = `
      [out:json][timeout:15];
      (
        way["highway"~"^(footway|path|pedestrian|steps|residential|living_street|secondary|tertiary)$"](${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng});
      );
      out tags;
    `;

    const params = new URLSearchParams({ data: query });
    const response = await queueOverpassRequest<OverpassApiResponse>(params.toString(), 10000, 'segment-highways');

    const stats: OverpassHighwayStats = {
      totalHighways: 0,
      unlitCount: 0,
      wellLitCount: 0,
      unknownLitCount: 0,
      byHighway: {},
      roadSegments: [],
    };

    for (const element of (response.elements ?? [])) {
      if ((element as any).type !== 'way' || !element.tags) continue;

      const highway = element.tags.highway ?? 'unknown';
      const litValue = element.tags.lit;
      let lit: 'yes' | 'no' | 'unknown' = 'unknown';
      let isWellLit = false;

      if (litValue === 'yes' || litValue === 'night') {
        lit = 'yes';
        isWellLit = true;
        stats.wellLitCount += 1;
      } else if (litValue === 'no' || litValue === 'disused') {
        lit = 'no';
        stats.unlitCount += 1;
      } else {
        stats.unknownLitCount += 1;
      }

      stats.totalHighways += 1;
      stats.byHighway[highway] = (stats.byHighway[highway] ?? 0) + 1;

      stats.roadSegments.push({
        id: element.id ?? 0,
        roadType: highway,
        lit,
        isWellLit,
        name: element.tags.name,
      });
    }

    return stats;
  } catch (error) {
    console.error('[Safety] fetchHighwaysForSegment: Error for segment', segment.id, ':', error);
    return emptyStats;
  }
};

/**
 * Count places with human activity along a route using Overpass (OSM).
 * Completely FREE — no Google API calls needed.
 *
 * Uses the shared nearbyCache module so results are de-duplicated across
 * safetyMapData.ts and safety.ts — no double API calls for the same area.
 */
export const fetchOpenPlacesForRoute = async (path: LatLng[]): Promise<number> => {
  try {
    if (path.length === 0) return 0;

    const cacheKey = `openplaces:${hashPath(path)}`;
    const cached = getCached<number>(cacheKey);
    if (cached !== null) return cached;

    // Sample up to 3 points along the route (start + 1/3 + 2/3)
    // and fetch ALL in parallel for speed
    const samplePoints: LatLng[] = [path[0]];
    if (path.length > 4) {
      samplePoints.push(path[Math.floor(path.length / 3)]);
      samplePoints.push(path[Math.floor((path.length * 2) / 3)]);
    }

    const seenIds = new Set<string>();

    // Parallel fetch for all sample points
    const results = await Promise.all(
      samplePoints.map((center) =>
        fetchNearbyPlacesCached(center.latitude, center.longitude, 300).catch(() => []),
      ),
    );

    for (const places of results) {
      for (const place of places) {
        if (place.place_id) seenIds.add(place.place_id);
      }
    }

    const count = seenIds.size;
    setCache(cacheKey, count);
    return count;
  } catch (error) {
    console.error('[Safety] fetchOpenPlacesForRoute: Error:', error);
    return 0;
  }
};

/**
 * Fetch highway ways with node coordinates for segment-based analysis
 */
export const fetchWaysWithNodesForSegment = async (
  segment: RouteSegment,
  bufferMeters = 20,
): Promise<
  Array<{
    id: number;
    highway: string;
    lit: 'yes' | 'no' | 'unknown';
    nodes: LatLng[];
    name?: string;
  }>
> => {
  try {
    const bbox = computeBoundingBox([segment.start, segment.end], bufferMeters);

    if (!bbox) return [];

    const query = `
      [out:json][timeout:12];
      (
        way["highway"~"^(footway|path|pedestrian|steps|residential|living_street|secondary|tertiary|primary)$"](${bbox.minLat},${bbox.minLng},${bbox.maxLat},${bbox.maxLng});
      );
      out body center;
    `;

    const params = new URLSearchParams({ data: query });
    
    const response = await queueOverpassRequest<any>(params.toString(), 12000, 'ways-nodes');

    // Build a map of node IDs to coordinates
    const nodeCoordinates: Record<number, LatLng> = {};
    for (const element of (response.elements ?? [])) {
      if (element.type === 'node' && element.lat && element.lon) {
        nodeCoordinates[element.id] = {
          latitude: element.lat,
          longitude: element.lon,
        };
      }
    }

    const ways: Array<{
      id: number;
      highway: string;
      lit: 'yes' | 'no' | 'unknown';
      nodes: LatLng[];
      name?: string;
    }> = [];

    // Process ways
    for (const element of (response.elements ?? [])) {
      if (element.type !== 'way' || !element.tags) continue;

      const nodeIds: number[] = element.nodes ?? [];
      const nodes = nodeIds
        .map((id: number) => nodeCoordinates[id])
        .filter((node: LatLng | undefined): node is LatLng => node !== undefined);

      if (nodes.length < 2) continue;

      const highway = element.tags.highway ?? 'unknown';
      const litValue = element.tags.lit;
      let lit: 'yes' | 'no' | 'unknown' = 'unknown';

      if (litValue === 'yes' || litValue === 'night') {
        lit = 'yes';
      } else if (litValue === 'no' || litValue === 'disused') {
        lit = 'no';
      }

      ways.push({
        id: element.id ?? 0,
        highway,
        lit,
        nodes,
        name: element.tags.name,
      });
    }

    return ways;
  } catch (error) {
    console.error('[Safety] fetchWaysWithNodesForSegment: Error for segment', segment.id, ':', error);
    return [];
  }
};

export const fetchRouteSafetyBySegments = async (
  path: LatLng[],
  onProgress?: SafetyProgressCallback
): Promise<
  Array<{
    segment: RouteSegment;
    crimes: CrimeIncident[];
    highwayStats: OverpassHighwayStats;
    roadTypesSummary: Record<string, number>;
    openPlacesCount: number;
  }>
> => {
  if (path.length < 2) return [];

  try {
    // Determine segment length based on total route distance
    let totalDistance = 0;
    for (let i = 1; i < path.length; i++) {
      totalDistance += haversineDistance(path[i - 1], path[i]);
    }

    const distanceKm = (totalDistance / 1000).toFixed(1);
    onProgress?.(`📏 Route is ${distanceKm}km - preparing analysis...`, 10);

    const segmentLength = totalDistance > 1000 ? 80 : 50;
    const segments = splitRouteIntoSegments(path, segmentLength);

    if (segments.length === 0) return [];

    onProgress?.(`🗺️ Divided into ${segments.length} segments for detailed analysis`, 20);

    // Fetch all data for the entire route in parallel
    onProgress?.('🔍 Fetching safety data...', 30);

    const defaultHighwayData = {
      stats: {
        totalHighways: 0,
        unlitCount: 0,
        wellLitCount: 0,
        unknownLitCount: 0,
        byHighway: {} as Record<string, number>,
        roadSegments: [],
      },
      ways: [] as RoadWayData[],
    };

    const [allCrimes, highwayData, totalOpenPlaces] = await Promise.all([
      fetchCrimesForRoute(path, 75).catch(() => [] as CrimeIncident[]),
      fetchHighwaysForRoute(path, 20).catch(() => defaultHighwayData),
      fetchOpenPlacesForRoute(path).catch(() => 0),
    ]);

    onProgress?.(
      `📋 Found ${allCrimes.length} incidents, ${highwayData.ways.length} road segments, ${totalOpenPlaces} open places`,
      70,
    );
    onProgress?.('🔄 Mapping safety data to route segments...', 80);

    // ---- Build spatial grids for fast O(1) lookups ----
    const crimeGrid = buildSpatialGrid(allCrimes, (c) => c.location);
    const wayGrid = buildSpatialGrid(highwayData.ways, (w) => w.center);

    // Ways without a center coordinate can't be placed in the grid;
    // include them for every segment as a fallback.
    const waysWithoutCenter = highwayData.ways.filter((w) => !w.center);

    const openPlacesPerSegment =
      segments.length > 0 ? Math.round(totalOpenPlaces / segments.length) : 0;

    const results: Array<{
      segment: RouteSegment;
      crimes: CrimeIncident[];
      highwayStats: OverpassHighwayStats;
      roadTypesSummary: Record<string, number>;
      openPlacesCount: number;
    }> = [];

    for (const segment of segments) {
      try {
        const lat = segment.center.latitude;
        const lng = segment.center.longitude;

        // --- Crimes: spatial grid query then refine by haversine ---
        const crimeCandidates = queryGrid(crimeGrid, lat, lng);
        const segmentCrimes = crimeCandidates.filter(
          (crime) => haversineDistance(crime.location, segment.center) <= segmentLength,
        );

        // --- Ways: spatial grid query then refine ---
        const wayCandidates = queryGrid(wayGrid, lat, lng);
        const segmentWays = wayCandidates.filter(
          (way) => way.center && haversineDistance(way.center, segment.center) <= segmentLength,
        );
        const allSegmentWays = [...segmentWays, ...waysWithoutCenter];

        const segmentStats: OverpassHighwayStats = {
          totalHighways: allSegmentWays.length,
          unlitCount: allSegmentWays.filter((w) => w.lit === 'no').length,
          wellLitCount: allSegmentWays.filter((w) => w.lit === 'yes').length,
          unknownLitCount: allSegmentWays.filter((w) => w.lit === 'unknown').length,
          byHighway: {},
          roadSegments: allSegmentWays.map((w) => ({
            id: w.id,
            roadType: w.highway,
            lit: w.lit,
            isWellLit: w.isWellLit,
            name: w.name,
          })),
        };

        for (const way of allSegmentWays) {
          segmentStats.byHighway[way.highway] = (segmentStats.byHighway[way.highway] ?? 0) + 1;
        }

        results.push({
          segment,
          crimes: segmentCrimes,
          highwayStats: segmentStats,
          roadTypesSummary: segmentStats.byHighway,
          openPlacesCount: openPlacesPerSegment,
        });
      } catch (segmentError) {
        console.error('[Safety] Error processing segment', segment.id, ':', segmentError);
      }
    }

    return results;
  } catch (error) {
    console.error('[Safety] fetchRouteSafetyBySegments: Fatal error:', error);
    onProgress?.('⚠️ Some safety data unavailable, continuing with partial results...', 60);
    return [];
  }
};

export const fetchRouteSafetyBySegmentsWithDetails = async (
  path: LatLng[]
): Promise<
  Array<{
    segment: RouteSegment;
    crimes: CrimeIncident[];
    highwayStats: OverpassHighwayStats;
    roadTypesSummary: Record<string, number>;
    waysWithNodes: Array<{
      id: number;
      highway: string;
      lit: 'yes' | 'no' | 'unknown';
      nodes: LatLng[];
      name?: string;
    }>;
    openPlacesCount: number;
  }>
> => {
  try {
    const baseResults = await fetchRouteSafetyBySegments(path);
    return baseResults.map((result) => ({ ...result, waysWithNodes: [] }));
  } catch (error) {
    console.error('[Safety] fetchRouteSafetyBySegmentsWithDetails: Error:', error);
    return [];
  }
};

/**
 * Fetch aggregated safety summary for a route.
 * Aggregates all segment data into a single summary.
 */
export const fetchRouteSafetySummary = async (
  path: LatLng[],
  onProgress?: SafetyProgressCallback
): Promise<SafetySummary> => {
  try {
    onProgress?.('🔍 Analyzing your route...', 0);

    const segmentResults = await fetchRouteSafetyBySegments(path, onProgress);

    onProgress?.('📊 Compiling safety report...', 90);

    const allCrimes: CrimeIncident[] = [];
    const aggregatedHighwayStats: OverpassHighwayStats = {
      totalHighways: 0,
      unlitCount: 0,
      wellLitCount: 0,
      unknownLitCount: 0,
      byHighway: {},
      roadSegments: [],
    };
    let totalOpenPlaces = 0;

    for (const result of segmentResults) {
      allCrimes.push(...result.crimes);

      aggregatedHighwayStats.totalHighways += result.highwayStats.totalHighways;
      aggregatedHighwayStats.unlitCount += result.highwayStats.unlitCount;
      aggregatedHighwayStats.wellLitCount += result.highwayStats.wellLitCount;
      aggregatedHighwayStats.unknownLitCount += result.highwayStats.unknownLitCount;

      for (const [highway, count] of Object.entries(result.highwayStats.byHighway)) {
        aggregatedHighwayStats.byHighway[highway] =
          (aggregatedHighwayStats.byHighway[highway] ?? 0) + count;
      }

      aggregatedHighwayStats.roadSegments.push(...result.highwayStats.roadSegments);
      totalOpenPlaces += result.openPlacesCount;
    }

    onProgress?.('✅ Safety analysis complete!', 100);

    return {
      crimeCount: allCrimes.length,
      crimes: allCrimes,
      highwayStats: aggregatedHighwayStats,
      openPlacesCount: totalOpenPlaces,
    };
  } catch (error) {
    console.error('[Safety] fetchRouteSafetySummary: Error:', error);
    onProgress?.('❌ Unable to complete safety analysis', 0);

    if (error instanceof AppError) throw error;
    throw new AppError('safety_summary_error', 'Unable to load safety data', error);
  }
};
