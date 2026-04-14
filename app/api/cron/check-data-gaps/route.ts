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
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

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
  return verifyCronSecret(req)
}

async function analyzePlatform(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  platform: string
): Promise<PlatformGapReport | null> {
  // Use count: 'estimated' (pg_class.reltuples, near-instant, ~5% accurate)
  // instead of 'exact' — this job is a gap-report health check, not a
  // financial audit. 6 x exact counts on multi-million row tables per
  // platform × 19 platforms was blowing the 120s maxDuration.
  const { count: totalTraders, error: tradersError } = await supabase
    .from('trader_sources')
    .select('*', { count: 'estimated', head: true })
    .eq('source', platform)

  if (tradersError) {
    logger.warn(`Failed to get traders for ${platform}`, { error: tradersError.message })
    return null
  }

  const total = totalTraders || 0

  // Get snapshot counts per period — run in parallel (safe now that we use
  // estimated counts which don't lock large portions of the table).
  const periodCounts: Record<string, number> = {}
  const periodResults = await Promise.all(TIME_PERIODS.map(async (period) => {
    try {
      const { count, error } = await supabase
        .from('trader_snapshots_v2')
        .select('*', { count: 'estimated', head: true })
        .eq('platform', platform)
        .eq('window', period)
      if (error) {
        logger.warn(`[check-data-gaps] ${platform} ${period} snapshot count error: ${error.message}`)
        return [period, 0] as const
      }
      return [period, count || 0] as const
    } catch (err) {
      logger.warn(`[check-data-gaps] ${platform} ${period} snapshot count failed: ${err}`)
      return [period, 0] as const
    }
  }))
  for (const [period, c] of periodResults) periodCounts[period] = c

  // Get enrichment counts for 90D only (most important) + position history
  // Run in parallel (estimated counts are cheap enough to parallelize).
  const [equityCurve90D, statsDetail90D, positionHistory] = await Promise.all([
    (async () => {
      try {
        const r = await supabase.from('trader_equity_curve').select('*', { count: 'estimated', head: true })
          .eq('source', platform).eq('period', '90D')
        return r.count || 0
      } catch (err) {
        logger.warn(`[check-data-gaps] ${platform} equity_curve count failed: ${err}`)
        return 0
      }
    })(),
    (async () => {
      try {
        const r = await supabase.from('trader_stats_detail').select('*', { count: 'estimated', head: true })
          .eq('source', platform).eq('period', '90D')
        return r.count || 0
      } catch (err) {
        logger.warn(`[check-data-gaps] ${platform} stats_detail count failed: ${err}`)
        return 0
      }
    })(),
    (async () => {
      try {
        const r = await supabase.from('trader_position_history').select('*', { count: 'estimated', head: true })
          .eq('source', platform)
        return r.count || 0
      } catch (err) {
        logger.warn(`[check-data-gaps] ${platform} position_history count failed: ${err}`)
        return 0
      }
    })(),
  ])

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
