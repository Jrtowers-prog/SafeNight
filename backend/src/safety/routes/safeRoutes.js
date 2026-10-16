/**
 * routes/safeRoutes.js — Safety-first pathfinding endpoint (v2).
 *
 * GET /api/safe-routes?origin_lat=...&origin_lng=...&dest_lat=...&dest_lng=...
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SPEED IMPROVEMENTS (vs v1):
 *   1. Single Overpass query instead of 4 parallel ones (~70% less latency)
 *   2. 30-min data cache (OSM) + 24h crime cache (vs 5-min route cache)
 *   3. A* pathfinding with heuristic (3–10× faster per route)
 *   4. Pre-computed coverage maps (lighting, crime) — O(1) per edge
 *   5. Spatial-grid nearest-node lookup — O(1) vs O(n)
 *   6. Request coalescing — concurrent identical requests share one computation
 *
 * ACCURACY IMPROVEMENTS:
 *   1. Crime severity weighting (violent > property > nuisance)
 *   2. Inverse-distance lighting model (closer lamp = much brighter)
 *   3. CCTV cameras as new safety signal
 *   4. Time-of-day adaptive weights
 *   5. Surface quality penalty (gravel/dirt paths)
 *   6. Dead-end detection and penalty
 * ═══════════════════════════════════════════════════════════════════════════
 */

const express = require("express");
const os = require("os");
const opening_hours = require("opening_hours");
const {
  validateLatitude,
  validateLongitude,
} = require("../../shared/validation/validate");
const {
  haversine,
  bboxFromPoints,
  encodePolyline,
} = require("../services/geo");
const {
  fetchAllSafetyData,
  fetchRoadNetworkOnly,
} = require("../services/overpassClient");
const { fetchCrimesInBbox } = require("../services/crimeClient");

/**
 * Strip PH (Public Holiday) rules from an opening_hours string.
 * The opening_hours library lacks GB state holiday definitions and throws
 * noisy errors for every PH reference, which slows down batch processing.
 */
function stripPH(str) {
  if (!str) return str;
  // Remove standalone "PH off" / "PH 08:00-20:00" clauses separated by ";"
  return (
    str
      .split(";")
      .map((s) => s.trim())
      .filter((s) => !/^\s*PH\b/.test(s))
      .map((s) => s.replace(/,\s*PH\b/g, "")) // "Mo-Su,PH 07:00-23:00" → "Mo-Su 07:00-23:00"
      .filter(Boolean)
      .join("; ") || null
  );
}

/**
 * Check if a place is open right now using the opening_hours npm library.
 * Returns { open: boolean, nextChange: string|null }.
 *   - nextChange is a human-readable string like "closes at 22:00" or "opens at 08:00"
 */
function checkOpenNow(hoursString) {
  if (!hoursString) return { open: null, nextChange: null }; // unknown
  try {
    const cleaned = stripPH(hoursString);
    if (!cleaned) return { open: null, nextChange: null };
    const oh = new opening_hours(cleaned, { address: { country_code: "gb" } });
    const now = new Date();
    const isOpen = oh.getState(now);
    let nextChange = null;
    try {
      const next = oh.getNextChange(now);
      if (next) {
        const h = next.getHours().toString().padStart(2, "0");
        const m = next.getMinutes().toString().padStart(2, "0");
        nextChange = isOpen ? `closes at ${h}:${m}` : `opens at ${h}:${m}`;
      }
    } catch {
      /* some strings don't support getNextChange */
    }
    return { open: isOpen, nextChange };
  } catch {
    return { open: null, nextChange: null }; // unparseable
  }
}

/**
 * Type-based heuristic for places without opening_hours tags.
 * Uses the amenity/shop type + current hour to estimate if likely open.
 *   - Hospitals, petrol stations, ATMs → always open
 *   - Pubs, bars, nightclubs → open evenings/nights
 *   - Shops, cafes, restaurants → open daytime
 *   - Unknown → likely open during daytime only
 */
const ALWAYS_OPEN = new Set([
  "hospital",
  "clinic",
  "pharmacy",
  "fuel",
  "atm",
  "police",
  "fire_station",
  "hotel",
  "hostel",
  "charging_station",
  "parking",
  "toilets",
]);
const EVENING_TYPES = new Set([
  "pub",
  "bar",
  "nightclub",
  "biergarten",
  "casino",
]);

function heuristicOpen(amenityType) {
  const hour = new Date().getHours();
  const type = (amenityType || "").toLowerCase();

  if (ALWAYS_OPEN.has(type)) return { open: true, nextChange: "open 24/7" };
  if (EVENING_TYPES.has(type)) {
    // Pubs/bars: typically 11:00–23:00 or later
    if (hour >= 11 && hour < 23)
      return { open: true, nextChange: "closes at 23:00" };
    return { open: false, nextChange: "opens at 11:00" };
  }
  // Default shops/restaurants/cafes: 07:00–20:00
  if (hour >= 7 && hour < 20)
    return { open: true, nextChange: "closes at 20:00" };
  return { open: false, nextChange: "opens at 07:00" };
}
const {
  buildGraph,
  buildDistanceOnlyGraph,
  aStarDistance,
  findNearestNode,
  findKSafestRoutes,
  routeToPolyline,
  routeSafetyBreakdown,
  getWeights,
} = require("../services/safetyGraph");

const router = express.Router();

// Default fallback — can be overridden per request via ?max_distance query param
// (the gateway / user-service resolves the caller's tier → distance limit)
const DEFAULT_MAX_DISTANCE_KM = 20;
const WALKING_SPEED_MPS = 1.35;
const ENABLE_RESPONSE_OPENING_HOURS_PARSE =
  process.env.SAFE_ROUTES_PARSE_RESPONSE_OPENING_HOURS === "1";

// ── Route cache (5 min TTL) ─────────────────────────────────────────────────
const routeCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCacheKey(oLat, oLng, dLat, dLng, wpLat, wpLng) {
  const r = (v) => Math.round(v * 1000) / 1000;
  const base = `${r(oLat)},${r(oLng)}->${r(dLat)},${r(dLng)}`;
  return wpLat != null && wpLng != null
    ? `${base}@${r(wpLat)},${r(wpLng)}`
    : base;
}

// ── Request coalescing — share computation for concurrent identical requests ─
const inflight = new Map();

// ── Single-active-search guard (per user across devices) ──────────────────
const activeSearchByUser = new Map();

function createSearchCancelledError(
  message = "Route search cancelled by a newer request on your account.",
) {
  const err = new Error(message);
  err.code = "SEARCH_CANCELLED";
  err.statusCode = 409;
  return err;
}

function createCancellationToken() {
  let cancelled = false;
  let reason = "Route search cancelled.";
  const listeners = new Set();

  return {
    isCancelled: () => cancelled,
    reason: () => reason,
    cancel: (message) => {
      if (cancelled) return;
      cancelled = true;
      reason = message || reason;
      listeners.forEach((fn) => {
        try {
          fn(reason);
        } catch {
          // ignore listener errors
        }
      });
      listeners.clear();
    },
    onCancel: (fn) => {
      if (typeof fn !== "function") return () => {};
      if (cancelled) {
        fn(reason);
        return () => {};
      }
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    throwIfCancelled: () => {
      if (cancelled) throw createSearchCancelledError(reason);
    },
  };
}

function readSearchId(req) {
  const raw = req.headers["x-search-id"];
  if (typeof raw === "string" && raw.trim()) return raw.trim().slice(0, 120);
  const r = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : "x";
  };
  const oLat = r(req.query.origin_lat);
  const oLng = r(req.query.origin_lng);
  const dLat = r(req.query.dest_lat);
  const dLng = r(req.query.dest_lng);
  const wpLat = r(req.query.waypoint_lat);
  const wpLng = r(req.query.waypoint_lng);
  const maxDist = Number.isFinite(Number(req.query.max_distance))
    ? Number(req.query.max_distance)
    : "x";
  return `${oLat},${oLng}->${dLat},${dLng}@${wpLat},${wpLng}#${maxDist}`;
}

function readSearchSeq(req) {
  const raw = req.headers["x-search-seq"];
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return Date.now();
}

function readSearchClient(req, userKey) {
  const raw = req.headers["x-search-client"];
  if (typeof raw === "string" && raw.trim()) return raw.trim().slice(0, 120);
  return `anon:${userKey}`;
}

function peekJwtUserId(req) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return null;
    const token = header.slice(7);
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    );
    return payload.sub || null;
  } catch {
    return null;
  }
}

