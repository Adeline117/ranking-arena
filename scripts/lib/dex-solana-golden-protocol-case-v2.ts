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
} from './dex-golden-rpc-evidence'
import { DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT } from './dex-golden-transaction-facts'
import {
  compileDexSolanaGoldenRpcMetadataWithProgramHits,
  disposeDexSolanaGoldenRpcMetadataInputBytes,
  type DexSolanaGoldenRpcMetadataInput,
  type DexSolanaGoldenRpcProgramHitSourceDerivation,
} from './dex-solana-golden-rpc-metadata'
import {
  DEX_SOLANA_PROGRAM_HIT_PROJECTION_CONTRACT,
  DEX_SOLANA_PROGRAM_HIT_PROJECTION_DERIVATION_STATE,
  DEX_SOLANA_PROGRAM_HIT_PROJECTION_PROOF_BOUNDARY,
  dexSolanaProgramHitProjectionSha256,
  parseDexSolanaProgramHitProjection,
  type DexSolanaProgramHitProjection,
} from './dex-solana-program-hit-projection'
import {
  DEX_SOLANA_PROTOCOL_MANIFEST_CONTRACT,
  DEX_SOLANA_PROTOCOL_REQUIRED_BLOCKERS,
  dexSolanaProtocolManifestSha256,
  normalizeDexSolanaProtocolManifest,
  type DexSolanaProtocolArtifact,
} from './dex-solana-protocol-manifest'

export const DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_SCHEMA_VERSION = 2 as const
export const DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_CONTRACT =
  'arena.dex.solana-golden-protocol-case@2' as const
export const DEX_SOLANA_PROGRAM_HIT_SOURCE_DERIVATION_V2_CONTRACT =
  'arena.dex.solana-program-hit-source-derivation@2' as const
export const DEX_SOLANA_PROGRAM_HIT_SOURCE_CLOSURE_V2_CONTRACT =
  'arena.dex.solana-program-hit-source-closure@2' as const

export const DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_REQUIRED_BLOCKERS = [
  'commercial_decoder_clearance_unverified',
  'decoder_facts_unverified',
  'finality_membership_not_cryptographically_verified',
  'golden_case_semantic_classification_unverified',
  'normalized_documents_not_replayed',
  'program_hit_persistent_replay_unavailable',
  'protocol_deployment_or_code_epoch_unverified',
  'protocol_identity_unverified',
  'protocol_invocation_semantics_unverified',
  'provider_independence_not_attested',
  'raw_and_normalized_bodies_not_persisted',
  'raw_blob_persistence_not_authorized',
] as const

const ALLOWED_ENDPOINT_IDS = ['publicnode_solana_mainnet', 'solana_official_mainnet'] as const
const SHA256 = /^[0-9a-f]{64}$/
const LOGICAL_ID = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/

type AllowedEndpointId = (typeof ALLOWED_ENDPOINT_IDS)[number]

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

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

const sha256Schema = z
  .string()
  .regex(SHA256)
  .refine((value) => !/^0{64}$/.test(value), 'SHA-256 must be nonzero')
const logicalIdSchema = z.string().min(1).max(128).regex(LOGICAL_ID)
const timestampSchema = z.string().refine(isCanonicalTimestamp, 'timestamp must be canonical ISO')
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
const endpointSchema = z
  .object({
    provider_id: logicalIdSchema,
    endpoint_id: z.enum(ALLOWED_ENDPOINT_IDS),
    connection_hash: sha256Schema,
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
    transaction_id: signatureSchema,
    stable_facts_contract: z.literal(DEX_SOLANA_STABLE_TRANSACTION_FACTS_CONTRACT),
    stable_facts_sha256: sha256Schema,
    source_evidence_blockers: z.array(logicalIdSchema).min(1).max(64),
  })
  .strict()

const commonMembershipSchema = z
  .object({
    stable_transaction_facts_sha256: sha256Schema,
    canonical_blockhash: publicKeySchema,
    transaction_index: safeUnsignedSchema(32_767),
  })
  .strict()

const projectionSchema = z.unknown().transform((input, context): DexSolanaProgramHitProjection => {
  try {
    return parseDexSolanaProgramHitProjection(input)
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'common program-hit projection is invalid',
    })
    return z.NEVER
  }
})

