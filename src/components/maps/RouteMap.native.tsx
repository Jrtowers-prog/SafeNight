/**
 * RouteMap.native — MapLibre GL JS in a WebView.
 *
 * Uses MapTiler vector style for 3D buildings, pitch, and bearing.
 * Falls back to OpenFreeMap when no MapTiler key is configured.
 */
import { useCallback, useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import {
  OPENFREEMAP_VECTOR_STYLE_URL,
  ROADMAP_STYLE,
} from "@/src/components/maps/mapConstants";
import type { RouteMapProps } from "@/src/components/maps/RouteMap.types";

// ---------------------------------------------------------------------------
// Build the HTML page that runs MapLibre GL JS inside the WebView
// ---------------------------------------------------------------------------

const buildMapHtml = (_mapType: string = "roadmap") => `
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
    /* Zoom controls removed */

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
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.7}}
    .friend-marker{display:flex;flex-direction:column;align-items:center;pointer-events:none}
    .friend-dot{width:32px;height:32px;border-radius:50%;background:#7C3AED;border:3px solid #fff;
      box-shadow:0 2px 8px rgba(124,58,237,.5);display:flex;align-items:center;justify-content:center}
    .friend-dot svg{width:18px;height:18px}
    .friend-label{margin-top:2px;background:rgba(124,58,237,.9);color:#fff;padding:2px 8px;
      border-radius:8px;font-size:10px;font-weight:700;white-space:nowrap;
      box-shadow:0 1px 4px rgba(0,0,0,.3);max-width:100px;overflow:hidden;text-overflow:ellipsis}
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
    /* Viz DOM marker tracking */
    var vizDataMarkers = [];
    var vizSearchLabelMarker = null;
    var longPressPoint = null;
    var touchMoved = false;

    var emptyFC = { type: 'FeatureCollection', features: [] };

    function clearMarkerArray(arr) { arr.forEach(function(m){m.remove()}); arr.length=0; }
    function sendMsg(t, d) { try { window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({type:t},d||{}))); } catch(e){} }
    function setFollowMode(next){
      if (isFollowingNav === next) return;
      isFollowingNav = next;
      sendMsg('navFollowChanged', { isFollowing: next });
    }

    /* ── Styles ─────────── */
    var mapStyles = {
      roadmap: ${JSON.stringify(ROADMAP_STYLE)},
      satellite: { version:8, sources:{ sat:{ type:'raster', tiles:['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize:256, maxzoom:18 }}, layers:[{id:'sat',type:'raster',source:'sat'}] },
      terrain: { version:8, sources:{ topo:{ type:'raster', tiles:['https://tile.opentopomap.org/{z}/{x}/{y}.png'], tileSize:256, maxzoom:17 }}, layers:[{id:'topo',type:'raster',source:'topo'}] },
      hybrid: { version:8, sources:{ sat:{ type:'raster', tiles:['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize:256, maxzoom:18 }}, layers:[{id:'sat',type:'raster',source:'sat'}] }
    };
    var roadmapFallbackStyle = ${JSON.stringify(OPENFREEMAP_VECTOR_STYLE_URL)};
    var roadmapStyleIndex = 0;
    var styleFallbackTimer = null;

    function clearStyleFallbackTimer() {
      if (styleFallbackTimer) {
        clearTimeout(styleFallbackTimer);
        styleFallbackTimer = null;
      }
    }

    function setRoadmapStyleWithFallback(nextIndex) {
      var styleCandidates = [mapStyles.roadmap, roadmapFallbackStyle];
      roadmapStyleIndex = Math.max(0, Math.min(nextIndex, styleCandidates.length - 1));
      styleReady = false;
      clearStyleFallbackTimer();
      map.setStyle(styleCandidates[roadmapStyleIndex]);
      styleFallbackTimer = setTimeout(function() {
        if (styleReady) return;
        if (roadmapStyleIndex < styleCandidates.length - 1) {
          setRoadmapStyleWithFallback(roadmapStyleIndex + 1);
        }
      }, 6000);
    }

    /* ── Init MapLibre ─────────────────────────────────────── */
    var map = new maplibregl.Map({
      container: 'map',
      style: mapStyles.roadmap,
      center: [-4.1427, 50.3755],
      zoom: 13,
      pitch: 0,
      bearing: 0,
      maxPitch: 70,
      antialias: true,
      attributionControl: false,
    });
    setRoadmapStyleWithFallback(0);

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
      map.addLayer({ id:'safety-circles', type:'circle', source:'safety-markers',
        paint:{'circle-radius':['case',['==',['get','kind'],'via'],10,4],
          'circle-color':['get','color'],'circle-opacity':0.9,
          'circle-stroke-color':'#fff','circle-stroke-width':['case',['==',['get','kind'],'via'],2,1]} });
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
      map.on('mouseenter','unselected-routes-line',function(){map.getCanvas().style.cursor='pointer'});
      map.on('mouseleave','unselected-routes-line',function(){map.getCanvas().style.cursor=''});

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
      clearStyleFallbackTimer();
      addCustomSources();
      addCustomLayers();
      add3DBuildings();
      sendMsg('ready',{});
    });

    map.on('error', function() {
      if (styleReady) return;
      var styleCandidates = [mapStyles.roadmap, roadmapFallbackStyle];
      if (roadmapStyleIndex < styleCandidates.length - 1) {
        setRoadmapStyleWithFallback(roadmapStyleIndex + 1);
      }
    });

    /* ── Click / Long-press events ─────────────────────────── */
    map.on('click',function(e){
      // Don't fire on route-click (already handled above)
      var features = map.queryRenderedFeatures(e.point,{layers:['unselected-routes-line']});
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
      if(isNavMode){
        userInteracted=true;
        setFollowMode(false);
      }
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
      lastData = data;
      isPipMode = !!(data.isInPipMode);

      // Ensure controls reflect PiP state immediately
      var ctrl = document.getElementById('mapCtrl');
      if(ctrl) ctrl.style.display = (isPipMode || isNavMode) ? 'none' : 'flex';

      clearMarkerArray(currentMarkers);
      var bounds = null;

      /* — Origin marker (blue dot) — hidden during nav — */
      if(data.origin && !data.navLocation){
        var oe=document.createElement('div');
        oe.innerHTML='<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#4285F4" stroke="white" stroke-width="3"/><circle cx="12" cy="12" r="3" fill="white"/></svg>';
        currentMarkers.push(new maplibregl.Marker({element:oe,anchor:'center'}).setLngLat([data.origin.lng,data.origin.lat]).addTo(map));
        bounds=extBounds(bounds,[data.origin.lng,data.origin.lat]);
      }

      /* — Destination marker (red pin) — */
      if(data.destination){
        var de=document.createElement('div');
        de.innerHTML='<svg width="28" height="40" viewBox="0 0 28 40"><path d="M14 0C6.3 0 0 6.3 0 14c0 10.5 14 26 14 26s14-15.5 14-26C28 6.3 21.7 0 14 0z" fill="#ef4444" stroke="white" stroke-width="1.5"/><circle cx="14" cy="14" r="5" fill="white"/></svg>';
        currentMarkers.push(new maplibregl.Marker({element:de,anchor:'bottom'}).setLngLat([data.destination.lng,data.destination.lat]).addTo(map));
        bounds=extBounds(bounds,[data.destination.lng,data.destination.lat]);
      }

      /* — Unselected routes (grey, clickable) — */
      var unselF=[];
      (data.routes||[]).forEach(function(r){
        if(r.selected) return;
        var coords=r.path.map(function(p){return[p.lng,p.lat]});
        unselF.push({type:'Feature',properties:{routeId:r.id},geometry:{type:'LineString',coordinates:coords}});
        coords.forEach(function(c){bounds=extBounds(bounds,c)});
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
        sel.path.forEach(function(p){bounds=extBounds(bounds,[p.lng,p.lat])});
      }

      map.getSource('route-traversed').setData({type:'FeatureCollection',features:travF});
      map.getSource('route-segments').setData({type:'FeatureCollection',features:segF});
      map.getSource('route-remaining').setData({type:'FeatureCollection',features:remF});

      /* — Safety markers — */
      var mColors={crime:'#ef4444',shop:'#22c55e',light:'#facc15',bus_stop:'#3b82f6',cctv:'#8b5cf6',dead_end:'#f97316',via:'#d946ef'};
      var smF=(data.safetyMarkers||[]).map(function(m){
        return{type:'Feature',properties:{kind:m.kind,label:m.label||m.kind,color:mColors[m.kind]||'#94a3b8'},
          geometry:{type:'Point',coordinates:[m.lng,m.lat]}};
      });
      map.getSource('safety-markers').setData({type:'FeatureCollection',features:smF});

      /* — Road labels (navigation mode only) — */
      if(data.navLocation){
        (data.roadLabels||[]).forEach(function(lbl){
          var el=document.createElement('div');
          el.className='road-label-3d';
          el.textContent=lbl.name.slice(0,16);
          currentMarkers.push(new maplibregl.Marker({element:el,anchor:'center'}).setLngLat([lbl.lng,lbl.lat]).addTo(map));
        });
      }

      /* — Fit bounds — */
      if(data.fitBounds && bounds && !data.navLocation){
        map.fitBounds(bounds,{padding:40,maxZoom:16,duration:600});
      }

      /* — Pan to — */
      if(data.panTo){
        map.easeTo({center:[data.panTo.lng,data.panTo.lat],zoom:Math.max(map.getZoom(),16),duration:500});
      }

      /* — Range circle — */
      if(data.origin&&data.maxDistanceKm&&data.maxDistanceKm>0&&!data.navLocation){
        var cf=makeCirclePolygon(data.origin.lng,data.origin.lat,data.maxDistanceKm,64);
        map.getSource('range-circle').setData({type:'FeatureCollection',features:[cf]});
      }else{
        map.getSource('range-circle').setData(emptyFC);
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
        friendMarkerObjs.push(new maplibregl.Marker({element:el,anchor:'bottom'}).setLngLat([f.lng,f.lat]).addTo(map));
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
        navMarkerObj=new maplibregl.Marker({element:ne,anchor:'center',rotationAlignment:'viewport',rotation:0})
          .setLngLat(lastNavCenter).addTo(map);

        // Camera follow — dead-zone & duration are tighter in PiP for snappy heading tracking
        if(!userInteracted){
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
          hazardMarkers.push(new maplibregl.Marker({element:he,anchor:'center'}).setLngLat([m.lng,m.lat]).addTo(map));
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
    }

    /* ── Map type switching — */
    function setMapType(type){
      if(type==='roadmap'){
        setRoadmapStyleWithFallback(0);
        return;
      }
      var s=mapStyles[type]||mapStyles.roadmap;
      styleReady=false;
      clearStyleFallbackTimer();
      map.setStyle(s);
      map.once('idle',function(){
        styleReady=true;
        clearStyleFallbackTimer();
        addCustomSources();
        addCustomLayers();
        if(type==='roadmap') add3DBuildings();
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
      vizSearchLabelMarker=new maplibregl.Marker({element:labelEl,anchor:'center'})
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
  safetyMarkers = [],
  routeSegments = [],
  roadLabels = [],
  panTo,
  isNavigating = false,
  navigationLocation,
  navigationHeading,
  mapType = "roadmap",
  maxDistanceKm,
  friendMarkers = [],
  isInPipMode = false,
  recenterSignal = 0,
  vizStreamUrl = null,
  vizProgressPct = null,
  vizProgressMessage = null,
  onSelectRoute,
  onLongPress,
  onMapPress,
  onNavigationFollowChange,
}: RouteMapProps) => {
  const webViewRef = useRef<WebView>(null);
  const readyRef = useRef(false);
  const prevGeoKeyRef = useRef("");
  const prevPanKeyRef = useRef(-1);

  // Keep latest props in refs so pushUpdate always reads fresh values
  // (fixes the stale-closure problem when called from the 'ready' handler)
  const propsRef = useRef({
    origin,
    destination,
    routes,
    selectedRouteId,
    safetyMarkers,
    routeSegments,
    roadLabels,
    panTo,
    isNavigating,
    navigationLocation,
    navigationHeading,
    maxDistanceKm,
    friendMarkers,
    isInPipMode,
  });
  propsRef.current = {
    origin,
    destination,
    routes,
    selectedRouteId,
    safetyMarkers,
    routeSegments,
    roadLabels,
    panTo,
    isNavigating,
    navigationLocation,
    navigationHeading,
    maxDistanceKm,
    friendMarkers,
    isInPipMode,
  };

  const mapTypeRef = useRef(mapType);

  const callbacksRef = useRef({
    onMapPress,
    onLongPress,
    onSelectRoute,
    onNavigationFollowChange,
  });
  callbacksRef.current = {
    onMapPress,
    onLongPress,
    onSelectRoute,
    onNavigationFollowChange,
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
      kind: m.kind,
      label: m.label,
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
    const fitBounds = geoKey !== prevGeoKeyRef.current;
    if (fitBounds) prevGeoKeyRef.current = geoKey;

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
      segments,
      safetyMarkers: mkrs,
      roadLabels: labels,
      fitBounds,
      panTo: panToData,
      navLocation:
        p.isNavigating && p.navigationLocation
          ? toLL(p.navigationLocation)
          : null,
      navHeading: p.navigationHeading,
      maxDistanceKm: p.maxDistanceKm || null,
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
    webViewRef.current.injectJavaScript(js);
  }, []);

  // Push whenever any data changes
  useEffect(() => {
    pushUpdate();
  }, [
    origin,
    destination,
    routes,
    selectedRouteId,
    safetyMarkers,
    routeSegments,
    roadLabels,
    panTo,
    isNavigating,
    navigationLocation,
    navigationHeading,
    maxDistanceKm,
    friendMarkers,
    isInPipMode,
    pushUpdate,
  ]);

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
    if (mapType === mapTypeRef.current) return;
    mapTypeRef.current = mapType;
    const js = `try{setMapType('${mapType}')}catch(e){}true;`;
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
          case "navFollowChanged":
            cbs.onNavigationFollowChange?.(Boolean(msg.isFollowing));
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
        source={{ html: buildMapHtml(mapType) }}
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
