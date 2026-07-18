import { createHash } from 'node:crypto'
import {
  BSC_MAINNET_CHAIN_ID,
  BSC_MAINNET_GENESIS_HASH,
  captureBscVerifiedTransactionFinalityEvidence,
  fetchBscTransactionMembershipEvidence,
  requireBscVerifiedTransactionFinality,
  type BscChainAnchorEvidence,
  type BscEvidenceEndpointIdentity,
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
  stream?: ReadableStream<Uint8Array>
}

const ZERO_HASH = `0x${'0'.repeat(64)}`
const EMPTY_ROOT = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421'
const TX_HASH = `0x${'ab'.repeat(32)}`
const OTHER_HASH = `0x${'11'.repeat(32)}`
const OTHER_HASH_2 = `0x${'22'.repeat(32)}`
const BLOCK_HASH = `0x${'cd'.repeat(32)}`
const PARENT_HASH = `0x${'bc'.repeat(32)}`
const FINALIZED_HASH = `0x${'ef'.repeat(32)}`
const STATE_ROOT = `0x${'33'.repeat(32)}`
const RECEIPTS_ROOT = `0x${'44'.repeat(32)}`
const TRANSACTIONS_ROOT = `0x${'55'.repeat(32)}`
function connectionHash(providerId: string, endpointId: string, rpcOrigin: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['bsc_evidence_connection_v1', providerId, endpointId, rpcOrigin]))
    .digest('hex')
}

const TEST_RPC_ORIGIN = 'http://127.0.0.1:8545'
const TEST_RPC_URL = `${TEST_RPC_ORIGIN}/`
const TEST_ENDPOINT = {
  providerId: 'local',
  endpointId: 'local_bsc_node',
  connectionHash: connectionHash('local', 'local_bsc_node', TEST_RPC_ORIGIN),
} as const
const FIXED_NOW = '2026-07-16T19:32:00.000Z'

function provider(endpoint: BscEvidenceEndpointIdentity) {
  return { servedBy: { ...endpoint }, attempted: [{ ...endpoint }] }
}

function available<T>(value: T, endpoint: BscEvidenceEndpointIdentity) {
  return { status: 'available' as const, value, provider: provider(endpoint), httpStatus: 200 }
}

function blockHeader(overrides: Record<string, unknown> = {}) {
  return {
    number: '0x123',
    hash: BLOCK_HASH,
    parentHash: PARENT_HASH,
    timestamp: '0x6a593000',
    stateRoot: STATE_ROOT,
    transactionsRoot: TRANSACTIONS_ROOT,
    receiptsRoot: RECEIPTS_ROOT,
    ...overrides,
  }
}

function anchorFixture(
  endpoint: BscEvidenceEndpointIdentity = TEST_ENDPOINT
): BscChainAnchorEvidence {
  const genesis = {
    number: '0x0',
    hash: BSC_MAINNET_GENESIS_HASH,
    parentHash: ZERO_HASH,
    timestamp: '0x5e9da7ce',
    stateRoot: '0x919fcc7ad870b53db0aa76eb588da06bacb6d230195100699fc928511003b422',
    transactionsRoot: EMPTY_ROOT,
    receiptsRoot: EMPTY_ROOT,
  }
  const finalized = blockHeader({
    number: '0x200',
    hash: FINALIZED_HASH,
    parentHash: `0x${'ee'.repeat(32)}`,
    timestamp: '0x6a59319a',
  })
  return {
    chain: { namespace: 'eip155', reference: '56' },
    observedAt: FIXED_NOW,
    finalityPolicy: {
      version: 'bsc_standard_finalized_current_v1',
      method: 'eth_getBlockByNumber',
      blockTag: 'finalized',
      headBlockTag: 'latest',
      fullTransactions: false,
      maxFutureBlockSkewMs: 60_000,
      maxCurrentAnchorLagMs: 900_000,
    },
    chainId: available(BSC_MAINNET_CHAIN_ID, endpoint),
    genesisBlock: available(genesis, endpoint),
    finalizedBlock: available(finalized, endpoint),
    headBlock: available(finalized, endpoint),
  }
}

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    hash: TX_HASH,
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    input: '0xABCDEF12',
    value: '0xA',
    blockNumber: '0x123',
    blockHash: BLOCK_HASH,
    transactionIndex: '0x1',
    ...overrides,
  }
}

