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
  add: jest.fn().mockResolvedValue(undefined),
}
// Fast-lane queue is a SEPARATE BullMQ queue; mock it independently so the
// cleanup pass walks both lanes (bulk + fast) like production.
const mockFastQueue = {
  upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
  removeJobScheduler: jest.fn().mockResolvedValue(undefined),
  getJobSchedulers: jest.fn().mockResolvedValue([]),
  getJob: jest.fn().mockResolvedValue(null),
  add: jest.fn().mockResolvedValue(undefined),
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
  getFastQueue: () => mockFastQueue,
  regionQueueName: (r: string) => (r === 'local' ? 'arena-ingest' : `arena-ingest-${r}`),
  regionFastQueueName: (r: string) =>
    r === 'local' ? 'arena-ingest-fast' : `arena-ingest-fast-${r}`,
  isFastTierA: (c: number | null | undefined) => typeof c === 'number' && c > 0 && c <= 3000,
  FAST_LANE_ENABLED: true,
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
import { getActiveSources } from '@/lib/ingest/sources'

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

  it('leaves a mildly-overdue backlogged chain alone (<2x cadence, iteration queued)', async () => {
    const staleNext = Date.now() - 30 * 60_000 // 30min overdue, cadence is 1h → <2x
    mockQueue.getJobSchedulers.mockResolvedValue([scheduler('tiera:srcx', staleNext)])
    mockQueue.getJob.mockResolvedValue({
      id: `repeat:tiera:srcx:${staleNext}`,
      getState: async () => 'waiting',
    })
    await reconcileSchedulers()
    expect(mockQueue.removeJobScheduler).not.toHaveBeenCalled()
  })

  it('revives a deadlocked chain: iteration stuck in waiting AND >2x cadence overdue', async () => {
    const staleNext = Date.now() - 3 * HOUR // 3h overdue, cadence 1h → >2x
    mockQueue.getJobSchedulers.mockResolvedValue([scheduler('tiera:srcx', staleNext)])
    mockQueue.getJob.mockResolvedValue({
      id: `repeat:tiera:srcx:${staleNext}`,
      getState: async () => 'waiting', // exists but never running (starved)
    })
    await reconcileSchedulers()
    expect(mockQueue.removeJobScheduler).toHaveBeenCalledWith('tiera:srcx')
    const upsertKeys = mockQueue.upsertJobScheduler.mock.calls.map((c) => c[0])
    expect(upsertKeys.filter((k) => k === 'tiera:srcx').length).toBeGreaterThanOrEqual(2)
    // Immediate priority-1 kick so the revived source crawls NOW, not after a
    // full 5h cadence (take-4).
    const kick = mockQueue.add.mock.calls.find((c) =>
      c[2]?.jobId?.startsWith('revive-kick-tiera-srcx')
    )
    expect(kick).toBeDefined()
    expect(kick?.[2]?.priority).toBe(1)
    // take-5 regression lock: jobId must NOT contain ':' — BullMQ rejects it
    // ("Custom Id cannot contain :"), and the awaited add() throw aborted the
    // whole reconcile loop so revival never kicked anything.
    expect(kick?.[2]?.jobId).not.toContain(':')
  })

  it('never interrupts an active long crawl even if the scheduler is >2x overdue', async () => {
    const staleNext = Date.now() - 3 * HOUR
    mockQueue.getJobSchedulers.mockResolvedValue([scheduler('tiera:srcx', staleNext)])
    mockQueue.getJob.mockResolvedValue({
      id: `repeat:tiera:srcx:${staleNext}`,
      getState: async () => 'active', // 25-90min Tier-A crawl mid-flight
    })
    await reconcileSchedulers()
    expect(mockQueue.removeJobScheduler).not.toHaveBeenCalled()
  })

  it('leaves fresh schedulers alone', async () => {
    mockQueue.getJobSchedulers.mockResolvedValue([scheduler('tiera:srcx', Date.now() + HOUR)])
    await reconcileSchedulers()
    expect(mockQueue.removeJobScheduler).not.toHaveBeenCalled()
    expect(mockQueue.getJob).not.toHaveBeenCalled()
  })

  // ── Fast-lane routing (2026-06-13 slot-starvation root fix) ──
  const baseSource = {
    fetch_region: 'local',
    cadence_tier_a_seconds: 3600,
    cadence_tier_b_seconds: 7200,
    cadence_tier_d_seconds: 1800,
    deep_profile_topn: 300,
    timeframes_derived: [],
    meta: {},
  }

  it('routes a small board Tier-A to the fast queue, other tiers to bulk', async () => {
    ;(getActiveSources as jest.Mock).mockResolvedValueOnce([
      { ...baseSource, slug: 'smallsrc', expected_count: 500 },
    ])
    await reconcileSchedulers()
    // Tier-A on the fast queue…
    expect(mockFastQueue.upsertJobScheduler).toHaveBeenCalledWith(
      'tiera:smallsrc',
      expect.anything(),
      expect.objectContaining({ name: 'tiera:leaderboard' })
    )
    // …and NOT on bulk; Tier-B/D stay on bulk.
    const bulkTierAKeys = mockQueue.upsertJobScheduler.mock.calls
      .map((c) => c[0])
      .filter((k) => k === 'tiera:smallsrc')
    expect(bulkTierAKeys).toHaveLength(0)
    expect(mockQueue.upsertJobScheduler).toHaveBeenCalledWith(
      'tierb:smallsrc',
      expect.anything(),
      expect.objectContaining({ name: 'tierb:profiles' })
    )
  })

  it('keeps a giant board Tier-A on the bulk queue (heavy, > threshold)', async () => {
    ;(getActiveSources as jest.Mock).mockResolvedValueOnce([
      { ...baseSource, slug: 'bigsrc', expected_count: 29000 },
    ])
    await reconcileSchedulers()
    expect(mockQueue.upsertJobScheduler).toHaveBeenCalledWith(
      'tiera:bigsrc',
      expect.anything(),
      expect.objectContaining({ name: 'tiera:leaderboard' })
    )
    const fastTierAKeys = mockFastQueue.upsertJobScheduler.mock.calls
      .map((c) => c[0])
      .filter((k) => k === 'tiera:bigsrc')
    expect(fastTierAKeys).toHaveLength(0)
  })

  it('treats NULL expected_count as heavy (unknown size → bulk)', async () => {
    ;(getActiveSources as jest.Mock).mockResolvedValueOnce([
      { ...baseSource, slug: 'unknownsrc', expected_count: null },
    ])
    await reconcileSchedulers()
    expect(mockQueue.upsertJobScheduler).toHaveBeenCalledWith(
      'tiera:unknownsrc',
      expect.anything(),
      expect.objectContaining({ name: 'tiera:leaderboard' })
    )
    expect(mockFastQueue.upsertJobScheduler).not.toHaveBeenCalledWith(
      'tiera:unknownsrc',
      expect.anything(),
      expect.anything()
    )
  })
})
