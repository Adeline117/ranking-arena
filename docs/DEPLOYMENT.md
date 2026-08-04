# Deployment Checklist

## Pre-Deploy

- [ ] `npm run type-check` passes (0 errors)
- [ ] `npm run test` passes (0 failures)
- [ ] `npm run lint` passes (0 errors)
- [ ] No `NEXT_PUBLIC_` secrets exposed
- [ ] Migration is backwards-compatible (no column drops without deprecation)
- [ ] Feature flags set for risky changes
- [ ] Contract releases with schema, workers, and app use their dedicated staged
      runbook and one frozen exact current-main SHA

## Post-Deploy (within 5 minutes)

- [ ] Check /api/health/pipeline — all platforms healthy
- [ ] Check Sentry for new error spikes
- [ ] Verify homepage loads with rankings data
- [ ] Check Telegram alerts for pipeline failures

## Rollback boundaries

- A failed database migration statement or in-transaction postflight is rolled
  back automatically by PostgreSQL. Before retrying, prove the exact ledger row
  and all objects from that one-shot attempt are absent; a client timeout is not
  proof of absence.
- Deploy Gate may automatically promote the exact previously serving Vercel
  deployment when immediate post-promotion smoke fails. Treat that as temporary
  2C containment. If schema or workers already moved, the previous app is a
  known release mismatch and must not become steady state.
- After any staged worker/app cutover succeeds or new-contract data commits, do
  not manually promote or deploy an old SHA. Recovery code must be a reviewed
  revert or forward commit that becomes exact current `origin/main`, then passes
  the normal controlled deployment paths for every affected runtime.
- Database migration rollback is a new reviewed forward compensating migration;
  do not delete/repair ledger rows, edit immutable data, or improvise a down
  migration.
- A feature flag may be disabled through its reviewed production control only
  when the schema/data contract explicitly supports that state. It does not
  authorize a mixed application/worker release.

For verified position-history specifically, use the exact order and failure
rules in the
[staged rollout](./VERIFIED_POSITION_HISTORY_ROLLOUT.md): prerequisite →
publication authority with the old runtime → both same-SHA worker regions →
same-SHA Deploy Gate/application promotion → exact 2C canary.

## Point-in-time recovery

PITR is disaster recovery for the whole database, not a normal migration
rollback checkbox. Restoring to a timestamp discards every later production
write, including unrelated user, billing, and 2C state. Invoke it only as a
deliberate incident decision with an approved recovery point, blast-radius
assessment, write freeze, restore validation, and reconciliation plan.

## Supabase Connection Pool

- Pool mode: Transaction (pgbouncer)
- Max connections: ~60 (Supabase Pro default)
- Query timeout: 45s (configured in lib/supabase/server.ts)
- If pool exhausted: cron jobs fail with "too many clients" → auto-recovers in ~30s