function receiptLog(overrides: Record<string, unknown> = {}) {
  return {
    address: '0x3333333333333333333333333333333333333333',
    topics: [`0x${'AA'.repeat(32)}`],
    data: '0xBEEF',
    blockNumber: '0x123',
    transactionHash: TX_HASH,
    transactionIndex: '0x1',
    blockHash: BLOCK_HASH,
    logIndex: '0x7',
    removed: false,
    ...overrides,
  }
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    transactionHash: TX_HASH,
    transactionIndex: '0x1',
    blockNumber: '0x123',
    blockHash: BLOCK_HASH,
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    status: '0x1',
    logs: [receiptLog()],
    ...overrides,
  }
}

function canonicalBlock(overrides: Record<string, unknown> = {}) {
  return {
    ...blockHeader(),
    transactions: [OTHER_HASH, TX_HASH, OTHER_HASH_2],
    ...overrides,
  }
}

function successfulPayload(request: RpcRequest): unknown {
  if (request.method === 'eth_getTransactionByHash') return transaction()
  if (request.method === 'eth_getTransactionReceipt') return receipt()
  if (request.method === 'eth_getBlockByNumber') return canonicalBlock()
  return transaction()
}

function successfulResponseBody(request: RpcRequest): string {
  const result = successfulPayload(request)
  return `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result:
      typeof result === 'object' && result !== null
        ? { ...result, providerOnlyRaw: '链上原始字段' }
        : result,
    providerNote: '链上原始信封',
  })}\n`
}

function byteStream(body: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(body)
  const markerIndex = Buffer.from(bytes).indexOf(Buffer.from('链', 'utf8'))
  const split = markerIndex >= 0 ? markerIndex + 1 : Math.max(1, bytes.byteLength - 1)
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

function mockRpc(handler: (request: RpcRequest) => MockReply = () => ({})): RpcRequest[] {
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
      headers: { get: () => null },
      body: reply.stream,
      text: async () => reply.body ?? JSON.stringify(payload),
    } as Response
  }) as jest.MockedFunction<typeof fetch>
  return requests
}

