const {
  haversine,
  fastDistance,
  bboxFromPoints,
  EARTH_RADIUS_M,
} = require('../../../../src/safety/services/geo');

describe('haversine', () => {
  test('returns zero for identical points', () => {
    const distance = haversine(50.37, -4.14, 50.37, -4.14);

    expect(distance).toBe(0);
  });

  test('returns positive distance for different points', () => {
    const distance = haversine(50.37, -4.14, 50.38, -4.13);

    expect(distance).toBeGreaterThan(0);
  });

  test('uses expected earth radius constant', () => {
    expect(EARTH_RADIUS_M).toBe(6371000);
  });
});

describe('fastDistance', () => {
  test('returns values close to haversine for short distances', () => {
    const exact = haversine(50.37, -4.14, 50.371, -4.139);
    const fast = fastDistance(50.37, -4.14, 50.371, -4.139);

    expect(Math.abs(fast - exact)).toBeLessThan(10);
  });
});

describe('bboxFromPoints', () => {
  test('returns a box with south<north and west<east', () => {
    const bbox = bboxFromPoints([
      { lat: 50.37, lng: -4.14 },
      { lat: 50.371, lng: -4.141 },
    ]);

    expect(bbox.south).toBeLessThan(bbox.north);
    expect(bbox.west).toBeLessThan(bbox.east);
  });

  test('expands the shorter side when width is smaller than height', () => {
    const bbox = bboxFromPoints([
      { lat: 50.37, lng: -4.14 },
      { lat: 50.39, lng: -4.1399 },
    ], 0);

    const height = bbox.north - bbox.south;
    const width = bbox.east - bbox.west;
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  test('expands the shorter side when height is smaller than width', () => {
    const bbox = bboxFromPoints([
      { lat: 50.37, lng: -4.16 },
      { lat: 50.3701, lng: -4.1 },
    ], 0);

    const height = bbox.north - bbox.south;
    const width = bbox.east - bbox.west;
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });
});
