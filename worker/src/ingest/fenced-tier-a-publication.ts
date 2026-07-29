import type { IngestQueryExecutor } from '@/lib/ingest/db'
import type { BoardSeriesBlock, ParsedLeaderboardRow, SourceRow } from '@/lib/ingest/core/types'
import {
  prepareBoardSeriesPublication,
  publishBoardSeriesInTransaction,
  publishLeaderboardSnapshotInTransaction,
  publishTrustedLeaderboardSnapshotInTransaction,
  type PublishBoardSeriesOptions,
  type PublishSnapshotInput,
  type PublishSnapshotResult,
  type PublishTrustedSnapshotInput,
} from '@/lib/ingest/serving/publish'
import {
  fenceAttemptBoundLeaderboardEvidencePublicationCommit,
  prepareLeaderboardAttemptBoundV4Evidence,
  snapshotLeaderboardTrustValue,
  type LeaderboardAttemptBoundV4Bundle,
  type PreparedLeaderboardAttemptBoundV4Evidence,
} from '@/lib/ingest/serving/metric-trust-publish'

import {
  assertSourceMatchesConsumedRegion,
  type AuthorizedConsumedRegionContext,
} from './consumed-region-context'
import {
  assertTierAExecutionClaimedWrite,
  SOURCE_JOB_EXECUTION_CONTRACT,
  type SourceJobExecutionAuthority,
  type TierAExecutionClaimedWrite,
} from './source-job-execution-authority'

export type TierAPublicationFenceErrorCode =
  | 'authority_identity_mismatch'
  | 'execution_authority_mismatch'
  | 'execution_transaction_unauthorized'
  | 'source_configuration_mismatch'
  | 'source_identity_mismatch'
  | 'source_inactive'
  | 'source_missing'
  | 'source_registry_contract_violation'
  | 'source_region_mismatch'
  | 'source_timeframe_not_native'
  | 'trader_identity_mismatch'

export class TierAPublicationFenceError extends Error {
  readonly code: TierAPublicationFenceErrorCode

  constructor(code: TierAPublicationFenceErrorCode) {
    super(`[ingest-worker] Tier-A publication rejected (${code})`)
    this.name = 'TierAPublicationFenceError'
    this.code = code
  }
}

interface LockedSourceAuthorityRow {
  adapter_slug: string
  exchange_id: number
  fetch_region: string
  id: number
  page_size: number | null
  pagination_kind: string | null
  product_type: string
  serving_mode: string
  slug: string
  status: string
  timeframes_derived: number[]
  timeframes_native: number[]
  trader_kind_scope: string
}

interface LockedTraderIdentityRow {
  bot_strategy: string | null
  exchange_trader_id: string
  trader_kind: string | null
}

interface TierAPublicationSourceContract {
  readonly adapter_slug: string
  readonly exchange_id: number
  readonly fetch_region: SourceRow['fetch_region']
  readonly id: number
  readonly page_size: number | null
  readonly pagination_kind: SourceRow['pagination_kind']
  readonly product_type: SourceRow['product_type']
  readonly serving_mode: SourceRow['serving_mode']
  readonly slug: string
  readonly status: SourceRow['status']
  readonly timeframes_derived: readonly number[]
  readonly timeframes_native: readonly number[]
  readonly trader_kind_scope: SourceRow['trader_kind_scope']
}

interface TierAPublicationTraderIdentity {
  readonly botStrategy: ParsedLeaderboardRow['botStrategy']
  readonly exchangeTraderId: string
  readonly traderKind: ParsedLeaderboardRow['traderKind']
}

function publicationFenceError(code: TierAPublicationFenceErrorCode): TierAPublicationFenceError {
  return new TierAPublicationFenceError(code)
}

function snapshotTimeframeRegistry(value: unknown): readonly number[] {
  if (
    !Array.isArray(value) ||
    value.some((timeframe) => typeof timeframe !== 'number' || !Number.isSafeInteger(timeframe))
  ) {
    throw publicationFenceError('source_registry_contract_violation')
  }
  return Object.freeze([...value])
}

