/* eslint-env jest */
const {
  buildSafeRoutesMeta,
} = require('../../../../src/safety/routes/safeRoutesMetaBuilder');

describe('safeRoutesMetaBuilder', () => {
  test('buildSafeRoutesMeta returns expected response meta shape', () => {
    const meta = buildSafeRoutesMeta({
      straightLineKm: 3.26,
      maxDistanceKm: 10,
      responseRoutes: [{ routeIndex: 0 }, { routeIndex: 1 }],
      roadCount: 120,
      crimes: [{ category: 'theft' }, { category: 'robbery' }],
      allData: {
        lights: { elements: [{}, {}] },
        cctv: { elements: [{}, {}, {}] },
        places: { elements: [{}] },
        transit: { elements: [{}, {}, {}, {}] },
      },
      elapsed: 456,
      phase1Time: 50,
      dataTime: 80,
      graphTime: 120,
      pathfindTime: 140,
      recorrectionMs: 0,
    });

    expect(meta).toEqual({
      straightLineDistanceKm: 3.3,
      maxDistanceKm: 10,
      routeCount: 2,
      dataQuality: {
        roads: 120,
        crimes: 2,
        lightElements: 2,
        cctvCameras: 3,
        places: 1,
        transitStops: 4,
        freshness: {
          crimeLastUpdated: null,
          lightsSource: 'local_osm',
          coverageRatio: 1,
          lightVerificationStatus: 'not_needed',
        },
      },
      timing: {
        totalMs: 456,
        corridorDiscoveryMs: 50,
        safetyDataFetchMs: 80,
        graphBuildMs: 120,
        pathfindMs: 140,
        recorrectionMs: 0,
      },
      computeTimeMs: 456,
    });
  });

  test('includes data source observability metadata when provided', () => {
    const meta = buildSafeRoutesMeta({
      straightLineKm: 1.2,
      maxDistanceKm: 10,
      responseRoutes: [{ routeIndex: 0 }],
      roadCount: 42,
      crimes: [],
      allData: {
        lights: { elements: [] },
        cctv: { elements: [] },
        places: { elements: [] },
        transit: { elements: [] },
      },
      elapsed: 200,
      phase1Time: 40,
      dataTime: 60,
      graphTime: 50,
      pathfindTime: 50,
      recorrectionMs: 0,
      dataSources: {
        overpass: { source: 'cache_stale', stale: true },
        crime: { source: 'live', stale: false },
      },
    });

    expect(meta.dataSources).toEqual({
      overpass: { source: 'cache_stale', stale: true },
      crime: { source: 'live', stale: false },
      os: null,
    });
  });
});
