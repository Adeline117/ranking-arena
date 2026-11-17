/**
 * Generic, pure attempt-bound profile capture (migration 20261116215328).
 *
 * Given one attempt's RAW pages, the parser's stats block for the attempt's
 * timeframe and the block that will actually be stored (after staging
 * validation), it either proves the capture complete under the source's
 * contract and returns the manifest the ledger records, or returns a typed
 * terminal outcome that attests nothing.
 *
 * Complete means: every page came from a declared endpoint, every required
 * endpoint answered exactly once, every response is strict-canonical JSON, and
 * for every declared metric the parser's value equals the transformed value at
 * the declared RAW field path. A metric is then attested when its stored value
 * equals the parser's value (a value clamped or nulled by validation is the
 * source's value no longer and is left unattested). The database trigger
 * re-checks the stored value against the manifest on every write.
 */

import type { ParsedStats, RankingTimeframe, RawPage } from '../core/types'
import { strictCanonicalSha256 } from '../strict-canonical-json'
import {
  assertProfileCaptureContract,
  parsedStatsMetricValue,
  profileContractMetrics,
  resolveProfileMetricPath,
  type ProfileAttestableMetric,
  type ProfileCaptureContract,
  type ProfileEndpointContract,
  type ProfileMetricTransform,
} from './contract'

export const PROFILE_ACQUISITION_MANIFEST_CONTRACT = 'profile-acquisition-manifest@1' as const
export const PROFILE_REQUEST_PROJECTION_CONTRACT = 'arena.profile-request-projection@1' as const

export type ProfileTerminalState =
  | 'complete'
  | 'partial'
  | 'upstream_failed'
  | 'processing_failed'
  | 'quality_rejected'
  | 'abandoned'

export type ProfileReasonCode =
  | 'endpoint_missing'
  | 'undeclared_endpoint'
  | 'duplicate_endpoint_page'
  | 'response_not_canonical'
  | 'stats_block_missing'
  | 'projection_mismatch'
  | 'profile_window_incomplete'
  | 'parse_failed'
  | 'quality_rejected'
  | 'upstream_gone'
  | 'upstream_error'
  | 'raw_persistence_failed'

export interface ProfileRequestRecord {
  endpoint: string
  request_projection_sha256: string
  response_sha256: string
}

export interface ProfileMetricAttestation {
  endpoint: string
  path: Array<string | number>
  raw_value: number | string
  /** The parser's (and stored) value. */
  value: number
}

export interface ProfileAcquisitionManifest {
  contract: typeof PROFILE_ACQUISITION_MANIFEST_CONTRACT
  attempt_id: string
  capture_contract: string
  capture_contract_sha256: string
  source_slug: string
  exchange_trader_id: string
  timeframe: RankingTimeframe
  requests: ProfileRequestRecord[]
  metrics: Partial<Record<ProfileAttestableMetric, ProfileMetricAttestation>>
}

export type ProfileCaptureResult =
  | {
      terminalState: 'complete'
      reasonCode: null
      manifest: ProfileAcquisitionManifest
      sourceRunId: string
      attestedMetrics: ProfileAttestableMetric[]
    }
  | {
      terminalState: Exclude<ProfileTerminalState, 'complete'>
      reasonCode: ProfileReasonCode
      detail: string
      manifest: null
      sourceRunId: null
      attestedMetrics: []
    }

export interface BuildProfileAcquisitionInput {
  contract: ProfileCaptureContract
  contractSha256: string
  attemptId: string
  exchangeTraderId: string
  timeframe: RankingTimeframe
  pages: readonly RawPage[]
  /** The parser's block for `timeframe` (null when the parser produced none). */
  parsed: ParsedStats | null
  /** The block that will be stored (after validation); null when rejected. */
  stored: ParsedStats | null
}

export function profileOutcome(
  terminalState: Exclude<ProfileTerminalState, 'complete'>,
  reasonCode: ProfileReasonCode,
  detail: string
): ProfileCaptureResult {
  return {
    terminalState,
    reasonCode,
    detail,
    manifest: null,
    sourceRunId: null,
    attestedMetrics: [],
  }
}

function endpointFor(
  contract: ProfileCaptureContract,
  url: URL
): ProfileEndpointContract | undefined {
  return contract.endpoints.find(
    (endpoint) => endpoint.origin === url.origin && endpoint.pathname === url.pathname
  )
}

/** Credential-free identity of one profile request. */
export function profileRequestProjection(
  contract: ProfileCaptureContract,
  endpoint: ProfileEndpointContract,
  url: URL
): Record<string, unknown> {
  const query = [...url.searchParams.entries()]
    .filter(([key]) => endpoint.queryAllowlist.includes(key))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey
        ? leftValue < rightValue
          ? -1
          : leftValue > rightValue
            ? 1
            : 0
        : leftKey < rightKey
          ? -1
          : 1
    )
  return {
    contract: PROFILE_REQUEST_PROJECTION_CONTRACT,
    capture_contract: contract.captureContract,
    endpoint: endpoint.id,
    origin: endpoint.origin,
    pathname: endpoint.pathname,
    query,
  }
}

function fieldValue(payload: unknown, path: readonly (string | number)[] | null): unknown {
  if (path === null) return undefined
  let value = payload
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(value) || segment < 0 || segment >= value.length) return undefined
      value = value[segment]
    } else {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
      if (!Object.prototype.hasOwnProperty.call(value, segment)) return undefined
      value = (value as Record<string, unknown>)[segment]
    }
  }
  return value
}

const NUMERIC_TEXT = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/

function rawNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && NUMERIC_TEXT.test(value)) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function applyTransform(value: number, transform: ProfileMetricTransform): number {
  switch (transform) {
    case 'identity':
      return value
    case 'fraction_to_percent':
      return value * 100
    case 'abs':
      return Math.abs(value)
    case 'abs_fraction_to_percent':
      return Math.abs(value) * 100
    case 'decimal_e2':
      return value / 1e2
    case 'decimal_e4':
      return value / 1e4
    case 'decimal_e8':
      return value / 1e8
  }
}

/** Equal within float noise of the transform (never a unit or rounding gap). */
export function sameMetricValue(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right))
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function buildProfileAcquisition(input: BuildProfileAcquisitionInput): ProfileCaptureResult {
  const { contract } = input
  assertProfileCaptureContract(contract)
  if (!contract.timeframes.includes(input.timeframe)) {
    throw new TypeError(
      `[profile-capture] ${contract.captureContract} does not cover ${input.timeframe}d`
    )
  }

  const pagesByEndpoint = new Map<string, RawPage>()
  const requests: ProfileRequestRecord[] = []
  for (const page of input.pages) {
    let url: URL
    try {
      url = new URL(page.url)
    } catch {
      return profileOutcome('processing_failed', 'undeclared_endpoint', `unparseable url`)
    }
    const endpoint = endpointFor(contract, url)
    if (!endpoint) {
      return profileOutcome(
        'processing_failed',
        'undeclared_endpoint',
        `${url.origin}${url.pathname} is not declared`
      )
    }
    if (pagesByEndpoint.has(endpoint.id)) {
      return profileOutcome(
        'processing_failed',
        'duplicate_endpoint_page',
        `endpoint ${endpoint.id} answered more than once`
      )
    }
    let responseSha256: string
    try {
      responseSha256 = strictCanonicalSha256(page.payload)
    } catch (error) {
      return profileOutcome(
        'processing_failed',
        'response_not_canonical',
        error instanceof Error ? error.message : String(error)
      )
    }
    pagesByEndpoint.set(endpoint.id, page)
    requests.push({
      endpoint: endpoint.id,
      request_projection_sha256: strictCanonicalSha256(
        profileRequestProjection(contract, endpoint, url)
      ),
      response_sha256: responseSha256,
    })
  }
  const missing = contract.endpoints.filter(
    (endpoint) => endpoint.required && !pagesByEndpoint.has(endpoint.id)
  )
  if (missing.length > 0) {
    return profileOutcome(
      'partial',
      'endpoint_missing',
      `required endpoint(s) ${missing.map((endpoint) => endpoint.id).join(',')} missing`
    )
  }
  if (input.parsed === null || input.parsed.timeframe !== input.timeframe) {
    return profileOutcome(
      'processing_failed',
      'stats_block_missing',
      `no ${input.timeframe}d block`
    )
  }

  const metrics: ProfileAcquisitionManifest['metrics'] = {}
  for (const metric of profileContractMetrics(contract)) {
    const field = contract.metrics[metric]
    if (!field) continue
    const parsedValue = parsedStatsMetricValue(input.parsed, metric)
    if (parsedValue === null || parsedValue === undefined) continue // honest absence
    const parsed = finiteNumber(parsedValue)
    const page = pagesByEndpoint.get(field.endpoint)
    const path = resolveProfileMetricPath(field.path, input.timeframe)
    const rawValue = page ? fieldValue(page.payload, path) : undefined
    const raw = rawNumber(rawValue)
    if (
      parsed === null ||
      raw === null ||
      !sameMetricValue(applyTransform(raw, field.transform), parsed)
    ) {
      // The parser produced a value the declared field does not supply: the
      // contract or the parser is wrong, so nothing of this capture is evidence.
      return profileOutcome(
        'processing_failed',
        'projection_mismatch',
        `${metric}: parser ${String(parsedValue)} vs ${field.endpoint}.${(path ?? []).join('.')}=${JSON.stringify(rawValue)}`
      )
    }
    const stored = input.stored === null ? null : parsedStatsMetricValue(input.stored, metric)
    if (stored !== parsed) continue // clamped / nulled by validation
    metrics[metric] = {
      endpoint: field.endpoint,
      path: path ?? [],
      raw_value: rawValue as number | string,
      value: parsed,
    }
  }

  const manifest: ProfileAcquisitionManifest = {
    contract: PROFILE_ACQUISITION_MANIFEST_CONTRACT,
    attempt_id: input.attemptId,
    capture_contract: contract.captureContract,
    capture_contract_sha256: input.contractSha256,
    source_slug: contract.sourceSlug,
    exchange_trader_id: input.exchangeTraderId,
    timeframe: input.timeframe,
    requests,
    metrics,
  }
  return {
    terminalState: 'complete',
    reasonCode: null,
    manifest,
    sourceRunId: strictCanonicalSha256(manifest),
    attestedMetrics: (Object.keys(metrics) as ProfileAttestableMetric[]).sort(),
  }
}

/**
 * The stats block the Tier-B writer stores LAST for `timeframe`: pages are
 * published in order and each upsert replaces the row's typed values, so only
 * that block's values can still be in arena.trader_stats when the attempt
 * finishes. Returns its position (page index into `profiles`) too, so the
 * writer stamps evidence on exactly that publish.
 */
export function lastStatsBlock(
  profiles: ReadonlyArray<{ stats: readonly ParsedStats[] }>,
  timeframe: RankingTimeframe
): { profileIndex: number; block: ParsedStats } | null {
  for (let profileIndex = profiles.length - 1; profileIndex >= 0; profileIndex -= 1) {
    const stats = profiles[profileIndex].stats
    for (let blockIndex = stats.length - 1; blockIndex >= 0; blockIndex -= 1) {
      if (stats[blockIndex].timeframe === timeframe) {
        return { profileIndex, block: stats[blockIndex] }
      }
    }
  }
  return null
}
