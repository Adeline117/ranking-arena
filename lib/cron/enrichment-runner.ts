/**
 * Core enrichment logic extracted from /api/cron/enrich route.
 * Can be called inline from batch-enrich (no HTTP needed) or from the route.
 */

import { validatePlatform } from '@/lib/config/platforms'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getReadReplica } from '@/lib/supabase/read-replica'
import { raceWithTimeout } from '@/lib/utils/race-with-timeout'
import {
  fetchBinanceEquityCurve,
  fetchBinanceStatsDetail,
  fetchBinancePositionHistory,
  // Bybit enrichment re-enabled (2026-03-18) — now routes through VPS scraper
  fetchBybitEquityCurve,
  fetchBybitStatsDetail,
  fetchOkxEquityCurve,
  fetchOkxStatsDetail,
  fetchOkxCurrentPositions,
  fetchOkxPositionHistory,
  fetchBitgetEquityCurve,
  fetchBitgetStatsDetail,
  fetchBitgetPositionHistory,
  fetchHyperliquidPositionHistory,
  fetchHyperliquidPortfolio,
  fetchHyperliquidEquityCurve,
  fetchHyperliquidStatsDetail,
  fetchGmxPositionHistory,
  fetchGmxPortfolio,
  fetchGmxEquityCurve,
  fetchGmxStatsDetail,
  fetchHtxEquityCurve,
  fetchHtxStatsDetail,
  fetchGateioEquityCurve,
  fetchGateioStatsDetail,
  fetchGateioCurrentPositions,
  fetchMexcEquityCurve,
  fetchMexcStatsDetail,
  fetchDriftPositionHistory,
  fetchDriftPositionHistoryFromS3,
  fetchDriftEquityCurve,
  fetchDriftStatsDetail,
  fetchDydxEquityCurve,
  fetchDydxStatsDetail,
  fetchDydxV4PositionHistory,
  fetchAevoEquityCurve,
  fetchAevoStatsDetail,
  fetchAevoPositionHistory,
  fetchGainsEquityCurve,
  fetchGainsStatsDetail,
  fetchGainsPositionHistory,
  fetchKwentaEquityCurve,
  fetchKwentaStatsDetail,
  fetchKwentaPositionHistory,
  fetchJupiterPositionHistory,
  fetchJupiterEquityCurve,
  fetchJupiterStatsDetail,
  fetchGainsOnchainEquityCurve,
  fetchGainsOnchainStatsDetail,
  fetchGainsOnchainPositionHistory,
  fetchKwentaOnchainEquityCurve,
  fetchKwentaOnchainStatsDetail,
  fetchKwentaOnchainPositionHistory,
  fetchBtccEquityCurve,
  fetchBtccStatsDetail,
  fetchEtoroEquityCurve,
  fetchEtoroStatsDetail,
  fetchEtoroPortfolio,
  fetchCoinexEquityCurve,
  fetchCoinexStatsDetail,
  fetchBitunixEquityCurve,
  fetchBitunixStatsDetail,
  fetchXtEquityCurve,
  fetchXtStatsDetail,
  fetchBitfinexEquityCurve,
  fetchBitfinexStatsDetail,
  fetchBitfinexRoi,
  fetchBlofinEquityCurve,
  fetchBlofinStatsDetail,
  fetchBingxEquityCurve,
  fetchBingxStatsDetail,
  fetchBingxCurrentPositions,
  fetchToobitEquityCurve,
  fetchToobitStatsDetail,
  fetchBinanceSpotEquityCurve,
  fetchBinanceSpotStatsDetail,
  fetchWalletAUM,
  fetchWalletPortfolio,
  isDexPlatform,
  upsertEquityCurve,
  upsertStatsDetail,
  upsertPositionHistory,
  upsertAssetBreakdown,
  upsertPortfolio,
  enhanceStatsWithDerivedMetrics,
  calculateAssetBreakdown,
  type StatsDetail,
  type EquityCurvePoint,
  type PositionHistoryItem,
  type PortfolioPosition,
} from '@/lib/cron/fetchers/enrichment'
import {
  fetchOkxSpotEquityCurve,
  fetchOkxSpotStatsDetail,
  fetchOkxSpotCurrentPositions,
} from '@/lib/cron/fetchers/enrichment-okx-spot'
import {
  fetchOkxWeb3EquityCurve,
  fetchOkxWeb3StatsDetail,
} from '@/lib/cron/fetchers/enrichment-okx-web3'
// kucoin enrichment disabled — import removed
import {
  fetchWooxEquityCurve,
  fetchWooxStatsDetail,
  fetchWooxCurrentPositions,
  fetchWooxPositionHistory,
} from '@/lib/cron/fetchers/enrichment-woox'
import {
  fetchPolymarketEquityCurve,
  fetchPolymarketStatsDetail,
  fetchPolymarketCurrentPositions,
  fetchPolymarketPositionHistory,
} from '@/lib/cron/fetchers/enrichment-polymarket'
import { sleep } from '@/lib/cron/fetchers/shared'
import { captureMessage } from '@/lib/utils/logger'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { getOrSet } from '@/lib/cache'
import { PipelineState } from '@/lib/services/pipeline-state'
import { LR, V2 } from '@/lib/types/schema-mapping'

// Retry config: 3 attempts with shared AbortSignal from per-trader timeout.
// The withRetry function checks signal.aborted before each attempt, so total
// wall-clock time is bounded by the per-trader AbortController regardless of retry count.
// Previous emergency fix (maxAttempts=1) was overly conservative — the real fix was
// passing the traderController.signal to withRetry, which is now done at every call site.
const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 2000,
}

async function withRetry<T>(
  fn: () => Promise<T>,
  context: string,
  options = RETRY_CONFIG,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    // Check if the shared timeout has already been exceeded
    if (signal?.aborted) {
      throw new Error(`Timeout before attempt ${attempt} in ${context}`)
    }
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (signal?.aborted) {
        throw new Error(`Timeout during attempt ${attempt} in ${context}: ${lastError.message}`)
      }
      if (attempt === options.maxAttempts) {
        logger.error(`Enrichment ${context} failed after retries`, { attempts: attempt }, lastError)
        throw lastError
      }
      const delay = Math.min(
        options.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500,
        options.maxDelayMs
      )
      logger.warn(`Enrichment ${context} attempt ${attempt} failed, retrying`, { delay: Math.round(delay) })
      await sleep(delay)
    }
  }
  throw lastError
}