function resolveSearchUserKey(req) {
  const userId = peekJwtUserId(req);
  if (userId) return `user:${userId}`;
  return `ip:${req.ip || "unknown"}`;
}

function logSearchCancellation(event, details = {}) {
  const extras = Object.entries(details)
    .filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    )
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  if (extras) {
    console.log(`[safe-routes][cancel] ${event} ${extras}`);
    return;
  }
  console.log(`[safe-routes][cancel] ${event}`);
}

function registerActiveSearch(req, cancelToken) {
  const userKey = resolveSearchUserKey(req);
  const searchId = readSearchId(req);
  const searchSeq = readSearchSeq(req);
  const clientId = readSearchClient(req, userKey);
  const previous = activeSearchByUser.get(userKey);

  if (previous && previous.searchSeq > searchSeq) {
    logSearchCancellation("stale_rejected", {
      userKey,
      clientId,
      staleSearchId: searchId,
      staleSeq: searchSeq,
      activeSearchId: previous.searchId,
      activeSeq: previous.searchSeq,
    });
    cancelToken.cancel(
      "This route search is older than another active search on your account.",
    );
    return {
      userKey,
      searchId,
      searchSeq,
      clientId,
      replacedPrevious: false,
      release: () => {},
      stale: true,
    };
  }

  if (previous) {
    logSearchCancellation("previous_preempted", {
      userKey,
      previousClientId: previous.clientId,
      newClientId: clientId,
      cancelledSearchId: previous.searchId,
      cancelledSeq: previous.searchSeq,
      newerSearchId: searchId,
      newerSeq: searchSeq,
    });
    previous.cancelToken.cancel(
      "This route search was cancelled because a newer search started on your account.",
    );
  }

  const entry = {
    searchId,
    searchSeq,
    clientId,
    userKey,
    cancelToken,
    startedAt: Date.now(),
  };
  activeSearchByUser.set(userKey, entry);

  const release = () => {
    const current = activeSearchByUser.get(userKey);
    if (current === entry) {
      activeSearchByUser.delete(userKey);
      logSearchCancellation("active_released", {
        userKey,
        clientId,
        searchId,
        searchSeq,
      });
    }
  };

  return {
    userKey,
    searchId,
    searchSeq,
    clientId,
    replacedPrevious: Boolean(previous),
    stale: false,
    release,
  };
}

// ── Compute queue/load control ──────────────────────────────────────────────
const AVAILABLE_PARALLELISM =
  typeof os.availableParallelism === "function"
    ? os.availableParallelism()
    : Math.max(1, os.cpus()?.length || 1);
const DEFAULT_MAX_CONCURRENT_COMPUTES = Math.max(
  1,
  Math.min(AVAILABLE_PARALLELISM, 8),
);
const DEFAULT_MAX_SERVER_LOAD_UNITS = Math.max(
  4,
  DEFAULT_MAX_CONCURRENT_COMPUTES * 3,
);
const MAX_CONCURRENT_COMPUTES = Math.max(
  1,
  Number(
    process.env.SAFE_ROUTES_MAX_CONCURRENT || DEFAULT_MAX_CONCURRENT_COMPUTES,
  ),
);
const MAX_SERVER_LOAD_UNITS = Math.max(
  1,
  Number(
    process.env.SAFE_ROUTES_MAX_SERVER_LOAD_UNITS ||
      DEFAULT_MAX_SERVER_LOAD_UNITS,
  ),
);
const MAX_QUEUE_LENGTH = Math.max(
  1,
  Number(process.env.SAFE_ROUTES_MAX_QUEUE_LENGTH || 200),
);
const MAX_QUEUE_WAIT_MS = Math.max(
  1000,
  Number(process.env.SAFE_ROUTES_MAX_QUEUE_WAIT_MS || 180000),
);
const DEFAULT_COMPUTE_ETA_MS = Math.max(
  10000,
  Number(process.env.SAFE_ROUTES_DEFAULT_ETA_MS || 30000),
);
const DEFAULT_REQUEST_LOAD_UNITS = Math.max(
  1,
  Number(process.env.SAFE_ROUTES_DEFAULT_REQUEST_LOAD_UNITS || 3),
);
const LOAD_UNITS_PER_KM = Math.max(
  0.1,
  Number(process.env.SAFE_ROUTES_LOAD_UNITS_PER_KM || 0.7),
);
const WAYPOINT_LOAD_BONUS = Math.max(
  0,
  Number(process.env.SAFE_ROUTES_WAYPOINT_LOAD_BONUS || 1),
);
const MIN_REQUEST_LOAD_UNITS = Math.max(
  1,
  Number(process.env.SAFE_ROUTES_MIN_REQUEST_LOAD_UNITS || 1),
);
const MAX_REQUEST_LOAD_UNITS = Math.max(
  MIN_REQUEST_LOAD_UNITS,
  Number(
    process.env.SAFE_ROUTES_MAX_REQUEST_LOAD_UNITS || MAX_SERVER_LOAD_UNITS,
  ),
);
const recentComputeDurationsMs = [];
const recentComputeMsPerLoadUnit = [];
const MAX_RECENT_DURATIONS = 24;
let activeComputations = 0;
let activeLoadUnits = 0;
let nextQueueJobId = 1;
const computeQueue = [];
const activeQueueJobs = new Map();
let queueHeartbeat = null;

function getAverageComputeMs() {
  if (!recentComputeDurationsMs.length) return DEFAULT_COMPUTE_ETA_MS;
  const total = recentComputeDurationsMs.reduce((sum, ms) => sum + ms, 0);
  return Math.round(total / recentComputeDurationsMs.length);
}

function trackComputeDuration(ms) {
  recentComputeDurationsMs.push(ms);
  if (recentComputeDurationsMs.length > MAX_RECENT_DURATIONS) {
    recentComputeDurationsMs.shift();
  }
}

function getAverageMsPerLoadUnit() {
  if (!recentComputeMsPerLoadUnit.length) {
    return Math.round(DEFAULT_COMPUTE_ETA_MS / DEFAULT_REQUEST_LOAD_UNITS);
  }
  const total = recentComputeMsPerLoadUnit.reduce((sum, ms) => sum + ms, 0);
  return Math.max(500, Math.round(total / recentComputeMsPerLoadUnit.length));
}

function trackLoadAdjustedDuration(ms, requestLoadUnits) {
  const safeUnits = Math.max(
    1,
    Number(requestLoadUnits || DEFAULT_REQUEST_LOAD_UNITS),
  );
  const msPerUnit = Math.max(500, Math.round(ms / safeUnits));
  recentComputeMsPerLoadUnit.push(msPerUnit);
  if (recentComputeMsPerLoadUnit.length > MAX_RECENT_DURATIONS) {
    recentComputeMsPerLoadUnit.shift();
  }
}

function estimateRequestLoadUnits({
  straightLineKm,
  maxDistanceKm,
  hasWaypoint,
}) {
  const distanceKm =
    Number.isFinite(maxDistanceKm) && maxDistanceKm > 0
      ? maxDistanceKm
      : Number.isFinite(straightLineKm)
        ? straightLineKm
        : 0;
  const distanceLoad = distanceKm * LOAD_UNITS_PER_KM;
  const raw =
    MIN_REQUEST_LOAD_UNITS +
    distanceLoad +
    (hasWaypoint ? WAYPOINT_LOAD_BONUS : 0);
  const rounded = Math.round(raw);
  return Math.max(
    MIN_REQUEST_LOAD_UNITS,
    Math.min(MAX_REQUEST_LOAD_UNITS, rounded),
  );
}

function estimateComputeMsForLoad(requestLoadUnits) {
  const safeUnits = Math.max(
    1,
    Number(requestLoadUnits || DEFAULT_REQUEST_LOAD_UNITS),
  );
  return Math.max(5000, Math.round(getAverageMsPerLoadUnit() * safeUnits));
}

function getActiveJobsSnapshot() {
  const now = Date.now();
  const jobs = [];
  for (const job of activeQueueJobs.values()) {
    const elapsed = Math.max(0, now - job.startedAt);
    const remainingMs = Math.max(1000, job.expectedMs - elapsed);
    jobs.push({
      id: job.id,
      loadUnits: job.requestLoadUnits,
      remainingMs,
    });
  }
  return jobs;
}

