/**
 * download.js — Download UK OSM PBF from Geofabrik.
 */

const fs = require('fs');
const path = require('path');

const { PBF_URL, DATA_DIR } = require('./config');

function getPbfPath() {
  return path.join(DATA_DIR, 'gb-latest.osm.pbf');
}

function getPbfTempPath() {
  return path.join(DATA_DIR, `gb-latest.osm.pbf.tmp-${Date.now()}`);
}

async function downloadPbf() {
  const dest = getPbfPath();
  const temp = getPbfTempPath();

  await fs.promises.mkdir(DATA_DIR, { recursive: true });

  console.log(`[download] Fetching ${PBF_URL} ...`);
  const t0 = Date.now();

  const resp = await fetch(PBF_URL, {
    headers: {
      'User-Agent': 'SafeNight-OSM-Ingestion/1.0 (contact: support@safenight.app)',
    },
  });

  if (!resp.ok) {
    throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  }

  const fileStream = fs.createWriteStream(temp);
  const reader = resp.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fileStream.write(Buffer.from(value));
    }
  } finally {
    fileStream.end();
    await new Promise((resolve, reject) => {
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });
  }

  await fs.promises.rename(temp, dest);
  const stats = await fs.promises.stat(dest);
  const elapsed = Date.now() - t0;
  console.log(`[download] Saved ${(stats.size / 1024 / 1024).toFixed(1)} MB in ${elapsed}ms`);

  return { path: dest, sizeBytes: stats.size };
}

module.exports = {
  downloadPbf,
  getPbfPath,
};
