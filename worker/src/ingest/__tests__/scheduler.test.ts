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
  getJobs: jest.fn().mockResolvedValue([]),
  add: jest.fn().mockResolvedValue(undefined),
}
// Fast-lane queue is a SEPARATE BullMQ queue; mock it independently so the
// cleanup pass walks both lanes (bulk + fast) like production.
const mockFastQueue = {
  upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
  removeJobScheduler: jest.fn().mockResolvedValue(undefined),
  getJobSchedulers: jest.fn().mockResolvedValue([]),
  getJob: jest.fn().mockResolvedValue(null),
  getJobs: jest.fn().mockResolvedValue([]),
  add: jest.fn().mockResolvedValue(undefined),
}
const mockDbQuery = jest.fn().mockResolvedValue({ rows: [] })
const mockRegions: string[] = ['local']

// The scheduler's historical invariants stay unit-tested under an explicit
// test-only GO. The checked-in V1 source gate remains fixed-off.
jest.mock('@/lib/ingest/v1-execution-publication', () => ({
  isV1IngestExecutionPublished: jest.fn(() => true),
}))

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
    FIRST_PARTY: 'firstparty:sync',
  },
  INGEST_REGIONS: mockRegions,
  getIngestQueue: () => mockQueue,
  getRegionQueue: () => mockQueue,
  getFastQueue: () => mockFastQueue,
  regionQueueName: (r: string) => (r === 'local' ? 'arena-ingest' : `arena-ingest-${r}`),
  regionFastQueueName: (r: string) =>
    r === 'local' ? 'arena-ingest-fast' : `arena-ingest-fast-${r}`,
  isFastTierA: (c: number | null | undefined) => typeof c === 'number' && c > 0 && c <= 3000,
  fastLaneEnabled: () => true,
}))

// Keep the ingest DB module mocked so a regression cannot silently reopen the
// retired authorization-wide first-party scheduler pass in unit tests.
jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: () => ({ query: mockDbQuery }),
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

