import { createHash } from 'node:crypto'

import { PublicKey } from '@solana/web3.js'

import {
  findSolanaV3ProgramDataAddress,
  parseSolanaV3ProgramDeploymentObservation,
  SOLANA_BPF_LOADER_V3,
  SOLANA_PROGRAM_ACCOUNT_MAX_DECODED_BYTES,
  SOLANA_V3_PROGRAMDATA_HEADER_BYTES,
  SOLANA_V3_PROGRAM_OBSERVATION_PROOF_BOUNDARY,
} from '../solana-program-deployment-evidence'

const PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const PROGRAMDATA_ADDRESS = '4Ec7ZxZS6Sbdg5UGSLHbAnM7GQHp2eFd4KYWRexAipQT'
const UPGRADE_AUTHORITY = 'CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ'
const OTHER_PUBLIC_KEY = '11111111111111111111111111111111'
const LAST_MODIFIED_SLOT = 433_056_714n
const ANCHOR_SLOT = 433_666_400
const CONTEXT_SLOT = 433_666_418

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function programBytes(pointer = PROGRAMDATA_ADDRESS, tag = 2): Buffer {
  const bytes = Buffer.alloc(36)
  bytes.writeUInt32LE(tag, 0)
  new PublicKey(pointer).toBuffer().copy(bytes, 4)
  return bytes
}

function programDataBytes(
  options: {
    tag?: number
    slot?: bigint
    authorityOption?: number
    authority?: string
    code?: readonly number[]
    dirtyRevokedAuthority?: boolean
  } = {}
): Buffer {
  const code = Uint8Array.from(options.code ?? [0xde, 0xad, 0xbe, 0xef, 0, 0])
  const bytes = Buffer.alloc(SOLANA_V3_PROGRAMDATA_HEADER_BYTES + code.byteLength)
  bytes.writeUInt32LE(options.tag ?? 3, 0)
  bytes.writeBigUInt64LE(options.slot ?? LAST_MODIFIED_SLOT, 4)
  const authorityOption = options.authorityOption ?? 1
  bytes[12] = authorityOption
  if (authorityOption === 1) {
    new PublicKey(options.authority ?? UPGRADE_AUTHORITY).toBuffer().copy(bytes, 13)
  } else if (options.dirtyRevokedAuthority) {
    bytes.fill(0xa5, 13, 45)
  }
  bytes.set(code, SOLANA_V3_PROGRAMDATA_HEADER_BYTES)
  return bytes
}

function rpcAccount(
  bytes: Uint8Array,
  options: {
    executable: boolean
    owner?: string
    space?: number
    lamports?: number
    rentEpoch?: number
  }
) {
  return {
    data: [Buffer.from(bytes).toString('base64'), 'base64'],
    executable: options.executable,
    lamports: options.lamports ?? 1_234_567,
    owner: options.owner ?? SOLANA_BPF_LOADER_V3,
    rentEpoch: options.rentEpoch ?? 18_446_744_073_709_552_000,
    space: options.space ?? bytes.byteLength,
  }
}

function fixture(
  program = programBytes(),
  programData = programDataBytes()
): {
  program_id: string
  programdata_address: string
  requested_min_context_slot: number
  result: {
    context: { apiVersion: string; slot: number }
    value: ReturnType<typeof rpcAccount>[]
  }
} {
  return {
    program_id: PROGRAM_ID,
    programdata_address: PROGRAMDATA_ADDRESS,
    requested_min_context_slot: ANCHOR_SLOT,
    result: {
      context: { apiVersion: '2.1.21', slot: CONTEXT_SLOT },
      value: [
        rpcAccount(program, { executable: true }),
        rpcAccount(programData, { executable: false }),
      ],
    },
  }
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const child of value) collectKeys(child, keys)
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key)
      collectKeys(child, keys)
    }
  }
  return keys
}

