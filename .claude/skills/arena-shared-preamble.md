# Arena Shared Preamble

All Arena virtual team skills (`arena-plan-ceo`, `arena-plan-eng`, `arena-ship`, `arena-qa`, etc.) share these patterns.

## Boil the Lake Philosophy

AI makes the marginal cost of completeness near-zero. When presenting options:
- Always recommend the COMPLETE implementation over shortcuts
- Show what "done right" looks like, not just "done"
- Never skip steps to save time — time is what AI saves for you
- If a fix is in scope, do it now, not "later"

## Unified AskUserQuestion Format

When asking the user a question, follow this format:

1. **Re-ground context**: Remind what we're doing and why this question matters
2. **Simplify**: Explain the tradeoff as if to a smart 16-year-old
3. **Recommend**: Give your recommendation with a completeness score (0-100%)
4. **Options**: Lettered options with dual effort estimates

Example:
```
We're reviewing the search feature architecture.

The key tradeoff is: Meilisearch handles 99% of queries in <5ms,
but edge cases (CJK fuzzy match, trader ID lookup) need Supabase fallback.

I recommend Option B (completeness: 85%).

A) Meilisearch only — simplest, covers 95% of users
   Human: 2h | CC: 5 min (24x compression)

B) Meilisearch + Supabase fallback — robust, handles edge cases
   Human: 4h | CC: 15 min (16x compression)

C) Meilisearch + Supabase + Redis cache — complete, production-grade
   Human: 8h | CC: 30 min (16x compression)
```

## Effort Compression Ratios

When estimating effort, show both human-team time and CC+Arena time:

| Task Type | Compression Ratio |
|-----------|-------------------|
| Boilerplate (CRUD, types, schemas) | 100x |
| Tests (unit, integration, E2E) | 50x |
| Features (new functionality) | 30x |
| Bug fixes (diagnose + fix) | 20x |
| Architecture (design + implement) | 10x |
| Research (explore + decide) | 5x |

## Review Readiness Dashboard

Track which reviews have been completed before `/ship`:

```
Review Readiness:
  [x] CEO Review    — completed (HOLD SCOPE)
  [x] Eng Review    — completed (APPROVED)
  [ ] Design Audit  — not started
  [x] QA Report     — completed (score: 82/100)
  [ ] Security      — not started

  Ship readiness: BLOCKED (Eng Review required, currently: completed)
  Recommendation: Ready to ship. Design audit optional.
```

The Eng Review is the ONLY hard gate for `/ship`. CEO Review and Design Audit are recommended but optional.
