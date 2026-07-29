import { createHash } from 'node:crypto'

import {
  BULL_ATTEMPT_COUNTER_MAX,
  BULL_JOB_PROVENANCE_CONTRACT,
  BULL_LOCK_COMMAND_TIMEOUT_MS,
  BULL_LOCK_DURATION_MAX_MS,
  createBullJobProvenance,
  createManagedBullJobAuthority,
} from '../job-provenance'

describe('Bull job provenance authority', () => {
  it('keeps the raw processor token inside a frozen exact-token capability', async () => {
    const processorToken = 'private-bull-lock-token'
    let finishExtension!: (value: number) => void
    const pendingExtension = new Promise<number>((resolve) => {
      finishExtension = resolve
    })
    const extendLock = jest.fn(() => pendingExtension)
    const managed = createManagedBullJobAuthority(
      {
        attemptsMade: 3,
        attemptsStarted: 4,
        extendLock,
        id: 'repeat:tiera:binance_futures',
        name: 'tiera:leaderboard',
        queueName: 'arena:ingest:local',
      },
      processorToken,
      new AbortController().signal
    )

    expect(managed.authority.proof).toEqual({
      contract: BULL_JOB_PROVENANCE_CONTRACT,
      queueName: 'arena:ingest:local',
      jobId: 'repeat:tiera:binance_futures',
      jobName: 'tiera:leaderboard',
      attemptsMade: 3,
      attemptsStarted: 4,
      processorTokenSha256: createHash('sha256').update(processorToken, 'utf8').digest('hex'),
    })
    expect(Object.keys(managed.authority.proof)).toEqual([
      'contract',
      'queueName',
      'jobId',
      'jobName',
      'attemptsMade',
      'attemptsStarted',
      'processorTokenSha256',
    ])
    expect(Object.isFrozen(managed)).toBe(true)
    expect(Object.isFrozen(managed.authority)).toBe(true)
    expect(Object.isFrozen(managed.authority.proof)).toBe(true)
    expect(JSON.stringify(managed.authority)).not.toContain(processorToken)

    const first = managed.authority.extendLock(60_000)
    const second = managed.authority.extendLock(60_000)
    expect(second).toBe(first)
    expect(extendLock).toHaveBeenCalledTimes(1)
    expect(extendLock).toHaveBeenCalledWith(processorToken, 60_000)
    finishExtension(1)
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])

    managed.close()
    expect(() => managed.authority.assertActive()).toThrow('authority is closed')
    await expect(managed.authority.extendLock(60_000)).rejects.toThrow('authority is closed')
  })

  it('fails closed when Bull no longer recognizes the exact token', async () => {
    const managed = createManagedBullJobAuthority(
      {
        extendLock: jest.fn(async () => 0),
        attemptsStarted: 1,
        id: 'job-1',
        name: 'tiera:leaderboard',
        queueName: 'arena:ingest:local',
      },
      'stale-token',
      new AbortController().signal
    )

    await expect(managed.authority.extendLock(60_000)).rejects.toThrow(
      'Bull job lock ownership lost'
    )
    expect(() => managed.authority.assertActive()).toThrow('Bull job lock ownership lost')
  })

  it('sanitizes third-party lock errors that contain the raw processor token', async () => {
    const processorToken = 'must-never-escape-through-errors'
    const thirdPartyFailure = new Error(`Redis command failed for token ${processorToken}`)
    const managed = createManagedBullJobAuthority(
      {
        extendLock: jest.fn(async () => Promise.reject(thirdPartyFailure)),
        id: 'job-2',
        name: 'tiera:leaderboard',
        queueName: 'arena:ingest:local',
      },
      processorToken,
      new AbortController().signal
    )

    const failure = await managed.authority.extendLock(60_000).catch((error: unknown) => error)

    expect(failure).toMatchObject({
      message: '[ingest-worker] Bull job lock extension unavailable',
    })
    expect(failure).not.toHaveProperty('cause')
    expect(String((failure as Error).stack)).not.toContain(processorToken)
    expect(() => managed.authority.assertActive()).toThrow(
      '[ingest-worker] Bull job lock extension unavailable'
    )
    expect(JSON.stringify(managed.authority)).not.toContain(processorToken)

    const spoofedOwnershipFailure = new Error(
      '[ingest-worker] Bull job lock ownership lost'
    ) as Error & { cause?: string }
    spoofedOwnershipFailure.cause = processorToken
    const spoofed = createManagedBullJobAuthority(
      {
        extendLock: jest.fn(async () => Promise.reject(spoofedOwnershipFailure)),
        id: 'job-2-spoofed',
        name: 'tiera:leaderboard',
        queueName: 'arena:ingest:local',
      },
      processorToken,
      new AbortController().signal
    )

    await expect(spoofed.authority.extendLock(60_000)).rejects.toMatchObject({
      message: '[ingest-worker] Bull job lock extension unavailable',
    })
  })

  it('bounds lock extension and safely observes a late third-party rejection', async () => {
    jest.useFakeTimers()
    try {
      const processorToken = 'late-private-token'
      let rejectExtension!: (error: Error) => void
      const extension = new Promise<number>((_resolve, reject) => {
        rejectExtension = reject
      })
      const managed = createManagedBullJobAuthority(
        {
          extendLock: jest.fn(() => extension),
          id: 'job-3',
          name: 'tiera:leaderboard',
          queueName: 'arena:ingest:local',
        },
        processorToken,
        new AbortController().signal
      )
      const rejected = expect(managed.authority.extendLock(60_000)).rejects.toThrow(
        'Bull job lock extension unavailable'
      )

      await jest.advanceTimersByTimeAsync(BULL_LOCK_COMMAND_TIMEOUT_MS)
      await rejected

      rejectExtension(new Error(`late Redis rejection for ${processorToken}`))
      await Promise.resolve()
      expect(() => managed.authority.assertActive()).toThrow('Bull job lock extension unavailable')
    } finally {
      jest.useRealTimers()
    }
  })

  it('rejects non-canonical provenance and bounded numeric fields', async () => {
    const base = {
      attemptsMade: 0,
      attemptsStarted: 1,
      id: 'job-4',
      name: 'tiera:leaderboard',
      queueName: 'arena:ingest:local',
    }

    expect(() => createBullJobProvenance({ ...base, queueName: ' arena:ingest:local' })).toThrow(
      'Bull queue name is not canonical'
    )
    expect(() => createBullJobProvenance({ ...base, id: 'job\n4' })).toThrow(
      'Bull job id is not canonical'
    )
    expect(() => createBullJobProvenance({ ...base, name: 'x'.repeat(257) })).toThrow(
      'Bull job name is not canonical'
    )
    expect(() =>
      createBullJobProvenance({ ...base, attemptsMade: BULL_ATTEMPT_COUNTER_MAX + 1 })
    ).toThrow('Bull attemptsMade is not canonical')
    expect(() =>
      createBullJobProvenance({ ...base, attemptsStarted: BULL_ATTEMPT_COUNTER_MAX + 1 })
    ).toThrow('Bull attemptsStarted is not canonical')
    expect(() => createBullJobProvenance({ ...base }, '')).toThrow(
      'Bull processor token is not canonical'
    )

    const managed = createManagedBullJobAuthority(
      { ...base, extendLock: jest.fn(async () => 1) },
      'private-token',
      new AbortController().signal
    )
    await expect(managed.authority.extendLock(BULL_LOCK_DURATION_MAX_MS + 1)).rejects.toThrow(
      'Bull lock extension duration is invalid'
    )
  })
})
