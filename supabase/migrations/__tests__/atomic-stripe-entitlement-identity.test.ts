import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const additive = readFileSync(
  join(root, 'supabase/migrations/20260718183000_atomic_stripe_entitlement_identity.sql'),
  'utf8'
)
const runner = readFileSync(join(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const pg17Proof = readFileSync(
  join(root, 'supabase/migrations/__tests__/atomic-stripe-entitlement-identity.pg17.sh'),
  'utf8'
)

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`)
  const end = source.indexOf(`ALTER FUNCTION public.${name}`, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('atomic Stripe entitlement payment authority', () => {
  it('keeps PREDEPLOY strictly additive and preserves canonical authority', () => {
    expect(additive).toContain('BEGIN;')
    expect(additive).toContain('COMMIT;')
    expect(additive).not.toMatch(/^\s*DROP\s/im)
    expect(additive).not.toContain(
      'CREATE OR REPLACE FUNCTION public.has_current_global_pro_entitlement'
    )
    expect(additive).toContain('CREATE UNIQUE INDEX uq_payment_history_invoice_conflict_target')
    expect(additive).toContain('CREATE UNIQUE INDEX uq_payment_history_pi_conflict_target')
    expect(additive).toContain('index_row.indpred IS NOT NULL')
    expect(additive).toContain('index_row.indexprs IS NOT NULL')
  })

  it('creates immutable payment, reservation, trial, grant, refund and effect ledgers', () => {
    for (const relation of [
      'stripe_entitlement_payments',
      'stripe_charge_refund_tombstones',
      'stripe_charge_refund_tombstone_events',
      'stripe_lifetime_seat_reservations',
      'stripe_legacy_lifetime_seat_claims',
      'stripe_trial_entitlements',
      'stripe_subscription_state_events',
      'pro_entitlement_grants',
      'stripe_manual_reviews',
      'stripe_entitlement_refund_events',
      'stripe_entitlement_effects',
    ]) {
      expect(additive).toContain(`CREATE TABLE public.${relation}`)
      expect(additive).toContain(`ALTER TABLE public.${relation} OWNER TO postgres`)
      expect(additive).toMatch(
        new RegExp(`ALTER TABLE public\\.${relation}\\s+ENABLE ROW LEVEL SECURITY`)
      )
      expect(additive).toMatch(
        new RegExp(`ALTER TABLE public\\.${relation}\\s+FORCE ROW LEVEL SECURITY`)
      )
    }
    expect(additive).toContain('REFERENCES public.user_profiles(id) ON DELETE SET NULL')
    expect(additive).toContain(
      'payable lifetime reservation identity must survive profile deletion'
    )
    expect(additive).toContain('durable legacy lifetime seat claim must survive profile deletion')
    expect(additive).toContain(
      'REFERENCES public.stripe_entitlement_payments(id) ON DELETE RESTRICT'
    )
  })

  it('uses identity-complete recurring, lifetime and refund RPC contracts', () => {
    const recurring = functionBody(additive, 'activate_recurring_entitlement_payment_atomic')
    const lifetime = functionBody(additive, 'activate_lifetime_membership_with_identity_atomic')
    const refund = functionBody(additive, 'reconcile_stripe_entitlement_refund_atomic')

    expect(recurring).toContain('p_stripe_payment_intent_id text')
    expect(recurring).toContain('p_stripe_charge_id text')
    expect(recurring).toContain('p_stripe_invoice_id text')
    expect(recurring).toContain('p_stripe_payment_intent_id IS NOT NULL\n      AND pg_catalog.left')
    expect(lifetime).toContain('p_reservation_id uuid')
    expect(lifetime).toContain('v_safe_refund_identity')
    expect(lifetime).toContain("'reservation_refund_queued'")
    expect(lifetime).toContain("'duplicate_refund_queued'")
    expect(lifetime).toContain("'payment_auto_refund'")
    expect(refund).toContain('v_effective_user_id uuid := p_user_id')
    expect(refund).toContain('CASE WHEN v_profile_exists THEN v_effective_user_id ELSE NULL END')
    expect(refund).toContain("release_reason = 'payment_fully_refunded'")
  })

  it('makes refund redelivery observable while full refund remains terminal', () => {
    const refund = functionBody(additive, 'reconcile_stripe_entitlement_refund_atomic')

    expect(additive).toContain("observations jsonb NOT NULL DEFAULT '[]'::jsonb")
    expect(refund).toContain('observations || pg_catalog.jsonb_build_array')
    expect(refund).toContain("'full_refund_terminal_conflict'")
    expect(refund).toContain("'ambiguous_refund_event_order'")
    expect(refund).toContain("status = 'superseded'")
    expect(refund).toContain("'payment_fully_refunded'")
  })

  it('fences side effects with DB lease tokens and exact source replay', () => {
    const lease = functionBody(additive, 'lease_stripe_entitlement_effects_atomic')
    const finish = functionBody(additive, 'finish_stripe_entitlement_effect_atomic')

    expect(additive).toContain("'superseded'")
    expect(additive).toContain("'dead_lettered'")
    expect(lease).toContain('pg_catalog.gen_random_uuid()')
    expect(lease).toContain("status IN ('pending', 'failed')")
    expect(finish).toContain('lease_token IS DISTINCT FROM p_lease_token')
    expect(finish).toContain("'lease_lost'")
    expect(finish).toContain("'authority_superseded'")
    expect(finish).toContain('v_effect.external_ref IS NOT DISTINCT FROM p_external_ref')
    expect(additive).not.toMatch(/effect_type[^;\n]*nft/i)
  })

  it('exposes the exact nine-key paid launch readiness gate', () => {
    const readiness = functionBody(additive, 'stripe_paid_launch_readiness_v2')
    for (const key of [
      'status',
      'open_manual_reviews',
      'unfinished_effects',
      'completed_effects_without_external_ref',
      'paid_unbound_payments',
      'unresolved_refund_tombstones',
      'reservation_anomalies',
      'projection_drift',
      'authority_drift',
    ]) {
      expect(readiness).toContain(`'${key}'`)
    }
    expect(readiness).toContain("'dead_lettered'")
    expect(readiness).not.toContain("effect.status = 'superseded'")
    expect(readiness).toContain('20260718183000_rolling_legacy_writer')
    expect(readiness).toContain('stripe_legacy_lifetime_seat_claims')
  })

  it('fails the legacy lifetime pre-check closed and durably quarantines late writers', () => {
    const check = functionBody(additive, 'check_lifetime_spots_available')
    const legacyActivate = functionBody(additive, 'activate_lifetime_membership')
    const count = functionBody(additive, 'stripe_lifetime_claimed_seat_count_v2')

    expect(check).toContain('RETURN false;')
    expect(check).not.toContain('stripe_lifetime_claimed_seat_count_v2')
    expect(legacyActivate).toContain('stripe-lifetime-seat-capacity')
    expect(legacyActivate).toContain('stripe_legacy_lifetime_seat_claims')
    expect(legacyActivate).toContain('legacy_lifetime_requires_exact_reconciliation')
    expect(legacyActivate).toContain('legacy_lifetime_sold_out_paid_review')
    expect(count).toContain('stripe_legacy_lifetime_seat_claims')
    expect(count).toContain(
      'payment.checkout_session_id =\n                reservation.checkout_session_id'
    )
  })

  it('binds Stripe customer ownership with an idempotent service-only CAS', () => {
    const bind = functionBody(additive, 'bind_stripe_customer_owner_atomic')

    expect(bind).toContain("IS DISTINCT FROM 'service_role'")
    expect(bind).toContain("'stripe-customer-owner:' || p_new_stripe_customer_id")
    expect(bind).toContain('IS DISTINCT FROM p_expected_previous_stripe_customer_id')
    expect(bind).toContain("'already_bound'")
    expect(bind).toContain("'identity_conflict'")
    expect(bind).toContain("'bound'")
    expect(additive).toContain('GRANT EXECUTE ON FUNCTION public.bind_stripe_customer_owner_atomic')
  })

  it('keeps the launch runner aligned with PREDEPLOY only', () => {
    expect(runner).toContain('20260718183000_atomic_stripe_entitlement_identity.sql')
  })

  it('ships PostgreSQL 17 PREDEPLOY proofs for identity and refund fencing', () => {
    for (const marker of [
      'unsupported Stripe-shaped projection',
      'ambiguous profile-only projection was mutated or evicted',
      'pre-migration lifetime sale was not backfilled and deduplicated',
      'hard deletion erased or double-counted a historical lifetime seat',
      'ownerless PI-null direct Charge tombstone was not preserved',
      'same refund event created a second Charge parent left-first',
      'ledger-first direct Charge created an orphan tombstone parent',
      'tombstone-first direct Charge did not merge before activation',
      'direct Charge full refund terminal aggregate was reversed',
      'activation merge did not absorb full refund and release bound seat',
      'merged replay after newer payment refund was not idempotent',
      'full projection sweep did not converge non-expiry drift',
      'readiness JSON keys drifted',
      'atomic Stripe payment-period authority PREDEPLOY PostgreSQL 17 proof passed',
    ]) {
      expect(pg17Proof).toContain(marker)
    }
  })
})
