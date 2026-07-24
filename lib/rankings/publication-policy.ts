/**
 * Public ranking publication policy.
 *
 * A source can remain active for collection, discovery, and profile evidence
 * while being explicitly excluded from Arena Score publication. Keep this
 * registry aligned with the durable database guards installed by reviewed
 * migrations. Promotion requires a new review, removal from this registry,
 * and a cache-epoch bump.
 */

export const PUBLIC_RANKING_CACHE_EPOCH = 'public-rank-policy-v1'

export const PUBLIC_RANKING_SOURCE_QUARANTINES = [
  {
    source: 'okx_web3_solana',
    contract: 'okx-web3-ranking-quarantine@1',
    reason: 'population_and_window_authority_unverified',
    reviewedAt: '2026-07-24',
  },
] as const

export const PUBLIC_RANKING_QUARANTINED_SOURCES: readonly string[] =
  PUBLIC_RANKING_SOURCE_QUARANTINES.map(({ source }) => source)

const QUARANTINED_SOURCES = new Set<string>(PUBLIC_RANKING_QUARANTINED_SOURCES)

export const PUBLIC_RANKING_POSTGREST_EXCLUSION: string | null =
  PUBLIC_RANKING_QUARANTINED_SOURCES.length > 0
    ? `(${PUBLIC_RANKING_QUARANTINED_SOURCES.join(',')})`
    : null

function canonicalSource(source: unknown): string | null {
  if (typeof source !== 'string') return null
  const normalized = source.trim().toLowerCase()
  return normalized.length > 0 ? normalized : null
}

export function isPublicRankingSourceAllowed(source: unknown): boolean {
  const canonical = canonicalSource(source)
  return canonical !== null && !QUARANTINED_SOURCES.has(canonical)
}

export function isPublicRankingSourceQuarantined(source: unknown): boolean {
  const canonical = canonicalSource(source)
  return canonical !== null && QUARANTINED_SOURCES.has(canonical)
}

export function hasActivePublicRankingQuarantine(): boolean {
  return QUARANTINED_SOURCES.size > 0
}

export function filterPublicRankingSources(sources: readonly unknown[]): string[] {
  const canonical = sources
    .map((source) => canonicalSource(source))
    .filter((source): source is string => source !== null && isPublicRankingSourceAllowed(source))
  return [...new Set(canonical)].sort()
}

export function filterPublicRankingRows<T>(rows: readonly T[], sourceOf: (row: T) => unknown): T[] {
  return rows.filter((row) => isPublicRankingSourceAllowed(sourceOf(row)))
}

type RankingPayload = Record<string, unknown> & {
  traders?: unknown[]
  availableSources?: unknown[]
  source_freshness?: unknown[]
}

function defaultRowSource(row: unknown): unknown {
  if (typeof row !== 'object' || row === null) return null
  const candidate = row as Record<string, unknown>
  return candidate.source ?? candidate.platform
}

function freshnessRowSource(row: unknown): unknown {
  if (typeof row !== 'object' || row === null) return null
  return (row as Record<string, unknown>).source
}

/**
 * Defense-in-depth for payloads returned from Redis/memory caches.
 *
 * New cache epochs should contain only safe rows. If an unsafe cached payload
 * still appears, remove it without mutating the cache object. When trader rows
 * are removed, downgrade totals to the visible page as an honest lower bound.
 * A smaller partial page is preferable to claiming a complete hidden ranking.
 */
export function sanitizePublicRankingPayload<T>(
  payload: T,
  sourceOf: (row: unknown) => unknown = defaultRowSource
): T {
  if (typeof payload !== 'object' || payload === null) return payload

  const record = payload as RankingPayload
  const originalTraders = Array.isArray(record.traders) ? record.traders : null
  const traders = originalTraders
    ? filterPublicRankingRows(originalTraders, sourceOf)
    : originalTraders
  const availableSources = Array.isArray(record.availableSources)
    ? filterPublicRankingSources(record.availableSources)
    : record.availableSources
  const sourceFreshness = Array.isArray(record.source_freshness)
    ? filterPublicRankingRows(record.source_freshness, freshnessRowSource)
    : record.source_freshness

  const removedTrader = Boolean(
    originalTraders && traders && traders.length !== originalTraders.length
  )
  const removedSource = Boolean(
    record.availableSources &&
    availableSources &&
    availableSources.length !== record.availableSources.length
  )
  const removedFreshness = Boolean(
    record.source_freshness &&
    sourceFreshness &&
    sourceFreshness.length !== record.source_freshness.length
  )

  if (!removedTrader && !removedSource && !removedFreshness) return payload

  const sanitized: RankingPayload = {
    ...record,
    ...(traders ? { traders } : {}),
    ...(availableSources ? { availableSources } : {}),
    ...(sourceFreshness ? { source_freshness: sourceFreshness } : {}),
    ranking_visibility: 'partial',
    ranking_visibility_reason: 'quarantined_source_removed',
  }

  if (removedTrader) {
    const safeCount = traders?.length ?? 0
    for (const countKey of ['total', 'totalCount', 'total_count', 'totalcount'] as const) {
      if (countKey in sanitized) sanitized[countKey] = safeCount
    }
    if ('hasMore' in sanitized) sanitized.hasMore = false
    if ('next_cursor' in sanitized) sanitized.next_cursor = null
    if ('nextCursor' in sanitized) sanitized.nextCursor = null
  }

  return sanitized as T
}
