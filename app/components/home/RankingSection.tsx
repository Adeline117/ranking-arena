'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
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
  const { showToast } = useToast()
  const { language, t } = useLanguage()
  const { isPro, isLoading: premiumLoading } = useSubscription()

  // 分类状态
  const [category, setCategory] = useState<CategoryType>('all')

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

  // 根据分类过滤交易员
  const filteredTraders = category === 'all'
    ? traders
    : traders.filter(t => t.source && filterByCategory(t.source, category))

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
