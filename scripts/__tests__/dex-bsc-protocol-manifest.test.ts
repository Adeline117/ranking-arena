import {
  DEX_BSC_REQUIRED_KNOWN_GAPS,
  DEX_BSC_PROTOCOL_REQUIRED_BLOCKERS,
  dexBscProtocolManifestSha256,
  normalizeDexBscProtocolManifest,
  parseDexBscProtocolManifest,
  type DexBscProtocolManifest,
} from '../lib/dex-bsc-protocol-manifest'

const DEPLOYMENT_ARTIFACT_ID = 'pancake-v3-bsc-deployments'
const FACTORY_INTERFACE_ARTIFACT_ID = 'pancake-v3-factory-interface'
const POOL_EVENTS_ARTIFACT_ID = 'pancake-v3-pool-events'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function artifact(
  artifactId: string,
  artifactKind:
    | 'official_address_registry'
    | 'official_deployment_registry'
    | 'contract_source'
    | 'event_interface',
  path: string
): DexBscProtocolManifest['artifacts'][number] {
  const repository = 'https://github.com/pancakeswap/pancake-v3-contracts'
  const gitCommit = '0123456789abcdef0123456789abcdef01234567'
  return {
    artifact_id: artifactId,
    artifact_kind: artifactKind,
    official_url: `${repository}/blob/${gitCommit}/${path}`,
    repository,
    git_commit: gitCommit,
    path,
    declared_raw_file_sha256: 'a'.repeat(64),
    hash_basis: 'git_file_raw_bytes',
    integrity_state: 'declared_not_repository_verified',
    license:
      artifactKind === 'official_address_registry' ||
      artifactKind === 'official_deployment_registry'
        ? 'NOASSERTION'
        : 'GPL-2.0-or-later',
    license_scope:
      artifactKind === 'official_address_registry' ||
      artifactKind === 'official_deployment_registry'
        ? 'none'
        : 'file',
    usage: 'reference_only',
  }
}

function contract(
  contractId: string,
  role: 'factory' | 'pool_deployer' | 'router' | 'universal_router' | 'pool_manager' | 'vault',
  address: string,
  interfaceArtifactIds: string[]
): DexBscProtocolManifest['protocols'][number]['epochs'][number]['contracts'][number] {
  const eventRole = {
    factory: 'factory_discovery_root',
    pool_deployer: 'deployment_context',
    router: 'attribution_only',
    universal_router: 'attribution_only',
    pool_manager: 'singleton_trade_event_source',
    vault: 'settlement_context',
  } as const
  return {
    contract_id: contractId,
    role,
    address,
    event_role: eventRole[role],
    address_artifact_id: DEPLOYMENT_ARTIFACT_ID,
    address_evidence_locator: contractId,
    interface_artifact_ids: interfaceArtifactIds,
    onchain_verification: {
      state: 'not_verified',
      observed_at: null,
      finalized_block: null,
      creation_transaction_hash: null,
      runtime_code_keccak256: null,
    },
  }
}

