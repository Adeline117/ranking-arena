import { createHash } from 'node:crypto'
import { z } from 'zod'

import {
  normalizeSolanaTxEvidenceResult,
  SOLANA_MAX_CPI_INSTRUCTION_DATA_BYTES,
  SOLANA_MAX_INSTRUCTION_TRACE_LENGTH,
  SOLANA_PACKET_DATA_SIZE_BYTES,
  type SolanaInstructionEvidence,
  type SolanaNormalizedTxResult,
} from '../../lib/ingest/onchain/solana-fetch'
import { decodeBase58BytesBounded, hasBase58DecodedByteLength } from '../../lib/utils/base58'
import { dexContractSha256 } from './dex-contract-hash'

export const DEX_SOLANA_PROGRAM_HIT_PROJECTION_SCHEMA_VERSION = 1 as const
export const DEX_SOLANA_PROGRAM_HIT_PROJECTION_CONTRACT =
  'arena.dex.solana-program-hit-projection@1' as const
export const DEX_SOLANA_RESOLVED_ACCOUNT_KEYS_ROOT_CONTRACT =
  'arena.dex.solana-resolved-account-keys@1' as const
export const DEX_SOLANA_INSTRUCTION_METADATA_ROOT_CONTRACT =
  'arena.dex.solana-instruction-metadata@1' as const
export const DEX_SOLANA_RESOLVED_ACCOUNT_KEYS_HASH_BASIS =
  'arena_dex_resolved_solana_account_keys_v1' as const
export const DEX_SOLANA_INSTRUCTION_METADATA_HASH_BASIS =
  'arena_dex_solana_instruction_metadata_v1' as const
export const DEX_SOLANA_INSTRUCTION_DATA_HASH_BASIS =
  'base58_decoded_instruction_data_bytes' as const
export const DEX_SOLANA_PROGRAM_HIT_PROJECTION_DERIVATION_STATE =
  'caller_supplied_transaction_result_normalized_in_memory_unbound_to_capture' as const
export const DEX_SOLANA_PROGRAM_HIT_PROJECTION_PROOF_BOUNDARY =
  'strict_transaction_shape_account_resolution_instruction_metadata_and_exact_program_id_equality_only_not_capture_provenance_finality_membership_provider_independence_protocol_identity_deployment_or_code_epoch_invocation_semantics_semantic_classification_decoder_facts_or_legal_clearance' as const

const SHA256 = /^[0-9a-f]{64}$/
const LOWER_HEX_8_BYTES = /^[0-9a-f]{16}$/
const DECIMAL_U64 = /^(?:0|[1-9][0-9]*)$/
const U64_MAX = (1n << 64n) - 1n
const MAX_RESOLVED_ACCOUNT_KEYS = 256
const MAX_ADDRESS_TABLE_LOOKUPS = 255
const TYPED_ARRAY_FILL = Uint8Array.prototype.fill
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype) as object,
  'length'
)?.get

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

const signatureSchema = z
  .string()
  .refine(
    (value) => hasBase58DecodedByteLength(value, 64),
    'value must be a base58-encoded 64-byte signature'
  )

const publicKeySchema = z
  .string()
  .refine(
    (value) => hasBase58DecodedByteLength(value, 32),
    'value must be a base58-encoded 32-byte public key'
  )

const sha256Schema = z
  .string()
  .regex(SHA256)
  .refine((value) => !/^0{64}$/.test(value), 'SHA-256 must be nonzero')

const decimalU64Schema = z.string().refine((value) => {
  return value.length <= 20 && DECIMAL_U64.test(value) && BigInt(value) <= U64_MAX
}, 'value must be a canonical u64 decimal')

const projectionInputSchema = z
  .object({
    signature: signatureSchema,
    target_program_id: publicKeySchema,
    transaction_result: z.unknown(),
  })
  .strict()
  .refine((value) => Object.hasOwn(value, 'transaction_result'), {
    message: 'transaction_result is required',
  })

