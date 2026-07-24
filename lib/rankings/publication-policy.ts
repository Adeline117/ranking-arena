/**
 * Public ranking publication policy.
 *
 * A source can remain active for collection, discovery, and profile evidence
 * while being explicitly excluded from Arena Score publication. Keep this
 * registry aligned with the durable database guards installed by reviewed
 * migrations. Promotion requires a new review, removal from this registry,
 * and a cache-epoch bump.
 */

export const PUBLIC_RANKING_CACHE_EPOCH = 'public-rank-policy-v2'
export const PUBLIC_RANKING_MAX_COMPUTED_AGE_MS = 48 * 60 * 60 * 1000
export const PUBLIC_RANKING_FUTURE_TOLERANCE_MS = 5 * 60 * 1000

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

function firstDefined(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key]
  }
  return undefined
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function consistentStringAlias(
  record: Record<string, unknown>,
  keys: readonly string[],
  normalize: (value: string) => string = (value) => value
): string | null {
  const values = keys.filter((key) => record[key] !== undefined).map((key) => record[key])
  if (values.length === 0 || values.some((value) => typeof value !== 'string')) return null

  const normalized = (values as string[]).map(normalize)
  if (normalized.some((value) => value.length === 0 || value !== value.trim())) return null
  return normalized.every((value) => value === normalized[0]) ? normalized[0] : null
}

const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

export interface PublicRankingRowEligibilityOptions {
  expectedPeriod?: string
  nowMs?: number
}

export interface SanitizePublicRankingPayloadOptions {
  expectedPeriod?: string
  nowMs?: number
  sourceOf?: (row: unknown) => unknown
}

/**
 * Minimum row-level proof required for public ranking publication.
 *
 * Raw/profile observations remain visible when this returns false. A row may
 * enter a public ranking only when its identity is canonical, required score
 * inputs are concrete (not partial/estimated), and its score computation is
 * current. Source-level history/price/cost-basis authority remains a separate
 * reviewed contract and quarantine gate.
 */
