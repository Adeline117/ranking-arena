/**
 * 交易员详情抓取 Cron 端点 (Inline Version)
 *
 * GET /api/cron/fetch-details - 触发详情抓取
 *
 * 参数:
 * - source: 指定来源 (binance_futures, bybit, okx_futures, hyperliquid, gmx, aevo, bitget_futures, jupiter_perps)
 * - limit: 限制数量 (默认 200)
 * - concurrency: 并发数 (默认 10)
 * - skipRecent: 跳过最近 N 小时更新的 (默认 6)
 * - force: 强制更新所有
 * - tier: 指定活动层级 (hot, active, normal, dormant)
 */

import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { isAuthorized, createSupabaseAdmin, logCronExecution } from '@/lib/cron/utils'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { createScheduleManager } from '@/lib/services/schedule-manager'
import { ActivityTier } from '@/lib/services/smart-scheduler'
import { safeParseInt } from '@/lib/utils/safe-parse'
import {
  fetchBinanceEquityCurve,
  fetchBinancePositionHistory,
  fetchBinanceStatsDetail,
  fetchBybitEquityCurve,
  fetchBybitPositionHistory,
  fetchBybitStatsDetail,
  fetchOkxStatsDetail,
  fetchOkxCurrentPositions,
  fetchHyperliquidPositionHistory,
  fetchGmxPositionHistory,
  upsertEquityCurve,
  upsertPositionHistory,
  upsertStatsDetail,
} from '@/lib/cron/fetchers/enrichment'
import { createLogger } from '@/lib/utils/logger'
import { sleep } from '@/lib/cron/fetchers/shared'

const logger = createLogger('FetchDetails')

export const runtime = 'nodejs'
export const preferredRegion = 'hnd1' // Tokyo — avoids exchange geo-blocking
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Platforms that support enrichment
const ENRICHABLE_PLATFORMS = [
  'binance_futures',
  'bybit',
  'okx_futures',
  'hyperliquid',
  'gmx',
  'aevo',
  'jupiter_perps',
]

function isSmartSchedulerEnabled(): boolean {
  return process.env.ENABLE_SMART_SCHEDULER === 'true'
}

interface TraderToEnrich {
  source: string
  source_trader_id: string
}

interface TraderRow {
  platform: string
  trader_key: string
}

/**
 * Enrich a single trader based on platform
 */
