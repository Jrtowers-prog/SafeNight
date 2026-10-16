const express = require('express');
const request = require('supertest');

describe('GET /reverse validation', () => {
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

  test('returns 400 for invalid latitude', async () => {
    const app = createApp();

    const response = await request(app)
      .get('/api/geocode/reverse')
      .query({ lat: 110, lng: -4.14 });

    expect(response.status).toBe(400);
  });

  test('returns NOT_FOUND when upstream has error payload', async () => {
    const app = createApp();
    global.fetch.mockResolvedValue({
      json: async () => ({ error: 'not found' }),
    });

    const response = await request(app)
      .get('/api/geocode/reverse')
      .query({ lat: 50.37, lng: -4.14 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'NOT_FOUND', result: null });
  });

  test('returns OK result when reverse lookup succeeds', async () => {
    const app = createApp();
    global.fetch.mockResolvedValue({
      json: async () => ({
        osm_type: 'node',
        osm_id: 123,
        display_name: 'Plymouth, Devon',
        lat: '50.37',
        lon: '-4.14',
      }),
    });

    const response = await request(app)
      .get('/api/geocode/reverse')
      .query({ lat: 50.37, lng: -4.14 });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('OK');
    expect(response.body.result.place_id).toBe('osm-node-123');
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
      .get('/api/geocode/reverse')
      .query({ lat: 50.37, lng: -4.14 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'NOT_FOUND', result: null });
  });

  test('returns 500 when upstream throws', async () => {
    const app = createApp();
    global.fetch.mockRejectedValue(new Error('reverse offline'));

    const response = await request(app)
      .get('/api/geocode/reverse')
      .query({ lat: 50.37, lng: -4.14 });

    expect(response.status).toBe(500);
  });
});
