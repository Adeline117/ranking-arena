/**
 * compute-leaderboard / canonical Arena read path
 *
 * Pulls ranking inputs from the `arena.*` pipeline through the
 * `arena_score_inputs` public RPC. The cutover readers have been retired, so
 * this is the only Phase-1 source.
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
import { isRankEligiblePnl, isRankEligibleRoi } from '@/lib/rankings/metric-eligibility'
import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'
import { mapArenaScoreRowToTraderRow } from './arena-score-row-mapper'
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
const MIN_SOURCE_ELIGIBLE_RATIO = 0.6

interface RpcRow {
  platform: string
  trader_key: string
  roi_pct: number | string | null
  pnl_usd: number | string | null
  win_rate: number | string | null
  max_drawdown: number | string | null
  copiers: number | string | null
  trades_count: number | string | null
  sharpe_ratio: number | string | null
  sortino_ratio: number | string | null
  calmar_ratio: number | string | null
  trader_kind: string | null
  as_of: string
  board_as_of: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numericTransportValue(value: unknown): number | string | null {
  return typeof value === 'number' || typeof value === 'string' ? value : null
}

function parseRpcRow(value: unknown): RpcRow {
  const row = isRecord(value) ? value : {}
  return {
    platform: typeof row.platform === 'string' ? row.platform : '',
    trader_key: typeof row.trader_key === 'string' ? row.trader_key : '',
    roi_pct: numericTransportValue(row.roi_pct),
    pnl_usd: numericTransportValue(row.pnl_usd),
    win_rate: numericTransportValue(row.win_rate),
    max_drawdown: numericTransportValue(row.max_drawdown),
    copiers: numericTransportValue(row.copiers),
    trades_count: numericTransportValue(row.trades_count),
    sharpe_ratio: numericTransportValue(row.sharpe_ratio),
    sortino_ratio: numericTransportValue(row.sortino_ratio),
    calmar_ratio: numericTransportValue(row.calmar_ratio),
    trader_kind: typeof row.trader_kind === 'string' ? row.trader_kind : null,
    as_of: typeof row.as_of === 'string' ? row.as_of : '',
    board_as_of: typeof row.board_as_of === 'string' ? row.board_as_of : '',
  }
}

const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const value = v.trim()
  if (!value || !DECIMAL_NUMBER.test(value)) return null
  const n = Number(value)
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
  const { data, error } = await supabase.rpc('arena_score_inputs_json', {
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
  const rows = (Array.isArray(data) ? data : []).map(parseRpcRow)
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
  const invalidObservationRow = rows.find(
    (row) =>
      typeof row.as_of !== 'string' ||
      row.as_of.trim() === '' ||
      !Number.isFinite(Date.parse(row.as_of))
  )
  if (invalidObservationRow) {
    throw new Error(
      `[${season}] arena_score_inputs_json returned an invalid as_of for ` +
        `${invalidObservationRow.platform || 'unknown'}:${invalidObservationRow.trader_key || 'unknown'} — aborting`
    )
  }

  const rawIdentitiesBySource = new Map<string, Set<string>>()
  const eligibleRowsBySource = new Map<string, Map<string, TraderRow>>()
  for (const d of rows) {
    if (
      !isPublicRankingSourceAllowed(d.platform) ||
      typeof d.trader_key !== 'string' ||
      d.trader_key.trim() === '' ||
      d.trader_key !== d.trader_key.trim()
    ) {
      continue
    }
    const traderKey = d.trader_key.startsWith('0x') ? d.trader_key.toLowerCase() : d.trader_key
    const rawIdentities = rawIdentitiesBySource.get(d.platform) ?? new Set<string>()
    const duplicateIdentity = rawIdentities.has(traderKey)
    rawIdentities.add(traderKey)
    rawIdentitiesBySource.set(d.platform, rawIdentities)
    if (duplicateIdentity) {
      // Conflicting duplicates have no deterministic row authority. Exclude
      // the identity regardless of which copy arrived first.
      eligibleRowsBySource.get(d.platform)?.delete(traderKey)
      continue
    }
    // ROI and PnL are both hard ranking inputs. Keep incomplete rows in the
    // arena data model for discovery/display, but never copy them into the
    // compute map. Finite zero and negative observations are valid; only
    // absence, malformed values, or non-finite values fail this boundary.
    const roi = num(d.roi_pct)
    const pnl = num(d.pnl_usd)
    if (!isRankEligibleRoi(roi, season) || !isRankEligiblePnl(pnl, d.platform)) continue

    const sourceRows = eligibleRowsBySource.get(d.platform) ?? new Map<string, TraderRow>()
    sourceRows.set(
      traderKey,
      mapArenaScoreRowToTraderRow({
        platform: d.platform,
        trader_key: traderKey,
        roi_pct: roi,
        pnl_usd: pnl,
        win_rate: num(d.win_rate),
        max_drawdown: num(d.max_drawdown),
        copiers: num(d.copiers),
        trades_count: num(d.trades_count),
        sharpe_ratio: num(d.sharpe_ratio),
        sortino_ratio: num(d.sortino_ratio),
        calmar_ratio: num(d.calmar_ratio),
        trader_kind: d.trader_kind,
        as_of: d.as_of,
        board_as_of: d.board_as_of,
      })
    )
    eligibleRowsBySource.set(d.platform, sourceRows)
  }

  const stagedRows: TraderRow[] = []
  for (const [source, rawIdentities] of rawIdentitiesBySource) {
    const rawCount = rawIdentities.size
    const eligibleRows = eligibleRowsBySource.get(source) ?? new Map<string, TraderRow>()
    const eligibleRatio = rawCount > 0 ? eligibleRows.size / rawCount : 0
    if (eligibleRatio < MIN_SOURCE_ELIGIBLE_RATIO) {
      logger.warn(
        `[${season}] ${source} has ${eligibleRows.size}/${rawCount} rank-eligible rows ` +
          `(${(eligibleRatio * 100).toFixed(1)}%); preserving its last-good board`
      )
      continue
    }
    countBySource.set(source, eligibleRows.size)
    stagedRows.push(...eligibleRows.values())
  }
  const rankEligibleRowCount = stagedRows.length

  // Sanity floor: refuse to feed an implausibly small read into scoring +
  // cleanup. Throwing aborts the whole compute, leaving the prior leaderboard
  // intact rather than letting cleanup wipe it down to whatever partial set
  // survived. This is the guard that would have prevented the 06-13 collapse.
  if (countBySource.size < MIN_PLAUSIBLE_SOURCES || rankEligibleRowCount < MIN_PLAUSIBLE_ROWS) {
    throw new Error(
      `[${season}] arena read implausibly small (${rankEligibleRowCount} rank-eligible rows / ${countBySource.size} platforms; ` +
        `floor ${MIN_PLAUSIBLE_ROWS} rows / ${MIN_PLAUSIBLE_SOURCES} platforms) — aborting to protect leaderboard`
    )
  }

  // Do not mutate the caller's map until every global/source-level gate passes.
  for (const row of stagedRows) addToTraderMap(row)

  logger.info(
    `[${season}] arena_score_inputs_json: ${rankEligibleRowCount}/${rows.length} rank-eligible rows across ${countBySource.size} platforms`
  )
  return countBySource
}
