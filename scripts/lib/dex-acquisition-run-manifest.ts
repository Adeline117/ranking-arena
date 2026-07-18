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

export const DEX_ACQUISITION_RUN_MANIFEST_SCHEMA_VERSION = 2 as const
export const DEX_ACQUISITION_RUN_MANIFEST_CONTRACT = 'arena.dex.acquisition-run-manifest@2' as const
export const DEX_ACQUISITION_QUERY_POLICY_SCHEMA_VERSION = 1 as const
export const DEX_ACQUISITION_QUERY_POLICY_CONTRACT = 'arena.dex.acquisition-query-policy@1' as const
export const DEX_ACQUISITION_ENDPOINT_PROFILE_CONTRACT =
  'arena.dex.acquisition-endpoint-profile@1' as const
export const DEX_ACQUISITION_CONNECTION_DESCRIPTOR_CONTRACT =
  'arena.dex.acquisition-connection-descriptor@1' as const
export const DEX_ACQUISITION_ENDPOINT_REGISTRY_CONTRACT =
  'arena.dex.acquisition-endpoint-registry@1' as const
export const DEX_ACQUISITION_ADAPTER_TOOLCHAIN_CONTRACT =
  'arena.dex.adapter-toolchain-manifest@1' as const
export const DEX_ACQUISITION_RUN_WINDOW_SECONDS = 7 * 24 * 60 * 60
export const DEX_ACQUISITION_MAX_CHAIN_CLOCK_SKEW_MS = 60_000
export const DEX_ACQUISITION_MAX_RUN_PAGES = 250_000
export const DEX_ACQUISITION_MAX_RUN_REQUEST_ATTEMPTS = 500_000
export const DEX_ACQUISITION_MAX_RUN_RAW_CANDIDATES = 100_000
export const DEX_ACQUISITION_MAX_RUN_WIRE_BYTES = 320 * 1024 * 1024 * 1024
export const DEX_ACQUISITION_MAX_RUN_DECODED_BYTES = 1024 * 1024 * 1024 * 1024
export const DEX_ACQUISITION_MAX_IN_FLIGHT_DECODED_BYTES = 512 * 1024 * 1024
export const DEX_ACQUISITION_MAX_RUN_DURATION_MS = 72 * 60 * 60 * 1000
export const DEX_ACQUISITION_MAX_RUN_BILLED_USD = 100

export const DEX_ACQUISITION_QUERY_TEMPLATE_CONTRACT_BY_MODE = {
  bsc_provider_address_index: 'arena.dex.bsc-address-index-query@1',
  solana_rpc_signatures_for_address: 'arena.dex.solana-signatures-query@1',
  sqd_finalized_stream_wallet_locator: 'arena.dex.sqd-finalized-wallet-locator-query@1',
  manifest_protocol_event_rpc_scan: 'arena.dex.protocol-event-rpc-query@1',
  manifest_protocol_event_sqd_finalized_stream: 'arena.dex.protocol-event-sqd-finalized-query@1',
} as const

const SHA256 = /^[0-9a-f]{64}$/
const FULL_GIT_SHA = /^[0-9a-f]{40}$/
const LOGICAL_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const NODE_VERSION = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const NON_NEGATIVE_CANONICAL_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/
const SECRET_MARKER =
  /(?:^|[._:-])(?:(?:sk|pk)[._:-](?:live|test)|api[._:-]?key|token|secret|password|passwd|private[._:-]?key|authorization|bearer)(?:[._:-]|$)/
const OPAQUE_ALIAS_SEGMENT = /(?:^|[._:-])[a-z0-9]{32,}(?=$|[._:-])/
const UUID_ALIAS =
  /(?:^|[._:-])[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:[._:-]|$)/

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
const logicalIdSchema = z
  .string()
  .regex(LOGICAL_ID)
  .refine(
    (value) =>
      !SECRET_MARKER.test(value) && !OPAQUE_ALIAS_SEGMENT.test(value) && !UUID_ALIAS.test(value),
    'logical ID contains a forbidden credential-like or opaque segment'
  )
const gitShaSchema = z
  .string()
  .regex(FULL_GIT_SHA)
  .refine((value) => !/^0{40}$/.test(value), 'git SHA must be nonzero')
const nodeVersionSchema = z.string().regex(NODE_VERSION)
const semverSchema = z.string().regex(SEMVER)
const maxBilledUsdSchema = z
  .string()
  .max(32)
  .regex(NON_NEGATIVE_CANONICAL_DECIMAL)
  .refine((value) => {
    const [whole, fraction] = value.split('.')
    const wholeUsd = BigInt(whole)
    const maximumUsd = BigInt(DEX_ACQUISITION_MAX_RUN_BILLED_USD)
    return wholeUsd < maximumUsd || (wholeUsd === maximumUsd && fraction === undefined)
  }, `run billed USD cap cannot exceed ${DEX_ACQUISITION_MAX_RUN_BILLED_USD}`)
const safeNonNegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .refine((value) => Number.isSafeInteger(value) && !Object.is(value, -0), {
    message: 'integer must be safe and must not be negative zero',
  })
const safePositiveIntegerSchema = safeNonNegativeIntegerSchema.positive()

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

const transportKindSchema = z.enum([
  'evm_json_rpc',
  'solana_json_rpc',
  'evm_provider_address_index',
  'sqd_portal_evm_finalized_stream',
  'sqd_portal_solana_finalized_stream',
])

const connectionDescriptorSchema = z
  .object({
    data_contract: z.literal(DEX_ACQUISITION_CONNECTION_DESCRIPTOR_CONTRACT),
    provider_id: logicalIdSchema,
    data_source_id: logicalIdSchema,
    endpoint_id: logicalIdSchema,
    source_independence_group: logicalIdSchema,
    transport_kind: transportKindSchema,
    auth_mode: z.enum(['none', 'api_key', 'bearer', 'signed']),
    rate_plan_id: logicalIdSchema,
    pricing_plan_id: logicalIdSchema,
  })
  .strict()

const endpointProfileCoreSchema = connectionDescriptorSchema
  .omit({ data_contract: true })
  .extend({
    data_contract: z.literal(DEX_ACQUISITION_ENDPOINT_PROFILE_CONTRACT),
    profile_id: logicalIdSchema,
    connection_descriptor_sha256: sha256Schema,
  })
  .strict()

