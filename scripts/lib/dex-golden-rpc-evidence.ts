import { createHash } from 'node:crypto'
import { z } from 'zod'

import { BSC_MAINNET_GENESIS_HASH } from '../../lib/ingest/onchain/bsc-evidence'
import { parseStrictJson } from '../../lib/ingest/onchain/strict-json'
import { SOLANA_MAINNET_GENESIS_HASH } from '../../lib/ingest/onchain/solana-evidence'
import { hasBase58DecodedByteLength } from '../../lib/utils/base58'
import { dexContractSha256 } from './dex-contract-hash'
import {
  DEX_BSC_STABLE_TRANSACTION_FACTS_CONTRACT,
  DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT,
} from './dex-golden-transaction-facts'

export const DEX_GOLDEN_RPC_EVIDENCE_SCHEMA_VERSION = 3 as const
export const DEX_GOLDEN_RPC_EVIDENCE_CONTRACT =
  'arena.dex.golden-rpc-transaction-evidence@3' as const
export const DEX_GOLDEN_RPC_EXCHANGE_BINDING_CONTRACT =
  'arena.dex.golden-rpc-exchange-binding@2' as const

export const DEX_GOLDEN_RPC_REQUIRED_BLOCKERS = [
  'decoder_facts_unverified',
  'normalized_documents_not_replayed',
  'protocol_invocation_unverified',
  'provider_independence_not_attested',
  'raw_and_normalized_bodies_not_persisted',
  'raw_blob_persistence_not_authorized',
] as const

export const DEX_BSC_GOLDEN_RPC_LANES = [
  ['chain_identity', 'eth_chainId'],
  ['genesis_block', 'eth_getBlockByNumber'],
  ['finalized_anchor_block', 'eth_getBlockByNumber'],
  ['head_diagnostic_block', 'eth_getBlockByNumber'],
  ['transaction', 'eth_getTransactionByHash'],
  ['receipt', 'eth_getTransactionReceipt'],
  ['membership_block', 'eth_getBlockByNumber'],
  ['indexed_transaction', 'eth_getTransactionByBlockNumberAndIndex'],
] as const

export const DEX_SOLANA_GOLDEN_RPC_LANES = [
  ['genesis_hash', 'getGenesisHash'],
  ['finalized_anchor_slot', 'getSlot'],
  ['finalized_anchor_produced_slots', 'getBlocks'],
  ['finalized_anchor_block', 'getBlock'],
  ['transaction', 'getTransaction'],
  ['signature_status', 'getSignatureStatuses'],
  ['membership_block', 'getBlock'],
] as const

const SHA256 = /^[0-9a-f]{64}$/
const BSC_TRANSACTION_HASH = /^0x[0-9a-f]{64}$/
const LOGICAL_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const MAX_REQUEST_BODY_BYTES = 64 * 1024
const MAX_RESPONSE_BODY_BYTES = 2 * 1024 * 1024

const REMOTE_ENDPOINTS = {
  alchemy_bnb_mainnet: {
    chain: 'bsc',
    provider_id: 'alchemy',
    origin: 'https://bnb-mainnet.g.alchemy.com',
    hash_domain: 'bsc_evidence_connection_v1',
  },
  bnb_official_public_seed: {
    chain: 'bsc',
    provider_id: 'bnb_chain',
    origin: 'https://bsc-dataseed.bnbchain.org',
    hash_domain: 'bsc_evidence_connection_v1',
  },
  bnb_official_public_seed_1: {
    chain: 'bsc',
    provider_id: 'bnb_chain',
    origin: 'https://bsc-dataseed1.bnbchain.org',
    hash_domain: 'bsc_evidence_connection_v1',
  },
  bnb_official_public_seed_2: {
    chain: 'bsc',
    provider_id: 'bnb_chain',
    origin: 'https://bsc-dataseed2.bnbchain.org',
    hash_domain: 'bsc_evidence_connection_v1',
  },
  defibit_bsc_mainnet: {
    chain: 'bsc',
    provider_id: 'defibit',
    origin: 'https://bsc-dataseed1.defibit.io',
    hash_domain: 'bsc_evidence_connection_v1',
  },
  publicnode_bsc_mainnet: {
    chain: 'bsc',
    provider_id: 'publicnode',
    origin: 'https://bsc-rpc.publicnode.com',
    hash_domain: 'bsc_evidence_connection_v1',
  },
  alchemy_solana_mainnet: {
    chain: 'solana',
    provider_id: 'alchemy',
    origin: 'https://solana-mainnet.g.alchemy.com',
    hash_domain: 'solana_evidence_connection_v1',
  },
  helius_solana_mainnet: {
    chain: 'solana',
    provider_id: 'helius',
    origin: 'https://mainnet.helius-rpc.com',
    hash_domain: 'solana_evidence_connection_v1',
  },
  publicnode_solana_mainnet: {
    chain: 'solana',
    provider_id: 'publicnode',
    origin: 'https://solana-rpc.publicnode.com',
    hash_domain: 'solana_evidence_connection_v1',
  },
  solana_official_mainnet: {
    chain: 'solana',
    provider_id: 'solana_foundation',
    origin: 'https://api.mainnet-beta.solana.com',
    hash_domain: 'solana_evidence_connection_v1',
  },
} as const

