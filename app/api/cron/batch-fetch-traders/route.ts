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
 *   group=d  → dydx, gains, htx_futures, kwenta, mux (every 6h)
 *   group=e  → blofin, bingx, gateio (every 8h)
 *   group=f  → toobit (every 12h)
 * 
 * Each platform is called sequentially with a small delay to avoid rate limits.
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 300
export const preferredRegion = 'hnd1' // Tokyo — avoids Binance/OKX/Bybit geo-blocking

const GROUPS: Record<string, string[]> = {
  // Group A: High-priority CEX (every 3h) — 5 platforms
  a: ['binance_futures', 'binance_spot', 'bybit', 'bitget_futures', 'okx_futures'],
  // Group B: Mid-priority (every 4h) — 7 platforms
  b: ['mexc', 'kucoin', 'okx_web3', 'hyperliquid', 'gmx', 'jupiter_perps', 'aevo'],
  // Group C: Lower-priority batch 1 (every 6h) — 6 platforms
  c: ['coinex', 'bitget_spot', 'xt', 'bybit_spot', 'binance_web3'],
  // Group D: Lower-priority batch 2 (every 6h) — 5 platforms
  // Removed: phemex (discontinued 2026-02), weex (discontinued), bitmart (no fetcher)
  d: ['dydx', 'gains', 'htx_futures', 'kwenta', 'mux'],
  // Group E: Lowest-priority (every 8h) — 3 platforms
  // Removed: cryptocom (no public API), bitfinex (no public leaderboard API)
  e: ['blofin', 'bingx', 'gateio'],
  // Group F: Additional platforms (every 12h) — 1 platform
  // Removed: whitebit (no copy-trading API), btse (no public leaderboard API)
  f: ['toobit'],
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

  for (const platform of platforms) {
    const start = Date.now()
    try {
      const res = await fetch(`${baseUrl}/api/cron/fetch-traders/${platform}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${cronSecret}`,
        },
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
