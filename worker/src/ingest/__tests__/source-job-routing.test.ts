import { INGEST_JOB } from '../job-names'
import { createManagedBullJobAuthority } from '../job-provenance'
import {
  AUTHORIZATION_JOB_LEASE_LANES,
  GLOBAL_JOB_LEASE_LANES,
  routeJobWithSourceLease,
  sourceJobLeaseLane,
  SOURCE_JOB_LEASE_LANES,
} from '../source-job-routing'
import type { SourceJobRedis } from '../source-job-lease'
import {
  SOURCE_JOB_LEASE_PROVENANCE_CONTRACT,
  SOURCE_JOB_LEASE_RENEW_MS,
} from '../source-job-lease'

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
    expect(AUTHORIZATION_JOB_LEASE_LANES).toEqual({
      [INGEST_JOB.FIRST_PARTY]: 'first-party',
    })
    expect(sourceJobLeaseLane(INGEST_JOB.FIRST_PARTY)).toBe('first-party')
    expect(sourceJobLeaseLane(INGEST_JOB.ONCHAIN_ENRICH)).toBe('onchain-enrich')
    expect(sourceJobLeaseLane(INGEST_JOB.FRESHNESS)).toBeNull()
  })

  it('hands downstream a frozen public lease proof and Bull token digests only', async () => {
    const redis = redisMock(['OK'])
    const processorToken = 'private-bull-processor-token'
    const managedBullJob = createManagedBullJobAuthority(
      {
        attemptsMade: 1,
        attemptsStarted: 2,
        id: 'repeat:tiera:binance_futures',
        name: INGEST_JOB.TIER_A,
        queueName: 'arena:ingest:local',
      },
      processorToken,
      new AbortController().signal
    )
    const bullJob = managedBullJob.authority
    const run = jest.fn(async () => 'finished')

    try {
      await expect(
        routeJobWithSourceLease({
          redis,
          bullJob,
          job: {
            id: 'repeat:tiera:binance_futures',
            name: INGEST_JOB.TIER_A,
            data: { sourceSlug: 'binance_futures' },
          },
          run,
        })
      ).resolves.toBe('finished')
    } finally {
      managedBullJob.close()
    }

    const provenance = run.mock.calls[0]?.[0]
    const ownerToken = (redis.set as jest.Mock).mock.calls[0]?.[1]
    expect(Object.isFrozen(provenance)).toBe(true)
    expect(provenance.bullJob).toBe(bullJob)
    expect(provenance.sourceLease.proof).toEqual({
      contract: SOURCE_JOB_LEASE_PROVENANCE_CONTRACT,
      leaseId: expect.any(String),
      lane: 'tier-a',
      scopeId: 'binance_futures',
      ownerTokenSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(Object.isFrozen(provenance.sourceLease)).toBe(true)
    expect(Object.isFrozen(provenance.sourceLease.proof)).toBe(true)
    expect(JSON.stringify(provenance)).not.toContain(processorToken)
    expect(JSON.stringify(provenance)).not.toContain(ownerToken)
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

  it('fails a Tier-A route when its source lease is lost', async () => {
    jest.useFakeTimers()
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const redis = redisMock(['OK'])
      ;(redis.eval as jest.Mock).mockResolvedValue(0)
      const run = jest.fn(
        (_provenance: unknown, signal: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            const cancel = () => reject(signal.reason)
            signal.addEventListener('abort', cancel, { once: true })
            if (signal.aborted) cancel()
          })
      )
      const routed = routeJobWithSourceLease({
        redis,
        job: {
          id: 'repeat:tiera:binance_futures',
          name: INGEST_JOB.TIER_A,
          data: { sourceSlug: 'binance_futures' },
        },
        run,
      })
      await Promise.resolve()
      const rejected = expect(routed).rejects.toThrow('source-job lease ownership lost')

      await jest.advanceTimersByTimeAsync(SOURCE_JOB_LEASE_RENEW_MS)

      await rejected
      expect(run.mock.calls[0]?.[1].aborted).toBe(true)
    } finally {
      errorSpy.mockRestore()
      jest.useRealTimers()
    }
  })

  it('keeps Tier-B behavior unchanged when its advisory lease is lost', async () => {
    jest.useFakeTimers()
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const redis = redisMock(['OK'])
      ;(redis.eval as jest.Mock).mockResolvedValue(0)
      const finish = deferred<string>()
      const run = jest.fn(async (_provenance: unknown, _signal: AbortSignal) => finish.promise)
      const routed = routeJobWithSourceLease({
        redis,
        job: {
          id: 'repeat:tierb:binance_futures',
          name: INGEST_JOB.TIER_B,
          data: { sourceSlug: 'binance_futures' },
        },
        run,
      })
      await Promise.resolve()

      await jest.advanceTimersByTimeAsync(SOURCE_JOB_LEASE_RENEW_MS)
      finish.resolve('tier-b-finished')

      await expect(routed).resolves.toBe('tier-b-finished')
      expect(run.mock.calls[0]?.[1].aborted).toBe(true)
    } finally {
      errorSpy.mockRestore()
      jest.useRealTimers()
    }
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

  it('coalesces periodic and immediate syncs for the same authorization', async () => {
    const redis = redisMock(['OK', null])
    const ownerFinish = deferred<string>()
    const ownerRun = jest.fn(() => ownerFinish.promise)
    const duplicateRun = jest.fn(async () => 'duplicate-ran')
    const job = {
      id: 'repeat:fp:auth-a:first',
      name: INGEST_JOB.FIRST_PARTY,
      data: { authorizationId: 'auth-a' },
    }

    const owner = routeJobWithSourceLease({ redis, job, run: ownerRun })
    await Promise.resolve()
    await expect(
      routeJobWithSourceLease({
        redis,
        job: { ...job, id: 'fp-initial-auth-a' },
        run: duplicateRun,
      })
    ).resolves.toEqual({
      coalesced: true,
      authorizationId: 'auth-a',
      lane: 'first-party',
    })

    expect(redis.set).toHaveBeenNthCalledWith(
      1,
      'arena:ingest:source-job-lease:first-party:auth-a',
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

  it('allows different first-party authorizations to sync concurrently', async () => {
    const redis = redisMock(['OK', 'OK'])
    const finishA = deferred<string>()
    const finishB = deferred<string>()
    const runA = jest.fn(() => finishA.promise)
    const runB = jest.fn(() => finishB.promise)

    const running = Promise.all([
      routeJobWithSourceLease({
        redis,
        job: {
          id: 'fp-initial-auth-a',
          name: INGEST_JOB.FIRST_PARTY,
          data: { authorizationId: 'auth-a' },
        },
        run: runA,
      }),
      routeJobWithSourceLease({
        redis,
        job: {
          id: 'fp-initial-auth-b',
          name: INGEST_JOB.FIRST_PARTY,
          data: { authorizationId: 'auth-b' },
        },
        run: runB,
      }),
    ])
    await Promise.resolve()
    await Promise.resolve()

    expect(runA).toHaveBeenCalledTimes(1)
    expect(runB).toHaveBeenCalledTimes(1)
    expect((redis.set as jest.Mock).mock.calls.map(([key]) => key)).toEqual([
      'arena:ingest:source-job-lease:first-party:auth-a',
      'arena:ingest:source-job-lease:first-party:auth-b',
    ])

    finishA.resolve('a-finished')
    finishB.resolve('b-finished')
    await expect(running).resolves.toEqual(['a-finished', 'b-finished'])
  })

  it('fails closed when a first-party job has no authorization identity', async () => {
    const redis = redisMock([])
    const run = jest.fn(async () => 'should-not-run')

    await expect(
      routeJobWithSourceLease({
        redis,
        job: { id: 'malformed', name: INGEST_JOB.FIRST_PARTY, data: {} },
        run,
      })
    ).rejects.toThrow('firstparty:sync job is missing authorizationId')

    expect(run).not.toHaveBeenCalled()
    expect(redis.set).not.toHaveBeenCalled()
  })

  it('does not start a first-party sync when lease acquisition fails', async () => {
    const redis = redisMock([])
    ;(redis.set as jest.Mock).mockRejectedValue(new Error('redis unavailable'))
    const run = jest.fn(async () => 'should-not-run')

    await expect(
      routeJobWithSourceLease({
        redis,
        job: {
          id: 'fp-initial-auth-a',
          name: INGEST_JOB.FIRST_PARTY,
          data: { authorizationId: 'auth-a' },
        },
        run,
      })
    ).rejects.toThrow('source-job lease acquire failed: first-party/auth-a')

    expect(run).not.toHaveBeenCalled()
  })
})
