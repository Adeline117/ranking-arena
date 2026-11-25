/**
 * Server-side leaderboard filters (audit 2026-11-12 frontend P2-5).
 *
 * Advanced filters and `?preset=` used to run in the browser over the one
 * loaded 50-row page, so matches on other pages never showed and pagination
 * described the unfiltered board. They are now `/api/traders` query params
 * applied in SQL to the public cohort, so every page, `hasMore` and the
 * cursor describe the filtered cohort.
 *
 * Every predicate uses a column of `public_ranked_leaderboard` (roi, pnl,
 * win_rate, max_drawdown, arena_score, source, source_type). A filter on a
 * metric excludes rows whose value is unknown: an unknown drawdown is not
 * evidence that the drawdown is under the bound.
 *
 * The same names are the homepage URL keys (`roi_min`, `dd_max`, `fex`, …),
 * so `leaderboardFilterQuery` is also the canonical form a client sends.
 */

import { PUBLIC_COHORT_MAX_ABS_ROI } from './public-cohort'

export const LEADERBOARD_PRESET_IDS = [
  'cex_futures',
  'cex_spot',
  'onchain_dex',
  'low_risk',
  'high_pnl',
  'consistent',
  'top_scorers',
] as const
export type LeaderboardPresetId = (typeof LEADERBOARD_PRESET_IDS)[number]

export const LEADERBOARD_GRADES = ['S', 'A', 'B', 'C', 'D'] as const
export type LeaderboardGrade = (typeof LEADERBOARD_GRADES)[number]

/** Arena Score bounds of a grade, matching getScoreGradeLetter. */
const GRADE_SCORE_RANGE: Record<LeaderboardGrade, { min?: number; maxExclusive?: number }> = {
  S: { min: 90 },
  A: { min: 75, maxExclusive: 90 },
  B: { min: 55, maxExclusive: 75 },
  C: { min: 35, maxExclusive: 55 },
  D: { maxExclusive: 35 },
}

export type LeaderboardSourceType = 'futures' | 'spot' | 'web3'

export interface LeaderboardFilters {
  roiMin?: number
  roiMax?: number
  /** Absolute max drawdown bounds, percent. */
  ddMin?: number
  ddMax?: number
  minPnl?: number
  minScore?: number
  minWinRate?: number
  grade?: LeaderboardGrade
  /** Canonical source ids (`.in('source', …)`). */
  sources?: string[]
  /** View `source_type` values (`onchain` is stored as `web3`). */
  sourceTypes?: LeaderboardSourceType[]
  preset?: LeaderboardPresetId
  /**
   * Also list idle-window rows (no ROI and no PnL in the period), which lists
   * hide by default. Not a narrowing predicate — the reader applies it through
   * excludeIdleWindowRows — but it is part of the cohort identity, so like any
   * other filter it keeps the request out of the shared cache.
   */
  includeIdle?: true
}

/** Predicates of each preset — the same thresholds FilterPresets shows. */
const PRESET_FILTERS: Record<LeaderboardPresetId, Omit<LeaderboardFilters, 'preset'>> = {
  cex_futures: { sourceTypes: ['futures'] },
  cex_spot: { sourceTypes: ['spot'] },
  onchain_dex: { sourceTypes: ['web3'] },
  low_risk: { ddMax: 20, minWinRate: 55 },
  high_pnl: { minPnl: 10_000 },
  consistent: { minWinRate: 60, minScore: 50 },
  top_scorers: { minScore: 75 },
}

export function isLeaderboardPresetId(value: unknown): value is LeaderboardPresetId {
  return typeof value === 'string' && (LEADERBOARD_PRESET_IDS as readonly string[]).includes(value)
}

export function isLeaderboardGrade(value: unknown): value is LeaderboardGrade {
  return typeof value === 'string' && (LEADERBOARD_GRADES as readonly string[]).includes(value)
}

export function toLeaderboardSourceType(value: string): LeaderboardSourceType | null {
  if (value === 'futures' || value === 'spot' || value === 'web3') return value
  return value === 'onchain' ? 'web3' : null
}

/**
 * Idle-window rows may be listed only on the PLAIN board: default order
 * (Arena Score, descending) and no other filter.
 *
 * Their place is the tail. Under any other order that no longer holds — sorted
 * by ROI, a row with ROI 0 sits above every losing trader — and a filter
 * selects rows the idle accounts do not belong among. So a request that asks
 * for them together with a sort or a filter gets the board without them.
 */
export function listsIdleRows(
  filters: LeaderboardFilters | null | undefined,
  sortBy: string,
  order: 'asc' | 'desc'
): boolean {
  if (filters?.includeIdle !== true) return false
  if (sortBy !== 'arena_score' || order !== 'desc') return false
  const { includeIdle: _includeIdle, ...others } = filters
  return !hasLeaderboardFilters(others)
}

export function hasLeaderboardFilters(filters: LeaderboardFilters): boolean {
  return Object.values(filters).some((value) =>
    Array.isArray(value) ? value.length > 0 : value !== undefined
  )
}

/** Structural subset of a PostgREST filter builder. */
export interface LeaderboardFilterable<Q> {
  gte(column: string, value: number): Q
  lte(column: string, value: number): Q
  lt(column: string, value: number): Q
  in(column: string, values: readonly string[]): Q
  or(filters: string): Q
}

