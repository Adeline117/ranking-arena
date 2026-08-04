import type {
  HistoryTerminalVerificationInput,
  SelectedHistoryTerminalVerifier,
} from '../../history-acquisition'
import { positionHistorySourceEpochMilliseconds } from '../../position-history-publication-values'

export const OKX_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT =
  'arena.ingest.history-terminal-verifier.okx.position_history@2' as const

const OKX_ORIGIN = 'https://www.okx.com'
const OKX_HISTORY_PATH = '/api/v5/copytrading/public-subpositions-history'
const OKX_HISTORY_PAGE_SIZE = 100

type Dict = Record<string, unknown>
const OKX_USDT_SWAP_SUFFIX = '-USDT-SWAP'

function isRecord(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unicodeCodePointLength(value: string): number {
  let length = 0
  for (const _codePoint of value) length += 1
  return length
}

function canonicalSourceId(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.length > 0 && unicodeCodePointLength(value) <= 512 && value.trim() === value
      ? value
      : null
  }
  return Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : null
}

function canonicalSourceText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return null
  return unicodeCodePointLength(value) <= maximumLength ? value : null
}

function exactHistoryUrl(
  rawUrl: string,
  exchangeTraderId: string,
  expectedAfter: string | null
): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.origin !== OKX_ORIGIN || url.pathname !== OKX_HISTORY_PATH || url.hash !== '') {
    return false
  }
  const expectedKeys =
    expectedAfter === null
      ? ['instType', 'limit', 'uniqueCode']
      : ['after', 'instType', 'limit', 'uniqueCode']
  const keys = [...url.searchParams.keys()].sort()
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return false
  }
  if (
    url.searchParams.getAll('instType').length !== 1 ||
    url.searchParams.get('instType') !== 'SWAP' ||
    url.searchParams.getAll('uniqueCode').length !== 1 ||
    url.searchParams.get('uniqueCode') !== exchangeTraderId ||
    url.searchParams.getAll('limit').length !== 1 ||
    url.searchParams.get('limit') !== '100'
  ) {
    return false
  }
  return expectedAfter === null
    ? !url.searchParams.has('after')
    : url.searchParams.getAll('after').length === 1 &&
        url.searchParams.get('after') === expectedAfter
}

interface ValidatedOkxPage {
  rows: Dict[]
  closeTimes: number[]
  hasPartialRows: boolean
}

export type OkxPositionHistorySourceRowClassification =
  | 'canonical_materialized'
  | 'source_partial_omitted'

export interface ClassifiedOkxPositionHistorySourceRow {
  readonly classification: OkxPositionHistorySourceRowClassification
  readonly closeTime: number | null
  readonly openTime: number
  readonly subPositionId: string
}

/**
 * Classify the exact OKX source lifecycle marker without treating every
 * parser-null close timestamp as a partial row. The public endpoint uses only
 * the empty JSON string for a still-partial leg; null, zero, whitespace and
 * other malformed spellings are neither closed facts nor omission evidence.
 */
export function classifyOkxPositionHistorySourceRow(
  value: unknown,
  fetchedAtMs: number,
  exchangeTraderId: string
): ClassifiedOkxPositionHistorySourceRow | null {
  if (!isRecord(value) || !Number.isFinite(fetchedAtMs)) return null
  const subPositionId = canonicalSourceId(value.subPosId)
  const instrumentId = canonicalSourceText(value.instId, 128)
  const openTime = positionHistorySourceEpochMilliseconds(value.openTime)
  if (
    subPositionId === null ||
    instrumentId === null ||
    openTime === null ||
    openTime > fetchedAtMs ||
    value.uniqueCode !== exchangeTraderId ||
    value.instType !== 'SWAP' ||
    value.ccy !== 'USDT' ||
    (value.posSide !== 'long' && value.posSide !== 'short') ||
    !instrumentId.endsWith(OKX_USDT_SWAP_SUFFIX) ||
    instrumentId.length <= OKX_USDT_SWAP_SUFFIX.length
  ) {
    return null
  }

  if (value.closeTime === '') {
    if (subPositionId.includes('|')) return null
    return Object.freeze({
      classification: 'source_partial_omitted' as const,
      closeTime: null,
      openTime,
      subPositionId,
    })
  }

  const closeTime = positionHistorySourceEpochMilliseconds(value.closeTime)
  if (closeTime === null || closeTime < openTime || closeTime > fetchedAtMs) return null
  return Object.freeze({
    classification: 'canonical_materialized' as const,
    closeTime,
    openTime,
    subPositionId,
  })
}

