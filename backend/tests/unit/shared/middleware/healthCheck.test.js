const { healthCheck } = require('../../../../src/shared/middleware/healthCheck');

describe('healthCheck', () => {
  test('returns service status payload', () => {
    const handler = healthCheck('gateway');
    const json = jest.fn();
    const res = { json };

    handler({}, res);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ok', service: 'gateway' }),
    );
  });
});
