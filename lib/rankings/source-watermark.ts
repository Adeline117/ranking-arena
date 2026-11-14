import { summarizeSourceFreshness, type SourceFreshnessRow } from './source-freshness'

/**
 * Oldest source watermark across the trader's published windows. Shared by
 * public profile APIs. Unknown (null) when no window is published or any published
 * window lacks a valid watermark.
 */
export function sourceWatermarkForWindows(
  source: string,
  publishedWindows: readonly string[],
  rows: ReadonlyArray<SourceFreshnessRow & { season_id: unknown }>,
  nowMs = Date.now()
): { asOf: string | null; isStale: boolean; ageSeconds: number | null } {
  const unknown = { asOf: null, isStale: true, ageSeconds: null }
  const windows = [...new Set(publishedWindows)]
  if (windows.length === 0) return unknown

  let oldest: { asOf: string; ageSeconds: number; isStale: boolean } | null = null
  for (const window of windows) {
    const summary = summarizeSourceFreshness(
      rows.filter((row) => row.season_id === window && row.source === source),
      [source],
      nowMs
    )
    if (summary.asOf === null || summary.ageSeconds === null) return unknown
    if (!oldest || Date.parse(summary.asOf) < Date.parse(oldest.asOf)) {
      oldest = { asOf: summary.asOf, ageSeconds: summary.ageSeconds, isStale: summary.isStale }
    }
  }
  return oldest ?? unknown
}

/** Keep only well-formed `{ source, source_as_of }` rows from an untyped read. */
export function parseWatermarkRows(data: unknown): SourceFreshnessRow[] {
  if (!Array.isArray(data)) return []
  return data.flatMap((row): SourceFreshnessRow[] => {
    if (typeof row !== 'object' || row === null) return []
    const record = row as Record<string, unknown>
    if (typeof record.source !== 'string') return []
    const asOf = typeof record.source_as_of === 'string' ? record.source_as_of : null
    return [{ source: record.source, source_as_of: asOf }]
  })
}

/**
 * Per-source watermark for one season's rows. A source with no valid
 * watermark maps to null (unknown): callers must omit the time, never
 * substitute the score compute time or the request time.
 */
export function watermarkBySource(
  rows: ReadonlyArray<SourceFreshnessRow>,
  sources: readonly string[],
  nowMs = Date.now()
): Map<string, string | null> {
  const result = new Map<string, string | null>()
  for (const source of new Set(sources)) {
    result.set(
      source,
      summarizeSourceFreshness(
        rows.filter((row) => row.source === source),
        [source],
        nowMs
      ).asOf
    )
  }
  return result
}
