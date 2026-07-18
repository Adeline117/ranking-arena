/**
 * Pipeline Health API - designed for external monitoring (OpenClaw)
 *
 * GET /api/health/pipeline
 * Returns per-job health status, per-platform data freshness,
 * success rates, recent failures, and an overall pipeline health score.
 *
 * Auth: Requires CRON_SECRET or service role key
 */

import { NextRequest, NextResponse } from 'next/server'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { DEAD_BLOCKED_PLATFORMS, EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { tieredGet, tieredSet } from '@/lib/cache/redis-layer'
import { getFireAndForgetStats, logger } from '@/lib/utils/logger'
import { verifyAdminAuth } from '@/lib/auth/verify-service-auth'
import { getRateLimitStats } from '@/lib/ratelimit/TokenBucket'
import {
  buildPlatformHealth,
  classifyPlatformHealth,
  type PlatformFreshnessRow,
  type PlatformHealth,
} from '@/lib/services/platform-health'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Race any promise against a hard timeout — returns fallback if it exceeds the deadline.
 * Critical: /api/health/pipeline must never hang the monitor. Each sub-query gets a cap.
 * Accepts PromiseLike so Supabase query builders can be passed directly.
 */
async function withDeadline<T>(
  promise: PromiseLike<T>,
  ms: number,
  fallback: T,
  label: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        logger.warn(`[health/pipeline] ${label} exceeded ${ms}ms, returning fallback`)
        resolve(fallback)
      }
    }, ms)

    Promise.resolve(promise).then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(error)
      }
    )
  })
}

/**
 * Check per-platform data health from the active arena source registry.
 */
async function getPlatformHealthData(): Promise<PlatformHealth[]> {
  const supabase = getSupabaseAdmin()
  const now = Date.now()
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()

  // ROOT CAUSE FIX (2026-04-08): Was firing 62 parallel queries which exhausted
  // Supabase pool (60 connections). Now uses RPC with GROUP BY (1 query, returns
  // 1 row per platform — ~31 rows total, fast).
  //
  // ROOT CAUSE FIX (2026-04-09): Added per-query 10s deadlines. The RPC
  // occasionally hangs 30s+ under load and was causing the entire endpoint
  // (and therefore the external monitor) to time out. Individual queries must
  // fail fast so the overall response still returns within the monitor budget.
  const logsQuery = supabase
    .from('pipeline_logs')
    .select('job_name, records_processed')
    .eq('status', 'success')
    .gte('started_at', sevenDaysAgo)
    .not('records_processed', 'is', null)
    .gt('records_processed', 0)
    .then(({ data, error }) => ({ data, error }))
  const freshnessQuery = supabase.rpc('get_platform_freshness').then(
    ({
      data,
      error,
    }): {
      data: PlatformFreshnessRow[] | null
      error: unknown
    } => ({ data, error })
  )

  const [allLogsRes, lbLatestRes] = await Promise.all([
    withDeadline(logsQuery, 10_000, { data: [], error: null }, 'pipeline_logs records_processed'),
    // get_platform_freshness() returns FETCH freshness per source from
    // arena.leaderboard_snapshots.scraped_at (when last crawled) — not score
    // freshness, which would false-alert sources that fetched but weren't scored.
    // (Migrated off retiring trader_latest 2026-06-15; RPC keyed by legacy alias.)
    withDeadline(
      freshnessQuery,
      25_000,
      { data: null, error: new Error('platform freshness query timed out') },
      'platform_freshness'
    ),
  ])

  if (lbLatestRes.error || !lbLatestRes.data?.length) {
    throw new Error('active platform freshness authority is unavailable')
  }
  if (allLogsRes.error) {
    logger.warn('[health/pipeline] pipeline log averages are unavailable')
  }

  // The RPC returns one row for every active registry source, including
  // latest=null when a genuinely active source has never produced a snapshot.
  // Its rows are the complete platform authority: do not merge them with
  // SOURCES_WITH_DATA, which is historical and intentionally includes no
  // lifecycle state.
  return buildPlatformHealth({
    freshnessRows: lbLatestRes.data || [],
    logs: allLogsRes.data || [],
    now,
    getDisplayName: (platform) => {
      const config = EXCHANGE_CONFIG[platform as keyof typeof EXCHANGE_CONFIG]
      return config?.name || platform
    },
  })
}

