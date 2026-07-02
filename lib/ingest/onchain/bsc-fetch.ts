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

import { decodeBscSwaps, bscQuoteConfig, TRANSFER_TOPIC, type RawLog } from './bsc-swaps'
import { computeWalletPnl, type WalletPnl } from './pnl-accounting'

const DEFAULT_RPCS = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
]
const BSC_BLOCKS_PER_DAY = 28_800 // ~3s blocks
const DEFAULT_WINDOW = 10_000 // conservative getLogs block span
const MIN_WINDOW = 500

interface RpcOpts {
  rpcUrls?: string[]
  timeoutMs?: number
}

async function rpc<T>(
  method: string,
  params: unknown[],
  opts: RpcOpts = {},
  rpcIndex = 0
): Promise<T> {
  const urls = opts.rpcUrls ?? DEFAULT_RPCS
  const url = urls[rpcIndex % urls.length]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    })
    const json = (await res.json()) as { result?: T; error?: { message?: string } }
    if (json.error) throw new Error(`rpc ${method}: ${json.error.message ?? 'error'}`)
    return json.result as T
  } finally {
    clearTimeout(timer)
  }
}

export async function getBscHead(opts: RpcOpts = {}): Promise<number> {
  const hex = await rpc<string>('eth_blockNumber', [], opts)
  return Number(BigInt(hex))
}

const walletTopic = (addr: string) => '0x' + '0'.repeat(24) + addr.toLowerCase().replace(/^0x/, '')

/** Is this a public-RPC "range too wide / too many results" complaint? */
function isRangeError(msg: string): boolean {
  const m = msg.toLowerCase()
  return (
    m.includes('range') ||
    m.includes('limit') ||
    m.includes('too many') ||
    m.includes('exceed') ||
    m.includes('more than')
  )
}

/**
 * Fetch all Transfer logs where the wallet is sender OR receiver, over
 * [fromBlock, toBlock]. Two topic-filtered getLogs per window (from-slot,
 * to-slot). Adaptively halves the window on range errors down to MIN_WINDOW.
 */
export async function fetchWalletTransferLogs(
  wallet: string,
  fromBlock: number,
  toBlock: number,
  opts: RpcOpts & { window?: number; maxCalls?: number } = {}
): Promise<RawLog[]> {
  const wt = walletTopic(wallet)
  const out: RawLog[] = []
  let window = opts.window ?? DEFAULT_WINDOW
  const maxCalls = opts.maxCalls ?? 400
  let calls = 0
  let start = fromBlock

  while (start <= toBlock && calls < maxCalls) {
    const end = Math.min(start + window - 1, toBlock)
    const base = { fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16) }
    try {
      // from = wallet (topic1), and to = wallet (topic2) — two calls.
      const [asFrom, asTo] = await Promise.all([
        rpc<RawLog[]>('eth_getLogs', [{ ...base, topics: [TRANSFER_TOPIC, wt] }], opts),
        rpc<RawLog[]>('eth_getLogs', [{ ...base, topics: [TRANSFER_TOPIC, null, wt] }], opts),
      ])
      calls += 2
      if (Array.isArray(asFrom)) out.push(...asFrom)
      if (Array.isArray(asTo)) out.push(...asTo)
      start = end + 1
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isRangeError(msg) && window > MIN_WINDOW) {
        window = Math.max(MIN_WINDOW, Math.floor(window / 2)) // shrink + retry same start
        continue
      }
      throw err
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
  fromBlock: number
  toBlock: number
  logs: number
  swaps: number
  bnbUsd: number
  pnl: WalletPnl
}

/** End-to-end: fetch → decode → PnL for one BSC wallet over the last N days. */
export async function computeBscWalletOnchain(
  wallet: string,
  opts: RpcOpts & {
    lookbackDays?: number
    window?: number
    maxCalls?: number
    bnbUsd?: number
  } = {}
): Promise<BscWalletResult> {
  const head = await getBscHead(opts)
  const lookbackDays = opts.lookbackDays ?? 90
  const fromBlock = Math.max(0, head - lookbackDays * BSC_BLOCKS_PER_DAY)
  const [logs, bnbUsd] = await Promise.all([
    fetchWalletTransferLogs(wallet, fromBlock, head, opts),
    opts.bnbUsd !== undefined ? Promise.resolve(opts.bnbUsd) : fetchBnbUsd(opts),
  ])
  const swaps = decodeBscSwaps(logs, wallet, bscQuoteConfig(bnbUsd))
  return {
    wallet,
    fromBlock,
    toBlock: head,
    logs: logs.length,
    swaps: swaps.length,
    bnbUsd,
    pnl: computeWalletPnl(swaps),
  }
}
