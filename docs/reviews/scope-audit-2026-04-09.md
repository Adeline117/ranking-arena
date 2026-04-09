# Scope Audit — 2026-04-09

Full inventory of `app/(app)/*` routes (49 total) with recommendation per route.
CEO review flagged "50+ routes, scope sprawl" as a blocking factor. This doc
translates that into concrete per-route decisions.

## Methodology

For each route:
- **page file size** (stub ≠ small page, but very thin pages are suspicious)
- **nav link count** in `app/components/*` (not authoritative — dynamic navs miss)
- **SEO status** from `app/robots.ts` (disallowed ≠ dead, but is a strong signal)
- **git last meaningful touch** (layout-only refactors filtered out)

Signals are correlated, not definitive. No route is deleted based on a single metric.

## Recommendation Summary

| Category | Count | Action |
|---|---|---|
| P0 Immediate Delete | 4 | SEO-disallowed + no refs + experimental |
| P1 Proposed Delete | 5 | Low value / orphan / stub — review-then-delete |
| P2 Review Scope | 6 | Big routes with unclear ROI |
| Keep As Is | 34 | Core product or essential secondary |

**Net impact if all P0+P1 executed**: 49 → 40 routes (-18%). Symbolic cut, not the 70% the CEO review proposed — but a safer start.

---

## P0 — Immediate Delete Candidates (4)

All four are: SEO-disallowed in `robots.ts`, no `href="/route"` references outside their own directory, experimental framings that never shipped broadly.

### `/frame` (146 lines)
- **Purpose**: Farcaster mini-app / frame renderer
- **Why delete**: Disallowed in `robots.ts:35`, zero external refs, Farcaster mini-app is a side experiment
- **Risk**: External users who bookmarked a frame URL would 404. Add a simple redirect to `/` and delete the page
- **Blast radius**: 1 route + 3 files

### `/kol` (271 lines)
- **Purpose**: KOL (Key Opinion Leader) browse page — curated traders
- **Why delete**: Disallowed in `robots.ts:31`, zero external refs, concept overlaps with `/rankings`
- **Risk**: Low — rankings supersede this
- **Blast radius**: 1 route + 3 files

### `/tip` (96 lines)
- **Purpose**: Tipping / crypto micro-payments experiment
- **Why delete**: Disallowed in `robots.ts:32`, zero refs, orthogonal to core trader ranking product
- **Risk**: None — was never a growth driver
- **Blast radius**: 1 route + 3 files

### `/channels` (606 lines)
- **Purpose**: Channel-style social feed (Discord/Slack-esque)
- **Why delete**: Disallowed in `robots.ts:26`, zero refs, concept already covered by `/groups`
- **Risk**: Low if no live users — check production analytics before deletion
- **Blast radius**: 1 route + 7 files

**P0 total**: 4 routes, ~16 files, ~1119 page lines

---

## P1 — Proposed Delete (5)

These need a 5-minute sanity check (production analytics) before deletion.

### `/hashtag` (27-line page)
- **Purpose**: Hashtag browse page — looks like a stub
- **Why delete**: Stub-level content (27 lines), no external refs, hashtags are already surfaced inside posts
- **Pre-delete check**: Is `hashtag/[tag]/page.tsx` dynamic route being hit organically?

### `/wrapped` (202 lines, 4 files)
- **Purpose**: Year-in-review card (Spotify Wrapped style)
- **Why delete**: Seasonal one-off, low year-round value, not linked from nav
- **Alternative**: Move to a yearly generated static marketing page

### `/bot` (345 lines, 5 files)
- **Purpose**: Bot/AI trader showcase
- **Why delete**: No external refs, concept overlaps with `isBot` field on regular trader profiles
- **Consolidation**: Filter bots via `/rankings?filter=bots` instead of separate route

### `/my-posts` (45-line page, 4 files)
- **Purpose**: Current user's posts list
- **Why delete**: 45-line stub, `/user-center` already shows the user's own posts
- **Consolidation**: Merge into `/user-center` or `/u/[self-handle]`

### `/learn` (84-line page, 7 files)
- **Purpose**: Educational content landing — a lightweight version of `/library`
- **Why delete**: 84-line stub, unclear differentiation from `/library`
- **Alternative**: Redirect `/learn` → `/library`

**P1 total**: 5 routes, ~23 files

---

## P2 — Review Scope Before Cutting (6)

