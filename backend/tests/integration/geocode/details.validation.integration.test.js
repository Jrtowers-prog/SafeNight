const express = require('express');
const request = require('supertest');

describe('GET /details validation', () => {
  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createApp() {
    const geocodeRouter = require('../../../src/geocode/routes/geocode');
    const app = express();
    app.use('/api/geocode', geocodeRouter);
    return app;
  }

  test('returns 400 for invalid place_id format', async () => {
    const app = createApp();

    const response = await request(app)
      .get('/api/geocode/details')
      .query({ place_id: 'osm-node-12345$' });

    expect(response.status).toBe(400);
  });

  test('returns OK result for valid OSM place id', async () => {
    const app = createApp();
    global.fetch.mockResolvedValue({
      json: async () => ([{
        name: 'Plymouth Station',
        lat: '50.3770',
        lon: '-4.1430',
      }]),
    });

    const response = await request(app)
      .get('/api/geocode/details')
      .query({ place_id: 'osm-node-12345' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('OK');
    expect(response.body.result.geometry.location.lat).toBeCloseTo(50.3770);
  });

  test('returns NOT_FOUND when upstream responds with XML error page', async () => {
    const app = createApp();
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/xml; charset=utf-8' : null),
      },
      text: async () => '<?xml version="1.0" encoding="UTF-8"?><error>rate limit</error>',
    });

    const response = await request(app)
      .get('/api/geocode/details')
      .query({ place_id: 'osm-way-99999' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'NOT_FOUND', result: null });
  });

  test('returns NOT_FOUND when upstream has no geometry', async () => {
    const app = createApp();
    global.fetch.mockResolvedValue({ json: async () => [] });

    const response = await request(app)
      .get('/api/geocode/details')
      .query({ place_id: 'osm-way-99999' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'NOT_FOUND', result: null });
  });

  test('returns 500 when upstream fetch fails', async () => {
    const app = createApp();
    global.fetch.mockRejectedValue(new Error('upstream failed'));

    const response = await request(app)
      .get('/api/geocode/details')
      .query({ place_id: 'osm-way-12345' });

    expect(response.status).toBe(500);
  });
});
