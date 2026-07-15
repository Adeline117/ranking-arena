/**
 * Moralis-sourced BSC internal BNB receipts (Phase B, 2026-07-09).
 *
 * Same gap as dune-bsc-internal (Alchemy's BSC getAssetTransfers omits
 * INTERNAL transfers, so native-BNB SELL proceeds router→wallet are invisible
 * → realized PnL understated for native-BNB sellers), but served per-wallet in
 * real time by the Moralis EVM API (owner的付费会员 key, 2026-07-09) instead of
 * a batched Dune execution with 5s polls. Live-verified: partial-realized
 * wallets return inbound internal BNB legs (0.967/0.442 BNB router→wallet).
 *
 * GET deep-index.moralis.io/api/v2.2/{wallet}?chain=bsc
 *     &include=internal_transactions&from_date=...  (cursor-paginated)
 * → keep internal txs whose `to` == wallet, value in wei → NATIVE_BNB in-legs
 * (same NormalizedTransfer shape the swap decoder pairs with token-out legs).
 */

import { NATIVE_BNB, type NormalizedTransfer } from './bsc-swaps'

interface MoralisInternalTx {
  to?: string | null
  value?: string | null
}
interface MoralisNativeTx {
  hash?: string
  block_timestamp?: string
  internal_transactions?: MoralisInternalTx[] | null
}
interface MoralisTxPage {
  cursor?: string | null
  result?: MoralisNativeTx[]
}

export type MoralisInternalStopReason =
  | 'history_exhausted'
  | 'page_cap'
  | 'missing_api_key'
  | 'request_error'
  | 'invalid_response'

export interface MoralisInternalCoverage {
  scanComplete: boolean
  truncated: boolean
  stopReason: MoralisInternalStopReason
  pagesFetched: number
  recordsSeen: number
  recordsReturned: number
  errors: string[]
}

export interface MoralisInternalScan {
  transfers: NormalizedTransfer[]
  coverage: MoralisInternalCoverage
}

const WEI_PER_BNB = 1e18

/** Pure converter — one wallet's native-tx page rows → its NATIVE_BNB in-legs. */
export function moralisTxsToInternalLegs(
  wallet: string,
  txs: MoralisNativeTx[]
): NormalizedTransfer[] {
  const w = wallet.toLowerCase()
  const legs: NormalizedTransfer[] = []
  for (const tx of Array.isArray(txs) ? txs : []) {
    if (!tx || typeof tx.hash !== 'string') continue
    const ts =
      typeof tx.block_timestamp === 'string' && !Number.isNaN(Date.parse(tx.block_timestamp))
        ? new Date(tx.block_timestamp).toISOString()
        : new Date(0).toISOString()
    for (const itx of tx.internal_transactions ?? []) {
      if ((itx?.to ?? '').toLowerCase() !== w) continue
      const bnb = Number(itx?.value) / WEI_PER_BNB
      if (!Number.isFinite(bnb) || bnb <= 0) continue
      legs.push({
        token: NATIVE_BNB,
        from: '', // router/pool (unused by decoder — only the quote value matters)
        to: w,
        amount: bnb,
        tx: tx.hash.toLowerCase(),
        ts,
      })
    }
  }
  return legs
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parsePage(value: unknown): MoralisTxPage | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as MoralisTxPage).result)) {
    return null
  }
  const page = value as MoralisTxPage
  if (page.cursor !== undefined && page.cursor !== null && typeof page.cursor !== 'string') {
    return null
  }
  for (const tx of page.result ?? []) {
    if (!tx || typeof tx !== 'object') return null
    if (typeof tx.hash !== 'string' || tx.hash.length === 0) return null
    if (typeof tx.block_timestamp !== 'string' || Number.isNaN(Date.parse(tx.block_timestamp))) {
      return null
    }
    if (
      tx.internal_transactions !== undefined &&
      tx.internal_transactions !== null &&
      !Array.isArray(tx.internal_transactions)
    ) {
      return null
    }
    for (const internal of tx.internal_transactions ?? []) {
      if (!internal || typeof internal !== 'object') return null
      if (internal.to !== undefined && internal.to !== null && typeof internal.to !== 'string') {
        return null
      }
      if (
        internal.value !== undefined &&
        internal.value !== null &&
        typeof internal.value !== 'string'
      ) {
        return null
      }
    }
  }
  return page
}

