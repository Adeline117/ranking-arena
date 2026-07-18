import manifestJson from '../fixtures/dex-solana-protocol-manifest.v1.json'
import {
  DEX_SOLANA_DECODER_REQUIRED_FACTS,
  DEX_SOLANA_PROTOCOL_REQUIRED_BLOCKERS,
  DEX_SOLANA_REQUIRED_KNOWN_GAPS,
  DEX_SOLANA_TARGET_PROTOCOL_IDS,
  DEX_SOLANA_TARGET_PROTOCOLS,
  dexSolanaProtocolManifestSha256,
  parseDexSolanaProtocolManifest,
} from '../lib/dex-solana-protocol-manifest'

const EXPECTED_ARTIFACTS = {
  'jupiter-v6-idl-cc068c9d': {
    protocol_id: 'jupiter_swap_v6',
    repository: 'https://github.com/jup-ag/jupiter-amm-implementation',
    git_commit: 'cc068c9d1df0060c62f9a8a4fc37ea13ea7b9b39',
    path: 'idls/jupiter_aggregator_v6.json',
    sha256: '100b41d7caad93818cf440e8ae97bde43e6dad1ca732de45762adf43013cf9d6',
    license: 'NOASSERTION',
    license_scope: 'none',
    license_evidence_sha256: null,
    legal_review_required: true,
  },
  'raydium-amm-v4-source-c613c87c': {
    protocol_id: 'raydium_amm_v4',
    repository: 'https://github.com/raydium-io/raydium-amm',
    git_commit: 'c613c87c41edbe21112c9b8341774a70009c6d7b',
    path: 'program/src/lib.rs',
    sha256: 'd0f63c766de4898d44043bb4bf69294b5dfdbc5081b284eeb6b40d43ebaa3756',
    license: 'Apache-2.0',
    license_scope: 'repository',
    license_evidence_sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
    legal_review_required: false,
  },
  'raydium-cpmm-source-78f254e1': {
    protocol_id: 'raydium_cpmm',
    repository: 'https://github.com/raydium-io/raydium-cp-swap',
    git_commit: '78f254e1023751e706df7dc15c453fc3e046697c',
    path: 'programs/cp-swap/src/lib.rs',
    sha256: 'b7d2985011d6e469e157d2771aa9d15cfb347c2229f9f7365091acabc12a6890',
    license: 'Apache-2.0',
    license_scope: 'repository',
    license_evidence_sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
    legal_review_required: false,
  },
  'raydium-clmm-source-03b44b7f': {
    protocol_id: 'raydium_clmm',
    repository: 'https://github.com/raydium-io/raydium-clmm',
    git_commit: '03b44b7ff41014b3fc715d445ee05f08d3815a99',
    path: 'programs/amm/src/lib.rs',
    sha256: '36d445de7b8a198b325fc38febc09817990270f93013a36e2ba7963246fc246a',
    license: 'Apache-2.0',
    license_scope: 'repository',
    license_evidence_sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
    legal_review_required: false,
  },
  'orca-whirlpool-source-bab9a1f3': {
    protocol_id: 'orca_whirlpool',
    repository: 'https://github.com/orca-so/whirlpools',
    git_commit: 'bab9a1f3e4a4021ca91d0d503132daf64e427486',
    path: 'programs/whirlpool/src/lib.rs',
    sha256: '1a9be028bb3d5c0699278dd3fe50aea4b20e91e975280fb69b7f2dcf14418ea0',
    license: 'LicenseRef-Orca-License',
    license_scope: 'repository',
    license_evidence_sha256: 'ab5facc90fe4f35f0dd07e2ed2ccce9c84b0d5019b782f74c6ce6356624fcffc',
    legal_review_required: true,
  },
  'meteora-dlmm-idl-4eaaeaa6': {
    protocol_id: 'meteora_dlmm',
    repository: 'https://github.com/MeteoraAg/dlmm-sdk',
    git_commit: '4eaaeaa6b832999db0ec4044cffe620658b4c8d9',
    path: 'ts-client/src/dlmm/idl/idl.json',
    sha256: '045c0f4af044be046b6a14b350077e4242e8ac026b64a855803dab30fcdd8b35',
    license: 'ISC',
    license_scope: 'package_subtree',
    license_evidence_sha256: 'c6c5854e5a13782e051985e391a798c7edd0fa730bc906763036ed3b9eb8b71f',
    legal_review_required: false,
  },
  'meteora-damm-v1-address-02c66a3c': {
    protocol_id: 'meteora_damm_v1',
    repository: 'https://github.com/MeteoraAg/dynamic-amm-sdk',
    git_commit: '02c66a3c13ebabdf71eb29d87996aaa7a06a7c29',
    path: 'ts-client/src/amm/constants.ts',
    sha256: '3e9f394977c3033ffc244dd5f977e51c2c408b42687a49fc0c9a75397eeb84ff',
    license: 'MIT',
    license_scope: 'package_subtree',
    license_evidence_sha256: '2cef3fcdbb58eb596b300d9b05ba192d19572e6c48c7b811dbc6c874d911e85e',
    legal_review_required: false,
  },
  'meteora-damm-v2-source-bdd8a1e3': {
    protocol_id: 'meteora_damm_v2',
    repository: 'https://github.com/MeteoraAg/damm-v2',
    git_commit: 'bdd8a1e355f484b3cff131578a662c560b97b72f',
    path: 'programs/cp-amm/src/lib.rs',
    sha256: '2eaf4cb4caa966c1c631ed143e635a48a8a4af2a4434978053f462bc4d6897d3',
    license: 'LicenseRef-Meteora-DAMM-v2-Noncommercial',
    license_scope: 'repository',
    license_evidence_sha256: 'f5fd01dfb4f78c449fbec7d1fccb3c428a05254c1799287735fba643147ea015',
    legal_review_required: true,
  },
  'meteora-dbc-source-3b540e94': {
    protocol_id: 'meteora_dbc',
    repository: 'https://github.com/MeteoraAg/dynamic-bonding-curve',
    git_commit: '3b540e94b5b20ba37733de6e25f58522a0cd8961',
    path: 'programs/dynamic-bonding-curve/src/lib.rs',
    sha256: '0e66a6c19ce87880bafd05cf9b4e10805e1a040a9b0e554067afaeb224df4f93',
    license: 'LicenseRef-Meteora-DBC-Noncommercial',
    license_scope: 'repository',
    license_evidence_sha256: '7c18b1ee4004d443bca671bd8ca63c39914add8e0b29a7b6d0d4244ac0701420',
    legal_review_required: true,
  },
} as const

