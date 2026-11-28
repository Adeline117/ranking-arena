import { readServedRankingSources } from '../served-ranking-sources'

type Client = Parameters<typeof readServedRankingSources>[0]

function client(result: unknown) {
  const rpc = jest.fn().mockResolvedValue(result)
  return { client: { rpc } as unknown as Client, rpc }
}

describe('readServedRankingSources', () => {
  it('lists each served public source once with its published count and record time', async () => {
    const { client: supabase, rpc } = client({
      data: [
        { filter_source: 'bybit', trader_count: 40, cache_updated_at: '2026-11-27T01:00:00Z' },
        // A second registry row under the same public name.
        { filter_source: 'bybit', trader_count: 40, cache_updated_at: '2026-11-27T01:00:00Z' },
        { filter_source: 'gmx', trader_count: 7, cache_updated_at: '2026-11-27T02:00:00Z' },
      ],
      error: null,
    })

    await expect(readServedRankingSources(supabase)).resolves.toEqual([
      { source: 'bybit', publishedCount: 40, recordedAt: '2026-11-27T01:00:00Z' },
      { source: 'gmx', publishedCount: 7, recordedAt: '2026-11-27T02:00:00Z' },
    ])
    expect(rpc).toHaveBeenCalledWith('arena_visible_sources', { p_season_id: '90D' })
  })

  it('throws on a database error instead of reporting no sources', async () => {
    const { client: supabase } = client({ data: null, error: { message: 'timeout' } })

    await expect(readServedRankingSources(supabase)).rejects.toThrow('timeout')
  })
})
