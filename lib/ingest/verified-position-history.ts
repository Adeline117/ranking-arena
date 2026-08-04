import { createHash } from 'node:crypto'
import { classifyOkxPositionHistorySourceRow } from './adapters/okx/history-terminal'
import { parsedPositionHistoryRowSchema } from './core/schemas'
import type {
  ParsedPositionHistoryFieldSources,
  ParsedPositionHistoryLimitation,
  ParsedPositionHistoryRow,
  ParsedHistoryRow,
  SourceRow,
} from './core/types'
import {
  historyAcquisitionSourceRunId,
  parseHistoryAcquisitionArtifact,
  type HistoryAcquisitionArtifact,
} from './history-acquisition'
import {
  canonicalPositionHistoryCandidateValues,
  canonicalPositionHistoryText,
  canonicalPositionHistoryTimestamp,
} from './position-history-publication-values'
import type { RawObjectReceipt } from './raw'
import {
  assertReviewedPositionHistoryFieldSources,
  buildReviewedPositionHistoryEvidence,
  reviewedPositionHistoryContract,
  reviewedPositionHistoryFactIdentity,
  type ReviewedPositionHistoryEvidence,
  type ReviewedPositionHistoryAdapterSlug,
  type ReviewedPositionHistoryContract,
  type ReviewedPositionHistoryParserContract,
  type ReviewedPositionHistorySourceContract as ReviewedPositionHistorySourceContractValue,
  type ReviewedPositionHistorySourceSlug,
} from './reviewed-position-history'
import { strictCanonicalJson, strictCanonicalSha256 } from './strict-canonical-json'

export {
  BINANCE_POSITION_HISTORY_PARSER_CONTRACT,
  BINANCE_POSITION_HISTORY_SOURCE_CONTRACT,
  BITGET_POSITION_HISTORY_PARSER_CONTRACT,
  BITGET_POSITION_HISTORY_SOURCE_CONTRACT,
  OKX_POSITION_HISTORY_PARSER_CONTRACT,
  OKX_POSITION_HISTORY_SOURCE_CONTRACT,
} from './reviewed-position-history'

export const VERIFIED_POSITION_HISTORY_PUBLICATION_CONTRACT =
  'arena.ingest.verified-position-history-publication@2' as const
export const VERIFIED_POSITION_HISTORY_RPC_PAYLOAD_CONTRACT =
  'arena.ingest.verified-position-history-rpc-payload@2' as const

export const PUBLISH_VERIFIED_POSITION_HISTORY_SQL =
  `SELECT arena.publish_verified_position_history(
     $1::bigint,
     $2::text,
     $3::bigint,
     $4::text
   ) AS receipt` as const

type ReviewedSourceSlug = ReviewedPositionHistorySourceSlug
type ReviewedAdapterSlug = ReviewedPositionHistoryAdapterSlug
type SourceContract = ReviewedPositionHistorySourceContractValue
type ParserContract = ReviewedPositionHistoryParserContract
type ReviewedPositionHistorySourceContract = ReviewedPositionHistoryContract

const SHA256 = /^[0-9a-f]{64}$/
const MAX_PUBLICATION_ROWS = 100_000

type ParsedPositionHistorySchemaOutput = ReturnType<typeof parsedPositionHistoryRowSchema.parse>

function hasNonEmptyFieldSourcePaths(
  row: ParsedPositionHistorySchemaOutput
): row is ParsedPositionHistorySchemaOutput & ParsedPositionHistoryRow {
  if (row.fieldSources === undefined) return true
  return Object.values(row.fieldSources).every(
    (source) => source === undefined || source.fieldPaths.length > 0
  )
}

function publicationError(detail: string): Error {
  return new Error(`[verified-position-history] ${detail}`)
}

function sha256Utf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    Object.is(value, -0)
  ) {
    throw publicationError(`${label} must be a positive safe integer`)
  }
  return value
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    Object.is(value, -0)
  ) {
    throw publicationError(`${label} must be a non-negative safe integer`)
  }
  return value
}

function canonicalTimestamp(value: unknown, label: string): string {
  return canonicalPositionHistoryTimestamp(value, label, publicationError)
}

function normalizedDatabaseTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw publicationError(`${label} must be a database timestamp`)
  }
  const epochMs = Date.parse(value)
  if (!Number.isFinite(epochMs)) throw publicationError(`${label} must be a database timestamp`)
  return new Date(epochMs).toISOString()
}

function canonicalText(
  value: unknown,
  label: string,
  minimumLength: number,
  maximumLength: number
): string {
  return canonicalPositionHistoryText(value, label, minimumLength, maximumLength, publicationError)
}

function deepFreezeJson<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((item) => deepFreezeJson(item))
    return Object.freeze(value)
  }
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach((item) => deepFreezeJson(item))
    return Object.freeze(value)
  }
  return value
}

