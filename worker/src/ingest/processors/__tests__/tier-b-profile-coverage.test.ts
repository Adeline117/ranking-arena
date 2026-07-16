import type { Job } from 'bullmq'
import type { ParsedProfile, SourceRow } from '@/lib/ingest/core/types'
import type { TierJobData } from '../../queues'

const mockGetSourceBySlug = jest.fn()
const mockProfileTimeframes = jest.fn()
const mockGetAdapter = jest.fn()
const mockGetProfile = jest.fn()
const mockParseProfile = jest.fn()
const mockOpenSession = jest.fn()
const mockSessionClose = jest.fn()
const mockWriteRawObject = jest.fn()
const mockPublishProfile = jest.fn()
const mockDbQuery = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: (...args: unknown[]) => mockDbQuery(...args) })),
}))
jest.mock('@/lib/ingest/sources', () => ({
  getSourceBySlug: (...args: unknown[]) => mockGetSourceBySlug(...args),
  profileTimeframes: (...args: unknown[]) => mockProfileTimeframes(...args),
}))
jest.mock('@/lib/ingest/core/adapter', () => ({
  getAdapter: (...args: unknown[]) => mockGetAdapter(...args),
}))
jest.mock('@/lib/ingest/core/history-cursor', () => ({ nextHistoryCursor: jest.fn() }))
jest.mock('@/lib/ingest/fetch/fetcher', () => ({
  openSession: (...args: unknown[]) => mockOpenSession(...args),
}))
jest.mock('@/lib/ingest/raw', () => ({
  writeRawObject: (...args: unknown[]) => mockWriteRawObject(...args),
}))
jest.mock('@/lib/ingest/staging/validate', () => ({
  roiCrossCheckOk: jest.fn(() => null),
  validateStats: jest.fn((stats: unknown[]) => ({ valid: stats, rejects: [] })),
}))
jest.mock('@/lib/ingest/serving/publish', () => ({
  getHistoryCursor: jest.fn(),
  publishHistoryRows: jest.fn(),
  publishProfile: (...args: unknown[]) => mockPublishProfile(...args),
}))
jest.mock('@/lib/ingest/field-inventory', () => ({
  recordFieldInventory: jest.fn(async () => undefined),
}))
jest.mock('../../queues', () => ({
  getRegionQueue: jest.fn(() => ({ add: jest.fn() })),
  INGEST_JOB: { TIER_B: 'tier-b' },
}))

import { processTierB } from '../tier-b-profiles'

const src = {
  id: 34,
  slug: 'gtrade',
  adapter_slug: 'gtrade',
  status: 'active',
  currency: 'USDC',
  tf_label_map: {},
  meta: {},
  deep_profile_topn: 300,
  cadence_tier_b_seconds: 21_600,
  fetch_region: 'local',
} as SourceRow & { cadence_tier_b_seconds: number }

function profile(timeframe: 7 | 30, complete: boolean): ParsedProfile {
  return {
    nickname: null,
    avatarUrlOrigin: null,
    stats: [
      {
        timeframe,
        asOf: '2026-07-15T12:00:00.000Z',
        roi: null,
        pnl: complete ? 1 : null,
        sharpe: null,
        mdd: null,
        winRate: null,
        winPositions: complete ? 0 : null,
        totalPositions: complete ? 0 : null,
        copierPnl: null,
        copierCount: null,
        aum: null,
        volume: null,
        profitShareRate: null,
        holdingDurationAvgHours: null,
        tradingPreferences: null,
        extras: {
          profile_window_metrics_complete: complete,
          profile_window_metrics_incomplete_reason: complete ? null : 'window_prefix_not_covered',
        },
      },
    ],
    series: [],
  }
}

const job = { data: { sourceSlug: 'gtrade' } } as Job<TierJobData>

describe('Tier-B profile coverage accounting', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSourceBySlug.mockResolvedValue(src)
    mockProfileTimeframes.mockReturnValue([7, 30])
    mockGetAdapter.mockReturnValue({
      capabilities: {
        profile: true,
        positionHistory: false,
        orders: false,
        transfers: false,
        copiers: false,
      },
      getProfile: mockGetProfile,
      parseProfile: mockParseProfile,
    })
    mockGetProfile.mockImplementation(async (_session, _src, _trader, timeframe) => ({
      pages: [
        {
          pageIndex: 1,
          payload: { timeframe },
          url: 'https://gtrade.test/profile',
          fetchedAt: '2026-07-15T12:00:00.000Z',
        },
      ],
      fetchedAt: '2026-07-15T12:00:00.000Z',
    }))
    mockOpenSession.mockResolvedValue({ close: mockSessionClose })
    mockSessionClose.mockResolvedValue(undefined)
    mockWriteRawObject.mockResolvedValue(undefined)
    mockPublishProfile.mockResolvedValue(undefined)
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('WITH latest AS')) {
        return {
          rows: [
            {
              id: 42,
              exchange_trader_id: '0x0000000000000000000000000000000000000001',
              meta: null,
              headline_rois: null,
            },
          ],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 1 }
    })
  })

  it('does not mark a trader fresh when one timeframe is unproven', async () => {
    mockParseProfile.mockImplementation((raw: { timeframe: 7 | 30 }) =>
      profile(raw.timeframe, raw.timeframe === 7)
    )

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 0,
      surfacesFetched: 1,
      errors: 1,
      remaining: 0,
    })

    expect(mockWriteRawObject).toHaveBeenCalledTimes(2)
    expect(mockPublishProfile).toHaveBeenCalledTimes(2)
    expect(
      mockDbQuery.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO arena.ingest_cursors')
      )
    ).toBe(false)
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('marks the trader only after every requested timeframe succeeds', async () => {
    mockParseProfile.mockImplementation((raw: { timeframe: 7 | 30 }) =>
      profile(raw.timeframe, true)
    )

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 1,
      surfacesFetched: 2,
      errors: 0,
    })
    expect(
      mockDbQuery.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO arena.ingest_cursors')
      )
    ).toBe(true)
  })
})
