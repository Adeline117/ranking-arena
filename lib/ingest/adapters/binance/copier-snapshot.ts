import type {
  CopierSnapshotVerificationInput,
  SelectedCopierSnapshotVerifier,
} from '../../core/adapter'
import type {
  HistoryTerminalClaimReason,
  HistoryTerminalVerificationInput,
} from '../../history-acquisition'
import { isCanonicalPostgresTimestamp } from '../../postgres-timestamp'
import {
  BINANCE_COPIER_HISTORY_URLS,
  BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
} from './history-contract'
import { dedupeHash } from './parsers'

export const BINANCE_COPIER_SNAPSHOT_VERIFIER_CONTRACT =
  'arena.ingest.history-terminal-verifier.binance.copiers@1' as const

const PAGE_SIZE = 50
const RESPONSE_FIELDS = ['code', 'data', 'message', 'messageDetail', 'success'] as const
const DATA_FIELDS = ['indexValue', 'list', 'total'] as const
const FUTURES_COPIER_FIELDS = [
  'avatarUrl',
  'copyPortfolioId',
  'createTime',
  'marginBalance',
  'marginBalanceAsset',
  'nickname',
  'totalPnl',
  'totalPnlAsset',
  'totalRoi',
] as const
const SPOT_COPIER_FIELDS = [
  'avatarUrl',
  'balanceAmount',
  'balanceAsset',
  'nickname',
  'startTime',
  'totalPnl',
  'totalPnlAsset',
  'totalRoi',
] as const
type Dict = Record<string, unknown>

function isRecord(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Dict, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function canonicalIdentity(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.length > 0 && value.trim() === value ? value : null
  }
  return Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : null
}

function normalizedLabel(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim()
    return normalized.length > 0 ? normalized : null
  }
  return Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : null
}

function reportedTotal(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

interface ValidatedPage {
  rows: Dict[]
  total: number | null
}

interface BinanceCopierProjection {
  label: string
  pnl: number
  invested: number
  startedAt: number
}

function canonicalFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) && !Object.is(parsed, -0) ? parsed : null
}

