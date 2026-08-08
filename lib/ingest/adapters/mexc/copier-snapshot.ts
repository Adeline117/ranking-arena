import type {
  CopierSnapshotVerificationInput,
  SelectedCopierSnapshotVerifier,
} from '../../core/adapter'
import type { HistoryTerminalVerificationInput } from '../../history-acquisition'
import { isCanonicalPostgresTimestamp } from '../../postgres-timestamp'
import { dedupeHash } from './parsers'

export const MEXC_COPIER_SNAPSHOT_VERIFIER_CONTRACT =
  'arena.ingest.history-terminal-verifier.mexc.copiers@2' as const
export const MEXC_COPIER_HISTORY_URL =
  'https://www.mexc.com/api/platform/futures/copyFutures/api/v1/trader/followers/v2' as const
export const MEXC_COPIER_PAGE_SIZE = 10 as const

const ENVELOPE_FIELDS = ['code', 'data', 'message', 'success'] as const
const DATA_FIELDS = ['content', 'currentPage', 'offset', 'pageSize', 'total', 'totalPage'] as const
const COPIER_FIELDS = [
  'copyFunds',
  'copyProfit',
  'currency',
  'followerUid',
  'nickname',
  'reverseCopy',
] as const

type Dict = Record<string, unknown>

export interface ValidatedMexcCopierPage {
  rows: Dict[]
  total: number
  totalPage: number
}

interface MexcCopierProjection {
  identity: string
  label: string
  pnl: number
  invested: number
  dedupeHash: string
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

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
}

function nonNegativeFiniteNumber(value: unknown): value is number {
  return finiteNumber(value) && value >= 0
}

function canonicalLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function canonicalTraderId(value: string): boolean {
  return /^[0-9]+$/.test(value)
}

export function mexcCopierIdentity(value: unknown): string | null {
  if (!isRecord(value) || typeof value.followerUid !== 'string') return null
  return /^[0-9]{2}\*{5}[0-9]$/.test(value.followerUid) ? value.followerUid : null
}

function mexcCopierProjection(value: unknown): MexcCopierProjection | null {
  if (!isRecord(value) || !exactKeys(value, COPIER_FIELDS)) return null
  const identity = mexcCopierIdentity(value)
  if (
    identity === null ||
    !canonicalLabel(value.nickname) ||
    !nonNegativeFiniteNumber(value.copyFunds) ||
    !finiteNumber(value.copyProfit) ||
    value.currency !== 'USDT' ||
    (value.reverseCopy !== 0 && value.reverseCopy !== 1)
  ) {
    return null
  }

  return {
    identity,
    label: value.nickname,
    pnl: value.copyProfit,
    invested: value.copyFunds,
    dedupeHash: dedupeHash('mexc_cp', identity, value.copyFunds, value.copyProfit),
  }
}

export function mexcCopierHistoryUrl(exchangeTraderId: string, page: number): string {
  if (
    !canonicalTraderId(exchangeTraderId) ||
    !Number.isSafeInteger(page) ||
    page <= 0 ||
    Object.is(page, -0)
  ) {
    throw new TypeError('[mexc] copier request coordinates are invalid')
  }
  return (
    `${MEXC_COPIER_HISTORY_URL}?limit=${MEXC_COPIER_PAGE_SIZE}` +
    `&page=${page}&uid=${encodeURIComponent(exchangeTraderId)}`
  )
}

export function validateMexcCopierPage(
  value: unknown,
  expectedPage: number
): ValidatedMexcCopierPage | null {
  if (
    !Number.isSafeInteger(expectedPage) ||
    expectedPage <= 0 ||
    Object.is(expectedPage, -0) ||
    !isRecord(value) ||
    !exactKeys(value, ENVELOPE_FIELDS) ||
    value.code !== 0 ||
    value.message !== '' ||
    value.success !== true ||
    !isRecord(value.data) ||
    !exactKeys(value.data, DATA_FIELDS)
  ) {
    return null
  }

  const data = value.data
  if (
    data.currentPage !== expectedPage ||
    data.pageSize !== MEXC_COPIER_PAGE_SIZE ||
    data.offset !== (expectedPage - 1) * MEXC_COPIER_PAGE_SIZE ||
    !nonNegativeSafeInteger(data.total) ||
    !nonNegativeSafeInteger(data.totalPage) ||
    data.totalPage !== Math.ceil(data.total / MEXC_COPIER_PAGE_SIZE) ||
    !Array.isArray(data.content) ||
    !data.content.every(isRecord)
  ) {
    return null
  }

  const total = data.total
  const totalPage = data.totalPage
  const expectedRows = Math.min(
    MEXC_COPIER_PAGE_SIZE,
    Math.max(total - (expectedPage - 1) * MEXC_COPIER_PAGE_SIZE, 0)
  )
  if (
    data.content.length !== expectedRows ||
    (total > 0 && expectedPage > totalPage) ||
    (total === 0 && expectedPage !== 1)
  ) {
    return null
  }

  const identities = new Set<string>()
  for (const row of data.content) {
    const projection = mexcCopierProjection(row)
    if (projection === null || identities.has(projection.identity)) return null
    identities.add(projection.identity)
  }
  return { rows: data.content, total, totalPage }
}

function validatePages(
  pages: readonly Readonly<HistoryTerminalVerificationInput['pages'][number]>[],
  exchangeTraderId: string
): ValidatedMexcCopierPage[] | null {
  if (pages.length === 0 || !canonicalTraderId(exchangeTraderId)) return null

  const validated: ValidatedMexcCopierPage[] = []
  const identities = new Set<string>()
  let stableTotal: number | null = null
  let stableTotalPage: number | null = null

  for (const [index, page] of pages.entries()) {
    const pageNumber = index + 1
    if (
      page.pageIndex !== pageNumber ||
      page.url !== mexcCopierHistoryUrl(exchangeTraderId, pageNumber)
    ) {
      return null
    }
    const parsed = validateMexcCopierPage(page.payload, pageNumber)
    if (
      parsed === null ||
      (stableTotal !== null && parsed.total !== stableTotal) ||
      (stableTotalPage !== null && parsed.totalPage !== stableTotalPage)
    ) {
      return null
    }
    stableTotal ??= parsed.total
    stableTotalPage ??= parsed.totalPage

    for (const row of parsed.rows) {
      const identity = mexcCopierIdentity(row)
      if (identity === null || identities.has(identity)) return null
      identities.add(identity)
    }
    validated.push(parsed)
  }

  if (stableTotal === null || stableTotalPage === null) return null
  const expectedPageCount = Math.max(1, stableTotalPage)
  return pages.length === expectedPageCount && identities.size === stableTotal ? validated : null
}

function verifyTerminal(input: HistoryTerminalVerificationInput) {
  if (
    input.source.slug !== 'mexc_futures' ||
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
    const projection = mexcCopierProjection(sourceRow)
    if (
      projection === null ||
      identities.has(projection.identity) ||
      row.kind !== 'copiers' ||
      row.ts !== parsedAt ||
      row.copierLabel !== projection.label ||
      !Object.is(row.copierPnl, projection.pnl) ||
      !Object.is(row.copierInvested, projection.invested) ||
      row.copyDurationDays !== null ||
      row.dedupeHash !== projection.dedupeHash ||
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

export const mexcCopierSnapshotVerifier: SelectedCopierSnapshotVerifier = Object.freeze({
  contract: MEXC_COPIER_SNAPSHOT_VERIFIER_CONTRACT,
  verifyTerminal,
  verifyConservation,
})
