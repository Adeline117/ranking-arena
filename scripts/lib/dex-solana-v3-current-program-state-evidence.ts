import { z } from 'zod'

import {
  RAW_RPC_REQUEST_HASH_BASIS,
  RAW_RPC_RESPONSE_HASH_BASIS,
} from '../../lib/ingest/onchain/raw-rpc-evidence'
import {
  SOLANA_BPF_LOADER_V3,
  SOLANA_PROGRAM_ACCOUNT_MAX_DECODED_BYTES,
  SOLANA_V3_PROGRAM_ACCOUNT_DATA_BYTES,
  SOLANA_V3_PROGRAMDATA_HEADER_BYTES,
  SOLANA_V3_PROGRAM_OBSERVATION_PROOF_BOUNDARY,
  type SolanaV3ProgramDeploymentObservation,
} from '../../lib/ingest/onchain/solana-program-deployment-evidence'
import { SOLANA_MAINNET_GENESIS_HASH } from '../../lib/ingest/onchain/solana-evidence'
import { hasBase58DecodedByteLength } from '../../lib/utils/base58'
import { dexContractSha256, strictCanonicalJson } from './dex-contract-hash'
import { dexGoldenRemoteEndpointIdentity } from './dex-golden-rpc-evidence'
import {
  buildDexSolanaV3StableProgramState,
  DEX_SOLANA_V3_STABLE_PROGRAM_STATE_CONTRACT,
  dexSolanaV3StableProgramStateSha256,
  parseDexSolanaV3StableProgramState,
  type DexSolanaV3StableProgramState,
} from './dex-solana-v3-stable-program-state'

export const DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_SCHEMA_VERSION = 1 as const
export const DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_CONTRACT =
  'arena.dex.solana-v3-current-program-state-evidence@1' as const
export const DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_RPC_EXCHANGE_BINDING_CONTRACT =
  'arena.dex.solana-v3-current-program-state-rpc-exchange-binding@1' as const
export const DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_SOURCE_BINDING_CONTRACT =
  'arena.dex.solana-v3-current-program-state-source-binding@1' as const
export const DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_CLOSURE_CONTRACT =
  'arena.dex.solana-v3-current-program-state-evidence-closure@1' as const
export const DEX_SOLANA_V3_CURRENT_PROGRAM_OBSERVATION_DOCUMENT_CONTRACT =
  'arena.dex.solana-v3-current-program-observation@1' as const
export const DEX_SOLANA_VERIFIED_ANCHOR_DOCUMENT_CONTRACT =
  'solana_verified_anchor_semantics_v2' as const

export const DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_PURPOSE =
  'phase0_current_loader_v3_program_state_evidence_only' as const
export const DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_PROOF_BOUNDARY =
  'two_fixed_public_solana_rpc_endpoints_replayed_from_ephemeral_raw_json_rpc_and_agree_on_current_loader_v3_program_and_programdata_account_state_only_not_provider_independence_cryptographic_finality_original_deployment_slot_historical_code_epochs_source_or_build_identity_protocol_ownership_or_invocation_decoder_facts_wallet_attribution_metrics_serving_rank_score_legal_clearance_or_publication_proof' as const
export const DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_VERIFICATION_STATE =
  'in_memory_raw_replayed_fixed_endpoint_current_state_agreement' as const

export const DEX_SOLANA_V3_PROGRAM_STATE_RPC_LANES = [
  ['genesis_hash', 'getGenesisHash'],
  ['finalized_anchor_slot', 'getSlot'],
  ['finalized_anchor_produced_slots', 'getBlocks'],
  ['finalized_anchor_block', 'getBlock'],
  ['program_accounts', 'getMultipleAccounts'],
] as const

