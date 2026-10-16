/**
 * LimitReachedModal — Popup shown when a subscription limit is hit.
 *
 * Displays:
 * - Which feature is limited
 * - How many uses were consumed vs the limit
 * - When the limit resets (if time-windowed)
 * - A prompt to upgrade
 * - A close (X) button
 */
import { Ionicons } from '@expo/vector-icons';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import type { LimitInfo } from '@/src/types/limitError';

// ── Friendly names & icons per feature ───────────────────────────────────────

const FEATURE_META: Record<string, { label: string; icon: string; description: string }> = {
  route_search: {
    label: 'Route Searches',
    icon: 'search',
    description: 'Safety-analysed route searches',
  },
  route_distance: {
    label: 'Route Distance',
    icon: 'map-outline',
    description: 'Maximum walking route distance',
  },
  navigation_start: {
    label: 'Navigation Sessions',
    icon: 'navigate',
    description: 'Turn-by-turn navigation sessions',
  },
  emergency_contacts: {
    label: 'Safety Circle Contacts',
    icon: 'people',
    description: 'Emergency contacts in your Safety Circle',
  },
  live_sessions: {
    label: 'Live Location Sharing',
    icon: 'location',
    description: 'Live location sharing sessions',
  },
  ai_explanation: {
    label: 'AI Route Explanations',
    icon: 'sparkles',
    description: 'AI-powered route safety explanations',
  },
  safety_reports: {
    label: 'Safety Reports',
    icon: 'warning',
    description: 'Safety hazard reports',
  },
};

function getFeatureMeta(feature: string) {
  return FEATURE_META[feature] || {
    label: feature.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    icon: 'lock-closed',
    description: feature,
  };
}

/** Format the reset time into a human-readable relative string */
function formatResetTime(resetsAt: string | null, per: string | null): string {
  if (!resetsAt && !per) return '';

  if (per === 'day') return 'Your limit resets at midnight tonight.';
  if (per === 'month') return 'Your limit resets at the start of next month.';

  if (resetsAt) {
    try {
      const reset = new Date(resetsAt);
      const now = new Date();
      const diffMs = reset.getTime() - now.getTime();
      if (diffMs <= 0) return 'Your limit should reset shortly.';

      const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
      const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

      if (diffHrs >= 24) {
        const days = Math.ceil(diffHrs / 24);
        return `Your limit resets in ${days} day${days > 1 ? 's' : ''}.`;
      }
      if (diffHrs > 0) {
        return `Your limit resets in ${diffHrs}h ${diffMins}m.`;
      }
      return `Your limit resets in ${diffMins} minute${diffMins !== 1 ? 's' : ''}.`;
    } catch {
      return '';
    }
  }

  return '';
}

