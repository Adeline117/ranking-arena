import {
  buildPricingCheckoutLoginHref,
  buildPricingLoginHref,
  buildPricingReturnPath,
  parsePricingBilling,
} from '../pricing-login-intent'

describe('pricing login intent', () => {
  it('keeps the selected plan and billing period in the safe internal return URL', () => {
    expect(buildPricingReturnPath('pro', 'monthly')).toBe('/pricing?plan=pro&billing=monthly')
    expect(buildPricingLoginHref('trial', 'yearly')).toBe(
      '/login?returnUrl=%2Fpricing%3Fplan%3Dtrial%26billing%3Dyearly'
    )
  })

  it('accepts only supported billing periods', () => {
    expect(parsePricingBilling('monthly')).toBe('monthly')
    expect(parsePricingBilling('yearly')).toBe('yearly')
    expect(parsePricingBilling('lifetime')).toBeNull()
    expect(parsePricingBilling(null)).toBeNull()
  })

  it('maps checkout state to the exact typed pricing intent', () => {
    expect(buildPricingCheckoutLoginHref({ plan: 'monthly' })).toBe(
      '/login?returnUrl=%2Fpricing%3Fplan%3Dpro%26billing%3Dmonthly'
    )
    expect(buildPricingCheckoutLoginHref({ plan: 'yearly', trial: true })).toBe(
      '/login?returnUrl=%2Fpricing%3Fplan%3Dtrial%26billing%3Dyearly'
    )
    expect(buildPricingCheckoutLoginHref({ plan: 'lifetime', billing: 'monthly' })).toBe(
      '/login?returnUrl=%2Fpricing%3Fplan%3Dlifetime%26billing%3Dmonthly'
    )
  })
})
