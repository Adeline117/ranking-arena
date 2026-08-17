/** @jest-environment node */

const mockFrom = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({ from: (...args: unknown[]) => mockFrom(...args) })),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { public: {} },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({ error: jest.fn() })),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

function queryFor(result: { data: unknown[] | null; error: unknown }) {
  const query = {} as Record<string, jest.Mock>
  for (const method of ['select', 'in', 'order', 'limit', 'eq', 'lt']) {
    query[method] = jest.fn(() => query)
  }
  query.then = jest.fn((resolve: (value: unknown) => void) => resolve(result))
  return query
}

describe('GET /api/feed public activity publication boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns explicit unavailable/empty without touching legacy activity rows', async () => {
    const query = queryFor({
      data: [
        {
          id: 'raw-score',
          activity_type: 'score_high',
          activity_text: 'Trader score is 99',
          metric_value: 99,
          metric_label: 'Arena Score',
          occurred_at: '2026-08-17T02:00:00.000Z',
        },
        { id: 'legacy-streak', activity_type: 'win_streak' },
        {
          id: 'future',
          activity_type: 'future_metric_type',
          activity_text: 'Unreviewed metric',
          occurred_at: '2026-08-17T00:00:00.000Z',
        },
      ],
      error: null,
    })
    mockFrom.mockReturnValue(query)

    const response = await GET(new NextRequest('https://www.arenafi.org/api/feed?limit=5'))
    const body = await response.json()

    expect(mockFrom).not.toHaveBeenCalled()
    expect(query.in).not.toHaveBeenCalled()
    expect(body.data.activities).toEqual([])
    expect(body.data.activity_visibility).toBe('unavailable')
    expect(body.data.activity_visibility_reason).toBe('event_time_publication_evidence_unavailable')
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })
})
