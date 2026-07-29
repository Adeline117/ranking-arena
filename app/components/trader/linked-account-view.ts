import type { PublicLinkedAccount } from '@/lib/data/linked-trader-public'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'

export interface TraderHeaderAccountMetrics {
  roi90d: number | undefined
  arenaScore: number | null
  scoreConfidence: string | null
  tradesCount: number | null
  rank: number | null
  platform: string | undefined
  traderKey: string | undefined
  tradingStyle: string | null
  lastUpdated: string | null | undefined
  isBot: boolean
}

export type LinkedAccountViewMode = 'primary' | 'aggregate' | 'selected' | 'unresolved' | 'invalid'

interface RequestedLinkedAccount {
  platform: string
  traderKey: string
}

interface LinkedAccountIdentityLabel {
  platform: string
  traderKey: string
  handle?: string | null
}

function compactTraderKey(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`
}

/** Keep same-exchange account selectors and comparison columns distinguishable. */
export function linkedAccountDisplayLabel(
  account: LinkedAccountIdentityLabel,
  accounts: LinkedAccountIdentityLabel[]
): string {
  const exchange = EXCHANGE_NAMES[account.platform.toLowerCase()] || account.platform
  const samePlatformCount = accounts.filter((item) => item.platform === account.platform).length
  if (samePlatformCount < 2) return exchange
  const handle = account.handle?.trim()
  const identity =
    handle && handle !== account.traderKey ? handle : compactTraderKey(account.traderKey)
  return `${exchange} · ${identity}`
}

export interface LinkedAccountViewScope {
  mode: LinkedAccountViewMode
  selectedAccount: PublicLinkedAccount | null
  suppressAccountMetrics: boolean
  shouldResetSelection: boolean
}

export function resolveLinkedAccountViewScope({
  selectionEnabled,
  requestedAccount,
  malformedSelection,
  authoritativeReady,
  accounts,
}: {
  selectionEnabled: boolean
  requestedAccount: RequestedLinkedAccount | null
  malformedSelection: boolean
  authoritativeReady: boolean
  accounts: PublicLinkedAccount[]
}): LinkedAccountViewScope {
  if (malformedSelection || (!selectionEnabled && requestedAccount)) {
    return {
      mode: 'invalid',
      selectedAccount: null,
      suppressAccountMetrics: true,
      shouldResetSelection: true,
    }
  }

  if (!selectionEnabled) {
    return {
      mode: 'primary',
      selectedAccount: null,
      suppressAccountMetrics: false,
      shouldResetSelection: false,
    }
  }

  if (requestedAccount) {
    if (!authoritativeReady) {
      return {
        mode: 'unresolved',
        selectedAccount: null,
        suppressAccountMetrics: true,
        shouldResetSelection: false,
      }
    }
    const selectedAccount =
      accounts.length >= 2
        ? (accounts.find(
            (account) =>
              account.platform === requestedAccount.platform &&
              account.traderKey === requestedAccount.traderKey
          ) ?? null)
        : null
    if (!selectedAccount) {
      return {
        mode: 'invalid',
        selectedAccount: null,
        suppressAccountMetrics: true,
        shouldResetSelection: true,
      }
    }
    return {
      mode: 'selected',
      selectedAccount,
      suppressAccountMetrics: false,
      shouldResetSelection: false,
    }
  }

  if (!authoritativeReady) {
    return {
      // Membership is an auxiliary, privacy-sensitive relation. While its
      // live read is pending (or being revalidated), keep publishing the
      // already exact route account and fail closed only on linked metadata.
      // An explicit ?account= selection above remains unresolved until that
      // same live read proves membership.
      mode: 'primary',
      selectedAccount: null,
      suppressAccountMetrics: false,
      shouldResetSelection: false,
    }
  }

  if (accounts.length >= 2) {
    return {
      mode: 'aggregate',
      selectedAccount: null,
      suppressAccountMetrics: true,
      shouldResetSelection: false,
    }
  }

  return {
    mode: 'primary',
    selectedAccount: null,
    suppressAccountMetrics: false,
    shouldResetSelection: false,
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function exactIdentityComponent(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim()
  )
}

/** A selected account cannot publish any detail field until its response proves the exact subject. */
export function traderDetailMatchesLinkedAccount(
  value: unknown,
  account: RequestedLinkedAccount
): boolean {
  const root = record(value)
  const profile = record(root?.profile)
  if (!profile) return false
  const traderKey = profile.trader_key ?? profile.id
  return profile.source === account.platform && traderKey === account.traderKey
}

/** Exact legacy fallback for a top-level ?platform= route disambiguation. */
export function traderDetailMatchesRequestedRoute(
  value: unknown,
  platform: string,
  routeHandle: string
): boolean {
  if (!exactIdentityComponent(platform, 64) || !exactIdentityComponent(routeHandle, 512)) {
    return false
  }
  const root = record(value)
  const profile = record(root?.profile)
  if (!profile || profile.source !== platform) return false
  const traderKey = profile.trader_key ?? profile.id
  return traderKey === routeHandle || profile.handle === routeHandle
}

/** Subject-bound identity check for a selected serving first-screen response. */
export function servingFirstScreenMatchesLinkedAccount(
  value: unknown,
  account: RequestedLinkedAccount
): boolean {
  const root = record(value)
  const subject = record(root?.subject)
  const firstScreen = record(root?.firstScreen)
  if (!subject || !firstScreen) return false
  if (
    !exactIdentityComponent(account.platform, 64) ||
    !exactIdentityComponent(account.traderKey, 512) ||
    !exactIdentityComponent(subject.platform, 64) ||
    !exactIdentityComponent(subject.traderKey, 512)
  ) {
    return false
  }
  return (
    subject.platform === account.platform &&
    subject.traderKey === account.traderKey &&
    firstScreen.exchangeTraderId === account.traderKey &&
    exactIdentityComponent(firstScreen.source, 64)
  )
}

export interface ExactRankHistoryPoint {
  date: string
  rank: number
  arena_score: number
}

/** Reject cached/malformed rank history that does not echo the visible subject. */
export function parseExactRankHistory(
  value: unknown,
  platform: string,
  traderKey: string
): ExactRankHistoryPoint[] | null {
  const root = record(value)
  if (
    root?.platform !== platform ||
    root.trader_key !== traderKey ||
    root.period !== '90D' ||
    !Array.isArray(root.history)
  ) {
    return null
  }

  const history: ExactRankHistoryPoint[] = []
  for (const value of root.history) {
    const point = record(value)
    if (
      !point ||
      typeof point.date !== 'string' ||
      point.date.length === 0 ||
      point.date !== point.date.trim() ||
      typeof point.rank !== 'number' ||
      !Number.isInteger(point.rank) ||
      point.rank <= 0 ||
      typeof point.arena_score !== 'number' ||
      !Number.isFinite(point.arena_score)
    ) {
      return null
    }
    history.push({ date: point.date, rank: point.rank, arena_score: point.arena_score })
  }
  return history
}

export function resolveTraderHeaderAccountMetrics(
  suppressAccountMetrics: boolean,
  metrics: TraderHeaderAccountMetrics
): TraderHeaderAccountMetrics {
  if (!suppressAccountMetrics) return metrics
  return {
    roi90d: undefined,
    arenaScore: null,
    scoreConfidence: null,
    tradesCount: null,
    rank: null,
    platform: undefined,
    traderKey: undefined,
    tradingStyle: null,
    lastUpdated: null,
    isBot: false,
  }
}
