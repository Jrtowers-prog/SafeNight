import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { PageHead } from '@/src/components/seo/PageHead';
import { resolveRouteShareLink, type ShareRouteResolveResponse } from '@/src/services/shareRoute';

export default function SharedRoutePreviewPage() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = useMemo(() => {
    const raw = params.token;
    return Array.isArray(raw) ? raw[0] : raw;
  }, [params.token]);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [share, setShare] = useState<ShareRouteResolveResponse | null>(null);

  useEffect(() => {
    if (!token) {
      setError('Share token missing.');
      setIsLoading(false);
      return;
    }

    let active = true;
    setIsLoading(true);
    setError(null);

    resolveRouteShareLink(token)
      .then((resolved) => {
        if (!active) return;
        setShare(resolved);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Unable to load shared route');
      })
      .finally(() => {
        if (!active) return;
        setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [token]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    if (isLoading || error || !share || !token) return;

    const deepLink = `safenight://share-route?token=${encodeURIComponent(token)}`;

    try {
      window.location.href = deepLink;
    } catch {
      // Ignore browser-level deep-link failures and continue with web fallback.
    }

    const fallbackTimer = setTimeout(() => {
      router.replace({ pathname: '/', params: { sharedRouteToken: token } });
    }, 900);

    return () => {
      clearTimeout(fallbackTimer);
    };
  }, [error, isLoading, router, share, token]);

  const openInApp = () => {
    if (!token) return;
    if (Platform.OS === 'web') {
      window.location.href = `safenight://share-route?token=${encodeURIComponent(token)}`;
      return;
    }
    router.replace({ pathname: '/', params: { sharedRouteToken: token } });
  };

  const continueOnWeb = () => {
    if (!token) {
      router.replace('/');
      return;
    }
    router.replace({ pathname: '/', params: { sharedRouteToken: token } });
  };

  return (
    <View style={styles.container}>
      <PageHead path="/share/[token]" title="Shared Safe Route" />

      <View style={styles.card}>
        <View style={styles.headerRow}>
          <Ionicons name="shield-checkmark" size={24} color="#1570ef" />
          <Text style={styles.title}>Shared Safe Route</Text>
        </View>

        {isLoading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="small" color="#1570ef" />
            <Text style={styles.loadingText}>Loading route preview…</Text>
          </View>
        ) : null}

        {!isLoading && error ? (
          <View style={styles.errorWrap}>
            <Text style={styles.errorTitle}>Link unavailable</Text>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        {!isLoading && !error && share ? (
          <View style={styles.infoWrap}>
            <Text style={styles.placeName} numberOfLines={2}>
              {share.destinationName || 'Shared destination'}
            </Text>
            {share.destination ? (
              <Text style={styles.metaText}>
                {share.destination.latitude.toFixed(5)}, {share.destination.longitude.toFixed(5)}
              </Text>
            ) : null}
            <Text style={styles.metaText}>Expires: {new Date(share.expiresAt).toLocaleString()}</Text>
            {!!share.routePath?.length && (
              <Text style={styles.metaText}>Route points: {share.routePath.length}</Text>
            )}
          </View>
        ) : null}

        <View style={styles.actions}>
          <Pressable
            style={styles.primaryButton}
            onPress={openInApp}
            accessibilityRole="button"
            accessibilityLabel="Open route in SafeNight app"
          >
            <Ionicons name="phone-portrait-outline" size={16} color="#ffffff" />
            <Text style={styles.primaryButtonText}>Open in app</Text>
          </Pressable>

          <Pressable
            style={styles.secondaryButton}
            onPress={continueOnWeb}
            accessibilityRole="button"
            accessibilityLabel="Continue in SafeNight web"
          >
            <Text style={styles.secondaryButtonText}>Continue on web</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#f7fafc',
  },
  card: {
    width: '100%',
    maxWidth: 520,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#d8e3f4',
    backgroundColor: '#ffffff',
    padding: 18,
    gap: 14,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0f172a',
  },
  loadingWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  loadingText: {
    color: '#334155',
    fontWeight: '500',
  },
  errorWrap: {
    borderRadius: 12,
    padding: 12,
    backgroundColor: '#fff5f5',
    borderWidth: 1,
    borderColor: '#fecaca',
    gap: 4,
  },
  errorTitle: {
    color: '#991b1b',
    fontWeight: '700',
  },
  errorText: {
    color: '#7f1d1d',
    fontWeight: '500',
  },
  infoWrap: {
    gap: 6,
  },
  placeName: {
    fontSize: 17,
    fontWeight: '700',
    color: '#111827',
  },
  metaText: {
    fontSize: 13,
    color: '#475467',
    fontWeight: '500',
  },
  actions: {
    gap: 10,
  },
  primaryButton: {
    minHeight: 44,
    borderRadius: 11,
    backgroundColor: '#1570ef',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 7,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
  },
  secondaryButton: {
    minHeight: 42,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: '#c9dbf7',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f2f7ff',
  },
  secondaryButtonText: {
    color: '#1e3a8a',
    fontWeight: '700',
    fontSize: 14,
  },
});
