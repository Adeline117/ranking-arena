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
import { useProStatus } from '@/lib/hooks/useProStatus'
import { PaywallGradientOverlay } from '@/app/components/pro/PaywallOverlay'
import { getScoreColor, getScoreColorHex } from '@/lib/utils/score-colors'

// Threshold for using virtual scrolling (for large datasets)
const VIRTUAL_SCROLL_THRESHOLD = 2000

// 免费用户排行榜可见数量限制
const FREE_RANKING_LIMIT = 100

// Convert RankedTraderV2 to VirtualLeaderboard's TraderRow format
/** Get a readable trader name — skip pure-numeric IDs */
function getTraderDisplayName(trader: { display_name: string | null; trader_key: string; platform: string }): string {
  // Show original platform ID as primary name
  // Users can customize after claiming their profile
  const key = trader.trader_key
  if (!key) {
    return trader.display_name || 'Unknown'
  }
  // Shorten long addresses/IDs (e.g. 0x addresses)
  if (key.length > 16) {
    return `${key.slice(0, 6)}...${key.slice(-4)}`
  }
  return key
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
const QUICK_FILTER_EXCHANGES: { value: string; label: string; logo: string; color: string }[] = [
  { value: 'binance_futures', label: 'Binance', logo: 'https://bin.bnbstatic.com/static/images/common/favicon.ico', color: 'var(--color-chart-amber)' },
  { value: 'bitget_futures', label: 'Bitget', logo: 'https://img.bitgetimg.com/image/third/1723701408221.png', color: 'var(--color-chart-teal)' },
  { value: 'okx_futures', label: 'OKX', logo: 'https://static.okx.com/cdn/assets/imgs/226/DF679B1DADBF90E3.png', color: 'var(--color-text-primary)' },
  { value: 'bybit', label: 'Bybit', logo: 'https://www.bybit.com/favicon.ico', color: 'var(--color-chart-orange)' },
  { value: 'mexc', label: 'MEXC', logo: 'https://www.mexc.com/favicon.png', color: 'var(--color-accent-success)' },
  { value: 'htx_futures', label: 'HTX', logo: 'https://www.htx.com/favicon.ico', color: 'var(--color-chart-indigo)' },
  { value: 'gateio', label: 'Gate.io', logo: 'https://www.gate.io/favicon.ico', color: 'var(--color-chart-indigo)' },
  { value: 'binance_spot', label: 'Binance', logo: 'https://bin.bnbstatic.com/static/images/common/favicon.ico', color: 'var(--color-chart-amber)' },
  { value: 'bitget_spot', label: 'Bitget', logo: 'https://img.bitgetimg.com/image/third/1723701408221.png', color: 'var(--color-chart-teal)' },
  { value: 'bybit_spot', label: 'Bybit', logo: 'https://www.bybit.com/favicon.ico', color: 'var(--color-chart-orange)' },
  { value: 'hyperliquid', label: 'Hyperliquid', logo: 'https://app.hyperliquid.xyz/favicon.ico', color: 'var(--color-chart-teal)' },
  { value: 'gmx', label: 'GMX', logo: 'https://app.gmx.io/favicon.ico', color: 'var(--color-chart-blue)' },
  { value: 'dydx', label: 'dYdX', logo: 'https://dydx.exchange/favicon.ico', color: 'var(--color-chart-indigo)' },
  { value: 'gains', label: 'gTrade', logo: 'https://gains.trade/favicon.ico', color: 'var(--color-chart-violet)' },
  { value: 'jupiter_perps', label: 'Jupiter', logo: 'https://jup.ag/favicon.ico', color: 'var(--color-accent-success)' },
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
    <div
      className="exchange-scroll-bar"
      style={{
        display: 'flex',
        gap: 8,
        marginBottom: 16,
        overflowX: 'auto',
        WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none',
        msOverflowStyle: 'none',
        padding: '4px 0',
      }}
    >
      {/* "全部" chip */}
      <button
        onClick={() => onPlatformChange(null)}
        className="touch-target-sm"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 16px',
          borderRadius: tokens.radius.xl,
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: !activePlatform ? 700 : 500,
          background: !activePlatform
            ? tokens.gradient.purpleGold
            : tokens.glass.bg.light,
          color: !activePlatform ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
          border: !activePlatform ? 'none' : `1px solid ${tokens.colors.border.primary}`,
          cursor: 'pointer',
          transition: `all ${tokens.transition.base}`,
          boxShadow: !activePlatform ? `0 2px 12px ${tokens.colors.accent.primary}30` : 'none',
          outline: 'none',
          flexShrink: 0,
          whiteSpace: 'nowrap',
        }}
      >
        {isZh ? '全部' : 'All'}
      </button>

      {visibleExchanges.map(ex => {
        const isActive = activePlatform === ex.value
        return (
          <button
            key={ex.value}
            onClick={() => onPlatformChange(isActive ? null : ex.value)}
            className="touch-target-sm"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 16px',
              borderRadius: tokens.radius.xl,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: isActive ? 700 : 500,
              background: isActive
                ? `${ex.color}18`
                : tokens.glass.bg.light,
              color: isActive ? (ex.color === 'var(--color-on-accent)' ? tokens.colors.text.primary : ex.color) : tokens.colors.text.secondary,
              border: `1px solid ${isActive ? ex.color + '60' : tokens.colors.border.primary}`,
              cursor: 'pointer',
              transition: `all ${tokens.transition.base}`,
              boxShadow: isActive ? `0 2px 12px ${ex.color}25` : 'none',
              outline: 'none',
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.borderColor = ex.color + '40'
                e.currentTarget.style.background = `${ex.color}0C`
                e.currentTarget.style.transform = 'translateY(-1px)'
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.borderColor = tokens.colors.border.primary
                e.currentTarget.style.background = tokens.glass.bg.light
                e.currentTarget.style.transform = 'none'
              }
            }}
          >
            {ex.logo ? (
              <img
                src={ex.logo}
                alt=""
                width={20}
                height={20}
                loading="lazy"
                style={{ borderRadius: '50%', flexShrink: 0 }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            ) : (
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: ex.color,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  fontWeight: 800,
                  color: 'var(--foreground)',
                  flexShrink: 0,
                }}
              >
                {ex.label[0]}
              </span>
            )}
            {ex.label}
          </button>
        )
      })}
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
  const { language, t } = useLanguage()
  const isZh = language === 'zh'
  const { isPro } = useProStatus()
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

  const [searchQuery, setSearchQuery] = useState('')

  const activeWindow = (searchParams.get('window') as SnapshotWindow) || '90D'
  const activePlatform = searchParams.get('platform') || undefined
  const activeCategory = (searchParams.get('category') as CategoryPreset) || 'all'

  // Map UI category presets to API category values
  const apiCategory = activeCategory === 'cex_futures' ? 'futures'
    : activeCategory === 'cex_spot' ? 'spot'
    : activeCategory === 'onchain_dex' ? 'onchain'
    : undefined

  const { data, error, isLoading, isValidating, isStale } = useRankingsV2({
    window: activeWindow,
    platform: activePlatform as Platform | undefined,
    category: apiCategory,
  })
  // With keepPreviousData, show skeleton only on first load
  const showSkeleton = isLoading && !data
  const showTransitionIndicator = isValidating && !!data

  // Restore scroll position when returning from trader detail page
  const scrollRestoredRef = useRef(false)
  useEffect(() => {
    if (data && !scrollRestoredRef.current) {
      scrollRestoredRef.current = true
      try {
        const savedY = sessionStorage.getItem('rankings_scroll_y')
        if (savedY) {
          sessionStorage.removeItem('rankings_scroll_y')
          // Delay to ensure DOM is rendered
          requestAnimationFrame(() => {
            window.scrollTo(0, parseInt(savedY, 10))
          })
        }
      } catch { /* ignore */ }
    }
  }, [data])

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

  // Filter data by category and search query
  const filteredTraders = useMemo(() => {
    if (!data) return []
    let result = data.traders
    if (activeCategory !== 'all' && !activePlatform) {
      result = result.filter(t => {
        const sourceType = SOURCE_TYPE_MAP[t.platform]
        if (activeCategory === 'cex_futures') return sourceType === 'futures'
        if (activeCategory === 'cex_spot') return sourceType === 'spot'
        if (activeCategory === 'onchain_dex') return sourceType === 'web3'
        return true
      })
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      result = result.filter(t => {
        const name = getTraderDisplayName(t).toLowerCase()
        const key = t.trader_key.toLowerCase()
        return name.includes(q) || key.includes(q)
      })
    }
    return result
  }, [data, activeCategory, activePlatform, searchQuery])
  
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
                color: activeWindow === w ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
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
                color: activeCategory === cat ? 'var(--color-on-accent)' : tokens.colors.text.secondary,
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

        {/* Exchange filter moved into AdvancedFilter */}

        {/* Search box */}
        <div style={{ position: 'relative', marginBottom: tokens.spacing[4] }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('rankingsSearchPlaceholder')}
            style={{
              width: '100%',
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              paddingRight: searchQuery ? 36 : tokens.spacing[4],
              borderRadius: tokens.radius.lg,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.glass.bg.light,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.sm,
              outline: 'none',
              transition: `border-color ${tokens.transition.fast}`,
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = tokens.colors.accent.brand }}
            onBlur={(e) => { e.currentTarget.style.borderColor = tokens.colors.border.primary }}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              style={{
                position: 'absolute',
                right: 10,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: tokens.colors.text.tertiary,
                padding: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              aria-label="Clear search"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6L6 18M6 6L18 18" />
              </svg>
            </button>
          )}
        </div>

        <RankingFadeWrapper transitionKey={`${activeWindow}-${activeCategory}-${activePlatform || ''}`}>
          <DataStateWrapper
            isLoading={showSkeleton}
            error={error}
            isEmpty={!filteredData?.traders?.length && !isValidating}
            emptyMessage={
              searchQuery.trim()
                ? (isZh ? `未找到包含"${searchQuery}"的交易员，试试其他关键词` : `No traders found for "${searchQuery}", try different keywords`)
                : (isZh ? '当前筛选条件下暂无排行数据，试试切换分类或平台' : 'No ranking data for current filters, try switching category or platform')
            }
            emptyActions={
              (searchQuery.trim() || activePlatform || activeCategory !== 'all')
                ? [{
                    label: isZh ? '清除筛选' : 'Clear Filters',
                    onClick: () => {
                      setSearchQuery('')
                      router.replace(pathname, { scroll: false })
                    },
                    variant: 'primary' as const,
                  }]
                : undefined
            }
            loadingComponent={<RankingSkeleton />}
          >
            {filteredData && filteredData.traders.length > 0 && (
              <div style={{ position: 'relative' }}>
                {(isFiltering || showTransitionIndicator) && (
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
                  isLoading={showSkeleton || isFiltering}
                  isPro={isPro}
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

type SortField = 'rank' | 'roi' | 'pnl' | 'winRate' | 'drawdown' | 'score'
type SortDir = 'asc' | 'desc'

/** Sort arrow indicator */
function SortIndicator({ active, direction }: { active: boolean; direction: SortDir }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        lineHeight: 0,
        marginLeft: 2,
        opacity: active ? 1 : 0.3,
        transition: 'opacity 0.15s ease',
      }}
    >
      <span style={{
        fontSize: 8,
        color: active && direction === 'asc' ? tokens.colors.accent.brand : tokens.colors.text.tertiary,
      }}>
        &#9650;
      </span>
      <span style={{
        fontSize: 8,
        color: active && direction === 'desc' ? tokens.colors.accent.brand : tokens.colors.text.tertiary,
      }}>
        &#9660;
      </span>
    </span>
  )
}

/**
 * TraderList - Renders trader list with automatic virtual scrolling
 * Uses VirtualLeaderboard when there are many traders for performance
 */
function TraderList({ 
  traders, 
  isZh, 
  isLoading,
  isPro = false,
}: { 
  traders: RankedTraderV2[]
  isZh: boolean
  isLoading: boolean
  isPro?: boolean
}) {
  const router = useRouter()
  const [sortField, setSortField] = useState<SortField>('rank')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDir(prev => prev === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      // Default direction: descending for metrics, ascending for rank
      setSortDir(field === 'rank' ? 'asc' : 'desc')
    }
  }, [sortField])

  const sortedTraders = useMemo(() => {
    if (sortField === 'rank') {
      return sortDir === 'asc' ? traders : [...traders].reverse()
    }
    const sorted = [...traders].sort((a, b) => {
      let va: number, vb: number
      switch (sortField) {
        case 'roi': va = a.metrics.roi; vb = b.metrics.roi; break
        case 'pnl': va = a.metrics.pnl; vb = b.metrics.pnl; break
        case 'winRate': va = a.metrics.win_rate ?? -1; vb = b.metrics.win_rate ?? -1; break
        case 'drawdown': va = a.metrics.max_drawdown ?? 999; vb = b.metrics.max_drawdown ?? 999; break
        case 'score': va = a.metrics.arena_score ?? -1; vb = b.metrics.arena_score ?? -1; break
        default: va = 0; vb = 0
      }
      return sortDir === 'desc' ? vb - va : va - vb
    })
    return sorted
  }, [traders, sortField, sortDir])
  
  // Convert traders to virtual row format
  const virtualRows = useMemo(() => 
    sortedTraders.map((t, i) => toVirtualRow(t, i + 1)),
    [sortedTraders]
  )
  
  const handleRowClick = useCallback((row: VirtualTraderRow) => {
    // Save scroll position before navigating to trader detail
    try {
      sessionStorage.setItem('rankings_scroll_y', String(window.scrollY))
    } catch { /* ignore */ }
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

  const headerStyle: React.CSSProperties = {
    cursor: 'pointer',
    userSelect: 'none',
    transition: 'color 0.15s ease',
  }
  
  // Regular rendering for small datasets
  return (
    <div className="rounded-xl overflow-hidden" style={{ background: tokens.glass.bg.secondary, backdropFilter: tokens.glass.blur.md, WebkitBackdropFilter: tokens.glass.blur.md, border: tokens.glass.border.light, boxShadow: tokens.shadow.md }}>
      <div>
        <div
          className="grid ranking-table-grid gap-2 px-4 py-3 text-xs font-medium border-b"
          style={{ color: tokens.colors.text.secondary, borderColor: tokens.colors.border.primary }}
        >
          <div style={headerStyle} onClick={() => handleSort('rank')}>
            # <SortIndicator active={sortField === 'rank'} direction={sortDir} />
          </div>
          <div>{isZh ? '交易员' : 'Trader'}</div>
          <div className="text-right flex items-center justify-end gap-1" style={headerStyle} onClick={() => handleSort('roi')}>
            ROI <SortIndicator active={sortField === 'roi'} direction={sortDir} /> <MetricTooltip metric="roi" language={isZh ? 'zh' : 'en'} />
          </div>
          <div className="text-right col-pnl flex items-center justify-end gap-1" style={headerStyle} onClick={() => handleSort('pnl')}>
            PnL <SortIndicator active={sortField === 'pnl'} direction={sortDir} /> <MetricTooltip metric="pnl" language={isZh ? 'zh' : 'en'} />
          </div>
          <div className="text-right col-winrate flex items-center justify-end gap-1" style={headerStyle} onClick={() => handleSort('winRate')}>
            {isZh ? '胜率' : 'Win%'} <SortIndicator active={sortField === 'winRate'} direction={sortDir} /> <MetricTooltip metric="winRate" language={isZh ? 'zh' : 'en'} />
          </div>
          <div className="text-right col-mdd flex items-center justify-end gap-1" style={headerStyle} onClick={() => handleSort('drawdown')}>
            {isZh ? '回撤' : 'MDD'} <SortIndicator active={sortField === 'drawdown'} direction={sortDir} /> <MetricTooltip metric="maxDrawdown" language={isZh ? 'zh' : 'en'} />
          </div>
          <div className="text-right col-score flex items-center justify-end gap-1" style={headerStyle} onClick={() => handleSort('score')}>
            Score <SortIndicator active={sortField === 'score'} direction={sortDir} /> <MetricTooltip metric="arenaScore" language={isZh ? 'zh' : 'en'} />
          </div>
        </div>

        {(isPro ? sortedTraders : sortedTraders.slice(0, FREE_RANKING_LIMIT)).map((trader, index) => (
          <TraderRow key={`${trader.platform}:${trader.trader_key}`} trader={{ ...trader, rank: index + 1 }} />
        ))}

        {!isPro && sortedTraders.length > FREE_RANKING_LIMIT && (
          <PaywallGradientOverlay
            feature={isZh ? '完整排行榜 - 32,000+ 名交易员' : 'Full rankings - 32,000+ traders'}
          />
        )}

        <div
          className="px-4 py-3 text-xs text-center border-t"
          style={{ color: tokens.colors.text.tertiary, borderColor: tokens.colors.border.primary }}
        >
          {isZh
            ? isPro
              ? `共 ${traders.length} 名交易员`
              : `显示前 ${Math.min(traders.length, FREE_RANKING_LIMIT)} / ${traders.length} 名交易员`
            : isPro
              ? `${traders.length} traders total`
              : `Showing top ${Math.min(traders.length, FREE_RANKING_LIMIT)} of ${traders.length} traders`}
        </div>
      </div>
    </div>
  )
}

function RankChangeIndicator({ currentRank, metricRank }: { currentRank: number; metricRank: number | null }) {
  if (metricRank == null || metricRank === 0 || metricRank === currentRank) return null
  const diff = metricRank - currentRank // positive = rank improved (went up)
  if (diff === 0) return null
  const isUp = diff > 0
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: isUp ? tokens.colors.accent.success : tokens.colors.accent.error,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 1,
        marginLeft: 4,
        animation: 'fadeIn 0.3s ease-in',
      }}
      title={isUp ? `↑${diff}` : `↓${Math.abs(diff)}`}
    >
      {isUp ? '↑' : '↓'}
      <span style={{ fontSize: 9 }}>{Math.abs(diff)}</span>
    </span>
  )
}

