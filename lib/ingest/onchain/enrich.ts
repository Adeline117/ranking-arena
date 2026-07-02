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
import { fetchTokenPricesUsd, unrealizedFromHoldings } from './token-prices'
import type { PerTokenPnl } from './pnl-accounting'

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
  /** Top tokens by realized PnL (for a "top tokens" UI card). */
  topTokens: Array<{ token: string; realizedPnlUsd: number; holding: number }>
  provenance: 'onchain-computed'
  /** True when realized may understate (BSC native-BNB sells not yet captured). */
  realizedPartial: boolean
}

async function priceUnrealized(perToken: PerTokenPnl[]) {
  const held = perToken.filter((t) => t.holding > 0 && t.costBasisUsd > 0)
  if (held.length === 0)
    return { unrealizedUsd: 0, pricedTokens: 0, unpricedTokens: 0, heldValueUsd: 0 }
  const prices = await fetchTokenPricesUsd(held.map((t) => t.token))
  return unrealizedFromHoldings(perToken, prices)
}

/** Run the full on-chain recompute + pricing for one wallet. */
export async function enrichWeb3Wallet(
  chain: OnchainChain,
  wallet: string,
  opts: { lookbackDays?: number; maxSigs?: number; maxPages?: number } = {}
): Promise<OnchainEnrichment> {
  const lookbackDays = opts.lookbackDays ?? 90

  if (chain === 'solana') {
    const r = await computeSolanaWalletOnchain(wallet, { lookbackDays, maxSigs: opts.maxSigs })
    const u = await priceUnrealized(r.pnl.perToken)
    return normalize('solana', wallet, lookbackDays, r.pnl, u, false)
  }
  const r = await computeBscWalletOnchain(wallet, { lookbackDays, maxPages: opts.maxPages })
  const u = await priceUnrealized(r.pnl.perToken)
  // BSC native-BNB sell legs aren't captured via Alchemy (no internal txs), so
  // realized understates for native-BNB sellers → flag partial.
  return normalize('bsc', wallet, lookbackDays, r.pnl, u, true)
}

function normalize(
  chain: OnchainChain,
  wallet: string,
  lookbackDays: number,
  pnl: import('./pnl-accounting').WalletPnl,
  u: { unrealizedUsd: number; pricedTokens: number; unpricedTokens: number },
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
    topTokens: pnl.perToken
      .slice(0, 10)
      .map((t) => ({ token: t.token, realizedPnlUsd: t.realizedPnlUsd, holding: t.holding })),
    provenance: 'onchain-computed',
    realizedPartial: realizedPartial && pnl.txsSell === 0,
  }
}

/** The trader_stats.extras patch — only onchain_* keys + provenance. */
export function enrichmentExtras(e: OnchainEnrichment): Record<string, unknown> {
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
    ...(e.realizedPartial ? { onchain_realized_partial: true } : {}),
  }
}
