import {
  SOURCE_JOB_LEASE_RENEW_MS,
  SOURCE_JOB_LEASE_TTL_MS,
  type SourceJobRedis,
  withSourceJobLease,
} from '../source-job-lease'

function redisMock(overrides: Partial<SourceJobRedis> = {}) {
  return {
    set: jest.fn(async () => 'OK'),
    eval: jest.fn(async () => 1),
    ...overrides,
  }
}

describe('withSourceJobLease', () => {
  it('runs one owner and releases it with a token-fenced script', async () => {
    const redis = redisMock()
    const run = jest.fn(async () => ({ rows: 42 }))

    await expect(
      withSourceJobLease({
        redis,
        lane: 'tier-a',
        sourceSlug: 'binance_futures',
        run,
      })
    ).resolves.toEqual({ coalesced: false, value: { rows: 42 } })

    expect(redis.set).toHaveBeenCalledWith(
      'arena:ingest:source-job-lease:tier-a:binance_futures',
      expect.any(String),
      'PX',
      SOURCE_JOB_LEASE_TTL_MS,
      'NX'
    )
    expect(run).toHaveBeenCalledTimes(1)
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("del", KEYS[1])'),
      1,
      'arena:ingest:source-job-lease:tier-a:binance_futures',
      expect.any(String)
    )
  })

  it('coalesces a duplicate without running or deleting the owner lease', async () => {
    const redis = redisMock({ set: jest.fn(async () => null) })
    const run = jest.fn(async () => 'should-not-run')

    await expect(
      withSourceJobLease({
        redis,
        lane: 'tier-a',
        sourceSlug: 'binance_futures',
        run,
      })
    ).resolves.toEqual({ coalesced: true })

    expect(run).not.toHaveBeenCalled()
    expect(redis.eval).not.toHaveBeenCalled()
  })

  it('renews a long-running owner with the same fenced token', async () => {
    jest.useFakeTimers()
    try {
      const redis = redisMock()
      let finishRun: ((value: string) => void) | undefined
      const run = new Promise<string>((resolve) => {
        finishRun = resolve
      })
      const leasedRun = withSourceJobLease({
        redis,
        lane: 'tier-a',
        sourceSlug: 'binance_futures',
        run: () => run,
      })
      await Promise.resolve()

      await jest.advanceTimersByTimeAsync(SOURCE_JOB_LEASE_RENEW_MS)

      const token = (redis.set as jest.Mock).mock.calls[0]?.[1]
      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("pexpire", KEYS[1], ARGV[2])'),
        1,
        'arena:ingest:source-job-lease:tier-a:binance_futures',
        token,
        String(SOURCE_JOB_LEASE_TTL_MS)
      )

      finishRun?.('done')
      await expect(leasedRun).resolves.toEqual({ coalesced: false, value: 'done' })
    } finally {
      jest.useRealTimers()
    }
  })

  it('bounds a crashed owner lease below the worker stalled interval', () => {
    expect(SOURCE_JOB_LEASE_TTL_MS).toBeLessThan(5 * 60_000)
  })

  it('rejects unsafe key material before touching Redis', async () => {
    const redis = redisMock()

    await expect(
      withSourceJobLease({
        redis,
        lane: 'tier-a',
        sourceSlug: '../other',
        run: async () => undefined,
      })
    ).rejects.toThrow('unsafe source-job lease identity')

    expect(redis.set).not.toHaveBeenCalled()
  })
})
