#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE_MIGRATION="$ROOT_DIR/supabase/migrations/20260803106000_durable_comment_reaction_count_repair.sql"
DESIRED_MIGRATION="$ROOT_DIR/supabase/migrations/20260803107000_set_comment_reaction_desired_state.sql"
CAUSAL_MIGRATION="$ROOT_DIR/supabase/migrations/20260803108000_comment_reaction_causal_intents.sql"
DESIRED_FIXTURE="$ROOT_DIR/supabase/migrations/__tests__/set-comment-reaction-desired-state.pg17.sh"

# Reuse the independently proven 1060/1070 PostgreSQL fixture setup through
# its first successful desired-state deployment. This keeps the 1080 proof
# focused on the new ledger instead of copying more than 700 lines of sealed
# dependency scaffolding. ROOT_DIR and migration paths are defined above.
SETUP_PREFIX="$(mktemp /tmp/comment-reaction-causal-setup.XXXXXX)"
awk '
  NR == 2 { print; next }
  NR >= 7 { print }
  $0 == "psql_cmd -f \"$DESIRED_MIGRATION\"" { exit }
' "$DESIRED_FIXTURE" >"$SETUP_PREFIX"
# shellcheck source=/dev/null
source "$SETUP_PREFIX"
rm -f "$SETUP_PREFIX"

psql_cmd -f "$CAUSAL_MIGRATION"

# hostile_column_acl_replay: table-level revocation alone is insufficient;
# replay discovers and removes independently granted column privileges.
psql_cmd -c \
  'GRANT SELECT (actor_id) ON TABLE public.comment_reaction_intent_heads TO authenticated'
assert_scalar 'true' \
  "SELECT pg_catalog.has_column_privilege(
     'authenticated',
     'public.comment_reaction_intent_heads',
     'actor_id',
     'SELECT'
   )::text"
psql_cmd -f "$CAUSAL_MIGRATION"
assert_scalar 'false|0' \
  "SELECT pg_catalog.has_any_column_privilege(
     'authenticated',
     'public.comment_reaction_intent_heads',
     'SELECT,INSERT,UPDATE,REFERENCES'
   )::text || '|' ||
   (SELECT count(*)
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
     WHERE attribute.attrelid IN (
       'public.comment_reaction_intent_heads'::regclass,
       'public.comment_reaction_intent_operations'::regclass
     )
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND acl_entry.grantee <> pg_catalog.to_regrole('postgres'))"

# migration_replay: exact catalog/function convergence is idempotent before
# runtime data exists; CREATE IF NOT EXISTS never bypasses the strict shape
# preflight that follows it.
psql_cmd -f "$CAUSAL_MIGRATION"

ACTOR_ONE='10000000-0000-0000-0000-000000000001'
ACTOR_TWO='10000000-0000-0000-0000-000000000002'
POST_ONE='20000000-0000-0000-0000-000000000001'
COMMENT_ONE='30000000-0000-0000-0000-000000000001'
REQUEST_A='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
REQUEST_B='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
REQUEST_C='cccccccccccccccccccccccccccccccc'
REQUEST_D='dddddddddddddddddddddddddddddddd'
REQUEST_E='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
REQUEST_F='ffffffffffffffffffffffffffffffff'

# service_only_acl: private tables have no grants/policies and browser roles
# cannot invoke any causal function, even with otherwise valid identifiers.
assert_scalar 'true|false|false|false|0|0' \
  "SELECT
     pg_catalog.has_function_privilege(
       'service_role',
       'public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text)',
       'EXECUTE'
     )::text || '|' ||
     pg_catalog.has_function_privilege(
       'authenticated',
       'public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text)',
       'EXECUTE'
     )::text || '|' ||
     pg_catalog.has_function_privilege(
       'anon',
       'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)',
       'EXECUTE'
     )::text || '|' ||
     pg_catalog.has_table_privilege(
       'service_role',
       'public.comment_reaction_intent_operations',
       'SELECT'
     )::text || '|' ||
     (SELECT count(*) FROM pg_catalog.pg_policy
       WHERE polrelid = 'public.comment_reaction_intent_heads'::regclass) || '|' ||
     (SELECT count(*) FROM pg_catalog.pg_policy
       WHERE polrelid = 'public.comment_reaction_intent_operations'::regclass)"
assert_fails service_only_acl \
  "SET ROLE authenticated;
   SET request.jwt.claim.role = 'authenticated';
   SELECT public.reserve_comment_reaction_intent_atomic(
     '$ACTOR_ONE', '$POST_ONE', '$COMMENT_ONE', '$REQUEST_A', 'like'
   )"

