'use client'

import React, { Suspense, useEffect, useState, useCallback, useRef } from 'react'
import Image from 'next/image'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box, Text, Button } from '@/app/components/base'
import Avatar from '@/app/components/ui/Avatar'
import ExchangeConnectionManager from '@/app/components/exchange/ExchangeConnection'
import { useToast } from '@/app/components/ui/Toast'
import { useDialog } from '@/app/components/ui/Dialog'
import { uiLogger } from '@/lib/utils/logger'
import { formatTimeAgo } from '@/lib/utils/date'
import AdvancedAlerts from '@/app/components/pro/AdvancedAlerts'
import { WalletSection } from '@/app/components/settings/WalletSection'
import { ImageCropper } from '@/app/components/ui/ImageCropper'
import { useSubscription } from '@/app/components/home/hooks/useSubscription'
import { useMultiAccount } from '@/lib/hooks/useMultiAccount'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import {
  validateHandle,
  validateEmail,
  validatePassword,
  validatePasswordMatch,
  MAX_BIO_LENGTH,
  MAX_HANDLE_LENGTH,
} from './validation'
import { isHapticSupported, haptic } from '@/lib/utils/haptics'

// Section IDs for navigation
type SectionId = 'profile' | 'security' | 'wallet' | 'exchanges' | 'alerts' | 'notifications' | 'privacy' | 'account'

const SECTION_ICONS: Record<SectionId, React.ReactNode> = {
  profile: (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
  security: (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  ),
  wallet: (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M22 10H18a2 2 0 0 0-2 2 2 2 0 0 0 2 2h4" />
    </svg>
  ),
  exchanges: (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  ),
  alerts: (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      <line x1="12" y1="2" x2="12" y2="4" />
    </svg>
  ),
  notifications: (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  ),
  privacy: (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  account: (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
}

// Section labels are now retrieved via t() function for i18n support
const SECTION_KEYS: Record<SectionId, string> = {
  profile: 'profileSection',
  security: 'securitySection',
  wallet: 'walletSection',
  exchanges: 'exchangesSection',
  alerts: 'alertsSection',
  notifications: 'notificationsSection',
  privacy: 'privacySection',
  account: 'accountSection',
}

const SECTION_IDS: SectionId[] = ['profile', 'security', 'wallet', 'exchanges', 'alerts', 'notifications', 'privacy', 'account']

// Toggle switch component
function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        padding: 2,
        border: 'none',
        background: checked ? '#8b6fa8' : tokens.colors.bg.tertiary,
        cursor: 'pointer',
        transition: 'background 0.2s ease',
        position: 'relative',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          display: 'block',
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: '#fff',
          transform: checked ? 'translateX(18px)' : 'translateX(0)',
          transition: 'transform 0.2s ease',
          boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        }}
      />
    </button>
  )
}

// Reusable section card component
function SectionCard({
  id,
  title,
  description,
  children,
  variant = 'default',
}: {
  id: string
  title: string
  description?: string
  children: React.ReactNode
  variant?: 'default' | 'danger'
}) {
  return (
    <Box
      id={id}
      style={{
        marginBottom: tokens.spacing[6],
        padding: tokens.spacing[6],
        borderRadius: tokens.radius.xl,
        background: tokens.colors.bg.secondary,
        border: `1px solid ${variant === 'danger' ? tokens.colors.accent.error + '30' : tokens.colors.border.primary}`,
      }}
    >
      <Text
        size="lg"
        weight="black"
        style={{
          marginBottom: description ? tokens.spacing[1] : tokens.spacing[4],
          color: variant === 'danger' ? tokens.colors.accent.error : tokens.colors.text.primary,
        }}
      >
        {title}
      </Text>
      {description && (
        <Text size="sm" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
          {description}
        </Text>
      )}
      {children}
    </Box>
  )
}

// Trader Links Section Component
interface TraderLink {
  id: string
  trader_id: string
  source: string
  handle: string | null
  verified_at: string
  created_at: string
}

