'use client'

/**
 * Rankings V2 Page
 * Uses /api/rankings endpoint with URL query params for window switching.
 * Pure DB read, fast rendering, stale indicators.
 */

import { Suspense, useState, useRef, useEffect } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useRankingsV2 } from '@/lib/hooks/useRankingsV2'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import DataStateWrapper from '@/app/components/ui/DataStateWrapper'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { Box } from '@/app/components/base'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { formatROI, formatPnL } from '@/app/components/ranking/utils'
import type { SnapshotWindow, RankedTraderV2, Platform } from '@/lib/types/trading-platform'
import { EXCHANGE_NAMES, SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'

const WINDOWS: SnapshotWindow[] = ['7D', '30D', '90D']

// Category presets for quick filtering
type CategoryPreset = 'all' | 'cex_futures' | 'cex_spot' | 'onchain_dex'

const CATEGORY_LABELS: Record<CategoryPreset, { zh: string; en: string }> = {
  all: { zh: '全部', en: 'All' },
  cex_futures: { zh: 'CEX合约', en: 'CEX Futures' },
  cex_spot: { zh: 'CEX现货', en: 'CEX Spot' },
  onchain_dex: { zh: '链上DEX', en: 'On-chain DEX' },
}

// Platforms grouped by category (only include platforms with actual data)
const PLATFORMS_BY_CATEGORY: Record<Exclude<CategoryPreset, 'all'>, string[]> = {
  cex_futures: ['binance_futures', 'bybit', 'bitget_futures', 'okx_futures', 'mexc', 'htx_futures', 'kucoin', 'coinex', 'weex'],
  cex_spot: ['binance_spot', 'bitget_spot'],
  onchain_dex: ['gmx', 'hyperliquid', 'dydx', 'gains', 'aevo'],
}

// Platform dropdown component
function PlatformDropdown({ 
  activePlatform, 
  activeCategory,
  onPlatformChange, 
  isZh 
}: { 
  activePlatform: string | undefined
  activeCategory: CategoryPreset
  onPlatformChange: (p: string | undefined) => void
  isZh: boolean 
}) {
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Get platforms based on active category
  const availablePlatforms = activeCategory === 'all' 
    ? Object.values(PLATFORMS_BY_CATEGORY).flat()
    : PLATFORMS_BY_CATEGORY[activeCategory] || []

  const selectedLabel = activePlatform 
    ? (EXCHANGE_NAMES[activePlatform] || activePlatform)
    : (isZh ? '选择平台' : 'Select Platform')

  return (
    <div ref={dropdownRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-2 rounded-md text-xs font-medium transition-all"
        style={{
          backgroundColor: activePlatform ? tokens.colors.accent.brand + '20' : tokens.colors.bg.tertiary,
          color: activePlatform ? tokens.colors.accent.brand : tokens.colors.text.secondary,
          border: activePlatform ? `1px solid ${tokens.colors.accent.brand}50` : `1px solid ${tokens.colors.border.primary}`,
        }}
      >
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M9 12h6M12 9v6" />
        </svg>
        {selectedLabel}
        <svg 
          width={10} height={10} 
          viewBox="0 0 24 24" 
          fill="none" 
          stroke="currentColor" 
          strokeWidth="2"
          style={{ transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            minWidth: 180,
            maxHeight: 320,
            overflowY: 'auto',
            background: tokens.colors.bg.secondary,
            border: `1px solid ${tokens.colors.border.primary}`,
            borderRadius: 8,
            boxShadow: tokens.shadow.lg,
            zIndex: 100,
          }}
        >
          <button
            onClick={() => { onPlatformChange(undefined); setIsOpen(false) }}
            className="w-full px-3 py-2 text-left text-xs font-medium transition-all"
            style={{
              color: !activePlatform ? tokens.colors.accent.brand : tokens.colors.text.primary,
              background: !activePlatform ? `${tokens.colors.accent.brand}10` : 'transparent',
            }}
          >
            {isZh ? '全部平台' : 'All Platforms'}
          </button>
          {availablePlatforms.map(p => (
            <button
              key={p}
              onClick={() => { onPlatformChange(p); setIsOpen(false) }}
              className="w-full px-3 py-2 text-left text-xs font-medium transition-all hover:bg-gray-100 dark:hover:bg-gray-800"
              style={{
                color: activePlatform === p ? tokens.colors.accent.brand : tokens.colors.text.primary,
                background: activePlatform === p ? `${tokens.colors.accent.brand}10` : 'transparent',
              }}
            >
              {EXCHANGE_NAMES[p] || p}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function RankingsContent() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const activeWindow = (searchParams.get('window') as SnapshotWindow) || '90D'
  const activePlatform = searchParams.get('platform') || undefined
  const activeCategory = (searchParams.get('category') as CategoryPreset) || 'all'

  const { data, error, isLoading, isStale } = useRankingsV2({
    window: activeWindow,
    platform: activePlatform as Platform | undefined,
  })

  const handleWindowChange = (w: SnapshotWindow) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set('window', w)
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }

  const handleCategoryChange = (cat: CategoryPreset) => {
    const params = new URLSearchParams(searchParams.toString())
    if (cat === 'all') {
      params.delete('category')
    } else {
      params.set('category', cat)
    }
    // Clear platform when category changes
    params.delete('platform')
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }

  const handlePlatformChange = (p: string | undefined) => {
    const params = new URLSearchParams(searchParams.toString())
    if (p) {
      params.set('platform', p)
    } else {
      params.delete('platform')
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }

  // Filter data by category if no specific platform selected
  const filteredData = data ? {
    ...data,
    traders: activeCategory !== 'all' && !activePlatform
      ? data.traders.filter(t => {
          const sourceType = SOURCE_TYPE_MAP[t.platform]
          if (activeCategory === 'cex_futures') return sourceType === 'futures'
          if (activeCategory === 'cex_spot') return sourceType === 'spot'
          if (activeCategory === 'onchain_dex') return sourceType === 'web3'
          return true
        })
      : data.traders,
  } : null

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={null} />
      <div className="feed-main-content max-w-5xl mx-auto px-4 py-6" style={{ paddingBottom: 80 }}>
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold" style={{ color: tokens.colors.text.primary }}>
            {isZh ? '交易员排行榜' : 'Trader Rankings'}
          </h1>
          <div className="flex items-center gap-3">
            {isStale && (
              <span
                className="px-2 py-1 rounded text-xs font-medium"
                style={{
                  backgroundColor: `${tokens.colors.accent.warning}20`,
                  color: tokens.colors.accent.warning,
                }}
              >
                {isZh ? '数据更新中' : 'Data updating'}
              </span>
            )}
            {data?.as_of && (
              <span className="text-xs" style={{ color: tokens.colors.text.tertiary }}>
                {new Date(data.as_of).toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>

        {/* Time range selector */}
        <div className="flex flex-wrap gap-2 mb-4">
          {WINDOWS.map(w => (
            <button
              key={w}
              onClick={() => handleWindowChange(w)}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
              style={{
                backgroundColor: activeWindow === w ? tokens.colors.accent.brand : tokens.colors.bg.secondary,
                color: activeWindow === w ? '#fff' : tokens.colors.text.secondary,
              }}
            >
              {w}
            </button>
          ))}
        </div>

        {/* Category presets + Platform dropdown - compact layout */}
        <div className="flex flex-wrap items-center gap-2 mb-6">
          {/* Category presets */}
          {(Object.keys(CATEGORY_LABELS) as CategoryPreset[]).map(cat => (
            <button
              key={cat}
              onClick={() => handleCategoryChange(cat)}
              className="px-3 py-2 rounded-full text-xs font-medium transition-all"
              style={{
                backgroundColor: activeCategory === cat ? tokens.colors.accent.brand : tokens.colors.bg.tertiary,
                color: activeCategory === cat ? '#fff' : tokens.colors.text.secondary,
                border: activeCategory === cat ? `1px solid ${tokens.colors.accent.brand}` : `1px solid ${tokens.colors.border.primary}`,
              }}
            >
              {isZh ? CATEGORY_LABELS[cat].zh : CATEGORY_LABELS[cat].en}
            </button>
          ))}
          
          {/* Divider */}
          <div style={{ width: 1, height: 24, background: tokens.colors.border.primary, margin: '0 4px' }} />
          
          {/* Platform dropdown */}
          <PlatformDropdown
            activePlatform={activePlatform}
            activeCategory={activeCategory}
            onPlatformChange={handlePlatformChange}
            isZh={isZh}
          />
        </div>

        <DataStateWrapper
          isLoading={isLoading}
          error={error}
          isEmpty={!filteredData?.traders?.length}
          emptyMessage={isZh ? '暂无排行榜数据' : 'No ranking data available'}
          loadingComponent={<RankingSkeleton />}
        >
          {filteredData && filteredData.traders.length > 0 && (
            <div className="rounded-xl overflow-x-auto" style={{ backgroundColor: tokens.colors.bg.secondary }}>
              <div>
                <div
                  className="grid ranking-table-grid gap-2 px-4 py-3 text-xs font-medium border-b"
                  style={{ color: tokens.colors.text.secondary, borderColor: tokens.colors.border.primary }}
                >
                  <div>#</div>
                  <div>{isZh ? '交易员' : 'Trader'}</div>
                  <div className="text-right">ROI</div>
                  <div className="text-right col-pnl">PnL</div>
                  <div className="text-right col-winrate">{isZh ? '胜率' : 'Win%'}</div>
                  <div className="text-right col-mdd">{isZh ? '回撤' : 'MDD'}</div>
                  <div className="text-right col-score">Score</div>
                </div>

                {filteredData.traders.map((trader, index) => (
                  <TraderRow key={`${trader.platform}:${trader.trader_key}`} trader={{ ...trader, rank: index + 1 }} />
                ))}

                <div
                  className="px-4 py-3 text-xs text-center border-t"
                  style={{ color: tokens.colors.text.tertiary, borderColor: tokens.colors.border.primary }}
                >
                  {isZh ? `共 ${filteredData.traders.length} 名交易员` : `${filteredData.traders.length} traders total`}
                </div>
              </div>
            </div>
          )}
        </DataStateWrapper>
      </div>
      <MobileBottomNav />
    </Box>
  )
}

function TraderRow({ trader }: { trader: RankedTraderV2 }) {
  const metrics = trader.metrics
  const roiColor = metrics.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
  const traderUrl = `/trader/${encodeURIComponent(trader.trader_key)}?platform=${trader.platform}`

  return (
    <Link
      href={traderUrl}
      className="grid ranking-table-grid gap-2 px-4 py-3 items-center transition-all border-b last:border-b-0"
      style={{ borderColor: tokens.colors.border.primary + '40' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = tokens.colors.bg.tertiary }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      <div className="text-sm font-medium" style={{ color: tokens.colors.text.secondary }}>
        {trader.rank <= 3 ? (
          <span className="text-lg">{trader.rank === 1 ? '🥇' : trader.rank === 2 ? '🥈' : '🥉'}</span>
        ) : (
          trader.rank
        )}
      </div>

      <div className="flex items-center gap-3 min-w-0">
        <div
          className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center overflow-hidden text-xs font-bold"
          style={{ background: trader.avatar_url ? undefined : getAvatarGradient(trader.trader_key) }}
        >
          {trader.avatar_url ? (
            <img src={trader.avatar_url} alt="" className="w-full h-full object-cover" />
          ) : (
            <span className="text-white">{getAvatarInitial(trader.display_name || trader.trader_key)}</span>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium truncate" style={{ color: tokens.colors.text.primary }}>
            {trader.display_name || trader.trader_key.slice(0, 12)}
          </div>
          <div className="text-xs" style={{ color: tokens.colors.text.tertiary }}>
            {trader.platform.replace('_', ' ')}
          </div>
        </div>
      </div>

      <div className="text-right text-sm font-semibold" style={{ color: roiColor }}>
        {formatROI(metrics.roi)}
      </div>

      <div className="text-right text-sm col-pnl" style={{ color: tokens.colors.text.primary }}>
        {formatPnL(metrics.pnl)}
      </div>

      <div className="text-right text-sm col-winrate" style={{ color: tokens.colors.text.secondary }}>
        {metrics.win_rate != null ? `${metrics.win_rate.toFixed(1)}%` : '--'}
      </div>

      <div className="text-right text-sm col-mdd" style={{ color: tokens.colors.accent.error + 'cc' }}>
        {metrics.max_drawdown != null ? `-${metrics.max_drawdown.toFixed(1)}%` : '--'}
      </div>

      <div className="text-right col-score">
        {metrics.arena_score != null ? (
          <span
            className="text-sm font-bold px-2 py-0.5 rounded"
            style={{ backgroundColor: tokens.colors.accent.brand + '20', color: tokens.colors.accent.brand }}
          >
            {metrics.arena_score.toFixed(1)}
          </span>
        ) : (
          <span className="text-sm" style={{ color: tokens.colors.text.tertiary }}>--</span>
        )}
      </div>
    </Link>
  )
}

export default function RankingsPage() {
  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
        <TopNav email={null} />
        <div className="max-w-5xl mx-auto px-4 py-6">
          <RankingSkeleton />
        </div>
      </Box>
    }>
      <RankingsContent />
    </Suspense>
  )
}
