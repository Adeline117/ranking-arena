/** @jest-environment node */

const mockRpc = jest.fn()
const mockAdminUpdateUser = jest.fn()
const mockPasswordSignIn = jest.fn()
const mockStripeUpdate = jest.fn()
const mockSubscriptionUpdate = jest.fn()
let tokenResult: { data: Record<string, unknown> | null; error: unknown }
let profileResult: { data: Record<string, unknown> | null; error: unknown }
let subscriptionResult: { data: Record<string, unknown> | null; error: unknown }

jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: Function) => (request: Request) => handler({ request }),
}))

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({ auth: { signInWithPassword: mockPasswordSignIn } })),
}))

jest.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon' },
}))

const mockFrom = jest.fn((table: string) => {
  if (table === 'account_recovery_tokens') {
    return {
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          maybeSingle: jest.fn().mockImplementation(async () => tokenResult),
        })),
      })),
    }
  }
  if (table === 'user_profiles') {
    return {
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          not: jest.fn(() => ({
            maybeSingle: jest.fn().mockImplementation(async () => profileResult),
          })),
        })),
      })),
    }
  }
  if (table === 'subscriptions') {
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
        mockSubscriptionUpdate(...args)
        return { eq: jest.fn().mockResolvedValue({ error: null }) }
      },
    }
  }
  throw new Error(`Unexpected table: ${table}`)
})

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({
    from: mockFrom,
    rpc: mockRpc,
    auth: { admin: { updateUserById: mockAdminUpdateUser } },
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
  return new Request('https://www.arenafi.org/api/account/recover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('account recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    tokenResult = {
      data: {
        user_id: 'user-1',
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        used_at: null,
      },
      error: null,
    }
    profileResult = {
      data: {
        id: 'user-1',
        deletion_scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
      error: null,
    }
    subscriptionResult = {
      data: {
        stripe_subscription_id: 'sub_123',
        status: 'active',
        plan: 'monthly',
        cancel_at_period_end: true,
      },
      error: null,
    }
    mockRpc.mockResolvedValue({ data: 'user-1', error: null })
    mockAdminUpdateUser.mockResolvedValue({ error: null })
    mockPasswordSignIn.mockResolvedValue({ error: null })
    mockStripeUpdate.mockResolvedValue({ status: 'active' })
  })

  it('restores a passwordless account with its one-time token and resumes renewal', async () => {
    const response = await POST(request({ recovery_token: 'plain-recovery-token' }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ success: true, subscription_resumed: true })
    expect(mockRpc).toHaveBeenCalledWith('restore_pending_account', {
      p_user_id: 'user-1',
      p_recovery_token_hash: createHash('sha256').update('plain-recovery-token').digest('hex'),
    })
    expect(mockAdminUpdateUser).toHaveBeenCalledWith('user-1', { ban_duration: 'none' })
    expect(mockStripeUpdate).toHaveBeenCalledWith('sub_123', { cancel_at_period_end: false })
    expect(mockSubscriptionUpdate).toHaveBeenCalledWith({ cancel_at_period_end: false })
  })

  it('does not unban or reveal account details for an invalid token', async () => {
    tokenResult = { data: null, error: null }

    const response = await POST(request({ recovery_token: 'wrong' }))

    expect(response.status).toBe(401)
    expect(mockAdminUpdateUser).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('re-bans a password account when credential verification fails', async () => {
    mockPasswordSignIn.mockResolvedValue({ error: { message: 'invalid' } })

    const response = await POST(request({ email: 'user@example.com', password: 'wrong' }))

    expect(response.status).toBe(401)
    expect(mockAdminUpdateUser).toHaveBeenNthCalledWith(1, 'user-1', {
      ban_duration: 'none',
    })
    expect(mockAdminUpdateUser).toHaveBeenNthCalledWith(2, 'user-1', {
      ban_duration: '720h',
    })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('re-bans the account if the atomic restore fails after verification', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database unavailable' } })

    const response = await POST(
      request({ email: 'user@example.com', password: 'correct-password' })
    )

    expect(response.status).toBe(500)
    expect(mockAdminUpdateUser).toHaveBeenLastCalledWith('user-1', {
      ban_duration: '720h',
    })
  })
})
