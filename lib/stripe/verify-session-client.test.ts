import { readVerifiedCheckoutSession } from './verify-session-client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('Stripe verify-session client contract', () => {
  it('accepts exact lifetime and recurring acknowledgements', () => {
    expect(
      readVerifiedCheckoutSession({
        success: true,
        tier: 'pro',
        status: 'active',
        plan: 'lifetime',
      })
    ).toEqual({ kind: 'lifetime', status: 'active' })
    expect(
      readVerifiedCheckoutSession({
        success: true,
        tier: 'pro',
        status: 'trialing',
        subscriptionId: 'sub_123ABC',
      })
    ).toEqual({ kind: 'recurring', status: 'trialing', subscriptionId: 'sub_123ABC' })
  })

  it.each([
    null,
    { success: true },
    { success: true, tier: 'free', status: 'active', plan: 'lifetime' },
    { success: true, tier: 'pro', status: 'trialing', plan: 'lifetime' },
    { success: true, tier: 'pro', status: 'active', subscriptionId: 'not-a-subscription' },
    {
      success: true,
      tier: 'pro',
      status: 'active',
      subscriptionId: 'sub_123',
      plan: 'monthly',
    },
  ])('rejects a malformed or mixed successful response: %p', (value) => {
    expect(readVerifiedCheckoutSession(value)).toBeNull()
  })

  it('keeps the payment success page on exact server authority', () => {
    const page = readFileSync(join(process.cwd(), 'app/(app)/pricing/success/page.tsx'), 'utf8')

    expect(page).toContain('readVerifiedCheckoutSession(responseData)')
    expect(page).toContain('verificationRequestKeyRef.current === verificationRequestKey')
    expect(page).toContain('fetchVerifiedSubscription(session.accessToken, session.userId)')
    expect(page).not.toContain(".from('subscriptions')")
    expect(page).not.toContain(".select('subscription_tier')")
  })
})
