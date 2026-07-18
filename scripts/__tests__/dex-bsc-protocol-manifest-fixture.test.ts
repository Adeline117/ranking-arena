import manifestJson from '../fixtures/dex-bsc-protocol-manifest.v1.json'
import {
  DEX_BSC_PROTOCOL_REQUIRED_BLOCKERS,
  DEX_BSC_REQUIRED_KNOWN_GAPS,
  DEX_BSC_TARGET_PROTOCOL_IDS,
  dexBscProtocolManifestSha256,
  parseDexBscProtocolManifest,
} from '../lib/dex-bsc-protocol-manifest'

const EXPECTED_ARTIFACT_HASHES = {
  'pancake-infinity-bin-interface-7c04695f':
    'cd1d173cfebea734f0a9badf9762c7706f36d3c04e2ca991ba02d9cb1d85575b',
  'pancake-infinity-cl-interface-7c04695f':
    'd2a488219dd1f4c6ce12bcb7234f692cb658384a61859a3b52ebb3a125edb2c5',
  'pancake-infinity-core-deployments-7c04695f':
    '81da53698252c25fce50bf0267a4230ff4420ccfdf0c9a9167caf0bdae179209',
  'pancake-infinity-router-deployments-8b03511e':
    '6a8fa0ce9853b2dcce764b20e044db57d990669c78a30cbf928ad34eb60c644c',
  'pancake-v2-addresses-81521fc1':
    'cf84d8c2a0aac50300f7fb18118b5159a3206244714125e8a75d8c2f6248408f',
  'pancake-v2-factory-cb079908': '72e35f8e71c199fe27b6fb1f9723f4adf74f5355e94a0a580b0b1b57d6504784',
  'pancake-v2-pair-cb079908': '2cbba91a92213c2ab84cae383be85e2b864c696abc8bb70aba9190732b584b1e',
  'pancake-v3-deployments-98684794':
    'cd72575c75643cc55e500963b2a94451e64166a84ce15a57412ce9737d48ad05',
  'pancake-v3-factory-interface-98684794':
    '390685b7ff3fe9d4a0895fc9a420402dd0ce01adb6dc7137c022d68c65a66bdd',
  'pancake-v3-pool-events-98684794':
    'c9979f9c2678921e77f3cc4484c24438267c2aa0c289c4199a59455899d56930',
} as const

const EXPECTED_CONTRACT_ADDRESSES = {
  pancakeswap_v2: {
    factory: '0xca143ce32fe78f1f7019d7d551a6402fc5350c73',
    router: '0x10ed43c718714eb63d5aa57b78b54704e256024e',
  },
  pancakeswap_v3: {
    factory: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
    pool_deployer: '0x41ff9aa7e16b8b1a8a8dc4f0efacd93d02d071c9',
    swap_router: '0x1b81d678ffb9c0263b24a97847620c99d213eb14',
  },
  pancakeswap_infinity_cl: {
    cl_pool_manager: '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b',
    universal_router: '0xd9c500dff816a1da21a48a732d3498bf09dc9aeb',
    vault: '0x238a358808379702088667322f80ac48bad5e6c4',
  },
  pancakeswap_infinity_bin: {
    bin_pool_manager: '0xc697d2898e0d09264376196696c51d7abbbaa4a9',
    universal_router: '0xd9c500dff816a1da21a48a732d3498bf09dc9aeb',
    vault: '0x238a358808379702088667322f80ac48bad5e6c4',
  },
} as const

