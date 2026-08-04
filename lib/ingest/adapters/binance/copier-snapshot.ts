import type {
  CopierSnapshotVerificationInput,
  SelectedCopierSnapshotVerifier,
} from '../../core/adapter'
import type {
  HistoryTerminalClaimReason,
  HistoryTerminalVerificationInput,
} from '../../history-acquisition'
import {
  BINANCE_COPIER_HISTORY_URLS,
  BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
} from './history-contract'

export const BINANCE_COPIER_SNAPSHOT_VERIFIER_CONTRACT =
  'arena.ingest.history-terminal-verifier.binance.copiers@1' as const

const PAGE_SIZE = 50
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

function canonicalLabel(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.length > 0 && value.trim() === value ? value : null
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
      envelope.response.code !== '000000' ||
      envelope.response.success !== true ||
      !isRecord(envelope.response.data)
    ) {
      return null
    }
    const data = envelope.response.data
    if (!Array.isArray(data.list) || !data.list.every(isRecord) || data.list.length > PAGE_SIZE) {
      return null
    }
    const total = reportedTotal(data.total)
    if (total === undefined || (stableTotal !== undefined && stableTotal !== total)) return null
    if (stableTotal === undefined) stableTotal = total
    const rows = data.list.filter(isRecord)
    for (const row of rows) {
      const label = canonicalLabel(row.copyPortfolioId ?? row.nickname)
      if (label === null || labels.has(label)) return null
      labels.add(label)
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

  const dedupeHashes = new Set<string>()
  for (const [index, row] of input.rows.entries()) {
    if (
      row.kind !== 'copiers' ||
      row.raw !== sourceRows[index] ||
      typeof row.dedupeHash !== 'string' ||
      row.dedupeHash.length === 0 ||
      dedupeHashes.has(row.dedupeHash)
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
