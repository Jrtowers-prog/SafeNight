import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import type { MapType } from './RouteMap.types';

type MapTypeControlProps = {
  mapType: MapType;
  onMapTypeChange: (mapType: MapType) => void;
};

const MAP_TYPE_OPTIONS: { value: MapType; label: string }[] = [
  { value: 'roadmap', label: 'Default' },
];

export const MapTypeControl = ({ mapType, onMapTypeChange }: MapTypeControlProps) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const isPhone = Platform.OS !== 'web';

  return (
    <View style={Platform.OS === 'web' ? styles.container : undefined}>      {isExpanded ? (
        <View style={styles.expandedContainer}>
          {MAP_TYPE_OPTIONS.map((option) => (
            <Pressable
              key={option.value}
              style={[
                styles.optionButton,
                mapType === option.value && styles.optionButtonActive,
              ]}
              onPress={() => {
                onMapTypeChange(option.value);
                setIsExpanded(false);
              }}>
              <Text
                style={[
                  styles.optionText,
                  mapType === option.value && styles.optionTextActive,
                ]}>
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : isPhone ? (
        <Pressable style={styles.iconButton} onPress={() => setIsExpanded(true)}>
          <Ionicons name="layers-outline" size={18} color="#1D2939" />
        </Pressable>
      ) : (
        <Pressable style={styles.compactButton} onPress={() => setIsExpanded(true)}>
          <Text style={styles.compactText}>
            {MAP_TYPE_OPTIONS.find((opt) => opt.value === mapType)?.label ?? 'Map'}
          </Text>
        </Pressable>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 16,
    right: 16,
    zIndex: 1000,
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 4,
    elevation: 3,
  },
  compactButton: {
    backgroundColor: '#ffffff',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
  },
  compactText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1D2939',
  },
  expandedContainer: {
    backgroundColor: '#ffffff',
    borderRadius: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
    elevation: 3,
    overflow: 'hidden',
  },
  optionButton: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F2F4F7',
  },
  optionButtonActive: {
    backgroundColor: '#EFF8FF',
  },
  optionText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#475467',
  },
  optionTextActive: {
    color: '#1570EF',
    fontWeight: '600',
  },
});
