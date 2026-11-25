import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import {
  PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
  PUBLIC_RANKING_REDIS_TAG,
  isPublicRankingSourceAllowed,
  publicRankingCacheKey,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'
import { isValidTokenSymbol } from '@/lib/utils/token-symbol'
import {
  mergeTokenRankingsWithProfiles,
  type TokenTraderRanking,
} from '@/lib/rankings/token-traders'

export const TOKEN_RANKING_PAGE_CONTRACT = 'token-ranking-page@1'
export const POPULAR_TOKEN_PAGE_CONTRACT = 'popular-token-page@1'
// v5 keeps only token-generation facts in the shared snapshot. Generic
// profile metrics are overlaid from the live sealed public cohort below.
export const TOKEN_RANKING_SNAPSHOT_CACHE_VERSION = 'v5'
export const TOKEN_RANKING_MAX_GENERATION = 9_007_199_254_740_000
export const TOKEN_RANKING_MAX_OFFSET = 2_000_000
export const TOKEN_RANKING_API_TIMEOUT_MS = 12_000

const PERIOD_DAYS = {
  '7D': 7,
  '30D': 30,
  '90D': 90,
} as const

const HEAD_KEYS = [
  'daily_row_count',
  'generation_seq',
  'popular_row_count',
  'published_at',
  'published_at_epoch_ms',
  'source_as_of',
  'source_through_date',
  'window_through_date',
] as const

const TOKEN_PAGE_KEYS = [
  'contract',
  'generation',
  'limit',
  'lookback_days',
  'offset',
  'published_at',
  'published_at_epoch_ms',
  'source_as_of',
  'source_through_date',
  'token',
  'total',
  'traders',
  'window_through_date',
] as const

const TOKEN_ROW_KEYS = [
  'source',
  'source_trader_id',
  'token_avg_pnl_pct',
  'token_pnl',
  'token_rank',
  'token_trade_count',
  'token_win_rate',
] as const

const POPULAR_PAGE_KEYS = [
  'contract',
  'generation',
  'limit',
  'lookback_days',
  'published_at',
  'published_at_epoch_ms',
  'source_as_of',
  'source_through_date',
  'tokens',
  'total',
  'window_through_date',
] as const

const POPULAR_ROW_KEYS = ['token', 'total_pnl', 'trade_count', 'trader_count'] as const

const FINAL_TOKEN_PAGE_KEYS = [
  'contract',
  'dailyRowCount',
  'generation',
  'limit',
  'lookbackDays',
  'offset',
  'period',
  'popularRowCount',
  'profilePublicationId',
  'publishedAt',
  'publishedAtEpochMs',
  'sourceAsOf',
  'sourceThroughDate',
  'token',
  'total',
  'traders',
  'windowThroughDate',
] as const

const FINAL_POPULAR_PAGE_KEYS = [
  'contract',
  'dailyRowCount',
  'generation',
  'limit',
  'lookbackDays',
  'popularRowCount',
  'publishedAt',
  'publishedAtEpochMs',
  'sourceAsOf',
  'sourceThroughDate',
  'tokens',
  'total',
  'windowThroughDate',
] as const

const FINAL_TRADER_KEYS = [
  'arena_score',
  'avatar_url',
  'handle',
  'roi',
  'source',
  'source_trader_id',
  'token_avg_pnl_pct',
  'token_pnl',
  'token_rank',
  'token_trade_count',
  'token_win_rate',
  'total_pnl',
] as const

const FINAL_POPULAR_TOKEN_KEYS = ['token', 'total_pnl', 'trade_count', 'trader_count'] as const
const PUBLIC_PROFILE_KEYS = [
  'arena_score',
  'avatar_url',
  'computed_at',
  'handle',
  'is_outlier',
  'max_drawdown',
  'metrics_estimated',
  'pnl',
  'rank',
  'roi',
  'score_completeness',
  'season_id',
  'source',
  'source_trader_id',
  'win_rate',
] as const
const PUBLIC_PROFILE_COLUMNS = PUBLIC_PROFILE_KEYS.join(',')
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const SOURCE_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/

export type TokenRankingPeriod = keyof typeof PERIOD_DAYS
export type TokenRankingReadErrorKind =
  | 'invalid_input'
  | 'not_published'
  | 'generation_changed'
  | 'publication_busy'
  | 'contract'
  | 'database'

export class TokenRankingReadError extends Error {
  constructor(
    public readonly kind: TokenRankingReadErrorKind,
    message: string,
    public readonly databaseCode?: string,
    public readonly details?: string,
    public readonly currentGeneration?: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'TokenRankingReadError'
  }
}

export interface TokenRankingPublicationHead {
  generation: string
  publishedAt: string
  publishedAtEpochMs: number
  windowThroughDate: string
  sourceAsOf: string | null
  sourceThroughDate: string | null
  dailyRowCount: number
  popularRowCount: number
}

export interface TokenTraderRankingSnapshot extends TokenRankingPublicationHead {
  contract: typeof TOKEN_RANKING_PAGE_CONTRACT
  token: string
  period: TokenRankingPeriod
  lookbackDays: number
  limit: number
  offset: number
  total: number
  traders: TokenTraderRanking[]
  /**
   * Generic profile publication is deliberately unknown: profile fields are
   * revalidated against the live sealed cohort for every response.
   */
  profilePublicationId: string | null
}

export interface PopularTokenRanking {
  token: string
  trade_count: number
  trader_count: number
  total_pnl: number
}

export interface PopularTokenRankingSnapshot extends TokenRankingPublicationHead {
  contract: typeof POPULAR_TOKEN_PAGE_CONTRACT
  lookbackDays: 90
  limit: number
  total: number
  tokens: PopularTokenRanking[]
}

interface RpcErrorShape {
  code?: unknown
  message?: unknown
  details?: unknown
}

interface ParsedInstant {
  raw: string
  epochMicros: bigint
  epochMs: number
}

interface TokenPageInput {
  token: string
  period: TokenRankingPeriod
  limit: number
  offset: number
  generation?: string
}

type NormalizedTokenPageInput = Omit<TokenPageInput, 'generation'> & {
  generation?: string
}

interface PopularPageInput {
  limit?: number
  generation?: string
}

export interface TokenRankingReadOptions {
  signal?: AbortSignal
}

interface AggregateTokenRow {
  source: string
  source_trader_id: string
  token_rank: number
  token_pnl: number
  token_trade_count: number
  token_win_rate: number | null
  token_avg_pnl_pct: number | null
  total_count: number
}

interface LeaderboardProfile {
  source: string
  source_trader_id: string
  handle: string | null
  avatar_url: string | null
  arena_score: number | null
  roi: number | null
  pnl: number | null
}

function fail(
  kind: TokenRankingReadErrorKind,
  message: string,
  options: {
    databaseCode?: string
    details?: string
    currentGeneration?: string
    cause?: unknown
  } = {}
): never {
  throw new TokenRankingReadError(
    kind,
    message,
    options.databaseCode,
    options.details,
    options.currentGeneration,
    options.cause === undefined ? undefined : { cause: options.cause }
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort(compareText)
  const wanted = [...expected].sort(compareText)
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function floorDivide(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor
  return value % divisor < 0n ? quotient - 1n : quotient
}

function parseInstant(value: unknown, label: string): ParsedInstant {
  if (typeof value !== 'string') fail('contract', `${label} must be an RFC3339 timestamp`)
  const match = RFC3339_PATTERN.exec(value)
  if (!match) fail('contract', `${label} must be an RFC3339 timestamp with timezone`)

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction, zone] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const baseMs = Date.UTC(year, month - 1, day, hour, minute, second)
  const probe = new Date(baseMs)
  if (
    year < 1000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute ||
    probe.getUTCSeconds() !== second
  ) {
    fail('contract', `${label} is not a real calendar timestamp`)
  }

  let offsetMinutes = 0
  if (zone !== 'Z') {
    const sign = match[9] === '+' ? 1 : -1
    const offsetHours = Number(match[10])
    const offsetMinutePart = Number(match[11])
    if (offsetHours > 23 || offsetMinutePart > 59) {
      fail('contract', `${label} has an invalid timezone offset`)
    }
    offsetMinutes = sign * (offsetHours * 60 + offsetMinutePart)
  }

  const fractionMicros = BigInt((fraction ?? '').padEnd(6, '0') || '0')
  const epochMicros = BigInt(baseMs - offsetMinutes * 60_000) * 1000n + fractionMicros
  const epochMsBigInt = floorDivide(epochMicros, 1000n)
  const epochMs = Number(epochMsBigInt)
  if (!Number.isSafeInteger(epochMs)) fail('contract', `${label} is outside the supported range`)
  return { raw: value, epochMicros, epochMs }
}

function parseDate(value: unknown, label: string): string {
  if (typeof value !== 'string') fail('contract', `${label} must be a calendar date`)
  const match = DATE_PATTERN.exec(value)
  if (!match) fail('contract', `${label} must use YYYY-MM-DD`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (
    year < 1000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    fail('contract', `${label} is not a real calendar date`)
  }
  return value
}

function parseSafeInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  let parsed: number
  if (typeof value === 'number') {
    parsed = value
  } else if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    const asBigInt = BigInt(value)
    if (asBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail('contract', `${label} must be a safe integer`)
    }
    parsed = Number(asBigInt)
  } else {
    fail('contract', `${label} must be a safe integer`)
  }
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail('contract', `${label} is outside its supported range`)
  }
  return parsed
}

function parseFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' && typeof value !== 'string') {
    fail('contract', `${label} must be finite`)
  }
  if (typeof value === 'string' && value.trim().length === 0) {
    fail('contract', `${label} must be finite`)
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) fail('contract', `${label} must be finite`)
  return parsed
}

function parseNullableFiniteNumber(value: unknown, label: string): number | null {
  return value === null ? null : parseFiniteNumber(value, label)
}

function parseNullableInstant(value: unknown, label: string): ParsedInstant | null {
  return value === null ? null : parseInstant(value, label)
}

function parseNullableDate(value: unknown, label: string): string | null {
  return value === null ? null : parseDate(value, label)
}

function parseGenerationValue(value: unknown, minimum: 0 | 1, label: string) {
  const number = parseSafeInteger(value, minimum, TOKEN_RANKING_MAX_GENERATION, label)
  return { number, text: String(number) }
}

export function parseTokenRankingGeneration(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)) {
    fail('invalid_input', 'generation must be a canonical positive integer')
  }
  let generation: { number: number; text: string }
  try {
    generation = parseGenerationValue(value, 1, 'generation')
  } catch (error) {
    if (error instanceof TokenRankingReadError) {
      fail('invalid_input', 'generation is outside its supported range', { cause: error })
    }
    throw error
  }
  if (generation.text !== value) fail('invalid_input', 'generation must be canonical')
  return generation.text
}

