'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { tokens, alpha, alpha as colorAlpha } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useToast } from '@/app/components/ui/Toast'
import { useDialog } from '@/app/components/ui/Dialog'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import EmptyState from '@/app/components/ui/EmptyState'
import { logger } from '@/lib/logger'
import { authedFetch } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '../hooks/settings-viewer-scope'
import { parseLinkedTraderManagementPayload, type LinkedTrader } from './linked-trader-management'

type TraderStateOwner = Pick<
  SettingsViewerSnapshot,
  'sessionGeneration' | 'userId' | 'viewerKey'
> & {
  loadGeneration: number
}

type TraderLoadOutcome = 'idle' | 'loading' | 'ready' | 'failed'

function traderOwnerMatches(
  owner: TraderStateOwner | null,
  viewer: SettingsViewerSnapshot | null,
  loadGeneration: number
): boolean {
  return (
    !!owner &&
    !!viewer &&
    owner.loadGeneration === loadGeneration &&
    owner.viewerKey === viewer.viewerKey &&
    owner.sessionGeneration === viewer.sessionGeneration &&
    owner.userId === viewer.userId
  )
}

function getPlatformName(source: string): string {
  return (
    EXCHANGE_CONFIG[source as keyof typeof EXCHANGE_CONFIG]?.name ||
    source.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  )
}

function getExchangeKey(source: string): string {
  // Extract base exchange name for logo lookup
  const base = source.split('_')[0]
  return base
}

function formatVerificationMethod(method: string, t: (key: string) => string): string {
  const map: Record<string, string> = {
    api_key: t('verificationMethodApiKey'),
    signature: t('verificationMethodSignature'),
    video: t('verificationMethodVideo'),
    social: t('verificationMethodSocial'),
  }
  return map[method] || method
}

