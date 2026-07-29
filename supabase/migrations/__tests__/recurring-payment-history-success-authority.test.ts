import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260729074000_recurring_payment_history_success_authority.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const invoiceHandler = readFileSync(
  resolve(root, 'app/api/stripe/webhook/handlers/invoice.ts'),
  'utf8'
)
const databaseTypes = readFileSync(resolve(root, 'lib/supabase/database.types.ts'), 'utf8')
const fixture = readFileSync(
  resolve(
    root,
    'supabase/migrations/__tests__/recurring-payment-history-success-authority.fixture.psql'
  ),
  'utf8'
)
const preFixture = readFileSync(
  resolve(
    root,
    'supabase/migrations/__tests__/recurring-payment-history-success-authority.pre-fixture.psql'
  ),
  'utf8'
)
const pg17 = readFileSync(
  resolve(
    root,
    'supabase/migrations/__tests__/recurring-payment-history-success-authority.pg17.sh'
  ),
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

describe('recurring payment-history success authority', () => {
  it('fails deployment on known canonical identity contradictions', () => {
    expect(migration).toContain('JOIN public.stripe_entitlement_payments AS payment')
    expect(migration).toContain("history.status = 'failed'")
    expect(migration).toContain('manual repair is required')
    expect(migration).toContain('FROM auth.users AS subject')
    expect(preFixture).toContain('Deleted financial-subject payment history pre-fixture passed')
    expect(migration).toContain('payment_history_recurring_invoice_shape_guard')
    expect(migration).toContain('NOT VALID')
  })

  it('makes the financial audit append-only outside the exact promotion path', () => {
    const guard = functionBody('guard_recurring_payment_history_audit')

    expect(guard).toContain("IF TG_OP = 'TRUNCATE'")
    expect(guard).toContain("IF TG_OP = 'DELETE'")
    expect(guard).toContain("'arena.recurring_payment_history_success_authority'")
    expect(guard).toContain("'recurring-success'")
    expect(guard).toContain('pg_catalog.pg_trigger_depth() > 1')
    expect(guard).toContain("OLD.status IS DISTINCT FROM 'failed'")
    expect(guard).toContain("NEW.status IS DISTINCT FROM 'succeeded'")
    expect(guard).toContain('failed payment history contradicts a canonical successful payment')
    expect(migration).toContain('trg_payment_history_recurring_audit_truncate')
  })

  it('records only an exact canonical recurring payment identity', () => {
    const recorder = functionBody('record_recurring_payment_history_success_atomic')

    expect(recorder).toContain('service role required')
    expect(recorder).toContain("'recurring-payment-history-invoice:'")
    expect(recorder).toContain("'recurring-payment-history-pi:'")
    expect(recorder).toContain('FROM public.stripe_entitlement_payments AS payment')
    expect(recorder).toContain("v_payment.payment_kind IS DISTINCT FROM 'recurring'")
    expect(recorder).toContain("v_payment.payment_status NOT IN ('paid', 'succeeded')")
    expect(recorder).toContain('payment_intent_history_collision')
    expect(recorder).toContain('recurring_payment_history_success_identity_conflict')
  })

  it('allows exact replay and failed-to-succeeded promotion without overwrite', () => {
    const recorder = functionBody('record_recurring_payment_history_success_atomic')

    expect(recorder).toContain("'status',\n      'already_recorded'")
    expect(recorder).toContain("'status',\n    'promoted_from_failed'")
    expect(recorder).toContain('stripe_payment_intent_id = p_stripe_payment_intent_id')
    expect(recorder).toContain("status = 'succeeded'")
    expect(recorder).not.toContain('ON CONFLICT (stripe_invoice_id) DO UPDATE')
    expect(fixture).toContain('failed-to-succeeded promotion changed the original audit timestamp')
    expect(fixture).toContain('exact successful replay was not idempotent')
  })

  it('routes the application through the exact one-key RPC contract', () => {
    const succeeded = invoiceHandler.slice(
      invoiceHandler.indexOf('export async function handlePaymentSucceeded'),
      invoiceHandler.indexOf('export async function handlePaymentFailed')
    )

    expect(succeeded).toContain("'record_recurring_payment_history_success_atomic'")
    expect(invoiceHandler).toContain('Object.keys(value).length !== 1')
    expect(succeeded).toContain("historyStatus === 'identity_conflict'")
    expect(succeeded).not.toMatch(/\.from\(\s*['"]payment_history['"]\s*\)\s*\.upsert\(/s)
    expect(databaseTypes).toContain('record_recurring_payment_history_success_atomic:')
    expect(databaseTypes).toContain('p_stripe_payment_intent_id: string | null')
  })

  it('proves every requested conflict and audit-retention boundary on PostgreSQL 17', () => {
    for (const evidence of [
      'cross-user success identity was accepted',
      'cross-amount success identity was accepted',
      'cross-currency success identity was accepted',
      'cross-PaymentIntent success identity was accepted',
      'successful audit row was directly mutated',
      'payment history audit row was directly deleted',
      'payment history audit table was truncated',
      'account deletion did not preserve the audit row',
      'Recurring payment-history success authority fixture passed',
    ]) {
      expect(fixture).toContain(evidence)
    }
    expect(pg17).toContain('atomic-stripe-entitlement-identity.pg17.sh')
    expect(pg17).toContain('$MIGRATION_290730:$PRE_FIXTURE:$MIGRATION_290740:$FIXTURE')
    expect(pg17).toContain('Recurring payment-history success authority PostgreSQL 17 proof passed')
  })

  it('runs exactly once after all canonical payment prerequisites in POSTDEPLOY', () => {
    const predeploy = migrationNames('PREDEPLOY_MIGRATIONS')
    const postdeploy = migrationNames('POSTDEPLOY_MIGRATIONS')

    expect(predeploy).not.toContain(migrationName)
    expect(postdeploy.filter((name) => name === migrationName)).toHaveLength(1)
    expect(postdeploy.indexOf(migrationName)).toBeGreaterThan(
      postdeploy.indexOf('20260729073000_stripe_dispute_funds_withdrawal_authority.sql')
    )
  })
})
