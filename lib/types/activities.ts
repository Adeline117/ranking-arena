/**
 * Trader activity types for the auto-generated feed.
 */

export type ActivityType =
  | 'rank_up'
  | 'roi_milestone'
  | 'score_high'
  | 'win_streak'
  | 'entered_top10'
  | 'large_profit'

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface TraderActivity {
  id: string
  source: string
  source_trader_id: string
  handle: string | null
  avatar_url: string | null
  activity_type: ActivityType
  activity_text: string
  metric_value: number | null
  metric_label: string | null
  occurred_at: string
}

export interface ActivityFeedResponse {
  activities: TraderActivity[]
  pagination: {
    limit: number
    hasMore: boolean
    nextCursor: string | null
  }
}

/**
 * Visual config per activity type.
 * Intentionally kept as plain data — no JSX here.
 */
export const ACTIVITY_META: Record<
  ActivityType,
  { label: string; colorVar: string; iconName: string }
> = {
  rank_up: {
    label: 'Rank Up',
    colorVar: 'var(--color-accent-success)',
    iconName: 'trending-up',
  },
  entered_top10: {
    label: 'Top 10',
    colorVar: 'var(--color-accent-success)',
    iconName: 'trophy',
  },
  roi_milestone: {
    label: 'ROI',
    colorVar: 'var(--color-sentiment-bull)',
    iconName: 'bar-chart',
  },
  score_high: {
    label: 'Arena Score',
    colorVar: 'var(--color-brand)',
    iconName: 'star',
  },
  win_streak: {
    label: 'Win Streak',
    colorVar: 'var(--color-accent-warning, #FFB800)',
    iconName: 'zap',
  },
  large_profit: {
    label: 'Large Profit',
    colorVar: '#C9A227',
    iconName: 'dollar-sign',
  },
}
