import {
  BSC_MAINNET_CHAIN_ID,
  BSC_MAINNET_GENESIS_HASH,
  fetchBscChainAnchorEvidence,
  requireBscVerifiedChainAnchor,
} from '../bsc-evidence'

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

const ZERO_HASH = `0x${'0'.repeat(64)}`
const HASH_A = `0x${'a1'.repeat(32)}`
const HASH_B = `0x${'b2'.repeat(32)}`
const HASH_C = `0x${'c3'.repeat(32)}`
const EMPTY_ROOT = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421'
const TEST_RPC_URL = 'http://127.0.0.1/private-api-key'
const TEST_ENDPOINT_ID = 'local_bsc_node' as const
const FIXED_NOW = '2026-07-16T19:32:00.000Z'

function genesisBlock(overrides: Record<string, unknown> = {}) {
  return {
    number: '0x0',
    hash: BSC_MAINNET_GENESIS_HASH,
    parentHash: ZERO_HASH,
    timestamp: '0x5e9da7ce',
    stateRoot: '0x919fcc7ad870b53db0aa76eb588da06bacb6d230195100699fc928511003b422',
    transactionsRoot: EMPTY_ROOT,
    receiptsRoot: EMPTY_ROOT,
    ...overrides,
  }
}

function finalizedBlock(overrides: Record<string, unknown> = {}) {
  return {
    number: '0x123',
    hash: HASH_A,
    parentHash: HASH_B,
    timestamp: '0x6a59319a',
    stateRoot: HASH_C,
    transactionsRoot: EMPTY_ROOT,
    receiptsRoot: EMPTY_ROOT,
    ...overrides,
  }
}

function successfulPayload(request: RpcRequest): unknown {
  if (request.method === 'eth_chainId') return BSC_MAINNET_CHAIN_ID
  return request.params[0] === '0x0' ? genesisBlock() : finalizedBlock()
}

function mockRpc(handler: (request: RpcRequest) => MockReply): RpcRequest[] {
  const requests: RpcRequest[] = []
  global.fetch = jest.fn(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest
    requests.push(request)
    const reply = handler(request)
    if (reply.error) throw reply.error
    const payload =
      reply.payload === undefined
        ? { jsonrpc: '2.0', id: 1, result: successfulPayload(request) }
        : reply.payload
    return {
      status: reply.status ?? 200,
      headers: { get: () => reply.contentLength ?? null },
      body: reply.stream ?? (reply.cancel ? { cancel: reply.cancel } : undefined),
      text: async () => reply.body ?? JSON.stringify(payload),
    } as Response
  }) as jest.MockedFunction<typeof fetch>
  return requests
}