function tierLabel(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

// ── Component ────────────────────────────────────────────────────────────────

interface Props {
  visible: boolean;
  limitInfo: LimitInfo | null;
  onClose: () => void;
  /** Called when user taps "Upgrade Now" */
  onUpgrade?: () => void;
}

export function LimitReachedModal({ visible, limitInfo, onClose, onUpgrade }: Props) {
  if (!limitInfo) return null;

  const meta = getFeatureMeta(limitInfo.feature);
  const isUpgradeRequired = limitInfo.errorType === 'upgrade_required';
  const resetText = formatResetTime(limitInfo.resetsAt, limitInfo.per);
  const perLabel = limitInfo.per ? `/${limitInfo.per}` : ' total';
  const dismissLabel = onUpgrade
    ? (!isUpgradeRequired && limitInfo.feature === 'live_sessions'
      ? "Later, I'll look into live sharing"
      : 'Not Now')
    : 'Got it';

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={(e) => e.stopPropagation()}>
          {/* Close button */}
          <Pressable
            style={styles.closeButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={12}
          >
            <Ionicons name="close" size={20} color="#667085" />
          </Pressable>

          {/* Icon */}
          <View style={styles.iconCircle}>
            <Ionicons name={meta.icon as any} size={28} color="#EF4444" />
          </View>

          {/* Title */}
          <Text style={styles.title}>
            {isUpgradeRequired ? 'Upgrade Required' : 'Limit Reached'}
          </Text>

          {/* Feature name */}
          <Text style={styles.featureLabel}>{meta.label}</Text>

          {/* Message */}
          <Text style={styles.message}>
            {isUpgradeRequired
              ? `${meta.description} is not available on the ${tierLabel(limitInfo.currentTier)} plan.`
              : `You've used all ${limitInfo.limit} ${meta.label.toLowerCase()}${perLabel} on the ${tierLabel(limitInfo.currentTier)} plan.`}
          </Text>

          {/* Usage bar (only for limit_reached) */}
          {!isUpgradeRequired && limitInfo.limit > 0 && (
            <View style={styles.usageSection}>
              <View style={styles.usageBarBg}>
                <View
                  style={[
                    styles.usageBarFill,
                    { width: '100%' },
                  ]}
                />
              </View>
              <Text style={styles.usageText}>
                {limitInfo.used} / {limitInfo.limit} used
              </Text>
            </View>
          )}

          {/* Reset info */}
          {resetText ? (
            <View style={styles.resetRow}>
              <Ionicons name="time-outline" size={14} color="#6B7280" />
              <Text style={styles.resetText}>{resetText}</Text>
            </View>
          ) : !isUpgradeRequired ? (
            <View style={styles.resetRow}>
              <Ionicons name="infinite-outline" size={14} color="#6B7280" />
              <Text style={styles.resetText}>This is a total cap for your plan.</Text>
            </View>
          ) : null}

          {/* Upgrade hint */}
          <View style={styles.upgradeHint}>
            <Ionicons name="arrow-up-circle" size={16} color="#7C3AED" />
            <Text style={styles.upgradeText}>
              Upgrade to{' '}
              {limitInfo.currentTier === 'free' ? 'Pro or Premium' : 'Premium'}{' '}
              for higher limits or unlimited access.
            </Text>
          </View>

          {/* Action buttons */}
          <View style={styles.buttonRow}>
            {onUpgrade && (
              <Pressable
                style={styles.upgradeButton}
                onPress={() => {
                  onClose();
                  onUpgrade();
                }}
              >
                <Ionicons name="arrow-up-circle" size={18} color="#fff" />
                <Text style={styles.upgradeButtonText}>Upgrade Now</Text>
              </Pressable>
            )}
            <Pressable
              style={[styles.dismissButton, onUpgrade && styles.dismissButtonSecondary]}
              onPress={onClose}
            >
              <Text style={[styles.dismissButtonText, onUpgrade && styles.dismissButtonTextSecondary]}>
                {dismissLabel}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 28,
    width: '100%',
    maxWidth: 380,
    alignItems: 'center',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 20px 60px rgba(0, 0, 0, 0.3)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 20 },
          shadowOpacity: 0.3,
          shadowRadius: 30,
        }),
    elevation: 24,
  },
  closeButton: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#f2f4f7',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#FEE2E2',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#101828',
    marginBottom: 4,
  },
  featureLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#6B7280',
    marginBottom: 12,
  },
  message: {
    fontSize: 14,
    color: '#374151',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 16,
  },
  usageSection: {
    width: '100%',
    marginBottom: 12,
  },
  usageBarBg: {
    height: 8,
    borderRadius: 4,
    backgroundColor: '#F3F4F6',
    overflow: 'hidden',
    marginBottom: 6,
  },
  usageBarFill: {
    height: '100%',
    borderRadius: 4,
    backgroundColor: '#EF4444',
  } as any,
  usageText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
    textAlign: 'center',
  },
  resetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#F9FAFB',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 12,
    width: '100%',
  },
  resetText: {
    fontSize: 13,
    color: '#6B7280',
    flex: 1,
  },
  upgradeHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#F5F3FF',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 16,
    width: '100%',
  },
  upgradeText: {
    fontSize: 13,
    color: '#5B21B6',
    fontWeight: '500',
    flex: 1,
    lineHeight: 18,
  },
  buttonRow: {
    flexDirection: 'column',
    gap: 8,
    width: '100%',
  },
  upgradeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#7C3AED',
    borderRadius: 12,
    paddingVertical: 13,
    width: '100%',
  },
  upgradeButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  dismissButton: {
    backgroundColor: '#1570EF',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 32,
    width: '100%',
    alignItems: 'center',
  },
  dismissButtonSecondary: {
    backgroundColor: '#F3F4F6',
  },
  dismissButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  dismissButtonTextSecondary: {
    color: '#374151',
  },
});
