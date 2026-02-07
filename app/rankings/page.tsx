'use client'

/**
 * Rankings V2 Page
 * Uses /api/rankings endpoint with URL query params for window switching.
 * Pure DB read, fast rendering, stale indicators.
 */

import { Suspense, useState, useRef, useEffect, useCallback, useMemo, useDeferredValue } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { useRankingsV2 } from '@/lib/hooks/useRankingsV2'
import TopNav from '@/app/components/layout/TopNav'
import MobileBottomNav from '@/app/components/layout/MobileBottomNav'
import DataStateWrapper from '@/app/components/ui/DataStateWrapper'
import DataFreshnessIndicator from '@/app/components/ranking/DataFreshnessIndicator'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { Box } from '@/app/components/base'
import { getAvatarGradient, getAvatarInitial } from '@/lib/utils/avatar'
import { formatROI, formatPnL } from '@/app/components/ranking/utils'
import { VirtualLeaderboard, type TraderRow as VirtualTraderRow } from '@/app/components/ranking/VirtualLeaderboard'
import { MetricTooltip } from '@/app/components/ui/MetricTooltip'
import type { SnapshotWindow, RankedTraderV2, Platform } from '@/lib/types/trading-platform'
import { EXCHANGE_NAMES, SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
import { getPlatformNote } from '@/lib/constants/platform-metrics'

// Threshold for using virtual scrolling (for large datasets)
const VIRTUAL_SCROLL_THRESHOLD = 50

// Convert RankedTraderV2 to VirtualLeaderboard's TraderRow format
function toVirtualRow(trader: RankedTraderV2, rank: number): VirtualTraderRow {
  return {
    id: `${trader.platform}:${trader.trader_key}`,
    rank,
    name: trader.display_name || trader.trader_key.slice(0, 8),
    avatar: trader.avatar_url || undefined,
    roi: trader.metrics.roi,
    pnl: trader.metrics.pnl,
    winRate: trader.metrics.win_rate ?? undefined,
    drawdown: trader.metrics.max_drawdown ?? undefined,
    followers: trader.metrics.followers ?? undefined,
    source: EXCHANGE_NAMES[trader.platform] || trader.platform,
  }
}

const WINDOWS: SnapshotWindow[] = ['7D', '30D', '90D']

// LocalStorage key for filter preferences
const FILTER_PREFS_KEY = 'arena_ranking_filters'

interface FilterPrefs {
  window?: SnapshotWindow
  category?: CategoryPreset
  platform?: string
}

function loadFilterPrefs(): FilterPrefs {
  if (typeof window === 'undefined') return {}
  try {
    const stored = localStorage.getItem(FILTER_PREFS_KEY)
    return stored ? JSON.parse(stored) : {}
  } catch {
    return {}
  }
}

function saveFilterPrefs(prefs: FilterPrefs): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(FILTER_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Ignore storage errors
  }
}

// Category presets for quick filtering
type CategoryPreset = 'all' | 'cex_futures' | 'cex_spot' | 'onchain_dex'

const CATEGORY_LABELS: Record<CategoryPreset, { zh: string; en: string }> = {
  all: { zh: '全部', en: 'All' },
  cex_futures: { zh: 'CEX合约', en: 'CEX Futures' },
  cex_spot: { zh: 'CEX现货', en: 'CEX Spot' },
  onchain_dex: { zh: '链上DEX', en: 'On-chain DEX' },
}

// Platforms grouped by category (only include platforms with actual data, sorted by data count)
const PLATFORMS_BY_CATEGORY: Record<Exclude<CategoryPreset, 'all'>, string[]> = {
  cex_futures: [
    'binance_futures',  // 2500
    'bitget_futures',   // 1203
    'htx_futures',      // 1099
    'okx_futures',      // 855
    'mexc',             // 860
    'kucoin',           // 537
    'bybit',            // 489
    'coinex',           // 650
    'weex',             // 69
    'xt',               // 158
  ],
  cex_spot: [
    'binance_spot',     // 1968
    'bitget_spot',      // 785
    'bybit_spot',       // 500
  ],
  onchain_dex: [
    'hyperliquid',      // 3433
    'gmx',              // 2575
    'aevo',             // 1519
    'okx_web3',         // 1531
    'gains',            // 1407
    'jupiter_perps',    // 1134
    'dydx',             // 196
    'binance_web3',     // 52
  ],
}

