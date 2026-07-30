/**
 * Cron: Data Reconciliation — detect and report data gaps
 * Schedule: Daily at 04:00 UTC
 *
 * Calls find_data_gaps() RPC to identify traders in trader_sources
 * that have no recent leaderboard data (>48h stale). Reports per-platform
 * summary via Telegram alert and stores results in pipeline_state for
 * the retry-dead-letters cron to act on.
 */

import { withCron } from '@/lib/api/with-cron'
import { PipelineState } from '@/lib/services/pipeline-state'
import { sendRateLimitedAlert } from '@/lib/alerts/send-alert'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const WORK_BUDGET_MS = 90_000
const MAX_AGE_HOURS = 48
const MAX_DETAIL_ROWS = 500

interface GapSummary {
  source: string
  gap_count: number
  avg_gap_hours: number
  max_gap_hours: number
}

interface GapDetail {
  source: string
  source_trader_id: string
  last_computed: string | null
  gap_hours: number
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function validIdentity(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value
  )
}

function parseGapSummary(payload: unknown): GapSummary[] {
  if (!Array.isArray(payload)) {
    throw new Error('get_data_gap_summary returned a non-array payload')
  }

  const sources = new Set<string>()
  return payload.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`get_data_gap_summary returned an invalid row at index ${index}`)
    }
    const row = value as Record<string, unknown>
    if (
      !exactKeys(row, ['avg_gap_hours', 'gap_count', 'max_gap_hours', 'source']) ||
      !validIdentity(row.source, 100) ||
      !Number.isSafeInteger(row.gap_count) ||
      (row.gap_count as number) < 1 ||
      typeof row.avg_gap_hours !== 'number' ||
      !Number.isFinite(row.avg_gap_hours) ||
      row.avg_gap_hours < MAX_AGE_HOURS ||
      typeof row.max_gap_hours !== 'number' ||
      !Number.isFinite(row.max_gap_hours) ||
      row.max_gap_hours < row.avg_gap_hours ||
      sources.has(row.source)
    ) {
      throw new Error(`get_data_gap_summary returned a malformed row at index ${index}`)
    }
    sources.add(row.source)
    return {
      source: row.source,
      gap_count: row.gap_count as number,
      avg_gap_hours: row.avg_gap_hours,
      max_gap_hours: row.max_gap_hours,
    }
  })
}

function parseGapDetails(
  payload: unknown,
  summary: readonly GapSummary[],
  now: number
): GapDetail[] {
  if (!Array.isArray(payload) || !Number.isFinite(now)) {
    throw new Error('find_data_gaps returned an invalid payload')
  }
  if (payload.length === 0 && summary.length > 0) {
    throw new Error('find_data_gaps returned no details for a non-empty summary')
  }
  if (payload.length > MAX_DETAIL_ROWS) {
    throw new Error('find_data_gaps exceeded its requested row limit')
  }

  const summaryCounts = new Map(summary.map((row) => [row.source, row.gap_count]))
  const detailCounts = new Map<string, number>()
  const identities = new Set<string>()

  return payload.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`find_data_gaps returned an invalid row at index ${index}`)
    }
    const row = value as Record<string, unknown>
    const lastComputed = row.last_computed
    const computedAt = typeof lastComputed === 'string' ? Date.parse(lastComputed) : null
    const identity = `${String(row.source)}\u0000${String(row.source_trader_id)}`
    const nextSourceCount = (detailCounts.get(String(row.source)) ?? 0) + 1
    if (
      !exactKeys(row, ['gap_hours', 'last_computed', 'source', 'source_trader_id']) ||
      !validIdentity(row.source, 100) ||
      !validIdentity(row.source_trader_id, 512) ||
      !summaryCounts.has(row.source) ||
      identities.has(identity) ||
      (lastComputed !== null &&
        (typeof lastComputed !== 'string' ||
          !Number.isFinite(computedAt) ||
          (computedAt as number) >= now - MAX_AGE_HOURS * 60 * 60 * 1000)) ||
      typeof row.gap_hours !== 'number' ||
      !Number.isFinite(row.gap_hours) ||
      row.gap_hours < MAX_AGE_HOURS ||
      nextSourceCount > (summaryCounts.get(row.source) ?? 0)
    ) {
      throw new Error(`find_data_gaps returned a malformed row at index ${index}`)
    }
    identities.add(identity)
    detailCounts.set(row.source, nextSourceCount)
    return {
      source: row.source,
      source_trader_id: row.source_trader_id,
      last_computed: lastComputed,
      gap_hours: row.gap_hours,
    }
  })
}

