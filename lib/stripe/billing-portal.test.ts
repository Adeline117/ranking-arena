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
        : { plan: authority.plan, userId: authority.userId },
    items: {
      object: 'list',
      data: [
        {
          id: 'si_current',
          object: 'subscription_item',
          quantity: 1,
          price: { id: priceId },
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
  subscriptionOverrides?: Record<string, unknown>
  sessionOverrides?: Record<string, unknown>
}) {
  const authority = params.authority ?? membershipAuthority
  const flow = params.flow ?? 'payment_method_update'
  const returnUrl = params.returnUrl ?? 'https://www.arenafi.org/user-center?tab=membership'
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
      subscriptions: { retrieve },
      billingPortal: { sessions: { create } },
    },
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
    expect(mock.retrieve).toHaveBeenCalledWith('sub_member')
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
      prices,
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
              price: { id: prices.api.starter },
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
              price: { id: prices.membership.monthly },
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

  it.each([
    'https://attacker.example/p/session/phishing',
    'https://billing.stripe.com.attacker.example/p/session/phishing',
    'https://billing.stripe.com@attacker.example/p/session/phishing',
    'http://billing.stripe.com/p/session/insecure',
  ])('rejects a non-Stripe Billing Portal URL: %s', async (url) => {
    const mock = stripeClient({ sessionOverrides: { url } })

    await expect(
      createBillingPortalFlow({
        stripe: mock.client,
        authority: membershipAuthority,
        flow: 'payment_method_update',
        returnUrl: 'https://www.arenafi.org/user-center?tab=membership',
        prices,
      })
    ).rejects.toThrow('invalid Billing Portal URL')
  })
})