function canonicalClone<T>(value: T, label: string): T {
  try {
    return deepFreezeJson(JSON.parse(strictCanonicalJson(value)) as T)
  } catch (cause) {
    throw publicationError(`${label} is not strict canonical JSON: ${asError(cause).message}`)
  }
}

function reviewedSourceContract(
  source: Pick<SourceRow, 'id' | 'slug' | 'adapter_slug'>
): ReviewedPositionHistorySourceContract {
  positiveSafeInteger(source.id, 'source id')
  const sourceSlug = canonicalText(source.slug, 'source slug', 1, 128)
  try {
    return reviewedPositionHistoryContract(sourceSlug, source.adapter_slug)
  } catch (cause) {
    throw publicationError(asError(cause).message.replace(/^\[reviewed-position-history\] /, ''))
  }
}

function pageContainsCanonicalRawRow(payload: unknown, canonicalRaw: string): boolean {
  if (payload === null || typeof payload !== 'object') return false
  const pending: object[] = [payload]
  const visited = new Set<object>()
  while (pending.length > 0) {
    const candidate = pending.pop()!
    if (visited.has(candidate)) continue
    visited.add(candidate)
    if (!Array.isArray(candidate)) {
      try {
        if (strictCanonicalJson(candidate) === canonicalRaw) return true
      } catch {
        return false
      }
    }
    for (const value of Object.values(candidate)) {
      if (value !== null && typeof value === 'object') pending.push(value)
    }
  }
  return false
}

export interface VerifiedPositionHistoryFact {
  readonly closed_at: string
  readonly dedupe_hash: string
  readonly entry_price: number | null
  readonly exit_price: number | null
  readonly field_sources: Readonly<ParsedPositionHistoryFieldSources> | null
  readonly leverage: number | null
  readonly limitations: readonly ParsedPositionHistoryLimitation[] | null
  readonly opened_at: string | null
  readonly raw: Readonly<Record<string, unknown>>
  readonly realized_pnl: number | null
  readonly side: string | null
  readonly size: number | null
  readonly source_fact_id: string | null
  readonly source_lifecycle_marker: string | null
  readonly source_return: number | null
  readonly symbol: string
}

export interface VerifiedPositionHistoryRowCandidate {
  readonly pageOrdinal: number
  readonly sourceRowOrdinal: number
  readonly row: ParsedHistoryRow
}

interface VerifiedPositionHistoryRowBindingBase {
  readonly binding_ordinal: number
  readonly classification: 'canonical_materialized' | 'source_partial_omitted'
  readonly page_fetched_at: string
  readonly page_ordinal: number
  readonly page_payload_sha256: string
  readonly page_stored_index: number
  readonly raw_row_canonical_json: string
  readonly raw_row_sha256: string
  readonly source_row_ordinal: number
}

export interface VerifiedPositionHistoryMaterializedRowBinding extends VerifiedPositionHistoryRowBindingBase {
  readonly classification: 'canonical_materialized'
  readonly fact_canonical_json: string
  readonly fact_ordinal: number
  readonly fact_sha256: string
}

export interface VerifiedPositionHistoryPartialRowBinding extends VerifiedPositionHistoryRowBindingBase {
  readonly classification: 'source_partial_omitted'
  readonly fact_canonical_json: null
  readonly fact_ordinal: null
  readonly fact_sha256: null
}

export type VerifiedPositionHistoryRowBinding =
  | VerifiedPositionHistoryMaterializedRowBinding
  | VerifiedPositionHistoryPartialRowBinding

export interface VerifiedPositionHistoryRpcPayload {
  readonly adapter_slug: ReviewedAdapterSlug
  readonly contract: typeof VERIFIED_POSITION_HISTORY_RPC_PAYLOAD_CONTRACT
  readonly exchange_trader_id: string
  readonly history_kind: 'position_history'
  readonly observed_at: string
  readonly page_count: number
  readonly parser_contract: ParserContract
  readonly previous_publication_id: number | null
  readonly raw_object_id: number
  readonly binding_set_sha256: string
  readonly bindings_canonical_json: string
  readonly serialization_contract: 'arena.strict-canonical-json@1'
  readonly source_contract: SourceContract
  readonly source_id: number
  readonly source_run_id: string
  readonly source_slug: ReviewedSourceSlug
  readonly starting_cursor: string | null
  readonly trader_id: number
}

const FACT_KEYS = Object.freeze([
  'closed_at',
  'dedupe_hash',
  'entry_price',
  'exit_price',
  'field_sources',
  'leverage',
  'limitations',
  'opened_at',
  'raw',
  'realized_pnl',
  'side',
  'size',
  'source_fact_id',
  'source_lifecycle_marker',
  'source_return',
  'symbol',
] as const)

const ROW_BINDING_KEYS = Object.freeze([
  'binding_ordinal',
  'classification',
  'fact_canonical_json',
  'fact_ordinal',
  'fact_sha256',
  'page_fetched_at',
  'page_ordinal',
  'page_payload_sha256',
  'page_stored_index',
  'raw_row_canonical_json',
  'raw_row_sha256',
  'source_row_ordinal',
] as const)

