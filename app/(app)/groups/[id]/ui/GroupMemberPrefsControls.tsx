'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { getCsrfHeaders } from '@/lib/api/client'
import { logger } from '@/lib/logger'

interface GroupMemberPrefsControlsProps {
  groupId: string
  accessToken: string | null
}

/**
 * Member self-controlled group preferences (U9-12): mute admin broadcasts +
 * pin group to top of "my groups". Only rendered for joined members. Reads the
 * caller's own prefs from GET /api/groups/[id]/prefs and writes via PATCH.
 * Toggles are optimistic — a boolean flip with delta rollback on failure (the
 * rollback flips back to `!next`, never a captured snapshot, per CLAUDE.md).
 */
export default function GroupMemberPrefsControls({
  groupId,
  accessToken,
}: GroupMemberPrefsControlsProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const [muted, setMuted] = useState<boolean | null>(null)
  const [pinned, setPinned] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!accessToken || !groupId) return
    let active = true
    ;(async () => {
      try {
        const res = await fetch(`/api/groups/${groupId}/prefs`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        if (!res.ok) return
        const json = await res.json()
        if (!active) return
        setMuted(!!json.data?.self_notify_muted)
        setPinned(!!json.data?.pinned)
      } catch (err) {
        logger.warn('Failed to load group prefs:', err)
      }
    })()
    return () => {
      active = false
    }
  }, [groupId, accessToken])

  const toggle = async (field: 'self_notify_muted' | 'pinned', next: boolean) => {
    if (busy || !accessToken) return
    setBusy(true)
    // Optimistic: flip to `next` now.
    if (field === 'self_notify_muted') setMuted(next)
    else setPinned(next)
    try {
      const res = await fetch(`/api/groups/${groupId}/prefs`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ [field]: next }),
      })
      if (!res.ok) throw new Error(`prefs PATCH ${res.status}`)
      showToast(
        field === 'self_notify_muted'
          ? next
            ? t('groupPrefs_mutedToast')
            : t('groupPrefs_unmutedToast')
          : next
            ? t('groupPrefs_pinnedToast')
            : t('groupPrefs_unpinnedToast'),
        'success'
      )
    } catch (err) {
      // Delta rollback: flip back to the pre-toggle value (!next).
      if (field === 'self_notify_muted') setMuted(!next)
      else setPinned(!next)
      logger.error('Group prefs update failed:', err)
      showToast(t('groupPrefs_updateFailed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  // Wait until prefs are loaded to avoid a flash of the wrong icon state.
  if (muted === null || pinned === null) return null

  const iconBtnStyle = (active: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 36,
    borderRadius: tokens.radius.md,
    background: active ? 'var(--color-accent-primary-10)' : tokens.colors.bg.secondary,
    border: `1px solid ${active ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
    color: active ? tokens.colors.accent.primary : tokens.colors.text.secondary,
    cursor: busy ? 'default' : 'pointer',
    opacity: busy ? 0.6 : 1,
    transition: `all ${tokens.transition.base}`,
  })

  return (
    <>
      {/* Mute toggle — bell (receiving) vs bell-off (muted) */}
      <button
        type="button"
        aria-pressed={muted}
        disabled={busy}
        title={muted ? t('groupPrefs_unmute') : t('groupPrefs_mute')}
        aria-label={muted ? t('groupPrefs_unmute') : t('groupPrefs_mute')}
        onClick={() => toggle('self_notify_muted', !muted)}
        style={iconBtnStyle(muted)}
      >
        {muted ? (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            <path d="M18.63 13A17.89 17.89 0 0 1 18 8" />
            <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
            <path d="M18 8a6 6 0 0 0-9.33-5" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        ) : (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
        )}
      </button>

      {/* Pin toggle — filled when pinned */}
      <button
        type="button"
        aria-pressed={pinned}
        disabled={busy}
        title={pinned ? t('groupPrefs_unpin') : t('groupPrefs_pin')}
        aria-label={pinned ? t('groupPrefs_unpin') : t('groupPrefs_pin')}
        onClick={() => toggle('pinned', !pinned)}
        style={iconBtnStyle(pinned)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill={pinned ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="12" y1="17" x2="12" y2="22" />
          <path d="M5 17h14l-1.5-3V5a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9L5 17z" />
        </svg>
      </button>
    </>
  )
}
