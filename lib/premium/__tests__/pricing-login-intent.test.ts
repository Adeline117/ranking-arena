import {
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
})
