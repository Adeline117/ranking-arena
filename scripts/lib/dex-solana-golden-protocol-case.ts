import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'

import { parseStrictJson } from '../../lib/ingest/onchain/strict-json'
import { SOLANA_MAINNET_GENESIS_HASH } from '../../lib/ingest/onchain/solana-evidence'
import { hasBase58DecodedByteLength } from '../../lib/utils/base58'
import { dexContractSha256 } from './dex-contract-hash'
import {
  DEX_GOLDEN_RPC_EVIDENCE_CONTRACT,
  DEX_GOLDEN_RPC_REQUIRED_BLOCKERS,
  dexGoldenRemoteEndpointIdentity,
  dexGoldenRpcEvidenceSha256,
  parseDexGoldenRpcEvidence,
} from './dex-golden-rpc-evidence'
import { DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT } from './dex-golden-transaction-facts'
import {
  DEX_SOLANA_PROTOCOL_REQUIRED_BLOCKERS,
  DEX_SOLANA_PROTOCOL_MANIFEST_CONTRACT,
  dexSolanaProtocolManifestSha256,
  normalizeDexSolanaProtocolManifest,
  type DexSolanaProtocolArtifact,
} from './dex-solana-protocol-manifest'

export const DEX_SOLANA_GOLDEN_PROTOCOL_CASE_SCHEMA_VERSION = 1 as const
export const DEX_SOLANA_GOLDEN_PROTOCOL_CASE_CONTRACT =
  'arena.dex.solana-golden-protocol-case@1' as const
export const DEX_SOLANA_PROGRAM_HIT_OBSERVATION_CONTRACT =
  'arena.dex.solana-program-hit-observation@1' as const
export const DEX_SOLANA_SOURCE_OBSERVATION_BINDING_CONTRACT =
  'arena.dex.solana-program-hit-source-binding@1' as const
export const DEX_SOLANA_SOURCE_OBSERVATION_CLOSURE_CONTRACT =
  'arena.dex.solana-program-hit-source-closure@1' as const

export const DEX_SOLANA_GOLDEN_PROTOCOL_CASE_REQUIRED_BLOCKERS = [
  'commercial_decoder_clearance_unverified',
  'decoder_facts_unverified',
  'golden_case_semantic_classification_unverified',
  'golden_rpc_evidence_not_replayed',
  'normalized_documents_not_replayed',
  'program_hit_provenance_unverified',
  'protocol_artifact_integrity_unverified',
  'protocol_deployment_or_code_epoch_unverified',
  'protocol_identity_unverified',
  'protocol_invocation_semantics_unverified',
  'provider_independence_not_attested',
  'raw_and_normalized_bodies_not_persisted',
  'raw_blob_persistence_not_authorized',
] as const

const ALLOWED_ENDPOINT_IDS = ['publicnode_solana_mainnet', 'solana_official_mainnet'] as const
const LOGICAL_ID = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/
const SHA256 = /^[0-9a-f]{64}$/
const LOWER_HEX_8_BYTES = /^[0-9a-f]{16}$/
const DECIMAL_U64 = /^(?:0|[1-9][0-9]*)$/
const U64_MAX = (1n << 64n) - 1n
const MAX_INSTRUCTION_DATA_BYTES = 1232
const MAX_RESOLVED_ACCOUNT_KEYS = 256
const MAX_COMPILED_INSTRUCTIONS = 65_536

type AllowedEndpointId = (typeof ALLOWED_ENDPOINT_IDS)[number]

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isCanonicalU64(value: string): boolean {
  return value.length <= 20 && DECIMAL_U64.test(value) && BigInt(value) <= U64_MAX
}

const sha256Schema = z
  .string()
  .regex(SHA256)
  .refine((value) => !/^0{64}$/.test(value), 'SHA-256 must be nonzero')
const timestampSchema = z.string().refine(isCanonicalTimestamp, 'timestamp must be canonical ISO')
const logicalIdSchema = z.string().min(1).max(128).regex(LOGICAL_ID)
const decimalU64Schema = z.string().refine(isCanonicalU64, 'value must be a canonical u64 decimal')
function safeUnsignedSchema(maximum: number, minimum = 0) {
  return z
    .number()
    .int()
    .min(minimum)
    .max(maximum)
    .refine((value) => Number.isSafeInteger(value) && !Object.is(value, -0), {
      message: 'value must be a nonnegative safe integer',
    })
}
const publicKeySchema = z
  .string()
  .refine(
    (value) => hasBase58DecodedByteLength(value, 32),
    'value must be a base58-encoded 32-byte public key'
  )
