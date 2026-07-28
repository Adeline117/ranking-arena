import {
  INITIAL_HEARTBEAT_TIMEOUT_MS,
  createWorkerOwnershipHeartbeatFactory,
  diskUsedPct,
  parseDiskUsedPct,
  resolveWorkerRuntimeIdentity,
  resolveWorkerReleaseId,
  startHeartbeat,
} from '../heartbeat'

const ORIGINAL_CAPTURE_FLAG = process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED

describe('worker heartbeat disk usage', () => {
  beforeEach(() => {
    process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED = 'true'
  })

  afterAll(() => {
    if (ORIGINAL_CAPTURE_FLAG === undefined) {
      delete process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED
    } else {
      process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED = ORIGINAL_CAPTURE_FLAG
    }
  })

  test('parses Linux and macOS POSIX df output', () => {
    expect(
      parseDiskUsedPct(
        [
          'Filesystem 1024-blocks Used Available Capacity Mounted on',
          '/dev/vda1 20480000 19456000 1024000 95% /',
        ].join('\n')
      )
    ).toBe(95)

    expect(
      parseDiskUsedPct(
        [
          'Filesystem 1024-blocks Used Available Capacity Mounted on',
          '/dev/disk3s1 100000000 97000000 3000000 97% /System/Volumes/Data',
        ].join('\n')
      )
    ).toBe(97)
  })

  test('rejects missing and out-of-range capacity values', () => {
    expect(parseDiskUsedPct('not df output')).toBeUndefined()
    expect(parseDiskUsedPct('/dev/vda1 1 1 0 101% /')).toBeUndefined()
  })

  test('checks the filesystem containing the supplied worker directory', () => {
    const readUsage = jest.fn(() => '/dev/disk3s1 100 97 3 97% /System/Volumes/Data')

    expect(diskUsedPct('/srv/ranking-arena', readUsage)).toBe(97)
    expect(readUsage).toHaveBeenCalledWith('/srv/ranking-arena')
  })

  test('fails open when df cannot inspect the worker filesystem', () => {
    expect(
      diskUsedPct('/srv/ranking-arena', () => {
        throw new Error('df failed')
      })
    ).toBeUndefined()
  })

  test('freezes one immutable runtime identity for both control planes', () => {
    const identity = resolveWorkerRuntimeIdentity()

    expect(Object.isFrozen(identity)).toBe(true)
    expect(identity).toMatchObject({
      attempt_bound_capture: true,
      node: expect.any(String),
      pid: process.pid,
      release_id: expect.any(String),
      sha: expect.any(String),
    })
  })

  test('refreshes only disk evidence across exact one-region authority heartbeats', () => {
    const identity = {
      attempt_bound_capture: true,
      node: 'fixed-worker',
      pid: 42,
      release_id: 'a'.repeat(64),
      sha: 'b'.repeat(40),
    }
    const readDisk = jest.fn().mockReturnValueOnce(91).mockReturnValueOnce(92)
    const buildHeartbeat = createWorkerOwnershipHeartbeatFactory(identity, 'local', readDisk)
    identity.node = 'mutated-worker'
    identity.sha = 'f'.repeat(40)

    expect(buildHeartbeat()).toEqual({
      attempt_bound_capture: true,
      disk: 91,
      node: 'fixed-worker',
      pid: 42,
      release_id: 'a'.repeat(64),
      regions: ['local'],
      sha: 'b'.repeat(40),
    })
    expect(buildHeartbeat()).toEqual({
      attempt_bound_capture: true,
      disk: 92,
      node: 'fixed-worker',
      pid: 42,
      release_id: 'a'.repeat(64),
      regions: ['local'],
      sha: 'b'.repeat(40),
    })
    expect(readDisk).toHaveBeenCalledTimes(2)
  })

  test('snapshots supplied identity and regions instead of rereading mutable inputs', async () => {
    jest.useFakeTimers()
    const identity = {
      attempt_bound_capture: true,
      node: 'frozen-sg-worker',
      pid: 77,
      release_id: 'c'.repeat(64),
      sha: 'd'.repeat(40),
    }
    const regions = ['vps_sg']
    const previous = process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED
    let timer: NodeJS.Timeout | undefined
    try {
      process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED = 'false'
      const hset = jest.fn().mockResolvedValue(1)
      timer = await startHeartbeat({ hset } as never, regions, identity)
      identity.node = 'mutated-worker'
      identity.sha = 'e'.repeat(40)
      regions[0] = 'local'
      await jest.advanceTimersByTimeAsync(60_000)

      expect(hset).toHaveBeenCalledTimes(2)
      for (const call of hset.mock.calls) {
        expect(JSON.parse(call[2])).toMatchObject({
          attempt_bound_capture: true,
          node: 'frozen-sg-worker',
          pid: 77,
          regions: ['vps_sg'],
          release_id: 'c'.repeat(64),
          sha: 'd'.repeat(40),
        })
      }
    } finally {
      if (timer) clearInterval(timer)
      if (previous === undefined) delete process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED
      else process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED = previous
      jest.useRealTimers()
    }
  })

  test('awaits a valid first HSET before emitting the committed token', async () => {
    const original = process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED
    const originalNode = process.env.WORKER_NODE_ID
    let timer: NodeJS.Timeout | undefined
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    try {
      process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED = 'true'
      process.env.WORKER_NODE_ID = 'sg-test-node'
      let acknowledge!: (value: number) => void
      const hset = jest.fn(
        () =>
          new Promise<number>((resolveAcknowledgement) => {
            acknowledge = resolveAcknowledgement
          })
      )

      const started = startHeartbeat({ hset } as never, ['vps_sg'])
      expect(log.mock.calls.some(([line]) => String(line).includes('redis-hset-committed'))).toBe(
        false
      )
      acknowledge(1)
      timer = await started

      const payload = JSON.parse(hset.mock.calls[0][2])
      expect(payload.attempt_bound_capture).toBe(true)
      expect(payload.release_id).toBe('unknown')
      expect(payload.regions).toEqual(['vps_sg'])
      expect(log).toHaveBeenCalledWith(
        `[heartbeat] redis-hset-committed node=sg-test-node pid=${process.pid} ` +
          `sha=${payload.sha} release=unknown ts=${payload.ts}`
      )
    } finally {
      if (timer) clearInterval(timer)
      log.mockRestore()
      if (original === undefined) delete process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED
      else process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED = original
      if (originalNode === undefined) delete process.env.WORKER_NODE_ID
      else process.env.WORKER_NODE_ID = originalNode
    }
  })

  test('accepts Redis HSET acknowledgement zero', async () => {
    const timer = await startHeartbeat({ hset: jest.fn().mockResolvedValue(0) } as never, ['local'])
    clearInterval(timer)
  })

  test('fails closed when the first Redis HSET rejects', async () => {
    const secretUrl = 'rediss://user:super-secret@host'
    const log = jest.spyOn(console, 'log').mockImplementation(() => {})
    let failure: unknown
    try {
      await startHeartbeat({ hset: jest.fn().mockRejectedValue(new Error(secretUrl)) } as never, [
        'vps_sg',
      ])
    } catch (error) {
      failure = error
    } finally {
      expect(log.mock.calls.some(([line]) => String(line).includes('redis-hset-committed'))).toBe(
        false
      )
      log.mockRestore()
    }

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toBe('[heartbeat] Redis HSET failed')
    expect(message).not.toContain('rediss://')
    expect(message).not.toContain('super-secret')
  })

  test.each([undefined, 'false'])(
    'refuses SG startup before HSET when attempt-bound capture is %p',
    async (captureFlag) => {
      if (captureFlag === undefined) delete process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED
      else process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED = captureFlag
      const hset = jest.fn()
      const log = jest.spyOn(console, 'log').mockImplementation(() => {})
      try {
        await expect(startHeartbeat({ hset } as never, ['vps_sg'])).rejects.toThrow(
          '[heartbeat] SG attempt-bound capture must be enabled'
        )
        expect(hset).not.toHaveBeenCalled()
        expect(log.mock.calls.some(([line]) => String(line).includes('redis-hset-committed'))).toBe(
          false
        )
      } finally {
        log.mockRestore()
      }
    }
  )

  test.each([2, -1, '1', null])(
    'fails closed when the first Redis HSET acknowledgement is invalid (%p)',
    async (acknowledgement) => {
      await expect(
        startHeartbeat({ hset: jest.fn().mockResolvedValue(acknowledgement) } as never, ['vps_sg'])
      ).rejects.toThrow('[heartbeat] Redis HSET returned an invalid acknowledgement')
    }
  )

  test('fails closed when the first Redis HSET exceeds the bounded timeout', async () => {
    jest.useFakeTimers()
    try {
      const started = startHeartbeat(
        { hset: jest.fn(() => new Promise<never>(() => {})) } as never,
        ['vps_sg']
      )
      const rejected = expect(started).rejects.toThrow('[heartbeat] Redis HSET timed out')
      await jest.advanceTimersByTimeAsync(INITIAL_HEARTBEAT_TIMEOUT_MS)
      await rejected
    } finally {
      jest.useRealTimers()
    }
  })

  test('keeps later periodic HSET failures non-fatal', async () => {
    jest.useFakeTimers()
    const error = jest.spyOn(console, 'error').mockImplementation(() => {})
    let timer: NodeJS.Timeout | undefined
    try {
      const hset = jest
        .fn()
        .mockResolvedValueOnce(1)
        .mockRejectedValueOnce(new Error('temporary Redis outage'))
      timer = await startHeartbeat({ hset } as never, ['local'])

      await jest.advanceTimersByTimeAsync(60_000)

      expect(hset).toHaveBeenCalledTimes(2)
      expect(error).toHaveBeenCalledWith('[heartbeat] periodic Redis HSET failed')
    } finally {
      if (timer) clearInterval(timer)
      error.mockRestore()
      jest.useRealTimers()
    }
  })

  test('accepts only a release ID stamped into the deployment directory', () => {
    const readReleaseFile = jest.fn(() => 'c'.repeat(64) + '\n')

    expect(resolveWorkerReleaseId(readReleaseFile as never, '/srv/arena-release')).toBe(
      'c'.repeat(64)
    )
    expect(readReleaseFile).toHaveBeenCalledWith('/srv/arena-release/WORKER_RELEASE_ID', 'utf8')
    expect(resolveWorkerReleaseId((() => 'forged') as never, '/srv/arena-release')).toBe('unknown')
  })
})
