'use client'

import { Box } from '../Base'
import RankingTable, { type Trader } from '../Features/RankingTable'
import TimeRangeSelector from './TimeRangeSelector'
import type { TimeRange } from './hooks/useTraderData'

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
  const source = traders.length > 0 ? traders[0].source : 'all'

  return (
    <Box
      as="section"
      className="home-ranking-section"
      style={{
        minWidth: 0,
      }}
    >
      <TimeRangeSelector
        activeRange={activeTimeRange}
        onChange={onTimeRangeChange}
        disabled={loading}
      />
      
      <RankingTable
        traders={traders}
        loading={loading}
        loggedIn={isLoggedIn}
        source={source}
        timeRange={activeTimeRange}
      />
    </Box>
  )
}
