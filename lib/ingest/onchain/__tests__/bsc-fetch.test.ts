import { scanWalletTransfers } from '../bsc-fetch'

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
    } as unknown as Response
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
