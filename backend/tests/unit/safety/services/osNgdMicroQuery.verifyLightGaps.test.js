jest.mock('../../../../src/safety/services/osNgdClient', () => ({
  fetchOsStreetLightsOnly: jest.fn(async () => ({ elements: [] })),
}));

jest.mock('../../../../src/safety/services/lightsCacheClient', () => ({
  queryBySegment: jest.fn(async () => null),
  upsert: jest.fn(async () => undefined),
  upsertBatch: jest.fn(async () => undefined),
  normalizeToCacheRecord: jest.fn(() => null),
  normalizeBatch: jest.fn(() => []),
}));

const {
  verifyLightGaps,
  __resetForTests,
} = require('../../../../src/safety/services/osNgdMicroQuery');

describe('osNgdMicroQuery verifyLightGaps', () => {
  afterEach(() => {
    __resetForTests();
    jest.clearAllMocks();
  });

  test('builds a verification footprint from the full segment bbox', async () => {
    const osmNodes = new Map([
      [1, { lat: 51.0, lng: -0.1 }],
      [2, { lat: 51.003, lng: -0.1 }],
    ]);

    const result = await verifyLightGaps(
      [
        {
          edgeIdx: 0,
          edge: { from: 1, to: 2, distance: 330 },
          confidence: 0.35,
          reason: 'uncertain',
        },
      ],
      osmNodes,
      { routeKey: 'test-route' },
    );

    expect(result.queryFootprints).toHaveLength(1);
    const footprint = result.queryFootprints[0];
    expect(footprint.south).toBeLessThanOrEqual(51.0);
    expect(footprint.north).toBeGreaterThanOrEqual(51.003);
    expect(footprint.centerLat).toBeGreaterThan(51.0);
    expect(footprint.centerLat).toBeLessThan(51.003);
  });

  test('treats a span candidate as one verification footprint and maps the result to every edge in the span', async () => {
    const osmNodes = new Map([
      [1, { lat: 51.0, lng: -0.1 }],
      [2, { lat: 51.0015, lng: -0.1 }],
      [3, { lat: 51.003, lng: -0.1 }],
    ]);

    const result = await verifyLightGaps(
      [
        {
          edgeIdx: 0,
          edgeIdxs: [0, 1],
          edge: { from: 1, to: 2, distance: 160 },
          bbox: {
            south: 50.9995,
            west: -0.1005,
            north: 51.0035,
            east: -0.0995,
          },
          confidence: 0.25,
          reason: 'light_uncertain_span',
        },
      ],
      osmNodes,
      { routeKey: 'test-span-route' },
    );

    expect(result.queryFootprints).toHaveLength(1);
    expect(result.verifiedSegments.get(0)?.lit_status).toBe('unlit');
    expect(result.verifiedSegments.get(1)?.lit_status).toBe('unlit');
  });
});