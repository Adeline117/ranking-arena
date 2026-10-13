jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(),
}))

jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn() },
}))

import { checkAPIHealth } from '../health-checks'

const mockFetch = jest.fn()

describe('API health checks', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    global.fetch = mockFetch as typeof fetch
    mockFetch.mockImplementation((input: string | URL | Request) => {
      const url = String(input)
      const payload = url.includes('/api/rankings/platform-stats')
        ? {
            platforms: [],
            season: '90D',
            ranking_visibility: 'unknown',
          }
        : { data: [], results: [], movers: [], status: 'ok' }

      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('warns when platform statistics have no verified aggregate publication', async () => {
    const checks = await checkAPIHealth('https://arena.test')

    expect(checks.find((check) => check.name === 'api:Platform Stats')).toMatchObject({
      status: 'warn',
      details: 'Published ranking aggregate unavailable',
    })
  })
})
