
/**
 * MobileWebSearchBar — collapsible search.
 *
 * Behaviour:
 *   - Default: single "Where to?" pill at the top
 *   - Tap pill → expands to dual origin/destination inputs with predictions
 *   - Search performed → collapses back to single pill showing destination name
 *   - Tap pill again → re-expands to dual inputs (does NOT edit destination inline)
 *
 * Used on phone-size web AND Android native.
 */
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ActivityIndicator,
    Animated,
  Easing,
    InteractionManager,
    type LayoutChangeEvent,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from "react-native";

import type { UseAutoPlaceSearchReturn } from "@/src/hooks/useAutoPlaceSearch";
import type { SavedPlace, SaveResult } from "@/src/hooks/useSavedPlaces";
import type { SafetyLevel } from "@/src/services/safeRoutes";
import type { LatLng, PlaceDetails, PlacePrediction } from "@/src/types/geo";
import { SafetyLevelToggle } from "./SafetyLevelToggle";
import { SavedPlaces } from "./SavedPlaces";

const CATEGORY_CHIP_DEFINITIONS: {
  key: string;
  label: string;
  query: string;
  icon: keyof typeof Ionicons.glyphMap;
}[] = [
  { key: "fuel", label: "Fuel", query: "fuel station", icon: "car-sport-outline" },
  { key: "shop", label: "Shops", query: "shops", icon: "bag-handle-outline" },
  { key: "food", label: "Food", query: "restaurants", icon: "restaurant-outline" },
  { key: "parking", label: "Parking", query: "parking", icon: "car-outline" },
  { key: "pharmacy", label: "Pharmacy", query: "pharmacy", icon: "medkit-outline" },
  { key: "hospital", label: "Hospital", query: "hospital", icon: "medical-outline" },
  { key: "bank", label: "Bank", query: "bank", icon: "cash-outline" },
  { key: "hotel", label: "Hotel", query: "hotel", icon: "bed-outline" },
];

function classifyPredictionCategory(prediction: PlacePrediction): string | null {
  const bucket = `${prediction.category || ""} ${prediction.placeType || ""} ${prediction.primaryText || ""} ${prediction.fullText || ""}`.toLowerCase();
  if (/\bfuel\b|petrol|gas station|charging_station|charging station/.test(bucket)) return "fuel";
  if (/\bparking\b|car park|park and ride/.test(bucket)) return "parking";
  if (/restaurant|cafe|coffee|pub|bar|fast_food|takeaway|food/.test(bucket)) return "food";
  if (/pharmacy|chemist|drugstore/.test(bucket)) return "pharmacy";
  if (/hospital|clinic|doctor|medical/.test(bucket)) return "hospital";
  if (/bank|atm/.test(bucket)) return "bank";
  if (/hotel|guest house|accommodation|lodging/.test(bucket)) return "hotel";
  if (/shop|supermarket|convenience|store|retail|mall/.test(bucket)) return "shop";
  return null;
}

// ── Props ────────────────────────────────────────────────────────────────────