export function isPublicRankingRowEligible(
  row: unknown,
  options: PublicRankingRowEligibilityOptions = {}
): boolean {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return false
  const record = row as Record<string, unknown>

  const source = consistentStringAlias(record, ['source', 'platform'], (value) =>
    value.toLowerCase()
  )
  const canonical = canonicalSource(source)
  if (
    source === null ||
    ['source', 'platform'].some((key) => record[key] !== undefined && record[key] !== source) ||
    canonical === null ||
    source !== canonical ||
    !isPublicRankingSourceAllowed(source)
  ) {
    return false
  }

  const traderIdentity = consistentStringAlias(record, [
    'source_trader_id',
    'traderKey',
    'trader_key',
  ])
  if (traderIdentity === null) return false

  if (firstDefined(record, 'score_completeness', 'scoreConfidence') !== 'full') return false
  if (firstDefined(record, 'metrics_estimated', 'metricsEstimated') !== false) return false

  const arenaScore = firstDefined(record, 'arena_score', 'arenaScore')
  const roi = record.roi
  const pnl = record.pnl
  const winRate = firstDefined(record, 'win_rate', 'winRate')
  const maxDrawdown = firstDefined(record, 'max_drawdown', 'maxDrawdown')
  if (
    !finiteNumber(arenaScore) ||
    arenaScore <= 0 ||
    arenaScore > 100 ||
    !finiteNumber(roi) ||
    !finiteNumber(pnl) ||
    !finiteNumber(winRate) ||
    winRate < 0 ||
    winRate > 100 ||
    !finiteNumber(maxDrawdown) ||
    maxDrawdown < 0 ||
    // 100 is commonly an upstream cap/sentinel, not proof of a measured
    // full-loss drawdown. Keep it profile-visible but outside ranking.
    maxDrawdown >= 100
  ) {
    return false
  }

  const computedAt = firstDefined(record, 'computed_at', 'lastUpdated')
  if (typeof computedAt !== 'string' || !ISO_INSTANT_PATTERN.test(computedAt)) return false
  const computedAtMs = Date.parse(computedAt)
  if (!Number.isFinite(computedAtMs)) return false
  const nowMs = options.nowMs ?? Date.now()
  if (!Number.isFinite(nowMs)) return false
  if (
    computedAtMs < nowMs - PUBLIC_RANKING_MAX_COMPUTED_AGE_MS ||
    computedAtMs > nowMs + PUBLIC_RANKING_FUTURE_TOLERANCE_MS
  ) {
    return false
  }

  if (options.expectedPeriod !== undefined) {
    if (
      typeof options.expectedPeriod !== 'string' ||
      options.expectedPeriod.length === 0 ||
      options.expectedPeriod !== options.expectedPeriod.trim()
    ) {
      return false
    }

    const period = consistentStringAlias(record, ['season_id', 'period'], (value) =>
      value.toUpperCase()
    )
    if (
      period === null ||
      ['season_id', 'period'].some((key) => record[key] !== undefined && record[key] !== period) ||
      period !== options.expectedPeriod.toUpperCase()
    ) {
      return false
    }
  }

  return true
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
  options: SanitizePublicRankingPayloadOptions = {}
): T {
  if (typeof payload !== 'object' || payload === null) return payload

  const record = payload as RankingPayload
  const sourceOf = options.sourceOf ?? defaultRowSource
  const topLevelPeriodKeys = ['period', 'window', 'timeRange'] as const
  const hasTopLevelPeriod = topLevelPeriodKeys.some((key) => record[key] !== undefined)
  const topLevelPeriod = hasTopLevelPeriod
    ? consistentStringAlias(record, topLevelPeriodKeys, (value) => value.toUpperCase())
    : null
  const hasOptionPeriod = options.expectedPeriod !== undefined
  const optionPeriod =
    typeof options.expectedPeriod === 'string' &&
    options.expectedPeriod.length > 0 &&
    options.expectedPeriod === options.expectedPeriod.trim()
      ? options.expectedPeriod.toUpperCase()
      : null
  const expectedPeriod = optionPeriod ?? topLevelPeriod
  const periodContractValid =
    expectedPeriod !== null &&
    (!hasOptionPeriod || optionPeriod !== null) &&
    (!hasTopLevelPeriod || topLevelPeriod !== null) &&
    (optionPeriod === null || topLevelPeriod === null || optionPeriod === topLevelPeriod)
  const nowMs = options.nowMs ?? Date.now()
  const originalTraders = Array.isArray(record.traders) ? record.traders : null
  const traders = originalTraders
    ? originalTraders.filter(
        (row) =>
          periodContractValid &&
          isPublicRankingSourceAllowed(sourceOf(row)) &&
          isPublicRankingRowEligible(row, { expectedPeriod: expectedPeriod ?? undefined, nowMs })
      )
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

  const removedQuarantinedSource = Boolean(
    originalTraders?.some((row) => isPublicRankingSourceQuarantined(sourceOf(row))) ||
    (Array.isArray(record.availableSources) &&
      record.availableSources.some(isPublicRankingSourceQuarantined)) ||
    (Array.isArray(record.source_freshness) &&
      record.source_freshness.some((row) =>
        isPublicRankingSourceQuarantined(freshnessRowSource(row))
      ))
  )
  const removedIneligibleRow = Boolean(
    originalTraders?.some(
      (row) =>
        !isPublicRankingSourceQuarantined(sourceOf(row)) &&
        (!periodContractValid ||
          !isPublicRankingRowEligible(row, {
            expectedPeriod: expectedPeriod ?? undefined,
            nowMs,
          }))
    )
  )
  const removedInvalidMetadata = (removedSource || removedFreshness) && !removedQuarantinedSource
  const visibilityReasons = [
    ...(removedQuarantinedSource ? ['quarantined_source_removed'] : []),
    ...(removedIneligibleRow ? ['ineligible_ranking_row_removed'] : []),
    ...(removedInvalidMetadata ? ['invalid_source_metadata_removed'] : []),
  ]

  const sanitized: RankingPayload = {
    ...record,
    ...(traders ? { traders } : {}),
    ...(availableSources ? { availableSources } : {}),
    ...(sourceFreshness ? { source_freshness: sourceFreshness } : {}),
    ranking_visibility: 'partial',
    ranking_visibility_reason: 'publication_policy_filtered',
    ranking_visibility_reasons: visibilityReasons,
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
