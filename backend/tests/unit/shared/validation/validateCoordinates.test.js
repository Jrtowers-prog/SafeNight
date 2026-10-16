const {
  validateLatitude,
  validateLongitude,
} = require('../../../../src/shared/validation/validate');

describe('coordinate validators', () => {
  test('validateLatitude accepts a valid latitude', () => {
    const result = validateLatitude(50.37);

    expect(result.valid).toBe(true);
  });

  test('validateLatitude rejects out-of-range latitude', () => {
    const result = validateLatitude(120);

    expect(result.valid).toBe(false);
  });

  test('validateLongitude accepts a valid longitude', () => {
    const result = validateLongitude(-4.14);

    expect(result.valid).toBe(true);
  });

  test('validateLongitude rejects out-of-range longitude', () => {
    const result = validateLongitude(-220);

    expect(result.valid).toBe(false);
  });
});