function rpcErrorField(
  error: RpcErrorShape,
  field: 'code' | 'message' | 'details'
): string | undefined {
  const value = error[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function currentGenerationFromDetails(details: string | undefined): string | undefined {
  if (!details || !/^[1-9]\d{0,15}$/.test(details)) return undefined
  try {
    return parseGenerationValue(details, 1, 'current generation').text
  } catch {
    return undefined
  }
}

function throwRpcError(stage: string, error: RpcErrorShape, signal?: AbortSignal): never {
  const databaseCode = rpcErrorField(error, 'code')
  const message = rpcErrorField(error, 'message')
  const details = rpcErrorField(error, 'details')
  if (signal?.aborted) {
    fail('database', `${stage} exceeded its request deadline`, {
      databaseCode: '57014',
      details,
    })
  }
  if (databaseCode === '40001') {
    fail('generation_changed', `${stage} observed a newer generation`, {
      databaseCode,
      details,
      currentGeneration: currentGenerationFromDetails(details),
    })
  }
  if (databaseCode === '55000') {
    fail('not_published', `${stage} has no published token ranking generation`, {
      databaseCode,
      details,
    })
  }
  if (databaseCode === '22023') {
    fail('invalid_input', `${stage} rejected its input`, { databaseCode, details })
  }
  fail('database', `${stage} failed${message ? `: ${message}` : ''}`, {
    databaseCode,
    details,
  })
}

function bindAbortSignal<T>(
  query: PromiseLike<T>,
  signal: AbortSignal | undefined,
  stage: string
): PromiseLike<T> {
  if (!signal) return query
  if (signal.aborted) {
    fail('database', `${stage} exceeded its request deadline`, { databaseCode: '57014' })
  }
  const abortSignal = (query as PromiseLike<T> & { abortSignal?: unknown }).abortSignal
  if (typeof abortSignal !== 'function') {
    fail('contract', `${stage} query cannot bind the request deadline`)
  }
  try {
    return Reflect.apply(abortSignal, query, [signal]) as PromiseLike<T>
  } catch (error) {
    fail('database', `${stage} could not bind its request deadline`, { cause: error })
  }
}

function isAbortFailure(error: unknown): boolean {
  if (!isRecord(error)) return false
  return error.name === 'AbortError' || error.name === 'TimeoutError'
}

function requireActiveDeadline(signal: AbortSignal | undefined, stage: string): void {
  if (signal?.aborted) {
    fail('database', `${stage} exceeded its request deadline`, { databaseCode: '57014' })
  }
}

async function readRpcResult<T>(
  stage: string,
  operation: () => PromiseLike<T>,
  signal?: AbortSignal
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof TokenRankingReadError) throw error
    if (signal?.aborted || isAbortFailure(error)) {
      fail('database', `${stage} exceeded its request deadline`, {
        databaseCode: '57014',
        cause: error,
      })
    }
    fail('database', `${stage} call failed`, { cause: error })
  }
}

export function parseTokenRankingPublicationHead(data: unknown): TokenRankingPublicationHead {
  if (!Array.isArray(data) || data.length !== 1 || !isRecord(data[0])) {
    fail('contract', 'token ranking publication head must contain exactly one row')
  }
  const row = data[0]
  if (!hasExactKeys(row, HEAD_KEYS))
    fail('contract', 'token ranking publication head shape changed')

  const generation = parseGenerationValue(row.generation_seq, 0, 'head generation')
  const dailyRowCount = parseSafeInteger(
    row.daily_row_count,
    0,
    Number.MAX_SAFE_INTEGER,
    'daily row count'
  )
  const popularRowCount = parseSafeInteger(
    row.popular_row_count,
    0,
    Number.MAX_SAFE_INTEGER,
    'popular row count'
  )

  if (generation.number === 0) {
    if (
      row.published_at !== null ||
      row.published_at_epoch_ms !== null ||
      row.window_through_date !== null ||
      row.source_as_of !== null
    ) {
      fail('contract', 'generation zero has contradictory publication metadata')
    }
    fail('not_published', 'token ranking generation has not been published')
  }

  const publishedAt = parseInstant(row.published_at, 'published_at')
  const publishedAtEpochMs = parseSafeInteger(
    row.published_at_epoch_ms,
    0,
    Number.MAX_SAFE_INTEGER,
    'published_at_epoch_ms'
  )
  if (publishedAtEpochMs !== publishedAt.epochMs) {
    fail('contract', 'published_at_epoch_ms does not identify published_at')
  }
  const sourceAsOf = parseNullableInstant(row.source_as_of, 'source_as_of')
  if (sourceAsOf && sourceAsOf.epochMicros > publishedAt.epochMicros + 300_000_000n) {
    fail('contract', 'source_as_of is implausibly later than publication')
  }

  return {
    generation: generation.text,
    publishedAt: publishedAt.raw,
    publishedAtEpochMs,
    windowThroughDate: parseDate(row.window_through_date, 'window_through_date'),
    sourceAsOf: sourceAsOf?.raw ?? null,
    sourceThroughDate: parseNullableDate(row.source_through_date, 'source_through_date'),
    dailyRowCount,
    popularRowCount,
  }
}

export async function readTokenRankingPublicationHead(
  supabase: SupabaseClient<Database>,
  options: TokenRankingReadOptions = {}
): Promise<TokenRankingPublicationHead> {
  const result = await readRpcResult(
    'token ranking publication head',
    () =>
      bindAbortSignal(
        supabase.rpc('get_token_ranking_publication_head'),
        options.signal,
        'token ranking publication head'
      ),
    options.signal
  )
  if (!isRecord(result)) fail('contract', 'token ranking publication head RPC envelope is invalid')
  if (result.error)
    throwRpcError('token ranking publication head', result.error as RpcErrorShape, options.signal)
  return parseTokenRankingPublicationHead(result.data)
}

