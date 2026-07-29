import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'

const mockParseApiTierSubscriptionAuthority = jest.fn()
const mockParseRecurringProCheckoutMetadata = jest.fn()

jest.mock('@/app/api/stripe/webhook/handlers/subscription', () => ({
  parseApiTierSubscriptionAuthority: (...args: unknown[]) =>
    mockParseApiTierSubscriptionAuthority(...args),
}))

jest.mock('@/lib/stripe/recurring-pro-checkout', () => ({
  parseRecurringProCheckoutMetadata: (...args: unknown[]) =>
    mockParseRecurringProCheckoutMetadata(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  }),
}))

import { drainApiTierReversalActions } from './api-tier-reversal-actions'

const ACTION_ID = '11111111-1111-4111-8111-111111111111'
const OWNERSHIP_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '33333333-3333-4333-8333-333333333333'
const CUSTOMER_ID = 'cus_api_owner'
const SUBSCRIPTION_ID = 'sub_api_reversed'

function subscription(status: Stripe.Subscription.Status = 'active'): Stripe.Subscription {
  return {
    id: SUBSCRIPTION_ID,
    customer: CUSTOMER_ID,
    livemode: true,
    status,
  } as Stripe.Subscription
}

function action(leaseToken: string, attempts = 1, productKind?: 'api_tier' | 'pro_entitlement') {
  return {
    id: ACTION_ID,
    ownership_id: OWNERSHIP_ID,
    livemode: true,
    user_id: USER_ID,
    stripe_customer_id: CUSTOMER_ID,
    stripe_subscription_id: SUBSCRIPTION_ID,
    attempts,
    lease_token: leaseToken,
    ...(productKind ? { product_kind: productKind } : {}),
  }
}

function harness(options: {
  attempts?: number
  productKind?: 'api_tier' | 'pro_entitlement'
  retrieve?: jest.Mock
  cancel?: jest.Mock
  finish?: (args: Record<string, unknown>, invocation: number) => Promise<unknown>
}) {
  const retrieve = options.retrieve ?? jest.fn().mockResolvedValue(subscription())
  const cancel = options.cancel ?? jest.fn().mockResolvedValue(subscription('canceled'))
  let finishInvocation = 0
  const rpc = jest.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'claim_api_tier_reversal_actions_atomic') {
      return {
        data: [action(String(args.p_worker_token), options.attempts, options.productKind)],
        error: null,
      }
    }
    if (name === 'finish_api_tier_reversal_action_atomic') {
      finishInvocation += 1
      if (options.finish) return options.finish(args, finishInvocation)
      return {
        data: args.p_succeeded ? 'completed' : 'retry_scheduled',
        error: null,
      }
    }
    throw new Error(`Unexpected RPC ${name}`)
  })
  return {
    stripe: {
      subscriptions: { retrieve, cancel },
    } as unknown as Stripe,
    supabase: { rpc } as unknown as SupabaseClient<Database>,
    rpc,
    retrieve,
    cancel,
  }
}

