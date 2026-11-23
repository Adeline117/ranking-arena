/**
 * Public ranking publication policy.
 *
 * A source can remain active for collection, discovery, and profile evidence
 * while being explicitly excluded from Arena Score publication. Keep this
 * registry aligned with the durable database guards installed by reviewed
 * migrations. Promotion requires a new review, removal from this registry,
 * and a cache-epoch bump.
 */

import { parsePublicActiveRankingSource } from '@/lib/constants/exchanges'

// The epoch is NOT rotated for the ROI + PnL row policy (20261122201611).
// Merging that change must not alter a running deployment, and an epoch the
// website has but an older scoring worker does not would leave the new keys
// outside whatever that worker invalidates. It is not needed for correctness
// either: pages cached under the four-metric policy hold only complete rows,
// which the relaxed reader accepts unchanged, and the fixed launch order
// (database -> website -> scoring worker) means no reader ever truncates a
// page of the larger cohort. If a rotation is wanted at launch it is a
// one-line change deployed to the website and the scoring worker together.
// v7: BingX ranking quarantine. Rotate every ranking key so orphaned v6
// payloads whose legacy tag TTL expired cannot bypass the
// new atomic generation invalidation contract.
export const PUBLIC_RANKING_CACHE_EPOCH = 'public-rank-policy-v7'
/**
 * Redis tag index for the current public ranking epoch. This must rotate with
 * the key epoch so an older rolling-deploy writer cannot shorten or recreate
 * the tag that owns current publication keys.
 */
export const PUBLIC_RANKING_REDIS_TAG = `rankings:${PUBLIC_RANKING_CACHE_EPOCH}`
/**
 * Opaque Redis generation used to reject cache writes from reads that began
 * before the current leaderboard publication invalidated the shared surface.
 */
export const PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY = 'public-rankings:write-fence:v1'
export const PUBLIC_RANKING_MAX_COMPUTED_AGE_MS = 48 * 60 * 60 * 1000

/**
 * Row-level eligibility the rank publication WRITER applies.
 *
 *   'four_metrics' THE DEFAULT: the rule in force before the "everyone with
 *                  ROI and PnL is ranked" decision. All four metrics required,
 *                  historical v4 scoring (computeArenaScoresV4). A build
 *                  without the environment variable publishes exactly what it
 *                  published before this switch existed.
 *   'roi_pnl'      owner decision 2026-11-22. ROI and PnL are required; win
 *                  rate and max drawdown are shown and range-checked when
 *                  present and left empty when absent. Only null is missing, a
 *                  missing dimension scores 0, idle-window rows are not scored,
 *                  a 0% drawdown on a losing window is refused.
 *
 * One switch for every writer-side consequence (required evidence metrics,
 * cohort admission, row classification, score options, score floors, idle and
 * contradiction rules, write order). It is turned on only by setting
 * PUBLIC_RANKING_ROW_ELIGIBILITY=roi_pnl in the scoring worker's environment,
 * AFTER migration 20261122201611 and the website are deployed; removing the
 * variable and redeploying the worker is the rollback. Readers and the
 * database row policy accept the relaxed superset and never consult it.
 */
export type PublicRankingRowEligibility = 'roi_pnl' | 'four_metrics'

export const PUBLIC_RANKING_ROW_ELIGIBILITY_ENV = 'PUBLIC_RANKING_ROW_ELIGIBILITY'
export const DEFAULT_PUBLIC_RANKING_ROW_ELIGIBILITY: PublicRankingRowEligibility = 'four_metrics'

export interface ResolvedPublicRankingRowEligibility {
  value: PublicRankingRowEligibility
  /** 'set' = a recognized value; otherwise the default was used. */
  source: 'set' | 'unset' | 'unrecognized'
  /** One line for the worker log. Never echoes an unrecognized value's content beyond 40 chars. */
  description: string
}

/**
 * Resolve the writer switch from an environment value. Unset, empty or
 * unrecognized all fall back to the default ('four_metrics'): a typo must
 * never turn the new rule on, and must never turn publication off.
 */
