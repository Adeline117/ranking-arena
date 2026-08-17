# Durable post and comment interaction count repair

Date: 2026-08-17

Priority: P1 data truth / release gate
Migrations:

- `20260803104000_durable_post_interaction_count_repair.sql`
- `20260803104500_close_hot_score_batch_public_execute.sql`
- `20260803105000_bind_bookmark_count_consistency.sql`
- `20260803106000_durable_comment_reaction_count_repair.sql`
- `20260803107000_set_comment_reaction_desired_state.sql`
- `20260803108000_comment_reaction_causal_intents.sql`
- `20260803110000_post_media_upload_registry.sql` (adjacent inert predeploy authority)
- `20260803111000_post_media_claims.sql` (adjacent inert predeploy authority)
- `20260803112000_post_media_coverage_inventory.sql` (adjacent snapshot-only predeploy authority)
- `20260803109000_close_legacy_comment_reaction_desired_state.sql` (postdeploy)

## Outcome

Reaction, built-in vote, and bookmark source rows remain canonical. The six cached values
on `posts` are projections only:

| Cached value     | Canonical source predicate          |
| ---------------- | ----------------------------------- |
| `like_count`     | `post_likes.reaction_type = 'up'`   |
| `dislike_count`  | `post_likes.reaction_type = 'down'` |
| `poll_bull`      | `post_votes.choice = 'bull'`        |
| `poll_bear`      | `post_votes.choice = 'bear'`        |
| `poll_wait`      | `post_votes.choice = 'wait'`        |
| `bookmark_count` | `count(post_bookmarks)`             |

Before migration 1040, a hard account delete could cascade a reaction or vote
row after a live RPC had already recounted the post. The child row was correctly
gone, but the cached value could remain high until another user interaction.
Taking the post advisory lock from a cascade trigger would invert the live
`post -> auth.users` order and could deadlock account deletion.

Migration 1040 closes that gap with a private durable queue:

- `post_likes` and `post_votes` AFTER-row triggers only UPSERT the affected post
  identity. They do not lock `posts`, `auth.users`, or the advisory domain.
- `post_interaction_count_repair_queue` deliberately has no foreign key, so a
  post delete cannot erase or block its pending cleanup identity. Its
  `next_attempt_at` and bounded `attempt_count` defer contended identities by
  5–300 seconds so one hot post cannot starve newer due work.
- `repair_post_interaction_counts_atomic(p_limit integer default 1)` accepts
  exactly `1`. Migration 1040 restores the five reaction/vote counters;
  migration 1050 extends the same absolute repair to `bookmark_count`. The
  worker discards an obligation only after the post is committed-absent, with
  one post lock-set per database transaction.
- the migration seeds the queue for every pre-existing post that has a nonzero
  cache or any reaction/vote source row. This makes historical drift a durable
  deployment obligation instead of assuming the existing cache was correct.
- the old arithmetic-only `increment_like_count` and `decrement_like_count`
  RPCs lose every non-owner caller, and browser/service bulk `TRUNCATE` of the
  child tables is closed because row triggers cannot observe it.

Migration 1045 separately closes four zero-argument hot-score batch RPCs. They
remain required by the cron path, but only `service_role` may execute them;
`PUBLIC`, `anon`, `authenticated`, and `authenticator` must receive SQLSTATE
`42501` rather than being able to rewrite recent post rankings through `/rpc`.

Migration 1050 extends the same durable obligation to `bookmark_count` and
binds all three first-party bookmark writers to the shared post counter lock:

- `toggle_post_bookmark_atomic(uuid,uuid,uuid)` remains `service_role` only;
- `save_post_bookmark_to_folder_atomic(uuid,uuid)` and
  `remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)` remain
  `authenticated` only;
- all three lock `P` before the post/bookmark pair and their existing
  account/profile/audience/folder chain, recount absolute bookmark source
  truth, and update `posts.bookmark_count` before returning;
