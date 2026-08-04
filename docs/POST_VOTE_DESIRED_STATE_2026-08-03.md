# Built-in post vote desired-state authority

Date: 2026-08-03
Priority: P1 data truth
Migration: `20260803103000_set_post_vote_desired_state.sql`

## Outcome

This migration adds a retry-safe authority for the built-in sentiment vote:

```sql
public.set_post_vote_desired_state_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_desired_choice text
) returns jsonb
```

`p_desired_choice` accepts `bull`, `bear`, `wait`, or SQL `NULL`. SQL `NULL`
means that the actor should have no vote. The function has no defaults: callers
must send the intended final state, and retry the same final state after a
timeout instead of recomputing another toggle edge.

The migration depends on both
`20260803101000_close_post_interaction_child_direct_writes.sql` and
`20260803102000_set_post_reaction_desired_state.sql`. It fails closed if the
child-table boundary, either reaction authority that owns the shared post lock,
the canonical audience chain, schema, RLS, trigger, ACL, or historical vote
domain has drifted.

## State machine

| Current row | Desired value            | Action      | Final row |
| ----------- | ------------------------ | ----------- | --------- |
| absent      | SQL `NULL`               | `unchanged` | absent    |
| absent      | `bull` / `bear` / `wait` | `added`     | desired   |
| same choice | same choice              | `unchanged` | unchanged |
| any choice  | another choice           | `changed`   | desired   |
| any choice  | SQL `NULL`               | `removed`   | absent    |

Every success, including both forms of `unchanged`, performs an absolute source
recount and repairs `posts.poll_bull`, `posts.poll_bear`, and `posts.poll_wait`.
Repeating a desired value therefore repairs stale caches without reversing the
first successful write.

## Exact acknowledgement

Success has exactly four outer keys and three nested counter keys:

```json
{
  "status": "added|removed|changed|unchanged",
  "action": "added|removed|changed|unchanged",
  "vote": "bull|bear|wait|null",
  "poll": {
    "bull": 0,
    "bear": 0,
    "wait": 0
  }
}
```

`status` equals `action`; `vote` is the final state. SQL `NULL` in a required
UUID argument, or a non-null choice outside the allowlist, returns exactly
`{"status":"invalid"}`. A malformed UUID is rejected by PostgreSQL argument
coercion with SQLSTATE `22P02` before the typed function begins.

A missing account, missing/ineligible post, canonical-audience denial, or a
non-null vote against a post whose `poll_enabled` is not exactly true returns
exactly `{"status":"not_found"}` without child or counter effects. After the
canonical audience check, desired SQL `NULL` remains allowed on a disabled post
so old rows can be removed and no-row retries can repair all three counters.

Only `service_role` can execute either vote function. `PUBLIC`, `anon`,
`authenticated`, and `authenticator` have no execute grant; an unauthorized
invocation fails with SQLSTATE `42501`.

## Shared serialization order

Both vote functions acquire resources in this order:

1. shared post counter/parent-row domain: `post-reaction-counts:<post_id>`
2. legacy vote pair domain: `post-vote:<post_id>:<actor_id>`
3. actor account with `FOR KEY SHARE`
4. canonical `lock_actor_can_interact_with_post` authority
5. `poll_enabled` eligibility
6. the exact `(post_id,user_id)` vote row
7. mutation, absolute three-way recount, then `posts` update

The historical name `post-reaction-counts:` is intentional rolling-deploy
compatibility, not a vote/reaction taxonomy claim. The 1020 legacy and desired
reaction authorities already own it. Reusing it serializes all four
reaction/vote writers before their canonical helper obtains `FOR SHARE` on the
same `posts` row, preventing a cross-authority SHARE-to-UPDATE lock-upgrade
deadlock and stale absolute recounts. Migration and attestation prove the two
1020 function metadata records, source-digest comments, ACLs, and lock order
before accepting that dependency.

The actor account lock precedes audience and child locks. A hard delete of that
same actor either wins first (`not_found`) or waits for the RPC and cascades
after commit without reversing the child/account lifecycle order.

## Rolling compatibility

`public.toggle_post_vote_atomic(p_actor_id uuid,p_post_id uuid,p_choice text)`
remains present with the same parameter names/order, zero defaults, three valid
choices, toggle behavior, and nested `poll` acknowledgement. It now also uses
the shared post domain, account lifecycle guard, explicit UUID generation,
composite-key mutations, exact absolute recount, and poll eligibility. Explicit
SQL `NULL`, which previously passed through SQL three-valued `NOT IN` logic,
now returns exact `invalid`.

Old application servers can continue using the legacy function while new
servers move to desired state. Remove the toggle only after old servers drain.
The separately tested `app/lib` cutover in this release binds and retries the
original desired final state, accepts `unchanged`, and never recomputes a new
toggle edge after an uncertain response.

## Schema and authority gates

Deployment and the read-only production attestation verify:

- permanent, unpartitioned postgres-owned `posts`, `post_votes`, and quarantine
  tables;
- exact UUID identity columns, `PRIMARY KEY (id)`, and a valid, ready,
  nonpartial, nonexpression exact-order `UNIQUE (post_id,user_id)`;
- validated, nondeferrable, single-column `ON DELETE CASCADE` foreign keys to
  `posts(id)` and `auth.users(id)`;
- `id DEFAULT gen_random_uuid()` plus explicit UUID writes;
- non-null text `choice`, no incompatible history, and an exact validated
  `bull|bear|wait` CHECK;
- nullable integer poll caches and boolean `poll_enabled` without inventing
  stronger historical column nullability;
- the one authenticated own-row SELECT policy and closed browser raw DML;
- the enabled canonical BEFORE ROW INSERT/UPDATE vote trigger and its
  postgres-owned internal-only guard function;
- internal-only canonical audience wrapper/locked implementation, including
  source digest and block-edge ordering;
- postgres-owned volatile `plpgsql` SECURITY DEFINER RPCs, exact argument
  metadata, four safe function settings, service-only non-grantable EXECUTE,
  source digests, and overload cardinality.

The migration locks `auth.users`, then `posts`, then `post_votes` before its
preflight and re-attests before commit.

## Remaining red P1 release gates

This slice does not make account hard-delete cascades or direct service-role
`DELETE` participate in the shared advisory domain. The canonical child trigger
runs only on INSERT/UPDATE and performs audience validation; it neither locks
the counter domain nor recounts, and DELETE/cascade bypasses it. A cascade can
therefore remove a vote after an RPC recount and leave a poll cache high until
the next successful vote RPC (including an unchanged/no-row SQL `NULL`) repairs
it. The PG17 proof demonstrates both the wait ordering and this repair; it is
not global cached-counter closure.

The shared key is also only proven here for the four reaction/vote authorities.
Other writers that lock the same `posts` row and update another cached counter,
including the current bookmark toggle, still need a full common parent-row lock
inventory. Close those writers and cascade/direct-delete reconciliation before
declaring every post counter writer deadlock-free and authoritative.

## Verification and rollout

Run the static contract:

```bash
npx jest --runInBand \
  supabase/migrations/__tests__/set-post-vote-desired-state.test.ts
```

Run the disposable PostgreSQL 17 proof:

```bash
supabase/migrations/__tests__/set-post-vote-desired-state.pg17.sh
```

Apply and attest in order:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260803101000_close_post_interaction_child_direct_writes.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260803102000_set_post_reaction_desired_state.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260803103000_set_post_vote_desired_state.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f docs/sql/post-vote-desired-state-attestation.sql
```

The attestation is read-only and ends with `ROLLBACK`.
