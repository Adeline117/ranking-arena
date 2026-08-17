import type { PublicLinkedAccount } from '@/lib/data/linked-trader-public'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import type {
  Money,
  Provenance,
  SourceCapability,
  TraderFirstScreen,
  TraderFirstScreenResponse,
} from '@/lib/data/serving/types'

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
  preserveAggregateIntent = false,
}: {
  selectionEnabled: boolean
  requestedAccount: RequestedLinkedAccount | null
  malformedSelection: boolean
  authoritativeReady: boolean
  accounts: PublicLinkedAccount[]
  preserveAggregateIntent?: boolean
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
    if (preserveAggregateIntent) {
      return {
        mode: 'aggregate',
        selectedAccount: null,
        suppressAccountMetrics: true,
        shouldResetSelection: false,
      }
    }
    return {
      // Membership is an auxiliary, privacy-sensitive relation. While its
      // live read is pending (or being revalidated), keep publishing the
      // already exact route account unless the subject-scoped UI intent says
      // the viewer explicitly selected All; that intent remains fail-closed.
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

function normalizeResolverIdentity(value: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : value
}

function resolverIdentityMatches(value: unknown, expected: string): value is string {
  return (
    typeof value === 'string' &&
    normalizeResolverIdentity(value) === normalizeResolverIdentity(expected)
  )
}

const INVALID = Symbol('invalid')
type Invalid = typeof INVALID

const SERVING_CURRENCIES = new Set(['USDT', 'USDx', 'USDC', 'USD'])
const TF_AVAILABILITIES = new Set(['native', 'derived', 'absent'])
const RECORD_KINDS = ['positions', 'position_history', 'orders', 'transfers', 'copiers'] as const
const COPIER_DEPTHS = new Set(['full', 'top10', 'top3_preview', 'none'])
const MAX_JSON_DEPTH = 12
const MAX_JSON_COLLECTION_SIZE = 10_000
const MAX_JSON_STRING_LENGTH = 65_536

function nullableString(value: unknown, maxLength: number): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= maxLength)
}

function finiteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

/** Rebuild extras as JSON-safe data so getters, cycles, BigInt and non-finite
 *  metrics cannot cross the transport boundary as trusted serving data. */
function sanitizeJsonValue(
  value: unknown,
  activeObjects: WeakSet<object>,
  depth = 0
): unknown | Invalid {
  if (depth > MAX_JSON_DEPTH) return INVALID
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID
  if (typeof value === 'string') {
    return value.length <= MAX_JSON_STRING_LENGTH ? value : INVALID
  }
  if (typeof value !== 'object') return INVALID
  if (activeObjects.has(value)) return INVALID

  activeObjects.add(value)
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_JSON_COLLECTION_SIZE) return INVALID
      const output: unknown[] = []
      for (const item of value) {
        const sanitized = sanitizeJsonValue(item, activeObjects, depth + 1)
        if (sanitized === INVALID) return INVALID
        output.push(sanitized)
      }
      return output
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return INVALID
    if (Object.getOwnPropertySymbols(value).length > 0) return INVALID
    const entries = Object.entries(value)
    if (entries.length > MAX_JSON_COLLECTION_SIZE) return INVALID
    const output: Array<[string, unknown]> = []
    for (const [key, item] of entries) {
      const sanitized = sanitizeJsonValue(item, activeObjects, depth + 1)
      if (sanitized === INVALID) return INVALID
      output.push([key, sanitized])
    }
    return Object.fromEntries(output)
  } catch {
    return INVALID
  } finally {
    activeObjects.delete(value)
  }
}

function parseMoney(value: unknown): Money | null | Invalid {
  if (value === null) return null
  const money = record(value)
  if (
    !money ||
    typeof money.value !== 'number' ||
    !Number.isFinite(money.value) ||
    typeof money.currency !== 'string' ||
    !SERVING_CURRENCIES.has(money.currency)
  ) {
    return INVALID
  }
  return { value: money.value, currency: money.currency as Money['currency'] }
}

function parseProvenance(value: unknown): Provenance | Invalid {
  const provenance = record(value)
  if (
    !provenance ||
    !exactIdentityComponent(provenance.source, 64) ||
    typeof provenance.asOf !== 'string' ||
    provenance.asOf.length === 0 ||
    provenance.asOf.length > 64 ||
    provenance.asOf !== provenance.asOf.trim() ||
    !Number.isFinite(Date.parse(provenance.asOf)) ||
    (provenance.derived !== undefined && typeof provenance.derived !== 'boolean')
  ) {
    return INVALID
  }
  return provenance.derived === undefined
    ? { source: provenance.source, asOf: provenance.asOf }
    : { source: provenance.source, asOf: provenance.asOf, derived: provenance.derived }
}

