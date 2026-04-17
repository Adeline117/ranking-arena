'use client'

import { useState, useEffect, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import Avatar from '@/app/components/ui/Avatar'
import { useToast } from '@/app/components/ui/Toast'
import { getCsrfHeaders } from '@/lib/api/client'
import { getProfileUrl } from '@/lib/utils/profile-navigation'
import dynamic from 'next/dynamic'
const ReportModal = dynamic(() => import('@/app/components/ui/ReportModal'), { ssr: false })
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { logger } from '@/lib/logger'

type ChatSettings = {
  remark: string | null
  is_muted: boolean
  is_pinned: boolean
  is_blocked: boolean
  cleared_before: string | null
}

type OtherUser = {
  id: string
  handle: string | null
  avatar_url?: string
  bio?: string
}

type ChatSettingsDrawerProps = {
  isOpen: boolean
  onClose: () => void
  conversationId: string
  otherUser: OtherUser
  accessToken: string
  onSettingsChange: (settings: ChatSettings) => void
  onSearchOpen: () => void
  onClearHistory: () => void
}

export default function ChatSettingsDrawer({
  isOpen,
  onClose,
  conversationId,
  otherUser,
  accessToken,
  onSettingsChange,
  onSearchOpen,
  onClearHistory,
}: ChatSettingsDrawerProps) {
  const { showToast } = useToast()
  const { t } = useLanguage()
  const [settings, setSettings] = useState<ChatSettings>({
    remark: null,
    is_muted: false,
    is_pinned: false,
    is_blocked: false,
    cleared_before: null,
  })
  const [loading, setLoading] = useState(true)
  const [editingRemark, setEditingRemark] = useState(false)
  const [remarkInput, setRemarkInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [reportModalOpen, setReportModalOpen] = useState(false)

  const loadSettings = useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch(`/api/chat/${conversationId}/settings`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
      })
      if (res.ok) {
        const data = await res.json()
        setSettings(data.settings)
        setRemarkInput(data.settings.remark || '')
      }
    } catch (error) {
      logger.error('Failed to load settings:', error)
    } finally {
      setLoading(false)
    }
  }, [conversationId, accessToken])

  useEffect(() => {
    if (isOpen) {
      loadSettings()
    }
  }, [isOpen, loadSettings])

  const updateSetting = async (updates: Partial<ChatSettings>) => {
    setSaving(true)
    try {
      const res = await fetch(`/api/chat/${conversationId}/settings`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify(updates),
      })

      if (!res.ok) {
        const data = await res.json()
        showToast(data.error || t('updateFailed'), 'error')
        return
      }

      const data = await res.json()
      setSettings(data.settings)
      onSettingsChange(data.settings)

      if ('is_muted' in updates) {
        showToast(updates.is_muted ? t('muted') : t('unmuted'), 'success')
      } else if ('is_pinned' in updates) {
        showToast(updates.is_pinned ? t('pinnedChat') : t('unpinnedChat'), 'success')
      } else if ('is_blocked' in updates) {
        showToast(updates.is_blocked ? t('blocked') : t('unblocked'), 'success')
      } else if ('remark' in updates) {
        showToast(t('remarkUpdated'), 'success')
      }
    } catch (error) {
      logger.error('Failed to update setting:', error)
      showToast(t('updateFailed'), 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleRemarkSave = () => {
    const trimmed = remarkInput.trim()
    if (trimmed.length > 50) {
      showToast(t('remarkMaxLength'), 'warning')
      return
    }
    updateSetting({ remark: trimmed || null })
    setEditingRemark(false)
  }

  const handleClearHistory = async () => {
    if (!confirm(t('confirmClearChat'))) {
      return
    }

    await updateSetting({ cleared_before: new Date().toISOString() })
    onClearHistory()
    showToast(t('chatHistoryCleared'), 'success')
  }

  const handleBlock = async () => {
    if (settings.is_blocked) {
      await updateSetting({ is_blocked: false })
    } else {
      if (!confirm(t('confirmBlockMessage'))) {
        return
      }
      await updateSetting({ is_blocked: true })
    }
  }

  const profileUrl = getProfileUrl(otherUser)

  if (!isOpen) return null

  return (
    <>
      {/* Overlay */}
      <Box
        onClick={onClose}
            aria-label="Close settings"
        style={{
          position: 'fixed',
          inset: 0,
          background: 'var(--color-overlay-dark)',
          zIndex: tokens.zIndex.overlay,
          transition: 'opacity 0.2s',
        }}
      />

      {/* Drawer */}
      <Box
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: '100%',
          maxWidth: 360,
          background: tokens.colors.bg.primary,
          zIndex: tokens.zIndex.modal,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: 'var(--shadow-elevated)',
          overflow: 'auto',
        }}
      >
        {/* Drawer Header */}
        <Box
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: tokens.spacing[4],
            borderBottom: `1px solid ${tokens.colors.border.primary}`,
          }}
        >
          <Text size="lg" weight="bold">{t('chatSettings')}</Text>
          <button
            onClick={onClose}
            style={{
              width: 36,
              height: 36,
              borderRadius: tokens.radius.full,
              border: 'none',
              background: tokens.colors.bg.secondary,
              color: tokens.colors.text.secondary,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all 0.2s',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </Box>

        {loading ? (
          <Box style={{ padding: tokens.spacing[6], textAlign: 'center' }}>
            <Text size="sm" color="tertiary">{t('loading')}</Text>
          </Box>
        ) : (
          <Box style={{ flex: 1, overflow: 'auto' }}>
            {/* User Info Section */}
            <Box
              style={{
                padding: tokens.spacing[5],
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: tokens.spacing[3],
                borderBottom: `1px solid ${tokens.colors.border.primary}`,
              }}
            >
              <Avatar
                userId={otherUser.id}
                name={otherUser.handle || `User ${otherUser.id.slice(0, 8)}`}
                avatarUrl={otherUser.avatar_url}
                size={72}
              />
              <Box style={{ textAlign: 'center' }}>
                <Text size="lg" weight="bold">
                  {settings.remark || otherUser.handle || `User ${otherUser.id.slice(0, 8)}`}
                </Text>
                {settings.remark && otherUser.handle && (
                  <Text size="xs" color="tertiary" style={{ marginTop: 2 }}>
                    @{otherUser.handle}
                  </Text>
                )}
                {otherUser.bio && (
                  <Text size="sm" color="secondary" style={{ marginTop: 4, maxWidth: 240, lineHeight: 1.5 }}>
                    {otherUser.bio}
                  </Text>
                )}
              </Box>
            </Box>

            {/* Remark Section */}
            <Box
              style={{
                padding: tokens.spacing[4],
                borderBottom: `1px solid ${tokens.colors.border.primary}`,
              }}
            >
              <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing[2] }}>
                <Text size="sm" weight="semibold" color="secondary">{t('remarkName')}</Text>
                {!editingRemark && (
                  <button
                    onClick={() => {
                      setEditingRemark(true)
                      setRemarkInput(settings.remark || '')
                    }}
                    style={{
                      padding: '4px 10px',
                      borderRadius: tokens.radius.sm,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      background: 'transparent',
                      color: tokens.colors.text.secondary,
                      fontSize: 12,
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                    }}
                  >
                    {settings.remark ? t('modify') : t('setRemark')}
                  </button>
                )}
              </Box>
              {editingRemark ? (
                <Box style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={remarkInput}
                    onChange={(e) => setRemarkInput(e.target.value)}
                    maxLength={50}
                    placeholder={t('enterRemarkName')}
                    aria-label={t('enterRemarkName')}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRemarkSave()
                      if (e.key === 'Escape') setEditingRemark(false)
                    }}
                    style={{
                      flex: 1,
                      padding: '8px 12px',
                      borderRadius: tokens.radius.md,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      background: tokens.colors.bg.secondary,
                      color: tokens.colors.text.primary,
                      fontSize: 14,
                      outline: 'none',
                    }}
                  />
                  <button
                    onClick={handleRemarkSave}
                    disabled={saving}
                    style={{
                      padding: '8px 14px',
                      borderRadius: tokens.radius.md,
                      border: 'none',
                      background: `linear-gradient(135deg, ${tokens.colors.accent.brandHover} 0%, ${tokens.colors.accent.brand} 100%)`,
                      color: tokens.colors.white,
                      fontSize: 13,
                      fontWeight: 600,
                      cursor: saving ? 'not-allowed' : 'pointer',
                      opacity: saving ? 0.6 : 1,
                    }}
                  >
                    {t('save')}
                  </button>
                  <button
                    onClick={() => setEditingRemark(false)}
                    style={{
                      padding: '8px 12px',
                      borderRadius: tokens.radius.md,
                      border: `1px solid ${tokens.colors.border.primary}`,
                      background: 'transparent',
                      color: tokens.colors.text.secondary,
                      fontSize: 13,
                      cursor: 'pointer',
                    }}
                  >
                    {t('cancel')}
                  </button>
                </Box>
              ) : (
                <Text size="sm" color={settings.remark ? 'primary' : 'tertiary'}>
                  {settings.remark || t('notSet')}
                </Text>
              )}
            </Box>

            {/* Actions Section */}
            <Box style={{ padding: `${tokens.spacing[2]} 0` }}>
              {/* Search */}
              <SettingsButton
                icon={
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                }
                label={t('searchChatHistory')}
                onClick={() => { onSearchOpen(); onClose() }}
              />

              {/* Mute Toggle */}
              <SettingsToggle
                icon={
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {settings.is_muted ? (
                      <>
                        <path d="M11 5L6 9H2v6h4l5 4V5z" />
                        <line x1="23" y1="9" x2="17" y2="15" />
                        <line x1="17" y1="9" x2="23" y2="15" />
                      </>
                    ) : (
                      <>
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                        <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                      </>
                    )}
                  </svg>
                }
                label={t('doNotDisturb')}
                checked={settings.is_muted}
                onChange={(checked) => updateSetting({ is_muted: checked })}
                disabled={saving}
              />

              {/* Pin Toggle */}
              <SettingsToggle
                icon={
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="17" x2="12" y2="22" />
                    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17z" />
                  </svg>
                }
                label={t('pinChat')}
                checked={settings.is_pinned}
                onChange={(checked) => updateSetting({ is_pinned: checked })}
                disabled={saving}
              />

              {profileUrl && (
                <SettingsButton
                  icon={
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                      <circle cx="12" cy="7" r="4" />
                    </svg>
                  }
                  label={t('viewProfile')}
                  onClick={() => { window.location.href = profileUrl }}
                />
              )}

              <Box style={{ height: 1, background: tokens.colors.border.primary, margin: `${tokens.spacing[2]} ${tokens.spacing[4]}` }} />

              {/* Clear History */}
              <SettingsButton
                icon={
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                }
                label={t('clearChatHistory')}
                onClick={handleClearHistory}
                danger
              />

              {/* Block */}
              <SettingsButton
                icon={
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                  </svg>
                }
                label={settings.is_blocked ? t('unblockUser') : t('blockUser')}
                onClick={handleBlock}
                danger={!settings.is_blocked}
              />

              {/* Report */}
              <SettingsButton
                icon={
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                    <line x1="4" y1="22" x2="4" y2="15" />
                  </svg>
                }
                label={t('report')}
                onClick={() => setReportModalOpen(true)}
                danger
              />
            </Box>
          </Box>
        )}
      </Box>

      {/* Report Modal */}
      <ReportModal
        isOpen={reportModalOpen}
        onClose={() => setReportModalOpen(false)}
        contentType="message"
        contentId={conversationId}
        accessToken={accessToken}
        targetName={`@${otherUser.handle || `User ${otherUser.id.slice(0, 8)}`}`}
      />
    </>
  )
}

