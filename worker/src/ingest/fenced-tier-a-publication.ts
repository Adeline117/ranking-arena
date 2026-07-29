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
  assertSourceMatchesConsumedRegion,
  type AuthorizedConsumedRegionContext,
} from './consumed-region-context'

export type TierAPublicationFenceErrorCode =
  | 'authority_identity_mismatch'
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
  ) => Promise<T>
): Promise<T> {
  assertSourceMatchesConsumedRegion(src, context)
  assertAuthorityIdentity(context)
  const sourceContract = snapshotSourceContract(src)
  const guardedTimeframes = snapshotPublicationTimeframes(publicationTimeframes)
  const expectedTraderIdentities = snapshotTraderIdentities(traderIdentities)
  return context.authority.withFencedWrite((transaction) =>
    publish(transaction, async (lockedTransaction) => {
      await lockAndAssertLiveSourceAuthority(
        lockedTransaction,
        sourceContract,
        guardedTimeframes,
        context
      )
      await lockAndAssertExistingTraderIdentities(
        lockedTransaction,
        sourceContract.id,
        expectedTraderIdentities
      )
    })
  )
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

export async function publishFencedLeaderboardSnapshot(
  input: PublishSnapshotInput,
  context: AuthorizedConsumedRegionContext
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
      publishLeaderboardSnapshotInTransaction(transaction, input, sourceAuthorityGuard)
  )
  reportCommittedBaselineShift(input, result)
  return result
}

export async function publishFencedTrustedLeaderboardSnapshot(
  input: PublishTrustedSnapshotInput,
  context: AuthorizedConsumedRegionContext
): Promise<PublishSnapshotResult> {
  const result = await withFencedTierAPublication(
    input.src,
    [input.timeframe],
    input.rows,
    context,
    (transaction, sourceAuthorityGuard) =>
      publishTrustedLeaderboardSnapshotInTransaction(transaction, input, sourceAuthorityGuard)
  )
  reportCommittedBaselineShift(input, result)
  return result
}

export async function publishFencedBoardSeries(
  src: SourceRow,
  seriesByTrader: Map<string, BoardSeriesBlock[]>,
  traderIds: Map<string, number>,
  context: AuthorizedConsumedRegionContext,
  options: PublishBoardSeriesOptions
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
      publishBoardSeriesInTransaction(transaction, prepared, sourceAuthorityGuard)
  )
}
