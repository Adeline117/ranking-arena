import { createHash } from 'node:crypto'

import { BSC_MAINNET_GENESIS_HASH } from '../../lib/ingest/onchain/bsc-evidence'
import { SOLANA_MAINNET_GENESIS_HASH } from '../../lib/ingest/onchain/solana-evidence'
import bscManifestJson from '../fixtures/dex-bsc-protocol-manifest.v1.json'
import solanaManifestJson from '../fixtures/dex-solana-protocol-manifest.v1.json'
import {
  DEX_BSC_GOLDEN_RPC_LANES,
  DEX_GOLDEN_RPC_EVIDENCE_CONTRACT,
  DEX_GOLDEN_RPC_EVIDENCE_SCHEMA_VERSION,
  DEX_GOLDEN_RPC_REQUIRED_BLOCKERS,
  DEX_SOLANA_GOLDEN_RPC_LANES,
  dexGoldenRemoteEndpointIdentity,
  dexGoldenRpcExchangeBindingSha256,
  dexGoldenRpcParamsSha256,
  type DexGoldenRemoteEndpointId,
  type DexGoldenRpcCapture,
  type DexGoldenRpcEvidence,
  type DexGoldenRpcExchange,
} from '../lib/dex-golden-rpc-evidence'
import {
  DEX_GOLDEN_PROTOCOL_BINDING_CONTRACT,
  DEX_GOLDEN_PROTOCOL_BINDING_REQUIRED_BLOCKERS,
  DEX_GOLDEN_PROTOCOL_BINDING_SCHEMA_VERSION,
  buildDexGoldenProtocolBinding,
  dexGoldenProtocolBindingSha256,
  parseDexGoldenProtocolBinding,
  parseDexGoldenProtocolBindingJson,
  verifyDexGoldenProtocolBinding,
  type DexGoldenProtocolBinding,
} from '../lib/dex-golden-protocol-binding'
import {
  DEX_BSC_STABLE_TRANSACTION_FACTS_CONTRACT,
  DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT,
} from '../lib/dex-golden-transaction-facts'

const BSC_TX = `0x${'ab'.repeat(32)}`
const SOLANA_TX =
  '4vJ9JU1bJJE96FWSJKvHsmmF5SboYzN9k7qypM1eS6KxWnL2p9wWSpP3gBF5zK7XoqT9VxpxpVZpjhmZz2HcQxZ'
const GENERATED_AT = '2026-07-18T10:00:00.000Z'

function hash(label: string): string {
  return createHash('sha256').update(`golden-protocol-binding:${label}`).digest('hex')
}

function rawBody(label: string, kind: 'request' | 'response') {
  const sha256 = hash(label)
  return {
    sha256,
    byte_length: label.length + 16,
    media_type: 'application/json' as const,
    hash_basis:
      kind === 'request'
        ? ('utf8_json_rpc_request_body_bytes' as const)
        : ('fetch_content_decoded_http_entity_body_bytes_before_utf8' as const),
    persistence_state: 'not_persisted' as const,
    content_available_for_replay: false as const,
    contains_secrets: false as const,
  }
}

function normalizedDocument(label: string) {
  const sha256 = hash(label)
  return {
    sha256,
    byte_length: label.length + 32,
    hash_basis: 'strict_canonical_json_utf8_bytes' as const,
    persistence_state: 'not_persisted' as const,
    content_available_for_replay: false as const,
    contains_secrets: false as const,
  }
}

function exchange(
  chainNamespace: 'eip155' | 'solana',
  transactionId: string,
  endpointId: DexGoldenRemoteEndpointId,
  completedAt: string,
  lane: string,
  method: string
): DexGoldenRpcExchange {
  const endpoint = dexGoldenRemoteEndpointIdentity(endpointId)
  const core = {
    lane,
    method,
    params_sha256: dexGoldenRpcParamsSha256(method, [transactionId, lane]),
    params_hash_basis: 'arena_dex_json_rpc_params_v1' as const,
    http_status: 200,
    request: rawBody(`${endpointId}:${lane}:request`, 'request'),
    response: rawBody(`${endpointId}:${lane}:response`, 'response'),
  }
  return {
    ...core,
    exchange_binding_sha256: dexGoldenRpcExchangeBindingSha256({
      chain_namespace: chainNamespace,
      transaction_id: transactionId,
      endpoint,
      capture_completed_at: completedAt,
      exchange: core,
    }),
  }
}