# unknown_ticket_no_target_oracle: an unknown request fails before post/comment
# lookup, so arbitrary nonexistent target identifiers do not produce a distinct
# existence signal.
assert_service 'unknown_ticket|1' \
  "SELECT (result->>'status') || '|' ||
          (SELECT count(*) FROM pg_catalog.jsonb_object_keys(result))
     FROM (SELECT public.set_comment_reaction_desired_state_causal_atomic(
       '$ACTOR_ONE',
       '20000000-0000-0000-0000-000000000099',
       '30000000-0000-0000-0000-000000000099',
       '99999999999999999999999999999999',
       1,
       'like'
     ) AS result) AS application"

# same_request_reservation_replay: one immutable request receives one decimal
# sequence; a retry returns the same ticket and does not increment the head.
assert_service 'issued|1|3' \
  "SELECT (result->>'status') || '|' ||
          (result->>'intent_sequence') || '|' ||
          (SELECT count(*) FROM pg_catalog.jsonb_object_keys(result))
     FROM (SELECT public.reserve_comment_reaction_intent_atomic(
       '$ACTOR_ONE', '$POST_ONE', '$COMMENT_ONE', '$REQUEST_A', 'dislike'
     ) AS result) AS reservation"
assert_service 'replayed|1|3' \
  "SELECT (result->>'status') || '|' ||
          (result->>'intent_sequence') || '|' ||
          (SELECT count(*) FROM pg_catalog.jsonb_object_keys(result))
     FROM (SELECT public.reserve_comment_reaction_intent_atomic(
       '$ACTOR_ONE', '$POST_ONE', '$COMMENT_ONE', '$REQUEST_A', 'dislike'
     ) AS result) AS reservation"
assert_scalar '1|1' \
  "SELECT latest_issued_sequence || '|' ||
          (SELECT count(*)
             FROM public.comment_reaction_intent_operations
            WHERE actor_id = '$ACTOR_ONE' AND request_id = '$REQUEST_A')
     FROM public.comment_reaction_intent_heads
    WHERE actor_id = '$ACTOR_ONE' AND comment_id = '$COMMENT_ONE'"

# same_request_conflict: equivocation cannot consume a new sequence or replace
# the immutable desired state bound to the request identity.
assert_service 'operation_conflict' \
  "SELECT result->>'status'
     FROM (SELECT public.reserve_comment_reaction_intent_atomic(
       '$ACTOR_ONE', '$POST_ONE', '$COMMENT_ONE', '$REQUEST_A', 'like'
     ) AS result) AS reservation"
assert_scalar '1|dislike' \
  "SELECT latest_issued_sequence || '|' ||
          (SELECT desired_reaction
             FROM public.comment_reaction_intent_operations
            WHERE actor_id = '$ACTOR_ONE' AND request_id = '$REQUEST_A')
     FROM public.comment_reaction_intent_heads
    WHERE actor_id = '$ACTOR_ONE' AND comment_id = '$COMMENT_ONE'"

# newer_reservation_fences_delayed_apply: once request B is reserved, request A
# is stale and cannot change the pre-existing canonical like.
assert_service 'issued|2|3' \
  "SELECT (result->>'status') || '|' ||
          (result->>'intent_sequence') || '|' ||
          (SELECT count(*) FROM pg_catalog.jsonb_object_keys(result))
     FROM (SELECT public.reserve_comment_reaction_intent_atomic(
       '$ACTOR_ONE', '$POST_ONE', '$COMMENT_ONE', '$REQUEST_B', NULL
     ) AS result) AS reservation"
assert_service 'stale|1' \
  "SELECT (result->>'status') || '|' ||
          (SELECT count(*) FROM pg_catalog.jsonb_object_keys(result))
     FROM (SELECT public.set_comment_reaction_desired_state_causal_atomic(
       '$ACTOR_ONE', '$POST_ONE', '$COMMENT_ONE', '$REQUEST_A', 1, 'dislike'
     ) AS result) AS application"
assert_scalar 'like|1|0' \
  "SELECT reaction_type || '|' ||
          (SELECT like_count FROM public.comments WHERE id = '$COMMENT_ONE') || '|' ||
          (SELECT dislike_count FROM public.comments WHERE id = '$COMMENT_ONE')
     FROM public.comment_likes
    WHERE comment_id = '$COMMENT_ONE' AND user_id = '$ACTOR_ONE'"

