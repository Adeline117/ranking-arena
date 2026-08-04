import { dedupeHash as binanceDedupeHash, parseBinanceHistory } from './adapters/binance/parsers'
import { binancePositionHistoryTerminalVerifier } from './adapters/binance/history-terminal'
import { dedupeHash as bitgetDedupeHash, parseBitgetHistory } from './adapters/bitget/parsers'
import { bitgetPositionHistoryTerminalVerifier } from './adapters/bitget/history-terminal'
import { dedupeHash as okxDedupeHash, parseOkxHistory } from './adapters/okx/parsers'
import { okxPositionHistoryTerminalVerifier } from './adapters/okx/history-terminal'
import { parsedPositionHistoryRowSchema } from './core/schemas'
import type {
  ParseCtx,
  ParsedHistoryRow,
  ParsedPositionHistoryFieldSources,
  ParsedPositionHistoryRow,
  RawPage,
} from './core/types'
import {
  HISTORY_TERMINAL_CLAIM_CONTRACT,
  historyAcquisitionSourceRunId,
  parseHistoryAcquisitionArtifact,
  type HistoryAcquisitionArtifact,
  type SelectedHistoryTerminalVerifier,
} from './history-acquisition'
import {
  canonicalPositionHistoryCandidateValues,
  canonicalPositionHistoryText,
  canonicalPositionHistoryTimestamp,
  POSITION_HISTORY_TEXT_LIMITS,
} from './position-history-publication-values'
import {
  STRICT_CANONICAL_JSON_CONTRACT,
  strictCanonicalJson,
  strictCanonicalSha256,
} from './strict-canonical-json'

export const POSITION_HISTORY_PUBLICATION_EVIDENCE_CONTRACT =
  'arena.position-history-publication-evidence@1' as const

export const BINANCE_POSITION_HISTORY_SOURCE_CONTRACT =
  'arena.ingest.position-history-source.binance_futures@1' as const
export const BITGET_POSITION_HISTORY_SOURCE_CONTRACT =
  'arena.ingest.position-history-source.bitget_futures@1' as const
export const OKX_POSITION_HISTORY_SOURCE_CONTRACT =
  'arena.ingest.position-history-source.okx_futures@1' as const

export const BINANCE_POSITION_HISTORY_PARSER_CONTRACT =
  'arena.ingest.position-history-parser.binance@1' as const
export const BITGET_POSITION_HISTORY_PARSER_CONTRACT =
  'arena.ingest.position-history-parser.bitget@1' as const
export const OKX_POSITION_HISTORY_PARSER_CONTRACT =
  'arena.ingest.position-history-parser.okx@1' as const

export type ReviewedPositionHistorySourceSlug = 'binance_futures' | 'bitget_futures' | 'okx_futures'
export type ReviewedPositionHistoryAdapterSlug = 'binance' | 'bitget' | 'okx'
export type ReviewedPositionHistorySourceContract =
  | typeof BINANCE_POSITION_HISTORY_SOURCE_CONTRACT
  | typeof BITGET_POSITION_HISTORY_SOURCE_CONTRACT
  | typeof OKX_POSITION_HISTORY_SOURCE_CONTRACT
export type ReviewedPositionHistoryParserContract =
  | typeof BINANCE_POSITION_HISTORY_PARSER_CONTRACT
  | typeof BITGET_POSITION_HISTORY_PARSER_CONTRACT
  | typeof OKX_POSITION_HISTORY_PARSER_CONTRACT

type PositionHistoryClaimField = keyof ParsedPositionHistoryFieldSources
export type ReviewedPositionHistoryFieldPathAllowlist = Readonly<
  Partial<Record<PositionHistoryClaimField, readonly (readonly string[])[]>>
>

export interface ReviewedPositionHistoryContract {
  readonly adapterSlug: ReviewedPositionHistoryAdapterSlug
  readonly expectedCurrency: 'USDT'
  readonly fieldPaths: ReviewedPositionHistoryFieldPathAllowlist
  readonly pageSize: number
  readonly parser: (raw: unknown, kind: 'position_history', ctx: ParseCtx) => ParsedHistoryRow[]
  readonly parserContract: ReviewedPositionHistoryParserContract
  readonly servingReturnScale: 1 | 100
  readonly sourceContract: ReviewedPositionHistorySourceContract
  readonly sourceSlug: ReviewedPositionHistorySourceSlug
  readonly verifier: SelectedHistoryTerminalVerifier
}

