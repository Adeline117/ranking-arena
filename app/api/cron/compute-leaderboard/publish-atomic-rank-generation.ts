import { createHash, randomUUID } from 'node:crypto'

import { SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
import {
  PUBLIC_RANKING_CACHE_EPOCH,
  hasConcretePublicRankingMetrics,
} from '@/lib/rankings/publication-policy'
import type { Period } from '@/lib/utils/arena-score'
import {
  claimLeaderboardRankGeneration,
  type LeaderboardRankGenerationClaim,
} from './claim-rank-generation'
import type { ScoredTrader } from './score-traders'
import {
  buildSourcePublicationRows,
  type ParsedSourcePublicationEvidence,
  type SourcePublicationRow,
} from './source-publication-evidence'

const RPC_TIMEOUT_MS = 30_000
const MANIFEST_LIFETIME_MS = 20 * 60 * 1000
const GENERATION_LEASE_SECONDS = 300
const ROWS_PER_BATCH = 1_000
const PLAN_CONCURRENCY = 4
const MAX_INT4 = 2_147_483_647
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/

const MANIFEST_RESPONSE_KEYS = [
  'contract',
  'inputCount',
  'inputDigest',
  'manifestDigest',
  'manifestId',
  'outputDigest',
  'outputs',
  'validUntil',
] as const
const SCORE_OUTPUT_KEYS = [
  'confidence',
  'factors',
  'quality',
  'source',
  'sourceTraderId',
  'totalScore',
] as const
const SCORE_FACTOR_KEYS = ['consistency', 'drawdown', 'pnl', 'roi', 'sharpe'] as const
const BATCH_PLAN_KEYS = [
  'batch_sha256',
  'canonical_octet_length',
  'contract',
  'first_source',
  'first_source_trader_id',
  'last_source',
  'last_source_trader_id',
  'row_count',
  'score_cohort_id',
  'season_id',
  'source_count',
  'source_proofs',
] as const
const WRITE_SET_PLAN_KEYS = [
  'contract',
  'expected_batch_count',
  'expected_rank_count',
  'score_cohort_id',
  'season_id',
  'write_set_sha256',
] as const
const STAGE_RESPONSE_KEYS = [
  'batch_index',
  'batch_sha256',
  'contract',
  'generation_seq',
  'phase',
  'row_count',
  'score_cohort_id',
  'season_id',
  'source_count',
  'staged_at',
] as const

const DEX_SOURCES = new Set([
  'hyperliquid',
  'gmx',
  'dydx',
  'drift',
  'aevo',
  'gains',
  'jupiter_perps',
  'polymarket',
])

export interface AtomicRankPublicationClient {
  rpc(name: string, args: Readonly<Record<string, unknown>>): unknown
  from(name: 'trader_sources'): {
    upsert(
      rows: readonly Record<string, unknown>[],
      options: Readonly<Record<string, unknown>>
    ): PromiseLike<{ error?: unknown }>
  }
}

export interface PublishAtomicRankGenerationInput {
  supabase: AtomicRankPublicationClient
  season: Period
  sourceEvidence: ParsedSourcePublicationEvidence
  scoredTraders: readonly ScoredTrader[]
  authorizePublication: (preview: AtomicRankPublicationPreview) => Promise<boolean>
}

export interface PublishAtomicRankGenerationOptions {
  scoreCohortId?: string
  computedAt?: string
  validUntil?: string
  rpcTimeoutMs?: number
}

export interface AtomicRankPublicationResult {
  season: Period
  scoreCohortId: string
  generationSeq: number
  publishedCount: number
  sourceCount: number
  manifestId: string
  manifestDigest: string
  writeSetSha256: string
}

export interface AtomicRankPublicationPreview {
  season: Period
  scoreCohortId: string
  publishedCount: number
  publishedCountsBySource: Readonly<Record<string, number>>
  manifestId: string
  manifestDigest: string
}

interface RpcEnvelope {
  data?: unknown
  error?: unknown
  status?: unknown
}

interface AbortableRpcQuery extends PromiseLike<RpcEnvelope> {
  abortSignal?: (signal: AbortSignal) => PromiseLike<RpcEnvelope>
}

interface ScoreInput {
  source: string
  source_trader_id: string
  roi: number
  pnl: number
  max_drawdown: number
  win_rate: number
  sharpe_ratio: number | null
  profit_factor: number | null
  trades_count: number | null
}

interface ScoreFactors {
  roi: number
  pnl: number
  drawdown: number | null
  sharpe: number | null
  consistency: number | null
}

interface ScoreOutput {
  source: string
  sourceTraderId: string
  totalScore: number
  quality: number
  confidence: number
  factors: ScoreFactors
}

interface ManifestSeal {
  manifestId: string
  manifestDigest: string
  outputs: ScoreOutput[]
}

interface TypedRankRow {
  source: string
  source_type: string
  source_trader_id: string
  rank: null
  arena_score: number
  roi: number
  pnl: number
  win_rate: number
  max_drawdown: number
  followers: number
  trades_count: number | null
  handle: string | null
  avatar_url: string
  profitability_score: number
  risk_control_score: number
  execution_score: number | null
  score_completeness: 'full'
  trading_style: string | null
  avg_holding_hours: number | null
  style_confidence: number | null
  sharpe_ratio: number | null
  sortino_ratio: number | null
  profit_factor: number | null
  calmar_ratio: number | null
  trader_type: string | null
  is_outlier: false
  metrics_estimated: false
  rank_change: null
  is_new: null
  copiers: number | null
  arena_score_v4: number
  arena_score_v3: number | null
  score_factors: ScoreFactors
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort(compareText)
  const wanted = [...expected].sort(compareText)
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function requireRecordWithKeys(
  value: unknown,
  expected: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, expected)) {
    throw new Error(`${label} returned a noncanonical response shape`)
  }
  return value
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase sha256`)
  }
  return value
}

function requireUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical lowercase UUID`)
  }
  return value
}

function requireFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be finite`)
  }
  return value
}

function requireNullableFinite(value: unknown, label: string): number | null {
  return value === null ? null : requireFinite(value, label)
}

function canonicalTimestamp(date: Date, label: string): string {
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is invalid`)
  return `${date.toISOString().slice(0, 23)}000Z`
}

function requireCanonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a timestamp`)
  const parsed = new Date(value)
  const canonical = canonicalTimestamp(parsed, label)
  if (value !== canonical) throw new Error(`${label} must use UTC microsecond form`)
  return canonical
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function roundToScale(value: number, scale: number, label: string): number {
  requireFinite(value, label)
  const rounded = Number(value.toFixed(scale))
  if (!Number.isFinite(rounded)) throw new Error(`${label} is outside its numeric scale`)
  return Object.is(rounded, -0) ? 0 : rounded
}

function nullableScaled(value: number | null, scale: number, label: string): number | null {
  return value === null ? null : roundToScale(value, scale, label)
}

function nullableInt4(value: number | null, label: string): number | null {
  if (value === null) return null
  requireFinite(value, label)
  const rounded = Math.round(value)
  if (!Number.isSafeInteger(rounded) || rounded < 0 || rounded > MAX_INT4) {
    throw new Error(`${label} is outside non-negative int4`)
  }
  return rounded
}

function nonNegativeInt4(value: number | null, label: string): number {
  return nullableInt4(value ?? 0, label) ?? 0
}

function sourceKind(source: string): string {
  return source.startsWith('binance_web3') ||
    source.startsWith('okx_web3') ||
    DEX_SOURCES.has(source)
    ? 'dex_leaderboard'
    : 'cex_leaderboard'
}

function scoreKey(source: string, sourceTraderId: string): string {
  return `${source}\u0000${sourceTraderId}`
}

function buildScoreInputs(scoredTraders: readonly ScoredTrader[]): {
  inputs: ScoreInput[]
  tradersByIdentity: Map<string, ScoredTrader>
} {
  const tradersByIdentity = new Map<string, ScoredTrader>()
  const eligible = scoredTraders.filter(hasConcretePublicRankingMetrics)

  for (const trader of eligible) {
    const key = scoreKey(trader.source, trader.source_trader_id)
    if (tradersByIdentity.has(key)) {
      throw new Error(`duplicate score identity ${trader.source}:${trader.source_trader_id}`)
    }
    tradersByIdentity.set(key, trader)
  }

  const inputs = eligible
    .map(
      (trader): ScoreInput => ({
        source: trader.source,
        source_trader_id: trader.source_trader_id,
        roi: roundToScale(trader.roi, 4, `${trader.source}.roi`),
        pnl: roundToScale(trader.pnl as number, 2, `${trader.source}.pnl`),
        max_drawdown: roundToScale(
          trader.max_drawdown as number,
          2,
          `${trader.source}.max_drawdown`
        ),
        win_rate: roundToScale(trader.win_rate as number, 2, `${trader.source}.win_rate`),
        sharpe_ratio: nullableScaled(trader.sharpe_ratio, 4, `${trader.source}.sharpe_ratio`),
        profit_factor: nullableScaled(trader.profit_factor, 4, `${trader.source}.profit_factor`),
        trades_count: nullableInt4(trader.trades_count, `${trader.source}.trades_count`),
      })
    )
    .sort((left, right) => {
      const sourceOrder = compareUtf8(left.source, right.source)
      return sourceOrder || compareUtf8(left.source_trader_id, right.source_trader_id)
    })

  if (inputs.length === 0) {
    throw new Error('atomic rank publication has no concrete eligible score inputs')
  }
  if (inputs.length > 64_000) {
    throw new Error('atomic rank publication exceeds the 64,000-row scorer bound')
  }
  return { inputs, tradersByIdentity }
}

function parseFactors(value: unknown, label: string): ScoreFactors {
  const factors = requireRecordWithKeys(value, SCORE_FACTOR_KEYS, label)
  const parsed = {
    roi: requireFinite(factors.roi, `${label}.roi`),
    pnl: requireFinite(factors.pnl, `${label}.pnl`),
    drawdown: requireNullableFinite(factors.drawdown, `${label}.drawdown`),
    sharpe: requireNullableFinite(factors.sharpe, `${label}.sharpe`),
    consistency: requireNullableFinite(factors.consistency, `${label}.consistency`),
  }
  for (const [name, factor] of Object.entries(parsed)) {
    if (factor !== null && (factor < 0 || factor > 1)) {
      throw new Error(`${label}.${name} must be within 0..1`)
    }
  }
  return parsed
}

function parseManifestSeal(
  value: unknown,
  inputs: readonly ScoreInput[],
  validUntil: string
): ManifestSeal {
  const seal = requireRecordWithKeys(value, MANIFEST_RESPONSE_KEYS, 'manifest prepare RPC')
  if (
    seal.contract !== 'leaderboard-score-input-manifest-seal@1' ||
    seal.inputCount !== inputs.length ||
    seal.validUntil !== validUntil ||
    !Array.isArray(seal.outputs) ||
    seal.outputs.length !== inputs.length
  ) {
    throw new Error('manifest prepare RPC disagrees with the requested score cohort')
  }
  requireSha256(seal.inputDigest, 'manifest inputDigest')
  requireSha256(seal.outputDigest, 'manifest outputDigest')
  const manifestId = requireUuid(seal.manifestId, 'manifestId')
  const manifestDigest = requireSha256(seal.manifestDigest, 'manifestDigest')

  const outputs = seal.outputs.map((rawOutput, index): ScoreOutput => {
    const output = requireRecordWithKeys(rawOutput, SCORE_OUTPUT_KEYS, `score output ${index}`)
    const expected = inputs[index]
    if (output.source !== expected.source || output.sourceTraderId !== expected.source_trader_id) {
      throw new Error(`score output ${index} identity disagrees with canonical input order`)
    }
    const parsed = {
      source: output.source,
      sourceTraderId: output.sourceTraderId,
      totalScore: requireFinite(output.totalScore, `score output ${index}.totalScore`),
      quality: requireFinite(output.quality, `score output ${index}.quality`),
      confidence: requireFinite(output.confidence, `score output ${index}.confidence`),
      factors: parseFactors(output.factors, `score output ${index}.factors`),
    } as ScoreOutput
    if (parsed.totalScore < 0 || parsed.totalScore > 100) {
      throw new Error(`score output ${index}.totalScore must be within 0..100`)
    }
    return parsed
  })
  return { manifestId, manifestDigest, outputs }
}

function derivedScores(factors: ScoreFactors): {
  profitability: number
  risk: number
  execution: number | null
} {
  const profitability = Math.floor((100 * (0.3 * factors.pnl + 0.2 * factors.roi)) / 0.5 + 0.5)
  const riskFactors = [factors.drawdown, factors.sharpe].filter(
    (factor): factor is number => factor !== null
  )
  const risk =
    riskFactors.length === 0
      ? 0
      : Math.floor(
          (100 * riskFactors.reduce((total, factor) => total + factor, 0)) / riskFactors.length +
            0.5
        )
  const execution =
    factors.consistency === null ? null : Math.floor(100 * factors.consistency + 0.5)
  return { profitability, risk, execution }
}

function buildTypedRows(
  inputs: readonly ScoreInput[],
  outputs: readonly ScoreOutput[],
  tradersByIdentity: ReadonlyMap<string, ScoredTrader>
): TypedRankRow[] {
  return outputs.flatMap((output, index): TypedRankRow[] => {
    if (output.totalScore <= 0) return []
    const input = inputs[index]
    const trader = tradersByIdentity.get(scoreKey(input.source, input.source_trader_id))
    if (!trader) throw new Error(`PG scorer output has no immutable trader projection`)
    const scores = derivedScores(output.factors)
    return [
      {
        source: input.source,
        source_type: SOURCE_TYPE_MAP[input.source] || 'futures',
        source_trader_id: input.source_trader_id,
        rank: null,
        arena_score: roundToScale(output.totalScore, 2, `${input.source}.arena_score`),
        roi: input.roi,
        pnl: input.pnl,
        win_rate: input.win_rate,
        max_drawdown: input.max_drawdown,
        followers: nonNegativeInt4(trader.followers, `${input.source}.followers`),
        trades_count: input.trades_count,
        handle: trader.handle,
        avatar_url: trader.avatar_url,
        profitability_score: scores.profitability,
        risk_control_score: scores.risk,
        execution_score: scores.execution,
        score_completeness: 'full',
        trading_style: trader.trading_style,
        avg_holding_hours: nullableScaled(
          trader.avg_holding_hours,
          2,
          `${input.source}.avg_holding_hours`
        ),
        style_confidence: nullableScaled(
          trader.style_confidence,
          4,
          `${input.source}.style_confidence`
        ),
        sharpe_ratio: input.sharpe_ratio,
        sortino_ratio: nullableScaled(trader.sortino_ratio, 4, `${input.source}.sortino_ratio`),
        profit_factor: input.profit_factor,
        calmar_ratio: nullableScaled(trader.calmar_ratio, 4, `${input.source}.calmar_ratio`),
        trader_type: trader.trader_type,
        is_outlier: false,
        metrics_estimated: false,
        rank_change: null,
        is_new: null,
        copiers: nullableInt4(trader.copiers, `${input.source}.copiers`),
        arena_score_v4: roundToScale(output.totalScore, 2, `${input.source}.arena_score_v4`),
        arena_score_v3:
          trader.arena_score_v3 === null
            ? null
            : roundToScale(trader.arena_score_v3, 2, `${input.source}.arena_score_v3`),
        score_factors: output.factors,
      },
    ]
  })
}

function describeRpcError(error: unknown): string {
  if (!isRecord(error)) return String(error)
  const message = typeof error.message === 'string' ? error.message : 'unknown RPC error'
  const code = typeof error.code === 'string' ? error.code : 'unknown'
  return `${message} (code=${code})`
}

async function callRpcAttempt(
  client: AtomicRankPublicationClient,
  name: string,
  args: Readonly<Record<string, unknown>>,
  timeoutMs: number
): Promise<RpcEnvelope> {
  let query: unknown
  try {
    query = client.rpc(name, args)
  } catch (error) {
    throw new Error(`${name} failed before dispatch`, { cause: error })
  }
  if ((typeof query !== 'object' && typeof query !== 'function') || query === null) {
    throw new Error(`${name} returned no query`)
  }
  const then = Reflect.get(query, 'then')
  const abortSignal = Reflect.get(query, 'abortSignal')
  if (typeof then !== 'function' && typeof abortSignal !== 'function') {
    throw new Error(`${name} returned a non-awaitable query`)
  }

  const rpcQuery = query as AbortableRpcQuery
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`${name} exceeded its ${timeoutMs}ms deadline`))
    }, timeoutMs)
  })
  try {
    const awaitable =
      typeof rpcQuery.abortSignal === 'function'
        ? rpcQuery.abortSignal(controller.signal)
        : rpcQuery
    return await Promise.race([Promise.resolve(awaitable), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function callReplaySafeRpc(
  client: AtomicRankPublicationClient,
  name: string,
  args: Readonly<Record<string, unknown>>,
  timeoutMs: number
): Promise<unknown> {
  let firstAmbiguous: unknown
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let envelope: RpcEnvelope
    try {
      envelope = await callRpcAttempt(client, name, args, timeoutMs)
    } catch (error) {
      firstAmbiguous ??= error
      if (attempt === 1) continue
      throw new Error(`${name} remained ambiguous after exact replay`, {
        cause: firstAmbiguous,
      })
    }
    const status = typeof envelope.status === 'number' ? envelope.status : 200
    if (envelope.error !== null && envelope.error !== undefined) {
      if ((status === 0 || status >= 500) && attempt === 1) {
        firstAmbiguous ??= envelope.error
        continue
      }
      if (firstAmbiguous) {
        throw new Error(`${name} could not resolve its first ambiguous attempt`, {
          cause: firstAmbiguous,
        })
      }
      throw new Error(`${name} failed: ${describeRpcError(envelope.error)}`)
    }
    if (envelope.data === null || envelope.data === undefined) {
      throw new Error(`${name} returned null data`)
    }
    return envelope.data
  }
  throw new Error(`${name} did not return a definitive response`)
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const output = new Array<R>(values.length)
  let nextIndex = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex
        nextIndex += 1
        output[index] = await map(values[index], index)
      }
    })
  )
  return output
}

function chunksOf<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

async function ensureTraderSourceParents(
  client: AtomicRankPublicationClient,
  rows: readonly TypedRankRow[],
  computedAt: string
): Promise<void> {
  for (const chunk of chunksOf(rows, ROWS_PER_BATCH)) {
    const parents = chunk.map((row) => ({
      source: row.source,
      source_trader_id: row.source_trader_id,
      source_type: row.source_type,
      handle: row.handle,
      avatar_url: row.avatar_url,
      is_active: true,
      identity_type: 'public',
      source_kind: sourceKind(row.source),
      last_seen_at: computedAt,
    }))
    const response = await client.from('trader_sources').upsert(parents, {
      onConflict: 'source,source_trader_id',
      ignoreDuplicates: true,
    })
    if (response.error !== null && response.error !== undefined) {
      throw new Error(`trader_sources parent upsert failed: ${describeRpcError(response.error)}`)
    }
  }
}

function parseBatchPlan(
  value: unknown,
  season: Period,
  scoreCohortId: string,
  rows: readonly TypedRankRow[]
): string {
  const plan = requireRecordWithKeys(value, BATCH_PLAN_KEYS, 'batch planner RPC')
  if (
    plan.contract !== 'leaderboard-rank-persisted-batch-evidence@1' ||
    plan.season_id !== season ||
    plan.score_cohort_id !== scoreCohortId ||
    plan.row_count !== rows.length ||
    plan.first_source !== rows[0]?.source ||
    plan.first_source_trader_id !== rows[0]?.source_trader_id ||
    plan.last_source !== rows.at(-1)?.source ||
    plan.last_source_trader_id !== rows.at(-1)?.source_trader_id ||
    !Number.isSafeInteger(plan.source_count) ||
    !Number.isSafeInteger(plan.canonical_octet_length) ||
    !Array.isArray(plan.source_proofs)
  ) {
    throw new Error('batch planner RPC disagrees with its typed rows')
  }
  return requireSha256(plan.batch_sha256, 'batch_sha256')
}

function parseWriteSetPlan(
  value: unknown,
  season: Period,
  scoreCohortId: string,
  expectedRankCount: number,
  expectedBatchCount: number
): string {
  const plan = requireRecordWithKeys(value, WRITE_SET_PLAN_KEYS, 'write-set planner RPC')
  if (
    plan.contract !== 'leaderboard-rank-generation-write-set-plan@1' ||
    plan.season_id !== season ||
    plan.score_cohort_id !== scoreCohortId ||
    plan.expected_rank_count !== expectedRankCount ||
    plan.expected_batch_count !== expectedBatchCount
  ) {
    throw new Error('write-set planner RPC disagrees with the generation')
  }
  return requireSha256(plan.write_set_sha256, 'write_set_sha256')
}

function parseStageResponse(
  value: unknown,
  claim: LeaderboardRankGenerationClaim,
  batchIndex: number,
  batchSha256: string,
  rowCount: number
): void {
  const stage = requireRecordWithKeys(value, STAGE_RESPONSE_KEYS, 'stage RPC')
  if (
    stage.contract !== 'leaderboard-rank-generation-batch-stage@1' ||
    stage.season_id !== claim.season_id ||
    stage.generation_seq !== claim.generation_seq ||
    stage.score_cohort_id !== claim.score_cohort_id ||
    stage.phase !== 'writing' ||
    stage.batch_index !== batchIndex ||
    stage.batch_sha256 !== batchSha256 ||
    stage.row_count !== rowCount ||
    !Number.isSafeInteger(stage.source_count) ||
    typeof stage.staged_at !== 'string'
  ) {
    throw new Error(`stage RPC returned a conflicting receipt for batch ${batchIndex}`)
  }
}

function buildFinalSourcePayload(
  sourcePublications: readonly SourcePublicationRow[],
  rows: readonly TypedRankRow[]
): Array<{ source: string; source_as_of: string; trader_ids: string[] }> {
  const identitiesBySource = new Map<string, string[]>(
    sourcePublications.map((publication) => [publication.source, []])
  )
  for (const row of rows) {
    const identities = identitiesBySource.get(row.source)
    if (!identities) throw new Error(`rank row uses non-authoritative source ${row.source}`)
    identities.push(row.source_trader_id)
  }
  return sourcePublications.map((publication) => {
    const traderIds = identitiesBySource.get(publication.source) ?? []
    traderIds.sort(compareUtf8)
    if (traderIds.length !== publication.published_rank_count) {
      throw new Error(`${publication.source} final identity count drifted`)
    }
    return {
      source: publication.source,
      source_as_of: publication.source_as_of,
      trader_ids: traderIds,
    }
  })
}

function parseFinalization(
  value: unknown,
  claim: LeaderboardRankGenerationClaim,
  sourcePublications: readonly SourcePublicationRow[],
  publishedCount: number
): void {
  if (!isRecord(value)) throw new Error('finalizer returned a non-object response')
  if (
    value.contract !== 'leaderboard-rank-generation-finalization@1' ||
    value.season_id !== claim.season_id ||
    value.generation_seq !== claim.generation_seq ||
    value.score_cohort_id !== claim.score_cohort_id ||
    value.phase !== 'sealed' ||
    value.is_sealed !== true ||
    typeof value.replayed !== 'boolean' ||
    !isRecord(value.publication)
  ) {
    throw new Error('finalizer response does not match the claimed generation')
  }
  const publication = value.publication
  if (
    publication.contract !== 'leaderboard-rank-publication@1' ||
    publication.season_id !== claim.season_id ||
    publication.score_cohort_id !== claim.score_cohort_id ||
    publication.source_count !== sourcePublications.length ||
    publication.trader_count !== publishedCount ||
    publication.is_sealed !== true ||
    !Array.isArray(publication.proofs) ||
    publication.proofs.length !== sourcePublications.length
  ) {
    throw new Error('finalizer publication proof does not match the staged generation')
  }
  const expectedBySource = new Map(
    sourcePublications.map((publicationRow) => [publicationRow.source, publicationRow])
  )
  for (const rawProof of publication.proofs) {
    if (!isRecord(rawProof) || typeof rawProof.source !== 'string') {
      throw new Error('finalizer returned a malformed source proof')
    }
    const expected = expectedBySource.get(rawProof.source)
    if (
      !expected ||
      rawProof.source_as_of !== expected.source_as_of ||
      rawProof.score_cohort_id !== claim.score_cohort_id ||
      rawProof.published_rank_count !== expected.published_rank_count ||
      !Number.isSafeInteger(rawProof.rank_mutation_seq) ||
      !SHA256_PATTERN.test(String(rawProof.published_identity_sha256))
    ) {
      throw new Error(`finalizer returned a conflicting proof for ${rawProof.source}`)
    }
    expectedBySource.delete(rawProof.source)
  }
  if (expectedBySource.size !== 0) throw new Error('finalizer omitted a source proof')
}

export async function publishAtomicRankGeneration(
  input: PublishAtomicRankGenerationInput,
  options: PublishAtomicRankGenerationOptions = {}
): Promise<AtomicRankPublicationResult | null> {
  const { supabase, season, sourceEvidence, scoredTraders, authorizePublication } = input
  if (sourceEvidence.window !== season) {
    throw new Error(`[${season}] source publication evidence window disagrees`)
  }
  if (sourceEvidence.aliases.length === 0 || sourceEvidence.retainedAliases.length > 0) {
    const retained = sourceEvidence.retainedAliases
      .map((alias) => `${alias.source}:${alias.denial_reasons.join('+')}`)
      .join(',')
    throw new Error(
      `[${season}] exact source authority is not fully publishable${retained ? ` (${retained})` : ''}`
    )
  }
  if (sourceEvidence.freshAliases.length !== sourceEvidence.aliases.length) {
    throw new Error(`[${season}] fresh source authority does not exactly cover the registry`)
  }

  const scoreCohortId = requireUuid(options.scoreCohortId ?? randomUUID(), 'scoreCohortId')
  const now = new Date()
  const computedAt = options.computedAt
    ? requireCanonicalTimestamp(options.computedAt, 'computedAt')
    : canonicalTimestamp(now, 'computedAt')
  const validUntil = options.validUntil
    ? requireCanonicalTimestamp(options.validUntil, 'validUntil')
    : canonicalTimestamp(new Date(now.getTime() + MANIFEST_LIFETIME_MS), 'validUntil')
  if (Date.parse(validUntil) <= Date.now() + GENERATION_LEASE_SECONDS * 1000) {
    throw new Error('manifest validity must outlive the complete generation lease')
  }
  const rpcTimeoutMs = options.rpcTimeoutMs ?? RPC_TIMEOUT_MS
  if (!Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs <= 0 || rpcTimeoutMs > 60_000) {
    throw new Error('rpcTimeoutMs must be an integer within 1..60000')
  }

  const { inputs, tradersByIdentity } = buildScoreInputs(scoredTraders)
  const sourceBundleDigest = sha256Json({
    scoreRows: sourceEvidence.scoreRows,
    physicalBoards: sourceEvidence.physicalBoards,
  })
  const scoreRowsSha256 = sha256Json(sourceEvidence.scoreRows)
  const physicalBoardsSha256 = sha256Json(sourceEvidence.physicalBoards)
  const identityPairs = inputs.map(({ source, source_trader_id }) => [source, source_trader_id])
  const sourceManifestEvidence = {
    contract: 'leaderboard-source-publication-attempt@1',
    window: season,
    sourceCount: sourceEvidence.aliases.length,
    aliases: sourceEvidence.aliases,
  }
  const enrichmentEvidence = {
    inputCount: inputs.length,
    normalizedInputSha256: sha256Json(inputs),
  }
  const eligibilityEvidence = {
    policyEpoch: PUBLIC_RANKING_CACHE_EPOCH,
    eligibleIdentitySha256: sha256Json(identityPairs),
    eligibleCount: inputs.length,
  }

  const rawManifest = await callReplaySafeRpc(
    supabase,
    'prepare_leaderboard_score_input_manifest_v1',
    {
      p_period: season,
      p_source_bundle_digest: sourceBundleDigest,
      p_score_rows_sha256: scoreRowsSha256,
      p_physical_boards_sha256: physicalBoardsSha256,
      p_source_evidence: sourceManifestEvidence,
      p_enrichment_contract: 'leaderboard-rank-enrichment-evidence@1',
      p_enrichment_evidence: enrichmentEvidence,
      p_eligibility_contract: 'leaderboard-rank-eligibility-evidence@1',
      p_eligibility_evidence: eligibilityEvidence,
      p_inputs: inputs,
      p_valid_until: validUntil,
    },
    rpcTimeoutMs
  )
  const manifest = parseManifestSeal(rawManifest, inputs, validUntil)
  const typedRows = buildTypedRows(inputs, manifest.outputs, tradersByIdentity)
  if (typedRows.length === 0) {
    throw new Error(`[${season}] PG17 scorer produced no positive public ranks`)
  }
  const rankCounts = new Map<string, number>(
    sourceEvidence.freshAliases.map((alias) => [alias.source, 0])
  )
  for (const row of typedRows) {
    if (!rankCounts.has(row.source)) {
      throw new Error(`[${season}] PG17 scorer emitted non-authoritative source ${row.source}`)
    }
    rankCounts.set(row.source, (rankCounts.get(row.source) ?? 0) + 1)
  }
  const publishedCountsBySource = Object.fromEntries(
    [...rankCounts.entries()].sort(([left], [right]) => compareUtf8(left, right))
  )
  if (
    !(await authorizePublication({
      season,
      scoreCohortId,
      publishedCount: typedRows.length,
      publishedCountsBySource,
      manifestId: manifest.manifestId,
      manifestDigest: manifest.manifestDigest,
    }))
  ) {
    return null
  }

  const sourcePublications = buildSourcePublicationRows(sourceEvidence, {
    publishId: scoreCohortId,
    finalRankCounts: rankCounts,
  })
  const batches = chunksOf(typedRows, ROWS_PER_BATCH)
  const batchSha256Plan = await mapConcurrent(batches, PLAN_CONCURRENCY, async (rows) =>
    parseBatchPlan(
      await callReplaySafeRpc(
        supabase,
        'plan_leaderboard_rank_generation_batch_v1',
        {
          p_season_id: season,
          p_score_cohort_id: scoreCohortId,
          p_computed_at: computedAt,
          p_rows: rows,
        },
        rpcTimeoutMs
      ),
      season,
      scoreCohortId,
      rows
    )
  )
  const writeSetSha256 = parseWriteSetPlan(
    await callReplaySafeRpc(
      supabase,
      'plan_leaderboard_rank_generation_write_set_v1',
      {
        p_season_id: season,
        p_score_cohort_id: scoreCohortId,
        p_score_input_manifest_digest: manifest.manifestDigest,
        p_computed_at: computedAt,
        p_expected_rank_count: typedRows.length,
        p_batch_sha256_plan: batchSha256Plan,
      },
      rpcTimeoutMs
    ),
    season,
    scoreCohortId,
    typedRows.length,
    batches.length
  )

  await ensureTraderSourceParents(supabase, typedRows, computedAt)

  const claim = await claimLeaderboardRankGeneration(supabase as never, {
    season,
    scoreCohortId,
    writeSetSha256,
    expectedRankCount: typedRows.length,
    expectedBatchCount: batches.length,
    computedAt,
    leaseSeconds: GENERATION_LEASE_SECONDS,
  })

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const rows = batches[batchIndex]
    const response = await callReplaySafeRpc(
      supabase,
      'stage_leaderboard_rank_generation_batch_v1',
      {
        p_season_id: season,
        p_generation_seq: claim.generation_seq,
        p_score_cohort_id: scoreCohortId,
        p_batch_index: batchIndex,
        p_score_input_manifest_id: manifest.manifestId,
        p_score_input_manifest_digest: manifest.manifestDigest,
        p_batch_sha256_plan: batchSha256Plan,
        p_rows: rows,
      },
      rpcTimeoutMs
    )
    parseStageResponse(response, claim, batchIndex, batchSha256Plan[batchIndex], rows.length)
  }

  const finalSourcePayload = buildFinalSourcePayload(sourcePublications, typedRows)
  const finalization = await callReplaySafeRpc(
    supabase,
    'finalize_leaderboard_rank_generation_v1',
    {
      p_season_id: season,
      p_generation_seq: claim.generation_seq,
      p_score_cohort_id: scoreCohortId,
      p_score_input_manifest_id: manifest.manifestId,
      p_score_input_manifest_digest: manifest.manifestDigest,
      p_source_publications: finalSourcePayload,
    },
    rpcTimeoutMs
  )
  parseFinalization(finalization, claim, sourcePublications, typedRows.length)

  return {
    season,
    scoreCohortId,
    generationSeq: claim.generation_seq,
    publishedCount: typedRows.length,
    sourceCount: sourcePublications.length,
    manifestId: manifest.manifestId,
    manifestDigest: manifest.manifestDigest,
    writeSetSha256,
  }
}
