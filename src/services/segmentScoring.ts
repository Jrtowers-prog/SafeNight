/**
 * Segment-based safety scoring service
 * Combines lighting, crime, and other factors per 50m segment
 */

import type { LatLng } from '@/src/types/geo';
import type { CrimeIncident, SegmentScore } from '@/src/types/safety';
import { scoreToColor } from '@/src/utils/colorCode';
import { calculateLightingScore, getLightingDataForSegment } from '@/src/utils/lightingScore';
import type { RouteSegment } from '@/src/utils/segmentRoute';
import { calculateDistance } from '@/src/utils/segmentRoute';

export interface SegmentScoringInput {
  segment: RouteSegment;
  nearbyWays: Array<{
    id: number;
    highway: string;
    lit: 'yes' | 'no' | 'unknown';
    nodes: LatLng[];
  }>;
  crimes: CrimeIncident[];
  userReports?: Array<{ location: LatLng; severity: number }>;
  crimeRadiusMeters?: number;
  lightingRadiusMeters?: number;
}

/**
 * Calculate crime risk score for a segment (0-1, where 1 = safe)
 */
export const calculateCrimeScore = (
  segment: RouteSegment,
  crimes: CrimeIncident[],
  radiusMeters: number = 30,
): number => {
  const crimeCount = crimes.filter((crime) => {
    const distance = calculateDistance(segment.midpointCoord, crime.location);
    return distance <= radiusMeters;
  }).length;

  // Normalize: assume more than 5 crimes = score 0, 0 crimes = score 1
  const maxDangerousCrimes = 5;
  const crimeScore = Math.max(0, 1 - crimeCount / maxDangerousCrimes);

  return crimeScore;
};

/**
 * Calculate user report risk score for a segment (0-1, where 1 = safe)
 */
export const calculateReportScore = (
  segment: RouteSegment,
  reports: Array<{ location: LatLng; severity: number }>,
  radiusMeters: number = 30,
): number => {
  const nearbyReports = reports.filter((report) => {
    const distance = calculateDistance(segment.midpointCoord, report.location);
    return distance <= radiusMeters;
  });

  if (nearbyReports.length === 0) {
    return 1.0; // No reports = safe
  }

  // Average severity (0-1) and convert to score
  const avgSeverity = nearbyReports.reduce((sum, r) => sum + r.severity, 0) / nearbyReports.length;
  return Math.max(0, 1 - avgSeverity);
};

/**
 * Score a single segment based on all available data
 */
export const scoreSegment = (input: SegmentScoringInput): SegmentScore => {
  const {
    segment,
    nearbyWays,
    crimes,
    userReports = [],
    crimeRadiusMeters = 30,
    lightingRadiusMeters = 30,
  } = input;

  if (!segment.midpointCoord) {
    // Malformed segment - return neutral score
    const { color, riskLevel } = scoreToColor(0.5);
    return {
      segmentId: segment.id,
      lightingScore: 0.5,
      crimeScore: 0.5,
      combinedScore: 0.5,
      color,
      riskLevel,
    };
  }

  // Get lighting score
  const lightingData = getLightingDataForSegment(
    segment.midpointCoord,
    nearbyWays,
    lightingRadiusMeters,
  );
  const lightingScoreObj = calculateLightingScore(lightingData);

  // Get crime score
  const crimeScore = calculateCrimeScore(segment, crimes, crimeRadiusMeters);

  // Get user report score
  const reportScore = calculateReportScore(segment, userReports, crimeRadiusMeters);

  // Combine scores with weights
  // For MVP: lighting is 40%, crime is 40%, reports are 20%
  const combinedScore =
    lightingScoreObj.score * 0.4 + crimeScore * 0.4 + reportScore * 0.2;

  // Convert to color
  const { color, riskLevel } = scoreToColor(combinedScore);

  return {
    segmentId: segment.id,
    lightingScore: lightingScoreObj.score,
    crimeScore,
    combinedScore,
    color,
    riskLevel,
  };
};

/**
 * Score all segments in a route
 */
export const scoreAllSegments = (
  segments: RouteSegment[],
  nearbyWays: Array<{
    id: number;
    highway: string;
    lit: 'yes' | 'no' | 'unknown';
    nodes: LatLng[];
  }>,
  crimes: CrimeIncident[],
  userReports?: Array<{ location: LatLng; severity: number }>,
): SegmentScore[] => {
  return segments.map((segment) =>
    scoreSegment({
      segment,
      nearbyWays,
      crimes,
      userReports,
    }),
  );
};

/**
 * Calculate overall route safety score (average of all segments)
 */
export const calculateOverallScore = (segmentScores: SegmentScore[]): number => {
  if (segmentScores.length === 0) return 0.5;
  const totalScore = segmentScores.reduce((sum, s) => sum + s.combinedScore, 0);
  return totalScore / segmentScores.length;
};

/**
 * Get safety statistics from segment scores
 */
export const getSegmentStatistics = (segmentScores: SegmentScore[]) => {
  if (segmentScores.length === 0) {
    return {
      total: 0,
      safe: 0,
      caution: 0,
      danger: 0,
      averageScore: 0.5,
      worstSegment: null,
      bestSegment: null,
    };
  }

  return {
    total: segmentScores.length,
    safe: segmentScores.filter((s) => s.riskLevel === 'safe').length,
    caution: segmentScores.filter((s) => s.riskLevel === 'caution').length,
    danger: segmentScores.filter((s) => s.riskLevel === 'danger').length,
    averageScore: calculateOverallScore(segmentScores),
    worstSegment: segmentScores.reduce((worst, current) =>
      current.combinedScore < worst.combinedScore ? current : worst,
    ),
    bestSegment: segmentScores.reduce((best, current) =>
      current.combinedScore > best.combinedScore ? current : best,
    ),
  };
};
