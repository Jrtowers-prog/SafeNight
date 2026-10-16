import {
  calculateDistance,
  findNearestSegment,
  getTotalDistance,
  interpolatePoint,
  segmentRoute,
} from '@/src/utils/segmentRoute';

describe('segmentRoute utilities', () => {
  const path = [
    { latitude: 51.5007, longitude: -0.1246 },
    { latitude: 51.5017, longitude: -0.1246 },
    { latitude: 51.5027, longitude: -0.1246 },
    { latitude: 51.5037, longitude: -0.1246 },
  ];

  it('returns no segments for paths shorter than two points', () => {
    expect(segmentRoute([], 50)).toEqual([]);
    expect(segmentRoute([path[0]], 50)).toEqual([]);
  });

  it('calculates distance and interpolation correctly', () => {
    const dist = calculateDistance(path[0], path[1]);
    expect(dist).toBeGreaterThan(100);

    const midpoint = interpolatePoint(path[0], path[1], 0.5);
    expect(midpoint.latitude).toBeCloseTo((path[0].latitude + path[1].latitude) / 2, 6);
    expect(midpoint.longitude).toBeCloseTo(path[0].longitude, 6);
  });

  it('segments route with expected distances and ids', () => {
    const segments = segmentRoute(path, 200);

    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0].id).toBe(0);
    expect(segments[0].startDistance).toBe(0);

    const totalDistance = getTotalDistance(segments);
    expect(totalDistance).toBeGreaterThan(0);
  });

  it('finds nearest segment midpoint to a point', () => {
    const segments = segmentRoute(path, 200);
    const nearest = findNearestSegment({ latitude: 51.5036, longitude: -0.1246 }, segments);

    expect(nearest).not.toBeNull();
    expect(nearest?.id).toBe(segments[segments.length - 1].id);
  });

  it('returns null when finding nearest segment in empty list', () => {
    expect(findNearestSegment(path[0], [])).toBeNull();
  });
});
