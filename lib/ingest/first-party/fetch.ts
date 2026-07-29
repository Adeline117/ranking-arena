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
  symbol?: string | null
  timestamp?: number | null
  lastUpdateTimestamp?: number | null
  realizedPnl?: number | null
  info?: unknown
}

interface CcxtLedgerRow {
  timestamp?: number | null
  amount?: number | null
  direction?: string | null
  type?: string | null
  currency?: string | null
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
  ): Promise<CcxtLedgerRow[]>
}

export type FirstPartyBalanceSemantics = 'total_includes_unrealized' | 'wallet_excludes_unrealized'
export type FirstPartyBalanceSource =
  | 'stable_totals'
  | 'binance_margin_balance'
  | 'bitget_usdt_equity'
  | 'bybit_total_equity'
  | 'okx_total_equity'
export type FirstPartyRealizedPnlSource = 'positions_history' | 'income_ledger'
export interface FirstPartyTransferLedgerContract {
  maxRangeDays: number
  pageLimit: number
  untilParam: 'until' | 'endTime'
  queries: ReadonlyArray<Readonly<Record<string, unknown>>>
}

const DAY_MS = 86_400_000
const STABLES = ['USDT', 'USD', 'USDC']
const USD_STABLES = new Set(['USDT', 'USDC', 'USD', 'BUSD', 'FDUSD'])
const POSITION_HISTORY_LIMIT = 100
const LEDGER_LIMIT = 1000
const MAX_EVIDENCE_REQUESTS = 128

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' && typeof v !== 'string') return null
  if (typeof v === 'string' && v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function ledgerCurrency(row: CcxtLedgerRow): string | null {
  const info = row.info as { asset?: unknown; currency?: unknown; coin?: unknown }
  const value = row.currency ?? info?.asset ?? info?.currency ?? info?.coin
  if (typeof value !== 'string' || value.trim() === '') return null
  return value.trim().toUpperCase()
}

function positionSettlementCurrency(row: CcxtPositionHistoryRow): string | null {
  const info = row.info as {
    ccy?: unknown
    marginCoin?: unknown
    settleCoin?: unknown
    currency?: unknown
    symbol?: unknown
    contract?: unknown
    instId?: unknown
  }
  const explicit = info?.ccy ?? info?.marginCoin ?? info?.settleCoin ?? info?.currency
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return explicit.trim().toUpperCase()
  }

  const instrument = row.symbol ?? info?.symbol ?? info?.contract ?? info?.instId
  if (typeof instrument !== 'string') return null
  const normalized = instrument.toUpperCase()
  for (const currency of USD_STABLES) {
    if (normalized.endsWith(currency)) return currency
  }
  return null
}

