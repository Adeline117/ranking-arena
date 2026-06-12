/**
 * compute-leaderboard / fetch-phase1-arena  (ENDGAME read path)
 *
 * Drop-in replacement for fetchPhase1FromV2: pulls ranking inputs from the
 * new arena.* pipeline via the `arena_score_inputs` public RPC instead of the
 * legacy trader_latest table. Same signature, same TraderRow shape, same
 * addToTraderMap streaming — the caller chooses which reader to run via the
 * COMPUTE_READ_SOURCE flag (see route.ts).
 *
 * WHY this is simpler than the legacy reader: arena.* is not PostgREST-exposed
 * (all reads go through SECURITY DEFINER RPCs), and the RPC already caps each
 * platform to its top-N by board rank and drops stale sources server-side. One
 * RPC call per window replaces ~35 per-platform queries + their 30D fallbacks.
 * The legacy reader's per-source freshness/fallback/JSONB-fallback machinery
 * is unnecessary here: the publish gate guarantees every row came from a
 * count-check-PASSED snapshot, and the view already collapses to the latest
 * passed snapshot per source/timeframe.
 */

import { getSupabaseAdmin } from '@/lib/api'
import type { Period } from '@/lib/utils/arena-score'
import { createLogger } from '@/lib/utils/logger'
import type { TraderRow } from './trader-row'

const logger = createLogger('compute-leaderboard')

// Matches the legacy per-platform .limit(1000) cap; the RPC enforces it on
// board rank (more correct than freshest-by-updated_at).
const PER_PLATFORM_LIMIT = 1000
// Drop sources whose latest PASSED snapshot is older than this. Tier-A cadence
// is ~5h; 48h leaves generous slack for slow cadences while shedding genuinely
// dead crawls (legacy used 6-12h per-source, but that over-dropped sources
// mid-cadence — the count-check gate already guarantees quality here).
const MAX_AGE_HOURS = 48

interface RpcRow {
  platform: string
  trader_key: string
  board_rank: number | null
  roi_pct: number | string | null
  pnl_usd: number | string | null
  win_rate: number | string | null
  max_drawdown: number | string | null
  copiers: number | string | null
  trades_count: number | string | null
  sharpe_ratio: number | string | null
  sortino_ratio: number | string | null
  calmar_ratio: number | string | null
  volatility_pct: number | string | null
  trader_kind: string | null
  as_of: string
}

const num = (v: number | string | null): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Run Phase 1 for the given season against the arena pipeline. Mutates
 * traderMap via addToTraderMap. Returns per-source row counts (parity with
 * fetchPhase1FromV2's diagnostic return).
 */
export async function fetchPhase1FromArena(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  season: Period,
  addToTraderMap: (row: TraderRow) => void
): Promise<Map<string, number>> {
  const countBySource = new Map<string, number>()

  const { data, error } = await (supabase as any).rpc('arena_score_inputs', {
    p_window: season,
    p_per_platform_limit: PER_PLATFORM_LIMIT,
    p_max_age_hours: MAX_AGE_HOURS,
  })

  if (error) {
    logger.error(
      `[${season}] arena_score_inputs RPC failed: ${error.message} (code=${error.code}) — NO arena rows loaded`
    )
    return countBySource
  }
  const rows = (data ?? []) as RpcRow[]
  if (rows.length === 0) {
    logger.warn(`[${season}] arena_score_inputs returned 0 rows`)
    return countBySource
  }

  for (const d of rows) {
    addToTraderMap({
      source: d.platform,
      source_trader_id: d.trader_key,
      roi: num(d.roi_pct),
      pnl: num(d.pnl_usd),
      win_rate: num(d.win_rate),
      max_drawdown: num(d.max_drawdown),
      trades_count: num(d.trades_count),
      followers: null, // arena pipeline does not surface a generic follower count
      copiers: num(d.copiers),
      arena_score: null, // recomputed downstream; the input value is unused
      captured_at: d.as_of,
      full_confidence_at: null,
      profitability_score: null,
      risk_control_score: null,
      execution_score: null,
      score_completeness: null,
      trading_style: null,
      avg_holding_hours: null,
      style_confidence: null,
      sharpe_ratio: num(d.sharpe_ratio),
      sortino_ratio: num(d.sortino_ratio),
      profit_factor: null,
      calmar_ratio: num(d.calmar_ratio),
      trader_type: d.trader_kind === 'bot' ? 'bot' : null,
      metrics_estimated: false,
    })
    countBySource.set(d.platform, (countBySource.get(d.platform) ?? 0) + 1)
  }

  logger.info(
    `[${season}] arena_score_inputs: ${rows.length} rows across ${countBySource.size} platforms`
  )
  return countBySource
}
