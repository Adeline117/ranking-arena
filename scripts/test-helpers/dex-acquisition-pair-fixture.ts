import { createHash } from 'node:crypto'
import { deserialize, serialize } from 'node:v8'

import fixtureJson from '../fixtures/dex-golden-wallets.v1.json'
import {
  DEX_ACQUISITION_ADAPTER_TOOLCHAIN_CONTRACT,
  DEX_ACQUISITION_CONNECTION_DESCRIPTOR_CONTRACT,
  DEX_ACQUISITION_ENDPOINT_PROFILE_CONTRACT,
  DEX_ACQUISITION_ENDPOINT_REGISTRY_CONTRACT,
  DEX_ACQUISITION_QUERY_POLICY_CONTRACT,
  DEX_ACQUISITION_QUERY_POLICY_SCHEMA_VERSION,
  DEX_ACQUISITION_QUERY_TEMPLATE_CONTRACT_BY_MODE,
  DEX_ACQUISITION_RUN_MANIFEST_CONTRACT,
  DEX_ACQUISITION_RUN_MANIFEST_SCHEMA_VERSION,
  dexAcquisitionConnectionDescriptorSha256,
  dexAcquisitionEndpointProfileSha256,
  dexAcquisitionQueryPolicySha256,
  dexAcquisitionRunManifestSha256,
  type DexAcquisitionConnectionDescriptor,
  type DexAcquisitionEndpointProfile,
  type DexAcquisitionEndpointProfileCore,
  type DexAcquisitionQueryPolicy,
  type DexAcquisitionRunManifest,
} from '../lib/dex-acquisition-run-manifest'
import {
  DEX_ACQUISITION_TRANSCRIPT_CONTRACT,
  DEX_ACQUISITION_TRANSCRIPT_SCHEMA_VERSION,
  type DexAcquisitionTranscript,
} from '../lib/dex-acquisition-transcript'
import {
  buildDexGoldenWalletChainSubset,
  DEX_GOLDEN_WALLET_CONTRACT,
  DEX_GOLDEN_WALLET_SUBSET_CONTRACT,
  dexGoldenWalletSnapshotSha256,
  type DexGoldenSource,
} from '../lib/dex-golden-wallets'

export type DexPairVariant = 'direct' | 'sqd_wallet' | 'protocol_rpc' | 'protocol_sqd'

export type DexAcquisitionPairFixture = {
  manifest: DexAcquisitionRunManifest
  transcript: DexAcquisitionTranscript
}

type ModeConfig = Pick<
  DexAcquisitionQueryPolicy,
  | 'acquisition_mode'
  | 'query_shape'
  | 'completeness_scope'
  | 'finality_claim'
  | 'adapter_id'
  | 'query_template_contract'
  | 'scope'
  | 'lane_topology'
>

const PARENT_SHA256 = dexGoldenWalletSnapshotSha256(fixtureJson)

function digest(label: string): string {
  return createHash('sha256').update(`dex-pair-fixture:${label}`).digest('hex')
}

function clone<T>(value: T): T {
  return deserialize(serialize(value)) as T
}

export function makeDexPairParentFixture(): unknown {
  return clone(fixtureJson)
}

function endpointProfile(
  input: Omit<DexAcquisitionEndpointProfileCore, 'data_contract' | 'connection_descriptor_sha256'>
): DexAcquisitionEndpointProfile {
  const descriptor: DexAcquisitionConnectionDescriptor = {
    data_contract: DEX_ACQUISITION_CONNECTION_DESCRIPTOR_CONTRACT,
    provider_id: input.provider_id,
    data_source_id: input.data_source_id,
    endpoint_id: input.endpoint_id,
    source_independence_group: input.source_independence_group,
    transport_kind: input.transport_kind,
    auth_mode: input.auth_mode,
    rate_plan_id: input.rate_plan_id,
    pricing_plan_id: input.pricing_plan_id,
  }
  const core: DexAcquisitionEndpointProfileCore = {
    data_contract: DEX_ACQUISITION_ENDPOINT_PROFILE_CONTRACT,
    ...input,
    connection_descriptor_sha256: dexAcquisitionConnectionDescriptorSha256(descriptor),
  }
  return { ...core, endpoint_identity_sha256: dexAcquisitionEndpointProfileSha256(core) }
}

