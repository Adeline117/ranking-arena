'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../Base'
import { useToast } from '../UI/Toast'
import RankingTable, { type Trader } from '../Features/RankingTable'
import TimeRangeSelector from './TimeRangeSelector'
import type { TimeRange } from './hooks/useTraderData'
import { CategoryType, filterByCategory } from '../Features/CategoryRankingTabs'
import { useSubscription } from './hooks/useSubscription'
import { useLanguage } from '../Utils/LanguageProvider'

interface RankingSectionProps {
  traders: Trader[]
  loading: boolean
  isLoggedIn: boolean
  activeTimeRange: TimeRange
  onTimeRangeChange: (range: TimeRange) => void
  lastUpdated?: string | null
}

/**
 * 排行榜区域组件
 * 包含时间选择器和排行榜表格
 */

// 格式化更新时间为相对时间
function formatLastUpdated(lastUpdated: string | null | undefined, language: string): string {
  if (!lastUpdated) return ''

  const date = new Date(lastUpdated)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)

  if (diffMins < 1) {
    return language === 'zh' ? '刚刚更新' : 'Just updated'
  } else if (diffMins < 60) {
    return language === 'zh' ? `${diffMins} 分钟前更新` : `Updated ${diffMins}m ago`
  } else if (diffHours < 24) {
    return language === 'zh' ? `${diffHours} 小时前更新` : `Updated ${diffHours}h ago`
  } else {
    const diffDays = Math.floor(diffHours / 24)
    return language === 'zh' ? `${diffDays} 天前更新` : `Updated ${diffDays}d ago`
  }
}

export default function RankingSection({
  traders,
  loading,
  isLoggedIn,
  activeTimeRange,
  onTimeRangeChange,
  lastUpdated,
}: RankingSectionProps) {
  const router = useRouter()
  const { showToast } = useToast()
  const { language, t } = useLanguage()
  const { isPro, isLoading: premiumLoading } = useSubscription()
  
  // 分类状态
  const [category, setCategory] = useState<CategoryType>('all')
  
  const source = traders.length > 0 ? traders[0].source : 'all'
  
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
      {/* 顶部工具栏 - 时间选择器 + 更新时间 */}
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
        {/* 数据更新时间指示器 */}
        {lastUpdated && !loading && (
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: tokens.colors.text.tertiary,
            }}
          >
            <Box
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: tokens.colors.accent.success,
              }}
            />
            {formatLastUpdated(lastUpdated, language)}
          </Box>
        )}
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
      />
    </Box>
  )
}