export interface MobileWebSearchBarProps {
  location: LatLng | null;
  isUsingCurrentLocation: boolean;
  setIsUsingCurrentLocation: (v: boolean) => void;
  originSearch: UseAutoPlaceSearchReturn;
  manualOrigin: PlaceDetails | null;
  setManualOrigin: (v: PlaceDetails | null) => void;
  destSearch: UseAutoPlaceSearchReturn;
  manualDest: PlaceDetails | null;
  setManualDest: (v: PlaceDetails | null) => void;
  pinMode: "origin" | "destination" | "via" | null;
  setPinMode: (v: "origin" | "destination" | "via" | null) => void;
  onPanTo: (location: LatLng) => void;
  onClearRoute: () => void;
  onSwap: () => void;
  destinationCandidates?: PlacePrediction[];
  selectedDestinationCandidateId?: string | null;
  onSelectDestinationCandidate?: (placeId: string, panToCandidate?: boolean) => void;
  onFindSafeRoutes?: () => boolean;
  /** When true, destination candidate results are rendered in a bottom sheet instead of this dropdown. */
  renderCandidatesInSheet?: boolean;
  onGuestTap?: () => void;
  /** Whether route results are currently showing */
  hasResults: boolean;
  /** Safe-area top inset (used on Android) */
  topInset?: number;
  /** Saved places for quick access */
  savedPlaces?: SavedPlace[];
  onSelectSavedPlace?: (place: SavedPlace) => void;
  onSavePlace?: (
    place: Omit<SavedPlace, "id" | "createdAt">,
  ) => Promise<SaveResult> | SaveResult;
  onRemoveSavedPlace?: (id: string) => void;
  onSavedPlaceToast?: (msg: string, icon?: string) => void;
  /** Safety data level for route search (Extra = default) */
  safetyLevel?: SafetyLevel;
  onSafetyLevelChange?: (level: SafetyLevel) => void;
  /** Optional callback to report expanded/collapsed state to parent overlays. */
  onExpandedChange?: (expanded: boolean) => void;
  onContainerLayout?: (metrics: { y: number; height: number; bottom: number }) => void;
  onEffectiveBottomChange?: (bottomY: number) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

export function MobileWebSearchBar({
  location,
  isUsingCurrentLocation,
  setIsUsingCurrentLocation,
  originSearch,
  manualOrigin,
  setManualOrigin,
  destSearch,
  manualDest,
  setManualDest,
  pinMode,
  setPinMode,
  onPanTo,
  onClearRoute,
  onSwap,
  destinationCandidates = [],
  selectedDestinationCandidateId = null,
  onSelectDestinationCandidate,
  renderCandidatesInSheet = false,
  onGuestTap,
  hasResults,
  topInset,
  savedPlaces,
  onSelectSavedPlace,
  onSavePlace,
  onRemoveSavedPlace,
  onSavedPlaceToast,
  safetyLevel = 'extra',
  onSafetyLevelChange,
  onExpandedChange,
  onContainerLayout,
  onEffectiveBottomChange,
}: MobileWebSearchBarProps) {
  const [expanded, setExpanded] = useState(false);
  const expandAnim = useRef(new Animated.Value(0)).current;
  const originRef = useRef<TextInput>(null);
  const destRef = useRef<TextInput>(null);
  const prevHasResultsRef = useRef(hasResults);
  const lastCollapsedDestinationQueryRef = useRef<string | null>(null);
  const destinationFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const focusRequestIdRef = useRef(0);
  const collapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerMetricsRef = useRef<{
    y: number;
    height: number;
    bottom: number;
  } | null>(null);
  const savedPlacesPopupBottomRef = useRef<number | null>(null);
  const lastEffectiveBottomRef = useRef<number | null>(null);

  // Focus management
  const [focusedField, setFocusedField] = useState<
    "origin" | "destination" | null
  >(null);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFocused = useRef<"origin" | "destination" | null>(null);
  const suppressBlur = useRef(false);

  const cancelBlur = useCallback(() => {
    if (blurTimer.current) {
      clearTimeout(blurTimer.current);
      blurTimer.current = null;
    }
  }, []);

  const handleBlur = useCallback(() => {
    if (suppressBlur.current) {
      suppressBlur.current = false;
      return;
    }
    // Longer delay on Android — focus/blur fires unreliably above WebView
    const delay = Platform.OS === "android" ? 1000 : 200;
    blurTimer.current = setTimeout(() => setFocusedField(null), delay);
  }, []);

  useEffect(() => {
    if (focusedField) lastFocused.current = focusedField;
  }, [focusedField]);

  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);

  const emitEffectiveBottom = useCallback(
    (metrics: { y: number; height: number; bottom: number }) => {
      const popupBottom = savedPlacesPopupBottomRef.current;
      const effectiveBottom =
        popupBottom == null ? metrics.bottom : Math.max(metrics.bottom, metrics.y + popupBottom);

      if (lastEffectiveBottomRef.current === effectiveBottom) return;
      lastEffectiveBottomRef.current = effectiveBottom;
      onEffectiveBottomChange?.(effectiveBottom);
    },
    [onEffectiveBottomChange],
  );

  const handleSavedPlacesPopupBottomChange = useCallback(
    (bottomY: number | null) => {
      savedPlacesPopupBottomRef.current = bottomY;
      const metrics = containerMetricsRef.current;
      if (!metrics) return;
      emitEffectiveBottom(metrics);
    },
    [emitEffectiveBottom],
  );

  const reportContainerLayout = useCallback(
    (metrics: { y: number; height: number; bottom: number }) => {
      containerMetricsRef.current = metrics;
      onContainerLayout?.(metrics);
      emitEffectiveBottom(metrics);
    },
    [emitEffectiveBottom, onContainerLayout],
  );

