'use client'

import { lazy, Suspense, useState, useCallback, useEffect } from 'react'
import TopNav from '@/app/components/layout/TopNav'
import FloatingActionButton from '@/app/components/layout/FloatingActionButton'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import { SectionErrorBoundary } from '@/app/components/utils/ErrorBoundary'
import { tokens } from '@/lib/design-tokens'
import { supabase } from '@/lib/supabase/client'

const SentimentBar = lazy(() => import('@/app/components/market/SentimentBar'))
const CoreCards = lazy(() => import('@/app/components/market/CoreCards'))
const SectorTreemap = lazy(() => import('@/app/components/market/SectorTreemap'))
const SpotMarket = lazy(() => import('@/app/components/market/SpotMarket'))
const TokenSidePanel = lazy(() => import('@/app/components/market/TokenSidePanel'))
const MobileMarketTabs = lazy(() => import('@/app/components/market/MobileMarketTabs'))
const FearGreedGauge = lazy(() => import('@/app/components/market/FearGreedGauge'))
const ArbitrageOpportunities = lazy(() => import('@/app/components/market/ArbitrageOpportunities'))
const LiveTradesFeed = lazy(() => import('@/app/components/market/LiveTradesFeed'))

function LoadingCard({ height = 64 }: { height?: number }) {
  return <div className="skeleton" style={{ height, borderRadius: 8 }} />
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  return isMobile
}

// Mobile-specific components
function MobileOverviewTab() {
  return (
    <SectionErrorBoundary fallbackMessage="核心指标加载失败">
      <Suspense fallback={<LoadingCard height={200} />}>
        <CoreCards />
      </Suspense>
    </SectionErrorBoundary>
  )
}

function MobileMoversTab() {
  return (
    <SectionErrorBoundary fallbackMessage="行情数据加载失败">
      <Suspense fallback={<LoadingCard height={300} />}>
        <SpotMarket />
      </Suspense>
    </SectionErrorBoundary>
  )
}

function MobileSectorsTab() {
  // On mobile: simple card layout instead of treemap
  const SECTORS = [
    { name: 'DeFi', change: '+3.2%', color: tokens.colors.accent.success },
    { name: 'L1', change: '+1.8%', color: tokens.colors.accent.success },
    { name: 'L2', change: '-0.5%', color: tokens.colors.accent.error },
    { name: 'Meme', change: '+8.1%', color: tokens.colors.accent.success },
    { name: 'AI', change: '+5.2%', color: tokens.colors.accent.success },
    { name: 'GameFi', change: '-1.3%', color: tokens.colors.accent.error },
    { name: 'NFT', change: '-2.8%', color: tokens.colors.accent.error },
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, padding: '0 12px' }}>
      {SECTORS.map(s => (
        <div key={s.name} style={{
          padding: 16,
          background: tokens.glass.bg.secondary,
          borderRadius: tokens.radius.lg,
          border: tokens.glass.border.light,
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: tokens.colors.text.primary, marginBottom: 4 }}>
            {s.name}
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: s.color }}>
            {s.change}
          </div>
        </div>
      ))}
    </div>
  )
}

function WatchlistPlaceholder() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: 200,
      color: tokens.colors.text.tertiary,
      fontSize: 14,
      gap: 8,
    }}>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.5 }}>
        <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26" />
      </svg>
      <span>自选列表即将推出</span>
    </div>
  )
}

