const {
  shouldKeepWay,
  filterWayTags,
  shouldKeepNode,
  filterNodeTags,
  HIGHWAY_KEEP,
} = require('../../src/filter');

describe('filter', () => {
  test('shouldKeepWay keeps valid highways', () => {
    expect(shouldKeepWay({ highway: 'residential' })).toBe(true);
    expect(shouldKeepWay({ highway: 'primary' })).toBe(true);
    expect(shouldKeepWay({ highway: 'motorway' })).toBe(false);
    expect(shouldKeepWay({})).toBe(false);
  });

  test('filterWayTags keeps only safety-relevant tags', () => {
    const tags = {
      highway: 'residential',
      name: 'High Street',
      lit: 'yes',
      sidewalk: 'both',
      surface: 'asphalt',
      building: 'yes',
      source: 'survey',
    };
    const filtered = filterWayTags(tags);
    expect(filtered).toEqual({
      highway: 'residential',
      name: 'High Street',
      lit: 'yes',
      sidewalk: 'both',
      surface: 'asphalt',
    });
  });

  test('shouldKeepNode keeps street lamps', () => {
    expect(shouldKeepNode({ highway: 'street_lamp' })).toBe(true);
    expect(shouldKeepNode({ man_made: 'surveillance' })).toBe(true);
    expect(shouldKeepNode({ highway: 'bus_stop' })).toBe(true);
    expect(shouldKeepNode({ amenity: 'cafe' })).toBe(true);
    expect(shouldKeepNode({ shop: 'supermarket' })).toBe(true);
    expect(shouldKeepNode({ railway: 'station' })).toBe(true);
    expect(shouldKeepNode({ station: 'subway' })).toBe(true);
    expect(shouldKeepNode({ highway: 'crossing' })).toBe(false);
  });

  test('filterNodeTags keeps relevant node tags', () => {
    const tags = {
      highway: 'street_lamp',
      source: 'survey',
      created_by: 'JOSM',
    };
    const filtered = filterNodeTags(tags);
    expect(filtered).toEqual({ highway: 'street_lamp' });
  });
});