const BINANCE_FIELD_PATHS: ReviewedPositionHistoryFieldPathAllowlist = Object.freeze({
  sourceFactId: [
    [
      'portfolioId',
      'response.data.list[].id',
      'response.data.list[].symbol',
      'response.data.list[].side',
    ],
  ],
  sourceLifecycleMarker: [['response.data.list[].status']],
  sourceReturn: [['response.data.list[].roi']],
  openedAt: [['response.data.list[].opened']],
  closedAt: [['response.data.list[].closed']],
  symbol: [['response.data.list[].symbol']],
  side: [['response.data.list[].side']],
  leverage: [['response.data.list[].leverage']],
  size: [['response.data.list[].closedVolume']],
  entryPrice: [['response.data.list[].avgCost']],
  exitPrice: [['response.data.list[].avgClosePrice']],
  realizedPnl: [['response.data.list[].closingPnl']],
})

const BITGET_FIELD_PATHS: ReviewedPositionHistoryFieldPathAllowlist = Object.freeze({
  sourceFactId: [['data.rows[].orderNo']],
  sourceLifecycleMarker: [['data.rows[].closeTime']],
  sourceReturn: [['data.rows[].returnRate']],
  openedAt: [['data.rows[].openTime']],
  closedAt: [['data.rows[].closeTime']],
  symbol: [
    ['data.rows[].symbolDisplayName'],
    ['data.rows[].productCode'],
    ['data.rows[].symbolId'],
  ],
  side: [['data.rows[].position'], ['data.rows[].holdSide']],
  leverage: [['data.rows[].openLevel']],
  size: [['data.rows[].closeDealCount'], ['data.rows[].openDealCount']],
  entryPrice: [['data.rows[].openAvgPrice']],
  exitPrice: [['data.rows[].closeAvgPrice']],
  realizedPnl: [['data.rows[].netProfit']],
})

const OKX_FIELD_PATHS: ReviewedPositionHistoryFieldPathAllowlist = Object.freeze({
  sourceFactId: [['historyTraderIdentity', 'data[].subPosId']],
  sourceLifecycleMarker: [['data[].closeTime']],
  sourceReturn: [['data[].pnlRatio']],
  openedAt: [['data[].openTime']],
  closedAt: [['data[].closeTime']],
  symbol: [['data[].instId']],
  side: [['data[].posSide']],
  leverage: [['data[].lever']],
  size: [['data[].subPos']],
  entryPrice: [['data[].openAvgPx']],
  exitPrice: [['data[].closeAvgPx']],
  realizedPnl: [['data[].pnl']],
})

export const REVIEWED_POSITION_HISTORY_CONTRACTS: Readonly<
  Record<ReviewedPositionHistorySourceSlug, ReviewedPositionHistoryContract>
> = Object.freeze({
  binance_futures: Object.freeze({
    adapterSlug: 'binance',
    expectedCurrency: 'USDT',
    fieldPaths: BINANCE_FIELD_PATHS,
    pageSize: 50,
    parser: parseBinanceHistory,
    parserContract: BINANCE_POSITION_HISTORY_PARSER_CONTRACT,
    servingReturnScale: 100,
    sourceContract: BINANCE_POSITION_HISTORY_SOURCE_CONTRACT,
    sourceSlug: 'binance_futures',
    verifier: binancePositionHistoryTerminalVerifier,
  }),
  bitget_futures: Object.freeze({
    adapterSlug: 'bitget',
    expectedCurrency: 'USDT',
    fieldPaths: BITGET_FIELD_PATHS,
    pageSize: 20,
    parser: parseBitgetHistory,
    parserContract: BITGET_POSITION_HISTORY_PARSER_CONTRACT,
    servingReturnScale: 1,
    sourceContract: BITGET_POSITION_HISTORY_SOURCE_CONTRACT,
    sourceSlug: 'bitget_futures',
    verifier: bitgetPositionHistoryTerminalVerifier,
  }),
  okx_futures: Object.freeze({
    adapterSlug: 'okx',
    expectedCurrency: 'USDT',
    fieldPaths: OKX_FIELD_PATHS,
    pageSize: 100,
    parser: parseOkxHistory,
    parserContract: OKX_POSITION_HISTORY_PARSER_CONTRACT,
    servingReturnScale: 100,
    sourceContract: OKX_POSITION_HISTORY_SOURCE_CONTRACT,
    sourceSlug: 'okx_futures',
    verifier: okxPositionHistoryTerminalVerifier,
  }),
})

