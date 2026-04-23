const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE_PATH = '../../../../src/safety/services/osUsageLedger';

function loadLedgerWithEnv(env = {}) {
  const prev = {};
  for (const [key, value] of Object.entries(env)) {
    prev[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  jest.resetModules();
  const mod = require(MODULE_PATH);
  mod.__resetForTests?.();
  return {
    ...mod,
    restoreEnv() {
      for (const key of Object.keys(env)) {
        if (prev[key] == null) delete process.env[key];
        else process.env[key] = prev[key];
      }
    },
  };
}

describe('osUsageLedger', () => {
  let cacheDir;

  afterEach(() => {
    jest.restoreAllMocks();
    if (cacheDir) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      cacheDir = null;
    }
  });

  test('recordProjected writes entry and returns recorded=true', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-os-ledger-'));
    const { recordProjected, restoreEnv } = loadLedgerWithEnv({
      SAFE_ROUTES_CACHE_DIR: cacheDir,
    });

    const result = await recordProjected({
      api: 'os-ngd-features',
      transactionType: 'feature_request',
      projectedTransactions: 5,
      estimatedSpendGbp: 0.00095,
      idempotencyKey: 'test-key-1',
    });

    expect(result.recorded).toBe(true);
    expect(result.yearMonth).toMatch(/^\d{4}-\d{2}$/);
    restoreEnv();
  });

  test('recordProjected is idempotent for same key', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-os-ledger-'));
    const { recordProjected, restoreEnv } = loadLedgerWithEnv({
      SAFE_ROUTES_CACHE_DIR: cacheDir,
    });

    const first = await recordProjected({
      api: 'os-ngd-features',
      transactionType: 'feature_request',
      projectedTransactions: 5,
      estimatedSpendGbp: 0.00095,
      idempotencyKey: 'test-key-1',
    });
    expect(first.recorded).toBe(true);

    const second = await recordProjected({
      api: 'os-ngd-features',
      transactionType: 'feature_request',
      projectedTransactions: 10,
      estimatedSpendGbp: 0.0019,
      idempotencyKey: 'test-key-1',
    });
    expect(second.recorded).toBe(false);
    restoreEnv();
  });

  test('recordConfirmed appends confirmation entry', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-os-ledger-'));
    const { recordProjected, recordConfirmed, getCurrentMonthTotals, restoreEnv } = loadLedgerWithEnv({
      SAFE_ROUTES_CACHE_DIR: cacheDir,
    });

    await recordProjected({
      api: 'os-ngd-features',
      transactionType: 'feature_request',
      projectedTransactions: 5,
      estimatedSpendGbp: 0.00095,
      idempotencyKey: 'test-key-2',
    });

    await recordConfirmed({
      api: 'os-ngd-features',
      transactionType: 'feature_request',
      confirmedTransactions: 5,
      confirmedSpendGbp: 0.00095,
      idempotencyKey: 'test-key-2',
    });

    const totals = await getCurrentMonthTotals();
    expect(totals.totalProjectedTransactions).toBe(5);
    expect(totals.totalConfirmedTransactions).toBe(5);
    expect(totals.totalEstimatedSpendGbp).toBeCloseTo(0.00095, 5);
    expect(totals.totalConfirmedSpendGbp).toBeCloseTo(0.00095, 5);
    restoreEnv();
  });

  test('getMonthTotals deduplicates projected entries by idempotencyKey', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-os-ledger-'));
    const { recordProjected, getCurrentMonthTotals, restoreEnv } = loadLedgerWithEnv({
      SAFE_ROUTES_CACHE_DIR: cacheDir,
    });

    // Same key written twice (should only count once)
    await recordProjected({
      api: 'os-ngd-features',
      transactionType: 'feature_request',
      projectedTransactions: 5,
      estimatedSpendGbp: 0.00095,
      idempotencyKey: 'dup-key',
    });
    await recordProjected({
      api: 'os-ngd-features',
      transactionType: 'feature_request',
      projectedTransactions: 5,
      estimatedSpendGbp: 0.00095,
      idempotencyKey: 'dup-key',
    });

    const totals = await getCurrentMonthTotals();
    expect(totals.totalProjectedTransactions).toBe(5);
    restoreEnv();
  });

  test('archiveMonth moves ledger file to archived path', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-os-ledger-'));
    const { recordProjected, archiveMonth, getCurrentYearMonth, restoreEnv } = loadLedgerWithEnv({
      SAFE_ROUTES_CACHE_DIR: cacheDir,
    });

    await recordProjected({
      api: 'os-ngd-features',
      transactionType: 'feature_request',
      projectedTransactions: 1,
      estimatedSpendGbp: 0.0001,
      idempotencyKey: 'archive-test',
    });

    const yearMonth = getCurrentYearMonth();
    const archivePath = await archiveMonth(yearMonth);
    expect(archivePath).toContain('.archived-');
    expect(fs.existsSync(archivePath)).toBe(true);
    restoreEnv();
  });

  test('hashIdempotencyKey produces consistent hashes', () => {
    const { hashIdempotencyKey, restoreEnv } = loadLedgerWithEnv({});
    const h1 = hashIdempotencyKey('api1', 'route1', 'bbox1', '2026-04-21');
    const h2 = hashIdempotencyKey('api1', 'route1', 'bbox1', '2026-04-21');
    const h3 = hashIdempotencyKey('api1', 'route1', 'bbox1', '2026-04-22');
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1).toHaveLength(32);
    restoreEnv();
  });
});