function assertSamePublication(
  page: Record<string, unknown>,
  head: TokenRankingPublicationHead
): void {
  const generation = parseGenerationValue(page.generation, 1, 'payload generation')
  if (generation.text !== head.generation)
    fail('contract', 'payload generation does not match head')

  const publishedAt = parseInstant(page.published_at, 'payload published_at')
  if (
    publishedAt.epochMicros !== parseInstant(head.publishedAt, 'head publishedAt').epochMicros ||
    parseSafeInteger(
      page.published_at_epoch_ms,
      0,
      Number.MAX_SAFE_INTEGER,
      'payload published_at_epoch_ms'
    ) !== head.publishedAtEpochMs ||
    parseDate(page.window_through_date, 'payload window_through_date') !== head.windowThroughDate
  ) {
    fail('contract', 'payload publication metadata does not match head')
  }

  const sourceAsOf = parseNullableInstant(page.source_as_of, 'payload source_as_of')
  const headSourceAsOf = parseNullableInstant(head.sourceAsOf, 'head sourceAsOf')
  if (sourceAsOf?.epochMicros !== headSourceAsOf?.epochMicros) {
    fail('contract', 'payload source_as_of does not match head')
  }
  if (
    parseNullableDate(page.source_through_date, 'payload source_through_date') !==
    head.sourceThroughDate
  ) {
    fail('contract', 'payload source_through_date does not match head')
  }
}

function parseAggregateRows(
  value: unknown,
  total: number,
  limit: number,
  offset: number
): AggregateTokenRow[] {
  if (!Array.isArray(value)) fail('contract', 'token ranking traders must be an array')
  const expectedLength = Math.min(limit, Math.max(total - offset, 0))
  if (value.length !== expectedLength) {
    fail('contract', 'token ranking page cardinality does not match its total')
  }
  const seenIdentities = new Set<string>()

  return value.map((candidate, index) => {
    if (!isRecord(candidate) || !hasExactKeys(candidate, TOKEN_ROW_KEYS)) {
      fail('contract', `token ranking row ${index} shape changed`)
    }
    const expectedRank = offset + index + 1
    const tokenRank = parseSafeInteger(
      candidate.token_rank,
      1,
      Number.MAX_SAFE_INTEGER,
      `token ranking row ${index} rank`
    )
    const tokenWinRate = parseNullableFiniteNumber(
      candidate.token_win_rate,
      `token ranking row ${index} win rate`
    )
    if (tokenRank !== expectedRank || tokenRank > total) {
      fail('contract', `token ranking row ${index} is not in authoritative rank order`)
    }
    if (tokenWinRate !== null && (tokenWinRate < 0 || tokenWinRate > 100)) {
      fail('contract', `token ranking row ${index} win rate is outside 0..100`)
    }
    if (
      typeof candidate.source !== 'string' ||
      !SOURCE_PATTERN.test(candidate.source) ||
      typeof candidate.source_trader_id !== 'string' ||
      candidate.source_trader_id.length === 0 ||
      candidate.source_trader_id !== candidate.source_trader_id.trim()
    ) {
      fail('contract', `token ranking row ${index} identity is invalid`)
    }
    const identity = JSON.stringify([candidate.source, candidate.source_trader_id])
    if (seenIdentities.has(identity)) {
      fail('contract', `token ranking row ${index} repeats a trader identity`)
    }
    seenIdentities.add(identity)
    return {
      source: candidate.source,
      source_trader_id: candidate.source_trader_id,
      token_rank: tokenRank,
      token_pnl: parseFiniteNumber(candidate.token_pnl, `token ranking row ${index} PnL`),
      token_trade_count: parseSafeInteger(
        candidate.token_trade_count,
        0,
        Number.MAX_SAFE_INTEGER,
        `token ranking row ${index} trade count`
      ),
      token_win_rate: tokenWinRate,
      token_avg_pnl_pct: parseNullableFiniteNumber(
        candidate.token_avg_pnl_pct,
        `token ranking row ${index} average PnL percent`
      ),
      total_count: total,
    }
  })
}

function parseRawTokenPage(
  value: unknown,
  head: TokenRankingPublicationHead,
  input: NormalizedTokenPageInput
): { total: number; rows: AggregateTokenRow[] } {
  if (!isRecord(value) || !hasExactKeys(value, TOKEN_PAGE_KEYS)) {
    fail('contract', 'token ranking page shape changed')
  }
  if (value.contract !== TOKEN_RANKING_PAGE_CONTRACT) {
    fail('contract', 'token ranking page contract is unsupported')
  }
  assertSamePublication(value, head)
  if (
    value.token !== input.token ||
    parseSafeInteger(value.lookback_days, 1, 90, 'lookback_days') !== PERIOD_DAYS[input.period] ||
    parseSafeInteger(value.limit, 1, 200, 'limit') !== input.limit ||
    parseSafeInteger(value.offset, 0, TOKEN_RANKING_MAX_OFFSET, 'offset') !== input.offset
  ) {
    fail('contract', 'token ranking page does not match its request')
  }
  const total = parseSafeInteger(value.total, 0, Number.MAX_SAFE_INTEGER, 'total')
  return { total, rows: parseAggregateRows(value.traders, total, input.limit, input.offset) }
}

function profileIdentityKey(source: string, sourceTraderId: string): string {
  return JSON.stringify([source, sourceTraderId])
}

function profileIdentityFromRow(value: unknown): string | null {
  if (
    !isRecord(value) ||
    typeof value.source !== 'string' ||
    !SOURCE_PATTERN.test(value.source) ||
    typeof value.source_trader_id !== 'string' ||
    value.source_trader_id.length === 0 ||
    value.source_trader_id !== value.source_trader_id.trim()
  ) {
    return null
  }
  return profileIdentityKey(value.source, value.source_trader_id)
}

function publicProfileFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && value.trim().length === 0) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function publicProfileRank(value: unknown): number | null {
  const rank = publicProfileFiniteNumber(value)
  return rank !== null && Number.isSafeInteger(rank) && rank > 0 ? rank : null
}

/**
 * Validate one optional profile overlay independently of the token snapshot.
 * A bad/missing row deliberately returns null: the token generation remains
 * authoritative, while generic profile fields become unknown for that trader.
 */