function TraderLinksSection({ userId }: { userId: string }) {
  const [links, setLinks] = useState<TraderLink[]>([])
  const [loadingLinks, setLoadingLinks] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)
  const { showToast } = useToast()
  const { showConfirm } = useDialog()
  const { t } = useLanguage()

  const loadLinks = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return

      const res = await fetch('/api/traders/link', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        const data = await res.json()
        setLinks(data.links || [])
      }
    } catch (error) {
      console.error('[TraderLinks] Load error:', error)
    } finally {
      setLoadingLinks(false)
    }
  }, [])

  useEffect(() => {
    loadLinks()
  }, [loadLinks])

  const handleDelete = async (linkId: string) => {
    const confirmed = await showConfirm(t('unlinkConfirm'), t('unlinkConfirmMsg'))
    if (!confirmed) return

    setDeleting(linkId)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return

      const res = await fetch(`/api/traders/link?id=${linkId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        setLinks((prev) => prev.filter((l) => l.id !== linkId))
        showToast(t('unlinked'), 'success')
      } else {
        const data = await res.json()
        showToast(data.error || t('operationFailed'), 'error')
      }
    } catch {
      showToast(t('networkError'), 'error')
    } finally {
      setDeleting(null)
    }
  }

  const getSourceLabel = (source: string) => {
    const futuresLabel = t('futures')
    const spotLabel = t('spot')
    const onChainLabel = t('onChain')
    const map: Record<string, string> = {
      binance_futures: futuresLabel,
      binance_spot: spotLabel,
      binance_web3: onChainLabel,
      bybit: futuresLabel,
      bitget_futures: futuresLabel,
      bitget_spot: spotLabel,
      mexc: futuresLabel,
      coinex: futuresLabel,
      okx_web3: onChainLabel,
      kucoin: futuresLabel,
      gmx: onChainLabel,
    }
    return map[source] || source
  }

  if (loadingLinks) {
    return (
      <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
        <Text size="sm" color="tertiary">{t('loadingText')}</Text>
      </Box>
    )
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
      {links.length === 0 ? (
        <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
          <Text size="sm" color="tertiary">{t('noLinkedTraders')}</Text>
          <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
            {t('linkTraderHint')}
          </Text>
        </Box>
      ) : (
        <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
          {links.map((link) => (
            <Box
              key={link.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: tokens.spacing[3],
                borderRadius: tokens.radius.md,
                background: tokens.colors.bg.primary,
                border: `1px solid ${tokens.colors.border.primary}`,
              }}
            >
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
                <Box
                  style={{
                    padding: `2px ${tokens.spacing[2]}`,
                    borderRadius: tokens.radius.sm,
                    background: `${tokens.colors.accent.primary}15`,
                    border: `1px solid ${tokens.colors.accent.primary}30`,
                  }}
                >
                  <Text size="xs" weight="bold" style={{ color: tokens.colors.accent.primary }}>
                    {getSourceLabel(link.source)}
                  </Text>
                </Box>
                <Box>
                  <Text size="sm" weight="medium">
                    {link.handle || link.trader_id}
                  </Text>
                  <Text size="xs" color="tertiary">
                    {new Date(link.verified_at).toLocaleDateString()} {t('certifiedAt')}
                  </Text>
                </Box>
              </Box>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDelete(link.id)}
                disabled={deleting === link.id}
                style={{
                  color: tokens.colors.accent.error,
                  fontSize: tokens.typography.fontSize.xs,
                  padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
                }}
              >
                {deleting === link.id ? '...' : t('unlinkButton')}
              </Button>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}

// Reusable input styles
function getInputStyle(hasError = false): React.CSSProperties {
  return {
    width: '100%',
    padding: tokens.spacing[3],
    borderRadius: tokens.radius.md,
    border: `1px solid ${hasError ? tokens.colors.accent.error : tokens.colors.border.primary}`,
    background: tokens.colors.bg.primary,
    color: tokens.colors.text.primary,
    fontSize: tokens.typography.fontSize.base,
    fontFamily: tokens.typography.fontFamily.sans.join(', '),
    outline: 'none',
    transition: 'border-color 0.2s ease',
  }
}

// Reusable radio option component
function RadioOption<T extends string>({
  value,
  currentValue,
  label,
  description,
  onChange,
  name,
}: {
  value: T
  currentValue: T
  label: string
  description: string
  onChange: (v: T) => void
  name: string
}): React.ReactElement {
  const isSelected = currentValue === value
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: tokens.spacing[3],
        cursor: 'pointer',
        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.md,
        border: `1px solid ${isSelected ? tokens.colors.accent.primary + '40' : 'transparent'}`,
        background: isSelected ? `${tokens.colors.accent.primary}08` : 'transparent',
        transition: 'all 0.15s ease',
      }}
    >
      <input
        type="radio"
        name={name}
        checked={isSelected}
        onChange={() => onChange(value)}
        style={{ width: 18, height: 18, accentColor: '#8b6fa8', marginTop: 2 }}
      />
      <Box>
        <Text size="sm" weight="medium">{label}</Text>
        <Text size="xs" color="tertiary">{description}</Text>
      </Box>
    </label>
  )
}

// Delete Account Modal Component
function DeleteAccountModal({
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

function MultiAccountSection() {
  const { accounts, activeAccount, inactiveAccounts, canAddAccount, isPro, removeAccount, switchAccount, signOutAll } = useMultiAccount()
  const router = useRouter()
  const { t } = useLanguage()
  const [switchingId, setSwitchingId] = useState<string | null>(null)

  const handleSwitch = async (userId: string) => {
    setSwitchingId(userId)
    const result = await switchAccount(userId)
    setSwitchingId(null)
    if (result.success) {
      router.refresh()
    }
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
      {accounts.map((account) => (
        <Box
          key={account.userId}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.spacing[2],
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            background: account.isActive ? `${tokens.colors.accent.primary}10` : 'transparent',
            border: `1px solid ${account.isActive ? tokens.colors.accent.primary + '30' : tokens.colors.border.primary}`,
          }}
        >
          <Box style={{
            width: 24, height: 24, borderRadius: '50%',
            background: tokens.colors.accent.primary + '20',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 700, color: tokens.colors.accent.primary,
          }}>
            {(account.handle?.[0] || account.email[0] || 'U').toUpperCase()}
          </Box>
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Text size="xs" weight={account.isActive ? 'bold' : 'normal'} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {account.handle || account.email}
            </Text>
          </Box>
          {account.isActive ? (
            <Text size="xs" style={{ color: tokens.colors.accent.success }}>{t('current')}</Text>
          ) : (
            <Box style={{ display: 'flex', gap: tokens.spacing[1] }}>
              <button
                onClick={() => handleSwitch(account.userId)}
                disabled={!!switchingId}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  fontSize: 11, color: tokens.colors.accent.primary,
                  opacity: switchingId ? 0.5 : 1,
                }}
              >
                {switchingId === account.userId ? '...' : t('switchAccount')}
              </button>
              <button
                onClick={() => removeAccount(account.userId)}
                style={{
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  fontSize: 11, color: tokens.colors.text.tertiary,
                }}
              >
                {t('removeAccount')}
              </button>
            </Box>
          )}
        </Box>
      ))}
      <Box
        onClick={() => {
          if (!isPro && accounts.length >= 1) {
            router.push('/settings?section=subscription')
          } else {
            router.push('/login?addAccount=true')
          }
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: tokens.spacing[2],
          padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
          borderRadius: tokens.radius.md,
          border: `1px dashed ${tokens.colors.border.secondary}`,
          cursor: 'pointer',
          transition: `all ${tokens.transition.base}`,
        }}
      >
        <Text size="xs" color="tertiary">+ {t('addAccount')}</Text>
        {!isPro && (
          <Box style={{
            marginLeft: 'auto',
            padding: `1px ${tokens.spacing[1]}`,
            borderRadius: tokens.radius.sm,
            background: 'linear-gradient(135deg, #8b6fa8, #b794d4)',
            color: '#fff', fontSize: 9, fontWeight: 700,
          }}>
            Pro
          </Box>
        )}
      </Box>
    </Box>
  )
}

function SettingsContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { showToast } = useToast()
  const { showConfirm } = useDialog()
  const { t, language } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)
  const [userId, setUserId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activeSection, setActiveSection] = useState<SectionId>('profile')

  // Profile data
  const [handle, setHandle] = useState('')
  const [bio, setBio] = useState('')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [coverUrl, setCoverUrl] = useState<string | null>(null)
  const [coverFile, setCoverFile] = useState<File | null>(null)
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null)

  // Image cropper state
  const [showAvatarCropper, setShowAvatarCropper] = useState(false)
  const [showCoverCropper, setShowCoverCropper] = useState(false)
  const [cropImageSrc, setCropImageSrc] = useState<string | null>(null)

  // Initial values for tracking changes
  const initialValuesRef = useRef<{
    handle: string
    bio: string
    avatarUrl: string | null
    coverUrl: string | null
    notifyFollow: boolean
    notifyLike: boolean
    notifyComment: boolean
    notifyMention: boolean
    notifyMessage: boolean
    showFollowers: boolean
    showFollowing: boolean
    dmPermission: string
    showProBadge: boolean
  } | null>(null)

  // Password change
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)
  const [passwordResetMode, setPasswordResetMode] = useState<'password' | 'code'>('password')
  const [resetCodeSent, setResetCodeSent] = useState(false)
  const [sendingResetCode, setSendingResetCode] = useState(false)
  const [resetCountdown, setResetCountdown] = useState(0)

  // Email change
  const [newEmail, setNewEmail] = useState('')
  const [savingEmail, setSavingEmail] = useState(false)

  // Notification preferences
  const [notifyFollow, setNotifyFollow] = useState(true)
  const [notifyLike, setNotifyLike] = useState(true)
  const [notifyComment, setNotifyComment] = useState(true)
  const [notifyMention, setNotifyMention] = useState(true)
  const [notifyMessage, setNotifyMessage] = useState(true)
  const [hapticEnabled, setHapticEnabled] = useState(true) // 震动反馈
  const [savingNotifications, setSavingNotifications] = useState(false)

  // Privacy settings
  const [showFollowers, setShowFollowers] = useState(true)
  const [showFollowing, setShowFollowing] = useState(true)
  const [dmPermission, setDmPermission] = useState<'all' | 'mutual' | 'none'>('all')
  const [showProBadge, setShowProBadge] = useState(true)

  // 2FA state
  const [twoFAEnabled, setTwoFAEnabled] = useState(false)
  const [twoFASetupData, setTwoFASetupData] = useState<{ qrCodeDataUrl: string; secret: string } | null>(null)
  const [twoFACode, setTwoFACode] = useState('')
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [twoFALoading, setTwoFALoading] = useState(false)
  const [disablePassword, setDisablePassword] = useState('')
  const [showDisable2FA, setShowDisable2FA] = useState(false)

  // Sessions state
  interface SessionInfo {
    id: string
    deviceInfo: { browser?: string; os?: string } | null
    ipAddress: string | null
    lastActiveAt: string | null
    isCurrent: boolean
  }
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [loadingSessions, setLoadingSessions] = useState(false)

  // Blocked users state
  interface BlockedUserInfo {
    blockedId: string
    handle: string | null
    avatarUrl: string | null
    createdAt: string
  }
  const [blockedUsers, setBlockedUsers] = useState<BlockedUserInfo[]>([])
  const [loadingBlockedUsers, setLoadingBlockedUsers] = useState(false)
  const [unblockingId, setUnblockingId] = useState<string | null>(null)

  // Email digest state
  const [emailDigest, setEmailDigest] = useState<'none' | 'daily' | 'weekly'>('none')

  // Pro subscription status
  const { isPro } = useSubscription()

  // Account deletion state
  const [showDeleteAccountModal, setShowDeleteAccountModal] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [deleteReason, setDeleteReason] = useState('')
  const [deletingAccount, setDeletingAccount] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Handle uniqueness check
  const [handleAvailable, setHandleAvailable] = useState<boolean | null>(null)
  const [checkingHandle, setCheckingHandle] = useState(false)
  const handleCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const submittingRef = useRef(false) // Prevent double submissions

  // Debounced handle uniqueness check
  useEffect(() => {
    if (!handle || handle.length < 2 || !validateHandle(handle, t).valid) {
      setHandleAvailable(null)
      return
    }
    // Don't check if it's the same as initial
    if (initialValuesRef.current && handle === initialValuesRef.current.handle) {
      setHandleAvailable(null)
      return
    }

    if (handleCheckTimeoutRef.current) {
      clearTimeout(handleCheckTimeoutRef.current)
    }

    setCheckingHandle(true)
    handleCheckTimeoutRef.current = setTimeout(async () => {
      try {
        const { data } = await supabase
          .from('user_profiles')
          .select('id')
          .eq('handle', handle)
          .neq('id', userId || '')
          .maybeSingle()

        setHandleAvailable(!data)
      } catch {
        setHandleAvailable(null)
      } finally {
        setCheckingHandle(false)
      }
    }, 500)

    return () => {
      if (handleCheckTimeoutRef.current) {
        clearTimeout(handleCheckTimeoutRef.current)
      }
    }
  }, [handle, userId])

  // Validation state
  const [touchedFields, setTouchedFields] = useState<{
    handle: boolean
    newPassword: boolean
    confirmPassword: boolean
    newEmail: boolean
  }>({ handle: false, newPassword: false, confirmPassword: false, newEmail: false })

  // Validation results
  const handleValidation = validateHandle(handle, t)
  const newPasswordValidation = validatePassword(newPassword, t)
  const confirmPasswordValidation = validatePasswordMatch(newPassword, confirmNewPassword, t)
  const newEmailValidation = validateEmail(newEmail, t)

  const markTouched = (field: keyof typeof touchedFields) => {
    setTouchedFields(prev => ({ ...prev, [field]: true }))
  }

  // Check if there are unsaved profile changes
  const hasUnsavedChanges = useCallback(() => {
    if (!initialValuesRef.current) return false
    const initial = initialValuesRef.current
    return (
      handle !== initial.handle ||
      bio !== initial.bio ||
      avatarFile !== null ||
      coverFile !== null ||
      notifyFollow !== initial.notifyFollow ||
      notifyLike !== initial.notifyLike ||
      notifyComment !== initial.notifyComment ||
      notifyMention !== initial.notifyMention ||
      notifyMessage !== initial.notifyMessage ||
      showFollowers !== initial.showFollowers ||
      showFollowing !== initial.showFollowing ||
      dmPermission !== initial.dmPermission ||
      showProBadge !== initial.showProBadge
    )
  }, [handle, bio, avatarFile, coverFile, notifyFollow, notifyLike, notifyComment, notifyMention, notifyMessage, showFollowers, showFollowing, dmPermission, showProBadge])

  // Warn before leaving with unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges()) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasUnsavedChanges])

  // Handle section from URL
  useEffect(() => {
    const section = searchParams.get('section') as SectionId | null
    if (section && SECTION_IDS.includes(section)) {
      setActiveSection(section)
      // Scroll to section after a short delay for DOM to render
      setTimeout(() => {
        document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
    }
  }, [searchParams])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null)
      setUserId(data.user?.id ?? null)

      if (!data.user) {
        router.push('/login')
        return
      }

      loadProfile(data.user.id)
    })
  }, [router])

  const loadProfile = async (uid: string) => {
    try {
      setLoading(true)

      const { data: userProfile } = await supabase
        .from('user_profiles')
        .select('handle, bio, avatar_url, cover_url, notify_follow, notify_like, notify_comment, notify_mention, notify_message, show_followers, show_following, dm_permission, show_pro_badge, totp_enabled, email_digest')
        .eq('id', uid)
        .maybeSingle()

      if (userProfile) {
        const profileHandle = userProfile.handle || ''
        const profileBio = userProfile.bio || ''
        const profileAvatarUrl = userProfile.avatar_url || null
        const profileCoverUrl = userProfile.cover_url || null
        const profileNotifyFollow = userProfile.notify_follow !== false
        const profileNotifyLike = userProfile.notify_like !== false
        const profileNotifyComment = userProfile.notify_comment !== false
        const profileNotifyMention = userProfile.notify_mention !== false
        const profileNotifyMessage = userProfile.notify_message !== false
        const profileShowFollowers = userProfile.show_followers !== false
        const profileShowFollowing = userProfile.show_following !== false
        const profileDmPermission = userProfile.dm_permission || 'all'
        const profileShowProBadge = userProfile.show_pro_badge !== false
        const profileTotpEnabled = userProfile.totp_enabled === true
        const profileEmailDigest = (userProfile.email_digest as 'none' | 'daily' | 'weekly') || 'none'

        setHandle(profileHandle)
        setTwoFAEnabled(profileTotpEnabled)
        setEmailDigest(profileEmailDigest)
        setBio(profileBio)
        setAvatarUrl(profileAvatarUrl)
        setPreviewUrl(profileAvatarUrl)
        setCoverUrl(profileCoverUrl)
        setCoverPreviewUrl(profileCoverUrl)
        setNotifyFollow(profileNotifyFollow)
        setNotifyLike(profileNotifyLike)
        setNotifyComment(profileNotifyComment)
        setNotifyMention(profileNotifyMention)
        setNotifyMessage(profileNotifyMessage)
        setShowFollowers(profileShowFollowers)
        setShowFollowing(profileShowFollowing)
        setDmPermission(profileDmPermission)
        setShowProBadge(profileShowProBadge)

        initialValuesRef.current = {
          handle: profileHandle,
          bio: profileBio,
          avatarUrl: profileAvatarUrl,
          coverUrl: profileCoverUrl,
          notifyFollow: profileNotifyFollow,
          notifyLike: profileNotifyLike,
          notifyComment: profileNotifyComment,
          notifyMention: profileNotifyMention,
          notifyMessage: profileNotifyMessage,
          showFollowers: profileShowFollowers,
          showFollowing: profileShowFollowing,
          dmPermission: profileDmPermission,
          showProBadge: profileShowProBadge,
        }
      }

    } catch (error) {
      uiLogger.error('Error loading profile:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        showToast(t('imageSizeExceed').replace('{size}', '5'), 'error')
        return
      }
      // Show cropper instead of directly setting the file
      const reader = new FileReader()
      reader.onloadend = () => {
        setCropImageSrc(reader.result as string)
        setShowAvatarCropper(true)
      }
      reader.readAsDataURL(file)
    }
    // Reset input so the same file can be selected again
    e.target.value = ''
  }

  const handleAvatarCropComplete = (croppedBlob: Blob) => {
    try {
      // Create a File from the Blob
      const croppedFile = new File([croppedBlob], 'avatar.jpg', { type: 'image/jpeg' })
      setAvatarFile(croppedFile)
      // Create preview URL
      const previewUrl = URL.createObjectURL(croppedBlob)
      setPreviewUrl(previewUrl)
      // Close cropper
      setShowAvatarCropper(false)
      setCropImageSrc(null)
      // Show success message
      showToast(t('cropSuccess') || 'Crop successful! Click Save to upload.', 'success')
    } catch (error) {
      console.error('Error in handleAvatarCropComplete:', error)
      showToast(t('cropFailed') || 'Failed to process cropped image', 'error')
    }
  }

  const handleCoverChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      if (file.size > 10 * 1024 * 1024) {
        showToast(t('imageSizeExceed').replace('{size}', '10'), 'error')
        return
      }
      // Show cropper instead of directly setting the file
      const reader = new FileReader()
      reader.onloadend = () => {
        setCropImageSrc(reader.result as string)
        setShowCoverCropper(true)
      }
      reader.readAsDataURL(file)
    }
    // Reset input so the same file can be selected again
    e.target.value = ''
  }

  const handleCoverCropComplete = (croppedBlob: Blob) => {
    try {
      // Create a File from the Blob
      const croppedFile = new File([croppedBlob], 'cover.jpg', { type: 'image/jpeg' })
      setCoverFile(croppedFile)
      // Create preview URL
      const coverPreview = URL.createObjectURL(croppedBlob)
      setCoverPreviewUrl(coverPreview)
      // Close cropper
      setShowCoverCropper(false)
      setCropImageSrc(null)
      // Show success message
      showToast(t('cropSuccess') || 'Crop successful! Click Save to upload.', 'success')
    } catch (error) {
      console.error('Error in handleCoverCropComplete:', error)
      showToast(t('cropFailed') || 'Failed to process cropped image', 'error')
    }
  }

  const uploadFile = async (file: File, bucket: string, userId: string, maxSize: number): Promise<string | null> => {
    try {
      if (file.size > maxSize) {
        showToast(t('imageSizeExceed').replace('{size}', String(Math.round(maxSize / 1024 / 1024))), 'error')
        return null
      }

      const fileExt = file.name.split('.').pop()?.toLowerCase()
      if (!['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileExt || '')) {
        showToast(t('onlySupportFormats'), 'error')
        return null
      }

      // Use server-side API for upload (bypasses RLS)
      const formData = new FormData()
      formData.append('file', file)
      formData.append('userId', userId)
      formData.append('bucket', bucket)

      const response = await fetch('/api/upload-profile-image', {
        method: 'POST',
        body: formData
      })

      const result = await response.json()

      if (!response.ok) {
        uiLogger.error(`${bucket} upload error:`, result.error)
        showToast(result.error || t('uploadFailed'), 'error')
        return null
      }

      return result.url
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : t('unknownError')
      showToast(`${t('uploadException')}: ${errorMessage}`, 'error')
      return null
    }
  }

  const handleSaveProfile = async () => {
    if (submittingRef.current || saving) return
    if (!userId) return

    // Validate handle before saving
    if (handle && !handleValidation.valid) {
      showToast(handleValidation.message, 'error')
      return
    }
    if (handle && handleAvailable === false) {
      showToast(t('usernameInUse'), 'error')
      return
    }

    submittingRef.current = true
    setSaving(true)
    try {
      const { data: currentProfile } = await supabase
        .from('user_profiles')
        .select('avatar_url, cover_url')
        .eq('id', userId)
        .maybeSingle()

      let finalAvatarUrl = avatarUrl
      let finalCoverUrl = coverUrl
      let uploadFailed = false

      if (avatarFile) {
        const uploadedUrl = await uploadFile(avatarFile, 'avatars', userId, 5 * 1024 * 1024)
        if (uploadedUrl) {
          finalAvatarUrl = uploadedUrl
          setAvatarUrl(uploadedUrl)
          setPreviewUrl(uploadedUrl)
        } else {
          // 上传失败，恢复原来的头像
          uploadFailed = true
          setAvatarFile(null)
          if (currentProfile?.avatar_url) {
            finalAvatarUrl = currentProfile.avatar_url
            setPreviewUrl(currentProfile.avatar_url)
          } else {
            setPreviewUrl(null)
          }
        }
      }

      if (coverFile) {
        const uploadedUrl = await uploadFile(coverFile, 'covers', userId, 10 * 1024 * 1024)
        if (uploadedUrl) {
          finalCoverUrl = uploadedUrl
          setCoverUrl(uploadedUrl)
          setCoverPreviewUrl(uploadedUrl)
        } else {
          // 上传失败，恢复原来的背景图
          uploadFailed = true
          setCoverFile(null)
          if (currentProfile?.cover_url) {
            finalCoverUrl = currentProfile.cover_url
            setCoverPreviewUrl(currentProfile.cover_url)
          } else {
            setCoverPreviewUrl(null)
          }
        }
      }

      const { error: saveError } = await supabase
        .from('user_profiles')
        .upsert(
          {
            id: userId,
            handle: handle || null,
            bio: bio || null,
            avatar_url: finalAvatarUrl || null,
            cover_url: finalCoverUrl || null,
            notify_follow: notifyFollow,
            notify_like: notifyLike,
            notify_comment: notifyComment,
            notify_mention: notifyMention,
            notify_message: notifyMessage,
            show_followers: showFollowers,
            show_following: showFollowing,
            dm_permission: dmPermission,
            show_pro_badge: showProBadge,
          },
          { onConflict: 'id' }
        )

      if (saveError) {
        uiLogger.error('Error saving profile:', JSON.stringify(saveError, null, 2))
        if (saveError.code === '23505' || saveError.message?.includes('unique') || saveError.message?.includes('duplicate')) {
          showToast(t('usernameInUse'), 'error')
        } else {
          showToast(t('saveFailedWithMsg').replace('{msg}', saveError.message || ''), 'error')
        }
        return
      }

      // Update initial values after successful save
      initialValuesRef.current = {
        handle,
        bio,
        avatarUrl: finalAvatarUrl,
        coverUrl: finalCoverUrl,
        notifyFollow,
        notifyLike,
        notifyComment,
        notifyMention,
        notifyMessage,
        showFollowers,
        showFollowing,
        dmPermission,
        showProBadge,
      }
      setAvatarFile(null)
      setCoverFile(null)

      // Revalidate profile page cache
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (session?.access_token) {
          await fetch('/api/revalidate/profile', {
            method: 'POST',
            headers: { Authorization: `Bearer ${session.access_token}` },
          })
        }
      } catch (revalidateError) {
        console.warn('[Settings] Failed to revalidate profile cache:', revalidateError)
      }

      if (uploadFailed) {
        showToast(t('settingsPartialSaved'), 'warning')
      } else {
        showToast(t('settingsSaved'), 'success')
      }

      // Refresh the page to reflect changes immediately
      router.refresh()
    } catch (error) {
      uiLogger.error('Error saving:', error)
      showToast(t('saveFailedRetry'), 'error')
    } finally {
      setSaving(false)
      submittingRef.current = false
    }
  }

  // Reset countdown timer
  useEffect(() => {
    if (resetCountdown > 0) {
      const timer = setTimeout(() => setResetCountdown(resetCountdown - 1), 1000)
      return () => clearTimeout(timer)
    }
  }, [resetCountdown])

  const handleSendResetCode = async () => {
    if (submittingRef.current || sendingResetCode) return
    if (!email) {
      showToast(t('cannotGetEmail'), 'error')
      return
    }

    submittingRef.current = true
    setSendingResetCode(true)
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      })

      if (error) {
        showToast(error.message, 'error')
        return
      }

      setResetCodeSent(true)
      setResetCountdown(60)
      showToast(t('resetEmailSent'), 'success')
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : t('sendFailed')
      showToast(msg, 'error')
    } finally {
      setSendingResetCode(false)
      submittingRef.current = false
    }
  }

  const handleChangePassword = async () => {
    if (submittingRef.current || savingPassword) return
    if (!currentPassword) {
      showToast(t('enterCurrentPasswordFirst'), 'warning')
      return
    }
    if (!newPassword || !newPasswordValidation.valid) {
      showToast(t('enterValidNewPassword'), 'warning')
      return
    }
    if (!confirmPasswordValidation.valid) {
      showToast(t('passwordsNotMatch'), 'warning')
      return
    }

    submittingRef.current = true
    setSavingPassword(true)
    try {
      if (!email) {
        showToast(t('cannotGetEmail'), 'error')
        return
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password: currentPassword,
      })

      if (signInError) {
        showToast(t('currentPasswordWrong'), 'error')
        return
      }

      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      })

      if (error) {
        showToast(error.message, 'error')
        return
      }

      showToast(t('passwordChanged'), 'success')
      setCurrentPassword('')
      setNewPassword('')
      setConfirmNewPassword('')
      setTouchedFields(prev => ({ ...prev, newPassword: false, confirmPassword: false }))
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : t('changeFailed')
      showToast(msg, 'error')
    } finally {
      setSavingPassword(false)
      submittingRef.current = false
    }
  }

  const handleChangeEmail = async () => {
    if (submittingRef.current || savingEmail) return
    if (!newEmail || !newEmailValidation.valid) {
      showToast(t('enterValidEmail'), 'warning')
      return
    }

    submittingRef.current = true
    setSavingEmail(true)
    try {
      const { error } = await supabase.auth.updateUser({
        email: newEmail,
      })

      if (error) {
        showToast(error.message, 'error')
        return
      }

      showToast(t('verificationEmailSent'), 'success')
      setNewEmail('')
      setTouchedFields(prev => ({ ...prev, newEmail: false }))
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : t('changeFailed')
      showToast(msg, 'error')
    } finally {
      setSavingEmail(false)
      submittingRef.current = false
    }
  }

  // Save notification preferences
  const handleSaveNotifications = async () => {
    if (submittingRef.current || savingNotifications) return
    if (!userId) return
    submittingRef.current = true
    setSavingNotifications(true)

    try {
      const { error } = await supabase
        .from('user_profiles')
        .update({
          notify_follow: notifyFollow,
          notify_like: notifyLike,
          notify_comment: notifyComment,
          notify_mention: notifyMention,
          notify_message: notifyMessage,
        })
        .eq('id', userId)

      if (error) {
        showToast(t('saveFailedRetry'), 'error')
        return
      }

      showToast(t('notificationsSaved'), 'success')
    } catch {
      showToast(t('saveFailed'), 'error')
    } finally {
      setSavingNotifications(false)
      submittingRef.current = false
    }
  }

  // ===== 2FA Handlers =====
  const handleSetup2FA = async () => {
    if (submittingRef.current || twoFALoading) return
    submittingRef.current = true
    setTwoFALoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        showToast(t('pleaseLoginFirst'), 'error')
        return
      }

      const res = await fetch('/api/settings/2fa/setup', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      const data = await res.json()
      if (!res.ok) {
        showToast(data.error || t('operationFailed'), 'error')
        return
      }
      setTwoFASetupData({ qrCodeDataUrl: data.qrCode, secret: data.secret })
    } catch {
      showToast(t('networkError'), 'error')
    } finally {
      setTwoFALoading(false)
      submittingRef.current = false
    }
  }

  const handleVerify2FA = async () => {
    if (submittingRef.current || twoFALoading) return
    if (!twoFACode || twoFACode.length !== 6) {
      showToast(t('enter6DigitCode'), 'warning')
      return
    }
    submittingRef.current = true
    setTwoFALoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        showToast(t('pleaseLoginFirst'), 'error')
        return
      }

      const res = await fetch('/api/settings/2fa/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ code: twoFACode }),
      })
      const data = await res.json()
      if (!res.ok) {
        showToast(data.error || t('verificationFailed'), 'error')
        return
      }
      setTwoFAEnabled(true)
      setBackupCodes(data.backupCodes || [])
      setTwoFASetupData(null)
      setTwoFACode('')
      showToast(t('twoFAEnabled'), 'success')
    } catch {
      showToast(t('networkError'), 'error')
    } finally {
      setTwoFALoading(false)
      submittingRef.current = false
    }
  }

  const handleDisable2FA = async () => {
    if (submittingRef.current || twoFALoading) return
    if (!disablePassword) {
      showToast(t('enterPassword'), 'warning')
      return
    }
    submittingRef.current = true
    setTwoFALoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        showToast(t('pleaseLoginFirst'), 'error')
        return
      }

      const res = await fetch('/api/settings/2fa/disable', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ password: disablePassword }),
      })
      const data = await res.json()
      if (!res.ok) {
        showToast(data.error || t('closeFailed'), 'error')
        return
      }
      setTwoFAEnabled(false)
      setShowDisable2FA(false)
      setDisablePassword('')
      setBackupCodes([])
      showToast(t('twoFADisabled'), 'success')
    } catch {
      showToast(t('networkError'), 'error')
    } finally {
      setTwoFALoading(false)
      submittingRef.current = false
    }
  }

  // ===== Sessions Handlers =====
  const loadSessions = useCallback(async () => {
    setLoadingSessions(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) {
        setLoadingSessions(false)
        return
      }

      const res = await fetch('/api/settings/sessions', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        const data = await res.json()
        const sessionList = (data.sessions || []) as Array<{
          id: string
          deviceInfo: string | null
          ipAddress: string | null
          lastActiveAt: string | null
        }>
        // Mark the first session (most recent activity) as current
        setSessions(sessionList.map((s, index) => ({
          id: s.id,
          deviceInfo: s.deviceInfo ? (typeof s.deviceInfo === 'string' ? JSON.parse(s.deviceInfo) : s.deviceInfo) as { browser?: string; os?: string } : null,
          ipAddress: s.ipAddress,
          lastActiveAt: s.lastActiveAt,
          isCurrent: index === 0,
        })))
      }
    } catch (error) {
      uiLogger.error('[Sessions] Load error:', error)
    } finally {
      setLoadingSessions(false)
    }
  }, [])

  const handleRevokeSession = async (sessionId: string) => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return

      const res = await fetch('/api/settings/sessions', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ sessionId }),
      })
      if (res.ok) {
        setSessions(prev => prev.filter(s => s.id !== sessionId))
        showToast(t('sessionRevoked'), 'success')
      } else {
        showToast(t('operationFailed'), 'error')
      }
    } catch {
      showToast(t('networkError'), 'error')
    }
  }

  const handleRevokeAllSessions = async () => {
    const confirmed = await showConfirm(t('logoutAllDevices'), t('logoutAllDevicesConfirm'))
    if (!confirmed) return

    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return

      const res = await fetch('/api/settings/sessions', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ all: true }),
      })
      if (res.ok) {
        setSessions(prev => prev.filter(s => s.isCurrent))
        showToast(t('logoutAllSuccess'), 'success')
      } else {
        showToast(t('operationFailed'), 'error')
      }
    } catch {
      showToast(t('networkError'), 'error')
    }
  }

  // ===== Blocked Users Handlers =====
  const loadBlockedUsers = useCallback(async (uid: string) => {
    setLoadingBlockedUsers(true)
    try {
      const { data: blockedRows, error } = await supabase
        .from('blocked_users')
        .select('blocked_id, created_at')
        .eq('blocker_id', uid)

      if (error || !blockedRows || blockedRows.length === 0) {
        setBlockedUsers([])
        return
      }

      const blockedIds = blockedRows.map(r => r.blocked_id as string)
      const { data: profiles } = await supabase
        .from('user_profiles')
        .select('id, handle, avatar_url')
        .in('id', blockedIds)

      const profileMap = new Map((profiles || []).map(p => [p.id as string, p]))

      setBlockedUsers(blockedRows.map(row => {
        const profile = profileMap.get(row.blocked_id as string)
        return {
          blockedId: row.blocked_id as string,
          handle: (profile?.handle as string) || null,
          avatarUrl: (profile?.avatar_url as string) || null,
          createdAt: row.created_at as string,
        }
      }))
    } catch (error) {
      uiLogger.error('[BlockedUsers] Load error:', error)
    } finally {
      setLoadingBlockedUsers(false)
    }
  }, [])

  const handleUnblock = async (blockedId: string) => {
    setUnblockingId(blockedId)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session?.access_token) return

      const res = await fetch(`/api/users/${blockedId}/block`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.access_token}` },
      })
      if (res.ok) {
        setBlockedUsers(prev => prev.filter(u => u.blockedId !== blockedId))
        showToast(t('unblocked'), 'success')
      } else {
        showToast(t('operationFailed'), 'error')
      }
    } catch {
      showToast(t('networkError'), 'error')
    } finally {
      setUnblockingId(null)
    }
  }

  // ===== Email Digest Handler =====
  const handleEmailDigestChange = async (value: 'none' | 'daily' | 'weekly') => {
    if (!userId) return
    const previous = emailDigest
    setEmailDigest(value)
    try {
      const { error } = await supabase
        .from('user_profiles')
        .update({ email_digest: value })
        .eq('id', userId)

      if (error) {
        setEmailDigest(previous)
        showToast(t('saveFailed'), 'error')
        return
      }
      showToast(t('emailDigestSaved'), 'success')
    } catch {
      setEmailDigest(previous)
      showToast(t('saveFailed'), 'error')
    }
  }

  const handleLogout = async () => {
    const confirmed = await showConfirm(t('logoutTitle'), t('logoutConfirm'))
    if (!confirmed) return

    try {
      await supabase.auth.signOut()
      router.push('/')
    } catch {
      showToast(t('logoutFailed'), 'error')
    }
  }

  const handleDeleteAccount = async () => {
    if (!deletePassword) return
    setDeletingAccount(true)
    setDeleteError(null)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) {
        setDeleteError(t('pleaseLoginAgain'))
        return
      }
      const res = await fetch('/api/account/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ password: deletePassword, reason: deleteReason }),
      })
      const data = await res.json()
      if (!res.ok) {
        setDeleteError(data.error || t('operationFailed'))
        return
      }
      showToast(t('accountMarkedDeleted'), 'success')
      setShowDeleteAccountModal(false)
      await supabase.auth.signOut()
      router.push('/')
    } catch {
      setDeleteError(t('networkErrorRetry'))
    } finally {
      setDeletingAccount(false)
    }
  }

  // Scroll-based active section detection
  useEffect(() => {
    const handleScroll = () => {
      const sections = SECTION_IDS.map(id => document.getElementById(id))
      const scrollTop = window.scrollY + 120

      for (let i = sections.length - 1; i >= 0; i--) {
        const section = sections[i]
        if (section && section.offsetTop <= scrollTop) {
          setActiveSection(SECTION_IDS[i])
          break
        }
      }
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  // Load sessions when security section becomes active
  useEffect(() => {
    if (activeSection === 'security' && sessions.length === 0 && !loadingSessions) {
      loadSessions()
    }
  }, [activeSection, sessions.length, loadingSessions, loadSessions])

  // Load blocked users when privacy section becomes active
  useEffect(() => {
    if (activeSection === 'privacy' && userId && blockedUsers.length === 0 && !loadingBlockedUsers) {
      loadBlockedUsers(userId)
    }
  }, [activeSection, userId, blockedUsers.length, loadingBlockedUsers, loadBlockedUsers])

  // Show auth-required state if not logged in (after initial check)
  if (!loading && !userId) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{
          maxWidth: 400,
          margin: '0 auto',
          padding: tokens.spacing[8],
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: tokens.spacing[4],
        }}>
          <Box style={{
            width: 64,
            height: 64,
            borderRadius: tokens.radius.full,
            background: `${tokens.colors.accent.primary}15`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: tokens.spacing[2],
          }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.primary} strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </Box>
          <Text size="xl" weight="bold">{t('loginRequired')}</Text>
          <Text size="sm" color="secondary" style={{ lineHeight: 1.6 }}>
            {t('loginRequiredDesc')}
          </Text>
          <Button
            variant="primary"
            onClick={() => router.push('/login?redirect=/settings')}
            style={{ marginTop: tokens.spacing[2] }}
          >
            {t('goToLogin')}
          </Button>
        </Box>
      </Box>
    )
  }

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={email} />
        <Box style={{
          maxWidth: 800,
          margin: '0 auto',
          padding: tokens.spacing[6],
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: tokens.spacing[3],
        }}>
          <Box style={{
            width: 32,
            height: 32,
            border: `3px solid ${tokens.colors.border.primary}`,
            borderTopColor: tokens.colors.accent.primary,
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }} />
          <Text size="lg" color="secondary">{t('loading')}</Text>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </Box>
      </Box>
    )
  }

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6], display: 'flex', gap: tokens.spacing[8] }}>
        {/* Sidebar Navigation - Desktop only */}
        <Box
          className="settings-sidebar"
          style={{
            width: 180,
            flexShrink: 0,
            position: 'sticky',
            top: 80,
            alignSelf: 'flex-start',
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.spacing[1],
          }}
        >
          {SECTION_IDS.map(sectionId => (
            <button
              key={sectionId}
              onClick={() => {
                setActiveSection(sectionId)
                document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[2],
                padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                borderRadius: tokens.radius.md,
                border: 'none',
                background: activeSection === sectionId ? tokens.colors.bg.tertiary : 'transparent',
                color: activeSection === sectionId ? tokens.colors.text.primary : tokens.colors.text.secondary,
                fontWeight: activeSection === sectionId ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.normal,
                fontSize: tokens.typography.fontSize.sm,
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.15s ease',
                width: '100%',
              }}
            >
              <span style={{ fontSize: '14px', display: 'flex', alignItems: 'center' }}>{SECTION_ICONS[sectionId]}</span>
              {t(SECTION_KEYS[sectionId] as keyof typeof import('@/lib/i18n').translations.zh)}
            </button>
          ))}
        </Box>

        {/* Main Content */}
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text size="2xl" weight="black" style={{ marginBottom: tokens.spacing[4] }}>
            {t('settingsTitle')}
          </Text>

          {/* Mobile Section Navigation - horizontal scroll tabs */}
          <Box
            className="settings-mobile-nav"
            style={{
              display: 'none',
              gap: tokens.spacing[2],
              marginBottom: tokens.spacing[5],
              overflowX: 'auto',
              paddingBottom: tokens.spacing[2],
              WebkitOverflowScrolling: 'touch',
              msOverflowStyle: 'none',
              scrollbarWidth: 'none',
            }}
          >
            {SECTION_IDS.map(sectionId => (
              <button
                key={sectionId}
                onClick={() => {
                  setActiveSection(sectionId)
                  document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: tokens.spacing[1],
                  padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.full,
                  border: `1px solid ${activeSection === sectionId ? tokens.colors.accent.primary + '60' : tokens.colors.border.primary}`,
                  background: activeSection === sectionId ? `${tokens.colors.accent.primary}15` : tokens.colors.bg.secondary,
                  color: activeSection === sectionId ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                  fontSize: tokens.typography.fontSize.xs,
                  fontWeight: activeSection === sectionId ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.normal,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                  transition: 'all 0.15s ease',
                }}
              >
                <span style={{ fontSize: '12px', display: 'flex', alignItems: 'center' }}>{SECTION_ICONS[sectionId]}</span>
                {t(SECTION_KEYS[sectionId] as keyof typeof import('@/lib/i18n').translations.zh)}
              </button>
            ))}
          </Box>

          {/* ===== Profile Section ===== */}
          <SectionCard id="profile" title={t('profileSection')} description={t('profileDescription')}>
            {/* Avatar */}
            <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[4], marginBottom: tokens.spacing[5] }}>
              {userId ? (
                <Avatar
                  userId={userId}
                  name={handle || email}
                  avatarUrl={previewUrl}
                  size={80}
                  style={{
                    borderRadius: tokens.radius.xl,
                    border: `2px solid ${tokens.colors.border.primary}`,
                  }}
                />
              ) : (
                <Box
                  style={{
                    width: 80,
                    height: 80,
                    borderRadius: tokens.radius.xl,
                    background: tokens.colors.bg.tertiary,
                    border: `2px solid ${tokens.colors.border.primary}`,
                    display: 'grid',
                    placeItems: 'center',
                    flexShrink: 0,
                  }}
                >
                  <Text size="2xl" weight="black" style={{ color: tokens.colors.text.secondary }}>
                    {(handle?.[0] || email?.[0] || 'U').toUpperCase()}
                  </Text>
                </Box>
              )}

              <Box>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  onChange={handleAvatarChange}
                  style={{ display: 'none' }}
                  id="avatar-input"
                />
                <label
                  htmlFor="avatar-input"
                  style={{
                    display: 'inline-block',
                    padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.primary,
                    color: tokens.colors.text.primary,
                    cursor: 'pointer',
                    fontWeight: tokens.typography.fontWeight.bold,
                    fontSize: tokens.typography.fontSize.sm,
                  }}
                >
                  {t('changeAvatar')}
                </label>
                <Text size="xs" color="tertiary" style={{ marginTop: tokens.spacing[1], display: 'block' }}>
                  {t('avatarFormatHint')}
                </Text>
              </Box>
            </Box>

            {/* Cover Image */}
            <Box style={{ marginBottom: tokens.spacing[5] }}>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                {t('coverImage')}
              </Text>
              <Box
                style={{
                  width: '100%',
                  height: 120,
                  borderRadius: tokens.radius.lg,
                  background: (coverPreviewUrl || coverUrl)
                    ? `url(${coverPreviewUrl || coverUrl}) center/cover no-repeat`
                    : `linear-gradient(135deg, ${tokens.colors.bg.tertiary} 0%, ${tokens.colors.bg.secondary} 100%)`,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: tokens.spacing[2],
                }}
              >
                {!coverPreviewUrl && !coverUrl && (
                  <Text size="sm" color="tertiary">{t('noCoverImage')}</Text>
                )}
              </Box>
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  onChange={handleCoverChange}
                  style={{ display: 'none' }}
                  id="cover-input"
                />
                <label
                  htmlFor="cover-input"
                  style={{
                    display: 'inline-block',
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.primary,
                    color: tokens.colors.text.primary,
                    cursor: 'pointer',
                    fontWeight: tokens.typography.fontWeight.bold,
                    fontSize: tokens.typography.fontSize.sm,
                  }}
                >
                  {t('changeCover')}
                </label>
                {(coverPreviewUrl || coverUrl) && (
                  <button
                    onClick={() => {
                      setCoverFile(null)
                      setCoverPreviewUrl(null)
                      setCoverUrl(null)
                      showToast(t('coverRemoveHint'), 'info')
                    }}
                    style={{
                      padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                      borderRadius: tokens.radius.md,
                      border: `1px solid ${tokens.colors.accent.error}40`,
                      background: 'transparent',
                      color: tokens.colors.accent.error,
                      cursor: 'pointer',
                      fontSize: tokens.typography.fontSize.sm,
                    }}
                  >
                    {t('remove')}
                  </button>
                )}
                <Text size="xs" color="tertiary">
                  {t('coverSizeHint')}
                </Text>
              </Box>
            </Box>

            {/* Handle */}
            <Box style={{ marginBottom: tokens.spacing[5] }}>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                {t('username')}
              </Text>
              {/* Show current username */}
              {initialValuesRef.current?.handle && (
                <Box
                  style={{
                    marginBottom: tokens.spacing[2],
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    background: tokens.colors.bg.primary,
                    border: `1px solid ${tokens.colors.border.primary}`,
                  }}
                >
                  <Text size="xs" color="tertiary" style={{ marginBottom: 2 }}>
                    {t('currentUsername') || 'Current username'}
                  </Text>
                  <Text size="sm" weight="bold">
                    @{initialValuesRef.current.handle}
                  </Text>
                </Box>
              )}
              <input
                type="text"
                value={handle}
                onChange={(e) => setHandle(e.target.value.slice(0, MAX_HANDLE_LENGTH))}
                onBlur={() => markTouched('handle')}
                placeholder={t('setUsername')}
                style={getInputStyle(touchedFields.handle && !handleValidation.valid)}
              />
              <Box style={{ display: 'flex', justifyContent: 'space-between', marginTop: tokens.spacing[1] }}>
                <Box>
                  {touchedFields.handle && handle && !handleValidation.valid && (
                    <Text size="xs" style={{ color: tokens.colors.accent.error }}>
                      {handleValidation.message}
                    </Text>
                  )}
                  {touchedFields.handle && handle && handleValidation.valid && checkingHandle && (
                    <Text size="xs" color="tertiary">
                      {t('checking')}
                    </Text>
                  )}
                  {touchedFields.handle && handle && handleValidation.valid && !checkingHandle && handleAvailable === true && (
                    <Text size="xs" style={{ color: tokens.colors.accent.success }}>
                      {t('usernameAvailable')}
                    </Text>
                  )}
                  {touchedFields.handle && handle && handleValidation.valid && !checkingHandle && handleAvailable === false && (
                    <Text size="xs" style={{ color: tokens.colors.accent.error }}>
                      {t('usernameTaken')}
                    </Text>
                  )}
                </Box>
                <Text size="xs" color="tertiary">
                  {handle.length}/{MAX_HANDLE_LENGTH}
                </Text>
              </Box>
            </Box>

            {/* Bio */}
            <Box style={{ marginBottom: tokens.spacing[4] }}>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                {t('personalBio')}
              </Text>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value.slice(0, MAX_BIO_LENGTH))}
                placeholder={t('introduceSelf')}
                rows={4}
                style={{
                  ...getInputStyle(),
                  resize: 'vertical',
                  minHeight: '80px',
                }}
              />
              <Box style={{ display: 'flex', justifyContent: 'flex-end', marginTop: tokens.spacing[1] }}>
                <Text
                  size="xs"
                  style={{
                    color: bio.length > MAX_BIO_LENGTH * 0.9
                      ? tokens.colors.accent.warning
                      : tokens.colors.text.tertiary
                  }}
                >
                  {bio.length}/{MAX_BIO_LENGTH}
                </Text>
              </Box>
            </Box>
          </SectionCard>

          {/* ===== Security Section ===== */}
          <SectionCard id="security" title={t('securitySection')} description={t('twoFADesc')}>
            {/* Current Email Display */}
            <Box style={{ marginBottom: tokens.spacing[5], padding: tokens.spacing[3], borderRadius: tokens.radius.md, background: tokens.colors.bg.primary }}>
              <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[1] }}>{t('currentLoginEmail')}</Text>
              <Text size="sm" weight="bold">{email}</Text>
            </Box>

            {/* Change Email */}
            <Box style={{ marginBottom: tokens.spacing[6] }}>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                {t('changeEmailButton')}
              </Text>
              <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
                <input
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  onBlur={() => markTouched('newEmail')}
                  placeholder={t('enterNewEmail')}
                  style={{ ...getInputStyle(touchedFields.newEmail && !newEmailValidation.valid), flex: 1 }}
                />
                <Button
                  variant="secondary"
                  onClick={handleChangeEmail}
                  disabled={savingEmail || !newEmail || !newEmailValidation.valid}
                >
                  {savingEmail ? t('sendingVerification') : t('verifyButton')}
                </Button>
              </Box>
              {touchedFields.newEmail && newEmail && !newEmailValidation.valid && (
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
                  onClick={() => setPasswordResetMode('password')}
                  style={{
                    flex: 1,
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${passwordResetMode === 'password' ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                    background: passwordResetMode === 'password' ? `${tokens.colors.accent.primary}15` : 'transparent',
                    color: passwordResetMode === 'password' ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                    fontSize: tokens.typography.fontSize.sm,
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                >
                  {t('useCurrentPassword')}
                </button>
                <button
                  onClick={() => setPasswordResetMode('code')}
                  style={{
                    flex: 1,
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${passwordResetMode === 'code' ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
                    background: passwordResetMode === 'code' ? `${tokens.colors.accent.primary}15` : 'transparent',
                    color: passwordResetMode === 'code' ? tokens.colors.accent.primary : tokens.colors.text.secondary,
                    fontSize: tokens.typography.fontSize.sm,
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                >
                  {t('useEmailReset')}
                </button>
              </Box>

              {passwordResetMode === 'password' ? (
                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder={t('currentPasswordPlaceholder')}
                    style={getInputStyle()}
                  />
                  <Box>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      onBlur={() => markTouched('newPassword')}
                      placeholder={t('newPasswordPlaceholder')}
                      style={getInputStyle(touchedFields.newPassword && !newPasswordValidation.valid)}
                    />
                    {touchedFields.newPassword && newPassword && !newPasswordValidation.valid && (
                      <Text size="xs" style={{ color: tokens.colors.accent.error, marginTop: tokens.spacing[1] }}>
                        {newPasswordValidation.message}
                      </Text>
                    )}
                  </Box>
                  <Box>
                    <input
                      type="password"
                      value={confirmNewPassword}
                      onChange={(e) => setConfirmNewPassword(e.target.value)}
                      onBlur={() => markTouched('confirmPassword')}
                      placeholder={t('confirmPasswordPlaceholder')}
                      style={getInputStyle(touchedFields.confirmPassword && !confirmPasswordValidation.valid)}
                    />
                    {touchedFields.confirmPassword && confirmNewPassword && !confirmPasswordValidation.valid && (
                      <Text size="xs" style={{ color: tokens.colors.accent.error, marginTop: tokens.spacing[1] }}>
                        {confirmPasswordValidation.message}
                      </Text>
                    )}
                    {touchedFields.confirmPassword && confirmNewPassword && confirmPasswordValidation.valid && (
                      <Text size="xs" style={{ color: tokens.colors.accent.success, marginTop: tokens.spacing[1] }}>
                        {t('passwordMatch')}
                      </Text>
                    )}
                  </Box>
                  <Box style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <Button
                      variant="secondary"
                      onClick={handleChangePassword}
                      disabled={savingPassword || !currentPassword || !newPassword || !newPasswordValidation.valid || !confirmPasswordValidation.valid}
                    >
                      {savingPassword ? t('changingPassword') : t('changePassword')}
                    </Button>
                  </Box>
                </Box>
              ) : (
                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                  <Text size="sm" color="secondary">
                    {t('resetLinkWillSendTo')}{email}
                  </Text>
                  <Text size="xs" color="tertiary">
                    {t('resetLinkNote')}
                  </Text>
                  <Box style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <Button
                      variant="secondary"
                      onClick={handleSendResetCode}
                      disabled={sendingResetCode || resetCountdown > 0}
                    >
                      {sendingResetCode
                        ? t('sendingVerification')
                        : resetCountdown > 0
                          ? `${resetCountdown}${t('resendAfter')}`
                          : resetCodeSent
                            ? t('resendResetEmail')
                            : t('sendResetEmail')}
                    </Button>
                  </Box>
                  {resetCodeSent && (
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

            {/* ===== 2FA Section ===== */}
            <Box style={{ marginTop: tokens.spacing[6], paddingTop: tokens.spacing[6], borderTop: `1px solid ${tokens.colors.border.primary}` }}>
              <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
                <Text size="sm" weight="bold">
                  {t('twoFactorAuthTitle')}
                </Text>
                {twoFAEnabled && (
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

              {!twoFAEnabled && !twoFASetupData && backupCodes.length === 0 && (
                <Box>
                  <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
                    {t('twoFAEnableDesc')}
                  </Text>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleSetup2FA}
                    disabled={twoFALoading}
                  >
                    {twoFALoading ? t('loading') : t('enable2FAButton')}
                  </Button>
                </Box>
              )}

              {twoFASetupData && !twoFAEnabled && (
                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
                  <Text size="xs" color="secondary" style={{ lineHeight: 1.6 }}>
                    {t('scanQRCodeDesc')}
                  </Text>
                  <Box style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacing[3] }}>
                    <Image
                      src={twoFASetupData.qrCodeDataUrl}
                      alt="2FA QR Code"
                      width={180}
                      height={180}
                      style={{
                        width: 180,
                        height: 180,
                        borderRadius: tokens.radius.md,
                        border: `1px solid ${tokens.colors.border.primary}`,
                        background: '#fff',
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
                        {twoFASetupData.secret}
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
                        value={twoFACode}
                        onChange={(e) => setTwoFACode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                        placeholder="000000"
                        maxLength={6}
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
                        onClick={handleVerify2FA}
                        disabled={twoFALoading || twoFACode.length !== 6}
                      >
                        {twoFALoading ? t('verifyingCode') : t('verifyAndEnable')}
                      </Button>
                    </Box>
                  </Box>
                </Box>
              )}

              {backupCodes.length > 0 && (
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
                  }}>
                    {backupCodes.map((code, index) => (
                      <Text
                        key={index}
                        size="sm"
                        style={{ fontFamily: 'monospace', textAlign: 'center' }}
                      >
                        {code}
                      </Text>
                    ))}
                  </Box>
                </Box>
              )}

              {twoFAEnabled && !showDisable2FA && (
                <Box style={{ marginTop: tokens.spacing[3] }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setShowDisable2FA(true)}
                    style={{
                      color: tokens.colors.accent.error,
                      borderColor: tokens.colors.accent.error + '40',
                    }}
                  >
                    {t('disable2FAButton')}
                  </Button>
                </Box>
              )}

              {showDisable2FA && (
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
                    <input
                      type="password"
                      value={disablePassword}
                      onChange={(e) => setDisablePassword(e.target.value)}
                      placeholder={t('enterCurrentPasswordPlaceholder')}
                      style={{ ...getInputStyle(), maxWidth: 240 }}
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={handleDisable2FA}
                      disabled={twoFALoading || !disablePassword}
                      style={{
                        color: tokens.colors.accent.error,
                        borderColor: tokens.colors.accent.error + '40',
                      }}
                    >
                      {twoFALoading ? t('processingText') : t('confirmDisableButton')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => { setShowDisable2FA(false); setDisablePassword('') }}
                    >
                      {t('cancel')}
                    </Button>
                  </Box>
                </Box>
              )}
            </Box>

            {/* ===== Active Sessions Section ===== */}
            <Box style={{ marginTop: tokens.spacing[6], paddingTop: tokens.spacing[6], borderTop: `1px solid ${tokens.colors.border.primary}` }}>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
                {t('activeSessionsTitle')}
              </Text>
              <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[4] }}>
                {t('activeSessionsDesc')}
              </Text>

              {loadingSessions ? (
                <Text size="sm" color="tertiary">{t('loading')}</Text>
              ) : sessions.length === 0 ? (
                <Text size="sm" color="tertiary">{t('noSessionInfo')}</Text>
              ) : (
                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
                  {sessions.map((session) => (
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
                            <Text size="xs" color="tertiary">
                              IP: {session.ipAddress}
                            </Text>
                          )}
                          {session.lastActiveAt && (
                            <Text size="xs" color="tertiary">
                              {formatTimeAgo(session.lastActiveAt)}
                            </Text>
                          )}
                        </Box>
                      </Box>
                      {!session.isCurrent && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRevokeSession(session.id)}
                          style={{
                            color: tokens.colors.accent.error,
                            fontSize: tokens.typography.fontSize.xs,
                          }}
                        >
                          {t('revokeSession')}
                        </Button>
                      )}
                    </Box>
                  ))}

                  {sessions.filter(s => !s.isCurrent).length > 0 && (
                    <Box style={{ display: 'flex', justifyContent: 'flex-end', marginTop: tokens.spacing[2] }}>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={handleRevokeAllSessions}
                        style={{
                          color: tokens.colors.accent.error,
                          borderColor: tokens.colors.accent.error + '40',
                        }}
                      >
                        {t('logoutOtherDevicesButton')}
                      </Button>
                    </Box>
                  )}
                </Box>
              )}
            </Box>
          </SectionCard>

          {/* ===== Wallet Section ===== */}
          <SectionCard id="wallet" title={t('walletSection')} description={t('walletDescription')}>
            <WalletSection
              onToast={(msg, type) => showToast(msg, type)}
              onConfirm={(title, msg) => showConfirm(title, msg)}
            />
          </SectionCard>

          {/* ===== Exchange Connections Section ===== */}
          <Box
            id="exchanges"
            style={{
              marginBottom: tokens.spacing[6],
              padding: tokens.spacing[6],
              borderRadius: tokens.radius.xl,
              background: tokens.colors.bg.secondary,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            {userId && <ExchangeConnectionManager userId={userId} />}
          </Box>

          {/* ===== Trader Links Section ===== */}
          <SectionCard id="trader-links" title={t('myTraderAccounts')} description={t('myTraderAccountsDesc')}>
            {userId && <TraderLinksSection userId={userId} />}
          </SectionCard>

          {/* ===== Trader Alerts Section ===== */}
          <SectionCard id="alerts" title={t('traderAlertsTitle')} description={t('traderAlertsDesc2')}>
            <AdvancedAlerts
              isPro={isPro}
              isLoggedIn={!!userId}
            />
          </SectionCard>

          {/* ===== Notification Preferences Section ===== */}
          <SectionCard id="notifications" title={t('notificationsSection')} description={t('notifications')}>
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
              {[
                { key: 'follow', labelKey: 'newFollowerNotify', value: notifyFollow, setter: setNotifyFollow },
                { key: 'like', labelKey: 'postLikedNotify', value: notifyLike, setter: setNotifyLike },
                { key: 'comment', labelKey: 'postCommentedNotify', value: notifyComment, setter: setNotifyComment },
                { key: 'mention', labelKey: 'mentionedNotify', value: notifyMention, setter: setNotifyMention },
                { key: 'message', labelKey: 'newMessageNotify', value: notifyMessage, setter: setNotifyMessage },
              ].map(item => (
                <Box
                  key={item.key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    transition: 'background 0.15s ease',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.primary }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
                >
                  <Box>
                    <Text size="sm" weight="medium">{t(item.labelKey as keyof typeof import('@/lib/i18n').translations.zh)}</Text>
                  </Box>
                  <ToggleSwitch
                    checked={item.value}
                    onChange={(v) => item.setter(v)}
                  />
                </Box>
              ))}
            </Box>

            {/* ===== Haptic Feedback Section ===== */}
            {isHapticSupported() && (
              <Box style={{ marginTop: tokens.spacing[5], paddingTop: tokens.spacing[5], borderTop: `1px solid ${tokens.colors.border.primary}` }}>
                <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                  {language === 'zh' ? '震动反馈' : 'Haptic Feedback'}
                </Text>
                <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
                  {language === 'zh' 
                    ? '当关注的交易员开仓时，手机会有特定节奏的震动' 
                    : 'Feel vibrations when followed traders open positions'}
                </Text>
                <Box
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: `${tokens.spacing[3]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    background: tokens.colors.bg.primary,
                  }}
                >
                  <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
                    <span style={{ fontSize: 20 }}>📳</span>
                    <Text size="sm" weight="medium">
                      {language === 'zh' ? '交易提醒震动' : 'Trade Alert Vibration'}
                    </Text>
                  </Box>
                  <ToggleSwitch
                    checked={hapticEnabled}
                    onChange={(v) => {
                      setHapticEnabled(v)
                      if (v) haptic('success') // 测试震动
                    }}
                  />
                </Box>
              </Box>
            )}

            {/* ===== Email Digest Section ===== */}
            <Box style={{ marginTop: tokens.spacing[5], paddingTop: tokens.spacing[5], borderTop: `1px solid ${tokens.colors.border.primary}` }}>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                {t('emailDigest')}
              </Text>
              <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
                {t('emailDigestDesc')}
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                <RadioOption
                  name="emailDigest"
                  value="none"
                  currentValue={emailDigest}
                  label={t('digestNone')}
                  description=""
                  onChange={handleEmailDigestChange}
                />
                <RadioOption
                  name="emailDigest"
                  value="daily"
                  currentValue={emailDigest}
                  label={t('digestDaily')}
                  description=""
                  onChange={handleEmailDigestChange}
                />
                <RadioOption
                  name="emailDigest"
                  value="weekly"
                  currentValue={emailDigest}
                  label={t('digestWeekly')}
                  description=""
                  onChange={handleEmailDigestChange}
                />
              </Box>
            </Box>
          </SectionCard>

          {/* ===== Privacy Settings Section ===== */}
          <SectionCard id="privacy" title={t('privacySection')} description={t('dmPermissions')}>
            {/* Follow lists visibility */}
            <Box style={{ marginBottom: tokens.spacing[5] }}>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                {t('showFollowerList')}
              </Text>
              <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
                {t('followListVisibilityNote')}
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={showFollowing}
                    onChange={(e) => setShowFollowing(e.target.checked)}
                    style={{ width: 18, height: 18, accentColor: '#8b6fa8' }}
                  />
                  <Text size="sm">{t('showFollowingListLabel')}</Text>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={showFollowers}
                    onChange={(e) => setShowFollowers(e.target.checked)}
                    style={{ width: 18, height: 18, accentColor: '#8b6fa8' }}
                  />
                  <Text size="sm">{t('showFollowersListLabel')}</Text>
                </label>
              </Box>
            </Box>

            {/* Pro Badge */}
            <Box style={{ marginBottom: tokens.spacing[5] }}>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                {t('proBadgeTitle')}
              </Text>
              <label style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3], cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={showProBadge}
                  onChange={(e) => setShowProBadge(e.target.checked)}
                  style={{ width: 18, height: 18, accentColor: '#8b6fa8' }}
                />
                <Box>
                  <Text size="sm">{t('showProBadgeLabel')}</Text>
                  <Text size="xs" color="tertiary">{t('proBadgeNote')}</Text>
                </Box>
              </label>
            </Box>

            {/* DM Permission */}
            <Box>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                {t('dmPermissionsTitle')}
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                <RadioOption
                  name="dmPermission"
                  value="all"
                  currentValue={dmPermission}
                  label={t('dmEveryoneLabel')}
                  description={t('dmEveryoneDesc')}
                  onChange={setDmPermission}
                />
                <RadioOption
                  name="dmPermission"
                  value="mutual"
                  currentValue={dmPermission}
                  label={t('dmMutualLabel')}
                  description={t('dmMutualDesc')}
                  onChange={setDmPermission}
                />
                <RadioOption
                  name="dmPermission"
                  value="none"
                  currentValue={dmPermission}
                  label={t('dmNoneLabel')}
                  description={t('dmNoneDesc')}
                  onChange={setDmPermission}
                />
              </Box>
            </Box>

            {/* ===== Blocked Users Section ===== */}
            <Box style={{ marginTop: tokens.spacing[5], paddingTop: tokens.spacing[5], borderTop: `1px solid ${tokens.colors.border.primary}` }}>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                {t('blockedUsersTitle')}
              </Text>
              <Text size="xs" color="tertiary" style={{ marginBottom: tokens.spacing[3] }}>
                {t('blockedUsersDesc')}
              </Text>

              {loadingBlockedUsers ? (
                <Text size="sm" color="tertiary">{t('loading')}</Text>
              ) : blockedUsers.length === 0 ? (
                <Box style={{
                  padding: tokens.spacing[4],
                  textAlign: 'center',
                  borderRadius: tokens.radius.md,
                  background: tokens.colors.bg.primary,
                }}>
                  <Text size="sm" color="tertiary">{t('noBlockedUsers')}</Text>
                </Box>
              ) : (
                <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[2] }}>
                  {blockedUsers.map((blockedUser) => (
                    <Box
                      key={blockedUser.blockedId}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: tokens.spacing[3],
                        borderRadius: tokens.radius.md,
                        background: tokens.colors.bg.primary,
                        border: `1px solid ${tokens.colors.border.primary}`,
                      }}
                    >
                      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
                        <Box
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: tokens.radius.full,
                            background: blockedUser.avatarUrl
                              ? `url(${blockedUser.avatarUrl}) center/cover no-repeat`
                              : `${tokens.colors.accent.primary}15`,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                          }}
                        >
                          {!blockedUser.avatarUrl && (
                            <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.primary }}>
                              {(blockedUser.handle?.[0] || '?').toUpperCase()}
                            </Text>
                          )}
                        </Box>
                        <Box>
                          <Text size="sm" weight="medium">
                            {blockedUser.handle || t('unknownUser')}
                          </Text>
                          <Text size="xs" color="tertiary">
                            {formatTimeAgo(blockedUser.createdAt)} {t('blockedAt')}
                          </Text>
                        </Box>
                      </Box>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleUnblock(blockedUser.blockedId)}
                        disabled={unblockingId === blockedUser.blockedId}
                        style={{
                          fontSize: tokens.typography.fontSize.xs,
                          color: tokens.colors.accent.primary,
                        }}
                      >
                        {unblockingId === blockedUser.blockedId ? '...' : t('unblockButton')}
                      </Button>
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
          </SectionCard>

          {/* ===== Account Management (Danger Zone) ===== */}
          <SectionCard id="account" title={t('accountSection')} variant="danger">
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>

              {/* Multi-Account Section */}
              <Box>
                <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[2] }}>
                  <Box>
                    <Text size="sm" weight="medium">{t('linkedAccountsTitle')}</Text>
                    <Text size="xs" color="tertiary">{t('linkedAccountsDesc')}</Text>
                  </Box>
                </Box>
                <MultiAccountSection />
              </Box>

              {/* Divider */}
              <Box style={{ height: 1, background: tokens.colors.border.primary }} />

              {/* Logout */}
              <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Box>
                  <Text size="sm" weight="medium">{t('logout')}</Text>
                  <Text size="xs" color="tertiary">{t('logoutDesc')}</Text>
                </Box>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleLogout}
                  style={{
                    color: tokens.colors.accent.error,
                    borderColor: tokens.colors.accent.error + '40',
                  }}
                >
                  {t('logout')}
                </Button>
              </Box>

              {/* Divider */}
              <Box style={{ height: 1, background: tokens.colors.border.primary }} />

              {/* Account Deletion */}
              <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Box>
                  <Text size="sm" weight="medium" style={{ color: tokens.colors.accent.error }}>{t('deleteAccount')}</Text>
                  <Text size="xs" color="tertiary">{t('deleteAccountDesc2')}</Text>
                </Box>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowDeleteAccountModal(true)}
                  style={{
                    color: tokens.colors.accent.error,
                    borderColor: tokens.colors.accent.error + '40',
                  }}
                >
                  {t('deleteAccount')}
                </Button>
              </Box>
            </Box>
          </SectionCard>

          <DeleteAccountModal
            isOpen={showDeleteAccountModal}
            onClose={() => setShowDeleteAccountModal(false)}
            password={deletePassword}
            setPassword={setDeletePassword}
            reason={deleteReason}
            setReason={setDeleteReason}
            error={deleteError}
            deleting={deletingAccount}
            onDelete={handleDeleteAccount}
          />

          {/* ===== Floating Save Bar ===== */}
          {hasUnsavedChanges() && (
            <Box
              style={{
                position: 'sticky',
                bottom: tokens.spacing[4],
                padding: `${tokens.spacing[3]} ${tokens.spacing[5]}`,
                borderRadius: tokens.radius.xl,
                background: tokens.colors.bg.secondary,
                border: `1px solid ${tokens.colors.accent.warning}40`,
                boxShadow: tokens.shadow.lg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                zIndex: 50,
              }}
            >
              <Text size="sm" style={{ color: tokens.colors.accent.warning }}>
                {t('unsavedChanges')}
              </Text>
              <Box style={{ display: 'flex', gap: tokens.spacing[3] }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    const confirmed = await showConfirm(t('discardChanges'), t('discardChangesConfirm'))
                    if (confirmed && userId) {
                      setTouchedFields({ handle: false, newPassword: false, confirmPassword: false, newEmail: false })
                      setHandleAvailable(null)
                      setAvatarFile(null)
                      setCoverFile(null)
                      loadProfile(userId)
                    }
                  }}
                  disabled={saving}
                >
                  {t('discard')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSaveProfile}
                  disabled={saving}
                >
                  {saving ? t('savingChanges') : t('saveAllChanges')}
                </Button>
              </Box>
            </Box>
          )}

          {/* Bottom spacer */}
          <Box style={{ height: tokens.spacing[12] }} />
        </Box>
      </Box>

      {/* Avatar Cropper Modal */}
      {showAvatarCropper && cropImageSrc && (
        <ImageCropper
          imageSrc={cropImageSrc}
          onCropComplete={handleAvatarCropComplete}
          onCancel={() => {
            setShowAvatarCropper(false)
            setCropImageSrc(null)
          }}
          onError={(message) => {
            showToast(message, 'error')
          }}
          aspectRatio={1}
          cropShape="round"
          title={t('cropAvatar')}
        />
      )}

      {/* Cover Cropper Modal */}
      {showCoverCropper && cropImageSrc && (
        <ImageCropper
          imageSrc={cropImageSrc}
          onCropComplete={handleCoverCropComplete}
          onCancel={() => {
            setShowCoverCropper(false)
            setCropImageSrc(null)
          }}
          onError={(message) => {
            showToast(message, 'error')
          }}
          aspectRatio={3}
          cropShape="rect"
          title={t('cropCover')}
        />
      )}

      {/* Responsive styles */}
      <style>{`
        @media (max-width: 768px) {
          .settings-sidebar {
            display: none !important;
          }
          .settings-mobile-nav {
            display: flex !important;
          }
          .settings-mobile-nav::-webkit-scrollbar {
            display: none;
          }
        }
      `}</style>
    </Box>
  )
}

export default function SettingsPage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 900, margin: '0 auto', padding: tokens.spacing[6] }}>
          <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
            {[1, 2, 3].map(i => (
              <Box
                key={i}
                style={{
                  height: 120,
                  borderRadius: tokens.radius.xl,
                  background: tokens.colors.bg.secondary,
                  animation: 'pulse 1.5s ease-in-out infinite',
                }}
              />
            ))}
          </Box>
        </Box>
      </Box>
    }>
      <SettingsContent />
    </Suspense>
  )
}