# forged_sequence_rejected: a client cannot advance or poison the head merely
# by supplying a large number for a real request.
assert_service 'operation_conflict' \
  "SELECT result->>'status'
     FROM (SELECT public.set_comment_reaction_desired_state_causal_atomic(
       '$ACTOR_ONE', '$POST_ONE', '$COMMENT_ONE', '$REQUEST_B', 999, NULL
     ) AS result) AS application"
assert_scalar '2|like' \
  "SELECT latest_issued_sequence || '|' ||
          (SELECT reaction_type FROM public.comment_likes
            WHERE comment_id = '$COMMENT_ONE' AND user_id = '$ACTOR_ONE')
     FROM public.comment_reaction_intent_heads
    WHERE actor_id = '$ACTOR_ONE' AND comment_id = '$COMMENT_ONE'"

# same_ticket_apply_replay: first apply performs the removal, the retry returns
# the stored exact receipt with applied=false and no second source mutation.
assert_service 'removed||false|2|0|0|9' \
  "SELECT (result->>'action') || '|' || COALESCE(result->>'reaction', '') || '|' ||
          (result->>'replayed') || '|' || (result->>'intent_sequence') || '|' ||
          (result->>'like_count') || '|' || (result->>'dislike_count') || '|' ||
          (SELECT count(*) FROM pg_catalog.jsonb_object_keys(result))
     FROM (SELECT public.set_comment_reaction_desired_state_causal_atomic(
       '$ACTOR_ONE', '$POST_ONE', '$COMMENT_ONE', '$REQUEST_B', 2, NULL
     ) AS result) AS application"
assert_service 'removed|true|9' \
  "SELECT (result->>'action') || '|' || (result->>'replayed') || '|' ||
          (SELECT count(*) FROM pg_catalog.jsonb_object_keys(result))
     FROM (SELECT public.set_comment_reaction_desired_state_causal_atomic(
       '$ACTOR_ONE', '$POST_ONE', '$COMMENT_ONE', '$REQUEST_B', 2, NULL
     ) AS result) AS application"
assert_scalar '0|0|0' \
  "SELECT
     (SELECT count(*) FROM public.comment_likes
       WHERE comment_id = '$COMMENT_ONE' AND user_id = '$ACTOR_ONE') || '|' ||
     like_count || '|' || dislike_count
     FROM public.comments WHERE id = '$COMMENT_ONE'"

# removal_ticket_replay_after_acl_revoke: reserve replay is operation-bound,
# not reauthorized against the source state changed by the original removal.
psql_cmd -c \
  "INSERT INTO public.blocked_users (blocker_id, blocked_id)
   VALUES ('$ACTOR_ONE', '10000000-0000-0000-0000-000000000003')"
assert_service 'replayed|2|3' \
  "SELECT (result->>'status') || '|' || (result->>'intent_sequence') || '|' ||
          (SELECT count(*) FROM pg_catalog.jsonb_object_keys(result))
     FROM (SELECT public.reserve_comment_reaction_intent_atomic(
       '$ACTOR_ONE', '$POST_ONE', '$COMMENT_ONE', '$REQUEST_B', NULL
     ) AS result) AS reservation"
psql_cmd -c \
  "DELETE FROM public.blocked_users
    WHERE blocker_id = '$ACTOR_ONE'
      AND blocked_id = '10000000-0000-0000-0000-000000000003'"

# A real concurrent retry also serializes on request then head. Exactly one
# call applies and one replays the stored receipt.
assert_service 'issued|3' \
  "SELECT (result->>'status') || '|' || (result->>'intent_sequence')
     FROM (SELECT public.reserve_comment_reaction_intent_atomic(
       '$ACTOR_ONE', '$POST_ONE', '$COMMENT_ONE', '$REQUEST_C', 'dislike'
     ) AS result) AS reservation"
for attempt in 1 2; do
  psql_cmd -At >"$TMP_ROOT/causal-concurrent-$attempt.out" <<SQL &
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT result->>'replayed'
FROM (SELECT public.set_comment_reaction_desired_state_causal_atomic(
  '$ACTOR_ONE', '$POST_ONE', '$COMMENT_ONE', '$REQUEST_C', 3, 'dislike'
) AS result) AS application;
SQL
  eval "causal_pid_$attempt=$!"
