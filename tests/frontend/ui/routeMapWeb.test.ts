import { buildLeafletHtml } from '@/src/components/maps/RouteMap.web';

describe('RouteMap.web buildLeafletHtml', () => {
  it('hides leaflet zoom controls for web layout', () => {
    const html = buildLeafletHtml(false);
    expect(html).toContain('.leaflet-control-zoom');
    // We intentionally hide the controls via display:none
    expect(html).toMatch(/\.leaflet-control-zoom\s*\{\s*display:\s*none/i);
  });

  it('includes basic map container', () => {
    const html = buildLeafletHtml(false);
    expect(html).toContain('<div id="map"></div>');
  });

  it('routes selected candidate card button to safe-route action instead of plain selection', () => {
    const html = buildLeafletHtml(false);
    expect(html).toContain("sendMsg('findSafeRoutes', { id:m.id });");
  });
});