function strictCanonicalJsonText(
  value: unknown,
  label: string
): {
  readonly canonicalJson: string
  readonly parsed: unknown
} {
  if (typeof value !== 'string') throw publicationError(`${label} must be canonical JSON text`)
  try {
    const parsed: unknown = JSON.parse(value)
    if (strictCanonicalJson(parsed) !== value) {
      throw publicationError(`${label} must be exact strict canonical JSON text`)
    }
    return { canonicalJson: value, parsed }
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('[verified-position-history]')) {
      throw cause
    }
    throw publicationError(`${label} must be exact strict canonical JSON text`)
  }
}

/**
 * Revalidate the complete mixed binding set against the independently built
 * page manifest. This is deliberately stricter than TypeScript's union: it
 * detects missing, duplicated, reordered and cross-page bindings at runtime,
 * and makes the null/non-null fact split part of the wire contract.
 */
export function validateVerifiedPositionHistoryBindingSet(
  value: unknown,
  evidence: Pick<ReviewedPositionHistoryEvidence, 'artifact' | 'contract' | 'pageManifest'>
): readonly VerifiedPositionHistoryRowBinding[] {
  if (!Array.isArray(value) || value.length > MAX_PUBLICATION_ROWS) {
    throw publicationError('binding set exceeds the bounded array contract')
  }
  const expectedBindings = evidence.pageManifest.flatMap((page) =>
    page.source_rows
      .filter((sourceRow) => sourceRow.classification !== 'verifier_only')
      .map((sourceRow) => ({ page, sourceRow }))
  )
  if (value.length !== expectedBindings.length) {
    throw publicationError('binding count does not exactly match the reviewed source manifest')
  }

  let expectedFactOrdinal = 0
  const validated: VerifiedPositionHistoryRowBinding[] = []
  value.forEach((candidate, index) => {
    if (!isPlainRecord(candidate) || !exactKeys(candidate, ROW_BINDING_KEYS)) {
      throw publicationError(`binding ${index + 1} has an inexact field set`)
    }
    const bindingOrdinal = positiveSafeInteger(
      candidate.binding_ordinal,
      `binding ${index + 1} binding_ordinal`
    )
    if (bindingOrdinal !== index + 1) {
      throw publicationError('binding ordinals must be dense and preserve source order')
    }

    const expected = expectedBindings[index]
    const pageOrdinal = positiveSafeInteger(
      candidate.page_ordinal,
      `binding ${bindingOrdinal} page_ordinal`
    )
    const sourceRowOrdinal = positiveSafeInteger(
      candidate.source_row_ordinal,
      `binding ${bindingOrdinal} source_row_ordinal`
    )
    const pageStoredIndex = positiveSafeInteger(
      candidate.page_stored_index,
      `binding ${bindingOrdinal} page_stored_index`
    )
    if (
      pageOrdinal !== expected.page.ordinal ||
      sourceRowOrdinal !== expected.sourceRow.source_row_ordinal ||
      pageStoredIndex !== expected.page.stored_page_index
    ) {
      throw publicationError(
        `binding ${bindingOrdinal} does not match the exact manifest coordinate order`
      )
    }
    if (
      candidate.classification !== expected.sourceRow.classification ||
      (candidate.classification !== 'canonical_materialized' &&
        candidate.classification !== 'source_partial_omitted')
    ) {
      throw publicationError(`binding ${bindingOrdinal} classification does not match manifest`)
    }

    const pageFetchedAt = canonicalTimestamp(
      candidate.page_fetched_at,
      `binding ${bindingOrdinal} page_fetched_at`
    )
    const pagePayloadSha256 = candidate.page_payload_sha256
    if (
      pageFetchedAt !== expected.page.fetched_at ||
      typeof pagePayloadSha256 !== 'string' ||
      pagePayloadSha256 !== expected.page.payload_sha256 ||
      !SHA256.test(pagePayloadSha256)
    ) {
      throw publicationError(`binding ${bindingOrdinal} page evidence does not match manifest`)
    }

    const raw = strictCanonicalJsonText(
      candidate.raw_row_canonical_json,
      `binding ${bindingOrdinal} RAW row`
    )
    const rawRowSha256 = candidate.raw_row_sha256
    if (
      typeof rawRowSha256 !== 'string' ||
      !SHA256.test(rawRowSha256) ||
      sha256Utf8(raw.canonicalJson) !== rawRowSha256 ||
      rawRowSha256 !== expected.sourceRow.source_row_sha256
    ) {
      throw publicationError(`binding ${bindingOrdinal} RAW digest does not match manifest`)
    }

    if (candidate.classification === 'source_partial_omitted') {
      if (evidence.contract.sourceSlug !== 'okx_futures') {
        throw publicationError('source partial omission is allowed only for reviewed OKX history')
      }
      if (evidence.artifact.termination.scan_terminal_state !== 'exhausted') {
        throw publicationError('source partial omission requires an exhausted acquisition')
      }
      if (
        classifyOkxPositionHistorySourceRow(
          raw.parsed,
          Date.parse(pageFetchedAt),
          evidence.artifact.trader.exchange_trader_id
        )?.classification !== 'source_partial_omitted'
      ) {
        throw publicationError('source partial binding does not carry exact OKX omission evidence')
      }
      if (
        candidate.fact_ordinal !== null ||
        candidate.fact_canonical_json !== null ||
        candidate.fact_sha256 !== null
      ) {
        throw publicationError('source partial binding must not carry a materialized fact')
      }
      validated.push(
        deepFreezeJson({
          binding_ordinal: bindingOrdinal,
          classification: 'source_partial_omitted' as const,
          fact_canonical_json: null,
          fact_ordinal: null,
          fact_sha256: null,
          page_fetched_at: pageFetchedAt,
          page_ordinal: pageOrdinal,
          page_payload_sha256: pagePayloadSha256,
          page_stored_index: pageStoredIndex,
          raw_row_canonical_json: raw.canonicalJson,
          raw_row_sha256: rawRowSha256,
          source_row_ordinal: sourceRowOrdinal,
        })
      )
      return
    }

    expectedFactOrdinal += 1
    if (
      candidate.fact_ordinal === null ||
      candidate.fact_canonical_json === null ||
      candidate.fact_sha256 === null
    ) {
      throw publicationError('canonical materialized binding must carry an exact fact')
    }
    const factOrdinal = positiveSafeInteger(
      candidate.fact_ordinal,
      `binding ${bindingOrdinal} fact_ordinal`
    )
    if (factOrdinal !== expectedFactOrdinal) {
      throw publicationError('materialized fact ordinals must be dense in binding order')
    }
    const fact = strictCanonicalJsonText(
      candidate.fact_canonical_json,
      `binding ${bindingOrdinal} fact`
    )
    const factSha256 = candidate.fact_sha256
    if (
      typeof factSha256 !== 'string' ||
      !SHA256.test(factSha256) ||
      sha256Utf8(fact.canonicalJson) !== factSha256 ||
      !isPlainRecord(fact.parsed) ||
      !exactKeys(fact.parsed, FACT_KEYS) ||
      strictCanonicalJson(fact.parsed.raw) !== raw.canonicalJson
    ) {
      throw publicationError(`binding ${bindingOrdinal} materialized fact is not exact`)
    }
    validated.push(
      deepFreezeJson({
        binding_ordinal: bindingOrdinal,
        classification: 'canonical_materialized' as const,
        fact_canonical_json: fact.canonicalJson,
        fact_ordinal: factOrdinal,
        fact_sha256: factSha256,
        page_fetched_at: pageFetchedAt,
        page_ordinal: pageOrdinal,
        page_payload_sha256: pagePayloadSha256,
        page_stored_index: pageStoredIndex,
        raw_row_canonical_json: raw.canonicalJson,
        raw_row_sha256: rawRowSha256,
        source_row_ordinal: sourceRowOrdinal,
      })
    )
  })

  return Object.freeze(validated)
}

