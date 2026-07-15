import {
  fetchMoralisInternalBnb,
  moralisTxsToInternalLegs,
  scanMoralisInternalBnb,
} from '../moralis-bsc-internal'
import { NATIVE_BNB } from '../bsc-swaps'

const WALLET = '0x38e47FECE3ea323e864c65410F6458c820eAa897'

function nativeTx(hash: string, value = '1000000000000000000') {
  return {
    hash,
    block_timestamp: '2026-07-01T00:00:00.000Z',
    internal_transactions: [{ to: WALLET, value }],
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as Response
}

describe('moralisTxsToInternalLegs', () => {
  it('keeps only inbound internal BNB legs, wei→BNB, lowercased tx', () => {
    const legs = moralisTxsToInternalLegs(WALLET, [
      {
        hash: '0xABCDEF01',
        block_timestamp: '2026-07-01T00:00:00.000Z',
        internal_transactions: [
          { to: WALLET.toLowerCase(), value: '967301007013715773' }, // 0.9673 BNB in
          { to: '0xdeadbeef', value: '5000000000000000000' }, // outbound-ish → dropped
        ],
      },
    ])
    expect(legs).toHaveLength(1)
    expect(legs[0]).toMatchObject({
      token: NATIVE_BNB,
      to: WALLET.toLowerCase(),
      tx: '0xabcdef01',
      ts: '2026-07-01T00:00:00.000Z',
    })
    expect(legs[0].amount).toBeCloseTo(0.9673, 3)
  })

  it('drops zero/garbage values and malformed rows without throwing', () => {
    const legs = moralisTxsToInternalLegs(WALLET, [
      { hash: '0x1', internal_transactions: [{ to: WALLET, value: '0' }] },
      { hash: '0x2', internal_transactions: [{ to: WALLET, value: 'not-a-number' }] },
      { internal_transactions: [{ to: WALLET, value: '1000000000000000000' }] }, // no hash
      null as unknown as Record<string, never>,
    ])
    expect(legs).toHaveLength(0)
  })

  it('address match is case-insensitive (Moralis mixed-case `to`)', () => {
    const legs = moralisTxsToInternalLegs(WALLET.toLowerCase(), [
      {
        hash: '0x3',
        block_timestamp: '2026-07-02T12:00:00.000Z',
        internal_transactions: [{ to: WALLET, value: '442165520362351993' }],
      },
    ])
    expect(legs).toHaveLength(1)
    expect(legs[0].amount).toBeCloseTo(0.4422, 3)
  })
})

describe('scanMoralisInternalBnb', () => {
  const originalFetch = global.fetch
  const originalKey = process.env.MORALIS_API_KEY

  beforeEach(() => {
    process.env.MORALIS_API_KEY = 'test-key'
  })

  afterEach(() => {
    if (originalFetch) global.fetch = originalFetch
    else delete (global as typeof global & { fetch?: typeof fetch }).fetch
    if (originalKey === undefined) delete process.env.MORALIS_API_KEY
    else process.env.MORALIS_API_KEY = originalKey
    jest.restoreAllMocks()
  })

  it('proves completeness only after the Moralis cursor is exhausted', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ result: [nativeTx('0x1')], cursor: 'next page' }))
      .mockResolvedValueOnce(jsonResponse({ result: [] }))
    global.fetch = fetchMock as jest.MockedFunction<typeof fetch>

    const scan = await scanMoralisInternalBnb(WALLET, { maxPages: 2 })

    expect(scan.transfers).toHaveLength(1)
    expect(scan.coverage).toEqual({
      scanComplete: true,
      truncated: false,
      stopReason: 'history_exhausted',
      pagesFetched: 2,
      recordsSeen: 1,
      recordsReturned: 1,
      errors: [],
    })
    expect(String(fetchMock.mock.calls[1][0])).toContain('cursor=next%20page')
  })

  it('marks a remaining cursor at maxPages as an explicit truncation', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        jsonResponse({ result: [nativeTx('0x1')], cursor: 'more' })
      ) as jest.MockedFunction<typeof fetch>

    const scan = await scanMoralisInternalBnb(WALLET, { maxPages: 1 })

    expect(scan.transfers).toHaveLength(1)
    expect(scan.coverage).toMatchObject({
      scanComplete: false,
      truncated: true,
      stopReason: 'page_cap',
      pagesFetched: 1,
      recordsSeen: 1,
      recordsReturned: 1,
      errors: [],
    })
  })

  it('retains partial transfers but fails closed when a later page request fails', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ result: [nativeTx('0x1')], cursor: 'next' }))
      .mockResolvedValueOnce(jsonResponse({ message: 'unavailable' }, 503)) as jest.MockedFunction<
      typeof fetch
    >

    const scan = await scanMoralisInternalBnb(WALLET, { maxPages: 2 })

    expect(scan.transfers).toHaveLength(1)
    expect(scan.coverage).toMatchObject({
      scanComplete: false,
      truncated: true,
      stopReason: 'request_error',
      pagesFetched: 1,
      recordsSeen: 1,
      recordsReturned: 1,
      errors: ['Moralis request failed: HTTP 503'],
    })
  })

  it('does not confuse a malformed payload with an empty history', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ cursor: null })) as jest.MockedFunction<typeof fetch>

    const scan = await scanMoralisInternalBnb(WALLET)

    expect(scan.transfers).toEqual([])
    expect(scan.coverage).toMatchObject({
      scanComplete: false,
      truncated: false,
      stopReason: 'invalid_response',
      pagesFetched: 0,
      errors: ['Moralis response shape invalid'],
    })
  })

  it('does not claim completeness when a returned transaction cannot be normalized', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        result: [
          {
            hash: '0x1',
            block_timestamp: null,
            internal_transactions: [{ to: WALLET, value: '1000000000000000000' }],
          },
        ],
      })
    ) as jest.MockedFunction<typeof fetch>

    const scan = await scanMoralisInternalBnb(WALLET)

    expect(scan.transfers).toEqual([])
    expect(scan.coverage).toMatchObject({
      scanComplete: false,
      truncated: false,
      stopReason: 'invalid_response',
      pagesFetched: 0,
      errors: ['Moralis response shape invalid'],
    })
  })

  it('fails closed without a key and does not make a request', async () => {
    delete process.env.MORALIS_API_KEY
    const fetchMock = jest.fn()
    global.fetch = fetchMock as jest.MockedFunction<typeof fetch>

    const scan = await scanMoralisInternalBnb(WALLET)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(scan.coverage).toMatchObject({
      scanComplete: false,
      truncated: false,
      stopReason: 'missing_api_key',
      pagesFetched: 0,
      errors: ['MORALIS_API_KEY missing'],
    })
  })

  it('rejects an empty page that still advertises another cursor', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ result: [], cursor: 'more' })) as jest.MockedFunction<
      typeof fetch
    >

    const scan = await scanMoralisInternalBnb(WALLET)

    expect(scan.coverage).toMatchObject({
      scanComplete: false,
      truncated: true,
      stopReason: 'invalid_response',
      pagesFetched: 1,
      errors: ['Moralis returned an empty page with a cursor'],
    })
  })

  it('fails closed when Moralis repeats a cursor', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ result: [nativeTx('0x1')], cursor: 'same' }))
      .mockResolvedValueOnce(
        jsonResponse({ result: [nativeTx('0x2')], cursor: 'same' })
      ) as jest.MockedFunction<typeof fetch>

    const scan = await scanMoralisInternalBnb(WALLET, { maxPages: 3 })

    expect(scan.transfers).toHaveLength(2)
    expect(scan.coverage).toMatchObject({
      scanComplete: false,
      truncated: true,
      stopReason: 'invalid_response',
      pagesFetched: 2,
      errors: ['Moralis cursor repeated'],
    })
  })

  it('keeps the legacy array wrapper fail-soft on an upstream failure', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('timeout')) as jest.MockedFunction<
      typeof fetch
    >

    await expect(fetchMoralisInternalBnb(WALLET)).resolves.toEqual([])
  })

  it.each([0, -1, Number.NaN, 1.5])('rejects invalid maxPages=%s', async (maxPages) => {
    const fetchMock = jest.fn()
    global.fetch = fetchMock as jest.MockedFunction<typeof fetch>

    await expect(scanMoralisInternalBnb(WALLET, { maxPages })).rejects.toThrow(
      'maxPages must be a positive safe integer'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
