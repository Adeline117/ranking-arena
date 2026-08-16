import { isProxy } from 'node:util/types'

import type { BuildCopierSnapshotArtifactInput } from './copier-snapshot-artifact'
import type { CopierSnapshotArtifactV2Result } from './copier-snapshot-artifact-v2'
import { captureCopierSnapshotTrustArtifactV2 } from './copier-snapshot-trust-capture'
import {
  type IngestTransactionRunner,
  type ReadVerifiedCopierSnapshotTrustRawArtifactV2Input,
  writeCopierSnapshotTrustRawArtifactV2,
} from './raw'
import {
  publishCopierSnapshotTrustV2,
  type CopierSnapshotTrustPublicationV2Receipt,
} from './serving/copier-snapshot-publish-v2'

const RAW_RECEIPT_FIELDS = Object.freeze([
  'id',
  'storagePath',
  'contentHash',
  'sourceRunId',
  'snapshotSourceRunId',
  'candidateLedgerSha256',
  'parserConservationSha256',
  'projectionLedgerSha256',
] as const)

const PUBLICATION_RECEIPT_FIELDS = Object.freeze([
  'publicationId',
  'publishedAt',
  'sourceId',
  'traderId',
  'lane',
  'rawObjectIdAtPublication',
  'outerSourceRunId',
  'observedAt',
  'snapshotSourceRunId',
  'candidateLedgerSha256',
  'parserConservationSha256',
  'projectionLedgerSha256',
  'parsedRowCount',
  'coverageState',
  'rankEligible',
  'replayed',
  'isCurrentHead',
] as const)

function pipelineError(detail: string): Error {
  return new Error(`[ingest] copier snapshot trust pipeline v2 failed: ${detail}`)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isCanonicalUtcInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) {
    return false
  }
  const epochMs = Date.parse(value)
  return Number.isFinite(epochMs) && new Date(epochMs).toISOString() === `${value.slice(0, 23)}Z`
}

function expectedPostgresObservedAt(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw pipelineError('captured artifact observation clock is not canonical milliseconds')
  }
  return `${value.slice(0, -1)}000Z`
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function expectedParsedRowCount(built: CopierSnapshotArtifactV2Result): number {
  const artifact = built.artifact
  const candidateCount = artifact.candidate_ledger.observed_candidate_count
  const conservation = artifact.parser_conservation
  const projection = artifact.projection_ledger
  if (
    !isNonnegativeSafeInteger(candidateCount) ||
    !isNonnegativeSafeInteger(conservation.observed_candidate_count) ||
    !isNonnegativeSafeInteger(conservation.parsed_row_count) ||
    !isNonnegativeSafeInteger(projection.row_count) ||
    candidateCount !== conservation.observed_candidate_count ||
    candidateCount !== conservation.parsed_row_count ||
    candidateCount !== conservation.rows.length ||
    candidateCount !== projection.row_count ||
    candidateCount !== projection.rows.length
  ) {
    throw pipelineError('captured artifact row counts are not conserved')
  }
  return candidateCount
}

function expectedStoragePath(built: CopierSnapshotArtifactV2Result): string {
  const snapshot = built.artifact.snapshot
  return (
    `${snapshot.source.slug}/copier_snapshot_trust/${snapshot.lane}/${built.sourceRunId}/` +
    `copier_snapshot_trust_${built.sourceRunId}.json.gz`
  )
}

/**
 * Turn the RAW writer's returned pointer into the only publication input the
 * next stage may observe. This is intentionally a narrow, hostile-boundary
 * capture: no artifact, projection row, storage path, coverage, or ranking
 * claim can cross into the publisher.
 */
