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

describe('safeRoutesOrchestrator', () => {
  test('returns computed source for first request', async () => {
    const computeSafeRoutes = jest.fn(async () => ({ routes: [1] }));
    const orchestrator = createSafeRoutesOrchestrator({
      computeSafeRoutes,
      estimateRequestLoadUnits: () => 1,
      enqueueComputeJob: ({ run }) => run(),
      waitWithCancellation: async (promise) => promise,
      formatWaitMmSs: () => '00:05',
    });

    const result = await orchestrator.resolveSafeRoutesRequest(baseParams());

    expect(result.source).toBe('computed');
  });

  test('returns cache source on repeated identical request', async () => {
    const computeSafeRoutes = jest.fn(async () => ({ routes: [1] }));
    const orchestrator = createSafeRoutesOrchestrator({
      computeSafeRoutes,
      estimateRequestLoadUnits: () => 1,
      enqueueComputeJob: ({ run }) => run(),
      waitWithCancellation: async (promise) => promise,
      formatWaitMmSs: () => '00:05',
    });

    await orchestrator.resolveSafeRoutesRequest(baseParams());
    const second = await orchestrator.resolveSafeRoutesRequest(baseParams());

    expect(second.source).toBe('cache');
  });

  test('returns inflight source for concurrent identical request', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    const computeSafeRoutes = jest.fn(async () => {
      await gate;
      return { routes: [1] };
    });

    const orchestrator = createSafeRoutesOrchestrator({
      computeSafeRoutes,
      estimateRequestLoadUnits: () => 1,
      enqueueComputeJob: ({ run }) => run(),
      waitWithCancellation: async (promise) => promise,
      formatWaitMmSs: () => '00:05',
    });

    const first = orchestrator.resolveSafeRoutesRequest(baseParams());
    const second = orchestrator.resolveSafeRoutesRequest(baseParams());
    release();

    await first;
    const secondResult = await second;

    expect(secondResult.source).toBe('inflight');
  });

  test('does not reuse cache across different response policy options', async () => {
    const computeSafeRoutes = jest.fn(async () => ({ routes: [1] }));
    const orchestrator = createSafeRoutesOrchestrator({
      computeSafeRoutes,
      estimateRequestLoadUnits: () => 1,
      enqueueComputeJob: ({ run }) => run(),
      waitWithCancellation: async (promise) => promise,
      formatWaitMmSs: () => '00:05',
    });

    await orchestrator.resolveSafeRoutesRequest(
      baseParams({
        responsePolicy: {
          verbosity: 'full',
          poiCaps: { cctv: 200, transit: 200, deadEnds: 200, lights: 200, places: 200, crimes: 200 },
        },
      }),
    );

    const second = await orchestrator.resolveSafeRoutesRequest(
      baseParams({
        responsePolicy: {
          verbosity: 'compact',
          poiCaps: { cctv: 10, transit: 10, deadEnds: 8, lights: 10, places: 10, crimes: 10 },
        },
      }),
    );

    expect(second.source).toBe('computed');
    expect(computeSafeRoutes).toHaveBeenCalledTimes(2);
  });

  test('emits queue_start progress event when compute starts', async () => {
    const onProgress = jest.fn();
    const orchestrator = createSafeRoutesOrchestrator({
      computeSafeRoutes: async () => ({ routes: [1] }),
      estimateRequestLoadUnits: () => 1,
      enqueueComputeJob: ({ run, onStart }) => {
        onStart({
          activeCount: 1,
          activeLoadUnits: 1,
          queuedCount: 0,
          maxServerLoadUnits: 4,
          expectedMs: 1000,
          requestLoadUnits: 1,
        });
        return run();
      },
      waitWithCancellation: async (promise) => promise,
      formatWaitMmSs: () => '00:01',
    });

    await orchestrator.resolveSafeRoutesRequest(baseParams({ onProgress }));

    expect(onProgress).toHaveBeenCalledWith(
      'queue_start',
      expect.stringContaining('Starting safety analysis'),
      22,
    );
  });
});
