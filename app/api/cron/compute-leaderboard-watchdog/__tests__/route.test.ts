/** @jest-environment node */

const mockSendAlert = jest.fn()
let mockQueryResult: (season: string) => { data: unknown; error: unknown }

jest.mock('@/lib/api/with-cron', () => ({
  withCron: (_name: string, handler: Function) => async (request: unknown) => {
    const supabase = {
      from: () => {
        let season = ''
        const chain = {
          select: () => chain,
          eq: (_col: string, value: string) => ((season = value), chain),
          order: () => chain,
          limit: async () => mockQueryResult(season),
        }
        return chain
      },
    }
    try {
      const result = await handler(request, { supabase })
      return Response.json({ ok: true, ...result })
    } catch (err) {
      return Response.json({ ok: false, error: String(err) }, { status: 500 })
    }
  },
}))

jest.mock('@/lib/alerts/send-alert', () => ({
  sendAlert: (...args: unknown[]) => mockSendAlert(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

const ORIGINAL_ENV = process.env
const ORIGINAL_FETCH = global.fetch
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

function run() {
  return GET(new NextRequest('http://localhost/api/cron/compute-leaderboard-watchdog'))
}

describe('compute-leaderboard-watchdog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSendAlert.mockResolvedValue(undefined)
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: 'test-secret' }
  })
  afterEach(() => {
    process.env = ORIGINAL_ENV
    global.fetch = ORIGINAL_FETCH
  })

  it('fails the run and alerts when the freshness query errors', async () => {
    mockQueryResult = () => ({ data: null, error: { message: 'permission denied' } })
    const response = await run()
    expect(response.status).toBe(500)
    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'critical', title: 'compute-leaderboard 看门狗失明' })
    )
  })

  it('does nothing when every season is fresh', async () => {
    mockQueryResult = () => ({ data: [{ computed_at: iso(60_000) }], error: null })
    const body = await (await run()).json()
    expect(body.stale).toBe(false)
    expect(mockSendAlert).not.toHaveBeenCalled()
  })

  it('reports a 410 fallback as NOT triggered and never claims recovery', async () => {
    mockQueryResult = (season) => ({
      data: [{ computed_at: iso(season === '90D' ? 5 * 3600_000 : 60_000) }],
      error: null,
    })
    global.fetch = jest.fn(async () => ({ ok: false, status: 410 })) as unknown as typeof fetch
    const body = await (await run()).json()
    expect(body.triggers).toEqual([{ season: '90D', triggered: false, note: 'HTTP 410' }])
    const alert = mockSendAlert.mock.calls[0][0]
    expect(alert.title).toBe('compute-leaderboard 看门狗:停更且兜底失败')
    expect(alert.message).toContain('兜底触发失败')
    expect(alert.message).not.toContain('已兜底触发')
  })

  it('treats a network error as not triggered', async () => {
    mockQueryResult = () => ({ data: [], error: null })
    global.fetch = jest.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const body = await (await run()).json()
    expect(body.triggers.every((t: { triggered: boolean }) => t.triggered === false)).toBe(true)
  })

  it('counts a 2xx fallback as triggered', async () => {
    mockQueryResult = () => ({ data: [{ computed_at: iso(4 * 3600_000) }], error: null })
    global.fetch = jest.fn(async () => ({ ok: true, status: 200 })) as unknown as typeof fetch
    const body = await (await run()).json()
    expect(body.triggers).toHaveLength(3)
    expect(body.triggers.every((t: { triggered: boolean }) => t.triggered)).toBe(true)
    expect(mockSendAlert.mock.calls[0][0].message).toContain('已兜底触发')
  })
})