function SettingsButton({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}) {
  const textColor = danger ? tokens.colors.accent.error : tokens.colors.text.primary
  const iconColor = danger ? tokens.colors.accent.error : tokens.colors.text.secondary

  return (
    <button
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[3],
        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
        border: 'none',
        background: 'transparent',
        color: textColor,
        fontSize: 14,
        cursor: 'pointer',
        transition: 'background 0.2s',
        textAlign: 'left',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = tokens.colors.bg.secondary
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      <Box style={{ color: iconColor, flexShrink: 0 }}>
        {icon}
      </Box>
      <Text size="sm" style={{ color: 'inherit' }}>{label}</Text>
      <Box style={{ marginLeft: 'auto', color: tokens.colors.text.tertiary }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </Box>
    </button>
  )
}

// Reusable toggle component
function SettingsToggle({
  icon,
  label,
  checked,
  onChange,
  disabled,
}: {
  icon: React.ReactNode
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[3],
        padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
        border: 'none',
        background: 'transparent',
        color: tokens.colors.text.primary,
        fontSize: 14,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background 0.2s',
        textAlign: 'left',
        opacity: disabled ? 0.6 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = tokens.colors.bg.secondary
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      <Box style={{ color: tokens.colors.text.secondary, flexShrink: 0 }}>{icon}</Box>
      <Text size="sm" style={{ flex: 1, color: 'inherit' }}>{label}</Text>
      {/* Toggle Switch */}
      <Box
        style={{
          width: 44,
          height: 24,
          borderRadius: tokens.radius.lg,
          background: checked ? `linear-gradient(135deg, ${tokens.colors.accent.brandHover} 0%, ${tokens.colors.accent.brand} 100%)` : tokens.colors.bg.tertiary || 'var(--glass-border-medium)',
          position: 'relative',
          transition: 'background 0.2s',
          flexShrink: 0,
        }}
      >
        <Box
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 22 : 2,
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: tokens.colors.white,
            boxShadow: tokens.shadow.sm,
            transition: 'left 0.2s',
          }}
        />
      </Box>
    </button>
  )
}
