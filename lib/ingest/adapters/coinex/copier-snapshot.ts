import type {
  CopierSnapshotVerificationInput,
  SelectedCopierSnapshotVerifier,
} from '../../core/adapter'
import type { HistoryTerminalVerificationInput } from '../../history-acquisition'
import { isCanonicalPostgresTimestamp } from '../../postgres-timestamp'
import { dedupeHash } from './parsers'

export const COINEX_COPIER_SNAPSHOT_VERIFIER_CONTRACT =
  'arena.ingest.history-terminal-verifier.coinex.copiers@2' as const
export const COINEX_COPIER_HISTORY_URL =
  'https://www.coinex.com/res/copy-trading/public/followers' as const
export const COINEX_COPIER_PAGE_SIZE = 10 as const

const ENVELOPE_FIELDS = ['code', 'data', 'message'] as const
const DATA_FIELDS = ['count', 'curr_page', 'data', 'has_next', 'total', 'total_page'] as const
const COPIER_FIELDS = ['follower_name', 'fund_amount', 'total_copy_earn_amount'] as const

type Dict = Record<string, unknown>

export interface ValidatedCoinexCopierPage {
  rows: Dict[]
  total: number
  totalPages: number
}

interface CoinexCopierProjection {
  identity: string
  label: string
  pnl: number
  invested: number
}

function isRecord(value: unknown): value is Dict {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Dict, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  )
}

function canonicalLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function canonicalFiniteDecimal(value: unknown, allowNegative: boolean): value is string {
  if (typeof value !== 'string') return false
  const pattern = allowNegative
    ? /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/
    : /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/
  if (!pattern.test(value)) return false
  const parsed = Number(value)
  return Number.isFinite(parsed) && !Object.is(parsed, -0)
}

function coinexCopierProjection(value: unknown): CoinexCopierProjection | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, COPIER_FIELDS) ||
    !canonicalLabel(value.follower_name) ||
    !canonicalFiniteDecimal(value.fund_amount, false) ||
    !canonicalFiniteDecimal(value.total_copy_earn_amount, true)
  ) {
    return null
  }

  return {
    identity: value.follower_name,
    label: value.follower_name,
    pnl: Number(value.total_copy_earn_amount),
    invested: Number(value.fund_amount),
  }
}

export function coinexCopierHistoryUrl(exchangeTraderId: string, page: number): string {
  if (
    exchangeTraderId.length === 0 ||
    exchangeTraderId.trim() !== exchangeTraderId ||
    !Number.isSafeInteger(page) ||
    page <= 0 ||
    Object.is(page, -0)
  ) {
    throw new TypeError('[coinex] copier request coordinates are invalid')
  }
  return (
    `${COINEX_COPIER_HISTORY_URL}?trader_id=${encodeURIComponent(exchangeTraderId)}` +
    `&page=${page}&limit=${COINEX_COPIER_PAGE_SIZE}`
  )
}

export function validateCoinexCopierPage(
  value: unknown,
  expectedPage: number
): ValidatedCoinexCopierPage | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ENVELOPE_FIELDS) ||
    value.code !== 0 ||
    value.message !== 'Success' ||
    !isRecord(value.data) ||
    !exactKeys(value.data, DATA_FIELDS)
  ) {
    return null
  }

  const page = value.data
  if (
    !nonNegativeSafeInteger(page.curr_page) ||
    page.curr_page !== expectedPage ||
    !nonNegativeSafeInteger(page.count) ||
    !nonNegativeSafeInteger(page.total) ||
    !nonNegativeSafeInteger(page.total_page) ||
    typeof page.has_next !== 'boolean' ||
    !Array.isArray(page.data) ||
    !page.data.every(isRecord) ||
    page.count !== page.data.length
  ) {
    return null
  }

  const total = page.total
  const totalPages = Math.ceil(total / COINEX_COPIER_PAGE_SIZE)
  const expectedRows = Math.min(
    COINEX_COPIER_PAGE_SIZE,
    Math.max(total - (expectedPage - 1) * COINEX_COPIER_PAGE_SIZE, 0)
  )
  if (
    page.total_page !== totalPages ||
    page.data.length !== expectedRows ||
    page.has_next !== expectedPage < totalPages ||
    (total > 0 && (expectedPage < 1 || expectedPage > totalPages)) ||
    (total === 0 && expectedPage !== 1)
  ) {
    return null
  }

  const identities = new Set<string>()
  for (const row of page.data) {
    const projection = coinexCopierProjection(row)
    if (projection === null || identities.has(projection.identity)) return null
    identities.add(projection.identity)
  }

  return { rows: page.data, total, totalPages }
}

