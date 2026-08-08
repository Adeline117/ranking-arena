import { isProxy } from 'node:util/types'

import {
  COPIER_SNAPSHOT_ARTIFACT_CONTRACT,
  revalidateCopierSnapshotArtifact,
  copierSnapshotSourceRunId,
  type CopierSnapshotArtifact,
} from './copier-snapshot-artifact'
import {
  COPIER_CANDIDATE_REPLAY_BINDING_CONTRACT,
  deriveCopierCandidateReplayBinding,
  revalidateCopierCandidateLedger,
  revalidateCopierCandidateLedgerFromReplayBinding,
  revalidateCopierCandidateReplayBinding,
  verifyCopierParserConservation,
  type CopierCandidateAdapterSlug,
  type CopierCandidateLedger,
  type CopierCandidateReplayBinding,
  type CopierParserConservationProof,
} from './copier-candidate-conservation'
import {
  COPIER_SNAPSHOT_CANDIDATE_PROJECTION_FIXED_MULTISET_CONTRACT,
  COPIER_SNAPSHOT_LENGTH_PREFIXED_UTF8_CONTRACT,
  COPIER_SNAPSHOT_PROJECTION_TUPLE_CONTRACT,
  COPIER_SNAPSHOT_SOURCE_CANDIDATE_FIXED_MULTISET_CONTRACT,
  buildCopierSnapshotProjection,
  copierSnapshotCandidateProjectionFixedMultisetSha256,
  copierSnapshotProjectionSha256,
  copierSnapshotSourceCandidateFixedMultisetSha256,
  revalidateCopierSnapshotProjectionTuple,
  type CanonicalCopierSnapshotProjectionTuple,
  type CopierSnapshotCandidateProjectionPair,
} from './copier-snapshot-projection'
import { getAdapter } from './core/adapter'
import { supportsSourceSurface } from './core/surface-capabilities'
import type {
  ParseCtx,
  ParsedCopierRow,
  ParsedHistoryRow,
  ProductType,
  SourceRow,
} from './core/types'
import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalJson,
  strictCanonicalSha256,
} from './strict-canonical-json'

export const COPIER_SNAPSHOT_PROJECTION_LEDGER_CONTRACT =
  'arena.ingest.copier-projection-ledger@1' as const
export const COPIER_SNAPSHOT_PARSER_BINDING_CONTRACT =
  'arena.ingest.copier-parser-replay-binding@1' as const

const COPIER_SNAPSHOT_PROJECTION_LEDGER_FIELDS = Object.freeze([
  'contract',
  'serialization_contract',
  'snapshot_artifact_contract',
  'snapshot_source_run_id',
  'candidate_ledger_sha256',
  'parser_conservation_sha256',
  'binding',
  'parser_context',
  'projection_tuple_contract',
  'projection_encoding_contract',
  'source_candidate_fixed_multiset_contract',
  'candidate_projection_fixed_multiset_contract',
  'row_count',
  'source_candidate_fixed_multiset_sha256',
  'candidate_projection_fixed_multiset_sha256',
  'rows',
] as const)
const COPIER_SNAPSHOT_PROJECTION_REVALIDATION_INPUT_FIELDS = Object.freeze([
  'artifact',
  'candidateLedger',
  'parserProof',
  'ledger',
  'expectedProjectionLedgerSha256',
] as const)

export type CopierSnapshotParserContract =
  `arena.ingest.copier-parser.${CopierCandidateAdapterSlug}@1`

