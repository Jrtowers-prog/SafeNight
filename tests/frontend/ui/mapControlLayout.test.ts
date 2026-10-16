import {
  computeClusterPlacement,
  computeSafeBounds,
  shouldCollapseUtilityCluster,
  type MapControlLayoutInput,
} from '@/src/components/ui/mapControlLayout';

const makeInput = (overrides: Partial<MapControlLayoutInput> = {}): MapControlLayoutInput => ({
  viewportHeight: 900,
  topInset: 20,
  bottomInset: 20,
  searchBoundaryBottom: 90,
  sheetBoundaryTop: 780,
  ...overrides,
});

describe('mapControlLayout', () => {
  it('pushes utility cluster down when search boundary expands', () => {
    const compactSearch = computeClusterPlacement(
      makeInput({
        searchBoundaryBottom: 90,
      }),
    );
    const expandedSearch = computeClusterPlacement(
      makeInput({
        searchBoundaryBottom: 240,
      }),
    );

    expect(expandedSearch.utility.top).toBeGreaterThan(compactSearch.utility.top);
    expect(expandedSearch.safeBounds.top).toBeGreaterThan(compactSearch.safeBounds.top);
  });

  it('pushes bottom action cluster up when sheet grows higher', () => {
    const shortSheet = computeClusterPlacement(
      makeInput({
        sheetBoundaryTop: 840,
      }),
    );
    const highSheet = computeClusterPlacement(
      makeInput({
        sheetBoundaryTop: 520,
      }),
    );

    expect(highSheet.action.top).toBeLessThan(shortSheet.action.top);
    expect(highSheet.safeBounds.bottom).toBeLessThan(shortSheet.safeBounds.bottom);
  });

  it('collapses utility cluster in cramped height', () => {
    const crampedInput = makeInput({
      viewportHeight: 620,
      topInset: 24,
      bottomInset: 24,
      searchBoundaryBottom: 190,
      sheetBoundaryTop: 360,
    });

    expect(shouldCollapseUtilityCluster(crampedInput)).toBe(true);

    const placement = computeClusterPlacement(crampedInput);
    expect(placement.utility.collapsed).toBe(true);
    expect(placement.utility.visibleControlCount).toBeLessThanOrEqual(2);
  });

  it('reduces utility controls further when space is very tight', () => {
    const veryCrampedInput = makeInput({
      viewportHeight: 620,
      topInset: 24,
      bottomInset: 24,
      searchBoundaryBottom: 220,
      sheetBoundaryTop: 360,
    });

    const placement = computeClusterPlacement(veryCrampedInput);

    expect(placement.utility.collapsed).toBe(true);
    expect(placement.utility.visibleControlCount).toBeLessThanOrEqual(1);
  });

  it('never overlaps utility and action clusters', () => {
    const stressInputs: MapControlLayoutInput[] = [
      makeInput(),
      makeInput({ viewportHeight: 700, searchBoundaryBottom: 180, sheetBoundaryTop: 460 }),
      makeInput({ viewportHeight: 620, topInset: 24, bottomInset: 24, searchBoundaryBottom: 220, sheetBoundaryTop: 360 }),
      makeInput({ viewportHeight: 560, topInset: 16, bottomInset: 16, searchBoundaryBottom: 200, sheetBoundaryTop: 300 }),
    ];

    for (const input of stressInputs) {
      const placement = computeClusterPlacement(input);
      const utilityBottom = placement.utility.top + placement.utility.height;
      expect(utilityBottom).toBeLessThanOrEqual(placement.action.top);
    }
  });

  it('keeps all controls visible in normal height', () => {
    const normalInput = makeInput();

    expect(shouldCollapseUtilityCluster(normalInput)).toBe(false);

    const bounds = computeSafeBounds(normalInput);
    const placement = computeClusterPlacement(normalInput);

    expect(placement.utility.collapsed).toBe(false);
    expect(placement.utility.visibleControlCount).toBe(3);
    expect(placement.utility.top).toBeGreaterThanOrEqual(bounds.top);
    expect(placement.action.top + placement.action.height).toBeLessThanOrEqual(bounds.bottom);
  });

  it('is deterministic for identical input', () => {
    const input = makeInput({
      searchBoundaryBottom: 220,
      sheetBoundaryTop: 560,
    });

    const first = computeClusterPlacement(input);
    const second = computeClusterPlacement(input);

    expect(second).toEqual(first);
  });

  it('respects preferred action side when provided', () => {
    const leftPref = computeClusterPlacement(makeInput({ preferredActionSide: 'left' }));
    expect(leftPref.action.side).toBe('left');

    const defaultPref = computeClusterPlacement(makeInput());
    expect(defaultPref.action.side).toBe('right');
  });
});