export const DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_REQUIRED_BLOCKERS = [
  'cryptographic_finality_unverified',
  'decoder_facts_unverified',
  'historical_code_epochs_unverified',
  'legal_clearance_unverified',
  'metrics_unverified',
  'original_deployment_slot_unverified',
  'protocol_invocation_unverified',
  'protocol_ownership_unverified',
  'provider_independence_unverified',
  'raw_and_normalized_bodies_not_persisted',
  'source_build_identity_unverified',
  'wallet_attribution_unverified',
] as const

const ALLOWED_ENDPOINT_IDS = ['publicnode_solana_mainnet', 'solana_official_mainnet'] as const
const SHA256 = /^[0-9a-f]{64}$/
const DECIMAL_U64 = /^(?:0|[1-9][0-9]*)$/
const U64_MAX = (1n << 64n) - 1n
const LOGICAL_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const MAX_REQUEST_BODY_BYTES = 64 * 1024
const MAX_ANCHOR_RESPONSE_BODY_BYTES = 2 * 1024 * 1024
const MAX_PROGRAM_ACCOUNTS_RESPONSE_BODY_BYTES = 16 * 1024 * 1024
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)

function isCanonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function canonicalTimestampMs(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError('current program-state evidence timestamp must be canonical ISO')
  }
  return parsed
}

const canonicalTimestampSchema = z
  .string()
  .refine(isCanonicalTimestamp, 'timestamp must be canonical ISO')

const sha256Schema = z
  .string()
  .regex(SHA256)
  .refine((value) => !/^0{64}$/.test(value), 'SHA-256 must be nonzero')

const publicKeySchema = z
  .string()
  .refine(
    (value) => hasBase58DecodedByteLength(value, 32),
    'value must be a base58-encoded 32-byte public key'
  )

const positiveDecimalU64Schema = z.string().refine((value) => {
  return value !== '0' && value.length <= 20 && DECIMAL_U64.test(value) && BigInt(value) <= U64_MAX
}, 'value must be a positive canonical u64 decimal')

const positiveSafeIntegerDecimalSchema = positiveDecimalU64Schema.refine(
  (value) => BigInt(value) <= MAX_SAFE_INTEGER_BIGINT,
  'value must fit a positive JSON safe integer'
)

const positiveByteLengthSchema = z
  .number()
  .int()
  .positive()
  .refine((value) => Number.isSafeInteger(value) && !Object.is(value, -0), {
    message: 'byte length must be a positive safe integer',
  })

const safeUnsignedSchema = (maximum: number) =>
  z
    .number()
    .int()
    .min(0)
    .max(maximum)
    .refine((value) => Number.isSafeInteger(value) && !Object.is(value, -0), {
      message: 'value must be a nonnegative safe integer',
    })

const upgradeAuthoritySchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('present'),
      address: publicKeySchema,
    })
    .strict(),
  z
    .object({
      state: z.literal('revoked'),
      address: z.null(),
    })
    .strict(),
])

const currentProgramObservationSchema = z
  .object({
    chain: z.literal('solana'),
    semantic_state: z.literal('v3_program_and_programdata_accounts_consistent'),
    proof_boundary: z.literal(SOLANA_V3_PROGRAM_OBSERVATION_PROOF_BOUNDARY),
    loader_program_id: z.literal(SOLANA_BPF_LOADER_V3),
    program_id: publicKeySchema,
    programdata_address: publicKeySchema,
    programdata_bump_seed: safeUnsignedSchema(255),
    requested_min_context_slot_decimal: positiveSafeIntegerDecimalSchema,
    accounts_context_slot_decimal: positiveSafeIntegerDecimalSchema,
    program_account: z
      .object({
        owner: z.literal(SOLANA_BPF_LOADER_V3),
        executable: z.literal(true),
        space: z.literal(SOLANA_V3_PROGRAM_ACCOUNT_DATA_BYTES),
        data_sha256: sha256Schema,
        programdata_address: publicKeySchema,
      })
      .strict(),
    programdata_account: z
      .object({
        owner: z.literal(SOLANA_BPF_LOADER_V3),
        executable: z.literal(false),
        space: positiveByteLengthSchema
          .min(SOLANA_V3_PROGRAMDATA_HEADER_BYTES + 1)
          .max(SOLANA_PROGRAM_ACCOUNT_MAX_DECODED_BYTES),
        data_sha256: sha256Schema,
        last_modified_slot_decimal: positiveDecimalU64Schema,
        effective_slot_decimal: positiveDecimalU64Schema,
        upgrade_authority: upgradeAuthoritySchema,
        code_offset_bytes: z.literal(SOLANA_V3_PROGRAMDATA_HEADER_BYTES),
        code_byte_length: positiveByteLengthSchema.max(
          SOLANA_PROGRAM_ACCOUNT_MAX_DECODED_BYTES - SOLANA_V3_PROGRAMDATA_HEADER_BYTES
        ),
        code_sha256: sha256Schema,
        code_hash_basis: z.literal(
          'programdata_allocated_bytes_after_45_byte_state_header_including_trailing_zeros'
        ),
      })
      .strict(),
  })
  .strict()