const PREPARED_PUBLICATION_BRAND: unique symbol = Symbol(
  'PreparedVerifiedPositionHistoryPublication'
)
const PREPARED_PUBLICATIONS = new WeakSet<object>()

export interface PreparedVerifiedPositionHistoryPublication {
  readonly [PREPARED_PUBLICATION_BRAND]: true
  readonly contract: typeof VERIFIED_POSITION_HISTORY_PUBLICATION_CONTRACT
  readonly observedAt: string
  readonly parserContract: ParserContract
  readonly previousPublicationId: number | null
  readonly bindingSetSha256: string
  readonly publicationSha256: string
  readonly rawObjectId: number
  readonly rowBindings: readonly VerifiedPositionHistoryRowBinding[]
  readonly rows: readonly VerifiedPositionHistoryFact[]
  readonly rpcPayload: VerifiedPositionHistoryRpcPayload
  readonly rpcPayloadCanonicalJson: string
  readonly sourceContract: SourceContract
  readonly sourceRunId: string
  readonly startingCursor: string | null
}

export interface PrepareVerifiedPositionHistoryPublicationInput {
  readonly acquisition: HistoryAcquisitionArtifact
  readonly previousPublicationId: number | null
  readonly rawObject: RawObjectReceipt
  readonly rows: readonly VerifiedPositionHistoryRowCandidate[]
  readonly source: Pick<SourceRow, 'id' | 'slug' | 'adapter_slug'>
  readonly sourceRunId: string
}

