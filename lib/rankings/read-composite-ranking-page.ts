import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import type { SealedCompositeRankingPublicationSet } from '@/lib/rankings/read-sealed-composite-ranking-generation'

export const SEALED_COMPOSITE_RANKINGS_RPC_CONTRACT = 'sealed-composite-rankings-rpc@1'

const SOURCE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
const ROW_KEYS = [
  'avatar_url',
  'avg_holding_hours',
  'calmar_ratio',
  'composite_rank',
  'composite_score',
  'computed_at',
  'copiers',
  'execution_score',
  'followers',
  'handle',
  'max_drawdown',
  'pnl',
  'primary_publication_id',
  'primary_season',
  'profit_factor',
  'profitability_score',
  'risk_control_score',
  'roi',
  'score_30d',
  'score_7d',
  'score_90d',
  'score_completeness',
  'sharpe_ratio',
  'sortino_ratio',
  'source',
  'source_trader_id',
  'source_type',
  'trader_type',
  'trades_count',
  'trading_style',
  'win_rate',
] as const

export type CompositeRankingSortBy =
  | 'arena_score'
  | 'roi'
  | 'pnl'
  | 'drawdown'
  | 'copiers'
  | 'win_rate'
  | 'sharpe_ratio'
  | 'trades_count'

export interface CompositeRankingPageInput {
  readonly publication: SealedCompositeRankingPublicationSet
  readonly scopeSources: readonly string[]
  readonly limit: number
  readonly offset: number
  readonly sortBy: CompositeRankingSortBy
  readonly sortDir: 'asc' | 'desc'
  readonly minPnl?: number
  readonly minTrades?: number
  readonly traderType?: 'human' | 'bot' | 'suspected_bot'
  readonly signal?: AbortSignal
}

export interface CompositeRankingRow {
  readonly source: string
  readonly source_trader_id: string
  readonly handle: string | null
  readonly source_type: string | null
  readonly roi: number | null
  readonly pnl: number | null
  readonly win_rate: number | null
  readonly max_drawdown: number | null
  readonly trades_count: number | null
  readonly followers: number | null
  readonly copiers: number | null
  readonly avatar_url: string | null
  readonly computed_at: string | null
  readonly profitability_score: number | null
  readonly risk_control_score: number | null
  readonly execution_score: number | null
  readonly score_completeness: string | null
  readonly trading_style: string | null
  readonly avg_holding_hours: number | null
  readonly sharpe_ratio: number | null
  readonly sortino_ratio: number | null
  readonly calmar_ratio: number | null
  readonly profit_factor: number | null
  readonly trader_type: string | null
  readonly primary_season: '7D' | '30D' | '90D'
  readonly primary_publication_id: string
  readonly score_7d: number | null
  readonly score_30d: number | null
  readonly score_90d: number | null
  readonly composite_score: number
  readonly composite_rank: number
}

export interface CompositeRankingPage {
  readonly rows: readonly CompositeRankingRow[]
  readonly totalCount: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function requireString(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new Error(`composite rankings RPC returned invalid ${field}`)
  }
  return value
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === '') return null
  return requireString(value, field)
}

function requireNumber(value: unknown, field: string, nullable = false): number | null {
  if (nullable && value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`composite rankings RPC returned invalid ${field}`)
  }
  return value
}

function requireScore(value: unknown, field: string, nullable = false): number | null {
  const score = requireNumber(value, field, nullable)
  if (score !== null && (score <= 0 || score > 100)) {
    throw new Error(`composite rankings RPC returned out-of-range ${field}`)
  }
  return score
}

function canonicalSources(sources: readonly string[]): readonly string[] {
  if (!Array.isArray(sources) || sources.length > 256) {
    throw new TypeError('composite ranking scope has invalid source bounds')
  }
  const canonical = [...new Set(sources)].sort()
  if (
    canonical.length !== sources.length ||
    canonical.some((source, index) => !SOURCE_PATTERN.test(source) || source !== sources[index])
  ) {
    throw new TypeError('composite ranking scope must be unique, canonical, and sorted')
  }
  return Object.freeze(canonical)
}

