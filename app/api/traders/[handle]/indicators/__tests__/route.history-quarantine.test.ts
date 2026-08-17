/**
 * @jest-environment node
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mockCheckRateLimit = jest.fn()

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) => ({
      status: init.status ?? 200,
      headers: init.headers ?? {},
      json: async () => body,
    }),
  },
}))

jest.mock('@/lib/api', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { public: {} },
}))

import type { NextRequest } from 'next/server'
import { dynamic, GET, revalidate } from '../route'

describe('trader indicators publication quarantine', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
  })

  it('returns no derived indicator from legacy daily ROI observations', async () => {
    const response = await GET({} as NextRequest, {
      params: Promise.resolve({ handle: 'alice' }),
    })

    expect(dynamic).toBe('force-dynamic')
    expect(revalidate).toBe(0)
    expect(response.status).toBe(200)
    expect(response.headers).toMatchObject({
      'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
    })
    await expect(response.json()).resolves.toEqual({
      indicators: {},
      publication: {
        state: 'unknown',
        reason: 'historical_metric_publication_unavailable',
      },
      cacheState: 'quarantined',
    })
  })

  it('removes legacy daily reads, calculations, and cache replay from the route', () => {
    const route = readFileSync(
      join(process.cwd(), 'app/api/traders/[handle]/indicators/route.ts'),
      'utf8'
    )

    expect(route).not.toContain(".from('trader_daily_snapshots')")
    expect(route).not.toContain('computeIndicators')
    expect(route).not.toContain('getServerCache')
    expect(route).not.toContain('getSupabaseAdmin')
  })
})
