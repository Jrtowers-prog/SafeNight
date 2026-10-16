const MODULE_PATH = '../../../../src/safety/services/sourceFusionEngine';
const OVERPASS_PATH = '../../../../src/safety/services/overpassClient';

function loadModulesWithEnv(env = {}) {
  const prev = {};
  for (const [key, value] of Object.entries(env)) {
    prev[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  jest.resetModules();
  const sourceFusion = require(MODULE_PATH);
  const overpass = require(OVERPASS_PATH);
  overpass.__resetForTests?.();
  return {
    sourceFusion,
    overpass,
    restoreEnv() {
      for (const key of Object.keys(env)) {
        if (prev[key] == null) delete process.env[key];
        else process.env[key] = prev[key];
      }
    },
  };
}

describe('sourceFusionEngine (local-OSM-first)', () => {
  afterEach(() => {
    delete global.fetch;
    jest.restoreAllMocks();
  });

  test('fetchRoadNetwork uses local OSM when available', async () => {
    const { sourceFusion, restoreEnv } = loadModulesWithEnv({});

    global.fetch = jest.fn(async (url) => {
      if (url.includes('/health')) {
        return { status: 200, ok: true };
      }
      if (url.includes('/data/bbox')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            ways: [
              { type: 'way', id: 1, nodes: [10, 11], tags: { highway: 'residential' }, bbox: { minLon: -0.1, minLat: 51.0, maxLon: -0.09, maxLat: 51.01 } },
            ],
            nodes: [
              { type: 'node', id: 10, lat: 51.0, lon: -0.1 },
              { type: 'node', id: 11, lat: 51.01, lon: -0.09 },
            ],
          }),
        };
      }
      return { status: 200, ok: true, json: async () => ({ elements: [] }) };
    });

    const result = await sourceFusion.fetchRoadNetwork({
      south: 51.0, west: -0.1, north: 51.02, east: -0.08,
    });

    expect(result.elements.length).toBeGreaterThan(0);
    expect(result._sourceMeta.source).toBe('local_osm');
    restoreEnv();
  });

  test('fetchRoadNetwork falls back to Overpass when local OSM unavailable', async () => {
    const { sourceFusion, overpass, restoreEnv } = loadModulesWithEnv({});

    global.fetch = jest.fn(async (url) => {
      if (url.includes('/health')) {
        return { status: 503, ok: false };
      }
      // Overpass fallback
      return {
        status: 200,
        ok: true,
        json: async () => ({
          elements: [
            { type: 'way', id: 1, nodes: [10, 11], tags: { highway: 'residential' } },
            { type: 'node', id: 10, lat: 51.0, lon: -0.1 },
            { type: 'node', id: 11, lat: 51.01, lon: -0.09 },
          ],
        }),
      };
    });

    const result = await sourceFusion.fetchRoadNetwork({
      south: 51.0, west: -0.1, north: 51.02, east: -0.08,
    });

    expect(result.elements.length).toBeGreaterThan(0);
    expect(result._sourceMeta.source).toBe('osm');
    restoreEnv();
  });

  test('fetchSafetyData uses local OSM when available', async () => {
    const { sourceFusion, restoreEnv } = loadModulesWithEnv({});

    global.fetch = jest.fn(async (url) => {
      if (url.includes('/health')) {
        return { status: 200, ok: true };
      }
      if (url.includes('/data/bbox')) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            ways: [
              { type: 'way', id: 1, nodes: [10, 11], tags: { highway: 'residential' }, bbox: { minLon: -0.1, minLat: 51.0, maxLon: -0.09, maxLat: 51.01 } },
            ],
            nodes: [
              { type: 'node', id: 10, lat: 51.0, lon: -0.1, tags: { highway: 'street_lamp' } },
              { type: 'node', id: 11, lat: 51.01, lon: -0.09, tags: { man_made: 'surveillance' } },
              { type: 'node', id: 12, lat: 51.0, lon: -0.1, tags: { amenity: 'cafe' } },
              { type: 'node', id: 13, lat: 51.0, lon: -0.1, tags: { highway: 'bus_stop' } },
            ],
          }),
        };
      }
      return { status: 200, ok: true, json: async () => ({ elements: [] }) };
    });

    const result = await sourceFusion.fetchSafetyData({
      south: 51.0, west: -0.1, north: 51.02, east: -0.08,
    });

    expect(result.roads.elements.length).toBeGreaterThan(0);
    expect(result.lights.elements.length).toBeGreaterThan(0);
    expect(result.cctv.elements.length).toBeGreaterThan(0);
    expect(result.places.elements.length).toBeGreaterThan(0);
    expect(result.transit.elements.length).toBeGreaterThan(0);
    expect(result._sourceMeta.roads.source).toBe('local_osm');
    expect(result._sourceMeta.lights.source).toBe('local_osm');
    expect(result._sourceMeta.cctv.source).toBe('local_osm');
    restoreEnv();
  });

  test('fetchSafetyData falls back to Overpass when local OSM fails', async () => {
    const { sourceFusion, overpass, restoreEnv } = loadModulesWithEnv({});

    global.fetch = jest.fn(async (url) => {
      if (url.includes('/health')) {
        return { status: 503, ok: false };
      }
      // Overpass fallback
      return {
        status: 200,
        ok: true,
        json: async () => ({
          elements: [
            { type: 'way', id: 1, nodes: [10, 11], tags: { highway: 'residential' } },
            { type: 'node', id: 10, lat: 51.0, lon: -0.1 },
            { type: 'node', id: 11, lat: 51.01, lon: -0.09 },
            { type: 'node', id: 12, lat: 51.0, lon: -0.1, tags: { highway: 'street_lamp' } },
            { type: 'node', id: 13, lat: 51.0, lon: -0.1, tags: { man_made: 'surveillance' } },
            { type: 'node', id: 14, lat: 51.0, lon: -0.1, tags: { amenity: 'cafe' } },
            { type: 'node', id: 15, lat: 51.0, lon: -0.1, tags: { highway: 'bus_stop' } },
          ],
        }),
      };
    });

    const result = await sourceFusion.fetchSafetyData({
      south: 51.0, west: -0.1, north: 51.02, east: -0.08,
    });

    expect(result._sourceMeta.roads.source).toBe('osm');
    expect(result._sourceMeta.lights.source).toBe('osm');
    restoreEnv();
  });

  test('fetchOsmOnlySafetyData returns only CCTV, places, transit', async () => {
    const { sourceFusion, restoreEnv } = loadModulesWithEnv({});

    let callCount = 0;
    global.fetch = jest.fn(async () => {
      callCount += 1;
      return {
        status: 200,
        ok: true,
        json: async () => ({
          elements: [
            { type: 'node', id: callCount, lat: 51.0, lon: -0.1, tags: { man_made: 'surveillance' } },
          ],
        }),
      };
    });

    const result = await sourceFusion.fetchOsmOnlySafetyData({
      south: 51.0, west: -0.1, north: 51.02, east: -0.08,
    });

    expect(result.cctv.elements.length).toBeGreaterThan(0);
    expect(result.places.elements.length).toBeGreaterThan(0);
    expect(result.transit.elements.length).toBeGreaterThan(0);
    restoreEnv();
  });
});
