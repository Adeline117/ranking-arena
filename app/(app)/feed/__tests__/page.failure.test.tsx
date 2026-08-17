const mockLimit = jest.fn()

jest.mock('next/navigation', () => ({
  redirect: jest.fn(),
}))

jest.mock('@/lib/features', () => ({
  features: { social: true },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        in: () => ({
          order: () => ({
            limit: (...args: unknown[]) => mockLimit(...args),
          }),
        }),
      }),
    }),
  }),
}))

import { fetchInitialActivities } from '../page'

describe('feed SSR seed', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns a successful empty SSR seed without querying legacy rows', async () => {
    mockLimit.mockResolvedValueOnce({
      data: null,
      error: { message: 'database unavailable' },
    })
    await expect(fetchInitialActivities()).resolves.toMatchObject({
      activities: [],
      status: 'success',
    })
    expect(mockLimit).not.toHaveBeenCalled()
  })

  it('does not seed win_streak, large_trade, ranking, or unknown legacy rows', async () => {
    mockLimit.mockResolvedValueOnce({
      data: [
        {
          id: 'raw-rank',
          activity_type: 'entered_top10',
          activity_text: 'Trader ranked #1 with 900% ROI',
          occurred_at: '2026-08-17T02:00:00.000Z',
        },
        {
          id: 'safe-streak',
          activity_type: 'win_streak',
          activity_text: 'Trader won three trades in a row',
          occurred_at: '2026-08-17T01:00:00.000Z',
        },
        {
          id: 'unknown',
          activity_type: 'future_metric_type',
          activity_text: 'Unknown metric activity',
          occurred_at: '2026-08-17T00:00:00.000Z',
        },
      ],
      error: null,
    })

    await expect(fetchInitialActivities()).resolves.toMatchObject({
      activities: [],
      status: 'success',
    })
    expect(mockLimit).not.toHaveBeenCalled()
  })
})
