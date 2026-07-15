import type Stripe from 'stripe'
import { classifyActiveProSubscription, getProPlan } from './reconciliation'

const prices = {
  monthly: 'price_monthly',
  yearly: 'price_yearly',
  apiStarter: 'price_api_starter',
  apiPro: 'price_api_pro',
}

function subscription(status: Stripe.Subscription.Status, priceId: string): Stripe.Subscription {
  return {
    id: `sub_${priceId}`,
    status,
    items: { data: [{ price: { id: priceId } }] },
  } as unknown as Stripe.Subscription
}

describe('Stripe subscription reconciliation', () => {
  it('maps only explicitly configured Pro prices', () => {
    expect(getProPlan('price_monthly', prices)).toBe('monthly')
    expect(getProPlan('price_yearly', prices)).toBe('yearly')
    expect(getProPlan('price_unconfigured', prices)).toBeNull()
    expect(getProPlan(undefined, prices)).toBeNull()
  })

  it('accepts active and trialing configured Pro subscriptions', () => {
    expect(
      classifyActiveProSubscription([subscription('active', 'price_monthly')], prices)
    ).toMatchObject({ kind: 'active', plan: 'monthly' })
    expect(
      classifyActiveProSubscription([subscription('trialing', 'price_yearly')], prices)
    ).toMatchObject({ kind: 'active', plan: 'yearly' })
  })

  it('does not treat canceled configured subscriptions as active', () => {
    expect(
      classifyActiveProSubscription([subscription('canceled', 'price_monthly')], prices)
    ).toEqual({ kind: 'none' })
  })

  it('ignores active API subscriptions when deciding Pro membership', () => {
    expect(
      classifyActiveProSubscription([subscription('active', 'price_api_pro')], prices)
    ).toEqual({ kind: 'none' })
  })

  it('preserves existing access for manual review when an active price is unknown', () => {
    expect(
      classifyActiveProSubscription([subscription('active', 'price_unconfigured')], prices)
    ).toEqual({ kind: 'unknown-active-price', priceIds: ['price_unconfigured'] })
  })

  it('prefers a configured Pro subscription even when another active price is unknown', () => {
    expect(
      classifyActiveProSubscription(
        [subscription('active', 'price_unconfigured'), subscription('active', 'price_yearly')],
        prices
      )
    ).toMatchObject({ kind: 'active', plan: 'yearly' })
  })
})
