/**
 * Batch enrich dispatcher
 * 
 * Consolidates multiple enrich cron jobs into one call.
 * Calls /api/cron/enrich for each platform sequentially.
 */

import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PLATFORMS = [
  { platform: 'binance_futures', period: '90D', limit: 100 },
  { platform: 'bybit', period: '90D', limit: 100 },
]

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

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'

  const results: BatchResult[] = []

  for (const { platform, period, limit } of PLATFORMS) {
    const start = Date.now()
    try {
      const res = await fetch(
        `${baseUrl}/api/cron/enrich?platform=${platform}&period=${period}&limit=${limit}`,
        {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${cronSecret || ''}` },
        }
      )
      results.push({
        platform,
        status: res.ok ? 'success' : 'error',
        durationMs: Date.now() - start,
        error: res.ok ? undefined : `HTTP ${res.status}`,
      })
    } catch (err) {
      results.push({
        platform,
        status: 'error',
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Delay between enrichments
    if (PLATFORMS.indexOf({ platform, period, limit }) < PLATFORMS.length - 1) {
      await new Promise((r) => setTimeout(r, 3000))
    }
  }

  return NextResponse.json({
    ok: results.every((r) => r.status === 'success'),
    results,
  })
}
