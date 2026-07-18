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

export type RankingSourceSeason = '7D' | '30D' | '90D'

export interface ExpectedSourceWindow {
  season_id: RankingSourceSeason
  registry_slug: string
  source: string
  display_name: string
}

export interface VisibleSourceWindow {
  season_id: RankingSourceSeason
  registry_slug: string
  source: string
  display_name: string
  record_count: number
}

export interface SourceWindowFreshnessRow {
  season_id: unknown
  source: unknown
  source_as_of: unknown
}

export type SourceWindowFreshnessIssueReason =
  | 'not_visible'
  | 'missing'
  | 'invalid'
  | 'future'
  | 'duplicate'

export interface SourceWindowFreshnessIssue {
  season_id: RankingSourceSeason
  reason: SourceWindowFreshnessIssueReason
  registry_slug?: string
}

export interface VisibleSourceFreshnessStatus {
  source: string
  display_name: string
  updated_at: string | null
  record_count: number
  issues: SourceWindowFreshnessIssue[]
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

function timestampState(
  value: unknown,
  nowMs: number
): { state: 'valid'; timestamp: number } | { state: 'invalid' | 'future' } {
  if (typeof value !== 'string' || value.length === 0) return { state: 'invalid' }
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return { state: 'invalid' }
  if (timestamp > nowMs + RANKING_SOURCE_FUTURE_TOLERANCE_MS) return { state: 'future' }
  return { state: 'valid', timestamp }
}

function sourceWindowKey(season: RankingSourceSeason, source: string): string {
  return `${season}\u0000${source}`
}

function physicalWindowKey(season: RankingSourceSeason, registrySlug: string): string {
  return `${season}\u0000${registrySlug}`
}

function isRankingSourceSeason(value: unknown): value is RankingSourceSeason {
  return value === '7D' || value === '30D' || value === '90D'
}

function authorityString(row: Record<string, unknown>, key: string, index: number): string {
  const value = row[key]
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`freshness expected source row ${index} has invalid ${key}`)
  }
  return value
}

/** Strictly validate the service-role-only registry membership RPC. */
export function parseExpectedSourceWindows(data: unknown): ExpectedSourceWindow[] {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('freshness expected source authority returned no windows')
  }

  const seenPhysicalWindows = new Set<string>()
  const registryIdentities = new Map<string, { source: string; display_name: string }>()

  return data.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new TypeError(`freshness expected source row ${index} is not an object`)
    }
    const row = value as Record<string, unknown>
    if (!isRankingSourceSeason(row.season_id)) {
      throw new TypeError(`freshness expected source row ${index} has invalid season_id`)
    }

    const registrySlug = authorityString(row, 'registry_slug', index)
    const source = authorityString(row, 'filter_source', index)
    const displayName = authorityString(row, 'exchange_name', index)
    if (source === 'null') {
      throw new TypeError(`freshness expected source row ${index} has invalid filter_source`)
    }

    const physicalKey = physicalWindowKey(row.season_id, registrySlug)
    if (seenPhysicalWindows.has(physicalKey)) {
      throw new Error('freshness expected source authority returned a duplicate registry window')
    }
    seenPhysicalWindows.add(physicalKey)

    const identity = registryIdentities.get(registrySlug)
    if (identity && (identity.source !== source || identity.display_name !== displayName)) {
      throw new Error('freshness expected source registry identity is inconsistent')
    }
    registryIdentities.set(registrySlug, { source, display_name: displayName })

    return {
      season_id: row.season_id,
      registry_slug: registrySlug,
      source,
      display_name: displayName,
    }
  })
}

/**
 * Close the cron monitor over every active+serving declared registry promise.
 * A source is healthy only when every declared physical registry window has a
 * matching public alias row with a positive current-generation count and every
 * public alias/window has one valid upstream watermark. The alias count does
 * not prove that each physical board contributed ranks; score computation time
 * is never consulted.
 *
 * Multiple physical registry boards may map to the same public source alias.
 * Such duplicate visible rows share one count-cache value and are counted once.
 * Historical watermark rows outside the expected registry set are ignored.
 */
