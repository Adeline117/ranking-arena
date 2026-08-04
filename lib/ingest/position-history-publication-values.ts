import type { ParsedPositionHistoryLimitation, ParsedPositionHistoryRow } from './core/types'
import { isCanonicalPostgresTimestamp } from './postgres-timestamp'

export const POSITION_HISTORY_NUMERIC_STRING_MAX_LENGTH = 128

const POSITION_HISTORY_DECIMAL_NUMBER =
  /^[+-]?((([0-9]+)(\.[0-9]*)?)|(\.[0-9]+))([eE][+-]?[0-9]+)?$/

function decimalSignificandIsZero(value: string): boolean {
  const significand = value.split(/[eE]/, 1)[0].replace(/^[+-]/, '').replace('.', '')
  return /^[0]+$/.test(significand)
}

export const POSITION_HISTORY_TEXT_LIMITS = Object.freeze({
  dedupeHash: Object.freeze({ minimum: 1, maximum: 512 }),
  exchangeTraderId: Object.freeze({ minimum: 1, maximum: 512 }),
  side: Object.freeze({ minimum: 1, maximum: 64 }),
  sourceFactId: Object.freeze({ minimum: 1, maximum: 1024 }),
  sourceLifecycleMarker: Object.freeze({ minimum: 1, maximum: 256 }),
  sourceSlug: Object.freeze({ minimum: 1, maximum: 128 }),
  symbol: Object.freeze({ minimum: 1, maximum: 128 }),
})

export type PositionHistoryPublicationSourceSlug =
  | 'binance_futures'
  | 'bitget_futures'
  | 'okx_futures'

export type PositionHistoryPublicationValueErrorFactory = (detail: string) => Error

const FORBIDDEN_LIFECYCLE_LIMITATIONS = new Set<ParsedPositionHistoryLimitation>([
  'source_lifecycle_marker_missing',
  'source_lifecycle_marker_partial',
  'source_lifecycle_marker_unrecognized',
])

function fail(errorFactory: PositionHistoryPublicationValueErrorFactory, detail: string): never {
  throw errorFactory(detail)
}

function unicodeCodePointLength(value: string): number {
  let length = 0
  for (const _codePoint of value) length += 1
  return length
}

export function canonicalPositionHistoryTimestamp(
  value: unknown,
  label: string,
  errorFactory: PositionHistoryPublicationValueErrorFactory
): string {
  if (!isCanonicalPostgresTimestamp(value)) {
    return fail(errorFactory, `${label} must be a canonical millisecond UTC timestamp`)
  }
  return value
}

export function canonicalPositionHistoryText(
  value: unknown,
  label: string,
  minimumLength: number,
  maximumLength: number,
  errorFactory: PositionHistoryPublicationValueErrorFactory
): string {
  const length = typeof value === 'string' ? unicodeCodePointLength(value) : 0
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    length < minimumLength ||
    length > maximumLength
  ) {
    return fail(
      errorFactory,
      `${label} must be trimmed and contain ${minimumLength}-${maximumLength} characters`
    )
  }
  return value
}

export function nullablePositionHistoryFiniteNumber(
  value: unknown,
  label: string,
  errorFactory: PositionHistoryPublicationValueErrorFactory
): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) {
    return fail(errorFactory, `${label} must be null or a finite non-negative-zero JSON number`)
  }
  return value
}

function positionHistorySourceEpochMilliseconds(value: unknown): number | null {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    (typeof value === 'string' && (value.length === 0 || value.trim() !== value))
  ) {
    return null
  }
  const epochMs = Number(value)
  if (!Number.isSafeInteger(epochMs) || epochMs <= 0) return null
  try {
    new Date(epochMs).toISOString()
    return epochMs
  } catch {
    return null
  }
}

export function positionHistorySourceEpochTimestamp(value: unknown): string | null {
  const epochMs = positionHistorySourceEpochMilliseconds(value)
  return epochMs === null ? null : new Date(epochMs).toISOString()
}