These have real code but dubious core-path value. Don't delete without user signal data.

### `/library` (123-line page, 4 files)
- **Purpose**: 60K+ educational resources (per CLAUDE.md)
- **Tension**: CEO review flagged as "no relation to core value" — but has nontrivial content investment
- **Recommend**: Keep but freeze development. Don't add features. Re-evaluate in 30 days by traffic.

### `/competitions` (11 files)
- **Purpose**: Trading competitions
- **Tension**: CEO review suggested "kill unless growth engine"; some retention potential
- **Recommend**: Measure. If <5% WAU touch it in 30 days, delete.

### `/flash-news` (380-line page, 7 files)
- **Purpose**: Market news ticker
- **Refs**: Linked from `NewsFlash.tsx` sidebar component
- **Tension**: Nice-to-have, not core. But integrated into homepage sidebar.
- **Recommend**: Keep the widget, consider killing the standalone page.

### `/favorites` (715-line page, 11 files)
- **Purpose**: User's favorited traders
- **Tension**: Overlaps with `/watchlist` and `/following`
- **Recommend**: Consolidate the three into one "My Traders" route with tabs.

### `/following` (8 files)
- **Purpose**: Followed traders feed
- **Tension**: Same as favorites
- **Recommend**: Consolidate.

### `/portfolio` (355-line page, 4 files)
- **Purpose**: Portfolio tracking (user's own positions)
- **Tension**: Not linked from nav, not SEO-indexed (per robots.ts:24). Could be deprecated or promoted.
- **Recommend**: Decide — either promote to nav (link from TopNav user menu) or delete.

---

## Keep As Is (34)

Core product or essential secondary:

**Core product path**: `rankings`, `trader`, `search`, `market`, `exchange`, `pricing`, `u`, `s`, `share`, `compare`

**Auth/account**: `login`, `logout`, `auth`, `reset-password`, `settings`, `user-center`, `onboarding`, `notifications`, `inbox`, `claim`

**Social**: `groups`, `messages`, `post`, `feed`, `watchlist`

**Trust/content**: `methodology`, `help`, `api-docs`, `admin`, `(legal)`

**Infra/special**: `offline` (PWA), `referral`, `status`, `hot`

---

## Execution Plan (proposed)

### Phase 1 — P0 deletions (today, 30 min)
- Delete 4 routes: `/frame`, `/kol`, `/tip`, `/channels`
- Add redirects in `middleware.ts` → `/`
- Remove from `robots.ts` disallow list (no longer needed)
- Remove any dead imports
- Run `npm run build` + fix residual TS errors
- One atomic commit per route

### Phase 2 — P1 deletions (this week, each its own day)
- 5-minute analytics check per route before deletion
- Each becomes 1 atomic commit
- Consolidate `my-posts` → `user-center` and `learn` → `library` with redirects

### Phase 3 — P2 decisions (30 days, data-driven)
- Instrument `/library`, `/competitions`, `/favorites`, `/following`, `/portfolio` with PostHog events
- Review WAU / 7-day retention per route
- Route with <2% WAU touch → delete
- Consolidate favorites/following/watchlist into single "My Traders"

### Phase 4 — Strategic scope rethink (only after P1-P3 land)
- CEO review proposed going to ≤15 routes. After Phase 1-3 we'd be at ~40.
- Gap from 40 → 15 requires killing social (groups/messages/post/feed) or merging heavily.
- That decision requires real user data, not just scope arguments.

---

## Not Doing (reasons)

- **Aggressive 50→15 delete in one pass**: Catastrophic risk, destroys real user value, no data to validate. CEO review's "kill 70%" is directionally right but execution requires phases.
- **Delete `/groups`, `/messages`, `/post`, `/feed`**: Social features have real users (per CLAUDE.md: "Social" is secondary path, not dead). Killing social is a strategy decision, not a refactor.
- **Delete `/methodology`, `/api-docs`**: Trust signals. For a ranking product, transparency pages are a core trust artifact.

---

## Data Sources

- Route list: `ls app/(app)/` (49 directories)
- Last commit per route: `git log -1 -- app/(app)/$route/`
- Nav refs: `grep -rln "href=\"/$route" app/components/`
- SEO status: `app/robots.ts`
- Traffic data: **NOT AVAILABLE in this audit** — recommend plugging PostHog per-route events before Phase 2/3
