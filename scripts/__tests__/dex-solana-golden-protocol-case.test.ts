import { createHash } from 'node:crypto'

import evidenceJson from '../fixtures/dex-solana-golden-rpc-metadata.v3.json'
import manifestJson from '../fixtures/dex-solana-protocol-manifest.v1.json'
import {
  DEX_GOLDEN_RPC_EVIDENCE_CONTRACT,
  dexGoldenRpcExchangeBindingSha256,
} from '../lib/dex-golden-rpc-evidence'
import {
  DEX_SOLANA_GOLDEN_PROTOCOL_CASE_CONTRACT,
  DEX_SOLANA_GOLDEN_PROTOCOL_CASE_REQUIRED_BLOCKERS,
  DEX_SOLANA_GOLDEN_PROTOCOL_CASE_SCHEMA_VERSION,
  DEX_SOLANA_PROGRAM_HIT_OBSERVATION_CONTRACT,
  buildDexSolanaGoldenProtocolCase,
  dexSolanaGoldenProtocolCaseSha256,
  dexSolanaSourceObservationBindingSha256,
  parseDexSolanaGoldenProtocolCase,
  parseDexSolanaGoldenProtocolCaseJson,
  verifyDexSolanaGoldenProtocolCase,
  type DexSolanaGoldenProtocolCase,
  type DexSolanaProgramHitObservedFacts,
} from '../lib/dex-solana-golden-protocol-case'
import { DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT } from '../lib/dex-golden-transaction-facts'
import { DEX_SOLANA_PROTOCOL_MANIFEST_CONTRACT } from '../lib/dex-solana-protocol-manifest'

const SIGNATURE =
  'j79Ffrrm3v5mD1WoM2fNrsRsefDFoFx9DTdZARp877uZqZ3RDrXQ35yNxKZ26SBGqDCj8n358Z9GztGRFxKDpef'
const JUPITER_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const GENERATED_AT = '2026-07-18T12:02:00.000Z'

