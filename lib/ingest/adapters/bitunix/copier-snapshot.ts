import type {
  CopierSnapshotVerificationInput,
  SelectedCopierSnapshotVerifier,
} from '../../core/adapter'
import type { HistoryTerminalVerificationInput } from '../../history-acquisition'
import { isCanonicalPostgresTimestamp } from '../../postgres-timestamp'
import {
  BITUNIX_COPIER_HISTORY_URL,
  BITUNIX_COPIER_PAGE_ENVELOPE_CONTRACT,
  BITUNIX_COPIER_PAGE_SIZE,
} from './copier-contract'
import { dedupeHash } from './parsers'

/**
 * "Exhausted" means a complete crawl whose reported total/totalPage remained
 * stable and whose observed identity keys were non-duplicated. Bitunix does
 * not issue a point-in-time snapshot token, so this contract does not claim
 * database-snapshot semantics at the crawl-completion observedAt clock.
 */
export const BITUNIX_COPIER_SNAPSHOT_VERIFIER_CONTRACT =
  'arena.ingest.history-terminal-verifier.bitunix.copiers@3' as const

const WRAPPER_FIELDS = ['contract', 'exchangeTraderId', 'request', 'response'] as const
const REQUEST_FIELDS = ['page', 'pageSize', 'traderUid'] as const
const RESPONSE_FIELDS = ['code', 'data', 'msg', 'success'] as const
const DATA_FIELDS = ['page', 'records', 'total', 'totalPage'] as const
const COPIER_FIELDS = [
  'day',
  'endFollowDate',
  'followAmount',
  'followDate',
  'header',
  'nickname',
  'pl',
  'puid',
  'roi',
  'status',
  'uid',
] as const

type Dict = Record<string, unknown>

export interface ValidatedBitunixCopierPage {
  rows: Dict[]
  total: number
  totalPage: number
}

interface BitunixCopierProjection {
  identityKeys: readonly string[]
  label: string
  pnl: number
  invested: number
  durationDays: number
  followedAt: string
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

function canonicalLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function canonicalDecimal(value: unknown, nonNegative: boolean): value is string {
  if (typeof value !== 'string' || value.length > 128) return false
  const match = /^-?(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value)
  if (!match) return false

  // RAW retains the exact source decimal. Serving uses a deterministic IEEE-754
  // projection, so reject magnitudes outside the safe integer boundary before
  // Number() can round them back inside it, and reject nonzero underflow.
  const integer = match[1]
  const fraction = match[2] ?? ''
  const maxSafeInteger = String(Number.MAX_SAFE_INTEGER)
  if (
    integer.length > maxSafeInteger.length ||
    (integer.length === maxSafeInteger.length && integer > maxSafeInteger) ||
    (integer === maxSafeInteger && /[1-9]/.test(fraction))
  ) {
    return false
  }
  const parsed = Number(value)
  const sourceIsZero = /^-?0(?:\.0+)?$/.test(value)
  return (
    Number.isFinite(parsed) &&
    !Object.is(parsed, -0) &&
    (!nonNegative || parsed >= 0) &&
    Math.abs(parsed) <= Number.MAX_SAFE_INTEGER &&
    (parsed !== 0 || sourceIsZero)
  )
}

function canonicalInstant(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    return false
  }
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return false
  const canonical = new Date(parsed).toISOString()
  return value.includes('.') ? canonical === value : canonical === value.replace(/Z$/, '.000Z')
}

function canonicalHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value) return false
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.hash === '' &&
      url.href === value
    )
  } catch {
    return false
  }
}

function traderUid(exchangeTraderId: string): number | null {
  if (!/^[1-9][0-9]*$/.test(exchangeTraderId)) return null
  const value = Number(exchangeTraderId)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function optionalUid(value: unknown): value is number | null {
  return value === null || positiveSafeInteger(value)
}

export function bitunixCopierIdentityKeys(value: unknown): readonly string[] | null {
  if (!isRecord(value)) return null
  if (!canonicalLabel(value.nickname) || !canonicalInstant(value.followDate)) return null
  const fallback = `masked:${value.nickname}|${value.followDate}`
  if (positiveSafeInteger(value.uid)) return Object.freeze([`uid:${value.uid}`, fallback])
  return value.uid === null ? Object.freeze([fallback]) : null
}

function bitunixCopierProjection(value: unknown): BitunixCopierProjection | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, COPIER_FIELDS) ||
    !optionalUid(value.uid) ||
    !optionalUid(value.puid) ||
    !canonicalLabel(value.nickname) ||
    !canonicalHttpsUrl(value.header) ||
    !canonicalDecimal(value.followAmount, true) ||
    !canonicalDecimal(value.pl, false) ||
    !canonicalDecimal(value.roi, false) ||
    !nonNegativeSafeInteger(value.day) ||
    !canonicalInstant(value.followDate) ||
    value.endFollowDate !== null ||
    value.status !== 1
  ) {
    return null
  }
  const identityKeys = bitunixCopierIdentityKeys(value)
  if (identityKeys === null) return null
  const dedupeIdentity = positiveSafeInteger(value.uid) ? value.uid : value.nickname

  return {
    identityKeys,
    label: value.nickname,
    pnl: Number(value.pl),
    invested: Number(value.followAmount),
    durationDays: value.day,
    followedAt: value.followDate,
    dedupeHash: dedupeHash('bitunix_cp', dedupeIdentity, value.followDate),
  }
}

