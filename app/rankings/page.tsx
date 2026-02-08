'use client'

/**
 * Rankings V2 Page
 * Uses /api/rankings endpoint with URL query params for window switching.
 * Pure DB read, fast rendering, stale indicators.
 */

import { Suspense, useState, useEffect, useCallback, useMemo, useDeferredValue, useRef } from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
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
import { EXCHANGE_NAMES, SOURCE_TYPE_MAP, SOURCE_TRUST_WEIGHT } from '@/lib/constants/exchanges'
import { Web3VerifiedBadge } from '@/app/components/trader/Web3VerifiedBadge'
import { getPlatformNote } from '@/lib/constants/platform-metrics'

// Threshold for using virtual scrolling (for large datasets)
const VIRTUAL_SCROLL_THRESHOLD = 50

// Convert RankedTraderV2 to VirtualLeaderboard's TraderRow format
/** Get a readable trader name — skip pure-numeric IDs */
function getTraderDisplayName(trader: { display_name: string | null; trader_key: string; platform: string }): string {
  const name = trader.display_name
  // If name is null, empty, or a long numeric ID, use a friendlier format
  if (!name || (name.length > 10 && /^\d+$/.test(name))) {
    const platformLabel = EXCHANGE_NAMES[trader.platform as keyof typeof EXCHANGE_NAMES] || trader.platform
    const shortId = trader.trader_key.length > 10 
      ? `${trader.trader_key.slice(0, 4)}...${trader.trader_key.slice(-4)}`
      : trader.trader_key
    return `${platformLabel} #${shortId}`
  }
  return name
}

function getTrustTier(platform: string): 'high' | 'medium' | 'low' {
  const w = SOURCE_TRUST_WEIGHT[platform] ?? 0.5
  if (w >= 1.0) return 'high'
  if (w >= 0.8) return 'medium'
  return 'low'
}

function toVirtualRow(trader: RankedTraderV2, rank: number): VirtualTraderRow {
  return {
    id: `${trader.platform}:${trader.trader_key}`,
    rank,
    name: getTraderDisplayName(trader),
    avatar: trader.avatar_url || undefined,
    roi: trader.metrics.roi,
    pnl: trader.metrics.pnl,
    winRate: trader.metrics.win_rate ?? undefined,
    drawdown: trader.metrics.max_drawdown ?? undefined,
    followers: trader.metrics.followers ?? undefined,
    source: EXCHANGE_NAMES[trader.platform] || trader.platform,
    trustTier: getTrustTier(trader.platform),
  }
}

const WINDOWS: SnapshotWindow[] = ['7D', '30D', '90D']

// LocalStorage key for filter preferences
const FILTER_PREFS_KEY = 'arena_ranking_filters'

// Category presets for quick filtering
type CategoryPreset = 'all' | 'cex_futures' | 'cex_spot' | 'onchain_dex'

const CATEGORY_LABELS: Record<CategoryPreset, { zh: string; en: string }> = {
  all: { zh: '全部', en: 'All' },
  cex_futures: { zh: 'CEX合约', en: 'CEX Futures' },
  cex_spot: { zh: 'CEX现货', en: 'CEX Spot' },
  onchain_dex: { zh: '链上DEX', en: 'On-chain DEX' },
}

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

/** Quick exchange filter chips shown above the leaderboard */
const QUICK_FILTER_EXCHANGES: { value: string; label: string }[] = [
  { value: 'binance_futures', label: 'Binance' },
  { value: 'bitget_futures', label: 'Bitget' },
  { value: 'okx_futures', label: 'OKX' },
  { value: 'bybit', label: 'Bybit' },
  { value: 'mexc', label: 'MEXC' },
  { value: 'htx_futures', label: 'HTX' },
  { value: 'hyperliquid', label: 'Hyperliquid' },
  { value: 'gmx', label: 'GMX' },
]

