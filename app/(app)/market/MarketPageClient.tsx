'use client'

import { lazy, Suspense, useState, useCallback, useEffect, useMemo, memo } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
// MobileBottomNav is rendered by root layout — do not duplicate here
import { SectionErrorBoundary } from '@/app/components/utils/ErrorBoundary'
import ErrorBoundary from '@/app/components/utils/ErrorBoundary'
import { tokens } from '@/lib/design-tokens'
import PageHeader from '@/app/components/ui/PageHeader'
import Metric from '@/app/components/ui/Metric'
import LoadingSkeleton from '@/app/components/ui/LoadingSkeleton'
import ErrorState from '@/app/components/ui/ErrorState'
import { supabase } from '@/lib/supabase/client'
import { STALE_STANDARD } from '@/lib/hooks/cache-presets'
import { NULL_DISPLAY } from '@/lib/utils/format'
import { useMarketSpotData, type SpotCoin } from '@/lib/hooks/useMarketSpot'

// Core above-fold components: direct import for faster LCP
import CoreCards from '@/app/components/market/CoreCards'
import PriceTicker from '@/app/components/market/PriceTicker'
import FearGreedGauge from '@/app/components/market/FearGreedGauge'

// Below-fold components: lazy-loaded
const SectorTreemap = lazy(() => import('@/app/components/market/SectorTreemap'))
const SpotMarket = lazy(() => import('@/app/components/market/SpotMarket'))
const TokenSidePanel = lazy(() => import('@/app/components/market/TokenSidePanel'))
const MobileMarketTabs = lazy(() => import('@/app/components/market/MobileMarketTabs'))
const ArbitrageOpportunities = lazy(() => import('@/app/components/market/ArbitrageOpportunities'))
const LiveTradesFeed = lazy(() => import('@/app/components/market/LiveTradesFeed'))

const LoadingCard = memo(function LoadingCard({
  height = 64,
  lines,
}: {
  height?: number
  lines?: number
}) {
  const skeletonItems = useMemo(() => {
    if (!lines) return null
    return Array.from({ length: lines }).map((_, i) => (
      <div
        key={i}
        className="skeleton"
        style={{
          height: 14,
          borderRadius: tokens.radius.sm,
          width: i === 0 ? '60%' : i === lines - 1 ? '40%' : '90%',
        }}
      />
    ))
  }, [lines])

  if (lines) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '16px 20px' }}>
        {skeletonItems}
      </div>
    )
  }
  return <div className="skeleton" style={{ height, borderRadius: tokens.radius.md }} />
})

const useIsMobile = () => {
  const [isMobile, setIsMobile] = useState(false)

  const handleResize = useCallback(() => {
    setIsMobile(window.innerWidth < 768)
  }, [])

  useEffect(() => {
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [handleResize])

  return isMobile
}

/**
 * Global market-state bar — surfaces the site-wide aggregates from
 * /api/market/overview (CoinGecko global + Etherscan gas). Only metrics that
 * actually have a data source are shown; when a fallback source (Coinbase /
 * Binance) can't provide market cap / dominance the endpoint returns 0 and we
 * hide those cells rather than render a fake zero.
 */
interface MarketOverview {
  btcPrice: number
  btcChange24h: number
  ethPrice: number
  ethChange24h: number
  totalMarketCap: number
  totalVolume24h: number
  btcDominance: number
  ethGasGwei: number | null
  updatedAt: string
}

/** USD compact including trillions (formatCompact tops out at B). */
function compactUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return NULL_DISPLAY
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  return `$${Math.round(n).toLocaleString('en-US')}`
}

/**
 * Ticking "Xs / Xm / Xh" since an ISO timestamp; pauses when tab is hidden.
 * Returns the label plus raw age in seconds (-1 if timestamp unusable) so
 * callers can flag stale/delayed data.
 */
