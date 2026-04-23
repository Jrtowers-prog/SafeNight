/**
 * filter.js — Stream-process PBF and extract only safety-relevant features.
 *
 * Uses osmium command-line tool if available, otherwise falls back to
 * a Node.js streaming parser (slower but no native deps).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { DATA_DIR } = require('./config');

// Tags we keep on ways (roads/paths)
const WAY_KEEP_TAGS = new Set([
  'highway', 'name', 'lit', 'sidewalk', 'cycleway', 'busway',
  'surface', 'access', 'oneway', 'maxspeed',
]);

// Highway values we keep
const HIGHWAY_KEEP = new Set([
  'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'living_street',
  'pedestrian', 'footway', 'cycleway', 'path',
  'steps', 'service', 'track',
]);

// Node tag filters
const NODE_FILTERS = [
  { key: 'highway', value: 'street_lamp' },
  { key: 'man_made', value: 'surveillance' },
  { key: 'highway', value: 'bus_stop' },
  { key: 'public_transport', value: 'stop_position' },
  { key: 'public_transport', value: 'platform' },
  { key: 'railway', value: 'station' },
  { key: 'station', value: 'subway' },
];

// Amenity/shop/leisure/tourism are kept as open places
const OPEN_PLACE_KEYS = new Set(['amenity', 'shop', 'leisure', 'tourism']);
const OPEN_PLACE_KEEP_TAGS = new Set([
  'amenity', 'shop', 'leisure', 'tourism',
  'name', 'opening_hours', 'brand', 'operator',
]);

function shouldKeepWay(tags) {
  const highway = tags?.highway;
  if (!highway) return false;
  return HIGHWAY_KEEP.has(highway);
}

function filterWayTags(tags) {
  const filtered = {};
  for (const [k, v] of Object.entries(tags)) {
    if (WAY_KEEP_TAGS.has(k)) filtered[k] = v;
  }
  return filtered;
}

function shouldKeepNode(tags) {
  if (!tags) return false;
  for (const f of NODE_FILTERS) {
    if (tags[f.key] === f.value) return true;
  }
  for (const k of OPEN_PLACE_KEYS) {
    if (tags[k]) return true;
  }
  return false;
}

function filterNodeTags(tags) {
  const filtered = {};
  for (const [k, v] of Object.entries(tags)) {
    if (OPEN_PLACE_KEEP_TAGS.has(k)) {
      filtered[k] = v;
    } else {
      for (const f of NODE_FILTERS) {
        if (k === f.key) filtered[k] = v;
      }
    }
  }
  return filtered;
}

function getOsmiumPath() {
  return process.env.OSMIUM_PATH || 'osmium';
}

async function osmiumAvailable() {
  return new Promise((resolve) => {
    const child = spawn(getOsmiumPath(), ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function filterWithOsmium(pbfPath) {
  const waysOut = path.join(DATA_DIR, 'ways-filtered.osm.pbf');
  const nodesOut = path.join(DATA_DIR, 'nodes-filtered.osm.pbf');

  const waysFilter = spawn(getOsmiumPath(), [
    'tags-filter',
    pbfPath,
    'w/highway=trunk,primary,secondary,tertiary,unclassified,residential,living_street,pedestrian,footway,cycleway,path,steps,service,track',
    '-o', waysOut,
    '--overwrite',
  ], { stdio: 'inherit' });

  await new Promise((resolve, reject) => {
    waysFilter.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`osmium ways filter exited ${code}`)));
  });

  const nodesFilter = spawn(getOsmiumPath(), [
    'tags-filter',
    pbfPath,
    'n/highway=street_lamp',
    'n/man_made=surveillance',
    'n/highway=bus_stop',
    'n/public_transport=stop_position',
    'n/public_transport=platform',
    'n/railway=station',
    'n/station=subway',
    'n/amenity',
    'n/shop',
    'n/leisure',
    'n/tourism',
    '-o', nodesOut,
    '--overwrite',
  ], { stdio: 'inherit' });

  await new Promise((resolve, reject) => {
    nodesFilter.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`osmium nodes filter exited ${code}`)));
  });

  return { waysPath: waysOut, nodesPath: nodesOut };
}

async function filterPbf(pbfPath) {
  const hasOsmium = await osmiumAvailable();
  if (hasOsmium) {
    console.log('[filter] Using osmium for fast filtering');
    return filterWithOsmium(pbfPath);
  }
  throw new Error('osmium not available — install osmium-tool or set OSMIUM_PATH');
}

module.exports = {
  filterPbf,
  shouldKeepWay,
  filterWayTags,
  shouldKeepNode,
  filterNodeTags,
  HIGHWAY_KEEP,
  WAY_KEEP_TAGS,
  NODE_FILTERS,
};
