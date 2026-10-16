import fs from 'node:fs';
import path from 'node:path';

describe('RouteMap.native Android autofocus fix — fitCandidateBoundsToken handling', () => {
  const nativeSourcePath = path.join(
    process.cwd(),
    'src/components/maps/RouteMap.native.tsx',
  );
  const nativeSource = fs.readFileSync(nativeSourcePath, 'utf8');

  it('includes Android injection safeguard with readiness check and delayed dispatch', () => {
    expect(nativeSource).toContain('if (Platform.OS === "android" && shouldDelayForAndroid) {');
    expect(nativeSource).toContain('requestAnimationFrame(() => {');
    expect(nativeSource).toContain('setTimeout(() => {');
    expect(nativeSource).toContain('if (!readyRef.current || !webViewRef.current) {');
    expect(nativeSource).toContain('webViewRef.current.injectJavaScript(js);');
  });

  it('keeps non-Android injection path direct', () => {
    expect(nativeSource).toContain('} else {');
    expect(nativeSource).toContain('webViewRef.current.injectJavaScript(js);');
  });

  it('derives fitCandidateBounds from token transition and stores previous token', () => {
    expect(nativeSource).toContain(
      '(p.fitCandidateBoundsToken ?? 0) !== prevFitCandidateBoundsTokenRef.current'
    );
    expect(nativeSource).toContain(
      'prevFitCandidateBoundsTokenRef.current = p.fitCandidateBoundsToken ?? 0'
    );
  });

  it('has dedicated token effect that immediately calls pushUpdate', () => {
    const tokenEffectPattern = /useEffect\(\(\) => \{[\s\S]*?pushUpdate\(\);[\s\S]*?\}, \[fitCandidateBoundsToken, androidFitCandidateBoundsToken, pushUpdate\]\);/;
    expect(nativeSource).toMatch(tokenEffectPattern);
  });

  it('guards candidate refit when there are no markers', () => {
    expect(nativeSource).toContain('if ((fitCandidateBounds || androidFitCandidateBounds) && mkrs.length === 0) {');
    expect(nativeSource).toContain('Skipping injection.');
  });

  it('sends candidate marker coordinates in payload and enables fitCandidateBounds flag', () => {
    expect(nativeSource).toContain('const mkrs = p.safetyMarkers.map((m) => ({');
    expect(nativeSource).toContain('lat: m.coordinate.latitude,');
    expect(nativeSource).toContain('lng: m.coordinate.longitude,');
    expect(nativeSource).toContain('fitCandidateBounds: explicitCandidateRefit,');
    expect(nativeSource).toContain('androidFitCandidateBounds,');
    expect(nativeSource).toContain('safetyMarkers: mkrs,');
  });

  it('keeps enhanced pin styling available for layer-rendered candidate emphasis', () => {
    expect(nativeSource).toContain(
      '.search-pin-wrap{position:relative;display:block;width:28px;height:30px;pointer-events:auto;overflow:visible}'
    );
    expect(nativeSource).toContain(
      '.search-pin-dot{width:18px;height:18px;border-radius:50%;background:var(--pin-color,#ef4444);border:2px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.35);position:absolute;left:50%;bottom:6px;transform:translateX(-50%) scale(1);transform-origin:50% 100%;transition:transform .16s ease,width .16s ease,height .16s ease}'
    );
    expect(nativeSource).toContain(
      '.search-pin-wrap.selected .search-pin-dot{width:24px;height:24px;border-width:3px;box-shadow:0 5px 16px rgba(0,0,0,.34);bottom:6px;transform:translateX(-50%) scale(1)}'
    );
    expect(nativeSource).toContain(
      '.pin-size-mid .search-pin-dot{transform:translateX(-50%) scale(0.86)}'
    );
    expect(nativeSource).toContain(
      '.pin-size-mid .search-pin-wrap.selected .search-pin-dot{transform:translateX(-50%) scale(0.84)}'
    );
    expect(nativeSource).toContain(
      '.pin-size-far .search-pin-dot{transform:translateX(-50%) scale(0.7)}'
    );
    expect(nativeSource).toContain(
      '.pin-size-far .search-pin-wrap.selected .search-pin-dot{transform:translateX(-50%) scale(0.68)}'
    );
    expect(nativeSource).toContain(
      '.pin-size-far .search-pin-label{font-size:10px;max-width:120px}'
    );
  });

  it('renders search candidates through geojson safety layer for coordinate-locked behavior', () => {
    expect(nativeSource).toContain("kind:'search_candidate'");
    expect(nativeSource).toContain('map.getSource(\'safety-markers\').setData');
    expect(nativeSource).not.toContain("pinEl.className='search-pin-wrap';");
  });

  it('restores the selected candidate detail card as a separate overlay marker', () => {
    expect(nativeSource).toContain('var selectedCandidate = null;');
    expect(nativeSource).toContain('selectedCandidate = m;');
    expect(nativeSource).toContain('selectedEl.className=\'search-pin-wrap selected\';');
    expect(nativeSource).toContain('search-pin-card-close');
    expect(nativeSource).toContain('dismissMarkerDetails');
    expect(nativeSource).toContain("createViewportMarker({ element:selectedEl, anchor:'bottom' })");
    expect(nativeSource).toContain('var selectedCandidateCardMarker = null;');
    expect(nativeSource).toContain('var selectedCandidateCardData = null;');
    expect(nativeSource).toContain('scheduleSelectedCandidateCardVisibility();');
    expect(nativeSource).toContain('cardEl.style.display = overlapCount > 3 ? \'none\' : \'block\';');
  });

  it('uses halo plus core safety-circle layers to improve dot appearance without DOM drift risk', () => {
    expect(nativeSource).toContain("id:'safety-circles-halo'");
    expect(nativeSource).toContain("['interpolate',['linear'],['zoom'],5");
    expect(nativeSource).toContain(
      "'circle-radius':['interpolate',['linear'],['zoom'],5,['case',['==',['get','isSelected'],1],12,['==',['get','kind'],'via'],11,['==',['get','kind'],'search_candidate'],10,7]"
    );
    expect(nativeSource).toContain("'circle-stroke-width':['interpolate',['linear'],['zoom'],5,['case',['==',['get','isSelected'],1],2.75,['==',['get','kind'],'via'],2.5,['==',['get','kind'],'search_candidate'],2.25,1.5]");
  });

  it('webview updateMap computes bounds from all visible safety markers when fitCandidateBounds is set', () => {
    expect(nativeSource).toContain(
      "var isCandidate = m.id && String(m.id).indexOf('search-candidate:')===0;"
    );
    expect(nativeSource).toContain('if(data.fitCandidateBounds){');
    expect(nativeSource).toContain('bounds=extBounds(bounds,[m.lng,m.lat]);');
    expect(nativeSource).not.toContain('if(data.fitCandidateBounds && m.id && String(m.id).indexOf(\'search-candidate:\')===0){');
  });

  it('webview fitBounds gate still requires bounds and no blocking camera state', () => {
    expect(nativeSource).toContain('if(!isOutOfRangeCameraHold && data.fitBounds && hasValidBounds && !data.navLocation');
  });

  it('emits Android diagnostics for tracing token changes and fit bounds execution', () => {
    expect(nativeSource).toContain('[RouteMap] fitCandidateBoundsToken changed to');
    expect(nativeSource).toContain('[RouteMap] Injecting JavaScript update (fitCandidateBounds=');
    expect(nativeSource).toContain('[RouteMap WebView] updateMap called, fitCandidateBounds=');
    expect(nativeSource).toContain('[RouteMap WebView] Calling fitBounds for candidate autofocus');
  });
});
