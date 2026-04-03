'use client'

import React from 'react'
import Image from 'next/image'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { formatTimeAgo } from '@/lib/utils/date'
import { useToast } from '@/app/components/ui/Toast'
import { SectionCard, getInputStyle } from './shared'
import PasswordInput from '@/app/components/ui/PasswordInput'
import { validateEmail, validatePassword, validatePasswordMatch } from '../validation'

interface SessionInfo {
  id: string
  deviceInfo: { browser?: string; os?: string } | null
  ipAddress: string | null
  lastActiveAt: string | null
  isCurrent: boolean
}

interface SecuritySectionProps {
  email: string | null
  // Email change
  newEmail: string
  setNewEmail: (v: string) => void
  savingEmail: boolean
  onChangeEmail: () => void
  // Password change
  currentPassword: string
  setCurrentPassword: (v: string) => void
  newPassword: string
  setNewPassword: (v: string) => void
  confirmNewPassword: string
  setConfirmNewPassword: (v: string) => void
  savingPassword: boolean
  onChangePassword: () => void
  passwordResetMode: 'password' | 'code'
  setPasswordResetMode: (v: 'password' | 'code') => void
  resetCodeSent: boolean
  sendingResetCode: boolean
  resetCountdown: number
  onSendResetCode: () => void
  // 2FA
  twoFAEnabled: boolean
  twoFASetupData: { qrCodeDataUrl: string; secret: string } | null
  twoFACode: string
  setTwoFACode: (v: string) => void
  backupCodes: string[]
  twoFALoading: boolean
  showDisable2FA: boolean
  setShowDisable2FA: (v: boolean) => void
  disablePassword: string
  setDisablePassword: (v: string) => void
  onSetup2FA: () => void
  onVerify2FA: () => void
  onDisable2FA: () => void
  // Sessions
  sessions: SessionInfo[]
  loadingSessions: boolean
  onRevokeSession: (id: string) => void
  onRevokeAllSessions: () => void
  // Validation touched state
  touchedFields: { newPassword: boolean; confirmPassword: boolean; newEmail: boolean }
  markTouched: (field: 'newPassword' | 'confirmPassword' | 'newEmail') => void
}

