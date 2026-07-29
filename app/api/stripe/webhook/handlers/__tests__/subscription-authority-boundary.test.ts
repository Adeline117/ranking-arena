import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('recurring Pro subscription state authority boundary', () => {
  const source = readFileSync(resolve(__dirname, '../subscription.ts'), 'utf8')

  it('has no direct subscription/profile downgrade or official-group leave path', () => {
    expect(source).not.toMatch(/\.from\(\s*['"]subscriptions['"]\s*\)\s*\.update\(/s)
    expect(source).not.toMatch(
      /\.from\(\s*['"]user_profiles['"]\s*\)\s*\.update\(\s*\{[^}]*subscription_tier:\s*['"]free['"]/s
    )
    expect(source).not.toContain('leaveProOfficialGroup(')
  })

  it('routes exact non-grant state through the atomic authority RPC', () => {
    expect(source).toContain("'reconcile_recurring_subscription_state_atomic'")
    expect(source).toContain('resolveSubscriptionEventStateAuthority(')
    expect(source).toContain('assertRecurringProCheckoutCompleted({')
  })
})