function parsePublishedProfile(
  value: unknown,
  period: TokenRankingPeriod,
  expectedIdentity: string
): LeaderboardProfile | null {
  if (!isRecord(value) || !hasExactKeys(value, PUBLIC_PROFILE_KEYS)) return null

  if (
    typeof value.source !== 'string' ||
    typeof value.source_trader_id !== 'string' ||
    (value.handle !== null && typeof value.handle !== 'string') ||
    (value.avatar_url !== null && typeof value.avatar_url !== 'string')
  ) {
    return null
  }
  const source = value.source
  const sourceTraderId = value.source_trader_id
  const handle = value.handle as string | null
  const avatarUrl = value.avatar_url as string | null
  const identity = profileIdentityFromRow(value)
  const rank = publicProfileRank(value.rank)
  const arenaScore = publicProfileFiniteNumber(value.arena_score)
  const roi = publicProfileFiniteNumber(value.roi)
  const pnl = publicProfileFiniteNumber(value.pnl)
  // Win rate and drawdown are optional on a ranked row: null means "not
  // provided". A value that is present must still parse; the sanitizer below
  // range-checks it.
  const winRate = publicProfileFiniteNumber(value.win_rate)
  const maxDrawdown = publicProfileFiniteNumber(value.max_drawdown)
  if (
    identity !== expectedIdentity ||
    value.season_id !== period ||
    rank === null ||
    arenaScore === null ||
    roi === null ||
    pnl === null ||
    (value.win_rate !== null && winRate === null) ||
    (value.max_drawdown !== null && maxDrawdown === null) ||
    !SOURCE_PATTERN.test(source) ||
    sourceTraderId.length === 0 ||
    sourceTraderId !== sourceTraderId.trim()
  ) {
    return null
  }

  // The sanitizer is kept after number normalization because PostgREST can
  // serialize numeric columns as strings. It still enforces the complete,
  // current score and source-publication proof before any generic metric is
  // attached to a token-specific row.
  const normalized = {
    ...value,
    rank,
    arena_score: arenaScore,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown,
  }
  const sanitized = sanitizePublicRankingPayload(
    { traders: [normalized], period },
    { expectedPeriod: period }
  ) as { traders?: unknown[] }
  const row = sanitized.traders?.[0]
  if (
    !isRecord(row) ||
    row.source !== source ||
    row.source_trader_id !== sourceTraderId ||
    row.season_id !== period ||
    publicProfileRank(row.rank) !== rank
  ) {
    return null
  }

  return {
    source,
    source_trader_id: sourceTraderId,
    handle,
    avatar_url: avatarUrl,
    arena_score: arenaScore,
    roi,
    pnl,
  }
}

async function loadProfiles(
  supabase: SupabaseClient<Database>,
  period: TokenRankingPeriod,
  rows: AggregateTokenRow[],
  options: TokenRankingReadOptions
): Promise<LeaderboardProfile[]> {
  const publicRows = rows.filter((row) => isPublicRankingSourceAllowed(row.source))
  if (publicRows.length === 0) return []

  const expectedIdentities = new Set(
    publicRows.map((row) => profileIdentityKey(row.source, row.source_trader_id))
  )
  const traderIds = [...new Set(publicRows.map((row) => row.source_trader_id))]
  const sources = [...new Set(publicRows.map((row) => row.source))]

  try {
    const query = supabase
      .from('public_ranked_leaderboard')
      .select(PUBLIC_PROFILE_COLUMNS)
      .eq('season_id', period)
      .in('source', sources)
      .in('source_trader_id', traderIds)
    const result = await (options.signal
      ? bindAbortSignal(query, options.signal, 'token ranking profile enrichment')
      : query)
    if (!isRecord(result) || result.error || !Array.isArray(result.data)) return []

    const profiles = new Map<string, LeaderboardProfile>()
    const invalidIdentities = new Set<string>()
    for (const profile of result.data) {
      const identity = profileIdentityFromRow(profile)
      // Queries use separate source and trader-id filters, so a source that
      // shares an id with a requested trader can still be returned. Never let
      // that row enrich a different source/trader pair.
      if (!identity || !expectedIdentities.has(identity)) continue

      const safeProfile = parsePublishedProfile(profile, period, identity)
      if (!safeProfile || profiles.has(identity)) {
        invalidIdentities.add(identity)
        profiles.delete(identity)
        continue
      }
      profiles.set(identity, safeProfile)
    }

    return [...profiles.entries()]
      .filter(([identity]) => !invalidIdentities.has(identity))
      .map(([, profile]) => profile)
  } catch {
    // Profile data is optional relative to the immutable token generation.
    // An unavailable or malformed public cohort may never shift the token
    // ranking; leave only its generic profile fields unknown.
    requireActiveDeadline(options.signal, 'token ranking profile enrichment')
    return []
  }
}

function assertCachedPublication(
  value: Record<string, unknown>,
  head: TokenRankingPublicationHead
): void {
  if (
    value.generation !== head.generation ||
    value.publishedAt !== head.publishedAt ||
    value.publishedAtEpochMs !== head.publishedAtEpochMs ||
    value.windowThroughDate !== head.windowThroughDate ||
    value.sourceAsOf !== head.sourceAsOf ||
    value.sourceThroughDate !== head.sourceThroughDate ||
    value.dailyRowCount !== head.dailyRowCount ||
    value.popularRowCount !== head.popularRowCount
  ) {
    fail('contract', 'cached token ranking publication does not match current head')
  }
}

