/** @jest-environment node */

const mockFrom = jest.fn()
const mockInfo = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({ from: (...args: unknown[]) => mockFrom(...args) })),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({ info: (...args: unknown[]) => mockInfo(...args) })),
}))

jest.mock('@/lib/api/with-cron', () => ({
  withCron:
    (_name: string, handler: (request: Request) => Promise<unknown>) => (request: Request) =>
      handler(request),
}))

import { NextRequest } from 'next/server'
import { GET, RANKING_ACTIVITY_EVIDENCE_UNAVAILABLE } from '../route'

describe('generate activities cron publication boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    const cleanupChain = {
      lt: jest.fn().mockResolvedValue({ error: null }),
    }
    mockFrom.mockImplementation((relation: string) => {
      if (relation !== 'trader_activities') {
        throw new Error(`unexpected relation ${relation}`)
      }
      return { delete: jest.fn(() => cleanupChain) }
    })
  })

  it('does not read raw leaderboard ranks or write any ranking-derived event', async () => {
    const result = await GET(
      new NextRequest('https://www.arenafi.org/api/cron/generate-activities')
    )

    expect(result).toEqual({ count: 0, reason: RANKING_ACTIVITY_EVIDENCE_UNAVAILABLE })
    expect(mockFrom).toHaveBeenCalledWith('trader_activities')
    expect(mockFrom).not.toHaveBeenCalledWith('leaderboard_ranks')
    expect(mockInfo).toHaveBeenCalledWith(
      'Skipped ranking activity generation: event-time evidence unavailable'
    )
  })
})