function TraderAvatar({ trader }: { trader: RankedTraderV2 }) {
  const [imgError, setImgError] = useState(false)
  const showFallback = !trader.avatar_url || imgError
  const initial = getAvatarInitial(getTraderDisplayName(trader))

  return (
    <div
      className="flex-shrink-0 flex items-center justify-center overflow-hidden"
      style={{
        width: 36,
        height: 36,
        minWidth: 36,
        borderRadius: '50%',
        background: getAvatarGradient(trader.trader_key),
        border: '2px solid var(--color-border-primary)',
        position: 'relative',
      }}
    >
      <span
        style={{
          color: 'white',
          fontSize: 14,
          fontWeight: 700,
          lineHeight: 1,
          textTransform: 'uppercase',
        }}
      >
        {initial}
      </span>
      {!showFallback && (
        <Image
          src={trader.avatar_url!}
          alt=""
          width={36}
          height={36}
          sizes="36px"
          className="object-cover"
          loading="lazy"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', borderRadius: '50%' }}
          onError={() => setImgError(true)}
        />
      )}
    </div>
  )
}

/** Arena Score badge with color gradient: red -> orange -> yellow -> green -> purple(legendary) */
function ScoreBadge({ score }: { score: number }) {
  const hex = getScoreColorHex(score)
  const cssColor = getScoreColor(score)
  // Progress bar width as percentage of 100
  const pct = Math.min(100, Math.max(0, score))
  return (
    <span
      className="arena-score-badge"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        position: 'relative',
        padding: '3px 10px',
        borderRadius: tokens.radius.md,
        fontSize: 13,
        fontWeight: 700,
        fontFamily: tokens.typography.fontFamily.mono.join(','),
        background: `linear-gradient(135deg, ${hex}25, ${hex}10)`,
        color: cssColor,
        border: `1px solid ${hex}45`,
        overflow: 'hidden',
        minWidth: 56,
        justifyContent: 'center',
        boxShadow: score >= 90
          ? `0 0 12px ${hex}50, 0 0 4px ${hex}30`
          : score >= 80
            ? `0 0 8px ${hex}30`
            : 'none',
        textShadow: score >= 90 ? `0 0 8px ${hex}60` : 'none',
        animation: score >= 95 ? 'score-glow 2s ease-in-out infinite' : undefined,
      }}
    >
      {/* Score progress fill bar */}
      <span
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: `${pct}%`,
          background: `${hex}18`,
          transition: 'width 0.4s ease',
          borderRadius: 'inherit',
        }}
      />
      <span style={{ position: 'relative', zIndex: 1 }}>{score.toFixed(1)}</span>
    </span>
  )
}