function ExchangeQuickFilter({
  activeCategory,
  activePlatform,
  isZh,
  onPlatformChange,
}: {
  activeCategory: CategoryPreset
  activePlatform: string | undefined
  isZh: boolean
  onPlatformChange: (platform: string | null) => void
}) {
  // Filter chips based on active category
  const visibleExchanges = useMemo(() => {
    if (activeCategory === 'all') return QUICK_FILTER_EXCHANGES
    return QUICK_FILTER_EXCHANGES.filter(ex => {
      const sourceType = SOURCE_TYPE_MAP[ex.value]
      if (activeCategory === 'cex_futures') return sourceType === 'futures'
      if (activeCategory === 'cex_spot') return sourceType === 'spot'
      if (activeCategory === 'onchain_dex') return sourceType === 'web3'
      return true
    })
  }, [activeCategory])

  if (visibleExchanges.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 mb-4">
      {visibleExchanges.map(ex => {
        const isActive = activePlatform === ex.value
        return (
          <button
            key={ex.value}
            onClick={() => onPlatformChange(isActive ? null : ex.value)}
            style={{
              padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.full,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: isActive ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
              background: isActive ? `${tokens.colors.accent.primary}20` : tokens.glass.bg.light,
              color: isActive ? tokens.colors.accent.primary : tokens.colors.text.tertiary,
              border: `1px solid ${isActive ? tokens.colors.accent.primary + '50' : tokens.colors.border.primary}`,
              cursor: 'pointer',
              transition: `all ${tokens.transition.fast}`,
              outline: 'none',
            }}
          >
            {ex.label}
          </button>
        )
      })}
      {activePlatform && (
        <button
          onClick={() => onPlatformChange(null)}
          style={{
            padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
            borderRadius: tokens.radius.full,
            fontSize: tokens.typography.fontSize.xs,
            fontWeight: tokens.typography.fontWeight.medium,
            background: 'transparent',
            color: tokens.colors.text.tertiary,
            border: `1px solid ${tokens.colors.border.primary}`,
            cursor: 'pointer',
            transition: `all ${tokens.transition.fast}`,
            outline: 'none',
          }}
        >
          {isZh ? '清除' : 'Clear'}
        </button>
      )}
    </div>
  )
}

