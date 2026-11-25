import { normalizeDrawdownMagnitude } from '@/lib/utils/format'
import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'

export interface PublicLinkedSubject {
  platform: string
  traderKey: string
}

export interface PublicLinkedAccount {
  id: string
  platform: string
  traderKey: string
  handle: string | null
  label: null
  isPrimary: boolean
  /** Per-account proof state; relation identity remains visible when unknown. */
  rankingVisibility: PublicLinkedRankingVisibility
  rankingVisibilityReason: PublicLinkedRankingVisibilityReason | null
  roi: number | null
  pnl: null
  arenaScore: number | null
  winRate: number | null
  maxDrawdown: number | null
  rank: number | null
}

export type PublicLinkedRankingVisibility = 'verified' | 'partial' | 'unknown'
export type PublicLinkedRankingVisibilityReason =
  | 'source_not_publicly_rankable'
  | 'public_cohort_unavailable'
  | 'public_rank_unavailable'
  | 'public_cohort_unverified'

export interface PublicLinkedAggregateData {
  combinedPnl: null
  bestRoi: null
  weightedScore: null
}

export interface PublicLinkedAggregateResponse {
  subject: PublicLinkedSubject
  aggregated: PublicLinkedAggregateData | null
  accounts: PublicLinkedAccount[]
  totalAccounts: number
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function exactNonEmptyString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim()
    ? value
    : null
}

function parseSubject(value: unknown): PublicLinkedSubject | null {
  const record = recordOrNull(value)
  if (!record) return null
  const platform = exactNonEmptyString(record.platform, 64)
  const traderKey = exactNonEmptyString(record.traderKey, 512)
  return platform && traderKey ? { platform, traderKey } : null
}

function sameSubject(left: PublicLinkedSubject, right: PublicLinkedSubject): boolean {
  return left.platform === right.platform && left.traderKey === right.traderKey
}

function roiOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= -10_000 && value <= 10_000
    ? value
    : null
}

function boundedPercentOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null
}

function arenaScoreOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100
    ? value
    : null
}

function positiveRankOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

const PUBLIC_LINKED_RANKING_REASONS = new Set<string>([
  'source_not_publicly_rankable',
  'public_cohort_unavailable',
  'public_rank_unavailable',
  'public_cohort_unverified',
])

function publicRankingReasonOrNull(value: unknown): PublicLinkedRankingVisibilityReason | null {
  if (typeof value !== 'string' || !PUBLIC_LINKED_RANKING_REASONS.has(value)) return null
  return value as PublicLinkedRankingVisibilityReason
}

function unknownAccountRanking(
  account: Omit<
    PublicLinkedAccount,
    | 'rankingVisibility'
    | 'rankingVisibilityReason'
    | 'roi'
    | 'pnl'
    | 'arenaScore'
    | 'winRate'
    | 'maxDrawdown'
    | 'rank'
  >,
  rankingVisibility: Exclude<PublicLinkedRankingVisibility, 'verified'> = 'unknown',
  rankingVisibilityReason: PublicLinkedRankingVisibilityReason = 'public_cohort_unavailable'
): PublicLinkedAccount {
  return {
    ...account,
    rankingVisibility,
    rankingVisibilityReason,
    roi: null,
    pnl: null,
    arenaScore: null,
    winRate: null,
    maxDrawdown: null,
    rank: null,
  }
}

