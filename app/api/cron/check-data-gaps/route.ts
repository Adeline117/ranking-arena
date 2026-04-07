/**
 * Data Gap Analysis API
 *
 * Analyzes data completeness across all exchanges and time periods.
 * Returns a detailed report of missing data for each exchange.
 *
 * Optimized 2026-04-07: Previous version ran 700+ sequential count queries
 * (22 platforms × 32 queries each) causing 80+ minute hangs.
 * Now: parallel batches of 5 platforms, simplified queries, 100s safety timeout.
 *
 * Query params:
 *   platform: Filter by specific platform (optional)
 *   detailed: Include trader-level details (default: false)
 */

import { NextRequest, NextResponse } from 'next/server'
import { logger } from '@/lib/logger'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { env } from '@/lib/env'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// Only active platforms — removed dead ones (lbank, phemex, bingx, bitget_spot, kucoin)
const ALL_PLATFORMS = [
  'binance_futures',
  'bybit',
  'bybit_spot',
  'okx_futures',
  'hyperliquid',
  'gmx',
  'mexc',
  'dydx',
  'gains',
  'jupiter_perps',
  'aevo',
  'coinex',
  'xt',
  'blofin',
  'gateio',
  'weex',
  'htx_futures',
  'bitunix',
  'bitget_futures',
]

const TIME_PERIODS = ['7D', '30D', '90D']

interface PlatformGapReport {
  platform: string
  totalTraders: number
  periodCounts: Record<string, number>
  enrichmentCounts: {
    equityCurve90D: number
    statsDetail90D: number
    positionHistory: number
  }
  missingPeriods: {
    missing7D: number
    missing30D: number
    missing90D: number
  }
}

function isAuthorized(req: Request): boolean {
  const secret = env.CRON_SECRET
  if (!secret) return false
  const authHeader = req.headers.get('authorization')
  return authHeader === `Bearer ${secret}`
}

async function analyzePlatform(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  platform: string
): Promise<PlatformGapReport | null> {
  // Get trader count
  const { count: totalTraders, error: tradersError } = await supabase
    .from('trader_sources')
    .select('*', { count: 'exact', head: true })
    .eq('source', platform)

  if (tradersError) {
    logger.warn(`Failed to get traders for ${platform}`, { error: tradersError.message })
    return null
  }

  const total = totalTraders || 0

  // Get snapshot counts per period — run sequentially to avoid parallel DB pressure
  // Each count query can be heavy on trader_snapshots_v2 (millions of rows)
  const periodCounts: Record<string, number> = {}
  for (const period of TIME_PERIODS) {
    try {
      const { count, error } = await supabase
        .from('trader_snapshots_v2')
        .select('*', { count: 'exact', head: true })
        .eq('platform', platform)
        .eq('window', period)
      if (error) {
        logger.warn(`[check-data-gaps] ${platform} ${period} snapshot count error: ${error.message}`)
        periodCounts[period] = 0
      } else {
        periodCounts[period] = count || 0
      }
    } catch (err) {
      logger.warn(`[check-data-gaps] ${platform} ${period} snapshot count failed: ${err}`)
      periodCounts[period] = 0
    }
  }

  // Get enrichment counts for 90D only (most important) + position history
  // Run sequentially to avoid parallel DB pressure on large tables
  let equityCurve90D = 0
  let statsDetail90D = 0
  let positionHistory = 0

  try {
    const curve90D = await supabase.from('trader_equity_curve').select('*', { count: 'exact', head: true })
      .eq('source', platform).eq('period', '90D')
    equityCurve90D = curve90D.count || 0
  } catch (err) {
    logger.warn(`[check-data-gaps] ${platform} equity_curve count failed: ${err}`)
  }

  try {
    const stats90D = await supabase.from('trader_stats_detail').select('*', { count: 'exact', head: true })
      .eq('source', platform).eq('period', '90D')
    statsDetail90D = stats90D.count || 0
  } catch (err) {
    logger.warn(`[check-data-gaps] ${platform} stats_detail count failed: ${err}`)
  }

  try {
    const positions = await supabase.from('trader_position_history').select('*', { count: 'exact', head: true })
      .eq('source', platform)
    positionHistory = positions.count || 0
  } catch (err) {
    logger.warn(`[check-data-gaps] ${platform} position_history count failed: ${err}`)
  }

  return {
    platform,
    totalTraders: total,
    periodCounts,
    enrichmentCounts: {
      equityCurve90D,
      statsDetail90D,
      positionHistory,
    },
    missingPeriods: {
      missing7D: Math.max(0, total - (periodCounts['7D'] || 0)),
      missing30D: Math.max(0, total - (periodCounts['30D'] || 0)),
      missing90D: Math.max(0, total - (periodCounts['90D'] || 0)),
    },
  }
}

