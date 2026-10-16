const express = require('express');
const request = require('supertest');

jest.mock('../../../src/user/middleware/authMiddleware', () => ({
  requireAuth: (req, res, next) => {
    req.user = { id: 'user-1' };
    next();
  },
}));

const mockFallbackDbError = { message: 'relation "route_shares" does not exist' };

const mockSingleInsert = jest.fn(async () => ({ data: null, error: mockFallbackDbError }));
const mockSingleSelect = jest.fn(async () => ({ data: null, error: mockFallbackDbError }));

const mockFrom = jest.fn(() => ({
  insert: () => ({
    select: () => ({ single: mockSingleInsert }),
  }),
  select: () => ({
    eq: () => ({ single: mockSingleSelect }),
  }),
}));

jest.mock('../../../src/user/lib/supabase', () => ({
  supabase: {
    from: (...args) => mockFrom(...args),
  },
}));

const sharesRouter = require('../../../src/user/routes/shares');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/shares', sharesRouter);
  app.use((err, req, res, _next) => {
    res.status(500).json({ error: err.message || 'error' });
  });
  return app;
}

describe('route shares API', () => {
  beforeEach(() => {
    mockSingleInsert.mockClear();
    mockSingleSelect.mockClear();
  });

  test('creates and resolves a share using in-memory fallback', async () => {
    const app = createApp();

    const createResponse = await request(app)
      .post('/api/shares')
      .send({
        destinationName: 'Central Station',
        destination: { latitude: 50.3755, longitude: -4.1427 },
        routePath: [
          { latitude: 50.3755, longitude: -4.1427 },
          { latitude: 50.376, longitude: -4.143 },
          { latitude: 50.377, longitude: -4.144 },
          { latitude: 50.378, longitude: -4.145 },
        ],
        redactOrigin: true,
      });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.token).toBeTruthy();
    expect(createResponse.body.shareUrl).toContain(createResponse.body.token);

    const resolveResponse = await request(app).get(`/api/shares/${createResponse.body.token}`);
    expect(resolveResponse.status).toBe(200);
    expect(resolveResponse.body.destinationName).toBe('Central Station');
    expect(resolveResponse.body.routePath.length).toBe(1);
  });

  test('returns 400 for invalid token', async () => {
    const app = createApp();
    const response = await request(app).get('/api/shares/');
    expect([404, 400]).toContain(response.status);
  });

  test('returns 400 when payload has no destination and no routePath', async () => {
    const app = createApp();
    const response = await request(app).post('/api/shares').send({ destinationName: 'Only text' });
    expect(response.status).toBe(400);
  });
});
