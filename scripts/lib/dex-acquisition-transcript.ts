import { z } from 'zod'

import { dexContractSha256 } from './dex-contract-hash'
import {
  buildDexGoldenWalletChainSubset,
  DEX_GOLDEN_WALLET_CONTRACT,
  DEX_GOLDEN_WALLET_SUBSET_CONTRACT,
  dexGoldenWalletSnapshotSha256,
  type DexGoldenWalletSnapshot,
  parseDexGoldenWalletSnapshot,
} from './dex-golden-wallets'
import {
  DEX_ACQUISITION_RUN_WINDOW_SECONDS,
  dexAcquisitionObservedEndpointBindingsStructuralSchema,
  dexAcquisitionSourceStructuralSchema,
  parseDexAcquisitionEndpointBindingContext,
} from './dex-acquisition-run-manifest'

export const DEX_ACQUISITION_TRANSCRIPT_SCHEMA_VERSION = 2 as const
export const DEX_ACQUISITION_TRANSCRIPT_CONTRACT = 'arena.dex.acquisition-transcript@2' as const
export const DEX_TRANSACTION_MEMBERSHIP_INDEX_CONTRACT =
  'arena.dex.transaction-membership-index@1' as const
export const DEX_ACQUISITION_WINDOW_SECONDS = DEX_ACQUISITION_RUN_WINDOW_SECONDS

const SHA256 = /^[0-9a-f]{64}$/
const FULL_GIT_SHA = /^[0-9a-f]{40}$/
const LOGICAL_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const NON_NEGATIVE_CANONICAL_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/

const canonicalTimestampSchema = z
  .string()
  .refine(isCanonicalTimestamp, 'timestamp must be canonical ISO')
const utcMidnightSchema = canonicalTimestampSchema.refine(
  (value) => value.endsWith('T00:00:00.000Z'),
  'window boundary must be UTC midnight'
)
const sha256Schema = z
  .string()
  .regex(SHA256)
  .refine((value) => !/^0{64}$/.test(value), 'SHA-256 must be nonzero')
const logicalIdSchema = z.string().regex(LOGICAL_ID)
const safeNonNegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .refine((value) => Number.isSafeInteger(value) && !Object.is(value, -0), {
    message: 'integer must be safe and must not be negative zero',
  })
const safePositiveIntegerSchema = safeNonNegativeIntegerSchema.positive()
const nullableHeightSchema = safeNonNegativeIntegerSchema.nullable()

const bscChainSchema = z
  .object({
    namespace: z.literal('eip155'),
    reference: z.literal('56'),
    height_unit: z.literal('block'),
  })
  .strict()
const solanaChainSchema = z
  .object({
    namespace: z.literal('solana'),
    reference: z.literal('mainnet-beta'),
    height_unit: z.literal('slot'),
  })
  .strict()

const goldenSampleSchema = z
  .object({
    parent_contract: z.literal(DEX_GOLDEN_WALLET_CONTRACT),
    parent_snapshot_sha256: sha256Schema,
    subset_contract: z.literal(DEX_GOLDEN_WALLET_SUBSET_CONTRACT),
    subset_sha256: sha256Schema,
    source_slug: z.enum(['binance_web3_bsc', 'okx_web3_solana']),
    wallet_count: z.literal(50),
    selection_scope: z.literal('leaderboard_derived_stratified_technical_sample'),
  })
  .strict()

const windowSchema = z
  .object({
    timeframe_days: z.literal(7),
    semantics: z.literal('completed_utc_days_half_open'),
    start_at: utcMidnightSchema,
    end_at: utcMidnightSchema,
    duration_seconds: z.literal(DEX_ACQUISITION_WINDOW_SECONDS),
    height_range: z
      .object({
        start_inclusive: safeNonNegativeIntegerSchema,
        end_exclusive: safePositiveIntegerSchema,
        start_anchor_semantic_sha256: sha256Schema,
        end_anchor_semantic_sha256: sha256Schema,
      })
      .strict(),
  })
  .strict()

const artifactsSchema = z
  .object({
    run_manifest_sha256: sha256Schema,
    query_policy_sha256: sha256Schema,
    page_ledger_sha256: sha256Schema,
    checkpoint_chain_sha256: sha256Schema,
    transaction_evidence_index_sha256: sha256Schema,
    protocol_manifest_sha256: sha256Schema.nullable(),
  })
  .strict()

const candidateEvidenceSchema = z
  .object({
    data_contract: z.literal(DEX_TRANSACTION_MEMBERSHIP_INDEX_CONTRACT),
    verification_method: z.enum([
      'bsc_strict_rpc_receipt_status_block_membership',
      'solana_strict_rpc_signature_status_block_membership',
    ]),
    provider_independence: z.literal('not_asserted'),
  })
  .strict()

const blockCatalogSchema = z
  .object({
    state: z.enum(['complete', 'partial', 'not_run']),
    completeness_scope: z.literal('bound_catalog_profile_internal_continuity_only'),
    produced_unit_count: safeNonNegativeIntegerSchema,
    verified_skipped_unit_count: safeNonNegativeIntegerSchema,
    missing_unit_count: safeNonNegativeIntegerSchema,
    unexplained_gap_count: safeNonNegativeIntegerSchema,
    duplicate_delivery_count: safeNonNegativeIntegerSchema,
    out_of_order_count: safeNonNegativeIntegerSchema,
    first_observed_height: nullableHeightSchema,
    last_observed_height: nullableHeightSchema,
    evidence_sha256: sha256Schema.nullable(),
    source_separated_gap_evidence_sha256: sha256Schema.nullable(),
  })
  .strict()

