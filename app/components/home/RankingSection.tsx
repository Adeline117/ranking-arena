'use client'

import { useState, useEffect, useCallback, useRef, useTransition } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import { useToast } from '../ui/Toast'
import { type Trader } from '../ranking/RankingTable'

const RankingTable = dynamic(
  () => import('@/app/components/ranking/RankingTable').then(m => ({ default: m.RankingTable })),
  {
    loading: () => (
      <div style={{ minHeight: 600 }} className="ranking-table-container">
        {/* Simple skeleton - 20 placeholder rows */}
        {Array.from({ length: 20 }, (_, i) => (
          <div key={i} style={{ height: 52, background: 'rgba(255,255,255,0.03)', marginBottom: 2, borderRadius: 8 }} />
        ))}
      </div>
    ),
    ssr: false
  }
)
import TimeRangeSelector from './TimeRangeSelector'
import type { TimeRange } from './hooks/useTraderData'
import { CategoryType, filterByCategory } from '../ranking/CategoryRankingTabs'
import { useSubscription } from './hooks/useSubscription'
import { useLanguage } from '../Providers/LanguageProvider'
import type { FilterConfig, SavedFilter } from '../premium/AdvancedFilter'
import FilterPresets, { type PresetId, PRESETS } from '../ranking/FilterPresets'
import ExchangeFilter from '../ranking/ExchangeFilter'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { getCsrfHeaders } from '@/lib/api/client'

// Lazy load heavy components to reduce initial bundle
const AdvancedFilter = dynamic(() => import('../premium/AdvancedFilter'), {
  ssr: false,
  loading: () => (
    <Box style={{ padding: tokens.spacing[3], background: tokens.colors.bg.secondary, borderRadius: tokens.radius.md }}>
      <Box className="skeleton" style={{ height: 40, borderRadius: tokens.radius.sm }} />
    </Box>
  ),
})

const DataFreshnessIndicator = dynamic(() => import('../ui/DataFreshnessIndicator'), {
  ssr: false,
})

const ShareTop10Button = dynamic(() => import('../ranking/ShareTop10Button'), {
  ssr: false,
})

interface RankingSectionProps {
  traders: Trader[]
  loading: boolean
  isLoggedIn: boolean
  activeTimeRange: TimeRange
  onTimeRangeChange: (range: TimeRange) => void
  /** 数据最后更新时间 */
  lastUpdated?: string | null
  /** 错误信息 */
  error?: string | null
  /** 重试回调 */
  onRetry?: () => void
  /** Feature 4: Manual refresh callback */
  onRefresh?: () => void
  /** 所有可用的数据来源 */
  availableSources?: string[]
}

/**
 * 排行榜区域组件
 * 包含时间选择器和排行榜表格
 */

