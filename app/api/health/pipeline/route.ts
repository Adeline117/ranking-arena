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
import { verifyAdminAuthResult, type AdminAuthResult } from '@/lib/auth/verify-service-auth'
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

// The shortest production caller aborts at 15s. Every phase consumes one shared
// absolute handler budget instead of adding independent sequential ceilings.
const HANDLER_DEADLINE_MS = 9_500
const RESPONSE_RESERVE_MS = 250
const CACHE_READ_DEADLINE_MS = 1_000
const ADMIN_AUTH_DEADLINE_MS = 3_000
const FAST_QUERY_DEADLINE_MS = 6_000
const DATABASE_QUERY_DEADLINE_MS = 7_500
const PLATFORM_HEALTH_DEADLINE_MS = 8_000
const COMPUTE_DEADLINE_MS = 9_000

interface RequestDeadline {
  signal: AbortSignal
  remaining: (phaseCapMs: number) => number
  close: () => void
}

function createRequestDeadline(): RequestDeadline {
  const controller = new AbortController()
  const deadlineAt = Date.now() + HANDLER_DEADLINE_MS
  const timeout = setTimeout(
    () => controller.abort(new Error('pipeline health deadline exceeded')),
    HANDLER_DEADLINE_MS
  )

  return {
    signal: controller.signal,
    remaining: (phaseCapMs) =>
      Math.max(0, Math.min(phaseCapMs, deadlineAt - Date.now() - RESPONSE_RESERVE_MS)),
    close: () => {
      clearTimeout(timeout)
      if (!controller.signal.aborted)
        controller.abort(new Error('pipeline health response complete'))
    },
  }
}

function buildUnavailableSnapshot(
  code: string,
  message: string,
  unavailableAuthority = 'pipeline_database'
) {
  return {
    status: 'critical' as const,
    timestamp: new Date().toISOString(),
    summary: {
      totalJobs: 0,
      healthyJobs: 0,
      failedJobs: 0,
      staleJobs: 0,
      stuckJobs: 0,
      avgSuccessRate7d: 0,
      platformHealthy: 0,
      platformWarning: 0,
      platformCritical: 0,
      platformNeverFetched: 0,
      totalPlatforms: 0,
      backgroundFailureCount: 0,
      circuitsOpen: 0,
      circuitsHalfOpen: 0,
      hotRateLimitedExchanges: 0,
    },
    platformHealth: [],
    jobs: [],
    stats: [],
    recentFailures: [],
    authority: { status: 'unavailable' as const, unavailable: [unavailableAuthority] },
    backgroundFailures: [],
    circuits: { states: {}, open: [], halfOpen: [], total: 0 },
    rateLimits: { perExchange: {}, hotExchanges: [] },
    error: { code, message },
  }
}

/**
 * Start an operation lazily with a linked AbortSignal and return its fallback
 * when either the phase cap or the request's absolute deadline is exhausted.
 */
async function withDeadline<T>(
  deadline: RequestDeadline,
  phaseCapMs: number,
  fallback: T,
  label: string,
  operation: (signal: AbortSignal) => PromiseLike<T>,
  parentSignal: AbortSignal = deadline.signal
): Promise<T> {
  const ms = deadline.remaining(phaseCapMs)
  if (ms <= 0 || deadline.signal.aborted || parentSignal.aborted) {
    logger.warn(`[health/pipeline] ${label} skipped because the request deadline is exhausted`)
    return fallback
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const controller = new AbortController()
    const parentSignals =
      parentSignal === deadline.signal ? [deadline.signal] : [deadline.signal, parentSignal]
    const abortListeners = parentSignals.map((signal) => {
      const listener = () => {
        if (!controller.signal.aborted) controller.abort(signal.reason)
        if (!settled) {
          settled = true
          cleanup()
          resolve(fallback)
        }
      }
      signal.addEventListener('abort', listener, { once: true })
      return { signal, listener }
    })
    const cleanup = () => {
      clearTimeout(timeout)
      for (const { signal, listener } of abortListeners) {
        signal.removeEventListener('abort', listener)
      }
    }
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        controller.abort(new Error(`${label} deadline exceeded`))
        cleanup()
        logger.warn(`[health/pipeline] ${label} exceeded ${ms}ms, returning fallback`)
        resolve(fallback)
      }
    }, ms)

    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(value)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          cleanup()
          reject(error)
        }
      )
  })
}

/**
 * Check per-platform data health from the active arena source registry.
 */
