import fixtureJson from '../fixtures/dex-golden-wallets.v1.json'
import {
  DEX_ACQUISITION_ADAPTER_TOOLCHAIN_CONTRACT,
  DEX_ACQUISITION_CONNECTION_DESCRIPTOR_CONTRACT,
  DEX_ACQUISITION_ENDPOINT_PROFILE_CONTRACT,
  DEX_ACQUISITION_ENDPOINT_REGISTRY_CONTRACT,
  DEX_ACQUISITION_QUERY_POLICY_CONTRACT,
  DEX_ACQUISITION_QUERY_POLICY_SCHEMA_VERSION,
  DEX_ACQUISITION_QUERY_TEMPLATE_CONTRACT_BY_MODE,
  DEX_ACQUISITION_PERSISTED_METADATA_FIELDS,
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
  parseDexAcquisitionRunManifest,
} from '../lib/dex-acquisition-run-manifest'
import {
  buildDexGoldenWalletChainSubset,
  DEX_GOLDEN_WALLET_CONTRACT,
  DEX_GOLDEN_WALLET_SUBSET_CONTRACT,
  type DexGoldenSource,
} from '../lib/dex-golden-wallets'

const HASH = {
  registry: '10'.repeat(32),
  lockfile: '11'.repeat(32),
  template: '12'.repeat(32),
  startBoundary: '13'.repeat(32),
  endBoundary: '14'.repeat(32),
  boundaryResolution: '15'.repeat(32),
  finalityAnchor: '16'.repeat(32),
  protocolManifest: '17'.repeat(32),
  toolchain: '18'.repeat(32),
} as const

const PARENT_SHA256 = '736144afddfb61c3140c4286caf480578345aae1c30f9e65c50341092cf2e5ba'
const GIB = 1024 * 1024 * 1024

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function mutableRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('test fixture value must be an object')
  }
  return value as Record<string, unknown>
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, item]) => [key, reverseObjectKeys(item)])
  )
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

