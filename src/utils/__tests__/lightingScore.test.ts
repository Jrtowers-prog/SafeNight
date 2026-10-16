import {
  calculateLightingScore,
  getLightingDataForSegment,
  getTimeWeight,
  isNighttime,
  lampCountMultiplier,
  lampQualityMultiplier,
  roadTypeToLightingLikelihood,
} from '@/src/utils/lightingScore';

describe('lightingScore utilities', () => {
  it('identifies nighttime and returns expected weighting', () => {
    expect(isNighttime(new Date('2026-04-17T19:00:00Z'))).toBe(true);
    expect(isNighttime(new Date('2026-04-17T12:00:00Z'))).toBe(false);
    expect(getTimeWeight(true)).toEqual({ lighting: 0.6, other: 0.4 });
    expect(getTimeWeight(false)).toEqual({ lighting: 0.2, other: 0.8 });
  });

  it('maps road types to lighting likelihood', () => {
    expect(roadTypeToLightingLikelihood('primary')).toBeGreaterThan(0.9);
    expect(roadTypeToLightingLikelihood('path')).toBeLessThan(0.3);
    expect(roadTypeToLightingLikelihood('unknown-type')).toBe(0.5);
  });

  it('applies lamp quality and count multipliers', () => {
    expect(
      lampQualityMultiplier({
        isLit: true,
        confidence: 1,
        roadType: 'primary',
        source: 'osm_explicit',
        lightMethod: 'LED',
      }),
    ).toBe(1.4);

    expect(
      lampCountMultiplier({
        isLit: true,
        confidence: 1,
        roadType: 'primary',
        source: 'osm_explicit',
        lightCount: 4,
        lightDirection: 'both',
      }),
    ).toBeGreaterThan(1.2);
  });

  it('returns conservative defaults when no lighting data exists', () => {
    const night = calculateLightingScore([], new Date('2026-04-17T21:00:00Z'));
    const day = calculateLightingScore([], new Date('2026-04-17T10:00:00Z'));

    expect(night.score).toBe(0.3);
    expect(day.score).toBe(0.7);
    expect(night.hasLighting).toBe(false);
  });

  it('extracts nearby lighting data and infers values from way tags', () => {
    const segmentMidpoint = { latitude: 51.5, longitude: -0.12 };
    const ways = [
      {
        id: 1,
        highway: 'residential',
        lit: 'yes' as const,
        nodes: [{ latitude: 51.50001, longitude: -0.12001 }],
        tags: { lamp_type: 'electric', 'light:method': 'LED', 'light:count': '3' },
      },
      {
        id: 2,
        highway: 'path',
        lit: 'unknown' as const,
        nodes: [{ latitude: 51.6, longitude: -0.2 }],
      },
    ];

    const data = getLightingDataForSegment(segmentMidpoint, ways, 50);

    expect(data).toHaveLength(1);
    expect(data[0].isLit).toBe(true);
    expect(data[0].source).toBe('osm_explicit');
    expect(data[0].lightMethod).toBe('LED');
    expect(data[0].lightCount).toBe(3);
  });
});
