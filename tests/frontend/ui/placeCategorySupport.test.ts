import fs from 'node:fs';
import path from 'node:path';

describe('place category search support', () => {
  const appSource = fs.readFileSync(path.join(process.cwd(), 'app/index.tsx'), 'utf8');
  const nearbyCacheSource = fs.readFileSync(
    path.join(process.cwd(), 'src/utils/nearbyCache.ts'),
    'utf8',
  );
  const gatewayNearbySource = fs.readFileSync(
    path.join(process.cwd(), 'backend/src/gateway/routes/nearby.js'),
    'utf8',
  );
  const geocodeSource = fs.readFileSync(
    path.join(process.cwd(), 'backend/src/geocode/routes/geocode.js'),
    'utf8',
  );

  it('exposes school and public-place chips in the UI', () => {
    expect(appSource).toContain('{ key: "school", label: "School", query: "schools", icon: "school-outline" }');
    expect(appSource).toContain('{ key: "public_place", label: "Public Places", query: "public places", icon: "business-outline" }');
  });

  it('classifies school and public-place results into dedicated categories', () => {
    expect(appSource).toContain('if (/\\bschool\\b|university|college|academy|campus|primary school|secondary school/.test(bucket)) return "school";');
    expect(appSource).toContain('if (/community_centre|community centre|library|town hall|townhall|civic|public building|public place|government|city hall|museum|community hall/.test(bucket)) return "public_place";');
  });

  it('expands the shared nearby Overpass query for schools and public places', () => {
    expect(nearbyCacheSource).toContain('school|university|college|library|townhall|community_centre');
  });

  it('expands the backend nearby proxy query for schools and public places', () => {
    expect(gatewayNearbySource).toContain('school|university|college|library|townhall|community_centre|bank|marketplace');
  });

  it('adds autocomplete expansions for school and public-place searches', () => {
    expect(geocodeSource).toContain('pattern: /\\b(school|schools|university|college|academy|campus)\\b/i');
    expect(geocodeSource).toContain('pattern: /\\b(public\\s*place|public\\s*places|community\\s*centre|community\\s*center|library|town\\s*hall|civic)\\b/i');
  });
});