/** CSS fade wrapper — re-triggers enter animation when transitionKey changes */
function RankingFadeWrapper({ transitionKey, children }: { transitionKey: string; children: React.ReactNode }) {
  const [animClass, setAnimClass] = useState('ranking-fade-active')
  const prevKey = useRef(transitionKey)

  useEffect(() => {
    if (prevKey.current !== transitionKey) {
      prevKey.current = transitionKey
      setAnimClass('ranking-fade-enter')
      // Force reflow then apply active class
      const raf = requestAnimationFrame(() => {
        setAnimClass('ranking-fade-active')
      })
      return () => cancelAnimationFrame(raf)
    }
  }, [transitionKey])

  return <div className={animClass}>{children}</div>
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
        <div className="flex items-center justify-between" style={{ marginBottom: tokens.spacing[6] }}>
          <h1 style={{ fontSize: tokens.typography.fontSize['2xl'], fontWeight: tokens.typography.fontWeight.black, color: tokens.colors.text.primary, letterSpacing: '-0.3px' }}>
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

        {/* Data coverage & update time */}
        {data && (
          <div className="flex flex-wrap items-center gap-4 mb-3" style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary }}>
            <span>
              {isZh
                ? `数据更新于 ${(() => {
                    const mins = Math.round((Date.now() - new Date(data.as_of).getTime()) / 60000)
                    return mins < 60 ? `${mins} 分钟前` : `${Math.round(mins / 60)} 小时前`
                  })()}`
                : `Updated ${(() => {
                    const mins = Math.round((Date.now() - new Date(data.as_of).getTime()) / 60000)
                    return mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`
                  })()}`}
            </span>
            <span style={{ color: tokens.colors.border.primary }}>|</span>
            <span>
              {isZh
                ? `覆盖 ${new Set(data.traders.map(t => t.platform)).size} 个平台 · 共 ${data.total_count} 名交易员`
                : `${new Set(data.traders.map(t => t.platform)).size} platforms · ${data.total_count} traders`}
            </span>
          </div>
        )}

        {/* Time range selector */}
        <div className="flex flex-wrap gap-2 mb-4">
          {WINDOWS.map(w => (
            <button
              key={w}
              onClick={() => handleWindowChange(w)}
              className="ranking-filter-btn touch-target"
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
                minHeight: 44,
                borderRadius: tokens.radius.lg,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: activeWindow === w ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
                background: activeWindow === w ? tokens.gradient.purpleGold : tokens.glass.bg.light,
                backdropFilter: activeWindow === w ? 'none' : tokens.glass.blur.sm,
                WebkitBackdropFilter: activeWindow === w ? 'none' : tokens.glass.blur.sm,
                color: activeWindow === w ? '#fff' : tokens.colors.text.secondary,
                border: activeWindow === w ? 'none' : tokens.glass.border.light,
                cursor: 'pointer',
                transition: `all ${tokens.transition.base}`,
                boxShadow: activeWindow === w ? `0 4px 16px ${tokens.colors.accent.primary}40` : 'none',
                outline: 'none',
              }}
              onMouseEnter={(e) => {
                if (activeWindow !== w) {
                  e.currentTarget.style.background = tokens.glass.bg.medium
                  e.currentTarget.style.color = tokens.colors.text.primary
                  e.currentTarget.style.transform = 'translateY(-1px)'
                }
              }}
              onMouseLeave={(e) => {
                if (activeWindow !== w) {
                  e.currentTarget.style.background = tokens.glass.bg.light
                  e.currentTarget.style.color = tokens.colors.text.secondary
                  e.currentTarget.style.transform = 'translateY(0)'
                }
              }}
              onFocus={(e) => {
                e.currentTarget.style.boxShadow = `0 0 0 ${tokens.focusRing.width} ${tokens.focusRing.color}`
              }}
              onBlur={(e) => {
                e.currentTarget.style.boxShadow = activeWindow === w ? `0 4px 16px ${tokens.colors.accent.primary}40` : 'none'
              }}
            >
              {w}
            </button>
          ))}
        </div>

        {/* Category filter */}
        <div className="flex flex-wrap gap-2 mb-4">
          {(['all', 'cex_futures', 'cex_spot', 'onchain_dex'] as CategoryPreset[]).map(cat => (
            <button
              key={cat}
              onClick={() => handleCategoryChange(cat)}
              className="ranking-filter-btn touch-target"
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[5]}`,
                minHeight: 44,
                borderRadius: tokens.radius.lg,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: activeCategory === cat ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
                background: activeCategory === cat ? tokens.gradient.purpleGold : tokens.glass.bg.light,
                backdropFilter: activeCategory === cat ? 'none' : tokens.glass.blur.sm,
                WebkitBackdropFilter: activeCategory === cat ? 'none' : tokens.glass.blur.sm,
                color: activeCategory === cat ? '#fff' : tokens.colors.text.secondary,
                border: activeCategory === cat ? 'none' : tokens.glass.border.light,
                cursor: 'pointer',
                transition: `all ${tokens.transition.base}`,
                boxShadow: activeCategory === cat ? `0 4px 16px ${tokens.colors.accent.primary}40` : 'none',
                outline: 'none',
              }}
              onMouseEnter={(e) => {
                if (activeCategory !== cat) {
                  e.currentTarget.style.background = tokens.glass.bg.medium
                  e.currentTarget.style.color = tokens.colors.text.primary
                  e.currentTarget.style.transform = 'translateY(-1px)'
                }
              }}
              onMouseLeave={(e) => {
                if (activeCategory !== cat) {
                  e.currentTarget.style.background = tokens.glass.bg.light
                  e.currentTarget.style.color = tokens.colors.text.secondary
                  e.currentTarget.style.transform = 'translateY(0)'
                }
              }}
              onFocus={(e) => {
                e.currentTarget.style.boxShadow = `0 0 0 ${tokens.focusRing.width} ${tokens.focusRing.color}`
              }}
              onBlur={(e) => {
                e.currentTarget.style.boxShadow = activeCategory === cat ? `0 4px 16px ${tokens.colors.accent.primary}40` : 'none'
              }}
            >
              {isZh ? CATEGORY_LABELS[cat].zh : CATEGORY_LABELS[cat].en}
            </button>
          ))}
        </div>

        {/* Exchange quick filter chips */}
        <ExchangeQuickFilter
          activeCategory={activeCategory}
          activePlatform={activePlatform}
          isZh={isZh}
          onPlatformChange={(platform) => {
            const params = new URLSearchParams(searchParams.toString())
            if (platform) {
              params.set('platform', platform)
            } else {
              params.delete('platform')
            }
            router.replace(`${pathname}?${params.toString()}`, { scroll: false })
          }}
        />

        <RankingFadeWrapper transitionKey={`${activeWindow}-${activeCategory}-${activePlatform || ''}`}>
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
        </RankingFadeWrapper>
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
          background: tokens.glass.bg.secondary,
          backdropFilter: tokens.glass.blur.md,
          WebkitBackdropFilter: tokens.glass.blur.md,
          border: tokens.glass.border.light,
          height: 'calc(100vh - 280px)',
          minHeight: 400,
          boxShadow: tokens.shadow.md,
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
    <div className="rounded-xl overflow-x-auto" style={{ background: tokens.glass.bg.secondary, backdropFilter: tokens.glass.blur.md, WebkitBackdropFilter: tokens.glass.blur.md, border: tokens.glass.border.light, boxShadow: tokens.shadow.md }}>
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
      className="grid ranking-table-grid gap-2 px-4 py-3 items-center border-b last:border-b-0 ranking-row-hover"
      style={{ borderColor: tokens.colors.border.primary + '40', textDecoration: 'none', transition: `all ${tokens.transition.base}` }}
    >
      <div className="text-sm font-medium" style={{ color: tokens.colors.text.secondary }}>
        {trader.rank <= 3 ? (
          <span
            className="inline-flex items-center justify-center"
            style={{
              width: 28, height: 28, borderRadius: '50%',
              fontSize: 13, fontWeight: 700,
              background: trader.rank === 1
                ? 'linear-gradient(135deg, #FFD700, #FFA500)'
                : trader.rank === 2
                ? 'linear-gradient(135deg, #C0C0C0, #A0A0A0)'
                : 'linear-gradient(135deg, #CD7F32, #A0522D)',
              color: trader.rank === 1 ? tokens.colors.bg.primary : tokens.colors.text.primary,
              boxShadow: trader.rank === 1
                ? '0 0 8px rgba(255,215,0,0.4)'
                : trader.rank === 2
                ? '0 0 6px rgba(192,192,192,0.3)'
                : '0 0 6px rgba(205,127,50,0.3)',
            }}
          >
            {trader.rank}
          </span>
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
            <Image src={trader.avatar_url} alt="" width={32} height={32} className="w-full h-full object-cover" loading="lazy" placeholder="empty" unoptimized />
          ) : (
            <span className="text-white">{getAvatarInitial(getTraderDisplayName(trader))}</span>
          )}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium truncate" style={{ color: tokens.colors.text.primary }}>
            {getTraderDisplayName(trader)}
          </div>
          <div className="text-xs flex items-center gap-1" style={{ color: tokens.colors.text.tertiary }}>
            {trader.platform.replace('_', ' ')}
            {SOURCE_TYPE_MAP[trader.platform] === 'web3' && <Web3VerifiedBadge size="sm" />}
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
