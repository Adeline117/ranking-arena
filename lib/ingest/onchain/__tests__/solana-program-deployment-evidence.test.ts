import { createHash } from 'node:crypto'

import { PublicKey } from '@solana/web3.js'

import { requireSolanaVerifiedChainAnchor, SOLANA_MAINNET_GENESIS_HASH } from '../solana-evidence'
import * as solanaEvidenceCore from '../solana-evidence-core'
import type { SolanaRawRpcEvidenceExchange } from '../solana-evidence-core'
import { RAW_RPC_REQUEST_HASH_BASIS, RAW_RPC_RESPONSE_HASH_BASIS } from '../raw-rpc-evidence'
import {
  captureSolanaV3ProgramDeploymentObservation,
  disposeSolanaV3ProgramDeploymentRawCapture,
  findSolanaV3ProgramDataAddress,
  parseSolanaV3ProgramDeploymentObservation,
  replaySolanaV3ProgramDeploymentRawCapture,
  SOLANA_BPF_LOADER_V3,
  SOLANA_PROGRAM_ACCOUNT_MAX_DECODED_BYTES,
  SOLANA_V3_PROGRAMDATA_HEADER_BYTES,
  SOLANA_V3_PROGRAM_OBSERVATION_PROOF_BOUNDARY,
} from '../solana-program-deployment-evidence'

jest.mock('../solana-evidence-core', () => {
  const actual =
    jest.requireActual<typeof import('../solana-evidence-core')>('../solana-evidence-core')
  return {
    ...actual,
    disposeSolanaRawRpcEvidenceExchanges: jest.fn(actual.disposeSolanaRawRpcEvidenceExchanges),
    solanaEvidenceRpc: jest.fn(actual.solanaEvidenceRpc),
  }
})

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

interface CaptureRpcRequest {
  jsonrpc: '2.0'
  id: 1
  method: string
  params: unknown[]
}

const CAPTURE_RPC_URL = 'http://127.0.0.1:8899/'
const CAPTURE_ENDPOINT_ID = 'local_solana_node' as const
const CAPTURE_NOW = '2026-07-18T00:00:00.000Z'
const CAPTURE_BLOCK_HASH = '66VMKCNBU8H2CQsYVFm94vv8Qobz7EgxPTxw7CyystSu'
const CAPTURE_PREVIOUS_BLOCK_HASH = '3kvmuuz5t9rDT3YBdBhhrRwEcn9hnMnVm4nLXNzrro93'

function mockDeploymentCaptureRpc(
  programData = programDataBytes(),
  options: { programAccountsHttpStatus?: number } = {}
) {
  const calls: CaptureRpcRequest[] = []
  const sourceChunks: Uint8Array[] = []
  global.fetch = jest.fn(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as CaptureRpcRequest
    calls.push(request)
    if (
      request.method === 'getMultipleAccounts' &&
      options.programAccountsHttpStatus !== undefined
    ) {
      return {
        status: options.programAccountsHttpStatus,
        headers: { get: () => null },
        body: { cancel: jest.fn(async () => undefined) },
      } as unknown as Response
    }
    const result =
      request.method === 'getGenesisHash'
        ? SOLANA_MAINNET_GENESIS_HASH
        : request.method === 'getSlot'
          ? CONTEXT_SLOT
          : request.method === 'getBlocks'
            ? [CONTEXT_SLOT]
            : request.method === 'getBlock'
              ? {
                  blockhash: CAPTURE_BLOCK_HASH,
                  previousBlockhash: CAPTURE_PREVIOUS_BLOCK_HASH,
                  parentSlot: CONTEXT_SLOT - 1,
                  blockTime: Math.floor(Date.parse(CAPTURE_NOW) / 1000) - 30,
                  blockHeight: CONTEXT_SLOT - 10,
                }
              : fixture(programBytes(), programData).result
    const sourceBytes = new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
    sourceChunks.push(sourceBytes)
    return {
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => {
          let emitted = false
          return {
            read: jest.fn(async () => {
              if (emitted) return { done: true, value: undefined }
              emitted = true
              return { done: false, value: sourceBytes }
            }),
            cancel: jest.fn(async () => undefined),
          }
        },
      },
    } as unknown as Response
  }) as jest.MockedFunction<typeof fetch>
  return { calls, sourceChunks }
}

function coreRpcMock(): jest.MockedFunction<typeof solanaEvidenceCore.solanaEvidenceRpc> {
  return solanaEvidenceCore.solanaEvidenceRpc as jest.MockedFunction<
    typeof solanaEvidenceCore.solanaEvidenceRpc
  >
}

