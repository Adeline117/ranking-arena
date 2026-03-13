/**
 * Core enrichment logic extracted from /api/cron/enrich route.
 * Can be called inline from batch-enrich (no HTTP needed) or from the route.
 */

import { createClient } from '@supabase/supabase-js'
import {
  fetchBinanceEquityCurve,
  fetchBinanceStatsDetail,
  fetchBinancePositionHistory,
  // Bybit enrichment removed — api2.bybit.com endpoints return 404 globally (2026-03-10)
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
  fetchMexcEquityCurve,
  fetchMexcStatsDetail,
  fetchDriftPositionHistory,
  fetchDriftEquityCurve,
  fetchDriftStatsDetail,
  fetchDydxEquityCurve,
  fetchDydxStatsDetail,
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
} from '@/lib/cron/fetchers/enrichment'
import { sleep } from '@/lib/cron/fetchers/shared'
import { captureMessage } from '@/lib/utils/logger'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
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
  fetchCurrentPositions?: (traderId: string) => Promise<PositionHistoryItem[]>
  concurrency: number
  delayMs: number
}

export const ENRICHMENT_PLATFORM_CONFIGS: Record<string, EnrichmentConfig> = {
  binance_futures: {
    platform: 'binance_futures',
    fetchEquityCurve: async (traderId, days) => {
      const timeRangeMap: Record<number, 'WEEKLY' | 'MONTHLY' | 'QUARTERLY'> = { 7: 'WEEKLY', 30: 'MONTHLY', 90: 'QUARTERLY' }
      return fetchBinanceEquityCurve(traderId, timeRangeMap[days] || 'QUARTERLY')
    },
    fetchStatsDetail: fetchBinanceStatsDetail,
    fetchPositionHistory: fetchBinancePositionHistory,
    concurrency: 5, delayMs: 1000,
  },
  binance_spot: {
    platform: 'binance_spot',
    fetchEquityCurve: async (traderId, days) => {
      const timeRangeMap: Record<number, 'WEEKLY' | 'MONTHLY' | 'QUARTERLY'> = { 7: 'WEEKLY', 30: 'MONTHLY', 90: 'QUARTERLY' }
      return fetchBinanceEquityCurve(traderId, timeRangeMap[days] || 'QUARTERLY')
    },
    fetchStatsDetail: fetchBinanceStatsDetail,
    concurrency: 4, delayMs: 1200,
  },
  // bybit/bybit_spot: enrichment disabled — api2.bybit.com endpoints return 404 globally (2026-03-10)
  okx_futures: {
    platform: 'okx_futures',
    fetchEquityCurve: fetchOkxEquityCurve,
    fetchStatsDetail: fetchOkxStatsDetail,
    fetchPositionHistory: fetchOkxPositionHistory,
    fetchCurrentPositions: fetchOkxCurrentPositions,
    concurrency: 3, delayMs: 1500,
  },
  bitget_futures: {
    platform: 'bitget_futures',
    fetchEquityCurve: fetchBitgetEquityCurve,
    fetchStatsDetail: fetchBitgetStatsDetail,
    fetchPositionHistory: fetchBitgetPositionHistory,
    concurrency: 2, delayMs: 2000,
  },
  // bitget_spot: removed — no public API exists (all endpoints 404)
  hyperliquid: {
    platform: 'hyperliquid',
    fetchEquityCurve: fetchHyperliquidEquityCurve,
    fetchStatsDetail: fetchHyperliquidStatsDetail,
    fetchPositionHistory: fetchHyperliquidPositionHistory,
    concurrency: 3, delayMs: 500,
  },
  gmx: {
    platform: 'gmx',
    fetchEquityCurve: fetchGmxEquityCurve,
    fetchStatsDetail: fetchGmxStatsDetail,
    fetchPositionHistory: fetchGmxPositionHistory,
    concurrency: 15, // Increased from 2 - GraphQL endpoint is fast
    delayMs: 200, // Reduced from 1000ms (2026-03-11)
  },
  htx_futures: {
    platform: 'htx_futures',
    fetchEquityCurve: fetchHtxEquityCurve,
    fetchStatsDetail: fetchHtxStatsDetail,
    concurrency: 2, delayMs: 2000,
  },
  gateio: {
    platform: 'gateio',
    fetchEquityCurve: fetchGateioEquityCurve,
    fetchStatsDetail: fetchGateioStatsDetail,
    concurrency: 2, delayMs: 2000,
  },
  mexc: {
    platform: 'mexc',
    fetchEquityCurve: fetchMexcEquityCurve,
    fetchStatsDetail: fetchMexcStatsDetail,
    concurrency: 2, delayMs: 2000,
  },
  drift: {
    platform: 'drift',
    fetchEquityCurve: fetchDriftEquityCurve,
    fetchStatsDetail: fetchDriftStatsDetail,
    fetchPositionHistory: fetchDriftPositionHistory,
    concurrency: 2, delayMs: 1000,
  },
  dydx: {
    platform: 'dydx',
    fetchEquityCurve: fetchDydxEquityCurve,
    fetchStatsDetail: fetchDydxStatsDetail,
    concurrency: 3, delayMs: 500,
  },
  aevo: {
    platform: 'aevo',
    fetchEquityCurve: fetchAevoEquityCurve,
    fetchStatsDetail: fetchAevoStatsDetail,
    fetchPositionHistory: fetchAevoPositionHistory,
    concurrency: 2, delayMs: 1000,
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
export async function runEnrichment(params: {
  platform: string
  period: string
  limit: number
  offset?: number
}): Promise<EnrichmentResult> {
  const { platform: platformParam, period, limit, offset = 0 } = params
  const startTime = Date.now()
  const plog = await PipelineLogger.start(`enrich-${platformParam}`)

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!supabaseUrl || !supabaseKey) {
    await plog.error(new Error('Supabase env vars missing'))
    return { ok: false, duration: 0, period, summary: { total: 0, enriched: 0, failed: 0 }, results: {} }
  }
  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } })

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

    const { data: traders, error: fetchError } = await supabase
      .from('trader_snapshots')
      .select('source_trader_id')
      .eq('source', platformKey)
      .eq('season_id', period)
      .order('arena_score', { ascending: false })
      .range(offset, offset + limit - 1)

    if (fetchError || !traders) {
      results[platformKey].errors.push(`Failed to fetch traders: ${fetchError?.message}`)
      continue
    }

    logger.warn(`[enrich] Processing ${traders.length} ${platformKey} traders for ${period}`)

    for (let i = 0; i < traders.length; i += config.concurrency) {
      const batch = traders.slice(i, i + config.concurrency)

      const batchResults = await Promise.allSettled(
        batch.map(async (trader) => {
          const traderId = trader.source_trader_id
          // EMERGENCY FIX (2026-03-13): Add per-trader timeout to prevent slow traders from blocking batch
          // 2min timeout for Jupiter/DEX platforms with slow on-chain calls, prevents hung requests
          const traderTimeout = new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`Trader ${traderId} timed out after 2min`)), 120_000)
          )
          
          try {
            await Promise.race([
              (async () => {
                let curve: EquityCurvePoint[] = []

            if (config.fetchEquityCurve) {
              curve = await withRetry(() => config.fetchEquityCurve!(traderId, days), `${platformKey}:${traderId} equity curve`)
            }

            // Fallback: build equity curve from daily snapshots in our DB
            if (curve.length === 0) {
              curve = await buildEquityCurveFromSnapshots(supabase, platformKey, traderId, days)
            }

            if (curve.length > 0) {
              await withRetry(() => upsertEquityCurve(supabase, platformKey, traderId, period, curve), `${platformKey}:${traderId} save equity curve`)
            }

            if (config.fetchPositionHistory) {
              const positions = await withRetry(() => config.fetchPositionHistory!(traderId), `${platformKey}:${traderId} position history`)
              if (positions.length > 0) {
                await withRetry(() => upsertPositionHistory(supabase, platformKey, traderId, positions), `${platformKey}:${traderId} save position history`)
                // Compute and save asset breakdown from position history
                const breakdown = calculateAssetBreakdown(positions)
                if (breakdown.length > 0) {
                  await withRetry(() => upsertAssetBreakdown(supabase, platformKey, traderId, period, breakdown), `${platformKey}:${traderId} save asset breakdown`)
                }
              }
            }

            if (config.fetchCurrentPositions) {
              const currentPos = await withRetry(() => config.fetchCurrentPositions!(traderId), `${platformKey}:${traderId} current positions`)
              if (currentPos.length > 0) {
                await withRetry(
                  () => upsertPortfolio(supabase, platformKey, traderId,
                    currentPos.map((p) => ({ symbol: p.symbol, direction: p.direction, investedPct: null, entryPrice: p.entryPrice, pnl: p.pnlUsd }))),
                  `${platformKey}:${traderId} save current positions`
                )
              }
            }

            if (config.fetchStatsDetail) {
              let stats = await withRetry(() => config.fetchStatsDetail!(traderId), `${platformKey}:${traderId} stats detail`)
              if (stats) {
                if (curve.length > 0) {
                  stats = enhanceStatsWithDerivedMetrics(stats, curve, period)
                }
                await withRetry(() => upsertStatsDetail(supabase, platformKey, traderId, period, stats!), `${platformKey}:${traderId} save stats detail`)

                // Write win_rate and max_drawdown back to snapshot so leaderboard shows them
                const snapshotUpdate: Record<string, unknown> = {}
                if (stats.profitableTradesPct != null) snapshotUpdate.win_rate = stats.profitableTradesPct
                if (stats.maxDrawdown != null) snapshotUpdate.max_drawdown = stats.maxDrawdown
                if (stats.totalTrades != null) snapshotUpdate.trades_count = stats.totalTrades
                if (Object.keys(snapshotUpdate).length > 0) {
                  await supabase
                    .from('trader_snapshots')
                    .update(snapshotUpdate)
                    .eq('source', platformKey)
                    .eq('source_trader_id', traderId)
                    .eq('season_id', period)
                }
              }
            }

            // On-chain wallet enrichment for DEX platforms (AUM + portfolio)
            if (isDexPlatform(platformKey)) {
              try {
                const walletAum = await fetchWalletAUM(platformKey, traderId)
                if (walletAum != null && walletAum > 10) {
                  // Update AUM in stats_detail
                  await supabase
                    .from('trader_stats_detail')
                    .update({ aum: walletAum })
                    .eq('source', platformKey)
                    .eq('source_trader_id', traderId)
                    .eq('season_id', period)

                  // Also save on-chain portfolio if no current positions exist
                  if (!config.fetchCurrentPositions) {
                    const walletPortfolio = await fetchWalletPortfolio(platformKey, traderId)
                    if (walletPortfolio.length > 0) {
                      await upsertPortfolio(supabase, platformKey, traderId, walletPortfolio)
                    }
                  }
                }
              } catch {
                // Non-critical — wallet enrichment failure shouldn't block
              }
            }

                results[platformKey].enriched++
              })(),
              traderTimeout
            ])
          } catch (err) {
            results[platformKey].failed++
            const errMsg = err instanceof Error ? err.message : String(err)
            if (results[platformKey].errors.length < 5) {
              results[platformKey].errors.push(`${traderId}: ${errMsg}`)
            }
            throw err // Re-throw to be caught by allSettled
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
