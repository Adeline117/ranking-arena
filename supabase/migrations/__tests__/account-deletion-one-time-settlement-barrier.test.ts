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
    expect(migration).toContain("'pending_fulfillment'")
    expect(migration).toContain("'terminal_manual_review'")
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

  it('proves delayed fulfillment, unknown review, and bound-reservation blocking in PG17', () => {
    expect(pg17Proof).toContain('$delayed_webhook_stays_pending$')
    expect(pg17Proof).toContain('$delayed_webhook_converges$')
    expect(pg17Proof).toContain('$unknown_product_is_durably_reviewed$')
    expect(pg17Proof).toContain('$expired_checkout_waits_for_local_lifecycle$')
    expect(pg17Proof).toContain('cs_lifetime_delayed')
    expect(pg17Proof).toContain('cs_unknown_paid')
    expect(pg17Proof).toContain('cs_expired_exact')
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