function validatePages(input: HistoryTerminalVerificationInput): ValidatedOkxPage[] | null {
  if (
    input.source.slug !== 'okx_futures' ||
    input.kind !== 'position_history' ||
    input.pages.length === 0
  ) {
    return null
  }

  const validated: ValidatedOkxPage[] = []
  let expectedAfter: string | null = null
  let previousCloseTime = Number.POSITIVE_INFINITY
  let completedRowsStarted = false
  const subPositionIds = new Set<string>()

  for (const [index, page] of input.pages.entries()) {
    const fetchedAtMs = Date.parse(page.fetchedAt)
    if (
      !Number.isFinite(fetchedAtMs) ||
      page.pageIndex !== index + 1 ||
      !exactHistoryUrl(page.url, input.exchangeTraderId, expectedAfter) ||
      !isRecord(page.payload) ||
      page.payload.historyTraderIdentity !== input.exchangeTraderId ||
      !Array.isArray(page.payload.data) ||
      page.payload.data.length > OKX_HISTORY_PAGE_SIZE ||
      !page.payload.data.every(isRecord)
    ) {
      return null
    }

    const rows = page.payload.data
    const closeTimes: number[] = []
    let hasPartialRows = false
    let lastId: string | null = null
    for (const row of rows) {
      const classified = classifyOkxPositionHistorySourceRow(
        row,
        fetchedAtMs,
        input.exchangeTraderId
      )
      if (
        classified === null ||
        subPositionIds.has(classified.subPositionId) ||
        (classified.classification === 'source_partial_omitted' && completedRowsStarted)
      ) {
        return null
      }
      subPositionIds.add(classified.subPositionId)
      if (classified.classification === 'source_partial_omitted') {
        hasPartialRows = true
      } else {
        completedRowsStarted = true
        if (classified.closeTime === null || classified.closeTime > previousCloseTime) return null
        closeTimes.push(classified.closeTime)
        previousCloseTime = classified.closeTime
      }
      lastId = classified.subPositionId
    }

    validated.push({ rows, closeTimes, hasPartialRows })
    expectedAfter = lastId
  }
  return validated
}

function verifyOkxPositionHistoryTerminal(input: HistoryTerminalVerificationInput) {
  const observations = input.claim.observations
  if (
    observations.length !== 1 ||
    observations[0].segment_id !== 'default' ||
    observations[0].page_ordinal !== input.pages.length
  ) {
    return { verified: false } as const
  }

  const pages = validatePages(input)
  if (!pages) return { verified: false } as const
  const terminalPage = pages.at(-1)
  if (!terminalPage) return { verified: false } as const

  if (observations[0].reason === 'empty_page') {
    if (terminalPage.rows.length !== 0) return { verified: false } as const
    if (pages.slice(0, -1).some((page) => page.rows.length === 0)) {
      return { verified: false } as const
    }
    return { verified: true, scanTerminalState: 'exhausted' } as const
  }

  if (observations[0].reason === 'cursor_overlap') {
    if (
      input.cursor === null ||
      terminalPage.closeTimes.length === 0 ||
      pages.some((page) => page.hasPartialRows)
    ) {
      return { verified: false } as const
    }
    if (pages.slice(0, -1).some((page) => page.rows.length === 0)) {
      return { verified: false } as const
    }
    const cursorMs = Date.parse(input.cursor)
    const oldestCloseTime = Math.min(...terminalPage.closeTimes)
    if (!Number.isFinite(cursorMs) || oldestCloseTime > cursorMs) {
      return { verified: false } as const
    }
    return {
      verified: true,
      scanTerminalState: 'cursor_overlap',
      overlapEventAt: new Date(oldestCloseTime).toISOString(),
    } as const
  }

  return { verified: false } as const
}

export const okxPositionHistoryTerminalVerifier: SelectedHistoryTerminalVerifier = Object.freeze({
  contract: OKX_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT,
  verify: verifyOkxPositionHistoryTerminal,
})
