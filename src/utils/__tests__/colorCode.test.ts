import {
  combineScores,
  getRiskLabel,
  getScoreDescription,
  scoreToColor,
} from '@/src/utils/colorCode';

describe('colorCode utilities', () => {
  it('maps score boundaries to expected risk levels', () => {
    expect(scoreToColor(0.2).riskLevel).toBe('danger');
    expect(scoreToColor(0.5).riskLevel).toBe('caution');
    expect(scoreToColor(0.9).riskLevel).toBe('safe');
  });

  it('clamps score values between 0 and 1', () => {
    expect(scoreToColor(-10).score).toBe(0);
    expect(scoreToColor(10).score).toBe(1);
  });

  it('combines weighted scores and ignores missing score keys', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const combined = combineScores(
      { lighting: 0.8, crime: 0.5 },
      { lighting: 0.6, crime: 0.2, missing: 0.2 },
    );

    expect(combined).toBeCloseTo((0.8 * 0.6 + 0.5 * 0.2) / 0.8, 5);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('returns neutral score when no valid weights are provided', () => {
    expect(combineScores({ lighting: 0.8 }, { missing: 1 })).toBe(0.5);
  });

  it('returns readable labels and score descriptions', () => {
    expect(getRiskLabel('safe')).toBe('Safe');
    expect(getRiskLabel('caution')).toBe('Caution');
    expect(getRiskLabel('danger')).toBe('Danger');

    expect(getScoreDescription(0.85)).toMatch('Very Safe');
    expect(getScoreDescription(0.65)).toMatch('Safe');
    expect(getScoreDescription(0.45)).toMatch('Moderate');
    expect(getScoreDescription(0.25)).toMatch('Risky');
    expect(getScoreDescription(0.05)).toMatch('Very Risky');
  });
});
