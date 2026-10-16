/**
 * WebSidebar — left sidebar for web only.
 *
 * Replaces the centered SearchBar + DraggableSheet bottom sheet on web.
 * Features:
 * - Left-anchored, expands rightward
 * - Search inputs at the top
 * - Route results + safety panel below
 * - Center toggle pill to collapse/expand
 * - Auto-expands when results arrive, auto-compacts on clear
 * - Minimum width preserves search inputs; cannot collapse below docked rail
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  clampWebSidebarWidth,
  getWebSidebarCollapsedWidth,
  getWebSidebarOpenWidth,
} from './webSidebarLayout';

export interface WebSidebarProps {
  /** Whether route results are present */
  hasResults: boolean;
  /** Whether we're loading */
  isLoading: boolean;
  /** Whether there's an error */
  hasError: boolean;
  /** Called when user clicks the close/clear button on results */
  onClearResults: () => void;
  /** Controls whether the clear button is shown in the results header. */
  showClearButton?: boolean;
  /** Search bar element */
  searchBar: React.ReactNode;
  /** Download banner element */
  downloadBanner?: React.ReactNode;
  /** Login button for web guests */
  loginButton?: React.ReactNode;
  /** The sheet content (route list, safety, charts, etc.) */
  children: React.ReactNode;
  /** Reports the live width so the parent can keep overlays aligned. */
  onWidthChange?: (width: number) => void;
}