export type DexGoldenRemoteEndpointId = keyof typeof REMOTE_ENDPOINTS

const REMOTE_ENDPOINT_IDS = Object.keys(REMOTE_ENDPOINTS) as [
  DexGoldenRemoteEndpointId,
  ...DexGoldenRemoteEndpointId[],
]

function connectionHash(
  hashDomain: string,
  providerId: string,
  endpointId: string,
  origin: string
): string {
  return createHash('sha256')
    .update(JSON.stringify([hashDomain, providerId, endpointId, origin]))
    .digest('hex')
}

export function dexGoldenRemoteEndpointIdentity(endpointId: DexGoldenRemoteEndpointId) {
  const config = REMOTE_ENDPOINTS[endpointId]
  return {
    provider_id: config.provider_id,
    endpoint_id: endpointId,
    connection_hash: connectionHash(
      config.hash_domain,
      config.provider_id,
      endpointId,
      config.origin
    ),
  }
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

const sha256Schema = z
  .string()
  .regex(SHA256)
  .refine((value) => !/^0{64}$/.test(value), 'SHA-256 must be nonzero')
const canonicalTimestampSchema = z
  .string()
  .refine(isCanonicalTimestamp, 'timestamp must be canonical ISO')
const positiveByteLengthSchema = z
  .number()
  .int()
  .positive()
  .refine((value) => Number.isSafeInteger(value) && !Object.is(value, -0), {
    message: 'byte length must be a positive safe integer',
  })

const endpointSchema = z
  .object({
    provider_id: z.string().regex(LOGICAL_ID),
    endpoint_id: z.enum(REMOTE_ENDPOINT_IDS),
    connection_hash: sha256Schema,
  })
  .strict()
  .superRefine((endpoint, context) => {
    const expected = dexGoldenRemoteEndpointIdentity(endpoint.endpoint_id)
    if (
      endpoint.provider_id !== expected.provider_id ||
      endpoint.connection_hash !== expected.connection_hash
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'endpoint identity does not match the pinned secret-free RPC origin',
      })
    }
  })

const rawRequestBodySchema = z
  .object({
    sha256: sha256Schema,
    byte_length: positiveByteLengthSchema.max(MAX_REQUEST_BODY_BYTES),
    media_type: z.literal('application/json'),
    hash_basis: z.literal('utf8_json_rpc_request_body_bytes'),
    persistence_state: z.literal('not_persisted'),
    content_available_for_replay: z.literal(false),
    contains_secrets: z.literal(false),
  })
  .strict()

const rawResponseBodySchema = z
  .object({
    sha256: sha256Schema,
    byte_length: positiveByteLengthSchema.max(MAX_RESPONSE_BODY_BYTES),
    media_type: z.literal('application/json'),
    hash_basis: z.literal('fetch_content_decoded_http_entity_body_bytes_before_utf8'),
    persistence_state: z.literal('not_persisted'),
    content_available_for_replay: z.literal(false),
    contains_secrets: z.literal(false),
  })
  .strict()

const rpcExchangeSchema = z
  .object({
    lane: z.string().regex(LOGICAL_ID),
    method: z.string().min(1).max(80),
    params_sha256: sha256Schema,
    params_hash_basis: z.literal('arena_dex_json_rpc_params_v1'),
    http_status: z.number().int().min(200).max(299),
    request: rawRequestBodySchema,
    response: rawResponseBodySchema,
    exchange_binding_sha256: sha256Schema,
  })
  .strict()

