/**
 * MapToast — Lightweight animated toast that slides up from the bottom.
 *
 * Auto-dismisses after a configurable duration. Supports icon + message.
 */

import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Animated, PanResponder, Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type IoniconsName = keyof typeof Ionicons.glyphMap;

export interface ToastConfig {
  message: string;
  icon?: IoniconsName;
  iconColor?: string;
  bgColor?: string;
  duration?: number;
}

interface Props {
  toast: ToastConfig | null;
  onDismiss: () => void;
  webTopOffset?: number;
  webLeftOffset?: number;
}

export function MapToast({ toast, onDismiss, webTopOffset = 12, webLeftOffset = 0 }: Props) {
  const insets = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(120)).current;
  const dragAnim = useRef(new Animated.Value(0)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissingRef = useRef(false);
  const toastDurationRef = useRef(3000);
  const onDismissRef = useRef(onDismiss);

  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  const clearDismissTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const finishDismiss = useCallback(() => {
    dismissingRef.current = false;
    slideAnim.setValue(120);
    dragAnim.setValue(0);
    opacityAnim.setValue(0);
    onDismissRef.current();
  }, [dragAnim, opacityAnim, slideAnim]);

  const dismissToast = useCallback((fromDrag: boolean) => {
    if (dismissingRef.current) return;
    dismissingRef.current = true;
    clearDismissTimer();

    Animated.parallel([
      Animated.timing(opacityAnim, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }),
      fromDrag
        ? Animated.timing(dragAnim, {
            toValue: 120,
            duration: 220,
            useNativeDriver: true,
          })
        : Animated.timing(slideAnim, {
            toValue: 120,
            duration: 220,
            useNativeDriver: true,
          }),
    ]).start(finishDismiss);
  }, [clearDismissTimer, dragAnim, finishDismiss, opacityAnim, slideAnim]);

  const scheduleAutoDismiss = useCallback(() => {
    clearDismissTimer();
    timerRef.current = setTimeout(() => {
      dismissToast(false);
    }, toastDurationRef.current);
  }, [clearDismissTimer, dismissToast]);

  const panResponder = useMemo(
    () => PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) =>
        gestureState.dy > 6 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
      onPanResponderGrant: () => {
        clearDismissTimer();
      },
      onPanResponderMove: (_, gestureState) => {
        dragAnim.setValue(Math.max(0, gestureState.dy));
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dy >= 60) {
          dismissToast(true);
          return;
        }

        Animated.spring(dragAnim, {
          toValue: 0,
          useNativeDriver: true,
          tension: 120,
          friction: 14,
        }).start(() => {
          if (toast) scheduleAutoDismiss();
        });
      },
      onPanResponderTerminate: () => {
        Animated.spring(dragAnim, {
          toValue: 0,
          useNativeDriver: true,
          tension: 120,
          friction: 14,
        }).start(() => {
          if (toast) scheduleAutoDismiss();
        });
      },
    }),
    [clearDismissTimer, dismissToast, dragAnim, scheduleAutoDismiss, toast],
  );

  useEffect(() => {
    if (!toast) {
      clearDismissTimer();
      return;
    }

    toastDurationRef.current = toast.duration ?? 3000;
    dismissingRef.current = false;
    slideAnim.setValue(120);
    dragAnim.setValue(0);
    opacityAnim.setValue(0);

    Animated.parallel([
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 80,
        friction: 12,
      }),
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }),
    ]).start(() => {
      scheduleAutoDismiss();
    });

    return () => {
      clearDismissTimer();
    };
  }, [toast, clearDismissTimer, dragAnim, opacityAnim, scheduleAutoDismiss, slideAnim]);

  if (!toast) return null;

  return (
    <Animated.View
      {...panResponder.panHandlers}
      style={[
        styles.container,
        {
          ...(Platform.OS === 'web'
            ? { top: insets.top + webTopOffset, left: 16 + webLeftOffset, right: 16, bottom: 'auto' as any }
            : { bottom: insets.bottom + 24 }),
          backgroundColor: toast.bgColor ?? 'rgba(30, 30, 46, 0.95)',
          transform: [{ translateY: Animated.add(slideAnim, dragAnim) }],
          opacity: opacityAnim,
        },
      ]}
      pointerEvents="auto"
    >
      {toast.icon && (
        <View style={[styles.iconWrap, { backgroundColor: (toast.iconColor ?? '#7C3AED') + '22' }]}>
          <Ionicons name={toast.icon} size={18} color={toast.iconColor ?? '#7C3AED'} />
        </View>
      )}
      <Text style={styles.text} numberOfLines={2}>{toast.message}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 9999,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    gap: 10,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }
      : {}),
    elevation: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
    lineHeight: 20,
  },
});