function parseFinalTrader(value: unknown, expectedRank: number, total: number): TokenTraderRanking {
  if (!isRecord(value) || !hasExactKeys(value, FINAL_TRADER_KEYS)) {
    fail('contract', 'cached token trader shape changed')
  }
  const rank = parseSafeInteger(value.token_rank, 1, Number.MAX_SAFE_INTEGER, 'cached token rank')
  const tradeCount = parseSafeInteger(
    value.token_trade_count,
    0,
    Number.MAX_SAFE_INTEGER,
    'cached token trade count'
  )
  const winRate = parseNullableFiniteNumber(value.token_win_rate, 'cached token win rate')
  if (
    rank !== expectedRank ||
    rank > total ||
    (winRate !== null && (winRate < 0 || winRate > 100)) ||
    typeof value.source !== 'string' ||
    !SOURCE_PATTERN.test(value.source) ||
    typeof value.source_trader_id !== 'string' ||
    value.source_trader_id.length === 0 ||
    value.source_trader_id !== value.source_trader_id.trim()
  ) {
    fail('contract', 'cached token trader violates its authority contract')
  }

  // Never trust profile fields stored in a token-generation cache. Older cache
  // entries may contain an otherwise well-formed but retired public profile;
  // a live sealed-cohort overlay below is the only way to expose these values.
  return {
    source: value.source,
    source_trader_id: value.source_trader_id,
    handle: null,
    avatar_url: null,
    arena_score: null,
    roi: null,
    total_pnl: null,
    token_rank: rank,
    token_pnl: parseFiniteNumber(value.token_pnl, 'cached token PnL'),
    token_trade_count: tradeCount,
    token_win_rate: winRate,
    token_avg_pnl_pct: parseNullableFiniteNumber(
      value.token_avg_pnl_pct,
      'cached average token PnL percent'
    ),
  }
}

function parseCachedTokenPage(
  value: unknown,
  head: TokenRankingPublicationHead,
  input: NormalizedTokenPageInput
): TokenTraderRankingSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, FINAL_TOKEN_PAGE_KEYS)) {
    fail('contract', 'cached token ranking page shape changed')
  }
  assertCachedPublication(value, head)
  if (
    value.contract !== TOKEN_RANKING_PAGE_CONTRACT ||
    value.token !== input.token ||
    value.period !== input.period ||
    value.lookbackDays !== PERIOD_DAYS[input.period] ||
    value.limit !== input.limit ||
    value.offset !== input.offset
  ) {
    fail('contract', 'cached token ranking page does not match its request')
  }
  const total = parseSafeInteger(value.total, 0, Number.MAX_SAFE_INTEGER, 'cached total')
  if (!Array.isArray(value.traders)) fail('contract', 'cached token ranking traders are invalid')
  const expectedLength = Math.min(input.limit, Math.max(total - input.offset, 0))
  if (value.traders.length !== expectedLength) {
    fail('contract', 'cached token ranking cardinality is invalid')
  }
  const seenIdentities = new Set<string>()
  const traders = value.traders.map((trader, index) => {
    const parsed = parseFinalTrader(trader, input.offset + index + 1, total)
    const identity = JSON.stringify([parsed.source, parsed.source_trader_id])
    if (seenIdentities.has(identity)) {
      fail('contract', 'cached token ranking repeats a trader identity')
    }
    seenIdentities.add(identity)
    return parsed
  })
  return {
    ...head,
    contract: TOKEN_RANKING_PAGE_CONTRACT,
    token: input.token,
    period: input.period,
    lookbackDays: PERIOD_DAYS[input.period],
    limit: input.limit,
    offset: input.offset,
    total,
    traders,
    // A token generation does not prove a generic profile publication. Keep
    // this unknown rather than carrying a fence captured by an older cache
    // writer into the current response.
    profilePublicationId: null,
  }
}

function aggregateRowsFromCachedPage(snapshot: TokenTraderRankingSnapshot): AggregateTokenRow[] {
  return snapshot.traders.map((trader) => ({
    source: trader.source,
    source_trader_id: trader.source_trader_id,
    token_rank: trader.token_rank,
    token_pnl: trader.token_pnl,
    token_trade_count: trader.token_trade_count,
    token_win_rate: trader.token_win_rate,
    token_avg_pnl_pct: trader.token_avg_pnl_pct,
    total_count: snapshot.total,
  }))
}

async function overlayLivePublicProfiles(
  supabase: SupabaseClient<Database>,
  snapshot: TokenTraderRankingSnapshot,
  options: TokenRankingReadOptions
): Promise<TokenTraderRankingSnapshot> {
  if (snapshot.traders.length === 0) return { ...snapshot, profilePublicationId: null }

  const rows = aggregateRowsFromCachedPage(snapshot)
  const profiles = await loadProfiles(supabase, snapshot.period, rows, options)
  const page = mergeTokenRankingsWithProfiles(rows, profiles)
  if (page.total !== snapshot.total || page.traders.length !== snapshot.traders.length) {
    fail('contract', 'live profile overlay changed token ranking authority')
  }

  return {
    ...snapshot,
    traders: page.traders,
    // There is intentionally no cached profile publication fence. Every
    // generic field in this response was validated during this request.
    profilePublicationId: null,
  }
}

export function getTokenTraderSnapshotCacheKey(
  generation: string,
  token: string,
  period: TokenRankingPeriod,
  limit: number,
  offset: number
): string {
  return publicRankingCacheKey(
    `rankings:by-token:${TOKEN_RANKING_SNAPSHOT_CACHE_VERSION}:${generation}:${token}:${period}:${limit}:${offset}`
  )
}

