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

import { computeBscWalletOnchain, type BscWalletResult } from './bsc-fetch'
import { computeSolanaWalletOnchain, type SolWalletResult } from './solana-fetch'
import { scanMoralisInternalBnb } from './moralis-bsc-internal'
import {
  fetchTokenInfo,
  tokenAddressKey,
  unrealizedFromHoldings,
  type TokenInfo,
} from './token-prices'
import type { PerTokenPnl } from './pnl-accounting'
import type { NormalizedTransfer } from './bsc-swaps'
import {
  ONCHAIN_METHODOLOGY,
  ONCHAIN_METHODOLOGY_VERSION,
  isOnchainQualityCanonical,
  type OnchainQuality,
  type OnchainQualityReason,
} from '@/lib/onchain-quality'

export type OnchainChain = 'bsc' | 'solana'

/** Map a source slug to its chain, or null if not an on-chain wallet source. */
export function chainForSource(slug: string): OnchainChain | null {
  if (slug.includes('solana')) return 'solana'
  if (slug.includes('bsc') || slug.includes('web3_bsc')) return 'bsc'
  return null
}

export type OnchainBudgetProfile = 'interactive' | 'scheduled' | 'backfill'
export interface OnchainFetchBudget {
  maxSigs?: number
  maxPages?: number
}

const ONCHAIN_FETCH_BUDGETS: Record<
  OnchainBudgetProfile,
  Record<OnchainChain, OnchainFetchBudget>
> = {
  // Vercel's 60-second user-facing path: at most 2,000 BSC records total
  // (one 1,000-record page for each direction).
  interactive: { solana: { maxSigs: 150 }, bsc: { maxPages: 1 } },
  // Recurring worker is long-lived but still bounded per wallet and per run.
  scheduled: { solana: { maxSigs: 400 }, bsc: { maxPages: 4 } },
  // Operator backfill trades more BSC depth for a smaller Solana tx budget.
  backfill: { solana: { maxSigs: 250 }, bsc: { maxPages: 6 } },
}

/** Chain-specific budgets prevent maxSigs from silently doing nothing on BSC. */
export function onchainFetchBudget(
  chain: OnchainChain,
  profile: OnchainBudgetProfile
): OnchainFetchBudget {
  return { ...ONCHAIN_FETCH_BUDGETS[profile][chain] }
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
  /** Estimated top tokens by reconstructed realized PnL (never a return percentage). */
  topEarningTokens: Array<Record<string, unknown>>
  provenance: 'onchain-computed'
  quality: OnchainQuality
  /** True when realized may understate (BSC native-BNB sells not yet captured). */
  realizedPartial: boolean
  /** Per-day realized PnL deltas (active days only) — raw material for
   *  enrichmentSeries(). */
  dailyRealized: Array<{ ts: string; value: number }>
}

/** Fold runtime Solana cursor + hydration evidence into quality schema v1. */
export function solanaHistoryEvidence(
  r: Pick<
    SolWalletResult,
    'signatureCoverage' | 'txsUnresolved' | 'txsMissingTimestamp' | 'txsFetched' | 'swaps'
  >
): Pick<
  OnchainQuality['history'],
  'scanComplete' | 'truncated' | 'recordsFetched' | 'txsFetched' | 'swapsDecoded'
> {
  return {
    scanComplete:
      r.signatureCoverage.scanComplete &&
      !r.signatureCoverage.truncated &&
      r.txsUnresolved === 0 &&
      r.txsMissingTimestamp === 0,
    truncated: r.signatureCoverage.truncated,
    recordsFetched: r.signatureCoverage.recordsReturned,
    txsFetched: r.txsFetched,
    swapsDecoded: r.swaps,
  }
}

/**
 * BSC base transfer cursors are only one part of realized-history coverage.
 * Native/internal receipts must also have an explicit complete-zero/success
 * contract before the combined history can be called complete.
 */
