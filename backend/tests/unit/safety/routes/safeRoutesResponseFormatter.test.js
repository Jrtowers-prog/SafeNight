/* eslint-env jest */

jest.mock('../../../../src/safety/routes/safeRoutesUtils', () => ({
  checkOpenNow: jest.fn(() => ({ open: true, nextChange: 'closes at 22:00' })),
  heuristicOpen: jest.fn(() => ({ open: true, nextChange: 'opens at 07:00' })),
  safetyLabel: jest.fn(() => ({ label: 'Safe', color: '#558B2F' })),
  segmentColor: jest.fn(() => '#4CAF50'),
}));

jest.mock('../../../../src/safety/routes/safeRoutesPoiCollector', () => ({
  collectRoutePOIs: jest.fn(() => ({
    cctv: [],
    transit: [],
    deadEnds: [],
    lights: [],
    places: [],
    crimes: [],
  })),
}));

jest.mock('../../../../src/safety/services/safetyGraph', () => ({
  routeToPolyline: jest.fn(() => [
    { lat: 50.37, lng: -4.14 },
    { lat: 50.38, lng: -4.13 },
  ]),
  routeSafetyBreakdown: jest.fn(() => ({
    overall: 0.61,
    roadType: 0.6,
    lighting: 0.6,
    crime: 0.6,
    cctv: 0.6,
    openPlaces: 0.6,
    traffic: 0.6,
    roadTypes: { residential: 100 },
    mainRoadRatio: 0.2,
  })),
}));

jest.mock('../../../../src/safety/services/geo', () => ({
  encodePolyline: jest.fn(() => 'encoded'),
}));

const {
  collectLightNodes,
  collectOpenPlaceNodes,
  buildRouteResponses,
} = require('../../../../src/safety/routes/safeRoutesResponseFormatter');
const safeRoutesUtils = require('../../../../src/safety/routes/safeRoutesUtils');
const {
  collectRoutePOIs,
} = require('../../../../src/safety/routes/safeRoutesPoiCollector');