const hitSchema = z
  .object({
    outer_index: safeUnsignedSchema(SOLANA_MAX_INSTRUCTION_TRACE_LENGTH - 1),
    inner_index: safeUnsignedSchema(SOLANA_MAX_INSTRUCTION_TRACE_LENGTH - 1).nullable(),
    program_id_index: safeUnsignedSchema(MAX_RESOLVED_ACCOUNT_KEYS - 1),
    program_id: publicKeySchema,
    data_byte_length: safeUnsignedSchema(SOLANA_MAX_CPI_INSTRUCTION_DATA_BYTES),
    data_sha256: sha256Schema,
    data_prefix8_hex: z.string().regex(LOWER_HEX_8_BYTES).nullable(),
    data_hash_basis: z.literal(DEX_SOLANA_INSTRUCTION_DATA_HASH_BASIS),
  })
  .strict()

const projectionSchema = z
  .object({
    schema_version: z.literal(DEX_SOLANA_PROGRAM_HIT_PROJECTION_SCHEMA_VERSION),
    data_contract: z.literal(DEX_SOLANA_PROGRAM_HIT_PROJECTION_CONTRACT),
    derivation_state: z.literal(DEX_SOLANA_PROGRAM_HIT_PROJECTION_DERIVATION_STATE),
    proof_boundary: z.literal(DEX_SOLANA_PROGRAM_HIT_PROJECTION_PROOF_BOUNDARY),
    signature: signatureSchema,
    slot_decimal: decimalU64Schema,
    transaction_version: z.union([z.literal('legacy'), z.literal(0)]),
    execution_status: z.literal('succeeded'),
    address_lookup_table_count: safeUnsignedSchema(MAX_ADDRESS_TABLE_LOOKUPS),
    account_resolution_state: z.literal('all_static_and_lookup_keys_resolved'),
    resolved_account_keys_count: safeUnsignedSchema(MAX_RESOLVED_ACCOUNT_KEYS, 1),
    resolved_account_keys_root_sha256: sha256Schema,
    resolved_account_keys_hash_basis: z.literal(DEX_SOLANA_RESOLVED_ACCOUNT_KEYS_HASH_BASIS),
    inner_instructions_state: z.enum(['present', 'verified_empty']),
    instruction_scope: z.literal('all_declared_outer_and_rpc_reported_inner_instructions'),
    outer_instruction_count: safeUnsignedSchema(SOLANA_MAX_INSTRUCTION_TRACE_LENGTH, 1),
    instruction_count: safeUnsignedSchema(SOLANA_MAX_INSTRUCTION_TRACE_LENGTH, 1),
    instruction_metadata_root_sha256: sha256Schema,
    instruction_metadata_hash_basis: z.literal(DEX_SOLANA_INSTRUCTION_METADATA_HASH_BASIS),
    target_program_id: publicKeySchema,
    target_hit_count: safeUnsignedSchema(SOLANA_MAX_INSTRUCTION_TRACE_LENGTH, 1),
    hits: z.array(hitSchema).min(1).max(SOLANA_MAX_INSTRUCTION_TRACE_LENGTH),
  })
  .strict()

export interface DexSolanaProgramHitProjectionInput {
  signature: string
  target_program_id: string
  transaction_result: unknown
}

export type DexSolanaProgramHit = z.infer<typeof hitSchema>
export type DexSolanaProgramHitProjection = z.infer<typeof projectionSchema>

interface CanonicalInstructionMetadata {
  ordinal: number
  outer_index: number
  inner_index: number | null
  program_id_index: number
  program_id: string
  account_indexes: number[]
  stack_height: number | null
  data_byte_length: number
  data_sha256: string
  data_prefix8_hex: string | null
}

function parseProjectionInput(input: unknown): DexSolanaProgramHitProjectionInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Solana program-hit projection input must be an object')
  }
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Solana program-hit projection input must be a plain object')
  }
  const expectedKeys = ['signature', 'target_program_id', 'transaction_result']
  const ownKeys = Reflect.ownKeys(input)
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) {
    throw new TypeError('Solana program-hit projection input must contain exactly three fields')
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(
        'Solana program-hit projection input fields must be enumerable data properties'
      )
    }
  }
  return projectionInputSchema.parse(input)
}

