/**
 * Input shape shared by the anomaly services (lib/services/anomaly-*.ts).
 *
 * This file used to hold a second, unused ranking algorithm
 * (calculateRiskAdjustedReturn, detectSuspiciousTrader, rankTraders, …). No
 * app, worker or script called it, and it treated a MISSING drawdown as the
 * minimum drawdown — which would rank a trader with no risk data above every
 * measured one. It was removed rather than corrected; only the type that is
 * still imported remains. Rankings come from the publication pipeline
 * (lib/rankings/publication) and Arena Score (lib/utils/arena-score).
 */

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface TraderRankingData {
  id: string
  roi: number
  pnl: number
  win_rate: number | null
  max_drawdown: number | null
  trades_count: number | null
  source: string
}