function snapshotSourceContract(src: SourceRow): TierAPublicationSourceContract {
  if (
    !Number.isSafeInteger(src.id) ||
    typeof src.slug !== 'string' ||
    typeof src.status !== 'string' ||
    typeof src.fetch_region !== 'string' ||
    typeof src.adapter_slug !== 'string' ||
    !Number.isSafeInteger(src.exchange_id) ||
    (src.page_size !== null && !Number.isSafeInteger(src.page_size)) ||
    (src.pagination_kind !== null && typeof src.pagination_kind !== 'string') ||
    typeof src.product_type !== 'string' ||
    typeof src.serving_mode !== 'string' ||
    typeof src.trader_kind_scope !== 'string'
  ) {
    throw publicationFenceError('source_registry_contract_violation')
  }
  return Object.freeze({
    adapter_slug: src.adapter_slug,
    exchange_id: src.exchange_id,
    fetch_region: src.fetch_region,
    id: src.id,
    page_size: src.page_size,
    pagination_kind: src.pagination_kind,
    product_type: src.product_type,
    serving_mode: src.serving_mode,
    slug: src.slug,
    status: src.status,
    timeframes_derived: snapshotTimeframeRegistry(src.timeframes_derived),
    timeframes_native: snapshotTimeframeRegistry(src.timeframes_native),
    trader_kind_scope: src.trader_kind_scope,
  })
}

function snapshotPublicationTimeframes(timeframes: readonly number[]): readonly number[] {
  if (
    !Array.isArray(timeframes) ||
    timeframes.length === 0 ||
    timeframes.some((timeframe) => ![7, 30, 90].includes(timeframe))
  ) {
    throw publicationFenceError('source_timeframe_not_native')
  }
  return Object.freeze([...new Set(timeframes)].sort((left, right) => left - right))
}

function exactTimeframes(left: readonly number[], right: readonly number[]): boolean {
  return (
    left.length === right.length && left.every((timeframe, index) => timeframe === right[index])
  )
}

function snapshotTraderIdentities(
  rows: readonly ParsedLeaderboardRow[]
): readonly TierAPublicationTraderIdentity[] {
  const byExchangeTraderId = new Map<string, TierAPublicationTraderIdentity>()
  for (const row of rows) {
    if (
      typeof row.exchangeTraderId !== 'string' ||
      row.exchangeTraderId.length === 0 ||
      (row.traderKind !== 'human' && row.traderKind !== 'bot') ||
      (row.botStrategy !== null && !['martingale', 'grid', 'ai'].includes(row.botStrategy))
    ) {
      throw publicationFenceError('source_registry_contract_violation')
    }
    const identity = Object.freeze({
      botStrategy: row.botStrategy,
      exchangeTraderId: row.exchangeTraderId,
      traderKind: row.traderKind,
    })
    const existing = byExchangeTraderId.get(identity.exchangeTraderId)
    if (
      existing !== undefined &&
      (existing.traderKind !== identity.traderKind || existing.botStrategy !== identity.botStrategy)
    ) {
      throw publicationFenceError('trader_identity_mismatch')
    }
    byExchangeTraderId.set(identity.exchangeTraderId, identity)
  }
  return Object.freeze([...byExchangeTraderId.values()])
}

function assertAuthorityIdentity(context: AuthorizedConsumedRegionContext): void {
  context.assertCanConsume()
  const expectedScope = `region:${context.consumedRegion}`
  if (
    context.authority.proof.region !== context.consumedRegion ||
    context.authority.proof.authorityScope !== expectedScope ||
    !context.authority.isActive()
  ) {
    throw publicationFenceError('authority_identity_mismatch')
  }
}

