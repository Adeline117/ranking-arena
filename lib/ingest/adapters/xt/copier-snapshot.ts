import type {
  CopierSnapshotVerificationInput,
  SelectedCopierSnapshotVerifier,
} from '../../core/adapter'
import type { HistoryTerminalVerificationInput } from '../../history-acquisition'
import { isCanonicalPostgresTimestamp } from '../../postgres-timestamp'
import { xtCopierDedupeHash } from './parsers'

export const XT_COPIER_SNAPSHOT_VERIFIER_CONTRACT =
  'arena.ingest.history-terminal-verifier.xt.copiers@2' as const
export const XT_COPIER_HISTORY_URL =
  'https://www.xt.com/fapi/user/v1/public/copy-trade/leader-follower-page' as const
export const XT_COPIER_PAGE_SIZE = 20 as const

type Dict = Record<string, unknown>

export interface ValidatedXtCopierPage {
  rows: Dict[]
  total: number
}

interface XtCopierProjection {
  identity: string
  label: string
  pnl: number
  invested: number
  durationDays: number
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

export function xtCopierIdentity(value: unknown): string | null {
  if (!isRecord(value)) return null
  return typeof value.id === 'string' && /^[1-9][0-9]*$/.test(value.id) ? value.id : null
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

function xtCopierProjection(value: unknown): XtCopierProjection | null {
  if (!isRecord(value)) return null
  const identity = xtCopierIdentity(value)
  if (
    identity === null ||
    !canonicalLabel(value.followerName) ||
    !canonicalFiniteDecimal(value.followProfitU, true) ||
    !nonNegativeSafeInteger(value.days)
  ) {
    return null
  }

  // XT currently supplies both fields. `followMarginU` is the reviewed
  // projection; `followAmountTotal` remains the parser's nullish fallback.
  // Validate either source value whenever it is present so malformed unused
  // fallback data cannot silently enter otherwise trusted RAW evidence.
  if (
    value.followMarginU !== undefined &&
    value.followMarginU !== null &&
    !canonicalFiniteDecimal(value.followMarginU, false)
  ) {
    return null
  }
  if (
    value.followAmountTotal !== undefined &&
    value.followAmountTotal !== null &&
    !canonicalFiniteDecimal(value.followAmountTotal, false)
  ) {
    return null
  }
  const investedSource = value.followMarginU ?? value.followAmountTotal
  if (!canonicalFiniteDecimal(investedSource, false)) return null

  return {
    identity,
    label: value.followerName,
    pnl: Number(value.followProfitU),
    invested: Number(investedSource),
    durationDays: value.days,
  }
}

export function xtCopierHistoryUrl(exchangeTraderId: string, page: number): string {
  if (
    exchangeTraderId.length === 0 ||
    exchangeTraderId.trim() !== exchangeTraderId ||
    !Number.isSafeInteger(page) ||
    page <= 0
  ) {
    throw new TypeError('[xt] copier request coordinates are invalid')
  }
  return (
    `${XT_COPIER_HISTORY_URL}?leaderAccountId=${encodeURIComponent(exchangeTraderId)}` +
    `&page=${page}&size=${XT_COPIER_PAGE_SIZE}`
  )
}

export function validateXtCopierPage(
  value: unknown,
  expectedPage: number
): ValidatedXtCopierPage | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['error', 'msgInfo', 'result', 'returnCode']) ||
    value.returnCode !== 0 ||
    value.msgInfo !== 'success' ||
    value.error !== null ||
    !isRecord(value.result) ||
    !exactKeys(value.result, ['items', 'page', 'ps', 'total'])
  ) {
    return null
  }

  const result = value.result
  if (
    result.page !== expectedPage ||
    result.ps !== XT_COPIER_PAGE_SIZE ||
    !nonNegativeSafeInteger(result.total) ||
    !Array.isArray(result.items) ||
    !result.items.every(isRecord)
  ) {
    return null
  }

  const expectedRows = Math.min(
    XT_COPIER_PAGE_SIZE,
    Math.max(result.total - (expectedPage - 1) * XT_COPIER_PAGE_SIZE, 0)
  )
  if (result.items.length !== expectedRows) return null

  const identities = new Set<string>()
  for (const row of result.items) {
    const projection = xtCopierProjection(row)
    if (projection === null || identities.has(projection.identity)) return null
    identities.add(projection.identity)
  }
  return { rows: result.items, total: result.total }
}

