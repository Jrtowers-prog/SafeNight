import type { LatLng } from '@/src/types/geo';

export type MoveToCurrentLocationDeps = {
  location: LatLng | null;
  refreshLocation: () => Promise<void> | void;
  panToLocation: (location: LatLng) => void;
  setIsFindingCurrentLocation: (value: boolean) => void;
  setIsAtCurrentLocation?: (value: boolean) => void;
};

export function moveToCurrentLocation({
  location,
  refreshLocation,
  panToLocation,
  setIsFindingCurrentLocation,
  setIsAtCurrentLocation,
}: MoveToCurrentLocationDeps): boolean {
  setIsFindingCurrentLocation(true);
  void refreshLocation();

  if (!location) {
    setIsAtCurrentLocation?.(false);
    return false;
  }

  panToLocation(location);
  setIsAtCurrentLocation?.(true);
  return true;
}