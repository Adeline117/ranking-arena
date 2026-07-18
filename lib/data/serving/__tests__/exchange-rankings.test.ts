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
})