function resetCoreRpcMock(): void {
  const actual =
    jest.requireActual<typeof import('../solana-evidence-core')>('../solana-evidence-core')
  coreRpcMock().mockReset().mockImplementation(actual.solanaEvidenceRpc)
}

function replaceRawBody(
  exchange: SolanaRawRpcEvidenceExchange,
  kind: 'request' | 'response',
  text: string
): void {
  exchange[kind].bytes.fill(0)
  const bytes = new TextEncoder().encode(text)
  const evidence = {
    bytes,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
  }
  if (kind === 'request') {
    exchange.request = { ...evidence, hashBasis: RAW_RPC_REQUEST_HASH_BASIS }
  } else {
    exchange.response = { ...evidence, hashBasis: RAW_RPC_RESPONSE_HASH_BASIS }
  }
}

function mutateRawJsonBody(
  exchange: SolanaRawRpcEvidenceExchange,
  kind: 'request' | 'response',
  mutate: (document: Record<string, unknown>) => void
): void {
  const document = JSON.parse(new TextDecoder().decode(exchange[kind].bytes)) as Record<
    string,
    unknown
  >
  mutate(document)
  replaceRawBody(exchange, kind, JSON.stringify(document))
}

type CoreRpcResult = Awaited<ReturnType<typeof solanaEvidenceCore.solanaEvidenceRpc>>
type CoreRpcSuccess = Extract<CoreRpcResult, { ok: true }>

function interceptProgramRpc(transform: (result: CoreRpcSuccess) => CoreRpcResult): void {
  const actual =
    jest.requireActual<typeof import('../solana-evidence-core')>('../solana-evidence-core')
  coreRpcMock().mockImplementation(async (...args) => {
    const result = await actual.solanaEvidenceRpc(...args)
    return args[1] === 'getMultipleAccounts' && result.ok ? transform(result) : result
  })
}

function coreDisposeMock(): jest.MockedFunction<
  typeof solanaEvidenceCore.disposeSolanaRawRpcEvidenceExchanges
> {
  return solanaEvidenceCore.disposeSolanaRawRpcEvidenceExchanges as jest.MockedFunction<
    typeof solanaEvidenceCore.disposeSolanaRawRpcEvidenceExchanges
  >
}

function expectDisposedExchangeCount(count: number): SolanaRawRpcEvidenceExchange[] {
  const disposeMock = coreDisposeMock()
  expect(disposeMock).toHaveBeenCalledTimes(1)
  const disposed = [...disposeMock.mock.calls[0][0]] as SolanaRawRpcEvidenceExchange[]
  expect(disposed).toHaveLength(count)
  expect(
    disposed.every(
      (exchange) =>
        exchange.request.bytes.every((byte) => byte === 0) &&
        exchange.response.bytes.every((byte) => byte === 0)
    )
  ).toBe(true)
  return disposed
}

