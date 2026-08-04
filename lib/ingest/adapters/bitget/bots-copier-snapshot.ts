import { createHash } from 'node:crypto'

import type {
  CopierSnapshotVerificationInput,
  SelectedCopierSnapshotVerifier,
} from '../../core/adapter'
import type { HistoryTerminalVerificationInput } from '../../history-acquisition'

export const BITGET_BOTS_COPIER_PAGE_CONTRACT = 'arena.ingest.bitget-bots-copier-page@1' as const
export const BITGET_BOTS_COPIER_SNAPSHOT_VERIFIER_CONTRACT =
  'arena.ingest.history-terminal-verifier.bitget_bots.copiers@1' as const
export const BITGET_BOTS_COPIER_URL =
  'https://www.bitget.com/v1/strategyPlatform/public/followRank' as const

const MAX_COPIER_ROWS = 10
const DAY_MS = 86_400_000
const REQUIRED_FOLLOWER_FIELDS = [
  'followerAvatarUrl',
  'followerInvestmentAmount',
  'followerProfitAmount',
  'followerTime',
  'followerUserName',
  'lastUpdateTime',
] as const

type Dict = Record<string, unknown>

interface ValidatedSnapshot {
  followers: Dict[]
  lastUpdateTime: string
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

function canonicalIdentity(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.trim() === value ? value : null
}

function canonicalNumericString(value: unknown): value is string {
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN
  return (
    typeof value === 'string' &&
    /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) &&
    Number.isFinite(parsed) &&
    !Object.is(parsed, -0)
  )
}

function canonicalNonNegativeNumericString(value: unknown): value is string {
  return canonicalNumericString(value) && Number(value) >= 0
}

function canonicalNonNegativeIntegerString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) return false
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0
}

function canonicalPositiveEpoch(value: unknown): value is string {
  if (!canonicalNonNegativeIntegerString(value) || Number(value) <= 0) return false
  return Number.isFinite(new Date(Number(value)).getTime())
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

function validateFollower(value: unknown, lastUpdateTime: string): value is Dict {
  if (!isRecord(value)) return false
  const expectedFields =
    value.followerUserDisplayName === undefined
      ? REQUIRED_FOLLOWER_FIELDS
      : [...REQUIRED_FOLLOWER_FIELDS, 'followerUserDisplayName']
  if (!exactKeys(value, expectedFields)) return false

  const displayName = value.followerUserDisplayName
  return (
    canonicalIdentity(value.followerUserName) !== null &&
    canonicalHttpsUrl(value.followerAvatarUrl) &&
    canonicalNonNegativeNumericString(value.followerInvestmentAmount) &&
    canonicalNumericString(value.followerProfitAmount) &&
    canonicalNonNegativeIntegerString(value.followerTime) &&
    value.lastUpdateTime === lastUpdateTime &&
    (displayName === undefined || displayName === '' || canonicalIdentity(displayName) !== null)
  )
}

function validatePages(
  pages: readonly Readonly<HistoryTerminalVerificationInput['pages'][number]>[],
  exchangeTraderId: string
): ValidatedSnapshot | null {
  if (pages.length !== 1) return null
  const page = pages[0]
  if (page.pageIndex !== 1 || page.url !== BITGET_BOTS_COPIER_URL || !isRecord(page.payload)) {
    return null
  }

  const wrapper = page.payload
  if (
    !exactKeys(wrapper, ['contract', 'historyTraderIdentity', 'request', 'response']) ||
    wrapper.contract !== BITGET_BOTS_COPIER_PAGE_CONTRACT ||
    wrapper.historyTraderIdentity !== exchangeTraderId ||
    !isRecord(wrapper.request) ||
    !exactKeys(wrapper.request, ['strategyId']) ||
    wrapper.request.strategyId !== exchangeTraderId ||
    !isRecord(wrapper.response)
  ) {
    return null
  }

  const response = wrapper.response
  if (
    !exactKeys(response, ['code', 'data', 'params']) ||
    response.code !== '200' ||
    !Array.isArray(response.params) ||
    response.params.length !== 0 ||
    !isRecord(response.data) ||
    !exactKeys(response.data, ['followers', 'lastUpdateTime']) ||
    !canonicalPositiveEpoch(response.data.lastUpdateTime) ||
    !Array.isArray(response.data.followers) ||
    response.data.followers.length > MAX_COPIER_ROWS
  ) {
    return null
  }

  const lastUpdateTime = response.data.lastUpdateTime
  if (!response.data.followers.every((row) => validateFollower(row, lastUpdateTime))) {
    return null
  }
  return { followers: response.data.followers, lastUpdateTime }
}

function verifyTerminal(input: HistoryTerminalVerificationInput) {
  if (
    (input.source.slug !== 'bitget_bots_futures' && input.source.slug !== 'bitget_bots_spot') ||
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

function copierHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((field) => String(field ?? '')).join('|'))
    .digest('hex')
}

function verifyConservation(input: CopierSnapshotVerificationInput) {
  const snapshot = validatePages(input.pages, input.exchangeTraderId)
  if (!snapshot || snapshot.followers.length !== input.rows.length) {
    return { verified: false } as const
  }

  const expectedTimestamp = new Date(Number(snapshot.lastUpdateTime)).toISOString()
  const hashes = new Set<string>()
  for (const [index, row] of input.rows.entries()) {
    const sourceRow = snapshot.followers[index]
    const label = canonicalIdentity(sourceRow.followerUserName)
    const expectedHash = copierHash(
      'bitget_bot_cp',
      label,
      sourceRow.followerProfitAmount,
      sourceRow.followerInvestmentAmount
    )
    const expectedDuration = Math.round(Number(sourceRow.followerTime) / DAY_MS)

    if (
      label === null ||
      row.kind !== 'copiers' ||
      row.ts !== expectedTimestamp ||
      row.copierLabel !== label ||
      row.copierPnl !== Number(sourceRow.followerProfitAmount) ||
      row.copierInvested !== Number(sourceRow.followerInvestmentAmount) ||
      row.copyDurationDays !== expectedDuration ||
      row.dedupeHash !== expectedHash ||
      hashes.has(row.dedupeHash) ||
      row.raw !== sourceRow
    ) {
      return { verified: false } as const
    }
    hashes.add(row.dedupeHash)
  }

  return { verified: true, envelopeRowCount: snapshot.followers.length } as const
}

export const bitgetBotsCopierSnapshotVerifier: SelectedCopierSnapshotVerifier = Object.freeze({
  contract: BITGET_BOTS_COPIER_SNAPSHOT_VERIFIER_CONTRACT,
  verifyTerminal,
  verifyConservation,
})
