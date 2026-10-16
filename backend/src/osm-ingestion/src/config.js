/**
 * config.js — Environment validation and defaults.
 */

const path = require('path');

const PORT = Number(process.env.PORT) || 3006;
const DATA_DIR = (process.env.DATA_DIR || './data').trim();
const PUBLISH_DIR = (process.env.PUBLISH_DIR || path.join(DATA_DIR, 'published')).trim();
const PBF_URL = (process.env.PBF_URL || 'https://download.geofabrik.de/europe/great-britain-latest.osm.pbf').trim();
const INGESTION_SCHEDULE = (process.env.INGESTION_SCHEDULE || '0 3 * * *').trim();
const ADMIN_API_KEY = (process.env.ADMIN_API_KEY || '').trim();
const MIN_FEATURE_COUNT = Math.max(0, Number(process.env.MIN_FEATURE_COUNT) || 100_000);
const MAX_AGE_HOURS = Math.max(1, Number(process.env.MAX_AGE_HOURS) || 48);

function validateConfig() {
  if (!DATA_DIR) {
    throw new Error('DATA_DIR must be set');
  }
  if (!PBF_URL) {
    throw new Error('PBF_URL must be set');
  }
  if (!ADMIN_API_KEY) {
    console.warn('[config] ADMIN_API_KEY not set — admin endpoints are unprotected');
  }
}

module.exports = {
  PORT,
  DATA_DIR,
  PUBLISH_DIR,
  PBF_URL,
  INGESTION_SCHEDULE,
  ADMIN_API_KEY,
  MIN_FEATURE_COUNT,
  MAX_AGE_HOURS,
  validateConfig,
};