function capture(
  chainNamespace: 'eip155' | 'solana',
  transactionId: string,
  endpointId: DexGoldenRemoteEndpointId,
  stableHash: string
): DexGoldenRpcCapture {
  const completedAt = '2026-07-18T09:00:00.000Z'
  const lanes = chainNamespace === 'eip155' ? DEX_BSC_GOLDEN_RPC_LANES : DEX_SOLANA_GOLDEN_RPC_LANES
  return {
    endpoint: dexGoldenRemoteEndpointIdentity(endpointId),
    endpoint_assertion_state: 'declared_not_replayed',
    capture_completed_at: completedAt,
    rpc_exchanges: lanes.map(([lane, method]) =>
      exchange(chainNamespace, transactionId, endpointId, completedAt, lane, method)
    ),
    normalized_documents: {
      chain_anchor: normalizedDocument(`${endpointId}:anchor`),
      transaction_membership: normalizedDocument(`${endpointId}:membership`),
      verified_finality: normalizedDocument(`${endpointId}:verified`),
    },
    provider_finality_witness:
      chainNamespace === 'eip155'
        ? {
            policy: 'bsc_verified_finality_document_no_exported_semantic_hash_v1',
            semantic_sha256: null,
          }
        : {
            policy: 'solana_verified_transaction_finality_semantics_v2',
            semantic_sha256: hash(`${endpointId}:semantic`),
          },
    stable_transaction_facts_sha256: stableHash,
  }
}