- `post_bookmarks` gains the third exact enqueue trigger; non-owner `TRUNCATE`
  and the legacy arithmetic bookmark counter RPCs are closed.

Migration 1060 creates a separate no-FK
`comment_reaction_count_repair_queue`. Its worker takes a shared migration gate
before its first relation access, then owns `posts -> comments -> queue`,
deletes the obligation, and derives `comments.like_count/dislike_count`
absolutely from `comment_likes`. The legacy toggle keeps its signature and
synchronous acknowledgement, but its sync trigger also recounts absolute
source truth. Direct top-level source/counter mutation is guarded; every
non-`SELECT` table or column ACL on `comment_likes` is dynamically removed from
all non-owner grantees, including `PUBLIC`, unknown roles, `MAINTAIN`, and
grant-option descendants.

Migration 1070 adds
`set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)`. It keeps the
legacy toggle unchanged for rolling compatibility, but gives the application a
service-only idempotent `like` / `dislike` / `null` authority. Authentication
and argument validation precede the same fail-fast shared migration gate; the
function then locks actor, block edges, post, group, comment, canonical source,
and queue in order. Successful replies have exactly seven keys
(`status/action/reaction/liked/disliked/like_count/dislike_count`), while a
pre-mutation invalid/not-found reply contains only `status`. Every call recounts
absolute source truth and coalesces a queue obligation, including unchanged
retries. Commit `3dcf3b38d` contains the reviewed migration and its dedicated
Jest 8/8 plus PostgreSQL 17 proof; `e1ba49111` places it exactly once after 1060
in the predeploy runner.

Migration 1080 adds a private actor/comment head and immutable operation ledger,
plus three service-only functions: reserve an intent, apply its exact
server-issued sequence, and clean expired retained tickets in bounded batches.
Each new reservation makes older issued/applied work stale, and apply accepts
only the exact actor/post/comment/request/sequence/desired tuple before composing
the sealed 1070 owner function. The client reserves before apply, retries the
same ticket, reconciles stale/expired/unknown outcomes canonically, and uses the
browser Web Locks API to serialize reservation requests for the same actor and
comment across same-origin tabs when available. This contract guarantees
**database reservation order**, not an unobservable global physical-click order;
different devices, clock skew, and clicks not yet reserved cannot be truthfully
ordered as physical events.

Migration 1090 is a postdeploy contract. It retains the four-argument 1070
object because causal apply composes it as `postgres`, but revokes every
non-owner `EXECUTE` path so delayed legacy callers cannot bypass the causal
ledger. It may run only after an atomic traffic cutover has stopped all legacy
admission and the deployment controller has proved `old_instances_remaining=0`.
Ordinary mixed rolling across this boundary is forbidden.

Code evidence is committed in `089e8d445` (1050), `3153d356f` / `af00c8308`
(1060), `37d8f9cd7` (repair runner), `d1ba58930` (realtime cache invalidation),
`1955cf02c` (bounded comment repair cron), `3dcf3b38d` / `e1ba49111` (1070 and
runner), `8f05b95ec` / `c50ab2911` / `209661569` / `d6bad1ef2` / `92d0c926e`
(causal application and database ledger), `6bac3ace0` (1080 runner),
`d874d8ad9` / `fd9172450` (1090 and fixed reviewed source digests), and
`d44e72822` (postdeploy runner). Adjacent launch evidence is `05adf3ef3` (the
inert 1100 post-media registry) and `b8dc3e1cb` (1100 appended after 1080 in
predeploy), followed by `de6c117e1` (the inert 1110 post-media claim substrate)
and `741770650` (1110 appended immediately after 1100). Commit `3c5d6e660` adds
the inert 1120 historical coverage inventory, and `46ed38a07` appends it exactly
once immediately after 1110. This does not prove production has applied the
migrations, executed the inventory, completed either atomic cutover, deployed
either scheduled consumer, drained either queue, or passed the read-only
attestations. Production remains **NO-GO**.

