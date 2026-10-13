/** @jest-environment node */
const mockUpdateVerifiedTrader = jest.fn()

jest.mock('@/lib/api', () => {
  const { ApiError } = jest.requireActual('@/lib/api/errors')
  return {
    checkRateLimit: jest.fn().mockResolvedValue(null),
    RateLimitPresets: { write: {}, read: {} },
    requireAuth: jest.fn().mockResolvedValue({ id: 'user-1' }),
    getSupabaseAdmin: jest.fn(() => ({})),
    success: (data: unknown) => Response.json({ success: true, data }),
    handleError: (error: unknown) =>
      Response.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        { status: error instanceof ApiError ? error.statusCode : 500 }
      ),
    validateString: (v: unknown) => (typeof v === 'string' ? v : null),
  }
})
jest.mock('@/lib/data/trader-claims', () => ({
  updateVerifiedTrader: (...args: unknown[]) => mockUpdateVerifiedTrader(...args),
  getVerifiedTrader: jest.fn(),
}))

import { NextRequest } from 'next/server'
import { PUT } from '../route'

function put(body: Record<string, unknown>) {
  return new NextRequest('https://www.arenafi.org/api/traders/verified', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trader_id: 't1', source: 'binance_futures', ...body }),
  })
}

describe('PUT /api/traders/verified URL validation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUpdateVerifiedTrader.mockImplementation(async (_s, userId, id, input) => ({
      user_id: userId,
      trader_id: id.trader_id,
      source: id.source,
      ...input,
    }))
  })

  it.each([
    ['website_url', 'javascript:alert(document.cookie)'],
    ['twitter_url', 'http://twitter.com/x'],
    ['avatar_url', 'data:image/svg+xml,<svg onload=alert(1)>'],
    ['telegram_url', 'https://localhost/x'],
    ['discord_url', 'javascript:alert(1)'],
  ])('rejects unsafe %s', async (field, value) => {
    const res = await PUT(put({ [field]: value }))
    expect(res.status).toBe(400)
    expect(mockUpdateVerifiedTrader).not.toHaveBeenCalled()
  })

  it('accepts https URLs and clears blank fields', async () => {
    const res = await PUT(
      put({ website_url: 'https://arena.example/me', twitter_url: '', discord_url: 'me#1' })
    )
    expect(res.status).toBe(200)
    expect(mockUpdateVerifiedTrader.mock.calls[0][3]).toMatchObject({
      website_url: 'https://arena.example/me',
      twitter_url: null,
      discord_url: 'me#1',
    })
  })
})
