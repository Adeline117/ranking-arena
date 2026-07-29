const mockReadSealedRankingGeneration = jest.fn()
jest.mock('@/lib/rankings/read-sealed-ranking-generation', () => ({
  readSealedRankingGeneration: (...args: unknown[]) => mockReadSealedRankingGeneration(...args),
}))

import { PUBLIC_ACTIVE_RANKING_SOURCES } from '@/lib/constants/exchanges'
import { filterPublicRankingSources } from '@/lib/rankings/publication-policy'
import { readRankingExportRows } from '@/lib/rankings/read-ranking-export'

const COHORT_ID = '11111111-1111-4111-8111-111111111111'

function queryResult(data: unknown[] | null, error: { message: string } | null = null) {
  const result = { data, error }
  const methods: Record<string, jest.Mock> = {}
  const proxy = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (
            resolve: (value: typeof result) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve(result).then(resolve, reject)
        }
        const key = String(property)
        methods[key] ??= jest.fn(() => proxy)
        return methods[key]
      },
    }
  )
  return proxy
}

describe('readRankingExportRows', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockReadSealedRankingGeneration.mockImplementation(
      async (
        _client: unknown,
        input: { season: string; sources: string[] },
        reader: (publication: { scoreCohortId: string }) => Promise<unknown>
      ) => ({
        value: await reader({ scoreCohortId: COHORT_ID }),
        input,
      })
    )
  })

  it('binds the requested window, public sources, and deterministic order to one cohort', async () => {
    const query = queryResult([{ source: 'binance_futures', trader_id: 'trader-1' }])
    const supabase = { from: jest.fn(() => query) } as never
    const expectedSources = filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES)

    const rows = await readRankingExportRows(supabase, {
      season: '30D',
      limit: 500,
    })

    expect(mockReadSealedRankingGeneration).toHaveBeenCalledWith(
      supabase,
      { season: '30D', sources: expectedSources },
      expect.any(Function),
      { timeoutMs: 10_000 }
    )
    expect(query.eq).toHaveBeenCalledWith('season_id', '30D')
    expect(query.filter).toHaveBeenCalledWith('rank_publication_id', 'eq', COHORT_ID)
    expect(query.in).toHaveBeenCalledWith('source', expectedSources)
    expect(query.order.mock.calls).toEqual([
      ['rank', { ascending: true }],
      ['source', { ascending: true }],
      ['source_trader_id', { ascending: true }],
    ])
    expect(query.limit).toHaveBeenCalledWith(500)
    expect(rows).toEqual([{ source: 'binance_futures', trader_id: 'trader-1' }])
  })

  it('uses one exact canonical exchange as both proof and row scope', async () => {
    const query = queryResult([])
    const supabase = { from: jest.fn(() => query) } as never

    await readRankingExportRows(supabase, {
      exchange: 'binance_futures',
      season: '7D',
      limit: 10,
    })

    expect(mockReadSealedRankingGeneration).toHaveBeenCalledWith(
      supabase,
      { season: '7D', sources: ['binance_futures'] },
      expect.any(Function),
      { timeoutMs: 10_000 }
    )
    expect(query.in).toHaveBeenCalledWith('source', ['binance_futures'])
  })

  it('rejects aliases before proof or database access', async () => {
    const supabase = { from: jest.fn() } as never

    await expect(
      readRankingExportRows(supabase, {
        exchange: 'binance',
        season: '90D',
        limit: 10,
      })
    ).rejects.toThrow('not a canonical public source')

    expect(mockReadSealedRankingGeneration).not.toHaveBeenCalled()
    expect((supabase as { from: jest.Mock }).from).not.toHaveBeenCalled()
  })

  it('fails closed on database errors and null payloads', async () => {
    const errorQuery = queryResult(null, { message: 'database unavailable' })
    await expect(
      readRankingExportRows({ from: jest.fn(() => errorQuery) } as never, {
        exchange: 'binance_futures',
        season: '90D',
        limit: 10,
      })
    ).rejects.toThrow('ranking export query failed: database unavailable')
  })
})
