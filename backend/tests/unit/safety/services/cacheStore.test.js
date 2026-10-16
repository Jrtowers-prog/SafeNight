const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSafetyCacheStore } = require('../../../../src/safety/services/cacheStore');

describe('cacheStore', () => {
  let cacheDir;

  afterEach(() => {
    if (cacheDir) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      cacheDir = null;
    }
  });

  test('returns fresh values from memory and expires stale entries', async () => {
    const store = createSafetyCacheStore({
      namespace: 'memory-only',
      ttlMs: 100,
      cacheDir: '',
    });

    await store.set('bbox:1', { value: 1 });
    await expect(store.get('bbox:1')).resolves.toEqual({ value: 1 });

    await new Promise((resolve) => setTimeout(resolve, 140));
    await expect(store.get('bbox:1')).resolves.toBeNull();
  });

  test('persists entries to disk using hashed filenames and survives new store instance', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-cache-'));
    const key = 'bbox:51.5001,-0.1,51.6001,-0.0';

    const storeA = createSafetyCacheStore({
      namespace: 'overpass-data',
      ttlMs: 5000,
      cacheDir,
    });

    await storeA.set(key, { elements: [{ id: 1 }] });

    const files = fs.readdirSync(cacheDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^overpass-data-[a-f0-9]{64}\.json$/);
    expect(files[0]).not.toContain('bbox:51.5001');

    const storeB = createSafetyCacheStore({
      namespace: 'overpass-data',
      ttlMs: 5000,
      cacheDir,
    });

    await expect(storeB.get(key)).resolves.toEqual({ elements: [{ id: 1 }] });
  });

  test('removes stale disk entries on read', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-cache-'));
    const key = 'crime:1,2,3,4';

    const storeA = createSafetyCacheStore({
      namespace: 'crime-data',
      ttlMs: 80,
      cacheDir,
    });

    await storeA.set(key, [{ category: 'unknown' }]);
    await new Promise((resolve) => setTimeout(resolve, 120));

    const storeB = createSafetyCacheStore({
      namespace: 'crime-data',
      ttlMs: 80,
      cacheDir,
    });

    await expect(storeB.get(key)).resolves.toBeNull();
    expect(fs.readdirSync(cacheDir).length).toBe(0);
  });
});
