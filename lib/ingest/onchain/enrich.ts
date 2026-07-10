/**
 * Web3 wallet on-chain enrichment orchestrator (Phase A — item A, integration).
 *
 * Ties the chain fetchers + pricing into ONE normalized result that a pipeline
 * step writes to arena.trader_stats.extras (never clobbering board values —
 * ADDS onchain_* fields + fills win_rate when the board left it null). This is
 * the durable replacement for the WAF-blocked profile detail: computed 100%
 * from chain data, tagged provenance='onchain-computed'.
 *
 * Chain dispatch by source slug:
 *   *_solana → Solana balance-delta path (sells fully captured)
 *   *_bsc / *_web3_bsc → BSC getAssetTransfers path (native-BNB sells need
 *     BscScan internal txs — see memory; realized may understate until added)
 */

import { computeBscWalletOnchain } from './bsc-fetch'
import { computeSolanaWalletOnchain } from './solana-fetch'
import { fetchTokenInfo, unrealizedFromHoldings, type TokenInfo } from './token-prices'
import type { PerTokenPnl } from './pnl-accounting'
import type { NormalizedTransfer } from './bsc-swaps'

export type OnchainChain = 'bsc' | 'solana'

/** Map a source slug to its chain, or null if not an on-chain wallet source. */
export function chainForSource(slug: string): OnchainChain | null {
  if (slug.includes('solana')) return 'solana'
  if (slug.includes('bsc') || slug.includes('web3_bsc')) return 'bsc'
  return null
}

export interface OnchainEnrichment {
  chain: OnchainChain
  wallet: string
  lookbackDays: number
  realizedPnlUsd: number
  unrealizedPnlUsd: number
  totalPnlUsd: number
  winRate: number | null
  txsBuy: number
  txsSell: number
  buyVolumeUsd: number
  sellVolumeUsd: number
  tokensTraded: number
  closedPositions: number
  pricedTokens: number
  unpricedTokens: number
  /** OnchainInsights token_distribution buckets (by realized PnL). */
  tokenDistribution: Record<string, number>
  /** OnchainInsights top_earning_tokens ({symbol,address,logo,profit_pct,realized_pnl}). */
  topEarningTokens: Array<Record<string, unknown>>
  provenance: 'onchain-computed'
  /** True when realized may understate (BSC native-BNB sells not yet captured). */
  realizedPartial: boolean
}

/** Price held tokens + surface symbols for the OnchainInsights token blocks. */
async function priceAndMeta(perToken: PerTokenPnl[]) {
  // Fetch info for BOTH held tokens (unrealized) and top realized tokens (for
  // the top-earning-tokens card) so both blocks get symbols/prices.
  const addrs = new Set<string>()
  for (const t of perToken) {
    if (t.holding > 0 && t.costBasisUsd > 0) addrs.add(t.token)
  }
  for (const t of [...perToken].sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd).slice(0, 10)) {
    addrs.add(t.token)
  }
  const info = addrs.size > 0 ? await fetchTokenInfo([...addrs]) : new Map<string, TokenInfo>()
  const prices = new Map<string, number>()
  for (const [k, v] of info) prices.set(k, v.priceUsd)
  return { u: unrealizedFromHoldings(perToken, prices), info }
}

/** Bucket per-token realized PnL into the OnchainInsights token_distribution. */
function tokenDistribution(perToken: PerTokenPnl[]): Record<string, number> {
  const d = { gt_500: 0, p0_500: 0, n50_0: 0, lt_n50: 0 }
  for (const t of perToken) {
    const r = t.realizedPnlUsd
    if (r > 500) d.gt_500 += 1
    else if (r > 0) d.p0_500 += 1
    else if (r >= -50) d.n50_0 += 1
    else d.lt_n50 += 1
  }
  return d
}

/** Top earning tokens (realized) with symbols/logos for the insights card. */
function topEarningTokens(
  perToken: PerTokenPnl[],
  info: Map<string, TokenInfo>
): Array<Record<string, unknown>> {
  return [...perToken]
    .filter((t) => t.realizedPnlUsd !== 0)
    .sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd)
    .slice(0, 10)
    .map((t) => {
      const meta = info.get(t.token.toLowerCase())
      return {
        symbol: meta?.symbol ?? t.token.slice(0, 6), // fallback to short addr
        address: t.token,
        logo: meta?.logo ?? null,
        profit_pct:
          t.costBasisUsd > 0 ? Math.round((t.realizedPnlUsd / t.costBasisUsd) * 10000) / 100 : null,
        realized_pnl: t.realizedPnlUsd,
      }
    })
}

