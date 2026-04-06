'use client'
import PasswordInput from '@/app/components/ui/PasswordInput'

import React, { useEffect, useRef } from 'react'
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
  const modalRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!isOpen) return
    previousFocusRef.current = document.activeElement as HTMLElement
    const timer = setTimeout(() => {
      if (modalRef.current) {
        const firstInput = modalRef.current.querySelector<HTMLElement>('input, button')
        firstInput?.focus()
      }
    }, 50)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'Tab' && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus() }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus() }
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', handleKeyDown)
      previousFocusRef.current?.focus()
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <Box
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        background: 'var(--color-backdrop)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: tokens.zIndex.max,
        padding: tokens.spacing[4],
      }}
      onClick={onClose}
    >
      <Box
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-account-modal-title"
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
        <Text id="delete-account-modal-title" size="lg" weight="bold" style={{ color: tokens.colors.accent.error, marginBottom: tokens.spacing[3] }}>
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
            <Text size="xs" style={{ color: tokens.colors.accent.warning, lineHeight: 1.6 }}>
              {t('deleteAccountWarning')}
            </Text>
          </Box>
          <Box style={{
            marginTop: tokens.spacing[2],
            padding: tokens.spacing[3],
            borderRadius: tokens.radius.md,
            background: `${tokens.colors.accent.primary}08`,
            border: `1px solid ${tokens.colors.accent.primary}20`,
          }}>
            <Text size="xs" style={{ color: tokens.colors.accent.primary, lineHeight: 1.6 }}>
              {t('deleteAccountRecoveryNote') || 'Your account will be deactivated for 30 days before permanent deletion. You can log back in during this period to cancel.'}
            </Text>
          </Box>
        </Box>
        <Box style={{ marginBottom: tokens.spacing[3] }}>
          <label htmlFor="delete-account-password">
            <Text size="sm" weight="medium" style={{ marginBottom: tokens.spacing[2] }}>{t('enterPasswordToConfirm')}</Text>
          </label>
          <input
            id="delete-account-password"
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
          <label htmlFor="delete-account-reason">
            <Text size="sm" weight="medium" style={{ marginBottom: tokens.spacing[2] }}>{t('deleteReasonOptional')}</Text>
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
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
            <Text size="xs" style={{ color: tokens.colors.accent.error, flex: 1 }}>
              {error}
            </Text>
            <Button variant="ghost" size="sm" onClick={onDelete} disabled={deleting} style={{ color: tokens.colors.accent.error, fontSize: tokens.typography.fontSize.xs, padding: `${tokens.spacing[1]} ${tokens.spacing[2]}` }}>
              {t('retry') || 'Retry'}
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
    </Box>
  )
}
