/**
 * Metric formatting, comparison, and overall winner computation
 * for the PK comparison page.
 */

import type { PKTraderData, MetricRow, OverallResult } from './pk-types'

// ─── Formatters ──────────────────────────────────────────────────────────────

export function fmtRoi(v: number | null): string {
  if (v == null) return 'N/A'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

export function fmtPct(v: number | null): string {
  if (v == null) return 'N/A'
  return `${v.toFixed(1)}%`
}

export function fmtMDD(v: number | null): string {
  if (v == null) return 'N/A'
  return `-${Math.abs(v).toFixed(1)}%`
}

export function fmtPnl(v: number | null): string {
  if (v == null) return 'N/A'
  const abs = Math.abs(v)
  const sign = v >= 0 ? '+' : '-'
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${abs.toFixed(0)}`
}

export function fmtCount(v: number | null): string {
  if (v == null) return 'N/A'
  return v.toLocaleString()
}

// ─── Build metric rows ──────────────────────────────────────────────────────

function compare(
  rawA: number | null,
  rawB: number | null,
  higherIsBetter: boolean
): 'a' | 'b' | 'tie' | null {
  if (rawA == null || rawB == null) return null
  if (rawA === rawB) return 'tie'
  if (higherIsBetter) return rawA > rawB ? 'a' : 'b'
  // lower is better (e.g. max_drawdown — less negative is better)
  return rawA < rawB ? 'a' : 'b'
}

export function buildMetrics(a: PKTraderData, b: PKTraderData): MetricRow[] {
  return [
    {
      label: 'ROI',
      a_raw: a.roi,
      b_raw: b.roi,
      a_display: fmtRoi(a.roi),
      b_display: fmtRoi(b.roi),
      winner: compare(a.roi, b.roi, true),
    },
    {
      label: 'Win Rate',
      a_raw: a.win_rate,
      b_raw: b.win_rate,
      a_display: fmtPct(a.win_rate),
      b_display: fmtPct(b.win_rate),
      winner: compare(a.win_rate, b.win_rate, true),
    },
    {
      label: 'Max Drawdown',
      // max_drawdown is typically stored as a negative number (e.g. -15.5)
      // lower absolute value = better -> compare raw (less negative = higher = better)
      a_raw: a.max_drawdown,
      b_raw: b.max_drawdown,
      a_display: fmtMDD(a.max_drawdown),
      b_display: fmtMDD(b.max_drawdown),
      winner: compare(a.max_drawdown, b.max_drawdown, true), // higher = less negative = better
    },
    {
      label: 'Arena Score',
      a_raw: a.arena_score,
      b_raw: b.arena_score,
      a_display: a.arena_score != null ? a.arena_score.toFixed(0) : 'N/A',
      b_display: b.arena_score != null ? b.arena_score.toFixed(0) : 'N/A',
      winner: compare(a.arena_score, b.arena_score, true),
    },
    {
      label: 'Trades',
      a_raw: a.trades_count,
      b_raw: b.trades_count,
      a_display: fmtCount(a.trades_count),
      b_display: fmtCount(b.trades_count),
      winner: compare(a.trades_count, b.trades_count, true),
    },
    {
      label: 'PnL',
      a_raw: a.pnl,
      b_raw: b.pnl,
      a_display: fmtPnl(a.pnl),
      b_display: fmtPnl(b.pnl),
      winner: compare(a.pnl, b.pnl, true),
    },
  ]
}

// ─── Overall winner ─────────────────────────────────────────────────────────

export function computeOverallWinner(
  metrics: MetricRow[],
  nameA: string,
  nameB: string
): OverallResult {
  let aWins = 0
  let bWins = 0
  let total = 0

  for (const m of metrics) {
    if (m.winner === 'a') {
      aWins++
      total++
    } else if (m.winner === 'b') {
      bWins++
      total++
    } else if (m.winner === 'tie') {
      total++
    }
  }

  const winner =
    aWins > bWins ? nameA : bWins > aWins ? nameB : aWins > 0 ? 'TIE' : null

  return { winner, aWins, bWins, total }
}
