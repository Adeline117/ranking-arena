import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const authority = readFileSync(
  join(root, 'supabase/migrations/20260718183000_atomic_stripe_entitlement_identity.sql'),
  'utf8'
)
const nullHardening = readFileSync(
  join(root, 'supabase/migrations/20260718183500_harden_stripe_entitlement_null_validation.sql'),
  'utf8'
)
const corrective = readFileSync(
  join(
    root,
    'supabase/migrations/20260718183600_fix_stripe_lifetime_duplicate_and_early_expiry.sql'
  ),
  'utf8'
)
const runner = readFileSync(join(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const basePg17Proof = readFileSync(
  join(root, 'supabase/migrations/__tests__/atomic-stripe-entitlement-identity.pg17.sh'),
  'utf8'
)
const pg17Proof = readFileSync(
  join(root, 'supabase/migrations/__tests__/stripe-lifetime-terminal-corrections.pg17.sh'),
  'utf8'
)
const pg17Fixture = readFileSync(
  join(root, 'supabase/migrations/__tests__/stripe-lifetime-terminal-corrections.fixture.psql'),
  'utf8'
)

const releaseName = 'release_lifetime_membership_reservation_atomic'
const lifetimeName = 'activate_lifetime_membership_with_identity_atomic'
const reserveName = 'reserve_lifetime_membership_spot_atomic'
const currentnessName = 'stripe_entitlement_effect_is_current_v2'
const leaseName = 'lease_stripe_entitlement_effects_atomic'
const finishName = 'finish_stripe_entitlement_effect_atomic'

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`)
  const end = source.indexOf(`ALTER FUNCTION public.${name}`, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

function referencedAndDeclaredVariables(body: string) {
  const withoutStringsOrComments = body.replace(/--.*$/gm, '').replace(/'(?:''|[^'])*'/g, "''")
  const declareStart = withoutStringsOrComments.indexOf('\nDECLARE\n')
  const begin = withoutStringsOrComments.indexOf('\nBEGIN\n', declareStart)
  expect(declareStart).toBeGreaterThanOrEqual(0)
  expect(begin).toBeGreaterThan(declareStart)
  const declarations = withoutStringsOrComments.slice(declareStart, begin)
  const declared = new Set(
    [...declarations.matchAll(/^\s*(v_[a-z0-9_]+)\s+/gm)].map((match) => match[1])
  )
  const referenced = new Set(
    [...withoutStringsOrComments.matchAll(/\b(v_[a-z0-9_]+)\b/g)].map((match) => match[1])
  )
  return { declared, referenced }
}

describe('Stripe lifetime terminal-path corrections', () => {
  it('replaces only the six lifetime corrective PREDEPLOY function bodies', () => {
    expect(corrective).toContain('BEGIN;')
    expect(corrective).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;')
    expect(corrective).toContain('COMMIT;')
    expect(corrective).not.toMatch(/^\s*DROP\s/im)
    expect(corrective).not.toMatch(/^\s*CREATE TABLE\s/im)
    expect(corrective).not.toMatch(/^\s*ALTER TABLE\s/im)

    const replaced = [
      ...corrective.matchAll(/^CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\(/gm),
    ].map((match) => match[1])
    expect(replaced).toEqual([
      reserveName,
      releaseName,
      lifetimeName,
      currentnessName,
      leaseName,
      finishName,
    ])
  })

  it('repairs the duplicate owner reference and captures only exact recurring authority', () => {
    const original = functionBody(authority, lifetimeName)
    const badReferences = original.match(/\bv_effective_user_id\b/g) ?? []
    expect(badReferences).toHaveLength(1)

    const corrected = functionBody(corrective, lifetimeName)
    expect(corrected).not.toContain('v_effective_user_id')
    expect(corrected).toContain("'duplicate_lifetime_purchase'")
    expect(corrected).toContain("'duplicate_refund_queued'")
    expect(corrected).toContain("'payment_auto_refund'")
    expect(corrected).toContain('v_superseded_stripe_subscription_id')
    expect(corrected).toContain(
      'public.stripe_subscription_has_exact_payment_binding_v2(p_user_id)'
    )
    expect(corrected).toContain('public.stripe_subscription_has_exact_trial_binding_v2(p_user_id)')
    expect(corrected).toContain("'stripe_subscription_cancel'")
    expect(corrected).toContain("'lifetime_membership_activated'")
    expect(corrected.indexOf("'stripe_subscription_cancel'")).toBeLessThan(
      corrected.indexOf('INSERT INTO public.subscriptions (')
    )
  })

  it('returns the durable original nonce for both reservation recovery paths', () => {
    const original = functionBody(authority, reserveName)
    const corrected = functionBody(corrective, reserveName)
    const expected = original.replaceAll(
      "      'reservation_id',\n      v_existing.id,\n      'reservation_status',",
      "      'reservation_id',\n" +
        '      v_existing.id,\n' +
        "      'request_nonce',\n" +
        '      v_existing.request_nonce,\n' +
        "      'reservation_status',"
    )
    expect(corrected).toBe(expected)
    expect(corrected.match(/'request_nonce',\n\s+v_existing\.request_nonce/g)).toHaveLength(2)
  })

  it('preserves NULL hardening while accepting only exact bound early signed expiry', () => {
    const hardened = functionBody(nullHardening, releaseName)
    const expected = hardened.replace(
      '        OR p_event_created_at < v_reservation.checkout_expires_at',
      '        OR p_event_created_at\n' +
        '          < v_reservation.created_at\n' +
        '            - pg_catalog.make_interval(mins => 5)'
    )
    const corrected = functionBody(corrective, releaseName)

    expect(corrected).toBe(expected)
    expect(corrected).toContain('p_release_reason IS NULL')
    expect(corrected).toContain('v_reservation.checkout_session_id')
    expect(corrected).toContain('IS DISTINCT FROM p_checkout_session_id')
    expect(corrected).toContain('v_reservation.created_at')
    expect(corrected).not.toContain('p_event_created_at < v_reservation.checkout_expires_at')
  })

  it('has no undeclared v_ reference in any declaring PL/pgSQL function', () => {
    for (const name of [reserveName, releaseName, lifetimeName, finishName]) {
      const { declared, referenced } = referencedAndDeclaredVariables(
        functionBody(corrective, name)
      )
      const undeclared = [...referenced].filter((variable) => !declared.has(variable))
      expect(undeclared).toEqual([])
    }
    expect(functionBody(corrective, leaseName)).not.toMatch(/\bv_[a-z0-9_]+\b/)
    expect(functionBody(corrective, lifetimeName)).not.toContain('v_effective_user_id')
  })

  it('leases remote cancellation only for unrefunded current lifetime authority', () => {
    const currentness = functionBody(corrective, currentnessName)
    expect(currentness).toContain("effect.effect_type = 'stripe_subscription_cancel'")
    expect(currentness).toContain("'lifetime_membership_activated'")
    expect(currentness).toContain("payment.payment_kind = 'lifetime'")
    expect(currentness).toContain("payment.refund_state = 'succeeded'")
    expect(currentness).toContain('payment.refund_succeeded_amount')
    expect(currentness).toContain("subscription.plan = 'lifetime'")
    expect(currentness).toContain("subscription.status = 'active'")
    expect(currentness).toContain('public.stripe_subscription_has_exact_payment_binding_v2')
    expect(currentness).toContain('effect.operation_key =')
    expect(currentness).toContain('payment.stripe_customer_id =')
    expect(currentness).toContain('payment.user_id IS NULL')
    expect(currentness).toContain('effect.user_id IS NULL')
    expect(currentness).toContain("'stripe_subscription_cancel',")

    for (const name of [leaseName, finishName]) {
      expect(functionBody(corrective, name)).toMatch(
        /'payment_manual_review',\s+'stripe_subscription_cancel'/
      )
    }
  })

  it('changes lease and finish only by exempting exact cancellation cleanup', () => {
    const expectedLease = functionBody(authority, leaseName).replace(
      "          'payment_manual_review'\n        )",
      "          'payment_manual_review',\n" +
        "          'stripe_subscription_cancel'\n" +
        '        )'
    )
    expect(functionBody(corrective, leaseName)).toBe(expectedLease)

    const expectedFinish = functionBody(authority, finishName).replace(
      "      'payment_manual_review'\n    )",
      "      'payment_manual_review',\n" + "      'stripe_subscription_cancel'\n" + '    )'
    )
    expect(functionBody(corrective, finishName)).toBe(expectedFinish)
  })

  it('postflights signatures, owner, security settings and closed ACLs', () => {
    for (const fragment of [
      'function_row.proowner = v_postgres',
      "'pg_catalog.jsonb'::pg_catalog.regtype",
      'function_row.prosecdef',
      "function_row.provolatile = 'v'",
      "function_row.proparallel = 'u'",
      "language_row.lanname = 'plpgsql'",
      "'search_path=pg_catalog, pg_temp'",
      "'lock_timeout=5s'",
      "'service_role',",
      "'authenticated',",
      "'authenticator',",
      'acl_row.grantee NOT IN (v_postgres, v_service_role)',
    ]) {
      expect(corrective).toContain(fragment)
    }
    expect(corrective.match(/REVOKE ALL ON FUNCTION/g)).toHaveLength(6)
    expect(corrective.match(/GRANT EXECUTE ON FUNCTION/g)).toHaveLength(5)
  })

  it('registers the corrective migration only after authority in PREDEPLOY', () => {
    const migration = '20260718183600_fix_stripe_lifetime_duplicate_and_early_expiry.sql'
    const predeployStart = runner.indexOf('PREDEPLOY_MIGRATIONS=(')
    const postdeployStart = runner.indexOf('POSTDEPLOY_MIGRATIONS=(')
    expect(predeployStart).toBeGreaterThanOrEqual(0)
    expect(postdeployStart).toBeGreaterThan(predeployStart)
    expect(runner.slice(predeployStart, postdeployStart)).toContain(migration)
    expect(runner.slice(postdeployStart)).not.toContain(migration)
    expect(runner.indexOf(migration)).toBeGreaterThan(
      runner.indexOf('20260718183500_harden_stripe_entitlement_null_validation.sql')
    )
    expect(runner.indexOf(migration)).toBeLessThan(
      runner.indexOf('20260718184000_arena_score_inputs_board_as_of.sql')
    )
  })

  it('ships real PostgreSQL 17 duplicate, early-expiry and replay proofs', () => {
    expect(basePg17Proof).toContain('STRIPE_ENTITLEMENT_EXTRA_MIGRATIONS')
    expect(basePg17Proof).toContain('STRIPE_ENTITLEMENT_EXTRA_PROOF_SQLS')
    expect(pg17Proof).toContain('20260718183500_harden_stripe_entitlement_null_validation.sql')
    expect(pg17Proof).toContain('20260718183600_fix_stripe_lifetime_duplicate_and_early_expiry.sql')
    expect(pg17Proof).toContain('stripe-entitlement-null-hardening.fixture.psql')
    for (const marker of [
      'duplicate lifetime purchase did not return durable refund status',
      'duplicate lifetime payment review/refund outbox rolled back or drifted',
      'duplicate lifetime refund replay was not idempotent',
      'early signed-expiry fixture did not precede natural expiry',
      'late-bind signed-expiry fixture did not cross the mutable bind boundary',
      'exact bound early signed-expiry did not durably release its seat',
      'exact early signed-expiry replay was not idempotent',
      'early signed-expiry replay identity was not immutable',
      'unbound ambiguous-create Session was silently trusted',
      'already_reserved did not recover the original reservation nonce',
      'reservation_exists did not recover the original reservation nonce',
      'exact recurring to lifetime did not queue one current cancel effect',
      'recurring cancellation effect replay was not idempotent',
      'full lifetime refund did not fence subscription cancellation currentness',
      'full lifetime refund did not fence leased cancellation completion',
      'nonexact legacy subscription projection queued a guessed cancellation',
      'active recurring cancellation did not lease and finish idempotently',
      'banned recurring cancellation was incorrectly subject-gated',
      'hard-deleted recurring cancellation was not financially actionable',
      'wrong cancellation customer payload remained current',
      'wrong cancellation operation remained current',
      'wrong cancellation subscription payload remained current',
      'full lifetime refund was leased for remote cancellation',
      'Stripe lifetime terminal corrections fixture passed',
    ]) {
      expect(pg17Fixture).toContain(marker)
    }
    expect(pg17Proof).toContain(
      'Stripe lifetime terminal corrections PREDEPLOY PostgreSQL 17 proof passed'
    )
  })
})