const queryStateSchema = z.enum(['exhausted', 'partial', 'failed', 'not_attempted'])
const completionReasonSchema = z.enum([
  'cursor_exhausted',
  'window_boundary_reached',
  'range_sentinel_observed',
  'height_range_completed',
  'request_cap_reached',
  'provider_page_limit',
  'cursor_stalled',
  'rate_limited_after_progress',
  'transport_error_after_progress',
  'provider_error_after_progress',
  'transport_error_before_progress',
  'provider_error_before_progress',
  'invalid_response',
  'checkpoint_mismatch',
  'not_started',
])

const queryLaneSchema = z
  .object({
    lane_id: logicalIdSchema,
    endpoint_profile_id: logicalIdSchema,
    scope: z.union([
      z.object({ kind: z.literal('wallet'), wallet: z.string().min(1) }).strict(),
      z.object({ kind: z.literal('all_golden_wallets') }).strict(),
      z
        .object({
          kind: z.literal('all_protocol_manifest_events'),
          protocol_manifest_contract: z.enum([
            'arena.dex.bsc-protocol-manifest@1',
            'arena.dex.solana-protocol-manifest@1',
          ]),
          protocol_manifest_sha256: sha256Schema,
          upstream_filter: z.literal('all_manifest_deployments_and_events'),
          evaluation: z.literal('local_golden_50_match'),
        })
        .strict(),
    ]),
    query_state: queryStateSchema,
    completion_reason: completionReasonSchema,
    attempt_count: safeNonNegativeIntegerSchema,
    page_count: safeNonNegativeIntegerSchema,
    page_chain_sha256: sha256Schema.nullable(),
    checkpoint_sha256: sha256Schema.nullable(),
  })
  .strict()

const queryTotalsSchema = z
  .object({
    lane_count: z.union([z.literal(1), z.literal(50)]),
    exhausted_lane_count: safeNonNegativeIntegerSchema,
    partial_lane_count: safeNonNegativeIntegerSchema,
    failed_lane_count: safeNonNegativeIntegerSchema,
    not_attempted_lane_count: safeNonNegativeIntegerSchema,
    attempt_count: safeNonNegativeIntegerSchema,
    page_count: safeNonNegativeIntegerSchema,
  })
  .strict()

const walletResultSchema = z
  .object({
    wallet: z.string().min(1),
    cohort: z.enum(['top', 'deterministic_random', 'high_frequency']),
    candidate_identity_count: safeNonNegativeIntegerSchema,
    duplicate_candidate_count: safeNonNegativeIntegerSchema,
    outside_window_candidate_count: safeNonNegativeIntegerSchema,
    unique_in_window_candidate_count: safeNonNegativeIntegerSchema,
    strict_membership_execution_success_count: safeNonNegativeIntegerSchema,
    strict_membership_execution_failure_count: safeNonNegativeIntegerSchema,
    evidence_unavailable_count: safeNonNegativeIntegerSchema,
    evidence_rejected_count: safeNonNegativeIntegerSchema,
    first_candidate_height: nullableHeightSchema,
    last_candidate_height: nullableHeightSchema,
  })
  .strict()

const candidateTotalsSchema = z
  .object({
    wallet_count: z.literal(50),
    candidate_identity_count: safeNonNegativeIntegerSchema,
    duplicate_candidate_count: safeNonNegativeIntegerSchema,
    outside_window_candidate_count: safeNonNegativeIntegerSchema,
    unique_in_window_candidate_count: safeNonNegativeIntegerSchema,
    strict_membership_execution_success_count: safeNonNegativeIntegerSchema,
    strict_membership_execution_failure_count: safeNonNegativeIntegerSchema,
    evidence_unavailable_count: safeNonNegativeIntegerSchema,
    evidence_rejected_count: safeNonNegativeIntegerSchema,
  })
  .strict()

// An accepted response passed the phase-specific decoder and semantic checks;
// HTTP/RPC error bodies and rate-limit responses do not count as accepted.
const telemetryPhaseSchema = z
  .object({
    request_count: safeNonNegativeIntegerSchema,
    accepted_response_count: safeNonNegativeIntegerSchema,
    request_bytes: safeNonNegativeIntegerSchema,
    response_wire_bytes: safeNonNegativeIntegerSchema,
    response_decoded_bytes: safeNonNegativeIntegerSchema,
    retry_count: safeNonNegativeIntegerSchema,
    rate_limit_count: safeNonNegativeIntegerSchema,
  })
  .strict()

const telemetrySchema = z
  .object({
    accounting_scope: z.literal('manifest_resolution_and_acquisition'),
    phases: z
      .object({
        boundary_resolution: telemetryPhaseSchema,
        block_catalog: telemetryPhaseSchema,
        discovery: telemetryPhaseSchema,
        transaction_evidence: telemetryPhaseSchema,
        finality_anchor: telemetryPhaseSchema,
        gap_evidence: telemetryPhaseSchema,
      })
      .strict(),
    request_count: safeNonNegativeIntegerSchema,
    accepted_response_count: safeNonNegativeIntegerSchema,
    request_bytes: safeNonNegativeIntegerSchema,
    response_wire_bytes: safeNonNegativeIntegerSchema,
    response_decoded_bytes: safeNonNegativeIntegerSchema,
    duration_ms: safeNonNegativeIntegerSchema,
    retry_count: safeNonNegativeIntegerSchema,
    rate_limit_count: safeNonNegativeIntegerSchema,
    cost: z
      .object({
        measurement_state: z.enum(['unknown', 'public_tier_zero_billed', 'measured']),
        currency: z.literal('USD'),
        billed_usd: z.string().regex(NON_NEGATIVE_CANONICAL_DECIMAL).nullable(),
        pricing_evidence_sha256: sha256Schema.nullable(),
      })
      .strict(),
  })
  .strict()

