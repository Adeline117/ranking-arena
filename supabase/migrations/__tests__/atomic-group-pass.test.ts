import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260716176000_atomic_group_pass.sql'),
  'utf8'
)
const databaseTypes = readFileSync(join(process.cwd(), 'lib/supabase/database.types.ts'), 'utf8')

describe('atomic paid-group pass migration', () => {
  it('installs immutable one-time payment and trial ledgers', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.group_payment_consumptions')
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.group_trial_consumptions')
    expect(migration).toContain('UNIQUE (provider, payment_intent_id)')
    expect(migration).toContain('group_payment_consumptions_checkout_session_unique')
    expect(migration).toContain('PRIMARY KEY (group_id, user_id)')
    expect(migration).toContain('group pass consumption ledgers are immutable')
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON public.group_payment_consumptions')
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON public.group_trial_consumptions')
    expect(migration).toContain('payment-intent consumption uniqueness drifted')
    expect(migration).toContain('checkout-session consumption uniqueness drifted')
    expect(migration).toContain('trial-consumption primary key drifted')
    expect(migration).toContain('trigger_row.tgtype = 27')
    expect(migration).toContain('group pass immutable ledger triggers drifted')
  })

  it('serializes each actor/group and Stripe credential before exact replay comparison', () => {
    expect(migration).toContain(
      "'group-membership:' || p_group_id::text || ':' || p_actor_id::text"
    )
    expect(migration).toContain("'group-payment-intent:stripe:' || p_payment_intent_id")
    expect(migration).toContain("'group-checkout-session:stripe:' || p_checkout_session_id")
    for (const field of [
      'payment_intent_id',
      'checkout_session_id',
      'group_id',
      'user_id',
      'tier',
      'amount_cents',
      'currency',
    ]) {
      expect(migration).toContain(`v_existing_consumption.${field}`)
    }
    expect(migration).toContain("jsonb_build_object('status', 'payment_replayed')")
    expect(migration).toContain("jsonb_build_object('idempotent_replay', true)")
  })

  it('applies subscription, renewal, membership, cancellation, and expiry atomically', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.activate_group_subscription_atomic'
    )
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.cancel_group_subscription_atomic'
    )
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.read_group_subscription_atomic')
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.expire_group_subscriptions()')
    expect(migration).toContain('INSERT INTO public.group_subscriptions')
    expect(migration).toContain('INSERT INTO public.group_members')
    expect(migration).toContain('GREATEST(v_subscription.expires_at, v_now)')
    expect(migration).toContain('cancel_at_period_end = true')
    expect(migration).toContain("WHERE status IN ('active', 'trialing')")
  })

  it('keeps 174 owner compatibility and dynamically reconverges server-only authority', () => {
    expect(migration).toContain('DO $converge_table_authority$')
    expect(migration).toContain('pg_catalog.aclexplode')
    expect(migration).toContain('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %s CASCADE')
    expect(migration).toContain('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY')
    expect(migration).toContain('service_role_manages_group_subscriptions')
    expect(migration).toContain('FULL JOIN actual')
    expect(migration).toContain('membership.member = v_authenticator')
    expect(migration).toContain('AND NOT membership.inherit_option')
    expect(migration).toContain('AND membership.set_option')
    expect(migration).toContain('membership.member NOT IN (v_authenticator, v_postgres)')
    expect(migration).toContain('WITH RECURSIVE service_inheritors(member_oid)')
    expect(migration).toContain('WITH RECURSIVE service_inherits(role_oid)')
    expect(migration).toContain('WITH RECURSIVE browser_authority(role_oid)')
    expect(migration).toContain("role_row.rolname = 'cli_login_postgres'")
    expect(migration).toContain('AND NOT managed_membership.inherit_option')
    expect(migration).toContain('AND managed_membership.set_option')
    expect(migration).toContain('atomic group pass service-role authority seal drifted')
  })

  it('exposes only actor-bound service RPCs and contains no presentation change', () => {
    expect(migration).toContain("auth.role()), '') IS DISTINCT FROM 'service_role'")
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.activate_group_subscription_atomic('
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.cancel_group_subscription_atomic(uuid, uuid)'
    )
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.read_group_subscription_atomic(uuid, uuid)'
    )
    expect(migration.match(/SET search_path = pg_catalog, pg_temp/g)).toHaveLength(5)
    expect(migration).not.toContain('SET search_path = pg_catalog, public')
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'")
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).not.toMatch(/(?:jsx|tsx|className|grid-template|tailwind)/i)
  })

  it('keeps generated client types aligned with the atomic pass boundary', () => {
    expect(databaseTypes).toContain('group_payment_consumptions: {')
    expect(databaseTypes).toContain('group_trial_consumptions: {')
    expect(databaseTypes).toContain('cancel_at_period_end: boolean')
    expect(databaseTypes).toContain('activate_group_subscription_atomic: {')
    expect(databaseTypes).toContain('cancel_group_subscription_atomic: {')
    expect(databaseTypes).toContain('read_group_subscription_atomic: {')
    expect(databaseTypes).toContain('p_payment_intent_id: string | null')
    expect(databaseTypes).toContain('p_checkout_session_id: string | null')
  })
})
