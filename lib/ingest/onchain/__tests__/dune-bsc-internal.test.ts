import { internalRowsToTransfers, scanBscInternalBnb } from '../dune-bsc-internal'
import { NATIVE_BNB } from '../bsc-swaps'

const response = (body: unknown, ok = true, status = ok ? 200 : 500) =>
  ({ ok, status, json: async () => body }) as Response

describe('internalRowsToTransfers', () => {
  it('groups internal BNB rows into NATIVE_BNB in-legs per wallet (0x-keyed)', () => {
    const m = internalRowsToTransfers([
      {
        wallet: 'be6c8068b476af0f70648e33b55600398a73b81c',
        tx_hash: 'aa',
        bnb: 2.5,
        block_time: '2026-06-15 12:00:00.000 UTC',
      },
      {
        wallet: 'be6c8068b476af0f70648e33b55600398a73b81c',
        tx_hash: 'bb',
        bnb: 1.0,
        block_time: '2026-06-16 00:00:00.000 UTC',
      },
      {
        wallet: '3d9a4972111111111111111111111111111111ff',
        tx_hash: 'cc',
        bnb: 5,
        block_time: '2026-06-10 00:00:00.000 UTC',
      },
    ])
    const w1 = m.get('0xbe6c8068b476af0f70648e33b55600398a73b81c')!
    expect(w1).toHaveLength(2)
    expect(w1[0]).toMatchObject({ token: NATIVE_BNB, amount: 2.5, tx: '0xaa' })
    expect(w1[0].to).toBe('0xbe6c8068b476af0f70648e33b55600398a73b81c')
    expect(m.get('0x3d9a4972111111111111111111111111111111ff')).toHaveLength(1)
  })

  it('skips rows with no/zero/invalid bnb or missing fields', () => {
    const m = internalRowsToTransfers([
      { wallet: 'aa', tx_hash: 't', bnb: 0 },
      { wallet: 'aa', tx_hash: 't', bnb: -1 },
      { wallet: 'aa', bnb: 5 }, // no tx_hash
      { tx_hash: 't', bnb: 5 }, // no wallet
    ])
    expect(m.size).toBe(0)
  })

  it('injected in-legs pair with token-out to form a BSC sell', async () => {
    const { decodeTransfersToSwaps, bscQuoteConfig } = await import('../bsc-swaps')
    const { computeWalletPnl } = await import('../pnl-accounting')
    const W = '0xbe6c8068b476af0f70648e33b55600398a73b81c'
    const TOKEN = '0x3333333333333333333333333333333333333333'
    // buy token for 1 BNB, then sell it — proceeds arrive via Dune internal leg.
    const alchemy = [
      {
        token: 'native:bnb',
        from: W,
        to: '0xpool',
        amount: 1,
        tx: '0xbuy',
        ts: '2026-06-01T00:00:00Z',
      },
      {
        token: TOKEN,
        from: '0xpool',
        to: W,
        amount: 1000,
        tx: '0xbuy',
        ts: '2026-06-01T00:00:00Z',
      },
      {
        token: TOKEN,
        from: W,
        to: '0xpool',
        amount: 1000,
        tx: '0xsell',
        ts: '2026-06-05T00:00:00Z',
      },
    ]
    const dune = internalRowsToTransfers([
      {
        wallet: W.replace('0x', ''),
        tx_hash: 'sell',
        bnb: 2,
        block_time: '2026-06-05 00:00:00.000 UTC',
      },
    ]).get(W)!
    const swaps = decodeTransfersToSwaps([...alchemy, ...dune], W, bscQuoteConfig(600))
    const pnl = computeWalletPnl(swaps)
    expect(pnl.txsBuy).toBe(1)
    expect(pnl.txsSell).toBe(1) // the Dune leg completed the sell
    expect(pnl.realizedPnlUsd).toBeCloseTo(600, 0) // sold 2 BNB($1200) − cost 1 BNB($600)
  })
})

