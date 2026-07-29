import {
  buildStaleAttemptDatabaseClientConfig,
  buildStaleAttemptReportRequest,
  collectStaleAttemptAdvisory,
  MAX_STALE_ATTEMPT_REPORT_PAGES,
  MAX_STALE_ATTEMPT_REPORT_ROWS,
  parseStaleAttemptReportArgs,
  STALE_ATTEMPT_REQUEST_CONTRACT,
  STALE_ATTEMPT_RESPONSE_CONTRACT,
  validateStaleAttemptReportResponse,
  type StaleAttemptQueryClient,
  type StaleAttemptReportRequest,
  type StaleAttemptReportRow,
} from '../lib/stale-leaderboard-attempt-report'

const OBSERVED_AT = '2026-07-29T12:00:00.000Z'
const OPTIONS = {
  observedAt: OBSERVED_AT,
  pageSize: 1,
  staleAfterSeconds: 7200,
}

function reportRow(overrides: Partial<StaleAttemptReportRow> = {}): StaleAttemptReportRow {
  return {
    attempt_seq: '1',
    attempt_id: '11111111-1111-4111-8111-111111111111',
    source_id: 1,
    source_slug: 'binance_futures',
    timeframe: 30,
    observation_cycle_id: 'cycle-1',
    queue_job_id: 'job-1',
    queue_attempt: 0,
    capture_contract: 'arena.ingest.leaderboard-acquisition-manifest@4',
    recorded_started_at: '2026-07-29T09:00:00.000Z',
    ownership: 'legacy',
    attempt_position: 'superseded',
    age_state: 'expired',
    attempt_phase: 'open',
    authority_state: 'legacy_unfenced',
    execution_phase: 'legacy',
    ...overrides,
  }
}

function responseFor({
  request,
  rows,
  highWater = '3',
  hasMore = false,
}: {
  request: StaleAttemptReportRequest
  rows: StaleAttemptReportRow[]
  highWater?: string
  hasMore?: boolean
}): unknown {
  return {
    contract: STALE_ATTEMPT_RESPONSE_CONTRACT,
    observed_at: request.observed_at,
    high_water_attempt_seq: highWater,
    after_attempt_seq: request.after_attempt_seq,
    stale_after_seconds: request.stale_after_seconds,
    page_size: request.page_size,
    rows,
    page: {
      returned_count: rows.length,
      has_more: hasMore,
      next_after_attempt_seq: hasMore ? rows.at(-1)?.attempt_seq : null,
    },
  }
}

