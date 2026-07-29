import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migrationName = '20260729075700_account_deletion_billing_intent.sql'
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations', migrationName), 'utf8')
const runner = readFileSync(
  resolve(process.cwd(), 'scripts/maintenance/apply-launch-migrations.sh'),
  'utf8'
)
const pg17Proof = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/__tests__/account-deletion-billing-intent.pg17.sh'),
  'utf8'
)

describe('durable account deletion billing intent', () => {
  it('persists an exact prepared operation before Stripe can be mutated', () => {
    expect(migration).toContain('CREATE TABLE public.account_deletion_billing_operations')
    expect(migration).toContain("CHECK (state IN ('prepared', 'settled'))")
    expect(migration).toContain('CREATE UNIQUE INDEX account_deletion_billing_one_prepared_user')
    expect(migration).toContain('CREATE FUNCTION public.prepare_account_deletion_billing_atomic')
    expect(migration).toContain('public.schedule_account_deletion_with_billing_blocks(')
    expect(migration).toContain("'status', 'prepared'")
  })

  it('finishes only the exact prepared subject and a subscription superset', () => {
    const finish = migration.slice(
      migration.indexOf('CREATE FUNCTION public.finish_account_deletion_billing_atomic')
    )
    expect(finish).toContain('v_operation.user_id IS DISTINCT FROM p_user_id')
    expect(finish).toContain('v_operation.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id')
    expect(finish).toContain(
      'NOT v_operation.stripe_subscription_ids <@ v_normalized_subscription_ids'
    )
    expect(finish).toContain("SET state = 'settled'")
    expect(finish).toContain("block_kind = 'account_deletion'")
  })

  it('blocks recovery and hard deletion while remote billing is unsettled', () => {
    const claim = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.claim_account_recovery_admission_atomic'
      ),
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.admit_expired_account_hard_delete_atomic'
      )
    )
    expect(claim).toContain("operation.state = 'prepared'")
    expect(claim).toContain("RETURN 'busy'")

    const hardDelete = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.admit_expired_account_hard_delete_atomic'
      )
    )
    expect(hardDelete).toContain("v_status := 'billing_settlement_in_progress'")
    expect(hardDelete).toContain("operation.state = 'prepared'")
  })

  it('keeps table writes private and exposes only service-role functions', () => {
    expect(migration).toContain(
      'ALTER TABLE public.account_deletion_billing_operations FORCE ROW LEVEL SECURITY'
    )
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.account_deletion_billing_operations\n  FROM PUBLIC, anon, authenticated, authenticator'
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.prepare_account_deletion_billing_atomic'
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.finish_account_deletion_billing_atomic'
    )
  })

  it('ships after every account lifecycle dependency in ordered predeploy', () => {
    const predeploy = runner.match(/PREDEPLOY_MIGRATIONS=\(([\s\S]*?)\n\)/)?.[1] ?? ''
    expect(predeploy).toContain(migrationName)
    expect(predeploy.indexOf(migrationName)).toBeGreaterThan(
      predeploy.indexOf('20260729075600_verified_auth_profile_ban_authority.sql')
    )
  })

  it('has a PostgreSQL 17 replay, ACL, and crash-window proof', () => {
    expect(pg17Proof).toContain('$prepared_blocks_recovery$')
    expect(pg17Proof).toContain('$settled_allows_recovery$')
    expect(pg17Proof).toContain('$prepared_blocks_hard_delete$')
    expect(pg17Proof).toContain('Account deletion billing intent PostgreSQL 17 proof passed')
  })
})
