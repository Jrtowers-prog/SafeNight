/**
 * HomeScreen — Main app screen.
 *
 * All business logic lives in useHomeScreen. Each UI section is a
 * standalone component, keeping this file under 200 lines.
 *
 * Android-specific: every overlay is absolutely positioned above the
 * flex-child RouteMap. This is the ONLY reliable z-ordering approach
 * on Android when a WebView (SurfaceView) is involved — no nesting
 * inside the map container.
 */
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
    Animated,
    AppState,
    Platform,
    Pressable,
    StyleSheet,
    Text,
    TouchableOpacity,
    useWindowDimensions,
    View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { PageHead } from "@/src/components/seo/PageHead";

import { AndroidOverlayHost } from "@/src/components/android/AndroidOverlayHost";
import RouteMap from "@/src/components/maps/RouteMap";
import { AIExplanationModal } from "@/src/components/modals/AIExplanationModal";
import { BackgroundLocationModal } from "@/src/components/modals/BackgroundLocationModal";
import { DownloadAppModal } from "@/src/components/modals/DownloadAppModal";
import { FamilyPackModal } from "@/src/components/modals/FamilyPackModal";
import { LimitReachedModal } from "@/src/components/modals/LimitReachedModal";
import LoginModal from "@/src/components/modals/LoginModal";
import { OnboardingModal } from "@/src/components/modals/OnboardingModal";
import { ReportModal } from "@/src/components/modals/ReportModal";
import { SubscriptionModal } from "@/src/components/modals/SubscriptionModal";
import { NavigationOverlay } from "@/src/components/navigation/NavigationOverlay";
import { RouteList } from "@/src/components/routes/RouteList";
import {
    RoadTypeBreakdown,
    SafetyPanel,
} from "@/src/components/safety/SafetyPanel";
import { SafetyProfileChart } from "@/src/components/safety/SafetyProfileChart";
import { MobileWebSearchBar } from "@/src/components/search/MobileWebSearchBar";
import { SearchBar } from "@/src/components/search/SearchBar";
import {
    DraggableSheet,
    SHEET_DEFAULT,
    SHEET_MIN,
} from "@/src/components/sheets/DraggableSheet";
import { MobileWebSheet } from "@/src/components/sheets/MobileWebSheet";
import { WebSidebar } from "@/src/components/sheets/WebSidebar";
import { PlaceResultCard } from "@/src/components/results/PlaceResultCard";
import { AndroidDownloadBanner } from "@/src/components/ui/AndroidDownloadBanner";
import { BuddyButton } from "@/src/components/ui/BuddyButton";
import { JailLoadingAnimation } from "@/src/components/ui/JailLoadingAnimation";
import { MapControlRail } from "@/src/components/ui/MapControlRail";
import { MapToast, type ToastConfig } from "@/src/components/ui/MapToast";
import { ProfileMenu } from "@/src/components/ui/ProfileMenu";
import { WebLoginButton } from "@/src/components/ui/WebLoginButton";
import { useAuth } from "@/src/hooks/useAuth";
import { useContacts } from "@/src/hooks/useContacts";
import { useFriendLocations } from "@/src/hooks/useFriendLocations";
import { useHomeScreen } from "@/src/hooks/useHomeScreen";
import { moveToCurrentLocation } from "../src/utils/currentLocation";
import { fetchPlacePredictions } from "@/src/services/osmDirections";
import type { PlacePrediction, LatLng } from "@/src/types/geo";
import { useLiveTracking } from "@/src/hooks/useLiveTracking";
import { useNavAlerts } from "@/src/hooks/useNavAlerts";
import { useSavedPlaces, type SavedPlace } from "@/src/hooks/useSavedPlaces";
import { useWebBreakpoint } from "@/src/hooks/useWebBreakpoint";
import { stripeApi } from "@/src/services/stripeApi";
import { subscriptionApi } from "@/src/services/userApi";
import { createRouteShareLink, resolveRouteShareLink } from "@/src/services/shareRoute";
import {
    LimitError,
    onLimitReached,
    type LimitInfo,
} from "@/src/types/limitError";
import { formatDistance, formatDuration } from "@/src/utils/format";

const PLACE_CATEGORY_CHIPS: {
  key: string;
  label: string;
  query: string;
  icon: keyof typeof Ionicons.glyphMap;
}[] = [
  { key: "fuel", label: "Fuel", query: "fuel station", icon: "car-sport-outline" },
  { key: "shop", label: "Shops", query: "shops", icon: "bag-handle-outline" },
  { key: "food", label: "Food", query: "restaurants", icon: "restaurant-outline" },
  { key: "school", label: "School", query: "schools", icon: "school-outline" },
  { key: "parking", label: "Parking", query: "parking", icon: "car-outline" },
  { key: "pharmacy", label: "Pharmacy", query: "pharmacy", icon: "medkit-outline" },
  { key: "hospital", label: "Hospital", query: "hospital", icon: "medical-outline" },
  { key: "public_place", label: "Public Places", query: "public places", icon: "business-outline" },
  { key: "bank", label: "Bank", query: "bank", icon: "cash-outline" },
  { key: "hotel", label: "Hotel", query: "hotel", icon: "bed-outline" },
];

const MILES_TO_METERS = 1609.34;
const SEARCH_AROUND_MAX_MILES = 10;
const SHEET_RESULTS_RENDER_LIMIT = 20;
const SEARCH_DISTANCE_FILTER_OPTIONS_MILES = [1, 2, 3, 4, 5, 10] as const;

const FEATURE_FLAGS = {
  phoneResultsCardsV1: true,
  webResultsCardsV1: true,
  routeShareV1: true,
} as const;

const REPORT_LABELS: Record<string, string> = {
  poor_lighting: "Poor Lighting",
  unsafe_area: "Unsafe Area",
  obstruction: "Obstruction",
  harassment: "Harassment",
  other: "Other",
};

function haversineDistanceMeters(a: LatLng, b: LatLng): number {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const earthRadiusMeters = 6371000;
  const deltaLatitude = toRadians(b.latitude - a.latitude);
  const deltaLongitude = toRadians(b.longitude - a.longitude);
  const latitudeA = toRadians(a.latitude);
  const latitudeB = toRadians(b.latitude);
  const x =
    Math.sin(deltaLatitude / 2) * Math.sin(deltaLatitude / 2) +
    Math.cos(latitudeA) *
      Math.cos(latitudeB) *
      Math.sin(deltaLongitude / 2) *
      Math.sin(deltaLongitude / 2);
  const y = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return earthRadiusMeters * y;
}

function classifyPlaceCategory(input: {
  category?: string;
  placeType?: string;
  primaryText?: string;
  fullText?: string;
}): string | null {
  const bucket = `${input.category || ""} ${input.placeType || ""} ${input.primaryText || ""} ${input.fullText || ""}`.toLowerCase();
  if (/\bfuel\b|petrol|gas station|charging_station|charging station/.test(bucket)) return "fuel";
  if (/\bparking\b|car park|park and ride/.test(bucket)) return "parking";
  if (/restaurant|cafe|coffee|pub|bar|fast_food|takeaway|food/.test(bucket)) return "food";
  if (/\bschool\b|university|college|academy|campus|primary school|secondary school/.test(bucket)) return "school";
  if (/pharmacy|chemist|drugstore/.test(bucket)) return "pharmacy";
  if (/hospital|clinic|doctor|medical/.test(bucket)) return "hospital";
  if (/community_centre|community centre|library|town hall|townhall|civic|public building|public place|government|city hall|museum|community hall/.test(bucket)) return "public_place";
  if (/bank|atm/.test(bucket)) return "bank";
  if (/hotel|guest house|accommodation|lodging/.test(bucket)) return "hotel";
  if (/shop|supermarket|convenience|store|retail|mall/.test(bucket)) return "shop";
  return null;
}