describe('BSC protocol manifest fixture', () => {
  const manifest = parseDexBscProtocolManifest(manifestJson)

  it('seeds exactly the four initial Pancake protocol lanes without a coverage claim', () => {
    expect(manifest.protocols.map((protocol) => protocol.protocol_id).sort()).toEqual(
      [...DEX_BSC_TARGET_PROTOCOL_IDS].sort()
    )
    expect(manifest.coverage).toEqual({
      selection_basis: 'official_pancakeswap_seed_only',
      live_wallet_sample_profiled: false,
      non_pancakeswap_protocols_profiled: false,
      protocol_event_share_measured: false,
      wallet_population_recall_measured: false,
      coverage_claim: 'none',
    })
    expect([...manifest.known_gaps].sort()).toEqual([...DEX_BSC_REQUIRED_KNOWN_GAPS].sort())
    expect(manifest.authorization).toEqual({
      execution: false,
      artifact_persistence: false,
      serving: false,
      rank: false,
      score: false,
    })
  })

  it('pins the expected lowercase contract identities and keeps routers attribution-only', () => {
    for (const protocol of manifest.protocols) {
      const expected =
        EXPECTED_CONTRACT_ADDRESSES[
          protocol.protocol_id as keyof typeof EXPECTED_CONTRACT_ADDRESSES
        ]
      const contracts = Object.fromEntries(
        protocol.epochs[0].contracts.map((contract) => [contract.contract_id, contract.address])
      )
      expect(contracts).toEqual(expected)
      for (const contract of protocol.epochs[0].contracts) {
        expect(contract.address).toBe(contract.address.toLowerCase())
        if (contract.role === 'router' || contract.role === 'universal_router') {
          expect(contract.event_role).toBe('attribution_only')
        }
        if (contract.role === 'vault') {
          expect(contract.event_role).toBe('settlement_context')
        }
      }
    }
  })

  it('separates factory discovery roots from child trade emitters and singleton managers', () => {
    const v2 = manifest.protocols.find((protocol) => protocol.protocol_id === 'pancakeswap_v2')!
    const v3 = manifest.protocols.find((protocol) => protocol.protocol_id === 'pancakeswap_v3')!
    const infinity = manifest.protocols.filter((protocol) =>
      protocol.protocol_id.startsWith('pancakeswap_infinity_')
    )

    expect(v2.epochs[0].event_surface).toEqual(
      expect.objectContaining({
        kind: 'factory_created_contracts',
        discovery_event: 'PairCreated',
        child_contract_kind: 'pair',
        trade_event_emitter_scope: 'discovered_child_contracts',
        discovered_child_set_complete: false,
      })
    )
    expect(v3.epochs[0].event_surface).toEqual(
      expect.objectContaining({
        kind: 'factory_created_contracts',
        discovery_event: 'PoolCreated',
        child_contract_kind: 'pool',
        trade_event_emitter_scope: 'discovered_child_contracts',
        discovered_child_set_complete: false,
      })
    )
    for (const protocol of infinity) {
      expect(protocol.epochs[0].event_surface).toEqual(
        expect.objectContaining({
          kind: 'singleton_pool_manager',
          pool_identity_scope: 'manager_scoped_pool_id',
          initialization_registry_complete: false,
        })
      )
      expect(
        protocol.epochs[0].contracts.filter(
          (contract) => contract.event_role === 'singleton_trade_event_source'
        )
      ).toHaveLength(1)
    }
  })

  it('locks official commit/file hash declarations while keeping integrity unverified', () => {
    expect(
      Object.fromEntries(
        manifest.artifacts.map((artifact) => [
          artifact.artifact_id,
          artifact.declared_raw_file_sha256,
        ])
      )
    ).toEqual(EXPECTED_ARTIFACT_HASHES)
    for (const artifact of manifest.artifacts) {
      expect(artifact.git_commit).toMatch(/^[0-9a-f]{40}$/)
      expect(artifact.declared_raw_file_sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(artifact.hash_basis).toBe('git_file_raw_bytes')
      expect(artifact.integrity_state).toBe('declared_not_repository_verified')
      expect(artifact.usage).toBe('reference_only')
    }
    expect(
      manifest.artifacts.find(
        (artifact) => artifact.artifact_id === 'pancake-v3-deployments-98684794'
      )
    ).toMatchObject({ license: 'NOASSERTION', license_scope: 'none' })
    expect(
      manifest.artifacts.find(
        (artifact) => artifact.artifact_id === 'pancake-infinity-cl-interface-7c04695f'
      )
    ).toMatchObject({ license: 'MIT', license_scope: 'file' })
  })

  it('keeps every source seed draft and every live-chain readiness field empty', () => {
    for (const protocol of manifest.protocols) {
      expect(protocol.verification_state).toBe('draft')
      expect(protocol.lifecycle_status).toBe('official_source_candidate_unverified')
      expect(protocol.decoder).toMatchObject({
        owner: null,
        implementation_state: 'not_started',
        golden_transactions_verified: false,
      })
      expect(protocol.finality_policy).toBeNull()
      for (const blocker of DEX_BSC_PROTOCOL_REQUIRED_BLOCKERS) {
        expect(protocol.blocking_reasons).toContain(blocker)
      }
      for (const epoch of protocol.epochs) {
        expect(epoch).toMatchObject({
          start_block: null,
          end_block: null,
          activation_state: 'unverified',
        })
        for (const contract of epoch.contracts) {
          expect(contract.onchain_verification).toEqual({
            state: 'not_verified',
            observed_at: null,
            finalized_block: null,
            creation_transaction_hash: null,
            runtime_code_keccak256: null,
          })
        }
      }
    }
  })

  it('has a deterministic canonical seed hash', () => {
    expect(dexBscProtocolManifestSha256(manifest)).toBe(
      '4f31653cf0bbf4d6f8efc7f389987a6139331d94f9885878fb4d150b77a120cf'
    )
  })
})