function balanceEvidence(
  balance: Awaited<ReturnType<CcxtLike['fetchBalance']>>,
  source: FirstPartyBalanceSource
): number | null {
  if (source === 'bybit_total_equity') {
    const info = balance.info as {
      result?: { list?: Array<{ totalEquity?: unknown }> }
    }
    return num(info?.result?.list?.[0]?.totalEquity)
  }
  if (source === 'binance_margin_balance') {
    return num((balance.info as { totalMarginBalance?: unknown })?.totalMarginBalance)
  }
  if (source === 'bitget_usdt_equity') {
    const entries = balance.info as Array<{ usdtEquity?: unknown }>
    if (!Array.isArray(entries) || entries.length === 0) return null
    let total = 0
    for (const entry of entries) {
      const value = num(entry.usdtEquity)
      if (value === null) return null
      total += value
    }
    return total
  }
  if (source === 'okx_total_equity') {
    const info = balance.info as {
      data?: Array<{ totalEq?: unknown }>
    }
    return num(info?.data?.[0]?.totalEq)
  }

  let total: number | null = null
  for (const currency of STABLES) {
    const value = num(balance.total?.[currency])
    if (value !== null) total = (total ?? 0) + value
  }
  return total
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
  maxRangeDays?: number,
  requireStableCurrency = false
): Promise<RealizedEvent[]> {
  if (!client.fetchPositionsHistory) {
    throw new Error('[first-party] position history evidence is unavailable')
  }
  const fetchPositionsHistory = client.fetchPositionsHistory.bind(client)
  const out: RealizedEvent[] = []
  const maxRangeMs = maxRangeDays === undefined ? null : maxRangeDays * DAY_MS
  let requests = 0
  let rangeStart = sinceMs

  const fetchRange = async (start: number, end: number): Promise<void> => {
    requests += 1
    if (requests > MAX_EVIDENCE_REQUESTS) {
      throw new Error('[first-party] position history evidence is truncated')
    }
    const rows = await fetchPositionsHistory(undefined, start, POSITION_HISTORY_LIMIT, {
      until: end,
    })
    if (rows.length >= POSITION_HISTORY_LIMIT) {
      // OKX's pinned adapter does not forward time bounds; it must remain
      // fail-closed on a saturated latest page. The bounded adapters can
      // safely prove completeness by splitting the requested time range.
      if (maxRangeMs === null || start >= end) {
        throw new Error('[first-party] position history evidence is truncated')
      }
      const midpoint = Math.floor((start + end) / 2)
      await fetchRange(start, midpoint)
      await fetchRange(midpoint + 1, end)
      return
    }
    for (const r of rows) {
      // CCXT's unified `timestamp` is commonly the position open/create time.
      // Realized PnL belongs to the close/update window.
      const ts = positionCloseTimestamp(r)
      const info = r.info as { netProfit?: unknown; closedPnl?: unknown }
      // Bitget's unified `realizedPnl` is the gross price PnL. Its raw
      // `netProfit` also includes open/close fees and funding, which is the
      // amount that actually changed account equity.
      const pnl = num(info?.netProfit ?? r.realizedPnl ?? info?.closedPnl)
      const currency = positionSettlementCurrency(r)
      if (ts === null || pnl === null || ts < start || ts > end) {
        throw new Error('[first-party] position history evidence is invalid')
      }
      if (requireStableCurrency && (currency === null || !USD_STABLES.has(currency))) {
        throw new Error('[first-party] position history currency evidence is invalid')
      }
      out.push({ ts, pnl, positionLevel: true })
    }
  }

  while (rangeStart <= untilMs) {
    const rangeEnd = maxRangeMs === null ? untilMs : Math.min(untilMs, rangeStart + maxRangeMs)
    await fetchRange(rangeStart, rangeEnd)
    if (maxRangeMs === null || rangeEnd === untilMs) break
    rangeStart = rangeEnd + 1
  }
  return out.sort((a, b) => a.ts - b.ts)
}

/** Realized events via income/ledger records (binanceusdm REALIZED_PNL). */
async function eventsFromLedger(
  client: CcxtLike,
  sinceMs: number,
  untilMs: number,
  requireStableCurrency = false
): Promise<RealizedEvent[]> {
  if (!client.fetchLedger) {
    throw new Error('[first-party] realized PnL ledger evidence is unavailable')
  }
  const fetchLedger = client.fetchLedger.bind(client)
  const out: RealizedEvent[] = []
  let requests = 0

  const fetchRange = async (rangeStart: number, rangeEnd: number): Promise<void> => {
    requests += 1
    if (requests > MAX_EVIDENCE_REQUESTS) {
      throw new Error('[first-party] realized PnL ledger evidence is truncated')
    }
    const rows = await fetchLedger(undefined, rangeStart, LEDGER_LIMIT, {
      incomeType: 'REALIZED_PNL',
      until: rangeEnd,
    })
    if (rows.length >= LEDGER_LIMIT) {
      if (rangeStart >= rangeEnd) {
        throw new Error('[first-party] realized PnL ledger evidence is truncated')
      }
      const midpoint = Math.floor((rangeStart + rangeEnd) / 2)
      await fetchRange(rangeStart, midpoint)
      await fetchRange(midpoint + 1, rangeEnd)
      return
    }
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
        const currency = ledgerCurrency(r)
        const amt =
          rawIncome ??
          (normalizedAmount === null
            ? null
            : r.direction === 'out'
              ? -Math.abs(normalizedAmount)
              : r.direction === 'in'
                ? Math.abs(normalizedAmount)
                : normalizedAmount)
        if (ts === null || amt === null || ts < rangeStart || ts > rangeEnd) {
          throw new Error('[first-party] realized PnL ledger evidence is invalid')
        }
        if (requireStableCurrency && (currency === null || !USD_STABLES.has(currency))) {
          throw new Error('[first-party] realized PnL ledger currency evidence is invalid')
        }
        out.push({ ts, pnl: amt, positionLevel: false })
      }
    }
  }

  await fetchRange(sinceMs, untilMs)
  return out.sort((a, b) => a.ts - b.ts)
}

