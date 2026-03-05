/**
 * Batch fetch-traders dispatcher
 * 
 * Consolidates multiple individual fetch-traders/[platform] cron jobs into
 * grouped batch calls, saving cron slots while preserving all functionality.
 * 
 * Query params:
 *   group=a  → binance_futures, binance_spot, bybit, bitget_futures, okx_futures (every 3h)
 *   group=b  → mexc, kucoin, okx_web3, hyperliquid, gmx, jupiter_perps, aevo (every 4h)
 *   group=c  → coinex, bitget_spot, xt (every 6h)
 * 
 * Each platform is called sequentially with a small delay to avoid rate limits.
 */

import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const GROUPS: Record<string, string[]> = {
  // Group A: High-priority CEX (every 3h) — 5 platforms
  a: ['binance_futures', 'binance_spot', 'bybit', 'bitget_futures', 'okx_futures'],
  // Group B: Mid-priority (every 4h) — 7 platforms
  b: ['mexc', 'kucoin', 'okx_web3', 'hyperliquid', 'gmx', 'jupiter_perps', 'aevo'],
  // Group C: Lower-priority batch 1 (every 6h) — 6 platforms
  c: ['coinex', 'bitget_spot', 'xt', 'bybit_spot', 'binance_web3'],
  // Group D: Lower-priority batch 2 (every 6h) — 6 platforms
  d: ['lbank', 'dydx', 'phemex', 'gains', 'htx_futures', 'weex'],
  // Group E: Lowest-priority (every 8h) — 5 platforms
  e: ['blofin', 'bingx', 'gateio', 'cryptocom', 'bitfinex'],
  // Group F: Additional platforms (every 12h) — 5 platforms
  f: ['whitebit', 'btse', 'toobit', 'uniswap', 'pancakeswap'],
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
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const group = request.nextUrl.searchParams.get('group') || 'a'
  const platforms = GROUPS[group]
  if (!platforms) {
    return NextResponse.json({ error: `Unknown group: ${group}`, available: Object.keys(GROUPS) }, { status: 400 })
  }

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'

  const results: BatchResult[] = []
  const overallStart = Date.now()

  for (const platform of platforms) {
    const start = Date.now()
    try {
      const res = await fetch(`${baseUrl}/api/cron/fetch-traders/${platform}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${cronSecret || ''}`,
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
  return NextResponse.json({
    ok: succeeded === results.length,
    group,
    platforms: platforms.length,
    succeeded,
    failed: results.length - succeeded,
    totalDurationMs: Date.now() - overallStart,
    results,
  })
}