/** Get exchange logo URL from QUICK_FILTER_EXCHANGES */
function getExchangeLogo(platform: string): string | undefined {
  return QUICK_FILTER_EXCHANGES.find(ex => ex.value === platform)?.logo
}

function TraderRow({ trader }: { trader: RankedTraderV2 }) {
  const metrics = trader.metrics
  const roiColor = metrics.roi >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error
  const traderUrl = `/trader/${encodeURIComponent(trader.trader_key)}?platform=${trader.platform}`
  const exchangeLogo = getExchangeLogo(trader.platform)

  // Top 3 get subtle background
  const top3Bg = trader.rank === 1
    ? 'linear-gradient(90deg, var(--color-gold-bg, rgba(212,175,55,0.06)) 0%, transparent 100%)'
    : trader.rank === 2
    ? 'linear-gradient(90deg, var(--color-silver-bg, rgba(192,192,192,0.06)) 0%, transparent 100%)'
    : trader.rank === 3
    ? 'linear-gradient(90deg, var(--color-bronze-bg, rgba(205,127,50,0.06)) 0%, transparent 100%)'
    : undefined

  return (
    <Link
      href={traderUrl}
      className="grid ranking-table-grid gap-2 px-4 items-center border-b last:border-b-0 ranking-row-hover"
      style={{
        borderColor: tokens.colors.border.primary + '30',
        textDecoration: 'none',
        transition: `all ${tokens.transition.base}`,
        minHeight: 56,
        paddingTop: 10,
        paddingBottom: 10,
        background: top3Bg || (trader.rank > 3 && trader.rank % 2 === 0 ? 'var(--overlay-hover, rgba(255,255,255,0.02))' : undefined),
      }}
    >
      {/* Rank */}
      <div className="text-sm font-medium" style={{ color: tokens.colors.text.secondary, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {trader.rank <= 3 ? (
          <span
            className="inline-flex items-center justify-center"
            style={{
              width: 30, height: 30, borderRadius: '50%',
              fontSize: 13, fontWeight: 700,
              background: trader.rank === 1
                ? 'linear-gradient(135deg, var(--color-medal-gold), var(--color-medal-gold-end))'
                : trader.rank === 2
                ? 'linear-gradient(135deg, var(--color-medal-silver), #A0A0A0)'
                : 'linear-gradient(135deg, var(--color-medal-bronze), #A0522D)',
              color: trader.rank === 1 ? tokens.colors.bg.primary : tokens.colors.text.primary,
              boxShadow: trader.rank === 1
                ? '0 0 8px var(--color-gold-glow)'
                : trader.rank === 2
                ? '0 0 6px var(--color-silver-glow)'
                : '0 0 6px var(--color-bronze-glow)',
            }}
          >
            {trader.rank}
          </span>
        ) : (
          <span className="tabular-nums" style={{ fontSize: 13 }}>{trader.rank}</span>
        )}
        <RankChangeIndicator currentRank={trader.rank} metricRank={metrics.rank} />
      </div>

      {/* Trader info */}
      <div className="flex items-center gap-3 min-w-0">
        <TraderAvatar trader={trader} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold truncate" style={{ color: tokens.colors.text.primary, lineHeight: 1.3 }}>
            {getTraderDisplayName(trader)}
          </div>
          <div className="text-xs flex items-center gap-1.5" style={{ color: tokens.colors.text.tertiary, marginTop: 2 }}>
            {exchangeLogo && (
              <img
                src={exchangeLogo}
                alt=""
                width={14}
                height={14}
                loading="lazy"
                style={{ borderRadius: '50%', flexShrink: 0, opacity: 0.8 }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
              />
            )}
            <span>{EXCHANGE_NAMES[trader.platform] || trader.platform.replace('_', ' ')}</span>
            {SOURCE_TYPE_MAP[trader.platform] === 'web3' && <Web3VerifiedBadge size="sm" />}
          </div>
        </div>
      </div>

      {/* ROI */}
      <div className="text-right text-sm font-bold tabular-nums" style={{ color: roiColor }}>
        {formatROI(metrics.roi)}
      </div>

      {/* PnL */}
      <div className="text-right text-sm col-pnl tabular-nums" style={{ color: metrics.pnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error }}>
        {formatPnL(metrics.pnl)}
      </div>

      {/* Win% */}
      <div 
        className="text-right text-sm col-winrate tabular-nums" 
        style={{ color: metrics.win_rate != null ? (metrics.win_rate > 50 ? tokens.colors.accent.success : tokens.colors.text.secondary) : tokens.colors.text.tertiary }}
        title={metrics.win_rate == null ? (getPlatformNote(trader.platform) || 'Win rate not provided by this platform') : undefined}
      >
        {metrics.win_rate != null ? `${metrics.win_rate.toFixed(1)}%` : (
          <span style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary, cursor: 'help' }}>&mdash;</span>
        )}
      </div>

      {/* MDD */}
      <div 
        className="text-right text-sm col-mdd tabular-nums" 
        style={{ color: metrics.max_drawdown != null ? tokens.colors.accent.error : tokens.colors.text.tertiary }}
        title={metrics.max_drawdown == null ? (getPlatformNote(trader.platform) || 'Drawdown not provided by this platform') : undefined}
      >
        {metrics.max_drawdown != null ? `-${metrics.max_drawdown.toFixed(1)}%` : (
          <span style={{ fontSize: tokens.typography.fontSize.xs, color: tokens.colors.text.tertiary, cursor: 'help' }}>&mdash;</span>
        )}
      </div>

      {/* Score */}
      <div className="text-right col-score">
        {metrics.arena_score != null ? (
          <ScoreBadge score={metrics.arena_score} />
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
