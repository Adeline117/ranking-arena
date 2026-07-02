/**
 * BSC on-chain fetcher (Phase A — the network half; decoder is bsc-swaps.ts).
 *
 * Pulls a wallet's ERC-20 Transfer logs via eth_getLogs (server-side topic
 * filter — no full-chain scan), decodes them into swaps, runs the PnL engine.
 *
 * PROVIDER NOTE (verified 2026-07-01): FREE PUBLIC BSC RPCs CANNOT serve
 * per-wallet history — bsc-dataseed/defibit "limit exceeded", 1rpc caps
 * getLogs to 50-block ranges, publicnode requires an archive token. Point
 * queries (getBalance/txCount) work, historical getLogs does not. Use a real
 * provider: the repo's ALCHEMY_API_KEY works once BNB Smart Chain is enabled
 * on the app (free dashboard toggle) — Alchemy allows wide getLogs and, better,
 * `alchemy_getAssetTransfers` (address-indexed, decoded values + timestamps, no
 * block scan). Point `rpcUrls` at the Alchemy BNB endpoint. See
 * memory/onchain-web3-enrichment-plan.md.
 *
 * Ordering uses block height (the decoder's fallback ts) — no per-block
 * timestamp storm; PnL accounting only needs a monotonic order.
 */

import {
  bscQuoteConfig,
  decodeTransfersToSwaps,
  NATIVE_BNB,
  type NormalizedTransfer,
} from './bsc-swaps'
import { computeWalletPnl, type WalletPnl } from './pnl-accounting'

/** Alchemy BNB endpoint from the shared key (BNB network enabled 2026-07-01). */
function alchemyBscUrl(): string {
  const key = process.env.ALCHEMY_API_KEY
  if (!key) throw new Error('[onchain] ALCHEMY_API_KEY missing')
  return `https://bnb-mainnet.g.alchemy.com/v2/${key}`
}

interface RpcOpts {
  rpcUrls?: string[]
  timeoutMs?: number
}

const DEFAULT_RPCS = [] as string[] // set lazily to alchemyBscUrl()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function isTransient(msg: string): boolean {
  const m = msg.toLowerCase()
  return (
    m.includes('compute unit') ||
    m.includes('throughput') ||
    m.includes('rate') ||
    m.includes('429') ||
    m.includes('unexpected end of json') ||
    m.includes('timeout') ||
    m.includes('aborted') ||
    m.includes('fetch failed') ||
    m.includes('econnreset')
  )
}

async function rpc<T>(
  method: string,
  params: unknown[],
  opts: RpcOpts = {},
  rpcIndex = 0
): Promise<T> {
  const urls = opts.rpcUrls && opts.rpcUrls.length > 0 ? opts.rpcUrls : [alchemyBscUrl()]
  const url = urls[rpcIndex % urls.length]
  const attempts = 5
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: ctrl.signal,
      })
      const text = await res.text()
      const json = (text ? JSON.parse(text) : {}) as { result?: T; error?: { message?: string } }
      if (json.error) throw new Error(`rpc ${method}: ${json.error.message ?? 'error'}`)
      return json.result as T
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (i < attempts - 1 && isTransient(msg)) {
        await sleep(400 * 2 ** i)
        continue
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`rpc ${method}: exhausted retries`)
}

export async function getBscHead(opts: RpcOpts = {}): Promise<number> {
  const hex = await rpc<string>('eth_blockNumber', [], opts)
  return Number(BigInt(hex))
}

interface AlchemyTransfer {
  hash: string
  from: string
  to: string | null
  value: number | null
  asset?: string | null
  category?: string
  rawContract?: { address?: string | null }
  metadata?: { blockTimestamp?: string }
}
interface AlchemyTransfersPage {
  transfers: AlchemyTransfer[]
  pageKey?: string
}

/**
 * Fetch a wallet's ERC-20 transfers (both directions) via
 * alchemy_getAssetTransfers — address-indexed, decoded values + timestamps, no
 * block scan. Paginates by pageKey; `sinceMs` stops once transfers predate the
 * lookback window (order desc). Two directions merged.
 */