describe('safeRoutesResponseFormatter', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('collectLightNodes keeps only street lamp nodes with coordinates', () => {
    const result = collectLightNodes([
      { type: 'node', tags: { highway: 'street_lamp' }, lat: 50.1, lon: -4.1 },
      { type: 'node', tags: { highway: 'bus_stop' }, lat: 50.2, lon: -4.2 },
      { type: 'way', tags: { highway: 'street_lamp' }, lat: 50.3, lon: -4.3 },
    ]);

    expect(result).toEqual([{ lat: 50.1, lng: -4.1 }]);
  });

  test('collectOpenPlaceNodes keeps open places and maps metadata', () => {
    const result = collectOpenPlaceNodes(
      [
        {
          lat: 50.37,
          lon: -4.14,
          tags: {
            name: 'Cafe',
            amenity: 'cafe',
            opening_hours: 'Mo-Su 08:00-18:00',
          },
        },
      ],
      true,
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      lat: 50.37,
      lng: -4.14,
      name: 'Cafe',
      amenity: 'cafe',
      open: true,
    });
  });

  test('collectOpenPlaceNodes filters closed places when heuristic reports closed', () => {
    safeRoutesUtils.heuristicOpen.mockReturnValueOnce({
      open: false,
      nextChange: 'opens at 07:00',
    });

    const result = collectOpenPlaceNodes(
      [
        {
          lat: 50.37,
          lon: -4.14,
          tags: {
            name: 'Night Closed Cafe',
            amenity: 'cafe',
          },
        },
      ],
      false,
    );

    expect(result).toEqual([]);
  });

  test('collectOpenPlaceNodes uses heuristic branch when parser is disabled', () => {
    safeRoutesUtils.heuristicOpen.mockReturnValueOnce({
      open: true,
      nextChange: 'closes at 20:00',
    });

    const result = collectOpenPlaceNodes(
      [
        {
          lat: 50.37,
          lon: -4.14,
          tags: {
            name: 'Heuristic Place',
            amenity: 'library',
          },
        },
      ],
      false,
    );

    expect(result).toHaveLength(1);
    expect(result[0].nextChange).toBe('closes at 20:00');
  });

  test('buildRouteResponses returns route payload with expected shape', () => {
    const responseRoutes = buildRouteResponses({
      rawRoutes: [
        {
          path: ['n1', 'n2', 'n3'],
          edges: [0, 1],
          totalDist: 1400,
        },
      ],
      osmNodes: new Map([
        ['n1', { lat: 50.37, lng: -4.14 }],
        ['n2', { lat: 50.38, lng: -4.13 }],
        ['n3', { lat: 50.38, lng: -4.13 }],
      ]),
      edges: [
        {
          from: 'n1',
          to: 'n2',
          distance: 700,
          safetyScore: 0.6,
          highway: 'residential',
          roadName: 'Main St',
          isDeadEnd: false,
          hasSidewalk: true,
          surfacePenalty: 0,
          surfaceType: 'paved',
          lightScore: 0.7,
          crimeScore: 0.8,
          cctvScore: 0.4,
          placeScore: 0.3,
          trafficScore: 0.5,
          nearbyTransitCount: 2,
          nearbyCctvCount: 1,
        },
        {
          from: 'n2',
          to: 'n3',
          distance: 700,
          safetyScore: 0.45,
          highway: 'path',
          roadName: '',
          isDeadEnd: false,
          hasSidewalk: false,
          surfacePenalty: 0,
          surfaceType: 'gravel',
          lightScore: 0.1,
          crimeScore: 0.9,
          cctvScore: 0.0,
          placeScore: 0.05,
          trafficScore: 0.1,
          nearbyTransitCount: 0,
          nearbyCctvCount: 0,
        },
      ],
      weights: {},
      cctvNodes: [],
      transitNodes: [],
      nodeDegree: new Map(),
      crimes: [],
      allData: {
        lights: { elements: [] },
        places: { elements: [] },
      },
      oLat: 50.37,
      oLng: -4.14,
      dLat: 50.38,
      dLng: -4.13,
      enableOpeningHoursParse: false,
      edgeConfidences: [
        { score: 0, reason: 'explicit_lit_no', needsVerification: true },
        { score: 0.35, reason: 'uncertain', needsVerification: false },
      ],
    });

    expect(responseRoutes).toHaveLength(1);
    expect(responseRoutes[0]).toMatchObject({
      routeIndex: 0,
      isSafest: true,
      overview_polyline: { points: 'encoded' },
      summary: 'Safest Route',
      safety: {
        score: 61,
        label: 'Safe',
        color: '#558B2F',
      },
      routeStats: {
        deadEnds: 0,
        sidewalkPct: 50,
      },
    });
    expect(responseRoutes[0].segments).toHaveLength(2);
    expect(responseRoutes[0].lightUncertaintySpans).toHaveLength(1);
    expect(responseRoutes[0].generalUncertaintyBoxes).toHaveLength(1);
  });

  test('buildRouteResponses in compact mode excludes heavy fields', () => {
    const responseRoutes = buildRouteResponses({
      rawRoutes: [
        {
          path: ['n1', 'n2'],
          edges: [0],
          totalDist: 1000,
        },
      ],
      osmNodes: new Map([
        ['n1', { lat: 50.37, lng: -4.14 }],
        ['n2', { lat: 50.38, lng: -4.13 }],
      ]),
      edges: [
        {
          distance: 1000,
          safetyScore: 0.6,
          highway: 'residential',
          roadName: 'Main St',
          isDeadEnd: false,
          hasSidewalk: true,
          surfacePenalty: 0,
          surfaceType: 'paved',
          lightScore: 0.7,
          crimeScore: 0.8,
          cctvScore: 0.4,
          placeScore: 0.3,
          trafficScore: 0.5,
          nearbyTransitCount: 2,
          nearbyCctvCount: 1,
        },
      ],
      weights: {},
      cctvNodes: [],
      transitNodes: [],
      nodeDegree: new Map(),
      crimes: [],
      allData: {
        lights: { elements: [] },
        places: { elements: [] },
      },
      oLat: 50.37,
      oLng: -4.14,
      dLat: 50.38,
      dLng: -4.13,
      enableOpeningHoursParse: false,
      responsePolicy: {
        verbosity: 'compact',
        poiCaps: {
          cctv: 10,
          transit: 10,
          deadEnds: 10,
          lights: 10,
          places: 10,
          crimes: 10,
        },
      },
    });

    const route = responseRoutes[0];
    expect(route.legs).toBeUndefined();
    expect(route.segments).toBeUndefined();
    expect(route.distance).toMatchObject({ value: 1000 });
    expect(route.duration).toMatchObject({ value: expect.any(Number) });
    expect(route.safety.breakdown).toBeDefined();
    expect(route.routeStats.roadNameChanges).toBeUndefined();
  });

  test('buildRouteResponses enforces poi caps for full mode', () => {
    collectRoutePOIs.mockReturnValueOnce({
      cctv: [
        { lat: 50.37001, lng: -4.14001 },
        { lat: 50.37100, lng: -4.14100 },
        { lat: 50.37200, lng: -4.14200 },
      ],
      transit: [
        { lat: 50.37002, lng: -4.14002 },
        { lat: 50.37300, lng: -4.14300 },
      ],
      deadEnds: [
        { lat: 50.37003, lng: -4.14003 },
        { lat: 50.37400, lng: -4.14400 },
      ],
      lights: [
        { lat: 50.37004, lng: -4.14004 },
        { lat: 50.37500, lng: -4.14500 },
      ],
      places: [
        { lat: 50.37005, lng: -4.14005, name: 'A', amenity: 'cafe' },
        { lat: 50.37600, lng: -4.14600, name: 'B', amenity: 'shop' },
      ],
      crimes: [
        { lat: 50.37006, lng: -4.14006, category: 'theft' },
        { lat: 50.37700, lng: -4.14700, category: 'burglary' },
      ],
    });

    const responseRoutes = buildRouteResponses({
      rawRoutes: [
        {
          path: ['n1', 'n2'],
          edges: [0],
          totalDist: 1000,
        },
      ],
      osmNodes: new Map([
        ['n1', { lat: 50.37, lng: -4.14 }],
        ['n2', { lat: 50.38, lng: -4.13 }],
      ]),
      edges: [
        {
          distance: 1000,
          safetyScore: 0.6,
          highway: 'residential',
          roadName: 'Main St',
          isDeadEnd: false,
          hasSidewalk: true,
          surfacePenalty: 0,
          surfaceType: 'paved',
          lightScore: 0.7,
          crimeScore: 0.8,
          cctvScore: 0.4,
          placeScore: 0.3,
          trafficScore: 0.5,
          nearbyTransitCount: 2,
          nearbyCctvCount: 1,
        },
      ],
      weights: {},
      cctvNodes: [],
      transitNodes: [],
      nodeDegree: new Map(),
      crimes: [],
      allData: {
        lights: { elements: [] },
        places: { elements: [] },
      },
      oLat: 50.37,
      oLng: -4.14,
      dLat: 50.38,
      dLng: -4.13,
      enableOpeningHoursParse: false,
      responsePolicy: {
        verbosity: 'full',
        poiCaps: {
          cctv: 2,
          transit: 1,
          deadEnds: 1,
          lights: 1,
          places: 1,
          crimes: 1,
        },
      },
    });

    const route = responseRoutes[0];
    expect(route.segments).toHaveLength(1);
    expect(route.routePOIs.cctv).toHaveLength(2);
    expect(route.routePOIs.transit).toHaveLength(1);
    expect(route.routePOIs.deadEnds).toHaveLength(1);
    expect(route.routePOIs.lights).toHaveLength(1);
    expect(route.routePOIs.places).toHaveLength(1);
    expect(route.routePOIs.crimes).toHaveLength(1);
    expect(route.routePOIs.cctv[0]).toEqual({ lat: 50.37001, lng: -4.14001 });
  });
});
