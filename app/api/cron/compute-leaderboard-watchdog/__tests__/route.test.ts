/** @jest-environment node */

const mockSendAlert = jest.fn()
type QueryResult = { data: unknown; error: unknown }
let mockSeal: (season: string) => QueryResult
let mockServing: (season: string) => QueryResult

jest.mock('@/lib/api/with-cron', () => ({
  withCron: (_name: string, handler: Function) => async (request: unknown) => {
    const supabase = {
      from: (table: string) => {
        let season = ''
        const chain = {
          select: () => chain,
          eq: (_col: string, value: string) => ((season = value), chain),
          order: () => chain,
          limit: async () =>
            table === 'public_ranked_leaderboard' ? mockServing(season) : mockSeal(season),
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

const ORIGINAL_FETCH = global.fetch
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const sealedAgo = (msAgo: number) => () => ({ data: [{ recorded_at: iso(msAgo) }], error: null })
const served = () => ({ data: [{ id: 'row' }], error: null })

function run() {
  return GET(new NextRequest('http://localhost/api/cron/compute-leaderboard-watchdog'))
}

describe('compute-leaderboard-watchdog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSendAlert.mockResolvedValue(undefined)
    mockSeal = sealedAgo(60_000)
    mockServing = served
    global.fetch = jest.fn() as unknown as typeof fetch
  })
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH
  })

  it('fails the run and alerts when the publication query errors', async () => {
    mockSeal = () => ({ data: null, error: { message: 'permission denied' } })
    const response = await run()
    expect(response.status).toBe(500)
    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'critical', title: 'compute-leaderboard 看门狗失明' })
    )
  })

  it('does nothing when every season has a recent served seal', async () => {
    const body = await (await run()).json()
    expect(body.stale).toBe(false)
    expect(mockSendAlert).not.toHaveBeenCalled()
  })

  it('alerts on an old seal and never calls an HTTP fallback', async () => {
    mockSeal = (season) => sealedAgo(season === '90D' ? 5 * 3600_000 : 60_000)()
    const body = await (await run()).json()
    expect(body.staleSeasons).toEqual(['90D'])
    expect(global.fetch).not.toHaveBeenCalled()
    const alert = mockSendAlert.mock.calls[0][0]
    expect(alert.title).toBe('compute-leaderboard 看门狗:封存发布停更')
    expect(alert.message).toContain('只告警、不兜底')
    expect(alert.message).not.toContain('已兜底触发')
  })

  it('treats a fresh seal that the public view does not serve as stale', async () => {
    mockServing = (season) => (season === '7D' ? { data: [], error: null } : served())
    const body = await (await run()).json()
    expect(body.staleSeasons).toEqual(['7D'])
    expect(mockSendAlert.mock.calls[0][0].message).toContain('公开视图未服务')
  })

  it('treats a season that was never sealed as stale', async () => {
    mockSeal = () => ({ data: [], error: null })
    const body = await (await run()).json()
    expect(body.staleSeasons).toEqual(['90D', '30D', '7D'])
    expect(mockSendAlert.mock.calls[0][0].message).toContain('从未封存')
  })
})
