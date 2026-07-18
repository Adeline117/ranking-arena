'use client'

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { tokens, alpha } from '@/lib/design-tokens'
import { avatarSrc } from '@/lib/utils/avatar-proxy'
import {
  getAvatarGradient,
  getAvatarInitial,
  isWalletAddress,
  generateBlockieSvg,
} from '@/lib/utils/avatar'
import { NULL_DISPLAY } from '@/lib/utils/format'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { getScoreColorInfo } from '@/lib/utils/score-colors'
import { Box, Text } from '@/app/components/base'
import ExchangeLogo from '@/app/components/ui/ExchangeLogo'
import EmptyState from '@/app/components/ui/EmptyState'
import Metric from '@/app/components/ui/Metric'
import ScoreMiniBar from '@/app/components/ranking/ScoreMiniBar'
import Breadcrumb from '@/app/components/ui/Breadcrumb'
import ProvenanceFooter from '@/app/components/common/ProvenanceFooter'
import { Skeleton } from '@/app/components/ui/Skeleton'
import ErrorState from '@/app/components/ui/ErrorState'

export type Period = '7D' | '30D' | '90D'

export interface TokenTrader {
  source: string
  source_trader_id: string
  handle: string | null
  avatar_url: string | null
  arena_score: number | null
  roi: number | null
  total_pnl: number
  token_pnl: number
  token_trade_count: number
  token_win_rate: number | null
  token_avg_pnl_pct: number | null
}

const PAGE_SIZE = 50
const CLIENT_REQUEST_TIMEOUT_MS = 15_000
const EMPTY_TRADERS: TokenTrader[] = []

interface RankingPageData {
  traders: TokenTrader[]
  total: number
}

type RequestState = {
  key: string
  status: 'loading' | 'idle' | 'error'
}

function rankingPageKey(token: string, period: Period, page: number): string {
  return `${token}:${period}:${page}`
}

// Frozen rank + name (sticky-left) then six numeric columns. gap:0 so the
// sticky offsets are exact px (a grid `gap` would shift the trader column's
// left edge and break the freeze). Trader column is the flex one (minmax 1fr)
// so it absorbs spare width on wide screens and clamps → horizontal scroll on
// narrow ones.
const GRID_TEMPLATE = '56px minmax(190px, 1fr) 116px 116px 88px 100px 104px 104px'
const GRID_MIN_WIDTH = 874

type SortKey =
  | 'token_pnl'
  | 'total_pnl'
  | 'token_trade_count'
  | 'token_win_rate'
  | 'roi'
  | 'arena_score'

function getDisplayName(trader: TokenTrader): string {
  if (trader.handle) return trader.handle
  const id = trader.source_trader_id
  return id.length > 10 ? `${id.slice(0, 4)}...${id.slice(-4)}` : id
}

function TraderAvatar({
  avatarUrl,
  traderKey,
  name,
  size = 32,
}: {
  avatarUrl: string | null
  traderKey: string
  name: string
  size?: number
}) {
  const [error, setError] = useState(false)
  if (!avatarUrl || error) {
    if (isWalletAddress(traderKey)) {
      return (
        <img
          src={generateBlockieSvg(traderKey, size)}
          alt={name || 'Wallet avatar'}
          width={size}
          height={size}
          style={{ width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated' }}
        />
      )
    }
    return (
      <span style={{ color: tokens.colors.white, fontSize: size * 0.375, fontWeight: 700 }}>
        {getAvatarInitial(name)}
      </span>
    )
  }
  return (
    <img
      src={avatarSrc(avatarUrl)}
      alt={name || 'Trader avatar'}
      width={size}
      height={size}
      loading="lazy"
      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
      onError={() => setError(true)}
    />
  )
}

/* eslint-disable no-restricted-syntax -- official token BRAND colors (external identities like BTC orange; not themeable design tokens) */
const TOKEN_COLORS: Record<string, string> = {
  BTC: '#F7931A',
  ETH: '#627EEA',
  SOL: '#9945FF',
  BNB: '#F3BA2F',
  XRP: '#23292F',
  DOGE: '#C2A633',
  ADA: '#0033AD',
  AVAX: '#E84142',
  DOT: '#E6007A',
  MATIC: '#8247E5',
  LINK: '#2A5ADA',
  UNI: '#FF007A',
  ARB: '#12AAFF',
  OP: '#FF0420',
}
/* eslint-enable no-restricted-syntax */

function PeriodSelector({
  period,
  onChange,
  loading,
}: {
  period: Period
  onChange: (p: Period) => void
  loading: boolean
}) {
  const { t } = useLanguage()
  const periods: Period[] = ['7D', '30D', '90D']
  const labels: Record<Period, string> = {
    '7D': t('days7'),
    '30D': t('days30'),
    '90D': t('days90'),
  }
  return (
    <div
      style={{
        display: 'inline-flex',
        gap: 0,
        padding: 2,
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: '1px solid var(--glass-border-light)',
      }}
    >
      {periods.map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          disabled={loading}
          style={{
            padding: '6px 14px',
            minHeight: 36,
            borderRadius: tokens.radius.md,
            border: 'none',
            fontSize: 13,
            fontWeight: period === p ? 700 : 500,
            background: period === p ? alpha(tokens.colors.accent.brand, 13) : 'transparent',
            color: period === p ? tokens.colors.accent.brand : tokens.colors.text.tertiary,
            cursor: loading ? 'wait' : 'pointer',
            opacity: loading ? 0.6 : 1,
            transition: 'all 0.15s',
          }}
        >
          {labels[p]}
        </button>
      ))}
    </div>
  )
}

