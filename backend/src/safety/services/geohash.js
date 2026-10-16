/**
 * geohash.js — Lightweight geohash encode/decode for spatial indexing.
 *
 * No external dependencies. Uses base32 encoding.
 * Precision guide:
 *   4 chars ≈ 20km
 *   5 chars ≈ 2.4km
 *   6 chars ≈ 0.61km  ← default for lights_cache
 *   7 chars ≈ 0.076km
 *   8 chars ≈ 0.019km
 */

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/**
 * Encode lat/lon to geohash string.
 * @param {number} lat — latitude (-90 to 90)
 * @param {number} lon — longitude (-180 to 180)
 * @param {number} precision — number of characters (default 6)
 * @returns {string} geohash
 */
function encode(lat, lon, precision = 6) {
  let idx = 0;
  let bit = 0;
  let evenBit = true;
  let geohash = '';

  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;

  while (geohash.length < precision) {
    if (evenBit) {
      // bisect longitude range
      const lonMid = (lonMin + lonMax) / 2;
      if (lon >= lonMid) {
        idx = (idx << 1) + 1;
        lonMin = lonMid;
      } else {
        idx = idx << 1;
        lonMax = lonMid;
      }
    } else {
      // bisect latitude range
      const latMid = (latMin + latMax) / 2;
      if (lat >= latMid) {
        idx = (idx << 1) + 1;
        latMin = latMid;
      } else {
        idx = idx << 1;
        latMax = latMid;
      }
    }

    evenBit = !evenBit;
    bit += 1;

    if (bit === 5) {
      geohash += BASE32[idx];
      bit = 0;
      idx = 0;
    }
  }

  return geohash;
}

/**
 * Decode geohash to bounding box.
 * @param {string} geohash
 * @returns {Object} { south, west, north, east }
 */
function decode(geohash) {
  let evenBit = true;
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;

  for (let i = 0; i < geohash.length; i++) {
    const cd = BASE32.indexOf(geohash[i]);
    for (let j = 4; j >= 0; j--) {
      const bit = (cd >> j) & 1;
      if (evenBit) {
        const lonMid = (lonMin + lonMax) / 2;
        if (bit === 1) {
          lonMin = lonMid;
        } else {
          lonMax = lonMid;
        }
      } else {
        const latMid = (latMin + latMax) / 2;
        if (bit === 1) {
          latMin = latMid;
        } else {
          latMax = latMid;
        }
      }
      evenBit = !evenBit;
    }
  }

  return {
    south: latMin,
    west: lonMin,
    north: latMax,
    east: lonMax,
  };
}

/**
 * Get neighbors of a geohash (N, NE, E, SE, S, SW, W, NW).
 * @param {string} geohash
 * @returns {Object} { n, ne, e, se, s, sw, w, nw }
 */
function neighbors(geohash) {
  const bbox = decode(geohash);
  const height = bbox.north - bbox.south;
  const width = bbox.east - bbox.west;

  const n = encode(bbox.north + height / 2, (bbox.west + bbox.east) / 2, geohash.length);
  const s = encode(bbox.south - height / 2, (bbox.west + bbox.east) / 2, geohash.length);
  const e = encode((bbox.south + bbox.north) / 2, bbox.east + width / 2, geohash.length);
  const w = encode((bbox.south + bbox.north) / 2, bbox.west - width / 2, geohash.length);

  return {
    n,
    ne: encode(bbox.north + height / 2, bbox.east + width / 2, geohash.length),
    e,
    se: encode(bbox.south - height / 2, bbox.east + width / 2, geohash.length),
    s,
    sw: encode(bbox.south - height / 2, bbox.west - width / 2, geohash.length),
    w,
    nw: encode(bbox.north + height / 2, bbox.west - width / 2, geohash.length),
  };
}

module.exports = {
  encode,
  decode,
  neighbors,
};