export async function GET(req: NextRequest) {
  const startTime = Date.now()

  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()

  const platformParam = req.nextUrl.searchParams.get('platform')

  const platforms = platformParam
    ? [platformParam].filter((p) => ALL_PLATFORMS.includes(p))
    : ALL_PLATFORMS

  const plog = await PipelineLogger.start('check-data-gaps')

  // Time budget: stop after 90s (leave 30s buffer for maxDuration=120)
  const TIME_BUDGET_MS = 90_000

  const reports: PlatformGapReport[] = []
  const failedPlatforms: string[] = []
  const skippedPlatforms: string[] = []
  const summary = {
    totalTraders: 0,
    totalGaps: 0,
    platformsWithIssues: [] as string[],
    platformsAnalyzed: 0,
  }

  // Process platforms in batches of 2 (reduced from 5 to avoid DB connection pressure)
  const BATCH_SIZE = 2
  let timedOut = false
  for (let i = 0; i < platforms.length; i += BATCH_SIZE) {
    const elapsed = Date.now() - startTime
    if (elapsed > TIME_BUDGET_MS) {
      const remaining = platforms.slice(i).map(p => p)
      skippedPlatforms.push(...remaining)
      timedOut = true
      logger.warn(`[check-data-gaps] Time budget exceeded at ${Math.round(elapsed / 1000)}s, skipping ${remaining.length} platforms: ${remaining.join(', ')}`)
      break
    }

    const batch = platforms.slice(i, i + BATCH_SIZE)
    const batchResults = await Promise.allSettled(
      batch.map(platform => analyzePlatform(supabase, platform))
    )

    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j]
      if (result.status === 'fulfilled' && result.value) {
        const report = result.value
        reports.push(report)
        summary.totalTraders += report.totalTraders
        summary.totalGaps += report.missingPeriods.missing7D + report.missingPeriods.missing30D + report.missingPeriods.missing90D

        const expectedEnrichment = Math.min(report.totalTraders, 300)
        const hasIssues =
          report.missingPeriods.missing7D > report.totalTraders * 0.3 ||
          report.missingPeriods.missing90D > report.totalTraders * 0.3 ||
          report.enrichmentCounts.equityCurve90D < expectedEnrichment * 0.5

        if (hasIssues) {
          summary.platformsWithIssues.push(report.platform)
        }
      } else if (result.status === 'rejected') {
        failedPlatforms.push(batch[j])
        logger.warn(`[check-data-gaps] Platform ${batch[j]} analysis failed: ${result.reason}`)
      }
    }
    summary.platformsAnalyzed = reports.length
  }

  const duration = Date.now() - startTime

  const hasPartialResults = timedOut || failedPlatforms.length > 0
  if (hasPartialResults) {
    await plog.partialSuccess(
      reports.length,
      [...skippedPlatforms.map(p => `skipped:${p}`), ...failedPlatforms.map(p => `failed:${p}`)],
      { summary, timedOut, skippedPlatforms, failedPlatforms }
    )
  } else {
    await plog.success(reports.length, { summary })
  }

  return NextResponse.json({
    ok: true,
    duration,
    timedOut,
    skippedPlatforms: skippedPlatforms.length > 0 ? skippedPlatforms : undefined,
    failedPlatforms: failedPlatforms.length > 0 ? failedPlatforms : undefined,
    summary,
    reports: reports.map((r) => ({
      platform: r.platform,
      totalTraders: r.totalTraders,
      periodCounts: r.periodCounts,
      enrichmentCounts: r.enrichmentCounts,
      missingPeriods: r.missingPeriods,
    })),
  })
}
