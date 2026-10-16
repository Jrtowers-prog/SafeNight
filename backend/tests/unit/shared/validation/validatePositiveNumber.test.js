const {
  validatePositiveNumber,
} = require('../../../../src/shared/validation/validate');

describe('validatePositiveNumber', () => {
  test('returns invalid for non-numeric value', () => {
    const result = validatePositiveNumber('abc', 'radius');

    expect(result).toEqual({ valid: false, error: 'Invalid radius: abc' });
  });

  test('returns invalid for zero', () => {
    const result = validatePositiveNumber(0, 'radius');

    expect(result).toEqual({ valid: false, error: 'Invalid radius: 0' });
  });

  test('returns invalid when above max', () => {
    const result = validatePositiveNumber(12, 'radius', 10);

    expect(result).toEqual({ valid: false, error: 'Invalid radius: 12' });
  });

  test('returns valid for positive value inside max', () => {
    const result = validatePositiveNumber(5, 'radius', 10);

    expect(result).toEqual({ valid: true, value: 5 });
  });
});