const mockAlert = jest.fn().mockResolvedValue(undefined)
jest.mock('@/lib/ingest/alerting', () => ({ alert: (...args: unknown[]) => mockAlert(...args) }))
jest.mock('../../connection', () => ({ getConnection: () => ({ set: jest.fn() }) }))

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
    mockQueue.getJobs.mockResolvedValue([])
    mockDbQuery.mockReset().mockResolvedValue({ rows: [] })
  })

  it('removes legacy first-party schedulers without scanning all account authorizations', async () => {
    mockQueue.getJobSchedulers.mockResolvedValue([
      {
        key: 'fp:auth-1',
        name: 'firstparty:sync',
        next: Date.now() + HOUR,
        every: 15 * 60_000,
        template: { data: { authorizationId: 'auth-1' } },
      },
    ])

    await reconcileSchedulers()

    expect(mockDbQuery).not.toHaveBeenCalled()
    expect(mockQueue.removeJobScheduler).toHaveBeenCalledWith('fp:auth-1')
    expect(
      mockQueue.upsertJobScheduler.mock.calls.some(([key]) => String(key).startsWith('fp:'))
    ).toBe(false)
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
      remove: jest.fn().mockResolvedValue(undefined),
    })
    await reconcileSchedulers()
    expect(mockQueue.removeJobScheduler).not.toHaveBeenCalled()
  })

  it('take-7b: short-cadence queued chain is NOT revived before the 45min floor', async () => {
    // 2×every alone scales down with cadence: series backfill at 600s made the
    // trigger 20min — normal prio-9 queue latency under load. Hourly reconciles
    // (×2 nodes) then "revived" ~20 healthy schedulers per pass, each rebuild
    // orphaning its queued iteration → the 295-zombie clog (2026-07-09).
    const TEN_MIN = 600_000
    const staleNext = Date.now() - 25 * 60_000 // 25min overdue: >2×every(20min), <45min floor
    mockQueue.getJobSchedulers.mockResolvedValue([
      {
        key: 'tierbs:srcx',
        name: 'tierb:series',
        next: staleNext,
        every: TEN_MIN,
        template: { data: { sourceSlug: 'srcx' }, opts: { priority: 9 } },
      },
    ])
    const base = (await (getActiveSources as jest.Mock)())[0]
    ;(getActiveSources as jest.Mock).mockResolvedValue([
      { ...base, meta: { series_backfill_topn: 100000 } },
    ])
    const queuedJob = {
      id: `repeat:tierbs:srcx:${staleNext}`,
      getState: async () => 'prioritized',
      remove: jest.fn().mockResolvedValue(undefined),
    }
    mockQueue.getJob.mockResolvedValue(queuedJob)
    await reconcileSchedulers()
    expect(mockQueue.removeJobScheduler).not.toHaveBeenCalled()
    expect(queuedJob.remove).not.toHaveBeenCalled()
  })

  it('revives a deadlocked chain: iteration stuck in waiting AND >2x cadence overdue', async () => {
    const staleNext = Date.now() - 3 * HOUR // 3h overdue, cadence 1h → >2x
    mockQueue.getJobSchedulers.mockResolvedValue([scheduler('tiera:srcx', staleNext)])
    const stuckJob = {
      id: `repeat:tiera:srcx:${staleNext}`,
      getState: async () => 'waiting',
      remove: jest.fn().mockResolvedValue(undefined), // exists but never running (starved)
    }
    mockQueue.getJob.mockResolvedValue(stuckJob)
    await reconcileSchedulers()
    expect(mockQueue.removeJobScheduler).toHaveBeenCalledWith('tiera:srcx')
    // take-7b: the superseded iteration is REMOVED on rebuild — leaving it
    // queued stacked one orphan per revive wave (295 prio-9 zombies, 2026-07-09).
    expect(stuckJob.remove).toHaveBeenCalled()
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

  it('take-6: revive kick inherits template priority + stable jobId; rebuild preserves opts', async () => {
    // A tierbs (series backfill) scheduler is priority 9 BY DESIGN. The old kick
    // hardcoded priority:1 + a timestamped jobId — revive-kicks of 180s series
    // jobs jumped ahead of tier-A and re-minted on every reconcile, compounding
    // into a 4.6k-job prioritized clog (2026-07-03 incident, oldest job 06-16).
    const staleNext = Date.now() - 3 * HOUR
    // srcx must OPT INTO the series band or tierbs:srcx isn't `wanted` and gets
    // removed as stale instead of revived.
    const base = (await (getActiveSources as jest.Mock)())[0]
    ;(getActiveSources as jest.Mock).mockResolvedValue([
      { ...base, meta: { series_backfill_topn: 100000 } },
    ])
    mockQueue.getJobSchedulers.mockResolvedValue([
      {
        key: 'tierbs:srcx',
        name: 'tierb:series',
        next: staleNext,
        every: HOUR,
        template: { data: { sourceSlug: 'srcx' }, opts: { priority: 9 } },
      },
    ])
    mockQueue.getJob.mockResolvedValue({
      id: `repeat:tierbs:srcx:${staleNext}`,
      getState: async () => 'waiting',
      remove: jest.fn().mockResolvedValue(undefined),
    })
    await reconcileSchedulers()
    const kick = mockQueue.add.mock.calls.find((c) =>
      c[2]?.jobId?.startsWith('revive-kick-tierbs-srcx')
    )
    expect(kick).toBeDefined()
    expect(kick?.[2]?.priority).toBe(9) // inherited, NOT hardcoded 1
    expect(kick?.[2]?.jobId).toBe('revive-kick-tierbs-srcx') // stable — no timestamp suffix
    // Rebuild must carry template opts through (old code dropped priority).
    const rebuild = mockQueue.upsertJobScheduler.mock.calls.find((c) => c[0] === 'tierbs:srcx')
    expect(rebuild?.[2]?.opts).toEqual({ priority: 9 })
  })

  it('take-7: priority derives from key prefix even when the stored template lost it', async () => {
    // Pre-take-6 rebuilds stripped opts from templates, and upsert with an
    // unchanged `every` never refreshes them — so trusting the template left
    // those schedulers spawning prio-0 iterations into the `wait` lane, ahead
    // of every prioritized job (prio-9 series batches ran while 89 prio-1
    // tier-A boards starved).
    const staleNext = Date.now() - 3 * HOUR
    const base = (await (getActiveSources as jest.Mock)())[0]
    ;(getActiveSources as jest.Mock).mockResolvedValue([
      { ...base, meta: { series_backfill_topn: 100000 } },
    ])
    mockQueue.getJobSchedulers.mockResolvedValue([
      {
        key: 'tierbs:srcx',
        name: 'tierb:series',
        next: staleNext,
        every: HOUR,
        // stripped template: attempts/backoff survive, priority is GONE
        template: { data: { sourceSlug: 'srcx' }, opts: { attempts: 3 } },
      },
    ])
    mockQueue.getJob.mockResolvedValue({
      id: `repeat:tierbs:srcx:${staleNext}`,
      getState: async () => 'waiting',
      remove: jest.fn().mockResolvedValue(undefined),
    })
    await reconcileSchedulers()
    const kick = mockQueue.add.mock.calls.find((c) =>
      c[2]?.jobId?.startsWith('revive-kick-tierbs-srcx')
    )
    expect(kick?.[2]?.priority).toBe(9) // from PRIORITY_BY_PREFIX, not template
    // the REBUILD upsert is the last one for this key (registration upserts first)
    const rebuild = mockQueue.upsertJobScheduler.mock.calls
      .filter((c) => c[0] === 'tierbs:srcx')
      .at(-1)
    expect(rebuild?.[2]?.opts).toEqual({ attempts: 3, priority: 9 }) // healed, other opts kept
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

  it('keeps pending first-party jobs for different authorizations', async () => {
    const authA = {
      id: 'fp-a',
      name: 'firstparty:sync',
      data: { authorizationId: 'auth-a' },
      timestamp: 100,
      remove: jest.fn().mockResolvedValue(undefined),
    }
    const authB = {
      id: 'fp-b',
      name: 'firstparty:sync',
      data: { authorizationId: 'auth-b' },
      timestamp: 200,
      remove: jest.fn().mockResolvedValue(undefined),
    }
    mockQueue.getJobs.mockResolvedValue([authA, authB])

    await reconcileSchedulers()

    expect(authA.remove).not.toHaveBeenCalled()
    expect(authB.remove).not.toHaveBeenCalled()
  })

  it('dedupes only the older pending job for the same authorization', async () => {
    const older = {
      id: 'fp-old',
      name: 'firstparty:sync',
      data: { authorizationId: 'auth-a' },
      timestamp: 100,
      remove: jest.fn().mockResolvedValue(undefined),
    }
    const newer = {
      id: 'fp-new',
      name: 'firstparty:sync',
      data: { authorizationId: 'auth-a' },
      timestamp: 200,
      remove: jest.fn().mockResolvedValue(undefined),
    }
    mockQueue.getJobs.mockResolvedValue([older, newer])

    await reconcileSchedulers()

    expect(older.remove).toHaveBeenCalledTimes(1)
    expect(newer.remove).not.toHaveBeenCalled()
  })

  it('never removes a pending scheduler iteration, even when a newer kick exists', async () => {
    const iteration = {
      id: 'repeat:tiera:srcx:1700000000000',
      name: 'tiera:leaderboard',
      data: { sourceSlug: 'srcx' },
      timestamp: 100,
      repeatJobKey: 'tiera:srcx',
      remove: jest.fn().mockResolvedValue(undefined),
    }
    const olderKick = {
      id: 'kick-old',
      name: 'tiera:leaderboard',
      data: { sourceSlug: 'srcx' },
      timestamp: 150,
      remove: jest.fn().mockResolvedValue(undefined),
    }
    const newerKick = {
      id: 'revive-kick-tiera-srcx',
      name: 'tiera:leaderboard',
      data: { sourceSlug: 'srcx' },
      timestamp: 200,
      remove: jest.fn().mockResolvedValue(undefined),
    }
    mockQueue.getJobs.mockResolvedValue([iteration, olderKick, newerKick])

    await reconcileSchedulers()

    expect(iteration.remove).not.toHaveBeenCalled()
    expect(olderKick.remove).toHaveBeenCalledTimes(1)
    expect(newerKick.remove).not.toHaveBeenCalled()
  })

  it('also dedupes the fast lane', async () => {
    const older = {
      id: 'fast-old',
      name: 'tiera:leaderboard',
      data: { sourceSlug: 'srcx' },
      timestamp: 100,
      remove: jest.fn().mockResolvedValue(undefined),
    }
    const newer = { ...older, id: 'fast-new', timestamp: 200, remove: jest.fn() }
    mockFastQueue.getJobs.mockResolvedValueOnce([older, newer])

    await reconcileSchedulers()

    expect(mockFastQueue.getJobs).toHaveBeenCalledWith(['prioritized', 'waiting'], 0, 500)
    expect(older.remove).toHaveBeenCalledTimes(1)
    expect(newer.remove).not.toHaveBeenCalled()
  })

  it('uses the BullMQ job id to break equal-timestamp ties deterministically', async () => {
    const lowerId = {
      id: 'fp-a',
      name: 'firstparty:sync',
      data: { authorizationId: 'auth-a' },
      timestamp: 100,
      remove: jest.fn().mockResolvedValue(undefined),
    }
    const higherId = {
      id: 'fp-b',
      name: 'firstparty:sync',
      data: { authorizationId: 'auth-a' },
      timestamp: 100,
      remove: jest.fn().mockResolvedValue(undefined),
    }
    mockQueue.getJobs.mockResolvedValue([higherId, lowerId])

    await reconcileSchedulers()

    expect(lowerId.remove).toHaveBeenCalledTimes(1)
    expect(higherId.remove).not.toHaveBeenCalled()
  })

  it('keeps malformed first-party jobs instead of merging them destructively', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const malformedA = {
      id: 'fp-a',
      name: 'firstparty:sync',
      data: {},
      timestamp: 100,
      remove: jest.fn().mockResolvedValue(undefined),
    }
    const malformedB = {
      id: 'fp-b',
      name: 'firstparty:sync',
      data: { authorizationId: '  ' },
      timestamp: 200,
      remove: jest.fn().mockResolvedValue(undefined),
    }
    mockQueue.getJobs.mockResolvedValue([malformedA, malformedB])

    await reconcileSchedulers()

    expect(malformedA.remove).not.toHaveBeenCalled()
    expect(malformedB.remove).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kept 2 unscoped pending jobs'))
    warn.mockRestore()
  })
})

describe('reconcileSchedulers per-source isolation', () => {
  const src = (slug: string) => ({
    slug,
    phase: 1,
    fetch_region: 'local',
    cadence_tier_a_seconds: 3600,
    cadence_tier_b_seconds: 7200,
    cadence_tier_d_seconds: 1800,
    deep_profile_topn: 300,
    timeframes_derived: [],
    meta: {},
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockQueue.getJobSchedulers.mockResolvedValue([])
    mockQueue.getJob.mockResolvedValue(null)
    mockQueue.getJobs.mockResolvedValue([])
  })

  it('keeps registering later sources, spares the failed source, and alerts', async () => {
    ;(getActiveSources as jest.Mock).mockResolvedValueOnce([src('bad'), src('good')])
    mockQueue.upsertJobScheduler.mockImplementation(async (key: string) => {
      if (key === 'tierb:bad') throw new Error('every must be > 0')
    })
    // An existing scheduler of the failed source must not be treated as stale.
    mockQueue.getJobSchedulers.mockResolvedValue([
      {
        key: 'tierd:bad',
        name: 'tierd:positions',
        next: Date.now() + HOUR,
        every: HOUR,
        template: { data: { sourceSlug: 'bad' } },
      },
    ])

    await reconcileSchedulers()

    const keys = mockQueue.upsertJobScheduler.mock.calls.map((c) => c[0])
    expect(keys).toEqual(expect.arrayContaining(['tierb:good', 'tierd:good']))
    expect(mockQueue.removeJobScheduler).not.toHaveBeenCalledWith('tierd:bad')
    expect(mockAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceSlug: 'bad', tier: 'maint' })
    )
    mockQueue.upsertJobScheduler.mockReset().mockResolvedValue(undefined)
  })
})

