import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260721211000_tip_checkout_completion_identity.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const lifecycleFixture = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/tip-checkout-lifecycle.fixture.psql'),
  'utf8'
)
const lifecyclePg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/tip-checkout-lifecycle.pg17.sh'),
  'utf8'
)
const lifecycleConcurrency = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/tip-checkout-lifecycle.concurrency.pg17.sh'),
  'utf8'
)
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')

function expandedCompletionBody(): string {
  const signature =
    /CREATE OR REPLACE FUNCTION public\.complete_tip_with_stripe_ownership_atomic\([\s\S]*?p_client_reference_id text[\s\S]*?p_event_id text[\s\S]*?\)\s*RETURNS jsonb/
  const match = signature.exec(migration)
  expect(match?.index).toBeGreaterThanOrEqual(0)
  const start = match?.index ?? 0
  const end = migration.indexOf(
    'ALTER FUNCTION public.complete_tip_with_stripe_ownership_atomic(',
    start
  )
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end)
}

describe('Tip checkout completion identity migration', () => {
  it('adds an expanded RPC without replacing the mixed-deploy eight-argument RPC', () => {
    expect(migration).toContain(
      'public.complete_tip_with_stripe_ownership_atomic(uuid,text,text,text,text,bigint,text,timestamptz)'
    )
    for (const argument of [
      'p_client_reference_id',
      'p_metadata_user_id',
      'p_metadata_from_user_id',
      'p_metadata_post_id',
      'p_metadata_to_user_id',
      'p_metadata_amount_cents',
      'p_checkout_expires_at',
      'p_event_id',
    ]) {
      expect(migration).toContain(argument)
    }
    expect(migration).toContain('function_row.oid <> v_completion')
  })

  it('locks the exact audited lifecycle ledger before inspecting live objects', () => {
    const ledgerPreflight = migration.indexOf('DO $exact_lifecycle_ledger$')
    const objectPreflight = migration.indexOf('DO $required_objects$')
    expect(ledgerPreflight).toBeGreaterThanOrEqual(0)
    expect(objectPreflight).toBeGreaterThan(ledgerPreflight)
    expect(migration).toContain("ledger.version = '20260721210000'")
    expect(migration).toContain("ledger.name = 'tip_checkout_lifecycle_atomic'")
    expect(migration).toContain("ledger.created_by = 'codex'")
    expect(migration).toContain('d10a9959b52e20d127553c1683b154a62c97d85c455ff12e831c3a1d5c7ef1ab')
    expect(migration).toMatch(/DO \$exact_lifecycle_ledger\$[\s\S]*FOR SHARE;/)
  })

  it('revalidates immutable Stripe and Tip identity after canonical locks', () => {
    const body = expandedCompletionBody()
    const chargeLock = body.indexOf('stripe-charge-refund:')
    const paymentLock = body.indexOf('stripe-payment-identity:')
    const sessionLock = body.indexOf('stripe-checkout-session:')
    const authorityLock = body.indexOf('public.lock_tip_notification_authority_atomic(')
    const tipLock = body.indexOf('FROM public.tips AS tip')
    const nestedCompletion = body.indexOf(
      'v_result := public.complete_tip_with_stripe_ownership_atomic('
    )
    expect(chargeLock).toBeGreaterThanOrEqual(0)
    expect(paymentLock).toBeGreaterThan(chargeLock)
    expect(sessionLock).toBeGreaterThan(paymentLock)
    expect(authorityLock).toBeGreaterThan(sessionLock)
    expect(tipLock).toBeGreaterThan(authorityLock)
    expect(nestedCompletion).toBeGreaterThan(tipLock)

    for (const check of [
      'v_tip.from_user_id IS DISTINCT FROM p_metadata_user_id',
      'v_tip.checkout_post_id IS DISTINCT FROM p_metadata_post_id',
      'v_tip.checkout_to_user_id IS DISTINCT FROM p_metadata_to_user_id',
      'v_tip.stripe_checkout_session_id IS DISTINCT FROM p_checkout_session_id',
      'v_tip.checkout_expires_at IS DISTINCT FROM p_checkout_expires_at',
      'p_client_reference_id IS DISTINCT FROM p_tip_id::text',
      "p_currency IS DISTINCT FROM 'usd'",
    ]) {
      expect(body).toContain(check)
    }
  })

  it('limits NULL-expiry compatibility to exact bound legacy identity with immutable audit', () => {
    const body = expandedCompletionBody()
    expect(body).toContain('v_tip.checkout_expires_at IS NULL')
    expect(body).toContain('v_tip.stripe_checkout_session_id IS NULL')
    expect(body).toContain('p_client_reference_id IS NOT NULL')
    expect(body).toContain('tip_checkout_completion_legacy_shape_drift')
    expect(body).toContain('tip_checkout_legacy_completion_audits')
    expect(migration).toContain('client_reference_id IS NULL')
    expect(migration).toContain('trg_tip_checkout_legacy_completion_audits_immutable')
    expect(migration).toContain('Tip legacy completion audit rows are immutable')
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE public\.tip_checkout_legacy_completion_audits[\s\S]*?GRANT SELECT ON TABLE public\.tip_checkout_legacy_completion_audits[\s\S]*?TO service_role/
    )
  })

  it('persists every deterministic completion contradiction before acknowledging it', () => {
    for (const reason of [
      'tip_checkout_completion_subject_missing',
      'tip_checkout_completion_after_expiry',
      'tip_checkout_completion_payer_drift',
      'tip_checkout_completion_amount_drift',
      'tip_checkout_completion_snapshot_drift',
      'tip_checkout_completion_session_drift',
      'tip_checkout_completion_lifecycle_drift',
      'tip_checkout_legacy_audit_identity_reuse',
      'tip_checkout_legacy_audit_replay_conflict',
    ]) {
      expect(migration).toContain(reason)
    }
    expect(migration).toContain('public.record_stripe_manual_review_atomic(')
  })

  it('converges ACLs and re-attests every SECURITY DEFINER dependency before commit', () => {
    const converge = migration.indexOf('DO $converge_acl$')
    const postflight = migration.indexOf('DO $postflight$')
    const notify = migration.indexOf("NOTIFY pgrst, 'reload schema';")
    const commit = migration.lastIndexOf('COMMIT;')
    expect(converge).toBeGreaterThanOrEqual(0)
    expect(postflight).toBeGreaterThan(converge)
    expect(notify).toBeGreaterThan(postflight)
    expect(commit).toBeGreaterThan(notify)
    for (const marker of [
      "relation.relkind = 'r'",
      "relation.relpersistence = 'p'",
      'attribute.attacl IS NULL',
      'trigger_row.tgtype = 27',
      'acl_row.is_grantable',
      'function_row.proargnames',
      'function_row.proconfig IS DISTINCT FROM ARRAY[',
      "extensions.digest(function_row.prosrc, 'sha256')",
      '3b7f906d3bbadba61ac8ac103921f8711425d59c8349840dfc56ddda15d27146',
      '40953ad533d19339ac23c42aa0893a009c5ac8fc9cc5e1fd375d1a2c05ea272f',
      'c3ceb0b30556e234321ca061496012cf6b51c360515516cb01e683643f8b774d',
      '229187be40e62e0014e948dfb6c801a0ad7f3b1946e9ed884157f5c615993292',
      '7c29e8275b6ccd6388c2308bd44cb00181aa042e55cdd95b57861397772e496e',
      '8c6ddc5473c9092822b853b3d6105248',
    ]) {
      expect(migration).toContain(marker)
    }
  })

  it('covers new identity drift, exact legacy compatibility, refund, and runner order in PG17', () => {
    for (const marker of [
      '$expanded_completion_exact_lifecycle$',
      '$expanded_completion_snapshot_drift$',
      '$expanded_completion_exact_legacy_audit_and_refund$',
      '$expanded_completion_legacy_shape_rejected$',
    ]) {
      expect(lifecycleFixture).toContain(marker)
    }
    expect(lifecyclePg17).toContain('MIGRATION_21211000')
    expect(lifecyclePg17).toContain('EXACT_LEDGER_SETUP')
    expect(lifecyclePg17).toContain('DRIFTED_LEDGER_SETUP')
    expect(lifecycleConcurrency).toContain('evt_tip_expiry_completion_complete')
    expect(lifecycleConcurrency).toContain('PAIR_SECOND_RESULT" != "manual_review')

    const predeploy = runner.slice(
      runner.indexOf('PREDEPLOY_MIGRATIONS=('),
      runner.indexOf('INDEPENDENT_PREDEPLOY_MIGRATIONS=(')
    )
    const independent = runner.slice(
      runner.indexOf('INDEPENDENT_PREDEPLOY_MIGRATIONS=('),
      runner.indexOf('POSTDEPLOY_MIGRATIONS=(')
    )
    expect(predeploy).toContain(migrationName)
    expect(predeploy.indexOf('20260721210000_tip_checkout_lifecycle_atomic.sql')).toBeLessThan(
      predeploy.indexOf(migrationName)
    )
    expect(independent).toContain(migrationName)
    expect(runner).toContain('TIP_CHECKOUT_CUTOVER_VERSIONS=(')
    expect(runner).toContain('20260721211000')
  })
})
