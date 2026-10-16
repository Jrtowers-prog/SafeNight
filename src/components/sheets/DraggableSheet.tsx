/**
 * DraggableSheet — Cross-platform bottom sheet with unified scroll+drag logic.
 *
 * Three snap points: MIN (peek), DEFAULT (40%), MAX (75%).
 * - Drag handle always initiates sheet resize
 * - Body pan only captures when scrolled to top AND swiping down
 *   (no confusing bottom-edge capture)
 * - 3-point nearest-distance snap with velocity shortcuts
 * - Dynamic screen height (supports rotation)
 * - Auto-snaps to DEFAULT when sheet becomes visible
 * - PanResponders recreated via useMemo to avoid stale closures
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
    Animated,
    Dimensions,
    PanResponder,
    Platform,
    ScrollView,
    StyleSheet,
    View,
} from 'react-native';

/** Always-fresh screen height (handles rotation / resize) */
function getScreenHeight() {
  return Dimensions.get('window').height;
}

const SHEET_MIN = 80;
const SHEET_DEFAULT_RATIO = 0.4;
const SHEET_MAX_RATIO = 0.75;

function getSheetDefault() { return getScreenHeight() * SHEET_DEFAULT_RATIO; }
function getSheetMax() { return getScreenHeight() * SHEET_MAX_RATIO; }

/** Legacy exports — keep the constants available for consumers */
const SHEET_DEFAULT = Dimensions.get('window').height * SHEET_DEFAULT_RATIO;
const SHEET_MAX = Dimensions.get('window').height * SHEET_MAX_RATIO;
export { SHEET_DEFAULT, SHEET_MAX, SHEET_MIN };

interface DraggableSheetProps {
  children: React.ReactNode;
  /** Safe-area bottom inset */
  bottomInset: number;
  /** Whether the sheet is visible at all */
  visible: boolean;
  /** External animated value — parent can read the current height */
  sheetHeight: Animated.Value;
  /** Ref to the height number */
  sheetHeightRef: React.MutableRefObject<number>;
  /** Optional ScrollView ref (parent can control scrolling) */
  scrollRef?: any;
  /** Optional sticky header indices to pass to ScrollView (web/native) */
  stickyHeaderIndices?: number[];
}

