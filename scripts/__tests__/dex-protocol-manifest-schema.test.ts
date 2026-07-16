import {
  assertDexDeploymentShadowReady,
  dexProtocolManifestSha256,
  normalizeDexProtocolManifest,
  parseDexProtocolManifest,
  type DexProtocolManifest,
} from '../lib/dex-protocol-manifest'

const ADDRESS_ARTIFACT_ID = 'gains-addresses'
const ABI_ARTIFACT_ID = 'gains-diamond-abi'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function manifestFixture(): DexProtocolManifest {
  return {
    schema_version: 1,
    evidence_as_of: '2026-07-16T00:00:00.000Z',
    purpose: 'deployment_evidence_only',
    artifacts: [
      {
        artifact_id: ADDRESS_ARTIFACT_ID,
        official_url:
          'https://github.com/example/protocol/blob/0123456789abcdef0123456789abcdef01234567/addresses.json',
        repository: 'https://github.com/example/protocol',
        git_commit: '0123456789abcdef0123456789abcdef01234567',
        path: 'addresses.json',
        content_sha256: 'a'.repeat(64),
        license: 'MIT',
        usage: 'reference_only',
      },
      {
        artifact_id: ABI_ARTIFACT_ID,
        official_url:
          'https://github.com/example/protocol/blob/0123456789abcdef0123456789abcdef01234567/Diamond.json',
        repository: 'https://github.com/example/protocol',
        git_commit: '0123456789abcdef0123456789abcdef01234567',
        path: 'Diamond.json',
        content_sha256: 'b'.repeat(64),
        license: 'MIT',
        usage: 'reference_only',
      },
    ],
    non_evm_exemptions: [
      {
        protocol: 'hyperliquid',
        acquisition_mode: 'hypercore_node_s3',
        synthetic_census_chain_id: 999,
        reason: 'Hyperliquid is not an EVM deployment.',
      },
    ],
    deployments: [
      {
        deployment_id: 'gtrade:eip155:42161',
        protocol: 'gtrade',
        chain: { namespace: 'eip155', chain_id: 42161, network: 'Arbitrum' },
        lifecycle_status: 'active',
        status_as_of: '2026-07-16T00:00:00.000Z',
        upgrade_model: 'diamond',
        verification_state: 'draft',
        blocking_reasons: ['start_block_unverified'],
        epochs: [
          {
            version_id: 'current',
            start_block: null,
            end_block: null,
            contracts: [
              {
                role: 'diamond',
                address: '0xFF162c694eAA571f685030649814282eA457f169',
                event_source: true,
                address_artifact_id: ADDRESS_ARTIFACT_ID,
                abi_artifact_id: ABI_ARTIFACT_ID,
              },
            ],
          },
        ],
        decoder: {
          owner: null,
          required_fact_families: ['position_lifecycle', 'fees'],
        },
        finality_policy: null,
        evidence: [
          {
            claim: 'Synthetic active deployment evidence.',
            official_url: 'https://docs.example.com/contracts',
          },
        ],
      },
    ],
  }
}

