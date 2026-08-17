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

function request(period?: string) {
  return {
    url: `https://www.arenafi.org/api/trader/binance/trader-1/history${
      period === undefined ? '' : `?period=${period}`
    }`,
  } as NextRequest
}

async function getHistory(period?: string) {
  return GET(request(period), {
    params: Promise.resolve({ platform: 'binance', trader_key: 'trader-1' }),
  })
}

describe('trader history publication quarantine', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
  })

  it('is dynamically rendered and never permits an ISR/cache replay', () => {
    expect(dynamic).toBe('force-dynamic')
    expect(revalidate).toBe(0)
  })

  it('returns a structural empty history with an explicit unavailable-publication state', async () => {
    const response = await getHistory('30D')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers).toMatchObject({
      'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      'CDN-Cache-Control': 'no-store',
      'Vercel-CDN-Cache-Control': 'no-store',
    })
    expect(body).toEqual({
      contract: 'arena.trader-history-evidence@1',
      history: { '7D': [], '30D': [], '90D': [] },
      coverage: {
        '7D': {
          state: 'unknown',
          reason: 'historical_metric_publication_unavailable',
          count: 0,
          expectedCount: 7,
        },
        '30D': {
          state: 'unknown',
          reason: 'historical_metric_publication_unavailable',
          count: 0,
          expectedCount: 30,
        },
        '90D': {
          state: 'unknown',
          reason: 'historical_metric_publication_unavailable',
          count: 0,
          expectedCount: 90,
        },
      },
      publication: {
        state: 'unknown',
        reason: 'historical_metric_publication_unavailable',
      },
      cacheState: 'quarantined',
    })
  })

  it('keeps invalid period errors non-cacheable without touching a data source', async () => {
    const response = await getHistory('all-time')

    expect(response.status).toBe(400)
    expect(response.headers).toMatchObject({
      'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
    })
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_period',
      allowedPeriods: ['7D', '30D', '90D'],
    })
  })

  it('does not retain a raw-table or legacy-cache reader in the public route', () => {
    const route = readFileSync(
      join(process.cwd(), 'app/api/trader/[platform]/[trader_key]/history/route.ts'),
      'utf8'
    )

    expect(route).not.toContain(".from('trader_daily_snapshots')")
    expect(route).not.toContain('getCachedTraderHistory')
    expect(route).not.toContain('cacheTraderHistory')
    expect(route).not.toContain('getSupabaseAdmin')
  })
})