const sourceDerivationCoreSchema = z
  .object({
    endpoint: endpointSchema,
    capture_completed_at: timestampSchema,
    golden_rpc_evidence_sha256: sha256Schema,
    stable_transaction_facts_sha256: sha256Schema,
    canonical_blockhash: publicKeySchema,
    transaction_index: safeUnsignedSchema(32_767),
    transaction_exchange_binding_sha256: sha256Schema,
    transaction_response_sha256: sha256Schema,
    program_hit_projection_sha256: sha256Schema,
  })
  .strict()

const sourceDerivationSchema = sourceDerivationCoreSchema
  .extend({
    source_binding_sha256: sha256Schema,
  })
  .strict()

const caseSchema = z
  .object({
    schema_version: z.literal(DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_SCHEMA_VERSION),
    data_contract: z.literal(DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_CONTRACT),
    purpose: z.literal('phase0_solana_manifest_program_hit_same_lifecycle_binding_only'),
    proof_boundary: z.literal(
      'same_lifecycle_raw_response_program_hit_derivation_and_cross_document_hash_binding_only_not_persistent_replay_provider_independence_cryptographic_finality_or_membership_protocol_identity_deployment_or_code_epoch_invocation_semantics_semantic_classification_decoder_facts_or_legal_clearance'
    ),
    verification_state: z.literal('same_lifecycle_derived_not_persistently_replayable'),
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
        selection_state: z.literal(
          'manifest_program_id_observed_in_two_same_lifecycle_sources_unclassified'
        ),
      })
      .strict(),
    protocol_manifest: protocolManifestBindingSchema,
    golden_rpc_evidence: rpcEvidenceBindingSchema,
    common_transaction_membership: commonMembershipSchema,
    common_program_hit_projection: projectionSchema,
    common_program_hit_projection_sha256: sha256Schema,
    source_derivations: z.array(sourceDerivationSchema).length(2),
    source_derivation_closure_sha256: sha256Schema,
    required_blockers: z.array(logicalIdSchema).min(1).max(64),
    claims: z
      .object({
        raw_response_to_projection_derivation_verified_in_same_lifecycle: z.literal(true),
        two_source_program_hit_projection_agreement_verified_in_same_lifecycle: z.literal(true),
        manifest_program_id_instruction_observed_in_same_lifecycle: z.literal(true),
        persistent_projection_replay_available: z.literal(false),
        normalized_documents_replayed: z.literal(false),
        provider_independence_verified: z.literal(false),
        finality_membership_cryptographically_verified: z.literal(false),
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

export type DexSolanaGoldenProtocolCaseV2 = z.infer<typeof caseSchema>

export interface DexSolanaGoldenProtocolCaseV2BuildInput {
  generated_at: string
  case_id: string
  protocol_id: string
  manifest_input: unknown
  metadata_input: DexSolanaGoldenRpcMetadataInput
}

export interface DexSolanaGoldenProtocolCaseV2VerifyInput {
  case_input: unknown
  manifest_input: unknown
  metadata_input: DexSolanaGoldenRpcMetadataInput
}

type SourceDerivation = z.infer<typeof sourceDerivationSchema>
type SourceDerivationCore = z.infer<typeof sourceDerivationCoreSchema>

function caseSubHash(domainSuffix: string, payload: unknown): string {
  return dexContractSha256(
    {
      domain: `arena.dex.solana-golden-protocol-case.v2.${domainSuffix}`,
      schema_id: DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_CONTRACT,
      schema_version: DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_SCHEMA_VERSION,
    },
    payload
  )
}

export function dexSolanaProgramHitSourceDerivationV2Sha256(input: unknown): string {
  const core = sourceDerivationCoreSchema.parse(input)
  return dexContractSha256(
    {
      domain: 'arena.dex.solana-program-hit-source-derivation',
      schema_id: DEX_SOLANA_PROGRAM_HIT_SOURCE_DERIVATION_V2_CONTRACT,
      schema_version: 2,
    },
    core
  )
}

function sourceDerivationClosureSha256(sources: readonly SourceDerivation[]): string {
  return dexContractSha256(
    {
      domain: 'arena.dex.solana-program-hit-source-closure',
      schema_id: DEX_SOLANA_PROGRAM_HIT_SOURCE_CLOSURE_V2_CONTRACT,
      schema_version: 2,
    },
    sources
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

function assertEndpointIdentity(endpoint: z.infer<typeof endpointSchema>): void {
  const expected = dexGoldenRemoteEndpointIdentity(endpoint.endpoint_id)
  if (
    endpoint.provider_id !== expected.provider_id ||
    endpoint.connection_hash !== expected.connection_hash
  ) {
    throw new Error('protocol case source endpoint is not a pinned public Solana origin')
  }
}

function assertCaseInvariants(value: DexSolanaGoldenProtocolCaseV2): void {
  const projection = value.common_program_hit_projection
  if (
    value.common_program_hit_projection_sha256 !== dexSolanaProgramHitProjectionSha256(projection)
  ) {
    throw new Error('common program-hit projection SHA does not match the full projection')
  }
  if (
    projection.data_contract !== DEX_SOLANA_PROGRAM_HIT_PROJECTION_CONTRACT ||
    projection.derivation_state !== DEX_SOLANA_PROGRAM_HIT_PROJECTION_DERIVATION_STATE ||
    projection.proof_boundary !== DEX_SOLANA_PROGRAM_HIT_PROJECTION_PROOF_BOUNDARY
  ) {
    throw new Error('common program-hit projection contract boundary is invalid')
  }
  if (
    projection.signature !== value.golden_rpc_evidence.transaction_id ||
    projection.target_program_id !== value.protocol_manifest.manifest_declared_program_id ||
    projection.execution_status !== 'succeeded'
  ) {
    throw new Error('common program-hit projection conflicts with its evidence or manifest')
  }
  if (
    value.common_transaction_membership.stable_transaction_facts_sha256 !==
      value.golden_rpc_evidence.stable_facts_sha256 ||
    projection.slot_decimal.length === 0
  ) {
    throw new Error('common transaction membership conflicts with stable evidence')
  }

  assertCanonicalStrings(value.protocol_manifest.reference_artifact_ids, 'reference artifact ids')
  assertCanonicalStrings(
    value.protocol_manifest.source_protocol_blockers,
    'source protocol blockers'
  )
  assertCanonicalStrings(
    value.golden_rpc_evidence.source_evidence_blockers,
    'source evidence blockers'
  )
  assertContainsRequired(
    value.protocol_manifest.source_protocol_blockers,
    DEX_SOLANA_PROTOCOL_REQUIRED_BLOCKERS,
    'source protocol blockers'
  )
  assertContainsRequired(
    value.golden_rpc_evidence.source_evidence_blockers,
    DEX_GOLDEN_RPC_REQUIRED_BLOCKERS,
    'source evidence blockers'
  )
  if (
    value.required_blockers.length !==
      DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_REQUIRED_BLOCKERS.length ||
    value.required_blockers.some(
      (blocker, index) => blocker !== DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_REQUIRED_BLOCKERS[index]
    )
  ) {
    throw new Error('protocol case v2 required blockers do not match the closed boundary')
  }

  const endpointKeys: string[] = []
  for (const source of value.source_derivations) {
    assertEndpointIdentity(source.endpoint)
    endpointKeys.push(`${source.endpoint.provider_id}:${source.endpoint.endpoint_id}`)
    if (
      source.golden_rpc_evidence_sha256 !== value.golden_rpc_evidence.canonical_sha256 ||
      source.stable_transaction_facts_sha256 !==
        value.common_transaction_membership.stable_transaction_facts_sha256 ||
      source.canonical_blockhash !== value.common_transaction_membership.canonical_blockhash ||
      source.transaction_index !== value.common_transaction_membership.transaction_index ||
      source.program_hit_projection_sha256 !== value.common_program_hit_projection_sha256
    ) {
      throw new Error('source derivation does not close over evidence, membership, and projection')
    }
    const { source_binding_sha256: _binding, ...core } = source
    if (source.source_binding_sha256 !== dexSolanaProgramHitSourceDerivationV2Sha256(core)) {
      throw new Error('source derivation binding SHA does not match its exact metadata')
    }
    if (Date.parse(source.capture_completed_at) > Date.parse(value.generated_at)) {
      throw new Error('protocol case v2 cannot predate a source derivation')
    }
  }
  assertCanonicalStrings(endpointKeys, 'source derivations')
  if (
    value.source_derivation_closure_sha256 !==
    sourceDerivationClosureSha256(value.source_derivations)
  ) {
    throw new Error('source derivation closure SHA does not match both source bindings')
  }
  if (
    Date.parse(value.generated_at) < Date.parse(value.protocol_manifest.evidence_as_of) ||
    Date.parse(value.generated_at) < Date.parse(value.golden_rpc_evidence.generated_at)
  ) {
    throw new Error('protocol case v2 cannot predate a bound source document')
  }
}

export function parseDexSolanaGoldenProtocolCaseV2(input: unknown): DexSolanaGoldenProtocolCaseV2 {
  const value = caseSchema.parse(input)
  assertCaseInvariants(value)
  return value
}

export function parseDexSolanaGoldenProtocolCaseV2Json(
  text: string
): DexSolanaGoldenProtocolCaseV2 {
  return parseDexSolanaGoldenProtocolCaseV2(parseStrictJson(text))
}

function assertExactBuildInput(
  input: unknown
): asserts input is DexSolanaGoldenProtocolCaseV2BuildInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Solana protocol case v2 build input must be an object')
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Solana protocol case v2 build input must be a plain object')
  }
  const expected = ['generated_at', 'case_id', 'protocol_id', 'manifest_input', 'metadata_input']
  const keys = Reflect.ownKeys(input)
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== 'string' || !expected.includes(key))
  ) {
    throw new TypeError('Solana protocol case v2 build input has an unexpected shape')
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Solana protocol case v2 build input requires enumerable data properties')
    }
  }
}

