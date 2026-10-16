/**
 * RouteMap.web — MapLibre GL JS + OpenFreeMap/OSM tiles (100% free, no key).
 *
 * Restores the old 3D navigation feel on web (pitch + bearing + extrusions)
 * while keeping the same RouteMap props/message contract.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import {
  OPENFREEMAP_VECTOR_STYLE_URL,
  OSM_RASTER_STYLE,
  ROADMAP_STYLE,
} from "@/src/components/maps/mapConstants";
import type { RouteMapProps } from "@/src/components/maps/RouteMap.types";

// ── Build MapLibre HTML page (embedded in iframe srcDoc) ─────────────────────

const buildMapLibreHtml = () => `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4/dist/maplibre-gl.css"/>
<script src="https://unpkg.com/maplibre-gl@4/dist/maplibre-gl.js"><\/script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden;background:#e8eaed}
#map{width:100%;height:100%;position:absolute;top:0;left:0}
.map-ctrl{position:absolute;right:12px;bottom:100px;z-index:1000;display:flex;flex-direction:column;gap:4px}
.map-btn{width:38px;height:38px;border:none;border-radius:8px;background:rgba(255,255,255,.95);
  box-shadow:0 2px 8px rgba(0,0,0,.2);font-size:20px;font-weight:700;color:#1D2939;
  cursor:pointer;display:flex;align-items:center;justify-content:center;user-select:none;line-height:1}
.map-btn:hover{background:#e4e7ec}
.road-label{background:rgba(0,0,0,.7);color:#fff;padding:2px 8px;border-radius:9px;font-size:9px;font-weight:600;white-space:nowrap}
.friend-marker{display:flex;align-items:center;gap:4px;background:#7C3AED;color:#fff;padding:3px 8px 3px 3px;
  border-radius:16px;font-size:11px;font-weight:600;white-space:nowrap;border:2px solid #fff;
  box-shadow:0 2px 8px rgba(124,58,237,.4);line-height:1.2}
.friend-dot{width:22px;height:22px;border-radius:50%;background:rgba(255,255,255,.25);
  display:flex;align-items:center;justify-content:center;font-size:12px}
.maplibregl-ctrl-attrib{display:none!important}
.maplibregl-ctrl-bottom-right{display:none!important}
/* ─── Pathfinding visualisation ─── */
@keyframes vizpin{from{transform:scale(0);opacity:0}to{transform:scale(1);opacity:1}}
.viz-data-pin{width:20px;height:20px;border-radius:50%;border:1.5px solid rgba(255,255,255,.75);
  display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;
  box-shadow:0 2px 6px rgba(0,0,0,.4);animation:vizpin .3s ease-out forwards;z-index:10001}
