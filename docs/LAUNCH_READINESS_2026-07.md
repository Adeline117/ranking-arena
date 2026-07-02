# Arena — Pre-Launch Readiness Report (2026-07-01)

Output of the pre-launch exhaustive audit (plan workstreams A–E: real-user truth,
analytics activation, exhaustive interaction testing, same-function unification,
SEO/share, acceptance). Companion to `docs/USER_TRUTH_2026-07.md`.

## Verdict

**Code is launch-ready; the bottleneck is go-to-market, not the product.** The
audit found one real user-facing defect (broken "Sign in with X") and one dead
instrument (presence sensor) — both fixed. Every core path is healthy on prod.
The product has ~0 real users at scale; that is an owner/GTM decision, not a code
gap (see USER_TRUTH).

## Fixed this pass (all committed + pushed + deploy-verified)

| #           | Area        | Fix                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1          | Instruments | Presence sensor was dead — `last_seen_at` NULL for all 45 users. Root cause: `usePresence` DB heartbeat mounted only in DM/channel pages **and** used a raw `fetch` with no CSRF header (would 403 even there). Fixed: global `PresenceHeartbeat` in the (app) layout via `authedFetch` (CSRF-correct); `/api/presence` now logs the UPDATE error instead of swallowing it. Verified: `POST /api/presence` → `{"ok":true}`. |
| A2          | Analytics   | `trackEvent` now dual-emits PostHog + Plausible; core funnel instrumented (post_reaction/bookmark/repost, comment_created, create_post, share). No-op-safe until keys set.                                                                                                                                                                                                                                                  |
| B (finding) | Auth        | "Sign in with **X**" 400'd (Twitter provider not configured in Supabase — verified google→302, discord→302, twitter→400). Button gated behind `NEXT_PUBLIC_ENABLE_X_LOGIN` (default off), reversible once configured.                                                                                                                                                                                                       |
| C1          | Social UI   | Unified null/deleted username rendering (`lib/utils/user-display.ts`) across 5 post surfaces — no more literal "null"/"@null"; fixed hot-card `@{author}` field bug; 24-char truncation.                                                                                                                                                                                                                                    |
| C2          | i18n        | Stopped Chinese timestamps leaking to EN/JA/KO users at 7 call sites.                                                                                                                                                                                                                                                                                                                                                       |
| C3          | Share       | Single-sourced `PLATFORM_LABELS` (`lib/constants/platform-labels.ts`) — the copies had drifted (raw "gateio" vs "Gate.io").                                                                                                                                                                                                                                                                                                 |
| D1          | SEO         | Added 15 exchange pages + 10 learn articles + 3 rankings subpages to the live sitemap (verified live).                                                                                                                                                                                                                                                                                                                      |
| D2          | Copy        | Unified contradictory stats (8,000+/45+/30+ → 34,000+ traders / 32+ exchanges).                                                                                                                                                                                                                                                                                                                                             |
| D5          | Cleanup     | Deleted dead `lib/seo/metadata.ts` (0 callers).                                                                                                                                                                                                                                                                                                                                                                             |

## Test infrastructure built (B0)

`scripts/qa/exhaustive-sweep.mjs` — clicks **every** interactive element per route
(closes the "first element only" sampling gap in the older sweeps), writes a
coverage-ledger JSONL, internal links recorded by href (no per-link rehydrate),
destructive + (in `--auth`) write actions denied, dialogs auto-cancelled,
route-level crash recovery.

- **Anon sweep**: 40 routes, 2163 interactive elements. One real bug (X login) →
  fixed. All click-failures were off-screen/menu-nested elements (skip-links,
  back-to-top), not defects.
- **Auth sweep**: 10 auth-only routes (settings/linked-accounts/watchlist/
  favorites/portfolio/following/messages/inbox/my-posts/user-center/claim), 272
  elements, **0 errors** (12 write-actions safely denied). All return 200. (First
  auth run exposed a tool-safety hole — it was clicking Follow/Like as the QA
  user; **verified 0 rows / 0 notifications created** before kill — then hardened
  with write-denial + page recovery, after which it achieved full clean coverage.)

## Remaining (owner action or follow-up — not launch blockers)

- **A3 (owner)**: register PostHog, set `NEXT_PUBLIC_POSTHOG_KEY` → funnel lights up with zero more code.
- **X login (owner)**: configure the Twitter/X provider in Supabase Auth, then flip `NEXT_PUBLIC_ENABLE_X_LOGIN=true`.
- **C5** (in progress): hardcoded/zh-en-only strings shown untranslated to ja/ko.
  Core-path batches done — **search** (dead `t()||中文` fallback + zh/en-only
  category labels → `t()`) and **login** (9 ternaries → `t()` + 8 new keys ×4
  locales). Remainder (notifications/following/favorites + ~100 other files) is
  the same pattern; do as dedicated batches (locale files = single serial writer).
- **D3**: bespoke not-found pages for 6 dynamic routes (the 4 that call `notFound()` already render the functional root 404; 2 are soft-404 SEO polish). Not crashes.
- **`app/sitemap.ts`**: dead `/sitemap.xml` (not advertised by robots) — deleting an endpoint possibly registered in Search Console is outward-facing; owner decision.
- **North-star metric**: pick one activation metric (now measurable since the presence + interaction sensors work) and gate future "should we build X?" against it.

## Core-path health (post-deploy verified)

`/`, `/rankings`, `/trader/*`, `/hot`, `/pricing`, `/login`, `/api/health` — all 200.
