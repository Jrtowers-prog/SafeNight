function loadRuntimeWithQueueLimits() {
  jest.resetModules();
  process.env.SAFE_ROUTES_MAX_CONCURRENT = '1';
  process.env.SAFE_ROUTES_MAX_SERVER_LOAD_UNITS = '1';
  process.env.SAFE_ROUTES_MAX_QUEUE_LENGTH = '1';
  process.env.SAFE_ROUTES_MAX_QUEUE_WAIT_MS = '1000';
  process.env.SAFE_ROUTES_DEFAULT_ETA_MS = '10000';
  process.env.SAFE_ROUTES_DEFAULT_REQUEST_LOAD_UNITS = '1';

  return require('../../../../src/safety/routes/safeRoutesRuntime');
}

function clearRuntimeQueueEnv() {
  delete process.env.SAFE_ROUTES_MAX_CONCURRENT;
  delete process.env.SAFE_ROUTES_MAX_SERVER_LOAD_UNITS;
  delete process.env.SAFE_ROUTES_MAX_QUEUE_LENGTH;
  delete process.env.SAFE_ROUTES_MAX_QUEUE_WAIT_MS;
  delete process.env.SAFE_ROUTES_DEFAULT_ETA_MS;
  delete process.env.SAFE_ROUTES_DEFAULT_REQUEST_LOAD_UNITS;
}

describe('safeRoutesRuntime queue branches', () => {
  afterEach(() => {
    clearRuntimeQueueEnv();
    jest.restoreAllMocks();
  });

  test('enqueueComputeJob rejects with QUEUE_FULL when queue length limit is reached', async () => {
    const { enqueueComputeJob } = loadRuntimeWithQueueLimits();

    let releaseFirst;
    const first = enqueueComputeJob({
      run: () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
      requestLoadUnits: 1,
    });

    const queuedSecond = enqueueComputeJob({
      run: async () => 'second',
      requestLoadUnits: 1,
    });

    const third = enqueueComputeJob({
      run: async () => 'third',
      requestLoadUnits: 1,
    });

    await expect(third).rejects.toMatchObject({
      code: 'QUEUE_FULL',
      statusCode: 503,
    });

    releaseFirst('first');
    await expect(first).resolves.toBe('first');
    await expect(queuedSecond).resolves.toBe('second');
  });

  test('queued job is removed and rejected when cancellation happens while waiting', async () => {
    const { enqueueComputeJob, createCancellationToken } =
      loadRuntimeWithQueueLimits();

    let releaseFirst;
    const first = enqueueComputeJob({
      run: () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
      requestLoadUnits: 1,
    });

    const token = createCancellationToken();
    const queued = enqueueComputeJob({
      run: async () => 'queued',
      requestLoadUnits: 1,
      cancelToken: token,
    });

    token.cancel('queue cancel from test');

    await expect(queued).rejects.toMatchObject({
      code: 'SEARCH_CANCELLED',
      statusCode: 409,
    });

    releaseFirst('first');
    await expect(first).resolves.toBe('first');
  });

  test('queued job rejects with QUEUE_TIMEOUT when it exceeds queue wait budget', async () => {
    let now = 1;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    const { enqueueComputeJob } = loadRuntimeWithQueueLimits();

    let releaseFirst = () => {};
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });

    const first = enqueueComputeJob({
      run: () => firstGate,
      requestLoadUnits: 1,
    });

    const queued = enqueueComputeJob({
      run: async () => 'queued',
      requestLoadUnits: 1,
    });

    now = 1202;
    releaseFirst('first');

    await expect(first).resolves.toBe('first');
    await expect(queued).rejects.toMatchObject({
      code: 'QUEUE_TIMEOUT',
      statusCode: 503,
    });
  });
});