function formatDate(dateStr: string, language: string): string {
  try {
    const locale = { en: 'en-US', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR' }[language] ?? 'en-US'
    return new Date(dateStr).toLocaleDateString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return dateStr
  }
}

function getLinkedTraderIdentityLabel(trader: LinkedTrader): string {
  const displayName = trader.label || trader.trader_id.slice(0, 12)
  return `${displayName} · ${getPlatformName(trader.source)} · ${trader.trader_id}`
}

export function TraderLinksSection({ userId }: { userId: string }) {
  const [traders, setTraders] = useState<LinkedTrader[]>([])
  const [loading, setLoading] = useState(true)
  const [editingLabelId, setEditingLabelId] = useState<string | null>(null)
  const [editLabelValue, setEditLabelValue] = useState('')
  const [updatingId, setUpdatingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const labelInputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const { showToast } = useToast()
  const { showConfirm } = useDialog()
  const { t, language } = useLanguage()
  const auth = useAuthSession()
  const authRef = useRef(auth)
  authRef.current = auth
  const feedbackRef = useRef({ showToast, t })
  feedbackRef.current = { showToast, t }
  const mountedRef = useRef(false)
  const loadGenerationRef = useRef(0)
  const ownerRef = useRef<TraderStateOwner | null>(null)
  const loadOutcomeRef = useRef<TraderLoadOutcome>('idle')
  const mutationRef = useRef<{ id: number } | null>(null)
  const nextMutationIdRef = useRef(0)
  const [stateOwner, setStateOwner] = useState<TraderStateOwner | null>(null)
  const [loadOutcome, setLoadOutcome] = useState<TraderLoadOutcome>('idle')

  const captureViewer = useCallback(() => {
    const scope = captureSettingsViewer(authRef.current)
    return scope?.userId === userId ? scope : null
  }, [userId])

  const stateBelongsToViewer = useCallback(
    (scope: SettingsViewerSnapshot, expectedLoadGeneration?: number) => {
      const owner = ownerRef.current
      return (
        mountedRef.current &&
        loadOutcomeRef.current === 'ready' &&
        traderOwnerMatches(owner, scope, loadGenerationRef.current) &&
        (expectedLoadGeneration === undefined ||
          owner?.loadGeneration === expectedLoadGeneration) &&
        isSettingsViewerCurrent(scope, authRef.current)
      )
    },
    []
  )

  const loadLinkedTraders = useCallback(
    async (expectedScope?: SettingsViewerSnapshot) => {
      const scope = expectedScope ?? captureViewer()
      if (!scope || !isSettingsViewerCurrent(scope, authRef.current)) return
      const loadGeneration = ++loadGenerationRef.current
      const owner: TraderStateOwner = { ...scope, loadGeneration }
      const loadIsCurrent = () =>
        mountedRef.current &&
        loadGenerationRef.current === loadGeneration &&
        isSettingsViewerCurrent(scope, authRef.current)

      ownerRef.current = owner
      loadOutcomeRef.current = 'loading'
      setStateOwner(owner)
      setLoadOutcome('loading')
      setTraders([])
      setLoading(true)
      try {
        const result = await authedFetch<{ data?: unknown }>(
          '/api/traders/linked',
          'GET',
          scope.accessToken,
          undefined,
          15_000,
          {
            expectedUserId: scope.userId,
            expectedSessionGeneration: scope.sessionGeneration,
          }
        )
        if (!loadIsCurrent() || result.stale) return
        const linkedTraders = result.ok
          ? parseLinkedTraderManagementPayload(result.data?.data, scope.userId)
          : null
        if (linkedTraders) {
          setTraders(linkedTraders)
          loadOutcomeRef.current = 'ready'
          setLoadOutcome('ready')
        } else {
          loadOutcomeRef.current = 'failed'
          setLoadOutcome('failed')
          feedbackRef.current.showToast(feedbackRef.current.t('loadLinkedTradersFailed'), 'error')
        }
      } catch (error) {
        if (!loadIsCurrent()) return
        loadOutcomeRef.current = 'failed'
        setLoadOutcome('failed')
        logger.error('[TraderLinks] Load error:', error)
        feedbackRef.current.showToast(feedbackRef.current.t('loadLinkedTradersFailed'), 'error')
      } finally {
        if (loadIsCurrent()) setLoading(false)
      }
    },
    [captureViewer]
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadGenerationRef.current += 1
      mutationRef.current = null
    }
  }, [])

  useEffect(() => {
    loadGenerationRef.current += 1
    ownerRef.current = null
    loadOutcomeRef.current = 'idle'
    mutationRef.current = null
    setStateOwner(null)
    setLoadOutcome('idle')
    setTraders([])
    setEditingLabelId(null)
    setEditLabelValue('')
    setUpdatingId(null)
    setDeletingId(null)
    setLoading(auth.loading || !auth.authChecked || Boolean(auth.userId))
    if (auth.authChecked && !auth.loading && auth.userId === userId) void loadLinkedTraders()
  }, [
    auth.authChecked,
    auth.loading,
    auth.sessionGeneration,
    auth.userId,
    loadLinkedTraders,
    userId,
  ])

  // Focus label input when editing
  useEffect(() => {
    if (editingLabelId && labelInputRef.current) {
      labelInputRef.current.focus()
    }
  }, [editingLabelId])

  const beginMutation = () => {
    const scope = captureViewer()
    const loadGeneration = ownerRef.current?.loadGeneration
    if (
      !scope ||
      loadGeneration === undefined ||
      mutationRef.current ||
      !stateBelongsToViewer(scope, loadGeneration)
    ) {
      return null
    }
    const operation = { id: ++nextMutationIdRef.current, loadGeneration, scope }
    mutationRef.current = operation
    return operation
  }

  const mutationIsCurrent = (operation: {
    id: number
    loadGeneration: number
    scope: SettingsViewerSnapshot
  }) =>
    mutationRef.current?.id === operation.id &&
    stateBelongsToViewer(operation.scope, operation.loadGeneration)

  const finishMutation = (operation: { id: number; scope: SettingsViewerSnapshot }) => {
    if (mutationRef.current?.id !== operation.id) return
    mutationRef.current = null
    if (isSettingsViewerCurrent(operation.scope, authRef.current)) {
      setUpdatingId(null)
      setDeletingId(null)
    }
  }

  const handleUpdateLabel = async (id: string) => {
    const operation = beginMutation()
    if (!operation || !traders.some((trader) => trader.id === id)) {
      if (operation) finishMutation(operation)
      return
    }
    const normalizedLabel = editLabelValue.trim() || null
    setUpdatingId(id)
    try {
      const result = await authedFetch(
        '/api/traders/linked',
        'PATCH',
        operation.scope.accessToken,
        { id, label: normalizedLabel },
        15_000,
        {
          expectedUserId: operation.scope.userId,
          expectedSessionGeneration: operation.scope.sessionGeneration,
        }
      )
      if (!mutationIsCurrent(operation) || result.stale) return
      if (result.ok) {
        setTraders((prev) =>
          prev.map((trader) => (trader.id === id ? { ...trader, label: normalizedLabel } : trader))
        )
        feedbackRef.current.showToast(feedbackRef.current.t('labelSaved'), 'success')
      } else {
        feedbackRef.current.showToast(feedbackRef.current.t('operationFailed'), 'error')
      }
    } catch {
      if (mutationIsCurrent(operation)) {
        feedbackRef.current.showToast(feedbackRef.current.t('operationFailed'), 'error')
      }
    } finally {
      if (mutationIsCurrent(operation)) setEditingLabelId(null)
      finishMutation(operation)
    }
  }

  const handleSetPrimary = async (id: string) => {
    const operation = beginMutation()
    if (!operation || !traders.some((trader) => trader.id === id && !trader.is_primary)) {
      if (operation) finishMutation(operation)
      return
    }
    setUpdatingId(id)
    try {
      const result = await authedFetch(
        '/api/traders/linked',
        'PATCH',
        operation.scope.accessToken,
        { id, is_primary: true },
        15_000,
        {
          expectedUserId: operation.scope.userId,
          expectedSessionGeneration: operation.scope.sessionGeneration,
        }
      )
      if (!mutationIsCurrent(operation) || result.stale) return
      if (result.ok) {
        setTraders((prev) =>
          prev.map((trader) => ({
            ...trader,
            is_primary: trader.id === id,
          }))
        )
        feedbackRef.current.showToast(feedbackRef.current.t('primarySet'), 'success')
      } else {
        feedbackRef.current.showToast(feedbackRef.current.t('operationFailed'), 'error')
      }
    } catch {
      if (mutationIsCurrent(operation)) {
        feedbackRef.current.showToast(feedbackRef.current.t('operationFailed'), 'error')
      }
    } finally {
      finishMutation(operation)
    }
  }

  const handleUnlink = async (trader: LinkedTrader) => {
    const operation = beginMutation()
    const ownedTrader = traders.find((candidate) => candidate.id === trader.id)
    if (!operation || !ownedTrader) {
      if (operation) finishMutation(operation)
      return
    }
    // Determine the appropriate warning
    let warningMsg = t('unlinkWarning')
    if (ownedTrader.is_primary && traders.length > 1) {
      warningMsg = t('unlinkPrimaryWarning')
    } else if (traders.length === 1) {
      warningMsg = t('unlinkLastWarning')
    }

    let confirmed = false
    try {
      confirmed = await showConfirm(t('confirmUnlink'), warningMsg)
    } catch {
      if (mutationIsCurrent(operation)) {
        feedbackRef.current.showToast(feedbackRef.current.t('operationFailed'), 'error')
      }
    }
    if (!confirmed || !mutationIsCurrent(operation)) {
      finishMutation(operation)
      return
    }

    setDeletingId(ownedTrader.id)
    try {
      const result = await authedFetch<{
        data?: { promoted_link_id?: string | null; remaining_count?: number }
        error?: string
      }>(
        '/api/traders/linked',
        'DELETE',
        operation.scope.accessToken,
        { id: ownedTrader.id },
        15_000,
        {
          expectedUserId: operation.scope.userId,
          expectedSessionGeneration: operation.scope.sessionGeneration,
        }
      )
      if (!mutationIsCurrent(operation) || result.stale) return
      if (result.ok) {
        const promotedLinkId = result.data?.data?.promoted_link_id
        const remaining = traders.filter((candidate) => candidate.id !== ownedTrader.id)
        const remainingCount = result.data?.data?.remaining_count
        const responseIsConsistent =
          Number.isInteger(remainingCount) &&
          remainingCount === remaining.length &&
          (promotedLinkId == null || remaining.some((candidate) => candidate.id === promotedLinkId))
        const unresolvedPrimary =
          remaining.length > 0 &&
          promotedLinkId == null &&
          !remaining.some((candidate) => candidate.is_primary)

        if (!responseIsConsistent || unresolvedPrimary) {
          await loadLinkedTraders(operation.scope)
        } else {
          setTraders(
            remaining.map((candidate) =>
              promotedLinkId == null
                ? candidate
                : { ...candidate, is_primary: candidate.id === promotedLinkId }
            )
          )
        }
        feedbackRef.current.showToast(feedbackRef.current.t('traderUnlinked'), 'success')

        // If no remaining accounts, could refresh to reflect verified status change
        if (result.data?.data?.remaining_count === 0 && mutationIsCurrent(operation)) {
          router.refresh()
        }
      } else {
        feedbackRef.current.showToast(
          result.data?.error || feedbackRef.current.t('operationFailed'),
          'error'
        )
      }
    } catch {
      if (mutationIsCurrent(operation)) {
        feedbackRef.current.showToast(feedbackRef.current.t('networkError'), 'error')
      }
    } finally {
      finishMutation(operation)
    }
  }

  const renderScopeCandidate = captureSettingsViewer(auth)
  const renderScope = renderScopeCandidate?.userId === userId ? renderScopeCandidate : null
  const stateOwnerIsCurrent = traderOwnerMatches(stateOwner, renderScope, loadGenerationRef.current)
  const stateReady = stateOwnerIsCurrent && loadOutcome === 'ready'
  const loadFailed = stateOwnerIsCurrent && loadOutcome === 'failed'
  const visibleTraders = stateReady ? traders : []
  const visibleEditingLabelId = stateReady ? editingLabelId : null
  const visibleUpdatingId = stateReady ? updatingId : null
  const visibleDeletingId = stateReady ? deletingId : null
  const displayLoading =
    auth.loading ||
    !auth.authChecked ||
    loading ||
    Boolean(
      auth.userId && (!stateOwnerIsCurrent || loadOutcome === 'idle' || loadOutcome === 'loading')
    )

  const handleLinkNewAccount = () => {
    const scope = captureViewer()
    if (!scope || !stateBelongsToViewer(scope)) return
    if (traders.length >= 10) {
      feedbackRef.current.showToast(feedbackRef.current.t('maxLinkedAccounts'), 'error')
      return
    }
    router.push('/claim')
  }

  if (displayLoading) {
    return (
      <Box style={{ padding: tokens.spacing[4], textAlign: 'center' }}>
        <Text size="sm" color="tertiary">
          {t('loadingText')}
        </Text>
      </Box>
    )
  }

  if (loadFailed) {
    return (
      <Box
        role="alert"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: tokens.spacing[3],
          padding: tokens.spacing[4],
          borderRadius: tokens.radius.lg,
          border: `1px solid ${alpha(tokens.colors.accent.error, 20)}`,
          background: alpha(tokens.colors.accent.error, 5),
        }}
      >
        <Text size="sm" style={{ color: tokens.colors.accent.error }}>
          {t('loadLinkedTradersFailed')}
        </Text>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            const scope = captureViewer()
            if (scope) void loadLinkedTraders(scope)
          }}
        >
          {t('retry')}
        </Button>
      </Box>
    )
  }

  // Empty state
  if (visibleTraders.length === 0) {
    return (
      <EmptyState
        variant="compact"
        icon={
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke={tokens.colors.accent.primary}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <line x1="19" y1="8" x2="19" y2="14" />
            <line x1="22" y1="11" x2="16" y2="11" />
          </svg>
        }
        title={t('noLinkedAccounts')}
        description={t('linkAccountDescription')}
        action={{ label: t('linkNewAccount'), onClick: handleLinkNewAccount }}
      />
    )
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
      {/* Linked trader cards */}
      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
        {visibleTraders.map((trader) => (
          <Box
            key={trader.id}
            style={{
              padding: tokens.spacing[4],
              borderRadius: tokens.radius.lg,
              background: tokens.colors.bg.primary,
              border: `1px solid ${trader.is_primary ? colorAlpha(tokens.colors.accent.primary, 25) : tokens.colors.border.primary}`,
              transition: `all ${tokens.transition.base}`,
            }}
          >
            {/* Header row: logo + name + badges */}
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: tokens.spacing[3],
                marginBottom: tokens.spacing[3],
              }}
            >
              <ExchangeLogo exchange={getExchangeKey(trader.source)} size={32} />
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Box
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.spacing[2],
                    flexWrap: 'wrap',
                  }}
                >
                  <Text
                    size="sm"
                    weight="bold"
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {trader.label || trader.trader_id.slice(0, 12)}
                  </Text>
                  {trader.is_primary && (
                    <span
                      style={{
                        padding: `1px ${tokens.spacing[2]}`,
                        borderRadius: tokens.radius.sm,
                        background: `${alpha(tokens.colors.accent.primary, 13)}`,
                        color: tokens.colors.accent.primary,
                        fontSize: tokens.typography.fontSize.xs,
                        fontWeight: tokens.typography.fontWeight.bold,
                        letterSpacing: '0.5px',
                        textTransform: 'uppercase',
                      }}
                    >
                      {t('primaryAccount')}
                    </span>
                  )}
                </Box>
                <Text size="xs" color="tertiary">
                  {getPlatformName(trader.source)} &middot;{' '}
                  {formatVerificationMethod(trader.verification_method, t)} &middot;{' '}
                  {t('verifiedOn')} {formatDate(trader.verified_at, language)}
                </Text>
                <Text
                  size="xs"
                  color="tertiary"
                  style={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}
                >
                  {trader.source}:{trader.trader_id}
                </Text>
              </Box>
            </Box>

            {/* Label edit */}
            {visibleEditingLabelId === trader.id ? (
              <Box
                style={{ display: 'flex', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}
              >
                <input
                  ref={labelInputRef}
                  value={editLabelValue}
                  onChange={(e) => {
                    const scope = captureViewer()
                    if (!scope || !stateBelongsToViewer(scope)) return
                    setEditLabelValue(e.target.value)
                  }}
                  placeholder={t('labelPlaceholder')}
                  aria-label={`${t('labelPlaceholder')}: ${getLinkedTraderIdentityLabel(trader)}`}
                  maxLength={50}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleUpdateLabel(trader.id)
                    if (e.key === 'Escape') {
                      const scope = captureViewer()
                      if (scope && stateBelongsToViewer(scope)) setEditingLabelId(null)
                    }
                  }}
                  style={{
                    flex: 1,
                    padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: tokens.colors.bg.secondary,
                    color: tokens.colors.text.primary,
                    fontSize: tokens.typography.fontSize.sm,
                    outline: 'none',
                    minHeight: 36,
                  }}
                />
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  aria-label={`${t('save')}: ${getLinkedTraderIdentityLabel(trader)}`}
                  onClick={() => handleUpdateLabel(trader.id)}
                  disabled={visibleUpdatingId === trader.id}
                  style={{ minHeight: 36 }}
                >
                  {visibleUpdatingId === trader.id ? '...' : t('save')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`${t('cancel')}: ${getLinkedTraderIdentityLabel(trader)}`}
                  onClick={() => {
                    const scope = captureViewer()
                    if (scope && stateBelongsToViewer(scope)) setEditingLabelId(null)
                  }}
                  style={{ minHeight: 36 }}
                >
                  {t('cancel')}
                </Button>
              </Box>
            ) : null}

            {/* Action buttons */}
            <Box
              className="trader-link-actions"
              style={{
                display: 'flex',
                gap: tokens.spacing[2],
                flexWrap: 'wrap',
              }}
            >
              <Link
                href={`/trader/${encodeURIComponent(trader.trader_id)}?platform=${encodeURIComponent(trader.source)}`}
                aria-label={`${t('viewProfile')}: ${getLinkedTraderIdentityLabel(trader)}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: 'transparent',
                  color: tokens.colors.text.secondary,
                  fontSize: tokens.typography.fontSize.xs,
                  minHeight: 32,
                  textDecoration: 'none',
                  transition: `all ${tokens.transition.base}`,
                }}
              >
                {t('viewProfile')}
              </Link>
              {!trader.is_primary && (
                <button
                  type="button"
                  aria-label={`${t('setAsPrimary')}: ${getLinkedTraderIdentityLabel(trader)}`}
                  onClick={() => handleSetPrimary(trader.id)}
                  disabled={!!visibleUpdatingId || !!visibleDeletingId}
                  style={{
                    padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    background: 'transparent',
                    color: tokens.colors.text.secondary,
                    fontSize: tokens.typography.fontSize.xs,
                    cursor: 'pointer',
                    minHeight: 32,
                    transition: `all ${tokens.transition.base}`,
                    opacity: visibleUpdatingId || visibleDeletingId ? 0.5 : 1,
                  }}
                >
                  {visibleUpdatingId === trader.id ? '...' : t('setAsPrimary')}
                </button>
              )}
              <button
                type="button"
                aria-label={`${t('editLabel')}: ${getLinkedTraderIdentityLabel(trader)}`}
                onClick={() => {
                  const scope = captureViewer()
                  if (!scope || !stateBelongsToViewer(scope) || mutationRef.current) return
                  setEditingLabelId(trader.id)
                  setEditLabelValue(trader.label || '')
                }}
                disabled={!!visibleUpdatingId || !!visibleDeletingId}
                style={{
                  padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: 'transparent',
                  color: tokens.colors.text.secondary,
                  fontSize: tokens.typography.fontSize.xs,
                  cursor: 'pointer',
                  minHeight: 32,
                  transition: `all ${tokens.transition.base}`,
                }}
              >
                {t('editLabel')}
              </button>
              <button
                type="button"
                aria-label={`${t('unlinkAccount')}: ${getLinkedTraderIdentityLabel(trader)}`}
                onClick={() => handleUnlink(trader)}
                disabled={!!visibleDeletingId || !!visibleUpdatingId}
                style={{
                  padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${alpha(tokens.colors.accent.error, 19)}`,
                  background: 'transparent',
                  color: tokens.colors.accent.error,
                  fontSize: tokens.typography.fontSize.xs,
                  cursor: 'pointer',
                  minHeight: 32,
                  transition: `all ${tokens.transition.base}`,
                  opacity: visibleDeletingId || visibleUpdatingId ? 0.5 : 1,
                }}
              >
                {visibleDeletingId === trader.id ? '...' : t('unlinkAccount')}
              </button>
            </Box>
          </Box>
        ))}
      </Box>

      {/* Link new account button */}
      <button
        type="button"
        aria-label={t('linkNewAccount')}
        onClick={handleLinkNewAccount}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: tokens.spacing[2],
          padding: tokens.spacing[3],
          borderRadius: tokens.radius.lg,
          border: `1px dashed ${tokens.colors.border.secondary}`,
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          transition: `all ${tokens.transition.base}`,
          minHeight: 44,
          width: '100%',
          font: 'inherit',
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke={tokens.colors.text.tertiary}
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <Text size="sm" color="tertiary">
          {t('linkNewAccount')}
        </Text>
      </button>

      {/* Mobile-responsive styles */}
      <style>{`
        @media (max-width: 480px) {
          .trader-link-actions {
            flex-direction: column;
          }
          .trader-link-actions a,
          .trader-link-actions button {
            width: 100%;
            text-align: center;
            min-height: 44px !important;
          }
        }
      `}</style>
    </Box>
  )
}
