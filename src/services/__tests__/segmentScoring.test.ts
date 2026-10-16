import {
  calculateCrimeScore,
  calculateOverallScore,
  calculateReportScore,
  getSegmentStatistics,
  scoreSegment,
} from '@/src/services/segmentScoring';

const baseSegment = {
  id: 1,
  index: 1,
  startCoord: { latitude: 51.5, longitude: -0.12 },
  endCoord: { latitude: 51.5001, longitude: -0.1201 },
  midpointCoord: { latitude: 51.50005, longitude: -0.12005 },
  length: 50,
  startDistance: 0,
  endDistance: 50,
};

describe('segmentScoring service', () => {
  it('calculates crime score based on nearby incidents', () => {
    const crimes = [
      { category: 'theft', month: '2026-04', location: { latitude: 51.50005, longitude: -0.12005 } },
      { category: 'theft', month: '2026-04', location: { latitude: 51.50005, longitude: -0.12005 } },
    ];

    const score = calculateCrimeScore(baseSegment, crimes as any, 30);
    expect(score).toBeCloseTo(0.6, 5);
  });

  it('calculates report score and defaults to safe when no reports nearby', () => {
    const reports = [
      { location: { latitude: 51.50005, longitude: -0.12005 }, severity: 0.8 },
      { location: { latitude: 51.50006, longitude: -0.12006 }, severity: 0.4 },
    ];

    const score = calculateReportScore(baseSegment, reports, 30);
    expect(score).toBeCloseTo(0.4, 5);
    expect(calculateReportScore(baseSegment, [], 30)).toBe(1);
  });

  it('returns neutral segment score when midpoint is missing', () => {
    const malformed = { ...baseSegment, midpointCoord: undefined };
    const scored = scoreSegment({ segment: malformed as any, nearbyWays: [], crimes: [] });

    expect(scored.combinedScore).toBe(0.5);
    expect(scored.riskLevel).toBe('caution');
  });

  it('calculates overall score and segment statistics', () => {
    const segmentScores = [
      { segmentId: 1, lightingScore: 0.9, crimeScore: 0.9, combinedScore: 0.85, color: '#00ff00', riskLevel: 'safe' as const },
      { segmentId: 2, lightingScore: 0.5, crimeScore: 0.4, combinedScore: 0.45, color: '#ffff00', riskLevel: 'caution' as const },
      { segmentId: 3, lightingScore: 0.1, crimeScore: 0.2, combinedScore: 0.2, color: '#ff0000', riskLevel: 'danger' as const },
    ];

    expect(calculateOverallScore(segmentScores as any)).toBeCloseTo((0.85 + 0.45 + 0.2) / 3, 5);

    const stats = getSegmentStatistics(segmentScores as any);
    expect(stats.total).toBe(3);
    expect(stats.safe).toBe(1);
    expect(stats.caution).toBe(1);
    expect(stats.danger).toBe(1);
    expect(stats.bestSegment?.segmentId).toBe(1);
    expect(stats.worstSegment?.segmentId).toBe(3);
  });

  it('returns default statistics for empty segments', () => {
    const stats = getSegmentStatistics([]);
    expect(stats.total).toBe(0);
    expect(stats.averageScore).toBe(0.5);
    expect(stats.bestSegment).toBeNull();
  });
});
