/** @jest-environment node */

const mockGetAuthUser = jest.fn()
const mockUpdate = jest.fn()
const mockEq = jest.fn()
const mockLoggerError = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== 'user_profiles') throw new Error(`Unexpected table: ${table}`)
      return {
        update: (values: unknown) => {
          mockUpdate(values)
          return { eq: (...args: unknown[]) => mockEq(...args) }
        },
      }
    },
  }),
}))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { auth: {} },
}))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: (...args: unknown[]) => mockLoggerError(...args), warn: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

const post = () =>
  POST(new NextRequest('http://localhost/api/auth/siwe/unlink', { method: 'POST' }))

describe('POST /api/auth/siwe/unlink', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: 'user-1', email: 'user@example.com' })
    mockEq.mockResolvedValue({ error: null })
  })

  it('requires authentication', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    expect((await post()).status).toBe(401)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('refuses to unlink the only login method of a wallet-only account', async () => {
    mockGetAuthUser.mockResolvedValue({ id: 'user-1', email: '0xabc@wallet.arena' })

    expect((await post()).status).toBe(400)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('clears the wallet on the caller’s own profile only', async () => {
    const response = await post()

    expect(response.status).toBe(200)
    expect(mockUpdate).toHaveBeenCalledWith({ wallet_address: null })
    expect(mockEq).toHaveBeenCalledWith('id', 'user-1')
  })

  it('logs the database error instead of failing silently', async () => {
    mockEq.mockResolvedValue({ error: { message: 'db down' } })

    expect((await post()).status).toBe(500)
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('Profile update failed'),
      expect.objectContaining({ userId: 'user-1', error: 'db down' })
    )
  })
})