export const dexAcquisitionEndpointProfileStructuralSchema = endpointProfileCoreSchema
  .extend({ endpoint_identity_sha256: sha256Schema })
  .strict()

export const dexAcquisitionEndpointBindingsStructuralSchema = z
  .object({
    registry_contract: z.literal(DEX_ACQUISITION_ENDPOINT_REGISTRY_CONTRACT),
    registry_sha256: sha256Schema,
    profiles: z.array(dexAcquisitionEndpointProfileStructuralSchema).min(1).max(5),
    phases: z
      .object({
        boundary_resolution: logicalIdSchema,
        block_catalog: logicalIdSchema,
        discovery: logicalIdSchema,
        transaction_evidence: logicalIdSchema,
        finality_anchor: logicalIdSchema,
        gap_evidence: logicalIdSchema.nullable(),
      })
      .strict(),
    redirect_policy: z.literal('error'),
    retry_endpoint_policy: z.literal('same_profile_only'),
    provider_failover_policy: z.literal('new_manifest_required'),
  })
  .strict()

export const dexAcquisitionObservedEndpointBindingsStructuralSchema =
  dexAcquisitionEndpointBindingsStructuralSchema
    .extend({ provider_failover_observed: z.literal(false) })
    .strict()

const acquisitionModeSchema = z.enum([
  'bsc_provider_address_index',
  'solana_rpc_signatures_for_address',
  'sqd_finalized_stream_wallet_locator',
  'manifest_protocol_event_rpc_scan',
  'manifest_protocol_event_sqd_finalized_stream',
])

export const dexAcquisitionSourceStructuralSchema = z
  .object({
    acquisition_mode: acquisitionModeSchema,
    query_shape: z.enum([
      'one_query_per_wallet',
      'batched_wallet_locator',
      'protocol_wide_local_match',
    ]),
    completeness_scope: z.enum([
      'provider_address_index_query',
      'rpc_address_signature_query',
      'provider_dataset_wallet_locator_query',
      'manifest_protocol_events_in_height_range',
    ]),
    finality_claim: z.enum([
      'strict_rpc_membership_bound',
      'provider_index_with_strict_rpc_membership',
      'provider_finalized_stream_assertion',
    ]),
    declared_source_role: z.enum([
      'primary_shadow',
      'same_provider_control',
      'declared_differential',
    ]),
    independence_claim: z.literal('not_asserted'),
    endpoint_binding_scope: z.literal('exact_profile_per_phase_and_lane'),
    mixed_provider_pages: z.literal(false),
  })
  .strict()

const endpointBindingContextSchema = z
  .object({
    chain: z.union([bscChainSchema, solanaChainSchema]),
    source: dexAcquisitionSourceStructuralSchema,
    endpoint_bindings: z.union([
      dexAcquisitionEndpointBindingsStructuralSchema,
      dexAcquisitionObservedEndpointBindingsStructuralSchema,
    ]),
  })
  .strict()

const sampleScopeSchema = z
  .object({
    kind: z.literal('golden_wallet_technical_sample'),
    upstream_filter: z.literal('exact_golden_50_subset'),
    evaluation: z.literal('direct_wallet_locator'),
    population_denominator_eligible: z.literal(false),
    population_recall_measured: z.literal(false),
  })
  .strict()
const protocolScopeSchema = z
  .object({
    kind: z.literal('protocol_manifest_event_scan'),
    upstream_filter: z.literal('all_manifest_deployments_and_events'),
    evaluation: z.literal('local_golden_50_match'),
    population_denominator_eligible: z.literal(false),
    population_recall_measured: z.literal(false),
  })
  .strict()

const phaseBudgetSchema = z
  .object({
    max_request_attempts: safeNonNegativeIntegerSchema.max(
      DEX_ACQUISITION_MAX_RUN_REQUEST_ATTEMPTS
    ),
    max_wire_bytes: safeNonNegativeIntegerSchema.max(DEX_ACQUISITION_MAX_RUN_WIRE_BYTES),
    max_decoded_bytes: safeNonNegativeIntegerSchema.max(DEX_ACQUISITION_MAX_RUN_DECODED_BYTES),
  })
  .strict()

