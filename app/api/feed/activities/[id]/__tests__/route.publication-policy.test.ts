/** @jest-environment node */

const mockFrom = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({ from: (...args: unknown[]) => mockFrom(...args) })),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { public: {} },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

function oneActivity(data: unknown) {
  const single = jest.fn().mockResolvedValue({ data, error: null })
  const eq = jest.fn(() => ({ single }))
  const select = jest.fn(() => ({ eq }))
  mockFrom.mockReturnValue({ select })
}

describe('GET /api/feed/activities/[id] publication boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('treats an old ranking-derived share activity as not found without reading it', async () => {
    oneActivity({
      id: 'legacy-rank',
      activity_type: 'entered_top10',
      activity_text: 'Trader ranked #1 with 900% ROI',
      metric_value: 99,
      metric_label: 'Arena Score',
    })

    const response = await GET(new NextRequest('https://www.arenafi.org/api/feed/activities/x'), {
      params: Promise.resolve({ id: 'legacy-rank' }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Activity not found' })
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('also hides legacy win_streak free text because it has no event-time receipt', async () => {
    oneActivity({
      id: 'streak',
      activity_type: 'win_streak',
      activity_text: 'Trader won three trades in a row',
      metric_value: 3,
      metric_label: 'Streak',
    })

    const response = await GET(new NextRequest('https://www.arenafi.org/api/feed/activities/x'), {
      params: Promise.resolve({ id: 'streak' }),
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Activity not found' })
    expect(mockFrom).not.toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })
})
