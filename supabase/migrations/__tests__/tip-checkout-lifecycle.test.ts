import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260721210000_tip_checkout_lifecycle_atomic.sql'),
  'utf8'
)
const fixture = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/tip-checkout-lifecycle.fixture.psql'),
  'utf8'
)
const concurrency = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/tip-checkout-lifecycle.concurrency.pg17.sh'),
  'utf8'
)
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/tip-checkout-lifecycle.pg17.sh'),
  'utf8'
)
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const databaseTypes = readFileSync(resolve(root, 'lib/supabase/database.types.ts'), 'utf8')

function functionBody(name: string): string {
  const startMatch = new RegExp(`CREATE OR REPLACE FUNCTION\\s+public\\.${name}`).exec(migration)
  const start = startMatch?.index ?? -1
  const endMatch = new RegExp(`ALTER FUNCTION\\s+public\\.${name}`).exec(
    migration.slice(Math.max(0, start))
  )
  const end = endMatch ? start + endMatch.index : -1
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return migration.slice(start, end)
}

describe('Tip checkout lifecycle migration', () => {
  it('owns immutable reservation identity independently of nullable parents', () => {
    for (const column of [
      'checkout_expires_at',
      'checkout_failed_at',
      'checkout_failure_reason',
      'checkout_failure_event_id',
      'checkout_failure_event_created_at',
      'checkout_post_id',
      'checkout_to_user_id',
    ]) {
      expect(migration).toContain(`ADD COLUMN ${column}`)
      expect(databaseTypes).toContain(`${column}: string | null`)
    }
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX tips_pending_checkout_reservation_unique[\s\S]*?\(from_user_id, checkout_post_id, amount_cents\)[\s\S]*?WHERE status = 'pending'/
    )
    expect(migration).toContain('NEW.checkout_post_id := NEW.post_id')
    expect(migration).toContain('NEW.checkout_to_user_id := NEW.to_user_id')
    expect(migration).toContain('checkout_post_id IS DISTINCT FROM p_post_id')
    expect(migration).toContain('checkout_to_user_id IS DISTINCT FROM p_to_user_id')
  })

  it('serializes reserve, bind, and expiry in the production lock order', () => {
    const reserve = functionBody('reserve_tip_checkout_atomic')
    const reserveTuple = reserve.indexOf('tip-checkout-reservation:')
    const reserveUsers = reserve.indexOf('FROM auth.users AS user_row')
    const reserveProfiles = reserve.indexOf('FROM public.user_profiles AS profile')
    const reserveAuthority = reserve.indexOf('public.lock_actor_can_interact_with_post(')
    const reserveTip = reserve.indexOf('FROM public.tips AS tip')
    expect(reserveTuple).toBeGreaterThanOrEqual(0)
    expect(reserveUsers).toBeGreaterThan(reserveTuple)
    expect(reserveProfiles).toBeGreaterThan(reserveUsers)
    expect(reserveAuthority).toBeGreaterThan(reserveProfiles)
    expect(reserveTip).toBeGreaterThan(reserveAuthority)

    const bind = functionBody('bind_tip_checkout_session_atomic')
    const bindSession = bind.indexOf('stripe-checkout-session:')
    const bindUsers = bind.indexOf('FROM auth.users AS user_row')
    const bindAuthority = bind.indexOf('public.lock_actor_can_interact_with_post(')
    const bindTipLock = bind.lastIndexOf('FOR UPDATE')
    expect(bindUsers).toBeGreaterThan(bindSession)
    expect(bindAuthority).toBeGreaterThan(bindUsers)
    expect(bindTipLock).toBeGreaterThan(bindAuthority)

    const expiry = functionBody('expire_pending_tip_checkout_atomic')
    const expirySession = expiry.indexOf('stripe-checkout-session:')
    const expiryAuthority = expiry.indexOf('public.lock_tip_notification_authority_atomic(')
    const expiryTip = expiry.indexOf('FROM public.tips AS tip')
    expect(expiryAuthority).toBeGreaterThan(expirySession)
    expect(expiryTip).toBeGreaterThan(expiryAuthority)
  })

  it('keeps replay statuses disjoint and never releases by DB time', () => {
    const reserve = functionBody('reserve_tip_checkout_atomic')
    expect(reserve).toContain('DB time is never authority')
    expect(reserve).toContain('<= pg_catalog.make_interval(mins => 35)')
    expect(reserve).toMatch(
      /WHEN v_tip\.stripe_checkout_session_id IS NOT NULL[\s\S]*?THEN 'already_bound'[\s\S]*?WHEN v_tip\.checkout_expires_at - v_now[\s\S]*?THEN 'reservation_expiring'/
    )
    expect(reserve).toContain('ON CONFLICT (from_user_id, checkout_post_id, amount_cents)')
    expect(reserve).not.toMatch(/DELETE FROM public\.tips/)
  })

  it('records signed contradictions durably before returning terminal ACKs', () => {
    const expiry = functionBody('expire_pending_tip_checkout_atomic')
    for (const reason of [
      'tip_checkout_expiry_subject_missing',
      'tip_checkout_expiry_identity_conflict',
      'tip_checkout_expiry_event_predates_reservation',
      'tip_checkout_expiry_replay_conflict',
      'tip_checkout_expired_after_payment_terminal',
      'tip_checkout_expiry_ownership_conflict',
      'tip_checkout_expiry_event_reuse_conflict',
    ]) {
      expect(expiry).toContain(reason)
    }
    expect(expiry).toContain("checkout_failure_reason = 'checkout_session_expired'")
    expect(migration).toContain('tips_checkout_failure_event_unique')
  })

  it('fails closed on independent-apply predecessor and managed-auth drift', () => {
    expect(migration).toContain("v_auth_owner NOT IN ('postgres', 'supabase_auth_admin')")
    expect(migration).toContain('v_postgres_bypassrls')
    expect(migration).toContain("trigger_row.tgenabled = 'O'")
    expect(migration).toContain('trigger_row.tgtype = 19')
    expect(migration).toContain('index_row.indnkeyatts = 1')
    expect(migration).toContain('tips_from_user_id_fkey')
    expect(migration).toContain('tips_to_user_id_fkey')
    expect(migration).toContain('tips_post_id_fkey')
    expect(migration).toContain('Tip checkout lifecycle function overload drifted')
    expect(pg17).toContain('tip-checkout-lifecycle.managed-auth-mode.psql')
    expect(pg17).toContain('tip-checkout-lifecycle.auth-select-only-drift.psql')
    expect(pg17).toContain('tip-checkout-lifecycle.auth-no-bypass-drift.psql')
  })

  it('proves mixed rollout, tombstones, completion/refund, and real concurrency', () => {
    for (const marker of [
      '$reservation_recovery_safety_margin$',
      '$mixed_deploy_legacy_pending_is_durable_review$',
      '$lifecycle_completion_and_full_refund_preserve_snapshots$',
      '$mixed_deploy_legacy_payment_completion_and_refund$',
      '$parent_tombstone_replay$',
      '$pending_post_tombstone_keeps_tuple_reserved$',
      '$missing_and_predating_expiry_are_durable$',
    ]) {
      expect(fixture).toContain(marker)
    }
    for (const marker of [
      'run_fanout reserve_same_tuple 12',
      'run_fanout bind_same_session 12',
      'run_fanout bind_different_sessions 12',
      'run_fanout expire_same_event 12',
      'run_fanout direct_insert_same_tuple 12',
      'tip_checkout_post_delete_bind',
      'tip_checkout_recipient_delete_expiry',
      'tip_checkout_expiry_completion_expiry',
      '40P01|55P03',
    ]) {
      expect(concurrency).toContain(marker)
    }
  })

  it('ships service-only RPCs, generated types, and the audited runner entry', () => {
    for (const rpc of [
      'reserve_tip_checkout_atomic',
      'bind_tip_checkout_session_atomic',
      'expire_pending_tip_checkout_atomic',
    ]) {
      expect(databaseTypes).toContain(`${rpc}: {`)
      expect(migration).toContain(`public.${rpc}`)
    }
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION[\s\S]*?FROM PUBLIC, anon, authenticated, service_role, authenticator/
    )
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role/)
    const file = '20260721210000_tip_checkout_lifecycle_atomic.sql'
    const predeploy = runner.slice(
      runner.indexOf('PREDEPLOY_MIGRATIONS=('),
      runner.indexOf('INDEPENDENT_PREDEPLOY_MIGRATIONS=(')
    )
    const independent = runner.slice(
      runner.indexOf('INDEPENDENT_PREDEPLOY_MIGRATIONS=('),
      runner.indexOf('POSTDEPLOY_MIGRATIONS=(')
    )
    expect(predeploy).toContain(file)
    expect(independent).toContain(file)
    expect(runner).toContain("TIP_CHECKOUT_LIFECYCLE_VERSION='20260721210000'")
    expect(pg17).toContain('tip-checkout-lifecycle.concurrency.pg17.sh')
  })
})
