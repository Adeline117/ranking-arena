# Deploy to Staging

Deploy current branch to Vercel preview environment for testing.

## Pre-Deploy Checklist

1. **Code Quality**
   ```bash
   npm run type-check
   npm run lint
   npm run test
   ```

2. **Build Verification**
   ```bash
   npm run build
   ```
   - Fix any build errors before deploying
   - Check bundle size if adding new dependencies

3. **Database Migrations**
   - If new migrations exist, note them for production sync
   - Test migrations locally first with Supabase CLI

## Deploy

```bash
# Deploy to preview (creates unique URL)
vercel

# Or deploy specific branch
vercel --branch feature-branch
```

## Post-Deploy Verification

1. **Check deployment status**
   ```bash
   vercel ls
   ```

2. **Test critical paths on preview URL:**
   - [ ] Homepage loads
   - [ ] Rankings page renders
   - [ ] Trader profile pages work
   - [ ] Auth flow works
   - [ ] API endpoints respond

3. **Check logs for errors**
   ```bash
   vercel logs [deployment-url]
   ```

## Rollback if Needed

```bash
# List recent deployments
vercel ls

# Promote previous deployment to current
vercel rollback [deployment-url]
```

## Notes
- Preview deployments auto-expire after 30 days
- Environment variables must be set in Vercel dashboard
- Database points to production Supabase (be careful with writes)
