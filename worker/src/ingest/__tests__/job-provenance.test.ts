import { createHash } from 'node:crypto'

import {
  BULL_ATTEMPT_COUNTER_MAX,
  BULL_JOB_DATA_CHECKPOINT_SCRIPT,
  BULL_JOB_PROVENANCE_CONTRACT,
  BULL_LOCK_COMMAND_TIMEOUT_MS,
  BULL_LOCK_DURATION_MAX_MS,
  createBullJobCheckpointTarget,
  createBullJobProvenance,
  createManagedBullJobAuthority,
  createUnownedBullJobAuthority,
  type BullCheckpointEvaluator,
  type BullJobProvenanceInput,
} from '../job-provenance'

function checkpointHarness(
  evaluator: BullCheckpointEvaluator,
  overrides: Partial<BullJobProvenanceInput> = {},
  processorToken = 'private-checkpoint-token'
) {
  const job: BullJobProvenanceInput = {
    attemptsMade: 1,
    attemptsStarted: 2,
    data: { sourceSlug: 'binance_futures', completedTimeframes: [7] },
    id: 'repeat:tiera:binance_futures',
    name: 'tiera:leaderboard',
    queueName: 'arena-ingest',
    queueQualifiedName: 'bull:arena-ingest',
    ...overrides,
  }
  const proof = createBullJobProvenance(job, processorToken)
  const target = createBullJobCheckpointTarget(proof, job.queueQualifiedName, evaluator)
  const managed = createManagedBullJobAuthority(
    job,
    processorToken,
    new AbortController().signal,
    target
  )
  return { job, managed, processorToken, proof, target }
}

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

  it('atomically checkpoints exact expected JSON and mutates local data only after success', async () => {
    let finishCheckpoint!: (status: unknown) => void
    const pending = new Promise<unknown>((resolve) => {
      finishCheckpoint = resolve
    })
    const evaluate = jest.fn(() => pending)
    const evaluator: BullCheckpointEvaluator = { eval: evaluate }
    const { job, managed, processorToken, target } = checkpointHarness(evaluator)
    const originalData = job.data
    const nextData = {
      sourceSlug: 'binance_futures',
      completedTimeframes: [7, 30],
      extensible: { cursor: 'page-3' },
    }

    const checkpoint = managed.authority.replaceDataIfOwned(nextData)

    expect(job.data).toBe(originalData)
    expect(target).toEqual({
      evaluator,
      jobId: 'repeat:tiera:binance_futures',
      jobKey: 'bull:arena-ingest:repeat:tiera:binance_futures',
      lockKey: 'bull:arena-ingest:repeat:tiera:binance_futures:lock',
      queueName: 'arena-ingest',
    })
    expect(Object.isFrozen(target)).toBe(true)
    expect(evaluate).toHaveBeenCalledWith(
      BULL_JOB_DATA_CHECKPOINT_SCRIPT,
      2,
      'bull:arena-ingest:repeat:tiera:binance_futures',
      'bull:arena-ingest:repeat:tiera:binance_futures:lock',
      processorToken,
      '{"sourceSlug":"binance_futures","completedTimeframes":[7]}',
      '{"sourceSlug":"binance_futures","completedTimeframes":[7,30],"extensible":{"cursor":"page-3"}}'
    )

    nextData.completedTimeframes.push(90)
    nextData.extensible.cursor = 'caller-mutated'
    expect(job.data).toBe(originalData)
    finishCheckpoint(1)
    await expect(checkpoint).resolves.toBeUndefined()

    expect(job.data).toEqual({
      sourceSlug: 'binance_futures',
      completedTimeframes: [7, 30],
      extensible: { cursor: 'page-3' },
    })
    expect(job.data).not.toBe(nextData)
    expect(Object.isFrozen(job.data)).toBe(true)
    expect(
      Object.isFrozen((job.data as { completedTimeframes: number[] }).completedTimeframes)
    ).toBe(true)
    expect(Object.isFrozen((job.data as { extensible: object }).extensible)).toBe(true)

    const scriptOrder = [
      BULL_JOB_DATA_CHECKPOINT_SCRIPT.indexOf("redis.call('GET'"),
      BULL_JOB_DATA_CHECKPOINT_SCRIPT.indexOf("redis.call('EXISTS'"),
      BULL_JOB_DATA_CHECKPOINT_SCRIPT.indexOf("redis.call('HGET'"),
      BULL_JOB_DATA_CHECKPOINT_SCRIPT.indexOf("redis.call('HSET'"),
    ]
    expect(scriptOrder.every((position) => position >= 0)).toBe(true)
    expect(scriptOrder).toEqual([...scriptOrder].sort((left, right) => left - right))
    expect(BULL_JOB_DATA_CHECKPOINT_SCRIPT).not.toContain('updateData')
  })

  it.each([
    [-1, 'Bull job lock ownership lost'],
    [-2, 'Bull job no longer exists for checkpoint'],
    [-3, 'Bull job data changed before checkpoint'],
  ])('makes Redis CAS status %i a sticky authority failure', async (status, message) => {
    const evaluate = jest.fn(async () => status)
    const { job, managed } = checkpointHarness({ eval: evaluate })
    const originalData = job.data

    await expect(
      managed.authority.replaceDataIfOwned({ sourceSlug: 'binance_futures', marker: status })
    ).rejects.toThrow(message)

    expect(job.data).toBe(originalData)
    expect(() => managed.authority.assertActive()).toThrow(message)
    await expect(
      managed.authority.replaceDataIfOwned({ sourceSlug: 'binance_futures', retry: true })
    ).rejects.toThrow(message)
    expect(evaluate).toHaveBeenCalledTimes(1)
  })

  it.each(['malformed', 'throw'] as const)(
    'sanitizes a %s evaluator outcome and never exposes the raw token',
    async (mode) => {
      const processorToken = 'checkpoint-token-must-not-escape'
      const evaluate = jest.fn(() => {
        if (mode === 'throw') {
          throw new Error(`Redis failed with ${processorToken}`)
        }
        return Promise.resolve({ malformed: processorToken })
      })
      const { job, managed } = checkpointHarness({ eval: evaluate }, {}, processorToken)
      const originalData = job.data

      const failure = await managed.authority
        .replaceDataIfOwned({ sourceSlug: 'binance_futures', completedTimeframes: [7, 30] })
        .catch((error: unknown) => error)

      expect(failure).toMatchObject({
        message: '[ingest-worker] Bull job data checkpoint unavailable',
      })
      expect(failure).not.toHaveProperty('cause')
      expect(String((failure as Error).stack)).not.toContain(processorToken)
      expect(JSON.stringify(managed.authority)).not.toContain(processorToken)
      expect(job.data).toBe(originalData)
      expect(() => managed.authority.assertActive()).toThrow('checkpoint unavailable')
      expect(evaluate).toHaveBeenCalledTimes(1)
    }
  )

  it('times out once, observes a late success, and never replays an uncertain checkpoint', async () => {
    jest.useFakeTimers()
    try {
      let finishCheckpoint!: (status: unknown) => void
      const pending = new Promise<unknown>((resolve) => {
        finishCheckpoint = resolve
      })
      const evaluate = jest.fn(() => pending)
      const { job, managed } = checkpointHarness({ eval: evaluate })
      const originalData = job.data
      const rejected = expect(
        managed.authority.replaceDataIfOwned({
          sourceSlug: 'binance_futures',
          completedTimeframes: [7, 30],
        })
      ).rejects.toThrow('Bull job data checkpoint unavailable')

      await jest.advanceTimersByTimeAsync(BULL_LOCK_COMMAND_TIMEOUT_MS)
      await rejected
      expect(job.data).toBe(originalData)

      finishCheckpoint(1)
      await Promise.resolve()
      await Promise.resolve()
      expect(job.data).toBe(originalData)
      expect(() => managed.authority.assertActive()).toThrow('checkpoint unavailable')
      await expect(
        managed.authority.replaceDataIfOwned({ sourceSlug: 'binance_futures', retry: true })
      ).rejects.toThrow('checkpoint unavailable')
      expect(evaluate).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it('explicitly rejects overlapping checkpoints and captures the new expected value next time', async () => {
    let finishFirst!: (status: unknown) => void
    const firstResult = new Promise<unknown>((resolve) => {
      finishFirst = resolve
    })
    const evaluate = jest
      .fn()
      .mockImplementationOnce(() => firstResult)
      .mockResolvedValueOnce(1)
    const { managed } = checkpointHarness({ eval: evaluate })
    const first = managed.authority.replaceDataIfOwned({
      sourceSlug: 'binance_futures',
      completedTimeframes: [7, 30],
    })

    await expect(
      managed.authority.replaceDataIfOwned({
        sourceSlug: 'binance_futures',
        completedTimeframes: [7, 90],
      })
    ).rejects.toThrow('checkpoint already in progress')
    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(() => managed.authority.assertActive()).not.toThrow()

    finishFirst(1)
    await first
    await expect(
      managed.authority.replaceDataIfOwned({
        sourceSlug: 'binance_futures',
        completedTimeframes: [7, 30, 90],
      })
    ).resolves.toBeUndefined()
    expect(evaluate).toHaveBeenCalledTimes(2)
    expect(evaluate.mock.calls[1]?.[5]).toBe(
      '{"sourceSlug":"binance_futures","completedTimeframes":[7,30]}'
    )
  })

  it('rejects a stale same-token writer through the expected-data compare', async () => {
    const processorToken = 'shared-token-for-stale-attempts'
    let redisData = '{"sourceSlug":"binance_futures","completedTimeframes":[7]}'
    const evaluate = jest.fn(
      async (
        _script: string,
        _numberOfKeys: number,
        _jobKey: string,
        _lockKey: string,
        token: string,
        expectedJson: string,
        nextJson: string
      ) => {
        if (token !== processorToken) return -1
        if (redisData !== expectedJson) return -3
        redisData = nextJson
        return 1
      }
    )
    const evaluator: BullCheckpointEvaluator = { eval: evaluate }
    const first = checkpointHarness(evaluator, {}, processorToken)
    const stale = checkpointHarness(evaluator, {}, processorToken)

    await first.managed.authority.replaceDataIfOwned({
      sourceSlug: 'binance_futures',
      completedTimeframes: [7, 30],
    })
    await expect(
      stale.managed.authority.replaceDataIfOwned({
        sourceSlug: 'binance_futures',
        completedTimeframes: [7, 90],
      })
    ).rejects.toThrow('Bull job data changed before checkpoint')

    expect(redisData).toBe('{"sourceSlug":"binance_futures","completedTimeframes":[7,30]}')
    expect(() => stale.managed.authority.assertActive()).toThrow(
      'Bull job data changed before checkpoint'
    )
  })

  it('rejects non-plain or lossy JSON without calling Redis or poisoning authority', async () => {
    const evaluate = jest.fn(async () => 1)
    const { managed } = checkpointHarness({ eval: evaluate })
    const cyclic: Record<string, unknown> = { sourceSlug: 'binance_futures' }
    cyclic.self = cyclic
    const accessor = { sourceSlug: 'binance_futures' } as Record<string, unknown>
    Object.defineProperty(accessor, 'cursor', {
      enumerable: true,
      get: () => 'secret-side-effect',
    })
    const symbolValue = { sourceSlug: 'binance_futures' }
    Object.defineProperty(symbolValue, Symbol('hidden'), { value: true })
    const inherited = Object.assign(Object.create({ polluted: true }), {
      sourceSlug: 'binance_futures',
    })
    const polluted = JSON.parse('{"sourceSlug":"binance_futures","__proto__":{"polluted":true}}')
    const sparse = { sourceSlug: 'binance_futures', values: new Array(2) }
    const invalidValues: unknown[] = [
      { sourceSlug: undefined },
      { sourceSlug: 'binance_futures', cursor: () => 'page-2' },
      { sourceSlug: 'binance_futures', count: Number.NaN },
      { sourceSlug: 'binance_futures', minusZero: -0 },
      { sourceSlug: 'binance_futures', bigint: BigInt(1) },
      cyclic,
      accessor,
      symbolValue,
      inherited,
      polluted,
      sparse,
      [],
    ]

    for (const invalid of invalidValues) {
      await expect(managed.authority.replaceDataIfOwned(invalid)).rejects.toThrow(
        'Bull job data must be canonical plain JSON'
      )
      expect(() => managed.authority.assertActive()).not.toThrow()
    }
    expect(evaluate).not.toHaveBeenCalled()

    const invalidCurrent = checkpointHarness(
      { eval: evaluate },
      { data: { sourceSlug: 'binance_futures', cursor: undefined } }
    )
    await expect(
      invalidCurrent.managed.authority.replaceDataIfOwned({ sourceSlug: 'binance_futures' })
    ).rejects.toThrow('Bull job data must be canonical plain JSON')
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('fails closed for forged queue identity, target objects, and unowned authorities', async () => {
    const evaluator: BullCheckpointEvaluator = { eval: jest.fn(async () => 1) }
    const job: BullJobProvenanceInput = {
      data: { sourceSlug: 'binance_futures' },
      id: 'job-queue-proof',
      name: 'tiera:leaderboard',
      queueName: 'arena-ingest',
      queueQualifiedName: 'bull:arena-ingest',
    }
    const proof = createBullJobProvenance(job, 'private-token')

    expect(() => createBullJobCheckpointTarget(proof, 'bull:other-queue', evaluator)).toThrow(
      'does not identify the provenance queue'
    )
    expect(() => createBullJobCheckpointTarget(proof, ' bull:arena-ingest', evaluator)).toThrow(
      'queue qualified name is not canonical'
    )
    const target = createBullJobCheckpointTarget(proof, job.queueQualifiedName, evaluator)
    expect(() =>
      createManagedBullJobAuthority(job, 'private-token', new AbortController().signal, {
        ...target,
        jobKey: 'bull:other-queue:job-queue-proof',
      })
    ).toThrow('checkpoint target does not match job provenance')

    const unowned = createUnownedBullJobAuthority(job)
    await expect(unowned.replaceDataIfOwned({ sourceSlug: 'binance_futures' })).rejects.toThrow(
      'checkpoint unavailable'
    )
    await expect(unowned.extendLock(60_000)).rejects.toThrow('Bull job lock extension unavailable')
    expect(() => unowned.assertActive()).toThrow('Bull job lock extension unavailable')
  })

  it.each([
    ['missing target', 'private-token'],
    ['missing token', undefined],
  ])('makes %s an immediately sticky checkpoint boundary failure', async (_case, token) => {
    const job: BullJobProvenanceInput = {
      data: { sourceSlug: 'binance_futures' },
      id: 'job-without-checkpoint-runtime',
      name: 'tiera:leaderboard',
      queueName: 'arena-ingest',
    }
    const evaluator: BullCheckpointEvaluator = { eval: jest.fn(async () => 1) }
    const target =
      token === undefined
        ? createBullJobCheckpointTarget(
            createBullJobProvenance(job),
            'bull:arena-ingest',
            evaluator
          )
        : undefined
    const managed = createManagedBullJobAuthority(job, token, new AbortController().signal, target)

    await expect(
      managed.authority.replaceDataIfOwned({ sourceSlug: 'binance_futures', marker: 'next' })
    ).rejects.toThrow('Bull job data checkpoint unavailable')
    expect(() => managed.authority.assertActive()).toThrow('Bull job data checkpoint unavailable')
    expect(evaluator.eval).not.toHaveBeenCalled()
  })
})
