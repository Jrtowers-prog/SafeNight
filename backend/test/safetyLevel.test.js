/**
 * Safety level toggle ("standard" vs "extra") — backend data & scoring.
 *
 *   standard → roads + street lights only (CCTV, places, transit skipped)
 *   extra    → full safety dataset (default, unchanged behaviour)
 *
 * Run: node --test test/safetyLevel.test.js
 */

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const realFetch = global.fetch;
const CLIENT = "../src/safety/services/overpassClient.js";
const GRAPH = "../src/safety/services/safetyGraph.js";
const SERVER = "https://server-a.test/api/interpreter";

const BBOX = { south: 50.37, west: -4.15, north: 50.38, east: -4.13 };

function loadClient() {
  process.env.OVERPASS_SERVERS = SERVER;
  delete require.cache[require.resolve(CLIENT)];
  return require(CLIENT);
}

// Capture every Overpass query body sent, decoded back to plain QL text.
function captureQueries() {
  const queries = [];
  global.fetch = async (_url, opts) => {
    queries.push(decodeURIComponent(opts.body.replace(/^data=/, "")));
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ elements: [] }),
      json: async () => ({ elements: [] }),
    };
  };
  return queries;
}

beforeEach(() => {
  delete process.env.OVERPASS_SERVERS;
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.OVERPASS_SERVERS;
});

test("standard level queries roads and lights only", async () => {
  const client = loadClient();
  const queries = captureQueries();

  await client.fetchAllSafetyData(BBOX, { level: "standard" });

  assert.equal(queries.length, 1, "one combined Overpass request");
  const q = queries[0];
  assert.match(q, /highway/);
  assert.match(q, /street_lamp/);
  assert.doesNotMatch(q, /surveillance/);
  assert.doesNotMatch(q, /amenity/);
  assert.doesNotMatch(q, /public_transport/);
});

test("extra level (default) still queries the full dataset", async () => {
  const client = loadClient();
  const queries = captureQueries();

  await client.fetchAllSafetyData({ ...BBOX, south: 50.39 }); // no level given

  const q = queries[0];
  assert.match(q, /surveillance/);
  assert.match(q, /amenity/);
  assert.match(q, /public_transport/);
});

test("standard level does not cache-collide with extra for the same bbox", async () => {
  const client = loadClient();
  const queries = captureQueries();
  const box = { ...BBOX, south: 50.41 };

  await client.fetchAllSafetyData(box, { level: "extra" });
  await client.fetchAllSafetyData(box, { level: "standard" });

  assert.equal(queries.length, 2, "standard must not reuse the extra cache entry");
  assert.doesNotMatch(queries[1], /amenity/);
});

test("standard weights drop CCTV and places and sum to 1", () => {
  const { buildGraph } = require(GRAPH);
  const roads = {
    elements: [
      { type: "node", id: 1, lat: 50.371, lon: -4.14 },
      { type: "node", id: 2, lat: 50.372, lon: -4.139 },
      { type: "way", id: 10, nodes: [1, 2], tags: { highway: "residential" } },
    ],
  };
  const emptyLight = { elements: [] };

  const { weights } = buildGraph(
    roads,
    emptyLight,
    { elements: [] },
    { elements: [] },
    { elements: [] },
    [],
    BBOX,
    { level: "standard" },
  );

  assert.equal(weights.cctv, 0);
  assert.equal(weights.openPlaces, 0);
  const sum =
    weights.roadType + weights.lighting + weights.crimeRate + weights.gpsTraffic;
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights should sum to 1, got ${sum}`);
});

test("extra weights are unchanged (sum to 1 with CCTV and places)", () => {
  const { buildGraph } = require(GRAPH);
  const roads = { elements: [] };

  const { weights } = buildGraph(
    roads,
    { elements: [] },
    { elements: [] },
    { elements: [] },
    { elements: [] },
    [],
    BBOX,
    {},
  );

  assert.ok(weights.cctv > 0);
  assert.ok(weights.openPlaces > 0);
  const sum =
    weights.roadType +
    weights.lighting +
    weights.crimeRate +
    weights.cctv +
    weights.openPlaces +
    weights.gpsTraffic;
  assert.ok(Math.abs(sum - 1) < 1e-9, `extra weights should sum to 1, got ${sum}`);
});
