/**
 * Data Write Gatekeeper — validateBeforeWrite()
 *
 * Single validation function that guards ALL writes to:
 * - trader_snapshots_v2
 * - trader_daily_snapshots
 * - leaderboard_ranks
 *
 * Dirty data never enters the database. Failed rows are logged to
 * pipeline_rejected_writes and trigger Telegram alerts.
 *
 * Usage:
 *   const { valid, rejected } = validateBeforeWrite(rows, 'trader_snapshots_v2')
 *   if (rejected.length) await logRejectedWrites(rejected)
 *   // only upsert `valid` rows
 */

import { logger } from '@/lib/logger'
import { VALIDATION_BOUNDS } from './types'

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface ValidationFailure {
  platform: string
  trader_key: string
  target_table: string
  field: string
  value: string | null
  reason: string
  metadata?: Record<string, unknown>
}

export interface ValidationResult<T> {
  valid: T[]
  rejected: ValidationFailure[]
}

// ═══════════════════════════════════════════════════════
// Validation Rules — derived from VALIDATION_BOUNDS (single source of truth)
// ═══════════════════════════════════════════════════════

const B = VALIDATION_BOUNDS
const RULES = {
  ROI_MIN: B.roi_pct.min,
  ROI_MAX: B.roi_pct.max,
  PNL_MIN: B.pnl_usd.min,
  PNL_MAX: B.pnl_usd.max,
  PNL_WHALE_EXEMPT_PLATFORMS: new Set(['hyperliquid', 'gmx', 'dydx', 'drift']),
  PNL_WHALE_MAX: B.pnl_usd_dex_whale.max,
  WIN_RATE_MIN: B.win_rate_pct.min,
  WIN_RATE_MAX: B.win_rate_pct.max,
  MDD_MIN: B.max_drawdown_pct.min,
  MDD_MAX: B.max_drawdown_pct.max,
  SHARPE_MIN: B.sharpe_ratio.min,
  SHARPE_MAX: B.sharpe_ratio.max,
  ARENA_SCORE_MIN: B.arena_score.min,
  ARENA_SCORE_MAX: B.arena_score.max,
} as const

// ═══════════════════════════════════════════════════════
// Field extraction — works for both V2 and LR schemas
// ═══════════════════════════════════════════════════════

function getField(row: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k]
    if (v != null) {
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
  }
  return null
}

