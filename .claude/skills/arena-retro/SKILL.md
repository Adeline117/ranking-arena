---
name: arena-retro
description: Engineering retrospective. Analyzes commit history, work patterns, pipeline health, code quality with trend tracking.
---

# Arena Retrospective

> **Shared patterns**: Read `.claude/skills/arena-shared-preamble.md` for Boil the Lake philosophy and effort estimates.

Weekly engineering retrospective with persistent history and trend tracking. More comprehensive than `/weekly-self-check` — covers engineering velocity, patterns, and team health.

## Data Collection

### 1. Commit Activity (last 7 days)

```bash
# Commits this week
git log --since="7 days ago" --oneline --no-merges | wc -l

# Files most changed
git log --since="7 days ago" --name-only --no-merges | sort | uniq -c | sort -rn | head -20

# Biggest commits (by diff size)
git log --since="7 days ago" --stat --no-merges | head -50

# New files created
git log --since="7 days ago" --diff-filter=A --name-only --no-merges | sort -u

# Deleted files
git log --since="7 days ago" --diff-filter=D --name-only --no-merges | sort -u
```

### 2. Pipeline Health (last 7 days)

```bash
# Current read-only diagnostic entry points
npm run check:status
npm run check:freshness
npm run check:platforms

# Optional explicitly selected local runtime probe
curl -s http://localhost:3000/api/health/pipeline 2>/dev/null | head -50
```

Record the observed environment, commit, and unavailable witnesses. Do not treat a
local probe as production truth or turn a retrospective into a cron invocation,
backfill, restart, deploy, or database write.

### 3. Code Quality Snapshot

```bash
# Type errors
npm run type-check 2>&1 | tail -5

# TODO/FIXME count
grep -rn "TODO\|FIXME\|HACK\|XXX" app/ lib/ --include="*.ts" --include="*.tsx" | wc -l

# Dependencies with vulnerabilities
npm audit --json 2>/dev/null | head -20
```

### 4. Feature Velocity

```bash
# Branches merged this week
git log --since="7 days ago" --merges --oneline

# PRs merged
gh pr list --state merged --search "merged:>=$(date -v-7d '+%Y-%m-%d')" --limit 20 2>/dev/null
```

## Analysis

### What Went Well

- Identify patterns of success (fast merges, clean commits, good test coverage)
- Call out specific accomplishments

### What Could Be Better

- Identify patterns of friction (repeated reverts, long-running branches, test failures)
- Flag recurring issues (same source adapter failing, same type errors)

### Hotspots

- Files changed most often = likely areas of instability
- Source adapters with most pipeline failures = need investigation/refactoring
- API routes with most errors = need attention

### Metrics vs Last Week

Read previous retro from `docs/retros/` (if exists) and compare:

| Metric                | Last Week | This Week | Trend |
| --------------------- | --------- | --------- | ----- |
| Commits               | N         | N         | +/-   |
| Pipeline success rate | N%        | N%        | +/-   |
| Type errors           | N         | N         | +/-   |
| TODO count            | N         | N         | +/-   |
| Active platforms      | N         | N         | +/-   |
| Trader count          | N         | N         | +/-   |

## Output

Write to `docs/retros/retro-YYYY-MM-DD.md`:

```markdown
# Arena Retro — [Date]

## Summary

[2-3 sentence summary of the week]

## Metrics

[table from above]

## What Went Well

- [item 1]
- [item 2]

## What Could Be Better

- [item 1]: [suggested action]
- [item 2]: [suggested action]

## Hotspots

- [file/source adapter]: changed [N] times — [recommendation]

## Action Items

- [ ] [Action 1] — [owner/priority]
- [ ] [Action 2] — [owner/priority]

## Pipeline Health

- Success rate: [N]%
- Failing jobs: [list]
- Stale platforms: [list]
```

Also update `docs/PROGRESS.md` with a one-line retro summary when the task authorizes
documentation changes.

## Persistent History

- Previous retros stored in `docs/retros/`
- Trends tracked across weeks
- Action items from last retro reviewed for completion
