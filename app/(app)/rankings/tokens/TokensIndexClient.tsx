'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Box, Text } from '@/app/components/base'
import PageHeader from '@/app/components/ui/PageHeader'
import CryptoIcon from '@/app/components/common/CryptoIcon'
import Metric from '@/app/components/ui/Metric'
import ErrorState from '@/app/components/ui/ErrorState'
import EmptyState from '@/app/components/ui/EmptyState'
import ProvenanceFooter from '@/app/components/common/ProvenanceFooter'
import { tokens } from '@/lib/design-tokens'
import { formatPnL } from '@/lib/utils/format'
import { isTokenRankingNotPublishedResponse } from '@/lib/rankings/token-ranking-api-contract'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export interface PopularToken {
  token: string
  trade_count: number
  trader_count: number
  total_pnl: number
}

export interface TokenRankingPublicationMetadata {
  publishedAt: string
  publishedAtEpochMs: number
  windowThroughDate: string
  sourceAsOf: string | null
  sourceThroughDate: string | null
  dailyRowCount: number
  popularRowCount: number
}

export interface PopularTokenIndexSnapshot extends TokenRankingPublicationMetadata {
  contract: 'popular-token-page@1'
  generation: string
  lookbackDays: 90
  limit: number
  total: number
  tokens: PopularToken[]
}

interface TokenCard {
  token: string
  trade_count: number | null
  trader_count: number | null
  total_pnl: number | null
}

// Featured tokens always displayed (even with no activity yet) so the index is
// never empty on a cold cache. They sort to the bottom once real data arrives.
const FEATURED_TOKENS = [
  'BTC',
  'ETH',
  'SOL',
  'BNB',
  'XRP',
  'DOGE',
  'ARB',
  'OP',
  'AVAX',
  'LINK',
  'UNI',
  'ADA',
]

type SortKey = 'traders' | 'trades' | 'pnl'
const CLIENT_REQUEST_TIMEOUT_MS = 15_000
const POPULAR_TOKEN_CONTRACT = 'popular-token-page@1'
const POPULAR_TOKEN_LIMIT = 50
const MAX_GENERATION = 9_007_199_254_740_000
const SNAPSHOT_KEYS = [
  'contract',
  'dailyRowCount',
  'generation',
  'limit',
  'lookbackDays',
  'popularRowCount',
  'publishedAt',
  'publishedAtEpochMs',
  'sourceAsOf',
  'sourceThroughDate',
  'tokens',
  'total',
  'windowThroughDate',
] as const
const TOKEN_KEYS = ['token', 'total_pnl', 'trade_count', 'trader_count'] as const
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}

function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return (
    Number(value.slice(0, 4)) >= 1000 &&
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  )
}