const queryPolicySchema = z
  .object({
    schema_version: z.literal(DEX_ACQUISITION_QUERY_POLICY_SCHEMA_VERSION),
    data_contract: z.literal(DEX_ACQUISITION_QUERY_POLICY_CONTRACT),
    acquisition_mode: acquisitionModeSchema,
    query_shape: dexAcquisitionSourceStructuralSchema.shape.query_shape,
    completeness_scope: dexAcquisitionSourceStructuralSchema.shape.completeness_scope,
    finality_claim: dexAcquisitionSourceStructuralSchema.shape.finality_claim,
    adapter_id: z.enum([
      'bsc_provider_address_index_v1',
      'solana_get_signatures_for_address_v1',
      'sqd_finalized_stream_wallet_locator_v1',
      'manifest_protocol_event_rpc_scan_v1',
      'manifest_protocol_event_sqd_finalized_stream_v1',
    ]),
    adapter_implementation_git_sha: gitShaSchema,
    adapter_toolchain: z
      .object({
        contract: z.literal(DEX_ACQUISITION_ADAPTER_TOOLCHAIN_CONTRACT),
        sha256: sha256Schema,
      })
      .strict(),
    query_template_contract: z.enum([
      'arena.dex.bsc-address-index-query@1',
      'arena.dex.solana-signatures-query@1',
      'arena.dex.sqd-finalized-wallet-locator-query@1',
      'arena.dex.protocol-event-rpc-query@1',
      'arena.dex.protocol-event-sqd-finalized-query@1',
    ]),
    query_template_sha256: sha256Schema,
    scope: z.union([sampleScopeSchema, protocolScopeSchema]),
    lane_topology: z.union([
      z
        .object({
          kind: z.literal('one_per_golden_wallet'),
          lane_count: z.literal(50),
        })
        .strict(),
      z
        .object({
          kind: z.literal('single_batched_golden_locator'),
          lane_count: z.literal(1),
        })
        .strict(),
      z
        .object({
          kind: z.literal('single_protocol_manifest_stream'),
          lane_count: z.literal(1),
        })
        .strict(),
    ]),
    budgets: z
      .object({
        max_pages_per_lane: safePositiveIntegerSchema.max(DEX_ACQUISITION_MAX_RUN_PAGES),
        max_raw_candidates_per_lane: safePositiveIntegerSchema.max(
          DEX_ACQUISITION_MAX_RUN_RAW_CANDIDATES
        ),
        request_timeout_ms: safePositiveIntegerSchema.max(120_000),
        max_response_wire_bytes_per_page: safePositiveIntegerSchema.max(64 * 1024 * 1024),
        max_response_decoded_bytes_per_page: safePositiveIntegerSchema.max(256 * 1024 * 1024),
        max_json_depth: safePositiveIntegerSchema.max(128),
        concurrency: safePositiveIntegerSchema.max(10),
        max_attempts_per_request: safePositiveIntegerSchema.max(5),
        max_run_duration_ms: safePositiveIntegerSchema.max(DEX_ACQUISITION_MAX_RUN_DURATION_MS),
        phases: z
          .object({
            boundary_resolution: phaseBudgetSchema,
            block_catalog: phaseBudgetSchema,
            discovery: phaseBudgetSchema,
            transaction_evidence: phaseBudgetSchema,
            finality_anchor: phaseBudgetSchema,
            gap_evidence: phaseBudgetSchema,
          })
          .strict(),
        billing: z
          .object({
            currency: z.literal('USD'),
            max_billed_usd: maxBilledUsdSchema,
          })
          .strict(),
      })
      .strict(),
    cursor: z
      .object({
        binding: z.literal('manifest_subset_lane_window_query_endpoint_anchor'),
        storage: z.literal('domain_separated_commitment_only'),
        repeat_policy: z.literal('fail_stalled'),
        cross_lane_reuse: z.literal('reject'),
        cross_run_reuse: z.literal('reject'),
      })
      .strict(),
    transport: z
      .object({
        strict_utf8: z.literal(true),
        strict_json_duplicate_keys: z.literal('reject'),
        redirect_policy: z.literal('error'),
        raw_page_archive_required: z.literal(true),
        fixed_height_and_utc_window: z.literal(true),
        include_failed_transactions: z.literal(true),
        malformed_response_policy: z.literal('fail_lane'),
        provider_failover_policy: z.literal('new_manifest_required'),
        retry_after_policy: z.literal('respect_bounded'),
      })
      .strict(),
    candidate_evidence: z
      .object({
        verification_method: z.enum([
          'bsc_strict_rpc_receipt_status_block_membership',
          'solana_strict_rpc_signature_status_block_membership',
        ]),
        transaction_membership_policy: z.enum([
          'bsc_transaction_membership_v1',
          'solana_transaction_membership_v1',
        ]),
        rpc_request_upper_bound_per_candidate: z.union([z.literal(3), z.literal(4)]),
        max_response_wire_bytes_per_rpc: safePositiveIntegerSchema.max(2 * 1024 * 1024),
        max_response_decoded_bytes_per_rpc: safePositiveIntegerSchema.max(8 * 1024 * 1024),
        unavailable_policy: z.literal('keep_partial'),
        rejected_policy: z.literal('fail_closed'),
      })
      .strict(),
  })
  .strict()

const bscWindowSchema = z
  .object({
    timeframe_days: z.literal(7),
    semantics: z.literal('completed_utc_days_half_open'),
    start_at: utcMidnightSchema,
    end_at: utcMidnightSchema,
    duration_seconds: z.literal(DEX_ACQUISITION_RUN_WINDOW_SECONDS),
    declared_resolution_state: z.literal('fully_resolved'),
    boundary_policy: z.literal('bsc_first_produced_block_at_or_after_utc_v1'),
    finality_anchor_policy: z.literal('bsc_verified_anchor_semantics_v1'),
    height_range: z
      .object({
        start_inclusive: safeNonNegativeIntegerSchema,
        end_exclusive: safePositiveIntegerSchema,
        start_boundary_time: canonicalTimestampSchema,
        end_boundary_time: canonicalTimestampSchema,
        start_boundary_evidence_sha256: sha256Schema,
        end_boundary_evidence_sha256: sha256Schema,
        boundary_resolution_evidence_sha256: sha256Schema,
        boundary_resolution_observed_at: canonicalTimestampSchema,
        finality_anchor_height: safeNonNegativeIntegerSchema,
        finality_anchor_semantic_sha256: sha256Schema,
        finality_anchor_observed_at: canonicalTimestampSchema,
      })
      .strict(),
  })
  .strict()

const solanaWindowSchema = z
  .object({
    timeframe_days: z.literal(7),
    semantics: z.literal('completed_utc_days_half_open'),
    start_at: utcMidnightSchema,
    end_at: utcMidnightSchema,
    duration_seconds: z.literal(DEX_ACQUISITION_RUN_WINDOW_SECONDS),
    declared_resolution_state: z.literal('fully_resolved'),
    boundary_policy: z.literal('solana_first_produced_slot_at_or_after_utc_v1'),
    finality_anchor_policy: z.literal('solana_verified_anchor_semantics_v2'),
    height_range: bscWindowSchema.shape.height_range,
  })
  .strict()

const protocolManifestSchema = z.union([
  z.object({ state: z.literal('not_applicable') }).strict(),
  z
    .object({
      state: z.literal('bound'),
      contract_id: z.enum([
        'arena.dex.bsc-protocol-manifest@1',
        'arena.dex.solana-protocol-manifest@1',
      ]),
      sha256: sha256Schema,
    })
    .strict(),
])

const claimsSchema = z
  .object({
    golden_fixture_verified: z.literal(false),
    endpoint_registry_verified: z.literal(false),
    boundary_evidence_verified: z.literal(false),
    query_template_verified: z.literal(false),
    adapter_toolchain_verified: z.literal(false),
    protocol_manifest_verified: z.literal(false),
    runtime_revision_verified: z.literal(false),
    execution_authorized: z.literal(false),
    artifact_persistence_authorized: z.literal(false),
    transcript_reference_eligible: z.literal(false),
    source_independence_verified: z.literal(false),
    population_denominator_eligible: z.literal(false),
    population_recall_measured: z.literal(false),
  })
  .strict()

