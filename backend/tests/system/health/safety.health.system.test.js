const { healthCheck } = require('../../../src/shared/middleware/healthCheck');

describe('safety health system check', () => {
  test('returns ok status for safety service', () => {
    const handler = healthCheck('safety-service');
    const json = jest.fn();
    const res = { json };

    handler({}, res);

    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ok', service: 'safety-service' }),
    );
  });
});
