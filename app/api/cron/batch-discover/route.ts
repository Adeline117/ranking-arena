/**
 * Batch discover dispatcher
 *
 * Consolidates discover-traders and discover-rankings into one cron job.
 * Runs sub-jobs INLINE (in-process) to avoid:
 * - Vercel deployment protection 401 (via VERCEL_URL)
 * - Cloudflare 100s proxy timeout (via NEXT_PUBLIC_APP_URL)
 *
 * Sub-jobs:
 * - discover-rankings: Seed refresh_jobs queue for all platforms
 *
 * Note: discover-traders (JobRunner v2 system) is disabled — v2 tables
 * (trader_sources_v2, trader_snapshots_v2, etc.) are not deployed.
 * The existing batch-fetch-traders pipeline handles trader discovery.
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import _logger from '@/lib/logger'
import { env } from '@/lib/env'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

interface BatchResult {
  name: string
  status: 'success' | 'error'
  durationMs: number
  detail?: Record<string, unknown>
  error?: string
}

// ---- Inline: discover-rankings ----
async function discoverRankingsInline(): Promise<BatchResult> {
  const start = Date.now()
  const name = 'discover-rankings'
  try {
    const supabase = getSupabaseAdmin()

    // Check which platforms have healthy status (not circuit-open)
    // platform_health table may not exist — skip gracefully
    let blockedPlatforms = new Set<string>()
    try {
      const { data: healthData } = await supabase
        .from('platform_health')
        .select('platform, status')

      blockedPlatforms = new Set(
        (healthData || [])
          .filter((h: { status: string }) => h.status === 'circuit_open')
          .map((h: { platform: string }) => h.platform)
      )
    } catch {
      // platform_health table may not exist — continue without blocking
    }

    const RANKING_PLATFORMS = [
      { platform: 'binance', market_type: 'futures', priority: 5 },
      { platform: 'binance', market_type: 'spot', priority: 10 },
      { platform: 'bybit', market_type: 'futures', priority: 5 },
      { platform: 'bitget', market_type: 'futures', priority: 10 },
      { platform: 'mexc', market_type: 'futures', priority: 15 },
      { platform: 'coinex', market_type: 'futures', priority: 20 },
      { platform: 'okx', market_type: 'futures', priority: 10 },
      // bitmart removed: gw-api/copytrade-streamer returns "service not open"
      { platform: 'htx', market_type: 'futures', priority: 25 },
      { platform: 'gmx', market_type: 'perp', priority: 15 },
      { platform: 'dydx', market_type: 'perp', priority: 15 },
      { platform: 'hyperliquid', market_type: 'perp', priority: 15 },
    ]

    const jobs = RANKING_PLATFORMS
      .filter(p => !blockedPlatforms.has(p.platform))
      .map(p => ({
        job_type: 'DISCOVER',
        platform: p.platform,
        market_type: p.market_type,
        priority: p.priority,
        status: 'pending',
        next_run_at: new Date().toISOString(),
      }))

    if (jobs.length === 0) {
      return { name, status: 'success', durationMs: Date.now() - start, detail: { message: 'All platforms circuit-open' } }
    }

    // Insert jobs — ignore errors if refresh_jobs table doesn't exist (v2 not deployed)
    const { error } = await supabase.from('refresh_jobs').insert(jobs)
    if (error) {
      // If refresh_jobs table doesn't exist, skip gracefully
      if (error.message.includes('does not exist') || error.message.includes('relation')) {
        return { name, status: 'success', durationMs: Date.now() - start, detail: { skipped: true, reason: 'refresh_jobs table not available' } }
      }
      return { name, status: 'error', durationMs: Date.now() - start, error: 'Database insert failed' }
    }

    // Release stale locks if RPC exists
    try {
      await supabase.rpc('release_stale_locks')
    } catch {
      // Intentionally swallowed: release_stale_locks RPC not deployed, stale locks will expire naturally
    }

    return { name, status: 'success', durationMs: Date.now() - start, detail: { jobs_created: jobs.length, blocked: Array.from(blockedPlatforms) } }
  } catch (_err) {
    return { name, status: 'error', durationMs: Date.now() - start, error: 'Discovery task failed' }
  }
}

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()

  // Run inline — no HTTP sub-calls
  const results: BatchResult[] = await Promise.all([
    discoverRankingsInline(),
  ])

  const totalDuration = Date.now() - startTime
  const hasErrors = results.some(r => r.status === 'error')

  const plog = await PipelineLogger.start('batch-discover')
  const succeeded = results.filter(r => r.status === 'success').length
  if (hasErrors) {
    await plog.error(new Error(`${results.length - succeeded}/${results.length} failed`), { results })
  } else {
    await plog.success(succeeded, { results })
  }

  return NextResponse.json({
    batch: 'batch-discover',
    status: hasErrors ? 'partial' : 'success',
    totalDurationMs: totalDuration,
    results,
  }, {
    status: hasErrors ? 207 : 200,
  })
}
