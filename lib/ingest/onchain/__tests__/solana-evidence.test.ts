import { createHash } from 'node:crypto'

import {
  SOLANA_MAINNET_GENESIS_HASH,
  fetchSolanaChainAnchorEvidence,
  requireSolanaVerifiedChainAnchor,
} from '../solana-evidence'

interface RpcRequest {
  jsonrpc: string
  id: number
  method: string
  params: unknown[]
}

interface MockReply {
  payload?: unknown
  body?: string
  status?: number
  error?: Error
  contentLength?: string
  cancel?: jest.Mock<Promise<void>, []>
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
const TEST_RPC_ORIGIN = 'http://127.0.0.1:8899'
const TEST_RPC_URL = `${TEST_RPC_ORIGIN}/`
const TEST_ENDPOINT_ID = 'local_solana_node' as const
const TEST_CONNECTION_HASH = createHash('sha256')
  .update(
    JSON.stringify(['solana_evidence_connection_v1', 'local', TEST_ENDPOINT_ID, TEST_RPC_ORIGIN])
  )
  .digest('hex')
const FIXED_NOW = '2026-07-16T21:00:41.000Z'

function finalizedBlock(overrides: Record<string, unknown> = {}) {
  return {
    blockhash: BLOCK_HASH,
    previousBlockhash: PREVIOUS_BLOCK_HASH,
    parentSlot: SLOT - 1,
    blockTime: BLOCK_TIME,
    blockHeight: BLOCK_HEIGHT,
    ...overrides,
  }
}

function successfulResult(request: RpcRequest): unknown {
  if (request.method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS_HASH
  if (request.method === 'getSlot') return SLOT
  return finalizedBlock()
}

function mockRpc(
  handler: (request: RpcRequest, url: string, init: RequestInit) => MockReply
): RpcCall[] {
  const calls: RpcCall[] = []
  global.fetch = jest.fn(async (input, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest
    const url = String(input)
    const requestInit = init ?? {}
    calls.push({ url, request, init: requestInit })
    const reply = handler(request, url, requestInit)
    if (reply.error) throw reply.error
    const payload =
      reply.payload === undefined
        ? { jsonrpc: '2.0', id: 1, result: successfulResult(request) }
        : reply.payload
    return {
      status: reply.status ?? 200,
      headers: { get: () => reply.contentLength ?? null },
      body: reply.stream ?? (reply.cancel ? { cancel: reply.cancel } : undefined),
      text: async () => reply.body ?? JSON.stringify(payload),
    } as Response
  }) as jest.MockedFunction<typeof fetch>
  return calls
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

describe('fetchSolanaChainAnchorEvidence', () => {
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

  it('binds exact mainnet identity, finalized slot, and block requests to one endpoint', async () => {
    const calls = mockRpc(() => ({}))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })

    expect(calls.map((call) => call.request)).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getSlot',
        params: [{ commitment: 'finalized' }],
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
            transactionDetails: 'none',
            maxSupportedTransactionVersion: 0,
            rewards: false,
          },
        ],
      },
    ])
    expect(
      calls.every(
        ({ init }) =>
          init.method === 'POST' &&
          init.redirect === 'error' &&
          (init.headers as Record<string, string>)['content-type'] === 'application/json'
      )
    ).toBe(true)
    expect(anchor).toMatchObject({
      chain: { cluster: 'mainnet-beta', genesisHash: SOLANA_MAINNET_GENESIS_HASH },
      observedAt: FIXED_NOW,
      anchorPolicy: {
        version: 'solana_current_finalized_block_v1',
        commitment: 'finalized',
        transactionDetails: 'none',
        maxFutureBlockSkewMs: 60_000,
        maxCurrentAnchorLagMs: 900_000,
      },
      genesisHash: { status: 'available', value: SOLANA_MAINNET_GENESIS_HASH },
      finalizedSlot: { status: 'available', value: SLOT },
      finalizedBlock: {
        status: 'available',
        value: { slot: SLOT, ...finalizedBlock() },
      },
    })
    for (const lane of [anchor.genesisHash, anchor.finalizedSlot, anchor.finalizedBlock]) {
      expect(lane).toMatchObject({
        provider: {
          servedBy: {
            providerId: 'local',
            endpointId: TEST_ENDPOINT_ID,
            connectionHash: TEST_CONNECTION_HASH,
          },
          attempted: [
            {
              providerId: 'local',
              endpointId: TEST_ENDPOINT_ID,
              connectionHash: TEST_CONNECTION_HASH,
            },
          ],
        },
        httpStatus: 200,
      })
    }
    const verified = requireSolanaVerifiedChainAnchor(clone(anchor))
    expect(verified).toMatchObject({
      finalizedSlot: SLOT,
      finalizedBlock: { slot: SLOT, blockhash: BLOCK_HASH },
      semanticHashPolicy: 'solana_verified_anchor_semantics_v1',
      semanticHash: '523c6e14d8e1f3f0cd70cb493fb3594d98630bb3f8ad7c38612ea10aae190315',
    })
    expect(JSON.stringify(anchor)).not.toContain(TEST_RPC_ORIGIN)
    expect(JSON.stringify(anchor)).not.toContain('private-api-key')
  })

  it('strictly reparses serialized evidence before granting verified status', async () => {
    mockRpc(() => ({}))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(requireSolanaVerifiedChainAnchor(clone(anchor)).observedAt).toBe(FIXED_NOW)

    const attacks: Array<(value: any) => void> = [
      (value) => {
        value.secret = 'private-api-key'
      },
      (value) => {
        value.finalizedBlock.value.secret = true
      },
      (value) => {
        value.chain.cluster = 'devnet'
      },
      (value) => {
        value.anchorPolicy.commitment = 'confirmed'
      },
      (value) => {
        value.anchorPolicy.maxCurrentAnchorLagMs = 900_001
      },
      (value) => {
        value.observedAt = '2026-07-16T21:00:41Z'
      },
      (value) => {
        value.genesisHash.value = BLOCK_HASH
      },
      (value) => {
        value.finalizedSlot.value = 0
      },
      (value) => {
        value.finalizedBlock.value.slot -= 1
      },
      (value) => {
        value.finalizedBlock.httpStatus = null
      },
      (value) => {
        value.finalizedBlock.provider.servedBy.connectionHash = '0'.repeat(64)
        value.finalizedBlock.provider.attempted[0].connectionHash = '0'.repeat(64)
      },
      (value) => {
        value.finalizedBlock.provider.attempted.push(
          clone(value.finalizedBlock.provider.attempted[0])
        )
      },
      (value) => {
        value.finalizedBlock.provider.servedBy.providerId = 'helius'
      },
      (value) => {
        Object.defineProperty(value, Symbol('secret'), { value: true })
      },
      (value) => {
        delete value.finalizedBlock.provider.attempted[0]
      },
      (value) => {
        Object.setPrototypeOf(value.finalizedBlock.provider.attempted, {})
      },
    ]
    for (const mutate of attacks) {
      const attacked = clone(anchor)
      mutate(attacked)
      expect(() => requireSolanaVerifiedChainAnchor(attacked)).toThrow(
        'Solana chain anchor is not fully verified'
      )
    }

    const accessor = clone(anchor) as any
    Object.defineProperty(accessor.finalizedBlock, 'value', {
      enumerable: true,
      get: () => ({ slot: SLOT, ...finalizedBlock() }),
    })
    expect(() => requireSolanaVerifiedChainAnchor(accessor)).toThrow(
      'Solana chain anchor is not fully verified'
    )
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('private-api-key')
        },
      }
    )
    expect(() => requireSolanaVerifiedChainAnchor(proxy)).toThrow(
      'Solana chain anchor is not fully verified'
    )
  })

  it.each([
    ['version', 'solana_current_finalized_block_v2'],
    ['genesisMethod', 'getBlock'],
    ['slotMethod', 'getBlockHeight'],
    ['blockMethod', 'getBlocks'],
    ['commitment', 'confirmed'],
    ['encoding', 'base64'],
    ['transactionDetails', 'signatures'],
    ['maxSupportedTransactionVersion', 1],
    ['rewards', true],
    ['maxFutureBlockSkewMs', 60_001],
    ['maxCurrentAnchorLagMs', 900_001],
  ])('rejects anchor policy drift in %s', async (key, value) => {
    mockRpc(() => ({}))
    const anchor = (await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })) as any
    anchor.anchorPolicy[key] = value
    expect(() => requireSolanaVerifiedChainAnchor(anchor)).toThrow(
      'Solana chain anchor is not fully verified'
    )
  })

  it('keeps semantic hashing independent of property order and HTTP success status', async () => {
    mockRpc(() => ({ status: 204 }))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    const expected = requireSolanaVerifiedChainAnchor(anchor)
    const source = clone(anchor) as any
    const reordered = {
      finalizedBlock: source.finalizedBlock,
      anchorPolicy: source.anchorPolicy,
      chain: source.chain,
      finalizedSlot: source.finalizedSlot,
      observedAt: source.observedAt,
      genesisHash: source.genesisHash,
    }
    expect(requireSolanaVerifiedChainAnchor(reordered).semanticHash).toBe(expected.semanticHash)

    const nullableHeight = clone(anchor) as any
    nullableHeight.finalizedBlock.value.blockHeight = null
    expect(requireSolanaVerifiedChainAnchor(nullableHeight).semanticHash).not.toBe(
      expected.semanticHash
    )
  })

  it('rejects a forged connection hash for a statically approved remote endpoint', async () => {
    mockRpc(() => ({}))
    const anchor = (await fetchSolanaChainAnchorEvidence({
      rpcUrl: 'https://api.mainnet-beta.solana.com/',
      endpointId: 'solana_official_mainnet',
    })) as any
    for (const lane of [anchor.genesisHash, anchor.finalizedSlot, anchor.finalizedBlock]) {
      lane.provider.servedBy.connectionHash = '0'.repeat(64)
      lane.provider.attempted[0].connectionHash = '0'.repeat(64)
    }
    expect(() => requireSolanaVerifiedChainAnchor(anchor)).toThrow(
      'Solana chain anchor is not fully verified'
    )
  })

  it('enforces capture-time freshness while allowing nullable block height', async () => {
    mockRpc(() => ({}))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    const observedAtSeconds = Date.parse(FIXED_NOW) / 1000

    const acceptedTimes = [observedAtSeconds + 60, observedAtSeconds - 900]
    for (const blockTime of acceptedTimes) {
      const value = clone(anchor) as any
      value.finalizedBlock.value.blockTime = blockTime
      expect(requireSolanaVerifiedChainAnchor(value).finalizedBlock.blockTime).toBe(blockTime)
    }
    const nullableHeight = clone(anchor) as any
    nullableHeight.finalizedBlock.value.blockHeight = null
    expect(requireSolanaVerifiedChainAnchor(nullableHeight).finalizedBlock.blockHeight).toBeNull()

    for (const blockTime of [
      observedAtSeconds + 61,
      observedAtSeconds - 901,
      Number.MAX_SAFE_INTEGER,
      null,
    ]) {
      const value = clone(anchor) as any
      value.finalizedBlock.value.blockTime = blockTime
      expect(() => requireSolanaVerifiedChainAnchor(value)).toThrow(
        'Solana chain anchor is not fully verified'
      )
    }
    const impossibleHeight = clone(anchor) as any
    impossibleHeight.finalizedBlock.value.blockHeight = SLOT + 1
    expect(() => requireSolanaVerifiedChainAnchor(impossibleHeight)).toThrow(
      'Solana chain anchor is not fully verified'
    )

    for (const field of ['parentSlot', 'blockHeight']) {
      const negativeZero = clone(anchor) as any
      negativeZero.finalizedBlock.value[field] = -0
      expect(() => requireSolanaVerifiedChainAnchor(negativeZero)).toThrow(
        'Solana chain anchor is not fully verified'
      )
    }
  })

  it('revalidates capture-time freshness deterministically without consulting Date.now', async () => {
    mockRpc(() => ({}))
    const anchor = (await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })) as any
    anchor.observedAt = '2025-07-16T21:00:41.000Z'
    anchor.finalizedBlock.value.blockTime = Date.parse('2025-07-16T21:00:22.000Z') / 1000

    expect(requireSolanaVerifiedChainAnchor(anchor).observedAt).toBe('2025-07-16T21:00:41.000Z')
  })

  it('keeps configuration failures explicit and makes no request', async () => {
    const calls = mockRpc(() => ({}))
    const anchor = await fetchSolanaChainAnchorEvidence({ rpcUrl: TEST_RPC_URL })
    expect(calls).toHaveLength(0)
    for (const lane of [anchor.genesisHash, anchor.finalizedSlot, anchor.finalizedBlock]) {
      expect(lane).toEqual({
        status: 'unavailable',
        reason: 'provider_unconfigured',
        provider: { servedBy: null, attempted: [] },
        rpcCode: null,
        httpStatus: null,
      })
    }
  })

  it('does not choose a provider when neither approved default is configured', async () => {
    const calls = mockRpc(() => ({}))
    const anchor = await fetchSolanaChainAnchorEvidence()
    expect(calls).toHaveLength(0)
    expect(anchor.genesisHash).toMatchObject({
      status: 'unavailable',
      reason: 'provider_unconfigured',
    })
  })

  it.each([
    { rpcUrl: TEST_RPC_URL, endpointId: 'unknown_endpoint' },
    { rpcUrl: TEST_RPC_URL, endpointId: 42 },
    { endpointId: TEST_ENDPOINT_ID },
  ])('rejects invalid endpoint options %#', async (opts) => {
    const calls = mockRpc(() => ({}))
    await expect(fetchSolanaChainAnchorEvidence(opts as never)).rejects.toThrow(
      'invalid Solana evidence options'
    )
    expect(calls).toHaveLength(0)
  })

  it('rejects accessors, exotic objects, symbols, and unknown option fields', async () => {
    const calls = mockRpc(() => ({}))
    const accessor = { endpointId: TEST_ENDPOINT_ID }
    Object.defineProperty(accessor, 'rpcUrl', {
      enumerable: true,
      get: () => TEST_RPC_URL,
    })
    const withSymbol = { rpcUrl: TEST_RPC_URL, endpointId: TEST_ENDPOINT_ID }
    Object.defineProperty(withSymbol, Symbol('secret'), { value: true })
    const exotic = Object.create({})
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('private-api-key')
        },
      }
    )
    for (const value of [
      accessor,
      withSymbol,
      exotic,
      proxy,
      { rpcUrl: TEST_RPC_URL, endpointId: TEST_ENDPOINT_ID, extra: true },
      { rpcUrl: { toString: () => TEST_RPC_URL }, endpointId: TEST_ENDPOINT_ID },
    ]) {
      await expect(fetchSolanaChainAnchorEvidence(value as never)).rejects.toThrow(
        'invalid Solana evidence options'
      )
    }
    expect(calls).toHaveLength(0)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 120_001])(
    'rejects invalid timeoutMs=%s',
    async (timeoutMs) => {
      const calls = mockRpc(() => ({}))
      await expect(
        fetchSolanaChainAnchorEvidence({
          rpcUrl: TEST_RPC_URL,
          endpointId: TEST_ENDPOINT_ID,
          timeoutMs,
        })
      ).rejects.toThrow('invalid Solana evidence options')
      expect(calls).toHaveLength(0)
    }
  )

  it.each([
    ['http://api.mainnet-beta.solana.com/', 'solana_official_mainnet'],
    ['https://api.mainnet-beta.solana.com/private', 'solana_official_mainnet'],
    ['https://api.mainnet-beta.solana.com/?key=secret', 'solana_official_mainnet'],
    ['https://api.mainnet-beta.solana.com.evil.test/', 'solana_official_mainnet'],
    ['https://user:password@api.mainnet-beta.solana.com/', 'solana_official_mainnet'],
    ['https://mainnet.helius-rpc.com/', 'helius_solana_mainnet'],
    ['https://mainnet.helius-rpc.com/?api-key=', 'helius_solana_mainnet'],
    ['https://mainnet.helius-rpc.com/?api-key=a&api-key=b', 'helius_solana_mainnet'],
    ['https://mainnet.helius-rpc.com/?api-key=a&extra=b', 'helius_solana_mainnet'],
    ['https://solana-mainnet.g.alchemy.com/v2/', 'alchemy_solana_mainnet'],
    ['https://solana-mainnet.g.alchemy.com/v2/a/b', 'alchemy_solana_mainnet'],
    ['https://solana-mainnet.g.alchemy.com/v2/a?extra=b', 'alchemy_solana_mainnet'],
    ['http://example.com/', 'local_solana_node'],
    ['http://127.0.0.1:8899/private', 'local_solana_node'],
    ['http://127.0.0.1:8899/?key=secret', 'local_solana_node'],
    [` ${TEST_RPC_URL}`, TEST_ENDPOINT_ID],
  ] as const)('does not call a URL outside its approved route', async (rpcUrl, endpointId) => {
    const calls = mockRpc(() => ({}))
    const anchor = await fetchSolanaChainAnchorEvidence({ rpcUrl, endpointId })
    expect(calls).toHaveLength(0)
    expect(anchor.genesisHash).toMatchObject({
      status: 'unavailable',
      reason: 'provider_unconfigured',
    })
  })

  it.each([
    ['https://api.mainnet-beta.solana.com/', 'solana_official_mainnet', 'solana_foundation'],
    ['https://mainnet.helius-rpc.com/?api-key=private-api-key', 'helius_solana_mainnet', 'helius'],
    [
      'https://solana-mainnet.g.alchemy.com/v2/private-api-key',
      'alchemy_solana_mainnet',
      'alchemy',
    ],
    ['http://localhost:8899/', 'local_solana_node', 'local'],
    ['http://[::1]:8899/', 'local_solana_node', 'local'],
  ] as const)('accepts the exact approved route for %s', async (rpcUrl, endpointId, providerId) => {
    const calls = mockRpc(() => ({}))
    const anchor = await fetchSolanaChainAnchorEvidence({ rpcUrl, endpointId })
    expect(calls).toHaveLength(3)
    expect(anchor.genesisHash).toMatchObject({
      status: 'available',
      provider: { servedBy: { providerId, endpointId } },
    })
    expect(JSON.stringify(anchor)).not.toContain('private-api-key')
  })

  it('never fails over from Helius to Alchemy inside one capture', async () => {
    process.env.HELIUS_API_KEY = 'helius-private-api-key'
    process.env.ALCHEMY_API_KEY = 'alchemy-private-api-key'
    const calls = mockRpc(() => ({ status: 402 }))
    const anchor = await fetchSolanaChainAnchorEvidence()

    expect(calls).toHaveLength(2)
    expect(calls.every(({ url }) => url.startsWith('https://mainnet.helius-rpc.com/'))).toBe(true)
    expect(calls.some(({ url }) => url.includes('alchemy'))).toBe(false)
    expect(anchor.genesisHash).toMatchObject({
      status: 'unavailable',
      reason: 'quota_exhausted',
      provider: { attempted: [{ providerId: 'helius' }] },
    })
    expect(JSON.stringify(anchor)).not.toContain('private-api-key')
  })

  it('uses Alchemy only when the Helius key is blank', async () => {
    process.env.HELIUS_API_KEY = '   '
    process.env.ALCHEMY_API_KEY = 'alchemy-private-api-key'
    const calls = mockRpc(() => ({}))
    const anchor = await fetchSolanaChainAnchorEvidence()
    expect(calls).toHaveLength(3)
    expect(calls.every(({ url }) => url.includes('solana-mainnet.g.alchemy.com'))).toBe(true)
    expect(anchor.genesisHash).toMatchObject({
      status: 'available',
      provider: { servedBy: { providerId: 'alchemy' } },
    })
  })

  it('retains a wrong mainnet identity without hiding valid slot and block lanes', async () => {
    mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result: request.method === 'getGenesisHash' ? BLOCK_HASH : successfulResult(request),
      },
    }))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(anchor.genesisHash).toMatchObject({ status: 'unavailable', reason: 'wrong_genesis' })
    expect(anchor.finalizedSlot.status).toBe('available')
    expect(anchor.finalizedBlock.status).toBe('available')
    expect(() => requireSolanaVerifiedChainAnchor(anchor)).toThrow(
      'Solana chain anchor is not fully verified'
    )
  })

  it.each(['1'.repeat(31), '1'.repeat(33), '0notbase58', null, {}, 42])(
    'rejects malformed genesis result %#',
    async (result) => {
      mockRpc((request) => ({
        payload: {
          jsonrpc: '2.0',
          id: 1,
          result: request.method === 'getGenesisHash' ? result : successfulResult(request),
        },
      }))
      const anchor = await fetchSolanaChainAnchorEvidence({
        rpcUrl: TEST_RPC_URL,
        endpointId: TEST_ENDPOINT_ID,
      })
      expect(anchor.genesisHash).toMatchObject({
        status: 'unavailable',
        reason: 'malformed_response',
      })
    }
  )

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null, {}])(
    'fails slot parsing closed for %#',
    async (result) => {
      const calls = mockRpc((request) => ({
        payload: {
          jsonrpc: '2.0',
          id: 1,
          result: request.method === 'getSlot' ? result : successfulResult(request),
        },
      }))
      const anchor = await fetchSolanaChainAnchorEvidence({
        rpcUrl: TEST_RPC_URL,
        endpointId: TEST_ENDPOINT_ID,
      })
      expect(calls).toHaveLength(2)
      expect(anchor.finalizedSlot).toMatchObject({
        status: 'unavailable',
        reason: 'malformed_response',
      })
      expect(anchor.finalizedBlock).toMatchObject({
        status: 'unavailable',
        reason: 'dependency_unavailable',
      })
    }
  )

  it('retains slot zero as raw evidence but never treats it as a current verified anchor', async () => {
    mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result:
          request.method === 'getSlot'
            ? 0
            : request.method === 'getBlock'
              ? null
              : successfulResult(request),
      },
    }))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(anchor.finalizedSlot).toMatchObject({ status: 'available', value: 0 })
    expect(() => requireSolanaVerifiedChainAnchor(anchor)).toThrow(
      'Solana chain anchor is not fully verified'
    )
  })

  it.each([
    { blockhash: '1'.repeat(31) },
    { blockhash: '1'.repeat(33) },
    { blockhash: '0notbase58' },
    { previousBlockhash: '1'.repeat(31) },
    { previousBlockhash: BLOCK_HASH },
    { parentSlot: SLOT },
    { parentSlot: -1 },
    { parentSlot: 1.5 },
    { blockTime: -1 },
    { blockTime: 1.5 },
    { blockTime: Number.MAX_SAFE_INTEGER + 1 },
    { blockHeight: -1 },
    { blockHeight: 1.5 },
  ])('fails finalized block parsing closed for %#', async (override) => {
    mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result:
          request.method === 'getBlock' ? finalizedBlock(override) : successfulResult(request),
      },
    }))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(anchor.finalizedBlock).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_response',
    })
  })

  it('requires explicit nullable block fields but safely strips unrelated provider fields', async () => {
    for (const missing of ['blockTime', 'blockHeight'] as const) {
      mockRpc((request) => {
        const value = finalizedBlock() as Record<string, unknown>
        delete value[missing]
        return {
          payload: {
            jsonrpc: '2.0',
            id: 1,
            result: request.method === 'getBlock' ? value : successfulResult(request),
          },
        }
      })
      const anchor = await fetchSolanaChainAnchorEvidence({
        rpcUrl: TEST_RPC_URL,
        endpointId: TEST_ENDPOINT_ID,
      })
      expect(anchor.finalizedBlock).toMatchObject({
        status: 'unavailable',
        reason: 'malformed_response',
      })
    }

    mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result:
          request.method === 'getBlock'
            ? finalizedBlock({ blockTime: null, blockHeight: null, transactions: ['secret'] })
            : successfulResult(request),
      },
    }))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(anchor.finalizedBlock).toMatchObject({
      status: 'available',
      value: { blockTime: null, blockHeight: null },
    })
    expect(JSON.stringify(anchor)).not.toContain('transactions')
  })

  it('allows parentSlot gaps because skipped slots are valid', async () => {
    mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result:
          request.method === 'getBlock'
            ? finalizedBlock({ parentSlot: SLOT - 3 })
            : successfulResult(request),
      },
    }))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(requireSolanaVerifiedChainAnchor(anchor).finalizedBlock.parentSlot).toBe(SLOT - 3)
  })

  it('distinguishes a null block result from a malformed result', async () => {
    for (const result of [null, []]) {
      mockRpc((request) => ({
        payload: {
          jsonrpc: '2.0',
          id: 1,
          result: request.method === 'getBlock' ? result : successfulResult(request),
        },
      }))
      const anchor = await fetchSolanaChainAnchorEvidence({
        rpcUrl: TEST_RPC_URL,
        endpointId: TEST_ENDPOINT_ID,
      })
      expect(anchor.finalizedBlock).toMatchObject({
        status: 'unavailable',
        reason: result === null ? 'not_found_or_unavailable' : 'malformed_response',
      })
    }
  })

  it.each([-32_001, -32_004, -32_007, -32_009, -32_011, -32_014, -32_019])(
    'maps getBlock provider gap code %s without claiming an empty or skipped block',
    async (code) => {
      mockRpc((request) => ({
        payload:
          request.method === 'getBlock'
            ? { jsonrpc: '2.0', id: 1, error: { code, message: 'provider gap private-api-key' } }
            : { jsonrpc: '2.0', id: 1, result: successfulResult(request) },
      }))
      const anchor = await fetchSolanaChainAnchorEvidence({
        rpcUrl: TEST_RPC_URL,
        endpointId: TEST_ENDPOINT_ID,
      })
      expect(anchor.finalizedBlock).toMatchObject({
        status: 'unavailable',
        reason: 'not_found_or_unavailable',
        rpcCode: code,
      })
      expect(JSON.stringify(anchor)).not.toContain('private-api-key')
    }
  )

  it.each([
    ['wrong JSON-RPC version', { jsonrpc: '1.0', id: 1, result: SLOT }],
    ['wrong response ID', { jsonrpc: '2.0', id: 2, result: SLOT }],
    [
      'result and error together',
      { jsonrpc: '2.0', id: 1, result: SLOT, error: { code: -1, message: 'bad' } },
    ],
    ['neither result nor error', { jsonrpc: '2.0', id: 1 }],
    ['malformed error code', { jsonrpc: '2.0', id: 1, error: { code: 'bad', message: 'bad' } }],
    ['error without message', { jsonrpc: '2.0', id: 1, error: { code: -32_000 } }],
    ['array envelope', []],
    ['null envelope', null],
  ])('rejects a %s envelope', async (_label, payload) => {
    const calls = mockRpc(() => ({ payload }))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(calls).toHaveLength(2)
    expect(anchor.genesisHash).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_response',
    })
    expect(anchor.finalizedSlot).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_response',
    })
    expect(anchor.finalizedBlock).toMatchObject({
      status: 'unavailable',
      reason: 'dependency_unavailable',
    })
  })

  it.each([
    '{not-json private-api-key',
    '',
    '\uFEFF{"jsonrpc":"2.0","id":1,"result":1}',
    '{"jsonrpc":"2.0","id":1,"id":2,"result":1}',
    '{"jsonrpc":"2.0","\\u0069d":1,"id":1,"result":1}',
    '{"jsonrpc":"2.0","id":1,"result":1,"result":2}',
    '{"jsonrpc":"2.0","id":1,"error":{"code":-1,"code":-2,"message":"bad"}}',
  ])('rejects invalid or ambiguous JSON without leaking raw text', async (body) => {
    mockRpc(() => ({ body }))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(anchor.genesisHash).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_response',
    })
    expect(JSON.stringify(anchor)).not.toContain('private-api-key')
  })

  it('rejects JSON nesting beyond the strict parser depth budget', async () => {
    let nested = '0'
    for (let depth = 0; depth < 130; depth += 1) nested = `[${nested}]`
    mockRpc(() => ({ body: `{"jsonrpc":"2.0","id":1,"result":${nested}}` }))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(anchor.genesisHash).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_response',
    })
  })

  it('rejects duplicate keys nested inside the finalized block result', async () => {
    mockRpc((request) =>
      request.method === 'getBlock'
        ? {
            body: `{"jsonrpc":"2.0","id":1,"result":{"blockhash":"${BLOCK_HASH}","blockhash":"${PREVIOUS_BLOCK_HASH}","previousBlockhash":"${PREVIOUS_BLOCK_HASH}","parentSlot":${SLOT - 1},"blockTime":${BLOCK_TIME},"blockHeight":${BLOCK_HEIGHT}}}`,
          }
        : {}
    )
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(anchor.finalizedBlock).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_response',
    })
  })

  it.each([
    [429, 'rate_limited'],
    [402, 'quota_exhausted'],
    [500, 'rpc_error'],
  ] as const)('maps HTTP %s to %s and cancels its body', async (status, reason) => {
    const cancel = jest.fn(async () => undefined)
    mockRpc(() => ({ status, cancel }))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(anchor.genesisHash).toMatchObject({ status: 'unavailable', reason, httpStatus: status })
    expect(cancel).toHaveBeenCalledTimes(2)
  })

  it.each([
    [-32_001, 'daily quota exhausted at private-api-key', 'quota_exhausted'],
    [-32_005, 'rate limit reached at private-api-key', 'rate_limited'],
    [-32_601, 'method unavailable at private-api-key', 'rpc_error'],
  ] as const)(
    'maps RPC code %s to %s without leaking its message',
    async (code, message, reason) => {
      mockRpc(() => ({ payload: { jsonrpc: '2.0', id: 1, error: { code, message } } }))
      const anchor = await fetchSolanaChainAnchorEvidence({
        rpcUrl: TEST_RPC_URL,
        endpointId: TEST_ENDPOINT_ID,
      })
      expect(anchor.genesisHash).toMatchObject({
        status: 'unavailable',
        reason,
        rpcCode: code,
      })
      expect(JSON.stringify(anchor)).not.toContain('private-api-key')
    }
  )

  it('rejects and cancels a response declared above the byte budget', async () => {
    const cancel = jest.fn(async () => undefined)
    mockRpc(() => ({ contentLength: String(2 * 1024 * 1024 + 1), cancel }))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(anchor.genesisHash).toMatchObject({
      status: 'unavailable',
      reason: 'response_too_large',
    })
    expect(cancel).toHaveBeenCalledTimes(2)
  })

  it('accepts an exact 2 MiB response before parsing its normalized result', async () => {
    const maxBytes = 2 * 1024 * 1024
    mockRpc((request) => {
      const base = JSON.stringify({ jsonrpc: '2.0', id: 1, result: successfulResult(request) })
      return {
        body: `${base}${' '.repeat(maxBytes - Buffer.byteLength(base))}`,
        contentLength: String(maxBytes),
      }
    })
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(requireSolanaVerifiedChainAnchor(anchor).finalizedSlot).toBe(SLOT)
  })

  it('measures fallback text by UTF-8 bytes instead of JavaScript string length', async () => {
    const body = `{"jsonrpc":"2.0","id":1,"result":"${'é'.repeat(1_100_000)}"}`
    expect(body.length).toBeLessThan(2 * 1024 * 1024)
    mockRpc(() => ({ body }))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(anchor.genesisHash).toMatchObject({
      status: 'unavailable',
      reason: 'response_too_large',
    })
  })

  it('stops and cancels a streamed response at one byte over budget', async () => {
    const cancels: jest.Mock[] = []
    mockRpc(() => {
      const cancel = jest.fn(async () => undefined)
      cancels.push(cancel)
      return {
        stream: {
          getReader: () => ({
            read: jest
              .fn()
              .mockResolvedValueOnce({ done: false, value: new Uint8Array(2 * 1024 * 1024) })
              .mockResolvedValueOnce({ done: false, value: new Uint8Array(1) }),
            cancel,
          }),
        } as never,
      }
    })
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(anchor.genesisHash).toMatchObject({
      status: 'unavailable',
      reason: 'response_too_large',
    })
    expect(cancels.every((cancel) => cancel.mock.calls.length === 1)).toBe(true)
  })

  it('rejects invalid UTF-8 from a streamed response', async () => {
    mockRpc(() => ({
      stream: {
        getReader: () => ({
          read: jest
            .fn()
            .mockResolvedValueOnce({ done: false, value: Uint8Array.of(0xff) })
            .mockResolvedValueOnce({ done: true }),
          cancel: jest.fn(async () => undefined),
        }),
      } as never,
    }))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(anchor.genesisHash).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_response',
    })
  })

  it.each([
    [Object.assign(new Error('request aborted'), { name: 'AbortError' }), 'timeout'],
    [new Error('socket failed at private-api-key'), 'transport_error'],
  ] as const)(
    'maps transport failure to %s without retaining raw errors',
    async (error, reason) => {
      mockRpc(() => ({ error }))
      const anchor = await fetchSolanaChainAnchorEvidence({
        rpcUrl: TEST_RPC_URL,
        endpointId: TEST_ENDPOINT_ID,
      })
      expect(anchor.genesisHash).toMatchObject({ status: 'unavailable', reason })
      expect(JSON.stringify(anchor)).not.toContain('private-api-key')
    }
  )
})
