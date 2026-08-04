import { createHash } from 'node:crypto'
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
  'arena.ingest.verified-position-history-publication@1' as const
export const VERIFIED_POSITION_HISTORY_RPC_PAYLOAD_CONTRACT =
  'arena.ingest.verified-position-history-rpc-payload@1' as const

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

export interface VerifiedPositionHistoryRowBinding {
  readonly fact_canonical_json: string
  readonly input_ordinal: number
  readonly page_fetched_at: string
  readonly page_ordinal: number
  readonly page_payload_sha256: string
  readonly page_stored_index: number
  readonly raw_row_canonical_json: string
  readonly raw_row_sha256: string
  readonly row_sha256: string
  readonly source_row_ordinal: number
}

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
  readonly row_set_sha256: string
  readonly rows_canonical_json: string
  readonly serialization_contract: 'arena.strict-canonical-json@1'
  readonly source_contract: SourceContract
  readonly source_id: number
  readonly source_run_id: string
  readonly source_slug: ReviewedSourceSlug
  readonly starting_cursor: string | null
  readonly trader_id: number
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
  readonly publicationSha256: string
  readonly rawObjectId: number
  readonly rowBindings: readonly VerifiedPositionHistoryRowBinding[]
  readonly rows: readonly VerifiedPositionHistoryFact[]
  readonly rowSetSha256: string
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
  const rowBindings: VerifiedPositionHistoryRowBinding[] = []
  const facts: VerifiedPositionHistoryFact[] = []
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
      manifestPage.classification !== 'canonical_materialized' ||
      manifestPage.ordinal !== pageOrdinal ||
      manifestPage.stored_page_index !== page.stored_page_index
    ) {
      throw publicationError(`row ${index + 1} is not bound to a canonical manifest page`)
    }
    const manifestSourceRow = manifestPage.source_rows[sourceRowOrdinal - 1]
    if (
      manifestSourceRow === undefined ||
      manifestSourceRow.source_row_ordinal !== sourceRowOrdinal
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
    const rowSha256 = sha256Utf8(factCanonicalJson)
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
    rowBindings.push(
      deepFreezeJson({
        fact_canonical_json: factCanonicalJson,
        input_ordinal: index + 1,
        page_fetched_at: pageFetchedAt,
        page_ordinal: pageOrdinal,
        page_payload_sha256: pagePayloadSha256,
        page_stored_index: page.stored_page_index,
        raw_row_canonical_json: rawRowCanonicalJson,
        raw_row_sha256: rawRowSha256,
        row_sha256: rowSha256,
        source_row_ordinal: sourceRowOrdinal,
      })
    )
  })

  const frozenFacts = Object.freeze([...facts])
  const frozenBindings = Object.freeze([...rowBindings])
  const rowsCanonicalJson = strictCanonicalJson(frozenBindings)
  const rowSetSha256 = sha256Utf8(rowsCanonicalJson)
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
    row_set_sha256: rowSetSha256,
    rows_canonical_json: rowsCanonicalJson,
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
    contract: VERIFIED_POSITION_HISTORY_PUBLICATION_CONTRACT,
    observedAt,
    parserContract: contract.parserContract,
    previousPublicationId,
    publicationSha256,
    rawObjectId,
    rowBindings: frozenBindings,
    rows: frozenFacts,
    rowSetSha256,
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