const endpointSchema = z
  .object({
    provider_id: z.string().regex(LOGICAL_ID),
    endpoint_id: z.enum(ALLOWED_ENDPOINT_IDS),
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
        message: 'endpoint identity does not match its pinned credential-free public origin',
      })
    }
  })

const rawRequestBodySchema = z
  .object({
    sha256: sha256Schema,
    byte_length: positiveByteLengthSchema.max(MAX_REQUEST_BODY_BYTES),
    media_type: z.literal('application/json'),
    hash_basis: z.literal(RAW_RPC_REQUEST_HASH_BASIS),
    persistence_state: z.literal('not_persisted'),
    content_available_for_replay: z.literal(false),
    contains_secrets: z.literal(false),
  })
  .strict()

const rawResponseBodySchema = z
  .object({
    sha256: sha256Schema,
    byte_length: positiveByteLengthSchema.max(MAX_PROGRAM_ACCOUNTS_RESPONSE_BODY_BYTES),
    media_type: z.literal('application/json'),
    hash_basis: z.literal(RAW_RPC_RESPONSE_HASH_BASIS),
    persistence_state: z.literal('not_persisted'),
    content_available_for_replay: z.literal(false),
    contains_secrets: z.literal(false),
  })
  .strict()

const rpcExchangeCoreSchema = z
  .object({
    lane: z.enum([
      'genesis_hash',
      'finalized_anchor_slot',
      'finalized_anchor_produced_slots',
      'finalized_anchor_block',
      'program_accounts',
    ]),
    method: z.string().min(1).max(80),
    params_sha256: sha256Schema,
    params_hash_basis: z.literal('arena_dex_json_rpc_params_v1'),
    http_status: z.number().int().min(200).max(299),
    completed_at: canonicalTimestampSchema,
    request: rawRequestBodySchema,
    response: rawResponseBodySchema,
  })
  .strict()

const rpcExchangeSchema = rpcExchangeCoreSchema
  .extend({
    exchange_binding_sha256: sha256Schema,
  })
  .strict()

const anchorSchema = z
  .object({
    policy: z.literal(DEX_SOLANA_VERIFIED_ANCHOR_DOCUMENT_CONTRACT),
    observed_at: canonicalTimestampSchema,
    finalized_root_slot_decimal: positiveSafeIntegerDecimalSchema,
    selected_produced_slot_decimal: positiveSafeIntegerDecimalSchema,
    selected_blockhash: publicKeySchema,
    semantic_sha256: sha256Schema,
  })
  .strict()

