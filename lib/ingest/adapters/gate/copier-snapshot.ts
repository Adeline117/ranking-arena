import type {
  CopierSnapshotVerificationInput,
  SelectedCopierSnapshotVerifier,
} from '../../core/adapter'
import type { HistoryTerminalVerificationInput } from '../../history-acquisition'
import { isCanonicalPostgresTimestamp } from '../../postgres-timestamp'
import { dedupeHash } from './parsers'

export const GATE_COPIER_SNAPSHOT_VERIFIER_CONTRACT =
  'arena.ingest.history-terminal-verifier.gate.copiers@1' as const
export const GATE_COPIER_HISTORY_URL =
  'https://www.gate.com/api/copytrade/copy_trading/trader/follow_user' as const
export const GATE_COPIER_PAGE_SIZE = 10 as const

const ENVELOPE_FIELDS = [
  'code',
  'data',
  'label',
  'message',
  'page',
  'pagecount',
  'pagesize',
  'totalcount',
] as const

// Exact candidate shape captured from the public futures follow_user endpoint
// on 2026-06-11. Additions/removals are contract drift, not publication-safe
// metadata: retain the RAW page, then fail this reviewed verifier closed.
const COPIER_FIELDS = [
  'auto_margin',
  'available_balance',
  'coupon_type',
  'create_time',
  'curated_option',
  'finish_as',
  'finish_time',
  'follow_asset',
  'follow_day',
  'follow_fee',
  'follow_fee_rate',
  'follow_id',
  'follow_mode',
  'follow_money',
  'follow_update_market',
  'follow_user_info',
  'is_end_claim',
  'label_list',
  'last_follow_money',
  'leader_id',
  'leader_private_link_id',
  'leader_status',
  'loss_num',
  'margin_trigger_rate',
  'markets',
  'max_claim_price',
  'max_follow_amount',
  'max_supplement',
  'next_fee_time',
  'position_copy_type',
  'profit',
  'profit_rate',
  'remove_follower_limit',
  'risk_control_type',
  'source',
  'status',
  'supplement_num',
  'supplement_rate',
  'text_label_list',
  'total_stop_loss',
  'trade_num',
  'trader_level',
  'unrealised_pnl',
  'update_time',
  'voucher_id',
  'win_num',
  'withdraw',
] as const

type Dict = Record<string, unknown>

export interface ValidatedGateCopierPage {
  rows: Dict[]
  total: number
  totalPages: number
}

interface GateCopierProjection {
  identity: string
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

function positiveSafeInteger(value: unknown): value is number {
  return nonNegativeSafeInteger(value) && value > 0
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

function gateCopierProjection(
  value: unknown,
  exchangeTraderId: string
): GateCopierProjection | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, COPIER_FIELDS) ||
    !positiveSafeInteger(value.follow_id) ||
    !positiveSafeInteger(value.leader_id) ||
    String(value.leader_id) !== exchangeTraderId ||
    !positiveSafeInteger(value.create_time) ||
    !nonNegativeSafeInteger(value.follow_day) ||
    !canonicalFiniteDecimal(value.profit, true) ||
    !canonicalFiniteDecimal(value.follow_money, false)
  ) {
    return null
  }

  return {
    identity: String(value.follow_id),
    label: String(value.follow_id),
    pnl: Number(value.profit),
    invested: Number(value.follow_money),
    durationDays: value.follow_day,
    dedupeHash: dedupeHash('gate_cp', value.follow_id, value.create_time),
  }
}

export function gateCopierHistoryUrl(exchangeTraderId: string, page: number): string {
  if (
    exchangeTraderId.length === 0 ||
    exchangeTraderId.trim() !== exchangeTraderId ||
    !Number.isSafeInteger(page) ||
    page <= 0 ||
    Object.is(page, -0)
  ) {
    throw new TypeError('[gate] copier request coordinates are invalid')
  }
  return (
    `${GATE_COPIER_HISTORY_URL}?sub_website_id=0` +
    `&leader_id=${encodeURIComponent(exchangeTraderId)}` +
    `&page_size=${GATE_COPIER_PAGE_SIZE}&page=${page}&status=running`
  )
}

