# Deployment Checklist

**Owner:** Production on-call (repository CODEOWNERS fallback)
**Last verified:** 2026-08-04

## Pre-Deploy

- [ ] `npm run type-check` passes (0 errors)
- [ ] `npm run test` passes (0 failures)
- [ ] `npm run lint` passes (0 errors)
- [ ] No `NEXT_PUBLIC_` secrets exposed
- [ ] Migration is backwards-compatible (no column drops without deprecation)
- [ ] Any rollout control used by the change exists in code and is covered by a rollback test

## Post-Deploy (within 5 minutes)

- [ ] Run the authenticated pipeline monitor and require an available active-registry authority, a fresh snapshot, and a healthy top-level verdict
- [ ] Check Sentry for new error spikes
- [ ] Verify homepage loads with rankings data
- [ ] Check Telegram alerts for pipeline failures
- [ ] Confirm Deploy Gate's exact-SHA smoke completed; use Dashboard promotion only if automated rollback is unavailable or unproved

## Rollback

- [ ] Vercel: Dashboard → Deployments → Promote previous
- [ ] Database: Supabase → Database → Backups → PITR
- [ ] Social surface only: set `NEXT_PUBLIC_FEATURE_SOCIAL=false` and redeploy
- [ ] Other write paths: use a documented route guard or promote the last known-good deployment; no global read-only flag exists

## Supabase Connection Pool

- Treat the current Supabase Dashboard configuration as authority for pool mode and limits; do not infer production capacity from a plan default.
- The server client has a bounded 45-second request timeout in `lib/supabase/server.ts`; that is not a recovery-time guarantee.
- Pool exhaustion can affect database-backed APIs, scheduled handlers, and ingest workers. Handle it as an incident using `docs/RUNBOOK.md`; never promise automatic recovery.