function assertExecutionAuthorityBinding(
  src: TierAPublicationSourceContract,
  context: AuthorizedConsumedRegionContext,
  execution: SourceJobExecutionAuthority
): void {
  try {
    const proof = execution.proof
    const regionProof = context.authority.proof
    if (
      !Object.isFrozen(execution) ||
      !Object.isFrozen(proof) ||
      proof.contract !== SOURCE_JOB_EXECUTION_CONTRACT ||
      proof.phase !== 'active' ||
      proof.sourceId !== src.id ||
      proof.executionRegion !== context.executionRegion ||
      proof.executionRegion !== context.consumedRegion ||
      proof.authorityScope !== regionProof.authorityScope ||
      proof.authorityScope !== `region:${context.consumedRegion}` ||
      proof.authorityEpoch !== regionProof.databaseEpoch ||
      proof.workerInstanceId !== regionProof.instanceId ||
      proof.workerNodeId !== regionProof.nodeId ||
      proof.workerRegion !== regionProof.region ||
      proof.workerRegion !== context.consumedRegion ||
      proof.controlEpoch !== regionProof.controlEpoch ||
      execution.signal === undefined ||
      !(execution.signal instanceof AbortSignal) ||
      typeof execution.assertActive !== 'function' ||
      typeof execution.withClaimedWrite !== 'function'
    ) {
      throw publicationFenceError('execution_authority_mismatch')
    }
  } catch (error) {
    if (error instanceof TierAPublicationFenceError) throw error
    throw publicationFenceError('execution_authority_mismatch')
  }

  // Preserve the execution authority's sticky ownership error. Callers use
  // that classification to close a lost claim as revoked rather than failed.
  execution.assertActive()
}

function assertClaimedPublicationTransaction(
  transaction: unknown,
  expected: TierAExecutionClaimedWrite,
  execution: SourceJobExecutionAuthority
): asserts transaction is TierAExecutionClaimedWrite {
  try {
    assertTierAExecutionClaimedWrite(transaction)
    if (transaction !== expected || transaction.signal !== execution.signal) {
      throw publicationFenceError('execution_transaction_unauthorized')
    }
  } catch (error) {
    if (error instanceof TierAPublicationFenceError) throw error
    throw publicationFenceError('execution_transaction_unauthorized')
  }
}

function throwIfPublicationCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  throw reason instanceof Error ? reason : new Error('[ingest-worker] Tier-A publication cancelled')
}

