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
  ): Promise<Array<{ timestamp?: number | null; realizedPnl?: number | null; info?: unknown }>>
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

const DAY_MS = 86_400_000
const STABLES = ['USDT', 'USD', 'USDC']

function num(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Realized events via per-position close history (bybit/okx: exact). */
async function eventsFromPositionsHistory(
  client: CcxtLike,
  sinceMs: number
): Promise<RealizedEvent[]> {
  if (!client.fetchPositionsHistory) return []
  const out: RealizedEvent[] = []
  // Single bounded page-walk: most personal accounts fit well within 5×100.
  let since = sinceMs
  for (let page = 0; page < 5; page++) {
    const rows = await client.fetchPositionsHistory(undefined, since, 100)
    if (!rows?.length) break
    for (const r of rows) {
      const ts = num(r.timestamp)
      const pnl = num(r.realizedPnl ?? (r.info as { closedPnl?: unknown })?.closedPnl)
      if (ts !== null && pnl !== null) out.push({ ts, pnl, positionLevel: true })
    }
    const maxTs = Math.max(...rows.map((r) => num(r.timestamp) ?? 0))
    if (!Number.isFinite(maxTs) || maxTs <= since || rows.length < 100) break
    since = maxTs + 1
  }
  return out
}

/** Realized events via income/ledger records (binanceusdm REALIZED_PNL). */
async function eventsFromLedger(client: CcxtLike, sinceMs: number): Promise<RealizedEvent[]> {
  if (!client.fetchLedger) return []
  const out: RealizedEvent[] = []
  let since = sinceMs
  for (let page = 0; page < 5; page++) {
    const rows = await client.fetchLedger(undefined, since, 500)
    if (!rows?.length) break
    for (const r of rows) {
      const ts = num(r.timestamp)
      const incomeType = String(
        (r.info as { incomeType?: unknown })?.incomeType ?? r.type ?? ''
      ).toUpperCase()
      if (ts === null) continue
      if (incomeType === 'REALIZED_PNL') {
        const amt = num(r.amount)
        if (amt !== null) out.push({ ts, pnl: amt, positionLevel: false })
      }
    }
    const maxTs = Math.max(...rows.map((r) => num(r.timestamp) ?? 0))
    if (!Number.isFinite(maxTs) || maxTs <= since || rows.length < 500) break
    since = maxTs + 1
  }
  return out
}

/** Net transfers IN (deposits/transfer-in − withdrawals/transfer-out). */
async function netTransfers(
  client: CcxtLike,
  sinceMs: number
): Promise<Array<{ ts: number; amount: number }>> {
  if (!client.fetchLedger) return []
  const out: Array<{ ts: number; amount: number }> = []
  try {
    const rows = await client.fetchLedger(undefined, sinceMs, 500)
    for (const r of rows ?? []) {
      const ts = num(r.timestamp)
      const amt = num(r.amount)
      const type = String(
        (r.info as { incomeType?: unknown })?.incomeType ?? r.type ?? ''
      ).toUpperCase()
      if (ts === null || amt === null) continue
      if (type === 'TRANSFER' || type === 'DEPOSIT' || type === 'WITHDRAWAL') {
        const sign = r.direction === 'out' || type === 'WITHDRAWAL' ? -1 : 1
        out.push({ ts, amount: sign * Math.abs(amt) })
      }
    }
  } catch {
    // transfers are a refinement, not a requirement — ROI falls back to
    // reconstruction without them (extras.roi_method already labels it).
  }
  return out
}

export async function fetchFirstPartyAccount(
  client: CcxtLike,
  opts: { nowMs: number; lookbackDays?: number; lastSyncMs?: number | null }
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
  let unrealizedNow: number | null = null
  if (client.fetchPositions) {
    try {
      const positions = await client.fetchPositions(undefined)
      unrealizedNow = positions.reduce((s, p) => s + (num(p.unrealizedPnl) ?? 0), 0)
    } catch {
      unrealizedNow = null
    }
  }
  const equityNow = (balanceNow ?? 0) + (unrealizedNow ?? 0)

  // Realized events: prefer per-position history (exact), else income ledger.
  let events: RealizedEvent[] = []
  if (client.has?.fetchPositionsHistory && client.fetchPositionsHistory) {
    events = await eventsFromPositionsHistory(client, sinceMs)
  }
  if (events.length === 0) {
    events = await eventsFromLedger(client, sinceMs)
  }

  // Transfers → per-window net-in + since-last-sync delta.
  const transfers = await netTransfers(client, sinceMs)
  const netTransfersIn: FirstPartyComputeInput['netTransfersIn'] = {}
  for (const tf of [7, 30, 90] as const) {
    const start = nowMs - tf * DAY_MS
    netTransfersIn[tf] = transfers.filter((t) => t.ts >= start).reduce((s, t) => s + t.amount, 0)
  }
  const lastSyncMs = opts.lastSyncMs ?? null
  const netTransfersSinceLast =
    lastSyncMs === null
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
