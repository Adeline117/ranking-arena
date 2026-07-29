import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260729072000_stripe_refund_retry_authority.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const worker = readFileSync(resolve(root, 'lib/stripe/entitlement-effect-worker.ts'), 'utf8')
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const readinessRoute = readFileSync(resolve(root, 'app/api/cron/stripe-readiness/route.ts'), 'utf8')
const fixture = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/stripe-refund-retry-authority.fixture.psql'),
  'utf8'
)
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/stripe-refund-retry-authority.pg17.sh'),
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

describe('Stripe automatic Refund retry authority', () => {
  it('persists only an exact Refund provider reference before completion', () => {
    expect(migration).toContain('stripe_entitlement_effects_external_ref_state_check')
    expect(migration).toContain("effect_type = 'payment_auto_refund'")
    expect(migration).toContain("external_ref ~ '^refund:re_[A-Za-z0-9]+$'")
    expect(migration).toContain("~ '^charge:ch_[A-Za-z0-9]+:fully_refunded$'")
    expect(migration).toContain('VALIDATE CONSTRAINT')
  })

  it('keeps the provider reference across retry/dead-letter transitions', () => {
    const finish = functionBody('finish_stripe_entitlement_effect_atomic')

    expect(finish).toContain("p_external_ref !~ '^refund:re_[A-Za-z0-9]+$'")
    expect(finish).toContain('external_ref = COALESCE(p_external_ref, external_ref)')
    expect(finish).toContain("SET status = 'failed'")
    expect(finish).toContain("SET status = 'dead_lettered'")
    expect(fixture).toContain('pending automatic Refund identity was not persisted')
    expect(fixture).toContain('generic retry erased the durable automatic Refund identity')
  })

  it('retrieves pending authority and advances only after terminal failure', () => {
    expect(worker).toContain('dependencies.stripe.refunds.retrieve(persistedRefundId)')
    expect(worker).toContain("persistedRefund.status === 'pending'")
    expect(worker).toContain("persistedRefund.status === 'requires_action'")
    expect(worker).toContain('successorRefundIdempotencyKey(effect.id, persistedRefundId)')
    expect(worker).toContain("createHash('sha256')")
    expect(worker).toContain('error instanceof RetryableEffectError ? error.externalRef : null')
  })

  it('fails launch readiness closed on reference data or constraint drift', () => {
    const readiness = functionBody('stripe_paid_launch_readiness_v2')

    expect(readiness).toContain('stripe_paid_launch_readiness_pre_refund_retry_v2')
    expect(readiness).toContain("'refund_effect_reference_anomalies'")
    expect(readiness).toContain('constraint_row.convalidated')
    expect(readinessRoute).toContain("'refund_effect_reference_anomalies'")
    expect(fixture).toContain(
      'Stripe readiness did not block malformed/missing Refund reference authority'
    )
  })

  it('ships a PostgreSQL 17 proof in real predeploy/postdeploy order', () => {
    expect(pg17).toContain('atomic-stripe-entitlement-identity.pg17.sh')
    expect(pg17).toContain(
      '$MIGRATION_290240:$MIGRATION_290720:$MIGRATION_290650:$MIGRATION_290660:$MIGRATION_290690'
    )
    expect(pg17).toContain('$REFUND_RETRY_FIXTURE')
    expect(fixture).toContain('Stripe automatic Refund retry authority fixture passed')
    expect(pg17).toContain('Stripe automatic Refund retry authority PostgreSQL 17 proof passed')
  })

  it('runs exactly once in PREDEPLOY before the new application contract', () => {
    const predeploy = runner.match(/PREDEPLOY_MIGRATIONS=\(([\s\S]*?)\n\)/)?.[1] ?? ''
    const postdeploy = runner.match(/POSTDEPLOY_MIGRATIONS=\(([\s\S]*?)\n\)/)?.[1] ?? ''

    expect(predeploy.match(new RegExp(migrationName, 'g'))).toHaveLength(1)
    expect(postdeploy).not.toContain(migrationName)
    expect(predeploy.indexOf(migrationName)).toBeGreaterThan(
      predeploy.indexOf('20260729062000_atomic_trader_follow_limit.sql')
    )
  })
})
