const {
  createCancellationToken,
  formatWaitMmSs,
  estimateRequestLoadUnits,
  registerActiveSearch,
  waitWithCancellation,
  enqueueComputeJob,
} = require('../../../../src/safety/routes/safeRoutesRuntime');

describe('safeRoutesRuntime', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createReq(overrides = {}) {
    return {
      headers: {},
      query: {
        origin_lat: 50.37,
        origin_lng: -4.14,
        dest_lat: 50.38,
        dest_lng: -4.13,
      },
      ip: '127.0.0.1',
      ...overrides,
    };
  }

  test('createCancellationToken marks token as cancelled', () => {
    const token = createCancellationToken();

    token.cancel('cancelled for test');

    expect(token.isCancelled()).toBe(true);
  });

  test('createCancellationToken notifies listeners and throwIfCancelled throws', () => {
    const token = createCancellationToken();
    const listener = jest.fn();
    token.onCancel(listener);

    token.cancel('explicit cancel reason');

    expect(listener).toHaveBeenCalledWith('explicit cancel reason');
    expect(() => token.throwIfCancelled()).toThrow('explicit cancel reason');
  });

  test('onCancel calls listener immediately when already cancelled', () => {
    const token = createCancellationToken();
    const listener = jest.fn();
    token.cancel('already cancelled');

    token.onCancel(listener);

    expect(listener).toHaveBeenCalledWith('already cancelled');
  });

  test('formatWaitMmSs formats 65s as 01:05', () => {
    const label = formatWaitMmSs(65_000);

    expect(label).toBe('01:05');
  });

  test('estimateRequestLoadUnits increases load when waypoint is present', () => {
    const noWaypoint = estimateRequestLoadUnits({
      straightLineKm: 2,
      maxDistanceKm: 2,
      hasWaypoint: false,
    });

    const withWaypoint = estimateRequestLoadUnits({
      straightLineKm: 2,
      maxDistanceKm: 2,
      hasWaypoint: true,
    });

    expect(withWaypoint).toBeGreaterThanOrEqual(noWaypoint);
  });

  test('registerActiveSearch accepts later arrivals even with lower sequence and preempts previous', () => {
    const firstToken = createCancellationToken();
    const secondToken = createCancellationToken();
    const firstReq = createReq({ headers: { 'x-search-id': 'stale-a', 'x-search-seq': '20' } });
    const staleReq = createReq({ headers: { 'x-search-id': 'stale-b', 'x-search-seq': '10' } });

    const first = registerActiveSearch(firstReq, firstToken);
    const stale = registerActiveSearch(staleReq, secondToken);

    expect(first.stale).toBe(false);
    expect(stale.stale).toBe(false);
    expect(stale.replacedPrevious).toBe(true);
    expect(firstToken.isCancelled()).toBe(true);
    expect(secondToken.isCancelled()).toBe(false);

    stale.release();
    first.release();
  });

  test('registerActiveSearch preempts older active search', () => {
    const oldToken = createCancellationToken();
    const newToken = createCancellationToken();
    const oldReq = createReq({ headers: { 'x-search-id': 'preempt-a', 'x-search-seq': '10' } });
    const newReq = createReq({ headers: { 'x-search-id': 'preempt-b', 'x-search-seq': '11' } });

    const oldSearch = registerActiveSearch(oldReq, oldToken);
    const newSearch = registerActiveSearch(newReq, newToken);

    expect(oldToken.isCancelled()).toBe(true);
    expect(newSearch.replacedPrevious).toBe(true);

    newSearch.release();
    oldSearch.release();
  });

  test('registerActiveSearch allows companion requests only for exact operation signature', () => {
    const primaryToken = createCancellationToken();
    const companionToken = createCancellationToken();
    const sharedHeaders = {
      'x-search-id': 'same-search-id',
      'x-search-client': 'same-client',
      'x-search-seq': '10',
    };
    const primaryReq = createReq({ headers: { ...sharedHeaders } });
    const companionReq = createReq({ headers: { ...sharedHeaders } });

    const primary = registerActiveSearch(primaryReq, primaryToken);
    const companion = registerActiveSearch(companionReq, companionToken);

    expect(primary.stale).toBe(false);
    expect(companion.stale).toBe(false);
    expect(companion.replacedPrevious).toBe(false);
    expect(primaryToken.isCancelled()).toBe(false);
    expect(companionToken.isCancelled()).toBe(false);

    primary.release();
    companion.release();
  });

  test('registerActiveSearch preempts when search id matches but client differs', () => {
    const oldToken = createCancellationToken();
    const newToken = createCancellationToken();
    const oldReq = createReq({
      headers: {
        'x-search-id': 'same-search-id',
        'x-search-client': 'client-a',
        'x-search-seq': '10',
      },
    });
    const newReq = createReq({
      headers: {
        'x-search-id': 'same-search-id',
        'x-search-client': 'client-b',
        'x-search-seq': '10',
      },
    });

    const oldSearch = registerActiveSearch(oldReq, oldToken);
    const newSearch = registerActiveSearch(newReq, newToken);

    expect(oldSearch.stale).toBe(false);
    expect(newSearch.stale).toBe(false);
    expect(newSearch.replacedPrevious).toBe(true);
    expect(oldToken.isCancelled()).toBe(true);
    expect(newToken.isCancelled()).toBe(false);

    newSearch.release();
    oldSearch.release();
  });

  test('waitWithCancellation returns original promise when no token is provided', async () => {
    const result = await waitWithCancellation(Promise.resolve('ok'));

    expect(result).toBe('ok');
  });

  test('waitWithCancellation rejects when token is cancelled', async () => {
    const token = createCancellationToken();
    const never = new Promise(() => {});
    setTimeout(() => token.cancel('stop now'), 0);

    await expect(waitWithCancellation(never, token)).rejects.toMatchObject({
      code: 'SEARCH_CANCELLED',
      statusCode: 409,
    });
  });

  test('enqueueComputeJob starts immediately when capacity is available', async () => {
    const onStart = jest.fn();

    const result = await enqueueComputeJob({
      run: async () => 'done',
      onStart,
      requestLoadUnits: 1,
    });

    expect(result).toBe('done');
    expect(onStart).toHaveBeenCalled();
  });

  test('enqueueComputeJob queues work and emits queue updates', async () => {
    const fillers = Array.from({ length: 40 }, () =>
      enqueueComputeJob({
        run: async () => new Promise((resolve) => setTimeout(() => resolve('fill'), 30)),
        requestLoadUnits: 1,
      }),
    );

    const onQueueUpdate = jest.fn();
    const second = enqueueComputeJob({
      run: async () => 'second',
      onQueueUpdate,
      requestLoadUnits: 1,
    });

    const results = await Promise.all([...fillers, second]);
    const secondResult = results[results.length - 1];

    expect(secondResult).toBe('second');
    expect(onQueueUpdate).toHaveBeenCalled();
  });

  test('enqueueComputeJob rejects when cancellation token is already cancelled', async () => {
    const token = createCancellationToken();
    token.cancel('queue cancelled');

    const queued = enqueueComputeJob({
      run: async () => 'queued',
      cancelToken: token,
      requestLoadUnits: 1,
    });

    await expect(queued).rejects.toMatchObject({ code: 'SEARCH_CANCELLED' });
  });
});
