import { createHash } from 'node:crypto'

import {
  findSolanaV3ProgramDataAddress,
  SOLANA_BPF_LOADER_V3,
  SOLANA_V3_PROGRAM_ACCOUNT_DATA_BYTES,
  SOLANA_V3_PROGRAMDATA_HEADER_BYTES,
  SOLANA_V3_PROGRAM_OBSERVATION_PROOF_BOUNDARY,
  type SolanaV3ProgramDeploymentObservation,
} from '../../lib/ingest/onchain/solana-program-deployment-evidence'
import { SOLANA_MAINNET_GENESIS_HASH } from '../../lib/ingest/onchain/solana-evidence'
import { decodeBase58BytesBounded } from '../../lib/utils/base58'
import {
  buildDexSolanaV3StableProgramState,
  DEX_SOLANA_ACCOUNT_DATA_HASH_BASIS,
  DEX_SOLANA_V3_EFFECTIVE_SLOT_POLICY,
  DEX_SOLANA_V3_STABLE_PROGRAM_STATE_CONTRACT,
  DEX_SOLANA_V3_STABLE_PROGRAM_STATE_DERIVATION_STATE,
  DEX_SOLANA_V3_STABLE_PROGRAM_STATE_PROOF_BOUNDARY,
  DEX_SOLANA_V3_STABLE_PROGRAM_STATE_SCHEMA_VERSION,
  dexSolanaV3StableProgramStateSha256,
  parseDexSolanaV3StableProgramState,
  type DexSolanaV3StableProgramState,
} from '../lib/dex-solana-v3-stable-program-state'

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function encodeBase58(bytes: Uint8Array): string {
  let numericValue = 0n
  for (const byte of bytes) numericValue = numericValue * 256n + BigInt(byte)
  let encoded = ''
  while (numericValue > 0n) {
    encoded = BASE58_ALPHABET[Number(numericValue % 58n)] + encoded
    numericValue /= 58n
  }
  let leadingZeroBytes = 0
  while (leadingZeroBytes < bytes.length && bytes[leadingZeroBytes] === 0) {
    leadingZeroBytes += 1
  }
  return '1'.repeat(leadingZeroBytes) + encoded
}

function publicKey(seed: number): string {
  return encodeBase58(Uint8Array.from({ length: 32 }, (_value, index) => (seed + index * 37) % 256))
}

function hash(label: string): string {
  return createHash('sha256').update(label).digest('hex')
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const PROGRAM_ID = publicKey(11)
const PROGRAMDATA = findSolanaV3ProgramDataAddress(PROGRAM_ID)
const AUTHORITY = publicKey(73)
const PROGRAMDATA_BYTES = SOLANA_V3_PROGRAMDATA_HEADER_BYTES + 256
const PROGRAM_ACCOUNT_DATA = new Uint8Array(SOLANA_V3_PROGRAM_ACCOUNT_DATA_BYTES)
PROGRAM_ACCOUNT_DATA[0] = 2
const PROGRAMDATA_ADDRESS_BYTES = decodeBase58BytesBounded(PROGRAMDATA.address, 32)
if (PROGRAMDATA_ADDRESS_BYTES?.byteLength !== 32) {
  throw new Error('test ProgramData address must decode to 32 bytes')
}
PROGRAM_ACCOUNT_DATA.set(PROGRAMDATA_ADDRESS_BYTES, 4)
const PROGRAM_ACCOUNT_DATA_SHA256 = hashBytes(PROGRAM_ACCOUNT_DATA)
const PROGRAM_CODE_BYTES = Uint8Array.from(
  { length: PROGRAMDATA_BYTES - SOLANA_V3_PROGRAMDATA_HEADER_BYTES },
  (_value, index) => (19 + index * 41) % 256
)
const PROGRAM_CODE_SHA256 = hashBytes(PROGRAM_CODE_BYTES)

function programDataAccountData(
  authority: SolanaV3ProgramDeploymentObservation['programdata_account']['upgrade_authority']
): Uint8Array {
  const bytes = new Uint8Array(PROGRAMDATA_BYTES)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  view.setUint32(0, 3, true)
  view.setBigUint64(4, 433_000_000n, true)
  if (authority.state === 'present') {
    const authorityBytes = decodeBase58BytesBounded(authority.address, 32)
    if (authorityBytes?.byteLength !== 32) {
      throw new Error('test upgrade authority must decode to 32 bytes')
    }
    bytes[12] = 1
    bytes.set(authorityBytes, 13)
  }
  bytes.set(PROGRAM_CODE_BYTES, SOLANA_V3_PROGRAMDATA_HEADER_BYTES)
  return bytes
}

function observation(
  authority: SolanaV3ProgramDeploymentObservation['programdata_account']['upgrade_authority'] = {
    state: 'present',
    address: AUTHORITY,
  }
): SolanaV3ProgramDeploymentObservation {
  const programDataBytes = programDataAccountData(authority)
  return {
    chain: 'solana',
    semantic_state: 'v3_program_and_programdata_accounts_consistent',
    proof_boundary: SOLANA_V3_PROGRAM_OBSERVATION_PROOF_BOUNDARY,
    loader_program_id: SOLANA_BPF_LOADER_V3,
    program_id: PROGRAM_ID,
    programdata_address: PROGRAMDATA.address,
    programdata_bump_seed: PROGRAMDATA.bump_seed,
    requested_min_context_slot_decimal: '433770000',
    accounts_context_slot_decimal: '433770123',
    program_account: {
      owner: SOLANA_BPF_LOADER_V3,
      executable: true,
      space: SOLANA_V3_PROGRAM_ACCOUNT_DATA_BYTES,
      data_sha256: PROGRAM_ACCOUNT_DATA_SHA256,
      programdata_address: PROGRAMDATA.address,
    },
    programdata_account: {
      owner: SOLANA_BPF_LOADER_V3,
      executable: false,
      space: PROGRAMDATA_BYTES,
      data_sha256: hashBytes(programDataBytes),
      last_modified_slot_decimal: '433000000',
      effective_slot_decimal: '433000001',
      upgrade_authority: authority,
      code_offset_bytes: SOLANA_V3_PROGRAMDATA_HEADER_BYTES,
      code_byte_length: PROGRAMDATA_BYTES - SOLANA_V3_PROGRAMDATA_HEADER_BYTES,
      code_sha256: PROGRAM_CODE_SHA256,
      code_hash_basis:
        'programdata_allocated_bytes_after_45_byte_state_header_including_trailing_zeros',
    },
  }
}

function presentState(): DexSolanaV3StableProgramState {
  return buildDexSolanaV3StableProgramState(observation())
}

function collectObjectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, keys)
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key)
      collectObjectKeys(child, keys)
    }
  }
  return keys
}