done
wait "$causal_pid_1"
wait "$causal_pid_2"
sort "$TMP_ROOT/causal-concurrent-1.out" "$TMP_ROOT/causal-concurrent-2.out" \
  >"$TMP_ROOT/causal-concurrent-sorted.out"
printf 'false\ntrue\n' >"$TMP_ROOT/causal-concurrent-expected.out"
cmp "$TMP_ROOT/causal-concurrent-expected.out" \
  "$TMP_ROOT/causal-concurrent-sorted.out"
assert_scalar '1|dislike|0|1' \
  "SELECT count(*) || '|' || min(reaction_type) || '|' ||
          (SELECT like_count FROM public.comments WHERE id = '$COMMENT_ONE') || '|' ||
          (SELECT dislike_count FROM public.comments WHERE id = '$COMMENT_ONE')
     FROM public.comment_likes
    WHERE comment_id = '$COMMENT_ONE' AND user_id = '$ACTOR_ONE'"

# old_success_replay_is_not_current: after a newer ticket is reserved, the old
# successful operation is terminally stale and cannot return historical truth.
assert_service 'issued|4' \
  "SELECT (result->>'status') || '|' || (result->>'intent_sequence')
     FROM (SELECT public.reserve_comment_reaction_intent_atomic(
       '$ACTOR_ONE', '$POST_ONE', '$COMMENT_ONE', '$REQUEST_D', 'like'
     ) AS result) AS reservation"
assert_service 'changed|like|false|4|9' \
  "SELECT (result->>'action') || '|' || (result->>'reaction') || '|' ||
          (result->>'replayed') || '|' || (result->>'intent_sequence') || '|' ||
          (SELECT count(*) FROM pg_catalog.jsonb_object_keys(result))
     FROM (SELECT public.set_comment_reaction_desired_state_causal_atomic(
       '$ACTOR_ONE', '$POST_ONE', '$COMMENT_ONE', '$REQUEST_D', 4, 'like'
     ) AS result) AS application"
assert_service 'stale|1' \
  "SELECT (result->>'status') || '|' ||
          (SELECT count(*) FROM pg_catalog.jsonb_object_keys(result))
     FROM (SELECT public.set_comment_reaction_desired_state_causal_atomic(
       '$ACTOR_ONE', '$POST_ONE', '$COMMENT_ONE', '$REQUEST_C', 3, 'dislike'
     ) AS result) AS application"

# expired_ticket_rejected: expiry is server-owned and checked before any
# source mutation. The terminal marker remains replayable until retention.
assert_service 'issued|5' \
  "SELECT (result->>'status') || '|' || (result->>'intent_sequence')
     FROM (SELECT public.reserve_comment_reaction_intent_atomic(
       '$ACTOR_ONE', '$POST_ONE', '$COMMENT_ONE', '$REQUEST_E', NULL
     ) AS result) AS reservation"
psql_cmd -c \
  "UPDATE public.comment_reaction_intent_operations
      SET issued_at = pg_catalog.statement_timestamp() - interval '2 hours',
          expires_at = pg_catalog.statement_timestamp() - interval '1 hour',
          retain_until = pg_catalog.statement_timestamp() + interval '1 hour'
    WHERE actor_id = '$ACTOR_ONE' AND request_id = '$REQUEST_E'"
assert_service 'expired' \
  "SELECT result->>'status'
     FROM (SELECT public.set_comment_reaction_desired_state_causal_atomic(
       '$ACTOR_ONE', '$POST_ONE', '$COMMENT_ONE', '$REQUEST_E', 5, NULL
     ) AS result) AS application"
assert_scalar 'like|1|0' \
  "SELECT reaction_type || '|' ||
          (SELECT like_count FROM public.comments WHERE id = '$COMMENT_ONE') || '|' ||
          (SELECT dislike_count FROM public.comments WHERE id = '$COMMENT_ONE')
     FROM public.comment_likes
    WHERE comment_id = '$COMMENT_ONE' AND user_id = '$ACTOR_ONE'"

# bounded_cleanup: only retention-expired operation rows are removed. A head
# with no operation and no source is then reclaimed after its inactivity TTL.
assert_service 'issued|1' \
  "SELECT (result->>'status') || '|' || (result->>'intent_sequence')
     FROM (SELECT public.reserve_comment_reaction_intent_atomic(
       '$ACTOR_TWO', '$POST_ONE', '$COMMENT_ONE', '$REQUEST_F', NULL
     ) AS result) AS reservation"
