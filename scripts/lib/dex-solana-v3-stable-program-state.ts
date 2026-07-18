import { createHash } from 'node:crypto'

import { z } from 'zod'

import {
  findSolanaV3ProgramDataAddress,
  SOLANA_BPF_LOADER_V3,
  SOLANA_PROGRAM_ACCOUNT_MAX_DECODED_BYTES,
  SOLANA_V3_DEPLOYMENT_EFFECTIVE_SLOT_OFFSET,
  SOLANA_V3_PROGRAM_ACCOUNT_DATA_BYTES,
  SOLANA_V3_PROGRAMDATA_HEADER_BYTES,
  type SolanaV3ProgramDeploymentObservation,
} from '../../lib/ingest/onchain/solana-program-deployment-evidence'
import { SOLANA_MAINNET_GENESIS_HASH } from '../../lib/ingest/onchain/solana-evidence'
import { decodeBase58BytesBounded, hasBase58DecodedByteLength } from '../../lib/utils/base58'
import { dexContractSha256, strictCanonicalJson } from './dex-contract-hash'

export const DEX_SOLANA_V3_STABLE_PROGRAM_STATE_SCHEMA_VERSION = 1 as const
export const DEX_SOLANA_V3_STABLE_PROGRAM_STATE_CONTRACT =
  'arena.dex.solana-v3-stable-program-state@1' as const
export const DEX_SOLANA_V3_STABLE_PROGRAM_STATE_DERIVATION_STATE =
  'caller_supplied_strict_loader_v3_observation_unbound_to_capture' as const
export const DEX_SOLANA_V3_STABLE_PROGRAM_STATE_PROOF_BOUNDARY =
  'provider_neutral_current_loader_v3_program_and_programdata_account_state_only_not_capture_provenance_rpc_provider_independence_cryptographic_finality_original_deployment_slot_historical_code_epochs_source_or_build_identity_protocol_ownership_or_invocation_decoder_facts_wallet_attribution_metrics_serving_rank_score_or_legal_clearance' as const
export const DEX_SOLANA_ACCOUNT_DATA_HASH_BASIS =
  'solana_base64_decoded_full_allocated_account_data_bytes' as const
export const DEX_SOLANA_V3_EFFECTIVE_SLOT_POLICY =
  'programdata_last_modified_slot_plus_one' as const

const SHA256 = /^[0-9a-f]{64}$/
const DECIMAL_U64 = /^(?:0|[1-9][0-9]*)$/
const U64_MAX = (1n << 64n) - 1n
const DEFAULT_PUBLIC_KEY = '11111111111111111111111111111111'
const TYPED_ARRAY_FILL = Uint8Array.prototype.fill

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

const sha256Schema = z
  .string()
  .regex(SHA256)
  .refine((value) => !/^0{64}$/.test(value), 'SHA-256 must be nonzero')

const decimalU64Schema = z.string().refine((value) => {
  return value.length <= 20 && DECIMAL_U64.test(value) && BigInt(value) <= U64_MAX
}, 'value must be a canonical u64 decimal')

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

