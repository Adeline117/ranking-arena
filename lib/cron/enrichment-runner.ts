/**
 * Core enrichment logic extracted from /api/cron/enrich route.
 * Can be called inline from batch-enrich (no HTTP needed) or from the route.
 */

import { validatePlatform } from '@/lib/config/platforms'
import { getSupabaseAdmin } from '@/lib/supabase/server'
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
  fetchHyperliquidEquityCurve,
  fetchHyperliquidStatsDetail,
  fetchGmxPositionHistory,
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
  fetchBlofinEquityCurve,
  fetchBlofinStatsDetail,
  fetchPhemexEquityCurve,
  fetchPhemexStatsDetail,
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
  classifyTradingStyle,
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
import {
  fetchWeexEquityCurve,
  fetchWeexStatsDetail,
} from '@/lib/cron/fetchers/enrichment-weex'
import {
  fetchKucoinEquityCurve,
  fetchKucoinStatsDetail,
} from '@/lib/cron/fetchers/enrichment-kucoin'
import { sleep } from '@/lib/cron/fetchers/shared'
import { captureMessage } from '@/lib/utils/logger'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { LR, V2 } from '@/lib/types/schema-mapping'

// EMERGENCY FIX (2026-03-20): Reduce retries to prevent timeout bypass
// Root cause of 44min hangs: withRetry creates new fetch+AbortController on each retry,
// bypassing per-trader/platform timeouts. 3 retries × 6s timeout × N APIs = >54s per trader.
// Solution: 1 retry max → total time ≤ 12s per API, respects per-trader timeout.
const RETRY_CONFIG = {
  maxAttempts: 1, // Was 3 — NO retries, fail fast
  baseDelayMs: 500, // Reduced from 1000
  maxDelayMs: 2000, // Reduced from 10000
}

async function withRetry<T>(
  fn: () => Promise<T>,
  context: string,
  options = RETRY_CONFIG
): Promise<T> {
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
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

    if (error || !data || data.length < 2) return []

    return data.map((row: { date: string; roi: number | null; pnl: number | null }) => ({
      date: row.date,
      roi: row.roi ?? 0,
      pnl: row.pnl ?? null,
    }))
  } catch {
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
    concurrency: 10, delayMs: 500, // Increased from 5/1000 for higher throughput
  },
  // binance_spot: PERMANENTLY REMOVED (2026-03-14) - repeatedly hangs 45-76min, blocks entire pipeline
  // Bybit enrichment re-enabled (2026-03-18) — routes through VPS scraper
  bybit: {
    platform: 'bybit',
    fetchEquityCurve: fetchBybitEquityCurve,
    fetchStatsDetail: fetchBybitStatsDetail,
    concurrency: 1, delayMs: 3000, // VPS scraper is serial (Playwright), go slow
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
  weex: {
    platform: 'weex',
    fetchEquityCurve: fetchWeexEquityCurve,
    fetchStatsDetail: fetchWeexStatsDetail,
    concurrency: 1, delayMs: 3000, // VPS scraper is slow, one at a time
  },
  kucoin: {
    platform: 'kucoin',
    fetchEquityCurve: fetchKucoinEquityCurve,
    fetchStatsDetail: fetchKucoinStatsDetail,
    concurrency: 1, delayMs: 3000, // VPS scraper is serial (Playwright)
  },
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
  // bitget_spot: enrichment not yet configured — spot-specific enrichment endpoints TBD
  hyperliquid: {
    platform: 'hyperliquid',
    fetchEquityCurve: fetchHyperliquidEquityCurve,
    fetchStatsDetail: fetchHyperliquidStatsDetail,
    fetchPositionHistory: fetchHyperliquidPositionHistory,
    concurrency: 10, delayMs: 200, // No rate limit, fast API
  },
  gmx: {
    platform: 'gmx',
    fetchEquityCurve: fetchGmxEquityCurve,
    fetchStatsDetail: fetchGmxStatsDetail,
    fetchPositionHistory: fetchGmxPositionHistory,
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
    concurrency: 5, delayMs: 800,
  },
  mexc: {
    platform: 'mexc',
    fetchEquityCurve: fetchMexcEquityCurve,
    fetchStatsDetail: fetchMexcStatsDetail,
    concurrency: 5, delayMs: 800,
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
    concurrency: 8, delayMs: 300, // Increased: public API, fast
  },
  dydx: {
    platform: 'dydx',
    fetchEquityCurve: fetchDydxEquityCurve,
    fetchStatsDetail: fetchDydxStatsDetail,
    fetchPositionHistory: fetchDydxV4PositionHistory,
    concurrency: 8, delayMs: 300, // Increased: indexer API is fast
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
    concurrency: 3, delayMs: 300,
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
    concurrency: 5, delayMs: 800,
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
    concurrency: 20, delayMs: 0, // Batch-cached from public traders list
  },
  phemex: {
    platform: 'phemex',
    fetchEquityCurve: fetchPhemexEquityCurve,
    fetchStatsDetail: fetchPhemexStatsDetail,
    concurrency: 1, delayMs: 3000, // Phemex has strict rate limits
  },
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
}

