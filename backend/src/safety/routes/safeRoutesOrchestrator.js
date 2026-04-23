function createSafeRoutesOrchestrator({
  computeSafeRoutes,
  estimateRequestLoadUnits,
  enqueueComputeJob,
  waitWithCancellation,
  formatWaitMmSs,
  cacheTtlMs = 5 * 60 * 1000,
  maxCacheEntries = 100,
}) {
  const routeCache = new Map();
  const inflight = new Map();

  function getResponsePolicyKey(responsePolicy) {
    const verbosity = responsePolicy?.verbosity === "compact" ? "compact" : "full";
    const poiCaps = responsePolicy?.poiCaps || {};
    const categories = ["cctv", "transit", "deadEnds", "lights", "places", "crimes"];
    const capsPart = categories
      .map((category) => {
        const capValue = poiCaps[category];
        return Number.isFinite(capValue) ? `${category}:${capValue}` : `${category}:default`;
      })
      .join("|");

    return `${verbosity}|${capsPart}`;
  }

  function getCacheKey(oLat, oLng, dLat, dLng, wpLat, wpLng, responsePolicy, departureHour, allowHazards) {
    const r = (v) => Math.round(v * 1000) / 1000;
    const base = `${r(oLat)},${r(oLng)}->${r(dLat)},${r(dLng)}`;
    const routeKey = wpLat != null && wpLng != null
      ? `${base}@${r(wpLat)},${r(wpLng)}`
      : base;
    const dhPart = departureHour != null ? `h${departureHour}` : '';
    const hazardPart = allowHazards ? 'H' : '';

    return `${routeKey}${dhPart}${hazardPart}#${getResponsePolicyKey(responsePolicy)}`;
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

  function pruneRouteCache() {
    if (routeCache.size <= maxCacheEntries) return;
    const now = Date.now();
    for (const [key, val] of routeCache) {
      if (now - val.timestamp > cacheTtlMs) routeCache.delete(key);
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
    departureHour = null,
    allowHazards = false,
    responsePolicy,
    onProgress,
    cancelToken = null,
  }) {
    cancelToken?.throwIfCancelled?.();
    const cacheKey = getCacheKey(
      oLat,
      oLng,
      dLat,
      dLng,
      wpLat,
      wpLng,
      responsePolicy,
      departureHour,
      allowHazards,
    );
    const cached = routeCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < cacheTtlMs) {
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

    if (typeof onProgress === "function") {
      inflightEntry.progressListeners.add(onProgress);
    }

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
            departureHour,
            allowHazards,
            cancelToken,
            (phase, message, pct) =>
              emitInflightProgress(inflightEntry, phase, message, pct),
            responsePolicy,
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
    } finally {
      inflight.delete(cacheKey);
      pruneRouteCache();
    }
  }

  function hasInflightRequest({
    oLat,
    oLng,
    dLat,
    dLng,
    wpLat,
    wpLng,
    responsePolicy,
    departureHour,
    allowHazards,
  }) {
    const key = getCacheKey(oLat, oLng, dLat, dLng, wpLat, wpLng, responsePolicy, departureHour, allowHazards);
    return inflight.has(key);
  }

  return {
    resolveSafeRoutesRequest,
    hasInflightRequest,
  };
}

module.exports = {
  createSafeRoutesOrchestrator,
};
