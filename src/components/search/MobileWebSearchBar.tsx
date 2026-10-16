/**
 * MobileWebSearchBar — Google Maps-style collapsible search.
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
import { useCallback, useEffect, useRef, useState } from "react";
import {
    ActivityIndicator,
    Animated,
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
import type { LatLng, PlaceDetails, PlacePrediction } from "@/src/types/google";
import { SavedPlaces } from "./SavedPlaces";

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
  onGuestTap,
  hasResults,
  topInset,
  savedPlaces,
  onSelectSavedPlace,
  onSavePlace,
  onRemoveSavedPlace,
  onSavedPlaceToast,
}: MobileWebSearchBarProps) {
  const [expanded, setExpanded] = useState(false);
  const expandAnim = useRef(new Animated.Value(0)).current;
  const originRef = useRef<TextInput>(null);
  const destRef = useRef<TextInput>(null);
  const prevHasResultsRef = useRef(hasResults);

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

  const focusField = useCallback(
    (field: "origin" | "destination") => {
      cancelBlur();
      setFocusedField(field);
      if (field === "origin") {
        requestAnimationFrame(() => originRef.current?.focus());
        return;
      }
      requestAnimationFrame(() => destRef.current?.focus());
    },
    [cancelBlur],
  );

  // Expand/collapse animation
  const expand = useCallback(() => {
    setExpanded(true);
    Animated.spring(expandAnim, {
      toValue: 1,
      useNativeDriver: false,
      bounciness: 4,
      speed: 14,
    }).start(() => {
      // Auto-focus destination input after expand
      setTimeout(() => destRef.current?.focus(), 100);
    });
  }, [expandAnim]);

  const collapse = useCallback(() => {
    originRef.current?.blur();
    destRef.current?.blur();
    setFocusedField(null);
    Animated.spring(expandAnim, {
      toValue: 0,
      useNativeDriver: false,
      bounciness: 4,
      speed: 14,
    }).start(() => setExpanded(false));
  }, [expandAnim]);

  // Auto-collapse when results appear
  useEffect(() => {
    const gainedResults = !prevHasResultsRef.current && hasResults;
    prevHasResultsRef.current = hasResults;

    const isTyping =
      !!originRef.current?.isFocused?.() || !!destRef.current?.isFocused?.();
    if (gainedResults && expanded && !isTyping) {
      collapse();
    }
  }, [hasResults, expanded, collapse]);

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
    <View style={[styles.wrapper, topInset != null && { top: topInset + 8 }]}>
      <Animated.View style={[styles.container, { height: containerHeight }]}>
        {/* ── Collapsed single pill ── */}
        {!expanded && (
          <Animated.View style={[styles.pill, { opacity: pillOpacity }]}>
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
        )}

        {/* ── Expanded dual inputs ── */}
        {expanded && (
          <Animated.View
            style={[styles.expandedCard, { opacity: dualOpacity }]}
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
                  onPress={() => {
                    if (onGuestTap) {
                      onGuestTap();
                      return;
                    }
                    setIsUsingCurrentLocation(false);
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
                      cancelBlur();
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
                    cancelBlur();
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
        )}
      </Animated.View>

      {/* ── Predictions dropdown (only in expanded mode) ── */}
      {expanded && activePredictions.length > 0 && (
        <View style={styles.predictions}>
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
    zIndex: 50,
    ...(Platform.OS === "android" ? { elevation: 50 } : {}),
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