async function lockAndAssertLiveSourceAuthority(
  transaction: IngestQueryExecutor,
  src: TierAPublicationSourceContract,
  publicationTimeframes: readonly number[],
  context: AuthorizedConsumedRegionContext
): Promise<void> {
  // The serving publisher invokes this guard only after taking its per-source
  // publication advisory lock and before any snapshot/baseline/series DML.
  // The row lock keeps this exact registry contract stable through commit.
  const result = await transaction.query<LockedSourceAuthorityRow>(
    `SELECT source.id::integer AS id,
            source.slug,
            source.status,
            source.fetch_region,
            source.adapter_slug,
            source.exchange_id::integer AS exchange_id,
            source.serving_mode,
            source.product_type,
            source.trader_kind_scope,
            source.page_size,
            source.pagination_kind,
            source.timeframes_native,
            source.timeframes_derived
       FROM arena.sources AS source
      WHERE source.id = $1::smallint
      FOR SHARE OF source`,
    [src.id]
  )
  if (result.rows.length === 0 && result.rowCount === 0) {
    throw publicationFenceError('source_missing')
  }
  if (result.rows.length !== 1 || result.rowCount !== 1) {
    throw publicationFenceError('source_registry_contract_violation')
  }
  const live = result.rows[0]
  if (
    !Number.isSafeInteger(live.id) ||
    typeof live.slug !== 'string' ||
    typeof live.status !== 'string' ||
    typeof live.fetch_region !== 'string' ||
    typeof live.adapter_slug !== 'string' ||
    !Number.isSafeInteger(live.exchange_id) ||
    typeof live.serving_mode !== 'string' ||
    typeof live.product_type !== 'string' ||
    typeof live.trader_kind_scope !== 'string' ||
    (live.page_size !== null && !Number.isSafeInteger(live.page_size)) ||
    (live.pagination_kind !== null && typeof live.pagination_kind !== 'string') ||
    !Array.isArray(live.timeframes_native) ||
    live.timeframes_native.some(
      (timeframe) => typeof timeframe !== 'number' || !Number.isSafeInteger(timeframe)
    ) ||
    !Array.isArray(live.timeframes_derived) ||
    live.timeframes_derived.some(
      (timeframe) => typeof timeframe !== 'number' || !Number.isSafeInteger(timeframe)
    )
  ) {
    throw publicationFenceError('source_registry_contract_violation')
  }
  if (live.id !== src.id || live.slug !== src.slug) {
    throw publicationFenceError('source_identity_mismatch')
  }
  if (live.status !== 'active') {
    throw publicationFenceError('source_inactive')
  }
  if (live.status !== src.status) {
    throw publicationFenceError('source_configuration_mismatch')
  }
  if (live.fetch_region !== src.fetch_region || live.fetch_region !== context.consumedRegion) {
    throw publicationFenceError('source_region_mismatch')
  }
  if (
    live.adapter_slug !== src.adapter_slug ||
    live.exchange_id !== src.exchange_id ||
    live.serving_mode !== src.serving_mode ||
    live.product_type !== src.product_type ||
    live.trader_kind_scope !== src.trader_kind_scope ||
    live.page_size !== src.page_size ||
    live.pagination_kind !== src.pagination_kind ||
    !exactTimeframes(live.timeframes_native, src.timeframes_native) ||
    !exactTimeframes(live.timeframes_derived, src.timeframes_derived)
  ) {
    throw publicationFenceError('source_configuration_mismatch')
  }
  if (
    publicationTimeframes.some(
      (timeframe) =>
        !live.timeframes_native.includes(timeframe) || live.timeframes_derived.includes(timeframe)
    )
  ) {
    throw publicationFenceError('source_timeframe_not_native')
  }
}

async function lockAndAssertExistingTraderIdentities(
  transaction: IngestQueryExecutor,
  sourceId: number,
  expectedIdentities: readonly TierAPublicationTraderIdentity[]
): Promise<void> {
  if (expectedIdentities.length === 0) return
  // Lock identities that already exist before snapshot DML. A trader inserted
  // after this read is still covered by upsertTraders' exact conflict predicate.
  const expectedByExchangeTraderId = new Map(
    expectedIdentities.map((identity) => [identity.exchangeTraderId, identity])
  )
  const result = await transaction.query<LockedTraderIdentityRow>(
    `SELECT trader.exchange_trader_id,
            trader.trader_kind,
            trader.bot_strategy
       FROM arena.traders AS trader
      WHERE trader.source_id = $1::smallint
        AND trader.exchange_trader_id = ANY($2::text[])
      FOR SHARE OF trader`,
    [sourceId, expectedIdentities.map((identity) => identity.exchangeTraderId)]
  )
  if (result.rowCount !== null && result.rowCount !== result.rows.length) {
    throw publicationFenceError('source_registry_contract_violation')
  }
  const seen = new Set<string>()
  for (const live of result.rows) {
    if (
      typeof live.exchange_trader_id !== 'string' ||
      (live.trader_kind !== null && typeof live.trader_kind !== 'string') ||
      (live.bot_strategy !== null && typeof live.bot_strategy !== 'string') ||
      seen.has(live.exchange_trader_id)
    ) {
      throw publicationFenceError('source_registry_contract_violation')
    }
    seen.add(live.exchange_trader_id)
    const expected = expectedByExchangeTraderId.get(live.exchange_trader_id)
    if (expected === undefined) {
      throw publicationFenceError('source_registry_contract_violation')
    }
    if (live.trader_kind !== expected.traderKind || live.bot_strategy !== expected.botStrategy) {
      throw publicationFenceError('trader_identity_mismatch')
    }
  }
}

