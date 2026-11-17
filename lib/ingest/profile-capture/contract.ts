/**
 * Per-source Tier-B profile capture contracts (attempt-bound profile evidence,
 * migration 20261116215328).
 *
 * A contract is the reviewed statement "for this source, the profile surface
 * is these endpoints, and these payload field paths supply these score-input
 * metrics". A profile value is publication evidence only when
 *   1. its source declares a contract here,
 *   2. the same contract document (by strict-canonical sha256) is registered in
 *      arena.profile_capture_contracts by a reviewed migration, and
 *   3. the capture helper (./capture.ts) proved, for one attempt, that the
 *      parser's value equals the value at the declared path of the RAW page.
 * A source without a contract keeps its profile crawl exactly as before; its
 * values are never attested, so publication treats them as unevidenced.
 */

import { TOOBIT_FUTURES_PROFILE_CAPTURE } from '../adapters/toobit/profile-capture-contract'
import type { ParsedStats, RankingTimeframe } from '../core/types'
import { strictCanonicalSha256 } from '../strict-canonical-json'

export const PROFILE_CAPTURE_CONTRACT_DOCUMENT = 'arena.profile-capture-contract@1' as const

/** The #489 score-input metric vocabulary (arena.profile_attestable_metrics()). */
export const PROFILE_ATTESTABLE_METRICS = [
  'roi',
  'pnl',
  'win_rate',
  'mdd',
  'sharpe',
  'copier_count',
  'total_positions',
  'sortino',
  'calmar',
  'volatility',
] as const
export type ProfileAttestableMetric = (typeof PROFILE_ATTESTABLE_METRICS)[number]

/**
 * How the RAW field value maps onto the parsed (stored) value:
 * - identity: stored = raw
 * - fraction_to_percent: stored = raw * 100 (upstream 0.123 → 12.3 %)
 * - abs / abs_fraction_to_percent: drawdowns some sources sign negatively
 */
export type ProfileMetricTransform =
  | 'identity'
  | 'fraction_to_percent'
  | 'abs'
  | 'abs_fraction_to_percent'

export interface ProfileEndpointContract {
  /** Stable id used by metric declarations and recorded in the manifest. */
  readonly id: string
  /** Public, credential-free origin, e.g. 'https://www.example.com'. */
  readonly origin: string
  readonly pathname: string
  /**
   * Query parameters that belong to the request projection (identity of the
   * request: trader id, timeframe, ...). Every other parameter (cache busters,
   * signatures) is excluded from the projection hash.
   */
  readonly queryAllowlist: readonly string[]
  /** A complete capture must contain one page of every required endpoint. */
  readonly required: boolean
}

export interface ProfileMetricFieldContract {
  readonly endpoint: string
  /** Path inside that endpoint's JSON payload; numbers index arrays. */
  readonly path: readonly (string | number)[]
  readonly transform: ProfileMetricTransform
}

export interface ProfileCaptureContract {
  readonly document: typeof PROFILE_CAPTURE_CONTRACT_DOCUMENT
  /** `<source_slug>-profile-capture@<version>`; bump the version on any change. */
  readonly captureContract: string
  readonly sourceSlug: string
  readonly timeframes: readonly RankingTimeframe[]
  readonly endpoints: readonly ProfileEndpointContract[]
  readonly metrics: Readonly<Partial<Record<ProfileAttestableMetric, ProfileMetricFieldContract>>>
}

const CONTRACT_NAME = /^([a-z0-9_]+)-profile-capture@[1-9][0-9]*$/
const ENDPOINT_ID = /^[a-z][a-z0-9_]{0,63}$/

function fail(contract: { captureContract?: unknown }, reason: string): never {
  throw new TypeError(`[profile-capture] ${String(contract.captureContract)}: ${reason}`)
}

