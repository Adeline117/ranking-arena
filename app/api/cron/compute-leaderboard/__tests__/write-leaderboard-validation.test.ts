/**
 * @jest-environment node
 */

const mockValidateBeforeWrite = jest.fn()
const mockLogRejectedWrites = jest.fn()

jest.mock('@/lib/validation/data-write-gate', () => ({
  validateBeforeWrite: (...args: unknown[]) => mockValidateBeforeWrite(...args),
  logRejectedWrites: (...args: unknown[]) => mockLogRejectedWrites(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { upsertLeaderboard } from '../write-leaderboard'

describe('leaderboard validation failure propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('reports rejected rows as publication errors before any database write', async () => {
    mockValidateBeforeWrite.mockReturnValue({
      valid: [],
      rejected: [{ row: { source_trader_id: 'rejected' }, errors: ['invalid'] }],
    })
    const supabase = { from: jest.fn() }

    await expect(
      upsertLeaderboard({
        supabase: supabase as never,
        season: '30D',
        changedTraders: [
          {
            source: 'binance_futures',
            source_trader_id: 'rejected',
          } as never,
        ],
        prevRankMap: new Map(),
        isOutOfTime: () => false,
        timeLeftMs: () => 120_000,
      })
    ).resolves.toEqual({ upsertErrors: 1, upsertAborted: false })

    expect(mockLogRejectedWrites).toHaveBeenCalledTimes(1)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('preserves the live pre-write rank while withholding unversioned movement', async () => {
    mockValidateBeforeWrite.mockImplementation((rows: unknown[]) => ({
      valid: rows,
      rejected: [],
    }))
    const upsert = jest.fn().mockResolvedValue({ error: null })
    const from = jest.fn(() => ({ upsert }))

    await expect(
      upsertLeaderboard({
        supabase: { from } as never,
        season: '30D',
        changedTraders: [
          { source: 'binance_futures', source_trader_id: 'existing' } as never,
          { source: 'hyperliquid', source_trader_id: 'new' } as never,
        ],
        prevRankMap: new Map([['binance_futures:existing', 17]]),
        isOutOfTime: () => false,
        timeLeftMs: () => 120_000,
      })
    ).resolves.toEqual({ upsertErrors: 0, upsertAborted: false })

    const rankUpsertRows = upsert.mock.calls.at(-1)?.[0]
    expect(rankUpsertRows).toEqual([
      expect.objectContaining({
        source_trader_id: 'existing',
        rank: 17,
        rank_change: null,
        is_new: false,
      }),
      expect.objectContaining({
        source_trader_id: 'new',
        rank: null,
        rank_change: null,
        is_new: false,
      }),
    ])
  })
})