export default function RankingSection({
  traders,
  loading,
  isLoggedIn,
  activeTimeRange,
  onTimeRangeChange,
  lastUpdated,
  error,
  onRetry,
  onRefresh,
  availableSources,
}: RankingSectionProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { showToast } = useToast()
  const { language, t } = useLanguage()
  const { isPro, isLoading: premiumLoading } = useSubscription()
  const { getAuthHeaders } = useAuthSession()

  // 分类状态
  const [category, setCategory] = useState<CategoryType>('all')

  // 高级筛选状态
  const [showAdvancedFilter, setShowAdvancedFilter] = useState(false)
  const [filterConfig, setFilterConfig] = useState<FilterConfig>({})
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([])

  // Feature 6: Filter presets
  const [activePreset, setActivePreset] = useState<PresetId | null>(null)

  // Feature 8: Lifted sort/page/search state for URL sync
  const [sortColumn, setSortColumn] = useState<'score' | 'roi' | 'winrate' | 'mdd'>('score')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [currentPage, setCurrentPage] = useState(1)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedExchange, setSelectedExchange] = useState<string | null>(null)

  // 从 URL 恢复筛选状态 + Feature 8: sort/page/search/preset
  useEffect(() => {
    const config: FilterConfig = {}
    const roiMin = searchParams.get('roi_min')
    const roiMax = searchParams.get('roi_max')
    const ddMin = searchParams.get('dd_min')
    const ddMax = searchParams.get('dd_max')
    const minPnl = searchParams.get('min_pnl')
    const minScore = searchParams.get('min_score')
    const minWr = searchParams.get('min_wr')
    const exchange = searchParams.get('exchange')
    const fcat = searchParams.get('fcat')

    if (roiMin) config.roi_min = Number(roiMin)
    if (roiMax) config.roi_max = Number(roiMax)
    if (ddMin) config.drawdown_min = Number(ddMin)
    if (ddMax) config.drawdown_max = Number(ddMax)
    if (minPnl) config.min_pnl = Number(minPnl)
    if (minScore) config.min_score = Number(minScore)
    if (minWr) config.min_win_rate = Number(minWr)
    if (exchange) config.exchange = exchange.split(',')
    if (fcat) config.category = fcat.split(',')

    if (Object.keys(config).length > 0) {
      setFilterConfig(config)
      setShowAdvancedFilter(true)
    }

    // Feature 8: Restore sort/page/search/preset from URL
    const urlSort = searchParams.get('sort') as typeof sortColumn | null
    const urlOrder = searchParams.get('order') as 'asc' | 'desc' | null
    const urlPage = searchParams.get('page')
    const urlQ = searchParams.get('q')
    const urlPreset = searchParams.get('preset') as PresetId | null

    if (urlSort && ['score', 'roi', 'winrate', 'mdd'].includes(urlSort)) setSortColumn(urlSort)
    if (urlOrder && ['asc', 'desc'].includes(urlOrder)) setSortDir(urlOrder)
    if (urlPage) setCurrentPage(Math.max(1, parseInt(urlPage, 10) || 1))
    if (urlQ) setSearchQuery(urlQ)
    if (urlPreset && PRESETS.some(p => p.id === urlPreset)) setActivePreset(urlPreset)
    const urlEx = searchParams.get('ex')
    if (urlEx) setSelectedExchange(urlEx)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Saved filters feature removed - filters are session-only

  // Debounce ref for URL sync
  const syncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [, startTransition] = useTransition()

  // Feature 8: Sync all state to URL via replaceState (debounced for performance)
  const syncStateToUrl = useCallback((overrides: {
    config?: FilterConfig
    sort?: string
    order?: string
    page?: number
    q?: string
    preset?: string | null
    ex?: string | null
  } = {}) => {
    // Clear pending sync
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current)
    }

    // Debounce URL sync to reduce INP (increased from 150ms to 300ms)
    syncTimeoutRef.current = setTimeout(() => {
      // Wrap in startTransition to mark as non-urgent update
      startTransition(() => {
      const params = new URLSearchParams(window.location.search)
      const config = overrides.config ?? filterConfig

      // Clear old filter params
      ;['roi_min', 'roi_max', 'dd_min', 'dd_max', 'min_pnl', 'min_score', 'min_wr', 'exchange', 'fcat', 'sort', 'order', 'page', 'q', 'preset', 'ex'].forEach(k => params.delete(k))

      // Filter params
      if (config.roi_min != null) params.set('roi_min', String(config.roi_min))
      if (config.roi_max != null) params.set('roi_max', String(config.roi_max))
      if (config.drawdown_min != null) params.set('dd_min', String(config.drawdown_min))
      if (config.drawdown_max != null) params.set('dd_max', String(config.drawdown_max))
      if (config.min_pnl != null) params.set('min_pnl', String(config.min_pnl))
      if (config.min_score != null) params.set('min_score', String(config.min_score))
      if (config.min_win_rate != null) params.set('min_wr', String(config.min_win_rate))
      if (config.exchange?.length) params.set('exchange', config.exchange.join(','))
      if (config.category?.length) params.set('fcat', config.category.join(','))

      // Feature 8: Sort/page/search/preset
      const sort = overrides.sort ?? sortColumn
      const order = overrides.order ?? sortDir
      const page = overrides.page ?? currentPage
      const q = overrides.q ?? searchQuery
      const preset = overrides.preset !== undefined ? overrides.preset : activePreset

      if (sort && sort !== 'score') params.set('sort', sort)
      if (order && order !== 'desc') params.set('order', order)
      if (page && page > 1) params.set('page', String(page))
      if (q) params.set('q', q)
      if (preset) params.set('preset', preset)

      // Exchange filter
      const ex = overrides.ex !== undefined ? overrides.ex : selectedExchange
      if (ex) params.set('ex', ex)

        const qs = params.toString()
        const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
        window.history.replaceState(null, '', newUrl)
      })
    }, 300) // 300ms debounce (increased for better INP)
  }, [filterConfig, sortColumn, sortDir, currentPage, searchQuery, activePreset, selectedExchange])

  // Keep backward compatibility for syncFilterToUrl
  const syncFilterToUrl = useCallback((config: FilterConfig) => {
    syncStateToUrl({ config })
  }, [syncStateToUrl])

  // 筛选变更处理
  const handleFilterChange = useCallback((config: FilterConfig) => {
    setFilterConfig(config)
    syncFilterToUrl(config)
  }, [syncFilterToUrl])

  // Feature 8: Sort/page/search change handlers
  const handleSortChange = useCallback((col: 'score' | 'roi' | 'winrate' | 'mdd', dir: 'asc' | 'desc') => {
    setSortColumn(col)
    setSortDir(dir)
    setCurrentPage(1)
    syncStateToUrl({ sort: col, order: dir, page: 1 })
  }, [syncStateToUrl])

  const handlePageChange = useCallback((page: number) => {
    setCurrentPage(page)
    syncStateToUrl({ page })
  }, [syncStateToUrl])

  const handleSearchChange = useCallback((q: string) => {
    setSearchQuery(q)
    setCurrentPage(1)
    syncStateToUrl({ q, page: 1 })
  }, [syncStateToUrl])

  // Feature 6: Preset change handler
  const handlePresetChange = useCallback((preset: PresetId | null) => {
    setActivePreset(preset)
    setCurrentPage(1)
    syncStateToUrl({ preset, page: 1 })
  }, [syncStateToUrl])

  // Exchange filter change handler
  const handleExchangeChange = useCallback((exchange: string | null) => {
    setSelectedExchange(exchange)
    setCurrentPage(1)
    syncStateToUrl({ ex: exchange, page: 1 })
  }, [syncStateToUrl])

  // 客户端高级筛选函数
  const applyAdvancedFilter = (list: Trader[], config: FilterConfig): Trader[] => {
    return list.filter(trader => {
      // 交易所筛选
      if (config.exchange?.length) {
        const src = (trader.source || '').toLowerCase()
        if (!config.exchange.some(ex => src.startsWith(ex))) return false
      }
      // ROI 范围
      if (config.roi_min != null && (trader.roi || 0) < config.roi_min) return false
      if (config.roi_max != null && (trader.roi || 0) > config.roi_max) return false
      // 回撤范围
      if (config.drawdown_min != null && trader.max_drawdown != null && Math.abs(trader.max_drawdown) < config.drawdown_min) return false
      if (config.drawdown_max != null && trader.max_drawdown != null && Math.abs(trader.max_drawdown) > config.drawdown_max) return false
      // 最小 PnL
      if (config.min_pnl != null && (trader.pnl == null || trader.pnl < config.min_pnl)) return false
      // 最小 Arena Score
      if (config.min_score != null && (trader.arena_score == null || trader.arena_score < config.min_score)) return false
      // 最小胜率
      if (config.min_win_rate != null && (trader.win_rate == null || trader.win_rate < config.min_win_rate)) return false
      return true
    })
  }

  // Saved filter handlers
  const handleSaveFilter = async (name: string, description?: string) => {
    const authHeaders = getAuthHeaders()
    if (!authHeaders) {
      showToast(language === 'zh' ? '请先登录' : 'Please login first', 'error')
      return
    }
    try {
      const res = await fetch('/api/saved-filters', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
          ...getCsrfHeaders(),
        },
        body: JSON.stringify({ name, description, filter_config: filterConfig }),
      })
      if (res.ok) {
        const data = await res.json()
        setSavedFilters(prev => [...prev, data.filter])
        showToast(language === 'zh' ? '筛选已保存' : 'Filter saved', 'success')
      } else {
        const errorData = await res.json().catch(() => ({}))
        showToast(errorData.error || (language === 'zh' ? '保存失败' : 'Save failed'), 'error')
      }
    } catch {
      showToast(language === 'zh' ? '保存失败' : 'Save failed', 'error')
    }
  }

  const handleLoadFilter = (filter: SavedFilter) => {
    handleFilterChange(filter.filter_config)
  }

  const handleDeleteFilter = async (filterId: string) => {
    const authHeaders = getAuthHeaders()
    if (!authHeaders) {
      showToast(language === 'zh' ? '请先登录' : 'Please login first', 'error')
      return
    }
    try {
      const res = await fetch(`/api/saved-filters?id=${filterId}`, {
        method: 'DELETE',
        headers: {
          ...authHeaders,
          ...getCsrfHeaders(),
        },
      })
      if (res.ok) {
        setSavedFilters(prev => prev.filter(f => f.id !== filterId))
        showToast(language === 'zh' ? '已删除' : 'Deleted', 'success')
      } else {
        showToast(language === 'zh' ? '删除失败' : 'Delete failed', 'error')
      }
    } catch {
      showToast(language === 'zh' ? '删除失败' : 'Delete failed', 'error')
    }
  }

  // 检查是否有活动筛选
  const hasActiveFilters = Object.keys(filterConfig).some(key => {
    const value = filterConfig[key as keyof FilterConfig]
    if (Array.isArray(value)) return value.length > 0
    return value != null
  })

  const source = traders.length > 0 ? traders[0].source : 'all'

  // Get unique data sources - prefer availableSources from API if provided
  const dataSources = availableSources && availableSources.length > 0
    ? availableSources
    : [...new Set(traders.map(t => t.source).filter(Boolean))]

  // Format last updated time
  const formatLastUpdated = (dateStr: string | null | undefined) => {
    if (!dateStr) return null
    try {
      const date = new Date(dateStr)
      const now = new Date()
      const diffMs = now.getTime() - date.getTime()
      const diffMins = Math.floor(diffMs / 60000)

      if (diffMins < 1) return language === 'zh' ? '刚刚更新' : 'Just now'
      if (diffMins < 60) return language === 'zh' ? `${diffMins} 分钟前` : `${diffMins}m ago`
      const diffHours = Math.floor(diffMins / 60)
      if (diffHours < 24) return language === 'zh' ? `${diffHours} 小时前` : `${diffHours}h ago`
      return language === 'zh' ? `${Math.floor(diffHours / 24)} 天前` : `${Math.floor(diffHours / 24)}d ago`
    } catch {
      return null
    }
  }

  // 根据分类过滤交易员，再应用交易所筛选、预设和高级筛选
  const categoryFiltered = category === 'all'
    ? traders
    : traders.filter(t => t.source && filterByCategory(t.source, category))

  // 交易所筛选（所有用户可用）
  const exchangeFiltered = selectedExchange
    ? categoryFiltered.filter(t => t.source === selectedExchange)
    : categoryFiltered

  // Feature 6: Apply preset filter
  const presetFiltered = activePreset
    ? (() => {
        const presetConfig = PRESETS.find(p => p.id === activePreset)
        return presetConfig
          ? exchangeFiltered.filter(t => presetConfig.filter(t))
          : exchangeFiltered
      })()
    : exchangeFiltered

  const advancedFiltered = hasActiveFilters
    ? applyAdvancedFilter(presetFiltered, filterConfig)
    : presetFiltered

  // Free users: limit to top 50 traders; Pro users: full leaderboard
  const FREE_LEADERBOARD_LIMIT = 50
  const filteredTraders = isPro
    ? advancedFiltered
    : advancedFiltered.slice(0, FREE_LEADERBOARD_LIMIT)

  // Pro 功能提示
  const handleProRequired = () => {
    showToast(language === 'zh' ? '此功能需要 Pro 会员' : 'Pro membership required', 'info')
    router.push('/pricing')
  }

  return (
    <Box
      as="section"
      className="home-ranking-section"
      style={{
        minWidth: 0,
      }}
    >
      {/* 紧凑工具栏 */}
      <Box
        className="ranking-toolbar"
        style={{
          marginBottom: tokens.spacing[2],
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: tokens.spacing[1],
        }}
      >
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
          <TimeRangeSelector
            activeRange={activeTimeRange}
            onChange={onTimeRangeChange}
            disabled={loading}
          />
          <FilterPresets activePreset={activePreset} onPresetChange={handlePresetChange} />
        </Box>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[1], flexShrink: 0 }}>
          {!loading && filteredTraders.length > 0 && (
            <ShareTop10Button
              traders={filteredTraders}
              timeRange={activeTimeRange}
              disabled={loading}
            />
          )}
          {!loading && onRefresh && (
            <button
              onClick={onRefresh}
              title={language === 'zh' ? '刷新数据' : 'Refresh data'}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 24,
                height: 24,
                borderRadius: tokens.radius.sm,
                background: tokens.glass.bg.light,
                border: `1px solid ${tokens.colors.border.primary}`,
                color: tokens.colors.text.secondary,
                cursor: 'pointer',
                transition: `all ${tokens.transition.fast}`,
              }}
            >
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M1 4v6h6M23 20v-6h-6" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          {!loading && (
            <DataFreshnessIndicator
              lastUpdated={lastUpdated}
              updateTier="standard"
              showDetails={false}
              size="sm"
            />
          )}
        </Box>
      </Box>

      {/* 交易所筛选（所有用户可用） */}
      {!loading && dataSources.length > 1 && (
        <Box style={{ marginBottom: tokens.spacing[2] }}>
          <ExchangeFilter
            availableSources={dataSources}
            selectedExchange={selectedExchange}
            onExchangeChange={handleExchangeChange}
          />
        </Box>
      )}

      {/* 高级筛选面板 */}
      {showAdvancedFilter && isPro && (
        <Box style={{ marginBottom: tokens.spacing[2] }}>
          <AdvancedFilter
            currentFilter={filterConfig}
            savedFilters={savedFilters}
            onFilterChange={handleFilterChange}
            onSaveFilter={handleSaveFilter}
            onLoadFilter={handleLoadFilter}
            onDeleteFilter={handleDeleteFilter}
            isPro={isPro}
          />
        </Box>
      )}

      <RankingTable
        traders={filteredTraders}
        loading={loading || premiumLoading}
        loggedIn={isLoggedIn}
        source={source}
        timeRange={activeTimeRange}
        isPro={isPro}
        category={category}
        onCategoryChange={setCategory}
        onProRequired={handleProRequired}
        onFilterToggle={() => setShowAdvancedFilter(prev => !prev)}
        hasActiveFilters={hasActiveFilters}
        error={error}
        onRetry={onRetry}
        // Feature 8: Controlled props
        controlledSortColumn={sortColumn}
        controlledSortDir={sortDir}
        controlledPage={currentPage}
        controlledSearchQuery={searchQuery}
        onSortChange={handleSortChange}
        onPageChange={handlePageChange}
        onSearchChange={handleSearchChange}
      />

      {/* Data source and update time info */}
      {!loading && traders.length > 0 && (
        <Box
          style={{
            marginTop: tokens.spacing[3],
            padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
            background: tokens.glass.bg.light,
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.colors.border.secondary}`,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: tokens.spacing[2],
            fontSize: tokens.typography.fontSize.xs,
            color: tokens.colors.text.tertiary,
          }}
        >
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], flexWrap: 'wrap' }}>
            <span>{language === 'zh' ? '数据来源:' : 'Sources:'}</span>
            {dataSources.slice(0, 5).map((src) => (
              <span
                key={src}
                style={{
                  padding: '2px 6px',
                  background: tokens.colors.bg.secondary,
                  borderRadius: tokens.radius.sm,
                  fontWeight: tokens.typography.fontWeight.semibold,
                  textTransform: 'capitalize',
                }}
              >
                {src}
              </span>
            ))}
            {dataSources.length > 5 && (
              <span>+{dataSources.length - 5}</span>
            )}
          </Box>
          {lastUpdated && (
            <Box suppressHydrationWarning style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
              <span suppressHydrationWarning>{formatLastUpdated(lastUpdated)}</span>
            </Box>
          )}
        </Box>
      )}

      {/* Compliance disclaimer */}
      <Box
        style={{
          marginTop: tokens.spacing[2],
          textAlign: 'center',
          fontSize: tokens.typography.fontSize.xs,
          color: tokens.colors.text.tertiary,
        }}
      >
        {t('notInvestmentAdvice')}
      </Box>
    </Box>
  )
}
