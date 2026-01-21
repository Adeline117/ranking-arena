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
import { useLanguage } from '../utils/LanguageProvider'

interface RankingSectionProps {
  traders: Trader[]
  loading: boolean
  isLoggedIn: boolean
  activeTimeRange: TimeRange
  onTimeRangeChange: (range: TimeRange) => void
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
      {/* 顶部工具栏 - 时间选择器 */}
      <Box
        className="ranking-toolbar"
        style={{
          marginBottom: tokens.spacing[3],
      }}
    >
      <TimeRangeSelector
        activeRange={activeTimeRange}
        onChange={onTimeRangeChange}
        disabled={loading}
      />
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