const runManifestSchema = z
  .object({
    schema_version: z.literal(DEX_ACQUISITION_RUN_MANIFEST_SCHEMA_VERSION),
    data_contract: z.literal(DEX_ACQUISITION_RUN_MANIFEST_CONTRACT),
    purpose: z.literal('phase0_7d_technical_bakeoff_only'),
    mode: z.literal('shadow_only'),
    resolved_at: canonicalTimestampSchema,
    runner_git_sha: gitShaSchema,
    runtime: z
      .object({
        node_version: nodeVersionSchema,
        package_manager: z.literal('npm'),
        package_manager_version: semverSchema,
        lockfile_contract: z.literal('npm-package-lock@3'),
        lockfile_sha256: sha256Schema,
      })
      .strict(),
    chain: z.union([bscChainSchema, solanaChainSchema]),
    golden_sample: goldenSampleSchema,
    window: z.union([bscWindowSchema, solanaWindowSchema]),
    source: dexAcquisitionSourceStructuralSchema,
    endpoint_bindings: dexAcquisitionEndpointBindingsStructuralSchema,
    query_policy: queryPolicySchema,
    query_policy_sha256: sha256Schema,
    protocol_manifest: protocolManifestSchema,
    claims: claimsSchema,
    serving_authorized: z.literal(false),
    rank_eligible: z.literal(false),
    score_eligible: z.literal(false),
  })
  .strict()

export type DexAcquisitionConnectionDescriptor = z.infer<typeof connectionDescriptorSchema>
export type DexAcquisitionEndpointProfileCore = z.infer<typeof endpointProfileCoreSchema>
export type DexAcquisitionEndpointProfile = z.infer<
  typeof dexAcquisitionEndpointProfileStructuralSchema
>
export type DexAcquisitionEndpointBindings = z.infer<
  typeof dexAcquisitionEndpointBindingsStructuralSchema
>
export type DexAcquisitionSource = z.infer<typeof dexAcquisitionSourceStructuralSchema>
export type DexAcquisitionQueryPolicy = z.infer<typeof queryPolicySchema>
export type DexAcquisitionRunManifest = z.infer<typeof runManifestSchema>
export type DexAcquisitionEndpointBindingContext = z.infer<typeof endpointBindingContextSchema>

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

export function dexAcquisitionEndpointProfileSha256(input: unknown): string {
  const profile = endpointProfileCoreSchema.parse(input)
  const descriptor = connectionDescriptorFromProfile(profile)
  if (
    profile.connection_descriptor_sha256 !== dexAcquisitionConnectionDescriptorSha256(descriptor)
  ) {
    throw new Error('connection descriptor SHA does not match endpoint profile')
  }
  return dexContractSha256(
    {
      domain: 'arena.dex.acquisition-endpoint-profile',
      schema_id: DEX_ACQUISITION_ENDPOINT_PROFILE_CONTRACT,
      schema_version: 1,
    },
    profile
  )
}

export function dexAcquisitionConnectionDescriptorSha256(input: unknown): string {
  const descriptor = connectionDescriptorSchema.parse(input)
  return dexContractSha256(
    {
      domain: 'arena.dex.acquisition-connection-descriptor',
      schema_id: DEX_ACQUISITION_CONNECTION_DESCRIPTOR_CONTRACT,
      schema_version: 1,
    },
    descriptor
  )
}

function connectionDescriptorFromProfile(
  profile: DexAcquisitionEndpointProfileCore | DexAcquisitionEndpointProfile
): DexAcquisitionConnectionDescriptor {
  return {
    data_contract: DEX_ACQUISITION_CONNECTION_DESCRIPTOR_CONTRACT,
    provider_id: profile.provider_id,
    data_source_id: profile.data_source_id,
    endpoint_id: profile.endpoint_id,
    source_independence_group: profile.source_independence_group,
    transport_kind: profile.transport_kind,
    auth_mode: profile.auth_mode,
    rate_plan_id: profile.rate_plan_id,
    pricing_plan_id: profile.pricing_plan_id,
  }
}

export function dexAcquisitionQueryPolicySha256(input: unknown): string {
  const policy = queryPolicySchema.parse(input)
  assertQueryPolicyInvariants(policy)
  return dexContractSha256(
    {
      domain: 'arena.dex.acquisition-query-policy',
      schema_id: DEX_ACQUISITION_QUERY_POLICY_CONTRACT,
      schema_version: DEX_ACQUISITION_QUERY_POLICY_SCHEMA_VERSION,
    },
    policy
  )
}

function expectedSourceContract(mode: DexAcquisitionQueryPolicy['acquisition_mode']): {
  adapter: DexAcquisitionQueryPolicy['adapter_id']
  queryShape: DexAcquisitionQueryPolicy['query_shape']
  completenessScope: DexAcquisitionQueryPolicy['completeness_scope']
  finalityClaim: DexAcquisitionQueryPolicy['finality_claim']
  laneKind: DexAcquisitionQueryPolicy['lane_topology']['kind']
  scopeKind: DexAcquisitionQueryPolicy['scope']['kind']
  queryTemplate: DexAcquisitionQueryPolicy['query_template_contract']
} {
  if (mode === 'bsc_provider_address_index') {
    return {
      adapter: 'bsc_provider_address_index_v1',
      queryShape: 'one_query_per_wallet',
      completenessScope: 'provider_address_index_query',
      finalityClaim: 'provider_index_with_strict_rpc_membership',
      laneKind: 'one_per_golden_wallet',
      scopeKind: 'golden_wallet_technical_sample',
      queryTemplate: DEX_ACQUISITION_QUERY_TEMPLATE_CONTRACT_BY_MODE[mode],
    }
  }
  if (mode === 'solana_rpc_signatures_for_address') {
    return {
      adapter: 'solana_get_signatures_for_address_v1',
      queryShape: 'one_query_per_wallet',
      completenessScope: 'rpc_address_signature_query',
      finalityClaim: 'strict_rpc_membership_bound',
      laneKind: 'one_per_golden_wallet',
      scopeKind: 'golden_wallet_technical_sample',
      queryTemplate: DEX_ACQUISITION_QUERY_TEMPLATE_CONTRACT_BY_MODE[mode],
    }
  }
  if (mode === 'sqd_finalized_stream_wallet_locator') {
    return {
      adapter: 'sqd_finalized_stream_wallet_locator_v1',
      queryShape: 'batched_wallet_locator',
      completenessScope: 'provider_dataset_wallet_locator_query',
      finalityClaim: 'provider_finalized_stream_assertion',
      laneKind: 'single_batched_golden_locator',
      scopeKind: 'golden_wallet_technical_sample',
      queryTemplate: DEX_ACQUISITION_QUERY_TEMPLATE_CONTRACT_BY_MODE[mode],
    }
  }
  if (mode === 'manifest_protocol_event_rpc_scan') {
    return {
      adapter: 'manifest_protocol_event_rpc_scan_v1',
      queryShape: 'protocol_wide_local_match',
      completenessScope: 'manifest_protocol_events_in_height_range',
      finalityClaim: 'strict_rpc_membership_bound',
      laneKind: 'single_protocol_manifest_stream',
      scopeKind: 'protocol_manifest_event_scan',
      queryTemplate: DEX_ACQUISITION_QUERY_TEMPLATE_CONTRACT_BY_MODE[mode],
    }
  }
  return {
    adapter: 'manifest_protocol_event_sqd_finalized_stream_v1',
    queryShape: 'protocol_wide_local_match',
    completenessScope: 'manifest_protocol_events_in_height_range',
    finalityClaim: 'provider_finalized_stream_assertion',
    laneKind: 'single_protocol_manifest_stream',
    scopeKind: 'protocol_manifest_event_scan',
    queryTemplate: DEX_ACQUISITION_QUERY_TEMPLATE_CONTRACT_BY_MODE[mode],
  }
}

