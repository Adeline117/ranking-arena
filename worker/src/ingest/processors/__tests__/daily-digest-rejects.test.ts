/**
 * Daily digest reject summary: whole-row rejects raise the quality-drift line
 * at the threshold; out-of-range metric records (rows kept, metric stored
 * empty) get their own count line and never count toward that threshold.
 */
import type { Job } from 'bullmq'

const mockQuery = jest.fn()
const mockAlert = jest.fn()
const mockFlushDigest = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: (...args: unknown[]) => mockQuery(...args) })),
}))
jest.mock('@/lib/ingest/alerting', () => ({
  alert: (...args: unknown[]) => mockAlert(...args),
  flushDigest: (...args: unknown[]) => mockFlushDigest(...args),
}))
jest.mock('../../../connection', () => ({ getConnection: jest.fn(() => ({})) }))

import {
  processDailyDigest,
  rejectDigestLines,
  REJECT_DRIFT_THRESHOLD,
  type RejectReasonCount,
} from '../daily-digest'

const row = (slug: string, reason: string, count: number, phase = 2): RejectReasonCount => ({
  slug,
  phase,
  reason,
  count,
})

describe('rejectDigestLines', () => {
  it('only out-of-range metric records: no quality-drift line, one count line', () => {
    // e.g. an exchange whose own drawdown definition exceeds 100 %.
    const lines = rejectDigestLines([
      row('binance_futures', 'metric_out_of_range:mdd', 180),
      row('binance_futures', 'metric_out_of_range:win_rate', 3),
    ])
    expect(lines).toEqual([
      {
        sourceSlug: 'binance_futures',
        phase: 2,
        message:
          '183 metric value(s) out of range in 24h, stored empty ' +
          '(top: metric_out_of_range:mdd); rows kept, not counted as rejects',
      },
    ])
    expect(lines.some((line) => line.message.includes('staging rejects'))).toBe(false)
  })

  it('whole-row rejects at the threshold raise the quality-drift line as before', () => {
    expect(
      rejectDigestLines([
        row('xt_futures', 'missing_required_field:pnl', REJECT_DRIFT_THRESHOLD - 5),
        row('xt_futures', 'zod:Invalid input', 5),
      ])
    ).toEqual([
      {
        sourceSlug: 'xt_futures',
        phase: 2,
        message: `${REJECT_DRIFT_THRESHOLD} staging rejects in 24h (top: missing_required_field:pnl)`,
      },
    ])
    expect(
      rejectDigestLines([row('xt_futures', 'zod:Invalid input', REJECT_DRIFT_THRESHOLD - 1)])
    ).toEqual([])
  })

  it('out-of-range records never push whole-row rejects over the threshold', () => {
    const lines = rejectDigestLines([
      row('bitget_cfd', 'zod:Invalid input', REJECT_DRIFT_THRESHOLD - 1),
      row('bitget_cfd', 'metric_out_of_range:mdd', 500),
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0].message).toMatch(/^500 metric value\(s\) out of range/)
  })

  it('reports both lines for a source that has both, with separate counts and top reasons', () => {
    const lines = rejectDigestLines([
      row('bitget_cfd', 'profile_payload_missing', 25, 3),
      row('bitget_cfd', 'metric_out_of_range:mdd', 7, 3),
      row('toobit_futures', 'metric_out_of_range:mdd', 1, 3),
    ])
    expect(lines.map((line) => [line.sourceSlug, line.message])).toEqual([
      ['bitget_cfd', '25 staging rejects in 24h (top: profile_payload_missing)'],
      [
        'bitget_cfd',
        '7 metric value(s) out of range in 24h, stored empty ' +
          '(top: metric_out_of_range:mdd); rows kept, not counted as rejects',
      ],
      [
        'toobit_futures',
        '1 metric value(s) out of range in 24h, stored empty ' +
          '(top: metric_out_of_range:mdd); rows kept, not counted as rejects',
      ],
    ])
  })
})

describe('processDailyDigest reject summary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFlushDigest.mockResolvedValue(0)
    mockAlert.mockResolvedValue(undefined)
  })

  const rejectAlerts = () =>
    mockAlert.mock.calls
      .map((call) => call[1] as { sourceSlug: string; tier: string; message: string })
      .filter((event) => /staging rejects|out of range/.test(event.message))

  function serveRejects(rows: RejectReasonCount[]) {
    mockQuery.mockImplementation(async (text: string) =>
      text.includes('arena.staging_rejects') ? { rows } : { rows: [] }
    )
  }

  it('queues only the count line when a source has only out-of-range records', async () => {
    serveRejects([row('binance_futures', 'metric_out_of_range:mdd', 321)])
    await processDailyDigest({} as Job)
    expect(rejectAlerts()).toEqual([
      {
        sourceSlug: 'binance_futures',
        phase: 2,
        tier: 'maint',
        message:
          '321 metric value(s) out of range in 24h, stored empty ' +
          '(top: metric_out_of_range:mdd); rows kept, not counted as rejects',
      },
    ])
  })

  it('queues the quality-drift line when whole-row rejects reach the threshold', async () => {
    serveRejects([row('xt_futures', 'zod:Invalid input', REJECT_DRIFT_THRESHOLD)])
    await processDailyDigest({} as Job)
    expect(rejectAlerts()).toEqual([
      {
        sourceSlug: 'xt_futures',
        phase: 2,
        tier: 'maint',
        message: `${REJECT_DRIFT_THRESHOLD} staging rejects in 24h (top: zod:Invalid input)`,
      },
    ])
  })
})
