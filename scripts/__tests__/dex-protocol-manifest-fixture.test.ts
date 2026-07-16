import manifestJson from '../fixtures/dex-protocol-manifest.v1.json'
import {
  assertDexDeploymentShadowReady,
  dexProtocolManifestSha256,
  parseDexProtocolManifest,
} from '../lib/dex-protocol-manifest'

const EXPECTED_GMX_ADDRESSES = {
  3637: {
    event_emitter: '0xAf2E131d483cedE068e21a9228aD91E623a989C2',
    data_store: '0xA23B81a89Ab9D7D89fF8fc1b5d8508fB75Cc094d',
    synthetics_reader: '0x922766ca6234cD49A483b5ee8D86cA3590D0Fb0E',
  },
  42161: {
    event_emitter: '0xC8ee91A54287DB53897056e12D9819156D3822Fb',
    data_store: '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8',
    synthetics_reader: '0x470fbC46bcC0f16532691Df360A07d8Bf5ee0789',
  },
  43114: {
    event_emitter: '0xDb17B211c34240B014ab6d61d4A31FA0C0e20c26',
    data_store: '0x2F0b22339414ADeD7D5F06f9D604c7fF5b2fe3f6',
    synthetics_reader: '0x62Cb8740E6986B29dC671B2EB596676f60590A5B',
  },
  4326: {
    event_emitter: '0xAf2E131d483cedE068e21a9228aD91E623a989C2',
    data_store: '0xE43C7B694f6b652a9F4A0f275C008d18758Dce35',
    synthetics_reader: '0x0f038EB4a38B08cd3c937a3256b51aa01904a684',
  },
} as const

const EXPECTED_GTRADE_ADDRESSES = {
  137: '0x209A9A01980377916851af2cA075C2b170452018',
  42161: '0xFF162c694eAA571f685030649814282eA457f169',
  8453: '0x6cD5aC19a07518A8092eEFfDA4f1174C72704eeb',
  33139: '0x2BE5D7058AdBa14Bc38E4A83E94A81f7491b0163',
  4326: '0x2D5B1ba6E2093a5b927Fe5bF8C049B107de31eaF',
} as const

describe('DEX protocol evidence fixture', () => {
  const manifest = parseDexProtocolManifest(manifestJson)

  it('pins four GMX and five gTrade EVM deployment identities', () => {
    expect(manifest.deployments).toHaveLength(9)
    expect(manifest.deployments.filter((deployment) => deployment.protocol === 'gmx')).toHaveLength(
      4
    )
    expect(
      manifest.deployments.filter((deployment) => deployment.protocol === 'gtrade')
    ).toHaveLength(5)
    expect(
      new Set(manifest.deployments.map((deployment) => deployment.chain.chain_id))
    ).not.toContain(999)
    expect(manifest.deployments.map((deployment) => deployment.chain.chain_id)).not.toContain(56)
  })

  it('matches pinned GMX contract-map evidence and lifecycle status', () => {
    for (const [chainIdText, expectedAddresses] of Object.entries(EXPECTED_GMX_ADDRESSES)) {
      const chainId = Number(chainIdText)
      const deployment = manifest.deployments.find(
        (candidate) => candidate.protocol === 'gmx' && candidate.chain.chain_id === chainId
      )
      expect(deployment).toBeDefined()
      const addresses = Object.fromEntries(
        deployment!.epochs[0].contracts.map((contract) => [contract.role, contract.address])
      )
      expect(addresses).toEqual(expectedAddresses)
      expect(deployment!.lifecycle_status).toBe(chainId === 3637 ? 'legacy' : 'active')
    }
  })

  it('matches pinned Gains diamond addresses while keeping ApeChain unverified', () => {
    for (const [chainIdText, expectedAddress] of Object.entries(EXPECTED_GTRADE_ADDRESSES)) {
      const chainId = Number(chainIdText)
      const deployment = manifest.deployments.find(
        (candidate) => candidate.protocol === 'gtrade' && candidate.chain.chain_id === chainId
      )
      expect(deployment).toBeDefined()
      expect(deployment!.epochs[0].contracts).toHaveLength(1)
      expect(deployment!.epochs[0].contracts[0]).toMatchObject({
        role: 'diamond',
        address: expectedAddress,
        event_source: true,
      })
      expect(deployment!.lifecycle_status).toBe(chainId === 33139 ? 'unverified' : 'active')
    }
  })

  it('keeps every deployment draft and fail-closed until chain evidence is complete', () => {
    for (const deployment of manifest.deployments) {
      expect(deployment.verification_state).toBe('draft')
      expect(deployment.blocking_reasons).toContain('start_block_unverified')
      expect(deployment.epochs.every((epoch) => epoch.start_block === null)).toBe(true)
      expect(deployment.decoder.owner).toBeNull()
      expect(deployment.finality_policy).toBeNull()
      expect(() => assertDexDeploymentShadowReady(manifest, deployment.deployment_id)).toThrow()
    }
  })

  it('pins official artifact hashes and enforces the GMX license boundary', () => {
    expect(
      Object.fromEntries(
        manifest.artifacts.map((artifact) => [artifact.artifact_id, artifact.content_sha256])
      )
    ).toEqual({
      'gains-addresses-aa7a05a4':
        '325ff862ab21af9e6cb8d1220df92f4a5cfe43d4da92e34a3360f4b148da1e5b',
      'gains-diamond-abi-aa7a05a4':
        'bd91559761d9a1e971fd339524d619b77c7481d3e1747874d98b6d789f1a06e0',
      'gmx-contracts-40f71d90': 'be70d19a9c9b3f822de060b1eef38c268a18658af0bf7759e3bfdbc2ee1ad9d3',
      'gmx-event-emitter-abi-40f71d90':
        '943f422f9b2a38796d14245201fe917f90fc161822b95811d838b66256de8e44',
    })
    for (const artifact of manifest.artifacts.filter((item) => item.license === 'BUSL-1.1')) {
      expect(artifact.usage).toBe('reference_only')
    }
  })

  it('records Hyperliquid as a non-EVM stream and does not complete BSC/Solana Phase 0', () => {
    expect(manifest.non_evm_exemptions).toEqual([
      expect.objectContaining({
        protocol: 'hyperliquid',
        acquisition_mode: 'hypercore_node_s3',
        synthetic_census_chain_id: 999,
      }),
    ])
    expect(manifest.purpose).toBe('deployment_evidence_only')
  })

  it('has a deterministic canonical evidence hash', () => {
    expect(dexProtocolManifestSha256(manifest)).toBe(
      '64a30a8b77c25353039c8041a5fca358909b3b496e15c56c26853c973f0724ba'
    )
  })
})
