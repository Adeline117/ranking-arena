import type {
  HistoryTerminalClaimReason,
  HistoryTerminalVerificationInput,
  SelectedHistoryTerminalVerifier,
} from '../../history-acquisition'
import {
  BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
  BINANCE_POSITION_HISTORY_URL,
} from './history-contract'

export const BINANCE_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT =
  'arena.ingest.history-terminal-verifier.binance.position_history@1' as const

const POSITION_PAGE_SIZE = 50
const EXHAUSTIVE_REASONS: readonly HistoryTerminalClaimReason[] = ['reported_end', 'empty_page']

type Dict = Record<string, unknown>
type PositionSort = 'CLOSING' | 'OPENING'

function isRecord(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Dict, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function canonicalSourceId(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.length > 0 && value.trim() === value ? value : null
  }
  return Number.isSafeInteger(value) ? String(value) : null
}

function canonicalSourceText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.trim() === value ? value : null
}

function positiveEpochMs(value: unknown): number | null {
  if (
    (typeof value !== 'string' && typeof value !== 'number') ||
    (typeof value === 'string' && (value.length === 0 || value.trim() !== value))
  ) {
    return null
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null
  try {
    new Date(parsed).toISOString()
    return parsed
  } catch {
    return null
  }
}

function reportedTotal(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

interface ValidatedSegment {
  factIds: Set<string>
  reportedTotal: number | null
  overlapEventAt: string | null
}

function validateSegment(
  input: HistoryTerminalVerificationInput,
  startOrdinal: number,
  endOrdinal: number,
  segmentId: 'closing' | 'opening',
  terminalReason: HistoryTerminalClaimReason
): ValidatedSegment | null {
  const sort: PositionSort = segmentId === 'closing' ? 'CLOSING' : 'OPENING'
  const pages = input.pages.slice(startOrdinal - 1, endOrdinal)
  if (pages.length === 0) return null

  let total: number | null | undefined
  let rowsSeen = 0
  let previousSortTime = Number.POSITIVE_INFINITY
  const factIds = new Set<string>()
  const pageCloseTimes: number[][] = []

  for (const [index, page] of pages.entries()) {
    const localPageNumber = index + 1
    if (
      page.pageIndex !== localPageNumber ||
      page.url !== BINANCE_POSITION_HISTORY_URL ||
      !isRecord(page.payload)
    ) {
      return null
    }
    const envelope = page.payload
    if (
      !exactKeys(envelope, ['contract', 'portfolioId', 'request', 'response', 'sort']) ||
      envelope.contract !== BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT ||
      envelope.portfolioId !== input.exchangeTraderId ||
      envelope.sort !== sort ||
      !isRecord(envelope.request) ||
      !exactKeys(envelope.request, ['pageNumber', 'pageSize', 'portfolioId', 'sort']) ||
      envelope.request.pageNumber !== localPageNumber ||
      envelope.request.pageSize !== POSITION_PAGE_SIZE ||
      envelope.request.portfolioId !== input.exchangeTraderId ||
      envelope.request.sort !== sort ||
      !isRecord(envelope.response) ||
      envelope.response.code !== '000000' ||
      envelope.response.success !== true ||
      !isRecord(envelope.response.data)
    ) {
      return null
    }

    const data = envelope.response.data
    const rawRows = data.list
    if (!Array.isArray(rawRows) || !rawRows.every(isRecord)) return null
    const rows = rawRows.filter(isRecord)
    if (rows.length > POSITION_PAGE_SIZE) return null

    const pageTotal = reportedTotal(data.total)
    if (pageTotal === undefined) return null
    if (total === undefined) total = pageTotal
    else if (total !== pageTotal) return null

    const closeTimes: number[] = []
    for (const row of rows) {
      const sourceId = canonicalSourceId(row.id)
      const symbol = canonicalSourceText(row.symbol)
      const side = canonicalSourceText(row.side)
      const openedAt = positiveEpochMs(row.opened)
      const closedAt = positiveEpochMs(row.closed)
      if (
        sourceId === null ||
        symbol === null ||
        side === null ||
        row.status !== 'All Closed' ||
        openedAt === null ||
        closedAt === null ||
        closedAt < openedAt
      ) {
        return null
      }
      const sortTime = sort === 'CLOSING' ? closedAt : openedAt
      if (sortTime > previousSortTime) return null
      previousSortTime = sortTime

      const factId = JSON.stringify([input.exchangeTraderId, sourceId, symbol, side])
      if (factIds.has(factId)) return null
      factIds.add(factId)
      closeTimes.push(closedAt)
    }
    pageCloseTimes.push(closeTimes)
    rowsSeen += rows.length
    if (total !== null && rowsSeen > total) return null
    if (index < pages.length - 1) {
      if (rows.length === 0 || (total !== null && rowsSeen === total)) return null
    }
  }

  if (total === undefined) return null
  const terminalRows = pageCloseTimes.at(-1) ?? []
  switch (terminalReason) {
    case 'reported_end':
      return total !== null && rowsSeen === total
        ? { factIds, reportedTotal: total, overlapEventAt: null }
        : null
    case 'empty_page':
      return total === null && terminalRows.length === 0
        ? { factIds, reportedTotal: null, overlapEventAt: null }
        : null
    case 'cursor_overlap': {
      if (segmentId !== 'closing' || input.cursor === null || terminalRows.length === 0) {
        return null
      }
      const cursorMs = Date.parse(input.cursor)
      const priorOverlaps = pageCloseTimes
        .slice(0, -1)
        .some((closeTimes) => Math.min(...closeTimes) <= cursorMs)
      const oldestCloseTime = Math.min(...terminalRows)
      if (
        !Number.isFinite(cursorMs) ||
        priorOverlaps ||
        oldestCloseTime > cursorMs ||
        (total !== null && rowsSeen >= total)
      ) {
        return null
      }
      return {
        factIds,
        reportedTotal: total ?? null,
        overlapEventAt: new Date(oldestCloseTime).toISOString(),
      }
    }
    default:
      return null
  }
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value))
}