const claimsSchema = z
  .object({
    technical_sample_scope: z.literal('leaderboard_derived_stratified_50_wallets'),
    query_exhaustion_scope: z.literal('provider_query_only'),
    block_catalog_scope: z.literal('bound_catalog_profile_internal_continuity_only'),
    wallet_chain_history_complete: z.literal(false),
    chain_population_complete: z.literal(false),
    population_denominator_eligible: z.literal(false),
    population_recall_measured: z.literal(false),
    population_recall: z.null(),
    referenced_artifacts_verified: z.literal(false),
    technical_run_complete: z.literal(false),
    source_independence_verified: z.literal(false),
  })
  .strict()

const transcriptSchema = z
  .object({
    schema_version: z.literal(DEX_ACQUISITION_TRANSCRIPT_SCHEMA_VERSION),
    data_contract: z.literal(DEX_ACQUISITION_TRANSCRIPT_CONTRACT),
    purpose: z.literal('phase0_7d_technical_bakeoff_only'),
    mode: z.literal('shadow_only'),
    generated_at: canonicalTimestampSchema,
    generator_git_sha: z
      .string()
      .regex(FULL_GIT_SHA)
      .refine((value) => !/^0{40}$/.test(value), 'git SHA must be nonzero'),
    structural_state: z.enum(['structurally_complete', 'partial', 'failed']),
    chain: z.union([bscChainSchema, solanaChainSchema]),
    golden_sample: goldenSampleSchema,
    window: windowSchema,
    source: dexAcquisitionSourceStructuralSchema,
    endpoint_bindings: dexAcquisitionObservedEndpointBindingsStructuralSchema,
    artifacts: artifactsSchema,
    candidate_evidence: candidateEvidenceSchema,
    block_catalog: blockCatalogSchema,
    query_lanes: z.array(queryLaneSchema).min(1).max(50),
    query_totals: queryTotalsSchema,
    wallet_results: z.array(walletResultSchema).length(50),
    candidate_totals: candidateTotalsSchema,
    telemetry: telemetrySchema,
    claims: claimsSchema,
    serving_authorized: z.literal(false),
    rank_eligible: z.literal(false),
    score_eligible: z.literal(false),
  })
  .strict()

export type DexAcquisitionQueryLane = z.infer<typeof queryLaneSchema>
export type DexAcquisitionWalletResult = z.infer<typeof walletResultSchema>
export type DexAcquisitionTranscript = z.infer<typeof transcriptSchema>
export type DexAcquisitionMode = DexAcquisitionTranscript['source']['acquisition_mode']

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function sumWalletResults(
  results: readonly DexAcquisitionWalletResult[],
  field:
    | 'candidate_identity_count'
    | 'duplicate_candidate_count'
    | 'outside_window_candidate_count'
    | 'unique_in_window_candidate_count'
    | 'strict_membership_execution_success_count'
    | 'strict_membership_execution_failure_count'
    | 'evidence_unavailable_count'
    | 'evidence_rejected_count'
): number {
  return results.reduce((total, result) => {
    const next = total + result[field]
    if (!Number.isSafeInteger(next)) throw new Error(`unsafe wallet total for ${field}`)
    return next
  }, 0)
}

function sumQueryLanes(
  lanes: readonly DexAcquisitionQueryLane[],
  field: 'attempt_count' | 'page_count'
): number {
  return lanes.reduce((total, lane) => {
    const next = total + lane[field]
    if (!Number.isSafeInteger(next)) throw new Error(`unsafe query-lane total for ${field}`)
    return next
  }, 0)
}

function assertDistinctEvidenceHashes(transcript: DexAcquisitionTranscript): void {
  const endpointHashes = [
    transcript.endpoint_bindings.registry_sha256,
    ...transcript.endpoint_bindings.profiles.flatMap((profile) => [
      profile.connection_descriptor_sha256,
      profile.endpoint_identity_sha256,
    ]),
  ]
  const hashes = [
    transcript.golden_sample.parent_snapshot_sha256,
    transcript.golden_sample.subset_sha256,
    transcript.window.height_range.start_anchor_semantic_sha256,
    transcript.window.height_range.end_anchor_semantic_sha256,
    ...endpointHashes,
    ...Object.values(transcript.artifacts),
    transcript.block_catalog.evidence_sha256,
    transcript.block_catalog.source_separated_gap_evidence_sha256,
    transcript.telemetry.cost.pricing_evidence_sha256,
    ...transcript.query_lanes.flatMap((lane) => [lane.page_chain_sha256, lane.checkpoint_sha256]),
  ].filter((value): value is string => value !== null)
  if (new Set(hashes).size !== hashes.length) {
    throw new Error('distinct evidence domains must not reuse a SHA-256 digest')
  }
}

function assertWindow(transcript: DexAcquisitionTranscript): void {
  const { window } = transcript
  const elapsedMs = Date.parse(window.end_at) - Date.parse(window.start_at)
  if (elapsedMs !== DEX_ACQUISITION_WINDOW_SECONDS * 1000) {
    throw new Error('acquisition window must be exactly seven completed UTC days')
  }
  if (Date.parse(transcript.generated_at) < Date.parse(window.end_at)) {
    throw new Error('acquisition transcript cannot be generated before its window ends')
  }
  if (window.height_range.end_exclusive <= window.height_range.start_inclusive) {
    throw new Error('acquisition height range must be non-empty and half-open')
  }
  if (
    window.height_range.start_anchor_semantic_sha256 ===
    window.height_range.end_anchor_semantic_sha256
  ) {
    throw new Error('distinct acquisition boundaries require distinct anchor evidence')
  }
}

