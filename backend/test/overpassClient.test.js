/**
 * Regression tests for the Overpass client's server selection:
 *   • HTML 200 responses count as failures (not a crash)
 *   • a failed server is skipped during its cooldown
 *   • a single configured server still gets retries
 *
 * Run: node --test test/overpassClient.test.js
 */

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const realFetch = global.fetch;
const MOD = "../src/safety/services/overpassClient.js";

const A = "https://server-a.test/api/interpreter";
const B = "https://server-b.test/api/interpreter";

// Load a fresh module so env-based server list and cooldown state reset.
function loadClient(servers) {
  process.env.OVERPASS_SERVERS = servers.join(",");
  delete require.cache[require.resolve(MOD)];
  return require(MOD);
}

// Map of url → handler returning a Response-like object.
function mockFetch(handlers) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    const handler = handlers[url];
    if (!handler) throw new TypeError(`unexpected url ${url}`);
    return handler();
  };
  return calls;
}

const json = (body) => ({
  status: 200,
  ok: true,
  text: async () => JSON.stringify(body),
  json: async () => body,
});
const html200 = () => ({
  status: 200,
  ok: true,
  text: async () => "<!DOCTYPE html><html>500 Internal Server Error</html>",
  json: async () => {
    throw new SyntaxError("Unexpected token <");
  },
});
const status = (code) => () => ({
  status: code,
  ok: false,
  text: async () => `error ${code}`,
});

beforeEach(() => {
  delete process.env.OVERPASS_SERVERS;
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.OVERPASS_SERVERS;
});

test("HTML 200 from first server fails over to the second", async () => {
  const client = loadClient([A, B]);
  const calls = mockFetch({
    [A]: html200,
    [B]: () => json({ elements: [{ type: "way", id: 1 }] }),
  });

  const data = await client.overpassQuery("way(1,2,3,4);out;", 5);

  assert.equal(data.elements.length, 1);
  assert.equal(calls[0], A);
  assert.equal(calls[1], B);
});

test("a server that just failed is skipped on the next query", async () => {
  const client = loadClient([A, B]);
  const calls = mockFetch({
    [A]: status(502),
    [B]: () => json({ elements: [] }),
  });

  await client.overpassQuery("q1", 5);
  const callsAfterFirst = calls.length;
  await client.overpassQuery("q2", 5);
  const secondQueryCalls = calls.slice(callsAfterFirst);

  assert.ok(
    !secondQueryCalls.includes(A),
    `expected server A to be skipped, but it was called: ${secondQueryCalls}`,
  );
});

test("a cooled-down server is not retried when the healthy one fails next", async () => {
  const client = loadClient([A, B]);
  let bShouldFail = false;
  const calls = mockFetch({
    [A]: status(502),
    [B]: () => (bShouldFail ? status(502)() : json({ elements: [] })),
  });

  await client.overpassQuery("q1", 5); // A fails, B succeeds
  bShouldFail = true;
  const before = calls.length;
  await assert.rejects(client.overpassQuery("q2", 5)); // B now fails too
  const secondQueryCalls = calls.slice(before);

  assert.ok(
    !secondQueryCalls.includes(A),
    `server A is cooling down but was called: ${secondQueryCalls}`,
  );
});

test("if every server is cooling down, all are still tried", async () => {
  const client = loadClient([A, B]);
  const calls = mockFetch({ [A]: status(502), [B]: status(502) });

  await assert.rejects(client.overpassQuery("q1", 5)); // both now cooling
  const before = calls.length;
  await assert.rejects(client.overpassQuery("q2", 5));
  const secondQueryCalls = calls.slice(before);

  assert.ok(
    secondQueryCalls.includes(A) && secondQueryCalls.includes(B),
    `with both cooling, both should be tried again: ${secondQueryCalls}`,
  );
});

test("a single configured server still gets at least 3 attempts", async () => {
  const client = loadClient([A]);
  const calls = mockFetch({ [A]: status(502) });

  await assert.rejects(client.overpassQuery("q", 5));

  assert.equal(calls.length, 3);
});
