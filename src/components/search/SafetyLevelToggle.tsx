/**
 * SafetyLevelToggle — "magic" pill that switches safety data between
 * Extra (full dataset, default) and Standard (roads + lights only, faster).
 */
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { SafetyLevel } from '@/src/services/safeRoutes';

export interface SafetyLevelToggleProps {
  value: SafetyLevel;
  onChange: (level: SafetyLevel) => void;
}

export function SafetyLevelToggle({ value, onChange }: SafetyLevelToggleProps) {
  const isExtra = value === 'extra';

  return (
    <Pressable
      onPress={() => onChange(isExtra ? 'standard' : 'extra')}
      accessibilityRole="switch"
      accessibilityState={{ checked: isExtra }}
      accessibilityLabel="Extra safety data"
      hitSlop={8}
    >
      {isExtra ? (
        <LinearGradient
          colors={['#7c3aed', '#06b6d4']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.pill}
        >
          <Ionicons name="sparkles" size={14} color="#ffffff" />
          <Text style={styles.textOn}>Extra</Text>
        </LinearGradient>
      ) : (
        <View style={[styles.pill, styles.pillOff]}>
          <Ionicons name="sparkles-outline" size={14} color="#667085" />
          <Text style={styles.textOff}>Standard</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  pillOff: {
    backgroundColor: '#f2f4f7',
  },
  textOn: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '600',
  },
  textOff: {
    color: '#667085',
    fontSize: 12,
    fontWeight: '600',
  },
});
