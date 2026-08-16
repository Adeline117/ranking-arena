import { isProxy } from 'node:util/types'

import {
  COPIER_SNAPSHOT_ARTIFACT_CONTRACT,
  copierSnapshotSourceRunId,
  revalidateCopierSnapshotArtifact,
  type CopierSnapshotArtifact,
} from './copier-snapshot-artifact'
import {
  copierCandidateLedgerSchema,
  copierParserConservationProofSchema,
  type CopierCandidateLedger,
  type CopierParserConservationProof,
} from './copier-candidate-conservation'
import {
  COPIER_SNAPSHOT_PROJECTION_LEDGER_CONTRACT,
  buildCopierSnapshotProjectionLedger,
  revalidateCopierSnapshotProjectionLedger,
  type CopierSnapshotProjectionLedger,
} from './copier-snapshot-projection-ledger'
import type { ParsedHistoryRow, SourceRow } from './core/types'
import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalJson,
  strictCanonicalSha256,
} from './strict-canonical-json'

export const COPIER_SNAPSHOT_ARTIFACT_V2_CONTRACT =
  'arena.ingest.copier-snapshot-artifact@2' as const

const COPIER_SNAPSHOT_ARTIFACT_V2_FIELDS = Object.freeze([
  'contract',
  'serialization_contract',
  'snapshot',
  'snapshot_source_run_id',
  'candidate_ledger',
  'candidate_ledger_sha256',
  'parser_conservation',
  'parser_conservation_sha256',
  'projection_ledger',
  'projection_ledger_sha256',
] as const)
const COPIER_SNAPSHOT_ANCHOR_FIELDS = Object.freeze([
  'sourceRunId',
  'sourceId',
  'sourceSlug',
  'traderId',
  'exchangeTraderId',
] as const)
const BUILD_INPUT_FIELDS = Object.freeze([
  'src',
  'snapshot',
  'expectedSnapshot',
  'candidateLedger',
  'parserProof',
  'rows',
] as const)
const REVALIDATION_INPUT_FIELDS = Object.freeze(['artifact', 'expectedSourceRunId'] as const)

export interface CopierSnapshotArtifactAnchor {
  /** Exact @1 SHA from the capture result or its immutable RAW receipt. */
  readonly sourceRunId: string
  readonly sourceId: number
  readonly sourceSlug: string
  readonly traderId: number
  readonly exchangeTraderId: string
}

/**
 * Self-contained raw-candidate-to-projection evidence. This contract deliberately
 * contains no completeness, rank-eligibility, receipt, or storage-path claim.
 * In particular, @1 `caller_limited` and `stream_exhausted_unverified` remain
 * exactly those states after being nested here.
 */
export interface CopierSnapshotArtifactV2 {
  readonly contract: typeof COPIER_SNAPSHOT_ARTIFACT_V2_CONTRACT
  readonly serialization_contract: typeof STRICT_CANONICAL_JSON_CONTRACT
  readonly snapshot: CopierSnapshotArtifact
  readonly snapshot_source_run_id: string
  readonly candidate_ledger: CopierCandidateLedger
  readonly candidate_ledger_sha256: string
  readonly parser_conservation: CopierParserConservationProof
  readonly parser_conservation_sha256: string
  readonly projection_ledger: CopierSnapshotProjectionLedger
  readonly projection_ledger_sha256: string
}

export interface BuildCopierSnapshotArtifactV2Input {
  /** Current live source snapshot. Historical revalidation never reads it. */
  readonly src: SourceRow
  readonly snapshot: CopierSnapshotArtifact
  /** External @1 capture/receipt anchor; never derived from `snapshot` by this call. */
  readonly expectedSnapshot: CopierSnapshotArtifactAnchor
  readonly candidateLedger: CopierCandidateLedger
  readonly parserProof: CopierParserConservationProof
  /** Ephemeral parser output. Parsed rows are verified but never persisted in @2. */
  readonly rows: readonly ParsedHistoryRow[]
}

/** Neutral evidence result. Its hash is not a storage receipt or publication grant. */
export interface CopierSnapshotArtifactV2Result {
  readonly artifact: CopierSnapshotArtifactV2
  /** SHA of the complete outer @2 bytes. It is intentionally not nested in itself. */
  readonly sourceRunId: string
}