async function readTokenPageAtHead(
  supabase: SupabaseClient<Database>,
  head: TokenRankingPublicationHead,
  input: NormalizedTokenPageInput,
  options: TokenRankingReadOptions
): Promise<TokenTraderRankingSnapshot> {
  requireActiveDeadline(options.signal, 'token ranking page')
  const cacheKey = getTokenTraderSnapshotCacheKey(
    head.generation,
    input.token,
    input.period,
    input.limit,
    input.offset
  )
  const cachedOrFresh = await tieredGetOrSet<unknown>(
    cacheKey,
    async () => {
      const result = await readRpcResult(
        'token ranking page',
        () =>
          bindAbortSignal(
            supabase.rpc('get_token_trader_rankings_v2', {
              token_symbol: input.token,
              lookback_days: PERIOD_DAYS[input.period],
              max_traders: input.limit,
              row_offset: input.offset,
              expected_generation: Number(head.generation),
            }),
            options.signal,
            'token ranking page'
          ),
        options.signal
      )
      if (!isRecord(result)) fail('contract', 'token ranking page RPC envelope is invalid')
      if (result.error)
        throwRpcError('token ranking page', result.error as RpcErrorShape, options.signal)
      const { total, rows } = parseRawTokenPage(result.data, head, input)
      // Persist only the token generation facts. Public profile fields have a
      // separate serving head and must be revalidated after every cache read.
      const page = rows.length ? mergeTokenRankingsWithProfiles(rows, []) : { traders: [], total }
      if (page.total !== total) fail('contract', 'token snapshot changed token ranking total')
      const candidate = {
        ...head,
        contract: TOKEN_RANKING_PAGE_CONTRACT,
        token: input.token,
        period: input.period,
        lookbackDays: PERIOD_DAYS[input.period],
        limit: input.limit,
        offset: input.offset,
        total,
        traders: page.traders,
        profilePublicationId: null,
      } satisfies TokenTraderRankingSnapshot
      return parseCachedTokenPage(candidate, head, input)
    },
    'cold',
    [PUBLIC_RANKING_REDIS_TAG, 'by-token', `token-ranking-generation:${head.generation}`],
    { skipMemory: true, writeFenceKey: PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY }
  )
  requireActiveDeadline(options.signal, 'token ranking page')
  const tokenSnapshot = parseCachedTokenPage(cachedOrFresh, head, input)
  const enriched = await overlayLivePublicProfiles(supabase, tokenSnapshot, options)
  requireActiveDeadline(options.signal, 'token ranking page')
  return enriched
}

function parsePopularRows(value: unknown, total: number, limit: number): PopularTokenRanking[] {
  if (!Array.isArray(value)) fail('contract', 'popular token rows must be an array')
  if (value.length !== Math.min(total, limit)) {
    fail('contract', 'popular token cardinality does not match its total')
  }
  const seenTokens = new Set<string>()
  let previous: PopularTokenRanking | null = null
  return value.map((candidate, index) => {
    if (!isRecord(candidate) || !hasExactKeys(candidate, POPULAR_ROW_KEYS)) {
      fail('contract', `popular token row ${index} shape changed`)
    }
    if (
      typeof candidate.token !== 'string' ||
      !isValidTokenSymbol(candidate.token) ||
      seenTokens.has(candidate.token)
    ) {
      fail('contract', `popular token row ${index} token is invalid`)
    }
    const row = {
      token: candidate.token,
      trade_count: parseSafeInteger(
        candidate.trade_count,
        0,
        Number.MAX_SAFE_INTEGER,
        `popular token row ${index} trade count`
      ),
      trader_count: parseSafeInteger(
        candidate.trader_count,
        0,
        Number.MAX_SAFE_INTEGER,
        `popular token row ${index} trader count`
      ),
      total_pnl: parseFiniteNumber(candidate.total_pnl, `popular token row ${index} PnL`),
    }
    if (
      previous &&
      (row.trade_count > previous.trade_count ||
        (row.trade_count === previous.trade_count && row.token <= previous.token))
    ) {
      fail('contract', `popular token row ${index} is not in authoritative order`)
    }
    seenTokens.add(row.token)
    previous = row
    return row
  })
}

function parseRawPopularPage(
  value: unknown,
  head: TokenRankingPublicationHead,
  limit: number
): { total: number; tokens: PopularTokenRanking[] } {
  if (!isRecord(value) || !hasExactKeys(value, POPULAR_PAGE_KEYS)) {
    fail('contract', 'popular token page shape changed')
  }
  if (value.contract !== POPULAR_TOKEN_PAGE_CONTRACT) {
    fail('contract', 'popular token page contract is unsupported')
  }
  assertSamePublication(value, head)
  if (
    parseSafeInteger(value.lookback_days, 1, 90, 'popular lookback_days') !== 90 ||
    parseSafeInteger(value.limit, 1, 60, 'popular limit') !== limit
  ) {
    fail('contract', 'popular token page does not match its request')
  }
  const total = parseSafeInteger(value.total, 0, Number.MAX_SAFE_INTEGER, 'popular total')
  return { total, tokens: parsePopularRows(value.tokens, total, limit) }
}

function parseCachedPopularPage(
  value: unknown,
  head: TokenRankingPublicationHead,
  limit: number
): PopularTokenRankingSnapshot {
  if (!isRecord(value) || !hasExactKeys(value, FINAL_POPULAR_PAGE_KEYS)) {
    fail('contract', 'cached popular token page shape changed')
  }
  assertCachedPublication(value, head)
  if (
    value.contract !== POPULAR_TOKEN_PAGE_CONTRACT ||
    value.lookbackDays !== 90 ||
    value.limit !== limit ||
    !Array.isArray(value.tokens)
  ) {
    fail('contract', 'cached popular token page does not match its request')
  }
  const total = parseSafeInteger(value.total, 0, Number.MAX_SAFE_INTEGER, 'cached popular total')
  if (value.tokens.length !== Math.min(total, limit)) {
    fail('contract', 'cached popular token cardinality is invalid')
  }
  for (const token of value.tokens) {
    if (!isRecord(token) || !hasExactKeys(token, FINAL_POPULAR_TOKEN_KEYS)) {
      fail('contract', 'cached popular token row shape changed')
    }
  }
  const tokens = parsePopularRows(value.tokens, total, limit)
  return {
    ...head,
    contract: POPULAR_TOKEN_PAGE_CONTRACT,
    lookbackDays: 90,
    limit,
    total,
    tokens,
  }
}