.viz-crime-pin{background:rgba(220,38,38,.85);color:#fff}
.viz-light-pin{background:rgba(234,179,8,.9);color:#1a1000}
.viz-place-pin{background:rgba(22,163,74,.85);color:#fff}
@keyframes vizscan{0%,100%{opacity:.95}50%{opacity:.45}}
.viz-search-zone{pointer-events:none;background:rgba(88,28,235,.22);border:1.5px solid rgba(167,139,250,.7);
  border-radius:5px;padding:4px 12px;color:#ddd6fe;font-size:10px;font-weight:700;letter-spacing:.5px;
  white-space:nowrap;animation:vizscan 1.8s ease-in-out infinite;backdrop-filter:blur(6px)}
.viz-progress-bar{position:fixed;top:0;left:0;height:3px;
  background:linear-gradient(90deg,#7C3AED,#3b82f6,#06b6d4);
  z-index:9999;transition:width .3s ease;box-shadow:0 0 8px rgba(124,58,237,.6)}
.viz-status{position:fixed;top:8px;left:50%;transform:translateX(-50%);display:none;
  background:rgba(15,15,30,.88);color:#e0e7ff;padding:6px 16px;border-radius:20px;
  font-size:11px;font-weight:600;z-index:9999;letter-spacing:.3px;white-space:nowrap;
  border:1px solid rgba(124,58,237,.4);box-shadow:0 2px 12px rgba(0,0,0,.4);
  backdrop-filter:blur(8px);transition:opacity .3s}
</style>
</head><body>
<div id="map"></div>
<div class="map-ctrl">
<button class="map-btn" onclick="try{map.zoomIn()}catch(e){}">+</button>
<button class="map-btn" onclick="try{map.zoomOut()}catch(e){}">&minus;</button>
</div>
<script>
var isPipMode = false;
var map=null,styleReady=false,lastData=null;
var isNavMode=false,userInteracted=false,lastNavLL=null;
var isFollowingNav=true;
var longPressTimer=null,longPressLatLng=null,touchStart=0;
var pointMarkers=[],roadLabelMarkers=[],friendMarkersDom=[],navMarker=null;

function sendMsg(t,d){
  try{var m=Object.assign({type:t},d||{});
    window.parent.postMessage(JSON.stringify(m),'*');
    window.dispatchEvent(new CustomEvent('leaflet-msg',{detail:m}));
  }catch(e){}
}

function makeEmptyFC(){return {type:'FeatureCollection',features:[]};}
function clearDomMarkers(arr){for(var i=0;i<arr.length;i++){try{arr[i].remove()}catch(e){}}arr.length=0;}
function toLL(c){return c?{lat:c.latitude,lng:c.longitude}:null;}

function makeCirclePolygon(lng,lat,radiusKm,steps){
  var pts=[];var R=6378137;var d=radiusKm*1000/R;
  var lat1=lat*Math.PI/180,lng1=lng*Math.PI/180;
  for(var i=0;i<=steps;i++){
    var brng=(i/steps)*2*Math.PI;
    var lat2=Math.asin(Math.sin(lat1)*Math.cos(d)+Math.cos(lat1)*Math.sin(d)*Math.cos(brng));
    var lng2=lng1+Math.atan2(Math.sin(brng)*Math.sin(d)*Math.cos(lat1),Math.cos(d)-Math.sin(lat1)*Math.sin(lat2));
    pts.push([lng2*180/Math.PI,lat2*180/Math.PI]);
  }
  return {type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[pts]}};
}

function setFollowMode(next){
  if(isFollowingNav===next) return;
  isFollowingNav=next;
  sendMsg('navFollowChanged',{isFollowing:next});
}

var mapStyles={
  roadmap:${JSON.stringify(ROADMAP_STYLE)},
  satellite:{version:8,sources:{sat:{type:'raster',tiles:['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],tileSize:256,maxzoom:18}},layers:[{id:'sat',type:'raster',source:'sat'}]},
  terrain:{version:8,sources:{topo:{type:'raster',tiles:['https://tile.opentopomap.org/{z}/{x}/{y}.png'],tileSize:256,maxzoom:17}},layers:[{id:'topo',type:'raster',source:'topo'}]},
  hybrid:{version:8,sources:{sat:{type:'raster',tiles:['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],tileSize:256,maxzoom:18}},layers:[{id:'sat',type:'raster',source:'sat'}]}
};
var roadmapFallbackStyle=${JSON.stringify(OPENFREEMAP_VECTOR_STYLE_URL)};
var roadmapRasterFallbackStyle=${JSON.stringify(OSM_RASTER_STYLE)};
var roadmapStyleIndex=0;
var styleFallbackTimer=null;

function clearStyleFallbackTimer(){
  if(styleFallbackTimer){clearTimeout(styleFallbackTimer);styleFallbackTimer=null;}
}

function setRoadmapStyleWithFallback(nextIndex){
  var styleCandidates=[mapStyles.roadmap, roadmapFallbackStyle, roadmapRasterFallbackStyle];
  roadmapStyleIndex=Math.max(0, Math.min(nextIndex, styleCandidates.length - 1));
  styleReady=false;
  clearStyleFallbackTimer();
  map.setStyle(styleCandidates[roadmapStyleIndex]);
  styleFallbackTimer=setTimeout(function(){
    if(styleReady) return;
    if(roadmapStyleIndex < styleCandidates.length - 1){
      setRoadmapStyleWithFallback(roadmapStyleIndex + 1);
    }
  },6000);
}

map = new maplibregl.Map({container:'map',style:mapStyles.roadmap,center:[-4.1427,50.3755],zoom:13,pitch:0,bearing:0,maxPitch:70,antialias:true,attributionControl:false});
styleFallbackTimer=setTimeout(function(){
  if(styleReady) return;
  setRoadmapStyleWithFallback(1);
},6000);
map.dragRotate.disable();
map.touchZoomRotate.disableRotation();

function addSources(){
  if(map.getSource('unselected-routes')) return;
  map.addSource('unselected-routes',{type:'geojson',data:makeEmptyFC()});
  map.addSource('route-traversed',{type:'geojson',data:makeEmptyFC()});
  map.addSource('route-segments',{type:'geojson',data:makeEmptyFC()});
  map.addSource('route-remaining',{type:'geojson',data:makeEmptyFC()});
  map.addSource('safety-markers',{type:'geojson',data:makeEmptyFC()});
  map.addSource('friend-paths',{type:'geojson',data:makeEmptyFC()});
  map.addSource('friend-planned-routes',{type:'geojson',data:makeEmptyFC()});
  map.addSource('range-circle',{type:'geojson',data:makeEmptyFC()});
}

function addLayers(){
  if(map.getLayer('unselected-routes-line')) return;
  map.addLayer({id:'range-circle-fill',type:'fill',source:'range-circle',paint:{'fill-color':'#22c55e','fill-opacity':0.04}});
  map.addLayer({id:'range-circle-line',type:'line',source:'range-circle',paint:{'line-color':'#22c55e','line-opacity':0.8,'line-width':2.5,'line-dasharray':[3,2]}});
  map.addLayer({id:'unselected-routes-line',type:'line',source:'unselected-routes',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#98a2b3','line-opacity':0.5,'line-width':5}});
  map.addLayer({id:'route-traversed-line',type:'line',source:'route-traversed',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#1D2939','line-opacity':0.7,'line-width':7}});
  map.addLayer({id:'route-segments-line',type:'line',source:'route-segments',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':['get','color'],'line-opacity':0.9,'line-width':7}});
  map.addLayer({id:'route-remaining-line',type:'line',source:'route-remaining',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#4285F4','line-opacity':0.85,'line-width':6}});
  map.addLayer({id:'safety-circles',type:'circle',source:'safety-markers',paint:{'circle-radius':['coalesce',['get','radius'],4],'circle-color':['get','color'],'circle-opacity':['coalesce',['get','opacity'],0.85],'circle-stroke-color':'#fff','circle-stroke-width':['coalesce',['get','stroke'],1]}});
  map.addLayer({id:'friend-paths-line',type:'line',source:'friend-paths',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':['get','color'],'line-opacity':0.9,'line-width':5}});
  map.addLayer({id:'friend-planned-routes-line',type:'line',source:'friend-planned-routes',layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#7C3AED','line-opacity':0.45,'line-width':5,'line-dasharray':[4,3]}});

  map.on('click','unselected-routes-line',function(e){
    if(e&&e.features&&e.features[0]&&e.features[0].properties){sendMsg('selectRoute',{id:e.features[0].properties.routeId});}
  });
  map.on('mouseenter','unselected-routes-line',function(){map.getCanvas().style.cursor='pointer';});
  map.on('mouseleave','unselected-routes-line',function(){map.getCanvas().style.cursor='';});
}

function resolveBuildingSource(){
  var style=map.getStyle();
  if(!style||!style.layers) return null;
  for(var i=0;i<style.layers.length;i++){
    var layer=style.layers[i];
    if(layer&&layer.source&&layer['source-layer']==='building'){
      return {source:layer.source,sourceLayer:'building'};
    }
  }
  if(style.sources&&style.sources.openmaptiles){
    return {source:'openmaptiles',sourceLayer:'building'};
  }
  return null;
}

function add3DBuildings(){
  if(map.getLayer('3d-buildings')) return;
  var buildingSource=resolveBuildingSource();
  if(!buildingSource) return;
  try{
    map.addLayer({id:'3d-buildings',source:buildingSource.source,'source-layer':buildingSource.sourceLayer,type:'fill-extrusion',minzoom:14,paint:{
      'fill-extrusion-color':['interpolate',['linear'],['zoom'],14,'#ddd8d0',16.5,'#c8c3bb'],
      'fill-extrusion-height':['interpolate',['linear'],['zoom'],14,0,14.5,['coalesce',['get','render_height'],8]],
      'fill-extrusion-base':['interpolate',['linear'],['zoom'],14,0,14.5,['coalesce',['get','render_min_height'],0]],
      'fill-extrusion-opacity':['interpolate',['linear'],['zoom'],14,0,14.5,0.7,18,0.85]
    }});
  }catch(e){}
}

function extBounds(bounds,c){
  if(!bounds) return [[c[0],c[1]],[c[0],c[1]]];
  return [
    [Math.min(bounds[0][0],c[0]),Math.min(bounds[0][1],c[1])],
    [Math.max(bounds[1][0],c[0]),Math.max(bounds[1][1],c[1])]
  ];
}

function haversineM(a,b){
  var R=6371000,dLat=(b.lat-a.lat)*Math.PI/180,dLng=(b.lng-a.lng)*Math.PI/180;
  var sa=Math.sin(dLat/2),sb=Math.sin(dLng/2);
  return 2*R*Math.asin(Math.sqrt(sa*sa+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*sb*sb));
}
function distToSegM(p,a,b){
  var dx=b.lng-a.lng,dy=b.lat-a.lat,lenSq=dx*dx+dy*dy;
  if(lenSq===0) return haversineM(p,a);
  var t=Math.max(0,Math.min(1,((p.lng-a.lng)*dx+(p.lat-a.lat)*dy)/lenSq));
  return haversineM(p,{lat:a.lat+t*dy,lng:a.lng+t*dx});
}
function isPointOnRoute(p,routePath,thresholdM){
  if(!routePath||routePath.length<2) return false;
  for(var i=0;i<routePath.length-1;i++) if(distToSegM(p,routePath[i],routePath[i+1])<=thresholdM) return true;
  return false;
}
function nearestIdx(path,pt){var best=0,bestD=1e18;for(var i=0;i<path.length;i++){var dl=path[i].lat-pt.lat,dn=path[i].lng-pt.lng,dd=dl*dl+dn*dn;if(dd<bestD){bestD=dd;best=i;}}return best;}

function updateMap(d){
  if(!styleReady||!d) return;
  lastData=d;
  if(typeof d.isInPipMode!=='undefined'){
    isPipMode=!!d.isInPipMode;
    var ctrl=document.querySelector('.map-ctrl'); if(ctrl) ctrl.style.display=isPipMode?'none':'flex';
  }

  clearDomMarkers(pointMarkers); clearDomMarkers(roadLabelMarkers); clearDomMarkers(friendMarkersDom);
  if(navMarker){try{navMarker.remove()}catch(e){} navMarker=null;}

  var unsel=[],trav=[],segs=[],rem=[],safety=[],fpaths=[],fplanned=[];
  var bounds=null;
  var colorMap={crime:'#ef4444',shop:'#22c55e',light:'#facc15',bus_stop:'#3b82f6',cctv:'#8b5cf6',dead_end:'#f97316',via:'#d946ef'};

  if(d.origin && !d.navLocation){
    var oe=document.createElement('div'); oe.style.width='16px'; oe.style.height='16px'; oe.style.border='3px solid white'; oe.style.borderRadius='50%'; oe.style.background='#4285F4';
    pointMarkers.push(new maplibregl.Marker({element:oe,anchor:'center'}).setLngLat([d.origin.lng,d.origin.lat]).addTo(map));
    bounds=extBounds(bounds,[d.origin.lng,d.origin.lat]);
  }
  if(d.destination){
    var de=document.createElement('div'); de.innerHTML='<svg width="28" height="40" viewBox="0 0 28 40"><path d="M14 0C6.3 0 0 6.3 0 14c0 10.5 14 26 14 26s14-15.5 14-26C28 6.3 21.7 0 14 0z" fill="#ef4444" stroke="white" stroke-width="1.5"/><circle cx="14" cy="14" r="5" fill="white"/></svg>';
    pointMarkers.push(new maplibregl.Marker({element:de,anchor:'bottom'}).setLngLat([d.destination.lng,d.destination.lat]).addTo(map));
    bounds=extBounds(bounds,[d.destination.lng,d.destination.lat]);
  }

  (d.routes||[]).forEach(function(r){
    if(r.selected) return;
    var coords=r.path.map(function(p){return [p.lng,p.lat];});
    unsel.push({type:'Feature',properties:{routeId:r.id},geometry:{type:'LineString',coordinates:coords}});
    for(var i=0;i<coords.length;i++) bounds=extBounds(bounds,coords[i]);
  });

  var sel=null;
  for(var ri=0;ri<(d.routes||[]).length;ri++){ if(d.routes[ri].selected){sel=d.routes[ri];break;} }
  if(sel){
    if(d.navLocation&&sel.path.length>1){
      var np=[d.navLocation.lng,d.navLocation.lat],si=nearestIdx(sel.path,d.navLocation);
      if(si>0){var tp=[];for(var ti=0;ti<=si;ti++) tp.push([sel.path[ti].lng,sel.path[ti].lat]);tp.push(np);trav.push({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:tp}});}
      if(d.segments&&d.segments.length>0){
        d.segments.forEach(function(sg){var fp=[],st=false;for(var i=0;i<sg.path.length;i++){var sp=sg.path[i];if(!st){var idx=nearestIdx(sel.path,sp);if(idx>=si)st=true;}if(st)fp.push([sp.lng,sp.lat]);}
          if(fp.length>=2) segs.push({type:'Feature',properties:{color:sg.color},geometry:{type:'LineString',coordinates:fp}});
        });
      } else {
        var rp=[np];for(var rpi=si;rpi<sel.path.length;rpi++) rp.push([sel.path[rpi].lng,sel.path[rpi].lat]);
        rem.push({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:rp}});
      }
    } else {
      if(d.segments&&d.segments.length>0){
        d.segments.forEach(function(sg){var sp=sg.path.map(function(p){return [p.lng,p.lat];});segs.push({type:'Feature',properties:{color:sg.color},geometry:{type:'LineString',coordinates:sp}});});
      } else {
        var spts=sel.path.map(function(p){return [p.lng,p.lat];});
        rem.push({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:spts}});
      }
    }
    sel.path.forEach(function(p){bounds=extBounds(bounds,[p.lng,p.lat]);});
  }

  var hl=d.highlightCategory||null;
  (d.safetyMarkers||[]).forEach(function(m){
    var k=m.kind||'crime';
    if(hl&&hl!==k) return;
    var isHl=hl&&hl===k;
    var radius=(k==='via')?10:(isHl?8:((k==='light'||k==='crime')?3:4));
    safety.push({type:'Feature',properties:{color:colorMap[k]||'#94a3b8',radius:radius,opacity:isHl?1:0.85,stroke:isHl?2:1},geometry:{type:'Point',coordinates:[m.lng,m.lat]}});
  });

  (d.friendMarkers||[]).forEach(function(f){
    var ap=f.path||[],rp=f.routePath||[];
    for(var i=0;i<ap.length-1;i++){
      var mid={lat:(ap[i].lat+ap[i+1].lat)/2,lng:(ap[i].lng+ap[i+1].lng)/2};
      fpaths.push({type:'Feature',properties:{color:isPointOnRoute(mid,rp,30)?'#7C3AED':'#f97316'},geometry:{type:'LineString',coordinates:[[ap[i].lng,ap[i].lat],[ap[i+1].lng,ap[i+1].lat]]}});
    }
    if(rp&&rp.length>=2){
      fplanned.push({type:'Feature',properties:{},geometry:{type:'LineString',coordinates:rp.map(function(p){return [p.lng,p.lat];})}});
    }
    var initial=(f.name||'?').charAt(0).toUpperCase();
    var label=f.name||(f.destinationName?'Friend':'Friend');
    var el=document.createElement('div');
    el.className='friend-marker';
    el.innerHTML='<div class="friend-dot">'+initial+'</div><div>'+label+'</div>';
    friendMarkersDom.push(new maplibregl.Marker({element:el,anchor:'center'}).setLngLat([f.lng,f.lat]).addTo(map));
  });

  (d.roadLabels||[]).forEach(function(l){
    var t=(l.name||'').slice(0,12);
    var el=document.createElement('div'); el.className='road-label'; el.style.background=l.color||'#111827'; el.textContent=t;
    roadLabelMarkers.push(new maplibregl.Marker({element:el,anchor:'center'}).setLngLat([l.lng,l.lat]).addTo(map));
  });

  map.getSource('unselected-routes').setData({type:'FeatureCollection',features:unsel});
  map.getSource('route-traversed').setData({type:'FeatureCollection',features:trav});
  map.getSource('route-segments').setData({type:'FeatureCollection',features:segs});
  map.getSource('route-remaining').setData({type:'FeatureCollection',features:rem});
  map.getSource('safety-markers').setData({type:'FeatureCollection',features:safety});
  map.getSource('friend-paths').setData({type:'FeatureCollection',features:fpaths});
  map.getSource('friend-planned-routes').setData({type:'FeatureCollection',features:fplanned});

  if(d.origin&&d.maxDistanceKm&&d.maxDistanceKm>0&&!d.navLocation){
    map.getSource('range-circle').setData({type:'FeatureCollection',features:[makeCirclePolygon(d.origin.lng,d.origin.lat,d.maxDistanceKm,64)]});
  } else {
    map.getSource('range-circle').setData(makeEmptyFC());
  }

  if(d.navLocation){
    var h=Number(d.navHeading||0);
    lastNavLL=[d.navLocation.lng,d.navLocation.lat];
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44"><circle cx="22" cy="22" r="19" fill="#1570EF" stroke="white" stroke-width="3"/><polygon points="22,7 29,27 22,22 15,27" fill="white" transform="rotate('+(-h)+',22,22)"/></svg>';
    var ne=document.createElement('div'); ne.innerHTML='<img src="data:image/svg+xml;charset=UTF-8,'+encodeURIComponent(svg)+'" width="44" height="44"/>';
    navMarker=new maplibregl.Marker({element:ne,anchor:'center'}).setLngLat(lastNavLL).addTo(map);
    if(!userInteracted){
      setFollowMode(true);
      map.easeTo({center:lastNavLL,zoom:isPipMode?15.5:17.5,pitch:isPipMode?45:60,bearing:h,duration:500});
    }
    isNavMode=true;
  } else {
    if(isNavMode){map.easeTo({pitch:0,bearing:0,duration:600});}
    userInteracted=false; setFollowMode(true); isNavMode=false;
  }

  if(d.fitBounds&&bounds&&!d.navLocation){map.fitBounds(bounds,{padding:40,maxZoom:16,duration:600});}
  if(d.panTo){map.easeTo({center:[d.panTo.lng,d.panTo.lat],zoom:Math.max(map.getZoom(),16),duration:500});}
}

function setMapType(type){
  if(type==='roadmap'){
    setRoadmapStyleWithFallback(0);
    return;
  }
  var style=mapStyles[type]||mapStyles.roadmap;
  styleReady=false;
  clearStyleFallbackTimer();
  map.setStyle(style);
}

window.setPipMode=function(pip){
  isPipMode=!!pip;
  var ctrl=document.querySelector('.map-ctrl'); if(ctrl) ctrl.style.display=isPipMode?'none':'flex';
};

window.recenterNavigation=function(){
  userInteracted=false;
  setFollowMode(true);
  if(isNavMode&&lastNavLL){map.easeTo({center:lastNavLL,zoom:isPipMode?15.5:17.5,pitch:isPipMode?45:60,duration:500});}
};

window.setVizProgress=function(_pct,_msg){};
window.startVizStream=function(_v){};
window.stopVizStream=function(){};

window.setMapType=setMapType;
window.updateMap=updateMap;

map.on('load',function(){
  styleReady=true;
  clearStyleFallbackTimer();
  addSources();
  addLayers();
  add3DBuildings();
  sendMsg('ready',{});
});

map.on('error',function(){
  if(styleReady) return;
  var styleCandidates=[mapStyles.roadmap, roadmapFallbackStyle, roadmapRasterFallbackStyle];
  if(roadmapStyleIndex < styleCandidates.length - 1){
    setRoadmapStyleWithFallback(roadmapStyleIndex + 1);
  }
});

map.on('styledata',function(){
  if(!map||!map.isStyleLoaded()) return;
  addSources(); addLayers(); add3DBuildings(); styleReady=true;
  clearStyleFallbackTimer();
  if(lastData) updateMap(lastData);
});

map.on('contextmenu',function(e){sendMsg('longpress',{lat:e.lngLat.lat,lng:e.lngLat.lng});});
map.on('mousedown',function(e){touchStart=Date.now();longPressLatLng=e.lngLat;longPressTimer=setTimeout(function(){if(longPressLatLng)sendMsg('longpress',{lat:longPressLatLng.lat,lng:longPressLatLng.lng});},600);});
map.on('mousemove',function(){if(longPressTimer){clearTimeout(longPressTimer);longPressTimer=null;}});
map.on('mouseup',function(){if(longPressTimer){clearTimeout(longPressTimer);longPressTimer=null;}});
map.on('click',function(e){if(Date.now()-touchStart<500){sendMsg('press',{lat:e.lngLat.lat,lng:e.lngLat.lng});}});
map.on('dragstart',function(){if(isNavMode){userInteracted=true;setFollowMode(false);}});

// ── Pathfinding viz animation ──────────────────────────────────────────────
<\/script>
</body></html>`;

// ─────────────────────────────────────────────────────────────────────────────
// React component — embeds MapLibre via iframe srcDoc on web
// ─────────────────────────────────────────────────────────────────────────────

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
  highlightCategory,
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
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  const [hasError, setHasError] = useState(false);
  const prevGeoKeyRef = useRef("");
  const prevPanKeyRef = useRef(-1);
  const prevVizUrlRef = useRef<string | null>(null);

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

  const vizStateRef = useRef({
    vizStreamUrl,
    vizProgressPct,
    vizProgressMessage,
  });
  vizStateRef.current = {
    vizStreamUrl,
    vizProgressPct,
    vizProgressMessage,
  };

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
    highlightCategory,
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
    highlightCategory,
    maxDistanceKm,
    friendMarkers,
    isInPipMode,
  };

  const pushUpdate = useCallback(() => {
    if (!readyRef.current || !iframeRef.current?.contentWindow) return;
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
      highlightCategory: p.highlightCategory || null,
      maxDistanceKm: p.maxDistanceKm || null,
      friendMarkers: p.friendMarkers.map((f) => ({
        name: f.name,
        lat: f.lat,
        lng: f.lng,
        destinationName: f.destinationName || null,
        path: f.path ?? [],
        routePath: f.routePath ?? [],
      })),
      isInPipMode: p.isInPipMode || false,
    };

    try {
      const win = iframeRef.current.contentWindow as any;
      if (win.updateMap) win.updateMap(payload);
    } catch {
      /* cross-origin */
    }
  }, []);

  // Listen for messages from the MapLibre iframe
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      try {
        const msg =
          typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        const cbs = callbacksRef.current;
        switch (msg.type) {
          case "ready":
            readyRef.current = true;
            pushUpdate();
            // Fire any pending viz stream that arrived before ready
            try {
              const viz = vizStateRef.current;
              if (viz.vizStreamUrl && iframeRef.current?.contentWindow) {
                const win = iframeRef.current.contentWindow as any;
                if (win.startVizStream) win.startVizStream(viz.vizStreamUrl);
                if (win.setVizProgress)
                  win.setVizProgress(
                    viz.vizProgressPct,
                    viz.vizProgressMessage || "",
                  );
              }
            } catch {
              /* ignore */
            }
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
        /* ignore */
      }
    };

    window.addEventListener("message", handler);
    const custom = (e: Event) =>
      handler({ data: (e as CustomEvent).detail } as MessageEvent);
    window.addEventListener("leaflet-msg", custom);
    return () => {
      window.removeEventListener("message", handler);
      window.removeEventListener("leaflet-msg", custom);
    };
  }, [pushUpdate]);

  // Push when props change
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
    highlightCategory,
    maxDistanceKm,
    friendMarkers,
    isInPipMode,
    pushUpdate,
  ]);

  // Switch tile layer on mapType change
  useEffect(() => {
    if (!readyRef.current || !iframeRef.current?.contentWindow) return;
    if (mapType === prevMapTypeRef.current) return;
    prevMapTypeRef.current = mapType;
    try {
      const win = iframeRef.current.contentWindow as any;
      if (win.setMapType) win.setMapType(mapType);
    } catch {
      /* ignore */
    }
  }, [mapType]);

  // Immediate PiP injection — set iframe.setPipMode without waiting for full update
  useEffect(() => {
    if (!readyRef.current || !iframeRef.current?.contentWindow) return;
    try {
      const win = iframeRef.current.contentWindow as any;
      if (win && win.setPipMode) win.setPipMode(isInPipMode ? true : false);
    } catch {}
  }, [isInPipMode]);

  useEffect(() => {
    if (!readyRef.current || !iframeRef.current?.contentWindow) return;
    try {
      const win = iframeRef.current.contentWindow as any;
      if (win && win.recenterNavigation) win.recenterNavigation();
    } catch {}
  }, [recenterSignal]);

  // ── Start/stop pathfinding visualisation in the map iframe ──
  useEffect(() => {
    if (vizStreamUrl === prevVizUrlRef.current) return;
    prevVizUrlRef.current = vizStreamUrl;
    if (!readyRef.current || !iframeRef.current?.contentWindow) return;
    try {
      const win = iframeRef.current.contentWindow as any;
      if (vizStreamUrl) {
        if (win.startVizStream) win.startVizStream(vizStreamUrl);
      } else {
        if (win.stopVizStream) win.stopVizStream();
      }
    } catch {
      /* cross-origin */
    }
  }, [vizStreamUrl]);

  useEffect(() => {
    if (!readyRef.current || !iframeRef.current?.contentWindow) return;
    try {
      const win = iframeRef.current.contentWindow as any;
      if (win.setVizProgress)
        win.setVizProgress(vizProgressPct, vizProgressMessage || "");
    } catch {
      /* ignore */
    }
  }, [vizProgressPct, vizProgressMessage]);

  // Keep map HTML stable across renders; srcDoc avoids blob URL loading issues.
  const mapHtml = useMemo(() => buildMapLibreHtml(), []);

  return (
    <View style={styles.container}>
      <iframe
        ref={iframeRef as any}
        srcDoc={mapHtml}
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          position: "absolute",
          top: 0,
          left: 0,
        }}
        title="Map"
        onError={() => setHasError(true)}
      />
      {hasError ? (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>Map unavailable</Text>
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f2f4f7" },
  placeholder: { flex: 1, alignItems: "center", justifyContent: "center" },
  placeholderText: { color: "#667085", fontSize: 14 },
});

export default RouteMap;
