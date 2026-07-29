import type IORedis from 'ioredis'

import { ingestClientConnect } from '@/lib/ingest/db'

import {
  BITGET_BOT_ATTEMPT_HEALTH_STARTUP_GRACE_MS,
  loadBitgetBotAttemptHealth,
  startBitgetBotAttemptHealthWatchdog,
  validateBitgetBotAttemptHealth,
} from '../attempt-health-watchdog'

jest.mock('@/lib/ingest/db', () => ({ ingestClientConnect: jest.fn() }))

const redis = {} as IORedis
const startedAt = new Date('2026-07-29T00:00:00.000Z')
const completedAt = new Date('2026-07-29T00:10:00.000Z')
const publishedAt = new Date('2026-07-29T00:11:00.000Z')

type RowOverrides = Record<string, unknown>

function row(sourceSlug: 'bitget_bots_futures' | 'bitget_bots_spot', overrides: RowOverrides = {}) {
  return {
    source_id: sourceSlug === 'bitget_bots_futures' ? 31 : 32,
    source_slug: sourceSlug,
    timeframe: 30,
    attempt_seq: 101,
    attempt_id:
      sourceSlug === 'bitget_bots_futures'
        ? '10000000-0000-8000-8000-000000000001'
        : '10000000-0000-4000-8000-000000000002',
    health_state: 'published',
    terminal_state: 'complete',
    recorded_started_at: startedAt,
    recorded_completed_at: completedAt,
    source_run_id: '1'.repeat(64),
    acquisition_contract: 'arena.ingest.leaderboard-acquisition-manifest@4',
    source_payload_raw_object_id: 501,
    manifest_raw_object_id: 502,
    publication_snapshot_id: 601,
    publication_scraped_at: publishedAt,
    publication_count_check_passed: true,
    ...overrides,
  }
}

function notStarted(sourceSlug: 'bitget_bots_futures' | 'bitget_bots_spot') {
  return row(sourceSlug, {
    attempt_seq: null,
    attempt_id: null,
    health_state: 'not_started',
    terminal_state: null,
    recorded_started_at: null,
    recorded_completed_at: null,
    source_run_id: null,
    acquisition_contract: null,
    source_payload_raw_object_id: null,
    manifest_raw_object_id: null,
    publication_snapshot_id: null,
    publication_scraped_at: null,
    publication_count_check_passed: null,
  })
}

