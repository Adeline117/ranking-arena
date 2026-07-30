import { isTrustedStripeBillingPortalUrl, isTrustedStripeCheckoutUrl } from './hosted-url'

describe('Stripe hosted URL trust boundaries', () => {
  it.each([
    'https://checkout.stripe.com/c/pay/cs_exact',
    'https://checkout.stripe.com/c/pay/cs_exact?prefilled_email=user%40example.com',
  ])('accepts an exact Stripe Checkout origin: %s', (url) => {
    expect(isTrustedStripeCheckoutUrl(url)).toBe(true)
  })

  it.each([
    'https://attacker.example/c/pay/cs_exact',
    'https://checkout.stripe.com.attacker.example/c/pay/cs_exact',
    'https://checkout.stripe.com@attacker.example/c/pay/cs_exact',
    'http://checkout.stripe.com/c/pay/cs_exact',
    'https://checkout.stripe.com:444/c/pay/cs_exact',
    ' https://checkout.stripe.com/c/pay/cs_exact',
    'javascript:alert(1)',
    '',
    null,
  ])('rejects a noncanonical Checkout URL: %s', (url) => {
    expect(isTrustedStripeCheckoutUrl(url)).toBe(false)
  })

  it('keeps Billing Portal and Checkout origins separate', () => {
    expect(isTrustedStripeBillingPortalUrl('https://checkout.stripe.com/c/pay/cs_exact')).toBe(
      false
    )
    expect(isTrustedStripeCheckoutUrl('https://billing.stripe.com/p/session/exact')).toBe(false)
  })
})
