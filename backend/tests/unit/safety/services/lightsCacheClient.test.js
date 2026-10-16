const {
  scoreFromCache,
  normalizeToCacheRecord,
  normalizeBatch,
  GEOHASH_PRECISION,
} = require('../../../../src/safety/services/lightsCacheClient');

describe('lightsCacheClient', () => {
  describe('scoreFromCache', () => {
    test('lit status with high confidence → high score', () => {
      const result = scoreFromCache({ lit_status: 'lit', confidence: 1.0 });
      expect(result.score).toBe(1.0);
    });

    test('lit status with low confidence → moderate score', () => {
      const result = scoreFromCache({ lit_status: 'lit', confidence: 0.5 });
      expect(result.score).toBe(0.85);
    });

    test('limited status → moderate score', () => {
      const result = scoreFromCache({ lit_status: 'limited', confidence: 0.8 });
      expect(result.score).toBeCloseTo(0.56, 1);
    });

    test('unlit status → low score', () => {
      const result = scoreFromCache({ lit_status: 'unlit', confidence: 1.0 });
      expect(result.score).toBe(0.15);
    });

    test('unknown status → null (fallback to coverage map)', () => {
      const result = scoreFromCache({ lit_status: 'unknown', confidence: 0.5 });
      expect(result).toBeNull();
    });

    test('null record → null', () => {
      expect(scoreFromCache(null)).toBeNull();
    });
  });

  describe('normalizeToCacheRecord', () => {
    test('creates valid record from OSM element', () => {
      const record = normalizeToCacheRecord(
        { type: 'node', id: 123, lat: 51.0, lon: -0.1, tags: { highway: 'street_lamp' } },
        'osm',
        { litStatus: 'lit', confidence: 0.9, confidenceReason: 'explicit_lamp' }
      );

      expect(record).not.toBeNull();
      expect(record.source).toBe('osm');
      expect(record.osm_id).toBe(123);
      expect(record.lat).toBe(51.0);
      expect(record.lon).toBe(-0.1);
      expect(record.lit_status).toBe('lit');
      expect(record.confidence).toBe(0.9);
      expect(record.geohash).toHaveLength(GEOHASH_PRECISION);
      expect(record.expires_at).toBeDefined();
    });

    test('returns null for missing lat/lon', () => {
      const record = normalizeToCacheRecord(
        { type: 'node', id: 123 },
        'osm',
        {}
      );
      expect(record).toBeNull();
    });
  });

  describe('normalizeBatch', () => {
    test('normalizes multiple elements', () => {
      const elements = [
        { type: 'node', id: 1, lat: 51.0, lon: -0.1, tags: { highway: 'street_lamp' } },
        { type: 'node', id: 2, lat: 51.01, lon: -0.09, tags: { lit: 'no' } },
        { type: 'node', id: 3, lat: 51.02, lon: -0.08, tags: { lit: 'limited' } },
      ];

      const records = normalizeBatch(elements, 'osm');
      expect(records).toHaveLength(3);
      expect(records[0].lit_status).toBe('lit');
      expect(records[1].lit_status).toBe('unlit');
      expect(records[2].lit_status).toBe('limited');
    });

    test('skips elements with missing coordinates', () => {
      const elements = [
        { type: 'node', id: 1, lat: 51.0, lon: -0.1 },
        { type: 'node', id: 2 }, // missing coords
      ];

      const records = normalizeBatch(elements, 'osm');
      expect(records).toHaveLength(1);
    });
  });
});
