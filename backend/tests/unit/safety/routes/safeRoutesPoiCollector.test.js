const { collectRoutePOIs } = require('../../../../src/safety/routes/safeRoutesPoiCollector');

describe('safeRoutesPoiCollector', () => {
  test('collects only CCTV points near the indexed route path', () => {
    const routePath = ['a', 'b'];
    const osmNodes = new Map([
      ['a', { lat: 50.0, lng: -4.0 }],
      ['b', { lat: 50.0001, lng: -4.0001 }],
    ]);

    const result = collectRoutePOIs(
      routePath,
      osmNodes,
      [
        { lat: 50.00011, lng: -4.0001 },
        { lat: 50.002, lng: -4.002 },
      ],
      [],
      new Map(),
      [],
      [],
      [],
    );

    expect(result.cctv).toEqual([{ lat: 50.00011, lng: -4.0001 }]);
  });

  test('deduplicates dead-end nodes with identical rounded coordinates', () => {
    const routePath = ['a', 'b'];
    const osmNodes = new Map([
      ['a', { lat: 50.0, lng: -4.0 }],
      ['b', { lat: 50.0000004, lng: -4.0000004 }],
    ]);
    const nodeDegree = new Map([
      ['a', 1],
      ['b', 1],
    ]);

    const result = collectRoutePOIs(
      routePath,
      osmNodes,
      [],
      [],
      nodeDegree,
      [],
      [],
      [],
    );

    expect(result.deadEnds).toHaveLength(1);
  });

  test('preserves place metadata for nearby places', () => {
    const routePath = ['a'];
    const osmNodes = new Map([
      ['a', { lat: 50.0, lng: -4.0 }],
    ]);

    const result = collectRoutePOIs(
      routePath,
      osmNodes,
      [],
      [],
      new Map(),
      [],
      [
        {
          lat: 50.0001,
          lng: -4.0,
          name: 'Late Cafe',
          amenity: 'cafe',
          open: true,
          nextChange: '22:00',
          opening_hours: 'Mo-Su 08:00-22:00',
        },
      ],
      [],
    );

    expect(result.places[0]).toMatchObject({
      name: 'Late Cafe',
      amenity: 'cafe',
      open: true,
      nextChange: '22:00',
      opening_hours: 'Mo-Su 08:00-22:00',
    });
  });
});