const MAX_EVIDENCE_CANDIDATES = 100_000
const MAX_ACQUISITION_PAGES = 100_000

export type ReviewedPositionHistoryRejectionCode =
  | 'reviewed_contract_rejected'
  | 'source_candidate_accounting_failed'
  | 'source_container_invalid'
  | 'source_not_reviewed'
  | 'source_page_bound_exceeded'
  | 'terminal_evidence_not_verified'

class ReviewedPositionHistoryContractError extends Error {
  readonly rejectionCode: ReviewedPositionHistoryRejectionCode

  constructor(detail: string, rejectionCode: ReviewedPositionHistoryRejectionCode) {
    super(`[reviewed-position-history] ${detail}`)
    this.name = 'ReviewedPositionHistoryContractError'
    this.rejectionCode = rejectionCode
  }
}

function contractError(
  detail: string,
  rejectionCode: ReviewedPositionHistoryRejectionCode = 'reviewed_contract_rejected'
): Error {
  return new ReviewedPositionHistoryContractError(detail, rejectionCode)
}

export function reviewedPositionHistoryRejectionCode(
  cause: unknown
): ReviewedPositionHistoryRejectionCode | null {
  return cause instanceof ReviewedPositionHistoryContractError ? cause.rejectionCode : null
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  )
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

/** PostgreSQL jsonb cannot represent U+0000 or unpaired UTF-16 surrogates. */
export function assertPostgresJsonbTextCompatible(value: unknown, label: string): void {
  function isIncompatibleText(text: string): boolean {
    if (text.includes('\0')) return true
    for (let index = 0; index < text.length; index += 1) {
      const codeUnit = text.charCodeAt(index)
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const next = text.charCodeAt(index + 1)
        if (next >= 0xdc00 && next <= 0xdfff) index += 1
        else return true
      } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        return true
      }
    }
    return false
  }

  const pending: unknown[] = [value]
  const visited = new Set<object>()

  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current === 'string') {
      if (isIncompatibleText(current)) {
        throw contractError(`${label} contains text that PostgreSQL JSONB cannot represent`)
      }
      continue
    }
    if (current === null || typeof current !== 'object' || visited.has(current)) continue
    visited.add(current)

    for (const key of Reflect.ownKeys(current)) {
      if (typeof key === 'string' && isIncompatibleText(key)) {
        throw contractError(`${label} contains an object key PostgreSQL JSONB cannot represent`)
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor && 'value' in descriptor) pending.push(descriptor.value)
    }
  }
}

function assertReviewedPositionHistoryCurrency(
  contract: ReviewedPositionHistoryContract,
  row: ParsedPositionHistoryRow
): void {
  const rawCurrency =
    contract.sourceSlug === 'bitget_futures'
      ? row.raw.tokenId
      : contract.sourceSlug === 'okx_futures'
        ? row.raw.ccy
        : contract.expectedCurrency
  if (rawCurrency !== contract.expectedCurrency) {
    throw contractError(
      `${contract.sourceSlug} canonical row currency must be exact ${contract.expectedCurrency}`
    )
  }
}

function canonicalText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw contractError(`${label} must be non-empty canonical text`)
  }
  return value
}

function reviewedSourceIdentity(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.length > 0 && value === value.trim() ? value : null
  }
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null
}

function reviewedSourceMarker(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim()
    return normalized.length > 0 ? normalized : null
  }
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : null
}

function assertUnambiguousReviewedDedupeComponents(
  sourceSlug: ReviewedPositionHistorySourceSlug,
  components: readonly string[]
): void {
  if (components.some((component) => component.includes('|'))) {
    throw contractError(
      `${sourceSlug} reviewed dedupe identity components must not contain the legacy delimiter`
    )
  }
}

