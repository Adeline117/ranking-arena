import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260729069000_stripe_dispute_funds_reinstatement.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const fixture = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/stripe-dispute-funds-reinstatement.fixture.psql'),
  'utf8'
)
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/stripe-dispute-funds-reinstatement.pg17.sh'),
  'utf8'
)
const readinessRoute = readFileSync(resolve(root, 'app/api/cron/stripe-readiness/route.ts'), 'utf8')
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

describe('Stripe won-dispute funds reinstatement authority', () => {
  it('installs private immutable mode-aware event and projection ledgers', () => {
    for (const relation of [
      'stripe_charge_dispute_reinstatement_events',
      'stripe_charge_dispute_reinstatement_projections',
    ]) {
      expect(migration).toContain(`CREATE TABLE public.${relation}`)
      expect(migration).toContain(`ALTER TABLE public.${relation}\n  OWNER TO postgres`)
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE public\\.${relation}\\s+ENABLE ROW LEVEL SECURITY`)
      )
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON TABLE\\s+public\\.${relation}\\s+FROM PUBLIC, anon, authenticated, service_role, authenticator`
        )
      )
      expect(migration).toContain(`trg_${relation}_immutable`)
    }
    expect(migration).toContain("dispute_status = 'won'")
    expect(migration).toContain('refund_succeeded_amount bigint NOT NULL')
    expect(databaseTypes).toContain('stripe_charge_dispute_reinstatement_events: {')
    expect(databaseTypes).toContain('stripe_charge_dispute_reinstatement_projections: {')
    expect(databaseTypes).toContain('record_stripe_charge_dispute_reinstatement_atomic: {')
  })

  it('restores only the exact Tip, Pro, Group Pass, or API-tier payment authority', () => {
    const project = functionBody('project_stripe_charge_dispute_reinstatement_atomic')

    for (const productKind of ['tip', 'pro_entitlement', 'group_pass', 'api_tier']) {
      expect(project).toContain(`WHEN '${productKind}'`)
    }
    expect(project).toContain("SET status = 'completed'")
    expect(project).toContain('SET notification_id = v_notification_id')
    expect(project).toContain("disposition = 'delivered'")
    expect(project).toContain('UPDATE public.pro_entitlement_grants')
    expect(project).toContain("SET status = 'active'")
    expect(project).toContain('INSERT INTO public.group_members')
    expect(project).toContain('DELETE FROM public.api_tier_subscription_blocks')
    expect(project).toContain('public.apply_user_api_tier_stripe_event')
    expect(project).toContain("'key_rotation_required', true")
    expect(migration).toContain('arena.stripe_dispute_reinstatement_event_id')
  })

  it('lets a succeeded full refund outrank a won dispute without weakening active-dispute guards', () => {
    const matches = functionBody('stripe_dispute_reinstatement_matches_payment_v2')
    const exact = functionBody('stripe_dispute_reinstatement_is_exact_v2')
    const project = functionBody('project_stripe_charge_dispute_reinstatement_atomic')

    expect(matches).not.toContain(
      'reinstatement.refund_succeeded_amount <\n          reinstatement.captured_amount'
    )
    expect(exact).toContain('reinstatement.refund_succeeded_amount <')
    expect(exact).toContain('public.stripe_charge_refund_tombstones')
    expect(project).toContain('public.stripe_dispute_reinstatement_matches_payment_v2')
    expect(project).toContain('v_event.refund_succeeded_amount >= v_event.captured_amount')
    expect(project).toContain("'status', 'refund_preserved'")
    expect(fixture).toContain('full refund did not outrank dispute reinstatement')
    expect(fixture).toContain('full-refunded Tip authority was revived')
  })

  it('fences an in-flight cancellation and neutralizes only an expired or pending action', () => {
    const neutralize = functionBody('neutralize_dispute_cancellation_for_reinstatement_atomic')
    const record = functionBody('record_stripe_charge_dispute_reinstatement_atomic')

    expect(neutralize).toContain("v_action.state = 'leased'")
    expect(neutralize).toContain("'action_in_flight'")
    expect(neutralize).toContain("RETURN 'manual_review'")
    expect(neutralize).toContain("completed_disposition = 'funds_reinstated'")
    expect(record).toContain("'action_in_flight'")
    expect(fixture).toContain('live Pro cancellation lease was not fenced')
    expect(fixture).toContain('expired Pro cancellation lease was treated as safe')
    expect(fixture).toContain('ambiguous expired cancellation restored Pro or lost review')
    expect(fixture).toContain('won Pro dispute lost entitlement or cancellation neutralization')
  })

  it('converges reinstatement-first, dispute-first, and payment-last delivery order', () => {
    const dispute = functionBody('record_api_tier_dispute_reversal_atomic')
    const deferred = functionBody('project_dispute_after_payment_ownership_insert')

    expect(dispute).toContain('record_api_tier_dispute_reversal_pre_reinstatement_v2')
    expect(dispute).toContain('stripe_charge_dispute_reinstatement_events')
    expect(dispute).toContain('public.project_stripe_charge_dispute_reinstatement_atomic')
    expect(deferred).toContain('stripe_charge_dispute_reinstatement_events')
    expect(deferred).toContain('public.project_stripe_charge_dispute_reinstatement_atomic')
    expect(fixture).toContain('reinstatement-first event was not durably accepted')
    expect(fixture).toContain(
      'reinstatement-first/dispute-first/payment-last order did not converge'
    )
  })

  it('blocks readiness on missing, conflicting, or drifted reinstatement projections', () => {
    const readiness = functionBody('stripe_paid_launch_readiness_v2')

    for (const key of [
      'unprojected_dispute_reinstatements',
      'dispute_reinstatement_identity_anomalies',
      'dispute_reinstatement_authority_drift',
    ]) {
      expect(readiness).toContain(`'${key}'`)
      expect(readinessRoute).toContain(`'${key}'`)
    }
    expect(readiness).toContain('stripe_paid_launch_readiness_pre_dispute_v2')
    expect(fixture).toContain('notification_delivery_anomalies')
    expect(fixture).toContain('Stripe dispute reinstatement readiness did not converge')
  })

  it('ships a real PostgreSQL 17 proof across product, lease, refund, and order paths', () => {
    expect(pg17).toContain('atomic-stripe-entitlement-identity.pg17.sh')
    expect(pg17).toContain('20260729066000_stripe_charge_dispute_authority.sql')
    expect(pg17).toContain('20260729069000_stripe_dispute_funds_reinstatement.sql')
    expect(pg17).toContain('$MIGRATION_290690:$DISPUTE_FIXTURE:$REINSTATEMENT_FIXTURE')
    expect(fixture).toContain('won Tip dispute did not restore durable notification authority')
    expect(fixture).toContain('won Group Pass dispute did not restore exact paid access')
    expect(pg17).toContain('Stripe dispute funds reinstatement PostgreSQL 17 proof passed')
  })

  it('runs exactly once in POSTDEPLOY after charge dispute authority', () => {
    const predeploy = runner.match(/PREDEPLOY_MIGRATIONS=\(([\s\S]*?)\n\)/)?.[1] ?? ''
    const postdeploy = runner.match(/POSTDEPLOY_MIGRATIONS=\(([\s\S]*?)\n\)/)?.[1] ?? ''

    expect(predeploy).not.toContain(migrationName)
    expect(postdeploy.match(new RegExp(migrationName, 'g'))).toHaveLength(1)
    expect(postdeploy.indexOf(migrationName)).toBeGreaterThan(
      postdeploy.indexOf('20260729066000_stripe_charge_dispute_authority.sql')
    )
  })
})
