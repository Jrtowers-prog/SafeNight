/**
 * Route segmentation utility to split routes into uniform 50m segments
 * for detailed analysis and color coding
 */

import type { LatLng } from '@/src/types/geo';

const EARTH_RADIUS_METERS = 6371000;

/**
 * Calculate distance between two points using Haversine formula
 * @param point1 - First coordinate
 * @param point2 - Second coordinate
 * @returns Distance in meters
 */
export const calculateDistance = (point1: LatLng, point2: LatLng): number => {
  const lat1Rad = (point1.latitude * Math.PI) / 180;
  const lat2Rad = (point2.latitude * Math.PI) / 180;
  const deltaLatRad = ((point2.latitude - point1.latitude) * Math.PI) / 180;
  const deltaLngRad = ((point2.longitude - point1.longitude) * Math.PI) / 180;

  const a =
    Math.sin(deltaLatRad / 2) * Math.sin(deltaLatRad / 2) +
    Math.cos(lat1Rad) *
      Math.cos(lat2Rad) *
      Math.sin(deltaLngRad / 2) *
      Math.sin(deltaLngRad / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
};

/**
 * Interpolate between two points
 * @param point1 - Start point
 * @param point2 - End point
 * @param fraction - Fraction between 0 and 1
 * @returns Interpolated point
 */
export const interpolatePoint = (
  point1: LatLng,
  point2: LatLng,
  fraction: number,
): LatLng => {
  return {
    latitude: point1.latitude + (point2.latitude - point1.latitude) * fraction,
    longitude: point1.longitude + (point2.longitude - point1.longitude) * fraction,
  };
};

export interface RouteSegment {
  id: number;
  index: number;
  startCoord: LatLng;
  endCoord: LatLng;
  midpointCoord: LatLng;
  length: number; // in meters
  startDistance: number; // cumulative distance from start of route
  endDistance: number; // cumulative distance from start of route
}

/**
 * Split a route into uniform segments of approximately targetLength meters
 * @param path - Array of coordinates representing the route
 * @param targetLength - Target segment length in meters (default 50m)
 * @returns Array of RouteSegment objects
 */
export const segmentRoute = (
  path: LatLng[],
  targetLength: number = 50,
): RouteSegment[] => {
  if (path.length < 2) {
    return [];
  }

  const segments: RouteSegment[] = [];
  let segmentId = 0;
  let currentDistance = 0; // Distance along the route so far
  let pathPointIndex = 0; // Current position in the path array

  while (pathPointIndex < path.length - 1) {
    const segmentStartCoord = path[pathPointIndex];
    const segmentStartDistance = currentDistance;
    let segmentLength = 0;
    let segmentEndCoord = path[pathPointIndex];
    let nextPathPointIndex = pathPointIndex;

    // Accumulate path points until we reach approximately targetLength
    while (
      nextPathPointIndex < path.length - 1 &&
      segmentLength < targetLength
    ) {
      const point1 = path[nextPathPointIndex];
      const point2 = path[nextPathPointIndex + 1];
      const distance = calculateDistance(point1, point2);

      if (segmentLength + distance <= targetLength) {
        // Include this entire segment
        segmentLength += distance;
        nextPathPointIndex += 1;
        segmentEndCoord = point2;
      } else {
        // Partial segment - interpolate to reach exactly targetLength
        const remainingDistance = targetLength - segmentLength;
        const fraction = remainingDistance / distance;
        segmentEndCoord = interpolatePoint(point1, point2, fraction);
        segmentLength += remainingDistance;
        break;
      }
    }

    // If we've reached the last point and haven't accumulated enough distance,
    // just use the remaining segment
    if (nextPathPointIndex === path.length - 1 && segmentLength < targetLength) {
      const lastPoint = path[path.length - 1];
      if (segmentEndCoord !== lastPoint) {
        segmentLength = calculateDistance(segmentStartCoord, lastPoint);
        segmentEndCoord = lastPoint;
      }
    }

    // Create the segment
    const midpoint = interpolatePoint(
      segmentStartCoord,
      segmentEndCoord,
      0.5,
    );

    segments.push({
      id: segmentId,
      index: segmentId,
      startCoord: segmentStartCoord,
      endCoord: segmentEndCoord,
      midpointCoord: midpoint,
      length: segmentLength,
      startDistance: segmentStartDistance,
      endDistance: segmentStartDistance + segmentLength,
    });

    segmentId += 1;
    currentDistance += segmentLength;
    pathPointIndex = nextPathPointIndex;

    // Avoid infinite loop if we're not making progress
    if (segmentLength === 0) {
      pathPointIndex += 1;
    }
  }

  return segments;
};

/**
 * Get total route distance from segments
 */
export const getTotalDistance = (segments: RouteSegment[]): number => {
  if (segments.length === 0) return 0;
  const lastSegment = segments[segments.length - 1];
  return lastSegment.endDistance;
};

/**
 * Find which segment a point (lat/lng) is closest to
 */
export const findNearestSegment = (
  point: LatLng,
  segments: RouteSegment[],
): RouteSegment | null => {
  if (segments.length === 0) return null;

  let nearest = segments[0];
  let minDistance = calculateDistance(point, segments[0].midpointCoord);

  for (let i = 1; i < segments.length; i++) {
    const distance = calculateDistance(point, segments[i].midpointCoord);
    if (distance < minDistance) {
      minDistance = distance;
      nearest = segments[i];
    }
  }

  return nearest;
};
