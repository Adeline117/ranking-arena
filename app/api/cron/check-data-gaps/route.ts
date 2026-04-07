/**
 * Data Gap Analysis API
 *
 * Analyzes data completeness across all exchanges and time periods.
 * Returns a detailed report of missing data for each exchange.
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

const ALL_PLATFORMS = [
  'binance_futures',
  // 'binance_spot', — REMOVED 2026-03-14: repeatedly hangs 45-76min
  'bybit',
  'bybit_spot',
  'okx_futures',
  'bitget_spot',
  'hyperliquid',
  'gmx',
  'mexc',
  // 'kucoin', — DEAD
  'dydx',
  'gains',
  'jupiter_perps',
  'aevo',
  'coinex',
  'xt',
  'lbank',
  'blofin',
  'bingx',
  'gateio',
  'phemex',
  'weex',
  'htx_futures',
]

const TIME_PERIODS = ['7D', '30D', '90D']

interface PlatformGapReport {
  platform: string
  totalTraders: number
  periodCoverage: Record<
    string,
    {
      count: number
      missingRoi: number
      missingPnl: number
      missingWinRate: number
      missingDrawdown: number
      missingFollowers: number
    }
  >
  enrichmentCoverage: {
    equityCurve: Record<string, number>
    statsDetail: Record<string, number>
    positionHistory: number
    assetBreakdown: Record<string, number>
  }
  missingPeriods: {
    missing7D: number
    missing30D: number
    missing90D: number
    missingAll3: number
  }
}

function isAuthorized(req: Request): boolean {
  const secret = env.CRON_SECRET
  if (!secret) return false

  const authHeader = req.headers.get('authorization')
  return authHeader === `Bearer ${secret}`
}

export async function GET(req: NextRequest) {
  const startTime = Date.now()

  if (!isAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = getSupabaseAdmin()

  const platformParam = req.nextUrl.searchParams.get('platform')
  const detailed = req.nextUrl.searchParams.get('detailed') === 'true'

  const platforms = platformParam
    ? [platformParam].filter((p) => ALL_PLATFORMS.includes(p))
    : ALL_PLATFORMS

  const reports: PlatformGapReport[] = []
  const summary = {
    totalTraders: 0,
    totalGaps: 0,
    missingPeriodGaps: 0,
    missingEnrichmentGaps: 0,
    platformsWithIssues: [] as string[],
  }

  const plog = await PipelineLogger.start('check-data-gaps')

  for (const platform of platforms) {
    try {
      // Get unique traders for this platform
      const { data: traders, error: tradersError } = await supabase
        .from('trader_sources')
        .select('source_trader_id')
        .eq('source', platform)

      if (tradersError) {
        logger.warn(`Failed to get traders for ${platform}`, { error: tradersError.message })
        continue
      }

      const totalTraders = traders?.length || 0
      const traderIds = traders?.map((t) => t.source_trader_id) || []

      // Check snapshots for each period — use count queries instead of full selects
      // Previous version fetched ALL rows (100K+ for large platforms), causing 65min+ hangs
      const periodCoverage: PlatformGapReport['periodCoverage'] = {}

      for (const period of TIME_PERIODS) {
        // Total count for this platform/period
        const { count: totalCount } = await supabase
          .from('trader_snapshots_v2')
          .select('*', { count: 'exact', head: true })
          .eq('platform', platform)
          .eq('window', period)

        // Count nulls for each metric using separate count queries
        const [roiNull, pnlNull, winRateNull, drawdownNull, followersNull] = await Promise.all([
          supabase.from('trader_snapshots_v2').select('*', { count: 'exact', head: true })
            .eq('platform', platform).eq('window', period).is('roi_pct', null),
          supabase.from('trader_snapshots_v2').select('*', { count: 'exact', head: true })
            .eq('platform', platform).eq('window', period).is('pnl_usd', null),
          supabase.from('trader_snapshots_v2').select('*', { count: 'exact', head: true })
            .eq('platform', platform).eq('window', period).is('win_rate', null),
          supabase.from('trader_snapshots_v2').select('*', { count: 'exact', head: true })
            .eq('platform', platform).eq('window', period).is('max_drawdown', null),
          supabase.from('trader_snapshots_v2').select('*', { count: 'exact', head: true })
            .eq('platform', platform).eq('window', period).is('followers', null),
        ])

        periodCoverage[period] = {
          count: totalCount || 0,
          missingRoi: roiNull.count || 0,
          missingPnl: pnlNull.count || 0,
          missingWinRate: winRateNull.count || 0,
          missingDrawdown: drawdownNull.count || 0,
          missingFollowers: followersNull.count || 0,
        }
      }

      // Check enrichment coverage
      const enrichmentCoverage: PlatformGapReport['enrichmentCoverage'] = {
        equityCurve: {},
        statsDetail: {},
        positionHistory: 0,
        assetBreakdown: {},
      }

      for (const period of TIME_PERIODS) {
        // Equity curves
        const { count: curveCount } = await supabase
          .from('trader_equity_curve')
          .select('*', { count: 'exact', head: true })
          .eq('source', platform)
          .eq('period', period)

        enrichmentCoverage.equityCurve[period] = curveCount || 0

        // Stats detail
        const { count: statsCount } = await supabase
          .from('trader_stats_detail')
          .select('*', { count: 'exact', head: true })
          .eq('source', platform)
          .eq('period', period)

        enrichmentCoverage.statsDetail[period] = statsCount || 0

        // Asset breakdown
        const { count: assetCount } = await supabase
          .from('trader_asset_breakdown')
          .select('*', { count: 'exact', head: true })
          .eq('source', platform)
          .eq('period', period)

        enrichmentCoverage.assetBreakdown[period] = assetCount || 0
      }

      // Position history (not period-specific)
      const { count: positionCount } = await supabase
        .from('trader_position_history')
        .select('*', { count: 'exact', head: true })
        .eq('source', platform)

      enrichmentCoverage.positionHistory = positionCount || 0

      // Calculate missing periods using count queries instead of fetching all trader_keys
      // Previous version fetched ALL trader_keys per platform/period into memory — O(n²) for large platforms
      const [count7D, count30D, count90D] = await Promise.all(
        TIME_PERIODS.map(period =>
          supabase
            .from('trader_snapshots_v2')
            .select('*', { count: 'exact', head: true })
            .eq('platform', platform)
            .eq('window', period)
        )
      )

      const snap7D = count7D.count || 0
      const snap30D = count30D.count || 0
      const snap90D = count90D.count || 0

      // Approximate missing: traders in source but not in snapshot for that period
      const missing7D = Math.max(0, totalTraders - snap7D)
      const missing30D = Math.max(0, totalTraders - snap30D)
      const missing90D = Math.max(0, totalTraders - snap90D)
      // Traders not in any snapshot: those in trader_sources but no snapshot at all
      const maxSnap = Math.max(snap7D, snap30D, snap90D)
      const missingAll3 = Math.max(0, totalTraders - maxSnap)

      const report: PlatformGapReport = {
        platform,
        totalTraders,
        periodCoverage,
        enrichmentCoverage,
        missingPeriods: {
          missing7D,
          missing30D,
          missing90D,
          missingAll3,
        },
      }

      reports.push(report)

      // Update summary
      summary.totalTraders += totalTraders
      summary.missingPeriodGaps += missing7D + missing30D + missing90D

      const expectedEnrichment = Math.min(totalTraders, 300) // top 300 should be enriched
      for (const period of TIME_PERIODS) {
        const curveCount = enrichmentCoverage.equityCurve[period]
        const statsCount = enrichmentCoverage.statsDetail[period]
        if (curveCount < expectedEnrichment * 0.8) {
          summary.missingEnrichmentGaps += expectedEnrichment - curveCount
        }
        if (statsCount < expectedEnrichment * 0.8) {
          summary.missingEnrichmentGaps += expectedEnrichment - statsCount
        }
      }

      // Check if platform has issues
      const hasIssues =
        missing7D > totalTraders * 0.3 ||
        missing30D > totalTraders * 0.3 ||
        missing90D > totalTraders * 0.3 ||
        enrichmentCoverage.equityCurve['90D'] < expectedEnrichment * 0.5

      if (hasIssues) {
        summary.platformsWithIssues.push(platform)
      }

      summary.totalGaps = summary.missingPeriodGaps + summary.missingEnrichmentGaps
    } catch (err) {
      logger.error(`Error analyzing ${platform}`, { error: err instanceof Error ? err.message : String(err) })
    }
  }

  const duration = Date.now() - startTime

  await plog.success(reports.length, { summary })

  return NextResponse.json({
    ok: true,
    duration,
    summary,
    reports: detailed ? reports : reports.map((r) => ({
      platform: r.platform,
      totalTraders: r.totalTraders,
      periodCounts: {
        '7D': r.periodCoverage['7D']?.count || 0,
        '30D': r.periodCoverage['30D']?.count || 0,
        '90D': r.periodCoverage['90D']?.count || 0,
      },
      enrichmentCounts: {
        equityCurve90D: r.enrichmentCoverage.equityCurve['90D'] || 0,
        statsDetail90D: r.enrichmentCoverage.statsDetail['90D'] || 0,
        positionHistory: r.enrichmentCoverage.positionHistory,
      },
      missingPeriods: r.missingPeriods,
    })),
  })
}
