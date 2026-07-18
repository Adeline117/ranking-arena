import { createHash } from 'node:crypto'

import {
  DEX_SOLANA_INSTRUCTION_DATA_HASH_BASIS,
  DEX_SOLANA_PROGRAM_HIT_PROJECTION_CONTRACT,
  DEX_SOLANA_PROGRAM_HIT_PROJECTION_DERIVATION_STATE,
  DEX_SOLANA_PROGRAM_HIT_PROJECTION_PROOF_BOUNDARY,
  DEX_SOLANA_PROGRAM_HIT_PROJECTION_SCHEMA_VERSION,
  dexSolanaProgramHitProjectionSha256,
  parseDexSolanaProgramHitProjection,
  projectDexSolanaProgramHits,
  type DexSolanaProgramHitProjection,
} from '../lib/dex-solana-program-hit-projection'

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

function deterministicBytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_value, index) => (seed + index * 37) % 256)
}

function key(seed: number): string {
  return encodeBase58(deterministicBytes(32, seed))
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

const SIGNATURE = encodeBase58(deterministicBytes(64, 19))
const PAYER = key(1)
const TARGET_PROGRAM_ID = key(2)
const OTHER_PROGRAM_ID = key(3)
const LOOKUP_TABLE_A = key(4)
const LOOKUP_TABLE_B = key(5)
const LOADED_WRITABLE_A = key(6)
const LOADED_WRITABLE_B = key(7)
const LOADED_READONLY_A = key(8)
const LOADED_READONLY_B = key(9)

function v0Fixture(): any {
  return {
    slot: 433_666_418,
    blockTime: 1_752_838_920,
    version: 0,
    transaction: {
      signatures: [SIGNATURE],
      message: {
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 2,
        },
        accountKeys: [PAYER, TARGET_PROGRAM_ID, OTHER_PROGRAM_ID],
        addressTableLookups: [
          {
            accountKey: LOOKUP_TABLE_A,
            writableIndexes: [4],
            readonlyIndexes: [9],
          },
          {
            accountKey: LOOKUP_TABLE_B,
            writableIndexes: [7],
            readonlyIndexes: [2],
          },
        ],
        instructions: [
          {
            programIdIndex: 2,
            accounts: [0, 3],
            data: '2',
          },
          {
            programIdIndex: 1,
            accounts: [0, 4],
            data: '2',
          },
          {
            programIdIndex: 2,
            accounts: [0, 6],
            data: '1111111',
          },
        ],
      },
    },
    meta: {
      err: null,
      fee: 5_000,
      computeUnitsConsumed: 123_456,
      loadedAddresses: {
        writable: [LOADED_WRITABLE_A, LOADED_WRITABLE_B],
        readonly: [LOADED_READONLY_A, LOADED_READONLY_B],
      },
      preBalances: [10_000, 0, 0, 0, 0, 0, 0],
      postBalances: [5_000, 0, 0, 0, 0, 0, 0],
      preTokenBalances: [],
      postTokenBalances: [],
      // RPC group order is intentionally non-canonical. The parser must emit
      // outer 0 + inners, outer 1, then outer 2 + inners.
      innerInstructions: [
        {
          index: 2,
          instructions: [
            {
              programIdIndex: 1,
              accounts: [0, 5],
              data: '',
              stackHeight: 2,
            },
          ],
        },
        {
          index: 0,
          instructions: [
            {
              programIdIndex: 2,
              accounts: [3],
              data: '',
              stackHeight: 2,
            },
            {
              programIdIndex: 1,
              accounts: [4, 6],
              data: '11111111',
              stackHeight: 3,
            },
          ],
        },
      ],
      logMessages: ['synthetic projection fixture'],
    },
  }
}

