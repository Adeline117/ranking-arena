import { createHash } from 'node:crypto'

import {
  SOLANA_MAINNET_GENESIS_HASH,
  captureSolanaVerifiedChainAnchorEvidence,
  fetchSolanaChainAnchorEvidence,
  requireSolanaVerifiedChainAnchor,
} from '../solana-evidence'
import { parseOptsOrThrow, resolveEndpoint, solanaEvidenceRpc } from '../solana-evidence-core'

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
  arrayBuffer?: jest.Mock<Promise<ArrayBuffer>, []>
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
const PUBLICNODE_SOLANA_ORIGIN = 'https://solana-rpc.publicnode.com'
const PUBLICNODE_SOLANA_CONNECTION_HASH = createHash('sha256')
  .update(
    JSON.stringify([
      'solana_evidence_connection_v1',
      'publicnode',
      'publicnode_solana_mainnet',
      PUBLICNODE_SOLANA_ORIGIN,
    ])
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
  if (request.method === 'getBlocks') return [SLOT]
  return finalizedBlock()
}

function successfulResponseBody(request: RpcRequest): string {
  return `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: successfulResult(request),
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
      arrayBuffer: reply.arrayBuffer,
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

  it('binds finalized root, produced-slot resolution, and selected block to one endpoint', async () => {
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
        method: 'getBlocks',
        params: [SLOT - 512, SLOT, { commitment: 'finalized', minContextSlot: SLOT }],
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
        version: 'solana_current_finalized_produced_block_v2',
        rootSlotMethod: 'getSlot',
        producedSlotsMethod: 'getBlocks',
        producedSlotLookback: 512,
        minContextSlotPolicy: 'finalized_root_slot',
        commitment: 'finalized',
        transactionDetails: 'none',
        maxFutureBlockSkewMs: 60_000,
        maxCurrentAnchorLagMs: 900_000,
      },
      genesisHash: { status: 'available', value: SOLANA_MAINNET_GENESIS_HASH },
      finalizedRootSlot: { status: 'available', value: SLOT },
      producedSlotResolution: {
        status: 'available',
        value: {
          rangeStartSlot: SLOT - 512,
          rangeEndSlot: SLOT,
          producedSlots: [SLOT],
          selectedSlot: SLOT,
          selectionPolicy: 'highest_returned_finalized_produced_slot_v1',
        },
      },
      finalizedBlock: {
        status: 'available',
        value: { slot: SLOT, ...finalizedBlock() },
      },
    })
    for (const lane of [
      anchor.genesisHash,
      anchor.finalizedRootSlot,
      anchor.producedSlotResolution,
      anchor.finalizedBlock,
    ]) {
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
      semanticHashPolicy: 'solana_verified_anchor_semantics_v2',
    })
    expect(verified.semanticHash).toBe(
      '1fc4752a9081e393e8964962aeb1ad0ccc45d7319f465def3cd4048773f61129'
    )
    expect(JSON.stringify(anchor)).not.toContain(TEST_RPC_ORIGIN)
    expect(JSON.stringify(anchor)).not.toContain('private-api-key')
  })

  it('selects the highest returned produced slot when the finalized root is omitted', async () => {
    const finalizedRootSlot = SLOT + 7
    const producedSlots = [SLOT - 2, SLOT]
    const calls = mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result:
          request.method === 'getSlot'
            ? finalizedRootSlot
            : request.method === 'getBlocks'
              ? producedSlots
              : successfulResult(request),
      },
    }))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })

    expect(calls[2].request).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'getBlocks',
      params: [
        finalizedRootSlot - 512,
        finalizedRootSlot,
        { commitment: 'finalized', minContextSlot: finalizedRootSlot },
      ],
    })
    expect(calls[3].request.method).toBe('getBlock')
    expect(calls[3].request.params[0]).toBe(SLOT)
    expect(
      calls.some(
        ({ request }) => request.method === 'getBlock' && request.params[0] === finalizedRootSlot
      )
    ).toBe(false)
    expect(anchor.producedSlotResolution).toMatchObject({
      status: 'available',
      value: {
        rangeStartSlot: finalizedRootSlot - 512,
        rangeEndSlot: finalizedRootSlot,
        producedSlots,
        selectedSlot: SLOT,
      },
    })
    expect(requireSolanaVerifiedChainAnchor(anchor)).toMatchObject({
      finalizedRootSlot,
      finalizedSlot: SLOT,
      producedSlotResolution: { producedSlots, selectedSlot: SLOT },
      finalizedBlock: { slot: SLOT },
    })
  })

  it('accepts the complete 513-slot inclusive resolution window', async () => {
    const producedSlots = Array.from({ length: 513 }, (_, index) => SLOT - 512 + index)
    mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result: request.method === 'getBlocks' ? producedSlots : successfulResult(request),
      },
    }))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })

    expect(requireSolanaVerifiedChainAnchor(anchor).producedSlotResolution.producedSlots).toEqual(
      producedSlots
    )
  })

  it('clamps the produced-slot range start to zero', async () => {
    const finalizedRootSlot = 7
    const calls = mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result:
          request.method === 'getSlot'
            ? finalizedRootSlot
            : request.method === 'getBlocks'
              ? [2, finalizedRootSlot]
              : request.method === 'getBlock'
                ? finalizedBlock({ parentSlot: 6, blockHeight: 7 })
                : successfulResult(request),
      },
    }))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })

    expect(calls[2].request.params).toEqual([
      0,
      finalizedRootSlot,
      { commitment: 'finalized', minContextSlot: finalizedRootSlot },
    ])
    expect(requireSolanaVerifiedChainAnchor(anchor)).toMatchObject({
      finalizedRootSlot,
      finalizedSlot: finalizedRootSlot,
      producedSlotResolution: { rangeStartSlot: 0, rangeEndSlot: finalizedRootSlot },
    })
  })

  it('captures the exact same request and streamed response bytes before UTF-8 decoding', async () => {
    const calls = mockRpc((request) => ({ stream: byteStream(successfulResponseBody(request)) }))
    const captured = await captureSolanaVerifiedChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })

    expect(captured.verified.finalizedSlot).toBe(SLOT)
    expect(captured.rawExchanges.map(({ lane }) => lane)).toEqual([
      'genesis_hash',
      'finalized_anchor_slot',
      'finalized_anchor_produced_slots',
      'finalized_anchor_block',
    ])
    expect(captured.rawExchanges).toHaveLength(calls.length)
    const expectedMethods = ['getGenesisHash', 'getSlot', 'getBlocks', 'getBlock']
    for (const [index, exchange] of captured.rawExchanges.entries()) {
      const requestBody = String(calls[index].init.body)
      const responseBody = successfulResponseBody(calls[index].request)
      const requestBytes = Buffer.from(exchange.request.bytes)
      const responseBytes = Buffer.from(exchange.response.bytes)
      expect(requestBytes.toString('utf8')).toBe(requestBody)
      expect(responseBytes.toString('utf8')).toBe(responseBody)
      expect(exchange.request.byteLength).toBe(Buffer.byteLength(requestBody))
      expect(exchange.response.byteLength).toBe(Buffer.byteLength(responseBody))
      expect(exchange.request.sha256).toBe(createHash('sha256').update(requestBytes).digest('hex'))
      expect(exchange.response.sha256).toBe(
        createHash('sha256').update(responseBytes).digest('hex')
      )
      expect(exchange.request.hashBasis).toBe('utf8_json_rpc_request_body_bytes')
      expect(exchange.response.hashBasis).toBe(
        'fetch_content_decoded_http_entity_body_bytes_before_utf8'
      )
      expect(exchange.method).toBe(expectedMethods[index])
      expect(exchange.httpStatus).toBe(200)
      expect(exchange.completedAt).toBe(FIXED_NOW)
      expect(exchange.trustBoundary).toBe(
        'json_rpc_result_transport_only_semantic_lane_not_yet_verified'
      )
      expect(exchange.endpoint).toEqual({
        providerId: 'local',
        endpointId: TEST_ENDPOINT_ID,
        connectionHash: TEST_CONNECTION_HASH,
      })
      expect(exchange).not.toHaveProperty('url')
    }
    expect(JSON.stringify(captured.evidence)).not.toContain('providerNote')
    expect(Buffer.from(captured.rawExchanges[3].response.bytes).toString('utf8')).toContain(
      '链上原始字段'
    )
  })

  it('fails exact capture closed for a text-only response while preserving the normal API', async () => {
    const arrayBuffers: Array<jest.Mock<Promise<ArrayBuffer>, []>> = []
    const calls = mockRpc(() => {
      const arrayBuffer = jest.fn(async () => new ArrayBuffer(0))
      arrayBuffers.push(arrayBuffer)
      return { contentLength: '10', arrayBuffer }
    })
    await expect(
      captureSolanaVerifiedChainAnchorEvidence({
        rpcUrl: TEST_RPC_URL,
        endpointId: TEST_ENDPOINT_ID,
      })
    ).rejects.toThrow('Solana chain anchor is not fully verified')
    expect(calls).toHaveLength(2)
    expect(arrayBuffers.every((arrayBuffer) => arrayBuffer.mock.calls.length === 0)).toBe(true)

    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(requireSolanaVerifiedChainAnchor(anchor).finalizedSlot).toBe(SLOT)
  })

  it('never returns raw bytes from an RPC error body that echoes an endpoint secret', async () => {
    const secret = 'private-api-key'
    mockRpc(() => ({
      stream: byteStream(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32_601, message: `method unavailable at ${secret}` },
        })
      ),
    }))
    let error: unknown
    try {
      await captureSolanaVerifiedChainAnchorEvidence({
        rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${secret}`,
        endpointId: 'helius_solana_mainnet',
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(TypeError)
    expect(String(error)).toBe('TypeError: Solana chain anchor is not fully verified')
    expect(String(error)).not.toContain(secret)
  })

  it.each([
    ['decoded short secret', 'k%2F', 'k/'],
    ['encoded short secret', 'k%2F', 'k%2F'],
  ])('rejects a successful response that echoes a %s', async (_label, encodedKey, echo) => {
    mockRpc((request) => ({
      stream: byteStream(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: successfulResult(request),
          providerEcho: echo,
        })
      ),
    }))
    let error: unknown
    try {
      await captureSolanaVerifiedChainAnchorEvidence({
        rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${encodedKey}`,
        endpointId: 'helius_solana_mainnet',
      })
    } catch (caught) {
      error = caught
    }
    expect(String(error)).toBe('TypeError: Solana chain anchor is not fully verified')
    expect(String(error)).not.toContain(echo)
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
        value.finalizedRootSlot.value = 0
      },
      (value) => {
        value.producedSlotResolution.value.producedSlots[0] -= 1
      },
      (value) => {
        value.producedSlotResolution.value.selectedSlot -= 1
      },
      (value) => {
        value.producedSlotResolution.value.selectionPolicy = 'provider_selected'
      },
      (value) => {
        delete value.producedSlotResolution.value.producedSlots[0]
      },
      (value) => {
        value.producedSlotResolution.provider.servedBy.connectionHash = '0'.repeat(64)
        value.producedSlotResolution.provider.attempted[0].connectionHash = '0'.repeat(64)
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
    ['version', 'solana_current_finalized_produced_block_v3'],
    ['genesisMethod', 'getBlock'],
    ['rootSlotMethod', 'getBlockHeight'],
    ['producedSlotsMethod', 'getBlock'],
    ['producedSlotLookback', 511],
    ['minContextSlotPolicy', 'none'],
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
      producedSlotResolution: source.producedSlotResolution,
      finalizedRootSlot: source.finalizedRootSlot,
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

  it('binds the finalized root, full produced-slot list, and endpoint into the semantic hash', async () => {
    mockRpc(() => ({}))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    const expected = requireSolanaVerifiedChainAnchor(anchor)

    const extraProducedSlot = clone(anchor) as any
    extraProducedSlot.producedSlotResolution.value.producedSlots = [SLOT - 1, SLOT]
    expect(requireSolanaVerifiedChainAnchor(extraProducedSlot).semanticHash).not.toBe(
      expected.semanticHash
    )

    const laterRoot = clone(anchor) as any
    laterRoot.finalizedRootSlot.value = SLOT + 1
    laterRoot.producedSlotResolution.value.rangeStartSlot = SLOT + 1 - 512
    laterRoot.producedSlotResolution.value.rangeEndSlot = SLOT + 1
    expect(requireSolanaVerifiedChainAnchor(laterRoot).semanticHash).not.toBe(expected.semanticHash)

    mockRpc(() => ({}))
    const otherEndpointAnchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: 'http://localhost:8899/',
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(requireSolanaVerifiedChainAnchor(otherEndpointAnchor).semanticHash).not.toBe(
      expected.semanticHash
    )
  })

  it('rejects endpoint drift independently in each of the four anchor lanes', async () => {
    mockRpc(() => ({}))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    mockRpc(() => ({}))
    const otherEndpointAnchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: 'http://localhost:8899/',
      endpointId: TEST_ENDPOINT_ID,
    })
    const otherProviders = [
      otherEndpointAnchor.genesisHash,
      otherEndpointAnchor.finalizedRootSlot,
      otherEndpointAnchor.producedSlotResolution,
      otherEndpointAnchor.finalizedBlock,
    ].map((lane) => clone(lane.provider))

    const laneNames = [
      'genesisHash',
      'finalizedRootSlot',
      'producedSlotResolution',
      'finalizedBlock',
    ] as const
    for (const [index, laneName] of laneNames.entries()) {
      const drifted = clone(anchor) as any
      drifted[laneName].provider = otherProviders[index]
      expect(() => requireSolanaVerifiedChainAnchor(drifted)).toThrow(
        'Solana chain anchor is not fully verified'
      )
    }
  })

  it('rejects a forged connection hash for a statically approved remote endpoint', async () => {
    mockRpc(() => ({}))
    const anchor = (await fetchSolanaChainAnchorEvidence({
      rpcUrl: 'https://api.mainnet-beta.solana.com/',
      endpointId: 'solana_official_mainnet',
    })) as any
    for (const lane of [
      anchor.genesisHash,
      anchor.finalizedRootSlot,
      anchor.producedSlotResolution,
      anchor.finalizedBlock,
    ]) {
      lane.provider.servedBy.connectionHash = '0'.repeat(64)
      lane.provider.attempted[0].connectionHash = '0'.repeat(64)
    }
    expect(() => requireSolanaVerifiedChainAnchor(anchor)).toThrow(
      'Solana chain anchor is not fully verified'
    )
  })

  it('pins PublicNode to its exact secret-free root origin and rejects identity forgery', async () => {
    const calls = mockRpc(() => ({}))
    const pendingAnchor = fetchSolanaChainAnchorEvidence({
      rpcUrl: `${PUBLICNODE_SOLANA_ORIGIN}/`,
      endpointId: 'publicnode_solana_mainnet',
    })
    await jest.advanceTimersByTimeAsync(0)
    expect(calls.map(({ request }) => request.method)).toEqual(['getGenesisHash', 'getSlot'])

    await jest.advanceTimersByTimeAsync(19_999)
    expect(calls.map(({ request }) => request.method)).toEqual(['getGenesisHash', 'getSlot'])

    await jest.advanceTimersByTimeAsync(1)
    const anchor = await pendingAnchor
    expect(calls).toHaveLength(4)
    expect(calls.every(({ url }) => url === `${PUBLICNODE_SOLANA_ORIGIN}/`)).toBe(true)
    expect(calls.filter(({ request }) => request.method === 'getBlocks')).toHaveLength(1)
    expect(calls[2].request).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'getBlocks',
      params: [SLOT - 512, SLOT, { commitment: 'finalized', minContextSlot: SLOT }],
    })
    for (const lane of [
      anchor.genesisHash,
      anchor.finalizedRootSlot,
      anchor.producedSlotResolution,
      anchor.finalizedBlock,
    ]) {
      expect(lane.provider).toEqual({
        servedBy: {
          providerId: 'publicnode',
          endpointId: 'publicnode_solana_mainnet',
          connectionHash: PUBLICNODE_SOLANA_CONNECTION_HASH,
        },
        attempted: [
          {
            providerId: 'publicnode',
            endpointId: 'publicnode_solana_mainnet',
            connectionHash: PUBLICNODE_SOLANA_CONNECTION_HASH,
          },
        ],
      })
    }
    expect(requireSolanaVerifiedChainAnchor(anchor).endpoint).toEqual({
      providerId: 'publicnode',
      endpointId: 'publicnode_solana_mainnet',
      connectionHash: PUBLICNODE_SOLANA_CONNECTION_HASH,
    })
    expect(JSON.stringify(anchor)).not.toContain(PUBLICNODE_SOLANA_ORIGIN)

    const forged = clone(anchor) as any
    for (const lane of [
      forged.genesisHash,
      forged.finalizedRootSlot,
      forged.producedSlotResolution,
      forged.finalizedBlock,
    ]) {
      lane.provider.servedBy.connectionHash = '0'.repeat(64)
      lane.provider.attempted[0].connectionHash = '0'.repeat(64)
    }
    expect(() => requireSolanaVerifiedChainAnchor(forged)).toThrow(
      'Solana chain anchor is not fully verified'
    )
  })

  it.each([
    ['official', 'https://api.mainnet-beta.solana.com/', 'solana_official_mainnet'],
    ['local', TEST_RPC_URL, TEST_ENDPOINT_ID],
  ] as const)(
    'does not apply the PublicNode history settle delay to %s RPC',
    async (_label, rpcUrl, endpointId) => {
      const calls = mockRpc(() => ({}))
      const pendingAnchor = fetchSolanaChainAnchorEvidence({ rpcUrl, endpointId })
      await jest.advanceTimersByTimeAsync(0)
      expect(calls.map(({ request }) => request.method)).toEqual([
        'getGenesisHash',
        'getSlot',
        'getBlocks',
        'getBlock',
      ])
      expect(new Date().toISOString()).toBe(FIXED_NOW)
      await expect(pendingAnchor).resolves.toMatchObject({
        finalizedRootSlot: { status: 'available', value: SLOT },
        producedSlotResolution: { status: 'available', value: { selectedSlot: SLOT } },
      })
    }
  )

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
    for (const lane of [
      anchor.genesisHash,
      anchor.finalizedRootSlot,
      anchor.producedSlotResolution,
      anchor.finalizedBlock,
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

  it('rejects mislabeled or exotic raw capture metadata before making a request', async () => {
    const calls = mockRpc(() => ({}))
    const endpoint = resolveEndpoint(
      parseOptsOrThrow({ rpcUrl: TEST_RPC_URL, endpointId: TEST_ENDPOINT_ID })
    )
    expect(endpoint).not.toBeNull()
    await expect(
      solanaEvidenceRpc(endpoint!, 'getSlot', [], 20_000, {
        lane: 'genesis_hash',
      })
    ).rejects.toThrow('invalid Solana raw RPC evidence capture')

    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('private-api-key')
        },
      }
    )
    await expect(
      solanaEvidenceRpc(endpoint!, 'getSlot', [], 20_000, proxy as never)
    ).rejects.toThrow('invalid Solana raw RPC evidence capture')
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
    ['http://solana-rpc.publicnode.com/', 'publicnode_solana_mainnet'],
    ['https://solana-rpc.publicnode.com/private', 'publicnode_solana_mainnet'],
    ['https://solana-rpc.publicnode.com/?key=secret', 'publicnode_solana_mainnet'],
    ['https://solana-rpc.publicnode.com.evil.test/', 'publicnode_solana_mainnet'],
    ['https://user:password@solana-rpc.publicnode.com/', 'publicnode_solana_mainnet'],
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
    expect(calls).toHaveLength(4)
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
    expect(calls).toHaveLength(4)
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
    expect(anchor.finalizedRootSlot.status).toBe('available')
    expect(anchor.producedSlotResolution.status).toBe('available')
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
      expect(anchor.finalizedRootSlot).toMatchObject({
        status: 'unavailable',
        reason: 'malformed_response',
      })
      expect(anchor.producedSlotResolution).toMatchObject({
        status: 'unavailable',
        reason: 'dependency_unavailable',
      })
      expect(anchor.finalizedBlock).toMatchObject({
        status: 'unavailable',
        reason: 'dependency_unavailable',
      })
    }
  )

  it.each([
    ['null', null],
    ['object', {}],
    ['empty list', []],
    ['unordered list', [SLOT, SLOT - 1]],
    ['duplicate slot', [SLOT - 1, SLOT - 1]],
    ['below requested range', [SLOT - 513]],
    ['above finalized root', [SLOT + 1]],
    ['negative slot', [-1]],
    ['fractional slot', [SLOT - 0.5]],
    ['unsafe slot', [Number.MAX_SAFE_INTEGER + 1]],
    ['string slot', [String(SLOT)]],
    ['more than 513 entries', Array.from({ length: 514 }, (_, index) => SLOT - 513 + index)],
  ])('rejects a malformed produced-slot %s without probing getBlock', async (_label, result) => {
    const calls = mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result: request.method === 'getBlocks' ? result : successfulResult(request),
      },
    }))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(calls).toHaveLength(3)
    expect(calls.some(({ request }) => request.method === 'getBlock')).toBe(false)
    expect(anchor.producedSlotResolution).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_response',
    })
    expect(anchor.finalizedBlock).toMatchObject({
      status: 'unavailable',
      reason: 'dependency_unavailable',
    })
    expect(() => requireSolanaVerifiedChainAnchor(anchor)).toThrow(
      'Solana chain anchor is not fully verified'
    )
  })

  it('does not fall back to another slot when getBlocks is unavailable', async () => {
    const calls = mockRpc((request) => ({
      payload:
        request.method === 'getBlocks'
          ? {
              jsonrpc: '2.0',
              id: 1,
              error: { code: -32_601, message: 'getBlocks unavailable private-api-key' },
            }
          : { jsonrpc: '2.0', id: 1, result: successfulResult(request) },
    }))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    expect(calls).toHaveLength(3)
    expect(calls.some(({ request }) => request.method === 'getBlock')).toBe(false)
    expect(anchor.producedSlotResolution).toMatchObject({
      status: 'unavailable',
      reason: 'rpc_error',
      rpcCode: -32_601,
    })
    expect(anchor.finalizedBlock).toMatchObject({
      status: 'unavailable',
      reason: 'dependency_unavailable',
    })
    expect(JSON.stringify(anchor)).not.toContain('private-api-key')
  })

  it('does not probe an older slot when getBlock fails for the selected produced slot', async () => {
    const calls = mockRpc((request) => ({
      payload:
        request.method === 'getBlock'
          ? {
              jsonrpc: '2.0',
              id: 1,
              error: { code: -32_004, message: 'selected block unavailable private-api-key' },
            }
          : {
              jsonrpc: '2.0',
              id: 1,
              result: request.method === 'getBlocks' ? [SLOT - 3, SLOT] : successfulResult(request),
            },
    }))
    const anchor = await fetchSolanaChainAnchorEvidence({
      rpcUrl: TEST_RPC_URL,
      endpointId: TEST_ENDPOINT_ID,
    })
    const blockCalls = calls.filter(({ request }) => request.method === 'getBlock')
    expect(blockCalls).toHaveLength(1)
    expect(blockCalls[0].request.params[0]).toBe(SLOT)
    expect(anchor.producedSlotResolution).toMatchObject({
      status: 'available',
      value: { producedSlots: [SLOT - 3, SLOT], selectedSlot: SLOT },
    })
    expect(anchor.finalizedBlock).toMatchObject({
      status: 'unavailable',
      reason: 'not_found_or_unavailable',
      rpcCode: -32_004,
    })
    expect(JSON.stringify(anchor)).not.toContain('private-api-key')
  })

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
    expect(anchor.finalizedRootSlot).toMatchObject({ status: 'available', value: 0 })
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
    expect(anchor.finalizedRootSlot).toMatchObject({
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