export function getPopularTokenSnapshotCacheKey(generation: string, limit: number): string {
  return publicRankingCacheKey(
    `rankings:popular-tokens:${TOKEN_RANKING_SNAPSHOT_CACHE_VERSION}:${generation}:${limit}`
  )
}

async function readPopularPageAtHead(
  supabase: SupabaseClient<Database>,
  head: TokenRankingPublicationHead,
  limit: number,
  options: TokenRankingReadOptions
): Promise<PopularTokenRankingSnapshot> {
  requireActiveDeadline(options.signal, 'popular token page')
  const cacheKey = getPopularTokenSnapshotCacheKey(head.generation, limit)
  const cachedOrFresh = await tieredGetOrSet<unknown>(
    cacheKey,
    async () => {
      const result = await readRpcResult(
        'popular token page',
        () =>
          bindAbortSignal(
            supabase.rpc('get_popular_tokens_v2', {
              lookback_days: 90,
              max_tokens: limit,
              expected_generation: Number(head.generation),
            }),
            options.signal,
            'popular token page'
          ),
        options.signal
      )
      if (!isRecord(result)) fail('contract', 'popular token page RPC envelope is invalid')
      if (result.error)
        throwRpcError('popular token page', result.error as RpcErrorShape, options.signal)
      const { total, tokens } = parseRawPopularPage(result.data, head, limit)
      const candidate = {
        ...head,
        contract: POPULAR_TOKEN_PAGE_CONTRACT,
        lookbackDays: 90,
        limit,
        total,
        tokens,
      } satisfies PopularTokenRankingSnapshot
      return parseCachedPopularPage(candidate, head, limit)
    },
    'cold',
    [PUBLIC_RANKING_REDIS_TAG, 'popular-tokens', `token-ranking-generation:${head.generation}`],
    { skipMemory: true, writeFenceKey: PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY }
  )
  requireActiveDeadline(options.signal, 'popular token page')
  return parseCachedPopularPage(cachedOrFresh, head, limit)
}

async function readCoordinatedSnapshot<T>(
  supabase: SupabaseClient<Database>,
  requestedGeneration: string | undefined,
  readAtHead: (head: TokenRankingPublicationHead) => Promise<T>,
  options: TokenRankingReadOptions
): Promise<T> {
  const head = await readTokenRankingPublicationHead(supabase, options)
  if (requestedGeneration && requestedGeneration !== head.generation) {
    fail('generation_changed', 'requested token ranking generation is no longer current', {
      currentGeneration: head.generation,
    })
  }

  try {
    return await readAtHead(head)
  } catch (error) {
    if (!(error instanceof TokenRankingReadError) || error.kind !== 'generation_changed') {
      throw error
    }
    if (requestedGeneration) {
      fail('generation_changed', 'requested token ranking generation changed during the read', {
        databaseCode: error.databaseCode,
        details: error.details,
        currentGeneration: error.currentGeneration,
        cause: error,
      })
    }

    const retryHead = await readTokenRankingPublicationHead(supabase, options)
    try {
      return await readAtHead(retryHead)
    } catch (retryError) {
      if (retryError instanceof TokenRankingReadError && retryError.kind === 'generation_changed') {
        fail('publication_busy', 'token ranking publication changed repeatedly', {
          databaseCode: retryError.databaseCode,
          details: retryError.details,
          currentGeneration: retryError.currentGeneration,
          cause: retryError,
        })
      }
      throw retryError
    }
  }
}

function normalizeTokenPageInput(input: TokenPageInput): NormalizedTokenPageInput {
  const token = typeof input.token === 'string' ? input.token.toUpperCase() : ''
  if (!isValidTokenSymbol(token)) fail('invalid_input', 'token is not a supported crypto symbol')
  if (!Object.hasOwn(PERIOD_DAYS, input.period)) fail('invalid_input', 'period is unsupported')
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) {
    fail('invalid_input', 'limit is outside 1..200')
  }
  if (
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    input.offset > TOKEN_RANKING_MAX_OFFSET
  ) {
    fail('invalid_input', `offset is outside 0..${TOKEN_RANKING_MAX_OFFSET}`)
  }
  return {
    token,
    period: input.period,
    limit: input.limit,
    offset: input.offset,
    generation:
      input.generation === undefined ? undefined : parseTokenRankingGeneration(input.generation),
  }
}

export async function getTokenTraderRankingSnapshot(
  supabase: SupabaseClient<Database>,
  input: TokenPageInput,
  options: TokenRankingReadOptions = {}
): Promise<TokenTraderRankingSnapshot> {
  const normalized = normalizeTokenPageInput(input)
  return readCoordinatedSnapshot(
    supabase,
    normalized.generation,
    (head) => readTokenPageAtHead(supabase, head, normalized, options),
    options
  )
}

export async function getPopularTokenRankingSnapshot(
  supabase: SupabaseClient<Database>,
  input: PopularPageInput = {},
  options: TokenRankingReadOptions = {}
): Promise<PopularTokenRankingSnapshot> {
  const limit = input.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60) {
    fail('invalid_input', 'popular token limit is outside 1..60')
  }
  const generation =
    input.generation === undefined ? undefined : parseTokenRankingGeneration(input.generation)
  return readCoordinatedSnapshot(
    supabase,
    generation,
    (head) => readPopularPageAtHead(supabase, head, limit, options),
    options
  )
}
