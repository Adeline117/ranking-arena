import { createHash } from 'node:crypto'

import { BSC_MAINNET_GENESIS_HASH } from '../../lib/ingest/onchain/bsc-evidence'
import { SOLANA_MAINNET_GENESIS_HASH } from '../../lib/ingest/onchain/solana-evidence'
import { base58DecodedByteLength } from '../../lib/utils/base58'
import {
  DEX_BSC_GOLDEN_RPC_LANES,
  DEX_GOLDEN_RPC_EVIDENCE_CONTRACT,
  DEX_GOLDEN_RPC_EVIDENCE_SCHEMA_VERSION,
  DEX_GOLDEN_RPC_EXCHANGE_BINDING_CONTRACT,
  DEX_GOLDEN_RPC_REQUIRED_BLOCKERS,
  DEX_SOLANA_GOLDEN_RPC_LANES,
  dexGoldenRemoteEndpointIdentity,
  dexGoldenRpcEvidenceSha256,
  dexGoldenRpcExchangeBindingSha256,
  dexGoldenRpcParamsSha256,
  parseDexGoldenRpcEvidence,
  parseDexGoldenRpcEvidenceJson,
  type DexGoldenRemoteEndpointId,
  type DexGoldenRpcCapture,
  type DexGoldenRpcEvidence,
  type DexGoldenRpcExchange,
} from '../lib/dex-golden-rpc-evidence'
import {
  DEX_BSC_STABLE_TRANSACTION_FACTS_CONTRACT,
  DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT,
} from '../lib/dex-golden-transaction-facts'

const BSC_TX = `0x${'ab'.repeat(32)}`
const SOLANA_TX =
  '4vJ9JU1bJJE96FWSJKvHsmmF5SboYzN9k7qypM1eS6KxWnL2p9wWSpP3gBF5zK7XoqT9VxpxpVZpjhmZz2HcQxZ'

function hash(label: string): string {
  return createHash('sha256').update(label).digest('hex')
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
    blob_locator: `sha256:${sha256}`,
    contains_secrets: false as const,
  }
}