describe('Solana loader-v3 stable current program state', () => {
  it('projects complete provider-neutral Program and ProgramData facts', () => {
    const state = presentState()

    expect(state).toEqual({
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
      loader_program_id: SOLANA_BPF_LOADER_V3,
      program_id: PROGRAM_ID,
      programdata_address: PROGRAMDATA.address,
      programdata_bump_seed: PROGRAMDATA.bump_seed,
      program_account: {
        owner: SOLANA_BPF_LOADER_V3,
        executable: true,
        data_byte_length: SOLANA_V3_PROGRAM_ACCOUNT_DATA_BYTES,
        data_sha256: PROGRAM_ACCOUNT_DATA_SHA256,
        data_hash_basis: DEX_SOLANA_ACCOUNT_DATA_HASH_BASIS,
        programdata_address: PROGRAMDATA.address,
      },
      programdata_account: {
        owner: SOLANA_BPF_LOADER_V3,
        executable: false,
        data_byte_length: PROGRAMDATA_BYTES,
        data_sha256: hashBytes(
          programDataAccountData({
            state: 'present',
            address: AUTHORITY,
          })
        ),
        data_hash_basis: DEX_SOLANA_ACCOUNT_DATA_HASH_BASIS,
        last_modified_slot_decimal: '433000000',
        effective_slot_decimal: '433000001',
        effective_slot_policy: DEX_SOLANA_V3_EFFECTIVE_SLOT_POLICY,
        upgrade_authority: { state: 'present', address: AUTHORITY },
        code_offset_bytes: SOLANA_V3_PROGRAMDATA_HEADER_BYTES,
        code_byte_length: 256,
        code_sha256: PROGRAM_CODE_SHA256,
        code_hash_basis:
          'programdata_allocated_bytes_after_45_byte_state_header_including_trailing_zeros',
      },
    })

    const keys = collectObjectKeys(state)
    for (const forbiddenKey of [
      'requested_min_context_slot_decimal',
      'accounts_context_slot_decimal',
      'endpoint',
      'anchor',
      'observed_at',
      'completed_at',
      'generated_at',
      'deployed_slot',
      'deployment_slot',
      'raw_exchanges',
      'response_sha256',
    ]) {
      expect(keys).not.toContain(forbiddenKey)
    }
  })

  it('is invariant to provider-specific request and returned context slots', () => {
    const first = observation()
    const second = observation()
    second.requested_min_context_slot_decimal = '433771000'
    second.accounts_context_slot_decimal = '433771777'

    const firstState = buildDexSolanaV3StableProgramState(first)
    const secondState = buildDexSolanaV3StableProgramState(second)
    expect(secondState).toEqual(firstState)
    expect(dexSolanaV3StableProgramStateSha256(secondState)).toBe(
      dexSolanaV3StableProgramStateSha256(firstState)
    )
  })

  it('pins present and revoked authority golden hashes', () => {
    const present = presentState()
    const revoked = buildDexSolanaV3StableProgramState(
      observation({ state: 'revoked', address: null })
    )

    expect(dexSolanaV3StableProgramStateSha256(present)).toBe(
      '3d90ea47006716b097eef7dd2fe47b361befed147dd72877e3b895221ec97b3d'
    )
    expect(dexSolanaV3StableProgramStateSha256(revoked)).toBe(
      '9cdf02ed1a9980cdca9640219c337068c5444679d5dfdea5842fe66b40fae692'
    )
    expect(revoked.programdata_account.upgrade_authority).toEqual({
      state: 'revoked',
      address: null,
    })
  })

  it.each([
    [
      'ProgramData PDA',
      (state: any) => {
        state.programdata_address = publicKey(91)
      },
      /canonical ProgramData PDA/,
    ],
    [
      'PDA bump',
      (state: any) => {
        state.programdata_bump_seed -= 1
      },
      /canonical ProgramData PDA/,
    ],
    [
      'Program pointer',
      (state: any) => {
        state.program_account.programdata_address = publicKey(92)
      },
      /Program account pointer/,
    ],
    [
      'Program account data hash',
      (state: any) => {
        state.program_account.data_sha256 = hash('forged-program-account')
      },
      /data hash conflicts/,
    ],
    [
      'effective slot',
      (state: any) => {
        state.programdata_account.effective_slot_decimal = '433000002'
      },
      /effective slot/,
    ],
    [
      'ProgramData code length',
      (state: any) => {
        state.programdata_account.code_byte_length -= 1
      },
      /code length/,
    ],
    [
      'default upgrade authority',
      (state: any) => {
        state.programdata_account.upgrade_authority = {
          state: 'present',
          address: '11111111111111111111111111111111',
        }
      },
      /default public key/,
    ],
  ])('rejects a forged %s invariant', (_label, mutate, expected) => {
    const state = clone(presentState())
    mutate(state)
    expect(() => parseDexSolanaV3StableProgramState(state)).toThrow(expected)
  })

  it('rejects capture-dependent, historical, extra, accessor, and exotic fields', () => {
    for (const [key, value] of [
      ['accounts_context_slot_decimal', '433770123'],
      ['requested_min_context_slot_decimal', '433770000'],
      ['deployed_slot', '433000000'],
      ['endpoint', 'solana_official_mainnet'],
    ] as const) {
      const state = clone(presentState()) as Record<string, unknown>
      state[key] = value
      expect(() => parseDexSolanaV3StableProgramState(state)).toThrow()
    }

    const accessor = clone(presentState()) as Record<string, unknown>
    let getterCalls = 0
    Object.defineProperty(accessor, 'endpoint', {
      enumerable: true,
      get() {
        getterCalls += 1
        return 'solana_official_mainnet'
      },
    })
    expect(() => parseDexSolanaV3StableProgramState(accessor)).toThrow('object accessors')
    expect(getterCalls).toBe(0)

    const exotic = Object.assign(Object.create({ inherited: true }), presentState())
    expect(() => parseDexSolanaV3StableProgramState(exotic)).toThrow('non-plain objects')
  })

  it('does not execute hostile getters in the exported observation builder', () => {
    const hostile = clone(observation()) as SolanaV3ProgramDeploymentObservation
    let getterCalls = 0
    Object.defineProperty(hostile.program_account, 'data_sha256', {
      enumerable: true,
      get() {
        getterCalls += 1
        return PROGRAM_ACCOUNT_DATA_SHA256
      },
    })

    expect(() => buildDexSolanaV3StableProgramState(hostile)).toThrow('object accessors')
    expect(getterCalls).toBe(0)
  })

  it('parses before hashing and rejects a forged contract or unknown field', () => {
    const forgedContract = clone(presentState()) as Record<string, unknown>
    forgedContract.data_contract = 'arena.dex.solana-v3-stable-program-state@2'
    expect(() => dexSolanaV3StableProgramStateSha256(forgedContract)).toThrow()

    const unknown = clone(presentState()) as Record<string, unknown>
    unknown.provider = 'official'
    expect(() => dexSolanaV3StableProgramStateSha256(unknown)).toThrow()
  })
})