describe('reconcileSchedulers maintenance placement', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockQueue.getJobSchedulers.mockResolvedValue([])
    mockQueue.getJobs.mockResolvedValue([])
  })
  afterEach(() => {
    mockRegions.splice(0, mockRegions.length, 'local')
  })

  it('keeps the primary on local and adds an SG standby copy for sentinel/digest/housekeeping', async () => {
    mockRegions.push('vps_sg')
    await reconcileSchedulers()
    const calls = mockQueue.upsertJobScheduler.mock.calls
    const byKey = new Map(calls.map((c) => [c[0], c[2]]))
    for (const id of ['maint:housekeeping', 'maint:freshness', 'maint:daily-digest']) {
      expect(byKey.get(id)).toMatchObject({ data: {} })
      expect(byKey.get(`${id}:vps_sg`)).toMatchObject({ data: { standby: true } })
    }
    expect(byKey.has('maint:onchain-enrich')).toBe(true)
    expect(byKey.has('maint:onchain-enrich:vps_sg')).toBe(false)
  })

  it('registers no standby when the SG region is not configured', async () => {
    await reconcileSchedulers()
    const keys = mockQueue.upsertJobScheduler.mock.calls.map((c) => String(c[0]))
    expect(keys.some((k) => k.endsWith(':vps_sg'))).toBe(false)
  })
})
