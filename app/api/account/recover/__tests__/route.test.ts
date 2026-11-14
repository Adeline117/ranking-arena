/** @jest-environment node */

const mockRpc = jest.fn()
const mockAdminUpdateUser = jest.fn()
const mockPasswordSignIn = jest.fn()
const mockSignOut = jest.fn()
const mockCheckRateLimit = jest.fn()
let rebanStateResult: { data: Record<string, unknown> | null; error: unknown }
const mockStripeUpdate = jest.fn()
const mockSubscriptionUpdate = jest.fn()
let tokenResult: { data: Record<string, unknown> | null; error: unknown }
let profileResult: { data: Record<string, unknown> | null; error: unknown }
let subscriptionResult: { data: Record<string, unknown> | null; error: unknown }

jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: Function) => (request: Request) => handler({ request }),
}))

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: { signInWithPassword: mockPasswordSignIn, signOut: mockSignOut },
  })),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}))

jest.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon' },
}))

const mockEmailLookup = jest.fn()
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
        ilike: jest.fn((column: string, pattern: string) => {
          mockEmailLookup(column, pattern)
          return {
            not: jest.fn(() => ({
              maybeSingle: jest.fn().mockImplementation(async () => profileResult),
            })),
          }
        }),
        eq: jest.fn(() => ({
          // rebanIfStillPending: select('deleted_at').eq('id', ...).maybeSingle()
          maybeSingle: jest.fn().mockImplementation(async () => rebanStateResult),
        })),
      })),
    }
  }
  if (table === 'subscriptions') {
    return {
      select: jest.fn(() => ({
        eq: jest.fn(() => ({
          in: jest.fn((_column: string, statuses: string[]) => ({
            limit: jest.fn(() => ({
              maybeSingle: jest
                .fn()
                .mockImplementation(async () =>
                  statuses.includes(
                    (subscriptionResult.data as { status?: string } | null)?.status ?? ''
                  )
                    ? subscriptionResult
                    : { data: null, error: null }
                ),
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

const RECOVERY_TOKEN = 'A'.repeat(43)

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
    mockPasswordSignIn.mockResolvedValue({ data: { session: { access_token: 'x' } }, error: null })
    mockSignOut.mockResolvedValue({ error: null })
    mockCheckRateLimit.mockResolvedValue(null)
    rebanStateResult = { data: { deleted_at: '2026-10-01T00:00:00Z' }, error: null }
    mockStripeUpdate.mockResolvedValue({ status: 'active' })
  })

  it('resumes renewal for a past_due subscription the deletion stopped', async () => {
    ;(subscriptionResult.data as { status: string }).status = 'past_due'

    const response = await POST(request({ recovery_token: RECOVERY_TOKEN }))

    expect(response.status).toBe(200)
    expect(mockStripeUpdate).toHaveBeenCalledWith('sub_123', { cancel_at_period_end: false })
  })

  it('restores a passwordless account with its one-time token and resumes renewal', async () => {
    const response = await POST(request({ recovery_token: RECOVERY_TOKEN }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ success: true, subscription_resumed: true })
    expect(mockRpc).toHaveBeenCalledWith('restore_pending_account', {
      p_user_id: 'user-1',
      p_recovery_token_hash: createHash('sha256').update(RECOVERY_TOKEN).digest('hex'),
    })
    expect(mockAdminUpdateUser).toHaveBeenCalledWith('user-1', { ban_duration: 'none' })
    expect(mockStripeUpdate).toHaveBeenCalledWith('sub_123', { cancel_at_period_end: false })
    expect(mockSubscriptionUpdate).toHaveBeenCalledWith({ cancel_at_period_end: false })
  })

  it('does not unban or reveal account details for an invalid token', async () => {
    tokenResult = { data: null, error: null }

    const response = await POST(request({ recovery_token: 'Q'.repeat(43) }))

    expect(response.status).toBe(401)
    expect(mockAdminUpdateUser).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['too short', 'A'.repeat(39)],
    ['impossible encoded length', 'A'.repeat(41)],
    ['too long', 'A'.repeat(129)],
    ['padding', `${'A'.repeat(42)}=`],
    ['non-canonical trailing bits', `${'A'.repeat(42)}B`],
    ['surrounding whitespace', ` ${RECOVERY_TOKEN}`],
  ])('fails malformed token input closed before querying storage: %s', async (_label, token) => {
    const response = await POST(request({ recovery_token: token }))

    expect(response.status).toBe(401)
    expect(mockFrom).not.toHaveBeenCalled()
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
      ban_duration: '876000h',
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
      ban_duration: '876000h',
    })
  })

  it('answers an expired password recovery exactly like an unknown email, without unbanning', async () => {
    profileResult = {
      data: { id: 'user-1', deletion_scheduled_at: new Date(Date.now() - 1000).toISOString() },
      error: null,
    }
    const expired = await POST(request({ email: 'user@example.com', password: 'x' }))
    profileResult = { data: null, error: null }
    const unknown = await POST(request({ email: 'nobody@example.com', password: 'x' }))

    expect(expired.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(await expired.json()).toEqual(await unknown.json())
    expect(mockAdminUpdateUser).not.toHaveBeenCalled()
    expect(mockPasswordSignIn).not.toHaveBeenCalled()
  })

  it('looks the pending account up case-insensitively, with LIKE wildcards escaped', async () => {
    await POST(request({ email: ' User_Name@Example.com ', password: 'correct-password' }))

    expect(mockEmailLookup).toHaveBeenCalledWith('email', 'User\\_Name@Example.com')
  })

  it('never lets a wildcard widen the pending-account lookup', async () => {
    const response = await POST(request({ email: '*@example.com', password: 'x' }))

    expect(response.status).toBe(401)
    expect(mockEmailLookup).not.toHaveBeenCalled()
    expect(mockAdminUpdateUser).not.toHaveBeenCalled()
  })

  it('enforces a per-email rate limit before touching the account', async () => {
    const limited = new Response(JSON.stringify({ code: 'RATE_LIMIT_EXCEEDED' }), { status: 429 })
    mockCheckRateLimit.mockResolvedValueOnce(limited)

    const response = await POST(request({ email: 'User@Example.com ', password: 'x' }))

    expect(response.status).toBe(429)
    const [, config, key] = mockCheckRateLimit.mock.calls[0]
    expect(config).toMatchObject({ prefix: 'account-recover-email', failClose: true })
    expect(key).toBe(
      `recover-email:${createHash('sha256').update('user@example.com').digest('hex')}`
    )
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockAdminUpdateUser).not.toHaveBeenCalled()
  })

  it('does not re-ban an account that a concurrent request already recovered', async () => {
    mockPasswordSignIn.mockResolvedValue({ data: { session: null }, error: { message: 'invalid' } })
    rebanStateResult = { data: { deleted_at: null }, error: null }

    const response = await POST(request({ email: 'user@example.com', password: 'wrong' }))

    expect(response.status).toBe(401)
    expect(mockAdminUpdateUser).toHaveBeenCalledTimes(1)
    expect(mockAdminUpdateUser).toHaveBeenCalledWith('user-1', { ban_duration: 'none' })
  })

  it('fails closed (500) when the re-ban cannot be restored', async () => {
    mockPasswordSignIn.mockResolvedValue({ data: { session: null }, error: { message: 'invalid' } })
    mockAdminUpdateUser
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValue({ error: { message: 'auth down' } })

    const response = await POST(request({ email: 'user@example.com', password: 'wrong' }))

    expect(response.status).toBe(500)
    // unban + reban + one retry
    expect(mockAdminUpdateUser).toHaveBeenCalledTimes(3)
  })

  it('re-bans when credential verification throws', async () => {
    mockPasswordSignIn.mockRejectedValue(new Error('network'))

    const response = await POST(request({ email: 'user@example.com', password: 'pw' }))

    expect(response.status).toBe(401)
    expect(mockAdminUpdateUser).toHaveBeenLastCalledWith('user-1', { ban_duration: '876000h' })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('revokes the credential-probe session after successful verification', async () => {
    const response = await POST(request({ email: 'user@example.com', password: 'correct' }))

    expect(response.status).toBe(200)
    expect(mockSignOut).toHaveBeenCalledWith({ scope: 'local' })
  })
})
