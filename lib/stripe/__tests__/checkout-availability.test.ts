import { isLifetimeCheckoutEnabled } from '../checkout-availability'

describe('isLifetimeCheckoutEnabled', () => {
  const originalVercelEnv = process.env.VERCEL_ENV
  const originalFlag = process.env.STRIPE_LIFETIME_CHECKOUT_ENABLED

  afterEach(() => {
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV
    else process.env.VERCEL_ENV = originalVercelEnv
    if (originalFlag === undefined) delete process.env.STRIPE_LIFETIME_CHECKOUT_ENABLED
    else process.env.STRIPE_LIFETIME_CHECKOUT_ENABLED = originalFlag
  })

  it('is open outside Production', () => {
    process.env.VERCEL_ENV = 'preview'
    delete process.env.STRIPE_LIFETIME_CHECKOUT_ENABLED
    expect(isLifetimeCheckoutEnabled()).toBe(true)
  })

  it('stays closed in Production unless the flag is exactly "true"', () => {
    process.env.VERCEL_ENV = 'production'
    delete process.env.STRIPE_LIFETIME_CHECKOUT_ENABLED
    expect(isLifetimeCheckoutEnabled()).toBe(false)
    process.env.STRIPE_LIFETIME_CHECKOUT_ENABLED = '1'
    expect(isLifetimeCheckoutEnabled()).toBe(false)
    process.env.STRIPE_LIFETIME_CHECKOUT_ENABLED = 'true'
    expect(isLifetimeCheckoutEnabled()).toBe(true)
  })
})