psql_cmd -c \
  "UPDATE public.comment_reaction_intent_operations
      SET state = 'expired',
          issued_at = pg_catalog.statement_timestamp() - interval '10 days',
          expires_at = pg_catalog.statement_timestamp() - interval '9 days',
          retain_until = pg_catalog.statement_timestamp() - interval '1 day',
          completed_at = pg_catalog.statement_timestamp() - interval '9 days'
    WHERE actor_id = '$ACTOR_TWO' AND request_id = '$REQUEST_F';
   UPDATE public.comment_reaction_intent_heads
      SET updated_at = pg_catalog.statement_timestamp() - interval '31 days'
    WHERE actor_id = '$ACTOR_TWO' AND comment_id = '$COMMENT_ONE'"
assert_service 'ok|1|0' \
  "SELECT (result->>'status') || '|' ||
          (result->>'operations_deleted') || '|' ||
          (result->>'heads_deleted')
     FROM (SELECT public.cleanup_comment_reaction_intents_atomic(100)
       AS result) AS cleanup"
assert_service 'ok|0|1' \
  "SELECT (result->>'status') || '|' ||
          (result->>'operations_deleted') || '|' ||
          (result->>'heads_deleted')
     FROM (SELECT public.cleanup_comment_reaction_intents_atomic(100)
       AS result) AS cleanup"

# account_comment_cascade: both parent lifecycles remove the head and its
# operation ledger without orphaning a private receipt.
assert_service 'issued' \
  "SELECT public.reserve_comment_reaction_intent_atomic(
    '$ACTOR_TWO', '$POST_ONE', '$COMMENT_ONE', '$REQUEST_F', NULL
  )->>'status'"
psql_cmd -c "DELETE FROM auth.users WHERE id = '$ACTOR_TWO'"
assert_scalar '0|0' \
  "SELECT
     (SELECT count(*) FROM public.comment_reaction_intent_heads
       WHERE actor_id = '$ACTOR_TWO') || '|' ||
     (SELECT count(*) FROM public.comment_reaction_intent_operations
       WHERE actor_id = '$ACTOR_TWO')"

psql_cmd <<'SQL'
INSERT INTO public.comments (id, post_id, user_id) VALUES (
  '30000000-0000-0000-0000-000000000006',
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000003'
);
SQL
assert_service 'issued' \
  "SELECT public.reserve_comment_reaction_intent_atomic(
    '$ACTOR_ONE', '$POST_ONE',
    '30000000-0000-0000-0000-000000000006', '$REQUEST_F', NULL
  )->>'status'"
psql_cmd -c \
  "DELETE FROM public.comments
    WHERE id = '30000000-0000-0000-0000-000000000006'"
assert_scalar '0|0' \
  "SELECT
     (SELECT count(*) FROM public.comment_reaction_intent_heads
       WHERE comment_id = '30000000-0000-0000-0000-000000000006') || '|' ||
     (SELECT count(*) FROM public.comment_reaction_intent_operations
       WHERE comment_id = '30000000-0000-0000-0000-000000000006')"

# cleanup_apply_lock_order: apply reads the immutable operation without a row
# lock, then waits on the canonical comment parent. Cleanup may delete an
# already retention-expired operation and commit; apply revalidates after the
# parent lock and fails unknown_ticket without a comment<->operation deadlock.
psql_cmd <<'SQL'
INSERT INTO public.comments (id, post_id, user_id) VALUES (
  '30000000-0000-0000-0000-000000000007',
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000003'
);
SQL
assert_service 'issued|1' \
  "SELECT (result->>'status') || '|' || (result->>'intent_sequence')
     FROM (SELECT public.reserve_comment_reaction_intent_atomic(
       '$ACTOR_ONE', '$POST_ONE',
       '30000000-0000-0000-0000-000000000007',
       '11111111111111111111111111111111', 'like'
     ) AS result) AS reservation"
psql_cmd -c \
  "UPDATE public.comment_reaction_intent_operations
      SET state = 'expired',
          issued_at = pg_catalog.statement_timestamp() - interval '10 days',
          expires_at = pg_catalog.statement_timestamp() - interval '9 days',
          retain_until = pg_catalog.statement_timestamp() - interval '1 day',
          completed_at = pg_catalog.statement_timestamp() - interval '9 days'
    WHERE actor_id = '$ACTOR_ONE'
      AND request_id = '11111111111111111111111111111111'"
