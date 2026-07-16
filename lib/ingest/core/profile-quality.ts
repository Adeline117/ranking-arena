import type { ParseCtx, ParsedProfile, Timeframe } from './types'

const DAY_MS = 86_400_000

export const PROFILE_SERIES_MAX_TAIL_AGE_MS = 48 * 60 * 60_000
export const PROFILE_SERIES_MAX_FUTURE_SKEW_MS = 24 * 60 * 60_000
export const PROFILE_SERIES_WINDOW_GRACE_DAYS = 7

export interface ProfileQualityReject {
  reason: string
  payload: Record<string, unknown>
}

export interface RequiredSeriesTailPolicy {
  requiredMetrics: readonly string[]
  maxTailAgeMs?: number
  maxFutureSkewMs?: number
  windowGraceDays?: number
}

interface MetricEvidence {
  point_count: number
  invalid_point_count: number
  first_at: string | null
  tail_at: string | null
}

function canonicalTimeframe(timeframe: Timeframe): 7 | 30 | 90 {
  return timeframe === 0 ? 90 : timeframe
}

function canonicalTimestamp(value: string): number | null {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return null
  return new Date(parsed).toISOString() === value ? parsed : null
}

/**
 * Validate a profile whose scalar metrics are derived from required chart
 * series. This is deliberately a whole-surface gate: one missing, malformed,
 * future, out-of-window, or stale required metric rejects the complete profile
 * before any stats/series/identity fields reach serving.
 *
 * Tails are computed by timestamp maximum, never array position, so replay is
 * deterministic for unsorted upstream payloads.
 */
export function validateRequiredSeriesTails(
  profile: ParsedProfile,
  ctx: ParseCtx,
  requestedTimeframe: Timeframe,
  policy: RequiredSeriesTailPolicy
): ProfileQualityReject[] {
  const timeframe = canonicalTimeframe(requestedTimeframe)
  const scrapedAtMs = canonicalTimestamp(ctx.scrapedAt)
  const maxTailAgeMs = policy.maxTailAgeMs ?? PROFILE_SERIES_MAX_TAIL_AGE_MS
  const maxFutureSkewMs = policy.maxFutureSkewMs ?? PROFILE_SERIES_MAX_FUTURE_SKEW_MS
  const windowGraceDays = policy.windowGraceDays ?? PROFILE_SERIES_WINDOW_GRACE_DAYS
  const blockingReasons: string[] = []
  const metrics: Record<string, MetricEvidence> = {}

  if (scrapedAtMs === null) blockingReasons.push('profile_reference_time_invalid')
  if (!profile.stats.some((stat) => stat.timeframe === timeframe)) {
    blockingReasons.push('profile_timeframe_mismatch')
  }

  for (const metric of policy.requiredMetrics) {
    const blocks = profile.series.filter(
      (series) => series.timeframe === timeframe && series.metric === metric
    )
    let pointCount = 0
    let invalidPointCount = 0
    let firstMs = Number.POSITIVE_INFINITY
    let tailMs = Number.NEGATIVE_INFINITY

    for (const block of blocks) {
      for (const point of block.points) {
        pointCount += 1
        const timestamp = canonicalTimestamp(point.ts)
        if (timestamp === null || !Number.isFinite(point.value)) {
          invalidPointCount += 1
          continue
        }
        firstMs = Math.min(firstMs, timestamp)
        tailMs = Math.max(tailMs, timestamp)
      }
    }

    metrics[metric] = {
      point_count: pointCount,
      invalid_point_count: invalidPointCount,
      first_at: Number.isFinite(firstMs) ? new Date(firstMs).toISOString() : null,
      tail_at: Number.isFinite(tailMs) ? new Date(tailMs).toISOString() : null,
    }

    if (pointCount === 0 || !Number.isFinite(tailMs)) {
      blockingReasons.push('profile_series_tail_missing')
      if (invalidPointCount > 0) blockingReasons.push('profile_series_point_invalid')
      continue
    }
    if (invalidPointCount > 0) blockingReasons.push('profile_series_point_invalid')
    if (scrapedAtMs !== null) {
      const oldestAllowedMs = scrapedAtMs - (timeframe + windowGraceDays) * DAY_MS
      if (tailMs > scrapedAtMs + maxFutureSkewMs) {
        blockingReasons.push('profile_series_tail_future')
      }
      if (scrapedAtMs - tailMs > maxTailAgeMs) {
        blockingReasons.push('profile_series_tail_stale')
      }
      if (firstMs < oldestAllowedMs) {
        blockingReasons.push('profile_series_point_outside_window')
      }
    }
  }

  const uniqueReasons = [...new Set(blockingReasons)]
  if (uniqueReasons.length === 0) return []

  return [
    {
      reason: uniqueReasons[0],
      payload: {
        requested_timeframe: requestedTimeframe,
        canonical_timeframe: timeframe,
        scraped_at: ctx.scrapedAt,
        required_metrics: [...policy.requiredMetrics],
        max_tail_age_ms: maxTailAgeMs,
        max_future_skew_ms: maxFutureSkewMs,
        window_grace_days: windowGraceDays,
        blocking_reasons: uniqueReasons,
        parsed_stats_timeframes: [...new Set(profile.stats.map((stat) => stat.timeframe))].sort(
          (left, right) => left - right
        ),
        metrics,
      },
    },
  ]
}