function assertQueryPolicyInvariants(policy: DexAcquisitionQueryPolicy): void {
  const expected = expectedSourceContract(policy.acquisition_mode)
  if (
    policy.adapter_id !== expected.adapter ||
    policy.query_shape !== expected.queryShape ||
    policy.completeness_scope !== expected.completenessScope ||
    policy.finality_claim !== expected.finalityClaim ||
    policy.lane_topology.kind !== expected.laneKind ||
    policy.scope.kind !== expected.scopeKind ||
    policy.query_template_contract !== expected.queryTemplate
  ) {
    throw new Error('query policy conflicts with its acquisition mode')
  }
  if (
    (policy.lane_topology.kind === 'one_per_golden_wallet' &&
      policy.lane_topology.lane_count !== 50) ||
    (policy.lane_topology.kind !== 'one_per_golden_wallet' && policy.lane_topology.lane_count !== 1)
  ) {
    throw new Error('query policy lane count conflicts with its topology')
  }

  const lanes = BigInt(policy.lane_topology.lane_count)
  const pages = BigInt(policy.budgets.max_pages_per_lane) * lanes
  const discoveryAttempts = pages * BigInt(policy.budgets.max_attempts_per_request)
  const candidates = BigInt(policy.budgets.max_raw_candidates_per_lane) * lanes
  const candidateAttempts =
    candidates *
    BigInt(policy.candidate_evidence.rpc_request_upper_bound_per_candidate) *
    BigInt(policy.budgets.max_attempts_per_request)
  const candidateWireBytes =
    candidateAttempts * BigInt(policy.candidate_evidence.max_response_wire_bytes_per_rpc)
  const candidateDecodedBytes =
    candidateAttempts * BigInt(policy.candidate_evidence.max_response_decoded_bytes_per_rpc)
  const discoveryWireBytes =
    discoveryAttempts * BigInt(policy.budgets.max_response_wire_bytes_per_page)
  const discoveryDecodedBytes =
    discoveryAttempts * BigInt(policy.budgets.max_response_decoded_bytes_per_page)
  const inFlightDecodedBytes =
    BigInt(policy.budgets.concurrency) * BigInt(policy.budgets.max_response_decoded_bytes_per_page)
  if (pages > BigInt(DEX_ACQUISITION_MAX_RUN_PAGES)) {
    throw new Error('query policy aggregate page budget exceeds the hard run limit')
  }
  if (candidates > BigInt(DEX_ACQUISITION_MAX_RUN_RAW_CANDIDATES)) {
    throw new Error('query policy aggregate raw-candidate budget exceeds the hard run limit')
  }
  const phaseBudgets = Object.values(policy.budgets.phases)
  for (const phase of phaseBudgets) {
    const allZero =
      phase.max_request_attempts === 0 &&
      phase.max_wire_bytes === 0 &&
      phase.max_decoded_bytes === 0
    const allPositive =
      phase.max_request_attempts > 0 && phase.max_wire_bytes > 0 && phase.max_decoded_bytes > 0
    if (!allZero && !allPositive) {
      throw new Error('query phase request and byte budgets must be jointly zero or positive')
    }
  }
  for (const phase of [
    policy.budgets.phases.boundary_resolution,
    policy.budgets.phases.block_catalog,
    policy.budgets.phases.discovery,
    policy.budgets.phases.transaction_evidence,
    policy.budgets.phases.finality_anchor,
  ]) {
    if (phase.max_request_attempts === 0) {
      throw new Error('required query phases must have a positive request budget')
    }
  }
  const phaseRequestAttempts = phaseBudgets.reduce(
    (total, phase) => total + BigInt(phase.max_request_attempts),
    0n
  )
  const phaseWireBytes = phaseBudgets.reduce(
    (total, phase) => total + BigInt(phase.max_wire_bytes),
    0n
  )
  const phaseDecodedBytes = phaseBudgets.reduce(
    (total, phase) => total + BigInt(phase.max_decoded_bytes),
    0n
  )
  const expectedCandidateFanout =
    policy.candidate_evidence.verification_method ===
    'bsc_strict_rpc_receipt_status_block_membership'
      ? 4
      : 3
  if (policy.candidate_evidence.rpc_request_upper_bound_per_candidate !== expectedCandidateFanout) {
    throw new Error('candidate evidence RPC fan-out conflicts with its verification method')
  }
  if (
    discoveryAttempts > BigInt(policy.budgets.phases.discovery.max_request_attempts) ||
    discoveryWireBytes > BigInt(policy.budgets.phases.discovery.max_wire_bytes) ||
    discoveryDecodedBytes > BigInt(policy.budgets.phases.discovery.max_decoded_bytes)
  ) {
    throw new Error('discovery phase budget cannot cover its per-lane worst case')
  }
  if (
    candidateAttempts > BigInt(policy.budgets.phases.transaction_evidence.max_request_attempts) ||
    candidateWireBytes > BigInt(policy.budgets.phases.transaction_evidence.max_wire_bytes) ||
    candidateDecodedBytes > BigInt(policy.budgets.phases.transaction_evidence.max_decoded_bytes)
  ) {
    throw new Error('transaction-evidence budget cannot cover the raw-candidate worst case')
  }
  if (
    phaseRequestAttempts > BigInt(DEX_ACQUISITION_MAX_RUN_REQUEST_ATTEMPTS) ||
    phaseWireBytes > BigInt(DEX_ACQUISITION_MAX_RUN_WIRE_BYTES) ||
    phaseDecodedBytes > BigInt(DEX_ACQUISITION_MAX_RUN_DECODED_BYTES) ||
    inFlightDecodedBytes > BigInt(DEX_ACQUISITION_MAX_IN_FLIGHT_DECODED_BYTES)
  ) {
    throw new Error('query policy aggregate run budget exceeds a hard safety limit')
  }
}