const normalizedDocumentSchema = z
  .object({
    sha256: sha256Schema,
    byte_length: positiveByteLengthSchema.max(MAX_RESPONSE_BODY_BYTES),
    hash_basis: z.literal('strict_canonical_json_utf8_bytes'),
    persistence_state: z.literal('not_persisted'),
    content_available_for_replay: z.literal(false),
    contains_secrets: z.literal(false),
  })
  .strict()

const bscFinalityWitnessSchema = z
  .object({
    policy: z.literal('bsc_verified_finality_document_no_exported_semantic_hash_v1'),
    semantic_sha256: z.null(),
  })
  .strict()

const solanaFinalityWitnessSchema = z
  .object({
    policy: z.literal('solana_verified_transaction_finality_semantics_v2'),
    semantic_sha256: sha256Schema,
  })
  .strict()

const captureSchema = z
  .object({
    endpoint: endpointSchema,
    endpoint_assertion_state: z.literal('declared_not_replayed'),
    capture_completed_at: canonicalTimestampSchema,
    rpc_exchanges: z.array(rpcExchangeSchema).min(1).max(8),
    normalized_documents: z
      .object({
        chain_anchor: normalizedDocumentSchema,
        transaction_membership: normalizedDocumentSchema,
        verified_finality: normalizedDocumentSchema,
      })
      .strict(),
    provider_finality_witness: z.union([bscFinalityWitnessSchema, solanaFinalityWitnessSchema]),
    stable_transaction_facts_sha256: sha256Schema,
  })
  .strict()

const bscEnvelopeSchema = z
  .object({
    schema_version: z.literal(DEX_GOLDEN_RPC_EVIDENCE_SCHEMA_VERSION),
    data_contract: z.literal(DEX_GOLDEN_RPC_EVIDENCE_CONTRACT),
    purpose: z.literal('phase0_shadow_finality_membership_evidence_only'),
    proof_boundary: z.literal(
      'same_provider_rpc_assertions_not_cryptographic_inclusion_or_protocol_hit_proof'
    ),
    verification_state: z.literal('declared_not_replayed'),
    generated_at: canonicalTimestampSchema,
    chain: z
      .object({
        namespace: z.literal('eip155'),
        reference: z.literal('56'),
        chain_id: z.literal(56),
        genesis_hash: z.literal(BSC_MAINNET_GENESIS_HASH),
        product_source_slug: z.literal('binance_web3_bsc'),
        chain_stream_slug: z.literal('bsc_mainnet'),
      })
      .strict(),
    transaction_id: z.string().regex(BSC_TRANSACTION_HASH),
    stable_transaction_facts_contract: z.literal(DEX_BSC_STABLE_TRANSACTION_FACTS_CONTRACT),
    stable_transaction_facts_sha256: sha256Schema,
    captures: z.array(captureSchema).length(2),
    required_blockers: z.array(z.string().regex(LOGICAL_ID)).min(1),
    claims: z
      .object({
        normalized_documents_replayed: z.literal(false),
        provider_independence_verified: z.literal(false),
        finality_membership_verified: z.literal(false),
        protocol_invocation_verified: z.literal(false),
        decoder_facts_verified: z.literal(false),
      })
      .strict(),
    authorization: z
      .object({
        network_execution: z.literal(false),
        raw_blob_persistence: z.literal(false),
        decoder_fixture: z.literal(false),
        serving: z.literal(false),
        rank: z.literal(false),
        score: z.literal(false),
      })
      .strict(),
  })
  .strict()

