jest.mock('../queues', () => ({
  INGEST_JOB: {
    TIER_A: 'tiera:leaderboard',
    TIER_B: 'tierb:profiles',
    TIER_B_SERIES: 'tierb:series',
    TIER_D: 'tierd:positions',
    DERIVE_BOARDS: 'derive:boards',
    FRESHNESS: 'maint:freshness',
  },
}))

import { INGEST_JOB } from '../queues'
import {
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
})
