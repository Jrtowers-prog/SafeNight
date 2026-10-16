import { Ionicons } from "@expo/vector-icons";
import { memo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { placeCardTokens } from "./placeCard.tokens";

type PlaceActionRowProps = {
  onSafeDirections: () => void;
  onShare?: () => void;
  onSave?: () => void;
  isSafeDirectionsLoading?: boolean;
  isSaved?: boolean;
  disabled?: boolean;
};

function PlaceActionRowComponent({
  onSafeDirections,
  onShare,
  onSave,
  isSafeDirectionsLoading = false,
  isSaved = false,
  disabled = false,
}: PlaceActionRowProps) {
  return (
    <View style={styles.row}>
      <Pressable
        style={({ pressed, focused }: any) => [
          styles.primaryButton,
          (pressed || focused) && styles.primaryButtonActive,
          (disabled || isSafeDirectionsLoading) && styles.buttonDisabled,
        ]}
        disabled={disabled || isSafeDirectionsLoading}
        onPress={onSafeDirections}
        accessibilityRole="button"
        accessibilityLabel="Safe Directions"
      >
        {isSafeDirectionsLoading ? (
          <ActivityIndicator size="small" color={placeCardTokens.colors.primaryText} />
        ) : (
          <Ionicons name="navigate" size={14} color={placeCardTokens.colors.primaryText} />
        )}
        <Text style={styles.primaryButtonText}>Safe Directions</Text>
      </Pressable>

      {onShare ? (
        <Pressable
          style={({ pressed, focused }: any) => [
            styles.secondaryButton,
            (pressed || focused) && styles.secondaryButtonActive,
            disabled && styles.buttonDisabled,
          ]}
          disabled={disabled}
          onPress={onShare}
          accessibilityRole="button"
          accessibilityLabel="Share route link"
        >
          <Ionicons name="share-social-outline" size={13} color={placeCardTokens.colors.ghostText} />
          <Text style={styles.secondaryText}>Share</Text>
        </Pressable>
      ) : null}

      {onSave ? (
        <Pressable
          style={({ pressed, focused }: any) => [
            styles.secondaryButton,
            (pressed || focused) && styles.secondaryButtonActive,
            disabled && styles.buttonDisabled,
          ]}
          disabled={disabled}
          onPress={onSave}
          accessibilityRole="button"
          accessibilityLabel={isSaved ? "Saved place" : "Save place"}
        >
          <Ionicons
            name={isSaved ? "bookmark" : "bookmark-outline"}
            size={13}
            color={placeCardTokens.colors.ghostText}
          />
          <Text style={styles.secondaryText}>{isSaved ? "Saved" : "Save"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export const PlaceActionRow = memo(PlaceActionRowComponent);

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: placeCardTokens.spacing.actionsGap,
    marginTop: 2,
  },
  primaryButton: {
    minHeight: 38,
    paddingHorizontal: 12,
    borderRadius: placeCardTokens.radius.button,
    backgroundColor: placeCardTokens.colors.primary,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    flex: 1,
  },
  primaryButtonActive: {
    opacity: 0.9,
  },
  primaryButtonText: {
    color: placeCardTokens.colors.primaryText,
    fontSize: 13,
    fontWeight: "700",
  },
  secondaryButton: {
    minHeight: 34,
    paddingHorizontal: 10,
    borderRadius: placeCardTokens.radius.pill,
    borderWidth: 1,
    borderColor: placeCardTokens.colors.ghostBorder,
    backgroundColor: placeCardTokens.colors.ghostBg,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  secondaryButtonActive: {
    borderColor: placeCardTokens.colors.focusRing,
  },
  secondaryText: {
    color: placeCardTokens.colors.ghostText,
    fontSize: 12,
    fontWeight: "600",
  },
  buttonDisabled: {
    opacity: 0.6,
  },
});