function parseAccount(value: unknown): PublicLinkedAccount | null {
  const record = recordOrNull(value)
  if (!record) return null
  const platform = exactNonEmptyString(record.platform, 64)
  const traderKey = exactNonEmptyString(record.traderKey, 512)
  if (!platform || !traderKey || typeof record.isPrimary !== 'boolean') return null

  const handle =
    record.handle == null
      ? null
      : typeof record.handle === 'string' && record.handle.length > 0 && record.handle.length <= 512
        ? record.handle
        : null
  const identity = {
    id: `${encodeURIComponent(platform)}:${encodeURIComponent(traderKey)}`,
    platform,
    traderKey,
    handle,
    // Custom account labels are owner-private until an explicit public-label
    // contract exists.
    label: null,
    isPrimary: record.isPrimary,
  }

  const rankingVisibility = record.rankingVisibility
  const rankingVisibilityReason = publicRankingReasonOrNull(record.rankingVisibilityReason)
  if (rankingVisibility !== 'verified') {
    // Old client/query-cache payloads predate the proof field. Their metrics
    // cannot be replayed merely because the shape looks plausible.
    return unknownAccountRanking(
      identity,
      rankingVisibility === 'partial' ? 'partial' : 'unknown',
      rankingVisibilityReason ??
        (rankingVisibility === 'partial' ? 'public_cohort_unverified' : 'public_cohort_unavailable')
    )
  }

  // Win rate and drawdown are optional on a ranked row: null/absent means
  // "not provided". A value that is present must still be valid.
  const winRateProvided = record.winRate !== null && record.winRate !== undefined
  const maxDrawdownProvided = record.maxDrawdown !== null && record.maxDrawdown !== undefined
  const rawDrawdown =
    typeof record.maxDrawdown === 'number' && Number.isFinite(record.maxDrawdown)
      ? record.maxDrawdown
      : null
  const roi = roiOrNull(record.roi)
  const arenaScore = arenaScoreOrNull(record.arenaScore)
  const winRate = boundedPercentOrNull(record.winRate)
  const maxDrawdown = normalizeDrawdownMagnitude(rawDrawdown)
  const rank = positiveRankOrNull(record.rank)
  if (
    !isPublicRankingSourceAllowed(platform) ||
    rankingVisibilityReason !== null ||
    roi === null ||
    arenaScore === null ||
    (winRateProvided && winRate === null) ||
    (maxDrawdownProvided && maxDrawdown === null) ||
    rank === null
  ) {
    return unknownAccountRanking(identity, 'partial', 'public_cohort_unverified')
  }

  return {
    ...identity,
    rankingVisibility: 'verified',
    rankingVisibilityReason: null,
    roi,
    // Per-account PnL lacks an attested settlement currency. It remains
    // unavailable even when the ranking cohort is otherwise verified.
    pnl: null,
    arenaScore,
    winRate,
    maxDrawdown,
    rank,
  }
}

function parseAccounts(value: unknown): PublicLinkedAccount[] | null {
  if (!Array.isArray(value)) return null
  const accounts = value.map(parseAccount)
  if (!accounts.every((account): account is PublicLinkedAccount => account !== null)) return null

  const ids = new Set(accounts.map((account) => account.id))
  if (ids.size !== accounts.length) return null
  if (accounts.length > 0 && accounts.filter((account) => account.isPrimary).length !== 1) {
    return null
  }
  return accounts
}

function aggregateForCount(totalAccounts: number): PublicLinkedAggregateData | null {
  return totalAccounts >= 2 ? { combinedPnl: null, bestRoi: null, weightedScore: null } : null
}

function hasValidAggregateShape(record: Record<string, unknown>, totalAccounts: number): boolean {
  return totalAccounts >= 2 ? recordOrNull(record.aggregated) !== null : record.aggregated === null
}

export function emptyPublicLinkedAggregate(
  subject: PublicLinkedSubject
): PublicLinkedAggregateResponse {
  return {
    subject: { ...subject },
    aggregated: null,
    accounts: [],
    totalAccounts: 0,
  }
}

/** Server boundary: convert internal linked rows into the exact public DTO. */
export function serializePublicLinkedAggregate(
  stats: unknown,
  subject: PublicLinkedSubject
): PublicLinkedAggregateResponse {
  if (stats == null) return emptyPublicLinkedAggregate(subject)

  const record = recordOrNull(stats)
  const accounts = record ? parseAccounts(record.accounts) : null
  if (!record || !accounts) throw new Error('Linked aggregate stats failed their public contract')
  if (accounts.length > 0 && !accounts.some((account) => sameSubject(account, subject))) {
    throw new Error('Linked aggregate stats do not contain the requested subject')
  }

  return {
    subject: { ...subject },
    aggregated: aggregateForCount(accounts.length),
    accounts,
    totalAccounts: accounts.length,
  }
}

/**
 * Client boundary: rebuild the allowlisted DTO from an untrusted API/bundle
 * payload. Extra fields and legacy non-null aggregate metrics are discarded.
 */
export function parsePublicLinkedAggregate(
  value: unknown,
  expectedSubject?: PublicLinkedSubject
): PublicLinkedAggregateResponse | null {
  const record = recordOrNull(value)
  if (!record || record._error !== undefined) return null
  const subject = parseSubject(record.subject)
  if (!subject || (expectedSubject && !sameSubject(subject, expectedSubject))) return null

  const accounts = parseAccounts(record.accounts)
  if (!accounts) return null
  if (
    typeof record.totalAccounts !== 'number' ||
    !Number.isInteger(record.totalAccounts) ||
    record.totalAccounts !== accounts.length ||
    !hasValidAggregateShape(record, accounts.length)
  ) {
    return null
  }
  if (accounts.length > 0 && !accounts.some((account) => sameSubject(account, subject))) {
    return null
  }

  return {
    subject,
    aggregated: aggregateForCount(accounts.length),
    accounts,
    totalAccounts: accounts.length,
  }
}
