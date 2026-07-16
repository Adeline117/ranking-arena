'use client'

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { tokens, alpha, alpha as colorAlpha } from '@/lib/design-tokens'
import { Box, Text, Button } from '@/app/components/base'
import { useToast } from '@/app/components/ui/Toast'
import { useDialog } from '@/app/components/ui/Dialog'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { NULL_DISPLAY } from '@/lib/utils/format'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import EmptyState from '@/app/components/ui/EmptyState'
import { logger } from '@/lib/logger'
import { authedFetch } from '@/lib/api/client'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import {
  captureSettingsViewer,
  isSettingsViewerCurrent,
  type SettingsViewerSnapshot,
} from '../hooks/settings-viewer-scope'

interface LinkedTraderStats {
  arena_score: number | null
  roi: number | null
  pnl: number | null
  rank: number | null
  handle: string | null
  avatar_url: string | null
}

interface LinkedTrader {
  id: string
  user_id: string
  trader_id: string
  source: string
  market_type: string
  label: string | null
  is_primary: boolean
  display_order: number
  verified_at: string
  verification_method: string
  created_at: string
  updated_at: string
  stats: LinkedTraderStats | null
}

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

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isLinkedTraderStats(value: unknown): value is LinkedTraderStats {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const stats = value as Record<string, unknown>
  return (
    isNullableFiniteNumber(stats.arena_score) &&
    isNullableFiniteNumber(stats.roi) &&
    isNullableFiniteNumber(stats.pnl) &&
    isNullableFiniteNumber(stats.rank) &&
    isNullableString(stats.handle) &&
    isNullableString(stats.avatar_url)
  )
}

function isLinkedTraderForViewer(value: unknown, userId: string): value is LinkedTrader {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const trader = value as Record<string, unknown>
  return (
    typeof trader.id === 'string' &&
    trader.user_id === userId &&
    typeof trader.trader_id === 'string' &&
    typeof trader.source === 'string' &&
    typeof trader.market_type === 'string' &&
    typeof trader.is_primary === 'boolean' &&
    typeof trader.display_order === 'number' &&
    Number.isFinite(trader.display_order) &&
    typeof trader.verified_at === 'string' &&
    typeof trader.verification_method === 'string' &&
    typeof trader.created_at === 'string' &&
    typeof trader.updated_at === 'string' &&
    (trader.label === null || typeof trader.label === 'string') &&
    (trader.stats === null || isLinkedTraderStats(trader.stats))
  )
}

function getPlatformName(source: string): string {
  const map: Record<string, string> = {
    binance_futures: 'Binance Futures',
    binance_spot: 'Binance Spot',
    binance_web3: 'Binance Web3',
    bybit: 'Bybit',
    bitget_futures: 'Bitget Futures',
    bitget_spot: 'Bitget Spot',
    okx_futures: 'OKX Futures',
    okx_web3: 'OKX Web3',
    mexc: 'MEXC',
    htx_futures: 'HTX',
    coinex: 'CoinEx',
    kucoin: 'KuCoin',
    gate: 'Gate.io',
    gateio: 'Gate.io',
    bingx: 'BingX',
    phemex: 'Phemex',
    hyperliquid: 'Hyperliquid',
    gmx: 'GMX',
    dydx: 'dYdX',
    jupiter_perps: 'Jupiter Perps',
    drift: 'Drift',
    aevo: 'Aevo',
    vertex: 'Vertex',
    kwenta: 'Kwenta',
    gains: 'Gains Network',
    btcc: 'BTCC',
    bitunix: 'Bitunix',
    bitfinex: 'Bitfinex',
    blofin: 'BloFin',
    etoro: 'eToro',
  }
  return map[source] || source.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
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

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return dateStr
  }
}

function formatPnl(pnl: number | null): string {
  if (pnl == null) return NULL_DISPLAY
  const abs = Math.abs(pnl)
  const prefix = pnl >= 0 ? '+$' : '-$'
  if (abs >= 1_000_000) return `${prefix}${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${prefix}${(abs / 1_000).toFixed(1)}K`
  return `${prefix}${abs.toFixed(0)}`
}