The reviewed 1110 migration itself is **GO with P0=0/P1=0** on its additive,
currently unreachable scope: it creates private FORCE-RLS claim evidence and four
service-only wrappers, but repository search finds zero app/API callers and it
does not release, lease, admit cleanup, create cron work, delete, garbage collect,
or mutate Storage. The former TypeScript final-state/renderer grammar P1 is
closed by `31b2e357a`, `001bdbdf2`, `35b514440`, and `f5c55e862`; the combined
helper slice independently reviewed at **P0=0/P1=0**. App/API media-claim cutover
remains **NO-GO** on one historical coverage/cutover P1: execute 1120 in
production, drain legacy media source writers, seal a new generation, complete
exact backfill/quarantine disposition, and only then move post/group callers to
1110 with exact acknowledgement validation. The four older composed content
authorities retain a P2 trusted-management-plane comment + `md5(current prosrc)`
self-seal; the two 1100 functions and five new 1110 functions are pinned to
reviewed source. None of this changes the separate 1090 zero-old-instance gate.

The reviewed 1120 migration is also **GO with P0=0/P1=0** on its additive,
observe-only scope. It publishes exactly five private FORCE-RLS evidence tables
and seven fixed-source functions for bounded enqueue/observation, persistent
snapshot sealing, and scope-local gate reads. It never writes a post, group,
application, upload-registry, claim, or Storage row. Every gate fixes
`cutover_ready=false` and `authoritative_for_gc=false`, requires a new generation
after source drain, and has zero app/API/cron callers. Production execution, a
source-drained new generation, and historical backfill/quarantine disposition all
remain pending. The accepted P2 boundaries are conservative custom-CNAME handling
and a 30-second fail-closed timeout for scope aggregation; neither may be relaxed
into false readiness.

## Serialization contract

`P` means the canonical advisory key
`post-reaction-counts:<post_id>` and `Q` means the queue row.

```text
live reaction/vote RPC: P -> actor/audience -> child row -> posts recount -> Q trigger
repair worker:          P -> posts row -> Q -> source recount -> posts update
account hard delete:    auth/users cascade -> child row delete -> Q trigger
post hard delete:       posts -> child row delete -> Q trigger
live bookmark RPC:      P -> bookmark pair -> auth/profile/audience/folder -> child -> recount
comment repair worker:  migration shared gate -> posts -> comments -> Q -> absolute recount
comment desired-state:  auth -> validation -> shared gate -> actor/block -> post/group/comment -> source -> Q -> recount
causal reserve/apply:    auth -> validation -> shared gate -> actor -> request/head advisory -> block/post/group/comment -> source/head/operation -> sealed desired-state
1090 postdeploy close:   exclusive shared gate -> complete relation lock graph -> exact dependency attestation -> revoke every non-owner legacy EXECUTE
```

The enqueue trigger never takes `P`, a post row, or an auth row. The worker never
claims `Q` before `P` and the post row. It uses `SKIP LOCKED`, leaving a contended
obligation for a later pass rather than waiting while holding the reverse edge.
All four live authorities must retain the same `P` key:

- `toggle_post_reaction(uuid,uuid,text)`
- `set_post_reaction_desired_state_atomic(uuid,uuid,text)`
- `toggle_post_vote_atomic(uuid,uuid,text)`
- `set_post_vote_desired_state_atomic(uuid,uuid,text)`

The three bookmark authorities listed above must also retain `P`, their exact
role ACL, and their function-source digest. The comment worker must use the
same fail-fast shared gate as migration 1060's exclusive gate before reading
its queue; it must never claim the queue before the post and comment rows.
The 1070 desired-state authority uses the same shared gate before every relation
access and reaches `Q` only after canonical comment/source ownership. The 1080
reserve/apply pair serializes its request and actor/comment head before canonical
rows, then assigns monotonic sequence numbers at reservation time. This is
reservation order only. Migration 1090 takes the exclusive form of the same gate
and the complete relation graph before closing legacy execution.