function compareHits(left: DexSolanaProgramHit, right: DexSolanaProgramHit): number {
  if (left.outer_index !== right.outer_index) return left.outer_index - right.outer_index
  if (left.inner_index === right.inner_index) return 0
  if (left.inner_index === null) return -1
  if (right.inner_index === null) return 1
  return left.inner_index - right.inner_index
}

function assertProjectionInvariants(projection: DexSolanaProgramHitProjection): void {
  if (projection.target_hit_count !== projection.hits.length) {
    throw new TypeError('target hit count does not match the exact hit set')
  }
  if (projection.target_hit_count > projection.instruction_count) {
    throw new TypeError('target hit count exceeds the complete instruction count')
  }
  if (projection.outer_instruction_count > projection.instruction_count) {
    throw new TypeError('outer instruction count exceeds the complete instruction count')
  }
  if (projection.transaction_version === 'legacy' && projection.address_lookup_table_count !== 0) {
    throw new TypeError('legacy transactions cannot declare address lookup tables')
  }
  if (
    projection.inner_instructions_state === 'verified_empty'
      ? projection.outer_instruction_count !== projection.instruction_count
      : projection.outer_instruction_count >= projection.instruction_count
  ) {
    throw new TypeError('inner instruction state conflicts with the complete instruction count')
  }

  for (let index = 0; index < projection.hits.length; index += 1) {
    const hit = projection.hits[index]
    if (hit.program_id !== projection.target_program_id) {
      throw new TypeError('target hit resolves to a different program id')
    }
    if (hit.program_id_index >= projection.resolved_account_keys_count) {
      throw new TypeError('target hit program index exceeds the resolved account key set')
    }
    if (hit.outer_index >= projection.outer_instruction_count) {
      throw new TypeError('target hit outer index exceeds the outer instruction set')
    }
    if (hit.data_byte_length >= 8 !== (hit.data_prefix8_hex !== null)) {
      throw new TypeError('target hit 8-byte prefix conflicts with its decoded data length')
    }
    if (
      hit.inner_index === null
        ? hit.data_byte_length > SOLANA_PACKET_DATA_SIZE_BYTES
        : hit.data_byte_length > SOLANA_MAX_CPI_INSTRUCTION_DATA_BYTES
    ) {
      throw new TypeError('target hit data exceeds its instruction-path byte bound')
    }
    if (projection.inner_instructions_state === 'verified_empty' && hit.inner_index !== null) {
      throw new TypeError('verified-empty inner instructions cannot contain an inner hit')
    }
    if (index > 0 && compareHits(projection.hits[index - 1], hit) >= 0) {
      throw new TypeError('target hits must be unique and in canonical instruction order')
    }
  }
}

export function parseDexSolanaProgramHitProjection(input: unknown): DexSolanaProgramHitProjection {
  const parsed = projectionSchema.parse(input)
  assertProjectionInvariants(parsed)
  return parsed
}