const normalizedDocumentsSchema = z
  .object({
    verified_anchor: z
      .object({
        sha256: sha256Schema,
        hash_contract: z.literal(DEX_SOLANA_VERIFIED_ANCHOR_DOCUMENT_CONTRACT),
        persistence_state: z.literal('not_persisted'),
        content_available_for_replay: z.literal(false),
        contains_secrets: z.literal(false),
      })
      .strict(),
    current_program_observation: z
      .object({
        sha256: sha256Schema,
        hash_contract: z.literal(DEX_SOLANA_V3_CURRENT_PROGRAM_OBSERVATION_DOCUMENT_CONTRACT),
        persistence_state: z.literal('not_persisted'),
        content_available_for_replay: z.literal(false),
        contains_secrets: z.literal(false),
      })
      .strict(),
  })
  .strict()

const sourceCoreSchema = z
  .object({
    endpoint: endpointSchema,
    capture_completed_at: canonicalTimestampSchema,
    same_endpoint_anchor: anchorSchema,
    requested_min_context_slot_decimal: positiveSafeIntegerDecimalSchema,
    accounts_context_slot_decimal: positiveSafeIntegerDecimalSchema,
    current_state_sha256: sha256Schema,
    rpc_exchanges: z.tuple([
      rpcExchangeSchema,
      rpcExchangeSchema,
      rpcExchangeSchema,
      rpcExchangeSchema,
      rpcExchangeSchema,
    ]),
    normalized_documents: normalizedDocumentsSchema,
  })
  .strict()

const sourceSchema = sourceCoreSchema
  .extend({
    source_binding_sha256: sha256Schema,
  })
  .strict()

const claimsSchema = z
  .object({
    raw_rpc_semantics_replayed_in_memory: z.literal(true),
    required_fixed_endpoint_set_matched: z.literal(true),
    current_state_projection_agreed: z.literal(true),
    provider_independence_verified: z.literal(false),
    cryptographic_finality_verified: z.literal(false),
    original_deployment_slot_verified: z.literal(false),
    historical_code_epochs_verified: z.literal(false),
    source_build_identity_verified: z.literal(false),
    protocol_ownership_verified: z.literal(false),
    protocol_invocation_verified: z.literal(false),
    decoder_facts_verified: z.literal(false),
    wallet_attribution_verified: z.literal(false),
    metrics_verified: z.literal(false),
    legal_clearance_verified: z.literal(false),
  })
  .strict()

const authorizationSchema = z
  .object({
    network_execution: z.literal(false),
    raw_blob_persistence: z.literal(false),
    decoder_fixture: z.literal(false),
    serving: z.literal(false),
    rank: z.literal(false),
    score: z.literal(false),
  })
  .strict()

const evidenceCoreShape = {
  schema_version: z.literal(DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_SCHEMA_VERSION),
  data_contract: z.literal(DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_CONTRACT),
  purpose: z.literal(DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_PURPOSE),
  proof_boundary: z.literal(DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_PROOF_BOUNDARY),
  verification_state: z.literal(DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_VERIFICATION_STATE),
  generated_at: canonicalTimestampSchema,
  chain: z
    .object({
      namespace: z.literal('solana'),
      cluster: z.literal('mainnet-beta'),
      genesis_hash: z.literal(SOLANA_MAINNET_GENESIS_HASH),
    })
    .strict(),
  program_id: publicKeySchema,
  current_state_contract: z.literal(DEX_SOLANA_V3_STABLE_PROGRAM_STATE_CONTRACT),
  current_state_sha256: sha256Schema,
  current_state: z.unknown(),
  captures: z.tuple([sourceSchema, sourceSchema]),
  required_blockers: z.array(z.enum(DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_REQUIRED_BLOCKERS)),
  claims: claimsSchema,
  authorization: authorizationSchema,
} as const

const evidenceCoreSchema = z.object(evidenceCoreShape).strict()
const evidenceSchema = z
  .object({
    ...evidenceCoreShape,
    evidence_closure_sha256: sha256Schema,
  })
  .strict()

const exchangeBindingInputSchema = z
  .object({
    chain_namespace: z.literal('solana'),
    program_id: publicKeySchema,
    endpoint: endpointSchema,
    capture_completed_at: canonicalTimestampSchema,
    exchange: rpcExchangeCoreSchema,
  })
  .strict()

