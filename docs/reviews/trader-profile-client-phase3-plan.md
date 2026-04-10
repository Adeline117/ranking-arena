# TraderProfileClient Phase 3 — server/client split plan

Status: **scoped, deferred to dedicated session**
Prerequisites: Phase 1 + 2 (shipped) stable in production for 24+ hours
Risk level: HIGH — touches SWR fallbackData wiring + activeAccount state machine

## Context

After 2 phases of refactoring during the 2026-04-09 perf session,
TraderProfileClient.tsx is at **867 lines** (down from 1009, -14%).
Phase 1 + 2 extracted:

- `hooks/useTraderPeriodSync.ts` — period URL ↔ store sync
- `hooks/useTraderActiveAccount.ts` — linked-account state machine
- `hooks/useTraderTabs.ts` — tab navigation + visited tracking
- `components/TraderProfileError.tsx` — error early-return UI
- `components/TraderStatusBanners.tsx` — stale + platform-dead banners

Plus memoization of `structuredData`, `traderProfile`, `traderPerformance`,
`traderStats`, `traderPortfolio`, `traderPositionHistory`, `traderSimilar`.

## What Phase 3 needs to accomplish

1. **Move JSON-LD render to the server component** (page.tsx)
   - Currently rendered in BOTH page.tsx AND TraderProfileClient
   - The TraderProfileClient version doesn't appear in SSR HTML on prod
     (verified via curl) because it's inside a Suspense boundary that
     never resolves during cron contention
   - Server component render guarantees the JSON-LD is in the initial
     HTML flush, before any Suspense

2. **Extract a `TraderProfilePageShell` server component**
   - Owns: header + breadcrumb + JSON-LD + status banners
   - Receives `data: UnregisteredTraderData` + `serverTraderData` as props
   - Renders the static chrome + a `<TraderInteractive>` slot
   - Pure server render — no hooks, no state

3. **Narrow `TraderInteractive` client boundary**
   - Owns: SWR data fetching + state machines + tab content rendering
   - Receives only the props it needs (not the whole `data` shape)
   - Becomes a much smaller client island (~400 lines target)

4. **Wrap each tab in `<Suspense>`**
   - Stats / Portfolio / Posts each become independent Suspense islands
   - Unvisited tabs don't block initial hydration
   - Each tab has its own React error boundary

## Why this is risky

The CRITICAL surface to preserve:

```ts
useSWR<TraderPageData>(traderApiUrl, traderFetcher, {
  fallbackData: isPrimaryAccount ? (serverTraderData ?? undefined) : undefined,
  revalidateOnMount: isPrimaryAccount && serverTraderData ? false : undefined,
  ...
})
```

This is the SSR → hydration handoff. `serverTraderData` comes from the
server component (page.tsx) via prop drilling, into TraderProfileClient,
into useSWR's fallbackData. After the split:

- `serverTraderData` would still be a prop, but passed from
  `TraderProfilePageShell` into `<TraderInteractive serverData={...}>`
- The interactive component reads it and feeds to useSWR
- The contract is the same, just an extra hop

But: any subtle bug here (passing wrong prop, breaking the
`isPrimaryAccount` condition, race between mount and SWR init) breaks
the entire trader page.

The other CRITICAL surface: the activeAccount state machine. It depends
on URL params (`?account=`) which the server component reads via
`searchParams`, AND the client component uses to fire SWR with the
right key. After the split:

- Server component reads searchParams and computes initial `activeAccount`
- Passes as prop to `<TraderInteractive initialActiveAccount={...}>`
- Client component uses it as initial state in useState
- Any ssr/hydration mismatch here = error boundary

## E2E test gates (must pass before refactor + after)

The 8 e2e tests in `e2e/trader-detail-*.spec.ts` cover the contract:

1. linked account UI renders when SWR receives 2+ accounts
2. activeAccount persists via URL ?account= param on direct visit
3. exactly ONE /api/traders/[handle] call with aggregate bundled
4. linked account → all clears the ?account= URL param
5. period switch updates URL param + re-renders charts
6. period persists across tab reload
7. cold visit returns trader content in SSR HTML
8. SSR HTML contains JSON-LD

