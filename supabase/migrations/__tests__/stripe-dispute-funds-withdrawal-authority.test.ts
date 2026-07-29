import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260729073000_stripe_dispute_funds_withdrawal_authority.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const webhookRoute = readFileSync(resolve(root, 'app/api/stripe/webhook/route.ts'), 'utf8')
const refundHandler = readFileSync(
  resolve(root, 'app/api/stripe/webhook/handlers/refund.ts'),
  'utf8'
)
const readinessRoute = readFileSync(resolve(root, 'app/api/cron/stripe-readiness/route.ts'), 'utf8')
const fixture = readFileSync(
  resolve(
    root,
    'supabase/migrations/__tests__/stripe-dispute-funds-withdrawal-authority.fixture.psql'
  ),
  'utf8'
)
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/stripe-dispute-funds-withdrawal-authority.pg17.sh'),
  'utf8'
)

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

function migrationNames(arrayName: string): string[] {
  const body = runner.match(new RegExp(`${arrayName}=\\(([\\s\\S]*?)\\n\\)`))?.[1] ?? ''
  return [...body.matchAll(/^\s*(\d{14}_[a-z0-9_]+\.sql)\s*$/gm)].map((match) => match[1])
}

describe('Stripe dispute funds-withdrawal authority', () => {
  it('rejects warning inquiries before immutable financial audit writes', () => {
    const recorder = functionBody('record_api_tier_dispute_reversal_atomic')

    expect(recorder).toContain('p_dispute_status NOT IN (')
    expect(recorder).toContain("'needs_response'")
    expect(recorder).toContain("'under_review'")
    expect(recorder).toContain("'lost'")
    expect(recorder).toContain('Stripe dispute does not prove withdrawn funds')
    expect(migration).toContain('stripe_charge_dispute_events_withdrawn_status_check')
    expect(migration).toContain(
      'live Stripe warning/inquiry dispute history requires manual repair'
    )
    expect(fixture).toContain('warning inquiry was accepted as financial reversal authority')
  })

  it('converges created and funds_withdrawn ids on one canonical reversal', () => {
    const recorder = functionBody('record_api_tier_dispute_reversal_atomic')
    const chargeLock = recorder.indexOf("'stripe-charge-refund:'")
    const paymentIntentLock = recorder.indexOf("'stripe-payment-identity:'")

    expect(chargeLock).toBeGreaterThan(-1)
    expect(paymentIntentLock).toBeGreaterThan(chargeLock)
    expect(recorder).toContain('v_existing public.stripe_charge_dispute_events%ROWTYPE')
    expect(recorder).toContain("'status', 'already_withdrawn'")
    expect(recorder).not.toContain('v_existing.stripe_event_id = p_stripe_event_id')
    expect(recorder).toContain('stripe_dispute_withdrawal_identity_conflict')
    expect(fixture).toContain('funds_withdrawn replay was not acknowledged exactly')
    expect(fixture).toContain('funds-withdrawn-first event was not persisted')
  })

  it('keeps warnings out of direct, deferred, and restored authority predicates', () => {
    const identity = functionBody('stripe_charge_dispute_identity_state_v2')
    const exact = functionBody('stripe_payment_ownership_has_exact_dispute_v2')
    const deferred = functionBody('project_dispute_after_payment_ownership_insert')
    const reinstatement = functionBody('stripe_dispute_reinstatement_matches_payment_v2')

    for (const body of [identity, exact, deferred, reinstatement]) {
      expect(body).toContain("'needs_response'")
      expect(body).toContain("'under_review'")
      expect(body).toContain("'lost'")
      expect(body).not.toContain("'warning_needs_response'")
    }
  })

  it('does not let one won dispute neutralize another active dispute', () => {
    const otherActive = functionBody('stripe_payment_ownership_has_other_active_dispute_v3')
    const active = functionBody('stripe_payment_ownership_has_active_dispute_v3')
    const projector = functionBody('project_stripe_charge_dispute_reinstatement_atomic')

    expect(otherActive).toContain('p_excluded_dispute_id')
    expect(otherActive).toContain('stripe_charge_dispute_reinstatement_projections')
    expect(otherActive).toContain("'restored'")
    expect(otherActive).toContain("'refund_preserved'")
    expect(active).toContain('stripe_payment_ownership_has_other_active_dispute_v3')
    expect(projector).toContain('stripe_payment_ownership_has_other_active_dispute_v3')
    expect(projector).toContain("'reason', 'other_dispute_active'")
    expect(projector).toContain("'status', 'refund_preserved'")
    expect(fixture).toContain('winning one of multiple disputes restored paid access')
    expect(fixture).toContain('final won dispute did not restore exact paid access')
  })

  it('keeps the readiness response shape stable and fails closed on guard drift', () => {
    const readiness = functionBody('stripe_paid_launch_readiness_v2')

    expect(readiness).toContain('stripe_paid_launch_readiness_pre_withdrawal_v3')
    expect(readiness).toContain('v_nonwithdrawn_live_events')
    expect(readiness).toContain('v_status_guard_anomalies')
    expect(readiness).toContain("'charge_dispute_identity_anomalies'")
    expect(readiness).not.toContain("'nonwithdrawn_dispute_events'")
    expect(readinessRoute).toContain("'charge.dispute.funds_withdrawn'")
  })

  it('dispatches the canonical Stripe withdrawal event through fresh authority', () => {
    expect(webhookRoute).toContain("case 'charge.dispute.funds_withdrawn':")
    expect(webhookRoute).toContain('handleChargeDisputeFundsWithdrawn')
    expect(refundHandler).toContain('STRIPE_DISPUTE_FUNDS_WITHDRAWN_STATUSES')
    expect(refundHandler).toContain(
      "handleChargeDisputeWithdrawal(dispute, context, 'charge.dispute.funds_withdrawn')"
    )
    expect(refundHandler).toContain(
      'if (!STRIPE_DISPUTE_FUNDS_WITHDRAWN_STATUSES.has(freshDispute.status))'
    )
  })

  it('ships a PostgreSQL 17 proof in real predeploy/postdeploy order', () => {
    expect(pg17).toContain('atomic-stripe-entitlement-identity.pg17.sh')
    expect(pg17).toContain(
      '$MIGRATION_290240:$MIGRATION_290720:$MIGRATION_290650:$MIGRATION_290660:$MIGRATION_290690:$MIGRATION_290730'
    )
    expect(pg17).toContain('$FIXTURE')
    expect(fixture).toContain('Stripe dispute funds-withdrawal authority fixture passed')
    expect(pg17).toContain('Stripe dispute funds-withdrawal authority PostgreSQL 17 proof passed')
  })

  it('runs exactly once after dispute reinstatement in POSTDEPLOY', () => {
    const predeploy = migrationNames('PREDEPLOY_MIGRATIONS')
    const postdeploy = migrationNames('POSTDEPLOY_MIGRATIONS')

    expect(predeploy).not.toContain(migrationName)
    expect(postdeploy.filter((name) => name === migrationName)).toHaveLength(1)
    expect(postdeploy.indexOf(migrationName)).toBeGreaterThan(
      postdeploy.indexOf('20260729069000_stripe_dispute_funds_reinstatement.sql')
    )
  })
})