export function resolvePublicRankingRowEligibility(
  raw: string | undefined = typeof process === 'undefined'
    ? undefined
    : process.env[PUBLIC_RANKING_ROW_ELIGIBILITY_ENV]
): ResolvedPublicRankingRowEligibility {
  const fallback = DEFAULT_PUBLIC_RANKING_ROW_ELIGIBILITY
  if (raw === undefined || raw.trim() === '') {
    return {
      value: fallback,
      source: 'unset',
      description: `row eligibility: ${fallback} (${PUBLIC_RANKING_ROW_ELIGIBILITY_ENV} is not set; default)`,
    }
  }
  if (raw === 'roi_pnl' || raw === 'four_metrics') {
    return {
      value: raw,
      source: 'set',
      description: `row eligibility: ${raw} (${PUBLIC_RANKING_ROW_ELIGIBILITY_ENV})`,
    }
  }
  return {
    value: fallback,
    source: 'unrecognized',
    description: `row eligibility: ${fallback} (${PUBLIC_RANKING_ROW_ELIGIBILITY_ENV}=${JSON.stringify(raw.slice(0, 40))} is not recognized; expected roi_pnl or four_metrics; default)`,
  }
}

/** The writer eligibility in force for this process. */
export function publicRankingRowEligibility(): PublicRankingRowEligibility {
  return resolvePublicRankingRowEligibility().value
}
export const PUBLIC_RANKING_FUTURE_TOLERANCE_MS = 5 * 60 * 1000

export const PUBLIC_RANKING_SOURCE_QUARANTINES = [
  {
    source: 'okx_web3_solana',
    contract: 'okx-web3-ranking-quarantine@1',
    reason: 'population_and_window_authority_unverified',
    reviewedAt: '2026-07-24',
  },
  {
    source: 'bitget_bots_futures',
    contract: 'bitget-bot-cumulative-rank-quarantine@1',
    reason: 'inception_cumulative_metrics_are_not_window_rank_authority',
    reviewedAt: '2026-07-28',
  },
  {
    source: 'bitget_bots_spot',
    contract: 'bitget-bot-cumulative-rank-quarantine@1',
    reason: 'inception_cumulative_metrics_are_not_window_rank_authority',
    reviewedAt: '2026-07-28',
  },
  {
    // Public alias for the ingest source bingx_futures.
    source: 'bingx',
    contract: 'bingx-ranking-quarantine@1',
    reason: 'population_window_and_history_authority_unverified',
    reviewedAt: '2026-08-03',
  },
  {
    source: 'bingx_spot',
    contract: 'bingx-ranking-quarantine@1',
    reason: 'population_window_and_history_authority_unverified',
    reviewedAt: '2026-08-03',
  },
] as const

export const PUBLIC_RANKING_QUARANTINED_SOURCES: readonly string[] =
  PUBLIC_RANKING_SOURCE_QUARANTINES.map(({ source }) => source)

const QUARANTINED_SOURCES = new Set<string>(PUBLIC_RANKING_QUARANTINED_SOURCES)

export const PUBLIC_RANKING_POSTGREST_EXCLUSION: string | null =
  PUBLIC_RANKING_QUARANTINED_SOURCES.length > 0
    ? `(${PUBLIC_RANKING_QUARANTINED_SOURCES.join(',')})`
    : null

export function publicRankingCacheKey(key: string): string {
  return `${PUBLIC_RANKING_CACHE_EPOCH}:${key}`
}

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

export interface ConcretePublicRankingMetricsOptions {
  /**
   * Writer-only: require win rate and max drawdown as well (the
   * 'four_metrics' rollback rule). Readers never set this.
   */
  requireWinRateAndDrawdown?: boolean
}

/**
 * Concrete source/identity/metric basis required before a row may participate
 * in the Arena Score percentile cohort. This deliberately excludes score and
 * computation-time checks because those values do not exist until after the
 * cohort has been scored.
 *
 * ROI and PnL are required. Win rate and max drawdown are optional: null (or
 * an absent key) means "not provided"; a present value must be in range, and
 * 0 is a value. score_completeness must describe exactly which of the two are
 * present. The same rule is arena.leaderboard_rank_row_is_public_eligible.
 */
