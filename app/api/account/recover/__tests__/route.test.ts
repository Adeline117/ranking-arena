/** @jest-environment node */

import { createHash, createHmac } from 'node:crypto'

const mockRpc = jest.fn()
const mockUpdateUser = jest.fn()
const mockGetUser = jest.fn()
const mockFrom = jest.fn()
const mockResume = jest.fn()
const mockStop = jest.fn()
const mockDiscover = jest.fn()
const mockGetStripe = jest.fn(() => ({ test: true }))
const mockGetSupabaseAdmin = jest.fn(() => ({
  rpc: mockRpc,
  from: mockFrom,
  auth: { admin: { updateUserById: mockUpdateUser, getUserById: mockGetUser } },
}))

jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: Function) => (request: Request) => handler({ request }),
}))
jest.mock('@/lib/env', () => ({
  env: {
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-secret',
    ACCOUNT_RECOVERY_FINALIZATION_SECRET: 'current-account-recovery-finalization-secret-0001',
    ACCOUNT_RECOVERY_FINALIZATION_SECRET_PREVIOUS: undefined,
    STRIPE_SECRET_KEY: 'sk_test_recovery',
    NEXT_PUBLIC_APP_URL: 'https://www.arenafi.org',
  },
}))
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))
jest.mock('@/lib/stripe', () => ({ getStripe: () => mockGetStripe() }))
jest.mock('@/lib/stripe/account-deletion', () => ({
  B2CSubscriptionRecoveryIdentityConflictError: class extends Error {},
  B2CSubscriptionRecoveryWriteUncertainError: class extends Error {},
  recoverExactB2CSubscriptionRenewal: (...args: unknown[]) => mockResume(...args),
  stopExactFrozenB2CSubscriptionForCompensation: (...args: unknown[]) => mockStop(...args),
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { env } from '@/lib/env'
import {
  B2CSubscriptionRecoveryIdentityConflictError,
  B2CSubscriptionRecoveryWriteUncertainError,
} from '@/lib/stripe/account-deletion'
import { POST } from '../route'

const mutableEnv = env as {
  NEXT_PUBLIC_APP_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  ACCOUNT_RECOVERY_FINALIZATION_SECRET?: string
  ACCOUNT_RECOVERY_FINALIZATION_SECRET_PREVIOUS?: string
}

const TOKEN = 'A'.repeat(43)
const OPERATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const DELETION_OPERATION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const LOCATED_OPERATION = '22222222-2222-4222-8222-222222222222'
const REACQUISITION_ID = '33333333-3333-4333-8333-333333333333'
const REACQUISITION_PROOF = 'R'.repeat(43)
const CURRENT_FINALIZATION_SECRET = 'current-account-recovery-finalization-secret-0001'
const ROTATED_FINALIZATION_SECRET = 'rotated-account-recovery-finalization-secret-0002'
const SERVICE_ROLE_SECRET = 'test-service-role-secret'
const HEX_FINALIZATION_SECRET = '0123456789abcdef'.repeat(4)
const BASE64_FINALIZATION_SECRET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const CONTROL_CHARACTER_SECRET = `${'0123456789abcdef'.repeat(2).slice(0, 31)}\t`
const TARGET_DIGEST = 'b'.repeat(64)
const B2C_TARGET = {
  stripe_subscription_id: 'sub_b2c_current',
  authority_kind: 'paid',
  plan: 'monthly',
  period_start: '2027-01-15T08:00:00.000Z',
  period_end: '2027-02-15T08:00:00.000Z',
  stripe_price_id: 'price_pro_monthly',
  expected_amount: 2_000,
  currency: 'usd',
}
const ACTIVE_OBSERVATION = {
  stripe_subscription_id: 'sub_b2c_current',
  stripe_customer_id: 'cus_owner',
  livemode: false,
  status: 'active',
  cancel_at_period_end: false,
  current_period_start: 1_800_000_000,
  current_period_end: 1_802_678_400,
  stripe_price_id: 'price_pro_monthly',
  unit_amount: 2_000,
  currency: 'usd',
  quantity: 1,
  collection_method: 'charge_automatically',
  has_pause_collection: false,
  has_pending_update: false,
  has_subscription_schedule: false,
  resume_state: 'resumed',
}

function resolvedTargets(overrides: Record<string, unknown> = {}) {
  return {
    status: 'resolved',
    stripe_customer_id: 'cus_owner',
    target_digest: TARGET_DIGEST,
    b2c_target: B2C_TARGET,
    api_target_count: 0,
    retired_b2c_count: 0,
    unclassified_target_count: 0,
    ...overrides,
  }
}

function compensationTarget(overrides: Record<string, unknown> = {}) {
  return {
    status: 'compensation_billing',
    livemode: false,
    stripe_customer_id: 'cus_owner',
    target_digest: TARGET_DIGEST,
    b2c_target: B2C_TARGET,
    ...overrides,
  }
}

function completedBilling(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'completed_resumed',
    b2c_state: 'active_restored',
    lifetime_state: 'not_present',
    subscription_resumed: true,
    billing_reactivation_required: false,
    target_digest: TARGET_DIGEST,
    ...overrides,
  }
}

function overrideRpcs(overrides: Record<string, unknown>): void {
  const fallback = mockRpc.getMockImplementation()
  if (!fallback) throw new Error('missing default RPC implementation')
  mockRpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (Object.prototype.hasOwnProperty.call(overrides, name)) {
      const value = overrides[name]
      return typeof value === 'function'
        ? (value as (args: Record<string, unknown>) => unknown)(args)
        : { data: value, error: null }
    }
    return fallback(name, args)
  })
}

