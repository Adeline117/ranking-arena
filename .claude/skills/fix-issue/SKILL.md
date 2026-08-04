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
  -- Registry-backed fetch freshness; includes active sources with no snapshots.
  SELECT * FROM public.get_platform_freshness();
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

### Ingest source stale (GMX, Hyperliquid)

1. Check `/api/admin/monitoring/arena-pipeline` and worker logs.
2. Confirm the active `arena.sources` row, execution region, and BullMQ lease.
3. Inspect `lib/ingest/adapters/<source>/` plus the latest durable RAW attempt.
4. Reproduce with a sanitized RAW fixture and run that adapter's tests.

### Data field null/wrong (WR, MDD, Sharpe)

1. Compare `arena.trader_stats`, score inputs, and the adapter's declared metrics.
2. Check whether durable RAW evidence contains the field without logging secrets.
3. Check parser mapping and semantic normalization in the source adapter.
4. If semantic error (e.g. ROI = total not annualized): fix the transform function

### UI component broken after deploy

1. Check for TypeScript errors that slipped through
2. Check for missing env var in Vercel dashboard
3. Check Sentry for client-side errors: look at recent issues

### Upstream WAF blocks an adapter

1. Confirm the source's authoritative region and configured transport.
2. Prefer an official API when its semantics satisfy the source contract.
3. Update the shared ingest transport/browser boundary; do not add a one-off
   per-platform cron or bypass durable RAW capture.

## End-of-Session Documentation

After fixing, append to `docs/session-notes/YYYY-MM-DD.md`:

```markdown
## Fixed: <issue title>

- Root cause: <one sentence>
- Files changed: <list>
- Verification: tsc ✓ lint ✓ tests ✓ build ✓
- Remaining risk: <any known edge cases>
```
