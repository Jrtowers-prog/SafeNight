/**
 * useHomeScreen — Centralised business logic for the Home screen.
 *
 * Pulls together onboarding, location, search, routing, safety, navigation
 * and AI explanation into a single hook.  The screen component just renders
 * the returned state — zero business logic in the JSX tree.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Dimensions, Keyboard, Platform } from "react-native";

import type { MapType } from "@/src/components/maps/RouteMap.types";
import { SHEET_DEFAULT } from "@/src/components/sheets/DraggableSheet";
import { useAIExplanation } from "@/src/hooks/useAIExplanation";
import type { RouteScore } from "@/src/hooks/useAllRoutesSafety";
import { useAuth } from "@/src/hooks/useAuth";
import { useAutoPlaceSearch } from "@/src/hooks/useAutoPlaceSearch";
import { useCurrentLocation } from "@/src/hooks/useCurrentLocation";
import { useNavigation } from "@/src/hooks/useNavigation";
import { useOnboarding } from "@/src/hooks/useOnboarding";
import { usePathfindingVisualization } from "@/src/hooks/usePathfindingVisualization";
import { useSafeRoutes } from "@/src/hooks/useSafeRoutes";
import { reverseGeocode } from "@/src/services/openStreetMap";
import type { SafeRoute, SafetyLevel } from "@/src/services/safeRoutes";
import type { SafetyMapResult } from "@/src/services/safetyMapData";
import type { DirectionsRoute, LatLng, PlaceDetails } from "@/src/types/google";

// ── Public interface ────────────────────────────────────────────────────────

export function useHomeScreen() {
  // ── Onboarding ──
  const {
    status: onboardingStatus,
    hasAccepted,
    error: onboardingError,
    accept,
  } = useOnboarding();
  const [showOnboarding, setShowOnboarding] = useState(false);

  // ── Auth ──
  const { user } = useAuth();
  const subscriptionTier = user?.subscription ?? "free";
  const routeDistanceKm = user?.routeDistanceKm;

  // ── Web guest detection (must be before onboarding effect) ──
  const isWebGuest = Platform.OS === "web" && !user;

  // Auto-accept onboarding for web guests (no modal needed)
  useEffect(() => {
    if (isWebGuest && onboardingStatus === "ready" && !hasAccepted) {
      accept();
      return;
    }
    if (onboardingStatus === "ready" && !hasAccepted) setShowOnboarding(true);
  }, [onboardingStatus, hasAccepted, isWebGuest, accept]);

  // ── Location ──
  // On web for guests, enable location immediately (onboarding is auto-accepted)
  const {
    location,
    error: locationError,
    refresh: refreshLocation,
  } = useCurrentLocation({ enabled: hasAccepted || isWebGuest });

  // ── Origin ──
  const [isUsingCurrentLocation, setIsUsingCurrentLocation] = useState(true);
  const originSearch = useAutoPlaceSearch(location);
  const [manualOrigin, setManualOrigin] = useState<PlaceDetails | null>(null);

  // ── Destination ──
  const destSearch = useAutoPlaceSearch(location);
  const [manualDest, setManualDest] = useState<PlaceDetails | null>(null);

  // ── Route selection ──
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [mapPanTo, setMapPanTo] = useState<{
    location: LatLng;
    key: number;
  } | null>(null);
  const [mapType, setMapType] = useState<MapType>("roadmap");
  const [pinMode, setPinMode] = useState<
    "origin" | "destination" | "via" | null
  >(null);
  const [highlightCategory, setHighlightCategory] = useState<string | null>(
    null,
  );

  // ── Via / direction-bias waypoint ──
  const [viaPinLocation, setViaPinLocation] = useState<LatLng | null>(null);

  // ── Safety data level (Extra = full dataset, Standard = faster) ──
  const [safetyLevel, setSafetyLevel] = useState<SafetyLevel>("extra");
  const clearViaPin = useCallback(() => setViaPinLocation(null), []);

  // ── AI ──
  const [showAIModal, setShowAIModal] = useState(false);

  // ── Bottom sheet ──
  const SCREEN_HEIGHT = Dimensions.get("window").height;
  const sheetHeight = useRef(new Animated.Value(SHEET_DEFAULT)).current;
  const sheetHeightRef = useRef(SHEET_DEFAULT);

  // ── Derived origins / destinations ──
  const effectiveOrigin = isUsingCurrentLocation
    ? location
    : (manualOrigin?.location ?? originSearch.place?.location ?? null);
  const effectiveDestination =
    manualDest?.location ?? destSearch.place?.location ?? null;

  // For web guests, don't pass destination to safe routes API (no real fetch)
  const routingDestination = isWebGuest ? null : effectiveDestination;

  // ── Safe routes ──
  const {
    status: safeRoutesStatus,
    routes: safeRoutes,
    safestRoute,
    error: safeRoutesError,
    outOfRange,
    outOfRangeMessage,
    meta: safeRoutesMeta,
  } = useSafeRoutes(
    effectiveOrigin,
    routingDestination,
    subscriptionTier,
    routeDistanceKm,
    viaPinLocation,
    safetyLevel,
  );

  // Clear via-pin whenever the destination changes so stale waypoints don't carry over
  const prevDestRef = useRef<LatLng | null>(null);
  useEffect(() => {
    const d = routingDestination;
    if (d !== prevDestRef.current) {
      prevDestRef.current = d;
      setViaPinLocation(null);
    }
  }, [routingDestination]);

  const routes: DirectionsRoute[] = safeRoutes;
  const directionsStatus = safeRoutesStatus;
  const directionsError = safeRoutesError;
  const bestRouteId = safestRoute?.id ?? null;

  // ── Pathfinding visualisation (client-side coords for WebView animation) ──
  const vizStreamUrl = useMemo(() => {
    if (
      directionsStatus !== "loading" ||
      !effectiveOrigin ||
      !routingDestination
    )
      return null;
    return JSON.stringify({
      oLat: effectiveOrigin.latitude,
      oLng: effectiveOrigin.longitude,
      dLat: routingDestination.latitude,
      dLng: routingDestination.longitude,
    });
  }, [directionsStatus, effectiveOrigin, routingDestination]);

  // Live progress needs the search identity (id/client/seq) that the safe-routes
  // request sends. The client does not send those headers yet, so the stream
  // stays idle and progress stays null until that wiring is added.
  const pathViz = usePathfindingVisualization(
    effectiveOrigin,
    routingDestination,
    directionsStatus === "loading",
    null,
    null,
    null,
  );

  // ── Route scores ──
  const routeScores: Record<string, RouteScore> = useMemo(() => {
    const scores: Record<string, RouteScore> = {};
    for (const r of safeRoutes) {
      scores[r.id] = {
        routeId: r.id,
        score: r.safety.score,
        pathfindingScore: r.safety.score,
        label: r.safety.label,
        color: r.safety.color,
        mainRoadRatio: r.safety.mainRoadRatio / 100,
        dataConfidence: 1,
        status: "done",
      };
    }
    return scores;
  }, [safeRoutes]);

  // ── Effects ──

  // Reset sheet when routes change
  useEffect(() => {
    if (routes.length > 0) {
      Animated.spring(sheetHeight, {
        toValue: SHEET_DEFAULT,
        useNativeDriver: false,
      }).start();
      sheetHeightRef.current = SHEET_DEFAULT;
    }
  }, [routes.length]);

  // Clear manual dest when user starts typing
  useEffect(() => {
    if (destSearch.query.length > 0) setManualDest(null);
  }, [destSearch.query]);

  // Pan to location on first fix
  useEffect(() => {
    if (location && isUsingCurrentLocation) {
      setMapPanTo({ location, key: Date.now() });
    }
  }, [location !== null]);

  // Auto-select safest route
  useEffect(() => {
    if (bestRouteId) setSelectedRouteId(bestRouteId);
    else if (routes.length > 0) setSelectedRouteId(routes[0].id);
  }, [routes, bestRouteId]);

  // ── Selected route derivations ──
  const selectedRoute = useMemo<DirectionsRoute | null>(
    () => routes.find((r) => r.id === selectedRouteId) ?? null,
    [routes, selectedRouteId],
  );

  const selectedSafeRoute = useMemo<SafeRoute | null>(
    () =>
      (safeRoutes as SafeRoute[]).find((r) => r.id === selectedRouteId) ?? null,
    [safeRoutes, selectedRouteId],
  );

  // ── POI markers ──
  const poiMarkers = useMemo(() => {
    const pois = selectedSafeRoute?.routePOIs;
    if (!pois) return [];
    const markers: Array<{
      id: string;
      kind: string;
      coordinate: { latitude: number; longitude: number };
      label: string;
    }> = [];
    pois.cctv?.forEach((c, i) =>
      markers.push({
        id: `poi-cctv-${i}`,
        kind: "cctv",
        coordinate: { latitude: c.lat, longitude: c.lng },
        label: "CCTV Camera",
      }),
    );
    pois.transit?.forEach((t, i) =>
      markers.push({
        id: `poi-transit-${i}`,
        kind: "bus_stop",
        coordinate: { latitude: t.lat, longitude: t.lng },
        label: "Transit Stop",
      }),
    );
    pois.deadEnds?.forEach((d, i) =>
      markers.push({
        id: `poi-deadend-${i}`,
        kind: "dead_end",
        coordinate: { latitude: d.lat, longitude: d.lng },
        label: "Dead End",
      }),
    );
    pois.lights?.forEach((l, i) =>
      markers.push({
        id: `poi-light-${i}`,
        kind: "light",
        coordinate: { latitude: l.lat, longitude: l.lng },
        label: "Street Light",
      }),
    );
    pois.places?.forEach((p: any, i: number) => {
      // Only show confirmed-open places
      if (p.open !== true) return;
      const name = p.name || p.amenity || "Place";
      const status = p.nextChange ? ` · Open, ${p.nextChange}` : " · Open now";
      markers.push({
        id: `poi-place-${i}`,
        kind: "shop",
        coordinate: { latitude: p.lat, longitude: p.lng },
        label: `${name}${status}`,
      });
    });
    pois.crimes?.forEach((cr, i) =>
      markers.push({
        id: `poi-crime-${i}`,
        kind: "crime",
        coordinate: { latitude: cr.lat, longitude: cr.lng },
        label: cr.category || "Crime",
      }),
    );
    return markers;
  }, [selectedSafeRoute]);

  // ── Filtered markers when a category is highlighted ──
  const displayMarkers = useMemo(() => {
    if (!highlightCategory) return poiMarkers;
    return poiMarkers.filter((m) => m.kind === highlightCategory);
  }, [poiMarkers, highlightCategory]);

  // ── Safety result derived from SafeRoute ──
  const safetyResult = useMemo<SafetyMapResult | null>(() => {
    if (!selectedSafeRoute) return null;
    const s = selectedSafeRoute.safety;
    const stats = selectedSafeRoute.routeStats;
    const pois = selectedSafeRoute.routePOIs;
    const segs = selectedSafeRoute.enrichedSegments ?? [];

    // Count lit vs unlit segments for the lighting ratio
    let litSegments = 0;
    let unlitSegments = 0;
    for (const seg of segs) {
      if (seg.lightScore > 0.5) litSegments++;
      else unlitSegments++;
    }

    // Use actual POI counts so every number matches what's on the map
    const crimeCount = pois?.crimes?.length ?? 0;
    const lightCount = pois?.lights?.length ?? 0;
    const openPlaceCount = pois?.places?.length ?? 0;
    const cctvCount = pois?.cctv?.length ?? 0;

    return {
      markers: [],
      roadOverlays: [],
      roadLabels: [],
      routeSegments: [],
      crimeCount,
      streetLights: lightCount,
      cctvCount,
      litRoads: litSegments,
      unlitRoads: unlitSegments,
      openPlaces: openPlaceCount,
      busStops: pois?.transit?.length ?? 0,
      safetyScore: s.score,
      safetyLabel: s.label,
      safetyColor: s.color,
      mainRoadRatio: s.mainRoadRatio / 100,
      pathfindingScore: s.score,
      dataConfidence: 1,
    };
  }, [selectedSafeRoute]);

  // ── Route segments for coloured overlay ──
  const routeSegments = useMemo(() => {
    if (!selectedSafeRoute?.enrichedSegments) return [];
    return selectedSafeRoute.enrichedSegments.map((seg, i) => ({
      id: `seg-${i}`,
      path: [seg.startCoord, seg.endCoord],
      color: seg.color,
      score: seg.safetyScore,
    }));
  }, [selectedSafeRoute]);

  // ── Road labels ──
  const roadLabels = useMemo(() => {
    if (!selectedSafeRoute?.enrichedSegments) return [];
    const seen = new Set<string>();
    const labels: Array<{
      id: string;
      coordinate: { latitude: number; longitude: number };
      roadType: string;
      displayName: string;
      color: string;
    }> = [];
    const typeColors: Record<string, string> = {
      primary: "#2563eb",
      secondary: "#3b82f6",
      tertiary: "#60a5fa",
      residential: "#64748b",
      footway: "#f59e0b",
      path: "#f59e0b",
      pedestrian: "#34d399",
      service: "#94a3b8",
    };
    for (const seg of selectedSafeRoute.enrichedSegments) {
      if (seg.roadName && !seen.has(seg.roadName)) {
        seen.add(seg.roadName);
        labels.push({
          id: `rl-${labels.length}`,
          coordinate: seg.midpointCoord,
          roadType: seg.highway,
          displayName: seg.roadName,
          color: typeColors[seg.highway] || "#64748b",
        });
      }
    }
    return labels;
  }, [selectedSafeRoute]);

  // ── Navigation ──
  const nav = useNavigation(selectedRoute);
  const isNavActive = nav.state === "navigating" || nav.state === "off-route";

  // ── AI Explanation ──
  const ai = useAIExplanation(
    safetyResult,
    routes,
    routeScores,
    bestRouteId,
    safeRoutes as SafeRoute[],
  );

  // ── Map interaction handlers ──

  /** Create an immediate pin, then resolve name in the background. */
  const makePinAndResolve = useCallback(
    (coordinate: LatLng, setter: (pin: PlaceDetails) => void) => {
      const pin: PlaceDetails = {
        placeId: `pin:${coordinate.latitude.toFixed(6)},${coordinate.longitude.toFixed(6)}`,
        name: "Dropped pin",
        location: coordinate,
      };
      setter(pin);
      // Resolve name in background
      reverseGeocode(coordinate)
        .then((resolved) => {
          if (resolved) setter({ ...resolved, location: coordinate });
        })
        .catch(() => {
          /* keep fallback */
        });
    },
    [],
  );

  const handleMapPress = useCallback(
    (coordinate: LatLng) => {
      Keyboard.dismiss();
      if (isNavActive) return;

      if (pinMode === "origin") {
        setIsUsingCurrentLocation(false);
        originSearch.clear();
        destSearch.clear();
        setManualDest(null);
        makePinAndResolve(coordinate, setManualOrigin);
        setPinMode(null);
        setSelectedRouteId(null);
      } else if (pinMode === "destination") {
        destSearch.clear();
        makePinAndResolve(coordinate, setManualDest);
        setPinMode(null);
        setSelectedRouteId(null);
      } else if (pinMode === "via") {
        setViaPinLocation(coordinate);
        setPinMode(null);
      }
    },
    [isNavActive, pinMode, originSearch, destSearch, makePinAndResolve],
  );

  const handleMapLongPress = useCallback(
    (coordinate: LatLng) => {
      Keyboard.dismiss();
      if (isNavActive) return;
      destSearch.clear();
      setSelectedRouteId(null);
      makePinAndResolve(coordinate, setManualDest);
    },
    [isNavActive, destSearch, makePinAndResolve],
  );

  const handleAcceptOnboarding = useCallback(async () => {
    await accept();
    setShowOnboarding(false);
    refreshLocation();
  }, [accept, refreshLocation]);

  const handlePanTo = useCallback((loc: LatLng) => {
    setMapPanTo({ location: loc, key: Date.now() });
  }, []);

  const clearSelectedRoute = useCallback(() => {
    setSelectedRouteId(null);
  }, []);

  const clearRouteResults = useCallback(() => {
    destSearch.clear();
    setManualDest(null);
    setSelectedRouteId(null);
    setViaPinLocation(null);
    setHighlightCategory(null);
  }, [destSearch]);

  /** Swap origin and destination (like Google Maps). */
  const swapOriginAndDest = useCallback(() => {
    // Snapshot current effective values
    const prevOriginIsGPS = isUsingCurrentLocation;
    const prevOriginPlace = originSearch.place;
    const prevManualOrigin = manualOrigin;
    const prevDestPlace = destSearch.place;
    const prevManualDest = manualDest;

    // Destination → new origin
    if (prevManualDest) {
      setManualOrigin(prevManualDest);
      setIsUsingCurrentLocation(false);
      originSearch.clear();
    } else if (prevDestPlace) {
      setManualOrigin({
        placeId: prevDestPlace.placeId ?? `swap-${Date.now()}`,
        name: prevDestPlace.name,
        location: prevDestPlace.location,
      });
      setIsUsingCurrentLocation(false);
      originSearch.clear();
    } else {
      // No destination was set — nothing to swap into origin
      return;
    }

    // Origin → new destination
    if (prevManualOrigin) {
      setManualDest(prevManualOrigin);
      destSearch.clear();
    } else if (!prevOriginIsGPS && prevOriginPlace) {
      setManualDest({
        placeId: prevOriginPlace.placeId ?? `swap-${Date.now()}`,
        name: prevOriginPlace.name,
        location: prevOriginPlace.location,
      });
      destSearch.clear();
    } else if (prevOriginIsGPS && location) {
      // GPS was origin — create a pin from current coords
      setManualDest({
        placeId: `gps-${Date.now()}`,
        name: "Your location",
        location,
      });
      destSearch.clear();
      setIsUsingCurrentLocation(false);
    } else {
      setManualDest(null);
      destSearch.clear();
    }

    setSelectedRouteId(null);
  }, [
    isUsingCurrentLocation,
    originSearch,
    manualOrigin,
    destSearch,
    manualDest,
    location,
  ]);

  return {
    // Onboarding
    showOnboarding,
    setShowOnboarding,
    onboardingError,
    handleAcceptOnboarding,

    // Location
    location,

    // Origin
    isUsingCurrentLocation,
    setIsUsingCurrentLocation,
    originSearch,
    manualOrigin,
    setManualOrigin,

    // Destination
    destSearch,
    manualDest,
    setManualDest,

    // Routing
    routes,
    safeRoutes: safeRoutes as SafeRoute[],
    selectedRouteId,
    setSelectedRouteId,
    selectedRoute,
    selectedSafeRoute,
    directionsStatus,
    directionsError,
    outOfRange,
    outOfRangeMessage,

    // Map
    effectiveOrigin,
    effectiveDestination,
    mapPanTo,
    mapType,
    setMapType,
    pinMode,
    setPinMode,
    handleMapPress,
    handleMapLongPress,
    handlePanTo,
    clearSelectedRoute,
    clearRouteResults,
    swapOriginAndDest,

    // Via / direction-bias
    viaPinLocation,
    clearViaPin,

    // Safety data level (Extra / Standard)
    safetyLevel,
    setSafetyLevel,

    // Safety
    safetyResult,
    poiMarkers: displayMarkers,
    routeSegments,
    roadLabels,
    highlightCategory,
    setHighlightCategory,

    // Pathfinding visualisation
    vizStreamUrl,
    vizProgressPct: directionsStatus === "loading" ? pathViz.pct : null,
    vizProgressMessage: directionsStatus === "loading" ? pathViz.message : null,

    // Sheet
    sheetHeight,
    sheetHeightRef,

    // Navigation
    nav,
    isNavActive,

    // AI
    ai,
    showAIModal,
    setShowAIModal,

    // Web guest
    isWebGuest,
  };
}
