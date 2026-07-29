import { normalizeDrawdownMagnitude } from '@/lib/utils/format'

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
  roi: number | null
  pnl: null
  arenaScore: null
  winRate: number | null
  maxDrawdown: number | null
  rank: null
}

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
  const rawDrawdown =
    typeof record.maxDrawdown === 'number' && Number.isFinite(record.maxDrawdown)
      ? record.maxDrawdown
      : null

  return {
    id: `${encodeURIComponent(platform)}:${encodeURIComponent(traderKey)}`,
    platform,
    traderKey,
    handle,
    // Custom account labels are owner-private until an explicit public-label
    // contract exists.
    label: null,
    isPrimary: record.isPrimary,
    roi: roiOrNull(record.roi),
    // These values require Money/publication-proof contracts that the legacy
    // linked rows do not carry. Force them closed even for old cached payloads.
    pnl: null,
    arenaScore: null,
    winRate: boundedPercentOrNull(record.winRate),
    maxDrawdown: normalizeDrawdownMagnitude(rawDrawdown),
    rank: null,
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
