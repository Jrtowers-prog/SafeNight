/* eslint-env jest */
/* global jest, describe, test, expect */

const {
  findRouteCandidates,
} = require('../../../../src/safety/routes/safeRoutesCandidateFinder');

function createBaseArgs(overrides = {}) {
  return {
    wpLat: null,
    wpLng: null,
    nodeGrid: {},
    adjacency: new Map(),
    startNode: 'start',
    endNode: 'end',
    osmNodes: new Map(),
    edges: [],
    maxRouteDist: 1000,
    findNearestNode: jest.fn(() => null),
    findKSafestRoutes: jest.fn(() => [{ path: ['start', 'end'], edges: [0], totalDist: 100 }]),
    logger: { log: jest.fn() },
    ...overrides,
  };
}

describe('safeRoutesCandidateFinder', () => {
  test('uses direct route search when waypoint is not provided', () => {
    const args = createBaseArgs();

    const routes = findRouteCandidates(args);

    expect(args.findKSafestRoutes).toHaveBeenCalledTimes(1);
    expect(routes).toHaveLength(1);
  });

  test('falls back to direct route when waypoint node is missing', () => {
    const args = createBaseArgs({
      wpLat: 50.37,
      wpLng: -4.14,
      findNearestNode: jest.fn(() => null),
    });

    const routes = findRouteCandidates(args);

    expect(args.findNearestNode).toHaveBeenCalledTimes(1);
    expect(args.findKSafestRoutes).toHaveBeenCalledTimes(1);
    expect(args.logger.log).toHaveBeenCalledWith(
      expect.stringContaining('Waypoint node not found in graph'),
    );
    expect(routes).toHaveLength(1);
  });

  test('combines leg routes when via-waypoint pathfinding succeeds', () => {
    const args = createBaseArgs({
      wpLat: 50.37,
      wpLng: -4.14,
      findNearestNode: jest.fn(() => 'waypoint'),
      findKSafestRoutes: jest
        .fn()
        .mockReturnValueOnce([
          { path: ['start', 'waypoint'], edges: [1], totalDist: 40 },
        ])
        .mockReturnValueOnce([
          { path: ['waypoint', 'endA'], edges: [2], totalDist: 60 },
          { path: ['waypoint', 'endB'], edges: [3], totalDist: 80 },
        ]),
    });

    const routes = findRouteCandidates(args);

    expect(args.findKSafestRoutes).toHaveBeenCalledTimes(2);
    expect(routes).toEqual([
      { path: ['start', 'waypoint', 'endA'], edges: [1, 2], totalDist: 100 },
      { path: ['start', 'waypoint', 'endB'], edges: [1, 3], totalDist: 120 },
    ]);
  });

  test('falls back to direct route when waypoint equals start node', () => {
    const args = createBaseArgs({
      wpLat: 50.37,
      wpLng: -4.14,
      findNearestNode: jest.fn(() => 'start'),
    });

    const routes = findRouteCandidates(args);

    expect(args.findKSafestRoutes).toHaveBeenCalledTimes(1);
    expect(args.logger.log).toHaveBeenCalledWith(
      expect.stringContaining('Waypoint node not found in graph'),
    );
    expect(routes).toHaveLength(1);
  });

  test('falls back to direct route when one via leg has no route', () => {
    const args = createBaseArgs({
      wpLat: 50.37,
      wpLng: -4.14,
      findNearestNode: jest.fn(() => 'waypoint'),
      findKSafestRoutes: jest
        .fn()
        .mockReturnValueOnce([])
        .mockReturnValueOnce([{ path: ['waypoint', 'end'], edges: [2], totalDist: 60 }])
        .mockReturnValueOnce([{ path: ['start', 'end'], edges: [9], totalDist: 110 }]),
    });

    const routes = findRouteCandidates(args);

    expect(args.findKSafestRoutes).toHaveBeenCalledTimes(3);
    expect(args.logger.log).toHaveBeenCalledWith(
      expect.stringContaining('Via routing failed'),
    );
    expect(routes).toEqual([{ path: ['start', 'end'], edges: [9], totalDist: 110 }]);
  });
});