interface CapturedBuildInput {
  readonly src: unknown
  readonly snapshot: unknown
  readonly expectedSnapshot: unknown
  readonly candidateLedger: unknown
  readonly parserProof: unknown
  readonly rows: unknown
}

interface CapturedRevalidationInput {
  readonly artifact: unknown
  readonly expectedSourceRunId: unknown
}

function artifactV2Error(detail: string): Error {
  return new Error(`[ingest] copier snapshot artifact v2 failed: ${detail}`)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw artifactV2Error(`${label} must have the exact contract fields`)
  }
}

function captureExactInput(
  value: unknown,
  fields: readonly string[],
  label: string
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw artifactV2Error(`${label} must be a non-proxy plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw artifactV2Error(`${label} must be a non-proxy plain object`)
  }
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== fields.length ||
    ownKeys.some((key) => typeof key !== 'string' || !fields.includes(key))
  ) {
    throw artifactV2Error(`${label} must have the exact contract fields`)
  }

  const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw artifactV2Error(`${label} must contain enumerable data properties`)
    }
    captured[field] = descriptor.value
  }
  return captured
}

function captureBuildInput(value: unknown): CapturedBuildInput {
  const captured = captureExactInput(value, BUILD_INPUT_FIELDS, 'build input')
  // Copy the external anchor reference before any evidence is inspected.
  const expectedSnapshot = captured.expectedSnapshot
  return {
    expectedSnapshot,
    src: captured.src,
    snapshot: captured.snapshot,
    candidateLedger: captured.candidateLedger,
    parserProof: captured.parserProof,
    rows: captured.rows,
  }
}

function captureRevalidationInput(value: unknown): CapturedRevalidationInput {
  const captured = captureExactInput(value, REVALIDATION_INPUT_FIELDS, 'revalidation input')
  // Capture the receipt primitive first. Canonicalizing untrusted evidence must
  // never be able to replace the external anchor through an accessor/proxy.
  const expectedSourceRunId = captured.expectedSourceRunId
  return { expectedSourceRunId, artifact: captured.artifact }
}

function canonicalSnapshot<T>(value: T, label: string): T {
  try {
    return JSON.parse(strictCanonicalJson(value)) as T
  } catch (cause) {
    throw artifactV2Error(
      `${label} is not strict canonical JSON: ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw artifactV2Error(`${label} must be a lowercase SHA-256 digest`)
  }
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function assertLiveSourceInput(value: unknown): asserts value is SourceRow {
  if (!isPlainRecord(value)) throw artifactV2Error('live source row must be an object')
}

function assertParserRowsInput(value: unknown): asserts value is ParsedHistoryRow[] {
  if (!Array.isArray(value)) throw artifactV2Error('ephemeral parser rows must be an array')
}

function revalidateSnapshotAnchor(value: unknown): CopierSnapshotArtifactAnchor {
  const snapshot = canonicalSnapshot(value, 'expected snapshot anchor')
  if (!isPlainRecord(snapshot)) {
    throw artifactV2Error('expected snapshot anchor must be an object')
  }
  assertExactKeys(snapshot, COPIER_SNAPSHOT_ANCHOR_FIELDS, 'expected snapshot anchor')
  assertSha256(snapshot.sourceRunId, 'expected snapshot source-run id')
  if (!positiveSafeInteger(snapshot.sourceId) || !positiveSafeInteger(snapshot.traderId)) {
    throw artifactV2Error('expected snapshot numeric coordinates are invalid')
  }
  if (
    typeof snapshot.sourceSlug !== 'string' ||
    !/^[a-z0-9][a-z0-9_]{0,127}$/.test(snapshot.sourceSlug)
  ) {
    throw artifactV2Error('expected snapshot source slug is invalid')
  }
  if (
    typeof snapshot.exchangeTraderId !== 'string' ||
    snapshot.exchangeTraderId !== snapshot.exchangeTraderId.trim() ||
    snapshot.exchangeTraderId.length < 1 ||
    snapshot.exchangeTraderId.length > 512
  ) {
    throw artifactV2Error('expected snapshot exchange trader id is invalid')
  }
  return deepFreeze({
    sourceRunId: snapshot.sourceRunId,
    sourceId: snapshot.sourceId,
    sourceSlug: snapshot.sourceSlug,
    traderId: snapshot.traderId,
    exchangeTraderId: snapshot.exchangeTraderId,
  })
}

function snapshotAnchor(snapshot: CopierSnapshotArtifact): CopierSnapshotArtifactAnchor {
  return deepFreeze({
    sourceRunId: copierSnapshotSourceRunId(snapshot),
    sourceId: snapshot.source.id,
    sourceSlug: snapshot.source.slug,
    traderId: snapshot.trader.id,
    exchangeTraderId: snapshot.trader.exchange_trader_id,
  })
}

function parseCandidateLedger(value: unknown): CopierCandidateLedger {
  const parsed = copierCandidateLedgerSchema.safeParse(canonicalSnapshot(value, 'candidate ledger'))
  if (!parsed.success) throw artifactV2Error('candidate ledger is not the exact canonical contract')
  return deepFreeze(parsed.data)
}

function parseParserConservation(value: unknown): CopierParserConservationProof {
  const parsed = copierParserConservationProofSchema.safeParse(
    canonicalSnapshot(value, 'parser conservation proof')
  )
  if (!parsed.success) {
    throw artifactV2Error('parser conservation proof is not the exact canonical contract')
  }
  return deepFreeze(parsed.data)
}

function assertChildBindings(input: {
  snapshot: CopierSnapshotArtifact
  candidateLedger: CopierCandidateLedger
  parserConservation: CopierParserConservationProof
  projectionLedger: CopierSnapshotProjectionLedger
}): void {
  const snapshotSourceRunId = copierSnapshotSourceRunId(input.snapshot)
  const candidateLedgerSha256 = strictCanonicalSha256(input.candidateLedger)
  const parserConservationSha256 = strictCanonicalSha256(input.parserConservation)
  if (
    input.projectionLedger.contract !== COPIER_SNAPSHOT_PROJECTION_LEDGER_CONTRACT ||
    input.projectionLedger.snapshot_artifact_contract !== COPIER_SNAPSHOT_ARTIFACT_CONTRACT ||
    input.projectionLedger.snapshot_source_run_id !== snapshotSourceRunId
  ) {
    throw artifactV2Error('projection ledger is not bound to the exact nested snapshot')
  }
  if (input.projectionLedger.candidate_ledger_sha256 !== candidateLedgerSha256) {
    throw artifactV2Error('projection ledger is not bound to the exact candidate ledger')
  }
  if (input.projectionLedger.parser_conservation_sha256 !== parserConservationSha256) {
    throw artifactV2Error('projection ledger is not bound to the exact parser conservation proof')
  }
}

function assembleArtifact(input: {
  snapshot: CopierSnapshotArtifact
  candidateLedger: CopierCandidateLedger
  parserConservation: CopierParserConservationProof
  projectionLedger: CopierSnapshotProjectionLedger
}): CopierSnapshotArtifactV2 {
  assertChildBindings(input)
  const candidate = {
    contract: COPIER_SNAPSHOT_ARTIFACT_V2_CONTRACT,
    serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
    snapshot: input.snapshot,
    snapshot_source_run_id: copierSnapshotSourceRunId(input.snapshot),
    candidate_ledger: input.candidateLedger,
    candidate_ledger_sha256: strictCanonicalSha256(input.candidateLedger),
    parser_conservation: input.parserConservation,
    parser_conservation_sha256: strictCanonicalSha256(input.parserConservation),
    projection_ledger: input.projectionLedger,
    projection_ledger_sha256: strictCanonicalSha256(input.projectionLedger),
  } satisfies CopierSnapshotArtifactV2
  return deepFreeze(canonicalSnapshot(candidate, 'assembled artifact v2'))
}

/**
 * Upgrade a just-captured @1 snapshot after current live-source checks.
 * Candidate/proof/rows are all replayed by the live projection builder; the
 * parsed rows are intentionally absent from the returned artifact.
 */
export function buildCopierSnapshotArtifactV2(
  input: BuildCopierSnapshotArtifactV2Input
): CopierSnapshotArtifactV2Result {
  const captured = captureBuildInput(input)
  const expectedSnapshot = revalidateSnapshotAnchor(captured.expectedSnapshot)
  const snapshot = revalidateCopierSnapshotArtifact(
    canonicalSnapshot(captured.snapshot, 'copier snapshot')
  )
  if (strictCanonicalJson(snapshotAnchor(snapshot)) !== strictCanonicalJson(expectedSnapshot)) {
    throw artifactV2Error('snapshot does not match the external @1 capture anchor')
  }

  const src = canonicalSnapshot(captured.src, 'live source row')
  assertLiveSourceInput(src)
  const candidateLedger = parseCandidateLedger(captured.candidateLedger)
  const parserConservation = parseParserConservation(captured.parserProof)
  const rows = canonicalSnapshot(captured.rows, 'ephemeral parser rows')
  assertParserRowsInput(rows)
  const projectionLedger = buildCopierSnapshotProjectionLedger({
    src,
    artifact: snapshot,
    candidateLedger,
    parserProof: parserConservation,
    rows,
  })
  const artifact = assembleArtifact({
    snapshot,
    candidateLedger,
    parserConservation,
    projectionLedger,
  })
  return deepFreeze({ artifact, sourceRunId: strictCanonicalSha256(artifact) })
}

/**
 * Revalidate an untrusted @2 value under an external immutable RAW/source-run
 * anchor. This path is self-contained: it reads neither mutable SourceRow state
 * nor caller-supplied parsed rows.
 */
export function revalidateCopierSnapshotArtifactV2(input: {
  readonly artifact: unknown
  readonly expectedSourceRunId: unknown
}): CopierSnapshotArtifactV2Result {
  const captured = captureRevalidationInput(input)
  assertSha256(captured.expectedSourceRunId, 'expected outer source-run id')

  const supplied = canonicalSnapshot(captured.artifact, 'copier snapshot artifact v2')
  if (strictCanonicalSha256(supplied) !== captured.expectedSourceRunId) {
    throw artifactV2Error('outer artifact does not match its immutable source-run anchor')
  }
  if (!isPlainRecord(supplied)) throw artifactV2Error('outer artifact must be an object')
  assertExactKeys(supplied, COPIER_SNAPSHOT_ARTIFACT_V2_FIELDS, 'outer artifact')
  if (
    supplied.contract !== COPIER_SNAPSHOT_ARTIFACT_V2_CONTRACT ||
    supplied.serialization_contract !== STRICT_CANONICAL_JSON_CONTRACT
  ) {
    throw artifactV2Error('outer artifact header contracts are invalid')
  }

  assertSha256(supplied.snapshot_source_run_id, 'snapshot source-run id')
  assertSha256(supplied.candidate_ledger_sha256, 'candidate ledger digest')
  assertSha256(supplied.parser_conservation_sha256, 'parser conservation digest')
  assertSha256(supplied.projection_ledger_sha256, 'projection ledger digest')

  const snapshot = revalidateCopierSnapshotArtifact(supplied.snapshot)
  const candidateLedger = parseCandidateLedger(supplied.candidate_ledger)
  const parserConservation = parseParserConservation(supplied.parser_conservation)
  if (copierSnapshotSourceRunId(snapshot) !== supplied.snapshot_source_run_id) {
    throw artifactV2Error('snapshot digest does not match the exact nested snapshot')
  }
  if (strictCanonicalSha256(candidateLedger) !== supplied.candidate_ledger_sha256) {
    throw artifactV2Error('candidate ledger digest does not match the exact nested ledger')
  }
  if (strictCanonicalSha256(parserConservation) !== supplied.parser_conservation_sha256) {
    throw artifactV2Error('parser conservation digest does not match the exact nested proof')
  }
  if (strictCanonicalSha256(supplied.projection_ledger) !== supplied.projection_ledger_sha256) {
    throw artifactV2Error('projection ledger digest does not match the exact nested ledger')
  }

  const projectionLedger = revalidateCopierSnapshotProjectionLedger({
    artifact: snapshot,
    candidateLedger,
    parserProof: parserConservation,
    ledger: supplied.projection_ledger,
    expectedProjectionLedgerSha256: supplied.projection_ledger_sha256,
  })
  const rebuilt = assembleArtifact({
    snapshot,
    candidateLedger,
    parserConservation,
    projectionLedger,
  })
  if (strictCanonicalJson(supplied) !== strictCanonicalJson(rebuilt)) {
    throw artifactV2Error('outer artifact does not match replayed immutable evidence')
  }
  return deepFreeze({ artifact: rebuilt, sourceRunId: captured.expectedSourceRunId })
}
