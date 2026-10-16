/**
 * JailLoadingAnimation — Animated loading indicator with rotating safety facts.
 *
 * Progress bar strategy:
 *   1. Starts immediately at 20% to confirm work has begun.
 *   2. Follows the progress value supplied by the screen state (client-driven).
 *   3. While loading, progress is clamped to 20–90 and completes at 100 on done.
 * Text strategy:
 *   – Rotates through 35 educational safety facts, one every 5 s.
 *   – Keeps running regardless of backend progress state.
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

type JailLoadingAnimationProps = {
  progressPct?: number | null;
  statusMessage?: string | null;
};

const LOADING_STAGES = [
  { icon: '🗺️', text: 'Building a walkable road graph from OpenStreetMap geometry around your route.' },
  { icon: '🧭', text: 'Tracing realistic corridor boundaries so we score the streets you can actually walk.' },
  { icon: '💡', text: 'Street-light density matters: better-lit segments usually reduce nighttime risk.' },
  { icon: '📹', text: 'Nearby CCTV coverage can raise confidence and improve segment safety weighting.' },
  { icon: '🚨', text: 'Recent crime patterns are weighted by category, not every incident equally.' },
  { icon: '🏪', text: 'Open venues add passive guardianship by increasing eyes-on-street at night.' },
  { icon: '🚌', text: 'Transit stops can improve safety by keeping routes in active, visible corridors.' },
  { icon: '🧱', text: 'Dead-end heavy stretches are penalized because escape options are limited.' },
  { icon: '🛣️', text: 'Main-road exposure is balanced with comfort so the route is safer, not just shorter.' },
  { icon: '👣', text: 'Sidewalk presence is scored because separated walking space reduces conflict with traffic.' },
  { icon: '🌙', text: 'Night routing prioritizes visibility and activity where possible.' },
  { icon: '📐', text: 'Distance-only shortest paths are compared against safety-optimized alternatives.' },
  { icon: '🧠', text: 'We rank candidates by multi-factor safety score, then keep practical travel time in check.' },
  { icon: '🔍', text: 'Sampling node connectivity to avoid sending you through isolated fragments.' },
  { icon: '🚶', text: 'Footway and pedestrian segments are evaluated differently from vehicle-heavy roads.' },
  { icon: '⚖️', text: 'No single signal dominates: lighting, crime, roads, and activity are blended together.' },
  { icon: '📊', text: 'Each segment receives a local score before total route safety is computed.' },
  { icon: '🛰️', text: 'Map data quality varies by area, so confidence is considered during route ranking.' },
  { icon: '🧯', text: 'Higher-risk micro-segments are softened by finding nearby safer alternatives.' },
  { icon: '🧵', text: 'We stitch safe segments into continuous paths that still feel natural to walk.' },
  { icon: '🏙️', text: 'Urban routes often gain from denser lighting and services after dark.' },
  { icon: '🌳', text: 'Quiet park or path segments may be scenic but can score lower at night if isolated.' },
  { icon: '📈', text: 'Progress updates reflect backend phases so your progress bar is deterministic.' },
  { icon: '🧪', text: 'Route candidates are validated for connectivity before final ranking.' },
  { icon: '🧰', text: 'If one data source slows down, fallback logic keeps routing resilient.' },
  { icon: '⏱️', text: 'Caching helps repeated searches complete faster with less redundant computation.' },
  { icon: '🔐', text: 'Safety scoring is computed server-side so your device stays responsive.' },
  { icon: '🌍', text: 'Local context matters: the same distance can have very different night risk by street.' },
  { icon: '🏁', text: 'Final candidates are compared side-by-side before the safest practical route is returned.' },
  { icon: '🛡️', text: 'Goal: reduce exposure to low-light and high-risk segments without huge detours.' },
  { icon: '📌', text: 'Longer trips trigger wider corridor analysis to capture realistic route options.' },
  { icon: '🔄', text: 'Dynamic weighting keeps route selection consistent even when data density changes.' },
  { icon: '🕸️', text: 'Graph search explores multiple branches, not just one straight-line guess.' },
  { icon: '🚦', text: 'Road class influences comfort and predictability during nighttime walking.' },
  { icon: '📚', text: 'Safety score is interpretable: road type, lighting, crime, CCTV, and activity all contribute.' },
  { icon: '✅', text: 'Assembling your final options now and preparing map overlays.' },
];

export function JailLoadingAnimation({ progressPct = null, statusMessage = null }: JailLoadingAnimationProps) {
  const MIN_START_PCT = 20;
  const MAX_LOADING_PCT = 90;

  const [stageIdx, setStageIdx] = useState(0);
  const fadeAnim = useRef(new Animated.Value(1)).current;
  // Displayed progress 0→100 (driven by the hook-provided progressPct)
  const barAnim = useRef(new Animated.Value(0)).current;
  const [displayPct, setDisplayPct] = useState(MIN_START_PCT);

  // ── Fact rotation: every 5 s, cross-fade to next fact ──
  useEffect(() => {
    const interval = setInterval(() => {
      Animated.timing(fadeAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
        setStageIdx((prev) => (prev + 1) % LOADING_STAGES.length);
        Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start();
      });
    }, 5000);
    return () => clearInterval(interval);
  }, [fadeAnim]);

  // Start instantly at 20% so users see immediate feedback.
  useEffect(() => {
    Animated.timing(barAnim, {
      toValue: MIN_START_PCT / 100,
      duration: 250,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Follow incoming progress, clamped to 20..90 while loading ──
  useEffect(() => {
    const hasServerPct = typeof progressPct === 'number' && Number.isFinite(progressPct) && progressPct >= 0;
    const incoming = !hasServerPct
      ? MIN_START_PCT
      : progressPct >= 100
        ? 100
        : Math.max(MIN_START_PCT, Math.min(MAX_LOADING_PCT, Math.round(progressPct)));

    let nextPct = incoming;
    setDisplayPct((prev) => {
      nextPct = Math.max(prev, incoming);
      return nextPct;
    });

    Animated.timing(barAnim, {
      toValue: nextPct / 100,
      duration: 400,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [progressPct, barAnim]);

  const stage = LOADING_STAGES[stageIdx];
  const backendStatus = statusMessage?.trim() || null;

  return (
    <View style={styles.container}>
      <View style={styles.barsContainer}>
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <View key={i} style={styles.bar} />
        ))}
      </View>

      <Text style={styles.icon}>{stage.icon}</Text>

      <Animated.Text style={[styles.statusText, { opacity: fadeAnim }]}>
        {stage.text}
      </Animated.Text>

      {backendStatus ? (
        <Text style={styles.backendStatusText}>{backendStatus}</Text>
      ) : null}

      <View style={styles.progressTrack}>
        <Animated.View
          style={[
            styles.progressFill,
            {
              width: barAnim.interpolate({
                inputRange: [0, 1],
                outputRange: ['0%', '100%'],
              }),
            },
          ]}
        />
      </View>

      <Text style={styles.subtitle}>{displayPct}% analysed</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: 28,
    paddingHorizontal: 16,
    gap: 12,
  },
  barsContainer: {
    position: 'absolute',
    top: 10,
    left: 20,
    right: 20,
    bottom: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    opacity: 0.06,
  },
  bar: {
    width: 4,
    height: '100%',
    backgroundColor: '#1e293b',
    borderRadius: 2,
  },
  icon: {
    fontSize: 40,
    marginBottom: 4,
  },
  statusText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1e293b',
    textAlign: 'center',
    lineHeight: 22,
  },
  backendStatusText: {
    fontSize: 12,
    color: '#475467',
    fontWeight: '600',
    textAlign: 'center',
  },
  progressTrack: {
    width: '85%',
    height: 7,
    backgroundColor: '#e2e8f0',
    borderRadius: 4,
    marginTop: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#3b82f6',
    borderRadius: 4,
  },
  subtitle: {
    fontSize: 12,
    color: '#94a3b8',
    fontWeight: '500',
  },
});
