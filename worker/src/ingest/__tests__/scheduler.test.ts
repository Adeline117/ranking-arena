/**
 * reconcileSchedulers — regression locks for the two silent-failure bugs
 * found 2026-06-12:
 *
 * 1. getJobSchedulers() items carry the scheduler identifier in `key`
 *    (`id` is undefined). The original cleanup/revive block read
 *    `scheduler.id` and silently skipped EVERY scheduler.
 * 2. Revival must probe the deterministic iteration job id
 *    `repeat:<key>:<next>` — a backlogged-but-queued iteration is intact
 *    and must NOT be rebuilt (would double-schedule).
 */

const mockQueue = {
  upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
  removeJobScheduler: jest.fn().mockResolvedValue(undefined),
  getJobSchedulers: jest.fn().mockResolvedValue([]),
  getJob: jest.fn().mockResolvedValue(null),
}

jest.mock('../queues', () => ({
  INGEST_JOB: {
    TIER_A: 'tiera:leaderboard',
    TIER_B: 'tierb:profiles',
    TIER_B_SERIES: 'tierb:series',
    TIER_D: 'tierd:positions',
    DERIVE_BOARDS: 'derive:boards',
    MAINTENANCE: 'maint:housekeeping',
    FRESHNESS: 'maint:freshness',
    AVATAR_MIRROR: 'maint:avatar-mirror',
    DAILY_DIGEST: 'maint:daily-digest',
  },
  INGEST_REGIONS: ['local'],
  getIngestQueue: () => mockQueue,
  getRegionQueue: () => mockQueue,
}))

jest.mock('@/lib/ingest/sources', () => ({
  getActiveSources: jest.fn().mockResolvedValue([
    {
      slug: 'srcx',
      fetch_region: 'local',
      cadence_tier_a_seconds: 3600,
      cadence_tier_b_seconds: 7200,
      cadence_tier_d_seconds: 1800,
      deep_profile_topn: 300,
      timeframes_derived: [],
      meta: {},
    },
  ]),
}))

import { reconcileSchedulers } from '../scheduler'

const HOUR = 3600_000

function scheduler(key: string, next: number, every = HOUR) {
  // Shape mirrors BullMQ JobSchedulerJson: identifier lives in `key`, no `id`.
  return { key, name: 'tiera:leaderboard', next, every, template: { data: { sourceSlug: 'srcx' } } }
}

describe('reconcileSchedulers cleanup/revival', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockQueue.getJobSchedulers.mockResolvedValue([])
    mockQueue.getJob.mockResolvedValue(null)
  })

  it('removes schedulers no longer wanted, addressing them by key (not id)', async () => {
    mockQueue.getJobSchedulers.mockResolvedValue([
      scheduler('tiera:retired_source', Date.now() + HOUR),
    ])
    await reconcileSchedulers()
    expect(mockQueue.removeJobScheduler).toHaveBeenCalledWith('tiera:retired_source')
  })

  it('revives a wanted scheduler whose chain is broken (next past grace, iteration job gone)', async () => {
    const staleNext = Date.now() - 30 * 60_000 // 30min overdue, grace is 5min
    mockQueue.getJobSchedulers.mockResolvedValue([scheduler('tiera:srcx', staleNext)])
    mockQueue.getJob.mockResolvedValue(null) // iteration job missing → broken
    await reconcileSchedulers()
    expect(mockQueue.getJob).toHaveBeenCalledWith(`repeat:tiera:srcx:${staleNext}`)
    expect(mockQueue.removeJobScheduler).toHaveBeenCalledWith('tiera:srcx')
    // re-created after removal (beyond the regular upsert pass)
    const upsertKeys = mockQueue.upsertJobScheduler.mock.calls.map((c) => c[0])
    expect(upsertKeys.filter((k) => k === 'tiera:srcx').length).toBeGreaterThanOrEqual(2)
  })

  it('leaves a backlogged-but-intact chain alone (iteration job still queued)', async () => {
    const staleNext = Date.now() - 30 * 60_000
    mockQueue.getJobSchedulers.mockResolvedValue([scheduler('tiera:srcx', staleNext)])
    mockQueue.getJob.mockResolvedValue({ id: `repeat:tiera:srcx:${staleNext}` })
    await reconcileSchedulers()
    expect(mockQueue.removeJobScheduler).not.toHaveBeenCalled()
  })

  it('leaves fresh schedulers alone', async () => {
    mockQueue.getJobSchedulers.mockResolvedValue([scheduler('tiera:srcx', Date.now() + HOUR)])
    await reconcileSchedulers()
    expect(mockQueue.removeJobScheduler).not.toHaveBeenCalled()
    expect(mockQueue.getJob).not.toHaveBeenCalled()
  })
})
