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
  error?: unknown
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function duneKey(): string {
  const k = process.env.DUNE_API_KEY
  if (!k) throw new Error('[onchain] DUNE_API_KEY missing')
  return k
}

/**
 * Batched fetch: one Dune execution for ALL wallets → per-wallet NATIVE_BNB
 * in-legs. Wallets passed as 0x-addresses; normalized to no-0x lowercase for
 * the query param. Returns an empty map on any failure (BSC realized just stays
 * partial — never blocks enrichment).
 */
export async function fetchBscInternalBnb(
  wallets: string[],
  opts: { timeoutMs?: number; pollMs?: number; maxPolls?: number } = {}
): Promise<Map<string, NormalizedTransfer[]>> {
  const key = duneKey()
  const list = wallets.map((w) => w.toLowerCase().replace(/^0x/, '')).join(',')
  const headers = { 'X-Dune-Api-Key': key, 'content-type': 'application/json' }
  try {
    const exRes = await fetch(
      `https://api.dune.com/api/v1/query/${DUNE_BSC_INTERNAL_QUERY_ID}/execute`,
      { method: 'POST', headers, body: JSON.stringify({ query_parameters: { wallets: list } }) }
    )
    const ex = (await exRes.json()) as DuneExec
    if (!ex.execution_id) return new Map()

    const maxPolls = opts.maxPolls ?? 24
    for (let i = 0; i < maxPolls; i++) {
      await sleep(opts.pollMs ?? 5000)
      const stRes = await fetch(`https://api.dune.com/api/v1/execution/${ex.execution_id}/status`, {
        headers,
      })
      const st = (await stRes.json()) as DuneExec
      if (st.state === 'QUERY_STATE_COMPLETED') break
      if (st.state === 'QUERY_STATE_FAILED') return new Map()
    }
    const resRes = await fetch(
      `https://api.dune.com/api/v1/execution/${ex.execution_id}/results?limit=5000`,
      { headers }
    )
    const res = (await resRes.json()) as DuneResults
    return internalRowsToTransfers(res.result?.rows ?? [])
  } catch {
    return new Map()
  }
}