function preparedFact(
  parsed: ParsedPositionHistoryRow,
  pageFetchedAt: string,
  observedAt: string,
  contract: ReviewedPositionHistorySourceContract
): VerifiedPositionHistoryFact {
  try {
    assertReviewedPositionHistoryFieldSources(contract, parsed)
  } catch (cause) {
    throw publicationError(asError(cause).message.replace(/^\[reviewed-position-history\] /, ''))
  }
  const values = canonicalPositionHistoryCandidateValues(
    contract.sourceSlug,
    contract.servingReturnScale,
    parsed,
    pageFetchedAt,
    observedAt,
    publicationError
  )

  return canonicalClone(
    {
      closed_at: values.closedAt,
      dedupe_hash: values.dedupeHash,
      entry_price: values.entryPrice,
      exit_price: values.exitPrice,
      field_sources: parsed.fieldSources ?? null,
      leverage: values.leverage,
      limitations: parsed.limitations ?? null,
      opened_at: values.openedAt,
      raw: parsed.raw,
      realized_pnl: values.realizedPnl,
      side: values.side,
      size: values.size,
      source_fact_id: values.sourceFactId,
      source_lifecycle_marker: values.sourceLifecycleMarker,
      source_return: values.sourceReturn,
      symbol: values.symbol,
    } satisfies VerifiedPositionHistoryFact,
    'position-history fact'
  )
}

function validateRawObjectBinding(
  rawObject: RawObjectReceipt,
  sourceSlug: ReviewedSourceSlug,
  sourceRunId: string
): number {
  const rawObjectId = positiveSafeInteger(rawObject.id, 'RAW object id')
  const expectedPath =
    `${sourceSlug}/history_trust/position_history/${sourceRunId}/` +
    `event_history_${sourceRunId}.json.gz`
  if (rawObject.contentHash !== sourceRunId || rawObject.storagePath !== expectedPath) {
    throw publicationError('RAW object receipt does not match the acquisition source run')
  }
  return rawObjectId
}

