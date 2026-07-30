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
import { isValidTokenSymbol } from '@/lib/utils/token-symbol'

export type Period = '7D' | '30D' | '90D'

export interface TokenTrader {
  source: string
  source_trader_id: string
  handle: string | null
  avatar_url: string | null
  arena_score: number | null
  roi: number | null
  total_pnl: number | null
  token_rank: number
  token_pnl: number
  token_trade_count: number
  token_win_rate: number | null
  token_avg_pnl_pct: number | null
}

export interface TokenRankingSnapshotSeed {
  contract: 'token-ranking-page@1'
  generation: string
  profilePublicationId: string | null
  publishedAt: string
  publishedAtEpochMs: number
  windowThroughDate: string
  sourceAsOf: string | null
  sourceThroughDate: string | null
  dailyRowCount: number
  popularRowCount: number
  token: string
  period: Period
  lookbackDays: number
  limit: number
  offset: number
  total: number
  traders: TokenTrader[]
}

const PAGE_SIZE = 50
const MAX_PAGE_INDEX = 40_000
const CLIENT_REQUEST_TIMEOUT_MS = 15_000
const EMPTY_TRADERS: TokenTrader[] = []
const MAX_GENERATION = 9_007_199_254_740_000
const SOURCE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/
const SNAPSHOT_KEYS = [
  'contract',
  'dailyRowCount',
  'generation',
  'limit',
  'lookbackDays',
  'offset',
  'period',
  'popularRowCount',
  'profilePublicationId',
  'publishedAt',
  'publishedAtEpochMs',
  'sourceAsOf',
  'sourceThroughDate',
  'token',
  'total',
  'traders',
  'windowThroughDate',
] as const
const TRADER_KEYS = [
  'arena_score',
  'avatar_url',
  'handle',
  'roi',
  'source',
  'source_trader_id',
  'token_avg_pnl_pct',
  'token_pnl',
  'token_rank',
  'token_trade_count',
  'token_win_rate',
  'total_pnl',
] as const

interface RankingPageData {
  traders: TokenTrader[]
  total: number
  generation: string
  profilePublicationId: string | null
  publishedAt: string
  publishedAtEpochMs: number
  windowThroughDate: string
  sourceAsOf: string | null
}

type RequestState = {
  key: string
  status: 'loading' | 'idle' | 'error'
}

function rankingPageKey(
  token: string,
  generation: string | null,
  profilePublicationId: string | null,
  period: Period,
  page: number
): string {
  return JSON.stringify([
    token,
    generation ?? 'unbound',
    profilePublicationId ?? 'profile-unknown',
    period,
    page,
  ])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nullableFiniteNumberOrInvalid(value: unknown): number | null | undefined {
  if (value === null) return null
  const parsed = finiteNumberOrNull(value)
  return parsed === null ? undefined : parsed
}

function safeIntegerOrNull(value: unknown, minimum: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : null
}

function generationOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)) return null
  try {
    const parsed = BigInt(value)
    return parsed <= BigInt(MAX_GENERATION) && String(parsed) === value ? value : null
  } catch {
    return null
  }
}

function instantEpochMs(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = RFC3339_PATTERN.exec(value)
  if (!match) return null
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zone] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const baseMs = Date.UTC(year, month - 1, day, hour, minute, second)
  const probe = new Date(baseMs)
  if (
    year < 1000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute ||
    probe.getUTCSeconds() !== second
  ) {
    return null
  }

  let offsetMinutes = 0
  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3))
    const offsetMinutePart = Number(zone.slice(4, 6))
    if (offsetHours > 23 || offsetMinutePart > 59) return null
    offsetMinutes = (zone[0] === '+' ? 1 : -1) * (offsetHours * 60 + offsetMinutePart)
  }
  const fractionMicros = Number((fraction ?? '').padEnd(6, '0') || '0')
  const epochMs = baseMs - offsetMinutes * 60_000 + Math.floor(fractionMicros / 1000)
  return Number.isSafeInteger(epochMs) ? epochMs : null
}

function validCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return (
    Number(value.slice(0, 4)) >= 1000 &&
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  )
}