export function validateGateCopierPage(
  value: unknown,
  expectedPage: number,
  exchangeTraderId: string
): ValidatedGateCopierPage | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ENVELOPE_FIELDS) ||
    value.code !== 200 ||
    value.label !== '' ||
    value.message !== '' ||
    value.page !== expectedPage ||
    value.pagesize !== GATE_COPIER_PAGE_SIZE ||
    !nonNegativeSafeInteger(value.totalcount) ||
    !nonNegativeSafeInteger(value.pagecount) ||
    !Array.isArray(value.data) ||
    !value.data.every(isRecord)
  ) {
    return null
  }

  const total = value.totalcount
  const totalPages = Math.ceil(total / GATE_COPIER_PAGE_SIZE)
  const expectedRows = Math.min(
    GATE_COPIER_PAGE_SIZE,
    Math.max(total - (expectedPage - 1) * GATE_COPIER_PAGE_SIZE, 0)
  )
  if (
    value.pagecount !== totalPages ||
    value.data.length !== expectedRows ||
    (total > 0 && (expectedPage < 1 || expectedPage > totalPages)) ||
    (total === 0 && expectedPage !== 1)
  ) {
    return null
  }

  const identities = new Set<string>()
  for (const row of value.data) {
    const projection = gateCopierProjection(row, exchangeTraderId)
    if (projection === null || identities.has(projection.identity)) return null
    identities.add(projection.identity)
  }

  return { rows: value.data, total, totalPages }
}

function validatePages(
  pages: readonly Readonly<HistoryTerminalVerificationInput['pages'][number]>[],
  exchangeTraderId: string
): ValidatedGateCopierPage[] | null {
  if (pages.length === 0) return null

  const validated: ValidatedGateCopierPage[] = []
  const identities = new Set<string>()
  let stableTotal: number | null = null
  let stableTotalPages: number | null = null

  for (const [index, page] of pages.entries()) {
    const pageNumber = index + 1
    if (
      page.pageIndex !== pageNumber ||
      page.url !== gateCopierHistoryUrl(exchangeTraderId, pageNumber)
    ) {
      return null
    }
    const parsed = validateGateCopierPage(page.payload, pageNumber, exchangeTraderId)
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
      const projection = gateCopierProjection(row, exchangeTraderId)
      if (projection === null || identities.has(projection.identity)) return null
      identities.add(projection.identity)
    }
    validated.push(parsed)
  }

  if (stableTotal === null || stableTotalPages === null) return null
  const expectedPageCount = Math.max(1, stableTotalPages)
  return pages.length === expectedPageCount && identities.size === stableTotal ? validated : null
}

function verifyTerminal(input: HistoryTerminalVerificationInput) {
  if (
    input.source.slug !== 'gate_futures' ||
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

  // This endpoint's create_time is the beginning of a follow relationship,
  // not the observation time of the live snapshot. The parser therefore owns
  // one job-scoped clock, captured before acquisition and shared by every row.
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

  const identities = new Set<string>()
  const hashes = new Set<string>()
  for (const [index, row] of input.rows.entries()) {
    const sourceRow = sourceRows[index]
    const projection = gateCopierProjection(sourceRow, input.exchangeTraderId)
    if (
      projection === null ||
      identities.has(projection.identity) ||
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
    identities.add(projection.identity)
    hashes.add(row.dedupeHash)
  }

  return { verified: true, envelopeRowCount: sourceRows.length } as const
}

export const gateCopierSnapshotVerifier: SelectedCopierSnapshotVerifier = Object.freeze({
  contract: GATE_COPIER_SNAPSHOT_VERIFIER_CONTRACT,
  verifyTerminal,
  verifyConservation,
})
