const {
  createSafeRoutesOrchestrator,
} = require('../../../../src/safety/routes/safeRoutesOrchestrator');

function baseParams(overrides = {}) {
  return {
    oLat: 50.37,
    oLng: -4.14,
    dLat: 50.38,
    dLng: -4.13,
    straightLineDist: 1000,
    straightLineKm: 1,
    maxDistanceKm: 2,
    wpLat: null,
    wpLng: null,
    cancelToken: null,
    ...overrides,
  };
}

describe('safeRoutesOrchestrator edge branches', () => {
  test('throws INTERNAL_ERROR when compute resolves to a falsy result', async () => {
    const orchestrator = createSafeRoutesOrchestrator({
      computeSafeRoutes: async () => null,
      estimateRequestLoadUnits: () => 1,
      enqueueComputeJob: ({ run }) => run(),
      waitWithCancellation: async (promise) => promise,
      formatWaitMmSs: () => '00:05',
    });

    await expect(
      orchestrator.resolveSafeRoutesRequest(baseParams()),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      statusCode: 500,
    });
  });

  test('replays latest inflight progress to a late coalesced subscriber', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const firstProgress = jest.fn();
    const secondProgress = jest.fn();

    const orchestrator = createSafeRoutesOrchestrator({
      computeSafeRoutes: async () => {
        await gate;
        return { routes: [1] };
      },
      estimateRequestLoadUnits: () => 1,
      enqueueComputeJob: ({ run, onQueueUpdate }) => {
        onQueueUpdate({
          queuePosition: 2,
          waitLabel: '00:07',
          activeCount: 1,
          activeLoadUnits: 2,
          queuedCount: 1,
          maxServerLoadUnits: 6,
          requestLoadUnits: 1,
        });
        return run();
      },
      waitWithCancellation: async (promise) => promise,
      formatWaitMmSs: () => '00:05',
    });

    const first = orchestrator.resolveSafeRoutesRequest(
      baseParams({ onProgress: firstProgress }),
    );

    await Promise.resolve();

    const second = orchestrator.resolveSafeRoutesRequest(
      baseParams({ onProgress: secondProgress }),
    );

    expect(secondProgress).toHaveBeenCalledWith(
      'queue_stats',
      expect.stringContaining('Queue size'),
      20,
    );

    release();
    await first;
    await second;
  });

  test('does not emit queue_stats progress when queuedCount is zero', async () => {
    const onProgress = jest.fn();
    const orchestrator = createSafeRoutesOrchestrator({
      computeSafeRoutes: async () => ({ routes: [1] }),
      estimateRequestLoadUnits: () => 1,
      enqueueComputeJob: ({ run, onQueueUpdate }) => {
        onQueueUpdate({
          queuePosition: 0,
          waitLabel: '00:02',
          activeCount: 1,
          activeLoadUnits: 1,
          queuedCount: 0,
          maxServerLoadUnits: 6,
          requestLoadUnits: 1,
        });
        return run();
      },
      waitWithCancellation: async (promise) => promise,
      formatWaitMmSs: () => '00:05',
    });

    await orchestrator.resolveSafeRoutesRequest(baseParams({ onProgress }));

    expect(onProgress).toHaveBeenCalledWith(
      'queued',
      expect.stringContaining('Server busy'),
      20,
    );
    expect(onProgress).not.toHaveBeenCalledWith(
      'queue_stats',
      expect.any(String),
      20,
    );
  });

  test('hasInflightRequest reports active state for an inflight request', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const orchestrator = createSafeRoutesOrchestrator({
      computeSafeRoutes: async () => {
        await gate;
        return { routes: [1] };
      },
      estimateRequestLoadUnits: () => 1,
      enqueueComputeJob: ({ run }) => run(),
      waitWithCancellation: async (promise) => promise,
      formatWaitMmSs: () => '00:05',
    });

    const params = baseParams();
    const pending = orchestrator.resolveSafeRoutesRequest(params);

    expect(orchestrator.hasInflightRequest(params)).toBe(true);

    release();
    await pending;

    expect(orchestrator.hasInflightRequest(params)).toBe(false);
  });
});