
/**
 * SearchBar — Origin + Destination inputs with prediction dropdown.
 *
 * Extracted from index.tsx for cleaner separation. Uses a flat absolute
 * positioning approach that works reliably on Android (avoids z-index
 * battles with the WebView-based map).
 */
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
    ActivityIndicator,
  InteractionManager,
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

const CATEGORY_CHIP_DEFINITIONS: Array<{
  key: string;
  label: string;
  query: string;
  icon: keyof typeof Ionicons.glyphMap;
}> = [
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
  destinationCandidates?: PlacePrediction[];
  selectedDestinationCandidateId?: string | null;
  onSelectDestinationCandidate?: (placeId: string, panToCandidate?: boolean) => void;
  onFindSafeRoutes?: () => boolean;
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
  /** When true, suppresses prediction/candidate dropdown cards below inputs. */
  hidePredictionsDropdown?: boolean;
  /** Safety data level for route search (Extra = default) */
  safetyLevel?: SafetyLevel;
  onSafetyLevelChange?: (level: SafetyLevel) => void;
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
  destinationCandidates = [],
  selectedDestinationCandidateId = null,
  onSelectDestinationCandidate,
  onGuestTap,
  embedded,
  savedPlaces,
  onSelectSavedPlace,
  onSavePlace,
  onRemoveSavedPlace,
  onSavedPlaceToast,
  hidePredictionsDropdown = false,
  safetyLevel = 'extra',
  onSafetyLevelChange,
}: SearchBarProps) {
  const originInputRef = useRef<TextInput>(null);
  const destInputRef = useRef<TextInput>(null);

  // Focus / blur management
  const [focusedField, setFocusedFieldState] = React.useState<
    "origin" | "destination" | null
  >(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusRequestIdRef = useRef(0);
  const lastFocusedFieldRef = useRef<"origin" | "destination" | null>(null);
  const pendingOriginFocusRef = useRef(false);
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

  const cancelScheduledFocus = useCallback(() => {
    focusRequestIdRef.current += 1;
    if (focusTimerRef.current) {
      clearTimeout(focusTimerRef.current);
      focusTimerRef.current = null;
    }
  }, []);

  const scheduleFieldFocus = useCallback(
    (field: "origin" | "destination", delayMs: number = 70) => {
      cancelScheduledFocus();
      const requestId = focusRequestIdRef.current;
      focusTimerRef.current = setTimeout(() => {
        focusTimerRef.current = null;
        InteractionManager.runAfterInteractions(() => {
          if (focusRequestIdRef.current !== requestId) return;
          if (field === "origin") {
            originInputRef.current?.focus();
            if (Platform.OS === "android") {
              requestAnimationFrame(() => {
                if (focusRequestIdRef.current !== requestId) return;
                originInputRef.current?.focus();
              });
            }
            return;
          }
          destInputRef.current?.focus();
          if (Platform.OS === "android") {
            requestAnimationFrame(() => {
              if (focusRequestIdRef.current !== requestId) return;
              destInputRef.current?.focus();
            });
          }
        });
      }, delayMs);
    },
    [cancelScheduledFocus],
  );

  const focusFieldImmediately = useCallback(
    (field: "origin" | "destination") => {
      cancelBlurTimer();
      cancelScheduledFocus();
      setPinMode(null);
      setFocusedFieldState(field);

      if (field === "origin") {
        originInputRef.current?.focus();
        return;
      }
      destInputRef.current?.focus();
    },
    [cancelBlurTimer, cancelScheduledFocus, setPinMode],
  );

  // One handler for the whole origin field, so clicks on its padding work
  // the same as clicks on the text itself.
  const activateOrigin = useCallback(() => {
    if (onGuestTap) {
      onGuestTap();
      return;
    }
    if (isUsingCurrentLocation) {
      // The text input is not mounted yet; focus it once it appears.
      pendingOriginFocusRef.current = true;
      setIsUsingCurrentLocation(false);
      return;
    }
    // Focus directly. Going through InteractionManager here never ran on web
    // while the sidebar animates, so the field was never focused.
    cancelScheduledFocus();
    focusFieldImmediately("origin");
  }, [onGuestTap, isUsingCurrentLocation, cancelScheduledFocus, focusFieldImmediately]);

  useEffect(() => {
    if (!isUsingCurrentLocation && pendingOriginFocusRef.current) {
      pendingOriginFocusRef.current = false;
      focusFieldImmediately("origin");
    }
  }, [isUsingCurrentLocation, focusFieldImmediately]);

  useEffect(
    () => () => {
      cancelScheduledFocus();
    },
    [cancelScheduledFocus],
  );

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

  const showDestinationCandidateCards =
    activeField !== "origin" &&
    !manualDest &&
    !destSearch.place &&
    destinationCandidates.length > 0;

  const showLegacyPredictions =
    activePredictions.length > 0 && !showDestinationCandidateCards;

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
      // Category chips always target destination discovery.
      setManualDest(null);
      destSearch.setQuery(categoryQuery);
      onClearRoute();
      setFocusedFieldState("destination");
      scheduleFieldFocus("destination", 80);
    },
    [destSearch, onClearRoute, scheduleFieldFocus, setManualDest],
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
            <Pressable style={styles.inputIconWrap} onPress={activateOrigin}>
              <View style={styles.iconDot} />
            </Pressable>
            <Pressable
              style={[
                styles.inputFieldWrap,
                focusedField === "origin" && styles.inputFieldWrapFocused,
              ]}
              hitSlop={4}
              onPress={activateOrigin}
            >
              {isUsingCurrentLocation ? (
                <Pressable
                  style={[
                    styles.inputField,
                    { flexDirection: "row", alignItems: "center", gap: 6 },
                  ]}
                  onPress={activateOrigin}
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
                    if (Platform.OS !== "android") {
                      cancelScheduledFocus();
                    } else {
                      setPinMode(null);
                    }
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
                    onPress={(e) => {
                      e.stopPropagation();
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
            {onSafetyLevelChange && (
              <View style={styles.magicSlot}>
                <SafetyLevelToggle
                  value={safetyLevel}
                  onChange={onSafetyLevelChange}
                />
              </View>
            )}
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
              hitSlop={4}
              onPress={() => {
                if (onGuestTap) {
                  onGuestTap();
                  return;
                }
                cancelScheduledFocus();
                focusFieldImmediately("destination");
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
                  if (Platform.OS !== "android") {
                    cancelScheduledFocus();
                  } else {
                    setPinMode(null);
                  }
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
        {!hidePredictionsDropdown && showLegacyPredictions && (
          <View
            style={[
              styles.predictionsDropdown,
              embedded && { maxWidth: "100%" as any },
            ]}
          >
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
            <ScrollView
              style={styles.predictionsScroll}
              keyboardShouldPersistTaps="always"
              nestedScrollEnabled
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
            </ScrollView>
          </View>
        )}
      </ScrollView>

      {/* Destination candidates (persistent cards when user typed but hasn't selected) */}
      {!manualDest &&
        !hidePredictionsDropdown &&
        showDestinationCandidateCards &&
        onSelectDestinationCandidate && (
          <View
            style={[
              styles.predictionsDropdown,
              embedded && { maxWidth: "100%" as any },
            ]}
          >
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
            <ScrollView
              style={styles.predictionsScroll}
              keyboardShouldPersistTaps="always"
              nestedScrollEnabled
            >
              {destinationCandidates.map((pred, idx) => {
                const selected = pred.placeId === selectedDestinationCandidateId;
                return (
                  <Pressable
                    key={`candidate-${pred.placeId}`}
                    style={({ pressed }: { pressed: boolean }) => [
                      styles.predictionItem,
                      idx === destinationCandidates.length - 1 &&
                        styles.predictionItemLast,
                      selected && styles.candidateItemSelected,
                      pressed && styles.predictionItemPressed,
                    ]}
                    onPress={() => {
                      onSelectDestinationCandidate(pred.placeId, true);
                    }}
                  >
                    <View style={styles.predictionIcon}>
                      <Ionicons
                        name={selected ? "radio-button-on" : "radio-button-off"}
                        size={18}
                        color={selected ? "#1570ef" : "#667085"}
                      />
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
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        )}

      {/* ── Saved places (when no predictions showing) ── */}
      {activePredictions.length === 0 &&
        destinationCandidates.length === 0 &&
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
    backgroundColor: "transparent",
    borderRadius: 0,
    boxShadow: "none",
    elevation: 0,
    overflow: "visible",
    paddingTop: 0,
    paddingBottom: 0,
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
    // Holds the gap that used to be a margin on the field, so every pixel
    // of the field's own box is part of its tap area.
    width: 28,
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
    marginLeft: 0,
    backgroundColor: "rgba(255, 255, 255, 0.72)",
    borderRadius: Platform.OS === "web" ? 16 : 12,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.95)",
    paddingHorizontal:
      Platform.OS === "android" ? 12 : Platform.OS === "web" ? 14 : 10,
    paddingVertical:
      Platform.OS === "android" ? 9 : Platform.OS === "web" ? 11 : 7,
    ...(Platform.OS === "web"
      ? { boxShadow: "0 2px 10px rgba(15, 23, 42, 0.08)" }
      : {}),
  },
  inputFieldWrapFocused: {
    borderColor: "rgba(21, 112, 239, 0.35)",
    backgroundColor: "rgba(255, 255, 255, 0.95)",
    ...(Platform.OS === "web"
      ? { boxShadow: "0 4px 14px rgba(21, 112, 239, 0.12)" }
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
    padding: 6,
    borderRadius: 999,
    backgroundColor: "rgba(255, 255, 255, 0.8)",
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
  magicSlot: {
    marginLeft: 'auto',
    paddingLeft: 8,
  },
  swapButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(255, 255, 255, 0.85)",
    boxShadow: "0 1px 4px rgba(15, 23, 42, 0.12)",
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
  predictionsScroll: {
    maxHeight: 380,
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
  candidatesHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#f2f4f7",
  },
  candidatesTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: "#344054",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  candidateItemSelected: {
    backgroundColor: "#eff8ff",
  },
});