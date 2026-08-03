import type Stripe from 'stripe'
import {
  createBillingPortalFlow,
  type BillingPortalAuthority,
  type BillingPortalFlow,
} from './billing-portal'

jest.mock('server-only', () => ({}))

const prices = {
  membership: {
    monthly: 'price_membership_monthly',
    yearly: 'price_membership_yearly',
  },
  api: {
    starter: 'price_api_starter',
    pro: 'price_api_pro',
  },
}

const membershipAuthority: BillingPortalAuthority = {
  userId: 'user-123',
  customerId: 'cus_member',
  subscriptionId: 'sub_member',
  scope: 'membership',
  plan: 'monthly',
  localStatus: 'active',
  livemode: false,
}

function customer(
  authority: BillingPortalAuthority,
  overrides: Record<string, unknown> = {}
): Stripe.Customer | Stripe.DeletedCustomer {
  return {
    id: authority.customerId,
    object: 'customer',
    deleted: false,
    livemode: authority.livemode,
    metadata: { userId: authority.userId },
    ...overrides,
  } as unknown as Stripe.Customer | Stripe.DeletedCustomer
}

function subscription(
  authority: BillingPortalAuthority,
  priceId: string,
  overrides: Record<string, unknown> = {}
): Stripe.Subscription {
  return {
    id: authority.subscriptionId,
    object: 'subscription',
    customer: authority.customerId,
    livemode: authority.livemode,
    status: 'active',
    metadata:
      authority.scope === 'api'
        ? {
            type: 'api_tier',
            api_plan: authority.plan,
            userId: authority.userId,
          }
        : { type: 'pro_membership', plan: authority.plan, userId: authority.userId },
    items: {
      object: 'list',
      data: [
        {
          id: 'si_current',
          object: 'subscription_item',
          quantity: 1,
          price: {
            id: priceId,
            object: 'price',
            livemode: authority.livemode,
          },
        },
      ],
      has_more: false,
      url: `/v1/subscription_items?subscription=${authority.subscriptionId}`,
    },
    ...overrides,
  } as unknown as Stripe.Subscription
}

function portalSession(
  authority: BillingPortalAuthority,
  flow: BillingPortalFlow,
  returnUrl: string,
  overrides: Record<string, unknown> = {}
): Stripe.BillingPortal.Session {
  return {
    id: 'bps_exact',
    object: 'billing_portal.session',
    customer: authority.customerId,
    livemode: authority.livemode,
    url: 'https://billing.stripe.com/p/session/exact',
    flow: {
      type: flow,
      after_completion: {
        type: 'redirect',
        hosted_confirmation: null,
        redirect: { return_url: returnUrl },
      },
      subscription_cancel:
        flow === 'subscription_cancel'
          ? { subscription: authority.subscriptionId, retention: null }
          : null,
      subscription_update: null,
      subscription_update_confirm: null,
    },
    ...overrides,
  } as unknown as Stripe.BillingPortal.Session
}

function stripeClient(params: {
  authority?: BillingPortalAuthority
  priceId?: string
  flow?: BillingPortalFlow
  returnUrl?: string
  customerOverrides?: Record<string, unknown>
  subscriptionOverrides?: Record<string, unknown>
  sessionOverrides?: Record<string, unknown>
}) {
  const authority = params.authority ?? membershipAuthority
  const flow = params.flow ?? 'payment_method_update'
  const returnUrl = params.returnUrl ?? 'https://www.arenafi.org/user-center?tab=membership'
  const retrieveCustomer = jest
    .fn()
    .mockResolvedValue(customer(authority, params.customerOverrides))
  const retrieve = jest
    .fn()
    .mockResolvedValue(
      subscription(
        authority,
        params.priceId ??
          (authority.scope === 'api' ? prices.api.starter : prices.membership.monthly),
        params.subscriptionOverrides
      )
    )
  const create = jest
    .fn()
    .mockResolvedValue(portalSession(authority, flow, returnUrl, params.sessionOverrides))
  return {
    client: {
      customers: { retrieve: retrieveCustomer },
      subscriptions: { retrieve },
      billingPortal: { sessions: { create } },
    },
    retrieveCustomer,
    retrieve,
    create,
  }
}