function parseFirstScreenEntry(
  value: unknown,
  canonicalSource: string
): TraderFirstScreen['entries'][number] | Invalid {
  const entry = record(value)
  const rankingVisibility = entry?.rankingVisibility
  const rankingVisibilityReason = entry?.rankingVisibilityReason
  if (
    !entry ||
    (entry.timeframe !== 7 && entry.timeframe !== 30 && entry.timeframe !== 90) ||
    (entry.rank !== null &&
      (typeof entry.rank !== 'number' || !Number.isInteger(entry.rank) || entry.rank <= 0)) ||
    (rankingVisibility !== 'verified' &&
      rankingVisibility !== 'partial' &&
      rankingVisibility !== 'unknown') ||
    !nullableString(rankingVisibilityReason, 256) ||
    !finiteNumberOrNull(entry.headlineRoi) ||
    !finiteNumberOrNull(entry.headlineWinRate)
  ) {
    return INVALID
  }

  const headlinePnl = parseMoney(entry.headlinePnl)
  const provenance = parseProvenance(entry.provenance)
  const extras = sanitizeJsonValue(entry.extras, new WeakSet())
  const extrasRecord = extras === INVALID ? null : record(extras)
  if (
    headlinePnl === INVALID ||
    provenance === INVALID ||
    provenance.source !== canonicalSource ||
    !extrasRecord ||
    (rankingVisibility === 'verified' &&
      (entry.rank === null || entry.headlineRoi === null || rankingVisibilityReason !== null)) ||
    (rankingVisibility !== 'verified' &&
      (entry.rank !== null || entry.headlineRoi !== null || headlinePnl !== null)) ||
    (rankingVisibility !== 'verified' &&
      (typeof rankingVisibilityReason !== 'string' || rankingVisibilityReason.length === 0))
  ) {
    return INVALID
  }

  return {
    timeframe: entry.timeframe,
    rank: entry.rank,
    rankingVisibility,
    rankingVisibilityReason,
    headlineRoi: entry.headlineRoi,
    headlinePnl,
    headlineWinRate: entry.headlineWinRate,
    extras: extrasRecord,
    provenance,
  }
}

function parseCapability(value: unknown): SourceCapability | null | Invalid {
  if (value === null) return null
  const capability = record(value)
  const timeframes = record(capability?.timeframes)
  const surfaces = record(capability?.surfaces)
  if (
    !capability ||
    !timeframes ||
    !surfaces ||
    !TF_AVAILABILITIES.has(timeframes['7'] as string) ||
    !TF_AVAILABILITIES.has(timeframes['30'] as string) ||
    !TF_AVAILABILITIES.has(timeframes['90'] as string) ||
    typeof capability.inceptionTf !== 'boolean' ||
    !Array.isArray(capability.metrics) ||
    capability.metrics.some((metric) => !exactIdentityComponent(metric, 128)) ||
    RECORD_KINDS.some((kind) => typeof surfaces[kind] !== 'boolean') ||
    typeof capability.copierDepth !== 'string' ||
    !COPIER_DEPTHS.has(capability.copierDepth) ||
    typeof capability.currency !== 'string' ||
    !SERVING_CURRENCIES.has(capability.currency) ||
    typeof capability.isOnchain !== 'boolean' ||
    typeof capability.derivedBoardNote !== 'boolean' ||
    typeof capability.exchangeName !== 'string' ||
    capability.exchangeName.length === 0 ||
    capability.exchangeName.length > 256
  ) {
    return INVALID
  }

  return {
    timeframes: {
      '7': timeframes['7'] as SourceCapability['timeframes']['7'],
      '30': timeframes['30'] as SourceCapability['timeframes']['30'],
      '90': timeframes['90'] as SourceCapability['timeframes']['90'],
    },
    inceptionTf: capability.inceptionTf,
    metrics: [...capability.metrics] as string[],
    surfaces: Object.fromEntries(
      RECORD_KINDS.map((kind) => [kind, surfaces[kind] as boolean])
    ) as SourceCapability['surfaces'],
    copierDepth: capability.copierDepth as SourceCapability['copierDepth'],
    currency: capability.currency as SourceCapability['currency'],
    isOnchain: capability.isOnchain,
    derivedBoardNote: capability.derivedBoardNote,
    exchangeName: capability.exchangeName,
  }
}

export type ExpectedTraderFirstScreenRequest =
  | { kind: 'route'; platform: string; handle: string }
  | { kind: 'linked'; platform: string; traderKey: string }

export type ExactTraderFirstScreenResponse = TraderFirstScreenResponse & {
  request: { platform: string; handle: string }
}

function parseExpectedFirstScreenRequest(expected: ExpectedTraderFirstScreenRequest): {
  kind: ExpectedTraderFirstScreenRequest['kind']
  platform: string
  handle: string
  traderKey: string | null
} | null {
  const handle = expected.kind === 'route' ? expected.handle : expected.traderKey
  if (!exactIdentityComponent(expected.platform, 64) || !exactIdentityComponent(handle, 512)) {
    return null
  }
  return {
    kind: expected.kind,
    platform: expected.platform,
    handle,
    traderKey: expected.kind === 'linked' ? expected.traderKey : null,
  }
}

