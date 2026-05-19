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
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { triggerDownstreamRefresh } from '@/lib/cron/trigger-chain'
import { PipelineCheckpoint } from '@/lib/harness/pipeline-checkpoint'
import { acquireCronLock } from '@/lib/cron/with-cron-lock'

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
  bitunix: { limit90: 100, limit30: 80, limit7: 50 },
  xt: { limit90: 40, limit30: 30, limit7: 20 },
  // blofin: REMOVED 2026-04-09 — openapi.blofin.com returns 401 without auth,
  //         VPS SG is geo-blocked, CF Worker fallback chain ~70% failure rate.
  //         Data now comes exclusively from Mac Mini (scripts/openclaw/fetch-blofin.mjs)
  //         via headless:'new' Chrome + residential IP. Same pattern as phemex/lbank.
  //         Already in PLATFORM_ROUTES as mac_mini-only (lib/connectors/route-config.ts).
  bitfinex: { limit90: 50, limit30: 40, limit7: 30 },
  toobit: { limit90: 40, limit30: 30, limit7: 20 },
  coinex: { limit90: 80, limit30: 60, limit7: 40 },
  // Large CEX — API per trader (~0.5s/trader → max ~150 in 90s)
  binance_futures: { limit90: 60, limit30: 40, limit7: 30 },
  okx_futures: { limit90: 60, limit30: 40, limit7: 30 },
  htx_futures: { limit90: 40, limit30: 30, limit7: 20 },
  etoro: { limit90: 30, limit30: 25, limit7: 25 }, // was 100/80/80, concurrency 2 × 20s/trader = needs <9 at a time for 90s budget
  gateio: { limit90: 40, limit30: 30, limit7: 20 },
  mexc: { limit90: 40, limit30: 30, limit7: 20 },
  // DEX on-chain (~0.3s/trader → max ~300 in 120s, but leave margin)
  hyperliquid: { limit90: 200, limit30: 150, limit7: 150 },
  drift: { limit90: 200, limit30: 150, limit7: 150 },
  jupiter_perps: { limit90: 150, limit30: 100, limit7: 100 },
  gmx: { limit90: 100, limit30: 80, limit7: 80 },
  gains: { limit90: 80, limit30: 60, limit7: 60 },
  dydx: { limit90: 150, limit30: 100, limit7: 100 },
  aevo: { limit90: 100, limit30: 80, limit7: 80 },
  // Slow-tier CEX (rate-limited) — reduced limits to fit within 90s route timeout
  bitget_futures: { limit90: 40, limit30: 30, limit7: 30 }, // was 100/80/80, concurrency 3 × 18s/trader = needs <15 at a time
  btcc: { limit90: 30, limit30: 25, limit7: 25 }, // was 50/50/50
  okx_spot: { limit90: 40, limit30: 40, limit7: 40 },
  okx_web3: { limit90: 150, limit30: 100, limit7: 100 },
  // Additional platforms
  binance_web3: { limit90: 150, limit30: 100, limit7: 100 },
  binance_spot: { limit90: 150, limit30: 100, limit7: 100 },
  polymarket: { limit90: 100, limit30: 80, limit7: 80 },
  // VPS scrapers (slow — ~18s/trader via Playwright, max 5 in 90s timeout)
  bybit: { limit90: 5, limit30: 5, limit7: 5 },
  bybit_spot: { limit90: 5, limit30: 5, limit7: 5 },
  // Re-enabled 2026-05-19: data exists, enrichment was disabled too aggressively
  bingx: { limit90: 30, limit30: 20, limit7: 15 },
  weex: { limit90: 30, limit30: 20, limit7: 15 },
  kucoin: { limit90: 40, limit30: 30, limit7: 20 },
  // DEAD/DISABLED:
  // phemex: DEAD (API 404 since 2026-04) — Mac Mini scraper only
  // bingx_spot: REMOVED (no enrichment API)
  // blofin: REMOVED (401 auth + geo-block) — Mac Mini scraper only, see note above
  // lbank: Mac Mini scraper only (VPS scraper returns empty data)
}

