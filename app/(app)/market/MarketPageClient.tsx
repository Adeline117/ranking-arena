'use client'

import { lazy, Suspense, useState, useCallback, useEffect, useMemo, memo } from 'react'
import Link from 'next/link'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
// MobileBottomNav is rendered by root layout — do not duplicate here
import { SectionErrorBoundary } from '@/app/components/utils/ErrorBoundary'
import ErrorBoundary from '@/app/components/utils/ErrorBoundary'
import { tokens } from '@/lib/design-tokens'
import PageHeader from '@/app/components/ui/PageHeader'
import { useMarketSpotData, type SpotCoin } from '@/lib/hooks/useMarketSpot'
import {
  isRenderableMarketSpotCoin,
  type MarketSpotCoin,
  type MarketSpotSnapshot,
} from '@/lib/market/market-spot-client-contract'

// Core above-fold components: direct import for faster LCP
import CoreCards from '@/app/components/market/CoreCards'
import GlobalMarketBar from '@/app/components/market/GlobalMarketBar'
import MarketSpotDataGate from '@/app/components/market/MarketSpotDataGate'
import MarketWatchlistEntry from '@/app/components/market/MarketWatchlistEntry'
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
  const [isMobile, setIsMobile] = useState<boolean | null>(null)

  const handleResize = useCallback(() => {
    setIsMobile(window.matchMedia?.('(max-width: 767px)').matches ?? window.innerWidth < 768)
  }, [])

  useEffect(() => {
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [handleResize])

  return isMobile
}

// Mobile-specific components
function MobileOverviewTab({ spotData }: { spotData?: MarketSpotCoin[] }) {
  return (
    <SectionErrorBoundary fallbackMessage="Failed to load core metrics">
      <Suspense fallback={<LoadingCard height={200} />}>
        <CoreCards spotData={spotData} />
      </Suspense>
    </SectionErrorBoundary>
  )
}

