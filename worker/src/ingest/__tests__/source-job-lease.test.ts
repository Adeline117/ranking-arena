import {
  SOURCE_JOB_LEASE_COMMAND_TIMEOUT_MS,
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

  it('rejects a non-canonical acquire result instead of skipping the job', async () => {
    const redis = redisMock({
      set: jest.fn(async (): Promise<string | null> => 'ok'),
    })
    const run = jest.fn(async () => 'must-not-run')

    await expect(
      withSourceJobLease({
        redis,
        lane: 'tier-a',
        sourceSlug: 'binance_futures',
        run,
      })
    ).rejects.toThrow('lease acquire returned an invalid result')

    expect(run).not.toHaveBeenCalled()
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("del", KEYS[1])'),
      1,
      'arena:ingest:source-job-lease:tier-a:binance_futures',
      expect.any(String)
    )
  })

  it('bounds cleanup for an acquire command that never settles', async () => {
    jest.useFakeTimers()
    try {
      const redis = redisMock({
        set: jest.fn(() => new Promise<string | null>(() => {})),
        eval: jest.fn(() => new Promise<never>(() => {})),
      })
      const onLeaseError = jest.fn()
      const run = jest.fn(async () => 'must-not-run')
      const leasedRun = withSourceJobLease({
        redis,
        lane: 'tier-a',
        sourceSlug: 'binance_futures',
        run,
        onLeaseError,
      })
      const rejected = expect(leasedRun).rejects.toThrow(
        'lease acquire: tier-a/binance_futures timed out'
      )

      await jest.advanceTimersByTimeAsync(SOURCE_JOB_LEASE_COMMAND_TIMEOUT_MS * 2)

      await rejected
      expect(run).not.toHaveBeenCalled()
      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("del", KEYS[1])'),
        1,
        'arena:ingest:source-job-lease:tier-a:binance_futures',
        expect.any(String)
      )
      expect(onLeaseError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('uncertain acquire cleanup') })
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it('token-cleans an acquire command rejection before preserving its error', async () => {
    const acquireFailure = new Error('Redis SET failed')
    const redis = redisMock({ set: jest.fn(async () => Promise.reject(acquireFailure)) })
    const run = jest.fn(async () => 'must-not-run')

    await expect(
      withSourceJobLease({
        redis,
        lane: 'tier-a',
        sourceSlug: 'binance_futures',
        run,
      })
    ).rejects.toBe(acquireFailure)

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("del", KEYS[1])'),
      1,
      'arena:ingest:source-job-lease:tier-a:binance_futures',
      expect.any(String)
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('queues token-fenced cleanup behind a timed-out acquire that succeeds late', async () => {
    jest.useFakeTimers()
    try {
      let finishAcquire!: (value: string | null) => void
      const acquire = new Promise<string | null>((resolve) => {
        finishAcquire = resolve
      })
      let finishCleanup!: (value: number) => void
      const cleanup = new Promise<number>((resolve) => {
        finishCleanup = resolve
      })
      const redis = redisMock({
        set: jest.fn(() => acquire),
        eval: jest.fn(() => cleanup),
      })
      const run = jest.fn(async () => 'must-not-run')
      const leasedRun = withSourceJobLease({
        redis,
        lane: 'tier-a',
        sourceSlug: 'binance_futures',
        run,
        onLeaseError: jest.fn(),
      })
      const rejected = expect(leasedRun).rejects.toThrow(
        'lease acquire: tier-a/binance_futures timed out'
      )

      await jest.advanceTimersByTimeAsync(SOURCE_JOB_LEASE_COMMAND_TIMEOUT_MS)
      expect(redis.eval).toHaveBeenCalledTimes(1)
      const token = (redis.set as jest.Mock).mock.calls[0]?.[1]
      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("del", KEYS[1])'),
        1,
        'arena:ingest:source-job-lease:tier-a:binance_futures',
        token
      )
      finishAcquire('OK')
      finishCleanup(1)

      await rejected
      expect(run).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
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

  it('aborts the active run when lease renewal loses ownership', async () => {
    jest.useFakeTimers()
    try {
      const redis = redisMock({ eval: jest.fn(async () => 0) })
      const onLeaseError = jest.fn()
      const run = jest.fn(
        (signal: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            const rejectFromAbort = () => reject(signal.reason)
            signal.addEventListener('abort', rejectFromAbort, { once: true })
            if (signal.aborted) rejectFromAbort()
          })
      )
      const leasedRun = withSourceJobLease({
        redis,
        lane: 'tier-a',
        sourceSlug: 'binance_futures',
        run,
        onLeaseError,
      })
      await Promise.resolve()
      const rejected = expect(leasedRun).rejects.toThrow('source-job lease ownership lost')

      await jest.advanceTimersByTimeAsync(SOURCE_JOB_LEASE_RENEW_MS)

      await rejected
      expect(run.mock.calls[0]?.[0]).toMatchObject({ aborted: true })
      expect(onLeaseError).toHaveBeenCalledTimes(1)
      expect(redis.eval).toHaveBeenLastCalledWith(
        expect.stringContaining('redis.call("del", KEYS[1])'),
        1,
        expect.any(String),
        expect.any(String)
      )
    } finally {
      jest.useRealTimers()
    }
  })

  it('never renews a zombie run again after the first ownership loss', async () => {
    jest.useFakeTimers()
    try {
      const redis = redisMock({
        eval: jest.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1),
      })
      const onLeaseError = jest.fn()
      let finishRun!: () => void
      const run = new Promise<void>((resolve) => {
        finishRun = resolve
      })
      const leasedRun = withSourceJobLease({
        redis,
        lane: 'tier-a',
        sourceSlug: 'binance_futures',
        run: async () => run,
        failClosedOnLeaseLoss: true,
        onLeaseError,
      })
      await Promise.resolve()
      const rejected = expect(leasedRun).rejects.toThrow('source-job lease ownership lost')

      await jest.advanceTimersByTimeAsync(SOURCE_JOB_LEASE_RENEW_MS)
      await jest.advanceTimersByTimeAsync(SOURCE_JOB_LEASE_RENEW_MS * 3)

      expect(redis.eval).toHaveBeenCalledTimes(1)
      finishRun()
      await rejected
      expect(redis.eval).toHaveBeenCalledTimes(2)
      expect(onLeaseError).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('combines an already-aborted caller signal with the lease signal', async () => {
    const redis = redisMock()
    const controller = new AbortController()
    const cancellation = new Error('authority lost')
    controller.abort(cancellation)
    const run = jest.fn(async (signal: AbortSignal) => {
      signal.throwIfAborted()
    })

    await expect(
      withSourceJobLease({
        redis,
        lane: 'tier-a',
        sourceSlug: 'binance_futures',
        run,
        signal: controller.signal,
      })
    ).rejects.toBe(cancellation)

    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0].aborted).toBe(true)
  })

  it('does not accept a Tier-A success racing an in-flight lost renewal', async () => {
    jest.useFakeTimers()
    try {
      let finishRenewal!: (value: number) => void
      const renewal = new Promise<number>((resolve) => {
        finishRenewal = resolve
      })
      const redis = redisMock({
        eval: jest
          .fn()
          .mockImplementationOnce(async () => renewal)
          .mockResolvedValueOnce(1),
      })
      let finishRun!: () => void
      const run = new Promise<void>((resolve) => {
        finishRun = resolve
      })
      const leasedRun = withSourceJobLease({
        redis,
        lane: 'tier-a',
        sourceSlug: 'binance_futures',
        run: async () => run,
        failClosedOnLeaseLoss: true,
        onLeaseError: jest.fn(),
      })
      await Promise.resolve()
      const rejected = expect(leasedRun).rejects.toThrow('source-job lease ownership lost')

      await jest.advanceTimersByTimeAsync(SOURCE_JOB_LEASE_RENEW_MS)
      finishRun()
      await Promise.resolve()
      finishRenewal(0)

      await rejected
      expect(redis.eval).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })

  it('aborts Tier-A when a renewal command never settles', async () => {
    jest.useFakeTimers()
    try {
      const never = new Promise<never>(() => {})
      const redis = redisMock({
        eval: jest
          .fn()
          .mockImplementationOnce(() => never)
          .mockResolvedValueOnce(1),
      })
      const onLeaseError = jest.fn()
      const run = jest.fn(
        (signal: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            const cancel = () => reject(signal.reason)
            signal.addEventListener('abort', cancel, { once: true })
            if (signal.aborted) cancel()
          })
      )
      const leasedRun = withSourceJobLease({
        redis,
        lane: 'tier-a',
        sourceSlug: 'binance_futures',
        run,
        failClosedOnLeaseLoss: true,
        onLeaseError,
      })
      await Promise.resolve()
      const rejected = expect(leasedRun).rejects.toThrow(
        'source-job lease renewal: tier-a/binance_futures timed out'
      )

      await jest.advanceTimersByTimeAsync(
        SOURCE_JOB_LEASE_RENEW_MS + SOURCE_JOB_LEASE_COMMAND_TIMEOUT_MS
      )

      await rejected
      expect(onLeaseError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('renewal') })
      )
      expect(redis.eval).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })

  it('aborts Tier-A when Redis throws synchronously during renewal', async () => {
    jest.useFakeTimers()
    try {
      const renewalFailure = new Error('Redis EVAL threw synchronously')
      const redis = redisMock({
        eval: jest
          .fn()
          .mockImplementationOnce(() => {
            throw renewalFailure
          })
          .mockResolvedValueOnce(1),
      })
      const onLeaseError = jest.fn()
      const run = jest.fn(
        (signal: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            const cancel = () => reject(signal.reason)
            signal.addEventListener('abort', cancel, { once: true })
            if (signal.aborted) cancel()
          })
      )
      const leasedRun = withSourceJobLease({
        redis,
        lane: 'tier-a',
        sourceSlug: 'binance_futures',
        run,
        failClosedOnLeaseLoss: true,
        onLeaseError,
      })
      await Promise.resolve()
      const rejected = expect(leasedRun).rejects.toBe(renewalFailure)

      await jest.advanceTimersByTimeAsync(SOURCE_JOB_LEASE_RENEW_MS)

      await rejected
      expect(onLeaseError).toHaveBeenCalledWith(renewalFailure)
      expect(redis.eval).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })

  it('bounds best-effort cleanup and observes a late delete rejection', async () => {
    jest.useFakeTimers()
    try {
      let rejectLateCleanup!: (error: Error) => void
      const cleanup = new Promise<never>((_resolve, reject) => {
        rejectLateCleanup = reject
      })
      const redis = redisMock({ eval: jest.fn(() => cleanup) })
      const onLeaseError = jest.fn()
      const leasedRun = withSourceJobLease({
        redis,
        lane: 'tier-a',
        sourceSlug: 'binance_futures',
        run: async () => 'finished',
        failClosedOnLeaseLoss: true,
        onLeaseError,
      })
      await Promise.resolve()
      const completed = expect(leasedRun).resolves.toEqual({
        coalesced: false,
        value: 'finished',
      })

      await jest.advanceTimersByTimeAsync(SOURCE_JOB_LEASE_COMMAND_TIMEOUT_MS)

      await completed
      expect(onLeaseError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('cleanup') })
      )
      rejectLateCleanup(new Error('late Redis cleanup rejection'))
      await Promise.resolve()
      expect(onLeaseError).toHaveBeenCalledTimes(1)
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
