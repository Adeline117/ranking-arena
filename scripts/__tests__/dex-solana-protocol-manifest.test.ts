import {
  DEX_SOLANA_DECODER_REQUIRED_FACTS,
  DEX_SOLANA_PROTOCOL_REQUIRED_BLOCKERS,
  DEX_SOLANA_REQUIRED_KNOWN_GAPS,
  DEX_SOLANA_TARGET_PROTOCOL_IDS,
  DEX_SOLANA_TARGET_PROTOCOLS,
  SOLANA_BPF_LOADER_V1,
  SOLANA_BPF_LOADER_V2,
  SOLANA_BPF_LOADER_V3,
  SOLANA_LOADER_V4,
  dexSolanaProtocolManifestSha256,
  findSolanaV3ProgramDataAddress,
  normalizeDexSolanaProtocolManifest,
  parseDexSolanaProtocolManifest,
  type DexSolanaProtocol,
  type DexSolanaProtocolManifest,
} from '../lib/dex-solana-protocol-manifest'

const ARTIFACT_ID = 'raydium-amm-v4-source'
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const HASH_C = 'c'.repeat(64)
const HASH_D = 'd'.repeat(64)
const HASH_E = 'e'.repeat(64)
const RAYDIUM_AMM_V4 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function observationSources(): Extract<
  DexSolanaProtocol['loader_evidence'],
  { state: 'provisional_observed' }
>['observation_sources'] {
  return [
    {
      provider_id: 'rpc-a',
      endpoint_fingerprint_sha256: HASH_A,
      response_sha256: HASH_B,
      response_hash_basis: 'json_rpc_response_raw_bytes',
      canonical_decoded_observation_sha256: HASH_E,
      decoded_hash_basis: 'strict_canonical_decoded_program_observation',
      commitment: 'finalized',
      observed_finalized_slot: '1002',
    },
    {
      provider_id: 'rpc-b',
      endpoint_fingerprint_sha256: HASH_C,
      response_sha256: HASH_D,
      response_hash_basis: 'json_rpc_response_raw_bytes',
      canonical_decoded_observation_sha256: HASH_E,
      decoded_hash_basis: 'strict_canonical_decoded_program_observation',
      commitment: 'finalized',
      observed_finalized_slot: '1003',
    },
  ]
}