function getString(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k]
    if (v != null && typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

// ═══════════════════════════════════════════════════════
// Core Validation
// ═══════════════════════════════════════════════════════

function validateRow(
  row: Record<string, unknown>,
  targetTable: string,
): ValidationFailure[] {
  const failures: ValidationFailure[] = []
  const platform = getString(row, 'platform', 'source') || 'unknown'
  const traderKey = getString(row, 'trader_key', 'source_trader_id') || 'unknown'

  function fail(field: string, value: unknown, reason: string) {
    failures.push({
      platform,
      trader_key: traderKey,
      target_table: targetTable,
      field,
      value: value != null ? String(value) : null,
      reason,
    })
  }

  // ── Required fields ──
  if (!getString(row, 'platform', 'source')) {
    fail('platform', null, 'platform/source is empty')
  }
  if (!getString(row, 'trader_key', 'source_trader_id')) {
    fail('trader_key', null, 'trader_key/source_trader_id is empty')
  }

  // ── ROI bounds ──
  const roi = getField(row, 'roi_pct', 'roi')
  if (roi != null) {
    if (roi < RULES.ROI_MIN || roi > RULES.ROI_MAX) {
      fail('roi', roi, `ROI ${roi}% outside [${RULES.ROI_MIN}, ${RULES.ROI_MAX}]`)
    }
  }

  // ── PnL bounds ──
  const pnl = getField(row, 'pnl_usd', 'pnl')
  if (pnl != null) {
    const isWhaleExempt = RULES.PNL_WHALE_EXEMPT_PLATFORMS.has(platform)
    const pnlMax = isWhaleExempt ? RULES.PNL_WHALE_MAX : RULES.PNL_MAX
    if (pnl < RULES.PNL_MIN || pnl > pnlMax) {
      fail('pnl', pnl, `PnL $${pnl} outside [${RULES.PNL_MIN}, ${pnlMax}]`)
    }
  }

  // ── ROI and PnL sign consistency ──
  if (roi != null && pnl != null && roi !== 0 && pnl !== 0) {
    const roiPositive = roi > 0
    const pnlPositive = pnl > 0
    if (roiPositive !== pnlPositive) {
      // Allow small discrepancies — sign mismatch only flagged when both are significant
      const roiSignificant = Math.abs(roi) > 10 // >10% ROI
      const pnlSignificant = Math.abs(pnl) > 100 // >$100 PnL
      if (roiSignificant && pnlSignificant) {
        fail('roi_pnl_sign', `roi=${roi}, pnl=${pnl}`, 'ROI and PnL signs disagree (both significant)')
      }
    }
  }

  // ── ROI ≈ PnL (common conversion bug) ──
  if (roi != null && pnl != null && Math.abs(pnl) > 1) {
    // If roi_pct equals pnl_usd, it's almost certainly a field mapping error
    if (Math.abs(roi - pnl) < 0.01 && Math.abs(roi) > 10) {
      fail('roi_equals_pnl', `roi=${roi}, pnl=${pnl}`, 'roi_pct equals pnl_usd — likely field mapping error')
    }
  }

  // ── Win Rate bounds ──
  const wr = getField(row, 'win_rate')
  if (wr != null && (wr < RULES.WIN_RATE_MIN || wr > RULES.WIN_RATE_MAX)) {
    fail('win_rate', wr, `WinRate ${wr}% outside [0, 100]`)
  }

  // ── Max Drawdown bounds ──
  const mdd = getField(row, 'max_drawdown')
  if (mdd != null && (mdd < RULES.MDD_MIN || mdd > RULES.MDD_MAX)) {
    fail('max_drawdown', mdd, `MDD ${mdd}% outside [0, 100]`)
  }

  // ── Sharpe ratio bounds ──
  const sharpe = getField(row, 'sharpe_ratio')
  if (sharpe != null && (sharpe < RULES.SHARPE_MIN || sharpe > RULES.SHARPE_MAX)) {
    fail('sharpe_ratio', sharpe, `Sharpe ${sharpe} outside [${RULES.SHARPE_MIN}, ${RULES.SHARPE_MAX}]`)
  }

  // ── Arena score bounds (leaderboard_ranks only) ──
  const score = getField(row, 'arena_score')
  if (score != null && (score < 0 || score > 100)) {
    fail('arena_score', score, `Arena score ${score} outside [0, 100]`)
  }

  return failures
}

// ═══════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════

/**
 * Validate an array of rows before writing to the database.
 * Returns { valid, rejected } — only write `valid` rows.
 */
export function validateBeforeWrite<T extends Record<string, unknown>>(
  rows: T[],
  targetTable: string,
): ValidationResult<T> {
  const valid: T[] = []
  const rejected: ValidationFailure[] = []

  for (const row of rows) {
    const failures = validateRow(row, targetTable)
    if (failures.length > 0) {
      rejected.push(...failures)
    } else {
      valid.push(row)
    }
  }

  if (rejected.length > 0) {
    logger.warn(`[validate-before-write] ${targetTable}: ${rejected.length} fields rejected from ${rows.length} rows`)
  }

  return { valid, rejected }
}

/**
 * Validate a single row. Returns null if valid, or the row with invalid fields set to null.
 * Use this for rows where you want to keep the row but null out bad fields.
 */
export function sanitizeRow<T extends Record<string, unknown>>(
  row: T,
  targetTable: string,
): { row: T; nulledFields: string[]; rejected: ValidationFailure[] } {
  const failures = validateRow(row, targetTable)
  const nulledFields: string[] = []
  const sanitized = { ...row }

  for (const f of failures) {
    // For required fields (platform, trader_key), reject entire row
    if (f.field === 'platform' || f.field === 'trader_key') {
      return { row: sanitized, nulledFields: [], rejected: failures }
    }
    // For value fields, null them out
    const fieldMappings: Record<string, string[]> = {
      roi: ['roi', 'roi_pct'],
      pnl: ['pnl', 'pnl_usd'],
      win_rate: ['win_rate'],
      max_drawdown: ['max_drawdown'],
      sharpe_ratio: ['sharpe_ratio'],
      arena_score: ['arena_score'],
      roi_pnl_sign: [], // Don't null — just warn
      roi_equals_pnl: ['roi', 'roi_pct'], // Null the ROI (PnL is more likely correct)
    }
    for (const key of (fieldMappings[f.field] || [])) {
      if (key in sanitized) {
        (sanitized as Record<string, unknown>)[key] = null
        nulledFields.push(key)
      }
    }
  }

  return { row: sanitized, nulledFields, rejected: failures }
}

// ═══════════════════════════════════════════════════════
// Persistence — log rejected writes to DB + Telegram
// ═══════════════════════════════════════════════════════

/**
 * Log rejected writes to pipeline_rejected_writes table and send Telegram alert.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function logRejectedWrites(
  rejections: ValidationFailure[],
  supabase?: any,
): Promise<void> {
  if (rejections.length === 0) return

  // 1. Log to DB (best-effort)
  try {
    if (supabase) {
      const rows = rejections.slice(0, 500).map(r => ({
        platform: r.platform,
        trader_key: r.trader_key,
        target_table: r.target_table,
        field: r.field,
        value: r.value?.slice(0, 500) ?? null,
        reason: r.reason.slice(0, 500),
        metadata: r.metadata || {},
      }))
      await supabase.from('pipeline_rejected_writes').insert(rows)
    }
  } catch (err) {
    logger.warn('[validate-before-write] Failed to log rejections to DB', err)
  }

  // 2. Telegram alert (rate-limited, max 1 per 10 minutes)
  try {
    const { sendRateLimitedAlert } = await import('@/lib/alerts/send-alert')
    const summary = rejections.slice(0, 10).map(r =>
      `  ${r.platform}/${r.trader_key.slice(0, 12)}: ${r.field}=${r.value?.slice(0, 20)} — ${r.reason}`
    ).join('\n')
    await sendRateLimitedAlert({
      title: `数据守门人: ${rejections.length} 条脏数据被拦截`,
      message: `以下数据未通过校验，已拒绝写入:\n${summary}${rejections.length > 10 ? `\n  ... and ${rejections.length - 10} more` : ''}`,
      level: 'warning',
      details: { count: rejections.length, tables: [...new Set(rejections.map(r => r.target_table))] },
    }, 'validate-gatekeeper', 10 * 60 * 1000)
  } catch {
    // Non-critical
  }
}
