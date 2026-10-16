/**
 * PrivacyPolicyModal.tsx — Full privacy policy accessible from ProfileMenu.
 *
 * Google Play / App Store require a privacy policy for apps that collect
 * location or personal data. This modal provides the in-app version.
 * The shared PrivacyPolicyContent component is also used by the web page
 * at /privacy.
 */

import { Ionicons } from '@expo/vector-icons';
import { useCallback } from 'react';
import {
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export const PRIVACY_LAST_UPDATED = '18 February 2026';

/** Shared policy content — rendered in the modal AND the /privacy web page. */
export function PrivacyPolicyContent() {
  return (
    <>
      <Text style={styles.lastUpdated}>Last updated: {PRIVACY_LAST_UPDATED}</Text>

      <Text style={styles.body}>
        SafeNight (&quot;we&quot;, &quot;our&quot;, &quot;us&quot;) is committed to protecting your privacy. This Privacy Policy
        explains how we collect, use, store, and share your personal information when you use the
        SafeNight application (the &quot;Service&quot;), available on Android, iOS, and via web at
        safenight.netlify.app.
      </Text>

      <Text style={styles.sectionTitle}>1. Information We Collect</Text>
      <Text style={styles.body}>
        <Text style={styles.bold}>Location Data: </Text>
        We collect your device&apos;s precise GPS location while the Service is in the foreground to
        provide route navigation, safety scoring, and nearby point-of-interest features. We do NOT
        collect location data when the app is in the background unless you have explicitly enabled
        background location sharing during an active Safety Circle session.
      </Text>
      <Text style={styles.body}>
        <Text style={styles.bold}>Account Information: </Text>
        When you create an account we collect your email address and an optional display name and
        username. We use passwordless magic-link authentication — we never store passwords.
      </Text>
      <Text style={styles.body}>
        <Text style={styles.bold}>Usage Data: </Text>
        We log anonymised usage events (e.g. app opens, routes searched) to improve the service.
        These events are tied to your account but do not contain route coordinates.
      </Text>
      <Text style={styles.body}>
        <Text style={styles.bold}>Payment Information: </Text>
        If you subscribe to a paid plan, payment is processed entirely by Stripe. We do not store
        your card number or any payment details — only your Stripe customer ID and subscription
        status are stored in our database.
      </Text>
      <Text style={styles.body}>
        <Text style={styles.bold}>Safety Circle: </Text>
        When you use the Safety Circle feature, your live location is shared with contacts you
        explicitly invite during active tracking sessions you initiate. Location sharing stops
        immediately when you end the session.
      </Text>
      <Text style={styles.body}>
        <Text style={styles.bold}>Device Information: </Text>
        We may collect basic device information (OS version, app version, crash logs) to help us
        diagnose and fix issues. This data is not linked to identifiable personal information.
      </Text>

      <Text style={styles.sectionTitle}>2. How We Use Your Information</Text>
      <Text style={styles.body}>
        • Provide route navigation and safety score calculations{'\n'}
        • Enable live location sharing with your Safety Circle contacts{'\n'}
        • Process subscription payments via Stripe{'\n'}
        • Send magic-link authentication emails{'\n'}
        • Improve app performance and features through anonymised analytics{'\n'}
        • Respond to support requests and enforce our Terms & Conditions{'\n'}
        • Comply with legal obligations
      </Text>

      <Text style={styles.sectionTitle}>3. Data Sharing</Text>
      <Text style={styles.body}>
        We do NOT sell your personal data to third parties. Data is shared only in the following
        circumstances:{'\n\n'}
        • <Text style={styles.bold}>Safety Circle contacts</Text> — your live location, only during
        active sharing sessions you initiate.{'\n'}
        • <Text style={styles.bold}>Stripe</Text> — your email address is used to create a payment
        customer record when you subscribe.{'\n'}
        • <Text style={styles.bold}>Supabase</Text> — our database and authentication provider
        stores your account, profile, and usage data.{'\n'}
        • <Text style={styles.bold}>OpenAI</Text> — anonymised route segment data (no personal
        identifiers) may be sent to generate AI safety explanations.{'\n'}
        • <Text style={styles.bold}>Law enforcement / legal process</Text> — if required by
        applicable law or to protect the safety of our users.
      </Text>

      <Text style={styles.sectionTitle}>4. Data Storage, Retention & Security</Text>
      <Text style={styles.body}>
        Your data is stored securely on Supabase (hosted on AWS within the EU). All data
        transmission uses HTTPS/TLS encryption. Access to production databases is restricted to
        authorised team members.
      </Text>
      <Text style={styles.body}>
        <Text style={styles.bold}>Account data: </Text>
        Retained for as long as your account is active. When you delete your account, all
        personally identifiable data (name, email, username, location history, Safety Circle
        contacts, and Stripe customer ID) is permanently erased within 30 days.
      </Text>
      <Text style={styles.body}>
        <Text style={styles.bold}>Safety reports: </Text>
        Reports you submit (hazards, CCTV, street lights, etc.) are retained indefinitely in
        anonymised form after account deletion. They form part of the shared safety dataset that
        benefits all users and cannot be linked back to your identity once your account is deleted.
      </Text>
      <Text style={styles.body}>
        <Text style={styles.bold}>Usage analytics: </Text>
        Anonymised, aggregate usage events are retained to improve the service. These records
        contain no name, email, or any identifier that can be traced back to you after your account
        is deleted.
      </Text>

      <Text style={styles.sectionTitle}>5. Cookies & Web Tracking</Text>
      <Text style={styles.body}>
        The SafeNight web application uses essential cookies and local-storage tokens to maintain
        your authenticated session. We do not use advertising cookies or third-party tracking
        pixels. Anonymous analytics may use a first-party cookie scoped to our domain.
      </Text>

      <Text style={styles.sectionTitle}>6. Your Rights (UK / EU)</Text>
      <Text style={styles.body}>
        Under UK GDPR / EU GDPR you have the right to:{'\n\n'}
        • <Text style={styles.bold}>Access</Text> — request a copy of your personal data.{'\n'}
        • <Text style={styles.bold}>Rectification</Text> — correct inaccurate data via your profile.{'\n'}
        • <Text style={styles.bold}>Erasure</Text> — delete your account and all personally
        identifiable data via &quot;Delete Account&quot; in the profile menu. Note: anonymised safety
        reports and aggregate usage analytics are retained as described in section 4.{'\n'}
        • <Text style={styles.bold}>Restriction</Text> — ask us to stop processing your data in
        certain circumstances.{'\n'}
        • <Text style={styles.bold}>Portability</Text> — request an export of your data by
        contacting us.{'\n'}
        • <Text style={styles.bold}>Object</Text> — object to processing based on legitimate
        interests.{'\n'}
        • <Text style={styles.bold}>Withdraw consent</Text> — for location access at any time via
        your device settings.{'\n\n'}
        To exercise any of these rights, contact us at mzst.26.x@gmail.com.
      </Text>

      <Text style={styles.sectionTitle}>7. Children&apos;s Privacy</Text>
      <Text style={styles.body}>
        SafeNight is not intended for children under 16. We do not knowingly collect personal data
        from anyone under 16. If you believe a child has provided us with personal data, please
        contact us immediately so we can delete it.
      </Text>

      <Text style={styles.sectionTitle}>8. Third-Party Services</Text>
      <Text style={styles.body}>
        The Service integrates the following third-party services, each governed by their own
        privacy policies:{'\n\n'}
        • <Text style={styles.bold}>OpenStreetMap / Nominatim</Text> — map display and geocoding{'\n'}
        • <Text style={styles.bold}>OpenStreetMap / OSRM</Text> — routing and map tiles{'\n'}
        • <Text style={styles.bold}>UK Police Data API</Text> — public crime statistics{'\n'}
        • <Text style={styles.bold}>Stripe</Text> — payment processing{'\n'}
        • <Text style={styles.bold}>Supabase</Text> — authentication and data storage{'\n'}
        • <Text style={styles.bold}>OpenAI</Text> — AI-generated safety explanations{'\n'}
        • <Text style={styles.bold}>Expo / React Native</Text> — mobile app framework
      </Text>

      <Text style={styles.sectionTitle}>9. Changes to This Policy</Text>
      <Text style={styles.body}>
        We may update this Privacy Policy from time to time. We will notify you of material changes
        through the app or by email. Continued use of the Service after changes are posted
        constitutes acceptance of the updated policy.
      </Text>

      <Text style={styles.sectionTitle}>10. Contact Us</Text>
      <Text style={styles.body}>
        For questions about this Privacy Policy or to exercise your data rights:{'\n\n'}
        Email: mzst.26.x@gmail.com{'\n'}
        SafeNight — Plymouth, UK
      </Text>
    </>
  );
}

export default function PrivacyPolicyModal({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={handleClose}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Privacy Policy</Text>
          <Pressable onPress={handleClose} hitSlop={12} accessibilityLabel="Close">
            <Ionicons name="close" size={24} color="#1E293B" />
          </Pressable>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
          showsVerticalScrollIndicator
        >
          <PrivacyPolicyContent />
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#E2E8F0',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1E293B',
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: 20,
  },
  lastUpdated: {
    fontSize: 13,
    color: '#64748B',
    marginBottom: 16,
    fontStyle: 'italic',
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#1E293B',
    marginTop: 24,
    marginBottom: 8,
  },
  body: {
    fontSize: 15,
    lineHeight: 22,
    color: '#374151',
    marginBottom: 12,
  },
  bold: {
    fontWeight: '700',
  },
});
