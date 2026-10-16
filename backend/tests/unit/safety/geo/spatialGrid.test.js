const {
  buildSpatialGrid,
  findNearby,
  countNearby,
} = require('../../../../src/safety/services/geo');

describe('spatial grid helpers', () => {
  const points = [
    { lat: 50.3700, lng: -4.1400, id: 'a' },
    { lat: 50.3702, lng: -4.1402, id: 'b' },
    { lat: 50.3900, lng: -4.1700, id: 'c' },
  ];

  test('buildSpatialGrid creates a populated grid', () => {
    const spatial = buildSpatialGrid(points);

    expect(spatial.grid.size).toBeGreaterThan(0);
  });

  test('findNearby returns only nearby items', () => {
    const spatial = buildSpatialGrid(points);
    const nearby = findNearby(spatial, 50.37, -4.14, 80);

    expect(nearby.every((item) => item.id !== 'c')).toBe(true);
  });

  test('countNearby returns nearby item count', () => {
    const spatial = buildSpatialGrid(points);
    const count = countNearby(spatial, 50.37, -4.14, 80);

    expect(count).toBe(2);
  });
});
