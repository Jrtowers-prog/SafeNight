/**
 * ChangePasswordModal.tsx — Change or set a new account password.
 *
 * Two modes:
 *   isResetFlow=false  → "Change Password" from Settings (user is logged in normally)
 *   isResetFlow=true   → "Set New Password" after clicking a password-reset email link
 *
 * Security:
 *   - New password must be at least 8 characters
 *   - Confirm password field prevents typos
 *   - Visual strength indicator guides users to a strong password
 *   - The actual API call uses the stored JWT (authFetch) — no secrets in the UI
 *   - In reset flow the JWT is the recovery token exchanged from the email link
 */

import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from 'react-native';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called with the new password. Should return true on success. */
  onChangePassword: (newPassword: string) => Promise<boolean>;
  /** true = came from password-reset email link (no current password needed) */
  isResetFlow?: boolean;
  /** Shown for context in reset flow */
  email?: string | null;
}

type Strength = 'weak' | 'fair' | 'good' | 'strong';

function getStrength(pw: string): Strength {
  if (pw.length < 8) return 'weak';
  const hasUpper = /[A-Z]/.test(pw);
  const hasLower = /[a-z]/.test(pw);
  const hasNumber = /[0-9]/.test(pw);
  const hasSymbol = /[^A-Za-z0-9]/.test(pw);
  const score = [hasUpper, hasLower, hasNumber, hasSymbol].filter(Boolean).length;
  if (score >= 4 && pw.length >= 10) return 'strong';
  if (score >= 3) return 'good';
  if (score >= 2) return 'fair';
  return 'weak';
}

const STRENGTH_COLOR: Record<Strength, string> = {
  weak: '#EF4444',
  fair: '#F97316',
  good: '#EAB308',
  strong: '#22C55E',
};
const STRENGTH_LABEL: Record<Strength, string> = {
  weak: 'Too weak',
  fair: 'Fair',
  good: 'Good',
  strong: 'Strong ✓',
};
const STRENGTH_PERCENT: Record<Strength, number> = {
  weak: 25, fair: 50, good: 75, strong: 100,
};

