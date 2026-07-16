import { createHash } from 'node:crypto'

export type DexProtocol = 'hyperliquid' | 'gmx' | 'gtrade'
export type DexCoverageScope =
  | 'full_public_file'
  | 'active_period_stats_offset_scan'
  | 'public_top25_board'
export type DexCompletenessStatus = 'complete' | 'provisional' | 'bounded_sample'
export type DexCoverageDenominator = 'eligible' | 'provisional' | 'excluded'
export type DexWindow = '1D' | '7D' | '30D' | '90D' | 'all_time'
export type DexCensusTimeframe = 1 | 7 | 30 | 90

export interface DexCensusSource {
  protocol: DexProtocol
  chain_id: number
  network: string
  endpoint: string
  scope: DexCoverageScope
  required_windows: readonly DexWindow[]
  completeness_status: DexCompletenessStatus
  completeness_basis:
    | 'upstream_full_file'
    | 'repeatable_offset_scan_without_order_by'
    | 'upstream_bounded_board'
  universe_complete: boolean
  coverage_denominator: DexCoverageDenominator
  truncation_detection: 'none' | 'scan_drift_or_guard_limit' | 'row_count_equals_25'
}

const GMX_ENDPOINT = (network: string) =>
  `https://gmx.squids.live/gmx-synthetics-${network}:prod/api/graphql`

const GTRADE_ENDPOINT = (chainId: number) =>
  `https://backend-global.gains.trade/api/leaderboard/all?chainId=${chainId}`

/**
 * Public-source census contract. A source being listed here only authorizes a
 * read-only discovery snapshot; it does not authorize publishing or ranking.
 *
 * GMX remains provisional because periodAccountStats has offset but no stable
 * orderBy. gTrade is a bounded Top-25 board and must never become an "all
 * traders" denominator. Hyperliquid is complete only for the public file, not
 * for every account that has ever existed on-chain.
 */
export const DEX_CENSUS_SOURCES = [
  {
    protocol: 'hyperliquid',
    chain_id: 999,
    network: 'Hyperliquid Mainnet',
    endpoint: 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard',
    scope: 'full_public_file',
    required_windows: ['7D', '30D', 'all_time'],
    completeness_status: 'complete',
    completeness_basis: 'upstream_full_file',
    universe_complete: true,
    coverage_denominator: 'eligible',
    truncation_detection: 'none',
  },
  ...[
    [42161, 'Arbitrum', 'arbitrum'],
    [43114, 'Avalanche', 'avalanche'],
    [3637, 'Botanix', 'botanix'],
    [4326, 'MegaETH', 'megaeth'],
  ].map(
    ([chainId, network, endpointNetwork]) =>
      ({
        protocol: 'gmx',
        chain_id: Number(chainId),
        network: String(network),
        endpoint: GMX_ENDPOINT(String(endpointNetwork)),
        scope: 'active_period_stats_offset_scan',
        required_windows: ['7D', '30D', '90D'],
        completeness_status: 'provisional',
        completeness_basis: 'repeatable_offset_scan_without_order_by',
        universe_complete: false,
        coverage_denominator: 'provisional',
        truncation_detection: 'scan_drift_or_guard_limit',
      }) satisfies DexCensusSource
  ),
  ...[
    [42161, 'Arbitrum'],
    [8453, 'Base'],
    [137, 'Polygon'],
    [33139, 'ApeChain'],
    [4326, 'MegaETH'],
  ].map(
    ([chainId, network]) =>
      ({
        protocol: 'gtrade',
        chain_id: Number(chainId),
        network: String(network),
        endpoint: GTRADE_ENDPOINT(Number(chainId)),
        scope: 'public_top25_board',
        required_windows: ['1D', '7D', '30D', '90D'],
        completeness_status: 'bounded_sample',
        completeness_basis: 'upstream_bounded_board',
        universe_complete: false,
        coverage_denominator: 'excluded',
        truncation_detection: 'row_count_equals_25',
      }) satisfies DexCensusSource
  ),
] as const satisfies readonly DexCensusSource[]

const ALLOWED_HOSTS = new Set([
  'stats-data.hyperliquid.xyz',
  'gmx.squids.live',
  'backend-global.gains.trade',
])

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

export interface DexCensusObservationInput {
  protocol: DexProtocol
  chainId: number
  address: string
  timeframe: DexCensusTimeframe
  metricReady: boolean
  /** Census is shadow-only. Any caller attempting promotion fails closed. */
  rankEligible?: boolean
}

export interface CanonicalDexCensusIdentity {
  identity: string
  protocol: DexProtocol
  chain_id: number
  address: string
  timeframes: DexCensusTimeframe[]
  metric_ready: boolean
  rank_eligible: false
}

export interface DexCensusStageSummary {
  discovered: number
  metric_ready: number
  rank_eligible: 0
  by_source: Array<{
    protocol: DexProtocol
    chain_id: number
    discovered: number
    metric_ready: number
    rank_eligible: 0
  }>
}

export interface DexCensusSnapshot {
  schema_version: 1
  generated_at: string
  sources: DexCensusSource[]
  stages: DexCensusStageSummary
  identities: CanonicalDexCensusIdentity[]
}

