export interface LeaderboardCountCacheRow {
  source: string | null
  total_count: number | null
  updated_at: string | null
}

const SCORED_SUFFIX = '_gt0'
const SCORED_TOTAL_KEY = '_all_gt0'

function generationTimestamp(rows: readonly LeaderboardCountCacheRow[]): string | null {
  const timestamp = rows.find(({ source }) => source === SCORED_TOTAL_KEY)?.updated_at
  return typeof timestamp === 'string' && timestamp.length > 0 ? timestamp : null
}

/** Sources with rows visible under the leaderboard's arena_score > 0 contract. */
export function currentScoredSources(rows: readonly LeaderboardCountCacheRow[]): string[] {
  const generation = generationTimestamp(rows)
  if (!generation) return []

  return [
    ...new Set(
      rows.flatMap((row) => {
        if (
          row.updated_at !== generation ||
          row.source === SCORED_TOTAL_KEY ||
          !row.source?.endsWith(SCORED_SUFFIX) ||
          typeof row.total_count !== 'number' ||
          row.total_count <= 0
        ) {
          return []
        }
        return [row.source.slice(0, -SCORED_SUFFIX.length)]
      })
    ),
  ].sort()
}

/**
 * Read a count from the same complete cache generation as `_all_gt0`.
 * A missing source in a present generation means zero; a missing generation
 * means the cache is unavailable and the caller should use its safe fallback.
 */
export function currentScoredCount(
  rows: readonly LeaderboardCountCacheRow[],
  sourceKey: string
): number | null {
  const generation = generationTimestamp(rows)
  if (!generation) return null

  const row = rows.find(({ source }) => source === sourceKey)
  if (!row) return 0
  if (row.updated_at !== generation) return 0
  return typeof row.total_count === 'number' && row.total_count >= 0 ? row.total_count : null
}
