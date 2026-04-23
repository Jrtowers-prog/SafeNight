/**
 * spatialIndex.js — Build and query a Flatbush R-tree spatial index.
 */

const fs = require('fs');
const path = require('path');
const Flatbush = require(path.join(__dirname, '../node_modules/flatbush/flatbush.js'));
const { DATA_DIR } = require('./config');

const WAYS_INDEX_PATH = path.join(DATA_DIR, 'ways-rtree.idx');
const NODES_INDEX_PATH = path.join(DATA_DIR, 'nodes-rtree.idx');
const WAYS_OFFSETS_PATH = path.join(DATA_DIR, 'ways-offsets.bin');
const NODES_OFFSETS_PATH = path.join(DATA_DIR, 'nodes-offsets.bin');
const WAYS_DATA_PATH = path.join(DATA_DIR, 'uk-roads.jsonl');
const NODES_DATA_PATH = path.join(DATA_DIR, 'uk-nodes.jsonl');

function getOffsetsPath(indexPath) {
  const parsed = path.parse(indexPath);
  const baseName = parsed.name.replace(/-rtree$/, '');
  return path.join(parsed.dir, `${baseName}-offsets.bin`);
}

async function iterateJsonlLines(dataPath, onLine) {
  const readStream = fs.createReadStream(dataPath);
  let carry = Buffer.alloc(0);
  let bytesReadFromStream = 0;

  for await (const chunk of readStream) {
    const combined = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    const fileStartOffset = bytesReadFromStream - carry.length;
    let cursor = 0;

    while (true) {
      const newlineIndex = combined.indexOf(10, cursor);
      if (newlineIndex === -1) break;
      const lineBuffer = combined.subarray(cursor, newlineIndex);
      const lineStartOffset = fileStartOffset + cursor;
      onLine(lineBuffer, lineStartOffset);
      cursor = newlineIndex + 1;
    }

    carry = combined.subarray(cursor);
    bytesReadFromStream += chunk.length;
  }

  if (carry.length) {
    const lineStartOffset = bytesReadFromStream - carry.length;
    onLine(carry, lineStartOffset);
  }
}

function toIndexBounds(feature) {
  if (feature.type === 'way' && feature.bbox) {
    return {
      minX: feature.bbox.minLon,
      minY: feature.bbox.minLat,
      maxX: feature.bbox.maxLon,
      maxY: feature.bbox.maxLat,
    };
  }

  if (feature.type === 'node') {
    return {
      minX: feature.lon,
      minY: feature.lat,
      maxX: feature.lon,
      maxY: feature.lat,
    };
  }

  return null;
}

async function buildIndex(dataPath, indexPath, offsetsPath = getOffsetsPath(indexPath)) {
  const entries = [];
  const offsetStream = fs.createWriteStream(offsetsPath);
  let offsetStreamError = null;
  offsetStream.on('error', (err) => {
    offsetStreamError = err;
  });

  await iterateJsonlLines(dataPath, (lineBuffer, lineStartOffset) => {
    const line = lineBuffer.toString('utf8').trim();
    if (!line) return;

    let feature;
    try {
      feature = JSON.parse(line);
    } catch {
      return;
    }

    const bounds = toIndexBounds(feature);
    if (!bounds) return;

    entries.push(bounds);

    const offsetBuffer = Buffer.allocUnsafe(8);
    offsetBuffer.writeBigUInt64LE(BigInt(lineStartOffset), 0);
    offsetStream.write(offsetBuffer);
  });

  await new Promise((resolve, reject) => {
    offsetStream.end((err) => {
      if (err) return reject(err);
      if (offsetStreamError) return reject(offsetStreamError);
      resolve();
    });
  });

  const index = new Flatbush(entries.length);
  for (const entry of entries) {
    index.add(entry.minX, entry.minY, entry.maxX, entry.maxY);
  }
  index.finish();

  const serialized = index.data;
  await fs.promises.writeFile(indexPath, Buffer.from(serialized));

  return { index, featureCount: entries.length, offsetsPath };
}

