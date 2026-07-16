import {
  computeSolanaWalletOnchain,
  fetchSignatures,
  scanSignatureRecords,
  scanSignatures,
} from '../solana-fetch'

interface RpcRequest {
  method: string
  params: [string, { limit: number; before?: string; commitment?: 'finalized' }]
}

function mockRpc(handler: (request: RpcRequest) => unknown): RpcRequest[] {
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

  it('ignores a missing timestamp on a failed transaction', async () => {
    mockRpc(() => [
      { signature: 'failed', blockTime: null, err: { code: 1 } },
      { signature: 'available', blockTime: 200, err: null },
    ])

    const scan = await scanSignatures('wallet', {
      rpcUrl: 'https://rpc.invalid',
      sinceMs: 100_000,
      maxSigs: 5,
    })

    expect(scan.signatures).toEqual(['available'])
    expect(scan.coverage).toMatchObject({
      scanComplete: true,
      truncated: false,
      stopReason: 'history_exhausted',
      recordsMissingTimestamp: 0,
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

  it.each([0, -1, Number.NaN, 1.5])('rejects invalid maxPages=%s', async (maxPages) => {
    const requests = mockRpc(() => [])
    await expect(
      scanSignatures('wallet', { rpcUrl: 'https://rpc.invalid', maxPages })
    ).rejects.toThrow('maxPages must be a positive safe integer')
    expect(requests).toHaveLength(0)
  })

  it('marks the strict page budget as truncation when failed records fill a page', async () => {
    mockRpc((request) =>
      Array.from({ length: request.params[1].limit }, (_, i) => ({
        signature: `failed-${i}`,
        blockTime: 1_800_000_000 - i,
        err: { code: 1 },
      }))
    )

    const scan = await scanSignatures('wallet', {
      rpcUrl: 'https://rpc.invalid',
      maxSigs: 5,
      maxPages: 1,
    })

    expect(scan.signatures).toEqual([])
    expect(scan.coverage).toMatchObject({
      scanComplete: false,
      truncated: true,
      stopReason: 'page_cap',
      pagesFetched: 1,
      recordsSeen: 5,
    })
  })

  it('rejects a malformed signature RPC result instead of claiming exhaustion', async () => {
    mockRpc(() => undefined)
    await expect(
      scanSignatures('wallet', { rpcUrl: 'https://rpc.invalid', maxSigs: 5 })
    ).rejects.toThrow('invalid result')
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
    expect(result.txsUnresolved).toBe(1)
    expect(result.txsMissingTimestamp).toBe(0)
  })
})

describe('scanSignatureRecords', () => {
  const originalFetch = global.fetch
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
    for (let index = 0; index < bytes.length - 1 && bytes[index] === 0; index += 1) {
      result += '1'
    }
    return (
      result +
      digits
        .reverse()
        .map((digit) => BASE58_ALPHABET[digit])
        .join('')
    )
  }

  function syntheticSignature(label: string): string {
    const bytes = new Uint8Array(64)
    bytes[0] = 1
    for (const [index, character] of [...label].entries())
      bytes[index + 1] = character.charCodeAt(0)
    return encodeBase58(bytes)
  }

  afterEach(() => {
    if (originalFetch) global.fetch = originalFetch
    else delete (global as typeof global & { fetch?: typeof fetch }).fetch
  })

  const record = (
    signature: string,
    patch: Partial<{
      slot: number
      blockTime: number | null
      err: string | Record<string, unknown> | null
      memo: string | null
      confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null
    }> = {}
  ) => ({
    signature: syntheticSignature(signature),
    slot: 100,
    blockTime: 1_800_000_000,
    err: null,
    memo: null,
    confirmationStatus: 'finalized' as const,
    ...patch,
  })

  it('retains successful and failed finalized records with secret-safe provenance', async () => {
    const executionError = { InstructionError: [0, { Custom: 1 }] }
    const requests = mockRpc(() => [
      record('success'),
      record('failed', { slot: 99, err: executionError, memo: 'synthetic memo' }),
    ])

    const scan = await scanSignatureRecords('synthetic-wallet', {
      rpcUrl: 'https://rpc.invalid/private-query-value',
      maxRecords: 5,
    })

    expect(requests).toHaveLength(1)
    expect(requests[0].params[1]).toEqual({ commitment: 'finalized', limit: 5 })
    expect(scan.records).toEqual([
      {
        signature: syntheticSignature('success'),
        slot: 100,
        blockTime: 1_800_000_000,
        executionError: null,
        memo: null,
        confirmationStatus: 'finalized',
        providerId: 'caller_supplied',
      },
      {
        signature: syntheticSignature('failed'),
        slot: 99,
        blockTime: 1_800_000_000,
        executionError,
        memo: 'synthetic memo',
        confirmationStatus: 'finalized',
        providerId: 'caller_supplied',
      },
    ])
    expect(scan.coverage).toEqual({
      scanComplete: true,
      truncated: false,
      stopReason: 'history_exhausted',
      commitmentRequested: 'finalized',
      pagesFetched: 1,
      recordsSeen: 2,
      recordsReturned: 2,
      failedRecords: 1,
      recordsMissingTimestamp: 0,
      recordsNotFinalized: 0,
      duplicateRecords: 0,
      orderingViolations: 0,
      windowBoundaryViolations: 0,
      recordsAboveWindow: 0,
      sinceMs: 0,
      endExclusiveMs: null,
      initialBefore: null,
      nextBefore: null,
      boundaryRecord: null,
      providersAttempted: ['caller_supplied'],
    })
    expect(JSON.stringify(scan)).not.toContain('rpc.invalid')
    expect(JSON.stringify(scan)).not.toContain('private-query-value')
  })

  it('uses an old failed record as boundary evidence without returning it', async () => {
    mockRpc(() => [
      record('inside', { blockTime: 200 }),
      record('old-failed', { blockTime: 99, err: { InstructionError: [0, 'Synthetic'] } }),
    ])

    const scan = await scanSignatureRecords('synthetic-wallet', {
      rpcUrl: 'https://rpc.invalid',
      sinceMs: 100_000,
      maxRecords: 10,
    })

    expect(scan.records.map(({ signature }) => signature)).toEqual([syntheticSignature('inside')])
    expect(scan.coverage).toMatchObject({
      scanComplete: true,
      truncated: false,
      stopReason: 'lookback_boundary',
      recordsSeen: 2,
      recordsReturned: 1,
      failedRecords: 0,
      boundaryRecord: {
        signature: syntheticSignature('old-failed'),
        slot: 100,
        blockTime: 99,
        providerId: 'caller_supplied',
      },
    })
  })

  it('retains failed records with missing timestamps and fails coverage closed', async () => {
    mockRpc(() => [
      record('unknown-time-failed', {
        blockTime: null,
        err: { InstructionError: [0, 'Synthetic'] },
      }),
    ])

    const scan = await scanSignatureRecords('synthetic-wallet', {
      rpcUrl: 'https://rpc.invalid',
      maxRecords: 5,
    })

    expect(scan.records).toHaveLength(1)
    expect(scan.records[0]).toMatchObject({
      signature: syntheticSignature('unknown-time-failed'),
      blockTime: null,
      providerId: 'caller_supplied',
    })
    expect(scan.coverage).toMatchObject({
      scanComplete: false,
      truncated: false,
      stopReason: 'history_exhausted',
      failedRecords: 1,
      recordsMissingTimestamp: 1,
    })
  })

  it('paginates from the last raw record even when that record failed', async () => {
    const first = Array.from({ length: 1000 }, (_, index) =>
      record(`page-1-${index}`, {
        slot: 10_000 - index,
        blockTime: 1_800_000_000 - index,
        err: index === 999 ? { InstructionError: [0, 'Synthetic'] } : null,
      })
    )
    const requests = mockRpc((request) => {
      if (!request.params[1].before) return first
      return [record('page-2-0', { slot: 9_000, blockTime: 1_799_998_999 })]
    })

    const scan = await scanSignatureRecords('synthetic-wallet', {
      rpcUrl: 'https://rpc.invalid',
      maxRecords: 1500,
    })

    expect(requests).toHaveLength(2)
    expect(requests[1].params[1]).toEqual({
      commitment: 'finalized',
      limit: 500,
      before: syntheticSignature('page-1-999'),
    })
    expect(scan.records).toHaveLength(1001)
    expect(scan.coverage).toMatchObject({
      scanComplete: true,
      stopReason: 'history_exhausted',
      failedRecords: 1,
      pagesFetched: 2,
    })
  })

  it('marks an exact raw-record cap as conservative truncation', async () => {
    const rows = Array.from({ length: 10 }, (_, index) => record(`sig-${index}`))
    mockRpc((request) => rows.slice(0, request.params[1].limit))

    const scan = await scanSignatureRecords('synthetic-wallet', {
      rpcUrl: 'https://rpc.invalid',
      maxRecords: 3,
    })

    expect(scan.records).toHaveLength(3)
    expect(scan.coverage).toMatchObject({
      scanComplete: false,
      truncated: true,
      stopReason: 'record_cap',
      recordsSeen: 3,
      recordsReturned: 3,
      nextBefore: syntheticSignature('sig-2'),
    })
  })

  it('filters an exact end-exclusive window and retains lower-bound evidence', async () => {
    mockRpc(() => [
      record('after-end', { slot: 400, blockTime: 400 }),
      record('at-end', { slot: 300, blockTime: 300 }),
      record('inside-window', { slot: 299, blockTime: 299 }),
      record('below-start', { slot: 99, blockTime: 99 }),
    ])

    const scan = await scanSignatureRecords('synthetic-wallet', {
      rpcUrl: 'https://rpc.invalid',
      sinceMs: 100_000,
      endExclusiveMs: 300_000,
      maxRecords: 10,
    })

    expect(scan.records.map(({ signature }) => signature)).toEqual([
      syntheticSignature('inside-window'),
    ])
    expect(scan.coverage).toMatchObject({
      scanComplete: true,
      stopReason: 'lookback_boundary',
      recordsAboveWindow: 2,
      sinceMs: 100_000,
      endExclusiveMs: 300_000,
      boundaryRecord: {
        signature: syntheticSignature('below-start'),
        blockTime: 99,
      },
    })
  })

  it('fails closed when the fetched page re-enters the window after crossing its lower bound', async () => {
    mockRpc(() => [
      record('inside-before-boundary', { slot: 200, blockTime: 200 }),
      record('below-start', { slot: 99, blockTime: 99 }),
      record('inside-after-boundary', { slot: 98, blockTime: 150 }),
    ])

    const scan = await scanSignatureRecords('synthetic-wallet', {
      rpcUrl: 'https://rpc.invalid',
      sinceMs: 100_000,
      endExclusiveMs: 300_000,
      maxRecords: 10,
    })

    expect(scan.records.map(({ signature }) => signature)).toEqual([
      syntheticSignature('inside-before-boundary'),
      syntheticSignature('inside-after-boundary'),
    ])
    expect(scan.coverage).toMatchObject({
      scanComplete: false,
      stopReason: 'lookback_boundary',
      orderingViolations: 0,
      windowBoundaryViolations: 1,
      boundaryRecord: { signature: syntheticSignature('below-start') },
    })
  })

  it('emits and consumes a validated continuation cursor after page interruption', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) =>
      record(`resume-page-1-${index}`, {
        slot: 10_000 - index,
        blockTime: 1_800_000_000 - index,
      })
    )
    const requests = mockRpc((request) =>
      request.params[1].before
        ? [record('resume-page-2', { slot: 9_000, blockTime: 1_799_998_999 })]
        : firstPage
    )

    const interrupted = await scanSignatureRecords('synthetic-wallet', {
      rpcUrl: 'https://rpc.invalid',
      maxRecords: 2000,
      maxPages: 1,
    })
    const continuation = syntheticSignature('resume-page-1-999')
    expect(interrupted.coverage).toMatchObject({
      scanComplete: false,
      truncated: true,
      stopReason: 'page_cap',
      initialBefore: null,
      nextBefore: continuation,
    })

    const resumed = await scanSignatureRecords('synthetic-wallet', {
      rpcUrl: 'https://rpc.invalid',
      initialBefore: interrupted.coverage.nextBefore!,
      maxRecords: 1000,
      maxPages: 2,
    })
    expect(requests[1].params[1].before).toBe(continuation)
    expect(resumed.records.map(({ signature }) => signature)).toEqual([
      syntheticSignature('resume-page-2'),
    ])
    expect(resumed.coverage).toMatchObject({
      scanComplete: true,
      stopReason: 'history_exhausted',
      initialBefore: continuation,
      nextBefore: null,
    })
  })

  it('applies maxRecords to raw records skipped above the upper window', async () => {
    mockRpc(() => [
      record('future-1', { slot: 200, blockTime: 200 }),
      record('future-2', { slot: 199, blockTime: 199 }),
    ])

    const scan = await scanSignatureRecords('synthetic-wallet', {
      rpcUrl: 'https://rpc.invalid',
      endExclusiveMs: 100_000,
      maxRecords: 2,
    })

    expect(scan.records).toEqual([])
    expect(scan.coverage).toMatchObject({
      scanComplete: false,
      stopReason: 'record_cap',
      recordsSeen: 2,
      recordsReturned: 0,
      recordsAboveWindow: 2,
      nextBefore: syntheticSignature('future-2'),
    })
  })

  it('fails coverage closed on duplicate, out-of-order, or non-finalized records', async () => {
    mockRpc(() => [
      record('duplicate', { slot: 100 }),
      record('duplicate', { slot: 101 }),
      record('confirmed', { slot: 99, confirmationStatus: 'confirmed' }),
      record('missing-status', { slot: 98, confirmationStatus: null }),
    ])

    const scan = await scanSignatureRecords('synthetic-wallet', {
      rpcUrl: 'https://rpc.invalid',
      maxRecords: 5,
    })

    expect(scan.coverage).toMatchObject({
      scanComplete: false,
      truncated: false,
      stopReason: 'history_exhausted',
      recordsNotFinalized: 2,
      duplicateRecords: 1,
      orderingViolations: 1,
      windowBoundaryViolations: 0,
    })
  })

  it('rejects malformed raw identity and timing fields', async () => {
    mockRpc(() => [{ ...record('valid'), signature: 'not-base58!' }])
    await expect(
      scanSignatureRecords('synthetic-wallet', {
        rpcUrl: 'https://rpc.invalid',
        maxRecords: 5,
      })
    ).rejects.toThrow('invalid signature')

    mockRpc(() => [{ ...record('valid'), signature: 'z'.repeat(64) }])
    await expect(
      scanSignatureRecords('synthetic-wallet', {
        rpcUrl: 'https://rpc.invalid',
        maxRecords: 5,
      })
    ).rejects.toThrow('invalid signature')

    mockRpc(() => [record('negative-time', { blockTime: -1 })])
    await expect(
      scanSignatureRecords('synthetic-wallet', {
        rpcUrl: 'https://rpc.invalid',
        maxRecords: 5,
      })
    ).rejects.toThrow('invalid blockTime')
  })

  it('redacts upstream RPC failures from evidence-path errors', async () => {
    const secret = 'private-provider-query-value'
    global.fetch = jest.fn(async () => ({
      text: async () => JSON.stringify({ error: { message: `failure ${secret}` } }),
    })) as jest.MockedFunction<typeof fetch>

    let error: unknown
    try {
      await scanSignatureRecords('synthetic-wallet', {
        rpcUrl: `https://rpc.invalid/?key=${secret}`,
        maxRecords: 5,
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('sol getSignaturesForAddress: RPC request failed')
    expect((error as Error).message).not.toContain(secret)
  })

  it('records stable provider provenance across Helius quota failover', async () => {
    const originalHeliusKey = process.env.HELIUS_API_KEY
    const originalAlchemyKey = process.env.ALCHEMY_API_KEY
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const providerCalls: Array<'helius' | 'alchemy'> = []
    try {
      process.env.HELIUS_API_KEY = 'synthetic-helius-key'
      process.env.ALCHEMY_API_KEY = 'synthetic-alchemy-key'
      jest.resetModules()
      global.fetch = jest.fn(async (input) => {
        const provider = String(input).includes('helius-rpc.com') ? 'helius' : 'alchemy'
        providerCalls.push(provider)
        return {
          text: async () =>
            provider === 'helius'
              ? JSON.stringify({ error: { message: 'quota exhausted' } })
              : JSON.stringify({ result: [record('served-by-alchemy')] }),
        } as Response
      }) as jest.MockedFunction<typeof fetch>
      const freshModule = await import('../solana-fetch')

      const scan = await freshModule.scanSignatureRecords('synthetic-wallet', { maxRecords: 5 })

      expect(providerCalls).toEqual(['helius', 'alchemy'])
      expect(scan.records[0].providerId).toBe('alchemy')
      expect(scan.coverage.providersAttempted).toEqual(['helius', 'alchemy'])
      expect(JSON.stringify(scan)).not.toContain('synthetic-helius-key')
      expect(JSON.stringify(scan)).not.toContain('synthetic-alchemy-key')
    } finally {
      if (originalHeliusKey === undefined) delete process.env.HELIUS_API_KEY
      else process.env.HELIUS_API_KEY = originalHeliusKey
      if (originalAlchemyKey === undefined) delete process.env.ALCHEMY_API_KEY
      else process.env.ALCHEMY_API_KEY = originalAlchemyKey
      warn.mockRestore()
      jest.resetModules()
    }
  })

  it.each([0, -1, Number.NaN, 1.5])('rejects invalid maxRecords=%s', async (maxRecords) => {
    const requests = mockRpc(() => [])
    await expect(
      scanSignatureRecords('synthetic-wallet', {
        rpcUrl: 'https://rpc.invalid',
        maxRecords,
      })
    ).rejects.toThrow('maxRecords must be a positive safe integer')
    expect(requests).toHaveLength(0)
  })

  it.each([0, -1, Number.NaN, 1.5])('rejects invalid maxPages=%s', async (maxPages) => {
    const requests = mockRpc(() => [])
    await expect(
      scanSignatureRecords('synthetic-wallet', {
        rpcUrl: 'https://rpc.invalid',
        maxPages,
      })
    ).rejects.toThrow('maxPages must be a positive safe integer')
    expect(requests).toHaveLength(0)
  })

  it('rejects an invalid continuation cursor before RPC', async () => {
    const requests = mockRpc(() => [])
    await expect(
      scanSignatureRecords('synthetic-wallet', {
        rpcUrl: 'https://rpc.invalid',
        initialBefore: 'z'.repeat(64),
      })
    ).rejects.toThrow('initialBefore must be a base58-encoded 64-byte signature')
    expect(requests).toHaveLength(0)
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid sinceMs=%s',
    async (sinceMs) => {
      const requests = mockRpc(() => [])
      await expect(
        scanSignatureRecords('synthetic-wallet', {
          rpcUrl: 'https://rpc.invalid',
          sinceMs,
        })
      ).rejects.toThrow('sinceMs must be a non-negative safe integer')
      expect(requests).toHaveLength(0)
    }
  )

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid endExclusiveMs=%s',
    async (endExclusiveMs) => {
      const requests = mockRpc(() => [])
      await expect(
        scanSignatureRecords('synthetic-wallet', {
          rpcUrl: 'https://rpc.invalid',
          endExclusiveMs,
        })
      ).rejects.toThrow('endExclusiveMs must be a non-negative safe integer')
      expect(requests).toHaveLength(0)
    }
  )

  it('rejects an empty or inverted fixed window', async () => {
    const requests = mockRpc(() => [])
    await expect(
      scanSignatureRecords('synthetic-wallet', {
        rpcUrl: 'https://rpc.invalid',
        sinceMs: 100_000,
        endExclusiveMs: 100_000,
      })
    ).rejects.toThrow('endExclusiveMs must be greater than sinceMs')
    expect(requests).toHaveLength(0)
  })
})
