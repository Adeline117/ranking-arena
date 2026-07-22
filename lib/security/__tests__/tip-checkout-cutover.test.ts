import { isTipCheckoutEnabled, shouldFreezeTipCheckout } from '../tip-checkout-cutover'

describe('Tip checkout cutover contract', () => {
  it.each([undefined, '', 'false', 'TRUE', ' true', 'true\n'])(
    'fails closed for non-exact value %p',
    (value) => {
      expect(isTipCheckoutEnabled(value)).toBe(false)
      expect(shouldFreezeTipCheckout('/api/tip/checkout', 'POST', value)).toBe(true)
    }
  )

  it('allows checkout only for the exact server value true', () => {
    expect(isTipCheckoutEnabled('true')).toBe(true)
    expect(shouldFreezeTipCheckout('/api/tip/checkout', 'POST', 'true')).toBe(false)
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