function requestHandleMatchesExpected(
  value: unknown,
  expected: NonNullable<ReturnType<typeof parseExpectedFirstScreenRequest>>
): value is string {
  return expected.kind === 'route'
    ? value === expected.handle
    : resolverIdentityMatches(value, expected.handle)
}

/** A 404 authorizes a legacy lookup only when the route explicitly proves that
 *  this exact requested source has no serving boundary. */
export function isExactSourceNotServingError(
  error: unknown,
  expected: ExpectedTraderFirstScreenRequest
): boolean {
  const expectedRequest = parseExpectedFirstScreenRequest(expected)
  const root = record(error)
  const info = record(root?.info)
  const apiError = record(info?.error)
  const details = record(apiError?.details)
  const request = record(details?.request)
  return Boolean(
    expectedRequest &&
    root?.status === 404 &&
    info?.success === false &&
    details?.reason === 'source_not_serving' &&
    request?.platform === expectedRequest.platform &&
    requestHandleMatchesExpected(request?.handle, expectedRequest)
  )
}

/** Validate transport, request echo and canonical identity before any first-screen
 *  field reaches header or serving consumers. Returns a rebuilt safe object. */
export function parseExactTraderFirstScreenResponse(
  value: unknown,
  expected: ExpectedTraderFirstScreenRequest
): ExactTraderFirstScreenResponse | null {
  const expectedRequest = parseExpectedFirstScreenRequest(expected)
  if (!expectedRequest) return null

  const root = record(value)
  const request = record(root?.request)
  const subject = record(root?.subject)
  const firstScreen = record(root?.firstScreen)
  if (
    !root ||
    !request ||
    request.platform !== expectedRequest.platform ||
    !requestHandleMatchesExpected(request.handle, expectedRequest) ||
    !subject ||
    !exactIdentityComponent(subject.platform, 64) ||
    !exactIdentityComponent(subject.traderKey, 512) ||
    !firstScreen ||
    !exactIdentityComponent(firstScreen.source, 64) ||
    !exactIdentityComponent(firstScreen.exchangeTraderId, 512) ||
    subject.platform !== firstScreen.source ||
    !resolverIdentityMatches(subject.traderKey, firstScreen.exchangeTraderId) ||
    (expectedRequest.traderKey !== null &&
      !resolverIdentityMatches(subject.traderKey, expectedRequest.traderKey)) ||
    !nullableString(firstScreen.nickname, 512) ||
    !nullableString(firstScreen.avatarMirrorUrl, 8192) ||
    !nullableString(firstScreen.avatarOriginUrl, 8192) ||
    !nullableString(firstScreen.avatarSrc, 8192) ||
    !nullableString(firstScreen.walletAddress, 512) ||
    (firstScreen.traderKind !== 'human' && firstScreen.traderKind !== 'bot') ||
    (firstScreen.botStrategy !== null &&
      firstScreen.botStrategy !== 'martingale' &&
      firstScreen.botStrategy !== 'grid' &&
      firstScreen.botStrategy !== 'ai') ||
    !Array.isArray(firstScreen.entries) ||
    typeof root.is_verified_data !== 'boolean'
  ) {
    return null
  }

  const entries: TraderFirstScreen['entries'] = []
  const seenTimeframes = new Set<number>()
  for (const value of firstScreen.entries) {
    const entry = parseFirstScreenEntry(value, firstScreen.source)
    if (entry === INVALID || seenTimeframes.has(entry.timeframe)) return null
    seenTimeframes.add(entry.timeframe)
    entries.push(entry)
  }

  const capability = parseCapability(root.capability)
  if (capability === INVALID) return null
  const canonicalTraderKey = normalizeResolverIdentity(subject.traderKey)
  const requestHandle =
    expectedRequest.kind === 'linked'
      ? normalizeResolverIdentity(expectedRequest.handle)
      : expectedRequest.handle

  return {
    request: { platform: expectedRequest.platform, handle: requestHandle },
    subject: { platform: subject.platform, traderKey: canonicalTraderKey },
    firstScreen: {
      source: firstScreen.source,
      exchangeTraderId: canonicalTraderKey,
      nickname: firstScreen.nickname,
      avatarMirrorUrl: firstScreen.avatarMirrorUrl,
      avatarOriginUrl: firstScreen.avatarOriginUrl,
      avatarSrc: firstScreen.avatarSrc,
      walletAddress: firstScreen.walletAddress,
      traderKind: firstScreen.traderKind,
      botStrategy: firstScreen.botStrategy,
      entries,
    },
    capability,
    is_verified_data: root.is_verified_data,
  }
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
  return (
    profile.source === account.platform && resolverIdentityMatches(traderKey, account.traderKey)
  )
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
  return (
    resolverIdentityMatches(traderKey, routeHandle) ||
    resolverIdentityMatches(profile.handle, routeHandle)
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
    // A matching identity alone cannot authenticate historical observations.
    // Legacy rank_history responses omit this proof marker and are deliberately
    // rejected so a browser/React Query cache cannot replay old sparklines.
    root.ranking_visibility !== 'verified' ||
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
