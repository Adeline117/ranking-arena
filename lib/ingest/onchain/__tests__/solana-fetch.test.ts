import { computeSolanaWalletOnchain, fetchSignatures, scanSignatures } from '../solana-fetch'

interface RpcRequest {
  method: string
  params: [string, { limit: number; before?: string }]
}

function mockRpc(handler: (request: RpcRequest) => unknown): RpcRequest[] {
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

describe('fetchSignatures', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    if (originalFetch) global.fetch = originalFetch
    else delete (global as typeof global & { fetch?: typeof fetch }).fetch
  })

  it('enforces maxSigs in the RPC request and returned records', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      signature: `sig-${i}`,
      blockTime: 1_800_000_000 - i,
      err: null,
    }))
    const requests = mockRpc((request) => rows.slice(0, request.params[1].limit))

    const signatures = await fetchSignatures('wallet', {
      rpcUrl: 'https://rpc.invalid',
      maxSigs: 150,
    })

    expect(requests).toHaveLength(1)
    expect(requests[0].params[1].limit).toBe(150)
    expect(signatures).toHaveLength(150)
    expect(signatures.at(-1)).toBe('sig-149')
  })

  it('marks an exact record cap as conservative truncation', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      signature: `sig-${i}`,
      blockTime: 1_800_000_000 - i,
      err: null,
    }))
    mockRpc((request) => rows.slice(0, request.params[1].limit))

    const scan = await scanSignatures('wallet', {
      rpcUrl: 'https://rpc.invalid',
      maxSigs: 3,
    })

    expect(scan.signatures).toEqual(['sig-0', 'sig-1', 'sig-2'])
    expect(scan.coverage).toEqual({
      scanComplete: false,
      truncated: true,
      stopReason: 'record_cap',
      pagesFetched: 1,
      recordsSeen: 3,
      recordsReturned: 3,
      recordsMissingTimestamp: 0,
    })
  })

  it('proves complete history when the provider returns a short page', async () => {
    mockRpc(() => [
      { signature: 'newer', blockTime: 1_800_000_000, err: null },
      { signature: 'older', blockTime: 1_799_999_999, err: null },
    ])

    const scan = await scanSignatures('wallet', {
      rpcUrl: 'https://rpc.invalid',
      maxSigs: 5,
    })

    expect(scan.signatures).toEqual(['newer', 'older'])
    expect(scan.coverage).toMatchObject({
      scanComplete: true,
      truncated: false,
      stopReason: 'history_exhausted',
      pagesFetched: 1,
      recordsSeen: 2,
      recordsReturned: 2,
    })
  })

  it('uses an old failed transaction as lookback-boundary evidence', async () => {
    mockRpc(() => [
      { signature: 'inside', blockTime: 200, err: null },
      { signature: 'old-failed', blockTime: 99, err: { code: 1 } },
      { signature: 'older', blockTime: 98, err: null },
    ])

    const scan = await scanSignatures('wallet', {
      rpcUrl: 'https://rpc.invalid',
      sinceMs: 100_000,
      maxSigs: 10,
    })

    expect(scan.signatures).toEqual(['inside'])
    expect(scan.coverage).toMatchObject({
      scanComplete: true,
      truncated: false,
      stopReason: 'lookback_boundary',
    })
  })

  it('does not claim completeness when a signature timestamp is missing', async () => {
    mockRpc(() => [{ signature: 'unknown-time', blockTime: null, err: null }])

    const scan = await scanSignatures('wallet', {
      rpcUrl: 'https://rpc.invalid',
      sinceMs: 100_000,
      maxSigs: 5,
    })

    expect(scan.signatures).toEqual(['unknown-time'])
    expect(scan.coverage).toMatchObject({
      scanComplete: false,
      truncated: false,
      stopReason: 'history_exhausted',
      recordsMissingTimestamp: 1,
    })
  })

  it('paginates with the last raw signature and proves exhaustion', async () => {
    const first = Array.from({ length: 1000 }, (_, i) => ({
      signature: `page-1-${i}`,
      blockTime: 1_800_000_000 - i,
      err: null,
    }))
    const requests = mockRpc((request) => {
      if (!request.params[1].before) return first
      return [{ signature: 'page-2-0', blockTime: 1_799_998_999, err: null }]
    })

    const scan = await scanSignatures('wallet', {
      rpcUrl: 'https://rpc.invalid',
      maxSigs: 1500,
    })

    expect(requests).toHaveLength(2)
    expect(requests[1].params[1]).toEqual({ limit: 500, before: 'page-1-999' })
    expect(scan.signatures).toHaveLength(1001)
    expect(scan.coverage).toMatchObject({
      scanComplete: true,
      truncated: false,
      stopReason: 'history_exhausted',
      pagesFetched: 2,
    })
  })

  it.each([0, -1, Number.NaN, 1.5])('rejects invalid maxSigs=%s', async (maxSigs) => {
    const requests = mockRpc(() => [])
    await expect(
      scanSignatures('wallet', { rpcUrl: 'https://rpc.invalid', maxSigs })
    ).rejects.toThrow('maxSigs must be a positive safe integer')
    expect(requests).toHaveLength(0)
  })

  it('reports transaction fetch failures separately from signature coverage', async () => {
    mockRpc((request) => {
      if (request.method === 'getSignaturesForAddress') {
        return [
          { signature: 'available', blockTime: 1_800_000_000, err: null },
          { signature: 'unavailable', blockTime: 1_799_999_999, err: null },
        ]
      }
      if (request.params[0] === 'unavailable') return null
      return {
        blockTime: 1_800_000_000,
        transaction: { message: { accountKeys: ['wallet'] } },
        meta: {
          fee: 0,
          preBalances: [1_000_000_000],
          postBalances: [1_000_000_000],
          preTokenBalances: [],
          postTokenBalances: [],
        },
      }
    })

    const result = await computeSolanaWalletOnchain('wallet', {
      rpcUrl: 'https://rpc.invalid',
      maxSigs: 5,
      solUsd: 100,
    })

    expect(result.signatureCoverage).toMatchObject({
      scanComplete: true,
      truncated: false,
      stopReason: 'history_exhausted',
    })
    expect(result.txsFetched).toBe(1)
    expect(result.txFetchFailures).toBe(1)
  })
})
