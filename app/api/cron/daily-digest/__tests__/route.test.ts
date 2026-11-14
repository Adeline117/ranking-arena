/** @jest-environment node */

const mockSendDailyDigest = jest.fn()
const tablesRead: string[] = []
let mockLogs: { data: unknown; error: unknown }

jest.mock('@/lib/api/with-cron', () => ({
  withCron: (_name: string, handler: Function) => async (request: unknown) => {
    const supabase = {
      from: (table: string) => {
        tablesRead.push(table)
        const chain = {
          select: () => chain,
          gte: () => chain,
          in: () => chain,
          then: (resolve: (v: unknown) => void) => resolve(mockLogs),
        }
        return chain
      },
    }
    try {
      return Response.json({ ok: true, ...(await handler(request, { supabase })) })
    } catch (err) {
      return Response.json({ ok: false, error: String(err) }, { status: 500 })
    }
  },
}))

jest.mock('@/lib/notifications/telegram', () => ({
  sendDailyDigest: (...args: unknown[]) => mockSendDailyDigest(...args),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

const run = () => GET(new NextRequest('http://localhost/api/cron/daily-digest'))

describe('web daily-digest', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    tablesRead.length = 0
    mockSendDailyDigest.mockResolvedValue(true)
  })

  it('reports web cron outcomes only and never judges freshness on leaderboard_ranks', async () => {
    mockLogs = {
      data: [
        { status: 'success', job_name: 'a' },
        { status: 'error', job_name: 'b' },
      ],
      error: null,
    }
    const body = await (await run()).json()
    expect(body.pipelineSuccessRate).toBe(50)
    expect(new Set(tablesRead)).toEqual(new Set(['pipeline_logs']))
    expect(Object.keys(mockSendDailyDigest.mock.calls[0][0]).sort()).toEqual([
      'alertCount24h',
      'pipelineSuccessRate',
      'topErrors',
    ])
  })

  it('fails the run instead of reporting 0% when pipeline_logs cannot be read', async () => {
    mockLogs = { data: null, error: { message: 'permission denied' } }
    const response = await run()
    expect(response.status).toBe(500)
    expect(mockSendDailyDigest).not.toHaveBeenCalled()
  })
})