export const SecuritySection = React.memo(function SecuritySection(props: SecuritySectionProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const newPasswordValidation = validatePassword(props.newPassword, t)
  const confirmPasswordValidation = validatePasswordMatch(props.newPassword, props.confirmNewPassword, t)
  const newEmailValidation = validateEmail(props.newEmail, t)

  return (
    <SectionCard id="security" title={t('securitySection')} description={t('twoFADesc')}>
      {/* Current Email Display */}
      <Box style={{ marginBottom: tokens.spacing[5], padding: tokens.spacing[3], borderRadius: tokens.radius.md, background: tokens.colors.bg.primary }}>
        <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>{t('currentLoginEmail')}</Text>
        <Text size="sm" weight="bold">{props.email}</Text>
      </Box>

      {/* Change Email */}
      <Box style={{ marginBottom: tokens.spacing[6] }}>
        <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
          {t('changeEmailButton')}
        </Text>
        <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
          <input
            type="email"
            value={props.newEmail}
            onChange={(e) => props.setNewEmail(e.target.value)}
            onBlur={() => props.markTouched('newEmail')}
            placeholder={t('enterNewEmail')}
            autoComplete="email"
            style={{ ...getInputStyle(props.touchedFields.newEmail && !newEmailValidation.valid), flex: 1 }}
          />
          <Button
            variant="secondary"
            onClick={props.onChangeEmail}
            disabled={props.savingEmail || !props.newEmail || !newEmailValidation.valid}
          >
            {props.savingEmail ? t('sendingVerification') : t('verifyButton')}
          </Button>
        </Box>
        {props.touchedFields.newEmail && props.newEmail && !newEmailValidation.valid && (
          <Text size="xs" style={{ color: tokens.colors.accent.error, marginTop: tokens.spacing[1] }}>
            {newEmailValidation.message}
          </Text>
        )}
        <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1] }}>
          {t('emailChangeNote')}
        </Text>
      </Box>

      {/* Change Password */}
      <Box>
        <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
          {t('changePasswordTitle')}
        </Text>

        {/* Mode Selector */}
        <Box style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
          <button
            onClick={() => props.setPasswordResetMode('password')}
            style={{
              flex: 1,
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${props.passwordResetMode === 'password' ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
              background: props.passwordResetMode === 'password' ? `${tokens.colors.accent.primary}15` : 'transparent',
              color: props.passwordResetMode === 'password' ? tokens.colors.accent.primary : tokens.colors.text.secondary,
              fontSize: tokens.typography.fontSize.sm,
              cursor: 'pointer',
              transition: `all ${tokens.transition.base}`,
            }}
          >
            {t('useCurrentPassword')}
          </button>
          <button
            onClick={() => props.setPasswordResetMode('code')}
            style={{
              flex: 1,
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${props.passwordResetMode === 'code' ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
              background: props.passwordResetMode === 'code' ? `${tokens.colors.accent.primary}15` : 'transparent',
              color: props.passwordResetMode === 'code' ? tokens.colors.accent.primary : tokens.colors.text.secondary,
              fontSize: tokens.typography.fontSize.sm,
              cursor: 'pointer',
              transition: `all ${tokens.transition.base}`,
            }}
          >
            {t('useEmailReset')}
          </button>
        </Box>

        {props.passwordResetMode === 'password' ? (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            <PasswordInput
              
              value={props.currentPassword}
              onChange={(e) => props.setCurrentPassword(e.target.value)}
              placeholder={t('currentPasswordPlaceholder')}
              autoComplete="current-password"
              style={getInputStyle()}
            />
            <Box>
              <PasswordInput
                
                value={props.newPassword}
                onChange={(e) => props.setNewPassword(e.target.value)}
                onBlur={() => props.markTouched('newPassword')}
                placeholder={t('newPasswordPlaceholder')}
                autoComplete="new-password"
                style={getInputStyle(props.touchedFields.newPassword && !newPasswordValidation.valid)}
              />
              {props.touchedFields.newPassword && props.newPassword && !newPasswordValidation.valid && (
                <Text size="xs" style={{ color: tokens.colors.accent.error, marginTop: tokens.spacing[1] }}>
                  {newPasswordValidation.message}
                </Text>
              )}
            </Box>
            <Box>
              <PasswordInput
                
                value={props.confirmNewPassword}
                onChange={(e) => props.setConfirmNewPassword(e.target.value)}
                onBlur={() => props.markTouched('confirmPassword')}
                placeholder={t('confirmPasswordPlaceholder')}
                autoComplete="new-password"
                style={getInputStyle(props.touchedFields.confirmPassword && !confirmPasswordValidation.valid)}
              />
              {props.touchedFields.confirmPassword && props.confirmNewPassword && !confirmPasswordValidation.valid && (
                <Text size="xs" style={{ color: tokens.colors.accent.error, marginTop: tokens.spacing[1] }}>
                  {confirmPasswordValidation.message}
                </Text>
              )}
              {props.touchedFields.confirmPassword && props.confirmNewPassword && confirmPasswordValidation.valid && (
                <Text size="xs" style={{ color: tokens.colors.accent.success, marginTop: tokens.spacing[1] }}>
                  {t('passwordMatch')}
                </Text>
              )}
            </Box>
            <Box style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button
                variant="secondary"
                onClick={props.onChangePassword}
                disabled={props.savingPassword || !props.currentPassword || !props.newPassword || !newPasswordValidation.valid || !confirmPasswordValidation.valid}
              >
                {props.savingPassword ? t('changingPassword') : t('changePassword')}
              </Button>
            </Box>
          </Box>
        ) : (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            <Text size="sm" color="secondary">
              {t('resetLinkWillSendTo')}{props.email}
            </Text>
            <Text size="xs" color="tertiary">
              {t('resetLinkNote')}
            </Text>
            <Box style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button
                variant="secondary"
                onClick={props.onSendResetCode}
                disabled={props.sendingResetCode || props.resetCountdown > 0}
              >
                {props.sendingResetCode
                  ? t('sendingVerification')
                  : props.resetCountdown > 0
                    ? `${props.resetCountdown}${t('resendAfter')}`
                    : props.resetCodeSent
                      ? t('resendResetEmail')
                      : t('sendResetEmail')}
              </Button>
            </Box>
            {props.resetCodeSent && (
              <Box
                style={{
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  background: `${tokens.colors.accent.success}10`,
                  border: `1px solid ${tokens.colors.accent.success}30`,
                }}
              >
                <Text size="sm" style={{ color: tokens.colors.accent.success }}>
                  {t('resetEmailSentNote')}
                </Text>
              </Box>
            )}
          </Box>
        )}
      </Box>

      {/* 2FA Section */}
      <Box style={{ marginTop: tokens.spacing[6], paddingTop: tokens.spacing[6], borderTop: `1px solid ${tokens.colors.border.primary}` }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
          <Text size="sm" weight="bold">
            {t('twoFactorAuthTitle')}
          </Text>
          {props.twoFAEnabled && (
            <span style={{
              padding: `2px ${tokens.spacing[2]}`,
              borderRadius: tokens.radius.sm,
              background: `${tokens.colors.accent.success}15`,
              border: `1px solid ${tokens.colors.accent.success}30`,
              color: tokens.colors.accent.success,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: Number(tokens.typography.fontWeight.bold),
            }}>
              {t('twoFAStatusEnabled')}
            </span>
          )}
        </Box>

        {!props.twoFAEnabled && !props.twoFASetupData && props.backupCodes.length === 0 && (
          <Box>
            <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
              {t('twoFAEnableDesc')}
            </Text>
            <Button variant="secondary" size="sm" onClick={props.onSetup2FA} disabled={props.twoFALoading}>
              {props.twoFALoading ? t('loading') : t('enable2FAButton')}
            </Button>
          </Box>
        )}

        {props.twoFASetupData && !props.twoFAEnabled && (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
            <Text size="xs" color="secondary" style={{ lineHeight: 1.6 }}>
              {t('scanQRCodeDesc')}
            </Text>
            <Box style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacing[3] }}>
              <Image
                src={props.twoFASetupData.qrCodeDataUrl}
                alt="2FA QR Code"
                width={180}
                height={180}
                style={{
                  width: 180, height: 180,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.white,
                  padding: tokens.spacing[2],
                }}
                unoptimized
              />
              <Box style={{
                padding: tokens.spacing[3],
                borderRadius: tokens.radius.md,
                background: tokens.colors.bg.primary,
                border: `1px solid ${tokens.colors.border.primary}`,
                textAlign: 'center',
                width: '100%',
                maxWidth: 320,
              }}>
                <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>
                  {t('manualEntryKey')}
                </Text>
                <Text size="sm" weight="bold" style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                  {props.twoFASetupData.secret}
                </Text>
              </Box>
            </Box>
            <Box>
              <Text size="xs" weight="medium" style={{ marginBottom: tokens.spacing[2] }}>
                {t('enter6DigitCodeDesc')}
              </Text>
              <Box style={{ display: 'flex', gap: tokens.spacing[3], alignItems: 'center' }}>
                <input
                  type="text"
                  value={props.twoFACode}
                  onChange={(e) => props.setTwoFACode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  maxLength={6}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  style={{
                    ...getInputStyle(),
                    maxWidth: 160,
                    textAlign: 'center',
                    fontSize: tokens.typography.fontSize.lg,
                    fontFamily: 'monospace',
                    letterSpacing: '4px',
                  }}
                />
                <Button
                  variant="primary"
                  size="sm"
                  onClick={props.onVerify2FA}
                  disabled={props.twoFALoading || props.twoFACode.length !== 6}
                >
                  {props.twoFALoading ? t('verifyingCode') : t('verifyAndEnable')}
                </Button>
              </Box>
            </Box>
          </Box>
        )}

        {props.backupCodes.length > 0 && (
          <Box style={{
            marginTop: tokens.spacing[4],
            padding: tokens.spacing[4],
            borderRadius: tokens.radius.md,
            background: `${tokens.colors.accent.warning}08`,
            border: `1px solid ${tokens.colors.accent.warning}30`,
          }}>
            <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2], color: tokens.colors.accent.warning }}>
              {t('backupRecoveryCodes')}
            </Text>
            <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3], lineHeight: 1.6 }}>
              {t('backupCodesNote')}
            </Text>
            <Box style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: tokens.spacing[2],
              padding: tokens.spacing[3],
              borderRadius: tokens.radius.md,
              background: tokens.colors.bg.primary,
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
              userSelect: 'all',
            }}>
              {props.backupCodes.map((code, index) => (
                <Text key={index} size="sm" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', '), textAlign: 'center', letterSpacing: '0.05em' }}>
                  {code}
                </Text>
              ))}
            </Box>
            <button
              onClick={() => {
                navigator.clipboard.writeText(props.backupCodes.join('\n'))
                  .then(() => showToast(t('copiedToClipboard'), 'success'))
                  .catch(() => showToast(t('copyFailed') || 'Copy failed', 'error'))
              }}
              style={{
                marginTop: tokens.spacing[2],
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.accent.warning}40`,
                background: 'transparent',
                color: tokens.colors.accent.warning,
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[1],
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              {t('copyBackupCodes') || 'Copy all codes'}
            </button>
          </Box>
        )}

        {props.twoFAEnabled && !props.showDisable2FA && (
          <Box style={{ marginTop: tokens.spacing[3] }}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => props.setShowDisable2FA(true)}
              style={{ color: tokens.colors.accent.error, borderColor: tokens.colors.accent.error + '40' }}
            >
              {t('disable2FAButton')}
            </Button>
          </Box>
        )}

        {props.showDisable2FA && (
          <Box style={{
            marginTop: tokens.spacing[3],
            padding: tokens.spacing[4],
            borderRadius: tokens.radius.md,
            background: tokens.colors.bg.primary,
            border: `1px solid ${tokens.colors.accent.error}30`,
          }}>
            <Text size="sm" weight="medium" style={{ marginBottom: tokens.spacing[2] }}>
              {t('enterPasswordToDisable')}
            </Text>
            <Box style={{ display: 'flex', gap: tokens.spacing[3], alignItems: 'center' }}>
              <PasswordInput
                
                value={props.disablePassword}
                onChange={(e) => props.setDisablePassword(e.target.value)}
                placeholder={t('enterCurrentPasswordPlaceholder')}
                autoComplete="current-password"
                style={{ ...getInputStyle(), maxWidth: 240 }}
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={props.onDisable2FA}
                disabled={props.twoFALoading || !props.disablePassword}
                style={{ color: tokens.colors.accent.error, borderColor: tokens.colors.accent.error + '40' }}
              >
                {props.twoFALoading ? t('processingText') : t('confirmDisableButton')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { props.setShowDisable2FA(false); props.setDisablePassword('') }}
              >
                {t('cancel')}
              </Button>
            </Box>
          </Box>
        )}
      </Box>

      {/* Active Sessions */}
      <Box style={{ marginTop: tokens.spacing[6], paddingTop: tokens.spacing[6], borderTop: `1px solid ${tokens.colors.border.primary}` }}>
        <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
          {t('activeSessionsTitle')}
        </Text>
        <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
          {t('activeSessionsDesc')}
        </Text>

        {props.loadingSessions ? (
          <Text size="sm" color="tertiary">{t('loading')}</Text>
        ) : props.sessions.length === 0 ? (
          <Text size="sm" color="tertiary">{t('noSessionInfo')}</Text>
        ) : (
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
            {props.sessions.map((session) => (
              <Box
                key={session.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: tokens.spacing[3],
                  borderRadius: tokens.radius.md,
                  background: tokens.colors.bg.primary,
                  border: `1px solid ${session.isCurrent ? tokens.colors.accent.success + '40' : tokens.colors.border.primary}`,
                }}
              >
                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
                  <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                    <Text size="sm" weight="medium">
                      {session.deviceInfo?.browser || t('unknownBrowser')}
                      {session.deviceInfo?.os ? ` - ${session.deviceInfo.os}` : ''}
                    </Text>
                    {session.isCurrent && (
                      <span style={{
                        padding: `1px ${tokens.spacing[2]}`,
                        borderRadius: tokens.radius.sm,
                        background: `${tokens.colors.accent.success}15`,
                        color: tokens.colors.accent.success,
                        fontSize: tokens.typography.fontSize.xs,
                        fontWeight: Number(tokens.typography.fontWeight.bold),
                      }}>
                        {t('currentSessionLabel')}
                      </span>
                    )}
                  </Box>
                  <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
                    {session.ipAddress && (
                      <Text size="xs" color="tertiary">IP: {session.ipAddress}</Text>
                    )}
                    {session.lastActiveAt && (
                      <Text size="xs" color="tertiary">{formatTimeAgo(session.lastActiveAt)}</Text>
                    )}
                  </Box>
                </Box>
                {!session.isCurrent && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => props.onRevokeSession(session.id)}
                    style={{ color: tokens.colors.accent.error, fontSize: tokens.typography.fontSize.xs }}
                  >
                    {t('revokeSession')}
                  </Button>
                )}
              </Box>
            ))}

            {props.sessions.filter(s => !s.isCurrent).length > 0 && (
              <Box style={{ display: 'flex', justifyContent: 'flex-end', marginTop: tokens.spacing[2] }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    if (window.confirm(t('revokeAllSessionsConfirm') || 'Log out all other devices? This cannot be undone.')) {
                      props.onRevokeAllSessions()
                    }
                  }}
                  style={{ color: tokens.colors.accent.error, borderColor: tokens.colors.accent.error + '40' }}
                >
                  {t('logoutOtherDevicesButton')}
                </Button>
              </Box>
            )}
          </Box>
        )}
      </Box>
    </SectionCard>
  )
})
