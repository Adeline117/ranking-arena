/**
 * Staging validation (spec §5.2): zod schema + per-source required fields.
 * A row failing validation is quarantined (arena.staging_rejects), never
 * silently NULLed. Pure module — no I/O.
 */

import type { ParsedLeaderboardRow, ParsedStats } from '../core/types'
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

  for (const row of seen.values()) valid.push(row)
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
    valid.push(block)
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
