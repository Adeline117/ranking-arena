import {
  isTipCheckoutEnabled,
  isTipCheckoutLiveModeConfigured,
  isTipCheckoutRuntimeEnabled,
  shouldFreezeTipCheckout,
} from '../tip-checkout-cutover'

describe('Tip checkout cutover contract', () => {
  it.each([undefined, '', 'false', 'TRUE', ' true', 'true\n'])(
    'fails closed for non-exact value %p',
    (value) => {
      expect(isTipCheckoutEnabled(value)).toBe(false)
      expect(shouldFreezeTipCheckout('/api/tip/checkout', 'POST', value)).toBe(true)
    }
  )

  it('allows checkout only for the exact server value true with both live Stripe keys', () => {
    expect(isTipCheckoutEnabled('true')).toBe(true)
    expect(isTipCheckoutLiveModeConfigured('sk_live_tip', 'pk_live_tip')).toBe(true)
    expect(isTipCheckoutRuntimeEnabled('true', 'sk_live_tip', 'pk_live_tip')).toBe(true)
    expect(
      shouldFreezeTipCheckout('/api/tip/checkout', 'POST', 'true', 'sk_live_tip', 'pk_live_tip')
    ).toBe(false)
  })

  it.each([
    ['both keys missing', undefined, undefined],
    ['both test keys', 'sk_test_tip', 'pk_test_tip'],
    ['test secret', 'sk_test_tip', 'pk_live_tip'],
    ['test publishable key', 'sk_live_tip', 'pk_test_tip'],
    ['malformed secret', ' sk_live_tip', 'pk_live_tip'],
    ['malformed publishable key', 'sk_live_tip', 'pk_live_tip '],
  ])('fails closed with flag=true when %s', (_label, secretKey, publishableKey) => {
    expect(isTipCheckoutLiveModeConfigured(secretKey, publishableKey)).toBe(false)
    expect(isTipCheckoutRuntimeEnabled('true', secretKey, publishableKey)).toBe(false)
    expect(
      shouldFreezeTipCheckout('/api/tip/checkout', 'POST', 'true', secretKey, publishableKey)
    ).toBe(true)
  })

  it.each([
    ['/api/tip/checkout', 'GET'],
    ['/api/tip/checkout/session', 'POST'],
    ['/api/stripe/webhook', 'POST'],
  ])('does not intercept unrelated request %s %s', (pathname, method) => {
    expect(shouldFreezeTipCheckout(pathname, method, undefined)).toBe(false)
  })

  it('covers the normalized trailing-slash route', () => {
    expect(shouldFreezeTipCheckout('/api/tip/checkout/', 'post', undefined)).toBe(true)
  })
})