describe('DEX protocol manifest schema', () => {
  it('parses draft deployment evidence without authorizing shadow indexing', () => {
    const fixture = manifestFixture()

    expect(parseDexProtocolManifest(fixture)).toEqual(fixture)
    expect(() => assertDexDeploymentShadowReady(fixture, 'gtrade:eip155:42161')).toThrow(
      /not verified/
    )
  })

  it('allows shadow indexing only after every readiness field is verified', () => {
    const fixture = manifestFixture()
    const deployment = fixture.deployments[0]
    deployment.verification_state = 'verified'
    deployment.blocking_reasons = []
    deployment.epochs[0].start_block = 1
    deployment.decoder.owner = 'arena-dex-indexing'
    deployment.finality_policy = { confirmations: 64, reorg_lookback_blocks: 128 }

    expect(() => assertDexDeploymentShadowReady(fixture, 'gtrade:eip155:42161')).not.toThrow()
  })

  it('rejects BUSL artifacts that are marked for vendoring', () => {
    const fixture = manifestFixture()
    fixture.artifacts[0].license = 'BUSL-1.1'
    fixture.artifacts[0].usage = 'vendored'

    expect(() => parseDexProtocolManifest(fixture)).toThrow(/reference_only/)
  })

  it('rejects zero addresses and missing artifact references', () => {
    const zeroAddress = manifestFixture()
    zeroAddress.deployments[0].epochs[0].contracts[0].address =
      '0x0000000000000000000000000000000000000000'
    expect(() => parseDexProtocolManifest(zeroAddress)).toThrow(/zero contract address/)

    const missingArtifact = manifestFixture()
    missingArtifact.deployments[0].epochs[0].contracts[0].abi_artifact_id = 'missing'
    expect(() => parseDexProtocolManifest(missingArtifact)).toThrow(/missing ABI artifact/)
  })

  it('rejects duplicate identities and overlapping epochs', () => {
    const duplicate = manifestFixture()
    duplicate.deployments.push(clone(duplicate.deployments[0]))
    expect(() => parseDexProtocolManifest(duplicate)).toThrow(/duplicate deployment id/)

    const overlap = manifestFixture()
    overlap.deployments[0].epochs[0].start_block = 1
    overlap.deployments[0].epochs[0].end_block = 100
    overlap.deployments[0].epochs.push({
      ...clone(overlap.deployments[0].epochs[0]),
      version_id: 'next',
      start_block: 100,
      end_block: null,
    })
    expect(() => parseDexProtocolManifest(overlap)).toThrow(/overlapping epochs/)
  })

  it('requires protocol-specific roles and upgrade models', () => {
    const wrongModel = manifestFixture()
    wrongModel.deployments[0].upgrade_model = 'modular_contracts'
    expect(() => parseDexProtocolManifest(wrongModel)).toThrow(/upgrade model/)

    const missingRole = manifestFixture()
    missingRole.deployments[0].protocol = 'gmx'
    missingRole.deployments[0].deployment_id = 'gmx:eip155:42161'
    missingRole.deployments[0].upgrade_model = 'modular_contracts'
    expect(() => parseDexProtocolManifest(missingRole)).toThrow(/missing event_emitter/)
  })

  it('normalizes unordered arrays before hashing without mutating input', () => {
    const fixture = manifestFixture()
    fixture.deployments[0].blocking_reasons.push('decoder_owner_unassigned')
    fixture.deployments[0].decoder.required_fact_families.push('cashflow')
    const shuffled = clone(fixture)
    shuffled.artifacts.reverse()
    shuffled.deployments[0].blocking_reasons.reverse()
    shuffled.deployments[0].decoder.required_fact_families.reverse()

    expect(dexProtocolManifestSha256(fixture)).toBe(dexProtocolManifestSha256(shuffled))
    expect(dexProtocolManifestSha256(fixture)).toMatch(/^[0-9a-f]{64}$/)
    expect(shuffled.artifacts[0].artifact_id).toBe(ABI_ARTIFACT_ID)
    expect(normalizeDexProtocolManifest(shuffled).artifacts[0].artifact_id).toBe(
      ADDRESS_ARTIFACT_ID
    )
  })

  it('requires canonical timestamps and the Hyperliquid non-EVM exemption', () => {
    const badTimestamp = manifestFixture()
    badTimestamp.evidence_as_of = '2026-07-16'
    expect(() => parseDexProtocolManifest(badTimestamp)).toThrow(/evidence_as_of/)

    const noHyperliquidBoundary = manifestFixture()
    noHyperliquidBoundary.non_evm_exemptions = []
    expect(() => parseDexProtocolManifest(noHyperliquidBoundary)).toThrow(/Hyperliquid/)
  })
})
