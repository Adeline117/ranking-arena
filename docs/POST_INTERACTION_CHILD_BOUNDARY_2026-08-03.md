# Post interaction child-table boundary rollout

Date: 2026-08-03
Migration: `20260803101000_close_post_interaction_child_direct_writes.sql`

## Outcome

The migration closes browser raw `INSERT`, `UPDATE`, and `DELETE` access to:

- `post_likes`
- `post_votes`
- `post_bookmarks`
- `post_reactions`, when the legacy table exists
- `post_emoji_reactions`
- `comment_emoji_reactions`, when the dormant table exists
- `poll_votes`

All historical policies on an extant source table are removed. The only policy
recreated is authenticated own-row `SELECT`; anon and authenticator receive no
raw identity read. Service-role reads remain available to server APIs.

Own-only is the deliberately conservative browser-read boundary for this
slice. It prevents one actor from enumerating another actor's interaction
identity, but it does not compose the current parent post/comment audience. An
actor can therefore still read their own stored child resource ID after later
losing access to the parent. Existing group hydration needs own-row reads. A
later batch-status API can remove raw browser reads entirely or enforce
own-plus-current-parent visibility without reopening cross-user access.

The tables keep RLS enabled without `FORCE ROW LEVEL SECURITY`. This is
intentional: canonical mutation functions are postgres-owned
`SECURITY DEFINER` authorities and must continue to write after browser table
privileges are revoked. The migration preflight blocks if any expected writer
is missing, invoker-mode, no longer owned by postgres, has an unsafe
`search_path`, or lacks its canonical execute ACL. The PostgreSQL proof invokes
all eight writers and verifies their source-table effects, including folder
save followed by removal.

This slice converges `PUBLIC`, `anon`, `authenticated`, and `authenticator`.
It preserves existing `service_role` maintenance DML ACLs and explicitly
ensures service reads remain available; the application runtime paths audited
for these tables use controlled RPCs for mutation. Migration and production
attestation both require `service_role` to remain `NOSUPERUSER` with its scoped
`BYPASSRLS`, so aggregate and export reads cannot silently become empty under
the authenticated own-row policy. They require `anon`, `authenticated`, and
`authenticator` to remain `NOSUPERUSER NOBYPASSRLS`; the migration fails safely
instead of trying to alter production roles. Revoking service-role raw DML is a
separate server-maintenance boundary and requires its own inventory of
operational cleanup jobs. It is not evidence that browser raw DML remains open.

## Legacy emoji handling

The database allowlist is the API allowlist:

`👍 🔥 💎 🚀 ❤️ 👀 🎯 💰 📈 📉 🤔 😂`

Before installing an exact validated check constraint, unsupported existing
rows are copied in full JSON form to
`interaction_emoji_reaction_quarantine`, then removed from the live source
table. Evidence is keyed by source table, source UUID, and a payload
fingerprint, so reuse of the same source UUID with a different payload creates a
second evidence version instead of overwriting the first. A replay reconciles
metadata only when the stored payload is identical. Each live delete requires
an exact matching fingerprint, payload, actor, source ID, and reason; any
evidence/delete count mismatch rolls the transaction back.

The quarantine has no RLS policies. The migration removes every direct
non-owner table and column ACL, including grants inherited by a browser role
through an unexpected intermediate role; postgres owns the table and only
`service_role` receives read-only access. Each evidence row retains an exact,
validated `user_id` foreign key to `auth.users(id)` with `ON DELETE CASCADE`, so
account hard deletion also erases its quarantined identity payload. The
attestation verifies the three-column evidence key, exact FK columns, exact
CHECK definitions, payload fingerprint, and payload/metadata parity.

Do not restore quarantined rows directly. If product adds another emoji, first
update the API/RPC/database allowlists together in a new migration, then use a
reviewed postgres-owner recovery statement.

## Historical schema safety

Five active relations are required and make the migration fail closed when
missing or structurally incompatible:

- `post_likes`
- `post_votes`
- `post_bookmarks`
- `post_emoji_reactions`
- `poll_votes`

`post_reactions` and `comment_emoji_reactions` are legacy/dormant. Their absence
is safe because there is no underlying raw-table attack surface; their presence
is fully converged. The migration also blocks on noncanonical ownership,
partitioning, inheritance, incompatible `user_id`/emoji columns, or an
incompatible pre-existing quarantine table.

Every extant source relation must also have both:

- an exact, valid, ready, nonpartial, nonexpression unique key used by its
  controlled writer (`post_id/user_id`, the emoji identity triple, or the poll
  vote identity triple); and