function formatRoi(roi: number | null): string {
  if (roi == null) return NULL_DISPLAY
  const prefix = roi >= 0 ? '+' : ''
  return `${prefix}${roi.toFixed(1)}%`
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
  const { t } = useLanguage()
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
        const result = await authedFetch<{ data?: { linked_traders?: unknown } }>(
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
        const linkedTraders = result.data?.data?.linked_traders
        if (
          result.ok &&
          Array.isArray(linkedTraders) &&
          linkedTraders.every((trader) => isLinkedTraderForViewer(trader, scope.userId))
        ) {
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
        setTraders((prev) => {
          const remaining = prev.filter((candidate) => candidate.id !== ownedTrader.id)
          // The database chooses the replacement under lock. Reflect that exact row;
          // local array order is not a concurrency-safe primary selection rule.
          if (ownedTrader.is_primary && remaining.length > 0) {
            return remaining.map((candidate) => ({
              ...candidate,
              is_primary: candidate.id === promotedLinkId,
            }))
          }
          return remaining
        })
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

  // Aggregated stats
  const totalPnl = visibleTraders.reduce((sum, trader) => sum + (trader.stats?.pnl ?? 0), 0)
  const bestRoi = Math.max(...visibleTraders.map((trader) => trader.stats?.roi ?? -Infinity))
  const avgScore =
    visibleTraders.filter((trader) => trader.stats?.arena_score != null).length > 0
      ? visibleTraders.reduce((sum, trader) => sum + (trader.stats?.arena_score ?? 0), 0) /
        visibleTraders.filter((trader) => trader.stats?.arena_score != null).length
      : null

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[4] }}>
      {/* Aggregated stats bar */}
      {visibleTraders.length > 1 && (
        <Box
          style={{
            display: 'flex',
            gap: tokens.spacing[4],
            padding: tokens.spacing[3],
            borderRadius: tokens.radius.lg,
            background: `${alpha(tokens.colors.accent.primary, 3)}`,
            border: `1px solid ${alpha(tokens.colors.accent.primary, 8)}`,
            flexWrap: 'wrap',
          }}
        >
          <Box style={{ flex: 1, minWidth: 80 }}>
            <Text size="xs" color="tertiary">
              {t('combinedPnl')}
            </Text>
            <Text
              size="sm"
              weight="bold"
              style={{
                color: totalPnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
              }}
            >
              {formatPnl(totalPnl)}
            </Text>
          </Box>
          <Box style={{ flex: 1, minWidth: 80 }}>
            <Text size="xs" color="tertiary">
              {t('bestRoi')}
            </Text>
            <Text
              size="sm"
              weight="bold"
              style={{
                color: bestRoi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error,
              }}
            >
              {bestRoi > -Infinity ? formatRoi(bestRoi) : '-'}
            </Text>
          </Box>
          {avgScore != null && (
            <Box style={{ flex: 1, minWidth: 80 }}>
              <Text size="xs" color="tertiary">
                {t('weightedScore')}
              </Text>
              <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.primary }}>
                {avgScore.toFixed(1)}
              </Text>
            </Box>
          )}
        </Box>
      )}

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
                    {trader.label || trader.stats?.handle || trader.trader_id.slice(0, 12)}
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
                  {t('verifiedOn')} {formatDate(trader.verified_at)}
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
                  variant="primary"
                  size="sm"
                  onClick={() => handleUpdateLabel(trader.id)}
                  disabled={visibleUpdatingId === trader.id}
                  style={{ minHeight: 36 }}
                >
                  {visibleUpdatingId === trader.id ? '...' : t('save')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
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

            {/* Stats row */}
            {trader.stats && (
              <Box
                style={{
                  display: 'flex',
                  gap: tokens.spacing[4],
                  marginBottom: tokens.spacing[3],
                  padding: tokens.spacing[2],
                  borderRadius: tokens.radius.md,
                  background: tokens.colors.bg.secondary,
                  flexWrap: 'wrap',
                }}
              >
                {trader.stats.roi != null && (
                  <Box style={{ minWidth: 60 }}>
                    <Text size="xs" color="tertiary">
                      ROI
                    </Text>
                    <Text
                      size="sm"
                      weight="bold"
                      style={{
                        color:
                          trader.stats.roi >= 0
                            ? tokens.colors.accent.success
                            : tokens.colors.accent.error,
                      }}
                    >
                      {formatRoi(trader.stats.roi)}
                    </Text>
                  </Box>
                )}
                {trader.stats.pnl != null && (
                  <Box style={{ minWidth: 60 }}>
                    <Text size="xs" color="tertiary">
                      PnL
                    </Text>
                    <Text
                      size="sm"
                      weight="bold"
                      style={{
                        color:
                          trader.stats.pnl >= 0
                            ? tokens.colors.accent.success
                            : tokens.colors.accent.error,
                      }}
                    >
                      {formatPnl(trader.stats.pnl)}
                    </Text>
                  </Box>
                )}
                {trader.stats.arena_score != null && (
                  <Box style={{ minWidth: 60 }}>
                    <Text size="xs" color="tertiary">
                      Score
                    </Text>
                    <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.primary }}>
                      {trader.stats.arena_score.toFixed(1)}
                    </Text>
                  </Box>
                )}
                {trader.stats.rank != null && (
                  <Box style={{ minWidth: 40 }}>
                    <Text size="xs" color="tertiary">
                      Rank
                    </Text>
                    <Text size="sm" weight="bold">
                      #{trader.stats.rank}
                    </Text>
                  </Box>
                )}
              </Box>
            )}

            {/* Action buttons */}
            <Box
              className="trader-link-actions"
              style={{
                display: 'flex',
                gap: tokens.spacing[2],
                flexWrap: 'wrap',
              }}
            >
              {!trader.is_primary && (
                <button
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
      <Box
        role="button"
        tabIndex={0}
        aria-label={t('linkNewAccount')}
        onClick={handleLinkNewAccount}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleLinkNewAccount()
          }
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: tokens.spacing[2],
          padding: tokens.spacing[3],
          borderRadius: tokens.radius.lg,
          border: `1px dashed ${tokens.colors.border.secondary}`,
          cursor: 'pointer',
          transition: `all ${tokens.transition.base}`,
          minHeight: 44,
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
      </Box>

      {/* Mobile-responsive styles */}
      <style>{`
        @media (max-width: 480px) {
          .trader-link-actions {
            flex-direction: column;
          }
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
