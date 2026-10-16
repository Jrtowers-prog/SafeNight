import { useCallback, useEffect, useState } from 'react';

import {
    getCurrentLocation,
  getLastKnownLocation,
    requestForegroundLocationPermission,
} from '@/src/services/location';
import { AppError } from '@/src/types/errors';
import type { LatLng } from '@/src/types/geo';

export type LocationStatus = 'idle' | 'loading' | 'denied' | 'error' | 'ready';

export type UseCurrentLocationState = {
  status: LocationStatus;
  location: LatLng | null;
  error: AppError | null;
  refresh: () => Promise<void>;
};

export const useCurrentLocation = (options?: {
  enabled?: boolean;
}): UseCurrentLocationState => {
  const isEnabled = options?.enabled ?? true;
  const [status, setStatus] = useState<LocationStatus>('idle');
  const [location, setLocation] = useState<LatLng | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  const refresh = useCallback(async () => {
    if (!isEnabled) {
      setStatus('idle');
      setError(null);
      return;
    }

    setStatus('loading');
    setError(null);

    const permissionStatus = await requestForegroundLocationPermission();

    if (permissionStatus !== 'granted') {
      setStatus('denied');
      return;
    }

    const cachedLocation = await getLastKnownLocation();
    if (cachedLocation) {
      setLocation(cachedLocation);
      setStatus('ready');
    }

    try {
      const currentLocation = await getCurrentLocation();
      setLocation(currentLocation);
      setStatus('ready');
    } catch (caught) {
      if (cachedLocation) {
        // Keep app usable with cached coordinates if live GPS fix is delayed/failed.
        return;
      }

      const normalizedError =
        caught instanceof AppError
          ? caught
          : new AppError('location_unknown_error', 'Unknown location error', caught);

      setError(normalizedError);
      setStatus('error');
    }
  }, [isEnabled]);

  useEffect(() => {
    if (!isEnabled) {
      return;
    }

    refresh().catch(() => {
      setStatus('error');
      setError(new AppError('location_refresh_error', 'Unable to refresh location'));
    });
  }, [refresh, isEnabled]);

  return {
    status,
    location,
    error,
    refresh,
  };
};