export function bitunixCopierRequest(
  exchangeTraderId: string,
  page: number
): Readonly<{
  traderUid: number
  page: number
  pageSize: typeof BITUNIX_COPIER_PAGE_SIZE
}> {
  const canonicalTraderUid = traderUid(exchangeTraderId)
  if (
    canonicalTraderUid === null ||
    !Number.isSafeInteger(page) ||
    page <= 0 ||
    Object.is(page, -0)
  ) {
    throw new TypeError('[bitunix] copier request coordinates are invalid')
  }
  return Object.freeze({
    traderUid: canonicalTraderUid,
    page,
    pageSize: BITUNIX_COPIER_PAGE_SIZE,
  })
}

export function validateBitunixCopierPage(
  value: unknown,
  expectedPage: number,
  exchangeTraderId: string
): ValidatedBitunixCopierPage | null {
  const expectedTraderUid = traderUid(exchangeTraderId)
  if (
    expectedTraderUid === null ||
    !Number.isSafeInteger(expectedPage) ||
    expectedPage <= 0 ||
    Object.is(expectedPage, -0) ||
    !isRecord(value) ||
    !exactKeys(value, WRAPPER_FIELDS) ||
    value.contract !== BITUNIX_COPIER_PAGE_ENVELOPE_CONTRACT ||
    value.exchangeTraderId !== exchangeTraderId ||
    !isRecord(value.request) ||
    !exactKeys(value.request, REQUEST_FIELDS) ||
    value.request.traderUid !== expectedTraderUid ||
    value.request.page !== expectedPage ||
    value.request.pageSize !== BITUNIX_COPIER_PAGE_SIZE ||
    !isRecord(value.response) ||
    !exactKeys(value.response, RESPONSE_FIELDS) ||
    value.response.code !== 0 ||
    value.response.msg !== 'result.success' ||
    value.response.success !== true ||
    !isRecord(value.response.data) ||
    !exactKeys(value.response.data, DATA_FIELDS)
  ) {
    return null
  }

  const data = value.response.data
  if (
    data.page !== expectedPage ||
    !nonNegativeSafeInteger(data.total) ||
    !nonNegativeSafeInteger(data.totalPage) ||
    data.totalPage !== Math.ceil(data.total / BITUNIX_COPIER_PAGE_SIZE) ||
    !Array.isArray(data.records) ||
    !data.records.every(isRecord)
  ) {
    return null
  }

  const total = data.total
  const totalPage = data.totalPage
  const expectedRows = Math.min(
    BITUNIX_COPIER_PAGE_SIZE,
    Math.max(total - (expectedPage - 1) * BITUNIX_COPIER_PAGE_SIZE, 0)
  )
  if (
    data.records.length !== expectedRows ||
    (total > 0 && expectedPage > totalPage) ||
    (total === 0 && expectedPage !== 1)
  ) {
    return null
  }

  const identities = new Set<string>()
  for (const row of data.records) {
    const projection = bitunixCopierProjection(row)
    if (
      projection === null ||
      projection.identityKeys.some((identity) => identities.has(identity))
    ) {
      return null
    }
    projection.identityKeys.forEach((identity) => identities.add(identity))
  }
  return { rows: data.records, total, totalPage }
}

function validatePages(
  pages: readonly Readonly<HistoryTerminalVerificationInput['pages'][number]>[],
  exchangeTraderId: string
): ValidatedBitunixCopierPage[] | null {
  if (pages.length === 0) return null

  const validated: ValidatedBitunixCopierPage[] = []
  const identities = new Set<string>()
  let stableTotal: number | null = null
  let stableTotalPage: number | null = null

  for (const [index, page] of pages.entries()) {
    const pageNumber = index + 1
    if (page.pageIndex !== pageNumber || page.url !== BITUNIX_COPIER_HISTORY_URL) return null
    const parsed = validateBitunixCopierPage(page.payload, pageNumber, exchangeTraderId)
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
      const projection = bitunixCopierProjection(row)
      if (
        projection === null ||
        projection.identityKeys.some((identity) => identities.has(identity))
      ) {
        return null
      }
      projection.identityKeys.forEach((identity) => identities.add(identity))
    }
    validated.push(parsed)
  }

  if (stableTotal === null || stableTotalPage === null) return null
  const expectedPageCount = Math.max(1, stableTotalPage)
  return pages.length === expectedPageCount &&
    validated.flatMap((page) => page.rows).length === stableTotal
    ? validated
    : null
}

function verifyTerminal(input: HistoryTerminalVerificationInput) {
  if (
    input.source.slug !== 'bitunix_futures' ||
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
    const projection = bitunixCopierProjection(sourceRow)
    if (
      projection === null ||
      Date.parse(projection.followedAt) > Date.parse(parsedAt) ||
      projection.identityKeys.some((identity) => identities.has(identity)) ||
      row.kind !== 'copiers' ||
      row.ts !== parsedAt ||
      row.copierLabel !== projection.label ||
      !Object.is(row.copierPnl, projection.pnl) ||
      !Object.is(row.copierInvested, projection.invested) ||
      row.copyDurationDays !== projection.durationDays ||
      row.dedupeHash !== projection.dedupeHash ||
      hashes.has(row.dedupeHash) ||
      row.raw !== sourceRow
    ) {
      return { verified: false } as const
    }
    projection.identityKeys.forEach((identity) => identities.add(identity))
    hashes.add(row.dedupeHash)
  }

  return { verified: true, envelopeRowCount: sourceRows.length } as const
}

export const bitunixCopierSnapshotVerifier: SelectedCopierSnapshotVerifier = Object.freeze({
  contract: BITUNIX_COPIER_SNAPSHOT_VERIFIER_CONTRACT,
  verifyTerminal,
  verifyConservation,
})