export function reviewedPositionHistoryContract(
  sourceSlug: string,
  adapterSlug?: string
): ReviewedPositionHistoryContract {
  const canonicalSourceSlug = canonicalText(sourceSlug, 'source slug')
  const contract =
    REVIEWED_POSITION_HISTORY_CONTRACTS[canonicalSourceSlug as ReviewedPositionHistorySourceSlug]
  if (!contract) {
    throw contractError(`source ${canonicalSourceSlug} is not reviewed`, 'source_not_reviewed')
  }
  if (adapterSlug !== undefined && adapterSlug !== contract.adapterSlug) {
    throw contractError(
      `source ${canonicalSourceSlug} adapter ${adapterSlug} does not match ${contract.adapterSlug}`
    )
  }
  return contract
}

export function assertReviewedPositionHistoryFieldSources(
  contract: ReviewedPositionHistoryContract,
  row: ParsedPositionHistoryRow
): void {
  if (row.fieldSources === undefined) {
    throw contractError('publishable row is missing reviewed field sources')
  }
  for (const field of Object.keys(row.fieldSources) as PositionHistoryClaimField[]) {
    const source = row.fieldSources[field]
    if (source === undefined) continue
    const allowedPaths = contract.fieldPaths[field]
    if (
      allowedPaths === undefined ||
      !allowedPaths.some((paths) => sameStrings(source.fieldPaths, paths))
    ) {
      throw contractError(`${contract.sourceSlug} ${field} field source is not exactly reviewed`)
    }
  }
}

export interface ReviewedPositionHistoryFactIdentity {
  readonly dedupeHash: string
  readonly sourceFactId: string
}

export function reviewedPositionHistoryFactIdentity(
  contract: ReviewedPositionHistoryContract,
  row: ParsedPositionHistoryRow,
  pagePayload: unknown
): ReviewedPositionHistoryFactIdentity {
  const claimedSourceFactId = canonicalText(row.sourceFactId, 'sourceFactId')
  let sourceFactId: string | null = null
  let dedupeHash: string | null = null

  if (contract.sourceSlug === 'binance_futures') {
    const payload = isPlainRecord(pagePayload) ? pagePayload : {}
    const portfolioId = reviewedSourceIdentity(payload.portfolioId)
    const rowId = reviewedSourceIdentity(row.raw.id)
    const symbol = row.raw.symbol ? String(row.raw.symbol) : null
    const side = reviewedSourceMarker(row.raw.side)
    if (portfolioId !== null && rowId !== null && symbol !== null && side !== null) {
      assertUnambiguousReviewedDedupeComponents(contract.sourceSlug, [
        portfolioId,
        rowId,
        symbol,
        side,
      ])
      sourceFactId = JSON.stringify([portfolioId, rowId, symbol, side])
      dedupeHash = binanceDedupeHash('binance_ph', portfolioId, rowId, symbol, side)
    }
  } else if (contract.sourceSlug === 'bitget_futures') {
    sourceFactId = reviewedSourceIdentity(row.raw.orderNo)
    if (sourceFactId !== null) dedupeHash = bitgetDedupeHash('bitget_ph', sourceFactId)
  } else {
    const payload = isPlainRecord(pagePayload) ? pagePayload : {}
    const traderIdentity = reviewedSourceIdentity(payload.historyTraderIdentity)
    const subPositionId = reviewedSourceIdentity(row.raw.subPosId)
    if (traderIdentity !== null && subPositionId !== null) {
      assertUnambiguousReviewedDedupeComponents(contract.sourceSlug, [
        traderIdentity,
        subPositionId,
      ])
      sourceFactId = JSON.stringify([traderIdentity, subPositionId])
      dedupeHash = okxDedupeHash('okx_ph', traderIdentity, subPositionId)
    }
  }

  if (sourceFactId === null || dedupeHash === null) {
    throw contractError(`${contract.sourceSlug} row has no reviewed source fact identity`)
  }
  if (claimedSourceFactId !== sourceFactId) {
    throw contractError(`${contract.sourceSlug} sourceFactId does not match reviewed RAW identity`)
  }
  if (row.dedupeHash !== dedupeHash) {
    throw contractError(
      `${contract.sourceSlug} dedupeHash does not match the reviewed parser formula`
    )
  }
  return Object.freeze({ dedupeHash, sourceFactId })
}

