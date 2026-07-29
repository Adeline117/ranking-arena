import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729020000_api_tier_cancellation_identity.sql'),
  'utf8'
)
const pg17Proof = readFileSync(
  join(process.cwd(), 'supabase/migrations/__tests__/api-tier-cancellation-identity.pg17.sh'),
  'utf8'
)

describe('API tier Stripe event ledger contract', () => {
  it('installs the exact ten-argument server authority', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.apply_user_api_tier_stripe_event('
    )
    for (const argument of [
      'p_user_id uuid',
      'p_api_tier text',
      'p_daily_limit integer',
      'p_stripe_subscription_id text',
      'p_subscription_created bigint',
      'p_stripe_event_id text',
      'p_event_created bigint',
      'p_is_active boolean',
      'p_is_terminal boolean',
      'p_livemode boolean',
    ]) {
      expect(migration).toContain(argument)
    }
    expect(migration).toContain('RETURNS text')
    expect(migration).toContain('SECURITY DEFINER')
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp')
    expect(migration).toContain('SET row_security = off')
  })

  it('persists immutable event identity and strict payload constraints', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.api_tier_stripe_event_ledger')
    expect(migration).toContain('PRIMARY KEY (livemode, stripe_event_id)')
    expect(migration).toContain('FOREIGN KEY (user_id)')
    expect(migration).toContain("stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'")
    expect(migration).toContain("stripe_event_id ~ '^evt_[A-Za-z0-9_]+$'")
    expect(migration).toContain('subscription_created <= stripe_event_created')
    expect(migration).toContain('subscription_created <= 253402300799')
    expect(migration).toContain('stripe_event_created <= 253402300799')
    expect(migration).toContain("(api_tier = 'starter' AND daily_limit = 10000)")
    expect(migration).toContain("(api_tier = 'pro' AND daily_limit = 0)")
    expect(migration).toContain('AND NOT is_terminal')
    expect(migration).toContain("OR (NOT is_active AND api_tier = 'free')")
    expect(migration).toContain('ON CONFLICT (livemode, stripe_event_id) DO NOTHING')
    expect(migration).toContain('Stripe event ID replayed with conflicting API tier payload')
  })

  it('seeds historical state only through the exact current subscription', () => {
    expect(migration).toContain('AND p_stripe_subscription_id <> v_current_subscription_id')
    expect(migration).toContain(
      'historical API subscription must be seeded by the same Stripe subscription ID'
    )
    expect(pg17Proof).toContain('an unseeded historical subscription accepted a different ID')
    expect(pg17Proof).toContain('evt_historical_seed')
  })

  it('makes terminal state sticky and selects the newest active subscription', () => {
    const stateOrder = [
      'ledger.stripe_subscription_id,',
      'ledger.is_terminal DESC,',
      'ledger.stripe_event_created DESC,',
      'ledger.stripe_event_id DESC',
    ].join('\n      ')

    expect(migration).toContain(stateOrder)
    expect(migration).toContain('SELECT pg_catalog.max(state.subscription_created)')
    expect(migration).toContain('equally-created active API subscriptions are ambiguous')
    expect(pg17Proof).toContain('evt_newest_impossible_reactivation')
    expect(pg17Proof).toContain('current terminal did not fall back to older active state')
    expect(pg17Proof).toContain('equally-created active subscriptions were not rejected')
    expect(pg17Proof).toContain('recoverable suspension did not revoke quota')
    expect(pg17Proof).toContain('recoverable subscription did not resume')
  })

  it('projects profile and active keys in the same function statement', () => {
    const profileUpdate = migration.indexOf('UPDATE public.user_profiles AS profile')
    const keyUpdate = migration.indexOf('UPDATE public.api_keys AS api_key')

    expect(profileUpdate).toBeGreaterThan(-1)
    expect(keyUpdate).toBeGreaterThan(profileUpdate)
    expect(migration).toContain('api_stripe_subscription_id = v_desired_subscription_id')
    expect(migration).toContain('WHERE api_key.user_id = p_user_id')
    expect(migration).toContain('AND api_key.active;')
    expect(pg17Proof).toContain('FORCE-RLS failure committed a partial event projection')
  })

  it('converges the old and new authority ACLs to their exact boundaries', () => {
    expect(migration).toContain(
      "'public.update_user_api_tier(uuid,text,text,integer)'::pg_catalog.regprocedure"
    )
    expect(migration).toContain(
      "'public.apply_user_api_tier_stripe_event(uuid,text,integer,text,bigint,text,bigint,boolean,boolean,boolean)'::pg_catalog.regprocedure"
    )
    expect(migration).toContain(
      'GRANT EXECUTE\n  ON FUNCTION public.apply_user_api_tier_stripe_event('
    )
    expect(migration).toContain('legacy unsequenced API tier updater is not owner-only')
    expect(migration).toContain('API tier Stripe event ledger is not owner-only')
    expect(pg17Proof).toContain('PUBLIC EXECUTE survived migration replay')
    expect(pg17Proof).toContain('legacy unsequenced updater grant survived migration replay')
  })

  it('uses the exact inherit/set-aware Supabase role graph pre and postflight', () => {
    expect(migration.match(/membership\.inherit_option/g)?.length).toBeGreaterThanOrEqual(16)
    expect(migration.match(/membership\.set_option/g)?.length).toBeGreaterThanOrEqual(14)
    expect(migration.match(/cli_login_postgres/g)).toHaveLength(2)
    expect(migration.match(/browser_authority/g)?.length).toBeGreaterThanOrEqual(4)
    expect(pg17Proof).toContain('GRANT service_role TO hostile_role WITH INHERIT TRUE, SET FALSE')
    expect(pg17Proof).toContain('GRANT authenticator TO hostile_role WITH INHERIT FALSE, SET TRUE')
    expect(pg17Proof).toContain('GRANT service_role TO authenticated WITH INHERIT FALSE, SET TRUE')
    expect(pg17Proof).toContain('FORCE RLS projection table was accepted')
  })

  it('seals ledger constraints, defaults, indexes, columns, and write hooks on replay', () => {
    expect(migration).toContain('v_expected_constraints jsonb')
    expect(migration).toContain('pg_catalog.pg_get_constraintdef')
    expect(migration).toContain('pg_catalog.pg_get_indexdef')
    expect(migration).toContain('attribute.attidentity')
    expect(migration).toContain('pg_catalog.pg_trigger')
    expect(migration).toContain('pg_catalog.pg_rewrite')
    expect(pg17Proof).toContain('same-name wrong daily-limit CHECK survived replay')
    expect(pg17Proof).toContain('same-name wrong ledger FK survived replay')
    expect(pg17Proof).toContain('wrong ledger recorded_at default survived replay')
    expect(pg17Proof).toContain('extra ledger column survived replay')
    expect(pg17Proof).toContain('ledger write trigger survived replay')
    expect(pg17Proof).toContain('same-name wrong ledger index survived replay')
  })
})