function verifyBinancePositionHistoryTerminal(input: HistoryTerminalVerificationInput) {
  if (
    input.source.slug !== 'binance_futures' ||
    input.kind !== 'position_history' ||
    input.pages.length === 0
  ) {
    return { verified: false } as const
  }

  const observations = input.claim.observations
  if (input.cursor === null) {
    if (
      observations.length !== 2 ||
      observations[0].segment_id !== 'closing' ||
      observations[1].segment_id !== 'opening' ||
      observations[1].page_ordinal !== input.pages.length ||
      !EXHAUSTIVE_REASONS.includes(observations[0].reason) ||
      !EXHAUSTIVE_REASONS.includes(observations[1].reason)
    ) {
      return { verified: false } as const
    }
    const closing = validateSegment(
      input,
      1,
      observations[0].page_ordinal,
      'closing',
      observations[0].reason
    )
    const opening = validateSegment(
      input,
      observations[0].page_ordinal + 1,
      observations[1].page_ordinal,
      'opening',
      observations[1].reason
    )
    if (!closing || !opening || !sameSet(closing.factIds, opening.factIds)) {
      return { verified: false } as const
    }
    if (
      closing.reportedTotal !== null &&
      opening.reportedTotal !== null &&
      closing.reportedTotal !== opening.reportedTotal
    ) {
      return { verified: false } as const
    }
    return { verified: true, scanTerminalState: 'exhausted' } as const
  }

  if (
    observations.length !== 1 ||
    observations[0].segment_id !== 'closing' ||
    observations[0].page_ordinal !== input.pages.length ||
    (observations[0].reason !== 'cursor_overlap' &&
      !EXHAUSTIVE_REASONS.includes(observations[0].reason))
  ) {
    return { verified: false } as const
  }
  const closing = validateSegment(
    input,
    1,
    observations[0].page_ordinal,
    'closing',
    observations[0].reason
  )
  if (!closing) return { verified: false } as const
  return observations[0].reason === 'cursor_overlap' && closing.overlapEventAt !== null
    ? ({
        verified: true,
        scanTerminalState: 'cursor_overlap',
        overlapEventAt: closing.overlapEventAt,
      } as const)
    : ({ verified: true, scanTerminalState: 'exhausted' } as const)
}

export const binancePositionHistoryTerminalVerifier: SelectedHistoryTerminalVerifier =
  Object.freeze({
    contract: BINANCE_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT,
    verify: verifyBinancePositionHistoryTerminal,
  })