describe('API tier reversal action outbox', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    process.env.STRIPE_SECRET_KEY = 'sk_live_test'
    mockParseApiTierSubscriptionAuthority.mockReturnValue({
      userId: USER_ID,
      stripeCustomerId: CUSTOMER_ID,
    })
    mockParseRecurringProCheckoutMetadata.mockReturnValue({
      userId: USER_ID,
      customerId: CUSTOMER_ID,
    })
  })

  afterAll(() => {
    delete process.env.STRIPE_SECRET_KEY
  })

  it('cancels only the exact fresh subscription and durably finishes the action', async () => {
    const test = harness({})

    await expect(
      drainApiTierReversalActions({
        stripe: test.stripe,
        supabase: test.supabase,
        limit: 1,
      })
    ).resolves.toEqual({ claimed: 1, completed: 1, retried: 0 })

    expect(test.cancel).toHaveBeenCalledWith(SUBSCRIPTION_ID)
    expect(test.rpc).toHaveBeenLastCalledWith(
      'finish_api_tier_reversal_action_atomic',
      expect.objectContaining({
        p_action_id: ACTION_ID,
        p_succeeded: true,
        p_disposition: 'canceled',
        p_retry_after_seconds: null,
      })
    )
  })

  it('cancels an exact ordinary Pro dispute action without API metadata', async () => {
    const test = harness({ productKind: 'pro_entitlement' })

    await expect(
      drainApiTierReversalActions({
        stripe: test.stripe,
        supabase: test.supabase,
        limit: 1,
      })
    ).resolves.toEqual({ claimed: 1, completed: 1, retried: 0 })

    expect(mockParseApiTierSubscriptionAuthority).not.toHaveBeenCalled()
    expect(mockParseRecurringProCheckoutMetadata).toHaveBeenCalledTimes(1)
    expect(test.cancel).toHaveBeenCalledWith(SUBSCRIPTION_ID)
  })

  it('keeps legacy action rows backward compatible as API tier actions', async () => {
    const test = harness({})

    await drainApiTierReversalActions({
      stripe: test.stripe,
      supabase: test.supabase,
      limit: 1,
    })

    expect(mockParseApiTierSubscriptionAuthority).toHaveBeenCalledTimes(1)
    expect(mockParseRecurringProCheckoutMetadata).not.toHaveBeenCalled()
  })

  it('schedules exponential retry when Stripe cancellation is transiently unavailable', async () => {
    const test = harness({
      attempts: 3,
      cancel: jest.fn().mockRejectedValue(new Error('Stripe unavailable')),
    })

    await expect(
      drainApiTierReversalActions({
        stripe: test.stripe,
        supabase: test.supabase,
        limit: 1,
      })
    ).resolves.toEqual({ claimed: 1, completed: 0, retried: 1 })

    expect(test.rpc).toHaveBeenLastCalledWith(
      'finish_api_tier_reversal_action_atomic',
      expect.objectContaining({
        p_succeeded: false,
        p_error: 'Stripe unavailable',
        p_retry_after_seconds: 120,
      })
    )
  })

  it('treats a confirmed resource_missing subscription as terminally revoked', async () => {
    const test = harness({
      retrieve: jest.fn().mockRejectedValue({ code: 'resource_missing' }),
    })

    await expect(
      drainApiTierReversalActions({
        stripe: test.stripe,
        supabase: test.supabase,
        limit: 1,
      })
    ).resolves.toEqual({ claimed: 1, completed: 1, retried: 0 })

    expect(test.cancel).not.toHaveBeenCalled()
    expect(test.rpc).toHaveBeenLastCalledWith(
      'finish_api_tier_reversal_action_atomic',
      expect.objectContaining({
        p_succeeded: true,
        p_disposition: 'resource_missing',
      })
    )
  })

  it('recovers after a crash between remote cancellation and durable finish', async () => {
    let canceled = false
    const retrieve = jest.fn(async () => subscription(canceled ? 'canceled' : 'active'))
    const cancel = jest.fn(async () => {
      canceled = true
      return subscription('canceled')
    })
    const test = harness({
      retrieve,
      cancel,
      finish: async (args, invocation) =>
        invocation === 1
          ? { data: null, error: { message: 'database connection lost' } }
          : {
              data: args.p_succeeded ? 'completed' : 'retry_scheduled',
              error: null,
            },
    })

    await expect(
      drainApiTierReversalActions({
        stripe: test.stripe,
        supabase: test.supabase,
        limit: 1,
      })
    ).resolves.toEqual({ claimed: 1, completed: 0, retried: 1 })

    await expect(
      drainApiTierReversalActions({
        stripe: test.stripe,
        supabase: test.supabase,
        limit: 1,
      })
    ).resolves.toEqual({ claimed: 1, completed: 1, retried: 0 })

    expect(cancel).toHaveBeenCalledTimes(1)
    expect(test.rpc).toHaveBeenLastCalledWith(
      'finish_api_tier_reversal_action_atomic',
      expect.objectContaining({
        p_succeeded: true,
        p_disposition: 'already_canceled',
      })
    )
  })
})