async function loadIndex(indexPath, dataPath, offsetsPath = getOffsetsPath(indexPath)) {
  const [indexBuffer, dataStat, offsetsStat, offsetsHandle, dataHandle] = await Promise.all([
    fs.promises.readFile(indexPath),
    fs.promises.stat(dataPath),
    fs.promises.stat(offsetsPath),
    fs.promises.open(offsetsPath, 'r'),
    fs.promises.open(dataPath, 'r'),
  ]);

  const arrayBuffer = indexBuffer.buffer.slice(
    indexBuffer.byteOffset,
    indexBuffer.byteOffset + indexBuffer.byteLength
  );
  const index = Flatbush.from(arrayBuffer);

  const offsetCount = Math.floor(offsetsStat.size / 8);

  return {
    index,
    dataPath,
    dataSize: dataStat.size,
    offsetsPath,
    offsetCount,
    offsetsHandle,
    dataHandle,
    async close() {
      await Promise.all([
        offsetsHandle?.close().catch(() => {}),
        dataHandle?.close().catch(() => {}),
      ]);
    },
  };
}

function queryBbox(indexData, south, west, north, east) {
  const { index } = indexData;
  const ids = index.search(west, south, east, north);
  return ids;
}

async function fetchFeaturesByIds(dataPath, ids, indexData = null) {

  if (!Array.isArray(ids) || ids.length === 0) {
    return [];
  }

  const loadedDataPath = indexData?.dataPath || dataPath;
  let offsetsHandle = indexData?.offsetsHandle || null;
  let dataHandle = indexData?.dataHandle || null;
  const offsetsPath = indexData?.offsetsPath || null;
  let offsetCount = Number.isInteger(indexData?.offsetCount) ? indexData.offsetCount : null;
  const openedHandles = [];

  try {
    if (!offsetsHandle) {
      if (!offsetsPath) {
        throw new Error('Offset index handle is required for random-access feature reads');
      }

      offsetsHandle = await fs.promises.open(offsetsPath, 'r');
      openedHandles.push(offsetsHandle);
      const offsetsStat = await fs.promises.stat(offsetsPath);
      offsetCount = Math.floor(offsetsStat.size / 8);
    }

    if (!dataHandle) {
      dataHandle = await fs.promises.open(loadedDataPath, 'r');
      openedHandles.push(dataHandle);
    }

    const features = [];
    for (const rawId of ids) {
      if (!Number.isInteger(rawId) || rawId < 0) {
        continue;
      }
      if (offsetCount !== null && rawId >= offsetCount) {
        continue;
      }

      const feature = await readFeatureAtId(dataHandle, offsetsHandle, rawId);
      if (feature) {
        features.push(feature);
      }
    }

    return features;
  } finally {
    await Promise.all(openedHandles.map((handle) => handle.close().catch(() => {})));
  }
}

async function readFeatureAtId(dataHandle, offsetsHandle, id) {
  const offsetBuffer = Buffer.allocUnsafe(8);
  const { bytesRead } = await offsetsHandle.read(offsetBuffer, 0, 8, id * 8);
  if (bytesRead < 8) {
    return null;
  }

  const offset = Number(offsetBuffer.readBigUInt64LE(0));
  if (!Number.isFinite(offset) || offset < 0) {
    return null;
  }

  const chunks = [];
  let totalLength = 0;
  let position = offset;
  const scratch = Buffer.allocUnsafe(1024);

  while (true) {
    const readResult = await dataHandle.read(scratch, 0, scratch.length, position);
    if (!readResult.bytesRead) {
      break;
    }

    const view = scratch.subarray(0, readResult.bytesRead);
    const newlineIndex = view.indexOf(10);

    if (newlineIndex !== -1) {
      if (newlineIndex > 0) {
        const part = Buffer.from(view.subarray(0, newlineIndex));
        chunks.push(part);
        totalLength += part.length;
      }
      break;
    }

    const part = Buffer.from(view);
    chunks.push(part);
    totalLength += part.length;
    position += readResult.bytesRead;
  }

  if (totalLength === 0) {
    return null;
  }

  const line = Buffer.concat(chunks, totalLength).toString('utf8').trim();
  if (!line) {
    return null;
  }

  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

module.exports = {
  buildIndex,
  loadIndex,
  queryBbox,
  fetchFeaturesByIds,
  WAYS_INDEX_PATH,
  NODES_INDEX_PATH,
  WAYS_OFFSETS_PATH,
  NODES_OFFSETS_PATH,
  WAYS_DATA_PATH,
  NODES_DATA_PATH,
  getOffsetsPath,
};