function applyOne<Q extends LeaderboardFilterable<Q>>(
  query: Q,
  filters: Omit<LeaderboardFilters, 'preset'>
): Q {
  let q = query
  if (filters.roiMin !== undefined) q = q.gte('roi', filters.roiMin)
  if (filters.roiMax !== undefined) q = q.lte('roi', filters.roiMax)
  // |max_drawdown| bounds. Published values are 0–100, but a legacy negative
  // value must not slip past the bound.
  if (filters.ddMax !== undefined) {
    q = q.gte('max_drawdown', -filters.ddMax).lte('max_drawdown', filters.ddMax)
  }
  if (filters.ddMin !== undefined) {
    q = q.or(`max_drawdown.gte.${filters.ddMin},max_drawdown.lte.${-filters.ddMin}`)
  }
  if (filters.minPnl !== undefined) q = q.gte('pnl', filters.minPnl)
  if (filters.minScore !== undefined) q = q.gte('arena_score', filters.minScore)
  if (filters.minWinRate !== undefined) q = q.gte('win_rate', filters.minWinRate)
  if (filters.grade !== undefined) {
    const range = GRADE_SCORE_RANGE[filters.grade]
    if (range.min !== undefined) q = q.gte('arena_score', range.min)
    if (range.maxExclusive !== undefined) q = q.lt('arena_score', range.maxExclusive)
  }
  if (filters.sources?.length) q = q.in('source', filters.sources)
  if (filters.sourceTypes?.length) q = q.in('source_type', filters.sourceTypes)
  return q
}

/** Apply the filters in SQL (AND of the preset and the advanced filters). */
export function applyLeaderboardFilters<Q extends LeaderboardFilterable<Q>>(
  query: Q,
  filters: LeaderboardFilters
): Q {
  const { preset, ...advanced } = filters
  const withPreset = preset ? applyOne(query, PRESET_FILTERS[preset]) : query
  return applyOne(withPreset, advanced)
}

/** Client filter state (structural FilterConfig) → leaderboard filters. */
export interface LeaderboardFilterInput {
  roi_min?: number
  roi_max?: number
  drawdown_min?: number
  drawdown_max?: number
  min_pnl?: number
  min_score?: number
  min_win_rate?: number
  grade?: string
  exchange?: string[]
  category?: string[]
  /** Show the idle-window rows the list hides by default. */
  show_idle?: boolean
}

/** Inclusive bounds `/api/traders` accepts for each numeric filter param. */
export const FILTER_PARAM_BOUNDS = {
  roi_min: [-PUBLIC_COHORT_MAX_ABS_ROI, PUBLIC_COHORT_MAX_ABS_ROI],
  roi_max: [-PUBLIC_COHORT_MAX_ABS_ROI, PUBLIC_COHORT_MAX_ABS_ROI],
  dd_min: [0, 100],
  dd_max: [0, 100],
  min_pnl: [-1e12, 1e12],
  min_score: [0, 100],
  min_wr: [0, 100],
} as const satisfies Record<string, readonly [number, number]>

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Canonical `/api/traders` query fragment for the client filter state, or
 * null when nothing filters the cohort. Keys and list values are sorted so one
 * filter state always produces one string (cohort identity / dedup key).
 * `resolveSource` maps an exchange alias to its canonical source id, or null
 * for one the API does not accept (it is dropped instead of failing the page).
 */
export function leaderboardFilterQuery(
  config: LeaderboardFilterInput,
  preset: string | null | undefined,
  resolveSource: (slug: string) => string | null = (slug) => slug
): string | null {
  const entries: Array<[string, string]> = []
  // Clamped to the API's accepted bounds and written as a plain decimal, so a
  // typed value can never turn the whole page into a 400.
  const num = (key: keyof typeof FILTER_PARAM_BOUNDS, value: unknown) => {
    const n = finite(value)
    if (n === undefined) return
    const [min, max] = FILTER_PARAM_BOUNDS[key]
    const clamped = Math.round(Math.min(max, Math.max(min, n)) * 10_000) / 10_000
    entries.push([key, String(Object.is(clamped, -0) ? 0 : clamped)])
  }
  num('roi_min', config.roi_min)
  num('roi_max', config.roi_max)
  num('dd_min', config.drawdown_min)
  num('dd_max', config.drawdown_max)
  num('min_pnl', config.min_pnl)
  num('min_score', config.min_score)
  num('min_wr', config.min_win_rate)
  if (isLeaderboardGrade(config.grade)) entries.push(['grade', config.grade])
  const sources = [
    ...new Set(
      (config.exchange ?? [])
        .filter(Boolean)
        .map(resolveSource)
        .filter((v): v is string => Boolean(v))
    ),
  ].sort()
  if (sources.length) entries.push(['fex', sources.join(',')])
  const categories = [
    ...new Set(
      (config.category ?? [])
        .map(toLeaderboardSourceType)
        .filter((v): v is LeaderboardSourceType => Boolean(v))
    ),
  ].sort()
  if (categories.length) entries.push(['fcat', categories.join(',')])
  if (config.show_idle === true) entries.push(['idle', '1'])
  if (isLeaderboardPresetId(preset)) entries.push(['preset', preset])
  if (entries.length === 0) return null
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return new URLSearchParams(entries).toString()
}