function tryStartWaitingJobs(activeJobs, waitingJobs) {
  let startedOne = false;
  while (waitingJobs.length > 0) {
    const next = waitingJobs[0];
    const currentLoad = activeJobs.reduce((sum, job) => sum + job.loadUnits, 0);
    const capacityByLoad =
      currentLoad + next.loadUnits <= MAX_SERVER_LOAD_UNITS;
    const capacityByConcurrency = activeJobs.length < MAX_CONCURRENT_COMPUTES;
    if (!capacityByLoad || !capacityByConcurrency) break;

    waitingJobs.shift();
    activeJobs.push({
      id: next.id,
      loadUnits: next.loadUnits,
      remainingMs: next.expectedMs,
      target: next.target,
    });
    startedOne = true;
  }
  return startedOne;
}

function estimateQueueWaitMs(queuePosition) {
  if (queuePosition < 0 || queuePosition >= computeQueue.length) return 0;

  const activeJobs = getActiveJobsSnapshot();
  const waitingJobs = computeQueue
    .slice(0, queuePosition + 1)
    .map((job, index) => ({
      id: job.id,
      loadUnits: Math.max(
        1,
        Number(job.requestLoadUnits || DEFAULT_REQUEST_LOAD_UNITS),
      ),
      expectedMs: estimateComputeMsForLoad(job.requestLoadUnits),
      target: index === queuePosition,
    }));

  let elapsedMs = 0;
  const MAX_SIM_STEPS = 1000;
  let steps = 0;

  while (steps < MAX_SIM_STEPS) {
    steps += 1;

    tryStartWaitingJobs(activeJobs, waitingJobs);
    if (activeJobs.some((job) => job.target)) {
      return Math.max(0, elapsedMs);
    }

    if (activeJobs.length === 0) {
      return elapsedMs + getAverageComputeMs();
    }

    const nextFinishMs = Math.min(...activeJobs.map((job) => job.remainingMs));
    elapsedMs += nextFinishMs;

    for (const job of activeJobs) {
      job.remainingMs = Math.max(0, job.remainingMs - nextFinishMs);
    }
    for (let i = activeJobs.length - 1; i >= 0; i -= 1) {
      if (activeJobs[i].remainingMs <= 0) {
        activeJobs.splice(i, 1);
      }
    }
  }

  return elapsedMs + getAverageComputeMs();
}

function ensureQueueHeartbeat() {
  if (queueHeartbeat) return;
  queueHeartbeat = setInterval(() => {
    if (computeQueue.length === 0) {
      clearInterval(queueHeartbeat);
      queueHeartbeat = null;
      return;
    }
    notifyQueuedJobs();
  }, 1000);
}

function canStartJobNow(job) {
  const requestLoadUnits = Math.max(
    1,
    Number(job.requestLoadUnits || DEFAULT_REQUEST_LOAD_UNITS),
  );
  const hasLoadCapacity =
    activeLoadUnits + requestLoadUnits <= MAX_SERVER_LOAD_UNITS;
  const hasConcurrencyCapacity = activeComputations < MAX_CONCURRENT_COMPUTES;
  return hasLoadCapacity && hasConcurrencyCapacity;
}

