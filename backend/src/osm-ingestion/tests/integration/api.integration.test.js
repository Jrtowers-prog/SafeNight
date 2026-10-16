const request = require('supertest');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('API integration', () => {
  let tmpDir;
  let app;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-api-'));
    process.env.DATA_DIR = tmpDir;
    process.env.PUBLISH_DIR = path.join(tmpDir, 'published');
    process.env.ADMIN_API_KEY = 'test-admin-key';

    // Require server AFTER env vars are set so config picks them up
    app = require('../../src/server').app;

    const publishDir = process.env.PUBLISH_DIR;
    await fs.promises.mkdir(publishDir, { recursive: true });

    const ways = [
      { type: 'way', id: 1, nodes: [10, 11], tags: { highway: 'residential' }, bbox: { minLon: -0.1, minLat: 51.0, maxLon: -0.09, maxLat: 51.01 } },
    ];
    const nodes = [
      { type: 'node', id: 10, lat: 51.0, lon: -0.1, tags: { highway: 'street_lamp' } },
      { type: 'node', id: 11, lat: 51.01, lon: -0.09, tags: { man_made: 'surveillance' } },
    ];

    await fs.promises.writeFile(
      path.join(publishDir, 'uk-roads.jsonl'),
      ways.map((w) => JSON.stringify(w)).join('\n') + '\n',
    );
    await fs.promises.writeFile(
      path.join(publishDir, 'uk-nodes.jsonl'),
      nodes.map((n) => JSON.stringify(n)).join('\n') + '\n',
    );

    // Build indexes
    const { buildIndex } = require('../../src/spatialIndex');
    await buildIndex(path.join(publishDir, 'uk-roads.jsonl'), path.join(publishDir, 'ways-rtree.idx'));
    await buildIndex(path.join(publishDir, 'uk-nodes.jsonl'), path.join(publishDir, 'nodes-rtree.idx'));

    await fs.promises.writeFile(
      path.join(publishDir, 'meta.json'),
      JSON.stringify({ publishedAt: new Date().toISOString() }),
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('GET /health returns healthy', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
  });

  test('GET /data/bbox returns features', async () => {
    const res = await request(app)
      .get('/data/bbox')
      .query({ south: 51.0, west: -0.1, north: 51.02, east: -0.08 });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.ways)).toBe(true);
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(res.body.ways.length).toBeGreaterThan(0);
    expect(res.body.nodes.length).toBeGreaterThan(0);
  });

  test('GET /data/bbox rejects invalid bbox', async () => {
    const res = await request(app)
      .get('/data/bbox')
      .query({ south: 'abc', west: -0.1, north: 51.02, east: -0.08 });
    expect(res.status).toBe(400);
  });

  test('GET /data/stats returns info', async () => {
    const res = await request(app).get('/data/stats');
    expect(res.status).toBe(200);
    expect(res.body.loaded).toBe(true);
  });
});
