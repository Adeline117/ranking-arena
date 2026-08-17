/** @jest-environment node */

jest.mock('@/lib/api/with-cron', () => ({
  withCron: jest.fn(
    (
      jobName: string,
      handler: (request: unknown, context: unknown) => Promise<Record<string, unknown>>
    ) => {
      return async (request: unknown) =>
        Response.json({ ok: true, ...(await handler(request, {})) })
    }
  ),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => {
    throw new Error('A paused Arena Bot publisher must not initialize a data source')
  }),
}))

import { NextRequest } from 'next/server'
import { withCron } from '@/lib/api/with-cron'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { GET as marketSummary, POST as marketSummaryPost } from '../auto-post-market-summary/route'
import { GET as weeklyRecap } from '../auto-post-weekly-recap/route'

const mockWithCron = withCron as jest.Mock
const mockGetSupabaseAdmin = getSupabaseAdmin as jest.Mock

const expectedPause = {
  ok: true,
  count: 0,
  skipped: true,
  reason: 'arena_bot_publication_evidence_unavailable',
  ranking_visibility: 'unknown',
}

describe('Arena Bot publication cron pause', () => {
  it.each([
    ['auto-post-market-summary GET', marketSummary],
    ['auto-post-market-summary POST', marketSummaryPost],
    ['auto-post-weekly-recap', weeklyRecap],
  ])(
    '%s remains behind the standard cron wrapper and fails closed before any data access',
    async (_name, GET) => {
      const response = await GET(new NextRequest('http://localhost/api/cron/test'))

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(expectedPause)
      expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    }
  )

  it('keeps both routes behind withCron so cron authentication remains unchanged', () => {
    expect(mockWithCron).toHaveBeenCalledWith('auto-post-market-summary', expect.any(Function))
    expect(mockWithCron).toHaveBeenCalledWith('auto-post-weekly-recap', expect.any(Function))
  })
})