function RankingsContent() {
  const { language } = useLanguage()
  const isZh = language === 'zh'
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const [hasRestoredPrefs, setHasRestoredPrefs] = useState(false)

  // Restore preferences from localStorage on first load if no URL params
  useEffect(() => {
    if (hasRestoredPrefs) return

    const hasUrlParams = searchParams.has('window') || searchParams.has('category') || searchParams.has('platform')
    if (!hasUrlParams) {
      const prefs = loadFilterPrefs()
      if (prefs.window || prefs.category || prefs.platform) {
        const params = new URLSearchParams()
        if (prefs.window && prefs.window !== '90D') params.set('window', prefs.window)
        if (prefs.category && prefs.category !== 'all') params.set('category', prefs.category)
        if (prefs.platform) params.set('platform', prefs.platform)
        if (params.toString()) {
          router.replace(`${pathname}?${params.toString()}`, { scroll: false })
        }
      }
    }
    setHasRestoredPrefs(true)
  }, [hasRestoredPrefs, searchParams, router, pathname])

  const activeWindow = (searchParams.get('window') as SnapshotWindow) || '90D'
  const activePlatform = searchParams.get('platform') || undefined
  const activeCategory = (searchParams.get('category') as CategoryPreset) || 'all'

  const { data, error, isLoading, isStale } = useRankingsV2({
    window: activeWindow,
    platform: activePlatform as Platform | undefined,
  })

  // Save preferences to localStorage when they change
  const saveCurrentPrefs = useCallback(() => {
    saveFilterPrefs({
      window: activeWindow,
      category: activeCategory,
      platform: activePlatform,
    })
  }, [activeWindow, activeCategory, activePlatform])

  useEffect(() => {
    if (hasRestoredPrefs) {
      saveCurrentPrefs()
    }
  }, [hasRestoredPrefs, saveCurrentPrefs])

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

  // Filter data by category if no specific platform selected
  const filteredTraders = useMemo(() => {
    if (!data) return []
    if (activeCategory === 'all' || activePlatform) return data.traders
    return data.traders.filter(t => {
      const sourceType = SOURCE_TYPE_MAP[t.platform]
      if (activeCategory === 'cex_futures') return sourceType === 'futures'
      if (activeCategory === 'cex_spot') return sourceType === 'spot'
      if (activeCategory === 'onchain_dex') return sourceType === 'web3'
      return true
    })
  }, [data, activeCategory, activePlatform])
  
  // Defer expensive list rendering to keep UI responsive during filter changes
  const deferredTraders = useDeferredValue(filteredTraders)
  const isFiltering = deferredTraders !== filteredTraders
  
  const filteredData = data ? {
    ...data,
    traders: deferredTraders,
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
            <DataFreshnessIndicator />
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

        {/* Filters removed - use filter panel instead */}

        <DataStateWrapper
          isLoading={isLoading}
          error={error}
          isEmpty={!filteredData?.traders?.length}
          emptyMessage={isZh ? '暂无排行榜数据' : 'No ranking data available'}
          loadingComponent={<RankingSkeleton />}
        >
          {filteredData && filteredData.traders.length > 0 && (
            <div style={{ position: 'relative' }}>
              {isFiltering && (
                <div 
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: 2,
                    background: `linear-gradient(90deg, transparent, ${tokens.colors.accent.brand}, transparent)`,
                    animation: 'shimmer 1s ease-in-out infinite',
                    zIndex: 10,
                  }}
                />
              )}
              <TraderList 
                traders={filteredData.traders} 
                isZh={isZh} 
                isLoading={isLoading || isFiltering}
              />
            </div>
          )}
        </DataStateWrapper>
      </div>
      <MobileBottomNav />
    </Box>
  )
}

/**
 * TraderList - Renders trader list with automatic virtual scrolling
 * Uses VirtualLeaderboard when there are many traders for performance
 */