const solanaEnvelopeSchema = z
  .object({
    schema_version: z.literal(DEX_GOLDEN_RPC_EVIDENCE_SCHEMA_VERSION),
    data_contract: z.literal(DEX_GOLDEN_RPC_EVIDENCE_CONTRACT),
    purpose: z.literal('phase0_shadow_finality_membership_evidence_only'),
    proof_boundary: z.literal(
      'same_provider_rpc_assertions_not_cryptographic_inclusion_or_protocol_hit_proof'
    ),
    verification_state: z.literal('declared_not_replayed'),
    generated_at: canonicalTimestampSchema,
    chain: z
      .object({
        namespace: z.literal('solana'),
        cluster: z.literal('mainnet-beta'),
        genesis_hash: z.literal(SOLANA_MAINNET_GENESIS_HASH),
        product_source_slug: z.literal('okx_web3_solana'),
        chain_stream_slug: z.literal('solana_mainnet'),
      })
      .strict(),
    transaction_id: z
      .string()
      .refine(
        (value) => hasBase58DecodedByteLength(value, 64),
        'Solana transaction ID must be a base58-encoded 64-byte signature'
      ),
    stable_transaction_facts_contract: z.literal(DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT),
    stable_transaction_facts_sha256: sha256Schema,
    captures: z.array(captureSchema).length(2),
    required_blockers: z.array(z.string().regex(LOGICAL_ID)).min(1),
    claims: z
      .object({
        normalized_documents_replayed: z.literal(false),
        provider_independence_verified: z.literal(false),
        finality_membership_verified: z.literal(false),
        protocol_invocation_verified: z.literal(false),
        decoder_facts_verified: z.literal(false),
      })
      .strict(),
    authorization: z
      .object({
        network_execution: z.literal(false),
        raw_blob_persistence: z.literal(false),
        decoder_fixture: z.literal(false),
        serving: z.literal(false),
        rank: z.literal(false),
        score: z.literal(false),
      })
      .strict(),
  })
  .strict()

const envelopeSchema = z.union([bscEnvelopeSchema, solanaEnvelopeSchema])

export type DexGoldenRpcEndpointIdentity = z.infer<typeof endpointSchema>
export type DexGoldenRpcExchange = z.infer<typeof rpcExchangeSchema>
export type DexGoldenRpcCapture = z.infer<typeof captureSchema>
export type DexGoldenRpcEvidence = z.infer<typeof envelopeSchema>

export interface DexGoldenRpcExchangeBindingInput {
  chain_namespace: 'eip155' | 'solana'
  transaction_id: string
  endpoint: DexGoldenRpcEndpointIdentity
  capture_completed_at: string
  exchange: Omit<DexGoldenRpcExchange, 'exchange_binding_sha256'>
}

export function dexGoldenRpcParamsSha256(method: string, params: unknown): string {
  return dexContractSha256(
    {
      domain: 'arena.dex.json-rpc-params',
      schema_id: 'arena.dex.json-rpc-params@1',
      schema_version: 1,
    },
    { method, params }
  )
}

export function dexGoldenRpcExchangeBindingSha256(input: DexGoldenRpcExchangeBindingInput): string {
  return dexContractSha256(
    {
      domain: 'arena.dex.golden-rpc-exchange-binding',
      schema_id: DEX_GOLDEN_RPC_EXCHANGE_BINDING_CONTRACT,
      schema_version: 2,
    },
    input
  )
}

function assertRequiredBlockers(evidence: DexGoldenRpcEvidence): void {
  const blockers = evidence.required_blockers
  if (
    blockers.some((blocker, index) => index > 0 && compareText(blockers[index - 1], blocker) >= 0)
  ) {
    throw new Error('golden RPC blockers must be unique and canonically sorted')
  }
  const present = new Set(blockers)
  for (const required of DEX_GOLDEN_RPC_REQUIRED_BLOCKERS) {
    if (!present.has(required)) {
      throw new Error(`golden RPC evidence is missing required blocker: ${required}`)
    }
  }
}

function assertEndpointChain(evidence: DexGoldenRpcEvidence, capture: DexGoldenRpcCapture): void {
  const endpoint = REMOTE_ENDPOINTS[capture.endpoint.endpoint_id]
  const expectedChain = evidence.chain.namespace === 'eip155' ? 'bsc' : 'solana'
  if (endpoint.chain !== expectedChain) {
    throw new Error('golden RPC capture endpoint belongs to a different chain')
  }
}