function resolvedAccountKeysRootSha256(normalized: SolanaNormalizedTxResult): string {
  const writableOrigins = normalized.addressTableLookups
    .flatMap((lookup, lookupOrdinal) =>
      lookup.writableIndexes.map((tableIndex) => ({
        lookup_ordinal: lookupOrdinal,
        lane: 'writable' as const,
        table_account: lookup.tableAccount,
        table_index: tableIndex,
      }))
    )
    .map((origin, loadedOrdinal) => ({ ...origin, loaded_ordinal: loadedOrdinal }))
  const readonlyOrigins = normalized.addressTableLookups
    .flatMap((lookup, lookupOrdinal) =>
      lookup.readonlyIndexes.map((tableIndex) => ({
        lookup_ordinal: lookupOrdinal,
        lane: 'readonly' as const,
        table_account: lookup.tableAccount,
        table_index: tableIndex,
      }))
    )
    .map((origin, loadedOrdinal) => ({ ...origin, loaded_ordinal: loadedOrdinal }))
  if (
    writableOrigins.length !== normalized.loadedAddresses.writable.length ||
    readonlyOrigins.length !== normalized.loadedAddresses.readonly.length
  ) {
    throw new TypeError('normalized lookup origins conflict with loaded address lanes')
  }
  const staticAccountKeyCount = normalized.staticAccountKeys.length
  const resolvedAccountKeys = normalized.accountKeys.map((account) => {
    if (account.source === 'transaction') {
      if (
        account.index >= staticAccountKeyCount ||
        account.lookup !== null ||
        account.pubkey !== normalized.staticAccountKeys[account.index]
      ) {
        throw new TypeError('normalized static account key origin is inconsistent')
      }
      return {
        index: account.index,
        pubkey: account.pubkey,
        source: 'transaction' as const,
        signer: account.signer,
        writable: account.writable,
        lookup: null,
      }
    }

    const loadedIndex = account.index - staticAccountKeyCount
    const isWritableLane = loadedIndex < writableOrigins.length
    const laneOrdinal = isWritableLane ? loadedIndex : loadedIndex - writableOrigins.length
    const origin = isWritableLane ? writableOrigins[laneOrdinal] : readonlyOrigins[laneOrdinal]
    const loadedPubkey = isWritableLane
      ? normalized.loadedAddresses.writable[laneOrdinal]
      : normalized.loadedAddresses.readonly[laneOrdinal]
    if (
      loadedIndex < 0 ||
      origin === undefined ||
      loadedPubkey === undefined ||
      account.lookup === null ||
      account.lookup.tableAccount !== origin.table_account ||
      account.lookup.tableIndex !== origin.table_index ||
      account.pubkey !== loadedPubkey ||
      account.signer ||
      account.writable !== isWritableLane
    ) {
      throw new TypeError('normalized lookup account key origin is inconsistent')
    }
    return {
      index: account.index,
      pubkey: account.pubkey,
      source: 'lookup_table' as const,
      signer: account.signer,
      writable: account.writable,
      lookup: origin,
    }
  })

  return dexContractSha256(
    {
      domain: 'arena.dex.solana-resolved-account-keys',
      schema_id: DEX_SOLANA_RESOLVED_ACCOUNT_KEYS_ROOT_CONTRACT,
      schema_version: 1,
    },
    {
      transaction_version: normalized.version,
      static_account_keys: normalized.staticAccountKeys.map((pubkey) => pubkey),
      address_table_lookups: normalized.addressTableLookups.map((lookup, lookupOrdinal) => ({
        lookup_ordinal: lookupOrdinal,
        table_account: lookup.tableAccount,
        writable_indexes: lookup.writableIndexes.map((index) => index),
        readonly_indexes: lookup.readonlyIndexes.map((index) => index),
      })),
      loaded_addresses: {
        writable: normalized.loadedAddresses.writable.map((pubkey) => pubkey),
        readonly: normalized.loadedAddresses.readonly.map((pubkey) => pubkey),
      },
      resolved_account_keys: resolvedAccountKeys,
    }
  )
}

function assertCanonicalInstructionOrder(
  instructions: readonly SolanaInstructionEvidence[]
): number {
  let outerInstructionCount = 0
  let activeOuterIndex = -1
  let expectedInnerIndex = 0

  for (const instruction of instructions) {
    if (instruction.path.kind === 'outer') {
      if (instruction.path.outerIndex !== outerInstructionCount) {
        throw new TypeError('normalized outer instructions are not in canonical order')
      }
      activeOuterIndex = instruction.path.outerIndex
      expectedInnerIndex = 0
      outerInstructionCount += 1
      continue
    }
    if (
      instruction.path.outerIndex !== activeOuterIndex ||
      instruction.path.innerIndex !== expectedInnerIndex
    ) {
      throw new TypeError('normalized inner instructions are not in canonical order')
    }
    expectedInnerIndex += 1
  }
  return outerInstructionCount
}

