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
const apiKeyRoute = readFileSync(join(process.cwd(), 'app/api/user/api-keys/route.ts'), 'utf8')

describe('API tier Stripe event ledger contract', () => {
  it('installs the exact nineteen-argument identity-bound authority', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.apply_user_api_tier_stripe_event('
    )
    for (const argument of [
      'p_user_id uuid',
      'p_metadata_user_id uuid',
      'p_metadata_supabase_user_id uuid',
      'p_stripe_customer_id text',
      'p_checkout_reservation_id uuid',
      'p_stripe_price_id text',
      'p_api_tier text',
      'p_daily_limit integer',
      'p_stripe_subscription_id text',
      'p_subscription_created bigint',
      'p_stripe_event_id text',
      'p_event_created bigint',
      'p_is_active boolean',
      'p_is_terminal boolean',
      'p_livemode boolean',
      'p_checkout_session_id text',
      'p_checkout_api_plan text',
      'p_checkout_price_id text',
      'p_identity_source text',
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
    expect(migration).not.toContain('api_tier_stripe_event_ledger_user_fkey')
    expect(migration).toContain('metadata_user_id = user_id')
    expect(migration).toContain('metadata_supabase_user_id = user_id')
    expect(migration).toContain('FOREIGN KEY (checkout_reservation_id)')
    expect(migration).toContain("stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'")
    expect(migration).toContain("stripe_price_id ~ '^price_[A-Za-z0-9_]+$'")
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
    expect(migration).toContain("identity_source IN ('signed_metadata', 'persisted_subscription')")
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.apply_user_api_tier_persisted_non_grant_event('
    )
    expect(pg17Proof).toContain('current-profile persisted terminal did not revoke exactly')
    expect(pg17Proof).toContain('persisted old terminal changed the newer subscription')
    expect(pg17Proof).toContain('ordinary subscription did not remain outside API authority')
    expect(pg17Proof).toContain('persisted suspension did not recover on a later active event')
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
      'ledger.is_active ASC,',
      'ledger.stripe_event_id DESC',
    ].join('\n      ')

    expect(migration).toContain(stateOrder)
    expect(migration).toContain('SELECT pg_catalog.max(state.subscription_created)')
    expect(migration).toContain('equally-created active API subscriptions are ambiguous')
    expect(pg17Proof).toContain('evt_newest_impossible_reactivation')
    expect(pg17Proof).toContain('current terminal did not fall back to older active state')
    expect(pg17Proof).toContain('same-second terminal did not durably revoke paid quota')
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

  it('creates later API keys from the same locked current entitlement', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.create_user_api_key_with_current_entitlement('
    )
    expect(migration).toContain("p_key !~ '^arena_sk_[0-9a-f]{32}$'")
    expect(migration).toContain("MESSAGE = 'maximum 5 active API keys allowed'")
    expect(migration).toContain("'tier', v_tier")
    expect(migration).toContain("'daily_limit', v_daily_limit")
    expect(apiKeyRoute).toContain("supabase.rpc('create_user_api_key_with_current_entitlement'")
    expect(apiKeyRoute).not.toContain("tier: 'free', daily_limit: 100")
    expect(pg17Proof).toContain('paid user API key did not inherit the locked current entitlement')
    expect(pg17Proof).toContain('hostile API key entitlement grant survived migration replay')
  })

  it('revokes copied API credentials when the account becomes inactive', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.quiesce_inactive_user_api_access()'
    )
    expect(migration).toContain('BEFORE UPDATE OF deleted_at, banned_at, is_banned')
    expect(migration).toContain('active = false')
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.increment_api_key_usage(p_key text)'
    )
    expect(migration).toContain('AND profile.deleted_at IS NULL')
    expect(migration).toContain('AND profile.banned_at IS NULL')
    expect(migration).toContain('AND NOT COALESCE(profile.is_banned, false)')
    expect(migration).toContain("RETURN 'subject_deleted'")
    expect(pg17Proof).toContain('soft-deleted account retained a usable API key')
    expect(pg17Proof).toContain('hard-deleted account erased durable API billing identity')
  })

  it('permanently blocks deleted subscriptions without blocking a fresh checkout', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.api_tier_subscription_blocks')
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.schedule_account_deletion_with_billing_blocks('
    )
    expect(migration).toContain("'account_deletion'")
    expect(migration).toContain("'financial_reversal'")
    expect(migration).toContain('FROM public.api_tier_subscription_blocks AS block')
    expect(migration).toContain("RETURN 'blocked'")
    expect(migration).toContain('NEW.api_stripe_subscription_id := NULL')
    expect(pg17Proof).toContain(
      'restored account accepted its permanently blocked old subscription'
    )
    expect(pg17Proof).toContain('restored account could not grant a distinct fresh subscription')
  })

  it('converges the old and new authority ACLs to their exact boundaries', () => {
    expect(migration).toContain(
      "'public.update_user_api_tier(uuid,text,text,integer)'::pg_catalog.regprocedure"
    )
    expect(migration).toContain(
      "'public.apply_user_api_tier_stripe_event(uuid,uuid,uuid,text,uuid,text,text,integer,text,bigint,text,bigint,boolean,boolean,boolean,text,text,text,text)'::pg_catalog.regprocedure"
    )
    expect(migration).toContain(
      'GRANT EXECUTE\n  ON FUNCTION public.apply_user_api_tier_stripe_event('
    )
    expect(migration).toContain(
      'legacy API tier compatibility updater is not exact service-only EXECUTE'
    )
    expect(migration).toContain('API tier Stripe event ledger is not owner-only')
    expect(pg17Proof).toContain('PUBLIC EXECUTE survived migration replay')
    expect(pg17Proof).toContain(
      'legacy compatibility updater was unavailable during additive rollout'
    )
    expect(pg17Proof).toContain('PUBLIC reservation authority EXECUTE survived migration replay')
    expect(pg17Proof).toContain('hostile reservation table grant survived migration replay')
    expect(pg17Proof).toContain('reservation authority overload was accepted')
    expect(pg17Proof).toContain('hostile reservation authority owner was accepted')
  })

  it('serializes checkout reservation, exact atomic conversion, and signed release', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.api_tier_checkout_reservations')
    expect(migration).toContain('api_tier_checkout_reservations_active_user_mode_idx')
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.reserve_api_tier_checkout_atomic('
    )
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.bind_api_tier_checkout_session_atomic('
    )
    expect(migration).not.toContain('confirm_api_tier_checkout_subscription_atomic')
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.release_api_tier_checkout_reservation_atomic('
    )
    expect(migration).not.toContain('p_stripe_event_created < v_reservation.checkout_expires_at')
    expect(migration).toContain(
      'pg_catalog.floor(\n      extract(epoch FROM v_reservation.created_at)\n    )::bigint'
    )
    expect(migration).toContain("status = 'converted'\n        AND checkout_session_id IS NOT NULL")
    expect(migration).toContain("v_reservation.status <> 'converted'")
    expect(migration).toContain("p_identity_source = 'signed_metadata'")
    expect(migration).toContain('v_reservation.checkout_session_id <> p_checkout_session_id')
    expect(migration).toContain('v_reservation.stripe_price_id <> p_checkout_price_id')
    expect(migration).toContain(
      "MESSAGE = 'new API subscription is missing its checkout reservation identity'"
    )
    expect(pg17Proof).toContain('double checkout did not converge to one reservation')
    expect(pg17Proof).toContain('existing reservation accepted a changed Stripe customer')
    expect(pg17Proof).toContain('exact early checkout expiration was not idempotent')
    expect(pg17Proof).toContain('unbound reservation granted an API subscription')
    expect(pg17Proof).toContain('reservation accepted another Checkout Session')
    expect(pg17Proof).toContain('post-conversion failure did not roll back reservation and quota')
    expect(pg17Proof).toContain('failed atomic apply did not preserve the reusable bound Session')
    expect(pg17Proof).toContain('pre-creation checkout expiration was accepted')
    expect(pg17Proof).toContain('confirmed reservation did not grant atomically')
    expect(pg17Proof).toContain('atomic Checkout grant replay was not idempotent')
  })

  it('rejects unpaid Portal price changes but keeps cancellation fail-closed', () => {
    expect(migration).toContain('ledger.stripe_price_id = p_stripe_price_id')
    expect(migration).toContain('v_reservation.stripe_price_id <> p_stripe_price_id')
    expect(pg17Proof).toContain('mismatched metadata UUID aliases were accepted')
    expect(pg17Proof).toContain('mismatched Stripe customer was accepted')
    expect(migration).toContain('API plan or price change requires separate paid authority')
    expect(pg17Proof).toContain('unpaid Billing Portal price change was accepted')
    expect(pg17Proof).toContain('rejected Billing Portal price change mutated entitlement state')
    expect(pg17Proof).toContain('current subscription cancellation did not revoke quota')
  })

  it('uses the exact inherit/set/admin-aware Supabase role graph pre and postflight', () => {
    expect(migration.match(/membership\.inherit_option/g)?.length).toBeGreaterThanOrEqual(16)
    expect(migration.match(/membership\.set_option/g)?.length).toBeGreaterThanOrEqual(14)
    expect(migration.match(/membership\.admin_option/g)?.length).toBeGreaterThanOrEqual(16)
    expect(migration.match(/cli_login_postgres/g)).toHaveLength(2)
    expect(migration.match(/browser_authority/g)?.length).toBeGreaterThanOrEqual(4)
    expect(pg17Proof).toContain('GRANT service_role TO hostile_role WITH INHERIT TRUE, SET FALSE')
    expect(pg17Proof).toContain('GRANT authenticator TO hostile_role WITH INHERIT FALSE, SET TRUE')
    expect(pg17Proof).toContain(
      'GRANT authenticator TO hostile_role\n  WITH ADMIN TRUE, INHERIT FALSE, SET FALSE'
    )
    expect(pg17Proof).toContain('hostile ADMIN-only chain through authenticator was accepted')
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
    expect(pg17Proof).toContain('unexpected ledger constraint survived replay')
    expect(pg17Proof).toContain('wrong ledger recorded_at default survived replay')
    expect(pg17Proof).toContain('extra ledger column survived replay')
    expect(pg17Proof).toContain('ledger write trigger survived replay')
    expect(pg17Proof).toContain('same-name wrong ledger index survived replay')
    expect(pg17Proof).toContain('same-name wrong reservation plan CHECK survived replay')
    expect(pg17Proof).toContain('wrong reservation updated_at default survived replay')
    expect(pg17Proof).toContain('extra reservation column survived replay')
    expect(pg17Proof).toContain('reservation write trigger survived replay')
    expect(pg17Proof).toContain('reservation RLS policy survived replay')
    expect(pg17Proof).toContain('reservation write rule survived replay')
    expect(pg17Proof).toContain('same-name wrong reservation partial index survived replay')
  })
})
