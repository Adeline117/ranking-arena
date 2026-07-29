import type { IngestQueryExecutor } from '@/lib/ingest/db'
import type { SourceRow } from '@/lib/ingest/core/types'
import {
  publishLeaderboardSnapshotInTransaction,
  publishTrustedLeaderboardSnapshotInTransaction,
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
  | 'source_identity_mismatch'
  | 'source_inactive'
  | 'source_missing'
  | 'source_registry_contract_violation'
  | 'source_region_mismatch'

export class TierAPublicationFenceError extends Error {
  readonly code: TierAPublicationFenceErrorCode

  constructor(code: TierAPublicationFenceErrorCode) {
    super(`[ingest-worker] Tier-A publication rejected (${code})`)
    this.name = 'TierAPublicationFenceError'
    this.code = code
  }
}

interface LockedSourceAuthorityRow {
  fetch_region: string
  id: number
  slug: string
  status: string
}

function publicationFenceError(code: TierAPublicationFenceErrorCode): TierAPublicationFenceError {
  return new TierAPublicationFenceError(code)
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
  src: SourceRow,
  context: AuthorizedConsumedRegionContext
): Promise<void> {
  const result = await transaction.query<LockedSourceAuthorityRow>(
    `SELECT source.id::integer AS id,
            source.slug,
            source.status,
            source.fetch_region
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
    typeof live.fetch_region !== 'string'
  ) {
    throw publicationFenceError('source_registry_contract_violation')
  }
  if (live.id !== src.id || live.slug !== src.slug) {
    throw publicationFenceError('source_identity_mismatch')
  }
  if (live.status !== 'active') {
    throw publicationFenceError('source_inactive')
  }
  if (live.fetch_region !== context.consumedRegion) {
    throw publicationFenceError('source_region_mismatch')
  }
}

async function withFencedTierAPublication<T>(
  src: SourceRow,
  context: AuthorizedConsumedRegionContext,
  publish: (
    transaction: IngestQueryExecutor,
    sourceAuthorityGuard: (transaction: IngestQueryExecutor) => Promise<void>
  ) => Promise<T>
): Promise<T> {
  assertSourceMatchesConsumedRegion(src, context)
  assertAuthorityIdentity(context)
  return context.authority.withFencedWrite((transaction) =>
    publish(transaction, (lockedTransaction) =>
      lockAndAssertLiveSourceAuthority(lockedTransaction, src, context)
    )
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
  const result = await withFencedTierAPublication(
    input.src,
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
    context,
    (transaction, sourceAuthorityGuard) =>
      publishTrustedLeaderboardSnapshotInTransaction(transaction, input, sourceAuthorityGuard)
  )
  reportCommittedBaselineShift(input, result)
  return result
}
