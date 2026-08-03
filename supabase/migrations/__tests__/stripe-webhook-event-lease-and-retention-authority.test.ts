import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationName = '20260803153000_stripe_webhook_event_lease_and_retention_authority.sql'
const migration = readFileSync(resolve(root, 'supabase/migrations', migrationName), 'utf8')
const runner = readFileSync(resolve(root, 'scripts/maintenance/apply-launch-migrations.sh'), 'utf8')
const pg17 = readFileSync(resolve(root, 'scripts/qa/stripe-webhook-event-leases.pg17.sh'), 'utf8')
const cleanupRoute = readFileSync(resolve(root, 'app/api/cron/cleanup-data/route.ts'), 'utf8')

function functionBody(name: string): string {
  const marker = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`)
  const match = marker.exec(migration)
  expect(match).not.toBeNull()
  const end = migration.indexOf('\n$function$;', match!.index)
  expect(end).toBeGreaterThan(match!.index)
  return migration.slice(match!.index, end)
}

describe('Stripe webhook event lease and retention authority', () => {
  it('retires every cleanup path and closes direct ledger DML', () => {
    expect(migration).toContain('DROP TRIGGER IF EXISTS trg_cleanup_stripe_events')
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.cleanup_old_stripe_events()')
    expect(migration).toMatch(
      /CREATE TRIGGER trg_reject_stripe_event_destructive_write[\s\S]*BEFORE DELETE OR TRUNCATE ON public\.stripe_events[\s\S]*FOR EACH STATEMENT/
    )
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE[\s\S]*ON TABLE public\.stripe_events[\s\S]*service_role/
    )
    expect(migration).toContain('Stripe webhook event ledger is permanent and append-only')
    expect(pg17).toContain('historical Stripe event was deleted')
    expect(pg17).toMatch(/assert_sql_failure \\\s+direct_service_update/)
    expect(pg17).toMatch(/assert_sql_failure \\\s+direct_service_truncate/)
  })

  it('keeps the runtime cleanup job away from the permanent event ledger', () => {
    expect(cleanupRoute).not.toContain("from('stripe_events')")
    expect(cleanupRoute).not.toContain('stripeEventsCleaned')
  })

  it('deduplicates the exact event ID and test/live mode tuple', () => {
    expect(migration).toContain('UNIQUE NULLS NOT DISTINCT (event_id, livemode)')
    expect(migration).toContain('event_row.livemode = p_livemode')
    expect(migration).toContain("'status', 'processed',\n        'legacy', true")
    expect(pg17).toContain("claim_stripe_event_v2('evt_shared_mode', 'invoice.paid', false)")
    expect(pg17).toContain("claim_stripe_event_v2('evt_shared_mode', 'invoice.paid', true)")
  })

  it('keeps the event type immutable across claim generations', () => {
    const claim = functionBody('claim_stripe_event_v2')

    expect(claim).toContain('v_event.event_type IS DISTINCT FROM p_event_type')
    expect(claim).not.toContain('SET event_type =')
    expect(migration).toContain('CREATE TRIGGER trg_stripe_event_identity')
    expect(migration).toContain('Stripe webhook event identity is immutable')
    expect(pg17).toContain('direct event type mutation unexpectedly succeeded')
  })

  it('issues a new lease per attempt and fences every completion', () => {
    const claim = functionBody('claim_stripe_event_v2')
    const finish = functionBody('finish_stripe_event_v2')

    expect(claim).toContain('v_lease_token := pg_catalog.gen_random_uuid()')
    expect(claim).toContain('v_event.lease_expires_at > v_now')
    expect(finish).toContain('v_event.lease_token IS DISTINCT FROM p_lease_token')
    expect(finish).toContain('v_event.lease_expires_at <= v_now')
    expect(finish).toContain("'status', 'lease_lost'")
    expect(pg17).toContain('stale worker did not overwrite the current claim')
    expect(pg17).toContain('handler failure remains immediately retryable')
  })

  it('keeps old RPC signatures safe during a rolling deployment', () => {
    const legacyClaim = functionBody('claim_stripe_event')
    const legacyFinish = functionBody('finish_stripe_event')

    expect(legacyClaim).toContain('event_row.livemode IS NOT NULL')
    expect(legacyClaim).toContain("RETURN 'busy'")
    expect(legacyClaim).toContain("v_event.status = 'processing'")
    expect(legacyFinish).toContain('event_row.livemode IS NULL')
    expect(legacyFinish).toContain('event_row.lease_token IS NULL')
    expect(pg17).toContain('legacy failed claim retry')
    expect(pg17).toContain('legacy worker fails closed on exact identity')
  })

  it('runs exactly once in PREDEPLOY before the v2 route is released', () => {
    const predeploy = runner.match(/PREDEPLOY_MIGRATIONS=\(([\s\S]*?)\n\)/)?.[1] ?? ''
    const postdeploy = runner.match(/POSTDEPLOY_MIGRATIONS=\(([\s\S]*?)\n\)/)?.[1] ?? ''

    expect(predeploy.match(new RegExp(migrationName, 'g'))).toHaveLength(1)
    expect(postdeploy).not.toContain(migrationName)
    expect(predeploy.indexOf(migrationName)).toBeGreaterThan(
      predeploy.indexOf('20260729230000_token_ranking_generation_barrier.sql')
    )
  })
})
