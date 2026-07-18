'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, Suspense, useCallback } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import nextDynamic from 'next/dynamic'
import { supabase } from '@/lib/supabase/client'
import { tokens, alpha } from '@/lib/design-tokens'
import LoadingSkeleton from '@/app/components/ui/LoadingSkeleton'
import { Box, Text } from '@/app/components/base'

// Lazy load: TraderComparison includes charts (RadarChart, EquityCurveOverlay) — heavy below-the-fold content
const TraderComparison = nextDynamic(() => import('@/app/components/premium/TraderComparison'), {
  ssr: false,
})
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useToast } from '@/app/components/ui/Toast'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { useAchievements } from '@/lib/hooks/useAchievements'
import ExportButton from '@/app/components/common/ExportButton'
import ProGate from '@/app/components/ui/ProGate'
// MobileBottomNav is rendered by root layout — do not duplicate here
import { logger } from '@/lib/logger'
import { BETA_PRO_FEATURES_FREE } from '@/lib/premium/hooks'
import { avatarSrc } from '@/lib/utils/avatar-proxy'
import type { UnifiedSearchResult } from '@/app/api/search/route'
import ErrorMessage from '@/app/components/ui/ErrorMessage'
import {
  buildCompareApiUrl,
  buildCompareUrl,
  compareAccountKey,
  isSameCompareAccount,
  parseCompareAccounts,
  parseUnifiedSearchTraderId,
  type CompareAccountRef,
} from '@/lib/compare/identity'

interface TraderCompareData extends CompareAccountRef {
  handle: string | null
  roi: number
  roi_7d?: number
  roi_30d?: number
  pnl?: number
  max_drawdown?: number
  win_rate?: number
  trades_count?: number
  arena_score?: number
  return_score?: number
  drawdown_score?: number
  stability_score?: number
  avatar_url?: string
  followers?: number
  equity_curve?: Array<{ date: string; roi: number }>
}

function CompareContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t } = useLanguage()
  const { showToast } = useToast()
  const { accessToken, authChecked, email } = useAuthSession()
  const { tryUnlock } = useAchievements()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [traders, setTraders] = useState<TraderCompareData[]>([])
  // Trader search (unified /api/search, traders category) — debounced
  const [searchInput, setSearchInput] = useState('')
  const [searchResults, setSearchResults] = useState<UnifiedSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchDone, setSearchDone] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchRetryKey, setSearchRetryKey] = useState(0)
  const [isPro, setIsPro] = useState(BETA_PRO_FEATURES_FREE)
  const [followedTraders, setFollowedTraders] = useState<
    Array<{
      id: string
      handle: string
      type: string
      avatar_url?: string
      roi?: number
      source?: string | null
      platform?: string
      identity_key?: string
      arena_score?: number
    }>
  >([])
  const [followedLoading, setFollowedLoading] = useState(false)
  const [followedError, setFollowedError] = useState<string | null>(null)
  const searchFailedMessage = t('searchFailed')
  const followedFailedMessage = t('loadFollowingFailed')

  // Check auth
  useEffect(() => {
    if (authChecked && !accessToken) {
      router.push('/login?redirect=/compare')
    }
  }, [authChecked, accessToken, router])

  // Init — stop loading once auth check completes (even if not logged in)
  useEffect(() => {
    if (!authChecked) return

    if (!accessToken) {
      setLoading(false)
      return
    }

    const init = async () => {
      // The subscription fetch only gates Pro UI; it has NO bearing on which
      // traders to load (ids come from the URL). Running it before loadTraders
      // serialized two independent round-trips and blocked the comparison data —
      // the page's primary content — behind the subscription call. Run both
      // concurrently so the comparison renders as soon as its own data is ready.
      const subPromise = fetch('/api/subscription', {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
        .then(async (subRes) => {
          if (subRes.ok) {
            const subData = await subRes.json()
            const tier = subData.subscription?.tier || 'free'
            setIsPro(BETA_PRO_FEATURES_FREE || tier === 'pro')
          }
        })
        .catch((err) => logger.error('Subscription fetch failed:', err))

      const ids = searchParams.get('ids')
      const platforms = searchParams.get('platforms')
      let tradersPromise: Promise<void> = Promise.resolve()
      if (ids || platforms) {
        const parsed = parseCompareAccounts(ids, platforms)
        if (parsed.ok) {
          tradersPromise = loadTraders(parsed.accounts)
        } else {
          logger.warn('Invalid compare URL identity parameters:', parsed.error)
          setError(t('errorOccurred'))
        }
      }

      try {
        await Promise.all([subPromise, tradersPromise])
      } catch (err) {
        logger.error('Init failed:', err)
      } finally {
        setLoading(false)
      }
    }

    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadTraders is stable; including it would cause refetch loops
  }, [authChecked, accessToken, searchParams])

  // Fallback: if Privy SDK hasn't loaded after 3s, stop loading anyway
  useEffect(() => {
    const timer = setTimeout(() => {
      if (loading) setLoading(false)
    }, 3000)
    return () => clearTimeout(timer)
  }, [loading])

  const fetchFollowed = useCallback(async () => {
    if (!accessToken) return

    setFollowedLoading(true)
    setFollowedError(null)
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) throw new Error('Authenticated user is unavailable')

      const res = await fetch(`/api/following?userId=${user.id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) throw new Error(`Following request failed: ${res.status}`)

      const data = await res.json()
      const traders = (data.items || []).filter((item: { type: string }) => item.type === 'trader')
      setFollowedTraders(traders)
    } catch (err) {
      logger.error('Fetch followed traders failed:', err)
      setFollowedError(followedFailedMessage)
    } finally {
      setFollowedLoading(false)
    }
  }, [accessToken, followedFailedMessage])

  // Fetch followed traders
  useEffect(() => {
    void fetchFollowed()
  }, [fetchFollowed])

  // Debounced trader search via the unified search API (same backend as site-wide search)
  useEffect(() => {
    const q = searchInput.trim()
    if (q.length < 2) {
      setSearchResults([])
      setSearching(false)
      setSearchDone(false)
      setSearchError(null)
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setSearching(true)
      setSearchError(null)
      setSearchResults([])
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=8`, {
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`Search failed: ${res.status}`)
        const json = await res.json()
        const data = (json.data || json) as { results?: { traders?: UnifiedSearchResult[] } }
        if (!controller.signal.aborted) {
          setSearchResults(data.results?.traders ?? [])
          setSearchDone(true)
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          logger.error('Compare trader search failed:', err)
          setSearchError(searchFailedMessage)
          setSearchDone(true)
        }
      } finally {
        if (!controller.signal.aborted) setSearching(false)
      }
    }, 300)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [searchFailedMessage, searchInput, searchRetryKey])

  // Load traders with equity curve data
  const loadTraders = async (accounts: CompareAccountRef[]) => {
    if (!accessToken || accounts.length === 0) return

    try {
      const res = await fetch(buildCompareApiUrl(accounts, { includeEquity: true }), {
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      if (!res.ok) {
        const data = await res.json()
        if (res.status === 403) {
          setError(t('portfolioProRequired'))
        } else {
          setError(
            (typeof data.error === 'string' ? data.error : data.error?.message) ||
              t('errorOccurred')
          )
        }
        return
      }

      // /api/compare 用 success() 包装 → { success, data: { traders }, meta }。
      // 此前读 data.traders(undefined)导致对比页对所有人 100% 空渲染(2026-07-04 修)。
      const json = await res.json()
      const list = (json.data?.traders ?? json.traders ?? []) as TraderCompareData[]
      setTraders(list)
      setError(null)
      if (list.length >= 2) {
        tryUnlock('first_comparison')
      }
    } catch (err) {
      logger.error('Load traders failed:', err)
      setError(t('errorOccurred'))
    }
  }

  // Add trader
  const handleAddTrader = async (account: CompareAccountRef) => {
    if (traders.length >= 10) {
      showToast(t('compareMax10'), 'warning')
      return
    }
    if (traders.some((trader) => isSameCompareAccount(trader, account))) {
      showToast(t('compareAlreadyAdded'), 'warning')
      return
    }

    const newAccounts = [...traders.map(({ id, source }) => ({ id, source })), account]
    await loadTraders(newAccounts)
    router.replace(buildCompareUrl(newAccounts), { scroll: false })
  }

  // Add trader picked from a search result. Search result ids are
  // `platform:traderKey`; retain both parts for exact account resolution.
  const handleAddFromSearch = async (result: UnifiedSearchResult) => {
    const account = parseUnifiedSearchTraderId(result.id)
    if (!account) {
      showToast(t('errorOccurred'), 'error')
      return
    }
    await handleAddTrader(account)
    setSearchInput('')
    setSearchResults([])
    setSearchDone(false)
  }

  // Remove trader
  const handleRemoveTrader = (account: CompareAccountRef) => {
    const newTraders = traders.filter((trader) => !isSameCompareAccount(trader, account))
    setTraders(newTraders)
    if (newTraders.length > 0) {
      router.replace(buildCompareUrl(newTraders), { scroll: false })
    } else {
      router.replace('/compare', { scroll: false })
    }
  }

  if (loading) {
    return (
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <LoadingSkeleton variant="detail" count={2} />
        </Box>
      </Box>
    )
  }

  return (
    <Box
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <Box
        style={{
          position: 'fixed',
          inset: 0,
          background: `radial-gradient(ellipse at 20% 20%, ${alpha(tokens.colors.accent.primary, 3)} 0%, transparent 50%),
                       radial-gradient(ellipse at 80% 80%, ${alpha(tokens.colors.accent.brand, 2)} 0%, transparent 50%)`,
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      <Box
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: tokens.spacing[6],
          paddingBottom: 100,
          position: 'relative',
          zIndex: 1,
        }}
      >
        {/* Title */}
        <Box
          style={{
            marginBottom: tokens.spacing[6],
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
          }}
        >
          <Box>
            <Text as="h1" size="2xl" weight="black" className="gradient-text">
              {t('compareTraders')}
            </Text>
            <Text size="sm" color="tertiary" style={{ marginTop: tokens.spacing[2] }}>
              {t('compareDesc')}
            </Text>
          </Box>
          {traders.length > 0 && isPro && (
            <ExportButton
              onExport={async (format) => {
                const { exportToCSV, exportToJSON, exportToPDF } =
                  await import('@/lib/utils/export')
                const rows = traders.map((tr) => ({
                  handle: tr.handle || tr.id,
                  source: tr.source,
                  roi: tr.roi,
                  roi_7d: tr.roi_7d ?? '',
                  roi_30d: tr.roi_30d ?? '',
                  pnl: tr.pnl ?? '',
                  win_rate: tr.win_rate ?? '',
                  max_drawdown: tr.max_drawdown ?? '',
                  arena_score: tr.arena_score ?? '',
                  trades_count: tr.trades_count ?? '',
                }))
                const filename = `compare-${traders.map((tr) => tr.handle || tr.id).join('-')}`
                if (format === 'json') exportToJSON(rows, filename)
                else if (format === 'pdf')
                  exportToPDF(rows as unknown as Record<string, unknown>[], filename)
                else exportToCSV(rows as unknown as Record<string, unknown>[], filename)
              }}
            />
          )}
        </Box>

        {/* Pro gate */}
        {!isPro && (
          <Box style={{ marginBottom: tokens.spacing[6] }}>
            <ProGate variant="inline" featureKey="featureTraderCompareDesc" />
          </Box>
        )}

        {/* Error */}
        {error && (
          <Box
            style={{
              padding: tokens.spacing[4],
              background: `${alpha(tokens.colors.accent.error, 8)}`,
              borderRadius: tokens.radius.lg,
              border: `1px solid ${alpha(tokens.colors.accent.error, 19)}`,
              marginBottom: tokens.spacing[4],
            }}
          >
            <Text size="sm" style={{ color: tokens.colors.accent.error }}>
              {error}
            </Text>
          </Box>
        )}

        {/* Trader search — add any trader to the comparison */}
        {isPro && (
          <Box
            style={{
              marginBottom: tokens.spacing[4],
              padding: tokens.spacing[4],
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.xl,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Box
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                gap: tokens.spacing[2],
                marginBottom: tokens.spacing[3],
              }}
            >
              <Text size="sm" weight="bold">
                {t('compareAddTrader')} ({traders.length}/10)
              </Text>
              <Link
                href="/rankings"
                style={{
                  fontSize: tokens.typography.fontSize.xs,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  color: tokens.colors.accent.primary,
                  textDecoration: 'none',
                }}
              >
                {t('compareAddFromRankings')} →
              </Link>
            </Box>

            <input
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t('compareSearchPlaceholder')}
              aria-label={t('compareSearchPlaceholder')}
              style={{
                width: '100%',
                padding: tokens.spacing[3],
                borderRadius: tokens.radius.md,
                border: `1px solid ${tokens.colors.border.primary}`,
                background: tokens.colors.bg.primary,
                color: tokens.colors.text.primary,
                fontSize: tokens.typography.fontSize.sm,
                outline: 'none',
                transition: 'border-color 0.2s, box-shadow 0.2s',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = tokens.colors.accent.primary
                e.currentTarget.style.boxShadow = `0 0 0 2px ${alpha(tokens.colors.accent.primary, 25)}`
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = tokens.colors.border.primary
                e.currentTarget.style.boxShadow = 'none'
              }}
            />

            {(searching || searchDone || searchError) && searchInput.trim().length >= 2 && (
              <Box
                style={{
                  marginTop: tokens.spacing[3],
                  maxHeight: 320,
                  overflowY: 'auto',
                  background: tokens.colors.bg.primary,
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                }}
              >
                {searching ? (
                  <Text
                    as="span"
                    size="sm"
                    color="tertiary"
                    style={{ display: 'block', padding: tokens.spacing[3] }}
                  >
                    {t('compareSearching')}
                  </Text>
                ) : searchError ? (
                  <Box style={{ padding: tokens.spacing[3] }}>
                    <ErrorMessage
                      message={searchError}
                      onRetry={() => setSearchRetryKey((value) => value + 1)}
                    />
                  </Box>
                ) : searchResults.length === 0 ? (
                  <Text
                    as="span"
                    size="sm"
                    color="tertiary"
                    style={{ display: 'block', padding: tokens.spacing[3] }}
                  >
                    {t('compareSearchNoResults')}
                  </Text>
                ) : (
                  searchResults.map((result, idx) => {
                    const account = parseUnifiedSearchTraderId(result.id)
                    const isUnavailable = account === null
                    const isAdded =
                      account !== null &&
                      traders.some((trader) => isSameCompareAccount(trader, account))
                    return (
                      <button
                        key={result.id}
                        type="button"
                        disabled={isAdded || isUnavailable}
                        onClick={() => handleAddFromSearch(result)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: tokens.spacing[2],
                          width: '100%',
                          padding: tokens.spacing[3],
                          background: 'transparent',
                          border: 'none',
                          borderBottom:
                            idx < searchResults.length - 1
                              ? `1px solid ${tokens.colors.border.primary}`
                              : 'none',
                          cursor: isAdded || isUnavailable ? 'not-allowed' : 'pointer',
                          opacity: isAdded || isUnavailable ? 0.45 : 1,
                          textAlign: 'left',
                          color: tokens.colors.text.primary,
                        }}
                      >
                        {result.avatar ? (
                          <img
                            src={avatarSrc(result.avatar)}
                            alt=""
                            width={28}
                            height={28}
                            loading="lazy"
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: tokens.radius.full,
                              objectFit: 'cover',
                              flexShrink: 0,
                            }}
                            onError={(e) => {
                              ;(e.target as HTMLImageElement).style.display = 'none'
                            }}
                          />
                        ) : (
                          <Box
                            style={{
                              width: 28,
                              height: 28,
                              borderRadius: tokens.radius.full,
                              background: tokens.colors.bg.tertiary,
                              flexShrink: 0,
                            }}
                          />
                        )}
                        <Box style={{ minWidth: 0, flex: 1 }}>
                          <Text
                            as="span"
                            size="sm"
                            weight="semibold"
                            style={{
                              display: 'block',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {result.title}
                          </Text>
                          {result.subtitle && (
                            <Text
                              as="span"
                              size="xs"
                              color="tertiary"
                              style={{
                                display: 'block',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {result.subtitle}
                            </Text>
                          )}
                        </Box>
                        {isAdded && (
                          <Text as="span" size="xs" color="tertiary" style={{ flexShrink: 0 }}>
                            {t('compareAdded')}
                          </Text>
                        )}
                      </button>
                    )
                  })
                )}
              </Box>
            )}
          </Box>
        )}

        {/* Followed traders */}
        {isPro && (
          <Box
            style={{
              marginBottom: tokens.spacing[4],
              padding: tokens.spacing[4],
              background: tokens.colors.bg.secondary,
              borderRadius: tokens.radius.xl,
              border: `1px solid ${tokens.colors.border.primary}`,
            }}
          >
            <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[3] }}>
              {t('compareFromFollowing')}
            </Text>

            {followedError && !followedLoading && (
              <Box style={{ marginBottom: tokens.spacing[3] }}>
                <ErrorMessage message={followedError} onRetry={() => void fetchFollowed()} />
              </Box>
            )}

            {!accessToken ? (
              <Text size="sm" color="tertiary">
                {t('compareLoginToSelect')}
              </Text>
            ) : followedLoading && followedTraders.length === 0 ? (
              <Text size="sm" color="tertiary">
                {t('loading')}
              </Text>
            ) : followedTraders.length === 0 && !followedError ? (
              <Text size="sm" color="tertiary">
                {t('compareNoFollowed')}
              </Text>
            ) : followedTraders.length > 0 ? (
              <Box
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                  gap: tokens.spacing[2],
                }}
              >
                {followedTraders.map((ft) => {
                  const followedSource = ft.platform || ft.source || ''
                  const account = { id: ft.id, source: followedSource }
                  const isUnavailable = !followedSource
                  const isAdded =
                    !isUnavailable &&
                    traders.some((trader) => isSameCompareAccount(trader, account))
                  return (
                    <Box
                      key={
                        ft.identity_key ||
                        (isUnavailable ? `legacy:${ft.id}` : compareAccountKey(account))
                      }
                      onClick={() => !isAdded && !isUnavailable && handleAddTrader(account)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: tokens.spacing[2],
                        padding: tokens.spacing[3],
                        borderRadius: tokens.radius.lg,
                        border: `1px solid ${tokens.colors.border.primary}`,
                        background: isAdded
                          ? `${tokens.colors.bg.tertiary}`
                          : tokens.colors.bg.primary,
                        cursor: isAdded || isUnavailable ? 'not-allowed' : 'pointer',
                        opacity: isAdded || isUnavailable ? 0.45 : 1,
                        transition: 'all 0.2s',
                      }}
                      onMouseEnter={(e) => {
                        if (!isAdded && !isUnavailable)
                          e.currentTarget.style.borderColor = tokens.colors.accent.primary
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = tokens.colors.border.primary
                      }}
                    >
                      {ft.avatar_url ? (
                        <img
                          src={avatarSrc(ft.avatar_url)}
                          alt={ft.handle || 'Trader avatar'}
                          width={32}
                          height={32}
                          loading="lazy"
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: tokens.radius.full,
                            objectFit: 'cover',
                            flexShrink: 0,
                          }}
                          onError={(e) => {
                            ;(e.target as HTMLImageElement).style.display = 'none'
                          }}
                        />
                      ) : (
                        <Box
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: tokens.radius.full,
                            background: `linear-gradient(135deg, hsl(${Math.abs(ft.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % 360}, 75%, 45%), hsl(${
                              Math.abs(
                                ft.id
                                  .split('')
                                  .reverse()
                                  .reduce((a, c) => a + c.charCodeAt(0), 0)
                              ) % 360
                            }, 75%, 55%))`,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                          }}
                        >
                          <Text size="xs" style={{ color: 'var(--foreground)', fontWeight: 700 }}>
                            {(ft.handle || '?')[0].toUpperCase()}
                          </Text>
                        </Box>
                      )}
                      <Box style={{ minWidth: 0, flex: 1 }}>
                        <Text
                          size="xs"
                          weight="semibold"
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {ft.handle || ft.id.slice(0, 8)}
                        </Text>
                        <Box
                          style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1] }}
                        >
                          <Text size="xs" color="tertiary">
                            {followedSource}
                          </Text>
                          <Text
                            size="xs"
                            weight="bold"
                            style={{
                              color:
                                (ft.roi ?? 0) >= 0
                                  ? tokens.colors.accent.success
                                  : tokens.colors.accent.error,
                            }}
                          >
                            {(ft.roi ?? 0) >= 0 ? '+' : ''}
                            {(ft.roi ?? 0).toFixed(1)}%
                          </Text>
                        </Box>
                      </Box>
                      {isAdded && (
                        <Text size="xs" color="tertiary" style={{ flexShrink: 0 }}>
                          {t('compareAdded')}
                        </Text>
                      )}
                    </Box>
                  )
                })}
              </Box>
            ) : null}
          </Box>
        )}

        {/* Comparison component */}
        {isPro && (
          <TraderComparison
            traders={traders}
            onRemove={handleRemoveTrader}
            showRemoveButton={true}
          />
        )}
      </Box>
      {/* MobileBottomNav rendered in root layout */}
    </Box>
  )
}

export default function ComparePageClient() {
  const { t } = useLanguage()
  return (
    <Suspense
      fallback={
        <Box
          style={{
            minHeight: '100vh',
            background: tokens.colors.bg.primary,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: 'var(--color-text-secondary)' }}>{t('loading')}</Text>
        </Box>
      }
    >
      <CompareContent />
    </Suspense>
  )
}
