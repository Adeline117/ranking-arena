const mockUpdateVerifiedTrader = jest.fn()
const mockSupabase = { name: 'supabase-admin' }

function mockResponse(status: number, body: unknown) {
  return { status, headers: new Headers(), json: async () => body }
}

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: () => mockSupabase,
  requireAuth: jest.fn().mockResolvedValue({ id: 'user-1' }),
  success: (data: unknown) => mockResponse(200, { success: true, data }),
  handleError: (error: unknown) => {
    const typed = error as { message?: string; statusCode?: number }
    return mockResponse(typed.statusCode ?? 500, {
      success: false,
      error: typed.message ?? 'Internal server error',
    })
  },
  validateString: (
    value: unknown,
    options: { required?: boolean; maxLength?: number; fieldName?: string } = {}
  ) => {
    if (typeof value !== 'string' || value.trim() === '') {
      if (options.required) {
        throw Object.assign(new Error(`${options.fieldName ?? 'field'} is required`), {
          statusCode: 400,
        })
      }
      return null
    }
    const normalized = value.trim()
    if (options.maxLength && normalized.length > options.maxLength) {
      throw Object.assign(new Error(`${options.fieldName ?? 'field'} is too long`), {
        statusCode: 400,
      })
    }
    return normalized
  },
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { write: {} },
}))

jest.mock('@/lib/data/trader-claims', () => ({
  getVerifiedTrader: jest.fn(),
  updateVerifiedTrader: (...args: unknown[]) => mockUpdateVerifiedTrader(...args),
  getVerifiedTraderLinks: jest.fn().mockResolvedValue(null),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn() }),
}))

import type { NextRequest } from 'next/server'
import { PUT as updateClaimProfile } from '../claim/profile/route'
import { PUT as updateVerifiedProfile } from '../verified/route'

function request(body: unknown): NextRequest {
  return { json: jest.fn().mockResolvedValue(body) } as unknown as NextRequest
}

const verified = {
  id: 'verified-b',
  user_id: 'user-1',
  trader_id: 'trader-b',
  source: 'binance_futures',
}

describe.each([
  ['claim profile PUT', updateClaimProfile],
  ['legacy verified profile PUT', updateVerifiedProfile],
])('%s exact identity boundary', (_label, updateProfile) => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUpdateVerifiedTrader.mockResolvedValue(verified)
  })

  it('updates only the requested user-owned trader identity', async () => {
    const response = await updateProfile(
      request({
        trader_id: 'trader-b',
        source: 'BINANCE_FUTURES',
        display_name: 'Beta Updated',
      })
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    expect(mockUpdateVerifiedTrader).toHaveBeenCalledWith(
      mockSupabase,
      'user-1',
      { trader_id: 'trader-b', source: 'binance_futures' },
      expect.objectContaining({ display_name: 'Beta Updated' })
    )
  })

  it('rejects a write without the target trader identity', async () => {
    const response = await updateProfile(request({ display_name: 'Ambiguous write' }))

    expect(response.status).toBe(400)
    expect(mockUpdateVerifiedTrader).not.toHaveBeenCalled()
  })

  it('fails closed when the requested identity is not owned by the viewer', async () => {
    mockUpdateVerifiedTrader.mockResolvedValue(null)

    const response = await updateProfile(
      request({
        trader_id: 'someone-elses-trader',
        source: 'bybit',
        bio: 'Must not be saved',
      })
    )

    expect(response.status).toBe(403)
    expect(mockUpdateVerifiedTrader).toHaveBeenCalledWith(
      mockSupabase,
      'user-1',
      { trader_id: 'someone-elses-trader', source: 'bybit' },
      expect.objectContaining({ bio: 'Must not be saved' })
    )
  })

  it.each([
    ['user', { user_id: 'different-user' }],
    ['trader', { trader_id: 'sibling-trader' }],
    ['source', { source: 'bybit' }],
  ])('rejects a service acknowledgement for a different %s', async (_field, mismatch) => {
    mockUpdateVerifiedTrader.mockResolvedValue({
      ...verified,
      ...mismatch,
    })

    const response = await updateProfile(
      request({
        trader_id: 'trader-b',
        source: 'binance_futures',
        bio: 'Scoped update',
      })
    )

    expect(response.status).toBe(403)
  })
})
