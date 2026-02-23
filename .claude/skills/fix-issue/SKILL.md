# Skill: Fix GitHub Issue — Standard Flow

## Step 1: Understand Before Touching Code
```bash
# Read the issue fully. Identify:
# - What is the expected behavior?
# - What is the actual behavior?
# - Which exchange / component / API route is affected?

# Check if there's a related failing test:
npm test -- --testPathPattern=<component>

# Check recent git history for context:
git log --oneline -20 -- <affected-file>
```

## Step 2: Reproduce Locally
- Never fix what you can't reproduce
- For data issues: query Supabase directly
  ```sql
  -- Example: check data freshness
  SELECT exchange, COUNT(*), MAX(updated_at) FROM traders GROUP BY exchange;
  ```
- For UI bugs: run `npm run dev`, navigate to the broken page, check console

## Step 3: Root Cause (mandatory — do not guess)
- Read the error message completely before writing any fix
- Check the call chain: UI → API route → service → DB query
- For scraper issues: check if it's auth failure, rate limit, schema change, or selector change
- Skill reference: `.claude/skills/data-quality/SKILL.md` for data pipeline issues

## Step 4: Write Failing Test First
```bash
# Red phase — test must fail before you write the fix
npm test -- --testPathPattern=<affected>
# If no test exists, write one in __tests__/ or colocated *.test.ts
```

## Step 5: Implement Fix
- Minimum change — do not refactor while fixing
- One issue per commit
- For data pipeline bugs: always add a dry-run mode first

## Step 6: Self-Verify Loop (Anthropic best practice)
```bash
npx tsc --noEmit           # zero type errors
npm run lint               # zero lint errors
npm test                   # all tests green
npm run build              # build succeeds
```
Iterate until all four pass without manual intervention.

## Step 7: Checkpoint Commit
```bash
git add -A
git commit -m "fix: <exchange/component> — <one-line description of root cause>"
# Example: "fix: gains upsert conflict key — use (uid, exchange, date) not (uid)"
```

## Step 8: Push and Verify Deploy
```bash
git push origin main
# Monitor Vercel deploy — see skills/deploy/SKILL.md
```

## Arena-Specific Issue Patterns

### Exchange connector stale (GMX, Hyperliquid)
1. Check worker logs: `npm run check:status`
2. Check if cron is running: look at `vercel.json` cron schedule
3. Check connector file: `worker/src/scrapers/<exchange>.ts`
4. Test connector standalone: `npx tsx worker/src/scrapers/<exchange>.ts --dry-run`

### Data field null/wrong (WR, MDD, Sharpe)
1. Check DB: `SELECT wr, mdd, sharpe FROM traders WHERE exchange='<x>' LIMIT 5`
2. Check if the raw API returns the field: add console.log in connector
3. Check field mapping in connector: raw field name → DB column name
4. If semantic error (e.g. ROI = total not annualized): fix the transform function

### UI component broken after deploy
1. Check for TypeScript errors that slipped through
2. Check for missing env var in Vercel dashboard
3. Check Sentry for client-side errors: look at recent issues

### Cloudflare 403 blocking scraper (BloFin pattern)
Options in priority order:
1. Add `puppeteer-extra` + `puppeteer-extra-plugin-stealth`
2. Rotate User-Agent headers
3. Add residential proxy (Smartproxy / Oxylabs) via `PROXY_URL` env var
4. Use exchange's official API if available (preferred)

## End-of-Session Documentation
After fixing, append to `docs/session-notes/YYYY-MM-DD.md`:
```markdown
## Fixed: <issue title>
- Root cause: <one sentence>
- Files changed: <list>
- Verification: tsc ✓ lint ✓ tests ✓ build ✓
- Remaining risk: <any known edge cases>
```
