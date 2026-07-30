/**
 * @jest-environment node
 */

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { zeroOutExcluded } from '../write-leaderboard'
import type { TraderRow } from '../trader-row'

function excludedTraderMap(count = 1) {
  return new Map<string, TraderRow>(
    Array.from({ length: count }, (_, index) => {
      const id = `excluded-${index}`
      return [
        `binance_futures:${id}`,
        { source: 'binance_futures', source_trader_id: id } as TraderRow,
      ]
    })
  )
}

function zeroOutParams(overrides: Record<string, unknown> = {}) {
  return {
    supabase: { from: jest.fn() },
    season: '30D' as const,
    uniqueTraders: [],
    traderMap: excludedTraderMap(),
    freshPlatforms: ['binance_futures'],
    isOutOfTime: () => false,
    upsertAborted: false,
    timeLeftMs: () => 60_000,
    ...overrides,
  }
}

function updateSupabase(result: { error: { message: string } | null }) {
  const gt = jest.fn().mockResolvedValue(result)
  const inIds = jest.fn(() => ({ gt }))
  const sourceEq = jest.fn(() => ({ in: inIds }))
  const seasonEq = jest.fn(() => ({ eq: sourceEq }))
  const update = jest.fn(() => ({ eq: seasonEq }))
  const from = jest.fn(() => ({ update }))
  return { from, gt }
}

describe('zeroOutExcluded current-cohort finalization', () => {
  it('throws before mutation when the upstream leaderboard write was aborted', async () => {
    const from = jest.fn()

    await expect(
      zeroOutExcluded(
        zeroOutParams({ supabase: { from }, upsertAborted: true }) as Parameters<
          typeof zeroOutExcluded
        >[0]
      )
    ).rejects.toThrow('[30D] zero-out refused because leaderboard upsert was aborted')
    expect(from).not.toHaveBeenCalled()
  })

  it('throws before mutation when the initial deadline gate fails', async () => {
    const from = jest.fn()

    await expect(
      zeroOutExcluded(
        zeroOutParams({
          supabase: { from },
          isOutOfTime: () => true,
          timeLeftMs: () => 12_000,
        }) as Parameters<typeof zeroOutExcluded>[0]
      )
    ).rejects.toThrow('[30D] zero-out deadline reached with 12s remaining')
    expect(from).not.toHaveBeenCalled()
  })

  it('throws when the deadline is reached while processing excluded sources', async () => {
    const isOutOfTime = jest.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    const from = jest.fn()

    await expect(
      zeroOutExcluded(
        zeroOutParams({ supabase: { from }, isOutOfTime }) as Parameters<typeof zeroOutExcluded>[0]
      )
    ).rejects.toThrow('[30D] zero-out deadline reached after 0 traders')
    expect(from).not.toHaveBeenCalled()
  })

  it('re-checks the deadline before every update batch', async () => {
    const isOutOfTime = jest
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    const supabase = updateSupabase({ error: null })

    await expect(
      zeroOutExcluded(
        zeroOutParams({
          supabase,
          traderMap: excludedTraderMap(101),
          isOutOfTime,
        }) as Parameters<typeof zeroOutExcluded>[0]
      )
    ).rejects.toThrow('[30D] zero-out deadline reached after 100 traders')
    expect(supabase.gt).toHaveBeenCalledTimes(1)
  })

  it('propagates a returned database update error', async () => {
    const supabase = updateSupabase({ error: { message: 'update denied' } })

    await expect(
      zeroOutExcluded(zeroOutParams({ supabase }) as Parameters<typeof zeroOutExcluded>[0])
    ).rejects.toThrow('[30D] zero-out update failed for binance_futures: update denied')
  })

  it('propagates a thrown database update error', async () => {
    const supabase = updateSupabase({ error: null })
    supabase.gt.mockRejectedValue(new Error('connection reset'))

    await expect(
      zeroOutExcluded(zeroOutParams({ supabase }) as Parameters<typeof zeroOutExcluded>[0])
    ).rejects.toThrow('[30D] zero-out update threw for binance_futures: connection reset')
  })

  it('returns only after every excluded row update succeeds', async () => {
    const supabase = updateSupabase({ error: null })

    await expect(
      zeroOutExcluded(zeroOutParams({ supabase }) as Parameters<typeof zeroOutExcluded>[0])
    ).resolves.toBe(1)
  })
})