function publicationAnchorsFromRawReceipt(
  value: unknown,
  built: CopierSnapshotArtifactV2Result
): ReadVerifiedCopierSnapshotTrustRawArtifactV2Input {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw pipelineError('RAW writer returned a non-plain receipt')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw pipelineError('RAW writer returned a non-plain receipt')
  }
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== RAW_RECEIPT_FIELDS.length ||
    ownKeys.some(
      (key) =>
        typeof key !== 'string' ||
        !RAW_RECEIPT_FIELDS.includes(key as (typeof RAW_RECEIPT_FIELDS)[number])
    )
  ) {
    throw pipelineError('RAW writer returned receipt fields outside the v2 contract')
  }

  const receipt: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const field of RAW_RECEIPT_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw pipelineError('RAW writer returned receipt accessors or missing fields')
    }
    receipt[field] = descriptor.value
  }

  const artifact = built.artifact
  const snapshot = artifact.snapshot
  if (!isPositiveSafeInteger(receipt.id)) {
    throw pipelineError('RAW writer returned an invalid pointer id')
  }
  if (receipt.storagePath !== expectedStoragePath(built)) {
    throw pipelineError('RAW writer storage path does not match the captured artifact')
  }
  if (
    !isSha256(receipt.contentHash) ||
    !isSha256(receipt.sourceRunId) ||
    receipt.contentHash !== built.sourceRunId ||
    receipt.sourceRunId !== built.sourceRunId
  ) {
    throw pipelineError('RAW writer outer source-run anchor does not match the captured artifact')
  }
  if (
    !isSha256(receipt.snapshotSourceRunId) ||
    !isSha256(receipt.candidateLedgerSha256) ||
    !isSha256(receipt.parserConservationSha256) ||
    !isSha256(receipt.projectionLedgerSha256) ||
    receipt.snapshotSourceRunId !== artifact.snapshot_source_run_id ||
    receipt.candidateLedgerSha256 !== artifact.candidate_ledger_sha256 ||
    receipt.parserConservationSha256 !== artifact.parser_conservation_sha256 ||
    receipt.projectionLedgerSha256 !== artifact.projection_ledger_sha256
  ) {
    throw pipelineError('RAW writer child evidence anchors do not match the captured artifact')
  }

  return Object.freeze({
    rawObjectId: receipt.id,
    expectedSourceId: snapshot.source.id,
    expectedSourceSlug: snapshot.source.slug,
    expectedTraderId: snapshot.trader.id,
    expectedExchangeTraderId: snapshot.trader.exchange_trader_id,
    expectedLane: snapshot.lane,
    expectedSourceRunId: receipt.sourceRunId,
    expectedSnapshotSourceRunId: receipt.snapshotSourceRunId,
    expectedCandidateLedgerSha256: receipt.candidateLedgerSha256,
    expectedParserConservationSha256: receipt.parserConservationSha256,
    expectedProjectionLedgerSha256: receipt.projectionLedgerSha256,
  })
}

/**
 * Make the handoff boundary explicit even if a future publisher grows an
 * internal result. The pipeline exposes only the frozen public v2 receipt;
 * it never returns the captured artifact, RAW receipt, evidence, or rows.
 */