function profilePublicationIdOrNull(value: unknown): string | null | undefined {
  if (value === null) return null
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    value === value.trim()
    ? value
    : undefined
}

export function normalizeTokenRankingPageResponse(
  value: unknown,
  expected: {
    token: string
    period: Period
    page: number
    generation: string | null
  }
): RankingPageData {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) {
    throw new Error('Token ranking response shape changed')
  }
  const response = value
  const generation = generationOrNull(response.generation)
  const profilePublicationId = profilePublicationIdOrNull(response.profilePublicationId)
  const publishedAtEpochMs = safeIntegerOrNull(response.publishedAtEpochMs, 0)
  const parsedPublishedAtEpochMs = instantEpochMs(response.publishedAt)
  const parsedSourceAsOfEpochMs =
    response.sourceAsOf === null ? null : instantEpochMs(response.sourceAsOf)
  const total = safeIntegerOrNull(response.total, 0)
  const expectedOffset = expected.page * PAGE_SIZE
  const expectedLookback = expected.period === '7D' ? 7 : expected.period === '30D' ? 30 : 90
  if (
    response.contract !== 'token-ranking-page@1' ||
    !isValidTokenSymbol(expected.token) ||
    response.token !== expected.token ||
    response.period !== expected.period ||
    response.lookbackDays !== expectedLookback ||
    response.limit !== PAGE_SIZE ||
    response.offset !== expectedOffset ||
    !generation ||
    (expected.generation !== null && generation !== expected.generation) ||
    profilePublicationId === undefined ||
    typeof response.publishedAt !== 'string' ||
    parsedPublishedAtEpochMs === null ||
    publishedAtEpochMs === null ||
    parsedPublishedAtEpochMs !== publishedAtEpochMs ||
    !validCalendarDate(response.windowThroughDate) ||
    (response.sourceAsOf !== null && parsedSourceAsOfEpochMs === null) ||
    (parsedSourceAsOfEpochMs !== null &&
      parsedSourceAsOfEpochMs > parsedPublishedAtEpochMs + 5 * 60_000) ||
    (response.sourceThroughDate !== null && !validCalendarDate(response.sourceThroughDate)) ||
    safeIntegerOrNull(response.dailyRowCount, 0) === null ||
    safeIntegerOrNull(response.popularRowCount, 0) === null ||
    total === null ||
    !Array.isArray(response.traders)
  ) {
    throw new Error('Token ranking response did not match its publication contract')
  }

  const expectedLength = Math.min(PAGE_SIZE, Math.max(total - expectedOffset, 0))
  if (response.traders.length !== expectedLength) {
    throw new Error('Token ranking response cardinality did not match its total')
  }

  const seenIdentities = new Set<string>()
  const traders = response.traders.map((value, index) => {
    const trader = normalizeTokenTrader(value)
    if (!trader || trader.token_rank !== expectedOffset + index + 1 || trader.token_rank > total) {
      throw new Error('Token ranking response contained invalid rank authority')
    }
    const identity = JSON.stringify([trader.source, trader.source_trader_id])
    if (seenIdentities.has(identity)) {
      throw new Error('Token ranking response repeated a trader identity')
    }
    seenIdentities.add(identity)
    return trader
  })

  return {
    traders,
    total,
    generation,
    profilePublicationId,
    publishedAt: response.publishedAt,
    publishedAtEpochMs,
    windowThroughDate: response.windowThroughDate,
    sourceAsOf: response.sourceAsOf as string | null,
  }
}