/**
 * Build equity curve from daily snapshots in our DB.
 * Used as fallback when platform APIs don't provide historical data.
 * Uses trader_daily_snapshots table (populated by aggregate-daily-snapshots cron).
 */
async function buildEquityCurveFromSnapshots(
  supabase: import('@supabase/supabase-js').SupabaseClient,
  source: string,
  traderId: string,
  days: number
): Promise<EquityCurvePoint[]> {
  try {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]
    const { data, error } = await supabase
      .from('trader_daily_snapshots')
      .select('date, roi, pnl')
      .eq('platform', source)
      .eq('trader_key', traderId)
      .gte('date', cutoff)
      .order('date', { ascending: true })
      .limit(days)

    if (error || !data || data.length === 0) return []

    return data.map((row: { date: string; roi: number | null; pnl: number | null }) => ({
      date: row.date,
      roi: row.roi ?? 0,
      pnl: row.pnl ?? null,
    }))
  } catch (err) {
    logger.warn(`[buildEquityCurveFromSnapshots] Failed for ${source}/${traderId}`, {
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

interface EnrichmentConfig {
  platform: string
  fetchEquityCurve?: (traderId: string, days: number) => Promise<Array<{ date: string; roi: number; pnl: number | null }>>
  fetchStatsDetail?: (traderId: string) => Promise<StatsDetail | null>
  fetchPositionHistory?: (traderId: string) => Promise<PositionHistoryItem[]>
  fetchCurrentPositions?: (traderId: string) => Promise<(PortfolioPosition | PositionHistoryItem)[]>
  concurrency: number
  delayMs: number
  limit?: number // Max traders to enrich per run (for slow VPS scrapers)
}

export const ENRICHMENT_PLATFORM_CONFIGS: Record<string, EnrichmentConfig> = {
  binance_futures: {
    platform: 'binance_futures',
    fetchEquityCurve: async (traderId, days) => {
      const timeRangeMap: Record<number, string> = { 7: '7D', 30: '30D', 90: '90D' }
      return fetchBinanceEquityCurve(traderId, timeRangeMap[days] || '90D')
    },
    fetchStatsDetail: fetchBinanceStatsDetail,
    fetchCurrentPositions: fetchBinancePositionHistory,
    fetchPositionHistory: fetchBinancePositionHistory,
    concurrency: 3, delayMs: 1200, // Reduced from 5/800: concurrency 5 caused zombie hangs (16 errors/day)
  },
  // binance_spot: PERMANENTLY REMOVED (2026-03-14) - repeatedly hangs 45-76min, blocks entire pipeline
  // Bybit enrichment re-enabled (2026-03-18) — routes through VPS scraper
  bybit: {
    platform: 'bybit',
    fetchEquityCurve: fetchBybitEquityCurve,
    fetchStatsDetail: fetchBybitStatsDetail,
    concurrency: 2, delayMs: 2000, limit: 20, // VPS scraper: ~20s/trader (2 Playwright calls), 2 concurrent = ~200s for 20 traders
  },
  okx_futures: {
    platform: 'okx_futures',
    fetchEquityCurve: fetchOkxEquityCurve,
    fetchStatsDetail: fetchOkxStatsDetail,
    fetchPositionHistory: fetchOkxPositionHistory,
    fetchCurrentPositions: fetchOkxCurrentPositions,
    concurrency: 8, delayMs: 500, // Increased: direct API, not geo-blocked
  },
  okx_spot: {
    platform: 'okx_spot',
    fetchEquityCurve: fetchOkxSpotEquityCurve,
    fetchStatsDetail: fetchOkxSpotStatsDetail,
    fetchCurrentPositions: fetchOkxSpotCurrentPositions,
    concurrency: 3, delayMs: 1500,
  },
  okx_web3: {
    platform: 'okx_web3',
    fetchEquityCurve: fetchOkxWeb3EquityCurve,
    fetchStatsDetail: fetchOkxWeb3StatsDetail,
    concurrency: 2, delayMs: 2000,
  },
  // weex: DISABLED 2026-04-01 — 75% timeout rate, VPS scraper unreliable, platform removed from fetch groups
  // weex: {
  //   platform: 'weex',
  //   fetchEquityCurve: fetchWeexEquityCurve,
  //   fetchStatsDetail: fetchWeexStatsDetail,
  //   concurrency: 1, delayMs: 3000,
  // },
  // kucoin: DISABLED 2026-04-01 — copy trading discontinued, removed from fetch groups
  // kucoin: {
  //   platform: 'kucoin',
  //   fetchEquityCurve: fetchKucoinEquityCurve,
  //   fetchStatsDetail: fetchKucoinStatsDetail,
  //   concurrency: 1, delayMs: 3000,
  // },
  // bitget_futures: RE-ENABLED stats+positions (2026-03-19)
  // Root cause of 44min hang: fetchStatsDetail internally called fetchPositionHistory,
  // doubling request time (2x20s timeout). Fix: standalone stats, strict 10s timeouts.
  // Safety: concurrency:1, per-trader 25s timeout, per-platform 120s timeout.
  bitget_futures: {
    platform: 'bitget_futures',
    fetchEquityCurve: fetchBitgetEquityCurve,
    fetchStatsDetail: fetchBitgetStatsDetail,
    fetchPositionHistory: fetchBitgetPositionHistory,
    concurrency: 3, delayMs: 1000, // Increased from 1/2000: CF Worker proxy handles 3 concurrent fine
  },
  // bybit_spot: VPS trader-detail may or may not support spot leaderMarks.
  // Even if VPS fails, the enrichment runner's buildEquityCurveFromSnapshots
  // fallback + derived metrics computation will still compute PnL from equity curves.
  bybit_spot: {
    platform: 'bybit_spot',
    fetchEquityCurve: fetchBybitEquityCurve,
    fetchStatsDetail: fetchBybitStatsDetail,
    concurrency: 2, delayMs: 2000, limit: 20, // Reduced from 3/1500/50: VPS scraper is slow (~20s/trader), 50 traders = 750s which always times out
  },
  hyperliquid: {
    platform: 'hyperliquid',
    fetchEquityCurve: fetchHyperliquidEquityCurve,
    fetchStatsDetail: fetchHyperliquidStatsDetail,
    fetchPositionHistory: fetchHyperliquidPositionHistory,
    fetchCurrentPositions: fetchHyperliquidPortfolio,
    concurrency: 10, delayMs: 200, // No rate limit, fast API
  },
  gmx: {
    platform: 'gmx',
    fetchEquityCurve: fetchGmxEquityCurve,
    fetchStatsDetail: fetchGmxStatsDetail,
    fetchPositionHistory: fetchGmxPositionHistory,
    fetchCurrentPositions: fetchGmxPortfolio,
    concurrency: 8, delayMs: 300,
  },
  htx_futures: {
    platform: 'htx_futures',
    fetchEquityCurve: fetchHtxEquityCurve,
    fetchStatsDetail: fetchHtxStatsDetail,
    concurrency: 5, delayMs: 800,
  },
  gateio: {
    platform: 'gateio',
    fetchEquityCurve: fetchGateioEquityCurve,
    fetchStatsDetail: fetchGateioStatsDetail,
    fetchCurrentPositions: fetchGateioCurrentPositions,
    concurrency: 3, delayMs: 1000, // Reduced from 8/300: 64% failure rate indicates rate limiting
  },
  mexc: {
    platform: 'mexc',
    fetchEquityCurve: fetchMexcEquityCurve,
    fetchStatsDetail: fetchMexcStatsDetail,
    concurrency: 5, delayMs: 500, // Reduced delay from 800: MEXC mobile UA bypass is fast
  },
  bingx_spot: {
    platform: 'bingx_spot',
    fetchEquityCurve: fetchBingxEquityCurve,
    fetchStatsDetail: fetchBingxStatsDetail,
    concurrency: 3, delayMs: 1000,
  },
  drift: {
    platform: 'drift',
    fetchEquityCurve: fetchDriftEquityCurve,
    fetchStatsDetail: fetchDriftStatsDetail,
    fetchPositionHistory: async (traderId: string) => {
      const s3Positions = await fetchDriftPositionHistoryFromS3(traderId, 90)
      if (s3Positions.length > 0) return s3Positions
      return fetchDriftPositionHistory(traderId)
    },
    concurrency: 3, delayMs: 800, // Reduced from 8/300: 78% failure rate, API rate-limiting
  },
  dydx: {
    platform: 'dydx',
    fetchEquityCurve: fetchDydxEquityCurve,
    fetchStatsDetail: fetchDydxStatsDetail,
    fetchPositionHistory: fetchDydxV4PositionHistory,
    concurrency: 5, delayMs: 500, // Increased from 3/1000: Copin API handles higher concurrency
  },
  aevo: {
    platform: 'aevo',
    fetchEquityCurve: fetchAevoEquityCurve,
    fetchStatsDetail: fetchAevoStatsDetail,
    fetchPositionHistory: fetchAevoPositionHistory,
    concurrency: 8, delayMs: 300, // Native API + Copin fallback
  },
  gains: {
    platform: 'gains',
    fetchEquityCurve: async (traderId: string, days: number) => {
      // Primary: on-chain via Etherscan V2 (Arbitrum)
      const onchain = await fetchGainsOnchainEquityCurve(traderId, days)
      if (onchain.length > 0) return onchain
      // Fallback: Copin (returns [] but keeps the chain)
      return fetchGainsEquityCurve(traderId, days)
    },
    fetchStatsDetail: async (traderId: string) => {
      // Try on-chain first for richer data (win/loss, drawdown)
      const onchain = await fetchGainsOnchainStatsDetail(traderId)
      if (onchain) return onchain
      // Fallback: Copin leaderboard stats
      return fetchGainsStatsDetail(traderId)
    },
    fetchPositionHistory: async (traderId: string) => {
      // Primary: on-chain trade events
      const onchain = await fetchGainsOnchainPositionHistory(traderId)
      if (onchain.length > 0) return onchain
      return fetchGainsPositionHistory(traderId)
    },
    concurrency: 2, delayMs: 1500, // Slower due to Etherscan rate limits
  },
  kwenta: {
    platform: 'kwenta',
    fetchEquityCurve: async (traderId: string, days: number) => {
      // Primary: on-chain via Blockscout Base (free, no API key)
      const onchain = await fetchKwentaOnchainEquityCurve(traderId, days)
      if (onchain.length > 0) return onchain
      // Fallback: Copin (returns [])
      return fetchKwentaEquityCurve(traderId, days)
    },
    fetchStatsDetail: async (traderId: string) => {
      // Primary: on-chain OrderSettled events
      const onchain = await fetchKwentaOnchainStatsDetail(traderId)
      if (onchain) return onchain
      // Fallback: Copin leaderboard stats
      return fetchKwentaStatsDetail(traderId)
    },
    fetchPositionHistory: async (traderId: string) => {
      // Primary: on-chain OrderSettled events
      const onchain = await fetchKwentaOnchainPositionHistory(traderId)
      if (onchain.length > 0) return onchain
      return fetchKwentaPositionHistory(traderId)
    },
    concurrency: 2, delayMs: 1500, // Slower due to Blockscout rate limits
  },
  jupiter_perps: {
    platform: 'jupiter_perps',
    fetchEquityCurve: fetchJupiterEquityCurve,
    fetchStatsDetail: fetchJupiterStatsDetail,
    fetchPositionHistory: fetchJupiterPositionHistory,
    concurrency: 2, delayMs: 1000, // Reduced from 3/300: 75% failure rate, Solana RPC limits
  },
  btcc: {
    platform: 'btcc',
    fetchEquityCurve: fetchBtccEquityCurve,
    fetchStatsDetail: fetchBtccStatsDetail,
    concurrency: 2, delayMs: 1500,
  },
  etoro: {
    platform: 'etoro',
    fetchEquityCurve: fetchEtoroEquityCurve,
    fetchStatsDetail: fetchEtoroStatsDetail,
    fetchCurrentPositions: fetchEtoroPortfolio,
    concurrency: 2, delayMs: 2000, // Reduced from 5/800: eToro rate-limits aggressively (81% failure rate)
  },
  coinex: {
    platform: 'coinex',
    fetchEquityCurve: fetchCoinexEquityCurve,
    fetchStatsDetail: fetchCoinexStatsDetail,
    concurrency: 20, delayMs: 0, // Batch-cached from public traders list
  },
  bitunix: {
    platform: 'bitunix',
    fetchEquityCurve: fetchBitunixEquityCurve,
    fetchStatsDetail: fetchBitunixStatsDetail,
    concurrency: 50, delayMs: 0, // Batch-cached: all lookups from memory, no API calls
  },
  xt: {
    platform: 'xt',
    fetchEquityCurve: fetchXtEquityCurve,
    fetchStatsDetail: fetchXtStatsDetail,
    concurrency: 50, delayMs: 0, // Batch-cached: all lookups from memory, no API calls
  },
  bitfinex: {
    platform: 'bitfinex',
    fetchEquityCurve: fetchBitfinexEquityCurve,
    fetchStatsDetail: fetchBitfinexStatsDetail,
    concurrency: 20, delayMs: 0, // Batch-cached from rankings, no per-trader API
  },
  blofin: {
    platform: 'blofin',
    fetchEquityCurve: fetchBlofinEquityCurve,
    fetchStatsDetail: fetchBlofinStatsDetail,
    concurrency: 2, delayMs: 1500, // Direct API returns 401, relies on CF proxy fallback
  },
  // phemex: REMOVED 2026-04-01 — API returns 404 (confirmed dead), removed from fetch groups too
  bingx: {
    platform: 'bingx',
    fetchEquityCurve: fetchBingxEquityCurve,
    fetchStatsDetail: fetchBingxStatsDetail,
    fetchCurrentPositions: fetchBingxCurrentPositions,
    concurrency: 2, delayMs: 2000, // Via CF proxy
  },
  toobit: {
    platform: 'toobit',
    fetchEquityCurve: fetchToobitEquityCurve,
    fetchStatsDetail: fetchToobitStatsDetail,
    concurrency: 20, delayMs: 0, // Batch-cached from rankings list
  },
  binance_spot: {
    platform: 'binance_spot',
    fetchEquityCurve: async (traderId: string, days: number) => {
      const timeRangeMap: Record<number, string> = { 7: '7D', 30: '30D', 90: '90D' }
      return fetchBinanceSpotEquityCurve(traderId, timeRangeMap[days] || '90D')
    },
    fetchStatsDetail: fetchBinanceSpotStatsDetail,
    concurrency: 3, delayMs: 1500,
  },
  // New platforms (Wave 2)
  woox: {
    platform: 'woox',
    fetchEquityCurve: fetchWooxEquityCurve,
    fetchStatsDetail: fetchWooxStatsDetail,
    fetchCurrentPositions: fetchWooxCurrentPositions,
    fetchPositionHistory: fetchWooxPositionHistory,
    concurrency: 3, delayMs: 1000,
  },
  polymarket: {
    platform: 'polymarket',
    fetchEquityCurve: fetchPolymarketEquityCurve,
    fetchStatsDetail: fetchPolymarketStatsDetail,
    fetchCurrentPositions: fetchPolymarketCurrentPositions,
    fetchPositionHistory: fetchPolymarketPositionHistory,
    concurrency: 5, delayMs: 500,
  },
}

export interface EnrichmentResult {
  ok: boolean
  duration: number
  period: string
  summary: { total: number; enriched: number; failed: number; suppressedErrors: number }
  results: Record<string, { enriched: number; failed: number; errors: string[]; suppressedErrors: number }>
}

/**
 * Run enrichment for a specific platform and period.
 * Called inline from batch-enrich or from the /api/cron/enrich route.
 */
// Platforms that don't support enrichment — ONLY truly impossible cases
// All active platforms with data should have enrichment via:
// 1. Dedicated enrichment module (fetchEquityCurve/fetchStatsDetail)
// 2. Leaderboard normalize() → connector-db-adapter writes copiers/metrics
// 3. Daily snapshot accumulation → computed equity curve
export const NO_ENRICHMENT_PLATFORMS = new Set([
  // Dead platforms — 0 traders or API 404, no data to enrich
  'bitmart', 'paradex', 'lbank', 'phemex',
  // Leaderboard-only platforms — all metrics already from normalize(), no separate detail API
  // Equity curves auto-generated from daily snapshots by aggregate-daily-snapshots cron
  // bybit_spot: REMOVED — now has enrichment config (2026-04-01), VPS trader-detail reuses same leaderMark format
  'binance_web3', // wallet-based, no per-trader detail API, all metrics from leaderboard
  'web3_bot',     // small platform (19 traders), all metrics from leaderboard
  'vertex',       // DEAD: No public leaderboard API — competition backend DNS dead, SDK has 0 leaderboard endpoints (2026-04-01)
  'apex_pro',     // DEAD: No public leaderboard API — tested 8+ endpoint patterns all 404, docs have 0 leaderboard endpoints (2026-04-01)
  'rabbitx',      // DEAD: All domains DNS dead — platform shut down, all infrastructure offline (2026-04-01)
  // 2026-03-31: dydx re-enabled — rewritten to use Copin API with AbortSignal.timeout(8s).
  // Original indexer (TCP hang) removed. All fetch calls use hardFetch() with runtime-level timeouts.
  // kucoin: REMOVED — now has dedicated enrichment module (2026-03-19)
  // weex: RE-ENABLED — ndaysReturnRates from VPS scraper leaderboard = equity curve
  // bingx_spot: REMOVED — now uses daily snapshot fallback for equity curves (2026-03-19)
])

// Per-platform timeout: prevents any single platform from burning the entire batch budget
// 2026-03-20: Increased timeouts for full coverage (was 45s/90s, now 120s/180s)
// Batch-cached platforms (bitunix, xt, etc.) finish in <5s regardless
const PLATFORM_TIMEOUT_MS: Record<string, number> = {
  'bitget_futures': 180_000,  // 3min total - increased for 200 trader limit at concurrency 3
  'binance_spot': 60_000,  // RE-ENABLED 2026-03-19 — 60s per-platform timeout
  'bybit': 240_000, // 4min - VPS Playwright scraper is slow (~20s/trader × 20 traders / 2 concurrent = ~200s)
  'bybit_spot': 240_000, // 4min - same VPS scraper as bybit (was using default 120s, causing 100% timeout)
  'etoro': 180_000, // 3min - eToro APIs are rate-limited, need generous timeout
  // Batch-cached: instant, but set generous limit
  'bitunix': 30_000, 'xt': 30_000, 'blofin': 60_000,
  'bitfinex': 60_000, 'toobit': 60_000, 'coinex': 60_000,
}
const DEFAULT_PLATFORM_TIMEOUT_MS = 120_000  // 2min for CEX (was 45s)
const ONCHAIN_PLATFORM_TIMEOUT_MS = 180_000  // 3min for onchain (was 90s)
const ONCHAIN_SET = new Set(['gmx', 'dydx', 'jupiter_perps', 'hyperliquid', 'drift', 'aevo', 'gains', 'kwenta'])

// Per-trader timeout: ultra-aggressive timeout for platforms that hang
// 2026-03-21: Reduced binance_futures from 20s→12s after VPS proxy testing showed <500ms responses
// 2026-03-22: Added dydx 15s timeout (similar to bitget_futures pattern)
const PER_TRADER_TIMEOUT_MS: Record<string, number> = {
  'bitget_futures': 18_000,  // 18s per trader - equity 15s + detail 10s run in parallel, 18s is generous
  'binance_futures': 30_000, // 30s per trader (was 20s) — Binance API intermittently slow under load
  'binance_spot': 30_000,    // 30s per trader — same as binance_futures
  'dydx': 15_000, // 15s per trader - 3 APIs × 5-6s timeout + fallback buffer
  'bybit': 75_000, // 75s per trader — VPS fetch has 60s timeout
  'bybit_spot': 75_000, // 75s per trader — same VPS scraper as bybit
  'etoro': 20_000, // 20s per trader - CopySim + ranking cache + portfolio fetch
  'woox': 25_000, // 25s per trader (was default 15s) — woox API consistently slow, was 100% failure
  'okx_spot': 30_000, // 30s per trader — OKX API intermittently slow
  'okx_futures': 30_000, // 30s per trader — same as spot
}

function getPlatformTimeout(platform: string): number {
  return PLATFORM_TIMEOUT_MS[platform] ?? (ONCHAIN_SET.has(platform) ? ONCHAIN_PLATFORM_TIMEOUT_MS : DEFAULT_PLATFORM_TIMEOUT_MS)
}

export async function runEnrichment(params: {
  platform: string
  period: string
  limit: number
  offset?: number
  /** When provided, skip leaderboard_ranks DB read and enrich these trader keys directly.
   *  Used by batch-fetch to enrich freshly-fetched traders inline. */
  traderKeys?: string[]
  /** Optional time budget in ms. Enrichment stops when elapsed time exceeds this. */
  timeBudgetMs?: number
}): Promise<EnrichmentResult> {
  const { platform: platformParam, period, limit, offset = 0, traderKeys: providedKeys, timeBudgetMs } = params
  const startTime = Date.now()
  
  // ✅ Parameter validation - prevent invalid/missing period
  if (!period || !['7D', '30D', '90D'].includes(period)) {
    throw new Error(`Invalid period: ${period}. Must be 7D, 30D, or 90D`)
  }
  
  // 🚨 Blacklist check - prevent disabled platforms from running
  validatePlatform(platformParam)
  
  const plog = await PipelineLogger.start(`enrich-${platformParam}`, { 
    platform: platformParam, 
    period, 
    limit, 
    offset 
  })

  // Early exit for platforms that don't support enrichment
  if (NO_ENRICHMENT_PLATFORMS.has(platformParam)) {
    logger.info(`[enrich] Skipping ${platformParam} - enrichment not supported`)
    await plog.success(0, { reason: 'platform does not support enrichment' })
    return { ok: true, duration: 0, period, summary: { total: 0, enriched: 0, failed: 0, suppressedErrors: 0 }, results: {} }
  }

  // Skip platforms that are circuit-broken in batch-fetch-traders.
  // If fetch consistently returns 0 traders, enrichment will also fail.
  try {
    const deadKey = `dead:consecutive:${platformParam}`
    const deadEntry = await PipelineState.get(deadKey)
    if (typeof deadEntry === 'number' && deadEntry >= 3) {
      logger.info(`[enrich] Skipping ${platformParam} - fetch circuit breaker active (${deadEntry} consecutive failures)`)
      await plog.success(0, { reason: `fetch circuit breaker: ${deadEntry} failures` })
      return { ok: true, duration: 0, period, summary: { total: 0, enriched: 0, failed: 0, suppressedErrors: 0 }, results: {} }
    }
  } catch {
    // Non-blocking: if PipelineState is down, proceed with enrichment
  }

  const supabase = getSupabaseAdmin()
  const readDb = getReadReplica() // Read replica for leaderboard_ranks lookups

  const platforms = [platformParam].filter((p) => p in ENRICHMENT_PLATFORM_CONFIGS)
  if (platforms.length === 0) {
    await plog.error(new Error(`Unknown platform: ${platformParam}`))
    return { ok: false, duration: 0, period, summary: { total: 0, enriched: 0, failed: 0, suppressedErrors: 0 }, results: {} }
  }

  const daysMap: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }
  const days = daysMap[period] || 90

  const results: Record<string, { enriched: number; failed: number; errors: string[]; suppressedErrors: number }> = {}
  let totalSuppressedErrors = 0

  for (const platformKey of platforms) {
    const config = ENRICHMENT_PLATFORM_CONFIGS[platformKey]
    if (!config) continue

    results[platformKey] = { enriched: 0, failed: 0, errors: [], suppressedErrors: 0 }
    let suppressedErrors = 0
    let walletEnrichFailCount = 0

    // Per-platform timeout: isolate each platform so one hanging platform
    // doesn't burn the entire batch's time budget
    const platformTimeoutMs = getPlatformTimeout(platformKey)
    const platformStart = Date.now()
    const platformController = new AbortController()
    const platformTimer = setTimeout(() => platformController.abort(), platformTimeoutMs)

    try {
      await raceWithTimeout((async () => {
    // Get trader keys: either provided directly (inline from batch-fetch) or read from DB
    let traders: Array<{ source_trader_id: string }>
    if (providedKeys && providedKeys.length > 0) {
      // Inline enrichment: trader keys provided by batch-fetch, skip DB read
      traders = providedKeys.slice(offset, offset + limit).map(k => ({ source_trader_id: k }))
      logger.info(`[enrich] ${platformKey}/${period}: using ${traders.length} provided trader keys (inline)`)
    } else {
      // Standard enrichment: read from leaderboard_ranks (canonical, has latest trader keys)
      // Cached in Redis for 10 min — leaderboard updates hourly, enrichment runs every 4-12h.
      // This eliminates ~90% of DB reads during enrichment batches (27 platforms × 3 periods).
      const cacheKey = `enrich:traders:${platformKey}:${period}:${offset}:${limit}`
      try {
        traders = await getOrSet<Array<{ source_trader_id: string }>>(
          cacheKey,
          async () => {
            let { data: dbTraders, error: fetchError } = await readDb
              .from('leaderboard_ranks')
              .select(LR.source_trader_id)
              .eq(LR.source, platformKey)
              .eq(LR.season_id, period)
              .not(LR.arena_score, 'is', null)
              .order(LR.arena_score, { ascending: false })
              .range(offset, offset + limit - 1)

            // Fallback: if no scored traders found, fetch by rank (handles compute-leaderboard lag)
            if (!fetchError && (!dbTraders || dbTraders.length === 0)) {
              logger.warn(`[enrich] ${platformKey}/${period}: no scored traders, falling back to rank-based query`)
              const fallback = await readDb
                .from('leaderboard_ranks')
                .select(LR.source_trader_id)
                .eq(LR.source, platformKey)
                .eq(LR.season_id, period)
                .order('rank', { ascending: true })
                .range(offset, offset + limit - 1)
              dbTraders = fallback.data
              fetchError = fallback.error
            }

            if (fetchError || !dbTraders) {
              throw new Error(`Failed to fetch traders: ${fetchError?.message}`)
            }
            return dbTraders
          },
          { ttl: 600 } // 10 min cache
        )
      } catch (err) {
        results[platformKey].errors.push(err instanceof Error ? err.message : String(err))
        return
      }
    }

    logger.warn(`[enrich] Processing ${traders.length} ${platformKey} traders for ${period} (timeout: ${platformTimeoutMs / 1000}s)`)

    for (let i = 0; i < traders.length; i += config.concurrency) {
      // Check per-platform time budget before each batch
      const platformElapsed = Date.now() - platformStart
      if (platformElapsed > platformTimeoutMs - 5000) {
        const remaining = traders.length - i
        logger.warn(`[enrich] ${platformKey} approaching timeout (${Math.round(platformElapsed / 1000)}s), skipping ${remaining} remaining traders`)
        results[platformKey].errors.push(`Timeout: ${remaining} traders skipped after ${Math.round(platformElapsed / 1000)}s`)
        break
      }
      // Check caller-provided time budget (used by inline enrichment from batch-fetch)
      if (timeBudgetMs) {
        const totalElapsed = Date.now() - startTime
        if (totalElapsed > timeBudgetMs - 3000) {
          const remaining = traders.length - i
          logger.warn(`[enrich] ${platformKey} inline time budget exhausted (${Math.round(totalElapsed / 1000)}s/${Math.round(timeBudgetMs / 1000)}s), ${remaining} traders deferred to batch-enrich`)
          results[platformKey].errors.push(`Time budget: ${remaining} traders deferred after ${Math.round(totalElapsed / 1000)}s`)
          break
        }
      }

      const batch = traders.slice(i, i + config.concurrency)

      const batchResults = await Promise.allSettled(
        batch.map(async (trader) => {
          const traderId = trader.source_trader_id
          // EMERGENCY FIX (2026-03-20): Aggressive per-trader timeout to prevent 44min hangs
          // Was: 25-60s. Now: 15-30s. Batch-cached platforms (bitunix/xt) finish in <2s anyway.
          // CEX with per-trader API: strict 15s limit forces fail-fast on slow responses.
          // Onchain: 30s (RPC/GraphQL need slightly more time).
          const traderTimeoutMs = PER_TRADER_TIMEOUT_MS[platformKey] 
            ?? (ONCHAIN_SET.has(platformKey) ? 30_000 : 15_000) // Reduced from 60s/30s
          const traderController = new AbortController()
          const traderTimer = setTimeout(() => {
            logger.warn(`Timeout in enrichTrader for trader ${traderId} on ${platformKey} (${traderTimeoutMs}ms)`)
            traderController.abort()
          }, traderTimeoutMs)
          // Cascade: if platform aborts, abort all its traders
          const onPlatformAbort = () => traderController.abort()
          platformController.signal.addEventListener('abort', onPlatformAbort, { once: true })

          try {
            await raceWithTimeout((async () => {
                // --- Phase 1: Parallel API fetches (independent network calls) ---
                const fetchPromises: Record<string, Promise<unknown>> = {}

                // All API fetches share the trader's AbortSignal for wall-clock enforcement
                const traderSignal = traderController.signal

                // Equity curve fetch
                if (config.fetchEquityCurve) {
                  fetchPromises.equityCurve = withRetry(
                    () => config.fetchEquityCurve!(traderId, days),
                    `${platformKey}:${traderId} equity curve`,
                    RETRY_CONFIG,
                    traderSignal,
                  ).catch((err) => {
                    suppressedErrors++
                    logger.warn(`[enrich] ${platformKey}/${traderId} equity curve failed`, { error: err instanceof Error ? err.message : String(err) })
                    return [] as EquityCurvePoint[]
                  })
                }

                // Position history fetch
                if (config.fetchPositionHistory) {
                  fetchPromises.positions = withRetry(
                    () => config.fetchPositionHistory!(traderId),
                    `${platformKey}:${traderId} position history`,
                    RETRY_CONFIG,
                    traderSignal,
                  ).catch((err) => {
                    suppressedErrors++
                    logger.warn(`[enrich] ${platformKey}/${traderId} position history failed`, { error: err instanceof Error ? err.message : String(err) })
                    return [] as PositionHistoryItem[]
                  })
                }

                // Current positions fetch
                if (config.fetchCurrentPositions) {
                  fetchPromises.currentPositions = withRetry(
                    () => config.fetchCurrentPositions!(traderId),
                    `${platformKey}:${traderId} current positions`,
                    RETRY_CONFIG,
                    traderSignal,
                  ).catch((err) => {
                    suppressedErrors++
                    logger.warn(`[enrich] ${platformKey}/${traderId} current positions failed`, { error: err instanceof Error ? err.message : String(err) })
                    return [] as (PortfolioPosition | PositionHistoryItem)[]
                  })
                }

                // Stats detail fetch
                if (config.fetchStatsDetail) {
                  fetchPromises.stats = withRetry(
                    () => config.fetchStatsDetail!(traderId),
                    `${platformKey}:${traderId} stats detail`,
                    RETRY_CONFIG,
                    traderSignal,
                  ).catch((err) => {
                    suppressedErrors++
                    logger.warn(`[enrich] ${platformKey}/${traderId} stats detail failed`, { error: err instanceof Error ? err.message : String(err) })
                    return null as StatsDetail | null
                  })
                }

                // DEX wallet AUM fetch (optional, failures logged)
                if (isDexPlatform(platformKey)) {
                  fetchPromises.walletAum = fetchWalletAUM(platformKey, traderId).catch(err => {
                    logger.warn(`[enrich] ${platformKey}/${traderId} wallet AUM fetch failed: ${err instanceof Error ? err.message : String(err)}`)
                    return null
                  })
                }

                // Await all API fetches in parallel
                const settled = await Promise.allSettled(Object.values(fetchPromises))
                const keys = Object.keys(fetchPromises)
                const fetchResults: Record<string, unknown> = {}
                keys.forEach((key, idx) => {
                  const result = settled[idx]
                  fetchResults[key] = result.status === 'fulfilled' ? result.value : null
                })

                let curve = (fetchResults.equityCurve as EquityCurvePoint[] | null) ?? []
                const positions = (fetchResults.positions as PositionHistoryItem[] | null) ?? []
                const currentPos = (fetchResults.currentPositions as (PortfolioPosition | PositionHistoryItem)[] | null) ?? []
                let stats = fetchResults.stats as StatsDetail | null
                const walletAum = fetchResults.walletAum as number | null

                // --- Phase 2: Fallback equity curve from DB snapshots ---
                // If API returned sparse data (<5 points), check if daily snapshots have more.
                // This catches platforms where the API returns 1-4 points but we've accumulated
                // 10-20+ daily snapshots over time.
                if (curve.length < 5) {
                  const dbCurve = await buildEquityCurveFromSnapshots(supabase, platformKey, traderId, days)
                  if (dbCurve.length > curve.length) {
                    curve = dbCurve
                  }
                }

                // --- Phase 3: Sequential DB writes (depend on fetch results) ---
                if (curve.length > 0) {
                  await withRetry(() => upsertEquityCurve(supabase, platformKey, traderId, period, curve), `${platformKey}:${traderId} save equity curve`, RETRY_CONFIG, traderSignal)
                }

                if (config.fetchPositionHistory && positions.length > 0) {
                  await withRetry(() => upsertPositionHistory(supabase, platformKey, traderId, positions), `${platformKey}:${traderId} save position history`, RETRY_CONFIG, traderSignal)
                  const breakdown = calculateAssetBreakdown(positions)
                  if (breakdown.length > 0) {
                    await withRetry(() => upsertAssetBreakdown(supabase, platformKey, traderId, period, breakdown), `${platformKey}:${traderId} save asset breakdown`, RETRY_CONFIG, traderSignal)
                  }
                }

                if (config.fetchCurrentPositions && currentPos.length > 0) {
                  await withRetry(
                    () => upsertPortfolio(supabase, platformKey, traderId,
                      currentPos.map((p) => ({
                        symbol: p.symbol,
                        direction: p.direction,
                        investedPct: 'investedPct' in p ? p.investedPct : null,
                        entryPrice: p.entryPrice,
                        pnl: 'pnl' in p ? p.pnl : ('pnlUsd' in p ? (p as PositionHistoryItem).pnlUsd : null),
                      }))),
                    `${platformKey}:${traderId} save current positions`,
                    RETRY_CONFIG,
                    traderSignal,
                  )
                }

                if (config.fetchStatsDetail && stats) {
                  // Pass position history to derive avg_holding_hours, avg_profit/loss, etc.
                  stats = enhanceStatsWithDerivedMetrics(stats, curve, period, positions.length > 0 ? positions : undefined)
                  await withRetry(() => upsertStatsDetail(supabase, platformKey, traderId, period, stats!), `${platformKey}:${traderId} save stats detail`, RETRY_CONFIG, traderSignal)
                }

                // Always sync key metrics back to trader_snapshots_v2 from stats + equity curve.
                // This ensures new traders are immediately complete without waiting for daily cron.
                {
                  const snapshotUpdate: Record<string, unknown> = {}
                  if (stats?.profitableTradesPct != null) snapshotUpdate.win_rate = stats.profitableTradesPct
                  if (stats?.maxDrawdown != null) snapshotUpdate.max_drawdown = stats.maxDrawdown
                  if (stats?.totalTrades != null) snapshotUpdate.trades_count = stats.totalTrades
                  if (stats?.sharpeRatio != null) snapshotUpdate.sharpe_ratio = stats.sharpeRatio
                  // ROI from stats (e.g. Gains native API, Copin totalPnl/totalVolume)
                  if (stats?.roi != null) snapshotUpdate.roi_pct = stats.roi
                  if (stats?.pnl != null) snapshotUpdate.pnl_usd ??= stats.pnl

                  // Compute from equity curve if stats didn't provide
                  if (curve.length >= 2) {
                    const lastPoint = curve[curve.length - 1]
                    const firstPoint = curve[0]
                    if (lastPoint.pnl != null) snapshotUpdate.pnl_usd ??= lastPoint.pnl
                    // ROI from equity curve: (last.roi - first.roi) or last.roi if first is 0
                    if (lastPoint.roi != null && !snapshotUpdate.roi_pct) {
                      const roiVal = firstPoint.roi != null && firstPoint.roi !== 0
                        ? lastPoint.roi - firstPoint.roi : lastPoint.roi
                      if (roiVal !== 0) snapshotUpdate.roi_pct = roiVal
                    }
                    // Sharpe from daily returns if not from stats
                    if (!snapshotUpdate.sharpe_ratio && curve.length >= 3) {
                      const returns: number[] = []
                      for (let j = 1; j < curve.length; j++) {
                        if (curve[j].roi != null && curve[j - 1].roi != null) {
                          returns.push(curve[j].roi! - curve[j - 1].roi!)
                        }
                      }
                      if (returns.length >= 2) {
                        const mean = returns.reduce((a, b) => a + b, 0) / returns.length
                        const std = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length)
                        if (std > 0) snapshotUpdate.sharpe_ratio = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
                      }
                    }
                    // Win rate from daily returns if not from stats (or if stats returned 0 — likely bad data)
                    if (!snapshotUpdate.win_rate && curve.length >= 3) {
                      const dailyReturns: number[] = []
                      for (let j = 1; j < curve.length; j++) {
                        if (curve[j].pnl != null && curve[j - 1].pnl != null) {
                          dailyReturns.push(curve[j].pnl! - curve[j - 1].pnl!)
                        }
                      }
                      if (dailyReturns.length >= 3) {
                        const wins = dailyReturns.filter(r => r > 0).length
                        snapshotUpdate.win_rate = Math.round((wins / dailyReturns.length) * 10000) / 100
                        snapshotUpdate.trades_count ??= dailyReturns.length
                      }
                    }
                    // Max drawdown from equity curve if not from stats (or if stats returned 0 — likely bad data)
                    if (!snapshotUpdate.max_drawdown && curve.length >= 3) {
                      let peak = -Infinity
                      let maxDD = 0
                      for (const pt of curve) {
                        const val = pt.roi ?? pt.pnl ?? 0
                        if (val > peak) peak = val
                        if (peak > 0) {
                          const dd = ((peak - val) / peak) * 100
                          if (dd > maxDD) maxDD = dd
                        }
                      }
                      if (maxDD > 0) snapshotUpdate.max_drawdown = Math.round(maxDD * 100) / 100
                    }
                  }

                  // Bitfinex ROI fallback: compute from rankings data when equity curve is empty
                  if (platformKey === 'bitfinex' && !snapshotUpdate.roi_pct) {
                    const windowArg = period === '7D' ? '7d' as const : '30d' as const
                    const roiFromRankings = await fetchBitfinexRoi(traderId, windowArg)
                    if (roiFromRankings != null) {
                      snapshotUpdate.roi_pct = Math.round(roiFromRankings * 100) / 100
                    }
                  }

                  // Only write non-null updates, and only overwrite NULL fields in snapshot
                  // Always touch updated_at so freshness checks pass for platforms without leaderboard API
                  snapshotUpdate.updated_at = new Date().toISOString()
                  const updates = Object.fromEntries(
                    Object.entries(snapshotUpdate).filter(([, v]) => v != null)
                  )
                  if (Object.keys(updates).length > 0) {
                    const { error: snapUpdateErr } = await supabase
                      .from('trader_snapshots_v2')
                      .update(updates)
                      .eq(V2.platform, platformKey)
                      .eq(V2.trader_key, traderId)
                      .eq(V2.window, period)
                    if (snapUpdateErr) {
                      logger.warn(`[enrich] Snapshot update failed for ${platformKey}/${traderId}: ${snapUpdateErr.message}`)
                    }
                  }
                }

                // On-chain wallet enrichment DB writes (AUM + portfolio)
                if (isDexPlatform(platformKey) && walletAum != null && walletAum > 10) {
                  const { error: aumErr } = await supabase
                    .from('trader_stats_detail')
                    .update({ aum: walletAum })
                    .eq('source', platformKey)
                    .eq('source_trader_id', traderId)
                    .eq('period', period)
                  if (aumErr) {
                    logger.warn(`[enrich] AUM update failed for ${platformKey}/${traderId}: ${aumErr.message}`)
                  }

                  if (!config.fetchCurrentPositions) {
                    try {
                      const walletPortfolio = await fetchWalletPortfolio(platformKey, traderId)
                      if (walletPortfolio.length > 0) {
                        await upsertPortfolio(supabase, platformKey, traderId, walletPortfolio)
                      }
                    } catch (_err) {
                      walletEnrichFailCount++ /* logged at platform level */
                    }
                  }
                }

                results[platformKey].enriched++
              })(), traderTimeoutMs, `${platformKey}/${traderId}`)
          } catch (err) {
            results[platformKey].failed++
            const errMsg = err instanceof Error ? err.message : String(err)
            if (results[platformKey].errors.length < 5) {
              results[platformKey].errors.push(`${traderId}: ${errMsg}`)
            }
            throw err // Re-throw to be caught by allSettled
          } finally {
            clearTimeout(traderTimer)
            platformController.signal.removeEventListener('abort', onPlatformAbort)
          }
        })
      )

      // Process allSettled results
      const successful = batchResults.filter(r => r.status === 'fulfilled')
      const failed = batchResults.filter(r => r.status === 'rejected')

      if (failed.length > 0) {
        logger.warn(`[enrich] Batch ${platformKey}: ${successful.length} success, ${failed.length} failed`)
        failed.forEach((result, idx) => {
          const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
          logger.error(`[enrich] Failed trader ${idx}: ${reason}`)
        })
      }

      if (i + config.concurrency < traders.length) {
        await sleep(config.delayMs)
      }
    }
        })(), platformTimeoutMs, `platform:${platformKey}`)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error(`[enrich] Platform ${platformKey} failed/timed out: ${errMsg}`)
      results[platformKey].errors.push(errMsg)
      // Continue to next platform - don't let one platform block others
    } finally {
      clearTimeout(platformTimer)
      platformController.abort() // Clean up any lingering trader work on platform completion/timeout
    }

    // Accumulate suppressed errors for this platform
    results[platformKey].suppressedErrors = suppressedErrors
    totalSuppressedErrors += suppressedErrors

    if (walletEnrichFailCount > 0) {
      logger.warn(`[Enrichment] ${walletEnrichFailCount} wallet enrichments failed for ${platformKey}`)
    }
    if (suppressedErrors > 0) {
      logger.warn(`[enrich] ${platformKey}: ${suppressedErrors} API calls failed silently (data returned as empty)`)
    }

  }

  const duration = Date.now() - startTime
  const totalEnriched = Object.values(results).reduce((sum, r) => sum + r.enriched, 0)
  const totalFailed = Object.values(results).reduce((sum, r) => sum + r.failed, 0)

  logger.warn(`[enrich] Completed in ${duration}ms: ${totalEnriched} enriched, ${totalFailed} failed, ${totalSuppressedErrors} API errors suppressed`)

  // Alert on high failure rate
  const total = totalEnriched + totalFailed
  const failureRate = total > 0 ? totalFailed / total : 0
  if (failureRate > 0.3 && totalFailed >= 5) {
    await captureMessage(
      `[Enrichment] High failure rate: ${(failureRate * 100).toFixed(0)}% (${totalFailed}/${total})`,
      'error',
      { period, platforms: platforms.join(', '), failureRate: failureRate.toFixed(2), totalFailed, totalEnriched }
    )
    await sendRateLimitedAlert(
      {
        title: 'Enrichment failure rate过高',
        message: `${period} period enrichment failure rate ${(failureRate * 100).toFixed(0)}%\nFailed: ${totalFailed}/${total}`,
        level: failureRate > 0.5 ? 'critical' : 'warning',
        details: { '周期': period, '平台': platforms.join(', '), '成功': totalEnriched, '失败': totalFailed, 'failure rate': `${(failureRate * 100).toFixed(1)}%` },
      },
      `enrichment:${period}`,
      600000
    )
  }

  if (totalFailed === 0) {
    await plog.success(totalEnriched, { period, duration })
  } else if (failureRate > 0.5) {
    // >50% failure → real error
    const errorDetails = Object.entries(results)
      .filter(([, r]) => r.errors.length > 0)
      .map(([platform, r]) => ({ platform, failed: r.failed, errors: r.errors.slice(0, 10) }))
    await plog.error(
      new Error(`${totalFailed}/${totalEnriched + totalFailed} enrichments failed`),
      { period, duration, totalEnriched, totalFailed, errorDetails }
    )
  } else {
    // <50% failure → log as success with warning metadata
    await plog.success(totalEnriched, { period, duration, totalFailed, note: `${totalFailed} partial failures (acceptable)` })
  }

  return { ok: totalFailed === 0, duration, period, summary: { total, enriched: totalEnriched, failed: totalFailed, suppressedErrors: totalSuppressedErrors }, results }
}