export interface EnrichmentResult {
  ok: boolean
  duration: number
  period: string
  summary: { total: number; enriched: number; failed: number }
  results: Record<string, { enriched: number; failed: number; errors: string[] }>
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
  // Dead platforms — 0 traders, no data to enrich
  'bitmart', 'paradex', 'lbank',
  // Leaderboard-only platforms — all metrics already from normalize(), no separate detail API
  // Equity curves auto-generated from daily snapshots by aggregate-daily-snapshots cron
  'bybit_spot',   // metricValues has ROI/WR/MDD/Sharpe, VPS trader-detail doesn't support spot leaderMark
  'binance_web3', // wallet-based, no per-trader detail API, all metrics from leaderboard
  'web3_bot',     // small platform (19 traders), all metrics from leaderboard
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
  // Batch-cached: instant, but set generous limit
  'bitunix': 30_000, 'xt': 30_000, 'blofin': 60_000,
  'bitfinex': 60_000, 'toobit': 60_000, 'coinex': 60_000,
}
const DEFAULT_PLATFORM_TIMEOUT_MS = 120_000  // 2min for CEX (was 45s)
const ONCHAIN_PLATFORM_TIMEOUT_MS = 180_000  // 3min for onchain (was 90s)
const ONCHAIN_SET = new Set(['gmx', 'dydx', 'jupiter_perps', 'hyperliquid', 'drift', 'aevo', 'gains', 'kwenta'])

// Per-trader timeout: ultra-aggressive timeout for platforms that hang
// 2026-03-21: Reduced binance_futures from 20s→12s after VPS proxy testing showed <500ms responses
const PER_TRADER_TIMEOUT_MS: Record<string, number> = {
  'bitget_futures': 18_000,  // 18s per trader - equity 15s + detail 10s run in parallel, 18s is generous
  'binance_futures': 12_000, // 12s per trader - ultra-short (VPS proxy tested <500ms, 3-8s API timeouts)
}

function getPlatformTimeout(platform: string): number {
  return PLATFORM_TIMEOUT_MS[platform] ?? (ONCHAIN_SET.has(platform) ? ONCHAIN_PLATFORM_TIMEOUT_MS : DEFAULT_PLATFORM_TIMEOUT_MS)
}