function parseRfc3339EpochMs(value: unknown): number | null {
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

function isRfc3339(value: unknown): value is string {
  return parseRfc3339EpochMs(value) !== null
}

function isGeneration(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return false
  try {
    const generation = BigInt(value)
    return generation <= BigInt(MAX_GENERATION) && String(generation) === value
  } catch {
    return false
  }
}

function parsePopularToken(
  value: unknown,
  index: number,
  previous: PopularToken | null
): PopularToken {
  if (!isRecord(value) || !hasExactKeys(value, TOKEN_KEYS)) {
    throw new Error(`popular-tokens: token row ${index} shape changed`)
  }
  const token = value.token
  const tradeCount = value.trade_count
  const traderCount = value.trader_count
  const totalPnl = value.total_pnl
  if (
    typeof token !== 'string' ||
    !/^[A-Z0-9]{1,10}$/.test(token) ||
    !/[A-Z]/.test(token) ||
    !isSafeInteger(tradeCount) ||
    !isSafeInteger(traderCount) ||
    typeof totalPnl !== 'number' ||
    !Number.isFinite(totalPnl)
  ) {
    throw new Error(`popular-tokens: token row ${index} is invalid`)
  }
  const parsed = {
    token,
    trade_count: tradeCount,
    trader_count: traderCount,
    total_pnl: totalPnl,
  }
  if (
    previous &&
    (parsed.trade_count > previous.trade_count ||
      (parsed.trade_count === previous.trade_count && parsed.token <= previous.token))
  ) {
    throw new Error(`popular-tokens: token row ${index} is out of order`)
  }
  return parsed
}

export function parsePopularTokenIndexSnapshot(value: unknown): PopularTokenIndexSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) {
    throw new Error('popular-tokens: snapshot shape changed')
  }
  const publishedAtEpochMs = parseRfc3339EpochMs(value.publishedAt)
  const sourceAsOfEpochMs = value.sourceAsOf === null ? null : parseRfc3339EpochMs(value.sourceAsOf)
  if (
    value.contract !== POPULAR_TOKEN_CONTRACT ||
    value.lookbackDays !== 90 ||
    value.limit !== POPULAR_TOKEN_LIMIT ||
    !isGeneration(value.generation) ||
    typeof value.publishedAt !== 'string' ||
    publishedAtEpochMs === null ||
    !isSafeInteger(value.publishedAtEpochMs) ||
    publishedAtEpochMs !== value.publishedAtEpochMs ||
    !isCanonicalDate(value.windowThroughDate) ||
    !(value.sourceAsOf === null || isRfc3339(value.sourceAsOf)) ||
    (sourceAsOfEpochMs !== null &&
      publishedAtEpochMs !== null &&
      sourceAsOfEpochMs > publishedAtEpochMs + 5 * 60_000) ||
    !(value.sourceThroughDate === null || isCanonicalDate(value.sourceThroughDate)) ||
    !isSafeInteger(value.dailyRowCount) ||
    !isSafeInteger(value.popularRowCount) ||
    !isSafeInteger(value.total) ||
    !Array.isArray(value.tokens) ||
    value.tokens.length !== Math.min(value.total, POPULAR_TOKEN_LIMIT)
  ) {
    throw new Error('popular-tokens: snapshot contract is invalid')
  }

  const seen = new Set<string>()
  let previous: PopularToken | null = null
  const parsedTokens = value.tokens.map((candidate, index) => {
    const parsed = parsePopularToken(candidate, index, previous)
    if (seen.has(parsed.token)) throw new Error('popular-tokens: duplicate token')
    seen.add(parsed.token)
    previous = parsed
    return parsed
  })

  return {
    contract: POPULAR_TOKEN_CONTRACT,
    generation: value.generation,
    publishedAt: value.publishedAt,
    publishedAtEpochMs: value.publishedAtEpochMs,
    windowThroughDate: value.windowThroughDate,
    sourceAsOf: value.sourceAsOf,
    sourceThroughDate: value.sourceThroughDate,
    dailyRowCount: value.dailyRowCount,
    popularRowCount: value.popularRowCount,
    lookbackDays: 90,
    limit: POPULAR_TOKEN_LIMIT,
    total: value.total,
    tokens: parsedTokens,
  }
}

function sortValue(tk: TokenCard, key: SortKey): number | null {
  switch (key) {
    case 'trades':
      return tk.trade_count
    case 'pnl':
      return tk.total_pnl
    case 'traders':
    default:
      return tk.trader_count
  }
}

