const mockQuery = jest.fn()
const mockAlert = jest.fn()

jest.mock('../../../connection', () => ({ getConnection: jest.fn(() => ({})) }))
jest.mock('@/lib/ingest/db', () => ({ getIngestPool: () => ({ query: mockQuery }) }))
jest.mock('@/lib/ingest/alerting', () => ({ alert: (...args: unknown[]) => mockAlert(...args) }))

import { alertPendingCountShifts } from '../freshness-sentinel'

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
