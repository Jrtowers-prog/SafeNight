/**
 * normalize.js — Convert filtered OSM PBF to compact JSONL.
 *
 * Uses osmium export for fast conversion, then strips unnecessary fields.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DATA_DIR } = require('./config');
const { filterWayTags, filterNodeTags } = require('./filter');

function getOsmiumPath() {
  return process.env.OSMIUM_PATH || 'osmium';
}

async function exportToGeoJSON(pbfPath, outPath) {
  const child = spawn(getOsmiumPath(), [
    'export',
    '-f', 'geojsonseq',
    '-c', 'id,tags,geometry,nodes',
    pbfPath,
    '-o', outPath,
    '--overwrite',
  ], { stdio: 'inherit' });

  await new Promise((resolve, reject) => {
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`osmium export exited ${code}`)));
  });
}

function computeBbox(geometry) {
  if (!geometry || !geometry.coordinates) return null;
  const coords = geometry.coordinates;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;

  function visit(c) {
    if (Array.isArray(c[0])) {
      c.forEach(visit);
    } else {
      const [lon, lat] = c;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }

  visit(coords);
  return { minLon, minLat, maxLon, maxLat };
}

async function normalizeWays(waysGeoJSONPath, outPath) {
  const readStream = fs.createReadStream(waysGeoJSONPath, { encoding: 'utf8' });
  const writeStream = fs.createWriteStream(outPath);

  let buffer = '';
  let count = 0;

  for await (const chunk of readStream) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const feature = JSON.parse(line);
        const tags = filterWayTags(feature.properties || {});
        if (!tags.highway) continue;

        const record = {
          type: 'way',
          id: feature.id || feature.properties?.id,
          nodes: feature.properties?.nodes || [],
          tags,
          bbox: computeBbox(feature.geometry),
        };

        writeStream.write(JSON.stringify(record) + '\n');
        count++;
      } catch {
        // skip malformed lines
      }
    }
  }

  writeStream.end();
  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  return count;
}

async function normalizeNodes(nodesGeoJSONPath, outPath) {
  const readStream = fs.createReadStream(nodesGeoJSONPath, { encoding: 'utf8' });
  const writeStream = fs.createWriteStream(outPath);

  let buffer = '';
  let count = 0;

  for await (const chunk of readStream) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const feature = JSON.parse(line);
        const tags = filterNodeTags(feature.properties || {});
        if (Object.keys(tags).length === 0) continue;

        const [lon, lat] = feature.geometry?.coordinates || [null, null];
        if (lon == null || lat == null) continue;

        const record = {
          type: 'node',
          id: feature.id || feature.properties?.id,
          lat,
          lon,
          tags,
        };

        writeStream.write(JSON.stringify(record) + '\n');
        count++;
      } catch {
        // skip malformed lines
      }
    }
  }

  writeStream.end();
  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });

  return count;
}

async function normalizeFiltered(waysPbfPath, nodesPbfPath) {
  const waysGeoJSON = path.join(DATA_DIR, 'ways.geojsonseq');
  const nodesGeoJSON = path.join(DATA_DIR, 'nodes.geojsonseq');
  const waysJSONL = path.join(DATA_DIR, 'uk-roads.jsonl');
  const nodesJSONL = path.join(DATA_DIR, 'uk-nodes.jsonl');

  console.log('[normalize] Exporting ways to GeoJSONSeq...');
  await exportToGeoJSON(waysPbfPath, waysGeoJSON);

  console.log('[normalize] Exporting nodes to GeoJSONSeq...');
  await exportToGeoJSON(nodesPbfPath, nodesGeoJSON);

  console.log('[normalize] Normalizing ways...');
  const wayCount = await normalizeWays(waysGeoJSON, waysJSONL);

  console.log('[normalize] Normalizing nodes...');
  const nodeCount = await normalizeNodes(nodesGeoJSON, nodesJSONL);

  // Clean up intermediate files
  await Promise.all([
    fs.promises.unlink(waysGeoJSON).catch(() => {}),
    fs.promises.unlink(nodesGeoJSON).catch(() => {}),
  ]);

  console.log(`[normalize] Done: ${wayCount} ways, ${nodeCount} nodes`);
  return { waysPath: waysJSONL, nodesPath: nodesJSONL, wayCount, nodeCount };
}

module.exports = {
  normalizeFiltered,
  computeBbox,
};
