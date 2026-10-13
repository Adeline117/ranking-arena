import { isNonStripeProGrant, LOCAL_PRO_GRANT_PLAN } from '../grant-identity'

describe('isNonStripeProGrant', () => {
  it('treats labelled referral grants as local grants', () => {
    expect(isNonStripeProGrant({ plan: LOCAL_PRO_GRANT_PLAN, stripe_subscription_id: null })).toBe(
      true
    )
  })

  it('treats legacy NULL-plan rows without any Stripe identity as local grants', () => {
    expect(
      isNonStripeProGrant({ plan: null, stripe_subscription_id: null, stripe_customer_id: null })
    ).toBe(true)
  })

  it('never treats a row with a Stripe customer but missing subscription id as a grant', () => {
    expect(
      isNonStripeProGrant({ plan: null, stripe_subscription_id: null, stripe_customer_id: 'cus_1' })
    ).toBe(false)
    expect(
      isNonStripeProGrant({
        plan: 'monthly',
        stripe_subscription_id: null,
        stripe_customer_id: null,
      })
    ).toBe(false)
  })

  it('excludes Stripe subscriptions and lifetime rows', () => {
    expect(isNonStripeProGrant({ plan: null, stripe_subscription_id: 'sub_1' })).toBe(false)
    expect(isNonStripeProGrant({ plan: 'lifetime', stripe_subscription_id: null })).toBe(false)
  })
})
