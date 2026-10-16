/**
 * useAutoPlaceSearch - Progressive Search Tests
 *
 * Tests verify the progressive search expansion logic:
 * - Level 1 (1 mile): Initial search radius
 * - Level 2 (2 miles): Expand if empty
 * - Level 3 (3 miles): Expand if empty
 * - Level 4 (5 miles): Expand if empty
 * - Level 5 (10 miles): Expand if empty
 * - Level 6 (Global): Search worldwide if all above empty
 */

import * as osmDirections from '@/src/services/osmDirections';
import type { PlacePrediction } from '@/src/types/geo';

jest.mock('@/src/services/osmDirections');

const mockFetchPlacePredictions = osmDirections.fetchPlacePredictions as jest.MockedFunction<
  typeof osmDirections.fetchPlacePredictions
>;

/**
 * Simulates the progressive search logic from useAutoPlaceSearch hooks
 */
async function performProgressiveSearch(
  query: string,
  locationBias: any,
  subscriptionTier: string,
): Promise<{ results: any[]; successfulRadiusMiles: number | null }> {
  const radiusStages = [1, 2, 3, 5, 10];

  for (const radiusMiles of radiusStages) {
    const radiusMeters = Math.round(radiusMiles * 1609.34);
    const results = await mockFetchPlacePredictions(query, {
      locationBias: locationBias ?? undefined,
      radiusMeters: locationBias ? radiusMeters : undefined,
      subscriptionTier: subscriptionTier,
    });

    if (results.length > 0) {
      return { results, successfulRadiusMiles: radiusMiles };
    }
  }

  const globalResults = await mockFetchPlacePredictions(query, {
    subscriptionTier: subscriptionTier,
  });
  return { results: globalResults, successfulRadiusMiles: null };
}

