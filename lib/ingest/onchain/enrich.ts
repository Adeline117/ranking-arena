/**
 * Web3 wallet on-chain enrichment orchestrator (Phase A — item A, integration).
 *
 * Ties the chain fetchers + pricing into ONE normalized result that a pipeline
 * step writes to arena.trader_stats.extras (never clobbering board values —
 * ADDS onchain_* fields only). This is
 * the durable replacement for the WAF-blocked profile detail: reconstructed
 * from chain activity plus marked pricing, tagged provenance='onchain-computed'.
 *
 * Chain dispatch by source slug:
 *   *_solana → Solana balance-delta path (sells fully captured)
 *   *_bsc / *_web3_bsc → BSC getAssetTransfers path (native-BNB sells need
 *     BscScan internal txs — see memory; realized may understate until added)
 */

import { computeBscWalletOnchain } from './bsc-fetch'
import { computeSolanaWalletOnchain } from './solana-fetch'
import { fetchMoralisInternalBnb } from './moralis-bsc-internal'
import { fetchTokenInfo, unrealizedFromHoldings, type TokenInfo } from './token-prices'
import type { PerTokenPnl } from './pnl-accounting'
import type { NormalizedTransfer } from './bsc-swaps'

export type OnchainChain = 'bsc' | 'solana'

/**
 * Current wallet accounting contract. It is intentionally score-ineligible:
 * the bounded lookback does not replay opening inventory and native quote legs
 * lack execution-time prices. Keep these limitations machine readable until
 * the canonical event/equity ledger replaces this methodology.
 */
export const ONCHAIN_METHODOLOGY = 'wallet-balance-delta-average-cost' as const
export const ONCHAIN_METHODOLOGY_VERSION = '1.0.0' as const

export type OnchainQualityReason =
  | 'opening_inventory_unknown'
  | 'history_scan_not_proven_complete'
  | 'historical_native_quote_not_execution_priced'
  | 'generic_balance_delta_decoder'
  | 'internal_transfer_coverage_unknown'

export interface OnchainQuality {
  schemaVersion: 1
  methodology: typeof ONCHAIN_METHODOLOGY
  methodologyVersion: typeof ONCHAIN_METHODOLOGY_VERSION
  completeness: 'partial' | 'complete'
  priceQuality: 'non_historical_approx' | 'historical_execution'
  scoreEligible: boolean
  reasons: OnchainQualityReason[]
  history: {
    requestedDays: number
    scanComplete: boolean | null
    truncated: boolean | null
    recordsFetched: number
    txsFetched: number | null
    swapsDecoded: number
  }
  pricing: { pricedTokens: number; unpricedTokens: number }
}

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
  quality: OnchainQuality
  /** True when realized may understate (BSC native-BNB sells not yet captured). */
  realizedPartial: boolean
  /** Per-day realized PnL deltas (active days only) — raw material for
   *  enrichmentSeries(). */
  dailyRealized: Array<{ ts: string; value: number }>
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
    return normalize('solana', wallet, lookbackDays, r.pnl, u, info, false, {
      recordsFetched: r.signatures,
      txsFetched: r.txsFetched,
      swapsDecoded: r.swaps,
    })
  }
  // Native-BNB SELL receipts (item C): caller-supplied (Dune batch) wins;
  // otherwise auto-fetch per wallet from Moralis (owner key 2026-07-09,
  // live-verified inbound router→wallet legs). Fail-soft [] → realized-partial.
  let internalLegs = opts.bscInternalBnb
  if (internalLegs === undefined && process.env.MORALIS_API_KEY) {
    const fetched = await fetchMoralisInternalBnb(wallet, { lookbackDays })
    if (fetched.length > 0) internalLegs = fetched
  }
  const r = await computeBscWalletOnchain(wallet, {
    lookbackDays,
    maxPages: opts.maxPages,
    extraTransfers: internalLegs,
  })
  const { u, info } = await priceAndMeta(r.pnl.perToken)
  // Only a caller-supplied coverage result or at least one Moralis leg proves
  // the internal-transfer gap was queried. Fail-soft [] is ambiguous (a valid
  // zero-row result and an upstream failure currently share that shape), so it
  // remains partial until the fetchers expose an explicit coverage contract.
  const partial = !internalLegs
  return normalize('bsc', wallet, lookbackDays, r.pnl, u, info, partial, {
    recordsFetched: r.transfers,
    txsFetched: null,
    swapsDecoded: r.swaps,
  })
}

