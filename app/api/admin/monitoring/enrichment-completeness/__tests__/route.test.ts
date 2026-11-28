/**
 * @jest-environment node
 */

const mockVerifyAdminAuth = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockGetByPrefix = jest.fn()
const mockFrom = jest.fn()
const mockRpc = jest.fn()
let gapSummary: unknown[] = []

jest.mock('@/lib/auth/verify-service-auth', () => ({
  verifyAdminAuth: (...args: unknown[]) => mockVerifyAdminAuth(...args),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}))

jest.mock('@/lib/services/pipeline-state', () => ({
  PipelineState: {
    getByPrefix: (...args: unknown[]) => mockGetByPrefix(...args),
  },
}))

import { GET } from '../route'

function queryResult(result: unknown) {
  const query = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject)
        }
        return jest.fn(() => query)
      },
    }
  )
  return query
}

function request() {
  return new Request('http://localhost:3000/api/admin/monitoring/enrichment-completeness', {
    headers: { authorization: 'Bearer admin-jwt' },
  })
}

function expectPrivateNoStore(response: Response) {
  expect(response.headers.get('Cache-Control')).toBe(
    'private, no-store, max-age=0, must-revalidate'
  )
  expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
  expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
}

describe('GET /api/admin/monitoring/enrichment-completeness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSupabaseAdmin.mockReturnValue({ from: mockFrom, rpc: mockRpc })
    mockGetByPrefix.mockResolvedValue([])
    gapSummary = []
    mockRpc.mockImplementation(async (name: string) =>
      name === 'arena_visible_sources'
        ? {
            data: [
              {
                filter_source: 'binance_futures',
                trader_count: 10,
                cache_updated_at: '2026-11-27T00:00:00Z',
              },
            ],
            error: null,
          }
        : { data: gapSummary }
    )
    mockFrom.mockImplementation((table: string) => {
      if (table === 'trader_equity_curve') return queryResult({ count: 8 })
      if (table === 'trader_stats_detail') return queryResult({ count: 6 })
      if (table === 'pipeline_logs') {
        return queryResult({
          data: [
            { job_name: 'enrich-binance_futures', status: 'success' },
            { job_name: 'enrich-binance_futures', status: 'error' },
          ],
        })
      }
      throw new Error(`Unexpected table: ${table}`)
    })
  })

  it('fails closed before opening the admin client and disables every shared cache', async () => {
    mockVerifyAdminAuth.mockResolvedValue(false)

    const response = await GET(request())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' })
    expectPrivateNoStore(response)
    expect(mockVerifyAdminAuth).toHaveBeenCalledWith(expect.any(Request))
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockGetByPrefix).not.toHaveBeenCalled()
  })

  it('retains enrichment reads while marking retired heartbeat history unavailable', async () => {
    mockVerifyAdminAuth.mockResolvedValue(true)
    mockGetByPrefix.mockResolvedValue([
      {
        key: 'enrich:dead:binance_futures',
        value: { traderIds: ['trader-1', 'trader-2'], failCount: 3 },
        updated_at: '2026-08-16T00:00:00.000Z',
      },
    ])
    gapSummary = [{ platform: 'binance_futures', stale: 2 }]
    const response = await GET(request())

    expect(response.status).toBe(200)
    expectPrivateNoStore(response)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      elapsed_ms: expect.any(Number),
      count: 1,
      enrichment_stats: [
        {
          platform: 'binance_futures',
          total_in_leaderboard: 10,
          with_equity_curve: 8,
          with_stats_detail: 6,
          ec_coverage_pct: 80,
          sd_coverage_pct: 60,
        },
      ],
      dead_letter_queue: [{ key: 'binance_futures', count: 2, fail_count: 3 }],
      dead_letter_total: 2,
      gap_summary: [{ platform: 'binance_futures', stale: 2 }],
      pipeline_24h: { total: 2, success: 1, success_rate_pct: 50 },
      heartbeats: [],
      heartbeat_history: {
        availability: false,
        code: 'HEARTBEAT_HISTORY_NOT_PUBLISHED',
      },
    })
    expect(mockGetSupabaseAdmin).toHaveBeenCalledTimes(1)
    expect(mockGetByPrefix).toHaveBeenCalledWith('enrich:dead:')
  })
})