function requiredSourceRows(
  value: unknown,
  contract: ReviewedPositionHistoryContract,
  pageOrdinal: number,
  label: string
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || !value.every(isPlainRecord)) {
    throw contractError(`${label} is not an exact source row container`, 'source_container_invalid')
  }
  if (value.length > contract.pageSize) {
    throw contractError(
      `${contract.sourceSlug} page ${pageOrdinal} exceeds reviewed page size ${contract.pageSize}`,
      'source_page_bound_exceeded'
    )
  }
  return value
}

export function reviewedPositionHistorySourceRows(
  contract: ReviewedPositionHistoryContract,
  pagePayload: unknown,
  pageOrdinal: number
): readonly Readonly<Record<string, unknown>>[] {
  const payload = isPlainRecord(pagePayload) ? pagePayload : {}
  if (contract.sourceSlug === 'binance_futures') {
    const response = isPlainRecord(payload.response) ? payload.response : {}
    const data = isPlainRecord(response.data) ? response.data : {}
    return requiredSourceRows(
      data.list,
      contract,
      pageOrdinal,
      `Binance page ${pageOrdinal} response.data.list`
    )
  }
  if (contract.sourceSlug === 'bitget_futures') {
    const response = isPlainRecord(payload.response) ? payload.response : {}
    const data = isPlainRecord(response.data) ? response.data : {}
    return requiredSourceRows(
      data.rows,
      contract,
      pageOrdinal,
      `Bitget page ${pageOrdinal} response.data.rows`
    )
  }
  return requiredSourceRows(payload.data, contract, pageOrdinal, `OKX page ${pageOrdinal} data`)
}

function canonicalRawPages(artifact: HistoryAcquisitionArtifact): readonly Readonly<RawPage>[] {
  return Object.freeze(
    artifact.pages.map((page) =>
      Object.freeze({
        pageIndex: page.stored_page_index,
        url: page.url,
        fetchedAt: page.fetched_at,
        payload: page.payload,
      })
    )
  )
}

function assertReviewedTerminalEvidence(
  artifact: HistoryAcquisitionArtifact,
  contract: ReviewedPositionHistoryContract
): void {
  const termination = artifact.termination
  if (
    termination.evidence_state !== 'verified' ||
    termination.verifier_contract !== contract.verifier.contract ||
    termination.blocker_reasons.length !== 0 ||
    (termination.scan_terminal_state !== 'exhausted' &&
      termination.scan_terminal_state !== 'cursor_overlap')
  ) {
    throw contractError(
      'acquisition does not carry the exact reviewed terminal evidence',
      'terminal_evidence_not_verified'
    )
  }

  let verification: ReturnType<SelectedHistoryTerminalVerifier['verify']>
  try {
    verification = contract.verifier.verify({
      claim: {
        contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
        observations: termination.claim_observations,
      },
      pages: canonicalRawPages(artifact),
      cursor: artifact.starting_cursor,
      source: artifact.source,
      traderId: artifact.trader.id,
      exchangeTraderId: artifact.trader.exchange_trader_id,
      kind: 'position_history',
    })
  } catch (cause) {
    throw contractError(
      `reviewed terminal verifier failed: ${asError(cause).message}`,
      'terminal_evidence_not_verified'
    )
  }
  if (
    !verification.verified ||
    verification.scanTerminalState !== termination.scan_terminal_state
  ) {
    throw contractError(
      'reviewed terminal verifier does not reproduce the acquisition verdict',
      'terminal_evidence_not_verified'
    )
  }
  if (
    verification.scanTerminalState === 'cursor_overlap' &&
    verification.overlapEventAt !== termination.overlap_event_at
  ) {
    throw contractError(
      'reviewed terminal verifier does not reproduce the overlap event',
      'terminal_evidence_not_verified'
    )
  }
}

export type PositionHistoryPageClassification = 'canonical_materialized' | 'verifier_only'
export type PositionHistoryPageSegment = 'closing' | 'opening' | 'default'

export interface PositionHistorySourceRowManifest {
  readonly source_row_ordinal: number
  readonly source_row_sha256: string
}

export interface PositionHistoryPageManifest {
  readonly classification: PositionHistoryPageClassification
  readonly fetched_at: string
  readonly ordinal: number
  readonly payload_sha256: string
  readonly segment_id: PositionHistoryPageSegment
  readonly source_rows: readonly PositionHistorySourceRowManifest[]
  readonly stored_page_index: number
}

