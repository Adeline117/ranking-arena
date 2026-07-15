import { fetchSignatures } from '../solana-fetch'

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
    const requests: Array<{ params: [string, { limit: number }] }> = []
    global.fetch = jest.fn(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { params: [string, { limit: number }] }
      requests.push(request)
      return {
        text: async () => JSON.stringify({ result: rows.slice(0, request.params[1].limit) }),
      } as unknown as Response
    }) as jest.MockedFunction<typeof fetch>

    const signatures = await fetchSignatures('wallet', {
      rpcUrl: 'https://rpc.invalid',
      maxSigs: 150,
    })

    expect(requests).toHaveLength(1)
    expect(requests[0].params[1].limit).toBe(150)
    expect(signatures).toHaveLength(150)
    expect(signatures.at(-1)).toBe('sig-149')
  })
})
