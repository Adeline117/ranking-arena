import {
  type ExpectedSgHeartbeat,
  type ProcessTreeReader,
  SG_ROSTER_READY_TOKEN,
  proveSgHeartbeatProcessTree,
  validateSgHeartbeatPayload,
  verifySgHeartbeatRoster,
} from '../../../verify-sg-heartbeat'
import {
  assertSgRuntimeEnvironment,
  assertSgRuntimeEnvironmentFile,
} from '../../../preflight-sg-runtime'

const SHA = 'a'.repeat(40)
const RELEASE = 'b'.repeat(64)
const NOW = 1_800_000_010_000
const NOT_BEFORE = 1_800_000_000_000

function expected(overrides: Partial<ExpectedSgHeartbeat> = {}): ExpectedSgHeartbeat {
  return {
    mode: 'candidate',
    sha: SHA,
    releaseId: RELEASE,
    notBeforeMs: NOT_BEFORE,
    pm2Pid: 100,
    ...overrides,
  }
}

function modernPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: NOT_BEFORE + 1,
    regions: ['vps_sg'],
    pid: 300,
    node: 'vps_sg',
    sha: SHA,
    release_id: RELEASE,
    attempt_bound_capture: true,
    disk: 40,
    ...overrides,
  })
}

function legacyPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: NOT_BEFORE + 1,
    regions: ['vps_sg'],
    pid: 300,
    node: 'vps_sg',
    sha: SHA,
    ...overrides,
  })
}

function tree(
  parents: Record<number, number>,
  live: number[] = [100, 200, 300]
): ProcessTreeReader {
  return {
    isAlive: (pid) => live.includes(pid),
    parentPid: (pid) => {
      const parent = parents[pid]
      if (parent === undefined) throw new Error('missing process')
      return parent
    },
  }
}