function formatWaitMmSs(waitMs) {
  const totalSec = Math.max(0, Math.round(waitMs / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function notifyQueuedJobs() {
  computeQueue.forEach((job, index) => {
    if (typeof job.onQueueUpdate !== "function") return;
    const waitMs = estimateQueueWaitMs(index);
    if (job.lastNotifiedPosition === index && job.lastNotifiedWaitMs === waitMs)
      return;
    job.lastNotifiedPosition = index;
    job.lastNotifiedWaitMs = waitMs;
    job.onQueueUpdate({
      queuePosition: index,
      waitMs,
      waitLabel: formatWaitMmSs(waitMs),
      activeCount: activeComputations,
      activeLoadUnits,
      queuedCount: computeQueue.length,
      maxServerLoadUnits: MAX_SERVER_LOAD_UNITS,
      maxQueueLength: MAX_QUEUE_LENGTH,
      requestLoadUnits: Math.max(
        1,
        Number(job.requestLoadUnits || DEFAULT_REQUEST_LOAD_UNITS),
      ),
      avgComputeMs: getAverageComputeMs(),
    });
  });
}

function startComputeJob(job) {
  if (job.cancelled) {
    if (typeof job.cancelUnsub === "function") job.cancelUnsub();
    return;
  }
  const requestLoadUnits = Math.max(
    1,
    Number(job.requestLoadUnits || DEFAULT_REQUEST_LOAD_UNITS),
  );
  const expectedMs = estimateComputeMsForLoad(requestLoadUnits);
  activeComputations += 1;
  activeLoadUnits += requestLoadUnits;
  activeQueueJobs.set(job.id, {
    id: job.id,
    requestLoadUnits,
    startedAt: Date.now(),
    expectedMs,
  });
  if (typeof job.onStart === "function") {
    job.onStart({
      activeCount: activeComputations,
      activeLoadUnits,
      queuedCount: computeQueue.length,
      maxServerLoadUnits: MAX_SERVER_LOAD_UNITS,
      maxQueueLength: MAX_QUEUE_LENGTH,
      requestLoadUnits,
      expectedMs,
      avgComputeMs: getAverageComputeMs(),
    });
  }

  const startedAt = Date.now();
  Promise.resolve()
    .then(job.run)
    .then((result) => {
      const totalMs = Date.now() - startedAt;
      trackComputeDuration(totalMs);
      trackLoadAdjustedDuration(totalMs, requestLoadUnits);
      job.resolve(result);
    })
    .catch((err) => {
      job.reject(err);
    })
    .finally(() => {
      if (typeof job.cancelUnsub === "function") job.cancelUnsub();
      activeQueueJobs.delete(job.id);
      activeComputations = Math.max(0, activeComputations - 1);
      activeLoadUnits = Math.max(0, activeLoadUnits - requestLoadUnits);
      notifyQueuedJobs();
      runQueuedComputes();
    });
}

function runQueuedComputes() {
  while (computeQueue.length > 0) {
    const nextJob = computeQueue.shift();
    if (!nextJob || nextJob.cancelled) {
      if (nextJob && typeof nextJob.cancelUnsub === "function")
        nextJob.cancelUnsub();
      continue;
    }
    const queuedForMs = Math.max(
      0,
      Date.now() - (nextJob.enqueuedAt || Date.now()),
    );
    if (queuedForMs > MAX_QUEUE_WAIT_MS) {
      if (typeof nextJob.cancelUnsub === "function") nextJob.cancelUnsub();
      nextJob.reject(
        Object.assign(
          new Error(
            "Server queue timeout. Please retry with a shorter route or lower load.",
          ),
          {
            statusCode: 503,
            code: "QUEUE_TIMEOUT",
            queuedForMs,
            maxQueueWaitMs: MAX_QUEUE_WAIT_MS,
          },
        ),
      );
      continue;
    }
    if (!canStartJobNow(nextJob)) {
      computeQueue.unshift(nextJob);
      break;
    }
    startComputeJob(nextJob);
  }
  if (computeQueue.length > 0) ensureQueueHeartbeat();
  notifyQueuedJobs();
}

function enqueueComputeJob({
  run,
  onQueueUpdate,
  onStart,
  cancelToken = null,
  requestLoadUnits = DEFAULT_REQUEST_LOAD_UNITS,
}) {
  return new Promise((resolve, reject) => {
    const job = {
      id: nextQueueJobId++,
      run,
      resolve,
      reject,
      onQueueUpdate,
      onStart,
      requestLoadUnits: Math.max(
        1,
        Number(requestLoadUnits || DEFAULT_REQUEST_LOAD_UNITS),
      ),
      cancelled: false,
      enqueuedAt: Date.now(),
      lastNotifiedPosition: -1,
      lastNotifiedWaitMs: -1,
      cancelUnsub: null,
    };

    if (cancelToken?.isCancelled?.()) {
      job.cancelled = true;
      reject(
        createSearchCancelledError(
          cancelToken.reason?.() || "Route search cancelled.",
        ),
      );
      return;
    }

    if (cancelToken?.onCancel) {
      job.cancelUnsub = cancelToken.onCancel((reason) => {
        job.cancelled = true;
        const queueIndex = computeQueue.findIndex(
          (queuedJob) => queuedJob.id === job.id,
        );
        if (queueIndex >= 0) {
          computeQueue.splice(queueIndex, 1);
          notifyQueuedJobs();
        }
        reject(createSearchCancelledError(reason));
      });
    }

    if (computeQueue.length === 0 && canStartJobNow(job)) {
      startComputeJob(job);
      return;
    }

    if (computeQueue.length >= MAX_QUEUE_LENGTH) {
      if (typeof job.cancelUnsub === "function") job.cancelUnsub();
      reject(
        Object.assign(
          new Error("Server is at capacity. Please retry shortly."),
          {
            statusCode: 503,
            code: "QUEUE_FULL",
            queueLength: computeQueue.length,
            maxQueueLength: MAX_QUEUE_LENGTH,
          },
        ),
      );
      return;
    }

    computeQueue.push(job);
    ensureQueueHeartbeat();
    notifyQueuedJobs();
  });
}

function emitInflightProgress(entry, phase, message, pct) {
  const payload = { phase, message, pct };
  entry.lastProgress = payload;
  entry.progressListeners.forEach((listener) => {
    try {
      listener(phase, message, pct);
    } catch {
      // best-effort listener fanout
    }
  });
}

async function waitWithCancellation(promise, cancelToken) {
  if (!cancelToken?.onCancel) return promise;
  cancelToken.throwIfCancelled?.();

  let unsubscribe = null;
  const cancelPromise = new Promise((_, reject) => {
    unsubscribe = cancelToken.onCancel((reason) => {
      reject(createSearchCancelledError(reason));
    });
  });

  try {
    return await Promise.race([promise, cancelPromise]);
  } finally {
    if (typeof unsubscribe === "function") unsubscribe();
  }
}

function pruneRouteCache() {
  if (routeCache.size <= 100) return;
  const now = Date.now();
  for (const [key, val] of routeCache) {
    if (now - val.timestamp > CACHE_TTL_MS) routeCache.delete(key);
  }
}

async function resolveSafeRoutesRequest({
  oLat,
  oLng,
  dLat,
  dLng,
  straightLineDist,
  straightLineKm,
  maxDistanceKm,
  wpLat,
  wpLng,
  onProgress,
  cancelToken = null,
}) {
  cancelToken?.throwIfCancelled?.();
  const cacheKey = getCacheKey(oLat, oLng, dLat, dLng, wpLat, wpLng);
  const cached = routeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log(`[safe-routes] 📋 Route cache hit for ${cacheKey}`);
    return { result: cached.data, source: "cache" };
  }

  if (inflight.has(cacheKey)) {
    console.log(
      `[safe-routes] ⏳ Coalescing with in-flight request for ${cacheKey}`,
    );
    const entry = inflight.get(cacheKey);
    let subscribed = false;
    if (entry && typeof onProgress === "function") {
      entry.progressListeners.add(onProgress);
      subscribed = true;
      if (entry.lastProgress) {
        onProgress(
          entry.lastProgress.phase,
          entry.lastProgress.message,
          entry.lastProgress.pct,
        );
      }
    }

    let result;
    try {
      result = await waitWithCancellation(entry.promise, cancelToken);
    } finally {
      if (subscribed) entry.progressListeners.delete(onProgress);
    }

    cancelToken?.throwIfCancelled?.();
    if (!result) {
      throw Object.assign(new Error("Computation failed."), {
        statusCode: 500,
        code: "INTERNAL_ERROR",
      });
    }
    return { result, source: "inflight" };
  }

  const inflightEntry = {
    promise: null,
    progressListeners: new Set(),
    lastProgress: null,
  };
  if (typeof onProgress === "function")
    inflightEntry.progressListeners.add(onProgress);
  inflight.set(cacheKey, inflightEntry);
  const requestLoadUnits = estimateRequestLoadUnits({
    straightLineKm,
    maxDistanceKm,
    hasWaypoint: Number.isFinite(wpLat) && Number.isFinite(wpLng),
  });

  try {
    inflightEntry.promise = enqueueComputeJob({
      run: () =>
        computeSafeRoutes(
          oLat,
          oLng,
          dLat,
          dLng,
          straightLineDist,
          straightLineKm,
          Date.now(),
          maxDistanceKm,
          wpLat,
          wpLng,
          cancelToken,
          (phase, message, pct) =>
            emitInflightProgress(inflightEntry, phase, message, pct),
        ),
      onQueueUpdate: ({
        queuePosition,
        waitLabel,
        activeCount,
        activeLoadUnits,
        queuedCount,
        maxServerLoadUnits,
        requestLoadUnits: queuedLoadUnits,
      }) => {
        const ahead = queuePosition + 1;
        emitInflightProgress(
          inflightEntry,
          "queued",
          `Server busy — queued (${ahead} ahead, ${activeCount} active, load ${activeLoadUnits}/${maxServerLoadUnits}). Est. ${waitLabel}`,
          20,
        );
        if (queuedCount > 0) {
          emitInflightProgress(
            inflightEntry,
            "queue_stats",
            `Queue size: ${queuedCount} requests • this route load ${queuedLoadUnits}/${maxServerLoadUnits}`,
            20,
          );
        }
      },
      onStart: ({
        activeCount,
        activeLoadUnits,
        queuedCount,
        maxServerLoadUnits,
        expectedMs,
        requestLoadUnits: startedLoadUnits,
      }) => {
        const expectedLabel = formatWaitMmSs(expectedMs);
        emitInflightProgress(
          inflightEntry,
          "queue_start",
          `Starting safety analysis (${activeCount} active, ${queuedCount} queued, load ${activeLoadUnits}/${maxServerLoadUnits}, route load ${startedLoadUnits}). Est. ${expectedLabel}`,
          22,
        );
      },
      requestLoadUnits,
      cancelToken,
    });

    const result = await waitWithCancellation(
      inflightEntry.promise,
      cancelToken,
    );
    if (!result) {
      throw Object.assign(new Error("Computation failed."), {
        statusCode: 500,
        code: "INTERNAL_ERROR",
      });
    }

    routeCache.set(cacheKey, { data: result, timestamp: Date.now() });
    return { result, source: "computed" };
  } catch (err) {
    throw err;
  } finally {
    inflight.delete(cacheKey);
    pruneRouteCache();
  }
}

function safetyLabel(score) {
  if (score >= 75) return { label: "Very Safe", color: "#2E7D32" };
  if (score >= 55) return { label: "Safe", color: "#558B2F" };
  if (score >= 35) return { label: "Moderate", color: "#F9A825" };
  return { label: "Use Caution", color: "#C62828" };
}

function segmentColor(safetyScore) {
  if (safetyScore >= 0.7) return "#4CAF50";
  if (safetyScore >= 0.5) return "#8BC34A";
  if (safetyScore >= 0.35) return "#FFC107";
  if (safetyScore >= 0.2) return "#FF9800";
  return "#F44336";
}

// ── GET /api/safe-routes ────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const cancelToken = createCancellationToken();
  const activeSearch = registerActiveSearch(req, cancelToken);
  if (activeSearch.stale) {
    logSearchCancellation("http_stale_response", {
      userKey: activeSearch.userKey,
      searchId: activeSearch.searchId,
      searchSeq: activeSearch.searchSeq,
    });
    return res.status(409).json({
      error: "SEARCH_CANCELLED",
      message:
        "This route search is older than another active search on your account.",
    });
  }
  req.on("close", () => {
    logSearchCancellation("http_client_disconnected", {
      userKey: activeSearch.userKey,
      searchId: activeSearch.searchId,
      searchSeq: activeSearch.searchSeq,
    });
    cancelToken.cancel(
      "Route search was cancelled because the client disconnected.",
    );
  });

  try {
    // ── 1. Validate inputs ──────────────────────────────────────────────
    const oLat = validateLatitude(req.query.origin_lat);
    const oLng = validateLongitude(req.query.origin_lng);
    if (!oLat.valid) return res.status(400).json({ error: oLat.error });
    if (!oLng.valid) return res.status(400).json({ error: oLng.error });

    const dLat = validateLatitude(req.query.dest_lat);
    const dLng = validateLongitude(req.query.dest_lng);
    if (!dLat.valid) return res.status(400).json({ error: dLat.error });
    if (!dLng.valid) return res.status(400).json({ error: dLng.error });

    // ── Optional waypoint (direction-bias / via point) ──────────────────
    let wpLat = null,
      wpLng = null;
    if (req.query.waypoint_lat != null && req.query.waypoint_lng != null) {
      const wpLatV = validateLatitude(req.query.waypoint_lat);
      const wpLngV = validateLongitude(req.query.waypoint_lng);
      if (wpLatV.valid && wpLngV.valid) {
        wpLat = wpLatV.value;
        wpLng = wpLngV.value;
      }
    }

    // ── 2. Distance limit ───────────────────────────────────────────────
    const straightLineDist = haversine(
      oLat.value,
      oLng.value,
      dLat.value,
      dLng.value,
    );
    const straightLineKm = straightLineDist / 1000;

    // The gateway sends ?max_distance=<km> based on the user's subscription tier
    const maxDistanceKm = req.query.max_distance
      ? Math.min(Number(req.query.max_distance), DEFAULT_MAX_DISTANCE_KM)
      : DEFAULT_MAX_DISTANCE_KM;

    if (straightLineKm > maxDistanceKm) {
      // Estimate how many data points the system would need to fetch.
      // The safety engine queries every street, lamp, CCTV camera, bus stop,
      // open venue, and recent crime record inside the bounding box.
      const latDiff = Math.abs(dLat.value - oLat.value);
      const lngDiff = Math.abs(dLng.value - oLng.value);
      const bufferDeg = 0.003; // ~300 m buffer on each side
      const heightKm = (latDiff + 2 * bufferDeg) * 111.32;
      const midLatRad = (((oLat.value + dLat.value) / 2) * Math.PI) / 180;
      const widthKm = (lngDiff + 2 * bufferDeg) * 111.32 * Math.cos(midLatRad);
      const areaKm2 = heightKm * widthKm;
      // ~4 000 elements/km² (roads, nodes, lights, CCTV, places, transit, crimes)
      const estimatedDataPoints = Math.round(areaKm2 * 4000);

      const straightLineMi = straightLineKm * 0.621371;
      const maxDistanceMi = maxDistanceKm * 0.621371;
      return res.status(400).json({
        error: "DESTINATION_OUT_OF_RANGE",
        message: `That destination is ${straightLineMi.toFixed(1)} mi away — your limit is ${maxDistanceMi.toFixed(1)} mi.`,
        maxDistanceKm,
        actualDistanceKm: Math.round(straightLineKm * 10) / 10,
        estimatedDataPoints,
        areaKm2: Math.round(areaKm2 * 10) / 10,
        detail: `To score this route for safety, we'd need to analyse roughly ${estimatedDataPoints.toLocaleString()} data points — every street, street light, CCTV camera, bus stop, open venue, and police-reported crime in a ${areaKm2.toFixed(1)} km² area. To keep SafeNight fast, we cap routes at ${maxDistanceMi.toFixed(1)} mi for your plan.`,
      });
    }

    const { result } = await resolveSafeRoutesRequest({
      oLat: oLat.value,
      oLng: oLng.value,
      dLat: dLat.value,
      dLng: dLng.value,
      straightLineDist,
      straightLineKm,
      maxDistanceKm,
      wpLat,
      wpLng,
      cancelToken,
    });

    res.json(result);
  } catch (err) {
    if (err?.code === "SEARCH_CANCELLED") {
      logSearchCancellation("http_cancelled_response", {
        userKey: activeSearch.userKey,
        searchId: activeSearch.searchId,
        searchSeq: activeSearch.searchSeq,
        reason: err.message,
      });
      if (!res.headersSent) {
        return res.status(409).json({
          error: "SEARCH_CANCELLED",
          message: err.message,
        });
      }
      return;
    }
    console.error(`[safe-routes] ❌ Error:`, err);
    if (!res.headersSent) {
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: "Something went wrong on our end while computing your route.",
        detail:
          "This is usually a temporary issue with one of our data sources (OpenStreetMap or the Police crime API). Please wait a moment and try again.",
      });
    }
  } finally {
    activeSearch.release();
  }
});

