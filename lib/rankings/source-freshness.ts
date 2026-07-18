/**
 * Public leaderboard source-freshness contract.
 *
 * `computed_at` answers when Arena recomputed a score. It does not answer when
 * the exchange/protocol data was captured, so it must never be used as a
 * freshness fallback. These helpers deliberately fail closed when a source
 * watermark is missing or invalid.
 */

export const RANKING_SOURCE_STALE_MS = 48 * 60 * 60 * 1000
export const RANKING_SOURCE_FUTURE_TOLERANCE_MS = 5 * 60 * 1000

export interface SourceFreshnessRow {
  source: string
  source_as_of: string | null
}

export interface SourceFreshnessStatus {
  source: string
  updated_at: string | null
  is_stale: boolean
  age_seconds: number | null
}

export interface SourceFreshnessSummary {
  asOf: string | null
  isStale: boolean
  ageSeconds: number | null
  sources: SourceFreshnessStatus[]
}

function validTimestamp(value: string | null | undefined, nowMs: number): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp <= nowMs + RANKING_SOURCE_FUTURE_TOLERANCE_MS
    ? timestamp
    : null
}

/**
 * Build one conservative status per requested source.
 *
 * The watermark table has a unique (season_id, source) key, but duplicate rows
 * are still handled defensively by retaining the oldest valid watermark. A
 * missing/invalid watermark remains explicitly stale instead of becoming
 * "fresh now".
 */
export function buildSourceFreshnessStatuses(
  rows: readonly SourceFreshnessRow[],
  relevantSources: readonly string[],
  nowMs = Date.now()
): SourceFreshnessStatus[] {
  const oldestBySource = new Map<string, { timestamp: number; value: string }>()

  for (const row of rows) {
    const timestamp = validTimestamp(row.source_as_of, nowMs)
    if (timestamp == null) continue
    const current = oldestBySource.get(row.source)
    if (!current || timestamp < current.timestamp) {
      oldestBySource.set(row.source, { timestamp, value: new Date(timestamp).toISOString() })
    }
  }

  return [...new Set(relevantSources)].sort().map((source) => {
    const watermark = oldestBySource.get(source)
    if (!watermark) {
      return { source, updated_at: null, is_stale: true, age_seconds: null }
    }

    const ageMs = Math.max(0, nowMs - watermark.timestamp)
    return {
      source,
      updated_at: watermark.value,
      is_stale: ageMs > RANKING_SOURCE_STALE_MS,
      age_seconds: Math.floor(ageMs / 1000),
    }
  })
}

/**
 * Summarize a set of source statuses for the legacy page-level freshness
 * fields. The page watermark is the oldest source watermark because a newest
 * timestamp would hide one stale source behind another fresh source.
 */
export function summarizeSourceFreshness(
  rows: readonly SourceFreshnessRow[],
  relevantSources: readonly string[],
  nowMs = Date.now()
): SourceFreshnessSummary {
  const sources = buildSourceFreshnessStatuses(rows, relevantSources, nowMs)
  if (sources.length === 0 || sources.some((source) => source.updated_at == null)) {
    return { asOf: null, isStale: true, ageSeconds: null, sources }
  }

  const oldestTimestamp = Math.min(
    ...sources.map((source) => Date.parse(source.updated_at as string))
  )
  const ageSeconds = Math.floor(Math.max(0, nowMs - oldestTimestamp) / 1000)
  return {
    asOf: new Date(oldestTimestamp).toISOString(),
    isStale: sources.some((source) => source.is_stale),
    ageSeconds,
    sources,
  }
}

export function sourceFreshnessStatusMap(
  summary: SourceFreshnessSummary
): Map<string, SourceFreshnessStatus> {
  return new Map(summary.sources.map((source) => [source.source, source]))
}
