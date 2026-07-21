jest.mock('../queues', () => ({
  INGEST_JOB: {
    TIER_A: 'tiera:leaderboard',
    TIER_B: 'tierb:profiles',
    TIER_B_SERIES: 'tierb:series',
    TIER_D: 'tierd:positions',
    DERIVE_BOARDS: 'derive:boards',
    FRESHNESS: 'maint:freshness',
    ONCHAIN_ENRICH: 'maint:onchain-enrich',
  },
}))

import { INGEST_JOB } from '../queues'
import {
  GLOBAL_JOB_LEASE_LANES,
  routeJobWithSourceLease,
  sourceJobLeaseLane,
  SOURCE_JOB_LEASE_LANES,
} from '../source-job-routing'
import type { SourceJobRedis } from '../source-job-lease'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function redisMock(setResults: Array<'OK' | null>): SourceJobRedis {
  return {
    set: jest.fn(async () => setResults.shift() ?? null),
    eval: jest.fn(async () => 1),
  }
}

describe('source job routing leases', () => {
  it('closes over every recurring source-wide worker lane', () => {
    expect(SOURCE_JOB_LEASE_LANES).toEqual({
      [INGEST_JOB.TIER_A]: 'tier-a',
      [INGEST_JOB.TIER_B]: 'tier-b',
      [INGEST_JOB.TIER_B_SERIES]: 'tier-b-series',
      [INGEST_JOB.TIER_D]: 'tier-d',
      [INGEST_JOB.DERIVE_BOARDS]: 'derive',
    })
    expect(GLOBAL_JOB_LEASE_LANES).toEqual({
      [INGEST_JOB.ONCHAIN_ENRICH]: 'onchain-enrich',
    })
    expect(sourceJobLeaseLane(INGEST_JOB.ONCHAIN_ENRICH)).toBe('onchain-enrich')
    expect(sourceJobLeaseLane(INGEST_JOB.FRESHNESS)).toBeNull()
  })

  it('lets only one same-source iteration run while duplicates coalesce', async () => {
    const redis = redisMock(['OK', null])
    const ownerFinish = deferred<string>()
    const ownerRun = jest.fn(() => ownerFinish.promise)
    const duplicateRun = jest.fn(async () => 'duplicate-ran')
    const log = jest.fn()
    const job = {
      id: 'repeat:tierbs:binance_futures:first',
      name: INGEST_JOB.TIER_B_SERIES,
      data: { sourceSlug: 'binance_futures' },
    }

    const owner = routeJobWithSourceLease({ redis, job, run: ownerRun, log })
    await Promise.resolve()
    await expect(
      routeJobWithSourceLease({
        redis,
        job: { ...job, id: 'repeat:tierbs:binance_futures:duplicate' },
        run: duplicateRun,
        log,
      })
    ).resolves.toEqual({
      coalesced: true,
      sourceSlug: 'binance_futures',
      lane: 'tier-b-series',
    })

    expect(ownerRun).toHaveBeenCalledTimes(1)
    expect(duplicateRun).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('coalesced duplicate tierb:series'))

    ownerFinish.resolve('owner-finished')
    await expect(owner).resolves.toBe('owner-finished')
  })

  it('passes non-source maintenance jobs through without touching Redis', async () => {
    const redis = redisMock([])
    const run = jest.fn(async () => 'freshness-finished')

    await expect(
      routeJobWithSourceLease({
        redis,
        job: { id: 'maint:freshness', name: INGEST_JOB.FRESHNESS, data: {} },
        run,
      })
    ).resolves.toBe('freshness-finished')

    expect(run).toHaveBeenCalledTimes(1)
    expect(redis.set).not.toHaveBeenCalled()
  })

  it('coalesces overlapping global on-chain enrichment iterations', async () => {
    const redis = redisMock(['OK', null])
    const ownerFinish = deferred<string>()
    const ownerRun = jest.fn(() => ownerFinish.promise)
    const duplicateRun = jest.fn(async () => 'duplicate-ran')
    const job = {
      id: 'repeat:maint:onchain-enrich:first',
      name: INGEST_JOB.ONCHAIN_ENRICH,
      data: {},
    }

    const owner = routeJobWithSourceLease({ redis, job, run: ownerRun })
    await Promise.resolve()
    await expect(
      routeJobWithSourceLease({
        redis,
        job: { ...job, id: 'repeat:maint:onchain-enrich:duplicate' },
        run: duplicateRun,
      })
    ).resolves.toEqual({
      coalesced: true,
      sourceSlug: 'global',
      lane: 'onchain-enrich',
    })

    expect(redis.set).toHaveBeenNthCalledWith(
      1,
      'arena:ingest:source-job-lease:onchain-enrich:global',
      expect.any(String),
      'PX',
      expect.any(Number),
      'NX'
    )
    expect(ownerRun).toHaveBeenCalledTimes(1)
    expect(duplicateRun).not.toHaveBeenCalled()

    ownerFinish.resolve('owner-finished')
    await expect(owner).resolves.toBe('owner-finished')
  })
})