export function ChangePasswordModal({
  visible,
  onClose,
  onChangePassword,
  isResetFlow = false,
  email,
}: Props) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const strength = getStrength(newPassword);
  const strengthColor = STRENGTH_COLOR[strength];
  const strengthLabel = STRENGTH_LABEL[strength];
  const strengthPercent = STRENGTH_PERCENT[strength];

  const passwordsMatch = newPassword === confirmPassword && confirmPassword.length > 0;
  const canSubmit = newPassword.length >= 8 && passwordsMatch && !isLoading;

  // Reset state on close
  useEffect(() => {
    if (!visible) {
      setNewPassword('');
      setConfirmPassword('');
      setShowNew(false);
      setShowConfirm(false);
      setError(null);
      setSuccess(false);
    }
  }, [visible]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setError(null);
    setIsLoading(true);
    const ok = await onChangePassword(newPassword);
    setIsLoading(false);
    if (ok) {
      setSuccess(true);
    }
  }, [canSubmit, newPassword, onChangePassword]);

  const handleClose = useCallback(() => {
    setNewPassword('');
    setConfirmPassword('');
    setError(null);
    setSuccess(false);
    onClose();
  }, [onClose]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={isResetFlow ? undefined : handleClose}
      transparent={false}
    >
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Handle bar */}
          <View style={styles.handleBar} />

          {/* Close (not in reset flow — user must complete or go back) */}
          {!isResetFlow && !success && (
            <Pressable onPress={handleClose} style={styles.closeBtn} hitSlop={12}>
              <Ionicons name="close" size={24} color="#64748B" />
            </Pressable>
          )}

          {success ? (
            /* ── Success State ── */
            <View style={styles.successContainer}>
              <View style={styles.successIconWrap}>
                <View style={styles.successRing}>
                  <Ionicons name="checkmark" size={40} color="#22C55E" />
                </View>
              </View>
              <Text style={styles.successTitle}>Password Updated!</Text>
              <Text style={styles.successSubtitle}>
                Your password has been changed successfully.
                {'\n'}Use it next time you sign in.
              </Text>
              <Pressable style={styles.doneBtn} onPress={handleClose}>
                <Text style={styles.doneBtnText}>Done</Text>
              </Pressable>
            </View>
          ) : (
            /* ── Form ── */
            <>
              <View style={styles.iconWrap}>
                <View style={styles.iconCircle}>
                  <Ionicons name="lock-closed" size={32} color="#6366F1" />
                </View>
              </View>

              <Text style={styles.heading}>
                {isResetFlow ? 'Set New Password' : 'Change Password'}
              </Text>

              {isResetFlow && email ? (
                <Text style={styles.emailHint}>
                  for <Text style={styles.emailBold}>{email}</Text>
                </Text>
              ) : null}

              <Text style={styles.subtitle}>
                {isResetFlow
                  ? 'Choose a strong password for your account.'
                  : 'Enter and confirm your new password below.'}
              </Text>

              {/* New password */}
              <Text style={styles.label}>New password</Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={styles.input}
                  placeholder="New password"
                  placeholderTextColor="#94A3B8"
                  value={newPassword}
                  onChangeText={(t) => { setNewPassword(t); setError(null); }}
                  secureTextEntry={!showNew}
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="newPassword"
                  returnKeyType="next"
                />
                <Pressable onPress={() => setShowNew((v) => !v)} style={styles.eyeBtn} hitSlop={8}>
                  <Ionicons name={showNew ? 'eye-off-outline' : 'eye-outline'} size={20} color="#94A3B8" />
                </Pressable>
              </View>

              {/* Strength bar */}
              {newPassword.length > 0 && (
                <View style={styles.strengthRow}>
                  <View style={styles.strengthBg}>
                    <View
                      style={[
                        styles.strengthFill,
                        {
                          width: `${strengthPercent}%` as any,
                          backgroundColor: strengthColor,
                        },
                      ]}
                    />
                  </View>
                  <Text style={[styles.strengthText, { color: strengthColor }]}>
                    {strengthLabel}
                  </Text>
                </View>
              )}

              {/* Confirm password */}
              <Text style={[styles.label, { marginTop: 16 }]}>Confirm password</Text>
              <View style={styles.inputRow}>
                <TextInput
                  style={[
                    styles.input,
                    confirmPassword.length > 0 && !passwordsMatch && styles.inputError,
                  ]}
                  placeholder="Confirm new password"
                  placeholderTextColor="#94A3B8"
                  value={confirmPassword}
                  onChangeText={(t) => { setConfirmPassword(t); setError(null); }}
                  secureTextEntry={!showConfirm}
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType="newPassword"
                  returnKeyType="done"
                  onSubmitEditing={handleSubmit}
                />
                <Pressable onPress={() => setShowConfirm((v) => !v)} style={styles.eyeBtn} hitSlop={8}>
                  <Ionicons name={showConfirm ? 'eye-off-outline' : 'eye-outline'} size={20} color="#94A3B8" />
                </Pressable>
              </View>

              {confirmPassword.length > 0 && !passwordsMatch && (
                <Text style={styles.mismatchText}>Passwords don&apos;t match</Text>
              )}

              {/* Requirements checklist */}
              <View style={styles.requirementsBox}>
                <View style={styles.reqRow}>
                  <Ionicons
                    name={newPassword.length >= 8 ? 'checkmark-circle' : 'ellipse-outline'}
                    size={15}
                    color={newPassword.length >= 8 ? '#22C55E' : '#CBD5E1'}
                  />
                  <Text style={[styles.reqText, newPassword.length >= 8 && styles.reqTextMet]}>
                    At least 8 characters
                  </Text>
                </View>
                <View style={styles.reqRow}>
                  <Ionicons
                    name={passwordsMatch ? 'checkmark-circle' : 'ellipse-outline'}
                    size={15}
                    color={passwordsMatch ? '#22C55E' : '#CBD5E1'}
                  />
                  <Text style={[styles.reqText, passwordsMatch && styles.reqTextMet]}>
                    Passwords match
                  </Text>
                </View>
              </View>

              {/* Error banner */}
              {error && (
                <View style={styles.errorBanner}>
                  <Ionicons name="alert-circle-outline" size={16} color="#DC2626" />
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              )}

              {/* Submit button */}
              <Pressable
                style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
                onPress={handleSubmit}
                disabled={!canSubmit}
              >
                {isLoading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.submitBtnText}>
                    {isResetFlow ? 'Set Password' : 'Update Password'}
                  </Text>
                )}
              </Pressable>

              {!isResetFlow && (
                <Pressable style={styles.cancelBtn} onPress={handleClose}>
                  <Text style={styles.cancelText}>Cancel</Text>
                </Pressable>
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  scroll: {
    padding: 24,
    paddingBottom: 48,
  },
  handleBar: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#E2E8F0',
    marginBottom: 16,
  },
  closeBtn: {
    alignSelf: 'flex-end',
    padding: 4,
    marginBottom: 8,
  },
  iconWrap: {
    alignItems: 'center',
    marginBottom: 16,
    marginTop: 8,
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#EEF2FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heading: {
    fontSize: 24,
    fontWeight: '700',
    color: '#0F172A',
    textAlign: 'center',
    marginBottom: 6,
  },
  emailHint: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
    marginBottom: 4,
  },
  emailBold: {
    fontWeight: '600',
    color: '#1E293B',
  },
  subtitle: {
    fontSize: 14,
    color: '#64748B',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#475569',
    marginBottom: 6,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#E2E8F0',
    paddingHorizontal: 14,
  },
  input: {
    flex: 1,
    height: 50,
    fontSize: 15,
    color: '#1E293B',
  },
  inputError: {
    borderColor: '#EF4444',
  },
  eyeBtn: {
    padding: 4,
  },
  strengthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 8,
    marginBottom: 4,
  },
  strengthBg: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#E2E8F0',
    overflow: 'hidden',
  },
  strengthFill: {
    height: '100%',
    borderRadius: 2,
  },
  strengthText: {
    fontSize: 12,
    fontWeight: '600',
    width: 68,
    textAlign: 'right',
  },
  mismatchText: {
    fontSize: 12,
    color: '#EF4444',
    marginTop: 6,
    marginLeft: 2,
  },
  requirementsBox: {
    gap: 6,
    marginTop: 12,
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  reqRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  reqText: {
    fontSize: 13,
    color: '#94A3B8',
  },
  reqTextMet: {
    color: '#475569',
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FEF2F2',
    borderRadius: 10,
    padding: 12,
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  errorText: {
    flex: 1,
    fontSize: 13,
    color: '#DC2626',
    lineHeight: 18,
  },
  submitBtn: {
    backgroundColor: '#6366F1',
    borderRadius: 14,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 20,
  },
  submitBtnDisabled: {
    opacity: 0.45,
  },
  submitBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 0.3,
  },
  cancelBtn: {
    alignItems: 'center',
    paddingVertical: 14,
    marginTop: 4,
  },
  cancelText: {
    fontSize: 15,
    color: '#64748B',
    fontWeight: '500',
  },
  // ── Success state ──
  successContainer: {
    alignItems: 'center',
    paddingTop: 32,
    paddingBottom: 16,
  },
  successIconWrap: {
    marginBottom: 24,
  },
  successRing: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: '#F0FDF4',
    borderWidth: 3,
    borderColor: '#86EFAC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  successTitle: {
    fontSize: 26,
    fontWeight: '700',
    color: '#0F172A',
    textAlign: 'center',
    marginBottom: 12,
  },
  successSubtitle: {
    fontSize: 15,
    color: '#64748B',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
  },
  doneBtn: {
    backgroundColor: '#6366F1',
    borderRadius: 14,
    paddingHorizontal: 48,
    paddingVertical: 14,
  },
  doneBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});
