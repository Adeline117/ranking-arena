'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, Suspense, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import nextDynamic from 'next/dynamic'
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
import ErrorMessage from '@/app/components/ui/ErrorMessage'
import {
  buildCompareUrl,
  compareAccountKey,
  isSameCompareAccount,
  parseCompareAccounts,
  parseUnifiedSearchTraderId,
  type CompareAccountRef,
} from '@/lib/compare/identity'
import {
  CompareClientRequestError,
  fetchCompareAccounts,
  fetchFollowingItems,
  type CompareLoadResult,
  type FollowingItem,
  type TraderCompareData,
} from '@/lib/compare/compare-client-contract'
import {
  fetchUnifiedSearch,
  type UnifiedSearchResponse,
} from '@/lib/search/unified-search-client-contract'
import {
  fetchVerifiedSubscription,
  SubscriptionRequestError,
} from '@/lib/premium/subscription-client'
import {
  compareAccountsTarget,
  consumeProfileActionLogin,
  PROFILE_ACTION_QUERY_PARAM,
  queueProfileActionLogin,
} from '@/lib/auth/profile-action-login'

type UnifiedSearchResult = UnifiedSearchResponse['results']['traders'][number]

interface CompareLoadRequest {
  accounts: CompareAccountRef[]
  replaceUrlOnSuccess: boolean
}

interface CompareLoadFailure {
  message: string
  retry: CompareLoadRequest | null
}

function CompareContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { t } = useLanguage()
  const { showToast } = useToast()
  const { accessToken, authChecked, userId } = useAuthSession()
  const { tryUnlock } = useAchievements()
  const redirectingToLoginRef = useRef(false)
  const rejectedResumeRef = useRef(false)
  const compareRetryPendingRef = useRef(false)
  const initGenerationRef = useRef(0)
  const subscriptionRequestRef = useRef<AbortController | null>(null)
  const followedRequestRef = useRef<AbortController | null>(null)
  const compareRequestRef = useRef<{
    controller: AbortController
    requestKey: string
  } | null>(null)
  const compareDataScopeRef = useRef<string | null>(null)
  const followedOwnerRef = useRef<string | null>(null)
  const compareOwnerRef = useRef<string | null>(null)
  const subscriptionOwnerRef = useRef<string | null>(null)

  const [loading, setLoading] = useState(true)
  const [compareFailure, setCompareFailure] = useState<CompareLoadFailure | null>(null)
  const [availabilityWarning, setAvailabilityWarning] = useState<string | null>(null)
  const [traders, setTraders] = useState<TraderCompareData[]>([])
  // Trader search (unified /api/search, traders category) — debounced
  const [searchInput, setSearchInput] = useState('')
  const [searchResults, setSearchResults] = useState<UnifiedSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchDone, setSearchDone] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchRetryKey, setSearchRetryKey] = useState(0)
  const [isPro, setIsPro] = useState(BETA_PRO_FEATURES_FREE)
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null)
  const [followedTraders, setFollowedTraders] = useState<FollowingItem[]>([])
  const [followedLoading, setFollowedLoading] = useState(false)
  const [followedError, setFollowedError] = useState<string | null>(null)
  const searchFailedMessage = t('searchFailed')
  const followedFailedMessage = t('loadFollowingFailed')

  function accountsFromCurrentUrl(): CompareAccountRef[] {
    const parsed = parseCompareAccounts(searchParams.get('ids'), searchParams.get('platforms'))
    return parsed.ok ? parsed.accounts : []
  }

  function redirectExpiredSession(accounts: CompareAccountRef[] = accountsFromCurrentUrl()) {
    if (redirectingToLoginRef.current) return
    redirectingToLoginRef.current = true
    if (accounts.length === 0) {
      router.push(`/login?returnUrl=${encodeURIComponent('/compare')}`)
      return
    }
    router.push(
      queueProfileActionLogin({
        action: 'compare-traders',
        target: compareAccountsTarget(accounts),
        fallbackPath: buildCompareUrl(accounts),
        initiatingUserId: userId,
      })
    )
  }

  // Every private lane is owned by the current token/viewer render. Abort old
  // work before a refreshed token or another account can reuse this component.
  useEffect(() => {
    subscriptionRequestRef.current?.abort()
    followedRequestRef.current?.abort()
    compareRequestRef.current?.controller.abort()
    subscriptionRequestRef.current = null
    followedRequestRef.current = null
    compareRequestRef.current = null
    if (followedOwnerRef.current !== userId) {
      followedOwnerRef.current = null
      setFollowedTraders([])
      setFollowedError(null)
    }
    if (compareOwnerRef.current !== userId) {
      compareOwnerRef.current = null
      compareDataScopeRef.current = null
      setTraders([])
      setAvailabilityWarning(null)
      setCompareFailure(null)
    }
    if (subscriptionOwnerRef.current !== userId) {
      subscriptionOwnerRef.current = null
      setIsPro(BETA_PRO_FEATURES_FREE)
    }
    setSubscriptionError(null)

    return () => {
      subscriptionRequestRef.current?.abort()
      followedRequestRef.current?.abort()
      compareRequestRef.current?.controller.abort()
    }
  }, [accessToken, userId])

  async function loadSubscription() {
    if (!accessToken || !userId) return
    subscriptionRequestRef.current?.abort()
    const controller = new AbortController()
    subscriptionRequestRef.current = controller
    setSubscriptionError(null)
    try {
      const subscription = await fetchVerifiedSubscription(
        accessToken,
        userId,
        fetch,
        controller.signal
      )
      if (subscriptionRequestRef.current !== controller || controller.signal.aborted) return
      subscriptionOwnerRef.current = userId
      setIsPro(BETA_PRO_FEATURES_FREE || subscription.tier === 'pro')
    } catch (error) {
      if (subscriptionRequestRef.current !== controller || controller.signal.aborted) return
      logger.error('Subscription fetch failed:', error)
      if (error instanceof SubscriptionRequestError && error.status === 401) {
        redirectExpiredSession()
        setSubscriptionError(t('loginExpiredPleaseRelogin'))
      } else {
        setSubscriptionError(t('subscriptionFailed'))
      }
    } finally {
      if (subscriptionRequestRef.current === controller) subscriptionRequestRef.current = null
    }
  }

  // Check auth
  useEffect(() => {
    if (!authChecked || accessToken || redirectingToLoginRef.current) return

    redirectingToLoginRef.current = true
    const parsed = parseCompareAccounts(searchParams.get('ids'), searchParams.get('platforms'))
    if (!parsed.ok) {
      router.push(`/login?returnUrl=${encodeURIComponent('/compare')}`)
      return
    }

    router.push(
      queueProfileActionLogin({
        action: 'compare-traders',
        target: compareAccountsTarget(parsed.accounts),
        fallbackPath: buildCompareUrl(parsed.accounts),
        initiatingUserId: userId,
      })
    )
  }, [authChecked, accessToken, router, searchParams, userId])

  // Init — stop loading once auth check completes (even if not logged in)
  useEffect(() => {
    if (!authChecked) return

    if (!accessToken || !userId) {
      initGenerationRef.current += 1
      setLoading(false)
      return
    }

    const init = async () => {
      const generation = initGenerationRef.current + 1
      initGenerationRef.current = generation
      setLoading(true)
      if (rejectedResumeRef.current) {
        if (initGenerationRef.current === generation) setLoading(false)
        return
      }

      const ids = searchParams.get('ids')
      const platforms = searchParams.get('platforms')
      const parsed = parseCompareAccounts(ids, platforms)
      if (searchParams.get(PROFILE_ACTION_QUERY_PARAM)) {
        const resumedAction = parsed.ok
          ? consumeProfileActionLogin({
              actions: ['compare-traders'],
              target: compareAccountsTarget(parsed.accounts),
              currentUserId: userId,
            })
          : null
        if (resumedAction !== 'compare-traders') {
          rejectedResumeRef.current = true
          router.replace('/compare', { scroll: false })
          if (initGenerationRef.current === generation) setLoading(false)
          return
        }
      }

      // Subscription only gates Pro controls; it must not hold the whole first
      // screen behind a separate entitlement round-trip. Its own error/retry
      // state renders in-page while the core comparison settles independently.
      void loadSubscription()

      let tradersPromise: Promise<void> = Promise.resolve()
      if (ids || platforms) {
        if (parsed.ok) {
          tradersPromise = loadTraders(parsed.accounts).then(() => undefined)
        } else {
          logger.warn('Invalid compare URL identity parameters:', parsed.error)
          setCompareFailure({ message: t('errorOccurred'), retry: null })
        }
      }

      try {
        await tradersPromise
      } catch (err) {
        logger.error('Init failed:', err)
      } finally {
        if (initGenerationRef.current === generation) setLoading(false)
      }
    }

    init()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadTraders is stable; including it would cause refetch loops
  }, [authChecked, accessToken, searchParams, userId])

  // Privy itself is outside these request lanes. Bound only that pre-auth
  // wait; once auth is known, each network lane owns its physical deadline.
  useEffect(() => {
    if (authChecked) return
    const timer = setTimeout(() => {
      setLoading(false)
    }, 3000)
    return () => clearTimeout(timer)
  }, [authChecked])

  const fetchFollowed = useCallback(async () => {
    if (!accessToken || !userId) return

    followedRequestRef.current?.abort()
    const controller = new AbortController()
    followedRequestRef.current = controller
    if (followedOwnerRef.current !== userId) setFollowedTraders([])
    setFollowedLoading(true)
    setFollowedError(null)
    try {
      const items = await fetchFollowingItems(userId, accessToken, controller.signal)
      if (followedRequestRef.current !== controller || controller.signal.aborted) return
      followedOwnerRef.current = userId
      setFollowedTraders(items.filter((item) => item.type === 'trader'))
    } catch (error) {
      if (followedRequestRef.current !== controller || controller.signal.aborted) return
      logger.error('Fetch followed traders failed:', error)
      if (error instanceof CompareClientRequestError && error.status === 401) {
        redirectExpiredSession()
      }
      setFollowedError(followedFailedMessage)
    } finally {
      if (followedRequestRef.current === controller) {
        followedRequestRef.current = null
        setFollowedLoading(false)
      }
    }
    // redirectExpiredSession reads the current URL at call time; adding the
    // function itself would recreate this callback on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, followedFailedMessage, userId])

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
        const data = await fetchUnifiedSearch(
          `/api/search?q=${encodeURIComponent(q)}&limit=8`,
          q,
          controller.signal
        )
        if (!controller.signal.aborted) {
          setSearchResults(data.results.traders)
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
  const loadTraders = async (
    accounts: CompareAccountRef[],
    { replaceUrlOnSuccess = false }: { replaceUrlOnSuccess?: boolean } = {}
  ): Promise<CompareLoadResult | null> => {
    if (!accessToken || !userId || accounts.length === 0) return null

    const retry: CompareLoadRequest = {
      accounts: accounts.map(({ id, source }) => ({ id, source })),
      replaceUrlOnSuccess,
    }

    compareRequestRef.current?.controller.abort()
    const controller = new AbortController()
    const requestKey = `${userId}\u0000${accounts.map(compareAccountKey).join('\u0000')}`
    const request = { controller, requestKey }
    compareRequestRef.current = request
    if (!replaceUrlOnSuccess && compareDataScopeRef.current !== requestKey) {
      setTraders([])
      setAvailabilityWarning(null)
    }

    try {
      const result = await fetchCompareAccounts(accounts, accessToken, controller.signal)
      if (compareRequestRef.current !== request || controller.signal.aborted) return null
      const { traders: list, missingAccounts } = result
      compareOwnerRef.current = userId
      compareDataScopeRef.current = requestKey
      setTraders(list)
      setCompareFailure(null)
      setAvailabilityWarning(missingAccounts.length > 0 ? t('compareSomeUnavailable') : null)
      if (replaceUrlOnSuccess || missingAccounts.length > 0) {
        router.replace(buildCompareUrl(list), { scroll: false })
      }
      if (list.length >= 2) {
        tryUnlock('first_comparison')
      }
      return { traders: list, missingAccounts }
    } catch (error) {
      if (compareRequestRef.current !== request || controller.signal.aborted) return null
      logger.error('Load traders failed:', error)
      if (error instanceof CompareClientRequestError && error.status === 401) {
        redirectExpiredSession(accounts)
        setCompareFailure({ message: t('loginExpiredPleaseRelogin'), retry: null })
      } else if (error instanceof CompareClientRequestError && error.status === 403) {
        setCompareFailure({ message: t('portfolioProRequired'), retry: null })
      } else {
        setCompareFailure({ message: t('errorOccurred'), retry })
      }
      return null
    } finally {
      if (compareRequestRef.current === request) compareRequestRef.current = null
    }
  }

  const handleRetryCompare = async () => {
    const retry = compareFailure?.retry
    if (!retry || compareRetryPendingRef.current) return

    compareRetryPendingRef.current = true
    try {
      await loadTraders(retry.accounts, {
        replaceUrlOnSuccess: retry.replaceUrlOnSuccess,
      })
    } finally {
      compareRetryPendingRef.current = false
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
    const result = await loadTraders(newAccounts, { replaceUrlOnSuccess: true })
    if (!result) return

    if (result.missingAccounts.length > 0) {
      showToast(t('compareSomeUnavailable'), 'warning')
    }
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
      className="compare-page"
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
      }}
    >
      <style>{`
        .compare-page button,
        .compare-page input[type='search'] {
          min-width: 44px !important;
          min-height: 44px !important;
        }
      `}</style>
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
                const rows: Record<string, unknown>[] = traders.map((tr) => ({
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
                else if (format === 'pdf') exportToPDF(rows, filename)
                else exportToCSV(rows, filename)
              }}
            />
          )}
        </Box>

        {/* Pro gate */}
        {subscriptionError && (
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <ErrorMessage
              message={subscriptionError}
              onRetry={() => void loadSubscription()}
              retryButtonSize="md"
            />
          </Box>
        )}

        {!isPro && (
          <Box style={{ marginBottom: tokens.spacing[6] }}>
            <ProGate variant="inline" featureKey="featureTraderCompareDesc" />
          </Box>
        )}

        {/* Retryable load error — never present a failed request as an empty comparison. */}
        {compareFailure && (
          <Box style={{ marginBottom: tokens.spacing[4] }}>
            <ErrorMessage
              message={compareFailure.message}
              onRetry={compareFailure.retry ? () => void handleRetryCompare() : undefined}
              retryButtonSize="md"
            />
          </Box>
        )}

        {/* A successful partial response remains usable, but names omitted accounts honestly. */}
        {availabilityWarning && (
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
              {availabilityWarning}
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
                  display: 'inline-flex',
                  alignItems: 'center',
                  minHeight: tokens.touchTarget.min,
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
                minHeight: tokens.touchTarget.min,
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
                      retryButtonSize="md"
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
                          minHeight: tokens.touchTarget.min,
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
                <ErrorMessage
                  message={followedError}
                  onRetry={() => void fetchFollowed()}
                  retryButtonSize="md"
                />
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
                    <button
                      key={
                        ft.identity_key ||
                        (isUnavailable ? `legacy:${ft.id}` : compareAccountKey(account))
                      }
                      type="button"
                      disabled={isAdded || isUnavailable}
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
                        width: '100%',
                        minHeight: tokens.touchTarget.min,
                        color: tokens.colors.text.primary,
                        font: 'inherit',
                        textAlign: 'left',
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
                          <Text
                            size="xs"
                            style={{
                              color: 'var(--foreground)',
                              fontWeight: tokens.typography.fontWeight.bold,
                            }}
                          >
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
                    </button>
                  )
                })}
              </Box>
            ) : null}
          </Box>
        )}

        {/* Comparison component */}
        {isPro && (!compareFailure || traders.length > 0) && (
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
