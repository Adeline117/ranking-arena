import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260729025000_recurring_pro_checkout_admission.sql'),
  'utf8'
)
const pg17 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/__tests__/recurring-pro-checkout-admission.pg17.sh'),
  'utf8'
)
const checkoutRoute = readFileSync(
  resolve(process.cwd(), 'app/api/stripe/create-checkout/route.ts'),
  'utf8'
)
const checkoutWebhook = readFileSync(
  resolve(process.cwd(), 'app/api/stripe/webhook/handlers/checkout.ts'),
  'utf8'
)

function functionBody(name: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  const next = migration.indexOf('CREATE OR REPLACE FUNCTION public.', start + 1)
  const end = next >= 0 ? next : migration.indexOf('ALTER FUNCTION public.', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end)
}

describe('recurring Pro Checkout admission migration', () => {
  it('creates one persistent RLS reservation authority with mode-scoped active keys', () => {
    expect(migration).toContain('CREATE TABLE public.stripe_recurring_pro_checkout_reservations')
    expect(migration).not.toContain('CREATE UNLOGGED TABLE')
    expect(migration).toContain(
      'ALTER TABLE public.stripe_recurring_pro_checkout_reservations ENABLE ROW LEVEL SECURITY'
    )
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX stripe_recurring_pro_checkout_active_user_key[\s\S]*?\(livemode, user_id\)[\s\S]*?WHERE status IN \('reserved', 'bound', 'completed'\)/
    )
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX stripe_recurring_pro_checkout_active_customer_key[\s\S]*?livemode,[\s\S]*?stripe_customer_id[\s\S]*?WHERE status IN \('reserved', 'bound', 'completed'\)/
    )
    expect(migration).toContain('UNIQUE (livemode, operation_id)')
  })

  it('ships only service-role SECURITY DEFINER lifecycle RPCs with scalar mutation ACKs', () => {
    for (const name of [
      'reserve_recurring_pro_checkout_atomic',
      'bind_recurring_pro_checkout_session_atomic',
      'complete_recurring_pro_checkout_atomic',
      'release_recurring_pro_checkout_atomic',
      'assert_recurring_pro_checkout_completed_atomic',
    ]) {
      const body = functionBody(name)
      expect(body).toContain('SECURITY DEFINER')
      expect(body).toContain('SET search_path = pg_catalog, pg_temp')
      expect(body).toContain('SET row_security = off')
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${name}(`)
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${name}(`)
    }
    for (const name of [
      'bind_recurring_pro_checkout_session_atomic',
      'complete_recurring_pro_checkout_atomic',
      'release_recurring_pro_checkout_atomic',
      'assert_recurring_pro_checkout_completed_atomic',
    ]) {
      expect(functionBody(name)).toContain('RETURNS text')
    }
  })

  it('serializes operation, user, and Customer admission before Stripe can be called', () => {
    const reserve = functionBody('reserve_recurring_pro_checkout_atomic')
    expect(reserve).toContain('pro-official-group-user:')
    expect(reserve).toContain('stripe-customer-owner:')
    expect(reserve).toContain('recurring-pro-checkout-operation:')
    expect(reserve).toContain("v_reservation.status IN ('reserved', 'bound')")
    expect(reserve).toContain("'status', 'existing'")
    expect(reserve).toContain("RETURN pg_catalog.jsonb_build_object('status', 'conflict')")
    expect(reserve).toContain('reservation.livemode = p_livemode')
    expect(reserve).not.toMatch(/DELETE FROM public\.stripe_recurring_pro_checkout_reservations/)
  })

  it('never unsigned-releases a bound Session and requires exact signed expiry identity', () => {
    const reserve = functionBody('reserve_recurring_pro_checkout_atomic')
    const release = functionBody('release_recurring_pro_checkout_atomic')
    expect(reserve).toContain('Only unbound reservations may be retired')
    expect(reserve).toContain('reservation.checkout_session_id IS NULL')
    expect(release).toContain("v_reservation.status IS DISTINCT FROM 'bound'")
    expect(release).toContain("release_reason = 'checkout_session_expired'")
    expect(release).toContain('p_stripe_event_id')
    expect(release).toContain('p_stripe_event_created')
    expect(checkoutRoute).not.toContain("'release_recurring_pro_checkout_atomic'")
  })

  it('makes completed Checkout a mandatory predecessor of invoice/subscription authority', () => {
    const assertion = functionBody('assert_recurring_pro_checkout_completed_atomic')
    const statusCheck = assertion.indexOf("v_reservation.status IS DISTINCT FROM 'completed'")
    const subscriptionCheck = assertion.lastIndexOf(
      'v_reservation.stripe_subscription_id\n    IS DISTINCT FROM p_stripe_subscription_id'
    )
    expect(assertion).toContain("USING ERRCODE = '40001'")
    expect(statusCheck).toBeGreaterThanOrEqual(0)
    expect(subscriptionCheck).toBeGreaterThan(statusCheck)
    expect(assertion).toContain("RETURN 'identity_conflict'")
    expect(assertion).toContain("RETURN 'completed'")
  })

  it('contains no duplicate-paid cancellation or direct paid entitlement mutation', () => {
    expect(checkoutWebhook).not.toContain('subscriptions.cancel')
    expect(checkoutWebhook).not.toContain('updateUserSubscription(')
    expect(checkoutWebhook).not.toContain('joinProOfficialGroup(')
    expect(checkoutWebhook).not.toContain('mintNFTForUser(')
    expect(checkoutWebhook).toContain("'complete_recurring_pro_checkout_atomic'")
    expect(checkoutWebhook).toContain("'activate_recurring_trial_entitlement_atomic'")
  })

  it('proves PostgreSQL 17 fanout, replay, event ordering, and exact release', () => {
    for (const marker of [
      'for lane in {1..12}',
      '1|11',
      'same operation immutable drift',
      'invoice/subscription must not outrun Checkout completion',
      'signed completion',
      'active subscription blocks recheckout',
      'terminal projection permits one new reservation',
      'exact signed expiry release',
      'new reservation after signed release',
    ]) {
      expect(pg17).toContain(marker)
    }
  })
})