function assertConsumedNumericScalar(
  rawValue: unknown,
  sourceSlug: PositionHistoryPublicationSourceSlug,
  rawField: string,
  errorFactory: PositionHistoryPublicationValueErrorFactory
): void {
  if (typeof rawValue !== 'string') return
  // Classify the RAW string independently from the parsed fact. A parser can
  // collapse a forbidden JavaScript spelling to null (for example a radix
  // side outside 1/2, a non-positive epoch, or a non-finite decimal).
  if (unicodeCodePointLength(rawValue) > POSITION_HISTORY_NUMERIC_STRING_MAX_LENGTH) {
    fail(
      errorFactory,
      `${sourceSlug} numeric string ${rawField} exceeds ${POSITION_HISTORY_NUMERIC_STRING_MAX_LENGTH} characters`
    )
  }
  if (rawValue.trim().length === 0) return
  if (rawValue !== rawValue.trim()) {
    fail(
      errorFactory,
      `${sourceSlug} consumed numeric string ${rawField} must not have edge whitespace`
    )
  }
  if (
    /^0[xX][0-9a-fA-F]+$/.test(rawValue) ||
    /^0[oO][0-7]+$/.test(rawValue) ||
    /^0[bB][01]+$/.test(rawValue)
  ) {
    fail(
      errorFactory,
      `${sourceSlug} consumed numeric string ${rawField} must use decimal or exponent syntax`
    )
  }
  if (!POSITION_HISTORY_DECIMAL_NUMBER.test(rawValue)) {
    return
  }
  const parsedNumber = Number(rawValue)
  const significandIsZero = decimalSignificandIsZero(rawValue)
  if (rawValue.startsWith('-') && significandIsZero) {
    fail(
      errorFactory,
      `${sourceSlug} consumed numeric string ${rawField} must not be negative zero`
    )
  }
  if (parsedNumber === 0 && !significandIsZero) {
    fail(
      errorFactory,
      `${sourceSlug} consumed numeric string ${rawField} must not underflow a nonzero decimal to zero`
    )
  }
}

function assertCanonicalConsumedNumericScalars(
  sourceSlug: PositionHistoryPublicationSourceSlug,
  row: ParsedPositionHistoryRow,
  errorFactory: PositionHistoryPublicationValueErrorFactory
): void {
  const raw = row.raw
  const common: ReadonlyArray<readonly [unknown, string]> =
    sourceSlug === 'binance_futures'
      ? [
          [raw.opened, 'opened'],
          [raw.closed, 'closed'],
          [raw.leverage, 'leverage'],
          [raw.closedVolume, 'closedVolume'],
          [raw.avgCost, 'avgCost'],
          [raw.avgClosePrice, 'avgClosePrice'],
          [raw.closingPnl, 'closingPnl'],
          [raw.roi, 'roi'],
        ]
      : sourceSlug === 'bitget_futures'
        ? [
            [raw.openTime, 'openTime'],
            [raw.closeTime, 'closeTime'],
            [raw.position ?? raw.holdSide, raw.position != null ? 'position' : 'holdSide'],
            [raw.openLevel, 'openLevel'],
            [
              raw.closeDealCount ?? raw.openDealCount,
              raw.closeDealCount != null ? 'closeDealCount' : 'openDealCount',
            ],
            [raw.openAvgPrice, 'openAvgPrice'],
            [raw.closeAvgPrice, 'closeAvgPrice'],
            [raw.netProfit, 'netProfit'],
            [raw.returnRate, 'returnRate'],
          ]
        : [
            [raw.openTime, 'openTime'],
            [raw.closeTime, 'closeTime'],
            [raw.lever, 'lever'],
            [raw.subPos, 'subPos'],
            [raw.openAvgPx, 'openAvgPx'],
            [raw.closeAvgPx, 'closeAvgPx'],
            [raw.pnl, 'pnl'],
            [raw.pnlRatio, 'pnlRatio'],
          ]

  for (const [rawValue, rawField] of common) {
    assertConsumedNumericScalar(rawValue, sourceSlug, rawField, errorFactory)
  }
}

function assertRawSymbolContract(
  sourceSlug: PositionHistoryPublicationSourceSlug,
  row: ParsedPositionHistoryRow,
  symbol: string,
  errorFactory: PositionHistoryPublicationValueErrorFactory
): void {
  const raw = row.raw
  const rawSymbol =
    sourceSlug === 'binance_futures'
      ? raw.symbol
      : sourceSlug === 'bitget_futures'
        ? (raw.symbolDisplayName ?? raw.productCode ?? raw.symbolId)
        : raw.instId
  if (typeof rawSymbol !== 'string' || rawSymbol !== symbol) {
    fail(errorFactory, `${sourceSlug} symbol does not match the exact reviewed RAW string`)
  }
}

