/**
 * server.js — Express API for querying hosted OSM safety data.
 */

const express = require('express');
const helmet = require('helmet');
const { queryBboxData, getStats } = require('./dataStore');
const { runPipeline } = require('./pipeline');
const { PORT, ADMIN_API_KEY, validateConfig } = require('./config');

const app = express();
app.use(helmet());
app.use(express.json({ limit: '10kb' }));

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!ADMIN_API_KEY) {
    return res.status(503).json({ error: 'Admin not configured' });
  }
  if (key !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Health check
app.get('/health', async (req, res) => {
  try {
    const stats = await getStats();
    const healthy = stats.loaded && stats.ageHours !== null && stats.ageHours < stats.maxAgeHours;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'healthy' : 'stale',
      ...stats,
    });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

// Query bbox
app.get('/data/bbox', async (req, res) => {
  const south = Number(req.query.south);
  const west = Number(req.query.west);
  const north = Number(req.query.north);
  const east = Number(req.query.east);

  if (![south, west, north, east].every((n) => Number.isFinite(n))) {
    return res.status(400).json({ error: 'Invalid bbox parameters' });
  }
  if (south >= north || west >= east) {
    return res.status(400).json({ error: 'Invalid bbox range' });
  }

  try {
    const data = await queryBboxData(south, west, north, east);
    res.json(data);
  } catch (err) {
    console.error('[api] Query failed:', err.message);
    res.status(503).json({ error: 'Dataset unavailable', message: err.message });
  }
});

// Stats
app.get('/data/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json(stats);
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// Admin: trigger ingestion
app.post('/admin/trigger', requireAdmin, async (req, res) => {
  res.json({ started: true });
  // Run async after response
  runPipeline().catch((err) => {
    console.error('[admin] Pipeline failed:', err.message);
  });
});

function startServer() {
  validateConfig();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[osm-ingestion] API running on http://0.0.0.0:${PORT}`);
    console.log(`[osm-ingestion] Endpoints: /health, /data/bbox, /data/stats`);
  });
}

module.exports = { app, startServer };
