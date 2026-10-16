const MODULE_PATH = '../../../../src/safety/services/overpassClient';

function withOverpassModule(env = {}) {
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

function makeResponse(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () =>
      typeof payload === 'string' ? payload : JSON.stringify(payload || {}),
    json: async () => {
      if (typeof payload === 'string') return JSON.parse(payload);
      return payload || {};
    },
  };
}

function decodeOverpassQuery(body) {
  if (typeof body !== 'string') return '';
  if (!body.startsWith('data=')) return body;
  return decodeURIComponent(body.slice(5));
}

function classifyQuery(query) {
  if (query.includes(')->.roads') && query.includes(')->.transit')) {
    return 'combined';
  }
  if (query.includes('node["highway"="street_lamp"]')) return 'lights';
  if (query.includes('node["man_made"="surveillance"]')) return 'cctv';
  if (query.includes('node["public_transport"="platform"]')) return 'transit';
  if (query.includes('node["amenity"]') && query.includes('out center')) {
    return 'places';
  }
  if (query.includes('way["highway"~"^(trunk|primary')) return 'roads';
  return 'unknown';
}

describe('overpassClient fallback behavior', () => {
  afterEach(() => {
    delete global.fetch;
    jest.restoreAllMocks();
  });

  test('enforces request budget exhaustion and stops unbounded server rotation', async () => {
    const { fetchAllSafetyData, restoreEnv } = withOverpassModule({
      OVERPASS_REQUEST_BUDGET_MS: '70',
      OVERPASS_SPLIT_FALLBACK_EXTRA_BUDGET_MS: '0',
      OVERPASS_HEDGE_DELAY_MS: '20',
      OVERPASS_RETRY_STAGGER_MS: '5',
      OVERPASS_SERVERS: 'https://a.test/api/interpreter,https://b.test/api/interpreter,https://c.test/api/interpreter',
    });

    global.fetch = jest.fn(async (_url, options = {}) => {
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (options.signal) {
          if (options.signal.aborted) return onAbort();
          options.signal.addEventListener('abort', onAbort, { once: true });
        }
        setTimeout(resolve, 500);
      });
      return makeResponse(200, { elements: [] });
    });

    await expect(
      fetchAllSafetyData({
        south: 10,
        west: 10,
        north: 10.1,
        east: 10.1,
      }),
    ).rejects.toThrow(/budget exhausted/i);

    expect(global.fetch).toHaveBeenCalled();
    restoreEnv();
  });

  test('uses hedged request and returns first successful server response', async () => {
    const { fetchAllSafetyData, restoreEnv } = withOverpassModule({
      OVERPASS_REQUEST_BUDGET_MS: '1200',
      OVERPASS_HEDGE_DELAY_MS: '15',
      OVERPASS_RETRY_STAGGER_MS: '5',
      OVERPASS_SERVERS: 'https://primary.test/api/interpreter,https://secondary.test/api/interpreter',
    });

    let primaryAborted = false;

    global.fetch = jest.fn((url, options = {}) => {
      if (String(url).includes('primary.test')) {
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            primaryAborted = true;
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          };
          if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
          setTimeout(() => {
            resolve(
              makeResponse(200, {
                elements: [{ type: 'way', id: 111, nodes: [1, 2], tags: { highway: 'residential' } }],
              }),
            );
          }, 250);
        });
      }

      return Promise.resolve(
        makeResponse(200, {
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
    });

    const data = await fetchAllSafetyData({
      south: 51,
      west: -1.1,
      north: 51.1,
      east: -0.9,
    });

    expect(data.roads.elements.length).toBeGreaterThan(0);
    expect(data.lights.elements.length).toBeGreaterThan(0);
    expect(data.cctv.elements.length).toBeGreaterThan(0);
    expect(data.places.elements.length).toBeGreaterThan(0);
    expect(data.transit.elements.length).toBeGreaterThan(0);
    expect(primaryAborted).toBe(true);
    expect(global.fetch.mock.calls.some(([url]) => String(url).includes('secondary.test'))).toBe(true);
    restoreEnv();
  });

  test('deprioritizes endpoints on cooldown after busy errors', async () => {
    const { fetchAllSafetyData, restoreEnv } = withOverpassModule({
      OVERPASS_REQUEST_BUDGET_MS: '1200',
      OVERPASS_HEDGE_DELAY_MS: '5',
      OVERPASS_SERVER_COOLDOWN_MS: '60000',
      OVERPASS_RETRY_STAGGER_MS: '5',
      OVERPASS_SERVERS: 'https://a.test/api/interpreter,https://b.test/api/interpreter,https://c.test/api/interpreter',
    });

    let phase = 1;
    const phase2Calls = [];

    global.fetch = jest.fn((url) => {
      const server = String(url);
      if (phase === 2) phase2Calls.push(server);

      if (phase === 1) {
        if (server.includes('a.test')) {
          return new Promise((resolve) =>
            setTimeout(() => resolve(makeResponse(200, { elements: [{ type: 'way', id: 1, nodes: [1, 2], tags: { highway: 'residential' } }] })), 45),
          );
        }
        if (server.includes('b.test')) {
          return Promise.resolve(makeResponse(429, 'rate limited'));
        }
        return Promise.resolve(makeResponse(200, { elements: [] }));
      }

      if (server.includes('a.test')) {
        return new Promise((resolve) =>
          setTimeout(() => resolve(makeResponse(200, { elements: [] })), 120),
        );
      }
      if (server.includes('c.test')) {
        return new Promise((resolve) =>
          setTimeout(() => resolve(makeResponse(200, { elements: [] })), 15),
        );
      }
      return new Promise((resolve) =>
        setTimeout(() => resolve(makeResponse(200, { elements: [] })), 8),
      );
    });

    await fetchAllSafetyData({
      south: 60,
      west: 10,
      north: 60.1,
      east: 10.1,
    });

    phase = 2;
    await fetchAllSafetyData({
      south: 60.2,
      west: 10,
      north: 60.3,
      east: 10.1,
    });

    expect(phase2Calls.length).toBeGreaterThanOrEqual(2);
    expect(phase2Calls[0]).toContain('a.test');
    expect(phase2Calls[1]).toContain('c.test');
    expect(phase2Calls.some((url) => url.includes('b.test'))).toBe(false);
    restoreEnv();
  });

  test('falls back to split queries when combined query hits upstream 5xx', async () => {
    const { fetchAllSafetyData, restoreEnv } = withOverpassModule({
      OVERPASS_REQUEST_BUDGET_MS: '5000',
      OVERPASS_HEDGE_DELAY_MS: '15',
      OVERPASS_RETRY_STAGGER_MS: '5',
    });

    const hits = {
      combined: 0,
      roads: 0,
      lights: 0,
      cctv: 0,
      places: 0,
      transit: 0,
    };

    global.fetch = jest.fn(async (_url, options = {}) => {
      const query = decodeOverpassQuery(options.body);
      const kind = classifyQuery(query);
      if (kind in hits) hits[kind] += 1;

      if (kind === 'combined') {
        return makeResponse(504, '<html>gateway timeout</html>');
      }
      if (kind === 'roads') {
        return makeResponse(200, {
          elements: [
            {
              type: 'way',
              id: 10,
              nodes: [1, 2],
              tags: { highway: 'residential' },
            },
            { type: 'node', id: 1, lat: 50.1, lon: -4.1 },
            { type: 'node', id: 2, lat: 50.1005, lon: -4.1005 },
          ],
        });
      }
      if (kind === 'lights') {
        return makeResponse(200, {
          elements: [{ type: 'node', id: 3, lat: 50.1, lon: -4.1, tags: { highway: 'street_lamp' } }],
        });
      }
      if (kind === 'cctv') {
        return makeResponse(200, {
          elements: [{ type: 'node', id: 4, lat: 50.1, lon: -4.1, tags: { man_made: 'surveillance' } }],
        });
      }
      if (kind === 'places') {
        return makeResponse(200, {
          elements: [{ type: 'node', id: 5, lat: 50.1, lon: -4.1, tags: { amenity: 'cafe' } }],
        });
      }
      if (kind === 'transit') {
        return makeResponse(200, {
          elements: [{ type: 'node', id: 6, lat: 50.1, lon: -4.1, tags: { highway: 'bus_stop' } }],
        });
      }

      return makeResponse(200, { elements: [] });
    });

    const data = await fetchAllSafetyData({
      south: 50.0,
      west: -4.2,
      north: 50.2,
      east: -4.0,
    });

    expect(hits.combined).toBeGreaterThanOrEqual(1);
    expect(hits.roads).toBeGreaterThanOrEqual(1);
    expect(data.roads.elements.length).toBeGreaterThan(0);
    expect(data.lights.elements.length).toBeGreaterThan(0);
    expect(data.cctv.elements.length).toBeGreaterThan(0);
    expect(data.places.elements.length).toBeGreaterThan(0);
    expect(data.transit.elements.length).toBeGreaterThan(0);
    restoreEnv();
  });

  test('keeps routes available when optional split category fails', async () => {
    const { fetchAllSafetyData, restoreEnv } = withOverpassModule({
      OVERPASS_REQUEST_BUDGET_MS: '5000',
      OVERPASS_HEDGE_DELAY_MS: '15',
      OVERPASS_RETRY_STAGGER_MS: '5',
    });

    const hits = {
      combined: 0,
      roads: 0,
      lights: 0,
      cctv: 0,
      places: 0,
      transit: 0,
    };

    global.fetch = jest.fn(async (_url, options = {}) => {
      const query = decodeOverpassQuery(options.body);
      const kind = classifyQuery(query);
      if (kind in hits) hits[kind] += 1;

      if (kind === 'combined') {
        return makeResponse(504, '<html>gateway timeout</html>');
      }
      if (kind === 'cctv') {
        return makeResponse(504, '<html>upstream timeout</html>');
      }
      if (kind === 'roads') {
        return makeResponse(200, {
          elements: [
            {
              type: 'way',
              id: 20,
              nodes: [11, 12],
              tags: { highway: 'residential' },
            },
            { type: 'node', id: 11, lat: 50.3, lon: -4.3 },
            { type: 'node', id: 12, lat: 50.31, lon: -4.31 },
          ],
        });
      }
      if (kind === 'lights') {
        return makeResponse(200, { elements: [] });
      }
      if (kind === 'places') {
        return makeResponse(200, { elements: [] });
      }
      if (kind === 'transit') {
        return makeResponse(200, { elements: [] });
      }

      return makeResponse(200, { elements: [] });
    });

    const data = await fetchAllSafetyData({
      south: 50.25,
      west: -4.35,
      north: 50.35,
      east: -4.25,
    });

    expect(hits.combined).toBeGreaterThanOrEqual(1);
    expect(hits.roads).toBeGreaterThanOrEqual(1);
    expect(hits.cctv).toBeGreaterThanOrEqual(1);
    expect(data.roads.elements.length).toBeGreaterThan(0);
    expect(data.cctv.elements).toEqual([]);
    restoreEnv();
  });

  test('extends split fallback budget when combined query exhausts request budget', async () => {
    const { fetchAllSafetyData, restoreEnv } = withOverpassModule({
      OVERPASS_REQUEST_BUDGET_MS: '120',
      OVERPASS_SPLIT_FALLBACK_EXTRA_BUDGET_MS: '800',
      OVERPASS_HEDGE_DELAY_MS: '5',
      OVERPASS_RETRY_STAGGER_MS: '5',
      OVERPASS_SERVERS: 'https://single.test/api/interpreter',
    });

    const hits = {
      combined: 0,
      roads: 0,
      lights: 0,
      cctv: 0,
      places: 0,
      transit: 0,
    };

    const waitOrAbort = (ms, signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);

        const onAbort = () => {
          clearTimeout(timer);
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };

        if (!signal) return;
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      });

    global.fetch = jest.fn(async (_url, options = {}) => {
      const query = decodeOverpassQuery(options.body);
      const kind = classifyQuery(query);
      if (kind in hits) hits[kind] += 1;

      if (kind === 'combined') {
        await waitOrAbort(220, options.signal);
        return makeResponse(200, { elements: [] });
      }

      if (kind === 'roads') {
        await waitOrAbort(80, options.signal);
        return makeResponse(200, {
          elements: [
            {
              type: 'way',
              id: 30,
              nodes: [31, 32],
              tags: { highway: 'residential' },
            },
            { type: 'node', id: 31, lat: 50.4, lon: -4.4 },
            { type: 'node', id: 32, lat: 50.4005, lon: -4.4005 },
          ],
        });
      }

      return makeResponse(200, { elements: [] });
    });

    const data = await fetchAllSafetyData({
      south: 50.35,
      west: -4.45,
      north: 50.45,
      east: -4.35,
    });

    expect(hits.combined).toBeGreaterThanOrEqual(1);
    expect(hits.roads).toBeGreaterThanOrEqual(1);
    expect(data.roads.elements.length).toBeGreaterThan(0);
    restoreEnv();
  });
});