async function withFencedTierAPublication<T>(
  src: SourceRow,
  publicationTimeframes: readonly number[],
  traderIdentities: readonly ParsedLeaderboardRow[],
  context: AuthorizedConsumedRegionContext,
  publish: (
    transaction: IngestQueryExecutor,
    sourceAuthorityGuard: (transaction: IngestQueryExecutor) => Promise<void>
  ) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  throwIfPublicationCancelled(signal)
  assertSourceMatchesConsumedRegion(src, context)
  assertAuthorityIdentity(context)
  const sourceContract = snapshotSourceContract(src)
  const guardedTimeframes = snapshotPublicationTimeframes(publicationTimeframes)
  const expectedTraderIdentities = snapshotTraderIdentities(traderIdentities)
  return context.authority.withFencedWrite(async (transaction) => {
    throwIfPublicationCancelled(signal)
    const result = await publish(transaction, async (lockedTransaction) => {
      throwIfPublicationCancelled(signal)
      await lockAndAssertLiveSourceAuthority(
        lockedTransaction,
        sourceContract,
        guardedTimeframes,
        context
      )
      throwIfPublicationCancelled(signal)
      await lockAndAssertExistingTraderIdentities(
        lockedTransaction,
        sourceContract.id,
        expectedTraderIdentities
      )
      throwIfPublicationCancelled(signal)
    })
    // Throwing inside withFencedWrite rolls every mutation in this publication
    // back before its transaction can commit, even if cancellation arrived
    // while an individual SQL statement was in flight.
    throwIfPublicationCancelled(signal)
    return result
  })
}

/**
 * Run publication inside the execution claim's callback-scoped transaction.
 *
 * This is the production path for claimed Tier-A work. It deliberately never
 * calls the region authority's withFencedWrite: SourceJobExecutionAuthority
 * owns the one PostgreSQL transaction and performs the durable claim assertion
 * before exposing the runtime-branded executor.
 */
async function withClaimedTierAPublication<T>(
  src: SourceRow,
  publicationTimeframes: readonly number[],
  traderIdentities: readonly ParsedLeaderboardRow[],
  context: AuthorizedConsumedRegionContext,
  execution: SourceJobExecutionAuthority,
  publish: (
    transaction: TierAExecutionClaimedWrite,
    sourceAuthorityGuard: (transaction: IngestQueryExecutor) => Promise<void>
  ) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  throwIfPublicationCancelled(signal)
  assertSourceMatchesConsumedRegion(src, context)
  assertAuthorityIdentity(context)
  const sourceContract = snapshotSourceContract(src)
  const guardedTimeframes = snapshotPublicationTimeframes(publicationTimeframes)
  const expectedTraderIdentities = snapshotTraderIdentities(traderIdentities)
  assertExecutionAuthorityBinding(sourceContract, context, execution)
  throwIfPublicationCancelled(execution.signal)

  return execution.withClaimedWrite(async (transaction) => {
    assertClaimedPublicationTransaction(transaction, transaction, execution)
    throwIfPublicationCancelled(signal)
    throwIfPublicationCancelled(execution.signal)
    let sourceAuthorityGuarded = false
    const result = await publish(transaction, async (lockedTransaction) => {
      assertClaimedPublicationTransaction(lockedTransaction, transaction, execution)
      throwIfPublicationCancelled(signal)
      throwIfPublicationCancelled(execution.signal)
      await lockAndAssertLiveSourceAuthority(
        transaction,
        sourceContract,
        guardedTimeframes,
        context
      )
      assertClaimedPublicationTransaction(transaction, transaction, execution)
      throwIfPublicationCancelled(signal)
      throwIfPublicationCancelled(execution.signal)
      await lockAndAssertExistingTraderIdentities(
        transaction,
        sourceContract.id,
        expectedTraderIdentities
      )
      assertClaimedPublicationTransaction(transaction, transaction, execution)
      throwIfPublicationCancelled(signal)
      throwIfPublicationCancelled(execution.signal)
      sourceAuthorityGuarded = true
    })
    if (!sourceAuthorityGuarded) {
      throw publicationFenceError('source_registry_contract_violation')
    }
    assertClaimedPublicationTransaction(transaction, transaction, execution)
    throwIfPublicationCancelled(signal)
    throwIfPublicationCancelled(execution.signal)
    execution.assertActive()
    return result
  })
}