function assertWindow(manifest: DexAcquisitionRunManifest): void {
  const { window } = manifest
  const resolvedAt = Date.parse(manifest.resolved_at)
  const elapsedMs = Date.parse(window.end_at) - Date.parse(window.start_at)
  if (elapsedMs !== DEX_ACQUISITION_RUN_WINDOW_SECONDS * 1000) {
    throw new Error('run manifest window must be exactly seven completed UTC days')
  }
  if (resolvedAt < Date.parse(window.end_at)) {
    throw new Error('run manifest cannot resolve before its completed window ends')
  }
  const range = window.height_range
  if (range.end_exclusive <= range.start_inclusive) {
    throw new Error('resolved run height range must be non-empty and half-open')
  }
  if (range.finality_anchor_height < range.end_exclusive) {
    throw new Error('finality anchor must cover the end-exclusive sentinel')
  }
  const startAt = Date.parse(window.start_at)
  const endAt = Date.parse(window.end_at)
  const startBoundary = Date.parse(range.start_boundary_time)
  const endBoundary = Date.parse(range.end_boundary_time)
  const boundaryObservedAt = Date.parse(range.boundary_resolution_observed_at)
  const finalityObservedAt = Date.parse(range.finality_anchor_observed_at)
  if (startBoundary < startAt || startBoundary >= endAt) {
    throw new Error('start boundary time must fall inside the requested UTC window')
  }
  if (endBoundary < endAt) {
    throw new Error('end boundary sentinel cannot precede the end-exclusive UTC boundary')
  }
  if (boundaryObservedAt < endAt || finalityObservedAt < endAt) {
    throw new Error('boundary and finality evidence cannot be observed before the window ends')
  }
  if (boundaryObservedAt > resolvedAt || finalityObservedAt > resolvedAt) {
    throw new Error('run manifest cannot resolve before its evidence was observed')
  }
  if (
    endBoundary > boundaryObservedAt + DEX_ACQUISITION_MAX_CHAIN_CLOCK_SKEW_MS ||
    endBoundary > finalityObservedAt + DEX_ACQUISITION_MAX_CHAIN_CLOCK_SKEW_MS
  ) {
    throw new Error('end boundary sentinel exceeds the allowed chain clock skew')
  }
}

function assertGoldenSample(
  manifest: DexAcquisitionRunManifest,
  parentSnapshot: DexGoldenWalletSnapshot
): void {
  const parentSha256 = dexGoldenWalletSnapshotSha256(parentSnapshot)
  const { subset, sha256: subsetSha256 } = buildDexGoldenWalletChainSubset(
    parentSnapshot,
    manifest.golden_sample.source_slug
  )
  if (manifest.golden_sample.parent_snapshot_sha256 !== parentSha256) {
    throw new Error('run manifest parent snapshot SHA does not match the supplied fixture')
  }
  if (manifest.golden_sample.subset_sha256 !== subsetSha256) {
    throw new Error('run manifest subset SHA does not match the supplied fixture')
  }
  if (
    manifest.chain.namespace !== subset.chain.namespace ||
    manifest.chain.reference !== subset.chain.reference
  ) {
    throw new Error('run manifest chain conflicts with its golden-wallet subset')
  }
}

function chainRpcTransport(
  manifest: DexAcquisitionEndpointBindingContext
): DexAcquisitionEndpointProfile['transport_kind'] {
  return manifest.chain.namespace === 'eip155' ? 'evm_json_rpc' : 'solana_json_rpc'
}

function chainSqdTransport(
  manifest: DexAcquisitionEndpointBindingContext
): DexAcquisitionEndpointProfile['transport_kind'] {
  return manifest.chain.namespace === 'eip155'
    ? 'sqd_portal_evm_finalized_stream'
    : 'sqd_portal_solana_finalized_stream'
}

function discoveryTransport(
  manifest: DexAcquisitionEndpointBindingContext
): DexAcquisitionEndpointProfile['transport_kind'] {
  const mode = manifest.source.acquisition_mode
  if (mode === 'bsc_provider_address_index') return 'evm_provider_address_index'
  if (mode === 'solana_rpc_signatures_for_address') return 'solana_json_rpc'
  if (
    mode === 'sqd_finalized_stream_wallet_locator' ||
    mode === 'manifest_protocol_event_sqd_finalized_stream'
  ) {
    return chainSqdTransport(manifest)
  }
  return chainRpcTransport(manifest)
}

