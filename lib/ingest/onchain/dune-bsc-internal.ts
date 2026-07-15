/**
 * Dune-sourced BSC internal BNB receipts (Phase A — item C, $0 fix).
 *
 * Alchemy's BSC getAssetTransfers omits INTERNAL transfers, so native-BNB SELL
 * proceeds (router → wallet) are invisible → realized PnL understated for
 * native-BNB sellers. Dune's `bnb.traces` dataset HAS these. We query it (one
 * batched execution for all top-N wallets) via the existing DUNE_API_KEY — free,
 * no new credential — and inject the results as NATIVE_BNB in-legs so the swap
 * decoder pairs them with the token-out legs → sells complete.
 *
 * Saved batched query (public): id 7864271, param `wallets` = comma-joined
 * lowercase no-0x addresses; returns (wallet, tx_hash, bnb, block_time).
 * A pure row parser (testable) + a thin execute/poll fetcher.
 */

import { NATIVE_BNB, type NormalizedTransfer } from './bsc-swaps'

/** The public saved query created for this (see module header). */
export const DUNE_BSC_INTERNAL_QUERY_ID = 7864271

export interface DuneInternalRow {
  wallet?: string // to_hex output: lowercase, NO 0x
  tx_hash?: string // to_hex output: lowercase, NO 0x
  bnb?: number
  block_time?: string
}

/**
 * Group Dune internal-BNB rows into per-wallet NATIVE_BNB in-legs (keyed by a
 * 0x-prefixed lowercase wallet). Pure — the fetcher supplies raw rows.
 */
export function internalRowsToTransfers(
  rows: DuneInternalRow[]
): Map<string, NormalizedTransfer[]> {
  const byWallet = new Map<string, NormalizedTransfer[]>()
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r.wallet !== 'string' || typeof r.tx_hash !== 'string') continue
    const bnb = Number(r.bnb)
    if (!Number.isFinite(bnb) || bnb <= 0) continue
    const wallet = '0x' + r.wallet.toLowerCase().replace(/^0x/, '')
    const ts =
      typeof r.block_time === 'string' && !Number.isNaN(Date.parse(r.block_time))
        ? new Date(r.block_time).toISOString()
        : new Date(0).toISOString()
    const tr: NormalizedTransfer = {
      token: NATIVE_BNB,
      from: '', // router/pool (unused by decoder — only the quote value matters)
      to: wallet,
      amount: bnb,
      tx: '0x' + r.tx_hash.toLowerCase().replace(/^0x/, ''),
      ts,
    }
    const arr = byWallet.get(wallet) ?? []
    arr.push(tr)
    byWallet.set(wallet, arr)
  }
  return byWallet
}

interface DuneExec {
  execution_id?: string
  state?: string
}
interface DuneResults {
  state?: string
  result?: { rows?: DuneInternalRow[] }
  next_offset?: number
  next_uri?: string
  error?: unknown
}

export type DuneInternalStopReason =
  | 'results_complete'
  | 'api_key_missing'
  | 'execution_failed'
  | 'execution_partial'
  | 'poll_limit'
  | 'result_page_cap'
  | 'invalid_response'
  | 'upstream_error'

export interface DuneInternalCoverage {
  scanComplete: boolean
  truncated: boolean
  stopReason: DuneInternalStopReason
  walletsRequested: number
  pagesFetched: number
  rowsFetched: number
}

