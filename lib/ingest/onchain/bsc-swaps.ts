/**
 * BSC swap decoder (Phase A — pure, testable half of the BSC on-chain fetcher).
 *
 * Turns a wallet's raw ERC-20 Transfer logs into normalized {@link OnchainSwap}
 * events for the PnL engine. A DEX swap moves TWO tokens in one tx: the wallet
 * sends one and receives the other. When exactly one leg is a known QUOTE asset
 * (stablecoin / WBNB) we can value the swap in USD:
 *   wallet RECEIVES non-quote token + SENDS quote  → `buy`  (cost   = quote USD)
 *   wallet SENDS    non-quote token + RECEIVES quote → `sell` (proceeds = quote USD)
 *
 * PnL accounting is per-token average-cost, so the non-quote token amount only
 * needs to be CONSISTENT (raw integer units are fine — decimals cancel in
 * cost/holding). Only the quote leg needs decimals + price → USD. Txs without a
 * clean single-quote / single-token pairing are skipped (can't value honestly).
 *
 * Pure & dependency-free: a network fetcher supplies the logs + BNB price.
 */

import type { OnchainSwap } from './pnl-accounting'

/** ERC-20 Transfer(address,address,uint256) topic0. */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export interface RawLog {
  address: string // token contract that emitted the Transfer
  topics: string[] // [topic0, from(32b), to(32b)]
  data: string // uint256 amount (hex)
  transactionHash: string
  blockNumber: string // hex
  logIndex: string // hex
}

/** Known BSC quote assets → USD price factor. Stables = $1; WBNB = bnbUsd. */
interface QuoteAsset {
  decimals: number
  usdPerUnit: number
}

export interface BscQuoteConfig {
  bnbUsd: number
  /** lowercase address → quote spec. */
  quotes: Record<string, QuoteAsset>
}

/** Sentinel token id for a NATIVE BNB leg (getAssetTransfers external/internal,
 *  no contract). Quoted at bnbUsd like WBNB — most BSC memecoin swaps pay in
 *  native BNB, so this leg is essential or every swap looks quote-less. */
export const NATIVE_BNB = 'native:bnb'

/** Canonical BSC quote set (addresses lowercased). All 18-decimals on BSC. */
export function bscQuoteConfig(bnbUsd: number): BscQuoteConfig {
  return {
    bnbUsd,
    quotes: {
      '0x55d398326f99059ff775485246999027b3197955': { decimals: 18, usdPerUnit: 1 }, // USDT
      '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { decimals: 18, usdPerUnit: 1 }, // USDC
      '0xe9e7cea3dedca5984780bafc599bd69add087d56': { decimals: 18, usdPerUnit: 1 }, // BUSD
      '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { decimals: 18, usdPerUnit: bnbUsd }, // WBNB
      [NATIVE_BNB]: { decimals: 18, usdPerUnit: bnbUsd }, // native BNB (external/internal legs)
    },
  }
}

/** 32-byte topic → 0x-prefixed 20-byte lowercase address. */
function topicToAddress(topic: string): string {
  const h = topic.toLowerCase().replace(/^0x/, '')
  return '0x' + h.slice(24)
}

/** hex → number scaled by 10^decimals (quote amounts only; fits f64 fine). */
function hexToUnits(hex: string, decimals: number): number {
  try {
    const v = BigInt(hex.startsWith('0x') ? hex : '0x' + hex)
    // Scale down by decimals using BigInt to avoid precision loss on huge ints,
    // then to float for the (already small) human value.
    const scale = 10n ** BigInt(decimals)
    const whole = v / scale
    const frac = v % scale
    return Number(whole) + Number(frac) / Number(scale)
  } catch {
    return NaN
  }
}

/** Raw hex → float (unscaled) — for non-quote token amounts (units cancel). */
function hexToRaw(hex: string): number {
  try {
    return Number(BigInt(hex.startsWith('0x') ? hex : '0x' + hex))
  } catch {
    return NaN
  }
}

interface Leg {
  token: string // lowercase contract
  from: string
  to: string
  amountHex: string
}

/**
 * Decode a wallet's Transfer logs into normalized swaps. `blockTs` maps a hex
 * blockNumber → ISO timestamp (from the fetcher's block lookups); a missing
 * entry falls back to a zero-padded blockNumber so ordering still holds.
 */
