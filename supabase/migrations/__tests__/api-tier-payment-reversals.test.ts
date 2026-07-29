import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260729024000_api_tier_payment_reversals.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/api-tier-payment-reversals.pg17.sh'),
  'utf8'
)
const setup = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/api-tier-payment-reversals.setup.psql'),
  'utf8'
)
const fixture = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/api-tier-payment-reversals.fixture.psql'),
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

describe('API tier exact payment and reversal authority', () => {
  it('installs immutable subject-independent payment, observation, reversal and outbox ledgers', () => {
    for (const relation of [
      'stripe_api_tier_payments',
      'stripe_api_tier_payment_events',
      'stripe_charge_refund_observation_modes',
      'stripe_api_tier_reversal_events',
      'api_tier_reversal_actions',
      'api_tier_payment_backfill_targets',
    ]) {
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS public.${relation}`)
      expect(migration).toContain(`ALTER TABLE public.${relation} OWNER TO postgres`)
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE public\\.${relation}\\s+ENABLE ROW LEVEL SECURITY`)
      )
      expect(migration).toMatch(
        new RegExp(`ALTER TABLE public\\.${relation}\\s+NO FORCE ROW LEVEL SECURITY`)
      )
    }
    expect(migration).toContain('financial history must not depend on deletable subject rows')
    expect(migration).not.toMatch(/REFERENCES\s+(?:auth\.users|public\.user_profiles)\s*\([^)]*\)/i)
    expect(migration).toContain('API tier financial ledgers are immutable')
  })

  it('records one exact mode-aware paid Invoice and claims global Stripe ownership atomically', () => {
    const record = functionBody('record_api_tier_payment_atomic')
    const claim = functionBody('claim_api_tier_payment_ownership_atomic')

    for (const identity of [
      'p_livemode boolean',
      'p_checkout_reservation_id uuid',
      'p_stripe_invoice_id text',
      'p_stripe_invoice_payment_id text',
      'p_stripe_payment_intent_id text',
      'p_stripe_charge_id text',
      'p_period_start bigint',
      'p_period_end bigint',
      'p_observation_id text',
      'p_observation_type text',
    ]) {
      expect(record).toContain(identity)
    }
    expect(record).toContain('API tier payment arrived before sealed subscription authority')
    expect(record).toContain('public.claim_api_tier_payment_ownership_atomic(v_payment.id)')
    expect(record).toContain("'recorded'")
    expect(record).toContain("'already_recorded'")
    expect(record).toContain("'identity_conflict'")
    expect(claim).toContain("ownership.product_kind = 'api_tier'")
    expect(claim).toContain('public.stripe_payment_ownership_is_exact_v2')
  })

  it('makes a successful full refund or dispute a sticky block plus durable cancellation action', () => {
    const projection = functionBody('project_api_tier_financial_reversal_atomic')
    const dispute = functionBody('record_api_tier_dispute_reversal_atomic')
    const modeAwareRefund = functionBody('record_charge_refund_tombstone_with_mode_atomic')
    const claimAction = functionBody('claim_api_tier_reversal_actions_atomic')
    const finishAction = functionBody('finish_api_tier_reversal_action_atomic')

    expect(projection).toContain("'financial_reversal'")
    expect(projection).toContain('INSERT INTO public.api_tier_reversal_actions')
    expect(projection).toContain('api_tier = v_desired_tier')
    expect(projection).toContain('active = CASE')
    expect(dispute).toContain('v_payment.livemode IS DISTINCT FROM p_livemode')
    expect(modeAwareRefund).toContain("'stripe_refund_livemode_identity_conflict'")
    expect(modeAwareRefund).toContain("'API tier refund Stripe mode mismatch'")
    expect(claimAction).toContain('FOR UPDATE SKIP LOCKED')
    expect(claimAction).toContain('lease_expires_at <= pg_catalog.clock_timestamp()')
    expect(finishAction).toContain("'retry_scheduled'")
    expect(finishAction).toContain("'already_completed'")
    expect(finishAction).toContain("'resource_missing'")
  })

  it('prevents every legacy Pro synchronizer from reviving a fully refunded bound period', () => {
    const sync = functionBody('sync_recurring_pro_subscription_projection_atomic')

    expect(sync).toContain('v_subscription.entitlement_payment_id')
    expect(sync).toContain("v_bound_payment.payment_kind <> 'recurring'")
    expect(sync).toContain("v_bound_payment.refund_state = 'succeeded'")
    expect(sync).toContain(
      'v_bound_payment.refund_succeeded_amount >=\n        v_bound_payment.amount_paid'
    )
    expect(sync).toContain("status = 'canceled'")
    expect(sync).toContain("'blocked_full_refund'")
    expect(sync).toContain("'stale_current_subscription'")
    expect(sync).toContain('public.sync_current_pro_projection_atomic(p_user_id)')
    expect(databaseTypes).toContain('sync_recurring_pro_subscription_projection_atomic:')
  })

  it('extends the exact ten-key readiness result with three API payment gates', () => {
    const readiness = functionBody('stripe_paid_launch_readiness_v2')

    for (const key of [
      'api_tier_payment_ownership_anomalies',
      'api_tier_payment_backfill_incomplete',
      'api_tier_reversal_actions_incomplete',
    ]) {
      expect(readiness).toContain(`'${key}'`)
    }
    expect(readiness).toContain('public.stripe_paid_launch_readiness_pre_api_tier_v2()')
    expect(readiness).toContain("COALESCE((v_base ->> 'authority_drift')::integer, -1)")
  })

  it('ships a real PostgreSQL 17 chain and functional payment/refund revival proof', () => {
    expect(pg17).toContain('atomic-stripe-entitlement-identity.pg17.sh')
    expect(pg17).toContain('20260729020000_api_tier_cancellation_identity.sql')
    expect(pg17).toContain('20260729023000_preserve_financial_owner_after_account_deletion.sql')
    expect(pg17).toContain('STRIPE_ENTITLEMENT_EXTRA_PROOF_SQLS="$MIGRATION_290240:$FIXTURE"')
    expect(setup).toContain('GRANT service_role TO authenticator')
    expect(fixture).toContain('readiness JSON keys drifted')
    expect(fixture).toContain('cross-mode API dispute mutated authority')
    expect(fixture).toContain('full-refunded API subscription revived')
    expect(fixture).toContain('refund cancellation completion was not durable')
    expect(fixture).toContain('Stripe-active sync revived refunded Pro')
    expect(fixture).toContain('later exact paid period did not restore Pro')
    expect(pg17).toContain('API tier payment reversals PostgreSQL 17 proof passed')
  })

  it('is ordered exactly once after its prerequisites in PREDEPLOY', () => {
    const predeployStart = runner.indexOf('PREDEPLOY_MIGRATIONS=(')
    const quarantineStart = runner.indexOf('QUARANTINED_PREDEPLOY_MIGRATIONS=(')
    const predeploy = runner.slice(predeployStart, quarantineStart)

    expect(predeploy.match(new RegExp(migrationName, 'g'))).toHaveLength(1)
    expect(predeploy.indexOf(migrationName)).toBeGreaterThan(
      predeploy.indexOf('20260729023000_preserve_financial_owner_after_account_deletion.sql')
    )
    expect(runner.slice(quarantineStart)).not.toContain(migrationName)
  })
})