export function bscHistoryEvidence(
  r: Pick<BscWalletResult, 'transferCoverage' | 'transfers' | 'swaps'>,
  internalCoverageComplete: boolean
): Pick<
  OnchainQuality['history'],
  'scanComplete' | 'truncated' | 'recordsFetched' | 'txsFetched' | 'swapsDecoded'
> {
  return {
    scanComplete:
      r.transferCoverage.scanComplete && !r.transferCoverage.truncated && internalCoverageComplete,
    truncated: r.transferCoverage.truncated,
    recordsFetched: r.transfers,
    txsFetched: null,
    swapsDecoded: r.swaps,
  }
}

/** Price held tokens + surface symbols for the OnchainInsights token blocks. */
async function priceAndMeta(perToken: PerTokenPnl[], chain: OnchainChain) {
  // Fetch info for BOTH held tokens (unrealized) and top realized tokens (for
  // the top-earning-tokens card) so both blocks get symbols/prices.
  const addrs = new Set<string>()
  for (const t of perToken) {
    if (t.holding > 0 && t.costBasisUsd > 0) addrs.add(t.token)
  }
  for (const t of [...perToken].sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd).slice(0, 10)) {
    addrs.add(t.token)
  }
  const info =
    addrs.size > 0 ? await fetchTokenInfo([...addrs], { chain }) : new Map<string, TokenInfo>()
  const prices = new Map<string, number>()
  for (const [k, v] of info) prices.set(k, v.priceUsd)
  return { u: unrealizedFromHoldings(perToken, prices, chain), info }
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

/** Top earning tokens (realized) with symbols/logos for the insights card.
 *
 * costBasisUsd is the cost of the remaining holding, not the total invested
 * capital behind realized PnL. It therefore cannot be used as a return-rate
 * denominator (and is zero after a full close), so this reconstruction emits
 * dollars only.
 */
function topEarningTokens(
  perToken: PerTokenPnl[],
  info: Map<string, TokenInfo>,
  chain: OnchainChain
): Array<Record<string, unknown>> {
  return [...perToken]
    .filter((t) => t.realizedPnlUsd !== 0)
    .sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd)
    .slice(0, 10)
    .map((t) => {
      const meta = info.get(tokenAddressKey(t.token, chain))
      return {
        symbol: meta?.symbol ?? t.token.slice(0, 6), // fallback to short addr
        address: t.token,
        logo: meta?.logo ?? null,
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
    /** Dune/Moralis native-BNB SELL receipts; coverage proof is separate. */
    bscInternalBnb?: NormalizedTransfer[]
    /** True only when the internal-transfer provider proves a complete query,
     * including a successful zero-row result and no cursor/page truncation. */
    bscInternalCoverageComplete?: boolean
  } = {}
): Promise<OnchainEnrichment> {
  const lookbackDays = opts.lookbackDays ?? 90

  if (chain === 'solana') {
    const r = await computeSolanaWalletOnchain(wallet, { lookbackDays, maxSigs: opts.maxSigs })
    const { u, info } = await priceAndMeta(r.pnl.perToken, 'solana')
    return normalize(
      'solana',
      wallet,
      lookbackDays,
      r.pnl,
      u,
      info,
      false,
      solanaHistoryEvidence(r)
    )
  }
  // Native-BNB SELL receipts (item C): caller-supplied Dune batch wins;
  // otherwise scan the wallet through Moralis. Only an explicitly exhausted
  // provider cursor can complete internal-transfer coverage; a non-empty array
  // proves records exist, not that the requested history is complete.
  let internalLegs = opts.bscInternalBnb
  let internalCoverageComplete =
    opts.bscInternalCoverageComplete === true && internalLegs !== undefined
  if (internalLegs === undefined && process.env.MORALIS_API_KEY) {
    const scan = await scanMoralisInternalBnb(wallet, {
      lookbackDays,
      maxPages: opts.maxPages,
    })
    internalLegs = scan.transfers
    internalCoverageComplete = scan.coverage.scanComplete
  }
  const r = await computeBscWalletOnchain(wallet, {
    lookbackDays,
    maxPages: opts.maxPages,
    extraTransfers: internalLegs,
  })
  const { u, info } = await priceAndMeta(r.pnl.perToken, 'bsc')
  const partial = !internalCoverageComplete
  return normalize(
    'bsc',
    wallet,
    lookbackDays,
    r.pnl,
    u,
    info,
    partial,
    bscHistoryEvidence(r, internalCoverageComplete)
  )
}

function normalize(
  chain: OnchainChain,
  wallet: string,
  lookbackDays: number,
  pnl: import('./pnl-accounting').WalletPnl,
  u: { unrealizedUsd: number; pricedTokens: number; unpricedTokens: number },
  info: Map<string, TokenInfo>,
  realizedPartial: boolean,
  historyCounts: Pick<OnchainQuality['history'], 'recordsFetched' | 'txsFetched' | 'swapsDecoded'> &
    Partial<Pick<OnchainQuality['history'], 'scanComplete' | 'truncated'>>
): OnchainEnrichment {
  const reasons: OnchainQualityReason[] = ['opening_inventory_unknown']
  if (historyCounts.scanComplete !== true || historyCounts.truncated !== false) {
    reasons.push('history_scan_not_proven_complete')
  }
  reasons.push('historical_native_quote_not_execution_priced', 'generic_balance_delta_decoder')
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
    topEarningTokens: topEarningTokens(pnl.perToken, info, chain),
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
        ...historyCounts,
        scanComplete: historyCounts.scanComplete ?? null,
        truncated: historyCounts.truncated ?? null,
      },
      pricing: { pricedTokens: u.pricedTokens, unpricedTokens: u.unpricedTokens },
    },
    realizedPartial,
    dailyRealized: pnl.dailyRealized,
  }
}

