'use client'
import PasswordInput from '@/app/components/ui/PasswordInput'

import React from 'react'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import ModalOverlay from '@/app/components/ui/ModalOverlay'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export function DeleteAccountModal({
  isOpen,
  onClose,
  password,
  setPassword,
  reason,
  setReason,
  error,
  deleting,
  onDelete,
}: {
  isOpen: boolean
  onClose: () => void
  password: string
  setPassword: (v: string) => void
  reason: string
  setReason: (v: string) => void
  error: string | null
  deleting: boolean
  onDelete: () => void
}): React.ReactElement | null {
  const { t } = useLanguage()

  return (
    <ModalOverlay
      open={isOpen}
      onClose={onClose}
      label={t('deleteAccountTitle')}
      zIndex={tokens.zIndex.max}
      raw
    >
      <Box
        style={{
          background: tokens.colors.bg.primary,
          borderRadius: tokens.radius.xl,
          padding: tokens.spacing[6],
          width: 'min(420px, calc(100vw - 32px))',
          border: `1px solid ${alpha(tokens.colors.accent.error, 25)}`,
        }}
      >
        <Text
          size="lg"
          weight="bold"
          style={{ color: tokens.colors.accent.error, marginBottom: tokens.spacing[3] }}
        >
          {t('deleteAccountTitle')}
        </Text>
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <Text size="sm" color="secondary" style={{ lineHeight: 1.6 }}>
            {t('deleteAccountDesc')}
          </Text>
          <Box
            style={{
              marginTop: tokens.spacing[3],
              padding: tokens.spacing[3],
              borderRadius: tokens.radius.md,
              background: `${alpha(tokens.colors.accent.warning, 6)}`,
              border: `1px solid ${alpha(tokens.colors.accent.warning, 19)}`,
            }}
          >
            <Text size="xs" style={{ color: tokens.colors.accent.warning, lineHeight: 1.6 }}>
              {t('deleteAccountWarning')}
            </Text>
          </Box>
          <Box
            style={{
              marginTop: tokens.spacing[2],
              padding: tokens.spacing[3],
              borderRadius: tokens.radius.md,
              background: `${alpha(tokens.colors.accent.primary, 3)}`,
              border: `1px solid ${alpha(tokens.colors.accent.primary, 13)}`,
            }}
          >
            <Text size="xs" style={{ color: tokens.colors.accent.primary, lineHeight: 1.6 }}>
              {t('deleteAccountRecoveryNote')}
            </Text>
          </Box>
        </Box>
        <Box style={{ marginBottom: tokens.spacing[3] }}>
          <label htmlFor="delete-account-password">
            <Text size="sm" weight="medium" style={{ marginBottom: tokens.spacing[2] }}>
              {t('enterPasswordToConfirm')}
            </Text>
          </label>
          <PasswordInput
            id="delete-account-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('enterCurrentPassword')}
            autoComplete="current-password"
            style={{
              width: '100%',
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.secondary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
            }}
          />
        </Box>
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <label htmlFor="delete-account-reason">
            <Text size="sm" weight="medium" style={{ marginBottom: tokens.spacing[2] }}>
              {t('deleteReasonOptional')}
            </Text>
          </label>
          <input
            id="delete-account-reason"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('tellUsWhy')}
            style={{
              width: '100%',
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.secondary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
            }}
          />
        </Box>
        {error && (
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
              marginBottom: tokens.spacing[3],
            }}
          >
            <Text size="xs" style={{ color: tokens.colors.accent.error, flex: 1 }}>
              {error}
            </Text>
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              disabled={deleting}
              style={{
                color: tokens.colors.accent.error,
                fontSize: tokens.typography.fontSize.xs,
                padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
              }}
            >
              {t('retry')}
            </Button>
          </Box>
        )}
        <Box style={{ display: 'flex', gap: tokens.spacing[3], justifyContent: 'flex-end' }}>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onDelete}
            disabled={!password || deleting}
            style={{
              background: tokens.colors.accent.error,
              opacity: !password || deleting ? 0.5 : 1,
            }}
          >
            {deleting ? t('processing') : t('confirmDeleteAccount')}
          </Button>
        </Box>
      </Box>
    </ModalOverlay>
  )
}
