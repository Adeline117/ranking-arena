import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase/migrations/20260718184500_classify_non_entitlement_stripe_payments.sql'),
  'utf8'
)
const runner = readFileSync(join(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const databaseTypes = readFileSync(join(root, 'lib/supabase/database.types.ts'), 'utf8')
const pg17 = readFileSync(
  join(root, 'supabase/migrations/__tests__/non-entitlement-stripe-ownership.pg17.sh'),
  'utf8'
)
const fixture = readFileSync(
  join(root, 'supabase/migrations/__tests__/non-entitlement-stripe-ownership.fixture.psql'),
  'utf8'
)
const productionGroupPg17 = readFileSync(
  join(
    root,
    'supabase/migrations/__tests__/non-entitlement-stripe-ownership.production-group.pg17.sh'
  ),
  'utf8'
)
const productionGroupSetup = readFileSync(
  join(
    root,
    'supabase/migrations/__tests__/non-entitlement-stripe-ownership.production-group.setup.psql'
  ),
  'utf8'
)
const productionGroupFixture = readFileSync(
  join(
    root,
    'supabase/migrations/__tests__/non-entitlement-stripe-ownership.production-group.fixture.psql'
  ),
  'utf8'
)
const entitlementPg17 = readFileSync(
  join(root, 'supabase/migrations/__tests__/atomic-stripe-entitlement-identity.pg17.sh'),
  'utf8'
)

function functionBody(name: string): string {
  const startMatch = new RegExp(`CREATE OR REPLACE FUNCTION\\s+public\\.${name}`).exec(migration)
  const start = startMatch?.index ?? -1
  const endMatch = new RegExp(`ALTER FUNCTION\\s+public\\.${name}`).exec(
    migration.slice(Math.max(0, start))
  )
  const end = endMatch ? start + endMatch.index : -1
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end)
}

describe('non-entitlement Stripe payment ownership', () => {
  it('creates one service-only immutable global ownership ledger', () => {
    expect(migration).toContain('CREATE TABLE public.stripe_payment_ownerships')
    expect(migration).toContain("product_kind IN ('pro_entitlement', 'tip', 'group_pass')")
    expect(migration).toContain('UNIQUE (product_kind, ledger_id)')
    expect(migration).toContain('UNIQUE (stripe_charge_id)')
    expect(migration).toContain('stripe_payment_ownerships_pi_key')
    expect(migration).toContain('stripe_payment_ownerships_session_key')
    expect(migration).toContain('FORCE ROW LEVEL SECURITY')
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON public.stripe_payment_ownerships')
    expect(migration).toContain('REVOKE ALL ON TABLE public.stripe_payment_ownerships')
    expect(migration).toContain(
      'GRANT SELECT ON TABLE public.stripe_payment_ownerships TO service_role'
    )
  })

  it('re-queries product ledgers and serializes Charge before PaymentIntent', () => {
    const claim = functionBody('claim_stripe_payment_ownership_atomic')
    const chargeLock = claim.indexOf("'stripe-charge-refund:' || p_stripe_charge_id")
    const paymentIntentLock = claim.indexOf(
      "'stripe-payment-identity:' || p_stripe_payment_intent_id"
    )
    const checkoutSessionLock = claim.indexOf("'stripe-checkout-session:' || v_session_id")
    expect(chargeLock).toBeGreaterThanOrEqual(0)
    expect(paymentIntentLock).toBeGreaterThan(chargeLock)
    expect(checkoutSessionLock).toBeGreaterThan(paymentIntentLock)
    expect(claim).toContain('FROM public.stripe_entitlement_payments AS payment')
    expect(claim).toContain('FROM public.tips AS tip')
    expect(claim).toContain('FROM public.group_payment_consumptions AS consumption')
    expect(claim).not.toMatch(/p_product_kind|p_ledger_id/)
    expect(claim).toContain("'cross_product_payment_identity_conflict'")
    expect(claim).toContain('v_candidate_count IS DISTINCT FROM 1')
  })

  it('makes Pro insertion fail non-entitling when central ownership conflicts', () => {
    const trigger = functionBody('claim_new_pro_payment_ownership')
    const merge = functionBody('stripe_merge_charge_refund_tombstone_v2')
    expect(migration).toContain("payment_status IN ('paid', 'succeeded', 'ownership_conflict')")
    expect(trigger).toContain('public.claim_stripe_payment_ownership_atomic')
    expect(trigger).toContain("SET payment_status = 'ownership_conflict'")
    expect(trigger).toContain('Do not leave a false Pro ledger row')
    expect(trigger).toContain('DELETE FROM public.stripe_entitlement_payments')
    expect(migration).toContain('AFTER INSERT ON public.stripe_entitlement_payments')
    expect(merge).toContain("'unclaimed_entitlement_payment'")
    expect(merge).toContain("v_tombstone.resolution_kind = 'non_entitlement_payment'")
    expect(merge).toContain("resolution_reference = 'ownership:' || v_ownership.id::text")
  })

  it('supports exact tip and group writers without trusting caller ledger claims', () => {
    expect(migration).toContain('tips_stripe_payment_intent_unique')
    expect(migration).toContain('tips_stripe_checkout_session_unique')
    expect(migration).toContain('tips_stripe_charge_unique')
    expect(migration).toContain('trg_tips_payment_identity_immutable')
    expect(migration).toContain('group_payment_consumptions_charge_unique')
    expect(migration).toContain('payment_member_joined_at timestamptz')
    expect(migration).toContain('trg_group_payment_consumptions_immutable')

    const tip = functionBody('complete_tip_with_stripe_ownership_atomic')
    const group = functionBody('activate_group_subscription_with_stripe_ownership_atomic')
    const bind = functionBody('bind_group_pass_stripe_ownership_atomic')
    expect(tip).toContain('FROM public.tips AS tip')
    expect(tip).toContain('FOR UPDATE')
    expect(tip).toContain('public.claim_stripe_payment_ownership_atomic')
    expect(tip).toContain('webhook during the additive application-deploy window')
    expect(tip).toContain("WHEN v_tip.status = 'refunded'")
    expect(group).toContain('public.activate_group_subscription_atomic')
    expect(group).toContain('public.bind_group_pass_stripe_ownership_atomic')
    expect(group).toContain('v_payment_member_joined_at')
    expect(bind).toContain('p_payment_member_joined_at timestamptz')
    expect(bind).toContain("'group-membership:' || v_consumption.group_id::text")
    expect(bind).toContain('v_current_member_joined_at IS DISTINCT FROM')
    expect(group).toContain('Roll back every grant row')
    expect(group).toContain("'refund_blocked'")
    expect(group).toContain('without touching subscription/member tables')
    expect(group).toContain('ownership.checkout_session_id = p_checkout_session_id')
    expect(group).toContain('tip.stripe_checkout_session_id = p_checkout_session_id')
    expect(group).toContain("'group_pass_post_grant_ownership_conflict'")
    expect(group).toContain('EXCEPTION')

    const publicGrant = migration.slice(
      migration.indexOf('GRANT EXECUTE ON FUNCTION'),
      migration.indexOf(
        'REVOKE ALL ON FUNCTION\n  public.prevent_stripe_payment_ownership_mutation()'
      )
    )
    expect(publicGrant).not.toContain('bind_group_pass_stripe_ownership_atomic')
  })

  it('classifies non-entitlement tombstones only with exact ownership and event chains', () => {
    const resolver = functionBody('stripe_resolve_non_entitlement_refund_tombstone_atomic')
    const readiness = functionBody('stripe_paid_launch_readiness_v2')
    const recorder = functionBody('record_charge_refund_tombstone_atomic')
    expect(migration).toContain("resolution_kind = 'non_entitlement_payment'")
    expect(migration).toContain('resolution_ownership_id uuid')
    expect(resolver).toContain('stripe_payment_ownership_is_exact_v2')
    expect(resolver).toContain('refund_snapshot_event_id')
    expect(resolver).toContain('latest_refund_event_id')
    expect(resolver).toContain("'cross_product_tombstone_resolution_conflict'")
    expect(resolver).toContain('Classification is not projection completion')
    expect(resolver).toContain("'group_pass_full_refund_revocation_required'")
    expect(migration).not.toContain('group_pass_refund_revocation_acks_ownership_key')
    expect(migration).not.toContain('group_pass_refund_revocation_acks_charge_key')
    expect(migration).toContain('group_pass_refund_revocation_acks_snapshot_key')
    expect(recorder).toContain('record_charge_refund_tombstone_financial_legacy_v2')
    expect(recorder).toContain('public.claim_stripe_payment_ownership_atomic')
    expect(readiness).toContain('stripe_refund_tombstone_is_resolved_v2')
    expect(readiness).toContain('v_unresolved_refund_tombstones')
    expect(readiness).toContain('v_authority_drift')
    expect(readiness).toContain('tip.stripe_charge_id IS NOT NULL')
    expect(readiness).toContain('consumption.stripe_charge_id IS NOT NULL')
    expect(readiness).toContain("tip.status IN ('completed', 'refunded')")
    expect(readiness).toContain("consumption.outcome IN ('activated', 'renewed')")
  })

  it('is ordered PREDEPLOY and keeps generated contracts synchronized', () => {
    const file = '20260718184500_classify_non_entitlement_stripe_payments.sql'
    const predeployStart = runner.indexOf('PREDEPLOY_MIGRATIONS=(')
    const postdeployStart = runner.indexOf('POSTDEPLOY_MIGRATIONS=(')
    expect(runner.slice(predeployStart, postdeployStart)).toContain(file)
    expect(runner.slice(postdeployStart)).not.toContain(file)
    expect(runner.indexOf(file)).toBeGreaterThan(
      runner.indexOf('20260718184000_arena_score_inputs_board_as_of.sql')
    )
    expect(migration).toContain("SET LOCAL lock_timeout = '5s';")

    expect(databaseTypes).toContain('stripe_payment_ownerships: {')
    expect(databaseTypes).toContain('resolution_ownership_id: string | null')
    expect(databaseTypes).toContain('claim_stripe_payment_ownership_atomic: {')
    expect(databaseTypes).toContain('complete_tip_with_stripe_ownership_atomic: {')
    expect(databaseTypes).toContain('activate_group_subscription_with_stripe_ownership_atomic: {')
    expect(databaseTypes).toContain('payment_member_joined_at: string | null')
    expect(databaseTypes).toContain('p_payment_member_joined_at: string | null')
  })

  it('ships a real PG17 refund-first, concurrency, conflict and readiness proof', () => {
    expect(pg17).toContain('20260718183500_harden_stripe_entitlement_null_validation.sql')
    expect(pg17).toContain('20260718183600_fix_stripe_lifetime_duplicate_and_early_expiry.sql')
    expect(pg17).toContain('20260718184500_classify_non_entitlement_stripe_payments.sql')
    expect(fixture).toContain('$refund_first_tip_writer_later$')
    expect(fixture).toContain('$refund_first_group_writer_later$')
    expect(fixture).toContain('$payment_first_tip_partial_then_full$')
    expect(fixture).toContain('$payment_first_group_partial_then_full$')
    expect(fixture).toContain('$recreated_plain_member_is_not_payment_provenance$')
    expect(fixture).toContain('$legacy_joined_replay_cannot_infer_member_provenance$')
    expect(fixture).toContain('$preexisting_member_is_never_payment_revocation_state$')
    expect(fixture).toContain('$multi_payment_subscription_stays_manual_review$')
    expect(fixture).toContain('evt_nonentitlement_payment_first_group_full_later')
    expect(fixture).toContain('$concurrent_claim$')
    expect(fixture).toContain('$concurrent_group_session_claim$')
    expect(fixture).toContain('$cross_product_conflicts_fail_closed$')
    expect(fixture).toContain('$post_grant_claim_failure_is_durable$')
    expect(fixture).toContain('$readiness_zero$')
    expect(fixture).toContain('cs_nonentitlement_unclaimed_tip')
    expect(fixture).toContain('ch_nonentitlement_unclaimed_readiness')
    expect(fixture).toContain('Non-entitlement Stripe payment ownership fixture passed')
  })

  it('ships a production-ordered proof with the real atomic group writer', () => {
    expect(productionGroupPg17).toContain('STRIPE_ENTITLEMENT_EXTRA_SETUP_SQLS')
    expect(productionGroupPg17).toContain('20260716176000_atomic_group_pass.sql')
    expect(productionGroupPg17).toContain(
      '20260718184500_classify_non_entitlement_stripe_payments.sql'
    )
    expect(entitlementPg17).toContain(
      'MIGRATION="$ROOT_DIR/supabase/migrations/20260718183000_atomic_stripe_entitlement_identity.sql"'
    )
    expect(entitlementPg17.indexOf('psql_cmd -f "$extra_setup"')).toBeLessThan(
      entitlementPg17.indexOf('psql_cmd -f "$MIGRATION"')
    )
    expect(productionGroupSetup).toContain(
      "CREATE TYPE public.member_role AS ENUM ('owner', 'admin', 'member')"
    )
    expect(productionGroupSetup).not.toContain(
      'CREATE FUNCTION public.activate_group_subscription_atomic'
    )
    expect(productionGroupFixture).toContain('$production_group_exact_writer_and_refund$')
    expect(productionGroupFixture).toContain(
      '$production_group_legacy_replay_cannot_guess_provenance$'
    )
    expect(productionGroupFixture).toContain('$production_group_private_binder_acl$')
  })
})