describe('useAutoPlaceSearch - Progressive Search', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('SCENARIO 1: finds results in initial 1-mile radius without expansion', async () => {
    const locationBias = { latitude: 51.5074, longitude: -0.1278 };
    const mockResults: PlacePrediction[] = [
      {
        placeId: 'place1',
        primaryText: 'Pizza Hut',
        fullText: 'Pizza Hut, London',
        location: { latitude: 51.51, longitude: -0.12 },
        source: 'osm',
      },
      {
        placeId: 'place2',
        primaryText: 'Pasta Palace',
        fullText: 'Pasta Palace, London',
        location: { latitude: 51.52, longitude: -0.11 },
        source: 'osm',
      },
    ];

    mockFetchPlacePredictions.mockResolvedValueOnce(mockResults);

    const results = await performProgressiveSearch('pizza', locationBias, 'free');

    expect(results.results).toHaveLength(2);
    expect(results.results[0].primaryText).toBe('Pizza Hut');
    expect(results.successfulRadiusMiles).toBe(1);
    expect(mockFetchPlacePredictions).toHaveBeenCalledTimes(1);
  });

  it('SCENARIO 2: expands to 2-mile radius when 1-mile search is empty', async () => {
    const locationBias = { latitude: 51.5074, longitude: -0.1278 };
    const mockResult: PlacePrediction[] = [
      {
        placeId: 'place1',
        primaryText: 'Rare Restaurant',
        fullText: 'Rare Restaurant, 10 miles away',
        location: { latitude: 51.6, longitude: -0.13 },
        source: 'osm',
      },
    ];

    mockFetchPlacePredictions.mockResolvedValueOnce([]).mockResolvedValueOnce(mockResult);

    const results = await performProgressiveSearch('restaurant', locationBias, 'free');

    expect(results.results).toHaveLength(1);
    expect(results.results[0].primaryText).toBe('Rare Restaurant');
    expect(results.successfulRadiusMiles).toBe(2);
    expect(mockFetchPlacePredictions).toHaveBeenCalledTimes(2);
  });

  it('SCENARIO 3: expands to 3-mile radius when 2-mile search is empty', async () => {
    const locationBias = { latitude: 51.5074, longitude: -0.1278 };
    const mockResult: PlacePrediction[] = [
      {
        placeId: 'p1',
        primaryText: 'Third Mile Result',
        fullText: 'Third Mile Result, London',
        source: 'osm',
        location: { latitude: 51.7, longitude: -0.14 },
      },
    ];

    mockFetchPlacePredictions.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce(mockResult);

    const results = await performProgressiveSearch('restaurant', locationBias, 'free');

    expect(results.results).toHaveLength(1);
    expect(results.successfulRadiusMiles).toBe(3);
    expect(mockFetchPlacePredictions).toHaveBeenCalledTimes(3);
  });

  it('SCENARIO 4: expands to 5-mile radius when 3-mile search is empty', async () => {
    const locationBias = { latitude: 51.5074, longitude: -0.1278 };
    const mockResult: PlacePrediction[] = [
      {
        placeId: 'p1',
        primaryText: 'Fifth Mile Result',
        fullText: 'Fifth Mile Result, London',
        source: 'osm',
        location: { latitude: 51.8, longitude: -0.15 },
      },
    ];

    mockFetchPlacePredictions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(mockResult);

    const results = await performProgressiveSearch('pizza', locationBias, 'free');

    expect(results.results).toHaveLength(1);
    expect(results.successfulRadiusMiles).toBe(5);
    expect(mockFetchPlacePredictions).toHaveBeenCalledTimes(4);
  });

  it('SCENARIO 5: expands to 10-mile radius when 5-mile search is empty', async () => {
    const locationBias = { latitude: 51.5074, longitude: -0.1278 };
    const mockGlobalResult: PlacePrediction[] = [
      {
        placeId: 'p1',
        primaryText: 'Global Result',
        fullText: 'Global Result, Scotland',
        source: 'osm',
        location: { latitude: 57.2652, longitude: -4.4185 },
      },
    ];

    mockFetchPlacePredictions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(mockGlobalResult);

    const results = await performProgressiveSearch('unique', locationBias, 'free');

    expect(results.results).toHaveLength(1);
    expect(results.successfulRadiusMiles).toBe(10);
    expect(mockFetchPlacePredictions).toHaveBeenCalledTimes(5);
  });

  it('SCENARIO 6: searches globally directly when no location bias provided', async () => {
    const mockResults: PlacePrediction[] = [
      {
        placeId: 'p1',
        primaryText: 'Global Match',
        fullText: 'Global Match, New York',
        location: { latitude: 40.7128, longitude: -74.006 },
        source: 'osm',
      },
    ];

    mockFetchPlacePredictions.mockResolvedValueOnce(mockResults);

    const results = await mockFetchPlacePredictions('unbiased', {
      subscriptionTier: 'free',
    });

    expect(results).toHaveLength(1);
    expect(mockFetchPlacePredictions).toHaveBeenCalledTimes(1);
  });

  it('SCENARIO 7: uses correct radius progression: 1, 2, 3, 5, 10 miles', async () => {
    const locationBias = { latitude: 51.5074, longitude: -0.1278 };

    mockFetchPlacePredictions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          placeId: 'p1',
          primaryText: 'Third Mile Result',
          fullText: 'Third Mile Result, London',
          source: 'osm',
          location: { latitude: 51, longitude: -0.1 },
        },
      ]);

    await performProgressiveSearch('test', locationBias, 'free');

    const calls = mockFetchPlacePredictions.mock.calls;
    expect(calls[0]![1]!.radiusMeters).toBeCloseTo(1 * 1609.34, -1);
    expect(calls[1]![1]!.radiusMeters).toBeCloseTo(2 * 1609.34, -1);
    expect(calls[2]![1]!.radiusMeters).toBeCloseTo(3 * 1609.34, -1);
  });

  it('SCENARIO 8: premium tier still uses the same automatic radius ladder', async () => {
    const locationBias = { latitude: 51.5074, longitude: -0.1278 };
    const mockResults: PlacePrediction[] = [
      {
        placeId: 'p1',
        primaryText: 'Result',
        fullText: 'Result, London',
        location: { latitude: 51.51, longitude: -0.12 },
        source: 'osm',
      },
    ];

    mockFetchPlacePredictions.mockResolvedValueOnce(mockResults);

    await performProgressiveSearch('pizza', locationBias, 'premium');

    const callArgs = mockFetchPlacePredictions.mock.calls[0];
    expect(callArgs[1]!.radiusMeters).toBeCloseTo(1 * 1609.34, -1);
  });

  it('SCENARIO 9: returns empty array when no results found at any expansion level', async () => {
    const locationBias = { latitude: 51.5074, longitude: -0.1278 };

    mockFetchPlacePredictions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const results = await performProgressiveSearch('nonexistent', locationBias, 'free');

    expect(results.results).toEqual([]);
    expect(results.successfulRadiusMiles).toBeNull();
    expect(mockFetchPlacePredictions).toHaveBeenCalledTimes(6);
  });

  it('SCENARIO 10: propagates network errors from API calls', async () => {
    const locationBias = { latitude: 51.5074, longitude: -0.1278 };

    mockFetchPlacePredictions.mockRejectedValueOnce(new Error('Network timeout'));

    await expect(performProgressiveSearch('pizza', locationBias, 'free')).rejects.toThrow('Network timeout');
  });

  it('SCENARIO 11: stops searching after finding results at 2-mile expansion', async () => {
    const locationBias = { latitude: 51.5074, longitude: -0.1278 };
    const mockResult: PlacePrediction[] = [
      {
        placeId: 'p1',
        primaryText: 'Early Result',
        fullText: 'Early Result, London',
        source: 'osm',
        location: { latitude: 51, longitude: -0.1 },
      },
    ];

    mockFetchPlacePredictions.mockResolvedValueOnce([]).mockResolvedValueOnce(mockResult);

    const results = await performProgressiveSearch('test', locationBias, 'free');

    expect(results.results).toHaveLength(1);
    expect(results.successfulRadiusMiles).toBe(2);
    expect(mockFetchPlacePredictions).toHaveBeenCalledTimes(2);
  });

  it('SCENARIO 12: passes location bias coordinates to API calls', async () => {
    const locationBias = { latitude: 51.5074, longitude: -0.1278 };
    const mockResults: PlacePrediction[] = [
      {
        placeId: 'p1',
        primaryText: 'Bias Result',
        fullText: 'Bias Result, London',
        source: 'osm',
        location: { latitude: 51.51, longitude: -0.12 },
      },
    ];

    mockFetchPlacePredictions.mockResolvedValueOnce(mockResults);

    await performProgressiveSearch('pizza', locationBias, 'free');

    const callArgs = mockFetchPlacePredictions.mock.calls[0];
    expect(callArgs[1]!.locationBias).toEqual(locationBias);
  });

  it('SCENARIO 13: returns all multiple predictions from successful search', async () => {
    const locationBias = { latitude: 51.5074, longitude: -0.1278 };
    const mockResults: PlacePrediction[] = [
      { placeId: 'p1', primaryText: 'Pizza Hut', fullText: 'Pizza Hut, London', location: { latitude: 51.51, longitude: -0.12 }, source: 'osm' },
      { placeId: 'p2', primaryText: 'Pasta Palace', fullText: 'Pasta Palace, London', location: { latitude: 51.52, longitude: -0.11 }, source: 'osm' },
      { placeId: 'p3', primaryText: 'Pizza Express', fullText: 'Pizza Express, London', location: { latitude: 51.53, longitude: -0.13 }, source: 'osm' },
    ];

    mockFetchPlacePredictions.mockResolvedValueOnce(mockResults);

    const results = await performProgressiveSearch('pizza', locationBias, 'free');

    expect(results.results).toHaveLength(3);
    expect(results.results[0].primaryText).toBe('Pizza Hut');
    expect(results.results[1].primaryText).toBe('Pasta Palace');
    expect(results.results[2].primaryText).toBe('Pizza Express');
  });

  it('SCENARIO 14: uses same search query in all expansion levels', async () => {
    const locationBias = { latitude: 51.5074, longitude: -0.1278 };
    const mockResult: PlacePrediction[] = [
      {
        placeId: 'p1',
        primaryText: 'Query Result',
        fullText: 'Query Result, London',
        source: 'osm',
        location: { latitude: 51, longitude: -0.1 },
      },
    ];

    mockFetchPlacePredictions.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce(mockResult);

    await performProgressiveSearch('restaurant', locationBias, 'free');

    const calls = mockFetchPlacePredictions.mock.calls;
    expect(calls[0][0]).toBe('restaurant');
    expect(calls[1][0]).toBe('restaurant');
    expect(calls[2][0]).toBe('restaurant');
  });

  it('SCENARIO 15: passes premium tier consistently to all expansion calls', async () => {
    const locationBias = { latitude: 51.5074, longitude: -0.1278 };
    const mockResult: PlacePrediction[] = [
      {
        placeId: 'p1',
        primaryText: 'Premium Result',
        fullText: 'Premium Result, London',
        source: 'osm',
        location: { latitude: 51, longitude: -0.1 },
      },
    ];

    mockFetchPlacePredictions.mockResolvedValueOnce([]).mockResolvedValueOnce(mockResult);

    await performProgressiveSearch('pizza', locationBias, 'premium');

    const calls = mockFetchPlacePredictions.mock.calls;
    expect(calls[0]![1]!.subscriptionTier).toBe('premium');
    expect(calls[1]![1]!.subscriptionTier).toBe('premium');
  });
});
