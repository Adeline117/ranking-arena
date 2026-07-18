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

import { cleanupStaleRows } from '../rerank-cleanup'

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
})
