/**
 * pipeline.js — Orchestrate download → filter → normalize → index → publish.
 */

const fs = require('fs');
const path = require('path');
const { downloadPbf } = require('./download');
const { filterPbf } = require('./filter');
const { normalizeFiltered } = require('./normalize');
const {
  buildIndex,
  WAYS_INDEX_PATH,
  NODES_INDEX_PATH,
  WAYS_OFFSETS_PATH,
  NODES_OFFSETS_PATH,
} = require('./spatialIndex');
const { DATA_DIR, MIN_FEATURE_COUNT } = require('./config');

const PUBLISH_DIR = path.join(DATA_DIR, 'published');
const STAGING_DIR = path.join(DATA_DIR, 'staging');

async function ensureDirs() {
  await fs.promises.mkdir(PUBLISH_DIR, { recursive: true });
  await fs.promises.mkdir(STAGING_DIR, { recursive: true });
}

async function validateDataset(waysPath, nodesPath, wayCount, nodeCount) {
  const total = wayCount + nodeCount;
  if (total < MIN_FEATURE_COUNT) {
    throw new Error(`Dataset too small: ${total} features (min ${MIN_FEATURE_COUNT})`);
  }

  const [waysStat, nodesStat] = await Promise.all([
    fs.promises.stat(waysPath),
    fs.promises.stat(nodesPath),
  ]);

  if (waysStat.size === 0 || nodesStat.size === 0) {
    throw new Error('Empty dataset files');
  }

  console.log(`[pipeline] Validation passed: ${wayCount} ways, ${nodeCount} nodes`);
}

async function atomicPublish(
  stagingWays,
  stagingNodes,
  stagingWaysIdx,
  stagingNodesIdx,
  stagingWaysOffsets,
  stagingNodesOffsets
) {
  const publishWays = path.join(PUBLISH_DIR, 'uk-roads.jsonl');
  const publishNodes = path.join(PUBLISH_DIR, 'uk-nodes.jsonl');
  const publishWaysIdx = path.join(PUBLISH_DIR, 'ways-rtree.idx');
  const publishNodesIdx = path.join(PUBLISH_DIR, 'nodes-rtree.idx');
  const publishWaysOffsets = path.join(PUBLISH_DIR, 'ways-offsets.bin');
  const publishNodesOffsets = path.join(PUBLISH_DIR, 'nodes-offsets.bin');
  const metaPath = path.join(PUBLISH_DIR, 'meta.json');

  // Write to temp then rename for atomicity
  const tempSuffix = `.tmp-${Date.now()}`;

  await fs.promises.copyFile(stagingWays, publishWays + tempSuffix);
  await fs.promises.copyFile(stagingNodes, publishNodes + tempSuffix);
  await fs.promises.copyFile(stagingWaysIdx, publishWaysIdx + tempSuffix);
  await fs.promises.copyFile(stagingNodesIdx, publishNodesIdx + tempSuffix);
  await fs.promises.copyFile(stagingWaysOffsets, publishWaysOffsets + tempSuffix);
  await fs.promises.copyFile(stagingNodesOffsets, publishNodesOffsets + tempSuffix);

  await fs.promises.rename(publishWays + tempSuffix, publishWays);
  await fs.promises.rename(publishNodes + tempSuffix, publishNodes);
  await fs.promises.rename(publishWaysIdx + tempSuffix, publishWaysIdx);
  await fs.promises.rename(publishNodesIdx + tempSuffix, publishNodesIdx);
  await fs.promises.rename(publishWaysOffsets + tempSuffix, publishWaysOffsets);
  await fs.promises.rename(publishNodesOffsets + tempSuffix, publishNodesOffsets);

  const meta = {
    publishedAt: new Date().toISOString(),
    waysFile: 'uk-roads.jsonl',
    nodesFile: 'uk-nodes.jsonl',
  };
  await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2));

  console.log('[pipeline] Published atomically');
}

async function runPipeline() {
  const t0 = Date.now();
  console.log('[pipeline] Starting daily ingestion...');

  await ensureDirs();

  // 1. Download
  const { path: pbfPath } = await downloadPbf();

  // 2. Filter
  const { waysPath: waysPbf, nodesPath: nodesPbf } = await filterPbf(pbfPath);

  // 3. Normalize
  const { waysPath, nodesPath, wayCount, nodeCount } = await normalizeFiltered(waysPbf, nodesPbf);

  // 4. Validate
  await validateDataset(waysPath, nodesPath, wayCount, nodeCount);

  // 5. Index
  console.log('[pipeline] Building spatial indexes...');
  await buildIndex(waysPath, WAYS_INDEX_PATH);
  await buildIndex(nodesPath, NODES_INDEX_PATH);

  // 6. Publish
  await atomicPublish(
    waysPath,
    nodesPath,
    WAYS_INDEX_PATH,
    NODES_INDEX_PATH,
    WAYS_OFFSETS_PATH,
    NODES_OFFSETS_PATH
  );

  // 7. Cleanup staging
  await Promise.all([
    fs.promises.unlink(waysPbf).catch(() => {}),
    fs.promises.unlink(nodesPbf).catch(() => {}),
    fs.promises.unlink(pbfPath).catch(() => {}),
  ]);

  const elapsed = Date.now() - t0;
  console.log(`[pipeline] Completed in ${elapsed}ms`);

  return { wayCount, nodeCount, elapsedMs: elapsed };
}

module.exports = {
  runPipeline,
  PUBLISH_DIR,
};