function firstEightBytesHex(value: Uint8Array): string {
  let prefix = ''
  for (let index = 0; index < 8; index += 1) {
    prefix += value[index].toString(16).padStart(2, '0')
  }
  return prefix
}

function clearDecodedInstructionData(bytes: Uint8Array): void {
  try {
    Reflect.apply(TYPED_ARRAY_FILL, bytes, [0])
    if (!TYPED_ARRAY_LENGTH_GETTER) {
      throw new TypeError('TypedArray length intrinsic is unavailable')
    }
    const length: unknown = Reflect.apply(TYPED_ARRAY_LENGTH_GETTER, bytes, [])
    if (!Number.isSafeInteger(length) || Number(length) < 0) {
      throw new TypeError('decoded instruction data has an invalid internal length')
    }
    for (let index = 0; index < Number(length); index += 1) {
      if (bytes[index] !== 0) {
        throw new TypeError('decoded instruction data could not be zeroed')
      }
    }
  } catch {
    throw new TypeError('decoded instruction data could not be zeroed')
  }
}

function instructionMetadata(
  instruction: SolanaInstructionEvidence,
  ordinal: number
): CanonicalInstructionMetadata {
  const maximumDataLength =
    instruction.path.kind === 'outer'
      ? SOLANA_PACKET_DATA_SIZE_BYTES
      : SOLANA_MAX_CPI_INSTRUCTION_DATA_BYTES
  const decodedData = decodeBase58BytesBounded(instruction.dataBase58, maximumDataLength)
  if (decodedData === null) {
    throw new TypeError('normalized instruction data violates its path-specific byte bound')
  }
  try {
    return {
      ordinal,
      outer_index: instruction.path.outerIndex,
      inner_index: instruction.path.kind === 'outer' ? null : instruction.path.innerIndex,
      program_id_index: instruction.programIdIndex,
      program_id: instruction.programId,
      account_indexes: instruction.accountIndexes.map((index) => index),
      stack_height: instruction.stackHeight,
      data_byte_length: decodedData.byteLength,
      data_sha256: createHash('sha256').update(decodedData).digest('hex'),
      data_prefix8_hex: decodedData.byteLength < 8 ? null : firstEightBytesHex(decodedData),
    }
  } finally {
    clearDecodedInstructionData(decodedData)
  }
}

function instructionMetadataRootSha256(
  resolvedAccountKeysRootSha256: string,
  innerInstructionsState: 'present' | 'verified_empty',
  outerInstructionCount: number,
  instructions: readonly CanonicalInstructionMetadata[]
): string {
  return dexContractSha256(
    {
      domain: 'arena.dex.solana-instruction-metadata',
      schema_id: DEX_SOLANA_INSTRUCTION_METADATA_ROOT_CONTRACT,
      schema_version: 1,
    },
    {
      resolved_account_keys_root_sha256: resolvedAccountKeysRootSha256,
      inner_instructions_state: innerInstructionsState,
      outer_instruction_count: outerInstructionCount,
      instruction_count: instructions.length,
      data_hash_basis: DEX_SOLANA_INSTRUCTION_DATA_HASH_BASIS,
      instructions,
    }
  )
}

/**
 * Build a source-independent projection from one caller-supplied decoded
 * transaction result. This proves strict shape normalization and exact program
 * id equality only; capture/finality/protocol claims must be bound separately.
 */
