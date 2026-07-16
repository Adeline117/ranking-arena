import { fetchBscTransactionEvidence, scanWalletTransfers } from '../bsc-fetch'

interface RpcRequest {
  method: string
  params: [
    {
      fromAddress?: string
      toAddress?: string
      pageKey?: string
      maxCount: string
    },
  ]
}

interface TransferPage {
  transfers: Array<Record<string, unknown>>
  pageKey?: string
}

function transfer(id: string, blockTimestamp = '2026-07-15T00:00:00.000Z') {
  return {
    hash: id,
    from: '0xfrom',
    to: '0xto',
    value: 1,
    asset: 'TOKEN',
    rawContract: { address: '0xtoken' },
    metadata: { blockTimestamp },
  }
}

function mockRpc(handler: (request: RpcRequest) => TransferPage | undefined): RpcRequest[] {
  const requests: RpcRequest[] = []
  global.fetch = jest.fn(async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest
    requests.push(request)
    return {
      text: async () => JSON.stringify({ result: handler(request) }),
    } as Response
  }) as jest.MockedFunction<typeof fetch>
  return requests
}

describe('scanWalletTransfers', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    if (originalFetch) global.fetch = originalFetch
    else delete (global as typeof global & { fetch?: typeof fetch }).fetch
  })

  it('proves both directions complete when each cursor is exhausted', async () => {
    mockRpc((request) => ({
      transfers: [transfer(request.params[0].fromAddress ? 'from' : 'to')],
    }))

    const scan = await scanWalletTransfers('0xwallet', {
      rpcUrls: ['https://rpc.invalid'],
      maxPages: 2,
    })

    expect(scan.transfers.map((row) => row.tx)).toEqual(['from', 'to'])
    expect(scan.coverage.scanComplete).toBe(true)
    expect(scan.coverage.truncated).toBe(false)
    expect(scan.coverage.fromAddress.stopReason).toBe('history_exhausted')
    expect(scan.coverage.toAddress.stopReason).toBe('history_exhausted')
  })

  it('tracks lookback completion independently by direction', async () => {
    mockRpc((request) =>
      request.params[0].fromAddress
        ? {
            transfers: [
              transfer('inside', '2026-07-15T00:00:00.000Z'),
              transfer('outside', '2026-07-01T00:00:00.000Z'),
            ],
            pageKey: 'unused',
          }
        : { transfers: [] }
    )

    const scan = await scanWalletTransfers('0xwallet', {
      rpcUrls: ['https://rpc.invalid'],
      sinceMs: Date.parse('2026-07-10T00:00:00.000Z'),
      maxPages: 2,
    })

    expect(scan.transfers.map((row) => row.tx)).toEqual(['inside'])
    expect(scan.coverage.fromAddress.stopReason).toBe('lookback_boundary')
    expect(scan.coverage.toAddress.stopReason).toBe('history_exhausted')
    expect(scan.coverage.scanComplete).toBe(true)
  })

  it('marks one direction hitting maxPages as overall truncation', async () => {
    mockRpc((request) =>
      request.params[0].fromAddress
        ? { transfers: [transfer('from')], pageKey: 'next' }
        : { transfers: [] }
    )

    const scan = await scanWalletTransfers('0xwallet', {
      rpcUrls: ['https://rpc.invalid'],
      maxPages: 1,
    })

    expect(scan.coverage.fromAddress).toMatchObject({
      scanComplete: false,
      truncated: true,
      stopReason: 'page_cap',
      pagesFetched: 1,
    })
    expect(scan.coverage.toAddress.scanComplete).toBe(true)
    expect(scan.coverage.scanComplete).toBe(false)
    expect(scan.coverage.truncated).toBe(true)
  })

  it('does not claim completeness when a transfer timestamp is missing', async () => {
    const missingTimestamp = transfer('missing')
    delete (missingTimestamp as { metadata?: unknown }).metadata
    mockRpc((request) =>
      request.params[0].fromAddress
        ? { transfers: [missingTimestamp, transfer('invalid-time', 'not-a-date')] }
        : { transfers: [] }
    )

    const scan = await scanWalletTransfers('0xwallet', {
      rpcUrls: ['https://rpc.invalid'],
      maxPages: 1,
    })

    expect(scan.coverage.fromAddress).toMatchObject({
      scanComplete: false,
      truncated: false,
      stopReason: 'history_exhausted',
      recordsMissingTimestamp: 2,
    })
    expect(scan.coverage.scanComplete).toBe(false)
  })

  it('uses the provider pageKey independently for each direction', async () => {
    const requests = mockRpc((request) => {
      if (!request.params[0].pageKey) {
        return { transfers: [transfer('page-1')], pageKey: 'next-page' }
      }
      return { transfers: [transfer('page-2')] }
    })

    const scan = await scanWalletTransfers('0xwallet', {
      rpcUrls: ['https://rpc.invalid'],
      maxPages: 2,
    })

    expect(requests).toHaveLength(4)
    expect(requests[1].params[0].pageKey).toBe('next-page')
    expect(requests[3].params[0].pageKey).toBe('next-page')
    expect(scan.coverage.fromAddress.pagesFetched).toBe(2)
    expect(scan.coverage.toAddress.pagesFetched).toBe(2)
  })

  it('rejects a malformed transfer payload instead of claiming exhaustion', async () => {
    mockRpc(() => undefined)
    await expect(
      scanWalletTransfers('0xwallet', {
        rpcUrls: ['https://rpc.invalid'],
        maxPages: 1,
      })
    ).rejects.toThrow('invalid result')
  })

  it.each([0, -1, Number.NaN, 1.5])('rejects invalid maxPages=%s', async (maxPages) => {
    const requests = mockRpc(() => ({ transfers: [] }))
    await expect(
      scanWalletTransfers('0xwallet', { rpcUrls: ['https://rpc.invalid'], maxPages })
    ).rejects.toThrow('maxPages must be a positive safe integer')
    expect(requests).toHaveLength(0)
  })
})