- an exact, validated `user_id -> auth.users(id) ON DELETE CASCADE` foreign key.

The migration does not invent a key, deduplicate production data, or silently
repair an incompatible historical schema. It blocks and rolls back so the
schema can be inventoried and repaired in a separate forward migration. A
blocked transaction makes no partial policy, ACL, row, quarantine, or
constraint change.

## Production rollout

1. Confirm no separate deploy is concurrently changing interaction table DDL.
   Estimate the legacy cleanup before taking the deployment lock:

   ```sql
   SELECT 'post_emoji_reactions' AS source_table, count(*) AS unsupported
   FROM public.post_emoji_reactions
   WHERE emoji IS NULL
      OR NOT (emoji = ANY ('{👍,🔥,💎,🚀,❤️,👀,🎯,💰,📈,📉,🤔,😂}'::text[]))
   UNION ALL
   SELECT 'comment_emoji_reactions', count(*)
   FROM public.comment_emoji_reactions
   WHERE emoji IS NULL
      OR NOT (emoji = ANY ('{👍,🔥,💎,🚀,❤️,👀,🎯,💰,📈,📉,🤔,😂}'::text[]));
   ```

   If the optional comment table is absent, omit that branch. A volume that
   cannot be copied and constrained within the two-minute statement timeout is
   a rollout blocker; do not raise the timeout without a reviewed batched
   quarantine plan.

2. Apply the migration through the normal migration ledger. It first takes
   `SHARE ROW EXCLUSIVE` on `auth.users`, then takes the same lock on extant
   children in deterministic order. This matches account deletion's
   parent-to-child order and prevents a child-to-parent FK-creation deadlock.
   Dropping and recreating each emoji CHECK also acquires `ACCESS EXCLUSIVE` and
   validates with a full source-table scan, temporarily blocking reads and
   writes on that emoji table. Schedule a maintenance window sized from the
   preflight counts/table size. The five-second lock timeout makes contention
   fail safely for retry; the two-minute statement timeout is a hard rollout
   ceiling, not permission to call the lock brief.
3. Run the PostgreSQL 17 proof before release:

   ```bash
   PG17_BIN=/opt/homebrew/opt/postgresql@17/bin \
     bash supabase/migrations/__tests__/close-post-interaction-child-direct-writes.pg17.sh
   ```

4. Run the production catalog attestation through a direct postgres session:

   ```bash
   psql "$PRODUCTION_DATABASE_URL" \
     -f docs/sql/post-interaction-child-boundary-attestation.sql
   ```

   Do not run the attestation through PostgREST. It is a read-only catalog proof
   intended for the database owner and exits nonzero on policy, role, ACL, FK,
   unique-key, function-authority, evidence, or allowlist drift. It uses valid
   unique-index metadata rather than a seven-table `GROUP BY` scan.

5. Record the seven boundary status rows and quarantine counts in the release
   evidence. `absent_safe` is accepted only for `post_reactions` and
   `comment_emoji_reactions`.
6. Smoke-test like/dislike, built-in vote, ordinary bookmark, bookmark-folder
   save/removal, post emoji, and custom poll through their HTTP APIs. Browser
   direct Supabase reads used by the group page must still return only the
   current viewer's own like/bookmark rows.

## Release blockers

Do not bypass the migration or reopen browser grants if any of these occur:

- an active required table is missing;
- an exact writer unique key or user-account cascade FK is missing;
- an expected controlled writer is not postgres-owned `SECURITY DEFINER` with
  the safe search path and canonical caller ACL;
- unknown policies or table/column mutation ACLs reappear after replay;
- an emoji constraint cannot validate after quarantine;
- the production attestation does not print
  `post interaction child boundary production attestation passed`;
- a canonical API RPC fails while direct browser mutation is correctly denied.

Resolve schema/function drift with a forward migration. Regranting authenticated
raw DML would reintroduce the identity, authorization, and cached-count bypass
this boundary closes.

## Explicit follow-up release gates

This boundary prevents new browser raw-write drift; it is not a historical
counter-repair migration and is not by itself a whole-site launch attestation.
Before general launch, a separate forward migration and production proof must:

- recount and attest cached post/poll truth (`like_count`, `dislike_count`,
  bookmark and built-in vote counts, and custom poll option votes), including
  the account-hard-delete path, because FK cascades do not execute these eight
  RPCs; and
- inventory and clean non-emoji legacy domain violations such as invalid
  reaction/vote values or poll option indexes outside the current poll shape.

Until those proofs exist, cached-count parity and non-emoji historical domain
integrity remain release blockers outside this narrowly completed ACL/RLS and
emoji-evidence slice.