function validatePages(
  pages: readonly Readonly<HistoryTerminalVerificationInput['pages'][number]>[],
  exchangeTraderId: string
): ValidatedXtCopierPage[] | null {
  if (pages.length === 0) return null

  const validated: ValidatedXtCopierPage[] = []
  const identities = new Set<string>()
  let stableTotal: number | null = null

  for (const [index, page] of pages.entries()) {
    const pageNumber = index + 1
    if (
      page.pageIndex !== pageNumber ||
      page.url !== xtCopierHistoryUrl(exchangeTraderId, pageNumber)
    ) {
      return null
    }
    const parsed = validateXtCopierPage(page.payload, pageNumber)
    if (parsed === null || (stableTotal !== null && parsed.total !== stableTotal)) return null
    stableTotal ??= parsed.total

    for (const row of parsed.rows) {
      const identity = xtCopierIdentity(row)
      if (identity === null || identities.has(identity)) return null
      identities.add(identity)
    }
    validated.push(parsed)
  }

  if (stableTotal === null) return null
  const expectedPageCount = Math.max(1, Math.ceil(stableTotal / XT_COPIER_PAGE_SIZE))
  const rowsSeen = validated.reduce((sum, page) => sum + page.rows.length, 0)
  return pages.length === expectedPageCount && rowsSeen === stableTotal ? validated : null
}

function verifyTerminal(input: HistoryTerminalVerificationInput) {
  if (
    input.source.slug !== 'xt_futures' ||
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

  // XT exposes no copier event timestamp. Bind rows to the exact job-scoped
  // ParseCtx clock captured before acquisition starts.
  const parsedAt = input.parserClock
  const firstFetchedAt = input.pages[0]?.fetchedAt
  if (
    !isCanonicalPostgresTimestamp(parsedAt) ||
    !isCanonicalPostgresTimestamp(firstFetchedAt) ||
    Date.parse(parsedAt) > Date.parse(firstFetchedAt)
  ) {
    return { verified: false } as const
  }

  const sourceIdentities = new Set<string>()
  const dedupeHashes = new Set<string>()
  for (const [index, row] of input.rows.entries()) {
    const sourceRow = sourceRows[index]
    const projection = xtCopierProjection(sourceRow)
    const expectedHash = projection === null ? null : xtCopierDedupeHash(projection.identity)
    if (
      projection === null ||
      sourceIdentities.has(projection.identity) ||
      row.kind !== 'copiers' ||
      row.ts !== parsedAt ||
      row.copierLabel !== projection.label ||
      !Object.is(row.copierPnl, projection.pnl) ||
      !Object.is(row.copierInvested, projection.invested) ||
      !Object.is(row.copyDurationDays, projection.durationDays) ||
      row.raw !== sourceRow ||
      row.dedupeHash !== expectedHash ||
      dedupeHashes.has(row.dedupeHash)
    ) {
      return { verified: false } as const
    }
    sourceIdentities.add(projection.identity)
    dedupeHashes.add(row.dedupeHash)
  }

  return { verified: true, envelopeRowCount: sourceRows.length } as const
}

export const xtCopierSnapshotVerifier: SelectedCopierSnapshotVerifier = Object.freeze({
  contract: XT_COPIER_SNAPSHOT_VERIFIER_CONTRACT,
  verifyTerminal,
  verifyConservation,
})
