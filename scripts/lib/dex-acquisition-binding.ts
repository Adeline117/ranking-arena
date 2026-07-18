import { isDeepStrictEqual } from 'node:util'
import { deserialize, serialize } from 'node:v8'

import {
  dexAcquisitionRunManifestSha256,
  type DexAcquisitionRunManifest,
  parseDexAcquisitionRunManifest,
} from './dex-acquisition-run-manifest'
import {
  type DexAcquisitionTranscript,
  parseDexAcquisitionTranscript,
} from './dex-acquisition-transcript'
import { parseDexGoldenWalletSnapshot } from './dex-golden-wallets'

declare const CONSISTENT_PAIR_TYPE: unique symbol

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T

type ConsistentPairState = Readonly<{
  manifest: DeepReadonly<DexAcquisitionRunManifest>
  transcript: DeepReadonly<DexAcquisitionTranscript>
}>

export type DexAcquisitionConsistentPair = Readonly<{
  [CONSISTENT_PAIR_TYPE]: true
  toJSON(): never
}>

export type DexAcquisitionConsistentPairInspection = ConsistentPairState

export type DexAcquisitionConsistencyInputs = Readonly<{
  manifestInput: unknown
  transcriptInput: unknown
  parentSnapshotInput: unknown
}>

const CONSISTENT_PAIR_STATES = new WeakMap<object, ConsistentPairState>()

type TelemetryPhaseName = keyof DexAcquisitionTranscript['telemetry']['phases']

function assertSame(label: string, actual: unknown, expected: unknown): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`acquisition transcript conflicts with its run manifest: ${label}`)
  }
}

function assertWindowProjection(
  manifest: DexAcquisitionRunManifest,
  transcript: DexAcquisitionTranscript
): void {
  assertSame('window timeframe', transcript.window.timeframe_days, manifest.window.timeframe_days)
  assertSame('window semantics', transcript.window.semantics, manifest.window.semantics)
  assertSame('window start', transcript.window.start_at, manifest.window.start_at)
  assertSame('window end', transcript.window.end_at, manifest.window.end_at)
  assertSame(
    'window duration',
    transcript.window.duration_seconds,
    manifest.window.duration_seconds
  )
  assertSame(
    'window start height',
    transcript.window.height_range.start_inclusive,
    manifest.window.height_range.start_inclusive
  )
  assertSame(
    'window end height',
    transcript.window.height_range.end_exclusive,
    manifest.window.height_range.end_exclusive
  )
}

function assertEndpointProjection(
  manifest: DexAcquisitionRunManifest,
  transcript: DexAcquisitionTranscript
): void {
  const planned = manifest.endpoint_bindings
  const observed = transcript.endpoint_bindings
  assertSame('endpoint registry contract', observed.registry_contract, planned.registry_contract)
  assertSame('endpoint registry SHA', observed.registry_sha256, planned.registry_sha256)
  assertSame('endpoint profiles', observed.profiles, planned.profiles)
  assertSame('endpoint phase bindings', observed.phases, planned.phases)
  assertSame('endpoint redirect policy', observed.redirect_policy, planned.redirect_policy)
  assertSame('endpoint retry policy', observed.retry_endpoint_policy, planned.retry_endpoint_policy)
  assertSame(
    'endpoint failover policy',
    observed.provider_failover_policy,
    planned.provider_failover_policy
  )
}

function assertProtocolProjection(
  manifest: DexAcquisitionRunManifest,
  transcript: DexAcquisitionTranscript
): void {
  const expectedSha256 =
    manifest.protocol_manifest.state === 'bound' ? manifest.protocol_manifest.sha256 : null
  assertSame('protocol manifest SHA', transcript.artifacts.protocol_manifest_sha256, expectedSha256)
  if (manifest.protocol_manifest.state === 'bound') {
    const scope = transcript.query_lanes[0]?.scope
    if (scope?.kind !== 'all_protocol_manifest_events') {
      throw new Error('acquisition protocol manifest requires a protocol-event query lane')
    }
    assertSame(
      'protocol manifest contract',
      scope.protocol_manifest_contract,
      manifest.protocol_manifest.contract_id
    )
  }
}

