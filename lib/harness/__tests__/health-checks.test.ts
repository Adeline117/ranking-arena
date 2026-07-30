/**
 * @jest-environment node
 */

const mockFrom = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({ from: mockFrom })),
}))

jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

import { checkAPIHealth, checkDataQuality } from '../health-checks'

function queryProxy(result: { data: unknown; error: unknown; count?: unknown }) {
  let proxy: Record<string, unknown>
  proxy = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (resolve: (value: unknown) => void) => resolve(result)
        }
        if (property === 'maybeSingle') {
          return () => Promise.resolve(result)
        }
        return () => proxy
      },
    }
  )
  return proxy
}

describe('health check fail-closed contracts', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('turns every resolved database error into a failed data-quality check', async () => {
    mockFrom.mockImplementation(() =>
      queryProxy({ data: null, error: { message: 'database unavailable' }, count: null })
    )

    const checks = await checkDataQuality()

    expect(checks).toHaveLength(6)
    expect(checks.every((check) => check.status === 'fail')).toBe(true)
    expect(checks.every((check) => check.details.includes('database unavailable'))).toBe(true)
  })

  it('does not report an empty leaderboard as healthy data', async () => {
    mockFrom.mockImplementation(() => queryProxy({ data: [], error: null, count: 0 }))

    const checks = await checkDataQuality()

    expect(checks).toHaveLength(6)
    expect(checks.every((check) => check.status === 'fail')).toBe(true)
  })

  it('marks a 2xx API response with a missing required JSON shape as failed', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 200,
      json: jest.fn().mockResolvedValue(null),
    } as unknown as Response)

    const checks = await checkAPIHealth('https://arena.test')

    expect(checks.filter((check) => check.details.startsWith('Missing key'))).toHaveLength(5)
    expect(
      checks
        .filter((check) => check.details.startsWith('Missing key'))
        .every((check) => check.status === 'fail')
    ).toBe(true)
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.cache).toBe('no-store')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
    fetchMock.mockRestore()
  })

  it('propagates a caller deadline into every database query', async () => {
    const observedSignals: AbortSignal[] = []
    const result = { data: null, error: { message: 'stopped' }, count: null }
    let proxy: Record<string, unknown>
    proxy = new Proxy(
      {},
      {
        get(_target, property) {
          if (property === 'then') {
            return (resolve: (value: unknown) => void) => resolve(result)
          }
          if (property === 'maybeSingle') return () => Promise.resolve(result)
          if (property === 'abortSignal') {
            return (signal: AbortSignal) => {
              observedSignals.push(signal)
              return proxy
            }
          }
          return () => proxy
        },
      }
    )
    mockFrom.mockImplementation(() => proxy)
    const parent = new AbortController()

    await checkDataQuality({ signal: parent.signal })

    expect(observedSignals).toHaveLength(8)
    expect(observedSignals.every((signal) => signal instanceof AbortSignal)).toBe(true)
  })
})
