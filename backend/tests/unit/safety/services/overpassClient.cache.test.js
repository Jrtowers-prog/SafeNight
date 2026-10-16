const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE_PATH = '../../../../src/safety/services/overpassClient';

function loadModuleWithEnv(env = {}) {
  const previousEnv = {};
  for (const [key, value] of Object.entries(env)) {
    previousEnv[key] = process.env[key];
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  jest.resetModules();
  const mod = require(MODULE_PATH);
  mod.__resetForTests?.();
  return {
    ...mod,
    restoreEnv() {
      for (const [key, oldValue] of Object.entries(previousEnv)) {
        if (oldValue == null) delete process.env[key];
        else process.env[key] = oldValue;
      }
    },
  };
}

function makeResponse(payload) {
  return {
    status: 200,
    ok: true,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

describe('overpassClient persistent cache', () => {
  let cacheDir;
  let dateNowSpy;

  afterEach(() => {
    delete global.fetch;
    jest.restoreAllMocks();
    if (dateNowSpy) {
      dateNowSpy.mockRestore();
      dateNowSpy = null;
    }
    if (cacheDir) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      cacheDir = null;
    }
  });

  test('serves cached safety data across module reload when SAFE_ROUTES_CACHE_DIR is set', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-overpass-cache-'));
    const bbox = { south: 51, west: -1.1, north: 51.1, east: -0.9 };

    const first = loadModuleWithEnv({
      SAFE_ROUTES_CACHE_DIR: cacheDir,
    });
    global.fetch = jest.fn(async () =>
      makeResponse({
        elements: [
          { type: 'way', id: 222, nodes: [3, 4], tags: { highway: 'residential' } },
          { type: 'node', id: 3, lat: 51, lon: -1 },
          { type: 'node', id: 4, lat: 51.0002, lon: -1.0002 },
          { type: 'node', id: 5, lat: 51, lon: -1, tags: { highway: 'street_lamp' } },
          { type: 'node', id: 6, lat: 51, lon: -1, tags: { man_made: 'surveillance' } },
          { type: 'node', id: 7, lat: 51, lon: -1, tags: { amenity: 'cafe' } },
          { type: 'node', id: 8, lat: 51, lon: -1, tags: { highway: 'bus_stop' } },
        ],
      }),
    );

    const firstData = await first.fetchAllSafetyData(bbox);
    expect(firstData.roads.elements.length).toBeGreaterThan(0);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    first.restoreEnv();

    const second = loadModuleWithEnv({
      SAFE_ROUTES_CACHE_DIR: cacheDir,
    });
    global.fetch = jest.fn(async () => {
      throw new Error('network should not be called');
    });

    const secondData = await second.fetchAllSafetyData(bbox);
    expect(secondData.roads.elements.length).toBeGreaterThan(0);
    expect(global.fetch).not.toHaveBeenCalled();
    second.restoreEnv();
  });

  test('serves stale cache when live fetch is slow and does not duplicate refresh for same key', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-overpass-cache-'));
    const bbox = { south: 51, west: -1.1, north: 51.1, east: -0.9 };
    let nowMs = 1000;
    dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const mod = loadModuleWithEnv({
      SAFE_ROUTES_CACHE_DIR: cacheDir,
      SAFE_ROUTES_ALLOW_STALE_CACHE: '1',
      SAFE_ROUTES_OVERPASS_MAX_STALE_MS: String(60 * 60 * 1000),
      SAFE_ROUTES_OVERPASS_STALE_FETCH_GRACE_MS: '5',
    });

    const cachePayload = {
      elements: [
        { type: 'way', id: 222, nodes: [3, 4], tags: { highway: 'residential' } },
        { type: 'node', id: 3, lat: 51, lon: -1 },
        { type: 'node', id: 4, lat: 51.0002, lon: -1.0002 },
      ],
    };

    let resolveSlow;
    global.fetch = jest
      .fn()
      .mockImplementationOnce(async () => makeResponse(cachePayload))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlow = () => resolve(makeResponse(cachePayload));
          }),
      );

    await mod.fetchAllSafetyData(bbox);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    nowMs += 31 * 60 * 1000;
    const sourceMeta = [];
    const staleResultPromise = mod.fetchAllSafetyData(bbox, {
      onSourceMeta: (meta) => sourceMeta.push(meta),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const staleResult = await staleResultPromise;
    expect(staleResult.roads.elements.length).toBeGreaterThan(0);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(sourceMeta[sourceMeta.length - 1]).toMatchObject({
      source: 'cache_stale',
      stale: true,
      staleFallbackReason: 'live_slow',
    });

    resolveSlow();
    await mod.__waitForInflightForTests?.();
    mod.restoreEnv();
  });
});