function assertPhaseBudgets(
  manifest: DexAcquisitionRunManifest,
  transcript: DexAcquisitionTranscript
): void {
  const budget = manifest.query_policy.budgets
  for (const phaseName of Object.keys(transcript.telemetry.phases) as TelemetryPhaseName[]) {
    const actual = transcript.telemetry.phases[phaseName]
    const maximum = budget.phases[phaseName]
    if (
      actual.request_count > maximum.max_request_attempts ||
      actual.response_wire_bytes > maximum.max_wire_bytes ||
      actual.response_decoded_bytes > maximum.max_decoded_bytes
    ) {
      throw new Error(`acquisition transcript exceeds its run-manifest phase budget: ${phaseName}`)
    }
    // Accepted semantic responses must contain at least one encoded and
    // decoded byte. V2 does not define whether rate-limit/error body bytes
    // include HTTP/RPC status metadata, so those responses receive no floor.
    if (
      actual.request_bytes < actual.request_count ||
      actual.response_wire_bytes < actual.accepted_response_count ||
      actual.response_decoded_bytes < actual.accepted_response_count
    ) {
      throw new Error(`acquisition transcript has impossible byte totals: ${phaseName}`)
    }
  }
  if (transcript.telemetry.duration_ms > budget.max_run_duration_ms) {
    throw new Error('acquisition transcript exceeds its run-manifest duration budget')
  }
  if (transcript.telemetry.request_count > 0 && transcript.telemetry.duration_ms === 0) {
    throw new Error('acquisition transcript has zero duration for recorded network requests')
  }

  const discovery = transcript.telemetry.phases.discovery
  if (discovery.request_count !== transcript.query_totals.attempt_count) {
    throw new Error('acquisition transcript contains unattributed discovery request attempts')
  }
  if (discovery.accepted_response_count !== transcript.query_totals.page_count) {
    throw new Error('acquisition transcript contains unattributed accepted discovery responses')
  }

  const maximumLaneAttempts =
    BigInt(budget.max_pages_per_lane) * BigInt(budget.max_attempts_per_request)
  for (const lane of transcript.query_lanes) {
    if (
      lane.page_count > budget.max_pages_per_lane ||
      BigInt(lane.attempt_count) > maximumLaneAttempts
    ) {
      throw new Error('acquisition transcript query lane exceeds its run-manifest budget')
    }
  }

  if (manifest.query_policy.lane_topology.kind === 'one_per_golden_wallet') {
    if (
      transcript.wallet_results.some(
        (result) => result.candidate_identity_count > budget.max_raw_candidates_per_lane
      )
    ) {
      throw new Error('acquisition transcript wallet lane exceeds its raw-candidate budget')
    }
  }

  if (
    BigInt(discovery.response_wire_bytes) >
      BigInt(discovery.request_count) * BigInt(budget.max_response_wire_bytes_per_page) ||
    BigInt(discovery.response_decoded_bytes) >
      BigInt(discovery.request_count) * BigInt(budget.max_response_decoded_bytes_per_page)
  ) {
    throw new Error(
      'acquisition transcript discovery aggregate exceeds its per-page-derived envelope'
    )
  }

  const transactionEvidence = transcript.telemetry.phases.transaction_evidence
  const candidatePolicy = manifest.query_policy.candidate_evidence
  const maximumEvidenceAttempts =
    BigInt(transcript.candidate_totals.unique_in_window_candidate_count) *
    BigInt(candidatePolicy.rpc_request_upper_bound_per_candidate) *
    BigInt(budget.max_attempts_per_request)
  if (BigInt(transactionEvidence.request_count) > maximumEvidenceAttempts) {
    throw new Error('acquisition transcript transaction requests exceed candidate RPC fan-out')
  }
  if (
    BigInt(transactionEvidence.response_wire_bytes) >
      BigInt(transactionEvidence.request_count) *
        BigInt(candidatePolicy.max_response_wire_bytes_per_rpc) ||
    BigInt(transactionEvidence.response_decoded_bytes) >
      BigInt(transactionEvidence.request_count) *
        BigInt(candidatePolicy.max_response_decoded_bytes_per_rpc)
  ) {
    throw new Error(
      'acquisition transcript transaction aggregate exceeds its per-RPC-derived envelope'
    )
  }

  const billedUsd = transcript.telemetry.cost.billed_usd
  if (
    billedUsd !== null &&
    compareCanonicalDecimals(billedUsd, budget.billing.max_billed_usd) > 0
  ) {
    throw new Error('acquisition transcript exceeds its run-manifest billing cap')
  }
}

function compareCanonicalDecimals(left: string, right: string): number {
  const [leftWhole, leftFraction = ''] = left.split('.')
  const [rightWhole, rightFraction = ''] = right.split('.')
  const scale = Math.max(leftFraction.length, rightFraction.length)
  const leftScaled = BigInt(leftWhole + leftFraction.padEnd(scale, '0'))
  const rightScaled = BigInt(rightWhole + rightFraction.padEnd(scale, '0'))
  return leftScaled < rightScaled ? -1 : leftScaled > rightScaled ? 1 : 0
}

