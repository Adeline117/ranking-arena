import { createHash } from 'node:crypto'

import {
  SOURCE_JOB_LEASE_COMMAND_TIMEOUT_MS,
  SOURCE_JOB_LEASE_PROVENANCE_CONTRACT,
  SOURCE_JOB_LEASE_RENEW_MS,
  SOURCE_JOB_LEASE_TTL_MS,
  type SourceJobLeaseAuthority,
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
        scopeId: 'binance_futures',
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
    const ownerToken = (redis.set as jest.Mock).mock.calls[0]?.[1]
    const proof = run.mock.calls[0]?.[0]
    expect(proof).toEqual({
      contract: SOURCE_JOB_LEASE_PROVENANCE_CONTRACT,
      leaseId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      ),
      lane: 'tier-a',
      scopeId: 'binance_futures',
      ownerTokenSha256: createHash('sha256').update(ownerToken, 'utf8').digest('hex'),
    })
    expect(Object.isFrozen(proof)).toBe(true)
    expect(Object.keys(proof)).toEqual([
      'contract',
      'leaseId',
      'lane',
      'scopeId',
      'ownerTokenSha256',
    ])
    expect(ownerToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(ownerToken).not.toBe(proof.leaseId)
    expect(ownerToken).not.toBe(proof.ownerTokenSha256)
    expect(JSON.stringify(proof)).not.toContain(ownerToken)
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("del", KEYS[1])'),
      1,
      'arena:ingest:source-job-lease:tier-a:binance_futures',
      ownerToken
    )
  })

  it('coalesces a duplicate without running or deleting the owner lease', async () => {
    const redis = redisMock({ set: jest.fn(async () => null) })
    const run = jest.fn(async () => 'should-not-run')

    await expect(
      withSourceJobLease({
        redis,
        lane: 'tier-a',
        scopeId: 'binance_futures',
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
        scopeId: 'binance_futures',
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
        scopeId: 'binance_futures',
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

  it('token-cleans and sanitizes an acquire command rejection', async () => {
    let leakedOwnerToken = ''
    const redis = redisMock({
      set: jest.fn(async (_key: string, ownerToken: string) => {
        leakedOwnerToken = ownerToken
        const spoofedSafeError = new Error(
          '[ingest] source-job lease acquire: tier-a/binance_futures timed out'
        ) as Error & { cause?: string }
        spoofedSafeError.name = ownerToken
        spoofedSafeError.cause = ownerToken
        throw spoofedSafeError
      }),
    })
    const run = jest.fn(async () => 'must-not-run')

    const failure = await withSourceJobLease({
      redis,
      lane: 'tier-a',
      scopeId: 'binance_futures',
      run,
    }).catch((error: unknown) => error)

    expect(failure).toMatchObject({
      message: '[ingest] source-job lease acquire failed: tier-a/binance_futures',
    })
    expect(failure).not.toHaveProperty('cause')
    expect(String((failure as Error).stack)).not.toContain(leakedOwnerToken)

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
        scopeId: 'binance_futures',
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
        scopeId: 'binance_futures',
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

  it('provides a frozen single-flight renewal authority that closes after the run', async () => {
    let finishRenewal!: (value: number) => void
    const renewal = new Promise<number>((resolve) => {
      finishRenewal = resolve
    })
    const redis = redisMock({
      eval: jest
        .fn()
        .mockImplementationOnce(() => renewal)
        .mockResolvedValueOnce(1),
    })
    let retainedAuthority!: SourceJobLeaseAuthority
    const leasedRun = withSourceJobLease({
      redis,
      lane: 'tier-a',
      scopeId: 'binance_futures',
      run: async (proof, _signal, authority) => {
        retainedAuthority = authority
        expect(Object.isFrozen(authority)).toBe(true)
        expect(authority.proof).toBe(proof)
        authority.assertOwned()
        const first = authority.renew()
        const second = authority.renew()
        expect(second).toBe(first)
        finishRenewal(1)
        await Promise.all([first, second])
        return 'finished'
      },
    })

    await expect(leasedRun).resolves.toEqual({ coalesced: false, value: 'finished' })

    expect(redis.eval).toHaveBeenCalledTimes(2)
    expect(() => retainedAuthority.assertOwned()).toThrow('lease authority is closed')
    await expect(retainedAuthority.renew()).rejects.toThrow('lease authority is closed')
  })

  it('sanitizes a best-effort cleanup rejection that contains the owner token', async () => {
    const onLeaseError = jest.fn()
    const redis = redisMock({
      eval: jest.fn(async (_script: string, _keyCount: 1, _key: string, ownerToken: string) => {
        throw new Error(`Redis cleanup failed for owner token ${ownerToken}`)
      }),
    })

    await expect(
      withSourceJobLease({
        redis,
        lane: 'tier-a',
        scopeId: 'binance_futures',
        run: async () => 'finished',
        onLeaseError,
      })
    ).resolves.toEqual({ coalesced: false, value: 'finished' })

    const ownerToken = (redis.set as jest.Mock).mock.calls[0]?.[1]
    expect(onLeaseError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: '[ingest] source-job lease cleanup failed: tier-a/binance_futures',
      })
    )
    expect(JSON.stringify(onLeaseError.mock.calls)).not.toContain(ownerToken)
  })

  it('aborts the active run when lease renewal loses ownership', async () => {
    jest.useFakeTimers()
    try {
      const redis = redisMock({ eval: jest.fn(async () => 0) })
      const onLeaseError = jest.fn()
      const run = jest.fn(
        (_proof: unknown, signal: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            const rejectFromAbort = () => reject(signal.reason)
            signal.addEventListener('abort', rejectFromAbort, { once: true })
            if (signal.aborted) rejectFromAbort()
          })
      )
      const leasedRun = withSourceJobLease({
        redis,
        lane: 'tier-a',
        scopeId: 'binance_futures',
        run,
        onLeaseError,
      })
      await Promise.resolve()
      const rejected = expect(leasedRun).rejects.toThrow('source-job lease ownership lost')

      await jest.advanceTimersByTimeAsync(SOURCE_JOB_LEASE_RENEW_MS)

      await rejected
      expect(run.mock.calls[0]?.[1]).toMatchObject({ aborted: true })
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
        scopeId: 'binance_futures',
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
    const run = jest.fn(async (_proof: unknown, signal: AbortSignal) => {
      signal.throwIfAborted()
    })

    await expect(
      withSourceJobLease({
        redis,
        lane: 'tier-a',
        scopeId: 'binance_futures',
        run,
        signal: controller.signal,
      })
    ).rejects.toBe(cancellation)

    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[1].aborted).toBe(true)
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
        scopeId: 'binance_futures',
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
        (_proof: unknown, signal: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            const cancel = () => reject(signal.reason)
            signal.addEventListener('abort', cancel, { once: true })
            if (signal.aborted) cancel()
          })
      )
      const leasedRun = withSourceJobLease({
        redis,
        lane: 'tier-a',
        scopeId: 'binance_futures',
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

  it('aborts Tier-A with a sanitized error when Redis throws during renewal', async () => {
    jest.useFakeTimers()
    try {
      let ownerToken = ''
      const redis = redisMock({
        set: jest.fn(async (_key: string, value: string) => {
          ownerToken = value
          return 'OK'
        }),
        eval: jest
          .fn()
          .mockImplementationOnce(() => {
            throw new Error(`Redis EVAL threw with owner token ${ownerToken}`)
          })
          .mockResolvedValueOnce(1),
      })
      const onLeaseError = jest.fn()
      const run = jest.fn(
        (_proof: unknown, signal: AbortSignal) =>
          new Promise<never>((_resolve, reject) => {
            const cancel = () => reject(signal.reason)
            signal.addEventListener('abort', cancel, { once: true })
            if (signal.aborted) cancel()
          })
      )
      const leasedRun = withSourceJobLease({
        redis,
        lane: 'tier-a',
        scopeId: 'binance_futures',
        run,
        failClosedOnLeaseLoss: true,
        onLeaseError,
      })
      await Promise.resolve()
      const rejected = expect(leasedRun).rejects.toThrow(
        'source-job lease renewal failed: tier-a/binance_futures'
      )

      await jest.advanceTimersByTimeAsync(SOURCE_JOB_LEASE_RENEW_MS)

      await rejected
      expect(onLeaseError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '[ingest] source-job lease renewal failed: tier-a/binance_futures',
        })
      )
      expect(JSON.stringify(onLeaseError.mock.calls)).not.toContain(ownerToken)
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
        scopeId: 'binance_futures',
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
        scopeId: '../other',
        run: async () => undefined,
      })
    ).rejects.toThrow('unsafe source-job lease identity')

    expect(redis.set).not.toHaveBeenCalled()
  })
})