function useUpdatedAgo(iso?: string): { label: string; ageSec: number } {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'hidden') return
      setNow(Date.now())
    }, 10_000)
    return () => clearInterval(id)
  }, [])
  if (!iso) return { label: '', ageSec: -1 }
  const ts = new Date(iso).getTime()
  if (!Number.isFinite(ts)) return { label: '', ageSec: -1 }
  const s = Math.max(0, Math.floor((now - ts) / 1000))
  const label = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`
  return { label, ageSec: s }
}

function GlobalMarketBar() {
  const { t } = useLanguage()
  const { data } = useQuery<MarketOverview>({
    queryKey: ['market-overview-bar'],
    queryFn: async () => {
      const res = await fetch('/api/market/overview')
      if (!res.ok) throw new Error(`overview: ${res.status}`)
      return res.json()
    },
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: STALE_STANDARD,
    refetchOnWindowFocus: false,
  })
  const { label: ago, ageSec } = useUpdatedAgo(data?.updatedAt)
  // Data older than 10min is no longer "live" — the upstream refresh window has
  // a gap. Drop the green pulse to a static gray dot + a "delayed" hint so the
  // "live" affordance isn't misleading.
  const isStale = ageSec > 600

  const stats: { label: string; value: number; display: string }[] = []
  if (data) {
    if (data.totalMarketCap > 0)
      stats.push({
        label: t('marketCap'),
        value: data.totalMarketCap,
        display: compactUsd(data.totalMarketCap),
      })
    if (data.totalVolume24h > 0)
      stats.push({
        label: t('volume24h'),
        value: data.totalVolume24h,
        display: compactUsd(data.totalVolume24h),
      })
    if (data.btcDominance > 0)
      stats.push({
        label: t('btcDominance'),
        value: data.btcDominance,
        display: `${data.btcDominance.toFixed(1)}%`,
      })
    if (data.ethGasGwei != null)
      stats.push({
        label: t('ethGas'),
        value: data.ethGasGwei,
        display: `${data.ethGasGwei} Gwei`,
      })
  }

  return (
    <div
      style={{
        maxWidth: 1400,
        margin: '0 auto',
        padding: `${tokens.spacing[2]} ${tokens.spacing[5]} 0`,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: tokens.spacing[5],
          padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
          background: tokens.glass.bg.light,
          border: tokens.glass.border.light,
          borderRadius: tokens.radius.lg,
        }}
      >
        {stats.length === 0 ? (
          <div
            className="skeleton"
            style={{ height: 36, flex: 1, minWidth: 200, borderRadius: tokens.radius.md }}
          />
        ) : (
          stats.map((s) => (
            <Metric
              key={s.label}
              value={s.value}
              display={s.display}
              label={s.label}
              size="md"
              colorBySign={false}
            />
          ))
        )}
        <div
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            // eslint-disable-next-line no-restricted-syntax -- off-scale micro label by design
            fontSize: 11,
            color: tokens.colors.text.tertiary,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: isStale ? tokens.colors.text.tertiary : tokens.colors.accent.success,
              display: 'inline-block',
              animation: isStale ? undefined : 'pulse 2s infinite',
            }}
          />
          <span suppressHydrationWarning>
            {ago ? `${t('updatedAgo')}${ago}` : `${t('liveData')} · ${t('autoRefresh')}`}
            {isStale ? ` · ${t('u7mkt_delayed')}` : ''}
          </span>
        </div>
      </div>
    </div>
  )
}

// Mobile-specific components
function MobileOverviewTab({ spotData }: { spotData?: SpotCoin[] }) {
  return (
    <SectionErrorBoundary fallbackMessage="Failed to load core metrics">
      <Suspense fallback={<LoadingCard height={200} />}>
        <CoreCards spotData={spotData} />
      </Suspense>
    </SectionErrorBoundary>
  )
}

function MobileMoversTab({
  spotData,
  initialSpotData,
}: {
  spotData?: SpotCoin[]
  initialSpotData?: SpotCoinSSR[]
}) {
  return (
    <SectionErrorBoundary fallbackMessage="Market data failed to load">
      <Suspense fallback={<LoadingCard height={300} />}>
        <SpotMarket spotData={spotData} initialData={initialSpotData} />
      </Suspense>
    </SectionErrorBoundary>
  )
}

const MOBILE_SECTOR_CATEGORY_MAP: Record<string, string> = {
  BTC: 'L1',
  ETH: 'L1',
  SOL: 'L1',
  BNB: 'L1',
  ADA: 'L1',
  AVAX: 'L1',
  DOT: 'L1',
  NEAR: 'L1',
  ATOM: 'L1',
  SUI: 'L1',
  APT: 'L1',
  TRX: 'L1',
  TON: 'L1',
  XRP: 'L1',
  LINK: 'DeFi',
  UNI: 'DeFi',
  AAVE: 'DeFi',
  MKR: 'DeFi',
  CRV: 'DeFi',
  SNX: 'DeFi',
  ARB: 'L2',
  OP: 'L2',
  MATIC: 'L2',
  STRK: 'L2',
  IMX: 'L2',
  DOGE: 'Meme',
  SHIB: 'Meme',
  PEPE: 'Meme',
  WIF: 'Meme',
  FLOKI: 'Meme',
  BONK: 'Meme',
  RNDR: 'AI',
  FET: 'AI',
  TAO: 'AI',
  WLD: 'AI',
  AXS: 'GameFi',
  GALA: 'GameFi',
  SAND: 'GameFi',
  MANA: 'GameFi',
}

function MobileSectorsTab({
  spotData,
  spotLoading,
}: {
  spotData?: SpotCoin[]
  spotLoading: boolean
}) {
  const { t } = useLanguage()

  const sectors = useMemo(() => {
    if (!spotData || spotData.length === 0) return []
    const grouped: Record<string, { totalCap: number; weightedChange: number }> = {}
    for (const c of spotData) {
      const cat = MOBILE_SECTOR_CATEGORY_MAP[c.symbol]
      if (!cat || c.change24h == null || c.marketCap <= 0) continue
      if (!grouped[cat]) grouped[cat] = { totalCap: 0, weightedChange: 0 }
      grouped[cat].totalCap += c.marketCap
      grouped[cat].weightedChange += c.change24h * c.marketCap
    }
    return Object.entries(grouped)
      .map(([name, v]) => ({ name, change: v.weightedChange / v.totalCap }))
      .sort((a, b) => b.change - a.change)
  }, [spotData])

  if (spotLoading) return <LoadingSkeleton variant="list" count={4} />
  if (!spotData) return <ErrorState title={t('loadFailed')} variant="compact" />
  if (sectors.length === 0)
    return (
      <div
        style={{
          height: 160,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: tokens.colors.text.tertiary,
          fontSize: 14,
        }}
      >
        {t('noData')}
      </div>
    )

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 1fr)',
        gap: 10,
        padding: '4px 16px',
      }}
    >
      {sectors.map((s) => {
        const color = s.change >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
        return (
          <div
            key={s.name}
            className="card-hover"
            style={{
              padding: '14px 16px',
              background: tokens.glass.bg.secondary,
              borderRadius: tokens.radius.lg,
              border: tokens.glass.border.light,
              borderLeft: `3px solid ${color}`,
              cursor: 'pointer',
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: tokens.colors.text.tertiary,
                marginBottom: 6,
                letterSpacing: '0.3px',
                textTransform: 'uppercase',
              }}
            >
              {s.name}
            </div>
            <div
              style={
                {
                  fontSize: 18,
                  fontWeight: 800,
                  color,
                  fontFamily: 'var(--font-mono, monospace)',
                  fontVariantNumeric: 'tabular-nums',
                  letterSpacing: '-0.5px',
                } as React.CSSProperties
              }
            >
              {/* Arrow = colorblind-safe redundant cue alongside the sign color */}
              <span aria-hidden="true" style={{ marginRight: '0.25em', fontSize: '0.8em' }}>
                {s.change >= 0 ? '▲' : '▼'}
              </span>
              {s.change >= 0 ? '+' : ''}
              {s.change.toFixed(2)}%
            </div>
          </div>
        )
      })}
    </div>
  )
}

function WatchlistPlaceholder() {
  const { t } = useLanguage()
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: 200,
        color: tokens.colors.text.tertiary,
        fontSize: 14,
        gap: 8,
      }}
    >
      <svg
        width="32"
        height="32"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        style={{ opacity: 0.5 }}
      >
        <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" />
      </svg>
      <span>{t('watchlistComingSoon')}</span>
    </div>
  )
}

function MarketPageContent({
  initialSpotData,
  initialSpotDataUpdatedAt,
}: {
  initialSpotData?: SpotCoinSSR[]
  initialSpotDataUpdatedAt?: number
}) {
  const { t } = useLanguage()
  const [email, setEmail] = useState<string | null>(null)
  const [selectedToken, setSelectedToken] = useState<{
    id: string
    symbol: string
    name: string
    image: string
    price: number
    change24h: number
    marketCap: number
    volume24h: number
    high24h: number
    low24h: number
    rank: number
  } | null>(null)
  const [sectorFilter, setSectorFilter] = useState<string | null>(null)
  const isMobile = useIsMobile()

  // Single shared fetch for /api/market/spot — data passed as props to all children.
  // Seed with the SSR-delivered spot data so the hook doesn't refetch the same
  // ~33KB/100-coin payload on mount (it was already in the document).
  const { data: spotData, isLoading: spotLoading } = useMarketSpotData(
    initialSpotData,
    initialSpotDataUpdatedAt
  )

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null))
  }, [])

  const handleSectorClick = useCallback((category: string) => {
    setSectorFilter((prev) => (prev === category ? null : category))
  }, [])

  const handleTokenClick = useCallback(
    (token: {
      id: string
      symbol: string
      name: string
      image: string
      price: number
      change24h: number
      marketCap: number
      volume24h: number
      high24h: number
      low24h: number
      rank: number
    }) => {
      setSelectedToken(token)
    },
    []
  )

  const handleClosePanel = useCallback(() => {
    setSelectedToken(null)
  }, [])

  return (
    <div
      style={{
        minHeight: '100vh',
        background: tokens.colors.bg.primary,
        color: tokens.colors.text.primary,
        overflowX: 'hidden',
      }}
    >
      {/* Compact page header — gives the page identity without pushing the
          dense market data down; the sub-page links live in the actions slot. */}
      <div
        style={{
          maxWidth: 1400,
          margin: '0 auto',
          padding: `${tokens.spacing[2]} ${tokens.spacing[6]} 0`,
        }}
      >
        <PageHeader
          title={t('market')}
          compact
          actions={
            <div style={{ display: 'flex', gap: 8 }}>
              <Link
                href="/market/funding-rates"
                style={{
                  fontSize: 13,
                  color: tokens.colors.text.secondary,
                  textDecoration: 'none',
                  padding: '4px 10px',
                  borderRadius: tokens.radius.sm,
                  background: tokens.colors.bg.secondary,
                  fontWeight: 600,
                }}
              >
                {t('fundingRates')}
              </Link>
              <Link
                href="/market/open-interest"
                style={{
                  fontSize: 13,
                  color: tokens.colors.text.secondary,
                  textDecoration: 'none',
                  padding: '4px 10px',
                  borderRadius: tokens.radius.sm,
                  background: tokens.colors.bg.secondary,
                  fontWeight: 600,
                }}
              >
                {t('openInterest')}
              </Link>
            </div>
          }
        />
      </div>

      {/* L0: Scrolling Price Ticker */}
      <SectionErrorBoundary fallbackMessage="Failed to load price ticker">
        <Suspense fallback={<div style={{ height: 48 }} />}>
          <PriceTicker />
        </Suspense>
      </SectionErrorBoundary>

      {/* Global market-state bar — total cap / 24h vol / BTC.D / gas + real
          "updated Xs ago". Renders above the mobile/desktop split so it shows
          on every viewport. */}
      <SectionErrorBoundary fallbackMessage="Failed to load market overview">
        <GlobalMarketBar />
      </SectionErrorBoundary>

      {isMobile ? (
        /* Mobile: Tab Layout */
        <Suspense fallback={<LoadingCard height={400} />}>
          <MobileMarketTabs>
            {{
              overview: <MobileOverviewTab spotData={spotData} />,
              movers: <MobileMoversTab spotData={spotData} initialSpotData={initialSpotData} />,
              sectors: <MobileSectorsTab spotData={spotData} spotLoading={spotLoading} />,
              watchlist: <WatchlistPlaceholder />,
            }}
          </MobileMarketTabs>
        </Suspense>
      ) : (
        /* Desktop: Full-width 4-layer layout */
        <div
          style={{
            maxWidth: 1400,
            margin: '0 auto',
            padding: '20px 24px 40px',
          }}
        >
          {/* L1: Core Cards */}
          <section style={{ marginBottom: 24 }}>
            <SectionErrorBoundary fallbackMessage="Failed to load core metrics">
              <Suspense fallback={<LoadingCard height={160} />}>
                <CoreCards spotData={spotData} />
              </Suspense>
            </SectionErrorBoundary>
          </section>

          {/* Fear & Greed + Arbitrage + Live Trades — 3-column widget row */}
          <section
            style={{
              marginBottom: 24,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: tokens.spacing[4],
              overflowX: 'hidden',
            }}
          >
            {/* minHeight (not fixed height) keeps the row visually aligned
                while letting taller content grow instead of being clipped. */}
            <div style={{ minHeight: 284 }}>
              <SectionErrorBoundary fallbackMessage="Failed to load Fear &amp; Greed index">
                <Suspense fallback={<LoadingCard height={160} />}>
                  <FearGreedGauge />
                </Suspense>
              </SectionErrorBoundary>
            </div>
            <div style={{ minHeight: 284 }}>
              <SectionErrorBoundary fallbackMessage="Failed to load arbitrage">
                <Suspense fallback={<LoadingCard height={160} />}>
                  <ArbitrageOpportunities />
                </Suspense>
              </SectionErrorBoundary>
            </div>
            <div style={{ minHeight: 284 }}>
              <SectionErrorBoundary fallbackMessage="Failed to load live trades">
                <Suspense fallback={<LoadingCard height={160} />}>
                  <LiveTradesFeed />
                </Suspense>
              </SectionErrorBoundary>
            </div>
          </section>

          {/* L2: Data Table + Sector Heatmap — side by side */}
          <section
            style={{
              marginBottom: 24,
              display: 'grid',
              gridTemplateColumns: '2fr 1fr',
              gap: tokens.spacing[4],
              alignItems: 'start',
            }}
          >
            <SectionErrorBoundary fallbackMessage="Market data failed to load">
              <Suspense fallback={<LoadingCard height={400} />}>
                <SpotMarket
                  spotData={spotData}
                  onTokenClick={handleTokenClick}
                  sectorFilter={sectorFilter}
                  initialData={initialSpotData}
                />
              </Suspense>
            </SectionErrorBoundary>
            <div>
              <SectionErrorBoundary fallbackMessage="Failed to load sector heatmap">
                <Suspense fallback={<LoadingCard height={300} />}>
                  <SectorTreemap spotData={spotData} onSectorClick={handleSectorClick} />
                </Suspense>
              </SectionErrorBoundary>
              {sectorFilter && (
                <div
                  style={{
                    marginTop: 8,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '4px 12px',
                    background: tokens.colors.bg.tertiary,
                    borderRadius: tokens.radius.md,
                    fontSize: 12,
                    color: tokens.colors.text.secondary,
                  }}
                >
                  {t('filter')}: {sectorFilter}
                  <button
                    onClick={() => setSectorFilter(null)}
                    aria-label="Clear filter"
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      width: 44,
                      height: 44,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: tokens.colors.text.tertiary,
                      fontSize: 14,
                      lineHeight: 1.2,
                      margin: '-14px -16px -14px 0',
                    }}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {/* Token Detail Modal */}
      <Suspense fallback={null}>
        <TokenSidePanel token={selectedToken} onClose={handleClosePanel} />
      </Suspense>

      <FloatingActionButton />
    </div>
  )
}

export interface SpotCoinSSR {
  id: string
  symbol: string
  name: string
  image: string
  price: number
  change24h: number
  high24h: number
  low24h: number
  volume24h: number
  marketCap: number
  rank: number
}

export default function MarketPage({
  initialSpotData,
  initialSpotDataUpdatedAt,
  initialError,
}: {
  initialSpotData?: SpotCoinSSR[]
  initialSpotDataUpdatedAt?: number
  initialError?: boolean
}) {
  return (
    <ErrorBoundary
      pageType="market"
      onError={() => {
        // Market page error handled by ErrorBoundary
      }}
    >
      {initialError && (!initialSpotData || initialSpotData.length === 0) ? (
        <div style={{ padding: '48px 16px', textAlign: 'center' }}>
          <ErrorState
            title="Market data temporarily unavailable"
            description="We couldn't load market prices. Please try again in a moment."
            retry={() => window.location.reload()}
          />
        </div>
      ) : (
        <MarketPageContent
          initialSpotData={initialSpotData}
          initialSpotDataUpdatedAt={initialSpotDataUpdatedAt}
        />
      )}
    </ErrorBoundary>
  )
}
