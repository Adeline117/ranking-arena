/**
 * Arena Score v2 — feature-extraction groundwork (ARENA_DATA_SPEC v1.2 §12.2).
 *
 * NOT a formula rewrite. This module normalizes the heterogeneous per-source
 * signals already accumulating in arena.trader_stats.extras and
 * arena.traders.meta into one typed FeatureVector, so a future scoring
 * iteration consumes ONE shape instead of 30+ exchange-specific key spellings.
 *
 * Risk-control block (2026-06-30): the FeatureVector now carries sharpe/sortino/
 * mdd/calmar/pnl_ratio — the risk-adjusted quality inputs spec §12.2 weights at
 * 40%. sharpe/mdd are typed trader_stats columns (passed via input.stats);
 * sortino/calmar/pnl_ratio come from extras. `risk_is_approx` flags DEX Tier-0
 * daily-approx derivations (lib/ingest/core/series-risk.ts) so a v2 formula can
 * down-weight sampled risk vs exchange-reported.
 *
 * Source → raw signal inventory (sampled from prod, 2026-06):
 *   bitget_cfd/futures   style_labels[], settled_in_days, copier_count_current,
 *                        copier_count_max, trade_frequency, long_short_ratio
 *   gate_futures         style_labels[], last_liquidation_at (unique risk
 *                        signal — spec §12.3), trading_frequency, leading_days
 *   gate_cfd             net_asset_value, trading_frequency, leading_days
 *   bitmart_futures      nav, rank_rings {*_point: 0-100}, trades_per_day
 *   mexc_futures         style_tags[{code,content}], ability_scores {0-1},
 *                        ability_rating, settled_days, trade_frequency_per_week
 *   htx_futures/spot     style_tags[string], trade_frequency_per_week,
 *                        max_copier_slots
 *   bybit_copytrade      weekly_trades, max_follower_count
 *   bingx_futures        risk rating 1-10 (sources.meta.risk_rating_1_10)
 *   binance_web3_bsc     traders.meta.binance_web3_kol (KOL flag)
 *   okx_web3_solana      traders.meta.okx_web3_labels (wallet categories:
 *                        sniper / dev / fresh / pump smart money / kol …)
 *   xt_futures           style_labels[], leading_days
 *
 * ── How V3 (lib/utils/arena-score.ts) would consume this ──────────────────
 * The live formula is ReturnScore + PnlScore, scaled by a confidence
 * multiplier and trust weight. FeatureVector plugs in WITHOUT touching the
 * tanh core:
 *
 *   1. confidenceMultiplier — `coverage` (count of populated features) and
 *      `settled_in_days` extend the existing sample-size confidence: a
 *      trader settled 500+ days with radar percentiles deserves a higher
 *      multiplier than a 4-day-old account with identical ROI.
 *   2. trustWeight — `risk_rating` (1-10, higher = riskier) and a recent
 *      `last_liquidation_at` are direct trust *discounts*; `kol === true`
 *      with wallet_categories containing 'dev' or 'sniper' flags
 *      manipulation-prone wallets for bot-detection review, not scoring.
 *   3. New sub-scores (additive, behind a flag) — radar_percentiles gives a
 *      pre-normalized 0-100 execution-quality block; copier_count_current /
 *      copier_count_max utilization is a demand signal; long_short_ratio and
 *      trade_frequency_per_week feed style clustering (style_labels are the
 *      exchange's own labels to validate that clustering against).
 *
 * Live scoring is NOT changed by this module — it is imported by nothing in
 * the scoring path until a v2 formula lands.
 *
 * Server reads go through the service_role-only RPC arena_score_features
 * (migration 20260612*_arena_score_features_rpc.sql) — extras/meta are not
 * public-board data, so the function is NOT granted to anon/authenticated.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Types
// ============================================================

export interface FeatureVector {
  source: string
  /** trader_stats.timeframe the extras row came from (0 = inception). */
  timeframe: number | null
  /** Exchange-assigned style labels, normalized to a flat string list. */
  style_labels: string[]
  /** Radar/ability percentiles normalized to 0-100 (MEXC ability_scores 0-1,
   *  BitMart rank_rings *_point 0-100). Null when the source has none. */
  radar_percentiles: Record<string, number> | null
  /** Exchange risk rating clamped to 1-10, higher = riskier (BingX). */
  risk_rating: number | null
  /** Net asset value of the lead portfolio (BitMart nav, Gate CFD). */
  nav: number | null
  /** Days since the trader settled / started leading on the exchange. */
  settled_in_days: number | null
  copier_count_current: number | null
  copier_count_max: number | null
  /** Trades per week, converted from per-day / per-period variants. */
  trade_frequency_per_week: number | null
  long_short_ratio: number | null
  /** Risk-adjusted quality ratios (spec §12.2 risk control block). sharpe/mdd
   *  come from the typed trader_stats columns (passed via input.stats); sortino/
   *  calmar/pnl_ratio from extras. Null when the source/derivation has none. */
  sharpe: number | null
  sortino: number | null
  mdd: number | null
  calmar: number | null
  pnl_ratio: number | null
  /** True when sharpe/mdd/sortino were derived from a daily-sampled series
   *  (DEX Tier-0, extras.risk_derivation='daily-approx') rather than exchange-
   *  reported — a v2 formula should down-weight these vs exchange-grade values. */
  risk_is_approx: boolean
  /** Lifetime trade count — an activity/confidence signal (Phase A promotions). */
  lifetime_trades: number | null
  /** ISO timestamp of the most recent forced liquidation (Gate — spec §12.3:
   *  a risk signal no other exchange exposes). */
  last_liquidation_at: string | null
  /** Exchange flagged this wallet/account as a KOL (binance_web3_kol). */
  kol: boolean
  /** On-chain wallet behavior categories (okx_web3_labels). */
  wallet_categories: string[]
  /** Count of populated feature slots — confidence input for V3 (see doc). */
  coverage: number
}

