import type { SupabaseClient } from '@supabase/supabase-js'
import { EXCHANGE_RANKINGS_QUERY_TIMEOUT_MS, getExchangeRankings } from '../exchange-rankings'

function rpcClient(data: unknown, error: unknown = null): SupabaseClient {
  return {
    rpc: jest.fn(() => ({
      abortSignal: jest.fn().mockResolvedValue({ data, error }),
    })),
  } as unknown as SupabaseClient
}

function payload(timeframe: 7 | 30 | 90, rows: unknown[] = []) {
  return { nonLegacyCount: 4, timeframe, rows }
}

describe('getExchangeRankings', () => {
  it('hard-times-out a transport that ignores its abort signal', async () => {
    jest.useFakeTimers()
    try {
      const client = {
        rpc: jest.fn(() => ({
          abortSignal: jest.fn(() => new Promise(() => undefined)),
        })),
      } as unknown as SupabaseClient

      const result = getExchangeRankings(client, 90)
      const assertion = expect(result).rejects.toThrow('Exchange rankings request failed for 90D')
      await jest.advanceTimersByTimeAsync(EXCHANGE_RANKINGS_QUERY_TIMEOUT_MS)

      await assertion
    } finally {
      jest.useRealTimers()
    }
  })

  it('throws on RPC failure so transport errors cannot become empty rankings', async () => {
    await expect(getExchangeRankings(rpcClient(null, { message: 'boom' }), 90)).rejects.toThrow(
      'Exchange rankings request failed for 90D'
    )
  })

  it('throws on malformed responses instead of treating schema drift as empty data', async () => {
    await expect(getExchangeRankings(rpcClient({ rows: [] }), 30)).rejects.toThrow(
      'Exchange rankings returned an invalid 30D response'
    )
    await expect(getExchangeRankings(rpcClient({ nonLegacyCount: 4 }), 30)).rejects.toThrow(
      'Exchange rankings returned an invalid 30D response'
    )
    await expect(getExchangeRankings(rpcClient('not-json-object'), 30)).rejects.toThrow(
      'Exchange rankings returned an invalid 30D response'
    )
  })

  it('rejects a cross-timeframe response instead of relabelling it as the requested scope', async () => {
    await expect(getExchangeRankings(rpcClient(payload(7)), 90)).rejects.toThrow(
      'Exchange rankings returned an invalid 90D response'
    )
  })

  it('rejects malformed rows instead of silently collapsing them into an empty success', async () => {
    await expect(
      getExchangeRankings(
        rpcClient(
          payload(30, [
            {
              source: 'hyperliquid',
              asOf: 'not-a-timestamp',
            },
          ])
        ),
        30
      )
    ).rejects.toThrow('Exchange rankings returned an invalid 30D response')
  })

  it('keeps a successful empty response distinct from request failure', async () => {
    await expect(getExchangeRankings(rpcClient(payload(7)), 7)).resolves.toEqual({
      nonLegacyCount: 4,
      timeframe: 7,
      rows: [],
    })
  })

  it('accepts a fully bound row without coercing its metrics or currency', async () => {
    const row = {
      source: 'hyperliquid',
      exchangeSlug: 'hyperliquid',
      exchangeName: 'Hyperliquid',
      productType: 'onchain',
      currency: 'USDC',
      derived: false,
      asOf: '2026-08-03T12:00:00.000Z',
      rankedTraders: 20,
      medianRoi: 12.5,
      topDecileRoi: 42,
      pctProfitable: 60,
      copierPnl: { value: 1234.5, currency: 'USDC' },
      botShare: null,
    }

    await expect(getExchangeRankings(rpcClient(payload(90, [row])), 90)).resolves.toEqual({
      nonLegacyCount: 4,
      timeframe: 90,
      rows: [
        {
          source: 'hyperliquid',
          exchangeSlug: 'hyperliquid',
          exchangeName: 'Hyperliquid',
          productType: 'onchain',
          currency: 'USDC',
          rankedTraders: 20,
          medianRoi: 12.5,
          topDecileRoi: 42,
          pctProfitable: 60,
          copierPnl: { value: 1234.5, currency: 'USDC' },
          botShare: null,
          provenance: {
            source: 'hyperliquid',
            asOf: '2026-08-03T12:00:00.000Z',
            derived: false,
          },
        },
      ],
    })
  })
})
