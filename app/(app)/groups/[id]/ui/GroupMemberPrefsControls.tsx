'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { getCsrfHeaders } from '@/lib/api/client'
import { logger } from '@/lib/logger'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import {
  readGroupMemberPreferencesMutationAcknowledgement,
  readGroupMemberPreferencesSnapshot,
  type GroupMemberPreferenceField,
  type GroupMemberPreferences,
} from '@/lib/groups/member-prefs-contract'
import type { ViewerKey } from '@/lib/auth/viewer-scope'

interface GroupMemberPrefsControlsProps {
  groupId: string
}

type IdentityScope = {
  key: string
  viewerKey: ViewerKey
  sessionGeneration: number
  viewerId: string
  groupId: string
}

type OperationScope = IdentityScope & { generation: number }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const GROUP_PREFS_TIMEOUT_MS = 15_000

/** Member-controlled broadcast mute and group pin preferences. */
export default function GroupMemberPrefsControls({ groupId }: GroupMemberPrefsControlsProps) {
  const { t } = useLanguage()
  const { showToast } = useToast()
  const { accessToken, authChecked, userId, viewerKey, sessionGeneration } = useAuthSession()
  const [preferences, setPreferences] = useState<GroupMemberPreferences | null>(null)
  const [preferencesScopeKey, setPreferencesScopeKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  const canonicalViewerId = userId?.toLowerCase() ?? null
  const canonicalGroupId = groupId.toLowerCase()
  const identityScope: IdentityScope | null =
    authChecked &&
    canonicalViewerId &&
    viewerKey !== 'pending' &&
    viewerKey !== 'anon' &&
    UUID_PATTERN.test(canonicalViewerId) &&
    UUID_PATTERN.test(canonicalGroupId)
      ? {
          key: `${viewerKey}:${sessionGeneration}:${canonicalGroupId}`,
          viewerKey,
          sessionGeneration,
          viewerId: canonicalViewerId,
          groupId: canonicalGroupId,
        }
      : null

  const identityScopeRef = useRef<IdentityScope | null>(identityScope)
  identityScopeRef.current = identityScope
  const authRef = useRef({ accessToken })
  authRef.current = { accessToken }
  const tRef = useRef(t)
  tRef.current = t
  const generationRef = useRef(0)
  const operationSequenceRef = useRef(0)
  const loadOperationRef = useRef<number | null>(null)
  const mutationOperationRef = useRef<number | null>(null)
  const loadAbortRef = useRef<AbortController | null>(null)
  const mutationAbortRef = useRef<AbortController | null>(null)

  const isCurrentScope = useCallback((scope: OperationScope) => {
    const current = identityScopeRef.current
    return (
      scope.generation === generationRef.current &&
      current?.key === scope.key &&
      current.viewerKey === scope.viewerKey &&
      current.sessionGeneration === scope.sessionGeneration &&
      current.viewerId === scope.viewerId &&
      current.groupId === scope.groupId
    )
  }, [])

  const loadPreferences = useCallback(
    async (scope: OperationScope) => {
      const operationToken = authRef.current.accessToken
      if (
        !operationToken ||
        loadOperationRef.current !== null ||
        mutationOperationRef.current !== null ||
        !isCurrentScope(scope)
      ) {
        return
      }

      const operationId = ++operationSequenceRef.current
      loadOperationRef.current = operationId
      const controller = new AbortController()
      loadAbortRef.current?.abort()
      loadAbortRef.current = controller
      let timedOut = false
      const timeoutId = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, GROUP_PREFS_TIMEOUT_MS)
      setLoading(true)
      setLoadFailed(false)

      try {
        const response = await fetch(`/api/groups/${scope.groupId}/prefs`, {
          headers: { Authorization: `Bearer ${operationToken}` },
          signal: controller.signal,
        })
        const payload: unknown = await response.json().catch(() => null)
        const acknowledgement =
          response.status === 200
            ? readGroupMemberPreferencesSnapshot(payload, {
                viewerId: scope.viewerId,
                groupId: scope.groupId,
              })
            : null

        if (
          (controller.signal.aborted && !timedOut) ||
          loadOperationRef.current !== operationId ||
          !isCurrentScope(scope)
        ) {
          return
        }
        if (timedOut) throw new Error('Group preference snapshot timed out')
        if (!acknowledgement) throw new Error('Invalid group preference snapshot')

        setPreferences(acknowledgement)
        setPreferencesScopeKey(scope.key)
      } catch (error) {
        if (
          (controller.signal.aborted && !timedOut) ||
          loadOperationRef.current !== operationId ||
          !isCurrentScope(scope)
        ) {
          return
        }
        logger.warn('Failed to load group prefs:', error)
        setLoadFailed(true)
        showToast(tRef.current('loadFailed'), 'error')
      } finally {
        clearTimeout(timeoutId)
        if (loadOperationRef.current === operationId) {
          loadOperationRef.current = null
          if (isCurrentScope(scope)) setLoading(false)
        }
        if (loadAbortRef.current === controller) loadAbortRef.current = null
      }
    },
    [isCurrentScope, showToast]
  )

  const scopeKey = identityScope?.key ?? null
  const hasAccessToken = Boolean(accessToken)
  useEffect(() => {
    generationRef.current += 1
    loadAbortRef.current?.abort()
    mutationAbortRef.current?.abort()
    loadOperationRef.current = null
    mutationOperationRef.current = null
    setBusy(false)
    setLoadFailed(false)
    setPreferences(null)
    setPreferencesScopeKey(null)

    const current = identityScopeRef.current
    if (!current) {
      setLoading(false)
      return
    }
    if (!hasAccessToken) {
      setLoading(false)
      setLoadFailed(true)
      return
    }

    const scope: OperationScope = { ...current, generation: generationRef.current }
    void loadPreferences(scope)
  }, [hasAccessToken, loadPreferences, scopeKey])

  useEffect(
    () => () => {
      generationRef.current += 1
      loadAbortRef.current?.abort()
      mutationAbortRef.current?.abort()
      loadOperationRef.current = null
      mutationOperationRef.current = null
    },
    []
  )

  const retryLoad = () => {
    const current = identityScopeRef.current
    if (!current || !authRef.current.accessToken) return
    void loadPreferences({ ...current, generation: generationRef.current })
  }

  const toggle = async (field: GroupMemberPreferenceField, next: boolean) => {
    const current = identityScopeRef.current
    const operationToken = authRef.current.accessToken
    const visiblePreferences = preferencesScopeKey === current?.key ? preferences : null
    if (
      !current ||
      !operationToken ||
      !visiblePreferences ||
      mutationOperationRef.current !== null ||
      loadOperationRef.current !== null
    ) {
      return
    }

    const operationId = ++operationSequenceRef.current
    mutationOperationRef.current = operationId
    const scope: OperationScope = { ...current, generation: generationRef.current }
    const previous = visiblePreferences
    const optimistic = {
      ...previous,
      ...(field === 'self_notify_muted' ? { selfNotifyMuted: next } : { pinned: next }),
    }
    const controller = new AbortController()
    mutationAbortRef.current?.abort()
    mutationAbortRef.current = controller
    let timedOut = false
    const timeoutId = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, GROUP_PREFS_TIMEOUT_MS)
    setBusy(true)
    setPreferences(optimistic)

    try {
      const response = await fetch(`/api/groups/${scope.groupId}/prefs`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${operationToken}`,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ [field]: next }),
        signal: controller.signal,
      })
      const payload: unknown = await response.json().catch(() => null)
      const acknowledgement =
        response.status === 200
          ? readGroupMemberPreferencesMutationAcknowledgement(payload, {
              viewerId: scope.viewerId,
              groupId: scope.groupId,
              field,
              value: next,
            })
          : null

      if (
        (controller.signal.aborted && !timedOut) ||
        mutationOperationRef.current !== operationId ||
        !isCurrentScope(scope)
      ) {
        return
      }
      if (timedOut) throw new Error('Group preference mutation timed out')
      if (!acknowledgement) throw new Error('Invalid group preference mutation acknowledgement')

      setPreferences(acknowledgement)
      showToast(
        field === 'self_notify_muted'
          ? next
            ? tRef.current('groupPrefs_mutedToast')
            : tRef.current('groupPrefs_unmutedToast')
          : next
            ? tRef.current('groupPrefs_pinnedToast')
            : tRef.current('groupPrefs_unpinnedToast'),
        'success'
      )
    } catch (error) {
      if (
        (controller.signal.aborted && !timedOut) ||
        mutationOperationRef.current !== operationId ||
        !isCurrentScope(scope)
      ) {
        return
      }
      setPreferences(previous)
      logger.error('Group prefs update failed:', error)
      showToast(tRef.current('groupPrefs_updateFailed'), 'error')
    } finally {
      clearTimeout(timeoutId)
      if (mutationOperationRef.current === operationId) {
        mutationOperationRef.current = null
        if (isCurrentScope(scope)) setBusy(false)
      }
      if (mutationAbortRef.current === controller) mutationAbortRef.current = null
    }
  }

  if (!identityScope) return null

  const visiblePreferences = preferencesScopeKey === identityScope.key ? preferences : null

  if (!visiblePreferences) {
    if (!loading && loadFailed) {
      return (
        <button
          type="button"
          onClick={retryLoad}
          style={{
            minHeight: 44,
            padding: `0 ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.secondary,
            color: tokens.colors.text.secondary,
            cursor: 'pointer',
          }}
        >
          {t('loadFailed')} · {t('retry')}
        </button>
      )
    }

    return (
      <span aria-label={t('loading')} aria-busy="true" style={{ display: 'inline-flex', gap: 8 }}>
        <span className="skeleton" style={{ display: 'inline-block', width: 44, height: 44 }} />
        <span className="skeleton" style={{ display: 'inline-block', width: 44, height: 44 }} />
      </span>
    )
  }

  const controlsBusy = busy || loading
  const iconBtnStyle = (active: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 44,
    height: 44,
    borderRadius: tokens.radius.md,
    background: active ? 'var(--color-accent-primary-10)' : tokens.colors.bg.secondary,
    border: `1px solid ${active ? tokens.colors.accent.primary : tokens.colors.border.primary}`,
    color: active ? tokens.colors.accent.primary : tokens.colors.text.secondary,
    cursor: controlsBusy ? 'default' : 'pointer',
    opacity: controlsBusy ? 0.6 : 1,
    transition: `all ${tokens.transition.base}`,
  })

  return (
    <span style={{ display: 'inline-flex', gap: tokens.spacing[2] }}>
      <button
        type="button"
        aria-pressed={visiblePreferences.selfNotifyMuted}
        aria-busy={busy || undefined}
        disabled={controlsBusy}
        title={visiblePreferences.selfNotifyMuted ? t('groupPrefs_unmute') : t('groupPrefs_mute')}
        aria-label={
          visiblePreferences.selfNotifyMuted ? t('groupPrefs_unmute') : t('groupPrefs_mute')
        }
        onClick={() => toggle('self_notify_muted', !visiblePreferences.selfNotifyMuted)}
        style={iconBtnStyle(visiblePreferences.selfNotifyMuted)}
      >
        {visiblePreferences.selfNotifyMuted ? (
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
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
            aria-hidden="true"
          >
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
        )}
      </button>

      <button
        type="button"
        aria-pressed={visiblePreferences.pinned}
        aria-busy={busy || undefined}
        disabled={controlsBusy}
        title={visiblePreferences.pinned ? t('groupPrefs_unpin') : t('groupPrefs_pin')}
        aria-label={visiblePreferences.pinned ? t('groupPrefs_unpin') : t('groupPrefs_pin')}
        onClick={() => toggle('pinned', !visiblePreferences.pinned)}
        style={iconBtnStyle(visiblePreferences.pinned)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill={visiblePreferences.pinned ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="12" y1="17" x2="12" y2="22" />
          <path d="M5 17h14l-1.5-3V5a1 1 0 0 0-1-1h-9a1 1 0 0 0-1 1v9L5 17z" />
        </svg>
      </button>

      {loadFailed && (
        <button
          type="button"
          onClick={retryLoad}
          disabled={controlsBusy}
          aria-label={`${t('loadFailed')}; ${t('retry')}`}
          title={`${t('loadFailed')}; ${t('retry')}`}
          style={iconBtnStyle(false)}
        >
          <span aria-hidden="true">↻</span>
        </button>
      )}
    </span>
  )
}
