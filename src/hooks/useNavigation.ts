/**
 * useNavigation — in-app turn-by-turn walking navigation.
 *
 * Tracks the user's live GPS position, matches it to the nearest step
 * on the selected route, and provides distance/time remaining + the
 * current instruction for the UI to display.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DirectionsRoute, LatLng, NavigationStep } from '@/src/types/geo';
import * as Location from 'expo-location';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NavigationState = 'idle' | 'navigating' | 'arrived' | 'off-route';

export interface NavigationInfo {
  /** Current navigation state */
  state: NavigationState;
  /** Index of the current step the user is on */
  currentStepIndex: number;
  /** The current step instruction */
  currentStep: NavigationStep | null;
  /** The next upcoming step (for preview) */
  nextStep: NavigationStep | null;
  /** Metres from current position to the end of the current step */
  distanceToNextTurn: number;
  /** Total remaining metres on the route */
  remainingDistance: number;
  /** Total remaining seconds on the route */
  remainingDuration: number;
  /** Live user location (updated every ~2 s) */
  userLocation: LatLng | null;
  /** User heading / bearing in degrees (0 = north) */
  userHeading: number | null;
  /** Start navigation */
  start: () => void;
  /** Stop navigation */
  stop: () => void;
}

// ---------------------------------------------------------------------------
// Geo helpers
// ---------------------------------------------------------------------------

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Haversine distance in metres between two points */
const haversine = (a: LatLng, b: LatLng): number => {
  const R = 6371000;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const sin2 = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(sin2));
};

/** Bearing from A → B in degrees (0 = north, 90 = east) */
const bearing = (a: LatLng, b: LatLng): number => {
  const dLng = toRad(b.longitude - a.longitude);
  const y = Math.sin(dLng) * Math.cos(toRad(b.latitude));
  const x =
    Math.cos(toRad(a.latitude)) * Math.sin(toRad(b.latitude)) -
    Math.sin(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

type ProjectedPoint = {
  closest: LatLng;
  distanceMeters: number;
  segmentIndex: number;
  segmentT: number;
};

type RouteMetrics = {
  cumulativePathMeters: number[];
  totalPathMeters: number;
  stepEndPathMeters: number[];
};

const projectPointToSegment = (p: LatLng, a: LatLng, b: LatLng): ProjectedPoint => {
  const ax = a.longitude;
  const ay = a.latitude;
  const bx = b.longitude;
  const by = b.latitude;
  const px = p.longitude;
  const py = p.latitude;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq <= 1e-15) {
    return {
      closest: a,
      distanceMeters: haversine(p, a),
      segmentIndex: 0,
      segmentT: 0,
    };
  }

  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / lengthSq);
  const closest = {
    latitude: ay + dy * t,
    longitude: ax + dx * t,
  };

  return {
    closest,
    distanceMeters: haversine(p, closest),
    segmentIndex: 0,
    segmentT: t,
  };
};

const buildCumulativePathMeters = (path: LatLng[]): number[] => {
  const cumulative = new Array(path.length).fill(0);
  for (let i = 1; i < path.length; i++) {
    cumulative[i] = cumulative[i - 1] + haversine(path[i - 1], path[i]);
  }
  return cumulative;
};

const findNearestPathProjection = (path: LatLng[], point: LatLng): ProjectedPoint | null => {
  if (path.length === 0) return null;
  if (path.length === 1) {
    return {
      closest: path[0],
      distanceMeters: haversine(point, path[0]),
      segmentIndex: 0,
      segmentT: 0,
    };
  }

  let best: ProjectedPoint | null = null;
  for (let i = 0; i < path.length - 1; i++) {
    const projected = projectPointToSegment(point, path[i], path[i + 1]);
    const candidate: ProjectedPoint = {
      ...projected,
      segmentIndex: i,
    };
    if (!best || candidate.distanceMeters < best.distanceMeters) {
      best = candidate;
      if (candidate.distanceMeters < 5) break;
    }
  }

  return best;
};

const projectedPathMeters = (projection: ProjectedPoint, cumulativePathMeters: number[]) => {
  const segmentStartMeters = cumulativePathMeters[projection.segmentIndex] ?? 0;
  const segmentEndMeters = cumulativePathMeters[projection.segmentIndex + 1] ?? segmentStartMeters;
  return segmentStartMeters + (segmentEndMeters - segmentStartMeters) * projection.segmentT;
};