/** Net transfers IN (deposits/transfer-in − withdrawals/transfer-out). */
async function netTransfers(
  client: CcxtLike,
  sinceMs: number,
  untilMs: number,
  contract?: FirstPartyTransferLedgerContract
): Promise<Array<{ ts: number; amount: number }> | null> {
  if (!client.fetchLedger || !contract) return null
  const out: Array<{ ts: number; amount: number }> = []
  try {
    const rangeMs = contract.maxRangeDays * DAY_MS
    for (const query of contract.queries) {
      let rangeStart = sinceMs
      while (rangeStart <= untilMs) {
        const rangeEnd = Math.min(untilMs, rangeStart + rangeMs)
        const rows = await client.fetchLedger(undefined, rangeStart, contract.pageLimit, {
          ...query,
          [contract.untilParam]: rangeEnd,
        })
        if (rows.length >= contract.pageLimit) return null
        for (const r of rows) {
          const ts = num(r.timestamp)
          const amt = num(r.amount)
          if (ts === null || ts < rangeStart || ts > rangeEnd) return null
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
          if (amt === null) return null
          const currency = ledgerCurrency(r)
          if (currency === null || !USD_STABLES.has(currency)) return null
          const sign =
            r.direction === 'out' || rawType.includes('OUT') || rawType.includes('WITHDRAW')
              ? -1
              : 1
          out.push({ ts, amount: sign * Math.abs(amt) })
        }
        if (rangeEnd === untilMs) break
        rangeStart = rangeEnd + 1
      }
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
    balanceSource?: FirstPartyBalanceSource
    realizedPnlSource: FirstPartyRealizedPnlSource
    requireStablePnlCurrency?: boolean
    positionHistoryMaxRangeDays?: number
    transferLedgerContract?: FirstPartyTransferLedgerContract
    lookbackDays?: number
    lastSyncMs?: number | null
  }
): Promise<Omit<FirstPartyComputeInput, 'snapshots'>> {
  const nowMs = opts.nowMs
  const sinceMs = nowMs - (opts.lookbackDays ?? 90) * DAY_MS

  // Balance + unrealized (read-only, same calls as the portfolio sync).
  const bal = await client.fetchBalance()
  const balanceSource = opts.balanceSource ?? 'stable_totals'
  const balanceNow = balanceEvidence(bal, balanceSource)
  if (balanceNow === null) {
    const evidence = balanceSource === 'stable_totals' ? 'stablecoin balance' : 'account equity'
    throw new Error(`[first-party] ${evidence} evidence is unavailable`)
  }

  let unrealizedNow: number | null = null
  if (client.fetchPositions) {
    try {
      const positions = await client.fetchPositions(undefined)
      let complete = true
      let sum = 0
      for (const position of positions) {
        const contracts = num(position.contracts)
        const pnl = num(position.unrealizedPnl)
        // Exchanges commonly include dormant zero-contract rows with no PnL.
        // A live (or indeterminate) row without PnL must not be invented as 0.
        if (contracts === 0) continue
        if (pnl === null) {
          complete = false
          break
        }
        sum += pnl
      }
      unrealizedNow = complete ? sum : null
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
      ? await eventsFromPositionsHistory(
          client,
          sinceMs,
          nowMs,
          opts.positionHistoryMaxRangeDays,
          opts.requireStablePnlCurrency
        )
      : await eventsFromLedger(client, sinceMs, nowMs, opts.requireStablePnlCurrency)

  // Transfers → per-window net-in + since-last-sync delta.
  const transfers = await netTransfers(client, sinceMs, nowMs, opts.transferLedgerContract)
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
