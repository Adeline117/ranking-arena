/** @jest-environment node */

const mockFrom = jest.fn()

jest.mock('@/lib/features', () => ({ features: { social: true } }))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({ from: (...args: unknown[]) => mockFrom(...args) })),
}))
jest.mock('@/lib/utils/logger', () => ({ createLogger: jest.fn(() => ({ warn: jest.fn() })) }))

import { dynamic, generateMetadata, revalidate } from '../page'

function activityQuery(data: unknown) {
  const single = jest.fn().mockResolvedValue({ data, error: null })
  const eq = jest.fn(() => ({ single }))
  const select = jest.fn(() => ({ eq }))
  mockFrom.mockReturnValue({ select })
}

describe('/feed/[id] public activity publication boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('does not generate title or OG metadata for a legacy ranking activity', async () => {
    activityQuery({
      id: 'legacy-ranking-activity',
      activity_type: 'large_profit',
      handle: 'alpha',
      source_trader_id: 'trader-1',
      activity_text: 'alpha earned $90,000 profit',
      metric_value: 90_000,
      metric_label: 'PnL USD',
    })

    await expect(
      generateMetadata({ params: Promise.resolve({ id: 'legacy-ranking-activity' }) })
    ).resolves.toEqual({
      title: 'Activity Not Found',
      robots: { index: false, follow: false },
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('does not generate share metadata for unattested win_streak free text', async () => {
    activityQuery({
      id: 'safe-streak-activity',
      activity_type: 'win_streak',
      handle: 'alpha',
      source_trader_id: 'trader-1',
      activity_text: 'alpha won three trades in a row',
      metric_value: 3,
      metric_label: 'Streak',
    })

    await expect(
      generateMetadata({ params: Promise.resolve({ id: 'safe-streak-activity' }) })
    ).resolves.toEqual({
      title: 'Activity Not Found',
      robots: { index: false, follow: false },
    })
    expect(mockFrom).not.toHaveBeenCalled()
    expect(dynamic).toBe('force-dynamic')
    expect(revalidate).toBe(0)
  })
})