function assertSource(transcript: DexAcquisitionTranscript): void {
  const {
    acquisition_mode: mode,
    completeness_scope: completenessScope,
    finality_claim: finality,
    query_shape: queryShape,
  } = transcript.source
  if (transcript.chain.namespace === 'eip155' && mode === 'solana_rpc_signatures_for_address') {
    throw new Error('BSC transcript cannot use the Solana signature acquisition mode')
  }
  if (transcript.chain.namespace === 'solana' && mode === 'bsc_provider_address_index') {
    throw new Error('Solana transcript cannot use the BSC address-index acquisition mode')
  }
  if (
    mode === 'solana_rpc_signatures_for_address' &&
    (finality !== 'strict_rpc_membership_bound' ||
      queryShape !== 'one_query_per_wallet' ||
      completenessScope !== 'rpc_address_signature_query')
  ) {
    throw new Error(
      'Solana RPC acquisition requires one query per wallet and strict RPC membership finality'
    )
  }
  if (
    mode === 'bsc_provider_address_index' &&
    (finality !== 'provider_index_with_strict_rpc_membership' ||
      queryShape !== 'one_query_per_wallet' ||
      completenessScope !== 'provider_address_index_query')
  ) {
    throw new Error(
      'BSC address-index acquisition requires one query per wallet and strict RPC membership finality'
    )
  }
  if (
    mode === 'sqd_finalized_stream_wallet_locator' &&
    (finality !== 'provider_finalized_stream_assertion' ||
      queryShape !== 'batched_wallet_locator' ||
      completenessScope !== 'provider_dataset_wallet_locator_query')
  ) {
    throw new Error(
      'SQD acquisition requires a batched wallet locator and provider finalized-stream finality'
    )
  }
  if (
    mode === 'manifest_protocol_event_rpc_scan' &&
    (finality !== 'strict_rpc_membership_bound' ||
      queryShape !== 'protocol_wide_local_match' ||
      completenessScope !== 'manifest_protocol_events_in_height_range')
  ) {
    throw new Error(
      'RPC protocol-event acquisition requires strict membership and protocol-wide local matching'
    )
  }
  if (
    mode === 'manifest_protocol_event_sqd_finalized_stream' &&
    (finality !== 'provider_finalized_stream_assertion' ||
      queryShape !== 'protocol_wide_local_match' ||
      completenessScope !== 'manifest_protocol_events_in_height_range')
  ) {
    throw new Error(
      'SQD protocol-event acquisition requires provider finality and protocol-wide local matching'
    )
  }

  const isProtocolMode =
    mode === 'manifest_protocol_event_rpc_scan' ||
    mode === 'manifest_protocol_event_sqd_finalized_stream'
  if (isProtocolMode !== (transcript.artifacts.protocol_manifest_sha256 !== null)) {
    throw new Error('protocol-event acquisition must exclusively bind a protocol manifest')
  }

  const expectedCandidateMethod =
    transcript.chain.namespace === 'eip155'
      ? 'bsc_strict_rpc_receipt_status_block_membership'
      : 'solana_strict_rpc_signature_status_block_membership'
  if (transcript.candidate_evidence.verification_method !== expectedCandidateMethod) {
    throw new Error('candidate evidence method conflicts with the transcript chain')
  }
}