function reportCommittedBaselineShift(
  input: Pick<PublishSnapshotInput, 'src' | 'timeframe' | 'rows'>,
  result: PublishSnapshotResult
): void {
  if (!result.baselineShifted) return
  try {
    console.warn(
      `[publish] ${input.src.slug} tf${input.timeframe}: sustained level-shift detected — ` +
        `adopting new baseline ${result.verdict.baselineUsed} ` +
        `(was frozen, board un-stuck), actual=${input.rows.length}`
    )
  } catch {
    // The fenced commit is already confirmed; logging cannot change its
    // durable outcome or turn success into a retry.
  }
}

export interface PublishAttemptBoundLeaderboardSnapshotInput extends Omit<
  PublishSnapshotInput,
  'rawObjectId' | 'isDerived'
> {
  /** Complete V4 capture proof. It grants snapshot authority, never metric authority. */
  attemptEvidence: LeaderboardAttemptBoundV4Bundle
}

async function bindSnapshotToAttemptEvidence(
  transaction: IngestQueryExecutor,
  result: PublishSnapshotResult,
  prepared: PreparedLeaderboardAttemptBoundV4Evidence
): Promise<void> {
  const receipt = await transaction.query(
    `UPDATE arena.leaderboard_snapshots
        SET meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb
      WHERE id = $1::bigint
        AND source_id = $3::smallint
        AND timeframe = $4::smallint
        AND scraped_at = $5::timestamptz
        AND raw_object_id = $6::bigint`,
    [
      result.snapshotId,
      JSON.stringify({
        source_run_id: prepared.sourceRunId,
        source_payload_raw_object_id: prepared.artifacts.sourcePayload.id,
        manifest_raw_object_id: prepared.artifacts.populationManifest.id,
        acquisition_contract: prepared.manifest.data_contract,
      }),
      prepared.src.id,
      prepared.timeframe,
      result.scrapedAt,
      prepared.artifacts.sourcePayload.id,
    ]
  )
  if (receipt.rowCount !== 1) {
    throw new Error('[ingest-worker] attempt-bound snapshot evidence binding count mismatch')
  }
}

export async function publishFencedLeaderboardSnapshot(
  input: PublishSnapshotInput,
  context: AuthorizedConsumedRegionContext,
  signal?: AbortSignal
): Promise<PublishSnapshotResult> {
  if (input.isDerived === true) {
    throw publicationFenceError('source_timeframe_not_native')
  }
  const result = await withFencedTierAPublication(
    input.src,
    [input.timeframe],
    input.rows,
    context,
    (transaction, sourceAuthorityGuard) =>
      publishLeaderboardSnapshotInTransaction(transaction, input, sourceAuthorityGuard),
    signal
  )
  reportCommittedBaselineShift(input, result)
  return result
}

/** Claimed Tier-A snapshot publication; never falls back to a region-only transaction. */
export async function publishClaimedLeaderboardSnapshot(
  input: PublishSnapshotInput,
  context: AuthorizedConsumedRegionContext,
  execution: SourceJobExecutionAuthority,
  signal?: AbortSignal
): Promise<PublishSnapshotResult> {
  if (input.isDerived === true) {
    throw publicationFenceError('source_timeframe_not_native')
  }
  const result = await withClaimedTierAPublication(
    input.src,
    [input.timeframe],
    input.rows,
    context,
    execution,
    (transaction, sourceAuthorityGuard) =>
      publishLeaderboardSnapshotInTransaction(transaction, input, sourceAuthorityGuard),
    signal
  )
  reportCommittedBaselineShift(input, result)
  return result
}

