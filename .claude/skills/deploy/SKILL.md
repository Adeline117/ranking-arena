# Skill: Vercel Deploy Flow

## Standard Deploy Path
```bash
# 1. Gate check (mandatory)
npx tsc --noEmit && npm run lint
# 2. Commit
git add -A && git commit -m "feat: <description>"
# 3. Push → triggers Vercel auto-deploy via GitHub integration
git push origin main
```
Monitor at: https://vercel.com/adeline-wens-projects/ranking-arena

## Manual Deploy (when GitHub integration is slow)
```bash
# Requires VERCEL_TOKEN in environment
vercel --prod
```

## Common Deploy Failures

### TypeScript error on Vercel but passes locally
- Vercel uses a clean install; local `tsconfig.tsbuildinfo` may be stale
- Fix: `rm tsconfig.tsbuildinfo && npx tsc --noEmit` locally
- `ignoreBuildErrors: true` in `next.config.ts` is a safety net — do NOT hide errors behind it

### Environment variables missing on Vercel
- `.env.local` is gitignored and never deployed
- All env vars must be set in Vercel Dashboard > Settings > Environment Variables
- Required vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `UPSTASH_REDIS_REST_URL`,
  `UPSTASH_REDIS_REST_TOKEN`, `STRIPE_SECRET_KEY`, `SENTRY_DSN`
- After adding vars in dashboard: re-deploy (vars don't apply retroactively)

### Local dev breaks after git pull
```bash
touch .env.local   # triggers Next.js hot reload; fixes missing env crash
```

### Edge function size exceeded
- Middleware at `middleware.ts` runs on Edge — no heavy imports
- Move business logic to API routes (Node runtime)

### Cron jobs not firing on Vercel
- Check `vercel.json` cron definitions
- Vercel cron requires Pro plan for sub-hourly schedules
- Test manually: `curl https://ranking-arena.vercel.app/api/cron/<name>`

## Post-Deploy Verification
```bash
# Check recent deployment status
vercel ls

# Tail logs for errors
vercel logs --follow

# Check specific function
vercel logs --filter=api/cron/update-traders
```

## Rollback
```bash
# Instant rollback to previous deployment
vercel rollback
```

## Slot Machine Pattern for Risky Deploys
1. Note current commit SHA: `git rev-parse HEAD`
2. Create experiment branch: `git checkout -b experiment/feature-name`
3. Let Claude implement for up to 30 min
4. Test: `npm run build && npx tsc --noEmit`
5. Accept: `git checkout main && git merge experiment/feature-name`
6. Reject: `git checkout main && git branch -D experiment/feature-name`
