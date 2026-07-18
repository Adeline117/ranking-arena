import {
  computeSolanaWalletOnchain,
  fetchSignatures,
  fetchTxEvidence,
  normalizeSolanaTxEvidenceResult,
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

describe('fetchTxEvidence', () => {
  const originalFetch = global.fetch
  const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

  interface EvidenceRpcRequest {
    method: string
    params: [
      string,
      {
        commitment: 'finalized'
        encoding: 'json'
        maxSupportedTransactionVersion: 0
      },
    ]
  }

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

  function syntheticBase58(label: string, byteLength: 32 | 64): string {
    const bytes = new Uint8Array(byteLength)
    bytes[0] = 1
    for (const [index, character] of [...label].entries()) {
      if (index + 1 >= bytes.length) break
      bytes[index + 1] = character.charCodeAt(0)
    }
    return encodeBase58(bytes)
  }

  const SIGNATURE = syntheticBase58('transaction', 64)
  const WALLET = syntheticBase58('wallet', 32)
  const TOKEN_ACCOUNT = syntheticBase58('token-account', 32)
  const ROUTER_PROGRAM = syntheticBase58('router-program', 32)
  const POOL_PROGRAM = syntheticBase58('pool-program', 32)
  const TOKEN_PROGRAM = syntheticBase58('token-program', 32)
  const TOKEN_MINT = syntheticBase58('token-mint', 32)
  const LOOKUP_TABLE = syntheticBase58('lookup-table', 32)
  const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
  const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

  function legacyFixture() {
    return {
      slot: 123,
      blockTime: 1_800_000_000,
      version: 'legacy',
      transaction: {
        signatures: [SIGNATURE],
        message: {
          accountKeys: [WALLET, TOKEN_ACCOUNT, ROUTER_PROGRAM],
          header: {
            numRequiredSignatures: 1,
            numReadonlySignedAccounts: 0,
            numReadonlyUnsignedAccounts: 1,
          },
          instructions: [
            {
              programIdIndex: 2,
              accounts: [0, 1],
              data: '3',
              stackHeight: 1,
            },
          ],
        },
      },
      meta: {
        err: null,
        fee: 5000,
        computeUnitsConsumed: 999,
        preBalances: [1_000_000, 2_000_000, 0],
        postBalances: [995_000, 2_000_000, 0],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: TOKEN_MINT,
            owner: WALLET,
            programId: TOKEN_PROGRAM,
            uiTokenAmount: {
              amount: '9007199254740993123',
              decimals: 6,
              uiAmount: null,
            },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: TOKEN_MINT,
            owner: WALLET,
            programId: TOKEN_PROGRAM,
            uiTokenAmount: {
              amount: '9007199254741993123',
              decimals: 6,
              uiAmount: null,
            },
          },
        ],
        innerInstructions: [],
        logMessages: ['synthetic legacy log'],
        loadedAddresses: { writable: [], readonly: [] },
      },
    }
  }

  function v0Fixture() {
    return {
      slot: 456,
      blockTime: 1_800_000_100,
      version: 0,
      transaction: {
        signatures: [SIGNATURE],
        message: {
          accountKeys: [WALLET, ROUTER_PROGRAM],
          header: {
            numRequiredSignatures: 1,
            numReadonlySignedAccounts: 0,
            numReadonlyUnsignedAccounts: 1,
          },
          addressTableLookups: [
            {
              accountKey: LOOKUP_TABLE,
              writableIndexes: [2],
              readonlyIndexes: [3, 4],
            },
          ],
          instructions: [
            {
              programIdIndex: 1,
              accounts: [0, 2, 4],
              data: '4',
              stackHeight: 1,
            },
          ],
        },
      },
      meta: {
        err: { InstructionError: [0, { Custom: 7 }] },
        fee: 7000,
        computeUnitsConsumed: 1234,
        preBalances: [1_000_000, 0, 2_000_000, 0, 0],
        postBalances: [993_000, 0, 2_000_000, 0, 0],
        preTokenBalances: [
          {
            accountIndex: 2,
            mint: TOKEN_MINT,
            owner: WALLET,
            programId: TOKEN_PROGRAM,
            uiTokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1 },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 2,
            mint: TOKEN_MINT,
            owner: WALLET,
            programId: TOKEN_PROGRAM,
            uiTokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1 },
          },
        ],
        loadedAddresses: {
          writable: [TOKEN_ACCOUNT],
          readonly: [TOKEN_PROGRAM, POOL_PROGRAM],
        },
        innerInstructions: [
          {
            index: 0,
            instructions: [
              {
                programIdIndex: 3,
                accounts: [2, 0],
                data: '5',
                stackHeight: 2,
              },
              {
                programIdIndex: 4,
                accounts: [0, 2],
                data: '6',
                stackHeight: 2,
              },
            ],
          },
        ],
        logMessages: ['synthetic v0 log'],
      },
    }
  }

  function mockEvidencePayload(payload: unknown, status = 200): EvidenceRpcRequest[] {
    const requests: EvidenceRpcRequest[] = []
    global.fetch = jest.fn(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as EvidenceRpcRequest)
      const envelope =
        payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        !Object.hasOwn(payload, 'jsonrpc') &&
        (Object.hasOwn(payload, 'result') || Object.hasOwn(payload, 'error'))
          ? { jsonrpc: '2.0', id: 1, ...payload }
          : payload
      return {
        status,
        text: async () => JSON.stringify(envelope),
      } as Response
    }) as jest.MockedFunction<typeof fetch>
    return requests
  }

  afterEach(() => {
    if (originalFetch) global.fetch = originalFetch
    else delete (global as typeof global & { fetch?: typeof fetch }).fetch
  })

  it('normalizes a decoded result without network access or invented source provenance', () => {
    global.fetch = jest.fn()

    const normalized = normalizeSolanaTxEvidenceResult(SIGNATURE, legacyFixture())
    expect(normalized).toMatchObject({
      status: 'available',
      signature: SIGNATURE,
      version: 'legacy',
      executionStatus: 'succeeded',
      innerInstructionsStatus: 'verified_empty',
    })
    expect(normalized).not.toHaveProperty('provider')
    expect(normalized).not.toHaveProperty('commitmentRequested')
    expect(normalized).not.toHaveProperty('encoding')
    expect(normalized).not.toHaveProperty('maxSupportedTransactionVersion')
    expect(global.fetch).not.toHaveBeenCalled()

    const unsupported = legacyFixture() as any
    unsupported.version = 1
    expect(() => normalizeSolanaTxEvidenceResult(SIGNATURE, unsupported)).toThrow(
      'unsupported Solana transaction version'
    )
    expect(() => normalizeSolanaTxEvidenceResult(SIGNATURE, null)).toThrow(
      'malformed Solana transaction evidence'
    )
  })

  it('maps exact legacy evidence without using floating token amounts', async () => {
    const requests = mockEvidencePayload({ result: legacyFixture() })

    const evidence = await fetchTxEvidence(SIGNATURE, {
      rpcUrl: 'https://rpc.invalid/private-query-value',
    })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [
        SIGNATURE,
        {
          commitment: 'finalized',
          encoding: 'json',
          maxSupportedTransactionVersion: 0,
        },
      ],
    })
    expect(evidence).toMatchObject({
      status: 'available',
      signature: SIGNATURE,
      provider: { servedBy: 'caller_supplied', attempted: ['caller_supplied'] },
      commitmentRequested: 'finalized',
      encoding: 'json',
      maxSupportedTransactionVersion: 0,
      version: 'legacy',
      executionStatus: 'succeeded',
      executionError: null,
      innerInstructionsStatus: 'verified_empty',
      staticAccountKeys: [WALLET, TOKEN_ACCOUNT, ROUTER_PROGRAM],
      loadedAddresses: { writable: [], readonly: [] },
      accountKeys: [
        { index: 0, pubkey: WALLET, source: 'transaction', signer: true, writable: true },
        {
          index: 1,
          pubkey: TOKEN_ACCOUNT,
          source: 'transaction',
          signer: false,
          writable: true,
        },
        {
          index: 2,
          pubkey: ROUTER_PROGRAM,
          source: 'transaction',
          signer: false,
          writable: false,
        },
      ],
      preTokenBalances: [
        {
          accountIndex: 1,
          account: TOKEN_ACCOUNT,
          mint: TOKEN_MINT,
          owner: WALLET,
          tokenProgram: TOKEN_PROGRAM,
          rawAmount: '9007199254740993123',
          decimals: 6,
        },
      ],
      instructions: [
        {
          path: { kind: 'outer', outerIndex: 0 },
          programIdIndex: 2,
          programId: ROUTER_PROGRAM,
          accountIndexes: [0, 1],
          accounts: [WALLET, TOKEN_ACCOUNT],
          dataBase58: '3',
          stackHeight: 1,
        },
      ],
    })
    expect(JSON.stringify(evidence)).not.toContain('rpc.invalid')
    expect(JSON.stringify(evidence)).not.toContain('private-query-value')
    expect(JSON.stringify(evidence)).not.toContain('uiAmount')
  })

  it('resolves v0 lookup origins and retains failed outer/inner evidence as available', async () => {
    mockEvidencePayload({ result: v0Fixture() })

    const evidence = await fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })

    expect(evidence).toMatchObject({
      status: 'available',
      version: 0,
      executionStatus: 'failed',
      executionError: { InstructionError: [0, { Custom: 7 }] },
      innerInstructionsStatus: 'present',
      addressTableLookups: [
        { tableAccount: LOOKUP_TABLE, writableIndexes: [2], readonlyIndexes: [3, 4] },
      ],
      loadedAddresses: {
        writable: [TOKEN_ACCOUNT],
        readonly: [TOKEN_PROGRAM, POOL_PROGRAM],
      },
      accountKeys: [
        { index: 0, pubkey: WALLET, source: 'transaction', lookup: null },
        { index: 1, pubkey: ROUTER_PROGRAM, source: 'transaction', lookup: null },
        {
          index: 2,
          pubkey: TOKEN_ACCOUNT,
          source: 'lookupTable',
          writable: true,
          lookup: { tableAccount: LOOKUP_TABLE, tableIndex: 2 },
        },
        {
          index: 3,
          pubkey: TOKEN_PROGRAM,
          source: 'lookupTable',
          writable: false,
          lookup: { tableAccount: LOOKUP_TABLE, tableIndex: 3 },
        },
        {
          index: 4,
          pubkey: POOL_PROGRAM,
          source: 'lookupTable',
          writable: false,
          lookup: { tableAccount: LOOKUP_TABLE, tableIndex: 4 },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 2,
          account: TOKEN_ACCOUNT,
          tokenProgram: TOKEN_PROGRAM,
          rawAmount: '1000000',
          decimals: 6,
        },
      ],
      instructions: [
        {
          path: { kind: 'outer', outerIndex: 0 },
          programId: ROUTER_PROGRAM,
          accounts: [WALLET, TOKEN_ACCOUNT, POOL_PROGRAM],
        },
        {
          path: { kind: 'inner', outerIndex: 0, innerIndex: 0 },
          programId: TOKEN_PROGRAM,
          accounts: [TOKEN_ACCOUNT, WALLET],
          stackHeight: 2,
        },
        {
          path: { kind: 'inner', outerIndex: 0, innerIndex: 1 },
          programId: POOL_PROGRAM,
          accounts: [WALLET, TOKEN_ACCOUNT],
          stackHeight: 2,
        },
      ],
    })
  })

  it('distinguishes not-found from explicitly unavailable metadata', async () => {
    mockEvidencePayload({ result: null })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'not_found',
      provider: { servedBy: 'caller_supplied', attempted: ['caller_supplied'] },
      rpcCode: null,
      httpStatus: 200,
    })

    const missingMeta = legacyFixture()
    missingMeta.meta = null as never
    mockEvidencePayload({ result: missingMeta })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'metadata_unavailable',
      provider: { servedBy: 'caller_supplied' },
    })
  })

  it('classifies unsupported versions from RPC errors or successful future payloads', async () => {
    const secret = 'private-version-message'
    mockEvidencePayload({ error: { code: -32015, message: secret } })
    const rpcUnsupported = await fetchTxEvidence(SIGNATURE, {
      rpcUrl: `https://rpc.invalid/?key=${secret}`,
    })
    expect(rpcUnsupported).toMatchObject({
      status: 'unavailable',
      reason: 'unsupported_transaction_version',
      rpcCode: -32015,
      httpStatus: 200,
    })
    expect(JSON.stringify(rpcUnsupported)).not.toContain(secret)

    const future = legacyFixture()
    future.version = 1 as never
    mockEvidencePayload({ result: future })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'unsupported_transaction_version',
      rpcCode: null,
    })
  })

  it.each([
    [429, 'rate_limited'],
    [402, 'quota_exhausted'],
  ] as const)(
    'classifies HTTP %s as %s without returning response text',
    async (status, reason) => {
      const secret = `private-http-${status}`
      mockEvidencePayload({ error: { code: -32000, message: secret } }, status)

      const evidence = await fetchTxEvidence(SIGNATURE, {
        rpcUrl: `https://rpc.invalid/?key=${secret}`,
      })

      expect(evidence).toMatchObject({
        status: 'unavailable',
        reason,
        rpcCode: null,
        httpStatus: status,
        provider: { servedBy: null, attempted: ['caller_supplied'] },
      })
      expect(JSON.stringify(evidence)).not.toContain(secret)
    }
  )

  it.each([
    ['AbortError', 'timeout'],
    ['TypeError', 'transport_error'],
  ] as const)('classifies %s without returning exception text', async (name, reason) => {
    const error = new Error('private-transport-message')
    error.name = name
    global.fetch = jest.fn(async () => {
      throw error
    }) as jest.MockedFunction<typeof fetch>

    const evidence = await fetchTxEvidence(SIGNATURE, {
      rpcUrl: 'https://rpc.invalid/?key=private-url-value',
    })

    expect(evidence).toMatchObject({
      status: 'unavailable',
      reason,
      rpcCode: null,
      httpStatus: null,
      provider: { servedBy: null, attempted: ['caller_supplied'] },
    })
    expect(JSON.stringify(evidence)).not.toContain('private-transport-message')
    expect(JSON.stringify(evidence)).not.toContain('private-url-value')
  })

  it('distinguishes generic RPC errors and never returns their raw message', async () => {
    const secret = 'private-rpc-message'
    mockEvidencePayload({ error: { code: -32000, message: secret } })

    const evidence = await fetchTxEvidence(SIGNATURE, {
      rpcUrl: `https://rpc.invalid/?key=${secret}`,
    })

    expect(evidence).toMatchObject({
      status: 'unavailable',
      reason: 'rpc_error',
      rpcCode: -32000,
      httpStatus: 200,
    })
    expect(JSON.stringify(evidence)).not.toContain(secret)
  })

  it('fails malformed JSON and malformed result envelopes closed', async () => {
    global.fetch = jest.fn(async () => ({
      status: 200,
      text: async () => '{private-malformed-body',
    })) as jest.MockedFunction<typeof fetch>
    const malformedJson = await fetchTxEvidence(SIGNATURE, {
      rpcUrl: 'https://rpc.invalid/?key=private-url-value',
    })
    expect(malformedJson).toMatchObject({
      status: 'unavailable',
      reason: 'malformed_response',
    })
    expect(JSON.stringify(malformedJson)).not.toContain('private-malformed-body')
    expect(JSON.stringify(malformedJson)).not.toContain('private-url-value')

    mockEvidencePayload({ jsonrpc: '2.0', id: 1 })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })
  })

  it('fails unsafe integers and out-of-range instruction indexes closed', async () => {
    const unsafe = legacyFixture()
    unsafe.slot = Number.MAX_SAFE_INTEGER + 1
    mockEvidencePayload({ result: unsafe })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })

    const outOfRange = legacyFixture()
    outOfRange.transaction.message.instructions[0].programIdIndex = 9
    mockEvidencePayload({ result: outOfRange })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })
  })

  it('separates the outer packet ceiling from the larger CPI instruction-data limit', async () => {
    // The packet-size value is a conservative per-field ceiling here; this
    // synthetic JSON does not claim that a full serialized packet would fit.
    for (const data of ['', '1'.repeat(1_232)]) {
      const accepted = legacyFixture()
      accepted.transaction.message.instructions[0].data = data
      mockEvidencePayload({ result: accepted })
      await expect(
        fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
      ).resolves.toMatchObject({ status: 'available' })
    }

    for (const data of ['0OIl!', '1'.repeat(1_233)]) {
      const rejected = legacyFixture()
      rejected.transaction.message.instructions[0].data = data
      mockEvidencePayload({ result: rejected })
      await expect(
        fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
      ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })
    }

    for (const data of ['1'.repeat(1_233), '1'.repeat(10_240)]) {
      const acceptedCpi = v0Fixture()
      acceptedCpi.meta.innerInstructions[0].instructions[0].data = data
      mockEvidencePayload({ result: acceptedCpi })
      await expect(
        fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
      ).resolves.toMatchObject({ status: 'available' })
    }

    const oversizedCpi = v0Fixture()
    oversizedCpi.meta.innerInstructions[0].instructions[0].data = '1'.repeat(10_241)
    mockEvidencePayload({ result: oversizedCpi })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })
  })

  it('separates declared outer instructions from the executed trace on failed transactions', async () => {
    const tooManyOuter = legacyFixture()
    const outerInstruction = tooManyOuter.transaction.message.instructions[0]
    tooManyOuter.transaction.message.instructions = Array.from({ length: 65 }, () => ({
      ...outerInstruction,
      accounts: [...outerInstruction.accounts],
    }))
    mockEvidencePayload({ result: tooManyOuter })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })

    const failedAtTraceLimit = legacyFixture()
    failedAtTraceLimit.transaction.message.instructions =
      tooManyOuter.transaction.message.instructions.map((instruction) => ({
        ...instruction,
        accounts: [...instruction.accounts],
      }))
    failedAtTraceLimit.meta.err = {
      InstructionError: [64, 'MaxInstructionTraceLengthExceeded'],
    } as never
    mockEvidencePayload({ result: failedAtTraceLimit })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({
      status: 'available',
      executionStatus: 'failed',
      instructions: expect.arrayContaining([
        expect.objectContaining({ path: { kind: 'outer', outerIndex: 64 } }),
      ]),
    })

    const tooManyDeclared = legacyFixture()
    tooManyDeclared.transaction.message.instructions = Array.from({ length: 411 }, () => ({
      ...outerInstruction,
      accounts: [...outerInstruction.accounts],
    }))
    tooManyDeclared.meta.err = {
      InstructionError: [64, 'MaxInstructionTraceLengthExceeded'],
    } as never
    mockEvidencePayload({ result: tooManyDeclared })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })

    const tooManyWithCpi = v0Fixture()
    const innerInstruction = tooManyWithCpi.meta.innerInstructions[0].instructions[0]
    tooManyWithCpi.meta.innerInstructions[0].instructions = Array.from({ length: 64 }, () => ({
      ...innerInstruction,
      accounts: [...innerInstruction.accounts],
    }))
    mockEvidencePayload({ result: tooManyWithCpi })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })

    const lateReportedCpi = v0Fixture()
    const v0OuterInstruction = lateReportedCpi.transaction.message.instructions[0]
    lateReportedCpi.transaction.message.instructions = Array.from({ length: 64 }, () => ({
      ...v0OuterInstruction,
      accounts: [...v0OuterInstruction.accounts],
    }))
    lateReportedCpi.meta.innerInstructions[0].index = 63
    mockEvidencePayload({ result: lateReportedCpi })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })
  })

  it('fails signature/header count and duplicate token balance identities closed', async () => {
    const signatureMismatch = legacyFixture()
    signatureMismatch.transaction.message.header.numRequiredSignatures = 2
    mockEvidencePayload({ result: signatureMismatch })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })

    const readonlyFeePayer = legacyFixture()
    readonlyFeePayer.transaction.message.header.numReadonlySignedAccounts = 1
    mockEvidencePayload({ result: readonlyFeePayer })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })

    const duplicateBalance = legacyFixture()
    duplicateBalance.meta.preTokenBalances.push({
      ...duplicateBalance.meta.preTokenBalances[0],
      uiTokenAmount: { ...duplicateBalance.meta.preTokenBalances[0].uiTokenAmount },
    })
    mockEvidencePayload({ result: duplicateBalance })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })
  })

  it('fails invalid transaction errors and JSON-RPC envelopes closed', async () => {
    const invalidError = v0Fixture()
    invalidError.meta.err = { InstructionError: [Number.MAX_SAFE_INTEGER + 1] }
    mockEvidencePayload({ result: invalidError })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })

    const multipleErrorVariants = v0Fixture()
    multipleErrorVariants.meta.err = {
      InstructionError: [0, { Custom: 7 }],
      BlockhashNotFound: null,
    }
    mockEvidencePayload({ result: multipleErrorVariants })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })

    mockEvidencePayload({ jsonrpc: '2.0', id: 2, result: legacyFixture() })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })

    mockEvidencePayload({ jsonrpc: '2.0', id: 1, result: legacyFixture(), error: null })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })
  })

  it('fails v0 evidence without loaded addresses or with inconsistent lookup counts', async () => {
    const missingLoaded = v0Fixture()
    delete (missingLoaded.meta as { loadedAddresses?: unknown }).loadedAddresses
    mockEvidencePayload({ result: missingLoaded })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })

    const inconsistent = v0Fixture()
    inconsistent.meta.loadedAddresses.readonly.pop()
    mockEvidencePayload({ result: inconsistent })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })

    const emptyLookup = v0Fixture()
    emptyLookup.transaction.message.addressTableLookups[0].writableIndexes = []
    emptyLookup.transaction.message.addressTableLookups[0].readonlyIndexes = []
    mockEvidencePayload({ result: emptyLookup })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })
  })

  it('accepts repeated lookup indexes but restricts outer program IDs to non-payer static keys', async () => {
    const repeatedLookupIndex = v0Fixture()
    repeatedLookupIndex.transaction.message.addressTableLookups[0].writableIndexes = [2, 2]
    repeatedLookupIndex.meta.loadedAddresses.writable = [TOKEN_ACCOUNT, TOKEN_ACCOUNT]
    repeatedLookupIndex.meta.preBalances.push(0)
    repeatedLookupIndex.meta.postBalances.push(0)
    mockEvidencePayload({ result: repeatedLookupIndex })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'available' })

    const payerProgram = legacyFixture()
    payerProgram.transaction.message.instructions[0].programIdIndex = 0
    mockEvidencePayload({ result: payerProgram })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })

    const loadedOuterProgram = v0Fixture()
    loadedOuterProgram.transaction.message.instructions[0].programIdIndex = 4
    mockEvidencePayload({ result: loadedOuterProgram })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })
  })

  it('retains whether inner-instruction metadata is unavailable', async () => {
    const unavailableInnerInstructions = legacyFixture()
    unavailableInnerInstructions.meta.innerInstructions = null as never
    mockEvidencePayload({ result: unavailableInnerInstructions })

    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({
      status: 'available',
      innerInstructionsStatus: 'unavailable',
      instructions: [{ path: { kind: 'outer', outerIndex: 0 } }],
    })
  })

  it.each([SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM])(
    'retains balances owned by the real token program %s',
    async (tokenProgram) => {
      const fixture = legacyFixture()
      fixture.meta.preTokenBalances[0].programId = tokenProgram
      fixture.meta.postTokenBalances[0].programId = tokenProgram
      mockEvidencePayload({ result: fixture })

      await expect(
        fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
      ).resolves.toMatchObject({
        status: 'available',
        preTokenBalances: [{ tokenProgram }],
        postTokenBalances: [{ tokenProgram }],
      })
    }
  )

  it('fails invalid raw token amounts, decimals, or account indexes closed', async () => {
    const invalidAmount = legacyFixture()
    invalidAmount.meta.preTokenBalances[0].uiTokenAmount.amount = '1.5'
    mockEvidencePayload({ result: invalidAmount })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })

    const u64Overflow = legacyFixture()
    u64Overflow.meta.preTokenBalances[0].uiTokenAmount.amount = '18446744073709551616'
    mockEvidencePayload({ result: u64Overflow })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })

    const invalidDecimals = legacyFixture()
    invalidDecimals.meta.preTokenBalances[0].uiTokenAmount.decimals = 256
    mockEvidencePayload({ result: invalidDecimals })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })

    const invalidAccount = legacyFixture()
    invalidAccount.meta.preTokenBalances[0].accountIndex = 9
    mockEvidencePayload({ result: invalidAccount })
    await expect(
      fetchTxEvidence(SIGNATURE, { rpcUrl: 'https://rpc.invalid' })
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed_response' })
  })

  it('returns provider_unconfigured before network access', async () => {
    const originalHeliusKey = process.env.HELIUS_API_KEY
    const originalAlchemyKey = process.env.ALCHEMY_API_KEY
    try {
      delete process.env.HELIUS_API_KEY
      delete process.env.ALCHEMY_API_KEY
      global.fetch = jest.fn()

      const evidence = await fetchTxEvidence(SIGNATURE)

      expect(evidence).toMatchObject({
        status: 'unavailable',
        reason: 'provider_unconfigured',
        provider: { servedBy: null, attempted: [] },
      })
      expect(global.fetch).not.toHaveBeenCalled()
    } finally {
      if (originalHeliusKey === undefined) delete process.env.HELIUS_API_KEY
      else process.env.HELIUS_API_KEY = originalHeliusKey
      if (originalAlchemyKey === undefined) delete process.env.ALCHEMY_API_KEY
      else process.env.ALCHEMY_API_KEY = originalAlchemyKey
    }
  })

  it('records secret-safe Helius-to-Alchemy quota failover provenance', async () => {
    const originalHeliusKey = process.env.HELIUS_API_KEY
    const originalAlchemyKey = process.env.ALCHEMY_API_KEY
    const providerCalls: Array<'helius' | 'alchemy'> = []
    try {
      process.env.HELIUS_API_KEY = 'synthetic-helius-key'
      process.env.ALCHEMY_API_KEY = 'synthetic-alchemy-key'
      jest.resetModules()
      global.fetch = jest.fn(async (input) => {
        const provider = String(input).includes('helius-rpc.com') ? 'helius' : 'alchemy'
        providerCalls.push(provider)
        return {
          status: 200,
          text: async () =>
            JSON.stringify(
              provider === 'helius'
                ? {
                    jsonrpc: '2.0',
                    id: 1,
                    error: { code: -32000, message: 'quota exhausted' },
                  }
                : { jsonrpc: '2.0', id: 1, result: legacyFixture() }
            ),
        } as Response
      }) as jest.MockedFunction<typeof fetch>
      const freshModule = await import('../solana-fetch')

      const evidence = await freshModule.fetchTxEvidence(SIGNATURE)

      expect(providerCalls).toEqual(['helius', 'alchemy'])
      expect(evidence).toMatchObject({
        status: 'available',
        provider: { servedBy: 'alchemy', attempted: ['helius', 'alchemy'] },
      })
      expect(JSON.stringify(evidence)).not.toContain('synthetic-helius-key')
      expect(JSON.stringify(evidence)).not.toContain('synthetic-alchemy-key')
    } finally {
      if (originalHeliusKey === undefined) delete process.env.HELIUS_API_KEY
      else process.env.HELIUS_API_KEY = originalHeliusKey
      if (originalAlchemyKey === undefined) delete process.env.ALCHEMY_API_KEY
      else process.env.ALCHEMY_API_KEY = originalAlchemyKey
      jest.resetModules()
    }
  })
})