function assertRawSideContract(
  sourceSlug: PositionHistoryPublicationSourceSlug,
  row: ParsedPositionHistoryRow,
  errorFactory: PositionHistoryPublicationValueErrorFactory
): void {
  // The reviewed endpoint exposes only these exact labels. Keeping the source
  // domain closed also avoids JavaScript/PostgreSQL case-folding drift.
  if (sourceSlug === 'binance_futures' && row.raw.side !== 'Long' && row.raw.side !== 'Short') {
    fail(errorFactory, 'binance_futures side must be exact Long or Short')
  }
}

function assertRawTimestampContract(
  sourceSlug: PositionHistoryPublicationSourceSlug,
  row: ParsedPositionHistoryRow,
  openedAt: string | null,
  closedAt: string,
  errorFactory: PositionHistoryPublicationValueErrorFactory
): void {
  const rawOpened = sourceSlug === 'binance_futures' ? row.raw.opened : row.raw.openTime
  const rawClosed = sourceSlug === 'binance_futures' ? row.raw.closed : row.raw.closeTime
  if (positionHistorySourceEpochTimestamp(rawOpened) !== openedAt) {
    fail(
      errorFactory,
      `${sourceSlug} opened timestamp must match a positive safe-integer RAW epoch`
    )
  }
  if (positionHistorySourceEpochTimestamp(rawClosed) !== closedAt) {
    fail(
      errorFactory,
      `${sourceSlug} closed timestamp must match a positive safe-integer RAW epoch`
    )
  }
}

function assertBinanceSourceIdentityContract(
  sourceSlug: PositionHistoryPublicationSourceSlug,
  row: ParsedPositionHistoryRow,
  errorFactory: PositionHistoryPublicationValueErrorFactory
): void {
  if (sourceSlug !== 'binance_futures') return
  if (
    typeof row.raw.id !== 'number' ||
    typeof row.raw.opened !== 'number' ||
    !Number.isSafeInteger(row.raw.id) ||
    row.raw.id <= 0 ||
    row.raw.id !== row.raw.opened
  ) {
    fail(
      errorFactory,
      'binance_futures id and opened must be equal positive safe-integer JSON numbers'
    )
  }
}

function assertClosedLifecycle(
  sourceSlug: PositionHistoryPublicationSourceSlug,
  row: ParsedPositionHistoryRow,
  lifecycle: string,
  closedAt: string,
  errorFactory: PositionHistoryPublicationValueErrorFactory
): void {
  const limitations = row.limitations ?? []
  if (limitations.some((limitation) => FORBIDDEN_LIFECYCLE_LIMITATIONS.has(limitation))) {
    fail(errorFactory, 'partial, missing, or unrecognized lifecycle evidence is not publishable')
  }

  if (sourceSlug === 'binance_futures') {
    if (lifecycle !== 'All Closed' || row.raw.status !== 'All Closed') {
      fail(errorFactory, 'Binance publication requires an exact All Closed source marker')
    }
    if (positionHistorySourceEpochTimestamp(row.raw.closed) !== closedAt) {
      fail(errorFactory, 'Binance closed timestamp does not match the reviewed RAW field')
    }
    return
  }

  const rawCloseTime = row.raw.closeTime
  if (
    positionHistorySourceEpochTimestamp(rawCloseTime) !== closedAt ||
    lifecycle !== String(rawCloseTime)
  ) {
    fail(errorFactory, `${sourceSlug} lifecycle does not match the reviewed RAW closeTime`)
  }
}

export interface CanonicalPositionHistoryCandidateValues {
  readonly closedAt: string
  readonly dedupeHash: string
  readonly entryPrice: number | null
  readonly exitPrice: number | null
  readonly leverage: number | null
  readonly openedAt: string | null
  readonly realizedPnl: number | null
  readonly side: string | null
  readonly size: number | null
  readonly sourceFactId: string
  readonly sourceLifecycleMarker: string
  readonly sourceReturn: number | null
  readonly symbol: string
}