psql_cmd >"$TMP_ROOT/cleanup-apply-holder.out" 2>&1 <<'SQL' &
BEGIN;
SET application_name = 'causal_cleanup_apply_comment_holder';
SELECT id
FROM public.comments
WHERE id = '30000000-0000-0000-0000-000000000007'
FOR UPDATE;
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
cleanup_holder_pid=$!
wait_for_activity \
  "application_name = 'causal_cleanup_apply_comment_holder' AND state = 'active' AND query LIKE '%pg_sleep%'" \
  1 \
  causal_cleanup_apply_comment_holder
psql_cmd -At >"$TMP_ROOT/cleanup-apply.out" 2>&1 <<SQL &
SET application_name = 'causal_cleanup_apply_waiter';
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT result->>'status'
FROM (SELECT public.set_comment_reaction_desired_state_causal_atomic(
  '$ACTOR_ONE', '$POST_ONE',
  '30000000-0000-0000-0000-000000000007',
  '11111111111111111111111111111111', 1, 'like'
) AS result) AS application;
SQL
cleanup_apply_pid=$!
wait_for_activity \
  "application_name = 'causal_cleanup_apply_waiter' AND wait_event_type = 'Lock'" \
  1 \
  causal_cleanup_apply_waiter
assert_service 'ok|1' \
  "SELECT (result->>'status') || '|' || (result->>'operations_deleted')
     FROM (SELECT public.cleanup_comment_reaction_intents_atomic(100)
       AS result) AS cleanup"
wait "$cleanup_holder_pid"
wait "$cleanup_apply_pid"
if [[ "$(tr -d '[:space:]' <"$TMP_ROOT/cleanup-apply.out")" != 'unknown_ticket' ]]; then
  echo 'cleanup_apply_lock_order returned an unexpected result' >&2
  cat "$TMP_ROOT/cleanup-apply.out" >&2
  exit 1
fi

# existing_table_shape_drift: replay cannot silently accept an IF NOT EXISTS
# table with extra columns, constraints or indexes.
psql_cmd -c \
  'ALTER TABLE public.comment_reaction_intent_heads ADD COLUMN drift text'
if psql_cmd -f "$CAUSAL_MIGRATION" \
  >"$TMP_ROOT/causal-table-shape-drift.out" 2>&1; then
  echo 'existing_table_shape_drift unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'comment reaction causal-intent columns drifted' \
  "$TMP_ROOT/causal-table-shape-drift.out"
psql_cmd -c \
  'ALTER TABLE public.comment_reaction_intent_heads DROP COLUMN drift'

# composed_source_seal_drift: a comment that no longer seals the exact 1070
# executable body closes 1080 publication before any table/function rewrite.
psql_cmd -c \
  "COMMENT ON FUNCTION public.set_comment_reaction_desired_state_atomic(
     uuid, uuid, uuid, text
   ) IS 'drifted'"
if psql_cmd -f "$CAUSAL_MIGRATION" \
  >"$TMP_ROOT/causal-source-seal-drift.out" 2>&1; then
  echo 'composed_source_seal_drift unexpectedly succeeded' >&2
  exit 1
fi
grep -q '1070 desired-state composed authority metadata, source seal, overload, or ACL drifted' \
  "$TMP_ROOT/causal-source-seal-drift.out"
psql_cmd <<'SQL'
DO $restore_source_seal$
DECLARE
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)'::regprocedure;
  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text) IS %L',
    'comment-reaction-desired-state:v1:' || pg_catalog.md5(v_source)
  );
END
$restore_source_seal$;
SQL

# causal_function_seal_drift: exact-signature residue is not silently replaced
# unless its stored comment still seals its executable body.
psql_cmd -c \
  "COMMENT ON FUNCTION public.reserve_comment_reaction_intent_atomic(
     uuid, uuid, uuid, text, text
   ) IS 'drifted'"
if psql_cmd -f "$CAUSAL_MIGRATION" \
  >"$TMP_ROOT/causal-function-seal-drift.out" 2>&1; then
  echo 'causal_function_seal_drift unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'existing comment reaction causal-intent function source seal drifted' \
  "$TMP_ROOT/causal-function-seal-drift.out"
psql_cmd <<'SQL'
DO $restore_causal_seal$
DECLARE
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text)'::regprocedure;
  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text) IS %L',
    'comment-reaction-causal-intent:reserve-v1:' || pg_catalog.md5(v_source)
  );
END
$restore_causal_seal$;
SQL
psql_cmd -f "$CAUSAL_MIGRATION"

echo 'comment reaction causal-intent PG17 proof passed'
