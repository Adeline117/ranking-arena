/**
 * First-party account fetcher (认领交易员 P1) — the CCXT network half.
 *
 * Pulls a claimed trader's OWN account data with their read-only key and
 * normalizes it into the engine's compute input. P1 exchanges (owner scope):
 * bybit / okx via fetchPositionsHistory (per-position closed PnL — exact win
 * rate), binance via fetchLedger income records (REALIZED_PNL events —
 * win_rate_basis='income_events'). Everything degrades gracefully: a surface
 * an exchange doesn't support just yields fewer inputs, never a throw-away.
 *
 * Client construction mirrors lib/portfolio/exchange-sync.ts (geo proxy for
 * binance/okx, passphrase exchanges, read-only calls exclusively).
 */

import type { FirstPartyComputeInput, RealizedEvent } from './engine'

interface CcxtPositionHistoryRow {
  timestamp?: number | null
  lastUpdateTimestamp?: number | null
  realizedPnl?: number | null
  info?: unknown
}

/** Minimal structural CCXT surface we rely on (no `as any`, spec 接地纪律). */
export interface CcxtLike {
  has?: Record<string, boolean | 'emulated' | undefined>
  fetchBalance(params?: Record<string, unknown>): Promise<{
    total?: Record<string, number>
    info?: unknown
  }>
  fetchPositions?(
    symbols?: string[] | undefined
  ): Promise<Array<{ unrealizedPnl?: number | null; contracts?: number | null }>>
  fetchPositionsHistory?(
    symbols?: string[] | undefined,
    since?: number,
    limit?: number,
    params?: Record<string, unknown>
  ): Promise<CcxtPositionHistoryRow[]>
  fetchLedger?(
    code?: string | undefined,
    since?: number,
    limit?: number,
    params?: Record<string, unknown>
  ): Promise<
    Array<{
      timestamp?: number | null
      amount?: number | null
      direction?: string | null
      type?: string | null
      info?: unknown
    }>
  >
}

export type FirstPartyBalanceSemantics = 'total_includes_unrealized' | 'wallet_excludes_unrealized'
export type FirstPartyRealizedPnlSource = 'positions_history' | 'income_ledger'