/** Closed parser implementation identities; any semantic parser change bumps this version. */
export const COPIER_SNAPSHOT_PARSER_CONTRACTS = Object.freeze({
  binance: 'arena.ingest.copier-parser.binance@1',
  bingx: 'arena.ingest.copier-parser.bingx@1',
  bitget: 'arena.ingest.copier-parser.bitget@1',
  bitget_bots: 'arena.ingest.copier-parser.bitget_bots@1',
  bitunix: 'arena.ingest.copier-parser.bitunix@1',
  blofin: 'arena.ingest.copier-parser.blofin@1',
  btcc: 'arena.ingest.copier-parser.btcc@1',
  bybit_copytrade: 'arena.ingest.copier-parser.bybit_copytrade@1',
  coinex: 'arena.ingest.copier-parser.coinex@1',
  gate: 'arena.ingest.copier-parser.gate@1',
  kucoin: 'arena.ingest.copier-parser.kucoin@1',
  lbank: 'arena.ingest.copier-parser.lbank@1',
  mexc: 'arena.ingest.copier-parser.mexc@1',
  okx: 'arena.ingest.copier-parser.okx@1',
  toobit: 'arena.ingest.copier-parser.toobit@1',
  xt: 'arena.ingest.copier-parser.xt@1',
} satisfies Readonly<Record<CopierCandidateAdapterSlug, CopierSnapshotParserContract>>)

export function selectCopierSnapshotParserContract(
  adapterSlug: CopierCandidateAdapterSlug
): CopierSnapshotParserContract {
  if (!Object.prototype.hasOwnProperty.call(COPIER_SNAPSHOT_PARSER_CONTRACTS, adapterSlug)) {
    throw projectionLedgerError(`adapter ${String(adapterSlug)} has no closed parser contract`)
  }
  const selected = COPIER_SNAPSHOT_PARSER_CONTRACTS[adapterSlug]
  if (!selected) {
    throw projectionLedgerError(`adapter ${String(adapterSlug)} has no closed parser contract`)
  }
  return selected
}

export interface CopierSnapshotProjectionLedgerRow {
  readonly row_ordinal: number
  readonly source_page_ordinal: number
  readonly candidate_ordinal: number
  readonly source_candidate_sha256: string
  readonly projection_sha256: string
  readonly projection: CanonicalCopierSnapshotProjectionTuple
}

export interface CopierSnapshotParserReplayBinding {
  readonly contract: typeof COPIER_SNAPSHOT_PARSER_BINDING_CONTRACT
  readonly adapter_slug: CopierCandidateAdapterSlug
  readonly product_type: ProductType
  readonly candidate_locator_contract: string
  readonly parser_contract: CopierSnapshotParserContract
}

/**
 * Exact bridge from an immutable copier RAW artifact and parser-conservation
 * proof to the private publisher projection. The two fixed-multiset digests are
 * deliberately distinct from candidate ledger @1's strict-canonical-JSON
 * multiset digest.
 */
export interface CopierSnapshotProjectionLedger {
  readonly contract: typeof COPIER_SNAPSHOT_PROJECTION_LEDGER_CONTRACT
  readonly serialization_contract: typeof STRICT_CANONICAL_JSON_CONTRACT
  readonly snapshot_artifact_contract: typeof COPIER_SNAPSHOT_ARTIFACT_CONTRACT
  /** Hash of the nested immutable @1 capture, not the future outer @2 artifact hash. */
  readonly snapshot_source_run_id: string
  readonly candidate_ledger_sha256: string
  readonly parser_conservation_sha256: string
  readonly binding: Readonly<CopierSnapshotParserReplayBinding>
  readonly parser_context: Readonly<ParseCtx>
  readonly projection_tuple_contract: typeof COPIER_SNAPSHOT_PROJECTION_TUPLE_CONTRACT
  readonly projection_encoding_contract: typeof COPIER_SNAPSHOT_LENGTH_PREFIXED_UTF8_CONTRACT
  readonly source_candidate_fixed_multiset_contract: typeof COPIER_SNAPSHOT_SOURCE_CANDIDATE_FIXED_MULTISET_CONTRACT
  readonly candidate_projection_fixed_multiset_contract: typeof COPIER_SNAPSHOT_CANDIDATE_PROJECTION_FIXED_MULTISET_CONTRACT
  readonly row_count: number
  readonly source_candidate_fixed_multiset_sha256: string
  readonly candidate_projection_fixed_multiset_sha256: string
  readonly rows: readonly CopierSnapshotProjectionLedgerRow[]
}

