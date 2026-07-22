import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260718184550_durable_tip_completion_notification.sql'),
  'utf8'
)
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const databaseTypes = readFileSync(resolve(root, 'lib/supabase/database.types.ts'), 'utf8')
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/durable-tip-completion-notification.pg17.sh'),
  'utf8'
)
const preSetup = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/durable-tip-completion-notification.pre-setup.psql'),
  'utf8'
)
const fixture = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/durable-tip-completion-notification.fixture.psql'),
  'utf8'
)
const concurrency = readFileSync(
  resolve(
    root,
    'supabase/migrations/__tests__/durable-tip-completion-notification.concurrency.pg17.sh'
  ),
  'utf8'
)
const baseHarness = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/atomic-stripe-entitlement-identity.pg17.sh'),
  'utf8'
)

function between(start: string, end: string): string {
  const startIndex = migration.indexOf(start)
  const endIndex = migration.indexOf(end, startIndex + start.length)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return migration.slice(startIndex, endIndex)
}

describe('durable tip completion notification migration', () => {
  it('fails closed on the production uuid reference shape and ambiguous history', () => {
    expect(migration).toContain(
      "('notifications', 'reference_id', 'uuid'::pg_catalog.regtype, false)"
    )
    expect(migration).toContain(
      'duplicate tip_received reference_id values require explicit review'
    )
    expect(migration).toContain(
      'historical completed tips without a notification require explicit classification'
    )
    expect(migration).toContain('No historical row is rewritten or')
    expect(pg17).toContain('durable-tip-completion-notification.reference-drift.psql')
    expect(pg17).toContain(
      'durable tip notification column shape is incompatible: notifications.reference_id'
    )
  })

  it('installs exact active-row idempotency plus a non-cascading durable ledger', () => {
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX notifications_tip_received_reference_unique[\s\S]*?ON public\.notifications \(reference_id\)[\s\S]*?WHERE type = 'tip_received'/
    )
    expect(migration).toContain('notifications_tip_received_reference_required')

    const ledger = between(
      'CREATE TABLE public.tip_completion_notification_deliveries (',
      'CREATE UNIQUE INDEX tip_completion_notification_delivery_notification_key'
    )
    expect(ledger).toContain('tip_id uuid PRIMARY KEY')
    expect(ledger).toContain('notification_id uuid')
    expect(ledger).toContain('payload_spec text NOT NULL')
    expect(ledger).toContain('disposition text NOT NULL')
    expect(ledger).not.toContain('REFERENCES')
    expect(migration).toContain('FORCE ROW LEVEL SECURITY')
    expect(migration).toMatch(
      /GRANT SELECT ON TABLE public\.tip_completion_notification_deliveries[\s\S]*?TO service_role/
    )
  })

  it('preserves 181845 financial logic behind an owner-only same-signature wrapper', () => {
    expect(migration).toMatch(
      /ALTER FUNCTION public\.complete_tip_with_stripe_ownership_atomic\([\s\S]*?RENAME TO complete_tip_with_stripe_ownership_financial_legacy_v2/
    )
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.complete_tip_with_stripe_ownership_atomic\([\s\S]*?p_tip_id uuid[\s\S]*?p_completed_at timestamptz[\s\S]*?RETURNS jsonb/
    )
    expect(migration).toContain('public.complete_tip_with_stripe_ownership_financial_legacy_v2(')
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION[\s\S]*?complete_tip_with_stripe_ownership_financial_legacy_v2[\s\S]*?FROM PUBLIC, anon, authenticated, service_role, authenticator/
    )
    expect(databaseTypes).toMatch(/complete_tip_with_stripe_ownership_atomic:\s*(?:\|\s*)?\{/)
  })

  it('takes Stripe advisories, lifecycle parents, and tip rows in one global order', () => {
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.lock_tip_notification_authority_atomic\([\s\S]*?FROM auth\.users AS user_row[\s\S]*?ORDER BY user_row\.id[\s\S]*?FOR KEY SHARE[\s\S]*?FROM public\.user_profiles AS profile[\s\S]*?FOR SHARE[\s\S]*?FROM public\.posts AS post[\s\S]*?FOR SHARE[\s\S]*?FROM public\.tips AS tip[\s\S]*?FOR UPDATE/
    )
    expect(migration).toContain("USING ERRCODE = 'PTA01'")
    expect(migration).toContain("USING ERRCODE = '40001'")

    const completionWrapper = between(
      'CREATE OR REPLACE FUNCTION public.complete_tip_with_stripe_ownership_atomic(',
      'ALTER FUNCTION public.complete_tip_with_stripe_ownership_atomic('
    )
    const completionCharge = completionWrapper.indexOf('stripe-charge-refund:')
    const completionIntent = completionWrapper.indexOf('stripe-payment-identity:')
    const completionSession = completionWrapper.indexOf('stripe-checkout-session:')
    const completionAuthority = completionWrapper.indexOf(
      'public.lock_tip_notification_authority_atomic(p_tip_id)'
    )
    const completionFinancial = completionWrapper.indexOf(
      'public.complete_tip_with_stripe_ownership_financial_legacy_v2('
    )
    expect(completionCharge).toBeGreaterThanOrEqual(0)
    expect(completionIntent).toBeGreaterThan(completionCharge)
    expect(completionSession).toBeGreaterThan(completionIntent)
    expect(completionAuthority).toBeGreaterThan(completionSession)
    expect(completionFinancial).toBeGreaterThan(completionAuthority)

    const refundWrapper = between(
      'CREATE OR REPLACE FUNCTION\n' +
        '  public.stripe_resolve_non_entitlement_refund_tombstone_atomic(',
      '-- Preserve the already-proven 181845 financial state machine byte-for-byte.'
    )
    expect(refundWrapper.indexOf('stripe-charge-refund:')).toBeGreaterThanOrEqual(0)
    expect(refundWrapper.indexOf('stripe-payment-identity:')).toBeGreaterThan(
      refundWrapper.indexOf('stripe-charge-refund:')
    )
    expect(refundWrapper.indexOf('stripe-checkout-session:')).toBeGreaterThan(
      refundWrapper.indexOf('stripe-payment-identity:')
    )
    expect(refundWrapper.indexOf('public.lock_tip_notification_authority_atomic(')).toBeGreaterThan(
      refundWrapper.indexOf('stripe-checkout-session:')
    )
    expect(
      refundWrapper.indexOf('public.stripe_resolve_non_entitlement_refund_notification_legacy_v2(')
    ).toBeGreaterThan(refundWrapper.indexOf('public.lock_tip_notification_authority_atomic('))

    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION[\s\S]*?lock_tip_notification_authority_atomic\(uuid\)[\s\S]*?stripe_resolve_non_entitlement_refund_notification_legacy_v2\(uuid\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role, authenticator/
    )
  })

  it('derives a stable payload from locked authority rather than webhook metadata or handle', () => {
    expect(migration).toContain('FROM public.user_profiles AS profile')
    expect(migration).toContain('FOR KEY SHARE')
    expect(migration).toContain('FROM public.posts AS post')
    expect(migration).toContain('v_expected_link := CASE')
    expect(migration).toContain("THEN '/post/' || v_tip.post_id::text")
    expect(migration).toContain('v_tip.amount_cents::numeric / 100')
    expect(migration).not.toContain('session.metadata')
    expect(migration).not.toContain("-> 'metadata'")
    expect(migration).not.toContain('.handle')
  })

  it('allows read state only, tombstones recipient deletion, and terminally suppresses refunds', () => {
    expect(migration).toContain("pg_catalog.to_jsonb(NEW) - 'read' - 'read_at'")
    expect(migration).toContain('record_tip_notification_user_deletion()')
    expect(migration).toContain("SET disposition = 'recipient_deleted'")
    expect(migration).toContain('suppress_terminal_tip_notification()')
    expect(migration).toContain("NEW.status NOT IN ('refunded', 'identity_conflict')")
    expect(migration).toContain("'refund_suppressed'")
    expect(migration).toContain("'identity_conflict_suppressed'")
    expect(migration).toContain("'recipient_deleted'")
    expect(migration).toContain("'authority_deleted'")
    expect(migration).toContain("'authority_unavailable'")
    expect(migration).toContain("'tip_completion_unavailable_v1'")
    expect(migration).toContain('suppress_detached_tip_notification()')
    expect(migration).toContain('FROM auth.users AS deleted_recipient')
    expect(migration).toContain('FROM public.posts AS deleted_post')
  })

  it('proves replay, user deletion, refunds, conflict, rollback, ACL, and concurrency', () => {
    for (const marker of [
      '$first_completion_and_replay$',
      '$deleted_notification_replay_does_not_resurrect$',
      '$refund_first_never_notifies$',
      '$refund_after_removes_active_notification$',
      '$conflicting_notification_is_durably_quarantined$',
      '$delivery_exception_rolls_back_everything$',
      '$identity_conflict_is_suppressed_and_reviewed$',
      '$deleted_recipient_and_post_use_cached_delivery_authority$',
      '$pre_delivery_authority_lifecycle_is_terminal$',
      '$missing_tip_is_durable_manual_review$',
      '$readiness_includes_notification_delivery_authority$',
      '$delivery_acl_is_read_only$',
      '$production_fk_trigger_order_matches$',
      '$prime_recipient_refund_race$',
    ]) {
      expect(fixture).toContain(marker)
    }
    expect(pg17).toContain('durable-tip-completion-notification.concurrency.pg17.sh')
    expect(pg17).toContain(
      'SETUP_CHAIN="$NOTIFICATION_PRE_SETUP:$NON_ENTITLEMENT_SETUP:$NOTIFICATION_SETUP"'
    )
    expect(preSetup).toContain('CREATE TABLE public.notifications (')
    expect(preSetup).not.toContain('CREATE TABLE public.tips (')
    for (const marker of [
      'durable_tip_post_delete_completion',
      'durable_tip_post_delete_parent',
      'durable_tip_actor_delete_completion',
      'durable_tip_actor_delete_parent',
      'durable_tip_recipient_delete_refund',
      'durable_tip_recipient_delete_parent',
      '40P01|55P03',
      'wait_for_activity_event "$first_marker" Timeout PgSleep',
      'wait_for_activity_event "$second_marker" Lock',
      'post-delete completion replay',
      'actor-delete completion replay',
      'recipient-delete refund replay',
    ]) {
      expect(concurrency).toContain(marker)
    }
    expect(baseHarness).toContain('STRIPE_ENTITLEMENT_EXTRA_PROOF_SHELLS')
    expect(baseHarness).toContain('notification_delivery_anomalies')
    expect(baseHarness).toContain('"$extra_proof_shell" "$SOCKET_DIR" "$PORT" "$PG_BIN"')
  })

  it('extends paid launch readiness with fail-closed delivery authority', () => {
    expect(migration).toMatch(
      /ALTER FUNCTION public\.stripe_paid_launch_readiness_v2\(\)[\s\S]*?RENAME TO stripe_paid_launch_readiness_non_notification_legacy_v2/
    )
    expect(migration).toContain("'notification_delivery_anomalies'")
    expect(migration).toContain("v_base ->> 'status' = 'ready'")
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION[\s\S]*?stripe_paid_launch_readiness_non_notification_legacy_v2[\s\S]*?FROM PUBLIC, anon, authenticated, service_role, authenticator/
    )
  })

  it('keeps the launch chain and generated table contract synchronized', () => {
    const previous = runner.indexOf('20260718184500_classify_non_entitlement_stripe_payments.sql')
    const current = runner.indexOf('20260718184550_durable_tip_completion_notification.sql')
    expect(previous).toBeGreaterThanOrEqual(0)
    expect(current).toBeGreaterThan(previous)
    expect(databaseTypes).toContain('tip_completion_notification_deliveries: {')
    expect(databaseTypes).toContain('payload_spec: string')
    expect(databaseTypes).toContain('disposition: string')
    expect(databaseTypes).toContain('post_id: string | null')
    expect(databaseTypes).toContain('recipient_user_id: string | null')
    expect(databaseTypes).toContain('Relationships: []')
  })
})