export function prepareVerifiedPositionHistoryPublication(
  input: PrepareVerifiedPositionHistoryPublicationInput
): PreparedVerifiedPositionHistoryPublication {
  const contract = reviewedSourceContract(input.source)
  if (!SHA256.test(input.sourceRunId) || input.sourceRunId === '0'.repeat(64)) {
    throw publicationError('source run id must be a non-zero lowercase SHA-256 digest')
  }

  let artifact: HistoryAcquisitionArtifact
  try {
    artifact = parseHistoryAcquisitionArtifact(input.acquisition)
  } catch (cause) {
    throw publicationError(`acquisition artifact is invalid: ${asError(cause).message}`)
  }
  if (
    artifact.history_kind !== 'position_history' ||
    artifact.source.id !== input.source.id ||
    artifact.source.slug !== input.source.slug
  ) {
    throw publicationError('acquisition source or history kind does not match the reviewed source')
  }
  if (historyAcquisitionSourceRunId(artifact) !== input.sourceRunId) {
    throw publicationError('source run id does not match the canonical acquisition artifact')
  }
  if (artifact.pages.length === 0) {
    throw publicationError('verified publication requires at least one acquisition page')
  }
  if (artifact.pages.length > 100_000) {
    throw publicationError('acquisition page count exceeds the publication bound')
  }
  let evidence: ReturnType<typeof buildReviewedPositionHistoryEvidence>
  try {
    evidence = buildReviewedPositionHistoryEvidence(artifact, input.sourceRunId)
  } catch (cause) {
    throw publicationError(asError(cause).message.replace(/^\[reviewed-position-history\] /, ''))
  }
  if (evidence.contract !== contract) {
    throw publicationError('shared reviewed source contract does not match publication input')
  }
  const sourceSlug = contract.sourceSlug

  const observedAt = canonicalTimestamp(evidence.observedAt, 'acquisition observedAt')
  const startingCursor =
    artifact.starting_cursor === null
      ? null
      : canonicalTimestamp(artifact.starting_cursor, 'starting cursor')
  if (startingCursor !== null && Date.parse(startingCursor) > Date.parse(observedAt)) {
    throw publicationError('starting cursor must not follow acquisition observedAt')
  }
  const previousPublicationId =
    input.previousPublicationId === null
      ? null
      : positiveSafeInteger(input.previousPublicationId, 'previous publication id')
  const rawObjectId = validateRawObjectBinding(input.rawObject, sourceSlug, input.sourceRunId)
  positiveSafeInteger(artifact.trader.id, 'trader id')
  canonicalText(artifact.trader.exchange_trader_id, 'exchange trader id', 1, 512)

  if (!Array.isArray(input.rows) || input.rows.length > MAX_PUBLICATION_ROWS) {
    throw publicationError('publication rows exceed the bounded array contract')
  }
  const replayedCandidates = evidence.canonicalRows
  if (input.rows.length !== replayedCandidates.length) {
    throw publicationError(
      'input row count does not exactly match the reviewed canonical parser output'
    )
  }
  const facts: VerifiedPositionHistoryFact[] = []
  const materializedBindings = new Map<
    string,
    Readonly<{
      factCanonicalJson: string
      factOrdinal: number
      factSha256: string
      rawRowCanonicalJson: string
      rawRowSha256: string
    }>
  >()
  const dedupeHashes = new Set<string>()
  const sourceFactIds = new Set<string>()

  input.rows.forEach((candidate, index) => {
    if (
      !isPlainRecord(candidate) ||
      !exactKeys(candidate, ['pageOrdinal', 'row', 'sourceRowOrdinal'])
    ) {
      throw publicationError(`row candidate ${index + 1} has an inexact envelope`)
    }
    const pageOrdinal = positiveSafeInteger(candidate.pageOrdinal, `row ${index + 1} pageOrdinal`)
    const sourceRowOrdinal = positiveSafeInteger(
      candidate.sourceRowOrdinal,
      `row ${index + 1} sourceRowOrdinal`
    )
    const page = artifact.pages[pageOrdinal - 1]
    if (!page) throw publicationError(`row ${index + 1} references an unknown page ordinal`)
    const replayed = replayedCandidates[index]
    if (replayed.pageOrdinal !== pageOrdinal) {
      throw publicationError(`row ${index + 1} page ordinal does not match reviewed parser order`)
    }
    if (replayed.sourceRowOrdinal !== sourceRowOrdinal) {
      throw publicationError(
        `row ${index + 1} source row ordinal does not match reviewed parser order`
      )
    }
    const manifestPage = evidence.pageManifest[pageOrdinal - 1]
    if (
      manifestPage === undefined ||
      manifestPage.ordinal !== pageOrdinal ||
      manifestPage.stored_page_index !== page.stored_page_index
    ) {
      throw publicationError(`row ${index + 1} is not bound to a canonical manifest page`)
    }
    const manifestSourceRow = manifestPage.source_rows[sourceRowOrdinal - 1]
    if (
      manifestSourceRow === undefined ||
      manifestSourceRow.source_row_ordinal !== sourceRowOrdinal ||
      manifestSourceRow.classification !== 'canonical_materialized'
    ) {
      throw publicationError(`row ${index + 1} is not bound to an exact manifest source row`)
    }

    let parsed: ParsedPositionHistoryRow
    try {
      const validated = parsedPositionHistoryRowSchema.parse(candidate.row)
      if (!hasNonEmptyFieldSourcePaths(validated)) {
        throw publicationError(`row ${index + 1} contains an empty field source path`)
      }
      parsed = validated
    } catch (cause) {
      throw publicationError(`row ${index + 1} is not position_history: ${asError(cause).message}`)
    }
    try {
      reviewedPositionHistoryFactIdentity(contract, parsed, page.payload)
    } catch (cause) {
      throw publicationError(asError(cause).message.replace(/^\[reviewed-position-history\] /, ''))
    }
    const pageFetchedAt = canonicalTimestamp(
      manifestPage.fetched_at,
      `page ${pageOrdinal} fetchedAt`
    )
    if (pageFetchedAt !== page.fetched_at) {
      throw publicationError(`page ${pageOrdinal} fetchedAt does not match the shared manifest`)
    }
    const fact = preparedFact(parsed, pageFetchedAt, observedAt, contract)
    if (fact.source_fact_id === null) {
      throw publicationError(`row ${index + 1} has no reviewed source fact identity`)
    }
    if (dedupeHashes.has(fact.dedupe_hash) || sourceFactIds.has(fact.source_fact_id)) {
      throw publicationError(`row ${index + 1} duplicates a reviewed fact identity`)
    }
    dedupeHashes.add(fact.dedupe_hash)
    sourceFactIds.add(fact.source_fact_id)

    const rawRowCanonicalJson = strictCanonicalJson(fact.raw)
    if (!pageContainsCanonicalRawRow(page.payload, rawRowCanonicalJson)) {
      throw publicationError(`row ${index + 1} RAW value is not present in its bound page`)
    }
    if (strictCanonicalJson(parsed) !== strictCanonicalJson(replayed.row)) {
      throw publicationError(`row ${index + 1} does not exactly match reviewed parser output`)
    }
    const factCanonicalJson = strictCanonicalJson(fact)
    const factSha256 = sha256Utf8(factCanonicalJson)
    const rawRowSha256 = sha256Utf8(rawRowCanonicalJson)
    if (rawRowSha256 !== manifestSourceRow.source_row_sha256) {
      throw publicationError(`row ${index + 1} RAW digest does not match the shared manifest`)
    }
    const pagePayloadSha256 = strictCanonicalSha256(page.payload)
    if (
      pagePayloadSha256 !== page.payload_sha256 ||
      pagePayloadSha256 !== manifestPage.payload_sha256
    ) {
      throw publicationError(
        `page ${pageOrdinal} payload digest does not match the shared manifest`
      )
    }

    facts.push(fact)
    materializedBindings.set(
      `${pageOrdinal}:${sourceRowOrdinal}`,
      Object.freeze({
        factCanonicalJson,
        factOrdinal: index + 1,
        factSha256,
        rawRowCanonicalJson,
        rawRowSha256,
      })
    )
  })

  const frozenFacts = Object.freeze([...facts])
  const rowBindings = evidence.bindingRows.map((candidate, index) => {
    const page = artifact.pages[candidate.pageOrdinal - 1]
    const manifestPage = evidence.pageManifest[candidate.pageOrdinal - 1]
    const manifestSourceRow = manifestPage?.source_rows[candidate.sourceRowOrdinal - 1]
    if (
      page === undefined ||
      manifestPage === undefined ||
      manifestSourceRow === undefined ||
      manifestSourceRow.classification !== candidate.classification
    ) {
      throw publicationError(`binding ${index + 1} is absent from the reviewed source manifest`)
    }

    const rawRowCanonicalJson = strictCanonicalJson(candidate.row.raw)
    const rawRowSha256 = sha256Utf8(rawRowCanonicalJson)
    const pagePayloadSha256 = strictCanonicalSha256(page.payload)
    const common = {
      binding_ordinal: index + 1,
      classification: candidate.classification,
      page_fetched_at: manifestPage.fetched_at,
      page_ordinal: candidate.pageOrdinal,
      page_payload_sha256: pagePayloadSha256,
      page_stored_index: page.stored_page_index,
      raw_row_canonical_json: rawRowCanonicalJson,
      raw_row_sha256: rawRowSha256,
      source_row_ordinal: candidate.sourceRowOrdinal,
    } as const
    if (
      rawRowSha256 !== manifestSourceRow.source_row_sha256 ||
      pagePayloadSha256 !== page.payload_sha256 ||
      pagePayloadSha256 !== manifestPage.payload_sha256
    ) {
      throw publicationError(`binding ${index + 1} does not match the reviewed RAW manifest`)
    }

    const materialized = materializedBindings.get(
      `${candidate.pageOrdinal}:${candidate.sourceRowOrdinal}`
    )
    if (candidate.classification === 'source_partial_omitted') {
      if (materialized !== undefined) {
        throw publicationError('source partial binding unexpectedly resolved to a fact')
      }
      return deepFreezeJson({
        ...common,
        classification: 'source_partial_omitted' as const,
        fact_canonical_json: null,
        fact_ordinal: null,
        fact_sha256: null,
      }) satisfies VerifiedPositionHistoryPartialRowBinding
    }
    if (
      materialized === undefined ||
      materialized.rawRowCanonicalJson !== rawRowCanonicalJson ||
      materialized.rawRowSha256 !== rawRowSha256
    ) {
      throw publicationError('canonical materialized binding is missing its exact fact')
    }
    return deepFreezeJson({
      ...common,
      classification: 'canonical_materialized' as const,
      fact_canonical_json: materialized.factCanonicalJson,
      fact_ordinal: materialized.factOrdinal,
      fact_sha256: materialized.factSha256,
    }) satisfies VerifiedPositionHistoryMaterializedRowBinding
  })
  const frozenBindings = validateVerifiedPositionHistoryBindingSet(rowBindings, evidence)
  const bindingsCanonicalJson = strictCanonicalJson(frozenBindings)
  const bindingSetSha256 = sha256Utf8(bindingsCanonicalJson)
  const rpcPayload = deepFreezeJson({
    adapter_slug: contract.adapterSlug,
    contract: VERIFIED_POSITION_HISTORY_RPC_PAYLOAD_CONTRACT,
    exchange_trader_id: artifact.trader.exchange_trader_id,
    history_kind: 'position_history' as const,
    observed_at: observedAt,
    page_count: artifact.pages.length,
    parser_contract: contract.parserContract,
    previous_publication_id: previousPublicationId,
    raw_object_id: rawObjectId,
    binding_set_sha256: bindingSetSha256,
    bindings_canonical_json: bindingsCanonicalJson,
    serialization_contract: 'arena.strict-canonical-json@1' as const,
    source_contract: contract.sourceContract,
    source_id: artifact.source.id,
    source_run_id: input.sourceRunId,
    source_slug: sourceSlug,
    starting_cursor: startingCursor,
    trader_id: artifact.trader.id,
  }) as VerifiedPositionHistoryRpcPayload
  const rpcPayloadCanonicalJson = strictCanonicalJson(rpcPayload)
  const publicationSha256 = sha256Utf8(rpcPayloadCanonicalJson)

  const prepared = Object.freeze({
    [PREPARED_PUBLICATION_BRAND]: true as const,
    bindingSetSha256,
    contract: VERIFIED_POSITION_HISTORY_PUBLICATION_CONTRACT,
    observedAt,
    parserContract: contract.parserContract,
    previousPublicationId,
    publicationSha256,
    rawObjectId,
    rowBindings: frozenBindings,
    rows: frozenFacts,
    rpcPayload,
    rpcPayloadCanonicalJson,
    sourceContract: contract.sourceContract,
    sourceRunId: input.sourceRunId,
    startingCursor,
  }) satisfies PreparedVerifiedPositionHistoryPublication
  PREPARED_PUBLICATIONS.add(prepared)
  return prepared
}

