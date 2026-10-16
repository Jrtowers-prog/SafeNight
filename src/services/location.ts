import * as Location from 'expo-location';

import { AppError } from '@/src/types/errors';
import type { LatLng } from '@/src/types/geo';

export type LocationPermissionStatus = Location.PermissionStatus;

const toLatLng = (coords: Location.LocationObjectCoords): LatLng => ({
  latitude: coords.latitude,
  longitude: coords.longitude,
});

export const requestForegroundLocationPermission = async (): Promise<LocationPermissionStatus> => {
  const { status } = await Location.requestForegroundPermissionsAsync();

  return status;
};

export const getLastKnownLocation = async (): Promise<LatLng | null> => {
  try {
    const position = await Location.getLastKnownPositionAsync();
    if (!position?.coords) return null;
    return toLatLng(position.coords);
  } catch {
    return null;
  }
};

export const getCurrentLocation = async (): Promise<LatLng> => {
  try {
    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });

    return toLatLng(position.coords);
  } catch (error) {
    throw new AppError('location_unavailable', 'Unable to fetch current location', error);
  }
};
