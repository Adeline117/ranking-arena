import type { IngestQueryExecutor } from '../db'
import {
  type IngestTransactionRunner,
  type LockedVerifiedCopierSnapshotTrustRawArtifactV2,
  type ReadVerifiedCopierSnapshotTrustRawArtifactV2Input,
  withVerifiedCopierSnapshotTrustRawArtifactV2,
} from '../raw'
import { strictCanonicalJson } from '../strict-canonical-json'

export type CopierSnapshotTrustCoverageState = 'partial' | 'unknown'

export type CopierSnapshotTrustPublicationV2Receipt = Readonly<{
  publicationId: number
  publishedAt: string
  sourceId: number
  traderId: number
  lane: 'tier_b' | 'tier_c'
  rawObjectIdAtPublication: number
  outerSourceRunId: string
  observedAt: string
  snapshotSourceRunId: string
  candidateLedgerSha256: string
  parserConservationSha256: string
  projectionLedgerSha256: string
  parsedRowCount: number
  coverageState: CopierSnapshotTrustCoverageState
  /** Trust artifact @2 is deliberately never ranking authority. */
  rankEligible: false
  replayed: boolean
  isCurrentHead: boolean
}>

interface StoredCopierSnapshotTrustPublicationV2Receipt {
  readonly publication_id: unknown
  readonly published_at: unknown
  readonly source_id: unknown
  readonly trader_id: unknown
  readonly lane: unknown
  readonly raw_object_id_at_publication: unknown
  readonly outer_source_run_id: unknown
  readonly observed_at: unknown
  readonly snapshot_source_run_id: unknown
  readonly candidate_ledger_sha256: unknown
  readonly parser_conservation_sha256: unknown
  readonly projection_ledger_sha256: unknown
  readonly parsed_row_count: unknown
  readonly coverage_state: unknown
  readonly rank_eligible: unknown
  readonly replayed: unknown
  readonly is_current_head: unknown
}

function publicationError(detail: string): Error {
  return new Error(`[publish] copier snapshot trust v2 failed: ${detail}`)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isCanonicalUtcInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) {
    return false
  }
  const epochMs = Date.parse(value)
  // Date.parse normalizes invalid calendar values (for example February 31),
  // so a finite epoch alone is not a receipt contract. PostgreSQL emits six
  // fractional digits; JavaScript can round-trip its millisecond prefix.
  return Number.isFinite(epochMs) && new Date(epochMs).toISOString() === `${value.slice(0, 23)}Z`
}

function expectedPostgresObservedAt(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw publicationError('locked evidence observation clock is not canonical milliseconds')
  }
  return `${value.slice(0, -1)}000Z`
}

function expectedParsedRowCount(evidence: LockedVerifiedCopierSnapshotTrustRawArtifactV2): number {
  const candidateCount = evidence.artifact.candidate_ledger.observed_candidate_count
  const proof = evidence.artifact.parser_conservation
  const projection = evidence.artifact.projection_ledger
  if (
    !isNonnegativeSafeInteger(candidateCount) ||
    !isNonnegativeSafeInteger(proof.observed_candidate_count) ||
    !isNonnegativeSafeInteger(proof.parsed_row_count) ||
    !isNonnegativeSafeInteger(projection.row_count) ||
    candidateCount !== proof.observed_candidate_count ||
    candidateCount !== proof.parsed_row_count ||
    candidateCount !== proof.rows.length ||
    candidateCount !== projection.row_count ||
    candidateCount !== projection.rows.length
  ) {
    throw publicationError('locked evidence row counts are not conserved')
  }
  return candidateCount
}