/** Small ▲/▼ glyph mirroring RankingTable's SortIndicator. Decorative — the
 *  authoritative cue is aria-sort on the header button. */
function SortGlyph({ active, dir }: { active: boolean; dir: 'asc' | 'desc' }) {
  return (
    <span
      aria-hidden="true"
      style={{
        fontSize: 9,
        marginLeft: 3,
        opacity: active ? 1 : 0.3,
        color: active ? tokens.colors.accent.brand : tokens.colors.text.tertiary,
      }}
    >
      {active ? (dir === 'asc' ? '▲' : '▼') : '▾'}
    </span>
  )
}

function SortHeader({
  label,
  colKey,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string
  colKey: SortKey
  sortKey: SortKey
  sortDir: 'asc' | 'desc'
  onSort: (k: SortKey) => void
}) {
  const active = sortKey === colKey
  return (
    <button
      type="button"
      role="columnheader"
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      aria-label={`${label} — sort`}
      onClick={() => onSort(colKey)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 0,
        padding: '0 12px',
        height: '100%',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        fontSize: 12,
        fontWeight: active ? 700 : 600,
        color: active ? tokens.colors.text.primary : tokens.colors.text.secondary,
        textAlign: 'right',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
      <SortGlyph active={active} dir={sortDir} />
    </button>
  )
}

export default function TokenRankingClient({
  token,
  initialPeriod,
  initialTraders,
  initialTotal,
  initialStatus = 'success',
  asOf,
}: {
  token: string
  initialPeriod: Period
  initialTraders: TokenTrader[]
  initialTotal: number
  initialStatus?: 'success' | 'error'
  asOf: string
}) {
  const { t } = useLanguage()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const urlPage = Math.max(0, parseInt(searchParams.get('page') || '0', 10) || 0)

  const [period, setPeriod] = useState<Period>(initialPeriod)
  const [page, setPageRaw] = useState(urlPage)
  const [sortKey, setSortKey] = useState<SortKey>('token_pnl')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [pages, setPages] = useState<Map<string, RankingPageData>>(() => {
    const initialPages = new Map<string, RankingPageData>()
    if (initialStatus === 'success') {
      initialPages.set(rankingPageKey(token, initialPeriod, 0), {
        traders: initialTraders,
        total: initialTotal,
      })
    }
    return initialPages
  })
  const pagesRef = useRef(pages)
  const [requestState, setRequestState] = useState<RequestState>(() => ({
    key: rankingPageKey(token, initialPeriod, urlPage),
    status: initialStatus === 'success' && urlPage === 0 ? 'idle' : 'loading',
  }))
  const abortRef = useRef<AbortController | null>(null)

  const tokenColor = TOKEN_COLORS[token] || tokens.colors.accent.primary
  const currentKey = rankingPageKey(token, period, page)
  const currentData = pages.get(currentKey)
  const currentRequest = requestState.key === currentKey ? requestState : null
  const currentError = currentRequest?.status === 'error'
  const loading =
    currentRequest?.status === 'loading' || (!currentData && currentRequest?.status !== 'error')
  const showSkeleton = loading && !currentData
  const traders = currentData?.traders ?? EMPTY_TRADERS
  const total = currentData?.total ?? 0

  const setPage = useCallback(
    (p: number | ((prev: number) => number)) => {
      setPageRaw((prev) => {
        const next = typeof p === 'function' ? p(prev) : p
        const params = new URLSearchParams(searchParams.toString())
        if (next > 0) params.set('page', String(next))
        else params.delete('page')
        router.replace(`${pathname}${params.size ? '?' + params.toString() : ''}`, {
          scroll: false,
        })
        return next
      })
    },
    [searchParams, router, pathname]
  )

  const fetchData = useCallback(
    async (p: Period, pageIndex: number) => {
      if (abortRef.current) abortRef.current.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const key = rankingPageKey(token, p, pageIndex)
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, CLIENT_REQUEST_TIMEOUT_MS)

      setRequestState({ key, status: 'loading' })
      try {
        const res = await fetch(
          `/api/rankings/by-token?token=${encodeURIComponent(token)}&period=${p}&limit=${PAGE_SIZE}&offset=${pageIndex * PAGE_SIZE}`,
          { signal: controller.signal }
        )
        if (!res.ok) throw new Error(`Token rankings request failed: ${res.status}`)
        const data: unknown = await res.json()
        if (
          typeof data !== 'object' ||
          data === null ||
          (data as { token?: unknown }).token !== token ||
          (data as { period?: unknown }).period !== p ||
          !Array.isArray((data as { traders?: unknown }).traders) ||
          typeof (data as { total?: unknown }).total !== 'number'
        ) {
          throw new Error('Token rankings response did not match the requested page')
        }
        if (abortRef.current !== controller || controller.signal.aborted) return

        const nextPages = new Map(pagesRef.current)
        nextPages.set(key, {
          traders: (data as { traders: TokenTrader[] }).traders,
          total: (data as { total: number }).total,
        })
        pagesRef.current = nextPages
        setPages(nextPages)
        setRequestState({ key, status: 'idle' })
      } catch (err) {
        if (abortRef.current !== controller) return
        if (controller.signal.aborted && !timedOut) return
        if (err instanceof Error && err.name === 'AbortError' && !timedOut) return
        setRequestState({ key, status: 'error' })
      } finally {
        clearTimeout(timeout)
      }
    },
    [token]
  )

  useEffect(() => {
    const key = rankingPageKey(token, period, page)
    if (pagesRef.current.has(key)) {
      abortRef.current?.abort()
      abortRef.current = null
      setRequestState({ key, status: 'idle' })
      return
    }
    void fetchData(period, page)
  }, [period, page, fetchData, token])

  useEffect(() => () => abortRef.current?.abort(), [])

  const handlePeriodChange = useCallback(
    (newPeriod: Period) => {
      setPeriod(newPeriod)
      setPageRaw(0)
      const params = new URLSearchParams(searchParams.toString())
      if (newPeriod === '90D') params.delete('period')
      else params.set('period', newPeriod)
      params.delete('page')
      const qs = params.toString()
      router.replace(`${pathname}${qs ? '?' + qs : ''}`, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  const handleSort = useCallback((key: SortKey) => {
    setSortKey((prevKey) => {
      setSortDir((prevDir) => (prevKey === key ? (prevDir === 'desc' ? 'asc' : 'desc') : 'desc'))
      return key
    })
  }, [])

  const totalPages = Math.ceil(total / PAGE_SIZE)

  // Attach the server (token-PnL) rank BEFORE display sorting so medals + the #
  // column always reflect the leaderboard position, not the transient sort.
  const ranked = useMemo(
    () => traders.map((tr, i) => ({ ...tr, _rank: page * PAGE_SIZE + i + 1 })),
    [traders, page]
  )

  const displayed = useMemo(() => {
    const arr = [...ranked]
    arr.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      const an = av == null ? Number.NEGATIVE_INFINITY : (av as number)
      const bn = bv == null ? Number.NEGATIVE_INFINITY : (bv as number)
      return sortDir === 'desc' ? bn - an : an - bn
    })
    return arr
  }, [ranked, sortKey, sortDir])

  const numCols: { key: SortKey; label: string }[] = [
    { key: 'token_pnl', label: `${token} PnL` },
    { key: 'total_pnl', label: t('tokenRankingTotalPnl') },
    { key: 'token_trade_count', label: t('tokenRankingTrades') },
    { key: 'token_win_rate', label: t('rankingWinRate') },
    { key: 'roi', label: 'ROI' },
    { key: 'arena_score', label: t('rankingScore') },
  ]

  const stickyCell: React.CSSProperties = {
    position: 'sticky',
    zIndex: 1,
    background: 'var(--row-bg)',
  }

  return (
    <Box>
      <style>{`
        .token-row { --row-bg: var(--color-bg-secondary); background: var(--row-bg); }
        .token-row:hover { --row-bg: var(--overlay-hover); }
      `}</style>

      {/* Breadcrumb: Home / Token Rankings / {TOKEN} */}
      <Breadcrumb
        items={[{ label: t('tokenRankingsTitle'), href: '/rankings/tokens' }, { label: token }]}
      />

      {/* Header */}
      <Box style={{ marginBottom: 24, marginTop: 4 }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Box
            style={{
              width: 48,
              height: 48,
              borderRadius: '50%',
              background: `${alpha(tokenColor, 13)}`,
              border: `2px solid ${alpha(tokenColor, 25)}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 22,
              fontWeight: 800,
              color: tokenColor,
            }}
          >
            {token.charAt(0)}
          </Box>
          <Box>
            <Text as="h1" size="2xl" weight="bold" style={{ color: tokens.colors.text.primary }}>
              {t('tokenRankingHeader').replace('{token}', token)}
            </Text>
            <Text size="sm" style={{ color: tokens.colors.text.secondary }}>
              {currentError && !currentData
                ? t('failedToLoadRankings')
                : total > 0
                  ? t('tokenRankingCount')
                      .replace('{count}', total.toLocaleString('en-US'))
                      .replace('{token}', token)
                  : t('tokenRankingNoData').replace('{token}', token)}
            </Text>
          </Box>
        </Box>
      </Box>

      {/* Period Selector */}
      <Box style={{ marginBottom: 16 }}>
        <PeriodSelector period={period} onChange={handlePeriodChange} loading={loading} />
      </Box>

      {currentError && (
        <ErrorState
          title={t('failedToLoadRankings')}
          description={t('tryAgain')}
          retry={() => void fetchData(period, page)}
          variant={currentData ? 'compact' : 'default'}
        />
      )}

      {/* Table — chrome (header row) stays mounted across period/page changes so
          only the body swaps (no full layout shift). */}
      {(showSkeleton || displayed.length > 0) && (
        <>
          <Box
            role="table"
            aria-label={t('tokenRankingHeader').replace('{token}', token)}
            style={{
              borderRadius: tokens.radius.lg,
              overflow: 'hidden',
              border: '1px solid var(--glass-border-light)',
            }}
          >
            <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
              <div style={{ minWidth: GRID_MIN_WIDTH }}>
                {/* Header Row */}
                <div
                  role="row"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: GRID_TEMPLATE,
                    height: 44,
                    fontSize: 12,
                    fontWeight: 600,
                    color: tokens.colors.text.secondary,
                    borderBottom: '1px solid var(--glass-border-light)',
                    background: 'var(--color-bg-primary)',
                  }}
                >
                  <div
                    role="columnheader"
                    style={{
                      ...stickyCell,
                      left: 0,
                      background: 'var(--color-bg-primary)',
                      display: 'flex',
                      alignItems: 'center',
                      paddingLeft: 16,
                    }}
                  >
                    #
                  </div>
                  <div
                    role="columnheader"
                    style={{
                      ...stickyCell,
                      left: 56,
                      background: 'var(--color-bg-primary)',
                      display: 'flex',
                      alignItems: 'center',
                      paddingLeft: 4,
                    }}
                  >
                    {t('rankingTrader')}
                  </div>
                  {numCols.map((c) => (
                    <SortHeader
                      key={c.key}
                      label={c.label}
                      colKey={c.key}
                      sortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSort}
                    />
                  ))}
                </div>

                {/* Body: skeleton while loading, else rows */}
                {showSkeleton
                  ? Array.from({ length: 8 }).map((_, i) => (
                      <div
                        key={`sk-${i}`}
                        role="row"
                        style={{
                          display: 'grid',
                          gridTemplateColumns: GRID_TEMPLATE,
                          height: 56,
                          alignItems: 'center',
                          borderBottom: '1px solid var(--overlay-hover)',
                          background: 'var(--color-bg-secondary)',
                        }}
                      >
                        <div style={{ paddingLeft: 16 }}>
                          <Skeleton width={20} height={14} />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <Skeleton width={32} height={32} variant="circular" />
                          <Skeleton width={110} height={14} />
                        </div>
                        {numCols.map((c) => (
                          <div
                            key={c.key}
                            style={{
                              display: 'flex',
                              justifyContent: 'flex-end',
                              paddingRight: 12,
                            }}
                          >
                            <Skeleton width={52} height={14} />
                          </div>
                        ))}
                      </div>
                    ))
                  : displayed.map((trader) => {
                      const rank = trader._rank
                      const name = getDisplayName(trader)
                      const platformName = EXCHANGE_NAMES[trader.source] || trader.source
                      const medal =
                        rank === 1
                          ? {
                              from: 'var(--color-medal-gold)',
                              to: 'var(--color-medal-gold-end)',
                              accent: 'var(--color-medal-gold)',
                            }
                          : rank === 2
                            ? {
                                from: 'var(--color-medal-silver)',
                                to: 'var(--color-medal-silver-end)',
                                accent: 'var(--color-medal-silver)',
                              }
                            : rank === 3
                              ? {
                                  from: 'var(--color-medal-bronze)',
                                  to: 'var(--color-medal-bronze-end)',
                                  accent: 'var(--color-medal-bronze)',
                                }
                              : null
                      const scoreInfo =
                        trader.arena_score != null ? getScoreColorInfo(trader.arena_score) : null

                      return (
                        <Link
                          key={`${trader.source}:${trader.source_trader_id}`}
                          href={`/trader/${encodeURIComponent(trader.handle || trader.source_trader_id)}?platform=${trader.source}`}
                          className="token-row"
                          role="row"
                          style={{
                            display: 'grid',
                            gridTemplateColumns: GRID_TEMPLATE,
                            minHeight: 56,
                            alignItems: 'center',
                            textDecoration: 'none',
                            borderBottom: '1px solid var(--overlay-hover)',
                          }}
                        >
                          {/* Rank (frozen) */}
                          <div
                            role="cell"
                            style={{
                              ...stickyCell,
                              left: 0,
                              display: 'flex',
                              alignItems: 'center',
                              paddingLeft: 16,
                              boxShadow: medal ? `inset 3px 0 0 ${medal.accent}` : undefined,
                            }}
                          >
                            {medal ? (
                              <span
                                style={{
                                  width: 26,
                                  height: 26,
                                  borderRadius: '50%',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  fontSize: 13,
                                  fontWeight: 700,
                                  background: `linear-gradient(135deg, ${medal.from}, ${medal.to})`,
                                  color: 'var(--color-bg-primary)',
                                }}
                              >
                                {rank}
                              </span>
                            ) : (
                              <span
                                style={{
                                  fontSize: 13,
                                  fontWeight: 600,
                                  color: tokens.colors.text.secondary,
                                  minWidth: 26,
                                  textAlign: 'center',
                                  display: 'inline-block',
                                }}
                              >
                                {rank}
                              </span>
                            )}
                          </div>

                          {/* Trader (frozen) */}
                          <div
                            role="cell"
                            style={{
                              ...stickyCell,
                              left: 56,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 10,
                              minWidth: 0,
                              paddingLeft: 4,
                              paddingRight: 8,
                            }}
                          >
                            <div
                              style={{
                                width: 32,
                                height: 32,
                                borderRadius: '50%',
                                flexShrink: 0,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                overflow: 'hidden',
                                background: getAvatarGradient(trader.source_trader_id),
                              }}
                            >
                              <TraderAvatar
                                avatarUrl={trader.avatar_url}
                                traderKey={trader.source_trader_id}
                                name={name}
                                size={32}
                              />
                            </div>
                            <div style={{ minWidth: 0 }}>
                              <div
                                style={{
                                  fontSize: 13,
                                  fontWeight: 600,
                                  color: tokens.colors.text.primary,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {name}
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <ExchangeLogo exchange={trader.source} size={12} />
                                <span style={{ fontSize: 11, color: tokens.colors.text.tertiary }}>
                                  {platformName}
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* Token PnL */}
                          <div
                            role="cell"
                            style={{
                              display: 'flex',
                              justifyContent: 'flex-end',
                              paddingRight: 12,
                            }}
                          >
                            <Metric value={trader.token_pnl} format="pnl" size="sm" showArrow />
                          </div>

                          {/* Total PnL */}
                          <div
                            role="cell"
                            style={{
                              display: 'flex',
                              justifyContent: 'flex-end',
                              paddingRight: 12,
                            }}
                          >
                            <Metric value={trader.total_pnl} format="pnl" size="sm" showArrow />
                          </div>

                          {/* Trade Count (neutral) */}
                          <div
                            role="cell"
                            style={{
                              display: 'flex',
                              justifyContent: 'flex-end',
                              paddingRight: 12,
                            }}
                          >
                            <Metric value={trader.token_trade_count} format="number" size="sm" />
                          </div>

                          {/* Win Rate — sign relative to 50% breakeven so the
                              arrow + color read as a colorblind-safe cue. */}
                          <div
                            role="cell"
                            style={{
                              display: 'flex',
                              justifyContent: 'flex-end',
                              paddingRight: 12,
                            }}
                          >
                            <Metric
                              value={
                                trader.token_win_rate != null ? trader.token_win_rate - 50 : null
                              }
                              display={
                                trader.token_win_rate != null
                                  ? `${trader.token_win_rate.toFixed(1)}%`
                                  : undefined
                              }
                              format="percent"
                              size="sm"
                              showArrow
                            />
                          </div>

                          {/* ROI */}
                          <div
                            role="cell"
                            style={{
                              display: 'flex',
                              justifyContent: 'flex-end',
                              paddingRight: 12,
                            }}
                          >
                            <Metric value={trader.roi} format="roi" size="sm" showArrow />
                          </div>

                          {/* Arena Score → graded chip + mini-bar (tokens) */}
                          <div
                            role="cell"
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'flex-end',
                              gap: 3,
                              paddingRight: 16,
                            }}
                          >
                            {trader.arena_score != null && scoreInfo ? (
                              <>
                                <span
                                  style={{
                                    fontSize: 13,
                                    fontWeight: 800,
                                    color: scoreInfo.color,
                                    fontVariantNumeric: 'tabular-nums',
                                  }}
                                >
                                  {trader.arena_score.toFixed(0)}
                                </span>
                                <ScoreMiniBar score={trader.arena_score} width={52} height={4} />
                              </>
                            ) : (
                              <span style={{ fontSize: 13, color: tokens.colors.text.tertiary }}>
                                {NULL_DISPLAY}
                              </span>
                            )}
                          </div>
                        </Link>
                      )
                    })}
              </div>
            </div>
          </Box>

          {/* Provenance footer (spec §6) */}
          <ProvenanceFooter provenance={{ source: 'arena', asOf }} exchangeName="Arena" />

          {/* Pagination */}
          {totalPages > 1 && (
            <Box style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: '20px 0' }}>
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0 || loading}
                style={{
                  padding: '8px 16px',
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.secondary,
                  color: page === 0 ? tokens.colors.text.tertiary : tokens.colors.text.primary,
                  cursor: page === 0 ? 'not-allowed' : 'pointer',
                  fontSize: 13,
                }}
              >
                {t('tokenRankingPrev')}
              </button>
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  fontSize: 13,
                  color: tokens.colors.text.secondary,
                }}
              >
                {page + 1} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1 || loading}
                style={{
                  padding: '8px 16px',
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.secondary,
                  color:
                    page >= totalPages - 1
                      ? tokens.colors.text.tertiary
                      : tokens.colors.text.primary,
                  cursor: page >= totalPages - 1 ? 'not-allowed' : 'pointer',
                  fontSize: 13,
                }}
              >
                {t('tokenRankingNext')}
              </button>
            </Box>
          )}
        </>
      )}

      {/* Empty State */}
      {!loading && !currentError && currentData && displayed.length === 0 && (
        <EmptyState
          icon={
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
            </svg>
          }
          title={t('tokenRankingNoData').replace('{token}', token)}
          description={t('tokenRankingNoDataDesc')}
          action={
            <Link
              href="/rankings/tokens"
              style={{
                display: 'inline-block',
                padding: '8px 20px',
                borderRadius: tokens.radius.md,
                background: 'var(--color-accent-primary)',
                color: 'var(--color-bg-primary)',
                textDecoration: 'none',
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              {t('tokenRankingBrowseAll')}
            </Link>
          }
        />
      )}
    </Box>
  )
}
