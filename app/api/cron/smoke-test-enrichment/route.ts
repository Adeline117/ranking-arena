/**
 * Enrichment Smoke Test — catches unknown-unknown bugs.
 *
 * Architectural fix: coverage monitor checks DB (after damage is done),
 * CI checks code patterns (known bug types). This smoke test catches
 * NEW categories of bugs by testing actual enrichment functions against
 * real traders and real external APIs.
 *
 * For each active platform:
 * 1. Pick a random trader from DB that has win_rate (= leaderboard works)
 * 2. Call the platform's enrichment functions (equity curve, stats, positions)
 * 3. Verify at least some non-null output
 * 4. Alert on platforms where enrichment returns all-empty
 *
 * Schedule: daily (vercel.json)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'
import { logger } from '@/lib/logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

// Lazy import to avoid loading all enrichment code at module level
const loadConfigs = () =>
  import('@/lib/cron/enrichment-runner').then((m) => m.ENRICHMENT_PLATFORM_CONFIGS)

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Platforms with enrichment configs (from enrichment-runner.ts)
const TESTABLE_PLATFORMS = [
  'binance_futures',
  'okx_futures',
  'hyperliquid',
  'gmx',
  'dydx',
  'mexc',
  'bitget_futures',
  'aevo',
  'jupiter_perps',
  'htx_futures',
] as const

interface SmokeResult {
  platform: string
  traderKey: string
  equityCurve: number
  stats: boolean
  positions: number
  ok: boolean
  error?: string
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const plog = await PipelineLogger.start('smoke-test-enrichment')
  const supabase = getSupabaseAdmin()
  const results: SmokeResult[] = []
  const failures: string[] = []

  try {
    const configs = await loadConfigs()

    for (const platform of TESTABLE_PLATFORMS) {
      try {
        // Pick a trader that has win_rate (= leaderboard data exists)
        const { data: traders } = await supabase
          .from('trader_snapshots_v2')
          .select('trader_key')
          .eq('platform', platform)
          .eq('window', '90D')
          .not('win_rate', 'is', null)
          .gt('updated_at', new Date(Date.now() - 7 * 86400000).toISOString())
          .limit(1)

        if (!traders || traders.length === 0) {
          results.push({
            platform,
            traderKey: '',
            equityCurve: 0,
            stats: false,
            positions: 0,
            ok: false,
            error: 'no traders in DB',
          })
          continue
        }

        const traderKey = traders[0].trader_key
        const config = configs[platform]

        if (!config) {
          results.push({
            platform,
            traderKey,
            equityCurve: 0,
            stats: false,
            positions: 0,
            ok: false,
            error: 'no enrichment config',
          })
          continue
        }

        // Test enrichment functions with 10s timeout each
        let curveLen = 0
        let hasStats = false
        let posLen = 0

        if (config.fetchEquityCurve) {
          try {
            const curve = await Promise.race([
              config.fetchEquityCurve(traderKey, 90),
              new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
            ])
            curveLen = curve?.length ?? 0
          } catch (e) {
            logger.warn(
              `[smoke] ${platform} equity curve: ${e instanceof Error ? e.message : String(e)}`
            )
          }
        }

        if (config.fetchStatsDetail) {
          try {
            const stats = await Promise.race([
              config.fetchStatsDetail(traderKey),
              new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
            ])
            hasStats =
              stats != null && (stats.totalTrades != null || stats.profitableTradesPct != null)
          } catch (e) {
            logger.warn(`[smoke] ${platform} stats: ${e instanceof Error ? e.message : String(e)}`)
          }
        }

        if (config.fetchPositionHistory) {
          try {
            const positions = await Promise.race([
              config.fetchPositionHistory(traderKey),
              new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
            ])
            posLen = positions?.length ?? 0
          } catch (e) {
            logger.warn(
              `[smoke] ${platform} positions: ${e instanceof Error ? e.message : String(e)}`
            )
          }
        }

        const ok = curveLen > 0 || hasStats || posLen > 0
        results.push({
          platform,
          traderKey: traderKey.slice(0, 12),
          equityCurve: curveLen,
          stats: hasStats,
          positions: posLen,
          ok,
        })

        if (!ok) {
          failures.push(
            `${platform}: curve=${curveLen} stats=${hasStats} pos=${posLen} (trader: ${traderKey.slice(0, 12)})`
          )
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({
          platform,
          traderKey: '',
          equityCurve: 0,
          stats: false,
          positions: 0,
          ok: false,
          error: msg,
        })
        failures.push(`${platform}: ${msg}`)
      }
    }

    if (failures.length > 0) {
      await sendRateLimitedAlert(
        {
          title: `🔥 Enrichment smoke test: ${failures.length}/${TESTABLE_PLATFORMS.length} platforms failing`,
          message: failures.join('\n'),
          level: failures.length > 3 ? 'critical' : 'warning',
        },
        'smoke-test-enrichment',
        3600000
      )
    }

    const passed = results.filter((r) => r.ok).length
    await plog.success(passed, { total: results.length, failures: failures.length })

    return NextResponse.json({
      ok: failures.length === 0,
      passed,
      total: results.length,
      results,
      failures,
    })
  } catch (error) {
    await plog.error(error instanceof Error ? error : new Error(String(error)))
    return NextResponse.json({ error: 'Smoke test failed' }, { status: 500 })
  }
}