function assertBlockCatalog(transcript: DexAcquisitionTranscript): void {
  const catalog = transcript.block_catalog
  const rangeSpan =
    transcript.window.height_range.end_exclusive - transcript.window.height_range.start_inclusive
  const accountedUnits =
    catalog.produced_unit_count + catalog.verified_skipped_unit_count + catalog.missing_unit_count
  if (!Number.isSafeInteger(accountedUnits)) {
    throw new Error('block catalog unit total is unsafe')
  }

  if (catalog.state === 'not_run') {
    const nonzeroCounts = [
      catalog.produced_unit_count,
      catalog.verified_skipped_unit_count,
      catalog.missing_unit_count,
      catalog.unexplained_gap_count,
      catalog.duplicate_delivery_count,
      catalog.out_of_order_count,
    ].some((value) => value !== 0)
    if (
      nonzeroCounts ||
      catalog.first_observed_height !== null ||
      catalog.last_observed_height !== null ||
      catalog.evidence_sha256 !== null ||
      catalog.source_separated_gap_evidence_sha256 !== null
    ) {
      throw new Error('not-run block catalog must be empty')
    }
    return
  }

  if (accountedUnits !== rangeSpan) {
    throw new Error('block catalog produced, skipped, and missing units must partition the range')
  }
  if (
    catalog.unexplained_gap_count > catalog.missing_unit_count ||
    (catalog.missing_unit_count === 0 && catalog.unexplained_gap_count !== 0)
  ) {
    throw new Error('unexplained gap count cannot exceed missing units')
  }
  if (catalog.duplicate_delivery_count > 0 && catalog.produced_unit_count === 0) {
    throw new Error('duplicate block delivery requires an observed produced unit')
  }
  if (catalog.out_of_order_count > 0 && catalog.produced_unit_count < 2) {
    throw new Error('out-of-order block delivery requires at least two produced units')
  }
  if (catalog.produced_unit_count === 0) {
    if (catalog.first_observed_height !== null || catalog.last_observed_height !== null) {
      throw new Error('empty block catalog cannot have observed height bounds')
    }
  } else {
    if (catalog.first_observed_height === null || catalog.last_observed_height === null) {
      throw new Error('non-empty block catalog requires observed height bounds')
    }
    if (
      catalog.first_observed_height < transcript.window.height_range.start_inclusive ||
      catalog.last_observed_height >= transcript.window.height_range.end_exclusive ||
      catalog.first_observed_height > catalog.last_observed_height
    ) {
      throw new Error('block catalog observed heights must remain inside the run range')
    }
    const observedSpan = catalog.last_observed_height - catalog.first_observed_height + 1
    if (!Number.isSafeInteger(observedSpan) || catalog.produced_unit_count > observedSpan) {
      throw new Error('produced units cannot exceed their observed height span')
    }
  }
  if (catalog.evidence_sha256 === null) {
    throw new Error('attempted block catalog requires evidence')
  }
  if (transcript.chain.namespace === 'eip155' && catalog.verified_skipped_unit_count !== 0) {
    throw new Error('BSC block ranges cannot classify skipped heights')
  }
  if (
    transcript.chain.namespace === 'solana' &&
    catalog.verified_skipped_unit_count > 0 &&
    catalog.source_separated_gap_evidence_sha256 === null
  ) {
    throw new Error('Solana skipped slots require source-separated gap evidence')
  }
  if (
    catalog.source_separated_gap_evidence_sha256 !== null &&
    (transcript.chain.namespace !== 'solana' || catalog.verified_skipped_unit_count === 0)
  ) {
    throw new Error('source-separated gap evidence is reserved for verified Solana skipped slots')
  }

  if (catalog.state === 'complete') {
    if (
      catalog.missing_unit_count !== 0 ||
      catalog.unexplained_gap_count !== 0 ||
      catalog.duplicate_delivery_count !== 0 ||
      catalog.out_of_order_count !== 0
    ) {
      throw new Error('complete block catalog cannot retain missing or disordered units')
    }
    if (catalog.first_observed_height !== transcript.window.height_range.start_inclusive) {
      throw new Error('complete block catalog must start at the frozen range boundary')
    }
    if (
      transcript.chain.namespace === 'eip155' &&
      catalog.last_observed_height !== transcript.window.height_range.end_exclusive - 1
    ) {
      throw new Error('complete BSC block catalog must end at the final in-window block')
    }
    if (transcript.chain.namespace === 'solana') {
      const trailingSlots =
        transcript.window.height_range.end_exclusive - 1 - catalog.last_observed_height!
      if (trailingSlots > catalog.verified_skipped_unit_count) {
        throw new Error('complete Solana catalog must account for every trailing slot')
      }
    }
  }
}

function assertWalletResult(
  result: DexAcquisitionWalletResult,
  transcript: DexAcquisitionTranscript
): void {
  if (
    result.candidate_identity_count !==
    result.duplicate_candidate_count +
      result.outside_window_candidate_count +
      result.unique_in_window_candidate_count
  ) {
    throw new Error(`candidate identities do not partition for wallet ${result.wallet}`)
  }
  if (
    result.unique_in_window_candidate_count !==
    result.strict_membership_execution_success_count +
      result.strict_membership_execution_failure_count +
      result.evidence_unavailable_count +
      result.evidence_rejected_count
  ) {
    throw new Error(`in-window evidence outcomes do not partition for wallet ${result.wallet}`)
  }

  const hasCandidates = result.unique_in_window_candidate_count > 0
  const hasBothHeightBounds =
    result.first_candidate_height !== null && result.last_candidate_height !== null
  const hasNeitherHeightBound =
    result.first_candidate_height === null && result.last_candidate_height === null
  if ((hasCandidates && !hasBothHeightBounds) || (!hasCandidates && !hasNeitherHeightBound)) {
    throw new Error(`candidate height bounds conflict with candidate count for ${result.wallet}`)
  }
  if (hasCandidates) {
    if (
      result.first_candidate_height! < transcript.window.height_range.start_inclusive ||
      result.last_candidate_height! >= transcript.window.height_range.end_exclusive ||
      result.first_candidate_height! > result.last_candidate_height!
    ) {
      throw new Error(`candidate height bounds are outside the window for ${result.wallet}`)
    }
  }
}

function exhaustedReasonsForMode(mode: DexAcquisitionMode): ReadonlySet<string> {
  if (mode === 'sqd_finalized_stream_wallet_locator') {
    return new Set(['range_sentinel_observed'])
  }
  if (mode === 'manifest_protocol_event_sqd_finalized_stream') {
    return new Set(['range_sentinel_observed'])
  }
  if (mode === 'manifest_protocol_event_rpc_scan') {
    return new Set(['height_range_completed'])
  }
  return new Set(['cursor_exhausted', 'window_boundary_reached'])
}

