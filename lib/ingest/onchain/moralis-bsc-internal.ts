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
  to?: string
  value?: string
}
interface MoralisNativeTx {
  hash?: string
  block_timestamp?: string
  internal_transactions?: MoralisInternalTx[]
}
interface MoralisTxPage {
  cursor?: string | null
  result?: MoralisNativeTx[]
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

/**
 * Per-wallet fetch, cursor-paginated. Returns [] (never throws) on any
 * upstream failure so the enrichment degrades to realized-partial instead of
 * dying — same fail-soft contract as fetchBscInternalBnb (Dune).
 */
export async function fetchMoralisInternalBnb(
  wallet: string,
  opts: { lookbackDays?: number; timeoutMs?: number; maxPages?: number } = {}
): Promise<NormalizedTransfer[]> {
  const key = process.env.MORALIS_API_KEY
  if (!key) return []
  const fromDate = new Date(Date.now() - (opts.lookbackDays ?? 90) * 86_400_000)
    .toISOString()
    .slice(0, 10)
  const base =
    `https://deep-index.moralis.io/api/v2.2/${wallet}` +
    `?chain=bsc&include=internal_transactions&from_date=${fromDate}&limit=100`
  const legs: NormalizedTransfer[] = []
  let cursor: string | null = null
  try {
    for (let pageN = 0; pageN < (opts.maxPages ?? 5); pageN++) {
      const url = cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000)
      const res = await fetch(url, {
        headers: { 'X-API-Key': key, accept: 'application/json' },
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer))
      if (!res.ok) return legs
      const page = (await res.json()) as MoralisTxPage
      legs.push(...moralisTxsToInternalLegs(wallet, page.result ?? []))
      cursor = page.cursor ?? null
      if (!cursor || (page.result?.length ?? 0) === 0) break
    }
    return legs
  } catch {
    return legs
  }
}
