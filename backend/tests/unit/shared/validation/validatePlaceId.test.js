const { validatePlaceId } = require('../../../../src/shared/validation/validate');

describe('validatePlaceId', () => {
  test('returns invalid for empty place id', () => {
    const result = validatePlaceId('');

    expect(result.valid).toBe(false);
  });

  test('returns valid for expected place id format', () => {
    const result = validatePlaceId('osm-node-12345');

    expect(result.valid).toBe(true);
  });

  test('returns invalid for illegal characters', () => {
    const result = validatePlaceId('osm-node-12345$');

    expect(result.valid).toBe(false);
  });

  test('returns invalid for oversized place id', () => {
    const result = validatePlaceId('a'.repeat(513));

    expect(result).toEqual({ valid: false, error: 'placeId too long' });
  });
});
