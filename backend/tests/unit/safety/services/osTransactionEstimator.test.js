const {
  estimateNgdFeatureTransactions,
  estimateSpendGbp,
  applySafetyMargin,
  confirmFeatureTransactions,
  bboxAreaKm2,
  PRICING,
  CAP_SAFETY_THRESHOLD_PERCENT,
} = require('../../../../src/safety/services/osTransactionEstimator');

describe('osTransactionEstimator', () => {
  test('estimateNgdFeatureTransactions returns at least 1', () => {
    const bbox = { south: 51.0, west: -0.1, north: 51.01, east: -0.09 };
    const result = estimateNgdFeatureTransactions(bbox);
    expect(result).toBeGreaterThanOrEqual(1);
  });

  test('estimateNgdFeatureTransactions scales with area', () => {
    const smallBbox = { south: 51.0, west: -0.1, north: 51.001, east: -0.099 };
    const largeBbox = { south: 51.0, west: -0.1, north: 51.1, east: 0.0 };
    const small = estimateNgdFeatureTransactions(smallBbox);
    const large = estimateNgdFeatureTransactions(largeBbox);
    expect(large).toBeGreaterThan(small);
  });

  test('estimateNgdFeatureTransactions respects density override', () => {
    const bbox = { south: 51.0, west: -0.1, north: 51.01, east: -0.09 };
    const lowDensity = estimateNgdFeatureTransactions(bbox, 50);
    const highDensity = estimateNgdFeatureTransactions(bbox, 500);
    expect(highDensity).toBeGreaterThan(lowDensity);
  });

  test('estimateSpendGbp for os-ngd-features', () => {
    const gbp = estimateSpendGbp('os-ngd-features', 10);
    expect(gbp).toBeCloseTo(10 * PRICING['os-ngd-features'].gbpPerTransaction, 6);
  });

  test('estimateSpendGbp for os-ngd-tiles', () => {
    const gbp = estimateSpendGbp('os-ngd-tiles', 5);
    expect(gbp).toBeCloseTo(5 * PRICING['os-ngd-tiles'].gbpPerMapView, 6);
  });

  test('estimateSpendGbp for os-places', () => {
    const gbp = estimateSpendGbp('os-places', 3);
    expect(gbp).toBeCloseTo(3 * PRICING['os-places'].gbpPerRequest, 6);
  });

  test('estimateSpendGbp returns 0 for unknown api', () => {
    expect(estimateSpendGbp('unknown-api', 10)).toBe(0);
  });

  test('applySafetyMargin with default 10%', () => {
    const projected = 100;
    const withMargin = applySafetyMargin(projected);
    expect(withMargin).toBeCloseTo(110, 2);
  });

  test('confirmFeatureTransactions for 0 features', () => {
    expect(confirmFeatureTransactions(0)).toBe(0);
  });

  test('confirmFeatureTransactions for 50 features', () => {
    expect(confirmFeatureTransactions(50)).toBe(1);
  });

  test('confirmFeatureTransactions for 100 features', () => {
    expect(confirmFeatureTransactions(100)).toBe(1);
  });

  test('confirmFeatureTransactions for 150 features', () => {
    expect(confirmFeatureTransactions(150)).toBe(2);
  });

  test('bboxAreaKm2 for valid bbox', () => {
    const bbox = { south: 51.0, west: -0.1, north: 51.01, east: -0.09 };
    const area = bboxAreaKm2(bbox);
    expect(area).toBeGreaterThan(0);
  });

  test('bboxAreaKm2 returns 0 for invalid bbox', () => {
    expect(bboxAreaKm2({ south: 51, west: -0.1, north: 51, east: -0.09 })).toBe(0);
    expect(bboxAreaKm2({ south: 'a', west: -0.1, north: 51, east: -0.09 })).toBe(0);
  });
});
