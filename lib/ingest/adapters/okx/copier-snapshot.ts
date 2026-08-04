import type {
  CopierSnapshotVerificationInput,
  SelectedCopierSnapshotVerifier,
} from '../../core/adapter'
import type { HistoryTerminalVerificationInput } from '../../history-acquisition'
import { dedupeHash } from './parsers'

export const OKX_COPIER_SNAPSHOT_VERIFIER_CONTRACT =
  'arena.ingest.history-terminal-verifier.okx.copiers@1' as const
export const OKX_COPIER_HISTORY_URL =
  'https://www.okx.com/api/v5/copytrading/public-copy-traders' as const

const MAX_COPIER_ROWS = 10
const DAY_MS = 86_400_000

type Dict = Record<string, unknown>

interface ValidatedSnapshot {
  block: Dict | null
  rows: Dict[]
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

function canonicalLabel(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.trim() === value ? value : null
}

function canonicalNumericString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) &&
    Number.isFinite(Number(value))
  )
}

function canonicalPositiveEpoch(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return false
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0
}

function canonicalHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value) return false
  try {
    const parsed = new URL(value)
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.hash === ''
    )
  } catch {
    return false
  }
}

export function okxCopierHistoryUrl(exchangeTraderId: string): string {
  return (
    `${OKX_COPIER_HISTORY_URL}?instType=SWAP&uniqueCode=` + encodeURIComponent(exchangeTraderId)
  )
}

function validateCopierItem(value: unknown): value is Dict {
  if (!isRecord(value) || !exactKeys(value, ['beginCopyTime', 'nickName', 'pnl', 'portLink'])) {
    return false
  }
  return (
    canonicalPositiveEpoch(value.beginCopyTime) &&
    canonicalLabel(value.nickName) !== null &&
    canonicalNumericString(value.pnl) &&
    canonicalHttpsUrl(value.portLink)
  )
}

function validateEnvelope(value: unknown): ValidatedSnapshot | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['code', 'data', 'msg']) ||
    value.code !== '0' ||
    value.msg !== '' ||
    !Array.isArray(value.data) ||
    value.data.length > 1
  ) {
    return null
  }

  if (value.data.length === 0) return { block: null, rows: [] }

  const block = value.data[0]
  if (
    !isRecord(block) ||
    !exactKeys(block, [
      'ccy',
      'copyTotalPnl',
      'copyTraderNumChg',
      'copyTraderNumChgRatio',
      'copyTraders',
    ]) ||
    block.ccy !== 'USDT' ||
    !canonicalNumericString(block.copyTotalPnl) ||
    !canonicalNumericString(block.copyTraderNumChg) ||
    !canonicalNumericString(block.copyTraderNumChgRatio) ||
    !Array.isArray(block.copyTraders) ||
    block.copyTraders.length > MAX_COPIER_ROWS ||
    !block.copyTraders.every(validateCopierItem)
  ) {
    return null
  }

  return { block, rows: block.copyTraders }
}

function validatePages(
  pages: readonly Readonly<HistoryTerminalVerificationInput['pages'][number]>[],
  exchangeTraderId: string
): ValidatedSnapshot | null {
  if (pages.length !== 1) return null
  const page = pages[0]
  if (page.pageIndex !== 1 || page.url !== okxCopierHistoryUrl(exchangeTraderId)) return null
  return validateEnvelope(page.payload)
}

function verifyTerminal(input: HistoryTerminalVerificationInput) {
  if (
    input.source.slug !== 'okx_futures' ||
    input.kind !== 'copiers' ||
    input.cursor !== null ||
    input.claim.observations.length !== 1
  ) {
    return { verified: false } as const
  }
  const observation = input.claim.observations[0]
  if (
    observation.segment_id !== 'default' ||
    observation.reason !== 'snapshot_complete' ||
    observation.page_ordinal !== 1
  ) {
    return { verified: false } as const
  }
  return validatePages(input.pages, input.exchangeTraderId)
    ? ({ verified: true, scanTerminalState: 'exhausted' } as const)
    : ({ verified: false } as const)
}

function derivedRawMatches(rowRaw: Dict, sourceRow: Dict, block: Dict): boolean {
  const expected = {
    ...sourceRow,
    copy_total_pnl: block.copyTotalPnl,
    copy_trader_num_chg: block.copyTraderNumChg,
  }
  return (
    exactKeys(rowRaw, Object.keys(expected)) &&
    Object.entries(expected).every(([key, value]) => rowRaw[key] === value)
  )
}

function verifyConservation(input: CopierSnapshotVerificationInput) {
  const snapshot = validatePages(input.pages, input.exchangeTraderId)
  if (!snapshot || snapshot.rows.length !== input.rows.length) {
    return { verified: false } as const
  }

  if (snapshot.rows.length === 0) {
    return { verified: true, envelopeRowCount: 0 } as const
  }
  if (snapshot.block === null) return { verified: false } as const

  const hashes = new Set<string>()
  for (const [index, row] of input.rows.entries()) {
    const sourceRow = snapshot.rows[index]
    const label = canonicalLabel(sourceRow.nickName)
    const beginCopyTime = Number(sourceRow.beginCopyTime)
    const rowTimestamp = Date.parse(row.ts)
    const expectedDuration =
      Number.isFinite(rowTimestamp) && rowTimestamp > beginCopyTime
        ? Math.floor((rowTimestamp - beginCopyTime) / DAY_MS)
        : null
    const expectedHash = dedupeHash('okx_cp', label, sourceRow.beginCopyTime)

    if (
      label === null ||
      row.kind !== 'copiers' ||
      !Number.isFinite(rowTimestamp) ||
      new Date(rowTimestamp).toISOString() !== row.ts ||
      row.copierLabel !== label ||
      row.copierPnl !== Number(sourceRow.pnl) ||
      row.copierInvested !== null ||
      row.copyDurationDays !== expectedDuration ||
      row.dedupeHash !== expectedHash ||
      hashes.has(row.dedupeHash) ||
      !isRecord(row.raw) ||
      !derivedRawMatches(row.raw, sourceRow, snapshot.block)
    ) {
      return { verified: false } as const
    }
    hashes.add(row.dedupeHash)
  }

  return { verified: true, envelopeRowCount: snapshot.rows.length } as const
}

export const okxCopierSnapshotVerifier: SelectedCopierSnapshotVerifier = Object.freeze({
  contract: OKX_COPIER_SNAPSHOT_VERIFIER_CONTRACT,
  verifyTerminal,
  verifyConservation,
})
