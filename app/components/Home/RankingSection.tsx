'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../Base'
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
}

/**
 * 排行榜区域组件
 * 包含时间选择器和排行榜表格
 */
// 图标组件
const FilterIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const CompareIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="7" height="18" rx="1" />
    <rect x="14" y="3" width="7" height="18" rx="1" />
  </svg>
)

const LockIcon = ({ size = 10 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M19 11H5C3.9 11 3 11.9 3 13V20C3 21.1 3.9 22 5 22H19C20.1 22 21 21.1 21 20V13C21 11.9 20.1 11 19 11Z" />
    <path d="M7 11V7C7 4.2 9.2 2 12 2C14.8 2 17 4.2 17 7V11" stroke="currentColor" strokeWidth="2" fill="none" />
  </svg>
)

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
      {/* 顶部工具栏 */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: tokens.spacing[4],
          gap: tokens.spacing[3],
          flexWrap: 'wrap',
      }}
    >
      <TimeRangeSelector
        activeRange={activeTimeRange}
        onChange={onTimeRangeChange}
        disabled={loading}
      />
        
        {/* Pro 工具按钮 */}
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          {/* 高级筛选按钮 */}
          <Box
            onClick={isPro ? () => {} : handleProRequired}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--color-border-primary)',
              color: isPro ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)',
              cursor: 'pointer',
              transition: 'all 0.2s',
              opacity: isPro ? 1 : 0.6,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: 600,
            }}
            onMouseEnter={(e) => {
              if (isPro) {
                e.currentTarget.style.borderColor = 'var(--color-pro-gradient-start)'
                e.currentTarget.style.color = 'var(--color-pro-gradient-start)'
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--color-border-primary)'
              e.currentTarget.style.color = isPro ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)'
            }}
          >
            <FilterIcon size={12} />
            <span>{t('advancedFilter')}</span>
            {!isPro && <LockIcon size={10} />}
          </Box>

          {/* 对比按钮 */}
          <Link
            href={isPro ? '/compare' : '/pricing'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              background: isPro ? 'var(--color-pro-glow)' : 'var(--color-bg-secondary)',
              border: isPro ? '1px solid var(--color-pro-gradient-start)' : '1px solid var(--color-border-primary)',
              color: isPro ? 'var(--color-pro-gradient-start)' : 'var(--color-text-tertiary)',
              textDecoration: 'none',
              cursor: 'pointer',
              transition: 'all 0.2s',
              opacity: isPro ? 1 : 0.6,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: 600,
            }}
            onMouseEnter={(e) => {
              if (isPro) {
                e.currentTarget.style.background = 'var(--color-pro-badge-bg)'
                e.currentTarget.style.color = '#fff'
              }
            }}
            onMouseLeave={(e) => {
              if (isPro) {
                e.currentTarget.style.background = 'var(--color-pro-glow)'
                e.currentTarget.style.color = 'var(--color-pro-gradient-start)'
              }
            }}
          >
            <CompareIcon size={12} />
            <span>{t('traderCompare')}</span>
            {!isPro && <LockIcon size={10} />}
          </Link>
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
      />
    </Box>
  )
}
