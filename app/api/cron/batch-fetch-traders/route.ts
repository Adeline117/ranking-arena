/**
 * Batch fetch-traders dispatcher
 *
 * Calls fetcher functions DIRECTLY (in-process) instead of via HTTP,
 * avoiding Cloudflare timeouts and Vercel deployment protection issues.
 *
 * Query params:
 *   group=a  → binance_futures, binance_spot, bybit, bitget_futures, okx_futures (every 3h)
 *   group=b  → hyperliquid, gmx, jupiter_perps (every 4h)
 *   group=c  → okx_web3, aevo, xt (every 4h)
 *   group=d  → gains, htx_futures, dydx, phemex, bybit_spot (every 6h)
 *   group=e  → coinex, binance_web3, kwenta, synthetix, mux (every 6h)
 *   group=f  → mexc, bingx, gateio, weex, bitmart (every 6h)
 *   group=g  → drift, bitunix, web3_bot, uniswap, pancakeswap (every 6h)
 *
 * Dead/blocked platforms removed:
 *   - kucoin: APIs return 404, feature discontinued
 *   - lbank: needs session auth, crashes headless browser
 *   - bitget_spot: no public API (all endpoints return 404)
 *   - blofin: needs credentials (BLOFIN env vars not set)
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { getInlineFetcher } from '@/lib/cron/fetchers'
import { createSupabaseAdmin } from '@/lib/cron/utils'
import { recordFetchResult } from '@/lib/utils/pipeline-monitor'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 300
export const preferredRegion = 'hnd1' // Tokyo — avoids Binance/OKX/Bybit geo-blocking

const GROUPS: Record<string, string[]> = {
  // Group A: High-priority CEX (every 3h) — 5 platforms
  // Consolidated: dedicated crons (binance_futures/spot, bybit) merged here
  a: ['binance_futures', 'binance_spot', 'bybit', 'bitget_futures', 'okx_futures'],
  // Group B: Top DEX (every 4h) — 3 platforms, ~110s parallel
  b: ['hyperliquid', 'gmx', 'jupiter_perps'],
  // Group C: Mid-priority (every 4h) — 3 platforms, ~70s parallel
  c: ['okx_web3', 'aevo', 'xt'],
  // Group D: CEX+DEX (every 6h) — 5 platforms
  d: ['gains', 'htx_futures', 'dydx', 'phemex', 'bybit_spot'],
  // Group E: Lower-priority DEX (every 6h) — 5 platforms (was 8h)
  e: ['coinex', 'binance_web3', 'kwenta', 'synthetix', 'mux'],
  // Group F: Mid-tier CEX (every 6h) — 5 platforms (was 12h)
  f: ['mexc', 'bingx', 'gateio', 'weex', 'bitmart'],
  // Group G: New CEX + DEX (every 6h) — 5 platforms (was 12h)
  g: ['drift', 'bitunix', 'web3_bot', 'uniswap', 'pancakeswap'],
}

interface BatchResult {
  platform: string
  status: 'success' | 'error'
  durationMs: number
  totalSaved?: number
  error?: string
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const group = request.nextUrl.searchParams.get('group') || 'a'
  const platforms = GROUPS[group]
  if (!platforms) {
    return NextResponse.json({ error: `Unknown group: ${group}`, available: Object.keys(GROUPS) }, { status: 400 })
  }

  const supabaseOrNull = createSupabaseAdmin()
  if (!supabaseOrNull) {
    return NextResponse.json({ error: 'Supabase env vars missing' }, { status: 500 })
  }
  const supabase = supabaseOrNull

  const overallStart = Date.now()
  const plog = await PipelineLogger.start(`batch-fetch-traders-${group}`, { group, platforms })

  // Run a single platform fetch and return the result
  async function runPlatform(platform: string): Promise<BatchResult> {
    const start = Date.now()
    try {
      const fetcher = getInlineFetcher(platform)
      if (!fetcher) {
        return { platform, status: 'error', durationMs: Date.now() - start, error: `No fetcher for ${platform}` }
      }

      const result = await fetcher(supabase, ['7D', '30D', '90D'])
      const hasErrors = Object.values(result.periods).some((p) => p.error)
      const totalSaved = Object.values(result.periods).reduce((sum, p) => sum + (p.saved || 0), 0)

      await recordFetchResult(supabase, result.source, {
        success: !hasErrors,
        durationMs: result.duration,
        recordCount: totalSaved,
        error: hasErrors
          ? Object.entries(result.periods).filter(([, p]) => p.error).map(([k, p]) => `${k}: ${p.error}`).join('; ')
          : undefined,
        metadata: { periods: result.periods, batchGroup: group },
      })

      logger.info(`[batch-fetch-traders-${group}] ${platform}: saved=${totalSaved} duration=${Date.now() - start}ms`)

      if (hasErrors && totalSaved === 0) {
        const errDetail = Object.entries(result.periods).filter(([, p]) => p.error).map(([k, p]) => `${k}: ${p.error}`).join('; ')
        return { platform, status: 'error', durationMs: Date.now() - start, totalSaved, error: errDetail }
      }
      return { platform, status: 'success', durationMs: Date.now() - start, totalSaved }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error(`[batch-fetch-traders-${group}] ${platform} error: ${errMsg}`)

      try {
        await recordFetchResult(supabase, platform, {
          success: false, durationMs: Date.now() - start, recordCount: 0, error: errMsg,
        })
      } catch (metricErr) {
        logger.warn(`[batch-fetch-traders-${group}] Failed to record metric for ${platform}`, { error: metricErr instanceof Error ? metricErr.message : String(metricErr) })
      }

      return { platform, status: 'error', durationMs: Date.now() - start, error: errMsg }
    }
  }

  // Small groups (≤3): run in parallel to maximize use of 300s budget
  // Large groups: run sequentially with delays to avoid upstream rate limits
  let results: BatchResult[]
  if (platforms.length <= 3) {
    results = await Promise.all(platforms.map(runPlatform))
  } else {
    results = []
    for (const platform of platforms) {
      results.push(await runPlatform(platform))
      if (platforms.indexOf(platform) < platforms.length - 1) {
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  }

  const succeeded = results.filter((r) => r.status === 'success').length
  const failed = results.length - succeeded

  if (failed === 0) {
    await plog.success(succeeded, { results })
  } else {
    await plog.error(
      new Error(`${failed}/${results.length} platforms failed`),
      { results }
    )
  }

  return NextResponse.json({
    ok: succeeded === results.length,
    group,
    platforms: platforms.length,
    succeeded,
    failed,
    totalDurationMs: Date.now() - overallStart,
    results,
  })
}
