import { createHash } from 'node:crypto'

import { SOLANA_MAINNET_GENESIS_HASH, requireSolanaVerifiedChainAnchor } from '../solana-evidence'
import {
  captureSolanaVerifiedTransactionFinalityEvidence,
  fetchSolanaTransactionMembershipEvidence,
  requireSolanaVerifiedTransactionFinality,
  type SolanaCanonicalTransactionError,
} from '../solana-transaction-evidence'

interface RpcRequest {
  jsonrpc: string
  id: number
  method: string
  params: unknown[]
}

interface RpcReply {
  payload?: unknown
  status?: number
  body?: string
  error?: Error
  stream?: ReadableStream<Uint8Array>
}

interface RpcCall {
  url: string
  request: RpcRequest
  init: RequestInit
}

const SLOT = 433_347_059
const BLOCK_HASH = '66VMKCNBU8H2CQsYVFm94vv8Qobz7EgxPTxw7CyystSu'
const PREVIOUS_BLOCK_HASH = '3kvmuuz5t9rDT3YBdBhhrRwEcn9hnMnVm4nLXNzrro93'
const BLOCK_TIME = 1_784_235_622
const BLOCK_HEIGHT = 411_411_459
const FIXED_NOW = '2026-07-16T21:00:41.000Z'
const TEST_RPC_ORIGIN = 'http://127.0.0.1:8899'
const TEST_RPC_URL = `${TEST_RPC_ORIGIN}/`
const TEST_ENDPOINT_ID = 'local_solana_node' as const
const TEST_CONNECTION_HASH = createHash('sha256')
  .update(
    JSON.stringify(['solana_evidence_connection_v1', 'local', TEST_ENDPOINT_ID, TEST_RPC_ORIGIN])
  )
  .digest('hex')

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function encodeBase58(bytes: Uint8Array): string {
  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let index = 0; index < digits.length; index += 1) {
      const value = digits[index] * 256 + carry
      digits[index] = value % 58
      carry = Math.floor(value / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  let result = ''
  for (let index = 0; index < bytes.length - 1 && bytes[index] === 0; index += 1) result += '1'
  return (
    result +
    digits
      .reverse()
      .map((digit) => BASE58_ALPHABET[digit])
      .join('')
  )
}

function syntheticBase58(byteLength: number, label: string): string {
  const bytes = new Uint8Array(byteLength)
  bytes[0] = 1
  for (const [index, character] of [...label].entries()) {
    if (index + 1 >= bytes.length) break
    bytes[index + 1] = character.charCodeAt(0)
  }
  return encodeBase58(bytes)
}

const TX_SIGNATURE = syntheticBase58(64, 'target-transaction')
const OTHER_SIGNATURE = syntheticBase58(64, 'other-transaction')
const THIRD_SIGNATURE = syntheticBase58(64, 'third-transaction')
const LOWER_BLOCK_HASH = syntheticBase58(32, 'lower-block')
const LOWER_PREVIOUS_BLOCK_HASH = syntheticBase58(32, 'lower-parent')

function provider() {
  const endpoint = {
    providerId: 'local' as const,
    endpointId: TEST_ENDPOINT_ID,
    connectionHash: TEST_CONNECTION_HASH,
  }
  return { servedBy: endpoint, attempted: [{ ...endpoint }] }
}

function lane<T>(value: T, httpStatus = 200) {
  return { status: 'available' as const, value, provider: provider(), httpStatus }
}

function anchorBlock() {
  return {
    slot: SLOT,
    blockhash: BLOCK_HASH,
    previousBlockhash: PREVIOUS_BLOCK_HASH,
    parentSlot: SLOT - 1,
    blockTime: BLOCK_TIME,
    blockHeight: BLOCK_HEIGHT,
  }
}

function anchorFixture() {
  return {
    chain: { cluster: 'mainnet-beta', genesisHash: SOLANA_MAINNET_GENESIS_HASH },
    observedAt: FIXED_NOW,
    anchorPolicy: {
      version: 'solana_current_finalized_block_v1',
      genesisMethod: 'getGenesisHash',
      slotMethod: 'getSlot',
      blockMethod: 'getBlock',
      commitment: 'finalized',
      encoding: 'json',
      transactionDetails: 'none',
      maxSupportedTransactionVersion: 0,
      rewards: false,
      maxFutureBlockSkewMs: 60_000,
      maxCurrentAnchorLagMs: 900_000,
    },
    genesisHash: lane(SOLANA_MAINNET_GENESIS_HASH),
    finalizedSlot: lane(SLOT),
    finalizedBlock: lane(anchorBlock()),
  }
}

function successfulTransaction(
  patch: Record<string, unknown> = {},
  error: unknown = null,
  status: unknown = error === null ? { Ok: null } : { Err: error }
) {
  return {
    blockTime: BLOCK_TIME,
    meta: {
      err: error,
      status,
      fee: 5_000,
      logMessages: ['provider-only detail'],
    },
    slot: SLOT,
    transaction: {
      signatures: [TX_SIGNATURE],
      message: { providerOnly: true },
    },
    transactionIndex: 1,
    version: 0,
    ...patch,
  }
}

function successfulStatus(
  patch: Record<string, unknown> = {},
  error: unknown = null,
  status: unknown = error === null ? { Ok: null } : { Err: error }
) {
  return {
    context: { apiVersion: '4.0.0', slot: SLOT + 5 },
    value: [
      {
        slot: SLOT,
        confirmations: null,
        err: error,
        status,
        confirmationStatus: 'finalized',
        ...patch,
      },
    ],
  }
}

function successfulBlock(patch: Record<string, unknown> = {}) {
  return {
    blockhash: BLOCK_HASH,
    previousBlockhash: PREVIOUS_BLOCK_HASH,
    parentSlot: SLOT - 1,
    blockTime: BLOCK_TIME,
    blockHeight: BLOCK_HEIGHT,
    signatures: [OTHER_SIGNATURE, TX_SIGNATURE, THIRD_SIGNATURE],
    ...patch,
  }
}

function defaultResult(request: RpcRequest): unknown {
  if (request.method === 'getTransaction') return successfulTransaction()
  if (request.method === 'getSignatureStatuses') return successfulStatus()
  if (request.method === 'getBlock') return successfulBlock()
  throw new Error(`unexpected test RPC method: ${request.method}`)
}

function successfulResponseBody(request: RpcRequest): string {
  return `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: defaultResult(request),
    providerNote: '链上原始字段',
  })}\n`
}

function byteStream(body: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(body)
  const split = Math.max(1, bytes.byteLength - 2)
  const chunks = [bytes.slice(0, split), bytes.slice(split)]
  return {
    getReader: () => {
      let index = 0
      return {
        read: jest.fn(async () =>
          index < chunks.length
            ? { done: false, value: chunks[index++] }
            : { done: true, value: undefined }
        ),
        cancel: jest.fn(async () => undefined),
      }
    },
  } as never
}

function mockRpc(handler: (request: RpcRequest) => RpcReply = () => ({})): RpcCall[] {
  const calls: RpcCall[] = []
  global.fetch = jest.fn(async (input, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest
    const requestInit = init ?? {}
    calls.push({ url: String(input), request, init: requestInit })
    const reply = handler(request)
    if (reply.error) throw reply.error
    const payload =
      reply.payload === undefined
        ? { jsonrpc: '2.0', id: 1, result: defaultResult(request) }
        : reply.payload
    return {
      status: reply.status ?? 200,
      headers: { get: () => null },
      body: reply.stream,
      text: async () => reply.body ?? JSON.stringify(payload),
    } as Response
  }) as jest.MockedFunction<typeof fetch>
  return calls
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

async function capture() {
  return fetchSolanaTransactionMembershipEvidence(TX_SIGNATURE, anchorFixture(), {
    rpcUrl: TEST_RPC_URL,
    endpointId: TEST_ENDPOINT_ID,
  })
}

function lowerSlotEvidence<T>(value: T): T {
  const evidence = clone(value) as any
  const slot = SLOT - 10
  evidence.transaction.value.slot = slot
  evidence.signatureStatus.value.slot = slot
  evidence.canonicalBlock.value = {
    slot,
    blockhash: LOWER_BLOCK_HASH,
    previousBlockhash: LOWER_PREVIOUS_BLOCK_HASH,
    parentSlot: slot - 1,
    blockTime: BLOCK_TIME - 4,
    blockHeight: BLOCK_HEIGHT - 10,
    signatures: [OTHER_SIGNATURE, TX_SIGNATURE, THIRD_SIGNATURE],
  }
  evidence.transaction.value.blockTime = BLOCK_TIME - 4
  return evidence as T
}

describe('Solana transaction finality evidence', () => {
  const originalFetch = global.fetch
  const originalHeliusKey = process.env.HELIUS_API_KEY
  const originalAlchemyKey = process.env.ALCHEMY_API_KEY

  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(FIXED_NOW))
    delete process.env.HELIUS_API_KEY
    delete process.env.ALCHEMY_API_KEY
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
    if (originalFetch) global.fetch = originalFetch
    else delete (global as typeof global & { fetch?: typeof fetch }).fetch
    if (originalHeliusKey === undefined) delete process.env.HELIUS_API_KEY
    else process.env.HELIUS_API_KEY = originalHeliusKey
    if (originalAlchemyKey === undefined) delete process.env.ALCHEMY_API_KEY
    else process.env.ALCHEMY_API_KEY = originalAlchemyKey
  })

  it('binds transaction, finalized status, and unique block position to one verified anchor', async () => {
    const calls = mockRpc()
    const evidence = await capture()

    expect(calls.map(({ request }) => request)).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [
          TX_SIGNATURE,
          { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 },
        ],
      },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignatureStatuses',
        params: [[TX_SIGNATURE], { searchTransactionHistory: true }],
      },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getBlock',
        params: [
          SLOT,
          {
            commitment: 'finalized',
            encoding: 'json',
            transactionDetails: 'signatures',
            rewards: false,
          },
        ],
      },
    ])
    expect(
      calls.every(
        ({ url, init }) =>
          url === TEST_RPC_URL &&
          init.method === 'POST' &&
          init.redirect === 'error' &&
          (init.headers as Record<string, string>)['content-type'] === 'application/json'
      )
    ).toBe(true)
    expect(evidence).toMatchObject({
      chain: { cluster: 'mainnet-beta', genesisHash: SOLANA_MAINNET_GENESIS_HASH },
      signature: TX_SIGNATURE,
      capturedAt: FIXED_NOW,
      membershipPolicy: {
        version: 'solana_transaction_membership_v1',
        blockMaxSupportedTransactionVersion: null,
      },
      anchor: {
        verifiedAnchorHashPolicy: 'solana_verified_anchor_semantics_v1',
        verifiedAnchorHash: '523c6e14d8e1f3f0cd70cb493fb3594d98630bb3f8ad7c38612ea10aae190315',
      },
      transaction: {
        status: 'available',
        value: {
          slot: SLOT,
          blockTime: BLOCK_TIME,
          version: 0,
          signatures: [TX_SIGNATURE],
          reportedTransactionIndex: 1,
          err: null,
          status: { Ok: null },
        },
      },
      signatureStatus: {
        status: 'available',
        value: { contextSlot: SLOT + 5, slot: SLOT, confirmationStatus: 'finalized' },
      },
      canonicalBlock: {
        status: 'available',
        value: { slot: SLOT, signatures: [OTHER_SIGNATURE, TX_SIGNATURE, THIRD_SIGNATURE] },
      },
    })
    const verified = requireSolanaVerifiedTransactionFinality(clone(evidence), anchorFixture())
    expect(verified).toMatchObject({
      signature: TX_SIGNATURE,
      transactionIndex: 1,
      executionStatus: 'succeeded',
      candidateHitEligible: true,
      semanticHashPolicy: 'solana_verified_transaction_finality_semantics_v1',
    })
    expect(verified.semanticHash).toBe(
      'e62f4323b1678355b2c388b0e89f507e2b4a734d19fcd17a66b7b6b61bd2241f'
    )
    expect(JSON.stringify(evidence)).not.toContain(TEST_RPC_ORIGIN)
    expect(JSON.stringify(evidence)).not.toContain('provider-only detail')
  })

  it('captures exact transaction transport bytes while keeping normalized evidence minimal', async () => {
    const calls = mockRpc((request) => ({
      stream: byteStream(successfulResponseBody(request)),
    }))
    const captured = await captureSolanaVerifiedTransactionFinalityEvidence(
      TX_SIGNATURE,
      anchorFixture(),
      {
        rpcUrl: TEST_RPC_URL,
        endpointId: TEST_ENDPOINT_ID,
      }
    )

    expect(captured.verified).toMatchObject({
      transactionIndex: 1,
      executionStatus: 'succeeded',
      candidateHitEligible: true,
    })
    expect(captured.rawExchanges.map(({ lane }) => lane)).toEqual([
      'transaction',
      'signature_status',
      'membership_block',
    ])
    expect(captured.rawExchanges).toHaveLength(calls.length)
    const expectedMethods = ['getTransaction', 'getSignatureStatuses', 'getBlock']
    for (const [index, exchange] of captured.rawExchanges.entries()) {
      const requestBody = String(calls[index].init.body)
      const responseBody = successfulResponseBody(calls[index].request)
      const requestBytes = Buffer.from(exchange.request.bytes)
      const responseBytes = Buffer.from(exchange.response.bytes)
      expect(requestBytes.toString('utf8')).toBe(requestBody)
      expect(responseBytes.toString('utf8')).toBe(responseBody)
      expect(exchange.request.sha256).toBe(createHash('sha256').update(requestBytes).digest('hex'))
      expect(exchange.response.sha256).toBe(
        createHash('sha256').update(responseBytes).digest('hex')
      )
      expect(exchange.method).toBe(expectedMethods[index])
      expect(exchange.httpStatus).toBe(200)
      expect(exchange.completedAt).toBe(FIXED_NOW)
      expect(exchange.endpoint).toEqual({
        providerId: 'local',
        endpointId: TEST_ENDPOINT_ID,
        connectionHash: TEST_CONNECTION_HASH,
      })
      expect(exchange).not.toHaveProperty('url')
    }
    expect(JSON.stringify(captured.evidence)).not.toContain('provider-only detail')
    expect(JSON.stringify(captured.evidence)).not.toContain('providerNote')
    const rawTransaction = Buffer.from(captured.rawExchanges[0].response.bytes).toString('utf8')
    expect(rawTransaction).toContain('provider-only detail')
    expect(rawTransaction).toContain('"providerOnly":true')
    expect(rawTransaction).toContain('链上原始字段')
  })

  it('fails exact transaction capture closed for text-only transport mocks', async () => {
    const calls = mockRpc()
    await expect(
      captureSolanaVerifiedTransactionFinalityEvidence(TX_SIGNATURE, anchorFixture(), {
        rpcUrl: TEST_RPC_URL,
        endpointId: TEST_ENDPOINT_ID,
      })
    ).rejects.toThrow('Solana transaction finality evidence is not fully verified')
    expect(calls).toHaveLength(1)

    const evidence = await capture()
    expect(
      requireSolanaVerifiedTransactionFinality(evidence, anchorFixture()).transactionIndex
    ).toBe(1)
    expect(evidence).not.toHaveProperty('rawExchanges')
  })

  it('returns no partial raw capture when a dependent transaction lane fails', async () => {
    const secret = 'private-api-key'
    const calls = mockRpc((request) => ({
      stream: byteStream(
        request.method === 'getSignatureStatuses'
          ? JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              error: { code: -32_601, message: `method unavailable at ${secret}` },
            })
          : successfulResponseBody(request)
      ),
    }))
    let error: unknown
    try {
      await captureSolanaVerifiedTransactionFinalityEvidence(TX_SIGNATURE, anchorFixture(), {
        rpcUrl: TEST_RPC_URL,
        endpointId: TEST_ENDPOINT_ID,
      })
    } catch (caught) {
      error = caught
    }
    expect(calls).toHaveLength(3)
    expect(String(error)).toBe(
      'TypeError: Solana transaction finality evidence is not fully verified'
    )
    expect(String(error)).not.toContain(secret)
  })

  it.each([
    ['null result', { jsonrpc: '2.0', id: 1, result: null }, 'not_found_or_unavailable'],
    [
      'history unavailable',
      { jsonrpc: '2.0', id: 1, error: { code: -32_011, message: 'history missing' } },
      'not_found_or_unavailable',
    ],
    [
      'unsupported RPC version',
      { jsonrpc: '2.0', id: 1, error: { code: -32_015, message: 'unsupported version' } },
      'unsupported_transaction_version',
    ],
    [
      'metadata unavailable',
      { jsonrpc: '2.0', id: 1, result: successfulTransaction({ meta: null }) },
      'metadata_unavailable',
    ],
    [
      'future transaction version',
      { jsonrpc: '2.0', id: 1, result: successfulTransaction({ version: 1 }) },
      'unsupported_transaction_version',
    ],
  ])(
    'keeps %s explicit and does not fabricate dependent proof',
    async (_label, payload, reason) => {
      const calls = mockRpc(() => ({ payload }))
      const evidence = await capture()
      expect(calls).toHaveLength(1)
      expect(evidence.transaction).toMatchObject({ status: 'unavailable', reason })
      expect(evidence.signatureStatus).toMatchObject({
        status: 'unavailable',
        reason: 'dependency_unavailable',
      })
      expect(evidence.canonicalBlock).toMatchObject({
        status: 'unavailable',
        reason: 'dependency_unavailable',
      })
      expect(() => requireSolanaVerifiedTransactionFinality(evidence, anchorFixture())).toThrow(
        'Solana transaction finality evidence is not fully verified'
      )
    }
  )

  it('retains finalized failed transactions but never marks them candidate-hit eligible', async () => {
    const txError = { InstructionError: [2, { BorshIoError: 'private-tx-error' }] }
    const statusError = { InstructionError: [2, { BorshIoError: 'private-status-error' }] }
    mockRpc((request) => {
      const result =
        request.method === 'getTransaction'
          ? successfulTransaction({}, txError, { Err: txError })
          : request.method === 'getSignatureStatuses'
            ? successfulStatus({}, statusError, { Err: statusError })
            : successfulBlock()
      return { payload: { jsonrpc: '2.0', id: 1, result } }
    })
    const evidence = await capture()
    expect(evidence.transaction).toMatchObject({
      status: 'available',
      value: {
        err: { InstructionError: [2, 'BorshIoError'] },
        status: { Err: { InstructionError: [2, 'BorshIoError'] } },
      },
    })
    const verified = requireSolanaVerifiedTransactionFinality(evidence, anchorFixture())
    expect(verified.executionStatus).toBe('failed')
    expect(verified.candidateHitEligible).toBe(false)
    expect(JSON.stringify(evidence)).not.toContain('private-tx-error')
    expect(JSON.stringify(evidence)).not.toContain('private-status-error')
  })

  it.each([
    ['status missing', null],
    ['context behind row', successfulStatus({}, null, { Ok: null })],
    ['not finalized', successfulStatus({ confirmationStatus: 'confirmed' }, null, { Ok: null })],
    ['still confirming', successfulStatus({ confirmations: 0 }, null, { Ok: null })],
    ['status contradiction', successfulStatus({}, null, { Err: 'AccountInUse' })],
  ])('rejects malformed signature-status evidence: %s', async (label, rawStatus) => {
    if (label === 'context behind row' && rawStatus && typeof rawStatus === 'object') {
      ;(rawStatus as any).context.slot = SLOT - 1
    }
    mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result:
          request.method === 'getTransaction'
            ? successfulTransaction()
            : request.method === 'getSignatureStatuses'
              ? rawStatus === null
                ? { context: { apiVersion: '4.0.0', slot: SLOT }, value: [null] }
                : rawStatus
              : successfulBlock(),
      },
    }))
    const evidence = await capture()
    expect(evidence.signatureStatus).toMatchObject({ status: 'unavailable' })
    expect(() => requireSolanaVerifiedTransactionFinality(evidence, anchorFixture())).toThrow()
  })

  it.each([-32_001, -32_004, -32_007, -32_009, -32_011, -32_014, -32_019])(
    'maps getBlock provider gap code %s without treating it as an empty block',
    async (code) => {
      mockRpc((request) => ({
        payload:
          request.method === 'getBlock'
            ? { jsonrpc: '2.0', id: 1, error: { code, message: 'provider gap' } }
            : { jsonrpc: '2.0', id: 1, result: defaultResult(request) },
      }))
      const evidence = await capture()
      expect(evidence.canonicalBlock).toMatchObject({
        status: 'unavailable',
        reason: 'not_found_or_unavailable',
        rpcCode: code,
      })
    }
  )

  it.each([
    ['transactions projection', { transactions: [] }],
    ['rewards projection', { rewards: [] }],
    ['duplicate target', { signatures: [TX_SIGNATURE, TX_SIGNATURE] }],
    ['duplicate other', { signatures: [OTHER_SIGNATURE, TX_SIGNATURE, OTHER_SIGNATURE] }],
  ])('rejects malformed block signature projection: %s', async (_label, patch) => {
    mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result: request.method === 'getBlock' ? successfulBlock(patch) : defaultResult(request),
      },
    }))
    const evidence = await capture()
    expect(evidence.canonicalBlock).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_response',
    })
  })

  it('rejects textual negative zero before JSON serialization can erase its sign', async () => {
    const blockBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: successfulBlock({ numRewardPartitions: 0 }),
    }).replace('"numRewardPartitions":0', '"numRewardPartitions":-0')
    mockRpc((request) =>
      request.method === 'getBlock'
        ? { body: blockBody }
        : { payload: { jsonrpc: '2.0', id: 1, result: defaultResult(request) } }
    )
    const evidence = await capture()
    expect(evidence.canonicalBlock).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_response',
    })
  })

  it('requires unique membership and agreement with optional Agave transactionIndex', async () => {
    mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result:
          request.method === 'getBlock'
            ? successfulBlock({ signatures: [OTHER_SIGNATURE, THIRD_SIGNATURE] })
            : defaultResult(request),
      },
    }))
    const missing = await capture()
    expect(missing.canonicalBlock).toMatchObject({ status: 'available' })
    expect(() => requireSolanaVerifiedTransactionFinality(missing, anchorFixture())).toThrow()

    mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result:
          request.method === 'getTransaction'
            ? successfulTransaction({ transactionIndex: 0 })
            : defaultResult(request),
      },
    }))
    const wrongIndex = await capture()
    expect(() => requireSolanaVerifiedTransactionFinality(wrongIndex, anchorFixture())).toThrow()

    const withoutReported = successfulTransaction()
    delete (withoutReported as any).transactionIndex
    mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result: request.method === 'getTransaction' ? withoutReported : defaultResult(request),
      },
    }))
    const legacyProvider = await capture()
    expect(
      requireSolanaVerifiedTransactionFinality(legacyProvider, anchorFixture()).transaction
        .reportedTransactionIndex
    ).toBeNull()
  })

  it('strictly reparses serialized evidence and rejects semantic drift', async () => {
    mockRpc()
    const evidence = await capture()
    const mutations: Array<(value: any) => void> = [
      (value) => {
        value.extra = true
      },
      (value) => {
        value.membershipPolicy.commitment = 'confirmed'
      },
      (value) => {
        value.anchor.verifiedAnchorHash = '0'.repeat(64)
      },
      (value) => {
        value.transaction.value.extra = true
      },
      (value) => {
        value.transaction.value.slot -= 1
      },
      (value) => {
        value.signatureStatus.value.contextSlot = SLOT - 1
      },
      (value) => {
        value.signatureStatus.value.err = 'AccountInUse'
        value.signatureStatus.value.status = { Err: 'AccountInUse' }
      },
      (value) => {
        value.canonicalBlock.value.blockhash = LOWER_BLOCK_HASH
      },
      (value) => {
        value.canonicalBlock.value.signatures.splice(1, 1)
      },
      (value) => {
        value.transaction.value.reportedTransactionIndex = 0
      },
      (value) => {
        value.transaction.value.version = -0
      },
      (value) => {
        value.transaction.httpStatus = null
      },
      (value) => {
        value.canonicalBlock.provider.attempted.push(
          clone(value.canonicalBlock.provider.attempted[0])
        )
      },
      (value) => {
        value.transaction.provider.servedBy.connectionHash = '0'.repeat(64)
        value.transaction.provider.attempted[0].connectionHash = '0'.repeat(64)
      },
      (value) => {
        value.capturedAt = '2026-07-16T21:00:41Z'
      },
      (value) => {
        Object.defineProperty(value, Symbol('secret'), { value: true })
      },
      (value) => {
        delete value.canonicalBlock.value.signatures[0]
      },
    ]
    for (const mutate of mutations) {
      const attacked = clone(evidence) as any
      mutate(attacked)
      expect(() => requireSolanaVerifiedTransactionFinality(attacked, anchorFixture())).toThrow(
        'Solana transaction finality evidence is not fully verified'
      )
    }

    const accessor = clone(evidence) as any
    Object.defineProperty(accessor.transaction, 'value', {
      enumerable: true,
      get: () => clone((evidence.transaction as any).value),
    })
    expect(() => requireSolanaVerifiedTransactionFinality(accessor, anchorFixture())).toThrow()
  })

  it('accepts a consistent lower finalized slot and rejects anchor-hash reuse', async () => {
    mockRpc()
    const evidence = lowerSlotEvidence(await capture()) as any
    const verified = requireSolanaVerifiedTransactionFinality(evidence, anchorFixture())
    expect(verified.canonicalBlock.slot).toBe(SLOT - 10)

    evidence.canonicalBlock.value.blockhash = BLOCK_HASH
    expect(() => requireSolanaVerifiedTransactionFinality(evidence, anchorFixture())).toThrow()
  })

  it('enforces canonical capture and future-time boundaries without Date.now at verification', async () => {
    mockRpc()
    const base = lowerSlotEvidence(await capture()) as any
    const capturedSeconds = Date.parse(FIXED_NOW) / 1000
    base.transaction.value.blockTime = capturedSeconds + 60
    base.canonicalBlock.value.blockTime = capturedSeconds + 60
    expect(requireSolanaVerifiedTransactionFinality(base, anchorFixture()).capturedAt).toBe(
      FIXED_NOW
    )

    const future = clone(base) as any
    future.transaction.value.blockTime = capturedSeconds + 61
    future.canonicalBlock.value.blockTime = capturedSeconds + 61
    expect(() => requireSolanaVerifiedTransactionFinality(future, anchorFixture())).toThrow()

    const unrepresentableMilliseconds = clone(base) as any
    unrepresentableMilliseconds.transaction.value.blockTime = Number.MAX_SAFE_INTEGER
    unrepresentableMilliseconds.canonicalBlock.value.blockTime = Number.MAX_SAFE_INTEGER
    expect(() =>
      requireSolanaVerifiedTransactionFinality(unrepresentableMilliseconds, anchorFixture())
    ).toThrow()

    const early = clone(base) as any
    early.capturedAt = new Date(Date.parse(FIXED_NOW) - 60_001).toISOString()
    expect(() => requireSolanaVerifiedTransactionFinality(early, anchorFixture())).toThrow()

    jest.setSystemTime(new Date('2036-01-01T00:00:00.000Z'))
    expect(requireSolanaVerifiedTransactionFinality(base, anchorFixture()).capturedAt).toBe(
      FIXED_NOW
    )
  })

  it('keeps semantic hashing independent of property order and HTTP success status', async () => {
    mockRpc()
    const evidence = await capture()
    const expected = requireSolanaVerifiedTransactionFinality(evidence, anchorFixture())
    const source = clone(evidence) as any
    const reordered = {
      canonicalBlock: source.canonicalBlock,
      signatureStatus: source.signatureStatus,
      transaction: source.transaction,
      anchor: source.anchor,
      membershipPolicy: source.membershipPolicy,
      capturedAt: source.capturedAt,
      signature: source.signature,
      chain: source.chain,
    }
    reordered.transaction.httpStatus = 204
    reordered.signatureStatus.httpStatus = 204
    reordered.canonicalBlock.httpStatus = 204
    expect(requireSolanaVerifiedTransactionFinality(reordered, anchorFixture()).semanticHash).toBe(
      expected.semanticHash
    )

    const changed = clone(evidence) as any
    changed.transaction.value.version = 'legacy'
    expect(
      requireSolanaVerifiedTransactionFinality(changed, anchorFixture()).semanticHash
    ).not.toBe(expected.semanticHash)
  })

  it.each([
    'AccountInUse',
    'ProgramCacheHitMaxLimit',
    'CommitCancelled',
    { DuplicateInstruction: 255 },
    { InstructionError: [255, { Custom: 4_294_967_295 }] },
    { InsufficientFundsForRent: { account_index: 0 } },
    { ProgramExecutionTemporarilyRestricted: { account_index: 255 } },
  ] as SolanaCanonicalTransactionError[])('accepts canonical failed error %j', async (error) => {
    mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result:
          request.method === 'getTransaction'
            ? successfulTransaction({}, error, { Err: error })
            : request.method === 'getSignatureStatuses'
              ? successfulStatus({}, error, { Err: error })
              : successfulBlock(),
      },
    }))
    const verified = requireSolanaVerifiedTransactionFinality(await capture(), anchorFixture())
    expect(verified.executionStatus).toBe('failed')
    expect(verified.candidateHitEligible).toBe(false)
  })

  it.each([
    ['unknown future error', 'FutureTransactionError'],
    ['u8 overflow', { DuplicateInstruction: 256 }],
    ['u32 overflow', { InstructionError: [0, { Custom: 4_294_967_296 }] }],
    ['wrong account key casing', { InsufficientFundsForRent: { accountIndex: 0 } }],
    ['unknown instruction error', { InstructionError: [0, 'FutureInstructionError'] }],
    ['extra structured key', { DuplicateInstruction: 0, extra: true }],
  ])('fails closed on non-canonical transaction error: %s', async (_label, error) => {
    const calls = mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result:
          request.method === 'getTransaction'
            ? successfulTransaction({}, error, { Err: error })
            : defaultResult(request),
      },
    }))
    const evidence = await capture()
    expect(calls).toHaveLength(1)
    expect(evidence.transaction).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_response',
    })
  })

  it('rejects invalid inputs and endpoint drift before making any request', async () => {
    const calls = mockRpc()
    await expect(
      fetchSolanaTransactionMembershipEvidence('not-a-signature', anchorFixture(), {
        rpcUrl: TEST_RPC_URL,
        endpointId: TEST_ENDPOINT_ID,
      })
    ).rejects.toThrow('signature must be a base58-encoded 64-byte signature')

    const badAnchor = clone(anchorFixture()) as any
    badAnchor.finalizedBlock.value.slot -= 1
    await expect(
      fetchSolanaTransactionMembershipEvidence(TX_SIGNATURE, badAnchor, {
        rpcUrl: TEST_RPC_URL,
        endpointId: TEST_ENDPOINT_ID,
      })
    ).rejects.toThrow('Solana chain anchor is not fully verified')

    await expect(
      fetchSolanaTransactionMembershipEvidence(TX_SIGNATURE, anchorFixture(), {
        rpcUrl: 'http://127.0.0.1:9999/',
        endpointId: TEST_ENDPOINT_ID,
      })
    ).rejects.toThrow('Solana transaction membership endpoint does not match anchor')
    expect(calls).toHaveLength(0)
  })

  it('uses the fully reconstructed verified anchor rather than trusting its embedded hash', () => {
    const anchor = requireSolanaVerifiedChainAnchor(anchorFixture())
    expect(anchor.semanticHash).toBe(
      '523c6e14d8e1f3f0cd70cb493fb3594d98630bb3f8ad7c38612ea10aae190315'
    )
  })
})