function publicPublicationReceipt(
  value: unknown,
  rawAnchors: ReadVerifiedCopierSnapshotTrustRawArtifactV2Input,
  built: CopierSnapshotArtifactV2Result
): CopierSnapshotTrustPublicationV2Receipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw pipelineError('publisher returned a non-plain receipt')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw pipelineError('publisher returned a non-plain receipt')
  }
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== PUBLICATION_RECEIPT_FIELDS.length ||
    ownKeys.some(
      (key) =>
        typeof key !== 'string' ||
        !PUBLICATION_RECEIPT_FIELDS.includes(key as (typeof PUBLICATION_RECEIPT_FIELDS)[number])
    )
  ) {
    throw pipelineError('publisher returned receipt fields outside the v2 contract')
  }

  const receipt: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const field of PUBLICATION_RECEIPT_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw pipelineError('publisher returned receipt accessors or missing fields')
    }
    receipt[field] = descriptor.value
  }

  const artifact = built.artifact
  const snapshot = artifact.snapshot
  const parsedRowCount = expectedParsedRowCount(built)
  const expectedCoverageState =
    snapshot.caller_limited || snapshot.source.copier_table_depth !== 'full' ? 'partial' : 'unknown'
  if (
    !isPositiveSafeInteger(receipt.publicationId) ||
    !isCanonicalUtcInstant(receipt.publishedAt)
  ) {
    throw pipelineError('publisher returned an invalid publication identity or clock')
  }
  if (
    receipt.sourceId !== rawAnchors.expectedSourceId ||
    receipt.traderId !== rawAnchors.expectedTraderId
  ) {
    throw pipelineError('publisher source or trader identity does not match verified RAW anchors')
  }
  if (receipt.lane !== rawAnchors.expectedLane) {
    throw pipelineError('publisher lane does not match verified RAW anchors')
  }
  if (
    !isPositiveSafeInteger(receipt.rawObjectIdAtPublication) ||
    receipt.rawObjectIdAtPublication !== rawAnchors.rawObjectId
  ) {
    throw pipelineError('publisher RAW identity does not match verified RAW anchors')
  }
  if (
    !isSha256(receipt.outerSourceRunId) ||
    receipt.outerSourceRunId !== rawAnchors.expectedSourceRunId
  ) {
    throw pipelineError('publisher outer source-run id does not match verified RAW anchors')
  }
  if (
    !isCanonicalUtcInstant(receipt.observedAt) ||
    receipt.observedAt !== expectedPostgresObservedAt(snapshot.observed_at)
  ) {
    throw pipelineError('publisher observation clock does not match the captured artifact')
  }
  if (
    !isSha256(receipt.snapshotSourceRunId) ||
    receipt.snapshotSourceRunId !== rawAnchors.expectedSnapshotSourceRunId ||
    !isSha256(receipt.candidateLedgerSha256) ||
    receipt.candidateLedgerSha256 !== rawAnchors.expectedCandidateLedgerSha256 ||
    !isSha256(receipt.parserConservationSha256) ||
    receipt.parserConservationSha256 !== rawAnchors.expectedParserConservationSha256 ||
    !isSha256(receipt.projectionLedgerSha256) ||
    receipt.projectionLedgerSha256 !== rawAnchors.expectedProjectionLedgerSha256
  ) {
    throw pipelineError('publisher evidence anchors do not match verified RAW anchors')
  }
  if (
    !isNonnegativeSafeInteger(receipt.parsedRowCount) ||
    receipt.parsedRowCount !== parsedRowCount
  ) {
    throw pipelineError('publisher parsed row count does not match the captured artifact')
  }
  if (receipt.coverageState !== expectedCoverageState) {
    throw pipelineError('publisher coverage state does not match the captured artifact')
  }
  if (receipt.rankEligible !== false) {
    throw pipelineError('publisher receipt must remain non-ranking')
  }
  if (typeof receipt.replayed !== 'boolean' || typeof receipt.isCurrentHead !== 'boolean') {
    throw pipelineError('publisher replay or head flag is invalid')
  }
  if (!receipt.replayed && !receipt.isCurrentHead) {
    throw pipelineError('a new publisher receipt must be the current lane head')
  }

  return Object.freeze({
    publicationId: receipt.publicationId as number,
    publishedAt: receipt.publishedAt as string,
    sourceId: receipt.sourceId as number,
    traderId: receipt.traderId as number,
    lane: receipt.lane as 'tier_b' | 'tier_c',
    rawObjectIdAtPublication: receipt.rawObjectIdAtPublication as number,
    outerSourceRunId: receipt.outerSourceRunId as string,
    observedAt: receipt.observedAt as string,
    snapshotSourceRunId: receipt.snapshotSourceRunId as string,
    candidateLedgerSha256: receipt.candidateLedgerSha256 as string,
    parserConservationSha256: receipt.parserConservationSha256 as string,
    projectionLedgerSha256: receipt.projectionLedgerSha256 as string,
    parsedRowCount: receipt.parsedRowCount as number,
    coverageState: receipt.coverageState as 'partial' | 'unknown',
    rankEligible: false,
    replayed: receipt.replayed as boolean,
    isCurrentHead: receipt.isCurrentHead as boolean,
  })
}

/**
 * Capture a retained copier snapshot, durably write its self-contained @2
 * trust artifact, and publish it through the locked RAW reader. This helper
 * has deliberately no rows argument: parser rows exist only while capture
 * constructs the immutable artifact and are never caller- or publisher-owned.
 *
 * The supplied runner is passed unchanged to both durable-pointer creation and
 * locked publication. Each lower-level boundary owns its own transaction, so
 * storage remains durable before a pointer and the reader can lock/recheck
 * that pointer during publication.
 */
export async function captureWritePublishCopierSnapshotTrustV2(
  input: BuildCopierSnapshotArtifactInput,
  runTransaction: IngestTransactionRunner
): Promise<CopierSnapshotTrustPublicationV2Receipt> {
  // Do not inspect `input` here. Capture owns the exact hostile-envelope
  // validation and detaches it before any page payload is replayed.
  const built = captureCopierSnapshotTrustArtifactV2(input)
  const rawReceipt = await writeCopierSnapshotTrustRawArtifactV2(
    { artifact: built.artifact, sourceRunId: built.sourceRunId },
    runTransaction
  )
  const anchors = publicationAnchorsFromRawReceipt(rawReceipt, built)
  const publication = await publishCopierSnapshotTrustV2(anchors, runTransaction)
  return publicPublicationReceipt(publication, anchors, built)
}
