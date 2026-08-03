import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(
    root,
    'supabase/migrations/20260729023000_preserve_financial_owner_after_account_deletion.sql'
  ),
  'utf8'
)
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/financial-subject-retention.pg17.sh'),
  'utf8'
)
const preMigrationFixture = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/financial-subject-retention.pre-migration.psql'),
  'utf8'
)
const fixture = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/financial-subject-retention.fixture.psql'),
  'utf8'
)
const databaseTypes = readFileSync(resolve(root, 'lib/supabase/database.types.ts'), 'utf8')
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')

describe('financial subject retention after account deletion', () => {
  it('removes only the two dangerous profile/auth FKs', () => {
    expect(migration).toContain("'public.tips'::pg_catalog.regclass")
    expect(migration).toContain("'from_user_id'::name")
    expect(migration).toContain("'auth.users'::pg_catalog.regclass")
    expect(migration).toContain('\'c\'::"char"')
    expect(migration).toContain("'public.stripe_entitlement_payments'::pg_catalog.regclass")
    expect(migration).toContain("'user_id'::name")
    expect(migration).toContain("'public.user_profiles'::pg_catalog.regclass")
    expect(migration).toContain('\'n\'::"char"')
    expect(migration).toContain('ALTER TABLE %s DROP CONSTRAINT %I')
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/)
    expect(migration).not.toMatch(/DELETE\s+FROM\s+(?:auth|public)\./)
  })

  it('repairs only an ownership-proven null subject and freezes both UUIDs', () => {
    expect(migration).toContain('UPDATE public.stripe_entitlement_payments AS payment')
    expect(migration).toContain("ownership.product_kind = 'pro_entitlement'")
    expect(migration).toContain('ownership.ledger_id = payment.id')
    expect(migration).toContain('ownership.owner_user_id IS NOT NULL')
    expect(migration).toContain('payment.stripe_customer_id = ownership.stripe_customer_id')
    expect(migration).toContain('payment.stripe_charge_id = ownership.stripe_charge_id')
    expect(migration).toContain('payment.amount_paid = ownership.amount_paid')
    expect(migration).toContain('public.prevent_tip_financial_owner_mutation()')
    expect(migration).toContain('public.prevent_entitlement_financial_owner_mutation()')
    expect(migration).toContain('BEFORE UPDATE OF from_user_id')
    expect(migration).toContain('BEFORE UPDATE OF user_id')
  })

  it('fails closed on historical ownership loss without recreating PII', () => {
    expect(migration).toContain('public.stripe_payment_ownership_is_exact_v2(ownership.id)')
    expect(migration).toContain('historical Stripe payment ownership requires recovery or review')
    expect(migration).not.toMatch(/INSERT\s+INTO\s+(?:auth\.users|public\.user_profiles)/)
    expect(migration).not.toMatch(/(?:email|phone|display_name|avatar_url|full_name)/)
  })

  it('keeps generated relationships from implying a deleted profile exists', () => {
    const tableStart = databaseTypes.indexOf('stripe_entitlement_payments: {')
    const tableEnd = databaseTypes.indexOf('stripe_entitlement_refund_events: {', tableStart)
    const tableContract = databaseTypes.slice(tableStart, tableEnd)
    expect(tableStart).toBeGreaterThanOrEqual(0)
    expect(tableEnd).toBeGreaterThan(tableStart)
    expect(tableContract).not.toContain('stripe_entitlement_payments_user_id_fkey')
  })

  it('ships a real PG17 repair, hard-delete and refund-routing proof', () => {
    expect(pg17).toContain('20260718184500_classify_non_entitlement_stripe_payments.sql')
    expect(pg17).toContain('20260721140000_idempotent_equivalent_refund_events.sql')
    expect(pg17).toContain('20260729023000_preserve_financial_owner_after_account_deletion.sql')
    expect(preMigrationFixture).toContain('$prove_historical_set_null_damage$')
    expect(fixture).toContain('$prove_preexisting_owner_repair$')
    expect(fixture).toContain('$hard_delete_retains_exact_financial_identity$')
    expect(fixture).toContain('$financial_owner_is_immutable$')
    expect(fixture).toContain('$refund_routing_survives_hard_delete$')
    expect(fixture).toContain('public.stripe_refund_tombstone_is_resolved_v2')
    expect(fixture).toContain('Financial-subject retention fixture passed')
  })

  it('is wired as a predeploy release migration', () => {
    const file = '20260729023000_preserve_financial_owner_after_account_deletion.sql'
    const predeployStart = runner.indexOf('PREDEPLOY_MIGRATIONS=(')
    const postdeployStart = runner.indexOf('POSTDEPLOY_MIGRATIONS=(')
    expect(runner.slice(predeployStart, postdeployStart)).toContain(file)
    expect(runner.slice(postdeployStart)).not.toContain(file)
  })
})
