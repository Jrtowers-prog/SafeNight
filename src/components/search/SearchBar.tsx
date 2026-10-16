/**
 * SearchBar — Origin + Destination inputs with prediction dropdown.
 *
 * Extracted from index.tsx for cleaner separation. Uses a flat absolute
 * positioning approach that works reliably on Android (avoids z-index
 * battles with the WebView-based map).
 */
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useRef } from "react";
import {
    ActivityIndicator,
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

export interface SearchBarProps {
  /** Safe-area top inset */
  topInset: number;
  /** Live GPS location (null while loading) */
  location: LatLng | null;
  /** Whether we're using GPS as origin */
  isUsingCurrentLocation: boolean;
  setIsUsingCurrentLocation: (v: boolean) => void;
  /** Origin search hook state */
  originSearch: UseAutoPlaceSearchReturn;
  /** Manual origin (dropped pin) */
  manualOrigin: PlaceDetails | null;
  setManualOrigin: (v: PlaceDetails | null) => void;
  /** Destination search hook state */
  destSearch: UseAutoPlaceSearchReturn;
  /** Manual destination (dropped pin) */
  manualDest: PlaceDetails | null;
  setManualDest: (v: PlaceDetails | null) => void;
  /** Pin-drop mode */
  pinMode: "origin" | "destination" | "via" | null;
  setPinMode: (v: "origin" | "destination" | "via" | null) => void;
  /** Trigger map pan */
  onPanTo: (location: LatLng) => void;
  /** Clear selected route */
  onClearRoute: () => void;
  /** Swap origin and destination */
  onSwap: () => void;
  /** If provided, tapping any input fires this instead of allowing typing (web guest mode) */
  onGuestTap?: () => void;
  /** When true, renders inline (no absolute positioning) — used inside WebSidebar */
  embedded?: boolean;
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

export function SearchBar({
  topInset,
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
  embedded,
  savedPlaces,
  onSelectSavedPlace,
  onSavePlace,
  onRemoveSavedPlace,
  onSavedPlaceToast,
}: SearchBarProps) {
  const originInputRef = useRef<TextInput>(null);
  const destInputRef = useRef<TextInput>(null);

  // Focus / blur management
  const [focusedField, setFocusedFieldState] = React.useState<
    "origin" | "destination" | null
  >(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFocusedFieldRef = useRef<"origin" | "destination" | null>(null);
  const suppressBlurRef = useRef(false);

  const handleBlur = useCallback(() => {
    if (suppressBlurRef.current) {
      suppressBlurRef.current = false;
      return;
    }
    // Longer delay on Android — focus/blur fires unreliably above WebView
    const delay = Platform.OS === "android" ? 1000 : 200;
    blurTimerRef.current = setTimeout(() => setFocusedFieldState(null), delay);
  }, []);

  const cancelBlurTimer = useCallback(() => {
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current);
      blurTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (focusedField) lastFocusedFieldRef.current = focusedField;
  }, [focusedField]);

  // On Android, focus/blur events are unreliable above a WebView, so
  // fall back to checking which field has active predictions when
  // focusedField is null.
  const activeField: "origin" | "destination" | null =
    focusedField ?? lastFocusedFieldRef.current ?? null;

  const activePredictions =
    Platform.OS === "android"
      ? // Android: use activeField (focus OR last-focused), then fall back
        // to whichever field actually has predictions available.
        activeField === "origin" && !manualOrigin && !originSearch.place
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
      : // Web / iOS: original strict focus-based logic
        focusedField === "origin" && !manualOrigin && !originSearch.place
        ? originSearch.predictions
        : focusedField === "destination" && !manualDest && !destSearch.place
          ? destSearch.predictions
          : [];

  const handlePredictionSelect = useCallback(
    (pred: PlacePrediction) => {
      cancelBlurTimer();
      suppressBlurRef.current = false;
      const field = focusedField ?? lastFocusedFieldRef.current;
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
      originInputRef.current?.blur();
      destInputRef.current?.blur();
      setFocusedFieldState(null);
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
      cancelBlurTimer,
    ],
  );

  return (
    <>
      <ScrollView
        style={[
          embedded ? styles.containerEmbedded : styles.container,
          !embedded && { top: topInset + 8, pointerEvents: "box-none" },
        ]}
        contentContainerStyle={
          embedded ? styles.contentEmbedded : styles.content
        }
        keyboardShouldPersistTaps="always"
        scrollEnabled={false}
      >
        <View style={[styles.card, embedded && styles.cardEmbedded]}>
          {/* Origin Input */}
          <View style={styles.inputRow}>
            <View style={styles.inputIconWrap}>
              <View style={styles.iconDot} />
            </View>
            <Pressable
              style={[
                styles.inputFieldWrap,
                focusedField === "origin" && styles.inputFieldWrapFocused,
              ]}
              onPress={() => {
                if (onGuestTap) {
                  onGuestTap();
                  return;
                }
                if (!isUsingCurrentLocation) originInputRef.current?.focus();
              }}
            >
              {isUsingCurrentLocation ? (
                <Pressable
                  style={[
                    styles.inputField,
                    { flexDirection: "row", alignItems: "center", gap: 6 },
                  ]}
                  onPress={() => {
                    if (onGuestTap) {
                      onGuestTap();
                      return;
                    }
                    setIsUsingCurrentLocation(false);
                  }}
                  accessibilityRole="button"
                >
                  <Ionicons
                    name={location ? "navigate" : "hourglass-outline"}
                    size={16}
                    color="#1570ef"
                  />
                  <Text style={styles.locationDisplayText}>
                    {location ? "Your location" : "Getting location..."}
                  </Text>
                </Pressable>
              ) : (
                <TextInput
                  ref={originInputRef}
                  value={
                    manualOrigin
                      ? (manualOrigin.name ?? "Dropped pin")
                      : originSearch.query
                  }
                  onChangeText={(t: string) => {
                    if (onGuestTap) return;
                    setManualOrigin(null);
                    originSearch.setQuery(t);
                    onClearRoute();
                  }}
                  placeholder="Starting point"
                  placeholderTextColor="#98a2b3"
                  accessibilityLabel="Starting point"
                  autoCorrect={false}
                  editable={!onGuestTap}
                  style={styles.inputField}
                  onFocus={() => {
                    if (onGuestTap) {
                      originInputRef.current?.blur();
                      onGuestTap();
                      return;
                    }
                    cancelBlurTimer();
                    setFocusedFieldState("origin");
                  }}
                  onBlur={handleBlur}
                />
              )}
              <View
                style={[styles.inputActions, { pointerEvents: "box-none" }]}
              >
                {originSearch.status === "searching" && (
                  <ActivityIndicator size="small" color="#1570ef" />
                )}
                {(originSearch.status === "found" || manualOrigin) && (
                  <Ionicons name="checkmark-circle" size={16} color="#22c55e" />
                )}
                <Pressable
                  style={[
                    styles.mapPinButton,
                    pinMode === "origin" && styles.mapPinButtonActive,
                  ]}
                  onPress={() =>
                    setPinMode(pinMode === "origin" ? null : "origin")
                  }
                  accessibilityRole="button"
                  accessibilityLabel="Pick on map"
                >
                  <Ionicons
                    name={pinMode === "origin" ? "pin" : "pin-outline"}
                    size={20}
                    color={pinMode === "origin" ? "#1570ef" : "#667085"}
                  />
                </Pressable>
                {!isUsingCurrentLocation && (
                  <Pressable
                    style={styles.mapPinButton}
                    onPress={() => {
                      setIsUsingCurrentLocation(true);
                      setManualOrigin(null);
                      originSearch.clear();
                      if (location) onPanTo(location);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Use current location"
                  >
                    <Ionicons name="locate-outline" size={16} color="#98a2b3" />
                  </Pressable>
                )}
              </View>
            </Pressable>
          </View>

          {/* Divider + Swap button */}
          <View style={styles.dividerRow}>
            <View style={styles.inputIconWrap}>
              <View style={styles.iconConnector} />
              <Pressable
                style={styles.swapButton}
                onPress={() => {
                  onSwap();
                  onClearRoute();
                }}
                accessibilityRole="button"
                accessibilityLabel="Swap origin and destination"
              >
                <Ionicons name="swap-vertical" size={14} color="#667085" />
              </Pressable>
              <View style={styles.iconConnector} />
            </View>
            <View style={styles.inputDivider} />
          </View>

          {/* Destination Input */}
          <View style={styles.inputRow}>
            <View style={styles.inputIconWrap}>
              <View style={styles.iconPin} />
            </View>
            <Pressable
              style={[
                styles.inputFieldWrap,
                focusedField === "destination" && styles.inputFieldWrapFocused,
              ]}
              onPress={() => {
                if (onGuestTap) {
                  onGuestTap();
                  return;
                }
                destInputRef.current?.focus();
              }}
            >
              <TextInput
                ref={destInputRef}
                value={
                  manualDest
                    ? (manualDest.name ?? "Dropped pin")
                    : destSearch.query
                }
                onChangeText={(text: string) => {
                  if (onGuestTap) return;
                  setManualDest(null);
                  destSearch.setQuery(text);
                  onClearRoute();
                }}
                placeholder="Where to?"
                placeholderTextColor="#98a2b3"
                accessibilityLabel="Destination"
                autoCorrect={false}
                editable={!onGuestTap}
                style={styles.inputField}
                onFocus={() => {
                  if (onGuestTap) {
                    destInputRef.current?.blur();
                    onGuestTap();
                    return;
                  }
                  cancelBlurTimer();
                  setFocusedFieldState("destination");
                }}
                onBlur={handleBlur}
              />
              <View
                style={[styles.inputActions, { pointerEvents: "box-none" }]}
              >
                {destSearch.status === "searching" && (
                  <ActivityIndicator size="small" color="#1570ef" />
                )}
                {(destSearch.status === "found" || manualDest) && (
                  <Ionicons name="checkmark-circle" size={16} color="#22c55e" />
                )}
                <Pressable
                  style={[
                    styles.mapPinButton,
                    pinMode === "destination" && styles.mapPinButtonActive,
                  ]}
                  onPress={() =>
                    setPinMode(pinMode === "destination" ? null : "destination")
                  }
                  accessibilityRole="button"
                  accessibilityLabel="Pick on map"
                >
                  <Ionicons
                    name={pinMode === "destination" ? "pin" : "pin-outline"}
                    size={20}
                    color={pinMode === "destination" ? "#d92d20" : "#667085"}
                  />
                </Pressable>
                {(destSearch.place || manualDest) && (
                  <Pressable
                    style={styles.mapPinButton}
                    onPress={() => {
                      destSearch.clear();
                      setManualDest(null);
                      onClearRoute();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Clear destination"
                  >
                    <Ionicons
                      name="close-circle-outline"
                      size={16}
                      color="#98a2b3"
                    />
                  </Pressable>
                )}
              </View>
            </Pressable>
          </View>
        </View>

        {/* Predictions Dropdown */}
        {activePredictions.length > 0 && (
          <View
            style={[
              styles.predictionsDropdown,
              embedded && { maxWidth: "100%" as any },
            ]}
          >
            {activePredictions.map((pred, idx) => (
              <Pressable
                key={pred.placeId}
                style={({ pressed }: { pressed: boolean }) => [
                  styles.predictionItem,
                  idx === 0 && styles.predictionItemFirst,
                  idx === activePredictions.length - 1 &&
                    styles.predictionItemLast,
                  pressed && styles.predictionItemPressed,
                ]}
                onPressIn={() => {
                  suppressBlurRef.current = true;
                  cancelBlurTimer();
                }}
                onPress={() => handlePredictionSelect(pred)}
              >
                <View style={styles.predictionIcon}>
                  <Ionicons name="location-outline" size={18} color="#667085" />
                </View>
                <View style={styles.predictionText}>
                  <Text style={styles.predictionPrimary} numberOfLines={1}>
                    {pred.primaryText}
                  </Text>
                  {pred.secondaryText ? (
                    <Text style={styles.predictionSecondary} numberOfLines={1}>
                      {pred.secondaryText}
                    </Text>
                  ) : null}
                </View>
                {idx === 0 && (
                  <View style={styles.predictionBadge}>
                    <Text style={styles.predictionBadgeText}>Suggested</Text>
                  </View>
                )}
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>

      {/* ── Saved places (when no predictions showing) ── */}
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
                    lat: manualDest.location!.latitude,
                    lng: manualDest.location!.longitude,
                  }
                : destSearch.place
                  ? {
                      name: destSearch.place.name ?? destSearch.query,
                      lat: destSearch.place!.location.latitude,
                      lng: destSearch.place!.location.longitude,
                    }
                  : null
            }
            visible
          />
        )}
    </>
  );
}

// We need React for the useState inside the component
import React from "react";

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 12,
    left: 0,
    right: 0,
    zIndex: 10,
    elevation: 10,
  },
  containerEmbedded: {
    // No absolute positioning — flows inline inside parent
  },
  content: {
    alignItems: "center",
    paddingHorizontal: 10,
  },
  contentEmbedded: {
    paddingHorizontal: 0,
  },
  card: {
    backgroundColor: "#ffffff",
    borderRadius: Platform.OS === "android" ? 16 : 14,
    ...(Platform.OS === "web"
      ? { boxShadow: "0 2px 12px rgba(0, 0, 0, 0.10)" }
      : {
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.15,
          shadowRadius: 20,
        }),
    elevation: Platform.OS === "android" ? 8 : 6,
    overflow: Platform.OS === "web" ? "hidden" : "visible",
    width: "100%",
    maxWidth: 600,
    paddingTop: Platform.OS === "android" ? 12 : Platform.OS === "web" ? 8 : 10,
    paddingBottom:
      Platform.OS === "android" ? 12 : Platform.OS === "web" ? 8 : 10,
  },
  cardEmbedded: {
    maxWidth: "100%" as any,
    borderRadius: 0,
    boxShadow: "none",
    elevation: 0,
    overflow: "visible",
  } as any,
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal:
      Platform.OS === "android" ? 10 : Platform.OS === "web" ? 10 : 8,
    paddingVertical:
      Platform.OS === "android" ? 4 : Platform.OS === "web" ? 0 : 2,
  },
  inputIconWrap: {
    width: 20,
    alignItems: "center",
  },
  iconDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#1570ef",
    borderWidth: 1.5,
    borderColor: "#93c5fd",
  },
  iconConnector: {
    width: 1.5,
    height: 6,
    backgroundColor: "#d0d5dd",
  },
  iconPin: {
    width: 10,
    height: 10,
    borderRadius: 2,
    backgroundColor: "#d92d20",
    borderWidth: 1.5,
    borderColor: "#fca5a5",
  },
  inputFieldWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    marginLeft: Platform.OS === "android" ? 10 : 8,
    backgroundColor: "#f9fafb",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    paddingHorizontal:
      Platform.OS === "android" ? 10 : Platform.OS === "web" ? 12 : 10,
    paddingVertical:
      Platform.OS === "android" ? 8 : Platform.OS === "web" ? 10 : 7,
  },
  inputFieldWrapFocused: {
    borderColor: "#1570ef",
    backgroundColor: "#ffffff",
    ...(Platform.OS === "web"
      ? { boxShadow: "0 0 0 2px rgba(21, 112, 239, 0.15)" }
      : Platform.OS === "android"
        ? {
            shadowColor: "#1570ef",
            shadowOffset: { width: 0, height: 0 },
            shadowOpacity: 0.15,
            shadowRadius: 8,
          }
        : {}),
  },
  inputField: {
    flex: 1,
    height: "100%",
    fontSize: Platform.OS === "web" ? 14 : 13,
    color: "#101828",
    fontWeight: "400",
    borderWidth: 0,
    ...(Platform.OS === "web" ? { outlineStyle: "none" } : {}),
  } as any,
  locationDisplayText: {
    fontSize: Platform.OS === "web" ? 14 : 13,
    color: "#1570ef",
    fontWeight: "500",
  },
  inputActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginLeft: 6,
  },
  mapPinButton: {
    padding: 5,
    borderRadius: 6,
    backgroundColor: "#f2f4f7",
  },
  mapPinButtonActive: {
    backgroundColor: "#e8f0fe",
  },
  inputDivider: {
    paddingHorizontal:
      Platform.OS === "android" ? 10 : Platform.OS === "web" ? 10 : 8,
    marginVertical:
      Platform.OS === "android" ? 4 : Platform.OS === "web" ? 0 : 2,
    height: 1,
    backgroundColor: "#f2f4f7",
    marginLeft: 8,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Platform.OS === "web" ? 10 : 8,
    marginVertical: Platform.OS === "web" ? 0 : 2,
  },
  swapButton: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#f2f4f7",
    alignItems: "center",
    justifyContent: "center",
  },
  predictionsDropdown: {
    marginTop: 8,
    backgroundColor: "#ffffff",
    borderRadius: 12,
    ...(Platform.OS === "web"
      ? { boxShadow: "0 6px 20px rgba(0, 0, 0, 0.12)" }
      : Platform.OS === "android"
        ? {
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 6 },
            shadowOpacity: 0.15,
            shadowRadius: 20,
          }
        : {
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 6 },
            shadowOpacity: 0.12,
            shadowRadius: 20,
          }),
    elevation: Platform.OS === "android" ? 12 : 12,
    zIndex: 20,
    overflow: Platform.OS === "web" ? "hidden" : "visible",
    width: "100%",
    maxWidth: 600,
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  predictionItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f2f4f7",
  },
  predictionItemFirst: {},
  predictionItemLast: {
    borderBottomWidth: 0,
  },
  predictionItemPressed: {
    backgroundColor: "#f0f6ff",
  },
  predictionIcon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: "#f2f4f7",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 10,
  },
  predictionText: {
    flex: 1,
  },
  predictionPrimary: {
    fontSize: 14,
    fontWeight: "500",
    color: "#101828",
  },
  predictionSecondary: {
    fontSize: 12,
    color: "#667085",
    marginTop: 1,
  },
  predictionBadge: {
    backgroundColor: "#ecfdf3",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginLeft: 8,
  },
  predictionBadgeText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#027a48",
  },
});