function manifestFixture(): DexBscProtocolManifest {
  return {
    schema_version: 1,
    data_contract: 'arena.dex.bsc-protocol-manifest@1',
    purpose: 'phase0_bsc_protocol_discovery_seed_only',
    evidence_as_of: '2026-07-18T00:00:00.000Z',
    chain: {
      namespace: 'eip155',
      chain_id: 56,
      network: 'bsc-mainnet',
      source_slug: 'binance_web3_bsc',
    },
    coverage: {
      selection_basis: 'official_pancakeswap_seed_only',
      live_wallet_sample_profiled: false,
      non_pancakeswap_protocols_profiled: false,
      protocol_event_share_measured: false,
      wallet_population_recall_measured: false,
      coverage_claim: 'none',
    },
    artifacts: [
      artifact(
        DEPLOYMENT_ARTIFACT_ID,
        'official_deployment_registry',
        'deployments/bscMainnet.json'
      ),
      artifact(
        FACTORY_INTERFACE_ARTIFACT_ID,
        'event_interface',
        'projects/v3-core/contracts/interfaces/IPancakeV3Factory.sol'
      ),
      artifact(
        POOL_EVENTS_ARTIFACT_ID,
        'event_interface',
        'projects/v3-core/contracts/interfaces/pool/IPancakeV3PoolEvents.sol'
      ),
    ],
    protocols: [
      {
        protocol_id: 'pancakeswap_v3',
        family: 'pancakeswap',
        lifecycle_status: 'official_source_candidate_unverified',
        selection_basis: 'official_pancakeswap_seed_not_live_sample',
        upgrade_model: 'immutable_factory_dynamic_pools',
        verification_state: 'draft',
        blocking_reasons: [...DEX_BSC_PROTOCOL_REQUIRED_BLOCKERS, 'child_contract_set_incomplete'],
        epochs: [
          {
            epoch_id: 'official_source_snapshot',
            version_label: 'PancakeSwap V3',
            start_block: null,
            end_block: null,
            activation_state: 'unverified',
            contracts: [
              contract('factory', 'factory', '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865', [
                FACTORY_INTERFACE_ARTIFACT_ID,
              ]),
              contract(
                'pool_deployer',
                'pool_deployer',
                '0x41ff9aa7e16b8b1a8a8dc4f0efacd93d02d071c9',
                []
              ),
              contract('swap_router', 'router', '0x1b81d678ffb9c0263b24a97847620c99d213eb14', []),
            ],
            event_surface: {
              kind: 'factory_created_contracts',
              discovery_root_contract_id: 'factory',
              discovery_event: 'PoolCreated',
              child_contract_kind: 'pool',
              child_event_interface_artifact_id: POOL_EVENTS_ARTIFACT_ID,
              trade_event_emitter_scope: 'discovered_child_contracts',
              discovered_child_set_complete: false,
              child_start_blocks_verified: false,
            },
          },
        ],
        decoder: {
          owner: null,
          implementation_state: 'not_started',
          golden_transactions_verified: false,
          required_fact_families: [
            'failed_transaction_semantics',
            'fees',
            'native_bnb_cashflow',
            'router_user_attribution',
            'swap_fills',
            'token_cashflow',
          ],
        },
        finality_policy: null,
      },
    ],
    known_gaps: [
      ...DEX_BSC_REQUIRED_KNOWN_GAPS,
      'pancakeswap_v2_not_seeded',
      'pancakeswap_infinity_cl_not_seeded',
      'pancakeswap_infinity_bin_not_seeded',
    ],
    authorization: {
      execution: false,
      artifact_persistence: false,
      serving: false,
      rank: false,
      score: false,
    },
  }
}

