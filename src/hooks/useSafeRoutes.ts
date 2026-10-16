/**
 * useSafeRoutes.ts — Hook for safety-first pathfinding.
 *
 * Replaces the old useDirections + useAllRoutesSafety combo with a single
 * hook that calls the backend /api/safe-routes endpoint.
 *
 * The backend builds an OSM walking graph, scores every edge with lighting,
 * road hierarchy, crime, open places, and foot-traffic factors, then runs
 * modified Dijkstra to return 3–5 safety-ranked routes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchSafeRoutes,
  type SafeRoute,
  type SafeRoutesResponse,
  type SafetyLevel,
} from '@/src/services/safeRoutes';
import { AppError } from '@/src/types/errors';
import type { LatLng } from '@/src/types/geo';
import { LimitError } from '@/src/types/limitError';

/** Round to 4 decimal places (~11 m) to avoid jitter re-fetches */
const round4 = (n: number) => Math.round(n * 10000) / 10000;

// ── Public types ────────────────────────────────────────────────────────────

export type SafeRoutesStatus = 'idle' | 'loading' | 'error' | 'ready';

export interface UseSafeRoutesState {
  status: SafeRoutesStatus;
  /** All returned routes, sorted safest-first */
  routes: SafeRoute[];
  /** The single safest route (first in array) */
  safestRoute: SafeRoute | null;
  /** Index of the currently selected route */
  selectedIndex: number;
  /** Select a route by index */
  selectRoute: (index: number) => void;
  /** Error, if any */
  error: AppError | null;
  /** True if destination is out of 20 km range */
  outOfRange: boolean;
  /** Human-readable message for out-of-range errors */
  outOfRangeMessage: string;
  /** Metadata about the computation (timing, data quality, etc.) */
  meta: SafeRoutesResponse['meta'] | null;
  /** Re-fetch routes */
  refresh: () => Promise<void>;
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useSafeRoutes(
  origin: LatLng | null,
  destination: LatLng | null,
  subscriptionTier: string = 'free',
  maxDistanceKmOverride?: number,
  waypoint?: LatLng | null,
  safetyLevel: SafetyLevel = 'extra',
): UseSafeRoutesState {
  const [status, setStatus] = useState<SafeRoutesStatus>('idle');
  const [routes, setRoutes] = useState<SafeRoute[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState<AppError | null>(null);
  const [outOfRange, setOutOfRange] = useState(false);
  const [outOfRangeMessage, setOutOfRangeMessage] = useState('');
  const [meta, setMeta] = useState<SafeRoutesResponse['meta'] | null>(null);
  const cancelRef = useRef(0);

  // Stabilise coordinate references so the effect doesn't re-fire on every render
  const oLat = origin ? round4(origin.latitude) : null;
  const oLng = origin ? round4(origin.longitude) : null;
  const dLat = destination ? round4(destination.latitude) : null;
  const dLng = destination ? round4(destination.longitude) : null;
  const wLat = waypoint ? round4(waypoint.latitude) : null;
  const wLng = waypoint ? round4(waypoint.longitude) : null;

  const stableOrigin = useMemo<LatLng | null>(
    () => (oLat != null && oLng != null ? { latitude: oLat, longitude: oLng } : null),
    [oLat, oLng],
  );
  const stableDest = useMemo<LatLng | null>(
    () => (dLat != null && dLng != null ? { latitude: dLat, longitude: dLng } : null),
    [dLat, dLng],
  );
  const stableWaypoint = useMemo<LatLng | null>(
    () => (wLat != null && wLng != null ? { latitude: wLat, longitude: wLng } : null),
    [wLat, wLng],
  );

  const refresh = useCallback(async () => {
    if (!stableOrigin || !stableDest) {
      setRoutes([]);
      setStatus('idle');
      setError(null);
      setOutOfRange(false);
      setOutOfRangeMessage('');
      setMeta(null);
      return;
    }

    const batchId = ++cancelRef.current;
    setStatus('loading');
    setRoutes([]);           // clear old routes so the sheet resets
    setSelectedIndex(0);
    setMeta(null);
    setError(null);
    setOutOfRange(false);
    setOutOfRangeMessage('');

    try {
      console.log(
        `[useSafeRoutes] 🔍 Fetching safe routes: ` +
          `${stableOrigin.latitude.toFixed(4)},${stableOrigin.longitude.toFixed(4)} → ` +
          `${stableDest.latitude.toFixed(4)},${stableDest.longitude.toFixed(4)}`,
      );

      const result = await fetchSafeRoutes(stableOrigin, stableDest, subscriptionTier, maxDistanceKmOverride, stableWaypoint, safetyLevel);

      if (cancelRef.current !== batchId) return; // stale

      setRoutes(result.routes);
      setSelectedIndex(0); // safest route is first
      setMeta(result.meta);
      setStatus('ready');

      console.log(
        `[useSafeRoutes] ✅ ${result.routes.length} safe routes — ` +
          `safest: ${result.routes[0]?.safety?.score}/100, ` +
          `compute: ${result.meta?.computeTimeMs}ms`,
      );
    } catch (caught) {
      if (cancelRef.current !== batchId) return;

      // Limit errors are handled by the global modal — don't treat as route error
      if (caught instanceof LimitError) {
        setStatus('idle');
        return;
      }

      const appError =
        caught instanceof AppError
          ? caught
          : new AppError('safe_routes_error', 'Unable to compute safe routes', caught);

      if (appError.code === 'DESTINATION_OUT_OF_RANGE') {
        setOutOfRange(true);
        setOutOfRangeMessage(appError.message);
      } else if (appError.code === 'NO_ROUTE_FOUND') {
        setOutOfRange(false);
        setOutOfRangeMessage('');
      } else if (appError.code === 'NO_NEARBY_ROAD') {
        setOutOfRange(false);
        setOutOfRangeMessage('');
      }

      setError(appError);
      setStatus('error');
    }
  }, [stableOrigin, stableDest, stableWaypoint, subscriptionTier, maxDistanceKmOverride, safetyLevel]);

  useEffect(() => {
    refresh().catch(() => {
      setStatus('error');
    });
    return () => {
      cancelRef.current++; // cancel on unmount
    };
  }, [refresh]);

  const selectRoute = useCallback(
    (index: number) => {
      if (index >= 0 && index < routes.length) {
        setSelectedIndex(index);
      }
    },
    [routes.length],
  );

  return {
    status,
    routes,
    safestRoute: routes.length > 0 ? routes[0] : null,
    selectedIndex,
    selectRoute,
    error,
    outOfRange,
    outOfRangeMessage,
    meta,
    refresh,
  };
}
