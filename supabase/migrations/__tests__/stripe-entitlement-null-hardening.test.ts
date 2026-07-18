import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const authority = readFileSync(
  join(root, 'supabase/migrations/20260718183000_atomic_stripe_entitlement_identity.sql'),
  'utf8'
)
const hardening = readFileSync(
  join(root, 'supabase/migrations/20260718183500_harden_stripe_entitlement_null_validation.sql'),
  'utf8'
)
const runner = readFileSync(join(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const basePg17Proof = readFileSync(
  join(root, 'supabase/migrations/__tests__/atomic-stripe-entitlement-identity.pg17.sh'),
  'utf8'
)
const pg17Proof = readFileSync(
  join(root, 'supabase/migrations/__tests__/stripe-entitlement-null-hardening.pg17.sh'),
  'utf8'
)
const pg17Fixture = readFileSync(
  join(root, 'supabase/migrations/__tests__/stripe-entitlement-null-hardening.fixture.psql'),
  'utf8'
)

const hardenedFunctions = [
  'record_charge_refund_tombstone_atomic',
  'release_lifetime_membership_reservation_atomic',
  'reconcile_due_pro_entitlement_projections_atomic',
  'revoke_pro_entitlement_grant_atomic',
  'activate_recurring_entitlement_payment_atomic',
  'activate_recurring_trial_entitlement_atomic',
  'reconcile_recurring_subscription_state_atomic',
  'reconcile_stripe_entitlement_refund_atomic',
] as const

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`)
  const end = source.indexOf(`ALTER FUNCTION public.${name}`, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

function functionHeader(source: string, name: string): string {
  return functionBody(source, name).split('\nRETURNS ')[0]
}

describe('Stripe entitlement NULL validation hardening', () => {
  it('is a PREDEPLOY-only replacement of the eight necessary functions', () => {
    expect(hardening).toContain('BEGIN;')
    expect(hardening).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;')
    expect(hardening).toContain('COMMIT;')
    expect(hardening).not.toMatch(/^\s*DROP\s/im)
    expect(hardening).not.toMatch(/^\s*CREATE TABLE\s/im)
    expect(hardening).not.toMatch(/^\s*ALTER TABLE\s/im)
    expect(hardening).not.toContain(
      'CREATE OR REPLACE FUNCTION public.has_current_global_pro_entitlement'
    )

    const replaced = [
      ...hardening.matchAll(/^CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\(/gm),
    ].map((match) => match[1])
    expect(replaced).toEqual(hardenedFunctions)
    for (const name of hardenedFunctions) {
      expect(functionHeader(hardening, name)).toBe(functionHeader(authority, name))
    }
  })

  it('fails every NULL business enum before any authority work', () => {
    const tombstone = functionBody(hardening, 'record_charge_refund_tombstone_atomic')
    const release = functionBody(hardening, 'release_lifetime_membership_reservation_atomic')
    const recurring = functionBody(hardening, 'activate_recurring_entitlement_payment_atomic')
    const trial = functionBody(hardening, 'activate_recurring_trial_entitlement_atomic')
    const subscription = functionBody(hardening, 'reconcile_recurring_subscription_state_atomic')
    const refund = functionBody(hardening, 'reconcile_stripe_entitlement_refund_atomic')

    expect(tombstone).toContain('OR p_refund_state IS NULL')
    expect(release).toContain('OR p_release_reason IS NULL')
    expect(recurring).toContain('OR p_plan IS NULL')
    expect(recurring).toContain('OR p_payment_status IS NULL')
    expect(recurring).toContain('OR p_stripe_subscription_status IS NULL')
    expect(trial).toContain('OR p_plan IS NULL')
    expect(subscription).toContain('OR p_plan IS NULL')
    expect(subscription).toContain('OR p_stripe_status IS NULL')
    expect(refund).toContain('OR p_payment_kind IS NULL')
    expect(refund).toContain('OR p_payment_status IS NULL')
    expect(refund).toContain('OR p_refund_state IS NULL')
    expect(refund).toContain('p_plan IS NULL')
    expect(refund).toContain('OR p_stripe_subscription_status IS NULL')

    for (const match of hardening.matchAll(/\b(p_[a-z_]+) NOT IN\b/g)) {
      const input = match[1]
      const matchIndex = match.index ?? 0
      const nearbyGuard = hardening.slice(Math.max(0, matchIndex - 120), matchIndex)
      expect(nearbyGuard).toContain(`${input} IS NULL`)
    }
  })

  it('fails all seven malformed or SQL NULL official-group leave ACK paths closed', () => {
    const failClosedAck =
      /IF COALESCE\(v_leave_ack ->> 'status', ''\)\s+NOT IN \('left', 'not_member'\)/g
    expect([...hardening.matchAll(failClosedAck)]).toHaveLength(7)
    expect(hardening).not.toMatch(/IF v_leave_ack ->> 'status' NOT IN \('left', 'not_member'\)/)
  })

  it('postflights exact signatures, postgres ownership and closed ACLs', () => {
    expect(hardening).toContain('pg_catalog.to_regprocedure(required_function.signature)')
    expect(hardening).toContain('function_row.proowner IS DISTINCT FROM v_postgres')
    expect(hardening).toContain("'pg_catalog.jsonb'::pg_catalog.regtype")
    expect(hardening).toContain('function_row.prosecdef IS DISTINCT FROM true')
    expect(hardening).toContain("'service_role',")
    expect(hardening).toContain("'authenticated',")
    expect(hardening).toContain('acl_row.grantee NOT IN (v_postgres, v_service_role)')
  })

  it('registers the hardening only in the ordered PREDEPLOY phase', () => {
    const migration = '20260718183500_harden_stripe_entitlement_null_validation.sql'
    const predeployStart = runner.indexOf('PREDEPLOY_MIGRATIONS=(')
    const postdeployStart = runner.indexOf('POSTDEPLOY_MIGRATIONS=(')
    expect(predeployStart).toBeGreaterThanOrEqual(0)
    expect(postdeployStart).toBeGreaterThan(predeployStart)
    expect(runner.slice(predeployStart, postdeployStart)).toContain(migration)
    expect(runner.slice(postdeployStart)).not.toContain(migration)
    expect(runner.indexOf(migration)).toBeGreaterThan(
      runner.indexOf('20260718183000_atomic_stripe_entitlement_identity.sql')
    )
  })

  it('ships a disposable PostgreSQL 17 proof for rollback-safe rejection', () => {
    expect(basePg17Proof).toContain('STRIPE_ENTITLEMENT_EXTRA_MIGRATION')
    expect(basePg17Proof).toContain('STRIPE_ENTITLEMENT_EXTRA_PROOF_SQL')
    expect(pg17Proof).toContain('20260718183500_harden_stripe_entitlement_null_validation.sql')
    expect(pg17Fixture).toContain('expected 13 NULL business-input rejections')
    expect(pg17Fixture).toContain('NULL enum/status validation changed Stripe entitlement state')
    expect(pg17Fixture).toContain("'malformed'")
    expect(pg17Fixture).toContain("'sql_null'")
    expect(pg17Fixture).toContain('malformed leave ACK did not roll back projection side effects')
    expect(pg17Fixture).toContain('Stripe entitlement NULL validation fixture passed')
    expect(pg17Proof).toContain(
      'Stripe entitlement NULL validation PREDEPLOY PostgreSQL 17 proof passed'
    )
  })
})
