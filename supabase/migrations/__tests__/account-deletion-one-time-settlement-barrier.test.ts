import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260729022000_account_deletion_one_time_settlement_barrier.sql'
  ),
  'utf8'
)
const pg17Proof = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/__tests__/account-deletion-one-time-settlement-barrier.pg17.sh'
  ),
  'utf8'
)

describe('account deletion one-time settlement barrier migration', () => {
  it('retains immutable user, mode, Customer, Session, product, and provider status', () => {
    expect(migration).toContain('CREATE TABLE public.account_deletion_one_time_settlements')
    for (const column of [
      'user_id uuid NOT NULL',
      'livemode boolean NOT NULL',
      'stripe_customer_id text NOT NULL',
      'checkout_session_id text NOT NULL',
      'product_kind text NOT NULL',
      'ownership_status text NOT NULL',
      'stripe_status text NOT NULL',
      'payment_status text NOT NULL',
      'settlement_status text NOT NULL',
      'last_scan_token uuid NOT NULL',
    ]) {
      expect(migration).toContain(column)
    }
    expect(migration).toContain('UNIQUE (livemode, checkout_session_id)')
    expect(migration).toContain("product_kind IN ('lifetime', 'tip', 'group_pass', 'unknown')")
  })

  it('requires exact sorted scan observations and a locked profile Customer', () => {
    expect(migration).toContain('pg_catalog.jsonb_array_elements(p_observations)')
    expect(migration).toContain('v_session_id COLLATE "C" <= v_previous_session_id COLLATE "C"')
    expect(migration).toContain('v_customer_id IS DISTINCT FROM p_stripe_customer_id')
    expect(migration).toContain('FOR UPDATE')
    expect(migration).toContain('v_profile_customer_id IS DISTINCT FROM p_stripe_customer_id')
    expect(migration).toContain('settlement observation conflicts with durable Session identity')
  })

  it('keeps paid Sessions pending until exact financial ownership converges', () => {
    expect(migration).toContain('public.stripe_entitlement_payments')
    expect(migration).toContain('public.stripe_payment_ownerships')
    expect(migration).toContain('public.group_payment_consumptions')
    expect(migration).toContain("v_entitlement.payment_kind IS DISTINCT FROM 'lifetime'")
    expect(migration).toContain("v_ownership.product_kind IS DISTINCT FROM 'tip'")
    expect(migration).toContain("v_ownership.product_kind IS DISTINCT FROM 'group_pass'")
    expect(migration).toContain('v_tip_status IS NULL')
    expect(migration).toContain('v_group_outcome IS NULL')
    expect(migration).toContain("'pending_fulfillment'")
    expect(migration).toContain("'terminal_manual_review'")
  })

  it('fails closed unless a lifetime payment has one exact central ownership', () => {
    expect(migration).toContain("'public.stripe_payment_ownership_is_exact_v2(uuid)'")
    expect(migration).toContain("v_entitlement.payment_status IS DISTINCT FROM 'paid'")
    expect(migration).toContain("v_entitlement.payment_status IS DISTINCT FROM 'succeeded'")
    expect(migration).toContain("ownership.product_kind = 'pro_entitlement'")
    expect(migration).toContain('ownership.ledger_id = v_entitlement.id')
    expect(migration).toContain('v_lifetime_ownership_count IS DISTINCT FROM 1')
    expect(migration).toContain(
      'public.stripe_payment_ownership_is_exact_v2(\n                v_lifetime_ownership_id'
    )
    expect(migration).toContain("'account_deletion_one_time:lifetime_payment_status_conflict'")
    expect(migration).toContain("'account_deletion_one_time:lifetime_ownership_cardinality'")
    expect(migration).toContain("'account_deletion_one_time:lifetime_ownership_not_exact'")
    expect(migration).toContain("'lifetime_ownership_count', v_lifetime_ownership_count")
    expect(migration).toContain("'entitlement_payment_status', v_entitlement.payment_status")
  })

  it('blocks hard deletion on stale complete scans and pending local lifecycles', () => {
    expect(migration).toContain('settlement.last_scan_token IS DISTINCT FROM p_scan_token')
    expect(migration).toContain("reservation.status IN ('reserved', 'bound')")
    expect(migration).toContain("tip.status = 'pending'")
    expect(migration).toContain('tip.checkout_to_user_id = p_user_id')
    expect(migration).toContain('v_deletion_scheduled_at <= pg_catalog.clock_timestamp()')
    expect(migration).toContain(
      'public.check_account_deletion_one_time_settlements_ready(uuid, uuid)'
    )
  })

  it('proves exact lifetime authority and every fail-closed disposition in PG17', () => {
    expect(pg17Proof).toContain('$delayed_webhook_stays_pending$')
    expect(pg17Proof).toContain('$delayed_webhook_converges$')
    expect(pg17Proof).toContain('$lifetime_conflict_missing_duplicate_nonexact_reviewed$')
    expect(pg17Proof).toContain('$fully_refunded_lifetime_remains_terminal$')
    expect(pg17Proof).toContain('$manual_review_evidence_survives_hard_delete$')
    expect(pg17Proof).toContain('$unknown_product_is_durably_reviewed$')
    expect(pg17Proof).toContain('$missing_child_ledgers_are_not_fulfilled$')
    expect(pg17Proof).toContain('$expired_checkout_waits_for_local_lifecycle$')
    expect(pg17Proof).toContain('cs_lifetime_delayed')
    expect(pg17Proof).toContain('cs_lifetime_conflict')
    expect(pg17Proof).toContain('cs_lifetime_missing')
    expect(pg17Proof).toContain('cs_lifetime_duplicate')
    expect(pg17Proof).toContain('cs_lifetime_nonexact')
    expect(pg17Proof).toContain('cs_lifetime_refunded')
    expect(pg17Proof).toContain('cs_unknown_paid')
    expect(pg17Proof).toContain('cs_expired_exact')
    expect(pg17Proof).toContain('payment_status text NOT NULL')
    expect(pg17Proof).toContain('CREATE FUNCTION public.stripe_payment_ownership_is_exact_v2(')
  })

  it('keeps both mutation and readiness RPCs service-only', () => {
    expect(migration).toContain('public.sync_account_deletion_one_time_settlements(')
    expect(migration).toContain('public.check_account_deletion_one_time_settlements_ready(')
    expect(migration.match(/COALESCE\(\(SELECT auth\.role\(\)\), ''\)/g)).toHaveLength(2)
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION[\s\S]*?sync_account_deletion_one_time_settlements[\s\S]*?TO service_role/
    )
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION[\s\S]*?check_account_deletion_one_time_settlements_ready[\s\S]*?TO service_role/
    )
  })
})
