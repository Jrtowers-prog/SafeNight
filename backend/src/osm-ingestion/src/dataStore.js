/**
 * dataStore.js — Load and serve published dataset with hot-reload support.
 */

const fs = require('fs');
const path = require('path');
const { loadIndex, queryBbox, fetchFeaturesByIds } = require('./spatialIndex');
const { PUBLISH_DIR, MAX_AGE_HOURS } = require('./config');

const PUBLISH_WAYS = path.join(PUBLISH_DIR, 'uk-roads.jsonl');
const PUBLISH_NODES = path.join(PUBLISH_DIR, 'uk-nodes.jsonl');
const PUBLISH_WAYS_IDX = path.join(PUBLISH_DIR, 'ways-rtree.idx');
const PUBLISH_NODES_IDX = path.join(PUBLISH_DIR, 'nodes-rtree.idx');
const PUBLISH_WAYS_OFFSETS = path.join(PUBLISH_DIR, 'ways-offsets.bin');
const PUBLISH_NODES_OFFSETS = path.join(PUBLISH_DIR, 'nodes-offsets.bin');
const META_PATH = path.join(PUBLISH_DIR, 'meta.json');

let waysIndex = null;
let nodesIndex = null;
let lastLoadedAt = 0;

async function closeLoadedIndexes() {
  await Promise.all([
    waysIndex?.close?.().catch(() => {}),
    nodesIndex?.close?.().catch(() => {}),
  ]);
  waysIndex = null;
  nodesIndex = null;
}

async function reloadIfNeeded() {
  try {
    const metaStat = await fs.promises.stat(META_PATH);
    const mtime = metaStat.mtimeMs;

    if (mtime > lastLoadedAt) {
      console.log('[dataStore] Reloading published dataset...');
      await closeLoadedIndexes();
      const [w, n] = await Promise.all([
        loadIndex(PUBLISH_WAYS_IDX, PUBLISH_WAYS, PUBLISH_WAYS_OFFSETS),
        loadIndex(PUBLISH_NODES_IDX, PUBLISH_NODES, PUBLISH_NODES_OFFSETS),
      ]);
      waysIndex = w;
      nodesIndex = n;
      lastLoadedAt = Date.now();
      console.log('[dataStore] Dataset loaded');
    }
  } catch (err) {
    console.warn(`[dataStore] Failed to load dataset: ${err.message}`);
  }
}

async function queryBboxData(south, west, north, east) {
  await reloadIfNeeded();

  if (!waysIndex || !nodesIndex) {
    throw new Error('Dataset not loaded');
  }

  const wayIds = queryBbox(waysIndex, south, west, north, east);
  const nodeIds = queryBbox(nodesIndex, south, west, north, east);

  const [ways, nodes] = await Promise.all([
    fetchFeaturesByIds(PUBLISH_WAYS, wayIds, waysIndex),
    fetchFeaturesByIds(PUBLISH_NODES, nodeIds, nodesIndex),
  ]);

  return { ways, nodes };
}

async function getStats() {
  await reloadIfNeeded();

  let meta = null;
  try {
    meta = JSON.parse(await fs.promises.readFile(META_PATH, 'utf8'));
  } catch {
    // ignore
  }

  const ageHours = lastLoadedAt ? ((Date.now() - lastLoadedAt) / 3600000).toFixed(1) : null;

  return {
    loaded: !!waysIndex && !!nodesIndex,
    lastLoadedAt: lastLoadedAt ? new Date(lastLoadedAt).toISOString() : null,
    ageHours: ageHours ? Number(ageHours) : null,
    maxAgeHours: MAX_AGE_HOURS,
    meta,
  };
}

module.exports = {
  reloadIfNeeded,
  queryBboxData,
  getStats,
};
