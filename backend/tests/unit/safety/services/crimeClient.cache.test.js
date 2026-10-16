const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE_PATH = '../../../../src/safety/services/crimeClient';

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

describe('crimeClient persistent cache', () => {
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

  test('serves crime data from persistent cache across module reload', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-crime-cache-'));
    const bbox = { south: 51, west: -1.1, north: 51.1, east: -0.9 };

    const first = loadModuleWithEnv({
      SAFE_ROUTES_CACHE_DIR: cacheDir,
    });
    global.fetch = jest.fn(async () =>
      makeResponse([
        {
          category: 'violent-crime',
          month: '2026-03',
          location: { latitude: '51.0001', longitude: '-1.0001' },
        },
      ]),
    );

    const firstData = await first.fetchCrimesInBbox(bbox);
    expect(firstData.length).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    first.restoreEnv();

    const second = loadModuleWithEnv({
      SAFE_ROUTES_CACHE_DIR: cacheDir,
    });
    global.fetch = jest.fn(async () => {
      throw new Error('network should not be called');
    });

    const secondData = await second.fetchCrimesInBbox(bbox);
    expect(secondData.length).toBe(1);
    expect(global.fetch).not.toHaveBeenCalled();
    second.restoreEnv();
  });

  test('serves stale crime cache when live fetch is slow and does not duplicate refresh for same key', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-crime-cache-'));
    const bbox = { south: 51, west: -1.1, north: 51.1, east: -0.9 };
    let nowMs = 1000;
    dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const mod = loadModuleWithEnv({
      SAFE_ROUTES_CACHE_DIR: cacheDir,
      SAFE_ROUTES_ALLOW_STALE_CACHE: '1',
      SAFE_ROUTES_CRIME_MAX_STALE_MS: String(12 * 60 * 60 * 1000),
      SAFE_ROUTES_CRIME_STALE_FETCH_GRACE_MS: '5',
    });

    const crimePayload = [
      {
        category: 'violent-crime',
        month: '2026-03',
        location: { latitude: '51.0001', longitude: '-1.0001' },
      },
    ];

    let resolveSlow;
    global.fetch = jest
      .fn()
      .mockImplementationOnce(async () => makeResponse(crimePayload))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlow = () => resolve(makeResponse(crimePayload));
          }),
      );

    await mod.fetchCrimesInBbox(bbox);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    nowMs += 25 * 60 * 60 * 1000;
    const sourceMeta = [];
    const staleResultPromise = mod.fetchCrimesInBbox(bbox, {
      onSourceMeta: (meta) => sourceMeta.push(meta),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    const staleResult = await staleResultPromise;
    expect(staleResult.length).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(sourceMeta[sourceMeta.length - 1]).toMatchObject({
      source: 'cache_stale',
      stale: true,
      staleFallbackReason: 'live_slow',
    });

    resolveSlow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    mod.restoreEnv();
  });
});