const DAY_MS = 86_400_000
const STABLES = ['USDT', 'USD', 'USDC']
const POSITION_HISTORY_LIMIT = 100
const LEDGER_LIMIT = 500
const LEDGER_MAX_PAGES = 5

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' && typeof v !== 'string') return null
  if (typeof v === 'string' && v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function positionCloseTimestamp(row: CcxtPositionHistoryRow): number | null {
  const info = row.info as {
    updatedTime?: unknown
    uTime?: unknown
    utime?: unknown
    time?: unknown
  }
  return num(
    row.lastUpdateTimestamp ??
      info?.updatedTime ??
      info?.uTime ??
      info?.utime ??
      info?.time ??
      row.timestamp
  )
}

/** Realized events via per-position close history (bybit/okx: exact). */
async function eventsFromPositionsHistory(
  client: CcxtLike,
  sinceMs: number,
  untilMs: number,
  maxRangeDays?: number
): Promise<RealizedEvent[]> {
  if (!client.fetchPositionsHistory) {
    throw new Error('[first-party] position history evidence is unavailable')
  }
  const out: RealizedEvent[] = []
  const maxRangeMs = maxRangeDays === undefined ? null : maxRangeDays * DAY_MS
  let rangeStart = sinceMs

  while (rangeStart <= untilMs) {
    const rangeEnd = maxRangeMs === null ? untilMs : Math.min(untilMs, rangeStart + maxRangeMs)
    const rows = await client.fetchPositionsHistory(undefined, rangeStart, POSITION_HISTORY_LIMIT, {
      until: rangeEnd,
    })
    if (rows.length >= POSITION_HISTORY_LIMIT) {
      throw new Error('[first-party] position history evidence is truncated')
    }
    for (const r of rows) {
      // CCXT's unified `timestamp` is commonly the position open/create time.
      // Realized PnL belongs to the close/update window.
      const ts = positionCloseTimestamp(r)
      const pnl = num(r.realizedPnl ?? (r.info as { closedPnl?: unknown })?.closedPnl)
      if (ts === null || pnl === null || ts < rangeStart || ts > rangeEnd) {
        throw new Error('[first-party] position history evidence is invalid')
      }
      out.push({ ts, pnl, positionLevel: true })
    }
    if (maxRangeMs === null || rangeEnd === untilMs) break
    rangeStart = rangeEnd + 1
  }
  return out
}

/** Realized events via income/ledger records (binanceusdm REALIZED_PNL). */
async function eventsFromLedger(client: CcxtLike, sinceMs: number): Promise<RealizedEvent[]> {
  if (!client.fetchLedger) {
    throw new Error('[first-party] realized PnL ledger evidence is unavailable')
  }
  const out: RealizedEvent[] = []
  let since = sinceMs
  for (let page = 0; page < LEDGER_MAX_PAGES; page++) {
    const rows = await client.fetchLedger(undefined, since, LEDGER_LIMIT)
    if (!rows?.length) break
    for (const r of rows) {
      const ts = num(r.timestamp)
      const incomeType = String(
        (r.info as { incomeType?: unknown })?.incomeType ?? r.type ?? ''
      ).toUpperCase()
      if (incomeType === 'REALIZED_PNL') {
        // CCXT ledger entries normalize amount to an absolute value and carry
        // the sign in `direction`; Binance's raw income remains signed.
        const rawIncome = num((r.info as { income?: unknown })?.income)
        const normalizedAmount = num(r.amount)
        const amt =
          rawIncome ??
          (normalizedAmount === null
            ? null
            : r.direction === 'out'
              ? -Math.abs(normalizedAmount)
              : r.direction === 'in'
                ? Math.abs(normalizedAmount)
                : normalizedAmount)
        if (ts === null || amt === null) {
          throw new Error('[first-party] realized PnL ledger evidence is invalid')
        }
        out.push({ ts, pnl: amt, positionLevel: false })
      }
    }
    const maxTs = Math.max(...rows.map((r) => num(r.timestamp) ?? 0))
    if (rows.length < LEDGER_LIMIT) break
    if (!Number.isFinite(maxTs) || maxTs <= since) {
      throw new Error('[first-party] realized PnL ledger evidence is invalid')
    }
    if (page === LEDGER_MAX_PAGES - 1) {
      throw new Error('[first-party] realized PnL ledger evidence is truncated')
    }
    since = maxTs + 1
  }
  return out
}

/** Net transfers IN (deposits/transfer-in − withdrawals/transfer-out). */
async function netTransfers(
  client: CcxtLike,
  sinceMs: number
): Promise<Array<{ ts: number; amount: number }> | null> {
  if (!client.fetchLedger) return null
  const out: Array<{ ts: number; amount: number }> = []
  try {
    const rows = await client.fetchLedger(undefined, sinceMs, 500)
    for (const r of rows ?? []) {
      const ts = num(r.timestamp)
      const amt = num(r.amount)
      const info = r.info as {
        incomeType?: unknown
        type?: unknown
        businessType?: unknown
      }
      const rawType = String(
        info?.incomeType ?? info?.type ?? info?.businessType ?? ''
      ).toUpperCase()
      const unifiedType = String(r.type ?? '').toUpperCase()
      const isTransfer =
        unifiedType === 'TRANSFER' ||
        unifiedType === 'DEPOSIT' ||
        unifiedType === 'WITHDRAWAL' ||
        rawType.includes('TRANSFER') ||
        rawType.includes('DEPOSIT') ||
        rawType.includes('WITHDRAW')
      if (!isTransfer) continue
      if (ts === null || amt === null) return null
      const sign =
        r.direction === 'out' || rawType.includes('OUT') || rawType.includes('WITHDRAW') ? -1 : 1
      out.push({ ts, amount: sign * Math.abs(amt) })
    }
  } catch {
    // Missing transfer evidence is unknown, never zero. The compute layer
    // keeps reconstructed ROI/MDD null until evidence is available.
    return null
  }
  return out
}

export async function fetchFirstPartyAccount(
  client: CcxtLike,
  opts: {
    nowMs: number
    balanceSemantics: FirstPartyBalanceSemantics
    realizedPnlSource: FirstPartyRealizedPnlSource
    positionHistoryMaxRangeDays?: number
    lookbackDays?: number
    lastSyncMs?: number | null
  }
): Promise<Omit<FirstPartyComputeInput, 'snapshots'>> {
  const nowMs = opts.nowMs
  const sinceMs = nowMs - (opts.lookbackDays ?? 90) * DAY_MS

  // Balance + unrealized (read-only, same calls as the portfolio sync).
  const bal = await client.fetchBalance()
  let balanceNow: number | null = null
  for (const c of STABLES) {
    const v = num(bal.total?.[c])
    if (v !== null) {
      balanceNow = (balanceNow ?? 0) + v
    }
  }
  if (balanceNow === null) {
    throw new Error('[first-party] stablecoin balance evidence is unavailable')
  }

  let unrealizedNow: number | null = null
  if (client.fetchPositions) {
    try {
      const positions = await client.fetchPositions(undefined)
      unrealizedNow = positions.reduce((s, p) => s + (num(p.unrealizedPnl) ?? 0), 0)
    } catch {
      unrealizedNow = null
    }
  }
  if (opts.balanceSemantics === 'wallet_excludes_unrealized' && unrealizedNow === null) {
    throw new Error('[first-party] unrealized PnL evidence is unavailable')
  }
  const equityNow =
    opts.balanceSemantics === 'total_includes_unrealized'
      ? balanceNow
      : balanceNow + (unrealizedNow ?? 0)
  if (!Number.isFinite(equityNow) || equityNow < 0) {
    throw new Error('[first-party] account equity evidence is invalid')
  }

  // Realized events use the exchange's explicit, pinned evidence contract.
  const events =
    opts.realizedPnlSource === 'positions_history'
      ? await eventsFromPositionsHistory(client, sinceMs, nowMs, opts.positionHistoryMaxRangeDays)
      : await eventsFromLedger(client, sinceMs)

  // Transfers → per-window net-in + since-last-sync delta.
  const transfers = await netTransfers(client, sinceMs)
  const netTransfersIn: FirstPartyComputeInput['netTransfersIn'] = {}
  if (transfers !== null) {
    for (const tf of [7, 30, 90] as const) {
      const start = nowMs - tf * DAY_MS
      netTransfersIn[tf] = transfers.filter((t) => t.ts >= start).reduce((s, t) => s + t.amount, 0)
    }
  }
  const lastSyncMs = opts.lastSyncMs ?? null
  const netTransfersSinceLast =
    transfers === null
      ? null
      : lastSyncMs === null
        ? 0
        : transfers.filter((t) => t.ts > lastSyncMs).reduce((s, t) => s + t.amount, 0)

  return {
    nowMs,
    currency: 'USDT',
    equityNow,
    balanceNow,
    unrealizedNow,
    events,
    netTransfersIn,
    netTransfersSinceLast,
  }
}
