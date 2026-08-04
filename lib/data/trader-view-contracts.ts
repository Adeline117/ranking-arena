import type { TraderPerformance } from '@/lib/data/trader-types'
import type {
  GmxMaxCapitalRoiDisclosure,
  GmxRealizedNetDisclosure,
} from '@/lib/data/serving/pnl-contract'
import type { NormalizedScoreConfidence } from '@/lib/data/trader/mappers'
import type { Period } from '@/lib/types/schema-mapping'

/** Shared legacy trader-view contract consumed by app views and serving adapters. */
export interface PositionHistoryEntry {
  symbol: string
  direction: 'long' | 'short'
  positionType: string
  marginMode: string
  openTime: string
  closeTime: string
  entryPrice: number
  exitPrice: number
  maxPositionSize: number
  closedSize: number
  pnlUsd: number
  pnlPct: number
  status: string
}

/** Shared performance view model consumed by the overview card and serving adapters. */
export interface ExtendedPerformance extends TraderPerformance {
  /** Source-specific PnL semantics, keyed to the exact rendered period. */
  pnlDisclosures?: Partial<Record<Period, GmxRealizedNetDisclosure>>
  /** Source-specific ROI formula, independently proven per rendered period. */
  roiDisclosures?: Partial<Record<Period, GmxMaxCapitalRoiDisclosure>>
  arena_score_7d?: number
  arena_score_30d?: number
  arena_score_90d?: number
  overall_score?: number
  sharpe_ratio?: number
  sharpe_ratio_30d?: number
  sharpe_ratio_7d?: number
  winning_positions?: number
  winning_positions_7d?: number
  winning_positions_30d?: number
  total_positions?: number
  total_positions_7d?: number
  total_positions_30d?: number
  // Per-period score breakdowns
  return_score_7d?: number
  return_score_30d?: number
  pnl_score?: number
  pnl_score_7d?: number
  pnl_score_30d?: number
  drawdown_score_7d?: number
  drawdown_score_30d?: number
  stability_score_7d?: number
  stability_score_30d?: number
  score_confidence?: NormalizedScoreConfidence | null
  score_confidence_7d?: NormalizedScoreConfidence | null
  score_confidence_30d?: NormalizedScoreConfidence | null
  // V3 Advanced Metrics
  sortino_ratio?: number
  sortino_ratio_7d?: number
  sortino_ratio_30d?: number
  calmar_ratio?: number
  calmar_ratio_7d?: number
  calmar_ratio_30d?: number
  alpha?: number
  alpha_7d?: number
  alpha_30d?: number
  arena_score_v3?: number
  arena_score_v3_7d?: number
  arena_score_v3_30d?: number
  trading_style?: string
  style_confidence?: number
  // Per-period additional stats
  trades_count?: number
  trades_count_7d?: number
  trades_count_30d?: number
  copiers_pnl?: number
  copiers_pnl_7d?: number
  copiers_pnl_30d?: number
  avg_holding_time_hours?: number
  avg_holding_time_hours_7d?: number
  avg_holding_time_hours_30d?: number
}
