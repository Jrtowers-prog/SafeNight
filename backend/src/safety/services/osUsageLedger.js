/**
 * osUsageLedger.js — Durable monthly usage tracking for OS API spend.
 *
 * Stores projected + confirmed transactions per API per month.
 * Supports idempotent reconciliation for retries.
 * Partitioned by year-month (YYYY-MM).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEDGER_DIR = (() => {
  const base = (process.env.SAFE_ROUTES_CACHE_DIR || '').trim();
  if (!base) return null;
  return path.resolve(base, 'os-ledger');
})();

const BILLING_TIMEZONE = process.env.OS_BILLING_TIMEZONE || 'Europe/London';

function getCurrentYearMonth() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: BILLING_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const year = parts.find((p) => p.type === 'year').value;
  const month = parts.find((p) => p.type === 'month').value;
  return `${year}-${month}`;
}

function getLedgerFilePath(yearMonth) {
  if (!LEDGER_DIR) return null;
  return path.join(LEDGER_DIR, `${yearMonth}.jsonl`);
}

async function ensureLedgerDir() {
  if (!LEDGER_DIR) return;
  await fs.promises.mkdir(LEDGER_DIR, { recursive: true });
}

function hashIdempotencyKey(api, routeKey, bboxHash, day) {
  return crypto
    .createHash('sha256')
    .update(`${api}:${routeKey}:${bboxHash}:${day}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Read all entries for a given year-month from disk.
 * Returns array of parsed entry objects.
 */
async function readMonthEntries(yearMonth) {
  const filePath = getLedgerFilePath(yearMonth);
  if (!filePath) return [];
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    return lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    console.warn(`[os-ledger] Failed reading ledger: ${err.message}`);
    return [];
  }
}

/**
 * Append a single entry to the month ledger.
 */
async function appendEntry(yearMonth, entry) {
  const filePath = getLedgerFilePath(yearMonth);
  if (!filePath) return;
  await ensureLedgerDir();
  const line = JSON.stringify(entry) + '\n';
  await fs.promises.appendFile(filePath, line, 'utf8');
}

/**
 * Write a projected transaction estimate.
 * If an entry with the same idempotencyKey already exists for this month,
 * it is NOT duplicated (idempotent).
 */
async function recordProjected({
  api,
  transactionType,
  projectedTransactions,
  estimatedSpendGbp,
  idempotencyKey,
  requestContext = {},
}) {
  const yearMonth = getCurrentYearMonth();
  const entries = await readMonthEntries(yearMonth);
  const exists = entries.some((e) => e.idempotencyKey === idempotencyKey && e.recordType === 'projected');
  if (exists) {
    return { recorded: false, yearMonth };
  }

  const entry = {
    recordType: 'projected',
    api,
    transactionType,
    projectedTransactions,
    confirmedTransactions: 0,
    estimatedSpendGbp,
    idempotencyKey,
    timestamp: new Date().toISOString(),
    requestContext,
  };

  await appendEntry(yearMonth, entry);
  return { recorded: true, yearMonth };
}

/**
 * Reconcile a projected entry with confirmed actuals.
 * Finds the matching projected entry by idempotencyKey and appends a
 * confirmation entry. If no projected entry exists, appends a standalone
 * confirmed entry.
 */
async function recordConfirmed({
  api,
  transactionType,
  confirmedTransactions,
  confirmedSpendGbp,
  idempotencyKey,
  requestContext = {},
}) {
  const yearMonth = getCurrentYearMonth();
  const entries = await readMonthEntries(yearMonth);
  const projectedEntry = entries.find((e) => e.idempotencyKey === idempotencyKey && e.recordType === 'projected');

  const entry = {
    recordType: 'confirmed',
    api,
    transactionType,
    projectedTransactions: projectedEntry ? projectedEntry.projectedTransactions : 0,
    confirmedTransactions,
    estimatedSpendGbp: projectedEntry ? projectedEntry.estimatedSpendGbp : 0,
    confirmedSpendGbp,
    idempotencyKey,
    timestamp: new Date().toISOString(),
    requestContext,
  };

  await appendEntry(yearMonth, entry);
  return { recorded: true, yearMonth };
}

/**
 * Compute totals for a given year-month.
 * Returns { totalProjectedTransactions, totalConfirmedTransactions, totalEstimatedSpendGbp, totalConfirmedSpendGbp }
 */
async function getMonthTotals(yearMonth) {
  const entries = await readMonthEntries(yearMonth);
  let totalProjectedTransactions = 0;
  let totalConfirmedTransactions = 0;
  let totalEstimatedSpendGbp = 0;
  let totalConfirmedSpendGbp = 0;
  const seenProjected = new Set();

  for (const entry of entries) {
    if (entry.recordType === 'projected' && !seenProjected.has(entry.idempotencyKey)) {
      seenProjected.add(entry.idempotencyKey);
      totalProjectedTransactions += Number(entry.projectedTransactions || 0);
      totalEstimatedSpendGbp += Number(entry.estimatedSpendGbp || 0);
    }
    if (entry.recordType === 'confirmed') {
      totalConfirmedTransactions += Number(entry.confirmedTransactions || 0);
      totalConfirmedSpendGbp += Number(entry.confirmedSpendGbp || 0);
    }
  }

  return {
    totalProjectedTransactions,
    totalConfirmedTransactions,
    totalEstimatedSpendGbp,
    totalConfirmedSpendGbp,
  };
}

/**
 * Get the current month's totals.
 */
async function getCurrentMonthTotals() {
  const yearMonth = getCurrentYearMonth();
  return getMonthTotals(yearMonth);
}

/**
 * Reset / archive a month ledger. Returns the archived file path.
 */
async function archiveMonth(yearMonth) {
  const filePath = getLedgerFilePath(yearMonth);
  if (!filePath) return null;
  try {
    await fs.promises.access(filePath);
    const archivePath = `${filePath}.archived-${Date.now()}`;
    await fs.promises.rename(filePath, archivePath);
    return archivePath;
  } catch {
    return null;
  }
}

function __resetForTests() {
  // No-op for tests that use temporary directories
}

module.exports = {
  getCurrentYearMonth,
  recordProjected,
  recordConfirmed,
  getMonthTotals,
  getCurrentMonthTotals,
  archiveMonth,
  hashIdempotencyKey,
  __resetForTests,
};
