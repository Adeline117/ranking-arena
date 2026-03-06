/**
 * Batch enrich dispatcher
 *
 * Consolidates multiple enrich cron jobs into one call.
 * Calls /api/cron/enrich for each platform sequentially.
 *
 * Query params:
 *   period=90D|30D|7D (default: 90D) - which time period to enrich
 *   all=true - enrich all platforms including lower priority ones
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Platform configs with limits per period
const PLATFORM_CONFIGS: Record<string, { limit90: number; limit30: number; limit7: number }> = {
  binance_futures: { limit90: 200, limit30: 150, limit7: 100 },
  binance_spot: { limit90: 100, limit30: 80, limit7: 50 },
  bybit: { limit90: 200, limit30: 150, limit7: 100 },
  bybit_spot: { limit90: 80, limit30: 60, limit7: 40 },
  okx_futures: { limit90: 150, limit30: 120, limit7: 80 },
  bitget_futures: { limit90: 150, limit30: 120, limit7: 80 },
  bitget_spot: { limit90: 80, limit30: 60, limit7: 40 },
  hyperliquid: { limit90: 120, limit30: 100, limit7: 60 },
  gmx: { limit90: 100, limit30: 80, limit7: 50 },
  mexc: { limit90: 80, limit30: 60, limit7: 40 },
  htx_futures: { limit90: 80, limit30: 60, limit7: 40 },
  kucoin: { limit90: 60, limit30: 50, limit7: 30 },
  dydx: { limit90: 80, limit30: 60, limit7: 40 },
  gains: { limit90: 60, limit30: 50, limit7: 30 },
  jupiter_perps: { limit90: 60, limit30: 50, limit7: 30 },
  aevo: { limit90: 60, limit30: 50, limit7: 30 },
}

// High priority platforms (always enriched)
const HIGH_PRIORITY = ['binance_futures', 'bybit', 'okx_futures', 'bitget_futures', 'hyperliquid', 'gmx']

// Medium priority (enriched with all=true or period=90D)
const MEDIUM_PRIORITY = ['binance_spot', 'bybit_spot', 'bitget_spot', 'mexc', 'htx_futures', 'dydx']

// Lower priority (enriched only with all=true)
const LOWER_PRIORITY = ['kucoin', 'gains', 'jupiter_perps', 'aevo']

interface BatchResult {
  platform: string
  period: string
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

  const period = request.nextUrl.searchParams.get('period') || '90D'
  const enrichAll = request.nextUrl.searchParams.get('all') === 'true'

  // Validate period
  if (!['7D', '30D', '90D'].includes(period)) {
    return NextResponse.json({ error: 'Invalid period, must be 7D, 30D, or 90D' }, { status: 400 })
  }

  // Use VERCEL_URL to bypass Cloudflare's ~120s proxy timeout
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000')

  // Determine which platforms to enrich based on period and all flag
  let platforms: string[]
  if (enrichAll) {
    platforms = [...HIGH_PRIORITY, ...MEDIUM_PRIORITY, ...LOWER_PRIORITY]
  } else if (period === '90D') {
    platforms = [...HIGH_PRIORITY, ...MEDIUM_PRIORITY]
  } else {
    // For 7D and 30D, only high priority platforms
    platforms = HIGH_PRIORITY
  }

  const results: BatchResult[] = []
  const plog = await PipelineLogger.start(`batch-enrich-${period}`, { period, enrichAll, platforms })

  for (const [index, platform] of platforms.entries()) {
    const config = PLATFORM_CONFIGS[platform]
    if (!config) continue

    const limit = period === '90D' ? config.limit90 : period === '30D' ? config.limit30 : config.limit7
    const start = Date.now()

    try {
      const res = await fetch(
        `${baseUrl}/api/cron/enrich?platform=${platform}&period=${period}&limit=${limit}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${cronSecret}` },
        }
      )
      results.push({
        platform,
        period,
        status: res.ok ? 'success' : 'error',
        durationMs: Date.now() - start,
        error: res.ok ? undefined : `HTTP ${res.status}`,
      })
    } catch (err) {
      results.push({
        platform,
        period,
        status: 'error',
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Delay between enrichments (skip after the last platform)
    if (index < platforms.length - 1) {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  const succeeded = results.filter(r => r.status === 'success').length
  const failed = results.length - succeeded

  if (failed === 0) {
    await plog.success(succeeded, { results })
  } else {
    await plog.error(
      new Error(`${failed}/${results.length} enrichments failed`),
      { results }
    )
  }

  return NextResponse.json({
    ok: succeeded === results.length,
    period,
    platforms: platforms.length,
    succeeded,
    failed,
    results,
  })
}
