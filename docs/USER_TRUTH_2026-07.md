# Arena — Real-User Truth Report (2026-07-01)

Ground-truth from the production Supabase DB (not client analytics — PostHog &
Plausible are both key-less = OFF; the only live client signal is Vercel Web
Analytics pageviews). This report answers one question: **do we have real users,
and where do they drop off?**

## Headline: essentially zero live human usage

| Signal                                            | Value                   | Read                                        |
| ------------------------------------------------- | ----------------------- | ------------------------------------------- |
| Total users                                       | **45**                  | tiny                                        |
| Signups last 7d / 30d                             | **0 / 4**               | growth stalled (~18 days since last signup) |
| Users active last 24h / 7d / 30d (`last_seen_at`) | **0 / 0 / 0**           | see BUG below                               |
| WAU / DAU (distinct `user_interactions.user_id`)  | **0 / 0**               | no tracked engagement                       |
| `user_interactions` rows, all-time                | **4** (last 2026-06-14) | tracking barely fires                       |
| Paying subscriptions (active/trialing)            | **2** (pro)             | —                                           |
| Posts total / last 30d                            | **1030 / 2**            | content is historical/seed                  |
| Comments total / last 30d                         | **355 / 0**             | dormant                                     |
| Distinct post authors all-time / last 90d         | **32 / 2**              | ~32 seed accounts, now silent               |
| Web3 (wallet) users                               | **0**                   | all 42 are email accounts                   |
| Sum of `posts.view_count`                         | **221,358**             | see "views are not humans" below            |

## Two findings that matter more than the counts

### 🐛 BUG — the "active users" sensor is dead

`user_profiles.last_seen_at` is **NULL for all 45 users**, including accounts
created 5+ months ago. The presence heartbeat (`lib/hooks/usePresence.ts` →
`POST /api/presence` → `last_seen_at`) has **never persisted a value**. So:

- The app cannot measure active users at all — `seen_30d = 0` is a broken sensor, not (only) an empty room.
- Admin dashboards that lean on activity are blind. `admin/pro-metrics` WAU reads `user_interactions` (4 rows all-time) — also effectively blind.
- **This must be fixed before launch**, or you'll be flying with no instruments the moment real users arrive. (Tracked as a fix in this workstream.)

### 📊 The 221k "views" are not engaged humans

`posts.view_count` sums to 221,358 across 1030 posts (~215/post), yet
`user_interactions` has **4 rows ever** and there are **0 comments/likes in 30
days**. Real engaged humans generating 221k views would leave a proportional
trail of likes/comments/follows. This ratio (221k views : 4 interactions) says
the view counter reflects **seeded/bot/crawler traffic or historical seeding**,
not an active audience. Treat `view_count` as vanity, not truth.

## What this means (the actual problem)

The product is **built for imaginary users**. Engineering surface (rankings for
34k traders, referral anti-farm, portfolio sync for 11 exchanges, trader alerts,
groups/posts/comments) vastly exceeds demonstrated demand: 45 accounts, ~2
genuinely-recent authors, 2 payers, 0 measured 30-day actives, growth flat.

The bottleneck is **not another feature or the 61st commit** — it's that the
product has not yet met real users at any scale. That is an owner/go-to-market
decision (open the closed-beta, invite users, pick a channel), not something
more code can fix. The most useful engineering posture now is: **make the
instruments work, harden every existing path against the first real users, and
stop expanding surface** — which is exactly what this pre-launch audit does.

## Recommended north-star + gates (owner)

- Pick ONE activation metric (e.g. _distinct users active on ≥2 distinct days within 7d of signup_), fixable only once `last_seen_at` + `trackInteraction` actually record.
- Every future "should we build X?" is judged against that metric.
- Set an open-beta date; today's `closed beta` banner + Pro-free promo means even willing visitors see "not ready" + no conversion signal.

## Queries used (reproducible)

1. Users + activity windows (`user_profiles.created_at/last_seen_at`, `user_interactions`).
2. `last_seen_at` populated count + max; subscriptions active; posts/comments totals + last-30d; sum view_count.
3. Web3 vs email split; distinct post authors all-time vs last 90d.

_All run 2026-07-01 against project `iknktzifjdyujdccyhsv` via read-only SQL._