function manifestFixture(): DexSolanaProtocolManifest {
  return {
    schema_version: 1,
    data_contract: 'arena.dex.solana-protocol-manifest@1',
    purpose: 'phase0_solana_protocol_discovery_seed_only',
    evidence_as_of: '2026-07-18T00:00:00.000Z',
    chain: {
      namespace: 'solana',
      network: 'mainnet-beta',
      source_slug: 'solana_mainnet',
    },
    coverage: {
      selection_basis: 'curated_nine_program_seed_only',
      live_wallet_sample_profiled: false,
      program_hit_distribution_measured: false,
      instruction_share_measured: false,
      wallet_population_recall_measured: false,
      coverage_claim: 'none',
    },
    artifacts: [
      {
        artifact_id: ARTIFACT_ID,
        artifact_kind: 'program_source',
        evidence_roles: ['program_identity_reference', 'source_candidate'],
        declared_program_ids: [RAYDIUM_AMM_V4],
        program_identity_locator: 'declare_id! in program/src/lib.rs',
        official_url:
          'https://github.com/raydium-io/raydium-amm/blob/' +
          'c613c87c41edbe21112c9b8341774a70009c6d7b/program/src/lib.rs',
        repository: 'https://github.com/raydium-io/raydium-amm',
        git_commit: 'c613c87c41edbe21112c9b8341774a70009c6d7b',
        path: 'program/src/lib.rs',
        declared_raw_file_sha256:
          'd0f63c766de4898d44043bb4bf69294b5dfdbc5081b284eeb6b40d43ebaa3756',
        hash_basis: 'git_file_raw_bytes',
        integrity_state: 'declared_not_repository_verified',
        license: {
          state: 'declared',
          identifier: 'Apache-2.0',
          terms_class: 'osi_approved',
          scope: 'repository',
          scope_root: null,
          evidence_path: 'LICENSE',
          declared_evidence_sha256:
            'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
          evidence_integrity_state: 'declared_not_repository_verified',
        },
        usage: 'reference_only',
        commercial_reuse_authorized: false,
        legal_review_required: false,
      },
    ],
    protocols: [
      {
        protocol_id: 'raydium_amm_v4',
        family: 'raydium',
        product: 'amm_v4',
        program_role: 'liquidity_venue',
        program_id: RAYDIUM_AMM_V4,
        lifecycle_status: 'official_reference_candidate_unverified',
        selection_basis: 'curated_official_program_seed_not_live_sample',
        verification_state: 'draft',
        reference_artifact_ids: [ARTIFACT_ID],
        program_address_artifact_id: ARTIFACT_ID,
        blocking_reasons: [...DEX_SOLANA_PROTOCOL_REQUIRED_BLOCKERS],
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
          required_fact_families: [...DEX_SOLANA_DECODER_REQUIRED_FACTS],
        },
        finality_policy: null,
      },
    ],
    known_gaps: [
      ...DEX_SOLANA_REQUIRED_KNOWN_GAPS,
      ...DEX_SOLANA_TARGET_PROTOCOL_IDS.filter((protocolId) => protocolId !== 'raydium_amm_v4').map(
        (protocolId) => `${protocolId}_not_seeded`
      ),
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

function setLoaderEvidence(
  manifest: DexSolanaProtocolManifest,
  evidence: DexSolanaProtocol['loader_evidence']
): void {
  manifest.protocols[0].loader_evidence = evidence
}

function retargetProtocol(
  manifest: DexSolanaProtocolManifest,
  protocolId: keyof typeof DEX_SOLANA_TARGET_PROTOCOLS
): void {
  const protocol = manifest.protocols[0]
  const previousId = protocol.protocol_id
  const target = DEX_SOLANA_TARGET_PROTOCOLS[protocolId]
  protocol.protocol_id = protocolId
  protocol.family = target.family
  protocol.product = target.product
  protocol.program_role = target.program_role
  protocol.program_id = target.program_id
  manifest.known_gaps = manifest.known_gaps
    .filter((gap) => gap !== `${protocolId}_not_seeded`)
    .concat(`${previousId}_not_seeded`)
}

describe('Solana protocol manifest contract', () => {
  it('accepts a curated source seed only while every execution and coverage claim is blocked', () => {
    const fixture = manifestFixture()

    expect(parseDexSolanaProtocolManifest(fixture)).toEqual(fixture)
    expect(fixture.coverage.coverage_claim).toBe('none')
    expect(Object.values(fixture.authorization)).toEqual([false, false, false, false, false])
    expect(fixture.protocols[0].loader_evidence.state).toBe('not_verified')
    expect(fixture.protocols[0].code_epochs).toEqual([])
  })

  it('requires pinned allowlisted artifacts and does not promote raw hashes to verified integrity', () => {
    const unpinned = manifestFixture()
    unpinned.artifacts[0].official_url =
      'https://github.com/raydium-io/raydium-amm/blob/main/program/src/lib.rs'
    expect(() => parseDexSolanaProtocolManifest(unpinned)).toThrow(/not pinned/)

    const foreign = manifestFixture()
    foreign.artifacts[0].repository = 'https://evil.example/raydium-amm'
    foreign.artifacts[0].official_url =
      `${foreign.artifacts[0].repository}/blob/${foreign.artifacts[0].git_commit}/` +
      foreign.artifacts[0].path
    expect(() => parseDexSolanaProtocolManifest(foreign)).toThrow(/allowlisted/)

    const traversal = manifestFixture()
    traversal.artifacts[0].path = '../program/src/lib.rs'
    expect(() => parseDexSolanaProtocolManifest(traversal)).toThrow(/repository-relative/)

    const overstated = clone(manifestFixture())
    Reflect.set(overstated.artifacts[0], 'integrity_state', 'verified')
    expect(() => parseDexSolanaProtocolManifest(overstated)).toThrow()
  })

  it('binds every protocol label to the exact canonical program id and topology', () => {
    const mislabeled = manifestFixture()
    mislabeled.protocols[0].protocol_id = 'raydium_cpmm'
    mislabeled.known_gaps = mislabeled.known_gaps
      .filter((gap) => gap !== 'raydium_cpmm_not_seeded')
      .concat('raydium_amm_v4_not_seeded')
    expect(() => parseDexSolanaProtocolManifest(mislabeled)).toThrow(/target program map/)

    const whitespace = manifestFixture()
    whitespace.protocols[0].program_id = `${RAYDIUM_AMM_V4} `
    expect(() => parseDexSolanaProtocolManifest(whitespace)).toThrow(/canonical 32-byte base58/)

    const loaderAsTarget = manifestFixture()
    loaderAsTarget.protocols[0].program_id = SOLANA_BPF_LOADER_V3
    expect(() => parseDexSolanaProtocolManifest(loaderAsTarget)).toThrow()

    const wrongIdentityArtifact = manifestFixture()
    wrongIdentityArtifact.artifacts[0].evidence_roles = ['source_candidate']
    expect(() => parseDexSolanaProtocolManifest(wrongIdentityArtifact)).toThrow(
      /identity reference/
    )

    const borrowedArtifact = manifestFixture()
    retargetProtocol(borrowedArtifact, 'orca_whirlpool')
    expect(() => parseDexSolanaProtocolManifest(borrowedArtifact)).toThrow(
      /repository does not belong/
    )

    const fabricatedRepositoryIdentity = manifestFixture()
    fabricatedRepositoryIdentity.artifacts[0].declared_program_ids = [
      DEX_SOLANA_TARGET_PROTOCOLS.orca_whirlpool.program_id,
    ]
    expect(() => parseDexSolanaProtocolManifest(fabricatedRepositoryIdentity)).toThrow(
      /not owned by artifact repository/
    )

    const sameRepositoryWrongProduct = manifestFixture()
    retargetProtocol(sameRepositoryWrongProduct, 'raydium_cpmm')
    const cpmmSource = sameRepositoryWrongProduct.artifacts[0]
    cpmmSource.repository = 'https://github.com/raydium-io/raydium-cp-swap'
    cpmmSource.git_commit = '78f254e1023751e706df7dc15c453fc3e046697c'
    cpmmSource.path = 'programs/cp-swap/src/lib.rs'
    cpmmSource.official_url = `${cpmmSource.repository}/blob/${cpmmSource.git_commit}/${cpmmSource.path}`
    cpmmSource.declared_program_ids = [DEX_SOLANA_TARGET_PROTOCOLS.raydium_cpmm.program_id]
    cpmmSource.declared_raw_file_sha256 =
      'b7d2985011d6e469e157d2771aa9d15cfb347c2229f9f7365091acabc12a6890'

    const clmmIdl = clone(cpmmSource)
    clmmIdl.artifact_id = 'raydium-clmm-idl'
    clmmIdl.artifact_kind = 'program_idl'
    clmmIdl.evidence_roles = ['decoder_reference', 'program_identity_reference']
    clmmIdl.repository = 'https://github.com/raydium-io/raydium-idl'
    clmmIdl.git_commit = 'e7e0c96fe77bcf6a020b84a44c47a722aac8e359'
    clmmIdl.path = 'raydium_clmm/raydium_clmm.json'
    clmmIdl.official_url = `${clmmIdl.repository}/blob/${clmmIdl.git_commit}/${clmmIdl.path}`
    clmmIdl.declared_program_ids = [DEX_SOLANA_TARGET_PROTOCOLS.raydium_clmm.program_id]
    clmmIdl.declared_raw_file_sha256 =
      '040a8c4866317fa028be8a81db54325ce6d9b92aeb10582d89992855bbbce5c1'
    clmmIdl.license = {
      state: 'unasserted',
      identifier: 'NOASSERTION',
      terms_class: 'unknown',
      scope: 'none',
      scope_root: null,
      evidence_path: null,
      declared_evidence_sha256: null,
      evidence_integrity_state: 'not_available',
    }
    clmmIdl.legal_review_required = true
    sameRepositoryWrongProduct.artifacts.push(clmmIdl)
    sameRepositoryWrongProduct.protocols[0].reference_artifact_ids.push(clmmIdl.artifact_id)
    sameRepositoryWrongProduct.protocols[0].blocking_reasons.push(
      'commercial_decoder_legal_clearance_required'
    )
    expect(() => parseDexSolanaProtocolManifest(sameRepositoryWrongProduct)).toThrow(
      /does not declare the target program id/
    )
  })

  it('requires the complete decoder fact and blocker contracts', () => {
    const missingBlocker = manifestFixture()
    missingBlocker.protocols[0].blocking_reasons =
      missingBlocker.protocols[0].blocking_reasons.slice(1)
    expect(() => parseDexSolanaProtocolManifest(missingBlocker)).toThrow(/missing required blocker/)

    const missingFact = manifestFixture()
    missingFact.protocols[0].decoder.required_fact_families =
      missingFact.protocols[0].decoder.required_fact_families.slice(1)
    expect(() => parseDexSolanaProtocolManifest(missingFact)).toThrow(
      /decoder fact contract is incomplete/
    )

    const duplicate = manifestFixture()
    duplicate.protocols[0].blocking_reasons.push(duplicate.protocols[0].blocking_reasons[0])
    expect(() => parseDexSolanaProtocolManifest(duplicate)).toThrow(/duplicate blocking reason/)
  })

  it('keeps unknown and restricted licenses fail closed with precise package scope', () => {
    const unknown = manifestFixture()
    unknown.artifacts[0].artifact_kind = 'program_idl'
    unknown.artifacts[0].evidence_roles = ['decoder_reference', 'program_identity_reference']
    unknown.artifacts[0].license = {
      state: 'unasserted',
      identifier: 'NOASSERTION',
      terms_class: 'unknown',
      scope: 'none',
      scope_root: null,
      evidence_path: null,
      declared_evidence_sha256: null,
      evidence_integrity_state: 'not_available',
    }
    unknown.artifacts[0].legal_review_required = true
    expect(() => parseDexSolanaProtocolManifest(unknown)).toThrow(/clearance blocker/)

    unknown.protocols[0].blocking_reasons.push('commercial_decoder_legal_clearance_required')
    expect(() => parseDexSolanaProtocolManifest(unknown)).not.toThrow()

    const disguisedRestricted = manifestFixture()
    retargetProtocol(disguisedRestricted, 'orca_whirlpool')
    const restrictedArtifact = disguisedRestricted.artifacts[0]
    restrictedArtifact.repository = 'https://github.com/orca-so/whirlpools'
    restrictedArtifact.git_commit = 'bab9a1f3e4a4021ca91d0d503132daf64e427486'
    restrictedArtifact.path = 'programs/whirlpool/src/lib.rs'
    restrictedArtifact.official_url =
      `${restrictedArtifact.repository}/blob/${restrictedArtifact.git_commit}/` +
      restrictedArtifact.path
    restrictedArtifact.declared_program_ids = [
      DEX_SOLANA_TARGET_PROTOCOLS.orca_whirlpool.program_id,
    ]
    restrictedArtifact.program_identity_locator = 'declare_id! in Whirlpool source'
    expect(() => parseDexSolanaProtocolManifest(disguisedRestricted)).toThrow(
      /pinned repository policy/
    )

    const packageScoped = manifestFixture()
    retargetProtocol(packageScoped, 'meteora_dlmm')
    packageScoped.artifacts[0].artifact_kind = 'program_idl'
    packageScoped.artifacts[0].evidence_roles = ['decoder_reference', 'program_identity_reference']
    packageScoped.artifacts[0].repository = 'https://github.com/MeteoraAg/dlmm-sdk'
    packageScoped.artifacts[0].git_commit = '4eaaeaa6b832999db0ec4044cffe620658b4c8d9'
    packageScoped.artifacts[0].path = 'ts-client/src/dlmm/idl/idl.json'
    packageScoped.artifacts[0].official_url =
      `${packageScoped.artifacts[0].repository}/blob/` +
      `${packageScoped.artifacts[0].git_commit}/${packageScoped.artifacts[0].path}`
    packageScoped.artifacts[0].declared_program_ids = [
      DEX_SOLANA_TARGET_PROTOCOLS.meteora_dlmm.program_id,
    ]
    packageScoped.artifacts[0].program_identity_locator = 'address field in IDL'
    packageScoped.artifacts[0].declared_raw_file_sha256 =
      '045c0f4af044be046b6a14b350077e4242e8ac026b64a855803dab30fcdd8b35'
    packageScoped.artifacts[0].license = {
      state: 'declared',
      identifier: 'ISC',
      terms_class: 'osi_approved',
      scope: 'package_subtree',
      scope_root: 'ts-client',
      evidence_path: 'ts-client/package.json',
      declared_evidence_sha256: 'c6c5854e5a13782e051985e391a798c7edd0fa730bc906763036ed3b9eb8b71f',
      evidence_integrity_state: 'declared_not_repository_verified',
    }
    expect(() => parseDexSolanaProtocolManifest(packageScoped)).not.toThrow()

    packageScoped.artifacts[0].path = 'other-package/idl.json'
    packageScoped.artifacts[0].official_url =
      `${packageScoped.artifacts[0].repository}/blob/` +
      `${packageScoped.artifacts[0].git_commit}/${packageScoped.artifacts[0].path}`
    expect(() => parseDexSolanaProtocolManifest(packageScoped)).toThrow(/does not cover artifact/)
  })

  it('models loader v1 and v2 as single-account code without inventing deployment slots', () => {
    for (const [loaderKind, loaderProgramId] of [
      ['bpf_loader_v1', SOLANA_BPF_LOADER_V1],
      ['bpf_loader_v2', SOLANA_BPF_LOADER_V2],
    ] as const) {
      const fixture = manifestFixture()
      setLoaderEvidence(fixture, {
        state: 'provisional_observed',
        loader_kind: loaderKind,
        loader_program_id: loaderProgramId,
        observed_at: '2026-07-18T00:00:00.000Z',
        observation_sources: observationSources(),
        program_account_owner: loaderProgramId,
        program_executable: true,
        program_account_data_sha256: HASH_A,
        code_sha256: HASH_A,
        code_storage: 'program_account_raw_data',
        deployment_slot: null,
        effective_slot: null,
      })
      expect(() => parseDexSolanaProtocolManifest(fixture)).not.toThrow()

      const mismatchedCode = clone(fixture)
      const evidence = mismatchedCode.protocols[0].loader_evidence
      if (evidence.loader_kind === loaderKind) evidence.code_sha256 = HASH_B
      expect(() => parseDexSolanaProtocolManifest(mismatchedCode)).toThrow(
        /must equal stored code bytes/
      )
    }
  })

  it('requires the v3 ProgramData PDA, two independent finalized observations, and N+1 visibility', () => {
    const fixture = manifestFixture()
    expect(findSolanaV3ProgramDataAddress(RAYDIUM_AMM_V4)).toEqual({
      address: 'A7ZG7ByDi8DpzT9Ab7CiXhvgYTJQmaDPJkMDoPitaCQV',
      bump_seed: 255,
    })
    setLoaderEvidence(fixture, {
      state: 'provisional_observed',
      loader_kind: 'bpf_loader_v3',
      loader_program_id: SOLANA_BPF_LOADER_V3,
      observed_at: '2026-07-18T00:00:00.000Z',
      observation_sources: observationSources(),
      program_account_owner: SOLANA_BPF_LOADER_V3,
      program_executable: true,
      program_account_data_sha256: HASH_A,
      program_account_programdata_address: 'A7ZG7ByDi8DpzT9Ab7CiXhvgYTJQmaDPJkMDoPitaCQV',
      programdata_address: 'A7ZG7ByDi8DpzT9Ab7CiXhvgYTJQmaDPJkMDoPitaCQV',
      programdata_bump_seed: 255,
      programdata_owner: SOLANA_BPF_LOADER_V3,
      programdata_account_data_sha256: HASH_B,
      code_sha256: HASH_C,
      code_storage: 'programdata_account_after_state_header',
      deployed_slot: '1000',
      effective_slot: '1001',
      upgrade_authority: {
        state: 'present',
        address: 'Vote111111111111111111111111111111111111111',
      },
    })
    expect(() => parseDexSolanaProtocolManifest(fixture)).not.toThrow()
    expect(fixture.protocols[0].blocking_reasons).toContain('program_source_build_unbound')
    expect(fixture.authorization.execution).toBe(false)

    const wrongPda = clone(fixture)
    if (wrongPda.protocols[0].loader_evidence.loader_kind === 'bpf_loader_v3') {
      wrongPda.protocols[0].loader_evidence.program_account_programdata_address =
        'Vote111111111111111111111111111111111111111'
      wrongPda.protocols[0].loader_evidence.programdata_address =
        'Vote111111111111111111111111111111111111111'
    }
    expect(() => parseDexSolanaProtocolManifest(wrongPda)).toThrow(/program-derived/)

    const noncanonicalBump = clone(fixture)
    if (noncanonicalBump.protocols[0].loader_evidence.loader_kind === 'bpf_loader_v3') {
      noncanonicalBump.protocols[0].loader_evidence.programdata_bump_seed = 254
    }
    expect(() => parseDexSolanaProtocolManifest(noncanonicalBump)).toThrow(/program-derived/)

    const sameProvider = clone(fixture)
    sameProvider.protocols[0].loader_evidence.observation_sources[1].provider_id = 'rpc-a'
    expect(() => parseDexSolanaProtocolManifest(sameProvider)).toThrow(/duplicate RPC provider/)

    const decodedDisagreement = clone(fixture)
    decodedDisagreement.protocols[0].loader_evidence.observation_sources[1].canonical_decoded_observation_sha256 =
      HASH_A
    expect(() => parseDexSolanaProtocolManifest(decodedDisagreement)).toThrow(
      /disagree on the canonical decoded/
    )

    const wrongEffectiveSlot = clone(fixture)
    if (wrongEffectiveSlot.protocols[0].loader_evidence.loader_kind === 'bpf_loader_v3') {
      wrongEffectiveSlot.protocols[0].loader_evidence.effective_slot = '1000'
    }
    expect(() => parseDexSolanaProtocolManifest(wrongEffectiveSlot)).toThrow(/plus one/)

    const observedTooEarly = clone(fixture)
    observedTooEarly.protocols[0].loader_evidence.observation_sources[0].observed_finalized_slot =
      '999'
    expect(() => parseDexSolanaProtocolManifest(observedTooEarly)).toThrow(/predates the effective/)

    const oversizedSlot = clone(fixture)
    oversizedSlot.protocols[0].loader_evidence.observation_sources[0].observed_finalized_slot =
      '18446744073709551616'
    expect(() => parseDexSolanaProtocolManifest(oversizedSlot)).toThrow(/canonical u64/)
  })

  it('binds loader v4 control semantics to deployed/finalized status and N+1 visibility', () => {
    const fixture = manifestFixture()
    setLoaderEvidence(fixture, {
      state: 'provisional_observed',
      loader_kind: 'loader_v4',
      loader_program_id: SOLANA_LOADER_V4,
      observed_at: '2026-07-18T00:00:00.000Z',
      observation_sources: observationSources(),
      program_account_owner: SOLANA_LOADER_V4,
      program_executable: true,
      program_account_data_sha256: HASH_A,
      code_sha256: HASH_B,
      code_storage: 'program_account_after_loader_v4_state',
      deployed_slot: '1000',
      effective_slot: '1001',
      status: 'finalized',
      authority_or_next_version: {
        kind: 'next_version',
        address: 'Vote111111111111111111111111111111111111111',
      },
    })
    expect(() => parseDexSolanaProtocolManifest(fixture)).not.toThrow()

    const wrongControl = clone(fixture)
    if (wrongControl.protocols[0].loader_evidence.loader_kind === 'loader_v4') {
      wrongControl.protocols[0].loader_evidence.authority_or_next_version = {
        kind: 'authority',
        address: 'Vote111111111111111111111111111111111111111',
      }
    }
    expect(() => parseDexSolanaProtocolManifest(wrongControl)).toThrow(/status conflicts/)

    const retracted = clone(fixture)
    Reflect.set(retracted.protocols[0].loader_evidence, 'status', 'retracted')
    expect(() => parseDexSolanaProtocolManifest(retracted)).toThrow()
  })

  it('requires target gaps without allowing a seeded protocol to remain marked missing', () => {
    const hiddenGap = manifestFixture()
    hiddenGap.known_gaps = hiddenGap.known_gaps.filter(
      (gap) => gap !== 'unprofiled_program_hits_not_quantified'
    )
    expect(() => parseDexSolanaProtocolManifest(hiddenGap)).toThrow(/missing required known gap/)

    const missingDisclosure = manifestFixture()
    missingDisclosure.known_gaps = missingDisclosure.known_gaps.filter(
      (gap) => gap !== 'orca_whirlpool_not_seeded'
    )
    expect(() => parseDexSolanaProtocolManifest(missingDisclosure)).toThrow(
      /must disclose missing target/
    )

    const contradictory = manifestFixture()
    contradictory.known_gaps.push('raydium_amm_v4_not_seeded')
    expect(() => parseDexSolanaProtocolManifest(contradictory)).toThrow(/contradicts/)
  })

  it('normalizes unordered sets before a strict canonical hash without mutating input', () => {
    const fixture = manifestFixture()
    const shuffled = clone(fixture)
    shuffled.artifacts[0].evidence_roles.reverse()
    shuffled.protocols[0].blocking_reasons.reverse()
    shuffled.protocols[0].decoder.required_fact_families.reverse()
    shuffled.known_gaps.reverse()

    expect(dexSolanaProtocolManifestSha256(shuffled)).toBe(dexSolanaProtocolManifestSha256(fixture))
    expect(dexSolanaProtocolManifestSha256(fixture)).toBe(
      '65f5568e1b3bab62e326d5cc90c3615249f9716f9153c520d05d03ef9a869e2e'
    )
    expect(shuffled.known_gaps[0]).not.toBe(
      normalizeDexSolanaProtocolManifest(shuffled).known_gaps[0]
    )

    const changed = clone(fixture)
    changed.protocols[0].product = 'changed'
    expect(() => dexSolanaProtocolManifestSha256(changed)).toThrow(/target program map/)
  })

  it('rejects noncanonical timestamps, foreign chain identity, and implied authorization', () => {
    const timestamp = manifestFixture()
    timestamp.evidence_as_of = '2026-07-18'
    expect(() => parseDexSolanaProtocolManifest(timestamp)).toThrow(/evidence_as_of/)

    const foreignChain = clone(manifestFixture())
    Reflect.set(foreignChain.chain, 'network', 'devnet')
    expect(() => parseDexSolanaProtocolManifest(foreignChain)).toThrow()

    const authorized = clone(manifestFixture())
    Reflect.set(authorized.authorization, 'serving', true)
    expect(() => parseDexSolanaProtocolManifest(authorized)).toThrow()
  })
})
