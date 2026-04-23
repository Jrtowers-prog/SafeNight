const request = require('supertest');
const express = require('express');

// Mock the source fusion engine to simulate local-OSM-first behavior
jest.mock('../../../src/safety/services/sourceFusionEngine', () => ({
  fetchRoadNetwork: jest.fn(),
  fetchSafetyData: jest.fn(),
  fetchOsmOnlySafetyData: jest.fn(),
}));

jest.mock('../../../src/safety/services/crimeClient', () => ({
  fetchCrimesInBbox: jest.fn(async () => []),
}));

const sourceFusion = require('../../../src/safety/services/sourceFusionEngine');
const crimeClient = require('../../../src/safety/services/crimeClient');

// Build a minimal app with just the safe-routes router
function buildApp() {
  const app = express();
  app.use(express.json());
  const router = require('../../../src/safety/routes/safeRoutes');
  app.use('/api/safe-routes', router);
  return app;
}

describe('safeRoutes local-OSM-first integration', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns routes when local OSM data is primary', async () => {
    const app = buildApp();

    sourceFusion.fetchRoadNetwork.mockResolvedValue({
      elements: [
        { type: 'way', id: 1, nodes: [10, 11], tags: { highway: 'residential' } },
        { type: 'node', id: 10, lat: 50.37, lon: -4.14 },
        { type: 'node', id: 11, lat: 50.38, lon: -4.13 },
      ],
      _sourceMeta: { source: 'local_osm', reason: 'local-osm-primary' },
    });

    sourceFusion.fetchSafetyData.mockResolvedValue({
      roads: {
        elements: [
          { type: 'way', id: 1, nodes: [10, 11], tags: { highway: 'residential' } },
          { type: 'node', id: 10, lat: 50.37, lon: -4.14 },
          { type: 'node', id: 11, lat: 50.38, lon: -4.13 },
        ],
      },
      lights: { elements: [] },
      cctv: { elements: [] },
      places: { elements: [] },
      transit: { elements: [] },
      _sourceMeta: {
        roads: { source: 'local_osm', reason: 'local-osm-primary' },
        lights: { source: 'local_osm', reason: 'local-osm-primary' },
        cctv: { source: 'local_osm', reason: 'local-osm-primary' },
        places: { source: 'local_osm', reason: 'local-osm-primary' },
        transit: { source: 'local_osm', reason: 'local-osm-primary' },
      },
    });

    const res = await request(app)
      .get('/api/safe-routes')
      .query({
        origin_lat: 50.37,
        origin_lng: -4.14,
        dest_lat: 50.38,
        dest_lng: -4.13,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
    expect(Array.isArray(res.body.routes)).toBe(true);
    expect(res.body.routes.length).toBeGreaterThan(0);
    expect(res.body.meta.sourceProvenance).toBeDefined();
    expect(res.body.meta.sourceProvenance.roads.source).toBe('local_osm');
  });

  test('includes source provenance in meta when local OSM data used', async () => {
    const app = buildApp();

    sourceFusion.fetchRoadNetwork.mockResolvedValue({
      elements: [
        { type: 'way', id: 1, nodes: [10, 11], tags: { highway: 'residential' } },
        { type: 'node', id: 10, lat: 50.37, lon: -4.14 },
        { type: 'node', id: 11, lat: 50.38, lon: -4.13 },
      ],
      _sourceMeta: { source: 'local_osm', reason: 'local-osm-primary' },
    });

    sourceFusion.fetchSafetyData.mockResolvedValue({
      roads: {
        elements: [
          { type: 'way', id: 1, nodes: [10, 11], tags: { highway: 'residential' } },
          { type: 'node', id: 10, lat: 50.37, lon: -4.14 },
          { type: 'node', id: 11, lat: 50.38, lon: -4.13 },
        ],
      },
      lights: { elements: [] },
      cctv: { elements: [] },
      places: { elements: [] },
      transit: { elements: [] },
      _sourceMeta: {
        roads: { source: 'local_osm', reason: 'local-osm-primary' },
        lights: { source: 'local_osm', reason: 'local-osm-primary' },
        cctv: { source: 'local_osm', reason: 'local-osm-primary' },
        places: { source: 'local_osm', reason: 'local-osm-primary' },
        transit: { source: 'local_osm', reason: 'local-osm-primary' },
      },
    });

    const res = await request(app)
      .get('/api/safe-routes')
      .query({
        origin_lat: 50.37,
        origin_lng: -4.14,
        dest_lat: 50.38,
        dest_lng: -4.13,
      });

    expect(res.status).toBe(200);
    expect(res.body.meta.sourceProvenance).toEqual({
      roads: { source: 'local_osm', reason: 'local-osm-primary' },
      lights: { source: 'local_osm', reason: 'local-osm-primary' },
      cctv: { source: 'local_osm', reason: 'local-osm-primary' },
      places: { source: 'local_osm', reason: 'local-osm-primary' },
      transit: { source: 'local_osm', reason: 'local-osm-primary' },
    });
  });
});