export function decodeBscSwaps(
  logs: RawLog[],
  walletAddress: string,
  cfg: BscQuoteConfig,
  blockTs: Record<string, string> = {}
): OnchainSwap[] {
  const wallet = walletAddress.toLowerCase()
  // Group Transfer legs by tx.
  const byTx = new Map<string, { legs: Leg[]; block: string; logIndex: number }>()
  for (const log of logs) {
    if (!log.topics || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue
    if (log.topics.length < 3) continue
    const from = topicToAddress(log.topics[1])
    const to = topicToAddress(log.topics[2])
    if (from !== wallet && to !== wallet) continue // wallet not involved
    const key = log.transactionHash
    let g = byTx.get(key)
    if (!g) {
      g = { legs: [], block: log.blockNumber, logIndex: parseInt(log.logIndex || '0x0', 16) }
      byTx.set(key, g)
    }
    g.legs.push({ token: log.address.toLowerCase(), from, to, amountHex: log.data })
  }

  const swaps: OnchainSwap[] = []
  for (const [, g] of byTx) {
    // Split wallet legs into quote vs non-quote, incoming vs outgoing.
    let quoteLeg: (Leg & { usd: number }) | null = null
    let tokenLeg: (Leg & { incoming: boolean }) | null = null
    let quoteCount = 0
    let tokenCount = 0
    for (const leg of g.legs) {
      const incoming = leg.to === wallet
      const q = cfg.quotes[leg.token]
      if (q) {
        quoteCount += 1
        const usd = hexToUnits(leg.amountHex, q.decimals) * q.usdPerUnit
        // Prefer the largest quote leg if several.
        if (!quoteLeg || usd > quoteLeg.usd) quoteLeg = { ...leg, usd }
      } else {
        tokenCount += 1
        const amt = hexToRaw(leg.amountHex)
        if (!tokenLeg || amt > hexToRaw(tokenLeg.amountHex)) tokenLeg = { ...leg, incoming }
      }
    }
    // Clean pairing only: exactly-ish one quote + at least one token leg.
    if (!quoteLeg || !tokenLeg || quoteCount === 0 || tokenCount === 0) continue
    if (!Number.isFinite(quoteLeg.usd) || quoteLeg.usd <= 0) continue
    const tokenAmount = hexToRaw(tokenLeg.amountHex)
    if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) continue
    const quoteIncoming = quoteLeg.to === wallet
    if (quoteIncoming === tokenLeg.incoming) continue

    // Wallet receives the non-quote token ⇒ buy; sends it ⇒ sell.
    const side: 'buy' | 'sell' = tokenLeg.incoming ? 'buy' : 'sell'
    const ts = blockTs[g.block] ?? isoFromBlock(g.block)
    swaps.push({ token: tokenLeg.token, ts, side, tokenAmount, usdValue: quoteLeg.usd })
  }
  return swaps
}

/**
 * A provider-decoded transfer (e.g. Alchemy alchemy_getAssetTransfers): amount
 * is ALREADY in human units (decimals applied), so no hex/decimals handling —
 * the cleaner, primary input. token = contract (lowercase).
 */
export interface NormalizedTransfer {
  token: string
  from: string
  to: string
  amount: number
  tx: string
  ts: string
}

/**
 * Decode normalized transfers into swaps (shares the quote/token pairing logic
 * with decodeBscSwaps but skips hex/decimals). usdValue = quote amount ×
 * usdPerUnit; token amount is the human value (consistent per token → avg-cost
 * accounting holds). Txs without a clean single-quote pairing are skipped.
 */
export function decodeTransfersToSwaps(
  transfers: NormalizedTransfer[],
  walletAddress: string,
  cfg: BscQuoteConfig
): OnchainSwap[] {
  const wallet = walletAddress.toLowerCase()
  const byTx = new Map<string, NormalizedTransfer[]>()
  for (const tr of transfers) {
    if (!tr || typeof tr.token !== 'string') continue
    const from = tr.from?.toLowerCase()
    const to = tr.to?.toLowerCase()
    if (from !== wallet && to !== wallet) continue
    if (!Number.isFinite(tr.amount) || tr.amount <= 0) continue
    const arr = byTx.get(tr.tx) ?? []
    arr.push({ ...tr, token: tr.token.toLowerCase(), from, to })
    byTx.set(tr.tx, arr)
  }

  const swaps: OnchainSwap[] = []
  for (const [, legs] of byTx) {
    let quote: { usd: number; incoming: boolean } | null = null
    let tokenLeg: { token: string; amount: number; incoming: boolean; ts: string } | null = null
    let quoteCount = 0
    let tokenCount = 0
    for (const leg of legs) {
      const incoming = leg.to === wallet
      const q = cfg.quotes[leg.token]
      if (q) {
        quoteCount += 1
        const usd = leg.amount * q.usdPerUnit
        if (!quote || usd > quote.usd) quote = { usd, incoming }
      } else {
        tokenCount += 1
        if (!tokenLeg || leg.amount > tokenLeg.amount)
          tokenLeg = { token: leg.token, amount: leg.amount, incoming, ts: leg.ts }
      }
    }
    if (!quote || !tokenLeg || quoteCount === 0 || tokenCount === 0) continue
    if (!Number.isFinite(quote.usd) || quote.usd <= 0) continue
    if (quote.incoming === tokenLeg.incoming) continue
    swaps.push({
      token: tokenLeg.token,
      ts: tokenLeg.ts,
      side: tokenLeg.incoming ? 'buy' : 'sell',
      tokenAmount: tokenLeg.amount,
      usdValue: quote.usd,
    })
  }
  return swaps
}

/** Deterministic ordering fallback when a block timestamp isn't supplied:
 *  a lexically-sortable pseudo-ISO derived from the numeric block height. */
function isoFromBlock(blockHex: string): string {
  const n = (() => {
    try {
      return Number(BigInt(blockHex))
    } catch {
      return 0
    }
  })()
  return `block-${String(n).padStart(12, '0')}`
}