const stableProgramStateSchema = z
  .object({
    schema_version: z.literal(DEX_SOLANA_V3_STABLE_PROGRAM_STATE_SCHEMA_VERSION),
    data_contract: z.literal(DEX_SOLANA_V3_STABLE_PROGRAM_STATE_CONTRACT),
    derivation_state: z.literal(DEX_SOLANA_V3_STABLE_PROGRAM_STATE_DERIVATION_STATE),
    proof_boundary: z.literal(DEX_SOLANA_V3_STABLE_PROGRAM_STATE_PROOF_BOUNDARY),
    chain: z
      .object({
        namespace: z.literal('solana'),
        cluster: z.literal('mainnet-beta'),
        genesis_hash: z.literal(SOLANA_MAINNET_GENESIS_HASH),
      })
      .strict(),
    semantic_state: z.literal('current_v3_program_and_programdata_accounts_consistent'),
    loader_program_id: z.literal(SOLANA_BPF_LOADER_V3),
    program_id: publicKeySchema,
    programdata_address: publicKeySchema,
    programdata_bump_seed: safeUnsignedSchema(255),
    program_account: z
      .object({
        owner: z.literal(SOLANA_BPF_LOADER_V3),
        executable: z.literal(true),
        data_byte_length: z.literal(SOLANA_V3_PROGRAM_ACCOUNT_DATA_BYTES),
        data_sha256: sha256Schema,
        data_hash_basis: z.literal(DEX_SOLANA_ACCOUNT_DATA_HASH_BASIS),
        programdata_address: publicKeySchema,
      })
      .strict(),
    programdata_account: z
      .object({
        owner: z.literal(SOLANA_BPF_LOADER_V3),
        executable: z.literal(false),
        data_byte_length: safeUnsignedSchema(SOLANA_PROGRAM_ACCOUNT_MAX_DECODED_BYTES, 1),
        data_sha256: sha256Schema,
        data_hash_basis: z.literal(DEX_SOLANA_ACCOUNT_DATA_HASH_BASIS),
        last_modified_slot_decimal: decimalU64Schema,
        effective_slot_decimal: decimalU64Schema,
        effective_slot_policy: z.literal(DEX_SOLANA_V3_EFFECTIVE_SLOT_POLICY),
        upgrade_authority: upgradeAuthoritySchema,
        code_offset_bytes: z.literal(SOLANA_V3_PROGRAMDATA_HEADER_BYTES),
        code_byte_length: safeUnsignedSchema(
          SOLANA_PROGRAM_ACCOUNT_MAX_DECODED_BYTES - SOLANA_V3_PROGRAMDATA_HEADER_BYTES,
          1
        ),
        code_sha256: sha256Schema,
        code_hash_basis: z.literal(
          'programdata_allocated_bytes_after_45_byte_state_header_including_trailing_zeros'
        ),
      })
      .strict(),
  })
  .strict()

export type DexSolanaV3StableProgramState = z.infer<typeof stableProgramStateSchema>

function assertStableProgramStateInvariants(state: DexSolanaV3StableProgramState): void {
  const derivedProgramData = findSolanaV3ProgramDataAddress(state.program_id)
  if (
    state.programdata_address !== derivedProgramData.address ||
    state.programdata_bump_seed !== derivedProgramData.bump_seed
  ) {
    throw new TypeError('stable loader-v3 state does not use the canonical ProgramData PDA')
  }
  if (state.program_account.programdata_address !== state.programdata_address) {
    throw new TypeError('stable Program account pointer does not match the ProgramData address')
  }
  const programDataAddressBytes = decodeBase58BytesBounded(state.programdata_address, 32)
  if (programDataAddressBytes?.byteLength !== 32) {
    throw new TypeError('stable ProgramData address cannot be decoded')
  }
  const programAccountData = new Uint8Array(SOLANA_V3_PROGRAM_ACCOUNT_DATA_BYTES)
  let expectedProgramAccountDataSha256: string
  try {
    programAccountData[0] = 2
    programAccountData.set(programDataAddressBytes, 4)
    expectedProgramAccountDataSha256 = createHash('sha256').update(programAccountData).digest('hex')
  } finally {
    Reflect.apply(TYPED_ARRAY_FILL, programAccountData, [0])
    Reflect.apply(TYPED_ARRAY_FILL, programDataAddressBytes, [0])
  }
  if (state.program_account.data_sha256 !== expectedProgramAccountDataSha256) {
    throw new TypeError('stable Program account data hash conflicts with its ProgramData pointer')
  }

  const lastModifiedSlot = BigInt(state.programdata_account.last_modified_slot_decimal)
  const effectiveSlot = BigInt(state.programdata_account.effective_slot_decimal)
  if (
    lastModifiedSlot === 0n ||
    lastModifiedSlot === U64_MAX ||
    effectiveSlot !== lastModifiedSlot + SOLANA_V3_DEPLOYMENT_EFFECTIVE_SLOT_OFFSET
  ) {
    throw new TypeError('stable ProgramData effective slot must equal last-modified slot plus one')
  }
  if (
    state.programdata_account.data_byte_length <= SOLANA_V3_PROGRAMDATA_HEADER_BYTES ||
    state.programdata_account.code_byte_length !==
      state.programdata_account.data_byte_length - SOLANA_V3_PROGRAMDATA_HEADER_BYTES
  ) {
    throw new TypeError('stable ProgramData code length conflicts with its allocated account data')
  }
  if (
    state.programdata_account.upgrade_authority.state === 'present' &&
    state.programdata_account.upgrade_authority.address === DEFAULT_PUBLIC_KEY
  ) {
    throw new TypeError('stable ProgramData upgrade authority cannot be the default public key')
  }
}