Tests 1, 4 currently use `page.route()` mocks. Test 8 is currently
softened to only require `/schema.org/` (waiting for the JSON-LD bug
fix to deploy and propagate).

After Phase 3:
- Test 8 should PASS with strict `/ProfilePage|Person|BreadcrumbList/`
  assertion (because JSON-LD is rendered in the server component)
- All 8 tests should pass without skips (use `?e2e_fixture=linked_accounts`
  for deterministic mocks)

## Step-by-step migration plan

### Step 0: prerequisites
- [ ] Phase 1/2 shipped — DONE
- [ ] e2e tests deterministic — IN PROGRESS (`?e2e_fixture` added 2026-04-09)
- [ ] All 8 e2e tests passing — needs deploy verification of JSON-LD fix
- [ ] 24h soak time on Phase 1/2 in prod

### Step 1: extract TraderProfilePageShell (server component)
1. Create `app/(app)/trader/[handle]/TraderProfilePageShell.tsx`
   - Server component (no `'use client'`)
   - Props: `data, serverTraderData, claimedUser, children`
   - Renders: TopNav already in layout.tsx, no need; renders Breadcrumb
     (server), JSON-LD (server), Status banners (server-safe), then
     `{children}` slot for the interactive island
2. Move JSON-LD generation from `TraderProfileClient.tsx` (memoized
   structuredData) into `TraderProfilePageShell.tsx`. Page.tsx already
   has the same logic — consolidate.
3. Update `page.tsx` return:
   ```tsx
   <TraderProfilePageShell data={traderData} serverTraderData={serverTraderData} claimedUser={claimedUserProfile}>
     <TraderInteractive {...interactiveProps} />
   </TraderProfilePageShell>
   ```

### Step 2: rename TraderProfileClient → TraderInteractive
1. Rename file
2. Strip out the JSON-LD render (now in shell)
3. Strip out the breadcrumb render (now in shell)
4. Strip out the status banners (now in shell)
5. Keep all hooks + state machines + tab content rendering

### Step 3: wrap tabs in Suspense
1. Each `<Box className="tab-pane-enter">` block gets:
   ```tsx
   <Suspense fallback={<RankingSkeleton />}>
     {visitedTabs.has('stats') && <StatsPage ... />}
   </Suspense>
   ```
2. Wrap in error boundaries too
3. Verify period switch doesn't cause Suspense waterfall

### Step 4: re-tighten e2e JSON-LD assertion
After deploy, change in `e2e/trader-detail-ssr-fallback.spec.ts`:
```ts
- expect(allSchemas).toMatch(/schema\.org/)
+ expect(allSchemas).toMatch(/ProfilePage|Person|BreadcrumbList/)
```

### Step 5: verification
- Run all 8 e2e tests
- Curl-verify trader page HTML contains:
  - `<script type="application/ld+json">` with ProfilePage schema
  - `<main>` with actual trader content (not Suspense placeholders)
  - Breadcrumb in initial HTML (not streamed)
- Manual smoke: visit 3 traders (one with linked accounts, one without,
  one on a dead platform) — verify all render correctly

## Estimated effort

- Step 1: 1-2 hours (mostly mechanical)
- Step 2: 30 min (rename + delete blocks)
- Step 3: 1 hour (Suspense + error boundary wiring)
- Step 4: 5 min
- Step 5: 30 min smoke test

**Total**: 3-4 hours focused session, single PR.

## Rollback plan

If the refactor breaks anything:
1. Revert the 2-3 commits via `git revert`
2. Phase 1 + 2 hooks remain (they're independent)
3. The state-machine hooks can be inlined back if needed

## Decision

**DEFERRED to dedicated session.** Phase 3 is too risky to ship in the
middle of the perf-fix marathon — needs:
- Phase 1/2 soak time
- Deterministic e2e fixtures (in progress)
- A single focused session with no concurrent background process churn
- A staging deploy to verify before main

The conservative wins from Phase 1+2 (hook + component extraction,
142 lines removed, e2e suite established) are sufficient for now.