async function getPlatformHealthData(
  deadline: RequestDeadline,
  parentSignal: AbortSignal
): Promise<PlatformHealth[]> {
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
  const [allLogsRes, lbLatestRes] = await Promise.all([
    withDeadline(
      deadline,
      FAST_QUERY_DEADLINE_MS,
      {
        data: [],
        error: {
          name: 'PostgrestError',
          message: 'pipeline log averages query timed out',
          details: '',
          hint: '',
          code: 'HEALTH_TIMEOUT',
        },
      },
      'pipeline_logs records_processed',
      (signal) =>
        supabase
          .from('pipeline_logs')
          .select('job_name, records_processed')
          .eq('status', 'success')
          .gte('started_at', sevenDaysAgo)
          .not('records_processed', 'is', null)
          .gt('records_processed', 0)
          .abortSignal(signal)
          .then(({ data, error }) => ({ data, error })),
      parentSignal
    ),
    // get_platform_freshness() returns FETCH freshness per source from
    // arena.leaderboard_snapshots.scraped_at (when last crawled) — not score
    // freshness, which would false-alert sources that fetched but weren't scored.
    // (Migrated off retiring trader_latest 2026-06-15; RPC keyed by legacy alias.)
    withDeadline(
      deadline,
      DATABASE_QUERY_DEADLINE_MS,
      { data: null, error: new Error('platform freshness query timed out') },
      'platform_freshness',
      (signal) =>
        supabase
          .rpc('get_platform_freshness')
          .abortSignal(signal)
          .then(
            ({
              data,
              error,
            }): {
              data: PlatformFreshnessRow[] | null
              error: unknown
            } => ({ data, error })
          ),
      parentSignal
    ),
  ])

  if (lbLatestRes.error || !lbLatestRes.data?.length) {
    throw new Error('active platform freshness authority is unavailable')
  }
  if (allLogsRes.error) {
    throw new Error('pipeline log averages authority is unavailable')
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
  const deadline = createRequestDeadline()
  try {
    let authResult: AdminAuthResult | { status: 'timed_out' }
    try {
      authResult = await withDeadline<AdminAuthResult | { status: 'timed_out' }>(
        deadline,
        ADMIN_AUTH_DEADLINE_MS,
        { status: 'timed_out' },
        'admin authentication',
        (signal) => verifyAdminAuthResult(req, { signal })
      )
    } catch (err) {
      const internalMessage = err instanceof Error ? err.message : String(err)
      logger.error('[health/pipeline] Admin authentication authority failed', {
        error: internalMessage,
      })
      const message = 'Pipeline health authentication authority is unavailable'
      return NextResponse.json(
        buildUnavailableSnapshot('PIPELINE_AUTH_UNAVAILABLE', message, 'admin_auth'),
        {
          status: 503,
          headers: { 'Cache-Control': 'no-store', 'X-Cache': 'MISS', 'X-Degraded': '1' },
        }
      )
    }
    if (authResult.status === 'timed_out') {
      const message = `Pipeline health authentication authority timed out after ${ADMIN_AUTH_DEADLINE_MS}ms`
      return NextResponse.json(
        buildUnavailableSnapshot('PIPELINE_AUTH_TIMEOUT', message, 'admin_auth'),
        {
          status: 503,
          headers: { 'Cache-Control': 'no-store', 'X-Cache': 'MISS', 'X-Degraded': '1' },
        }
      )
    }
    if (authResult.status === 'unavailable') {
      logger.error('[health/pipeline] Admin authentication authority failed', {
        error:
          authResult.error instanceof Error ? authResult.error.message : String(authResult.error),
      })
      const message = 'Pipeline health authentication authority is unavailable'
      return NextResponse.json(
        buildUnavailableSnapshot('PIPELINE_AUTH_UNAVAILABLE', message, 'admin_auth'),
        {
          status: 503,
          headers: { 'Cache-Control': 'no-store', 'X-Cache': 'MISS', 'X-Degraded': '1' },
        }
      )
    }
    if (authResult.status === 'invalid') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

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
    // v7 (2026-07-28): cache entries must carry an explicit authority verdict;
    // never reuse a snapshot that masked an empty database result as healthy.
    const CACHE_KEY = 'api:health:pipeline:v7'
    const cached = await withDeadline(
      deadline,
      CACHE_READ_DEADLINE_MS,
      { data: null, layer: null },
      'cache read',
      () => tieredGet(CACHE_KEY, 'warm')
    )
    if (cached.data !== null) {
      // Defensive: even on cache hit, validate the cached entry isn't degraded.
      // ANY of the three lists empty == degraded (production has 100+ jobs and
      // 30+ platforms; legitimately empty is impossible).
      const cachedTyped = cached.data as {
        jobs?: unknown[]
        stats?: unknown[]
        platformHealth?: unknown[]
        authority?: { status?: string }
      }
      const cachedDegraded =
        (cachedTyped?.jobs?.length ?? 0) === 0 ||
        (cachedTyped?.stats?.length ?? 0) === 0 ||
        (cachedTyped?.platformHealth?.length ?? 0) === 0 ||
        cachedTyped?.authority?.status !== 'available'
      if (!cachedDegraded) {
        return NextResponse.json(cached.data, {
          headers: { 'Cache-Control': 'no-store', 'X-Cache': 'HIT' },
        })
      }
      // Fall through to recompute; degraded cache entries are ignored.
    }

    const compute = async (parentSignal: AbortSignal) => {
      // Hard per-query deadlines: if any one query gets stuck, we still return
      // a (partial) response instead of hanging the monitor's fetch.
      const [jobStatuses, jobStats, recentFailuresRaw, platformHealth] = await Promise.all([
        withDeadline(
          deadline,
          DATABASE_QUERY_DEADLINE_MS,
          [],
          'getJobStatuses',
          (signal) => PipelineLogger.getJobStatuses(signal),
          parentSignal
        ),
        withDeadline(
          deadline,
          DATABASE_QUERY_DEADLINE_MS,
          [],
          'getJobStats',
          (signal) => PipelineLogger.getJobStats(signal),
          parentSignal
        ),
        withDeadline<Awaited<ReturnType<typeof PipelineLogger.getRecentFailures>> | null>(
          deadline,
          FAST_QUERY_DEADLINE_MS,
          null,
          'getRecentFailures',
          (signal) => PipelineLogger.getRecentFailures(10, 120, signal, true),
          parentSignal
        ),
        withDeadline<PlatformHealth[] | null>(
          deadline,
          PLATFORM_HEALTH_DEADLINE_MS,
          null,
          'getPlatformHealthData',
          (signal) => getPlatformHealthData(deadline, signal),
          parentSignal
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
      const recentFailures = (recentFailuresRaw ?? []).filter(
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
      const unavailableAuthorities = [
        ...(jobStatuses.length === 0 ? ['job_statuses'] : []),
        ...(jobStats.length === 0 ? ['job_stats'] : []),
        ...(recentFailuresRaw === null ? ['recent_failures'] : []),
        ...(platformHealth.length === 0 ? ['platform_freshness'] : []),
      ]

      let overallStatus: 'healthy' | 'degraded' | 'critical' = 'healthy'
      // Root cause fix: previous thresholds were too aggressive:
      //   - stuckJobs > 0 → critical (one slow job = critical)
      //   - failedJobs > 0 → degraded (one transient failure = degraded)
      // With 60+ cron jobs running continuously, transient failures are expected.
      // New thresholds: tolerate up to 10% failures as normal, require >2 stuck
      // jobs for critical (single stuck is often just a slow run).
      const failedPct = totalJobs > 0 ? failedJobs / totalJobs : 0
      if (
        unavailableAuthorities.length > 0 ||
        platformStatus === 'critical' ||
        stuckJobs >= 3 ||
        failedPct > 0.3
      ) {
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
        authority: {
          status:
            unavailableAuthorities.length > 0 ? ('unavailable' as const) : ('available' as const),
          unavailable: unavailableAuthorities,
        },
        backgroundFailures,
        circuits,
        rateLimits,
      }
    }

    const result = await withDeadline<Awaited<ReturnType<typeof compute>> | null>(
      deadline,
      COMPUTE_DEADLINE_MS,
      null,
      'complete pipeline health computation',
      (signal) => compute(signal)
    )

    if (result === null) {
      const message = 'Pipeline health database authority exceeded the request deadline'
      logger.error('[health/pipeline] ' + message)
      return NextResponse.json(buildUnavailableSnapshot('PIPELINE_HEALTH_TIMEOUT', message), {
        status: 503,
        headers: { 'Cache-Control': 'no-store', 'X-Cache': 'MISS', 'X-Degraded': '1' },
      })
    }

    // Detect degraded response. ANY of these signals → degraded → skip cache.
    // Production has 100+ active cron jobs and 30+ platforms, so legitimately
    // empty jobs[] / stats[] is impossible. Empty == query failure.
    const isDegraded = result.authority.status === 'unavailable'

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
      status: isDegraded ? 503 : 200,
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
      buildUnavailableSnapshot(
        'PIPELINE_HEALTH_UNAVAILABLE',
        'Pipeline health authority is unavailable'
      ),
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store', 'X-Cache': 'MISS', 'X-Degraded': '1' },
      }
    )
  } finally {
    deadline.close()
  }
}