describe('fetchBscChainAnchorEvidence', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date(FIXED_NOW))
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
    if (originalFetch) global.fetch = originalFetch
    else delete (global as typeof global & { fetch?: typeof fetch }).fetch
  })

  it('binds one endpoint to chain ID, genesis, and the standard finalized tag', async () => {
    const requests = mockRpc((request) => {
      if (request.method === 'eth_chainId') return {}
      if (request.params[0] === '0x0') return {}
      const upperHash = `0x${HASH_A.slice(2).toUpperCase()}`
      return {
        payload: {
          jsonrpc: '2.0',
          id: 1,
          result: finalizedBlock({ number: '0xA', hash: upperHash }),
        },
      }
    })
    const anchor = await fetchBscChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })

    expect(requests).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
      { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['0x0', false] },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBlockByNumber',
        params: ['finalized', false],
      },
      { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] },
    ])
    expect(anchor.chain).toEqual({ namespace: 'eip155', reference: '56' })
    expect(anchor.finalityPolicy).toEqual({
      version: 'bsc_standard_finalized_current_v1',
      method: 'eth_getBlockByNumber',
      blockTag: 'finalized',
      headBlockTag: 'latest',
      fullTransactions: false,
      maxFutureBlockSkewMs: 60_000,
      maxCurrentAnchorLagMs: 900_000,
    })
    expect(anchor.chainId).toMatchObject({
      status: 'available',
      value: '0x38',
      provider: {
        servedBy: { providerId: 'local', endpointId: TEST_ENDPOINT_ID },
      },
    })
    expect(anchor.genesisBlock).toMatchObject({
      status: 'available',
      value: { number: '0x0', hash: BSC_MAINNET_GENESIS_HASH, parentHash: ZERO_HASH },
    })
    expect(anchor.finalizedBlock).toMatchObject({
      status: 'available',
      value: { number: '0xa', hash: HASH_A },
    })
    expect(requireBscVerifiedChainAnchor(anchor)).toMatchObject({
      endpoint: { providerId: 'local', endpointId: TEST_ENDPOINT_ID },
      chainId: '0x38',
      genesisBlock: { hash: BSC_MAINNET_GENESIS_HASH },
      finalizedBlock: { number: '0xa', hash: HASH_A },
      headBlock: { number: '0xa', hash: HASH_A },
    })
    expect(
      (global.fetch as jest.Mock).mock.calls.every(([, init]) => init.redirect === 'error')
    ).toBe(true)
    expect(JSON.stringify(anchor)).not.toContain('private-api-key')
    expect(JSON.stringify(anchor)).not.toContain('127.0.0.1')
  })

  it('strictly reparses a serialized anchor before granting verified status', async () => {
    mockRpc(() => ({}))
    const anchor = await fetchBscChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(requireBscVerifiedChainAnchor(JSON.parse(JSON.stringify(anchor)))).toMatchObject({
      chainId: BSC_MAINNET_CHAIN_ID,
      observedAt: FIXED_NOW,
    })

    const attacks: Array<(value: any) => void> = [
      (value) => {
        value.secret = 'private-api-key'
      },
      (value) => {
        value.finalizedBlock.value.secret = 'private-api-key'
      },
      (value) => {
        value.finalizedBlock.value.number = '1'
        value.finalizedBlock.value.hash = 'x'
      },
      (value) => {
        value.finalizedBlock.httpStatus = null
      },
      (value) => {
        value.headBlock.provider.servedBy.endpointId = 'private_api_key_123'
        value.headBlock.provider.attempted[0].endpointId = 'private_api_key_123'
      },
      (value) => {
        value.headBlock.provider.servedBy.providerId = 'alchemy'
        value.headBlock.provider.attempted[0].providerId = 'alchemy'
      },
      (value) => {
        value.observedAt = 'not-a-timestamp'
      },
      (value) => {
        value.finalityPolicy.maxFutureBlockSkewMs = 60_001
      },
      (value) => {
        value.finalityPolicy.headBlockTag = 'pending'
      },
    ]
    for (const mutate of attacks) {
      const attacked = JSON.parse(JSON.stringify(anchor))
      mutate(attacked)
      expect(() => requireBscVerifiedChainAnchor(attacked)).toThrow(
        'BSC chain anchor is not fully verified'
      )
    }

    const accessor = JSON.parse(JSON.stringify(anchor))
    Object.defineProperty(accessor.finalizedBlock, 'value', {
      enumerable: true,
      get: () => finalizedBlock(),
    })
    expect(() => requireBscVerifiedChainAnchor(accessor)).toThrow(
      'BSC chain anchor is not fully verified'
    )
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('private-api-key')
        },
      }
    )
    expect(() => requireBscVerifiedChainAnchor(proxy)).toThrow(
      'BSC chain anchor is not fully verified'
    )
  })

  it('rejects stale, future, or internally contradictory finalized/head observations', async () => {
    mockRpc(() => ({}))
    const anchor = await fetchBscChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    const mutations: Array<(value: any) => void> = [
      (value) => {
        for (const lane of [value.finalizedBlock, value.headBlock]) {
          lane.value.number = '0x1'
          lane.value.timestamp = '0x5e9da7cf'
        }
      },
      (value) => {
        for (const lane of [value.finalizedBlock, value.headBlock]) {
          lane.value.timestamp = '0xffffffffffffffff'
        }
      },
      (value) => {
        value.headBlock.value.stateRoot = HASH_B
      },
      (value) => {
        value.headBlock.value.number = '0x124'
        value.headBlock.value.hash = HASH_C
        value.headBlock.value.parentHash = HASH_B
        value.headBlock.value.timestamp = '0x6a59319b'
      },
      (value) => {
        value.headBlock.value.number = '0x122'
        value.headBlock.value.hash = HASH_C
      },
    ]
    for (const mutate of mutations) {
      const attacked = JSON.parse(JSON.stringify(anchor))
      mutate(attacked)
      expect(() => requireBscVerifiedChainAnchor(attacked)).toThrow(
        'BSC chain anchor is not fully verified'
      )
    }

    const adjacent = JSON.parse(JSON.stringify(anchor))
    adjacent.headBlock.value.number = '0x124'
    adjacent.headBlock.value.hash = HASH_C
    adjacent.headBlock.value.parentHash = HASH_A
    adjacent.headBlock.value.timestamp = '0x6a59319b'
    expect(requireBscVerifiedChainAnchor(adjacent).headBlock).toMatchObject({
      number: '0x124',
      hash: HASH_C,
      parentHash: HASH_A,
    })
  })

  it('keeps configuration failure explicit and makes no request', async () => {
    const requests = mockRpc(() => ({}))
    const anchor = await fetchBscChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
    })

    expect(requests).toHaveLength(0)
    for (const lane of [
      anchor.chainId,
      anchor.genesisBlock,
      anchor.finalizedBlock,
      anchor.headBlock,
    ]) {
      expect(lane).toEqual({
        status: 'unavailable',
        reason: 'provider_unconfigured',
        provider: { servedBy: null, attempted: [] },
        rpcCode: null,
        httpStatus: null,
      })
    }
  })

  it.each([
    { rpcUrl: 'https://rpc.invalid', endpointId: 'https://secret.invalid' },
    { rpcUrl: 'https://rpc.invalid', endpointId: 'private-api-key' },
    { rpcUrl: 'https://rpc.invalid', endpointId: 'unknown_endpoint' },
  ])('rejects an endpoint identity outside the static allowlist %#', async (opts) => {
    const requests = mockRpc(() => ({}))
    await expect(fetchBscChainAnchorEvidence(opts as never)).rejects.toThrow(
      'invalid BSC evidence options'
    )
    expect(requests).toHaveLength(0)
  })

  it('rejects accessors, non-string option values, and unknown option fields', async () => {
    const requests = mockRpc(() => ({}))
    const accessor = { endpointId: TEST_ENDPOINT_ID }
    Object.defineProperty(accessor, 'rpcUrl', {
      enumerable: true,
      get: () => TEST_RPC_URL,
    })
    await expect(fetchBscChainAnchorEvidence(accessor as never)).rejects.toThrow(
      'invalid BSC evidence options'
    )
    await expect(
      fetchBscChainAnchorEvidence({ rpcUrl: { toString: () => TEST_RPC_URL } } as never)
    ).rejects.toThrow('invalid BSC evidence options')
    await expect(
      fetchBscChainAnchorEvidence({ rpcUrl: TEST_RPC_URL, extra: true } as never)
    ).rejects.toThrow('invalid BSC evidence options')
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('private-api-key')
        },
      }
    )
    await expect(fetchBscChainAnchorEvidence(proxy)).rejects.toThrow('invalid BSC evidence options')
    expect(requests).toHaveLength(0)
  })

  it.each([
    ['https://other.invalid', 'bnb_official_public_seed'],
    ['http://bsc-dataseed.bnbchain.org', 'bnb_official_public_seed'],
    ['http://example.com', 'local_bsc_node'],
    ['https://user:password@bsc-dataseed.bnbchain.org', 'bnb_official_public_seed'],
  ] as const)(
    'does not call a URL outside the approved endpoint mapping',
    async (rpcUrl, endpointId) => {
      const requests = mockRpc(() => ({}))
      const anchor = await fetchBscChainAnchorEvidence({ rpcUrl, endpointId })
      expect(requests).toHaveLength(0)
      expect(anchor.chainId).toMatchObject({
        status: 'unavailable',
        reason: 'provider_unconfigured',
      })
    }
  )

  it.each([0, -1, 1.5, Number.NaN, 120_001])('rejects invalid timeoutMs=%s', async (timeoutMs) => {
    const requests = mockRpc(() => ({}))
    await expect(
      fetchBscChainAnchorEvidence({
        rpcUrl: TEST_RPC_URL,
        endpointId: TEST_ENDPOINT_ID,
        timeoutMs,
      })
    ).rejects.toThrow('invalid BSC evidence options')
    expect(requests).toHaveLength(0)
  })

  it('retains wrong-chain and wrong-genesis failures without hiding a valid finalized lane', async () => {
    mockRpc((request) => {
      const result =
        request.method === 'eth_chainId'
          ? '0x1'
          : request.params[0] === '0x0'
            ? genesisBlock({ hash: HASH_A })
            : finalizedBlock()
      return { payload: { jsonrpc: '2.0', id: 1, result } }
    })
    const anchor = await fetchBscChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })

    expect(anchor.chainId).toMatchObject({ status: 'unavailable', reason: 'wrong_chain' })
    expect(anchor.genesisBlock).toMatchObject({ status: 'unavailable', reason: 'wrong_genesis' })
    expect(anchor.finalizedBlock.status).toBe('available')
    expect(() => requireBscVerifiedChainAnchor(anchor)).toThrow(
      'BSC chain anchor is not fully verified'
    )
  })

  it.each([
    { number: '0x1' },
    { parentHash: HASH_A },
    { timestamp: '0x5e9da7cf' },
    { stateRoot: HASH_A },
    { transactionsRoot: HASH_A },
    { receiptsRoot: HASH_A },
  ])('rejects drift in every pinned genesis header field %#', async (override) => {
    mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result:
          request.method === 'eth_chainId'
            ? BSC_MAINNET_CHAIN_ID
            : request.params[0] === '0x0'
              ? genesisBlock(override)
              : finalizedBlock(),
      },
    }))
    const anchor = await fetchBscChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(anchor.genesisBlock).toMatchObject({
      status: 'unavailable',
      reason: 'wrong_genesis',
    })
  })

  it('distinguishes a missing block from a malformed block', async () => {
    mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result:
          request.method === 'eth_chainId'
            ? BSC_MAINNET_CHAIN_ID
            : request.params[0] === '0x0'
              ? null
              : finalizedBlock({ receiptsRoot: '0x1234' }),
      },
    }))
    const anchor = await fetchBscChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })

    expect(anchor.genesisBlock).toMatchObject({ status: 'unavailable', reason: 'not_found' })
    expect(anchor.finalizedBlock).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_response',
    })
  })

  it.each([
    { number: '0x01' },
    { number: '0x0' },
    { number: `0x${'1'.repeat(17)}` },
    { hash: ZERO_HASH },
    { hash: HASH_B },
    { hash: BSC_MAINNET_GENESIS_HASH },
    { parentHash: ZERO_HASH },
    { timestamp: '123' },
    { timestamp: '0x0' },
    { timestamp: '0x5e9da7ce' },
    { stateRoot: null },
    { transactionsRoot: `0x${'0'.repeat(64)}` },
    { receiptsRoot: '0x1234' },
  ])('fails finalized header parsing closed for %#', async (override) => {
    mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result:
          request.method === 'eth_chainId'
            ? BSC_MAINNET_CHAIN_ID
            : request.params[0] === '0x0'
              ? genesisBlock()
              : finalizedBlock(override),
      },
    }))
    const anchor = await fetchBscChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(anchor.finalizedBlock).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_response',
    })
  })

  it.each([
    ['wrong JSON-RPC version', { jsonrpc: '1.0', id: 1, result: '0x38' }],
    ['wrong response ID', { jsonrpc: '2.0', id: 2, result: '0x38' }],
    [
      'result and error together',
      { jsonrpc: '2.0', id: 1, result: '0x38', error: { code: -1, message: 'bad' } },
    ],
    ['neither result nor error', { jsonrpc: '2.0', id: 1 }],
    ['malformed error', { jsonrpc: '2.0', id: 1, error: { code: 'bad' } }],
    ['error without message', { jsonrpc: '2.0', id: 1, error: { code: -32000 } }],
    ['array envelope', []],
  ])('rejects a %s envelope', async (_label, payload) => {
    mockRpc(() => ({ payload }))
    const anchor = await fetchBscChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })

    for (const lane of [
      anchor.chainId,
      anchor.genesisBlock,
      anchor.finalizedBlock,
      anchor.headBlock,
    ]) {
      expect(lane).toMatchObject({ status: 'unavailable', reason: 'malformed_response' })
    }
  })

  it('rejects invalid JSON without returning raw response text', async () => {
    mockRpc(() => ({ body: '{not-json private-api-key' }))
    const anchor = await fetchBscChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })

    expect(anchor.chainId).toMatchObject({ status: 'unavailable', reason: 'malformed_response' })
    expect(JSON.stringify(anchor)).not.toContain('private-api-key')
  })

  it.each([
    '{"jsonrpc":"2.0","id":1,"id":2,"result":"0x38"}',
    '{"jsonrpc":"2.0","id":1,"result":"0x38","result":"0x38"}',
    '{"jsonrpc":"2.0","\\u0069d":1,"id":1,"result":"0x38"}',
  ])('rejects duplicate JSON-RPC keys before interpreting the envelope', async (body) => {
    mockRpc(() => ({ body }))
    const anchor = await fetchBscChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })

    expect(anchor.chainId).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_response',
    })
  })

  it.each([
    [429, 'rate_limited'],
    [402, 'quota_exhausted'],
    [500, 'rpc_error'],
  ] as const)('maps HTTP %s to %s', async (status, reason) => {
    mockRpc(() => ({ status }))
    const anchor = await fetchBscChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(anchor.chainId).toMatchObject({
      status: 'unavailable',
      reason,
      httpStatus: status,
    })
  })

  it('cancels non-success response bodies before returning', async () => {
    const cancel = jest.fn(async () => undefined)
    mockRpc(() => ({ status: 500, cancel }))
    const anchor = await fetchBscChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(anchor.chainId).toMatchObject({ status: 'unavailable', reason: 'rpc_error' })
    expect(cancel).toHaveBeenCalledTimes(4)
  })

  it('rejects and cancels a response declared above the byte budget', async () => {
    const cancel = jest.fn(async () => undefined)
    mockRpc(() => ({ contentLength: String(2 * 1024 * 1024 + 1), cancel }))
    const anchor = await fetchBscChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(anchor.chainId).toMatchObject({
      status: 'unavailable',
      reason: 'response_too_large',
    })
    expect(cancel).toHaveBeenCalledTimes(4)
  })

  it('stops a streamed response once it crosses the byte budget', async () => {
    mockRpc(() => ({
      stream: {
        getReader: () => ({
          read: jest.fn().mockResolvedValueOnce({
            done: false,
            value: new Uint8Array(2 * 1024 * 1024 + 1),
          }),
          cancel: jest.fn(async () => undefined),
        }),
      } as never,
    }))
    const anchor = await fetchBscChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(anchor.chainId).toMatchObject({
      status: 'unavailable',
      reason: 'response_too_large',
    })
  })

  it.each([
    [-32001, 'daily quota exhausted at private-api-key', 'quota_exhausted'],
    [-32005, 'rate limit reached at private-api-key', 'rate_limited'],
    [-32601, 'method unavailable at private-api-key', 'rpc_error'],
  ] as const)(
    'maps RPC code %s to %s without leaking the message',
    async (code, message, reason) => {
      mockRpc(() => ({ payload: { jsonrpc: '2.0', id: 1, error: { code, message } } }))
      const anchor = await fetchBscChainAnchorEvidence({
        rpcUrl: TEST_RPC_URL,
        endpointId: TEST_ENDPOINT_ID,
      })
      expect(anchor.chainId).toMatchObject({
        status: 'unavailable',
        reason,
        rpcCode: code,
      })
      expect(JSON.stringify(anchor)).not.toContain('private-api-key')
    }
  )

  it.each([
    [Object.assign(new Error('request aborted'), { name: 'AbortError' }), 'timeout'],
    [new Error('socket failed at private-api-key'), 'transport_error'],
  ] as const)('maps transport failure to %s without raw errors', async (error, reason) => {
    mockRpc(() => ({ error }))
    const anchor = await fetchBscChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(anchor.chainId).toMatchObject({ status: 'unavailable', reason })
    expect(JSON.stringify(anchor)).not.toContain('private-api-key')
  })
})