function normalize(
  chain: OnchainChain,
  wallet: string,
  lookbackDays: number,
  pnl: import('./pnl-accounting').WalletPnl,
  u: { unrealizedUsd: number; pricedTokens: number; unpricedTokens: number },
  info: Map<string, TokenInfo>,
  realizedPartial: boolean,
  historyCounts: Pick<OnchainQuality['history'], 'recordsFetched' | 'txsFetched' | 'swapsDecoded'>
): OnchainEnrichment {
  const reasons: OnchainQualityReason[] = [
    'opening_inventory_unknown',
    'history_scan_not_proven_complete',
    'historical_native_quote_not_execution_priced',
    'generic_balance_delta_decoder',
  ]
  if (realizedPartial) reasons.push('internal_transfer_coverage_unknown')
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
    quality: {
      schemaVersion: 1,
      methodology: ONCHAIN_METHODOLOGY,
      methodologyVersion: ONCHAIN_METHODOLOGY_VERSION,
      completeness: 'partial',
      priceQuality: 'non_historical_approx',
      scoreEligible: false,
      reasons,
      history: {
        requestedDays: lookbackDays,
        scanComplete: null,
        truncated: null,
        ...historyCounts,
      },
      pricing: { pricedTokens: u.pricedTokens, unpricedTokens: u.unpricedTokens },
    },
    realizedPartial,
    dailyRealized: pnl.dailyRealized,
  }
}

/** Only canonical, complete on-chain metrics may populate typed score inputs. */
export function scoreEligibleWinRate(e: OnchainEnrichment): number | null {
  const q = e.quality
  const canonical =
    q.scoreEligible &&
    q.completeness === 'complete' &&
    q.priceQuality === 'historical_execution' &&
    q.history.scanComplete === true &&
    q.history.truncated === false &&
    q.reasons.length === 0
  return canonical ? e.winRate : null
}

/**
 * Chain-derived pnl_daily series blocks — SAME shape/convention as the
 * sibling okx_web3_solana adapter series (metric='pnl_daily', tf 7/30/90,
 * per-day deltas) so every serving reader renders it unchanged.
 *
 * BSC-only by policy: okx_web3_solana gets pnl_daily from the exchange —
 * 死命令「不自派生交易所提供的字段」;binance_web3 profile 是 202 bot-shield
 * 真墙,链上自算是获批路径(Phase B)。Idle days between first activity and
 * today are honest zeros (no realized PnL that day).
 */
export function enrichmentSeries(
  e: OnchainEnrichment,
  nowMs: number
): Array<{ timeframe: number; metric: string; points: Array<{ ts: string; value: number }> }> {
  if (e.chain !== 'bsc' || e.dailyRealized.length === 0) return []
  const byDay = new Map(e.dailyRealized.map((d) => [d.ts, d.value]))
  const first = e.dailyRealized[0].ts
  const today = new Date(nowMs).toISOString().slice(0, 10)
  const full: Array<{ ts: string; value: number }> = []
  for (
    let t = Date.parse(`${first}T00:00:00Z`);
    t <= Date.parse(`${today}T00:00:00Z`);
    t += 86_400_000
  ) {
    const day = new Date(t).toISOString().slice(0, 10)
    full.push({ ts: day, value: byDay.get(day) ?? 0 })
  }
  return [7, 30, 90]
    .map((tf) => ({
      timeframe: tf,
      metric: 'pnl_daily',
      points: full.filter((p) => Date.parse(`${p.ts}T00:00:00Z`) > nowMs - tf * 86_400_000),
    }))
    .filter((b) => b.points.length >= 2)
}

/** The trader_stats.extras patch — onchain_* scalars + the OnchainInsights
 *  token blocks (token_distribution / top_earning_tokens) our compute fills. */
export function enrichmentExtras(e: OnchainEnrichment): Record<string, unknown> {
  const hasTokens = e.topEarningTokens.length > 0
  const quality = {
    schema_version: e.quality.schemaVersion,
    methodology: e.quality.methodology,
    methodology_version: e.quality.methodologyVersion,
    completeness: e.quality.completeness,
    price_quality: e.quality.priceQuality,
    score_eligible: e.quality.scoreEligible,
    reasons: [...e.quality.reasons],
    history: {
      requested_days: e.quality.history.requestedDays,
      scan_complete: e.quality.history.scanComplete,
      truncated: e.quality.history.truncated,
      records_fetched: e.quality.history.recordsFetched,
      txs_fetched: e.quality.history.txsFetched,
      swaps_decoded: e.quality.history.swapsDecoded,
    },
    pricing: {
      priced_tokens: e.quality.pricing.pricedTokens,
      unpriced_tokens: e.quality.pricing.unpricedTokens,
    },
    realized_partial: e.realizedPartial,
  }
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
    onchain_methodology: `${e.quality.methodology}@${e.quality.methodologyVersion}`,
    // Whole-object replacement prevents a prior partial/error state from
    // surviving JSONB's shallow extras merge after a later complete recompute.
    onchain_quality: quality,
    onchain_score_eligible: e.quality.scoreEligible,
    onchain_limitations: [...e.quality.reasons],
    onchain_realized_partial: e.realizedPartial,
    // Freshness stamp — the runner's sweep selection skips wallets enriched
    // within its window and refreshes stalest-first (Phase B recurring, 2026-07-09).
    onchain_enriched_at: new Date().toISOString(),
    // Always emit null when empty so shallow JSONB merge clears stale cards.
    token_distribution: hasTokens ? e.tokenDistribution : null,
    top_earning_tokens: hasTokens ? e.topEarningTokens : null,
  }
}