export function DraggableSheet({
  children,
  bottomInset,
  visible,
  sheetHeight,
  sheetHeightRef,
  scrollRef,
  stickyHeaderIndices,
}: DraggableSheetProps) {
  const scrollOffsetRef = useRef(0);
  const isAtTopRef = useRef(true);
  /** Tracks the height value captured at the start of a gesture */
  const gestureStartHeight = useRef(0);

  // ── Snap logic ──────────────────────────────────────────────────────
  const snapTo = useCallback(
    (target: number) => {
      sheetHeightRef.current = target;
      Animated.spring(sheetHeight, {
        toValue: target,
        useNativeDriver: false,
        tension: 68,
        friction: 12,
      }).start();
    },
    [sheetHeight, sheetHeightRef],
  );

  const snapToNearest = useCallback(
    (current: number, velocity: number) => {
      const sheetDefault = getSheetDefault();
      const sheetMax = getSheetMax();

      // Fast flick shortcuts
      if (velocity > 0.5) { snapTo(SHEET_MIN); return; }
      if (velocity < -0.5) { snapTo(sheetMax); return; }

      // Nearest-distance among all three snap points
      const dMin = Math.abs(current - SHEET_MIN);
      const dDef = Math.abs(current - sheetDefault);
      const dMax = Math.abs(current - sheetMax);
      const best = Math.min(dMin, dDef, dMax);
      if (best === dMin) snapTo(SHEET_MIN);
      else if (best === dDef) snapTo(sheetDefault);
      else snapTo(sheetMax);
    },
    [snapTo],
  );

  // ── Auto-snap to default when sheet becomes visible ─────────────────
  const prevVisible = useRef(false);
  useEffect(() => {
    if (visible && !prevVisible.current) {
      prevVisible.current = true;
      requestAnimationFrame(() => snapTo(getSheetDefault()));
    }
    if (!visible && prevVisible.current) {
      prevVisible.current = false;
    }
  }, [visible, snapTo]);

  // ── Shared gesture helpers ──────────────────────────────────────────
  const onGestureStart = useCallback(() => {
    sheetHeight.stopAnimation((v: number) => {
      sheetHeightRef.current = v;
      gestureStartHeight.current = v;
    });
  }, [sheetHeight, sheetHeightRef]);

  const onGestureMove = useCallback(
    (dy: number) => {
      const sheetMax = getSheetMax();
      const next = Math.min(sheetMax, Math.max(SHEET_MIN, gestureStartHeight.current - dy));
      sheetHeight.setValue(next);
    },
    [sheetHeight],
  );

  const onGestureEnd = useCallback(
    (dy: number, vy: number) => {
      const current = gestureStartHeight.current - dy;
      snapToNearest(current, vy);
    },
    [snapToNearest],
  );

  // ── Handle PanResponder (drag handle — always draggable) ────────────
  const handlePanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => onGestureStart(),
        onPanResponderMove: (_, g) => onGestureMove(g.dy),
        onPanResponderRelease: (_, g) => onGestureEnd(g.dy, g.vy),
      }),
    [onGestureStart, onGestureMove, onGestureEnd],
  );

  // ── Body PanResponder (scroll area — only captures swipe-down at top)
  const bodyPanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponderCapture: (_, g) => {
          if (Math.abs(g.dy) < 4) return false;
          // Only intercept when scrolled to top AND swiping down
          return g.dy > 0 && isAtTopRef.current;
        },
        onPanResponderTerminationRequest: () => true,
        onPanResponderGrant: () => onGestureStart(),
        onPanResponderMove: (_, g) => onGestureMove(g.dy),
        onPanResponderRelease: (_, g) => onGestureEnd(g.dy, g.vy),
        onShouldBlockNativeResponder: () => false,
      }),
    [onGestureStart, onGestureMove, onGestureEnd],
  );

  // Keep consistent body gesture handoff across platforms:
  // scroll owns normal interaction; sheet captures only top-edge swipe-down.
  const bodyPanHandlers = bodyPanResponder.panHandlers;

  // ── Scroll tracking ─────────────────────────────────────────────────
  const handleSheetScroll = useCallback((e: any) => {
    const { contentOffset } = e.nativeEvent;
    scrollOffsetRef.current = contentOffset.y;
    isAtTopRef.current = contentOffset.y <= 1;
  }, []);

  if (!visible) return null;

  return (
    <Animated.View
      style={[
        styles.sheet,
        { height: sheetHeight },
      ]}
      needsOffscreenAlphaCompositing={Platform.OS === 'android'}
    >
      {/* Drag handle */}
      <View {...handlePanResponder.panHandlers} style={styles.dragZone}>
        <View style={styles.handle} />
      </View>

      {/* Scrollable content */}
      <View style={{ flex: 1 }} pointerEvents="auto" {...bodyPanHandlers}>
        <ScrollView
          ref={scrollRef}
          stickyHeaderIndices={stickyHeaderIndices}
          style={styles.scroll}
          contentContainerStyle={[styles.content, { paddingBottom: bottomInset + 24 }]}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={handleSheetScroll}
          bounces={false}
          nestedScrollEnabled={Platform.OS === 'android'}
          keyboardShouldPersistTaps="always"
          scrollEnabled
          pointerEvents="auto"
        >
          {children}
        </ScrollView>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    bottom: 0,
    alignSelf: 'center',
    width: '100%',
    maxWidth: 900,
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0 -4px 12px rgba(0, 0, 0, 0.15)', userSelect: 'none', cursor: 'default' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: -4 },
          shadowOpacity: 0.15,
          shadowRadius: 12,
        }),
    elevation: 12,
    zIndex: 220,
    overflow: 'hidden',
  } as any,
  dragZone: {
    alignItems: 'center',
    paddingTop: 12,
    paddingBottom: 10,
    ...(Platform.OS === 'web' ? { cursor: 'grab', touchAction: 'none' } : {}),
  } as any,
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#d0d5dd',
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 80,
  },
});