export default function MarketPage() {
  const [email, setEmail] = useState<string | null>(null)
  const [selectedToken, setSelectedToken] = useState<{ id: string; symbol: string; name: string; image: string; price: number; change24h: number; marketCap: number; volume24h: number; high24h: number; low24h: number; rank: number } | null>(null)
  const [sectorFilter, setSectorFilter] = useState<string | null>(null)
  const isMobile = useIsMobile()

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null))
  }, [])

  const handleSectorClick = useCallback((category: string) => {
    setSectorFilter(prev => prev === category ? null : category)
  }, [])

  const handleTokenClick = useCallback((token: { id: string; symbol: string; name: string; image: string; price: number; change24h: number; marketCap: number; volume24h: number; high24h: number; low24h: number; rank: number }) => {
    if (!isMobile) setSelectedToken(token)
  }, [isMobile])

  const handleClosePanel = useCallback(() => {
    setSelectedToken(null)
  }, [])

  return (
    <div style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />

      {/* L0: Sentiment Bar */}
      <SectionErrorBoundary fallbackMessage="情绪指标加载失败">
        <Suspense fallback={<div style={{ height: 48 }} />}>
          <SentimentBar />
        </Suspense>
      </SectionErrorBoundary>

      {isMobile ? (
        /* Mobile: Tab Layout */
        <Suspense fallback={<LoadingCard height={400} />}>
          <MobileMarketTabs>
            {{
              overview: <MobileOverviewTab />,
              movers: <MobileMoversTab />,
              sectors: <MobileSectorsTab />,
              watchlist: <WatchlistPlaceholder />,
            }}
          </MobileMarketTabs>
        </Suspense>
      ) : (
        /* Desktop: Full-width 4-layer layout */
        <div style={{
          maxWidth: 1400,
          margin: '0 auto',
          padding: '20px 24px 40px',
        }}>
          {/* L1: Core Cards */}
          <section style={{ marginBottom: 24 }}>
            <SectionErrorBoundary fallbackMessage="核心指标加载失败">
              <Suspense fallback={<LoadingCard height={200} />}>
                <CoreCards />
              </Suspense>
            </SectionErrorBoundary>
          </section>

          {/* Widgets row: Fear&Greed + Arbitrage + Live Trades */}
          <section style={{ marginBottom: 24, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
            <SectionErrorBoundary fallbackMessage="恐惧贪婪指数加载失败">
              <Suspense fallback={<LoadingCard height={200} />}>
                <FearGreedGauge />
              </Suspense>
            </SectionErrorBoundary>
            <SectionErrorBoundary fallbackMessage="套利机会加载失败">
              <Suspense fallback={<LoadingCard height={200} />}>
                <ArbitrageOpportunities />
              </Suspense>
            </SectionErrorBoundary>
            <SectionErrorBoundary fallbackMessage="实时成交加载失败">
              <Suspense fallback={<LoadingCard height={200} />}>
                <LiveTradesFeed />
              </Suspense>
            </SectionErrorBoundary>
          </section>

          {/* L2: Sector Treemap */}
          <section style={{ marginBottom: 24 }}>
            <SectionErrorBoundary fallbackMessage="板块热力图加载失败">
              <Suspense fallback={<LoadingCard height={300} />}>
                <SectorTreemap onSectorClick={handleSectorClick} />
              </Suspense>
            </SectionErrorBoundary>
            {sectorFilter && (
              <div style={{
                marginTop: 8,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 12px',
                background: tokens.colors.bg.tertiary,
                borderRadius: tokens.radius.md,
                fontSize: 12,
                color: tokens.colors.text.secondary,
              }}>
                筛选: {sectorFilter}
                <button
                  onClick={() => setSectorFilter(null)}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    color: tokens.colors.text.tertiary,
                    fontSize: 14,
                    lineHeight: 1,
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}
          </section>

          {/* L3: Data Table */}
          <section>
            <SectionErrorBoundary fallbackMessage="行情数据加载失败">
              <Suspense fallback={<LoadingCard height={400} />}>
                <SpotMarket onTokenClick={handleTokenClick} />
              </Suspense>
            </SectionErrorBoundary>
          </section>
        </div>
      )}

      {/* Desktop Side Panel */}
      {!isMobile && (
        <Suspense fallback={null}>
          <TokenSidePanel token={selectedToken} onClose={handleClosePanel} />
        </Suspense>
      )}

      <FloatingActionButton />
      <MobileBottomNav />
    </div>
  )
}
