import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const migration = readFileSync(
  join(process.cwd(), 'supabase/migrations/20260729075500_preserve_stripe_event_idempotency.sql'),
  'utf8'
)
const cleanupRoute = readFileSync(join(process.cwd(), 'app/api/cron/cleanup-data/route.ts'), 'utf8')

describe('permanent Stripe webhook idempotency ledger', () => {
  it('removes both legacy retention authorities', () => {
    expect(migration).toContain('DROP TRIGGER IF EXISTS trg_cleanup_stripe_events')
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.cleanup_old_stripe_events()')
    expect(cleanupRoute).not.toContain("from('stripe_events')")
    expect(cleanupRoute).not.toContain('stripeEventsCleaned')
  })

  it('rejects deletion at both the ACL and trigger layers', () => {
    expect(migration).toMatch(
      /CREATE TRIGGER trg_reject_stripe_event_delete[\s\S]*BEFORE DELETE ON public\.stripe_events[\s\S]*FOR EACH STATEMENT/
    )
    expect(migration).toMatch(/REVOKE DELETE ON TABLE public\.stripe_events[\s\S]*service_role/)
    expect(migration).toContain('Stripe webhook event ledger is append-only')
    expect(migration).toContain('Stripe webhook event retention ACL drifted')
  })

  it('is transactional and replayable', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/)
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.reject_stripe_event_delete()')
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
  })
})
