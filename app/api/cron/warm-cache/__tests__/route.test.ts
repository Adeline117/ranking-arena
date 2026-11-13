/** @jest-environment node */

const mockRefresh = jest.fn()

jest.mock('@/lib/api/with-cron', () => ({
  withCron: (_name: string, handler: Function) => async (request: unknown) => {
    try {
      const result = await handler(request, {})
      return Response.json({ ok: true, ...result })
    } catch (err) {
      return Response.json({ ok: false, error: String(err) }, { status: 500 })
    }
  },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }),
}))

jest.mock('@/lib/getInitialTraders', () => ({
  refreshHomeInitialTradersCache: (...args: unknown[]) => mockRefresh(...args),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

const ORIGINAL_FETCH = global.fetch
const run = () => GET(new NextRequest('http://localhost/api/cron/warm-cache'))

describe('warm-cache', () => {
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH
    mockRefresh.mockReset()
  })

  it('succeeds when the SSR cache and API warmup succeed', async () => {
    mockRefresh.mockResolvedValueOnce(50)
    global.fetch = jest.fn(async () => ({ ok: true })) as unknown as typeof fetch
    const response = await run()
    expect(response.status).toBe(200)
    expect((await response.json()).traders_cached).toBe(50)
  })

  it('fails the run when the SSR cache refresh errors', async () => {
    mockRefresh.mockRejectedValueOnce(new Error('db down'))
    global.fetch = jest.fn(async () => ({ ok: true })) as unknown as typeof fetch
    const response = await run()
    expect(response.status).toBe(500)
    expect((await response.json()).error).toContain('db down')
  })

  it('fails the run when the API warmup fails', async () => {
    mockRefresh.mockResolvedValueOnce(50)
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch
    expect((await run()).status).toBe(500)
  })
})
