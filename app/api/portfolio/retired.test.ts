import type { NextRequest } from 'next/server'

jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn(
      (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) => ({
        status: init.status ?? 200,
        headers: new Map(Object.entries(init.headers ?? {})),
        json: async () => body,
      })
    ),
  },
}))

import { POST as connect } from './route'
import { GET as positions } from './positions/route'
import { GET as snapshots } from './snapshots/route'
import { POST as sync } from './sync/route'

describe('legacy portfolio write retirement', () => {
  it.each([
    ['connect', connect],
    ['sync', sync],
    ['positions', positions],
    ['snapshots', snapshots],
  ])('returns a fixed private 410 for %s without reading the request', async (_name, handler) => {
    const request = {} as NextRequest
    const response = await handler(request)

    expect(response.status).toBe(410)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Pragma')).toBe('no-cache')
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      successor: '/api/trader/authorize',
    })
  })
})
