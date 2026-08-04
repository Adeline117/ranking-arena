# Durable post interaction count repair

Date: 2026-08-03

Priority: P1 data truth / release gate
Migrations:

- `20260803104000_durable_post_interaction_count_repair.sql`
- `20260803104500_close_hot_score_batch_public_execute.sql`

## Outcome

Reaction and built-in vote source rows remain canonical. The five cached values
on `posts` are projections only:

| Cached value    | Canonical source predicate          |
| --------------- | ----------------------------------- |
| `like_count`    | `post_likes.reaction_type = 'up'`   |
| `dislike_count` | `post_likes.reaction_type = 'down'` |
| `poll_bull`     | `post_votes.choice = 'bull'`        |
| `poll_bear`     | `post_votes.choice = 'bear'`        |
| `poll_wait`     | `post_votes.choice = 'wait'`        |

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
  exactly `1`. It restores all five counters from source rows, or discards an
  obligation after the post is committed-absent, with one post lock-set per
  database transaction.
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

## Serialization contract

`P` means the canonical advisory key
`post-reaction-counts:<post_id>` and `Q` means the queue row.

```text
live reaction/vote RPC: P -> actor/audience -> child row -> posts recount -> Q trigger
repair worker:          P -> posts row -> Q -> source recount -> posts update
account hard delete:    auth/users cascade -> child row delete -> Q trigger
post hard delete:       posts -> child row delete -> Q trigger
```

The enqueue trigger never takes `P`, a post row, or an auth row. The worker never
claims `Q` before `P` and the post row. It uses `SKIP LOCKED`, leaving a contended
obligation for a later pass rather than waiting while holding the reverse edge.
All four live authorities must retain the same `P` key:

- `toggle_post_reaction(uuid,uuid,text)`
- `set_post_reaction_desired_state_atomic(uuid,uuid,text)`
- `toggle_post_vote_atomic(uuid,uuid,text)`
- `set_post_vote_desired_state_atomic(uuid,uuid,text)`

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

## Ordered rollout

The release runner must contain these migrations exactly once and in this
order:

1. `20260803101000_close_post_interaction_child_direct_writes.sql`
2. `20260803102000_set_post_reaction_desired_state.sql`
3. `20260803103000_set_post_vote_desired_state.sql`
4. `20260803104000_durable_post_interaction_count_repair.sql`
5. `20260803104500_close_hot_score_batch_public_execute.sql`

The candidate manifest has 194 predeploy migrations and 220 unique classified
migrations in total. Production execution still uses the governed migration
channel and exact name/body/hash ledger; the local runner's mutating psql
commands remain disabled by ADR-023.

Roll out in this order:

1. deploy migrations 1040 and 1045 through the approved production channel;
2. verify exact ledger body/hash and the PostgREST schema reload;
3. deploy the same release SHA containing the dedicated runtime worker route;
4. invoke the protected repair route repeatedly until its exact acknowledgement
   reports `remainingCount: 0` and `oldestEnqueuedAt: null`;
5. run the read-only attestation below from a catalog-visible maintenance role;
6. let at least two scheduled invocations complete and confirm the queue remains
   below both runtime limits before clearing P1-31.

Do not deploy the runtime caller before 1040: a missing RPC would make every
scheduled repair attempt fail. Do not clear P1-31 merely because 1040 committed:
the initial backfill is intentionally queued and must be drained on the deployed
worker.

## Verification

Static migration and runner contracts:

```bash
npx jest --runInBand \
  supabase/migrations/__tests__/durable-post-interaction-count-repair.test.ts \
  supabase/migrations/__tests__/close-hot-score-batch-public-execute.test.ts

node --test scripts/maintenance/apply-launch-migrations.test.mjs
```

Disposable PostgreSQL 17 proofs:

```bash
supabase/migrations/__tests__/durable-post-interaction-count-repair.pg17.sh
supabase/migrations/__tests__/close-hot-score-batch-public-execute.pg17.sh
```

Runtime worker contracts:

```bash
npx jest --runInBand --runTestsByPath \
  lib/cron/inline-jobs.post-interaction-repair.test.ts \
  app/api/cron/repair-post-interaction-counts/__tests__/route.test.ts
```

These exact two worker/route suites contain 17 tests. Do not roll unrelated
shared cron suites into that count.

After the production drain:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f docs/sql/post-interaction-count-repair-attestation.sql
```

The attestation begins a repeatable-read, read-only transaction and always ends
with `ROLLBACK`. It verifies:

- exact postgres-owned permanent queue relation, forced RLS with no policies,
  exact four columns/defaults/PK/retry CHECK, no foreign key, and the ordered
  `(next_attempt_at,enqueued_at,post_id)` index;
- no queue table/column ACL leakage and service-only non-grantable worker
  execution;
- exactly two enabled enqueue triggers and a trigger source with no post/auth/
  advisory lock;
- worker metadata and the `P -> posts -> Q -> recount -> posts update` source
  order;
- closed arithmetic like RPCs and closed child-table `TRUNCATE`;
- all four live reaction/vote authorities still use `P` before updating posts;
- all four hot-score authorities retain exact source markers, safe function
  settings, source-digest comments, and service-only execution;
- total/due backlog, oldest age, maximum attempt count, and drift counts for each
  of the five cached values.

It raises an exception for any cached-counter mismatch or for an oldest queue
item over 15 minutes. A fresh nonempty queue is reported but is not itself a
schema failure because a write can race immediately after a successful drain;
the rollout gate still requires the explicit zero-backlog observation in step 4.

## Incident handling

If the worker reports contention, rerun it; do not delete queue rows manually.
If age or count crosses the alarm threshold:

1. keep launch status NO-GO and preserve the queue;
2. inspect the protected route response and pipeline log for RPC/timeout/auth
   failures;
3. verify 1040 exact ledger and service-role EXECUTE before changing capacity;
4. run bounded protected invocations until the backlog falls, then attest;
5. if drift remains with an empty queue, enqueue the affected post identities
   through a reviewed service maintenance authority or deploy a reviewed
   backfill migration—never repair by incrementing cached values.

Direct queue DML, disabling triggers, granting browser access, bulk child-table
`TRUNCATE`, or increasing timeouts without proving the lock order are not valid
recovery actions.
