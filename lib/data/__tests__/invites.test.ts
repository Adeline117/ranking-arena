/**
 * Invite code system — unit tests
 *
 * Tests validateInviteCode and checkUserTrialStatus.
 * redeemInviteCode is skipped (uses RPC, tested via integration tests).
 *
 * All Supabase calls are mocked via chainable builder stubs.
 */

import { validateInviteCode, checkUserTrialStatus, type InviteCode } from '../invites'
import type { SupabaseClient } from '@supabase/supabase-js'

// ---- Helpers ----

/**
 * Build a mock SupabaseClient whose `.from(table)` chain resolves to the
 * given result. The chain supports .select().eq().single() and
 * .select().eq().eq().maybeSingle().
 */
function mockSupabase(
  singleResult: { data: unknown; error: unknown } = { data: null, error: null },
  maybeSingleResult?: { data: unknown; error: unknown }
): SupabaseClient {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue(singleResult),
    maybeSingle: jest.fn().mockResolvedValue(maybeSingleResult ?? singleResult),
  }
  return {
    from: jest.fn().mockReturnValue(chain),
  } as unknown as SupabaseClient
}

function makeInvite(overrides: Partial<InviteCode> = {}): InviteCode {
  return {
    id: 'inv-1',
    code: 'ABCD1234',
    creator_id: 'user-creator',
    max_uses: 10,
    current_uses: 3,
    trial_days: 7,
    trial_tier: 'pro',
    expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    created_at: new Date().toISOString(),
    is_active: true,
    ...overrides,
  }
}

// ============================================
// validateInviteCode
// ============================================

describe('validateInviteCode', () => {
  it('returns valid:true for a valid active code', async () => {
    const invite = makeInvite()
    const sb = mockSupabase({ data: invite, error: null })

    const result = await validateInviteCode(sb, 'abcd1234')
    expect(result.valid).toBe(true)
    expect(result.invite).toEqual(invite)
    expect(result.error).toBeUndefined()

    // Verify .eq was called with uppercased code
    const chain = (sb.from as jest.Mock).mock.results[0].value
    expect(chain.eq).toHaveBeenCalledWith('code', 'ABCD1234')
  })

  it('returns valid:false when code does not exist', async () => {
    const sb = mockSupabase({ data: null, error: { code: 'PGRST116' } })

    const result = await validateInviteCode(sb, 'NOTEXIST')
    expect(result.valid).toBe(false)
    expect(result.error).toBe('邀请码不存在')
    expect(result.invite).toBeUndefined()
  })

  it('returns valid:false when code is inactive', async () => {
    const invite = makeInvite({ is_active: false })
    const sb = mockSupabase({ data: invite, error: null })

    const result = await validateInviteCode(sb, invite.code)
    expect(result.valid).toBe(false)
    expect(result.error).toBe('邀请码已失效')
  })

  it('returns valid:false when code has expired', async () => {
    const invite = makeInvite({
      expires_at: new Date(Date.now() - 1000).toISOString(), // 1 second ago
    })
    const sb = mockSupabase({ data: invite, error: null })

    const result = await validateInviteCode(sb, invite.code)
    expect(result.valid).toBe(false)
    expect(result.error).toBe('邀请码已过期')
  })

  it('returns valid:true when expires_at is null (never expires)', async () => {
    const invite = makeInvite({ expires_at: null })
    const sb = mockSupabase({ data: invite, error: null })

    const result = await validateInviteCode(sb, invite.code)
    expect(result.valid).toBe(true)
  })

  it('returns valid:false when max uses reached', async () => {
    const invite = makeInvite({ max_uses: 5, current_uses: 5 })
    const sb = mockSupabase({ data: invite, error: null })

    const result = await validateInviteCode(sb, invite.code)
    expect(result.valid).toBe(false)
    expect(result.error).toBe('邀请码使用次数已达上限')
  })

  it('returns valid:false when current_uses exceeds max_uses', async () => {
    // Defensive: should not happen but code handles >= check
    const invite = makeInvite({ max_uses: 3, current_uses: 10 })
    const sb = mockSupabase({ data: invite, error: null })

    const result = await validateInviteCode(sb, invite.code)
    expect(result.valid).toBe(false)
    expect(result.error).toBe('邀请码使用次数已达上限')
  })

  it('returns valid:true when current_uses < max_uses by 1', async () => {
    const invite = makeInvite({ max_uses: 10, current_uses: 9 })
    const sb = mockSupabase({ data: invite, error: null })

    const result = await validateInviteCode(sb, invite.code)
    expect(result.valid).toBe(true)
  })

  it('handles Supabase error gracefully', async () => {
    const sb = mockSupabase({
      data: null,
      error: { message: 'network error' },
    })

    const result = await validateInviteCode(sb, 'CODE')
    expect(result.valid).toBe(false)
    expect(result.error).toBe('邀请码不存在')
  })

  it('uppercases the code for lookup', async () => {
    const invite = makeInvite({ code: 'LOWER123' })
    const sb = mockSupabase({ data: invite, error: null })

    await validateInviteCode(sb, 'lower123')
    const chain = (sb.from as jest.Mock).mock.results[0].value
    expect(chain.eq).toHaveBeenCalledWith('code', 'LOWER123')
  })

  it('validates priority: inactive checked before expired', async () => {
    // Both inactive AND expired — is_active check comes first
    const invite = makeInvite({
      is_active: false,
      expires_at: new Date(Date.now() - 1000).toISOString(),
    })
    const sb = mockSupabase({ data: invite, error: null })

    const result = await validateInviteCode(sb, invite.code)
    expect(result.valid).toBe(false)
    expect(result.error).toBe('邀请码已失效') // not 已过期
  })

  it('validates priority: expired checked before maxed-out', async () => {
    const invite = makeInvite({
      expires_at: new Date(Date.now() - 1000).toISOString(),
      max_uses: 5,
      current_uses: 5,
    })
    const sb = mockSupabase({ data: invite, error: null })

    const result = await validateInviteCode(sb, invite.code)
    expect(result.valid).toBe(false)
    expect(result.error).toBe('邀请码已过期') // not 使用次数已达上限
  })
})

