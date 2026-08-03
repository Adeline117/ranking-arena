import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase/migrations/20260729080000_api_tier_recovery_payment_authority.sql'),
  'utf8'
)
const pg17 = readFileSync(
  join(root, 'supabase/migrations/__tests__/api-tier-recovery-payment-authority.pg17.sh'),
  'utf8'
)

describe('API tier recovery payment authority', () => {
  it('locks recovery before any paid Stripe authority lock', () => {
    const paid = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.apply_api_tier_paid_invoice_event_atomic'
      ),
      migration.indexOf('ALTER FUNCTION public.apply_api_tier_paid_invoice_event_atomic')
    )
    expect(paid.indexOf('locate_api_tier_invoice_authority_atomic')).toBeGreaterThan(-1)
    expect(paid.indexOf('locate_api_tier_invoice_authority_atomic')).toBeLessThan(
      paid.indexOf("'stripe-charge-refund:'")
    )
    const locator = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.locate_api_tier_invoice_authority_atomic'
      ),
      migration.indexOf('ALTER FUNCTION public.locate_api_tier_invoice_authority_atomic')
    )
    expect(locator.indexOf("'account-recovery-admission:'")).toBeGreaterThan(-1)
    expect(locator.indexOf("'account-recovery-admission:'")).toBeLessThan(
      locator.indexOf("'stripe-customer-owner:'")
    )
    expect(migration).toContain("SET LOCAL lock_timeout = '5s';")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min';")
    expect(migration).toContain('SET LOCAL search_path = pg_catalog, pg_temp;')
  })

  it('locates rotated historical Prices only through the signed durable chain', () => {
    const locator = migration.slice(
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.locate_api_tier_invoice_authority_atomic'
      ),
      migration.indexOf('ALTER FUNCTION public.locate_api_tier_invoice_authority_atomic')
    )
    expect(locator).toContain('public.api_tier_checkout_reservations')
    expect(locator).toContain('checkout_session_id IS DISTINCT FROM p_checkout_session_id')
    expect(locator).toContain('stripe_price_id IS DISTINCT FROM p_stripe_price_id')
    expect(locator).toContain('api_plan IS DISTINCT FROM p_api_plan')
    expect(locator).not.toMatch(/process\.env|STRIPE_API_(STARTER|PRO)_PRICE_ID/)
    expect(pg17).toContain('rotated historical Price was not located from its signed Session')
  })

  it('persists the complete Invoice and payment time chain', () => {
    expect(migration).toContain('invoice_created_at timestamptz NOT NULL')
    expect(migration).toContain('paid_at timestamptz NOT NULL')
    expect(migration).toContain(
      'pg_catalog.to_timestamp(subscription_created) <= invoice_created_at'
    )
    expect(migration).toContain('invoice_created_at <= paid_at')
    expect(migration).toContain('period_start <= paid_at')
    expect(migration).toContain('paid_at < period_end')
    expect(migration).toContain('p_paid_at > p_event_created_at')
  })

  it('makes a pre-recovery bind an immutable lifecycle boundary', () => {
    expect(migration).toContain('ADD COLUMN bound_at timestamptz')
    expect(migration).toContain('CREATE TRIGGER trg_api_tier_checkout_bind_time_once')
    expect(migration).toContain('locate_account_recovery_payment_lifecycle_v2')
    expect(migration).not.toContain('account_recovery_payment_lifecycle_is_blocked_v2')
    expect(migration).not.toContain('FROM public.account_recovery_admissions')
    expect(migration).not.toContain('admission.updated_at')
    expect(migration).toContain('LEAST(v_reservation.created_at, p_session_created_at)')
    expect(migration).toContain('session_created_at timestamptz NOT NULL')
    expect(migration).toContain("status = 'account_recovery_billing_blocked'")
    expect(pg17).toContain('completed recovery was bypassed by a late first paid delivery')
    expect(pg17).toContain('superseded recovery late-first payment escaped')
    expect(pg17).toContain('current recovery surface lost its exact admission')
  })

  it('never grants an active Subscription before exact paid Invoice authority', () => {
    expect(migration).toContain('stripe_api_tier_pending_subscription_events')
    expect(migration).toContain("THEN 'payment_pending'")
    expect(migration).toContain("payment.authority_outcome = 'granted'")
    expect(migration).toContain('apply_user_api_tier_stripe_event_pre_payment_v2')
    expect(pg17).toContain('subscription-first event granted before payment authority')
    expect(migration).toContain('p_subscription_status text')
    expect(migration).toContain("p_subscription_status IS DISTINCT FROM 'active'")
    expect(migration).toContain('subscription_status text NOT NULL')
    expect(migration).toContain(
      'v_payment.subscription_status IS DISTINCT FROM p_subscription_status'
    )
    expect(pg17).toContain('non-active Subscription status was accepted')
    expect(pg17).toContain('rejected Subscription status mutated paid authority')
  })

  it('queues exact durable refund and cancellation work for blocked money', () => {
    expect(migration).toContain("'recovery_payment_auto_refund'")
    expect(migration).toContain("'stripe_subscription_cancel'")
    expect(migration).toContain("'protocol_version', 'dispatch_commit_v1'")
    expect(migration).toContain("'refund:account_recovery_billing_blocked'")
    expect(migration).toContain("'cancel:subscription:' || p_stripe_subscription_id")
    expect(migration).toContain('public.claim_api_tier_recovery_payment_refund_dispatch_atomic')
    expect(migration).toContain('public.claim_api_tier_subscription_cancel_dispatch_atomic')
    expect(pg17).toContain('blocked payment did not queue exactly two effects')
  })

  it('routes API ownership through refund tombstones and revokes quota', () => {
    expect(migration).toContain("ownership.product_kind = 'api_tier'")
    expect(migration).toContain('resolve_api_tier_refund_tombstone_atomic')
    expect(migration).toContain("'api_tier_full_refund_revoked'")
    expect(migration).toContain("'financial_reversal'")
    expect(migration).toContain('stripe_api_tier_refund_revocations')
    expect(pg17).toContain('API full refund did not produce its strict revocation ACK')
  })

  it('seals owner-only ledgers and exact service RPCs', () => {
    expect(migration).toContain('FORCE ROW LEVEL SECURITY')
    expect(migration).toContain('API tier recovery payment function ACL drifted')
    expect(migration).toContain('API tier recovery payment overload inventory drifted')
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role, authenticator')
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(pg17).toContain('hostile role executed an API payment authority RPC')
  })
})
