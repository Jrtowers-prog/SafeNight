import {
  formatDistance,
  formatDuration,
  formatNavDistance,
  lerpColor,
  maneuverIcon,
  stripHtml,
} from '@/src/utils/format';

describe('format utilities', () => {
  it('formats long and short distances in miles', () => {
    expect(formatDistance(1609.344)).toBe('1.0 mi');
    expect(formatDistance(16093.44)).toBe('10 mi');
  });

  it('formats navigation distances in yards for short ranges', () => {
    expect(formatNavDistance(100)).toBe('110 yds');
    expect(formatNavDistance(1609.344)).toBe('1.0 mi');
  });

  it('formats durations with hour and minute styles', () => {
    expect(formatDuration(3599)).toBe('60 min');
    expect(formatDuration(3660)).toBe('1h 1m');
    expect(formatDuration(1)).toBe('1 min');
  });

  it('strips html tags and nbsp from instructions', () => {
    expect(stripHtml('Turn <b>left</b>&nbsp;here')).toBe('Turn left here');
  });

  it('maps maneuvers to icons with a sensible fallback', () => {
    expect(maneuverIcon('turn-left')).toBe('arrow-back');
    expect(maneuverIcon('turn-right')).toBe('arrow-forward');
    expect(maneuverIcon('unknown-maneuver')).toBe('arrow-up');
  });

  it('interpolates colors and clamps interpolation value', () => {
    expect(lerpColor(0x000000, 0xffffff, 0.5)).toBe('#808080');
    expect(lerpColor(0x000000, 0xffffff, -1)).toBe('#000000');
    expect(lerpColor(0x000000, 0xffffff, 2)).toBe('#ffffff');
  });
});
