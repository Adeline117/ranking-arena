import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260729066000_stripe_charge_dispute_authority.sql'),
  'utf8'
)
const fixture = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/stripe-charge-dispute-authority.fixture.psql'),
  'utf8'
)
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/stripe-charge-dispute-authority.pg17.sh'),
  'utf8'
)
const databaseTypes = readFileSync(resolve(root, 'lib/supabase/database.types.ts'), 'utf8')

function functionBody(name: string): string {
  const pattern = new RegExp(
    `CREATE OR REPLACE FUNCTION\\s+(?:\\n\\s*)?public\\.${name}\\s*\\(`,
    'm'
  )
  const match = pattern.exec(migration)
  expect(match).not.toBeNull()
  const end = migration.indexOf('ALTER FUNCTION', match!.index)
  expect(end).toBeGreaterThan(match!.index)
  return migration.slice(match!.index, end)
}

describe('Stripe charge dispute authority', () => {
  it('installs private immutable event and projection ledgers with full payment mode identity', () => {
    for (const relation of ['stripe_charge_dispute_events', 'stripe_charge_dispute_projections']) {
      expect(migration).toContain(`CREATE TABLE public.${relation}`)
      expect(migration).toContain(`ALTER TABLE public.${relation} OWNER TO postgres`)
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE public\\.${relation}\\s+ENABLE ROW LEVEL SECURITY`)
      )
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON TABLE public\\.${relation}\\s+FROM PUBLIC, anon, authenticated, service_role, authenticator`
        )
      )
      expect(migration).toContain(`trg_${relation}_immutable`)
    }

    for (const identity of [
      'livemode boolean NOT NULL',
      'stripe_event_id text NOT NULL',
      'stripe_dispute_id text NOT NULL',
      'stripe_customer_id text NOT NULL',
      'stripe_payment_intent_id text',
      'stripe_charge_id text NOT NULL',
      'captured_amount bigint NOT NULL',
    ]) {
      expect(migration).toContain(identity)
    }
    expect(migration).toContain('Stripe dispute financial audit rows are immutable')
    expect(databaseTypes).toContain('stripe_charge_dispute_events: {')
    expect(databaseTypes).toContain('stripe_charge_dispute_projections: {')
  })

  it('atomically revokes the exact Tip, ordinary Pro, Group Pass, and API-tier product', () => {
    const project = functionBody('project_stripe_charge_dispute_ownership_atomic')

    for (const productKind of ['tip', 'pro_entitlement', 'group_pass', 'api_tier']) {
      expect(project).toContain(`WHEN '${productKind}'`)
    }
    expect(project).toContain("SET status = 'refunded'")
    expect(project).toContain('DELETE FROM public.notifications')
    expect(project).toContain('UPDATE public.tip_completion_notification_deliveries')
    expect(project).toContain('UPDATE public.pro_entitlement_grants')
    expect(project).toContain("SET status = 'canceled'")
    expect(project).toContain("'pro_entitlement'")
    expect(project).toContain('INSERT INTO public.api_tier_reversal_actions')
    expect(project).toContain('UPDATE public.group_subscriptions')
    expect(project).toContain('DELETE FROM public.group_members')
    expect(project).toContain('public.group_pass_has_nondisputed_current_authority_v3')
    expect(project).toContain('public.project_api_tier_financial_reversal_atomic')
  })

  it('persists dispute-first events and projects them before a later ownership commit', () => {
    const record = functionBody('record_api_tier_dispute_reversal_atomic')
    const deferred = functionBody('project_dispute_after_payment_ownership_insert')

    expect(record.indexOf('INSERT INTO public.stripe_charge_dispute_events')).toBeLessThan(
      record.indexOf('FROM public.stripe_payment_ownerships AS ownership')
    )
    expect(record).toContain('stripe_dispute_event_identity_conflict')
    expect(record).toContain('stripe_dispute_payment_identity_conflict')
    expect(record).toContain('record_api_tier_dispute_reversal_pre_global_v2')
    expect(record).toContain("RETURN pg_catalog.jsonb_build_object('status', 'not_api')")
    expect(deferred).toContain('public.project_stripe_charge_dispute_ownership_atomic')
    expect(migration).toContain('CREATE CONSTRAINT TRIGGER')
    expect(migration).toContain('DEFERRABLE INITIALLY DEFERRED')
  })

  it('keeps a disputed recurring Pro payment revoked across delayed active webhooks', () => {
    const exactBinding = functionBody('stripe_subscription_has_exact_payment_binding_v2')
    const grantGuard = functionBody('guard_stripe_derived_pro_grant_livemode')
    const activate = functionBody('activate_recurring_entitlement_payment_atomic')
    const reconcile = functionBody('reconcile_recurring_subscription_state_atomic')

    expect(exactBinding).toContain('stripe_charge_dispute_events')
    expect(exactBinding).toContain('NOT EXISTS')
    expect(grantGuard).toContain('stripe_charge_dispute_events')
    expect(grantGuard).toContain('NOT EXISTS')
    for (const writer of [activate, reconcile]) {
      expect(writer).toContain('stripe_charge_dispute_projections')
      expect(writer).toContain('public.project_stripe_charge_dispute_ownership_atomic')
    }
    expect(activate).toContain("'refunded_payment'")
    expect(reconcile).toContain("'financial_reversal', 'dispute'")
  })

  it('routes cancellation actions by product and blocks readiness on dispute drift', () => {
    const claim = functionBody('claim_api_tier_reversal_actions_atomic')
    const readiness = functionBody('stripe_paid_launch_readiness_v2')

    expect(migration).toContain("CHECK (product_kind IN ('api_tier', 'pro_entitlement'))")
    expect(claim).toContain("'product_kind', claimed.product_kind")
    expect(databaseTypes).toContain('product_kind: string')
    for (const key of [
      'unprojected_charge_disputes',
      'charge_dispute_identity_anomalies',
      'charge_dispute_authority_drift',
    ]) {
      expect(readiness).toContain(`'${key}'`)
    }
    expect(readiness).toContain('stripe_paid_launch_readiness_pre_dispute_v2')
  })

  it('ships a PostgreSQL 17 proof for payment-first, dispute-first, and anti-revival paths', () => {
    expect(pg17).toContain('atomic-stripe-entitlement-identity.pg17.sh')
    expect(pg17).toContain('20260729065000_stripe_entitlement_livemode_authority.sql')
    expect(pg17).toContain(
      'STRIPE_ENTITLEMENT_EXTRA_PROOF_SQLS="$MIGRATION_290240:$MIGRATION_290650:$MIGRATION_290660:$FIXTURE"'
    )
    expect(pg17).toContain('Stripe charge dispute authority PostgreSQL 17 proof passed')
    expect(fixture).toContain('payment-first Tip dispute retained authority')
    expect(fixture).toContain('ordinary Pro dispute retained authority or lost cancellation')
    expect(fixture).toContain('delayed Stripe active state revived disputed Pro')
    expect(fixture).toContain('Group Pass dispute retained paid access')
    expect(fixture).toContain('dispute-first deferred ownership projection granted Tip')
    expect(fixture).toContain('Pro dispute cancellation claim lost product routing')
    expect(fixture).toContain('Stripe dispute readiness keys are incomplete')
  })
})