/**
 * Per-wallet cursor scan with explicit coverage evidence. Only cursor
 * exhaustion proves the requested Moralis query complete. Page caps, missing
 * configuration, request failures and malformed payloads retain any valid
 * partial transfers but fail closed in `coverage`.
 */
export async function scanMoralisInternalBnb(
  wallet: string,
  opts: { lookbackDays?: number; timeoutMs?: number; maxPages?: number } = {}
): Promise<MoralisInternalScan> {
  const maxPages = opts.maxPages ?? 5
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
    throw new RangeError('maxPages must be a positive safe integer')
  }

  const transfers: NormalizedTransfer[] = []
  let pagesFetched = 0
  let recordsSeen = 0
  const finish = (
    stopReason: MoralisInternalStopReason,
    errors: string[] = []
  ): MoralisInternalScan => {
    const scanComplete = stopReason === 'history_exhausted' && errors.length === 0
    const truncated = stopReason === 'page_cap' || (!scanComplete && pagesFetched > 0)
    return {
      transfers,
      coverage: {
        scanComplete,
        truncated,
        stopReason,
        pagesFetched,
        recordsSeen,
        recordsReturned: transfers.length,
        errors,
      },
    }
  }

  const key = process.env.MORALIS_API_KEY
  if (!key) return finish('missing_api_key', ['MORALIS_API_KEY missing'])
  const fromDate = new Date(Date.now() - (opts.lookbackDays ?? 90) * 86_400_000)
    .toISOString()
    .slice(0, 10)
  const base =
    `https://deep-index.moralis.io/api/v2.2/${wallet}` +
    `?chain=bsc&include=internal_transactions&from_date=${fromDate}&limit=100`
  let cursor: string | null = null
  const requestedCursors = new Set<string>()

  for (let pageN = 0; pageN < maxPages; pageN++) {
    const url = cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base
    if (cursor) requestedCursors.add(cursor)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000)
    let res: Response
    try {
      res = await fetch(url, {
        headers: { 'X-API-Key': key, accept: 'application/json' },
        signal: ctrl.signal,
      })
    } catch (error) {
      return finish('request_error', [`Moralis request failed: ${errorMessage(error)}`])
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      return finish('request_error', [`Moralis request failed: HTTP ${res.status}`])
    }

    let payload: unknown
    try {
      payload = await res.json()
    } catch (error) {
      return finish('invalid_response', [`Moralis response JSON invalid: ${errorMessage(error)}`])
    }
    const page = parsePage(payload)
    if (!page) {
      return finish('invalid_response', ['Moralis response shape invalid'])
    }

    const rows = page.result ?? []
    pagesFetched += 1
    recordsSeen += rows.length
    transfers.push(...moralisTxsToInternalLegs(wallet, rows))

    const nextCursor = page.cursor || null
    if (!nextCursor) return finish('history_exhausted')
    if (rows.length === 0) {
      return finish('invalid_response', ['Moralis returned an empty page with a cursor'])
    }
    if (requestedCursors.has(nextCursor)) {
      return finish('invalid_response', ['Moralis cursor repeated'])
    }
    cursor = nextCursor
  }

  return finish('page_cap')
}

/**
 * Compatibility wrapper for existing enrichment callers. It deliberately
 * preserves the historical fail-soft array contract; callers making quality
 * claims must use {@link scanMoralisInternalBnb} and inspect coverage.
 */
export async function fetchMoralisInternalBnb(
  wallet: string,
  opts: { lookbackDays?: number; timeoutMs?: number; maxPages?: number } = {}
): Promise<NormalizedTransfer[]> {
  return (await scanMoralisInternalBnb(wallet, opts)).transfers
}