export async function GET(req: NextRequest) {
  if (!(await verifyAdminAuth(req))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // Cache the entire health response for 2 minutes (health data doesn't change fast).
    //
    // ROOT CAUSE FIX (2026-04-09): previously used tieredGetOrSet which cached
    // EVERY response — including degraded ones where per-query deadlines fired
    // and returned empty fallbacks. A single transient PostgREST schema cache
    // blip would poison the cache for 15 minutes, making status=critical stick
    // around long after the underlying issue resolved.
    //
    // Fix: read cache first; if miss, compute; if computed result is degraded
    // (all queries returned empty fallbacks), return directly WITHOUT writing
    // to cache so the next request retries the underlying queries.
    // Cache key bumped 2026-04-09 v3 to bust the previous degraded entries
    // that got persisted before the OR-based degraded check landed (v2 used
    // AND which let partially-degraded responses through).
    // v4 (2026-04-16): added `circuits` field and circuit-based status
    // escalation; bump to avoid serving cached responses without circuit data.
    // v5 (2026-04-16): added `rateLimits` field + hot-exchange escalation.
    // v6 (2026-07-18): platform membership now comes from active arena.sources;
    // discard v5 entries that still contain retired/inactive static sources.
    const CACHE_KEY = 'api:health:pipeline:v6'
    const cached = await tieredGet(CACHE_KEY, 'warm')
    if (cached.data !== null) {
      // Defensive: even on cache hit, validate the cached entry isn't degraded.
      // ANY of the three lists empty == degraded (production has 100+ jobs and
      // 30+ platforms; legitimately empty is impossible).
      const cachedTyped = cached.data as {
        jobs?: unknown[]
        stats?: unknown[]
        platformHealth?: unknown[]
      }
      const cachedDegraded =
        (cachedTyped?.jobs?.length ?? 0) === 0 ||
        (cachedTyped?.stats?.length ?? 0) === 0 ||
        (cachedTyped?.platformHealth?.length ?? 0) === 0
      if (!cachedDegraded) {
        return NextResponse.json(cached.data, {
          headers: { 'Cache-Control': 'no-store', 'X-Cache': 'HIT' },
        })
      }
      // Fall through to recompute; degraded cache entries are ignored.
    }

    const compute = async () => {
      // Hard per-query deadlines: if any one query gets stuck, we still return
      // a (partial) response instead of hanging the monitor's fetch.
      const [jobStatuses, jobStats, recentFailuresRaw, platformHealth] = await Promise.all([
        withDeadline(PipelineLogger.getJobStatuses(), 15_000, [], 'getJobStatuses'),
        withDeadline(PipelineLogger.getJobStats(), 15_000, [], 'getJobStats'),
        withDeadline(PipelineLogger.getRecentFailures(10), 10_000, [], 'getRecentFailures'),
        withDeadline<PlatformHealth[] | null>(
          getPlatformHealthData(),
          20_000,
          null,
          'getPlatformHealthData'
        ),
      ])

      if (platformHealth === null) {
        throw new Error('active platform health computation timed out')
      }

      // Filter out dead/blocked platforms from failure counts
      const deadSet = new Set<string>([...DEAD_BLOCKED_PLATFORMS])
      const isDeadPlatformJob = (jobName: string) => {
        for (const dead of deadSet) {
          if (jobName.includes(dead)) return true
        }
        return false
      }
      const recentFailures = recentFailuresRaw.filter(
        (f: { job_name?: string }) => !isDeadPlatformJob(f.job_name || '')
      )

      // Calculate overall pipeline health (excluding dead platforms)
      const activeJobs = jobStatuses.filter((j) => !isDeadPlatformJob(j.job_name || ''))
      const totalJobs = activeJobs.length
      const healthyJobs = activeJobs.filter((j) => j.health_status === 'healthy').length
      const failedJobs = activeJobs.filter((j) => j.health_status === 'failed').length
      const staleJobs = activeJobs.filter((j) => j.health_status === 'stale').length
      const stuckJobs = activeJobs.filter((j) => j.health_status === 'stuck').length

      // Platform health summary
      const platformHealthy = platformHealth.filter((p) => p.status === 'healthy').length
      const platformWarning = platformHealth.filter((p) => p.status === 'warning').length
      const platformCritical = platformHealth.filter((p) => p.status === 'critical').length
      const platformNeverFetched = platformHealth.filter((p) => p.lastUpdate === null).length
      const platformStatus = classifyPlatformHealth(platformHealth)

      let overallStatus: 'healthy' | 'degraded' | 'critical' = 'healthy'
      // Root cause fix: previous thresholds were too aggressive:
      //   - stuckJobs > 0 → critical (one slow job = critical)
      //   - failedJobs > 0 → degraded (one transient failure = degraded)
      // With 60+ cron jobs running continuously, transient failures are expected.
      // New thresholds: tolerate up to 10% failures as normal, require >2 stuck
      // jobs for critical (single stuck is often just a slow run).
      const failedPct = totalJobs > 0 ? failedJobs / totalJobs : 0
      if (platformStatus === 'critical' || stuckJobs >= 3 || failedPct > 0.3) {
        overallStatus = 'critical'
      } else if (
        platformStatus === 'degraded' ||
        failedPct > 0.1 ||
        stuckJobs >= 1 ||
        staleJobs > totalJobs * 0.2 ||
        platformWarning > platformHealth.length * 0.3
      ) {
        overallStatus = 'degraded'
      }

      // Average success rate across active jobs only (exclude dead platforms)
      const activeStats = jobStats.filter((j) => !isDeadPlatformJob(j.job_name || ''))
      const avgSuccessRate =
        activeStats.length > 0
          ? activeStats.reduce((sum, j) => sum + (j.success_rate || 0), 0) / activeStats.length
          : 0

      // Background task failures — surface silent fireAndForget errors that
      // would otherwise only live in the serverless instance's memory. Only
      // labels with >= 3 failures (the escalation threshold) are included —
      // single transient failures are expected and not actionable.
      // Retro 2026-04-09: OpenClaw never saw these before this change.
      const rawFfStats = getFireAndForgetStats()
      const backgroundFailures = Object.entries(rawFfStats)
        .filter(([, s]) => s.count >= 3)
        .map(([label, s]) => ({
          label,
          count: s.count,
          lastError: s.lastError,
          lastAt: s.lastAt,
        }))
        .sort((a, b) => b.count - a.count)

      // Escalate status if many silent background failures detected
      if (backgroundFailures.length >= 5 && overallStatus === 'healthy') {
        overallStatus = 'degraded'
      }

      // ENDGAME (ARENA_DATA_SPEC v1.2): legacy connector circuit breakers
      // deleted with lib/connectors — the new ingest pipeline tracks failures
      // in arena.leaderboard_snapshots / freshness-sentinel instead. Keep the
      // response shape for OpenClaw consumers; always empty now.
      const rawCircuits: Record<string, string> = {}
      const circuits = {
        states: rawCircuits,
        open: Object.entries(rawCircuits)
          .filter(([, s]) => s === 'open')
          .map(([p]) => p),
        halfOpen: Object.entries(rawCircuits)
          .filter(([, s]) => s === 'half_open')
          .map(([p]) => p),
        total: Object.keys(rawCircuits).length,
      }

      // Any open circuit is at minimum a degraded state. 2+ open circuits
      // suggests systemic issue (upstream outage, our IP blocked, etc.) →
      // critical.
      if (circuits.open.length >= 2) {
        overallStatus = 'critical'
      } else if (circuits.open.length >= 1 && overallStatus === 'healthy') {
        overallStatus = 'degraded'
      }

      // Rate-limit stats per exchange. Denial rate > 10% means we're hitting
      // upstream throttles — useful early signal before circuit breakers
      // trip. In-memory (resets on cold start) so a fresh instance shows
      // empty. Surfaces `hotExchanges` (> 10% denial + at least 20 calls).
      const rawRateLimits = getRateLimitStats()
      const hotExchanges = Object.entries(rawRateLimits)
        .filter(([, s]) => s.denialRate > 10 && s.allowed + s.denied >= 20)
        .map(([exchange, s]) => ({ exchange, ...s }))
        .sort((a, b) => b.denialRate - a.denialRate)
      const rateLimits = {
        perExchange: rawRateLimits,
        hotExchanges,
      }

      // Escalate if multiple exchanges are hot (our IPs or keys are likely
      // being throttled across the board).
      if (hotExchanges.length >= 3 && overallStatus === 'healthy') {
        overallStatus = 'degraded'
      }

      return {
        status: overallStatus,
        timestamp: new Date().toISOString(),
        summary: {
          totalJobs,
          healthyJobs,
          failedJobs,
          staleJobs,
          stuckJobs,
          avgSuccessRate7d: Math.round(avgSuccessRate * 10) / 10,
          platformHealthy,
          platformWarning,
          platformCritical,
          platformNeverFetched,
          totalPlatforms: platformHealth.length,
          backgroundFailureCount: backgroundFailures.length,
          circuitsOpen: circuits.open.length,
          circuitsHalfOpen: circuits.halfOpen.length,
          hotRateLimitedExchanges: hotExchanges.length,
        },
        platformHealth,
        jobs: jobStatuses,
        stats: jobStats,
        recentFailures,
        backgroundFailures,
        circuits,
        rateLimits,
      }
    }

    const result = await compute()

    // Detect degraded response. ANY of these signals → degraded → skip cache.
    // Production has 100+ active cron jobs and 30+ platforms, so legitimately
    // empty jobs[] / stats[] is impossible. Empty == query failure.
    const isDegraded =
      result.jobs.length === 0 || result.stats.length === 0 || result.platformHealth.length === 0

    if (!isDegraded) {
      // Fire-and-forget cache write — don't block the response on Redis,
      // but log failures. If this silently fails, every request recomputes
      // the full health snapshot (~dozens of Supabase queries), masking the
      // Redis outage and inflating costs until someone notices.
      tieredSet(CACHE_KEY, result, 'warm', ['pipeline-health']).catch((cacheErr) => {
        logger.warn('[health/pipeline] Failed to cache pipeline health result', {
          error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
        })
      })
    }

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store',
        'X-Cache': 'MISS',
        'X-Degraded': isDegraded ? '1' : '0',
      },
    })
  } catch (err) {
    // This endpoint feeds OpenClaw / admin dashboard / Sentry alerting.
    // A silent 500 with no log means we lose the one monitor that would
    // tell us the monitor itself is broken. Always log.
    logger.error('[health/pipeline] Unhandled error while computing health snapshot', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    )
  }
}