describe('fetchBscTransactionEvidence', () => {
  const originalFetch = global.fetch
  const TX_HASH = `0x${'ab'.repeat(32)}`
  const BLOCK_HASH = `0x${'cd'.repeat(32)}`

  interface PointRpcRequest {
    method: string
    params: [string]
  }

  function mockPointRpc(
    handler: (request: PointRpcRequest) => { result?: unknown; error?: { message: string } }
  ): PointRpcRequest[] {
    const requests: PointRpcRequest[] = []
    global.fetch = jest.fn(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as PointRpcRequest
      requests.push(request)
      return {
        text: async () => JSON.stringify(handler(request)),
      } as Response
    }) as jest.MockedFunction<typeof fetch>
    return requests
  }

  const transaction = {
    hash: TX_HASH,
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    input: '0x12345678',
    blockNumber: '0x123',
    blockHash: BLOCK_HASH,
  }
  const receipt = {
    transactionHash: TX_HASH,
    status: '0x1',
    blockNumber: '0x123',
    blockHash: BLOCK_HASH,
    logs: [
      {
        address: '0x3333333333333333333333333333333333333333',
        topics: [`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`],
        data: '0x42',
        logIndex: '0x7',
      },
    ],
  }

  afterEach(() => {
    if (originalFetch) global.fetch = originalFetch
    else delete (global as typeof global & { fetch?: typeof fetch }).fetch
  })

  it('fetches transaction and receipt point evidence without classifying it', async () => {
    const requests = mockPointRpc((request) => ({
      result: request.method === 'eth_getTransactionByHash' ? transaction : receipt,
    }))

    const evidence = await fetchBscTransactionEvidence(TX_HASH.toUpperCase().replace('0X', '0x'), {
      rpcUrls: ['https://rpc.invalid/secret-key'],
    })

    expect(requests.map(({ method }) => method).sort()).toEqual([
      'eth_getTransactionByHash',
      'eth_getTransactionReceipt',
    ])
    expect(requests.every(({ params }) => params[0] === TX_HASH)).toBe(true)
    expect(evidence).toEqual({
      txHash: TX_HASH,
      transaction,
      receipt,
      unresolved: { transaction: null, receipt: null },
    })
    expect(JSON.stringify(evidence)).not.toContain('secret-key')
  })

  it('retains a reverted receipt and its logs', async () => {
    mockPointRpc((request) => ({
      result:
        request.method === 'eth_getTransactionByHash' ? transaction : { ...receipt, status: '0x0' },
    }))

    const evidence = await fetchBscTransactionEvidence(TX_HASH, {
      rpcUrls: ['https://rpc.invalid'],
    })

    expect(evidence.receipt?.status).toBe('0x0')
    expect(evidence.receipt?.logs).toEqual(receipt.logs)
    expect(evidence.unresolved.receipt).toBeNull()
  })

  it('distinguishes not-found and invalid responses with explicit nulls', async () => {
    mockPointRpc((request) =>
      request.method === 'eth_getTransactionByHash'
        ? { result: null }
        : { result: { ...receipt, logs: [{ ...receipt.logs[0], topics: [42] }] } }
    )

    const evidence = await fetchBscTransactionEvidence(TX_HASH, {
      rpcUrls: ['https://rpc.invalid'],
    })

    expect(evidence.transaction).toBeNull()
    expect(evidence.receipt).toBeNull()
    expect(evidence.unresolved).toEqual({
      transaction: 'not_found',
      receipt: 'invalid_response',
    })
  })

  it.each([
    { ...transaction, from: '0x1234' },
    { ...transaction, input: '0x123' },
    { ...transaction, blockNumber: '0x00' },
    { ...transaction, blockHash: null },
  ])('fails closed on malformed transaction point evidence %#', async (invalidTransaction) => {
    mockPointRpc((request) => ({
      result: request.method === 'eth_getTransactionByHash' ? invalidTransaction : receipt,
    }))

    const evidence = await fetchBscTransactionEvidence(TX_HASH, {
      rpcUrls: ['https://rpc.invalid'],
    })

    expect(evidence.transaction).toBeNull()
    expect(evidence.unresolved.transaction).toBe('invalid_response')
    expect(evidence.receipt).toEqual(receipt)
  })

  it.each([
    { ...receipt, status: '0x2' },
    { ...receipt, blockNumber: '123' },
    { ...receipt, blockHash: null },
    { ...receipt, logs: [{ ...receipt.logs[0], address: '0x1234' }] },
    { ...receipt, logs: [{ ...receipt.logs[0], topics: ['0x1234'] }] },
    { ...receipt, logs: [{ ...receipt.logs[0], data: '0x123' }] },
  ])('fails closed on malformed receipt point evidence %#', async (invalidReceipt) => {
    mockPointRpc((request) => ({
      result: request.method === 'eth_getTransactionByHash' ? transaction : invalidReceipt,
    }))

    const evidence = await fetchBscTransactionEvidence(TX_HASH, {
      rpcUrls: ['https://rpc.invalid'],
    })

    expect(evidence.transaction).toEqual(transaction)
    expect(evidence.receipt).toBeNull()
    expect(evidence.unresolved.receipt).toBe('invalid_response')
  })

  it('redacts provider failures into a fixed rpc_error reason', async () => {
    const secret = 'https://rpc.invalid/private-api-key'
    mockPointRpc((request) =>
      request.method === 'eth_getTransactionByHash'
        ? { error: { message: `upstream failed at ${secret}` } }
        : { result: receipt }
    )

    const evidence = await fetchBscTransactionEvidence(TX_HASH, { rpcUrls: [secret] })

    expect(evidence.transaction).toBeNull()
    expect(evidence.unresolved.transaction).toBe('rpc_error')
    expect(evidence.receipt).toEqual(receipt)
    expect(JSON.stringify(evidence)).not.toContain(secret)
  })

  it.each(['', '0x1234', `0x${'gg'.repeat(32)}`, `${'ab'.repeat(32)}`, `0x${'ab'.repeat(33)}`])(
    'rejects malformed tx hash %j before making an RPC request',
    async (txHash) => {
      const requests = mockPointRpc(() => ({ result: null }))

      await expect(
        fetchBscTransactionEvidence(txHash, { rpcUrls: ['https://rpc.invalid/private-api-key'] })
      ).rejects.toThrow('txHash must be a 0x-prefixed 32-byte hex string')
      expect(requests).toHaveLength(0)
    }
  )
})