/** Structural validation; throws on the first violation. */
export function assertProfileCaptureContract(contract: ProfileCaptureContract): void {
  if (contract.document !== PROFILE_CAPTURE_CONTRACT_DOCUMENT) fail(contract, 'unknown document')
  const name = CONTRACT_NAME.exec(contract.captureContract)
  if (!name) fail(contract, 'contract name must be <source_slug>-profile-capture@<n>')
  if (name[1] !== contract.sourceSlug) fail(contract, 'contract name must start with its source')
  if (
    contract.timeframes.length === 0 ||
    new Set(contract.timeframes).size !== contract.timeframes.length ||
    contract.timeframes.some((tf) => tf !== 7 && tf !== 30 && tf !== 90)
  ) {
    fail(contract, 'timeframes must be distinct values of 7/30/90')
  }
  if (contract.endpoints.length === 0) fail(contract, 'at least one endpoint is required')
  const endpointIds = new Set<string>()
  const routes = new Set<string>()
  for (const endpoint of contract.endpoints) {
    if (!ENDPOINT_ID.test(endpoint.id) || endpointIds.has(endpoint.id)) {
      fail(contract, `endpoint id ${endpoint.id} is malformed or duplicated`)
    }
    endpointIds.add(endpoint.id)
    let origin: URL
    try {
      origin = new URL(endpoint.origin)
    } catch {
      fail(contract, `endpoint ${endpoint.id} origin is not a URL`)
    }
    if (origin.protocol !== 'https:' || origin.origin !== endpoint.origin) {
      fail(contract, `endpoint ${endpoint.id} origin must be a bare https origin`)
    }
    if (!endpoint.pathname.startsWith('/')) fail(contract, `endpoint ${endpoint.id} pathname`)
    const route = `${endpoint.origin}${endpoint.pathname}`
    if (routes.has(route)) fail(contract, `endpoint ${endpoint.id} route is duplicated`)
    routes.add(route)
  }
  if (!contract.endpoints.some((endpoint) => endpoint.required)) {
    fail(contract, 'at least one endpoint must be required')
  }
  const declared = Object.entries(contract.metrics) as Array<
    [string, ProfileMetricFieldContract | undefined]
  >
  if (declared.length === 0) fail(contract, 'at least one metric is required')
  for (const [metric, field] of declared) {
    if (!(PROFILE_ATTESTABLE_METRICS as readonly string[]).includes(metric) || !field) {
      fail(contract, `metric ${metric} is not attestable`)
    }
    const endpoint = contract.endpoints.find((candidate) => candidate.id === field.endpoint)
    if (!endpoint) fail(contract, `metric ${metric} names an undeclared endpoint`)
    // A metric from an optional endpoint would make attestation depend on
    // whether that page happened to be fetched; keep evidence deterministic.
    if (!endpoint.required) fail(contract, `metric ${metric} must come from a required endpoint`)
    if (field.path.length === 0) fail(contract, `metric ${metric} path is empty`)
  }
}

/** The sha256 the registration migration inserts as contract_sha256. */
export function profileCaptureContractSha256(contract: ProfileCaptureContract): string {
  assertProfileCaptureContract(contract)
  return strictCanonicalSha256(contract)
}

/** Metrics a contract attests, in the database's sorted order. */
export function profileContractMetrics(
  contract: ProfileCaptureContract
): ProfileAttestableMetric[] {
  return (Object.keys(contract.metrics) as ProfileAttestableMetric[]).sort()
}

/** Where a metric lives in ParsedStats (and so in arena.trader_stats). */
export function parsedStatsMetricValue(
  stats: ParsedStats,
  metric: ProfileAttestableMetric
): unknown {
  switch (metric) {
    case 'roi':
      return stats.roi
    case 'pnl':
      return stats.pnl
    case 'win_rate':
      return stats.winRate
    case 'mdd':
      return stats.mdd
    case 'sharpe':
      return stats.sharpe
    case 'copier_count':
      return stats.copierCount
    case 'total_positions':
      return stats.totalPositions
    case 'sortino':
    case 'calmar':
    case 'volatility':
      return stats.extras[metric]
  }
}

/**
 * Declared contracts, keyed by source slug. Declaring a source is a reviewed
 * change that adds its contract here AND a migration that registers
 * profileCaptureContractSha256(contract) for it (see
 * docs/PROFILE_CAPTURE_EVIDENCE.md); until that row exists, start refuses the
 * attempt and the source publishes unattested exactly as before.
 */
const PROFILE_CAPTURE_CONTRACTS: ReadonlyMap<string, ProfileCaptureContract> = new Map(
  [TOOBIT_FUTURES_PROFILE_CAPTURE].map((contract) => [contract.sourceSlug, contract])
)

export function getProfileCaptureContract(
  sourceSlug: string,
  registry: ReadonlyMap<string, ProfileCaptureContract> = PROFILE_CAPTURE_CONTRACTS
): ProfileCaptureContract | null {
  const contract = registry.get(sourceSlug) ?? null
  if (contract) {
    assertProfileCaptureContract(contract)
    if (contract.sourceSlug !== sourceSlug) {
      throw new TypeError(`[profile-capture] registry key ${sourceSlug} holds another source`)
    }
  }
  return contract
}
