/**
 * @jest-environment node
 */

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

import { atomicPlatformCleanup, cleanupStaleRows, rerankAllRows } from '../rerank-cleanup'

describe('stale leaderboard row cleanup', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-18T12:00:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('deletes old rows only for a source with a fresh source-data watermark', async () => {
    const freshnessGte = jest.fn().mockResolvedValue({
      data: [{ source: 'fresh_source' }],
      error: null,
    })
    const freshnessEq = jest.fn(() => ({ gte: freshnessGte }))
    const freshnessSelect = jest.fn(() => ({ eq: freshnessEq }))

    const staleLimit = jest.fn().mockResolvedValue({
      data: [
        { id: 'fresh-zombie', source: 'fresh_source' },
        { id: 'stale-last-good', source: 'stale_source' },
      ],
      error: null,
    })
    const staleLt = jest.fn(() => ({ limit: staleLimit }))
    const staleEq = jest.fn(() => ({ lt: staleLt }))
    const staleSelect = jest.fn(() => ({ eq: staleEq }))
    const deleteIn = jest.fn().mockResolvedValue({ error: null })
    const deleteRows = jest.fn(() => ({ in: deleteIn }))

    const from = jest.fn((table: string) => {
      if (table === 'leaderboard_source_freshness') return { select: freshnessSelect }
      if (table === 'leaderboard_ranks') return { select: staleSelect, delete: deleteRows }
      throw new Error(`unexpected table ${table}`)
    })

    await expect(cleanupStaleRows({ from } as never, '90D')).resolves.toBe(1)

    expect(freshnessEq).toHaveBeenCalledWith('season_id', '90D')
    expect(freshnessGte).toHaveBeenCalledWith('source_as_of', '2026-07-16T12:00:00.000Z')
    expect(staleSelect).toHaveBeenCalledWith('id,source')
    expect(deleteIn).toHaveBeenCalledWith('id', ['fresh-zombie'])
    expect(JSON.stringify(deleteIn.mock.calls)).not.toContain('stale-last-good')
  })

  it('deletes nothing when provenance is missing or unreadable', async () => {
    const freshnessGte = jest.fn().mockResolvedValue({
      data: null,
      error: { message: 'unavailable' },
    })
    const from = jest.fn((table: string) => {
      if (table === 'leaderboard_source_freshness') {
        return {
          select: () => ({
            eq: () => ({ gte: freshnessGte }),
          }),
        }
      }
      throw new Error('leaderboard rows must not be queried without provenance')
    })

    await expect(cleanupStaleRows({ from } as never, '7D')).resolves.toBe(0)
    expect(from).toHaveBeenCalledTimes(1)
  })

  it('surfaces stale-row delete failures', async () => {
    const freshnessGte = jest.fn().mockResolvedValue({
      data: [{ source: 'fresh_source' }],
      error: null,
    })
    const staleLimit = jest.fn().mockResolvedValue({
      data: [{ id: 'zombie', source: 'fresh_source' }],
      error: null,
    })
    const deleteIn = jest.fn().mockResolvedValue({ error: { message: 'delete failed' } })
    const from = jest.fn((table: string) => {
      if (table === 'leaderboard_source_freshness') {
        return {
          select: () => ({
            eq: () => ({ gte: freshnessGte }),
          }),
        }
      }
      return {
        select: () => ({
          eq: () => ({
            lt: () => ({ limit: staleLimit }),
          }),
        }),
        delete: () => ({ in: deleteIn }),
      }
    })

    await expect(cleanupStaleRows({ from } as never, '90D')).rejects.toThrow(
      'stale-row cleanup failed: delete failed'
    )
  })
})

describe('required leaderboard finalization', () => {
  it('surfaces a rerank RPC failure', async () => {
    const rpc = jest.fn().mockResolvedValue({
      error: { code: 'XX000', message: 'rerank failed' },
    })

    await expect(rerankAllRows({ rpc } as never, '90D')).rejects.toThrow(
      '90D: re-rank failed: rerank failed'
    )
  })

  it('surfaces an inline rerank write failure', async () => {
    const rpc = jest.fn().mockResolvedValue({
      error: { code: '42883', message: 'missing' },
    })
    const order = jest
      .fn()
      .mockResolvedValue({ data: [{ id: 'row-1', arena_score: 90 }], error: null })
    const upsert = jest.fn().mockResolvedValue({ error: { message: 'write failed' } })
    const from = jest.fn(() => ({
      select: () => ({
        eq: () => ({ order }),
      }),
      upsert,
    }))

    await expect(rerankAllRows({ rpc, from } as never, '7D')).rejects.toThrow(
      '7D: inline re-rank write failed: write failed'
    )
  })

  it('surfaces platform cleanup failures', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: null,
      error: { code: 'XX000', message: 'cleanup failed' },
    })

    await expect(
      atomicPlatformCleanup(
        { rpc } as never,
        '30D',
        ['binance_futures'],
        new Map([['binance_futures', ['trader-1']]])
      )
    ).rejects.toThrow('30D: cleanup RPC failed for binance_futures: cleanup failed')
  })
})
