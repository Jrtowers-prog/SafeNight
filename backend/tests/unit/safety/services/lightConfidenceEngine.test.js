const {
  computeLightConfidence,
  computeSampledLightConfidence,
  sampleEdgeProbePoints,
  buildVerificationQueue,
  mergeVerifiedLights,
  calculateRouteUncertainty,
  buildRouteLightGapSpans,
  CONFIDENCE_THRESHOLDS,
} = require('../../../../src/safety/services/lightConfidenceEngine');

const { buildSpatialGrid } = require('../../../../src/safety/services/geo');

describe('lightConfidenceEngine', () => {
  const mockOsmNodes = new Map([
    [1, { lat: 51.0, lng: -0.1 }],
    [2, { lat: 51.01, lng: -0.09 }],
  ]);

  describe('computeLightConfidence', () => {
    test('lit=yes → confident lit', () => {
      const result = computeLightConfidence(
        { tags: { highway: 'residential', lit: 'yes' } },
        { from: 1, to: 2, highway: 'residential' },
        mockOsmNodes,
        [],
        [],
      );
      expect(result.score).toBe(1.0);
      expect(result.needsVerification).toBe(false);
    });

    test('lit=no → confident unlit and verify', () => {
      const result = computeLightConfidence(
        { tags: { highway: 'residential', lit: 'no' } },
        { from: 1, to: 2, highway: 'residential' },
        mockOsmNodes,
        [],
        [],
      );
      expect(result.score).toBe(0.0);
      expect(result.needsVerification).toBe(true);
    });

    test('unknown lit + nearby lamps → confident lit', () => {
      const result = computeLightConfidence(
        { tags: { highway: 'residential' } },
        { from: 1, to: 2, highway: 'residential' },
        mockOsmNodes,
        [{ lat: 51.005, lng: -0.095 }], // within 30m of midpoint
        [],
      );
      expect(result.score).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLDS.LIT);
      expect(result.needsVerification).toBe(false);
    });

    test('unknown lit + rural road → confident unlit', () => {
      const result = computeLightConfidence(
        { tags: { highway: 'track' } },
        { from: 1, to: 2, highway: 'track' },
        mockOsmNodes,
        [],
        [],
      );
      expect(result.score).toBeLessThanOrEqual(CONFIDENCE_THRESHOLDS.UNLIT);
      expect(result.needsVerification).toBe(false);
    });

    test('unknown lit + no signals → uncertain', () => {
      const result = computeLightConfidence(
        { tags: { highway: 'residential' } },
        { from: 1, to: 2, highway: 'residential' },
        mockOsmNodes,
        [],
        [],
      );
      expect(result.score).toBeGreaterThan(CONFIDENCE_THRESHOLDS.UNLIT);
      expect(result.score).toBeLessThan(CONFIDENCE_THRESHOLDS.LIT);
      expect(result.needsVerification).toBe(true);
    });
  });

  describe('sampleEdgeProbePoints', () => {
    test('returns multiple probe points along an edge', () => {
      const probes = sampleEdgeProbePoints(
        mockOsmNodes,
        { from: 1, to: 2 },
        [0.25, 0.5, 0.75],
      );

      expect(probes).toHaveLength(3);
      expect(probes[0].lat).toBeLessThan(probes[1].lat);
      expect(probes[1].lat).toBeLessThan(probes[2].lat);
    });
  });

  describe('computeSampledLightConfidence', () => {
    test('keeps an edge uncertain when only the midpoint is lit', () => {
      const longEdgeNodes = new Map([
        [1, { lat: 51.0, lng: -0.1 }],
        [2, { lat: 51.01, lng: -0.1 }],
      ]);
      const lightGrid = buildSpatialGrid([
        { lat: 51.005, lng: -0.1 },
      ], 'lat', 'lng', 0.0003);

      const result = computeSampledLightConfidence(
        { tags: { highway: 'residential' } },
        { from: 1, to: 2, highway: 'residential' },
        longEdgeNodes,
        lightGrid,
        [],
        { sampleFractions: [0.25, 0.5, 0.75], searchRadiusMetres: 50 },
      );

      expect(result.needsVerification).toBe(true);
      expect(result.score).toBeLessThan(CONFIDENCE_THRESHOLDS.LIT);
      expect(result.score).toBeGreaterThan(CONFIDENCE_THRESHOLDS.UNLIT);
    });
  });

  describe('buildVerificationQueue', () => {
    test('returns only uncertain segments', () => {
      const edges = [
        { from: 1, to: 2 },
        { from: 2, to: 3 },
        { from: 3, to: 4 },
      ];
      const confidences = [
        { score: 1.0, needsVerification: false },
        { score: 0.4, needsVerification: true },
        { score: 0.0, needsVerification: false },
      ];

      const queue = buildVerificationQueue(edges, confidences);
      expect(queue).toHaveLength(1);
      expect(queue[0].edgeIdx).toBe(1);
    });
  });

  describe('mergeVerifiedLights', () => {
    test('adds new lights without duplicates', () => {
      const local = [
        { type: 'node', id: 1, lat: 51.0, lon: -0.1, tags: { highway: 'street_lamp' } },
      ];
      const verified = [
        { type: 'node', id: 2, lat: 51.001, lon: -0.101, tags: { highway: 'street_lamp' } }, // far away
        { type: 'node', id: 3, lat: 51.0001, lon: -0.1001, tags: { highway: 'street_lamp' } }, // very close to existing
      ];

      const merged = mergeVerifiedLights(local, verified);
      expect(merged).toHaveLength(2); // id 1 + id 2 (id 3 is duplicate)
      expect(merged.some((el) => el.id === 2)).toBe(true);
    });
  });

  describe('calculateRouteUncertainty', () => {
    test('calculates ratio correctly', () => {
      const edges = [
        { distance: 100 },
        { distance: 50 },
        { distance: 50 },
      ];
      const confidences = [
        { needsVerification: false },
        { needsVerification: true },
        { needsVerification: false },
      ];

      const result = calculateRouteUncertainty([0, 1, 2], edges, confidences);
      expect(result.uncertainRatio).toBe(0.25); // 50/200
      expect(result.uncertainLengthM).toBe(50);
      expect(result.totalLengthM).toBe(200);
    });
  });

  describe('buildRouteLightGapSpans', () => {
    test('groups a long low-light run into one route span', () => {
      const route = { edges: [0, 1, 2] };
      const nodes = new Map([
        [1, { lat: 51.0, lng: -0.1 }],
        [2, { lat: 51.001, lng: -0.1 }],
        [3, { lat: 51.002, lng: -0.1 }],
        [4, { lat: 51.003, lng: -0.1 }],
      ]);
      const edges = [
        { from: 1, to: 2, distance: 100, lightScore: 0.4 },
        { from: 2, to: 3, distance: 100, lightScore: 0.38 },
        { from: 3, to: 4, distance: 100, lightScore: 0.35 },
      ];
      const confidences = [
        { score: 0.4, needsVerification: true, reason: 'uncertain' },
        { score: 0.35, needsVerification: true, reason: 'uncertain' },
        { score: 0.3, needsVerification: true, reason: 'uncertain' },
      ];

      const spans = buildRouteLightGapSpans(route, edges, nodes, confidences, {
        lowThreshold: 0.58,
        continueThreshold: 0.72,
        minSpanDistance: 90,
      });

      expect(spans).toHaveLength(1);
      expect(spans[0].edgeCount).toBe(3);
      expect(spans[0].distance).toBe(300);
      expect(spans[0].bbox).toBeTruthy();
      expect(spans[0].reason).toBe('light_uncertain_span');
    });
  });
});