const signatureSchema = z
  .string()
  .refine(
    (value) => hasBase58DecodedByteLength(value, 64),
    'value must be a base58-encoded 64-byte signature'
  )

const hitSchema = z
  .object({
    outer_index: safeUnsignedSchema(255),
    inner_index: safeUnsignedSchema(65_535).nullable(),
    program_id_index: safeUnsignedSchema(255),
    program_id: publicKeySchema,
    data_byte_length: safeUnsignedSchema(MAX_INSTRUCTION_DATA_BYTES),
    data_sha256: sha256Schema,
    data_prefix8_hex: z.string().regex(LOWER_HEX_8_BYTES).nullable(),
    data_hash_basis: z.literal('base58_decoded_instruction_data_bytes'),
  })
  .strict()

const observedFactsSchema = z
  .object({
    data_contract: z.literal(DEX_SOLANA_PROGRAM_HIT_OBSERVATION_CONTRACT),
    observation_state: z.literal('caller_declared_unverified_not_replayed'),
    signature: signatureSchema,
    slot_decimal: decimalU64Schema,
    blockhash: publicKeySchema,
    transaction_index_zero_based: safeUnsignedSchema(32_767),
    execution_status: z.enum(['succeeded', 'failed']),
    transaction_version: z.union([z.literal('legacy'), z.literal(0)]),
    address_lookup_table_count: safeUnsignedSchema(255),
    account_resolution_state: z.literal('all_static_and_lookup_keys_resolved'),
    resolved_account_keys_count: safeUnsignedSchema(MAX_RESOLVED_ACCOUNT_KEYS, 1),
    resolved_account_keys_root_sha256: sha256Schema,
    resolved_account_keys_hash_basis: z.literal('arena_dex_resolved_solana_account_keys_v1'),
    inner_instructions_state: z.enum(['present', 'verified_empty']),
    instruction_scope: z.literal('all_outer_and_rpc_reported_inner_instructions'),
    outer_instruction_count: safeUnsignedSchema(255, 1),
    instruction_count: safeUnsignedSchema(MAX_COMPILED_INSTRUCTIONS, 1),
    instruction_metadata_root_sha256: sha256Schema,
    instruction_metadata_hash_basis: z.literal('arena_dex_solana_instruction_metadata_v1'),
    target_program_id: publicKeySchema,
    target_hit_count: safeUnsignedSchema(MAX_COMPILED_INSTRUCTIONS, 1),
    hits: z.array(hitSchema).min(1).max(MAX_COMPILED_INSTRUCTIONS),
  })
  .strict()

const endpointSchema = z
  .object({
    provider_id: logicalIdSchema,
    endpoint_id: z.enum(ALLOWED_ENDPOINT_IDS),
    connection_hash: sha256Schema,
  })
  .strict()

const sourceObservationCoreSchema = z
  .object({
    endpoint: endpointSchema,
    capture_completed_at: timestampSchema,
    response_content_state: z.literal('not_persisted'),
    content_available_for_replay: z.literal(false),
    rpc_response_commitments: z
      .object({
        transaction_sha256: sha256Schema,
        signature_status_sha256: sha256Schema,
        membership_block_sha256: sha256Schema,
      })
      .strict(),
    protocol_observation_sha256: sha256Schema,
  })
  .strict()

const sourceObservationSchema = sourceObservationCoreSchema
  .extend({
    source_binding_sha256: sha256Schema,
  })
  .strict()

const protocolManifestBindingSchema = z
  .object({
    data_contract: z.literal(DEX_SOLANA_PROTOCOL_MANIFEST_CONTRACT),
    canonical_sha256: sha256Schema,
    evidence_as_of: timestampSchema,
    verification_state: z.literal('draft'),
    protocol_id: logicalIdSchema,
    protocol_snapshot_sha256: sha256Schema,
    manifest_declared_program_id: publicKeySchema,
    decoder_snapshot_sha256: sha256Schema,
    reference_artifact_ids: z.array(logicalIdSchema).min(1).max(32),
    reference_artifact_closure_sha256: sha256Schema,
    source_protocol_blockers: z.array(logicalIdSchema).min(1).max(64),
  })
  .strict()