The production attestation validates this source order, not just the existence
of similarly named functions.

## Runtime worker

`lib/cron/inline-jobs.ts` exports
`repairPostInteractionCountsInline(signal?)`. The authenticated, dedicated
`/api/cron/repair-post-interaction-counts` route runs only this repair job. It is
separate from the historical `batch-5min` hot-score dispatcher, so a contended
repair cannot consume the hot-score route's execution budget.

One RPC call uses `p_limit: 1`; every awaited call therefore commits and releases
its `P -> posts -> Q` lock set before the next item. One invocation is bounded by
100 calls and a 75-second internal budget. The route adds an 80-second
AbortSignal, the shared cron wrapper fails safe at 85 seconds, and the platform
`maxDuration` is 90 seconds. It stops early when no due work remains or when the
first candidate is contended. Every acknowledgement is exact-key and internally
reconciled before it is trusted.

The job reports these fields through the existing pipeline log:

- RPC calls, selected/processed/repaired/discarded/contended totals;
- `hasMore`, `remainingCount`, `oldestEnqueuedAt`, and computed oldest age;
- `no-due-work`, `contention`, `call-limit`, or `time-budget` stop reason.

`hasMore` means another item is due now; `remainingCount` includes both due and
backed-off items. Therefore `hasMore: false` with a positive remaining count is
a valid bounded response, not permission to forget the deferred obligations.

The route becomes `error` and returns non-2xx when `remainingCount > 1000` or the
oldest item is more than 15 minutes old, so it cannot silently acknowledge an
unhealthy backlog. `vercel.json` schedules the dedicated route with
`*/5 * * * *`; the meta monitor expects evidence within about ten minutes. The
deployed schedule and monitor registration are part of the release proof.

`repairCommentReactionCountsInline(signal?)` and the authenticated dedicated
`/api/cron/repair-comment-reaction-counts` route now apply the same one-item,
100-call, 75/80/85/90-second bounds and exact nine-key acknowledgement contract
to the comment queue. `vercel.json` schedules it every five minutes, and the
meta monitor requires evidence within ten minutes. Its worker/route contract is
covered by 2 suites / 19 tests. This closes the repository-side scheduled
consumer gap, but not the release gate: the same SHA must still be deployed,
drain `comment_reaction_count_repair_queue`, stay below the runtime limits for
scheduled invocations, and pass the read-only comment attestation.

The same five-minute heartbeat also calls
`cleanup_comment_reaction_intents_atomic(500)` once per successful repair pass.
It accepts only the exact three-key cleanup receipt and fails closed on malformed
telemetry. Cleanup removes only operations past `retain_until` and inactive heads
past the reviewed retention boundary; it is not allowed to reorder or acknowledge
live reaction work.

## Ordered rollout

The release runner must contain these migrations exactly once and in this
order:

1. `20260803101000_close_post_interaction_child_direct_writes.sql`
2. `20260803102000_set_post_reaction_desired_state.sql`
3. `20260803103000_set_post_vote_desired_state.sql`
4. `20260803104000_durable_post_interaction_count_repair.sql`
5. `20260803104500_close_hot_score_batch_public_execute.sql`
6. `20260803105000_bind_bookmark_count_consistency.sql`
7. `20260803106000_durable_comment_reaction_count_repair.sql`
8. `20260803107000_set_comment_reaction_desired_state.sql`
9. `20260803108000_comment_reaction_causal_intents.sql`
10. `20260803110000_post_media_upload_registry.sql` (inert; no claim or cleanup authority)
11. `20260803111000_post_media_claims.sql` (inert; no current caller or cleanup authority)
12. `20260803112000_post_media_coverage_inventory.sql` (snapshot-only; no cutover or GC authority)

