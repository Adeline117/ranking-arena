/**
 * Batch fetch for exchanges without dedicated cron slots.
 *
 * Runs sequentially to stay within the 300s timeout:
 *   - bybit_spot (API-based, works from non-US Vercel regions)
 *   - binance_web3 (API-based, works from non-US Vercel regions)
 *
 * NOTE: weex, bingx, blofin require browser/proxy infrastructure
 * and are excluded until that infrastructure is available.
 *
 * Schedule: every 6 hours (shares slot with low-frequency fetchers)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getInlineFetcher } from '@/lib/cron/fetchers'
import { createSupabaseAdmin, getSupabaseEnv } from '@/lib/cron/utils'
import { recordFetchResult } from '@/lib/utils/pipeline-monitor'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PLATFORMS = ['bybit_spot', 'binance_web3']
const PERIODS = ['7D', '30D', '90D']

interface PlatformResult {
  platform: string
  status: 'success' | 'error'
  durationMs: number
  saved?: number
  error?: string
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { url, serviceKey } = getSupabaseEnv()
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Supabase env missing' }, { status: 500 })
  }

  const supabase = createSupabaseAdmin()
  if (!supabase) {
    return NextResponse.json({ error: 'Failed to create Supabase client' }, { status: 500 })
  }

  const results: PlatformResult[] = []

  for (const platform of PLATFORMS) {
    const start = Date.now()
    try {
      const fetcher = getInlineFetcher(platform)
      if (!fetcher) {
        results.push({ platform, status: 'error', durationMs: 0, error: 'No fetcher found' })
        continue
      }

      const result = await fetcher(supabase, PERIODS)
      const totalSaved = Object.values(result.periods).reduce((sum, p) => sum + (p.saved || 0), 0)
      const hasErrors = Object.values(result.periods).some(p => p.error)
      const durationMs = Date.now() - start

      await recordFetchResult(supabase, platform, {
        success: !hasErrors,
        durationMs,
        recordCount: totalSaved,
        error: hasErrors
          ? Object.entries(result.periods).filter(([, p]) => p.error).map(([k, p]) => `${k}: ${p.error}`).join('; ')
          : undefined,
        metadata: { periods: result.periods },
      }).catch(() => {})

      results.push({
        platform,
        status: hasErrors ? 'error' : 'success',
        durationMs,
        saved: totalSaved,
        error: hasErrors ? 'Some periods failed' : undefined,
      })
    } catch (err) {
      results.push({
        platform,
        status: 'error',
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  const hasErrors = results.some(r => r.status === 'error')
  return NextResponse.json({
    batch: 'batch-fetch-extra',
    status: hasErrors ? 'partial' : 'success',
    results,
  }, { status: hasErrors ? 207 : 200 })
}
