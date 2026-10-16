import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { Linking, Platform, View } from 'react-native';

import RootLayout from '@/app/_layout';
import LoginModal from '@/src/components/modals/LoginModal';
import { ChangePasswordModal } from '@/src/components/modals/ChangePasswordModal';
import { useAuth } from '@/src/hooks/useAuth';

const mockRouterReplace = jest.fn();

jest.mock('expo-router', () => ({
  Stack: jest.fn(() => null),
  router: {
    replace: (...args: any[]) => mockRouterReplace(...args),
  },
}));

jest.mock('expo-splash-screen', () => ({
  preventAutoHideAsync: jest.fn().mockResolvedValue(undefined),
  hideAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-system-ui', () => ({
  setBackgroundColorAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/hooks/useUpdateCheck', () => ({
  useUpdateCheck: jest.fn(() => ({ forceUpdate: false })),
}));

jest.mock('@/src/hooks/useAutoUpdate', () => ({
  useAutoUpdate: jest.fn(),
}));

jest.mock('@/src/services/onboarding', () => ({
  setOnboardingAccepted: jest.fn(),
}));

jest.mock('@/src/components/AnimatedSplashScreen', () => ({
  AnimatedSplashScreen: jest.fn(() => null),
}));

jest.mock('@/src/components/modals/ChangePasswordModal', () => ({
  ChangePasswordModal: jest.fn(() => null),
}));

jest.mock('@/src/components/modals/DisclaimerModal', () => jest.fn(() => null));
jest.mock('@/src/components/modals/LoginModal', () => jest.fn(() => null));
jest.mock('@/src/components/modals/WelcomeModal', () => jest.fn(() => null));
jest.mock('@/src/components/ui/ForceUpdateScreen', () => jest.fn(() => null));

jest.mock('@/src/hooks/useAuth', () => ({
  useAuth: jest.fn(),
}));

const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockLoginModal = LoginModal as unknown as jest.Mock;
const mockChangePasswordModal = ChangePasswordModal as unknown as jest.Mock;

const makeAuth = (overrides: Partial<ReturnType<typeof useAuth>> = {}) => ({
  user: null,
  isLoggedIn: false,
  isLoading: false,
  error: null,
  beginPasswordReset: jest.fn().mockResolvedValue(undefined),
  checkAuthOptions: jest.fn(),
  sendMagicLink: jest.fn(),
  signInWithPassword: jest.fn(),
  forgotPassword: jest.fn(),
  verify: jest.fn(),
  acceptDisclaimer: jest.fn(),
  refreshProfile: jest.fn(),
  updateUsername: jest.fn(),
  updateName: jest.fn(),
  changePassword: jest.fn(),
  ...overrides,
});

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

const mountedTrees: ReactTestRenderer[] = [];

const renderRoot = async () => {
  let tree: ReactTestRenderer | null = null;
  await act(async () => {
    tree = create(<RootLayout />);
  });

  if (!tree) {
    throw new Error('Failed to render RootLayout');
  }

  mountedTrees.push(tree);

  return tree;
};

const completeSplashSequence = async (tree: ReactTestRenderer) => {
  const layoutContainer = tree.root
    .findAllByType(View)
    .find((node: ReactTestInstance) => typeof node.props.onLayout === 'function');
  if (!layoutContainer) {
    throw new Error('Expected app layout container with onLayout callback');
  }

  act(() => {
    layoutContainer.props.onLayout();
  });

  act(() => {
    jest.advanceTimersByTime(3500);
  });

  await settle();
};

describe('RootLayout route flow', () => {
  const getInitialUrlSpy = jest.spyOn(Linking, 'getInitialURL');
  const addListenerSpy = jest.spyOn(Linking, 'addEventListener');

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    (Platform as { OS: string }).OS = 'ios';
    getInitialUrlSpy.mockResolvedValue(null);
    addListenerSpy.mockReturnValue({ remove: jest.fn() } as any);
    mockRouterReplace.mockReset();
    mockUseAuth.mockReturnValue(makeAuth() as ReturnType<typeof useAuth>);
  });

  afterEach(() => {
    act(() => {
      mountedTrees.splice(0).forEach((tree) => tree.unmount());
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it('opens mandatory login gate on native when splash finishes and user is logged out', async () => {
    const tree = await renderRoot();

    await completeSplashSequence(tree);

    expect(mockLoginModal).toHaveBeenCalled();
    const lastCall = mockLoginModal.mock.calls[mockLoginModal.mock.calls.length - 1][0];
    expect(lastCall.visible).toBe(true);
    expect(lastCall.dismissable).toBe(false);
  });

  it('keeps web guests out of native login gate', async () => {
    (Platform as { OS: string }).OS = 'web';

    const tree = await renderRoot();
    await completeSplashSequence(tree);

    const lastCall = mockLoginModal.mock.calls[mockLoginModal.mock.calls.length - 1][0];
    expect(lastCall.visible).toBe(false);
  });

  it('handles password reset deep link and shows reset modal after splash', async () => {
    const auth = makeAuth();
    mockUseAuth.mockReturnValue(auth as ReturnType<typeof useAuth>);
    getInitialUrlSpy.mockResolvedValue(
      'safenight://reset-password?access_token=test-token&type=recovery&refresh_token=test-refresh&expires_in=3600',
    );

    const tree = await renderRoot();
    await settle();

    expect(auth.beginPasswordReset).toHaveBeenCalledWith('test-token', 'test-refresh', 3600);

    await completeSplashSequence(tree);

    const lastChangePasswordCall =
      mockChangePasswordModal.mock.calls[mockChangePasswordModal.mock.calls.length - 1][0];
    expect(lastChangePasswordCall.visible).toBe(true);
    expect(lastChangePasswordCall.isResetFlow).toBe(true);
  });

  it('routes shared-route deep links into home params', async () => {
    getInitialUrlSpy.mockResolvedValue('safenight://share-route?token=shared-token-123');

    await renderRoot();
    await settle();

    expect(mockRouterReplace).toHaveBeenCalledWith({
      pathname: '/',
      params: { sharedRouteToken: 'shared-token-123' },
    });
  });

  it('routes share path deep links into home params', async () => {
    getInitialUrlSpy.mockResolvedValue('safenight://share/shared-token-456');

    await renderRoot();
    await settle();

    expect(mockRouterReplace).toHaveBeenCalledWith({
      pathname: '/',
      params: { sharedRouteToken: 'shared-token-456' },
    });
  });
});
