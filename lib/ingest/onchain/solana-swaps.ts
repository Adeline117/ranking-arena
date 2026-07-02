/**
 * Solana swap decoder (Phase A — pure, testable half of the Solana fetcher).
 *
 * Solana swaps route through many programs (Jupiter/Raydium/Orca/pump.fun), so
 * instruction-level decoding is brittle. Instead we read the tx's BALANCE
 * DELTAS — every getTransaction returns pre/postTokenBalances (per owner+mint)
 * and pre/postBalances (native SOL lamports per account). The wallet's net
 * change per mint + its SOL change fully describe the swap, program-agnostic:
 *   SOL down + token up  → buy  (quote = SOL spent)
 *   token down + SOL up  → sell (quote = SOL received)
 * Stablecoin (USDC/USDT) legs are handled the same way as an alternative quote.
 *
 * Pure & dependency-free: the fetcher supplies parsed tx metas + SOL price.
 */

import type { OnchainSwap } from './pnl-accounting'

/** Wrapped SOL mint — treated as native SOL, not a token leg. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112'
/** Stablecoin mints on Solana (quote legs, $1). */
export const SOL_STABLES: Record<string, number> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 1, // USDC
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 1, // USDT
}
const LAMPORTS_PER_SOL = 1e9

export interface SolTokenBalance {
  mint: string
  owner?: string
  uiTokenAmount: { uiAmount: number | null }
}

export interface SolTxMeta {
  signature: string
  blockTime: number | null // unix seconds
  fee: number // lamports
  /** index of the wallet in the account list, or -1. index 0 = fee payer. */
  walletIndex: number
  preSol: number // lamports at walletIndex
  postSol: number // lamports at walletIndex
  preTokenBalances: SolTokenBalance[]
  postTokenBalances: SolTokenBalance[]
}

const EPS = 1e-9

/** Net per-mint uiAmount change for the wallet (post − pre; missing side = 0). */
function walletMintDeltas(meta: SolTxMeta, wallet: string): Map<string, number> {
  const pre = new Map<string, number>()
  const post = new Map<string, number>()
  for (const b of meta.preTokenBalances) {
    if (b.owner === wallet)
      pre.set(b.mint, (pre.get(b.mint) ?? 0) + (b.uiTokenAmount.uiAmount ?? 0))
  }
  for (const b of meta.postTokenBalances) {
    if (b.owner === wallet)
      post.set(b.mint, (post.get(b.mint) ?? 0) + (b.uiTokenAmount.uiAmount ?? 0))
  }
  const mints = new Set([...pre.keys(), ...post.keys()])
  const deltas = new Map<string, number>()
  for (const m of mints) deltas.set(m, (post.get(m) ?? 0) - (pre.get(m) ?? 0))
  return deltas
}

/**
 * Decode one Solana tx into a swap for `wallet`, or null if it isn't a
 * recognisable single-token↔quote swap. `solUsd` prices the native/WSOL leg.
 */
export function decodeSolanaSwap(
  meta: SolTxMeta,
  wallet: string,
  solUsd: number
): OnchainSwap | null {
  if (meta.walletIndex < 0) return null

  // Native SOL delta (add the fee back when the wallet is the fee payer so the
  // swap's SOL leg isn't polluted by gas).
  let solDelta = (meta.postSol - meta.preSol) / LAMPORTS_PER_SOL
  if (meta.walletIndex === 0) solDelta += meta.fee / LAMPORTS_PER_SOL

  const deltas = walletMintDeltas(meta, wallet)
  // Fold wrapped SOL into the native SOL delta.
  const wsol = deltas.get(WSOL_MINT)
  if (wsol !== undefined) {
    solDelta += wsol
    deltas.delete(WSOL_MINT)
  }

  // Quote candidates: SOL (native) and any stablecoin the wallet moved.
  let quoteUsd = 0 // signed: negative = wallet paid, positive = wallet received
  // SOL leg
  if (Math.abs(solDelta) > 1e-7) quoteUsd = solDelta * solUsd
  // Stablecoin leg (prefer the larger-magnitude quote)
  for (const [mint, one] of Object.entries(SOL_STABLES)) {
    const d = deltas.get(mint)
    if (d !== undefined && Math.abs(d * one) > Math.abs(quoteUsd)) {
      quoteUsd = d * one
      deltas.delete(mint)
    } else if (d !== undefined) {
      deltas.delete(mint) // consumed as (smaller) quote, don't treat as token
    }
  }
  if (Math.abs(quoteUsd) < EPS) return null // no quote leg → can't value

  // Token leg = the largest-magnitude remaining non-quote mint delta.
  let tokenMint: string | null = null
  let tokenDelta = 0
  for (const [mint, d] of deltas) {
    if (Math.abs(d) > Math.abs(tokenDelta)) {
      tokenMint = mint
      tokenDelta = d
    }
  }
  if (!tokenMint || Math.abs(tokenDelta) < EPS) return null

  // token up + quote down = buy; token down + quote up = sell. Require opposite signs.
  const side: 'buy' | 'sell' = tokenDelta > 0 ? 'buy' : 'sell'
  if (side === 'buy' && quoteUsd >= 0) return null // buying should COST quote
  if (side === 'sell' && quoteUsd <= 0) return null // selling should RECEIVE quote

  const ts = meta.blockTime
    ? new Date(meta.blockTime * 1000).toISOString()
    : `slot-${String(0).padStart(12, '0')}`
  return {
    token: tokenMint,
    ts,
    side,
    tokenAmount: Math.abs(tokenDelta),
    usdValue: Math.abs(quoteUsd),
  }
}

/** Decode a batch of tx metas into swaps (skips non-swaps). */
export function decodeSolanaSwaps(
  metas: SolTxMeta[],
  wallet: string,
  solUsd: number
): OnchainSwap[] {
  const out: OnchainSwap[] = []
  for (const m of metas) {
    const s = decodeSolanaSwap(m, wallet, solUsd)
    if (s) out.push(s)
  }
  return out
}