export function isPreparedVerifiedPositionHistoryPublication(
  value: unknown
): value is PreparedVerifiedPositionHistoryPublication {
  return (
    value !== null &&
    typeof value === 'object' &&
    PREPARED_PUBLICATIONS.has(value) &&
    (value as Partial<PreparedVerifiedPositionHistoryPublication>).contract ===
      VERIFIED_POSITION_HISTORY_PUBLICATION_CONTRACT
  )
}

function assertPrepared(
  value: PreparedVerifiedPositionHistoryPublication
): asserts value is PreparedVerifiedPositionHistoryPublication {
  if (!isPreparedVerifiedPositionHistoryPublication(value)) {
    throw publicationError('publication was not produced by the verified preparation boundary')
  }
}

export interface PreparedVerifiedPositionHistoryRpcCall {
  readonly text: typeof PUBLISH_VERIFIED_POSITION_HISTORY_SQL
  readonly values: readonly [number, string, number | null, string]
}

export function prepareVerifiedPositionHistoryRpcCall(
  publication: PreparedVerifiedPositionHistoryPublication
): PreparedVerifiedPositionHistoryRpcCall {
  assertPrepared(publication)
  const values: readonly [number, string, number | null, string] = Object.freeze([
    publication.rawObjectId,
    publication.sourceRunId,
    publication.previousPublicationId,
    publication.rpcPayloadCanonicalJson,
  ])

  return Object.freeze({
    text: PUBLISH_VERIFIED_POSITION_HISTORY_SQL,
    values,
  })
}

