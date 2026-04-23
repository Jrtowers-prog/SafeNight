const request = require('supertest');
const express = require('express');

jest.mock('../../../src/safety/services/sourceFusionEngine', () => ({
  fetchRoadNetwork: jest.fn(),
  fetchSafetyData: jest.fn(),
  fetchOsmOnlySafetyData: jest.fn(),
}));

jest.mock('../../../src/safety/services/crimeClient', () => ({
  fetchCrimesInBbox: jest.fn(async () => []),
}));

const sourceFusion = require('../../../src/safety/services/sourceFusionEngine');
const { OsCapExceededError } = require('../../../src/safety/services/osSpendGuard');

function buildApp() {
  const app = express();
  app.use(express.json());
  const router = require('../../../src/safety/routes/safeRoutes');
  app.use('/api/safe-routes', router);
  return app;
}

describe('safeRoutes cap block integration', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('returns exact maintenance message when OS cap is exceeded', async () => {
    const app = buildApp();

    sourceFusion.fetchSafetyData.mockImplementation(() => {
      throw new OsCapExceededError();
    });

    const res = await request(app)
      .get('/api/safe-routes')
      .query({
        origin_lat: 50.37,
        origin_lng: -4.14,
        dest_lat: 50.38,
        dest_lng: -4.13,
      });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('SERVICE_UNAVAILABLE');
    expect(res.body.message).toBe('Service is currently under maintanace and unavailable');
  });

  test('no premium call escapes after cap breached', async () => {
    const app = buildApp();

    let callCount = 0;
    sourceFusion.fetchSafetyData.mockImplementation(() => {
      callCount += 1;
      throw new OsCapExceededError();
    });

    // Make multiple requests
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .get('/api/safe-routes')
        .query({
          origin_lat: 50.37 + i * 0.001,
          origin_lng: -4.14,
          dest_lat: 50.38 + i * 0.001,
          dest_lng: -4.13,
        });

      expect(res.status).toBe(503);
      expect(res.body.message).toBe('Service is currently under maintanace and unavailable');
    }

    // All requests should have been blocked by cap guard, not by OS API calls
    expect(callCount).toBe(3);
  });
});
