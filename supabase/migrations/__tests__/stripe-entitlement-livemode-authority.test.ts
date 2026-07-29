import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260729065000_stripe_entitlement_livemode_authority.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/stripe-entitlement-livemode-authority.pg17.sh'),
  'utf8'
)
const fixture = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/stripe-entitlement-livemode-authority.fixture.psql'),
  'utf8'
)

describe('Stripe entitlement livemode authority', () => {
  it('persists non-null mode on every B2C authority and refund identity', () => {
    for (const relation of [
      'stripe_entitlement_payments',
      'stripe_trial_entitlements',
      'stripe_subscription_state_events',
      'stripe_entitlement_refund_events',
      'stripe_charge_refund_tombstones',
      'stripe_charge_refund_tombstone_events',
      'stripe_payment_ownerships',
      'group_payment_consumptions',
    ]) {
      expect(migration).toContain(`ALTER TABLE public.${relation}`)
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE public\\.${relation}\\s+ALTER COLUMN livemode SET NOT NULL`)
      )
    }
    expect(migration).toContain('authenticated Stripe livemode context is required')
    expect(migration).toContain('assign_stripe_payment_ownership_livemode')
  })

  it('classifies every pre-cutover B2C entitlement row as test and removes its authority', () => {
    expect(migration).toContain('UPDATE public.stripe_entitlement_payments SET livemode = false')
    expect(migration).toContain('UPDATE public.stripe_trial_entitlements SET livemode = false')
    expect(migration).toContain("'pre_livemode_test_cutover'")
    expect(migration).toContain("'stripe_lifetime_payment'")
    expect(migration).toContain("'stripe_payment_retry_grace'")
    expect(migration).toContain("SET status = 'canceled'")
    expect(migration).toContain("SET status = 'cancelled'")
    expect(migration).toContain("subscription_tier = 'free'")
    expect(migration).toContain('public.leave_pro_official_group_atomic(v_user_id)')
  })

  it('requires live mode in exact recurring, lifetime and trial authority', () => {
    expect(migration).toContain('AND payment.livemode IS TRUE')
    expect(migration).toContain('AND trial.livemode IS TRUE')
    expect(migration).toContain('SELECT public.stripe_has_current_pro_authority_v2(p_actor_id)')
    expect(migration).toContain('Stripe-derived Pro grant lacks live-mode authority')
  })

  it('replaces all entitlement writers with mode-aware service-only overloads', () => {
    for (const writer of [
      'activate_recurring_entitlement_payment_atomic',
      'activate_recurring_trial_entitlement_atomic',
      'reconcile_recurring_subscription_state_atomic',
      'activate_lifetime_membership_with_identity_atomic',
      'activate_group_subscription_with_stripe_ownership_atomic',
    ]) {
      expect(migration).toContain(`public.${writer}(`)
    }
    expect(migration.match(/p_livemode boolean/g)?.length).toBeGreaterThanOrEqual(6)
    expect(migration).toContain("'test_mode_non_entitling'")
    expect(migration).toContain('legacy Stripe entitlement writer remains executable')
  })

  it('matches refunds to same-mode payment ownership before mutation', () => {
    expect(migration).toContain('record_charge_refund_tombstone_pre_entitlement_livemode_v2')
    expect(migration).toContain("'stripe_refund_livemode_ownership_conflict'")
    expect(migration).toContain('ownership.livemode IS DISTINCT FROM p_livemode')
    expect(migration).toContain('refund ownership Stripe mode mismatch')
    expect(migration).toContain('refund tombstone Stripe mode mismatch')
  })

  it('extends readiness with mode-aware blocking gates and PostgreSQL 17 proof', () => {
    for (const key of [
      'test_mode_entitlement_payments',
      'test_mode_trial_entitlements',
      'non_live_current_pro_authorities',
      'non_live_current_group_passes',
      'stripe_payment_mode_anomalies',
      'refund_mode_anomalies',
      'group_payment_mode_anomalies',
    ]) {
      expect(migration).toContain(`'${key}'`)
    }
    expect(pg17).toContain('20260729065000_stripe_entitlement_livemode_authority.sql')
    expect(pg17).toContain('atomic-stripe-entitlement-identity.pg17.sh')
    expect(fixture).toContain("'test_mode_non_entitling'")
    expect(fixture).toContain('direct ledger insert without livemode context succeeded')
  })

  it('runs only after the mode-aware application has been deployed', () => {
    const predeploy = runner.match(/PREDEPLOY_MIGRATIONS=\(([\s\S]*?)\n\)/)?.[1] ?? ''
    const postdeploy = runner.match(/POSTDEPLOY_MIGRATIONS=\(([\s\S]*?)\n\)/)?.[1] ?? ''

    expect(predeploy).not.toContain(migrationName)
    expect(postdeploy).toContain(migrationName)
  })
})
