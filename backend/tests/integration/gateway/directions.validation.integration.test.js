const express = require('express');
const request = require('supertest');

const directionsRouter = require('../../../src/gateway/routes/directions');

describe('GET /directions validation', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createApp() {
    const app = express();
    app.use('/api/directions', directionsRouter);
    return app;
  }

  test('returns 400 for invalid origin latitude', async () => {
    const app = createApp();

    const response = await request(app)
      .get('/api/directions')
      .query({
        origin_lat: 120,
        origin_lng: -4.14,
        dest_lat: 50.38,
        dest_lng: -4.13,
      });

    expect(response.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns 400 for invalid origin longitude', async () => {
    const app = createApp();

    const response = await request(app)
      .get('/api/directions')
      .query({
        origin_lat: 50.37,
        origin_lng: -220,
        dest_lat: 50.38,
        dest_lng: -4.13,
      });

    expect(response.status).toBe(400);
  });

  test('returns 400 for invalid destination latitude', async () => {
    const app = createApp();

    const response = await request(app)
      .get('/api/directions')
      .query({
        origin_lat: 50.37,
        origin_lng: -4.14,
        dest_lat: 95,
        dest_lng: -4.13,
      });

    expect(response.status).toBe(400);
  });

  test('returns 400 when OSRM reports no route', async () => {
    const app = createApp();
    global.fetch.mockResolvedValue({
      json: async () => ({ code: 'NoRoute', message: 'No route found' }),
    });

    const response = await request(app)
      .get('/api/directions')
      .query({
        origin_lat: 50.37,
        origin_lng: -4.14,
        dest_lat: 50.38,
        dest_lng: -4.13,
      });

    expect(response.status).toBe(400);
    expect(response.body.status).toBe('ZERO_RESULTS');
  });

  test('returns 500 when upstream fetch throws', async () => {
    const app = createApp();
    global.fetch.mockRejectedValue(new Error('network down'));

    const response = await request(app)
      .get('/api/directions')
      .query({
        origin_lat: 50.37,
        origin_lng: -4.14,
        dest_lat: 50.38,
        dest_lng: -4.13,
      });

    expect(response.status).toBe(500);
  });

  test('returns transformed Google-style payload for valid upstream response', async () => {
    const app = createApp();
    global.fetch.mockResolvedValue({
      json: async () => ({
        code: 'Ok',
        routes: [{
          distance: 1609.344,
          duration: 300,
          geometry: 'abc123',
          legs: [{
            steps: [{
              distance: 120,
              duration: 30,
              name: 'Main St',
              maneuver: {
                type: 'turn',
                modifier: 'left',
                location: [-4.14, 50.37],
              },
              intersections: [{ location: [-4.141, 50.371] }],
            }],
          }],
        }],
      }),
    });

    const response = await request(app)
      .get('/api/directions')
      .query({
        origin_lat: 50.37,
        origin_lng: -4.14,
        dest_lat: 50.38,
        dest_lng: -4.13,
        mode: 'driving',
        waypoints: 'via:50.375,-4.12|via:50.376,-4.121',
      });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('OK');
    expect(response.body.routes).toHaveLength(1);
    expect(response.body.routes[0].legs[0].steps[0].maneuver).toBe('turn-left');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toContain('/car/');
  });

  test('falls back to walking mode when invalid mode is provided', async () => {
    const app = createApp();
    global.fetch.mockResolvedValue({
      json: async () => ({ code: 'Ok', routes: [] }),
    });

    const response = await request(app)
      .get('/api/directions')
      .query({
        origin_lat: 50.37,
        origin_lng: -4.14,
        dest_lat: 50.38,
        dest_lng: -4.13,
        mode: 'flying',
      });

    expect(response.status).toBe(200);
    expect(global.fetch.mock.calls[0][0]).toContain('/foot/');
  });
});
