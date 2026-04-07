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

  // Get snapshot counts per period (3 queries in parallel)
  const periodCountResults = await Promise.all(
    TIME_PERIODS.map(period =>
      supabase
        .from('trader_snapshots_v2')
        .select('*', { count: 'exact', head: true })
        .eq('platform', platform)
        .eq('window', period)
    )
  )

  const periodCounts: Record<string, number> = {}
  TIME_PERIODS.forEach((period, i) => {
    periodCounts[period] = periodCountResults[i].count || 0
  })

  // Get enrichment counts for 90D only (most important) + position history
  const [curve90D, stats90D, positions] = await Promise.all([
    supabase.from('trader_equity_curve').select('*', { count: 'exact', head: true })
      .eq('source', platform).eq('period', '90D'),
    supabase.from('trader_stats_detail').select('*', { count: 'exact', head: true })
      .eq('source', platform).eq('period', '90D'),
    supabase.from('trader_position_history').select('*', { count: 'exact', head: true })
      .eq('source', platform),
  ])

  return {
    platform,
    totalTraders: total,
    periodCounts,
    enrichmentCounts: {
      equityCurve90D: curve90D.count || 0,
      statsDetail90D: stats90D.count || 0,
      positionHistory: positions.count || 0,
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

  // Safety timeout: log partial results before Vercel kills us
  let timedOut = false
  const safetyTimer = setTimeout(() => { timedOut = true }, 100_000) // 100s for 120s maxDuration

  const reports: PlatformGapReport[] = []
  const summary = {
    totalTraders: 0,
    totalGaps: 0,
    platformsWithIssues: [] as string[],
    platformsAnalyzed: 0,
  }

  // Process platforms in parallel batches of 5 (was sequential before)
  const BATCH_SIZE = 5
  for (let i = 0; i < platforms.length; i += BATCH_SIZE) {
    if (timedOut) {
      logger.warn(`[check-data-gaps] Safety timeout at ${Math.round((Date.now() - startTime) / 1000)}s, ${i}/${platforms.length} platforms analyzed`)
      break
    }

    const batch = platforms.slice(i, i + BATCH_SIZE)
    const batchResults = await Promise.allSettled(
      batch.map(platform => analyzePlatform(supabase, platform))
    )

    for (const result of batchResults) {
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
      }
    }
    summary.platformsAnalyzed = reports.length
  }

  clearTimeout(safetyTimer)
  const duration = Date.now() - startTime

  await plog.success(reports.length, { summary, timedOut })

  return NextResponse.json({
    ok: true,
    duration,
    timedOut,
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