describe('Solana v3 program deployment observation', () => {
  it('derives the canonical Jupiter ProgramData PDA and bump', () => {
    expect(findSolanaV3ProgramDataAddress(PROGRAM_ID)).toEqual({
      address: PROGRAMDATA_ADDRESS,
      bump_seed: 254,
    })
    expect(findSolanaV3ProgramDataAddress('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')).toEqual({
      address: 'A7ZG7ByDi8DpzT9Ab7CiXhvgYTJQmaDPJkMDoPitaCQV',
      bump_seed: 255,
    })
  })

  it('parses exact Program and ProgramData state into metadata-only evidence', () => {
    const program = programBytes()
    const programData = programDataBytes()
    const code = programData.subarray(SOLANA_V3_PROGRAMDATA_HEADER_BYTES)

    const observation = parseSolanaV3ProgramDeploymentObservation(fixture(program, programData))

    expect(observation).toEqual({
      chain: 'solana',
      semantic_state: 'v3_program_and_programdata_accounts_consistent',
      proof_boundary: SOLANA_V3_PROGRAM_OBSERVATION_PROOF_BOUNDARY,
      loader_program_id: SOLANA_BPF_LOADER_V3,
      program_id: PROGRAM_ID,
      programdata_address: PROGRAMDATA_ADDRESS,
      programdata_bump_seed: 254,
      requested_min_context_slot_decimal: String(ANCHOR_SLOT),
      accounts_context_slot_decimal: String(CONTEXT_SLOT),
      program_account: {
        owner: SOLANA_BPF_LOADER_V3,
        executable: true,
        space: 36,
        data_sha256: sha256(program),
        programdata_address: PROGRAMDATA_ADDRESS,
      },
      programdata_account: {
        owner: SOLANA_BPF_LOADER_V3,
        executable: false,
        space: programData.byteLength,
        data_sha256: sha256(programData),
        last_modified_slot_decimal: LAST_MODIFIED_SLOT.toString(),
        effective_slot_decimal: (LAST_MODIFIED_SLOT + 1n).toString(),
        upgrade_authority: {
          state: 'present',
          address: UPGRADE_AUTHORITY,
        },
        code_offset_bytes: 45,
        code_byte_length: code.byteLength,
        code_sha256: sha256(code),
        code_hash_basis:
          'programdata_allocated_bytes_after_45_byte_state_header_including_trailing_zeros',
      },
    })

    const keys = collectKeys(observation)
    for (const forbidden of [
      'data',
      'dataBase64',
      'bytes',
      'body',
      'url',
      'lamports',
      'rentEpoch',
      'apiVersion',
      'serving_authorized',
      'rank_eligible',
      'score_eligible',
      'decoder_facts_verified',
    ]) {
      expect(keys.has(forbidden)).toBe(false)
    }
  })

  it('keeps revoked authority residue outside the fixed 45-byte code boundary', () => {
    const programData = programDataBytes({
      authorityOption: 0,
      dirtyRevokedAuthority: true,
      code: [1, 2, 3, 0, 0],
    })
    const code = programData.subarray(45)

    const observation = parseSolanaV3ProgramDeploymentObservation(
      fixture(programBytes(), programData)
    )

    expect(observation.programdata_account.upgrade_authority).toEqual({
      state: 'revoked',
      address: null,
    })
    expect(observation.programdata_account.code_byte_length).toBe(5)
    expect(observation.programdata_account.code_sha256).toBe(sha256(code))
  })

  it('accepts context without apiVersion and excludes transport-only account fields', () => {
    const input = fixture()
    const withoutVersion = { slot: CONTEXT_SLOT + 1 }
    ;(input.result as { context: unknown }).context = withoutVersion
    input.result.value[0].lamports = 9_999
    input.result.value[0].rentEpoch = 0

    const observation = parseSolanaV3ProgramDeploymentObservation(input)

    expect(observation.accounts_context_slot_decimal).toBe(String(CONTEXT_SLOT + 1))
    expect(observation.program_account).not.toHaveProperty('lamports')
  })

  it.each([
    [
      'foreign Program owner',
      (input: ReturnType<typeof fixture>) => {
        input.result.value[0].owner = OTHER_PUBLIC_KEY
      },
      'Program account owner is not loader v3',
    ],
    [
      'non-executable Program',
      (input: ReturnType<typeof fixture>) => {
        input.result.value[0].executable = false
      },
      'Program account must be executable',
    ],
    [
      'Program state tag',
      (input: ReturnType<typeof fixture>) => {
        input.result.value[0] = rpcAccount(programBytes(PROGRAMDATA_ADDRESS, 1), {
          executable: true,
        })
      },
      'Program account state tag is not Program',
    ],
    [
      'Program pointer',
      (input: ReturnType<typeof fixture>) => {
        input.result.value[0] = rpcAccount(programBytes(UPGRADE_AUTHORITY), {
          executable: true,
        })
      },
      'Program account pointer does not match',
    ],
    [
      'ProgramData owner',
      (input: ReturnType<typeof fixture>) => {
        input.result.value[1].owner = OTHER_PUBLIC_KEY
      },
      'ProgramData owner is not loader v3',
    ],
    [
      'executable ProgramData',
      (input: ReturnType<typeof fixture>) => {
        input.result.value[1].executable = true
      },
      'ProgramData account must not be executable',
    ],
    [
      'ProgramData state tag',
      (input: ReturnType<typeof fixture>) => {
        input.result.value[1] = rpcAccount(programDataBytes({ tag: 2 }), {
          executable: false,
        })
      },
      'ProgramData state tag is not ProgramData',
    ],
    [
      'invalid authority option',
      (input: ReturnType<typeof fixture>) => {
        input.result.value[1] = rpcAccount(programDataBytes({ authorityOption: 2 }), {
          executable: false,
        })
      },
      'upgrade-authority option tag is invalid',
    ],
    [
      'default upgrade authority',
      (input: ReturnType<typeof fixture>) => {
        input.result.value[1] = rpcAccount(programDataBytes({ authority: OTHER_PUBLIC_KEY }), {
          executable: false,
        })
      },
      'upgrade authority cannot be the default key',
    ],
    [
      'empty code',
      (input: ReturnType<typeof fixture>) => {
        input.result.value[1] = rpcAccount(programDataBytes({ code: [] }), {
          executable: false,
        })
      },
      'must contain code after the 45-byte state header',
    ],
    [
      'effective-slot overflow',
      (input: ReturnType<typeof fixture>) => {
        input.result.value[1] = rpcAccount(programDataBytes({ slot: (1n << 64n) - 1n }), {
          executable: false,
        })
      },
      'effective slot would overflow u64',
    ],
    [
      'space mismatch',
      (input: ReturnType<typeof fixture>) => {
        input.result.value[1].space += 1
      },
      'data must be canonical bounded base64',
    ],
    [
      'context before anchor',
      (input: ReturnType<typeof fixture>) => {
        input.result.context.slot = ANCHOR_SLOT - 1
      },
      'context predates the requested minimum context slot',
    ],
    [
      'context before effective slot',
      (input: ReturnType<typeof fixture>) => {
        input.requested_min_context_slot = Number(LAST_MODIFIED_SLOT - 1n)
        input.result.context.slot = Number(LAST_MODIFIED_SLOT)
      },
      'context predates the ProgramData effective slot',
    ],
    [
      'wrong derived PDA',
      (input: ReturnType<typeof fixture>) => {
        input.programdata_address = UPGRADE_AUTHORITY
      },
      'not the canonical loader-v3 PDA',
    ],
  ])('fails closed for %s', (_label, mutate, expected) => {
    const input = fixture()
    mutate(input)
    expect(() => parseSolanaV3ProgramDeploymentObservation(input)).toThrow(expected)
  })

  it.each([
    [
      'null Program',
      (input: any) => {
        input.result.value[0] = null
      },
    ],
    [
      'reversed rows',
      (input: any) => {
        input.result.value.reverse()
      },
    ],
    [
      'extra row',
      (input: any) => {
        input.result.value.push(input.result.value[0])
      },
    ],
    [
      'extra account field',
      (input: any) => {
        input.result.value[0].raw = 'forbidden'
      },
    ],
    [
      'extra result field',
      (input: any) => {
        input.result.raw = 'forbidden'
      },
    ],
    [
      'accessor input',
      (input: any) => {
        Object.defineProperty(input.result.value[0], 'owner', {
          enumerable: true,
          get: () => SOLANA_BPF_LOADER_V3,
        })
      },
    ],
    [
      'noncanonical base64',
      (input: any) => {
        input.result.value[0].data[0] = `${input.result.value[0].data[0].slice(0, -1)}_`
      },
    ],
  ])('rejects malformed %s without returning partial metadata', (_label, mutate) => {
    const input: any = clone(fixture())
    mutate(input)
    expect(() => parseSolanaV3ProgramDeploymentObservation(input)).toThrow(
      'invalid Solana v3 program deployment observation'
    )
  })

  it('clears every base64-decoded account buffer after success and semantic failure', () => {
    const originalFrom = Buffer.from.bind(Buffer)
    const decoded: Buffer[] = []
    const fromSpy = jest.spyOn(Buffer, 'from').mockImplementation(((
      value: unknown,
      encoding?: BufferEncoding
    ) => {
      const result =
        typeof value === 'string' && encoding !== undefined
          ? originalFrom(value, encoding)
          : originalFrom(value as Uint8Array)
      if (encoding === 'base64') decoded.push(result)
      return result
    }) as typeof Buffer.from)

    try {
      expect(() => parseSolanaV3ProgramDeploymentObservation(fixture())).not.toThrow()
      const invalid = fixture()
      invalid.result.value[1] = rpcAccount(programDataBytes({ tag: 2 }), {
        executable: false,
      })
      expect(() => parseSolanaV3ProgramDeploymentObservation(invalid)).toThrow(
        'ProgramData state tag is not ProgramData'
      )
    } finally {
      fromSpy.mockRestore()
    }

    expect(decoded).toHaveLength(4)
    expect(decoded.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
  })

  it('accepts the exact 10 MiB Solana account-data limit without trimming code zeros', () => {
    const programData = Buffer.alloc(SOLANA_PROGRAM_ACCOUNT_MAX_DECODED_BYTES)
    programData.writeUInt32LE(3, 0)
    programData.writeBigUInt64LE(LAST_MODIFIED_SLOT, 4)
    programData[12] = 1
    new PublicKey(UPGRADE_AUTHORITY).toBuffer().copy(programData, 13)
    programData[45] = 0x7f

    try {
      const observation = parseSolanaV3ProgramDeploymentObservation(
        fixture(programBytes(), programData)
      )
      expect(observation.programdata_account.space).toBe(SOLANA_PROGRAM_ACCOUNT_MAX_DECODED_BYTES)
      expect(observation.programdata_account.code_byte_length).toBe(
        SOLANA_PROGRAM_ACCOUNT_MAX_DECODED_BYTES - 45
      )
      expect(observation.programdata_account.code_sha256).toBe(sha256(programData.subarray(45)))
    } finally {
      programData.fill(0)
    }
  })

  it('rejects oversized or length-conflicting declarations before decoding offending data', () => {
    const originalFrom = Buffer.from.bind(Buffer)
    const decoded: Buffer[] = []
    const fromSpy = jest.spyOn(Buffer, 'from').mockImplementation(((
      value: unknown,
      encoding?: BufferEncoding
    ) => {
      const result =
        typeof value === 'string' && encoding !== undefined
          ? originalFrom(value, encoding)
          : originalFrom(value as Uint8Array)
      if (encoding === 'base64') decoded.push(result)
      return result
    }) as typeof Buffer.from)

    try {
      const oversizedProgram = fixture()
      oversizedProgram.result.value[0].space = SOLANA_PROGRAM_ACCOUNT_MAX_DECODED_BYTES
      expect(() => parseSolanaV3ProgramDeploymentObservation(oversizedProgram)).toThrow(
        'Program account space conflicts with its fixed state size'
      )
      expect(decoded).toHaveLength(0)

      const oversized = fixture()
      oversized.result.value[1].space = SOLANA_PROGRAM_ACCOUNT_MAX_DECODED_BYTES + 1
      expect(() => parseSolanaV3ProgramDeploymentObservation(oversized)).toThrow(
        'space exceeds the Solana account data byte bound'
      )
      expect(decoded.map((bytes) => bytes.byteLength)).toEqual([36])
      expect(decoded[0].every((byte) => byte === 0)).toBe(true)

      const conflicting = fixture()
      conflicting.result.value[1].space += 1
      expect(() => parseSolanaV3ProgramDeploymentObservation(conflicting)).toThrow(
        'data must be canonical bounded base64'
      )
      expect(decoded.map((bytes) => bytes.byteLength)).toEqual([36, 36])
      expect(decoded[1].every((byte) => byte === 0)).toBe(true)
    } finally {
      fromSpy.mockRestore()
    }

    expect(decoded).toHaveLength(2)
  })

  it('sanitizes hostile inspection failures', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('private-api-key')
        },
      }
    )

    expect(() => parseSolanaV3ProgramDeploymentObservation(hostile)).toThrow(
      'input could not be inspected safely'
    )
    expect(() => parseSolanaV3ProgramDeploymentObservation(hostile)).not.toThrow('private-api-key')
  })
})