function makeEvidence(chain: 'bsc' | 'solana'): DexGoldenRpcEvidence {
  const isBsc = chain === 'bsc'
  const transactionId = isBsc ? BSC_TX : SOLANA_TX
  const stableHash = hash(`${chain}:stable-facts`)
  const endpointIds: [DexGoldenRemoteEndpointId, DexGoldenRemoteEndpointId] = isBsc
    ? ['alchemy_bnb_mainnet', 'publicnode_bsc_mainnet']
    : ['alchemy_solana_mainnet', 'helius_solana_mainnet']
  return {
    schema_version: DEX_GOLDEN_RPC_EVIDENCE_SCHEMA_VERSION,
    data_contract: DEX_GOLDEN_RPC_EVIDENCE_CONTRACT,
    purpose: 'phase0_shadow_finality_membership_evidence_only',
    proof_boundary:
      'same_provider_rpc_assertions_not_cryptographic_inclusion_or_protocol_hit_proof',
    verification_state: 'declared_not_replayed',
    generated_at: '2026-07-18T09:01:00.000Z',
    chain: isBsc
      ? {
          namespace: 'eip155',
          reference: '56',
          chain_id: 56,
          genesis_hash: BSC_MAINNET_GENESIS_HASH,
          product_source_slug: 'binance_web3_bsc',
          chain_stream_slug: 'bsc_mainnet',
        }
      : {
          namespace: 'solana',
          cluster: 'mainnet-beta',
          genesis_hash: SOLANA_MAINNET_GENESIS_HASH,
          product_source_slug: 'okx_web3_solana',
          chain_stream_slug: 'solana_mainnet',
        },
    transaction_id: transactionId,
    stable_transaction_facts_contract: isBsc
      ? DEX_BSC_STABLE_TRANSACTION_FACTS_CONTRACT
      : DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT,
    stable_transaction_facts_sha256: stableHash,
    captures: endpointIds.map((endpointId) =>
      capture(isBsc ? 'eip155' : 'solana', transactionId, endpointId, stableHash)
    ),
    required_blockers: [...DEX_GOLDEN_RPC_REQUIRED_BLOCKERS],
    claims: {
      normalized_documents_replayed: false,
      provider_independence_verified: false,
      finality_membership_verified: false,
      protocol_invocation_verified: false,
      decoder_facts_verified: false,
    },
    authorization: {
      network_execution: false,
      raw_blob_persistence: false,
      decoder_fixture: false,
      serving: false,
      rank: false,
      score: false,
    },
  } as DexGoldenRpcEvidence
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function buildBsc(
  manifestInput: unknown = bscManifestJson,
  evidenceInput: unknown = makeEvidence('bsc')
): DexGoldenProtocolBinding {
  return buildDexGoldenProtocolBinding({
    generated_at: GENERATED_AT,
    manifest_input: manifestInput,
    golden_rpc_evidence_input: evidenceInput,
    selection: {
      chain: 'bsc',
      protocol_id: 'pancakeswap_v2',
      epoch_id: 'official-source-snapshot',
    },
    golden_case: {
      chain: 'bsc',
      case_id: 'pancakeswap-v2-buy-001',
      scenario_tags: ['buy', 'native_bnb_wbnb'],
      expected_execution: 'succeeded',
    },
  })
}

function buildSolana(
  manifestInput: unknown = solanaManifestJson,
  evidenceInput: unknown = makeEvidence('solana')
): DexGoldenProtocolBinding {
  return buildDexGoldenProtocolBinding({
    generated_at: GENERATED_AT,
    manifest_input: manifestInput,
    golden_rpc_evidence_input: evidenceInput,
    selection: {
      chain: 'solana',
      protocol_id: 'jupiter_swap_v6',
    },
    golden_case: {
      chain: 'solana',
      case_id: 'jupiter-v6-multihop-001',
      scenario_tags: ['inner_cpi', 'jupiter_route', 'multi_hop', 'versioned_transaction'],
      expected_execution: 'succeeded',
    },
  })
}

describe('DEX protocol/decoder/golden draft binding', () => {
  it('builds canonical BSC and Solana bindings without upgrading any claim', () => {
    const bscEvidence = makeEvidence('bsc')
    const bsc = buildBsc(bscManifestJson, bscEvidence)
    expect(
      verifyDexGoldenProtocolBinding({
        binding_input: bsc,
        manifest_input: bscManifestJson,
        golden_rpc_evidence_input: bscEvidence,
      })
    ).toEqual(bsc)
    expect(bsc.protocol_manifest.canonical_sha256).toBe(
      '4f31653cf0bbf4d6f8efc7f389987a6139331d94f9885878fb4d150b77a120cf'
    )
    expect(bsc.deployment_binding).toMatchObject({
      kind: 'bsc_manifest_epoch_candidate',
      activation_state: 'unverified',
      start_block: null,
      end_block: null,
      transaction_within_epoch_verified: false,
    })
    expect(bsc.legal_binding.artifact_ids).toEqual([
      'pancake-v2-addresses-81521fc1',
      'pancake-v2-factory-cb079908',
      'pancake-v2-pair-cb079908',
    ])
    expect(dexGoldenProtocolBindingSha256(bsc)).toBe(
      '641d8c2aa59070c60320fcaba448c44f3c773f195fc306cffd65219bea29ad5a'
    )

    const solanaEvidence = makeEvidence('solana')
    const solana = buildSolana(solanaManifestJson, solanaEvidence)
    expect(
      verifyDexGoldenProtocolBinding({
        binding_input: solana,
        manifest_input: solanaManifestJson,
        golden_rpc_evidence_input: solanaEvidence,
      })
    ).toEqual(solana)
    expect(solana.protocol_manifest.canonical_sha256).toBe(
      '10e000a4b625c90da571374bdc3567e86ac01a632d1a7803da69018677d77f9a'
    )
    expect(solana.deployment_binding).toMatchObject({
      kind: 'solana_code_epoch_unavailable',
      loader_evidence_state: 'not_verified',
      code_epoch_id: null,
      effective_slot: null,
      code_sha256: null,
      transaction_within_epoch_verified: false,
    })
    expect(solana.legal_binding).toMatchObject({
      review_requirement: 'required_by_manifest',
      review_artifact_ids: ['jupiter-v6-idl-cc068c9d'],
      commercial_reuse_authorized: false,
    })

    for (const binding of [bsc, solana]) {
      expect(Object.values(binding.claims)).toEqual(
        expect.arrayContaining(Array(Object.keys(binding.claims).length).fill(false))
      )
      expect(Object.values(binding.claims).every((value) => value === false)).toBe(true)
      expect(Object.values(binding.authorization).every((value) => value === false)).toBe(true)
      expect(binding.required_blockers).toEqual(DEX_GOLDEN_PROTOCOL_BINDING_REQUIRED_BLOCKERS)
    }
  })

  it('recomputes both source digests instead of trusting self-reported hashes', () => {
    const evidence = makeEvidence('bsc')
    const wrongManifestHash = clone(buildBsc(bscManifestJson, evidence))
    wrongManifestHash.protocol_manifest.canonical_sha256 = hash('wrong-manifest')
    expect(() => parseDexGoldenProtocolBinding(wrongManifestHash)).not.toThrow()
    expect(() =>
      verifyDexGoldenProtocolBinding({
        binding_input: wrongManifestHash,
        manifest_input: bscManifestJson,
        golden_rpc_evidence_input: evidence,
      })
    ).toThrow('conflicts with its source documents')

    const wrongEvidenceHash = clone(buildBsc(bscManifestJson, evidence))
    wrongEvidenceHash.golden_rpc_evidence.canonical_sha256 = hash('wrong-evidence')
    expect(() =>
      verifyDexGoldenProtocolBinding({
        binding_input: wrongEvidenceHash,
        manifest_input: bscManifestJson,
        golden_rpc_evidence_input: evidence,
      })
    ).toThrow('conflicts with its source documents')

    const wrongStableFacts = clone(buildBsc(bscManifestJson, evidence))
    wrongStableFacts.golden_rpc_evidence.stable_transaction_facts_sha256 =
      hash('wrong-stable-facts')
    expect(() =>
      verifyDexGoldenProtocolBinding({
        binding_input: wrongStableFacts,
        manifest_input: bscManifestJson,
        golden_rpc_evidence_input: evidence,
      })
    ).toThrow('conflicts with its source documents')
  })

  it('rejects cross-chain source documents and unknown protocol or epoch selections', () => {
    expect(() => buildBsc(bscManifestJson, makeEvidence('solana'))).toThrow(
      'requires BSC golden RPC evidence'
    )
    expect(() => buildSolana(solanaManifestJson, makeEvidence('bsc'))).toThrow(
      'requires Solana golden RPC evidence'
    )

    expect(() =>
      buildDexGoldenProtocolBinding({
        generated_at: GENERATED_AT,
        manifest_input: bscManifestJson,
        golden_rpc_evidence_input: makeEvidence('bsc'),
        selection: {
          chain: 'bsc',
          protocol_id: 'pancakeswap_v2',
          epoch_id: 'missing-epoch',
        },
        golden_case: {
          chain: 'bsc',
          case_id: 'missing-epoch',
          scenario_tags: ['buy'],
          expected_execution: 'succeeded',
        },
      })
    ).toThrow('epoch does not exist')

    expect(() =>
      buildDexGoldenProtocolBinding({
        generated_at: GENERATED_AT,
        manifest_input: solanaManifestJson,
        golden_rpc_evidence_input: makeEvidence('solana'),
        selection: { chain: 'solana', protocol_id: 'missing_protocol' },
        golden_case: {
          chain: 'solana',
          case_id: 'missing-protocol',
          scenario_tags: ['buy'],
          expected_execution: 'succeeded',
        },
      })
    ).toThrow('protocol does not exist')
  })

  it('keeps deployment, code epoch, and decoder fields fail closed', () => {
    const bsc = clone(buildBsc()) as any
    bsc.deployment_binding.start_block = '123'
    expect(() => parseDexGoldenProtocolBinding(bsc)).toThrow()

    const solana = clone(buildSolana()) as any
    solana.deployment_binding.code_epoch_id = 'invented'
    expect(() => parseDexGoldenProtocolBinding(solana)).toThrow()

    const decoder = clone(buildBsc()) as any
    decoder.decoder_binding.version = '1.0.0'
    decoder.decoder_binding.implementation_sha256 = hash('invented-decoder')
    decoder.claims.decoder_implementation_verified = true
    expect(() => parseDexGoldenProtocolBinding(decoder)).toThrow()

    const snapshotDrift = clone(buildSolana())
    snapshotDrift.decoder_binding.manifest_decoder_snapshot_sha256 = hash('other-decoder')
    expect(() =>
      verifyDexGoldenProtocolBinding({
        binding_input: snapshotDrift,
        manifest_input: solanaManifestJson,
        golden_rpc_evidence_input: makeEvidence('solana'),
      })
    ).toThrow('conflicts with its source documents')
  })

  it('derives the exact reference-only legal artifact closure', () => {
    const evidence = makeEvidence('bsc')
    const missingArtifact = clone(buildBsc(bscManifestJson, evidence))
    missingArtifact.legal_binding.artifact_ids = missingArtifact.legal_binding.artifact_ids.slice(1)
    expect(() =>
      verifyDexGoldenProtocolBinding({
        binding_input: missingArtifact,
        manifest_input: bscManifestJson,
        golden_rpc_evidence_input: evidence,
      })
    ).toThrow('conflicts with its source documents')

    const borrowedArtifact = clone(buildBsc(bscManifestJson, evidence))
    borrowedArtifact.legal_binding.artifact_ids = [
      ...borrowedArtifact.legal_binding.artifact_ids,
      'pancake-v3-deployments-98684794',
    ].sort()
    expect(() =>
      verifyDexGoldenProtocolBinding({
        binding_input: borrowedArtifact,
        manifest_input: bscManifestJson,
        golden_rpc_evidence_input: evidence,
      })
    ).toThrow('conflicts with its source documents')

    const cleared = clone(buildSolana()) as any
    cleared.legal_binding.state = 'cleared'
    cleared.legal_binding.commercial_reuse_authorized = true
    cleared.legal_binding.legal_decision_sha256 = hash('fake-legal-decision')
    expect(() => parseDexGoldenProtocolBinding(cleared)).toThrow()

    const hiddenReview = clone(buildSolana()) as any
    hiddenReview.legal_binding.review_requirement = 'not_required_by_seed_policy'
    expect(() => parseDexGoldenProtocolBinding(hiddenReview)).toThrow(
      'review requirement conflicts'
    )
  })

  it('preserves source blockers and every cross-binding blocker', () => {
    const evidence = makeEvidence('bsc')
    const missingSourceBlocker = clone(buildBsc(bscManifestJson, evidence))
    missingSourceBlocker.protocol_manifest.source_protocol_blockers =
      missingSourceBlocker.protocol_manifest.source_protocol_blockers.filter(
        (blocker) => blocker !== 'trace_internal_attribution_unverified'
      )
    expect(() =>
      verifyDexGoldenProtocolBinding({
        binding_input: missingSourceBlocker,
        manifest_input: bscManifestJson,
        golden_rpc_evidence_input: evidence,
      })
    ).toThrow('conflicts with its source documents')

    const missingRequired = clone(buildSolana())
    missingRequired.required_blockers = missingRequired.required_blockers.slice(1)
    expect(() => parseDexGoldenProtocolBinding(missingRequired)).toThrow(
      'preserve every canonical required blocker'
    )

    const reordered = clone(buildBsc())
    reordered.required_blockers.reverse()
    expect(() => parseDexGoldenProtocolBinding(reordered)).toThrow(
      'preserve every canonical required blocker'
    )

    const authorized = clone(buildSolana()) as any
    authorized.authorization.score = true
    expect(() => parseDexGoldenProtocolBinding(authorized)).toThrow()
  })

  it('requires internally consistent declared scenario tags without verifying them', () => {
    expect(() =>
      buildDexGoldenProtocolBinding({
        generated_at: GENERATED_AT,
        manifest_input: bscManifestJson,
        golden_rpc_evidence_input: makeEvidence('bsc'),
        selection: {
          chain: 'bsc',
          protocol_id: 'pancakeswap_v2',
          epoch_id: 'official-source-snapshot',
        },
        golden_case: {
          chain: 'bsc',
          case_id: 'failed-case',
          scenario_tags: ['failed_transaction'],
          expected_execution: 'succeeded',
        },
      })
    ).toThrow('failed_transaction consistently')

    const foreignTag = clone(buildBsc()) as any
    foreignTag.golden_case.scenario_tags = ['token_2022']
    expect(() => parseDexGoldenProtocolBinding(foreignTag)).toThrow()
  })

  it('rejects impossible time, unknown fields, and duplicate JSON keys', () => {
    expect(() =>
      buildDexGoldenProtocolBinding({
        generated_at: '2026-07-18T08:00:00.000Z',
        manifest_input: bscManifestJson,
        golden_rpc_evidence_input: makeEvidence('bsc'),
        selection: {
          chain: 'bsc',
          protocol_id: 'pancakeswap_v2',
          epoch_id: 'official-source-snapshot',
        },
        golden_case: {
          chain: 'bsc',
          case_id: 'too-early',
          scenario_tags: ['buy'],
          expected_execution: 'succeeded',
        },
      })
    ).toThrow('cannot predate')

    const unknown = clone(buildSolana()) as any
    unknown.protocol_manifest.chain_code_verified = true
    expect(() => parseDexGoldenProtocolBinding(unknown)).toThrow()

    const invalidSignature = clone(buildSolana())
    invalidSignature.golden_rpc_evidence.transaction_id = '0'.repeat(64)
    expect(() => parseDexGoldenProtocolBinding(invalidSignature)).toThrow(
      'base58-encoded 64-byte signature'
    )
    expect(() => dexGoldenProtocolBindingSha256(invalidSignature)).toThrow(
      'base58-encoded 64-byte signature'
    )

    const invalidProgram = clone(buildSolana())
    if (invalidProgram.deployment_binding.kind !== 'solana_code_epoch_unavailable') {
      throw new Error('expected a Solana binding')
    }
    invalidProgram.deployment_binding.program_id = '0'.repeat(32)
    expect(() => parseDexGoldenProtocolBinding(invalidProgram)).toThrow(
      'base58-encoded 32-byte public key'
    )

    const serialized = JSON.stringify(buildBsc())
    const duplicate = serialized.replace(
      `"schema_version":${DEX_GOLDEN_PROTOCOL_BINDING_SCHEMA_VERSION}`,
      `"schema_version":${DEX_GOLDEN_PROTOCOL_BINDING_SCHEMA_VERSION},"schema_version":${DEX_GOLDEN_PROTOCOL_BINDING_SCHEMA_VERSION}`
    )
    expect(() => parseDexGoldenProtocolBindingJson(duplicate)).toThrow('invalid strict JSON')
  })

  it('rejects superseded binding schemas and contracts instead of mutating their semantics', () => {
    expect(DEX_GOLDEN_PROTOCOL_BINDING_SCHEMA_VERSION).toBe(3)
    expect(DEX_GOLDEN_PROTOCOL_BINDING_CONTRACT).toBe('arena.dex.protocol-decoder-golden-binding@3')

    const oldSchema = clone(buildBsc()) as any
    oldSchema.schema_version = 1
    expect(() => parseDexGoldenProtocolBinding(oldSchema)).toThrow()

    const v2Schema = clone(buildBsc()) as any
    v2Schema.schema_version = 2
    expect(() => parseDexGoldenProtocolBinding(v2Schema)).toThrow()

    const oldContract = clone(buildBsc()) as any
    oldContract.data_contract = 'arena.dex.protocol-decoder-golden-binding@1'
    expect(() => parseDexGoldenProtocolBinding(oldContract)).toThrow()

    const v2Contract = clone(buildBsc()) as any
    v2Contract.data_contract = 'arena.dex.protocol-decoder-golden-binding@2'
    expect(() => parseDexGoldenProtocolBinding(v2Contract)).toThrow()

    const current = buildBsc()
    expect(current).toMatchObject({
      schema_version: DEX_GOLDEN_PROTOCOL_BINDING_SCHEMA_VERSION,
      data_contract: DEX_GOLDEN_PROTOCOL_BINDING_CONTRACT,
      golden_rpc_evidence: { data_contract: DEX_GOLDEN_RPC_EVIDENCE_CONTRACT },
    })
  })

  it('normalizes manifest set ordering and hashes semantic binding changes', () => {
    const shuffledManifest = clone(bscManifestJson)
    shuffledManifest.artifacts.reverse()
    shuffledManifest.protocols.reverse()
    for (const protocol of shuffledManifest.protocols) {
      protocol.blocking_reasons.reverse()
      protocol.decoder.required_fact_families.reverse()
    }
    expect(buildBsc(shuffledManifest)).toEqual(buildBsc(bscManifestJson))

    const baseline = buildSolana()
    const baselineHash = dexGoldenProtocolBindingSha256(baseline)
    expect(baselineHash).toBe('642abec4b6cdc6a3a0a3ca6d0e6c655b0f21ca257ce1c00869d100cc5fc21623')
    const reorderedObject = {
      authorization: baseline.authorization,
      claims: baseline.claims,
      required_blockers: baseline.required_blockers,
      legal_binding: baseline.legal_binding,
      golden_case: baseline.golden_case,
      golden_rpc_evidence: baseline.golden_rpc_evidence,
      deployment_binding: baseline.deployment_binding,
      protocol_manifest: baseline.protocol_manifest,
      chain: baseline.chain,
      decoder_binding: baseline.decoder_binding,
      generated_at: baseline.generated_at,
      verification_state: baseline.verification_state,
      proof_boundary: baseline.proof_boundary,
      purpose: baseline.purpose,
      data_contract: baseline.data_contract,
      schema_version: baseline.schema_version,
    }
    expect(dexGoldenProtocolBindingSha256(reorderedObject)).toBe(baselineHash)

    const changed = clone(baseline)
    changed.golden_case.case_id = 'jupiter-v6-multihop-002'
    expect(dexGoldenProtocolBindingSha256(changed)).not.toBe(
      dexGoldenProtocolBindingSha256(baseline)
    )
  })
})