function assertEndpointBindingInvariants(manifest: DexAcquisitionEndpointBindingContext): void {
  const bindings = manifest.endpoint_bindings
  const profileIds = bindings.profiles.map((profile) => profile.profile_id)
  if (new Set(profileIds).size !== profileIds.length) {
    throw new Error('run manifest endpoint profile IDs must be unique')
  }
  const sortedIds = [...profileIds].sort()
  if (sortedIds.some((profileId, index) => profileId !== profileIds[index])) {
    throw new Error('run manifest endpoint profiles must use canonical profile-id order')
  }
  for (const [index, profile] of bindings.profiles.entries()) {
    const descriptorSha256 = dexAcquisitionConnectionDescriptorSha256(
      connectionDescriptorFromProfile(profile)
    )
    if (profile.connection_descriptor_sha256 !== descriptorSha256) {
      throw new Error(`connection descriptor SHA does not match endpoint profile at index ${index}`)
    }
    const { endpoint_identity_sha256: claimedSha256, ...core } = profile
    const expectedSha256 = dexAcquisitionEndpointProfileSha256(core)
    if (claimedSha256 !== expectedSha256) {
      throw new Error(`endpoint identity SHA does not match endpoint profile at index ${index}`)
    }
  }
  const connectionDescriptors = bindings.profiles.map(
    (profile) => profile.connection_descriptor_sha256
  )
  if (new Set(connectionDescriptors).size !== connectionDescriptors.length) {
    throw new Error('run manifest cannot alias one connection through multiple endpoint profiles')
  }
  const physicalEndpointAliases = bindings.profiles.map((profile) =>
    [profile.provider_id, profile.data_source_id, profile.endpoint_id].join('\u0000')
  )
  if (new Set(physicalEndpointAliases).size !== physicalEndpointAliases.length) {
    throw new Error('run manifest cannot relabel one physical endpoint as multiple profiles')
  }

  const referencedIds = Object.values(bindings.phases).filter(
    (profileId): profileId is string => profileId !== null
  )
  const profiles = new Set(profileIds)
  if (referencedIds.some((profileId) => !profiles.has(profileId))) {
    throw new Error('run manifest phase references an unknown endpoint profile')
  }
  if (new Set(referencedIds).size !== profiles.size) {
    throw new Error('run manifest endpoint profiles must all be referenced by a phase')
  }

  const byId = new Map(bindings.profiles.map((profile) => [profile.profile_id, profile]))
  const phaseProfile = (
    phase: Exclude<keyof typeof bindings.phases, 'gap_evidence'>
  ): DexAcquisitionEndpointProfile => byId.get(bindings.phases[phase])!
  const rpcTransport = chainRpcTransport(manifest)
  const sqdTransport = chainSqdTransport(manifest)
  const chainTransports = new Set<DexAcquisitionEndpointProfile['transport_kind']>([
    rpcTransport,
    sqdTransport,
    ...(manifest.chain.namespace === 'eip155' ? (['evm_provider_address_index'] as const) : []),
  ])
  if (bindings.profiles.some((profile) => !chainTransports.has(profile.transport_kind))) {
    throw new Error('endpoint profile transport conflicts with the run chain')
  }
  if (phaseProfile('discovery').transport_kind !== discoveryTransport(manifest)) {
    throw new Error('discovery endpoint transport conflicts with the acquisition mode')
  }
  if (
    ![rpcTransport, sqdTransport].includes(phaseProfile('boundary_resolution').transport_kind) ||
    ![rpcTransport, sqdTransport].includes(phaseProfile('block_catalog').transport_kind)
  ) {
    throw new Error('boundary and block-catalog phases require a chain data transport')
  }
  if (
    phaseProfile('transaction_evidence').transport_kind !== rpcTransport ||
    phaseProfile('finality_anchor').transport_kind !== rpcTransport
  ) {
    throw new Error('strict transaction and finality evidence require a chain RPC transport')
  }
  if (bindings.phases.finality_anchor !== bindings.phases.transaction_evidence) {
    throw new Error('transaction evidence must use the exact finality-anchor endpoint profile')
  }

  if (manifest.chain.namespace === 'eip155') {
    if (bindings.phases.gap_evidence !== null) {
      throw new Error('BSC run manifest cannot declare skipped-slot gap evidence')
    }
  } else {
    const gapProfileId = bindings.phases.gap_evidence
    if (gapProfileId === null) {
      throw new Error('Solana run manifest requires a separate gap-evidence endpoint profile')
    }
    const gapProfile = byId.get(gapProfileId)!
    const comparedProfiles = [phaseProfile('block_catalog'), phaseProfile('discovery')]
    if (gapProfile.transport_kind !== 'solana_json_rpc') {
      throw new Error('Solana gap evidence requires a Solana RPC transport')
    }
    if (
      comparedProfiles.some(
        (profile) =>
          profile.profile_id === gapProfile.profile_id ||
          profile.connection_descriptor_sha256 === gapProfile.connection_descriptor_sha256 ||
          profile.source_independence_group === gapProfile.source_independence_group
      )
    ) {
      throw new Error(
        'Solana gap evidence must be source-separated from block catalog and discovery'
      )
    }
  }
}

/**
 * Strictly parse and semantically validate the endpoint-binding projection
 * shared by resolved run manifests and acquisition transcripts. This validates
 * aliases and commitments, but does not verify the referenced registry artifact.
 */
export function parseDexAcquisitionEndpointBindingContext(
  input: unknown
): DexAcquisitionEndpointBindingContext {
  const context = endpointBindingContextSchema.parse(input)
  assertEndpointBindingInvariants(context)
  return context
}

function assertSourceAndPolicy(manifest: DexAcquisitionRunManifest): void {
  const source = manifest.source
  const policy = manifest.query_policy
  assertQueryPolicyInvariants(policy)
  if (
    source.acquisition_mode !== policy.acquisition_mode ||
    source.query_shape !== policy.query_shape ||
    source.completeness_scope !== policy.completeness_scope ||
    source.finality_claim !== policy.finality_claim
  ) {
    throw new Error('run manifest source conflicts with its query policy')
  }
  const policySha256 = dexAcquisitionQueryPolicySha256(policy)
  if (manifest.query_policy_sha256 !== policySha256) {
    throw new Error('run manifest query policy SHA does not match its embedded policy')
  }

  if (
    manifest.chain.namespace === 'eip155' &&
    policy.candidate_evidence.verification_method !==
      'bsc_strict_rpc_receipt_status_block_membership'
  ) {
    throw new Error('BSC run manifest requires BSC strict candidate evidence')
  }
  if (
    manifest.chain.namespace === 'solana' &&
    policy.candidate_evidence.verification_method !==
      'solana_strict_rpc_signature_status_block_membership'
  ) {
    throw new Error('Solana run manifest requires Solana strict candidate evidence')
  }
  const expectedMembershipPolicy =
    manifest.chain.namespace === 'eip155'
      ? 'bsc_transaction_membership_v1'
      : 'solana_transaction_membership_v1'
  if (policy.candidate_evidence.transaction_membership_policy !== expectedMembershipPolicy) {
    throw new Error('transaction membership policy conflicts with the run chain')
  }
  const gapBudget = policy.budgets.phases.gap_evidence
  if (
    manifest.chain.namespace === 'eip155' &&
    (gapBudget.max_request_attempts !== 0 ||
      gapBudget.max_wire_bytes !== 0 ||
      gapBudget.max_decoded_bytes !== 0)
  ) {
    throw new Error('BSC query policy cannot budget skipped-slot gap evidence')
  }
  if (manifest.chain.namespace === 'solana' && gapBudget.max_request_attempts === 0) {
    throw new Error('Solana query policy requires a positive gap-evidence budget')
  }

  const isProtocolMode =
    source.acquisition_mode === 'manifest_protocol_event_rpc_scan' ||
    source.acquisition_mode === 'manifest_protocol_event_sqd_finalized_stream'
  if (isProtocolMode !== (manifest.protocol_manifest.state === 'bound')) {
    throw new Error('protocol-event run must exclusively bind a protocol manifest')
  }
  if (manifest.protocol_manifest.state === 'bound') {
    const expectedContract =
      manifest.chain.namespace === 'eip155'
        ? 'arena.dex.bsc-protocol-manifest@1'
        : 'arena.dex.solana-protocol-manifest@1'
    if (manifest.protocol_manifest.contract_id !== expectedContract) {
      throw new Error('protocol manifest contract conflicts with the run chain')
    }
  }
}