/**
 * Parse a provider-neutral current loader-v3 state contract.
 *
 * The canonical JSON preflight rejects accessors, sparse arrays, exotic
 * prototypes, symbol keys, and non-JSON values before Zod reads the object.
 */
export function parseDexSolanaV3StableProgramState(input: unknown): DexSolanaV3StableProgramState {
  strictCanonicalJson(input)
  const parsed = stableProgramStateSchema.parse(input)
  assertStableProgramStateInvariants(parsed)
  return parsed
}

/**
 * Remove capture-dependent endpoint, anchor, time, minimum-context, and
 * returned-context fields from one already strict loader-v3 observation.
 */
export function buildDexSolanaV3StableProgramState(
  observation: SolanaV3ProgramDeploymentObservation
): DexSolanaV3StableProgramState {
  strictCanonicalJson(observation)
  return parseDexSolanaV3StableProgramState({
    schema_version: DEX_SOLANA_V3_STABLE_PROGRAM_STATE_SCHEMA_VERSION,
    data_contract: DEX_SOLANA_V3_STABLE_PROGRAM_STATE_CONTRACT,
    derivation_state: DEX_SOLANA_V3_STABLE_PROGRAM_STATE_DERIVATION_STATE,
    proof_boundary: DEX_SOLANA_V3_STABLE_PROGRAM_STATE_PROOF_BOUNDARY,
    chain: {
      namespace: 'solana',
      cluster: 'mainnet-beta',
      genesis_hash: SOLANA_MAINNET_GENESIS_HASH,
    },
    semantic_state: 'current_v3_program_and_programdata_accounts_consistent',
    loader_program_id: observation.loader_program_id,
    program_id: observation.program_id,
    programdata_address: observation.programdata_address,
    programdata_bump_seed: observation.programdata_bump_seed,
    program_account: {
      owner: observation.program_account.owner,
      executable: observation.program_account.executable,
      data_byte_length: observation.program_account.space,
      data_sha256: observation.program_account.data_sha256,
      data_hash_basis: DEX_SOLANA_ACCOUNT_DATA_HASH_BASIS,
      programdata_address: observation.program_account.programdata_address,
    },
    programdata_account: {
      owner: observation.programdata_account.owner,
      executable: observation.programdata_account.executable,
      data_byte_length: observation.programdata_account.space,
      data_sha256: observation.programdata_account.data_sha256,
      data_hash_basis: DEX_SOLANA_ACCOUNT_DATA_HASH_BASIS,
      last_modified_slot_decimal: observation.programdata_account.last_modified_slot_decimal,
      effective_slot_decimal: observation.programdata_account.effective_slot_decimal,
      effective_slot_policy: DEX_SOLANA_V3_EFFECTIVE_SLOT_POLICY,
      upgrade_authority:
        observation.programdata_account.upgrade_authority.state === 'present'
          ? {
              state: 'present',
              address: observation.programdata_account.upgrade_authority.address,
            }
          : { state: 'revoked', address: null },
      code_offset_bytes: observation.programdata_account.code_offset_bytes,
      code_byte_length: observation.programdata_account.code_byte_length,
      code_sha256: observation.programdata_account.code_sha256,
      code_hash_basis: observation.programdata_account.code_hash_basis,
    },
  })
}

export function dexSolanaV3StableProgramStateSha256(input: unknown): string {
  return dexContractSha256(
    {
      domain: 'arena.dex.solana-v3-stable-program-state',
      schema_id: DEX_SOLANA_V3_STABLE_PROGRAM_STATE_CONTRACT,
      schema_version: DEX_SOLANA_V3_STABLE_PROGRAM_STATE_SCHEMA_VERSION,
    },
    parseDexSolanaV3StableProgramState(input)
  )
}