function assertPairConsistency(
  manifest: DexAcquisitionRunManifest,
  transcript: DexAcquisitionTranscript,
  manifestSha256: string
): void {
  assertSame('purpose', transcript.purpose, manifest.purpose)
  assertSame('mode', transcript.mode, manifest.mode)
  assertSame('chain', transcript.chain, manifest.chain)
  assertSame('golden sample', transcript.golden_sample, manifest.golden_sample)
  assertSame('source', transcript.source, manifest.source)
  assertSame('runner revision', transcript.generator_git_sha, manifest.runner_git_sha)
  if (Date.parse(transcript.generated_at) < Date.parse(manifest.resolved_at)) {
    throw new Error('acquisition transcript was generated before its run manifest resolved')
  }

  assertSame('run manifest SHA', transcript.artifacts.run_manifest_sha256, manifestSha256)
  assertSame(
    'query policy SHA',
    transcript.artifacts.query_policy_sha256,
    manifest.query_policy_sha256
  )
  assertSame(
    'candidate evidence method',
    transcript.candidate_evidence.verification_method,
    manifest.query_policy.candidate_evidence.verification_method
  )
  assertSame(
    'query lane count',
    transcript.query_totals.lane_count,
    manifest.query_policy.lane_topology.lane_count
  )

  assertWindowProjection(manifest, transcript)
  assertEndpointProjection(manifest, transcript)
  assertProtocolProjection(manifest, transcript)
  assertPhaseBudgets(manifest, transcript)
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value as DeepReadonly<T>
}

function cloneVerifiedData<T>(value: T): T {
  return deserialize(serialize(value)) as T
}

function mintConsistentPair(
  manifest: DexAcquisitionRunManifest,
  transcript: DexAcquisitionTranscript
): DexAcquisitionConsistentPair {
  const token = Object.create(null) as object
  Object.defineProperty(token, 'toJSON', {
    value: () => {
      throw new TypeError('consistent DEX acquisition pair token is not serializable')
    },
  })
  Object.freeze(token)
  CONSISTENT_PAIR_STATES.set(
    token,
    Object.freeze({
      manifest: deepFreeze(manifest),
      transcript: deepFreeze(transcript),
    })
  )
  return token as DexAcquisitionConsistentPair
}

/**
 * Return fresh frozen inspection copies after a runtime WeakMap identity check.
 * The returned data is not a capability and cannot be passed in place of the
 * original consistency token.
 */
export function inspectDexAcquisitionConsistentPair(
  pair: unknown
): DexAcquisitionConsistentPairInspection {
  const state =
    pair !== null && typeof pair === 'object' ? CONSISTENT_PAIR_STATES.get(pair) : undefined
  if (state === undefined) {
    throw new TypeError('value is not a consistent DEX acquisition pair token')
  }
  return Object.freeze({
    manifest: deepFreeze(cloneVerifiedData(state.manifest)),
    transcript: deepFreeze(cloneVerifiedData(state.transcript)),
  })
}

/**
 * Verify that a structurally valid transcript is a consistent projection of
 * one structurally valid resolved run manifest and stays within the observable
 * summary limits for request attempts, aggregate response wire/decoded bytes,
 * duration, lanes, representable direct wallet candidates, and any reported
 * billed amount. Request-byte totals receive a plausibility floor because this
 * manifest version does not define a request-byte budget.
 *
 * This does not load or verify the registry, query template, toolchain,
 * boundary, page, checkpoint, transaction, pricing, or protocol artifacts.
 * Transcript-v2 anchor-semantic digests also have no defined equivalence to
 * run-manifest boundary-evidence digests and are deliberately not cross-bound
 * here. Batched and protocol-wide raw volume cannot be derived safely from
 * per-wallet aggregate rows, and unknown cost remains unknown. This token
 * therefore does not authorize network execution, persistence, serving, rank,
 * or score. Those decisions require a later trusted-artifact verifier and a
 * separate authorization token.
 */
export function verifyDexAcquisitionManifestTranscriptConsistency(
  inputs: DexAcquisitionConsistencyInputs
): DexAcquisitionConsistentPair {
  const { manifestInput, transcriptInput, parentSnapshotInput } = inputs
  const parentSnapshot = parseDexGoldenWalletSnapshot(parentSnapshotInput)
  const manifest = parseDexAcquisitionRunManifest(manifestInput, parentSnapshot)
  const transcript = parseDexAcquisitionTranscript(transcriptInput, parentSnapshot)
  const manifestSha256 = dexAcquisitionRunManifestSha256(manifest, parentSnapshot)
  assertPairConsistency(manifest, transcript, manifestSha256)

  return mintConsistentPair(manifest, transcript)
}
