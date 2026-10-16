import AsyncStorage from '@react-native-async-storage/async-storage';

import { createRouteShareLink, resolveRouteShareLink } from '@/src/services/shareRoute';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
}));

describe('shareRoute service', () => {
  beforeEach(() => {
    jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates a route share link with auth header when token exists', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('token-abc');
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: 'share-1', shareUrl: 'https://safe/link', expiresAt: '2099-01-01' }),
    } as Response);

    const created = await createRouteShareLink({
      destinationName: 'Central Station',
      destination: { latitude: 50.3, longitude: -4.1 },
      routePath: [{ latitude: 50.3, longitude: -4.1 }],
    });

    expect(created.token).toBe('share-1');
    expect(created.shareUrl).toBe('https://safe/link');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/shares'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer token-abc' }),
      }),
    );
  });

  it('resolves a share link token', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        token: 'share-1',
        destinationName: 'Central Station',
        destination: { latitude: 50.3, longitude: -4.1 },
        routePath: [{ latitude: 50.31, longitude: -4.11 }],
        expiresAt: '2099-01-01',
        createdAt: '2099-01-01',
      }),
    } as Response);

    const resolved = await resolveRouteShareLink('share-1');
    expect(resolved.token).toBe('share-1');
    expect(resolved.routePath?.[0].latitude).toBeCloseTo(50.31, 5);
  });

  it('throws on non-ok create response', async () => {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce(null);
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'missing auth' }),
    } as Response);

    await expect(createRouteShareLink({})).rejects.toThrow('missing auth');
  });
});
