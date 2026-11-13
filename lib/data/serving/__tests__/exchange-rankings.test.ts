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

  it('keeps an unknown currency null and drops unit-less money (never defaults to USDT)', async () => {
    const base = { source: 'x_futures', asOf: '2026-11-12T00:00:00Z', copierPnl: { value: 12 } }
    const result = await getExchangeRankings(
      rpcClient({
        nonLegacyCount: 3,
        rows: [
          { ...base, currency: null },
          { ...base, source: 'y_futures', currency: 'BTC' },
          { ...base, source: 'z_futures', currency: 'USDC' },
        ],
      }),
      30
    )
    expect(result.rows.map((r) => [r.source, r.currency, r.copierPnl])).toEqual([
      ['x_futures', null, null],
      ['y_futures', null, null],
      ['z_futures', 'USDC', { value: 12, currency: 'USDC' }],
    ])
  })
})