// ============================================
// checkUserTrialStatus
// ============================================

describe('checkUserTrialStatus', () => {
  it('returns isTrial:true for active trial', async () => {
    const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString()
    const sb = mockSupabase(undefined, {
      data: {
        tier: 'pro',
        status: 'trial',
        trial_ends_at: futureDate,
      },
      error: null,
    })

    const result = await checkUserTrialStatus(sb, 'user-1')
    expect(result.isTrial).toBe(true)
    expect(result.tier).toBe('pro')
    expect(result.expiresAt).toBe(futureDate)
    expect(result.daysRemaining).toBeGreaterThanOrEqual(4)
    expect(result.daysRemaining).toBeLessThanOrEqual(5)
  })

  it('returns isTrial:false when trial has expired', async () => {
    const pastDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()
    const sb = mockSupabase(undefined, {
      data: {
        tier: 'pro',
        status: 'trial',
        trial_ends_at: pastDate,
      },
      error: null,
    })

    const result = await checkUserTrialStatus(sb, 'user-1')
    expect(result.isTrial).toBe(false)
    expect(result.tier).toBeUndefined()
    expect(result.daysRemaining).toBeUndefined()
  })

  it('returns isTrial:false when no subscription exists', async () => {
    const sb = mockSupabase(undefined, { data: null, error: null })

    const result = await checkUserTrialStatus(sb, 'user-1')
    expect(result.isTrial).toBe(false)
  })

  it('returns isTrial:false when trial_ends_at is null', async () => {
    const sb = mockSupabase(undefined, {
      data: {
        tier: 'pro',
        status: 'trial',
        trial_ends_at: null,
      },
      error: null,
    })

    const result = await checkUserTrialStatus(sb, 'user-1')
    expect(result.isTrial).toBe(false)
  })

  it('daysRemaining rounds up (ceil)', async () => {
    // Expires in 12 hours → should show 1 day remaining
    const halfDay = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
    const sb = mockSupabase(undefined, {
      data: {
        tier: 'pro',
        status: 'trial',
        trial_ends_at: halfDay,
      },
      error: null,
    })

    const result = await checkUserTrialStatus(sb, 'user-1')
    expect(result.isTrial).toBe(true)
    expect(result.daysRemaining).toBe(1)
  })

  it('daysRemaining for exactly 7 days', async () => {
    const sevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    const sb = mockSupabase(undefined, {
      data: {
        tier: 'pro',
        status: 'trial',
        trial_ends_at: sevenDays,
      },
      error: null,
    })

    const result = await checkUserTrialStatus(sb, 'user-1')
    expect(result.isTrial).toBe(true)
    expect(result.daysRemaining).toBe(7)
  })

  it('calls supabase with correct table and filters', async () => {
    const sb = mockSupabase(undefined, { data: null, error: null })

    await checkUserTrialStatus(sb, 'user-42')

    expect(sb.from).toHaveBeenCalledWith('user_subscriptions')
    const chain = (sb.from as jest.Mock).mock.results[0].value
    expect(chain.select).toHaveBeenCalledWith('tier, status, trial_ends_at')
    expect(chain.eq).toHaveBeenCalledWith('user_id', 'user-42')
    expect(chain.eq).toHaveBeenCalledWith('status', 'trial')
    expect(chain.maybeSingle).toHaveBeenCalled()
  })
})
