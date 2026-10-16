const { validateTextInput } = require('../../../../src/shared/validation/validate');

describe('validateTextInput', () => {
  test('returns invalid for empty input', () => {
    const result = validateTextInput('');

    expect(result.valid).toBe(false);
  });

  test('returns trimmed value for valid input', () => {
    const result = validateTextInput('  Plymouth  ');

    expect(result.value).toBe('Plymouth');
  });

  test('returns invalid for oversized input', () => {
    const result = validateTextInput('a'.repeat(301));

    expect(result.valid).toBe(false);
  });
});
