---
name: arena-qa
description: Evidence-first QA for Arena. Tests the current authority paths, applies scoped fixes, and reports verified results without touching production state.
---

# Arena QA — Verify, Fix, Re-verify

> **Shared patterns**: Read `.claude/skills/arena-shared-preamble.md` for effort estimates and repository conventions.

Use the requested scope. If no tier is specified, begin with Quick and expand only
when the evidence or task requires it.

- **Quick**: homepage ranking, trader detail, search, focused tests
- **Standard**: Quick + auth, published API contracts, freshness probes, typecheck/lint
- **Exhaustive**: Standard + exchange/token/weekly pages, edge cases, performance, i18n

Diagnosis and local code changes do not authorize a deploy, production cron call,
backfill, migration apply, cache purge, process restart, secret read, or database
write.

## 1. Establish the environment

Record the commit, worktree status, Node version, target URL, and observation time.
Use an already running local server only when browser/runtime QA is in scope. Do not
silently start a background server, switch the target to production, or assume a
missing dependency is healthy.

## 2. Inspect the current product paths

### Homepage ranking

- Read `app/page.tsx` and `app/components/home/`.
- The main ranking table is on `/`; `/rankings` permanently redirects to `/`.
- Check publication/eligibility gates, sorting, pagination, filters, empty states,
  and negative/zero/null metric behavior.

### Ranking subpages

- Read `app/(app)/rankings/`.
- Test only implemented routes such as `/rankings/exchanges`, `/rankings/tokens`,
  and `/rankings/weekly`; do not invent a standalone `/rankings` page.

### Trader detail and search

- Read `app/(app)/trader/[handle]/` and `app/(app)/search/`.
- Verify a real fixture/test handle discovered from the repository; never substitute
  a literal placeholder and call a 404 a product result.
- Historical daily-derived series may be intentionally quarantined. Validate the
  documented unavailable/no-store contract instead of expecting legacy data.

## 3. Exercise published API contracts

Against an explicitly selected local target, quote URLs containing `&`:

```bash
curl -i 'http://localhost:3000/api/health'
curl -i 'http://localhost:3000/api/rankings?window=30d&limit=10'
curl -i 'http://localhost:3000/api/search?q=test'
```

Discover a trader handle before calling `GET /api/traders/<handle>`. The rankings
parameter is required and named `window` (`7d`, `30d`, `90d`, or `composite`), not
`period`. Check status, exact response shape, publication evidence, cache headers,
and sanitized failures; a 200 response alone is not a pass.

## 4. Capture data-authority evidence

Use the canonical read-only diagnostic entry points:

```bash
npm run check:status
npm run check:freshness
npm run check:platforms
```

Record unavailable witnesses and the environment being observed. The old health,
local-recompute, source-fetch, checkpoint, and legacy-backfill paths covered by the
V1 tombstone contract report `RETIRED` and exit 2; do not invoke them as QA evidence.
Do not backfill, invoke a cron, or repair production as part of QA.

## 5. Run repository checks

Start with focused tests for changed code, then expand in proportion to risk:

```bash
npm run type-check
npm run lint
```

Also run the ingest-worker typecheck and relevant publication/migration QA when the
change touches those surfaces. Report skipped checks and missing prerequisites.

## 6. Scoped fix loop

For each defect:

1. Capture the failing behavior and authority source.
2. Identify the root cause in current code or versioned schema.
3. Make the smallest in-scope change and add a behavior/regression test.
4. Re-run the focused failure, then the broader checks required by risk.
5. Commit only when the task authorizes repository changes, using the repository's
   shared-index-safe commit helper and explicit paths.

Do not change ranking formulas, publication authority, API compatibility, database
schema, or external state merely to make a check green. Missing evidence stays
missing; do not replace it with defaults, mocks, or stale legacy rows.

## 7. Report

State verified passes, observed failures, skipped checks, environment/commit, and
remaining gates. If a health score is requested, show the evidence behind every
component and never score unavailable data as healthy.
