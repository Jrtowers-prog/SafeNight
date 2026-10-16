import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useNavigation, type NavigationInfo } from '@/src/hooks/useNavigation';
import type { DirectionsRoute } from '@/src/types/geo';
import * as Location from 'expo-location';

jest.mock('expo-location', () => ({
  Accuracy: {
    Balanced: 'Balanced',
    BestForNavigation: 'BestForNavigation',
  },
  requestForegroundPermissionsAsync: jest.fn(),
  watchHeadingAsync: jest.fn(),
  watchPositionAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
}));

function Probe({
  route,
  onUpdate,
}: {
  route: DirectionsRoute | null;
  onUpdate: (state: NavigationInfo) => void;
}) {
  const nav = useNavigation(route);
  onUpdate(nav);
  return null;
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

const createRoute = (): DirectionsRoute => ({
  id: 'route-1',
  distanceMeters: 220,
  durationSeconds: 160,
  encodedPolyline: 'abc',
  path: [
    { latitude: 51.5, longitude: -0.12 },
    { latitude: 51.5, longitude: -0.119 },
    { latitude: 51.5, longitude: -0.118 },
  ],
  steps: [
    {
      instruction: 'Head east',
      distanceMeters: 110,
      durationSeconds: 80,
      startLocation: { latitude: 51.5, longitude: -0.12 },
      endLocation: { latitude: 51.5, longitude: -0.119 },
      maneuver: 'straight',
    },
    {
      instruction: 'Continue east',
      distanceMeters: 110,
      durationSeconds: 80,
      startLocation: { latitude: 51.5, longitude: -0.119 },
      endLocation: { latitude: 51.5, longitude: -0.118 },
      maneuver: 'straight',
    },
  ],
});

describe('useNavigation', () => {
  const mockRequestPermission = Location.requestForegroundPermissionsAsync as jest.MockedFunction<
    typeof Location.requestForegroundPermissionsAsync
  >;
  const mockWatchHeading = Location.watchHeadingAsync as jest.MockedFunction<
    typeof Location.watchHeadingAsync
  >;
  const mockWatchPosition = Location.watchPositionAsync as jest.MockedFunction<
    typeof Location.watchPositionAsync
  >;
  const mockGetCurrentPosition = Location.getCurrentPositionAsync as jest.MockedFunction<
    typeof Location.getCurrentPositionAsync
  >;

  let renderer: ReactTestRenderer | null = null;
  let latest: NavigationInfo;
  let positionCallback: ((loc: any) => void) | null;
  let removePositionWatch: jest.Mock;
  let removeHeadingWatch: jest.Mock;

  const mount = async (route: DirectionsRoute | null) => {
    await act(async () => {
      renderer = create(
        <Probe
          route={route}
          onUpdate={(state) => {
            latest = state;
          }}
        />,
      );
    });
  };

  const emitPosition = async (latitude: number, longitude: number, heading?: number) => {
    await act(async () => {
      positionCallback?.({
        coords: {
          latitude,
          longitude,
          heading: heading ?? -1,
        },
      });
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    removePositionWatch = jest.fn();
    removeHeadingWatch = jest.fn();
    positionCallback = null;

    mockRequestPermission.mockResolvedValue({ status: 'granted' } as any);
    mockWatchHeading.mockResolvedValue({ remove: removeHeadingWatch } as any);
    mockWatchPosition.mockImplementation(async (_opts, callback: any) => {
      positionCallback = callback;
      return { remove: removePositionWatch } as any;
    });
    mockGetCurrentPosition.mockResolvedValue({
      coords: {
        latitude: 51.5,
        longitude: -0.12,
        heading: 90,
      },
    } as any);
  });

  afterEach(async () => {
    if (renderer) {
      await act(async () => {
        renderer?.unmount();
      });
      renderer = null;
    }
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('stays idle and does not start watchers when no route is provided', async () => {
    await mount(null);

    await act(async () => {
      latest.start();
    });
    await flush();

    expect(latest.state).toBe('idle');
    expect(mockRequestPermission).not.toHaveBeenCalled();
    expect(mockWatchPosition).not.toHaveBeenCalled();
  });

  it('returns to idle when foreground location permission is denied', async () => {
    mockRequestPermission.mockResolvedValue({ status: 'denied' } as any);
    await mount(createRoute());

    await act(async () => {
      latest.start();
    });
    await flush();

    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
    expect(latest.state).toBe('idle');
    expect(mockWatchPosition).not.toHaveBeenCalled();
  });

  it('starts navigating and advances to the next step as user progresses', async () => {
    await mount(createRoute());

    await act(async () => {
      latest.start();
    });
    await flush();

    expect(latest.state).toBe('navigating');
    expect(latest.currentStepIndex).toBe(0);

    await emitPosition(51.5, -0.11905, 90);

    expect(latest.state).toBe('navigating');
    expect(latest.currentStepIndex).toBe(1);
    expect(latest.remainingDistance).toBeGreaterThan(0);
    expect(latest.remainingDuration).toBeGreaterThan(0);
  });

  it('marks navigation as off-route when user drifts far from route', async () => {
    await mount(createRoute());

    await act(async () => {
      latest.start();
    });
    await flush();

    await emitPosition(51.502, -0.121, 45);

    expect(latest.state).toBe('off-route');
  });

  it('recovers from off-route back to navigating once user returns to route', async () => {
    await mount(createRoute());

    await act(async () => {
      latest.start();
    });
    await flush();

    await emitPosition(51.502, -0.121, 20);
    expect(latest.state).toBe('off-route');

    await emitPosition(51.5, -0.1196, 90);
    expect(latest.state).toBe('navigating');
  });

  it('marks arrived and stops watchers when user reaches destination', async () => {
    await mount(createRoute());

    await act(async () => {
      latest.start();
    });
    await flush();

    await emitPosition(51.5, -0.11801, 90);

    expect(latest.state).toBe('arrived');
    expect(removePositionWatch).toHaveBeenCalled();
    expect(removeHeadingWatch).toHaveBeenCalled();
  });

  it('builds synthetic steps when route contains only path coordinates', async () => {
    const route = createRoute();
    await mount({ ...route, steps: [] });

    await act(async () => {
      latest.start();
    });
    await flush();

    expect(latest.state).toBe('navigating');
    expect(latest.currentStep).not.toBeNull();
    expect(latest.currentStep?.instruction).toBe('Start walking');
    expect(latest.nextStep?.instruction).toBe('Continue');
  });

  it('stops and resets navigation when route id changes mid-navigation', async () => {
    const route = createRoute();
    await mount(route);

    await act(async () => {
      latest.start();
    });
    await flush();

    expect(latest.state).toBe('navigating');

    await act(async () => {
      renderer?.update(
        <Probe
          route={{ ...route, id: 'route-2' }}
          onUpdate={(state) => {
            latest = state;
          }}
        />,
      );
    });

    expect(latest.state).toBe('idle');
    expect(latest.currentStepIndex).toBe(0);
    expect(latest.remainingDistance).toBe(0);
    expect(removePositionWatch).toHaveBeenCalled();
  });

  it('polls fallback location updates while navigating', async () => {
    await mount(createRoute());

    await act(async () => {
      latest.start();
    });
    await flush();

    await act(async () => {
      jest.advanceTimersByTime(2000);
      await Promise.resolve();
    });

    expect(mockGetCurrentPosition).toHaveBeenCalled();
  });
});
