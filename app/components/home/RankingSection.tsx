'use client'

import { Box } from '../base'
import { RankingTable, type Trader } from '../ranking/RankingTable'
import type { TimeRange } from './hooks/useTraderData'

import AdvancedFilterPanel from './AdvancedFilterPanel'
import FilterStatusMessages from './FilterStatusMessages'
import ProUpgradeCTA from './ProUpgradeCTA'
import RankingFooter from './RankingFooter'
import TimeRangeSelector from './TimeRangeSelector'
import { useRankingFilters, FREE_LEADERBOARD_LIMIT } from './useRankingFilters'

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
}: RankingSectionProps) {
  // TEMPORARY: Bypass useRankingFilters to isolate infinite loop
  return (
    <Box
      as="section"
      className="home-ranking-section"
      style={{
        minWidth: 0,
        contain: 'layout style',
      }}
    >
      {/* Time range selector (7D / 30D / 90D) */}
      <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 8 }}>
        <TimeRangeSelector
          activeRange={activeTimeRange}
          onChange={onTimeRangeChange}
          disabled={loading}
        />
      </Box>

      <RankingTable
        traders={traders}
        loading={loading}
        loggedIn={isLoggedIn}
        source={traders.length > 0 ? traders[0].source : 'all'}
        timeRange={activeTimeRange}
        error={error}
        onRetry={onRetry}
      />
    </Box>
  )
}
