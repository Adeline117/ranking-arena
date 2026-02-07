'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
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
  if (!isOpen) return null

  return (
    <Box
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999,
        padding: tokens.spacing[4],
      }}
      onClick={onClose}
    >
      <Box
        onClick={(e) => e.stopPropagation()}
        style={{
          background: tokens.colors.bg.primary,
          borderRadius: tokens.radius.xl,
          padding: tokens.spacing[6],
          maxWidth: 420,
          width: '100%',
          border: `1px solid ${tokens.colors.accent.error}40`,
        }}
      >
        <Text size="lg" weight="bold" style={{ color: tokens.colors.accent.error, marginBottom: tokens.spacing[3] }}>
          {t('deleteAccountTitle')}
        </Text>
        <Box style={{ marginBottom: tokens.spacing[4] }}>
          <Text size="sm" color="secondary" style={{ lineHeight: 1.6 }}>
            {t('deleteAccountDesc')}
          </Text>
          <Box style={{
            marginTop: tokens.spacing[3],
            padding: tokens.spacing[3],
            borderRadius: tokens.radius.md,
            background: `${tokens.colors.accent.warning}10`,
            border: `1px solid ${tokens.colors.accent.warning}30`,
          }}>
            <Text size="xs" style={{ color: tokens.colors.accent.warning }}>
              {t('deleteAccountWarning')}
            </Text>
          </Box>
        </Box>
        <Box style={{ marginBottom: tokens.spacing[3] }}>
          <Text size="sm" weight="medium" style={{ marginBottom: tokens.spacing[2] }}>{t('enterPasswordToConfirm')}</Text>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('enterCurrentPassword')}
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
          <Text size="sm" weight="medium" style={{ marginBottom: tokens.spacing[2] }}>{t('deleteReasonOptional')}</Text>
          <input
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
          <Text size="xs" style={{ color: tokens.colors.accent.error, marginBottom: tokens.spacing[3] }}>
            {error}
          </Text>
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
    </Box>
  )
}