describe('SG Redis roster deployment proof', () => {
  test('preflights the exact SG node and region environment contract', () => {
    expect(() =>
      assertSgRuntimeEnvironment({
        WORKER_NODE_ID: 'vps_sg',
        INGEST_REGIONS: 'vps_sg',
        INGEST_LOCAL_REGION: 'vps_sg',
        INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED: 'true',
      })
    ).not.toThrow()
    for (const [key, value] of [
      ['WORKER_NODE_ID', 'hostname'],
      ['INGEST_REGIONS', 'local,vps_sg'],
      ['INGEST_LOCAL_REGION', 'local'],
    ]) {
      expect(() =>
        assertSgRuntimeEnvironment({
          WORKER_NODE_ID: 'vps_sg',
          INGEST_REGIONS: 'vps_sg',
          INGEST_LOCAL_REGION: 'vps_sg',
          INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED: 'true',
          [key]: value,
        })
      ).toThrow('must be exactly vps_sg')
    }
    for (const captureValue of [undefined, 'false']) {
      expect(() =>
        assertSgRuntimeEnvironment({
          WORKER_NODE_ID: 'vps_sg',
          INGEST_REGIONS: 'vps_sg',
          INGEST_LOCAL_REGION: 'vps_sg',
          INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED: captureValue,
        })
      ).toThrow('attempt-bound capture must be enabled')
    }
  })

  test('requires the box-local env file itself to carry the exact SG rollout contract', () => {
    const exact = {
      WORKER_NODE_ID: 'vps_sg',
      INGEST_REGIONS: 'vps_sg',
      INGEST_LOCAL_REGION: 'vps_sg',
      INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED: 'true',
    }
    expect(() => assertSgRuntimeEnvironmentFile(exact)).not.toThrow()
    expect(() => assertSgRuntimeEnvironmentFile(undefined)).toThrow(
      'worker/.env could not be parsed'
    )
    expect(() =>
      assertSgRuntimeEnvironmentFile({
        ...exact,
        INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED: 'false',
      })
    ).toThrow('attempt-bound capture must be enabled')
  })

  test('accepts the exact candidate identity and returns its heartbeat PID', () => {
    expect(validateSgHeartbeatPayload(modernPayload(), expected(), NOW)).toBe(300)
  })

  test.each([
    ['wrong node', { node: 'mac-mini' }],
    ['wrong region', { regions: ['local'] }],
    ['extra region', { regions: ['vps_sg', 'local'] }],
    ['wrong SHA', { sha: 'c'.repeat(40) }],
    ['wrong release', { release_id: 'd'.repeat(64) }],
    ['wrong PID', { pid: 0 }],
    ['stale timestamp', { ts: NOT_BEFORE - 1 }],
    ['future timestamp', { ts: NOW + 5_001 }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => validateSgHeartbeatPayload(modernPayload(overrides), expected(), NOW)).toThrow()
  })

  test('rejects absent, malformed, or widened roster payloads', () => {
    expect(() => validateSgHeartbeatPayload(null, expected(), NOW)).toThrow()
    expect(() => validateSgHeartbeatPayload('not-json', expected(), NOW)).toThrow()
    expect(() =>
      validateSgHeartbeatPayload(modernPayload({ injected: true }), expected(), NOW)
    ).toThrow('keys are not exact')
  })

  test('rejects a roster timestamp that predates the freshness window', () => {
    expect(() =>
      validateSgHeartbeatPayload(
        modernPayload({ ts: NOW - 120_001 }),
        expected({ notBeforeMs: NOW - 180_000 }),
        NOW
      )
    ).toThrow('freshness is not exact')
  })

  test('candidate mode never accepts a legacy payload without release identity', () => {
    expect(() => validateSgHeartbeatPayload(legacyPayload(), expected(), NOW)).toThrow()
  })

  test('candidate mode requires attempt-bound capture to be explicitly enabled', () => {
    expect(() =>
      validateSgHeartbeatPayload(modernPayload({ attempt_bound_capture: false }), expected(), NOW)
    ).toThrow('attempt-bound capture is not enabled')
  })

  test('rollback accepts legacy payloads with or without an old release stamp', () => {
    expect(
      validateSgHeartbeatPayload(
        legacyPayload(),
        expected({ mode: 'rollback', releaseId: 'unknown' }),
        NOW
      )
    ).toBe(300)
    expect(
      validateSgHeartbeatPayload(
        legacyPayload(),
        expected({ mode: 'rollback', releaseId: RELEASE }),
        NOW
      )
    ).toBe(300)
  })

  test('rollback accepts the historical capture-flag legacy schema but validates its type', () => {
    expect(
      validateSgHeartbeatPayload(
        legacyPayload({ attempt_bound_capture: true }),
        expected({ mode: 'rollback', releaseId: RELEASE }),
        NOW
      )
    ).toBe(300)
    expect(() =>
      validateSgHeartbeatPayload(
        legacyPayload({ attempt_bound_capture: 'true' }),
        expected({ mode: 'rollback', releaseId: RELEASE }),
        NOW
      )
    ).toThrow('capture flag is malformed')
    expect(() =>
      validateSgHeartbeatPayload(
        legacyPayload({ attempt_bound_capture: false }),
        expected({ mode: 'rollback', releaseId: RELEASE }),
        NOW
      )
    ).toThrow('attempt-bound capture is not enabled')
  })

  test('rollback accepts a modern unknown-release payload from an unstamped old runtime', () => {
    expect(
      validateSgHeartbeatPayload(
        modernPayload({ release_id: 'unknown' }),
        expected({ mode: 'rollback', releaseId: 'unknown' }),
        NOW
      )
    ).toBe(300)
  })

  test('rollback rejects a modern payload with capture disabled', () => {
    expect(() =>
      validateSgHeartbeatPayload(
        modernPayload({ attempt_bound_capture: false }),
        expected({ mode: 'rollback' }),
        NOW
      )
    ).toThrow('attempt-bound capture is not enabled')
  })

  test('runs the real HGET, payload validation, and ancestry chain before returning one token', async () => {
    const hget = jest.fn().mockResolvedValue(modernPayload())
    const token = await verifySgHeartbeatRoster(
      expected(),
      { hget, on: jest.fn(), disconnect: jest.fn() },
      {
        deadlineMs: 1_000,
        hgetTimeoutMs: 100,
        now: () => NOW,
        processTreeReader: tree({ 300: 200, 200: 100 }),
      }
    )

    expect(hget).toHaveBeenCalledTimes(1)
    expect(hget).toHaveBeenCalledWith('arena:worker:roster', 'vps_sg')
    expect(token).toBe(SG_ROSTER_READY_TOKEN)
    expect(token.match(/exact fresh Redis roster identity ready/g)).toHaveLength(1)
  })

  test.each(['candidate', 'rollback'] as const)(
    'the %s orchestration returns no token for a capture-disabled modern payload',
    async (mode) => {
      const hget = jest.fn().mockResolvedValue(modernPayload({ attempt_bound_capture: false }))
      let currentTime = NOW

      await expect(
        verifySgHeartbeatRoster(
          expected({ mode }),
          { hget, on: jest.fn(), disconnect: jest.fn() },
          {
            deadlineMs: 10,
            hgetTimeoutMs: 10,
            now: () => currentTime,
            processTreeReader: tree({ 300: 200, 200: 100 }),
            sleep: async () => {
              currentTime += 1_000
            },
          }
        )
      ).rejects.toThrow('SG roster attempt-bound capture is not enabled')
      expect(hget).toHaveBeenCalledTimes(1)
    }
  )

  test('the orchestration returns no token when the heartbeat writer is outside PM2', async () => {
    const hget = jest.fn().mockResolvedValue(modernPayload())
    const reader: ProcessTreeReader = {
      isAlive: jest.fn(() => true),
      parentPid: jest.fn((pid) => (pid === 300 ? 250 : 1)),
    }
    let currentTime = NOW

    await expect(
      verifySgHeartbeatRoster(
        expected(),
        { hget, on: jest.fn(), disconnect: jest.fn() },
        {
          deadlineMs: 10,
          hgetTimeoutMs: 10,
          now: () => currentTime,
          processTreeReader: reader,
          sleep: async () => {
            currentTime += 1_000
          },
        }
      )
    ).rejects.toThrow('SG heartbeat PID is outside the PM2 process tree')
    expect(reader.isAlive).toHaveBeenCalledWith(100)
    expect(reader.isAlive).toHaveBeenCalledWith(300)
    expect(reader.parentPid).toHaveBeenCalledWith(300)
  })

  test.each([
    ['legacy payload without a release field', legacyPayload(), 'unknown'],
    ['modern payload with capture enabled', modernPayload(), RELEASE],
  ])('rollback orchestration accepts %s', async (_label, raw, releaseId) => {
    const hget = jest.fn().mockResolvedValue(raw)
    const token = await verifySgHeartbeatRoster(
      expected({ mode: 'rollback', releaseId }),
      { hget, on: jest.fn(), disconnect: jest.fn() },
      {
        deadlineMs: 1_000,
        hgetTimeoutMs: 100,
        now: () => NOW,
        processTreeReader: tree({ 300: 200, 200: 100 }),
      }
    )

    expect(token).toBe(SG_ROSTER_READY_TOKEN)
    expect(hget).toHaveBeenCalledTimes(1)
  })

  test('never trusts an SG-prefixed Redis rejection or leaks its URL', async () => {
    const secretUrl = 'rediss://user:super-secret@redis.example'
    const hget = jest.fn().mockRejectedValue(new Error(`SG ${secretUrl}`))
    let currentTime = NOW

    let failure: unknown
    try {
      await verifySgHeartbeatRoster(
        expected(),
        { hget, on: jest.fn(), disconnect: jest.fn() },
        {
          deadlineMs: 10,
          hgetTimeoutMs: 10,
          now: () => currentTime,
          processTreeReader: tree({ 300: 200, 200: 100 }),
          sleep: async () => {
            currentTime += 1_000
          },
        }
      )
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toBe('[sg-heartbeat-proof] Redis roster read did not produce exact evidence')
    expect(message).not.toContain('rediss://')
    expect(message).not.toContain('super-secret')
  })

  test('binds the heartbeat writer to the live PM2 process tree', () => {
    expect(() => proveSgHeartbeatProcessTree(100, 100, tree({}))).not.toThrow()
    expect(() => proveSgHeartbeatProcessTree(100, 300, tree({ 300: 200, 200: 100 }))).not.toThrow()
  })

  test('rejects an unrelated or replaced heartbeat process', () => {
    expect(() =>
      proveSgHeartbeatProcessTree(100, 300, tree({ 300: 250, 250: 1 }, [100, 250, 300]))
    ).toThrow('outside the PM2 process tree')
  })

  test('rejects dead PM2, dead heartbeat, and even a dead equal PID', () => {
    expect(() => proveSgHeartbeatProcessTree(100, 300, tree({ 300: 100 }, [300]))).toThrow(
      'PM2 PID is not live'
    )
    expect(() => proveSgHeartbeatProcessTree(100, 300, tree({ 300: 100 }, [100]))).toThrow(
      'heartbeat PID is not live'
    )
    expect(() => proveSgHeartbeatProcessTree(100, 100, tree({}, []))).toThrow('PM2 PID is not live')
  })
})
