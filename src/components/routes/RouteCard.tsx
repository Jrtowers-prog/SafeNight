/**
 * RouteCard — A single route in the route list.
 * Safety details are hidden behind a collapsible toggle (Google-Maps style).
 */
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { SafeRoute } from "@/src/services/safeRoutes";
import { formatDistance, formatDuration } from "@/src/utils/format";

interface RouteCardProps {
  route: SafeRoute;
  index: number;
  isSelected: boolean;
  onSelect: () => void;
  /** Full safety breakdown rendered inside the collapsible section */
  detailsPanel?: React.ReactNode;
}

export function RouteCard({
  route,
  index,
  isSelected,
  onSelect,
  detailsPanel,
}: RouteCardProps) {
  const isBest = route.isSafest;
  const safety = route.safety;
  const label = isBest ? "Safest Route" : `Route ${index + 1}`;
  const [expanded, setExpanded] = useState(false);

  // Collapse whenever the card is deselected
  useEffect(() => {
    if (!isSelected) setExpanded(false);
  }, [isSelected]);

  return (
    <Pressable
      onPress={onSelect}
      accessibilityRole="button"
      style={[
        styles.card,
        isSelected && styles.cardSelected,
        isBest && styles.cardBest,
      ]}
    >
      {/* ── Header: route name + score badge ─────────────────── */}
      <View style={styles.header}>
        <View style={styles.labelRow}>
          <Text
            style={[
              styles.label,
              isSelected && styles.labelSelected,
              isBest && styles.labelBest,
            ]}
          >
            {label}
          </Text>
          {isBest && (
            <View style={styles.bestBadge}>
              <Text style={styles.bestBadgeText}>★ Recommended</Text>
            </View>
          )}
        </View>
        <View
          style={[styles.scoreChip, { backgroundColor: safety.color + "20" }]}
        >
          <View
            style={[styles.scoreChipDot, { backgroundColor: safety.color }]}
          />
          <Text style={[styles.scoreChipText, { color: safety.color }]}>
            {safety.score}
          </Text>
        </View>
      </View>

      {/* ── Summary line ─────────────────────────────────────── */}
      <Text style={styles.details}>
        🚶 {formatDistance(route.distanceMeters)} ·{" "}
        {formatDuration(route.durationSeconds)}
        {"  "}
        <Text style={[styles.safetyInline, { color: safety.color }]}>
          {safety.label}
        </Text>
      </Text>

      {/* ── Safety Details toggle (only when selected + data available) ── */}
      {isSelected && detailsPanel != null && (
        <Pressable
          style={styles.detailsToggle}
          onPress={() => setExpanded((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={
            expanded ? "Collapse safety details" : "Expand safety details"
          }
          hitSlop={8}
        >
          <Text style={styles.detailsToggleText}>Safety Details</Text>
          <Text style={[styles.chevron, expanded && styles.chevronOpen]}>
            ›
          </Text>
        </Pressable>
      )}

      {/* ── Collapsible body ─────────────────────────────────── */}
      {isSelected && expanded && detailsPanel != null && (
        <View style={styles.detailsWrap}>{detailsPanel}</View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: 12,
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "#eaecf0",
    backgroundColor: "#ffffff",
  },
  cardSelected: {
    borderColor: "#1570ef",
    backgroundColor: "#f0f9ff",
  },
  cardBest: {
    borderColor: "#22c55e",
    backgroundColor: "#f0fdf4",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  label: {
    fontSize: 16,
    fontWeight: "600",
    color: "#101828",
  },
  labelSelected: {
    color: "#1570ef",
  },
  labelBest: {
    color: "#16a34a",
  },
  bestBadge: {
    backgroundColor: "#dcfce7",
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  bestBadgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#16a34a",
  },
  scoreChip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 12,
    gap: 5,
  },
  scoreChipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  scoreChipText: {
    fontSize: 13,
    fontWeight: "700",
  },
  details: {
    fontSize: 14,
    color: "#667085",
    marginBottom: 2,
  },
  safetyInline: {
    fontSize: 13,
    fontWeight: "600",
  },
  detailsToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#dde3ef",
  },
  detailsToggleText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#1570ef",
  },
  chevron: {
    fontSize: 18,
    fontWeight: "600",
    color: "#1570ef",
    transform: [{ rotate: "90deg" }],
  },
  chevronOpen: {
    transform: [{ rotate: "-90deg" }],
  },
  detailsWrap: {
    marginTop: 12,
  },
});
