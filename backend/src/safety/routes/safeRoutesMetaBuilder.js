function buildSafeRoutesMeta({
  straightLineKm,
  maxDistanceKm,
  responseRoutes,
  roadCount,
  crimes,
  allData,
  elapsed,
  phase1Time,
  dataTime,
  graphTime,
  pathfindTime,
  recorrectionMs,
  dataSources,
  lightVerificationStatus,
  verifiedLightsCount,
}) {
  const meta = {
    straightLineDistanceKm: Math.round(straightLineKm * 10) / 10,
    maxDistanceKm,
    routeCount: responseRoutes.length,
    dataQuality: {
      roads: roadCount,
      crimes: crimes.length,
      lightElements: allData.lights.elements.length,
      cctvCameras: allData.cctv.elements.length,
      places: allData.places.elements.length,
      transitStops: allData.transit.elements.length,
    },
    timing: {
      totalMs: elapsed,
      corridorDiscoveryMs: phase1Time,
      safetyDataFetchMs: dataTime,
      graphBuildMs: graphTime,
      pathfindMs: pathfindTime,
      recorrectionMs,
    },
    computeTimeMs: elapsed,
  };

  if (dataSources && (dataSources.overpass || dataSources.crime || dataSources.os)) {
    meta.dataSources = {
      overpass: dataSources.overpass || null,
      crime: dataSources.crime || null,
      os: dataSources.os || null,
    };
  }

  if (allData && allData._sourceMeta) {
    meta.sourceProvenance = allData._sourceMeta;
  }

  // C4 — Data provenance and freshness
  const osmLightCount = allData.lights.elements.filter((e) => e.type === 'node' && e.tags?.highway === 'street_lamp').length;
  const osGapFillCount = verifiedLightsCount || 0;
  const coverageRatio = osmLightCount + osGapFillCount > 0
    ? osmLightCount / (osmLightCount + osGapFillCount)
    : 1;
  meta.dataQuality.freshness = {
    crimeLastUpdated: crimes.length > 0 && crimes[0]?.month ? crimes[0].month : null,
    lightsSource: osGapFillCount > 0 ? 'local_osm+os_ngd_gapfill' : 'local_osm',
    coverageRatio: Math.round(coverageRatio * 100) / 100,
    lightVerificationStatus: lightVerificationStatus || 'not_needed',
  };

  return meta;
}

module.exports = {
  buildSafeRoutesMeta,
};