function hash(label: string): string {
  return createHash('sha256').update(`solana-golden-protocol-case:${label}`).digest('hex')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function observedFacts(): DexSolanaProgramHitObservedFacts {
  return {
    data_contract: DEX_SOLANA_PROGRAM_HIT_OBSERVATION_CONTRACT,
    observation_state: 'caller_declared_unverified_not_replayed',
    signature: SIGNATURE,
    slot_decimal: '433666418',
    blockhash: '9619you2FRGZq19sbzULJQKFPBtnDgkagk1VkttTyUvf',
    transaction_index_zero_based: 1056,
    execution_status: 'succeeded',
    transaction_version: 0,
    address_lookup_table_count: 0,
    account_resolution_state: 'all_static_and_lookup_keys_resolved',
    resolved_account_keys_count: 28,
    resolved_account_keys_root_sha256: hash('resolved-account-keys'),
    resolved_account_keys_hash_basis: 'arena_dex_resolved_solana_account_keys_v1',
    inner_instructions_state: 'present',
    instruction_scope: 'all_outer_and_rpc_reported_inner_instructions',
    outer_instruction_count: 8,
    instruction_count: 25,
    instruction_metadata_root_sha256: hash('instruction-metadata'),
    instruction_metadata_hash_basis: 'arena_dex_solana_instruction_metadata_v1',
    target_program_id: JUPITER_PROGRAM_ID,
    target_hit_count: 2,
    hits: [
      {
        outer_index: 6,
        inner_index: null,
        program_id_index: 17,
        program_id: JUPITER_PROGRAM_ID,
        data_byte_length: 35,
        data_sha256: '3d9bb5c201615434a0042d2ba613894d8e61fda070ccec1a35c78089bc9e4189',
        data_prefix8_hex: 'e517cb977ae3ad2a',
        data_hash_basis: 'base58_decoded_instruction_data_bytes',
      },
      {
        outer_index: 6,
        inner_index: 8,
        program_id_index: 17,
        program_id: JUPITER_PROGRAM_ID,
        data_byte_length: 128,
        data_sha256: '1ad83c6bed0de3009234cb04b619587d1b08650b5c98ec0fa12b395f42a06095',
        data_prefix8_hex: 'e445a52e51cb9a1d',
        data_hash_basis: 'base58_decoded_instruction_data_bytes',
      },
    ],
  }
}

function sourceObservations(
  first = observedFacts(),
  second = observedFacts()
): [
  { endpoint_id: 'publicnode_solana_mainnet'; observed_facts: unknown },
  { endpoint_id: 'solana_official_mainnet'; observed_facts: unknown },
] {
  return [
    { endpoint_id: 'publicnode_solana_mainnet', observed_facts: first },
    { endpoint_id: 'solana_official_mainnet', observed_facts: second },
  ]
}

function build(
  sources: ReturnType<typeof sourceObservations> = sourceObservations()
): DexSolanaGoldenProtocolCase {
  return buildDexSolanaGoldenProtocolCase({
    generated_at: GENERATED_AT,
    case_id: 'solana-jupiter-program-hit-001',
    protocol_id: 'jupiter_swap_v6',
    manifest_input: manifestJson,
    golden_rpc_evidence_input: evidenceJson,
    source_observations: sources,
  })
}

function rebuildExchangeBinding(evidence: any, captureIndex: number, exchangeIndex: number): void {
  const capture = evidence.captures[captureIndex]
  const exchange = capture.rpc_exchanges[exchangeIndex]
  const { exchange_binding_sha256: _binding, ...core } = exchange
  exchange.exchange_binding_sha256 = dexGoldenRpcExchangeBindingSha256({
    chain_namespace: evidence.chain.namespace,
    transaction_id: evidence.transaction_id,
    endpoint: capture.endpoint,
    capture_completed_at: capture.capture_completed_at,
    exchange: core,
  })
}

describe('Solana manifest program-hit golden case contract', () => {
  it('binds a caller-declared candidate without upgrading provenance, semantics, or replay claims', () => {
    const value = build()
    expect(parseDexSolanaGoldenProtocolCase(value)).toEqual(value)
    expect(
      verifyDexSolanaGoldenProtocolCase({
        case_input: value,
        manifest_input: manifestJson,
        golden_rpc_evidence_input: evidenceJson,
      })
    ).toEqual(value)
    expect(value).toMatchObject({
      schema_version: DEX_SOLANA_GOLDEN_PROTOCOL_CASE_SCHEMA_VERSION,
      data_contract: DEX_SOLANA_GOLDEN_PROTOCOL_CASE_CONTRACT,
      purpose: 'phase0_solana_manifest_program_hit_candidate_binding_only',
      verification_state: 'declared_not_replayed',
      protocol_manifest: {
        data_contract: DEX_SOLANA_PROTOCOL_MANIFEST_CONTRACT,
        canonical_sha256: '10e000a4b625c90da571374bdc3567e86ac01a632d1a7803da69018677d77f9a',
        protocol_id: 'jupiter_swap_v6',
        manifest_declared_program_id: JUPITER_PROGRAM_ID,
      },
      golden_rpc_evidence: {
        data_contract: DEX_GOLDEN_RPC_EVIDENCE_CONTRACT,
        canonical_sha256: '223babd47d32242e49e594286cc20a7cd5471aa9ab8e85bdeee5c3d96390b2a9',
        stable_facts_contract: DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT,
        stable_facts_sha256: 'd29905e525cd5f0c7aa97fcfe033f5a5b1862111dfa2a3f71020401fc51f7803',
      },
    })
    expect(value.required_blockers).toEqual([...DEX_SOLANA_GOLDEN_PROTOCOL_CASE_REQUIRED_BLOCKERS])
    expect(value.claims).toEqual({
      manifest_declared_program_id_instruction_observed_at_capture: false,
      program_hit_provenance_verified: false,
      normalized_documents_replayed: false,
      provider_independence_verified: false,
      finality_membership_verified: false,
      protocol_identity_verified: false,
      deployment_or_code_epoch_verified: false,
      protocol_invocation_semantics_verified: false,
      golden_case_semantic_classification_verified: false,
      decoder_facts_verified: false,
      legal_clearance_verified: false,
    })
    expect(
      Object.values(value.authorization).every((authorization) => authorization === false)
    ).toBe(true)
    expect(dexSolanaGoldenProtocolCaseSha256(value)).toBe(
      'a394eca5cebe5ba33baf6864b7e2546bb0e6b3452b9649498b9a0e378ac9ee84'
    )
  })

  it('binds the exact three response lanes and one common candidate to each RPC source', () => {
    const value = build()
    expect(value.source_observations.map((source) => source.endpoint.endpoint_id)).toEqual([
      'publicnode_solana_mainnet',
      'solana_official_mainnet',
    ])
    expect(value.source_observations.map((source) => source.rpc_response_commitments)).toEqual([
      {
        transaction_sha256: 'd874cfef6a79682a139298863a82b8f723aea60fc610d903396f96fca502cb08',
        signature_status_sha256: '0f65932070402e2c429727dff2a1951f778711e120a4adf21c6790b03c0343c2',
        membership_block_sha256: '110f90aefd335fbb11b54544bba28ab999ad03c5c7eabd19459cfa689f540070',
      },
      {
        transaction_sha256: 'd874cfef6a79682a139298863a82b8f723aea60fc610d903396f96fca502cb08',
        signature_status_sha256: '07a6c8dd9ce22cd2d43c6a623b7a7531648188383c8623da31a95883f8904f9c',
        membership_block_sha256: '110f90aefd335fbb11b54544bba28ab999ad03c5c7eabd19459cfa689f540070',
      },
    ])
    expect(
      new Set(value.source_observations.map((source) => source.source_binding_sha256)).size
    ).toBe(2)
    expect(
      value.source_observations.every(
        (source) =>
          source.protocol_observation_sha256 === value.observed_facts_sha256 &&
          source.response_content_state === 'not_persisted' &&
          source.content_available_for_replay === false
      )
    ).toBe(true)
  })

  it('requires identical facts from both endpoints and rejects duplicate sources', () => {
    const drifted = observedFacts()
    drifted.transaction_index_zero_based += 1
    expect(() => build(sourceObservations(observedFacts(), drifted))).toThrow(
      'identical program-hit facts'
    )

    expect(() =>
      buildDexSolanaGoldenProtocolCase({
        generated_at: GENERATED_AT,
        case_id: 'solana-jupiter-program-hit-001',
        protocol_id: 'jupiter_swap_v6',
        manifest_input: manifestJson,
        golden_rpc_evidence_input: evidenceJson,
        source_observations: [
          { endpoint_id: 'publicnode_solana_mainnet', observed_facts: observedFacts() },
          { endpoint_id: 'publicnode_solana_mainnet', observed_facts: observedFacts() },
        ],
      })
    ).toThrow('source endpoints must be unique')
  })

  it('rejects forged, missing, duplicate, or noncanonical target hits', () => {
    const wrongProgram = observedFacts()
    wrongProgram.hits[0].program_id = '11111111111111111111111111111111'
    expect(() => build(sourceObservations(wrongProgram, clone(wrongProgram)))).toThrow(
      'different program id'
    )

    const missing = observedFacts()
    missing.hits = []
    missing.target_hit_count = 0
    expect(() => build(sourceObservations(missing, clone(missing)))).toThrow()

    const duplicate = observedFacts()
    duplicate.hits.push(clone(duplicate.hits[0]))
    duplicate.target_hit_count = 3
    expect(() => build(sourceObservations(duplicate, clone(duplicate)))).toThrow(
      'unique and canonically sorted'
    )

    const reordered = observedFacts()
    reordered.hits.reverse()
    expect(() => build(sourceObservations(reordered, clone(reordered)))).toThrow(
      'unique and canonically sorted'
    )
  })

  it('rejects incomplete account/data/inner-instruction metadata', () => {
    const outOfRangeProgram = observedFacts()
    outOfRangeProgram.hits[0].program_id_index = outOfRangeProgram.resolved_account_keys_count
    expect(() => build(sourceObservations(outOfRangeProgram, clone(outOfRangeProgram)))).toThrow(
      'program index exceeds'
    )

    const missingPrefix = observedFacts()
    missingPrefix.hits[0].data_prefix8_hex = null
    expect(() => build(sourceObservations(missingPrefix, clone(missingPrefix)))).toThrow(
      '8-byte prefix conflicts'
    )

    const impossibleInner = observedFacts()
    impossibleInner.inner_instructions_state = 'verified_empty'
    impossibleInner.instruction_count = impossibleInner.outer_instruction_count
    expect(() => build(sourceObservations(impossibleInner, clone(impossibleInner)))).toThrow(
      'verified-empty inner instructions'
    )

    const outerIndexOutOfRange = observedFacts()
    outerIndexOutOfRange.hits[0].outer_index = outerIndexOutOfRange.outer_instruction_count
    expect(() =>
      build(sourceObservations(outerIndexOutOfRange, clone(outerIndexOutOfRange)))
    ).toThrow('outer index exceeds')

    const outerCountOutOfRange = observedFacts()
    outerCountOutOfRange.outer_instruction_count = outerCountOutOfRange.instruction_count + 1
    expect(() =>
      build(sourceObservations(outerCountOutOfRange, clone(outerCountOutOfRange)))
    ).toThrow('outer instruction count exceeds')

    const unavailableInner = observedFacts() as any
    unavailableInner.inner_instructions_state = 'unavailable'
    expect(() => build(sourceObservations(unavailableInner, clone(unavailableInner)))).toThrow()
  })

  it('rejects unsafe numeric identities and a target outside the selected manifest protocol', () => {
    const noncanonicalSlot = observedFacts()
    noncanonicalSlot.slot_decimal = '0433666418'
    expect(() => build(sourceObservations(noncanonicalSlot, clone(noncanonicalSlot)))).toThrow(
      'canonical u64 decimal'
    )

    const oversizedSlot = observedFacts()
    oversizedSlot.slot_decimal = '1'.repeat(100)
    expect(() => build(sourceObservations(oversizedSlot, clone(oversizedSlot)))).toThrow(
      'canonical u64 decimal'
    )

    const negativeZero = observedFacts()
    negativeZero.transaction_index_zero_based = -0
    expect(() => build(sourceObservations(negativeZero, clone(negativeZero)))).toThrow(
      'nonnegative safe integer'
    )

    const oversizedData = observedFacts()
    oversizedData.hits[0].data_byte_length = 1233
    expect(() => build(sourceObservations(oversizedData, clone(oversizedData)))).toThrow()

    const futureTransactionVersion = observedFacts() as any
    futureTransactionVersion.transaction_version = 1
    expect(() =>
      build(sourceObservations(futureTransactionVersion, clone(futureTransactionVersion)))
    ).toThrow()

    const legacyWithLookups = observedFacts()
    legacyWithLookups.transaction_version = 'legacy'
    legacyWithLookups.address_lookup_table_count = 1
    expect(() => build(sourceObservations(legacyWithLookups, clone(legacyWithLookups)))).toThrow(
      'legacy transactions cannot declare address lookup tables'
    )

    const foreignProgram = observedFacts()
    foreignProgram.target_program_id = '11111111111111111111111111111111'
    for (const hit of foreignProgram.hits) hit.program_id = foreignProgram.target_program_id
    expect(() => build(sourceObservations(foreignProgram, clone(foreignProgram)))).toThrow(
      'target program'
    )
  })

  it('fails closed on scenario labels, replay upgrades, body injection, or missing blockers', () => {
    const baseline = build()

    const labeled = clone(baseline) as any
    labeled.case.scenario_tags = ['jupiter_route']
    expect(() => parseDexSolanaGoldenProtocolCase(labeled)).toThrow()

    const replayed = clone(baseline) as any
    replayed.claims.normalized_documents_replayed = true
    expect(() => parseDexSolanaGoldenProtocolCase(replayed)).toThrow()

    const observationOverclaimed = clone(baseline) as any
    observationOverclaimed.claims.manifest_declared_program_id_instruction_observed_at_capture = true
    expect(() => parseDexSolanaGoldenProtocolCase(observationOverclaimed)).toThrow()

    const decoded = clone(baseline) as any
    decoded.claims.protocol_invocation_semantics_verified = true
    expect(() => parseDexSolanaGoldenProtocolCase(decoded)).toThrow()

    const authorized = clone(baseline) as any
    authorized.authorization.serving = true
    expect(() => parseDexSolanaGoldenProtocolCase(authorized)).toThrow()

    const body = clone(baseline) as any
    body.source_observations[0].response_body = { result: 'not allowed' }
    expect(() => parseDexSolanaGoldenProtocolCase(body)).toThrow()

    const url = clone(baseline) as any
    url.source_observations[0].url = 'https://api.mainnet-beta.solana.com'
    expect(() => parseDexSolanaGoldenProtocolCase(url)).toThrow()

    const missingBlocker = clone(baseline)
    missingBlocker.required_blockers = missingBlocker.required_blockers.filter(
      (blocker) => blocker !== 'protocol_invocation_semantics_unverified'
    )
    expect(() => parseDexSolanaGoldenProtocolCase(missingBlocker)).toThrow('required blockers')

    const missingSourceProtocolBlocker = clone(baseline)
    missingSourceProtocolBlocker.protocol_manifest.source_protocol_blockers =
      missingSourceProtocolBlocker.protocol_manifest.source_protocol_blockers.filter(
        (blocker) => blocker !== 'golden_transactions_unverified'
      )
    expect(() => parseDexSolanaGoldenProtocolCase(missingSourceProtocolBlocker)).toThrow(
      'protocol blockers is missing required blocker'
    )

    const missingSourceEvidenceBlocker = clone(baseline)
    missingSourceEvidenceBlocker.golden_rpc_evidence.source_evidence_blockers =
      missingSourceEvidenceBlocker.golden_rpc_evidence.source_evidence_blockers.filter(
        (blocker) => blocker !== 'raw_and_normalized_bodies_not_persisted'
      )
    expect(() => parseDexSolanaGoldenProtocolCase(missingSourceEvidenceBlocker)).toThrow(
      'evidence blockers is missing required blocker'
    )
  })

  it('rejects source binding, closure, timestamp, and source-document drift', () => {
    const baseline = build()

    const binding = clone(baseline)
    binding.source_observations[0].rpc_response_commitments.transaction_sha256 =
      hash('forged-response')
    expect(() => parseDexSolanaGoldenProtocolCase(binding)).toThrow(
      'source observation binding SHA'
    )

    const closure = clone(baseline)
    closure.source_observation_closure_sha256 = hash('forged-closure')
    expect(() => parseDexSolanaGoldenProtocolCase(closure)).toThrow(
      'source observation closure SHA'
    )

    const observedFactsRoot = clone(baseline)
    observedFactsRoot.observed_facts.instruction_metadata_root_sha256 =
      hash('forged-instruction-root')
    expect(() => parseDexSolanaGoldenProtocolCase(observedFactsRoot)).toThrow('observed facts SHA')

    const reorderedSources = clone(baseline)
    reorderedSources.source_observations.reverse()
    expect(() => parseDexSolanaGoldenProtocolCase(reorderedSources)).toThrow('canonically sorted')

    const futureCapture = clone(baseline)
    futureCapture.source_observations[0].capture_completed_at = '2026-07-18T12:02:01.000Z'
    const { source_binding_sha256: _binding, ...core } = futureCapture.source_observations[0]
    futureCapture.source_observations[0].source_binding_sha256 =
      dexSolanaSourceObservationBindingSha256(core)
    expect(() => parseDexSolanaGoldenProtocolCase(futureCapture)).toThrow(
      'cannot predate a source capture'
    )

    const driftedEvidence = clone(evidenceJson) as any
    driftedEvidence.captures[0].rpc_exchanges[4].response.sha256 = hash(
      'valid-but-different-response'
    )
    rebuildExchangeBinding(driftedEvidence, 0, 4)
    expect(() =>
      verifyDexSolanaGoldenProtocolCase({
        case_input: baseline,
        manifest_input: manifestJson,
        golden_rpc_evidence_input: driftedEvidence,
      })
    ).toThrow('conflicts with its bound source documents')

    const driftedManifest = clone(manifestJson)
    driftedManifest.evidence_as_of = '2026-07-18T08:08:47.000Z'
    expect(() =>
      verifyDexSolanaGoldenProtocolCase({
        case_input: baseline,
        manifest_input: driftedManifest,
        golden_rpc_evidence_input: evidenceJson,
      })
    ).toThrow('conflicts with its bound source documents')
  })

  it('rejects superseded versions, duplicate JSON keys, and extra fields', () => {
    const baseline = build()
    const legacy = clone(baseline) as any
    legacy.schema_version = 0
    legacy.data_contract = 'arena.dex.solana-golden-protocol-case@0'
    expect(() => parseDexSolanaGoldenProtocolCase(legacy)).toThrow()

    const serialized = JSON.stringify(baseline)
    const duplicate = serialized.replace(
      '"schema_version":1',
      '"schema_version":1,"schema_version":1'
    )
    expect(() => parseDexSolanaGoldenProtocolCaseJson(duplicate)).toThrow('invalid strict JSON')

    const extra = clone(baseline) as any
    extra.observed_facts.idl_instruction_name = 'route'
    expect(() => parseDexSolanaGoldenProtocolCase(extra)).toThrow()
  })
})
