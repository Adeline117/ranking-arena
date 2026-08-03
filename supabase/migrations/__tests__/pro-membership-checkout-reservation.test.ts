import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  join(root, 'supabase/migrations/20260729073000_pro_membership_checkout_reservation.sql'),
  'utf8'
)
const pg17Proof = readFileSync(
  join(root, 'supabase/migrations/__tests__/pro-membership-checkout-reservation.pg17.sh'),
  'utf8'
)
const createRoute = readFileSync(join(root, 'app/api/stripe/create-checkout/route.ts'), 'utf8')
const proCheckoutRecovery = readFileSync(join(root, 'lib/stripe/pro-checkout-recovery.ts'), 'utf8')
const proCheckoutRuntime = `${createRoute}\n${proCheckoutRecovery}`
const checkoutHandler = readFileSync(
  join(root, 'app/api/stripe/webhook/handlers/checkout.ts'),
  'utf8'
)
const checkoutTests = readFileSync(
  join(root, 'app/api/stripe/create-checkout/__tests__/route.test.ts'),
  'utf8'
)
const webhookTests = readFileSync(
  join(root, 'app/api/stripe/webhook/handlers/__tests__/checkout.test.ts'),
  'utf8'
)

describe('ordinary B2C Pro Checkout reservation contract', () => {
  it('bounds migration lock, statement, idle transaction, and namespace risk', () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '10s';")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min';")
    expect(migration).toContain("SET LOCAL idle_in_transaction_session_timeout = '2min';")
    expect(migration).toContain('SET LOCAL search_path = pg_catalog, pg_temp;')
    expect(migration.indexOf("SET LOCAL lock_timeout = '10s';")).toBeLessThan(
      migration.indexOf('DO $preflight$')
    )
  })

  it('installs a durable one-active-checkout admission ledger', () => {
    expect(migration).toContain(
      'CREATE TABLE IF NOT EXISTS public.pro_membership_checkout_reservations'
    )
    expect(migration).toContain('pro_membership_checkout_reservations_active_user_mode_idx')
    expect(migration).toContain("WHERE status IN ('reserved', 'bound', 'converted')")
    expect(migration).toContain('pro_membership_checkout_reservations_active_customer_mode_idx')
    expect(migration).toContain("p_pro_plan NOT IN ('monthly', 'yearly')")
    expect(migration).toContain("status = 'converted'")
    expect(migration).toContain("status = 'released'")
    expect(pg17Proof).toContain(
      'Concurrent monthly/yearly checkout did not converge to one reservation'
    )
    expect(pg17Proof).toContain('Same-plan retry did not recover the durable reservation')
  })

  it('uses the shared paid-authority lock order and rechecks current identity', () => {
    const globalLock = migration.indexOf("'pro-official-group-assignment'")
    const userLock = migration.indexOf("'pro-official-group-user:'")
    const customerLock = migration.indexOf("'stripe-customer-owner:'")
    expect(globalLock).toBeGreaterThan(-1)
    expect(userLock).toBeGreaterThan(globalLock)
    expect(customerLock).toBeGreaterThan(userLock)
    expect(migration).toContain('FROM public.user_profiles AS profile')
    expect(migration).toContain('FROM public.subscriptions AS subscription')
    expect(migration).toContain("'active', 'trialing', 'past_due', 'incomplete',")
    expect(migration).toContain("'unpaid', 'paused'")
    expect(migration).toContain('Pro membership checkout customer ownership drifted')
    expect(pg17Proof).toContain('new non-terminal authority did not block bound Session recovery')
    expect(migration).toContain('v_active_reservation_count > 1')
    expect(pg17Proof).toContain(
      'crossed active user/Customer reservations were reused nondeterministically'
    )
  })

  it('keeps converted as a mode-bound financial barrier until exact signed terminal state', () => {
    const reserveBody = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.reserve_pro_membership_checkout_atomic'),
      migration.indexOf(
        'CREATE OR REPLACE FUNCTION public.bind_pro_membership_checkout_session_atomic'
      )
    )
    expect(reserveBody).toContain("reservation.status = 'converted'")
    expect(reserveBody).toContain("status = 'retired'")
    expect(reserveBody).toContain("pg_catalog.to_jsonb(state) ->> 'livemode' = p_livemode::text")
    expect(pg17Proof).toContain('other Stripe mode all remain blocked')
    expect(pg17Proof).toContain('Exact terminal converted reservation was not retired')
  })

  it('makes trial consumption permanent and never silently falls back to a paid Session', () => {
    expect(migration).toContain('FROM public.stripe_trial_entitlements AS trial')
    expect(migration).toContain('IF p_trial_days = 7 AND (')
    expect(migration).toContain("reservation.status IN ('converted', 'retired')")
    expect(migration).toContain("'status', 'trial_already_used'")
    expect(pg17Proof).toContain('durable and independent of the currently configured')
    expect(pg17Proof).toContain('Used trial created an immediate-charge reservation')
    expect(pg17Proof).toContain('Converted trial proof was not retained after retirement')
    expect(checkoutTests).toContain(
      'rejects a database trial downgrade instead of creating an immediate paid Session'
    )
    expect(checkoutTests).toContain('TRIAL_ALREADY_USED')
    expect(checkoutTests).toContain(
      'accepts the exact zero-due-today trial shape while preserving the future unit Price'
    )
  })

  it('binds one stable Stripe identity and never uses a minute idempotency key', () => {
    expect(createRoute).toContain(
      "idempotencyKey: `pro_membership_checkout_${livemode ? 'live' : 'test'}_${reservation.reservationId}`"
    )
    expect(createRoute).toContain('expiresAt: reservation.checkoutExpiresAtSeconds')
    expect(createRoute).toContain('clientReferenceId: reservation.reservationId')
    expect(createRoute).toContain("type: 'pro_membership'")
    expect(proCheckoutRuntime).toContain('pro_membership_reservation_id')
    expect(proCheckoutRuntime).toContain('pro_price_id')
    expect(proCheckoutRuntime).toContain('unit_amount')
    expect(createRoute).toContain('currency: reservation.currency')
    expect(createRoute).not.toContain(
      'The durable recurring-checkout admission RPC remains required'
    )
  })

  it('freshly attests Customer and fully paginates exact fixed Price identity', () => {
    expect(createRoute).toContain('getStripe().customers.retrieve(customerId)')
    expect(createRoute).toContain('stripeCustomerIsExactlyOwned')
    expect(proCheckoutRecovery).toContain("expand: ['line_items.data.price']")
    expect(proCheckoutRecovery).toContain("expand: ['data.price']")
    expect(proCheckoutRecovery).toContain("price.billing_scheme !== 'per_unit'")
    expect(proCheckoutRecovery).toContain("price.type !== 'recurring'")
    expect(proCheckoutRecovery).toContain('price.custom_unit_amount !== null')
    expect(proCheckoutRecovery).toContain('session.optional_items')
    expect(proCheckoutRecovery).toContain('session.custom_fields.length === 0')
    expect(proCheckoutRecovery).toContain('maxStripePaginationPages')
    expect(createRoute).toContain("'resolve_b2c_recurring_price_authority'")
    expect(checkoutTests).toContain('ownerless Customer')
    expect(checkoutTests).toContain('whose exact owner cannot be established')
  })

  it('preserves ambiguous create/bind outcomes with no application release fallback', () => {
    expect(createRoute).toContain('Stripe Pro Checkout create was ambiguous; reservation preserved')
    expect(createRoute).toContain('Pro Checkout bind outcome was uncertain; Session preserved')
    const recurringSection = createRoute.slice(
      createRoute.indexOf('// 月付 / 年付订阅'),
      createRoute.indexOf('return NextResponse.json(\n      {\n        url: checkoutSession.url')
    )
    expect(recurringSection).not.toContain("'release_pro_membership_checkout_reservation_atomic'")
    expect(checkoutTests).toContain(
      'preserves the reservation when Stripe create has an ambiguous outcome'
    )
    expect(checkoutTests).toContain('preserves an exact Session when the bind outcome is ambiguous')
  })

  it('requires exact signed expiration and completion identities with idempotent replay', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.release_pro_membership_checkout_reservation_atomic('
    )
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.convert_pro_membership_checkout_reservation_atomic('
    )
    expect(migration).toContain('p_stripe_event_created <')
    expect(migration).toContain(
      'pg_catalog.floor(extract(epoch FROM v_reservation.created_at))::bigint'
    )
    expect(checkoutHandler).toContain("'release_pro_membership_checkout_reservation_atomic'")
    expect(checkoutHandler).toContain("'convert_pro_membership_checkout_reservation_atomic'")
    expect(pg17Proof).toContain('pre-reservation expiration event was accepted')
    expect(pg17Proof).toContain('conflicting completion replay was accepted')
    expect(webhookTests).toContain(
      'keeps the pre-cutover three-key signed completion path reachable'
    )
    expect(checkoutHandler).toContain('activateExactRecurringCheckout')
    expect(checkoutHandler).not.toContain('await updateUserSubscription(')
    expect(checkoutHandler).not.toContain('await stripe.subscriptions.cancel(')
    expect(checkoutHandler).toContain('pro_checkout_completion_identity_invalid')
  })

  it('seals table/RPC ownership, RLS, ACL, overload, and replay hashes', () => {
    expect(migration).toContain(
      'ALTER TABLE public.pro_membership_checkout_reservations OWNER TO postgres'
    )
    expect(migration).toContain(
      'ALTER TABLE public.pro_membership_checkout_reservations ENABLE ROW LEVEL SECURITY'
    )
    expect(migration).toContain('SET search_path = pg_catalog, pg_temp')
    expect(migration).toContain('SET row_security = off')
    expect(migration).toContain("SET lock_timeout = '5s'")
    expect(migration).toContain("SET statement_timeout = '30s'")
    expect(migration).toContain('TO service_role;')
    expect(migration).toContain('Pro checkout authority overload inventory drifted')
    expect(migration).toContain('Pro checkout authority function body hash drifted')
    expect(migration).toContain('Pro checkout reservation columns/defaults/nullability drifted')
    expect(migration).toContain('Pro checkout reservation CHECK/PK/FK constraints drifted')
    expect(migration).toContain('Pro checkout reservation PK/five-index inventory drifted')
    expect(pg17Proof).toContain('runtime reservation lock contention did not fail closed')
    expect(pg17Proof).toContain('schema_hash()')
    expect(pg17Proof).toContain('Migration replay changed the Pro checkout schema hash')
    expect(pg17Proof).toContain('Migration accepted a hostile reservation authority overload')
  })
})
