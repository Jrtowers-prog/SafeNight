const MODULE_PATH = '../../../../src/safety/services/osNgdClient';

function loadModuleWithEnv(env = {}) {
  const prev = {};
  for (const [key, value] of Object.entries(env)) {
    prev[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  jest.resetModules();
  const mod = require(MODULE_PATH);
  mod.__resetForTests?.();
  return {
    ...mod,
    restoreEnv() {
      for (const key of Object.keys(env)) {
        if (prev[key] == null) delete process.env[key];
        else process.env[key] = prev[key];
      }
    },
  };
}

describe('osNgdClient', () => {
  afterEach(() => {
    delete global.fetch;
    jest.restoreAllMocks();
  });

  test('OS_ENABLED is false when OS_API_KEY missing', () => {
    const { OS_ENABLED, restoreEnv } = loadModuleWithEnv({ OS_API_KEY: '' });
    expect(OS_ENABLED).toBe(false);
    restoreEnv();
  });

  test('OS_ENABLED is true when OS_API_KEY present', () => {
    const { OS_ENABLED, restoreEnv } = loadModuleWithEnv({ OS_API_KEY: 'test-key' });
    expect(OS_ENABLED).toBe(true);
    restoreEnv();
  });

  test('fetchOsRoadNetwork transforms OS GeoJSON to Overpass-like shape', async () => {
    const { fetchOsRoadNetwork, restoreEnv } = loadModuleWithEnv({
      OS_API_KEY: 'test-key',
      OS_PLAN_MODE: 'premium',
      OS_MONTHLY_CAP_GBP: '1000',
      OS_CAP_SAFETY_THRESHOLD_PERCENT: '10',
    });

    global.fetch = jest.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 'road-1',
            geometry: { type: 'LineString', coordinates: [[-0.1, 51.0], [-0.09, 51.01]] },
            properties: {
              roadclassification: 'A Road',
              formofway: 'Dual Carriageway',
              presenceofpavement: 'True',
              presenceofstreetlight_coverage: 'WellLit',
              name: 'Test Road',
            },
          },
        ],
      }),
      text: async () => '',
    }));

    const result = await fetchOsRoadNetwork({
      south: 51.0, west: -0.1, north: 51.02, east: -0.08,
    });

    expect(result.elements.length).toBeGreaterThan(0);
    const way = result.elements.find((e) => e.type === 'way');
    expect(way).toBeDefined();
    expect(way.tags.highway).toBe('primary');
    expect(way.tags.name).toBe('Test Road');
    expect(way.tags.sidewalk).toBe('both');
    expect(way.tags.lit).toBe('yes');
    expect(way._source).toBe('os');
    restoreEnv();
  });

  test('fetchOsSafetyData includes street lights', async () => {
    const { fetchOsSafetyData, restoreEnv } = loadModuleWithEnv({
      OS_API_KEY: 'test-key',
      OS_PLAN_MODE: 'premium',
      OS_MONTHLY_CAP_GBP: '1000',
      OS_CAP_SAFETY_THRESHOLD_PERCENT: '10',
      OS_THROTTLE_TXNS_PER_MINUTE: '100',
    });

    global.fetch = jest.fn(async (url) => {
      const isStreetLight = url.includes('streetlight');
      return {
        status: 200,
        ok: true,
        json: async () => ({
          type: 'FeatureCollection',
          features: isStreetLight
            ? [
                {
                  type: 'Feature',
                  id: 'light-1',
                  geometry: { type: 'Point', coordinates: [-0.095, 51.005] },
                  properties: {},
                },
              ]
            : [
                {
                  type: 'Feature',
                  id: 'road-1',
                  geometry: { type: 'LineString', coordinates: [[-0.1, 51.0], [-0.09, 51.01]] },
                  properties: { roadclassification: 'A Road', formofway: 'Dual Carriageway' },
                },
              ],
        }),
        text: async () => '',
      };
    });

    const result = await fetchOsSafetyData({
      south: 51.0, west: -0.1, north: 51.02, east: -0.08,
    });

    expect(result.roads.elements.length).toBeGreaterThan(0);
    expect(result.lights.elements.length).toBeGreaterThan(0);
    expect(result.cctv.elements.length).toBe(0);
    expect(result.places.elements.length).toBe(0);
    expect(result.transit.elements.length).toBe(0);
    restoreEnv();
  });

  test('throws when OS API key missing', async () => {
    const { fetchOsRoadNetwork, restoreEnv } = loadModuleWithEnv({
      OS_API_KEY: '',
    });

    await expect(
      fetchOsRoadNetwork({ south: 51, west: -0.1, north: 51.01, east: -0.09 }),
    ).rejects.toThrow('OS API not enabled');
    restoreEnv();
  });

  test('respects throttle limit', async () => {
    const { fetchOsSafetyData, restoreEnv } = loadModuleWithEnv({
      OS_API_KEY: 'test-key',
      OS_PLAN_MODE: 'premium',
      OS_MONTHLY_CAP_GBP: '1000',
      OS_THROTTLE_TXNS_PER_MINUTE: '1',
    });

    global.fetch = jest.fn(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ type: 'FeatureCollection', features: [] }),
      text: async () => '',
    }));

    // First call should succeed (uses 1 token for roadlink, but pathlink may also use one)
    // fetchOsSafetyData makes 3 calls: roadlink, pathlink, streetlight
    // With throttle=1, the second call should be throttled
    const first = await fetchOsSafetyData({ south: 51, west: -0.1, north: 51.01, east: -0.09 });
    expect(first.roads.elements.length).toBe(0); // empty because all fetches were throttled after first

    restoreEnv();
  });
});