export function buildRegistrySourceFreshnessStatuses(
  expectedWindows: readonly ExpectedSourceWindow[],
  visibleWindows: readonly VisibleSourceWindow[],
  watermarkRows: readonly SourceWindowFreshnessRow[],
  nowMs = Date.now()
): VisibleSourceFreshnessStatus[] {
  if (!Number.isFinite(nowMs)) throw new TypeError('freshness clock must be finite')
  if (expectedWindows.length === 0) {
    throw new Error('freshness expected source authority returned no windows')
  }

  const expectedPhysicalWindows = new Map<string, ExpectedSourceWindow>()
  const expectedAliasWindows = new Map<string, ExpectedSourceWindow>()
  const sourceDisplayNames = new Map<string, string>()
  for (const window of expectedWindows) {
    if (
      !isRankingSourceSeason(window.season_id) ||
      !window.registry_slug ||
      window.registry_slug.trim() !== window.registry_slug ||
      !window.source ||
      window.source.trim() !== window.source ||
      window.source === 'null' ||
      !window.display_name ||
      window.display_name.trim() !== window.display_name
    ) {
      throw new TypeError('freshness expected source window is invalid')
    }
    const existingDisplayName = sourceDisplayNames.get(window.source)
    if (existingDisplayName && existingDisplayName !== window.display_name) {
      throw new Error('freshness expected source alias has conflicting display names')
    }
    sourceDisplayNames.set(window.source, window.display_name)

    const physicalKey = physicalWindowKey(window.season_id, window.registry_slug)
    if (expectedPhysicalWindows.has(physicalKey)) {
      throw new Error('freshness expected source authority returned a duplicate registry window')
    }
    expectedPhysicalWindows.set(physicalKey, { ...window })
    expectedAliasWindows.set(sourceWindowKey(window.season_id, window.source), { ...window })
  }

  const visiblePhysicalWindows = new Set<string>()
  const visibleCounts = new Map<string, number>()
  for (const window of visibleWindows) {
    if (
      !isRankingSourceSeason(window.season_id) ||
      !window.registry_slug ||
      window.registry_slug.trim() !== window.registry_slug ||
      !window.source ||
      window.source.trim() !== window.source ||
      !window.display_name ||
      window.display_name.trim() !== window.display_name ||
      !Number.isSafeInteger(window.record_count) ||
      window.record_count <= 0
    ) {
      throw new TypeError('visible source freshness window is invalid')
    }

    const physicalKey = physicalWindowKey(window.season_id, window.registry_slug)
    const expectedWindow = expectedPhysicalWindows.get(physicalKey)
    if (!expectedWindow) {
      throw new Error('visible source lies outside the freshness registry authority')
    }
    if (
      expectedWindow.source !== window.source ||
      expectedWindow.display_name !== window.display_name
    ) {
      throw new Error('visible source identity conflicts with the freshness registry authority')
    }
    if (visiblePhysicalWindows.has(physicalKey)) {
      throw new Error('visible source authority returned a duplicate registry window')
    }
    visiblePhysicalWindows.add(physicalKey)

    const aliasKey = sourceWindowKey(window.season_id, window.source)
    const existingCount = visibleCounts.get(aliasKey)
    if (existingCount !== undefined && existingCount !== window.record_count) {
      throw new Error('visible source alias has conflicting record counts')
    }
    visibleCounts.set(aliasKey, window.record_count)
  }

  const visibilityIssues = new Map<string, SourceWindowFreshnessIssue[]>()
  for (const window of expectedPhysicalWindows.values()) {
    const physicalKey = physicalWindowKey(window.season_id, window.registry_slug)
    if (visiblePhysicalWindows.has(physicalKey)) continue
    const aliasKey = sourceWindowKey(window.season_id, window.source)
    const issues = visibilityIssues.get(aliasKey) ?? []
    issues.push({
      season_id: window.season_id,
      reason: 'not_visible',
      registry_slug: window.registry_slug,
    })
    visibilityIssues.set(aliasKey, issues)
  }

  const observations = new Map<
    string,
    { state: 'valid'; timestamp: number } | { state: 'invalid' | 'future' | 'duplicate' }
  >()
  for (const row of watermarkRows) {
    if (
      (row.season_id !== '7D' && row.season_id !== '30D' && row.season_id !== '90D') ||
      typeof row.source !== 'string'
    ) {
      continue
    }
    const key = sourceWindowKey(row.season_id, row.source)
    if (!expectedAliasWindows.has(key)) continue
    if (observations.has(key)) {
      observations.set(key, { state: 'duplicate' })
      continue
    }
    observations.set(key, timestampState(row.source_as_of, nowMs))
  }

  const windowsBySource = new Map<string, ExpectedSourceWindow[]>()
  for (const window of expectedAliasWindows.values()) {
    const windows = windowsBySource.get(window.source) ?? []
    windows.push(window)
    windowsBySource.set(window.source, windows)
  }

  return [...windowsBySource.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([source, windows]) => {
      const issues: SourceWindowFreshnessIssue[] = []
      const timestamps: number[] = []
      let recordCount = 0

      for (const window of windows.sort((left, right) =>
        left.season_id.localeCompare(right.season_id)
      )) {
        const aliasKey = sourceWindowKey(window.season_id, source)
        recordCount += visibleCounts.get(aliasKey) ?? 0
        issues.push(...(visibilityIssues.get(aliasKey) ?? []))

        const observation = observations.get(aliasKey)
        if (!observation) {
          issues.push({ season_id: window.season_id, reason: 'missing' })
        } else if (observation.state === 'valid') {
          timestamps.push(observation.timestamp)
        } else {
          issues.push({ season_id: window.season_id, reason: observation.state })
        }
      }

      const oldestTimestamp =
        issues.length === 0 && timestamps.length === windows.length ? Math.min(...timestamps) : null
      return {
        source,
        display_name: sourceDisplayNames.get(source) ?? source,
        updated_at: oldestTimestamp === null ? null : new Date(oldestTimestamp).toISOString(),
        record_count: recordCount,
        issues,
      }
    })
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