function assertCanonicalCaptures(evidence: DexGoldenRpcEvidence): void {
  const [first, second] = evidence.captures
  const firstSortKey = `${first.endpoint.provider_id}:${first.endpoint.endpoint_id}`
  const secondSortKey = `${second.endpoint.provider_id}:${second.endpoint.endpoint_id}`
  if (compareText(firstSortKey, secondSortKey) >= 0) {
    throw new Error('golden RPC captures must be distinct and canonically sorted')
  }
  if (
    first.endpoint.provider_id === second.endpoint.provider_id ||
    first.endpoint.endpoint_id === second.endpoint.endpoint_id ||
    first.endpoint.connection_hash === second.endpoint.connection_hash
  ) {
    throw new Error('golden RPC captures require two distinct remote providers')
  }
  if (
    first.stable_transaction_facts_sha256 !== evidence.stable_transaction_facts_sha256 ||
    second.stable_transaction_facts_sha256 !== evidence.stable_transaction_facts_sha256
  ) {
    throw new Error('golden RPC captures disagree on stable transaction facts')
  }
  for (const capture of evidence.captures) assertEndpointChain(evidence, capture)
}

function assertNormalizedDocuments(evidence: DexGoldenRpcEvidence): void {
  const documentHashes = evidence.captures.flatMap((capture) =>
    Object.values(capture.normalized_documents).map((document) => document.sha256)
  )
  if (new Set(documentHashes).size !== documentHashes.length) {
    throw new Error('provider-specific normalized evidence documents must be distinct')
  }
}

function assertCaptureExchanges(
  evidence: DexGoldenRpcEvidence,
  capture: DexGoldenRpcCapture
): void {
  const lanes =
    evidence.chain.namespace === 'eip155' ? DEX_BSC_GOLDEN_RPC_LANES : DEX_SOLANA_GOLDEN_RPC_LANES
  if (capture.rpc_exchanges.length !== lanes.length) {
    throw new Error('golden RPC capture does not contain the exact required lane set')
  }
  for (let index = 0; index < lanes.length; index += 1) {
    const exchange = capture.rpc_exchanges[index]
    const [expectedLane, expectedMethod] = lanes[index]
    if (exchange.lane !== expectedLane || exchange.method !== expectedMethod) {
      throw new Error('golden RPC lanes must use the canonical lane and method order')
    }
    const { exchange_binding_sha256: _binding, ...exchangeCore } = exchange
    const expectedBinding = dexGoldenRpcExchangeBindingSha256({
      chain_namespace: evidence.chain.namespace,
      transaction_id: evidence.transaction_id,
      endpoint: capture.endpoint,
      capture_completed_at: capture.capture_completed_at,
      exchange: exchangeCore,
    })
    if (exchange.exchange_binding_sha256 !== expectedBinding) {
      throw new Error('golden RPC exchange binding SHA does not match its request and response')
    }
  }
}

function assertWitnessPolicy(evidence: DexGoldenRpcEvidence): void {
  for (const capture of evidence.captures) {
    if (
      evidence.chain.namespace === 'eip155'
        ? capture.provider_finality_witness.policy !==
          'bsc_verified_finality_document_no_exported_semantic_hash_v1'
        : capture.provider_finality_witness.policy !==
          'solana_verified_transaction_finality_semantics_v2'
    ) {
      throw new Error('provider finality witness policy conflicts with the evidence chain')
    }
  }
}

function assertEnvelopeInvariants(evidence: DexGoldenRpcEvidence): void {
  const generatedAt = Date.parse(evidence.generated_at)
  if (evidence.captures.some((capture) => Date.parse(capture.capture_completed_at) > generatedAt)) {
    throw new Error('golden RPC evidence cannot be generated before a capture completes')
  }
  assertRequiredBlockers(evidence)
  assertCanonicalCaptures(evidence)
  assertNormalizedDocuments(evidence)
  assertWitnessPolicy(evidence)
  for (const capture of evidence.captures) assertCaptureExchanges(evidence, capture)
}

export function parseDexGoldenRpcEvidence(input: unknown): DexGoldenRpcEvidence {
  const evidence = envelopeSchema.parse(input)
  assertEnvelopeInvariants(evidence)
  return evidence
}

export function parseDexGoldenRpcEvidenceJson(text: string): DexGoldenRpcEvidence {
  return parseDexGoldenRpcEvidence(parseStrictJson(text))
}

export function dexGoldenRpcEvidenceSha256(input: unknown): string {
  const evidence = parseDexGoldenRpcEvidence(input)
  return dexContractSha256(
    {
      domain: 'arena.dex.golden-rpc-transaction-evidence',
      schema_id: DEX_GOLDEN_RPC_EVIDENCE_CONTRACT,
      schema_version: DEX_GOLDEN_RPC_EVIDENCE_SCHEMA_VERSION,
    },
    evidence
  )
}
