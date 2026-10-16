/**
 * osSpendGuard.js — Pre/post-call cap enforcement for OS premium APIs.
 *
 * Hard-enforces the free-tier cap at server side.
 * If projected or reconciled premium usage exceeds configured free limit:
 *   - Block premium OS calls
 *   - Return server error with exact message:
 *     "Service is currently under maintanace and unavailable"
 *
 * Do not silently continue with paid premium usage.
 * Do not auto-fallback into unlimited paid mode.
 */

const {
  getCurrentYearMonth,
  getMonthTotals,
  archiveMonth,
} = require('./osUsageLedger');

const {
  applySafetyMargin,
} = require('./osTransactionEstimator');

const MONTHLY_CAP_GBP = Math.max(
  0,
  Number(process.env.OS_MONTHLY_CAP_GBP || 1000),
);

const OS_PLAN_MODE = (process.env.OS_PLAN_MODE || 'premium').trim().toLowerCase();

// Global fast-fail state
let _capBreached = false;
let _lastCheckedMonth = null;
let _cachedRemainingGbp = MONTHLY_CAP_GBP;

class OsCapExceededError extends Error {
  constructor(message = 'Service is currently under maintanace and unavailable') {
    super(message);
    this.code = 'OS_CAP_EXCEEDED';
    this.statusCode = 503;
    this.isServerBusy = true;
  }
}

/**
 * Check if the cap has been breached for the current month.
 * Called before every premium OS API call.
 */
async function checkCap(projectedCostGbp) {
  const currentMonth = getCurrentYearMonth();

  // Detect month rollover
  if (_lastCheckedMonth && _lastCheckedMonth !== currentMonth) {
    _capBreached = false;
    _cachedRemainingGbp = MONTHLY_CAP_GBP;
    await archiveMonth(_lastCheckedMonth);
  }
  _lastCheckedMonth = currentMonth;

  // Fast fail if already breached
  if (_capBreached) {
    throw new OsCapExceededError();
  }

  // Development mode is free but throttled — cap still enforced for safety
  if (OS_PLAN_MODE === 'development') {
    // Continue but still track
  }

  const totals = await getMonthTotals(currentMonth);
  const committedSpend = totals.totalEstimatedSpendGbp;
  const marginSpend = applySafetyMargin(Number(projectedCostGbp) || 0);
  const projectedTotal = committedSpend + marginSpend;

  if (projectedTotal > MONTHLY_CAP_GBP) {
    _capBreached = true;
    console.error(
      `[os-spend-guard] CAP BREACHED: projected=${projectedTotal.toFixed(4)} GBP ` +
      `(committed=${committedSpend.toFixed(4)} + margin=${marginSpend.toFixed(4)}), ` +
      `cap=${MONTHLY_CAP_GBP} GBP. Blocking premium OS calls.`
    );
    throw new OsCapExceededError();
  }

  _cachedRemainingGbp = Math.max(0, MONTHLY_CAP_GBP - committedSpend);
  return {
    allowed: true,
    remainingGbp: _cachedRemainingGbp,
    projectedTotalGbp: projectedTotal,
  };
}

/**
 * Reconcile after a successful API call.
 * Updates the ledger with confirmed spend.
 */
async function reconcile({
  api,
  transactionType,
  confirmedTransactions,
  confirmedSpendGbp,
  idempotencyKey,
  requestContext = {},
}) {
  const { recordConfirmed } = require('./osUsageLedger');
  await recordConfirmed({
    api,
    transactionType,
    confirmedTransactions,
    confirmedSpendGbp,
    idempotencyKey,
    requestContext,
  });

  // Refresh cached remaining
  const currentMonth = getCurrentYearMonth();
  const totals = await getMonthTotals(currentMonth);
  _cachedRemainingGbp = Math.max(0, MONTHLY_CAP_GBP - totals.totalConfirmedSpendGbp);

  // If confirmed spend itself pushed us over, breach immediately
  if (totals.totalConfirmedSpendGbp > MONTHLY_CAP_GBP) {
    _capBreached = true;
    console.error(
      `[os-spend-guard] CAP BREACHED by confirmed spend: ` +
      `confirmed=${totals.totalConfirmedSpendGbp.toFixed(4)} GBP, cap=${MONTHLY_CAP_GBP} GBP`
    );
  }
}

function isCapBreached() {
  return _capBreached;
}

function getRemainingGbp() {
  return _cachedRemainingGbp;
}

function resetCapStateForTests() {
  _capBreached = false;
  _lastCheckedMonth = null;
  _cachedRemainingGbp = MONTHLY_CAP_GBP;
}

module.exports = {
  checkCap,
  reconcile,
  isCapBreached,
  getRemainingGbp,
  OsCapExceededError,
  resetCapStateForTests,
};