const sourceBindingInputSchema = z
  .object({
    chain_namespace: z.literal('solana'),
    program_id: publicKeySchema,
    current_state_contract: z.literal(DEX_SOLANA_V3_STABLE_PROGRAM_STATE_CONTRACT),
    current_state_sha256: sha256Schema,
    source: sourceCoreSchema,
  })
  .strict()

export type DexSolanaV3ProgramStateRpcExchangeCore = z.infer<typeof rpcExchangeCoreSchema>
export type DexSolanaV3ProgramStateRpcExchange = z.infer<typeof rpcExchangeSchema>
export type DexSolanaV3CurrentProgramStateSourceCore = z.infer<typeof sourceCoreSchema>
export type DexSolanaV3CurrentProgramStateSource = z.infer<typeof sourceSchema>
export type DexSolanaV3ProgramStateExchangeBindingInput = z.infer<typeof exchangeBindingInputSchema>
export type DexSolanaV3ProgramStateSourceBindingInput = z.infer<typeof sourceBindingInputSchema>

type RawEvidenceCore = z.infer<typeof evidenceCoreSchema>
type RawEvidence = z.infer<typeof evidenceSchema>

export type DexSolanaV3CurrentProgramStateEvidenceCore = Omit<RawEvidenceCore, 'current_state'> & {
  current_state: DexSolanaV3StableProgramState
}

export type DexSolanaV3CurrentProgramStateEvidence = Omit<RawEvidence, 'current_state'> & {
  current_state: DexSolanaV3StableProgramState
}

function exchangeCore(
  exchange: DexSolanaV3ProgramStateRpcExchange
): DexSolanaV3ProgramStateRpcExchangeCore {
  const { exchange_binding_sha256: _binding, ...core } = exchange
  return core
}

function sourceCore(
  source: DexSolanaV3CurrentProgramStateSource
): DexSolanaV3CurrentProgramStateSourceCore {
  const { source_binding_sha256: _binding, ...core } = source
  return core
}

export function dexSolanaV3ProgramStateRpcExchangeBindingSha256(
  input: DexSolanaV3ProgramStateExchangeBindingInput
): string {
  strictCanonicalJson(input)
  const parsed = exchangeBindingInputSchema.parse(input)
  return dexContractSha256(
    {
      domain: 'arena.dex.solana-v3-current-program-state-rpc-exchange-binding',
      schema_id: DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_RPC_EXCHANGE_BINDING_CONTRACT,
      schema_version: 1,
    },
    parsed
  )
}

export function dexSolanaV3ProgramStateSourceBindingSha256(
  input: DexSolanaV3ProgramStateSourceBindingInput
): string {
  strictCanonicalJson(input)
  const parsed = sourceBindingInputSchema.parse(input)
  return dexContractSha256(
    {
      domain: 'arena.dex.solana-v3-current-program-state-source-binding',
      schema_id: DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_SOURCE_BINDING_CONTRACT,
      schema_version: 1,
    },
    parsed
  )
}

export function dexSolanaV3CurrentProgramObservationDocumentSha256(input: unknown): string {
  const parsed = parseDexSolanaV3CurrentProgramObservationDocument(input)
  return dexContractSha256(
    {
      domain: 'arena.dex.solana-v3-current-program-observation',
      schema_id: DEX_SOLANA_V3_CURRENT_PROGRAM_OBSERVATION_DOCUMENT_CONTRACT,
      schema_version: 1,
    },
    parsed
  )
}