export async function publishFencedTrustedLeaderboardSnapshot(
  input: PublishTrustedSnapshotInput,
  context: AuthorizedConsumedRegionContext,
  signal?: AbortSignal
): Promise<PublishSnapshotResult> {
  const result = await withFencedTierAPublication(
    input.src,
    [input.timeframe],
    input.rows,
    context,
    (transaction, sourceAuthorityGuard) =>
      publishTrustedLeaderboardSnapshotInTransaction(transaction, input, sourceAuthorityGuard),
    signal
  )
  reportCommittedBaselineShift(input, result)
  return result
}

/** Claimed Tier-A trusted snapshot publication; no region-only compatibility fallback. */
export async function publishClaimedTrustedLeaderboardSnapshot(
  input: PublishTrustedSnapshotInput,
  context: AuthorizedConsumedRegionContext,
  execution: SourceJobExecutionAuthority,
  signal?: AbortSignal
): Promise<PublishSnapshotResult> {
  const result = await withClaimedTierAPublication(
    input.src,
    [input.timeframe],
    input.rows,
    context,
    execution,
    (transaction, sourceAuthorityGuard) =>
      publishTrustedLeaderboardSnapshotInTransaction(transaction, input, sourceAuthorityGuard),
    signal
  )
  reportCommittedBaselineShift(input, result)
  return result
}

/**
 * Publish a canonical, non-metric-authoritative V4 board.
 *
 * The query-only snapshot body, immutable snapshot metadata, acquisition
 * source/window lock, and exact latest-terminal comparison all share the
 * region-authority transaction. No mutable statement follows the terminal
 * fence, so a changed attempt or RAW pointer rolls every snapshot write back.
 */
export async function publishFencedAttemptBoundLeaderboardSnapshot(
  input: PublishAttemptBoundLeaderboardSnapshotInput,
  context: AuthorizedConsumedRegionContext,
  signal?: AbortSignal
): Promise<PublishSnapshotResult> {
  const rejects = snapshotLeaderboardTrustValue(input.rejects)
  const prepared = prepareLeaderboardAttemptBoundV4Evidence({
    src: input.src,
    timeframe: input.timeframe,
    rows: input.rows,
    rejectedRowCount: rejects.length,
    bundle: input.attemptEvidence,
  })
  const cycleId = input.observationCycleId?.trim() || null
  if (cycleId !== prepared.manifest.observation_cycle_id) {
    throw new Error(
      '[ingest-worker] observation cycle does not match the canonical capture manifest'
    )
  }

  const publicationInput: PublishSnapshotInput = {
    src: prepared.src,
    timeframe: prepared.timeframe,
    rows: prepared.rows,
    rejects,
    rawObjectId: prepared.artifacts.sourcePayload.id,
    isDerived: false,
    expectedCountOverride: input.expectedCountOverride,
    countBaselineGeneration: input.countBaselineGeneration,
    observationCycleId: cycleId ?? undefined,
  }
  const result = await withFencedTierAPublication(
    prepared.src,
    [prepared.timeframe],
    prepared.rows,
    context,
    async (transaction, sourceAuthorityGuard) => {
      const published = await publishLeaderboardSnapshotInTransaction(
        transaction,
        publicationInput,
        sourceAuthorityGuard
      )
      await bindSnapshotToAttemptEvidence(transaction, published, prepared)
      await fenceAttemptBoundLeaderboardEvidencePublicationCommit(transaction, prepared)
      return published
    },
    signal
  )
  reportCommittedBaselineShift(publicationInput, result)
  return result
}

/**
 * Claimed V4 publication keeps snapshot DML, evidence binding, and the terminal
 * attempt/RAW fence in the execution claim's one PostgreSQL transaction.
 */