function canonicalPositiveEpoch(value: unknown): number | null {
  const parsed = canonicalFiniteNumber(value)
  return parsed !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function copierProjection(value: unknown, url: string): BinanceCopierProjection | null {
  if (!isRecord(value)) return null
  const futures = url === BINANCE_COPIER_HISTORY_URLS.futures
  const spot = url === BINANCE_COPIER_HISTORY_URLS.spot
  if (
    (!futures && !spot) ||
    !exactKeys(value, futures ? FUTURES_COPIER_FIELDS : SPOT_COPIER_FIELDS) ||
    typeof value.avatarUrl !== 'string' ||
    normalizedLabel(value.nickname) === null ||
    (futures && canonicalIdentity(value.copyPortfolioId) === null) ||
    (futures && value.marginBalanceAsset !== 'USDT') ||
    (spot && value.balanceAsset !== 'USDT') ||
    value.totalPnlAsset !== 'USDT'
  ) {
    return null
  }
  const identity = futures
    ? canonicalIdentity(value.copyPortfolioId)
    : normalizedLabel(value.nickname)
  const pnl = canonicalFiniteNumber(value.totalPnl)
  const invested = canonicalFiniteNumber(futures ? value.marginBalance : value.balanceAmount)
  const roi = canonicalFiniteNumber(value.totalRoi)
  const startedAt = canonicalPositiveEpoch(futures ? value.createTime : value.startTime)
  if (
    identity === null ||
    pnl === null ||
    invested === null ||
    invested < 0 ||
    roi === null ||
    startedAt === null
  ) {
    return null
  }
  return {
    label: String(identity),
    pnl,
    invested,
    startedAt,
  }
}

function expectedUrl(sourceSlug: string): string | null {
  if (sourceSlug === 'binance_futures') return BINANCE_COPIER_HISTORY_URLS.futures
  if (sourceSlug === 'binance_spot') return BINANCE_COPIER_HISTORY_URLS.spot
  return null
}

function validatePages(
  pages: readonly Readonly<HistoryTerminalVerificationInput['pages'][number]>[],
  exchangeTraderId: string,
  url: string
): ValidatedPage[] | null {
  if (pages.length === 0) return null
  const validated: ValidatedPage[] = []
  let stableTotal: number | null | undefined
  let rowsSeen = 0
  const labels = new Set<string>()

  for (const [index, page] of pages.entries()) {
    if (page.pageIndex !== index + 1 || page.url !== url || !isRecord(page.payload)) return null
    const envelope = page.payload
    if (
      !exactKeys(envelope, ['contract', 'portfolioId', 'request', 'response', 'sort']) ||
      envelope.contract !== BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT ||
      envelope.portfolioId !== exchangeTraderId ||
      envelope.sort !== null ||
      !isRecord(envelope.request) ||
      !exactKeys(envelope.request, ['pageNumber', 'pageSize', 'portfolioId']) ||
      envelope.request.pageNumber !== index + 1 ||
      envelope.request.pageSize !== PAGE_SIZE ||
      envelope.request.portfolioId !== exchangeTraderId ||
      !isRecord(envelope.response) ||
      !exactKeys(envelope.response, RESPONSE_FIELDS) ||
      envelope.response.code !== '000000' ||
      envelope.response.success !== true ||
      envelope.response.message !== null ||
      envelope.response.messageDetail !== null ||
      !isRecord(envelope.response.data)
    ) {
      return null
    }
    const data = envelope.response.data
    if (
      !exactKeys(data, DATA_FIELDS) ||
      data.indexValue !== null ||
      !Array.isArray(data.list) ||
      !data.list.every(isRecord) ||
      data.list.length > PAGE_SIZE
    ) {
      return null
    }
    const total = reportedTotal(data.total)
    if (total === undefined || (stableTotal !== undefined && stableTotal !== total)) return null
    if (stableTotal === undefined) stableTotal = total
    const rows = data.list.filter(isRecord)
    for (const row of rows) {
      const projection = copierProjection(row, url)
      if (projection === null || labels.has(projection.label)) return null
      labels.add(projection.label)
    }
    rowsSeen += rows.length
    if (total !== null && rowsSeen > total) return null
    if (index < pages.length - 1 && (rows.length === 0 || rows.length < PAGE_SIZE)) return null
    validated.push({ rows, total })
  }
  return validated
}

function terminalIsExhausted(
  reason: HistoryTerminalClaimReason,
  pages: readonly ValidatedPage[]
): boolean {
  const terminal = pages.at(-1)
  if (!terminal) return false
  const rowsSeen = pages.reduce((sum, page) => sum + page.rows.length, 0)
  if (reason === 'reported_end') return terminal.total !== null && rowsSeen === terminal.total
  if (reason === 'empty_page') return terminal.total === null && terminal.rows.length === 0
  return (
    reason === 'short_page' &&
    terminal.total === null &&
    terminal.rows.length > 0 &&
    terminal.rows.length < PAGE_SIZE
  )
}

function verifyTerminal(input: HistoryTerminalVerificationInput) {
  const url = expectedUrl(input.source.slug)
  if (
    url === null ||
    input.kind !== 'copiers' ||
    input.cursor !== null ||
    input.claim.observations.length !== 1
  ) {
    return { verified: false } as const
  }
  const observation = input.claim.observations[0]
  if (observation.segment_id !== 'default' || observation.page_ordinal !== input.pages.length) {
    return { verified: false } as const
  }
  const pages = validatePages(input.pages, input.exchangeTraderId, url)
  return pages && terminalIsExhausted(observation.reason, pages)
    ? ({ verified: true, scanTerminalState: 'exhausted' } as const)
    : ({ verified: false } as const)
}

function verifyConservation(input: CopierSnapshotVerificationInput) {
  const url = input.pages[0]?.url
  if (url !== BINANCE_COPIER_HISTORY_URLS.futures && url !== BINANCE_COPIER_HISTORY_URLS.spot) {
    return { verified: false } as const
  }
  const pages = validatePages(input.pages, input.exchangeTraderId, url)
  if (!pages) return { verified: false } as const
  const sourceRows = pages.flatMap((page) => page.rows)
  if (sourceRows.length !== input.rows.length) return { verified: false } as const

  // Binance exposes no copier event clock. Production parsing stamps every
  // row with one job-scoped clock captured before the first response. Bind
  // that clock as well as every publishable projection; a raw-object reference
  // and a caller-supplied non-empty hash are not conservation proofs.
  const parsedAt = input.rows[0]?.ts ?? null
  const firstFetchedAt = input.pages[0]?.fetchedAt
  if (
    sourceRows.length > 0 &&
    (parsedAt === null ||
      !isCanonicalPostgresTimestamp(parsedAt) ||
      !isCanonicalPostgresTimestamp(firstFetchedAt) ||
      Date.parse(parsedAt) > Date.parse(firstFetchedAt))
  ) {
    return { verified: false } as const
  }
  const parsedAtMs = parsedAt === null ? Number.NaN : Date.parse(parsedAt)

  const dedupeHashes = new Set<string>()
  for (const [index, row] of input.rows.entries()) {
    const sourceRow = sourceRows[index]
    const projection = copierProjection(sourceRow, url)
    const expectedDuration =
      projection !== null && Number.isFinite(parsedAtMs)
        ? Math.max(0, Math.floor((parsedAtMs - projection.startedAt) / 86_400_000))
        : null
    const expectedHash =
      projection === null
        ? null
        : dedupeHash('binance_cp', input.exchangeTraderId, projection.label, projection.startedAt)
    if (
      projection === null ||
      row.kind !== 'copiers' ||
      row.ts !== parsedAt ||
      row.copierLabel !== projection.label ||
      !Object.is(row.copierPnl, projection.pnl) ||
      !Object.is(row.copierInvested, projection.invested) ||
      !Object.is(row.copyDurationDays, expectedDuration) ||
      row.dedupeHash !== expectedHash ||
      dedupeHashes.has(row.dedupeHash) ||
      row.raw !== sourceRow
    ) {
      return { verified: false } as const
    }
    dedupeHashes.add(row.dedupeHash)
  }
  return { verified: true, envelopeRowCount: sourceRows.length } as const
}

export const binanceCopierSnapshotVerifier: SelectedCopierSnapshotVerifier = Object.freeze({
  contract: BINANCE_COPIER_SNAPSHOT_VERIFIER_CONTRACT,
  verifyTerminal,
  verifyConservation,
})
