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
  baseToken?: { address?: string; symbol?: string }
  info?: { imageUrl?: string }
  priceUsd?: string
  liquidity?: { usd?: number }
}

export interface TokenInfo {
  priceUsd: number
  symbol: string | null
  logo: string | null
}

/**
 * Reduce Dexscreener pairs to the best (highest-liquidity) info per token
 * address (lowercased): price + symbol + logo. Pure; unpriced tokens omitted.
 */
export function bestInfoFromPairs(pairs: DexPair[]): Map<string, TokenInfo> {
  const best = new Map<string, { info: TokenInfo; liq: number }>()
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const addr = p.baseToken?.address?.toLowerCase()
    const price = Number(p.priceUsd)
    if (!addr || !Number.isFinite(price) || price <= 0) continue
    const liq = Number(p.liquidity?.usd) || 0
    const cur = best.get(addr)
    if (!cur || liq > cur.liq) {
      best.set(addr, {
        liq,
        info: {
          priceUsd: price,
          symbol: typeof p.baseToken?.symbol === 'string' ? p.baseToken.symbol : null,
          logo: typeof p.info?.imageUrl === 'string' ? p.info.imageUrl : null,
        },
      })
    }
  }
  const out = new Map<string, TokenInfo>()
  for (const [addr, v] of best) out.set(addr, v.info)
  return out
}

/** Price-only view (back-compat). */
export function bestPricesFromPairs(pairs: DexPair[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const [addr, info] of bestInfoFromPairs(pairs)) out.set(addr, info.priceUsd)
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

/** Fetch token info (price + symbol + logo) via Dexscreener (batched by 30). */
export async function fetchTokenInfo(
  addresses: string[],
  opts: { timeoutMs?: number } = {}
): Promise<Map<string, TokenInfo>> {
  const merged = new Map<string, TokenInfo>()
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
      for (const [k, v] of bestInfoFromPairs(json.pairs ?? [])) merged.set(k, v)
    } catch {
      /* skip this batch — unpriced tokens just drop out of unrealized */
    } finally {
      clearTimeout(timer)
    }
  }
  return merged
}

/** Price-only convenience (back-compat). */
export async function fetchTokenPricesUsd(
  addresses: string[],
  opts: { timeoutMs?: number } = {}
): Promise<Map<string, number>> {
  const info = await fetchTokenInfo(addresses, opts)
  const out = new Map<string, number>()
  for (const [k, v] of info) out.set(k, v.priceUsd)
  return out
}
