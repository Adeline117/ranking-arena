/**
 * Token USD pricing for on-chain unrealized PnL (Phase A accuracy — item B).
 *
 * Realized PnL comes from the swap quote legs (SOL/BNB/stables). UNREALIZED
 * PnL needs a CURRENT price for each still-held token: unrealized =
 * Σ(holding × priceUsd − remaining costBasis). Prices come from Dexscreener
 * (keyless, covers BSC + Solana, batch up to 30 addresses) — $0, no key.
 *
 * Split into a pure parser (testable) + a thin fetcher.
 */

import type { PerTokenPnl } from './pnl-accounting'

export interface DexPair {
  baseToken?: { address?: string }
  priceUsd?: string
  liquidity?: { usd?: number }
}

/**
 * Reduce Dexscreener pairs to one best (highest-liquidity) USD price per token
 * address (lowercased). Pure. Tokens with no priced pair are omitted.
 */
export function bestPricesFromPairs(pairs: DexPair[]): Map<string, number> {
  const best = new Map<string, { price: number; liq: number }>()
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const addr = p.baseToken?.address?.toLowerCase()
    const price = Number(p.priceUsd)
    if (!addr || !Number.isFinite(price) || price <= 0) continue
    const liq = Number(p.liquidity?.usd) || 0
    const cur = best.get(addr)
    if (!cur || liq > cur.liq) best.set(addr, { price, liq })
  }
  const out = new Map<string, number>()
  for (const [addr, v] of best) out.set(addr, v.price)
  return out
}

/**
 * Unrealized PnL over held tokens given a price map (addr lowercased → USD).
 * Tokens without a price are counted as `unpriced` (their bag is excluded from
 * unrealized — honest: we don't guess a price).
 */
export function unrealizedFromHoldings(
  perToken: PerTokenPnl[],
  prices: Map<string, number>
): { unrealizedUsd: number; pricedTokens: number; unpricedTokens: number; heldValueUsd: number } {
  let unrealizedUsd = 0
  let heldValueUsd = 0
  let priced = 0
  let unpriced = 0
  for (const t of perToken) {
    if (t.holding <= 0 || t.costBasisUsd <= 0) continue
    const px = prices.get(t.token.toLowerCase())
    if (px === undefined) {
      unpriced += 1
      continue
    }
    const value = t.holding * px
    heldValueUsd += value
    unrealizedUsd += value - t.costBasisUsd
    priced += 1
  }
  return {
    unrealizedUsd: Math.round(unrealizedUsd * 100) / 100,
    pricedTokens: priced,
    unpricedTokens: unpriced,
    heldValueUsd: Math.round(heldValueUsd * 100) / 100,
  }
}

/** Fetch USD prices for token addresses via Dexscreener (batched by 30). */
export async function fetchTokenPricesUsd(
  addresses: string[],
  opts: { timeoutMs?: number } = {}
): Promise<Map<string, number>> {
  const merged = new Map<string, number>()
  const uniq = [...new Set(addresses.map((a) => a.toLowerCase()))]
  for (let i = 0; i < uniq.length; i += 30) {
    const batch = uniq.slice(i, i + 30)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 12_000)
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${batch.join(',')}`, {
        headers: { accept: 'application/json' },
        signal: ctrl.signal,
      })
      const json = (await res.json()) as { pairs?: DexPair[] }
      const prices = bestPricesFromPairs(json.pairs ?? [])
      for (const [k, v] of prices) merged.set(k, v)
    } catch {
      /* skip this batch — unpriced tokens just drop out of unrealized */
    } finally {
      clearTimeout(timer)
    }
  }
  return merged
}