describe('createBillingPortalFlow', () => {
  it('creates a payment-method deep link with redirect completion and no generic return URL', async () => {
    const returnUrl = 'https://www.arenafi.org/user-center?tab=membership'
    const mock = stripeClient({ returnUrl })

    const result = await createBillingPortalFlow({
      stripe: mock.client,
      authority: membershipAuthority,
      flow: 'payment_method_update',
      returnUrl,
      prices,
    })

    expect(result.url).toBe('https://billing.stripe.com/p/session/exact')
    expect(mock.retrieveCustomer).toHaveBeenCalledWith('cus_member')
    expect(mock.retrieve).toHaveBeenCalledWith('sub_member')
    expect(mock.retrieveCustomer.mock.invocationCallOrder[0]).toBeLessThan(
      mock.retrieve.mock.invocationCallOrder[0]
    )
    expect(mock.retrieve.mock.invocationCallOrder[0]).toBeLessThan(
      mock.create.mock.invocationCallOrder[0]
    )
    expect(mock.create).toHaveBeenCalledWith({
      customer: 'cus_member',
      flow_data: {
        type: 'payment_method_update',
        after_completion: {
          type: 'redirect',
          redirect: { return_url: returnUrl },
        },
      },
    })
    expect(mock.create.mock.calls[0][0]).not.toHaveProperty('return_url')
    expect(JSON.stringify(mock.create.mock.calls[0][0])).not.toContain('subscription_update')
    expect(JSON.stringify(mock.create.mock.calls[0][0])).not.toContain('portal_homepage')
  })

  it('binds an API cancellation deep link to the exact API subscription', async () => {
    const authority: BillingPortalAuthority = {
      ...membershipAuthority,
      customerId: 'cus_api',
      subscriptionId: 'sub_api',
      scope: 'api',
      plan: 'starter',
    }
    const returnUrl = 'https://www.arenafi.org/settings#api-keys'
    const mock = stripeClient({
      authority,
      flow: 'subscription_cancel',
      priceId: prices.api.starter,
      returnUrl,
    })

    await createBillingPortalFlow({
      stripe: mock.client,
      authority,
      flow: 'subscription_cancel',
      returnUrl,
    })

    expect(mock.create).toHaveBeenCalledWith({
      customer: 'cus_api',
      flow_data: {
        type: 'subscription_cancel',
        subscription_cancel: { subscription: 'sub_api' },
        after_completion: {
          type: 'redirect',
          redirect: { return_url: returnUrl },
        },
      },
    })
  })

  it.each([
    [
      'empty',
      {
        membership: { monthly: '', yearly: '' },
        api: { starter: '', pro: '' },
      },
    ],
    [
      'conflicting',
      {
        membership: {
          monthly: 'price_shared',
          yearly: 'price_shared',
        },
        api: { starter: 'price_shared', pro: 'price_shared' },
      },
    ],
  ])(
    'ignores an %s Checkout price catalog for exact cancellation but rejects payment updates',
    async (_label, invalidPrices) => {
      const cancel = stripeClient({
        flow: 'subscription_cancel',
        priceId: 'price_historical_membership',
      })

      await expect(
        createBillingPortalFlow({
          stripe: cancel.client,
          authority: membershipAuthority,
          flow: 'subscription_cancel',
          returnUrl: 'https://www.arenafi.org/user-center?tab=membership',
          prices: invalidPrices,
        })
      ).resolves.toMatchObject({ id: 'bps_exact' })
      expect(cancel.create).toHaveBeenCalledTimes(1)

      const paymentUpdate = stripeClient({})
      await expect(
        createBillingPortalFlow({
          stripe: paymentUpdate.client,
          authority: membershipAuthority,
          flow: 'payment_method_update',
          returnUrl: 'https://www.arenafi.org/user-center?tab=membership',
          prices: invalidPrices,
        })
      ).rejects.toThrow(/price|product scope/i)
      expect(paymentUpdate.retrieveCustomer).not.toHaveBeenCalled()
      expect(paymentUpdate.create).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['wrong subscription', { id: 'sub_attacker' }, 'different Stripe subscription'],
    ['wrong customer', { customer: 'cus_attacker' }, 'different Stripe customer'],
    [
      'wrong user',
      { metadata: { type: 'pro_membership', plan: 'monthly', userId: 'attacker' } },
      'different user',
    ],
    ['wrong mode', { livemode: true }, 'subscription mode is invalid'],
    [
      'ambiguous item',
      {
        items: {
          object: 'list',
          data: [],
          has_more: false,
          url: '/v1/subscription_items',
        },
      },
      'item identity is ambiguous',
    ],
    [
      'wrong item price mode',
      {
        items: {
          object: 'list',
          data: [
            {
              id: 'si_current',
              object: 'subscription_item',
              quantity: 1,
              price: {
                id: 'price_historical_membership',
                object: 'price',
                livemode: true,
              },
            },
          ],
          has_more: false,
          url: '/v1/subscription_items',
        },
      },
      'item price identity is invalid',
    ],
  ])('fails closed for cancellation with a %s', async (_label, overrides, message) => {
    const mock = stripeClient({
      flow: 'subscription_cancel',
      subscriptionOverrides: overrides,
    })

    await expect(
      createBillingPortalFlow({
        stripe: mock.client,
        authority: membershipAuthority,
        flow: 'subscription_cancel',
        returnUrl: 'https://www.arenafi.org/user-center?tab=membership',
      })
    ).rejects.toThrow(message)

    expect(mock.create).not.toHaveBeenCalled()
  })

  it.each([
    ['membership scope', { metadata: { type: 'api_tier', plan: 'monthly', userId: 'user-123' } }],
    [
      'membership plan',
      { metadata: { type: 'pro_membership', plan: 'yearly', userId: 'user-123' } },
    ],
    ['manageable status', { status: 'canceled' }],
  ])('rejects cancellation with mismatched %s evidence', async (_label, overrides) => {
    const mock = stripeClient({
      flow: 'subscription_cancel',
      subscriptionOverrides: overrides,
    })

    await expect(
      createBillingPortalFlow({
        stripe: mock.client,
        authority: membershipAuthority,
        flow: 'subscription_cancel',
        returnUrl: 'https://www.arenafi.org/user-center?tab=membership',
      })
    ).rejects.toThrow()
    expect(mock.create).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong object', { object: 'customer' }, 'subscription mode is invalid'],
    ['wrong id', { id: 'sub_attacker' }, 'different Stripe subscription'],
    ['different customer', { customer: 'cus_attacker' }, 'different Stripe customer'],
    ['different mode', { livemode: true }, 'subscription mode is invalid'],
    [
      'different product price',
      {
        items: {
          object: 'list',
          data: [
            {
              id: 'si_current',
              object: 'subscription_item',
              quantity: 1,
              price: {
                id: prices.api.starter,
                object: 'price',
                livemode: false,
              },
            },
          ],
          has_more: false,
          url: '/v1/subscription_items',
        },
      },
      'different product scope',
    ],
    [
      'paginated items',
      {
        items: {
          object: 'list',
          data: [
            {
              id: 'si_current',
              object: 'subscription_item',
              quantity: 1,
              price: {
                id: prices.membership.monthly,
                object: 'price',
                livemode: false,
              },
            },
          ],
          has_more: true,
          url: '/v1/subscription_items',
        },
      },
      'item identity is ambiguous',
    ],
  ])('fails closed for a %s subscription', async (_label, overrides, message) => {
    const mock = stripeClient({ subscriptionOverrides: overrides })

    await expect(
      createBillingPortalFlow({
        stripe: mock.client,
        authority: membershipAuthority,
        flow: 'payment_method_update',
        returnUrl: 'https://www.arenafi.org/user-center?tab=membership',
        prices,
      })
    ).rejects.toThrow(message)

    expect(mock.create).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong returned identity', { id: 'cus_attacker' }],
    ['foreign owner', { metadata: { userId: 'attacker' } }],
    ['missing owner', { metadata: {} }],
    [
      'conflicting owner aliases',
      { metadata: { userId: membershipAuthority.userId, user_id: 'attacker' } },
    ],
    ['deleted object', { deleted: true }],
    ['wrong mode', { livemode: true }],
  ])(
    'rejects a %s Customer before reading or mutating scoped billing',
    async (_label, overrides) => {
      const mock = stripeClient({ customerOverrides: overrides })

      await expect(
        createBillingPortalFlow({
          stripe: mock.client,
          authority: membershipAuthority,
          flow: 'payment_method_update',
          returnUrl: 'https://www.arenafi.org/user-center?tab=membership',
          prices,
        })
      ).rejects.toThrow()

      expect(mock.retrieve).not.toHaveBeenCalled()
      expect(mock.create).not.toHaveBeenCalled()
    }
  )

  it('rejects an unlisted flow even if an internal caller bypasses TypeScript', async () => {
    const mock = stripeClient({})

    await expect(
      createBillingPortalFlow({
        stripe: mock.client,
        authority: membershipAuthority,
        flow: 'subscription_update' as BillingPortalFlow,
        returnUrl: 'https://www.arenafi.org/user-center?tab=membership',
        prices,
      })
    ).rejects.toThrow('flow is not allowed')

    expect(mock.create).not.toHaveBeenCalled()
  })

  it('rejects a Stripe response that falls through to a subscription-update flow', async () => {
    const mock = stripeClient({
      sessionOverrides: {
        flow: {
          type: 'payment_method_update',
          after_completion: {
            type: 'redirect',
            hosted_confirmation: null,
            redirect: {
              return_url: 'https://www.arenafi.org/user-center?tab=membership',
            },
          },
          subscription_cancel: null,
          subscription_update: { subscription: 'sub_member' },
          subscription_update_confirm: null,
        },
      },
    })

    await expect(
      createBillingPortalFlow({
        stripe: mock.client,
        authority: membershipAuthority,
        flow: 'payment_method_update',
        returnUrl: 'https://www.arenafi.org/user-center?tab=membership',
        prices,
      })
    ).rejects.toThrow('subscription-update Billing Portal flow')
  })
})