function TraderList({ 
  traders, 
  isZh, 
  isLoading 
}: { 
  traders: RankedTraderV2[]
  isZh: boolean
  isLoading: boolean
}) {
  const router = useRouter()
  
  // Convert traders to virtual row format
  const virtualRows = useMemo(() => 
    traders.map((t, i) => toVirtualRow(t, i + 1)),
    [traders]
  )
  
  const handleRowClick = useCallback((row: VirtualTraderRow) => {
    const [platform, traderKey] = row.id.split(':')
    router.push(`/trader/${encodeURIComponent(traderKey)}?platform=${platform}`)
  }, [router])
  
  // Use virtual scrolling for large datasets
  const useVirtual = traders.length > VIRTUAL_SCROLL_THRESHOLD
  
  if (useVirtual) {
    return (
      <div 
        className="rounded-xl overflow-hidden" 
        style={{ 
          backgroundColor: tokens.colors.bg.secondary,
          height: 'calc(100vh - 280px)',
          minHeight: 400,
        }}
      >
        <VirtualLeaderboard
          data={virtualRows}
          onRowClick={handleRowClick}
          isLoading={isLoading}
        />
        <div
          className="px-4 py-3 text-xs text-center border-t"
          style={{ color: tokens.colors.text.tertiary, borderColor: tokens.colors.border.primary }}
        >
          {isZh ? `共 ${traders.length} 名交易员 (虚拟滚动)` : `${traders.length} traders (virtual scroll)`}
        </div>
      </div>
    )
  }
  
  // Regular rendering for small datasets
  return (
    <div className="rounded-xl overflow-x-auto" style={{ backgroundColor: tokens.colors.bg.secondary }}>
      <div>
        <div
          className="grid ranking-table-grid gap-2 px-4 py-3 text-xs font-medium border-b"
          style={{ color: tokens.colors.text.secondary, borderColor: tokens.colors.border.primary }}
        >
          <div>#</div>
          <div>{isZh ? '交易员' : 'Trader'}</div>
          <div className="text-right flex items-center justify-end gap-1">
            ROI <MetricTooltip metric="roi" language={isZh ? 'zh' : 'en'} />
          </div>
          <div className="text-right col-pnl flex items-center justify-end gap-1">
            PnL <MetricTooltip metric="pnl" language={isZh ? 'zh' : 'en'} />
          </div>
          <div className="text-right col-winrate flex items-center justify-end gap-1">
            {isZh ? '胜率' : 'Win%'} <MetricTooltip metric="winRate" language={isZh ? 'zh' : 'en'} />
          </div>
          <div className="text-right col-mdd flex items-center justify-end gap-1">
            {isZh ? '回撤' : 'MDD'} <MetricTooltip metric="maxDrawdown" language={isZh ? 'zh' : 'en'} />
          </div>
          <div className="text-right col-score flex items-center justify-end gap-1">
            Score <MetricTooltip metric="arenaScore" language={isZh ? 'zh' : 'en'} />
          </div>
        </div>

        {traders.map((trader, index) => (
          <TraderRow key={`${trader.platform}:${trader.trader_key}`} trader={{ ...trader, rank: index + 1 }} />
        ))}

        <div
          className="px-4 py-3 text-xs text-center border-t"
          style={{ color: tokens.colors.text.tertiary, borderColor: tokens.colors.border.primary }}
        >
          {isZh ? `共 ${traders.length} 名交易员` : `${traders.length} traders total`}
        </div>
      </div>
    </div>
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

      <div 
        className="text-right text-sm col-winrate" 
        style={{ color: metrics.win_rate != null ? tokens.colors.text.secondary : tokens.colors.text.tertiary }}
        title={metrics.win_rate == null ? (getPlatformNote(trader.platform) || 'Win rate not provided by this platform') : undefined}
      >
        {metrics.win_rate != null ? `${metrics.win_rate.toFixed(1)}%` : (
          <span style={{ opacity: 0.5, cursor: 'help' }}>N/A</span>
        )}
      </div>

      <div 
        className="text-right text-sm col-mdd" 
        style={{ color: metrics.max_drawdown != null ? (tokens.colors.accent.error + 'cc') : tokens.colors.text.tertiary }}
        title={metrics.max_drawdown == null ? (getPlatformNote(trader.platform) || 'Drawdown not provided by this platform') : undefined}
      >
        {metrics.max_drawdown != null ? `-${metrics.max_drawdown.toFixed(1)}%` : (
          <span style={{ opacity: 0.5, cursor: 'help' }}>N/A</span>
        )}
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
