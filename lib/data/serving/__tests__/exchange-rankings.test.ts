import type { SupabaseClient } from '@supabase/supabase-js'
import { getExchangeRankings } from '../exchange-rankings'

function rpcClient(data: unknown, error: unknown = null): SupabaseClient {
  return { rpc: jest.fn().mockResolvedValue({ data, error }) } as unknown as SupabaseClient
}

describe('getExchangeRankings', () => {
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
  })

  it('keeps a successful empty response distinct from request failure', async () => {
    await expect(
      getExchangeRankings(rpcClient({ nonLegacyCount: 4, rows: [] }), 7)
    ).resolves.toEqual({
      nonLegacyCount: 4,
      timeframe: 7,
      rows: [],
    })
  })

  it('keeps an unknown product type unknown instead of defaulting to futures', async () => {
    const row = { source: 'some_spot', asOf: '2026-11-12T00:00:00Z', rankedTraders: 3 }
    const result = await getExchangeRankings(
      rpcClient({
        nonLegacyCount: 4,
        rows: [
          { ...row, productType: null },
          { ...row, source: 'weird', productType: 'perp-ish' },
          { ...row, source: 'spot_ok', productType: 'spot' },
        ],
      }),
      90
    )
    expect(result.rows.map((r) => r.productType)).toEqual([null, null, 'spot'])
  })
})
