/** @jest-environment node */

const mockUser = {
  id: 'user-1',
  email: 'user@example.com',
  identities: [{ provider: 'email' }],
}
const mockPasswordSignIn = jest.fn()
const mockRpc = jest.fn()
const mockAdminUpdateUser = jest.fn()
const mockAdminSignOut = jest.fn()
const mockStripeUpdate = jest.fn()
const mockLocalSubscriptionUpdate = jest.fn()
let subscriptionResult: { data: Record<string, unknown> | null; error: unknown }

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => (request: Request) => handler({ user: mockUser, request }),
}))

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ auth: { signInWithPassword: mockPasswordSignIn } })),
}))

jest.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon' },
}))

const mockFrom = jest.fn((table: string) => {
  if (table !== 'subscriptions') throw new Error(`Unexpected table: ${table}`)
  return {
    select: jest.fn(() => ({
      eq: jest.fn(() => ({
        in: jest.fn(() => ({
          limit: jest.fn(() => ({
            maybeSingle: jest.fn().mockImplementation(async () => subscriptionResult),
          })),
        })),
      })),
    })),
    update: (...args: unknown[]) => {
      mockLocalSubscriptionUpdate(...args)
      return { eq: jest.fn().mockResolvedValue({ error: null }) }
    },
  }
})

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: mockFrom,
    rpc: mockRpc,
    auth: {
      admin: { updateUserById: mockAdminUpdateUser, signOut: mockAdminSignOut },
    },
  })),
}))

jest.mock('@/lib/stripe', () => ({
  getStripe: jest.fn(() => ({ subscriptions: { update: mockStripeUpdate } })),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
}))

import { createHash } from 'node:crypto'
import { POST } from '../route'

function request(body: Record<string, unknown>): Request {
  return new Request('https://www.arenafi.org/api/account/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('account deletion scheduling', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUser.email = 'user@example.com'
    mockUser.identities = [{ provider: 'email' }]
    subscriptionResult = {
      data: {
        stripe_subscription_id: 'sub_123',
        status: 'active',
        plan: 'monthly',
      },
      error: null,
    }
    mockPasswordSignIn.mockResolvedValue({ error: null })
    mockRpc.mockResolvedValue({ data: new Date().toISOString(), error: null })
    mockStripeUpdate.mockResolvedValue({ status: 'active' })
    mockAdminUpdateUser.mockResolvedValue({ error: null })
    mockAdminSignOut.mockResolvedValue({ error: null })
  })

  it('retains account data, stores only a token hash, and stops renewal reversibly', async () => {
    const response = await POST(request({ password: 'correct', reason: 'privacy' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.recovery_token).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(mockRpc).toHaveBeenCalledWith(
      'schedule_account_deletion',
      expect.objectContaining({
        p_user_id: 'user-1',
        p_reason: 'privacy',
        p_recovery_token_hash: createHash('sha256').update(body.recovery_token).digest('hex'),
      })
    )
    expect(mockRpc.mock.calls[0][1].p_recovery_token_hash).not.toBe(body.recovery_token)
    expect(mockStripeUpdate).toHaveBeenCalledWith('sub_123', { cancel_at_period_end: true })
    expect(mockLocalSubscriptionUpdate).toHaveBeenCalledWith({ cancel_at_period_end: true })
    expect(mockAdminUpdateUser).toHaveBeenCalledWith('user-1', { ban_duration: '720h' })
    expect(mockAdminSignOut).toHaveBeenCalledWith('user-1', 'global')
    expect(mockFrom).toHaveBeenCalledTimes(2)
  })

  it('compensates subscription renewal when the deletion transaction fails', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    const response = await POST(request({ password: 'correct' }))

    expect(response.status).toBe(500)
    expect(mockStripeUpdate).toHaveBeenNthCalledWith(1, 'sub_123', {
      cancel_at_period_end: true,
    })
    expect(mockStripeUpdate).toHaveBeenNthCalledWith(2, 'sub_123', {
      cancel_at_period_end: false,
    })
    expect(mockAdminUpdateUser).not.toHaveBeenCalled()
  })

  it('supports passwordless accounts with typed confirmation and skips lifetime billing calls', async () => {
    mockUser.email = 'wallet@wallet.arena'
    mockUser.identities = [{ provider: 'privy' }]
    subscriptionResult.data = {
      stripe_subscription_id: 'lifetime_user-1',
      status: 'active',
      plan: 'lifetime',
    }

    const response = await POST(request({ confirm: 'DELETE' }))

    expect(response.status).toBe(200)
    expect(mockPasswordSignIn).not.toHaveBeenCalled()
    expect(mockStripeUpdate).not.toHaveBeenCalled()
  })
})
