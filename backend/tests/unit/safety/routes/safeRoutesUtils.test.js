const {
  stripPH,
  checkOpenNow,
  heuristicOpen,
  safetyLabel,
  segmentColor,
} = require('../../../../src/safety/routes/safeRoutesUtils');

describe('safeRoutesUtils', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('stripPH returns input when it is falsy', () => {
    expect(stripPH(null)).toBeNull();
  });

  test('stripPH removes standalone PH clauses', () => {
    const result = stripPH('Mo-Su 07:00-23:00; PH off');

    expect(result).toBe('Mo-Su 07:00-23:00');
  });

  test('stripPH returns null when every segment is removed', () => {
    const result = stripPH('PH off');

    expect(result).toBeNull();
  });

  test('checkOpenNow returns unknown for empty input', () => {
    const result = checkOpenNow('');

    expect(result).toEqual({ open: null, nextChange: null });
  });

  test('checkOpenNow returns unknown for invalid hours expression', () => {
    const result = checkOpenNow('not-a-valid-hours-string');

    expect(result).toEqual({ open: null, nextChange: null });
  });

  test('heuristicOpen marks always-open amenity as open', () => {
    const result = heuristicOpen('hospital');

    expect(result.open).toBe(true);
  });

  test('heuristicOpen marks evening places as open in evening window', () => {
    jest.spyOn(Date.prototype, 'getHours').mockReturnValue(18);

    const result = heuristicOpen('pub');

    expect(result).toEqual({ open: true, nextChange: 'closes at 23:00' });
  });

  test('heuristicOpen marks evening places as closed outside evening window', () => {
    jest.spyOn(Date.prototype, 'getHours').mockReturnValue(3);

    const result = heuristicOpen('bar');

    expect(result).toEqual({ open: false, nextChange: 'opens at 10:00' });
  });

  test('heuristicOpen marks daytime generic places as open', () => {
    jest.spyOn(Date.prototype, 'getHours').mockReturnValue(10);

    const result = heuristicOpen('library');

    expect(result).toEqual({ open: true, nextChange: 'closes at 20:00' });
  });

  test('heuristicOpen marks nighttime generic places as closed', () => {
    jest.spyOn(Date.prototype, 'getHours').mockReturnValue(22);

    const result = heuristicOpen('library');

    expect(result).toEqual({ open: false, nextChange: 'opens at 07:00' });
  });

  test('safetyLabel returns very-safe label for high scores', () => {
    const result = safetyLabel(90);

    expect(result.label).toBe('Very Safe');
  });

  test('safetyLabel returns safe label for medium-high scores', () => {
    expect(safetyLabel(60)).toEqual({ label: 'Safe', color: '#558B2F' });
  });

  test('safetyLabel returns moderate label for mid-range scores', () => {
    expect(safetyLabel(40)).toEqual({ label: 'Moderate', color: '#F9A825' });
  });

  test('safetyLabel returns caution label for low scores', () => {
    expect(safetyLabel(10)).toEqual({ label: 'Use Caution', color: '#C62828' });
  });

  test('segmentColor returns green for safest range', () => {
    expect(segmentColor(0.8)).toBe('#4CAF50');
  });

  test('segmentColor returns light-green for safe range', () => {
    expect(segmentColor(0.6)).toBe('#8BC34A');
  });

  test('segmentColor returns yellow for moderate range', () => {
    expect(segmentColor(0.4)).toBe('#FFC107');
  });

  test('segmentColor returns orange for lower range', () => {
    expect(segmentColor(0.25)).toBe('#FF9800');
  });

  test('segmentColor returns caution color for low score', () => {
    const result = segmentColor(0.1);

    expect(result).toBe('#F44336');
  });
});
