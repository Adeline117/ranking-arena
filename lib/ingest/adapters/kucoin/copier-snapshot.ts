import type {
  CopierSnapshotVerificationInput,
  SelectedCopierSnapshotVerifier,
} from '../../core/adapter'
import type { HistoryTerminalVerificationInput } from '../../history-acquisition'
import { isCanonicalPostgresTimestamp } from '../../postgres-timestamp'
import { dedupeHash } from './parsers'

export const KUCOIN_COPIER_SNAPSHOT_VERIFIER_CONTRACT =
  'arena.ingest.history-terminal-verifier.kucoin.copiers@2' as const
export const KUCOIN_COPIER_HISTORY_URL =
  'https://www.kucoin.com/_api/ct-copy-trade/v1/copyTrading/leadShow/copyTraders' as const
export const KUCOIN_COPIER_PAGE_SIZE = 10 as const

const ENVELOPE_FIELDS = ['code', 'data', 'msg', 'retry', 'success'] as const
const DATA_FIELDS = ['currentPage', 'items', 'pageSize', 'totalNum', 'totalPage'] as const
const COPIER_FIELDS = ['avatar', 'copyDays', 'copyPrincipal', 'nickName', 'pnl', 'uid'] as const

type Dict = Record<string, unknown>

export interface ValidatedKucoinCopierPage {
  rows: Dict[]
  total: number
  totalPages: number
}

interface KucoinCopierProjection {
  label: string
  pnl: number
  invested: number
  durationDays: number
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

function canonicalLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim().length > 0
}

function canonicalHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return false
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

function canonicalFiniteDecimal(value: unknown, allowNegative: boolean): value is string {
  if (typeof value !== 'string') return false
  const pattern = allowNegative
    ? /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/
    : /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/
  if (!pattern.test(value)) return false
  const parsed = Number(value)
  return Number.isFinite(parsed) && !Object.is(parsed, -0)
}

function kucoinCopierProjection(value: unknown): KucoinCopierProjection | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, COPIER_FIELDS) ||
    value.uid !== null ||
    !canonicalLabel(value.nickName) ||
    !canonicalHttpsUrl(value.avatar) ||
    !nonNegativeSafeInteger(value.copyDays) ||
    !canonicalFiniteDecimal(value.copyPrincipal, false) ||
    !canonicalFiniteDecimal(value.pnl, true)
  ) {
    return null
  }

  return {
    label: value.nickName,
    pnl: Number(value.pnl),
    invested: Number(value.copyPrincipal),
    durationDays: value.copyDays,
    dedupeHash: dedupeHash('kucoin_cp', value.nickName, value.copyPrincipal, value.copyDays),
  }
}

export function kucoinCopierProjectionHash(value: unknown): string | null {
  return kucoinCopierProjection(value)?.dedupeHash ?? null
}

export function kucoinCopierHistoryUrl(exchangeTraderId: string, page: number): string {
  if (
    exchangeTraderId.length === 0 ||
    exchangeTraderId.trim() !== exchangeTraderId ||
    !Number.isSafeInteger(page) ||
    page <= 0 ||
    Object.is(page, -0)
  ) {
    throw new TypeError('[kucoin] copier request coordinates are invalid')
  }
  return (
    `${KUCOIN_COPIER_HISTORY_URL}?lang=en_US` +
    `&leadConfigId=${encodeURIComponent(exchangeTraderId)}` +
    `&currentPage=${page}&pageSize=${KUCOIN_COPIER_PAGE_SIZE}`
  )
}

