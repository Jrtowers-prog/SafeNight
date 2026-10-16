import { moveToCurrentLocation } from '@/src/utils/currentLocation';

describe('moveToCurrentLocation', () => {
  it('refreshes location and pans immediately when a location is already available', () => {
    const refreshLocation = jest.fn();
    const panToLocation = jest.fn();
    const setIsFindingCurrentLocation = jest.fn();
    const setIsAtCurrentLocation = jest.fn();

    const moved = moveToCurrentLocation({
      location: { latitude: 51.5, longitude: -0.12 },
      refreshLocation,
      panToLocation,
      setIsFindingCurrentLocation,
      setIsAtCurrentLocation,
    });

    expect(moved).toBe(true);
    expect(setIsFindingCurrentLocation).toHaveBeenCalledWith(true);
    expect(refreshLocation).toHaveBeenCalledTimes(1);
    expect(panToLocation).toHaveBeenCalledWith({ latitude: 51.5, longitude: -0.12 });
    expect(setIsAtCurrentLocation).toHaveBeenCalledWith(true);
  });

  it('still refreshes location when no fix is available yet', () => {
    const refreshLocation = jest.fn();
    const panToLocation = jest.fn();
    const setIsFindingCurrentLocation = jest.fn();
    const setIsAtCurrentLocation = jest.fn();

    const moved = moveToCurrentLocation({
      location: null,
      refreshLocation,
      panToLocation,
      setIsFindingCurrentLocation,
      setIsAtCurrentLocation,
    });

    expect(moved).toBe(false);
    expect(setIsFindingCurrentLocation).toHaveBeenCalledWith(true);
    expect(refreshLocation).toHaveBeenCalledTimes(1);
    expect(panToLocation).not.toHaveBeenCalled();
    expect(setIsAtCurrentLocation).toHaveBeenCalledWith(false);
  });
});