function rows(first: RowOverrides = {}, second: RowOverrides = {}) {
  return [row('bitget_bots_futures', first), row('bitget_bots_spot', second)]
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('Bitget bot attempt-health watchdog', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.mocked(ingestClientConnect).mockReset()
    jest.useRealTimers()
  })

  it('accepts only the exact two ordered source/window rows and cross-field state shape', () => {
    expect(validateBitgetBotAttemptHealth(rows())).toHaveLength(2)
    expect(
      validateBitgetBotAttemptHealth([
        notStarted('bitget_bots_futures'),
        notStarted('bitget_bots_spot'),
      ])
    ).toHaveLength(2)

    expect(() => validateBitgetBotAttemptHealth([row('bitget_bots_futures')])).toThrow(
      'health contract is malformed'
    )
    expect(() => validateBitgetBotAttemptHealth(rows().reverse())).toThrow(
      'health contract is malformed'
    )
    expect(() =>
      validateBitgetBotAttemptHealth(rows({ secret_unexpected_column: 'must-not-pass' }))
    ).toThrow('health contract is malformed')
    expect(() =>
      validateBitgetBotAttemptHealth(
        rows({ health_state: 'published', publication_count_check_passed: false })
      )
    ).toThrow('health contract is malformed')
    expect(() =>
      validateBitgetBotAttemptHealth(rows({ health_state: 'complete_unpublished' }))
    ).toThrow('health contract is malformed')
    expect(() => validateBitgetBotAttemptHealth(rows({}, { source_id: 31 }))).toThrow(
      'health contract is malformed'
    )
    expect(() =>
      validateBitgetBotAttemptHealth(
        rows({ acquisition_contract: 'arena.ingest.leaderboard-acquisition-manifest@3' })
      )
    ).toThrow('health contract is malformed')
    expect(() => validateBitgetBotAttemptHealth(rows({ source_run_id: '0'.repeat(64) }))).toThrow(
      'health contract is malformed'
    )
    expect(() => validateBitgetBotAttemptHealth(rows({ source_run_id: 'A'.repeat(64) }))).toThrow(
      'health contract is malformed'
    )
    expect(() => validateBitgetBotAttemptHealth(rows({ manifest_raw_object_id: 501 }))).toThrow(
      'health contract is malformed'
    )
  })

  it('accepts fail-closed unknown for in-progress and complete contract drift only without publication', () => {
    const inProgressMismatch = {
      health_state: 'unknown',
      terminal_state: 'in_progress',
      recorded_completed_at: null,
      source_run_id: null,
      acquisition_contract: 'arena.ingest.leaderboard-acquisition-manifest@3',
      source_payload_raw_object_id: null,
      manifest_raw_object_id: null,
      publication_snapshot_id: null,
      publication_scraped_at: null,
      publication_count_check_passed: null,
    }
    const completeMismatch = {
      health_state: 'unknown',
      acquisition_contract: 'arena.ingest.leaderboard-acquisition-manifest@3',
      publication_snapshot_id: null,
      publication_scraped_at: null,
      publication_count_check_passed: null,
    }

    expect(validateBitgetBotAttemptHealth(rows(inProgressMismatch, completeMismatch))).toHaveLength(
      2
    )
    expect(() =>
      validateBitgetBotAttemptHealth(
        rows(inProgressMismatch, {
          ...completeMismatch,
          publication_snapshot_id: 999,
          publication_scraped_at: publishedAt,
          publication_count_check_passed: true,
        })
      )
    ).toThrow('health contract is malformed')
  })

  it('enforces ledger evidence shape for every visible terminal class', () => {
    const noEvidence = {
      source_run_id: null,
      source_payload_raw_object_id: null,
      manifest_raw_object_id: null,
    }
    const noPublication = {
      publication_snapshot_id: null,
      publication_scraped_at: null,
      publication_count_check_passed: null,
    }
    const valid = [
      { health_state: 'partial', terminal_state: 'partial', ...noPublication },
      {
        health_state: 'processing_failed',
        terminal_state: 'processing_failed',
        ...noEvidence,
        ...noPublication,
      },
      {
        health_state: 'abandoned',
        terminal_state: 'abandoned',
        ...noEvidence,
        ...noPublication,
      },
      { health_state: 'unknown', terminal_state: 'unknown', ...noPublication },
      {
        health_state: 'unknown',
        terminal_state: 'unknown',
        ...noEvidence,
        ...noPublication,
      },
    ]
    for (const shape of valid) {
      expect(validateBitgetBotAttemptHealth(rows(shape))).toHaveLength(2)
    }

    const invalid = [
      { health_state: 'partial', terminal_state: 'partial', ...noEvidence, ...noPublication },
      { health_state: 'processing_failed', terminal_state: 'processing_failed', ...noPublication },
      { health_state: 'abandoned', terminal_state: 'abandoned', ...noPublication },
      {
        health_state: 'unknown',
        terminal_state: 'partial',
        ...noEvidence,
        ...noPublication,
      },
      { health_state: 'unknown', terminal_state: 'processing_failed', ...noPublication },
      { health_state: 'unknown', terminal_state: 'abandoned', ...noPublication },
      {
        health_state: 'unknown',
        terminal_state: 'unknown',
        source_run_id: '1'.repeat(64),
        source_payload_raw_object_id: null,
        manifest_raw_object_id: null,
        ...noPublication,
      },
      {
        health_state: 'open_fresh',
        terminal_state: 'in_progress',
        recorded_completed_at: null,
        ...noPublication,
      },
    ]
    for (const shape of invalid) {
      expect(() => validateBitgetBotAttemptHealth(rows(shape))).toThrow(
        'health contract is malformed'
      )
    }
  })

  it('loads the RPC in one read-only transaction and commits before release', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: null, rows: [] })
      .mockResolvedValueOnce({ rowCount: null, rows: [] })
      .mockResolvedValueOnce({ rowCount: 2, rows: rows() })
      .mockResolvedValueOnce({ rowCount: null, rows: [] })
    const release = jest.fn()
    jest.mocked(ingestClientConnect).mockResolvedValue({ query, release } as never)

    await expect(loadBitgetBotAttemptHealth()).resolves.toHaveLength(2)

    expect(query).toHaveBeenCalledTimes(4)
    expect(query.mock.calls[0]?.[0]).toBe('BEGIN TRANSACTION READ ONLY')
    expect(query.mock.calls[1]?.[0]).toBe("SET LOCAL statement_timeout = '10s'")
    expect(query.mock.calls[2]?.[0]).toMatch(
      /FROM public\.arena_bitget_bot_acquisition_attempt_health\(\)$/
    )
    expect(query.mock.calls[3]?.[0]).toBe('COMMIT')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it.each(['malformed row count', 'malformed row shape', 'query failure'])(
    'rolls back and releases on %s without logging database detail',
    async (failure) => {
      const query = jest
        .fn()
        .mockResolvedValueOnce({ rowCount: null, rows: [] })
        .mockResolvedValueOnce({ rowCount: null, rows: [] })
      if (failure === 'malformed row count') {
        query.mockResolvedValueOnce({ rowCount: 1, rows: [row('bitget_bots_futures')] })
      } else if (failure === 'malformed row shape') {
        query.mockResolvedValueOnce({
          rowCount: 2,
          rows: rows({ publication_count_check_passed: false }),
        })
      } else {
        query.mockRejectedValueOnce(new Error('secret database host and SQL detail'))
      }
      query.mockResolvedValueOnce({ rowCount: null, rows: [] })
      const release = jest.fn()
      const log = jest.spyOn(console, 'error').mockImplementation(() => undefined)
      jest.mocked(ingestClientConnect).mockResolvedValue({ query, release } as never)

      await expect(loadBitgetBotAttemptHealth()).rejects.toThrow()

      expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK')
      expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false)
      expect(release).toHaveBeenCalledTimes(1)
      expect(log.mock.calls.flat().join(' ')).not.toContain('secret database host')
    }
  )

  it('routes a failed RPC read through a sanitized alert after rollback and release', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: null, rows: [] })
      .mockResolvedValueOnce({ rowCount: null, rows: [] })
      .mockRejectedValueOnce(new Error('secret database host and SQL detail'))
      .mockResolvedValueOnce({ rowCount: null, rows: [] })
    const release = jest.fn()
    const sendAlert = jest.fn(async () => undefined)
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    jest.mocked(ingestClientConnect).mockResolvedValue({ query, release } as never)

    const watchdog = startBitgetBotAttemptHealthWatchdog({ redis, sendAlert })
    await watchdog.poll()

    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK')
    expect(release).toHaveBeenCalledTimes(1)
    expect(sendAlert).toHaveBeenCalledWith(redis, {
      sourceSlug: 'bitget_bots_attempt_health',
      phase: 0,
      tier: 'A',
      message: 'health contract unavailable',
    })
    expect(JSON.stringify(sendAlert.mock.calls)).not.toContain('secret database host')
    expect(error.mock.calls.flat().join(' ')).not.toContain('secret database host')
    watchdog.stop()
  })

  it('suppresses not_started during startup grace, then alerts once through Tier-A routing', async () => {
    let time = 1_800_000_000_000
    const sendAlert = jest.fn(async () => undefined)
    const payload = [notStarted('bitget_bots_futures'), row('bitget_bots_spot')]
    const watchdog = startBitgetBotAttemptHealthWatchdog({
      redis,
      load: async () => payload,
      now: () => time,
      sendAlert,
    })

    await watchdog.poll()
    expect(sendAlert).not.toHaveBeenCalled()

    time += BITGET_BOT_ATTEMPT_HEALTH_STARTUP_GRACE_MS
    await watchdog.poll()
    expect(sendAlert).toHaveBeenCalledTimes(1)
    expect(sendAlert).toHaveBeenCalledWith(redis, {
      sourceSlug: 'bitget_bots_futures',
      phase: 0,
      tier: 'A',
      message: 'acquisition attempt health degraded: state=not_started timeframe=30',
    })

    await watchdog.poll()
    expect(sendAlert).toHaveBeenCalledTimes(1)
    watchdog.stop()
  })

  it('alerts degraded transitions, deduplicates stable state, and records recovery without IDs', async () => {
    const sendAlert = jest.fn(async () => undefined)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    let payload = rows(
      {
        health_state: 'open_stale_suspect',
        terminal_state: 'in_progress',
        recorded_completed_at: null,
        source_run_id: null,
        source_payload_raw_object_id: null,
        manifest_raw_object_id: null,
        publication_snapshot_id: null,
        publication_scraped_at: null,
        publication_count_check_passed: null,
      },
      {
        health_state: 'complete_unpublished',
        publication_snapshot_id: null,
        publication_scraped_at: null,
        publication_count_check_passed: null,
      }
    )
    const watchdog = startBitgetBotAttemptHealthWatchdog({
      redis,
      load: async () => payload,
      sendAlert,
    })

    await watchdog.poll()
    expect(sendAlert).toHaveBeenCalledTimes(2)
    await watchdog.poll()
    expect(sendAlert).toHaveBeenCalledTimes(2)

    payload = rows(
      {},
      {
        health_state: 'published_gated',
        publication_count_check_passed: false,
      }
    )
    await watchdog.poll()

    expect(sendAlert).toHaveBeenCalledTimes(3)
    expect(log.mock.calls.flat().join(' ')).toContain('recovered source=bitget_bots_futures')
    const emittedLogs = [...warn.mock.calls, ...log.mock.calls].flat().join(' ')
    expect(emittedLogs).not.toContain('10000000-0000-4000-8000')
    expect(emittedLogs).not.toContain('1'.repeat(64))
    watchdog.stop()
  })

  it('logs sanitized degraded identity and retries when alert delivery fails', async () => {
    const sendAlert = jest
      .fn()
      .mockRejectedValueOnce(new Error('secret Redis failure'))
      .mockResolvedValue(undefined)
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const payload = rows(
      {
        health_state: 'published_gated',
        publication_count_check_passed: false,
      },
      {}
    )
    const watchdog = startBitgetBotAttemptHealthWatchdog({
      redis,
      load: async () => payload,
      sendAlert,
    })

    await watchdog.poll()
    await watchdog.poll()

    expect(sendAlert).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.flat().join(' ')).toContain(
      'degraded source=bitget_bots_futures timeframe=30 state=published_gated'
    )
    expect(error.mock.calls.flat().join(' ')).not.toContain('secret Redis failure')
    watchdog.stop()
  })

  it('sanitizes query failures, transition-deduplicates them, and tracks each in-flight poll', async () => {
    const sendAlert = jest.fn(async () => undefined)
    const track = jest.fn()
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const watchdog = startBitgetBotAttemptHealthWatchdog({
      redis,
      load: async () => {
        throw new Error('postgres secret DSN and SQL detail')
      },
      sendAlert,
      track,
    })

    await watchdog.poll()
    await watchdog.poll()

    expect(sendAlert).toHaveBeenCalledTimes(1)
    expect(sendAlert.mock.calls[0]?.[1]).toMatchObject({
      sourceSlug: 'bitget_bots_attempt_health',
      message: 'health contract unavailable',
    })
    expect(track).toHaveBeenCalledTimes(2)
    expect(error.mock.calls.flat().join(' ')).not.toContain('secret DSN')
    watchdog.stop()
  })

  it('clears its unrefed interval and starts no more polls after stop', async () => {
    jest.useFakeTimers()
    const load = jest.fn(async () => rows())
    const watchdog = startBitgetBotAttemptHealthWatchdog({
      redis,
      load,
      pollIntervalMs: 1_000,
    })
    await watchdog.poll()
    expect(load).toHaveBeenCalledTimes(1)

    watchdog.stop()
    await jest.advanceTimersByTimeAsync(5_000)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('does not reenter while a slow alert remains in flight', async () => {
    const delivery = deferred()
    const sendAlert = jest.fn(() => delivery.promise)
    const track = jest.fn()
    const watchdog = startBitgetBotAttemptHealthWatchdog({
      redis,
      load: async () =>
        rows({
          health_state: 'published_gated',
          publication_count_check_passed: false,
        }),
      sendAlert,
      track,
    })

    const first = watchdog.poll()
    const second = watchdog.poll()
    expect(second).toBe(first)
    await Promise.resolve()
    await Promise.resolve()
    expect(sendAlert).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledTimes(1)

    delivery.resolve()
    await first
    watchdog.stop()
  })
})
