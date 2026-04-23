/**
 * osMetrics.js — Observability for OS-first routing.
 *
 * Metrics (in-memory counters, logged every 60s):
 *   - os_transactions_total by api, type
 *   - os_spend_estimated_gbp
 *   - os_spend_confirmed_gbp
 *   - os_cap_remaining_gbp
 *   - os_cap_block_count
 *   - osm_fallback_ratio
 *   - overpass_calls_avoided
 *   - route_latency_p50 and p95
 */

const METRICS_LOG_INTERVAL_MS = 60_000;

const counters = {
  osTransactionsTotal: new Map(), // key: `${api}:${type}` → count
  osSpendEstimatedGbp: 0,
  osSpendConfirmedGbp: 0,
  osCapRemainingGbp: 0,
  osCapBlockCount: 0,
  osmFallbackCount: 0,
  osmTotalCount: 0,
  overpassCallsAvoided: 0,
  localOsmPrimaryCount: 0,
  osNgdGapFillCount: 0,
  lightVerificationSent: 0,
  lightVerificationCached: 0,
  routeLatenciesMs: [],
};

function recordTransaction(api, type, count = 1) {
  const key = `${api}:${type}`;
  counters.osTransactionsTotal.set(key, (counters.osTransactionsTotal.get(key) || 0) + count);
}

function recordEstimatedSpend(gbp) {
  counters.osSpendEstimatedGbp += Number(gbp) || 0;
}

function recordConfirmedSpend(gbp) {
  counters.osSpendConfirmedGbp += Number(gbp) || 0;
}

function recordCapRemaining(gbp) {
  counters.osCapRemainingGbp = Number(gbp) || 0;
}

function recordCapBlock() {
  counters.osCapBlockCount += 1;
}

function recordSourceDecision(source) {
  counters.osmTotalCount += 1;
  if (source === 'osm_fallback' || source === 'osm') {
    counters.osmFallbackCount += 1;
  }
  if (source === 'local_osm') {
    counters.localOsmPrimaryCount += 1;
    counters.overpassCallsAvoided += 1;
  }
  if (source === 'os') {
    counters.overpassCallsAvoided += 1;
  }
}

function recordOsNgdGapFill() {
  counters.osNgdGapFillCount += 1;
}

function recordLightVerification(sent, cached) {
  counters.lightVerificationSent += sent || 0;
  counters.lightVerificationCached += cached || 0;
}

function recordRouteLatency(ms) {
  counters.routeLatenciesMs.push(Number(ms) || 0);
  // Keep last 1000 samples
  if (counters.routeLatenciesMs.length > 1000) {
    counters.routeLatenciesMs.shift();
  }
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}

function getLatencyStats() {
  const sorted = [...counters.routeLatenciesMs].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    count: sorted.length,
  };
}

function getOsmFallbackRatio() {
  if (counters.osmTotalCount === 0) return 0;
  return counters.osmFallbackCount / counters.osmTotalCount;
}

function formatMetrics() {
  const latency = getLatencyStats();
  const transactions = {};
  for (const [key, count] of counters.osTransactionsTotal.entries()) {
    transactions[key] = count;
  }

  return {
    event: 'os_metrics_snapshot',
    timestamp: new Date().toISOString(),
    os_transactions_total: transactions,
    os_spend_estimated_gbp: Math.round(counters.osSpendEstimatedGbp * 10000) / 10000,
    os_spend_confirmed_gbp: Math.round(counters.osSpendConfirmedGbp * 10000) / 10000,
    os_cap_remaining_gbp: Math.round(counters.osCapRemainingGbp * 10000) / 10000,
    os_cap_block_count: counters.osCapBlockCount,
    osm_fallback_ratio: Math.round(getOsmFallbackRatio() * 1000) / 1000,
    overpass_calls_avoided: counters.overpassCallsAvoided,
    local_osm_primary_count: counters.localOsmPrimaryCount,
    os_ngd_gap_fill_count: counters.osNgdGapFillCount,
    light_verification_sent: counters.lightVerificationSent,
    light_verification_cached: counters.lightVerificationCached,
    route_latency_p50: latency.p50,
    route_latency_p95: latency.p95,
    route_latency_p99: latency.p99,
    route_latency_count: latency.count,
  };
}

function logMetrics() {
  console.log(JSON.stringify(formatMetrics()));
}

// Start periodic logging
let metricsInterval = null;
function startMetricsLogging() {
  if (metricsInterval) return;
  metricsInterval = setInterval(logMetrics, METRICS_LOG_INTERVAL_MS);
  metricsInterval.unref?.();
}

function stopMetricsLogging() {
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
  }
}

function resetMetricsForTests() {
  counters.osTransactionsTotal.clear();
  counters.osSpendEstimatedGbp = 0;
  counters.osSpendConfirmedGbp = 0;
  counters.osCapRemainingGbp = 0;
  counters.osCapBlockCount = 0;
  counters.osmFallbackCount = 0;
  counters.osmTotalCount = 0;
  counters.overpassCallsAvoided = 0;
  counters.localOsmPrimaryCount = 0;
  counters.osNgdGapFillCount = 0;
  counters.lightVerificationSent = 0;
  counters.lightVerificationCached = 0;
  counters.routeLatenciesMs = [];
}

module.exports = {
  recordTransaction,
  recordEstimatedSpend,
  recordConfirmedSpend,
  recordCapRemaining,
  recordCapBlock,
  recordSourceDecision,
  recordOsNgdGapFill,
  recordLightVerification,
  recordRouteLatency,
  formatMetrics,
  logMetrics,
  startMetricsLogging,
  stopMetricsLogging,
  resetMetricsForTests,
  getLatencyStats,
  getOsmFallbackRatio,
};