export interface FeatureExtractionInput {
  source: string
  timeframe?: number | null
  /** arena.trader_stats.extras for one (trader, timeframe) row. */
  extras?: Record<string, unknown> | null
  /** arena.traders.meta for the trader. */
  meta?: Record<string, unknown> | null
  /** Typed trader_stats columns (sharpe/mdd live here, not in extras). Optional
   *  so existing extras-only callers keep working; the v2 formula joins them in. */
  stats?: { sharpe?: number | null; mdd?: number | null } | null
}

// ============================================================
// Primitive normalizers (defensive: extras are scraped, never trusted)
// ============================================================

const MAX_LABELS = 12

function finiteOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function nonNegativeOrNull(v: unknown): number | null {
  const n = finiteOrNull(v)
  return n === null || n < 0 ? null : n
}

function firstFinite(extras: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const n = finiteOrNull(extras[key])
    if (n !== null) return n
  }
  return null
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** Kill float noise from fraction→percent conversion (0.8433 → 84.33). */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6
}

/** One label out of the three observed spellings: plain string (HTX, Gate,
 *  Bitget, XT), or MEXC's `{ code, content }` objects. */
function asLabel(item: unknown): string | null {
  if (typeof item === 'string') {
    const trimmed = item.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (item && typeof item === 'object') {
    const content = (item as Record<string, unknown>).content
    if (typeof content === 'string' && content.trim().length > 0) return content.trim()
  }
  return null
}

function normalizeLabels(...rawLists: unknown[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of rawLists) {
    if (!Array.isArray(raw)) continue
    for (const item of raw) {
      const label = asLabel(item)
      if (!label) continue
      const dedupeKey = label.toLowerCase()
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      out.push(label)
      if (out.length >= MAX_LABELS) return out
    }
  }
  return out
}

/** MEXC ability_scores are 0-1 fractions; BitMart rank_rings are `*_point`
 *  keys already on 0-100. Both normalize to 0-100 with the suffix stripped. */
function normalizeRadar(extras: Record<string, unknown>): Record<string, number> | null {
  const out: Record<string, number> = {}

  const ability = extras.ability_scores
  if (ability && typeof ability === 'object' && !Array.isArray(ability)) {
    for (const [key, raw] of Object.entries(ability as Record<string, unknown>)) {
      const n = finiteOrNull(raw)
      if (n !== null) out[key] = round6(clamp(n * 100, 0, 100))
    }
  }

  const rings = extras.rank_rings
  if (rings && typeof rings === 'object' && !Array.isArray(rings)) {
    for (const [key, raw] of Object.entries(rings as Record<string, unknown>)) {
      const n = finiteOrNull(raw)
      if (n !== null) out[key.replace(/_point$/, '')] = clamp(n, 0, 100)
    }
  }

  return Object.keys(out).length > 0 ? out : null
}

// Alias tables — per-source key spellings observed in prod extras.
const SETTLED_DAYS_KEYS = [
  'settled_in_days', // bitget
  'settled_days', // mexc
  'leading_days', // gate, xt
  'trading_days', // bybit, bitget futures
  'trade_days', // coinex
  'days_trading', // binance spot
] as const

const COPIER_MAX_KEYS = [
  'copier_count_max', // bitget, binance
  'max_copier_slots', // htx, coinex
  'max_follower_count', // bybit
  'copier_limit', // btcc
] as const

const WEEKLY_FREQUENCY_KEYS = [
  'trade_frequency_per_week', // htx, mexc
  'weekly_trades', // bybit
  'trade_frequency', // bitget, gate, kucoin (per-week; gate/kucoin ×7 from per-day)
  // NOTE: `trading_frequency` is deliberately EXCLUDED — gate/kucoin write it as
  // the raw PER-DAY value (the per-week figure is `trade_frequency`). Treating
  // per-day as per-week would under-count 7×.
] as const

/** Profit-to-loss quality ratio — many spellings across sources. */
const PNL_RATIO_KEYS = [
  'pnl_ratio',
  'profit_to_loss_ratio',
  'profit_loss_ratio',
  'profit_and_loss_ratio',
  'pl_ratio',
] as const

/** Lifetime trade-count spellings (Phase A promotions + earlier). */
const LIFETIME_TRADES_KEYS = ['lifetime_trades', 'trade_count_lifetime'] as const

// ============================================================
// Extraction
// ============================================================

export function extractFeatureVector(input: FeatureExtractionInput): FeatureVector {
  const extras = input.extras && typeof input.extras === 'object' ? input.extras : {}
  const meta = input.meta && typeof input.meta === 'object' ? input.meta : {}

  const stats = input.stats && typeof input.stats === 'object' ? input.stats : {}
  const riskRaw = firstFinite(extras, ['risk_rating', 'risk_rating_1_10'])
  const navRaw = firstFinite(extras, ['nav', 'net_asset_value'])
  const weekly = firstFinite(extras, WEEKLY_FREQUENCY_KEYS)
  const perDay = finiteOrNull(extras.trades_per_day) // bitmart
  const settled = firstFinite(extras, SETTLED_DAYS_KEYS)
  // sharpe/mdd are typed columns → prefer input.stats, fall back to extras
  // (DEX Tier-0 sets the typed cols; some sources also mirror into extras).
  const sharpeRaw = stats.sharpe ?? finiteOrNull(extras.sharpe)
  const mddRaw = stats.mdd ?? finiteOrNull(extras.mdd)
  const lifetimeTrades = firstFinite(extras, LIFETIME_TRADES_KEYS)

  const vector: Omit<FeatureVector, 'coverage'> = {
    source: input.source,
    timeframe: input.timeframe ?? null,
    style_labels: normalizeLabels(extras.style_labels, extras.style_tags),
    radar_percentiles: normalizeRadar(extras),
    risk_rating: riskRaw === null ? null : clamp(Math.round(riskRaw), 1, 10),
    nav: navRaw === null || navRaw < 0 ? null : navRaw,
    settled_in_days: settled === null || settled < 0 ? null : Math.round(settled),
    copier_count_current: nonNegativeOrNull(extras.copier_count_current),
    copier_count_max: firstFinite(extras, COPIER_MAX_KEYS),
    trade_frequency_per_week:
      weekly !== null && weekly >= 0 ? weekly : perDay !== null && perDay >= 0 ? perDay * 7 : null,
    long_short_ratio: nonNegativeOrNull(extras.long_short_ratio),
    sharpe: sharpeRaw === null || sharpeRaw === undefined ? null : round6(sharpeRaw),
    sortino: firstFinite(extras, ['sortino', 'sortino_ratio']),
    mdd: mddRaw === null || mddRaw === undefined || mddRaw < 0 ? null : round6(mddRaw),
    calmar: firstFinite(extras, ['calmar', 'calmar_ratio']),
    pnl_ratio: firstFinite(extras, PNL_RATIO_KEYS),
    risk_is_approx: extras.risk_derivation === 'daily-approx',
    lifetime_trades:
      lifetimeTrades === null || lifetimeTrades < 0 ? null : Math.round(lifetimeTrades),
    last_liquidation_at: isoOrNull(extras.last_liquidation_at),
    kol: meta.binance_web3_kol === true || meta.kol === true,
    wallet_categories: normalizeLabels(meta.okx_web3_labels, meta.wallet_category_tags),
  }

  return { ...vector, coverage: countCoverage(vector) }
}

function countCoverage(v: Omit<FeatureVector, 'coverage'>): number {
  let n = 0
  if (v.style_labels.length > 0) n++
  if (v.radar_percentiles !== null) n++
  if (v.risk_rating !== null) n++
  if (v.nav !== null) n++
  if (v.settled_in_days !== null) n++
  if (v.copier_count_current !== null) n++
  if (v.copier_count_max !== null) n++
  if (v.trade_frequency_per_week !== null) n++
  if (v.long_short_ratio !== null) n++
  if (v.sharpe !== null) n++
  if (v.sortino !== null) n++
  if (v.mdd !== null) n++
  if (v.calmar !== null) n++
  if (v.pnl_ratio !== null) n++
  if (v.lifetime_trades !== null) n++
  if (v.last_liquidation_at !== null) n++
  if (v.kol) n++
  if (v.wallet_categories.length > 0) n++
  return n
}

// ============================================================
// Server read path (service_role only)
// ============================================================

/** Per-timeframe feature vectors for one trader, read through the
 *  service_role-only arena_score_features RPC. Returns {} when the trader
 *  is unknown or the caller lacks the grant (anon/authenticated). */
export async function fetchFeatureVectors(
  supabase: SupabaseClient,
  source: string,
  exchangeTraderId: string
): Promise<Record<number, FeatureVector>> {
  const { data, error } = await supabase.rpc('arena_score_features', {
    p_source: source,
    p_trader: exchangeTraderId,
  })
  if (error || !data || typeof data !== 'object') return {}
  const d = data as Record<string, unknown>
  const meta = (d.meta as Record<string, unknown>) ?? null
  const byTimeframe = (d.byTimeframe as Record<string, unknown>) ?? {}

  const out: Record<number, FeatureVector> = {}
  for (const [tfKey, raw] of Object.entries(byTimeframe)) {
    const tf = Number(tfKey)
    if (!Number.isFinite(tf) || !raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const extras = row.extras as Record<string, unknown> | null
    // typed sharpe/mdd if the RPC surfaces them alongside extras (else null →
    // the extractor falls back to extras / leaves them null).
    const stats = {
      sharpe: typeof row.sharpe === 'number' ? row.sharpe : null,
      mdd: typeof row.mdd === 'number' ? row.mdd : null,
    }
    out[tf] = extractFeatureVector({ source, timeframe: tf, extras, meta, stats })
  }
  return out
}
