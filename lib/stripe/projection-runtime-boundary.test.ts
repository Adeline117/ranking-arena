import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')
const MUTATION_SURFACES = [
  'app/api/stripe/webhook/handlers/subscription.ts',
  'app/api/stripe/webhook/handlers/invoice.ts',
  'app/api/cron/reconcile-subscriptions/route.ts',
  'app/api/cron/subscription-expiry/route.ts',
  'app/api/admin/sync-subscription/route.ts',
] as const

function source(path: (typeof MUTATION_SURFACES)[number]): string {
  return readFileSync(resolve(ROOT, path), 'utf8')
}

describe('runtime Pro projection authority boundary', () => {
  it.each(MUTATION_SURFACES)('%s has no direct projection or group mutation', (path) => {
    const runtime = source(path)
    expect(runtime).not.toMatch(/\.from\(\s*['"]subscriptions['"]\s*\)[\s\S]{0,240}?\.update\(/s)
    expect(runtime).not.toMatch(/\.from\(\s*['"]user_profiles['"]\s*\)[\s\S]{0,320}?\.update\(/s)
    expect(runtime).not.toMatch(
      /\.from\(\s*['"]group_members['"]\s*\)[\s\S]{0,240}?\.(?:delete|insert|upsert|update)\(/s
    )
    expect(runtime).not.toContain('leaveProOfficialGroup(')
    expect(runtime).not.toContain('sync_recurring_pro_subscription_projection_atomic')
    expect(runtime).not.toContain('updateUserSubscription(')
  })

  it.each([
    'app/api/cron/reconcile-subscriptions/route.ts',
    'app/api/cron/subscription-expiry/route.ts',
    'app/api/admin/sync-subscription/route.ts',
  ] as const)('%s delegates projection and group convergence to the shared authority', (path) => {
    expect(source(path)).toContain('reconcileAllDueProEntitlementProjections(')
  })

  it('keeps subscription state and failed invoices on separate authority paths', () => {
    const subscription = source('app/api/stripe/webhook/handlers/subscription.ts')
    const invoice = source('app/api/stripe/webhook/handlers/invoice.ts')

    expect(subscription).toContain("'reconcile_recurring_subscription_state_atomic'")
    expect(invoice).not.toContain('reconcile_recurring_subscription_state_atomic')
    expect(invoice).toMatch(/\.from\(\s*['"]payment_history['"]\s*\)\s*\.insert\(/s)
    expect(invoice).not.toMatch(
      /\.from\(\s*['"]payment_history['"]\s*\)\s*\.upsert\([\s\S]{0,240}?status:\s*['"]failed['"]/s
    )
  })
})