// Hover/focus affordances live in CSS so cards are keyboard-reachable (:focus-visible
// ring) and touch-friendly — replacing the old JS onMouseEnter/Leave inline mutations.
// The accent tint is a single safe design-token color, not a per-token hardcoded hex.
const TOKENS_INDEX_CSS = `
.tk-card-link{display:block;text-decoration:none;border-radius:${tokens.radius.xl};}
.tk-card-link:focus-visible{outline:none;}
.tk-card{transition:border-color .2s ease,transform .2s ease,box-shadow .2s ease;}
.tk-card-link:hover .tk-card{
  border-color:var(--color-accent-primary);
  transform:translateY(-2px);
  box-shadow:${tokens.shadow.md};
}
.tk-card-link:focus-visible .tk-card{
  border-color:var(--color-accent-primary);
  box-shadow:0 0 0 3px var(--color-accent-primary-30);
}
.tk-search-input{outline:none;}
.tk-search-input:focus-visible{
  border-color:var(--color-accent-primary)!important;
  box-shadow:0 0 0 3px var(--color-accent-primary-30);
}
.tk-sort-btn{
  background:var(--color-bg-secondary);
  border:1px solid var(--color-border-primary);
  border-radius:999px;
  padding:6px 14px;
  font-size:13px;
  font-weight:600;
  color:var(--color-text-tertiary);
  cursor:pointer;
  transition:color .15s ease,border-color .15s ease,background .15s ease;
}
.tk-sort-btn:hover{color:var(--color-text-secondary);}
.tk-sort-btn[aria-pressed="true"]{
  background:var(--color-accent-primary-15);
  border-color:var(--color-accent-primary);
  color:var(--color-text-primary);
}
.tk-sort-btn:focus-visible{outline:2px solid var(--color-accent-primary);outline-offset:2px;}
.tk-search-input:disabled,.tk-sort-btn:disabled{cursor:wait;opacity:.65;}
`

interface TokensIndexClientProps {
  initialSnapshot?: PopularTokenIndexSnapshot | null
  initialStatus?: 'success' | 'unpublished' | 'error'
}

