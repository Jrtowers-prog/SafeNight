import { router, Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useCallback, useEffect, useState } from 'react';
import { Linking, LogBox, Platform, StyleSheet, View } from 'react-native';
import 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';

// expo-router uses expo-keep-awake internally during bundle load; the native
// module occasionally fails to activate before the Activity is fully ready on
// Android dev builds. This is non-fatal — suppress the noise.
LogBox.ignoreLogs(['Unable to activate keep awake']);

import { AnimatedSplashScreen } from '@/src/components/AnimatedSplashScreen';
import { ChangePasswordModal } from '@/src/components/modals/ChangePasswordModal';
import DisclaimerModal from '@/src/components/modals/DisclaimerModal';
import LoginModal from '@/src/components/modals/LoginModal';
import WelcomeModal from '@/src/components/modals/WelcomeModal';
import ForceUpdateScreen from '@/src/components/ui/ForceUpdateScreen';
import { useAuth } from '@/src/hooks/useAuth';
import { useAutoUpdate } from '@/src/hooks/useAutoUpdate';
import { useUpdateCheck } from '@/src/hooks/useUpdateCheck';
import { setOnboardingAccepted } from '@/src/services/onboarding';

// Hide native splash as fast as possible
SplashScreen.preventAutoHideAsync().then(() => SplashScreen.hideAsync());

const MIN_SPLASH_MS = 3500;