export function projectDexSolanaProgramHits(
  input: DexSolanaProgramHitProjectionInput
): DexSolanaProgramHitProjection {
  const parsedInput = parseProjectionInput(input)
  const normalized = normalizeSolanaTxEvidenceResult(
    parsedInput.signature,
    parsedInput.transaction_result
  )
  if (normalized.executionStatus !== 'succeeded') {
    throw new TypeError('Solana program-hit projection requires a succeeded transaction')
  }
  if (normalized.innerInstructionsStatus === 'unavailable') {
    throw new TypeError('Solana program-hit projection requires available inner instructions')
  }

  const outerInstructionCount = assertCanonicalInstructionOrder(normalized.instructions)
  const innerInstructionCount = normalized.instructions.length - outerInstructionCount
  if (
    normalized.innerInstructionsStatus === 'present'
      ? innerInstructionCount === 0
      : innerInstructionCount !== 0
  ) {
    throw new TypeError('inner instruction state conflicts with the normalized instruction set')
  }
  if (
    normalized.instructions.length === 0 ||
    normalized.instructions.length > SOLANA_MAX_INSTRUCTION_TRACE_LENGTH
  ) {
    throw new TypeError('successful instruction trace must contain between 1 and 64 instructions')
  }

  const resolvedAccountRoot = resolvedAccountKeysRootSha256(normalized)
  const canonicalInstructions = normalized.instructions.map(instructionMetadata)
  const instructionRoot = instructionMetadataRootSha256(
    resolvedAccountRoot,
    normalized.innerInstructionsStatus,
    outerInstructionCount,
    canonicalInstructions
  )
  const hits: DexSolanaProgramHit[] = canonicalInstructions
    .filter((instruction) => instruction.program_id === parsedInput.target_program_id)
    .map((instruction) => ({
      outer_index: instruction.outer_index,
      inner_index: instruction.inner_index,
      program_id_index: instruction.program_id_index,
      program_id: instruction.program_id,
      data_byte_length: instruction.data_byte_length,
      data_sha256: instruction.data_sha256,
      data_prefix8_hex: instruction.data_prefix8_hex,
      data_hash_basis: DEX_SOLANA_INSTRUCTION_DATA_HASH_BASIS,
    }))
  if (hits.length === 0) {
    throw new TypeError('target program id does not occur in the complete instruction trace')
  }

  return parseDexSolanaProgramHitProjection({
    schema_version: DEX_SOLANA_PROGRAM_HIT_PROJECTION_SCHEMA_VERSION,
    data_contract: DEX_SOLANA_PROGRAM_HIT_PROJECTION_CONTRACT,
    derivation_state: DEX_SOLANA_PROGRAM_HIT_PROJECTION_DERIVATION_STATE,
    proof_boundary: DEX_SOLANA_PROGRAM_HIT_PROJECTION_PROOF_BOUNDARY,
    signature: normalized.signature,
    slot_decimal: String(normalized.slot),
    transaction_version: normalized.version,
    execution_status: 'succeeded',
    address_lookup_table_count: normalized.addressTableLookups.length,
    account_resolution_state: 'all_static_and_lookup_keys_resolved',
    resolved_account_keys_count: normalized.accountKeys.length,
    resolved_account_keys_root_sha256: resolvedAccountRoot,
    resolved_account_keys_hash_basis: DEX_SOLANA_RESOLVED_ACCOUNT_KEYS_HASH_BASIS,
    inner_instructions_state: normalized.innerInstructionsStatus,
    instruction_scope: 'all_declared_outer_and_rpc_reported_inner_instructions',
    outer_instruction_count: outerInstructionCount,
    instruction_count: canonicalInstructions.length,
    instruction_metadata_root_sha256: instructionRoot,
    instruction_metadata_hash_basis: DEX_SOLANA_INSTRUCTION_METADATA_HASH_BASIS,
    target_program_id: parsedInput.target_program_id,
    target_hit_count: hits.length,
    hits,
  })
}

export function dexSolanaProgramHitProjectionSha256(input: unknown): string {
  return dexContractSha256(
    {
      domain: 'arena.dex.solana-program-hit-projection',
      schema_id: DEX_SOLANA_PROGRAM_HIT_PROJECTION_CONTRACT,
      schema_version: DEX_SOLANA_PROGRAM_HIT_PROJECTION_SCHEMA_VERSION,
    },
    parseDexSolanaProgramHitProjection(input)
  )
}