export interface ReviewedPositionHistoryCandidate {
  readonly pageOrdinal: number
  readonly row: ParsedPositionHistoryRow
  readonly sourceRowOrdinal: number
}

export interface ReviewedPositionHistoryEvidence {
  readonly artifact: HistoryAcquisitionArtifact
  readonly canonicalRows: readonly ReviewedPositionHistoryCandidate[]
  readonly contract: ReviewedPositionHistoryContract
  readonly observedAt: string
  readonly pageManifest: readonly PositionHistoryPageManifest[]
  readonly sourceRunId: string
}

function pageClassification(
  artifact: HistoryAcquisitionArtifact,
  contract: ReviewedPositionHistoryContract,
  pageOrdinal: number
): Pick<PositionHistoryPageManifest, 'classification' | 'segment_id'> {
  if (contract.sourceSlug !== 'binance_futures') {
    return { classification: 'canonical_materialized', segment_id: 'default' }
  }
  if (artifact.starting_cursor !== null) {
    return { classification: 'canonical_materialized', segment_id: 'closing' }
  }
  const closing = artifact.termination.claim_observations[0]
  if (closing?.segment_id !== 'closing') {
    throw contractError(
      'Binance full scan is missing its canonical CLOSING segment',
      'terminal_evidence_not_verified'
    )
  }
  return pageOrdinal <= closing.page_ordinal
    ? { classification: 'canonical_materialized', segment_id: 'closing' }
    : { classification: 'verifier_only', segment_id: 'opening' }
}

type ParsedPositionHistorySchemaOutput = ReturnType<typeof parsedPositionHistoryRowSchema.parse>

function hasNonEmptyFieldSourcePaths(
  row: ParsedPositionHistorySchemaOutput
): row is ParsedPositionHistorySchemaOutput & ParsedPositionHistoryRow {
  if (row.fieldSources === undefined) return true
  return Object.values(row.fieldSources).every(
    (source) => source === undefined || source.fieldPaths.length > 0
  )
}