function legacyFixture(): any {
  const fixture = v0Fixture()
  fixture.version = 'legacy'
  fixture.transaction.message.addressTableLookups = []
  fixture.transaction.message.instructions = [
    {
      programIdIndex: 1,
      accounts: [0],
      data: '11111111',
    },
  ]
  fixture.meta.loadedAddresses = { writable: [], readonly: [] }
  fixture.meta.preBalances = [10_000, 0, 0]
  fixture.meta.postBalances = [5_000, 0, 0]
  fixture.meta.innerInstructions = []
  return fixture
}

function project(
  transactionResult: unknown = v0Fixture(),
  targetProgramId = TARGET_PROGRAM_ID
): DexSolanaProgramHitProjection {
  return projectDexSolanaProgramHits({
    signature: SIGNATURE,
    target_program_id: targetProgramId,
    transaction_result: transactionResult,
  })
}

function collectObjectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectObjectKeys(item, keys)
  } else if (value && typeof value === 'object') {
    for (const [keyName, child] of Object.entries(value)) {
      keys.add(keyName)
      collectObjectKeys(child, keys)
    }
  }
  return keys
}

describe('Solana program-hit projection', () => {
  it('projects canonical v0 ALT and outer/inner facts without capture or raw payload leakage', () => {
    const projection = project()

    expect(projection).toMatchObject({
      schema_version: DEX_SOLANA_PROGRAM_HIT_PROJECTION_SCHEMA_VERSION,
      data_contract: DEX_SOLANA_PROGRAM_HIT_PROJECTION_CONTRACT,
      derivation_state: DEX_SOLANA_PROGRAM_HIT_PROJECTION_DERIVATION_STATE,
      proof_boundary: DEX_SOLANA_PROGRAM_HIT_PROJECTION_PROOF_BOUNDARY,
      signature: SIGNATURE,
      slot_decimal: '433666418',
      transaction_version: 0,
      execution_status: 'succeeded',
      address_lookup_table_count: 2,
      account_resolution_state: 'all_static_and_lookup_keys_resolved',
      resolved_account_keys_count: 7,
      inner_instructions_state: 'present',
      instruction_scope: 'all_declared_outer_and_rpc_reported_inner_instructions',
      outer_instruction_count: 3,
      instruction_count: 6,
      target_program_id: TARGET_PROGRAM_ID,
      target_hit_count: 3,
    })
    expect(projection.hits).toEqual([
      {
        outer_index: 0,
        inner_index: 1,
        program_id_index: 1,
        program_id: TARGET_PROGRAM_ID,
        data_byte_length: 8,
        data_sha256: hashBytes(new Uint8Array(8)),
        data_prefix8_hex: '0000000000000000',
        data_hash_basis: DEX_SOLANA_INSTRUCTION_DATA_HASH_BASIS,
      },
      {
        outer_index: 1,
        inner_index: null,
        program_id_index: 1,
        program_id: TARGET_PROGRAM_ID,
        data_byte_length: 1,
        data_sha256: hashBytes(Uint8Array.of(1)),
        data_prefix8_hex: null,
        data_hash_basis: DEX_SOLANA_INSTRUCTION_DATA_HASH_BASIS,
      },
      {
        outer_index: 2,
        inner_index: 0,
        program_id_index: 1,
        program_id: TARGET_PROGRAM_ID,
        data_byte_length: 0,
        data_sha256: hashBytes(new Uint8Array()),
        data_prefix8_hex: null,
        data_hash_basis: DEX_SOLANA_INSTRUCTION_DATA_HASH_BASIS,
      },
    ])

    const keys = collectObjectKeys(projection)
    for (const forbiddenKey of [
      'transaction_result',
      'dataBase58',
      'data_base58',
      'staticAccountKeys',
      'static_account_keys',
      'accountKeys',
      'resolved_account_keys',
      'addressTableLookups',
      'address_table_lookups',
      'loadedAddresses',
      'loaded_addresses',
      'instructions',
      'provider',
      'commitmentRequested',
      'encoding',
      'maxSupportedTransactionVersion',
      'finality_membership_verified',
      'protocol_identity_verified',
      'protocol_invocation_semantics_verified',
    ]) {
      expect(keys.has(forbiddenKey)).toBe(false)
    }
    expect(Object.hasOwn(projection, 'claims')).toBe(false)
    expect(parseDexSolanaProgramHitProjection(projection)).toEqual(projection)
  })

  it('pins the account, instruction, and complete projection canonical hashes', () => {
    const projection = project()

    expect({
      resolved_account_keys_root_sha256: projection.resolved_account_keys_root_sha256,
      instruction_metadata_root_sha256: projection.instruction_metadata_root_sha256,
      projection_sha256: dexSolanaProgramHitProjectionSha256(projection),
    }).toEqual({
      resolved_account_keys_root_sha256:
        '8613d397af6038d600d4c5124e49c05effa3a5bfebe8b7c47c223c670caea5a3',
      instruction_metadata_root_sha256:
        '59f6ecc751b015527fcbffce9bb5923b34f97c4aa272283ccea5d1514c059731',
      projection_sha256: 'c042121fe83bba30d1b7d6f2c61fac53c1ca749c388ea06fa7d805e0440bf2a8',
    })
  })

  it('normalizes raw inner group order into one canonical outer/inner sequence', () => {
    const reordered = v0Fixture()
    reordered.meta.innerInstructions.reverse()

    expect(project(reordered)).toEqual(project(v0Fixture()))
    expect(dexSolanaProgramHitProjectionSha256(project(reordered))).toBe(
      dexSolanaProgramHitProjectionSha256(project(v0Fixture()))
    )
  })

  it('keeps caller/source annotations outside the source-independent projection', () => {
    const first = v0Fixture()
    const second = v0Fixture()
    first.callerSource = { endpoint: 'first.invalid', commitment: 'processed' }
    second.callerSource = { endpoint: 'second.invalid', commitment: 'finalized' }

    expect(project(first)).toEqual(project(second))
  })

  it('projects legacy verified-empty inner instructions without inventing ALT state', () => {
    const projection = project(legacyFixture())

    expect(projection).toMatchObject({
      transaction_version: 'legacy',
      address_lookup_table_count: 0,
      resolved_account_keys_count: 3,
      inner_instructions_state: 'verified_empty',
      outer_instruction_count: 1,
      instruction_count: 1,
      target_hit_count: 1,
    })
    expect(projection.hits[0]).toMatchObject({
      outer_index: 0,
      inner_index: null,
      data_byte_length: 8,
      data_prefix8_hex: '0000000000000000',
    })
  })

  it.each([
    [
      'static pubkey',
      (fixture: any) => {
        fixture.transaction.message.accountKeys[0] = key(31)
      },
    ],
    [
      'static signer/writable role',
      (fixture: any) => {
        fixture.transaction.message.header.numReadonlyUnsignedAccounts = 1
      },
    ],
    [
      'lookup ordinal',
      (fixture: any) => {
        fixture.transaction.message.addressTableLookups.reverse()
      },
    ],
    [
      'lookup lane',
      (fixture: any) => {
        const lookup = fixture.transaction.message.addressTableLookups[0]
        ;[lookup.writableIndexes, lookup.readonlyIndexes] = [
          lookup.readonlyIndexes,
          lookup.writableIndexes,
        ]
      },
    ],
    [
      'loaded ordinal',
      (fixture: any) => {
        fixture.meta.loadedAddresses.writable.reverse()
      },
    ],
    [
      'lookup table account',
      (fixture: any) => {
        fixture.transaction.message.addressTableLookups[0].accountKey = key(32)
      },
    ],
    [
      'lookup table index',
      (fixture: any) => {
        fixture.transaction.message.addressTableLookups[0].writableIndexes[0] = 5
      },
    ],
    [
      'loaded resolved pubkey',
      (fixture: any) => {
        fixture.meta.loadedAddresses.readonly[0] = key(33)
      },
    ],
  ])('binds every resolved-account origin dimension: %s', (_label, mutate) => {
    const baseline = project()
    const changedFixture = v0Fixture()
    mutate(changedFixture)
    const changed = project(changedFixture)

    expect(changed.resolved_account_keys_root_sha256).not.toBe(
      baseline.resolved_account_keys_root_sha256
    )
    expect(changed.instruction_metadata_root_sha256).not.toBe(
      baseline.instruction_metadata_root_sha256
    )
  })

  it.each([
    [
      'instruction data',
      (fixture: any) => {
        fixture.transaction.message.instructions[0].data = '3'
      },
    ],
    [
      'account indexes',
      (fixture: any) => {
        fixture.transaction.message.instructions[0].accounts = [0, 4]
      },
    ],
    [
      'stack height',
      (fixture: any) => {
        fixture.meta.innerInstructions[1].instructions[0].stackHeight = 7
      },
    ],
    [
      'program id and index',
      (fixture: any) => {
        fixture.meta.innerInstructions[1].instructions[0].programIdIndex = 3
      },
    ],
    [
      'canonical outer ordinal/path',
      (fixture: any) => {
        ;[
          fixture.transaction.message.instructions[0],
          fixture.transaction.message.instructions[2],
        ] = [
          fixture.transaction.message.instructions[2],
          fixture.transaction.message.instructions[0],
        ]
      },
    ],
  ])('binds complete canonical instruction metadata: %s', (_label, mutate) => {
    const baseline = project()
    const changedFixture = v0Fixture()
    mutate(changedFixture)
    const changed = project(changedFixture)

    expect(changed.resolved_account_keys_root_sha256).toBe(
      baseline.resolved_account_keys_root_sha256
    )
    expect(changed.instruction_metadata_root_sha256).not.toBe(
      baseline.instruction_metadata_root_sha256
    )
  })

  it('enforces path-specific decoded data bounds and exact prefix thresholds', () => {
    const outerAtLimit = legacyFixture()
    outerAtLimit.transaction.message.instructions[0].data = '1'.repeat(1_232)
    expect(project(outerAtLimit).hits[0]).toMatchObject({
      data_byte_length: 1_232,
      data_prefix8_hex: '0000000000000000',
    })

    const outerOverLimit = legacyFixture()
    outerOverLimit.transaction.message.instructions[0].data = '1'.repeat(1_233)
    expect(() => project(outerOverLimit)).toThrow('malformed Solana transaction evidence')

    const innerAtLimit = v0Fixture()
    innerAtLimit.meta.innerInstructions[0].instructions[0].data = '1'.repeat(10_240)
    expect(project(innerAtLimit).hits[2]).toMatchObject({
      outer_index: 2,
      inner_index: 0,
      data_byte_length: 10_240,
      data_prefix8_hex: '0000000000000000',
    })

    const innerOverLimit = v0Fixture()
    innerOverLimit.meta.innerInstructions[0].instructions[0].data = '1'.repeat(10_241)
    expect(() => project(innerOverLimit)).toThrow('malformed Solana transaction evidence')

    const preDecodeLengthBomb = legacyFixture()
    preDecodeLengthBomb.transaction.message.instructions[0].data = '2'.repeat(2_465)
    expect(() => project(preDecodeLengthBomb)).toThrow('malformed Solana transaction evidence')
  })

  it.each([
    ['success', false],
    ['target-free rejection after projection', true],
  ] as const)(
    'bypasses a forged prototype fill while zeroing decoded data on %s',
    (_label, rejectTarget) => {
      const fillSpy = jest.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
        this: Uint8Array
      ) {
        return this
      })
      try {
        if (rejectTarget) {
          expect(() => project(v0Fixture(), key(99))).toThrow(
            'target program id does not occur in the complete instruction trace'
          )
        } else {
          expect(() => project()).not.toThrow()
        }
      } finally {
        fillSpy.mockRestore()
      }

      expect(fillSpy).not.toHaveBeenCalled()
    }
  )

  it('rejects failed, unavailable, contradictory-empty, and target-free observations', () => {
    const failed = v0Fixture()
    failed.meta.err = { InstructionError: [0, 'Custom'] }
    expect(() => project(failed)).toThrow('requires a succeeded transaction')

    const unavailableNull = v0Fixture()
    unavailableNull.meta.innerInstructions = null
    expect(() => project(unavailableNull)).toThrow('requires available inner instructions')

    const unavailableOmitted = v0Fixture()
    delete unavailableOmitted.meta.innerInstructions
    expect(() => project(unavailableOmitted)).toThrow('requires available inner instructions')

    const contradictoryEmpty = v0Fixture()
    contradictoryEmpty.meta.innerInstructions = [{ index: 0, instructions: [] }]
    expect(() => project(contradictoryEmpty)).toThrow(
      'inner instruction state conflicts with the normalized instruction set'
    )

    expect(() => project(v0Fixture(), key(99))).toThrow(
      'target program id does not occur in the complete instruction trace'
    )
  })

  it('inherits strict trace, account, ALT, version, and inner-group parser bounds', () => {
    const tooManySuccessfulInstructions = legacyFixture()
    tooManySuccessfulInstructions.transaction.message.instructions = Array.from(
      { length: 65 },
      () => ({
        programIdIndex: 1,
        accounts: [0],
        data: '',
      })
    )
    expect(() => project(tooManySuccessfulInstructions)).toThrow(
      'malformed Solana transaction evidence'
    )

    const atAccountLimit = legacyFixture()
    atAccountLimit.transaction.message.accountKeys = [
      PAYER,
      TARGET_PROGRAM_ID,
      ...Array.from({ length: 254 }, () => OTHER_PROGRAM_ID),
    ]
    atAccountLimit.transaction.message.header.numReadonlyUnsignedAccounts = 0
    atAccountLimit.meta.preBalances = Array.from({ length: 256 }, () => 0)
    atAccountLimit.meta.postBalances = Array.from({ length: 256 }, () => 0)
    expect(project(atAccountLimit).resolved_account_keys_count).toBe(256)

    const overAccountLimit = clone(atAccountLimit)
    overAccountLimit.transaction.message.accountKeys.push(OTHER_PROGRAM_ID)
    overAccountLimit.meta.preBalances.push(0)
    overAccountLimit.meta.postBalances.push(0)
    expect(() => project(overAccountLimit)).toThrow('malformed Solana transaction evidence')

    const loadedMismatch = v0Fixture()
    loadedMismatch.meta.loadedAddresses.readonly.pop()
    expect(() => project(loadedMismatch)).toThrow('malformed Solana transaction evidence')

    const duplicateInnerGroup = v0Fixture()
    duplicateInnerGroup.meta.innerInstructions.push(
      clone(duplicateInnerGroup.meta.innerInstructions[1])
    )
    expect(() => project(duplicateInnerGroup)).toThrow('malformed Solana transaction evidence')

    const outOfRangeInnerGroup = v0Fixture()
    outOfRangeInnerGroup.meta.innerInstructions[0].index = 3
    expect(() => project(outOfRangeInnerGroup)).toThrow('malformed Solana transaction evidence')

    const unsupported = v0Fixture()
    unsupported.version = 1
    expect(() => project(unsupported)).toThrow('unsupported Solana transaction version')
  })

  it('requires an exact plain three-field input envelope and valid identities', () => {
    expect(() =>
      projectDexSolanaProgramHits({
        signature: SIGNATURE,
        target_program_id: TARGET_PROGRAM_ID,
        transaction_result: v0Fixture(),
        extra: true,
      } as never)
    ).toThrow('exactly three fields')

    expect(() =>
      projectDexSolanaProgramHits({
        signature: SIGNATURE,
        target_program_id: TARGET_PROGRAM_ID,
      } as never)
    ).toThrow('exactly three fields')

    class ProjectionInput {
      signature = SIGNATURE
      target_program_id = TARGET_PROGRAM_ID
      transaction_result = v0Fixture()
    }
    expect(() => projectDexSolanaProgramHits(new ProjectionInput())).toThrow('plain object')

    const accessor = Object.defineProperty(
      {
        signature: SIGNATURE,
        target_program_id: TARGET_PROGRAM_ID,
        transaction_result: v0Fixture(),
      },
      'target_program_id',
      {
        enumerable: true,
        get: () => TARGET_PROGRAM_ID,
      }
    )
    expect(() => projectDexSolanaProgramHits(accessor as never)).toThrow(
      'enumerable data properties'
    )

    expect(() =>
      projectDexSolanaProgramHits({
        signature: 'bad',
        target_program_id: TARGET_PROGRAM_ID,
        transaction_result: v0Fixture(),
      })
    ).toThrow('base58-encoded 64-byte signature')
    expect(() =>
      projectDexSolanaProgramHits({
        signature: SIGNATURE,
        target_program_id: 'bad',
        transaction_result: v0Fixture(),
      })
    ).toThrow('base58-encoded 32-byte public key')
  })

  it('strictly parses the closed projection schema and cross-field invariants', () => {
    const projection = project()

    expect(() =>
      parseDexSolanaProgramHitProjection({ ...projection, provider: 'invented' })
    ).toThrow()

    const wrongCount = clone(projection)
    wrongCount.target_hit_count -= 1
    expect(() => parseDexSolanaProgramHitProjection(wrongCount)).toThrow(
      'target hit count does not match'
    )

    const wrongProgram = clone(projection)
    wrongProgram.hits[0].program_id = OTHER_PROGRAM_ID
    expect(() => parseDexSolanaProgramHitProjection(wrongProgram)).toThrow('different program id')

    const wrongPrefix = clone(projection)
    wrongPrefix.hits[0].data_prefix8_hex = null
    expect(() => parseDexSolanaProgramHitProjection(wrongPrefix)).toThrow('8-byte prefix conflicts')

    const wrongInnerState = clone(projection)
    wrongInnerState.inner_instructions_state = 'verified_empty'
    expect(() => parseDexSolanaProgramHitProjection(wrongInnerState)).toThrow(
      'inner instruction state conflicts'
    )

    const wrongLegacyAlt = clone(projection)
    wrongLegacyAlt.transaction_version = 'legacy'
    expect(() => parseDexSolanaProgramHitProjection(wrongLegacyAlt)).toThrow(
      'legacy transactions cannot declare'
    )

    const wrongOuterDataBound = clone(projection)
    wrongOuterDataBound.hits[1].data_byte_length = 1_233
    wrongOuterDataBound.hits[1].data_prefix8_hex = '0000000000000000'
    expect(() => parseDexSolanaProgramHitProjection(wrongOuterDataBound)).toThrow(
      'instruction-path byte bound'
    )

    const wrongOrder = clone(projection)
    wrongOrder.hits.reverse()
    expect(() => parseDexSolanaProgramHitProjection(wrongOrder)).toThrow(
      'canonical instruction order'
    )
  })

  it('hashes only a valid closed projection and changes with a valid fact mutation', () => {
    const projection = project()
    const changed = clone(projection)
    changed.slot_decimal = String(Number(changed.slot_decimal) + 1)

    expect(dexSolanaProgramHitProjectionSha256(changed)).not.toBe(
      dexSolanaProgramHitProjectionSha256(projection)
    )
    expect(() =>
      dexSolanaProgramHitProjectionSha256({ ...projection, raw_response: 'forbidden' })
    ).toThrow()
  })
})
