/**
 * Staging validation (spec §5.2): zod schema + per-source required fields.
 * A row failing validation is quarantined (arena.staging_rejects), never
 * silently NULLed. Pure module — no I/O.
 */

import type { ParsedHeadlineMetricSources, ParsedLeaderboardRow, ParsedStats } from '../core/types'
import { parsedLeaderboardRowSchema, parsedStatsSchema } from '../core/schemas'

export interface RejectedRow {
  reason: string
  payload: unknown
}

export interface ValidationResult<T> {
  valid: T[]
  rejects: RejectedRow[]
}

/**
 * Normalize physically-impossible metric values so source garbage never persists
 * in the serving layer (arena.trader_stats / leaderboard_entries). This is NOT
 * the "silent NULL" the header warns against — whole rows are still kept and the
 * immutable raw payload stays in arena.raw_objects for re-parse. We only bound
 * individual metrics to their canonical ranges so every downstream reader gets
 * clean data without re-defending. Roots out e.g. a KuCoin broken
 * thirtyDayPnlRatio (2.19e9 %) or an exchange-reported MDD of 140665%.
 *   roi      -> clamp to [-10000, 10000]  (matches arena.score_inputs)
 *   mdd      -> NULL when outside [0, 100] (definitional max drawdown)
 *   win_rate -> NULL when outside [0, 100] (definitional)
 */
function clampRoi(v: number | null | undefined): number | null {
  return v == null ? null : Math.max(-10000, Math.min(10000, v))
}
function boundPct(v: number | null | undefined): number | null {
  return v == null || v < 0 || v > 100 ? null : v
}

function exactHeadlineMetricSources(
  row: ParsedLeaderboardRow,
  roi: number | null,
  winRate: number | null,
  mdd: number | null
): ParsedHeadlineMetricSources | undefined {
  if (!row.headlineMetricSources) return undefined
  const sources = { ...row.headlineMetricSources }
  if (roi !== row.headlineRoi) delete sources.roi
  if (winRate !== row.headlineWinRate) delete sources.win_rate
  if (mdd !== (row.headlineMdd ?? null)) delete sources.mdd
  return Object.keys(sources).length > 0 ? sources : undefined
}

/**
 * Validate + dedupe leaderboard rows.
 * requiredFields: sources.meta.required_fields — fields that must be
 * non-null for THIS source (e.g. Binance profiles must yield ROI+PnL).
 */
export function validateLeaderboardRows(
  rows: ParsedLeaderboardRow[],
  requiredFields: Array<keyof ParsedLeaderboardRow> = []
): ValidationResult<ParsedLeaderboardRow> {
  const valid: ParsedLeaderboardRow[] = []
  const rejects: RejectedRow[] = []
  const seen = new Map<string, ParsedLeaderboardRow>()

  for (const row of rows) {
    const parsed = parsedLeaderboardRowSchema.safeParse(row)
    if (!parsed.success) {
      rejects.push({ reason: `zod:${parsed.error.issues[0]?.message}`, payload: row })
      continue
    }
    const missing = requiredFields.find((f) => row[f] === null || row[f] === undefined)
    if (missing) {
      rejects.push({ reason: `missing_required_field:${String(missing)}`, payload: row })
      continue
    }
    // Dedupe within one crawl: keep the better (lower) rank.
    const existing = seen.get(row.exchangeTraderId)
    if (!existing || row.rank < existing.rank) {
      seen.set(row.exchangeTraderId, row)
    }
  }

  for (const row of seen.values()) {
    const headlineRoi = clampRoi(row.headlineRoi)
    const headlineWinRate = boundPct(row.headlineWinRate)
    const headlineMdd = boundPct(row.headlineMdd)
    valid.push({
      ...row,
      headlineRoi,
      headlineWinRate,
      headlineMdd,
      headlineMetricSources: exactHeadlineMetricSources(
        row,
        headlineRoi,
        headlineWinRate,
        headlineMdd
      ),
    })
  }
  valid.sort((a, b) => a.rank - b.rank)
  return { valid, rejects }
}

/** Validate per-timeframe stats blocks (Tier B/C profile crawls). */
export function validateStats(
  stats: ParsedStats[],
  requiredFields: Array<keyof ParsedStats> = []
): ValidationResult<ParsedStats> {
  const valid: ParsedStats[] = []
  const rejects: RejectedRow[] = []

  for (const block of stats) {
    const parsed = parsedStatsSchema.safeParse(block)
    if (!parsed.success) {
      rejects.push({ reason: `zod:${parsed.error.issues[0]?.message}`, payload: block })
      continue
    }
    const missing = requiredFields.find((f) => block[f] === null || block[f] === undefined)
    if (missing) {
      rejects.push({ reason: `missing_required_field:${String(missing)}`, payload: block })
      continue
    }
    // Invariant: winning positions can never exceed total positions. When a
    // source returns garbage that violates it (seen on mexc_futures), we can't
    // tell which count is wrong — null the offending winPositions rather than
    // fabricate, so the impossible value never reaches serving.
    const winPositions =
      block.winPositions !== null &&
      block.totalPositions !== null &&
      block.winPositions > block.totalPositions
        ? null
        : block.winPositions
    valid.push({
      ...block,
      roi: clampRoi(block.roi),
      mdd: boundPct(block.mdd),
      winRate: boundPct(block.winRate),
      winPositions,
    })
  }
  return { valid, rejects }
}

/**
 * Cross-check (spec §5.3): headline board ROI must match profile ROI for
 * the same timeframe within tolerance — catches stale caches and
 * wrong-timeframe clicks. Returns null when either side is missing.
 */
export function roiCrossCheckOk(
  headlineRoi: number | null,
  profileRoi: number | null,
  tolerancePct = 5
): boolean | null {
  if (headlineRoi === null || profileRoi === null) return null
  const scale = Math.max(Math.abs(headlineRoi), Math.abs(profileRoi), 1)
  return (Math.abs(headlineRoi - profileRoi) / scale) * 100 <= tolerancePct
}