function assertChainPolicies(manifest: DexAcquisitionRunManifest): void {
  if (manifest.chain.namespace === 'eip155') {
    if (
      manifest.window.boundary_policy !== 'bsc_first_produced_block_at_or_after_utc_v1' ||
      manifest.window.finality_anchor_policy !== 'bsc_verified_anchor_semantics_v1' ||
      manifest.golden_sample.source_slug !== 'binance_web3_bsc' ||
      manifest.source.acquisition_mode === 'solana_rpc_signatures_for_address'
    ) {
      throw new Error('BSC run manifest contains a foreign chain policy')
    }
  } else if (
    manifest.window.boundary_policy !== 'solana_first_produced_slot_at_or_after_utc_v1' ||
    manifest.window.finality_anchor_policy !== 'solana_verified_anchor_semantics_v2' ||
    manifest.golden_sample.source_slug !== 'okx_web3_solana' ||
    manifest.source.acquisition_mode === 'bsc_provider_address_index'
  ) {
    throw new Error('Solana run manifest contains a foreign chain policy')
  }
}

function nodeVersionAtLeast(value: string, minimum: readonly [number, number, number]): boolean {
  const actual = value.slice(1).split('.').map(Number) as [number, number, number]
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index]
  }
  return true
}

function assertRuntime(manifest: DexAcquisitionRunManifest): void {
  if (!nodeVersionAtLeast(manifest.runtime.node_version, [22, 0, 0])) {
    throw new Error('DEX acquisition runner requires Node.js 22 or newer')
  }
  const usesSqd =
    manifest.source.acquisition_mode === 'sqd_finalized_stream_wallet_locator' ||
    manifest.source.acquisition_mode === 'manifest_protocol_event_sqd_finalized_stream'
  if (usesSqd && !nodeVersionAtLeast(manifest.runtime.node_version, [22, 15, 0])) {
    throw new Error('SQD Pipes acquisition requires Node.js 22.15.0 or newer')
  }
  if (manifest.runtime.package_manager_version === '0.0.0') {
    throw new Error('package manager version must be nonzero')
  }
}

function assertDistinctEvidenceHashes(manifest: DexAcquisitionRunManifest): void {
  const protocolSha256 =
    manifest.protocol_manifest.state === 'bound' ? manifest.protocol_manifest.sha256 : null
  const hashes = [
    manifest.golden_sample.parent_snapshot_sha256,
    manifest.golden_sample.subset_sha256,
    manifest.runtime.lockfile_sha256,
    manifest.endpoint_bindings.registry_sha256,
    ...manifest.endpoint_bindings.profiles.map((profile) => profile.connection_descriptor_sha256),
    ...manifest.endpoint_bindings.profiles.map((profile) => profile.endpoint_identity_sha256),
    manifest.query_policy.adapter_toolchain.sha256,
    manifest.query_policy.query_template_sha256,
    manifest.query_policy_sha256,
    manifest.window.height_range.start_boundary_evidence_sha256,
    manifest.window.height_range.end_boundary_evidence_sha256,
    manifest.window.height_range.boundary_resolution_evidence_sha256,
    manifest.window.height_range.finality_anchor_semantic_sha256,
    protocolSha256,
  ].filter((value): value is string => value !== null)
  if (new Set(hashes).size !== hashes.length) {
    throw new Error('distinct run-manifest evidence domains must not reuse a SHA-256 digest')
  }
}

function assertRunManifestInvariants(
  manifest: DexAcquisitionRunManifest,
  parentSnapshot: DexGoldenWalletSnapshot
): void {
  assertWindow(manifest)
  assertGoldenSample(manifest, parentSnapshot)
  parseDexAcquisitionEndpointBindingContext({
    chain: manifest.chain,
    source: manifest.source,
    endpoint_bindings: manifest.endpoint_bindings,
  })
  assertSourceAndPolicy(manifest)
  assertChainPolicies(manifest)
  assertRuntime(manifest)
  assertDistinctEvidenceHashes(manifest)
}

/**
 * Parse a fully populated run manifest without authorizing execution. Every
 * externally referenced artifact remains explicitly unverified in `claims`;
 * registry aliases receive only structural/credential-pattern screening here;
 * this parser does not certify that arbitrary aliases are credential-free and
 * its result is not authorized for persistence. A later verifier must load the
 * exact trusted registry, templates, toolchain, boundary, anchor, and optional
 * protocol artifacts and return a non-serializable verified brand before a
 * manifest may be written or a collector may run.
 */
export function parseDexAcquisitionRunManifest(
  input: unknown,
  parentSnapshotInput: unknown
): DexAcquisitionRunManifest {
  const manifest = runManifestSchema.parse(input)
  const parentSnapshot = parseDexGoldenWalletSnapshot(parentSnapshotInput)
  assertRunManifestInvariants(manifest, parentSnapshot)
  return manifest
}

export function dexAcquisitionRunManifestSha256(
  input: unknown,
  parentSnapshotInput: unknown
): string {
  const manifest = parseDexAcquisitionRunManifest(input, parentSnapshotInput)
  return dexContractSha256(
    {
      domain: 'arena.dex.acquisition-run-manifest',
      schema_id: DEX_ACQUISITION_RUN_MANIFEST_CONTRACT,
      schema_version: DEX_ACQUISITION_RUN_MANIFEST_SCHEMA_VERSION,
    },
    manifest
  )
}