export interface BuildCopierSnapshotProjectionLedgerInput {
  readonly src: SourceRow
  readonly artifact: CopierSnapshotArtifact
  readonly candidateLedger: CopierCandidateLedger
  readonly parserProof: CopierParserConservationProof
  readonly rows: readonly ParsedHistoryRow[]
}

export interface RevalidateCopierSnapshotProjectionLedgerInput {
  readonly artifact: unknown
  readonly candidateLedger: unknown
  readonly parserProof: unknown
  readonly ledger: unknown
  /** Immutable child hash supplied by the enclosing @2 artifact/RAW receipt. */
  readonly expectedProjectionLedgerSha256: unknown
}

interface CapturedCopierSnapshotProjectionLedgerInput {
  readonly artifact: unknown
  readonly candidateLedger: unknown
  readonly parserProof: unknown
  readonly ledger: unknown
  readonly expectedProjectionLedgerSha256: unknown
}

function projectionLedgerError(detail: string): Error {
  return new Error(`[ingest] copier projection ledger failed: ${detail}`)
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
    throw projectionLedgerError(`${label} must have the exact contract fields`)
  }
}

function captureRevalidationInput(value: unknown): CapturedCopierSnapshotProjectionLedgerInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw projectionLedgerError('revalidation input must be a non-proxy plain object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw projectionLedgerError('revalidation input must be a non-proxy plain object')
  }
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== COPIER_SNAPSHOT_PROJECTION_REVALIDATION_INPUT_FIELDS.length ||
    ownKeys.some(
      (key) =>
        typeof key !== 'string' ||
        !COPIER_SNAPSHOT_PROJECTION_REVALIDATION_INPUT_FIELDS.includes(
          key as (typeof COPIER_SNAPSHOT_PROJECTION_REVALIDATION_INPUT_FIELDS)[number]
        )
    )
  ) {
    throw projectionLedgerError('revalidation input must have the exact contract fields')
  }

  const dataProperty = (key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw projectionLedgerError('revalidation input must contain enumerable data properties')
    }
    return descriptor.value
  }
  return {
    artifact: dataProperty('artifact'),
    candidateLedger: dataProperty('candidateLedger'),
    parserProof: dataProperty('parserProof'),
    ledger: dataProperty('ledger'),
    expectedProjectionLedgerSha256: dataProperty('expectedProjectionLedgerSha256'),
  }
}

