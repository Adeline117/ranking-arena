import type { Job } from 'bullmq'
import type { SourceRow } from '@/lib/ingest/core/types'
import type { TierJobData } from '../../queues'

const mockGetSourceBySlug = jest.fn()
const mockProfileTimeframes = jest.fn()
const mockGetAdapter = jest.fn()
const mockOpenSession = jest.fn()
const mockSessionClose = jest.fn()
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
jest.mock('@/lib/ingest/fetch/fetcher', () => ({
  openSession: (...args: unknown[]) => mockOpenSession(...args),
}))
jest.mock('@/lib/ingest/raw', () => ({ writeRawObject: jest.fn() }))
jest.mock('@/lib/ingest/staging/rejects', () => ({ recordStagingRejects: jest.fn() }))
jest.mock('@/lib/ingest/staging/validate', () => ({ validateStats: jest.fn() }))
jest.mock('@/lib/ingest/serving/publish', () => ({ publishProfile: jest.fn() }))
jest.mock('@/lib/logger', () => ({ logger: { info: jest.fn() } }))

import { processTierBSeries } from '../tier-b-series'

const src = {
  id: 34,
  slug: 'kucoin_futures',
  adapter_slug: 'kucoin',
  status: 'active',
  currency: 'USDT',
  tf_label_map: {},
  deep_profile_topn: 300,
  meta: {
    series_backfill_topn: 302,
    series_backfill_batch: 1,
    series_backfill_newcomers: 1,
  },
} as SourceRow

const job = { data: { sourceSlug: src.slug } } as Job<TierJobData>

describe('Tier-B series quality scheduling', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSourceBySlug.mockResolvedValue(src)
    mockProfileTimeframes.mockReturnValue([30])
    mockGetAdapter.mockReturnValue({ capabilities: { profile: true } })
    mockOpenSession.mockResolvedValue({ close: mockSessionClose })
    mockSessionClose.mockResolvedValue(undefined)
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT count(*)::int AS n')) {
        return { rows: [{ n: 1 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
  })

  it('cools never-published newcomer attempts for 24 hours', async () => {
    await expect(processTierBSeries(job)).resolves.toMatchObject({
      tradersCrawled: 0,
      bandSize: 1,
      errors: 0,
    })

    const newcomerSql = mockDbQuery.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('NOT EXISTS (SELECT 1 FROM arena.trader_series'))
    expect(newcomerSql).toContain('FROM arena.raw_objects ro')
    expect(newcomerSql).toContain('ro.source_id = $1')
    expect(newcomerSql).toContain("ro.job_type = 'tier_b_series'")
    expect(newcomerSql).toContain('ro.trader_id = t.id')
    expect(newcomerSql).toContain("ro.fetched_at > now() - interval '24 hours'")
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })
})