export function assertDexCensusSources(
  sources: readonly DexCensusSource[] = DEX_CENSUS_SOURCES
): void {
  const identities = new Set<string>()
  for (const source of sources) {
    if (!Number.isSafeInteger(source.chain_id) || source.chain_id <= 0) {
      throw new Error(`invalid census chain id: ${source.chain_id}`)
    }
    const key = `${source.protocol}:${source.chain_id}`
    if (identities.has(key)) throw new Error(`duplicate census source: ${key}`)
    identities.add(key)

    const url = new URL(source.endpoint)
    if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
      throw new Error(`unapproved census endpoint: ${source.endpoint}`)
    }
    if (source.universe_complete && source.completeness_status !== 'complete') {
      throw new Error(`complete universe must have complete evidence: ${key}`)
    }
    if (source.universe_complete && source.coverage_denominator !== 'eligible') {
      throw new Error(`complete universe must be denominator-eligible: ${key}`)
    }
    if (
      source.completeness_status === 'bounded_sample' &&
      source.coverage_denominator !== 'excluded'
    ) {
      throw new Error(`bounded sample cannot enter coverage denominator: ${key}`)
    }

    const registered = DEX_CENSUS_SOURCES.find(
      (candidate) =>
        candidate.protocol === source.protocol && candidate.chain_id === source.chain_id
    )
    if (!registered) throw new Error(`unapproved census source: ${key}`)
    if (canonicalJson(source) !== canonicalJson(registered)) {
      throw new Error(`census source contract does not match registry: ${key}`)
    }
  }
}

export function canonicalDexIdentity(
  protocol: DexProtocol,
  chainId: number,
  address: string
): { identity: string; address: string } {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`invalid DEX chain id: ${chainId}`)
  }
  if (
    !DEX_CENSUS_SOURCES.some(
      (source) => source.protocol === protocol && source.chain_id === chainId
    )
  ) {
    throw new Error(`unsupported DEX source: ${protocol}:${chainId}`)
  }
  const trimmed = address.trim()
  if (!EVM_ADDRESS.test(trimmed)) throw new Error(`invalid DEX address: ${address}`)
  const normalized = trimmed.toLowerCase()
  return { identity: `${protocol}:${chainId}:${normalized}`, address: normalized }
}

export function mergeDexCensusObservations(
  observations: readonly DexCensusObservationInput[]
): CanonicalDexCensusIdentity[] {
  const merged = new Map<string, CanonicalDexCensusIdentity>()
  for (const observation of observations) {
    if (![1, 7, 30, 90].includes(observation.timeframe)) {
      throw new Error(`invalid census timeframe: ${observation.timeframe}`)
    }
    if (typeof observation.metricReady !== 'boolean') {
      throw new Error('metricReady must be boolean')
    }
    if (observation.rankEligible === true) {
      throw new Error('DEX census observations are shadow-only and cannot be rank eligible')
    }
    const canonical = canonicalDexIdentity(
      observation.protocol,
      observation.chainId,
      observation.address
    )
    const existing = merged.get(canonical.identity)
    if (!existing) {
      merged.set(canonical.identity, {
        identity: canonical.identity,
        protocol: observation.protocol,
        chain_id: observation.chainId,
        address: canonical.address,
        timeframes: [observation.timeframe],
        metric_ready: observation.metricReady,
        rank_eligible: false,
      })
      continue
    }
    if (!existing.timeframes.includes(observation.timeframe)) {
      existing.timeframes.push(observation.timeframe)
      existing.timeframes.sort((a, b) => a - b)
    }
    existing.metric_ready ||= observation.metricReady
  }
  return [...merged.values()].sort((a, b) => a.identity.localeCompare(b.identity))
}

export function summarizeDexCensusStages(
  identities: readonly CanonicalDexCensusIdentity[]
): DexCensusStageSummary {
  const bySource = new Map<string, DexCensusStageSummary['by_source'][number]>()
  let metricReady = 0
  for (const identity of identities) {
    if (identity.rank_eligible) throw new Error('DEX census snapshot cannot contain ranked rows')
    if (identity.metric_ready) metricReady += 1
    const key = `${identity.protocol}:${identity.chain_id}`
    const current = bySource.get(key) ?? {
      protocol: identity.protocol,
      chain_id: identity.chain_id,
      discovered: 0,
      metric_ready: 0,
      rank_eligible: 0 as const,
    }
    current.discovered += 1
    if (identity.metric_ready) current.metric_ready += 1
    bySource.set(key, current)
  }
  return {
    discovered: identities.length,
    metric_ready: metricReady,
    rank_eligible: 0,
    by_source: [...bySource.values()].sort((a, b) =>
      `${a.protocol}:${a.chain_id}`.localeCompare(`${b.protocol}:${b.chain_id}`)
    ),
  }
}

function canonicalValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers')
    return value
  }
  if (typeof value !== 'object') {
    throw new Error(`canonical JSON rejects ${typeof value}`)
  }
  if (ancestors.has(value)) throw new Error('canonical JSON rejects cycles')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalValue(item, ancestors))
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('canonical JSON accepts plain objects only')
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonicalValue(item, ancestors)])
    )
  } finally {
    ancestors.delete(value)
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, new Set()))
}

export function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function buildDexCensusSnapshot(input: {
  generatedAt: string
  observations: readonly DexCensusObservationInput[]
  sources?: readonly DexCensusSource[]
}): { snapshot: DexCensusSnapshot; sha256: string } {
  const generatedAtMs = Date.parse(input.generatedAt)
  if (
    !Number.isFinite(generatedAtMs) ||
    new Date(generatedAtMs).toISOString() !== input.generatedAt
  ) {
    throw new Error(`generatedAt must be a canonical ISO timestamp: ${input.generatedAt}`)
  }
  const sources = [...(input.sources ?? DEX_CENSUS_SOURCES)].sort((a, b) =>
    `${a.protocol}:${a.chain_id}`.localeCompare(`${b.protocol}:${b.chain_id}`)
  )
  assertDexCensusSources(sources)
  const identities = mergeDexCensusObservations(input.observations)
  const snapshot: DexCensusSnapshot = {
    schema_version: 1,
    generated_at: input.generatedAt,
    sources,
    stages: summarizeDexCensusStages(identities),
    identities,
  }
  return { snapshot, sha256: canonicalSha256(snapshot) }
}