function request(path: string, body: Record<string, unknown>, cookie?: string): Request {
  return new Request(`https://www.arenafi.org${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://www.arenafi.org',
      'sec-fetch-site': 'same-origin',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  })
}

function queryResult(data: unknown) {
  return {
    select: jest.fn(() => ({
      eq: jest.fn(() => ({ maybeSingle: jest.fn(async () => ({ data, error: null })) })),
    })),
  }
}

function cookiePair(response: Response): string {
  const header = response.headers.get('set-cookie') ?? ''
  const match = header.match(new RegExp(`arena_recovery_${OPERATION}=[^;]+`))
  expect(header).toContain('HttpOnly')
  expect(header).toContain('SameSite=strict')
  if (!match) throw new Error('missing operation-scoped recovery cookie')
  return match[0]
}

function capabilityFromCookie(cookie: string): string {
  const encoded = cookie.slice(cookie.indexOf('=') + 1)
  const payload = JSON.parse(
    Buffer.from(decodeURIComponent(encoded), 'base64url').toString('utf8')
  ) as { c?: unknown }
  if (typeof payload.c !== 'string') throw new Error('missing finalization capability')
  return payload.c
}

function existingFinalizationCookie(capability: string): string {
  const encoded = Buffer.from(
    JSON.stringify({ v: 1, u: USER_ID, o: OPERATION, c: capability, d: null })
  ).toString('base64url')
  return `arena_recovery_${OPERATION}=${encoded}`
}

async function prepareRecoveryCookie(): Promise<string> {
  const prepared = await POST(
    request('/api/account/recover', { recovery_token: TOKEN, operation_id: OPERATION })
  )
  expect(prepared.status).toBe(202)
  return cookiePair(prepared)
}

async function commitRecovery(cookie: string): Promise<Response> {
  return POST(request('/api/account/recover?phase=commit', { operation_id: OPERATION }, cookie))
}

describe('account recovery two-phase finalization', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mutableEnv.NEXT_PUBLIC_APP_URL = 'https://www.arenafi.org'
    mutableEnv.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_SECRET
    mutableEnv.ACCOUNT_RECOVERY_FINALIZATION_SECRET = CURRENT_FINALIZATION_SECRET
    mutableEnv.ACCOUNT_RECOVERY_FINALIZATION_SECRET_PREVIOUS = undefined
    mockFrom.mockImplementation((table: string) => {
      if (table === 'account_recovery_tokens') {
        return queryResult({
          user_id: '11111111-1111-4111-8111-111111111111',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          used_at: null,
        })
      }
      if (table === 'user_profiles') {
        return queryResult({
          id: '11111111-1111-4111-8111-111111111111',
          deleted_at: null,
          stripe_customer_id: 'cus_owner',
          api_stripe_subscription_id: null,
          banned_at: null,
          is_banned: false,
          ban_expires_at: null,
          deletion_scheduled_at: null,
        })
      }
      if (table === 'subscriptions') {
        return {
          ...queryResult(null),
          select: jest.fn(() => ({
            eq: jest.fn(() => ({
              in: jest.fn(() => ({
                limit: jest.fn(() => ({
                  maybeSingle: jest.fn(async () => ({ data: null, error: null })),
                })),
              })),
            })),
          })),
        }
      }
      throw new Error(`unexpected table ${table}`)
    })
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'locate_account_recovery_capability_reacquisition_atomic') {
        return { data: { status: 'absent' }, error: null }
      }
      if (name === 'status_account_recovery_capability_reacquisition_atomic') {
        return { data: { status: 'available' }, error: null }
      }
      if (name === 'attest_account_recovery_capability_reacquisition_atomic') {
        return { data: { status: 'invalid' }, error: null }
      }
      const ack: Record<string, string> = {
        claim_account_recovery_with_deletion_fence_atomic: 'claimed',
        prepare_account_recovery_auth_finalization_atomic: 'prepared',
        finish_account_recovery_with_auth_finalization_atomic: 'finished',
        claim_account_recovery_auth_finalization_atomic: 'claimed',
        finalize_account_recovery_auth_atomic: 'finalized',
        arm_account_recovery_billing_atomic: 'armed',
      }
      if (name === 'resolve_account_recovery_billing_targets_v2_atomic') {
        return {
          data: {
            status: 'resolved',
            stripe_customer_id: 'cus_owner',
            target_digest: 'a'.repeat(64),
            b2c_target: null,
            api_target_count: 0,
            retired_b2c_count: 0,
            unclassified_target_count: 0,
          },
          error: null,
        }
      }
      if (name === 'complete_account_recovery_billing_v2_atomic') {
        return {
          data: {
            status: 'completed_resumed',
            b2c_state: 'no_b2c_target',
            lifetime_state: 'not_present',
            subscription_resumed: true,
            billing_reactivation_required: false,
            target_digest: 'a'.repeat(64),
          },
          error: null,
        }
      }
      return { data: ack[name] ?? 'invalid', error: null }
    })
    mockUpdateUser.mockResolvedValue({ error: null })
    mockGetUser.mockResolvedValue({ data: { user: { banned_until: null } }, error: null })
    mockDiscover.mockResolvedValue({ customerId: 'cus_owner', observedSubscriptionIds: [] })
    mockResume.mockResolvedValue({
      customerId: 'cus_owner',
      changedSubscriptionIds: [],
      terminalMarkedSubscriptionIds: [],
    })
    mockStop.mockResolvedValue({
      status: 'terminal',
      subscriptionId: 'sub_b2c_current',
    })
  })

  it('prepares without unbanning, then commits only with its exact cookie', async () => {
    const prepared = await POST(
      request('/api/account/recover', { recovery_token: TOKEN, operation_id: OPERATION })
    )
    expect(prepared.status).toBe(202)
    expect(mockUpdateUser).not.toHaveBeenCalled()
    const cookie = cookiePair(prepared)

    const committed = await POST(
      request('/api/account/recover?phase=commit', { operation_id: OPERATION }, cookie)
    )
    expect(committed.status).toBe(200)
    expect(await committed.json()).toMatchObject({ success: true, subscription_resumed: true })
    expect(mockUpdateUser).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', {
      ban_duration: 'none',
    })
    expect(mockRpc).toHaveBeenCalledWith('arm_account_recovery_billing_atomic', expect.any(Object))
  })

  it('locates an unfinished operation before rejecting its already-used recovery token', async () => {
    mutableEnv.ACCOUNT_RECOVERY_FINALIZATION_SECRET_PREVIOUS = ROTATED_FINALIZATION_SECRET
    overrideRpcs({
      locate_account_recovery_capability_reacquisition_atomic: {
        status: 'located',
        user_id: USER_ID,
        operation_id: LOCATED_OPERATION,
        reacquisition_id: REACQUISITION_ID,
        reacquisition_proof: REACQUISITION_PROOF,
      },
      attest_account_recovery_capability_reacquisition_atomic: {
        status: 'reacquired',
        user_id: USER_ID,
        operation_id: LOCATED_OPERATION,
        candidate_index: 1,
        auth_finalization_state: 'pending',
      },
    })

    const response = await POST(
      request('/api/account/recover', { recovery_token: TOKEN, operation_id: OPERATION })
    )

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      status: 'prepared',
      operation_id: LOCATED_OPERATION,
    })
    expect(response.headers.get('set-cookie')).toContain(`arena_recovery_${LOCATED_OPERATION}=`)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc.mock.calls.slice(0, 2).map(([name]) => name)).toEqual([
      'locate_account_recovery_capability_reacquisition_atomic',
      'attest_account_recovery_capability_reacquisition_atomic',
    ])
  })

  it('derives fallback availability only from the exact status RPC acknowledgement', async () => {
    const fallbackCookie = `arena_account_recovery_${DELETION_OPERATION}=${TOKEN}`
    overrideRpcs({
      status_account_recovery_capability_reacquisition_atomic: { status: 'unavailable' },
    })

    const response = await POST(
      request('/api/account/recover?phase=fallback-status', {}, fallbackCookie)
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ available: false, operations: [] })
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledWith(
      'status_account_recovery_capability_reacquisition_atomic',
      {
        p_operation_id: DELETION_OPERATION,
        p_recovery_token_hash: createHash('sha256').update(TOKEN).digest('hex'),
      }
    )
    expect(response.headers.get('set-cookie')).toContain(
      `arena_account_recovery_${DELETION_OPERATION}=;`
    )
  })

  it('binds a fallback cookie to the deletion operation but returns the located recovery operation', async () => {
    const fallbackCookie = `arena_account_recovery_${DELETION_OPERATION}=${TOKEN}`
    overrideRpcs({
      locate_account_recovery_capability_reacquisition_atomic: {
        status: 'located',
        user_id: USER_ID,
        operation_id: LOCATED_OPERATION,
        reacquisition_id: REACQUISITION_ID,
        reacquisition_proof: REACQUISITION_PROOF,
      },
      attest_account_recovery_capability_reacquisition_atomic: {
        status: 'reacquired',
        user_id: USER_ID,
        operation_id: LOCATED_OPERATION,
        candidate_index: 0,
        auth_finalization_state: 'prepared',
      },
    })

    const response = await POST(
      request(
        '/api/account/recover',
        {
          recovery_cookie: true,
          recovery_cookie_operation_id: DELETION_OPERATION,
          operation_id: OPERATION,
        },
        fallbackCookie
      )
    )

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      status: 'prepared',
      operation_id: LOCATED_OPERATION,
    })
    const serialized = response.headers
      .get('set-cookie')
      ?.match(new RegExp(`arena_recovery_${LOCATED_OPERATION}=([^;]+)`))?.[1]
    expect(serialized).toBeDefined()
    const capability = JSON.parse(
      Buffer.from(decodeURIComponent(serialized!), 'base64url').toString('utf8')
    ) as Record<string, unknown>
    expect(capability).toMatchObject({ o: LOCATED_OPERATION, d: DELETION_OPERATION })
  })

  it('derives newly prepared capabilities only from the dedicated v2 secret', async () => {
    const capability = capabilityFromCookie(await prepareRecoveryCookie())

    expect(capability).toBe(
      createHmac('sha256', CURRENT_FINALIZATION_SECRET)
        .update(`account-recovery-finalization:v2:${USER_ID}:${OPERATION}`)
        .digest('base64url')
    )
    expect(capability).not.toBe(
      createHmac('sha256', SERVICE_ROLE_SECRET)
        .update(`account-recovery-finalization:v1:${USER_ID}:${OPERATION}`)
        .digest('base64url')
    )
  })

  it('does not change a newly prepared capability when the service-role key changes', async () => {
    const before = capabilityFromCookie(await prepareRecoveryCookie())
    mutableEnv.SUPABASE_SERVICE_ROLE_KEY = 'rotated-service-role-secret'
    const after = capabilityFromCookie(await prepareRecoveryCookie())

    expect(after).toBe(before)
  })

  it('changes a newly prepared capability when the dedicated current secret changes', async () => {
    const before = capabilityFromCookie(await prepareRecoveryCookie())
    mutableEnv.ACCOUNT_RECOVERY_FINALIZATION_SECRET = ROTATED_FINALIZATION_SECRET
    const after = capabilityFromCookie(await prepareRecoveryCookie())

    expect(after).not.toBe(before)
    expect(after).toBe(
      createHmac('sha256', ROTATED_FINALIZATION_SECRET)
        .update(`account-recovery-finalization:v2:${USER_ID}:${OPERATION}`)
        .digest('base64url')
    )
  })

  it.each([
    ['hex', HEX_FINALIZATION_SECRET, BASE64_FINALIZATION_SECRET],
    ['base64', BASE64_FINALIZATION_SECRET, HEX_FINALIZATION_SECRET],
  ])(
    'accepts distinct strong %s secrets while issuing with current only',
    async (_, current, previous) => {
      mutableEnv.ACCOUNT_RECOVERY_FINALIZATION_SECRET = current
      mutableEnv.ACCOUNT_RECOVERY_FINALIZATION_SECRET_PREVIOUS = previous

      const capability = capabilityFromCookie(await prepareRecoveryCookie())

      expect(capability).toBe(
        createHmac('sha256', current)
          .update(`account-recovery-finalization:v2:${USER_ID}:${OPERATION}`)
          .digest('base64url')
      )
    }
  )

  it.each([
    {
      case: 'missing current',
      current: undefined,
      previous: undefined,
      serviceRole: SERVICE_ROLE_SECRET,
    },
    {
      case: 'short current',
      current: 'x'.repeat(31),
      previous: undefined,
      serviceRole: SERVICE_ROLE_SECRET,
    },
    {
      case: 'overlong current',
      current: '0123456789abcdef'.repeat(257).slice(0, 4_097),
      previous: undefined,
      serviceRole: SERVICE_ROLE_SECRET,
    },
    {
      case: '32 spaces as current',
      current: ' '.repeat(32),
      previous: undefined,
      serviceRole: SERVICE_ROLE_SECRET,
    },
    {
      case: 'trailing whitespace in current',
      current: `${HEX_FINALIZATION_SECRET} `,
      previous: undefined,
      serviceRole: SERVICE_ROLE_SECRET,
    },
    {
      case: 'control character in current',
      current: CONTROL_CHARACTER_SECRET,
      previous: undefined,
      serviceRole: SERVICE_ROLE_SECRET,
    },
    {
      case: 'terminal newline in current',
      current: `${HEX_FINALIZATION_SECRET}\n`,
      previous: undefined,
      serviceRole: SERVICE_ROLE_SECRET,
    },
    {
      case: 'non-ASCII current',
      current: `${'0123456789abcdef'.repeat(2).slice(0, 31)}é`,
      previous: undefined,
      serviceRole: SERVICE_ROLE_SECRET,
    },
    {
      case: '32 repeated characters as current',
      current: 'x'.repeat(32),
      previous: undefined,
      serviceRole: SERVICE_ROLE_SECRET,
    },
    {
      case: 'short previous',
      current: CURRENT_FINALIZATION_SECRET,
      previous: 'x'.repeat(31),
      serviceRole: SERVICE_ROLE_SECRET,
    },
    {
      case: '32 spaces as previous',
      current: CURRENT_FINALIZATION_SECRET,
      previous: ' '.repeat(32),
      serviceRole: SERVICE_ROLE_SECRET,
    },
    {
      case: 'leading whitespace in previous',
      current: CURRENT_FINALIZATION_SECRET,
      previous: ` ${HEX_FINALIZATION_SECRET}`,
      serviceRole: SERVICE_ROLE_SECRET,
    },
    {
      case: 'control character in previous',
      current: CURRENT_FINALIZATION_SECRET,
      previous: CONTROL_CHARACTER_SECRET,
      serviceRole: SERVICE_ROLE_SECRET,
    },
    {
      case: '32 repeated characters as previous',
      current: CURRENT_FINALIZATION_SECRET,
      previous: 'x'.repeat(32),
      serviceRole: SERVICE_ROLE_SECRET,
    },
    {
      case: 'reused current as previous',
      current: CURRENT_FINALIZATION_SECRET,
      previous: CURRENT_FINALIZATION_SECRET,
      serviceRole: SERVICE_ROLE_SECRET,
    },
    {
      case: 'current reused as service-role key',
      current: HEX_FINALIZATION_SECRET,
      previous: undefined,
      serviceRole: HEX_FINALIZATION_SECRET,
    },
    {
      case: 'previous reused as service-role key',
      current: BASE64_FINALIZATION_SECRET,
      previous: HEX_FINALIZATION_SECRET,
      serviceRole: HEX_FINALIZATION_SECRET,
    },
  ])(
    'fails prepare closed with $case before any recovery side effect',
    async ({ current, previous, serviceRole }) => {
      mutableEnv.ACCOUNT_RECOVERY_FINALIZATION_SECRET = current
      mutableEnv.ACCOUNT_RECOVERY_FINALIZATION_SECRET_PREVIOUS = previous
      mutableEnv.SUPABASE_SERVICE_ROLE_KEY = serviceRole

      const response = await POST(
        request('/api/account/recover', { recovery_token: TOKEN, operation_id: OPERATION })
      )

      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
      expect(mockFrom).not.toHaveBeenCalled()
      expect(mockRpc).not.toHaveBeenCalled()
      expect(mockUpdateUser).not.toHaveBeenCalled()
      expect(mockGetUser).not.toHaveBeenCalled()
      expect(mockGetStripe).not.toHaveBeenCalled()
      expect(mockResume).not.toHaveBeenCalled()
      expect(mockStop).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['missing current', undefined, 'x'.repeat(32)],
    ['weak current', 'x'.repeat(32), CONTROL_CHARACTER_SECRET],
  ])(
    'commits an existing v1 cookie with %s and invalid previous without reading new HMAC keys',
    async (_, current, previous) => {
      const legacyCapability = createHmac('sha256', SERVICE_ROLE_SECRET)
        .update(`account-recovery-finalization:v1:${USER_ID}:${OPERATION}`)
        .digest('base64url')
      const legacyCapabilityHash = createHash('sha256').update(legacyCapability).digest('hex')
      mutableEnv.SUPABASE_SERVICE_ROLE_KEY = 'rotated-service-role-secret'
      mutableEnv.ACCOUNT_RECOVERY_FINALIZATION_SECRET = current
      mutableEnv.ACCOUNT_RECOVERY_FINALIZATION_SECRET_PREVIOUS = previous

      const response = await commitRecovery(existingFinalizationCookie(legacyCapability))

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ success: true })
      expect(mockRpc).toHaveBeenCalledWith(
        'finish_account_recovery_with_auth_finalization_atomic',
        {
          p_user_id: USER_ID,
          p_operation_id: OPERATION,
          p_capability_hash: legacyCapabilityHash,
        }
      )
    }
  )

  it('fails commit closed when the operation cookie is absent', async () => {
    const response = await POST(
      request('/api/account/recover?phase=commit', { operation_id: OPERATION })
    )
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'capability_missing' })
    expect(mockUpdateUser).not.toHaveBeenCalled()
  })

  it('rejects a Host-self-consistent origin outside the canonical app origin', async () => {
    const prepared = await POST(
      request('/api/account/recover', { recovery_token: TOKEN, operation_id: OPERATION })
    )
    const response = await POST(
      new Request('https://attacker.example/api/account/recover?phase=commit', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://attacker.example',
          'sec-fetch-site': 'same-origin',
          cookie: cookiePair(prepared),
        },
        body: JSON.stringify({ operation_id: OPERATION }),
      })
    )

    expect(response.status).toBe(409)
    expect(mockUpdateUser).not.toHaveBeenCalled()
    expect(mockResume).not.toHaveBeenCalled()
  })

  it('fails closed when the configured canonical origin is not HTTPS', async () => {
    const prepared = await POST(
      request('/api/account/recover', { recovery_token: TOKEN, operation_id: OPERATION })
    )
    mutableEnv.NEXT_PUBLIC_APP_URL = 'http://www.arenafi.org'

    const response = await POST(
      request(
        '/api/account/recover?phase=commit',
        { operation_id: OPERATION },
        cookiePair(prepared)
      )
    )

    expect(response.status).toBe(409)
    expect(mockUpdateUser).not.toHaveBeenCalled()
    expect(mockResume).not.toHaveBeenCalled()
  })

  it('rejects an expired durable capability before Auth or billing side effects', async () => {
    const prepared = await POST(
      request('/api/account/recover', { recovery_token: TOKEN, operation_id: OPERATION })
    )
    mockRpc.mockImplementation(async (name: string) =>
      name === 'finish_account_recovery_with_auth_finalization_atomic'
        ? { data: 'invalid', error: null }
        : { data: 'invalid', error: null }
    )
    const response = await POST(
      request(
        '/api/account/recover?phase=commit',
        { operation_id: OPERATION },
        cookiePair(prepared)
      )
    )
    expect(response.status).toBe(410)
    expect(mockUpdateUser).not.toHaveBeenCalled()
    expect(mockResume).not.toHaveBeenCalled()
    expect(mockStop).not.toHaveBeenCalled()
  })

  it('does not finalize an Auth unban with a malformed fresh ban timestamp', async () => {
    const prepared = await POST(
      request('/api/account/recover', { recovery_token: TOKEN, operation_id: OPERATION })
    )
    mockGetUser.mockResolvedValue({
      data: { user: { banned_until: 'not-a-date' } },
      error: null,
    })
    const response = await POST(
      request(
        '/api/account/recover?phase=commit',
        { operation_id: OPERATION },
        cookiePair(prepared)
      )
    )
    expect(response.status).toBe(503)
    expect(
      mockRpc.mock.calls.some(([name]) => name === 'finalize_account_recovery_auth_atomic')
    ).toBe(false)
    expect(mockResume).not.toHaveBeenCalled()
  })

  it('re-bans and completes an Auth-only compensation without reading or stopping billing', async () => {
    const prepared = await POST(
      request('/api/account/recover', { recovery_token: TOKEN, operation_id: OPERATION })
    )
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'finish_account_recovery_with_auth_finalization_atomic')
        return { data: 'finished', error: null }
      if (name === 'claim_account_recovery_auth_finalization_atomic')
        return { data: 'compensation_auth_only', error: null }
      if (name === 'resolve_account_recovery_compensation_scope_atomic')
        return { data: 'auth_only', error: null }
      if (name === 'complete_account_recovery_auth_compensation_atomic')
        return { data: 'compensated', error: null }
      return { data: 'invalid', error: null }
    })
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          banned_until: new Date(Date.now() + 100 * 365 * 24 * 60 * 60_000).toISOString(),
        },
      },
      error: null,
    })
    const response = await POST(
      request(
        '/api/account/recover?phase=commit',
        { operation_id: OPERATION },
        cookiePair(prepared)
      )
    )
    expect(response.status).toBe(503)
    expect(mockStop).not.toHaveBeenCalled()
    expect(mockUpdateUser).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', {
      ban_duration: '876000h',
    })
    expect(
      mockRpc.mock.calls.some(
        ([name]) => name === 'read_account_recovery_billing_compensation_target_v2_atomic'
      )
    ).toBe(false)
    expect(
      mockRpc.mock.calls.some(
        ([name]) => name === 'complete_account_recovery_auth_compensation_atomic'
      )
    ).toBe(true)
  })

  it('replays billing compensation from the durable exact target and re-bans before Stripe', async () => {
    const prepared = await POST(
      request('/api/account/recover', { recovery_token: TOKEN, operation_id: OPERATION })
    )
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'finish_account_recovery_with_auth_finalization_atomic')
        return { data: 'finished', error: null }
      if (name === 'claim_account_recovery_auth_finalization_atomic')
        return { data: 'compensation_billing', error: null }
      if (name === 'resolve_account_recovery_compensation_scope_atomic')
        return { data: 'billing_stop_required', error: null }
      if (name === 'read_account_recovery_billing_compensation_target_v2_atomic')
        return { data: compensationTarget(), error: null }
      if (name === 'complete_account_recovery_auth_compensation_atomic')
        return { data: 'compensated', error: null }
      return { data: 'invalid', error: null }
    })
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          banned_until: new Date(Date.now() + 100 * 365 * 24 * 60 * 60_000).toISOString(),
        },
      },
      error: null,
    })

    const response = await POST(
      request(
        '/api/account/recover?phase=commit',
        { operation_id: OPERATION },
        cookiePair(prepared)
      )
    )

    expect(response.status).toBe(503)
    expect(mockStop).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub_b2c_current',
        customerId: 'cus_owner',
        expectedUserId: USER_ID,
        livemode: false,
      })
    )
    const completeCall = mockRpc.mock.calls.findIndex(
      ([name]) => name === 'complete_account_recovery_auth_compensation_atomic'
    )
    const targetReadCall = mockRpc.mock.calls.findIndex(
      ([name]) => name === 'read_account_recovery_billing_compensation_target_v2_atomic'
    )
    expect(mockRpc.mock.invocationCallOrder[targetReadCall]).toBeLessThan(
      mockUpdateUser.mock.invocationCallOrder[0]
    )
    expect(mockUpdateUser.mock.invocationCallOrder[0]).toBeLessThan(
      mockStop.mock.invocationCallOrder[0]
    )
    expect(mockStop.mock.invocationCallOrder[0]).toBeLessThan(
      mockRpc.mock.invocationCallOrder[completeCall]
    )
  })

  it('completes billing compensation when the exact frozen Subscription is already missing', async () => {
    const prepared = await prepareRecoveryCookie()
    overrideRpcs({
      claim_account_recovery_auth_finalization_atomic: 'compensation_billing',
      resolve_account_recovery_compensation_scope_atomic: 'billing_stop_required',
      read_account_recovery_billing_compensation_target_v2_atomic: compensationTarget(),
      complete_account_recovery_auth_compensation_atomic: 'compensated',
    })
    mockStop.mockResolvedValue({
      status: 'missing',
      subscriptionId: 'sub_b2c_current',
    })
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          banned_until: new Date(Date.now() + 100 * 365 * 24 * 60 * 60_000).toISOString(),
        },
      },
      error: null,
    })

    const response = await commitRecovery(prepared)

    expect(response.status).toBe(503)
    expect(mockStop).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub_b2c_current',
        customerId: 'cus_owner',
        expectedUserId: USER_ID,
      })
    )
    expect(
      mockRpc.mock.calls.some(
        ([name]) => name === 'complete_account_recovery_auth_compensation_atomic'
      )
    ).toBe(true)
  })

  it('treats a durable null B2C compensation target as an explicit zero-write result', async () => {
    const prepared = await POST(
      request('/api/account/recover', { recovery_token: TOKEN, operation_id: OPERATION })
    )
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'finish_account_recovery_with_auth_finalization_atomic')
        return { data: 'finished', error: null }
      if (name === 'claim_account_recovery_auth_finalization_atomic')
        return { data: 'compensation_billing', error: null }
      if (name === 'resolve_account_recovery_compensation_scope_atomic')
        return { data: 'billing_stop_required', error: null }
      if (name === 'read_account_recovery_billing_compensation_target_v2_atomic')
        return {
          data: compensationTarget({ stripe_customer_id: null, b2c_target: null }),
          error: null,
        }
      if (name === 'complete_account_recovery_auth_compensation_atomic')
        return { data: 'compensated', error: null }
      return { data: 'invalid', error: null }
    })
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          banned_until: new Date(Date.now() + 100 * 365 * 24 * 60 * 60_000).toISOString(),
        },
      },
      error: null,
    })

    const response = await commitRecovery(cookiePair(prepared))

    expect(response.status).toBe(503)
    expect(mockStop).not.toHaveBeenCalled()
    expect(mockUpdateUser).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', {
      ban_duration: '876000h',
    })
    const targetReadCall = mockRpc.mock.calls.findIndex(
      ([name]) => name === 'read_account_recovery_billing_compensation_target_v2_atomic'
    )
    expect(mockRpc.mock.invocationCallOrder[targetReadCall]).toBeLessThan(
      mockUpdateUser.mock.invocationCallOrder[0]
    )
    expect(
      mockRpc.mock.calls.some(
        ([name]) => name === 'complete_account_recovery_auth_compensation_atomic'
      )
    ).toBe(true)
  })

  it.each([
    [
      'a non-null target without a Customer',
      { data: compensationTarget({ stripe_customer_id: null }), error: null },
    ],
    [
      'an unexpected acknowledgement key',
      { data: { ...compensationTarget(), unexpected: true }, error: null },
    ],
    ['a target RPC failure', { data: null, error: { message: 'database unavailable' } }],
  ])('re-bans but performs no Stripe mutation for %s', async (_label, targetResult) => {
    const prepared = await prepareRecoveryCookie()
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'finish_account_recovery_with_auth_finalization_atomic')
        return { data: 'finished', error: null }
      if (name === 'claim_account_recovery_auth_finalization_atomic')
        return { data: 'compensation_billing', error: null }
      if (name === 'resolve_account_recovery_compensation_scope_atomic')
        return { data: 'billing_stop_required', error: null }
      if (name === 'read_account_recovery_billing_compensation_target_v2_atomic')
        return targetResult
      return { data: 'invalid', error: null }
    })
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          banned_until: new Date(Date.now() + 100 * 365 * 24 * 60 * 60_000).toISOString(),
        },
      },
      error: null,
    })

    const response = await commitRecovery(prepared)

    expect(response.status).toBe(503)
    expect(mockUpdateUser).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', {
      ban_duration: '876000h',
    })
    const targetReadCall = mockRpc.mock.calls.findIndex(
      ([name]) => name === 'read_account_recovery_billing_compensation_target_v2_atomic'
    )
    expect(mockRpc.mock.invocationCallOrder[targetReadCall]).toBeLessThan(
      mockUpdateUser.mock.invocationCallOrder[0]
    )
    expect(mockStop).not.toHaveBeenCalled()
    expect(
      mockRpc.mock.calls.some(
        ([name]) => name === 'complete_account_recovery_auth_compensation_atomic'
      )
    ).toBe(false)
  })

  it('keeps Auth banned and billing pending when the frozen Stripe mode differs', async () => {
    const prepared = await prepareRecoveryCookie()
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'finish_account_recovery_with_auth_finalization_atomic')
        return { data: 'finished', error: null }
      if (name === 'claim_account_recovery_auth_finalization_atomic')
        return { data: 'compensation_billing', error: null }
      if (name === 'resolve_account_recovery_compensation_scope_atomic')
        return { data: 'billing_stop_required', error: null }
      if (name === 'read_account_recovery_billing_compensation_target_v2_atomic')
        return { data: compensationTarget({ livemode: true }), error: null }
      if (name === 'complete_account_recovery_auth_compensation_atomic')
        return { data: 'compensated', error: null }
      return { data: 'invalid', error: null }
    })
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          banned_until: new Date(Date.now() + 100 * 365 * 24 * 60 * 60_000).toISOString(),
        },
      },
      error: null,
    })

    const response = await commitRecovery(prepared)

    expect(response.status).toBe(503)
    expect(mockUpdateUser).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', {
      ban_duration: '876000h',
    })
    const targetReadCall = mockRpc.mock.calls.findIndex(
      ([name]) => name === 'read_account_recovery_billing_compensation_target_v2_atomic'
    )
    expect(mockRpc.mock.invocationCallOrder[targetReadCall]).toBeLessThan(
      mockUpdateUser.mock.invocationCallOrder[0]
    )
    expect(mockStop).not.toHaveBeenCalled()
    expect(
      mockRpc.mock.calls.some(
        ([name]) => name === 'complete_account_recovery_auth_compensation_atomic'
      )
    ).toBe(false)
  })

  it.each([
    'Customer missing while the exact Subscription still exists',
    'wrong exact Subscription mode',
    'wrong exact Subscription owner',
  ])('keeps Auth banned and does not complete for %s', async (reason) => {
    const prepared = await prepareRecoveryCookie()
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'finish_account_recovery_with_auth_finalization_atomic')
        return { data: 'finished', error: null }
      if (name === 'claim_account_recovery_auth_finalization_atomic')
        return { data: 'compensation_billing', error: null }
      if (name === 'resolve_account_recovery_compensation_scope_atomic')
        return { data: 'billing_stop_required', error: null }
      if (name === 'read_account_recovery_billing_compensation_target_v2_atomic')
        return { data: compensationTarget(), error: null }
      if (name === 'complete_account_recovery_auth_compensation_atomic')
        return { data: 'compensated', error: null }
      return { data: 'invalid', error: null }
    })
    mockGetUser.mockResolvedValue({
      data: {
        user: {
          banned_until: new Date(Date.now() + 100 * 365 * 24 * 60 * 60_000).toISOString(),
        },
      },
      error: null,
    })
    mockStop.mockRejectedValue(new Error(reason))

    const response = await commitRecovery(prepared)

    expect(response.status).toBe(503)
    const targetReadCall = mockRpc.mock.calls.findIndex(
      ([name]) => name === 'read_account_recovery_billing_compensation_target_v2_atomic'
    )
    expect(mockRpc.mock.invocationCallOrder[targetReadCall]).toBeLessThan(
      mockUpdateUser.mock.invocationCallOrder[0]
    )
    expect(mockUpdateUser.mock.invocationCallOrder[0]).toBeLessThan(
      mockStop.mock.invocationCallOrder[0]
    )
    expect(
      mockRpc.mock.calls.some(
        ([name]) => name === 'complete_account_recovery_auth_compensation_atomic'
      )
    ).toBe(false)
  })

  it('does not compensate Auth or billing when the durable scope has expired', async () => {
    const prepared = await POST(
      request('/api/account/recover', { recovery_token: TOKEN, operation_id: OPERATION })
    )
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'finish_account_recovery_with_auth_finalization_atomic')
        return { data: 'finished', error: null }
      if (name === 'claim_account_recovery_auth_finalization_atomic')
        return { data: 'compensation_billing', error: null }
      if (name === 'resolve_account_recovery_compensation_scope_atomic')
        return { data: 'invalid', error: null }
      return { data: 'invalid', error: null }
    })

    const response = await POST(
      request(
        '/api/account/recover?phase=commit',
        { operation_id: OPERATION },
        cookiePair(prepared)
      )
    )

    expect(response.status).toBe(503)
    expect(mockStop).not.toHaveBeenCalled()
    expect(mockUpdateUser).not.toHaveBeenCalled()
  })

  it('retrieves and resumes only the frozen B2C target with the exact billing contract', async () => {
    overrideRpcs({
      resolve_account_recovery_billing_targets_v2_atomic: resolvedTargets(),
      complete_account_recovery_billing_v2_atomic: completedBilling(),
    })
    mockResume.mockResolvedValue(ACTIVE_OBSERVATION)

    const response = await commitRecovery(await prepareRecoveryCookie())

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      subscription_resumed: true,
      billing_reactivation_required: false,
    })
    expect(mockResume).toHaveBeenCalledWith({
      stripeClient: { test: true },
      subscriptionId: 'sub_b2c_current',
      expectedCustomerId: 'cus_owner',
      expectedUserId: '11111111-1111-4111-8111-111111111111',
      livemode: false,
      authorityKind: 'paid',
      plan: 'monthly',
      periodStart: 1_800_000_000,
      periodEnd: 1_802_678_400,
      priceId: 'price_pro_monthly',
      expectedAmount: 2_000,
      currency: 'usd',
      pauseMarker: '11111111-1111-4111-8111-111111111111',
    })
    expect(mockRpc).toHaveBeenCalledWith(
      'complete_account_recovery_billing_v2_atomic',
      expect.objectContaining({
        p_target_digest: TARGET_DIGEST,
        p_b2c_observation: ACTIVE_OBSERVATION,
      })
    )
    expect(mockDiscover).not.toHaveBeenCalled()
  })

  it('does not hide a retired API subscription behind a restored B2C subscription', async () => {
    overrideRpcs({
      resolve_account_recovery_billing_targets_v2_atomic: resolvedTargets({
        api_target_count: 1,
      }),
      complete_account_recovery_billing_v2_atomic: completedBilling({
        status: 'completed_manual',
        subscription_resumed: false,
        billing_reactivation_required: true,
      }),
    })
    mockResume.mockResolvedValue(ACTIVE_OBSERVATION)

    const response = await commitRecovery(await prepareRecoveryCookie())
    expect(await response.json()).toMatchObject({
      subscription_resumed: false,
      billing_reactivation_required: true,
    })
  })

  it('keeps lifetime access independent while reporting terminal B2C billing', async () => {
    const terminalObservation = {
      ...ACTIVE_OBSERVATION,
      status: 'canceled',
      resume_state: 'ineligible',
    }
    overrideRpcs({
      resolve_account_recovery_billing_targets_v2_atomic: resolvedTargets(),
      complete_account_recovery_billing_v2_atomic: completedBilling({
        status: 'completed_manual',
        b2c_state: 'retired_nonentitling',
        lifetime_state: 'restored',
        subscription_resumed: false,
        billing_reactivation_required: true,
      }),
    })
    mockResume.mockResolvedValue(terminalObservation)

    const response = await commitRecovery(await prepareRecoveryCookie())
    expect(await response.json()).toMatchObject({
      subscription_resumed: false,
      billing_reactivation_required: true,
    })
    expect(mockRpc).toHaveBeenCalledWith(
      'complete_account_recovery_billing_v2_atomic',
      expect.objectContaining({ p_b2c_observation: terminalObservation })
    )
  })

  it('keeps an exact existing retry grace distinct from a resumed subscription', async () => {
    const pastDueObservation = {
      ...ACTIVE_OBSERVATION,
      status: 'past_due',
      cancel_at_period_end: true,
      resume_state: 'ineligible',
    }
    overrideRpcs({
      resolve_account_recovery_billing_targets_v2_atomic: resolvedTargets(),
      complete_account_recovery_billing_v2_atomic: completedBilling({
        status: 'completed_manual',
        b2c_state: 'grace_restored',
        subscription_resumed: false,
        billing_reactivation_required: true,
      }),
    })
    mockResume.mockResolvedValue(pastDueObservation)

    const response = await commitRecovery(await prepareRecoveryCookie())
    expect(await response.json()).toMatchObject({
      subscription_resumed: false,
      billing_reactivation_required: true,
    })
    expect(mockRpc).toHaveBeenCalledWith(
      'complete_account_recovery_billing_v2_atomic',
      expect.objectContaining({ p_b2c_observation: pastDueObservation })
    )
  })

  it.each([
    [
      'no billing',
      resolvedTargets({ stripe_customer_id: null, b2c_target: null }),
      completedBilling({
        b2c_state: 'no_b2c_target',
        target_digest: TARGET_DIGEST,
      }),
      true,
      false,
    ],
    [
      'pure lifetime',
      resolvedTargets({ b2c_target: null }),
      completedBilling({
        b2c_state: 'no_b2c_target',
        lifetime_state: 'restored',
      }),
      true,
      false,
    ],
    [
      'API only',
      resolvedTargets({ b2c_target: null, api_target_count: 1 }),
      completedBilling({
        status: 'completed_manual',
        b2c_state: 'no_b2c_target',
        subscription_resumed: false,
        billing_reactivation_required: true,
      }),
      false,
      true,
    ],
  ])(
    'derives UX from the product result for %s',
    async (_label, targets, completion, resumed, reactivation) => {
      overrideRpcs({
        resolve_account_recovery_billing_targets_v2_atomic: targets,
        complete_account_recovery_billing_v2_atomic: completion,
      })
      const response = await commitRecovery(await prepareRecoveryCookie())
      expect(await response.json()).toMatchObject({
        subscription_resumed: resumed,
        billing_reactivation_required: reactivation,
      })
      expect(mockResume).not.toHaveBeenCalled()
    }
  )

  it('sends unknown or conflicting target sets directly to durable manual review', async () => {
    overrideRpcs({
      resolve_account_recovery_billing_targets_v2_atomic: resolvedTargets({
        status: 'manual_review',
        b2c_target: null,
        unclassified_target_count: 1,
      }),
      complete_account_recovery_billing_v2_atomic: completedBilling({
        status: 'completed_manual',
        b2c_state: 'manual_review',
        subscription_resumed: false,
        billing_reactivation_required: true,
      }),
    })

    const response = await commitRecovery(await prepareRecoveryCookie())
    expect(response.status).toBe(200)
    expect(mockResume).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledWith(
      'complete_account_recovery_billing_v2_atomic',
      expect.objectContaining({ p_b2c_observation: null })
    )
  })

  it('fails closed on a malformed frozen target before Stripe access', async () => {
    overrideRpcs({
      resolve_account_recovery_billing_targets_v2_atomic: resolvedTargets({
        b2c_target: { ...B2C_TARGET, unexpected: true },
      }),
    })
    const response = await commitRecovery(await prepareRecoveryCookie())
    expect(response.status).toBe(503)
    expect(mockResume).not.toHaveBeenCalled()
    expect(
      mockRpc.mock.calls.some(([name]) => name === 'complete_account_recovery_billing_v2_atomic')
    ).toBe(false)
  })

  it.each(['wrong Customer owner', 'wrong Customer mode'])(
    'completes deterministic pre-write identity drift as manual without compensation: %s',
    async (reason) => {
      overrideRpcs({
        resolve_account_recovery_billing_targets_v2_atomic: resolvedTargets(),
        complete_account_recovery_billing_v2_atomic: completedBilling({
          status: 'completed_manual',
          b2c_state: 'identity_conflict',
          subscription_resumed: false,
          billing_reactivation_required: true,
        }),
      })
      mockResume.mockRejectedValue(new B2CSubscriptionRecoveryIdentityConflictError(reason))

      const response = await commitRecovery(await prepareRecoveryCookie())
      expect(response.status).toBe(200)
      expect(mockStop).not.toHaveBeenCalled()
      expect(mockRpc).toHaveBeenCalledWith(
        'complete_account_recovery_billing_v2_atomic',
        expect.objectContaining({ p_b2c_observation: null })
      )
    }
  )

  it('leaves a pre-write Stripe transport failure retryable without compensation', async () => {
    overrideRpcs({ resolve_account_recovery_billing_targets_v2_atomic: resolvedTargets() })
    mockResume.mockRejectedValue(new Error('Stripe transport unavailable'))

    const response = await commitRecovery(await prepareRecoveryCookie())
    expect(response.status).toBe(503)
    expect(mockStop).not.toHaveBeenCalled()
  })

  it('compensates only the exact B2C target after an ambiguous recovery write', async () => {
    const terminalObservation = {
      ...ACTIVE_OBSERVATION,
      status: 'canceled',
      resume_state: 'ineligible',
    }
    overrideRpcs({
      resolve_account_recovery_billing_targets_v2_atomic: resolvedTargets(),
      complete_account_recovery_billing_v2_atomic: completedBilling({
        status: 'completed_manual',
        b2c_state: 'retired_nonentitling',
        subscription_resumed: false,
        billing_reactivation_required: true,
      }),
    })
    mockResume
      .mockRejectedValueOnce(new B2CSubscriptionRecoveryWriteUncertainError('ambiguous write'))
      .mockResolvedValueOnce(terminalObservation)

    const response = await commitRecovery(await prepareRecoveryCookie())
    expect(response.status).toBe(200)
    expect(mockStop).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub_b2c_current',
        customerId: 'cus_owner',
        expectedUserId: USER_ID,
      })
    )
    expect(mockStop.mock.calls[0][0]).not.toHaveProperty('subscriptionIds')
  })

  it('completes an ambiguous recovery write from exact missing evidence without re-reading Customer', async () => {
    overrideRpcs({
      resolve_account_recovery_billing_targets_v2_atomic: resolvedTargets(),
      complete_account_recovery_billing_v2_atomic: completedBilling({
        status: 'completed_manual',
        b2c_state: 'target_missing',
        subscription_resumed: false,
        billing_reactivation_required: true,
      }),
    })
    mockResume.mockRejectedValueOnce(
      new B2CSubscriptionRecoveryWriteUncertainError('ambiguous write')
    )
    mockStop.mockResolvedValue({
      status: 'missing',
      subscriptionId: 'sub_b2c_current',
    })

    const response = await commitRecovery(await prepareRecoveryCookie())

    expect(response.status).toBe(200)
    expect(mockResume).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith(
      'complete_account_recovery_billing_v2_atomic',
      expect.objectContaining({
        p_b2c_observation: {
          stripe_subscription_id: 'sub_b2c_current',
          missing: true,
        },
      })
    )
  })

  it('returns success when a timed-out completion committed durably', async () => {
    overrideRpcs({
      resolve_account_recovery_billing_targets_v2_atomic: resolvedTargets(),
      complete_account_recovery_billing_v2_atomic: () => ({
        data: null,
        error: { message: 'connection reset after commit' },
      }),
      read_account_recovery_billing_result_v2_atomic: completedBilling(),
    })
    mockResume.mockResolvedValue(ACTIVE_OBSERVATION)

    const response = await commitRecovery(await prepareRecoveryCookie())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ subscription_resumed: true })
    expect(mockStop).not.toHaveBeenCalled()
    expect(
      mockRpc.mock.calls.some(
        ([name]) => name === 'require_account_recovery_auth_compensation_atomic'
      )
    ).toBe(false)
  })

  it('CAS-compensates exact B2C billing when a timed-out completion did not commit', async () => {
    overrideRpcs({
      resolve_account_recovery_billing_targets_v2_atomic: resolvedTargets(),
      complete_account_recovery_billing_v2_atomic: () => ({
        data: null,
        error: { message: 'connection reset before commit' },
      }),
      read_account_recovery_billing_result_v2_atomic: { status: 'invalid' },
      require_account_recovery_auth_compensation_atomic: 'compensation_billing',
      resolve_account_recovery_compensation_scope_atomic: 'billing_stop_required',
      read_account_recovery_billing_compensation_target_v2_atomic: compensationTarget(),
      complete_account_recovery_auth_compensation_atomic: 'compensated',
    })
    mockResume.mockResolvedValue(ACTIVE_OBSERVATION)
    mockGetUser
      .mockResolvedValueOnce({ data: { user: { banned_until: null } }, error: null })
      .mockResolvedValue({
        data: {
          user: {
            banned_until: new Date(Date.now() + 100 * 365 * 24 * 60 * 60_000).toISOString(),
          },
        },
        error: null,
      })

    const response = await commitRecovery(await prepareRecoveryCookie())
    expect(response.status).toBe(503)
    expect(mockStop).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub_b2c_current',
        customerId: 'cus_owner',
      })
    )
    expect(mockUpdateUser).toHaveBeenLastCalledWith('11111111-1111-4111-8111-111111111111', {
      ban_duration: '876000h',
    })
  })

  it('uses the durable target when completion detects a local-authority race', async () => {
    overrideRpcs({
      resolve_account_recovery_billing_targets_v2_atomic: resolvedTargets(),
      complete_account_recovery_billing_v2_atomic: { status: 'compensation_billing' },
      resolve_account_recovery_compensation_scope_atomic: 'billing_stop_required',
      read_account_recovery_billing_compensation_target_v2_atomic: compensationTarget(),
      complete_account_recovery_auth_compensation_atomic: 'compensated',
    })
    mockResume.mockResolvedValue(ACTIVE_OBSERVATION)
    mockGetUser
      .mockResolvedValueOnce({ data: { user: { banned_until: null } }, error: null })
      .mockResolvedValue({
        data: {
          user: {
            banned_until: new Date(Date.now() + 100 * 365 * 24 * 60 * 60_000).toISOString(),
          },
        },
        error: null,
      })

    const response = await commitRecovery(await prepareRecoveryCookie())

    expect(response.status).toBe(503)
    expect(mockStop).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: 'sub_b2c_current',
        customerId: 'cus_owner',
        livemode: false,
      })
    )
    expect(mockUpdateUser).toHaveBeenLastCalledWith('11111111-1111-4111-8111-111111111111', {
      ban_duration: '876000h',
    })
  })

  it('does not compensate when a late completion wins the admission CAS', async () => {
    let reads = 0
    overrideRpcs({
      resolve_account_recovery_billing_targets_v2_atomic: resolvedTargets(),
      complete_account_recovery_billing_v2_atomic: () => ({
        data: null,
        error: { message: 'completion response lost' },
      }),
      read_account_recovery_billing_result_v2_atomic: () => {
        reads += 1
        return {
          data: reads === 1 ? { status: 'invalid' } : completedBilling(),
          error: null,
        }
      },
      require_account_recovery_auth_compensation_atomic: 'completed_resumed',
    })
    mockResume.mockResolvedValue(ACTIVE_OBSERVATION)

    const response = await commitRecovery(await prepareRecoveryCookie())
    expect(response.status).toBe(200)
    expect(reads).toBe(2)
    expect(mockStop).not.toHaveBeenCalled()
  })

  it('reads the durable per-product result on replay instead of trusting the old boolean ack', async () => {
    overrideRpcs({
      claim_account_recovery_auth_finalization_atomic: 'completed_manual',
      read_account_recovery_billing_result_v2_atomic: completedBilling({
        status: 'completed_manual',
        b2c_state: 'target_missing',
        lifetime_state: 'restored',
        subscription_resumed: false,
        billing_reactivation_required: true,
      }),
    })

    const response = await commitRecovery(await prepareRecoveryCookie())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      subscription_resumed: false,
      billing_reactivation_required: true,
    })
    expect(mockResume).not.toHaveBeenCalled()
    expect(
      mockRpc.mock.calls.some(
        ([name]) => name === 'resolve_account_recovery_billing_targets_v2_atomic'
      )
    ).toBe(false)
  })

  it('fails replay closed when the durable v2 result is absent or malformed', async () => {
    overrideRpcs({
      claim_account_recovery_auth_finalization_atomic: 'completed_resumed',
      read_account_recovery_billing_result_v2_atomic: { status: 'invalid' },
    })
    const response = await commitRecovery(await prepareRecoveryCookie())
    expect(response.status).toBe(503)
    expect(mockResume).not.toHaveBeenCalled()
  })

  it('returns 503 instead of an empty status when authority lookup fails', async () => {
    const prepared = await POST(
      request('/api/account/recover', { recovery_token: TOKEN, operation_id: OPERATION })
    )
    mockRpc.mockResolvedValue({ data: null, error: { message: 'db unavailable' } })
    const response = await POST(
      request('/api/account/recover?phase=status', {}, cookiePair(prepared))
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: 'Status unavailable' })
  })
})