export async function runEnrichment(params: {
  platform: string
  period: string
  limit: number
  offset?: number
}): Promise<EnrichmentResult> {
  const { platform: platformParam, period, limit, offset = 0 } = params
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
    return { ok: true, duration: 0, period, summary: { total: 0, enriched: 0, failed: 0 }, results: {} }
  }

  const supabase = getSupabaseAdmin()

  const platforms = [platformParam].filter((p) => p in ENRICHMENT_PLATFORM_CONFIGS)
  if (platforms.length === 0) {
    await plog.error(new Error(`Unknown platform: ${platformParam}`))
    return { ok: false, duration: 0, period, summary: { total: 0, enriched: 0, failed: 0 }, results: {} }
  }

  const daysMap: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }
  const days = daysMap[period] || 90

  const results: Record<string, { enriched: number; failed: number; errors: string[] }> = {}

  for (const platformKey of platforms) {
    const config = ENRICHMENT_PLATFORM_CONFIGS[platformKey]
    if (!config) continue

    results[platformKey] = { enriched: 0, failed: 0, errors: [] }
    let walletEnrichFailCount = 0

    // Per-platform timeout: isolate each platform so one hanging platform
    // doesn't burn the entire batch's time budget
    const platformTimeoutMs = getPlatformTimeout(platformKey)
    const platformStart = Date.now()
    const platformController = new AbortController()
    const platformTimer = setTimeout(() => platformController.abort(), platformTimeoutMs)

    try {
      await Promise.race([
        (async () => {
    // Read from leaderboard_ranks (canonical, has latest trader keys)
    // Previously read from trader_snapshots v1, which has stale keys
    // (e.g., Binance migrated from encryptedUid to leadPortfolioId)
    // LR columns: source → platform, source_trader_id → traderKey, season_id → period
    const { data: traders, error: fetchError } = await supabase
      .from('leaderboard_ranks')
      .select(LR.source_trader_id)
      .eq(LR.source, platformKey)
      .eq(LR.season_id, period)
      .not(LR.arena_score, 'is', null)
      .order(LR.arena_score, { ascending: false })
      .range(offset, offset + limit - 1)

    if (fetchError || !traders) {
      results[platformKey].errors.push(`Failed to fetch traders: ${fetchError?.message}`)
      return
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
            logger.warn(`[enrich] ${platformKey}/${traderId} timeout after ${traderTimeoutMs / 1000}s`)
            traderController.abort()
          }, traderTimeoutMs)
          // Cascade: if platform aborts, abort all its traders
          const onPlatformAbort = () => traderController.abort()
          platformController.signal.addEventListener('abort', onPlatformAbort, { once: true })

          try {
            await Promise.race([
              (async () => {
                // --- Phase 1: Parallel API fetches (independent network calls) ---
                const fetchPromises: Record<string, Promise<unknown>> = {}

                // Equity curve fetch
                if (config.fetchEquityCurve) {
                  fetchPromises.equityCurve = withRetry(
                    () => config.fetchEquityCurve!(traderId, days),
                    `${platformKey}:${traderId} equity curve`
                  ).catch(() => [] as EquityCurvePoint[])
                }

                // Position history fetch
                if (config.fetchPositionHistory) {
                  fetchPromises.positions = withRetry(
                    () => config.fetchPositionHistory!(traderId),
                    `${platformKey}:${traderId} position history`
                  ).catch(() => [] as PositionHistoryItem[])
                }

                // Current positions fetch
                if (config.fetchCurrentPositions) {
                  fetchPromises.currentPositions = withRetry(
                    () => config.fetchCurrentPositions!(traderId),
                    `${platformKey}:${traderId} current positions`
                  ).catch(() => [] as (PortfolioPosition | PositionHistoryItem)[])
                }

                // Stats detail fetch
                if (config.fetchStatsDetail) {
                  fetchPromises.stats = withRetry(
                    () => config.fetchStatsDetail!(traderId),
                    `${platformKey}:${traderId} stats detail`
                  ).catch(() => null as StatsDetail | null)
                }

                // DEX wallet AUM fetch (optional, failures swallowed)
                if (isDexPlatform(platformKey)) {
                  fetchPromises.walletAum = fetchWalletAUM(platformKey, traderId).catch(() => null)
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
                if (curve.length === 0) {
                  curve = await buildEquityCurveFromSnapshots(supabase, platformKey, traderId, days)
                }

                // --- Phase 3: Sequential DB writes (depend on fetch results) ---
                if (curve.length > 0) {
                  await withRetry(() => upsertEquityCurve(supabase, platformKey, traderId, period, curve), `${platformKey}:${traderId} save equity curve`)
                }

                if (config.fetchPositionHistory && positions.length > 0) {
                  await withRetry(() => upsertPositionHistory(supabase, platformKey, traderId, positions), `${platformKey}:${traderId} save position history`)
                  const breakdown = calculateAssetBreakdown(positions)
                  if (breakdown.length > 0) {
                    await withRetry(() => upsertAssetBreakdown(supabase, platformKey, traderId, period, breakdown), `${platformKey}:${traderId} save asset breakdown`)
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
                    `${platformKey}:${traderId} save current positions`
                  )
                }

                if (config.fetchStatsDetail && stats) {
                  // Pass position history to derive avg_holding_hours, avg_profit/loss, etc.
                  stats = enhanceStatsWithDerivedMetrics(stats, curve, period, positions.length > 0 ? positions : undefined)
                  await withRetry(() => upsertStatsDetail(supabase, platformKey, traderId, period, stats!), `${platformKey}:${traderId} save stats detail`)
                }

                // Always sync key metrics back to trader_snapshots_v2 from stats + equity curve.
                // This ensures new traders are immediately complete without waiting for daily cron.
                {
                  const snapshotUpdate: Record<string, unknown> = {}
                  if (stats?.profitableTradesPct != null) snapshotUpdate.win_rate = stats.profitableTradesPct
                  if (stats?.maxDrawdown != null) snapshotUpdate.max_drawdown = stats.maxDrawdown
                  if (stats?.totalTrades != null) snapshotUpdate.trades_count = stats.totalTrades
                  if (stats?.sharpeRatio != null) snapshotUpdate.sharpe_ratio = stats.sharpeRatio

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
                    if (!snapshotUpdate.sharpe_ratio && curve.length >= 7) {
                      const returns: number[] = []
                      for (let j = 1; j < curve.length; j++) {
                        if (curve[j].roi != null && curve[j - 1].roi != null) {
                          returns.push(curve[j].roi! - curve[j - 1].roi!)
                        }
                      }
                      if (returns.length >= 5) {
                        const mean = returns.reduce((a, b) => a + b, 0) / returns.length
                        const std = Math.sqrt(returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length)
                        if (std > 0) snapshotUpdate.sharpe_ratio = Math.round((mean / std) * Math.sqrt(365) * 100) / 100
                      }
                    }
                    // Win rate from daily returns if not from stats
                    if (!snapshotUpdate.win_rate && curve.length >= 5) {
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
                    // Max drawdown from equity curve if not from stats
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

                  // Only write non-null updates, and only overwrite NULL fields in snapshot
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
                    .eq('season_id', period)
                  if (aumErr) {
                    logger.warn(`[enrich] AUM update failed for ${platformKey}/${traderId}: ${aumErr.message}`)
                  }

                  if (!config.fetchCurrentPositions) {
                    try {
                      const walletPortfolio = await fetchWalletPortfolio(platformKey, traderId)
                      if (walletPortfolio.length > 0) {
                        await upsertPortfolio(supabase, platformKey, traderId, walletPortfolio)
                      }
                    } catch {
                      walletEnrichFailCount++
                    }
                  }
                }

                results[platformKey].enriched++
              })(),
              new Promise<void>((_, reject) => {
                if (traderController.signal.aborted) return reject(new Error(`Trader ${traderId} timed out after ${traderTimeoutMs / 1000}s`))
                traderController.signal.addEventListener('abort', () =>
                  reject(new Error(`Trader ${traderId} timed out after ${traderTimeoutMs / 1000}s`)), { once: true })
              })
            ])
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
        })(),
        new Promise<void>((_, reject) => {
          if (platformController.signal.aborted) return reject(new Error(`Platform ${platformKey} timed out after ${platformTimeoutMs / 1000}s`))
          platformController.signal.addEventListener('abort', () =>
            reject(new Error(`Platform ${platformKey} timed out after ${platformTimeoutMs / 1000}s`)), { once: true })
        }),
      ])
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error(`[enrich] Platform ${platformKey} failed/timed out: ${errMsg}`)
      results[platformKey].errors.push(errMsg)
      // Continue to next platform - don't let one platform block others
    } finally {
      clearTimeout(platformTimer)
      platformController.abort() // Clean up any lingering trader work on platform completion/timeout
    }

    if (walletEnrichFailCount > 0) {
      logger.warn(`[Enrichment] ${walletEnrichFailCount} wallet enrichments failed for ${platformKey}`)
    }
  }

  const duration = Date.now() - startTime
  const totalEnriched = Object.values(results).reduce((sum, r) => sum + r.enriched, 0)
  const totalFailed = Object.values(results).reduce((sum, r) => sum + r.failed, 0)

  logger.warn(`[enrich] Completed in ${duration}ms: ${totalEnriched} enriched, ${totalFailed} failed`)

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
  } else {
    await plog.error(new Error(`${totalFailed}/${totalEnriched + totalFailed} enrichments failed`), { period, duration, totalEnriched, totalFailed })
  }

  return { ok: totalFailed === 0, duration, period, summary: { total, enriched: totalEnriched, failed: totalFailed }, results }
}