export default function HomeScreen() {
  const routeParams = useLocalSearchParams<{ sharedRouteToken?: string | string[] }>();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const h = useHomeScreen();
  const auth = useAuth();
  const { places: savedPlaces, savePlace, removePlace } = useSavedPlaces();
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [showFriendsOnMap, setShowFriendsOnMap] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [showLoginPrompt, setShowLoginPrompt] = useState(false);
  const [limitModal, setLimitModal] = useState<LimitInfo | null>(null);
  const dismissedLimitRef = useRef<Record<string, boolean>>({});
  const [liveSharingNotice, setLiveSharingNotice] = useState<string | null>(null);
  const [showSubscriptionModal, setShowSubscriptionModal] = useState(false);
  const [showFamilyPackModal, setShowFamilyPackModal] = useState(false);
  const [toast, setToast] = useState<ToastConfig | null>(null);
  const [isNavFollowing, setIsNavFollowing] = useState(true);
  const [isAtCurrentLocation, setIsAtCurrentLocation] = useState(false);
  const [isFindingCurrentLocation, setIsFindingCurrentLocation] =
    useState(false);
  const [recenterSignal, setRecenterSignal] = useState(0);
  const [outOfRangeCueSignal, setOutOfRangeCueSignal] = useState(0);
  const [isSearchBarExpanded, setIsSearchBarExpanded] = useState(false);
  const [searchBottomY, setSearchBottomY] = useState<number | null>(null);
  const [nativeSheetTopY, setNativeSheetTopY] = useState(windowHeight);
  const [phoneWebSheetHeight, setPhoneWebSheetHeight] = useState(0);
  const subscriptionTier = auth.user?.subscription ?? "free";
  const maxDistanceKm = auth.user?.routeDistanceKm ?? 3; // DB-driven, fallback to free tier

  // Responsive breakpoint — phone-size web gets a different layout
  const breakpoint = useWebBreakpoint();
  const isPhoneWeb = breakpoint === "phone";
  const isWeb = Platform.OS === "web";
  const isDesktopWeb = isWeb && !isPhoneWeb;
  const [webSidebarOverlayOffset, setWebSidebarOverlayOffset] = useState(404);
  const { width: viewportWidth } = useWindowDimensions();

  // Sheet scroll ref and search-around state
  const sheetScrollRef = useRef<any>(null);
  const [mapCenterForSearch, setMapCenterForSearch] = useState<LatLng | null>(null);
  const [showSearchAroundButton, setShowSearchAroundButton] = useState(false);
  const [accumulatedDestinationCandidates, setAccumulatedDestinationCandidates] = useState<PlacePrediction[]>([]);
  const [searchAnchor, setSearchAnchor] = useState<LatLng | null>(null);
  const [searchAroundLimitReached, setSearchAroundLimitReached] = useState(false);
  const [isSearchAroundLoading, setIsSearchAroundLoading] = useState(false);
  const [searchDistanceFilterMiles, setSearchDistanceFilterMiles] = useState<number>(3);
  const [sheetPlacesFitToken, setSheetPlacesFitToken] = useState(0);
  const [androidFitCandidateBoundsToken, setAndroidFitCandidateBoundsToken] = useState(0);
  const [showMapExtraDetail, setShowMapExtraDetail] = useState(true);
  const [activePlaceCategoryKey, setActivePlaceCategoryKey] = useState<string | null>(null);
  const [selectedSheetCandidateId, setSelectedSheetCandidateId] = useState<string | null>(null);
  const [hasExplicitCandidateSelection, setHasExplicitCandidateSelection] = useState(false);
  const previousSearchQueryRef = useRef("");
  const lastMapCenterForSearchRef = useRef<LatLng | null>(null);
  const lastCandidateAutoFitKeyRef = useRef("");
  const lastAutoExpandedZoneKeyRef = useRef("");
  const lastAndroidFitKeyRef = useRef("");
  const appliedShareTokenRef = useRef<string | null>(null);

  const sharedRouteToken = useMemo(() => {
    const raw = routeParams.sharedRouteToken;
    return Array.isArray(raw) ? raw[0] : raw;
  }, [routeParams.sharedRouteToken]);

  const maxDistanceFilterMiles = useMemo(() => {
    const tier = (subscriptionTier || "free").toLowerCase();
    return tier === "free" ? 5 : 10;
  }, [subscriptionTier]);

  const distanceFilterOptionsMiles = useMemo(
    () => SEARCH_DISTANCE_FILTER_OPTIONS_MILES.filter((miles) => miles <= maxDistanceFilterMiles),
    [maxDistanceFilterMiles],
  );

  const searchAroundFloatingTop = useMemo(() => {
    const baseTop = insets.top + (isWeb ? 36 : 0);
    if (isWeb) {
      if (isPhoneWeb) {
        return baseTop + (isSearchBarExpanded ? 248 : 142);
      }
      return baseTop + 96;
    }
    return baseTop + (isSearchBarExpanded ? 206 : 102);
  }, [insets.top, isWeb, isPhoneWeb, isSearchBarExpanded]);

  const pinBannerOverlayStyle = useMemo(() => {
    if (isWeb) {
      return {
        top: insets.top + 14,
        bottom: "auto" as const,
        left: (isDesktopWeb ? webSidebarOverlayOffset : 0) + 16,
        right: 16,
      };
    }

    return {
      bottom: insets.bottom + 12,
      left: 16,
      right: 16,
      top: "auto" as const,
    };
  }, [insets.bottom, insets.top, isDesktopWeb, isWeb, webSidebarOverlayOffset]);

  useEffect(() => {
    setSearchDistanceFilterMiles((current) => Math.min(current, maxDistanceFilterMiles));
  }, [maxDistanceFilterMiles]);

  useEffect(() => {
    const radiusMiles = h.destSearch.lastSuccessfulRadiusMiles;
    if (radiusMiles == null) return;

    setSearchDistanceFilterMiles((current) => {
      const next = Math.min(radiusMiles, maxDistanceFilterMiles);
      return current === next ? current : next;
    });
  }, [h.destSearch.lastSuccessfulRadiusMiles, maxDistanceFilterMiles]);

  useEffect(() => {
    setSelectedSheetCandidateId(h.selectedDestinationCandidateId);
  }, [h.selectedDestinationCandidateId]);

  useEffect(() => {
    const token = sharedRouteToken?.trim();
    if (!token) return;
    if (appliedShareTokenRef.current === token) return;

    appliedShareTokenRef.current = token;

    resolveRouteShareLink(token)
      .then((share) => {
        if (!share.destination) {
          setToast({
            message: "Shared route has no destination",
            icon: "alert-circle-outline",
            iconColor: "#d92d20",
            duration: 2800,
          });
          return;
        }

        const destinationCandidate: PlacePrediction = {
          placeId: `shared-${share.token}`,
          primaryText: share.destinationName || "Shared destination",
          secondaryText: "Shared route",
          fullText: share.destinationName || "Shared destination",
          location: share.destination,
        };

        h.destSearch.selectPrediction(destinationCandidate);
        h.setManualDest(null);
        h.handlePanTo(share.destination);
        h.clearSelectedRoute();
        setToast({
          message: "Shared route destination loaded",
          icon: "share-social-outline",
          iconColor: "#1570ef",
          duration: 2600,
        });
      })
      .catch((error) => {
        setToast({
          message:
            error instanceof Error
              ? `Unable to open shared route: ${error.message}`
              : "Unable to open shared route",
          icon: "alert-circle-outline",
          iconColor: "#d92d20",
          duration: 3200,
        });
      });
  }, [sharedRouteToken, h]);

  useEffect(() => {
    const query = (h.destSearch?.query || "").trim();
    const normalizedQuery = query.toLowerCase();

    if (normalizedQuery !== previousSearchQueryRef.current) {
      previousSearchQueryRef.current = normalizedQuery;
      setAccumulatedDestinationCandidates([]);
      setSearchAroundLimitReached(false);
      setShowSearchAroundButton(false);
      setSearchAnchor(h.location ?? h.effectiveOrigin ?? mapCenterForSearch ?? null);
      setSelectedSheetCandidateId(h.selectedDestinationCandidateId);
      setHasExplicitCandidateSelection(false);
    }

    if (query.length < 2) {
      setShowSearchAroundButton(false);
      setSearchAroundLimitReached(false);
      setSearchAnchor(null);
      setAccumulatedDestinationCandidates([]);
      setSelectedSheetCandidateId(h.selectedDestinationCandidateId);
      setHasExplicitCandidateSelection(false);
      return;
    }

    if (!searchAnchor) {
      const initialAnchor = h.location ?? h.effectiveOrigin ?? mapCenterForSearch;
      if (initialAnchor) {
        setSearchAnchor(initialAnchor);
      }
    }
  }, [
    h.destSearch?.query,
    h.location,
    h.location?.latitude,
    h.location?.longitude,
    h.effectiveOrigin,
    h.effectiveOrigin?.latitude,
    h.effectiveOrigin?.longitude,
    h.selectedDestinationCandidateId,
    mapCenterForSearch,
    mapCenterForSearch?.latitude,
    mapCenterForSearch?.longitude,
    searchAnchor,
  ]);

  const handleMapCenterChanged = useCallback((loc: LatLng) => {
    const prevCenter = lastMapCenterForSearchRef.current;
    const centerChanged =
      !prevCenter ||
      Math.abs(prevCenter.latitude - loc.latitude) > 0.00001 ||
      Math.abs(prevCenter.longitude - loc.longitude) > 0.00001;

    if (centerChanged) {
      lastMapCenterForSearchRef.current = loc;
      setMapCenterForSearch(loc);
    }

    const q = (h.destSearch?.query || "").trim();
    if (q.length < 2) {
      setShowSearchAroundButton(false);
      return;
    }

    const anchor = searchAnchor ?? h.location ?? h.effectiveOrigin ?? loc;
    if (!searchAnchor) {
      setSearchAnchor(anchor);
    }

    const maxMeters = SEARCH_AROUND_MAX_MILES * MILES_TO_METERS;
    const movedDistance = haversineDistanceMeters(anchor, loc);
    if (movedDistance > maxMeters) {
      setSearchAroundLimitReached(true);
      setShowSearchAroundButton(false);
      return;
    }

    // Hide "search around here" once safe routes have been found
    if (h.safeRoutes.length > 0) {
      setShowSearchAroundButton(false);
      return;
    }

    setSearchAroundLimitReached(false);
    setShowSearchAroundButton(true);
  }, [h.destSearch, h.location, h.effectiveOrigin, searchAnchor, h.safeRoutes]);

  const performSearchAround = useCallback(async () => {
    if (!mapCenterForSearch || isSearchAroundLoading) return;
    const q = (h.destSearch?.query || "").trim();
    if (q.length < 2) return;

    // Force re-selection to nearest local candidate after refreshed around-here results arrive.
    setSelectedSheetCandidateId(null);

    const anchor = searchAnchor ?? h.location ?? h.effectiveOrigin ?? mapCenterForSearch;
    if (!searchAnchor) {
      setSearchAnchor(anchor);
    }

    const maxMeters = SEARCH_AROUND_MAX_MILES * MILES_TO_METERS;
    const movedDistance = haversineDistanceMeters(anchor, mapCenterForSearch);
    if (movedDistance > maxMeters) {
      setSearchAroundLimitReached(true);
      setShowSearchAroundButton(false);
      return;
    }

    // Hide "search around here" once safe routes have been found
    if (h.safeRoutes.length > 0) {
      setShowSearchAroundButton(false);
      return;
    }

    const tier = (subscriptionTier || "free").toLowerCase();
    const radiusMiles = tier === "free" ? 3 : 5;
    const radiusMeters = Math.round(radiusMiles * MILES_TO_METERS);
    setIsSearchAroundLoading(true);
    try {
      const results = await fetchPlacePredictions(q, {
        locationBias: mapCenterForSearch,
        radiusMeters,
        subscriptionTier: tier,
      });
      setAccumulatedDestinationCandidates((prev) => {
        const map = new Map(prev.map((p) => [p.placeId, p]));
        for (const r of results) map.set(r.placeId, r);
        return Array.from(map.values());
      });
      if (results.length > 0) {
        // Ensure map fit runs for Search Around searches even when IDs overlap prior results.
        setSheetPlacesFitToken((prev) => prev + 1);
      }
      setSearchAroundLimitReached(false);
    } catch {
      // ignore network errors for now
    } finally {
      setIsSearchAroundLoading(false);
      setShowSearchAroundButton(false);
    }
  }, [mapCenterForSearch, isSearchAroundLoading, h.destSearch, h.location, h.effectiveOrigin, searchAnchor, subscriptionTier]);

  // Navigation alerts (crime / CCTV / street)
  const navAlert = useNavAlerts({
    nav: h.nav,
    selectedSafeRoute: h.selectedSafeRoute,
  });

  // Web guest detection (also exposed from useHomeScreen)
  const isWebGuest = Platform.OS === "web" && !auth.isLoggedIn;

  // Extra top offset on web to clear the AndroidDownloadBanner (32px + 4px gap)
  const webBannerOffset = Platform.OS === "web" ? 36 : 0;

  // Open the login modal (dismissable) for web guests
  const promptLogin = useCallback(() => {
    setShowLoginPrompt(true);
  }, []);

  // Handle selecting a saved place as destination
  const handleSelectSavedPlace = useCallback(
    (place: SavedPlace) => {
      h.destSearch.setQuery(place.name);
      h.destSearch.selectPrediction({
        placeId: place.id,
        primaryText: place.name,
        secondaryText: place.address ?? "",
        fullText: place.name,
        location: { latitude: place.lat, longitude: place.lng },
      });
      h.setManualDest(null);
      h.handlePanTo({ latitude: place.lat, longitude: place.lng });
      h.clearSelectedRoute();
    },
    [h],
  );

  // Toast callback for saved places
  const handleSavedPlaceToast = useCallback((msg: string, icon?: string) => {
    setToast({
      message: msg,
      icon: (icon as any) ?? "bookmark",
      iconColor: "#1570ef",
      duration: 2000,
    });
  }, []);

  // Auto-dismiss login prompt when user logs in
  useEffect(() => {
    if (auth.isLoggedIn) {
      setShowLoginPrompt(false);
    }
  }, [auth.isLoggedIn]);

  // Listen for subscription limit events from any service
  useEffect(() => {
    const unsub = onLimitReached((info) => {
      // If the user already dismissed the live_sessions limit during
      // the current navigation session, don't re-open the modal — show
      // a persistent, non-blocking notice instead.
      if (info.feature === 'live_sessions' && dismissedLimitRef.current['live_sessions']) {
        setLiveSharingNotice('Location not shared — limit reached for your plan.');
        return;
      }
      setLimitModal(info);
    });
    return unsub;
  }, [auth, setToast]);

  // Handle Stripe checkout redirect (?subscription=success or ?subscription=cancelled)
  // Security: URL params are cosmetic — we verify with the server before showing success.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const params = new URLSearchParams(window.location.search);
    const subResult = params.get("subscription");

    // Always clean up URL params immediately to prevent reuse / bookmarking
    if (subResult) {
      window.history.replaceState({}, "", window.location.pathname);
    }

    if (subResult === "success") {
      // Verify the subscription is actually active on the server
      (async () => {
        try {
          const status = await stripeApi.getStatus();
          if (status.stripeSubscription?.status === "active") {
            auth.refreshProfile?.();
            setToast({
              message: `Subscription activated! Welcome to ${status.tier === "family" ? "Family Pack" : "Guarded"}.`,
              icon: "shield-checkmark",
              iconColor: "#7C3AED",
              duration: 5000,
            });
          } else {
            // Webhook may still be processing — show a softer message
            setToast({
              message:
                "Payment received — your subscription is being activated…",
              icon: "hourglass-outline",
              iconColor: "#F59E0B",
              duration: 5000,
            });
            // Retry after a short delay for webhook propagation
            setTimeout(async () => {
              try {
                const retry = await stripeApi.getStatus();
                if (retry.stripeSubscription?.status === "active") {
                  auth.refreshProfile?.();
                  setToast({
                    message: "Subscription activated! Welcome to Guarded.",
                    icon: "shield-checkmark",
                    iconColor: "#7C3AED",
                    duration: 4000,
                  });
                }
              } catch {
                /* silent retry */
              }
            }, 4000);
          }
        } catch {
          // Not logged in or network error — ignore
        }
      })();
    } else if (subResult === "cancelled") {
      setToast({
        message: "Subscription checkout was cancelled.",
        icon: "close-circle-outline",
        iconColor: "#6B7280",
        duration: 4000,
      });
    }
  }, [auth, setToast]);

  // Only load contacts when logged in
  const {
    contacts,
    liveContacts,
    refresh: refreshContacts,
  } = useContacts(auth.isLoggedIn);

  // Friend locations — poll when the toggle is on and user has contacts
  const { friends: friendMarkers, checkNow: checkFriendLocations } =
    useFriendLocations(showFriendsOnMap && auth.isLoggedIn);

  // Callback when contacts change in BuddyModal — refresh parent state
  const handleContactsChanged = useCallback(() => {
    refreshContacts();
  }, [refreshContacts]);

  // Toggle friend locations with immediate check + toast
  const handleFriendToggle = useCallback(async () => {
    if (contacts.length === 0) {
      setToast({
        message: "Add contacts in Safety Circle first to see friend locations",
        icon: "people-outline",
        iconColor: "#F59E0B",
        duration: 3500,
      });
      return;
    }
    const next = !showFriendsOnMap;
    setShowFriendsOnMap(next);

    if (next) {
      setToast({
        message: "Checking friend locations…",
        icon: "search",
        iconColor: "#7C3AED",
        duration: 2000,
      });
      const { found, names } = await checkFriendLocations();
      if (found === 0) {
        setToast({
          message: "No friends are sharing their location right now",
          icon: "location-outline",
          iconColor: "#F59E0B",
          duration: 3500,
        });
      } else {
        const nameList =
          names.slice(0, 3).join(", ") +
          (names.length > 3 ? ` +${names.length - 3} more` : "");
        setToast({
          message: `Found ${found} friend${found > 1 ? "s" : ""} — showing ${nameList}`,
          icon: "people",
          iconColor: "#10B981",
          duration: 4000,
        });
      }
    } else {
      setToast({
        message: "Friend locations hidden",
        icon: "eye-off-outline",
        iconColor: "#6B7280",
        duration: 2000,
      });
    }
  }, [showFriendsOnMap, checkFriendLocations, contacts.length]);

  const handleReportSubmitted = useCallback((category: string) => {
    setShowReportModal(false);
    setToast({
      message: `${REPORT_LABELS[category] || "Report"} reported — thank you for keeping others safe!`,
      icon: "shield-checkmark",
      iconColor: "#10B981",
      duration: 4000,
    });
  }, []);

  const handleLocationHelp = useCallback(() => {
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.alert(
        "Location is blocked or unavailable.\n\nPlease:\n1) Click the site icon in your browser address bar\n2) Allow Location access\n3) Refresh the page and tap Retry Location",
      );
      return;
    }
    setToast({
      message:
        "Enable location permissions in your browser/app settings, then retry.",
      icon: "information-circle-outline",
      iconColor: "#1570ef",
      duration: 4500,
    });
  }, []);

  // Live tracking — auto-register push token on mount, share location during nav
  const live = useLiveTracking(auth.isLoggedIn);
  const liveStarted = useRef(false);
  // Keep stable references to avoid re-firing effects when live state changes
  const liveRef = useRef(live);
  liveRef.current = live;

  // Auto-start live tracking when navigation begins (if logged in with contacts)
  useEffect(() => {
    if (
      h.nav.state === "navigating" &&
      auth.isLoggedIn &&
      contacts.length > 0 &&
      !liveStarted.current
    ) {
      const dest = h.effectiveDestination;
      const destName =
        h.destSearch?.place?.name ?? h.manualDest?.name ?? undefined;
      // Set flag immediately to prevent duplicate calls while the async call is in flight
      liveStarted.current = true;
      // Build route_path from the selected route so contacts can see the planned route
      const routePath = h.selectedRoute?.path?.map((p) => ({
        lat: p.latitude,
        lng: p.longitude,
      }));
      console.log(
        "[live] routePath debug — selectedRoute exists:",
        !!h.selectedRoute,
        "path length:",
        h.selectedRoute?.path?.length,
        "routePath length:",
        routePath?.length,
      );
      liveRef.current
        .startTracking({
          destination_lat: dest?.latitude,
          destination_lng: dest?.longitude,
          ...(destName ? { destination_name: destName } : {}),
          ...(routePath && routePath.length >= 2
            ? { route_path: routePath }
            : {}),
        })
        .then((result) => {
          if (result.ok) {
            setToast({
              message: destName
                ? `Your Safety Circle can see you heading to ${destName}`
                : "Your Safety Circle can now see where you are",
              icon: "shield-checkmark",
              iconColor: "#10B981",
              duration: 5000,
            });
          } else {
            // Start failed — reset flag so it can retry on next render
            liveStarted.current = false;
            if (result.reason === "limit-reached") {
              // LimitReachedModal handles this globally
            } else if (result.reason === "permission-denied") {
              // Background location is required — exit navigation
              h.nav.stop();
              setToast({
                message:
                  "Background location is required for safe navigation. Please allow it to continue.",
                icon: "location-outline",
                iconColor: "#ef4444",
                duration: 5000,
              });
            } else {
              setToast({
                message: result.message || "Could not start live sharing",
                icon: "alert-circle-outline",
                iconColor: "#ef4444",
                duration: 4000,
              });
            }
          }
        });
    }
  }, [
    h.nav.state,
    auth.isLoggedIn,
    contacts.length,
    h.effectiveDestination,
    h.destSearch?.place?.name,
    h.manualDest?.name,
    h.nav,
    h.selectedRoute,
  ]);

  // Auto-stop live tracking when navigation ends
  useEffect(() => {
    if (
      liveStarted.current &&
      (h.nav.state === "arrived" || h.nav.state === "idle")
    ) {
      liveStarted.current = false;
      liveRef.current.stopTracking(
        h.nav.state === "arrived" ? "completed" : "cancelled",
      );
    }
  }, [h.nav.state]);

  // Clear any dismissal suppressions and persistent notices when navigation ends
  useEffect(() => {
    if (h.nav.state === 'arrived' || h.nav.state === 'idle') {
      dismissedLimitRef.current = {};
      setLiveSharingNotice(null);
    }
  }, [h.nav.state]);

  // --- PiP: auto-enter Picture-in-Picture when user leaves app during navigation (Android only) ---
  useEffect(() => {
    if (Platform.OS !== "android") return;

    let cancelled = false;
    (async () => {
      try {
        const mod = await import("expo-pip");
        const expoPip = mod?.default;
        if (!expoPip || cancelled) return;

        if (h.nav.state === "navigating") {
          expoPip.setPictureInPictureParams({
            width: 9,
            height: 16,
            autoEnterEnabled: true,
            title: "SafeNight Navigation",
            subtitle: h.destSearch?.place?.name ?? "Navigating...",
            seamlessResizeEnabled: true,
          });
        } else {
          expoPip.setPictureInPictureParams({
            autoEnterEnabled: false,
          });
        }
      } catch {
        // expo-pip is optional in some builds
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [h.nav.state, h.destSearch?.place?.name]);

  // PiP fallback: manually enter PiP on older Android (< 12) when app goes to background during nav
  useEffect(() => {
    if (Platform.OS !== "android" || h.nav.state !== "navigating") return;

    let cancelled = false;
    let sub: { remove: () => void } | null = null;

    (async () => {
      try {
        const mod = await import("expo-pip");
        const pip = mod?.default;
        if (!pip || cancelled) return;

        sub = AppState.addEventListener("change", (nextState) => {
          if (nextState === "background") {
            pip.enterPipMode({ width: 9, height: 16 });
          }
        });
      } catch {
        // expo-pip is optional in some builds
      }
    })();

    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [h.nav.state]);

  const distanceLabel = h.selectedRoute
    ? `🚶 ${formatDistance(h.selectedRoute.distanceMeters)}`
    : "--";
  const durationLabel = h.selectedRoute
    ? formatDuration(h.selectedRoute.durationSeconds)
    : "--";
  const showSafety = Boolean(h.selectedRoute);
  const hasError = h.directionsStatus === "error";
  const hasLiveDestinationPredictions =
    h.destSearch.query.trim().length > 0 && h.destSearch.predictions.length > 0;
  const hasRouteRequestState =
    h.routes.length > 0 ||
    h.directionsStatus === "loading" ||
    hasError ||
    h.outOfRange;
  const hasRoutesWithLabels = h.routes.length > 0 && h.roadLabels.length > 0;

  const showDestinationCandidateSheet =
    !h.isNavActive &&
    !h.manualDest &&
    (h.destinationCandidates.length > 0 || hasLiveDestinationPredictions);
  const hasSheetContent = hasRouteRequestState || showDestinationCandidateSheet;
  const sheetVisible =
    hasSheetContent &&
    !h.isNavActive;

  const fallbackSearchBottomY = useMemo(() => {
    if (isWeb && isPhoneWeb) {
      return insets.top + webBannerOffset + (isSearchBarExpanded ? 264 : 132);
    }
    if (!isWeb) {
      return insets.top + webBannerOffset + (isSearchBarExpanded ? 244 : 122);
    }
    return insets.top + webBannerOffset + 92;
  }, [insets.top, isWeb, isPhoneWeb, isSearchBarExpanded, webBannerOffset]);

  useEffect(() => {
    if (isWeb || !sheetVisible) {
      setNativeSheetTopY(windowHeight);
      return;
    }
    setNativeSheetTopY(Math.max(0, windowHeight - h.sheetHeightRef.current));
  }, [isWeb, sheetVisible, windowHeight, h.sheetHeightRef]);

  useEffect(() => {
    if (isWeb) return;
    const listenerId = h.sheetHeight.addListener(({ value }) => {
      setNativeSheetTopY(Math.max(0, windowHeight - value));
    });
    return () => {
      h.sheetHeight.removeListener(listenerId);
    };
  }, [h.sheetHeight, isWeb, windowHeight]);

  useEffect(() => {
    if (!isPhoneWeb) {
      setPhoneWebSheetHeight(0);
      return;
    }
    if (!sheetVisible) {
      setPhoneWebSheetHeight(0);
      return;
    }
    setPhoneWebSheetHeight(windowHeight * 0.45);
  }, [isPhoneWeb, sheetVisible, windowHeight]);

  const handleSearchBottomYChange = useCallback((nextBottomY: number) => {
    if (!Number.isFinite(nextBottomY) || nextBottomY <= 0) return;
    setSearchBottomY(nextBottomY);
  }, []);

  const searchBottomYForRail =
    Platform.OS === "android"
      ? Math.max(searchBottomY ?? 0, fallbackSearchBottomY)
      : searchBottomY ?? fallbackSearchBottomY;
  const currentSheetTopY = useMemo(() => {
    if (!sheetVisible) return Number.POSITIVE_INFINITY;
    if (!isWeb) return nativeSheetTopY;
    if (isPhoneWeb && phoneWebSheetHeight > 0) {
      return Math.max(0, windowHeight - phoneWebSheetHeight);
    }
    return Number.POSITIVE_INFINITY;
  }, [sheetVisible, isWeb, nativeSheetTopY, isPhoneWeb, phoneWebSheetHeight, windowHeight]);

  const mobileSearchBarLayoutCallbacks = useMemo(
    () => ({
      onEffectiveBottomChange: handleSearchBottomYChange,
      onContainerLayout: (metrics: { y: number; height: number; bottom: number }) => {
        handleSearchBottomYChange(metrics.bottom);
      },
    }),
    [handleSearchBottomYChange],
  );

  // Category label map for the highlight banner
  const categoryLabels: Record<string, string> = {
    crime: "Crimes",
    light: "Street Lights",
    cctv: "CCTV Cameras",
    shop: "Open Places",
    bus_stop: "Transit Stops",
    dead_end: "Dead Ends",
  };

  const handleCategoryPress = useCallback(
    (category: string) => {
      h.setHighlightCategory(category);
      // Collapse the sheet so the map markers are fully visible
      h.sheetHeightRef.current = SHEET_MIN;
      Animated.spring(h.sheetHeight, {
        toValue: SHEET_MIN,
        useNativeDriver: false,
        bounciness: 4,
      }).start();
    },
    [h],
  );

  const handleClearHighlight = useCallback(() => {
    h.setHighlightCategory(null);
    // Re-expand the sheet
    h.sheetHeightRef.current = SHEET_DEFAULT;
    Animated.spring(h.sheetHeight, {
      toValue: SHEET_DEFAULT,
      useNativeDriver: false,
      bounciness: 4,
    }).start();
  }, [h]);

  useEffect(() => {
    if (!h.isNavActive) setIsNavFollowing(true);
  }, [h.isNavActive]);

  const handleRecenterNavigation = useCallback(() => {
    setIsNavFollowing(true);
    setRecenterSignal((prev) => prev + 1);
  }, []);

  const handleStartNavigation = useCallback(async () => {
    if (Platform.OS === "web") {
      setShowDownloadModal(true);
      return;
    }

    try {
      await subscriptionApi.ensureFeatureAllowed("navigation_start");
      h.nav.start();
      await subscriptionApi.consume("navigation_start");
    } catch (err) {
      if (err instanceof LimitError) return;
      setToast({
        message:
          err instanceof Error ? err.message : "Unable to start navigation",
        icon: "alert-circle",
        iconColor: "#EF4444",
        duration: 2500,
      });
    }
  }, [h.nav, setToast]);

  const handleMoveToCurrentLocation = useCallback(() => {
    moveToCurrentLocation({
      location: h.location,
      refreshLocation: h.refreshLocation,
      panToLocation: h.handlePanTo,
      setIsFindingCurrentLocation,
      setIsAtCurrentLocation,
    });
  }, [h]);

  const handleMapPress = useCallback(
    (coordinate: { latitude: number; longitude: number }) => {
      setIsAtCurrentLocation(false);
      setIsFindingCurrentLocation(false);
      h.handleMapPress(coordinate);
    },
    [h],
  );

  const handleMapLongPress = useCallback(
    (coordinate: { latitude: number; longitude: number }) => {
      setIsAtCurrentLocation(false);
      setIsFindingCurrentLocation(false);
      h.handleMapLongPress(coordinate);
    },
    [h],
  );

  const handleMapInteraction = useCallback(() => {
    setIsAtCurrentLocation(false);
    setIsFindingCurrentLocation(false);
  }, []);

  useEffect(() => {
    if (!isFindingCurrentLocation || !h.location) return;
    h.handlePanTo(h.location);
  }, [isFindingCurrentLocation, h, h.location, h.handlePanTo]);

  useEffect(() => {
    if (!h.location || !h.mapPanTo?.location) return;
    const nearThreshold = 0.00012;
    const atCurrentLocation =
      Math.abs(h.mapPanTo.location.latitude - h.location.latitude) <=
        nearThreshold &&
      Math.abs(h.mapPanTo.location.longitude - h.location.longitude) <=
        nearThreshold;

    setIsAtCurrentLocation(atCurrentLocation);
    if (atCurrentLocation) setIsFindingCurrentLocation(false);
  }, [
    h.location,
    h.mapPanTo?.location,
    h.location?.latitude,
    h.location?.longitude,
    h.mapPanTo?.key,
    h.mapPanTo?.location.latitude,
    h.mapPanTo?.location.longitude,
  ]);

  useEffect(() => {
    if (
      !h.outOfRange ||
      h.directionsStatus === "loading" ||
      !h.effectiveOrigin ||
      !h.effectiveDestination
    ) {
      return;
    }
    setOutOfRangeCueSignal((prev) => prev + 1);
  }, [
    h.outOfRange,
    h.outOfRangeMessage,
    h.directionsStatus,
    h.effectiveOrigin,
    h.effectiveDestination,
    h.effectiveOrigin?.latitude,
    h.effectiveOrigin?.longitude,
    h.effectiveDestination?.latitude,
    h.effectiveDestination?.longitude,
  ]);

  const _baseSheetPlaces =
    h.destinationCandidates.length > 0
      ? h.destinationCandidates
      : hasLiveDestinationPredictions
        ? h.destSearch.predictions
        : [];

  const sheetPlaces =
    accumulatedDestinationCandidates.length > 0
      ? Array.from(
          new Map(
            [..._baseSheetPlaces, ...accumulatedDestinationCandidates].map(
              (p) => [p.placeId, p],
            ),
          ).values(),
        )
      : _baseSheetPlaces;

  const nearbyReference = useMemo(() => {
    // When using Search Around, rank results by proximity to the local map center.
    if (accumulatedDestinationCandidates.length > 0 && mapCenterForSearch) {
      return mapCenterForSearch;
    }
    return h.location ?? h.effectiveOrigin ?? null;
  }, [
    accumulatedDestinationCandidates.length,
    mapCenterForSearch,
    h.location,
    h.effectiveOrigin,
  ]);
  const maxDistanceMeters = searchDistanceFilterMiles * MILES_TO_METERS;
  const placeDistanceById = useMemo(() => {
    const distances = new Map<string, number>();
    if (!nearbyReference) return distances;

    for (const place of sheetPlaces) {
      if (!place.location) continue;
      distances.set(
        place.placeId,
        haversineDistanceMeters(nearbyReference, place.location),
      );
    }
    return distances;
  }, [sheetPlaces, nearbyReference]);

  const distanceFilteredSheetPlaces = useMemo(() => {
    if (!nearbyReference) return sheetPlaces;
    return sheetPlaces.filter((place) => {
      const distance = placeDistanceById.get(place.placeId);
      return typeof distance === "number" && distance <= maxDistanceMeters;
    });
  }, [sheetPlaces, nearbyReference, placeDistanceById, maxDistanceMeters]);

  const visibleFilteredSheetPlaces = useMemo(() => {
    if (!activePlaceCategoryKey) return distanceFilteredSheetPlaces;
    return distanceFilteredSheetPlaces.filter(
      (candidate) => classifyPlaceCategory(candidate) === activePlaceCategoryKey,
    );
  }, [distanceFilteredSheetPlaces, activePlaceCategoryKey]);

  const androidCandidateRefitMaxZoom = useMemo(() => {
    if (Platform.OS !== "android") return 16;

    const distanceBiasByMiles: Record<number, number> = {
      1: 0,
      2: 0.15,
      3: 0.3,
      4: 0.5,
      5: 0.7,
      10: 1.0,
    };

    const count = visibleFilteredSheetPlaces.length;
    const countBias =
      count <= 1 ? 0.0 :
      count <= 3 ? 0.35 :
      count <= 6 ? 0.65 :
      count <= 10 ? 0.95 :
      1.2;

    const distanceBias = distanceBiasByMiles[searchDistanceFilterMiles] ?? 0;
    return Math.max(10.8, Math.min(13.2, 12.2 + distanceBias - countBias));
  }, [searchDistanceFilterMiles, visibleFilteredSheetPlaces.length]);

  useEffect(() => {
    if (Platform.OS !== "android") return;

    const query = (h.destSearch?.query || "").trim().toLowerCase();
    if (query.length < 2) {
      lastAndroidFitKeyRef.current = "";
      return;
    }

    const nextKey = [
      query,
      searchDistanceFilterMiles,
      activePlaceCategoryKey ?? "all",
    ].join("|");

    if (nextKey === lastAndroidFitKeyRef.current) return;
    lastAndroidFitKeyRef.current = nextKey;

    if (visibleFilteredSheetPlaces.length === 0 && sheetPlaces.length === 0) return;

    setAndroidFitCandidateBoundsToken((prev) => prev + 1);
  }, [
    activePlaceCategoryKey,
    h.destSearch?.query,
    searchDistanceFilterMiles,
    sheetPlaces.length,
    visibleFilteredSheetPlaces.length,
  ]);

  const categoryFilteredSheetPlaces = visibleFilteredSheetPlaces;

  const orderedSheetPlaces = useMemo(() => {
    if (!nearbyReference) return categoryFilteredSheetPlaces;
    return [...categoryFilteredSheetPlaces].sort((a, b) => {
      const aDistance = placeDistanceById.get(a.placeId) ?? Number.MAX_SAFE_INTEGER;
      const bDistance = placeDistanceById.get(b.placeId) ?? Number.MAX_SAFE_INTEGER;
      return aDistance - bDistance;
    });
  }, [categoryFilteredSheetPlaces, nearbyReference, placeDistanceById]);

  const filteredSheetPlaceIds = useMemo(
    () => new Set(categoryFilteredSheetPlaces.map((place) => place.placeId)),
    [categoryFilteredSheetPlaces],
  );

  const visibleSheetPlaces = useMemo(() => {
    const clipped = orderedSheetPlaces.slice(0, SHEET_RESULTS_RENDER_LIMIT);
    if (!selectedSheetCandidateId) return clipped;
    if (clipped.some((p) => p.placeId === selectedSheetCandidateId)) return clipped;
    const selected = orderedSheetPlaces.find(
      (p) => p.placeId === selectedSheetCandidateId,
    );
    return selected ? [...clipped, selected] : clipped;
  }, [orderedSheetPlaces, selectedSheetCandidateId]);

  useEffect(() => {
    const query = (h.destSearch?.query || "").trim().toLowerCase();
    if (query.length < 2) {
      lastAutoExpandedZoneKeyRef.current = "";
      return;
    }

    const hasResults = visibleFilteredSheetPlaces.length > 0;
    if (hasResults) {
      lastAutoExpandedZoneKeyRef.current = "";
      return;
    }

    const maxAutoZoneMiles = Math.min(maxDistanceFilterMiles, 5);
    if (searchDistanceFilterMiles >= maxAutoZoneMiles) {
      return;
    }

    const autoKey = [
      query,
      activePlaceCategoryKey ?? "all",
      nearbyReference ? `${nearbyReference.latitude.toFixed(4)},${nearbyReference.longitude.toFixed(4)}` : "none",
      searchDistanceFilterMiles,
      sheetPlaces.length,
    ].join("|");

    if (lastAutoExpandedZoneKeyRef.current === autoKey) {
      return;
    }

    lastAutoExpandedZoneKeyRef.current = autoKey;

    const nextDistance = Math.min(searchDistanceFilterMiles + 1, maxAutoZoneMiles);
    if (nextDistance !== searchDistanceFilterMiles) {
      setSelectedSheetCandidateId(null);
      setHasExplicitCandidateSelection(false);
      setSearchDistanceFilterMiles(nextDistance);
      setSheetPlacesFitToken((prev) => prev + 1);
    }
  }, [
    activePlaceCategoryKey,
    h.destSearch?.query,
    nearbyReference,
    searchDistanceFilterMiles,
    sheetPlaces.length,
    maxDistanceFilterMiles,
    visibleFilteredSheetPlaces.length,
  ]);

  const selectedPlace = useMemo(
    () =>
      sheetPlaces.find((p) => p.placeId === selectedSheetCandidateId) ??
      h.selectedDestinationCandidate,
    [sheetPlaces, selectedSheetCandidateId, h.selectedDestinationCandidate],
  );

  const isResultsCardsEnabled = isWeb
    ? FEATURE_FLAGS.webResultsCardsV1
    : FEATURE_FLAGS.phoneResultsCardsV1;

  const emitPlaceCardEvent = useCallback(
    (
      eventName:
        | "place_card_viewed"
        | "safe_directions_clicked"
        | "share_route_clicked"
        | "save_place_clicked",
      placeId: string,
    ) => {
      if (!__DEV__) return;
      console.debug("[place-card-event]", eventName, { placeId });
    },
    [],
  );

  const getDistanceLabelForPlace = useCallback(
    (placeId: string): string | null => {
      const distanceMeters = placeDistanceById.get(placeId);
      if (typeof distanceMeters !== "number") return null;
      const distanceMiles = distanceMeters / MILES_TO_METERS;
      if (distanceMiles < 0.1) return `${Math.round(distanceMeters)} m`;
      return `${distanceMiles.toFixed(distanceMiles < 1 ? 1 : 0)} mi`;
    },
    [placeDistanceById],
  );

  const findSavedPlaceMatch = useCallback(
    (candidate: PlacePrediction) => {
      if (!candidate.location) return null;
      return (
        savedPlaces.find(
          (saved) =>
            Math.abs(saved.lat - candidate.location!.latitude) < 0.00005 &&
            Math.abs(saved.lng - candidate.location!.longitude) < 0.00005,
        ) ?? null
      );
    },
    [savedPlaces],
  );

  const buildDestinationFallbackLink = useCallback((candidate: PlacePrediction): string => {
    if (!candidate.location) return "";
    const name = encodeURIComponent(candidate.primaryText || "SafeNight destination");
    const lat = candidate.location.latitude;
    const lng = candidate.location.longitude;
    if (Platform.OS === "web") {
      return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
    }
    return `geo:${lat},${lng}?q=${lat},${lng}(${name})`;
  }, []);

  const handleShareRouteFromPlace = useCallback(
    async (candidate: PlacePrediction) => {
      if (!candidate.location) return;
      emitPlaceCardEvent("share_route_clicked", candidate.placeId);

      let shareUrl = buildDestinationFallbackLink(candidate);

      if (FEATURE_FLAGS.routeShareV1) {
        try {
          const created = await createRouteShareLink({
            destinationName: candidate.primaryText,
            destination: candidate.location,
            routePath: h.selectedSafeRoute?.path,
            expiresInHours: 24,
            redactOrigin: true,
          });
          if (created.shareUrl) {
            shareUrl = created.shareUrl;
          }
        } catch {
          // Keep destination fallback URL when share endpoint is unavailable.
        }
      }

      if (!shareUrl) return;

      await Clipboard.setStringAsync(shareUrl);
      handleSavedPlaceToast("Route link copied", "link-outline");
    },
    [
      emitPlaceCardEvent,
      buildDestinationFallbackLink,
      h.selectedSafeRoute,
      handleSavedPlaceToast,
    ],
  );

  const handleSavePlaceFromCandidate = useCallback(
    async (candidate: PlacePrediction) => {
      if (!candidate.location) return;
      emitPlaceCardEvent("save_place_clicked", candidate.placeId);

      const existing = findSavedPlaceMatch(candidate);
      if (existing) {
        await removePlace(existing.id);
        handleSavedPlaceToast("Removed from saved", "bookmark-outline");
        return;
      }

      const categoryKey = classifyPlaceCategory(candidate);
      const iconByCategory: Record<string, string> = {
        fuel: "car",
        shop: "bag-handle",
        food: "restaurant",
        parking: "car-sport",
        pharmacy: "medkit",
        hospital: "medical",
        bank: "cash",
        hotel: "bed",
      };

      const result = await savePlace({
        label: (candidate.primaryText || "Saved").slice(0, 32),
        name: candidate.primaryText || "Saved place",
        address: candidate.secondaryText || candidate.fullText || "",
        lat: candidate.location.latitude,
        lng: candidate.location.longitude,
        icon: iconByCategory[categoryKey || ""] || "bookmark",
      });

      if (!result.ok && result.existingLabel) {
        handleSavedPlaceToast(`Already saved as ${result.existingLabel}`, "alert-circle-outline");
        return;
      }

      handleSavedPlaceToast(result.updated ? "Saved place updated" : "Saved place", "bookmark");
    },
    [emitPlaceCardEvent, findSavedPlaceMatch, handleSavedPlaceToast, removePlace, savePlace],
  );

  const handleFindSafeRoutesForSelectedPlace = useCallback((explicitCandidate?: PlacePrediction | null) => {
    const candidate =
      explicitCandidate ??
      sheetPlaces.find((p) => p.placeId === selectedSheetCandidateId) ??
      null;
    if (!candidate) {
      h.activateSelectedDestinationCandidate();
      return;
    }

    const isBaseCandidate = h.destinationCandidates.some(
      (p) => p.placeId === candidate.placeId,
    );

    if (isBaseCandidate) {
      h.selectDestinationCandidate(candidate.placeId, true);
      h.activateSelectedDestinationCandidate();
      return;
    }

    h.destSearch.selectPrediction(candidate);
    h.setManualDest(null);
    if (candidate.location) {
      h.handlePanTo(candidate.location);
    }
    h.clearSelectedRoute();
  }, [
    h,
    selectedSheetCandidateId,
    sheetPlaces,
  ]);

  // Scroll sheet to center selected candidate when selection changes
  useEffect(() => {
    const id = selectedSheetCandidateId;
    if (!id || !sheetScrollRef?.current) return;
    const idx = visibleSheetPlaces.findIndex((p) => p.placeId === id);
    if (idx === -1) return;
    const approxItemHeight = 72; // approximate item height
    const centerOffset = Math.max(0, idx * approxItemHeight - 120);
    try {
      sheetScrollRef.current.scrollTo({ y: centerOffset, animated: false });
    } catch {
      // ignore
    }

    if (Platform.OS !== "web") {
      h.sheetHeightRef.current = SHEET_DEFAULT;
      h.sheetHeight.setValue(SHEET_DEFAULT);
    }
  }, [selectedSheetCandidateId, visibleSheetPlaces, h.sheetHeight, h.sheetHeightRef]);

  const sheetCategoryBubbles = useMemo(() => {
    if (!distanceFilteredSheetPlaces.length) return [];

    const counts = new Map<string, number>();
    for (const candidate of distanceFilteredSheetPlaces) {
      const category = classifyPlaceCategory(candidate);
      if (!category) continue;
      counts.set(category, (counts.get(category) || 0) + 1);
    }

    return PLACE_CATEGORY_CHIPS
      .map((chip) => ({ ...chip, count: counts.get(chip.key) || 0 }))
      .filter((chip) => chip.count > 0)
      .sort((a, b) => b.count - a.count);
  }, [distanceFilteredSheetPlaces]);

  const handleSheetCategoryBubblePress = useCallback(
    (categoryKey: string) => {
      const nextCategoryKey =
        activePlaceCategoryKey === categoryKey ? null : categoryKey;
      setActivePlaceCategoryKey(nextCategoryKey);

      setSelectedSheetCandidateId(null);
      setHasExplicitCandidateSelection(false);
      setSheetPlacesFitToken((prev) => prev + 1);
    },
    [activePlaceCategoryKey],
  );

  const handleDistanceFilterPress = useCallback(
    (distance: number) => {
      setSearchDistanceFilterMiles(distance);
      setSelectedSheetCandidateId(null);
      setHasExplicitCandidateSelection(false);
      setSheetPlacesFitToken((prev) => prev + 1);
    },
    [],
  );

  useEffect(() => {
    if (
      selectedSheetCandidateId &&
      visibleSheetPlaces.some((p) => p.placeId === selectedSheetCandidateId)
    ) {
      return;
    }

    if (visibleSheetPlaces.length === 0) {
      setSelectedSheetCandidateId(null);
      setHasExplicitCandidateSelection(false);
      return;
    }

    setSelectedSheetCandidateId(visibleSheetPlaces[0].placeId);
    setHasExplicitCandidateSelection(false);
  }, [visibleSheetPlaces, selectedSheetCandidateId]);

  useEffect(() => {
    if (!selectedPlace) return;

    if (Platform.OS !== "web" && !h.isNavActive) {
      h.sheetHeightRef.current = SHEET_DEFAULT;
      h.sheetHeight.setValue(SHEET_DEFAULT);
    }
  }, [selectedPlace, h.isNavActive, h.sheetHeight, h.sheetHeightRef]);

  const candidateDetailsById = useMemo(() => {
    const detailMap = new Map<string, {
      title: string;
      subtitle: string;
      meta: string;
      coords: string;
      buttonLabel: string;
    }>();

    const toTitle = (value?: string | null) => {
      if (!value) return "";
      return value
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());
    };

    for (const candidate of sheetPlaces) {
      const coords = candidate.location
        ? `${candidate.location.latitude.toFixed(5)}, ${candidate.location.longitude.toFixed(5)}`
        : "";
      const meta = [
        toTitle(candidate.category),
        toTitle(candidate.placeType),
        candidate.address?.postcode || null,
      ]
        .filter(Boolean)
        .join(" • ");

      detailMap.set(candidate.placeId, {
        title: candidate.primaryText || candidate.fullText || "Place",
        subtitle:
          candidate.fullText ||
          candidate.secondaryText ||
          candidate.primaryText ||
          "",
        meta,
        coords,
        buttonLabel: "Safe directions",
      });
    }

    return detailMap;
  }, [sheetPlaces]);

  const combinedDestinationCandidateMarkers = useMemo(() => {
    const markers = new Map<string, any>();
    const selectedCandidateMarkerId = hasExplicitCandidateSelection && selectedSheetCandidateId
      ? `search-candidate:${selectedSheetCandidateId}`
      : null;

    for (const marker of h.destinationCandidateMarkers as any[]) {
      const markerId = String(marker?.id ?? "");
      const isCandidateMarker = markerId.startsWith("search-candidate:");
      const isSelectedCandidate =
        isCandidateMarker && selectedCandidateMarkerId === markerId;
      const placeId = isCandidateMarker
        ? markerId.slice("search-candidate:".length)
        : "";
      const detail = placeId ? candidateDetailsById.get(placeId) : null;

      markers.set(marker.id, {
        ...marker,
        isSelected: isSelectedCandidate,
        pinColor: isCandidateMarker
          ? isSelectedCandidate
            ? "#1570ef"
            : "#ef4444"
          : marker?.pinColor,
        popupTitle: detail?.title,
        popupSubtitle: detail?.subtitle,
        popupMeta: detail?.meta,
        popupCoords: detail?.coords,
        popupButtonLabel: detail?.buttonLabel,
      });
    }

    for (const candidate of accumulatedDestinationCandidates) {
      if (!candidate.location) continue;
      const markerId = `search-candidate:${candidate.placeId}`;
      const isSelectedCandidate = selectedCandidateMarkerId === markerId;
      const detail = candidateDetailsById.get(candidate.placeId);
      markers.set(`search-candidate:${candidate.placeId}`, {
        id: markerId,
        kind: "shop",
        coordinate: {
          latitude: candidate.location.latitude,
          longitude: candidate.location.longitude,
        },
        label: candidate.fullText || candidate.primaryText,
        isSelected: isSelectedCandidate,
        pinColor: isSelectedCandidate ? "#1570ef" : "#ef4444",
        popupTitle: detail?.title,
        popupSubtitle: detail?.subtitle,
        popupMeta: detail?.meta,
        popupCoords: detail?.coords,
        popupButtonLabel: detail?.buttonLabel,
      });
    }

    return Array.from(markers.values());
  }, [
    h.destinationCandidateMarkers,
    accumulatedDestinationCandidates,
    candidateDetailsById,
    hasExplicitCandidateSelection,
    selectedSheetCandidateId,
  ]);

  const filteredDestinationCandidateMarkers = useMemo(() => {
    return combinedDestinationCandidateMarkers.filter((marker: any) => {
      const markerId = String(marker?.id ?? "");
      if (!markerId.startsWith("search-candidate:")) return true;
      const placeId = markerId.slice("search-candidate:".length);
      return filteredSheetPlaceIds.has(placeId);
    });
  }, [combinedDestinationCandidateMarkers, filteredSheetPlaceIds]);

  const candidateAutoFitKey = useMemo(() => {
    if (!showDestinationCandidateSheet) return "";

    const candidateIds = combinedDestinationCandidateMarkers
      .map((marker: any) => String(marker?.id ?? ""))
      .filter((id) => id.startsWith("search-candidate:"))
      .sort();

    if (candidateIds.length === 0) return "";

    return [
      activePlaceCategoryKey ?? "all",
      String(searchDistanceFilterMiles),
      candidateIds.join(","),
    ].join("|");
  }, [
    showDestinationCandidateSheet,
    combinedDestinationCandidateMarkers,
    activePlaceCategoryKey,
    searchDistanceFilterMiles,
  ]);

  useEffect(() => {
    if (!candidateAutoFitKey) {
      lastCandidateAutoFitKeyRef.current = "";
      return;
    }
    if (candidateAutoFitKey === lastCandidateAutoFitKeyRef.current) return;

    lastCandidateAutoFitKeyRef.current = candidateAutoFitKey;
    // Re-fit only when filter/search candidate identity actually changed.
    setSheetPlacesFitToken((prev) => prev + 1);
  }, [candidateAutoFitKey]);

  const mapFitTopPadding = useMemo(() => {
    if (!showDestinationCandidateSheet) return 40;

    if (!isWeb) {
      const collapsedTopOverlay = insets.top + 122;
      const expandedTopOverlay = insets.top + 206;
      return isSearchBarExpanded
        ? Math.max(96, expandedTopOverlay)
        : Math.max(84, collapsedTopOverlay);
    }

    if (isPhoneWeb) {
      const collapsedTopOverlay = insets.top + 170;
      const expandedTopOverlay = insets.top + 248;
      return isSearchBarExpanded
        ? Math.max(104, expandedTopOverlay)
        : Math.max(92, collapsedTopOverlay);
    }

    return 64;
  }, [showDestinationCandidateSheet, isWeb, isPhoneWeb, isSearchBarExpanded, insets.top]);

  const mapFitBottomPadding = useMemo(() => {
    if (!showDestinationCandidateSheet) return 40;
    if (!isWeb) {
      return Math.max(120, Math.round(h.sheetHeightRef.current + insets.bottom + 24));
    }
    return isPhoneWeb ? 300 : 56;
  }, [showDestinationCandidateSheet, isWeb, isPhoneWeb, h.sheetHeightRef, insets.bottom]);

  const mapFitSidePadding = useMemo(() => {
    if (!showDestinationCandidateSheet) return 40;
    if (!isWeb) return 28;
    return isPhoneWeb ? 24 : 52;
  }, [showDestinationCandidateSheet, isWeb, isPhoneWeb]);

  const candidateMapFitTopPadding = useMemo(
    () => Math.round(mapFitTopPadding * 4),
    [mapFitTopPadding],
  );

  const candidateMapFitBottomPadding = useMemo(
    () => Math.round(mapFitBottomPadding * 4),
    [mapFitBottomPadding],
  );

  const candidateMapFitSidePadding = useMemo(
    () => Math.round(mapFitSidePadding * 4),
    [mapFitSidePadding],
  );

  const renderDestinationCandidatesSection = (keyPrefix: string) => {
    if (!showDestinationCandidateSheet) return null;

    return (
      <View style={styles.placeResultsPanel}>
        {/* Sticky Header — Index 0 for stickyHeaderIndices */}
        <View style={styles.stickyHeaderContainer}>
          {/* Category Chips */}
          {sheetCategoryBubbles.length > 0 && (
            <View style={styles.placeCategoryFiltersBlock}>
              <Text style={styles.placeFiltersHelperText}>
                Quick filters: tap a category to instantly narrow Places results.
              </Text>
              <View style={styles.placeCategoriesWrap}>
              {sheetCategoryBubbles.map((chip, idx, arr) => {
                const iconOnly = arr.length > 3;
                return (
                <Pressable
                  key={`${keyPrefix}-cat-${chip.key}`}
                  style={[
                    styles.placeCategoryBubble,
                    styles.placeCategoryBubbleEqual,
                    iconOnly ? styles.placeCategoryBubbleIconOnly : null,
                    activePlaceCategoryKey === chip.key
                      ? styles.placeCategoryBubbleActive
                      : null,
                  ]}
                  onPress={() => handleSheetCategoryBubblePress(chip.key)}
                  accessibilityRole="button"
                  accessibilityLabel={`Filter places by ${chip.label}`}
                  accessibilityHint="Filters the visible Places list immediately"
                >
                  <Ionicons name={chip.icon} size={14} color="#1570ef" />
                  {!iconOnly ? (
                    <Text style={styles.placeCategoryBubbleText}>{chip.label}</Text>
                  ) : null}
                  <Text style={styles.placeCategoryBubbleCount}>{chip.count}</Text>
                </Pressable>
                );
              })}
              </View>
            </View>
          )}
          
          {/* Distance Filter Controls */}
          <View style={styles.distanceFilterRow}>
            <Text style={styles.distanceFilterLabel}>Distance:</Text>
            <View style={styles.distanceFilterOptions}>
              {distanceFilterOptionsMiles.map((distance) => (
                <Pressable
                  key={`${keyPrefix}-distance-${distance}`}
                  style={[
                    styles.distanceFilterButton,
                    searchDistanceFilterMiles === distance && styles.distanceFilterButtonActive,
                  ]}
                  onPress={() => handleDistanceFilterPress(distance)}
                  accessibilityRole="button"
                  accessibilityLabel={`Filter places to ${distance} miles`}
                  accessibilityHint="Applies distance filter to Places results"
                >
                  <Text
                    style={[
                      styles.distanceFilterButtonText,
                      searchDistanceFilterMiles === distance && styles.distanceFilterButtonTextActive,
                    ]}
                  >
                    {distance}mi
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        </View>

        <View style={styles.placeResultsHeader}>
          <Text style={styles.placeResultsTitle}>Places</Text>
        </View>
        {visibleSheetPlaces.map((candidate) => {
          const selected = candidate.placeId === selectedSheetCandidateId;
          const distanceLabel = getDistanceLabelForPlace(candidate.placeId);
          const candidateMeta = [
            candidate.category ? candidate.category.replace(/_/g, " ") : null,
            candidate.placeType ? candidate.placeType.replace(/_/g, " ") : null,
            candidate.address?.postcode || null,
          ]
            .filter(Boolean)
            .join(" • ");

          if (isResultsCardsEnabled) {
            return (
              <PlaceResultCard
                key={`${keyPrefix}-${candidate.placeId}`}
                place={candidate}
                selected={selected}
                subtitle={candidate.secondaryText || candidate.fullText || null}
                meta={candidateMeta || null}
                distanceLabel={distanceLabel}
                isSaved={Boolean(findSavedPlaceMatch(candidate))}
                isSafeDirectionsLoading={selected && h.directionsStatus === "loading"}
                onSelect={() => {
                  emitPlaceCardEvent("place_card_viewed", candidate.placeId);
                  setSelectedSheetCandidateId(candidate.placeId);
                  setHasExplicitCandidateSelection(true);
                  if (h.destinationCandidates.some((p) => p.placeId === candidate.placeId)) {
                    h.selectDestinationCandidate(candidate.placeId, false);
                  }
                }}
                onSafeDirections={() => {
                  emitPlaceCardEvent("safe_directions_clicked", candidate.placeId);
                  setSelectedSheetCandidateId(candidate.placeId);
                  setHasExplicitCandidateSelection(true);
                  handleFindSafeRoutesForSelectedPlace(candidate);
                }}
                onShare={() => {
                  setSelectedSheetCandidateId(candidate.placeId);
                  setHasExplicitCandidateSelection(true);
                  void handleShareRouteFromPlace(candidate);
                }}
                onSave={() => {
                  void handleSavePlaceFromCandidate(candidate);
                }}
              />
            );
          }

          return (
            <Pressable
              key={`${keyPrefix}-${candidate.placeId}`}
              style={[
                styles.placeResultItem,
                selected && styles.placeResultItemSelected,
              ]}
              onPress={() => {
                setSelectedSheetCandidateId(candidate.placeId);
                setHasExplicitCandidateSelection(true);
                if (h.destinationCandidates.some((p) => p.placeId === candidate.placeId)) {
                  h.selectDestinationCandidate(candidate.placeId, false);
                }
              }}
            >
              <View style={styles.placeResultTitleRow}>
                <Ionicons
                  name={selected ? "radio-button-on" : "radio-button-off"}
                  size={16}
                  color={selected ? "#1570ef" : "#667085"}
                />
                <Text style={styles.placeResultTitle} numberOfLines={1}>
                  {candidate.primaryText}
                </Text>
              </View>
              {candidate.secondaryText ? (
                <Text style={styles.placeResultSecondary} numberOfLines={1}>
                  {candidate.secondaryText}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    );
  };

  return (
    <View
      style={[
        styles.container,
        { paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      <PageHead path="/" />
      {/* ── Map (fills the screen as a flex child) ── */}
      <RouteMap
        origin={h.effectiveOrigin}
        destination={h.effectiveDestination}
        routes={isWebGuest ? [] : h.routes}
        selectedRouteId={isWebGuest ? null : h.selectedRouteId}
        showExtraDetail={!isWebGuest && showMapExtraDetail}
        safetyMarkers={
          isWebGuest
            ? []
            : [
                ...filteredDestinationCandidateMarkers,
                ...(h.poiMarkers as any),
                ...(h.viaPinLocation
                  ? [
                      {
                        kind: "via",
                        label: "Via point",
                        coordinate: h.viaPinLocation,
                      },
                    ]
                  : []),
              ]
        }
        routeSegments={isWebGuest ? [] : h.routeSegments}
        roadLabels={isWebGuest ? [] : h.roadLabels}
        panTo={h.mapPanTo}
        fitCandidateBoundsToken={
          Platform.OS === "android"
            ? h.destinationCandidatesFitToken + sheetPlacesFitToken + androidFitCandidateBoundsToken
            : h.destinationCandidatesFitToken + sheetPlacesFitToken
        }
        androidFitCandidateBoundsToken={Platform.OS === "android" ? androidFitCandidateBoundsToken : 0}
        androidCandidateRefitMaxZoom={Platform.OS === "android" ? androidCandidateRefitMaxZoom : 16}
        fitTopPadding={mapFitTopPadding}
        fitBottomPadding={mapFitBottomPadding}
        fitSidePadding={mapFitSidePadding}
        candidateFitTopPadding={candidateMapFitTopPadding}
        candidateFitBottomPadding={candidateMapFitBottomPadding}
        candidateFitSidePadding={candidateMapFitSidePadding}
        showZoomControls={isWeb && !isPhoneWeb}
        isNavigating={h.isNavActive}
        navigationLocation={h.nav.userLocation}
        navigationHeading={h.nav.userHeading}
        mapType={h.mapType}
        highlightCategory={h.highlightCategory}
        maxDistanceKm={maxDistanceKm}
        friendMarkers={friendMarkers}
        recenterSignal={recenterSignal}
        outOfRangeCueSignal={outOfRangeCueSignal}
        vizStreamUrl={h.vizStreamUrl}
        vizProgressPct={h.vizProgressPct}
        vizProgressMessage={h.vizProgressMessage}
        onSelectRoute={h.setSelectedRouteId}
        onSelectMarker={(markerId) => {
          h.handleMapMarkerSelect(markerId);
          if (!markerId.startsWith("search-candidate:")) return;

          const placeId = markerId.slice("search-candidate:".length);
          if (!placeId) return;

          setSelectedSheetCandidateId(placeId);
          setHasExplicitCandidateSelection(true);

          const markerPlace = sheetPlaces.find((p) => p.placeId === placeId);
          if (markerPlace?.location) {
            h.handlePanTo(markerPlace.location);
          }
        }}
        onFindSafeRoutes={(markerId) => {
          h.handleMapMarkerSelect(markerId);

          if (!markerId.startsWith("search-candidate:")) return;

          const placeId = markerId.slice("search-candidate:".length);
          if (!placeId) return;

          setSelectedSheetCandidateId(placeId);
          setHasExplicitCandidateSelection(true);

          const markerPlace = sheetPlaces.find((p) => p.placeId === placeId);
          if (markerPlace?.location) {
            h.handlePanTo(markerPlace.location);
          }

          handleFindSafeRoutesForSelectedPlace(markerPlace ?? null);
        }}
        onDismissMarkerDetails={() => {
          setHasExplicitCandidateSelection(false);
        }}
        onLongPress={isWebGuest ? undefined : handleMapLongPress}
        onMapPress={isWebGuest ? undefined : handleMapPress}
        onNavigationFollowChange={setIsNavFollowing}
        onUserInteraction={isWebGuest ? undefined : handleMapInteraction}
        onMapCenterChanged={handleMapCenterChanged}
      />

      {/*
       * ── Overlay layer ──
       * On Android, AndroidOverlayHost creates a separate compositing layer
       * with high elevation so all UI renders above the native map view.
       * On iOS/web it's a no-op passthrough.
       */}
      <AndroidOverlayHost>
        {/* ══════════════════════════════════════════════════════════════
         * WEB LAYOUT — Google Maps-style left sidebar (tablet/desktop only)
         * ══════════════════════════════════════════════════════════════ */}
        {isWeb && !isPhoneWeb && !h.isNavActive && (
          <WebSidebar
            hasResults={hasSheetContent}
            isLoading={h.directionsStatus === "loading"}
            hasError={hasError}
            onClearResults={h.clearRouteResults}
            showClearButton={hasRouteRequestState}
            onWidthChange={setWebSidebarOverlayOffset}
            downloadBanner={<AndroidDownloadBanner embedded />}
            loginButton={
              isWebGuest ? <WebLoginButton onPress={promptLogin} /> : null
            }
            searchBar={
              <SearchBar
                topInset={0}
                location={h.location}
                isUsingCurrentLocation={h.isUsingCurrentLocation}
                setIsUsingCurrentLocation={h.setIsUsingCurrentLocation}
                originSearch={h.originSearch}
                manualOrigin={h.manualOrigin}
                setManualOrigin={h.setManualOrigin}
                destSearch={h.destSearch}
                manualDest={h.manualDest}
                setManualDest={h.setManualDest}
                pinMode={h.pinMode}
                setPinMode={h.setPinMode}
                onPanTo={h.handlePanTo}
                onClearRoute={h.clearSelectedRoute}
                onSwap={h.swapOriginAndDest}
                onGuestTap={isWebGuest ? promptLogin : undefined}
                destinationCandidates={h.destinationCandidates}
                selectedDestinationCandidateId={
                  h.selectedDestinationCandidateId
                }
                onSelectDestinationCandidate={h.selectDestinationCandidate}
                onFindSafeRoutes={h.activateSelectedDestinationCandidate}
                embedded
                savedPlaces={savedPlaces}
                onSelectSavedPlace={handleSelectSavedPlace}
                onSavePlace={savePlace}
                onRemoveSavedPlace={removePlace}
                onSavedPlaceToast={handleSavedPlaceToast}
                hidePredictionsDropdown
              />
            }
          >
            {renderDestinationCandidatesSection("sheet-candidate-sidebar-web")}

            {/* Sheet content rendered inside sidebar */}
            {hasRouteRequestState && (
              <View style={styles.sheetHeader}>
                <Text style={styles.sheetTitle}>
                  {hasError && h.routes.length === 0 ? "Oops!!" : "Routes"}
                </Text>
                {!hasError && h.selectedRoute && (
                  <Text style={styles.sheetMeta}>
                    {distanceLabel} · {durationLabel}
                  </Text>
                )}
              </View>
            )}

            {h.directionsStatus === "loading" && (
              <JailLoadingAnimation
                progressPct={h.vizProgressPct}
                statusMessage={h.vizProgressMessage}
              />
            )}

            {h.outOfRange && (
              <View style={styles.warningBanner}>
                <Ionicons name="ban-outline" size={20} color="#dc2626" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.warningTitle}>
                    Destination out of range
                  </Text>
                  <Text style={styles.warningText}>
                    {h.outOfRangeMessage ||
                      "Destination is too far away (max 6.2 mi walking distance)."}
                  </Text>
                  {h.directionsError?.details?.detail ? (
                    <Text style={styles.warningDetail}>
                      {String(h.directionsError.details.detail)}
                    </Text>
                  ) : null}
                  <Text style={styles.warningHint}>
                    💡 Try selecting a closer destination, or split your journey
                    into shorter legs.
                  </Text>
                </View>
              </View>
            )}

            {h.directionsError && !h.outOfRange && (
              <View
                style={[
                  styles.warningBanner,
                  h.directionsError.code === "INTERNAL_ERROR" && {
                    backgroundColor: "#fffbeb",
                  },
                ]}
              >
                <Ionicons
                  name={
                    h.directionsError.code === "NO_ROUTE_FOUND"
                      ? "git-branch-outline"
                      : h.directionsError.code === "NO_NEARBY_ROAD"
                        ? "location-outline"
                        : h.directionsError.code === "NO_WALKING_NETWORK"
                          ? "walk-outline"
                          : h.directionsError.code === "safe_routes_timeout"
                            ? "time-outline"
                            : h.directionsError.code === "INTERNAL_ERROR"
                              ? "cloud-offline-outline"
                              : "alert-circle"
                  }
                  size={20}
                  color={
                    h.directionsError.code === "safe_routes_timeout" ||
                    h.directionsError.code === "INTERNAL_ERROR"
                      ? "#d97706"
                      : "#dc2626"
                  }
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.warningTitle}>
                    {h.directionsError.code === "NO_ROUTE_FOUND"
                      ? "No route found"
                      : h.directionsError.code === "NO_NEARBY_ROAD"
                        ? "No road nearby"
                        : h.directionsError.code === "NO_WALKING_NETWORK"
                          ? "No walkable roads"
                          : h.directionsError.code === "safe_routes_timeout"
                            ? "Request timed out"
                            : h.directionsError.code === "INTERNAL_ERROR"
                              ? "Something went wrong"
                              : "Route error"}
                  </Text>
                  <Text style={styles.warningText}>
                    {h.directionsError.message}
                  </Text>
                  {h.directionsError.details?.detail ? (
                    <Text style={styles.warningDetail}>
                      {String(h.directionsError.details.detail)}
                    </Text>
                  ) : null}
                  <Text style={styles.warningHint}>
                    {h.directionsError.code === "NO_ROUTE_FOUND"
                      ? "💡 The two points are probably on separate road networks — try a destination on the same side of any rivers, motorways, or railways."
                      : h.directionsError.code === "NO_NEARBY_ROAD"
                        ? "💡 Move the pin closer to a visible street or footpath on the map."
                        : h.directionsError.code === "NO_WALKING_NETWORK"
                          ? "💡 This area only has motorways or private roads. Pick a more residential destination."
                          : h.directionsError.code === "safe_routes_timeout"
                            ? "💡 Shorter routes compute faster. Try somewhere within 3 mi."
                            : h.directionsError.code === "INTERNAL_ERROR"
                              ? "💡 This is usually temporary — wait a moment and try again."
                              : "💡 Try again, or pick a different destination."}
                  </Text>
                </View>
              </View>
            )}

            {/* Route cards + safety panel — stacked in sidebar */}
            <View style={styles.routeSafetyRow}>
              <RouteList
                routes={h.safeRoutes}
                selectedRouteId={h.selectedRouteId}
                onSelectRoute={h.setSelectedRouteId}
                inSidebar
              />

              {showSafety && h.safetyResult && h.selectedSafeRoute && (
                <SafetyPanel
                  safetyResult={h.safetyResult}
                  selectedSafeRoute={h.selectedSafeRoute}
                  onCategoryPress={handleCategoryPress}
                  inSidebar
                />
              )}
            </View>

            {h.selectedRouteId && h.nav.state === "idle" && (
              <Pressable
                style={styles.startNavButton}
                onPress={() => setShowDownloadModal(true)}
                accessibilityRole="button"
                accessibilityLabel="Start navigation"
              >
                <Ionicons name="navigate" size={20} color="#ffffff" />
                <Text style={styles.startNavButtonText}>Start Navigation</Text>
              </Pressable>
            )}

            {h.routes.length > 0 && h.nav.state === "idle" && (
              <View style={styles.viaRow}>
                <Pressable
                  style={styles.viaButton}
                  onPress={() => h.setPinMode("via")}
                  accessibilityRole="button"
                  accessibilityLabel="Re-route via a point"
                >
                  <Ionicons
                    name="git-branch-outline"
                    size={15}
                    color="#d946ef"
                  />
                  <Text style={styles.viaButtonText}>Re-route via…</Text>
                </Pressable>
                {h.viaPinLocation && (
                  <Pressable
                    style={styles.viaClearButton}
                    onPress={() => h.clearViaPin()}
                    accessibilityRole="button"
                    accessibilityLabel="Clear via point"
                  >
                    <Ionicons name="close-circle" size={15} color="#667085" />
                    <Text style={styles.viaClearText}>Clear via</Text>
                  </Pressable>
                )}
              </View>
            )}

            {showSafety &&
              h.selectedSafeRoute &&
              Object.keys(h.selectedSafeRoute.safety.roadTypes).length > 0 && (
                <RoadTypeBreakdown
                  roadTypes={h.selectedSafeRoute.safety.roadTypes}
                />
              )}

            {showSafety &&
              h.selectedSafeRoute?.enrichedSegments &&
              h.selectedSafeRoute.enrichedSegments.length > 1 && (
                <SafetyProfileChart
                  segments={h.routeSegments}
                  enrichedSegments={h.selectedSafeRoute.enrichedSegments}
                  roadNameChanges={
                    h.selectedSafeRoute.routeStats?.roadNameChanges ?? []
                  }
                  totalDistance={h.selectedSafeRoute.distanceMeters}
                />
              )}
          </WebSidebar>
        )}

        {/* ══════════════════════════════════════════════════════════════
         * PHONE WEB LAYOUT — Google Maps-style top pill + bottom sheet
         * Only for web viewports < 768px. Android/iOS unaffected.
         * ══════════════════════════════════════════════════════════════ */}
        {isPhoneWeb && !h.isNavActive && (
          <>
            {/* Download banner */}
            <AndroidDownloadBanner />

            {/* MobileWebSearchBar — collapsible pill */}
            <MobileWebSearchBar
              location={h.location}
              isUsingCurrentLocation={h.isUsingCurrentLocation}
              setIsUsingCurrentLocation={h.setIsUsingCurrentLocation}
              originSearch={h.originSearch}
              manualOrigin={h.manualOrigin}
              setManualOrigin={h.setManualOrigin}
              destSearch={h.destSearch}
              manualDest={h.manualDest}
              setManualDest={h.setManualDest}
              pinMode={h.pinMode}
              setPinMode={h.setPinMode}
              onPanTo={h.handlePanTo}
              onClearRoute={h.clearSelectedRoute}
              onSwap={h.swapOriginAndDest}
              onGuestTap={isWebGuest ? promptLogin : undefined}
              destinationCandidates={h.destinationCandidates}
              selectedDestinationCandidateId={h.selectedDestinationCandidateId}
              onSelectDestinationCandidate={h.selectDestinationCandidate}
              onFindSafeRoutes={h.activateSelectedDestinationCandidate}
              renderCandidatesInSheet
              hasResults={
                h.routes.length > 0 ||
                h.destinationCandidates.length > 0 ||
                hasLiveDestinationPredictions
              }
              savedPlaces={savedPlaces}
              onSelectSavedPlace={handleSelectSavedPlace}
              onSavePlace={savePlace}
              onRemoveSavedPlace={removePlace}
              onSavedPlaceToast={handleSavedPlaceToast}
              onExpandedChange={setIsSearchBarExpanded}
              {...mobileSearchBarLayoutCallbacks}
            />

            {/* Login button for guest */}
            {isWebGuest && (
              <View
                style={{
                  position: "absolute",
                  top: 100,
                  left: 12,
                  right: 12,
                  zIndex: 45,
                  alignItems: "center",
                }}
              >
                <WebLoginButton onPress={promptLogin} />
              </View>
            )}

            {/* Phone web bottom sheet */}
            <MobileWebSheet visible={sheetVisible}>
              {renderDestinationCandidatesSection("sheet-candidate-web")}

              {hasRouteRequestState && (
                <View style={styles.sheetHeader}>
                  <Text style={styles.sheetTitle}>
                    {hasError && h.routes.length === 0 ? "Oops!!" : "Routes"}
                  </Text>
                  {!hasError && h.selectedRoute && (
                    <Text style={styles.sheetMeta}>
                      {distanceLabel} · {durationLabel}
                    </Text>
                  )}
                  {h.routes.length > 0 && (
                    <Pressable
                      onPress={h.clearRouteResults}
                      hitSlop={8}
                      style={{ marginLeft: 8 }}
                    >
                      <Ionicons name="close" size={18} color="#667085" />
                    </Pressable>
                  )}
                </View>
              )}

              {h.directionsStatus === "loading" && (
                <JailLoadingAnimation
                  progressPct={h.vizProgressPct}
                  statusMessage={h.vizProgressMessage}
                />
              )}

              {h.outOfRange && (
                <View style={styles.warningBanner}>
                  <Ionicons name="ban-outline" size={20} color="#dc2626" />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.warningTitle}>
                      Destination out of range
                    </Text>
                    <Text style={styles.warningText}>
                      {h.outOfRangeMessage ||
                        "Destination is too far away (max 6.2 mi walking distance)."}
                    </Text>
                    {h.directionsError?.details?.detail ? (
                      <Text style={styles.warningDetail}>
                        {String(h.directionsError.details.detail)}
                      </Text>
                    ) : null}
                    <Text style={styles.warningHint}>
                      💡 Try selecting a closer destination, or split your
                      journey into shorter legs.
                    </Text>
                  </View>
                </View>
              )}

              {h.directionsError && !h.outOfRange && (
                <View
                  style={[
                    styles.warningBanner,
                    h.directionsError.code === "INTERNAL_ERROR" && {
                      backgroundColor: "#fffbeb",
                    },
                  ]}
                >
                  <Ionicons
                    name={
                      h.directionsError.code === "NO_ROUTE_FOUND"
                        ? "git-branch-outline"
                        : h.directionsError.code === "NO_NEARBY_ROAD"
                          ? "location-outline"
                          : h.directionsError.code === "NO_WALKING_NETWORK"
                            ? "walk-outline"
                            : h.directionsError.code === "safe_routes_timeout"
                              ? "time-outline"
                              : h.directionsError.code === "INTERNAL_ERROR"
                                ? "cloud-offline-outline"
                                : "alert-circle"
                    }
                    size={20}
                    color={
                      h.directionsError.code === "safe_routes_timeout" ||
                      h.directionsError.code === "INTERNAL_ERROR"
                        ? "#d97706"
                        : "#dc2626"
                    }
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.warningTitle}>
                      {h.directionsError.code === "NO_ROUTE_FOUND"
                        ? "No route found"
                        : h.directionsError.code === "NO_NEARBY_ROAD"
                          ? "No road nearby"
                          : h.directionsError.code === "NO_WALKING_NETWORK"
                            ? "No walkable roads"
                            : h.directionsError.code === "safe_routes_timeout"
                              ? "Request timed out"
                              : h.directionsError.code === "INTERNAL_ERROR"
                                ? "Something went wrong"
                                : "Route error"}
                    </Text>
                    <Text style={styles.warningText}>
                      {h.directionsError.message}
                    </Text>
                    {h.directionsError.details?.detail ? (
                      <Text style={styles.warningDetail}>
                        {String(h.directionsError.details.detail)}
                      </Text>
                    ) : null}
                    <Text style={styles.warningHint}>
                      {h.directionsError.code === "NO_ROUTE_FOUND"
                        ? "💡 The two points are probably on separate road networks — try a destination on the same side of any rivers, motorways, or railways."
                        : h.directionsError.code === "NO_NEARBY_ROAD"
                          ? "💡 Move the pin closer to a visible street or footpath on the map."
                          : h.directionsError.code === "NO_WALKING_NETWORK"
                            ? "💡 This area only has motorways or private roads. Pick a more residential destination."
                            : h.directionsError.code === "safe_routes_timeout"
                              ? "💡 Shorter routes compute faster. Try somewhere within 3 mi."
                              : h.directionsError.code === "INTERNAL_ERROR"
                                ? "💡 This is usually temporary — wait a moment and try again."
                                : "💡 Try again, or pick a different destination."}
                    </Text>
                  </View>
                </View>
              )}

              <RouteList
                routes={h.safeRoutes}
                selectedRouteId={h.selectedRouteId}
                onSelectRoute={h.setSelectedRouteId}
                inSidebar
              />

              {showSafety && h.safetyResult && h.selectedSafeRoute && (
                <SafetyPanel
                  safetyResult={h.safetyResult}
                  selectedSafeRoute={h.selectedSafeRoute}
                  onCategoryPress={handleCategoryPress}
                  inSidebar
                />
              )}

              {h.selectedRouteId && h.nav.state === "idle" && (
                <Pressable
                  style={styles.startNavButton}
                  onPress={() => setShowDownloadModal(true)}
                  accessibilityRole="button"
                  accessibilityLabel="Start navigation"
                >
                  <Ionicons name="navigate" size={20} color="#ffffff" />
                  <Text style={styles.startNavButtonText}>
                    Start Navigation
                  </Text>
                </Pressable>
              )}

              {h.routes.length > 0 && h.nav.state === "idle" && (
                <View style={styles.viaRow}>
                  <Pressable
                    style={styles.viaButton}
                    onPress={() => h.setPinMode("via")}
                    accessibilityRole="button"
                    accessibilityLabel="Re-route via a point"
                  >
                    <Ionicons
                      name="git-branch-outline"
                      size={15}
                      color="#d946ef"
                    />
                    <Text style={styles.viaButtonText}>Re-route via…</Text>
                  </Pressable>
                  {h.viaPinLocation && (
                    <Pressable
                      style={styles.viaClearButton}
                      onPress={() => h.clearViaPin()}
                      accessibilityRole="button"
                      accessibilityLabel="Clear via point"
                    >
                      <Ionicons name="close-circle" size={15} color="#667085" />
                      <Text style={styles.viaClearText}>Clear via</Text>
                    </Pressable>
                  )}
                </View>
              )}

              {showSafety &&
                h.selectedSafeRoute &&
                Object.keys(h.selectedSafeRoute.safety.roadTypes).length >
                  0 && (
                  <RoadTypeBreakdown
                    roadTypes={h.selectedSafeRoute.safety.roadTypes}
                  />
                )}

              {showSafety &&
                h.selectedSafeRoute?.enrichedSegments &&
                h.selectedSafeRoute.enrichedSegments.length > 1 && (
                  <SafetyProfileChart
                    segments={h.routeSegments}
                    enrichedSegments={h.selectedSafeRoute.enrichedSegments}
                    roadNameChanges={
                      h.selectedSafeRoute.routeStats?.roadNameChanges ?? []
                    }
                    totalDistance={h.selectedSafeRoute.distanceMeters}
                  />
                )}
            </MobileWebSheet>
          </>
        )}

        {/* ══════════════════════════════════════════════════════════════
         * MOBILE LAYOUT — Original centered search + bottom sheet
         * ══════════════════════════════════════════════════════════════ */}

        {/* Mobile: Android download banner (also shows on web if sidebar not active) */}
        {!isWeb && <AndroidDownloadBanner />}

        {/* ── Pin-mode banner ── */}
        {h.pinMode && (
          <View style={[styles.pinBanner, pinBannerOverlayStyle]}>
            <View style={styles.pinBannerInner}>
              <Ionicons name="location" size={18} color="#ffffff" />
              <Text style={styles.pinBannerText}>
                {h.pinMode === "via"
                  ? "Tap the map to set a via point — routes will re-run through it"
                  : `Tap anywhere on the map to set your ${h.pinMode === "origin" ? "starting point" : "destination"}`}
              </Text>
            </View>
            <Pressable
              onPress={() => h.setPinMode(null)}
              style={styles.pinBannerCancel}
            >
              <Text style={styles.pinBannerCancelText}>Cancel</Text>
            </Pressable>
          </View>
        )}

        {/* ── Search bar (mobile only — web uses sidebar) ── */}
        {!isWeb && !h.isNavActive && (
          <MobileWebSearchBar
            topInset={insets.top + webBannerOffset}
            location={h.location}
            isUsingCurrentLocation={h.isUsingCurrentLocation}
            setIsUsingCurrentLocation={h.setIsUsingCurrentLocation}
            originSearch={h.originSearch}
            manualOrigin={h.manualOrigin}
            setManualOrigin={h.setManualOrigin}
            destSearch={h.destSearch}
            manualDest={h.manualDest}
            setManualDest={h.setManualDest}
            pinMode={h.pinMode}
            setPinMode={h.setPinMode}
            onPanTo={h.handlePanTo}
            onClearRoute={h.clearSelectedRoute}
            onSwap={h.swapOriginAndDest}
            onGuestTap={isWebGuest ? promptLogin : undefined}
            destinationCandidates={h.destinationCandidates}
            selectedDestinationCandidateId={h.selectedDestinationCandidateId}
            onSelectDestinationCandidate={h.selectDestinationCandidate}
            onFindSafeRoutes={h.activateSelectedDestinationCandidate}
            renderCandidatesInSheet
            hasResults={
              h.routes.length > 0 ||
              h.destinationCandidates.length > 0 ||
              hasLiveDestinationPredictions
            }
            savedPlaces={savedPlaces}
            onSelectSavedPlace={handleSelectSavedPlace}
            onSavePlace={savePlace}
            onRemoveSavedPlace={removePlace}
            onSavedPlaceToast={handleSavedPlaceToast}
            onExpandedChange={setIsSearchBarExpanded}
            {...mobileSearchBarLayoutCallbacks}
          />
        )}

        {!h.isNavActive && (showSearchAroundButton || searchAroundLimitReached) && (
          <View
            pointerEvents="box-none"
            style={[
              styles.searchAroundFloatingWrap,
              isDesktopWeb
                ? {
                    left: webSidebarOverlayOffset,
                    right: 0,
                    width: Math.max(0, viewportWidth - webSidebarOverlayOffset),
                    paddingHorizontal: 0,
                  }
                : null,
              {
                top: searchAroundFloatingTop,
              },
            ]}
          >
            {showSearchAroundButton ? (
              <Pressable
                style={styles.searchAroundFloatingBtn}
                onPress={performSearchAround}
                disabled={isSearchAroundLoading}
                accessibilityRole="button"
                accessibilityLabel="Search around here"
              >
                {isSearchAroundLoading ? (
                  <View style={styles.searchAroundFloatingLoadingRow}>
                    <ActivityIndicator size="small" color="#111111" />
                    <Text style={styles.searchAroundFloatingBtnText}>Searching…</Text>
                  </View>
                ) : (
                  <View style={styles.searchAroundFloatingBtnInner}>
                    <View style={styles.searchAroundPulse} />
                    <Text style={styles.searchAroundFloatingBtnText}>Search around here</Text>
                  </View>
                )}
              </Pressable>
            ) : (
              <View style={styles.searchAroundFloatingLimit}>
                <Text style={styles.searchAroundFloatingLimitText}>
                  Search around unavailable beyond 30 miles.
                </Text>
              </View>
            )}
          </View>
        )}

        {/* ── Web guest: Login button (under search bar) — mobile only, web uses sidebar ── */}
        {!isWeb && !h.isNavActive && isWebGuest && (
          <View
            style={{
              position: "absolute",
              top: insets.top + webBannerOffset + 80,
              left: 0,
              right: 0,
              zIndex: 110,
              alignItems: "center",
              paddingHorizontal: 10,
            }}
          >
            <WebLoginButton onPress={promptLogin} />
          </View>
        )}

        {
          <MapControlRail
            layoutInput={{
              viewportHeight: windowHeight,
              topInset: insets.top,
              bottomInset: insets.bottom,
              searchBoundaryBottom: searchBottomYForRail,
              sheetBoundaryTop: currentSheetTopY,
            }}
            profileControl={() => {
              if (h.isNavActive || !auth.isLoggedIn) return null;
              return (
                <ProfileMenu
                  name={auth.user?.name ?? auth.user?.username ?? null}
                  email={auth.user?.email ?? null}
                  subscriptionTier={subscriptionTier}
                  isGift={auth.user?.isGift}
                  subscriptionEndsAt={auth.user?.subscriptionEndsAt}
                  onLogout={auth.logout}
                  onManageSubscription={() => setShowSubscriptionModal(true)}
                  onChangePassword={auth.changePassword}
                />
              );
            }}
            safetyCircleControl={() => {
              if (h.isNavActive || !auth.isLoggedIn) return null;
              return (
                <BuddyButton
                  username={auth.user?.username ?? null}
                  userId={auth.user?.id ?? null}
                  hasLiveContacts={liveContacts.length > 0}
                  onContactsChanged={handleContactsChanged}
                />
              );
            }}
            liveLocationControl={() => {
              if (h.isNavActive || !auth.isLoggedIn) return null;
              return (
                <Pressable
                  onPress={handleFriendToggle}
                  style={[
                    styles.friendToggle,
                    showFriendsOnMap && styles.friendToggleActive,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={
                    showFriendsOnMap
                      ? "Hide friends on map"
                      : "Show friends on map"
                  }
                >
                  <Ionicons
                    name={showFriendsOnMap ? "people" : "people-outline"}
                    size={20}
                    color={showFriendsOnMap ? "#fff" : "#7C3AED"}
                  />
                </Pressable>
              );
            }}
            currentLocationControl={() => {
              return (
                <Pressable
                  onPress={handleMoveToCurrentLocation}
                  style={[
                    styles.currentLocationBtn,
                    isAtCurrentLocation
                      ? styles.currentLocationBtnActive
                      : styles.currentLocationBtnInactive,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={
                    isAtCurrentLocation
                      ? "You are at current location"
                      : isFindingCurrentLocation
                        ? "Finding current location"
                        : "Move to current location"
                  }
                >
                  {isAtCurrentLocation ? (
                    <View style={styles.currentLocationDotOuter}>
                      <View style={styles.currentLocationDotInner} />
                    </View>
                  ) : (
                    <Ionicons name="locate-outline" size={20} color="#E5E7EB" />
                  )}
                </Pressable>
              );
            }}
            reportControl={() => {
              if (!auth.isLoggedIn) return null;
              return (
                <Pressable
                  onPress={() => setShowReportModal(true)}
                  style={styles.reportBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Report a hazard"
                >
                  <Ionicons name="flag-outline" size={20} color="#EF4444" />
                </Pressable>
              );
            }}
          />
        }

        {!h.isNavActive && hasRoutesWithLabels && (
          <View
            pointerEvents="box-none"
            style={[
              styles.extraDetailToggleWrap,
              {
                top: insets.top + webBannerOffset + (isWeb && !isPhoneWeb ? 92 : 96),
                left: isWeb && !isPhoneWeb ? webSidebarOverlayOffset + 12 : 12,
              },
            ]}
          >
            <Pressable
              onPress={() => setShowMapExtraDetail((prev) => !prev)}
              style={[
                styles.extraDetailToggle,
                showMapExtraDetail
                  ? styles.extraDetailToggleActive
                  : styles.extraDetailToggleInactive,
              ]}
              accessibilityRole="switch"
              accessibilityState={{ checked: showMapExtraDetail }}
              accessibilityLabel="Toggle extra map detail"
            >
              <Ionicons
                name={showMapExtraDetail ? "eye" : "eye-off"}
                size={14}
                color={showMapExtraDetail ? "#0f5132" : "#475467"}
              />
              <Text
                style={[
                  styles.extraDetailToggleText,
                  showMapExtraDetail
                    ? styles.extraDetailToggleTextActive
                    : styles.extraDetailToggleTextInactive,
                ]}
              >
                Extra detail
              </Text>
            </Pressable>
          </View>
        )}

        {/* ── Category highlight banner — shows when user tapped a stat card ── */}
        {h.highlightCategory && (
          <View
            style={[
              styles.highlightBanner,
              {
                top: insets.top + 120,
                left: webSidebarOverlayOffset,
              },
            ]}
          >
            <Pressable
              style={styles.highlightBannerInner}
              onPress={handleClearHighlight}
              accessibilityRole="button"
              accessibilityLabel="Show all markers"
            >
              <Text style={styles.highlightBannerText}>
                Showing{" "}
                {(
                  categoryLabels[h.highlightCategory] || h.highlightCategory
                ).toLowerCase()}{" "}
                only · tap to view all
              </Text>
              <Ionicons
                name="close-circle"
                size={16}
                color="rgba(255,255,255,0.8)"
              />
            </Pressable>
          </View>
        )}

        {h.needsLocationRecovery && !h.isNavActive && (
          <View
            style={[
              styles.locationRecoveryWrap,
              { top: insets.top + 86, left: webSidebarOverlayOffset },
            ]}
          >
            <View style={styles.locationRecoveryCard}>
              <Ionicons name="locate-outline" size={16} color="#1570ef" />
              <Text style={styles.locationRecoveryText}>
                {h.locationRecoveryReason === "denied"
                  ? "Location permission is blocked. Enable it to stop defaulting to London."
                  : h.locationRecoveryReason === "error"
                    ? "We couldn't read your current location."
                    : "Still trying to get your location..."}
              </Text>
              <Pressable
                style={styles.locationRecoveryBtn}
                onPress={() => {
                  h.refreshLocation();
                }}
                accessibilityRole="button"
                accessibilityLabel="Retry location"
              >
                <Text style={styles.locationRecoveryBtnText}>Retry</Text>
              </Pressable>
              <Pressable
                style={styles.locationRecoveryLink}
                onPress={handleLocationHelp}
                accessibilityRole="button"
                accessibilityLabel="Location help"
              >
                <Text style={styles.locationRecoveryLinkText}>Help</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* ── AI floating button (logged in only) ── */}
        {h.safetyResult &&
          !h.isNavActive &&
          h.routes.length > 0 &&
          auth.isLoggedIn &&
          !isWeb && (
            <Animated.View
              pointerEvents="box-none"
              style={[
                styles.aiWrap,
                {
                  bottom: Animated.add(h.sheetHeight, 12),
                },
              ]}
            >
              <Pressable
                style={styles.aiButton}
                onPress={() => {
                  h.setShowAIModal(true);
                  if (h.ai.status === "idle") h.ai.ask();
                }}
                accessibilityRole="button"
                accessibilityLabel="Why is this the safest route"
              >
                <Ionicons name="sparkles" size={16} color="#ffffff" />
                <Text style={styles.aiText}>Why is this the safest route?</Text>
              </Pressable>
            </Animated.View>
          )}

        {/* ── Bottom sheet (mobile only — web uses sidebar) ── */}
        {!isWeb && (
          <DraggableSheet
            visible={sheetVisible}
            bottomInset={insets.bottom}
            sheetHeight={h.sheetHeight}
            sheetHeightRef={h.sheetHeightRef}
            scrollRef={sheetScrollRef}
            stickyHeaderIndices={Platform.OS === 'android' ? undefined : [0]}
          >
            {renderDestinationCandidatesSection("sheet-candidate-native")}

            {/* Header — hide distance/duration when there's only an error */}
            {hasRouteRequestState && (
              <View style={styles.sheetHeader}>
                <Text style={styles.sheetTitle}>
                  {hasError && h.routes.length === 0 ? "Oops!!" : "Routes"}
                </Text>
                {!hasError && h.selectedRoute && (
                  <Text style={styles.sheetMeta}>
                    {distanceLabel} · {durationLabel}
                  </Text>
                )}
              </View>
            )}

            {/* Loading state */}
            {h.directionsStatus === "loading" && (
              <JailLoadingAnimation
                progressPct={h.vizProgressPct}
                statusMessage={h.vizProgressMessage}
              />
            )}

            {/* Out-of-range warning */}
            {h.outOfRange && (
              <View style={styles.warningBanner}>
                <Ionicons name="ban-outline" size={20} color="#dc2626" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.warningTitle}>
                    Destination out of range
                  </Text>
                  <Text style={styles.warningText}>
                    {h.outOfRangeMessage ||
                      "Destination is too far away (max 6.2 mi walking distance)."}
                  </Text>
                  {h.directionsError?.details?.detail ? (
                    <Text style={styles.warningDetail}>
                      {String(h.directionsError.details.detail)}
                    </Text>
                  ) : null}
                  <Text style={styles.warningHint}>
                    💡 Try selecting a closer destination, or split your journey
                    into shorter legs.
                  </Text>
                </View>
              </View>
            )}

            {h.directionsError && !h.outOfRange && (
              <View
                style={[
                  styles.warningBanner,
                  h.directionsError.code === "INTERNAL_ERROR" && {
                    backgroundColor: "#fffbeb",
                  },
                ]}
              >
                <Ionicons
                  name={
                    h.directionsError.code === "NO_ROUTE_FOUND"
                      ? "git-branch-outline"
                      : h.directionsError.code === "NO_NEARBY_ROAD"
                        ? "location-outline"
                        : h.directionsError.code === "NO_WALKING_NETWORK"
                          ? "walk-outline"
                          : h.directionsError.code === "safe_routes_timeout"
                            ? "time-outline"
                            : h.directionsError.code === "INTERNAL_ERROR"
                              ? "cloud-offline-outline"
                              : "alert-circle"
                  }
                  size={20}
                  color={
                    h.directionsError.code === "safe_routes_timeout" ||
                    h.directionsError.code === "INTERNAL_ERROR"
                      ? "#d97706"
                      : "#dc2626"
                  }
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.warningTitle}>
                    {h.directionsError.code === "NO_ROUTE_FOUND"
                      ? "No route found"
                      : h.directionsError.code === "NO_NEARBY_ROAD"
                        ? "No road nearby"
                        : h.directionsError.code === "NO_WALKING_NETWORK"
                          ? "No walkable roads"
                          : h.directionsError.code === "safe_routes_timeout"
                            ? "Request timed out"
                            : h.directionsError.code === "INTERNAL_ERROR"
                              ? "Something went wrong"
                              : "Route error"}
                  </Text>
                  <Text style={styles.warningText}>
                    {h.directionsError.message}
                  </Text>
                  {h.directionsError.details?.detail ? (
                    <Text style={styles.warningDetail}>
                      {String(h.directionsError.details.detail)}
                    </Text>
                  ) : null}
                  <Text style={styles.warningHint}>
                    {h.directionsError.code === "NO_ROUTE_FOUND"
                      ? "💡 The two points are probably on separate road networks — try a destination on the same side of any rivers, motorways, or railways."
                      : h.directionsError.code === "NO_NEARBY_ROAD"
                        ? "💡 Move the pin closer to a visible street or footpath on the map."
                        : h.directionsError.code === "NO_WALKING_NETWORK"
                          ? "💡 This area only has motorways or private roads. Pick a more residential destination."
                          : h.directionsError.code === "safe_routes_timeout"
                            ? "💡 Shorter routes compute faster. Try somewhere within 3 mi."
                            : h.directionsError.code === "INTERNAL_ERROR"
                              ? "💡 This is usually temporary — wait a moment and try again."
                              : "💡 Try again, or pick a different destination."}
                  </Text>
                </View>
              </View>
            )}

            {/* Route cards — safety details hidden behind per-card toggle */}
            <RouteList
              routes={h.safeRoutes}
              selectedRouteId={h.selectedRouteId}
              onSelectRoute={h.setSelectedRouteId}
              detailsPanel={
                showSafety && h.safetyResult && h.selectedSafeRoute ? (
                  <>
                    <SafetyPanel
                      safetyResult={h.safetyResult}
                      selectedSafeRoute={h.selectedSafeRoute}
                      onCategoryPress={handleCategoryPress}
                      inSidebar
                    />
                    {Object.keys(h.selectedSafeRoute.safety.roadTypes).length >
                      0 && (
                      <RoadTypeBreakdown
                        roadTypes={h.selectedSafeRoute.safety.roadTypes}
                      />
                    )}
                    {h.selectedSafeRoute.enrichedSegments &&
                      h.selectedSafeRoute.enrichedSegments.length > 1 && (
                        <SafetyProfileChart
                          segments={h.routeSegments}
                          enrichedSegments={
                            h.selectedSafeRoute.enrichedSegments
                          }
                          roadNameChanges={
                            h.selectedSafeRoute.routeStats?.roadNameChanges ??
                            []
                          }
                          totalDistance={h.selectedSafeRoute.distanceMeters}
                        />
                      )}
                  </>
                ) : undefined
              }
            />

            {/* Start navigation — full width */}
            {h.selectedRouteId && h.nav.state === "idle" && (
              <Pressable
                style={styles.startNavButton}
                onPress={handleStartNavigation}
                accessibilityRole="button"
                accessibilityLabel="Start navigation"
              >
                <Ionicons name="navigate" size={20} color="#ffffff" />
                <Text style={styles.startNavButtonText}>Start Navigation</Text>
              </Pressable>
            )}

            {/* Re-route via a point — shown when routes are ready and not navigating */}
            {h.routes.length > 0 &&
              h.nav.state === "idle" &&
              !h.isNavActive && (
                <View style={styles.viaRow}>
                  <TouchableOpacity
                    style={styles.viaButton}
                    onPress={() => h.setPinMode("via")}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel="Re-route via a point"
                  >
                    <Ionicons
                      name="git-branch-outline"
                      size={15}
                      color="#d946ef"
                    />
                    <Text style={styles.viaButtonText}>
                      Re-route via a point
                    </Text>
                  </TouchableOpacity>
                  {h.viaPinLocation && (
                    <TouchableOpacity
                      style={styles.viaClearButton}
                      onPress={() => h.clearViaPin()}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityLabel="Clear via point"
                    >
                      <Ionicons name="close-circle" size={15} color="#667085" />
                      <Text style={styles.viaClearText}>Clear via point</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}
          </DraggableSheet>
        )}

        {/* ── Modals / Overlays ── */}
        <AIExplanationModal
          visible={h.showAIModal}
          ai={h.ai}
          onClose={() => {
            h.setShowAIModal(false);
            h.ai.reset();
          }}
        />

        <OnboardingModal
          visible={h.showOnboarding}
          error={h.onboardingError}
          onAccept={h.handleAcceptOnboarding}
          onDismiss={() => h.setShowOnboarding(false)}
        />

        {Platform.OS !== "web" && (
            <NavigationOverlay
              nav={h.nav}
              topInset={insets.top}
              bottomInset={insets.bottom}
              showRecenter={h.isNavActive && !isNavFollowing}
              onRecenter={handleRecenterNavigation}
              liveSharingNotice={liveSharingNotice}
              navAlert={navAlert}
              showReportButton={auth.isLoggedIn && h.isNavActive}
              onPressReport={() => setShowReportModal(true)}
            />
        )}

        <DownloadAppModal
          visible={showDownloadModal}
          onClose={() => setShowDownloadModal(false)}
        />

        {/* ── Toast notifications ── */}
        <MapToast
          toast={toast}
          onDismiss={() => setToast(null)}
          webTopOffset={isDesktopWeb ? 16 : 12}
          webLeftOffset={webSidebarOverlayOffset}
        />

        {/* ── Report modal ── */}
        <ReportModal
          visible={showReportModal}
          location={h.location}
          onClose={() => setShowReportModal(false)}
          onSubmitted={handleReportSubmitted}
        />

        {/* ── Web guest login prompt (dismissable) ── */}
        <LoginModal
          visible={showLoginPrompt}
          onClose={() => setShowLoginPrompt(false)}
          onCheckAuthOptions={auth.checkAuthOptions}
          onSendMagicLink={auth.sendMagicLink}
          onSignInWithPassword={auth.signInWithPassword}
          onForgotPassword={auth.forgotPassword}
          onVerify={auth.verify}
          error={auth.error}
          dismissable={true}
        />

        {/* ── Background location disclosure (Android — Google Play requirement) ── */}
        <BackgroundLocationModal
          visible={live.showBackgroundDisclosure}
          onAllow={live.confirmBackgroundPermission}
          onDeny={live.denyBackgroundPermission}
        />

        {/* ── Subscription limit popup ── */}
        <LimitReachedModal
          visible={limitModal !== null}
          limitInfo={limitModal}
          onClose={() => {
            if (limitModal?.feature === 'live_sessions') {
              dismissedLimitRef.current['live_sessions'] = true;
              setLiveSharingNotice('Location not shared — limit reached for your plan.');
            }
            setLimitModal(null);
          }}
          onUpgrade={() => setShowSubscriptionModal(true)}
        />

        {/* ── Subscription upgrade / manage modal ── */}
        <SubscriptionModal
          visible={showSubscriptionModal}
          currentTier={subscriptionTier}
          isGift={auth.user?.isGift}
          isFamilyPack={auth.user?.isFamilyPack}
          subscriptionEndsAt={auth.user?.subscriptionEndsAt}
          onClose={() => setShowSubscriptionModal(false)}
          onSubscriptionChanged={() => auth.refreshProfile?.()}
          onOpenFamilyPack={() => setShowFamilyPackModal(true)}
        />

        {/* ── Family Pack modal ── */}
        <FamilyPackModal
          visible={showFamilyPackModal}
          onClose={() => setShowFamilyPackModal(false)}
          onPackChanged={() => auth.refreshProfile?.()}
        />

        {/* ── Profile fetch failed — auto-logout overlay (no buttons) ── */}
        {auth.profileFetchFailed && (
          <View style={styles.profileFailOverlay}>
            <View style={styles.profileFailCard}>
              <Ionicons
                name="warning-outline"
                size={40}
                color="#F59E0B"
                style={{ marginBottom: 12 }}
              />
              <Text style={styles.profileFailTitle}>
                Unable to load your profile
              </Text>
              <Text style={styles.profileFailBody}>
                Your session is active but we couldn&apos;t retrieve your data.{"\n"}
                Logging you out automatically…
              </Text>
            </View>
          </View>
        )}
      </AndroidOverlayHost>
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  friendToggle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#fff",
    borderWidth: 2,
    borderColor: "#7C3AED",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 4,
  },
  friendToggleActive: {
    backgroundColor: "#7C3AED",
    borderColor: "#7C3AED",
  },
  reportBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#fff",
    borderWidth: 2,
    borderColor: "#EF4444",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 4,
  },
  currentLocationBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 4,
  },
  currentLocationBtnActive: {
    backgroundColor: "#fff",
    borderColor: "#1570EF",
  },
  currentLocationBtnInactive: {
    backgroundColor: "#111827",
    borderColor: "#111827",
  },
  currentLocationDotOuter: {
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(21,112,239,0.22)",
  },
  currentLocationDotInner: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#1570EF",
  },
  extraDetailToggleWrap: {
    position: "absolute",
    zIndex: 120,
  },
  extraDetailToggle: {
    minHeight: 34,
    borderRadius: 17,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    ...(Platform.OS === "web"
      ? { boxShadow: "0 6px 16px rgba(2, 6, 23, 0.16)" }
      : {}),
    elevation: 6,
  },
  extraDetailToggleActive: {
    backgroundColor: "#dcfce7",
    borderColor: "#16a34a",
  },
  extraDetailToggleInactive: {
    backgroundColor: "#ffffff",
    borderColor: "#d0d5dd",
  },
  extraDetailToggleText: {
    fontSize: 12,
    fontWeight: "700",
  },
  extraDetailToggleTextActive: {
    color: "#0f5132",
  },
  extraDetailToggleTextInactive: {
    color: "#344054",
  },
  pinBanner: {
    position: "absolute",
    backgroundColor: "#1570ef",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    ...(Platform.OS === "web"
      ? { boxShadow: "0 4px 12px rgba(21, 112, 239, 0.35)" }
      : {}),
    elevation: 10,
    zIndex: 40,
  },
  pinBannerInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  pinBannerText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "600",
    flex: 1,
  },
  pinBannerCancel: {
    backgroundColor: "rgba(255,255,255,0.2)",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginLeft: 8,
  },
  pinBannerCancelText: {
    color: "#ffffff",
    fontWeight: "600",
    fontSize: 13,
  },
  aiWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 13,
  },
  aiButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 24,
    backgroundColor: "#7c3aed",
    ...(Platform.OS === "web"
      ? { boxShadow: "0 4px 14px rgba(124, 58, 237, 0.4)" }
      : {}),
    elevation: 14,
  },
  aiText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "700",
  },
  viaRow: {
    flexDirection: "column",
    gap: 6,
    marginBottom: 8,
    marginTop: 4,
  },
  viaButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#d946ef",
    backgroundColor: "rgba(217,70,239,0.06)",
  },
  viaButtonText: {
    color: "#d946ef",
    fontSize: 13,
    fontWeight: "600",
    flexShrink: 1,
  },
  viaClearButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#d0d5dd",
    backgroundColor: "rgba(102,112,133,0.06)",
  },
  viaClearText: {
    color: "#667085",
    fontSize: 12,
    fontWeight: "500",
  },
  sheetHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },
  sheetTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#101828",
  },
  sheetMeta: {
    fontSize: 14,
    color: "#667085",
    fontWeight: "500",
  },
  warningBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderRadius: 10,
    backgroundColor: "#fef2f2",
  },
  placeResultsPanel: {
    marginBottom: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#dbeafe",
    backgroundColor: "#f8fbff",
    overflow: "hidden",
  },
  placeCategoryFiltersBlock: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#e6eefb",
    gap: 6,
  },
  placeFiltersHelperText: {
    fontSize: 11,
    color: "#475467",
    fontWeight: "500",
  },
  placeCategoriesWrap: {
    flexDirection: "row",
    flexWrap: "nowrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
  },
  placeCategoryBubble: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#bfdbfe",
    backgroundColor: "#eff6ff",
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 0,
  },
  placeCategoryBubbleIconOnly: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    gap: 4,
  },
  placeCategoryBubbleEqual: {
    flex: 1,
    minWidth: 0,
  },
  placeCategoryBubbleActive: {
    borderColor: "#1570ef",
    backgroundColor: "#dbeafe",
  },
  placeCategoryBubbleText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#1d4ed8",
    flexShrink: 1,
  },
  placeCategoryBubbleCount: {
    fontSize: 11,
    fontWeight: "700",
    color: "#1570ef",
    backgroundColor: "#dbeafe",
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  placeResultsHeader: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#e6eefb",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
  },
  searchAroundBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#ffffff",
    borderBottomWidth: 1,
    borderBottomColor: "#e6eefb",
  },
  searchAroundText: {
    color: "#334155",
    fontSize: 13,
    flex: 1,
    marginRight: 8,
  },
  searchAroundBtn: {
    backgroundColor: "#1570ef",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  searchAroundBtnText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 12,
  },
  searchAroundFloatingWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 210,
    alignItems: "center",
    paddingHorizontal: 12,
  },
  searchAroundFloatingBtn: {
    backgroundColor: "rgba(255,255,255,0.58)",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.65)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    ...(Platform.OS === "web"
      ? { boxShadow: "0 3px 10px rgba(0,0,0,0.18)" }
      : {
          shadowColor: "#000000",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.18,
          shadowRadius: 6,
          elevation: 5,
        }),
  } as any,
  searchAroundFloatingBtnText: {
    color: "#111111",
    fontSize: 12,
    fontWeight: "600",
  },
  searchAroundFloatingLoadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  searchAroundFloatingLimit: {
    backgroundColor: "rgba(15,23,42,0.78)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  searchAroundFloatingLimitText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "600",
  },
  searchAroundFloatingBtnInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  searchAroundPulse: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#1570ef",
  },
  placeResultsTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#1d4ed8",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  placeResultsActionBtn: {
    borderRadius: 8,
    backgroundColor: "#1570ef",
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  placeResultsActionText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#ffffff",
  },
  placeResultItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: "#edf2ff",
    gap: 3,
  },
  placeResultItemSelected: {
    backgroundColor: "#eef6ff",
  },
  placeResultTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  placeResultTitle: {
    flex: 1,
    fontSize: 14,
    fontWeight: "700",
    color: "#101828",
  },
  placeResultSecondary: {
    fontSize: 12,
    fontWeight: "500",
    color: "#667085",
    paddingLeft: 24,
  },
  placeResultDetailsWrap: {
    marginTop: 6,
    marginLeft: 24,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#dbeafe",
    backgroundColor: "#ffffff",
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 4,
  },
  placeResultDetailsText: {
    fontSize: 12,
    color: "#334155",
    fontWeight: "500",
  },
  placeResultDetailsMeta: {
    fontSize: 11,
    color: "#1d4ed8",
    fontWeight: "700",
  },
  placeResultDetailsCoords: {
    fontSize: 11,
    color: "#475467",
    fontWeight: "500",
  },
  warningTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#1f2937",
    marginBottom: 2,
  },
  warningText: {
    fontSize: 13,
    fontWeight: "500",
    color: "#dc2626",
  },
  warningDetail: {
    fontSize: 12,
    fontWeight: "400",
    color: "#374151",
    marginTop: 4,
    lineHeight: 17,
  },
  warningHint: {
    fontSize: 12,
    color: "#6b7280",
    marginTop: 4,
  },
  error: {
    fontSize: 14,
    color: "#d92d20",
    paddingVertical: 8,
  },
  startNavButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginBottom: 12,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: "#1570ef",
    width: "100%",
  } as any,
  startNavButtonText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 16,
  },
  routeSafetyRow: {
    width: "100%",
  },
  routeSafetyRowWeb: {
    flexDirection: "row",
    gap: 16,
    alignItems: "flex-start",
  } as any,
  highlightBanner: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 220,
    alignItems: "center",
  },
  highlightBannerInner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 20,
    backgroundColor: "rgba(21, 112, 239, 0.9)",
    maxWidth: 360,
    ...(Platform.OS === "web"
      ? { boxShadow: "0 2px 8px rgba(0,0,0,0.18)" }
      : {}),
    elevation: 14,
  } as any,
  highlightBannerText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "600",
  },
  locationRecoveryWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 120,
    alignItems: "center",
    paddingHorizontal: 12,
  },
  locationRecoveryCard: {
    width: "100%",
    maxWidth: 760,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#bfdbfe",
    backgroundColor: "#eff6ff",
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    ...(Platform.OS === "web"
      ? { boxShadow: "0 4px 12px rgba(21,112,239,0.15)" }
      : {
          shadowColor: "#1570ef",
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.15,
          shadowRadius: 10,
          elevation: 10,
        }),
  } as any,
  locationRecoveryText: {
    flex: 1,
    color: "#1d4ed8",
    fontSize: 12,
    fontWeight: "600",
  },
  locationRecoveryBtn: {
    borderRadius: 8,
    backgroundColor: "#1570ef",
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  locationRecoveryBtnText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
  },
  locationRecoveryLink: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#93c5fd",
    backgroundColor: "#ffffff",
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  locationRecoveryLinkText: {
    color: "#1d4ed8",
    fontSize: 12,
    fontWeight: "700",
  },
  profileFailOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 9999,
  } as any,
  profileFailCard: {
    backgroundColor: "#1F2937",
    borderRadius: 16,
    paddingVertical: 32,
    paddingHorizontal: 28,
    alignItems: "center",
    maxWidth: 340,
    width: "85%",
    ...(Platform.OS === "web"
      ? { boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }
      : {}),
    elevation: 20,
  } as any,
  profileFailTitle: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 10,
  },
  profileFailBody: {
    color: "#9CA3AF",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  stickyHeaderContainer: {
    backgroundColor: "#ffffff",
    borderBottomWidth: 1,
    borderBottomColor: "#e6eefb",
  },
  distanceFilterRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#e6eefb",
  },
  distanceFilterLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#475467",
  },
  distanceFilterOptions: {
    flexDirection: "row",
    gap: 6,
    flex: 1,
  },
  distanceFilterButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: "#f3f4f6",
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  distanceFilterButtonActive: {
    backgroundColor: "#1570ef",
    borderColor: "#1570ef",
  },
  distanceFilterButtonText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#475467",
  },
  distanceFilterButtonTextActive: {
    color: "#ffffff",
  },
});