export function hasConcretePublicRankingMetrics(
  row: unknown,
  options: ConcretePublicRankingMetricsOptions = {}
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

  const completeness = firstDefined(record, 'score_completeness', 'scoreConfidence')
  if (completeness !== 'full' && completeness !== 'partial' && completeness !== 'minimal') {
    return false
  }
  if (options.requireWinRateAndDrawdown === true && completeness !== 'full') return false
  if (firstDefined(record, 'metrics_estimated', 'metricsEstimated') !== false) return false
  if (firstDefined(record, 'is_outlier', 'isOutlier') === true) return false

  const roi = record.roi
  const pnl = record.pnl
  const winRate = firstDefined(record, 'win_rate', 'winRate')
  const maxDrawdown = firstDefined(record, 'max_drawdown', 'maxDrawdown')
  if (!finiteNumber(roi) || !finiteNumber(pnl)) return false

  // Only null/absent is "not provided". Anything else must be a real in-range
  // observation; a malformed or out-of-range value is not silently read as
  // missing here (the scorer nulls those before a row gets this far).
  const hasWinRate = winRate !== null && winRate !== undefined
  const hasMaxDrawdown = maxDrawdown !== null && maxDrawdown !== undefined
  if (hasWinRate && !(finiteNumber(winRate) && winRate >= 0 && winRate <= 100)) return false
  // 100 is commonly an upstream cap/sentinel, not proof of a measured
  // full-loss drawdown, so the upper bound is exclusive.
  if (hasMaxDrawdown && !(finiteNumber(maxDrawdown) && maxDrawdown >= 0 && maxDrawdown < 100)) {
    return false
  }
  return completeness === publicRankingScoreCompleteness(hasWinRate, hasMaxDrawdown)
}

/** score_completeness is a statement about which optional risk metrics exist. */
export function publicRankingScoreCompleteness(
  hasWinRate: boolean,
  hasMaxDrawdown: boolean
): 'full' | 'partial' | 'minimal' {
  if (hasWinRate && hasMaxDrawdown) return 'full'
  return hasWinRate || hasMaxDrawdown ? 'partial' : 'minimal'
}

/**
 * Minimum row-level proof required for public ranking publication.
 *
 * Raw/profile observations remain visible when this returns false. A row may
 * enter a public ranking only when its identity is canonical, ROI and PnL are
 * concrete (not estimated), any win rate / drawdown it carries is in range,
 * and its score computation is current. Source-level history/price/cost-basis authority remains a separate
 * reviewed contract and quarantine gate.
 */