function assertQueryLane(lane: DexAcquisitionQueryLane, mode: DexAcquisitionMode): void {
  const pageHashExpected = lane.page_count > 0
  if (pageHashExpected !== (lane.page_chain_sha256 !== null)) {
    throw new Error(`page hash conflicts with page count for query lane ${lane.lane_id}`)
  }
  const attempted = lane.query_state !== 'not_attempted'
  if (attempted !== (lane.checkpoint_sha256 !== null)) {
    throw new Error(`checkpoint presence conflicts with query lane ${lane.lane_id}`)
  }

  const partialReasons = new Set([
    'request_cap_reached',
    'provider_page_limit',
    'cursor_stalled',
    'rate_limited_after_progress',
    'transport_error_after_progress',
    'provider_error_after_progress',
  ])
  const failedReasons = new Set([
    'transport_error_before_progress',
    'provider_error_before_progress',
    'invalid_response',
    'checkpoint_mismatch',
  ])

  if (lane.query_state === 'not_attempted') {
    if (
      lane.completion_reason !== 'not_started' ||
      lane.attempt_count !== 0 ||
      lane.page_count !== 0
    ) {
      throw new Error(`not-attempted query lane must remain empty: ${lane.lane_id}`)
    }
  } else if (lane.query_state === 'exhausted') {
    if (
      !exhaustedReasonsForMode(mode).has(lane.completion_reason) ||
      lane.attempt_count === 0 ||
      lane.page_count === 0
    ) {
      throw new Error(`exhausted query lane has inconsistent completion evidence: ${lane.lane_id}`)
    }
  } else if (lane.query_state === 'partial') {
    if (
      !partialReasons.has(lane.completion_reason) ||
      lane.attempt_count === 0 ||
      lane.page_count === 0
    ) {
      throw new Error(`partial query lane has inconsistent completion evidence: ${lane.lane_id}`)
    }
  } else {
    if (
      !failedReasons.has(lane.completion_reason) ||
      lane.attempt_count === 0 ||
      lane.page_count !== 0
    ) {
      throw new Error(`failed query lane has inconsistent completion evidence: ${lane.lane_id}`)
    }
  }
}

function assertQueryTotals(transcript: DexAcquisitionTranscript): void {
  const lanes = transcript.query_lanes
  const totals = transcript.query_totals
  const expectedLaneCount = transcript.source.query_shape === 'one_query_per_wallet' ? 50 : 1
  if (lanes.length !== expectedLaneCount || totals.lane_count !== expectedLaneCount) {
    throw new Error(`query shape requires exactly ${expectedLaneCount} query lanes`)
  }
  const states = {
    exhausted_lane_count: lanes.filter((lane) => lane.query_state === 'exhausted').length,
    partial_lane_count: lanes.filter((lane) => lane.query_state === 'partial').length,
    failed_lane_count: lanes.filter((lane) => lane.query_state === 'failed').length,
    not_attempted_lane_count: lanes.filter((lane) => lane.query_state === 'not_attempted').length,
  }
  for (const [field, expected] of Object.entries(states)) {
    if (totals[field as keyof typeof states] !== expected) {
      throw new Error(`query-lane state total does not match lanes: ${field}`)
    }
  }
  if (
    totals.exhausted_lane_count +
      totals.partial_lane_count +
      totals.failed_lane_count +
      totals.not_attempted_lane_count !==
    totals.lane_count
  ) {
    throw new Error('query states must partition every query lane')
  }
  for (const field of ['attempt_count', 'page_count'] as const) {
    if (totals[field] !== sumQueryLanes(lanes, field)) {
      throw new Error(`query aggregate does not match lanes: ${field}`)
    }
  }
}

function assertCandidateTotals(transcript: DexAcquisitionTranscript): void {
  const results = transcript.wallet_results
  const totals = transcript.candidate_totals
  const sumFields = [
    'candidate_identity_count',
    'duplicate_candidate_count',
    'outside_window_candidate_count',
    'unique_in_window_candidate_count',
    'strict_membership_execution_success_count',
    'strict_membership_execution_failure_count',
    'evidence_unavailable_count',
    'evidence_rejected_count',
  ] as const
  for (const field of sumFields) {
    if (totals[field] !== sumWalletResults(results, field)) {
      throw new Error(`wallet aggregate does not match rows: ${field}`)
    }
  }
  if (transcript.query_totals.page_count === 0 && totals.candidate_identity_count !== 0) {
    throw new Error('wallet candidates require at least one committed query page')
  }
}

function assertStructuralState(transcript: DexAcquisitionTranscript): void {
  const isStructurallyComplete =
    transcript.query_totals.exhausted_lane_count === transcript.query_totals.lane_count &&
    transcript.block_catalog.state === 'complete' &&
    transcript.candidate_totals.evidence_unavailable_count === 0 &&
    transcript.candidate_totals.evidence_rejected_count === 0
  const isFailed =
    transcript.query_totals.exhausted_lane_count === 0 &&
    transcript.query_totals.partial_lane_count === 0 &&
    transcript.query_totals.failed_lane_count > 0
  const expectedState = isStructurallyComplete
    ? 'structurally_complete'
    : isFailed
      ? 'failed'
      : 'partial'
  if (transcript.structural_state !== expectedState) {
    throw new Error(`structural_state must be ${expectedState} for the recorded summary`)
  }
}

