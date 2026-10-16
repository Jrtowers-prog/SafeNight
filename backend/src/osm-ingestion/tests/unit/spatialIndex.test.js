const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  buildIndex,
  loadIndex,
  queryBbox,
  fetchFeaturesByIds,
  getOffsetsPath,
} = require('../../src/spatialIndex');

describe('spatialIndex', () => {
  let tmpDir;
  let dataPath;
  let indexPath;
  let offsetsPath;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safenight-spatial-'));
    dataPath = path.join(tmpDir, 'test.jsonl');
    indexPath = path.join(tmpDir, 'test.idx');
    offsetsPath = getOffsetsPath(indexPath);

    const features = [
      { type: 'way', id: 1, bbox: { minLon: -0.1, minLat: 51.0, maxLon: -0.09, maxLat: 51.01 } },
      { type: 'way', id: 2, bbox: { minLon: -0.2, minLat: 51.1, maxLon: -0.19, maxLat: 51.11 } },
      { type: 'node', id: 3, lon: -0.095, lat: 51.005 },
    ];

    const lines = features.map((f) => JSON.stringify(f)).join('\n') + '\n';
    await fs.promises.writeFile(dataPath, lines);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('buildIndex creates index and offsets files', async () => {
    const { index, featureCount, offsetsPath: createdOffsetsPath } = await buildIndex(dataPath, indexPath);
    expect(index).toBeDefined();
    expect(featureCount).toBe(3);
    expect(fs.existsSync(indexPath)).toBe(true);
    expect(fs.existsSync(createdOffsetsPath)).toBe(true);
    expect(createdOffsetsPath).toBe(offsetsPath);
  });

  test('loadIndex reads back index and offsets metadata', async () => {
    await buildIndex(dataPath, indexPath);
    const loaded = await loadIndex(indexPath, dataPath);
    expect(loaded.index).toBeDefined();
    expect(loaded.dataSize).toBeGreaterThan(0);
    expect(loaded.offsetCount).toBe(3);
    expect(loaded.offsetsPath).toBe(offsetsPath);
    await loaded.close();
  });

  test('queryBbox returns matching ids', async () => {
    await buildIndex(dataPath, indexPath);
    const loaded = await loadIndex(indexPath, dataPath);
    const ids = queryBbox(loaded, 51.0, -0.1, 51.02, -0.08);
    expect(ids.length).toBeGreaterThan(0);
    await loaded.close();
  });

  test('fetchFeaturesByIds returns correct features for queried ids', async () => {
    await buildIndex(dataPath, indexPath);
    const loaded = await loadIndex(indexPath, dataPath);
    const ids = queryBbox(loaded, 51.0, -0.1, 51.02, -0.08);
    const features = await fetchFeaturesByIds(dataPath, ids, loaded);
    expect(features.length).toBeGreaterThan(0);
    expect(features[0]).toHaveProperty('type');
    await loaded.close();
  });

  test('fetchFeaturesByIds preserves requested id order for sparse random lists', async () => {
    await buildIndex(dataPath, indexPath);
    const loaded = await loadIndex(indexPath, dataPath);

    const features = await fetchFeaturesByIds(dataPath, [2, 0, 1], loaded);
    expect(features.map((f) => f.id)).toEqual([3, 1, 2]);

    await loaded.close();
  });

  test('fetchFeaturesByIds skips invalid or missing ids safely', async () => {
    await buildIndex(dataPath, indexPath);
    const loaded = await loadIndex(indexPath, dataPath);

    const features = await fetchFeaturesByIds(dataPath, [1, 99, -1, 2.5, 0], loaded);
    expect(features.map((f) => f.id)).toEqual([2, 1]);

    await loaded.close();
  });
});
