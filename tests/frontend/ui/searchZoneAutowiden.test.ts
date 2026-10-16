import fs from 'node:fs';
import path from 'node:path';

describe('search zone auto-widening', () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), 'app/index.tsx'), 'utf8');

  it('includes the 4-mile step in the distance filter options', () => {
    expect(appSource).toContain('const SEARCH_DISTANCE_FILTER_OPTIONS_MILES = [1, 2, 3, 4, 5, 10] as const;');
  });

  it('auto-expands empty results from 1 to 5 miles', () => {
    expect(appSource).toContain('const maxDistanceFilterMiles = useMemo(() => {');
    expect(appSource).toContain('return tier === "free" ? 5 : 10;');
    expect(appSource).toContain('const visibleFilteredSheetPlaces = useMemo(() => {');
    expect(appSource).toContain('const maxAutoZoneMiles = Math.min(maxDistanceFilterMiles, 5);');
    expect(appSource).toContain('const nextDistance = Math.min(searchDistanceFilterMiles + 1, maxAutoZoneMiles);');
    expect(appSource).toContain('setSearchDistanceFilterMiles(nextDistance);');
    expect(appSource).toContain('setSheetPlacesFitToken((prev) => prev + 1);');
  });
});