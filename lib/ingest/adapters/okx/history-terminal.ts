import type {
  HistoryTerminalVerificationInput,
  SelectedHistoryTerminalVerifier,
} from '../../history-acquisition'

export const OKX_POSITION_HISTORY_TERMINAL_VERIFIER_CONTRACT =
  'arena.ingest.history-terminal-verifier.okx.position_history@1' as const

const OKX_ORIGIN = 'https://www.okx.com'
const OKX_HISTORY_PATH = '/api/v5/copytrading/public-subpositions-history'

type Dict = Record<string, unknown>

function isRecord(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalSourceId(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.length > 0 && value.trim() === value ? value : null
  }
  return Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : null
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

  for (const [index, page] of input.pages.entries()) {
    if (
      page.pageIndex !== index + 1 ||
      !exactHistoryUrl(page.url, input.exchangeTraderId, expectedAfter) ||
      !isRecord(page.payload) ||
      page.payload.historyTraderIdentity !== input.exchangeTraderId ||
      !Array.isArray(page.payload.data) ||
      !page.payload.data.every(isRecord)
    ) {
      return null
    }

    const rows = page.payload.data
    const closeTimes: number[] = []
    for (const row of rows) {
      const closeTime = positiveEpochMs(row.closeTime)
      if (closeTime === null || closeTime > previousCloseTime) return null
      closeTimes.push(closeTime)
      previousCloseTime = closeTime
    }

    const lastId = rows.length === 0 ? null : canonicalSourceId(rows.at(-1)?.subPosId)
    if (rows.length > 0 && lastId === null) return null
    validated.push({ rows, closeTimes })
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
    if (input.cursor === null || terminalPage.closeTimes.length === 0) {
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