The postdeploy manifest must then contain
`20260803109000_close_legacy_comment_reaction_desired_state.sql` exactly once.
Commits `37d8f9cd7`, `e1ba49111`, `6bac3ace0`, `d44e72822`, `b8dc3e1cb`,
`741770650`, and `46ed38a07` establish the committed order through 1120. The
committed runner proof covers 201 predeploy migrations, 17 postdeploy migrations,
and 228 unique classified migrations; its Node contract is 19/19, and the shell
syntax/format/diff checks pass. This is repository evidence only, not a production
ledger result. Production execution still uses the governed migration channel and
exact name/body/hash ledger; the local runner's mutating psql commands remain
disabled by ADR-023.

The fixed SHA256 ledger inputs are:

| Artifact     | SHA256                                                             |
| ------------ | ------------------------------------------------------------------ |
| 1060         | `0052b7a298e9880c692de6d8835ce7a48a6486b72efdd14005e308930a794d19` |
| 1070         | `86d96b5793f7fde92a51743c9c3cce95e4f230f3d83911a6499d69accdf3bcbb` |
| 1080         | `f7d808d5205c8b220d35dcd2511660bd2665e629e6bb0b7e52fcf59b551ca9a4` |
| 1090         | `0a5326888b3d355998a1f8bbbef4e15400e6680e2f397b956518af3f2f925602` |
| 1100         | `61871a54eab1f4ffb6931d617ca5c517b60483d0fd98f425fd2f06cdc71f7bc1` |
| 1110         | `4b87cae7dea0a2fb45693145482f1a8ff3bde05ecc75e0dc8c65db6171411dac` |
| 1120         | `c2c437129fee69eb0f9b82c6956fd72463881e61cae98a4a20afc290022a761a` |
| 1120 Jest    | `63d824b632d30db098bfac4379a5dd61440dbb07d31601baca649a7b9868767e` |
| 1120 PG17    | `0f3f5f6e3fb45a510d7ef949cf4a2a04b72d8ab21557dcbc1b3ed2d401e6efec` |
| runner shell | `984bdf613aac8d637071a1368a6e7a61f76f45c675484075f7d57ed8c11a62f5` |
| runner test  | `a0f235adfa8ca89ae567b8b9832dcd5c96d31278526a5a63fbd3bfd4627254be` |

Roll out in this order:

1. deploy predeploy migrations 1040, 1045, 1050, 1060, 1070, 1080, inert registry
   1100, inert claim substrate 1110, and runner-scheduled snapshot-only coverage
   inventory 1120 through the approved production channel;
2. verify their exact ledger body/hash and the PostgREST schema reload;
3. bring up the same release SHA containing the causal client/API and both
   dedicated runtime workers in an isolated pool, atomically switch admission to
   that pool, and stop all old instances from accepting new work;
4. drain the old pool and record `old_instances_remaining=0`; do not continue
   while any old instance can call the four-argument 1070 authority;
5. only then execute postdeploy migration 1090, verify its exact ledger hash and
   schema reload, and confirm the legacy authority is owner-only while all three
   causal functions remain service-only;
6. invoke both protected repair routes repeatedly until each exact
   acknowledgement reports `remainingCount: 0` and `oldestEnqueuedAt: null`;
7. run both read-only attestations below from a catalog-visible maintenance role;
8. let at least two scheduled invocations of each worker complete and confirm
   both queues remain below the runtime limits before clearing their P1 gates.
9. execute 1120 in bounded batches for historical evidence, drain the legacy
   media source writers, start and seal a new generation, then disposition every
   blocked canonical reference by exact backfill or explicit quarantine; a
   snapshot-complete response is never cutover or GC authority.

Do not deploy the runtime caller before 1040: a missing RPC would make every
scheduled repair attempt fail. Do not clear P1-31 merely because 1040 committed:
the initial backfill is intentionally queued and must be drained on the deployed
worker.

