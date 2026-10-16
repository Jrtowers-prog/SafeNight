const fs = require('fs');
const os = require('os');
const path = require('path');

const LEDGER_MODULE_PATH = '../../../../src/safety/services/osUsageLedger';
const GUARD_MODULE_PATH = '../../../../src/safety/services/osSpendGuard';
const ESTIMATOR_MODULE_PATH = '../../../../src/safety/services/osTransactionEstimator';

function loadGuardWithEnv(env = {}) {
  const prev = {};
  for (const [key, value] of Object.entries(env)) {
    prev[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  jest.resetModules();
  const ledger = require(LEDGER_MODULE_PATH);
  ledger.__resetForTests?.();
  const guard = require(GUARD_MODULE_PATH);
  guard.resetCapStateForTests?.();
  return {
    ...guard,
    restoreEnv() {
      for (const key of Object.keys(env)) {
        if (prev[key] == null) delete process.env[key];
        else process.env[key] = prev[key];
      }
    },
  };
}

describe('osSpendGuard', () => {
  let cacheDir;

  afterEach(() => {
    jest.restoreAllMocks();
    if (cacheDir) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      cacheDir = null;
    }
  });

  test('checkCap allows call when under cap', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-os-guard-'));
    const { checkCap, restoreEnv } = loadGuardWithEnv({
      SAFE_ROUTES_CACHE_DIR: cacheDir,
      OS_MONTHLY_CAP_GBP: '1000',
      OS_CAP_SAFETY_THRESHOLD_PERCENT: '10',
    });

    const result = await checkCap(100);
    expect(result.allowed).toBe(true);
    expect(result.remainingGbp).toBeGreaterThan(0);
    restoreEnv();
  });

  test('checkCap blocks when projected exceeds cap', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-os-guard-'));
    const { checkCap, restoreEnv } = loadGuardWithEnv({
      SAFE_ROUTES_CACHE_DIR: cacheDir,
      OS_MONTHLY_CAP_GBP: '100',
      OS_CAP_SAFETY_THRESHOLD_PERCENT: '0',
    });

    await expect(checkCap(150)).rejects.toThrow('Service is currently under maintanace and unavailable');
    restoreEnv();
  });

  test('checkCap applies safety margin', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-os-guard-'));
    const { checkCap, restoreEnv } = loadGuardWithEnv({
      SAFE_ROUTES_CACHE_DIR: cacheDir,
      OS_MONTHLY_CAP_GBP: '100',
      OS_CAP_SAFETY_THRESHOLD_PERCENT: '10',
    });

    // 100 GBP cap with 10% margin means 90.91 GBP raw is the limit
    // So 95 GBP should be blocked
    await expect(checkCap(95)).rejects.toThrow('Service is currently under maintanace and unavailable');
    restoreEnv();
  });

  test('isCapBreached returns true after cap exceeded', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-os-guard-'));
    const { checkCap, isCapBreached, restoreEnv } = loadGuardWithEnv({
      SAFE_ROUTES_CACHE_DIR: cacheDir,
      OS_MONTHLY_CAP_GBP: '50',
      OS_CAP_SAFETY_THRESHOLD_PERCENT: '0',
    });

    expect(isCapBreached()).toBe(false);
    await expect(checkCap(100)).rejects.toThrow('Service is currently under maintanace and unavailable');
    expect(isCapBreached()).toBe(true);
    restoreEnv();
  });

  test('fast fail on subsequent calls after breach', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-os-guard-'));
    const { checkCap, restoreEnv } = loadGuardWithEnv({
      SAFE_ROUTES_CACHE_DIR: cacheDir,
      OS_MONTHLY_CAP_GBP: '50',
      OS_CAP_SAFETY_THRESHOLD_PERCENT: '0',
    });

    await expect(checkCap(100)).rejects.toThrow('Service is currently under maintanace and unavailable');
    // Second call should fail immediately without ledger I/O
    await expect(checkCap(1)).rejects.toThrow('Service is currently under maintanace and unavailable');
    restoreEnv();
  });

  test('reconcile updates confirmed spend', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-os-guard-'));
    const { checkCap, reconcile, getRemainingGbp, restoreEnv } = loadGuardWithEnv({
      SAFE_ROUTES_CACHE_DIR: cacheDir,
      OS_MONTHLY_CAP_GBP: '1000',
      OS_CAP_SAFETY_THRESHOLD_PERCENT: '10',
    });

    await checkCap(50);
    await reconcile({
      api: 'os-ngd-features',
      transactionType: 'feature_request',
      confirmedTransactions: 1,
      confirmedSpendGbp: 50,
      idempotencyKey: 'test-key-1',
    });

    const remaining = getRemainingGbp();
    expect(remaining).toBeLessThanOrEqual(950);
    restoreEnv();
  });

  test('OsCapExceededError has correct properties', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-os-guard-'));
    const { checkCap, OsCapExceededError, restoreEnv } = loadGuardWithEnv({
      SAFE_ROUTES_CACHE_DIR: cacheDir,
      OS_MONTHLY_CAP_GBP: '10',
      OS_CAP_SAFETY_THRESHOLD_PERCENT: '0',
    });

    try {
      await checkCap(100);
      fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OsCapExceededError);
      expect(err.message).toBe('Service is currently under maintanace and unavailable');
      expect(err.code).toBe('OS_CAP_EXCEEDED');
      expect(err.statusCode).toBe(503);
      expect(err.isServerBusy).toBe(true);
    }
    restoreEnv();
  });
});
