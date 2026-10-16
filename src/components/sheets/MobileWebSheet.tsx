/**
 * MobileWebSheet — Bottom sheet for phone-size web.
 *
 * Unified scroll+drag logic matching DraggableSheet:
 * - Three snap points: peek (120px), half (45%), full (85%)
 * - Drag handle always initiates sheet resize
 * - Body pan only captures when scrolled to top AND swiping down
 * - 3-point nearest-distance snap with velocity shortcuts
 * - Dynamic screen height (handles resize)
 * - Auto-snaps to half when sheet becomes visible
 * - PanResponders via useMemo to avoid stale closures
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Animated,
    Dimensions,
    PanResponder,
    ScrollView,
    StyleSheet,
    View,
} from 'react-native';

function getScreenHeight() {
  return Dimensions.get('window').height;
}

const SHEET_PEEK = 120;
const SHEET_HALF_RATIO = 0.45;
const SHEET_FULL_RATIO = 0.85;

function getSheetHalf() { return getScreenHeight() * SHEET_HALF_RATIO; }
function getSheetFull() { return getScreenHeight() * SHEET_FULL_RATIO; }

interface MobileWebSheetProps {
  children: React.ReactNode;
  visible: boolean;
}

export function MobileWebSheet({ children, visible }: MobileWebSheetProps) {
  const animatedHeight = useRef(new Animated.Value(SHEET_PEEK)).current;
  const heightRef = useRef(SHEET_PEEK);
  const [currentSnap, setCurrentSnap] = useState(SHEET_PEEK);

  // Scroll state
  const scrollRef = useRef<ScrollView>(null);
  const scrollOffset = useRef(0);
  const isAtTopRef = useRef(true);
  /** Tracks the height value captured at the start of a gesture */
  const gestureStartHeight = useRef(0);

  // ── Snap logic (unified with DraggableSheet) ─────────────────────────
  const snapTo = useCallback((target: number) => {
    heightRef.current = target;
    setCurrentSnap(target);
    Animated.spring(animatedHeight, {
      toValue: target,
      useNativeDriver: false,
      tension: 68,
      friction: 12,
    }).start();
  }, [animatedHeight]);

  const snapToNearest = useCallback((current: number, velocity: number) => {
    const half = getSheetHalf();
    const full = getSheetFull();

    // Fast flick shortcuts
    if (velocity > 0.5) { snapTo(SHEET_PEEK); return; }
    if (velocity < -0.5) { snapTo(full); return; }

    // Nearest-distance among all three snap points
    const dPeek = Math.abs(current - SHEET_PEEK);
    const dHalf = Math.abs(current - half);
    const dFull = Math.abs(current - full);
    const best = Math.min(dPeek, dHalf, dFull);
    if (best === dPeek) snapTo(SHEET_PEEK);
    else if (best === dHalf) snapTo(half);
    else snapTo(full);
  }, [snapTo]);

  // Auto-snap to half when sheet becomes visible
  const prevVisible = useRef(false);
  useEffect(() => {
    if (visible && !prevVisible.current) {
      prevVisible.current = true;
      requestAnimationFrame(() => snapTo(getSheetHalf()));
    }
    if (!visible && prevVisible.current) {
      prevVisible.current = false;
    }
  }, [visible, snapTo]);

  // ── Shared gesture helpers (same pattern as DraggableSheet) ──────────
  const onGestureStart = useCallback(() => {
    animatedHeight.stopAnimation((v: number) => {
      heightRef.current = v;
      gestureStartHeight.current = v;
    });
  }, [animatedHeight]);

  const onGestureMove = useCallback(
    (dy: number) => {
      const next = Math.min(
        getSheetFull(),
        Math.max(SHEET_PEEK, gestureStartHeight.current - dy),
      );
      animatedHeight.setValue(next);
    },
    [animatedHeight],
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

  const handleScroll = useCallback((e: any) => {
    const { contentOffset } = e.nativeEvent;
    scrollOffset.current = contentOffset.y;
    isAtTopRef.current = contentOffset.y <= 1;
  }, []);

  if (!visible) return null;

  return (
    <Animated.View style={[styles.sheet, { height: animatedHeight }]}>
      {/* Drag handle */}
      <View {...handlePanResponder.panHandlers} style={styles.dragZone}>
        <View style={styles.handle} />
      </View>

      {/* Content */}
      <View style={styles.scrollWrap} {...bodyPanResponder.panHandlers}>
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={handleScroll}
          bounces={false}
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
    left: 0,
    right: 0,
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    boxShadow: '0 -4px 16px rgba(0,0,0,0.15)',
    zIndex: 40,
    overflow: 'hidden',
    userSelect: 'none',
    cursor: 'default',
  } as any,
  dragZone: {
    alignItems: 'center',
    paddingTop: 12,
    paddingBottom: 10,
    cursor: 'grab',
    touchAction: 'none',
  } as any,
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#d0d5dd',
  },
  scrollWrap: {
    flex: 1,
    touchAction: 'pan-y',
  } as any,
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
});