// 2026-04-20: Tiered execution to prevent 40-77min timeout hangs
// Tier 1 (FAST): Batch-cached — no per-trader API calls, complete in <5s total
// Tier 2 (MEDIUM): API-per-trader with reasonable rate limits, complete in <60s per platform
// Tier 3 (SLOW): VPS scrapers / heavily rate-limited, can take 60-180s per platform
// Each tier has its own concurrency to prevent slow platforms from starving the time budget.
const TIER_FAST = [
  'bitunix',
  // bitfinex moved to MEDIUM — enrichment-runner internal timeout is 30s,
  // xt, toobit, coinex, btcc moved to MEDIUM — they use VPS scraper (15-30s)
]
const TIER_MEDIUM = [
  'binance_futures',
  'okx_futures',
  'hyperliquid',
  'jupiter_perps',
  'xt', // VPS scraper — moved from FAST
  'toobit', // VPS scraper — moved from FAST
  'coinex', // VPS scraper — moved from FAST
  'bitfinex', // enrichment needs 30s — moved from FAST
  'htx_futures',
  'gateio',
  'mexc',
  'drift',
  'gmx',
  'gains',
  'dydx',
  'aevo',
  'okx_spot',
  'okx_web3',
  'binance_web3',
  'binance_spot',
  'polymarket',
]
const TIER_SLOW = [
  'bitget_futures',
  'btcc',
  'etoro', // rate-limited CEX
  'bybit',
  'bybit_spot', // VPS scrapers
  'bingx', // re-enabled 2026-05-19 — via CF proxy, rate-limited
  'weex', // re-enabled 2026-05-19 — via VPS scraper
  'kucoin', // re-enabled 2026-05-19 — enrichment from leaderboard cache
]
// Concurrency per tier: fast can run all at once, medium in batches of 5, slow in batches of 3
// ROOT CAUSE FIX (2026-04-23): slow was 2 → 5 slow platforms ÷ 2 = 3 batches × 100s = 300s
// which exactly hit the Vercel maxDuration limit, causing 13 days of zombie jobs.
// With concurrency 3: 5 ÷ 3 = 2 batches × 55s = 110s (safe margin).
const TIER_CONCURRENCY = { fast: 8, medium: 8, slow: 3 } as const

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
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const periodParam = request.nextUrl.searchParams.get('period') || '90D'
  const tierParam = request.nextUrl.searchParams.get('tier')

  // Dedup lock: prevent overlapping executions of the same period
  const releaseLock = await acquireCronLock(`batch-enrich-${periodParam}-${tierParam || 'all'}`, {
    ttlSeconds: 300,
  })
  if (!releaseLock) {
    return NextResponse.json({ skipped: true, reason: 'already-running', period: periodParam })
  }
  try {
    const enrichAll = request.nextUrl.searchParams.get('all') === 'true'

    const VALID_PERIODS = ['7D', '30D', '90D'] as const
    type Period = (typeof VALID_PERIODS)[number]

    if (periodParam !== 'all' && !VALID_PERIODS.includes(periodParam as Period)) {
      return NextResponse.json(
        { error: 'Invalid period, must be 7D, 30D, 90D, or all' },
        { status: 400 }
      )
    }

    const periodsToRun: Period[] =
      periodParam === 'all' ? ['90D', '30D', '7D'] : [periodParam as Period]

    // ROOT CAUSE FIX (2026-04-26): 41 platforms x DB overhead = 350s+, exceeds 300s Vercel limit.
    // Split via &tier= param: fast (18 platforms ~24s) or slow (17 medium + 5 slow ~165s)
    const tierParam = request.nextUrl.searchParams.get('tier')
    // Determine which platforms to enrich — organized by tier for budget-aware execution
    // 2026-04-20: Tiered execution prevents slow platforms from consuming the entire time budget
    // All tiers run by default (enrichAll flag reserved for future use)
    const platforms =
      tierParam === 'fast'
        ? [...TIER_FAST]
        : tierParam === 'slow'
          ? [...TIER_MEDIUM, ...TIER_SLOW]
          : [...TIER_FAST, ...TIER_MEDIUM, ...TIER_SLOW]

    // Build tier membership set for efficient lookup during batch execution
    const tierFastSet = new Set(TIER_FAST)
    const tierSlowSet = new Set(TIER_SLOW)

    const results: BatchResult[] = []
    const startedAt = Date.now()
    const plog = await PipelineLogger.start(
      `batch-enrich-${periodParam}${tierParam ? '-' + tierParam : ''}`,
      {
        period: periodParam,
        enrichAll,
        platforms,
      }
    )

    // Checkpoint: resume from last crash point (skip already-enriched platforms)
    const checkpoint = await PipelineCheckpoint.startOrResume('enrich', periodParam)

    // ────────────────────────────────────────────────────────────────
    // Time budget + hard-deadline watchdog
    // ────────────────────────────────────────────────────────────────
    // Shared elapsed helper used by the soft per-platform budget check and the
    // hard-deadline watchdog below.
    //
    // Root cause we are guarding against: a per-platform enrichment can hang
    // inside runEnrichment() (CF proxy stall, VPS scraper Playwright lock-up,
    // OKX retry storm, etc.) past the per-platform timeout wrapper — or the
    // cumulative time across batches can push total runtime past Vercel's
    // 300s maxDuration before the soft budget check between batches has a
    // chance to bail. When that happens the function gets killed mid-query,
    // plog never finalizes, and cleanup-stuck-logs sweeps it 30 min later as
    // "enrich-<platform> stuck >30min".
    //
    // Fix: (1) soft gate — skip remaining platforms if not enough budget
    // remains (already enforced by the periodBudget check below); (2) hard
    // gate — a setTimeout watchdog at 270s that forcibly finalizes plog with
    // partialSuccess so cleanup-stuck-logs never sees it. The main flow
    // clears the watchdog on normal exit and checks `plogFinalized` before
    // any downstream finalization so we never double-log the plog entry.
    const TIME_BUDGET_MS = 240_000 // soft gate — 60s buffer
    const HARD_DEADLINE_MS = 270_000 // hard gate — 30s buffer for plog write
    const elapsed = () => Date.now() - startedAt
    const isOutOfTime = (buffer: number = 10_000) => elapsed() + buffer >= TIME_BUDGET_MS
    let plogFinalized = false
    const watchdog = setTimeout(async () => {
      if (plogFinalized) return
      plogFinalized = true
      logger.error(
        `[batch-enrich] HARD DEADLINE hit at ${Math.round(elapsed() / 1000)}s — finalizing plog as partialSuccess`
      )
      try {
        const enriched = results
          .filter((r) => r.status === 'success')
          .reduce((sum, r) => sum + (r.enriched || 0), 0)
        const failedItems = results
          .filter((r) => r.status === 'error')
          .map((r) => `${r.platform}/${r.period}: ${r.error || 'unknown'}`)
        // Timeout the plog write itself — if Supabase connection pool is
        // exhausted, plog.partialSuccess() hangs and the pipeline_logs entry
        // stays 'running' forever (the exact symptom this patch fixes).
        await Promise.race([
          plog.partialSuccess(enriched, failedItems, {
            results,
            reason: 'hard_deadline_watchdog',
            elapsedMs: elapsed(),
            note: 'Hard deadline at 270s — partial enrichment, will resume from checkpoint',
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 20_000)),
        ])
      } catch (err) {
        try {
          await plog.error(
            new Error(
              `Hard deadline + plog finalize failed: ${err instanceof Error ? err.message : String(err)}`
            )
          )
        } catch {
          /* truly best effort */
        }
      }
    }, HARD_DEADLINE_MS)

    // Per-platform enrichment timeout (2026-04-20 rewrite)
    // Each tier gets a fixed timeout cap per platform. The route-level timeout
    // MUST be shorter than the enrichment-runner's internal timeout to ensure
    // the Promise.race here fires first, allowing us to mark the platform as
    // timed out and continue to the next one without the watchdog firing.
    // Root cause fix: binance_futures (60 traders × VPS proxy) and hyperliquid
    // (200 traders × API) consistently need >35s. They were timing out at the
    // default 35s medium tier budget, causing 54+ alerts. Platform-specific
    // overrides for known slow enrichments.
    const ENRICH_PLATFORM_TIMEOUTS: Record<string, number> = {
      binance_futures: 55_000,
      okx_futures: 50_000,
      hyperliquid: 55_000,
    }
    function getRoutePlatformTimeout(platform: string): number {
      if (ENRICH_PLATFORM_TIMEOUTS[platform]) return ENRICH_PLATFORM_TIMEOUTS[platform]
      if (tierFastSet.has(platform)) return 15_000
      if (tierSlowSet.has(platform)) return 45_000
      return 35_000 // medium tier default
    }

    // Budget per period: divide 240s (leaving 60s buffer from 300s total) by number of periods
    const PER_PERIOD_BUDGET_MS = Math.floor(TIME_BUDGET_MS / periodsToRun.length)

    // ── Helper: run a batch of platforms with given concurrency ────────
    async function runPlatformBatch(
      platformList: string[],
      concurrency: number,
      period: string,
      periodStart: number
    ): Promise<boolean> {
      for (let i = 0; i < platformList.length; i += concurrency) {
        // Hard budget gate: if we're within 30s of the hard deadline, skip remaining
        if (isOutOfTime(30_000)) {
          const remaining = platformList.slice(i)
          for (const p of remaining) {
            results.push({
              platform: p,
              period,
              status: 'error',
              durationMs: 0,
              error: `Skipped: hard budget reached (${Math.round(elapsed() / 1000)}s elapsed)`,
            })
          }
          return false // signal: time exhausted
        }
        // Check per-period budget
        if (Date.now() - periodStart > PER_PERIOD_BUDGET_MS) {
          const remaining = platformList.slice(i)
          for (const p of remaining) {
            results.push({
              platform: p,
              period,
              status: 'error',
              durationMs: 0,
              error: `Skipped: period budget ${Math.round(PER_PERIOD_BUDGET_MS / 1000)}s exhausted`,
            })
          }
          return false
        }

        const batch = platformList.slice(i, i + concurrency)
        // Per-batch deadline: the entire batch (all concurrent platforms) must complete
        // within the lesser of: remaining period budget, or 2× the max single-platform timeout in this batch.
        // This prevents a single batch from consuming the entire remaining budget.
        const maxPlatformTimeout = Math.max(...batch.map((p) => getRoutePlatformTimeout(p)))
        const remainingBudget = PER_PERIOD_BUDGET_MS - (Date.now() - periodStart)
        const batchDeadline = Math.min(remainingBudget, maxPlatformTimeout + 10_000) // platform timeout + 10s grace

        const batchResults = await Promise.race([
          Promise.allSettled(
            batch.map(async (platform): Promise<BatchResult> => {
              // Checkpoint: skip platforms already completed in a prior (crashed) run
              const checkpointKey = `${platform}:${period}`
              if (PipelineCheckpoint.isCompleted(checkpoint, checkpointKey)) {
                logger.info(
                  `[checkpoint] Skipping ${checkpointKey} (already completed in prior run)`
                )
                return { platform, period, status: 'success', durationMs: 0, enriched: 0 }
              }
              const config = PLATFORM_LIMITS[platform]
              if (!config)
                return { platform, period, status: 'error', durationMs: 0, error: 'No config' }

              const limit =
                period === '90D'
                  ? config.limit90
                  : period === '30D'
                    ? config.limit30
                    : config.limit7
              const start = Date.now()

              // Offset rotation
              let offset = 0
              let leaderboardSize: number | null = null
              try {
                const supabase = getSupabaseAdmin()
                const { data: cacheRow } = await supabase
                  .from('leaderboard_count_cache')
                  .select('total_count')
                  .eq('season_id', period)
                  .eq('source', `${platform}_gt0`)
                  .maybeSingle()
                leaderboardSize = cacheRow?.total_count ?? null
              } catch (err) {
                logger.warn(
                  `[batch-enrich] Failed to read leaderboard_count_cache for ${platform}/${period}`,
                  { error: err instanceof Error ? err.message : String(err) }
                )
              }

              try {
                const { PipelineState } = await import('@/lib/services/pipeline-state')
                const rotationKey = `enrich:offset:${platform}:${period}`
                const prevOffset = (await PipelineState.get<number>(rotationKey)) ?? 0
                const wrapAt = leaderboardSize && leaderboardSize > 0 ? leaderboardSize : 5000
                offset = prevOffset >= wrapAt ? 0 : prevOffset
                await PipelineState.set(rotationKey, (offset + limit) % wrapAt)
              } catch (err) {
                logger.warn(
                  `[batch-enrich] Redis offset rotation failed for ${platform}/${period}, starting at 0`,
                  {
                    error: err instanceof Error ? err.message : String(err),
                  }
                )
              }

              try {
                // Route-level timeout wraps runEnrichment to guarantee bail-out
                const timeoutMs = getRoutePlatformTimeout(platform)
                // Pass timeBudgetMs so runEnrichment can bail gracefully between
                // trader batches instead of being killed mid-operation by Promise.race.
                // This prevents partial DB writes from abandoned enrichment runs.
                const result: EnrichmentResult = await Promise.race([
                  runEnrichment({
                    platform,
                    period,
                    limit,
                    offset,
                    timeBudgetMs: timeoutMs - 2000,
                  }),
                  new Promise<never>((_, reject) =>
                    setTimeout(
                      () =>
                        reject(
                          new Error(
                            `Enrichment ${platform}/${period} timed out after ${timeoutMs / 1000}s`
                          )
                        ),
                      timeoutMs
                    )
                  ),
                ])
                if (result.ok) {
                  await PipelineCheckpoint.markCompleted(
                    checkpoint,
                    checkpointKey,
                    result.summary.enriched ?? 0
                  )
                } else {
                  await PipelineCheckpoint.markFailed(
                    checkpoint,
                    checkpointKey,
                    `${result.summary.failed} enrichments failed`
                  )
                }
                return {
                  platform,
                  period,
                  status: result.ok ? 'success' : 'error',
                  durationMs: Date.now() - start,
                  enriched: result.summary.enriched,
                  failed: result.summary.failed,
                  error: result.ok ? undefined : `${result.summary.failed} enrichments failed`,
                }
              } catch (err) {
                await PipelineCheckpoint.markFailed(
                  checkpoint,
                  checkpointKey,
                  err instanceof Error ? err.message : String(err)
                )
                return {
                  platform,
                  period,
                  status: 'error',
                  durationMs: Date.now() - start,
                  error: err instanceof Error ? err.message : String(err),
                }
              }
            })
          ),
          // Batch-level deadline: if the entire batch hasn't resolved, force-skip
          new Promise<PromiseSettledResult<BatchResult>[]>((resolve) =>
            setTimeout(() => {
              resolve(
                batch.map((p) => ({
                  status: 'fulfilled' as const,
                  value: {
                    platform: p,
                    period,
                    status: 'error' as const,
                    durationMs: batchDeadline,
                    error: `Batch deadline ${Math.round(batchDeadline / 1000)}s exceeded`,
                  },
                }))
              )
            }, batchDeadline)
          ),
        ])

        // Handle Promise.allSettled results
        const settled = batchResults.map((r) =>
          r.status === 'fulfilled'
            ? r.value
            : {
                platform: 'unknown',
                period,
                status: 'error' as const,
                durationMs: 0,
                error: r.reason instanceof Error ? r.reason.message : String(r.reason),
              }
        )
        results.push(...settled)

        const batchSucceeded = settled.filter((r) => r.status === 'success').length
        const batchFailed = settled.length - batchSucceeded
        logger.info(
          `Batch ${period} [${batch.join(',')}]: ${batchSucceeded} ok, ${batchFailed} failed (${Math.round(elapsed() / 1000)}s total)`
        )
      }
      return true // all batches processed within budget
    }

    // Run each period sequentially (when period=all, this runs 90D → 30D → 7D)
    for (const period of periodsToRun) {
      // Bail early if we're running low on time (leave 60s buffer from 300s total)
      if (isOutOfTime(60_000)) {
        results.push({
          platform: '*',
          period,
          status: 'error',
          durationMs: 0,
          error: `Skipped: ${Math.round(elapsed() / 1000)}s elapsed, <60s remaining (budget: 300s)`,
        })
        continue
      }

      const periodStart = Date.now()

      // 2026-04-20: Tiered execution — fast platforms first (high value, instant),
      // then medium (most coverage), then slow (VPS scrapers, rate-limited).
      // Each tier has its own concurrency. If time runs out during medium tier,
      // slow tier is skipped entirely (acceptable: slow platforms have very few traders
      // and are covered by checkpoint-resume on the next run).

      // Tier 1: FAST (batch-cached) — all at once, should complete in <5s total
      const fastPlatforms = platforms.filter((p) => tierFastSet.has(p))
      if (fastPlatforms.length > 0) {
        const ok = await runPlatformBatch(fastPlatforms, TIER_CONCURRENCY.fast, period, periodStart)
        if (!ok) continue // budget exhausted, skip to next period
      }

      // Tier 2: MEDIUM (API-per-trader) — batches of 5, most coverage here
      const mediumPlatforms = platforms.filter((p) => !tierFastSet.has(p) && !tierSlowSet.has(p))
      if (mediumPlatforms.length > 0) {
        const ok = await runPlatformBatch(
          mediumPlatforms,
          TIER_CONCURRENCY.medium,
          period,
          periodStart
        )
        if (!ok) continue
      }

      // Tier 3: SLOW (VPS scrapers, rate-limited) — batches of 2, run last
      const slowPlatforms = platforms.filter((p) => tierSlowSet.has(p))
      if (slowPlatforms.length > 0) {
        await runPlatformBatch(slowPlatforms, TIER_CONCURRENCY.slow, period, periodStart)
      }
    }

    // Main flow finished normally — clear the hard-deadline watchdog so it
    // doesn't fire after we've already finalized below.
    clearTimeout(watchdog)

    const succeeded = results.filter((r) => r.status === 'success').length
    const failed = results.length - succeeded
    const failedItems = results
      .filter((r) => r.status === 'error')
      .map((r) => `${r.platform}/${r.period}: ${r.error || 'unknown'}`)

    // If the watchdog already finalized plog (race: it fired while we were
    // wrapping up the last batch), skip re-finalization — plog state is
    // terminal after the first call and a second write would either be a
    // no-op or produce a duplicate row.
    if (!plogFinalized) {
      plogFinalized = true
      if (failed === 0) {
        await plog.success(succeeded, { results })
      } else if (succeeded > 0) {
        // Partial success: some platforms failed (including budget-exhausted) but others worked
        await plog.partialSuccess(succeeded, failedItems, { results })
      } else {
        // Total failure: all platforms failed
        await plog.error(new Error(`${failed}/${results.length} enrichments failed`), { results })
      }
    }

    // Fallback: if plog.success() silently timed out (withDbTimeout 15s cap),
    // pipeline_logs stays 'running' forever. Direct UPDATE as safety net.
    try {
      const { getSupabaseAdmin } = await import('@/lib/supabase/server')
      const fallbackDb = getSupabaseAdmin()
      await Promise.race([
        fallbackDb
          .from('pipeline_logs')
          .update({
            status: failed === 0 ? 'success' : 'error',
            records_processed: succeeded,
            ended_at: new Date().toISOString(),
            error_message: failed > 0 ? failedItems.join('; ').slice(0, 500) : null,
          })
          .eq('job_name', `batch-enrich-${periodParam}${tierParam ? '-' + tierParam : ''}`)
          .eq('status', 'running')
          .order('started_at', { ascending: false })
          .limit(1),
        new Promise((r) => setTimeout(r, 10000)),
      ])
    } catch {
      /* non-blocking fallback */
    }

    // Finalize checkpoint and trigger downstream with trace metadata from checkpoint
    const traceMetadata = await PipelineCheckpoint.finalize(checkpoint, elapsed())
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
  } finally {
    await releaseLock()
  }
}