// ── GET /api/safe-routes/stream (SSE progress, low-overhead) ──────────────
router.get("/stream", async (req, res) => {
  let closed = false;
  let keepAliveTimer = null;
  const cancelToken = createCancellationToken();
  const activeSearch = registerActiveSearch(req, cancelToken);

  if (activeSearch.stale) {
    logSearchCancellation("sse_stale_response", {
      userKey: activeSearch.userKey,
      searchId: activeSearch.searchId,
      searchSeq: activeSearch.searchSeq,
    });
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    res.write("event: error\n");
    res.write(
      `data: ${JSON.stringify({ code: "SEARCH_CANCELLED", message: "This route search is older than another active search on your account.", pct: 0 })}\n\n`,
    );
    return res.end();
  }

  const cleanup = () => {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  };

  req.on("close", () => {
    closed = true;
    logSearchCancellation("sse_client_disconnected", {
      userKey: activeSearch.userKey,
      searchId: activeSearch.searchId,
      searchSeq: activeSearch.searchSeq,
    });
    cancelToken.cancel(
      "Route search was cancelled because the client disconnected.",
    );
    activeSearch.release();
    cleanup();
  });

  cancelToken.onCancel((reason) => {
    if (closed) return;
    logSearchCancellation("sse_cancel_signal", {
      userKey: activeSearch.userKey,
      searchId: activeSearch.searchId,
      searchSeq: activeSearch.searchSeq,
      reason,
    });
    send("error", { code: "SEARCH_CANCELLED", message: reason, pct: 0 });
    closed = true;
    cleanup();
    try {
      res.end();
    } catch {
      // ignore
    }
    activeSearch.release();
  });

  const send = (event, data) => {
    if (closed) return;
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Client disconnected
    }
  };

  try {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    keepAliveTimer = setInterval(() => {
      if (closed) return;
      try {
        res.write(": keepalive\n\n");
      } catch {
        // ignore write failures
      }
    }, 15000);

    send("phase", {
      phase: "init",
      message: "Starting route analysis…",
      pct: 20,
    });

    const oLat = validateLatitude(req.query.origin_lat);
    const oLng = validateLongitude(req.query.origin_lng);
    if (!oLat.valid)
      return (send("error", { message: oLat.error, pct: 0 }), res.end());
    if (!oLng.valid)
      return (send("error", { message: oLng.error, pct: 0 }), res.end());

    const dLat = validateLatitude(req.query.dest_lat);
    const dLng = validateLongitude(req.query.dest_lng);
    if (!dLat.valid)
      return (send("error", { message: dLat.error, pct: 0 }), res.end());
    if (!dLng.valid)
      return (send("error", { message: dLng.error, pct: 0 }), res.end());

    let wpLat = null,
      wpLng = null;
    if (req.query.waypoint_lat != null && req.query.waypoint_lng != null) {
      const wpLatV = validateLatitude(req.query.waypoint_lat);
      const wpLngV = validateLongitude(req.query.waypoint_lng);
      if (wpLatV.valid && wpLngV.valid) {
        wpLat = wpLatV.value;
        wpLng = wpLngV.value;
      }
    }

    const straightLineDist = haversine(
      oLat.value,
      oLng.value,
      dLat.value,
      dLng.value,
    );
    const straightLineKm = straightLineDist / 1000;
    const maxDistanceKm = req.query.max_distance
      ? Math.min(Number(req.query.max_distance), DEFAULT_MAX_DISTANCE_KM)
      : DEFAULT_MAX_DISTANCE_KM;

    if (straightLineKm > maxDistanceKm) {
      const maxDistanceMi = maxDistanceKm * 0.621371;
      const straightLineMi = straightLineKm * 0.621371;
      send("error", {
        message: `That destination is ${straightLineMi.toFixed(1)} mi away — your limit is ${maxDistanceMi.toFixed(1)} mi.`,
        pct: 0,
      });
      return res.end();
    }

    const cacheKey = getCacheKey(
      oLat.value,
      oLng.value,
      dLat.value,
      dLng.value,
      wpLat,
      wpLng,
    );
    if (inflight.has(cacheKey)) {
      send("phase", {
        phase: "coalesced",
        message: "Joining active route computation…",
        pct: 20,
      });
    }

    const onProgress = (phase, message, pct) => {
      send("phase", { phase, message, pct });
    };

    const { source } = await resolveSafeRoutesRequest({
      oLat: oLat.value,
      oLng: oLng.value,
      dLat: dLat.value,
      dLng: dLng.value,
      straightLineDist,
      straightLineKm,
      maxDistanceKm,
      wpLat,
      wpLng,
      onProgress,
      cancelToken,
    });

    if (source === "cache") {
      send("phase", {
        phase: "cache_hit",
        message: "Using cached route analysis…",
        pct: 96,
      });
    }

    send("done", { pct: 100, message: "Routes ready!" });
    cleanup();
    activeSearch.release();
    res.end();
  } catch (err) {
    if (err?.code === "SEARCH_CANCELLED") {
      logSearchCancellation("sse_cancelled_response", {
        userKey: activeSearch.userKey,
        searchId: activeSearch.searchId,
        searchSeq: activeSearch.searchSeq,
        reason: err.message,
      });
      send("error", { code: "SEARCH_CANCELLED", message: err.message, pct: 0 });
      cleanup();
      activeSearch.release();
      return res.end();
    }
    send("error", {
      message:
        err?.message || "Something went wrong while streaming route progress.",
      pct: 0,
    });
    cleanup();
    activeSearch.release();
    res.end();
  }
});

