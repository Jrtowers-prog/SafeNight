/**
 * TermsModal.tsx — Terms & Conditions modal.
 *
 * Governs use of the SafeNight Service.
 * The shared TermsContent component is also used by the /terms web page.
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

export const TERMS_LAST_UPDATED = '19 February 2026';

/** Shared terms content — rendered in the modal AND the /terms web page. */
export function TermsContent() {
  return (
    <>
      <Text style={styles.lastUpdated}>Last updated: {TERMS_LAST_UPDATED}</Text>

      <Text style={styles.body}>
        These Terms & Conditions ("Terms") govern your use of the SafeNight application and website
        ("Service") operated by SafeNight ("we", "us", "our"). By accessing or using the Service
        you agree to be bound by these Terms. If you do not agree, please do not use the Service.
      </Text>

      <Text style={styles.sectionTitle}>1. Eligibility</Text>
      <Text style={styles.body}>
        You must be at least 16 years old to use the Service. By using the Service you represent
        and warrant that you meet this age requirement. Accounts found to belong to users under 16
        will be terminated and any data deleted.
      </Text>

      <Text style={styles.sectionTitle}>2. Account Registration</Text>
      <Text style={styles.body}>
        To access most features you must create an account using a valid email address. You are
        responsible for maintaining the confidentiality of your account and for all activities that
        occur under it. You agree to notify us immediately of any unauthorised use of your account
        at mzst.26.x@gmail.com.{'\n\n'}
        We use passwordless magic-link authentication. You must have access to your registered
        email address to log in. One account per person — creating multiple accounts to circumvent
        usage limits is prohibited and may result in termination of all associated accounts.
      </Text>

      <Text style={styles.sectionTitle}>3. Acceptable Use</Text>
      <Text style={styles.body}>
        You agree NOT to:{'\n\n'}
        • Use the Service for any unlawful purpose or in violation of any applicable law.{'\n'}
        • Reverse-engineer, decompile, or attempt to extract the source code of the Service.{'\n'}
        • Use automated tools (bots, scrapers) to access the Service without our written permission.{'\n'}
        • Attempt to gain unauthorised access to our systems or other users' accounts.{'\n'}
        • Upload or transmit malicious code, viruses, or any other harmful content.{'\n'}
        • Harass, threaten, or abuse other users via any feature of the Service.{'\n'}
        • Share your account credentials with others.{'\n'}
        • Misuse the Safety Circle or live-tracking features to surveil others without their
        consent.
      </Text>

      <Text style={styles.sectionTitle}>4. Safety Disclaimer</Text>
      <Text style={styles.body}>
        SafeNight provides route safety information for guidance purposes only. Safety scores are
        derived from publicly available UK Police crime data and algorithmic analysis — they do not
        constitute professional security advice.{'\n\n'}
        We do NOT guarantee your personal safety. Always use your own judgement, stay aware of your
        surroundings, and follow official guidance from local authorities. In an emergency, call
        999. Do not rely solely on the Service for decisions that affect your personal safety.{'\n\n'}
        By using the Service you acknowledge and accept that the safety information provided may be
        outdated, incomplete, or inaccurate, and that we are not liable for any harm arising from
        reliance on it.
      </Text>

      <Text style={styles.sectionTitle}>5. Subscriptions & Payments</Text>
      <Text style={styles.body}>
        The Service offers free and paid subscription tiers. By subscribing to a paid plan you
        agree to our Refund & Payment Policy, which is incorporated into these Terms by reference.
        Subscription fees are billed through Stripe and are non-refundable except as set out in
        our Refund & Payment Policy. A 14-day cooling-off refund is available on your first
        subscription only, in accordance with UK consumer law.
      </Text>

      <Text style={styles.sectionTitle}>6. Intellectual Property</Text>
      <Text style={styles.body}>
        All content, trademarks, logos, and software comprising the Service are the exclusive
        property of SafeNight or its licensors and are protected by applicable intellectual
        property laws. You are granted a limited, non-exclusive, non-transferable, revocable
        licence to use the Service solely for its intended personal, non-commercial purposes.{'\n\n'}
        You may not copy, redistribute, reproduce, or create derivative works from any part of the
        Service without our prior written consent.
      </Text>

      <Text style={styles.sectionTitle}>7. User-Generated Content & Reports</Text>
      <Text style={styles.body}>
        Where the Service allows you to submit content (e.g. safety reports, hazard data, CCTV or
        infrastructure records), you grant us a perpetual, worldwide, royalty-free licence to use,
        store, display, and retain that content in connection with operating the Service.{'\n\n'}
        Safety reports are retained indefinitely in anonymised form to maintain the accuracy of
        the shared safety dataset, even after account deletion. Once your account is deleted,
        retained reports cannot be linked to your identity.{'\n\n'}
        Anonymised, aggregate usage analytics are also retained to improve the service and cannot
        be traced back to your account after deletion.{'\n\n'}
        You are responsible for ensuring that content you submit is accurate and does not violate
        applicable laws or third-party rights. We reserve the right to remove or edit submitted
        content at our discretion.
      </Text>

      <Text style={styles.sectionTitle}>8. Privacy</Text>
      <Text style={styles.body}>
        Your use of the Service is also governed by our Privacy Policy, which is incorporated into
        these Terms by reference. By using the Service you consent to our collection and use of
        your data as described in the Privacy Policy.
      </Text>

      <Text style={styles.sectionTitle}>9. Third-Party Services & Links</Text>
      <Text style={styles.body}>
        The Service integrates third-party services including OpenStreetMap / Nominatim, Stripe, Supabase, and
        OpenAI. Use of these services is subject to their respective terms and privacy policies. We
        are not responsible for the practices of any third-party service.{'\n\n'}
        The Service may display links to third-party websites. These links are provided for
        convenience only and do not imply our endorsement.
      </Text>

      <Text style={styles.sectionTitle}>10. Availability & Changes</Text>
      <Text style={styles.body}>
        We strive to keep the Service available at all times but do not guarantee uninterrupted
        access. We may modify, suspend, or discontinue any feature or the Service as a whole at any
        time with or without notice.{'\n\n'}
        We reserve the right to update these Terms at any time. We will notify you of material
        changes through the app or by email. Continued use of the Service after updated Terms are
        posted constitutes your acceptance of the changes.
      </Text>

      <Text style={styles.sectionTitle}>11. Termination</Text>
      <Text style={styles.body}>
        We may suspend or terminate your access to the Service at any time if we believe you have
        violated these Terms, without prior notice or liability. You may terminate your account at
        any time using the "Delete Account" option in the profile menu.{'\n\n'}
        Upon termination, all licences granted herein cease, and all provisions that by their
        nature should survive termination (including limitation of liability and dispute resolution)
        shall continue to apply.
      </Text>

      <Text style={styles.sectionTitle}>12. Limitation of Liability</Text>
      <Text style={styles.body}>
        To the maximum extent permitted by applicable law, SafeNight and its team shall not be
        liable for any indirect, incidental, special, consequential, or punitive damages, or any
        loss of profits, data, or goodwill, arising from your use of (or inability to use) the
        Service.{'\n\n'}
        Our total liability to you for any claim arising out of or relating to the Service shall not
        exceed the amount you paid us in the 12 months preceding the claim, or £10, whichever is
        greater.{'\n\n'}
        Nothing in these Terms limits or excludes our liability for death or personal injury caused
        by our negligence, fraud, or any other liability that cannot be excluded by law.
      </Text>

      <Text style={styles.sectionTitle}>13. Governing Law & Disputes</Text>
      <Text style={styles.body}>
        These Terms are governed by and construed in accordance with the laws of England and Wales.
        Any dispute arising from or relating to these Terms or the Service shall be subject to the
        exclusive jurisdiction of the courts of England and Wales, except where mandatory consumer
        protection laws in your country of residence provide otherwise.
      </Text>

      <Text style={styles.sectionTitle}>14. Contact Us</Text>
      <Text style={styles.body}>
        If you have questions about these Terms:{'\n\n'}
        Email: mzst.26.x@gmail.com{'\n'}
        SafeNight — Plymouth, UK
      </Text>
    </>
  );
}

export default function TermsModal({ visible, onClose }: Props) {
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
          <Text style={styles.headerTitle}>Terms & Conditions</Text>
          <Pressable onPress={handleClose} hitSlop={12} accessibilityLabel="Close">
            <Ionicons name="close" size={24} color="#1E293B" />
          </Pressable>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
          showsVerticalScrollIndicator
        >
          <TermsContent />
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
    fontSize: 18,
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