export interface DuneInternalScan {
  transfersByWallet: Map<string, NormalizedTransfer[]>
  coverage: DuneInternalCoverage
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Batched fetch: one Dune execution for ALL wallets → per-wallet NATIVE_BNB
 * in-legs plus an explicit coverage proof. Wallets passed as 0x-addresses;
 * normalized to no-0x lowercase for the query param. A successful zero-row
 * result is complete; a timeout, partial execution, malformed response or
 * pagination cap is not.
 */
export async function scanBscInternalBnb(
  wallets: string[],
  opts: {
    timeoutMs?: number
    pollMs?: number
    maxPolls?: number
    resultPageSize?: number
    maxResultPages?: number
  } = {}
): Promise<DuneInternalScan> {
  const normalizedWallets = [...new Set(wallets.map((w) => w.toLowerCase()))]
  const empty = new Map<string, NormalizedTransfer[]>()
  const finish = (
    stopReason: DuneInternalStopReason,
    rows: DuneInternalRow[] = [],
    pagesFetched = 0
  ): DuneInternalScan => ({
    transfersByWallet: internalRowsToTransfers(rows),
    coverage: {
      scanComplete: stopReason === 'results_complete',
      truncated:
        stopReason === 'execution_partial' ||
        stopReason === 'result_page_cap' ||
        (rows.length > 0 && stopReason !== 'results_complete'),
      stopReason,
      walletsRequested: normalizedWallets.length,
      pagesFetched,
      rowsFetched: rows.length,
    },
  })

  if (normalizedWallets.length === 0) {
    return {
      transfersByWallet: empty,
      coverage: {
        scanComplete: true,
        truncated: false,
        stopReason: 'results_complete',
        walletsRequested: 0,
        pagesFetched: 0,
        rowsFetched: 0,
      },
    }
  }
  const key = process.env.DUNE_API_KEY
  if (!key) return finish('api_key_missing')
  const list = normalizedWallets.map((w) => w.replace(/^0x/, '')).join(',')
  const headers = { 'X-Dune-Api-Key': key, 'content-type': 'application/json' }
  const timeoutMs = opts.timeoutMs ?? 30_000
  const request = async (url: string, init?: RequestInit): Promise<unknown> => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...init, headers, signal: ctrl.signal })
      if (!res.ok) throw new Error(`Dune HTTP ${res.status}`)
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    const ex = (await request(
      `https://api.dune.com/api/v1/query/${DUNE_BSC_INTERNAL_QUERY_ID}/execute`,
      { method: 'POST', headers, body: JSON.stringify({ query_parameters: { wallets: list } }) }
    )) as DuneExec
    if (!ex.execution_id) return finish('invalid_response')

    const maxPolls = opts.maxPolls ?? 24
    let completed = false
    for (let i = 0; i < maxPolls; i++) {
      await sleep(opts.pollMs ?? 5000)
      const st = (await request(
        `https://api.dune.com/api/v1/execution/${ex.execution_id}/status`
      )) as DuneExec
      if (st.state === 'QUERY_STATE_COMPLETED') {
        completed = true
        break
      }
      if (st.state === 'QUERY_STATE_COMPLETED_PARTIAL') return finish('execution_partial')
      if (
        st.state === 'QUERY_STATE_FAILED' ||
        st.state === 'QUERY_STATE_CANCELED' ||
        st.state === 'QUERY_STATE_EXPIRED'
      ) {
        return finish('execution_failed')
      }
    }
    if (!completed) return finish('poll_limit')

    const pageSize = opts.resultPageSize ?? 5000
    const maxResultPages = opts.maxResultPages ?? 20
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0) return finish('invalid_response')
    if (!Number.isSafeInteger(maxResultPages) || maxResultPages <= 0) {
      return finish('invalid_response')
    }
    const rows: DuneInternalRow[] = []
    let offset = 0
    for (let page = 0; page < maxResultPages; page++) {
      const result = (await request(
        `https://api.dune.com/api/v1/execution/${ex.execution_id}/results` +
          `?limit=${pageSize}&offset=${offset}`
      )) as DuneResults
      if (
        result.state !== 'QUERY_STATE_COMPLETED' ||
        result.error ||
        !result.result ||
        !Array.isArray(result.result.rows)
      ) {
        return finish('invalid_response', rows, page)
      }
      rows.push(...result.result.rows)
      const nextOffset = result.next_offset
      const hasNext = typeof result.next_uri === 'string' || nextOffset !== undefined
      if (!hasNext) return finish('results_complete', rows, page + 1)
      if (!Number.isSafeInteger(nextOffset) || (nextOffset as number) <= offset) {
        return finish('invalid_response', rows, page + 1)
      }
      offset = nextOffset as number
    }
    return finish('result_page_cap', rows, maxResultPages)
  } catch {
    return finish('upstream_error')
  }
}

/** Compatibility wrapper for callers that have not yet adopted coverage. */
export async function fetchBscInternalBnb(
  wallets: string[],
  opts: Parameters<typeof scanBscInternalBnb>[1] = {}
): Promise<Map<string, NormalizedTransfer[]>> {
  return (await scanBscInternalBnb(wallets, opts)).transfersByWallet
}
