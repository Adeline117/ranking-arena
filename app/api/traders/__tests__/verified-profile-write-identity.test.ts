const mockUpdateVerifiedTrader = jest.fn()
const mockSupabase = { name: 'supabase-admin' }

function mockResponse(status: number, body: unknown) {
  return { status, json: async () => body }
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
  isVerifiedTraderProfileConflict: (error: unknown) =>
    (error as { code?: string } | null)?.code === '40001',
  updateVerifiedTrader: (...args: unknown[]) => mockUpdateVerifiedTrader(...args),
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

function invalidJsonRequest(): NextRequest {
  return {
    json: jest.fn().mockRejectedValue(new SyntaxError('invalid JSON')),
  } as unknown as NextRequest
}

const verified = {
  id: 'verified-b',
  user_id: 'user-1',
  trader_id: 'trader-b',
  source: 'binance_futures',
  profile_version: 8,
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
        profile_version: 7,
        display_name: 'Beta Updated',
      })
    )

    expect(response.status).toBe(200)
    expect(mockUpdateVerifiedTrader).toHaveBeenCalledWith(
      mockSupabase,
      'user-1',
      { trader_id: 'trader-b', source: 'binance_futures' },
      7,
      expect.objectContaining({ display_name: 'Beta Updated' })
    )
  })

  it('rejects a write without the revision read with the profile', async () => {
    const response = await updateProfile(
      request({
        trader_id: 'trader-b',
        source: 'binance_futures',
        display_name: 'Ambiguous revision',
      })
    )

    expect(response.status).toBe(400)
    expect(mockUpdateVerifiedTrader).not.toHaveBeenCalled()
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
        profile_version: 3,
        bio: 'Must not be saved',
      })
    )

    expect(response.status).toBe(403)
    expect(mockUpdateVerifiedTrader).toHaveBeenCalledWith(
      mockSupabase,
      'user-1',
      { trader_id: 'someone-elses-trader', source: 'bybit' },
      3,
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
        profile_version: 7,
        bio: 'Scoped update',
      })
    )

    expect(response.status).toBe(403)
  })

  it('returns 409 when another editor committed the loaded revision first', async () => {
    mockUpdateVerifiedTrader.mockRejectedValue({
      code: '40001',
      message: 'verified-trader profile changed since it was loaded',
    })

    const response = await updateProfile(
      request({
        trader_id: 'trader-b',
        source: 'binance_futures',
        profile_version: 7,
        bio: 'Stale draft',
      })
    )

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('draft was not saved'),
    })
  })
})

describe('claim profile PUT strict request contract', () => {
  const validRequest = {
    trader_id: 'trader-b',
    source: 'binance_futures',
    profile_version: 7,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockUpdateVerifiedTrader.mockResolvedValue(verified)
  })

  it.each([null, [], 'profile', 42])('rejects a non-object body: %p', async (body) => {
    const response = await updateClaimProfile(request(body))

    expect(response.status).toBe(400)
    expect(mockUpdateVerifiedTrader).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON', async () => {
    const response = await updateClaimProfile(invalidJsonRequest())

    expect(response.status).toBe(400)
    expect(mockUpdateVerifiedTrader).not.toHaveBeenCalled()
  })

  it('rejects unknown fields instead of silently ignoring them', async () => {
    const response = await updateClaimProfile(
      request({ ...validRequest, display_name: 'Valid', admin: true })
    )

    expect(response.status).toBe(400)
    expect(mockUpdateVerifiedTrader).not.toHaveBeenCalled()
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER])(
    'rejects an invalid database revision: %p',
    async (profileVersion) => {
      const response = await updateClaimProfile(
        request({ ...validRequest, profile_version: profileVersion, display_name: 'Valid' })
      )

      expect(response.status).toBe(400)
      expect(mockUpdateVerifiedTrader).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['display_name', 7],
    ['bio', false],
    ['avatar_url', { url: 'https://example.com/avatar.png' }],
    ['twitter_url', 7],
    ['telegram_url', false],
    ['discord_url', ['https://discord.com/users/1']],
    ['website_url', { href: 'https://example.com' }],
    ['can_receive_messages', 'false'],
  ])('rejects an invalid %s type instead of coercing it', async (field, value) => {
    const response = await updateClaimProfile(request({ ...validRequest, [field]: value }))

    expect(response.status).toBe(400)
    expect(mockUpdateVerifiedTrader).not.toHaveBeenCalled()
  })

  it.each([
    ['discord_url', 'discord-user'],
    ['discord_url', `https://discord.com/${'a'.repeat(4096)}`],
    ['website_url', 'http://example.com'],
  ])('rejects an invalid or oversized %s', async (field, value) => {
    const response = await updateClaimProfile(request({ ...validRequest, [field]: value }))

    expect(response.status).toBe(400)
    expect(mockUpdateVerifiedTrader).not.toHaveBeenCalled()
  })

  it('preserves an explicit false boolean and normalized nullable values', async () => {
    const response = await updateClaimProfile(
      request({
        ...validRequest,
        display_name: '   ',
        discord_url: ' https://discord.com/users/123 ',
        can_receive_messages: false,
      })
    )

    expect(response.status).toBe(200)
    expect(mockUpdateVerifiedTrader).toHaveBeenCalledWith(
      mockSupabase,
      'user-1',
      { trader_id: 'trader-b', source: 'binance_futures' },
      7,
      {
        display_name: null,
        discord_url: 'https://discord.com/users/123',
        can_receive_messages: false,
      }
    )
  })

  it('fails closed when the service does not acknowledge the next revision', async () => {
    mockUpdateVerifiedTrader.mockResolvedValue({ ...verified, profile_version: 7 })

    const response = await updateClaimProfile(
      request({ ...validRequest, display_name: 'Must be acknowledged' })
    )

    expect(response.status).toBe(500)
  })
})
