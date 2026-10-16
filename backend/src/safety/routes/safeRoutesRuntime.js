const os = require("os");

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
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
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

  const isExactCompanion =
    previous &&
    previous.searchId === searchId &&
    previous.searchSeq === searchSeq &&
    previous.clientId === clientId;

  if (isExactCompanion) {
    logSearchCancellation("companion_attached", {
      userKey,
      activeClientId: previous.clientId,
      companionClientId: clientId,
      searchId,
      activeSeq: previous.searchSeq,
      companionSeq: searchSeq,
    });
    return {
      userKey,
      searchId,
      searchSeq,
      clientId,
      replacedPrevious: false,
      stale: false,
      companion: true,
      release: () => {},
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
    process.env.SAFE_ROUTES_MAX_SERVER_LOAD_UNITS || DEFAULT_MAX_SERVER_LOAD_UNITS,
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
  Number(process.env.SAFE_ROUTES_MAX_REQUEST_LOAD_UNITS || MAX_SERVER_LOAD_UNITS),
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

function estimateRequestLoadUnits({ straightLineKm, maxDistanceKm, hasWaypoint }) {
  const distanceKm =
    Number.isFinite(maxDistanceKm) && maxDistanceKm > 0
      ? maxDistanceKm
      : Number.isFinite(straightLineKm)
        ? straightLineKm
        : 0;
  const distanceLoad = distanceKm * LOAD_UNITS_PER_KM;
  const raw =
    MIN_REQUEST_LOAD_UNITS + distanceLoad + (hasWaypoint ? WAYPOINT_LOAD_BONUS : 0);
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
    const capacityByLoad = currentLoad + next.loadUnits <= MAX_SERVER_LOAD_UNITS;
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
  const hasLoadCapacity = activeLoadUnits + requestLoadUnits <= MAX_SERVER_LOAD_UNITS;
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
    if (job.lastNotifiedPosition === index && job.lastNotifiedWaitMs === waitMs) return;
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
      if (nextJob && typeof nextJob.cancelUnsub === "function") nextJob.cancelUnsub();
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

module.exports = {
  createCancellationToken,
  logSearchCancellation,
  registerActiveSearch,
  estimateRequestLoadUnits,
  enqueueComputeJob,
  waitWithCancellation,
  formatWaitMmSs,
};
