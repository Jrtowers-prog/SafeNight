const { healthCheck } = require('../../../src/shared/middleware/healthCheck');

describe('gateway health system check', () => {
  test('returns ok status for gateway service', () => {
    const handler = healthCheck('api-gateway');
    const json = jest.fn();
    const res = { json };

    handler({}, res);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ok', service: 'api-gateway' }),
    );
  });
});