export function buildReviewedPositionHistoryEvidence(
  rawArtifact: unknown,
  sourceRunId: string
): ReviewedPositionHistoryEvidence {
  let artifact: HistoryAcquisitionArtifact
  try {
    artifact = parseHistoryAcquisitionArtifact(rawArtifact)
  } catch (cause) {
    throw contractError(`acquisition artifact is invalid: ${asError(cause).message}`)
  }
  if (artifact.history_kind !== 'position_history') {
    throw contractError('only position_history has a reviewed publication contract')
  }
  if (historyAcquisitionSourceRunId(artifact) !== sourceRunId) {
    throw contractError('source run id does not match the canonical acquisition artifact')
  }
  assertPostgresJsonbTextCompatible(artifact.trader.exchange_trader_id, 'exchange trader identity')
  if (artifact.pages.length === 0 || artifact.pages.length > MAX_ACQUISITION_PAGES) {
    throw contractError(
      'reviewed acquisition page count is outside the publication bound',
      'source_page_bound_exceeded'
    )
  }
  const contract = reviewedPositionHistoryContract(artifact.source.slug)
  canonicalPositionHistoryText(
    artifact.trader.exchange_trader_id,
    'exchange trader id',
    POSITION_HISTORY_TEXT_LIMITS.exchangeTraderId.minimum,
    POSITION_HISTORY_TEXT_LIMITS.exchangeTraderId.maximum,
    contractError
  )
  canonicalPositionHistoryTimestamp(
    artifact.attempt_started_at,
    'acquisition attempt startedAt',
    contractError
  )
  const observedAt = canonicalPositionHistoryTimestamp(
    artifact.pages.at(-1)!.fetched_at,
    'acquisition observedAt',
    contractError
  )
  for (const page of artifact.pages) {
    canonicalPositionHistoryTimestamp(
      page.fetched_at,
      `page ${page.ordinal} fetchedAt`,
      contractError
    )
  }
  if (artifact.starting_cursor !== null) {
    const startingCursor = canonicalPositionHistoryTimestamp(
      artifact.starting_cursor,
      'starting cursor',
      contractError
    )
    if (Date.parse(startingCursor) > Date.parse(observedAt)) {
      throw contractError('starting cursor must not follow acquisition observedAt')
    }
  }
  if (artifact.termination.terminal_cursor_value !== null) {
    canonicalPositionHistoryTimestamp(
      artifact.termination.terminal_cursor_value,
      'terminal cursor value',
      contractError
    )
  }
  if (artifact.termination.overlap_event_at !== null) {
    canonicalPositionHistoryTimestamp(
      artifact.termination.overlap_event_at,
      'terminal overlap event',
      contractError
    )
  }

  const pageRows = artifact.pages.map((page) =>
    reviewedPositionHistorySourceRows(contract, page.payload, page.ordinal)
  )
  let evidenceCandidateCount = 0
  for (const rows of pageRows) {
    evidenceCandidateCount += rows.length
    if (evidenceCandidateCount > MAX_EVIDENCE_CANDIDATES) {
      throw contractError(
        'all-page evidence candidate count exceeds the publication bound',
        'source_page_bound_exceeded'
      )
    }
  }
  assertReviewedTerminalEvidence(artifact, contract)

  const canonicalRows: ReviewedPositionHistoryCandidate[] = []
  const pageManifest: PositionHistoryPageManifest[] = []
  artifact.pages.forEach((page, pageIndex) => {
    const sourceRows = pageRows[pageIndex]
    const classification = pageClassification(artifact, contract, page.ordinal)
    let parsedRows: ParsedHistoryRow[]
    try {
      parsedRows = contract.parser(page.payload, 'position_history', {
        sourceSlug: contract.sourceSlug,
        currency: contract.expectedCurrency,
        tfLabelMap: {},
        scrapedAt: page.fetched_at,
        meta: {},
      })
    } catch (cause) {
      throw contractError(
        `reviewed parser failed on page ${page.ordinal}: ${asError(cause).message}`
      )
    }
    if (parsedRows.length !== sourceRows.length) {
      throw contractError(
        `reviewed parser did not account for every source candidate on page ${page.ordinal}`,
        'source_candidate_accounting_failed'
      )
    }

    const sourceRowManifest: PositionHistorySourceRowManifest[] = []
    parsedRows.forEach((parsedRow, rowIndex) => {
      if (parsedRow.kind !== 'position_history') {
        throw contractError(`reviewed parser emitted a non-position row on page ${page.ordinal}`)
      }
      let row: ParsedPositionHistorySchemaOutput
      try {
        row = parsedPositionHistoryRowSchema.parse(parsedRow)
      } catch (cause) {
        throw contractError(
          `reviewed parser emitted an invalid row on page ${page.ordinal}: ${asError(cause).message}`
        )
      }
      if (!hasNonEmptyFieldSourcePaths(row)) {
        throw contractError(
          `reviewed parser emitted an empty field source path on page ${page.ordinal}`
        )
      }
      if (classification.classification === 'canonical_materialized') {
        assertPostgresJsonbTextCompatible(row, `canonical row on page ${page.ordinal}`)
      }
      assertReviewedPositionHistoryFieldSources(contract, row)
      if (strictCanonicalJson(row.raw) !== strictCanonicalJson(sourceRows[rowIndex])) {
        throw contractError(
          `reviewed parser changed source candidate order or RAW on page ${page.ordinal}`
        )
      }
      if (classification.classification === 'canonical_materialized') {
        canonicalPositionHistoryCandidateValues(
          contract.sourceSlug,
          contract.servingReturnScale,
          row,
          page.fetched_at,
          observedAt,
          contractError
        )
        reviewedPositionHistoryFactIdentity(contract, row, page.payload)
        assertReviewedPositionHistoryCurrency(contract, row)
      }
      const sourceRowOrdinal = rowIndex + 1
      sourceRowManifest.push(
        deepFreezeJson({
          source_row_ordinal: sourceRowOrdinal,
          source_row_sha256: strictCanonicalSha256(row.raw),
        })
      )
      if (classification.classification === 'canonical_materialized') {
        canonicalRows.push(Object.freeze({ pageOrdinal: page.ordinal, row, sourceRowOrdinal }))
      }
    })

    pageManifest.push(
      deepFreezeJson({
        classification: classification.classification,
        fetched_at: page.fetched_at,
        ordinal: page.ordinal,
        payload_sha256: page.payload_sha256,
        segment_id: classification.segment_id,
        source_rows: sourceRowManifest,
        stored_page_index: page.stored_page_index,
      })
    )
  })

  return Object.freeze({
    artifact,
    canonicalRows: Object.freeze(canonicalRows),
    contract,
    observedAt,
    pageManifest: Object.freeze(pageManifest),
    sourceRunId,
  })
}

