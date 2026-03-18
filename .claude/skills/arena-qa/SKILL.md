---
name: arena-qa
description: QA lead with auto-fix. Systematically tests Arena, finds bugs, fixes them, commits atomically, re-verifies. Produces health score.
---

# Arena QA — Test & Fix

> **Shared patterns**: Read `.claude/skills/arena-shared-preamble.md` for Boil the Lake philosophy and effort estimates.

Systematically QA test Arena and automatically fix bugs found. Each fix is committed atomically with verification.

## Tier Selection

Ask the user which tier (use AskUserQuestion):
- **Quick** (5 min): Core path only — homepage, rankings, trader detail, search
- **Standard** (15 min): Quick + auth, pro features, API routes, data freshness
- **Exhaustive** (30 min): Standard + all exchange pages, edge cases, performance, i18n

## QA Process

### Phase 1: Environment Check
```bash
# Verify dev server is running
curl -s http://localhost:3000 | head -5

# If not running:
npm run dev &
sleep 10
```

### Phase 2: Core Path Testing

#### 2a. Homepage
- Read `app/page.tsx` and related components
- Check: data loads, no console errors, layout correct
- Verify: top traders display, Arena Scores visible, exchange logos render

#### 2b. Rankings Page
- Read `app/rankings/` pages
- Check: table renders, sorting works, period switching (7D/30D/90D)
- Verify: pagination, exchange filter, market type filter
- Edge cases: empty exchange, 0 ROI trader, negative PnL

#### 2c. Trader Detail
- Read `app/trader/[id]/` pages
- Check: profile loads, stats display, chart renders
- Verify: period switching, score breakdown, trading history
- Edge cases: trader with no snapshots, deleted trader, bot trader

#### 2d. Search
- Read search components and API
- Check: search returns results, ranking correct, no stale results
- Verify: Meilisearch integration, fallback behavior

### Phase 3: API Route Testing
```bash
# Test critical API routes
curl -s http://localhost:3000/api/health
curl -s http://localhost:3000/api/rankings?period=30d&limit=10
curl -s http://localhost:3000/api/trader/[sample-id]
curl -s http://localhost:3000/api/search?q=test
```

Check for:
- 200 status codes
- Correct response shape
- No leaked error details
- Proper cache headers

### Phase 4: Data Quality
```bash
# Run data freshness check
node scripts/pipeline-health-check.mjs --quick
```

Verify:
- All active platforms have data < 48h old (CEX) / < 72h (DEX)
- No null Arena Scores on ranked traders
- ROI/PnL values reasonable (no Infinity, no -100% without explanation)

### Phase 5: Type & Lint Check
```bash
npm run type-check
npm run lint
```

### Phase 6: Bug Fix Loop

For each bug found:

1. **Document**: What's broken, where, reproduction steps
2. **Root cause**: Read the relevant code, understand why
3. **Fix**: Make the minimal fix
4. **Verify**: Confirm the fix works
5. **Commit**: Atomic commit with descriptive message
```bash
git add [specific files]
git commit -m "fix: [what was broken] — [what was fixed]

Found by Arena QA (tier: [quick/standard/exhaustive])

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
6. **Continue**: Move to next bug

### Phase 7: Health Score

Calculate and output:

```markdown
# Arena QA Report — [Date]

## Health Score: [0-100]

Scoring:
- Core path works:        /30
- API routes respond:     /20
- Data freshness OK:      /20
- Type check passes:      /15
- No console errors:      /15

## Bugs Found: [N]
## Bugs Fixed: [N]
## Bugs Remaining: [N] (need user input)

### Fixed Bugs
1. [commit hash] — [description]

### Remaining Issues (need user input)
1. [description] — [why it needs human decision]

### Before → After
- Health Score: [before] → [after]
```

## Important Rules

- NEVER fix business logic without asking (Arena Score formula, ranking algorithm)
- NEVER modify database schema
- NEVER change API response shapes (breaking change)
- OK to fix: null handling, missing error boundaries, broken imports, wrong types, CSS issues
- Each fix MUST be a separate commit
- If unsure about a fix, add to "Remaining Issues" instead