describe('stale leaderboard attempt advisory', () => {
  it('derives locality from the exact URL hostname and pins secure connection deadlines', () => {
    for (const connectionString of [
      'postgres://user:localhost-in-password@localhost/database',
      'postgresql://user:password@127.0.0.1:5432/database',
      'postgres://user:password@[::1]/database',
    ]) {
      expect(buildStaleAttemptDatabaseClientConfig(connectionString)).toMatchObject({
        ssl: false,
        connectionTimeoutMillis: 10_000,
        query_timeout: 20_000,
        statement_timeout: 15_000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10_000,
      })
    }

    const remote = buildStaleAttemptDatabaseClientConfig(
      'postgres://localhost-user:password@localhost.evil.example/database' +
        '?host=localhost&sslmode=no-verify&query_timeout=0&options=-c%20statement_timeout%3D0'
    )
    expect(remote.ssl).toEqual({ rejectUnauthorized: true })
    expect(new URL(remote.connectionString).hostname).toBe('localhost.evil.example')
    expect([...new URL(remote.connectionString).searchParams.keys()]).toEqual([])

    for (const malformed of [
      'not-a-database-url',
      'https://database.example/database',
      'postgres:///database',
    ]) {
      expect(() => buildStaleAttemptDatabaseClientConfig(malformed)).toThrow(
        '[stale-attempt-report]'
      )
    }
  })

  it('parses only bounded explicit advisory options and freezes one observed timestamp', () => {
    expect(parseStaleAttemptReportArgs([], () => new Date(OBSERVED_AT))).toEqual({
      observedAt: OBSERVED_AT,
      pageSize: 250,
      staleAfterSeconds: 7200,
    })
    expect(
      parseStaleAttemptReportArgs([
        '--observed-at',
        OBSERVED_AT,
        '--page-size',
        '1000',
        '--stale-after-seconds',
        '300',
      ])
    ).toEqual({ observedAt: OBSERVED_AT, pageSize: 1000, staleAfterSeconds: 300 })

    for (const args of [
      ['--page-size', '1001'],
      ['--page-size', '1', '--page-size', '2'],
      ['--stale-after-seconds', '299'],
      ['--observed-at', '2026-07-29T12:00:00Z'],
      ['--write', 'true'],
      ['--page-size'],
    ]) {
      expect(() => parseStaleAttemptReportArgs(args)).toThrow('[stale-attempt-report]')
    }
  })

  it('builds the exact request envelope with decimal-string cursors', () => {
    expect(
      buildStaleAttemptReportRequest({
        options: OPTIONS,
        highWaterAttemptSeq: '9007199254740993',
        afterAttemptSeq: '9007199254740992',
      })
    ).toEqual({
      contract: STALE_ATTEMPT_REQUEST_CONTRACT,
      observed_at: OBSERVED_AT,
      high_water_attempt_seq: '9007199254740993',
      after_attempt_seq: '9007199254740992',
      page_size: 1,
      stale_after_seconds: 7200,
    })
    expect(() =>
      buildStaleAttemptReportRequest({
        options: OPTIONS,
        highWaterAttemptSeq: '1',
        afterAttemptSeq: '2',
      })
    ).toThrow('exceeds the fixed high-water')
    expect(() =>
      buildStaleAttemptReportRequest({
        options: OPTIONS,
        highWaterAttemptSeq: '01',
        afterAttemptSeq: null,
      })
    ).toThrow('high-water attempt sequence is malformed')
    expect(() =>
      buildStaleAttemptReportRequest({
        options: OPTIONS,
        highWaterAttemptSeq: '1',
        afterAttemptSeq: '0',
      })
    ).toThrow('after attempt sequence is malformed')
  })

  it('rejects output drift, cursor drift, future rows, and authority contradictions', () => {
    const request = buildStaleAttemptReportRequest({
      options: OPTIONS,
      highWaterAttemptSeq: '3',
      afterAttemptSeq: null,
    })
    const valid = responseFor({ request, rows: [reportRow()] })
    expect(validateStaleAttemptReportResponse(valid, request).rows).toHaveLength(1)

    const withSecret = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>
    ;(withSecret.rows as Array<Record<string, unknown>>)[0].bull_lock_token_sha256 = 'a'.repeat(64)
    expect(() => validateStaleAttemptReportResponse(withSecret, request)).toThrow(
      'response row envelope is malformed'
    )

    const changedHighWater = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>
    changedHighWater.high_water_attempt_seq = '4'
    expect(() => validateStaleAttemptReportResponse(changedHighWater, request)).toThrow(
      'changed the fixed high-water'
    )

    const futureRow = responseFor({
      request,
      rows: [reportRow({ recorded_started_at: '2026-07-29T11:00:00.001Z' })],
    })
    expect(() => validateStaleAttemptReportResponse(futureRow, request)).toThrow(
      'outside the frozen report window'
    )

    const contradictory = responseFor({
      request,
      rows: [reportRow({ authority_state: 'current', execution_phase: 'legacy' })],
    })
    expect(() => validateStaleAttemptReportResponse(contradictory, request)).toThrow(
      'legacy row authority classification is malformed'
    )
  })

  it('paginates inside one repeatable-read read-only transaction and always rolls back', async () => {
    const queries: Array<{ text: string; values?: readonly unknown[] }> = []
    const client: StaleAttemptQueryClient = {
      query: jest.fn(async (text: string, values?: readonly unknown[]) => {
        queries.push({ text, values })
        if (!text.startsWith('SELECT arena.report_')) return { rowCount: null, rows: [] }
        const request = JSON.parse(values?.[0] as string) as StaleAttemptReportRequest
        const firstPage = request.after_attempt_seq === null
        const rows = firstPage
          ? [reportRow()]
          : [
              reportRow({
                attempt_seq: '3',
                attempt_id: '33333333-3333-4333-8333-333333333333',
                source_id: 2,
                source_slug: 'bitget_bots_futures',
                observation_cycle_id: 'cycle-3',
                queue_job_id: 'job-3',
                ownership: 'claimed',
                attempt_position: 'current',
                authority_state: 'closed',
                execution_phase: 'failed',
              }),
            ]
        return {
          rowCount: 1,
          rows: [
            {
              report: responseFor({
                request,
                rows,
                highWater: '3',
                hasMore: firstPage,
              }),
            },
          ],
        }
      }),
    }

    await expect(collectStaleAttemptAdvisory(client, OPTIONS)).resolves.toMatchObject({
      advisory_only: true,
      mutation_authorized: false,
      observed_at: OBSERVED_AT,
      high_water_attempt_seq: '3',
      page_count: 2,
      row_count: 2,
    })

    expect(queries.map(({ text }) => text)).toEqual([
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'SET LOCAL ROLE service_role',
      "SET LOCAL statement_timeout = '15s'",
      "SET LOCAL lock_timeout = '3s'",
      "SET LOCAL idle_in_transaction_session_timeout = '30s'",
      'SELECT arena.report_stale_leaderboard_acquisition_attempts($1::jsonb) AS report',
      'SELECT arena.report_stale_leaderboard_acquisition_attempts($1::jsonb) AS report',
      'ROLLBACK',
    ])
    expect(
      queries.some(({ text }) => /\bCOMMIT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i.test(text))
    ).toBe(false)
    const requests = queries
      .filter(({ text }) => text.startsWith('SELECT arena.report_'))
      .map(({ values }) => JSON.parse(values?.[0] as string) as StaleAttemptReportRequest)
    expect(requests).toEqual([
      expect.objectContaining({ high_water_attempt_seq: null, after_attempt_seq: null }),
      expect.objectContaining({ high_water_attempt_seq: '3', after_attempt_seq: '1' }),
    ])
    expect(new Set(requests.map((request) => request.observed_at))).toEqual(new Set([OBSERVED_AT]))
  })

  it('preserves a report failure while rolling the read-only transaction back', async () => {
    const queries: string[] = []
    const unavailable = new Error('report unavailable')
    const client: StaleAttemptQueryClient = {
      query: jest.fn(async (text: string) => {
        queries.push(text)
        if (text.startsWith('SELECT arena.report_')) throw unavailable
        return { rowCount: null, rows: [] }
      }),
    }

    await expect(collectStaleAttemptAdvisory(client, OPTIONS)).rejects.toBe(unavailable)
    expect(queries.at(-1)).toBe('ROLLBACK')
    expect(queries).not.toContain('COMMIT')
  })

  it('fails closed at the aggregate row bound instead of buffering an unbounded report', async () => {
    expect(MAX_STALE_ATTEMPT_REPORT_ROWS).toBe(10_000)
    expect(MAX_STALE_ATTEMPT_REPORT_PAGES).toBe(1_000)

    let reportQueryCount = 0
    const client: StaleAttemptQueryClient = {
      query: jest.fn(async (text: string, values?: readonly unknown[]) => {
        if (!text.startsWith('SELECT arena.report_')) return { rowCount: null, rows: [] }
        reportQueryCount += 1
        const request = JSON.parse(values?.[0] as string) as StaleAttemptReportRequest
        const firstAttemptSeq = (reportQueryCount - 1) * 1_000 + 1
        const rows = Array.from({ length: 1_000 }, (_, offset) => {
          const attemptSeq = String(firstAttemptSeq + offset)
          return reportRow({
            attempt_seq: attemptSeq,
            attempt_id: `00000000-0000-4000-8000-${attemptSeq.padStart(12, '0')}`,
          })
        })
        return {
          rowCount: 1,
          rows: [
            {
              report: responseFor({
                request,
                rows,
                highWater: '10001',
                hasMore: true,
              }),
            },
          ],
        }
      }),
    }

    await expect(
      collectStaleAttemptAdvisory(client, { ...OPTIONS, pageSize: 1_000 })
    ).rejects.toThrow('row safety bound exceeded')
    expect(reportQueryCount).toBe(10)
    expect((client.query as jest.Mock).mock.calls.at(-1)?.[0]).toBe('ROLLBACK')
  })
})
