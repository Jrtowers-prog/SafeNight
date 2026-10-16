/**
 * RouteMap.native — MapLibre GL JS in a WebView.
 *
 * Uses MapTiler Streets vector style for 3D buildings, pitch, and bearing.
 */
import { useCallback, useEffect, useRef } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import {
  MAPTILER_STREETS_RASTER_STYLE,
  ROADMAP_STYLE,
} from "@/src/components/maps/mapConstants";
import type { RouteMapProps } from "@/src/components/maps/RouteMap.types";

// ---------------------------------------------------------------------------
// Build the HTML page that runs MapLibre GL JS inside the WebView
// ---------------------------------------------------------------------------

const buildMapHtml = (
  _mapType: string = "roadmap",
  showZoomControls: boolean = true,
) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
  <link href="https://unpkg.com/maplibre-gl@4/dist/maplibre-gl.css" rel="stylesheet"/>
  <script src="https://unpkg.com/maplibre-gl@4/dist/maplibre-gl.js"><\/script>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:100%;height:100%;overflow:hidden;background:#e8eaed}
    #map{width:100%;height:100%;position:absolute;top:0;left:0}
    .maplibregl-ctrl-group{border:none!important;box-shadow:0 6px 20px rgba(15,23,42,.25)!important;background:transparent!important}
    .maplibregl-ctrl-group button{width:72px!important;height:72px!important;line-height:72px!important;background:#ffffff!important;border:1px solid rgba(15,23,42,.18)!important;color:#0f172a!important}
    .maplibregl-ctrl-group button span{transform:scale(2)}
    .maplibregl-ctrl-top-left{margin-top:10px!important;margin-left:10px!important}

    .road-label{background:rgba(0,0,0,.7);color:#fff;padding:2px 8px;border-radius:9px;
      font-size:9px;font-weight:600;white-space:nowrap}
    .road-label-3d{background:rgba(20,30,50,.8);color:#fff;padding:4px 12px;border-radius:5px;
      font-size:12px;font-weight:700;white-space:nowrap;letter-spacing:0.5px;
      border:1px solid rgba(255,255,255,0.15);box-shadow:0 2px 8px rgba(0,0,0,.4);
      text-shadow:0 1px 3px rgba(0,0,0,.6)}
    .hazard-label{background:rgba(239,68,68,.9);color:#fff;padding:4px 12px;border-radius:5px;
      font-size:11px;font-weight:700;white-space:nowrap;letter-spacing:0.3px;
      border:1px solid rgba(255,255,255,0.2);box-shadow:0 2px 8px rgba(0,0,0,.4);
      text-shadow:0 1px 3px rgba(0,0,0,.5);animation:pulse 2s ease-in-out infinite}
    .search-pin-wrap{position:relative;display:block;width:28px;height:30px;pointer-events:auto;overflow:visible}
    .search-pin-dot{width:18px;height:18px;border-radius:50%;background:var(--pin-color,#ef4444);border:2px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,.35);position:absolute;left:50%;bottom:6px;transform:translateX(-50%) scale(1);transform-origin:50% 100%;transition:transform .16s ease,width .16s ease,height .16s ease}
    .search-pin-dot:after{content:'';position:absolute;left:50%;bottom:-7px;transform:translateX(-50%);width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:8px solid var(--pin-color,#ef4444);filter:drop-shadow(0 1px 1px rgba(0,0,0,.22))}
    .search-pin-label{position:absolute;left:50%;top:24px;transform:translateX(-50%);background:transparent;color:#0b1220;border:0;border-radius:0;padding:0;font-size:11px;font-weight:800;line-height:1.15;max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:none;text-shadow:-1px 0 rgba(255,255,255,.96),0 1px rgba(255,255,255,.96),1px 0 rgba(255,255,255,.96),0 -1px rgba(255,255,255,.96),0 0 2px rgba(255,255,255,.9)}
    .search-pin-wrap.selected{width:28px;height:30px}
    .search-pin-wrap.selected{pointer-events:auto}
    .search-pin-wrap.selected .search-pin-dot{width:24px;height:24px;border-width:3px;box-shadow:0 5px 16px rgba(0,0,0,.34);bottom:6px;transform:translateX(-50%) scale(1)}
    .search-pin-wrap.selected .search-pin-dot:after{bottom:-8px;border-left-width:6px;border-right-width:6px;border-top-width:9px}
    .search-pin-wrap.selected .search-pin-label{display:none}
    .search-pin-card{position:absolute;left:calc(100% + 6px);bottom:2px;margin-top:0;background:#ffffff;border:1px solid rgba(148,163,184,.35);border-radius:12px;padding:8px 10px;min-width:168px;max-width:min(260px,48vw);box-shadow:0 8px 20px rgba(2,6,23,.22);text-shadow:none}
    .search-pin-card-head{display:flex;align-items:flex-start;gap:8px}
    .search-pin-card-title{flex:1;font-size:13px;font-weight:800;color:#0f172a;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .search-pin-card-close{border:0;background:transparent;color:#98a2b3;font-size:16px;font-weight:700;line-height:1;padding:0;margin:0}
    .search-pin-card-close:active{opacity:.8}
    .search-pin-card-subtitle{margin-top:4px;font-size:11px;font-weight:500;color:#475467;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .search-pin-card-meta{margin-top:6px;font-size:11px;font-weight:600;color:#1570ef;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .search-pin-card-coords{margin-top:4px;font-size:11px;font-weight:500;color:#344054}
    .search-pin-card-actions{margin-top:8px;display:flex;justify-content:flex-end}
    .search-pin-card-btn{border:0;border-radius:8px;background:#1570ef;color:#ffffff;font-size:11px;font-weight:700;padding:6px 10px;cursor:pointer;line-height:1}
    .search-pin-card-btn:active{opacity:.9}
    .search-pin-label-anchor{position:relative;width:1px;height:1px;overflow:visible;pointer-events:none}
    .pin-size-mid .search-pin-dot{transform:translateX(-50%) scale(0.86)}
    .pin-size-mid .search-pin-wrap.selected .search-pin-dot{transform:translateX(-50%) scale(0.84)}
    .pin-size-far .search-pin-dot{transform:translateX(-50%) scale(0.7)}
    .pin-size-far .search-pin-wrap.selected .search-pin-dot{transform:translateX(-50%) scale(0.68)}
    .pin-size-far .search-pin-label{font-size:10px;max-width:120px}
    .pin-card-compact .search-pin-card{padding:7px 9px;min-width:152px;max-width:min(220px,46vw)}
    .pin-card-compact .search-pin-card-title{font-size:12px}
    .pin-card-compact .search-pin-card-subtitle,.pin-card-compact .search-pin-card-meta,.pin-card-compact .search-pin-card-coords{font-size:10px}
    .hide-selected-pin-cards .search-pin-wrap.selected .search-pin-card{display:none}
    .hide-pin-labels .search-pin-label-anchor .search-pin-label{display:none}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.7}}
    .friend-marker{display:flex;flex-direction:column;align-items:center;pointer-events:none}
    .friend-dot{width:32px;height:32px;border-radius:50%;background:#7C3AED;border:3px solid #fff;
      box-shadow:0 2px 8px rgba(124,58,237,.5);display:flex;align-items:center;justify-content:center}
    .friend-dot svg{width:18px;height:18px}
    .friend-label{margin-top:2px;background:rgba(124,58,237,.9);color:#fff;padding:2px 8px;
      border-radius:8px;font-size:10px;font-weight:700;white-space:nowrap;
      box-shadow:0 1px 4px rgba(0,0,0,.3);max-width:100px;overflow:hidden;text-overflow:ellipsis}
    .hide-pin-labels .friend-label{display:none}
    .maplibregl-ctrl-attrib{display:none!important}

    /* ─── Pathfinding visualisation animations ─── */
    @keyframes vizPulse{0%,100%{opacity:0.85}50%{opacity:0.4}}
    .viz-progress-bar{position:fixed;top:0;left:0;height:3px;background:linear-gradient(90deg,#7C3AED,#3b82f6,#06b6d4);
      z-index:9999;transition:width .3s ease;box-shadow:0 0 8px rgba(124,58,237,.6)}
    .viz-status{position:fixed;top:8px;left:50%;transform:translateX(-50%);display:none;
      background:rgba(15,15,30,.88);color:#e0e7ff;padding:6px 16px;border-radius:20px;
      font-size:11px;font-weight:600;z-index:9999;letter-spacing:.3px;white-space:nowrap;
      border:1px solid rgba(124,58,237,.4);box-shadow:0 2px 12px rgba(0,0,0,.4);
      backdrop-filter:blur(8px);transition:opacity .3s}
    /* Viz data point DOM-marker pins */
    @keyframes vizpin{from{transform:scale(0) translateY(3px);opacity:0}to{transform:scale(1);opacity:1}}
    .viz-data-pin{pointer-events:none;display:flex;align-items:center;justify-content:center;
      width:20px;height:20px;border-radius:50%;border:1.5px solid rgba(255,255,255,.75);
      font-size:11px;line-height:1;font-weight:700;box-shadow:0 2px 6px rgba(0,0,0,.4);
      animation:vizpin .3s ease-out forwards;z-index:10001}
    .viz-crime-pin{background:rgba(220,38,38,.85);color:#fff}
    .viz-light-pin{background:rgba(234,179,8,.9);color:#1a1000}
    .viz-place-pin{background:rgba(22,163,74,.85);color:#fff}
    /* Search zone overlay label */
    @keyframes vizscan{0%,100%{opacity:.95}50%{opacity:.45}}
    .viz-search-zone{pointer-events:none;background:rgba(88,28,235,.22);border:1.5px solid rgba(167,139,250,.7);
      border-radius:5px;padding:4px 12px;color:#ddd6fe;font-size:10px;font-weight:700;letter-spacing:.5px;
      white-space:nowrap;display:flex;align-items:center;gap:5px;
      animation:vizscan 1.8s ease-in-out infinite;backdrop-filter:blur(6px)}
  </style>
</head>
<body>
  <div id="map"></div>


  <script>
    /* ── State ─────────────────────────────────────────────── */
    var currentMarkers = [];
    var navMarkerObj = null;
    var hazardMarkers = [];
    var friendMarkerObjs = [];
    var isNavMode = false;
    var isPipMode = false;   // zooms out when in PiP
    var userInteracted = false;
    var isFollowingNav = true;
    var lastNavCenter = null;
    var lastNavHeading = 0;
    /** Last bearing value actually applied to the camera (for dead-zone check) */
    var lastCameraHeading = 0;
    var lastData = null;
    var styleReady = false;
    var longPressTimer = null;
    var lastOutOfRangeCueToken = 0;
    var outOfRangeBlinkTimers = [];
    var outOfRangeCameraHoldUntil = 0;
    var userCameraOverrideUntil = 0;
    /* Viz DOM marker tracking */
    var vizDataMarkers = [];
    var vizSearchLabelMarker = null;
    var longPressPoint = null;
    var touchMoved = false;
    var PIN_LABEL_MIN_ZOOM = 16.0;
    var isMapDragging = false;
    var lastMapDragAt = 0;
    var candidatePinLabelEntries = [];
    var pinLabelLayoutScheduler = null;
    var selectedCandidateCardMarker = null;
    var selectedCandidateCardData = null;
    var selectedCandidateCardVisibilityScheduler = null;

    // Prefer close-to-pin placement first; only use wider offsets when overlap requires it.
    var pinLabelOffsetCandidates = [
      { x: 0, y: -34 },
      { x: 0, y: 30 },
      { x: 50, y: -6 },
      { x: -50, y: -6 },
      { x: 38, y: -30 },
      { x: -38, y: -30 },
      { x: 38, y: 28 },
      { x: -38, y: 28 },
      // Maximum spread fallback (existing max distance behavior)
      { x: 0, y: -50 },
      { x: 0, y: 45 },
      { x: 70, y: -10 },
      { x: -70, y: -10 },
      { x: 50, y: -40 },
      { x: -50, y: -40 },
      { x: 50, y: 40 },
      { x: -50, y: 40 }
    ];

    function rectsOverlap(r1, r2, minGap){
      var gap = typeof minGap === 'number' ? minGap : 3;
      return !(r1.right + gap < r2.left || r2.right + gap < r1.left || r1.bottom + gap < r2.top || r2.bottom + gap < r1.top);
    }

    function rectInsideViewport(rect, margin){
      var m = typeof margin === 'number' ? margin : 2;
      var winW = window.innerWidth || 0;
      var winH = window.innerHeight || 0;
      return rect.left >= m && rect.right <= winW - m && rect.top >= m && rect.bottom <= winH - m;
    }

    function layoutCandidatePinLabels(){
      if(!map || !candidatePinLabelEntries.length) return;
      if(map.getZoom() < PIN_LABEL_MIN_ZOOM) return;

      var entries = candidatePinLabelEntries.slice().sort(function(a, b){
        if(Math.abs(a.lat - b.lat) > 0.00001) return b.lat - a.lat;
        if(Math.abs(a.lng - b.lng) > 0.00001) return a.lng - b.lng;
        return String(a.id || '').localeCompare(String(b.id || ''));
      });

      var placedRects = [];
      var unresolved = false;

      entries.forEach(function(entry){
        var labelEl = entry && entry.labelEl;
        if(!labelEl || !labelEl.parentElement) return;

        labelEl.parentElement.style.display = '';
        labelEl.style.display = '';

        var placed = false;
        for(var i=0;i<pinLabelOffsetCandidates.length;i++){
          var offset = pinLabelOffsetCandidates[i];
          labelEl.style.left = offset.x + 'px';
          labelEl.style.top = offset.y + 'px';
          labelEl.style.transform = 'translateX(-50%)';

          var rect = labelEl.getBoundingClientRect();
          var testRect = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
          if(!rectInsideViewport(testRect, 2)) continue;

          var collides = placedRects.some(function(pr){ return rectsOverlap(testRect, pr, 3); });
          if(collides) continue;

          placedRects.push(testRect);
          placed = true;
          break;
        }

        if(!placed) unresolved = true;
      });

      if(unresolved && entries.length >= 2){
        entries.forEach(function(entry){
          if(entry && entry.labelEl && entry.labelEl.parentElement){
            entry.labelEl.parentElement.style.display = 'none';
          }
        });
      }
    }

    function schedulePinLabelLayout(){
      if(!map) return;
      if(pinLabelLayoutScheduler) clearTimeout(pinLabelLayoutScheduler);
      pinLabelLayoutScheduler = setTimeout(function(){
        pinLabelLayoutScheduler = null;
        requestAnimationFrame(layoutCandidatePinLabels);
      }, 70);
    }

    function rectContainsPoint(rect, pointX, pointY){
      return pointX >= rect.left && pointX <= rect.right && pointY >= rect.top && pointY <= rect.bottom;
    }

    function updateSelectedCandidateCardVisibility(){
      if(!map || !selectedCandidateCardMarker || !selectedCandidateCardData) return;

      var markerEl = selectedCandidateCardMarker.getElement ? selectedCandidateCardMarker.getElement() : null;
      if(!markerEl) return;

      var cardEl = markerEl.querySelector('.search-pin-card');
      if(!cardEl) return;

      var rect = cardEl.getBoundingClientRect();
      if(!rect || !isFinite(rect.left) || !isFinite(rect.top)) return;

      var overlapCount = 0;
      var markers = (lastData && lastData.safetyMarkers) ? lastData.safetyMarkers : [];
      for(var i=0;i<markers.length;i++){
        var m = markers[i];
        if(!m) continue;
        if(selectedCandidateCardData.id && m.id === selectedCandidateCardData.id) continue;
        if(typeof m.lng !== 'number' || typeof m.lat !== 'number') continue;

        try{
          var point = map.project([m.lng, m.lat]);
          if(rectContainsPoint(rect, point.x, point.y)){
            overlapCount += 1;
            if(overlapCount > 3) break;
          }
        }catch(e){}
      }

      cardEl.style.display = overlapCount > 3 ? 'none' : 'block';
    }

    function scheduleSelectedCandidateCardVisibility(){
      if(!map || !selectedCandidateCardMarker) return;
      if(selectedCandidateCardVisibilityScheduler) clearTimeout(selectedCandidateCardVisibilityScheduler);
      selectedCandidateCardVisibilityScheduler = setTimeout(function(){
        selectedCandidateCardVisibilityScheduler = null;
        requestAnimationFrame(updateSelectedCandidateCardVisibility);
      }, 50);
    }

    function shouldIgnoreMarkerSelection(){
      if(isMapDragging) return true;
      return Date.now() - lastMapDragAt < 220;
    }

    function updatePinLabelVisibility(){
      if(!map || !document.body) return;
      var zoom = map.getZoom();
      var shouldHide = zoom < PIN_LABEL_MIN_ZOOM;
      if(shouldHide) document.body.classList.add('hide-pin-labels');
      else document.body.classList.remove('hide-pin-labels');

      document.body.classList.remove('pin-size-near','pin-size-mid','pin-size-far');
      if(zoom < 11.8) document.body.classList.add('pin-size-far');
      else if(zoom < 14.8) document.body.classList.add('pin-size-mid');
      else document.body.classList.add('pin-size-near');

      if(zoom < 14.2) document.body.classList.add('hide-selected-pin-cards');
      else document.body.classList.remove('hide-selected-pin-cards');
      if(zoom < 15.2) document.body.classList.add('pin-card-compact');
      else document.body.classList.remove('pin-card-compact');
    }

    var emptyFC = { type: 'FeatureCollection', features: [] };

    function clearMarkerArray(arr) { arr.forEach(function(m){m.remove()}); arr.length=0; }
    function sendMsg(t, d) { try { window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({type:t},d||{}))); } catch(e){} }
    function safeLabel(text){
      return String(text||'')
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/\"/g,'&quot;')
        .replace(/'/g,'&#39;');
    }

    function normalizePinColor(color){
      var value = String(color || '').trim();
      if(/^#[0-9a-fA-F]{6}$/.test(value) || /^#[0-9a-fA-F]{3}$/.test(value)){
        return value;
      }
      return '#ef4444';
    }

    function createViewportMarker(options){
      var marker = new maplibregl.Marker(Object.assign({
        pitchAlignment: 'viewport',
        rotationAlignment: 'viewport'
      }, options || {}));
      if(marker.setSubpixelPositioning){
        marker.setSubpixelPositioning(true);
      }
      return marker;
    }

    function setFollowMode(next){
      if (isFollowingNav === next) return;
      isFollowingNav = next;
      sendMsg('navFollowChanged', { isFollowing: next });
    }

    function markUserCameraOverride(){
      // Keep manual override short so filter/findings auto-refits are responsive on phone.
      userCameraOverrideUntil = Date.now() + 1200;
      sendMsg('userInteracted', {});
      if(isNavMode){
        userInteracted = true;
        setFollowMode(false);
      }
    }

    function clearOutOfRangeBlink(){
      while(outOfRangeBlinkTimers.length){
        clearTimeout(outOfRangeBlinkTimers.pop());
      }
      if(!styleReady) return;
      try{
        map.setPaintProperty('range-circle-fill', 'fill-color', '#22c55e');
        map.setPaintProperty('range-circle-fill', 'fill-opacity', 0.04);
        map.setPaintProperty('range-circle-line', 'line-color', '#22c55e');
        map.setPaintProperty('range-circle-line', 'line-opacity', 0.8);
      }catch(e){}
    }

    function setOutOfRangeBlinkStyle(red){
      if(!styleReady) return;
      try{
        if(red){
          map.setPaintProperty('range-circle-fill', 'fill-color', '#ef4444');
          map.setPaintProperty('range-circle-fill', 'fill-opacity', 0.12);
          map.setPaintProperty('range-circle-line', 'line-color', '#ef4444');
          map.setPaintProperty('range-circle-line', 'line-opacity', 0.95);
        }else{
          map.setPaintProperty('range-circle-fill', 'fill-color', '#22c55e');
          map.setPaintProperty('range-circle-fill', 'fill-opacity', 0.04);
          map.setPaintProperty('range-circle-line', 'line-color', '#22c55e');
          map.setPaintProperty('range-circle-line', 'line-opacity', 0.8);
        }
      }catch(e){}
    }

    function triggerOutOfRangeCue(data){
      if(!data || !data.origin || !data.maxDistanceKm) return false;

      // Hold camera updates briefly so regular fit/pan updates cannot override this cue.
      outOfRangeCameraHoldUntil = Date.now() + 2200;

      clearOutOfRangeBlink();

      // Ensure the range ring exists before blinking.
      var cf = makeCirclePolygon(data.origin.lng, data.origin.lat, data.maxDistanceKm, 64);
      map.getSource('range-circle').setData({type:'FeatureCollection',features:[cf]});

      var center = data.navLocation || data.origin;
      var radiusKm = Math.max(1, Number(data.maxDistanceKm || 0));
      var latRadiusDeg = (radiusKm * 1.15) / 111.32;
      var lngRadiusDeg = latRadiusDeg / Math.max(0.25, Math.cos((center.lat || 0) * Math.PI / 180));
      var cueBounds = [
        [center.lng - lngRadiusDeg, center.lat - latRadiusDeg],
        [center.lng + lngRadiusDeg, center.lat + latRadiusDeg],
      ];
      try{
        map.fitBounds(cueBounds, {
          padding: { top: 84, right: 72, bottom: 84, left: 72 },
          maxZoom: 12.5,
          duration: 900,
        });
      }catch(e){
        map.easeTo({center:[center.lng,center.lat],zoom:12,duration:900});
      }

      var blinkStarted = false;
      var startBlink = function(){
        if(blinkStarted) return;
        blinkStarted = true;
        setOutOfRangeBlinkStyle(true);
        outOfRangeBlinkTimers.push(setTimeout(function(){ setOutOfRangeBlinkStyle(false); }, 180));
        outOfRangeBlinkTimers.push(setTimeout(function(){ setOutOfRangeBlinkStyle(true); }, 360));
        outOfRangeBlinkTimers.push(setTimeout(function(){ setOutOfRangeBlinkStyle(false); }, 540));
      };

      map.once('moveend', function(){
        outOfRangeBlinkTimers.push(setTimeout(startBlink, 500));
      });
      outOfRangeBlinkTimers.push(setTimeout(startBlink, 1300));
      return true;
    }

    /* ── Styles ─────────── */
    var mapStyles = { roadmap: ${JSON.stringify(ROADMAP_STYLE)} };
    var roadmapRasterFallbackStyle = ${JSON.stringify(MAPTILER_STREETS_RASTER_STYLE)};
    var usedRasterFallback = false;

    /* ── Init MapLibre ─────────────────────────────────────── */
    var map = new maplibregl.Map({
      container: 'map',
      style: mapStyles.roadmap,
      center: [-0.1278, 51.5074],
      zoom: 13,
      pitch: 0,
      bearing: 0,
      maxPitch: 70,
      antialias: true,
      fadeDuration: 250,
      attributionControl: false,
    });

    ${showZoomControls ? `
    try {
      map.addControl(new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }), 'top-left');
    } catch (e) {}
    ` : ""}

    // Faster zoom responsiveness for wheel and pinch interactions.
    try {
      if (map.scrollZoom && map.scrollZoom.setWheelZoomRate) {
        map.scrollZoom.setWheelZoomRate(1 / 120);
      }
      if (map.scrollZoom && map.scrollZoom.setZoomRate) {
        map.scrollZoom.setZoomRate(1 / 22);
      }
      if (map.touchZoomRotate && map.touchZoomRotate.setZoomRate) {
        map.touchZoomRotate.setZoomRate(1 / 16);
      }
    } catch (e) {}

    // Disable rotation in normal mode (enable only in nav mode)
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();

    /* ── Sources & Layers ──────────────────────────────────── */
    function addCustomSources() {
      if (map.getSource('unselected-routes')) return;
      map.addSource('unselected-routes', { type:'geojson', data:emptyFC });
      map.addSource('route-traversed', { type:'geojson', data:emptyFC });
      map.addSource('route-segments', { type:'geojson', data:emptyFC });
      map.addSource('route-remaining', { type:'geojson', data:emptyFC });
      map.addSource('safety-markers', { type:'geojson', data:emptyFC });
      map.addSource('range-circle', { type:'geojson', data:emptyFC });
      map.addSource('friend-paths', { type:'geojson', data:emptyFC });
      map.addSource('friend-planned-routes', { type:'geojson', data:emptyFC });

      /* Visualisation sources */
      map.addSource('viz-bbox', { type:'geojson', data:emptyFC });
      map.addSource('viz-corridor', { type:'geojson', data:emptyFC });
      map.addSource('viz-lights', { type:'geojson', data:emptyFC });
      map.addSource('viz-cctv', { type:'geojson', data:emptyFC });
      map.addSource('viz-crimes', { type:'geojson', data:emptyFC });
      map.addSource('viz-places', { type:'geojson', data:emptyFC });
      map.addSource('viz-transit', { type:'geojson', data:emptyFC });
      map.addSource('viz-roads', { type:'geojson', data:emptyFC });
      map.addSource('viz-scoring', { type:'geojson', data:emptyFC });
      map.addSource('viz-routes', { type:'geojson', data:emptyFC });
    }

    function addCustomLayers() {
      map.addLayer({ id:'range-circle-fill', type:'fill', source:'range-circle',
        paint:{'fill-color':'#22c55e','fill-opacity':0.04} });
      map.addLayer({ id:'range-circle-line', type:'line', source:'range-circle',
        layout:{'line-cap':'round','line-join':'round'},
        paint:{'line-color':'#22c55e','line-opacity':0.8,'line-width':2.5,'line-dasharray':[3,2]} });
      map.addLayer({ id:'unselected-routes-line', type:'line', source:'unselected-routes',
        layout:{'line-cap':'round','line-join':'round'},
        paint:{'line-color':'#98a2b3','line-opacity':0.5,'line-width':5} });
      map.addLayer({ id:'route-traversed-line', type:'line', source:'route-traversed',
        layout:{'line-cap':'round','line-join':'round'},
        paint:{'line-color':'#1D2939','line-opacity':0.7,'line-width':7} });
      map.addLayer({ id:'route-segments-line', type:'line', source:'route-segments',
        layout:{'line-cap':'round','line-join':'round'},
        paint:{'line-color':['get','color'],'line-opacity':0.9,'line-width':7} });
      map.addLayer({ id:'route-remaining-line', type:'line', source:'route-remaining',
        layout:{'line-cap':'round','line-join':'round'},
        paint:{'line-color':'#4285F4','line-opacity':0.85,'line-width':6} });
      map.addLayer({ id:'safety-circles-halo', type:'circle', source:'safety-markers',
        paint:{'circle-radius':['interpolate',['linear'],['zoom'],5,['case',['==',['get','isSelected'],1],16,['==',['get','kind'],'via'],15,['==',['get','kind'],'search_candidate'],13,10],
          11,['case',['==',['get','isSelected'],1],15,['==',['get','kind'],'via'],14,['==',['get','kind'],'search_candidate'],12,9],
          16,['case',['==',['get','isSelected'],1],14,['==',['get','kind'],'via'],13,['==',['get','kind'],'search_candidate'],11,8]],
          'circle-color':['get','color'],'circle-opacity':0.24} });
      map.addLayer({ id:'safety-circles', type:'circle', source:'safety-markers',
        paint:{'circle-radius':['interpolate',['linear'],['zoom'],5,['case',['==',['get','isSelected'],1],12,['==',['get','kind'],'via'],11,['==',['get','kind'],'search_candidate'],10,7],
          11,['case',['==',['get','isSelected'],1],11,['==',['get','kind'],'via'],10,['==',['get','kind'],'search_candidate'],9,6],
          16,['case',['==',['get','isSelected'],1],10,['==',['get','kind'],'via'],9,['==',['get','kind'],'search_candidate'],8,5]],
          'circle-color':['get','color'],'circle-opacity':0.95,
          'circle-stroke-color':'#fff','circle-stroke-width':['interpolate',['linear'],['zoom'],5,['case',['==',['get','isSelected'],1],2.75,['==',['get','kind'],'via'],2.5,['==',['get','kind'],'search_candidate'],2.25,1.5],
          11,['case',['==',['get','isSelected'],1],2.5,['==',['get','kind'],'via'],2.25,['==',['get','kind'],'search_candidate'],2,1.35],
          16,['case',['==',['get','isSelected'],1],2.25,['==',['get','kind'],'via'],2,['==',['get','kind'],'search_candidate'],1.75,1.25]]} });
      map.addLayer({ id:'friend-paths-line', type:'line', source:'friend-paths',
        layout:{'line-cap':'round','line-join':'round'},
        paint:{'line-color':['get','color'],'line-opacity':0.9,'line-width':5} });
      map.addLayer({ id:'friend-planned-routes-line', type:'line', source:'friend-planned-routes',
        layout:{'line-cap':'round','line-join':'round'},
        paint:{'line-color':'#7C3AED','line-opacity':0.45,'line-width':5,'line-dasharray':[4,3]} });

      // Click unselected route to select it
      map.on('click','unselected-routes-line',function(e){
        if(e.features&&e.features[0]) sendMsg('selectRoute',{id:e.features[0].properties.routeId});
      });
      map.on('click','safety-circles',function(e){
        if(e.features&&e.features[0]&&e.features[0].properties&&e.features[0].properties.id){
          if(shouldIgnoreMarkerSelection()) return;
          sendMsg('selectMarker',{id:e.features[0].properties.id});
        }
      });
      map.on('mouseenter','unselected-routes-line',function(){map.getCanvas().style.cursor='pointer'});
      map.on('mouseleave','unselected-routes-line',function(){map.getCanvas().style.cursor=''});
      map.on('mouseenter','safety-circles',function(){map.getCanvas().style.cursor='pointer'});
      map.on('mouseleave','safety-circles',function(){map.getCanvas().style.cursor=''});

      /* ── Visualisation layers (rendered below route layers) ── */
      // Bounding box — solid bright border + subtle fill
      map.addLayer({ id:'viz-bbox-fill', type:'fill', source:'viz-bbox',
        paint:{'fill-color':['get','color'],'fill-opacity':0.08} });
      map.addLayer({ id:'viz-bbox-line', type:'line', source:'viz-bbox',
        paint:{'line-color':'#a855f7','line-opacity':0.9,'line-width':2.5} });

      // Road network edges
      map.addLayer({ id:'viz-roads-line', type:'line', source:'viz-roads',
        layout:{'line-cap':'round','line-join':'round'},
        paint:{'line-color':'#6366f1','line-opacity':0.25,'line-width':1.5} });

      // Corridor / exploration path
      map.addLayer({ id:'viz-corridor-line', type:'line', source:'viz-corridor',
        layout:{'line-cap':'round','line-join':'round'},
        paint:{'line-color':'#f59e0b','line-opacity':0.9,'line-width':3,'line-dasharray':[4,1.5]} });

      // Safety scoring — colour-coded edges
      map.addLayer({ id:'viz-scoring-line', type:'line', source:'viz-scoring',
        layout:{'line-cap':'round','line-join':'round'},
        paint:{'line-color':['get','color'],'line-opacity':0.8,'line-width':3} });

      // Route candidates
      map.addLayer({ id:'viz-routes-line', type:'line', source:'viz-routes',
        layout:{'line-cap':'round','line-join':'round'},
        paint:{'line-color':['get','color'],'line-opacity':0.7,'line-width':5} });
    }

    function resolveBuildingSource() {
      var style = map.getStyle();
      if (!style || !style.layers) return null;
      for (var i = 0; i < style.layers.length; i++) {
        var layer = style.layers[i];
        if (layer && layer.source && layer['source-layer'] === 'building') {
          return { source: layer.source, sourceLayer: 'building' };
        }
      }
      var hasOpenMapTilesSource = style.sources && style.sources.openmaptiles;
      if (hasOpenMapTilesSource) return { source: 'openmaptiles', sourceLayer: 'building' };
      return null;
    }

    function add3DBuildings() {
      try {
        if (map.getLayer('3d-buildings')) return;
        var buildingSource = resolveBuildingSource();
        if (!buildingSource) return;

        // Find first symbol layer for insertion point
        var layers = map.getStyle().layers || [];
        var labelId;
        for(var i=0;i<layers.length;i++){
          if(layers[i].type==='symbol'&&layers[i].layout&&layers[i].layout['text-field']){labelId=layers[i].id;break}
        }
        map.addLayer({
          id:'3d-buildings', source:buildingSource.source, 'source-layer':buildingSource.sourceLayer,
          type:'fill-extrusion', minzoom:14,
          paint:{
            'fill-extrusion-color':['interpolate',['linear'],['zoom'],14,'#ddd8d0',16.5,'#c8c3bb'],
            'fill-extrusion-height':['interpolate',['linear'],['zoom'],14,0,14.5,['coalesce',['get','render_height'],8]],
            'fill-extrusion-base':['interpolate',['linear'],['zoom'],14,0,14.5,['coalesce',['get','render_min_height'],0]],
            'fill-extrusion-opacity':['interpolate',['linear'],['zoom'],14,0,14.5,0.7,18,0.85],
          }
        },labelId);
      } catch(e){}
    }

    /* ── Map load ──────────────────────────────────────────── */
    map.on('load',function(){
      styleReady = true;
      addCustomSources();
      addCustomLayers();
      add3DBuildings();
      updatePinLabelVisibility();
      sendMsg('ready',{});
    });

    map.on('error', function(e) {
      var err = (e && e.error && e.error.message) ? String(e.error.message) : 'Map render error';
      if (!styleReady && !usedRasterFallback) {
        usedRasterFallback = true;
        styleReady = false;
        try { map.setStyle(roadmapRasterFallbackStyle); } catch (_e) {}
        return;
      }
      sendMsg('styleError', { message: err });
    });

    /* ── Click / Long-press events ─────────────────────────── */
    map.on('click',function(e){
      // Don't fire on route-click (already handled above)
      var features = map.queryRenderedFeatures(e.point,{layers:['unselected-routes-line','safety-circles']});
      if(features.length>0) return;
      sendMsg('press',{lat:e.lngLat.lat,lng:e.lngLat.lng});
    });
    map.on('contextmenu',function(e){
      sendMsg('longpress',{lat:e.lngLat.lat,lng:e.lngLat.lng});
    });

    // Touch-based long-press (single finger only)
    var mapEl = document.getElementById('map');
    function cancelLongPress(){
      if(longPressTimer){clearTimeout(longPressTimer);longPressTimer=null}
      longPressPoint=null;
    }
    mapEl.addEventListener('touchstart',function(e){
      markUserCameraOverride();
      touchMoved=false;
      // Only start long-press detection on single-finger touch
      if(e.touches.length===1){
        var t=e.touches[0];
        longPressPoint = {x:t.clientX, y:t.clientY};
        longPressTimer = setTimeout(function(){
          if(!touchMoved&&longPressPoint){
            var rect=map.getCanvas().getBoundingClientRect();
            var pt=map.unproject([longPressPoint.x-rect.left, longPressPoint.y-rect.top]);
            sendMsg('longpress',{lat:pt.lat,lng:pt.lng});
          }
          longPressTimer=null;
        },600);
      } else {
        // Multi-touch (pinch/zoom) — cancel any pending long-press immediately
        cancelLongPress();
      }
    },{passive:true});
    mapEl.addEventListener('touchmove',function(e){
      // Cancel long-press if a second finger appears or finger moves too far
      if(e.touches.length>1){ cancelLongPress(); return; }
      if(longPressPoint&&e.touches.length===1){
        var dx=e.touches[0].clientX-longPressPoint.x, dy=e.touches[0].clientY-longPressPoint.y;
        if(Math.sqrt(dx*dx+dy*dy)>10){touchMoved=true;cancelLongPress()}
      }
    },{passive:true});
    mapEl.addEventListener('touchend',function(){cancelLongPress()},{passive:true});
    mapEl.addEventListener('touchcancel',function(){cancelLongPress()},{passive:true});

    /* ── Drag tracking ────────────────────────────────────────── */
    map.on('dragstart',function(){
      isMapDragging = true;
      markUserCameraOverride();
    });

    map.on('dragend', function(){
      isMapDragging = false;
      lastMapDragAt = Date.now();
      try {
        var center = map.getCenter();
        sendMsg('mapCenterChanged', { lat: center.lat, lng: center.lng });
      } catch (e) {}
      schedulePinLabelLayout();
    });

    map.on('zoomstart',function(e){
      if(e && e.originalEvent){
        markUserCameraOverride();
      }
    });

    map.on('zoom', function(){
      updatePinLabelVisibility();
      schedulePinLabelLayout();
      scheduleSelectedCandidateCardVisibility();
    });
    map.on('moveend', function(){
      schedulePinLabelLayout();
      scheduleSelectedCandidateCardVisibility();
    });
    window.addEventListener('resize', function(){
      schedulePinLabelLayout();
      scheduleSelectedCandidateCardVisibility();
    });
    window.addEventListener('orientationchange', function(){
      schedulePinLabelLayout();
      scheduleSelectedCandidateCardVisibility();
    });

    window.recenterNavigation = function(){
      userInteracted = false;
      setFollowMode(true);
      if(lastNavCenter && isNavMode){
        var navZoom = isPipMode ? 15 : 17;
        lastCameraHeading = lastNavHeading;
        map.easeTo({
          center:lastNavCenter,
          zoom:Math.max(map.getZoom(), navZoom),
          pitch:0,
          bearing:lastNavHeading,
          duration:250,
        });
      }
    };

    /* ── Dedicated PiP setter — called directly from RN for zero-lag zoom ── */
    window.setPipMode = function(pip){
      var entering = !!pip;
      if(entering === isPipMode) return;
      isPipMode = entering;

      // Always hide interactive controls when entering PiP
      var ctrl = document.getElementById('mapCtrl');
      if(ctrl) ctrl.style.display = isPipMode ? 'none' : (isNavMode ? 'none' : 'flex');

      // Force resize detection and auto-recenter immediately
      map.resize();
      if(lastNavCenter && isNavMode){
        userInteracted = false;
        var tz = isPipMode ? 15 : 17;
        map.jumpTo({center:lastNavCenter, zoom:tz, pitch:0, bearing:lastNavHeading});
      }
    };

    /* ── Re-anchor camera immediately on any container resize ── */
    /* Handles PiP window resize (user dragging pip edge) and activity transitions. */
    map.on('resize', function(){
      if(isNavMode && lastNavCenter && !userInteracted){
        var rz = isPipMode ? 15 : 17;
        // jumpTo = instant, no animation artefacts during resize
        map.jumpTo({center:lastNavCenter, zoom:Math.max(map.getZoom(), rz), bearing:lastNavHeading, pitch:0});
      }
    });

    /* ── Helpers ────────────────────────────────────────────── */
    function nearestIdx(path,pt){
      var best=0,bestD=1e18;
      for(var i=0;i<path.length;i++){
        var dl=path[i].lat-pt.lat,dn=path[i].lng-pt.lng,d=dl*dl+dn*dn;
        if(d<bestD){bestD=d;best=i}
      }
      return best;
    }

    /* Haversine distance in metres between two {lat,lng} points */
    function haversineM(a,b){
      var R=6371000,dLat=(b.lat-a.lat)*Math.PI/180,dLng=(b.lng-a.lng)*Math.PI/180;
      var sa=Math.sin(dLat/2),sb=Math.sin(dLng/2);
      return 2*R*Math.asin(Math.sqrt(sa*sa+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*sb*sb));
    }
    /* Distance from point p to segment a→b in metres */
    function distToSegM(p,a,b){
      var dx=b.lng-a.lng,dy=b.lat-a.lat,lenSq=dx*dx+dy*dy;
      if(lenSq===0) return haversineM(p,a);
      var t=Math.max(0,Math.min(1,((p.lng-a.lng)*dx+(p.lat-a.lat)*dy)/lenSq));
      return haversineM(p,{lat:a.lat+t*dy,lng:a.lng+t*dx});
    }
    /* Returns true if point p is within thresholdM metres of any segment in routePath */
    function isPointOnRoute(p,routePath,thresholdM){
      if(!routePath||routePath.length<2) return false;
      for(var i=0;i<routePath.length-1;i++){
        if(distToSegM(p,routePath[i],routePath[i+1])<=thresholdM) return true;
      }
      return false;
    }
    function extBounds(b,c){
      if(!b) return [[c[0],c[1]],[c[0],c[1]]];
      return [[Math.min(b[0][0],c[0]),Math.min(b[0][1],c[1])],[Math.max(b[1][0],c[0]),Math.max(b[1][1],c[1])]];
    }

    function hasFiniteLngLat(lng,lat){
      return Number.isFinite(Number(lng)) && Number.isFinite(Number(lat));
    }

    function makeCirclePolygon(centerLng,centerLat,radiusKm,steps){
      steps=steps||64;
      var coords=[];
      var R=6371;
      for(var i=0;i<=steps;i++){
        var angle=2*Math.PI*i/steps;
        var lat2=Math.asin(Math.sin(centerLat*Math.PI/180)*Math.cos(radiusKm/R)+Math.cos(centerLat*Math.PI/180)*Math.sin(radiusKm/R)*Math.cos(angle));
        var lng2=(centerLng*Math.PI/180)+Math.atan2(Math.sin(angle)*Math.sin(radiusKm/R)*Math.cos(centerLat*Math.PI/180),Math.cos(radiusKm/R)-Math.sin(centerLat*Math.PI/180)*Math.sin(lat2));
        coords.push([lng2*180/Math.PI,lat2*180/Math.PI]);
      }
      return {type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[coords]}};
    }

    /* ── Main update (called from RN) ──────────────────────── */
    function updateMap(data){
      if(!styleReady) return;
      if(data && data.fitCandidateBounds){
        console.log('[RouteMap WebView] updateMap called, fitCandidateBounds=', data.fitCandidateBounds);
      }
      var londonCenter = [-0.1278, 51.5074];
      var hasPinpoint = Boolean(data.origin || data.navLocation);
      var focusCandidatesOnly = !!data.fitCandidateBounds;
      lastData = data;
      isPipMode = !!(data.isInPipMode);

      // Ensure controls reflect PiP state immediately
      var ctrl = document.getElementById('mapCtrl');
      if(ctrl) ctrl.style.display = (isPipMode || isNavMode) ? 'none' : 'flex';

      selectedCandidateCardMarker = null;
      selectedCandidateCardData = null;
      clearMarkerArray(currentMarkers);
      candidatePinLabelEntries = [];
      var bounds = null;

      /* — Origin marker (blue dot) — hidden during nav — */
      if(data.origin && !data.navLocation && hasFiniteLngLat(data.origin.lng,data.origin.lat)){
        var oe=document.createElement('div');
        oe.innerHTML='<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#4285F4" stroke="white" stroke-width="3"/><circle cx="12" cy="12" r="3" fill="white"/></svg>';
        currentMarkers.push(createViewportMarker({element:oe,anchor:'center'}).setLngLat([data.origin.lng,data.origin.lat]).addTo(map));
        if(data.fitCandidateBounds || !focusCandidatesOnly){
          bounds=extBounds(bounds,[data.origin.lng,data.origin.lat]);
        }
      }

      /* — Destination marker (red pin) — */
      if(data.destination && hasFiniteLngLat(data.destination.lng,data.destination.lat)){
        var de=document.createElement('div');
        de.innerHTML='<svg width="28" height="40" viewBox="0 0 28 40"><path d="M14 0C6.3 0 0 6.3 0 14c0 10.5 14 26 14 26s14-15.5 14-26C28 6.3 21.7 0 14 0z" fill="#ef4444" stroke="white" stroke-width="1.5"/><circle cx="14" cy="14" r="5" fill="white"/></svg>';
        currentMarkers.push(createViewportMarker({element:de,anchor:'bottom'}).setLngLat([data.destination.lng,data.destination.lat]).addTo(map));
        if(!focusCandidatesOnly){
          bounds=extBounds(bounds,[data.destination.lng,data.destination.lat]);
        }
      }

      /* — Unselected routes (grey, clickable) — */
      var unselF=[];
      (data.routes||[]).forEach(function(r){
        if(r.selected) return;
        var coords=r.path.map(function(p){return[p.lng,p.lat]});
        unselF.push({type:'Feature',properties:{routeId:r.id},geometry:{type:'LineString',coordinates:coords}});
        if(!focusCandidatesOnly){
          coords.forEach(function(c){bounds=extBounds(bounds,c)});
        }
      });
      map.getSource('unselected-routes').setData({type:'FeatureCollection',features:unselF});

      /* — Selected route — */
      var sel=(data.routes||[]).find(function(r){return r.selected});
      var travF=[], segF=[], remF=[];

      if(sel){
        if(data.navLocation && sel.path.length>1){
          var navPt=[data.navLocation.lng,data.navLocation.lat];
          var splitIdx=nearestIdx(sel.path,data.navLocation);

          // Traversed portion
          if(splitIdx>0){
            var tp=[];
            for(var ti=0;ti<=splitIdx;ti++) tp.push([sel.path[ti].lng,sel.path[ti].lat]);
            tp.push(navPt);
            travF.push({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:tp}});
          }
          // Remaining: segments or plain
          if(data.segments&&data.segments.length>0){
            data.segments.forEach(function(seg){
              var fp=[],started=false;
              for(var si=0;si<seg.path.length;si++){
                var sp=seg.path[si];
                if(!started){var spIdx=nearestIdx(sel.path,sp);if(spIdx>=splitIdx)started=true}
                if(started) fp.push([sp.lng,sp.lat]);
              }
              if(fp.length>=2) segF.push({type:'Feature',properties:{color:seg.color},geometry:{type:'LineString',coordinates:fp}});
            });
          } else {
            var rc=[navPt];
            for(var ri=splitIdx;ri<sel.path.length;ri++) rc.push([sel.path[ri].lng,sel.path[ri].lat]);
            remF.push({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:rc}});
          }
        } else {
          // Not navigating
          if(data.segments&&data.segments.length>0){
            data.segments.forEach(function(seg){
              var sc=seg.path.map(function(p){return[p.lng,p.lat]});
              segF.push({type:'Feature',properties:{color:seg.color},geometry:{type:'LineString',coordinates:sc}});
            });
          } else {
            var sc2=sel.path.map(function(p){return[p.lng,p.lat]});
            remF.push({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:sc2}});
          }
        }
        if(!focusCandidatesOnly){
          sel.path.forEach(function(p){bounds=extBounds(bounds,[p.lng,p.lat])});
        }
      }

      map.getSource('route-traversed').setData({type:'FeatureCollection',features:travF});
      map.getSource('route-segments').setData({type:'FeatureCollection',features:segF});
      map.getSource('route-remaining').setData({type:'FeatureCollection',features:remF});

      /* — Safety markers — */
      var mColors={crime:'#ef4444',shop:'#22c55e',light:'#facc15',bus_stop:'#3b82f6',cctv:'#8b5cf6',dead_end:'#f97316',via:'#d946ef'};
      var selectedCandidate = null;
      var smF=(data.safetyMarkers||[]).flatMap(function(m){
        if(!hasFiniteLngLat(m.lng,m.lat)){
          return [];
        }
        var isCandidate = m.id && String(m.id).indexOf('search-candidate:')===0;
        if(isCandidate){
          var isSelectedCandidate = !!m.isSelected;
          var candidateColor = normalizePinColor(m.pinColor);
          if(isSelectedCandidate && !selectedCandidate){
            selectedCandidate = m;
          }

          if(data.fitCandidateBounds){
            bounds=extBounds(bounds,[m.lng,m.lat]);
          }
          return [{type:'Feature',properties:{id:m.id||'',kind:'search_candidate',label:m.label||'candidate',color:candidateColor,isSelected:isSelectedCandidate ? 1 : 0},
            geometry:{type:'Point',coordinates:[m.lng,m.lat]}}];
        }

        if(data.fitCandidateBounds){
          bounds=extBounds(bounds,[m.lng,m.lat]);
        }
        return [{type:'Feature',properties:{id:m.id||'',kind:m.kind,label:m.label||m.kind,color:mColors[m.kind]||'#94a3b8',isSelected:0},
          geometry:{type:'Point',coordinates:[m.lng,m.lat]}}];
      });
      map.getSource('safety-markers').setData({type:'FeatureCollection',features:smF});

      if(selectedCandidate){
        var selectedRaw = String(selectedCandidate.popupTitle || selectedCandidate.label || 'Place').trim();
        var popupTitle = safeLabel(selectedCandidate.popupTitle || selectedRaw || 'Place');
        var popupSubtitle = safeLabel(selectedCandidate.popupSubtitle || selectedRaw || '');
        var popupMeta = safeLabel(selectedCandidate.popupMeta || '');
        var popupCoords = safeLabel(selectedCandidate.popupCoords || '');
        var popupButtonLabel = safeLabel(selectedCandidate.popupButtonLabel || 'Select');

        var selectedEl=document.createElement('div');
        selectedEl.className='search-pin-wrap selected';
        selectedEl.style.cursor='pointer';
        selectedEl.style.setProperty('--pin-color', normalizePinColor(selectedCandidate.pinColor));
        selectedEl.innerHTML='<div class="search-pin-card"><div class="search-pin-card-head"><div class="search-pin-card-title">'+popupTitle+'</div><button class="search-pin-card-close" type="button" aria-label="Close details">×</button></div><div class="search-pin-card-subtitle">'+popupSubtitle+'</div>'+
          (popupMeta ? '<div class="search-pin-card-meta">'+popupMeta+'</div>' : '')+
          (popupCoords ? '<div class="search-pin-card-coords">'+popupCoords+'</div>' : '')+
          '<div class="search-pin-card-actions"><button class="search-pin-card-btn" type="button">'+popupButtonLabel+'</button></div></div>';
        selectedEl.addEventListener('click', function(ev){
          ev.preventDefault();
          ev.stopPropagation();
          if(shouldIgnoreMarkerSelection()) return;
          sendMsg('selectMarker', { id:selectedCandidate.id });
        });
        var selectedButtonEl = selectedEl.querySelector('.search-pin-card-btn');
        if(selectedButtonEl){
          selectedButtonEl.addEventListener('click', function(ev){
            ev.preventDefault();
            ev.stopPropagation();
            if(shouldIgnoreMarkerSelection()) return;
            sendMsg('findSafeRoutes', { id:selectedCandidate.id });
          });
        }
        var selectedCloseEl = selectedEl.querySelector('.search-pin-card-close');
        if(selectedCloseEl){
          selectedCloseEl.addEventListener('click', function(ev){
            ev.preventDefault();
            ev.stopPropagation();
            sendMsg('dismissMarkerDetails', { id:selectedCandidate.id });
          });
        }
        selectedCandidateCardData = selectedCandidate;
        currentMarkers.push(
          selectedCandidateCardMarker = createViewportMarker({ element:selectedEl, anchor:'bottom' })
            .setLngLat([selectedCandidate.lng,selectedCandidate.lat])
            .addTo(map)
        );
        scheduleSelectedCandidateCardVisibility();
      }

      /* — Road labels (navigation mode only) — */
      var hasRoutes = Array.isArray(data.routes) && data.routes.length > 0;
      if(data.showExtraDetail && hasRoutes){
        (data.roadLabels||[]).forEach(function(lbl){
          var el=document.createElement('div');
          el.className='road-label-3d';
          el.textContent=lbl.name.slice(0,16);
          currentMarkers.push(createViewportMarker({element:el,anchor:'center'}).setLngLat([lbl.lng,lbl.lat]).addTo(map));
        });
      }

      /* — Fit bounds — */
      var isOutOfRangeCameraHold = Date.now() < outOfRangeCameraHoldUntil;
      var isUserCameraOverride = Date.now() < userCameraOverrideUntil;
      var fitTopPadding = Math.max(40, Number(data.fitTopPadding || 40));
      var fitBottomPadding = Math.max(40, Number(data.fitBottomPadding || 40));
      var fitSidePadding = Math.max(24, Number(data.fitSidePadding || 40));
      var candidateFitTopPadding = Math.max(40, Number(data.candidateFitTopPadding || fitTopPadding));
      var candidateFitBottomPadding = Math.max(40, Number(data.candidateFitBottomPadding || fitBottomPadding));
      var candidateFitSidePadding = Math.max(24, Number(data.candidateFitSidePadding || fitSidePadding));
      var isExplicitCandidateRefit = !!data.fitCandidateBounds;
      var hasValidBounds = !!(bounds && hasFiniteLngLat(bounds[0][0],bounds[0][1]) && hasFiniteLngLat(bounds[1][0],bounds[1][1]));

      if(!isOutOfRangeCameraHold && data.fitBounds && hasValidBounds && !data.navLocation && (isExplicitCandidateRefit || !isUserCameraOverride)){
        if(isExplicitCandidateRefit){
          console.log('[RouteMap WebView] Calling fitBounds for candidate autofocus');
        }
        map.stop();
        map.fitBounds(bounds,{padding:{top:isExplicitCandidateRefit ? candidateFitTopPadding : fitTopPadding,right:isExplicitCandidateRefit ? candidateFitSidePadding : fitSidePadding,bottom:isExplicitCandidateRefit ? candidateFitBottomPadding : fitBottomPadding,left:isExplicitCandidateRefit ? candidateFitSidePadding : fitSidePadding},maxZoom:isExplicitCandidateRefit ? Number(data.androidCandidateRefitMaxZoom || 12) : 16,duration:420});
      }

      scheduleSelectedCandidateCardVisibility();

      /* — Pan to — */
      if(!isOutOfRangeCameraHold && !isUserCameraOverride && data.panTo && !isExplicitCandidateRefit){
        map.easeTo({center:[data.panTo.lng,data.panTo.lat],zoom:Math.max(map.getZoom(),16),duration:320});
      }

      // Native/phone behavior: do not force a default-city recenter when location is cleared.
      // Keep the current camera instead; web handles default-city fallback independently.

      /* — Range circle — */
      if(data.origin&&data.maxDistanceKm&&data.maxDistanceKm>0&&!data.navLocation){
        var cf=makeCirclePolygon(data.origin.lng,data.origin.lat,data.maxDistanceKm,64);
        map.getSource('range-circle').setData({type:'FeatureCollection',features:[cf]});
      }else{
        map.getSource('range-circle').setData(emptyFC);
      }

      if(data.outOfRangeCueToken && data.outOfRangeCueToken !== lastOutOfRangeCueToken){
        if(triggerOutOfRangeCue(data)){
          lastOutOfRangeCueToken = data.outOfRangeCueToken;
        }
      }

      /* — Friend planned routes (dashed purple — the route they clicked navigate on) — */
      var plannedRouteFeats = [];
      (data.friendMarkers||[]).forEach(function(f){
        if(f.routePath && f.routePath.length >= 2){
          plannedRouteFeats.push({
            type:'Feature', properties:{userId:f.userId},
            geometry:{type:'LineString', coordinates:f.routePath.map(function(p){return[p.lng,p.lat]})}
          });
        }
      });
      map.getSource('friend-planned-routes').setData({type:'FeatureCollection',features:plannedRouteFeats});

      /* — Friend actual path (purple = on-route ≤30m, orange = off-route) — */
      var actualPathFeats = [];
      (data.friendMarkers||[]).forEach(function(f){
        var ap = f.path || [], rp = f.routePath || [];
        for(var i=0;i<ap.length-1;i++){
          var mid = {lat:(ap[i].lat+ap[i+1].lat)/2, lng:(ap[i].lng+ap[i+1].lng)/2};
          var onRoute = isPointOnRoute(mid, rp, 30);
          actualPathFeats.push({
            type:'Feature',
            properties:{color: onRoute ? '#7C3AED' : '#f97316'},
            geometry:{type:'LineString', coordinates:[[ap[i].lng,ap[i].lat],[ap[i+1].lng,ap[i+1].lat]]}
          });
        }
      });
      map.getSource('friend-paths').setData({type:'FeatureCollection',features:actualPathFeats});

      /* — Friend markers — */
      clearMarkerArray(friendMarkerObjs);
      (data.friendMarkers||[]).forEach(function(f){
        var el=document.createElement('div');
        el.className='friend-marker';
        el.innerHTML='<div class="friend-dot"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg></div>'
          +'<div class="friend-label">'+f.name.slice(0,12)+'</div>';
        friendMarkerObjs.push(createViewportMarker({element:el,anchor:'bottom'}).setLngLat([f.lng,f.lat]).addTo(map));
      });

        // actual path rendered above via actualPathFeats

      /* — Navigation marker + 3D camera — */
      if(navMarkerObj){navMarkerObj.remove();navMarkerObj=null}
      clearMarkerArray(hazardMarkers);

      if(data.navLocation){
        var heading=data.navHeading||0;
        lastNavCenter=[data.navLocation.lng,data.navLocation.lat];
        lastNavHeading=heading;

        // Direction arrow marker
        var ne=document.createElement('div');
        ne.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56">'+
          '<defs><filter id="glow"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#1570EF" flood-opacity="0.5"/></filter></defs>'+
          '<circle cx="28" cy="28" r="24" fill="#1570EF" stroke="white" stroke-width="3" filter="url(#glow)"/>'+
          '<polygon points="28,8 36,32 28,26 20,32" fill="white"/></svg>';
        ne.style.width='56px';ne.style.height='56px';
        navMarkerObj=createViewportMarker({element:ne,anchor:'center',rotationAlignment:'viewport',rotation:0})
          .setLngLat(lastNavCenter).addTo(map);

        // Camera follow — dead-zone & duration are tighter in PiP for snappy heading tracking
        if(!userInteracted && !isUserCameraOverride){
          setFollowMode(true);
          var bearingDiff = heading - lastCameraHeading;
          while (bearingDiff > 180) bearingDiff -= 360;
          while (bearingDiff < -180) bearingDiff += 360;
          var absDiff = Math.abs(bearingDiff);
          // PiP: 1° dead-zone so even slight turns are visible on the small screen
          // Normal: 5° dead-zone to suppress sensor jitter
          var deadZone = isPipMode ? 1 : 5;
          if(absDiff >= deadZone){
            lastCameraHeading = heading;
            // PiP: snap at 80ms so the map feels live; Normal: adapt to turn size
            var camDuration = isPipMode ? 80 : (absDiff >= 30 ? 250 : 500);
            var navZoom = isPipMode ? 15 : 17;
            map.easeTo({
              center:lastNavCenter,
              zoom:Math.max(map.getZoom(), navZoom),
              pitch:0,
              bearing:heading,
              duration:camDuration,
            });
          }
        }

        // Enter nav mode
        if(!isNavMode){
          isNavMode=true;
          setFollowMode(!userInteracted);
          var ctrl=document.getElementById('mapCtrl');
          if(ctrl) ctrl.style.display='none';
          map.dragRotate.enable();
          map.touchZoomRotate.enableRotation();
        }

        // Hazard labels near user
        var nlat=data.navLocation.lat, nlng=data.navLocation.lng;
        (data.safetyMarkers||[]).forEach(function(m){
          var dlat=m.lat-nlat,dlng=m.lng-nlng;
          if(Math.sqrt(dlat*dlat+dlng*dlng)*111320>200) return;
          var ht={crime:'⚠ Crime area',dead_end:'⛔ Dead end'};
          var txt=ht[m.kind]; if(!txt) return;
          var he=document.createElement('div'); he.className='hazard-label'; he.textContent=txt;
          hazardMarkers.push(createViewportMarker({element:he,anchor:'center'}).setLngLat([m.lng,m.lat]).addTo(map));
        });

      } else {
        // Exit nav mode
        if(isNavMode){
          isNavMode=false;
          userInteracted=false;
          setFollowMode(true);
          var ctrl=document.getElementById('mapCtrl');
          if(ctrl) ctrl.style.display = isPipMode ? 'none' : 'flex';
          map.easeTo({pitch:0,bearing:0,duration:600});
          map.dragRotate.disable();
          map.touchZoomRotate.disableRotation();
        }
      }

      schedulePinLabelLayout();
    }

    /* ── Map type switching — */
    function setMapType(type){
      styleReady=false;
      map.setStyle(mapStyles.roadmap);
      map.once('idle',function(){
        styleReady=true;
        addCustomSources();
        addCustomLayers();
        add3DBuildings();
        if(lastData) updateMap(lastData);
      });
    }

    /* ── Pathfinding visualisation (client-side animation) ──── */
    var vizProgressEl = null;
    var vizStatusEl = null;

    function ensureVizUI(){
      if(!vizProgressEl){
        vizProgressEl = document.createElement('div');
        vizProgressEl.className = 'viz-progress-bar';
        vizProgressEl.style.width = '0%';
        document.body.appendChild(vizProgressEl);
      }
      if(!vizStatusEl){
        vizStatusEl = document.createElement('div');
        vizStatusEl.className = 'viz-status';
        vizStatusEl.style.opacity = '0';
        document.body.appendChild(vizStatusEl);
      }
    }

    function clearVizMarkers(){
      vizDataMarkers.forEach(function(m){ m.remove(); });
      vizDataMarkers=[];
      if(vizSearchLabelMarker){ vizSearchLabelMarker.remove(); vizSearchLabelMarker=null; }
    }

    function clearVisualization(){
      var srcs=['viz-bbox','viz-corridor','viz-roads','viz-scoring','viz-routes'];
      srcs.forEach(function(s){ try{ if(map.getSource(s)) map.getSource(s).setData(emptyFC); }catch(e){} });
      clearVizMarkers();
      if(vizProgressEl){ vizProgressEl.style.width='0%'; vizProgressEl.style.opacity='0'; }
      if(vizStatusEl){ vizStatusEl.style.opacity='0'; }
    }

    function vizSetProgress(pct, msg){
      ensureVizUI();
      if(pct!=null){ vizProgressEl.style.opacity='1'; vizProgressEl.style.width=Math.min(pct,100)+'%'; }
      if(msg){ vizStatusEl.style.opacity='1'; vizStatusEl.textContent=msg; }
    }

    var vizExternalPct = null;
    window.setVizProgress = function(pct, _msg){
      if(pct==null || !isFinite(Number(pct))){ vizExternalPct = null; return; }
      vizExternalPct = Math.max(0, Math.min(100, Number(pct)));
      vizSetProgress(vizExternalPct, null);
    };

    /* Client-side search animation — loops until routes arrive, then stopVizStream() clears it */
    var vizAnimTimer = null;
    var vizClearTimer = null;

    window.stopVizStream = function(){
      if(vizAnimTimer){ clearInterval(vizAnimTimer); vizAnimTimer=null; }
      if(vizClearTimer){ clearTimeout(vizClearTimer); vizClearTimer=null; }
      vizExternalPct = null;
      vizClearTimer = setTimeout(function(){ clearVisualization(); vizClearTimer=null; }, 800);
    };

    window.startVizStream = function(coordsJson){
      if(vizAnimTimer){ clearInterval(vizAnimTimer); vizAnimTimer=null; }
      // Cancel any pending clear from a previous stopVizStream — we're starting fresh
      if(vizClearTimer){ clearTimeout(vizClearTimer); vizClearTimer=null; }
      if(!coordsJson) return;
      clearVisualization();
      ensureVizUI();

      var c;
      try{ c=JSON.parse(coordsJson); }catch(e){ return; }
      var oLat=Number(c.oLat), oLng=Number(c.oLng), dLat=Number(c.dLat), dLng=Number(c.dLng);
      if(!isFinite(oLat)||!isFinite(oLng)||!isFinite(dLat)||!isFinite(dLng)) return;

      // Haversine straight-line distance
      var dLatRad=(dLat-oLat)*Math.PI/180, dLngRad=(dLng-oLng)*Math.PI/180;
      var oLatRad=oLat*Math.PI/180, dLatAbsRad=dLat*Math.PI/180;
      var a=Math.sin(dLatRad/2)*Math.sin(dLatRad/2)
        + Math.cos(oLatRad)*Math.cos(dLatAbsRad)*Math.sin(dLngRad/2)*Math.sin(dLngRad/2);
      var straightLineDist=6371000*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));

      // Corridor buffer (mirrors backend)
      var corridorBufferM=Math.max(700, Math.min(1000, straightLineDist * 0.3));
      var minLat=Math.min(oLat,dLat), maxLat=Math.max(oLat,dLat);
      var minLng=Math.min(oLng,dLng), maxLng=Math.max(oLng,dLng);
      var midLat=(oLat+dLat)/2;
      var metersPerDegLat=111320;
      var metersPerDegLng=Math.max(1000, 111320*Math.cos(midLat*Math.PI/180));
      var bufferLatDeg=corridorBufferM/metersPerDegLat;
      var bufferLngDeg=corridorBufferM/metersPerDegLng;
      var fullSouth=minLat-bufferLatDeg, fullNorth=maxLat+bufferLatDeg;
      var fullWest=minLng-bufferLngDeg,  fullEast=maxLng+bufferLngDeg;

      // Square the bbox
      var heightM=(fullNorth-fullSouth)*metersPerDegLat;
      var widthM=(fullEast-fullWest)*metersPerDegLng;
      if(widthM<heightM){ var extra=(heightM-widthM)/2/metersPerDegLng; fullWest-=extra; fullEast+=extra; }
      else if(heightM<widthM){ var extra2=(widthM-heightM)/2/metersPerDegLat; fullSouth-=extra2; fullNorth+=extra2; }

      var midLng=(fullWest+fullEast)/2, bboxMidLat=(fullSouth+fullNorth)/2;

      // Show full analysis zone with a far/city framing on phone.
      try{
        map.fitBounds(
          [[fullWest, fullSouth], [fullEast, fullNorth]],
          {
            padding: { top: 96, right: 88, bottom: 104, left: 88 },
            maxZoom: 12,
            duration: 820,
          }
        );
      }catch(e){
        map.easeTo({center:[midLng,bboxMidLat],zoom:11.5,duration:820});
      }

      // Draw bbox immediately — it stays for the full animation, clearly marking the search zone
      try{
        map.getSource('viz-bbox').setData({type:'FeatureCollection',features:[{
          type:'Feature',properties:{color:'#7C3AED'},
          geometry:{type:'Polygon',coordinates:[[[fullWest,fullSouth],[fullEast,fullSouth],
            [fullEast,fullNorth],[fullWest,fullNorth],[fullWest,fullSouth]]]}
        }]});
      }catch(e){}

      // Search zone label at bbox centre (pulsing DOM overlay)
      if(vizSearchLabelMarker){ vizSearchLabelMarker.remove(); vizSearchLabelMarker=null; }
      var labelEl=document.createElement('div');
      labelEl.className='viz-search-zone';
      labelEl.innerHTML='&#128269; Analysing area&hellip;';
      vizSearchLabelMarker=createViewportMarker({element:labelEl,anchor:'center'})
        .setLngLat([midLng, bboxMidLat]).addTo(map);
      var labelWrapper=labelEl.parentElement;
      if(labelWrapper) labelWrapper.style.zIndex='10000';

      vizSetProgress(5, null);

      // Pulse bbox fill only — no line animation during analysis (saves CPU/RAM).
      var pulseStep=0;
      vizAnimTimer=setInterval(function(){
        pulseStep++;
        if(vizExternalPct!=null){ vizSetProgress(vizExternalPct, null); }
        if(!styleReady) return;
        try {
          var bboxOp = 0.05 + 0.10 * (0.5 + 0.5 * Math.sin(pulseStep * 0.314));
          map.setPaintProperty('viz-bbox-fill', 'fill-opacity', bboxOp);
        } catch(e) {}
      },1000);
    };
  <\/script>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const RouteMap = ({
  origin,
  destination,
  routes,
  selectedRouteId,
  showExtraDetail = true,
  safetyMarkers = [],
  routeSegments = [],
  roadLabels = [],
  panTo,
  fitCandidateBoundsToken = 0,
  androidFitCandidateBoundsToken = 0,
  androidCandidateRefitMaxZoom,
  fitTopPadding = 40,
  fitBottomPadding = 40,
  fitSidePadding = 40,
  candidateFitTopPadding,
  candidateFitBottomPadding,
  candidateFitSidePadding,
  isNavigating = false,
  navigationLocation,
  navigationHeading,
  mapType = "roadmap",
  maxDistanceKm,
  friendMarkers = [],
  isInPipMode = false,
  recenterSignal = 0,
  outOfRangeCueSignal = 0,
  vizStreamUrl = null,
  vizProgressPct = null,
  vizProgressMessage = null,
  onSelectRoute,
  onSelectMarker,
  onFindSafeRoutes,
  onDismissMarkerDetails,
  onLongPress,
  onMapPress,
  onMapCenterChanged,
  onNavigationFollowChange,
  onUserInteraction,
  showZoomControls = true,
}: RouteMapProps) => {
  const webViewRef = useRef<WebView>(null);
  const readyRef = useRef(false);
  const prevGeoKeyRef = useRef("");
  const prevPanKeyRef = useRef(-1);
  const prevFitCandidateBoundsTokenRef = useRef(0);
  const prevAndroidFitCandidateBoundsTokenRef = useRef(0);

  // Keep latest props in refs so pushUpdate always reads fresh values
  // (fixes the stale-closure problem when called from the 'ready' handler)
  const propsRef = useRef({
    origin,
    destination,
    routes,
    selectedRouteId,
    showExtraDetail,
    safetyMarkers,
    routeSegments,
    roadLabels,
    panTo,
    fitCandidateBoundsToken,
    androidFitCandidateBoundsToken,
    androidCandidateRefitMaxZoom,
    fitTopPadding,
    fitBottomPadding,
    fitSidePadding,
    candidateFitTopPadding,
    candidateFitBottomPadding,
    candidateFitSidePadding,
    isNavigating,
    navigationLocation,
    navigationHeading,
    maxDistanceKm,
    friendMarkers,
    isInPipMode,
    outOfRangeCueSignal,
  });
  propsRef.current = {
    origin,
    destination,
    routes,
    selectedRouteId,
    showExtraDetail,
    safetyMarkers,
    routeSegments,
    roadLabels,
    panTo,
    fitCandidateBoundsToken,
    androidFitCandidateBoundsToken,
    androidCandidateRefitMaxZoom,
    fitTopPadding,
    fitBottomPadding,
    fitSidePadding,
    candidateFitTopPadding,
    candidateFitBottomPadding,
    candidateFitSidePadding,
    isNavigating,
    navigationLocation,
    navigationHeading,
    maxDistanceKm,
    friendMarkers,
    isInPipMode,
    outOfRangeCueSignal,
  };

  const callbacksRef = useRef({
    onMapPress,
    onLongPress,
    onSelectRoute,
    onSelectMarker,
    onFindSafeRoutes,
    onDismissMarkerDetails,
    onMapCenterChanged,
    onNavigationFollowChange,
    onUserInteraction,
  });
  callbacksRef.current = {
    onMapPress,
    onLongPress,
    onSelectRoute,
    onSelectMarker,
    onFindSafeRoutes,
    onDismissMarkerDetails,
    onMapCenterChanged,
    onNavigationFollowChange,
    onUserInteraction,
  };

  // Serialize current props → a JS call the WebView can execute
  const pushUpdate = useCallback(() => {
    if (!readyRef.current || !webViewRef.current) return;

    const p = propsRef.current;
    const toLL = (c: { latitude: number; longitude: number }) => ({
      lat: c.latitude,
      lng: c.longitude,
    });

    const mappedRoutes = p.routes.map((r) => ({
      id: r.id,
      selected: r.id === p.selectedRouteId,
      path: r.path.map(toLL),
    }));

    const segments = p.routeSegments.map((seg) => ({
      color: seg.color,
      path: seg.path.map(toLL),
    }));

    const mkrs = p.safetyMarkers.map((m) => ({
      id: m.id,
      kind: m.kind,
      label: m.label,
      pinColor: (m as any).pinColor,
      isSelected: Boolean((m as any).isSelected),
      popupTitle: (m as any).popupTitle,
      popupSubtitle: (m as any).popupSubtitle,
      popupMeta: (m as any).popupMeta,
      popupCoords: (m as any).popupCoords,
      popupButtonLabel: (m as any).popupButtonLabel,
      lat: m.coordinate.latitude,
      lng: m.coordinate.longitude,
    }));

    const labels = p.roadLabels.map((l) => ({
      name: l.displayName,
      color: l.color,
      lat: l.coordinate.latitude,
      lng: l.coordinate.longitude,
    }));

    // Detect geography changes to decide whether to fitBounds
    const geoKey = [
      p.origin ? `${p.origin.latitude},${p.origin.longitude}` : "",
      p.destination
        ? `${p.destination.latitude},${p.destination.longitude}`
        : "",
      p.routes.map((r) => r.id).join(","),
      p.selectedRouteId ?? "",
    ].join("|");
    const geoChanged = geoKey !== prevGeoKeyRef.current;
    if (geoChanged) prevGeoKeyRef.current = geoKey;

    const fitCandidateBounds =
      (p.fitCandidateBoundsToken ?? 0) !== prevFitCandidateBoundsTokenRef.current;
    const androidFitCandidateBounds =
      (p.androidFitCandidateBoundsToken ?? 0) !==
      prevAndroidFitCandidateBoundsTokenRef.current;
    if (fitCandidateBounds) {
      prevFitCandidateBoundsTokenRef.current = p.fitCandidateBoundsToken ?? 0;
    }
    if (androidFitCandidateBounds) {
      prevAndroidFitCandidateBoundsTokenRef.current =
        p.androidFitCandidateBoundsToken ?? 0;
    }
    if ((fitCandidateBounds || androidFitCandidateBounds) && mkrs.length === 0) {
      console.log(
        "[RouteMap] fitCandidateBounds trigger changed but no candidate markers yet. Skipping injection.",
      );
    }

    const hasExplicitFitTargets = Boolean(p.destination) || p.routes.length > 0;
    const fitBounds =
      fitCandidateBounds || androidFitCandidateBounds || (geoChanged && hasExplicitFitTargets);
    const explicitCandidateRefit = fitCandidateBounds || androidFitCandidateBounds;

    // panTo
    let panToData: { lat: number; lng: number } | null = null;
    if (p.panTo && p.panTo.key !== prevPanKeyRef.current) {
      prevPanKeyRef.current = p.panTo.key;
      panToData = toLL(p.panTo.location);
    }

    const payload = {
      origin: p.origin ? toLL(p.origin) : null,
      destination: p.destination ? toLL(p.destination) : null,
      routes: mappedRoutes,
      showExtraDetail: p.showExtraDetail ?? true,
      segments,
      safetyMarkers: mkrs,
      roadLabels: labels,
      fitBounds,
      fitCandidateBounds: explicitCandidateRefit,
      androidFitCandidateBounds,
      androidCandidateRefitMaxZoom,
      fitTopPadding: p.fitTopPadding ?? 40,
      fitBottomPadding: p.fitBottomPadding ?? 40,
      fitSidePadding: p.fitSidePadding ?? 40,
      candidateFitTopPadding: p.candidateFitTopPadding ?? p.fitTopPadding ?? 40,
      candidateFitBottomPadding: p.candidateFitBottomPadding ?? p.fitBottomPadding ?? 40,
      candidateFitSidePadding: p.candidateFitSidePadding ?? p.fitSidePadding ?? 40,
      panTo: panToData,
      navLocation:
        p.isNavigating && p.navigationLocation
          ? toLL(p.navigationLocation)
          : null,
      navHeading: p.navigationHeading,
      maxDistanceKm: p.maxDistanceKm || null,
      outOfRangeCueToken: p.outOfRangeCueSignal || 0,
      isInPipMode: p.isInPipMode ?? false,
      friendMarkers: p.friendMarkers.map((f) => ({
        userId: f.userId,
        name: f.name,
        lat: f.lat,
        lng: f.lng,
        path: f.path ?? [],
        routePath: f.routePath ?? [],
      })),
    };

    const js = `try{updateMap(${JSON.stringify(payload)})}catch(e){}true;`;
    const shouldDelayForAndroid = fitCandidateBounds;
    console.log(
      `[RouteMap] Injecting JavaScript update (fitCandidateBounds=${fitCandidateBounds}, markers=${mkrs.length})`,
    );
    if (Platform.OS === "android" && shouldDelayForAndroid) {
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (!readyRef.current || !webViewRef.current) {
            return;
          }
          webViewRef.current.injectJavaScript(js);
        }, 24);
      });
    } else {
      webViewRef.current.injectJavaScript(js);
    }
  }, [androidCandidateRefitMaxZoom]);

  // Push whenever any data changes
  useEffect(() => {
    pushUpdate();
  }, [
    origin,
    destination,
    routes,
    selectedRouteId,
    showExtraDetail,
    safetyMarkers,
    routeSegments,
    roadLabels,
    panTo,
    fitCandidateBoundsToken,
    fitTopPadding,
    fitBottomPadding,
    fitSidePadding,
    isNavigating,
    navigationLocation,
    navigationHeading,
    maxDistanceKm,
    friendMarkers,
    isInPipMode,
    outOfRangeCueSignal,
    pushUpdate,
  ]);

  // Trigger candidate refit immediately when token changes.
  useEffect(() => {
    console.log(
      "[RouteMap] fitCandidateBoundsToken changed to",
      fitCandidateBoundsToken,
    );
    pushUpdate();
  }, [fitCandidateBoundsToken, androidFitCandidateBoundsToken, pushUpdate]);

  // ── Immediate PiP mode injection — bypasses the full pushUpdate cycle.
  // Fixes the 1+ second zoom delay: camera snaps to pip zoom as soon as
  // isInPipMode changes, without waiting for the next GPS location update.
  useEffect(() => {
    if (!readyRef.current || !webViewRef.current) return;
    webViewRef.current.injectJavaScript(
      `try{window.setPipMode(${isInPipMode ? "true" : "false"})}catch(e){}true;`,
    );
  }, [isInPipMode]);

  // ── Start/stop pathfinding visualisation SSE stream inside WebView ──
  const prevVizUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (!readyRef.current || !webViewRef.current) return;
    if (vizStreamUrl === prevVizUrlRef.current) return;
    prevVizUrlRef.current = vizStreamUrl;
    if (vizStreamUrl) {
      const js = `try{window.startVizStream(${JSON.stringify(vizStreamUrl)})}catch(e){}true;`;
      webViewRef.current.injectJavaScript(js);
    } else {
      webViewRef.current.injectJavaScript(
        "try{window.stopVizStream()}catch(e){}true;",
      );
    }
  }, [vizStreamUrl]);

  useEffect(() => {
    if (!readyRef.current || !webViewRef.current) return;
    const pct =
      typeof vizProgressPct === "number" && Number.isFinite(vizProgressPct)
        ? Math.max(0, Math.min(100, vizProgressPct))
        : null;
    const js = `try{window.setVizProgress&&window.setVizProgress(${pct == null ? "null" : pct},${JSON.stringify(vizProgressMessage ?? "")})}catch(e){}true;`;
    webViewRef.current.injectJavaScript(js);
  }, [vizProgressPct, vizProgressMessage]);

  useEffect(() => {
    if (!readyRef.current || !webViewRef.current) return;
    webViewRef.current.injectJavaScript(
      "try{window.recenterNavigation&&window.recenterNavigation()}catch(e){}true;",
    );
  }, [recenterSignal]);

  // Update map type when it changes
  useEffect(() => {
    if (!readyRef.current || !webViewRef.current) return;
    const js = "try{setMapType('roadmap')}catch(e){}true;";
    webViewRef.current.injectJavaScript(js);
  }, [mapType]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const msg = JSON.parse(event.nativeEvent.data);
        const cbs = callbacksRef.current;
        switch (msg.type) {
          case "ready":
            readyRef.current = true;
            // Flush update now that the map is ready
            pushUpdate();
            break;
          case "press":
            cbs.onMapPress?.({ latitude: msg.lat, longitude: msg.lng });
            break;
          case "longpress":
            cbs.onLongPress?.({ latitude: msg.lat, longitude: msg.lng });
            break;
          case "selectRoute":
            cbs.onSelectRoute?.(msg.id);
            break;
          case "selectMarker":
            cbs.onSelectMarker?.(msg.id);
            break;
          case "findSafeRoutes":
            cbs.onFindSafeRoutes?.(msg.id);
            break;
          case "dismissMarkerDetails":
            cbs.onDismissMarkerDetails?.(msg.id);
            break;
          case "navFollowChanged":
            cbs.onNavigationFollowChange?.(Boolean(msg.isFollowing));
            break;
          case "userInteracted":
            cbs.onUserInteraction?.();
            break;
          case "mapCenterChanged":
            cbs.onMapCenterChanged?.({
              latitude: msg.lat,
              longitude: msg.lng,
            });
            break;
        }
      } catch {
        // ignore parse errors
      }
    },
    [pushUpdate],
  );

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={{ html: buildMapHtml(mapType, showZoomControls) }}
        style={{ flex: 1 }}
        originWhitelist={["*"]}
        javaScriptEnabled
        domStorageEnabled
        onMessage={handleMessage}
        scrollEnabled={false}
        overScrollMode="never"
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        startInLoadingState={false}
        cacheEnabled
        // Android: force TextureView instead of SurfaceView to fix z-ordering
        androidLayerType="hardware"
        // Android: allow mixed content (http tiles from https page)
        mixedContentMode="compatibility"
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#e8eaed",
    overflow: "hidden" as const,
  },
});

export default RouteMap;