function normalizedDocument(label: string) {
  const sha256 = hash(label)
  return {
    sha256,
    byte_length: label.length + 32,
    hash_basis: 'strict_canonical_json_utf8_bytes' as const,
    blob_locator: `sha256:${sha256}`,
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

function baseEnvelope(chain: 'bsc' | 'solana'): DexGoldenRpcEvidence {
  const isBsc = chain === 'bsc'
  const transactionId = isBsc ? BSC_TX : SOLANA_TX
  const stableHash = hash(`${chain}:stable`)
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

function rebuildExchangeBinding(
  evidence: DexGoldenRpcEvidence,
  captureIndex: number,
  exchangeIndex: number
): void {
  const captureValue = evidence.captures[captureIndex]
  const exchangeValue = captureValue.rpc_exchanges[exchangeIndex]
  const { exchange_binding_sha256: _binding, ...core } = exchangeValue
  exchangeValue.exchange_binding_sha256 = dexGoldenRpcExchangeBindingSha256({
    chain_namespace: evidence.chain.namespace,
    transaction_id: evidence.transaction_id,
    endpoint: captureValue.endpoint,
    capture_completed_at: captureValue.capture_completed_at,
    exchange: core,
  })
}

describe('DEX golden double-RPC evidence contract', () => {
  it('pins the v2 envelope while preserving the unchanged v1 exchange binding', () => {
    expect(DEX_GOLDEN_RPC_EVIDENCE_SCHEMA_VERSION).toBe(2)
    expect(DEX_GOLDEN_RPC_EVIDENCE_CONTRACT).toBe('arena.dex.golden-rpc-transaction-evidence@2')
    expect(DEX_GOLDEN_RPC_EXCHANGE_BINDING_CONTRACT).toBe('arena.dex.golden-rpc-exchange-binding@1')
    expect(DEX_BSC_GOLDEN_RPC_LANES).toHaveLength(8)
    expect(baseEnvelope('bsc').captures[0].rpc_exchanges[0].exchange_binding_sha256).toBe(
      'd976d46c7af66aff527a7c11e5e37b27d240198d7c397ab7c65000814042c92f'
    )
  })

  it.each(['bsc', 'solana'] as const)(
    'accepts a canonical draft-only %s finality envelope',
    (chain) => {
      const evidence = baseEnvelope(chain)
      expect(parseDexGoldenRpcEvidence(evidence)).toEqual(evidence)
      expect(dexGoldenRpcEvidenceSha256(evidence)).toBe(
        chain === 'bsc'
          ? '0dd902355dca6a62f685431f7cec687ae42c4b558033021645f0585cd178066f'
          : 'b8031f747ae37ab94163a401cda6312f026c18015e87e53c9d0f3d545f825844'
      )
    }
  )

  it('requires two genuinely different remote providers, not two BNB seed hosts', () => {
    const evidence = baseEnvelope('bsc')
    const stableHash = evidence.stable_transaction_facts_sha256
    evidence.captures = [
      capture('eip155', BSC_TX, 'bnb_official_public_seed', stableHash),
      capture('eip155', BSC_TX, 'bnb_official_public_seed_1', stableHash),
    ]
    expect(() => parseDexGoldenRpcEvidence(evidence)).toThrow('two distinct remote providers')
  })

  it('allows provider-specific witness drift but rejects stable fact disagreement', () => {
    const evidence = baseEnvelope('solana')
    expect(evidence.captures[0].provider_finality_witness.semantic_sha256).not.toBe(
      evidence.captures[1].provider_finality_witness.semantic_sha256
    )
    expect(() => parseDexGoldenRpcEvidence(evidence)).not.toThrow()

    evidence.captures[1].stable_transaction_facts_sha256 = hash('different-stable-facts')
    expect(() => parseDexGoldenRpcEvidence(evidence)).toThrow(
      'disagree on stable transaction facts'
    )
  })

  it('rejects missing, reordered, duplicated, or foreign RPC lanes', () => {
    const missing = baseEnvelope('bsc')
    missing.captures[0].rpc_exchanges.pop()
    expect(() => parseDexGoldenRpcEvidence(missing)).toThrow('exact required lane set')

    const reordered = baseEnvelope('solana')
    reordered.captures[0].rpc_exchanges.reverse()
    expect(() => parseDexGoldenRpcEvidence(reordered)).toThrow('canonical lane and method order')

    const foreign = baseEnvelope('bsc')
    foreign.captures[0].rpc_exchanges[0].method = 'getGenesisHash'
    rebuildExchangeBinding(foreign, 0, 0)
    expect(() => parseDexGoldenRpcEvidence(foreign)).toThrow('canonical lane and method order')
  })

  it('pins the produced-slot exchange at the exact Solana anchor position', () => {
    expect(DEX_SOLANA_GOLDEN_RPC_LANES).toHaveLength(7)
    expect(DEX_SOLANA_GOLDEN_RPC_LANES[2]).toEqual(['finalized_anchor_produced_slots', 'getBlocks'])
    const evidence = baseEnvelope('solana')
    for (const captureValue of evidence.captures) {
      expect(captureValue.rpc_exchanges[2]).toMatchObject({
        lane: 'finalized_anchor_produced_slots',
        method: 'getBlocks',
      })
    }
  })

  it('rejects every legacy v1 Solana envelope boundary independently', () => {
    const oldSchema = clone(baseEnvelope('solana')) as any
    oldSchema.schema_version = 1
    expect(() => parseDexGoldenRpcEvidence(oldSchema)).toThrow()

    const oldContract = clone(baseEnvelope('solana')) as any
    oldContract.data_contract = 'arena.dex.golden-rpc-transaction-evidence@1'
    expect(() => parseDexGoldenRpcEvidence(oldContract)).toThrow()

    const oldWitness = clone(baseEnvelope('solana')) as any
    oldWitness.captures[0].provider_finality_witness.policy =
      'solana_verified_transaction_finality_semantics_v1'
    expect(() => parseDexGoldenRpcEvidence(oldWitness)).toThrow()

    const oldSixLaneFixture = clone(baseEnvelope('solana'))
    for (const captureValue of oldSixLaneFixture.captures) {
      captureValue.rpc_exchanges.splice(2, 1)
      expect(captureValue.rpc_exchanges).toHaveLength(6)
    }
    expect(() => parseDexGoldenRpcEvidence(oldSixLaneFixture)).toThrow('exact required lane set')
  })

  it('binds every request and response to its exact exchange context', () => {
    const evidence = baseEnvelope('bsc')
    const first = evidence.captures[0].rpc_exchanges[0]
    const second = evidence.captures[0].rpc_exchanges[1]
    ;[first.response, second.response] = [second.response, first.response]
    expect(() => parseDexGoldenRpcEvidence(evidence)).toThrow('exchange binding SHA')
  })

  it('allows content-address reuse when two honest lanes return identical bytes', () => {
    const evidence = baseEnvelope('bsc')
    const finalized = evidence.captures[0].rpc_exchanges[2]
    const head = evidence.captures[0].rpc_exchanges[3]
    head.response = { ...finalized.response }
    rebuildExchangeBinding(evidence, 0, 3)

    expect(() => parseDexGoldenRpcEvidence(evidence)).not.toThrow()
  })

  it('pins endpoint identities to secret-free approved origins and the correct chain', () => {
    const forged = baseEnvelope('solana')
    forged.captures[0].endpoint.connection_hash = hash('forged endpoint')
    expect(() => parseDexGoldenRpcEvidence(forged)).toThrow('pinned secret-free RPC origin')

    const wrongChain = baseEnvelope('bsc')
    const stableHash = wrongChain.stable_transaction_facts_sha256
    wrongChain.captures[0] = capture('eip155', BSC_TX, 'alchemy_solana_mainnet', stableHash)
    expect(() => parseDexGoldenRpcEvidence(wrongChain)).toThrow(
      'endpoint belongs to a different chain'
    )
  })

  it('rejects a provider finality witness from the other chain', () => {
    const evidence = baseEnvelope('bsc')
    evidence.captures[0].provider_finality_witness = {
      policy: 'solana_verified_transaction_finality_semantics_v2',
      semantic_sha256: hash('foreign-solana-witness'),
    }
    expect(() => parseDexGoldenRpcEvidence(evidence)).toThrow(
      'witness policy conflicts with the evidence chain'
    )
  })

  it('rejects unsafe blob metadata, zero hashes, and oversized responses', () => {
    const wrongBasis = baseEnvelope('bsc')
    ;(wrongBasis.captures[0].rpc_exchanges[0].response as any).hash_basis =
      'json_string_reencoded_bytes'
    expect(() => parseDexGoldenRpcEvidence(wrongBasis)).toThrow()

    const zeroHash = baseEnvelope('solana')
    zeroHash.captures[0].rpc_exchanges[0].response.sha256 = '0'.repeat(64)
    expect(() => parseDexGoldenRpcEvidence(zeroHash)).toThrow('SHA-256 must be nonzero')

    const oversized = baseEnvelope('bsc')
    oversized.captures[0].rpc_exchanges[0].response.byte_length = 2 * 1024 * 1024 + 1
    expect(() => parseDexGoldenRpcEvidence(oversized)).toThrow()
  })

  it('keeps the persistent document draft-only and preserves every blocker', () => {
    const missingBlocker = baseEnvelope('bsc')
    missingBlocker.required_blockers = missingBlocker.required_blockers.filter(
      (blocker) => blocker !== 'protocol_invocation_unverified'
    )
    expect(() => parseDexGoldenRpcEvidence(missingBlocker)).toThrow('missing required blocker')

    const authorized = baseEnvelope('solana')
    ;(authorized.authorization as any).score = true
    expect(() => parseDexGoldenRpcEvidence(authorized)).toThrow()
  })

  it('rejects impossible generation time and non-success HTTP evidence', () => {
    const futureCapture = baseEnvelope('bsc')
    futureCapture.captures[0].capture_completed_at = '2026-07-18T09:02:00.000Z'
    for (let index = 0; index < futureCapture.captures[0].rpc_exchanges.length; index += 1) {
      rebuildExchangeBinding(futureCapture, 0, index)
    }
    expect(() => parseDexGoldenRpcEvidence(futureCapture)).toThrow(
      'cannot be generated before a capture completes'
    )

    const failedHttp = baseEnvelope('solana')
    failedHttp.captures[0].rpc_exchanges[0].http_status = 429
    rebuildExchangeBinding(failedHttp, 0, 0)
    expect(() => parseDexGoldenRpcEvidence(failedHttp)).toThrow()
  })

  it('rejects cross-chain identities, noncanonical capture order, and duplicate JSON keys', () => {
    expect(base58DecodedByteLength(SOLANA_TX)).toBe(64)

    const wrongIdentity = baseEnvelope('bsc')
    wrongIdentity.transaction_id = BSC_TX.toUpperCase()
    expect(() => parseDexGoldenRpcEvidence(wrongIdentity)).toThrow()

    const reordered = baseEnvelope('solana')
    reordered.captures.reverse()
    expect(() => parseDexGoldenRpcEvidence(reordered)).toThrow('canonically sorted')

    const serialized = JSON.stringify(baseEnvelope('bsc'))
    const duplicateKey = serialized.replace(
      '"schema_version":2',
      '"schema_version":2,"schema_version":2'
    )
    expect(() => parseDexGoldenRpcEvidenceJson(duplicateKey)).toThrow('invalid strict JSON')
  })

  it('rejects extra fields and keeps its canonical digest property-order independent', () => {
    const baseline = baseEnvelope('solana')
    const extra = clone(baseline) as any
    extra.claims.cryptographic_inclusion_proven = true
    expect(() => parseDexGoldenRpcEvidence(extra)).toThrow()

    const reorderedObject = {
      authorization: baseline.authorization,
      required_blockers: baseline.required_blockers,
      captures: baseline.captures,
      stable_transaction_facts_sha256: baseline.stable_transaction_facts_sha256,
      stable_transaction_facts_contract: baseline.stable_transaction_facts_contract,
      transaction_id: baseline.transaction_id,
      chain: baseline.chain,
      generated_at: baseline.generated_at,
      verification_state: baseline.verification_state,
      proof_boundary: baseline.proof_boundary,
      purpose: baseline.purpose,
      data_contract: baseline.data_contract,
      schema_version: baseline.schema_version,
      claims: baseline.claims,
    }
    expect(dexGoldenRpcEvidenceSha256(reorderedObject)).toBe(dexGoldenRpcEvidenceSha256(baseline))
  })
})