function expectedCompositeScore(
  score7d: number | null,
  score30d: number | null,
  score90d: number | null
): number {
  let weight = 0
  let weightedScore = 0
  if (score7d !== null) {
    weight += 0.05
    weightedScore += score7d * 0.05
  }
  if (score30d !== null) {
    weight += 0.25
    weightedScore += score30d * 0.25
  }
  if (score90d !== null) {
    weight += 0.7
    weightedScore += score90d * 0.7
  }
  if (weight === 0) throw new Error('composite rankings RPC returned an empty score')
  return Math.round((Math.min(weightedScore / weight, 100) + 1e-9) * 10) / 10
}

function parseRow(
  value: unknown,
  scopeSources: ReadonlySet<string>,
  publicationIds: ReadonlyMap<string, string>
): CompositeRankingRow {
  if (!isRecord(value) || !hasExactKeys(value, ROW_KEYS)) {
    throw new Error('composite rankings RPC returned an invalid row shape')
  }
  const source = requireString(value.source, 'source')
  const sourceTraderId = requireString(value.source_trader_id, 'source_trader_id')
  if (!SOURCE_PATTERN.test(source) || !scopeSources.has(source)) {
    throw new Error('composite rankings RPC returned a row outside its source scope')
  }
  const primarySeason = value.primary_season
  if (primarySeason !== '7D' && primarySeason !== '30D' && primarySeason !== '90D') {
    throw new Error('composite rankings RPC returned an invalid primary season')
  }
  const primaryPublicationId = requireString(value.primary_publication_id, 'primary_publication_id')
  if (
    !UUID_PATTERN.test(primaryPublicationId) ||
    primaryPublicationId !== publicationIds.get(primarySeason)
  ) {
    throw new Error('composite rankings RPC returned a row from the wrong publication')
  }

  const score7d = requireScore(value.score_7d, 'score_7d', true)
  const score30d = requireScore(value.score_30d, 'score_30d', true)
  const score90d = requireScore(value.score_90d, 'score_90d', true)
  const compositeScore = requireScore(value.composite_score, 'composite_score')
  if (
    compositeScore === null ||
    compositeScore !== expectedCompositeScore(score7d, score30d, score90d)
  ) {
    throw new Error('composite rankings RPC returned a mismatched weighted score')
  }
  const compositeRank = requireNumber(value.composite_rank, 'composite_rank')
  if (compositeRank === null || !Number.isSafeInteger(compositeRank) || compositeRank < 1) {
    throw new Error('composite rankings RPC returned an invalid composite rank')
  }
  const computedAt = optionalString(value.computed_at, 'computed_at')
  if (computedAt !== null && !Number.isFinite(Date.parse(computedAt))) {
    throw new Error('composite rankings RPC returned an invalid computed_at')
  }

  return Object.freeze({
    source,
    source_trader_id: sourceTraderId,
    handle: optionalString(value.handle, 'handle'),
    source_type: optionalString(value.source_type, 'source_type'),
    roi: requireNumber(value.roi, 'roi', true),
    pnl: requireNumber(value.pnl, 'pnl', true),
    win_rate: requireNumber(value.win_rate, 'win_rate', true),
    max_drawdown: requireNumber(value.max_drawdown, 'max_drawdown', true),
    trades_count: requireNumber(value.trades_count, 'trades_count', true),
    followers: requireNumber(value.followers, 'followers', true),
    copiers: requireNumber(value.copiers, 'copiers', true),
    avatar_url: optionalString(value.avatar_url, 'avatar_url'),
    computed_at: computedAt,
    profitability_score: requireNumber(value.profitability_score, 'profitability_score', true),
    risk_control_score: requireNumber(value.risk_control_score, 'risk_control_score', true),
    execution_score: requireNumber(value.execution_score, 'execution_score', true),
    score_completeness: optionalString(value.score_completeness, 'score_completeness'),
    trading_style: optionalString(value.trading_style, 'trading_style'),
    avg_holding_hours: requireNumber(value.avg_holding_hours, 'avg_holding_hours', true),
    sharpe_ratio: requireNumber(value.sharpe_ratio, 'sharpe_ratio', true),
    sortino_ratio: requireNumber(value.sortino_ratio, 'sortino_ratio', true),
    calmar_ratio: requireNumber(value.calmar_ratio, 'calmar_ratio', true),
    profit_factor: requireNumber(value.profit_factor, 'profit_factor', true),
    trader_type: optionalString(value.trader_type, 'trader_type'),
    primary_season: primarySeason,
    primary_publication_id: primaryPublicationId,
    score_7d: score7d,
    score_30d: score30d,
    score_90d: score90d,
    composite_score: compositeScore,
    composite_rank: compositeRank,
  })
}