const rpcEvidenceBindingSchema = z
  .object({
    data_contract: z.literal(DEX_GOLDEN_RPC_EVIDENCE_CONTRACT),
    canonical_sha256: sha256Schema,
    generated_at: timestampSchema,
    verification_state: z.literal('declared_not_replayed'),
    stable_facts_contract: z.literal(DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT),
    stable_facts_sha256: sha256Schema,
    source_evidence_blockers: z.array(logicalIdSchema).min(1).max(64),
  })
  .strict()

const goldenProtocolCaseSchema = z
  .object({
    schema_version: z.literal(DEX_SOLANA_GOLDEN_PROTOCOL_CASE_SCHEMA_VERSION),
    data_contract: z.literal(DEX_SOLANA_GOLDEN_PROTOCOL_CASE_CONTRACT),
    purpose: z.literal('phase0_solana_manifest_program_hit_candidate_binding_only'),
    proof_boundary: z.literal(
      'caller_declared_projection_and_cross_document_hash_binding_not_response_derivation_replay_finality_protocol_identity_code_epoch_decoder_or_legal_proof'
    ),
    verification_state: z.literal('declared_not_replayed'),
    generated_at: timestampSchema,
    chain: z
      .object({
        namespace: z.literal('solana'),
        cluster: z.literal('mainnet-beta'),
        genesis_hash: z.literal(SOLANA_MAINNET_GENESIS_HASH),
        product_source_slug: z.literal('okx_web3_solana'),
        chain_stream_slug: z.literal('solana_mainnet'),
      })
      .strict(),
    case: z
      .object({
        case_id: logicalIdSchema,
        selection_state: z.literal('caller_declared_manifest_program_id_candidate_unclassified'),
      })
      .strict(),
    protocol_manifest: protocolManifestBindingSchema,
    golden_rpc_evidence: rpcEvidenceBindingSchema,
    observed_facts: observedFactsSchema,
    observed_facts_sha256: sha256Schema,
    source_observations: z.array(sourceObservationSchema).length(2),
    source_observation_closure_sha256: sha256Schema,
    required_blockers: z.array(logicalIdSchema).min(1).max(64),
    claims: z
      .object({
        manifest_declared_program_id_instruction_observed_at_capture: z.literal(false),
        program_hit_provenance_verified: z.literal(false),
        normalized_documents_replayed: z.literal(false),
        provider_independence_verified: z.literal(false),
        finality_membership_verified: z.literal(false),
        protocol_identity_verified: z.literal(false),
        deployment_or_code_epoch_verified: z.literal(false),
        protocol_invocation_semantics_verified: z.literal(false),
        golden_case_semantic_classification_verified: z.literal(false),
        decoder_facts_verified: z.literal(false),
        legal_clearance_verified: z.literal(false),
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

export type DexSolanaProgramHit = z.infer<typeof hitSchema>
export type DexSolanaProgramHitObservedFacts = z.infer<typeof observedFactsSchema>
export type DexSolanaGoldenProtocolCase = z.infer<typeof goldenProtocolCaseSchema>

export interface DexSolanaGoldenProtocolCaseSourceInput {
  endpoint_id: AllowedEndpointId
  observed_facts: unknown
}

export interface DexSolanaGoldenProtocolCaseBuildInput {
  generated_at: string
  case_id: string
  protocol_id: string
  manifest_input: unknown
  golden_rpc_evidence_input: unknown
  source_observations: readonly [
    DexSolanaGoldenProtocolCaseSourceInput,
    DexSolanaGoldenProtocolCaseSourceInput,
  ]
}

export interface DexSolanaGoldenProtocolCaseVerifyInput {
  case_input: unknown
  manifest_input: unknown
  golden_rpc_evidence_input: unknown
}

function contractHash(domainSuffix: string, payload: unknown): string {
  return dexContractSha256(
    {
      domain: `arena.dex.solana-golden-protocol-case.${domainSuffix}`,
      schema_id: DEX_SOLANA_GOLDEN_PROTOCOL_CASE_CONTRACT,
      schema_version: DEX_SOLANA_GOLDEN_PROTOCOL_CASE_SCHEMA_VERSION,
    },
    payload
  )
}

export function dexSolanaProgramHitObservedFactsSha256(input: unknown): string {
  return dexContractSha256(
    {
      domain: 'arena.dex.solana-program-hit-observation',
      schema_id: DEX_SOLANA_PROGRAM_HIT_OBSERVATION_CONTRACT,
      schema_version: 1,
    },
    observedFactsSchema.parse(input)
  )
}

export function dexSolanaSourceObservationBindingSha256(input: unknown): string {
  return dexContractSha256(
    {
      domain: 'arena.dex.solana-program-hit-source-binding',
      schema_id: DEX_SOLANA_SOURCE_OBSERVATION_BINDING_CONTRACT,
      schema_version: 1,
    },
    sourceObservationCoreSchema.parse(input)
  )
}

function sourceObservationClosureSha256(
  observations: readonly z.infer<typeof sourceObservationSchema>[]
): string {
  return dexContractSha256(
    {
      domain: 'arena.dex.solana-program-hit-source-closure',
      schema_id: DEX_SOLANA_SOURCE_OBSERVATION_CLOSURE_CONTRACT,
      schema_version: 1,
    },
    observations
  )
}

function assertCanonicalStrings(values: readonly string[], label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareText(values[index - 1], values[index]) >= 0) {
      throw new Error(`${label} must be unique and canonically sorted`)
    }
  }
}

function assertContainsRequired(
  values: readonly string[],
  requiredValues: readonly string[],
  label: string
): void {
  const present = new Set(values)
  for (const required of requiredValues) {
    if (!present.has(required)) throw new Error(`${label} is missing required blocker: ${required}`)
  }
}

function compareHits(left: DexSolanaProgramHit, right: DexSolanaProgramHit): number {
  if (left.outer_index !== right.outer_index) return left.outer_index - right.outer_index
  if (left.inner_index === right.inner_index) return 0
  if (left.inner_index === null) return -1
  if (right.inner_index === null) return 1
  return left.inner_index - right.inner_index
}

function assertObservedFacts(facts: DexSolanaProgramHitObservedFacts): void {
  if (facts.target_hit_count !== facts.hits.length) {
    throw new Error('target hit count does not match the exact hit set')
  }
  if (facts.target_hit_count > facts.instruction_count) {
    throw new Error('target hit count exceeds the complete instruction count')
  }
  if (facts.outer_instruction_count > facts.instruction_count) {
    throw new Error('outer instruction count exceeds the complete instruction count')
  }
  if (facts.transaction_version === 'legacy' && facts.address_lookup_table_count !== 0) {
    throw new Error('legacy transactions cannot declare address lookup tables')
  }
  if (
    (facts.inner_instructions_state === 'verified_empty') !==
    (facts.outer_instruction_count === facts.instruction_count)
  ) {
    throw new Error('inner instruction state conflicts with the complete instruction count')
  }
  for (let index = 0; index < facts.hits.length; index += 1) {
    const hit = facts.hits[index]
    if (hit.program_id !== facts.target_program_id) {
      throw new Error('target hit resolves to a different program id')
    }
    if (hit.program_id_index >= facts.resolved_account_keys_count) {
      throw new Error('target hit program index exceeds the resolved account key set')
    }
    if (hit.outer_index >= facts.outer_instruction_count) {
      throw new Error('target hit outer index exceeds the outer instruction set')
    }
    if (hit.data_byte_length >= 8 !== (hit.data_prefix8_hex !== null)) {
      throw new Error('target hit 8-byte prefix conflicts with its decoded data length')
    }
    if (facts.inner_instructions_state === 'verified_empty' && hit.inner_index !== null) {
      throw new Error('verified-empty inner instructions cannot contain an inner hit')
    }
    if (index > 0 && compareHits(facts.hits[index - 1], hit) >= 0) {
      throw new Error('target hits must be unique and canonically sorted')
    }
  }
}

function assertEndpointIdentity(endpoint: z.infer<typeof endpointSchema>): void {
  const expected = dexGoldenRemoteEndpointIdentity(endpoint.endpoint_id)
  if (
    endpoint.provider_id !== expected.provider_id ||
    endpoint.connection_hash !== expected.connection_hash
  ) {
    throw new Error('protocol case endpoint identity is not the pinned public RPC origin')
  }
}

function assertCaseInvariants(value: DexSolanaGoldenProtocolCase): void {
  assertObservedFacts(value.observed_facts)
  if (
    value.observed_facts_sha256 !== dexSolanaProgramHitObservedFactsSha256(value.observed_facts)
  ) {
    throw new Error('observed facts SHA does not match the program-hit projection')
  }
  if (
    value.observed_facts.target_program_id !== value.protocol_manifest.manifest_declared_program_id
  ) {
    throw new Error('observed target program conflicts with the manifest declaration')
  }
  assertCanonicalStrings(value.protocol_manifest.reference_artifact_ids, 'reference artifacts')
  assertCanonicalStrings(value.protocol_manifest.source_protocol_blockers, 'protocol blockers')
  assertCanonicalStrings(value.golden_rpc_evidence.source_evidence_blockers, 'evidence blockers')
  assertContainsRequired(
    value.protocol_manifest.source_protocol_blockers,
    DEX_SOLANA_PROTOCOL_REQUIRED_BLOCKERS,
    'protocol blockers'
  )
  assertContainsRequired(
    value.golden_rpc_evidence.source_evidence_blockers,
    DEX_GOLDEN_RPC_REQUIRED_BLOCKERS,
    'evidence blockers'
  )
  if (
    value.required_blockers.length !== DEX_SOLANA_GOLDEN_PROTOCOL_CASE_REQUIRED_BLOCKERS.length ||
    value.required_blockers.some(
      (blocker, index) => blocker !== DEX_SOLANA_GOLDEN_PROTOCOL_CASE_REQUIRED_BLOCKERS[index]
    )
  ) {
    throw new Error('protocol case required blockers do not match the closed contract boundary')
  }

  const endpointKeys: string[] = []
  for (const source of value.source_observations) {
    assertEndpointIdentity(source.endpoint)
    endpointKeys.push(`${source.endpoint.provider_id}:${source.endpoint.endpoint_id}`)
    const { source_binding_sha256: _binding, ...core } = source
    if (source.source_binding_sha256 !== dexSolanaSourceObservationBindingSha256(core)) {
      throw new Error('source observation binding SHA does not match its exact metadata')
    }
    if (source.protocol_observation_sha256 !== value.observed_facts_sha256) {
      throw new Error('source observations disagree on the program-hit projection')
    }
    if (Date.parse(source.capture_completed_at) > Date.parse(value.generated_at)) {
      throw new Error('protocol case cannot predate a source capture')
    }
  }
  assertCanonicalStrings(endpointKeys, 'source observations')
  if (
    value.source_observation_closure_sha256 !==
    sourceObservationClosureSha256(value.source_observations)
  ) {
    throw new Error('source observation closure SHA does not match its two bindings')
  }
  if (
    Date.parse(value.generated_at) < Date.parse(value.protocol_manifest.evidence_as_of) ||
    Date.parse(value.generated_at) < Date.parse(value.golden_rpc_evidence.generated_at)
  ) {
    throw new Error('protocol case cannot predate a bound source document')
  }
}

export function parseDexSolanaGoldenProtocolCase(input: unknown): DexSolanaGoldenProtocolCase {
  const value = goldenProtocolCaseSchema.parse(input)
  assertCaseInvariants(value)
  return value
}

export function parseDexSolanaGoldenProtocolCaseJson(text: string): DexSolanaGoldenProtocolCase {
  return parseDexSolanaGoldenProtocolCase(parseStrictJson(text))
}

function selectedArtifacts(
  artifacts: readonly DexSolanaProtocolArtifact[],
  artifactIds: readonly string[]
): DexSolanaProtocolArtifact[] {
  return artifactIds.map((artifactId) => {
    const artifact = artifacts.find((candidate) => candidate.artifact_id === artifactId)
    if (artifact === undefined) {
      throw new Error(`selected Solana protocol references a missing artifact: ${artifactId}`)
    }
    return artifact
  })
}

function responseSha256(
  capture: ReturnType<typeof parseDexGoldenRpcEvidence>['captures'][number],
  lane: 'transaction' | 'signature_status' | 'membership_block'
): string {
  const exchange = capture.rpc_exchanges.find((candidate) => candidate.lane === lane)
  if (exchange === undefined) throw new Error(`golden RPC capture is missing lane: ${lane}`)
  return exchange.response.sha256
}

/**
 * Bind two caller-supplied, byte-free candidates to the exact manifest and
 * golden RPC metadata documents. This function deliberately cannot attest
 * that the candidates came from the discarded response bodies, so every
 * provenance and semantic claim in its output remains false.
 */
export function buildDexSolanaGoldenProtocolCase(
  input: DexSolanaGoldenProtocolCaseBuildInput
): DexSolanaGoldenProtocolCase {
  const manifest = normalizeDexSolanaProtocolManifest(input.manifest_input)
  const evidence = parseDexGoldenRpcEvidence(input.golden_rpc_evidence_input)
  if (evidence.chain.namespace !== 'solana') {
    throw new Error('Solana protocol case requires Solana golden RPC evidence')
  }
  if (
    manifest.chain.network !== evidence.chain.cluster ||
    manifest.chain.source_slug !== evidence.chain.chain_stream_slug
  ) {
    throw new Error('Solana protocol manifest chain conflicts with golden RPC evidence')
  }
  const protocol = manifest.protocols.find(
    (candidate) => candidate.protocol_id === input.protocol_id
  )
  if (protocol === undefined) {
    throw new Error(`Solana protocol does not exist: ${input.protocol_id}`)
  }
  if (
    protocol.verification_state !== 'draft' ||
    protocol.loader_evidence.state !== 'not_verified' ||
    protocol.code_epochs.length !== 0 ||
    protocol.decoder.golden_transactions_verified ||
    protocol.finality_policy !== null
  ) {
    throw new Error('protocol-hit case v1 only binds the closed draft manifest state')
  }

  if (!Array.isArray(input.source_observations) || input.source_observations.length !== 2) {
    throw new Error('protocol-hit case requires exactly two source observations')
  }
  const sourceInputs = new Map<AllowedEndpointId, DexSolanaProgramHitObservedFacts>()
  for (const source of input.source_observations) {
    if (!ALLOWED_ENDPOINT_IDS.includes(source.endpoint_id)) {
      throw new Error('protocol-hit case source endpoint is not allowed')
    }
    if (sourceInputs.has(source.endpoint_id)) {
      throw new Error('protocol-hit case source endpoints must be unique')
    }
    sourceInputs.set(source.endpoint_id, observedFactsSchema.parse(source.observed_facts))
  }

  const captures = evidence.captures.map((capture) => {
    if (!ALLOWED_ENDPOINT_IDS.includes(capture.endpoint.endpoint_id as AllowedEndpointId)) {
      throw new Error('golden RPC evidence does not use both pinned public Solana endpoints')
    }
    const endpointId = capture.endpoint.endpoint_id as AllowedEndpointId
    const facts = sourceInputs.get(endpointId)
    if (facts === undefined) {
      throw new Error('source observation is not bound to a golden RPC capture endpoint')
    }
    assertObservedFacts(facts)
    if (
      facts.signature !== evidence.transaction_id ||
      facts.target_program_id !== protocol.program_id
    ) {
      throw new Error('source observation conflicts with the bound transaction or target program')
    }
    return { capture, facts }
  })
  if (
    captures.length !== 2 ||
    sourceInputs.size !== 2 ||
    !isDeepStrictEqual(captures[0].facts, captures[1].facts)
  ) {
    throw new Error('both public RPC sources must produce identical program-hit facts')
  }

  const facts = captures[0].facts
  const observedFactsSha256 = dexSolanaProgramHitObservedFactsSha256(facts)
  const sourceObservations = captures.map(({ capture }) => {
    const endpointId = capture.endpoint.endpoint_id as AllowedEndpointId
    const core = {
      endpoint: {
        provider_id: capture.endpoint.provider_id,
        endpoint_id: endpointId,
        connection_hash: capture.endpoint.connection_hash,
      },
      capture_completed_at: capture.capture_completed_at,
      response_content_state: 'not_persisted' as const,
      content_available_for_replay: false as const,
      rpc_response_commitments: {
        transaction_sha256: responseSha256(capture, 'transaction'),
        signature_status_sha256: responseSha256(capture, 'signature_status'),
        membership_block_sha256: responseSha256(capture, 'membership_block'),
      },
      protocol_observation_sha256: observedFactsSha256,
    }
    return {
      ...core,
      source_binding_sha256: dexSolanaSourceObservationBindingSha256(core),
    }
  })
  const artifactIds = [...protocol.reference_artifact_ids].sort(compareText)
  const artifacts = selectedArtifacts(manifest.artifacts, artifactIds)

  return parseDexSolanaGoldenProtocolCase({
    schema_version: DEX_SOLANA_GOLDEN_PROTOCOL_CASE_SCHEMA_VERSION,
    data_contract: DEX_SOLANA_GOLDEN_PROTOCOL_CASE_CONTRACT,
    purpose: 'phase0_solana_manifest_program_hit_candidate_binding_only',
    proof_boundary:
      'caller_declared_projection_and_cross_document_hash_binding_not_response_derivation_replay_finality_protocol_identity_code_epoch_decoder_or_legal_proof',
    verification_state: 'declared_not_replayed',
    generated_at: input.generated_at,
    chain: {
      namespace: 'solana',
      cluster: 'mainnet-beta',
      genesis_hash: SOLANA_MAINNET_GENESIS_HASH,
      product_source_slug: evidence.chain.product_source_slug,
      chain_stream_slug: evidence.chain.chain_stream_slug,
    },
    case: {
      case_id: input.case_id,
      selection_state: 'caller_declared_manifest_program_id_candidate_unclassified',
    },
    protocol_manifest: {
      data_contract: manifest.data_contract,
      canonical_sha256: dexSolanaProtocolManifestSha256(manifest),
      evidence_as_of: manifest.evidence_as_of,
      verification_state: protocol.verification_state,
      protocol_id: protocol.protocol_id,
      protocol_snapshot_sha256: contractHash('manifest-protocol', protocol),
      manifest_declared_program_id: protocol.program_id,
      decoder_snapshot_sha256: contractHash('manifest-decoder', protocol.decoder),
      reference_artifact_ids: artifactIds,
      reference_artifact_closure_sha256: contractHash('reference-artifact-closure', artifacts),
      source_protocol_blockers: [...protocol.blocking_reasons].sort(compareText),
    },
    golden_rpc_evidence: {
      data_contract: evidence.data_contract,
      canonical_sha256: dexGoldenRpcEvidenceSha256(evidence),
      generated_at: evidence.generated_at,
      verification_state: evidence.verification_state,
      stable_facts_contract: evidence.stable_transaction_facts_contract,
      stable_facts_sha256: evidence.stable_transaction_facts_sha256,
      source_evidence_blockers: [...evidence.required_blockers],
    },
    observed_facts: facts,
    observed_facts_sha256: observedFactsSha256,
    source_observations: sourceObservations,
    source_observation_closure_sha256: sourceObservationClosureSha256(sourceObservations),
    required_blockers: [...DEX_SOLANA_GOLDEN_PROTOCOL_CASE_REQUIRED_BLOCKERS],
    claims: {
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
    },
    authorization: {
      network_execution: false,
      raw_blob_persistence: false,
      decoder_fixture: false,
      serving: false,
      rank: false,
      score: false,
    },
  })
}

/**
 * Rebuild every manifest/RPC/source commitment around the caller-declared
 * candidate and require exact equality. This proves cross-document closure,
 * not that discarded RPC response bytes were replayed or produced the facts.
 */
export function verifyDexSolanaGoldenProtocolCase(
  input: DexSolanaGoldenProtocolCaseVerifyInput
): DexSolanaGoldenProtocolCase {
  const value = parseDexSolanaGoldenProtocolCase(input.case_input)
  const rebuilt = buildDexSolanaGoldenProtocolCase({
    generated_at: value.generated_at,
    case_id: value.case.case_id,
    protocol_id: value.protocol_manifest.protocol_id,
    manifest_input: input.manifest_input,
    golden_rpc_evidence_input: input.golden_rpc_evidence_input,
    source_observations: value.source_observations.map((source) => ({
      endpoint_id: source.endpoint.endpoint_id,
      observed_facts: value.observed_facts,
    })) as [DexSolanaGoldenProtocolCaseSourceInput, DexSolanaGoldenProtocolCaseSourceInput],
  })
  if (!isDeepStrictEqual(value, rebuilt)) {
    throw new Error('Solana golden protocol case conflicts with its bound source documents')
  }
  return value
}

export function dexSolanaGoldenProtocolCaseSha256(input: unknown): string {
  const value = parseDexSolanaGoldenProtocolCase(input)
  return dexContractSha256(
    {
      domain: 'arena.dex.solana-golden-protocol-case',
      schema_id: DEX_SOLANA_GOLDEN_PROTOCOL_CASE_CONTRACT,
      schema_version: DEX_SOLANA_GOLDEN_PROTOCOL_CASE_SCHEMA_VERSION,
    },
    value
  )
}
