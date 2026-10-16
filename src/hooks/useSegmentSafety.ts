/**
 * Hook to fetch and calculate segment-based safety scores for a route
 * This integrates all the new utilities:
 * - Route segmentation (50m chunks)
 * - Lighting analysis from OSM
 * - Crime data analysis
 * - User report integration
 * - Color coding
 */

import { useCallback, useEffect, useState } from 'react';

import { fetchRouteSafetySummary } from '@/src/services/safety';
import { getSegmentStatistics, scoreAllSegments } from '@/src/services/segmentScoring';
import { AppError } from '@/src/types/errors';
import type { DirectionsRoute, LatLng } from '@/src/types/geo';
import type { SegmentScore } from '@/src/types/safety';
import { segmentRoute } from '@/src/utils/segmentRoute';

export type SegmentSafetyStatus = 'idle' | 'loading' | 'ready' | 'error';

export type UseSegmentSafetyState = {
  status: SegmentSafetyStatus;
  segments: SegmentScore[];
  overallScore: number | null;
  statistics: ReturnType<typeof getSegmentStatistics> | null;
  error: AppError | null;
  refresh: () => Promise<void>;
};

/**
 * Main hook for segment-based route safety analysis
 */
export const useSegmentSafety = (route: DirectionsRoute | null): UseSegmentSafetyState => {
  const [status, setStatus] = useState<SegmentSafetyStatus>('idle');
  const [segments, setSegments] = useState<SegmentScore[]>([]);
  const [overallScore, setOverallScore] = useState<number | null>(null);
  const [statistics, setStatistics] = useState<ReturnType<typeof getSegmentStatistics> | null>(
    null,
  );
  const [error, setError] = useState<AppError | null>(null);

  const refresh = useCallback(async () => {
    if (!route || !route.path || route.path.length === 0) {
      setSegments([]);
      setOverallScore(null);
      setStatistics(null);
      setStatus('idle');
      setError(null);
      return;
    }

    setStatus('loading');
    setError(null);

    try {
      // Step 1: Segment the route into 50m chunks
      const routeSegments = segmentRoute(route.path, 50);

      if (routeSegments.length === 0) {
        throw new AppError('segment_error', 'Unable to segment route');
      }

      // Step 2: Fetch all safety data for the route
      const safetySummary = await fetchRouteSafetySummary(route.path);

      // Step 3: Score each segment
      // Map roadSegments to the format expected by scoreAllSegments
      const roadSegments = safetySummary?.highwayStats?.roadSegments ?? [];
      const nearbyWays = roadSegments.map((seg) => ({
        id: seg.id,
        highway: seg.roadType,
        lit: seg.lit,
        nodes: [] as LatLng[], // Nodes not available in simplified format
      }));

      const segmentScores = scoreAllSegments(
        routeSegments,
        nearbyWays,
        safetySummary?.crimes ?? [],
      );

      if (segmentScores.length === 0) {
        throw new AppError('scoring_error', 'Unable to score segments');
      }

      // Step 4: Calculate statistics
      const stats = getSegmentStatistics(segmentScores);

      // Calculate overall score
      const overall =
        segmentScores.reduce((sum, s) => sum + s.combinedScore, 0) / segmentScores.length;

      setSegments(segmentScores);
      setOverallScore(overall);
      setStatistics(stats);
      setStatus('ready');
    } catch (caught) {
      const normalizedError =
        caught instanceof AppError
          ? caught
          : new AppError('segment_safety_error', 'Unable to fetch segment safety data', caught);

      setError(normalizedError);
      setStatus('error');
      setSegments([]);
      setOverallScore(null);
      setStatistics(null);
    }
  }, [route]);

  useEffect(() => {
    refresh().catch(() => {
      setStatus('error');
      setError(new AppError('segment_safety_refresh_error', 'Unable to refresh segment safety'));
    });
  }, [refresh]);

  return {
    status,
    segments,
    overallScore,
    statistics,
    error,
    refresh,
  };
};