export interface PositionHistoryPublicationRawMetaBase {
  readonly attempt_started_at: string
  readonly capture_config: HistoryAcquisitionArtifact['capture_config']
  readonly data_contract: HistoryAcquisitionArtifact['contract']
  readonly exchange_trader_id: string
  readonly history_evidence_contract: typeof POSITION_HISTORY_PUBLICATION_EVIDENCE_CONTRACT
  readonly history_kind: 'position_history'
  readonly observed_at: string
  readonly page_count: number
  readonly page_manifest: readonly PositionHistoryPageManifest[]
  readonly parser_contract: ReviewedPositionHistoryParserContract
  readonly source_contract: ReviewedPositionHistorySourceContract
  readonly source_run_id: string
  readonly source_slug: ReviewedPositionHistorySourceSlug
  readonly starting_cursor: string | null
  readonly termination: HistoryAcquisitionArtifact['termination']
  readonly verifier_contract: string
}

export interface PositionHistoryPublicationRawMeta extends PositionHistoryPublicationRawMetaBase {
  readonly raw_integrity: Readonly<Record<string, unknown>>
}

export function positionHistoryPublicationRawMetaBase(
  evidence: ReviewedPositionHistoryEvidence
): PositionHistoryPublicationRawMetaBase {
  const { artifact, contract } = evidence
  return deepFreezeJson({
    attempt_started_at: artifact.attempt_started_at,
    capture_config: artifact.capture_config,
    data_contract: artifact.contract,
    exchange_trader_id: artifact.trader.exchange_trader_id,
    history_evidence_contract: POSITION_HISTORY_PUBLICATION_EVIDENCE_CONTRACT,
    history_kind: 'position_history' as const,
    observed_at: evidence.observedAt,
    page_count: artifact.pages.length,
    page_manifest: evidence.pageManifest,
    parser_contract: contract.parserContract,
    source_contract: contract.sourceContract,
    source_run_id: evidence.sourceRunId,
    source_slug: contract.sourceSlug,
    starting_cursor: artifact.starting_cursor,
    termination: artifact.termination,
    verifier_contract: contract.verifier.contract,
  })
}

export function positionHistoryPublicationRawMeta(
  evidence: ReviewedPositionHistoryEvidence,
  rawIntegrity: Readonly<Record<string, unknown>>
): PositionHistoryPublicationRawMeta {
  return positionHistoryPublicationRawMetaFromBase(
    positionHistoryPublicationRawMetaBase(evidence),
    rawIntegrity
  )
}

export function positionHistoryPublicationRawMetaFromBase(
  metaBase: PositionHistoryPublicationRawMetaBase,
  rawIntegrity: Readonly<Record<string, unknown>>
): PositionHistoryPublicationRawMeta {
  if (!isPlainRecord(rawIntegrity)) throw contractError('raw_integrity must be an exact object')
  return deepFreezeJson({
    ...metaBase,
    raw_integrity: rawIntegrity,
  })
}

export const POSITION_HISTORY_RAW_META_KEYS = Object.freeze([
  'attempt_started_at',
  'capture_config',
  'data_contract',
  'exchange_trader_id',
  'history_evidence_contract',
  'history_kind',
  'observed_at',
  'page_count',
  'page_manifest',
  'parser_contract',
  'raw_integrity',
  'source_contract',
  'source_run_id',
  'source_slug',
  'starting_cursor',
  'termination',
  'verifier_contract',
] as const)

export const POSITION_HISTORY_PAGE_MANIFEST_KEYS = Object.freeze([
  'classification',
  'fetched_at',
  'ordinal',
  'payload_sha256',
  'segment_id',
  'source_rows',
  'stored_page_index',
] as const)

export const POSITION_HISTORY_SOURCE_ROW_MANIFEST_KEYS = Object.freeze([
  'source_row_ordinal',
  'source_row_sha256',
] as const)

export { STRICT_CANONICAL_JSON_CONTRACT }