function rehashEndpointProfile(profile: DexAcquisitionEndpointProfile): void {
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

function queryPolicy(source: DexGoldenSource): DexAcquisitionQueryPolicy {
  const isBsc = source === 'binance_web3_bsc'
  return {
    schema_version: DEX_ACQUISITION_QUERY_POLICY_SCHEMA_VERSION,
    data_contract: DEX_ACQUISITION_QUERY_POLICY_CONTRACT,
    acquisition_mode: isBsc ? 'bsc_provider_address_index' : 'solana_rpc_signatures_for_address',
    query_shape: 'one_query_per_wallet',
    completeness_scope: isBsc ? 'provider_address_index_query' : 'rpc_address_signature_query',
    finality_claim: isBsc
      ? 'provider_index_with_strict_rpc_membership'
      : 'strict_rpc_membership_bound',
    adapter_id: isBsc ? 'bsc_provider_address_index_v1' : 'solana_get_signatures_for_address_v1',
    adapter_implementation_git_sha: 'cd'.repeat(20),
    adapter_toolchain: {
      contract: DEX_ACQUISITION_ADAPTER_TOOLCHAIN_CONTRACT,
      sha256: HASH.toolchain,
    },
    query_template_contract: isBsc
      ? DEX_ACQUISITION_QUERY_TEMPLATE_CONTRACT_BY_MODE.bsc_provider_address_index
      : DEX_ACQUISITION_QUERY_TEMPLATE_CONTRACT_BY_MODE.solana_rpc_signatures_for_address,
    query_template_sha256: HASH.template,
    scope: {
      kind: 'golden_wallet_technical_sample',
      upstream_filter: 'exact_golden_50_subset',
      evaluation: 'direct_wallet_locator',
      population_denominator_eligible: false,
      population_recall_measured: false,
    },
    lane_topology: { kind: 'one_per_golden_wallet', lane_count: 50 },
    budgets: {
      max_pages_per_lane: 100,
      max_raw_candidates_per_lane: 500,
      request_timeout_ms: 30_000,
      max_response_wire_bytes_per_page: 8 * 1024 * 1024,
      max_response_decoded_bytes_per_page: 32 * 1024 * 1024,
      max_json_depth: 64,
      concurrency: 2,
      max_attempts_per_request: 3,
      max_run_duration_ms: 6 * 60 * 60 * 1000,
      phases: {
        boundary_resolution: {
          max_request_attempts: 200,
          max_wire_bytes: GIB,
          max_decoded_bytes: 4 * GIB,
        },
        block_catalog: {
          max_request_attempts: 50_000,
          max_wire_bytes: 32 * GIB,
          max_decoded_bytes: 128 * GIB,
        },
        discovery: {
          max_request_attempts: 15_000,
          max_wire_bytes: 128 * GIB,
          max_decoded_bytes: 512 * GIB,
        },
        transaction_evidence: {
          max_request_attempts: isBsc ? 300_000 : 225_000,
          max_wire_bytes: 128 * GIB,
          max_decoded_bytes: 256 * GIB,
        },
        finality_anchor: {
          max_request_attempts: 20,
          max_wire_bytes: GIB,
          max_decoded_bytes: 4 * GIB,
        },
        gap_evidence: isBsc
          ? { max_request_attempts: 0, max_wire_bytes: 0, max_decoded_bytes: 0 }
          : {
              max_request_attempts: 50_000,
              max_wire_bytes: 16 * GIB,
              max_decoded_bytes: 64 * GIB,
            },
      },
      billing: { currency: 'USD', max_billed_usd: '0' },
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
      evidence_persistence: {
        mode: 'metadata_only',
        body_lifecycle: {
          provider_request_body: 'in_memory_only_then_zero_or_release',
          provider_response_body: 'in_memory_only_then_zero_or_release',
          normalized_json_body: 'in_memory_only_then_zero_or_release',
        },
        persisted_metadata_fields: [...DEX_ACQUISITION_PERSISTED_METADATA_FIELDS],
        opaque_cursor_storage: 'domain_separated_commitment_only',
        blob_availability: 'absent',
        replay_state: 'declared_not_replayed',
        replay_promotion_policy: 'refetch_and_recompute_required',
      },
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
      rpc_request_upper_bound_per_candidate: isBsc ? 4 : 3,
      max_response_wire_bytes_per_rpc: 256 * 1024,
      max_response_decoded_bytes_per_rpc: 512 * 1024,
      unavailable_policy: 'keep_partial',
      rejected_policy: 'fail_closed',
    },
  }
}

function validManifest(source: DexGoldenSource = 'binance_web3_bsc'): DexAcquisitionRunManifest {
  const { sha256: subsetSha256 } = buildDexGoldenWalletChainSubset(fixtureJson, source)
  const isBsc = source === 'binance_web3_bsc'
  const policy = queryPolicy(source)
  const profiles = isBsc
    ? [
        endpointProfile({
          profile_id: 'bsc-discovery',
          provider_id: 'alchemy',
          data_source_id: 'alchemy-bnb-mainnet-address-index',
          endpoint_id: 'alchemy.bnb-mainnet.primary',
          source_independence_group: 'alchemy-bnb-index',
          transport_kind: 'evm_provider_address_index',
          auth_mode: 'api_key',
          rate_plan_id: 'phase0-rate-plan',
          pricing_plan_id: 'phase0-pricing-snapshot',
        }),
        endpointProfile({
          profile_id: 'bsc-evidence',
          provider_id: 'bnb-chain',
          data_source_id: 'bsc-mainnet-rpc',
          endpoint_id: 'bnb.official-public-seed',
          source_independence_group: 'bnb-chain-public-rpc',
          transport_kind: 'evm_json_rpc',
          auth_mode: 'none',
          rate_plan_id: 'phase0-rate-plan',
          pricing_plan_id: 'phase0-pricing-snapshot',
        }),
      ]
    : [
        endpointProfile({
          profile_id: 'solana-gap',
          provider_id: 'solana-foundation',
          data_source_id: 'solana-mainnet-rpc',
          endpoint_id: 'solana.mainnet.independent-gap',
          source_independence_group: 'solana-foundation-public-rpc',
          transport_kind: 'solana_json_rpc',
          auth_mode: 'none',
          rate_plan_id: 'phase0-rate-plan',
          pricing_plan_id: 'phase0-pricing-snapshot',
        }),
        endpointProfile({
          profile_id: 'solana-primary',
          provider_id: 'publicnode',
          data_source_id: 'solana-mainnet-rpc',
          endpoint_id: 'solana.mainnet.primary',
          source_independence_group: 'publicnode-solana-rpc',
          transport_kind: 'solana_json_rpc',
          auth_mode: 'none',
          rate_plan_id: 'phase0-rate-plan',
          pricing_plan_id: 'phase0-pricing-snapshot',
        }),
      ]

  return {
    schema_version: DEX_ACQUISITION_RUN_MANIFEST_SCHEMA_VERSION,
    data_contract: DEX_ACQUISITION_RUN_MANIFEST_CONTRACT,
    purpose: 'phase0_7d_technical_bakeoff_only',
    mode: 'shadow_only',
    resolved_at: '2026-07-16T20:00:00.000Z',
    runner_git_sha: 'ab'.repeat(20),
    runtime: {
      node_version: 'v22.15.0',
      package_manager: 'npm',
      package_manager_version: '11.4.1',
      lockfile_contract: 'npm-package-lock@3',
      lockfile_sha256: HASH.lockfile,
    },
    chain: isBsc
      ? { namespace: 'eip155', reference: '56', height_unit: 'block' }
      : { namespace: 'solana', reference: 'mainnet-beta', height_unit: 'slot' },
    golden_sample: {
      parent_contract: DEX_GOLDEN_WALLET_CONTRACT,
      parent_snapshot_sha256: PARENT_SHA256,
      subset_contract: DEX_GOLDEN_WALLET_SUBSET_CONTRACT,
      subset_sha256: subsetSha256,
      source_slug: source,
      wallet_count: 50,
      selection_scope: 'leaderboard_derived_stratified_technical_sample',
    },
    window: {
      timeframe_days: 7,
      semantics: 'completed_utc_days_half_open',
      start_at: '2026-07-08T00:00:00.000Z',
      end_at: '2026-07-15T00:00:00.000Z',
      duration_seconds: 604800,
      declared_resolution_state: 'fully_resolved',
      boundary_policy: isBsc
        ? 'bsc_first_produced_block_at_or_after_utc_v1'
        : 'solana_first_produced_slot_at_or_after_utc_v1',
      finality_anchor_policy: isBsc
        ? 'bsc_verified_anchor_semantics_v1'
        : 'solana_verified_anchor_semantics_v2',
      height_range: {
        start_inclusive: 100,
        end_exclusive: 107,
        start_boundary_time: '2026-07-08T00:00:03.000Z',
        end_boundary_time: '2026-07-15T00:00:02.000Z',
        start_boundary_evidence_sha256: HASH.startBoundary,
        end_boundary_evidence_sha256: HASH.endBoundary,
        boundary_resolution_evidence_sha256: HASH.boundaryResolution,
        boundary_resolution_observed_at: '2026-07-15T00:01:00.000Z',
        finality_anchor_height: 110,
        finality_anchor_semantic_sha256: HASH.finalityAnchor,
        finality_anchor_observed_at: '2026-07-15T00:02:00.000Z',
      },
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
    endpoint_bindings: {
      registry_contract: DEX_ACQUISITION_ENDPOINT_REGISTRY_CONTRACT,
      registry_sha256: HASH.registry,
      profiles,
      phases: isBsc
        ? {
            boundary_resolution: 'bsc-evidence',
            block_catalog: 'bsc-evidence',
            discovery: 'bsc-discovery',
            transaction_evidence: 'bsc-evidence',
            finality_anchor: 'bsc-evidence',
            gap_evidence: null,
          }
        : {
            boundary_resolution: 'solana-primary',
            block_catalog: 'solana-primary',
            discovery: 'solana-primary',
            transaction_evidence: 'solana-primary',
            finality_anchor: 'solana-primary',
            gap_evidence: 'solana-gap',
          },
      redirect_policy: 'error',
      retry_endpoint_policy: 'same_profile_only',
      provider_failover_policy: 'new_manifest_required',
    },
    query_policy: policy,
    query_policy_sha256: dexAcquisitionQueryPolicySha256(policy),
    protocol_manifest: { state: 'not_applicable' },
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

function asSqdRun(manifest: DexAcquisitionRunManifest): DexAcquisitionRunManifest {
  const isBsc = manifest.chain.namespace === 'eip155'
  const sqdProfileId = isBsc ? 'bsc-sqd' : 'solana-sqd'
  const sqdProfile = endpointProfile({
    profile_id: sqdProfileId,
    provider_id: 'sqd-network',
    data_source_id: isBsc ? 'sqd-binance-mainnet' : 'sqd-solana-mainnet',
    endpoint_id: isBsc ? 'sqd.portal.binance-mainnet' : 'sqd.portal.solana-mainnet',
    source_independence_group: isBsc ? 'sqd-binance-mainnet' : 'sqd-solana-mainnet',
    transport_kind: isBsc
      ? 'sqd_portal_evm_finalized_stream'
      : 'sqd_portal_solana_finalized_stream',
    auth_mode: 'none',
    rate_plan_id: 'public-development-20-per-10s',
    pricing_plan_id: 'public-development-zero-billed-2026-07',
  })
  manifest.endpoint_bindings.profiles = [
    ...manifest.endpoint_bindings.profiles.filter((profile) =>
      isBsc ? profile.profile_id === 'bsc-evidence' : true
    ),
    sqdProfile,
  ].sort((left, right) =>
    left.profile_id < right.profile_id ? -1 : left.profile_id > right.profile_id ? 1 : 0
  )
  manifest.endpoint_bindings.phases.boundary_resolution = sqdProfileId
  manifest.endpoint_bindings.phases.block_catalog = sqdProfileId
  manifest.endpoint_bindings.phases.discovery = sqdProfileId
  manifest.source = {
    ...manifest.source,
    acquisition_mode: 'sqd_finalized_stream_wallet_locator',
    query_shape: 'batched_wallet_locator',
    completeness_scope: 'provider_dataset_wallet_locator_query',
    finality_claim: 'provider_finalized_stream_assertion',
  }
  manifest.query_policy = {
    ...manifest.query_policy,
    acquisition_mode: 'sqd_finalized_stream_wallet_locator',
    query_shape: 'batched_wallet_locator',
    completeness_scope: 'provider_dataset_wallet_locator_query',
    finality_claim: 'provider_finalized_stream_assertion',
    adapter_id: 'sqd_finalized_stream_wallet_locator_v1',
    query_template_contract:
      DEX_ACQUISITION_QUERY_TEMPLATE_CONTRACT_BY_MODE.sqd_finalized_stream_wallet_locator,
    lane_topology: { kind: 'single_batched_golden_locator', lane_count: 1 },
  }
  manifest.query_policy_sha256 = dexAcquisitionQueryPolicySha256(manifest.query_policy)
  return manifest
}

function asProtocolRun(
  manifest: DexAcquisitionRunManifest,
  transport: 'rpc' | 'sqd' = 'rpc'
): DexAcquisitionRunManifest {
  if (transport === 'sqd') asSqdRun(manifest)
  const isSqd = transport === 'sqd'
  const isBsc = manifest.chain.namespace === 'eip155'
  if (!isSqd && isBsc) {
    manifest.endpoint_bindings.profiles = manifest.endpoint_bindings.profiles.filter(
      (profile) => profile.profile_id === 'bsc-evidence'
    )
    manifest.endpoint_bindings.phases.discovery = 'bsc-evidence'
  }
  const acquisitionMode = isSqd
    ? 'manifest_protocol_event_sqd_finalized_stream'
    : 'manifest_protocol_event_rpc_scan'
  manifest.source = {
    ...manifest.source,
    acquisition_mode: acquisitionMode,
    query_shape: 'protocol_wide_local_match',
    completeness_scope: 'manifest_protocol_events_in_height_range',
    finality_claim: isSqd ? 'provider_finalized_stream_assertion' : 'strict_rpc_membership_bound',
  }
  manifest.query_policy = {
    ...manifest.query_policy,
    acquisition_mode: acquisitionMode,
    query_shape: 'protocol_wide_local_match',
    completeness_scope: 'manifest_protocol_events_in_height_range',
    finality_claim: isSqd ? 'provider_finalized_stream_assertion' : 'strict_rpc_membership_bound',
    adapter_id: isSqd
      ? 'manifest_protocol_event_sqd_finalized_stream_v1'
      : 'manifest_protocol_event_rpc_scan_v1',
    query_template_contract: isSqd
      ? DEX_ACQUISITION_QUERY_TEMPLATE_CONTRACT_BY_MODE.manifest_protocol_event_sqd_finalized_stream
      : DEX_ACQUISITION_QUERY_TEMPLATE_CONTRACT_BY_MODE.manifest_protocol_event_rpc_scan,
    budgets: {
      ...manifest.query_policy.budgets,
      max_raw_candidates_per_lane: 30_000,
      phases: {
        ...manifest.query_policy.budgets.phases,
        transaction_evidence: {
          ...manifest.query_policy.budgets.phases.transaction_evidence,
          max_request_attempts: isBsc ? 360_000 : 270_000,
        },
      },
    },
    scope: {
      kind: 'protocol_manifest_event_scan',
      upstream_filter: 'all_manifest_deployments_and_events',
      evaluation: 'local_golden_50_match',
      population_denominator_eligible: false,
      population_recall_measured: false,
    },
    lane_topology: { kind: 'single_protocol_manifest_stream', lane_count: 1 },
  }
  manifest.query_policy_sha256 = dexAcquisitionQueryPolicySha256(manifest.query_policy)
  manifest.protocol_manifest = {
    state: 'bound',
    contract_id: isBsc
      ? 'arena.dex.bsc-protocol-manifest@1'
      : 'arena.dex.solana-protocol-manifest@1',
    sha256: HASH.protocolManifest,
  }
  return manifest
}

describe('DEX acquisition run manifest contract', () => {
  it('accepts fully populated BSC and Solana manifests without authorizing execution', () => {
    const bsc = parseDexAcquisitionRunManifest(validManifest(), fixtureJson)
    const solana = parseDexAcquisitionRunManifest(validManifest('okx_web3_solana'), fixtureJson)

    expect(bsc.chain).toEqual({ namespace: 'eip155', reference: '56', height_unit: 'block' })
    expect(solana.chain).toEqual({
      namespace: 'solana',
      reference: 'mainnet-beta',
      height_unit: 'slot',
    })
    expect(bsc).toMatchObject({
      schema_version: 3,
      data_contract: 'arena.dex.acquisition-run-manifest@3',
      query_policy: {
        schema_version: 2,
        data_contract: 'arena.dex.acquisition-query-policy@2',
      },
    })
    expect(solana.window.finality_anchor_policy).toBe('solana_verified_anchor_semantics_v2')
    expect(bsc.claims).toMatchObject({
      boundary_evidence_verified: false,
      endpoint_registry_verified: false,
      execution_authorized: false,
      artifact_persistence_authorized: false,
      transcript_reference_eligible: false,
    })
  })

  it('rejects legacy run schema versions 1 and 2', () => {
    const previousSchema = validManifest()
    mutableRecord(previousSchema).schema_version = 2
    expect(() => parseDexAcquisitionRunManifest(previousSchema, fixtureJson)).toThrow()

    const legacySchema = validManifest()
    mutableRecord(legacySchema).schema_version = 1
    expect(() => parseDexAcquisitionRunManifest(legacySchema, fixtureJson)).toThrow()
  })

  it('rejects the previous @2 and legacy @1 run-manifest contracts', () => {
    const previousContract = validManifest()
    mutableRecord(previousContract).data_contract = 'arena.dex.acquisition-run-manifest@2'
    expect(() => parseDexAcquisitionRunManifest(previousContract, fixtureJson)).toThrow()

    const legacyContract = validManifest()
    mutableRecord(legacyContract).data_contract = 'arena.dex.acquisition-run-manifest@1'
    expect(() => parseDexAcquisitionRunManifest(legacyContract, fixtureJson)).toThrow()
  })

  it('rejects the pre-metadata query-policy @1 identity', () => {
    const previousSchema = validManifest()
    mutableRecord(previousSchema.query_policy).schema_version = 1
    expect(() => parseDexAcquisitionRunManifest(previousSchema, fixtureJson)).toThrow()

    const previousContract = validManifest()
    mutableRecord(previousContract.query_policy).data_contract =
      'arena.dex.acquisition-query-policy@1'
    expect(() => parseDexAcquisitionRunManifest(previousContract, fixtureJson)).toThrow()
  })

  it('pins the exact metadata-only evidence lifecycle and persisted field order', () => {
    const manifest = parseDexAcquisitionRunManifest(validManifest(), fixtureJson)

    expect(manifest.query_policy.transport.evidence_persistence).toEqual({
      mode: 'metadata_only',
      body_lifecycle: {
        provider_request_body: 'in_memory_only_then_zero_or_release',
        provider_response_body: 'in_memory_only_then_zero_or_release',
        normalized_json_body: 'in_memory_only_then_zero_or_release',
      },
      persisted_metadata_fields: DEX_ACQUISITION_PERSISTED_METADATA_FIELDS,
      opaque_cursor_storage: 'domain_separated_commitment_only',
      blob_availability: 'absent',
      replay_state: 'declared_not_replayed',
      replay_promotion_policy: 'refetch_and_recompute_required',
    })
    expect(DEX_ACQUISITION_PERSISTED_METADATA_FIELDS).toContain('source_independence_group')
    expect(DEX_ACQUISITION_PERSISTED_METADATA_FIELDS).toContain(
      'batch_page_item_hash_chain_metadata'
    )
    expect(DEX_ACQUISITION_PERSISTED_METADATA_FIELDS).toContain('verification_state')
    expect(DEX_ACQUISITION_PERSISTED_METADATA_FIELDS).not.toContain(
      'batch_page_hash_chain_metadata'
    )
  })

  it('rejects the v2 raw archive flag and body, blob, URL, header, or secret fields', () => {
    const forbiddenRawFlag = validManifest()
    mutableRecord(forbiddenRawFlag.query_policy.transport).raw_page_archive_required = true
    expect(() => parseDexAcquisitionRunManifest(forbiddenRawFlag, fixtureJson)).toThrow()

    const previousRawPolicy = validManifest()
    const previousRawTransport = mutableRecord(previousRawPolicy.query_policy.transport)
    delete previousRawTransport.evidence_persistence
    previousRawTransport.raw_page_archive_required = true
    expect(() => parseDexAcquisitionRunManifest(previousRawPolicy, fixtureJson)).toThrow()

    for (const [field, value] of [
      ['provider_response_body', '{"jsonrpc":"2.0","result":[]}'],
      ['blob_locator', 'sha256:'.concat('ab'.repeat(32))],
      ['endpoint_url', 'https://rpc.example.test/?api_key=secret'],
      ['request_headers', { authorization: 'Bearer secret' }],
      ['api_secret', 'secret'],
    ] as const) {
      const changed = validManifest()
      mutableRecord(changed.query_policy.transport.evidence_persistence)[field] = value
      expect(() => parseDexAcquisitionRunManifest(changed, fixtureJson)).toThrow()
    }
  })

  it('rejects forged, missing, or reordered persisted metadata policy fields', () => {
    const reordered = validManifest()
    reordered.query_policy.transport.evidence_persistence.persisted_metadata_fields.reverse()
    expect(() => parseDexAcquisitionRunManifest(reordered, fixtureJson)).toThrow()

    const forged = validManifest()
    mutableRecord(forged.query_policy.transport.evidence_persistence).persisted_metadata_fields = [
      ...DEX_ACQUISITION_PERSISTED_METADATA_FIELDS.slice(0, -1),
      'raw_provider_body',
    ]
    expect(() => parseDexAcquisitionRunManifest(forged, fixtureJson)).toThrow()

    const missing = validManifest()
    mutableRecord(missing.query_policy.transport.evidence_persistence).persisted_metadata_fields =
      DEX_ACQUISITION_PERSISTED_METADATA_FIELDS.slice(1)
    expect(() => parseDexAcquisitionRunManifest(missing, fixtureJson)).toThrow()
  })

  it('rejects forged body lifecycle, cursor, blob, and replay policy literals', () => {
    const mutations = [
      ['mode', 'raw_archive'],
      ['opaque_cursor_storage', 'plaintext'],
      ['blob_availability', 'retrievable'],
      ['replay_state', 'replayed'],
      ['replay_promotion_policy', 'trust_declared_hashes'],
    ] as const
    for (const [field, value] of mutations) {
      const changed = validManifest()
      mutableRecord(changed.query_policy.transport.evidence_persistence)[field] = value
      expect(() => parseDexAcquisitionRunManifest(changed, fixtureJson)).toThrow()
    }

    const persistedBody = validManifest()
    mutableRecord(
      persistedBody.query_policy.transport.evidence_persistence.body_lifecycle
    ).provider_response_body = 'persist'
    expect(() => parseDexAcquisitionRunManifest(persistedBody, fixtureJson)).toThrow()
  })

  it('rejects Solana v1 anchor semantics', () => {
    const legacySolanaAnchor = validManifest('okx_web3_solana')
    mutableRecord(legacySolanaAnchor.window).finality_anchor_policy =
      'solana_verified_anchor_semantics_v1'
    expect(() => parseDexAcquisitionRunManifest(legacySolanaAnchor, fixtureJson)).toThrow()
  })

  it('accepts the complete chain and acquisition-mode matrix', () => {
    const manifests = [
      validManifest(),
      validManifest('okx_web3_solana'),
      asSqdRun(validManifest()),
      asSqdRun(validManifest('okx_web3_solana')),
      asProtocolRun(validManifest()),
      asProtocolRun(validManifest('okx_web3_solana')),
      asProtocolRun(validManifest(), 'sqd'),
      asProtocolRun(validManifest('okx_web3_solana'), 'sqd'),
    ]

    expect(
      manifests.map(
        (manifest) => parseDexAcquisitionRunManifest(manifest, fixtureJson).source.acquisition_mode
      )
    ).toEqual([
      'bsc_provider_address_index',
      'solana_rpc_signatures_for_address',
      'sqd_finalized_stream_wallet_locator',
      'sqd_finalized_stream_wallet_locator',
      'manifest_protocol_event_rpc_scan',
      'manifest_protocol_event_rpc_scan',
      'manifest_protocol_event_sqd_finalized_stream',
      'manifest_protocol_event_sqd_finalized_stream',
    ])
  })

  it('pins domain-bound policy and manifest hashes', () => {
    const manifest = validManifest()
    const expectedPolicy = 'f22b0830b1d4415f46a0c91fa68c3b282ea62ea7d79762e8210c92b37cecbf4d'
    const expectedManifest = '53f71b3e39f49ad956317bc69c45e0783ab2cb5db2a4f9608ea066106ce7714d'

    expect(dexAcquisitionQueryPolicySha256(manifest.query_policy)).toBe(expectedPolicy)
    expect(dexAcquisitionRunManifestSha256(manifest, fixtureJson)).toBe(expectedManifest)
    expect(dexAcquisitionRunManifestSha256(reverseObjectKeys(manifest), fixtureJson)).toBe(
      expectedManifest
    )

    const changed = clone(manifest)
    changed.query_policy.budgets.request_timeout_ms += 1
    changed.query_policy_sha256 = dexAcquisitionQueryPolicySha256(changed.query_policy)
    expect(dexAcquisitionRunManifestSha256(changed, fixtureJson)).not.toBe(expectedManifest)
  })

  it('rejects pending, placeholder, or unknown resolution fields', () => {
    const pending = validManifest() as DexAcquisitionRunManifest & {
      window: DexAcquisitionRunManifest['window'] & { declared_resolution_state: string }
    }
    pending.window.declared_resolution_state = 'pending'
    expect(() => parseDexAcquisitionRunManifest(pending, fixtureJson)).toThrow()

    const zeroBoundary = validManifest()
    zeroBoundary.window.height_range.start_boundary_evidence_sha256 = '0'.repeat(64)
    expect(() => parseDexAcquisitionRunManifest(zeroBoundary, fixtureJson)).toThrow(/nonzero/)

    const unknown = validManifest() as DexAcquisitionRunManifest & { rpc_url: string }
    unknown.rpc_url = 'https://example.test/?apiKey=secret'
    expect(() => parseDexAcquisitionRunManifest(unknown, fixtureJson)).toThrow()
  })

  it('keeps redirect, failover, and cursor reuse controls fail-closed', () => {
    const redirect = validManifest()
    mutableRecord(redirect.endpoint_bindings).redirect_policy = 'follow'
    expect(() => parseDexAcquisitionRunManifest(redirect, fixtureJson)).toThrow()

    const failover = validManifest()
    mutableRecord(failover.query_policy.transport).provider_failover_policy = 'continue'
    expect(() => parseDexAcquisitionRunManifest(failover, fixtureJson)).toThrow()

    const cursorReuse = validManifest()
    mutableRecord(cursorReuse.query_policy.cursor).cross_run_reuse = 'allow'
    expect(() => parseDexAcquisitionRunManifest(cursorReuse, fixtureJson)).toThrow()
  })

  it('requires an exact completed UTC window and honest boundary times', () => {
    const nonMidnight = validManifest()
    nonMidnight.window.start_at = '2026-07-08T00:00:01.000Z'
    expect(() => parseDexAcquisitionRunManifest(nonMidnight, fixtureJson)).toThrow(/UTC midnight/)

    const short = validManifest()
    short.window.end_at = '2026-07-14T00:00:00.000Z'
    expect(() => parseDexAcquisitionRunManifest(short, fixtureJson)).toThrow(/exactly seven/)

    const resolvedEarly = validManifest()
    resolvedEarly.resolved_at = '2026-07-14T23:59:59.999Z'
    expect(() => parseDexAcquisitionRunManifest(resolvedEarly, fixtureJson)).toThrow(
      /before its completed window ends/
    )

    const earlyStartBoundary = validManifest()
    earlyStartBoundary.window.height_range.start_boundary_time = '2026-07-07T23:59:59.000Z'
    expect(() => parseDexAcquisitionRunManifest(earlyStartBoundary, fixtureJson)).toThrow(
      /start boundary time/
    )

    const earlySentinel = validManifest()
    earlySentinel.window.height_range.end_boundary_time = '2026-07-14T23:59:59.000Z'
    expect(() => parseDexAcquisitionRunManifest(earlySentinel, fixtureJson)).toThrow(
      /end boundary sentinel/
    )

    const futureSentinel = validManifest()
    futureSentinel.window.height_range.end_boundary_time = '2100-01-01T00:00:00.000Z'
    expect(() => parseDexAcquisitionRunManifest(futureSentinel, fixtureJson)).toThrow(/clock skew/)

    const unresolvedEvidence = validManifest()
    unresolvedEvidence.window.height_range.finality_anchor_observed_at = '2026-07-16T20:00:00.001Z'
    expect(() => parseDexAcquisitionRunManifest(unresolvedEvidence, fixtureJson)).toThrow(
      /before its evidence was observed/
    )
  })

  it('rejects negative zero, unsafe or reversed heights, and a shallow finality anchor', () => {
    const negativeZero = validManifest()
    negativeZero.window.height_range.start_inclusive = -0
    expect(() => parseDexAcquisitionRunManifest(negativeZero, fixtureJson)).toThrow(/negative zero/)

    const unsafe = validManifest()
    unsafe.query_policy.budgets.max_raw_candidates_per_lane = Number.MAX_SAFE_INTEGER + 1
    expect(() => parseDexAcquisitionRunManifest(unsafe, fixtureJson)).toThrow(/safe/)

    const empty = validManifest()
    empty.window.height_range.end_exclusive = 100
    expect(() => parseDexAcquisitionRunManifest(empty, fixtureJson)).toThrow(/non-empty/)

    const shallowAnchor = validManifest()
    shallowAnchor.window.height_range.finality_anchor_height = 106
    expect(() => parseDexAcquisitionRunManifest(shallowAnchor, fixtureJson)).toThrow(
      /cover the end-exclusive sentinel/
    )
  })

  it('re-derives the parent fixture, chain subset, and chain identity', () => {
    const wrongParent = validManifest()
    wrongParent.golden_sample.parent_snapshot_sha256 = HASH.registry
    expect(() => parseDexAcquisitionRunManifest(wrongParent, fixtureJson)).toThrow(
      /parent snapshot/
    )

    const wrongSubset = validManifest()
    wrongSubset.golden_sample.subset_sha256 = HASH.registry
    expect(() => parseDexAcquisitionRunManifest(wrongSubset, fixtureJson)).toThrow(/subset SHA/)

    const wrongChain = validManifest()
    wrongChain.chain = { namespace: 'solana', reference: 'mainnet-beta', height_unit: 'slot' }
    expect(() => parseDexAcquisitionRunManifest(wrongChain, fixtureJson)).toThrow(/chain conflicts/)
  })

  it('recomputes connection descriptors and endpoint identities', () => {
    const changedEndpoint = validManifest()
    changedEndpoint.endpoint_bindings.profiles[0].endpoint_id = 'alchemy.bnb-mainnet.changed'
    expect(() => parseDexAcquisitionRunManifest(changedEndpoint, fixtureJson)).toThrow(
      /connection descriptor SHA/
    )

    const changedProfileId = validManifest()
    changedProfileId.endpoint_bindings.profiles[0].profile_id = 'bsc-discovery-changed'
    changedProfileId.endpoint_bindings.phases.discovery = 'bsc-discovery-changed'
    expect(() => parseDexAcquisitionRunManifest(changedProfileId, fixtureJson)).toThrow(
      /endpoint identity SHA/
    )

    const secretUrl = validManifest()
    secretUrl.endpoint_bindings.profiles[0].endpoint_id = 'https://example.test/token'
    expect(() => parseDexAcquisitionRunManifest(secretUrl, fixtureJson)).toThrow()

    const secretAlias = validManifest()
    const secretValue = `sk_live_${'a'.repeat(24)}`
    secretAlias.endpoint_bindings.profiles[0].endpoint_id = secretValue
    let secretError = ''
    try {
      parseDexAcquisitionRunManifest(secretAlias, fixtureJson)
    } catch (error) {
      secretError = String(error)
    }
    expect(secretError).toMatch(/forbidden credential-like or opaque segment/)
    expect(secretError).not.toContain(secretValue)

    const opaqueAlias = validManifest()
    opaqueAlias.endpoint_bindings.profiles[0].endpoint_id = 'a'.repeat(64)
    expect(() => parseDexAcquisitionRunManifest(opaqueAlias, fixtureJson)).toThrow(
      /forbidden credential-like or opaque segment/
    )

    const uuidAlias = validManifest()
    uuidAlias.endpoint_bindings.profiles[0].endpoint_id = '123e4567-e89b-12d3-a456-426614174000'
    expect(() => parseDexAcquisitionRunManifest(uuidAlias, fixtureJson)).toThrow(
      /forbidden credential-like or opaque segment/
    )

    const extraHeader = validManifest()
    const profile = extraHeader.endpoint_bindings.profiles[0] as DexAcquisitionEndpointProfile & {
      authorization: string
    }
    profile.authorization = 'Bearer secret'
    expect(() => parseDexAcquisitionRunManifest(extraHeader, fixtureJson)).toThrow()
  })

  it('requires canonical, complete phase-to-endpoint bindings', () => {
    const reordered = validManifest()
    ;[reordered.endpoint_bindings.profiles[0], reordered.endpoint_bindings.profiles[1]] = [
      reordered.endpoint_bindings.profiles[1],
      reordered.endpoint_bindings.profiles[0],
    ]
    expect(() => parseDexAcquisitionRunManifest(reordered, fixtureJson)).toThrow(/canonical/)

    const unknownProfile = validManifest()
    unknownProfile.endpoint_bindings.phases.discovery = 'missing-profile'
    expect(() => parseDexAcquisitionRunManifest(unknownProfile, fixtureJson)).toThrow(
      /unknown endpoint profile/
    )

    const unused = validManifest()
    unused.endpoint_bindings.phases.discovery = 'bsc-evidence'
    expect(() => parseDexAcquisitionRunManifest(unused, fixtureJson)).toThrow(/all be referenced/)

    const aliasedConnection = validManifest()
    const duplicateProfile = clone(aliasedConnection.endpoint_bindings.profiles[0])
    duplicateProfile.profile_id = 'bsc-discovery-alias'
    rehashEndpointProfile(duplicateProfile)
    aliasedConnection.endpoint_bindings.profiles.splice(1, 0, duplicateProfile)
    aliasedConnection.endpoint_bindings.phases.boundary_resolution = duplicateProfile.profile_id
    expect(() => parseDexAcquisitionRunManifest(aliasedConnection, fixtureJson)).toThrow(
      /cannot alias one connection/
    )

    const relabeledEndpoint = validManifest()
    const relabeledProfile = clone(relabeledEndpoint.endpoint_bindings.profiles[0])
    relabeledProfile.profile_id = 'bsc-discovery-relabeled'
    relabeledProfile.rate_plan_id = 'phase0-second-rate-plan'
    rehashEndpointProfile(relabeledProfile)
    relabeledEndpoint.endpoint_bindings.profiles.splice(1, 0, relabeledProfile)
    relabeledEndpoint.endpoint_bindings.phases.boundary_resolution = relabeledProfile.profile_id
    expect(() => parseDexAcquisitionRunManifest(relabeledEndpoint, fixtureJson)).toThrow(
      /cannot relabel one physical endpoint/
    )

    const bscGap = validManifest()
    bscGap.endpoint_bindings.phases.gap_evidence = 'bsc-evidence'
    expect(() => parseDexAcquisitionRunManifest(bscGap, fixtureJson)).toThrow(/BSC run manifest/)

    const noSolanaGap = validManifest('okx_web3_solana')
    noSolanaGap.endpoint_bindings.phases.gap_evidence = null
    noSolanaGap.endpoint_bindings.profiles = noSolanaGap.endpoint_bindings.profiles.filter(
      (profile) => profile.profile_id !== 'solana-gap'
    )
    expect(() => parseDexAcquisitionRunManifest(noSolanaGap, fixtureJson)).toThrow(
      /requires a separate gap-evidence/
    )

    const sameSolanaGap = validManifest('okx_web3_solana')
    sameSolanaGap.endpoint_bindings.phases.block_catalog = 'solana-gap'
    expect(() => parseDexAcquisitionRunManifest(sameSolanaGap, fixtureJson)).toThrow(
      /source-separated/
    )

    const splitAnchor = validManifest()
    const anchorProfile = endpointProfile({
      profile_id: 'bsc-finality-anchor',
      provider_id: 'publicnode',
      data_source_id: 'bsc-mainnet-rpc',
      endpoint_id: 'publicnode.bsc.finality-anchor',
      source_independence_group: 'publicnode-bsc-rpc',
      transport_kind: 'evm_json_rpc',
      auth_mode: 'none',
      rate_plan_id: 'phase0-rate-plan',
      pricing_plan_id: 'phase0-pricing-snapshot',
    })
    splitAnchor.endpoint_bindings.profiles.push(anchorProfile)
    splitAnchor.endpoint_bindings.profiles.sort((left, right) =>
      left.profile_id < right.profile_id ? -1 : left.profile_id > right.profile_id ? 1 : 0
    )
    splitAnchor.endpoint_bindings.phases.finality_anchor = anchorProfile.profile_id
    expect(() => parseDexAcquisitionRunManifest(splitAnchor, fixtureJson)).toThrow(
      /exact finality-anchor endpoint/
    )

    const wrongProtocolTransport = asProtocolRun(validManifest())
    wrongProtocolTransport.endpoint_bindings.profiles[0].transport_kind =
      'evm_provider_address_index'
    rehashEndpointProfile(wrongProtocolTransport.endpoint_bindings.profiles[0])
    expect(() => parseDexAcquisitionRunManifest(wrongProtocolTransport, fixtureJson)).toThrow(
      /discovery endpoint transport/
    )
  })

  it('binds acquisition mode, adapter, scope, lanes, finality, and policy SHA', () => {
    const wrongAdapter = validManifest()
    wrongAdapter.query_policy.adapter_id = 'solana_get_signatures_for_address_v1'
    expect(() => parseDexAcquisitionRunManifest(wrongAdapter, fixtureJson)).toThrow(
      /query policy conflicts/
    )

    const wrongTemplate = validManifest()
    wrongTemplate.query_policy.query_template_contract =
      DEX_ACQUISITION_QUERY_TEMPLATE_CONTRACT_BY_MODE.solana_rpc_signatures_for_address
    expect(() => parseDexAcquisitionRunManifest(wrongTemplate, fixtureJson)).toThrow(
      /query policy conflicts/
    )

    const wrongEvidenceFanout = validManifest()
    wrongEvidenceFanout.query_policy.candidate_evidence.rpc_request_upper_bound_per_candidate = 3
    expect(() => dexAcquisitionQueryPolicySha256(wrongEvidenceFanout.query_policy)).toThrow(
      /RPC fan-out conflicts/
    )

    const wrongScope = validManifest()
    wrongScope.query_policy.scope = {
      kind: 'protocol_manifest_event_scan',
      upstream_filter: 'all_manifest_deployments_and_events',
      evaluation: 'local_golden_50_match',
      population_denominator_eligible: false,
      population_recall_measured: false,
    }
    expect(() => parseDexAcquisitionRunManifest(wrongScope, fixtureJson)).toThrow(
      /query policy conflicts/
    )

    const sourceDrift = validManifest()
    sourceDrift.source.query_shape = 'batched_wallet_locator'
    expect(() => parseDexAcquisitionRunManifest(sourceDrift, fixtureJson)).toThrow(
      /source conflicts/
    )

    const hashDrift = validManifest()
    hashDrift.query_policy.budgets.concurrency = 3
    expect(() => parseDexAcquisitionRunManifest(hashDrift, fixtureJson)).toThrow(/policy SHA/)
  })

  it('requires chain-specific boundary and transaction-membership policies', () => {
    const wrongCandidateMethod = validManifest()
    wrongCandidateMethod.query_policy.candidate_evidence.verification_method =
      'solana_strict_rpc_signature_status_block_membership'
    wrongCandidateMethod.query_policy.candidate_evidence.rpc_request_upper_bound_per_candidate = 3
    wrongCandidateMethod.query_policy_sha256 = dexAcquisitionQueryPolicySha256(
      wrongCandidateMethod.query_policy
    )
    expect(() => parseDexAcquisitionRunManifest(wrongCandidateMethod, fixtureJson)).toThrow(
      /BSC strict candidate evidence/
    )

    const wrongMembership = validManifest('okx_web3_solana')
    wrongMembership.query_policy.candidate_evidence.transaction_membership_policy =
      'bsc_transaction_membership_v1'
    wrongMembership.query_policy_sha256 = dexAcquisitionQueryPolicySha256(
      wrongMembership.query_policy
    )
    expect(() => parseDexAcquisitionRunManifest(wrongMembership, fixtureJson)).toThrow(
      /membership policy/
    )

    const bscGapBudget = validManifest()
    bscGapBudget.query_policy.budgets.phases.gap_evidence = {
      max_request_attempts: 1,
      max_wire_bytes: 1,
      max_decoded_bytes: 1,
    }
    bscGapBudget.query_policy_sha256 = dexAcquisitionQueryPolicySha256(bscGapBudget.query_policy)
    expect(() => parseDexAcquisitionRunManifest(bscGapBudget, fixtureJson)).toThrow(
      /cannot budget skipped-slot gap evidence/
    )

    const missingSolanaGapBudget = validManifest('okx_web3_solana')
    missingSolanaGapBudget.query_policy.budgets.phases.gap_evidence = {
      max_request_attempts: 0,
      max_wire_bytes: 0,
      max_decoded_bytes: 0,
    }
    missingSolanaGapBudget.query_policy_sha256 = dexAcquisitionQueryPolicySha256(
      missingSolanaGapBudget.query_policy
    )
    expect(() => parseDexAcquisitionRunManifest(missingSolanaGapBudget, fixtureJson)).toThrow(
      /requires a positive gap-evidence budget/
    )

    const foreignBoundary = validManifest() as DexAcquisitionRunManifest & {
      window: DexAcquisitionRunManifest['window'] & { boundary_policy: string }
    }
    foreignBoundary.window.boundary_policy = 'solana_first_produced_slot_at_or_after_utc_v1'
    expect(() => parseDexAcquisitionRunManifest(foreignBoundary, fixtureJson)).toThrow()
  })

  it('requires protocol-wide scope and a conditional protocol manifest', () => {
    const missingManifest = asProtocolRun(validManifest())
    missingManifest.protocol_manifest = { state: 'not_applicable' }
    expect(() => parseDexAcquisitionRunManifest(missingManifest, fixtureJson)).toThrow(
      /exclusively bind/
    )

    const protocol = asProtocolRun(validManifest())
    expect(parseDexAcquisitionRunManifest(protocol, fixtureJson).query_policy.scope).toMatchObject({
      kind: 'protocol_manifest_event_scan',
      upstream_filter: 'all_manifest_deployments_and_events',
      evaluation: 'local_golden_50_match',
      population_denominator_eligible: false,
    })

    const unexpectedManifest = validManifest()
    unexpectedManifest.protocol_manifest = protocol.protocol_manifest
    expect(() => parseDexAcquisitionRunManifest(unexpectedManifest, fixtureJson)).toThrow(
      /exclusively bind/
    )

    const foreignChainManifest = asProtocolRun(validManifest('okx_web3_solana'))
    foreignChainManifest.protocol_manifest = {
      state: 'bound',
      contract_id: 'arena.dex.bsc-protocol-manifest@1',
      sha256: HASH.protocolManifest,
    }
    expect(() => parseDexAcquisitionRunManifest(foreignChainManifest, fixtureJson)).toThrow(
      /conflicts with the run chain/
    )
  })

  it('rejects evidence digest reuse across distinct domains', () => {
    const boundaryReuse = validManifest()
    boundaryReuse.window.height_range.end_boundary_evidence_sha256 =
      boundaryReuse.window.height_range.start_boundary_evidence_sha256
    expect(() => parseDexAcquisitionRunManifest(boundaryReuse, fixtureJson)).toThrow(
      /must not reuse/
    )

    const fixtureReuse = validManifest()
    fixtureReuse.query_policy.query_template_sha256 =
      fixtureReuse.golden_sample.parent_snapshot_sha256
    fixtureReuse.query_policy_sha256 = dexAcquisitionQueryPolicySha256(fixtureReuse.query_policy)
    expect(() => parseDexAcquisitionRunManifest(fixtureReuse, fixtureJson)).toThrow(
      /must not reuse/
    )

    const connectionReuse = validManifest()
    connectionReuse.endpoint_bindings.registry_sha256 =
      connectionReuse.endpoint_bindings.profiles[0].connection_descriptor_sha256
    expect(() => parseDexAcquisitionRunManifest(connectionReuse, fixtureJson)).toThrow(
      /must not reuse/
    )
  })

  it('keeps every execution, serving, ranking, and population claim closed', () => {
    for (const claim of Object.keys(validManifest().claims)) {
      const changed = validManifest()
      mutableRecord(changed.claims)[claim] = true
      expect(() => parseDexAcquisitionRunManifest(changed, fixtureJson)).toThrow()
    }
    for (const field of ['serving_authorized', 'rank_eligible', 'score_eligible'] as const) {
      const changed = validManifest()
      mutableRecord(changed)[field] = true
      expect(() => parseDexAcquisitionRunManifest(changed, fixtureJson)).toThrow()
    }
  })

  it('rejects invalid runtime revisions and unsafe budget ceilings', () => {
    const abbreviatedGit = validManifest()
    abbreviatedGit.runner_git_sha = 'abc1234'
    expect(() => parseDexAcquisitionRunManifest(abbreviatedGit, fixtureJson)).toThrow()

    const floatingNode = validManifest()
    floatingNode.runtime.node_version = 'v22'
    expect(() => parseDexAcquisitionRunManifest(floatingNode, fixtureJson)).toThrow()

    const zeroGit = validManifest()
    zeroGit.runner_git_sha = '0'.repeat(40)
    expect(() => parseDexAcquisitionRunManifest(zeroGit, fixtureJson)).toThrow(/nonzero/)

    const unsupportedNode = validManifest()
    unsupportedNode.runtime.node_version = 'v21.99.99'
    expect(() => parseDexAcquisitionRunManifest(unsupportedNode, fixtureJson)).toThrow(
      /Node.js 22 or newer/
    )

    const oldSqdNode = asSqdRun(validManifest())
    oldSqdNode.runtime.node_version = 'v22.14.9'
    expect(() => parseDexAcquisitionRunManifest(oldSqdNode, fixtureJson)).toThrow(
      /SQD Pipes acquisition requires Node.js 22.15.0/
    )

    const excessiveTimeout = validManifest()
    excessiveTimeout.query_policy.budgets.request_timeout_ms = 120_001
    expect(() => parseDexAcquisitionRunManifest(excessiveTimeout, fixtureJson)).toThrow()

    const excessiveAggregatePages = validManifest()
    excessiveAggregatePages.query_policy.budgets.max_pages_per_lane = 5001
    excessiveAggregatePages.query_policy.budgets.max_attempts_per_request = 1
    excessiveAggregatePages.query_policy.budgets.max_response_wire_bytes_per_page = 1
    excessiveAggregatePages.query_policy.budgets.max_response_decoded_bytes_per_page = 1
    excessiveAggregatePages.query_policy.budgets.phases.discovery = {
      max_request_attempts: 250_050,
      max_wire_bytes: 250_050,
      max_decoded_bytes: 250_050,
    }
    expect(() => dexAcquisitionQueryPolicySha256(excessiveAggregatePages.query_policy)).toThrow(
      /aggregate page budget/
    )

    const excessiveAggregateCandidates = validManifest()
    excessiveAggregateCandidates.query_policy.budgets.max_raw_candidates_per_lane = 2001
    expect(() =>
      dexAcquisitionQueryPolicySha256(excessiveAggregateCandidates.query_policy)
    ).toThrow(/aggregate raw-candidate budget/)

    const shallowDiscoveryBudget = validManifest()
    shallowDiscoveryBudget.query_policy.budgets.phases.discovery.max_request_attempts = 14_999
    expect(() => dexAcquisitionQueryPolicySha256(shallowDiscoveryBudget.query_policy)).toThrow(
      /discovery phase budget/
    )

    const shallowEvidenceBudget = validManifest()
    shallowEvidenceBudget.query_policy.budgets.max_raw_candidates_per_lane = 501
    shallowEvidenceBudget.query_policy.candidate_evidence.max_response_wire_bytes_per_rpc = 1
    shallowEvidenceBudget.query_policy.candidate_evidence.max_response_decoded_bytes_per_rpc = 1
    expect(() => dexAcquisitionQueryPolicySha256(shallowEvidenceBudget.query_policy)).toThrow(
      /transaction-evidence budget/
    )

    const shallowEvidenceWireBudget = validManifest()
    shallowEvidenceWireBudget.query_policy.budgets.phases.transaction_evidence.max_wire_bytes = 1
    expect(() => dexAcquisitionQueryPolicySha256(shallowEvidenceWireBudget.query_policy)).toThrow(
      /transaction-evidence budget/
    )

    const shallowEvidenceDecodedBudget = validManifest()
    shallowEvidenceDecodedBudget.query_policy.budgets.phases.transaction_evidence.max_decoded_bytes = 1
    expect(() =>
      dexAcquisitionQueryPolicySha256(shallowEvidenceDecodedBudget.query_policy)
    ).toThrow(/transaction-evidence budget/)

    const excessivePhaseRequests = validManifest()
    excessivePhaseRequests.query_policy.budgets.phases.block_catalog.max_request_attempts = 300_000
    expect(() => dexAcquisitionQueryPolicySha256(excessivePhaseRequests.query_policy)).toThrow(
      /aggregate run budget/
    )

    const excessivePhaseWireBytes = validManifest()
    excessivePhaseWireBytes.query_policy.budgets.phases.boundary_resolution.max_wire_bytes =
      40 * GIB
    expect(() => dexAcquisitionQueryPolicySha256(excessivePhaseWireBytes.query_policy)).toThrow(
      /aggregate run budget/
    )

    const excessivePhaseDecodedBytes = validManifest()
    excessivePhaseDecodedBytes.query_policy.budgets.phases.boundary_resolution.max_decoded_bytes =
      130 * GIB
    expect(() => dexAcquisitionQueryPolicySha256(excessivePhaseDecodedBytes.query_policy)).toThrow(
      /aggregate run budget/
    )

    const excessiveInFlightBytes = validManifest()
    excessiveInFlightBytes.query_policy.budgets.max_pages_per_lane = 1
    excessiveInFlightBytes.query_policy.budgets.max_attempts_per_request = 1
    excessiveInFlightBytes.query_policy.budgets.max_response_decoded_bytes_per_page =
      64 * 1024 * 1024
    excessiveInFlightBytes.query_policy.budgets.concurrency = 10
    excessiveInFlightBytes.query_policy.budgets.phases.discovery.max_decoded_bytes = 4 * GIB
    expect(() => dexAcquisitionQueryPolicySha256(excessiveInFlightBytes.query_policy)).toThrow(
      /aggregate run budget/
    )

    const nonCanonicalCost = validManifest()
    nonCanonicalCost.query_policy.budgets.billing.max_billed_usd = '1.0'
    expect(() => parseDexAcquisitionRunManifest(nonCanonicalCost, fixtureJson)).toThrow()

    const excessiveCost = validManifest()
    excessiveCost.query_policy.budgets.billing.max_billed_usd = '100.00000000000000000001'
    expect(() => parseDexAcquisitionRunManifest(excessiveCost, fixtureJson)).toThrow(
      /billed USD cap/
    )
  })
})