export function validateKucoinCopierPage(
  value: unknown,
  expectedPage: number
): ValidatedKucoinCopierPage | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ENVELOPE_FIELDS) ||
    value.success !== true ||
    value.code !== '200' ||
    value.msg !== 'success' ||
    value.retry !== false ||
    !isRecord(value.data) ||
    !exactKeys(value.data, DATA_FIELDS)
  ) {
    return null
  }

  const page = value.data
  if (
    !nonNegativeSafeInteger(page.currentPage) ||
    page.currentPage !== expectedPage ||
    page.pageSize !== KUCOIN_COPIER_PAGE_SIZE ||
    !nonNegativeSafeInteger(page.totalNum) ||
    !nonNegativeSafeInteger(page.totalPage) ||
    !Array.isArray(page.items) ||
    !page.items.every(isRecord)
  ) {
    return null
  }

  const total = page.totalNum
  const totalPages = Math.ceil(total / KUCOIN_COPIER_PAGE_SIZE)
  const expectedRows = Math.min(
    KUCOIN_COPIER_PAGE_SIZE,
    Math.max(total - (expectedPage - 1) * KUCOIN_COPIER_PAGE_SIZE, 0)
  )
  if (
    page.totalPage !== totalPages ||
    page.items.length !== expectedRows ||
    (total > 0 && (expectedPage < 1 || expectedPage > totalPages)) ||
    (total === 0 && expectedPage !== 1)
  ) {
    return null
  }

  const hashes = new Set<string>()
  for (const row of page.items) {
    const projection = kucoinCopierProjection(row)
    if (projection === null || hashes.has(projection.dedupeHash)) {
      return null
    }
    hashes.add(projection.dedupeHash)
  }
  return { rows: page.items, total, totalPages }
}

function validatePages(
  pages: readonly Readonly<HistoryTerminalVerificationInput['pages'][number]>[],
  exchangeTraderId: string
): ValidatedKucoinCopierPage[] | null {
  if (pages.length === 0) return null

  const validated: ValidatedKucoinCopierPage[] = []
  const hashes = new Set<string>()
  let stableTotal: number | null = null
  let stableTotalPages: number | null = null

  for (const [index, page] of pages.entries()) {
    const pageNumber = index + 1
    if (
      page.pageIndex !== pageNumber ||
      page.url !== kucoinCopierHistoryUrl(exchangeTraderId, pageNumber)
    ) {
      return null
    }
    const parsed = validateKucoinCopierPage(page.payload, pageNumber)
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
      const projection = kucoinCopierProjection(row)
      if (projection === null || hashes.has(projection.dedupeHash)) {
        return null
      }
      hashes.add(projection.dedupeHash)
    }
    validated.push(parsed)
  }

  if (stableTotal === null || stableTotalPages === null) return null
  const expectedPageCount = Math.max(1, stableTotalPages)
  return pages.length === expectedPageCount && hashes.size === stableTotal ? validated : null
}

function verifyTerminal(input: HistoryTerminalVerificationInput) {
  if (
    input.source.slug !== 'kucoin_futures' ||
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

  // KuCoin exposes relationship age, not an observation clock. Bind every
  // parsed row to the exact ParseCtx clock captured before acquisition.
  const parsedAt = input.parserClock
  const firstFetchedAt = input.pages[0]?.fetchedAt
  if (
    !isCanonicalPostgresTimestamp(parsedAt) ||
    !isCanonicalPostgresTimestamp(firstFetchedAt) ||
    Date.parse(parsedAt) > Date.parse(firstFetchedAt)
  ) {
    return { verified: false } as const
  }

  const hashes = new Set<string>()
  for (const [index, row] of input.rows.entries()) {
    const sourceRow = sourceRows[index]
    const projection = kucoinCopierProjection(sourceRow)
    if (
      projection === null ||
      row.kind !== 'copiers' ||
      row.ts !== parsedAt ||
      row.copierLabel !== projection.label ||
      !Object.is(row.copierPnl, projection.pnl) ||
      !Object.is(row.copierInvested, projection.invested) ||
      !Object.is(row.copyDurationDays, projection.durationDays) ||
      row.dedupeHash !== projection.dedupeHash ||
      hashes.has(row.dedupeHash) ||
      row.raw !== sourceRow
    ) {
      return { verified: false } as const
    }
    hashes.add(row.dedupeHash)
  }

  return { verified: true, envelopeRowCount: sourceRows.length } as const
}

export const kucoinCopierSnapshotVerifier: SelectedCopierSnapshotVerifier = Object.freeze({
  contract: KUCOIN_COPIER_SNAPSHOT_VERIFIER_CONTRACT,
  verifyTerminal,
  verifyConservation,
})
