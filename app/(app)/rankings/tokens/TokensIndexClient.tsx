'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Box, Text } from '@/app/components/base'
import PageHeader from '@/app/components/ui/PageHeader'
import CryptoIcon from '@/app/components/common/CryptoIcon'
import Metric from '@/app/components/ui/Metric'
import ErrorState from '@/app/components/ui/ErrorState'
import { tokens } from '@/lib/design-tokens'
import { formatPnL } from '@/lib/utils/format'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

export interface PopularToken {
  token: string
  trade_count: number
  trader_count: number
  total_pnl: number
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

function sortValue(tk: PopularToken, key: SortKey): number {
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
  initialTokens?: PopularToken[]
  initialStatus?: 'success' | 'error'
}

export default function TokensIndexClient({
  initialTokens,
  initialStatus = initialTokens === undefined ? 'error' : 'success',
}: TokensIndexClientProps = {}) {
  const { t } = useLanguage()
  const [popularTokens, setPopularTokens] = useState<PopularToken[]>(initialTokens || [])
  const [loadState, setLoadState] = useState<'loading' | 'success' | 'error'>(
    initialStatus === 'success' ? 'success' : 'loading'
  )
  const [hasSuccessfulData, setHasSuccessfulData] = useState(initialStatus === 'success')
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
      })
      if (!response.ok) throw new Error(`popular-tokens: ${response.status}`)
      const data: unknown = await response.json()
      if (
        typeof data !== 'object' ||
        data === null ||
        !Array.isArray((data as { tokens?: unknown }).tokens)
      ) {
        throw new Error('popular-tokens: invalid response')
      }
      if (requestRef.current !== controller || controller.signal.aborted) return

      setPopularTokens((data as { tokens: PopularToken[] }).tokens)
      setHasSuccessfulData(true)
      setLoadState('success')
    } catch (error) {
      if (requestRef.current !== controller) return
      if (controller.signal.aborted && !timedOut) return
      if (error instanceof Error && error.name === 'AbortError' && !timedOut) return
      setLoadState('error')
    } finally {
      clearTimeout(timeout)
    }
  }, [])

  useEffect(() => {
    // A successful empty SSR result is legitimate data and must not be retried
    // or relabelled as a transport failure. Only failed/timed-out SSR loads fall
    // through to the wire.
    if (initialStatus === 'success') return
    void loadPopularTokens()
    return () => requestRef.current?.abort()
  }, [initialStatus, loadPopularTokens])

  // Merge featured tokens with popular tokens (dedup by symbol).
  const allTokens = useMemo(() => {
    const tokenMap = new Map(popularTokens.map((tk) => [tk.token, tk]))
    const result: PopularToken[] = []

    for (const ft of FEATURED_TOKENS) {
      if (tokenMap.has(ft)) {
        result.push(tokenMap.get(ft)!)
        tokenMap.delete(ft)
      } else {
        result.push({ token: ft, trade_count: 0, trader_count: 0, total_pnl: 0 })
      }
    }
    for (const [, v] of tokenMap) result.push(v)
    return result
  }, [popularTokens])

  // Sort by the chosen metric (desc). Zero-activity tokens naturally fall to the
  // bottom for traders/trades, so they're never pinned above real data.
  const sorted = useMemo(() => {
    return [...allTokens].sort((a, b) => sortValue(b, sortKey) - sortValue(a, sortKey))
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
      <PageHeader title={t('tokenRankingsTitle')} subtitle={t('tokenRankingsSubtitle')} />

      {/* Controls: search + sort */}
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
            fontSize: 14,
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

      {loadState === 'error' && (
        <ErrorState
          title={t('failedToLoadRankings')}
          description={t('tryAgain')}
          retry={() => void loadPopularTokens()}
          variant={hasSuccessfulData ? 'compact' : 'default'}
        />
      )}

      {/* Token Grid */}
      {loadState === 'loading' && !hasSuccessfulData ? (
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
      ) : loadState !== 'error' || hasSuccessfulData ? (
        <Box
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 16,
          }}
        >
          {filtered.map((tk) => {
            const hasActivity = tk.trade_count > 0 || tk.trader_count > 0
            const ariaLabel = hasActivity
              ? `${tk.token} — ${tk.trader_count} ${tk.trader_count === 1 ? t('tokenRankingsTradersSingular') : t('tokenRankingsTraders')}, ${tk.trade_count} ${t('tokenRankingsTrades')}, ${t('tokenRankingsTotalPnl')} ${formatPnL(tk.total_pnl)}`
              : `${tk.token} — ${t('tokenRankingsNoActivity')}`
            return (
              <Link
                key={tk.token}
                href={`/rankings/tokens/${tk.token}`}
                className="tk-card-link"
                aria-label={ariaLabel}
                data-token={tk.token}
                data-trader-count={tk.trader_count}
                data-trade-count={tk.trade_count}
                data-total-pnl={tk.total_pnl}
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
                        {tk.trader_count > 0
                          ? `${tk.trader_count} ${tk.trader_count === 1 ? t('tokenRankingsTradersSingular') : t('tokenRankingsTraders')}`
                          : t('tokenRankingsViewRankings')}
                      </Text>
                    </Box>
                  </Box>

                  {/* Stats — real activity, or a clean "no activity yet" note */}
                  {hasActivity ? (
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
                          {tk.trade_count.toLocaleString('en-US')}
                        </Text>
                      </Box>
                      <Metric
                        value={tk.total_pnl}
                        format="pnl"
                        size="md"
                        showArrow
                        label={t('tokenRankingsTotalPnl')}
                      />
                    </Box>
                  ) : (
                    <Text size="xs" style={{ color: tokens.colors.text.tertiary }}>
                      {t('tokenRankingsNoActivity')}
                    </Text>
                  )}
                </Box>
              </Link>
            )
          })}
        </Box>
      ) : null}
    </Box>
  )
}
