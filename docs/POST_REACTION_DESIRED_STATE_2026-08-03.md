# Post reaction desired-state authority

Date: 2026-08-03
Priority: P1 data truth
Migration: `20260803102000_set_post_reaction_desired_state.sql`

## Outcome

This migration adds a retry-safe authority for post up/down reactions:

```sql
public.set_post_reaction_desired_state_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_desired_reaction text
) returns jsonb
```

`p_desired_reaction` accepts only `up`, `down`, or SQL `NULL`. SQL `NULL`
means the actor should have no reaction. The RPC has no default arguments, so a
caller must send its intended final state explicitly.

The migration depends on
`20260803101000_close_post_interaction_child_direct_writes.sql`. It fails closed
if that browser-write boundary, the canonical audience authority, identity
keys, cascade foreign keys, RLS policy, or reaction domain has drifted.

## State machine

| Current row | Desired value | Action      | Final row |
| ----------- | ------------- | ----------- | --------- |
| absent      | SQL `NULL`    | `unchanged` | absent    |
| absent      | `up`/`down`   | `added`     | desired   |
| `up`        | `up`          | `unchanged` | `up`      |
| `down`      | `down`        | `unchanged` | `down`    |
| `up`        | `down`        | `changed`   | `down`    |
| `down`      | `up`          | `changed`   | `up`      |
| `up`/`down` | SQL `NULL`    | `removed`   | absent    |

Repeating the same desired value never reverses the first successful write.
Every success, including `unchanged`, performs an absolute source recount and
repairs `posts.like_count` and `posts.dislike_count` inside the transaction.

## Exact acknowledgements

Successful calls return exactly five keys:

```json
{
  "status": "added|removed|changed|unchanged",
  "action": "added|removed|changed|unchanged",
  "reaction": "up|down|null",
  "like_count": 0,
  "dislike_count": 0
}
```

`status` and `action` are identical. `reaction` is the final state.

SQL `NULL` in either required UUID argument, or a non-null desired value outside
`up|down`, returns exactly:

```json
{ "status": "invalid" }
```

A syntactically malformed UUID cannot enter this typed function; PostgreSQL
rejects it during argument coercion with SQLSTATE `22P02`.

A missing account, missing post, or canonical-audience denial returns exactly:

```json
{ "status": "not_found" }
```

A caller whose JWT role is not `service_role` receives SQLSTATE `42501`; the
function is not executable by `PUBLIC`, `anon`, `authenticated`, or
`authenticator`.

## Serialization and lifecycle order

Both the new authority and the retained legacy toggle acquire locks in this
order:

1. post-wide counter domain: `post-reaction-counts:<post_id>`
2. legacy pair domain: `post-reaction:<post_id>:<actor_id>`
3. actor row in `auth.users` with `FOR KEY SHARE`
4. canonical `lock_actor_can_interact_with_post` authority
5. the `(post_id,user_id)` reaction row
6. absolute child recount and `posts` counter update

The post-wide domain serializes different actors writing the same post, so two
absolute recounts cannot overwrite each other from partial snapshots. Reusing
the legacy pair domain prevents the old and new endpoints from crossing for the
same actor during a rolling deployment.

The account row is locked before any reaction child row. A concurrent account
hard delete therefore either completes first and produces `not_found`, or waits
until the reaction transaction commits and then performs its cascade. The PG17
proof rejects deadlocks and lock timeouts for this sequence.

## Rolling compatibility

`public.toggle_post_reaction(uuid,uuid,text)` is deliberately not removed. Its
signature, default argument, valid `up|down` toggle behavior, and success ACK
shape remain compatible. Explicit SQL `NULL` previously fell through a
three-valued `NOT IN` check and could attempt a null reaction; it now returns
the exact `invalid` ACK because the canonical reaction domain forbids null
rows. The migration also adds the same post-wide counter domain, account
lifecycle guard, explicit UUID generation, composite-key mutations, and
absolute recount contract.

Application traffic should move to the desired-state RPC only after the
database migration is present. Removing the legacy toggle is a later contract
phase after old servers are drained.

## Schema and authority gates

Deployment and production attestation verify:

- canonical permanent postgres-owned `posts`, `post_likes`, and quarantine
  relations;
- exact `post_likes` UUID columns and `PRIMARY KEY (id)`;
- exact valid `UNIQUE (post_id,user_id)` order;
- validated single-column `ON DELETE CASCADE` foreign keys to `posts(id)` and
  `auth.users(id)`;
- canonical `id DEFAULT gen_random_uuid()` plus explicit UUID generation in
  both writers;
- validated non-null `up|down` reaction check and no incompatible history;
- the own-only authenticated SELECT policy from the prior boundary migration;
- no browser mutation ACLs;
- postgres-owned `plpgsql` `SECURITY DEFINER` functions with fixed safe
  `search_path`, RLS, timeout, volatility, strictness, parallel, leakproof, and
  execute-grant properties;
- an internal-only canonical audience wrapper that calls the block-edge lock
  before its source-attested locked implementation;
- source-digest comments for the desired and legacy authorities.

The migration acquires table locks in parent-to-child order (`auth.users`,
`posts`, `post_likes`) before running catalog preflight. Postflight repeats the
identity keys, defaults, foreign keys, RLS boundary, function metadata, ACLs,
lock order, and source attestations before commit.

## Remaining release gate: hard-delete counter ownership

**This slice does not make account hard-delete cascades participate in the
post-wide advisory domain.** A delete of a different actor can remove a
`post_likes` row after an RPC recount and temporarily leave a cached post
counter high. Any later valid desired-state call for that post repairs the
counter, and the PG17 lifecycle test proves that repair, but this is not a
complete counter-authority closure.

Before claiming reaction counters are closed under every writer, ship a single
counter owner that also covers account/post cascades (for example a proven
trigger/delta or ordered reconciliation authority) and attest every direct
service writer. Until then, account hard delete plus cached-counter parity is a
red P1 release gate, not a solved invariant.

## Verification and rollout

Run the static contract:

```bash
npx jest --runInBand \
  supabase/migrations/__tests__/set-post-reaction-desired-state.test.ts
```

Run the disposable PostgreSQL 17 proof:

```bash
supabase/migrations/__tests__/set-post-reaction-desired-state.pg17.sh
```

The PG17 proof covers dependency failure, unauthorized/invalid/not-found ACKs,
absent/add/replay/change/remove/SQL-NULL replay, stale-counter repair, two actors
on one post, duplicate concurrent intent, legacy/new overlap, account hard
delete ordering, clean replay, drift convergence, invalid historical rows, and
the production attestation.

Apply in order:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260803101000_close_post_interaction_child_direct_writes.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260803102000_set_post_reaction_desired_state.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f docs/sql/post-reaction-desired-state-attestation.sql
```

The attestation is read-only and ends with `ROLLBACK`.

## Scope boundary

This database slice does not edit `app/lib` callers. Route and client cutover,
late-response suppression across UI surfaces, and eventual legacy removal are
separate application/contract steps. During that cutover, use the exact RPC
shape above and treat `reaction` plus returned absolute counters as the server
truth.