export interface VerifiedPositionHistoryPublicationReceipt {
  readonly cursorAfter: string | null
  readonly factsAdded: number
  readonly factsReused: number
  readonly observedAt: string
  readonly publicationId: number
  readonly publicationSha256: string
  readonly rawObjectId: number
  readonly replayed: boolean
  readonly sourceRunId: string
  readonly stateId: number
}

function expectedCursorAfter(
  publication: PreparedVerifiedPositionHistoryPublication
): string | null {
  let cursor = publication.startingCursor
  for (const row of publication.rows) {
    if (cursor === null || Date.parse(row.closed_at) > Date.parse(cursor)) cursor = row.closed_at
  }
  return cursor
}

const RECEIPT_KEYS = [
  'cursorAfter',
  'factsAdded',
  'factsReused',
  'observedAt',
  'publicationId',
  'publicationSha256',
  'rawObjectId',
  'replayed',
  'sourceRunId',
  'stateId',
] as const

export function validateVerifiedPositionHistoryPublicationReceipt(
  publication: PreparedVerifiedPositionHistoryPublication,
  value: unknown
): VerifiedPositionHistoryPublicationReceipt {
  assertPrepared(publication)
  if (!isPlainRecord(value) || !exactKeys(value, RECEIPT_KEYS)) {
    throw publicationError('publication receipt has an inexact field set')
  }

  const publicationId = positiveSafeInteger(value.publicationId, 'receipt publicationId')
  const rawObjectId = positiveSafeInteger(value.rawObjectId, 'receipt rawObjectId')
  const stateId = positiveSafeInteger(value.stateId, 'receipt stateId')
  if (stateId !== publicationId) {
    throw publicationError('receipt stateId does not match publicationId')
  }
  const factsAdded = nonNegativeSafeInteger(value.factsAdded, 'receipt factsAdded')
  const factsReused = nonNegativeSafeInteger(value.factsReused, 'receipt factsReused')
  if (typeof value.replayed !== 'boolean') {
    throw publicationError('receipt replayed must be boolean')
  }
  const observedAt = normalizedDatabaseTimestamp(value.observedAt, 'receipt observedAt')
  const cursorAfter =
    value.cursorAfter === null
      ? null
      : normalizedDatabaseTimestamp(value.cursorAfter, 'receipt cursorAfter')

  if (value.publicationSha256 !== publication.publicationSha256) {
    throw publicationError('receipt publicationSha256 does not match the publication')
  }
  if (value.sourceRunId !== publication.sourceRunId) {
    throw publicationError('receipt sourceRunId does not match the acquisition')
  }
  if (rawObjectId !== publication.rawObjectId) {
    throw publicationError('receipt rawObjectId does not match the RAW object')
  }

  if (observedAt !== publication.observedAt) {
    throw publicationError('receipt observedAt does not match the acquisition')
  }
  if (cursorAfter !== expectedCursorAfter(publication)) {
    throw publicationError('receipt cursorAfter does not match the verified row set')
  }
  if (factsAdded + factsReused !== publication.rows.length) {
    throw publicationError('receipt fact counts do not match the verified row set')
  }
  if (value.replayed && (factsAdded !== 0 || factsReused !== publication.rows.length)) {
    throw publicationError('replayed receipt fact counts are not exact')
  }

  return Object.freeze({
    cursorAfter,
    factsAdded,
    factsReused,
    observedAt,
    publicationId,
    publicationSha256: publication.publicationSha256,
    rawObjectId,
    replayed: value.replayed,
    sourceRunId: publication.sourceRunId,
    stateId,
  })
}
