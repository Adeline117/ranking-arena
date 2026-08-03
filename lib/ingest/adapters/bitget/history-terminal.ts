import type {
  HistoryTerminalVerificationInput,
  SelectedHistoryTerminalVerifier,
} from '../../history-acquisition'

export const BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT = 'arena.ingest.bitget-history-page@1' as const
export const BITGET_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT =
  'arena.ingest.history-terminal-verifier.bitget.position_history@1' as const

export const BITGET_POSITION_HISTORY_URL =
  'https://www.bitget.com/v1/trigger/trace/order/historyList' as const
const POSITION_PAGE_SIZE = 20

type Dict = Record<string, unknown>

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

interface ValidatedBitgetPage {
  rows: Dict[]
  closeTimes: number[]
  nextFlag: boolean | null
}

function validatePages(input: HistoryTerminalVerificationInput): ValidatedBitgetPage[] | null {
  if (
    input.source.slug !== 'bitget_futures' ||
    input.kind !== 'position_history' ||
    input.pages.length === 0
  ) {
    return null
  }

  const validated: ValidatedBitgetPage[] = []
  const factIds = new Set<string>()
  let previousCloseTime = Number.POSITIVE_INFINITY

  for (const [index, page] of input.pages.entries()) {
    if (
      page.pageIndex !== index + 1 ||
      page.url !== BITGET_POSITION_HISTORY_URL ||
      !isRecord(page.payload)
    ) {
      return null
    }
    const envelope = page.payload
    if (
      !exactKeys(envelope, ['contract', 'historyTraderIdentity', 'request', 'response']) ||
      envelope.contract !== BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT ||
      envelope.historyTraderIdentity !== input.exchangeTraderId ||
      !isRecord(envelope.request) ||
      !exactKeys(envelope.request, ['pageNo', 'pageSize', 'traderUid']) ||
      envelope.request.pageNo !== index + 1 ||
      envelope.request.pageSize !== POSITION_PAGE_SIZE ||
      envelope.request.traderUid !== input.exchangeTraderId ||
      !isRecord(envelope.response) ||
      envelope.response.code !== '00000' ||
      !isRecord(envelope.response.data)
    ) {
      return null
    }
    const data = envelope.response.data
    const rawRows = data.rows
    if (!Array.isArray(rawRows) || !rawRows.every(isRecord)) return null
    const rows = rawRows.filter(isRecord)
    if (rows.length > POSITION_PAGE_SIZE) return null
    if (
      data.nextFlag !== undefined &&
      data.nextFlag !== null &&
      typeof data.nextFlag !== 'boolean'
    ) {
      return null
    }
    const closeTimes: number[] = []
    for (const row of rows) {
      const factId = canonicalSourceId(row.orderNo)
      const closeTime = positiveEpochMs(row.closeTime)
      if (
        factId === null ||
        factIds.has(factId) ||
        closeTime === null ||
        closeTime > previousCloseTime
      ) {
        return null
      }
      factIds.add(factId)
      closeTimes.push(closeTime)
      previousCloseTime = closeTime
    }
    validated.push({ rows, closeTimes, nextFlag: data.nextFlag ?? null })
  }

  if (
    validated
      .slice(0, -1)
      .some((page) => page.rows.length !== POSITION_PAGE_SIZE || page.nextFlag === false)
  ) {
    return null
  }
  return validated
}

function verifyBitgetPositionHistoryTerminal(input: HistoryTerminalVerificationInput) {
  const observations = input.claim.observations
  if (
    observations.length !== 1 ||
    observations[0].segment_id !== 'default' ||
    observations[0].page_ordinal !== input.pages.length
  ) {
    return { verified: false } as const
  }

  const pages = validatePages(input)
  const terminalPage = pages?.at(-1)
  if (!pages || !terminalPage) return { verified: false } as const

  switch (observations[0].reason) {
    case 'reported_end':
      return terminalPage.nextFlag === false
        ? ({ verified: true, scanTerminalState: 'exhausted' } as const)
        : ({ verified: false } as const)
    case 'short_page':
      return terminalPage.rows.length > 0 &&
        terminalPage.rows.length < POSITION_PAGE_SIZE &&
        terminalPage.nextFlag !== true &&
        terminalPage.nextFlag !== false
        ? ({ verified: true, scanTerminalState: 'exhausted' } as const)
        : ({ verified: false } as const)
    case 'empty_page':
      return terminalPage.rows.length === 0 && terminalPage.nextFlag === null
        ? ({ verified: true, scanTerminalState: 'exhausted' } as const)
        : ({ verified: false } as const)
    case 'cursor_overlap': {
      if (
        input.cursor === null ||
        terminalPage.rows.length !== POSITION_PAGE_SIZE ||
        terminalPage.nextFlag === false
      ) {
        return { verified: false } as const
      }
      const cursorMs = Date.parse(input.cursor)
      const priorOverlaps = pages
        .slice(0, -1)
        .some((page) => Math.min(...page.closeTimes) <= cursorMs)
      const oldestCloseTime = Math.min(...terminalPage.closeTimes)
      if (!Number.isFinite(cursorMs) || priorOverlaps || oldestCloseTime > cursorMs) {
        return { verified: false } as const
      }
      return {
        verified: true,
        scanTerminalState: 'cursor_overlap',
        overlapEventAt: new Date(oldestCloseTime).toISOString(),
      } as const
    }
    default:
      return { verified: false } as const
  }
}

export const bitgetPositionHistoryTerminalVerifier: SelectedHistoryTerminalVerifier = Object.freeze(
  {
    contract: BITGET_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT,
    verify: verifyBitgetPositionHistoryTerminal,
  }
)
