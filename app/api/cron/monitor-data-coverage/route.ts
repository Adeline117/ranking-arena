/**
 * Data Coverage Monitor — the "immune system" for enrichment quality.
 *
 * Root cause fix: enrichment regressions (GMX 0.9% Sharpe, MEXC 0.1%, Gains 3%)
 * accumulated silently for weeks because nothing monitored metric fill rates.
 * check-data-gaps only checks row counts, not whether win_rate/sharpe/roi/mdd
 * are actually populated.
 *
 * This cron:
 * 1. Checks actual fill rates for key metrics per platform (win_rate, sharpe, roi, mdd)
 * 2. Compares against stored baselines in pipeline_state
 * 3. Alerts via Telegram when coverage drops >10% from baseline
 * 4. Stores new baselines for trend tracking
 *
 * Schedule: every 6 hours (vercel.json)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { PipelineState } from '@/lib/services/pipeline-state'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MONITORED_PLATFORMS = [
  'binance_futures',
  'binance_spot',
  'bybit',
  'okx_futures',
  'hyperliquid',
  'gmx',
  'mexc',
  'dydx',
  'gains',
  'drift',
  'aevo',
  'bitget_futures',
  'bitunix',
  'coinex',
  'htx_futures',
  'gateio',
  'bitfinex',
  'jupiter_perps',
  'kwenta',
  'toobit',
  'xt',
]

// Minimum expected fill rates (%). Platforms below these trigger alerts.
const EXPECTED_THRESHOLDS: Record<string, number> = {
  win_rate: 40,
  sharpe_ratio: 20,
  roi_pct: 50,
  max_drawdown: 20,
}

// Drop threshold: alert if coverage drops more than this % from baseline
const DROP_ALERT_THRESHOLD = 10

interface PlatformCoverage {
  platform: string
  total: number
  win_rate_pct: number
  sharpe_pct: number
  roi_pct: number
  mdd_pct: number
}

interface CoverageBaseline {
  timestamp: string
  platforms: Record<string, { wr: number; sr: number; roi: number; mdd: number }>
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('monitor-data-coverage')
  const supabase = getSupabaseAdmin()
  const results: PlatformCoverage[] = []
  const alerts: string[] = []

  try {
    // Load previous baseline
    const baseline = await PipelineState.get<CoverageBaseline>('coverage:baseline')

    // Query fill rates via HEAD count queries (zero row transfer, DB-level counting).
    // 5 counts per platform (total + 4 metrics), batched 3 platforms at a time.
    const cutoff = new Date(Date.now() - 3 * 86400000).toISOString()

    const countNonNull = async (platform: string, column: string) => {
      const { count } = await supabase
        .from('trader_snapshots_v2')
        .select('*', { count: 'exact', head: true })
        .eq('platform', platform)
        .eq('window', '90D')
        .gt('updated_at', cutoff)
        .not(column, 'is', null)
      return count ?? 0
    }

    const BATCH_SIZE = 3
    for (let i = 0; i < MONITORED_PLATFORMS.length; i += BATCH_SIZE) {
      const batch = MONITORED_PLATFORMS.slice(i, i + BATCH_SIZE)
      const batchResults = await Promise.allSettled(
        batch.map(async (platform) => {
          // 5 parallel HEAD counts per platform (total + 4 metrics)
          const [totalRes, wr, sr, roi, mdd] = await Promise.all([
            supabase
              .from('trader_snapshots_v2')
              .select('*', { count: 'exact', head: true })
              .eq('platform', platform)
              .eq('window', '90D')
              .gt('updated_at', cutoff)
              .then((r) => r.count ?? 0),
            countNonNull(platform, 'win_rate'),
            countNonNull(platform, 'sharpe_ratio'),
            countNonNull(platform, 'roi_pct'),
            countNonNull(platform, 'max_drawdown'),
          ])

          const total = totalRes
          if (total === 0) return null
          return {
            platform,
            total,
            win_rate_pct: Math.round((wr / total) * 1000) / 10,
            sharpe_pct: Math.round((sr / total) * 1000) / 10,
            roi_pct: Math.round((roi / total) * 1000) / 10,
            mdd_pct: Math.round((mdd / total) * 1000) / 10,
          } as PlatformCoverage
        })
      )

      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value) {
          results.push(result.value)
        }
      }
    }

    // Check for threshold violations and coverage drops
    for (const cov of results) {
      const violations: string[] = []

      // Check absolute thresholds
      if (cov.win_rate_pct < EXPECTED_THRESHOLDS.win_rate && cov.total > 100) {
        violations.push(`WR ${cov.win_rate_pct}% < ${EXPECTED_THRESHOLDS.win_rate}%`)
      }
      if (cov.sharpe_pct < EXPECTED_THRESHOLDS.sharpe_ratio && cov.total > 100) {
        violations.push(`SR ${cov.sharpe_pct}% < ${EXPECTED_THRESHOLDS.sharpe_ratio}%`)
      }
      if (cov.roi_pct < EXPECTED_THRESHOLDS.roi_pct && cov.total > 100) {
        violations.push(`ROI ${cov.roi_pct}% < ${EXPECTED_THRESHOLDS.roi_pct}%`)
      }

      // Check drops from baseline
      if (baseline?.platforms?.[cov.platform]) {
        const prev = baseline.platforms[cov.platform]
        if (prev.wr - cov.win_rate_pct > DROP_ALERT_THRESHOLD) {
          violations.push(`WR dropped ${prev.wr}→${cov.win_rate_pct}%`)
        }
        if (prev.sr - cov.sharpe_pct > DROP_ALERT_THRESHOLD) {
          violations.push(`SR dropped ${prev.sr}→${cov.sharpe_pct}%`)
        }
        if (prev.roi - cov.roi_pct > DROP_ALERT_THRESHOLD) {
          violations.push(`ROI dropped ${prev.roi}→${cov.roi_pct}%`)
        }
      }

      if (violations.length > 0) {
        alerts.push(`${cov.platform} (${cov.total}): ${violations.join(', ')}`)
      }
    }

    // Send alert if any violations
    if (alerts.length > 0) {
      await sendRateLimitedAlert(
        {
          title: `⚠️ Data coverage alert: ${alerts.length} platform(s)`,
          message: alerts.join('\n'),
          level: alerts.length > 3 ? 'critical' : 'warning',
          details: Object.fromEntries(
            results.map((r) => [
              r.platform,
              `WR:${r.win_rate_pct}% SR:${r.sharpe_pct}% ROI:${r.roi_pct}% MDD:${r.mdd_pct}%`,
            ])
          ),
        },
        'coverage-monitor',
        3600000 // 1 hour rate limit
      )
    }

    // Store new baseline
    const newBaseline: CoverageBaseline = {
      timestamp: new Date().toISOString(),
      platforms: Object.fromEntries(
        results.map((r) => [
          r.platform,
          {
            wr: r.win_rate_pct,
            sr: r.sharpe_pct,
            roi: r.roi_pct,
            mdd: r.mdd_pct,
          },
        ])
      ),
    }
    await PipelineState.set('coverage:baseline', newBaseline)

    await plog.success(results.length, {
      alerts: alerts.length,
      platforms: results.length,
    })

    return NextResponse.json({
      ok: true,
      alerts,
      coverage: results.sort((a, b) => b.total - a.total),
      baseline: baseline?.timestamp ?? null,
    })
  } catch (error) {
    await plog.error(error instanceof Error ? error : new Error(String(error)))
    return NextResponse.json({ error: 'Coverage monitor failed' }, { status: 500 })
  }
}
