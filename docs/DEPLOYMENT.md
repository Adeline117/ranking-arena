# Deployment Checklist

## Pre-Deploy
- [ ] `npm run type-check` passes (0 errors)
- [ ] `npm run test` passes (0 failures)
- [ ] `npm run lint` passes (0 errors)
- [ ] No `NEXT_PUBLIC_` secrets exposed
- [ ] Migration is backwards-compatible (no column drops without deprecation)
- [ ] Feature flags set for risky changes

## Post-Deploy (within 5 minutes)
- [ ] Check /api/health/pipeline — all platforms healthy
- [ ] Check Sentry for new error spikes
- [ ] Verify homepage loads with rankings data
- [ ] Check Telegram alerts for pipeline failures

## Rollback
- [ ] Vercel: Dashboard → Deployments → Promote previous
- [ ] Database: Supabase → Database → Backups → PITR
- [ ] Feature flags: Set flag to disabled in lib/features.ts

## Supabase Connection Pool
- Pool mode: Transaction (pgbouncer)
- Max connections: ~60 (Supabase Pro default)
- Query timeout: 45s (configured in lib/supabase/server.ts)
- If pool exhausted: cron jobs fail with "too many clients" → auto-recovers in ~30s