function MobileMoversTab({ spotData }: { spotData?: SpotCoin[] }) {
  return (
    <SectionErrorBoundary fallbackMessage="Market data failed to load">
      <Suspense fallback={<LoadingCard height={300} />}>
        <SpotMarket spotData={spotData} />
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

function MobileSectorsTab({ spotData }: { spotData?: SpotCoin[] }) {
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

  if (sectors.length === 0)
    return (
      <div
        style={{
          height: 160,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: tokens.colors.text.tertiary,
          fontSize: tokens.typography.fontSize.base,
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
            }}
          >
            <div
              style={{
                fontSize: tokens.typography.fontSize.xs,
                fontWeight: tokens.typography.fontWeight.semibold,
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
                  fontSize: tokens.typography.fontSize.lg,
                  fontWeight: tokens.typography.fontWeight.black,
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

function MarketPageContent({
  initialSpotSnapshot,
  initialError,
}: {
  initialSpotSnapshot?: MarketSpotSnapshot
  initialError: boolean
}) {
  const { t } = useLanguage()
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

  // One strictly verified /api/market/spot lane is shared by every spot panel.
  // The SSR seed carries the provider collection receipt, so cached data is not
  // relabeled as freshly fetched during hydration.
  const {
    data: spotSnapshot,
    isLoading: spotLoading,
    error: spotRequestError,
    refetch: refetchSpot,
  } = useMarketSpotData(initialSpotSnapshot)
  const allSpotData = spotSnapshot?.coins
  const renderableSpotData = useMemo(
    () => allSpotData?.filter(isRenderableMarketSpotCoin),
    [allSpotData]
  )
  // Existing table/treemap props predate nullable provider metrics. Their
  // formatters already render null as "--"; keep nulls truthful at runtime.
  const spotData = renderableSpotData as SpotCoin[] | undefined
  const sectorSpotData = useMemo(
    () =>
      renderableSpotData?.filter((coin) => coin.marketCap !== null && coin.volume24h !== null) as
        | SpotCoin[]
        | undefined,
    [renderableSpotData]
  )
  const hasUsableSpotData = !!spotData?.length
  const spotPending = spotLoading && !hasUsableSpotData
  const spotFailed =
    !hasUsableSpotData &&
    (!!spotRequestError || (!!spotSnapshot && spotSnapshot.completeCount === 0))
  const sectorSpotFailed = spotFailed || (!!spotSnapshot && !sectorSpotData?.length)
  const spotDegraded =
    !!spotSnapshot?.partial ||
    (!!spotRequestError && hasUsableSpotData) ||
    (initialError && !spotSnapshot)

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
      className="market-page"
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
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Link
                href="/market/funding-rates"
                style={{
                  fontSize: tokens.typography.fontSize.sm,
                  color: tokens.colors.text.secondary,
                  textDecoration: 'none',
                  padding: '8px 12px',
                  borderRadius: tokens.radius.sm,
                  background: tokens.colors.bg.secondary,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  minWidth: 44,
                  minHeight: 44,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {t('fundingRates')}
              </Link>
              <Link
                href="/market/open-interest"
                style={{
                  fontSize: tokens.typography.fontSize.sm,
                  color: tokens.colors.text.secondary,
                  textDecoration: 'none',
                  padding: '8px 12px',
                  borderRadius: tokens.radius.sm,
                  background: tokens.colors.bg.secondary,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  minWidth: 44,
                  minHeight: 44,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
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

      {spotDegraded && (
        <div
          role="alert"
          data-testid="market-spot-degraded"
          style={{
            maxWidth: 1400,
            minHeight: 44,
            margin: `${tokens.spacing[3]} auto 0`,
            padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
            border: `1px solid ${tokens.colors.accent.warning}`,
            borderRadius: tokens.radius.md,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: tokens.spacing[3],
            color: tokens.colors.text.secondary,
            fontSize: tokens.typography.fontSize.sm,
          }}
        >
          <span>
            {spotSnapshot?.partial
              ? t('dataLoadIncomplete')
              : hasUsableSpotData
                ? t('dataStaleWarning')
                : t('marketDataError')}
            {spotSnapshot?.partial && spotRequestError ? ` · ${t('dataStaleWarning')}` : null}
          </span>
          <button
            type="button"
            onClick={() => void refetchSpot()}
            style={{
              minWidth: 44,
              minHeight: 44,
              padding: `0 ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: tokens.glass.border.light,
              background: tokens.colors.bg.tertiary,
              color: tokens.colors.text.primary,
              cursor: 'pointer',
              fontWeight: tokens.typography.fontWeight.semibold,
            }}
          >
            {t('retry')}
          </button>
        </div>
      )}

      {isMobile === null ? (
        <div
          data-testid="market-layout-resolving"
          aria-busy="true"
          style={{
            maxWidth: 1400,
            minHeight: '70vh',
            margin: '0 auto',
            padding: '20px 24px 40px',
          }}
        >
          <div className="market-layout-skeleton-grid">
            <LoadingCard height={220} />
            <LoadingCard height={284} />
            <LoadingCard height={400} />
          </div>
        </div>
      ) : isMobile ? (
        /* Mobile: Tab Layout */
        <Suspense fallback={<LoadingCard height={400} />}>
          <MobileMarketTabs>
            {{
              overview: <MobileOverviewTab spotData={allSpotData} />,
              movers: (
                <MarketSpotDataGate
                  pending={spotPending}
                  failed={spotFailed}
                  retry={() => void refetchSpot()}
                  height={300}
                >
                  <MobileMoversTab spotData={spotData} />
                </MarketSpotDataGate>
              ),
              sectors: (
                <MarketSpotDataGate
                  pending={spotPending}
                  failed={sectorSpotFailed}
                  retry={() => void refetchSpot()}
                  height={200}
                >
                  <MobileSectorsTab spotData={sectorSpotData} />
                </MarketSpotDataGate>
              ),
              watchlist: <MarketWatchlistEntry />,
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
                <CoreCards spotData={allSpotData} />
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
                <MarketSpotDataGate
                  pending={spotPending}
                  failed={spotFailed}
                  retry={() => void refetchSpot()}
                  height={400}
                >
                  <SpotMarket
                    spotData={spotData}
                    onTokenClick={handleTokenClick}
                    sectorFilter={sectorFilter}
                  />
                </MarketSpotDataGate>
              </Suspense>
            </SectionErrorBoundary>
            <div>
              <SectionErrorBoundary fallbackMessage="Failed to load sector heatmap">
                <Suspense fallback={<LoadingCard height={300} />}>
                  <MarketSpotDataGate
                    pending={spotPending}
                    failed={sectorSpotFailed}
                    retry={() => void refetchSpot()}
                    height={300}
                  >
                    <SectorTreemap spotData={sectorSpotData} onSectorClick={handleSectorClick} />
                  </MarketSpotDataGate>
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
                    fontSize: tokens.typography.fontSize.xs,
                    color: tokens.colors.text.secondary,
                  }}
                >
                  {t('filter')}: {sectorFilter}
                  <button
                    type="button"
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
                      fontSize: tokens.typography.fontSize.base,
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

      <style>{`
        .market-page button,
        .market-page input,
        .market-page select {
          min-width: 44px;
          min-height: 44px;
        }
        .market-page a {
          min-width: 44px;
          min-height: 44px;
        }
        .market-page tr {
          height: 44px;
        }
        .market-page th[tabindex="0"] {
          height: 44px;
        }
        .market-layout-skeleton-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 24px;
        }
        @media (min-width: 768px) {
          .market-layout-skeleton-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
          }
          .market-layout-skeleton-grid > :last-child {
            grid-column: 1 / -1;
          }
        }
      `}</style>
    </div>
  )
}

export default function MarketPage({
  initialSpotSnapshot,
  initialError = false,
}: {
  initialSpotSnapshot?: MarketSpotSnapshot
  initialError?: boolean
}) {
  return (
    <ErrorBoundary
      pageType="market"
      onError={() => {
        // Market page error handled by ErrorBoundary
      }}
    >
      <MarketPageContent initialSpotSnapshot={initialSpotSnapshot} initialError={initialError} />
    </ErrorBoundary>
  )
}
