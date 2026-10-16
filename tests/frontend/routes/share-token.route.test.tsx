import React from 'react';
import { act, create } from 'react-test-renderer';

import SharedRoutePreviewPage from '@/app/share/[token]';
import { resolveRouteShareLink } from '@/src/services/shareRoute';

const mockReplace = jest.fn();

jest.mock('expo-router', () => ({
  useLocalSearchParams: jest.fn(() => ({ token: 'token-abc' })),
  useRouter: jest.fn(() => ({ replace: (...args: any[]) => mockReplace(...args) })),
}));

jest.mock('@/src/components/seo/PageHead', () => ({
  PageHead: jest.fn(() => null),
}));

jest.mock('@/src/services/shareRoute', () => ({
  resolveRouteShareLink: jest.fn(),
}));

const mockResolveRouteShareLink = resolveRouteShareLink as jest.MockedFunction<typeof resolveRouteShareLink>;

describe('Shared route preview page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads shared route details and renders destination info', async () => {
    mockResolveRouteShareLink.mockResolvedValueOnce({
      token: 'token-abc',
      destinationName: 'Plymouth Station',
      destination: { latitude: 50.3755, longitude: -4.1427 },
      routePath: [{ latitude: 50.3755, longitude: -4.1427 }],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });

    let tree: any;
    await act(async () => {
      tree = create(<SharedRoutePreviewPage />);
      await Promise.resolve();
    });

    const root = tree.root;
    expect(mockResolveRouteShareLink).toHaveBeenCalledWith('token-abc');
    expect(root.findAllByProps({ children: 'Plymouth Station' }).length).toBeGreaterThan(0);
  });

  it('navigates to Home with shared route token on continue button', async () => {
    mockResolveRouteShareLink.mockResolvedValueOnce({
      token: 'token-abc',
      destinationName: 'Any place',
      destination: { latitude: 50.37, longitude: -4.14 },
      routePath: [],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });

    let tree: any;
    await act(async () => {
      tree = create(<SharedRoutePreviewPage />);
      await Promise.resolve();
    });

    const continueButton = tree.root.findByProps({
      accessibilityLabel: 'Continue in SafeNight web',
    });

    act(() => {
      continueButton.props.onPress();
    });

    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/',
      params: { sharedRouteToken: 'token-abc' },
    });
  });
});