export function parseDexSolanaV3CurrentProgramObservationDocument(
  input: unknown
): SolanaV3ProgramDeploymentObservation {
  strictCanonicalJson(input)
  const parsed = currentProgramObservationSchema.parse(input)
  buildDexSolanaV3StableProgramState(parsed)
  const requestedMinimum = BigInt(parsed.requested_min_context_slot_decimal)
  const accountsContext = BigInt(parsed.accounts_context_slot_decimal)
  const effectiveSlot = BigInt(parsed.programdata_account.effective_slot_decimal)
  if (accountsContext < requestedMinimum || accountsContext < effectiveSlot) {
    throw new TypeError('current Program observation context predates its required state')
  }
  return parsed
}

function assertRpcExchanges(programId: string, source: DexSolanaV3CurrentProgramStateSource): void {
  const completedTimes: number[] = []
  for (let index = 0; index < source.rpc_exchanges.length; index += 1) {
    const exchange = source.rpc_exchanges[index]
    const [lane, method] = DEX_SOLANA_V3_PROGRAM_STATE_RPC_LANES[index]
    if (exchange.lane !== lane || exchange.method !== method) {
      throw new TypeError('current program-state RPC exchanges are not in canonical lane order')
    }
    if (
      lane !== 'program_accounts' &&
      exchange.response.byte_length > MAX_ANCHOR_RESPONSE_BODY_BYTES
    ) {
      throw new TypeError('current program-state anchor response exceeds its byte bound')
    }
    completedTimes.push(canonicalTimestampMs(exchange.completed_at))
    const expectedBinding = dexSolanaV3ProgramStateRpcExchangeBindingSha256({
      chain_namespace: 'solana',
      program_id: programId,
      endpoint: source.endpoint,
      capture_completed_at: source.capture_completed_at,
      exchange: exchangeCore(exchange),
    })
    if (exchange.exchange_binding_sha256 !== expectedBinding) {
      throw new TypeError('current program-state RPC exchange binding is invalid')
    }
  }
  const [genesisCompleted, rootCompleted, blocksCompleted, blockCompleted, programCompleted] =
    completedTimes
  const anchorObserved = canonicalTimestampMs(source.same_endpoint_anchor.observed_at)
  if (
    Math.max(genesisCompleted, rootCompleted) > blocksCompleted ||
    blocksCompleted > blockCompleted ||
    blockCompleted > anchorObserved ||
    anchorObserved > programCompleted ||
    canonicalTimestampMs(source.capture_completed_at) !== programCompleted
  ) {
    throw new TypeError('current program-state raw capture lifecycle is invalid')
  }
}

function assertSource(
  core: DexSolanaV3CurrentProgramStateEvidenceCore,
  source: DexSolanaV3CurrentProgramStateSource
): void {
  const anchor = source.same_endpoint_anchor
  const rootSlot = BigInt(anchor.finalized_root_slot_decimal)
  const selectedSlot = BigInt(anchor.selected_produced_slot_decimal)
  const requestedMinimum = BigInt(source.requested_min_context_slot_decimal)
  const accountsContext = BigInt(source.accounts_context_slot_decimal)
  const effectiveSlot = BigInt(core.current_state.programdata_account.effective_slot_decimal)
  if (
    selectedSlot > rootSlot ||
    rootSlot - selectedSlot > 512n ||
    requestedMinimum !== rootSlot ||
    accountsContext < requestedMinimum ||
    accountsContext < effectiveSlot
  ) {
    throw new TypeError('current program-state source slot relationships are invalid')
  }
  if (
    source.current_state_sha256 !== core.current_state_sha256 ||
    source.normalized_documents.verified_anchor.sha256 !== anchor.semantic_sha256
  ) {
    throw new TypeError('current program-state source normalized hashes do not close')
  }

  assertRpcExchanges(core.program_id, source)
  const expectedBinding = dexSolanaV3ProgramStateSourceBindingSha256({
    chain_namespace: 'solana',
    program_id: core.program_id,
    current_state_contract: DEX_SOLANA_V3_STABLE_PROGRAM_STATE_CONTRACT,
    current_state_sha256: core.current_state_sha256,
    source: sourceCore(source),
  })
  if (source.source_binding_sha256 !== expectedBinding) {
    throw new TypeError('current program-state source binding is invalid')
  }
}