Do not treat 1090 as an ordinary rolling migration. If the cutover cannot prove
zero old instances, leave 1090 unapplied and keep launch status **NO-GO**; running
it early would intentionally break legacy callers, while leaving legacy callers
admitted after causal reservations would let them bypass reservation ordering.

## Verification

Static migration and runner contracts:

```bash
npx jest --runInBand \
  supabase/migrations/__tests__/durable-post-interaction-count-repair.test.ts \
  supabase/migrations/__tests__/close-hot-score-batch-public-execute.test.ts \
  supabase/migrations/__tests__/bind-bookmark-count-consistency.test.ts \
  supabase/migrations/__tests__/durable-comment-reaction-count-repair.test.ts \
  supabase/migrations/__tests__/set-comment-reaction-desired-state.test.ts \
  supabase/migrations/__tests__/comment-reaction-causal-intents.test.ts \
  supabase/migrations/__tests__/close-legacy-comment-reaction-desired-state.test.ts \
  supabase/migrations/__tests__/post-media-claims.test.ts \
  supabase/migrations/__tests__/post-media-coverage-inventory.test.ts

node --test scripts/maintenance/apply-launch-migrations.test.mjs
```

Disposable PostgreSQL 17 proofs:

```bash
supabase/migrations/__tests__/durable-post-interaction-count-repair.pg17.sh
supabase/migrations/__tests__/close-hot-score-batch-public-execute.pg17.sh
supabase/migrations/__tests__/bind-bookmark-count-consistency.pg17.sh
supabase/migrations/__tests__/durable-comment-reaction-count-repair.pg17.sh
supabase/migrations/__tests__/set-comment-reaction-desired-state.pg17.sh
supabase/migrations/__tests__/comment-reaction-causal-intents.pg17.sh
supabase/migrations/__tests__/close-legacy-comment-reaction-desired-state.pg17.sh
supabase/migrations/__tests__/post-media-claims.pg17.sh
supabase/migrations/__tests__/post-media-coverage-inventory.pg17.sh
```

The 1080/1090 static suites contribute 20/20 passing tests; both matching PG17
proofs pass against the real composed 1060/1070 dependency graph. The final
runner contract is 19/19. The adjacent inert 1100 registry is separately covered
by its dedicated Jest 13/13 and PostgreSQL 17 proof. The adjacent inert 1110
claims migration is separately covered by Jest 12/12 and its PostgreSQL 17
adversarial proof. Neither migration enables lease, cleanup, delete, cron, GC, or
Storage mutation; 1110 also has no current app/API caller.

The adjacent 1120 coverage migration is separately covered by Jest 12/12 and its
PostgreSQL 17 hostile/replay/concurrency proof. It exposes five private tables and
seven functions but zero app/API/cron callers, always reports
`cutover_ready=false` / `authoritative_for_gc=false`, and performs no source,
claim, cleanup, GC, or Storage mutation.

Causal comment-reaction application contracts:

```bash
npx jest --runInBand --runTestsByPath \
  lib/comments/comment-reaction-client-contract.test.ts \
  'app/api/posts/[id]/comments/like/__tests__/route.test.ts' \
  'app/api/posts/[id]/comments/like/intents/__tests__/route.test.ts' \
  app/components/post/hooks/__tests__/usePostComments.test.tsx \
  app/components/post/hooks/__tests__/usePostComments.uncertain.test.tsx \
  lib/comments/comment-reaction-reservation-lock.test.ts \
  lib/cron/inline-jobs.comment-reaction-repair.test.ts

npm run type-check
```

This application gate is 7 suites / 263 tests, followed by a clean TypeScript
check. It covers exact reserve/apply receipts, same-ticket retries, canonical
reconciliation, latest local intent handling, Web Locks fallback, and bounded
ticket cleanup; it does not claim cross-device physical-click ordering.

Runtime worker contracts:

