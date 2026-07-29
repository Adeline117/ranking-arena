import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('failed recurring Invoice authority boundary', () => {
  const source = readFileSync(resolve(__dirname, '../invoice.ts'), 'utf8')
  const handler = source.slice(
    source.indexOf('export async function handlePaymentFailed'),
    source.indexOf('export async function handlePaymentActionRequired')
  )

  it('records history without mutating subscription or entitlement projections', () => {
    expect(handler).not.toMatch(/\.from\(\s*['"]subscriptions['"]\s*\)/)
    expect(handler).not.toMatch(/subscription_tier/)
    expect(handler).not.toContain('reconcile_recurring_subscription_state_atomic')
  })

  it('never upserts a failure over an existing succeeded Invoice record', () => {
    expect(handler).toContain(".from('payment_history').insert({")
    expect(handler).not.toMatch(/\.from\(\s*['"]payment_history['"]\s*\)\.upsert\(/s)
    expect(handler).toContain("existingFailure.status !== 'failed'")
  })

  it('requires signed event, exact Checkout identity, and exact subscription state', () => {
    expect(handler).toContain('exactFailedEventContext(invoice, event)')
    expect(handler).toContain('parseRecurringProCheckoutMetadata(subscription.metadata)')
    expect(handler).toContain('resolveSubscriptionEventStateAuthority(')
    expect(handler).toContain('assertRecurringProCheckoutCompleted({')
  })
})
