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

// Defense-in-depth sanity floor (root-cause-of-root-cause for the 2026-06-13
// collapse): the original RPC silently truncated at PostgREST's ~1000-row cap,
// the read returned only bitget, and compute's platform cleanup then WIPED
// every other source from leaderboard_ranks. A degraded/partial read must NEVER
// be allowed to reach the cleanup. If the read is implausibly small we THROW —
// the compute aborts and leaves the existing leaderboard untouched (stale beats
// collapsed). Normal reads are 15k+ rows across 18-26 platforms.
const MIN_PLAUSIBLE_SOURCES = 10
const MIN_PLAUSIBLE_ROWS = 3000

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
  board_as_of: string
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

  // Use the jsonb variant: a table-returning RPC is capped at PostgREST's
  // ~1000-row limit (the cause of the 06-13 collapse), but a single jsonb row
  // carrying the whole array has no row-count cap.
  const { data, error } = await (supabase as any).rpc('arena_score_inputs_json', {
    p_window: season,
    p_per_platform_limit: PER_PLATFORM_LIMIT,
    p_max_age_hours: MAX_AGE_HOURS,
  })

  // THROW (not silent empty return): an errored read must abort the compute, not
  // hand it an empty map that the cleanup turns into a wiped leaderboard.
  if (error) {
    throw new Error(
      `[${season}] arena_score_inputs_json RPC failed: ${error.message} (code=${error.code})`
    )
  }
  const rows = (Array.isArray(data) ? data : []) as RpcRow[]
  if (rows.length === 0) {
    throw new Error(
      `[${season}] arena_score_inputs_json returned 0 rows — aborting (would collapse leaderboard)`
    )
  }

  // Fail the entire read before mutating traderMap when the RPC cannot prove
  // the independent source-board watermark. Row `as_of` is metric observation
  // time and must never be substituted for board publication time.
  const invalidBoardRow = rows.find(
    (row) =>
      typeof row.board_as_of !== 'string' ||
      row.board_as_of.trim() === '' ||
      !Number.isFinite(Date.parse(row.board_as_of))
  )
  if (invalidBoardRow) {
    throw new Error(
      `[${season}] arena_score_inputs_json returned an invalid board_as_of for ` +
        `${invalidBoardRow.platform || 'unknown'}:${invalidBoardRow.trader_key || 'unknown'} — aborting`
    )
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
      source_board_as_of: d.board_as_of,
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

  // Sanity floor: refuse to feed an implausibly small read into scoring +
  // cleanup. Throwing aborts the whole compute, leaving the prior leaderboard
  // intact rather than letting cleanup wipe it down to whatever partial set
  // survived. This is the guard that would have prevented the 06-13 collapse.
  if (countBySource.size < MIN_PLAUSIBLE_SOURCES || rows.length < MIN_PLAUSIBLE_ROWS) {
    throw new Error(
      `[${season}] arena read implausibly small (${rows.length} rows / ${countBySource.size} platforms; ` +
        `floor ${MIN_PLAUSIBLE_ROWS} rows / ${MIN_PLAUSIBLE_SOURCES} platforms) — aborting to protect leaderboard`
    )
  }

  logger.info(
    `[${season}] arena_score_inputs_json: ${rows.length} rows across ${countBySource.size} platforms`
  )
  return countBySource
}