function assertTelemetry(transcript: DexAcquisitionTranscript): void {
  const { telemetry } = transcript
  const phaseFields = [
    'request_count',
    'accepted_response_count',
    'request_bytes',
    'response_wire_bytes',
    'response_decoded_bytes',
    'retry_count',
    'rate_limit_count',
  ] as const
  const phases = Object.entries(telemetry.phases) as Array<
    [keyof typeof telemetry.phases, (typeof telemetry.phases)[keyof typeof telemetry.phases]]
  >
  for (const field of phaseFields) {
    const total = phases.reduce((sum, [, phase]) => {
      const next = sum + phase[field]
      if (!Number.isSafeInteger(next)) throw new Error(`unsafe telemetry phase total: ${field}`)
      return next
    }, 0)
    if (telemetry[field] !== total) {
      throw new Error(`telemetry total does not match phase counters: ${field}`)
    }
  }

  for (const [phaseName, phase] of phases) {
    if (phase.request_count === 0) {
      if (phaseFields.some((field) => field !== 'request_count' && phase[field] !== 0)) {
        throw new Error(`zero-request telemetry phase must remain empty: ${phaseName}`)
      }
    } else if (phase.request_bytes === 0) {
      throw new Error(`recorded telemetry phase requests require request bytes: ${phaseName}`)
    }
    if (
      phase.retry_count > phase.request_count ||
      phase.accepted_response_count + phase.rate_limit_count > phase.request_count
    ) {
      throw new Error(`telemetry response/retry count exceeds requests: ${phaseName}`)
    }
    if (
      phase.accepted_response_count > 0 &&
      (phase.response_wire_bytes === 0 || phase.response_decoded_bytes === 0)
    ) {
      throw new Error(`accepted telemetry responses require response bytes: ${phaseName}`)
    }
  }

  for (const [phaseName, phase] of [
    ['boundary_resolution', telemetry.phases.boundary_resolution],
    ['finality_anchor', telemetry.phases.finality_anchor],
  ] as const) {
    if (
      phase.request_count === 0 ||
      phase.accepted_response_count === 0 ||
      phase.response_wire_bytes === 0 ||
      phase.response_decoded_bytes === 0
    ) {
      throw new Error(`${phaseName} requires response-backed endpoint telemetry`)
    }
  }

  const catalogPhase = telemetry.phases.block_catalog
  if (transcript.block_catalog.state === 'not_run') {
    if (phaseFields.some((field) => catalogPhase[field] !== 0)) {
      throw new Error('not-run block catalog cannot contain catalog telemetry')
    }
  } else if (catalogPhase.request_count === 0 || catalogPhase.accepted_response_count === 0) {
    throw new Error('attempted block catalog requires an accepted catalog response')
  }

  const discoveryPhase = telemetry.phases.discovery
  if (
    transcript.query_totals.attempt_count === 0 &&
    phaseFields.some((field) => discoveryPhase[field] !== 0)
  ) {
    throw new Error('unattempted discovery lanes cannot contain discovery telemetry')
  }
  if (
    discoveryPhase.request_count < transcript.query_totals.page_count ||
    discoveryPhase.request_count < transcript.query_totals.attempt_count
  ) {
    throw new Error('discovery requests cannot be below recorded query pages or attempts')
  }
  if (
    transcript.query_totals.page_count > 0 &&
    (discoveryPhase.accepted_response_count < transcript.query_totals.page_count ||
      discoveryPhase.response_wire_bytes === 0 ||
      discoveryPhase.response_decoded_bytes === 0)
  ) {
    throw new Error('committed query pages require accepted discovery responses and bytes')
  }
  if (
    transcript.block_catalog.state !== 'not_run' &&
    (catalogPhase.response_wire_bytes === 0 || catalogPhase.response_decoded_bytes === 0)
  ) {
    throw new Error('attempted block catalog requires catalog response bytes')
  }

  const evidencePhase = telemetry.phases.transaction_evidence
  if (transcript.candidate_totals.unique_in_window_candidate_count === 0) {
    if (phaseFields.some((field) => evidencePhase[field] !== 0)) {
      throw new Error('empty candidate set cannot contain transaction-evidence telemetry')
    }
  } else if (evidencePhase.request_count === 0) {
    throw new Error('in-window candidates require transaction-evidence requests')
  }
  const responseBackedEvidenceCount =
    transcript.candidate_totals.strict_membership_execution_success_count +
    transcript.candidate_totals.strict_membership_execution_failure_count +
    transcript.candidate_totals.evidence_rejected_count
  if (
    responseBackedEvidenceCount > 0 &&
    (evidencePhase.accepted_response_count === 0 ||
      evidencePhase.response_wire_bytes === 0 ||
      evidencePhase.response_decoded_bytes === 0)
  ) {
    throw new Error('response-backed transaction evidence requires an accepted response and bytes')
  }

  const gapPhase = telemetry.phases.gap_evidence
  if (transcript.chain.namespace === 'eip155') {
    if (phaseFields.some((field) => gapPhase[field] !== 0)) {
      throw new Error('BSC acquisition cannot contain skipped-slot gap telemetry')
    }
  } else if (
    transcript.block_catalog.verified_skipped_unit_count > 0 &&
    (gapPhase.request_count === 0 ||
      gapPhase.accepted_response_count === 0 ||
      gapPhase.response_wire_bytes === 0 ||
      gapPhase.response_decoded_bytes === 0)
  ) {
    throw new Error('verified Solana skipped slots require response-backed gap telemetry')
  }
  if (
    transcript.block_catalog.state === 'not_run' &&
    phaseFields.some((field) => gapPhase[field] !== 0)
  ) {
    throw new Error('not-run block catalog cannot contain gap-evidence telemetry')
  }

  const { cost } = telemetry
  if (cost.measurement_state === 'unknown') {
    if (cost.billed_usd !== null || cost.pricing_evidence_sha256 !== null) {
      throw new Error('unknown cost must not claim a billed amount or pricing evidence')
    }
  } else if (cost.measurement_state === 'public_tier_zero_billed') {
    if (cost.billed_usd !== '0' || cost.pricing_evidence_sha256 === null) {
      throw new Error('zero-billed public tier requires a zero amount and pricing evidence')
    }
  } else if (cost.billed_usd === null || cost.pricing_evidence_sha256 === null) {
    throw new Error('measured cost requires an amount and pricing evidence')
  }
}

