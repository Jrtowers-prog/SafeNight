/**
 * BuddyModal.tsx — QR code pairing modal.
 *
 * Two tabs:
 * 1. "My QR" — Shows your QR code (username) for others to scan
 * 2. "Scan"  — Camera scanner to scan a friend's QR code
 *
 * Also shows:
 * - List of accepted contacts (with live status indicator)
 * - Pending incoming requests with accept/reject buttons
 */

import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { useContacts } from '../../hooks/useContacts';
import { CustomAlert, type AlertButton } from '../ui/CustomAlert';

const { width: SCREEN_W } = Dimensions.get('window');
const QR_SIZE = Math.min(SCREEN_W * 0.55, 220);

interface Props {
  visible: boolean;
  onClose: () => void;
  username: string | null;
  userId: string | null;
  onContactsChanged?: () => void;
}

type Tab = 'qr' | 'scan' | 'contacts';

export default function BuddyModal({ visible, onClose, username: initialUsername, userId, onContactsChanged }: Props) {
  const [tab, setTab] = useState<Tab>('qr');
  const [hasScanned, setHasScanned] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [respondingToId, setRespondingToId] = useState<string | null>(null);

  // ─── Custom alert state ────────────────────────────────────────────────
  const [alertState, setAlertState] = useState<{
    visible: boolean;
    title: string;
    message: string;
    icon?: string;
    iconColor?: string;
    buttons?: AlertButton[];
  }>({ visible: false, title: '', message: '' });

  const showAlert = useCallback(
    (title: string, message: string, opts?: {
      icon?: string; iconColor?: string; buttons?: AlertButton[];
    }) => {
      setAlertState({
        visible: true,
        title,
        message,
        icon: opts?.icon,
        iconColor: opts?.iconColor,
        buttons: opts?.buttons,
      });
    },
    [],
  );

  const dismissAlert = useCallback(() => {
    setAlertState((s) => ({ ...s, visible: false }));
  }, []);

  const {
    contacts,
    pending,
    username,
    isLoading,
    error,
    setUsername,
    lookupUser,
    invite,
    respond,
    removeContact,
    clearError,
    refresh,
    liveContacts,
  } = useContacts(!!userId);

  const currentUsername = username || initialUsername;

  // Refresh contacts + reset tab every time the modal opens
  useEffect(() => {
    if (visible) {
      setTab('qr');
      setHasScanned(false);
      refresh();
    }
  }, [visible, refresh]);

  // Reset scan state when switching tabs
  useEffect(() => {
    if (tab === 'scan') setHasScanned(false);
  }, [tab]);

  // ─── Auto-refresh on auth errors ───────────────────────────────────────
  useEffect(() => {
    if (!error) return;
    
    // Check if error is auth-related (missing user id, invalid token, etc.)
    const isAuthError = error.toLowerCase().includes('authentication') ||
                       error.toLowerCase().includes('no user') ||
                       error.toLowerCase().includes('401') ||
                       error.toLowerCase().includes('invalid');
    
    if (!isAuthError) return;

    // Auto-retry after 2 seconds
    const timeoutId = setTimeout(() => {
      refresh();
    }, 2000);

    return () => clearTimeout(timeoutId);
  }, [error, refresh]);

  // ─── Handle QR scan ───────────────────────────────────────────────────
  const handleBarCodeScanned = useCallback(
    async ({ data }: { data: string }) => {
      if (hasScanned) return;
      setHasScanned(true);

      // QR data is the username
      const scannedUsername = data.trim().replace('safenight://', '');

      const user = await lookupUser(scannedUsername);
      if (!user) {
        showAlert('Not Found', 'This user was not found on SafeNight.', {
          icon: 'person-outline',
          iconColor: '#F59E0B',
          buttons: [{ text: 'OK', style: 'default', onPress: () => setHasScanned(false) }],
        });
        return;
      }

      const doAdd = async () => {
        const ok = await invite(user.id, user.name);
        if (ok) {
          onContactsChanged?.();
          showAlert('Sent!', 'Contact request sent.', {
            icon: 'checkmark-circle',
            iconColor: '#10B981',
          });
          setTab('contacts');
        } else {
          setHasScanned(false);
        }
      };

      showAlert(
        'Add Contact',
        `Add ${user.name || user.username} as an emergency contact?`,
        {
          icon: 'person-add',
          iconColor: '#6366F1',
          buttons: [
            { text: 'Cancel', style: 'cancel', onPress: () => setHasScanned(false) },
            { text: 'Add', style: 'default', onPress: doAdd },
          ],
        },
      );
    },
    [hasScanned, lookupUser, invite, showAlert, onContactsChanged],
  );

  // ─── Handle contact response ──────────────────────────────────────────
  const doRespond = useCallback(
    async (id: string, resp: 'accepted' | 'rejected') => {
      try {
        setRespondingToId(id);
        console.log(`[BuddyModal] Responding to request ${id}: ${resp}`);
        const ok = await respond(id, resp);
        setRespondingToId(null);
        if (ok) {
          onContactsChanged?.();
          showAlert('Success', `Contact request ${resp}.`, {
            icon: resp === 'accepted' ? 'checkmark-circle' : 'close-circle',
            iconColor: resp === 'accepted' ? '#10B981' : '#94A3B8',
          });
        } else {
          showAlert('Error', 'Failed to respond. Please try again.', {
            icon: 'alert-circle',
            iconColor: '#EF4444',
          });
        }
      } catch (err: unknown) {
        setRespondingToId(null);
        const msg = err instanceof Error ? err.message : 'Unknown error';
        console.error('[BuddyModal] Respond error:', msg);
        showAlert('Error', msg || 'Failed to respond to request', {
          icon: 'alert-circle',
          iconColor: '#EF4444',
        });
      }
    },
    [respond, showAlert, onContactsChanged],
  );

  const handleRespond = useCallback(
    (id: string, name: string, resp: 'accepted' | 'rejected') => {
      const title = resp === 'accepted' ? 'Accept Contact' : 'Reject Contact';
      const message = `${resp === 'accepted' ? 'Accept' : 'Reject'} ${name}'s request?`;

      showAlert(title, message, {
        icon: resp === 'accepted' ? 'person-add' : 'person-remove',
        iconColor: resp === 'accepted' ? '#10B981' : '#F59E0B',
        buttons: [
          { text: 'Cancel', style: 'cancel' },
          {
            text: resp === 'accepted' ? 'Accept' : 'Reject',
            style: resp === 'accepted' ? 'default' : 'destructive',
            onPress: () => doRespond(id, resp),
          },
        ],
      });
    },
    [doRespond, showAlert],
  );

  const handleRemove = useCallback(
    (id: string, name: string) => {
      const doRemove = async () => {
        try {
          console.log(`[BuddyModal] Removing contact ${id}`);
          const ok = await removeContact(id);
          if (ok) {
            onContactsChanged?.();
            showAlert('Removed', 'Contact removed.', {
              icon: 'checkmark-circle',
              iconColor: '#10B981',
            });
          } else {
            showAlert('Error', 'Failed to remove contact. Please try again.', {
              icon: 'alert-circle',
              iconColor: '#EF4444',
            });
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          console.error('[BuddyModal] Remove contact error:', msg);
          showAlert('Error', msg || 'Failed to remove contact', {
            icon: 'alert-circle',
            iconColor: '#EF4444',
          });
        }
      };

      showAlert('Remove Contact', `Remove ${name} as your emergency contact?`, {
        icon: 'person-remove',
        iconColor: '#EF4444',
        buttons: [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Remove', style: 'destructive', onPress: doRemove },
        ],
      });
    },
    [removeContact, showAlert, onContactsChanged],
  );

  // ─── Web download prompt (replaces QR/Scan on web) ────────────────────
  const renderWebDownloadPrompt = (context: 'qr' | 'scan') => (
    <View style={styles.tabContent}>
      <View style={styles.downloadPrompt}>
        <Ionicons name="phone-portrait-outline" size={56} color="#6366F1" />
        <Text style={styles.downloadTitle}>
          {context === 'qr' ? 'QR Code Pairing' : 'QR Code Scanning'}
        </Text>
        <Text style={styles.downloadTitle}>Available on the App</Text>
        <Text style={styles.downloadDescription}>
          {context === 'qr'
            ? 'Your unique QR code is available in the SafeNight mobile app. Friends can scan it to add you as an emergency contact.'
            : 'Use the SafeNight mobile app to scan a friend\'s QR code and add them to your Safety Circle.'}
        </Text>

        <View style={styles.howItWorks}>
          <Text style={styles.howItWorksTitle}>How Safety Circle Works</Text>
          <View style={styles.stepRow}>
            <View style={styles.stepNumber}><Text style={styles.stepNumberText}>1</Text></View>
            <Text style={styles.stepText}>Download SafeNight on your phone</Text>
          </View>
          <View style={styles.stepRow}>
            <View style={styles.stepNumber}><Text style={styles.stepNumberText}>2</Text></View>
            <Text style={styles.stepText}>Open Safety Circle and share your QR code with a friend</Text>
          </View>
          <View style={styles.stepRow}>
            <View style={styles.stepNumber}><Text style={styles.stepNumberText}>3</Text></View>
            <Text style={styles.stepText}>Your friend scans it to send a contact request</Text>
          </View>
          <View style={styles.stepRow}>
            <View style={styles.stepNumber}><Text style={styles.stepNumberText}>4</Text></View>
            <Text style={styles.stepText}>Accept the request — you can now share live location while walking</Text>
          </View>
        </View>

        <Pressable
          style={styles.downloadButton}
          onPress={() => Linking.openURL('https://github.com/MobinZaki/PlymHack2026New/releases')}
        >
          <Ionicons name="download-outline" size={20} color="#FFF" />
          <Text style={styles.downloadButtonText}>Download Latest Version</Text>
        </Pressable>
      </View>
    </View>
  );

  // ─── Render tabs ──────────────────────────────────────────────────────
  const renderMyQR = () => {
    if (Platform.OS === 'web') return renderWebDownloadPrompt('qr');

    return (
      <View style={[styles.tabContent, styles.qrTabContent]}>
        {currentUsername ? (
          <>
            <Text style={styles.subtitle}>Show this to a friend to add you</Text>
            <View style={styles.qrContainer}>
              <QRCode
                value={`safenight://${currentUsername}`}
                size={QR_SIZE}
                backgroundColor="#FFFFFF"
                color="#1E293B"
              />
            </View>
            <View style={styles.usernameTag}>
              <Ionicons name="person" size={16} color="#6366F1" />
              <Text style={styles.usernameText}>@{currentUsername}</Text>
            </View>
          </>
        ) : isLoading ? (
          <View style={styles.usernameSetup}>
            <ActivityIndicator size="large" color="#6366F1" />
            <Text style={styles.subtitle}>Fetching your profile…</Text>
            <Text style={styles.hint}>
              Just a moment while we grab your details.
            </Text>
          </View>
        ) : (
          <View style={styles.usernameSetup}>
            <Ionicons name="alert-circle" size={40} color="#F59E0B" />
            <Text style={styles.subtitle}>No username set</Text>
            <Text style={styles.hint}>
              Your username is your unique handle — friends use it to find and add you to their Safety Circle via QR code. Please log out and log back in to complete setup.
            </Text>
          </View>
        )}
      </View>
    );
  };

  const renderScanner = () => {
    if (Platform.OS === 'web') return renderWebDownloadPrompt('scan');

    if (!permission?.granted) {
      return (
        <View style={styles.tabContent}>
          <Ionicons name="camera" size={48} color="#94A3B8" />
          <Text style={styles.subtitle}>Camera access needed to scan QR codes</Text>
          <Pressable style={styles.button} onPress={requestPermission}>
            <Text style={styles.buttonText}>Allow Camera</Text>
          </Pressable>
        </View>
      );
    }

    return (
      <View style={styles.scannerContainer}>
        <CameraView
          style={styles.camera}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={hasScanned ? undefined : handleBarCodeScanned}
        >
          <View style={styles.scanOverlay}>
            <View style={styles.scanFrame} />
            <Text style={styles.scanText}>
              Point at a friend&apos;s SafeNight QR code
            </Text>
          </View>
        </CameraView>
      </View>
    );
  };

  const renderContacts = () => (
    <ScrollView style={styles.contactsList} showsVerticalScrollIndicator={false}>
      {/* Pending requests */}
      {pending.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>
            Pending Requests ({pending.length})
          </Text>
          {pending.map((p) => (
            <View key={p.id} style={styles.contactRow}>
              <View style={styles.contactInfo}>
                <Ionicons name="person-add" size={20} color="#F59E0B" />
                <View style={styles.contactText}>
                  <Text style={styles.contactName}>
                    {p.from.name || p.from.username || 'Unknown'}
                  </Text>
                  {p.from.username && (
                    <Text style={styles.contactUsername}>@{p.from.username}</Text>
                  )}
                </View>
              </View>
              <View style={styles.actionButtons}>
                <Pressable
                  style={[styles.smallBtn, styles.acceptBtn, respondingToId === p.id && styles.buttonDisabled]}
                  onPress={() =>
                    handleRespond(p.id, p.from.name || 'this user', 'accepted')
                  }
                  hitSlop={8}
                  disabled={respondingToId === p.id}
                >
                  {respondingToId === p.id ? (
                    <ActivityIndicator size={16} color="#FFF" />
                  ) : (
                    <Ionicons name="checkmark" size={18} color="#FFF" />
                  )}
                </Pressable>
                <Pressable
                  style={[styles.smallBtn, styles.rejectBtn, respondingToId === p.id && styles.buttonDisabled]}
                  onPress={() =>
                    handleRespond(p.id, p.from.name || 'this user', 'rejected')
                  }
                  hitSlop={8}
                  disabled={respondingToId === p.id}
                >
                  {respondingToId === p.id ? (
                    <ActivityIndicator size={16} color="#FFF" />
                  ) : (
                    <Ionicons name="close" size={18} color="#FFF" />
                  )}
                </Pressable>
              </View>
            </View>
          ))}
        </>
      )}

      {/* Active contacts */}
      <Text style={styles.sectionTitle}>
        Emergency Contacts ({contacts.length})
      </Text>
      {contacts.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="people-outline" size={36} color="#94A3B8" />
          <Text style={styles.emptyText}>No contacts yet</Text>
          <Text style={styles.emptyHint}>
            Scan a friend&apos;s QR code to add them
          </Text>
        </View>
      ) : (
        contacts.map((c) => (
          <View key={c.id} style={styles.contactRow}>
            <View style={styles.contactInfo}>
              {c.is_live ? (
                <View style={styles.liveIndicator}>
                  <Ionicons name="radio" size={18} color="#22C55E" />
                </View>
              ) : (
                <Ionicons name="person" size={20} color="#6366F1" />
              )}
              <View style={styles.contactText}>
                <Text style={styles.contactName}>
                  {c.nickname || c.user.name || c.user.username || 'Unknown'}
                </Text>
                {c.user.username && (
                  <Text style={styles.contactUsername}>@{c.user.username}</Text>
                )}
                {c.is_live && c.live_session && (
                  <Text style={styles.liveText}>
                    Walking{c.live_session.destination_name
                      ? ` to ${c.live_session.destination_name}`
                      : ''}
                  </Text>
                )}
              </View>
            </View>
            <Pressable
              style={[styles.smallBtn, styles.removeBtn]}
              onPress={() =>
                handleRemove(c.id, c.nickname || c.user.name || 'this contact')
              }
            >
              <Ionicons name="trash-outline" size={16} color="#EF4444" />
            </Pressable>
          </View>
        ))
      )}
    </ScrollView>
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Safety Circle</Text>
          <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={12}>
            <Ionicons name="close" size={24} color="#64748B" />
          </Pressable>
        </View>

        {/* Tab bar */}
        <View style={styles.tabBar}>
          {(['qr', 'scan', 'contacts'] as Tab[]).map((t) => (
            <Pressable
              key={t}
              style={[styles.tab, tab === t && styles.tabActive]}
              onPress={() => {
                setTab(t);
                if (t === 'contacts') refresh();
              }}
            >
              <Ionicons
                name={
                  t === 'qr'
                    ? 'qr-code'
                    : t === 'scan'
                      ? 'scan'
                      : 'people'
                }
                size={18}
                color={tab === t ? '#6366F1' : '#94A3B8'}
              />
              <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
                {t === 'qr' ? 'My QR' : t === 'scan' ? 'Scan' : `Contacts${pending.length > 0 ? ` (${pending.length})` : ''}`}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Error banner */}
        {error && (
          <Pressable
            style={styles.errorBanner}
            onPress={clearError}
          >
            <View style={{ flex: 1 }}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
            <Ionicons name="close-circle" size={18} color="#FFF" />
          </Pressable>
        )}

        {/* Content */}
        {isLoading && tab === 'contacts' ? (
          <View style={styles.loading}>
            <ActivityIndicator size="large" color="#6366F1" />
          </View>
        ) : (
          <>
            {tab === 'qr' && renderMyQR()}
            {tab === 'scan' && renderScanner()}
            {tab === 'contacts' && renderContacts()}
          </>
        )}

        {/* Live contacts banner */}
        {liveContacts.length > 0 && tab !== 'contacts' && (
          <Pressable style={styles.liveBanner} onPress={() => setTab('contacts')}>
            <View style={styles.liveIndicator}>
              <Ionicons name="radio" size={16} color="#22C55E" />
            </View>
            <Text style={styles.liveBannerText}>
              {liveContacts.length} contact{liveContacts.length > 1 ? 's' : ''} walking now
            </Text>
            <Ionicons name="chevron-forward" size={16} color="#22C55E" />
          </Pressable>
        )}
      </View>

      <CustomAlert
        visible={alertState.visible}
        title={alertState.title}
        message={alertState.message}
        icon={alertState.icon as any}
        iconColor={alertState.iconColor}
        buttons={alertState.buttons}
        onDismiss={dismissAlert}
      />
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1E293B',
  },
  closeBtn: {
    padding: 4,
  },
  // Tab bar
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 6,
    marginBottom: 8,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#F1F5F9',
  },
  tabActive: {
    backgroundColor: '#EEF2FF',
  },
  tabText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#94A3B8',
  },
  tabTextActive: {
    color: '#6366F1',
  },
  // Tab content
  tabContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  subtitle: {
    fontSize: 15,
    color: '#64748B',
    textAlign: 'center',
    marginBottom: 20,
  },
  // QR code
  qrTabContent: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    margin: 8,
  },
  qrContainer: {
    padding: 24,
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
    marginBottom: 16,
  },
  usernameTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  usernameText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#6366F1',
  },
  // Username setup
  usernameSetup: {
    alignItems: 'center',
    gap: 12,
  },
  input: {
    width: '100%',
    height: 48,
    borderWidth: 1.5,
    borderColor: '#E2E8F0',
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    color: '#1E293B',
    backgroundColor: '#FFF',
  },
  hint: {
    fontSize: 12,
    color: '#94A3B8',
  },
  button: {
    backgroundColor: '#6366F1',
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 12,
    minWidth: 160,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#FFF',
    fontWeight: '700',
    fontSize: 15,
  },
  // Scanner
  scannerContainer: {
    flex: 1,
    overflow: 'hidden',
    margin: 16,
    borderRadius: 16,
  },
  camera: {
    flex: 1,
  },
  scanOverlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  scanFrame: {
    width: 220,
    height: 220,
    borderWidth: 3,
    borderColor: '#6366F1',
    borderRadius: 20,
    backgroundColor: 'transparent',
    marginBottom: 20,
  },
  scanText: {
    color: '#FFF',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  // Contacts list
  contactsList: {
    flex: 1,
    paddingHorizontal: 16,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#64748B',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 16,
    marginBottom: 8,
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFF',
    padding: 14,
    borderRadius: 12,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  contactInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  contactText: {
    flex: 1,
  },
  contactName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1E293B',
  },
  contactUsername: {
    fontSize: 12,
    color: '#94A3B8',
    marginTop: 1,
  },
  liveText: {
    fontSize: 12,
    color: '#22C55E',
    fontWeight: '600',
    marginTop: 2,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 6,
  },
  smallBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  acceptBtn: {
    backgroundColor: '#22C55E',
  },
  rejectBtn: {
    backgroundColor: '#EF4444',
  },
  removeBtn: {
    backgroundColor: '#FEF2F2',
  },
  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingVertical: 32,
    gap: 8,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#64748B',
  },
  emptyHint: {
    fontSize: 13,
    color: '#94A3B8',
    textAlign: 'center',
  },
  // Live indicator
  liveIndicator: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Error banner
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#EF4444',
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginHorizontal: 16,
    borderRadius: 10,
    marginBottom: 8,
  },
  errorText: {
    color: '#FFF',
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  // Loading
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Live banner
  liveBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#F0FDF4',
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#BBF7D0',
  },
  liveBannerText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
    color: '#15803D',
  },
  // Validation
  inputError: {
    borderColor: '#EF4444',
  },
  validationError: {
    fontSize: 12,
    color: '#EF4444',
    fontWeight: '500',
  },
  // Web download prompt
  downloadPrompt: {
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 8,
    maxWidth: 400,
  },
  downloadTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1E293B',
    textAlign: 'center',
  },
  downloadDescription: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 20,
  },
  howItWorks: {
    width: '100%',
    backgroundColor: '#F8FAFC',
    borderRadius: 14,
    padding: 16,
    gap: 12,
    marginTop: 4,
  },
  howItWorksTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#334155',
    marginBottom: 2,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  stepNumber: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#6366F1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumberText: {
    color: '#FFF',
    fontSize: 13,
    fontWeight: '700',
  },
  stepText: {
    flex: 1,
    fontSize: 13,
    color: '#475569',
    lineHeight: 18,
  },
  downloadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#6366F1',
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 12,
    marginTop: 4,
    width: '100%',
  } as any,
  downloadButtonText: {
    color: '#FFF',
    fontSize: 15,
    fontWeight: '700',
  },
});
