import type {
  CopierSnapshotVerificationInput,
  SelectedCopierSnapshotVerifier,
} from '../../core/adapter'
import type { HistoryTerminalVerificationInput } from '../../history-acquisition'
import { isCanonicalPostgresTimestamp } from '../../postgres-timestamp'
import { dedupeHash } from './parsers'

export const TOOBIT_COPIER_SNAPSHOT_VERIFIER_CONTRACT =
  'arena.ingest.history-terminal-verifier.toobit.copiers@2' as const
export const TOOBIT_COPIER_DETAIL_URL =
  'https://bapi.toobit.com/bapi/v1/copy-trading/leader-detail' as const
export const TOOBIT_COPIER_FOLLOWERS_URL =
  'https://bapi.toobit.com/bapi/v1/copy-trading/top-followers' as const

const DAY_MS = 86_400_000
const FOLLOWER_FIELDS = [
  'followRunningMills',
  'followerAccountId',
  'followerAvatar',
  'followerNickname',
  'followerUserId',
  'totalFollowAmount',
  'totalFollowProfit',
] as const

type Dict = Record<string, unknown>

interface ValidatedSnapshot {
  followers: Dict[]
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

function canonicalLabel(value: unknown): string | null {
  const label = canonicalIdentity(value)
  return label !== null && label !== '****' && label !== '--' ? label : null
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

function canonicalNonNegativeIntegerString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) return false
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0
}

function validAvatar(value: unknown): value is string {
  if (value === '') return true
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

function validateFollower(value: unknown): value is Dict {
  return (
    isRecord(value) &&
    exactKeys(value, FOLLOWER_FIELDS) &&
    canonicalNonNegativeIntegerString(value.followerAccountId) &&
    canonicalNonNegativeIntegerString(value.followerUserId) &&
    canonicalLabel(value.followerNickname) !== null &&
    validAvatar(value.followerAvatar) &&
    canonicalNumericString(value.totalFollowAmount) &&
    canonicalNumericString(value.totalFollowProfit) &&
    canonicalNonNegativeIntegerString(value.followRunningMills)
  )
}

export function toobitCopierDetailUrl(exchangeTraderId: string): string {
  return `${TOOBIT_COPIER_DETAIL_URL}?leaderUserId=${encodeURIComponent(exchangeTraderId)}`
}

export function toobitCopierFollowersUrl(exchangeTraderId: string): string {
  return `${TOOBIT_COPIER_FOLLOWERS_URL}?leaderUserId=${encodeURIComponent(exchangeTraderId)}`
}

function validatePages(
  pages: readonly Readonly<HistoryTerminalVerificationInput['pages'][number]>[],
  exchangeTraderId: string
): ValidatedSnapshot | null {
  if (pages.length !== 2) return null
  const detailPage = pages[0]
  const followersPage = pages[1]
  if (
    detailPage.pageIndex !== 1 ||
    followersPage.pageIndex !== 2 ||
    detailPage.url !== toobitCopierDetailUrl(exchangeTraderId) ||
    followersPage.url !== toobitCopierFollowersUrl(exchangeTraderId) ||
    !isRecord(detailPage.payload) ||
    !exactKeys(detailPage.payload, ['code', 'data']) ||
    detailPage.payload.code !== 200 ||
    !isRecord(detailPage.payload.data)
  ) {
    return null
  }

  const detail = detailPage.payload.data
  if (
    detail.leaderUserId !== exchangeTraderId ||
    !canonicalNonNegativeIntegerString(detail.currentFollowerCount) ||
    !canonicalNonNegativeIntegerString(detail.maxLeadCount)
  ) {
    return null
  }
  const currentFollowerCount = Number(detail.currentFollowerCount)
  if (currentFollowerCount > Number(detail.maxLeadCount)) return null

  if (
    !isRecord(followersPage.payload) ||
    !exactKeys(followersPage.payload, ['code', 'data']) ||
    followersPage.payload.code !== 200 ||
    !Array.isArray(followersPage.payload.data) ||
    !followersPage.payload.data.every(validateFollower) ||
    followersPage.payload.data.length !== currentFollowerCount
  ) {
    return null
  }

  return { followers: followersPage.payload.data }
}

function verifyTerminal(input: HistoryTerminalVerificationInput) {
  if (
    input.source.slug !== 'toobit_futures' ||
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
    observation.page_ordinal !== 2
  ) {
    return { verified: false } as const
  }
  return validatePages(input.pages, input.exchangeTraderId)
    ? ({ verified: true, scanTerminalState: 'exhausted' } as const)
    : ({ verified: false } as const)
}

function verifyConservation(input: CopierSnapshotVerificationInput) {
  const snapshot = validatePages(input.pages, input.exchangeTraderId)
  if (!snapshot || snapshot.followers.length !== input.rows.length) {
    return { verified: false } as const
  }

  // The endpoint has no follower event timestamp. Bind every row to the exact
  // job-scoped ParseCtx clock captured before either response.
  const parsedAt = input.parserClock
  const firstFetchedAt = input.pages[0]?.fetchedAt
  if (
    !isCanonicalPostgresTimestamp(parsedAt) ||
    !isCanonicalPostgresTimestamp(firstFetchedAt) ||
    Date.parse(parsedAt) > Date.parse(firstFetchedAt)
  ) {
    return { verified: false } as const
  }

  const hashes = new Set<string>()
  for (const [index, row] of input.rows.entries()) {
    const sourceRow = snapshot.followers[index]
    const label = canonicalLabel(sourceRow.followerNickname)
    const expectedHash = dedupeHash('toobit_cp', label, sourceRow.followRunningMills)
    const expectedDuration = Math.floor(Number(sourceRow.followRunningMills) / DAY_MS)

    if (
      label === null ||
      row.kind !== 'copiers' ||
      row.ts !== parsedAt ||
      row.copierLabel !== label ||
      row.copierPnl !== Number(sourceRow.totalFollowProfit) ||
      row.copierInvested !== Number(sourceRow.totalFollowAmount) ||
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

export const toobitCopierSnapshotVerifier: SelectedCopierSnapshotVerifier = Object.freeze({
  contract: TOOBIT_COPIER_SNAPSHOT_VERIFIER_CONTRACT,
  verifyTerminal,
  verifyConservation,
})
