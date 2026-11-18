const mockQuery = jest.fn()
const mockAlert = jest.fn()

jest.mock('../../../connection', () => ({ getConnection: jest.fn(() => ({})) }))
jest.mock('@/lib/ingest/db', () => ({ getIngestPool: () => ({ query: mockQuery }) }))
jest.mock('@/lib/ingest/alerting', () => ({ alert: (...args: unknown[]) => mockAlert(...args) }))

import { alertPendingCountShifts, alertStalledDeepCrawls } from '../freshness-sentinel'

describe('alertPendingCountShifts', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockAlert.mockReset()
  })

  it('pages each held downward shift on its own source×timeframe key with the ack instruction', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          slug: 'bybit',
          phase: 0,
          timeframe: 30,
          proposed_baseline: '60',
          current_baseline: '100',
        },
        { slug: 'bybit', phase: 0, timeframe: 90, proposed_baseline: '55', current_baseline: '98' },
      ],
    })
    await expect(alertPendingCountShifts({} as never)).resolves.toBe(2)
    expect(String(mockQuery.mock.calls[0][0])).toContain("latest.meta ? 'count_shift_pending'")
    expect(mockAlert.mock.calls.map((call) => call[1].sourceSlug)).toEqual([
      'bybit:count-shift:30',
      'bybit:count-shift:90',
    ])
    expect(mockAlert.mock.calls[0][1]).toMatchObject({
      tier: 'A',
      phase: 0,
      message: expect.stringContaining('count_shift_ack.30 = 60'),
    })
  })

  it('stays quiet when nothing is pending', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] })
    await expect(alertPendingCountShifts({} as never)).resolves.toBe(0)
    expect(mockAlert).not.toHaveBeenCalled()
  })
})

describe('alertStalledDeepCrawls', () => {
  const NOW = Date.parse('2026-11-17T12:00:00Z')
  const H = 3600_000
  const sourceRows = {
    rows: [
      { slug: 'bybit', cadence_tier_b_seconds: 18 * 3600, cadence_tier_d_seconds: 2 * 3600 },
      { slug: 'okx_futures', cadence_tier_b_seconds: 18 * 3600, cadence_tier_d_seconds: 2 * 3600 },
    ],
  }
  const redisWith = (tierB: Record<string, string>, tierD: Record<string, string>) => ({
    hgetall: jest.fn(async (key: string) => (key.endsWith('tier_b') ? tierB : tierD)),
    hsetnx: jest.fn(async () => 1),
  })

  beforeEach(() => {
    mockQuery.mockReset()
    mockAlert.mockReset()
  })

  it('sends one page per tier that lists every stalled source', async () => {
    mockQuery.mockResolvedValueOnce(sourceRows)
    const fresh = String(NOW - 1 * H)
    const redis = redisWith(
      { bybit: fresh, okx_futures: fresh },
      { bybit: String(NOW - 7 * H), okx_futures: String(NOW - 9 * H) }
    )
    await expect(alertStalledDeepCrawls(redis as never, NOW)).resolves.toBe(2)
    expect(mockAlert).toHaveBeenCalledTimes(1)
    expect(mockAlert.mock.calls[0][1]).toMatchObject({
      sourceSlug: 'framework:deep-crawl-stalled',
      tier: 'D',
      page: true,
      message: expect.stringContaining('bybit 7h, okx_futures 9h'),
    })
    expect(redis.hsetnx).not.toHaveBeenCalled()
  })

  it('starts the clock for a source it has never seen, without paging', async () => {
    mockQuery.mockResolvedValueOnce(sourceRows)
    const fresh = String(NOW - 1 * H)
    const redis = redisWith({ bybit: fresh }, { bybit: fresh, okx_futures: fresh })
    await expect(alertStalledDeepCrawls(redis as never, NOW)).resolves.toBe(0)
    expect(redis.hsetnx.mock.calls).toEqual([
      ['arena:ingest:progress:tier_b', 'okx_futures', String(NOW)],
    ])
    expect(mockAlert).not.toHaveBeenCalled()
  })
})