export default function RootLayout() {
  const [splashVisible, setSplashVisible] = useState(true);
  const [appReady, setAppReady] = useState(false);
  const [minTimePassed, setMinTimePassed] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [locationGranted, setLocationGranted] = useState(false);
  const [showPasswordReset, setShowPasswordReset] = useState(false);
  const update = useUpdateCheck();
  const auth = useAuth();

  // Enable auto-updates (OTA updates for Play Store builds)
  useAutoUpdate();

  // Handle deep links for password reset (safenight://reset-password?access_token=...&type=recovery)
  useEffect(() => {
    const handleUrl = async (url: string | null) => {
      if (!url) return;

      const parsedUrl = url.trim();
      const hasResetFlow =
        parsedUrl.includes('reset-password') || parsedUrl.includes('type=recovery');

      const tokenFromQuery = (() => {
        const queryString = parsedUrl.includes('?') ? parsedUrl.split('?')[1] : '';
        const params = new URLSearchParams(queryString);
        return params.get('token');
      })();

      const tokenFromPath = (() => {
        const match = parsedUrl.match(/\/share\/([A-Za-z0-9_-]+)/);
        return match?.[1] ?? null;
      })();

      const sharedRouteToken = tokenFromQuery || tokenFromPath;

      if (!hasResetFlow && sharedRouteToken) {
        router.replace({
          pathname: '/',
          params: { sharedRouteToken },
        });
        return;
      }

      if (!hasResetFlow) return;

      const queryString = parsedUrl.includes('?') ? parsedUrl.split('?')[1] : '';
      const params = new URLSearchParams(queryString);
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token') ?? '';
      const type = params.get('type');
      const expiresIn = params.get('expires_in');

      if (type === 'recovery' && accessToken) {
        await auth.beginPasswordReset(
          accessToken,
          refreshToken,
          expiresIn ? parseInt(expiresIn, 10) : undefined
        );
        setShowPasswordReset(true);
      }
    };

    // Check if app was cold-started from a deep link
    Linking.getInitialURL().then(handleUrl);

    // Listen for links while app is already running
    const sub = Linking.addEventListener('url', ({ url }) => handleUrl(url));
    return () => sub.remove();
  }, [auth.beginPasswordReset]);

  // Set Android navigation bar color to white with dark icons
  useEffect(() => {
    if (Platform.OS === 'android') {
      SystemUI.setBackgroundColorAsync('#ffffff').catch(() => {});
    }
  }, []);

  // Start minimum timer on mount
  useEffect(() => {
    const timer = setTimeout(() => setMinTimePassed(true), MIN_SPLASH_MS);
    return () => clearTimeout(timer);
  }, []);

  // Mark app as ready once the main content has mounted
  const onMainLayout = useCallback(() => {
    setAppReady(true);
  }, []);

  // Dismiss splash when both conditions are met AND auth check is complete
  useEffect(() => {
    if (appReady && minTimePassed && !auth.isLoading) {
      setSplashVisible(false);
    }
  }, [appReady, minTimePassed, auth.isLoading]);

  // Check if welcome flow is needed after login
  // Source of truth is the DB profile — only show if name or username is missing
  useEffect(() => {
    if (!auth.isLoggedIn || !auth.user) {
      setShowWelcome(false);
      return;
    }
    const profileIncomplete =
      !auth.user.name?.trim() || !auth.user.username?.trim();

    if (profileIncomplete) {
      setShowWelcome(true);
    } else {
      setShowWelcome(false);
    }
  }, [auth.isLoggedIn, auth.user]);

  const handleWelcomeComplete = useCallback(async () => {
    // Re-fetch profile from server so all hooks see the latest name/username
    await auth.refreshProfile();
    setShowWelcome(false);
  }, [auth.refreshProfile]);

  const handleAcceptLocation = useCallback(() => {
    setLocationGranted(true);
    // Also mark the existing onboarding as accepted so
    // the old OnboardingModal doesn't appear again
    setOnboardingAccepted();
  }, []);

  // Show login modal after splash if not authenticated
  // On web, allow guests to browse the map — login is prompted contextually
  const showLoginGate = !splashVisible && !auth.isLoggedIn && Platform.OS !== 'web';

  // Show disclaimer if logged in but hasn't accepted yet
  const needsDisclaimer =
    !splashVisible &&
    auth.isLoggedIn &&
    !auth.user?.disclaimer_accepted_at;

  // Force update blocks EVERYTHING (highest priority, after splash)
  const showForceUpdate = !splashVisible && update.forceUpdate;

  return (
    <View style={styles.root}>
      {/* Force update screen — blocks the entire app */}
      {showForceUpdate && (
        <View style={styles.forceUpdateOverlay}>
          <SafeAreaProvider>
            <ForceUpdateScreen />
          </SafeAreaProvider>
        </View>
      )}

      {/* App loads underneath the splash */}
      <View 
        style={[
          styles.app, 
          !splashVisible && !showForceUpdate && styles.appVisible,
          (showLoginGate || needsDisclaimer) && styles.appBlocked
        ]} 
        onLayout={onMainLayout}
      >
        <SafeAreaProvider>
          <StatusBar style="dark" />
          <Stack screenOptions={{ headerShown: false }} />
        </SafeAreaProvider>
      </View>

      {/* Splash overlays on top while loading */}
      {splashVisible && (
        <View style={styles.splashOverlay}>
          <AnimatedSplashScreen
            onFinish={() => {
              // Animation loops, so this is only called by the fade-out
              // which we trigger via the duration prop — but now we control
              // dismissal via state, so just keep it as a no-op
            }}
            duration={999999}
          />
        </View>
      )}

      {/* Web: Opaque backdrop when login gate is active (native only now) */}
      {Platform.OS !== 'web' && showLoginGate && (
        <View style={styles.webBackdrop} />
      )}

      {/* Auth gate — force login before accessing app */}
      <LoginModal
        visible={showLoginGate}
        onClose={() => {}} // Cannot close - mandatory login
        onCheckAuthOptions={auth.checkAuthOptions}
        onSendMagicLink={auth.sendMagicLink}
        onSignInWithPassword={auth.signInWithPassword}
        onForgotPassword={auth.forgotPassword}
        onVerify={auth.verify}
        error={auth.error}
        dismissable={false}
      />

      {/* Safety disclaimer — must accept before using the app */}
      <DisclaimerModal
        visible={needsDisclaimer && !showForceUpdate}
        onAccept={auth.acceptDisclaimer}
      />

      {/* Post-login onboarding wizard (only after disclaimer is accepted) */}
      <WelcomeModal
        visible={showWelcome && !needsDisclaimer && !showForceUpdate}
        onComplete={handleWelcomeComplete}
        userName={auth.user?.name ?? ''}
        currentUsername={auth.user?.username ?? null}
        onSetUsername={auth.updateUsername}
        onSetName={auth.updateName}
        onAcceptLocation={handleAcceptLocation}
        hasLocationPermission={locationGranted}
      />

      {/* Password reset via email deep link */}
      <ChangePasswordModal
        visible={showPasswordReset && !splashVisible}
        onClose={() => setShowPasswordReset(false)}
        onChangePassword={auth.changePassword}
        isResetFlow={true}
        email={auth.user?.email ?? null}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  app: {
    flex: 1,
    opacity: 0,
  },
  appVisible: {
    opacity: 1,
  },
  appBlocked: {
    pointerEvents: 'none',
  },
  splashOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
  },
  webBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#F8FAFC',
    zIndex: 9,
  },
  forceUpdateOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    backgroundColor: '#FFFFFF',
  },
});
