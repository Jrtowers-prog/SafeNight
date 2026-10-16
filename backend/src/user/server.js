/**
 * SafeNight — User Data Service
 *
 * Handles user authentication, usage tracking, safety reports,
 * and app reviews via Supabase (Postgres + Auth).
 *
 * This is a separate microservice (port 3003) to keep load off
 * the gateway and safety services.
 *
 * Auth: Supabase magic link (passwordless email OTP)
 * DB: Supabase Postgres (free tier — 500MB)
 *
 * Security:
 * - Helmet headers
 * - CORS whitelist
 * - Per-user rate limiting (JWT peek → user ID, fallback to IP)
 * - JWT validation on all protected routes
 * - Supabase service_role key server-side only
 * - Input validation on all endpoints
 */

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');

const { createCorsMiddleware } = require('../shared/middleware/cors');
const { createRateLimiter } = require('../shared/middleware/rateLimiter');
const { errorHandler } = require('../shared/middleware/errorHandler');
const { healthCheck } = require('../shared/middleware/healthCheck');

// Route handlers
const authRouter = require('./routes/auth');
const usageRouter = require('./routes/usage');
const reportsRouter = require('./routes/reports');
const reviewsRouter = require('./routes/reviews');
const contactsRouter = require('./routes/contacts');
const liveRouter = require('./routes/live');
const { cleanupStaleSessions, cleanupOldSessions } = require('./routes/live');
const subscriptionsRouter = require('./routes/subscriptions');
const familyRouter = require('./routes/family');
const sharesRouter = require('./routes/shares');

const app = express();
const PORT = process.env.PORT || 3003;

// ─── Trust proxy (Render / reverse-proxy sets X-Forwarded-For) ────────────────
app.set('trust proxy', 1);

// ─── Security headers ───────────────────────────────────────────────────────
app.use(helmet());

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(createCorsMiddleware());

// ─── Body parser ─────────────────────────────────────────────────────────────
// Raised to 100kb to accommodate route_path polylines in live session starts
app.use(express.json({ limit: '100kb' }));

// ─── Routes ──────────────────────────────────────────────────────────────────
// Limits are PER USER (via JWT peek) per 15 minutes; falls back to IP when
// no token is present. magic-link & verify use ipOnly since there's no user yet.
app.use('/api/auth', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 120 }), authRouter);

app.use('/api/usage', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 200 }), usageRouter);
app.use('/api/reports', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 60 }), reportsRouter);
app.use('/api/reviews', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 40 }), reviewsRouter);
app.use('/api/contacts', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 100 }), contactsRouter);
app.use('/api/live', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 500 }), liveRouter);
app.use('/api/subscriptions', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 60 }), subscriptionsRouter);
app.use('/api/family', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 60 }), familyRouter);
app.use('/api/shares', createRateLimiter({ windowMs: 15 * 60 * 1000, max: 90 }), sharesRouter);

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/api/health', healthCheck('user-service'));

// ─── Error handler ───────────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[user] User Data Service running on http://0.0.0.0:${PORT}`);
  // ── Periodic cleanup: expire stale live sessions every 60s ──
  setInterval(cleanupStaleSessions, 60_000);
  console.log('[user] Stale live session cleanup scheduled (every 60s)');
  // ── Periodic cleanup: delete sessions older than 30 days (every hour) ──
  setInterval(cleanupOldSessions, 60 * 60 * 1000);
  cleanupOldSessions(); // Run once on startup
  console.log('[user] 30-day old session cleanup scheduled (every hour)');
  console.log(`[user] Routes: auth, usage, reports, reviews, contacts, live, subscriptions, family, shares`);
});