export async function fetchWalletTransfers(
  wallet: string,
  opts: RpcOpts & { sinceMs?: number; maxPages?: number } = {}
): Promise<NormalizedTransfer[]> {
  const out: NormalizedTransfer[] = []
  const sinceMs = opts.sinceMs ?? 0
  const maxPages = opts.maxPages ?? 20

  // erc20 = token legs; external/internal = NATIVE BNB legs (most BSC memecoin
  // swaps pay in native BNB — without these every swap looks quote-less).
  const categories = ['erc20', 'external', 'internal']
  for (const dir of ['fromAddress', 'toAddress'] as const) {
    let pageKey: string | undefined
    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, unknown> = {
        [dir]: wallet,
        category: categories,
        withMetadata: true,
        order: 'desc',
        maxCount: '0x3e8', // 1000
      }
      if (pageKey) params.pageKey = pageKey
      const res = await rpc<AlchemyTransfersPage>('alchemy_getAssetTransfers', [params], opts)
      const rows = res?.transfers ?? []
      let reachedOld = false
      for (const t of rows) {
        const ts = t.metadata?.blockTimestamp
        if (!ts || t.value == null || !Number.isFinite(t.value) || t.value <= 0) continue
        if (sinceMs && Date.parse(ts) < sinceMs) {
          reachedOld = true
          continue
        }
        // Native BNB leg (no contract) → sentinel token; else the ERC-20 contract.
        const contract = t.rawContract?.address?.toLowerCase()
        const token = contract ?? (t.asset === 'BNB' ? NATIVE_BNB : null)
        if (!token) continue
        out.push({ token, from: t.from, to: t.to ?? '', amount: t.value, tx: t.hash, ts })
      }
      pageKey = res?.pageKey
      if (!pageKey || reachedOld) break // done or crossed the window boundary
    }
  }
  return out
}

/** Public BNB/USD spot (keyless). Falls back to a sane default on failure. */
export async function fetchBnbUsd(opts: { timeoutMs?: number } = {}): Promise<number> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000)
  try {
    // llama prices — keyless, no geo issues. coingecko id: binancecoin.
    const res = await fetch('https://coins.llama.fi/prices/current/coingecko:binancecoin', {
      signal: ctrl.signal,
    })
    const json = (await res.json()) as { coins?: Record<string, { price?: number }> }
    const p = json.coins?.['coingecko:binancecoin']?.price
    if (typeof p === 'number' && p > 0) return p
  } catch {
    /* fall through */
  } finally {
    clearTimeout(timer)
  }
  return 600 // conservative fallback; only scales WBNB-quoted legs
}

export interface BscWalletResult {
  wallet: string
  lookbackDays: number
  transfers: number
  swaps: number
  bnbUsd: number
  pnl: WalletPnl
}

/** End-to-end: fetch → decode → PnL for one BSC wallet over the last N days.
 *  `extraTransfers` injects legs Alchemy omits (Dune-sourced native-BNB SELL
 *  receipts — item C) so those sells complete. */
export async function computeBscWalletOnchain(
  wallet: string,
  opts: RpcOpts & {
    lookbackDays?: number
    maxPages?: number
    bnbUsd?: number
    extraTransfers?: NormalizedTransfer[]
  } = {}
): Promise<BscWalletResult> {
  const lookbackDays = opts.lookbackDays ?? 90
  const sinceMs = Date.now() - lookbackDays * 86_400_000
  const [transfers, bnbUsd] = await Promise.all([
    fetchWalletTransfers(wallet, { ...opts, sinceMs }),
    opts.bnbUsd !== undefined ? Promise.resolve(opts.bnbUsd) : fetchBnbUsd(opts),
  ])
  const allTransfers = opts.extraTransfers ? [...transfers, ...opts.extraTransfers] : transfers
  const swaps = decodeTransfersToSwaps(allTransfers, wallet, bscQuoteConfig(bnbUsd))
  return {
    wallet,
    lookbackDays,
    transfers: allTransfers.length,
    swaps: swaps.length,
    bnbUsd,
    pnl: computeWalletPnl(swaps),
  }
}
