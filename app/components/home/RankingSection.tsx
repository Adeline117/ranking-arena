'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import { useToast } from '../ui/Toast'
import RankingTable, { type Trader } from '../ranking/RankingTable'
import TimeRangeSelector from './TimeRangeSelector'
import type { TimeRange } from './hooks/useTraderData'
import { CategoryType, filterByCategory } from '../ranking/CategoryRankingTabs'
import { useSubscription } from './hooks/useSubscription'
import { useLanguage } from '../Providers/LanguageProvider'
import DataFreshnessIndicator from '../ui/DataFreshnessIndicator'
import { CreateSnapshotButton } from '../snapshot'
import AdvancedFilter, { type FilterConfig, type SavedFilter } from '../premium/AdvancedFilter'

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
}: RankingSectionProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { showToast } = useToast()
  const { language, t } = useLanguage()
  const { isPro, isLoading: premiumLoading } = useSubscription()

  // 分类状态
  const [category, setCategory] = useState<CategoryType>('all')

  // 高级筛选状态
  const [showAdvancedFilter, setShowAdvancedFilter] = useState(false)
  const [filterConfig, setFilterConfig] = useState<FilterConfig>({})
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([])

  // 从 URL 恢复筛选状态
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
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 同步筛选状态到 URL
  const syncFilterToUrl = useCallback((config: FilterConfig) => {
    const params = new URLSearchParams(window.location.search)

    // 清除旧的筛选参数
    ;['roi_min', 'roi_max', 'dd_min', 'dd_max', 'min_pnl', 'min_score', 'min_wr', 'exchange', 'fcat'].forEach(k => params.delete(k))

    // 写入新参数
    if (config.roi_min != null) params.set('roi_min', String(config.roi_min))
    if (config.roi_max != null) params.set('roi_max', String(config.roi_max))
    if (config.drawdown_min != null) params.set('dd_min', String(config.drawdown_min))
    if (config.drawdown_max != null) params.set('dd_max', String(config.drawdown_max))
    if (config.min_pnl != null) params.set('min_pnl', String(config.min_pnl))
    if (config.min_score != null) params.set('min_score', String(config.min_score))
    if (config.min_win_rate != null) params.set('min_wr', String(config.min_win_rate))
    if (config.exchange?.length) params.set('exchange', config.exchange.join(','))
    if (config.category?.length) params.set('fcat', config.category.join(','))

    const qs = params.toString()
    const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
    window.history.replaceState(null, '', newUrl)
  }, [])

  // 筛选变更处理
  const handleFilterChange = useCallback((config: FilterConfig) => {
    setFilterConfig(config)
    syncFilterToUrl(config)
  }, [syncFilterToUrl])

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
    try {
      const res = await fetch('/api/saved-filters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, filter_config: filterConfig }),
      })
      if (res.ok) {
        const data = await res.json()
        setSavedFilters(prev => [...prev, data.filter])
        showToast(language === 'zh' ? '筛选已保存' : 'Filter saved', 'success')
      }
    } catch {
      showToast(language === 'zh' ? '保存失败' : 'Save failed', 'error')
    }
  }

  const handleLoadFilter = (filter: SavedFilter) => {
    handleFilterChange(filter.filter_config)
  }

  const handleDeleteFilter = async (filterId: string) => {
    try {
      await fetch(`/api/saved-filters/${filterId}`, { method: 'DELETE' })
      setSavedFilters(prev => prev.filter(f => f.id !== filterId))
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

  // Get unique data sources from traders
  const dataSources = [...new Set(traders.map(t => t.source).filter(Boolean))]

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

  // 根据分类过滤交易员，再应用高级筛选
  const categoryFiltered = category === 'all'
    ? traders
    : traders.filter(t => t.source && filterByCategory(t.source, category))
  const filteredTraders = hasActiveFilters
    ? applyAdvancedFilter(categoryFiltered, filterConfig)
    : categoryFiltered

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
      {/* 顶部工具栏 - 时间选择器 + 数据新鲜度 */}
      <Box
        className="ranking-toolbar"
        style={{
          marginBottom: tokens.spacing[3],
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: tokens.spacing[2],
        }}
      >
        <TimeRangeSelector
          activeRange={activeTimeRange}
          onChange={onTimeRangeChange}
          disabled={loading}
        />
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
          {/* 快照分享按钮 */}
          {!loading && isLoggedIn && (
            <CreateSnapshotButton
              timeRange={activeTimeRange}
              onSuccess={(snapshot) => {
                const url = snapshot.shareUrl || `${window.location.origin}/s/${snapshot.shareToken}`
                navigator.clipboard.writeText(url).then(() => {
                  showToast(language === 'zh' ? '快照已创建，链接已复制' : 'Snapshot created, link copied', 'success')
                }).catch(() => {
                  showToast(language === 'zh' ? `快照已创建: ${url}` : `Snapshot created: ${url}`, 'success')
                })
              }}
              disabled={loading || traders.length === 0}
            />
          )}
          {/* 数据新鲜度指示器 */}
          {!loading && (
            <DataFreshnessIndicator
              lastUpdated={lastUpdated}
              updateTier="standard"
              showDetails={true}
              size="sm"
            />
          )}
        </Box>
      </Box>
      
      {/* 高级筛选面板 */}
      {showAdvancedFilter && isPro && (
        <Box style={{ marginBottom: tokens.spacing[3] }}>
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
        error={null}
        onRetry={undefined}
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
            {dataSources.slice(0, 5).map((src, i) => (
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
            <Box style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
              <span>{formatLastUpdated(lastUpdated)}</span>
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
          opacity: 0.7,
        }}
      >
        {t('notInvestmentAdvice')}
      </Box>
    </Box>
  )
}
