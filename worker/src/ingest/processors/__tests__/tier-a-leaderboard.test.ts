import type { Job } from 'bullmq'
import type { ParsedLeaderboardRow, RawPage, SourceRow } from '@/lib/ingest/core/types'
import type { TierJobData } from '../../queues'

const mockGetSourceBySlug = jest.fn()
const mockNativeRankingTimeframes = jest.fn()
const mockGetAdapter = jest.fn()
const mockOpenSession = jest.fn()
const mockSessionClose = jest.fn()
const mockWriteRawObject = jest.fn()
const mockRecordFieldInventory = jest.fn()
const mockValidateLeaderboardRows = jest.fn()
const mockPublishLeaderboardSnapshot = jest.fn()
const mockPublishBoardSeries = jest.fn()

jest.mock('@/lib/ingest/sources', () => ({
  getSourceBySlug: (...args: unknown[]) => mockGetSourceBySlug(...args),
  nativeRankingTimeframes: (...args: unknown[]) => mockNativeRankingTimeframes(...args),
}))
jest.mock('@/lib/ingest/core/adapter', () => ({
  getAdapter: (...args: unknown[]) => mockGetAdapter(...args),
}))
jest.mock('@/lib/ingest/fetch/fetcher', () => ({
  openSession: (...args: unknown[]) => mockOpenSession(...args),
}))
jest.mock('@/lib/ingest/raw', () => ({
  writeRawObject: (...args: unknown[]) => mockWriteRawObject(...args),
}))
jest.mock('@/lib/ingest/field-inventory', () => ({
  recordFieldInventory: (...args: unknown[]) => mockRecordFieldInventory(...args),
}))
jest.mock('@/lib/ingest/staging/validate', () => ({
  validateLeaderboardRows: (...args: unknown[]) => mockValidateLeaderboardRows(...args),
}))
jest.mock('@/lib/ingest/serving/publish', () => ({
  publishLeaderboardSnapshot: (...args: unknown[]) => mockPublishLeaderboardSnapshot(...args),
  publishBoardSeries: (...args: unknown[]) => mockPublishBoardSeries(...args),
}))

import { processTierA } from '../tier-a-leaderboard'

const src = {
  id: 19,
  slug: 'xt_futures',
  adapter_slug: 'xt',
  status: 'active',
  currency: 'USDT',
  tf_label_map: {},
  meta: {},
  page_size: 100,
  trader_kind_scope: 'human',
} as SourceRow

const page: RawPage = {
  pageIndex: 1,
  payload: { result: { items: [{ accountId: 'xt-1' }] } },
  url: 'https://xt.test/leader-list',
  fetchedAt: '2026-07-16T00:00:00.000Z',
}

const row = {
  exchangeTraderId: 'xt-1',
  rank: 1,
  nickname: 'XT One',
  avatarUrlOrigin: null,
  walletAddress: null,
  traderKind: 'human',
  botStrategy: null,
  headlineRoi: 10,
  headlinePnl: 20,
  headlineWinRate: 50,
  raw: {},
} as ParsedLeaderboardRow

const job = { data: { sourceSlug: src.slug } } as Job<TierJobData>

describe('Tier-A board-series publication guard', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSourceBySlug.mockResolvedValue(src)
    mockNativeRankingTimeframes.mockReturnValue([30])
    mockOpenSession.mockResolvedValue({ close: mockSessionClose })
    mockSessionClose.mockResolvedValue(undefined)
    mockWriteRawObject.mockResolvedValue(9001)
    mockRecordFieldInventory.mockResolvedValue(undefined)
    mockValidateLeaderboardRows.mockImplementation((rows: ParsedLeaderboardRow[]) => ({
      valid: rows,
      rejects: [],
    }))
    mockGetAdapter.mockReturnValue({
      listLeaderboard: async function* () {
        yield page
      },
      parseLeaderboard: () => ({ rows: [row], reportedTotal: 1 }),
      parseLeaderboardSeries: () =>
        new Map([
          [
            row.exchangeTraderId,
            [
              {
                timeframe: 30,
                metric: 'pnl',
                replaceSeries: true,
                points: [{ ts: '2026-07-16T00:00:00.000Z', value: 20 }],
              },
            ],
          ],
        ]),
    })
    mockPublishLeaderboardSnapshot.mockResolvedValue({
      snapshotId: 777,
      scrapedAt: '2026-07-16 00:01:02.123456+00',
      verdict: { passed: true, baselineUsed: 1, deviationPct: 0 },
      published: true,
      traderIds: new Map([[row.exchangeTraderId, 42]]),
    })
    mockPublishBoardSeries.mockResolvedValue({ traders: 1, points: 1 })
  })

  it('passes the exact live snapshot identity before publishing replacement series', async () => {
    await expect(processTierA(job)).resolves.toEqual([
      expect.objectContaining({ timeframe: 30, snapshotId: 777, passed: true }),
    ])

    expect(mockPublishBoardSeries).toHaveBeenCalledWith(
      src,
      expect.any(Map),
      new Map([[row.exchangeTraderId, 42]]),
      {
        expectedLatestSnapshots: new Map([
          [
            30,
            {
              id: 777,
              rawObjectId: 9001,
              scrapedAt: '2026-07-16T00:01:02.123Z',
            },
          ],
        ]),
      }
    )
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })
})