export function WebSidebar({
  hasResults,
  isLoading,
  hasError,
  onClearResults,
  showClearButton = hasResults,
  searchBar,
  downloadBanner,
  loginButton,
  children,
  onWidthChange,
}: WebSidebarProps) {
  const showContent = hasResults || isLoading || hasError;
  const [viewportWidth, setViewportWidth] = useState(() => Dimensions.get('window').width);

  const initialWidth = getWebSidebarOpenWidth(viewportWidth, showContent);
  const sidebarWidth = useRef(new Animated.Value(initialWidth)).current;
  const widthRef = useRef(initialWidth);
  const lastOpenWidthRef = useRef(initialWidth);
  const prevShowContent = useRef(showContent);

  const [isCollapsed, setIsCollapsed] = useState(false);

  const emitWidthChange = useCallback(
    (nextWidth: number) => {
      onWidthChange?.(nextWidth);
    },
    [onWidthChange],
  );

  const animateToWidth = useCallback(
    (target: number, options?: { immediate?: boolean; forceDocked?: boolean }) => {
      const nextWidth = clampWebSidebarWidth(
        target,
        viewportWidth,
        options?.forceDocked ? false : showContent,
      );
      widthRef.current = nextWidth;
      emitWidthChange(nextWidth);

      if (options?.immediate) {
        sidebarWidth.setValue(nextWidth);
        return;
      }

      Animated.spring(sidebarWidth, {
        toValue: nextWidth,
        useNativeDriver: false,
        tension: 70,
        friction: 12,
      }).start();
    },
    [emitWidthChange, sidebarWidth, showContent, viewportWidth],
  );

  useEffect(() => {
    const sub = Dimensions.addEventListener('change', () => {
      const nextViewportWidth = Dimensions.get('window').width;
      setViewportWidth(nextViewportWidth);

      const nextWidth = clampWebSidebarWidth(
        widthRef.current,
        nextViewportWidth,
        showContent,
      );
      widthRef.current = nextWidth;
      emitWidthChange(nextWidth);
      sidebarWidth.setValue(nextWidth);
    });

    return () => sub.remove();
  }, [emitWidthChange, showContent, sidebarWidth]);

  useEffect(() => {
    emitWidthChange(widthRef.current);
  }, [emitWidthChange]);

  useEffect(() => {
    if (showContent && !prevShowContent.current) {
      const target = getWebSidebarOpenWidth(viewportWidth, true);
      lastOpenWidthRef.current = target;
      setIsCollapsed(false);
      animateToWidth(target);
    }

    if (!showContent) {
      setIsCollapsed(widthRef.current <= getWebSidebarCollapsedWidth(false) + 8);
    }

    prevShowContent.current = showContent;
  }, [animateToWidth, showContent, viewportWidth]);

  const handleToggle = useCallback(() => {
    if (isCollapsed) {
      const target = lastOpenWidthRef.current || getWebSidebarOpenWidth(viewportWidth, showContent);
      setIsCollapsed(false);
      animateToWidth(target);
      return;
    }

    lastOpenWidthRef.current = widthRef.current;
    const target = getWebSidebarCollapsedWidth(showContent);
    setIsCollapsed(true);
    animateToWidth(target, { forceDocked: true });
  }, [animateToWidth, isCollapsed, showContent, viewportWidth]);

  const handleClear = useCallback(() => {
    onClearResults();
    setIsCollapsed(false);
    animateToWidth(getWebSidebarOpenWidth(viewportWidth, false));
  }, [animateToWidth, onClearResults, viewportWidth]);

  return (
    <Animated.View
      style={[
        styles.sidebar,
        { width: sidebarWidth },
      ]}
    >
      <View style={styles.sidebarInner}>
        {!isCollapsed && downloadBanner}

        {!isCollapsed && (
          <View style={styles.searchArea}>
            {searchBar}
          </View>
        )}

        {!isCollapsed && loginButton && (
          <View style={styles.loginArea}>{loginButton}</View>
        )}

        {!isCollapsed && showContent && (
          <View style={styles.resultsArea}>
            {showClearButton && (
              <View style={styles.resultsHeader}>
                <Pressable
                  onPress={handleClear}
                  style={styles.clearButton}
                  accessibilityRole="button"
                  accessibilityLabel="Clear results"
                >
                  <Ionicons name="close" size={18} color="#667085" />
                </Pressable>
              </View>
            )}
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={true}
              bounces={false}
            >
              {children}
            </ScrollView>
          </View>
        )}

        {isCollapsed && (
          <View style={styles.collapsedContent}>
            <Ionicons name="shield-checkmark" size={24} color="#1570ef" />
          </View>
        )}

        {!isCollapsed && (
          <View style={styles.policyFooter}>
            <Pressable onPress={() => router.push('/privacy' as any)} accessibilityRole="link">
              <Text style={styles.policyLink}>Privacy</Text>
            </Pressable>
            <Text style={styles.policySep}>·</Text>
            <Pressable onPress={() => router.push('/refund' as any)} accessibilityRole="link">
              <Text style={styles.policyLink}>Refund</Text>
            </Pressable>
            <Text style={styles.policySep}>·</Text>
            <Pressable onPress={() => router.push('/terms' as any)} accessibilityRole="link">
              <Text style={styles.policyLink}>Terms</Text>
            </Pressable>
            <Text style={styles.policySep}>·</Text>
            <Pressable onPress={() => router.push('/delete-account' as any)} accessibilityRole="link">
              <Text style={[styles.policyLink, { color: '#EF4444' }]}>Delete Account</Text>
            </Pressable>
          </View>
        )}
      </View>

      <Pressable
        onPress={handleToggle}
        accessibilityRole="button"
        accessibilityLabel={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        accessibilityHint="Toggles the sidebar open or closed"
        style={styles.centerToggleButton}
      >
        <Ionicons
          name={isCollapsed ? 'chevron-forward' : 'chevron-back'}
          size={18}
          color="#0f172a"
        />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sidebar: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: '#ffffff',
    zIndex: 15,
    flexDirection: 'row',
    boxShadow: '4px 0 16px rgba(0, 0, 0, 0.08)',
    overflow: 'visible',
  } as any,
  sidebarInner: {
    flex: 1,
    paddingHorizontal: 8,
    overflow: 'visible',
  },
  searchArea: {
    paddingTop: 12,
    paddingHorizontal: 0,
  },
  loginArea: {
    paddingHorizontal: 4,
    paddingTop: 8,
  },
  resultsArea: {
    flex: 1,
    borderTopWidth: 1,
    borderTopColor: '#f2f4f7',
    marginTop: 8,
  },
  resultsHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 4,
    paddingTop: 8,
    paddingBottom: 4,
  },
  clearButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#f2f4f7',
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 4,
    paddingBottom: 24,
  },
  collapsedContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  policyFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E2E8F0',
    gap: 4,
    flexWrap: 'wrap',
  },
  policyLink: {
    fontSize: 11,
    color: '#94A3B8',
    fontWeight: '500',
    paddingHorizontal: 2,
  },
  policySep: {
    fontSize: 11,
    color: '#CBD5E1',
  },
  centerToggleButton: {
    position: 'absolute',
    right: -18,
    top: '50%',
    marginTop: -32,
    width: 42,
    height: 64,
    borderRadius: 20,
    backgroundColor: '#ffffff',
    borderColor: '#dbe4f0',
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '3px 6px 14px rgba(15, 23, 42, 0.16)',
    zIndex: 999,
    cursor: 'pointer',
  } as any,
});
