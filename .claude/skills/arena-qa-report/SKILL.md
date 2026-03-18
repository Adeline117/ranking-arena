---
name: arena-qa-report
description: QA report only — same systematic testing as /qa but never touches code. Produces structured report with health score.
---

# Arena QA Report (Read-Only)

> **Shared patterns**: Read `.claude/skills/arena-shared-preamble.md` for Boil the Lake philosophy and effort estimates.

Same systematic QA testing as `/qa` but **report-only**. Never modifies code.

## Process

Follow the exact same testing process as arena-qa (Phase 1-5), but:
- Do NOT fix any bugs
- Do NOT commit anything
- Do NOT modify any files

## Output

Produce a comprehensive report:

```markdown
# Arena QA Report (Read-Only) — [Date]

## Health Score: [0-100]

Scoring:
- Core path works:        /30
- API routes respond:     /20
- Data freshness OK:      /20
- Type check passes:      /15
- No console errors:      /15

## Issues Found: [N]

### Critical (blocks users)
1. [Page/Route]: [Description] — [File:Line]
   - Repro: [steps]
   - Impact: [who is affected, how many]

### Major (degrades experience)
1. [Page/Route]: [Description] — [File:Line]
   - Repro: [steps]

### Minor (cosmetic/polish)
1. [Page/Route]: [Description] — [File:Line]

### Data Quality
- Freshest platform: [name] ([age])
- Stalest platform: [name] ([age])
- Platforms with missing data: [list]

### Performance
- Type errors: [count]
- Lint warnings: [count]
- Bundle concerns: [if any]

## Recommendations
1. [Priority 1 fix]: [estimated effort]
2. [Priority 2 fix]: [estimated effort]
3. [Priority 3 fix]: [estimated effort]
```

**REMEMBER: This is report-only. Do NOT modify any code.**
