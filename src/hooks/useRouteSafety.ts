import { useCallback, useEffect, useRef, useState } from 'react';

import {
  fetchSafetyMapData,
  type RoadLabel,
  type RouteSegment,
  type SafetyMapResult,
  type SafetyMarker,
  type SafetyProgressCb,
} from '@/src/services/safetyMapData';
import { AppError } from '@/src/types/errors';
import type { DirectionsRoute } from '@/src/types/geo';

export type SafetyStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface UseRouteSafetyState {
  status: SafetyStatus;
  markers: SafetyMarker[];
  routeSegments: RouteSegment[];
  roadLabels: RoadLabel[];
  result: SafetyMapResult | null;
  error: AppError | null;
  progressMessage: string;
  progressPercent: number;
  refresh: () => Promise<void>;
}

export const useRouteSafety = (route: DirectionsRoute | null): UseRouteSafetyState => {
  const [status, setStatus] = useState<SafetyStatus>('idle');
  const [result, setResult] = useState<SafetyMapResult | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [progressMessage, setProgressMessage] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const requestIdRef = useRef(0);

  // Immediately clear stale data when the route identity changes
  const routeId = route?.id ?? null;
  useEffect(() => {
    setResult(null);
    setError(null);
    setProgressMessage('');
    setProgressPercent(0);
    setStatus(routeId ? 'loading' : 'idle');
  }, [routeId]);

  const refresh = useCallback(async () => {
    if (!route || route.path.length < 2) {
      setResult(null);
      setStatus('idle');
      setError(null);
      setProgressMessage('');
      setProgressPercent(0);
      return;
    }

    setStatus('loading');
    setError(null);
    setProgressMessage('🔍 Analysing route safety…');
    setProgressPercent(0);

    const onProgress: SafetyProgressCb = (msg, pct) => {
      setProgressMessage(msg);
      setProgressPercent(pct);
    };

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    try {
      const data = await withTimeout(
        fetchSafetyMapData(route.path, onProgress, route.distanceMeters),
        20000,
      );
      if (requestIdRef.current !== requestId) {
        return;
      }
      setResult(data);
      setStatus('ready');
      setProgressMessage('✅ Safety analysis complete!');
      setProgressPercent(100);
    } catch (caught) {
      if (requestIdRef.current !== requestId) {
        return;
      }
      const err =
        caught instanceof AppError
          ? caught
          : new AppError('safety_error', 'Unable to fetch safety data', caught);
      setError(err);
      setStatus('error');
      setProgressMessage('❌ Unable to complete safety analysis');
    }
  }, [route]);

  useEffect(() => {
    refresh().catch(() => {
      setStatus('error');
      setError(new AppError('safety_refresh_error', 'Unable to refresh safety data'));
    });
  }, [refresh]);

  return {
    status,
    markers: result?.markers ?? [],
    routeSegments: result?.routeSegments ?? [],
    roadLabels: result?.roadLabels ?? [],
    result,
    error,
    progressMessage,
    progressPercent,
    refresh,
  };
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new AppError('safety_timeout', 'Safety analysis timed out'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};