describe('fetchBscTransactionMembershipEvidence', () => {
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

  it('captures tx, receipt, canonical block, and indexed tx from the anchor endpoint', async () => {
    const requests = mockRpc()
    const evidence = await fetchBscTransactionMembershipEvidence(
      `0x${'AB'.repeat(32)}`,
      anchorFixture(),
      { rpcUrl: TEST_RPC_URL, endpointId: 'local_bsc_node' }
    )

    expect(requests).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [TX_HASH] },
      { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [TX_HASH] },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBlockByNumber',
        params: ['0x123', false],
      },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionByBlockNumberAndIndex',
        params: ['0x123', '0x1'],
      },
    ])
    expect(evidence).toMatchObject({
      chain: { namespace: 'eip155', reference: '56' },
      txHash: TX_HASH,
      capturedAt: FIXED_NOW,
      membershipPolicy: { version: 'bsc_transaction_membership_v1' },
      anchor: {
        endpoint: TEST_ENDPOINT,
        verifiedAnchorHash: '85a2b4805b011417ca202dd853532591a0c92f721209bf7d001fad63d3992525',
        verifiedAnchorHashPolicy: 'bsc_verified_anchor_semantics_v1',
        observedAt: FIXED_NOW,
        finalizedBlock: { number: '0x200', hash: FINALIZED_HASH },
      },
      transaction: {
        status: 'available',
        value: { hash: TX_HASH, input: '0xabcdef12', value: '0xa', transactionIndex: '0x1' },
      },
      receipt: {
        status: 'available',
        value: {
          status: '0x1',
          logs: [{ topics: [`0x${'aa'.repeat(32)}`], data: '0xbeef', removed: false }],
        },
      },
      canonicalBlock: {
        status: 'available',
        value: {
          number: '0x123',
          hash: BLOCK_HASH,
          transactions: [OTHER_HASH, TX_HASH, OTHER_HASH_2],
        },
      },
      indexedTransaction: { status: 'available', value: { hash: TX_HASH } },
    })
    expect(
      (global.fetch as jest.Mock).mock.calls.every(([, init]) => init.redirect === 'error')
    ).toBe(true)
    expect(JSON.stringify(evidence)).not.toContain('private-api-key')
    expect(JSON.stringify(evidence)).not.toContain('127.0.0.1')

    const verified = requireBscVerifiedTransactionFinality(
      JSON.parse(JSON.stringify(evidence)),
      JSON.parse(JSON.stringify(anchorFixture()))
    )
    expect(verified).toMatchObject({
      txHash: TX_HASH,
      transaction: { value: '0xa', transactionIndex: '0x1' },
      receipt: { status: '0x1' },
      canonicalBlock: { number: '0x123', hash: BLOCK_HASH },
      indexedTransaction: { hash: TX_HASH },
    })
  })

  it('captures four exact transaction exchanges without widening normalized facts', async () => {
    const requests = mockRpc((request) => ({
      stream: byteStream(successfulResponseBody(request)),
    }))
    const captured = await captureBscVerifiedTransactionFinalityEvidence(TX_HASH, anchorFixture(), {
      rpcUrl: TEST_RPC_URL,
      endpointId: 'local_bsc_node',
    })

    expect(captured.verified).toMatchObject({
      txHash: TX_HASH,
      receipt: { status: '0x1' },
      canonicalBlock: { hash: BLOCK_HASH },
    })
    expect(captured.rawExchanges.map(({ lane }) => lane)).toEqual([
      'transaction',
      'receipt',
      'membership_block',
      'indexed_transaction',
    ])
    const fetchCalls = (global.fetch as jest.Mock).mock.calls
    expect(captured.rawExchanges).toHaveLength(fetchCalls.length)
    const expectedMethods = [
      'eth_getTransactionByHash',
      'eth_getTransactionReceipt',
      'eth_getBlockByNumber',
      'eth_getTransactionByBlockNumberAndIndex',
    ]
    for (const [index, exchange] of captured.rawExchanges.entries()) {
      const requestBody = String(fetchCalls[index][1].body)
      const responseBody = successfulResponseBody(requests[index])
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
      expect(exchange.completedAt).toBe(FIXED_NOW)
      expect(exchange.httpStatus).toBe(200)
      expect(exchange.chain).toBe('bsc')
      expect(exchange.trustBoundary).toBe(
        'json_rpc_result_transport_only_semantic_lane_not_yet_verified'
      )
      expect(exchange.endpoint).toEqual(TEST_ENDPOINT)
      expect(exchange).not.toHaveProperty('url')
    }
    expect(JSON.stringify(captured.evidence)).not.toContain('providerOnlyRaw')
    expect(JSON.stringify(captured.evidence)).not.toContain('providerNote')
    const rawTransaction = Buffer.from(captured.rawExchanges[0].response.bytes).toString('utf8')
    expect(rawTransaction).toContain('providerOnlyRaw')
    expect(rawTransaction).toContain('链上原始字段')
  })

  it('fails exact transaction capture closed for text-only transport while preserving normal fetch', async () => {
    const requests = mockRpc()
    await expect(
      captureBscVerifiedTransactionFinalityEvidence(TX_HASH, anchorFixture(), {
        rpcUrl: TEST_RPC_URL,
        endpointId: 'local_bsc_node',
      })
    ).rejects.toThrow('BSC transaction finality evidence is not fully verified')
    expect(requests).toHaveLength(2)

    const evidence = await fetchBscTransactionMembershipEvidence(TX_HASH, anchorFixture(), {
      rpcUrl: TEST_RPC_URL,
      endpointId: 'local_bsc_node',
    })
    expect(requireBscVerifiedTransactionFinality(evidence, anchorFixture()).txHash).toBe(TX_HASH)
    expect(evidence).not.toHaveProperty('rawExchanges')
  })

  it('returns no partial raw capture when a dependent membership lane fails', async () => {
    const secret = 'private-api-key'
    const requests = mockRpc((request) => ({
      stream: byteStream(
        request.method === 'eth_getBlockByNumber'
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
      await captureBscVerifiedTransactionFinalityEvidence(TX_HASH, anchorFixture(), {
        rpcUrl: TEST_RPC_URL,
        endpointId: 'local_bsc_node',
      })
    } catch (caught) {
      error = caught
    }
    expect(requests).toHaveLength(4)
    expect(String(error)).toBe('TypeError: BSC transaction finality evidence is not fully verified')
    expect(String(error)).not.toContain(secret)
  })

  it('rejects complete raw transaction lanes whose normalized facts contradict', async () => {
    const requests = mockRpc((request) => {
      const result =
        request.method === 'eth_getTransactionByHash'
          ? transaction({ value: '0xb' })
          : successfulPayload(request)
      return {
        stream: byteStream(JSON.stringify({ jsonrpc: '2.0', id: 1, result })),
      }
    })
    await expect(
      captureBscVerifiedTransactionFinalityEvidence(TX_HASH, anchorFixture(), {
        rpcUrl: TEST_RPC_URL,
        endpointId: 'local_bsc_node',
      })
    ).rejects.toThrow('BSC transaction finality evidence is not fully verified')
    expect(requests).toHaveLength(4)
  })

  it('retains a reverted receipt as non-success evidence and rejects reverted logs', async () => {
    mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result:
          request.method === 'eth_getTransactionReceipt'
            ? receipt({ status: '0x0', logs: [] })
            : successfulPayload(request),
      },
    }))
    const reverted = await fetchBscTransactionMembershipEvidence(TX_HASH, anchorFixture(), {
      rpcUrl: TEST_RPC_URL,
      endpointId: 'local_bsc_node',
    })
    expect(reverted.receipt).toMatchObject({
      status: 'available',
      value: { status: '0x0', logs: [] },
    })
    expect(JSON.stringify(reverted)).not.toContain('isHit')
    expect(JSON.stringify(reverted)).not.toContain('success')
    expect(requireBscVerifiedTransactionFinality(reverted, anchorFixture()).receipt.status).toBe(
      '0x0'
    )

    mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result:
          request.method === 'eth_getTransactionReceipt'
            ? receipt({ status: '0x0' })
            : successfulPayload(request),
      },
    }))
    const impossibleLogs = await fetchBscTransactionMembershipEvidence(TX_HASH, anchorFixture(), {
      rpcUrl: TEST_RPC_URL,
      endpointId: 'local_bsc_node',
    })
    expect(impossibleLogs.receipt).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_response',
    })
    expect(impossibleLogs.canonicalBlock).toMatchObject({
      status: 'unavailable',
      reason: 'dependency_unavailable',
    })
  })

  it('fails closed on serialized artifact drift across every membership boundary', async () => {
    mockRpc()
    const anchor = anchorFixture()
    const evidence = await fetchBscTransactionMembershipEvidence(TX_HASH, anchor, {
      rpcUrl: TEST_RPC_URL,
      endpointId: 'local_bsc_node',
    })
    const attacks: Array<(value: any) => void> = [
      (value) => {
        value.secret = 'private-api-key'
      },
      (value) => {
        value.txHash = OTHER_HASH
      },
      (value) => {
        value.capturedAt = '2026-07-16T19:30:59.999Z'
      },
      (value) => {
        value.membershipPolicy.version = 'bsc_transaction_membership_v2'
      },
      (value) => {
        value.anchor.verifiedAnchorHash = '0'.repeat(64)
      },
      (value) => {
        value.anchor.finalizedBlock.hash = OTHER_HASH
      },
      (value) => {
        value.transaction.value.secret = 'private-api-key'
      },
      (value) => {
        value.transaction.value.value = '0x0a'
      },
      (value) => {
        value.transaction.value.blockNumber = '0x124'
      },
      (value) => {
        value.receipt.value.blockHash = OTHER_HASH
      },
      (value) => {
        value.receipt.value.blockNumber = '0x124'
      },
      (value) => {
        value.receipt.value.transactionIndex = '0x2'
      },
      (value) => {
        value.receipt.value.from = '0x4444444444444444444444444444444444444444'
      },
      (value) => {
        value.receipt.value.status = '0x2'
      },
      (value) => {
        value.receipt.value.logs[0].transactionIndex = '0x2'
      },
      (value) => {
        value.indexedTransaction.value.input = '0x'
      },
      (value) => {
        value.indexedTransaction.value.value = '0xb'
      },
      (value) => {
        value.indexedTransaction.value.blockHash = OTHER_HASH
      },
      (value) => {
        value.indexedTransaction.value.transactionIndex = '0x2'
      },
      (value) => {
        value.canonicalBlock.value.hash = OTHER_HASH
      },
      (value) => {
        value.canonicalBlock.value.number = '0x124'
      },
      (value) => {
        value.canonicalBlock.value.transactions[1] = OTHER_HASH
      },
      (value) => {
        value.canonicalBlock.value.transactions = [TX_HASH]
      },
      (value) => {
        value.transaction.httpStatus = null
      },
      (value) => {
        value.transaction.provider.servedBy.connectionHash = '0'.repeat(64)
        value.transaction.provider.attempted[0].connectionHash = '0'.repeat(64)
      },
    ]
    for (const mutate of attacks) {
      const attacked = JSON.parse(JSON.stringify(evidence))
      mutate(attacked)
      expect(() => requireBscVerifiedTransactionFinality(attacked, anchor)).toThrow(
        'BSC transaction finality evidence is not fully verified'
      )
    }
  })

  it('accepts an exact finalized-height block and rejects finality contradictions', async () => {
    mockRpc()
    const anchor = anchorFixture()
    const evidence = await fetchBscTransactionMembershipEvidence(TX_HASH, anchor, {
      rpcUrl: TEST_RPC_URL,
      endpointId: 'local_bsc_node',
    })
    const sameHeight = JSON.parse(JSON.stringify(evidence))
    if (anchor.finalizedBlock.status !== 'available') throw new Error('fixture anchor unavailable')
    const finalizedHeader = anchor.finalizedBlock.value
    for (const lane of [
      sameHeight.transaction,
      sameHeight.receipt,
      sameHeight.indexedTransaction,
    ]) {
      lane.value.blockNumber = finalizedHeader.number
      lane.value.blockHash = finalizedHeader.hash
    }
    for (const log of sameHeight.receipt.value.logs) {
      log.blockNumber = finalizedHeader.number
      log.blockHash = finalizedHeader.hash
    }
    Object.assign(sameHeight.canonicalBlock.value, finalizedHeader)
    expect(requireBscVerifiedTransactionFinality(sameHeight, anchor).canonicalBlock).toMatchObject({
      number: '0x200',
      hash: FINALIZED_HASH,
    })
    const exactClockSkewBoundary = JSON.parse(JSON.stringify(evidence))
    exactClockSkewBoundary.capturedAt = '2026-07-16T19:31:00.000Z'
    expect(requireBscVerifiedTransactionFinality(exactClockSkewBoundary, anchor).capturedAt).toBe(
      '2026-07-16T19:31:00.000Z'
    )
    const sameHeightRootDrift = JSON.parse(JSON.stringify(sameHeight))
    sameHeightRootDrift.canonicalBlock.value.stateRoot = OTHER_HASH
    expect(() => requireBscVerifiedTransactionFinality(sameHeightRootDrift, anchor)).toThrow(
      'BSC transaction finality evidence is not fully verified'
    )

    const aboveFinalized = JSON.parse(JSON.stringify(evidence))
    for (const lane of [
      aboveFinalized.transaction,
      aboveFinalized.receipt,
      aboveFinalized.indexedTransaction,
    ]) {
      lane.value.blockNumber = '0x201'
    }
    for (const log of aboveFinalized.receipt.value.logs) log.blockNumber = '0x201'
    aboveFinalized.canonicalBlock.value.number = '0x201'
    expect(() => requireBscVerifiedTransactionFinality(aboveFinalized, anchor)).toThrow(
      'BSC transaction finality evidence is not fully verified'
    )

    const reusedFinalizedHash = JSON.parse(JSON.stringify(evidence))
    for (const lane of [
      reusedFinalizedHash.transaction,
      reusedFinalizedHash.receipt,
      reusedFinalizedHash.indexedTransaction,
    ]) {
      lane.value.blockHash = FINALIZED_HASH
    }
    for (const log of reusedFinalizedHash.receipt.value.logs) log.blockHash = FINALIZED_HASH
    reusedFinalizedHash.canonicalBlock.value.hash = FINALIZED_HASH
    expect(() => requireBscVerifiedTransactionFinality(reusedFinalizedHash, anchor)).toThrow(
      'BSC transaction finality evidence is not fully verified'
    )

    const laterTimestamp = JSON.parse(JSON.stringify(evidence))
    laterTimestamp.canonicalBlock.value.timestamp = '0x6a59319b'
    expect(() => requireBscVerifiedTransactionFinality(laterTimestamp, anchor)).toThrow(
      'BSC transaction finality evidence is not fully verified'
    )
  })

  it('rejects accessors, exotic arrays, proxies, and a different valid anchor', async () => {
    mockRpc()
    const anchor = anchorFixture()
    const evidence = await fetchBscTransactionMembershipEvidence(TX_HASH, anchor, {
      rpcUrl: TEST_RPC_URL,
      endpointId: 'local_bsc_node',
    })

    const accessor = JSON.parse(JSON.stringify(evidence))
    Object.defineProperty(accessor.transaction.value, 'input', {
      enumerable: true,
      get: () => '0xabcdef12',
    })
    expect(() => requireBscVerifiedTransactionFinality(accessor, anchor)).toThrow(
      'BSC transaction finality evidence is not fully verified'
    )

    const sparse = JSON.parse(JSON.stringify(evidence))
    delete sparse.canonicalBlock.value.transactions[1]
    expect(() => requireBscVerifiedTransactionFinality(sparse, anchor)).toThrow(
      'BSC transaction finality evidence is not fully verified'
    )

    const exotic = JSON.parse(JSON.stringify(evidence))
    Object.setPrototypeOf(exotic.receipt.value.logs, {})
    expect(() => requireBscVerifiedTransactionFinality(exotic, anchor)).toThrow(
      'BSC transaction finality evidence is not fully verified'
    )

    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('private-api-key')
        },
      }
    )
    expect(() => requireBscVerifiedTransactionFinality(proxy, anchor)).toThrow(
      'BSC transaction finality evidence is not fully verified'
    )

    const differentAnchor = JSON.parse(JSON.stringify(anchor))
    for (const lane of [differentAnchor.finalizedBlock, differentAnchor.headBlock]) {
      lane.value.hash = OTHER_HASH_2
    }
    expect(() => requireBscVerifiedTransactionFinality(evidence, differentAnchor)).toThrow(
      'BSC transaction finality evidence is not fully verified'
    )
  })

  it.each([
    ['null status', { status: null }],
    ['non-binary status', { status: '0x2' }],
    ['non-canonical index', { transactionIndex: '0x01' }],
    ['wrong log transaction', { logs: [receiptLog({ transactionHash: OTHER_HASH })] }],
    ['removed log', { logs: [receiptLog({ removed: true })] }],
    [
      'non-increasing logs',
      { logs: [receiptLog({ logIndex: '0x8' }), receiptLog({ logIndex: '0x7' })] },
    ],
  ])('fails closed on a malformed receipt: %s', async (_label, overrides) => {
    const requests = mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result:
          request.method === 'eth_getTransactionReceipt'
            ? receipt(overrides)
            : successfulPayload(request),
      },
    }))
    const evidence = await fetchBscTransactionMembershipEvidence(TX_HASH, anchorFixture(), {
      rpcUrl: TEST_RPC_URL,
      endpointId: 'local_bsc_node',
    })
    expect(requests).toHaveLength(2)
    expect(evidence.receipt).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_response',
    })
    expect(evidence.indexedTransaction).toMatchObject({
      status: 'unavailable',
      reason: 'dependency_unavailable',
    })
  })

  it.each([
    ['missing value', { value: undefined }],
    ['pending', { blockNumber: null, blockHash: null, transactionIndex: null }],
    [
      'malformed pending',
      { hash: OTHER_HASH, blockNumber: null, blockHash: null, transactionIndex: null },
    ],
    ['bad input', { input: '0x123' }],
    ['non-canonical index', { transactionIndex: '0x01' }],
  ])(
    'keeps malformed or pending transaction evidence unavailable: %s',
    async (_label, overrides) => {
      mockRpc((request) => ({
        payload: {
          jsonrpc: '2.0',
          id: 1,
          result:
            request.method === 'eth_getTransactionByHash'
              ? transaction(overrides)
              : successfulPayload(request),
        },
      }))
      const evidence = await fetchBscTransactionMembershipEvidence(TX_HASH, anchorFixture(), {
        rpcUrl: TEST_RPC_URL,
        endpointId: 'local_bsc_node',
      })
      expect(evidence.transaction).toMatchObject({
        status: 'unavailable',
        reason: _label === 'pending' ? 'pending' : 'malformed_response',
      })
      expect(evidence.receipt.status).toBe('available')
    }
  )

  it('does not issue membership lookups when the receipt is absent', async () => {
    const requests = mockRpc((request) => ({
      payload: {
        jsonrpc: '2.0',
        id: 1,
        result: request.method === 'eth_getTransactionReceipt' ? null : transaction(),
      },
    }))
    const evidence = await fetchBscTransactionMembershipEvidence(TX_HASH, anchorFixture(), {
      rpcUrl: TEST_RPC_URL,
      endpointId: 'local_bsc_node',
    })
    expect(requests).toHaveLength(2)
    expect(evidence.receipt).toMatchObject({
      status: 'unavailable',
      reason: 'not_found_or_unindexed',
    })
    expect(evidence.canonicalBlock).toMatchObject({
      status: 'unavailable',
      reason: 'dependency_unavailable',
    })
  })

  it('rejects malformed block transaction arrays and wrong indexed hashes', async () => {
    mockRpc((request) => {
      if (request.method === 'eth_getBlockByNumber') {
        return {
          payload: {
            jsonrpc: '2.0',
            id: 1,
            result: canonicalBlock({ transactions: [TX_HASH, TX_HASH] }),
          },
        }
      }
      if (request.method === 'eth_getTransactionByBlockNumberAndIndex') {
        return {
          payload: { jsonrpc: '2.0', id: 1, result: transaction({ hash: OTHER_HASH }) },
        }
      }
      return {}
    })
    const evidence = await fetchBscTransactionMembershipEvidence(TX_HASH, anchorFixture(), {
      rpcUrl: TEST_RPC_URL,
      endpointId: 'local_bsc_node',
    })
    expect(evidence.canonicalBlock).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_response',
    })
    expect(evidence.indexedTransaction).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_response',
    })
  })

  it('sanitizes RPC failures without discarding other available lanes', async () => {
    const secret = 'private-api-key'
    mockRpc((request) =>
      request.method === 'eth_getTransactionByHash'
        ? {
            payload: {
              jsonrpc: '2.0',
              id: 1,
              error: { code: -32000, message: `failed at ${secret}` },
            },
          }
        : {}
    )
    const evidence = await fetchBscTransactionMembershipEvidence(TX_HASH, anchorFixture(), {
      rpcUrl: TEST_RPC_URL,
      endpointId: 'local_bsc_node',
    })
    expect(evidence.transaction).toMatchObject({ status: 'unavailable', reason: 'rpc_error' })
    expect(evidence.receipt.status).toBe('available')
    expect(evidence.canonicalBlock.status).toBe('available')
    expect(JSON.stringify(evidence)).not.toContain(secret)
  })

  it('rejects invalid hash, anchor, options, or endpoint mismatch before any RPC', async () => {
    const requests = mockRpc()
    await expect(
      fetchBscTransactionMembershipEvidence('0x1234', anchorFixture(), {
        rpcUrl: TEST_RPC_URL,
        endpointId: 'local_bsc_node',
      })
    ).rejects.toThrow('txHash must be a 0x-prefixed 32-byte hex string')

    const invalidAnchor = { ...anchorFixture(), secret: 'private-api-key' }
    await expect(
      fetchBscTransactionMembershipEvidence(TX_HASH, invalidAnchor, {
        rpcUrl: TEST_RPC_URL,
        endpointId: 'local_bsc_node',
      })
    ).rejects.toThrow('BSC chain anchor is not fully verified')

    await expect(
      fetchBscTransactionMembershipEvidence(TX_HASH, anchorFixture(), {
        rpcUrl: 'http://127.0.0.1:9545/',
        endpointId: 'local_bsc_node',
      })
    ).rejects.toThrow('BSC transaction membership endpoint does not match anchor')

    await expect(
      fetchBscTransactionMembershipEvidence(TX_HASH, anchorFixture(), {
        rpcUrl: 'http://127.0.0.1:8545/private-api-key',
        endpointId: 'local_bsc_node',
      })
    ).rejects.toThrow('BSC transaction membership endpoint is unavailable')

    const officialEndpoint = {
      providerId: 'bnb_chain',
      endpointId: 'bnb_official_public_seed',
      connectionHash: connectionHash(
        'bnb_chain',
        'bnb_official_public_seed',
        'https://bsc-dataseed.bnbchain.org'
      ),
    } as const
    await expect(
      fetchBscTransactionMembershipEvidence(TX_HASH, anchorFixture(officialEndpoint), {
        rpcUrl: TEST_RPC_URL,
        endpointId: 'local_bsc_node',
      })
    ).rejects.toThrow('BSC transaction membership endpoint does not match anchor')

    await expect(
      fetchBscTransactionMembershipEvidence(TX_HASH, anchorFixture(), {
        rpcUrl: TEST_RPC_URL,
        endpointId: 'local_bsc_node',
        extra: 'private-api-key',
      } as never)
    ).rejects.toThrow('invalid BSC evidence options')
    expect(requests).toHaveLength(0)
  })
})