export function rehashDexPairEndpointProfile(profile: DexAcquisitionEndpointProfile): void {
  const descriptor: DexAcquisitionConnectionDescriptor = {
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
  profile.connection_descriptor_sha256 = dexAcquisitionConnectionDescriptorSha256(descriptor)
  const { endpoint_identity_sha256: _previousIdentity, ...core } = profile
  profile.endpoint_identity_sha256 = dexAcquisitionEndpointProfileSha256(core)
}

function modeConfig(source: DexGoldenSource, variant: DexPairVariant): ModeConfig {
  const isBsc = source === 'binance_web3_bsc'
  if (variant === 'direct') {
    const acquisitionMode = isBsc
      ? ('bsc_provider_address_index' as const)
      : ('solana_rpc_signatures_for_address' as const)
    return {
      acquisition_mode: acquisitionMode,
      query_shape: 'one_query_per_wallet',
      completeness_scope: isBsc ? 'provider_address_index_query' : 'rpc_address_signature_query',
      finality_claim: isBsc
        ? 'provider_index_with_strict_rpc_membership'
        : 'strict_rpc_membership_bound',
      adapter_id: isBsc ? 'bsc_provider_address_index_v1' : 'solana_get_signatures_for_address_v1',
      query_template_contract: DEX_ACQUISITION_QUERY_TEMPLATE_CONTRACT_BY_MODE[acquisitionMode],
      scope: {
        kind: 'golden_wallet_technical_sample',
        upstream_filter: 'exact_golden_50_subset',
        evaluation: 'direct_wallet_locator',
        population_denominator_eligible: false,
        population_recall_measured: false,
      },
      lane_topology: { kind: 'one_per_golden_wallet', lane_count: 50 },
    }
  }
  if (variant === 'sqd_wallet') {
    return {
      acquisition_mode: 'sqd_finalized_stream_wallet_locator',
      query_shape: 'batched_wallet_locator',
      completeness_scope: 'provider_dataset_wallet_locator_query',
      finality_claim: 'provider_finalized_stream_assertion',
      adapter_id: 'sqd_finalized_stream_wallet_locator_v1',
      query_template_contract:
        DEX_ACQUISITION_QUERY_TEMPLATE_CONTRACT_BY_MODE.sqd_finalized_stream_wallet_locator,
      scope: {
        kind: 'golden_wallet_technical_sample',
        upstream_filter: 'exact_golden_50_subset',
        evaluation: 'direct_wallet_locator',
        population_denominator_eligible: false,
        population_recall_measured: false,
      },
      lane_topology: { kind: 'single_batched_golden_locator', lane_count: 1 },
    }
  }
  const usesSqd = variant === 'protocol_sqd'
  const acquisitionMode = usesSqd
    ? ('manifest_protocol_event_sqd_finalized_stream' as const)
    : ('manifest_protocol_event_rpc_scan' as const)
  return {
    acquisition_mode: acquisitionMode,
    query_shape: 'protocol_wide_local_match',
    completeness_scope: 'manifest_protocol_events_in_height_range',
    finality_claim: usesSqd ? 'provider_finalized_stream_assertion' : 'strict_rpc_membership_bound',
    adapter_id: usesSqd
      ? 'manifest_protocol_event_sqd_finalized_stream_v1'
      : 'manifest_protocol_event_rpc_scan_v1',
    query_template_contract: DEX_ACQUISITION_QUERY_TEMPLATE_CONTRACT_BY_MODE[acquisitionMode],
    scope: {
      kind: 'protocol_manifest_event_scan',
      upstream_filter: 'all_manifest_deployments_and_events',
      evaluation: 'local_golden_50_match',
      population_denominator_eligible: false,
      population_recall_measured: false,
    },
    lane_topology: { kind: 'single_protocol_manifest_stream', lane_count: 1 },
  }
}

function queryPolicy(source: DexGoldenSource, variant: DexPairVariant): DexAcquisitionQueryPolicy {
  const config = modeConfig(source, variant)
  const isBsc = source === 'binance_web3_bsc'
  const laneCount = config.lane_topology.lane_count
  const candidateFanout = isBsc ? 4 : 3
  const candidateAttempts = laneCount * candidateFanout
  return {
    schema_version: DEX_ACQUISITION_QUERY_POLICY_SCHEMA_VERSION,
    data_contract: DEX_ACQUISITION_QUERY_POLICY_CONTRACT,
    ...config,
    adapter_implementation_git_sha: 'cd'.repeat(20),
    adapter_toolchain: {
      contract: DEX_ACQUISITION_ADAPTER_TOOLCHAIN_CONTRACT,
      sha256: digest(`${source}:${variant}:toolchain`),
    },
    query_template_sha256: digest(`${source}:${variant}:query-template`),
    budgets: {
      max_pages_per_lane: 1,
      max_raw_candidates_per_lane: 1,
      request_timeout_ms: 1_000,
      max_response_wire_bytes_per_page: 1,
      max_response_decoded_bytes_per_page: 1,
      max_json_depth: 8,
      concurrency: 1,
      max_attempts_per_request: 1,
      max_run_duration_ms: 1_000,
      phases: {
        boundary_resolution: {
          max_request_attempts: 1,
          max_wire_bytes: 1,
          max_decoded_bytes: 1,
        },
        block_catalog: {
          max_request_attempts: 10,
          max_wire_bytes: 10,
          max_decoded_bytes: 10,
        },
        discovery: {
          max_request_attempts: laneCount,
          max_wire_bytes: laneCount,
          max_decoded_bytes: laneCount,
        },
        transaction_evidence: {
          max_request_attempts: candidateAttempts,
          max_wire_bytes: candidateAttempts,
          max_decoded_bytes: candidateAttempts,
        },
        finality_anchor: {
          max_request_attempts: 1,
          max_wire_bytes: 1,
          max_decoded_bytes: 1,
        },
        gap_evidence: isBsc
          ? { max_request_attempts: 0, max_wire_bytes: 0, max_decoded_bytes: 0 }
          : { max_request_attempts: 10, max_wire_bytes: 10, max_decoded_bytes: 10 },
      },
      billing: { currency: 'USD', max_billed_usd: '1.25' },
    },
    cursor: {
      binding: 'manifest_subset_lane_window_query_endpoint_anchor',
      storage: 'domain_separated_commitment_only',
      repeat_policy: 'fail_stalled',
      cross_lane_reuse: 'reject',
      cross_run_reuse: 'reject',
    },
    transport: {
      strict_utf8: true,
      strict_json_duplicate_keys: 'reject',
      redirect_policy: 'error',
      raw_page_archive_required: true,
      fixed_height_and_utc_window: true,
      include_failed_transactions: true,
      malformed_response_policy: 'fail_lane',
      provider_failover_policy: 'new_manifest_required',
      retry_after_policy: 'respect_bounded',
    },
    candidate_evidence: {
      verification_method: isBsc
        ? 'bsc_strict_rpc_receipt_status_block_membership'
        : 'solana_strict_rpc_signature_status_block_membership',
      transaction_membership_policy: isBsc
        ? 'bsc_transaction_membership_v1'
        : 'solana_transaction_membership_v1',
      rpc_request_upper_bound_per_candidate: candidateFanout,
      max_response_wire_bytes_per_rpc: 1,
      max_response_decoded_bytes_per_rpc: 1,
      unavailable_policy: 'keep_partial',
      rejected_policy: 'fail_closed',
    },
  }
}

function endpointBindings(
  source: DexGoldenSource,
  variant: DexPairVariant
): DexAcquisitionRunManifest['endpoint_bindings'] {
  const isBsc = source === 'binance_web3_bsc'
  const usesSqd = variant === 'sqd_wallet' || variant === 'protocol_sqd'
  const usesDirectIndex = isBsc && variant === 'direct'
  const rpc = endpointProfile({
    profile_id: isBsc ? 'bsc-rpc' : 'solana-rpc',
    provider_id: isBsc ? 'bnb-chain' : 'publicnode',
    data_source_id: isBsc ? 'bsc-mainnet-rpc' : 'solana-mainnet-rpc',
    endpoint_id: isBsc ? 'bnb.public-rpc.primary' : 'publicnode.solana.primary',
    source_independence_group: isBsc ? 'bnb-chain-public-rpc' : 'publicnode-solana-rpc',
    transport_kind: isBsc ? 'evm_json_rpc' : 'solana_json_rpc',
    auth_mode: 'none',
    rate_plan_id: 'phase0-rate-plan',
    pricing_plan_id: 'phase0-pricing-snapshot',
  })
  const profiles = [rpc]
  let discovery = rpc
  if (usesDirectIndex) {
    discovery = endpointProfile({
      profile_id: 'bsc-index',
      provider_id: 'alchemy',
      data_source_id: 'alchemy-bnb-address-index',
      endpoint_id: 'alchemy.bnb-index.primary',
      source_independence_group: 'alchemy-bnb-index',
      transport_kind: 'evm_provider_address_index',
      auth_mode: 'api_key',
      rate_plan_id: 'phase0-rate-plan',
      pricing_plan_id: 'phase0-pricing-snapshot',
    })
    profiles.push(discovery)
  } else if (usesSqd) {
    discovery = endpointProfile({
      profile_id: isBsc ? 'bsc-sqd' : 'solana-sqd',
      provider_id: 'sqd',
      data_source_id: isBsc ? 'sqd-bsc-finalized' : 'sqd-solana-finalized',
      endpoint_id: isBsc ? 'sqd.bsc.finalized' : 'sqd.solana.finalized',
      source_independence_group: isBsc ? 'sqd-bsc-portal' : 'sqd-solana-portal',
      transport_kind: isBsc
        ? 'sqd_portal_evm_finalized_stream'
        : 'sqd_portal_solana_finalized_stream',
      auth_mode: 'none',
      rate_plan_id: 'phase0-rate-plan',
      pricing_plan_id: 'phase0-pricing-snapshot',
    })
    profiles.push(discovery)
  }

  let gapProfileId: string | null = null
  if (!isBsc) {
    const gap = endpointProfile({
      profile_id: 'solana-gap',
      provider_id: 'solana-foundation',
      data_source_id: 'solana-mainnet-rpc',
      endpoint_id: 'solana.foundation.gap',
      source_independence_group: 'solana-foundation-public-rpc',
      transport_kind: 'solana_json_rpc',
      auth_mode: 'none',
      rate_plan_id: 'phase0-rate-plan',
      pricing_plan_id: 'phase0-pricing-snapshot',
    })
    profiles.push(gap)
    gapProfileId = gap.profile_id
  }
  profiles.sort((left, right) => left.profile_id.localeCompare(right.profile_id))

  return {
    registry_contract: DEX_ACQUISITION_ENDPOINT_REGISTRY_CONTRACT,
    registry_sha256: digest(`${source}:${variant}:endpoint-registry`),
    profiles,
    phases: {
      boundary_resolution: rpc.profile_id,
      block_catalog: rpc.profile_id,
      discovery: discovery.profile_id,
      transaction_evidence: rpc.profile_id,
      finality_anchor: rpc.profile_id,
      gap_evidence: gapProfileId,
    },
    redirect_policy: 'error',
    retry_endpoint_policy: 'same_profile_only',
    provider_failover_policy: 'new_manifest_required',
  }
}

function makeManifest(source: DexGoldenSource, variant: DexPairVariant): DexAcquisitionRunManifest {
  const isBsc = source === 'binance_web3_bsc'
  const protocolMode = variant === 'protocol_rpc' || variant === 'protocol_sqd'
  const { sha256: subsetSha256 } = buildDexGoldenWalletChainSubset(fixtureJson, source)
  const policy = queryPolicy(source, variant)
  const sharedWindow = {
    timeframe_days: 7,
    semantics: 'completed_utc_days_half_open',
    start_at: '2026-07-08T00:00:00.000Z',
    end_at: '2026-07-15T00:00:00.000Z',
    duration_seconds: 604800,
    declared_resolution_state: 'fully_resolved',
    height_range: {
      start_inclusive: 100,
      end_exclusive: 107,
      start_boundary_time: '2026-07-08T00:00:03.000Z',
      end_boundary_time: '2026-07-15T00:00:02.000Z',
      start_boundary_evidence_sha256: digest(`${source}:${variant}:start-boundary`),
      end_boundary_evidence_sha256: digest(`${source}:${variant}:end-boundary`),
      boundary_resolution_evidence_sha256: digest(`${source}:${variant}:boundary-resolution`),
      boundary_resolution_observed_at: '2026-07-15T00:01:00.000Z',
      finality_anchor_height: 110,
      finality_anchor_semantic_sha256: digest(`${source}:${variant}:finality-anchor`),
      finality_anchor_observed_at: '2026-07-15T00:02:00.000Z',
    },
  } as const
  const chainWindow = isBsc
    ? {
        chain: { namespace: 'eip155', reference: '56', height_unit: 'block' } as const,
        window: {
          ...sharedWindow,
          boundary_policy: 'bsc_first_produced_block_at_or_after_utc_v1' as const,
          finality_anchor_policy: 'bsc_verified_anchor_semantics_v1' as const,
        },
      }
    : {
        chain: { namespace: 'solana', reference: 'mainnet-beta', height_unit: 'slot' } as const,
        window: {
          ...sharedWindow,
          boundary_policy: 'solana_first_produced_slot_at_or_after_utc_v1' as const,
          finality_anchor_policy: 'solana_verified_anchor_semantics_v1' as const,
        },
      }
  return {
    schema_version: DEX_ACQUISITION_RUN_MANIFEST_SCHEMA_VERSION,
    data_contract: DEX_ACQUISITION_RUN_MANIFEST_CONTRACT,
    purpose: 'phase0_7d_technical_bakeoff_only',
    mode: 'shadow_only',
    resolved_at: '2026-07-15T01:00:00.000Z',
    runner_git_sha: 'ab'.repeat(20),
    runtime: {
      node_version: 'v22.15.0',
      package_manager: 'npm',
      package_manager_version: '11.4.1',
      lockfile_contract: 'npm-package-lock@3',
      lockfile_sha256: digest(`${source}:${variant}:lockfile`),
    },
    ...chainWindow,
    golden_sample: {
      parent_contract: DEX_GOLDEN_WALLET_CONTRACT,
      parent_snapshot_sha256: PARENT_SHA256,
      subset_contract: DEX_GOLDEN_WALLET_SUBSET_CONTRACT,
      subset_sha256: subsetSha256,
      source_slug: source,
      wallet_count: 50,
      selection_scope: 'leaderboard_derived_stratified_technical_sample',
    },
    source: {
      acquisition_mode: policy.acquisition_mode,
      query_shape: policy.query_shape,
      completeness_scope: policy.completeness_scope,
      finality_claim: policy.finality_claim,
      declared_source_role: 'primary_shadow',
      independence_claim: 'not_asserted',
      endpoint_binding_scope: 'exact_profile_per_phase_and_lane',
      mixed_provider_pages: false,
    },
    endpoint_bindings: endpointBindings(source, variant),
    query_policy: policy,
    query_policy_sha256: dexAcquisitionQueryPolicySha256(policy),
    protocol_manifest: protocolMode
      ? {
          state: 'bound',
          contract_id: isBsc
            ? 'arena.dex.bsc-protocol-manifest@1'
            : 'arena.dex.solana-protocol-manifest@1',
          sha256: digest(`${source}:${variant}:protocol-manifest`),
        }
      : { state: 'not_applicable' },
    claims: {
      golden_fixture_verified: false,
      endpoint_registry_verified: false,
      boundary_evidence_verified: false,
      query_template_verified: false,
      adapter_toolchain_verified: false,
      protocol_manifest_verified: false,
      runtime_revision_verified: false,
      execution_authorized: false,
      artifact_persistence_authorized: false,
      transcript_reference_eligible: false,
      source_independence_verified: false,
      population_denominator_eligible: false,
      population_recall_measured: false,
    },
    serving_authorized: false,
    rank_eligible: false,
    score_eligible: false,
  }
}

function telemetryPhase(requestCount: number) {
  return {
    request_count: requestCount,
    accepted_response_count: requestCount,
    request_bytes: requestCount,
    response_wire_bytes: requestCount,
    response_decoded_bytes: requestCount,
    retry_count: 0,
    rate_limit_count: 0,
  }
}

function makeTranscript(
  manifest: DexAcquisitionRunManifest,
  source: DexGoldenSource,
  variant: DexPairVariant
): DexAcquisitionTranscript {
  const isBsc = source === 'binance_web3_bsc'
  const { subset } = buildDexGoldenWalletChainSubset(fixtureJson, source)
  const discoveryProfileId = manifest.endpoint_bindings.phases.discovery
  const protocolManifest =
    manifest.protocol_manifest.state === 'bound' ? manifest.protocol_manifest : null
  const queryLanes: DexAcquisitionTranscript['query_lanes'] =
    manifest.query_policy.lane_topology.kind === 'one_per_golden_wallet'
      ? subset.wallets.map((wallet, index) => ({
          lane_id: `wallet-${String(index).padStart(2, '0')}`,
          endpoint_profile_id: discoveryProfileId,
          scope: { kind: 'wallet' as const, wallet: wallet.wallet },
          query_state: 'exhausted' as const,
          completion_reason: 'window_boundary_reached' as const,
          attempt_count: 1,
          page_count: 1,
          page_chain_sha256: digest(`${source}:${variant}:lane:${index}:pages`),
          checkpoint_sha256: digest(`${source}:${variant}:lane:${index}:checkpoint`),
        }))
      : [
          {
            lane_id:
              manifest.query_policy.lane_topology.kind === 'single_batched_golden_locator'
                ? 'all-golden-wallets'
                : 'all-protocol-manifest-events',
            endpoint_profile_id: discoveryProfileId,
            scope:
              protocolManifest === null
                ? { kind: 'all_golden_wallets' as const }
                : {
                    kind: 'all_protocol_manifest_events' as const,
                    protocol_manifest_contract: protocolManifest.contract_id,
                    protocol_manifest_sha256: protocolManifest.sha256,
                    upstream_filter: 'all_manifest_deployments_and_events' as const,
                    evaluation: 'local_golden_50_match' as const,
                  },
            query_state: 'exhausted',
            completion_reason:
              variant === 'protocol_rpc' ? 'height_range_completed' : 'range_sentinel_observed',
            attempt_count: 1,
            page_count: 1,
            page_chain_sha256: digest(`${source}:${variant}:shared-lane:pages`),
            checkpoint_sha256: digest(`${source}:${variant}:shared-lane:checkpoint`),
          },
        ]
  const walletResults = subset.wallets.map((wallet) => ({
    wallet: wallet.wallet,
    cohort: wallet.cohort,
    candidate_identity_count: 0,
    duplicate_candidate_count: 0,
    outside_window_candidate_count: 0,
    unique_in_window_candidate_count: 0,
    strict_membership_execution_success_count: 0,
    strict_membership_execution_failure_count: 0,
    evidence_unavailable_count: 0,
    evidence_rejected_count: 0,
    first_candidate_height: null,
    last_candidate_height: null,
  }))
  const discoveryRequests = queryLanes.length
  const phases: DexAcquisitionTranscript['telemetry']['phases'] = {
    boundary_resolution: telemetryPhase(1),
    block_catalog: telemetryPhase(1),
    discovery: telemetryPhase(discoveryRequests),
    transaction_evidence: telemetryPhase(0),
    finality_anchor: telemetryPhase(1),
    gap_evidence: telemetryPhase(isBsc ? 0 : 1),
  }

  const transcript: DexAcquisitionTranscript = {
    schema_version: DEX_ACQUISITION_TRANSCRIPT_SCHEMA_VERSION,
    data_contract: DEX_ACQUISITION_TRANSCRIPT_CONTRACT,
    purpose: manifest.purpose,
    mode: manifest.mode,
    generated_at: '2026-07-15T02:00:00.000Z',
    generator_git_sha: manifest.runner_git_sha,
    structural_state: 'structurally_complete',
    chain: clone(manifest.chain),
    golden_sample: clone(manifest.golden_sample),
    window: {
      timeframe_days: manifest.window.timeframe_days,
      semantics: manifest.window.semantics,
      start_at: manifest.window.start_at,
      end_at: manifest.window.end_at,
      duration_seconds: manifest.window.duration_seconds,
      height_range: {
        start_inclusive: manifest.window.height_range.start_inclusive,
        end_exclusive: manifest.window.height_range.end_exclusive,
        start_anchor_semantic_sha256: digest(`${source}:${variant}:transcript-start-anchor`),
        end_anchor_semantic_sha256: digest(`${source}:${variant}:transcript-end-anchor`),
      },
    },
    source: clone(manifest.source),
    endpoint_bindings: {
      ...clone(manifest.endpoint_bindings),
      provider_failover_observed: false,
    },
    artifacts: {
      run_manifest_sha256: dexAcquisitionRunManifestSha256(manifest, fixtureJson),
      query_policy_sha256: manifest.query_policy_sha256,
      page_ledger_sha256: digest(`${source}:${variant}:page-ledger`),
      checkpoint_chain_sha256: digest(`${source}:${variant}:checkpoint-chain`),
      transaction_evidence_index_sha256: digest(`${source}:${variant}:transaction-evidence-index`),
      protocol_manifest_sha256: protocolManifest?.sha256 ?? null,
    },
    candidate_evidence: {
      data_contract: 'arena.dex.transaction-membership-index@1',
      verification_method: manifest.query_policy.candidate_evidence.verification_method,
      provider_independence: 'not_asserted',
    },
    block_catalog: {
      state: 'complete',
      completeness_scope: 'bound_catalog_profile_internal_continuity_only',
      produced_unit_count: isBsc ? 7 : 5,
      verified_skipped_unit_count: isBsc ? 0 : 2,
      missing_unit_count: 0,
      unexplained_gap_count: 0,
      duplicate_delivery_count: 0,
      out_of_order_count: 0,
      first_observed_height: 100,
      last_observed_height: isBsc ? 106 : 105,
      evidence_sha256: digest(`${source}:${variant}:block-catalog`),
      source_separated_gap_evidence_sha256: isBsc
        ? null
        : digest(`${source}:${variant}:gap-evidence`),
    },
    query_lanes: queryLanes,
    query_totals: {
      lane_count: queryLanes.length === 50 ? 50 : 1,
      exhausted_lane_count: queryLanes.length,
      partial_lane_count: 0,
      failed_lane_count: 0,
      not_attempted_lane_count: 0,
      attempt_count: queryLanes.length,
      page_count: queryLanes.length,
    },
    wallet_results: walletResults,
    candidate_totals: {
      wallet_count: 50,
      candidate_identity_count: 0,
      duplicate_candidate_count: 0,
      outside_window_candidate_count: 0,
      unique_in_window_candidate_count: 0,
      strict_membership_execution_success_count: 0,
      strict_membership_execution_failure_count: 0,
      evidence_unavailable_count: 0,
      evidence_rejected_count: 0,
    },
    telemetry: {
      accounting_scope: 'manifest_resolution_and_acquisition',
      phases,
      request_count: 0,
      accepted_response_count: 0,
      request_bytes: 0,
      response_wire_bytes: 0,
      response_decoded_bytes: 0,
      duration_ms: 100,
      retry_count: 0,
      rate_limit_count: 0,
      cost: {
        measurement_state: 'unknown',
        currency: 'USD',
        billed_usd: null,
        pricing_evidence_sha256: null,
      },
    },
    claims: {
      technical_sample_scope: 'leaderboard_derived_stratified_50_wallets',
      query_exhaustion_scope: 'provider_query_only',
      block_catalog_scope: 'bound_catalog_profile_internal_continuity_only',
      wallet_chain_history_complete: false,
      chain_population_complete: false,
      population_denominator_eligible: false,
      population_recall_measured: false,
      population_recall: null,
      referenced_artifacts_verified: false,
      technical_run_complete: false,
      source_independence_verified: false,
    },
    serving_authorized: false,
    rank_eligible: false,
    score_eligible: false,
  }
  recomputeDexPairTelemetryTotals(transcript)
  return transcript
}

export function recomputeDexPairTelemetryTotals(transcript: DexAcquisitionTranscript): void {
  for (const field of [
    'request_count',
    'accepted_response_count',
    'request_bytes',
    'response_wire_bytes',
    'response_decoded_bytes',
    'retry_count',
    'rate_limit_count',
  ] as const) {
    transcript.telemetry[field] = Object.values(transcript.telemetry.phases).reduce(
      (total, phase) => total + phase[field],
      0
    )
  }
}

export function recomputeDexPairQueryTotals(transcript: DexAcquisitionTranscript): void {
  transcript.query_totals.attempt_count = transcript.query_lanes.reduce(
    (total, lane) => total + lane.attempt_count,
    0
  )
  transcript.query_totals.page_count = transcript.query_lanes.reduce(
    (total, lane) => total + lane.page_count,
    0
  )
}

export function recommitDexPairManifest(pair: DexAcquisitionPairFixture): void {
  pair.manifest.query_policy_sha256 = dexAcquisitionQueryPolicySha256(pair.manifest.query_policy)
  pair.transcript.artifacts.query_policy_sha256 = pair.manifest.query_policy_sha256
  pair.transcript.artifacts.run_manifest_sha256 = dexAcquisitionRunManifestSha256(
    pair.manifest,
    fixtureJson
  )
}

export function cloneDexAcquisitionPairFixture(
  pair: DexAcquisitionPairFixture
): DexAcquisitionPairFixture {
  return clone(pair)
}

export function makeDexAcquisitionPairFixture(
  source: DexGoldenSource = 'binance_web3_bsc',
  variant: DexPairVariant = 'direct'
): DexAcquisitionPairFixture {
  const manifest = makeManifest(source, variant)
  return { manifest, transcript: makeTranscript(manifest, source, variant) }
}
