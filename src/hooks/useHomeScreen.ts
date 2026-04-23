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
import { useSafeRoutes } from "@/src/hooks/useSafeRoutes";
import { reverseGeocode } from "@/src/services/openStreetMap";
import type { SafeRoute } from "@/src/services/safeRoutes";
import type { SafetyMapResult } from "@/src/services/safetyMapData";
import type {
  DirectionsRoute,
  LatLng,
  PlaceDetails,
  PlacePrediction,
} from "@/src/types/geo";

const FAKE_PROGRESS_MESSAGES = [
  "Preparing route analysis…",
  "Discovering nearby walkable roads…",
  "Building route corridor…",
  "Scoring lighting and crime factors…",
  "Ranking safest route options…",
];

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

  // ── Origin mode ──
  const [isUsingCurrentLocation, setIsUsingCurrentLocation] = useState(true);

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
    status: locationStatus,
    location,
    error: locationError,
    refresh: refreshLocation,
  } = useCurrentLocation({ enabled: hasAccepted || isWebGuest });
  const [locationWatchdogExpired, setLocationWatchdogExpired] =
    useState(false);

  useEffect(() => {
    if (Platform.OS !== "web") {
      setLocationWatchdogExpired(false);
      return;
    }

    if (!isUsingCurrentLocation || location) {
      setLocationWatchdogExpired(false);
      return;
    }

    if (locationStatus === "denied" || locationStatus === "error") {
      setLocationWatchdogExpired(true);
      return;
    }

    const timer = setTimeout(() => {
      setLocationWatchdogExpired(true);
    }, 12000);

    return () => clearTimeout(timer);
  }, [isUsingCurrentLocation, location, locationStatus]);

  const needsLocationRecovery = useMemo(() => {
    if (Platform.OS !== "web") return false;
    if (!isUsingCurrentLocation || location) return false;
    return (
      locationStatus === "denied" ||
      locationStatus === "error" ||
      locationWatchdogExpired
    );
  }, [
    isUsingCurrentLocation,
    location,
    locationStatus,
    locationWatchdogExpired,
  ]);

  const locationRecoveryReason = useMemo<
    "denied" | "error" | "timeout" | null
  >(() => {
    if (!needsLocationRecovery) return null;
    if (locationStatus === "denied") return "denied";
    if (locationStatus === "error") return "error";
    return "timeout";
  }, [needsLocationRecovery, locationStatus]);

  // ── Origin ──
  const originSearch = useAutoPlaceSearch(location, {
    subscriptionTier,
  });
  const [manualOrigin, setManualOrigin] = useState<PlaceDetails | null>(null);

  // ── Destination ──
  const destSearch = useAutoPlaceSearch(location, {
    subscriptionTier,
  });
  const [manualDest, setManualDest] = useState<PlaceDetails | null>(null);
  const [selectedDestinationCandidateId, setSelectedDestinationCandidateId] =
    useState<string | null>(null);
  const [destinationCandidatesFitToken, setDestinationCandidatesFitToken] =
    useState(0);

  // ── Route selection ──
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [mapPanTo, setMapPanTo] = useState<{
    location: LatLng;
    key: number;
  } | null>(null);
  const prevIsUsingCurrentLocationRef = useRef(isUsingCurrentLocation);
  const hasAutoCenteredCurrentLocationRef = useRef(false);
  const [mapType, setMapType] = useState<MapType>("roadmap");
  const [pinMode, setPinMode] = useState<
    "origin" | "destination" | "via" | null
  >(null);
  const [highlightCategory, setHighlightCategory] = useState<string | null>(
    null,
  );

  // ── Via / direction-bias waypoint ──
  const [viaPinLocation, setViaPinLocation] = useState<LatLng | null>(null);
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

  // Destination candidates shown when user has typed a destination query
  // but has not yet selected a concrete place.
  const destinationCandidates = useMemo<PlacePrediction[]>(() => {
    if (manualDest || destSearch.place) return [];
    const q = destSearch.query.trim();
    if (q.length < 2) return [];
    return (destSearch.predictions || []).filter((p) => Boolean(p.location));
  }, [manualDest, destSearch.place, destSearch.query, destSearch.predictions]);

  useEffect(() => {
    if (destinationCandidates.length === 0) {
      setSelectedDestinationCandidateId(null);
      return;
    }
    const exists = destinationCandidates.some(
      (p) => p.placeId === selectedDestinationCandidateId,
    );
    if (!exists) {
      setSelectedDestinationCandidateId(destinationCandidates[0].placeId);
    }
  }, [destinationCandidates, selectedDestinationCandidateId]);

  const selectedDestinationCandidate = useMemo<PlacePrediction | null>(
    () =>
      destinationCandidates.find(
        (p) => p.placeId === selectedDestinationCandidateId,
      ) ?? null,
    [destinationCandidates, selectedDestinationCandidateId],
  );

  const selectDestinationCandidate = useCallback(
    (placeId: string, panToCandidate = true) => {
      const candidate =
        destinationCandidates.find((p) => p.placeId === placeId) ?? null;
      if (!candidate) return;
      setSelectedDestinationCandidateId(candidate.placeId);
      if (panToCandidate && candidate.location) {
        setMapPanTo({ location: candidate.location, key: Date.now() });
      }
    },
    [destinationCandidates],
  );

  const activateSelectedDestinationCandidate = useCallback(() => {
    const candidate = selectedDestinationCandidate ?? destinationCandidates[0];
    if (!candidate) return false;

    destSearch.selectPrediction(candidate);
    setManualDest(null);
    setSelectedRouteId(null);

    if (candidate.location) {
      setMapPanTo({ location: candidate.location, key: Date.now() });
    }
    return true;
  }, [
    selectedDestinationCandidate,
    destinationCandidates,
    destSearch,
    setManualDest,
  ]);

  const destinationCandidateMarkers = useMemo(() => {
    return destinationCandidates
      .filter((p) => Boolean(p.location))
      .map((p, idx) => ({
        id: `search-candidate:${p.placeId}`,
        kind: "shop",
        coordinate: {
          latitude: p.location!.latitude,
          longitude: p.location!.longitude,
        },
        label: p.fullText || p.primaryText || `Search result ${idx + 1}`,
      }));
  }, [destinationCandidates]);

  const previousCandidateViewportKeyRef = useRef<string>("");
  useEffect(() => {
    if (manualDest || destSearch.place) {
      previousCandidateViewportKeyRef.current = "";
      return;
    }

    const queryKey = destSearch.query.trim().toLowerCase();
    if (queryKey.length < 2 || destinationCandidates.length === 0) {
      previousCandidateViewportKeyRef.current = "";
      return;
    }

    const candidateIds = destinationCandidates.map((p) => p.placeId).join(",");
    const viewportKey = `${queryKey}|${candidateIds}`;
    if (viewportKey === previousCandidateViewportKeyRef.current) {
      return;
    }

    previousCandidateViewportKeyRef.current = viewportKey;
    setDestinationCandidatesFitToken((prev) => prev + 1);
  }, [manualDest, destSearch.place, destSearch.query, destinationCandidates]);

  const handleMapMarkerSelect = useCallback(
    (markerId: string) => {
      if (!markerId.startsWith("search-candidate:")) return;
      const placeId = markerId.slice("search-candidate:".length);
      if (!placeId) return;
      selectDestinationCandidate(placeId, false);
    },
    [selectDestinationCandidate],
  );

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

  // ── Local-only progress for loading animation (no backend stream dependency) ──
  const [vizProgressPct, setVizProgressPct] = useState<number | null>(null);
  const [vizProgressMessage, setVizProgressMessage] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (directionsStatus !== "loading") {
      setVizProgressPct(null);
      setVizProgressMessage(null);
      return;
    }

    setVizProgressPct(20);
    setVizProgressMessage(FAKE_PROGRESS_MESSAGES[0]);

    let stageIdx = 0;
    const tick = setInterval(() => {
      setVizProgressPct((prev) => {
        const current = typeof prev === "number" ? prev : 20;
        if (current >= 90) return 90;
        const inc = current < 50 ? 3 : current < 75 ? 2 : 1;
        return Math.min(90, current + inc);
      });
    }, 700);

    const rotate = setInterval(() => {
      stageIdx = (stageIdx + 1) % FAKE_PROGRESS_MESSAGES.length;
      setVizProgressMessage(FAKE_PROGRESS_MESSAGES[stageIdx]);
    }, 2200);

    return () => {
      clearInterval(tick);
      clearInterval(rotate);
    };
  }, [directionsStatus]);

  // ── Pathfinding visualisation (client-side coords for map animation) ──
  const vizStreamUrl = useMemo(() => {
    if (directionsStatus !== "loading" || !effectiveOrigin || !routingDestination) {
      return null;
    }

    return JSON.stringify({
      oLat: effectiveOrigin.latitude,
      oLng: effectiveOrigin.longitude,
      dLat: routingDestination.latitude,
      dLng: routingDestination.longitude,
    });
  }, [
    directionsStatus,
    effectiveOrigin?.latitude,
    effectiveOrigin?.longitude,
    routingDestination?.latitude,
    routingDestination?.longitude,
  ]);

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

  // Pan to current location only on first GPS fix or when current-location mode is re-enabled.
  // Avoid recentering on every location update because that can fight manual map drags.
  useEffect(() => {
    const justEnabledCurrentLocation =
      isUsingCurrentLocation && !prevIsUsingCurrentLocationRef.current;
    prevIsUsingCurrentLocationRef.current = isUsingCurrentLocation;

    if (!isUsingCurrentLocation || !location) return;

    if (justEnabledCurrentLocation || !hasAutoCenteredCurrentLocationRef.current) {
      setMapPanTo({ location, key: Date.now() });
      hasAutoCenteredCurrentLocationRef.current = true;
    }
  }, [location, isUsingCurrentLocation]);

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
      const name = p.name || p.amenity || "Place";
      const status = p.open === true
        ? (p.nextChange ? ` · Open, ${p.nextChange}` : " · Open now")
        : p.open === false
          ? (p.nextChange ? ` · Closed, ${p.nextChange}` : " · Closed")
          : " · Hours unknown";
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
    const baseSegments = selectedSafeRoute.enrichedSegments.map((seg, i) => ({
      id: `seg-${i}`,
      path: [seg.startCoord, seg.endCoord],
      color: seg.color,
      score: seg.safetyScore,
    }));

    const lightUncertaintySegments = (selectedSafeRoute.lightUncertaintySpans || []).map((span, i) => ({
      id: `light-gap-${i}`,
      path: [
        { latitude: span.start.lat, longitude: span.start.lng },
        { latitude: span.end.lat, longitude: span.end.lng },
      ],
      color: span.reason === 'explicit_dark' ? '#DC2626' : '#F59E0B',
      score: span.confidence ?? 0,
    }));

    const generalUncertaintyBoxes = (
      selectedSafeRoute.generalUncertaintyBoxes?.length
        ? selectedSafeRoute.generalUncertaintyBoxes
        : selectedSafeRoute.uncertaintyBoxes || []
    ).flatMap((box, i) => {
      const sw = { latitude: box.south, longitude: box.west };
      const nw = { latitude: box.north, longitude: box.west };
      const ne = { latitude: box.north, longitude: box.east };
      const se = { latitude: box.south, longitude: box.east };
      return [
        { id: `general-box-${i}-0`, path: [sw, nw], color: '#C026D3', score: 0 },
        { id: `general-box-${i}-1`, path: [nw, ne], color: '#C026D3', score: 0 },
        { id: `general-box-${i}-2`, path: [ne, se], color: '#C026D3', score: 0 },
        { id: `general-box-${i}-3`, path: [se, sw], color: '#C026D3', score: 0 },
      ];
    });

    return [...baseSegments, ...lightUncertaintySegments, ...generalUncertaintyBoxes];
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
    setSelectedDestinationCandidateId(null);
    setSelectedRouteId(null);
    setViaPinLocation(null);
    setHighlightCategory(null);
  }, [destSearch]);

  /** Swap origin and destination. */
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
    locationStatus,
    locationError,
    needsLocationRecovery,
    locationRecoveryReason,
    refreshLocation,

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
    destinationCandidates,
    destinationCandidatesFitToken,
    selectedDestinationCandidateId,
    selectedDestinationCandidate,
    selectDestinationCandidate,
    activateSelectedDestinationCandidate,
    destinationCandidateMarkers,
    handleMapMarkerSelect,

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

    // Safety
    safetyResult,
    poiMarkers: displayMarkers,
    routeSegments,
    roadLabels,
    highlightCategory,
    setHighlightCategory,

    // Pathfinding visualisation
    vizStreamUrl,
    vizProgressPct,
    vizProgressMessage,

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
