const crypto = require('crypto');
const express = require('express');

const { requireAuth } = require('../middleware/authMiddleware');
const { supabase } = require('../lib/supabase');

const router = express.Router();

const memoryShares = new Map();
const MAX_ROUTE_POINTS = 600;
const MAX_DEST_NAME = 120;
const DEFAULT_EXPIRY_HOURS = 24;
const MAX_EXPIRY_HOURS = 24 * 30;
const APP_LINK_BASE = process.env.SHARE_DEEP_LINK_BASE || 'safenight://share-route';
const WEB_LINK_BASE = process.env.SHARE_WEB_BASE_URL || '';

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isValidCoordinatePoint(point) {
  const lat = toNumber(point?.latitude);
  const lng = toNumber(point?.longitude);
  return lat != null && lng != null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function normalizeRoutePath(routePath) {
  if (!Array.isArray(routePath)) return [];
  const normalized = routePath
    .map((point) => ({
      latitude: toNumber(point?.latitude),
      longitude: toNumber(point?.longitude),
    }))
    .filter((point) => point.latitude != null && point.longitude != null)
    .filter((point) => point.latitude >= -90 && point.latitude <= 90 && point.longitude >= -180 && point.longitude <= 180);

  return normalized.slice(0, MAX_ROUTE_POINTS);
}

function normalizeDestination(destination) {
  if (!destination) return null;
  if (!isValidCoordinatePoint(destination)) return null;
  return {
    latitude: Number(destination.latitude),
    longitude: Number(destination.longitude),
  };
}

function buildShareUrl(token) {
  if (WEB_LINK_BASE) {
    return `${WEB_LINK_BASE.replace(/\/$/, '')}/share/${token}`;
  }
  return `${APP_LINK_BASE}?token=${encodeURIComponent(token)}`;
}

function isTableMissingError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('relation') && message.includes('route_shares');
}

async function insertDbShare(payload) {
  const { data, error } = await supabase
    .from('route_shares')
    .insert(payload)
    .select('token, expires_at, created_at')
    .single();

  if (error) throw error;
  return data;
}

async function selectDbShare(token) {
  const { data, error } = await supabase
    .from('route_shares')
    .select('token, destination_name, destination_lat, destination_lng, route_path, expires_at, created_at, revoked_at')
    .eq('token', token)
    .single();

  if (error) throw error;
  return data;
}

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const expiresInHours = Math.min(
      Math.max(Number(req.body?.expiresInHours) || DEFAULT_EXPIRY_HOURS, 1),
      MAX_EXPIRY_HOURS,
    );

    const destinationName = String(req.body?.destinationName || '').trim().slice(0, MAX_DEST_NAME);
    const destination = normalizeDestination(req.body?.destination);
    const redactOrigin = Boolean(req.body?.redactOrigin);

    const normalizedRoutePath = normalizeRoutePath(req.body?.routePath);
    const routePath = redactOrigin ? normalizedRoutePath.slice(3) : normalizedRoutePath;

    if (!destination && routePath.length === 0) {
      return res.status(400).json({ error: 'destination or routePath is required' });
    }

    const token = crypto.randomBytes(12).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + expiresInHours * 60 * 60 * 1000).toISOString();

    const row = {
      token,
      user_id: req.user.id,
      destination_name: destinationName || null,
      destination_lat: destination?.latitude ?? null,
      destination_lng: destination?.longitude ?? null,
      route_path: routePath,
      redact_origin: redactOrigin,
      expires_at: expiresAt,
    };

    let createdAt = now.toISOString();

    try {
      const inserted = await insertDbShare(row);
      createdAt = inserted?.created_at || createdAt;
    } catch (dbError) {
      if (!isTableMissingError(dbError)) {
        console.error('[shares] DB insert error:', dbError.message);
      }
      memoryShares.set(token, {
        token,
        destinationName: destinationName || null,
        destination,
        routePath,
        revokedAt: null,
        createdAt,
        expiresAt,
      });
    }

    return res.status(201).json({
      token,
      shareUrl: buildShareUrl(token),
      expiresAt,
      createdAt,
    });
  } catch (err) {
    return next(err);
  }
});

router.get('/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token || token.length > 64) {
      return res.status(400).json({ error: 'Invalid share token' });
    }

    let record = null;

    try {
      const dbRow = await selectDbShare(token);
      if (dbRow) {
        record = {
          token: dbRow.token,
          destinationName: dbRow.destination_name || undefined,
          destination:
            dbRow.destination_lat != null && dbRow.destination_lng != null
              ? {
                  latitude: Number(dbRow.destination_lat),
                  longitude: Number(dbRow.destination_lng),
                }
              : undefined,
          routePath: Array.isArray(dbRow.route_path) ? normalizeRoutePath(dbRow.route_path) : [],
          createdAt: dbRow.created_at,
          expiresAt: dbRow.expires_at,
          revokedAt: dbRow.revoked_at,
        };
      }
    } catch (dbError) {
      if (!isTableMissingError(dbError)) {
        console.error('[shares] DB lookup error:', dbError.message);
      }
      const memRow = memoryShares.get(token);
      if (memRow) {
        record = {
          token: memRow.token,
          destinationName: memRow.destinationName || undefined,
          destination: memRow.destination || undefined,
          routePath: memRow.routePath || [],
          createdAt: memRow.createdAt,
          expiresAt: memRow.expiresAt,
          revokedAt: memRow.revokedAt,
        };
      }
    }

    if (!record) {
      return res.status(404).json({ error: 'Share not found' });
    }

    if (record.revokedAt) {
      return res.status(410).json({ error: 'Share is no longer available' });
    }

    if (Date.now() > new Date(record.expiresAt).getTime()) {
      return res.status(410).json({ error: 'Share expired' });
    }

    return res.json({
      token: record.token,
      destinationName: record.destinationName,
      destination: record.destination,
      routePath: record.routePath,
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
