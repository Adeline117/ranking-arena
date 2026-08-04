import type {
  CopierSnapshotVerificationInput,
  SelectedCopierSnapshotVerifier,
} from '../../core/adapter'
import type { HistoryTerminalVerificationInput } from '../../history-acquisition'
import { BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT } from './history-terminal'

export const BITGET_COPIER_HISTORY_URL =
  'https://www.bitget.com/v1/trigger/trace/trader/followerList' as const
export const BITGET_COPIER_SNAPSHOT_VERIFIER_CONTRACT =
  'arena.ingest.history-terminal-verifier.bitget.copiers@1' as const

const PAGE_SIZE = 10
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
  return typeof value === 'string' && value.length > 0 && value.trim() === value ? value : null
}

interface ValidatedPage {
  rows: Dict[]
  nextFlag: boolean | null
}

function validatePages(
  pages: readonly Readonly<HistoryTerminalVerificationInput['pages'][number]>[],
  exchangeTraderId: string
): ValidatedPage[] | null {
  if (pages.length === 0) return null
  const validated: ValidatedPage[] = []
  const labels = new Set<string>()

  for (const [index, page] of pages.entries()) {
    if (
      page.pageIndex !== index + 1 ||
      page.url !== BITGET_COPIER_HISTORY_URL ||
      !isRecord(page.payload)
    ) {
      return null
    }
    const envelope = page.payload
    if (
      !exactKeys(envelope, ['contract', 'historyTraderIdentity', 'request', 'response']) ||
      envelope.contract !== BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT ||
      envelope.historyTraderIdentity !== exchangeTraderId ||
      !isRecord(envelope.request) ||
      !exactKeys(envelope.request, ['pageNo', 'pageSize', 'traderUid']) ||
      envelope.request.pageNo !== index + 1 ||
      envelope.request.pageSize !== PAGE_SIZE ||
      envelope.request.traderUid !== exchangeTraderId ||
      !isRecord(envelope.response) ||
      envelope.response.code !== '00000' ||
      envelope.response.success !== true ||
      !isRecord(envelope.response.data)
    ) {
      return null
    }
    const data = envelope.response.data
    if (!Array.isArray(data.rows) || !data.rows.every(isRecord) || data.rows.length > PAGE_SIZE) {
      return null
    }
    if (
      data.nextFlag !== undefined &&
      data.nextFlag !== null &&
      typeof data.nextFlag !== 'boolean'
    ) {
      return null
    }
    const rows = data.rows.filter(isRecord)
    for (const row of rows) {
      const label = canonicalLabel(row.userName ?? row.displayName ?? row.followerNickName)
      if (label === null || labels.has(label)) return null
      labels.add(label)
    }
    validated.push({ rows, nextFlag: data.nextFlag ?? null })
  }

  if (
    validated.slice(0, -1).some((page) => page.rows.length !== PAGE_SIZE || page.nextFlag === false)
  ) {
    return null
  }
  return validated
}

function verifyTerminal(input: HistoryTerminalVerificationInput) {
  if (
    input.source.slug !== 'bitget_futures' ||
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
  const terminalPage = validatePages(input.pages, input.exchangeTraderId)?.at(-1)
  if (!terminalPage) return { verified: false } as const

  const exhausted =
    (observation.reason === 'reported_end' && terminalPage.nextFlag === false) ||
    (observation.reason === 'empty_page' &&
      terminalPage.rows.length === 0 &&
      terminalPage.nextFlag === null) ||
    (observation.reason === 'short_page' &&
      terminalPage.rows.length > 0 &&
      terminalPage.rows.length < PAGE_SIZE &&
      terminalPage.nextFlag === null)

  return exhausted
    ? ({ verified: true, scanTerminalState: 'exhausted' } as const)
    : ({ verified: false } as const)
}

function verifyConservation(input: CopierSnapshotVerificationInput) {
  const pages = validatePages(input.pages, input.exchangeTraderId)
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

export const bitgetCopierSnapshotVerifier: SelectedCopierSnapshotVerifier = Object.freeze({
  contract: BITGET_COPIER_SNAPSHOT_VERIFIER_CONTRACT,
  verifyTerminal,
  verifyConservation,
})
