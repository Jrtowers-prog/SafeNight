function findRouteCandidates({
  wpLat,
  wpLng,
  nodeGrid,
  adjacency,
  startNode,
  endNode,
  osmNodes,
  edges,
  maxRouteDist,
  findNearestNode,
  findKSafestRoutes,
  logger = console,
  allowHazards = false,
  edgeConfidences = null,
}) {
  const aStarOptions = { allowHazards, edgeConfidences };

  if (wpLat != null) {
    const waypointNode = findNearestNode(nodeGrid, adjacency, wpLat, wpLng);

    if (waypointNode && waypointNode !== startNode && waypointNode !== endNode) {
      const leg1Routes = findKSafestRoutes(
        osmNodes,
        edges,
        adjacency,
        startNode,
        waypointNode,
        maxRouteDist * 0.7,
        1,
        aStarOptions,
      );
      const leg2Routes = findKSafestRoutes(
        osmNodes,
        edges,
        adjacency,
        waypointNode,
        endNode,
        maxRouteDist * 0.7,
        3,
        aStarOptions,
      );

      if (leg1Routes.length > 0 && leg2Routes.length > 0) {
        const leg1 = leg1Routes[0];
        const combinedRoutes = leg2Routes.map((leg2) => ({
          path: [...leg1.path, ...leg2.path.slice(1)],
          edges: [...leg1.edges, ...leg2.edges],
          totalDist: leg1.totalDist + leg2.totalDist,
        }));

        logger.log(
          `[safe-routes] 📍 Via waypoint node ${waypointNode}: ${leg1.path.length}+${leg2Routes[0].path.length} nodes, ${combinedRoutes.length} combined routes`,
        );

        return combinedRoutes;
      }

      logger.log(
        `[safe-routes] ⚠️  Via routing failed (leg1=${leg1Routes.length}, leg2=${leg2Routes.length}), falling back to direct`,
      );
      return findKSafestRoutes(
        osmNodes,
        edges,
        adjacency,
        startNode,
        endNode,
        maxRouteDist,
        3,
        aStarOptions,
      );
    }

    logger.log(
      `[safe-routes] ⚠️  Waypoint node not found in graph, falling back to direct`,
    );
    return findKSafestRoutes(
      osmNodes,
      edges,
      adjacency,
      startNode,
      endNode,
      maxRouteDist,
      3,
      aStarOptions,
    );
  }

  return findKSafestRoutes(
    osmNodes,
    edges,
    adjacency,
    startNode,
    endNode,
    maxRouteDist,
    3,
    aStarOptions,
  );
}

module.exports = {
  findRouteCandidates,
};