/**
 * Core computation — separated for request coalescing.
 */
async function computeSafeRoutes(
  oLatV,
  oLngV,
  dLatV,
  dLngV,
  straightLineDist,
  straightLineKm,
  startTime,
  maxDistanceKm = DEFAULT_MAX_DISTANCE_KM,
  wpLat = null,
  wpLng = null,
  cancelToken = null,
  onProgress = null,
) {
  cancelToken?.throwIfCancelled?.();
  const upstreamAbortController = new AbortController();
  const cancelUnsub = cancelToken?.onCancel?.(() => {
    try {
      upstreamAbortController.abort();
    } catch {
      // ignore abort errors
    }
  });

  const progress = (phase, message, pct) => {
    if (typeof onProgress !== "function") return;
    if (cancelToken?.isCancelled?.()) return;
    try {
      onProgress(phase, message, pct);
    } catch {
      // no-op: progress is best-effort
    }
  };

  progress("start", "Preparing route analysis…", 20);
  console.log(
    `[safe-routes] 🔍 Computing: ${oLatV},${oLngV} → ${dLatV},${dLngV} (${straightLineKm.toFixed(1)} km)`,
  );

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 1 — Corridor discovery (skip for short distances to save time)
    // For routes < 1.5 km, a straight-line corridor works fine.
    // For longer routes, discover the actual walking corridor shape.
    // ═══════════════════════════════════════════════════════════════════════
    let shortestPath = null;
    let distGraph = null;
    let phase1Time = 0;

    const SKIP_PHASE1_DIST = 1500; // skip road-only fetch for < 1.5 km

    if (straightLineDist >= SKIP_PHASE1_DIST) {
      cancelToken?.throwIfCancelled?.();
      progress("phase1", "Discovering walking corridor…", 28);
      console.log(`[safe-routes] 🛤️  Phase 1: Discovering walking corridor...`);
      const t0p1 = Date.now();
      const initialBufferM = Math.max(
        400,
        Math.min(800, straightLineDist * 0.25),
      );
      const initialBboxPoints = [
        { lat: oLatV, lng: oLngV },
        { lat: dLatV, lng: dLngV },
      ];
      if (wpLat != null) initialBboxPoints.push({ lat: wpLat, lng: wpLng });
      const initialBbox = bboxFromPoints(initialBboxPoints, initialBufferM);

      const roadData = await fetchRoadNetworkOnly(initialBbox, {
        signal: upstreamAbortController.signal,
      });
      distGraph = buildDistanceOnlyGraph(roadData);

      const distStart = findNearestNode(
        distGraph.nodeGrid,
        distGraph.adjacency,
        oLatV,
        oLngV,
      );
      const distEnd = findNearestNode(
        distGraph.nodeGrid,
        distGraph.adjacency,
        dLatV,
        dLngV,
      );

      if (distStart && distEnd) {
        shortestPath = aStarDistance(
          distGraph.osmNodes,
          distGraph.edges,
          distGraph.adjacency,
          distStart,
          distEnd,
          straightLineDist * 3,
        );
      }
      phase1Time = Date.now() - t0p1;
      cancelToken?.throwIfCancelled?.();
      progress("phase1_done", "Walking corridor discovered.", 38);
      console.log(
        `[safe-routes] ✅ Phase 1: ${phase1Time}ms — ${
          shortestPath
            ? shortestPath.path.length +
              " nodes, " +
              Math.round(shortestPath.totalDist) +
              "m"
            : "fallback to straight-line corridor"
        }`,
      );
    } else {
      progress(
        "phase1_skipped",
        "Skipping corridor discovery for short route.",
        34,
      );
      console.log(
        `[safe-routes] ⏩ Phase 1: skipped (${Math.round(straightLineDist)}m < ${SKIP_PHASE1_DIST}m)`,
      );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 2 — Build corridor bbox + fetch safety data
    // Smaller buffers to reduce data volume and processing time.
    // ═══════════════════════════════════════════════════════════════════════
    const corridorBufferM = Math.max(
      700,
      Math.min(1000, straightLineDist * 0.3),
    );

    let corridorPoints;
    if (shortestPath && distGraph) {
      corridorPoints = [];
      for (const nodeId of shortestPath.path) {
        const n = distGraph.osmNodes.get(nodeId);
        if (n) corridorPoints.push({ lat: n.lat, lng: n.lng });
      }
    } else {
      const numSamples = Math.max(8, Math.ceil(straightLineKm * 4));
      corridorPoints = [];
      for (let i = 0; i <= numSamples; i++) {
        const t = i / numSamples;
        corridorPoints.push({
          lat: oLatV + (dLatV - oLatV) * t,
          lng: oLngV + (dLngV - oLngV) * t,
        });
      }
    }
    corridorPoints.unshift({ lat: oLatV, lng: oLngV });
    corridorPoints.push({ lat: dLatV, lng: dLngV });
    // Ensure waypoint is also inside the bbox corridor
    if (wpLat != null) corridorPoints.push({ lat: wpLat, lng: wpLng });

    const bbox = bboxFromPoints(corridorPoints, corridorBufferM);
    cancelToken?.throwIfCancelled?.();
    progress("phase2", "Fetching safety data in route corridor…", 50);
    console.log(
      `[safe-routes] 📐 Phase 2: Corridor from ${corridorPoints.length} waypoints + ${corridorBufferM}m buffer`,
    );

    // ── Fetch ALL safety data within the corridor ───────────────────────
    console.log(
      `[safe-routes] 📡 Fetching safety data in corridor (Overpass + Crime)...`,
    );
    const t0 = Date.now();

    let [allData, crimes] = await Promise.all([
      fetchAllSafetyData(bbox, { signal: upstreamAbortController.signal }),
      fetchCrimesInBbox(bbox, { signal: upstreamAbortController.signal }),
    ]);

    let dataTime = Date.now() - t0;
    cancelToken?.throwIfCancelled?.();
    progress("phase2_done", "Safety data loaded.", 66);
    console.log(`[safe-routes] 📡 Corridor data fetched in ${dataTime}ms`);

    let roadCount = allData.roads.elements.filter(
      (e) => e.type === "way",
    ).length;
    let nodeCount = allData.roads.elements.filter(
      (e) => e.type === "node",
    ).length;
    console.log(
      `[safe-routes] 📊 Data: ${roadCount} roads, ${nodeCount} nodes, ${crimes.length} crimes, ${allData.lights.elements.length} lights, ${allData.cctv.elements.length} CCTV`,
    );

    // ── 6b. Extract light & place node positions for POI markers ────────
    // ── 7. Build safety-weighted graph (with coverage maps) ─────────────
    console.log(`[safe-routes] 🏗️  Building graph + coverage maps...`);
    cancelToken?.throwIfCancelled?.();
    progress("graph_build", "Building safety graph…", 74);
    const t1 = Date.now();
    let {
      osmNodes,
      edges,
      adjacency,
      nodeGrid,
      weights,
      cctvNodes,
      transitNodes,
      nodeDegree,
    } = buildGraph(
      allData.roads,
      allData.lights,
      allData.cctv,
      allData.places,
      allData.transit,
      crimes,
      bbox,
      { shouldCancel: () => cancelToken?.isCancelled?.() === true },
    );
    let graphTime = Date.now() - t1;
    cancelToken?.throwIfCancelled?.();
    progress("graph_ready", "Running safest path search…", 82);
    console.log(
      `[safe-routes] 📊 Graph: ${osmNodes.size} nodes, ${edges.length} edges (built in ${graphTime}ms)`,
    );

    if (edges.length === 0) {
      throw Object.assign(
        new Error(
          "We found roads in this area but none of them are walkable (they may all be motorways or private roads). Try a destination in a more pedestrian-friendly area.",
        ),
        { statusCode: 404, code: "NO_WALKING_NETWORK", roadCount },
      );
    }

    // ── 8. Find nearest graph nodes (O(1) via spatial grid) ─────────────
    let startNode = findNearestNode(nodeGrid, adjacency, oLatV, oLngV);
    let endNode = findNearestNode(nodeGrid, adjacency, dLatV, dLngV);

    if (!startNode || !endNode) {
      const which = !startNode ? "origin" : "destination";
      throw Object.assign(
        new Error(
          `We couldn't find a walkable road within 200 m of your ${which}. ` +
            `This can happen if the point is in the middle of a park, body of water, or private land. ` +
            `Try tapping a spot closer to a street or footpath.`,
        ),
        { statusCode: 404, code: "NO_NEARBY_ROAD", which },
      );
    }

    // ── 9. Find 3–5 safest routes (A* — much faster than Dijkstra) ─────
    console.log(
      `[safe-routes] 🔎 A* pathfinding (start=${startNode}, end=${endNode})...`,
    );
    cancelToken?.throwIfCancelled?.();
    progress("pathfind", "Computing route candidates…", 86);
    const t2 = Date.now();
    const maxRouteDist = straightLineDist * 2.5;
    let rawRoutes;

    if (wpLat != null) {
      // ── Two-leg via-waypoint pathfinding ──────────────────────────────
      const waypointNode = findNearestNode(nodeGrid, adjacency, wpLat, wpLng);
      if (
        waypointNode &&
        waypointNode !== startNode &&
        waypointNode !== endNode
      ) {
        const leg1Routes = findKSafestRoutes(
          osmNodes,
          edges,
          adjacency,
          startNode,
          waypointNode,
          maxRouteDist * 0.7,
          1,
        );
        const leg2Routes = findKSafestRoutes(
          osmNodes,
          edges,
          adjacency,
          waypointNode,
          endNode,
          maxRouteDist * 0.7,
          3,
        );
        if (leg1Routes.length > 0 && leg2Routes.length > 0) {
          const leg1 = leg1Routes[0];
          rawRoutes = leg2Routes.map((leg2) => ({
            path: [...leg1.path, ...leg2.path.slice(1)],
            edges: [...leg1.edges, ...leg2.edges],
            totalDist: leg1.totalDist + leg2.totalDist,
          }));
          console.log(
            `[safe-routes] 📍 Via waypoint node ${waypointNode}: ${leg1.path.length}+${leg2Routes[0].path.length} nodes, ${rawRoutes.length} combined routes`,
          );
        } else {
          console.log(
            `[safe-routes] ⚠️  Via routing failed (leg1=${leg1Routes.length}, leg2=${leg2Routes.length}), falling back to direct`,
          );
          rawRoutes = findKSafestRoutes(
            osmNodes,
            edges,
            adjacency,
            startNode,
            endNode,
            maxRouteDist,
            3,
          );
        }
      } else {
        console.log(
          `[safe-routes] ⚠️  Waypoint node not found in graph, falling back to direct`,
        );
        rawRoutes = findKSafestRoutes(
          osmNodes,
          edges,
          adjacency,
          startNode,
          endNode,
          maxRouteDist,
          3,
        );
      }
    } else {
      rawRoutes = findKSafestRoutes(
        osmNodes,
        edges,
        adjacency,
        startNode,
        endNode,
        maxRouteDist,
        3,
      );
    }

    let pathfindTime = Date.now() - t2;
    cancelToken?.throwIfCancelled?.();
    progress("pathfind_done", "Scoring and formatting route options…", 89);
    console.log(
      `[safe-routes] 🔎 A* found ${rawRoutes.length} routes in ${pathfindTime}ms`,
    );

    if (rawRoutes.length === 0) {
      throw Object.assign(
        new Error(
          `We analysed ${osmNodes.size.toLocaleString()} intersections and ${edges.length.toLocaleString()} road segments ` +
            `but couldn't connect your origin to the destination. ` +
            `They're likely separated by a barrier with no pedestrian crossing — a motorway, river, railway, or restricted area.`,
        ),
        {
          statusCode: 404,
          code: "NO_ROUTE_FOUND",
          graphNodes: osmNodes.size,
          graphEdges: edges.length,
        },
      );
    }

    // Recorrection removed — too expensive for 512MB/0.1CPU.
    const recorrectionMs = 0;

    const lightNodes = [];
    for (const el of allData.lights.elements) {
      if (
        el.type === "node" &&
        el.tags?.highway === "street_lamp" &&
        el.lat &&
        el.lon
      ) {
        lightNodes.push({ lat: el.lat, lng: el.lon });
      }
    }
    const placeNodes = [];
    for (const el of allData.places.elements) {
      const lat = el.lat || el.center?.lat;
      const lng = el.lon || el.center?.lon;
      if (lat && lng) {
        const name =
          el.tags?.name ||
          el.tags?.["name:en"] ||
          el.tags?.brand ||
          el.tags?.operator ||
          "";
        const amenity =
          el.tags?.amenity ||
          el.tags?.shop ||
          el.tags?.leisure ||
          el.tags?.tourism ||
          "";
        const hoursRaw = el.tags?.opening_hours || "";
        let open = null;
        let nextChange = null;
        // Optional strict parser for opening_hours (off by default under load).
        if (ENABLE_RESPONSE_OPENING_HOURS_PARSE && hoursRaw) {
          const parsed = checkOpenNow(hoursRaw);
          open = parsed.open;
          nextChange = parsed.nextChange;
        }
        // Default to fast heuristic to reduce CPU and parser noise.
        if (open === null) {
          const h = heuristicOpen(amenity);
          open = h.open;
          nextChange = h.nextChange;
        }
        // Only keep confirmed-open places
        if (open !== true) continue;
        placeNodes.push({
          lat,
          lng,
          name,
          amenity,
          open,
          nextChange,
          opening_hours: hoursRaw,
        });
      }
    }

    // ── 10. Build response ────────────────────────────────────────────────
    const routes = rawRoutes.map((route, idx) => {
      const polyline = routeToPolyline(osmNodes, route.path);
      const breakdown = routeSafetyBreakdown(edges, route.edges, weights);
      const score100 = Math.round(breakdown.overall * 100);
      const { label, color } = safetyLabel(score100);
      const durationSec = Math.round(route.totalDist / WALKING_SPEED_MPS);

      // Build enriched segments with all metadata
      const segments = [];
      let deadEndCount = 0;
      let sidewalkDist = 0;
      let unpavedDist = 0;
      let transitStopCount = 0;
      let cctvNearCount = 0;
      const roadNameChanges = [];
      let lastRoadName = "";
      let cumulativeDist = 0;

      for (let i = 0; i < route.edges.length; i++) {
        const edge = edges[route.edges[i]];
        const nodeA = osmNodes.get(route.path[i]);
        const nodeB = osmNodes.get(route.path[i + 1]);
        if (!nodeA || !nodeB) continue;

        // Track stats
        if (edge.isDeadEnd) deadEndCount++;
        if (edge.hasSidewalk) sidewalkDist += edge.distance;
        if (edge.surfacePenalty > 0) unpavedDist += edge.distance;
        transitStopCount += edge.nearbyTransitCount;
        cctvNearCount += edge.nearbyCctvCount;

        // Track road name changes for chart annotations
        const rn = edge.roadName || "";
        if (rn && rn !== lastRoadName) {
          roadNameChanges.push({
            segmentIndex: i,
            name: rn,
            distance: Math.round(cumulativeDist),
          });
          lastRoadName = rn;
        }
        cumulativeDist += edge.distance;

        segments.push({
          start: { lat: nodeA.lat, lng: nodeA.lng },
          end: { lat: nodeB.lat, lng: nodeB.lng },
          safetyScore: edge.safetyScore,
          color: segmentColor(edge.safetyScore),
          highway: edge.highway,
          roadName: edge.roadName,
          isDeadEnd: edge.isDeadEnd,
          hasSidewalk: edge.hasSidewalk,
          surfaceType: edge.surfaceType,
          lightScore: edge.lightScore,
          crimeScore: edge.crimeScore,
          cctvScore: edge.cctvScore,
          placeScore: edge.placeScore,
          trafficScore: edge.trafficScore,
          distance: Math.round(edge.distance),
        });
      }

      // Collect nearby POIs along the route for map markers
      const routePOIs = collectRoutePOIs(
        route.path,
        route.edges,
        edges,
        osmNodes,
        cctvNodes,
        transitNodes,
        nodeDegree,
        lightNodes,
        placeNodes,
        crimes,
      );

      // Compute route stats
      const routeStats = {
        deadEnds: deadEndCount,
        sidewalkPct:
          route.totalDist > 0
            ? Math.round((sidewalkDist / route.totalDist) * 100)
            : 0,
        unpavedPct:
          route.totalDist > 0
            ? Math.round((unpavedDist / route.totalDist) * 100)
            : 0,
        transitStopsNearby: Math.min(transitStopCount, 50),
        cctvCamerasNearby: Math.min(cctvNearCount, 50),
        roadNameChanges,
      };

      return {
        routeIndex: idx,
        isSafest: idx === 0,
        overview_polyline: { points: encodePolyline(polyline) },
        legs: [
          {
            distance: {
              text:
                route.totalDist >= 1000
                  ? `${(route.totalDist / 1000).toFixed(1)} km`
                  : `${Math.round(route.totalDist)} m`,
              value: Math.round(route.totalDist),
            },
            duration: {
              text:
                durationSec >= 3600
                  ? `${Math.floor(durationSec / 3600)} hr ${Math.round((durationSec % 3600) / 60)} mins`
                  : `${Math.round(durationSec / 60)} mins`,
              value: durationSec,
            },
            start_location: { lat: oLatV, lng: oLngV },
            end_location: { lat: dLatV, lng: dLngV },
            steps: [],
          },
        ],
        summary: idx === 0 ? "Safest Route" : `Route ${idx + 1}`,
        safety: {
          score: score100,
          label,
          color,
          breakdown: {
            roadType: Math.round(breakdown.roadType * 100),
            lighting: Math.round(breakdown.lighting * 100),
            crime: Math.round(breakdown.crime * 100),
            cctv: Math.round(breakdown.cctv * 100),
            openPlaces: Math.round(breakdown.openPlaces * 100),
            traffic: Math.round(breakdown.traffic * 100),
          },
          roadTypes: breakdown.roadTypes,
          mainRoadRatio: Math.round(breakdown.mainRoadRatio * 100),
        },
        segments,
        routeStats,
        routePOIs,
      };
    });

    const minRoutes = Math.min(3, rawRoutes.length);
    const responseRoutes = routes.slice(0, Math.max(minRoutes, routes.length));

    const elapsed = Date.now() - startTime;
    cancelToken?.throwIfCancelled?.();
    progress("finalize", "Finalizing route output…", 90);
    console.log(
      `[safe-routes] 🏁 Done in ${elapsed}ms (corridor:${phase1Time}ms, data:${dataTime}ms, graph:${graphTime}ms, A*:${pathfindTime}ms, recorrection:${recorrectionMs}ms) — ${responseRoutes.length} routes, safest: ${responseRoutes[0]?.safety?.score}`,
    );

    return {
      status: "OK",
      routes: responseRoutes,
      meta: {
        straightLineDistanceKm: Math.round(straightLineKm * 10) / 10,
        maxDistanceKm: maxDistanceKm,
        routeCount: responseRoutes.length,
        dataQuality: {
          roads: roadCount,
          crimes: crimes.length,
          lightElements: allData.lights.elements.length,
          cctvCameras: allData.cctv.elements.length,
          places: allData.places.elements.length,
          transitStops: allData.transit.elements.length,
        },
        timing: {
          totalMs: elapsed,
          corridorDiscoveryMs: phase1Time,
          safetyDataFetchMs: dataTime,
          graphBuildMs: graphTime,
          pathfindMs: pathfindTime,
          recorrectionMs,
        },
        computeTimeMs: elapsed,
      },
    };
  } finally {
    if (typeof cancelUnsub === "function") cancelUnsub();
  }
}