```bash
npx jest --runInBand --runTestsByPath \
  lib/cron/inline-jobs.post-interaction-repair.test.ts \
  app/api/cron/repair-post-interaction-counts/__tests__/route.test.ts \
  lib/cron/inline-jobs.comment-reaction-repair.test.ts \
  app/api/cron/repair-comment-reaction-counts/__tests__/route.test.ts
```

The two post worker/route suites contain 17 tests; the two comment worker/route
suites contain 19. Do not roll unrelated shared cron suites into either count.

After the production drain:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f docs/sql/post-interaction-count-repair-attestation.sql

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f docs/sql/comment-reaction-count-repair-attestation.sql
```

Both scripts have been executed end to end against their disposable
PostgreSQL 17 zero-backlog fixtures. That proves their catalog queries and
read-only drift checks compile against the reviewed migrations; it does not
replace running them against the drained production snapshot.

The attestation begins a repeatable-read, read-only transaction and always ends
with `ROLLBACK`. It verifies:

- exact postgres-owned permanent queue relation, forced RLS with no policies,
  exact four columns/defaults/PK/retry CHECK, no foreign key, and the ordered
  `(next_attempt_at,enqueued_at,post_id)` index;
- no queue table/column ACL leakage and service-only non-grantable worker
  execution;
- exactly three enabled post enqueue triggers and a trigger source with no post/auth/
  advisory lock;
- worker metadata and the `P -> posts -> Q -> recount -> posts update` source
  order;
- closed arithmetic like/bookmark RPCs and closed child-table `TRUNCATE`;
- all four live reaction/vote authorities still use `P` before updating posts;
- all four hot-score authorities retain exact source markers, safe function
  settings, source-digest comments, and service-only execution;
- all three bookmark RPC metadata, lock order, source digest, exact ACL, and
  absolute `bookmark_count` source truth;
- comment queue/worker/shared gate, absolute sync, source/cache guards, exact
  four-trigger set, source/worker ACL, nine-key receipt, backlog, and zero
  like/dislike drift;
- exact 1080 head/operation columns, defaults, constraint/index digests,
  cascade topology, permanent owner-only relations, forced RLS, zero policies,
  zero user triggers, and no table or column ACL leakage;
- the exact four-function comment desired-state surface and fixed reviewed
  source digests; 1070 is owner-only after 1090, the three causal functions are
  service-only without grant option, and causal apply still composes the sealed
  owner function;
- the exact head comment that states sequence order is server reservation order,
  not physical click time;
- total/due backlog, oldest age, maximum attempt count, and drift counts for each
  of the six post cached values.

It raises an exception for any cached-counter mismatch or for an oldest queue
item over 15 minutes. A fresh nonempty queue is reported but is not itself a
schema failure because a write can race immediately after a successful drain;
the rollout gate still requires the explicit zero-backlog observation in step 6.

## Incident handling

If the worker reports contention, rerun it; do not delete queue rows manually.
If age or count crosses the alarm threshold:

1. keep launch status NO-GO and preserve the queue;
2. inspect the protected route response and pipeline log for RPC/timeout/auth
   failures;
3. verify the 1040/1050/1060/1070/1080 predeploy and 1090 postdeploy exact
   ledger, then confirm owner-only legacy execution and service-only causal
   execution before changing capacity;
4. run bounded protected invocations until the backlog falls, then attest;
5. if drift remains with an empty queue, enqueue the affected post identities
   through a reviewed service maintenance authority or deploy a reviewed
   backfill migration—never repair by incrementing cached values.

Direct queue DML, disabling triggers, granting browser access, bulk child-table
`TRUNCATE`, or increasing timeouts without proving the lock order are not valid
recovery actions.

If `old_instances_remaining` is nonzero or cannot be proved, do not execute or
replay 1090 as a workaround. Restore the atomic cutover evidence first and keep
production **NO-GO**.