function normalizeTokenTrader(value: unknown): TokenTrader | null {
  if (!isRecord(value) || !hasExactKeys(value, TRADER_KEYS)) return null
  const trader = value
  const tokenRank = safeIntegerOrNull(trader.token_rank, 1)
  const tokenPnl = finiteNumberOrNull(trader.token_pnl)
  const tokenTradeCount = safeIntegerOrNull(trader.token_trade_count, 0)
  const arenaScore = nullableFiniteNumberOrInvalid(trader.arena_score)
  const roi = nullableFiniteNumberOrInvalid(trader.roi)
  const totalPnl = nullableFiniteNumberOrInvalid(trader.total_pnl)
  const tokenWinRate = nullableFiniteNumberOrInvalid(trader.token_win_rate)
  const tokenAvgPnlPct = nullableFiniteNumberOrInvalid(trader.token_avg_pnl_pct)
  if (
    typeof trader.source !== 'string' ||
    !SOURCE_PATTERN.test(trader.source) ||
    typeof trader.source_trader_id !== 'string' ||
    trader.source_trader_id.length === 0 ||
    trader.source_trader_id !== trader.source_trader_id.trim() ||
    (trader.handle !== null && typeof trader.handle !== 'string') ||
    (trader.avatar_url !== null && typeof trader.avatar_url !== 'string') ||
    tokenRank === null ||
    tokenPnl === null ||
    tokenTradeCount === null ||
    arenaScore === undefined ||
    roi === undefined ||
    totalPnl === undefined ||
    tokenWinRate === undefined ||
    tokenAvgPnlPct === undefined ||
    (arenaScore !== null && (arenaScore < 0 || arenaScore > 100)) ||
    (tokenWinRate !== null && (tokenWinRate < 0 || tokenWinRate > 100))
  ) {
    return null
  }

  return {
    source: trader.source,
    source_trader_id: trader.source_trader_id,
    handle: trader.handle as string | null,
    avatar_url: trader.avatar_url as string | null,
    arena_score: arenaScore,
    roi,
    total_pnl: totalPnl,
    token_rank: tokenRank,
    token_pnl: tokenPnl,
    token_trade_count: tokenTradeCount,
    token_win_rate: tokenWinRate,
    token_avg_pnl_pct: tokenAvgPnlPct,
  }
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
      <span
        style={{
          color: tokens.colors.white,
          fontSize: tokens.typography.fontSize.xs,
          fontWeight: tokens.typography.fontWeight.bold,
        }}
      >
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
          type="button"
          key={p}
          onClick={() => onChange(p)}
          disabled={loading}
          aria-pressed={period === p}
          style={{
            padding: '6px 14px',
            minHeight: 36,
            borderRadius: tokens.radius.md,
            border: 'none',
            fontSize: tokens.typography.fontSize.sm,
            fontWeight:
              period === p
                ? tokens.typography.fontWeight.bold
                : tokens.typography.fontWeight.medium,
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
        fontSize: tokens.typography.fontSize.xs,
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
        fontSize: tokens.typography.fontSize.xs,
        fontWeight: active
          ? tokens.typography.fontWeight.bold
          : tokens.typography.fontWeight.semibold,
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
  initialPage,
  requestedGeneration,
  initialSnapshot,
}: {
  token: string
  initialPeriod: Period
  initialPage: number
  requestedGeneration: string | null
  initialSnapshot: TokenRankingSnapshotSeed | null
}) {
  const { t } = useLanguage()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const initialData = useMemo(() => {
    if (!initialSnapshot) return null
    try {
      return normalizeTokenRankingPageResponse(initialSnapshot, {
        token,
        period: initialPeriod,
        page: initialPage,
        generation: requestedGeneration ?? initialSnapshot.generation,
      })
    } catch {
      return null
    }
  }, [initialPage, initialPeriod, initialSnapshot, requestedGeneration, token])

  const rawUrlPeriod = searchParams.get('period')?.toUpperCase()
  const urlPeriod: Period =
    rawUrlPeriod === '7D' || rawUrlPeriod === '30D' || rawUrlPeriod === '90D' ? rawUrlPeriod : '90D'
  const rawUrlPage = searchParams.get('page')
  const parsedUrlPage = rawUrlPage && /^[1-9]\d{0,4}$/.test(rawUrlPage) ? Number(rawUrlPage) : 0
  const urlPage = parsedUrlPage <= MAX_PAGE_INDEX ? parsedUrlPage : MAX_PAGE_INDEX
  const urlGeneration = generationOrNull(searchParams.get('generation'))

  const initialGeneration = initialData?.generation ?? requestedGeneration
  const initialProfilePublicationId = initialData?.profilePublicationId ?? null
  const [period, setPeriod] = useState<Period>(initialPeriod)
  const [page, setPageRaw] = useState(initialPage)
  const [activePublication, setActivePublication] = useState<{
    generation: string
    profilePublicationId: string | null
  } | null>(() =>
    initialGeneration
      ? { generation: initialGeneration, profilePublicationId: initialProfilePublicationId }
      : null
  )
  const [sortKey, setSortKey] = useState<SortKey>('token_pnl')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [pages, setPages] = useState<Map<string, RankingPageData>>(() => {
    const initialPages = new Map<string, RankingPageData>()
    if (initialData) {
      initialPages.set(
        rankingPageKey(
          token,
          initialData.generation,
          initialData.profilePublicationId,
          initialPeriod,
          initialPage
        ),
        initialData
      )
    }
    return initialPages
  })
  const pagesRef = useRef(pages)
  const publicationRef = useRef(activePublication)
  const publicationProfilesRef = useRef(
    new Map<string, string | null>(
      initialData ? [[initialData.generation, initialData.profilePublicationId]] : []
    )
  )
  const [requestState, setRequestState] = useState<RequestState>(() => ({
    key: rankingPageKey(
      token,
      initialGeneration,
      initialProfilePublicationId,
      initialPeriod,
      initialPage
    ),
    status: initialData ? 'idle' : 'loading',
  }))
  const abortRef = useRef<AbortController | null>(null)
  const requestIdRef = useRef(0)
  const generationRebaseUsedRef = useRef(false)
  const generationCanonicalizedRef = useRef<string | null>(null)

  const commitPublication = useCallback(
    (publication: { generation: string; profilePublicationId: string | null } | null) => {
      publicationRef.current = publication
      setActivePublication(publication)
      if (publication) {
        publicationProfilesRef.current.set(publication.generation, publication.profilePublicationId)
      }
    },
    []
  )

  const cancelCurrentRequest = useCallback(() => {
    requestIdRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  const navigate = useCallback(
    (mode: 'push' | 'replace', nextPeriod: Period, nextPage: number, generation: string | null) => {
      const params = new URLSearchParams()
      if (nextPeriod !== '90D') params.set('period', nextPeriod)
      if (nextPage > 0) params.set('page', String(nextPage))
      if (generation) params.set('generation', generation)
      const query = params.toString()
      router[mode](`${pathname}${query ? `?${query}` : ''}`, { scroll: false })
    },
    [pathname, router]
  )

  // URL changes are authoritative for back/forward. Profile publication is
  // recovered from the generation map so a cached historical page can paint
  // without being confused with the current generation's optional enrichment.
  useEffect(() => {
    const desiredGeneration =
      urlGeneration ?? initialData?.generation ?? requestedGeneration ?? null
    const current = publicationRef.current
    const desiredProfile = desiredGeneration
      ? (publicationProfilesRef.current.get(desiredGeneration) ??
        (current?.generation === desiredGeneration ? current.profilePublicationId : null))
      : null
    if (
      period !== urlPeriod ||
      page !== urlPage ||
      current?.generation !== desiredGeneration ||
      (desiredGeneration !== null && current?.profilePublicationId !== desiredProfile)
    ) {
      cancelCurrentRequest()
      setPeriod(urlPeriod)
      setPageRaw(urlPage)
      commitPublication(
        desiredGeneration
          ? { generation: desiredGeneration, profilePublicationId: desiredProfile }
          : null
      )
    }
  }, [
    cancelCurrentRequest,
    commitPublication,
    initialData?.generation,
    page,
    period,
    requestedGeneration,
    urlGeneration,
    urlPage,
    urlPeriod,
  ])

  useEffect(() => {
    if (
      initialData &&
      !urlGeneration &&
      generationCanonicalizedRef.current !== initialData.generation
    ) {
      generationCanonicalizedRef.current = initialData.generation
      navigate('replace', initialPeriod, initialPage, initialData.generation)
    }
  }, [initialData, initialPage, initialPeriod, navigate, urlGeneration])

  // App Router can preserve this client instance while delivering a new SSR
  // snapshot for back/forward navigation. Seed that page into the publication-
  // keyed cache instead of issuing a duplicate client request.
  useEffect(() => {
    if (!initialData) return
    const key = rankingPageKey(
      token,
      initialData.generation,
      initialData.profilePublicationId,
      initialPeriod,
      initialPage
    )
    publicationProfilesRef.current.set(initialData.generation, initialData.profilePublicationId)
    if (pagesRef.current.get(key) !== initialData) {
      const nextPages = new Map(pagesRef.current)
      nextPages.set(key, initialData)
      pagesRef.current = nextPages
      setPages(nextPages)
    }
    const desiredGeneration = urlGeneration ?? initialData.generation
    if (
      urlPeriod === initialPeriod &&
      urlPage === initialPage &&
      desiredGeneration === initialData.generation
    ) {
      commitPublication({
        generation: initialData.generation,
        profilePublicationId: initialData.profilePublicationId,
      })
    }
  }, [
    commitPublication,
    initialData,
    initialPage,
    initialPeriod,
    token,
    urlGeneration,
    urlPage,
    urlPeriod,
  ])

  const tokenColor = TOKEN_COLORS[token] || tokens.colors.accent.primary
  const currentKey = rankingPageKey(
    token,
    activePublication?.generation ?? null,
    activePublication?.profilePublicationId ?? null,
    period,
    page
  )
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
      const next = Math.min(MAX_PAGE_INDEX, Math.max(0, typeof p === 'function' ? p(page) : p))
      if (next === page) return
      cancelCurrentRequest()
      generationRebaseUsedRef.current = false
      navigate('push', period, next, publicationRef.current?.generation ?? null)
    },
    [cancelCurrentRequest, navigate, page, period]
  )

  const fetchData = useCallback(
    async (p: Period, pageIndex: number) => {
      cancelCurrentRequest()
      const controller = new AbortController()
      abortRef.current = controller
      const requestId = requestIdRef.current
      const requestedPublication = publicationRef.current
      const requestedGeneration = requestedPublication?.generation ?? null
      const key = rankingPageKey(
        token,
        requestedGeneration,
        requestedPublication?.profilePublicationId ?? null,
        p,
        pageIndex
      )
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, CLIENT_REQUEST_TIMEOUT_MS)

      setRequestState({ key, status: 'loading' })
      try {
        const params = new URLSearchParams({
          token,
          period: p,
          limit: String(PAGE_SIZE),
          offset: String(pageIndex * PAGE_SIZE),
        })
        if (requestedGeneration) params.set('generation', requestedGeneration)
        const res = await fetch(`/api/rankings/by-token?${params.toString()}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        const data: unknown = await res.json().catch(() => null)
        const requestIsCurrent = () =>
          abortRef.current === controller &&
          requestIdRef.current === requestId &&
          !controller.signal.aborted
        if (!requestIsCurrent()) return

        if (res.status === 409) {
          const currentGeneration =
            data && typeof data === 'object'
              ? generationOrNull((data as { current_generation?: unknown }).current_generation)
              : null
          const isGenerationConflict =
            data &&
            typeof data === 'object' &&
            (data as { code?: unknown }).code === 'TOKEN_RANKING_GENERATION_CHANGED'
          if (
            isGenerationConflict &&
            requestedGeneration &&
            currentGeneration &&
            currentGeneration !== requestedGeneration &&
            !generationRebaseUsedRef.current
          ) {
            generationRebaseUsedRef.current = true
            const emptyPages = new Map<string, RankingPageData>()
            pagesRef.current = emptyPages
            setPages(emptyPages)
            publicationProfilesRef.current.set(currentGeneration, null)
            navigate('replace', p, 0, currentGeneration)
            setRequestState({
              key: rankingPageKey(token, currentGeneration, null, p, 0),
              status: 'loading',
            })
            return
          }
          throw new Error('Token ranking generation changed repeatedly')
        }
        if (!res.ok) throw new Error(`Token rankings request failed: ${res.status}`)

        const response = normalizeTokenRankingPageResponse(data, {
          token,
          period: p,
          page: pageIndex,
          generation: requestedGeneration,
        })
        if (!requestIsCurrent()) return

        const responsePublication = {
          generation: response.generation,
          profilePublicationId: response.profilePublicationId,
        }
        const publicationChanged =
          requestedPublication?.generation !== response.generation ||
          requestedPublication?.profilePublicationId !== response.profilePublicationId
        const totalPagesForResponse = Math.ceil(response.total / PAGE_SIZE)
        const lastPage = Math.max(totalPagesForResponse - 1, 0)
        if (pageIndex > lastPage) {
          const emptyPages = new Map<string, RankingPageData>()
          pagesRef.current = emptyPages
          setPages(emptyPages)
          publicationProfilesRef.current.set(response.generation, response.profilePublicationId)
          navigate('replace', p, lastPage, response.generation)
          setRequestState({
            key: rankingPageKey(
              token,
              response.generation,
              response.profilePublicationId,
              p,
              lastPage
            ),
            status: 'loading',
          })
          return
        }

        const responseKey = rankingPageKey(
          token,
          response.generation,
          response.profilePublicationId,
          p,
          pageIndex
        )
        const nextPages = publicationChanged
          ? new Map<string, RankingPageData>()
          : new Map(pagesRef.current)
        nextPages.set(responseKey, response)
        pagesRef.current = nextPages
        setPages(nextPages)
        publicationProfilesRef.current.set(response.generation, response.profilePublicationId)
        if (requestedGeneration) commitPublication(responsePublication)
        generationRebaseUsedRef.current = false
        if (!requestedGeneration) navigate('replace', p, pageIndex, response.generation)
        setRequestState({ key: responseKey, status: 'idle' })
      } catch (err) {
        if (abortRef.current !== controller || requestIdRef.current !== requestId) return
        if (controller.signal.aborted && !timedOut) return
        if (err instanceof Error && err.name === 'AbortError' && !timedOut) return
        setRequestState({ key, status: 'error' })
      } finally {
        clearTimeout(timeout)
      }
    },
    [cancelCurrentRequest, commitPublication, navigate, token]
  )

  useEffect(() => {
    const desiredGeneration =
      urlGeneration ?? initialData?.generation ?? requestedGeneration ?? null
    // URL synchronization and SSR seeding run before this effect. If either
    // changed refs/state during the same effect flush, wait for the committed
    // rerender instead of issuing a request for the previous URL selection.
    if (
      period !== urlPeriod ||
      page !== urlPage ||
      (activePublication?.generation ?? null) !== desiredGeneration ||
      publicationRef.current !== activePublication
    ) {
      return
    }
    const key = rankingPageKey(
      token,
      activePublication?.generation ?? null,
      activePublication?.profilePublicationId ?? null,
      period,
      page
    )
    if (pagesRef.current.has(key)) {
      abortRef.current?.abort()
      abortRef.current = null
      setRequestState({ key, status: 'idle' })
      return
    }
    void fetchData(period, page)
  }, [
    activePublication,
    fetchData,
    initialData?.generation,
    page,
    period,
    requestedGeneration,
    token,
    urlGeneration,
    urlPage,
    urlPeriod,
  ])

  useEffect(() => () => cancelCurrentRequest(), [cancelCurrentRequest])

  const handlePeriodChange = useCallback(
    (newPeriod: Period) => {
      if (newPeriod === period) return
      cancelCurrentRequest()
      generationRebaseUsedRef.current = false
      navigate('push', newPeriod, 0, publicationRef.current?.generation ?? null)
    },
    [cancelCurrentRequest, navigate, period]
  )

  const handleSort = useCallback((key: SortKey) => {
    setSortKey((prevKey) => {
      setSortDir((prevDir) => (prevKey === key ? (prevDir === 'desc' ? 'asc' : 'desc') : 'desc'))
      return key
    })
  }, [])

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const lastBrowsablePage = Math.min(Math.max(totalPages - 1, 0), MAX_PAGE_INDEX)

  const displayed = useMemo(() => {
    const arr = [...traders]
    arr.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      const an = finiteNumberOrNull(av)
      const bn = finiteNumberOrNull(bv)
      if (an === null && bn === null) return a.token_rank - b.token_rank
      if (an === null) return 1
      if (bn === null) return -1
      const comparison = sortDir === 'desc' ? bn - an : an - bn
      return comparison || a.token_rank - b.token_rank
    })
    return arr
  }, [traders, sortKey, sortDir])

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
              fontSize: tokens.typography.fontSize.xl,
              fontWeight: tokens.typography.fontWeight.extrabold,
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
          retry={() => {
            generationRebaseUsedRef.current = false
            void fetchData(period, page)
          }}
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
                    fontSize: tokens.typography.fontSize.xs,
                    fontWeight: tokens.typography.fontWeight.semibold,
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
                      const rank = trader.token_rank
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
                          href={`/trader/${encodeURIComponent(trader.handle || trader.source_trader_id)}?platform=${encodeURIComponent(trader.source)}`}
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
                                  fontSize: tokens.typography.fontSize.sm,
                                  fontWeight: tokens.typography.fontWeight.bold,
                                  background: `linear-gradient(135deg, ${medal.from}, ${medal.to})`,
                                  color: 'var(--color-bg-primary)',
                                }}
                              >
                                {rank}
                              </span>
                            ) : (
                              <span
                                style={{
                                  fontSize: tokens.typography.fontSize.sm,
                                  fontWeight: tokens.typography.fontWeight.semibold,
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
                                  fontSize: tokens.typography.fontSize.sm,
                                  fontWeight: tokens.typography.fontWeight.semibold,
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
                                <span
                                  style={{
                                    fontSize: tokens.typography.fontSize.xs,
                                    color: tokens.colors.text.tertiary,
                                  }}
                                >
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
                                    fontSize: tokens.typography.fontSize.sm,
                                    fontWeight: tokens.typography.fontWeight.extrabold,
                                    color: scoreInfo.color,
                                    fontVariantNumeric: 'tabular-nums',
                                  }}
                                >
                                  {trader.arena_score.toFixed(0)}
                                </span>
                                <ScoreMiniBar score={trader.arena_score} width={52} height={4} />
                              </>
                            ) : (
                              <span
                                style={{
                                  fontSize: tokens.typography.fontSize.sm,
                                  color: tokens.colors.text.tertiary,
                                }}
                              >
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

          {/* Pagination */}
          {totalPages > 1 && (
            <Box style={{ display: 'flex', justifyContent: 'center', gap: 8, padding: '20px 0' }}>
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0 || loading}
                style={{
                  padding: '8px 16px',
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.secondary,
                  color: page === 0 ? tokens.colors.text.tertiary : tokens.colors.text.primary,
                  cursor: page === 0 ? 'not-allowed' : 'pointer',
                  fontSize: tokens.typography.fontSize.sm,
                }}
              >
                {t('tokenRankingPrev')}
              </button>
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  fontSize: tokens.typography.fontSize.sm,
                  color: tokens.colors.text.secondary,
                }}
              >
                {page + 1} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(lastBrowsablePage, p + 1))}
                disabled={page >= lastBrowsablePage || loading}
                style={{
                  padding: '8px 16px',
                  borderRadius: tokens.radius.md,
                  border: `1px solid ${tokens.colors.border.primary}`,
                  background: tokens.colors.bg.secondary,
                  color:
                    page >= lastBrowsablePage
                      ? tokens.colors.text.tertiary
                      : tokens.colors.text.primary,
                  cursor: page >= lastBrowsablePage ? 'not-allowed' : 'pointer',
                  fontSize: tokens.typography.fontSize.sm,
                }}
              >
                {t('tokenRankingNext')}
              </button>
            </Box>
          )}
        </>
      )}

      {/* Data freshness is source evidence, never the HTML render or publication time. */}
      {currentData &&
        (currentData.sourceAsOf ? (
          <ProvenanceFooter
            provenance={{ source: 'arena', asOf: currentData.sourceAsOf }}
            exchangeName="Arena"
          />
        ) : (
          <Text
            size="xs"
            color="tertiary"
            style={{ display: 'block', marginTop: tokens.spacing[2] }}
          >
            {t('provenanceSource')}: Arena · {t('provenanceAsOf')} {t('unknown')}
          </Text>
        ))}

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
                fontSize: tokens.typography.fontSize.base,
                fontWeight: tokens.typography.fontWeight.semibold,
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
