/**
 * Job Runner Types
 * Self-contained types for the worker (no @/ path aliases)
 */

export type SnapshotWindow = '7D' | '30D' | '90D'

export type JobType = 'full_refresh' | 'profile_only' | 'snapshot_only' | 'timeseries_only'
export type JobStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled'
export type SeriesType = 'equity_curve' | 'daily_pnl' | 'asset_breakdown'

export interface RefreshJobRow {
  id: string
  job_type: JobType
  platform: string
  trader_key: string
  priority: number
  status: JobStatus
  attempts: number
  max_attempts: number
  next_run_at: string
  locked_at: string | null
  locked_by: string | null
  started_at: string | null
  completed_at: string | null
  last_error: string | null
  result: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface SnapshotMetrics {
  roi: number
  pnl: number
  win_rate: number | null
  max_drawdown: number | null
  trades_count: number | null
  followers: number | null
  aum: number | null
  arena_score: number | null
  return_score: number | null
  drawdown_score: number | null
  stability_score: number | null
  rank: number | null
}

export interface ConnectorTraderProfile {
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  bio: string | null
  follower_count: number | null
  copier_count: number | null
  aum: number | null
  tags: string[]
}

export interface ConnectorSnapshot {
  trader_key: string
  window: SnapshotWindow
  metrics: SnapshotMetrics
  quality_flags: {
    is_suspicious?: boolean
    suspicion_reasons?: string[]
    data_completeness?: number
  }
}

export interface ConnectorTimeseries {
  trader_key: string
  series_type: SeriesType
  data: unknown[]
}

/**
 * Interface that all platform connectors in the worker must implement.
 */
export interface ConnectorInterface {
  fetchTraderProfile(traderKey: string): Promise<ConnectorTraderProfile | null>
  fetchTraderSnapshot(traderKey: string, window: SnapshotWindow): Promise<ConnectorSnapshot | null>
  fetchTimeseries(traderKey: string): Promise<ConnectorTimeseries[]>
}