export function isPublicRankingRowEligible(
  row: unknown,
  options: PublicRankingRowEligibilityOptions = {}
): boolean {
  if (!hasConcretePublicRankingMetrics(row)) return false
  const record = row as Record<string, unknown>

  const arenaScore = firstDefined(record, 'arena_score', 'arenaScore')
  if (!finiteNumber(arenaScore) || arenaScore <= 0 || arenaScore > 100) {
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
  const activeSource = parsePublicActiveRankingSource(source)
  return activeSource !== null && !QUARANTINED_SOURCES.has(activeSource)
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

export interface PublicRankingCountCacheRow {
  source: string | null
  total_count: number | null
  updated_at: string | null
}

export interface PublicRankingCountSelection {
  source?: unknown
  sources?: readonly unknown[]
}

function countGeneration(rows: readonly PublicRankingCountCacheRow[]): string | null {
  const timestamp = rows.find(({ source }) => source === '_all_gt0')?.updated_at
  return typeof timestamp === 'string' && timestamp.length > 0 ? timestamp : null
}

function countForPublicSource(
  rows: readonly PublicRankingCountCacheRow[],
  source: string,
  generation: string
): number | null {
  const row = rows.find(
    (candidate) => candidate.source === `${source}_gt0` && candidate.updated_at === generation
  )
  if (!row) return 0
  return typeof row.total_count === 'number' &&
    Number.isFinite(row.total_count) &&
    row.total_count >= 0
    ? row.total_count
    : null
}

/**
 * Count only source quarantine. This deliberately makes no claim that every
 * row satisfies the stricter row-publication proof contract.
 */
export function publicRankingCountFromCache(
  rows: readonly PublicRankingCountCacheRow[],
  selection: PublicRankingCountSelection = {}
): number | null {
  const generation = countGeneration(rows)
  if (!generation) return null

  const aggregate = rows.find(
    (row) => row.source === '_all_gt0' && row.updated_at === generation
  )?.total_count
  if (typeof aggregate !== 'number' || !Number.isFinite(aggregate) || aggregate < 0) {
    return null
  }

  if ('source' in selection) {
    const source = canonicalSource(selection.source)
    if (!source) return null
    if (!isPublicRankingSourceAllowed(source)) return 0
    return countForPublicSource(rows, source, generation)
  }

  if ('sources' in selection) {
    let total = 0
    for (const source of filterPublicRankingSources(selection.sources ?? [])) {
      const count = countForPublicSource(rows, source, generation)
      if (count === null) return null
      total += count
    }
    return total
  }

  let publicCount = 0
  for (const row of rows) {
    if (
      row.updated_at !== generation ||
      typeof row.source !== 'string' ||
      row.source === '_all_gt0' ||
      !row.source.endsWith('_gt0')
    ) {
      continue
    }

    const source = row.source.slice(0, -'_gt0'.length)
    if (!isPublicRankingSourceAllowed(source)) continue
    if (
      typeof row.total_count !== 'number' ||
      !Number.isFinite(row.total_count) ||
      row.total_count < 0
    ) {
      return null
    }
    publicCount += row.total_count
  }
  return Math.min(aggregate, publicCount)
}

type SourceOnlyRankingPayload = Record<string, unknown> & {
  traders?: unknown[]
  data?: unknown[] | Record<string, unknown>
  rankings?: unknown[]
  availableSources?: unknown[]
  available_sources?: unknown[]
  source_freshness?: unknown[]
  meta?: Record<string, unknown>
  categoryCounts?: Record<string, unknown>
}

export interface SanitizePublicRankingSourcePayloadOptions {
  sourceOf?: (row: unknown) => unknown
}

function withoutNonPublicSourceRows<T>(rows: readonly T[], sourceOf: (row: T) => unknown): T[] {
  return rows.filter((row) => isPublicRankingSourceAllowed(sourceOf(row)))
}

function sanitizePublicSourceMetadata(
  record: SourceOnlyRankingPayload
): SourceOnlyRankingPayload | null {
  const updates: SourceOnlyRankingPayload = {}

  for (const key of ['availableSources', 'available_sources'] as const) {
    const original = record[key]
    if (!Array.isArray(original)) continue
    const safe = original.filter(isPublicRankingSourceAllowed)
    if (safe.length !== original.length) updates[key] = safe
  }

  if (Array.isArray(record.source_freshness)) {
    const safe = withoutNonPublicSourceRows(record.source_freshness, freshnessRowSource)
    if (safe.length !== record.source_freshness.length) updates.source_freshness = safe
  }

  return Object.keys(updates).length > 0 ? updates : null
}

function sourceRemovalReasons(
  record: SourceOnlyRankingPayload,
  sourceOf: (row: unknown) => unknown
): string[] {
  const candidates: unknown[] = []

  for (const key of ['traders', 'data', 'rankings'] as const) {
    const rows = record[key]
    if (Array.isArray(rows)) candidates.push(...rows.map(sourceOf))
  }
  for (const key of ['availableSources', 'available_sources'] as const) {
    const sources = record[key]
    if (Array.isArray(sources)) candidates.push(...sources)
  }
  if (Array.isArray(record.source_freshness)) {
    candidates.push(...record.source_freshness.map(freshnessRowSource))
  }

  const removed = candidates.filter((source) => !isPublicRankingSourceAllowed(source))
  return [
    ...(removed.some(isPublicRankingSourceQuarantined) ? ['quarantined_source_removed'] : []),
    ...(removed.some((source) => !isPublicRankingSourceQuarantined(source))
      ? ['inactive_source_removed']
      : []),
  ]
}

function sourceCategoryCounts(rows: readonly unknown[]): Record<string, number> {
  return rows.reduce<Record<string, number>>(
    (counts, row) => {
      counts.all += 1
      if (typeof row !== 'object' || row === null) return counts
      const sourceType = (row as Record<string, unknown>).source_type
      if (sourceType === 'spot') counts.spot += 1
      else if (sourceType === 'web3') counts.onchain += 1
      else counts.futures += 1
      return counts
    },
    { all: 0, futures: 0, spot: 0, onchain: 0 }
  )
}

function invalidatePaginationFields(
  record: Record<string, unknown>,
  safeCount: number
): Record<string, unknown> {
  const next = { ...record }
  for (const key of ['total', 'totalCount', 'total_count', 'totalcount'] as const) {
    if (key in next) next[key] = safeCount
  }
  for (const key of ['hasMore', 'has_more'] as const) {
    if (key in next) next[key] = false
  }
  for (const key of ['cursor', 'nextCursor', 'next_cursor'] as const) {
    if (key in next) next[key] = null
  }
  return next
}

function invalidateSourcePagination(
  record: SourceOnlyRankingPayload,
  safeRows: readonly unknown[]
): SourceOnlyRankingPayload {
  const safeCount = safeRows.length
  const next = invalidatePaginationFields(record, safeCount) as SourceOnlyRankingPayload

  if (next.meta && typeof next.meta === 'object' && !Array.isArray(next.meta)) {
    const meta = invalidatePaginationFields(next.meta, safeCount)
    if (meta.pagination && typeof meta.pagination === 'object' && !Array.isArray(meta.pagination)) {
      meta.pagination = invalidatePaginationFields(
        meta.pagination as Record<string, unknown>,
        safeCount
      )
    }
    next.meta = meta
  }

  if (next.categoryCounts && typeof next.categoryCounts === 'object') {
    next.categoryCounts = { ...next.categoryCounts, ...sourceCategoryCounts(safeRows) }
  }

  return next
}

function invalidateSourceFreshnessSummary(
  record: SourceOnlyRankingPayload
): SourceOnlyRankingPayload {
  const invalidate = (value: Record<string, unknown>) => {
    const next = { ...value }
    for (const key of ['lastUpdated', 'as_of', 'updated_at', 'source_as_of'] as const) {
      if (key in next) next[key] = null
    }
    for (const key of ['isStale', 'is_stale'] as const) {
      if (key in next) next[key] = true
    }
    for (const key of ['dataAgeMinutes', 'staleness_seconds'] as const) {
      if (key in next) next[key] = null
    }
    return next
  }

  const next = invalidate(record) as SourceOnlyRankingPayload
  if (next.meta && typeof next.meta === 'object' && !Array.isArray(next.meta)) {
    next.meta = invalidate(next.meta)
  }
  return next
}

/**
 * Source-publication defense for finite pages and cached payloads.
 *
 * Unlike sanitizePublicRankingPayload, this function never evaluates row proof,
 * metric completeness, score freshness, or period evidence. Every non-quarantined
 * row from an active canonical source in the fetched page is retained.
 */
export function sanitizePublicRankingSourcePayload<T>(
  payload: T,
  options: SanitizePublicRankingSourcePayloadOptions = {}
): T {
  if (typeof payload !== 'object' || payload === null) return payload

  const record = payload as SourceOnlyRankingPayload
  const sourceOf = options.sourceOf ?? defaultRowSource
  const removalReasons = new Set(sourceRemovalReasons(record, sourceOf))
  if (record.meta && typeof record.meta === 'object' && !Array.isArray(record.meta)) {
    for (const reason of sourceRemovalReasons(record.meta as SourceOnlyRankingPayload, sourceOf)) {
      removalReasons.add(reason)
    }
  }
  let sanitized: SourceOnlyRankingPayload = record
  let safeRows: readonly unknown[] | null = null
  let removedTopLevelRows = false

  for (const key of ['traders', 'data', 'rankings'] as const) {
    const original = record[key]
    if (!Array.isArray(original)) continue
    const safe = withoutNonPublicSourceRows(original, sourceOf)
    if (safeRows === null) safeRows = safe
    if (safe.length === original.length) continue
    if (sanitized === record) sanitized = { ...record }
    sanitized[key] = safe
    removedTopLevelRows = true
  }

  if (record.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
    const safeData = sanitizePublicRankingSourcePayload(record.data, { sourceOf })
    if (safeData !== record.data) {
      if (sanitized === record) sanitized = { ...record }
      sanitized.data = safeData as Record<string, unknown>
    }
  }

  const metadata = sanitizePublicSourceMetadata(sanitized)
  if (metadata) {
    if (sanitized === record) sanitized = { ...record }
    sanitized = { ...sanitized, ...metadata }
  }

  if (sanitized.meta && typeof sanitized.meta === 'object' && !Array.isArray(sanitized.meta)) {
    const meta = sanitized.meta as SourceOnlyRankingPayload
    const metaMetadata = sanitizePublicSourceMetadata(meta)
    if (metaMetadata) {
      if (sanitized === record) sanitized = { ...record }
      sanitized.meta = { ...meta, ...metaMetadata }
    }
  }

  if (sanitized === record) return payload
  if (removedTopLevelRows) sanitized = invalidateSourcePagination(sanitized, safeRows ?? [])
  sanitized = invalidateSourceFreshnessSummary(sanitized)

  return {
    ...sanitized,
    ranking_visibility: 'partial',
    ranking_visibility_reason: 'publication_policy_filtered',
    ranking_visibility_reasons:
      removalReasons.size > 0 ? [...removalReasons] : ['non_public_source_removed'],
  } as T
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
