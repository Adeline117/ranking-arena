/**
 * First-party stats engine (认领交易员 P1, 2026-07-09 owner 拍板).
 *
 * A claimed trader's ranking inputs come from THEIR OWN account via a
 * read-only CCXT client — not from board scraping. This module is the pure
 * compute half: given a live CCXT client + the trader's prior equity
 * snapshots, produce ParsedStats (tf 7/30/90, extras.provenance='first_party')
 * + chart series + one new equity snapshot. The worker processor
 * (worker/src/ingest/processors/first-party-sync.ts) owns credentials,
 * persistence and scheduling.
 *
 * Metric honesty rules (mirror the scraping pipeline's 死命令):
 * - realized PnL / win rate come from the exchange's own closed-position or
 *   income records — exact, not estimated.
 * - ROI denominator = start-of-window equity from OUR snapshots when history
 *   covers the window; before that, reconstructed as
 *   equity_now − window_pnl − net_transfers_in(window), labeled
 *   extras.roi_method='reconstructed'.
 * - mdd only once snapshots cover the window (extras.mdd_basis='snapshots');
 *   NULL until then — never faked.
 */

import type { ParsedStats, Timeframe } from '@/lib/ingest/core/types'

/** One realized-PnL event (closed position or income record). */
export interface RealizedEvent {
  ts: number // epoch ms
  pnl: number
  /** true when the event is a per-position close (exact win rate basis). */
  positionLevel: boolean
}

export interface EquitySnapshotRow {
  ts: string // ISO
  equity: number
  net_transfer_cum: number | null
}

export interface FirstPartyComputeInput {
  nowMs: number
  currency: string
  equityNow: number
  balanceNow: number | null
  unrealizedNow: number | null
  /** Realized events, any order; engine sorts. */
  events: RealizedEvent[]
  /** Net transfers IN per window (deposits − withdrawals), keyed by tf days. */
  netTransfersIn: Partial<Record<7 | 30 | 90, number>>
  /** Net transfers IN since the previous sync run (for the cumulative
   *  counter on the snapshot row — NOT window-scoped, no double counting). */
  netTransfersSinceLast: number | null
  /** Prior arena.first_party_snapshots rows, ascending ts. */
  snapshots: EquitySnapshotRow[]
}

export interface FirstPartyResult {
  stats: ParsedStats[]
  series: { timeframe: Timeframe; metric: string; points: { ts: string; value: number }[] }[]
  snapshot: {
    equity: number
    balance: number | null
    unrealizedPnl: number | null
    netTransferCum: number | null
    currency: string
  }
}

const WINDOWS: Array<7 | 30 | 90> = [7, 30, 90]
const DAY_MS = 86_400_000

/** Max peak-to-trough drawdown (%) over an equity path. */
export function maxDrawdownPct(equities: number[]): number | null {
  if (equities.length < 2) return null
  let peak = -Infinity
  let mdd = 0
  for (const e of equities) {
    if (e > peak) peak = e
    if (peak > 0) mdd = Math.max(mdd, ((peak - e) / peak) * 100)
  }
  return Number.isFinite(mdd) ? Number(mdd.toFixed(2)) : null
}

export function computeFirstParty(input: FirstPartyComputeInput): FirstPartyResult {
  const { nowMs, currency, equityNow, balanceNow, unrealizedNow, snapshots } = input
  const events = [...input.events].sort((a, b) => a.ts - b.ts)
  const asOf = new Date(nowMs).toISOString()

  const stats: ParsedStats[] = []
  const series: FirstPartyResult['series'] = []

  for (const tf of WINDOWS) {
    const startMs = nowMs - tf * DAY_MS
    const inWindow = events.filter((e) => e.ts >= startMs && e.ts <= nowMs)
    const pnl = inWindow.reduce((s, e) => s + e.pnl, 0)
    const positionLevel = inWindow.length > 0 && inWindow.every((e) => e.positionLevel)
    const wins = inWindow.filter((e) => e.pnl > 0).length
    const total = inWindow.length
    const netIn = input.netTransfersIn[tf] ?? 0

    // ROI denominator: earliest snapshot INSIDE the window if snapshot history
    // reaches back to (or beyond) the window start; else reconstruct.
    const windowSnaps = snapshots.filter((s) => Date.parse(s.ts) >= startMs)
    const coversWindow = snapshots.length > 0 && Date.parse(snapshots[0].ts) <= startMs + DAY_MS // 1d slack
    let startEquity: number | null = null
    let roiMethod: 'snapshot' | 'reconstructed' = 'reconstructed'
    if (coversWindow && windowSnaps.length > 0) {
      startEquity = windowSnaps[0].equity
      roiMethod = 'snapshot'
    } else {
      const recon = equityNow - pnl - netIn
      startEquity = recon > 0 ? recon : null
    }
    const roi =
      startEquity !== null && startEquity > 0
        ? Number(((pnl / startEquity) * 100).toFixed(4))
        : null

    // MDD strictly from our snapshot equity path (never faked before coverage).
    const mdd = coversWindow
      ? maxDrawdownPct([...windowSnaps.map((s) => s.equity), equityNow])
      : null

    stats.push({
      timeframe: tf as Timeframe,
      asOf,
      roi,
      pnl: Number(pnl.toFixed(4)),
      sharpe: null,
      mdd,
      winRate: total > 0 ? Number(((wins / total) * 100).toFixed(2)) : null,
      winPositions: total > 0 ? wins : null,
      totalPositions: total > 0 ? total : null,
      copierPnl: null,
      copierCount: null,
      aum: equityNow,
      volume: null,
      profitShareRate: null,
      holdingDurationAvgHours: null,
      tradingPreferences: null,
      extras: {
        provenance: 'first_party',
        roi_method: roiMethod,
        ...(mdd !== null ? { mdd_basis: 'snapshots' } : {}),
        ...(unrealizedNow !== null ? { unrealized_pnl: Number(unrealizedNow.toFixed(4)) } : {}),
        ...(total > 0 && !positionLevel ? { win_rate_basis: 'income_events' } : {}),
        net_transfers_in_window: netIn,
      },
    })

    // Chart series: equity path (snapshots + live point) and cumulative
    // realized pnl within the window — same shapes the scraped pipeline
    // stores, so every existing chart read path works unchanged.
    const equityPoints = [
      ...windowSnaps.map((s) => ({ ts: s.ts, value: s.equity })),
      { ts: asOf, value: equityNow },
    ]
    if (equityPoints.length >= 2) {
      series.push({ timeframe: tf as Timeframe, metric: 'account_value', points: equityPoints })
    }
    let cum = 0
    const pnlPoints = inWindow.map((e) => {
      cum += e.pnl
      return { ts: new Date(e.ts).toISOString(), value: Number(cum.toFixed(4)) }
    })
    if (pnlPoints.length >= 2) {
      series.push({ timeframe: tf as Timeframe, metric: 'pnl', points: pnlPoints })
    }
  }

  const lastCum = snapshots.length > 0 ? (snapshots[snapshots.length - 1].net_transfer_cum ?? 0) : 0
  return {
    stats,
    series,
    snapshot: {
      equity: equityNow,
      balance: balanceNow,
      unrealizedPnl: unrealizedNow,
      // Cumulative net transfers: prior cum + since-last-sync delta only —
      // window buckets are NOT reused here (a 15min cadence would re-add the
      // same 7d window every run).
      netTransferCum: lastCum + (input.netTransfersSinceLast ?? 0),
      currency,
    },
  }
}