function assertEvidenceCoreInvariants(core: DexSolanaV3CurrentProgramStateEvidenceCore): void {
  if (core.program_id !== core.current_state.program_id) {
    throw new TypeError('current program-state evidence subject differs from its stable state')
  }
  const currentStateSha256 = dexSolanaV3StableProgramStateSha256(core.current_state)
  if (core.current_state_sha256 !== currentStateSha256) {
    throw new TypeError('current program-state stable projection hash is invalid')
  }

  for (let index = 0; index < ALLOWED_ENDPOINT_IDS.length; index += 1) {
    if (core.captures[index].endpoint.endpoint_id !== ALLOWED_ENDPOINT_IDS[index]) {
      throw new TypeError(
        'current program-state captures must use the exact canonical endpoint set'
      )
    }
  }
  if (
    core.captures[0].endpoint.provider_id === core.captures[1].endpoint.provider_id ||
    core.captures[0].endpoint.connection_hash === core.captures[1].endpoint.connection_hash
  ) {
    throw new TypeError('current program-state captures must use distinct pinned endpoints')
  }
  for (const source of core.captures) assertSource(core, source)

  const generatedAtMs = canonicalTimestampMs(core.generated_at)
  if (
    core.captures.some(
      (source) => generatedAtMs < canonicalTimestampMs(source.capture_completed_at)
    )
  ) {
    throw new TypeError('current program-state evidence predates a source capture')
  }
  if (
    core.required_blockers.length !==
      DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_REQUIRED_BLOCKERS.length ||
    core.required_blockers.some(
      (blocker, index) => blocker !== DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_REQUIRED_BLOCKERS[index]
    )
  ) {
    throw new TypeError('current program-state evidence blockers are not the exact canonical set')
  }
}

function parseEvidenceCore(input: unknown): DexSolanaV3CurrentProgramStateEvidenceCore {
  strictCanonicalJson(input)
  const raw = evidenceCoreSchema.parse(input)
  const currentState = parseDexSolanaV3StableProgramState(raw.current_state)
  const core = {
    ...raw,
    current_state: currentState,
  } as DexSolanaV3CurrentProgramStateEvidenceCore
  assertEvidenceCoreInvariants(core)
  return core
}

function closureSha256(core: DexSolanaV3CurrentProgramStateEvidenceCore): string {
  return dexContractSha256(
    {
      domain: 'arena.dex.solana-v3-current-program-state-evidence-closure',
      schema_id: DEX_SOLANA_V3_CURRENT_PROGRAM_STATE_EVIDENCE_CLOSURE_CONTRACT,
      schema_version: 1,
    },
    core
  )
}

export function dexSolanaV3CurrentProgramStateEvidenceClosureSha256(input: unknown): string {
  return closureSha256(parseEvidenceCore(input))
}

export function finalizeDexSolanaV3CurrentProgramStateEvidence(
  input: unknown
): DexSolanaV3CurrentProgramStateEvidence {
  const core = parseEvidenceCore(input)
  return parseDexSolanaV3CurrentProgramStateEvidence({
    ...core,
    evidence_closure_sha256: closureSha256(core),
  })
}

export function parseDexSolanaV3CurrentProgramStateEvidence(
  input: unknown
): DexSolanaV3CurrentProgramStateEvidence {
  strictCanonicalJson(input)
  const raw = evidenceSchema.parse(input)
  const { evidence_closure_sha256: evidenceClosureSha256, ...coreInput } = raw
  const core = parseEvidenceCore(coreInput)
  const expectedClosure = closureSha256(core)
  if (evidenceClosureSha256 !== expectedClosure) {
    throw new TypeError('current program-state evidence closure hash is invalid')
  }
  return {
    ...core,
    evidence_closure_sha256: evidenceClosureSha256,
  }
}
