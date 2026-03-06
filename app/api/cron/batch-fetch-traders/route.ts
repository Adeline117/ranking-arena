/**
 * Batch fetch-traders dispatcher
 * 
 * Consolidates multiple individual fetch-traders/[platform] cron jobs into
 * grouped batch calls, saving cron slots while preserving all functionality.
 * 
 * Query params:
 *   group=a  → binance_futures, binance_spot, bybit, bitget_futures, okx_futures (every 3h)
 *   group=b  → mexc, kucoin, okx_web3, hyperliquid, gmx, jupiter_perps, aevo (every 4h)
 *   group=c  → coinex, bitget_spot, xt, bybit_spot, binance_web3 (every 6h)
 *   group=d  → dydx, phemex, gains, htx_futures, weex, bitmart, kwenta, mux (every 6h)
 *   group=e  → blofin, bingx, gateio, cryptocom, bitfinex, pionex, lbank (every 8h)
 *   group=f  → whitebit, btse, toobit, uniswap, pancakeswap (every 12h)
 * 
 * Each platform is called sequentially with a small delay to avoid rate limits.
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 300
export const preferredRegion = 'hnd1' // Tokyo — avoids Binance/OKX/Bybit geo-blocking

const GROUPS: Record<string, string[]> = {
  // Group A: High-priority CEX (every 3h) — 4 platforms (bybit has dedicated cron)
  a: ['binance_futures', 'binance_spot', 'bitget_futures', 'okx_futures'],
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

  // Use production URL to avoid Vercel deployment protection on preview URLs
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

  const results: BatchResult[] = []
  const overallStart = Date.now()
  const plog = await PipelineLogger.start(`batch-fetch-traders-${group}`, { group, platforms })

  // Per-platform timeout: scale based on group size to fit within 300s Vercel limit
  // Reserve 10s for overhead, distribute remaining time across platforms
  const PLATFORM_TIMEOUT_MS = Math.floor((290_000 - platforms.length * 2000) / platforms.length)

  for (const platform of platforms) {
    const start = Date.now()
    try {
      const headers: Record<string, string> = {
          'Authorization': `Bearer ${cronSecret}`,
        }
      // Bypass Vercel Deployment Protection for internal cron calls
      if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) {
        headers['x-vercel-protection-bypass'] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET
      }
      const res = await fetch(`${baseUrl}/api/cron/fetch-traders/${platform}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(PLATFORM_TIMEOUT_MS),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        results.push({
          platform,
          status: 'error',
          durationMs: Date.now() - start,
          error: `HTTP ${res.status}: ${body.slice(0, 200)}`,
        })
      } else {
        results.push({ platform, status: 'success', durationMs: Date.now() - start })
      }
    } catch (err) {
      results.push({
        platform,
        status: 'error',
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Small delay between platforms to be nice to upstream APIs
    if (platforms.indexOf(platform) < platforms.length - 1) {
      await new Promise((r) => setTimeout(r, 2000))
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
