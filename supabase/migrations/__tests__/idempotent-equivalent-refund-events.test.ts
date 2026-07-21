import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260721140000_idempotent_equivalent_refund_events.sql'),
  'utf8'
)
const predecessor = readFileSync(
  resolve(root, 'supabase/migrations/20260718183500_harden_stripe_entitlement_null_validation.sql'),
  'utf8'
)
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const fixture = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/idempotent-equivalent-refund-events.fixture.psql'),
  'utf8'
)
const pg17 = readFileSync(
  resolve(root, 'supabase/migrations/__tests__/idempotent-equivalent-refund-events.pg17.sh'),
  'utf8'
)

function functionBody(source: string): string {
  const start = source.indexOf(
    'CREATE OR REPLACE FUNCTION public.reconcile_stripe_entitlement_refund_atomic('
  )
  const end = source.indexOf(
    'ALTER FUNCTION public.reconcile_stripe_entitlement_refund_atomic(',
    start
  )
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

function migrationNames(arrayName: string): string[] {
  const marker = new RegExp(`^${arrayName}=\\(\\n`, 'm')
  const match = marker.exec(runner)
  expect(match).not.toBeNull()
  const bodyStart = (match?.index ?? 0) + (match?.[0].length ?? 0)
  const bodyEnd = runner.indexOf('\n)', bodyStart)
  expect(bodyEnd).toBeGreaterThan(bodyStart)
  return [...runner.slice(bodyStart, bodyEnd).matchAll(/^\s+(202\d{11}_[a-z0-9_]+\.sql)$/gm)].map(
    (entry) => entry[1]
  )
}

describe('idempotent equivalent Stripe refund events', () => {
  it('replaces only the refund reconciler without changing its public contract', () => {
    const previousBody = functionBody(predecessor)
    const currentBody = functionBody(migration)
    expect(migration).toContain('BEGIN;')
    expect(migration).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;')
    expect(migration).toContain("SET LOCAL lock_timeout = '5s';")
    expect(migration).toContain("SET LOCAL statement_timeout = '2min';")
    expect(migration).toContain('COMMIT;')
    expect(migration).toContain('v_is_predecessor :=')
    expect(migration).toContain('v_is_current :=')
    expect(migration).not.toMatch(/^\s*DROP\s/im)
    expect(migration).not.toMatch(/^\s*CREATE TABLE\s/im)
    expect(migration).not.toMatch(/^\s*ALTER TABLE\s/im)
    expect(
      [...migration.matchAll(/^CREATE OR REPLACE FUNCTION public\.([a-z0-9_]+)\(/gm)].map(
        (match) => match[1]
      )
    ).toEqual(['reconcile_stripe_entitlement_refund_atomic'])
    expect(currentBody.split('\nRETURNS ')[0]).toBe(previousBody.split('\nRETURNS ')[0])
    expect(currentBody).toContain('SECURITY DEFINER')
    expect(currentBody).toContain('SET search_path = pg_catalog, pg_temp')
    expect(currentBody).toContain("SET lock_timeout = '5s'")
  })

  it('uses the complete applied projection before recording the incoming observation', () => {
    const body = functionBody(migration)
    const incoming = body.indexOf('v_incoming_observation := pg_catalog.jsonb_build_object(')
    const applied = body.indexOf('v_same_applied_observation :=')
    const insert = body.indexOf('INSERT INTO public.stripe_entitlement_refund_events (')
    const equivalent = body.indexOf('IF v_same_applied_observation THEN')
    const full = body.indexOf('IF v_existing_full_refund')
    expect(incoming).toBeGreaterThanOrEqual(0)
    expect(applied).toBeGreaterThan(incoming)
    expect(insert).toBeGreaterThan(applied)
    expect(equivalent).toBeGreaterThan(insert)
    expect(full).toBeGreaterThan(equivalent)
    expect(body).toContain('v_payment.refund_state IS NOT DISTINCT FROM p_refund_state')
    expect(body).toContain(
      'v_payment.refund_succeeded_amount\n      IS NOT DISTINCT FROM p_refund_succeeded_amount'
    )
    expect(body).toContain('v_applied_observation IS NOT DISTINCT FROM')
    expect(body).toContain('ORDER BY observation.position DESC')
    expect(body).toContain('pg_catalog.jsonb_build_array(v_incoming_observation)')
    expect(body).not.toContain(
      "RETURN pg_catalog.jsonb_build_object('status', 'already_reconciled');"
    )
  })

  it('removes envelope ordering as authority and quarantines only real regressions', () => {
    const body = functionBody(migration)
    expect(body).not.toContain('ambiguous_refund_event_order')
    expect(body).not.toContain('v_ambiguous_event_order')
    expect(body).toMatch(/IF p_refund_succeeded_amount\s+< v_payment\.refund_succeeded_amount/)
    expect(body).toContain("'charge_refund_aggregate_decreased'")
    expect(body).toContain("'review:charge_refund_aggregate_decreased:'")
    expect(body).toContain("'full_refund_terminal_conflict'")
    expect(body.indexOf('IF v_existing_full_refund')).toBeLessThan(
      body.indexOf('IF p_refund_succeeded_amount')
    )
    expect(body).toContain('p_refund_event_created_at > latest_refund_event_created_at')
    expect(body).not.toMatch(/p_refund_event_created_at\s+<=\s+v_payment\.latest/)
  })

  it('preserves immutable event rows while exact wakeups remain idempotent', () => {
    const body = functionBody(migration)
    expect(body).toContain(
      'v_existing_event.event_created_at\n        IS DISTINCT FROM p_refund_event_created_at'
    )
    expect(body).toContain("'refund_event_identity_conflict'")
    expect(body).toContain('event id carrying a newly observed aggregate must not short-circuit')
    expect(body).toContain('observations\n            || pg_catalog.jsonb_build_array')
    expect(body).toContain("'status',\n      'already_reconciled'")
    expect(body).toContain('max-seen envelope watermark')
  })

  it('reasserts postgres ownership and service-role-only execution', () => {
    expect(migration).toContain(') OWNER TO postgres;')
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION[\s\S]*?FROM PUBLIC, anon, authenticated, service_role, authenticator/
    )
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role/)
    expect(migration).toContain('pg_catalog.aclexplode(')
    expect(migration).toContain('acl_row.grantee NOT IN (v_postgres, v_service_role)')
  })

  it('proves equivalent, monotonic, decreasing, terminal, and identity paths on PostgreSQL 17', () => {
    for (const marker of [
      '$composed_handler_order_still_revokes$',
      '$subscription_status_is_part_of_equivalence$',
      '$equivalent_wakeups_keep_applied_snapshot$',
      '$same_second_growth_reaches_full_terminal$',
      '$partial_aggregate_decrease_is_quarantined$',
      '$full_refund_remains_terminal$',
      '$same_event_growth_and_identity_are_distinct$',
    ]) {
      expect(fixture).toContain(marker)
    }
    expect(pg17).toContain('20260718184550_durable_tip_completion_notification.sql')
    expect(pg17).toContain('20260721140000_idempotent_equivalent_refund_events.sql')
    expect(pg17).toContain('idempotent-equivalent-refund-events.fixture.psql')
  })

  it('places the migration after every current predeploy dependency', () => {
    const migrationName = '20260721140000_idempotent_equivalent_refund_events.sql'
    const predeploy = migrationNames('PREDEPLOY_MIGRATIONS')
    expect(predeploy.indexOf(migrationName)).toBeGreaterThan(
      predeploy.indexOf('20260721130000_raw_object_gc_outbox.sql')
    )
    expect(migrationNames('POSTDEPLOY_MIGRATIONS')).not.toContain(migrationName)
  })
})