export default function TokensIndexClient({
  initialSnapshot = null,
  initialStatus = initialSnapshot === null ? 'error' : 'success',
}: TokensIndexClientProps = {}) {
  const { t } = useLanguage()
  const [snapshot, setSnapshot] = useState<PopularTokenIndexSnapshot | null>(
    initialStatus === 'success' ? initialSnapshot : null
  )
  const [loadState, setLoadState] = useState<'loading' | 'success' | 'unpublished' | 'error'>(
    initialStatus === 'success' && initialSnapshot !== null
      ? 'success'
      : initialStatus === 'unpublished'
        ? 'unpublished'
        : 'loading'
  )
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('traders')
  const requestRef = useRef<AbortController | null>(null)
  // SSR controls must not advertise interactivity before React owns their
  // events. On slower mobile hydration, users could type into the search box
  // and then watch their text disappear when hydration reset the DOM value.
  const [interactive, setInteractive] = useState(false)

  useEffect(() => {
    setInteractive(true)
  }, [])

  const loadPopularTokens = useCallback(async () => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, CLIENT_REQUEST_TIMEOUT_MS)
    setLoadState('loading')

    try {
      const response = await fetch('/api/rankings/by-token?action=popular-tokens', {
        signal: controller.signal,
        cache: 'no-store',
      })
      const body: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        if (isTokenRankingNotPublishedResponse(response.status, body)) {
          if (requestRef.current !== controller || controller.signal.aborted) return
          setSnapshot(null)
          setLoadState('unpublished')
          return
        }
        throw new Error(`popular-tokens: ${response.status}`)
      }
      const nextSnapshot = parsePopularTokenIndexSnapshot(body)
      if (requestRef.current !== controller || controller.signal.aborted) return

      // One state update replaces generation, publication metadata, total, and
      // rows together. No field from the previous generation can survive.
      setSnapshot(nextSnapshot)
      setLoadState('success')
    } catch (error) {
      if (requestRef.current !== controller) return
      if (controller.signal.aborted && !timedOut) return
      if (error instanceof Error && error.name === 'AbortError' && !timedOut) return
      setLoadState('error')
    } finally {
      clearTimeout(timeout)
      if (requestRef.current === controller) requestRef.current = null
    }
  }, [])

  useEffect(() => {
    // A successful empty SSR result is legitimate data and must not be retried
    // or relabelled as a transport failure. Only failed/timed-out SSR loads fall
    // through to the wire.
    if (
      initialStatus === 'unpublished' ||
      (initialStatus === 'success' && initialSnapshot !== null)
    ) {
      return
    }
    void loadPopularTokens()
    return () => requestRef.current?.abort()
  }, [initialSnapshot, initialStatus, loadPopularTokens])

  // Merge featured tokens with published tokens (dedup by symbol). Missing
  // featured tokens are discovery links, not measured zero-activity rows.
  const allTokens = useMemo(() => {
    const tokenMap = new Map((snapshot?.tokens ?? []).map((tk) => [tk.token, tk]))
    const result: TokenCard[] = []

    for (const ft of FEATURED_TOKENS) {
      if (tokenMap.has(ft)) {
        result.push(tokenMap.get(ft)!)
        tokenMap.delete(ft)
      } else {
        result.push({ token: ft, trade_count: null, trader_count: null, total_pnl: null })
      }
    }
    for (const [, v] of tokenMap) result.push(v)
    return result
  }, [snapshot])

  // Known values sort first. Unknown featured-token metrics remain at the end
  // even when every published PnL is negative.
  const sorted = useMemo(() => {
    return [...allTokens].sort((a, b) => {
      const aValue = sortValue(a, sortKey)
      const bValue = sortValue(b, sortKey)
      if (aValue === null && bValue === null) return a.token.localeCompare(b.token)
      if (aValue === null) return 1
      if (bValue === null) return -1
      return bValue - aValue || a.token.localeCompare(b.token)
    })
  }, [allTokens, sortKey])

  const filtered = useMemo(() => {
    if (!search) return sorted
    const q = search.toUpperCase()
    return sorted.filter((tk) => tk.token.includes(q))
  }, [sorted, search])

  const sortOptions: { key: SortKey; label: string }[] = [
    { key: 'traders', label: t('tokenRankingsSortTraders') },
    { key: 'trades', label: t('tokenRankingsSortTrades') },
    { key: 'pnl', label: t('tokenRankingsSortPnl') },
  ]

  return (
    <Box>
      <style>{TOKENS_INDEX_CSS}</style>

      {/* Header */}
      <PageHeader
        title={t('tokenRankingsTitle')}
        subtitle={
          loadState === 'unpublished' || (loadState === 'success' && snapshot?.total === 0)
            ? undefined
            : t('tokenRankingsSubtitle')
        }
      />

      {/* Controls: search + sort */}
      {loadState !== 'unpublished' && !(loadState === 'success' && snapshot?.total === 0) && (
        <Box
          style={{
            marginBottom: 20,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
            alignItems: 'center',
          }}
        >
          <input
            type="text"
            className="tk-search-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('tokenRankingsSearchPlaceholder')}
            aria-label={t('tokenRankingsSearchPlaceholder')}
            aria-busy={!interactive || loadState === 'loading'}
            disabled={!interactive}
            style={{
              flex: '1 1 240px',
              maxWidth: 400,
              padding: '10px 16px',
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.secondary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.base,
              transition: `border-color ${tokens.transition.fast}, box-shadow ${tokens.transition.fast}`,
            }}
          />
          <Box
            role="group"
            aria-label={t('tokenRankingsSortLabel')}
            style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
          >
            {sortOptions.map((opt) => (
              <button
                key={opt.key}
                type="button"
                className="tk-sort-btn"
                aria-pressed={sortKey === opt.key}
                disabled={!interactive}
                onClick={() => setSortKey(opt.key)}
              >
                {opt.label}
              </button>
            ))}
          </Box>
        </Box>
      )}

      {loadState === 'unpublished' && (
        <Box role="status" aria-live="polite">
          <EmptyState
            title={t('tokenRankingUnpublishedTitle')}
            description={t('tokenRankingUnpublishedDescription')}
            variant="card"
          />
        </Box>
      )}

      {loadState === 'error' && (
        <ErrorState
          title={t('failedToLoadRankings')}
          description={t('tryAgain')}
          retry={() => void loadPopularTokens()}
          variant={snapshot ? 'compact' : 'default'}
        />
      )}

      {/* Token Grid */}
      {loadState === 'unpublished' ? null : loadState === 'success' && snapshot?.total === 0 ? (
        <Box role="status">
          <EmptyState
            title={t('tokenRankingEmptyCohortTitle')}
            description={t('tokenRankingEmptyCohortDescription')}
            variant="card"
          />
        </Box>
      ) : loadState === 'loading' && snapshot === null ? (
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 16,
          }}
        >
          {Array.from({ length: 12 }).map((_, i) => (
            <Box
              key={i}
              style={{
                height: 120,
                borderRadius: tokens.radius.xl,
                background: tokens.colors.bg.secondary,
                border: `1px solid ${tokens.colors.border.primary}`,
                animation: 'pulse 1.5s ease-in-out infinite',
              }}
            />
          ))}
        </Box>
      ) : loadState !== 'error' || snapshot !== null ? (
        <Box
          data-generation={snapshot?.generation}
          data-published-at={snapshot?.publishedAt}
          data-total={snapshot?.total}
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 16,
          }}
        >
          {filtered.map((tk) => {
            const metrics =
              tk.trade_count === null || tk.trader_count === null || tk.total_pnl === null
                ? null
                : {
                    tradeCount: tk.trade_count,
                    traderCount: tk.trader_count,
                    totalPnl: tk.total_pnl,
                  }
            const ariaLabel = metrics
              ? `${tk.token} — ${metrics.traderCount} ${metrics.traderCount === 1 ? t('tokenRankingsTradersSingular') : t('tokenRankingsTraders')}, ${metrics.tradeCount} ${t('tokenRankingsTrades')}, ${t('tokenRankingsTotalPnl')} ${formatPnL(metrics.totalPnl)}`
              : `${tk.token} — ${t('unknown')}`
            return (
              <Link
                key={tk.token}
                href={`/rankings/tokens/${tk.token}`}
                className="tk-card-link"
                aria-label={ariaLabel}
                data-token={tk.token}
                data-metrics-known={metrics ? 'true' : 'false'}
                data-trader-count={metrics?.traderCount}
                data-trade-count={metrics?.tradeCount}
                data-total-pnl={metrics?.totalPnl}
              >
                <Box
                  className="tk-card"
                  style={{
                    padding: '20px',
                    borderRadius: tokens.radius.xl,
                    background: tokens.colors.bg.secondary,
                    border: `1px solid ${tokens.colors.border.primary}`,
                    cursor: 'pointer',
                    minHeight: 110,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                  }}
                >
                  {/* Token Header — real logo via shared CryptoIcon (local SVG → CDN
                      → contrast-safe initials fallback), not a hardcoded brand-hex circle */}
                  <Box style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <CryptoIcon symbol={tk.token} size={40} />
                    <Box style={{ flex: 1, minWidth: 0 }}>
                      <Text size="md" weight="bold" style={{ color: tokens.colors.text.primary }}>
                        {tk.token}
                      </Text>
                      <Text size="xs" style={{ color: tokens.colors.text.tertiary }}>
                        {metrics
                          ? `${metrics.traderCount} ${metrics.traderCount === 1 ? t('tokenRankingsTradersSingular') : t('tokenRankingsTraders')}`
                          : t('tokenRankingsViewRankings')}
                      </Text>
                    </Box>
                  </Box>

                  {/* Stats — published measurements or an explicit unknown. */}
                  {metrics ? (
                    <Box
                      style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}
                    >
                      <Box>
                        <Text
                          size="xs"
                          style={{ color: tokens.colors.text.tertiary, marginBottom: 2 }}
                        >
                          {t('tokenRankingsTrades')}
                        </Text>
                        <Text
                          size="base"
                          weight="bold"
                          style={{ color: tokens.colors.text.primary }}
                        >
                          {metrics.tradeCount.toLocaleString('en-US')}
                        </Text>
                      </Box>
                      <Metric
                        value={metrics.totalPnl}
                        format="pnl"
                        size="md"
                        showArrow
                        label={t('tokenRankingsTotalPnl')}
                      />
                    </Box>
                  ) : (
                    <Text size="xs" style={{ color: tokens.colors.text.tertiary }}>
                      {t('unknown')}
                    </Text>
                  )}
                </Box>
              </Link>
            )
          })}
        </Box>
      ) : null}

      {snapshot &&
        (snapshot.sourceAsOf ? (
          <ProvenanceFooter
            provenance={{ source: 'arena', asOf: snapshot.sourceAsOf }}
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
    </Box>
  )
}
