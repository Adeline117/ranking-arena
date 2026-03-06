# Arena Vercel Deployment

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

## Manual Deploy
```bash
npx vercel deploy --prod --yes --token=$VERCEL_TOKEN
touch .env  # gitignored, build needs it
```

## Arena-Specific Pitfalls

1. **Pro plan 最多 3 regions** — 曾设 17 个导致部署失败好几天
2. **Turbopack 编译**: Vercel 4核8GB 上需 95s（本地 17s），偶尔 hang
3. **Stuck builds**: `curl -X PATCH "https://api.vercel.com/v13/deployments/{uid}/cancel" -H "Authorization: Bearer $TOKEN"`
4. **`ssr: false` on provider wrappers**: 会杀掉所有 SSR
5. **Top-level await in lib**: 会导致 build 无限挂起
6. **Stripe**: 当前是 sandbox (pk_test_/sk_test_)

## Common Deploy Failures

### TypeScript error on Vercel but passes locally
- Vercel uses a clean install; local `tsconfig.tsbuildinfo` may be stale
- Fix: `rm tsconfig.tsbuildinfo && npx tsc --noEmit`

### Environment variables missing
- `.env.local` is gitignored — set vars in Vercel Dashboard
- Required: `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `STRIPE_SECRET_KEY`, `SENTRY_DSN`
- After adding vars: re-deploy (vars don't apply retroactively)
- Pull from prod: `npx vercel env pull .env.local --token=$TOKEN`

### Edge function size exceeded
- Middleware runs on Edge — no heavy imports, move logic to API routes

### Cron jobs not firing
- Check `vercel.json` cron definitions
- Pro plan required for sub-hourly schedules
- Test: `curl https://ranking-arena.vercel.app/api/cron/<name>`

## Post-Deploy & Rollback
```bash
vercel ls              # deployment status
vercel logs --follow   # tail logs
vercel rollback        # instant rollback
```
