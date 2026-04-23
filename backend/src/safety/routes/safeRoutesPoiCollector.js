/**
 * Collect POI positions along a route for map display.
 * Returns CCTV cameras, transit stops, dead-end nodes, street lights,
 * open places, and crime locations near the route path.
 */

const NEARBY_M = 45;
const DEG_PER_M = 1 / 111320;
const CELL_DEG = NEARBY_M * DEG_PER_M;
const MAX_DELTA = NEARBY_M * DEG_PER_M;
const MAX_DELTA_SQ = MAX_DELTA * MAX_DELTA;

function gridKey(r, c) {
  return `${r}:${c}`;
}

function toCell(lat, lng) {
  return {
    r: Math.floor(lat / CELL_DEG),
    c: Math.floor(lng / CELL_DEG),
  };
}

function indexRoutePoint(routeGrid, lat, lng) {
  const { r, c } = toCell(lat, lng);
  const key = gridKey(r, c);
  const points = routeGrid.get(key);
  const point = { lat, lng };
  if (points) {
    points.push(point);
  } else {
    routeGrid.set(key, [point]);
  }
}

function isNearRoute(routeGrid, lat, lng) {
  const { r, c } = toCell(lat, lng);
  for (let rr = r - 1; rr <= r + 1; rr += 1) {
    for (let cc = c - 1; cc <= c + 1; cc += 1) {
      const bucket = routeGrid.get(gridKey(rr, cc));
      if (!bucket) continue;
      for (const point of bucket) {
        const dLat = lat - point.lat;
        const dLng = lng - point.lng;
        if (dLat * dLat + dLng * dLng <= MAX_DELTA_SQ) {
          return true;
        }
      }
    }
  }
  return false;
}

function collectRoutePOIs(
  routePath,
  osmNodes,
  cctvNodes,
  transitNodes,
  nodeDegree,
  lightNodes,
  placeNodes,
  crimeNodes,
) {
  const pois = {
    cctv: [],
    transit: [],
    deadEnds: [],
    lights: [],
    places: [],
    crimes: [],
  };
  const seen = new Set();
  const routeGrid = new Map();

  for (const nodeId of routePath) {
    const degree = nodeDegree.get(nodeId) || 0;
    if (degree <= 1) {
      const node = osmNodes.get(nodeId);
      if (node) {
        const key = `de:${node.lat.toFixed(5)},${node.lng.toFixed(5)}`;
        if (!seen.has(key)) {
          seen.add(key);
          pois.deadEnds.push({ lat: node.lat, lng: node.lng });
        }
      }
    }
  }

  for (const nodeId of routePath) {
    const node = osmNodes.get(nodeId);
    if (node) indexRoutePoint(routeGrid, node.lat, node.lng);
  }

  for (const cam of cctvNodes || []) {
    if (!isNearRoute(routeGrid, cam.lat, cam.lng)) continue;
    const key = `cc:${cam.lat.toFixed(5)},${cam.lng.toFixed(5)}`;
    if (!seen.has(key)) {
      seen.add(key);
      pois.cctv.push({ lat: cam.lat, lng: cam.lng });
    }
  }

  for (const stop of transitNodes || []) {
    if (!isNearRoute(routeGrid, stop.lat, stop.lng)) continue;
    const key = `tr:${stop.lat.toFixed(5)},${stop.lng.toFixed(5)}`;
    if (!seen.has(key)) {
      seen.add(key);
      pois.transit.push({ lat: stop.lat, lng: stop.lng });
    }
  }

  for (const lamp of lightNodes || []) {
    if (!isNearRoute(routeGrid, lamp.lat, lamp.lng)) continue;
    const key = `lt:${lamp.lat.toFixed(5)},${lamp.lng.toFixed(5)}`;
    if (!seen.has(key)) {
      seen.add(key);
      pois.lights.push({ lat: lamp.lat, lng: lamp.lng });
    }
  }

  for (const place of placeNodes || []) {
    if (!isNearRoute(routeGrid, place.lat, place.lng)) continue;
    const key = `pl:${place.lat.toFixed(5)},${place.lng.toFixed(5)}`;
    if (!seen.has(key)) {
      seen.add(key);
      pois.places.push({
        lat: place.lat,
        lng: place.lng,
        name: place.name,
        amenity: place.amenity,
        open: place.open,
        nextChange: place.nextChange,
        opening_hours: place.opening_hours,
      });
    }
  }

  for (const crime of crimeNodes || []) {
    if (!isNearRoute(routeGrid, crime.lat, crime.lng)) continue;
    const key = `cr:${crime.lat.toFixed(5)},${crime.lng.toFixed(5)}`;
    if (!seen.has(key)) {
      seen.add(key);
      pois.crimes.push({
        lat: crime.lat,
        lng: crime.lng,
        category: crime.category,
      });
    }
  }

  return pois;
}

module.exports = {
  collectRoutePOIs,
};
