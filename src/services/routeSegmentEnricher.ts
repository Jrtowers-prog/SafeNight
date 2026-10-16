/**
 * Service to enrich routes with segment-level safety data
 * Segments are 50m chunks with lighting, crime, and combined scores
 *
 * Uses a spatial grid index for O(1) lookups instead of O(n×m) brute-force.
 */

import type { DirectionsRoute, LatLng, RouteSegment } from '@/src/types/geo';
import type { CrimeIncident, RoadSegment, SafetySummary } from '@/src/types/safety';
import { scoreToColor } from '@/src/utils/colorCode';
import { isNighttime } from '@/src/utils/lightingScore';
import { calculateDistance, segmentRoute } from '@/src/utils/segmentRoute';

// ---------------------------------------------------------------------------
// Spatial grid – O(1) proximity lookups
// ---------------------------------------------------------------------------

/** Roughly 100 m expressed in degrees at UK latitudes (~50-55°N). */
const GRID_CELL_SIZE_DEG = 0.001; // ~111 m lat, ~70 m lng at 51°

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
      const key = `${row + dr},${col + dc}`;
      const bucket = grid.cells.get(key);
      if (bucket) results.push(...bucket);
    }
  }
  return results;
};

// ---------------------------------------------------------------------------
// Per-segment scoring helpers
// ---------------------------------------------------------------------------

const calculateSegmentLightingScore = (
  segment: { midpointCoord: LatLng },
  nearbyRoads: RoadSegment[],
): number => {
  if (nearbyRoads.length === 0) {
    return isNighttime() ? 0.3 : 0.7;
  }

  let litCount = 0;
  for (const road of nearbyRoads) {
    if (road.isWellLit) litCount++;
  }

  const baseLightingScore = litCount / nearbyRoads.length;

  if (isNighttime()) {
    return baseLightingScore;
  }
  return 0.7 + baseLightingScore * 0.3;
};

const calculateSegmentCrimeScore = (
  nearbyCrimeCount: number,
): number => {
  // 0 crimes → 1.0 (safe), 5+ crimes → 0.0 (danger)
  return Math.max(0, 1 - nearbyCrimeCount / 5);
};

const WEIGHTS = { lighting: 0.3, crime: 0.4, activity: 0.3 } as const;

const calculateCombinedScore = (
  lightingScore: number,
  crimeScore: number,
  activityScore: number,
): number =>
  lightingScore * WEIGHTS.lighting +
  crimeScore * WEIGHTS.crime +
  activityScore * WEIGHTS.activity;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enrich a route with segment-level safety data.
 *
 * Accepts an optional pre-computed segments array to avoid re-segmenting the
 * route (the same segments from safety.ts are reused).
 */
export const enrichRouteWithSegments = (
  route: DirectionsRoute,
  safetySummary: SafetySummary | null,
  precomputedSegments?: ReturnType<typeof segmentRoute>,
): DirectionsRoute => {
  if (!route.path || route.path.length < 2) {
    return route;
  }

  try {
    // Re-use segments when provided, otherwise compute once
    const baseSegments = precomputedSegments ?? segmentRoute(route.path, 50);

    if (baseSegments.length === 0) {
      return route;
    }

    // Extract source data with safe defaults
    const crimes: CrimeIncident[] = safetySummary?.crimes ?? [];
    const roadSegments: RoadSegment[] =
      safetySummary?.highwayStats?.roadSegments ?? [];

    // Build spatial grids for O(1) lookups
    const crimeGrid = buildSpatialGrid(crimes, (c) => c.location);
    // roadSegments don't carry coordinates on the RoadSegment type, so we
    // apply a simplified approach: use the full list for every segment (these
    // are already filtered to the route's bounding box by the Overpass query).
    // This is fast because the list is small (~10-50 items).

    // Activity score is a constant for now
    const activityScore = 0.6;

    const enrichedSegments: RouteSegment[] = baseSegments.map((seg) => {
      const mid = seg.midpointCoord;

      // --- Crime: query spatial grid then refine by distance ---
      const crimeCandidates = queryGrid(crimeGrid, mid.latitude, mid.longitude);
      let crimeCount = 0;
      for (const crime of crimeCandidates) {
        if (calculateDistance(mid, crime.location) <= 30) {
          crimeCount++;
        }
      }
      const crimeScore = calculateSegmentCrimeScore(crimeCount);

      // --- Lighting: use all road segments (already route-scoped) ---
      const lightingScore = calculateSegmentLightingScore(seg, roadSegments);

      const combinedScore = calculateCombinedScore(
        lightingScore,
        crimeScore,
        activityScore,
      );

      const { color } = scoreToColor(combinedScore);

      return {
        startCoord: seg.startCoord,
        endCoord: seg.endCoord,
        midpointCoord: seg.midpointCoord,
        distanceMeters: seg.length,
        lightingScore,
        crimeScore,
        activityScore,
        combinedScore,
        color,
      };
    });

    return {
      ...route,
      segments: enrichedSegments,
    };
  } catch (error) {
    console.error('Error enriching route with segments:', error);
    return route;
  }
};