describe('BSC protocol manifest contract', () => {
  it('accepts an official-source seed while every operational claim remains blocked', () => {
    const fixture = manifestFixture()

    expect(parseDexBscProtocolManifest(fixture)).toEqual(fixture)
    expect(fixture.coverage.coverage_claim).toBe('none')
    expect(Object.values(fixture.authorization)).toEqual([false, false, false, false, false])
    expect(fixture.protocols[0].epochs[0].start_block).toBeNull()
  })

  it('requires commit-pinned official artifact URLs and safe repository paths', () => {
    const unpinned = manifestFixture()
    unpinned.artifacts[0].official_url =
      'https://github.com/pancakeswap/pancake-v3-contracts/blob/main/deployments/bscMainnet.json'
    expect(() => parseDexBscProtocolManifest(unpinned)).toThrow(/not pinned/)

    const traversal = manifestFixture()
    traversal.artifacts[0].path = '../deployments/bscMainnet.json'
    expect(() => parseDexBscProtocolManifest(traversal)).toThrow(/safe repository-relative/)

    const fragment = manifestFixture()
    fragment.artifacts[0].path = 'deployments/bscMainnet.json#L1'
    expect(() => parseDexBscProtocolManifest(fragment)).toThrow(/safe repository-relative/)

    const foreignRepository = manifestFixture()
    foreignRepository.artifacts[0].repository = 'https://evil.example/pancake-v3-contracts'
    foreignRepository.artifacts[0].official_url =
      `${foreignRepository.artifacts[0].repository}/blob/` +
      `${foreignRepository.artifacts[0].git_commit}/${foreignRepository.artifacts[0].path}`
    expect(() => parseDexBscProtocolManifest(foreignRepository)).toThrow(/official Pancake/)

    const falseLicenseScope = manifestFixture()
    falseLicenseScope.artifacts[0].license_scope = 'file'
    expect(() => parseDexBscProtocolManifest(falseLicenseScope)).toThrow(/license scope/)
  })

  it('rejects zero or duplicate contract addresses and duplicate identities', () => {
    const zero = manifestFixture()
    zero.protocols[0].epochs[0].contracts[0].address = '0x0000000000000000000000000000000000000000'
    expect(() => parseDexBscProtocolManifest(zero)).toThrow(/zero contract/)

    const duplicateAddress = manifestFixture()
    duplicateAddress.protocols[0].epochs[0].contracts[1].address =
      duplicateAddress.protocols[0].epochs[0].contracts[0].address
    expect(() => parseDexBscProtocolManifest(duplicateAddress)).toThrow(
      /duplicate contract address/
    )

    const duplicateProtocol = manifestFixture()
    duplicateProtocol.protocols.push(clone(duplicateProtocol.protocols[0]))
    expect(() => parseDexBscProtocolManifest(duplicateProtocol)).toThrow(/duplicate protocol id/)

    const mixedCase = manifestFixture()
    mixedCase.protocols[0].epochs[0].contracts[0].address =
      '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'
    expect(() => parseDexBscProtocolManifest(mixedCase)).toThrow()
  })

  it('requires typed address and interface artifact references', () => {
    const missingAddressArtifact = manifestFixture()
    missingAddressArtifact.protocols[0].epochs[0].contracts[0].address_artifact_id = 'missing'
    expect(() => parseDexBscProtocolManifest(missingAddressArtifact)).toThrow(
      /invalid address artifact/
    )

    const wrongChildInterface = manifestFixture()
    wrongChildInterface.protocols[0].epochs[0].event_surface.child_event_interface_artifact_id =
      DEPLOYMENT_ARTIFACT_ID
    expect(() => parseDexBscProtocolManifest(wrongChildInterface)).toThrow(/child event interface/)
  })

  it('keeps event discovery topology consistent with roles and upgrade models', () => {
    const wrongRootRole = manifestFixture()
    wrongRootRole.protocols[0].epochs[0].contracts[0].role = 'pool_deployer'
    expect(() => parseDexBscProtocolManifest(wrongRootRole)).toThrow(/event role/)

    const wrongDiscoveryEvent = manifestFixture()
    wrongDiscoveryEvent.protocols[0].epochs[0].event_surface.discovery_event = 'PairCreated'
    expect(() => parseDexBscProtocolManifest(wrongDiscoveryEvent)).toThrow(
      /PoolCreated-discovered pool/
    )

    const extraDiscoveryRoot = manifestFixture()
    extraDiscoveryRoot.protocols[0].epochs[0].contracts[1].role = 'factory'
    extraDiscoveryRoot.protocols[0].epochs[0].contracts[1].event_role = 'factory_discovery_root'
    extraDiscoveryRoot.protocols[0].epochs[0].contracts[1].interface_artifact_ids = [
      FACTORY_INTERFACE_ARTIFACT_ID,
    ]
    expect(() => parseDexBscProtocolManifest(extraDiscoveryRoot)).toThrow(
      /exactly one discovery root/
    )

    const routerAsRoot = manifestFixture()
    routerAsRoot.protocols[0].epochs[0].event_surface.discovery_root_contract_id = 'swap_router'
    expect(() => parseDexBscProtocolManifest(routerAsRoot)).toThrow(/discovery-only factory root/)

    const mislabeledV2 = manifestFixture()
    mislabeledV2.protocols[0].protocol_id = 'pancakeswap_v2'
    mislabeledV2.known_gaps = mislabeledV2.known_gaps
      .filter((gap) => gap !== 'pancakeswap_v2_not_seeded')
      .concat('pancakeswap_v3_not_seeded')
    expect(() => parseDexBscProtocolManifest(mislabeledV2)).toThrow(/PairCreated-discovered pair/)
  })

  it('requires the complete fail-closed blocker set while allowing new typed risks', () => {
    const missing = manifestFixture()
    missing.protocols[0].blocking_reasons = missing.protocols[0].blocking_reasons.slice(1)
    expect(() => parseDexBscProtocolManifest(missing)).toThrow(/missing required blocker/)

    const duplicate = manifestFixture()
    duplicate.protocols[0].blocking_reasons.push(duplicate.protocols[0].blocking_reasons[0])
    expect(() => parseDexBscProtocolManifest(duplicate)).toThrow(/duplicate blocking reason/)

    const missingChildSet = manifestFixture()
    missingChildSet.protocols[0].blocking_reasons =
      missingChildSet.protocols[0].blocking_reasons.filter(
        (blocker) => blocker !== 'child_contract_set_incomplete'
      )
    expect(() => parseDexBscProtocolManifest(missingChildSet)).toThrow(/child-set blocker/)

    const extended = manifestFixture()
    extended.protocols[0].blocking_reasons.push('new_verified_risk_boundary')
    expect(() => parseDexBscProtocolManifest(extended)).not.toThrow()

    const invalid = clone(manifestFixture())
    Reflect.set(invalid.protocols[0], 'blocking_reasons', [
      ...invalid.protocols[0].blocking_reasons,
      'Untyped Blocker',
    ])
    expect(() => parseDexBscProtocolManifest(invalid)).toThrow()
  })

  it('models singleton managers as trade sources without treating routers or vaults as emitters', () => {
    const singleton = manifestFixture()
    const protocol = singleton.protocols[0]
    protocol.protocol_id = 'pancakeswap_infinity_cl'
    protocol.upgrade_model = 'singleton_managers_upgradeability_unverified'
    protocol.blocking_reasons = [
      ...DEX_BSC_PROTOCOL_REQUIRED_BLOCKERS,
      'manager_pool_registry_unverified',
      'hook_delta_semantics_unverified',
    ]
    protocol.epochs[0].contracts = [
      contract('cl_pool_manager', 'pool_manager', '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b', [
        FACTORY_INTERFACE_ARTIFACT_ID,
      ]),
      contract('vault', 'vault', '0x238a358808379702088667322f80ac48bad5e6c4', []),
      contract(
        'universal_router',
        'universal_router',
        '0xd9c500dff816a1da21a48a732d3498bf09dc9aeb',
        []
      ),
    ]
    protocol.epochs[0].event_surface = {
      kind: 'singleton_pool_manager',
      trade_event_source_contract_id: 'cl_pool_manager',
      initialization_event: 'Initialize',
      pool_identity_scope: 'manager_scoped_pool_id',
      initialization_registry_complete: false,
    }
    singleton.known_gaps = singleton.known_gaps
      .filter((gap) => gap !== 'pancakeswap_infinity_cl_not_seeded')
      .concat('pancakeswap_v3_not_seeded')

    expect(() => parseDexBscProtocolManifest(singleton)).not.toThrow()

    protocol.epochs[0].event_surface.trade_event_source_contract_id = 'universal_router'
    expect(() => parseDexBscProtocolManifest(singleton)).toThrow(/manager trade source/)
  })

  it('normalizes unordered arrays before hashing without mutating the manifest', () => {
    const fixture = manifestFixture()
    const shuffled = clone(fixture)
    shuffled.artifacts.reverse()
    shuffled.protocols[0].blocking_reasons.reverse()
    shuffled.protocols[0].epochs[0].contracts.reverse()
    shuffled.protocols[0].decoder.required_fact_families.reverse()
    shuffled.known_gaps.reverse()

    expect(dexBscProtocolManifestSha256(shuffled)).toBe(dexBscProtocolManifestSha256(fixture))
    expect(dexBscProtocolManifestSha256(fixture)).toBe(
      '3dd95040fb7d56fab91f3de5507870a883f780d34179f2d8efa8d1ea4b038db2'
    )
    expect(shuffled.artifacts[0].artifact_id).toBe(POOL_EVENTS_ARTIFACT_ID)
    expect(normalizeDexBscProtocolManifest(shuffled).artifacts[0].artifact_id).toBe(
      DEPLOYMENT_ARTIFACT_ID
    )

    const changed = clone(fixture)
    changed.protocols[0].epochs[0].version_label = 'PancakeSwap V3 changed'
    expect(dexBscProtocolManifestSha256(changed)).not.toBe(dexBscProtocolManifestSha256(fixture))
  })

  it('rejects noncanonical time, foreign chain identity, and implied authorization', () => {
    const badTimestamp = manifestFixture()
    badTimestamp.evidence_as_of = '2026-07-18'
    expect(() => parseDexBscProtocolManifest(badTimestamp)).toThrow(/evidence_as_of/)

    const foreignChain = clone(manifestFixture())
    Reflect.set(foreignChain.chain, 'chain_id', 1)
    expect(() => parseDexBscProtocolManifest(foreignChain)).toThrow()

    const authorized = clone(manifestFixture())
    Reflect.set(authorized.authorization, 'execution', true)
    expect(() => parseDexBscProtocolManifest(authorized)).toThrow()

    const hiddenGap = manifestFixture()
    hiddenGap.known_gaps = hiddenGap.known_gaps.filter(
      (gap) => gap !== 'non_pancakeswap_protocols_not_profiled'
    )
    expect(() => parseDexBscProtocolManifest(hiddenGap)).toThrow(/missing required known gap/)

    const contradictoryGap = manifestFixture()
    contradictoryGap.known_gaps.push('pancakeswap_v3_not_seeded')
    expect(() => parseDexBscProtocolManifest(contradictoryGap)).toThrow(/contradicts/)
  })
})