/** Snapshot once so accessors, proxies, hidden keys, and non-JSON values fail closed. */
function canonicalSnapshot(value: unknown, label: string): unknown {
  try {
    const snapshot: unknown = JSON.parse(strictCanonicalJson(value))
    return snapshot
  } catch (cause) {
    throw projectionLedgerError(
      `${label} is not strict canonical JSON: ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
}

function assertReplaySourceRow(value: unknown): asserts value is SourceRow {
  if (
    !isPlainRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    (value.id as number) <= 0 ||
    typeof value.slug !== 'string' ||
    typeof value.adapter_slug !== 'string' ||
    !['spot', 'futures', 'cfd', 'onchain'].includes(String(value.product_type)) ||
    !['USDT', 'USDx', 'USDC', 'USD'].includes(String(value.currency)) ||
    !['full', 'top10', 'top3_preview', 'none'].includes(String(value.copier_table_depth)) ||
    !['local', 'vps_sg', 'vps_jp'].includes(String(value.fetch_region)) ||
    !isPlainRecord(value.tf_label_map) ||
    !isPlainRecord(value.meta)
  ) {
    throw projectionLedgerError('source row is missing canonical replay coordinates')
  }
}

function assertParsedCopierRows(value: unknown): asserts value is ParsedCopierRow[] {
  if (!Array.isArray(value)) {
    throw projectionLedgerError('replayed parser rows must be an array')
  }
  value.forEach((row, index) => {
    if (!isPlainRecord(row) || row.kind !== 'copiers') {
      throw projectionLedgerError(`replayed parser row ${index} is not a copier row`)
    }
  })
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function exactCanonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return strictCanonicalJson(left) === strictCanonicalJson(right)
  } catch {
    return false
  }
}

function assertArtifactSourceCoordinates(src: SourceRow, artifact: CopierSnapshotArtifact): void {
  if (
    src.status !== 'active' ||
    src.serving_mode !== 'serving' ||
    src.copier_table_depth === 'none'
  ) {
    throw projectionLedgerError('source must be active serving with a copier surface')
  }
  if (
    artifact.source.id !== src.id ||
    artifact.source.slug !== src.slug ||
    artifact.source.currency !== src.currency ||
    artifact.source.copier_table_depth !== src.copier_table_depth ||
    artifact.source.fetch_region !== src.fetch_region
  ) {
    throw projectionLedgerError('artifact source coordinates do not match the source row')
  }
}

function assertLiveCopierParserAuthority(
  src: SourceRow,
  binding: CopierCandidateReplayBinding
): void {
  const adapter = getAdapter(binding.adapter_slug)
  if (adapter.slug !== binding.adapter_slug || !supportsSourceSurface(adapter, src, 'copiers')) {
    throw projectionLedgerError(
      `adapter ${binding.adapter_slug} is not a copier parser authority for this source`
    )
  }
}

function revalidateParserBinding(value: unknown): CopierSnapshotParserReplayBinding {
  if (!isPlainRecord(value)) {
    throw projectionLedgerError('parser replay binding must be an object')
  }
  assertExactKeys(
    value,
    ['contract', 'adapter_slug', 'product_type', 'candidate_locator_contract', 'parser_contract'],
    'parser replay binding'
  )
  if (value.contract !== COPIER_SNAPSHOT_PARSER_BINDING_CONTRACT) {
    throw projectionLedgerError('parser replay binding contract is invalid')
  }
  const candidateBinding = revalidateCopierCandidateReplayBinding({
    contract: COPIER_CANDIDATE_REPLAY_BINDING_CONTRACT,
    serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
    adapter_slug: value.adapter_slug,
    product_type: value.product_type,
    candidate_locator_contract: value.candidate_locator_contract,
  })
  const adapterSlug = candidateBinding.adapter_slug
  const parserContract = selectCopierSnapshotParserContract(adapterSlug)
  if (value.parser_contract !== parserContract) {
    throw projectionLedgerError('parser replay binding parser contract is invalid')
  }
  return deepFreeze({
    contract: COPIER_SNAPSHOT_PARSER_BINDING_CONTRACT,
    adapter_slug: adapterSlug,
    product_type: candidateBinding.product_type,
    candidate_locator_contract: candidateBinding.candidate_locator_contract,
    parser_contract: parserContract,
  })
}

function candidateReplayBindingForParserBinding(
  binding: CopierSnapshotParserReplayBinding
): CopierCandidateReplayBinding {
  return revalidateCopierCandidateReplayBinding({
    contract: COPIER_CANDIDATE_REPLAY_BINDING_CONTRACT,
    serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
    adapter_slug: binding.adapter_slug,
    product_type: binding.product_type,
    candidate_locator_contract: binding.candidate_locator_contract,
  })
}

function parserBindingFromSuppliedLedger(value: unknown): CopierSnapshotParserReplayBinding {
  if (!isPlainRecord(value)) {
    throw projectionLedgerError('projection ledger must be an object')
  }
  assertExactKeys(value, COPIER_SNAPSHOT_PROJECTION_LEDGER_FIELDS, 'projection ledger')
  if (
    value.contract !== COPIER_SNAPSHOT_PROJECTION_LEDGER_CONTRACT ||
    value.serialization_contract !== STRICT_CANONICAL_JSON_CONTRACT ||
    value.snapshot_artifact_contract !== COPIER_SNAPSHOT_ARTIFACT_CONTRACT
  ) {
    throw projectionLedgerError('projection ledger header contracts are invalid')
  }
  return revalidateParserBinding(value.binding)
}

function parserContextForBinding(
  artifact: CopierSnapshotArtifact,
  binding: CopierSnapshotParserReplayBinding
): Readonly<ParseCtx> {
  const meta =
    binding.adapter_slug === 'gate' ? { boardKey: binding.product_type as 'futures' | 'cfd' } : {}
  return deepFreeze({
    sourceSlug: artifact.source.slug,
    currency: artifact.source.currency,
    tfLabelMap: {},
    scrapedAt: artifact.observed_at,
    meta,
  } satisfies ParseCtx)
}

interface CanonicalProjectionInputs {
  artifact: CopierSnapshotArtifact
  candidateLedger: CopierCandidateLedger
  parserProof: CopierParserConservationProof
  rows: ParsedCopierRow[]
  binding: CopierSnapshotProjectionLedger['binding']
  parserContext: Readonly<ParseCtx>
}

function replayCopierParser(
  artifact: CopierSnapshotArtifact,
  binding: CopierSnapshotParserReplayBinding,
  parserContext: Readonly<ParseCtx>,
  liveSource?: SourceRow
): ParsedCopierRow[] {
  const adapterSlug = binding.adapter_slug
  const adapter = getAdapter(adapterSlug)
  // Operational capability is a live publication gate, not historical
  // evidence. A source may be retired later while its versioned parser must
  // remain able to replay already anchored artifacts.
  const authorized = liveSource ? supportsSourceSurface(adapter, liveSource, 'copiers') : true
  if (adapter.slug !== adapterSlug || !authorized) {
    throw projectionLedgerError(
      `adapter ${adapterSlug} is not a copier parser authority${liveSource ? ' for this source' : ''}`
    )
  }

  let replayed: ParsedHistoryRow[] = []
  try {
    for (const page of artifact.pages) {
      const parsedPage = adapter.parseHistory(page.payload, 'copiers', parserContext)
      if (!Array.isArray(parsedPage)) {
        throw projectionLedgerError(`adapter ${adapterSlug} returned a non-array parser result`)
      }
      replayed = replayed.concat(parsedPage)
    }
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('[ingest] copier projection ledger')) {
      throw cause
    }
    throw projectionLedgerError(
      `canonical parser replay failed: ${cause instanceof Error ? cause.message : String(cause)}`
    )
  }
  const replayedSnapshot = canonicalSnapshot(replayed, 'replayed parser rows')
  assertParsedCopierRows(replayedSnapshot)
  return replayedSnapshot
}

function canonicalInputs(
  input: BuildCopierSnapshotProjectionLedgerInput
): CanonicalProjectionInputs {
  const sourceSnapshot = canonicalSnapshot(input.src, 'source row')
  assertReplaySourceRow(sourceSnapshot)
  const src = sourceSnapshot

  const artifactSnapshot = canonicalSnapshot(input.artifact, 'copier snapshot artifact')
  const artifact = revalidateCopierSnapshotArtifact(artifactSnapshot)
  assertArtifactSourceCoordinates(src, artifact)

  const candidateReplayBinding = deriveCopierCandidateReplayBinding(src)
  assertLiveCopierParserAuthority(src, candidateReplayBinding)
  const candidateLedgerSnapshot = canonicalSnapshot(input.candidateLedger, 'candidate ledger')
  const candidateLedger = revalidateCopierCandidateLedger({
    src,
    exchangeTraderId: artifact.trader.exchange_trader_id,
    pages: artifact.pages,
    ledger: candidateLedgerSnapshot,
  })
  if (
    candidateLedger.source.id !== artifact.source.id ||
    candidateLedger.source.slug !== artifact.source.slug ||
    candidateLedger.exchange_trader_id !== artifact.trader.exchange_trader_id
  ) {
    throw projectionLedgerError('candidate ledger coordinates do not match the artifact')
  }

  const adapterSlug = candidateLedger.source.adapter_slug
  const binding = revalidateParserBinding({
    contract: COPIER_SNAPSHOT_PARSER_BINDING_CONTRACT,
    adapter_slug: adapterSlug,
    product_type: candidateReplayBinding.product_type,
    candidate_locator_contract: candidateReplayBinding.candidate_locator_contract,
    parser_contract: selectCopierSnapshotParserContract(adapterSlug),
  })
  const parserContext = parserContextForBinding(artifact, binding)

  const replayedRows = replayCopierParser(artifact, binding, parserContext, src)

  const callerRowsSnapshot = canonicalSnapshot(input.rows, 'parsed copier rows')
  if (!Array.isArray(callerRowsSnapshot)) {
    throw projectionLedgerError('parsed copier rows must be an array')
  }
  if (!exactCanonicalEqual(callerRowsSnapshot, replayedRows)) {
    throw projectionLedgerError('parsed copier rows do not match canonical parser replay')
  }

  const parserProofSnapshot = canonicalSnapshot(input.parserProof, 'parser conservation proof')
  const rebuiltProof = verifyCopierParserConservation({
    ledger: candidateLedger,
    rows: replayedRows,
  })
  if (!exactCanonicalEqual(parserProofSnapshot, rebuiltProof)) {
    throw projectionLedgerError(
      'parser conservation proof does not match the replayed candidate ledger and parsed rows'
    )
  }

  return {
    artifact,
    candidateLedger,
    parserProof: rebuiltProof,
    rows: replayedRows,
    binding,
    parserContext,
  }
}

function canonicalStoredInputs(
  input: CapturedCopierSnapshotProjectionLedgerInput,
  suppliedLedger: unknown
): CanonicalProjectionInputs {
  const artifactSnapshot = canonicalSnapshot(input.artifact, 'copier snapshot artifact')
  const artifact = revalidateCopierSnapshotArtifact(artifactSnapshot)
  const binding = parserBindingFromSuppliedLedger(suppliedLedger)
  const candidateReplayBinding = candidateReplayBindingForParserBinding(binding)

  const candidateLedgerSnapshot = canonicalSnapshot(input.candidateLedger, 'candidate ledger')
  const candidateLedger = revalidateCopierCandidateLedgerFromReplayBinding({
    binding: candidateReplayBinding,
    source: { id: artifact.source.id, slug: artifact.source.slug },
    exchangeTraderId: artifact.trader.exchange_trader_id,
    pages: artifact.pages,
    ledger: candidateLedgerSnapshot,
  })
  if (
    candidateLedger.source.id !== artifact.source.id ||
    candidateLedger.source.slug !== artifact.source.slug ||
    candidateLedger.source.adapter_slug !== binding.adapter_slug ||
    candidateLedger.exchange_trader_id !== artifact.trader.exchange_trader_id
  ) {
    throw projectionLedgerError('candidate ledger coordinates do not match the artifact binding')
  }

  const parserContext = parserContextForBinding(artifact, binding)
  const replayedRows = replayCopierParser(artifact, binding, parserContext)
  const parserProofSnapshot = canonicalSnapshot(input.parserProof, 'parser conservation proof')
  const rebuiltProof = verifyCopierParserConservation({
    ledger: candidateLedger,
    rows: replayedRows,
  })
  if (!exactCanonicalEqual(parserProofSnapshot, rebuiltProof)) {
    throw projectionLedgerError(
      'parser conservation proof does not match the replayed candidate ledger and parsed rows'
    )
  }

  return {
    artifact,
    candidateLedger,
    parserProof: rebuiltProof,
    rows: replayedRows,
    binding,
    parserContext,
  }
}

function assembleCopierSnapshotProjectionLedger(
  input: CanonicalProjectionInputs
): CopierSnapshotProjectionLedger {
  const { artifact, candidateLedger, parserProof, rows, binding, parserContext } = input

  const candidateOccurrences = new Map<
    string,
    {
      next: number
      coordinates: Array<{ source_page_ordinal: number; candidate_ordinal: number }>
    }
  >()
  for (const page of candidateLedger.pages) {
    for (const occurrence of page.occurrences) {
      const bucket = candidateOccurrences.get(occurrence.raw_candidate_sha256) ?? {
        next: 0,
        coordinates: [],
      }
      bucket.coordinates.push({
        source_page_ordinal: page.page_ordinal,
        candidate_ordinal: occurrence.candidate_ordinal,
      })
      candidateOccurrences.set(occurrence.raw_candidate_sha256, bucket)
    }
  }

  const ledgerRows = rows.map((row, rowOrdinal) => {
    const proofOccurrence = parserProof.rows[rowOrdinal]
    if (!proofOccurrence || proofOccurrence.row_ordinal !== rowOrdinal) {
      throw projectionLedgerError(`parser proof occurrence ${rowOrdinal} is missing or unordered`)
    }

    const projected = buildCopierSnapshotProjection(row)
    const sourceCandidateSha256 = projected.tuple.source_candidate_sha256
    if (sourceCandidateSha256 !== proofOccurrence.raw_candidate_sha256) {
      throw projectionLedgerError(
        `projection row ${rowOrdinal} does not match its parser-proof RAW occurrence`
      )
    }
    if (copierSnapshotProjectionSha256(projected.tuple) !== projected.projectionSha256) {
      throw projectionLedgerError(`projection row ${rowOrdinal} digest is not reproducible`)
    }

    const occurrenceBucket = candidateOccurrences.get(sourceCandidateSha256)
    const occurrenceCoordinate = occurrenceBucket?.coordinates[occurrenceBucket.next]
    if (!occurrenceBucket || !occurrenceCoordinate) {
      throw projectionLedgerError(
        `projection row ${rowOrdinal} has no unconsumed candidate occurrence`
      )
    }
    occurrenceBucket.next += 1

    return {
      row_ordinal: rowOrdinal,
      source_page_ordinal: occurrenceCoordinate.source_page_ordinal,
      candidate_ordinal: occurrenceCoordinate.candidate_ordinal,
      source_candidate_sha256: sourceCandidateSha256,
      projection_sha256: projected.projectionSha256,
      projection: projected.tuple,
    }
  })

  for (const occurrenceBucket of candidateOccurrences.values()) {
    if (occurrenceBucket.next !== occurrenceBucket.coordinates.length) {
      throw projectionLedgerError('candidate ledger has unconsumed occurrences after projection')
    }
  }

  const sourceCandidateHashes = ledgerRows.map((row) => row.source_candidate_sha256)
  const capturedSourceCandidateHashes = candidateLedger.pages.flatMap((page) =>
    page.occurrences.map((occurrence) => occurrence.raw_candidate_sha256)
  )
  const projectedSourceCandidateFixedMultisetSha256 =
    copierSnapshotSourceCandidateFixedMultisetSha256(sourceCandidateHashes)
  const capturedSourceCandidateFixedMultisetSha256 =
    copierSnapshotSourceCandidateFixedMultisetSha256(capturedSourceCandidateHashes)
  if (projectedSourceCandidateFixedMultisetSha256 !== capturedSourceCandidateFixedMultisetSha256) {
    throw projectionLedgerError('projected rows do not conserve the captured fixed-byte multiset')
  }
  const candidateProjectionPairs: CopierSnapshotCandidateProjectionPair[] = ledgerRows.map(
    (row) => ({
      source_candidate_sha256: row.source_candidate_sha256,
      projection_sha256: row.projection_sha256,
    })
  )

  const ledger = {
    contract: COPIER_SNAPSHOT_PROJECTION_LEDGER_CONTRACT,
    serialization_contract: STRICT_CANONICAL_JSON_CONTRACT,
    snapshot_artifact_contract: COPIER_SNAPSHOT_ARTIFACT_CONTRACT,
    snapshot_source_run_id: copierSnapshotSourceRunId(artifact),
    candidate_ledger_sha256: strictCanonicalSha256(candidateLedger),
    parser_conservation_sha256: strictCanonicalSha256(parserProof),
    binding,
    parser_context: parserContext,
    projection_tuple_contract: COPIER_SNAPSHOT_PROJECTION_TUPLE_CONTRACT,
    projection_encoding_contract: COPIER_SNAPSHOT_LENGTH_PREFIXED_UTF8_CONTRACT,
    source_candidate_fixed_multiset_contract:
      COPIER_SNAPSHOT_SOURCE_CANDIDATE_FIXED_MULTISET_CONTRACT,
    candidate_projection_fixed_multiset_contract:
      COPIER_SNAPSHOT_CANDIDATE_PROJECTION_FIXED_MULTISET_CONTRACT,
    row_count: ledgerRows.length,
    source_candidate_fixed_multiset_sha256: capturedSourceCandidateFixedMultisetSha256,
    candidate_projection_fixed_multiset_sha256:
      copierSnapshotCandidateProjectionFixedMultisetSha256(candidateProjectionPairs),
    rows: ledgerRows,
  } satisfies CopierSnapshotProjectionLedger

  // Validate the complete assembled object once more before freezing it. Every
  // embedded object above is a detached replay product, never a caller object.
  strictCanonicalJson(ledger)
  return deepFreeze(ledger)
}

/**
 * Build a fully replayed ledger under the current live source authority. No
 * caller-supplied candidate or projection digest is trusted: candidate
 * identities come from each exact `row.raw`, and every projection digest is
 * recomputed from its fixed tuple bytes.
 */
export function buildCopierSnapshotProjectionLedger(
  input: BuildCopierSnapshotProjectionLedgerInput
): CopierSnapshotProjectionLedger {
  return assembleCopierSnapshotProjectionLedger(canonicalInputs(input))
}

/**
 * Rebuild from immutable evidence and byte-compare exactly. Historical replay
 * never reads a mutable SourceRow and never accepts caller-supplied parsed rows.
 */
export function revalidateCopierSnapshotProjectionLedger(
  input: RevalidateCopierSnapshotProjectionLedgerInput
): CopierSnapshotProjectionLedger {
  const capturedInput = captureRevalidationInput(input)
  // Capture the immutable receipt primitive before touching any untrusted
  // evidence object; evidence access must never be able to swap its anchor.
  const expectedProjectionLedgerSha256 = capturedInput.expectedProjectionLedgerSha256
  if (
    typeof expectedProjectionLedgerSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(expectedProjectionLedgerSha256)
  ) {
    throw projectionLedgerError('expected projection ledger SHA-256 is invalid')
  }
  const supplied = canonicalSnapshot(capturedInput.ledger, 'projection ledger')
  if (strictCanonicalSha256(supplied) !== expectedProjectionLedgerSha256) {
    throw projectionLedgerError('projection ledger does not match its immutable SHA-256 anchor')
  }
  const rebuilt = assembleCopierSnapshotProjectionLedger(
    canonicalStoredInputs(capturedInput, supplied)
  )
  if (!exactCanonicalEqual(supplied, rebuilt)) {
    throw projectionLedgerError('projection ledger does not match replayed immutable evidence')
  }

  // Revalidate each tuple independently before the exact comparison result is
  // returned; this keeps future builder refactors from weakening tuple checks.
  rebuilt.rows.forEach((row, index) => {
    const tuple = revalidateCopierSnapshotProjectionTuple(row.projection)
    if (
      row.row_ordinal !== index ||
      !Number.isSafeInteger(row.source_page_ordinal) ||
      row.source_page_ordinal <= 0 ||
      !Number.isSafeInteger(row.candidate_ordinal) ||
      row.candidate_ordinal <= 0 ||
      row.source_candidate_sha256 !== tuple.source_candidate_sha256 ||
      row.projection_sha256 !== copierSnapshotProjectionSha256(tuple)
    ) {
      throw projectionLedgerError(`projection ledger row ${index} violates its exact binding`)
    }
  })
  return rebuilt
}