describe('Solana protocol manifest fixture', () => {
  const manifest = parseDexSolanaProtocolManifest(manifestJson)

  it('seeds exactly the nine initial program lanes without making a coverage claim', () => {
    expect(manifest.protocols.map((protocol) => protocol.protocol_id).sort()).toEqual(
      [...DEX_SOLANA_TARGET_PROTOCOL_IDS].sort()
    )
    expect(manifest.artifacts).toHaveLength(9)
    expect(manifest.coverage).toEqual({
      selection_basis: 'curated_nine_program_seed_only',
      live_wallet_sample_profiled: false,
      program_hit_distribution_measured: false,
      instruction_share_measured: false,
      wallet_population_recall_measured: false,
      coverage_claim: 'none',
    })
    expect([...manifest.known_gaps].sort()).toEqual([...DEX_SOLANA_REQUIRED_KNOWN_GAPS].sort())
    expect(manifest.authorization).toEqual({
      execution: false,
      artifact_persistence: false,
      serving: false,
      rank: false,
      score: false,
    })
  })

  it('binds every protocol label and artifact locator to its exact program id', () => {
    for (const protocol of manifest.protocols) {
      const expected =
        DEX_SOLANA_TARGET_PROTOCOLS[
          protocol.protocol_id as keyof typeof DEX_SOLANA_TARGET_PROTOCOLS
        ]
      expect(protocol).toMatchObject(expected)
      expect(protocol.reference_artifact_ids).toHaveLength(1)
      const artifact = manifest.artifacts.find(
        (candidate) => candidate.artifact_id === protocol.program_address_artifact_id
      )!
      expect(artifact.declared_program_ids).toEqual([protocol.program_id])
      expect(artifact.evidence_roles).toContain('program_identity_reference')
      expect(artifact.program_identity_locator).not.toHaveLength(0)
    }
  })

  it('locks each official commit and raw-file hash while keeping integrity unverified', () => {
    expect(Object.keys(EXPECTED_ARTIFACTS).sort()).toEqual(
      manifest.artifacts.map((artifact) => artifact.artifact_id).sort()
    )
    for (const artifact of manifest.artifacts) {
      const expected = EXPECTED_ARTIFACTS[artifact.artifact_id as keyof typeof EXPECTED_ARTIFACTS]
      expect(artifact).toMatchObject({
        repository: expected.repository,
        git_commit: expected.git_commit,
        path: expected.path,
        declared_raw_file_sha256: expected.sha256,
        hash_basis: 'git_file_raw_bytes',
        integrity_state: 'declared_not_repository_verified',
        usage: 'reference_only',
        commercial_reuse_authorized: false,
        legal_review_required: expected.legal_review_required,
      })
      expect(artifact.license.identifier).toBe(expected.license)
      expect(artifact.license.scope).toBe(expected.license_scope)
      expect(artifact.license.declared_evidence_sha256).toBe(expected.license_evidence_sha256)
      expect(artifact.official_url).toBe(
        `${artifact.repository}/blob/${artifact.git_commit}/${artifact.path}`
      )
      const protocol = manifest.protocols.find(
        (candidate) => candidate.protocol_id === expected.protocol_id
      )!
      expect(protocol.reference_artifact_ids).toContain(artifact.artifact_id)
    }
  })

  it('keeps restricted and unknown licenses reference-only behind a legal gate', () => {
    const legalArtifacts = manifest.artifacts.filter((artifact) => artifact.legal_review_required)
    expect(legalArtifacts.map((artifact) => artifact.artifact_id).sort()).toEqual(
      [
        'jupiter-v6-idl-cc068c9d',
        'meteora-damm-v2-source-bdd8a1e3',
        'meteora-dbc-source-3b540e94',
        'orca-whirlpool-source-bab9a1f3',
      ].sort()
    )
    for (const artifact of legalArtifacts) {
      const protocol = manifest.protocols.find((candidate) =>
        candidate.reference_artifact_ids.includes(artifact.artifact_id)
      )!
      expect(protocol.blocking_reasons).toContain('commercial_decoder_legal_clearance_required')
      expect(artifact.commercial_reuse_authorized).toBe(false)
    }
  })

  it('keeps every chain, decoder, finality, and serving readiness field closed', () => {
    for (const protocol of manifest.protocols) {
      expect(protocol).toMatchObject({
        lifecycle_status: 'official_reference_candidate_unverified',
        verification_state: 'draft',
        loader_evidence: {
          state: 'not_verified',
          loader_kind: null,
          loader_program_id: null,
          observed_at: null,
          observation_sources: [],
        },
        code_epochs: [],
        decoder: {
          owner: null,
          implementation_state: 'not_started',
          golden_transactions_verified: false,
        },
        finality_policy: null,
      })
      for (const blocker of DEX_SOLANA_PROTOCOL_REQUIRED_BLOCKERS) {
        expect(protocol.blocking_reasons).toContain(blocker)
      }
      for (const fact of DEX_SOLANA_DECODER_REQUIRED_FACTS) {
        expect(protocol.decoder.required_fact_families).toContain(fact)
      }
      if (protocol.program_role === 'aggregator_router') {
        expect(protocol.blocking_reasons).toContain('inner_venue_program_coverage_unverified')
        expect(protocol.decoder.required_fact_families).toContain('aggregator_route_attribution')
      }
    }
  })

  it('has a deterministic canonical source-seed hash', () => {
    expect(dexSolanaProtocolManifestSha256(manifest)).toBe(
      '10e000a4b625c90da571374bdc3567e86ac01a632d1a7803da69018677d77f9a'
    )
  })
})