export async function publishClaimedAttemptBoundLeaderboardSnapshot(
  input: PublishAttemptBoundLeaderboardSnapshotInput,
  context: AuthorizedConsumedRegionContext,
  execution: SourceJobExecutionAuthority,
  signal?: AbortSignal
): Promise<PublishSnapshotResult> {
  const rejects = snapshotLeaderboardTrustValue(input.rejects)
  const prepared = prepareLeaderboardAttemptBoundV4Evidence({
    src: input.src,
    timeframe: input.timeframe,
    rows: input.rows,
    rejectedRowCount: rejects.length,
    bundle: input.attemptEvidence,
  })
  const cycleId = input.observationCycleId?.trim() || null
  if (cycleId !== prepared.manifest.observation_cycle_id) {
    throw new Error(
      '[ingest-worker] observation cycle does not match the canonical capture manifest'
    )
  }

  const publicationInput: PublishSnapshotInput = {
    src: prepared.src,
    timeframe: prepared.timeframe,
    rows: prepared.rows,
    rejects,
    rawObjectId: prepared.artifacts.sourcePayload.id,
    isDerived: false,
    expectedCountOverride: input.expectedCountOverride,
    countBaselineGeneration: input.countBaselineGeneration,
    observationCycleId: cycleId ?? undefined,
  }
  const result = await withClaimedTierAPublication(
    prepared.src,
    [prepared.timeframe],
    prepared.rows,
    context,
    execution,
    async (transaction, sourceAuthorityGuard) => {
      const published = await publishLeaderboardSnapshotInTransaction(
        transaction,
        publicationInput,
        sourceAuthorityGuard
      )
      await bindSnapshotToAttemptEvidence(transaction, published, prepared)
      await fenceAttemptBoundLeaderboardEvidencePublicationCommit(transaction, prepared)
      return published
    },
    signal
  )
  reportCommittedBaselineShift(publicationInput, result)
  return result
}

export async function publishFencedBoardSeries(
  src: SourceRow,
  seriesByTrader: Map<string, BoardSeriesBlock[]>,
  traderIds: Map<string, number>,
  context: AuthorizedConsumedRegionContext,
  options: PublishBoardSeriesOptions,
  signal?: AbortSignal
): Promise<{ traders: number; points: number }> {
  const prepared = prepareBoardSeriesPublication(src, seriesByTrader, traderIds, options)
  if (prepared.rows.length === 0) return { traders: 0, points: 0 }
  const guardedTimeframes = prepared.expectedLatestSnapshots.map(
    (expectation) => expectation.timeframe
  )
  return withFencedTierAPublication(
    src,
    guardedTimeframes,
    [],
    context,
    (transaction, sourceAuthorityGuard) =>
      publishBoardSeriesInTransaction(transaction, prepared, sourceAuthorityGuard),
    signal
  )
}

/** Claimed Tier-A board-series publication; no region-only transaction fallback. */
export async function publishClaimedBoardSeries(
  src: SourceRow,
  seriesByTrader: Map<string, BoardSeriesBlock[]>,
  traderIds: Map<string, number>,
  context: AuthorizedConsumedRegionContext,
  execution: SourceJobExecutionAuthority,
  options: PublishBoardSeriesOptions,
  signal?: AbortSignal
): Promise<{ traders: number; points: number }> {
  const prepared = prepareBoardSeriesPublication(src, seriesByTrader, traderIds, options)
  if (prepared.rows.length === 0) return { traders: 0, points: 0 }
  const guardedTimeframes = prepared.expectedLatestSnapshots.map(
    (expectation) => expectation.timeframe
  )
  return withClaimedTierAPublication(
    src,
    guardedTimeframes,
    [],
    context,
    execution,
    (transaction, sourceAuthorityGuard) =>
      publishBoardSeriesInTransaction(transaction, prepared, sourceAuthorityGuard),
    signal
  )
}
