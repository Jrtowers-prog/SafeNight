import { act, create } from 'react-test-renderer';

import { useCurrentLocation, type UseCurrentLocationState } from '@/src/hooks/useCurrentLocation';
import {
  getCurrentLocation,
  getLastKnownLocation,
  requestForegroundLocationPermission,
} from '@/src/services/location';
import { AppError } from '@/src/types/errors';

jest.mock('@/src/services/location', () => ({
  requestForegroundLocationPermission: jest.fn(),
  getLastKnownLocation: jest.fn(),
  getCurrentLocation: jest.fn(),
}));

function Probe({
  enabled,
  onUpdate,
}: {
  enabled?: boolean;
  onUpdate: (state: UseCurrentLocationState) => void;
}) {
  const state = useCurrentLocation({ enabled });

  onUpdate(state);
  return null;
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe('useCurrentLocation', () => {
  const mockRequestPermission = requestForegroundLocationPermission as jest.MockedFunction<
    typeof requestForegroundLocationPermission
  >;
  const mockGetLastKnownLocation = getLastKnownLocation as jest.MockedFunction<
    typeof getLastKnownLocation
  >;
  const mockGetCurrentLocation = getCurrentLocation as jest.MockedFunction<
    typeof getCurrentLocation
  >;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stays idle and skips location calls when disabled', async () => {
    const updates: UseCurrentLocationState[] = [];

    await act(async () => {
      create(<Probe enabled={false} onUpdate={(state) => updates.push(state)} />);
    });

    const latest = updates[updates.length - 1];
    expect(latest.status).toBe('idle');
    expect(latest.location).toBeNull();
    expect(mockRequestPermission).not.toHaveBeenCalled();
    expect(mockGetLastKnownLocation).not.toHaveBeenCalled();
    expect(mockGetCurrentLocation).not.toHaveBeenCalled();
  });

  it('marks status denied when permission is not granted', async () => {
    const updates: UseCurrentLocationState[] = [];
    mockRequestPermission.mockResolvedValue('denied' as any);

    await act(async () => {
      create(<Probe onUpdate={(state) => updates.push(state)} />);
    });
    await flush();

    const latest = updates[updates.length - 1];
    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
    expect(latest.status).toBe('denied');
    expect(latest.location).toBeNull();
    expect(latest.error).toBeNull();
  });

  it('keeps cached location when live fix fails', async () => {
    const updates: UseCurrentLocationState[] = [];
    mockRequestPermission.mockResolvedValue('granted' as any);
    mockGetLastKnownLocation.mockResolvedValue({ latitude: 51.5, longitude: -0.12 });
    mockGetCurrentLocation.mockRejectedValue(new AppError('location_unavailable', 'failed'));

    await act(async () => {
      create(<Probe onUpdate={(state) => updates.push(state)} />);
    });
    await flush();

    const latest = updates[updates.length - 1];
    expect(latest.status).toBe('ready');
    expect(latest.location).toEqual({ latitude: 51.5, longitude: -0.12 });
    expect(latest.error).toBeNull();
  });

  it('surfaces normalized error when no location is available', async () => {
    const updates: UseCurrentLocationState[] = [];
    mockRequestPermission.mockResolvedValue('granted' as any);
    mockGetLastKnownLocation.mockResolvedValue(null);
    mockGetCurrentLocation.mockRejectedValue(new Error('gps timeout'));

    await act(async () => {
      create(<Probe onUpdate={(state) => updates.push(state)} />);
    });
    await flush();

    const latest = updates[updates.length - 1];
    expect(latest.status).toBe('error');
    expect(latest.error).toBeInstanceOf(AppError);
    expect(latest.error?.code).toBe('location_unknown_error');
  });
});
