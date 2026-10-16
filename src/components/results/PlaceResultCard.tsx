import { Ionicons } from "@expo/vector-icons";
import { memo, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { PlacePrediction } from "@/src/types/geo";

import { PlaceActionRow } from "./PlaceActionRow";
import { placeCardTokens } from "./placeCard.tokens";

export type PlaceResultCardProps = {
  place: PlacePrediction;
  selected: boolean;
  distanceLabel?: string | null;
  subtitle?: string | null;
  meta?: string | null;
  isSafeDirectionsLoading?: boolean;
  isSaved?: boolean;
  onSelect: () => void;
  onSafeDirections: () => void;
  onShare?: () => void;
  onSave?: () => void;
};

function PlaceResultCardComponent({
  place,
  selected,
  distanceLabel,
  subtitle,
  meta,
  isSafeDirectionsLoading = false,
  isSaved = false,
  onSelect,
  onSafeDirections,
  onShare,
  onSave,
}: PlaceResultCardProps) {
  const accessibilityLabel = useMemo(() => {
    const distance = distanceLabel ? `, ${distanceLabel} away` : "";
    return `${place.primaryText}${distance}`;
  }, [place.primaryText, distanceLabel]);

  return (
    <Pressable
      onPress={onSelect}
      style={({ pressed, focused }: any) => [
        styles.card,
        selected && styles.cardSelected,
        pressed ? styles.cardPressed : null,
        focused ? styles.cardFocused : null,
      ]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
    >
      <View style={styles.headerRow}>
        <View style={styles.titleWrap}>
          <Ionicons
            name={selected ? "radio-button-on" : "radio-button-off"}
            size={16}
            color={selected ? placeCardTokens.colors.primary : "#667085"}
          />
          <Text style={styles.title} numberOfLines={1}>
            {place.primaryText}
          </Text>
        </View>
        {distanceLabel ? <Text style={styles.distance}>{distanceLabel}</Text> : null}
      </View>

      {subtitle ? (
        <Text style={styles.subtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}

      {meta ? (
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
      ) : null}

      <PlaceActionRow
        onSafeDirections={onSafeDirections}
        onShare={onShare}
        onSave={onSave}
        isSafeDirectionsLoading={isSafeDirectionsLoading}
        isSaved={isSaved}
      />
    </Pressable>
  );
}

export const PlaceResultCard = memo(PlaceResultCardComponent);

const styles = StyleSheet.create({
  card: {
    borderRadius: placeCardTokens.radius.card,
    borderWidth: 1,
    borderColor: placeCardTokens.colors.border,
    backgroundColor: placeCardTokens.colors.surface,
    paddingHorizontal: placeCardTokens.spacing.cardPadding,
    paddingVertical: 11,
    marginHorizontal: 12,
    marginBottom: 10,
    gap: placeCardTokens.spacing.rowGap,
  },
  cardSelected: {
    borderColor: placeCardTokens.colors.borderSelected,
    backgroundColor: placeCardTokens.colors.surfaceSelected,
  },
  cardPressed: {
    opacity: 0.96,
  },
  cardFocused: {
    borderColor: placeCardTokens.colors.focusRing,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  titleWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  title: {
    color: placeCardTokens.colors.textPrimary,
    fontWeight: "700",
    fontSize: placeCardTokens.typography.title,
    flex: 1,
  },
  distance: {
    color: "#0f4ab8",
    fontWeight: "700",
    fontSize: 12,
  },
  subtitle: {
    color: placeCardTokens.colors.textSecondary,
    fontSize: placeCardTokens.typography.subtitle,
    fontWeight: "500",
  },
  meta: {
    color: placeCardTokens.colors.textMeta,
    fontSize: placeCardTokens.typography.meta,
    fontWeight: "700",
  },
});