// Thresholds
const ROUTE_ARRIVAL_M = 40;  // consider arrived at destination within 40 m
const OFF_ROUTE_M = 100;     // user is off-route if > 100 m from nearest path point
const STEP_PROGRESS_HYSTERESIS_M = 15;
const FALLBACK_LOCATION_POLL_MS = 2000;
const STATIONARY_REFRESH_MS = 30_000;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export const useNavigation = (route: DirectionsRoute | null): NavigationInfo => {
  const [state, setState] = useState<NavigationState>('idle');
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [userLocation, setUserLocation] = useState<LatLng | null>(null);
  const [userHeading, setUserHeading] = useState<number | null>(null);
  const [distanceToNextTurn, setDistanceToNextTurn] = useState(0);
  const [remainingDistance, setRemainingDistance] = useState(0);
  const [remainingDuration, setRemainingDuration] = useState(0);
  const [stationaryRefreshTick, setStationaryRefreshTick] = useState(0);

  const watchRef = useRef<Location.LocationSubscription | null>(null);
  /** Separate subscription for compass/magnetometer heading (fires instantly) */
  const headingWatchRef = useRef<Location.LocationSubscription | null>(null);
  /** Whether the compass heading has been received at least once */
  const hasCompassRef = useRef(false);
  /**
   * Running EMA-smoothed heading (never emitted directly — used for jitter filtering).
   * Smoothing factor: α=0.25 → new reading gets 25% weight, history gets 75%.
   * This suppresses magnetometer noise (±1-3°) without lag on real turns.
   */
  const smoothedHeadingRef = useRef<number | null>(null);
  /**
   * Last heading value that was actually pushed into React state.
   * We only update state when the change exceeds HEADING_EMIT_THRESHOLD.
   */
  const lastEmittedHeadingRef = useRef<number | null>(null);
  const syntheticStepsRef = useRef<NavigationStep[] | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const routeMetricsRef = useRef<RouteMetrics | null>(null);
  const lastKnownPathMetersRef = useRef(0);
  const routeRef = useRef(route);
  routeRef.current = route;

  const steps = route?.steps ?? [];
  const activeSteps = syntheticStepsRef.current ?? steps;
  const currentStep = activeSteps[currentStepIndex] ?? null;
  const nextStep = activeSteps[currentStepIndex + 1] ?? null;

  // ── GPS + Compass watcher ────────────────────────────────────
  const startWatching = useCallback(async () => {
    // Clean previous watchers
    try { watchRef.current?.remove(); } catch { /* noop */ }
    try { headingWatchRef.current?.remove(); } catch { /* noop */ }
    watchRef.current = null;
    headingWatchRef.current = null;
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    hasCompassRef.current = false;

    // Ensure we have location permission (critical on web)
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        console.warn('[useNavigation] Location permission denied');
        setState('idle');
        return;
      }
    } catch (permErr) {
      console.warn('[useNavigation] Permission request failed:', permErr);
      setState('idle');
      return;
    }

    // ── Compass heading (instant — no movement required) ──────
    // watchHeadingAsync fires on every magnetometer/orientation change.
    // trueHeading is preferred (accurate), magHeading as fallback.
    // GPS heading is only used as last resort (requires physical movement).
    //
    // Stabilisation strategy:
    //   1. Low-pass EMA (α=0.12) smooths out sensor noise (±1-3° jitter).
    //      Lower α = more smoothing, slightly more lag on very slow turns
    //      but zero perceptible lag on quick/real turns.
    //   2. Dead-zone: only push to React state when change ≥ 8° so micro
    //      wobbles don't cause re-renders / map camera updates.
    //   3. Full turns (any size) are still captured immediately — the
    //      dead-zone only blocks noise, not real rotations.
    const SMOOTH_ALPHA = 0.12;
    const EMIT_THRESHOLD = 8; // degrees — ignore changes smaller than this
    try {
      const headingSub = await Location.watchHeadingAsync((h) => {
        const raw = h.trueHeading > 0 ? h.trueHeading : h.magHeading;
        if (raw < 0) return;
        hasCompassRef.current = true;

        // ── Step 1: EMA smooth (circular) ────────────────────
        let smoothed: number;
        if (smoothedHeadingRef.current === null) {
          smoothed = raw;
        } else {
          // Shortest-path delta so we interpolate through 0/360 correctly
          let d = raw - smoothedHeadingRef.current;
          while (d > 180) d -= 360;
          while (d < -180) d += 360;
          smoothed = (smoothedHeadingRef.current + d * SMOOTH_ALPHA + 360) % 360;
        }
        smoothedHeadingRef.current = smoothed;

        // ── Step 2: Dead-zone — only emit if change is meaningful ─
        if (lastEmittedHeadingRef.current === null) {
          lastEmittedHeadingRef.current = smoothed;
          setUserHeading(smoothed);
        } else {
          let delta = smoothed - lastEmittedHeadingRef.current;
          while (delta > 180) delta -= 360;
          while (delta < -180) delta += 360;
          if (Math.abs(delta) >= EMIT_THRESHOLD) {
            lastEmittedHeadingRef.current = smoothed;
            setUserHeading(smoothed);
          }
        }
      });
      headingWatchRef.current = headingSub as unknown as Location.LocationSubscription;
    } catch {
      // Compass unavailable (web, simulator) — fall back to GPS heading
    }

    // ── GPS position (used for location + heading refinement) ──
    try {
      const sub = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          timeInterval: 1000,
          distanceInterval: 1,
        },
        (loc) => {
          const pos: LatLng = {
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
          };
          setUserLocation(pos);
          // Use GPS heading only when compass hasn't fired yet (or unavailable)
          if (!hasCompassRef.current && loc.coords.heading != null && loc.coords.heading >= 0) {
            setUserHeading(loc.coords.heading);
          }
        },
      );
      watchRef.current = sub;

      // Fallback polling keeps progress/ETA moving if platform watcher stalls.
      pollTimerRef.current = setInterval(() => {
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
          .then((loc) => {
            const pos: LatLng = {
              latitude: loc.coords.latitude,
              longitude: loc.coords.longitude,
            };
            setUserLocation((prev) => {
              if (!prev || haversine(prev, pos) >= 1.5) return pos;
              return prev;
            });
            if (!hasCompassRef.current && loc.coords.heading != null && loc.coords.heading >= 0) {
              setUserHeading(loc.coords.heading);
            }
          })
          .catch(() => {
            // ignore transient polling failures
          });
      }, FALLBACK_LOCATION_POLL_MS);
    } catch (watchErr) {
      console.warn('[useNavigation] watchPositionAsync failed:', watchErr);
      setState('idle');
    }
  }, []);

  const stopWatching = useCallback(() => {
    try { watchRef.current?.remove(); } catch { /* expo-location web compat */ }
    try { headingWatchRef.current?.remove(); } catch { /* expo-location web compat */ }
    watchRef.current = null;
    headingWatchRef.current = null;
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    hasCompassRef.current = false;
    smoothedHeadingRef.current = null;
    lastEmittedHeadingRef.current = null;
  }, []);

  // ── Start / Stop ─────────────────────────────────────────────
  const start = useCallback(() => {
    if (!route) {
      console.warn('[useNavigation] No route provided');
      return;
    }
    if (steps.length === 0) {
      console.warn('[useNavigation] Route has no steps — starting with path-only navigation');
      // Build synthetic steps from the route path so navigation still works
      const syntheticSteps: NavigationStep[] = [];
      const pathPts = route.path;
      if (pathPts.length >= 2) {
        for (let i = 0; i < pathPts.length - 1; i++) {
          syntheticSteps.push({
            instruction: i === 0 ? 'Start walking' : 'Continue',
            distanceMeters: haversine(pathPts[i], pathPts[i + 1]),
            durationSeconds: 0,
            startLocation: pathPts[i],
            endLocation: pathPts[i + 1],
          });
        }
        syntheticStepsRef.current = syntheticSteps;
      }
    } else {
      syntheticStepsRef.current = null;
    }

    const navSteps = syntheticStepsRef.current ?? route.steps ?? [];
    const cumulativePathMeters = buildCumulativePathMeters(route.path);
    const totalPathMeters = cumulativePathMeters[cumulativePathMeters.length - 1] ?? route.distanceMeters;
    const stepEndPathMeters: number[] = [];

    for (let i = 0; i < navSteps.length; i++) {
      const projection = findNearestPathProjection(route.path, navSteps[i].endLocation);
      if (!projection) {
        stepEndPathMeters.push(totalPathMeters);
        continue;
      }
      const stepEndMeters = projectedPathMeters(projection, cumulativePathMeters);
      const prevMeters = stepEndPathMeters[stepEndPathMeters.length - 1] ?? 0;
      stepEndPathMeters.push(Math.max(prevMeters, stepEndMeters));
    }

    routeMetricsRef.current = {
      cumulativePathMeters,
      totalPathMeters,
      stepEndPathMeters,
    };
    lastKnownPathMetersRef.current = 0;

    setCurrentStepIndex(0);
    setRemainingDistance(route.distanceMeters);
    setRemainingDuration(route.durationSeconds);
    setState('navigating');
    startWatching();
  }, [route, steps.length, startWatching]);

  const stop = useCallback(() => {
    setState('idle');
    setCurrentStepIndex(0);
    setDistanceToNextTurn(0);
    setRemainingDistance(0);
    setRemainingDuration(0);
    syntheticStepsRef.current = null;
    routeMetricsRef.current = null;
    lastKnownPathMetersRef.current = 0;
    stopWatching();
  }, [stopWatching]);

  // ── Step matching on location update ─────────────────────────
  useEffect(() => {
    if (state !== 'navigating' && state !== 'off-route') return;
    if (!userLocation || !routeRef.current) return;
    const r = routeRef.current;
    const s = syntheticStepsRef.current ?? r.steps ?? [];
    if (s.length === 0) return;
    const metrics = routeMetricsRef.current;
    if (!metrics || r.path.length === 0) return;

    const projection = findNearestPathProjection(r.path, userLocation);
    if (!projection) return;

    const rawPathMeters = projectedPathMeters(projection, metrics.cumulativePathMeters);
    const userPathMeters = Math.max(lastKnownPathMetersRef.current, rawPathMeters);
    lastKnownPathMetersRef.current = userPathMeters;

    const remainingPathMeters = Math.max(0, metrics.totalPathMeters - userPathMeters);

    // Check if we've arrived at destination
    const dest = r.path[r.path.length - 1];
    if (dest && (haversine(userLocation, dest) < ROUTE_ARRIVAL_M || remainingPathMeters < ROUTE_ARRIVAL_M)) {
      setState('arrived');
      stopWatching();
      return;
    }

    if (projection.distanceMeters > OFF_ROUTE_M) {
      setState('off-route');
      // Don't stop — keep tracking so they can get back on route
    } else if (state === 'off-route') {
      setState('navigating');
    }

    // Pick current step from route progress (prevents stale instructions).
    let computedIndex = s.length - 1;
    for (let i = 0; i < metrics.stepEndPathMeters.length; i++) {
      if (userPathMeters < metrics.stepEndPathMeters[i] - STEP_PROGRESS_HYSTERESIS_M) {
        computedIndex = i;
        break;
      }
    }
    const idx = Math.max(currentStepIndex, computedIndex);
    if (idx !== currentStepIndex && idx >= 0 && idx < s.length) {
      setCurrentStepIndex(idx);
    }

    const stepEndMeters = metrics.stepEndPathMeters[idx] ?? metrics.totalPathMeters;
    const dToTurn = Math.max(0, stepEndMeters - userPathMeters);
    setDistanceToNextTurn(Math.round(dToTurn));

    // Remaining route distance from current projected position to destination.
    const remDist = remainingPathMeters;
    setRemainingDistance(Math.round(remDist));

    // Walking ETA: compute from distance at average walking speed (1.4 m/s ≈ 5 km/h)
    const WALKING_SPEED = 1.4;
    setRemainingDuration(Math.round(remDist / WALKING_SPEED));

    // Update heading toward next step end
    if (!userHeading && s[idx]) {
      setUserHeading(bearing(userLocation, s[idx].endLocation));
    }
  }, [userLocation, state, currentStepIndex, stationaryRefreshTick, stopWatching]);

  useEffect(() => {
    if (state !== 'navigating' && state !== 'off-route') return;
    const timer = setInterval(() => {
      setStationaryRefreshTick((prev) => prev + 1);
    }, STATIONARY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [state]);

  // Cleanup on unmount
  useEffect(() => () => stopWatching(), [stopWatching]);

  // Reset when route changes
  useEffect(() => {
    if (state !== 'idle') stop();
  }, [route?.id]);

  return {
    state,
    currentStepIndex,
    currentStep,
    nextStep,
    distanceToNextTurn,
    remainingDistance,
    remainingDuration,
    userLocation,
    userHeading,
    start,
    stop,
  };
};
