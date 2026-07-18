import {
  BroadcastEventDataReadError,
  loadBroadcastEventPreferences,
  loadBroadcastEventRows,
  type BroadcastEventPageLoaders,
  type CurrentRankRow,
  type DailySnapshotRow,
  type RankHistoryRow,
  type TraderEventPreferenceRow,
  type TraderFollowRow,
} from '../event-data'

const PAGE_SIZE = 1000

function page<T>(row: T): T[] {
  return Array.from({ length: PAGE_SIZE }, () => row)
}

function follow(index: number): TraderFollowRow {
  return {
    user_id: `user-${index}`,
    trader_id: `trader-${index}`,
    source: 'bybit',
  }
}

const currentRank: CurrentRankRow = {
  source_trader_id: 'trader-0',
  source: 'bybit',
  rank: 1,
  roi: 12,
  pnl: 100,
}

const rankHistory: RankHistoryRow = {
  trader_key: 'trader-0',
  platform: 'bybit',
  rank: 3,
}

const dailySnapshot: DailySnapshotRow = {
  trader_key: 'trader-0',
  platform: 'bybit',
  roi: 8,
  pnl: 70,
}

describe('broadcast trader event data pagination', () => {
  it('reads more than 1,000 rows from every input and chunks large trader-id filters', async () => {
    const firstChunk = Array.from({ length: 300 }, (_, index) => `trader-${index}`)
    const follows = jest.fn(async (from: number) => {
      if (from === 0) {
        return {
          data: Array.from({ length: PAGE_SIZE }, (_, index) => follow(index)),
          error: null,
        }
      }
      return { data: [follow(PAGE_SIZE)], error: null }
    })
    const pagedChunkLoader = <T>(row: T) =>
      jest.fn(async (traderIds: string[], from: number) => {
        if (traderIds[0] !== 'trader-0') return { data: [], error: null }
        return from === 0 ? { data: page(row), error: null } : { data: [row], error: null }
      })
    const currentRanks = pagedChunkLoader(currentRank)
    const rankHistoryRows = pagedChunkLoader(rankHistory)
    const dailySnapshots = pagedChunkLoader(dailySnapshot)

    const result = await loadBroadcastEventRows({
      follows,
      currentRanks,
      rankHistory: rankHistoryRows,
      dailySnapshots,
    })

    expect(result.follows).toHaveLength(1001)
    expect(result.currentRanks).toHaveLength(1001)
    expect(result.rankHistory).toHaveLength(1001)
    expect(result.dailySnapshots).toHaveLength(1001)
    expect(follows).toHaveBeenNthCalledWith(1, 0, 999)
    expect(follows).toHaveBeenNthCalledWith(2, 1000, 1999)

    for (const loader of [currentRanks, rankHistoryRows, dailySnapshots]) {
      expect(loader).toHaveBeenNthCalledWith(1, firstChunk, 0, 999)
      expect(loader).toHaveBeenNthCalledWith(2, firstChunk, 1000, 1999)
      expect(loader.mock.calls).toHaveLength(5)
      expect(loader.mock.calls[4][0]).toHaveLength(101)
    }
  })

  it.each(['follows', 'currentRanks', 'rankHistory', 'dailySnapshots'] as const)(
    'discards the whole input set when a later %s page fails',
    async (failureTarget) => {
      const follows = jest.fn(async (from: number) => {
        if (failureTarget !== 'follows') return { data: [follow(0)], error: null }
        return from === 0
          ? { data: page(follow(0)), error: null }
          : { data: null, error: { message: 'follows page failed' } }
      })
      const loader = <T>(name: keyof BroadcastEventPageLoaders, row: T) =>
        jest.fn(async (_traderIds: string[], from: number) => {
          if (failureTarget !== name) return { data: [row], error: null }
          return from === 0
            ? { data: page(row), error: null }
            : { data: null, error: { message: `${name} page failed` } }
        })
      const currentRanks = loader('currentRanks', currentRank)
      const rankHistoryRows = loader('rankHistory', rankHistory)
      const dailySnapshots = loader('dailySnapshots', dailySnapshot)

      const result = loadBroadcastEventRows({
        follows,
        currentRanks,
        rankHistory: rankHistoryRows,
        dailySnapshots,
      })

      await expect(result).rejects.toMatchObject<Partial<BroadcastEventDataReadError>>({
        name: 'BroadcastEventDataReadError',
        dataset: failureTarget,
      })

      if (failureTarget === 'follows') {
        expect(currentRanks).not.toHaveBeenCalled()
        expect(rankHistoryRows).not.toHaveBeenCalled()
        expect(dailySnapshots).not.toHaveBeenCalled()
      } else if (failureTarget === 'currentRanks') {
        expect(rankHistoryRows).not.toHaveBeenCalled()
        expect(dailySnapshots).not.toHaveBeenCalled()
      } else if (failureTarget === 'rankHistory') {
        expect(dailySnapshots).not.toHaveBeenCalled()
      }
    }
  )

  it('reads 1,001 user preferences across bounded id chunks and result pages', async () => {
    const userIds = Array.from({ length: 1001 }, (_, index) => `user-${index}`)
    const loadPage = jest.fn(async (chunk: string[], from: number, to: number) => ({
      data: chunk.slice(from, to + 1).map<TraderEventPreferenceRow>((id, index) => ({
        id,
        notify_trader_events: index % 2 === 0,
      })),
      error: null,
    }))

    const result = await loadBroadcastEventPreferences(userIds, loadPage, {
      pageSize: 128,
      filterChunkSize: 300,
    })

    expect(result).toHaveLength(1001)
    expect(new Set(result.map((preference) => preference.id)).size).toBe(1001)
    expect(loadPage).toHaveBeenNthCalledWith(1, userIds.slice(0, 300), 0, 127)
    expect(loadPage).toHaveBeenNthCalledWith(2, userIds.slice(0, 300), 128, 255)
    expect(loadPage).toHaveBeenNthCalledWith(3, userIds.slice(0, 300), 256, 383)
    expect(loadPage).toHaveBeenLastCalledWith(userIds.slice(900), 0, 127)
    expect(loadPage).toHaveBeenCalledTimes(10)
    for (const [chunk] of loadPage.mock.calls) expect(chunk.length).toBeLessThanOrEqual(300)
  })

  it('discards all user preferences when a later id chunk fails', async () => {
    const userIds = Array.from({ length: 1001 }, (_, index) => `user-${index}`)
    const loadPage = jest.fn(async (chunk: string[]) => {
      if (chunk[0] === 'user-300') {
        return { data: null, error: { message: 'preference page failed' } }
      }
      return {
        data: chunk.map<TraderEventPreferenceRow>((id) => ({
          id,
          notify_trader_events: true,
        })),
        error: null,
      }
    })

    await expect(loadBroadcastEventPreferences(userIds, loadPage)).rejects.toMatchObject<
      Partial<BroadcastEventDataReadError>
    >({
      name: 'BroadcastEventDataReadError',
      dataset: 'userPreferences',
    })
    expect(loadPage).toHaveBeenCalledTimes(2)
  })
})