function assertExactVerifyInput(
  input: unknown
): asserts input is DexSolanaGoldenProtocolCaseV2VerifyInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Solana protocol case v2 verify input must be an object')
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Solana protocol case v2 verify input must be a plain object')
  }
  const expected = ['case_input', 'manifest_input', 'metadata_input']
  const keys = Reflect.ownKeys(input)
  if (
    keys.length !== expected.length ||
    keys.some((key) => typeof key !== 'string' || !expected.includes(key))
  ) {
    throw new TypeError('Solana protocol case v2 verify input has an unexpected shape')
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(
        'Solana protocol case v2 verify input requires enumerable data properties'
      )
    }
  }
}

function ownDataProperty(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(input, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
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

function sourceCore(
  source: DexSolanaGoldenRpcProgramHitSourceDerivation,
  evidenceSha256: string,
  membership: z.infer<typeof commonMembershipSchema>
): SourceDerivationCore {
  if (!ALLOWED_ENDPOINT_IDS.includes(source.endpoint.endpoint_id as AllowedEndpointId)) {
    throw new Error('same-lifecycle compiler returned a foreign source endpoint')
  }
  const endpointId = source.endpoint.endpoint_id as AllowedEndpointId
  return {
    endpoint: {
      provider_id: source.endpoint.provider_id,
      endpoint_id: endpointId,
      connection_hash: source.endpoint.connection_hash,
    },
    capture_completed_at: source.capture_completed_at,
    golden_rpc_evidence_sha256: evidenceSha256,
    stable_transaction_facts_sha256: membership.stable_transaction_facts_sha256,
    canonical_blockhash: membership.canonical_blockhash,
    transaction_index: membership.transaction_index,
    transaction_exchange_binding_sha256: source.transaction_exchange_binding_sha256,
    transaction_response_sha256: source.transaction_response_sha256,
    program_hit_projection_sha256: source.program_hit_projection_sha256,
  }
}

function buildInternal(
  input: DexSolanaGoldenProtocolCaseV2BuildInput
): DexSolanaGoldenProtocolCaseV2 {
  assertExactBuildInput(input)
  if (!isCanonicalTimestamp(input.generated_at)) {
    throw new TypeError('protocol case v2 generated_at must be a canonical timestamp')
  }
  const manifest = normalizeDexSolanaProtocolManifest(input.manifest_input)
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
    throw new Error('protocol-hit case v2 only binds the closed draft manifest state')
  }

  const compiled = compileDexSolanaGoldenRpcMetadataWithProgramHits({
    metadata_input: input.metadata_input,
    target_program_id: protocol.program_id,
  })
  const evidence = compiled.golden_rpc_evidence
  if (
    evidence.chain.namespace !== 'solana' ||
    manifest.chain.network !== evidence.chain.cluster ||
    manifest.chain.source_slug !== evidence.chain.chain_stream_slug
  ) {
    throw new Error('Solana protocol manifest chain conflicts with golden RPC evidence')
  }
  const evidenceSha256 = dexGoldenRpcEvidenceSha256(evidence)
  const membership = { ...compiled.common_transaction_membership }
  const sources: SourceDerivation[] = compiled.source_derivations.map((source) => {
    const core = sourceCore(source, evidenceSha256, membership)
    return {
      ...core,
      source_binding_sha256: dexSolanaProgramHitSourceDerivationV2Sha256(core),
    }
  })
  const artifactIds = [...protocol.reference_artifact_ids].sort(compareText)
  const artifacts = selectedArtifacts(manifest.artifacts, artifactIds)

  return parseDexSolanaGoldenProtocolCaseV2({
    schema_version: DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_SCHEMA_VERSION,
    data_contract: DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_CONTRACT,
    purpose: 'phase0_solana_manifest_program_hit_same_lifecycle_binding_only',
    proof_boundary:
      'same_lifecycle_raw_response_program_hit_derivation_and_cross_document_hash_binding_only_not_persistent_replay_provider_independence_cryptographic_finality_or_membership_protocol_identity_deployment_or_code_epoch_invocation_semantics_semantic_classification_decoder_facts_or_legal_clearance',
    verification_state: 'same_lifecycle_derived_not_persistently_replayable',
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
      selection_state: 'manifest_program_id_observed_in_two_same_lifecycle_sources_unclassified',
    },
    protocol_manifest: {
      data_contract: manifest.data_contract,
      canonical_sha256: dexSolanaProtocolManifestSha256(manifest),
      evidence_as_of: manifest.evidence_as_of,
      verification_state: protocol.verification_state,
      protocol_id: protocol.protocol_id,
      protocol_snapshot_sha256: caseSubHash('manifest-protocol', protocol),
      manifest_declared_program_id: protocol.program_id,
      decoder_snapshot_sha256: caseSubHash('manifest-decoder', protocol.decoder),
      reference_artifact_ids: artifactIds,
      reference_artifact_closure_sha256: caseSubHash('reference-artifact-closure', artifacts),
      source_protocol_blockers: [...protocol.blocking_reasons].sort(compareText),
    },
    golden_rpc_evidence: {
      data_contract: evidence.data_contract,
      canonical_sha256: evidenceSha256,
      generated_at: evidence.generated_at,
      verification_state: evidence.verification_state,
      transaction_id: evidence.transaction_id,
      stable_facts_contract: evidence.stable_transaction_facts_contract,
      stable_facts_sha256: evidence.stable_transaction_facts_sha256,
      source_evidence_blockers: [...evidence.required_blockers],
    },
    common_transaction_membership: membership,
    common_program_hit_projection: compiled.common_program_hit_projection,
    common_program_hit_projection_sha256: compiled.common_program_hit_projection_sha256,
    source_derivations: sources,
    source_derivation_closure_sha256: sourceDerivationClosureSha256(sources),
    required_blockers: [...DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_REQUIRED_BLOCKERS],
    claims: {
      raw_response_to_projection_derivation_verified_in_same_lifecycle: true,
      two_source_program_hit_projection_agreement_verified_in_same_lifecycle: true,
      manifest_program_id_instruction_observed_in_same_lifecycle: true,
      persistent_projection_replay_available: false,
      normalized_documents_replayed: false,
      provider_independence_verified: false,
      finality_membership_cryptographically_verified: false,
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

export function buildDexSolanaGoldenProtocolCaseV2(
  input: DexSolanaGoldenProtocolCaseV2BuildInput
): DexSolanaGoldenProtocolCaseV2 {
  let ownedMetadataInput: unknown
  try {
    ownedMetadataInput = ownDataProperty(input, 'metadata_input')
    return buildInternal(input)
  } finally {
    disposeDexSolanaGoldenRpcMetadataInputBytes(ownedMetadataInput)
  }
}

export function verifyDexSolanaGoldenProtocolCaseV2(
  input: DexSolanaGoldenProtocolCaseV2VerifyInput
): DexSolanaGoldenProtocolCaseV2 {
  let ownedMetadataInput: unknown
  try {
    ownedMetadataInput = ownDataProperty(input, 'metadata_input')
    assertExactVerifyInput(input)
    const value = parseDexSolanaGoldenProtocolCaseV2(input.case_input)
    const rebuilt = buildDexSolanaGoldenProtocolCaseV2({
      generated_at: value.generated_at,
      case_id: value.case.case_id,
      protocol_id: value.protocol_manifest.protocol_id,
      manifest_input: input.manifest_input,
      metadata_input: input.metadata_input,
    })
    if (!isDeepStrictEqual(value, rebuilt)) {
      throw new Error('Solana golden protocol case v2 conflicts with its recompiled sources')
    }
    return value
  } finally {
    disposeDexSolanaGoldenRpcMetadataInputBytes(ownedMetadataInput)
  }
}

export function dexSolanaGoldenProtocolCaseV2Sha256(input: unknown): string {
  const value = parseDexSolanaGoldenProtocolCaseV2(input)
  return dexContractSha256(
    {
      domain: 'arena.dex.solana-golden-protocol-case',
      schema_id: DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_CONTRACT,
      schema_version: DEX_SOLANA_GOLDEN_PROTOCOL_CASE_V2_SCHEMA_VERSION,
    },
    value
  )
}