describe('Solana v3 program deployment raw capture', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(CAPTURE_NOW))
  })

  afterEach(() => {
    global.fetch = originalFetch
    resetCoreRpcMock()
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it('binds one endpoint anchor and exact program-account request in one owned lifecycle', async () => {
    const { calls, sourceChunks } = mockDeploymentCaptureRpc()

    const capture = await captureSolanaV3ProgramDeploymentObservation(PROGRAM_ID, {
      rpcUrl: CAPTURE_RPC_URL,
      endpointId: CAPTURE_ENDPOINT_ID,
      timeoutMs: 20_000,
    })

    expect(calls.map((call) => call.method)).toEqual([
      'getGenesisHash',
      'getSlot',
      'getBlocks',
      'getBlock',
      'getMultipleAccounts',
    ])
    expect(calls[4]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'getMultipleAccounts',
      params: [
        [PROGRAM_ID, PROGRAMDATA_ADDRESS],
        {
          commitment: 'finalized',
          encoding: 'base64',
          minContextSlot: CONTEXT_SLOT,
        },
      ],
    })
    expect(capture.anchor.verified.finalizedRootSlot).toBe(CONTEXT_SLOT)
    expect(capture.anchor.verified).toEqual(
      requireSolanaVerifiedChainAnchor(capture.anchor.evidence)
    )
    expect(capture.anchor.evidence.finalizedRootSlot).toMatchObject({
      status: 'available',
      value: CONTEXT_SLOT,
    })
    expect(capture.observation).toMatchObject({
      program_id: PROGRAM_ID,
      programdata_address: PROGRAMDATA_ADDRESS,
      requested_min_context_slot_decimal: String(CONTEXT_SLOT),
      accounts_context_slot_decimal: String(CONTEXT_SLOT),
    })
    const rawExchanges = [...capture.anchor.rawExchanges, capture.programAccountsExchange]
    expect(rawExchanges.map((exchange) => exchange.lane)).toEqual([
      'genesis_hash',
      'finalized_anchor_slot',
      'finalized_anchor_produced_slots',
      'finalized_anchor_block',
      'program_accounts',
    ])
    expect(sourceChunks).toHaveLength(5)
    expect(sourceChunks.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
    expect(
      rawExchanges.some(
        (exchange) =>
          exchange.request.bytes.some((byte) => byte !== 0) ||
          exchange.response.bytes.some((byte) => byte !== 0)
      )
    ).toBe(true)

    disposeSolanaV3ProgramDeploymentRawCapture(capture)
    expect(() => disposeSolanaV3ProgramDeploymentRawCapture(capture)).not.toThrow()
    expect(
      rawExchanges.every(
        (exchange) =>
          exchange.request.bytes.every((byte) => byte === 0) &&
          exchange.response.bytes.every((byte) => byte === 0)
      )
    ).toBe(true)
  })

  it('replays all five raw lanes and ignores forged embedded sidecars', async () => {
    mockDeploymentCaptureRpc()
    const capture = await captureSolanaV3ProgramDeploymentObservation(PROGRAM_ID, {
      rpcUrl: CAPTURE_RPC_URL,
      endpointId: CAPTURE_ENDPOINT_ID,
    })
    const expectedCodeSha256 = capture.observation.programdata_account.code_sha256
    capture.anchor.verified = {
      ...capture.anchor.verified,
      finalizedRootSlot: 1,
    }
    capture.observation = {
      ...capture.observation,
      programdata_account: {
        ...capture.observation.programdata_account,
        code_sha256: '0'.repeat(64),
      },
    }

    const replayed = replaySolanaV3ProgramDeploymentRawCapture(capture)

    expect(replayed.anchor.finalizedRootSlot).toBe(CONTEXT_SLOT)
    expect(replayed.observation.programdata_account.code_sha256).toBe(expectedCodeSha256)
    expect(replayed.rawExchanges.map((exchange) => exchange.lane)).toEqual([
      'genesis_hash',
      'finalized_anchor_slot',
      'finalized_anchor_produced_slots',
      'finalized_anchor_block',
      'program_accounts',
    ])
    expect(
      replayed.rawExchanges.some(
        (exchange) =>
          exchange.request.bytes.some((byte) => byte !== 0) ||
          exchange.response.bytes.some((byte) => byte !== 0)
      )
    ).toBe(true)

    disposeSolanaV3ProgramDeploymentRawCapture(capture)
    expect(
      replayed.rawExchanges.every(
        (exchange) =>
          exchange.request.bytes.every((byte) => byte === 0) &&
          exchange.response.bytes.every((byte) => byte === 0)
      )
    ).toBe(true)
  })

  it.each([
    [
      'genesis',
      0,
      (document: Record<string, unknown>) => {
        document.params = [null]
      },
    ],
    [
      'finalized root',
      1,
      (document: Record<string, unknown>) => {
        const params = document.params as [Record<string, unknown>]
        params[0].commitment = 'confirmed'
      },
    ],
    [
      'produced slots',
      2,
      (document: Record<string, unknown>) => {
        const params = document.params as [number, number, Record<string, unknown>]
        params[2].minContextSlot = CONTEXT_SLOT - 1
      },
    ],
    [
      'finalized block',
      3,
      (document: Record<string, unknown>) => {
        const params = document.params as [number, Record<string, unknown>]
        params[1].rewards = true
      },
    ],
  ])(
    'rejects replayed %s anchor request drift after metadata is recomputed',
    async (_label, index, mutate) => {
      mockDeploymentCaptureRpc()
      const capture = await captureSolanaV3ProgramDeploymentObservation(PROGRAM_ID, {
        rpcUrl: CAPTURE_RPC_URL,
        endpointId: CAPTURE_ENDPOINT_ID,
      })
      mutateRawJsonBody(capture.anchor.rawExchanges[index], 'request', mutate)

      expect(() => replaySolanaV3ProgramDeploymentRawCapture(capture)).toThrow(
        'does not match the normalized anchor'
      )
      expect(capture.anchor.rawExchanges[index].request.bytes.some((byte) => byte !== 0)).toBe(true)

      disposeSolanaV3ProgramDeploymentRawCapture(capture)
      expect(capture.anchor.rawExchanges[index].request.bytes.every((byte) => byte === 0)).toBe(
        true
      )
    }
  )

  it.each([
    [
      'genesis',
      0,
      (document: Record<string, unknown>) => {
        document.result = OTHER_PUBLIC_KEY
      },
    ],
    [
      'finalized root',
      1,
      (document: Record<string, unknown>) => {
        document.result = CONTEXT_SLOT + 1
      },
    ],
    [
      'produced slots',
      2,
      (document: Record<string, unknown>) => {
        document.result = [CONTEXT_SLOT - 1]
      },
    ],
    [
      'finalized block',
      3,
      (document: Record<string, unknown>) => {
        const result = document.result as Record<string, unknown>
        result.blockHeight = CONTEXT_SLOT
      },
    ],
  ])(
    'rejects replayed %s anchor response drift after metadata is recomputed',
    async (_label, index, mutate) => {
      mockDeploymentCaptureRpc()
      const capture = await captureSolanaV3ProgramDeploymentObservation(PROGRAM_ID, {
        rpcUrl: CAPTURE_RPC_URL,
        endpointId: CAPTURE_ENDPOINT_ID,
      })
      mutateRawJsonBody(capture.anchor.rawExchanges[index], 'response', mutate)

      expect(() => replaySolanaV3ProgramDeploymentRawCapture(capture)).toThrow(
        'does not match the normalized anchor'
      )
      expect(capture.anchor.rawExchanges[index].response.bytes.some((byte) => byte !== 0)).toBe(
        true
      )

      disposeSolanaV3ProgramDeploymentRawCapture(capture)
      expect(capture.anchor.rawExchanges[index].response.bytes.every((byte) => byte === 0)).toBe(
        true
      )
    }
  )

  it('rejects an anchor lane sidecar that conflicts with its raw method order', async () => {
    mockDeploymentCaptureRpc()
    const capture = await captureSolanaV3ProgramDeploymentObservation(PROGRAM_ID, {
      rpcUrl: CAPTURE_RPC_URL,
      endpointId: CAPTURE_ENDPOINT_ID,
    })
    capture.anchor.rawExchanges[0].lane = 'finalized_anchor_slot'

    expect(() => replaySolanaV3ProgramDeploymentRawCapture(capture)).toThrow(
      'raw RPC exchange conflicts with its verified endpoint or lane'
    )

    disposeSolanaV3ProgramDeploymentRawCapture(capture)
  })

  it('ignores a conflicting valid sidecar and rejects invalid raw response semantics', async () => {
    const { sourceChunks } = mockDeploymentCaptureRpc(programDataBytes({ tag: 2 }))
    interceptProgramRpc((result) => ({
      ...result,
      result: fixture(programBytes(), programDataBytes()).result,
    }))
    coreDisposeMock().mockClear()

    await expect(
      captureSolanaV3ProgramDeploymentObservation(PROGRAM_ID, {
        rpcUrl: CAPTURE_RPC_URL,
        endpointId: CAPTURE_ENDPOINT_ID,
      })
    ).rejects.toThrow('ProgramData state tag is not ProgramData')

    expect(sourceChunks.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
    expectDisposedExchangeCount(5)
  })

  it.each([
    [
      'program id',
      (request: { params: [string[], Record<string, unknown>] }) => {
        request.params[0][0] = `K${PROGRAM_ID.slice(1)}`
      },
    ],
    [
      'address order',
      (request: { params: [string[], Record<string, unknown>] }) => {
        request.params[0].reverse()
      },
    ],
    [
      'commitment',
      (request: { params: [string[], Record<string, unknown>] }) => {
        request.params[1].commitment = 'confirmed'
      },
    ],
    [
      'encoding',
      (request: { params: [string[], Record<string, unknown>] }) => {
        request.params[1].encoding = 'base64+zstd'
      },
    ],
    [
      'minimum context slot',
      (request: { params: [string[], Record<string, unknown>] }) => {
        request.params[1].minContextSlot = CONTEXT_SLOT - 1
      },
    ],
    [
      'extra config field',
      (request: { params: [string[], Record<string, unknown>] }) => {
        request.params[1].extra = true
      },
    ],
  ])(
    'rejects raw request %s drift even when the parsed sidecar is valid',
    async (_label, mutate) => {
      const { sourceChunks } = mockDeploymentCaptureRpc()
      coreDisposeMock().mockClear()
      interceptProgramRpc((result) => {
        const exchange = result.rawExchange
        if (!exchange) throw new Error('test fixture did not capture raw program accounts')
        const request = JSON.parse(new TextDecoder().decode(exchange.request.bytes)) as {
          params: [string[], Record<string, unknown>]
        }
        mutate(request)
        replaceRawBody(exchange, 'request', JSON.stringify(request))
        return result
      })

      await expect(
        captureSolanaV3ProgramDeploymentObservation(PROGRAM_ID, {
          rpcUrl: CAPTURE_RPC_URL,
          endpointId: CAPTURE_ENDPOINT_ID,
        })
      ).rejects.toThrow('raw program account request does not match the verified anchor')

      expect(sourceChunks.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
      expectDisposedExchangeCount(5)
    }
  )

  it.each([
    [
      'sha256',
      (exchange: SolanaRawRpcEvidenceExchange) => {
        exchange.response.sha256 = '0'.repeat(64)
      },
    ],
    [
      'byte length',
      (exchange: SolanaRawRpcEvidenceExchange) => {
        exchange.response.byteLength += 1
      },
    ],
    [
      'hash basis',
      (exchange: SolanaRawRpcEvidenceExchange) => {
        ;(exchange.response as { hashBasis: string }).hashBasis = RAW_RPC_REQUEST_HASH_BASIS
      },
    ],
  ])('rejects forged raw response %s metadata and clears all bytes', async (_label, mutate) => {
    const { sourceChunks } = mockDeploymentCaptureRpc()
    coreDisposeMock().mockClear()
    interceptProgramRpc((result) => {
      const exchange = result.rawExchange
      if (!exchange) throw new Error('test fixture did not capture raw program accounts')
      mutate(exchange)
      return result
    })

    await expect(
      captureSolanaV3ProgramDeploymentObservation(PROGRAM_ID, {
        rpcUrl: CAPTURE_RPC_URL,
        endpointId: CAPTURE_ENDPOINT_ID,
      })
    ).rejects.toThrow('raw RPC response hash, length, or basis is invalid')

    expect(sourceChunks.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
    expectDisposedExchangeCount(5)
  })

  it('rejects extra fields in the raw JSON-RPC response envelope', async () => {
    const { sourceChunks } = mockDeploymentCaptureRpc()
    coreDisposeMock().mockClear()
    interceptProgramRpc((result) => {
      const exchange = result.rawExchange
      if (!exchange) throw new Error('test fixture did not capture raw program accounts')
      replaceRawBody(
        exchange,
        'response',
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: result.result,
          extra: true,
        })
      )
      return result
    })

    await expect(
      captureSolanaV3ProgramDeploymentObservation(PROGRAM_ID, {
        rpcUrl: CAPTURE_RPC_URL,
        endpointId: CAPTURE_ENDPOINT_ID,
      })
    ).rejects.toThrow('raw program account response is not a successful JSON-RPC result')

    expect(sourceChunks.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
    expectDisposedExchangeCount(5)
  })

  it('clears the four anchor exchanges when the program-account RPC is unavailable', async () => {
    const { calls, sourceChunks } = mockDeploymentCaptureRpc(programDataBytes(), {
      programAccountsHttpStatus: 503,
    })
    coreDisposeMock().mockClear()

    await expect(
      captureSolanaV3ProgramDeploymentObservation(PROGRAM_ID, {
        rpcUrl: CAPTURE_RPC_URL,
        endpointId: CAPTURE_ENDPOINT_ID,
      })
    ).rejects.toThrow('program account RPC capture is unavailable')

    expect(calls.map((call) => call.method)).toEqual([
      'getGenesisHash',
      'getSlot',
      'getBlocks',
      'getBlock',
      'getMultipleAccounts',
    ])
    expect(sourceChunks).toHaveLength(4)
    expect(sourceChunks.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true)
    expectDisposedExchangeCount(4)
  })

  it('rejects an unapproved endpoint before network I/O', async () => {
    global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>

    await expect(
      captureSolanaV3ProgramDeploymentObservation(PROGRAM_ID, {
        rpcUrl: 'https://example.invalid/',
        endpointId: 'solana_official_mainnet',
      })
    ).rejects.toThrow('approved RPC endpoint is unavailable')

    expect(global.fetch).not.toHaveBeenCalled()
  })
})