function alertText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export const GET = withCron(
  'data-reconciliation',
  async (_request, { supabase }) => {
    const workSignal = AbortSignal.timeout(WORK_BUDGET_MS)

    // 1. Get per-platform gap summary
    const { data: summaryPayload, error: summaryErr } = await supabase
      .rpc('get_data_gap_summary', {
        p_max_age_hours: MAX_AGE_HOURS,
      })
      .abortSignal(workSignal)

    if (summaryErr) {
      throw new Error(`get_data_gap_summary failed: ${summaryErr.message}`)
    }
    workSignal.throwIfAborted()

    const gaps = parseGapSummary(summaryPayload)

    if (gaps.length === 0) {
      return { count: 0, message: 'No data gaps detected' }
    }
    const totalGaps = gaps.reduce((sum, gap) => sum + gap.gap_count, 0)
    if (!Number.isSafeInteger(totalGaps)) {
      throw new Error('get_data_gap_summary total is outside the safe integer range')
    }

    // 2. Get detailed gap list for top platforms (limited to 500 total)
    const { data: detailPayload, error: detailErr } = await supabase
      .rpc('find_data_gaps', {
        p_max_age_hours: MAX_AGE_HOURS,
        p_limit: MAX_DETAIL_ROWS,
      })
      .abortSignal(workSignal)

    if (detailErr) {
      throw new Error(`find_data_gaps failed: ${detailErr.message}`)
    }
    workSignal.throwIfAborted()

    const gapDetails = parseGapDetails(detailPayload, gaps, Date.now())

    // 3. Group by platform and store in PipelineState for retry-dead-letters
    const byPlatform: Record<string, string[]> = {}
    for (const gap of gapDetails) {
      if (!byPlatform[gap.source]) byPlatform[gap.source] = []
      byPlatform[gap.source].push(gap.source_trader_id)
    }

    for (const [platform, traderIds] of Object.entries(byPlatform)) {
      workSignal.throwIfAborted()
      await PipelineState.set(
        `reconciliation:gaps:${platform}`,
        {
          traderIds: traderIds.slice(0, 100), // Cap per platform
          detectedAt: new Date().toISOString(),
          count: traderIds.length,
        },
        { signal: workSignal }
      )
    }

    // 4. Send summary alert
    const summaryLines = gaps
      .sort((a, b) => b.gap_count - a.gap_count)
      .slice(0, 15)
      .map(
        (g) =>
          `  ${alertText(g.source)}: ${g.gap_count} traders (avg ${g.avg_gap_hours}h, max ${g.max_gap_hours}h)`
      )

    const alertResult = await sendRateLimitedAlert(
      {
        title: `数据缺口报告: ${totalGaps} traders across ${gaps.length} platforms`,
        message: summaryLines.join('\n'),
        level: totalGaps > 1000 ? 'critical' : 'warning',
        details: { platforms: gaps.length, total_gaps: totalGaps },
      },
      'data-reconciliation:daily',
      20 * 60 * 60 * 1000 // 20h cooldown (daily job)
    )
    if (!alertResult.handled) {
      throw new Error('Data reconciliation alert delivery failed')
    }
    workSignal.throwIfAborted()

    return {
      count: totalGaps,
      platforms_affected: gaps.length,
      top_gaps: gaps.slice(0, 10),
    }
  },
  { safetyTimeoutMs: 115_000 }
)