function requireInput(input: CompositeRankingPageInput) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('composite ranking page input must be an object')
  }
  const scopeSources = canonicalSources(input.scopeSources)
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 500 ||
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    input.offset > 1_000_000 ||
    ![
      'arena_score',
      'roi',
      'pnl',
      'drawdown',
      'copiers',
      'win_rate',
      'sharpe_ratio',
      'trades_count',
    ].includes(input.sortBy) ||
    (input.sortDir !== 'asc' && input.sortDir !== 'desc') ||
    (input.minPnl !== undefined && !Number.isFinite(input.minPnl)) ||
    (input.minTrades !== undefined &&
      (!Number.isSafeInteger(input.minTrades) || input.minTrades < 0)) ||
    (input.traderType !== undefined &&
      input.traderType !== 'human' &&
      input.traderType !== 'bot' &&
      input.traderType !== 'suspected_bot')
  ) {
    throw new TypeError('composite ranking page input is invalid')
  }
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) {
    throw new TypeError('composite ranking page signal must be an AbortSignal')
  }
  return scopeSources
}

export async function readCompositeRankingPage(
  supabase: SupabaseClient<Database>,
  input: CompositeRankingPageInput
): Promise<CompositeRankingPage> {
  const scopeSources = requireInput(input)
  const [publication7d, publication30d, publication90d] = input.publication.publications
  const publications = [publication7d, publication30d, publication90d] as const
  const authoritySources = new Set(
    publications.flatMap((publication) => publication.proofs.map((proof) => proof.source))
  )
  if (scopeSources.some((source) => !authoritySources.has(source))) {
    throw new TypeError('composite ranking scope exceeds the sealed authority')
  }

  let query = supabase.rpc('arena_read_composite_rankings_v1', {
    p_7d_cohort_id: publication7d.scoreCohortId,
    p_30d_cohort_id: publication30d.scoreCohortId,
    p_90d_cohort_id: publication90d.scoreCohortId,
    p_7d_sources: publication7d.proofs.map((proof) => proof.source),
    p_30d_sources: publication30d.proofs.map((proof) => proof.source),
    p_90d_sources: publication90d.proofs.map((proof) => proof.source),
    p_scope_sources: [...scopeSources],
    p_limit: input.limit,
    p_offset: input.offset,
    p_sort_by: input.sortBy,
    p_sort_dir: input.sortDir,
    p_min_pnl: input.minPnl ?? null,
    p_min_trades: input.minTrades ?? null,
    p_trader_type: input.traderType ?? null,
  })
  if (input.signal) query = query.abortSignal(input.signal)
  const { data, error } = await query
  if (error || data === null) {
    throw new Error(`Composite rankings query failed: ${error?.message ?? 'null payload'}`)
  }
  if (
    !isRecord(data) ||
    !hasExactKeys(data, ['contract', 'rows', 'total_count']) ||
    data.contract !== SEALED_COMPOSITE_RANKINGS_RPC_CONTRACT ||
    !Array.isArray(data.rows) ||
    data.rows.length > input.limit ||
    !Number.isSafeInteger(data.total_count) ||
    Number(data.total_count) < 0
  ) {
    throw new Error('composite rankings RPC returned an invalid envelope')
  }

  const publicationIds = new Map(
    publications.map((publication) => [publication.season, publication.scoreCohortId])
  )
  const scopeSet = new Set(scopeSources)
  const seen = new Set<string>()
  const rows = data.rows.map((value) => {
    const row = parseRow(value, scopeSet, publicationIds)
    const normalizedId = row.source_trader_id.startsWith('0x')
      ? row.source_trader_id.toLowerCase()
      : row.source_trader_id
    const identity = `${row.source}:${normalizedId}`
    if (seen.has(identity)) {
      throw new Error('composite rankings RPC returned a duplicate identity')
    }
    seen.add(identity)
    return row
  })
  if (scopeSources.length === 0 && (rows.length !== 0 || data.total_count !== 0)) {
    throw new Error('composite rankings RPC returned data for an empty scope')
  }

  return Object.freeze({
    rows: Object.freeze(rows),
    totalCount: Number(data.total_count),
  })
}
