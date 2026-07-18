export interface TraderFollowRow {
  user_id: string
  trader_id: string
  source: string | null
}

export interface CurrentRankRow {
  source_trader_id: string
  source: string
  rank: number | null
  roi: number | null
  pnl: number | null
}

export interface RankHistoryRow {
  trader_key: string
  platform: string
  rank: number | null
}

export interface DailySnapshotRow {
  trader_key: string
  platform: string
  roi: number | null
  pnl: number | null
}

export interface TraderEventPreferenceRow {
  id: string
  notify_trader_events: boolean | null
}

interface PageError {
  message: string
}

interface PageResult<T> {
  data: T[] | null
  error: PageError | null
}

export type BroadcastEventDataset =
  | 'follows'
  | 'currentRanks'
  | 'rankHistory'
  | 'dailySnapshots'
  | 'userPreferences'

type PageLoader<T> = (from: number, to: number) => PromiseLike<PageResult<T>>
type ChunkedPageLoader<T> = (
  filterIds: string[],
  from: number,
  to: number
) => PromiseLike<PageResult<T>>

export interface BroadcastEventPageLoaders {
  follows: PageLoader<TraderFollowRow>
  currentRanks: ChunkedPageLoader<CurrentRankRow>
  rankHistory: ChunkedPageLoader<RankHistoryRow>
  dailySnapshots: ChunkedPageLoader<DailySnapshotRow>
}

export interface BroadcastEventRows {
  follows: TraderFollowRow[]
  currentRanks: CurrentRankRow[]
  rankHistory: RankHistoryRow[]
  dailySnapshots: DailySnapshotRow[]
}

export class BroadcastEventDataReadError extends Error {
  constructor(
    readonly dataset: BroadcastEventDataset,
    message: string
  ) {
    super(`[broadcast-trader-events] ${dataset} pagination failed: ${message}`)
    this.name = 'BroadcastEventDataReadError'
  }
}

async function readAllPages<T>(
  dataset: BroadcastEventDataset,
  loadPage: PageLoader<T>,
  pageSize: number
): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; ; offset += pageSize) {
    let page: PageResult<T>
    try {
      page = await loadPage(offset, offset + pageSize - 1)
    } catch (error) {
      throw new BroadcastEventDataReadError(
        dataset,
        error instanceof Error ? error.message : String(error)
      )
    }
    if (page.error) {
      throw new BroadcastEventDataReadError(dataset, page.error.message)
    }
    const pageRows = page.data ?? []
    rows.push(...pageRows)
    if (pageRows.length < pageSize) return rows
  }
}

async function readAllChunkedPages<T>(
  dataset: BroadcastEventDataset,
  filterIds: string[],
  loadPage: ChunkedPageLoader<T>,
  pageSize: number,
  filterChunkSize: number
): Promise<T[]> {
  const rows: T[] = []
  for (let index = 0; index < filterIds.length; index += filterChunkSize) {
    const chunk = filterIds.slice(index, index + filterChunkSize)
    const chunkRows = await readAllPages(dataset, (from, to) => loadPage(chunk, from, to), pageSize)
    rows.push(...chunkRows)
  }
  return rows
}

export async function loadBroadcastEventRows(
  loaders: BroadcastEventPageLoaders,
  {
    pageSize = 1000,
    filterChunkSize = 300,
  }: {
    pageSize?: number
    filterChunkSize?: number
  } = {}
): Promise<BroadcastEventRows> {
  const follows = await readAllPages('follows', loaders.follows, pageSize)
  const traderIds = [
    ...new Set(follows.map((follow) => follow.trader_id).filter((traderId) => traderId.length > 0)),
  ]

  if (traderIds.length === 0) {
    return { follows, currentRanks: [], rankHistory: [], dailySnapshots: [] }
  }

  // Keep the reads sequential. If any page fails, no later dataset is read and
  // no partial input set can escape to the notification fan-out.
  const currentRanks = await readAllChunkedPages(
    'currentRanks',
    traderIds,
    loaders.currentRanks,
    pageSize,
    filterChunkSize
  )
  const rankHistory = await readAllChunkedPages(
    'rankHistory',
    traderIds,
    loaders.rankHistory,
    pageSize,
    filterChunkSize
  )
  const dailySnapshots = await readAllChunkedPages(
    'dailySnapshots',
    traderIds,
    loaders.dailySnapshots,
    pageSize,
    filterChunkSize
  )

  return { follows, currentRanks, rankHistory, dailySnapshots }
}

export async function loadBroadcastEventPreferences(
  userIds: string[],
  loadPage: ChunkedPageLoader<TraderEventPreferenceRow>,
  {
    pageSize = 1000,
    filterChunkSize = 300,
  }: {
    pageSize?: number
    filterChunkSize?: number
  } = {}
): Promise<TraderEventPreferenceRow[]> {
  const uniqueUserIds = [...new Set(userIds.filter((userId) => userId.length > 0))]
  return readAllChunkedPages('userPreferences', uniqueUserIds, loadPage, pageSize, filterChunkSize)
}