async function enrichTrader(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  trader: TraderToEnrich
): Promise<{ success: boolean; error?: string }> {
  const { source, source_trader_id: traderId } = trader

  try {
    switch (source) {
      case 'binance_futures': {
        const [curve, positions, stats] = await Promise.all([
          fetchBinanceEquityCurve(traderId, 'QUARTERLY'),
          fetchBinancePositionHistory(traderId, 50),
          fetchBinanceStatsDetail(traderId),
        ])
        if (curve.length > 0) {
          await upsertEquityCurve(supabase, source, traderId, '90D', curve)
        }
        if (positions.length > 0) {
          await upsertPositionHistory(supabase, source, traderId, positions)
        }
        if (stats) {
          await upsertStatsDetail(supabase, source, traderId, '90D', stats)
        }
        return { success: true }
      }

      case 'bybit': {
        const [curve, positions, stats] = await Promise.all([
          fetchBybitEquityCurve(traderId, 90),
          fetchBybitPositionHistory(traderId, 50),
          fetchBybitStatsDetail(traderId),
        ])
        if (curve.length > 0) {
          await upsertEquityCurve(supabase, source, traderId, '90D', curve)
        }
        if (positions.length > 0) {
          await upsertPositionHistory(supabase, source, traderId, positions)
        }
        if (stats) {
          await upsertStatsDetail(supabase, source, traderId, '90D', stats)
        }
        return { success: true }
      }

      case 'okx_futures': {
        const [stats, positions] = await Promise.all([
          fetchOkxStatsDetail(traderId),
          fetchOkxCurrentPositions(traderId),
        ])
        if (stats) {
          await upsertStatsDetail(supabase, source, traderId, '90D', stats)
        }
        if (positions.length > 0) {
          await upsertPositionHistory(supabase, source, traderId, positions)
        }
        return { success: true }
      }

      case 'hyperliquid': {
        const positions = await fetchHyperliquidPositionHistory(traderId, 100)
        if (positions.length > 0) {
          await upsertPositionHistory(supabase, source, traderId, positions)
        }
        return { success: true }
      }

      case 'gmx': {
        const positions = await fetchGmxPositionHistory(traderId, 50)
        if (positions.length > 0) {
          await upsertPositionHistory(supabase, source, traderId, positions)
        }
        return { success: true }
      }

      // These platforms already enrich during their main fetch cycle
      // or don't have accessible position history APIs
      case 'aevo':
      case 'jupiter_perps': {
        return { success: true }
      }

      default:
        return { success: false, error: `Unsupported platform: ${source}` }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}

export async function GET(req: Request) {
  const startTime = Date.now()

  try {
    if (!isAuthorized(req)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

    const supabase = getSupabaseAdmin()

    // Parse params
    const requestUrl = new URL(req.url)
    const source = requestUrl.searchParams.get('source') || ''
    const limitParam = requestUrl.searchParams.get('limit') || '200'
    const concurrencyParam = requestUrl.searchParams.get('concurrency') || '10'
    const skipRecent = safeParseInt(requestUrl.searchParams.get('skipRecent'), 6)
    const force = requestUrl.searchParams.get('force') === 'true'
    const tierParam = requestUrl.searchParams.get('tier') as ActivityTier | null

    let limit = safeParseInt(limitParam, 200)
    let concurrency = safeParseInt(concurrencyParam, 10)
    let smartSchedulerUsed = false

    // Smart Scheduler integration
    if (isSmartSchedulerEnabled() && !force) {
      try {
        const scheduleManager = createScheduleManager()
        const tradersToRefresh = await scheduleManager.getTradersToRefresh({
          platform: source || undefined,
          limit: limit * 2,
          priorityOrder: true,
          includeOverdue: true,
          tiers: tierParam ? [tierParam] : undefined,
        })

        if (tradersToRefresh.length > 0) {
          smartSchedulerUsed = true
          limit = Math.min(limit, tradersToRefresh.length)
          const avgPriority =
            tradersToRefresh.reduce((sum, t) => sum + (t.refresh_priority || 30), 0) /
            tradersToRefresh.length

          if (avgPriority <= 15) concurrency = 20
          else if (avgPriority <= 25) concurrency = 15
          else if (avgPriority <= 35) concurrency = 10
          else concurrency = 5

          logger.info('Smart scheduler: adjusted parameters', {
            tradersToRefresh: tradersToRefresh.length,
            adjustedLimit: limit,
            adjustedConcurrency: concurrency,
            avgPriority,
          })
        }
      } catch (error: unknown) {
        logger.error('Smart scheduler failed, falling back to default', { error })
      }
    }

    // Query traders that need detail refresh
    const platforms = source
      ? [source]
      : ENRICHABLE_PLATFORMS

    const cutoffTime = new Date(Date.now() - skipRecent * 60 * 60 * 1000).toISOString()

    // traders table uses platform/trader_key columns (not source/source_trader_id)
    // Order by updated_at ascending so least-recently-updated get enriched first
    // Removed ORDER BY updated_at — causes statement timeout on large traders table.
    // The LIMIT + random platform shuffle gives adequate coverage without expensive sort.
    let baseQuery = supabase
      .from('traders')
      .select('platform, trader_key')
      .in('platform', platforms)
      .eq('is_active', true)
      .limit(limit)

    if (!force) {
      baseQuery = baseQuery.or(`last_seen_at.is.null,last_seen_at.lt.${cutoffTime}`)
    }

    const { data: rawTraders, error: fetchError } = await baseQuery

    if (fetchError) {
      // Provide a useful error message instead of "[object Object]"
      const errMsg = fetchError.message || JSON.stringify(fetchError)
      logger.error('Failed to query traders table', { error: errMsg, code: fetchError.code })
      throw new Error(`DB query failed: ${errMsg}`)
    }

    // Normalize to TraderToEnrich shape expected by enrichTrader()
    const traders: TraderToEnrich[] = (rawTraders || []).map((r: TraderRow) => ({
      source: r.platform,
      source_trader_id: r.trader_key,
    }))

    return await processTraders(supabase, traders, concurrency, startTime, source, limit, skipRecent, force, smartSchedulerUsed, tierParam)
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logger.error('执行失败', { error: errorMessage })
    return NextResponse.json({ ok: false, error: errorMessage }, { status: 500 })
  }
}

async function processTraders(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  traders: TraderToEnrich[],
  concurrency: number,
  startTime: number,
  source: string,
  limit: number,
  skipRecent: number,
  force: boolean,
  smartSchedulerUsed: boolean,
  tierParam: ActivityTier | null
) {
  let success = 0
  let failed = 0

  // Process in batches
  for (let i = 0; i < traders.length; i += concurrency) {
    const batch = traders.slice(i, i + concurrency)
    const results = await Promise.allSettled(
      batch.map(trader => enrichTrader(supabase, trader))
    )

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.success) {
        success++
      } else {
        failed++
        if (result.status === 'rejected') {
          logger.warn(`[fetch-details] enrichTrader rejected: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`)
        }
      }
    }

    // Rate limiting between batches
    if (i + concurrency < traders.length) {
      await sleep(500)
    }
  }

  // Batch update last_seen_at grouped by platform (1 query per platform instead of N per trader)
  try {
    const now = new Date().toISOString()
    const byPlatform = new Map<string, string[]>()
    for (const trader of traders) {
      const keys = byPlatform.get(trader.source) || []
      keys.push(trader.source_trader_id)
      byPlatform.set(trader.source, keys)
    }
    await Promise.all(
      Array.from(byPlatform.entries()).map(([platform, keys]) =>
        supabase
          .from('traders')
          .update({ last_seen_at: now } as Record<string, unknown>)
          .eq('platform', platform)
          .in('trader_key', keys)
      )
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn('Unexpected error updating last_seen_at after enrichment', { error: msg })
  }

  const duration = Date.now() - startTime

  // Log execution
  const adminSupabase = createSupabaseAdmin()
  const isSuccess = failed === 0 || success > failed
  await logCronExecution(adminSupabase, 'fetch-details', [
    {
      name: 'fetch_details_inline',
      success: isSuccess,
      output: `Processed ${traders.length} traders: ${success} success, ${failed} failed`,
      duration,
    },
  ])

  // Pipeline logging
  const plog = await PipelineLogger.start(`fetch-details-${tierParam || source || 'all'}`)
  if (failed > 0 && failed > success) {
    await plog.error(new Error(`${failed}/${traders.length} failed`), { success, failed })
  } else {
    await plog.success(success, { failed, total: traders.length })
  }

  return NextResponse.json({
    ok: isSuccess,
    ran_at: new Date().toISOString(),
    summary: {
      total: traders.length,
      success,
      failed,
      duration,
      params: { source, limit, concurrency, skipRecent, force },
      smartScheduler: smartSchedulerUsed
        ? { enabled: true, tier: tierParam || 'all' }
        : { enabled: false },
    },
  })
}