/**
 * Collect POI positions along a route for map display.
 * Returns CCTV cameras, transit stops, dead-end nodes, street lights,
 * open places, and crime locations near the route path.
 *
 * Uses road-type-aware buffer distances:
 *  - Main roads (primary/secondary/tertiary/trunk): 20m — a CCTV on the
 *    opposite side of a wide road doesn't help this side.
 *  - Narrower/path roads (footway/path/steps/track etc): 30m — on a
 *    narrow path, nearby items are more relevant.
 *
 * Samples EVERY node on the route (no cap) so long routes have no gaps.
 */
const NEARBY_M = 30;

function collectRoutePOIs(
  routePath,
  routeEdges,
  allEdges,
  osmNodes,
  cctvNodes,
  transitNodes,
  nodeDegree,
  lightNodes,
  placeNodes,
  crimeNodes,
) {
  const pois = {
    cctv: [],
    transit: [],
    deadEnds: [],
    lights: [],
    places: [],
    crimes: [],
  };
  const seen = new Set();
  const DEG_PER_M = 1 / 111320;
  const CELL_DEG = NEARBY_M * DEG_PER_M;
  const routeGrid = new Map();

  function gridKey(r, c) {
    return `${r}:${c}`;
  }

  function toCell(lat, lng) {
    return {
      r: Math.floor(lat / CELL_DEG),
      c: Math.floor(lng / CELL_DEG),
    };
  }

  function indexRoutePoint(lat, lng) {
    const { r, c } = toCell(lat, lng);
    const key = gridKey(r, c);
    const arr = routeGrid.get(key);
    const point = { lat, lng };
    if (arr) {
      arr.push(point);
    } else {
      routeGrid.set(key, [point]);
    }
  }

  function isNearRoute(lat, lng) {
    const maxDelta = NEARBY_M * DEG_PER_M;
    const maxDeltaSq = maxDelta * maxDelta;
    const { r, c } = toCell(lat, lng);
    for (let rr = r - 1; rr <= r + 1; rr += 1) {
      for (let cc = c - 1; cc <= c + 1; cc += 1) {
        const bucket = routeGrid.get(gridKey(rr, cc));
        if (!bucket) continue;
        for (const p of bucket) {
          const dLat = lat - p.lat;
          const dLng = lng - p.lng;
          if (dLat * dLat + dLng * dLng <= maxDeltaSq) {
            return true;
          }
        }
      }
    }
    return false;
  }

  // Collect dead-end nodes on the route
  for (const nid of routePath) {
    const deg = nodeDegree.get(nid) || 0;
    if (deg <= 1) {
      const n = osmNodes.get(nid);
      if (n) {
        const key = `de:${n.lat.toFixed(5)},${n.lng.toFixed(5)}`;
        if (!seen.has(key)) {
          seen.add(key);
          pois.deadEnds.push({ lat: n.lat, lng: n.lng });
        }
      }
    }
  }

  // Build sample points from EVERY node on the route — full coverage, no gaps.
  for (let i = 0; i < routePath.length; i++) {
    const n = osmNodes.get(routePath[i]);
    if (n) indexRoutePoint(n.lat, n.lng);
  }

  // Collect CCTV near route
  for (const cam of cctvNodes) {
    if (isNearRoute(cam.lat, cam.lng)) {
      const key = `cc:${cam.lat.toFixed(5)},${cam.lng.toFixed(5)}`;
      if (!seen.has(key)) {
        seen.add(key);
        pois.cctv.push({ lat: cam.lat, lng: cam.lng });
      }
    }
  }

  // Collect transit stops near route
  for (const ts of transitNodes) {
    if (isNearRoute(ts.lat, ts.lng)) {
      const key = `tr:${ts.lat.toFixed(5)},${ts.lng.toFixed(5)}`;
      if (!seen.has(key)) {
        seen.add(key);
        pois.transit.push({ lat: ts.lat, lng: ts.lng });
      }
    }
  }

  // Collect street lights near route
  for (const lamp of lightNodes || []) {
    if (isNearRoute(lamp.lat, lamp.lng)) {
      const key = `lt:${lamp.lat.toFixed(5)},${lamp.lng.toFixed(5)}`;
      if (!seen.has(key)) {
        seen.add(key);
        pois.lights.push({ lat: lamp.lat, lng: lamp.lng });
      }
    }
  }

  // Collect places near route (with name, open status, and hours)
  for (const pl of placeNodes || []) {
    if (isNearRoute(pl.lat, pl.lng)) {
      const key = `pl:${pl.lat.toFixed(5)},${pl.lng.toFixed(5)}`;
      if (!seen.has(key)) {
        seen.add(key);
        pois.places.push({
          lat: pl.lat,
          lng: pl.lng,
          name: pl.name,
          amenity: pl.amenity,
          open: pl.open,
          nextChange: pl.nextChange,
          opening_hours: pl.opening_hours,
        });
      }
    }
  }

  // Collect crimes near route
  for (const cr of crimeNodes || []) {
    if (isNearRoute(cr.lat, cr.lng)) {
      const key = `cr:${cr.lat.toFixed(5)},${cr.lng.toFixed(5)}`;
      if (!seen.has(key)) {
        seen.add(key);
        pois.crimes.push({ lat: cr.lat, lng: cr.lng, category: cr.category });
      }
    }
  }

  return pois;
}

module.exports = router;