function validatePages(
  pages: readonly Readonly<HistoryTerminalVerificationInput['pages'][number]>[],
  exchangeTraderId: string
): ValidatedCoinexCopierPage[] | null {
  if (pages.length === 0) return null

  const validated: ValidatedCoinexCopierPage[] = []
  const identities = new Set<string>()
  let stableTotal: number | null = null
  let stableTotalPages: number | null = null

  for (const [index, page] of pages.entries()) {
    const pageNumber = index + 1
    if (
      page.pageIndex !== pageNumber ||
      page.url !== coinexCopierHistoryUrl(exchangeTraderId, pageNumber)
    ) {
      return null
    }
    const parsed = validateCoinexCopierPage(page.payload, pageNumber)
    if (
      parsed === null ||
      (stableTotal !== null && parsed.total !== stableTotal) ||
      (stableTotalPages !== null && parsed.totalPages !== stableTotalPages)
    ) {
      return null
    }
    stableTotal ??= parsed.total
    stableTotalPages ??= parsed.totalPages

    for (const row of parsed.rows) {
      const projection = coinexCopierProjection(row)
      if (projection === null || identities.has(projection.identity)) return null
      identities.add(projection.identity)
    }
    validated.push(parsed)
  }

  if (stableTotal === null || stableTotalPages === null) return null
  const expectedPageCount = Math.max(1, stableTotalPages)
  return pages.length === expectedPageCount && identities.size === stableTotal ? validated : null
}

function verifyTerminal(input: HistoryTerminalVerificationInput) {
  if (
    input.source.slug !== 'coinex_futures' ||
    input.kind !== 'copiers' ||
    input.cursor !== null ||
    input.claim.observations.length !== 1
  ) {
    return { verified: false } as const
  }
  const observation = input.claim.observations[0]
  if (
    observation.segment_id !== 'default' ||
    observation.reason !== 'reported_end' ||
    observation.page_ordinal !== input.pages.length
  ) {
    return { verified: false } as const
  }

  return validatePages(input.pages, input.exchangeTraderId)
    ? ({ verified: true, scanTerminalState: 'exhausted' } as const)
    : ({ verified: false } as const)
}

function verifyConservation(input: CopierSnapshotVerificationInput) {
  const pages = validatePages(input.pages, input.exchangeTraderId)
  if (!pages) return { verified: false } as const
  const sourceRows = pages.flatMap((page) => page.rows)
  if (sourceRows.length !== input.rows.length) return { verified: false } as const

  // CoinEx exposes no follower event clock. Bind the complete snapshot to the
  // exact ParseCtx clock captured before acquisition.
  const parsedAt = input.parserClock
  const firstFetchedAt = input.pages[0]?.fetchedAt
  if (
    !isCanonicalPostgresTimestamp(parsedAt) ||
    !isCanonicalPostgresTimestamp(firstFetchedAt) ||
    Date.parse(parsedAt) > Date.parse(firstFetchedAt)
  ) {
    return { verified: false } as const
  }

  const identities = new Set<string>()
  const hashes = new Set<string>()
  for (const [index, row] of input.rows.entries()) {
    const sourceRow = sourceRows[index]
    const projection = coinexCopierProjection(sourceRow)
    const expectedHash =
      projection === null
        ? null
        : dedupeHash(
            'coinex_cp',
            projection.label,
            sourceRow.fund_amount,
            sourceRow.total_copy_earn_amount
          )
    if (
      projection === null ||
      identities.has(projection.identity) ||
      row.kind !== 'copiers' ||
      row.ts !== parsedAt ||
      row.copierLabel !== projection.label ||
      !Object.is(row.copierPnl, projection.pnl) ||
      !Object.is(row.copierInvested, projection.invested) ||
      row.copyDurationDays !== null ||
      row.dedupeHash !== expectedHash ||
      hashes.has(row.dedupeHash) ||
      row.raw !== sourceRow
    ) {
      return { verified: false } as const
    }
    identities.add(projection.identity)
    hashes.add(row.dedupeHash)
  }

  return { verified: true, envelopeRowCount: sourceRows.length } as const
}

export const coinexCopierSnapshotVerifier: SelectedCopierSnapshotVerifier = Object.freeze({
  contract: COINEX_COPIER_SNAPSHOT_VERIFIER_CONTRACT,
  verifyTerminal,
  verifyConservation,
})