describe('scanBscInternalBnb', () => {
  const originalKey = process.env.DUNE_API_KEY
  const originalFetch = global.fetch

  beforeEach(() => {
    process.env.DUNE_API_KEY = 'test-key'
  })

  afterEach(() => {
    if (originalFetch) global.fetch = originalFetch
    else delete (global as typeof global & { fetch?: typeof fetch }).fetch
    if (originalKey === undefined) delete process.env.DUNE_API_KEY
    else process.env.DUNE_API_KEY = originalKey
  })

  it('proves a successful zero-row result instead of conflating it with failure', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(response({ execution_id: 'exec-1' }))
      .mockResolvedValueOnce(response({ state: 'QUERY_STATE_COMPLETED' }))
      .mockResolvedValueOnce(response({ state: 'QUERY_STATE_COMPLETED', result: { rows: [] } }))
    global.fetch = fetchMock as jest.MockedFunction<typeof fetch>

    const scan = await scanBscInternalBnb(['0xABC'], { pollMs: 0 })

    expect(scan.transfersByWallet.size).toBe(0)
    expect(scan.coverage).toEqual({
      scanComplete: true,
      truncated: false,
      stopReason: 'results_complete',
      walletsRequested: 1,
      pagesFetched: 1,
      rowsFetched: 0,
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('follows result pagination until Dune supplies no next page', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(response({ execution_id: 'exec-2' }))
      .mockResolvedValueOnce(response({ state: 'QUERY_STATE_COMPLETED' }))
      .mockResolvedValueOnce(
        response({
          state: 'QUERY_STATE_COMPLETED',
          result: {
            rows: [
              {
                wallet: 'abc',
                tx_hash: 'first',
                bnb: 1,
                block_time: '2026-07-01T00:00:00Z',
              },
            ],
          },
          next_offset: 1,
          next_uri: 'https://api.dune.com/api/v1/execution/exec-2/results?offset=1&limit=1',
        })
      )
      .mockResolvedValueOnce(
        response({
          state: 'QUERY_STATE_COMPLETED',
          result: {
            rows: [
              {
                wallet: 'abc',
                tx_hash: 'second',
                bnb: 2,
                block_time: '2026-07-02T00:00:00Z',
              },
            ],
          },
        })
      )
    global.fetch = fetchMock as jest.MockedFunction<typeof fetch>

    const scan = await scanBscInternalBnb(['0xABC', '0xabc'], {
      pollMs: 0,
      resultPageSize: 1,
    })

    expect(scan.coverage).toMatchObject({
      scanComplete: true,
      truncated: false,
      pagesFetched: 2,
      rowsFetched: 2,
      walletsRequested: 1,
    })
    expect(scan.transfersByWallet.get('0xabc')).toHaveLength(2)
    expect(String(fetchMock.mock.calls[3][0])).toContain('offset=1')
  })

  it('fails closed when polling never reaches a completed terminal state', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({ execution_id: 'exec-3' }))
      .mockResolvedValue(response({ state: 'QUERY_STATE_EXECUTING' })) as jest.MockedFunction<
      typeof fetch
    >

    const scan = await scanBscInternalBnb(['0xabc'], { pollMs: 0, maxPolls: 2 })

    expect(scan.coverage).toMatchObject({
      scanComplete: false,
      truncated: false,
      stopReason: 'poll_limit',
      pagesFetched: 0,
    })
  })

  it('marks a partial execution truncated and never reads partial results', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(response({ execution_id: 'exec-4' }))
      .mockResolvedValueOnce(response({ state: 'QUERY_STATE_COMPLETED_PARTIAL' }))
    global.fetch = fetchMock as jest.MockedFunction<typeof fetch>

    const scan = await scanBscInternalBnb(['0xabc'], { pollMs: 0 })

    expect(scan.coverage).toMatchObject({
      scanComplete: false,
      truncated: true,
      stopReason: 'execution_partial',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not call Dune or claim coverage without an API key', async () => {
    delete process.env.DUNE_API_KEY
    const fetchMock = jest.fn()
    global.fetch = fetchMock as jest.MockedFunction<typeof fetch>

    const scan = await scanBscInternalBnb(['0xabc'])

    expect(scan.coverage.stopReason).toBe('api_key_missing')
    expect(scan.coverage.scanComplete).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('marks a remaining next page truncated when the result page cap is reached', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({ execution_id: 'exec-5' }))
      .mockResolvedValueOnce(response({ state: 'QUERY_STATE_COMPLETED' }))
      .mockResolvedValueOnce(
        response({
          state: 'QUERY_STATE_COMPLETED',
          result: {
            rows: [
              {
                wallet: 'abc',
                tx_hash: 'only-page',
                bnb: 1,
                block_time: '2026-07-01T00:00:00Z',
              },
            ],
          },
          next_offset: 1,
          next_uri: 'https://api.dune.com/next',
        })
      ) as jest.MockedFunction<typeof fetch>

    const scan = await scanBscInternalBnb(['0xabc'], {
      pollMs: 0,
      maxResultPages: 1,
    })

    expect(scan.coverage).toMatchObject({
      scanComplete: false,
      truncated: true,
      stopReason: 'result_page_cap',
      pagesFetched: 1,
      rowsFetched: 1,
    })
  })

  it('rejects a malformed result page instead of treating it as zero rows', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(response({ execution_id: 'exec-6' }))
      .mockResolvedValueOnce(response({ state: 'QUERY_STATE_COMPLETED' }))
      .mockResolvedValueOnce(
        response({ state: 'QUERY_STATE_COMPLETED', result: { rows: null } })
      ) as jest.MockedFunction<typeof fetch>

    const scan = await scanBscInternalBnb(['0xabc'], { pollMs: 0 })

    expect(scan.coverage).toMatchObject({
      scanComplete: false,
      stopReason: 'invalid_response',
      rowsFetched: 0,
    })
  })
})
