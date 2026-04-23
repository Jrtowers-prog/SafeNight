const {
  clusterSegments,
  clusterBbox,
  segmentBbox,
  __resetForTests,
} = require('../../../../src/safety/services/osNgdMicroQuery');

describe('osNgdMicroQuery', () => {
  afterEach(() => {
    __resetForTests();
  });

  const mockOsmNodes = new Map([
    [1, { lat: 51.0, lng: -0.1 }],
    [2, { lat: 51.001, lng: -0.099 }],
    [3, { lat: 51.002, lng: -0.098 }],
    [4, { lat: 51.1, lng: -0.2 }], // far away
  ]);

  describe('segmentBbox', () => {
    test('computes bbox with buffer', () => {
      const bbox = segmentBbox({ from: 1, to: 2 }, mockOsmNodes, 30);
      expect(bbox).not.toBeNull();
      expect(bbox.south).toBeLessThan(bbox.north);
      expect(bbox.west).toBeLessThan(bbox.east);
    });

    test('returns null for missing nodes', () => {
      const bbox = segmentBbox({ from: 999, to: 2 }, mockOsmNodes, 30);
      expect(bbox).toBeNull();
    });
  });

  describe('clusterSegments', () => {
    test('groups nearby segments', () => {
      const segments = [
        { edge: { from: 1, to: 2 } },
        { edge: { from: 2, to: 3 } },
        { edge: { from: 3, to: 4 } }, // far from first two
      ];

      const clusters = clusterSegments(segments, mockOsmNodes, 200);
      expect(clusters.length).toBeGreaterThanOrEqual(1);
      // First two should be in same cluster
      const firstCluster = clusters.find((c) =>
        c.some((s) => s.edge.from === 1 && s.edge.to === 2)
      );
      expect(firstCluster).toBeDefined();
      expect(firstCluster.some((s) => s.edge.from === 2 && s.edge.to === 3)).toBe(true);
    });

    test('each segment appears in exactly one cluster', () => {
      const segments = [
        { edge: { from: 1, to: 2 } },
        { edge: { from: 2, to: 3 } },
        { edge: { from: 3, to: 4 } },
      ];

      const clusters = clusterSegments(segments, mockOsmNodes, 200);
      const allSegments = clusters.flat();
      const unique = new Set(allSegments.map((s) => `${s.edge.from}-${s.edge.to}`));
      expect(unique.size).toBe(segments.length);
    });
  });

  describe('clusterBbox', () => {
    test('covers all segments in cluster', () => {
      const cluster = [
        { edge: { from: 1, to: 2 } },
        { edge: { from: 2, to: 3 } },
      ];

      const bbox = clusterBbox(cluster, mockOsmNodes, 30);
      expect(bbox).not.toBeNull();
      expect(bbox.south).toBeLessThanOrEqual(51.0);
      expect(bbox.north).toBeGreaterThanOrEqual(51.002);
    });

    test('returns null for empty cluster', () => {
      const bbox = clusterBbox([], mockOsmNodes, 30);
      expect(bbox).toBeNull();
    });
  });
});
