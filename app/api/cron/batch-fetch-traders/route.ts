/**
 * Batch fetch-traders dispatcher
 *
 * Calls fetcher functions DIRECTLY (in-process) instead of via HTTP,
 * avoiding Cloudflare timeouts and Vercel deployment protection issues.
 *
 * Query params:
 *   group=a  → bitget_futures, okx_futures (every 3h)
 *   group=b  → mexc, kucoin, okx_web3, hyperliquid, gmx, jupiter_perps, aevo (every 4h)
 *   group=c  → coinex, bitget_spot, xt, binance_web3 (every 6h)
 *   group=d  → dydx, phemex, gains, htx_futures, weex, bitmart, kwenta, mux (every 6h)
 *   group=e  → blofin, bingx, gateio, cryptocom, bitfinex, pionex, lbank (every 8h)
 *   group=f  → whitebit, btse, toobit (every 12h)
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
  // Group A: High-priority CEX (every 3h) — 2 platforms
  // binance_futures, binance_spot, bybit have dedicated crons (need full 300s for VPS proxy)
  a: ['bitget_futures', 'okx_futures'],
  // Group B: Mid-priority (every 4h) — 7 platforms
  b: ['mexc', 'kucoin', 'okx_web3', 'hyperliquid', 'gmx', 'jupiter_perps', 'aevo'],
  // Group C: Lower-priority batch 1 (every 6h) — 4 platforms (bybit_spot has dedicated cron)
  c: ['coinex', 'bitget_spot', 'xt', 'binance_web3'],
  // Group D: Lower-priority batch 2 (every 6h) — 8 platforms
  d: ['dydx', 'phemex', 'gains', 'htx_futures', 'weex', 'bitmart', 'kwenta', 'mux'],
  // Group E: Lowest-priority (every 8h) — 7 platforms
  e: ['blofin', 'bingx', 'gateio', 'cryptocom', 'bitfinex', 'pionex', 'lbank'],
  // Group F: Additional platforms (every 12h) — 3 platforms
  f: ['whitebit', 'btse', 'toobit'],
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

  const supabase = createSupabaseAdmin()
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase env vars missing' }, { status: 500 })
  }

  const results: BatchResult[] = []
  const overallStart = Date.now()
  const plog = await PipelineLogger.start(`batch-fetch-traders-${group}`, { group, platforms })

  for (const platform of platforms) {
    const start = Date.now()
    try {
      const fetcher = getInlineFetcher(platform)
      if (!fetcher) {
        results.push({ platform, status: 'error', durationMs: Date.now() - start, error: `No fetcher for ${platform}` })
        continue
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

      if (hasErrors && totalSaved === 0) {
        const errDetail = Object.entries(result.periods).filter(([, p]) => p.error).map(([k, p]) => `${k}: ${p.error}`).join('; ')
        results.push({ platform, status: 'error', durationMs: Date.now() - start, totalSaved, error: errDetail })
      } else {
        results.push({ platform, status: 'success', durationMs: Date.now() - start, totalSaved })
      }

      logger.info(`[batch-fetch-traders-${group}] ${platform}: saved=${totalSaved} duration=${Date.now() - start}ms`)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error(`[batch-fetch-traders-${group}] ${platform} error: ${errMsg}`)

      try {
        await recordFetchResult(supabase, platform, {
          success: false,
          durationMs: Date.now() - start,
          recordCount: 0,
          error: errMsg,
        })
      } catch { /* ignore metric recording failures */ }

      results.push({ platform, status: 'error', durationMs: Date.now() - start, error: errMsg })
    }

    // Small delay between platforms to be nice to upstream APIs
    if (platforms.indexOf(platform) < platforms.length - 1) {
      await new Promise((r) => setTimeout(r, 1000))
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