/** Run the full on-chain recompute + pricing for one wallet. */
export async function enrichWeb3Wallet(
  chain: OnchainChain,
  wallet: string,
  opts: {
    lookbackDays?: number
    maxSigs?: number
    maxPages?: number
    /** Dune-sourced native-BNB SELL receipts (item C) — completes BSC sells. */
    bscInternalBnb?: NormalizedTransfer[]
  } = {}
): Promise<OnchainEnrichment> {
  const lookbackDays = opts.lookbackDays ?? 90

  if (chain === 'solana') {
    const r = await computeSolanaWalletOnchain(wallet, { lookbackDays, maxSigs: opts.maxSigs })
    const { u, info } = await priceAndMeta(r.pnl.perToken)
    return normalize('solana', wallet, lookbackDays, r.pnl, u, info, false)
  }
  const r = await computeBscWalletOnchain(wallet, {
    lookbackDays,
    maxPages: opts.maxPages,
    extraTransfers: opts.bscInternalBnb,
  })
  const { u, info } = await priceAndMeta(r.pnl.perToken)
  // With Dune internal-BNB legs injected, native-BNB sells ARE captured →
  // realized complete. Only flag partial when we had NO Dune data to inject.
  const partial = !opts.bscInternalBnb
  return normalize('bsc', wallet, lookbackDays, r.pnl, u, info, partial)
}

function normalize(
  chain: OnchainChain,
  wallet: string,
  lookbackDays: number,
  pnl: import('./pnl-accounting').WalletPnl,
  u: { unrealizedUsd: number; pricedTokens: number; unpricedTokens: number },
  info: Map<string, TokenInfo>,
  realizedPartial: boolean
): OnchainEnrichment {
  return {
    chain,
    wallet,
    lookbackDays,
    realizedPnlUsd: pnl.realizedPnlUsd,
    unrealizedPnlUsd: u.unrealizedUsd,
    totalPnlUsd: Math.round((pnl.realizedPnlUsd + u.unrealizedUsd) * 100) / 100,
    winRate: pnl.winRate,
    txsBuy: pnl.txsBuy,
    txsSell: pnl.txsSell,
    buyVolumeUsd: pnl.buyVolumeUsd,
    sellVolumeUsd: pnl.sellVolumeUsd,
    tokensTraded: pnl.tokensTraded,
    closedPositions: pnl.closedPositions,
    pricedTokens: u.pricedTokens,
    unpricedTokens: u.unpricedTokens,
    tokenDistribution: tokenDistribution(pnl.perToken),
    topEarningTokens: topEarningTokens(pnl.perToken, info),
    provenance: 'onchain-computed',
    realizedPartial: realizedPartial && pnl.txsSell === 0,
  }
}

/** The trader_stats.extras patch — onchain_* scalars + the OnchainInsights
 *  token blocks (token_distribution / top_earning_tokens) our compute fills. */
export function enrichmentExtras(e: OnchainEnrichment): Record<string, unknown> {
  const hasTokens = e.topEarningTokens.length > 0
  return {
    onchain_realized_pnl: e.realizedPnlUsd,
    onchain_unrealized_pnl: e.unrealizedPnlUsd,
    onchain_total_pnl: e.totalPnlUsd,
    onchain_win_rate: e.winRate,
    onchain_txs_buy: e.txsBuy,
    onchain_txs_sell: e.txsSell,
    onchain_buy_volume: e.buyVolumeUsd,
    onchain_sell_volume: e.sellVolumeUsd,
    onchain_tokens_traded: e.tokensTraded,
    onchain_derivation: e.provenance,
    // Freshness stamp — the runner's sweep selection skips wallets enriched
    // within its window and refreshes stalest-first (Phase B recurring, 2026-07-09).
    onchain_enriched_at: new Date().toISOString(),
    // OnchainInsights blocks — only when we actually have tokens (NULL-collapse).
    ...(hasTokens ? { token_distribution: e.tokenDistribution } : {}),
    ...(hasTokens ? { top_earning_tokens: e.topEarningTokens } : {}),
    ...(e.realizedPartial ? { onchain_realized_partial: true } : {}),
  }
}