function validateStoredReceipt(
  stored: StoredCopierSnapshotTrustPublicationV2Receipt,
  evidence: LockedVerifiedCopierSnapshotTrustRawArtifactV2
): CopierSnapshotTrustPublicationV2Receipt {
  const artifact = evidence.artifact
  const snapshot = artifact.snapshot
  const pointer = evidence.pointerSnapshot
  const parsedRowCount = expectedParsedRowCount(evidence)
  const expectedObservedAt = expectedPostgresObservedAt(snapshot.observed_at)
  const expectedCoverageState: CopierSnapshotTrustCoverageState =
    snapshot.caller_limited || snapshot.source.copier_table_depth !== 'full' ? 'partial' : 'unknown'

  if (!isPositiveSafeInteger(stored.publication_id)) {
    throw publicationError('database receipt publication id is invalid')
  }
  if (!isCanonicalUtcInstant(stored.published_at)) {
    throw publicationError('database receipt publication clock is invalid')
  }
  if (stored.source_id !== snapshot.source.id || stored.trader_id !== snapshot.trader.id) {
    throw publicationError('database receipt source or trader identity does not match evidence')
  }
  if (stored.lane !== snapshot.lane) {
    throw publicationError('database receipt lane does not match evidence')
  }
  if (
    !isPositiveSafeInteger(stored.raw_object_id_at_publication) ||
    stored.raw_object_id_at_publication !== pointer.rawObjectId
  ) {
    throw publicationError('database receipt RAW identity does not match evidence')
  }
  if (!isSha256(stored.outer_source_run_id) || stored.outer_source_run_id !== pointer.sourceRunId) {
    throw publicationError('database receipt outer source-run id does not match evidence')
  }
  if (
    !isCanonicalUtcInstant(stored.observed_at) ||
    pointer.observedAt !== snapshot.observed_at ||
    stored.observed_at !== expectedObservedAt
  ) {
    throw publicationError('database receipt observation clock does not match evidence')
  }
  if (
    !isSha256(stored.snapshot_source_run_id) ||
    stored.snapshot_source_run_id !== evidence.snapshotSourceRunId ||
    !isSha256(stored.candidate_ledger_sha256) ||
    stored.candidate_ledger_sha256 !== evidence.candidateLedgerSha256 ||
    !isSha256(stored.parser_conservation_sha256) ||
    stored.parser_conservation_sha256 !== evidence.parserConservationSha256 ||
    !isSha256(stored.projection_ledger_sha256) ||
    stored.projection_ledger_sha256 !== evidence.projectionLedgerSha256
  ) {
    throw publicationError('database receipt child evidence anchors do not match')
  }
  if (
    !isNonnegativeSafeInteger(stored.parsed_row_count) ||
    stored.parsed_row_count !== parsedRowCount
  ) {
    throw publicationError('database receipt parsed row count does not match evidence')
  }
  if (
    (stored.coverage_state !== 'partial' && stored.coverage_state !== 'unknown') ||
    stored.coverage_state !== expectedCoverageState
  ) {
    throw publicationError('database receipt coverage state does not match evidence')
  }
  if (stored.rank_eligible !== false) {
    throw publicationError('database receipt must remain non-ranking')
  }
  if (typeof stored.replayed !== 'boolean' || typeof stored.is_current_head !== 'boolean') {
    throw publicationError('database receipt replay or head flag is invalid')
  }
  if (!stored.replayed && !stored.is_current_head) {
    throw publicationError('a new database publication must be the current lane head')
  }

  return Object.freeze({
    publicationId: stored.publication_id,
    publishedAt: stored.published_at,
    sourceId: stored.source_id,
    traderId: stored.trader_id,
    lane: snapshot.lane,
    rawObjectIdAtPublication: stored.raw_object_id_at_publication,
    outerSourceRunId: stored.outer_source_run_id,
    observedAt: stored.observed_at,
    snapshotSourceRunId: stored.snapshot_source_run_id,
    candidateLedgerSha256: stored.candidate_ledger_sha256,
    parserConservationSha256: stored.parser_conservation_sha256,
    projectionLedgerSha256: stored.projection_ledger_sha256,
    parsedRowCount: stored.parsed_row_count,
    coverageState: stored.coverage_state,
    rankEligible: false,
    replayed: stored.replayed,
    isCurrentHead: stored.is_current_head,
  })
}

async function publishLockedEvidence(
  transaction: IngestQueryExecutor,
  evidence: LockedVerifiedCopierSnapshotTrustRawArtifactV2
): Promise<CopierSnapshotTrustPublicationV2Receipt> {
  const artifact = evidence.artifact
  const snapshot = artifact.snapshot
  // Reassert the three independently stored count witnesses before invoking
  // the database authority, even though the locked reader already replayed
  // their complete artifact contract.
  expectedParsedRowCount(evidence)
  const result = await transaction.query<StoredCopierSnapshotTrustPublicationV2Receipt>(
    `SELECT publication_id,
            pg_catalog.to_char(
              published_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS published_at,
            source_id,
            trader_id,
            lane,
            raw_object_id_at_publication,
            outer_source_run_id,
            pg_catalog.to_char(
              observed_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS observed_at,
            snapshot_source_run_id,
            candidate_ledger_sha256,
            parser_conservation_sha256,
            projection_ledger_sha256,
            parsed_row_count,
            coverage_state,
            rank_eligible,
            replayed,
            is_current_head
       FROM arena.publish_copier_snapshot_trust_v2(
         $1::bigint,
         $2::smallint,
         $3::bigint,
         $4::text,
         $5::text,
         $6::text,
         $7::text,
         $8::text,
         $9::text
       )`,
    [
      evidence.pointerSnapshot.rawObjectId,
      snapshot.source.id,
      snapshot.trader.id,
      snapshot.lane,
      evidence.pointerSnapshot.sourceRunId,
      strictCanonicalJson(snapshot),
      strictCanonicalJson(artifact.candidate_ledger),
      strictCanonicalJson(artifact.parser_conservation),
      strictCanonicalJson(artifact.projection_ledger),
    ]
  )

  if (result.rows.length !== 1) {
    throw publicationError(`database returned ${result.rows.length} publication receipts`)
  }
  return validateStoredReceipt(result.rows[0], evidence)
}

/**
 * Verify immutable copier snapshot trust evidence and publish it inside the
 * reader-owned transaction. The public boundary accepts only the reader's
 * eleven independent anchors; rows, artifacts, coverage, and rank claims can
 * never be supplied by this caller.
 */
export async function publishCopierSnapshotTrustV2(
  input: ReadVerifiedCopierSnapshotTrustRawArtifactV2Input,
  runTransaction: IngestTransactionRunner
): Promise<CopierSnapshotTrustPublicationV2Receipt> {
  // Do not inspect `input` here. The locked reader captures and validates the
  // exact hostile envelope before this wrapper is allowed to see evidence.
  return withVerifiedCopierSnapshotTrustRawArtifactV2(input, runTransaction, publishLockedEvidence)
}