/** Shared publication boundary for any typed or generic serving field. */
export function isCanonicalOnchainEnrichment(e: OnchainEnrichment): boolean {
  return !e.realizedPartial && isOnchainQualityCanonical(e.quality)
}

/** Only canonical, complete on-chain metrics may populate typed score inputs. */
export function scoreEligibleWinRate(e: OnchainEnrichment): number | null {
  return isCanonicalOnchainEnrichment(e) ? e.winRate : null
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
  if (e.chain !== 'bsc' || e.dailyRealized.length === 0 || !isCanonicalOnchainEnrichment(e)) {
    return []
  }
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

/** The trader_stats.extras patch — onchain_* scalars + estimated insight blocks. */
export function enrichmentExtras(e: OnchainEnrichment): Record<string, unknown> {
  // Re-shape at the publication boundary so an accidentally supplied
  // profit_pct can never escape into serving. Reconstructed realized PnL has
  // no trustworthy invested-capital denominator in quality schema v1.
  const onchainTopTokens = e.topEarningTokens
    .filter(
      (token) =>
        typeof token.symbol === 'string' &&
        token.symbol.length > 0 &&
        typeof token.realized_pnl === 'number' &&
        Number.isFinite(token.realized_pnl)
    )
    .map((token) => ({
      symbol: token.symbol,
      address: typeof token.address === 'string' ? token.address : '',
      logo: typeof token.logo === 'string' ? token.logo : null,
      realized_pnl: token.realized_pnl,
    }))
  const hasTokens = onchainTopTokens.length > 0
  const hasDistribution = Object.values(e.tokenDistribution).some((count) => count > 0)
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
    // Dollar-PnL buckets must never share the exchange-owned percentage key.
    // Always emit null when empty so shallow JSONB merge clears stale estimates.
    onchain_token_distribution_usd: hasDistribution ? e.tokenDistribution : null,
    onchain_token_distribution_unit: hasDistribution ? 'realized_pnl_usd' : null,
    // Never overwrite the exchange-owned top_earning_tokens list. The two
    // sources use different methodologies and only native data has profit %.
    onchain_top_earning_tokens: hasTokens ? onchainTopTokens : null,
    onchain_top_earning_tokens_provenance: hasTokens ? e.provenance : null,
  }
}