  const handleContainerLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      reportContainerLayout({ y, height, bottom: y + height });
    },
    [reportContainerLayout],
  );

  useEffect(() => {
    const metrics = containerMetricsRef.current;
    if (!metrics) return;
    onContainerLayout?.(metrics);
    emitEffectiveBottom(metrics);
  }, [expanded, emitEffectiveBottom, onContainerLayout]);

  useEffect(() => {
    if (expanded) return;
    savedPlacesPopupBottomRef.current = null;
    const metrics = containerMetricsRef.current;
    if (!metrics) return;
    emitEffectiveBottom(metrics);
  }, [emitEffectiveBottom, expanded]);

  useEffect(() => {
    return () => {
      onExpandedChange?.(false);
    };
  }, [onExpandedChange]);

  const clearDestinationFocusTimer = useCallback(() => {
    focusRequestIdRef.current += 1;
    if (destinationFocusTimerRef.current) {
      clearTimeout(destinationFocusTimerRef.current);
      destinationFocusTimerRef.current = null;
    }
  }, []);

  const scheduleFieldFocus = useCallback(
    (field: "origin" | "destination", delayMs: number) => {
      clearDestinationFocusTimer();
      const requestId = focusRequestIdRef.current;
      destinationFocusTimerRef.current = setTimeout(() => {
        destinationFocusTimerRef.current = null;
        InteractionManager.runAfterInteractions(() => {
          if (requestId !== focusRequestIdRef.current) return;
          if (field === "origin") {
            originRef.current?.focus();
            if (Platform.OS === "android") {
              requestAnimationFrame(() => {
                if (requestId !== focusRequestIdRef.current) return;
                originRef.current?.focus();
              });
            }
            return;
          }
          destRef.current?.focus();
          if (Platform.OS === "android") {
            requestAnimationFrame(() => {
              if (requestId !== focusRequestIdRef.current) return;
              destRef.current?.focus();
            });
          }
        });
      }, delayMs);
    },
    [clearDestinationFocusTimer],
  );

  const focusField = useCallback(
    (field: "origin" | "destination") => {
      cancelBlur();
      setFocusedField(field);
      focusRequestIdRef.current += 1;
      if (Platform.OS === "android") {
        setPinMode(null);
        if (field === "origin") {
          originRef.current?.focus();
        } else {
          destRef.current?.focus();
        }
        // Keep a short fallback for Android/WebView timing races.
        scheduleFieldFocus(field, 25);
      } else {
        scheduleFieldFocus(field, 55);
      }
    },
    [cancelBlur, scheduleFieldFocus, setPinMode],
  );

  const clearCollapseTimer = useCallback(() => {
    if (collapseTimerRef.current) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  }, []);

  // Expand/collapse animation
  const expand = useCallback(() => {
    clearCollapseTimer();
    clearDestinationFocusTimer();
    setExpanded(true);
    expandAnim.stopAnimation();
    Animated.timing(expandAnim, {
      toValue: 1,
      useNativeDriver: false,
      duration: 260,
      easing: Easing.out(Easing.cubic),
    }).start(() => {
      // Auto-focus destination after expand; cancellable by any user interaction.
      scheduleFieldFocus("destination", 90);
    });
  }, [
    expandAnim,
    clearCollapseTimer,
    clearDestinationFocusTimer,
    scheduleFieldFocus,
  ]);

  const collapse = useCallback(() => {
    clearCollapseTimer();
    clearDestinationFocusTimer();
    originRef.current?.blur();
    destRef.current?.blur();
    setFocusedField(null);
    expandAnim.stopAnimation();
    Animated.timing(expandAnim, {
      toValue: 0,
      useNativeDriver: false,
      duration: 220,
      easing: Easing.inOut(Easing.cubic),
    }).start(() => setExpanded(false));
  }, [expandAnim, clearCollapseTimer, clearDestinationFocusTimer]);

  const scheduleCollapse = useCallback(
    (delayMs: number) => {
      clearCollapseTimer();
      collapseTimerRef.current = setTimeout(() => {
        collapseTimerRef.current = null;
        collapse();
      }, delayMs);
    },
    [clearCollapseTimer, collapse],
  );

  const normalizedDestinationQuery = destSearch.query.trim().toLowerCase();
  const hasDestinationSearchResults =
    !manualDest &&
    !destSearch.place &&
    (destinationCandidates.length > 0 || destSearch.predictions.length > 0);

  // Android: collapse once per destination query when place results are shown.
  // This keeps repeated searches reliable even when generic hasResults stays true.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    if (!expanded) return;
    if (!normalizedDestinationQuery) {
      lastCollapsedDestinationQueryRef.current = null;
      return;
    }
    if (!hasDestinationSearchResults) return;
    if (lastCollapsedDestinationQueryRef.current === normalizedDestinationQuery) {
      return;
    }

    scheduleCollapse(220);
    const t = setTimeout(() => {
      lastCollapsedDestinationQueryRef.current = normalizedDestinationQuery;
    }, 220);

    return () => clearTimeout(t);
  }, [
    expanded,
    normalizedDestinationQuery,
    hasDestinationSearchResults,
    scheduleCollapse,
  ]);

  // Auto-collapse when results appear
  useEffect(() => {
    const gainedResults = !prevHasResultsRef.current && hasResults;
    prevHasResultsRef.current = hasResults;

    const isTyping =
      !!originRef.current?.isFocused?.() || !!destRef.current?.isFocused?.();
    const hasSelectedDestination = !!manualDest || !!destSearch.place;
    const shouldCollapse =
      gainedResults &&
      expanded &&
      (Platform.OS === "android" 
        ? !hasDestinationSearchResults 
        : !isTyping || hasSelectedDestination);
    if (shouldCollapse) {
      // On Android, delay collapse by 2s to match routes-found behaviour
      if (Platform.OS === "android") {
        scheduleCollapse(2000);
        return;
      }
      collapse();
    }
  }, [
    hasResults,
    expanded,
    collapse,
    hasDestinationSearchResults,
    scheduleCollapse,
    manualDest,
    destSearch.place,
  ]);

  useEffect(
    () => () => {
      clearDestinationFocusTimer();
      clearCollapseTimer();
    },
    [clearDestinationFocusTimer, clearCollapseTimer],
  );

  // When user taps the collapsed pill
  const handlePillPress = useCallback(() => {
    if (onGuestTap) {
      onGuestTap();
      return;
    }
    expand();
  }, [onGuestTap, expand]);

  // Prediction logic
  // On Android, focus/blur events are unreliable above a WebView, so
  // fall back to checking which field has active predictions.
  const activeField: "origin" | "destination" | null =
    focusedField ?? lastFocused.current ?? null;

  const activePredictions =
    Platform.OS === "android"
      ? activeField === "origin" && !manualOrigin && !originSearch.place
        ? originSearch.predictions
        : activeField === "destination" && !manualDest && !destSearch.place
          ? destSearch.predictions
          : !manualDest &&
              !destSearch.place &&
              destSearch.predictions.length > 0
            ? destSearch.predictions
            : !manualOrigin &&
                !originSearch.place &&
                originSearch.predictions.length > 0
              ? originSearch.predictions
              : []
      : focusedField === "origin" && !manualOrigin && !originSearch.place
        ? originSearch.predictions
        : focusedField === "destination" && !manualDest && !destSearch.place
          ? destSearch.predictions
          : [];

  const handlePredictionSelect = useCallback(
    (pred: PlacePrediction) => {
      cancelBlur();
      suppressBlur.current = false;
      const field = focusedField ?? lastFocused.current;
      if (field === "origin") {
        originSearch.selectPrediction(pred);
        setManualOrigin(null);
        setIsUsingCurrentLocation(false);
        if (pred.location) onPanTo(pred.location);
      } else {
        destSearch.selectPrediction(pred);
        setManualDest(null);
        if (pred.location) onPanTo(pred.location);
      }
      onClearRoute();
      originRef.current?.blur();
      destRef.current?.blur();
      setFocusedField(null);
    },
    [
      focusedField,
      originSearch,
      destSearch,
      setManualOrigin,
      setManualDest,
      setIsUsingCurrentLocation,
      onPanTo,
      onClearRoute,
      cancelBlur,
    ],
  );

  const showDestinationCandidateCards =
    !renderCandidatesInSheet &&
    activeField !== "origin" &&
    !manualDest &&
    !destSearch.place &&
    destinationCandidates.length > 0;

  const showLegacyPredictions =
    !renderCandidatesInSheet &&
    activePredictions.length > 0 &&
    !showDestinationCandidateCards;

  const bubbleSource = showDestinationCandidateCards
    ? destinationCandidates
    : activePredictions;

  const categoryBubbles = useMemo(() => {
    if (!bubbleSource || bubbleSource.length === 0) return [];

    const counts = new Map<string, number>();
    for (const prediction of bubbleSource) {
      const category = classifyPredictionCategory(prediction);
      if (!category) continue;
      counts.set(category, (counts.get(category) || 0) + 1);
    }

    return CATEGORY_CHIP_DEFINITIONS
      .map((chip) => ({
        ...chip,
        count: counts.get(chip.key) || 0,
      }))
      .filter((chip) => chip.count > 0)
      .sort((a, b) => b.count - a.count);
  }, [bubbleSource]);

  const handleCategoryBubblePress = useCallback(
    (categoryQuery: string) => {
      setManualDest(null);
      destSearch.setQuery(categoryQuery);
      onClearRoute();
      setFocusedField("destination");
      requestAnimationFrame(() => destRef.current?.focus());
    },
    [destSearch, onClearRoute, setManualDest],
  );

  // Display text for collapsed pill
  const destDisplayText = manualDest
    ? (manualDest.name ?? "Dropped pin")
    : destSearch.place
      ? (destSearch.place.name ?? destSearch.query)
      : destSearch.query || null;

  // Interpolated heights for expand/collapse
  const containerHeight = expandAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [56, 160],
  });

  const dualOpacity = expandAnim.interpolate({
    inputRange: [0, 0.4, 1],
    outputRange: [0, 0, 1],
  });

  const pillOpacity = expandAnim.interpolate({
    inputRange: [0, 0.3],
    outputRange: [1, 0],
  });

  return (
    <View
      style={[styles.wrapper, topInset != null && { top: topInset + 8 }]}
      onLayout={handleContainerLayout}
    >
      <Animated.View style={[styles.container, { height: containerHeight }]}>
        {/* ── Collapsed single pill ── */}
        <Animated.View
          style={[styles.pill, { opacity: pillOpacity }]}
          pointerEvents={expanded ? "none" : "auto"}
        >
            <Pressable
              style={styles.pillInner}
              onPress={handlePillPress}
              accessibilityRole="button"
              accessibilityLabel="Search for a destination"
            >
              <Ionicons name="search" size={18} color="#667085" />
              <Text
                style={[
                  styles.pillText,
                  destDisplayText ? styles.pillTextActive : null,
                ]}
                numberOfLines={1}
              >
                {destDisplayText || "Where to?"}
              </Text>
              {destDisplayText && (
                <Pressable
                  onPress={(e) => {
                    e.stopPropagation();
                    destSearch.clear();
                    setManualDest(null);
                    onClearRoute();
                  }}
                  style={styles.pillClear}
                  hitSlop={8}
                >
                  <Ionicons name="close-circle" size={16} color="#98a2b3" />
                </Pressable>
              )}
            </Pressable>
          </Animated.View>

        {/* ── Expanded dual inputs ── */}
        <Animated.View
          style={[styles.expandedCard, { opacity: dualOpacity }]}
          pointerEvents={expanded ? "auto" : "none"}
        >
            {/* Back / collapse button */}
            <View style={styles.expandedHeader}>
              <Pressable
                onPress={collapse}
                style={styles.backButton}
                hitSlop={8}
              >
                <Ionicons name="arrow-back" size={22} color="#374151" />
              </Pressable>
              <Text style={styles.expandedTitle}>Plan your route</Text>
              <Pressable
                onPress={() => {
                  onSwap();
                  onClearRoute();
                }}
                style={styles.swapBtn}
                hitSlop={8}
                accessibilityLabel="Swap origin and destination"
              >
                <Ionicons name="swap-vertical" size={18} color="#667085" />
              </Pressable>
              {onSafetyLevelChange && (
                <View style={styles.magicSlot}>
                  <SafetyLevelToggle value={safetyLevel} onChange={onSafetyLevelChange} />
                </View>
              )}
            </View>

            {/* Origin */}
            <View style={styles.inputRow}>
              <View style={[styles.dot, { backgroundColor: "#1570ef" }]} />
              {isUsingCurrentLocation ? (
                <Pressable
                  style={[
                    styles.inputField,
                    focusedField === "origin" && styles.inputFieldFocused,
                  ]}
                  hitSlop={4}
                  onPress={(e) => {
                    e.stopPropagation();
                    if (onGuestTap) {
                      onGuestTap();
                      return;
                    }
                    setIsUsingCurrentLocation(false);
                    requestAnimationFrame(() => focusField("origin"));
                  }}
                >
                  <Ionicons
                    name={location ? "navigate" : "hourglass-outline"}
                    size={14}
                    color="#1570ef"
                  />
                  <Text style={styles.locationText}>
                    {location ? "Your location" : "Getting location..."}
                  </Text>
                  <Pressable
                    style={[
                      styles.pinButton,
                      pinMode === "origin" && styles.pinButtonActive,
                    ]}
                    onPress={() =>
                      setPinMode(pinMode === "origin" ? null : "origin")
                    }
                    hitSlop={4}
                    accessibilityLabel="Pick origin on map"
                  >
                    <Ionicons
                      name={pinMode === "origin" ? "pin" : "pin-outline"}
                      size={14}
                      color="#ffffff"
                    />
                  </Pressable>
                </Pressable>
              ) : (
                <Pressable
                  style={[
                    styles.inputField,
                    focusedField === "origin" && styles.inputFieldFocused,
                  ]}
                  onPress={() => {
                    if (onGuestTap) {
                      onGuestTap();
                      return;
                    }
                    focusField("origin");
                  }}
                >
                  <TextInput
                    ref={originRef}
                    value={
                      manualOrigin
                        ? (manualOrigin.name ?? "Dropped pin")
                        : originSearch.query
                    }
                    onChangeText={(t) => {
                      if (onGuestTap) return;
                      setManualOrigin(null);
                      originSearch.setQuery(t);
                      onClearRoute();
                    }}
                    placeholder="Starting point"
                    placeholderTextColor="#98a2b3"
                    style={styles.textInput}
                    onFocus={() => {
                      if (onGuestTap) {
                        originRef.current?.blur();
                        onGuestTap();
                        return;
                      }
                      if (Platform.OS !== "android") {
                        clearDestinationFocusTimer();
                      }
                      cancelBlur();
                      if (Platform.OS === "android") {
                        setPinMode(null);
                      }
                      setFocusedField("origin");
                    }}
                    onBlur={handleBlur}
                  />
                  {originSearch.status === "searching" && (
                    <ActivityIndicator size="small" color="#1570ef" />
                  )}
                  {(originSearch.status === "found" || manualOrigin) && (
                    <Ionicons
                      name="checkmark-circle"
                      size={14}
                      color="#22c55e"
                    />
                  )}
                  <Pressable
                    style={[
                      styles.pinButton,
                      pinMode === "origin" && styles.pinButtonActive,
                    ]}
                    onPress={(e) => {
                      e.stopPropagation();
                      setPinMode(pinMode === "origin" ? null : "origin");
                    }}
                    hitSlop={4}
                    accessibilityLabel="Pick origin on map"
                  >
                    <Ionicons
                      name={pinMode === "origin" ? "pin" : "pin-outline"}
                      size={14}
                      color="#ffffff"
                    />
                  </Pressable>
                  {!isUsingCurrentLocation && (
                    <Pressable
                      onPress={(e) => {
                        e.stopPropagation();
                        setIsUsingCurrentLocation(true);
                        setManualOrigin(null);
                        originSearch.clear();
                        if (location) onPanTo(location);
                      }}
                      hitSlop={6}
                    >
                      <Ionicons
                        name="locate-outline"
                        size={14}
                        color="#98a2b3"
                      />
                    </Pressable>
                  )}
                </Pressable>
              )}
            </View>

            {/* Destination */}
            <View style={styles.inputRow}>
              <View style={[styles.dot, { backgroundColor: "#d92d20" }]} />
              <Pressable
                style={[
                  styles.inputField,
                  focusedField === "destination" && styles.inputFieldFocused,
                ]}
                hitSlop={4}
                onPress={() => {
                  if (onGuestTap) {
                    onGuestTap();
                    return;
                  }
                  focusField("destination");
                }}
              >
                <TextInput
                  ref={destRef}
                  value={
                    manualDest
                      ? (manualDest.name ?? "Dropped pin")
                      : destSearch.query
                  }
                  onChangeText={(t) => {
                    if (onGuestTap) return;
                    setManualDest(null);
                    destSearch.setQuery(t);
                    onClearRoute();
                  }}
                  placeholder="Where to?"
                  placeholderTextColor="#98a2b3"
                  style={styles.textInput}
                  onFocus={() => {
                    if (onGuestTap) {
                      destRef.current?.blur();
                      onGuestTap();
                      return;
                    }
                    if (Platform.OS !== "android") {
                      clearDestinationFocusTimer();
                    }
                    cancelBlur();
                    if (Platform.OS === "android") {
                      setPinMode(null);
                    }
                    setFocusedField("destination");
                  }}
                  onBlur={handleBlur}
                />
                {destSearch.status === "searching" && (
                  <ActivityIndicator size="small" color="#1570ef" />
                )}
                {(destSearch.status === "found" || manualDest) && (
                  <Ionicons name="checkmark-circle" size={14} color="#22c55e" />
                )}
                <Pressable
                  style={[
                    styles.pinButton,
                    pinMode === "destination" && styles.pinButtonActive,
                  ]}
                  onPress={(e) => {
                    e.stopPropagation();
                    setPinMode(
                      pinMode === "destination" ? null : "destination",
                    );
                  }}
                  hitSlop={4}
                  accessibilityLabel="Pick destination on map"
                >
                  <Ionicons
                    name={pinMode === "destination" ? "pin" : "pin-outline"}
                    size={14}
                    color="#ffffff"
                  />
                </Pressable>
                {(destSearch.place || manualDest) && (
                  <Pressable
                    onPress={(e) => {
                      e.stopPropagation();
                      destSearch.clear();
                      setManualDest(null);
                      onClearRoute();
                    }}
                    hitSlop={6}
                  >
                    <Ionicons
                      name="close-circle-outline"
                      size={14}
                      color="#98a2b3"
                    />
                  </Pressable>
                )}
              </Pressable>
            </View>

            {/* ── Saved places (inside card, below inputs, only when no predictions) ── */}
            {activePredictions.length === 0 &&
              savedPlaces &&
              onSelectSavedPlace &&
              onSavePlace &&
              onRemoveSavedPlace && (
                <SavedPlaces
                  places={savedPlaces}
                  onSelect={onSelectSavedPlace}
                  onSave={onSavePlace}
                  onRemove={onRemoveSavedPlace}
                  onToast={onSavedPlaceToast}
                  onPopupBottomChange={handleSavedPlacesPopupBottomChange}
                  currentDestination={
                    manualDest
                      ? {
                          name: manualDest.name ?? "Dropped pin",
                          lat: manualDest.location.latitude,
                          lng: manualDest.location.longitude,
                        }
                      : destSearch.place
                        ? {
                            name: destSearch.place.name ?? destSearch.query,
                            lat: destSearch.place.location.latitude,
                            lng: destSearch.place.location.longitude,
                          }
                        : null
                  }
                  visible
                />
              )}
          </Animated.View>
      </Animated.View>

      {/* ── Predictions dropdown (only in expanded mode) ── */}
      {expanded && showLegacyPredictions && (
        <View style={styles.predictions}>
          {categoryBubbles.length > 0 && (
            <View>
              <Text style={styles.categoryHelpText}>
                Quick filters: tap a category to update results instantly.
              </Text>
              <ScrollView
                horizontal
                style={styles.categoryBubblesWrap}
                contentContainerStyle={styles.categoryBubblesContent}
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="always"
              >
                {categoryBubbles.map((chip, _idx, arr) => {
                  const iconOnly = arr.length > 3;
                  return (
                    <Pressable
                      key={`legacy-chip-${chip.key}`}
                      style={[
                        styles.categoryBubble,
                        iconOnly ? styles.categoryBubbleIconOnly : null,
                      ]}
                      onPress={() => handleCategoryBubblePress(chip.query)}
                    >
                      <Ionicons name={chip.icon} size={14} color="#1570ef" />
                      {!iconOnly ? (
                        <Text style={styles.categoryBubbleText}>{chip.label}</Text>
                      ) : null}
                      <Text style={styles.categoryBubbleCount}>{chip.count}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          )}
          <ScrollView keyboardShouldPersistTaps="always" bounces={false}>
            {activePredictions.map((pred, idx) => (
              <Pressable
                key={pred.placeId}
                style={({ pressed }) => [
                  styles.predItem,
                  idx === activePredictions.length - 1 && styles.predItemLast,
                  pressed && styles.predItemPressed,
                ]}
                onPressIn={() => {
                  suppressBlur.current = true;
                  cancelBlur();
                }}
                onPress={() => handlePredictionSelect(pred)}
              >
                <View style={styles.predIcon}>
                  <Ionicons name="location-outline" size={16} color="#667085" />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.predPrimary} numberOfLines={1}>
                    {pred.primaryText}
                  </Text>
                  {pred.secondaryText ? (
                    <Text style={styles.predSecondary} numberOfLines={1}>
                      {pred.secondaryText}
                    </Text>
                  ) : null}
                </View>
                {idx === 0 && (
                  <View style={styles.predBadge}>
                    <Text style={styles.predBadgeText}>Suggested</Text>
                  </View>
                )}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {expanded &&
        showDestinationCandidateCards &&
        onSelectDestinationCandidate && (
          <View style={styles.predictions}>
            <View style={styles.candidatesHeader}>
              <Text style={styles.candidatesTitle}>Related places</Text>
            </View>
            {categoryBubbles.length > 0 && (
              <View>
                <Text style={styles.categoryHelpText}>
                  Quick filters: tap a category to update results instantly.
                </Text>
                <ScrollView
                  horizontal
                  style={styles.categoryBubblesWrap}
                  contentContainerStyle={styles.categoryBubblesContent}
                  showsHorizontalScrollIndicator={false}
                  keyboardShouldPersistTaps="always"
                >
                  {categoryBubbles.map((chip, _idx, arr) => {
                    const iconOnly = arr.length > 3;
                    return (
                      <Pressable
                        key={`candidate-chip-${chip.key}`}
                        style={[
                          styles.categoryBubble,
                          iconOnly ? styles.categoryBubbleIconOnly : null,
                        ]}
                        onPress={() => handleCategoryBubblePress(chip.query)}
                      >
                        <Ionicons name={chip.icon} size={14} color="#1570ef" />
                        {!iconOnly ? (
                          <Text style={styles.categoryBubbleText}>{chip.label}</Text>
                        ) : null}
                        <Text style={styles.categoryBubbleCount}>{chip.count}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            )}
            <ScrollView keyboardShouldPersistTaps="always" bounces={false}>
              {destinationCandidates.map((pred, idx) => {
                const selected = pred.placeId === selectedDestinationCandidateId;
                return (
                  <Pressable
                    key={`candidate-${pred.placeId}`}
                    style={({ pressed }) => [
                      styles.predItem,
                      idx === destinationCandidates.length - 1 && styles.predItemLast,
                      selected && styles.candidateItemSelected,
                      pressed && styles.predItemPressed,
                    ]}
                    onPress={() => onSelectDestinationCandidate(pred.placeId, true)}
                  >
                    <View style={styles.predIcon}>
                      <Ionicons
                        name={selected ? "radio-button-on" : "radio-button-off"}
                        size={16}
                        color={selected ? "#1570ef" : "#667085"}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.predPrimary} numberOfLines={1}>
                        {pred.primaryText}
                      </Text>
                      {pred.secondaryText ? (
                        <Text style={styles.predSecondary} numberOfLines={1}>
                          {pred.secondaryText}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        )}
    </View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  wrapper: {
    position: "absolute",
    top: Platform.OS === "android" ? 12 : 32,
    left: 0,
    right: 0,
    zIndex: Platform.OS === 'web' ? 1600 : 260,
    ...(Platform.OS === "android" ? { elevation: 260 } : {}),
    alignItems: "center",
    paddingHorizontal: 12,
  },
  container: {
    width: "100%",
    maxWidth: 480,
    overflow: "visible",
  },

  // ── Collapsed pill ──
  pill: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
  pillInner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 28,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
    ...(Platform.OS === "web"
      ? { boxShadow: "0 2px 12px rgba(0,0,0,0.12)" }
      : {
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.12,
          shadowRadius: 12,
          elevation: 8,
        }),
  } as any,
  pillText: {
    flex: 1,
    fontSize: 15,
    color: "#98a2b3",
    fontWeight: "400",
  },
  pillTextActive: {
    color: "#101828",
    fontWeight: "500",
  },
  pillClear: {
    padding: 2,
  },

  // ── Expanded card ──
  expandedCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 12,
    ...(Platform.OS === "web"
      ? { boxShadow: "0 4px 20px rgba(0,0,0,0.15)" }
      : {
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.15,
          shadowRadius: 20,
          elevation: 10,
        }),
    gap: 8,
  } as any,
  expandedHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  backButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#f3f4f6",
    alignItems: "center",
    justifyContent: "center",
  },
  expandedTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: "600",
    color: "#374151",
  },
  swapBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#f3f4f6",
    alignItems: "center",
    justifyContent: "center",
  },
  magicSlot: {
    marginLeft: 8,
  },

  // ── Input rows ──
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  inputField: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f9fafb",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
  },
  inputFieldFocused: {
    borderColor: "#1570ef",
    backgroundColor: "#ffffff",
    ...(Platform.OS === "web"
      ? { boxShadow: "0 0 0 2px rgba(21, 112, 239, 0.15)" }
      : {
          shadowColor: "#1570ef",
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: 0.15,
          shadowRadius: 8,
        }),
  } as any,
  textInput: {
    flex: 1,
    fontSize: 14,
    color: "#101828",
    borderWidth: 0,
    ...(Platform.OS === "web" ? { outlineStyle: "none" } : {}),
  } as any,
  locationText: {
    fontSize: 14,
    color: "#1570ef",
    fontWeight: "500",
    flex: 1,
  },
  pinButton: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "#1F2937",
    alignItems: "center",
    justifyContent: "center",
  },
  pinButtonActive: {
    backgroundColor: "#1570ef",
  },

  // ── Predictions ──
  predictions: {
    marginTop: 6,
    width: "100%",
    maxWidth: 480,
    backgroundColor: "#ffffff",
    borderRadius: 12,
    ...(Platform.OS === "web"
      ? { boxShadow: "0 6px 20px rgba(0,0,0,0.12)" }
      : {
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.12,
          shadowRadius: 20,
          elevation: 12,
        }),
    overflow: Platform.OS === "web" ? ("hidden" as any) : ("visible" as any),
    maxHeight: 280,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  } as any,
  candidatesHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  categoryBubblesWrap: {
    maxHeight: 46,
    borderBottomWidth: 1,
    borderBottomColor: "#f2f4f7",
  },
  categoryBubblesContent: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
    alignItems: "center",
  },
  categoryHelpText: {
    fontSize: 11,
    color: "#475467",
    fontWeight: "500",
    paddingHorizontal: 10,
    paddingTop: 8,
  },
  categoryBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#bfdbfe",
    backgroundColor: "#eff6ff",
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 0,
  },
  categoryBubbleIconOnly: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    gap: 4,
    borderRadius: 8,
  },
  categoryBubbleText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#1d4ed8",
    flexShrink: 1,
  },
  categoryBubbleCount: {
    fontSize: 11,
    fontWeight: "700",
    color: "#1570ef",
    backgroundColor: "#dbeafe",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  candidatesTitle: {
    fontSize: 11,
    fontWeight: "700",
    color: "#344054",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  candidateItemSelected: {
    backgroundColor: "#eff8ff",
  },
  predItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f2f4f7",
    gap: 10,
  },
  predItemLast: {
    borderBottomWidth: 0,
  },
  predItemPressed: {
    backgroundColor: "#f0f6ff",
  },
  predIcon: {
    width: 28,
    height: 28,
    borderRadius: 7,
    backgroundColor: "#f2f4f7",
    alignItems: "center",
    justifyContent: "center",
  },
  predPrimary: {
    fontSize: 14,
    fontWeight: "500",
    color: "#101828",
  },
  predSecondary: {
    fontSize: 12,
    color: "#667085",
    marginTop: 1,
  },
  predBadge: {
    backgroundColor: "#ecfdf3",
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  predBadgeText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#027a48",
  },
});