function assertGoldenSample(
  transcript: DexAcquisitionTranscript,
  parentSnapshot: DexGoldenWalletSnapshot
): void {
  const parentSha256 = dexGoldenWalletSnapshotSha256(parentSnapshot)
  const { subset, sha256: subsetSha256 } = buildDexGoldenWalletChainSubset(
    parentSnapshot,
    transcript.golden_sample.source_slug
  )
  if (transcript.golden_sample.parent_snapshot_sha256 !== parentSha256) {
    throw new Error(
      'acquisition transcript parent snapshot SHA does not match the supplied fixture'
    )
  }
  if (transcript.golden_sample.subset_sha256 !== subsetSha256) {
    throw new Error('acquisition transcript chain subset SHA does not match the supplied fixture')
  }
  if (
    transcript.chain.namespace !== subset.chain.namespace ||
    transcript.chain.reference !== subset.chain.reference
  ) {
    throw new Error('acquisition transcript chain conflicts with its golden-wallet subset')
  }
  for (let index = 0; index < subset.wallets.length; index += 1) {
    const expected = subset.wallets[index]
    const actual = transcript.wallet_results[index]
    if (actual.wallet !== expected.wallet || actual.cohort !== expected.cohort) {
      throw new Error('acquisition wallet results must preserve exact subset wallet/cohort order')
    }
  }

  const discoveryProfileId = transcript.endpoint_bindings.phases.discovery
  if (transcript.query_lanes.some((lane) => lane.endpoint_profile_id !== discoveryProfileId)) {
    throw new Error('every query lane must bind the exact discovery endpoint profile')
  }

  if (transcript.source.query_shape === 'one_query_per_wallet') {
    for (let index = 0; index < subset.wallets.length; index += 1) {
      const lane = transcript.query_lanes[index]
      const expectedWallet = subset.wallets[index].wallet
      const expectedLaneId = `wallet-${String(index).padStart(2, '0')}`
      if (
        lane?.lane_id !== expectedLaneId ||
        lane.scope.kind !== 'wallet' ||
        lane.scope.wallet !== expectedWallet
      ) {
        throw new Error('per-wallet query lanes must preserve exact subset wallet order')
      }
      if (transcript.wallet_results[index].candidate_identity_count > 0 && lane.page_count === 0) {
        throw new Error('wallet candidates require a committed page in their matching query lane')
      }
    }
  } else if (transcript.source.query_shape === 'batched_wallet_locator') {
    const lane = transcript.query_lanes[0]
    if (lane?.lane_id !== 'all-golden-wallets' || lane.scope.kind !== 'all_golden_wallets') {
      throw new Error('batched wallet queries require one all-golden-wallet query lane')
    }
    if (transcript.candidate_totals.candidate_identity_count > 0 && lane.page_count === 0) {
      throw new Error('all-wallet candidates require a committed shared query page')
    }
  } else {
    const lane = transcript.query_lanes[0]
    const expectedContract =
      transcript.chain.namespace === 'eip155'
        ? 'arena.dex.bsc-protocol-manifest@1'
        : 'arena.dex.solana-protocol-manifest@1'
    if (
      lane?.lane_id !== 'all-protocol-manifest-events' ||
      lane.scope.kind !== 'all_protocol_manifest_events' ||
      lane.scope.protocol_manifest_contract !== expectedContract ||
      lane.scope.protocol_manifest_sha256 !== transcript.artifacts.protocol_manifest_sha256
    ) {
      throw new Error('protocol-wide queries require one exact manifest-event query lane')
    }
    if (transcript.candidate_totals.candidate_identity_count > 0 && lane.page_count === 0) {
      throw new Error('protocol-linked wallet candidates require a committed shared query page')
    }
  }

  for (const field of ['page_chain_sha256', 'checkpoint_sha256'] as const) {
    const hashes = transcript.query_lanes
      .map((lane) => lane[field])
      .filter((value): value is string => value !== null)
    if (new Set(hashes).size !== hashes.length) {
      throw new Error(`query lanes must not share ${field}`)
    }
  }
}

function assertTranscriptInvariants(
  transcript: DexAcquisitionTranscript,
  parentSnapshot: DexGoldenWalletSnapshot
): void {
  assertWindow(transcript)
  assertSource(transcript)
  parseDexAcquisitionEndpointBindingContext({
    chain: transcript.chain,
    source: transcript.source,
    endpoint_bindings: transcript.endpoint_bindings,
  })
  assertGoldenSample(transcript, parentSnapshot)
  assertDistinctEvidenceHashes(transcript)
  assertBlockCatalog(transcript)
  for (const lane of transcript.query_lanes) {
    assertQueryLane(lane, transcript.source.acquisition_mode)
  }
  for (const result of transcript.wallet_results) assertWalletResult(result, transcript)
  assertQueryTotals(transcript)
  assertCandidateTotals(transcript)
  assertStructuralState(transcript)
  assertTelemetry(transcript)
}

/**
 * Parse a single-chain, phase-bound-endpoint, fixed-window technical transcript.
 * The supplied parent fixture is re-derived so a plausible-looking subset SHA
 * or reordered 50-wallet result set cannot be accepted on its own. This parser
 * validates the summary and its content-addressed references; it deliberately
 * keeps artifact verification and technical completion false until a separate
 * verifier replays the referenced page/checkpoint/evidence artifacts.
 */
export function parseDexAcquisitionTranscript(
  input: unknown,
  parentSnapshotInput: unknown
): DexAcquisitionTranscript {
  const transcript = transcriptSchema.parse(input)
  const parentSnapshot = parseDexGoldenWalletSnapshot(parentSnapshotInput)
  assertTranscriptInvariants(transcript, parentSnapshot)
  return transcript
}

export function dexAcquisitionTranscriptSha256(
  input: unknown,
  parentSnapshotInput: unknown
): string {
  const transcript = parseDexAcquisitionTranscript(input, parentSnapshotInput)
  return dexContractSha256(
    {
      domain: 'arena.dex.acquisition-transcript',
      schema_id: DEX_ACQUISITION_TRANSCRIPT_CONTRACT,
      schema_version: DEX_ACQUISITION_TRANSCRIPT_SCHEMA_VERSION,
    },
    transcript
  )
}