export function canonicalPositionHistoryCandidateValues(
  sourceSlug: PositionHistoryPublicationSourceSlug,
  servingReturnScale: 1 | 100,
  row: ParsedPositionHistoryRow,
  pageFetchedAtValue: unknown,
  observedAtValue: unknown,
  errorFactory: PositionHistoryPublicationValueErrorFactory
): CanonicalPositionHistoryCandidateValues {
  const openedAt =
    row.openedAt === null
      ? null
      : canonicalPositionHistoryTimestamp(row.openedAt, 'openedAt', errorFactory)
  const closedAt = canonicalPositionHistoryTimestamp(row.closedAt, 'closedAt', errorFactory)
  const pageFetchedAt = canonicalPositionHistoryTimestamp(
    pageFetchedAtValue,
    'bound page fetchedAt',
    errorFactory
  )
  const observedAt = canonicalPositionHistoryTimestamp(
    observedAtValue,
    'acquisition observedAt',
    errorFactory
  )
  if (openedAt !== null && Date.parse(openedAt) > Date.parse(closedAt)) {
    fail(errorFactory, 'openedAt must not follow closedAt')
  }
  if (Date.parse(closedAt) > Date.parse(pageFetchedAt)) {
    fail(errorFactory, 'closedAt must not follow its bound page fetchedAt')
  }
  if (Date.parse(closedAt) > Date.parse(observedAt)) {
    fail(errorFactory, 'closedAt must not follow acquisition observedAt')
  }

  const symbol = canonicalPositionHistoryText(
    row.symbol,
    'symbol',
    POSITION_HISTORY_TEXT_LIMITS.symbol.minimum,
    POSITION_HISTORY_TEXT_LIMITS.symbol.maximum,
    errorFactory
  )
  const side =
    row.side === null
      ? null
      : canonicalPositionHistoryText(
          row.side,
          'side',
          POSITION_HISTORY_TEXT_LIMITS.side.minimum,
          POSITION_HISTORY_TEXT_LIMITS.side.maximum,
          errorFactory
        )
  const dedupeHash = canonicalPositionHistoryText(
    row.dedupeHash,
    'dedupeHash',
    POSITION_HISTORY_TEXT_LIMITS.dedupeHash.minimum,
    POSITION_HISTORY_TEXT_LIMITS.dedupeHash.maximum,
    errorFactory
  )
  const sourceFactId = canonicalPositionHistoryText(
    row.sourceFactId,
    'sourceFactId',
    POSITION_HISTORY_TEXT_LIMITS.sourceFactId.minimum,
    POSITION_HISTORY_TEXT_LIMITS.sourceFactId.maximum,
    errorFactory
  )
  const sourceLifecycleMarker = canonicalPositionHistoryText(
    row.sourceLifecycleMarker,
    'sourceLifecycleMarker',
    POSITION_HISTORY_TEXT_LIMITS.sourceLifecycleMarker.minimum,
    POSITION_HISTORY_TEXT_LIMITS.sourceLifecycleMarker.maximum,
    errorFactory
  )

  assertRawSymbolContract(sourceSlug, row, symbol, errorFactory)
  assertRawSideContract(sourceSlug, row, errorFactory)
  assertCanonicalConsumedNumericScalars(sourceSlug, row, errorFactory)
  assertRawTimestampContract(sourceSlug, row, openedAt, closedAt, errorFactory)
  assertBinanceSourceIdentityContract(sourceSlug, row, errorFactory)
  assertClosedLifecycle(sourceSlug, row, sourceLifecycleMarker, closedAt, errorFactory)

  const sourceReturn = nullablePositionHistoryFiniteNumber(
    row.sourceReturn ?? null,
    'sourceReturn',
    errorFactory
  )
  if (sourceReturn !== null && !Number.isFinite(sourceReturn * servingReturnScale)) {
    fail(errorFactory, 'sourceReturn must remain finite after applying the serving return scale')
  }

  return Object.freeze({
    closedAt,
    dedupeHash,
    entryPrice: nullablePositionHistoryFiniteNumber(row.entryPrice, 'entryPrice', errorFactory),
    exitPrice: nullablePositionHistoryFiniteNumber(row.exitPrice, 'exitPrice', errorFactory),
    leverage: nullablePositionHistoryFiniteNumber(row.leverage, 'leverage', errorFactory),
    openedAt,
    realizedPnl: nullablePositionHistoryFiniteNumber(row.realizedPnl, 'realizedPnl', errorFactory),
    side,
    size: nullablePositionHistoryFiniteNumber(row.size, 'size', errorFactory),
    sourceFactId,
    sourceLifecycleMarker,
    sourceReturn,
    symbol,
  })
}
