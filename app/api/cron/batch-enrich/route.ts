/**
 * Batch enrich dispatcher
 *
 * Calls enrichment logic INLINE (in-process) instead of via HTTP,
 * avoiding Cloudflare timeouts and Vercel deployment protection issues.
 *
 * Query params:
 *   period=90D|30D|7D|all (default: 90D) - which time period to enrich
 *     When period=all, runs all 3 periods (90D, 30D, 7D) sequentially
 *   all=true - enrich all platforms including lower priority ones
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { runEnrichment, type EnrichmentResult } from '@/lib/cron/enrichment-runner'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { env } from '@/lib/env'
import { triggerDownstreamRefresh } from '@/lib/cron/trigger-chain'
import { PipelineCheckpoint } from '@/lib/harness/pipeline-checkpoint'

const logger = createLogger('batch-enrich')

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // Vercel Pro max (800 was invalid — silently capped at 300s anyway)

// Platform configs with limits per period
// EMERGENCY REDUCTION (2026-03-13 Round 2): batch-enrich STILL hitting 600s timeout
// Onchain platforms: 50/40/30 → 30/25/20 (more aggressive)
// CEX platforms: slightly reduced to balance load
// 2026-03-20: FULL COVERAGE — limits sized to actual leaderboard counts
// With offset rotation, each run processes a different slice. Over 6 runs/day = full coverage.
// Limits must satisfy: limit × per_trader_time < platform_timeout (90s CEX / 120s onchain)
// With offset rotation, full coverage is achieved over multiple runs (every 4h).
const PLATFORM_LIMITS: Record<string, { limit90: number; limit30: number; limit7: number }> = {
  // Batch-cached (no per-trader API calls, instant) — can be higher
  bitunix: { limit90: 300, limit30: 300, limit7: 300 },
  xt: { limit90: 100, limit30: 100, limit7: 100 },
  blofin: { limit90: 200, limit30: 200, limit7: 200 },
  bitfinex: { limit90: 120, limit30: 120, limit7: 120 },
  toobit: { limit90: 100, limit30: 100, limit7: 100 },
  coinex: { limit90: 200, limit30: 200, limit7: 200 },
  // Large CEX — API per trader (~0.5s/trader → max ~150 in 90s)
  binance_futures: { limit90: 150, limit30: 100, limit7: 100 },
  okx_futures: { limit90: 150, limit30: 100, limit7: 100 },
  htx_futures: { limit90: 100, limit30: 80, limit7: 80 },
  etoro: { limit90: 100, limit30: 80, limit7: 80 },
  gateio: { limit90: 100, limit30: 80, limit7: 80 },
  mexc: { limit90: 100, limit30: 80, limit7: 80 },
  // DEX on-chain (~0.3s/trader → max ~300 in 120s, but leave margin)
  hyperliquid: { limit90: 200, limit30: 150, limit7: 150 },
  drift: { limit90: 200, limit30: 150, limit7: 150 },
  jupiter_perps: { limit90: 150, limit30: 100, limit7: 100 },
  gmx: { limit90: 100, limit30: 80, limit7: 80 },
  gains: { limit90: 80, limit30: 60, limit7: 60 },
  dydx: { limit90: 150, limit30: 100, limit7: 100 },
  aevo: { limit90: 100, limit30: 80, limit7: 80 },
  // Medium CEX
  bitget_futures: { limit90: 100, limit30: 80, limit7: 80 },
  btcc: { limit90: 50, limit30: 50, limit7: 50 },
  okx_spot: { limit90: 40, limit30: 40, limit7: 40 },
  okx_web3: { limit90: 150, limit30: 100, limit7: 100 },
  // Additional platforms
  binance_web3: { limit90: 150, limit30: 100, limit7: 100 },
  binance_spot: { limit90: 150, limit30: 100, limit7: 100 },
  polymarket: { limit90: 100, limit30: 80, limit7: 80 },
  // VPS scrapers (slow — ~18s/trader via Playwright, max 5 in 90s timeout)
  bybit: { limit90: 5, limit30: 5, limit7: 5 },
  bybit_spot: { limit90: 5, limit30: 5, limit7: 5 },
  // DEAD/DISABLED:
  // phemex: DEAD (API 404 since 2026-04)
  // bingx: DEAD (empty data since 2026-04)
  // weex: DISABLED (75% timeout)
  // kucoin: DEAD (copy trading discontinued)
  // bingx_spot: REMOVED (no enrichment API)
}

// 2026-03-20: Full coverage — batch-cached first (instant), then API-per-trader
const HIGH_PRIORITY = [
  'bitunix', 'xt', 'blofin', 'bitfinex', 'toobit', 'coinex', // batch-cached: instant
  'binance_futures', 'okx_futures', 'hyperliquid', 'jupiter_perps', // fast APIs
]
const MEDIUM_PRIORITY = [
  'htx_futures', 'gateio', 'mexc', 'drift', 'gmx', 'gains',
  'bitget_futures', 'btcc', 'etoro', 'okx_spot', 'okx_web3',
  'dydx', 'aevo', // re-enabled via Copin + indexer
  'binance_web3', 'binance_spot', 'polymarket', // added for full coverage
  // REMOVED: phemex (API 404), bingx (empty data)
]
const LOW_PRIORITY = ['bybit', 'bybit_spot'] // VPS scrapers, run last
// REMOVED: weex (75% timeout), bingx_spot (no enrichment API)
const LOWER_PRIORITY: string[] = []

interface BatchResult {
  platform: string
  period: string
  status: 'success' | 'error'
  durationMs: number
  enriched?: number
  failed?: number
  error?: string
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = env.CRON_SECRET
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const periodParam = request.nextUrl.searchParams.get('period') || '90D'
  const enrichAll = request.nextUrl.searchParams.get('all') === 'true'

  const VALID_PERIODS = ['7D', '30D', '90D'] as const
  type Period = typeof VALID_PERIODS[number]

  if (periodParam !== 'all' && !VALID_PERIODS.includes(periodParam as Period)) {
    return NextResponse.json({ error: 'Invalid period, must be 7D, 30D, 90D, or all' }, { status: 400 })
  }

  const periodsToRun: Period[] = periodParam === 'all'
    ? ['90D', '30D', '7D']
    : [periodParam as Period]

  // Determine which platforms to enrich
  // Low priority platforms (dydx, binance_spot) run LAST to prevent blocking
  let platforms: string[]
  if (enrichAll) {
    platforms = [...HIGH_PRIORITY, ...MEDIUM_PRIORITY, ...LOWER_PRIORITY, ...LOW_PRIORITY]
  } else {
    platforms = [...HIGH_PRIORITY, ...MEDIUM_PRIORITY, ...LOW_PRIORITY]
  }

  const results: BatchResult[] = []
  const plog = await PipelineLogger.start(`batch-enrich-${periodParam}`, { period: periodParam, enrichAll, platforms })

  // Checkpoint: resume from last crash point (skip already-enriched platforms)
  const checkpoint = await PipelineCheckpoint.startOrResume('enrich', periodParam)

  // Safety timeout: ensure plog gets called before Vercel kills the function at 300s.
  // Log as SUCCESS with partial note — enrichment resumes from checkpoint next run.
  // Fires at 250s (was 280s) to leave 50s for plog.success() to complete reliably.
  // Previous 280s left only 20s which wasn't enough under heavy load, causing 'running' entries
  // that got cleaned up as timeout by cleanup-stuck-logs after 30+ minutes.
  const SAFETY_TIMEOUT_MS = 240_000 // 240s for 300s limit (60s buffer)
  const safetyTimer = setTimeout(async () => {
    try {
      const enriched = results.filter(r => r.status === 'success').reduce((sum, r) => sum + (r.enriched || 0), 0)
      // Timeout the plog.success() call itself — if Supabase connection pool is exhausted,
      // plog.success() hangs and the pipeline_logs entry stays as 'running' forever.
      // Previous: no timeout → Vercel kills function at 300s → plog never finalizes → cleanup-stuck-logs marks as timeout after 30min
      await Promise.race([
        plog.success(enriched, { results, note: 'Safety timeout at 240s — partial enrichment, will resume from checkpoint' }),
        new Promise<void>((resolve) => setTimeout(resolve, 30_000)), // 30s timeout for DB write
      ])
    } catch (err) {
      try { await plog.error(new Error(`Safety timeout + plog.success failed: ${err}`)) } catch { /* truly best effort */ }
    }
  }, SAFETY_TIMEOUT_MS)

  // Per-platform enrichment timeout (2026-04-03 optimization)
  // Previous: 90s CEX / 120s onchain caused frequent timeouts
  // New strategy: Platform-specific timeouts based on actual data:
  //   - Batch-cached (bitunix, xt, etc.): 30s (no per-trader API calls)
  //   - Fast CEX APIs: 60s
  //   - Slow CEX/onchain: 120s
  //   - VPS scrapers: 180s (Playwright)
  const ONCHAIN_PLATFORMS = new Set(['gmx', 'jupiter_perps', 'hyperliquid', 'drift', 'aevo', 'gains'])
  const BATCH_CACHED = new Set(['bitunix', 'xt', 'blofin', 'bitfinex', 'toobit', 'coinex'])
  const VPS_SCRAPERS = new Set(['bybit'])
  
  function getPlatformTimeout(platform: string): number {
    if (VPS_SCRAPERS.has(platform)) return 180_000
    if (BATCH_CACHED.has(platform)) return 30_000
    if (ONCHAIN_PLATFORMS.has(platform)) return 120_000
    return 60_000 // Default for CEX APIs
  }

  const functionStart = Date.now()
  // Budget per period: divide 240s (leaving 60s buffer from 300s total) by number of periods
  const PER_PERIOD_BUDGET_MS = Math.floor(240_000 / periodsToRun.length)

  // Run each period sequentially (when period=all, this runs 90D → 30D → 7D)
  for (const period of periodsToRun) {
    // Bail early if we're running low on time (leave 30s for cleanup/logging)
    const elapsed = Date.now() - functionStart
    if (elapsed > 240_000) {
      results.push({ platform: '*', period, status: 'error', durationMs: 0, error: `Skipped: ${Math.round(elapsed / 1000)}s elapsed, <60s remaining (budget: 300s)` })
      continue
    }

    const periodStart = Date.now()

    // Run enrichments inline in parallel batches of 10 to fit within 270s budget.
    // With 27 platforms: 3 batches × ~90s = ~270s (tight but workable).
    // batch-cached platforms (bitunix, xt, etc.) complete in <5s, freeing time for API-per-trader ones.
    const BATCH_CONCURRENCY = 7
    for (let i = 0; i < platforms.length; i += BATCH_CONCURRENCY) {
      // Check per-period budget before starting next batch
      if (Date.now() - periodStart > PER_PERIOD_BUDGET_MS) {
        const remaining = platforms.slice(i)
        for (const p of remaining) {
          results.push({ platform: p, period, status: 'error', durationMs: 0, error: `Skipped: period budget ${Math.round(PER_PERIOD_BUDGET_MS / 1000)}s exhausted` })
        }
        break
      }
      const batch = platforms.slice(i, i + BATCH_CONCURRENCY)
      const batchResults = await Promise.allSettled(
        batch.map(async (platform): Promise<BatchResult> => {
          // Checkpoint: skip platforms already completed in a prior (crashed) run
          const checkpointKey = `${platform}:${period}`
          if (PipelineCheckpoint.isCompleted(checkpoint, checkpointKey)) {
            logger.info(`[checkpoint] Skipping ${checkpointKey} (already completed in prior run)`)
            return { platform, period, status: 'success', durationMs: 0, enriched: 0 }
          }
          const config = PLATFORM_LIMITS[platform]
          if (!config) return { platform, period, status: 'error', durationMs: 0, error: 'No config' }

          const limit = period === '90D' ? config.limit90 : period === '30D' ? config.limit30 : config.limit7
          const start = Date.now()

          // Offset rotation: each run enriches a different slice of the leaderboard
          // Counter stored in PipelineState, incremented per platform per period
          //
          // ROOT CAUSE FIX (2026-04-08): Previously wrapped at hardcoded 5000.
          // Many platforms have <2000 traders → offset > total → 0 enriched but
          // status=success → critical platforms because no data is updated.
          // Now we query the actual leaderboard size and wrap at the real count.
          let offset = 0
          let leaderboardSize: number | null = null
          try {
            const supabase = getSupabaseAdmin()
            const { count } = await supabase
              .from('leaderboard_ranks')
              .select('id', { count: 'exact', head: true })
              .eq('source', platform)
              .eq('season_id', period)
              .not('arena_score', 'is', null)
            leaderboardSize = count ?? null
          } catch (err) {
            logger.warn(`[batch-enrich] Failed to count leaderboard for ${platform}/${period}`, { error: err instanceof Error ? err.message : String(err) })
          }

          try {
            const { PipelineState } = await import('@/lib/services/pipeline-state')
            const rotationKey = `enrich:offset:${platform}:${period}`
            const prevOffset = await PipelineState.get<number>(rotationKey) ?? 0
            // Wrap at actual leaderboard size (or 5000 fallback). Reset to 0 if prev offset already exceeds size.
            const wrapAt = leaderboardSize && leaderboardSize > 0 ? leaderboardSize : 5000
            offset = prevOffset >= wrapAt ? 0 : prevOffset
            await PipelineState.set(rotationKey, (offset + limit) % wrapAt)
          } catch (err) {
            logger.warn(`[batch-enrich] Redis offset rotation failed for ${platform}/${period}, starting at 0`, {
              error: err instanceof Error ? err.message : String(err),
            })
          }

          try {
            // Wrap enrichment in a timeout to prevent stuck jobs
            const timeoutMs = getPlatformTimeout(platform)
            const result: EnrichmentResult = await Promise.race([
              runEnrichment({ platform, period, limit, offset }),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Enrichment ${platform}/${period} timed out after ${timeoutMs / 1000}s`)), timeoutMs)
              ),
            ])
            if (result.ok) {
              await PipelineCheckpoint.markCompleted(checkpoint, checkpointKey, result.summary.enriched ?? 0)
            } else {
              await PipelineCheckpoint.markFailed(checkpoint, checkpointKey, `${result.summary.failed} enrichments failed`)
            }
            return {
              platform, period,
              status: result.ok ? 'success' : 'error',
              durationMs: Date.now() - start,
              enriched: result.summary.enriched,
              failed: result.summary.failed,
              error: result.ok ? undefined : `${result.summary.failed} enrichments failed`,
            }
          } catch (err) {
            await PipelineCheckpoint.markFailed(checkpoint, checkpointKey, err instanceof Error ? err.message : String(err))
            return {
              platform, period,
              status: 'error',
              durationMs: Date.now() - start,
              error: err instanceof Error ? err.message : String(err),
            }
          }
        })
      )
      
      // Handle Promise.allSettled results
      const settled = batchResults.map(r => 
        r.status === 'fulfilled' ? r.value : {
          platform: 'unknown',
          period,
          status: 'error' as const,
          durationMs: 0,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason)
        }
      )
      results.push(...settled)
      
      const batchSucceeded = settled.filter(r => r.status === 'success').length
      const batchFailed = settled.length - batchSucceeded
      logger.info(`Batch ${period}: ${batchSucceeded} success, ${batchFailed} failed`)
    }
  }

  clearTimeout(safetyTimer)
  const succeeded = results.filter(r => r.status === 'success').length
  const failed = results.length - succeeded
  const failedItems = results.filter(r => r.status === 'error').map(r => `${r.platform}/${r.period}: ${r.error || 'unknown'}`)

  if (failed === 0) {
    await plog.success(succeeded, { results })
  } else if (succeeded > 0) {
    // Partial success: some platforms failed (including budget-exhausted) but others worked
    await plog.partialSuccess(succeeded, failedItems, { results })
  } else {
    // Total failure: all platforms failed
    await plog.error(
      new Error(`${failed}/${results.length} enrichments failed`),
      { results }
    )
  }

  // Finalize checkpoint and trigger downstream with trace metadata from checkpoint
  const traceMetadata = await PipelineCheckpoint.finalize(checkpoint, Date.now() - functionStart)
  if (succeeded > 0) {
    triggerDownstreamRefresh(`batch-enrich-${periodParam}`, traceMetadata)
  }

  return NextResponse.json({
    ok: failed === 0,
    period: periodParam,
    periodsRun: periodsToRun,
    platforms: platforms.length,
    succeeded,
    failed,
    failedItems: failedItems.length > 0 ? failedItems : undefined,
    results,
  })
}
