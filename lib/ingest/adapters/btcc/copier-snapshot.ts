import type {
  CopierSnapshotVerificationInput,
  SelectedCopierSnapshotVerifier,
} from '../../core/adapter'
import type { HistoryTerminalVerificationInput } from '../../history-acquisition'
import { isCanonicalPostgresTimestamp } from '../../postgres-timestamp'
import {
  BTCC_COPIER_HISTORY_URL,
  BTCC_COPIER_PAGE_ENVELOPE_CONTRACT,
  BTCC_COPIER_PAGE_SIZE,
} from './copier-contract'
import { dedupeHash } from './parsers'

export const BTCC_COPIER_SNAPSHOT_VERIFIER_CONTRACT =
  'arena.ingest.history-terminal-verifier.btcc.copiers@2' as const

const WRAPPER_FIELDS = ['contract', 'exchangeTraderId', 'request', 'response'] as const
const REQUEST_FIELDS = ['pageNum', 'pageSize', 'traderId'] as const
const RESPONSE_FIELDS = ['code', 'extended', 'msg', 'pageNum', 'pageSize', 'rows', 'total'] as const
const COPIER_FIELDS = [
  'avatarPic',
  'cumulativeNetProfit',
  'followTime',
  'nickName',
  'userId',
] as const
const DAY_MS = 86_400_000

type Dict = Record<string, unknown>

export interface ValidatedBtccCopierPage {
  rows: Dict[]
  total: number
}

interface BtccCopierProjection {
  identity: string
  label: string
  pnl: number
  followedAt: number
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

function positiveSafeInteger(value: unknown): value is number {
  return nonNegativeSafeInteger(value) && value > 0
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
}

function canonicalLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function traderId(exchangeTraderId: string): number | null {
  if (!/^[1-9][0-9]*$/.test(exchangeTraderId)) return null
  const value = Number(exchangeTraderId)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function btccCopierProjection(value: unknown): BtccCopierProjection | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, COPIER_FIELDS) ||
    !positiveSafeInteger(value.userId) ||
    !positiveSafeInteger(value.followTime) ||
    typeof value.avatarPic !== 'string' ||
    !canonicalLabel(value.nickName) ||
    !finiteNumber(value.cumulativeNetProfit)
  ) {
    return null
  }

  return {
    identity: String(value.userId),
    label: value.nickName,
    pnl: value.cumulativeNetProfit,
    followedAt: value.followTime,
    dedupeHash: dedupeHash('btcc_cp', value.userId, value.followTime),
  }
}

export function btccCopierRequest(
  exchangeTraderId: string,
  page: number
): Readonly<{
  pageNum: number
  pageSize: typeof BTCC_COPIER_PAGE_SIZE
  traderId: number
}> {
  const canonicalTraderId = traderId(exchangeTraderId)
  if (
    canonicalTraderId === null ||
    !Number.isSafeInteger(page) ||
    page <= 0 ||
    Object.is(page, -0)
  ) {
    throw new TypeError('[btcc] copier request coordinates are invalid')
  }
  return Object.freeze({
    pageNum: page,
    pageSize: BTCC_COPIER_PAGE_SIZE,
    traderId: canonicalTraderId,
  })
}

export function validateBtccCopierPage(
  value: unknown,
  expectedPage: number,
  exchangeTraderId: string
): ValidatedBtccCopierPage | null {
  const expectedTraderId = traderId(exchangeTraderId)
  if (
    expectedTraderId === null ||
    !Number.isSafeInteger(expectedPage) ||
    expectedPage <= 0 ||
    Object.is(expectedPage, -0) ||
    !isRecord(value) ||
    !exactKeys(value, WRAPPER_FIELDS) ||
    value.contract !== BTCC_COPIER_PAGE_ENVELOPE_CONTRACT ||
    value.exchangeTraderId !== exchangeTraderId ||
    !isRecord(value.request) ||
    !exactKeys(value.request, REQUEST_FIELDS) ||
    value.request.pageNum !== expectedPage ||
    value.request.pageSize !== BTCC_COPIER_PAGE_SIZE ||
    value.request.traderId !== expectedTraderId ||
    !isRecord(value.response) ||
    !exactKeys(value.response, RESPONSE_FIELDS)
  ) {
    return null
  }

  const response = value.response
  if (
    response.code !== 200 ||
    response.msg !== '请求成功' ||
    response.extended !== null ||
    response.pageNum !== expectedPage ||
    response.pageSize !== BTCC_COPIER_PAGE_SIZE ||
    !nonNegativeSafeInteger(response.total) ||
    !Array.isArray(response.rows) ||
    !response.rows.every(isRecord)
  ) {
    return null
  }

  const total = response.total
  const expectedRows = Math.min(
    BTCC_COPIER_PAGE_SIZE,
    Math.max(total - (expectedPage - 1) * BTCC_COPIER_PAGE_SIZE, 0)
  )
  if (
    response.rows.length !== expectedRows ||
    (total > 0 && expectedPage > Math.ceil(total / BTCC_COPIER_PAGE_SIZE)) ||
    (total === 0 && expectedPage !== 1)
  ) {
    return null
  }

  const identities = new Set<string>()
  for (const row of response.rows) {
    const projection = btccCopierProjection(row)
    if (projection === null || identities.has(projection.identity)) return null
    identities.add(projection.identity)
  }
  return { rows: response.rows, total }
}

function validatePages(
  pages: readonly Readonly<HistoryTerminalVerificationInput['pages'][number]>[],
  exchangeTraderId: string
): ValidatedBtccCopierPage[] | null {
  if (pages.length === 0) return null

  const validated: ValidatedBtccCopierPage[] = []
  const identities = new Set<string>()
  let stableTotal: number | null = null

  for (const [index, page] of pages.entries()) {
    const pageNumber = index + 1
    if (page.pageIndex !== pageNumber || page.url !== BTCC_COPIER_HISTORY_URL) {
      return null
    }
    const parsed = validateBtccCopierPage(page.payload, pageNumber, exchangeTraderId)
    if (parsed === null || (stableTotal !== null && parsed.total !== stableTotal)) return null
    stableTotal ??= parsed.total

    for (const row of parsed.rows) {
      const projection = btccCopierProjection(row)
      if (projection === null || identities.has(projection.identity)) return null
      identities.add(projection.identity)
    }
    validated.push(parsed)
  }

  if (stableTotal === null) return null
  const expectedPageCount = Math.max(1, Math.ceil(stableTotal / BTCC_COPIER_PAGE_SIZE))
  return pages.length === expectedPageCount && identities.size === stableTotal ? validated : null
}

function verifyTerminal(input: HistoryTerminalVerificationInput) {
  if (
    input.source.slug !== 'btcc_futures' ||
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
    const projection = btccCopierProjection(sourceRow)
    const durationDays =
      projection === null
        ? null
        : Math.floor((Date.parse(parsedAt) - projection.followedAt) / DAY_MS)
    if (
      projection === null ||
      durationDays === null ||
      durationDays < 0 ||
      identities.has(projection.identity) ||
      row.kind !== 'copiers' ||
      row.ts !== parsedAt ||
      row.copierLabel !== projection.label ||
      !Object.is(row.copierPnl, projection.pnl) ||
      row.copierInvested !== null ||
      !Object.is(row.copyDurationDays, durationDays) ||
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

export const btccCopierSnapshotVerifier: SelectedCopierSnapshotVerifier = Object.freeze({
  contract: BTCC_COPIER_SNAPSHOT_VERIFIER_CONTRACT,
  verifyTerminal,
  verifyConservation,
})
