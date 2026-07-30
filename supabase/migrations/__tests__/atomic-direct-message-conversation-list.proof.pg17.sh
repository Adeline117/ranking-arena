#!/usr/bin/env bash

# Sourced by atomic-direct-message-conversation-page.pg17.sh after its own
# checks. Helper functions, TMP_ROOT, and the isolated PG17 cluster are owned by
# that harness.

expect_failure "SET ROLE authenticated; SET request.jwt.claim.role='authenticated'; SELECT public.get_direct_message_conversation_list_atomic('41111111-1111-4111-8111-111111111111',50)"
expect_failure "SET ROLE rogue_role; SELECT public.get_direct_message_conversation_list_atomic('41111111-1111-4111-8111-111111111111',50)"

psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('41111111-1111-4111-8111-111111111111'),
  ('42222222-2222-4222-8222-222222222222'),
  ('43333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444'),
  ('45555555-5555-4555-8555-555555555555');

INSERT INTO public.user_profiles(id, handle, avatar_url, bio) VALUES
  ('41111111-1111-4111-8111-111111111111','list-actor','https://img/list-actor','actor'),
  ('42222222-2222-4222-8222-222222222222','cleared-peer',NULL,NULL),
  ('43333333-3333-4333-8333-333333333333','pinned-peer',NULL,'pinned'),
  ('44444444-4444-4444-8444-444444444444','latest-peer',NULL,'latest'),
  ('45555555-5555-4555-8555-555555555555','race-peer',NULL,'race');

INSERT INTO public.conversations(id, user1_id, user2_id, created_at) VALUES
  ('c0000000-0000-4000-8000-000000000001','41111111-1111-4111-8111-111111111111','42222222-2222-4222-8222-222222222222','2026-07-29T12:00:00Z'),
  ('c0000000-0000-4000-8000-000000000002','41111111-1111-4111-8111-111111111111','43333333-3333-4333-8333-333333333333','2026-07-29T12:00:00Z'),
  ('c0000000-0000-4000-8000-000000000003','41111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444','2026-07-29T12:00:00Z'),
  ('c0000000-0000-4000-8000-000000000004','41111111-1111-4111-8111-111111111111','45555555-5555-4555-8555-555555555555','2026-07-29T12:00:00Z');

INSERT INTO public.conversation_members(
  conversation_id, user_id, remark, is_muted, is_pinned, is_blocked,
  cleared_before
) VALUES
  ('c0000000-0000-4000-8000-000000000001','41111111-1111-4111-8111-111111111111',NULL,false,false,false,'2026-07-29T12:05:00Z'),
  ('c0000000-0000-4000-8000-000000000002','41111111-1111-4111-8111-111111111111','VIP',true,true,false,NULL),
  ('c0000000-0000-4000-8000-000000000003','41111111-1111-4111-8111-111111111111',NULL,false,false,false,NULL),
  ('c0000000-0000-4000-8000-000000000004','41111111-1111-4111-8111-111111111111',NULL,false,false,false,NULL);

INSERT INTO public.direct_messages(
  id, conversation_id, sender_id, receiver_id, content, read, created_at,
  deleted_at
) VALUES
  ('d0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001','42222222-2222-4222-8222-222222222222','41111111-1111-4111-8111-111111111111','must stay cleared',false,'2026-07-29T12:01:00Z',NULL),
  ('d0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000002','43333333-3333-4333-8333-333333333333','41111111-1111-4111-8111-111111111111','pinned preview',false,'2026-07-29T12:01:00Z',NULL),
  ('d0000000-0000-4000-8000-000000000003','c0000000-0000-4000-8000-000000000003','44444444-4444-4444-8444-444444444444','41111111-1111-4111-8111-111111111111','live preview',false,'2026-07-29T12:04:00Z',NULL),
  ('d0000000-0000-4000-8000-000000000004','c0000000-0000-4000-8000-000000000003','44444444-4444-4444-8444-444444444444','41111111-1111-4111-8111-111111111111','deleted secret',false,'2026-07-29T12:06:00Z','2026-07-29T12:06:01Z'),
  ('d0000000-0000-4000-8000-000000000005','c0000000-0000-4000-8000-000000000004','45555555-5555-4555-8555-555555555555','41111111-1111-4111-8111-111111111111','race baseline',true,'2026-07-29T12:02:00Z',NULL);
SQL

assert_service_scalar 'INVALID' "SELECT public.get_direct_message_conversation_list_atomic('41111111-1111-4111-8111-111111111111',0)->>'reason'"
assert_service_scalar 'ACTOR_UNAVAILABLE' "SELECT public.get_direct_message_conversation_list_atomic('49999999-9999-4999-8999-999999999999',50)->>'reason'"

# A cleared conversation is absent, pinning precedes recency before LIMIT, and
# deleted rows affect neither preview nor unread evidence.
assert_service_scalar '2|c0000000-0000-4000-8000-000000000002|c0000000-0000-4000-8000-000000000003|pinned preview|live preview|1|VIP|true' "SELECT jsonb_array_length(r->'conversations') || '|' || (r#>>'{conversations,0,id}') || '|' || (r#>>'{conversations,1,id}') || '|' || (r#>>'{conversations,0,last_message_preview}') || '|' || (r#>>'{conversations,1,last_message_preview}') || '|' || (r#>>'{conversations,1,unread_count}') || '|' || (r#>>'{conversations,0,member_settings,remark}') || '|' || (r#>>'{conversations,0,member_settings,is_muted}') FROM (SELECT public.get_direct_message_conversation_list_atomic('41111111-1111-4111-8111-111111111111',2) AS r) AS result" || { echo 'pin ordering or page limit drifted' >&2; exit 1; }
assert_service_scalar 'false' "SELECT (r->'conversations' @> '[{\"id\":\"c0000000-0000-4000-8000-000000000001\"}]'::jsonb)::text FROM (SELECT public.get_direct_message_conversation_list_atomic('41111111-1111-4111-8111-111111111111',50) AS r) AS result" || { echo 'cleared conversation reappeared before a new live message' >&2; exit 1; }
assert_service_scalar 'false' "SELECT (r::text LIKE '%deleted secret%')::text FROM (SELECT public.get_direct_message_conversation_list_atomic('41111111-1111-4111-8111-111111111111',50) AS r) AS result" || { echo 'deleted message leaked into inbox preview' >&2; exit 1; }

# A newer live message makes a previously cleared relationship visible again.
psql_cmd -qc "INSERT INTO public.direct_messages(id,conversation_id,sender_id,receiver_id,content,read,created_at) VALUES ('d0000000-0000-4000-8000-000000000006','c0000000-0000-4000-8000-000000000001','42222222-2222-4222-8222-222222222222','41111111-1111-4111-8111-111111111111','after clear',false,'2026-07-29T12:07:00Z')"
assert_service_scalar 'after clear|1' "SELECT (item->>'last_message_preview') || '|' || (item->>'unread_count') FROM (SELECT jsonb_array_elements(public.get_direct_message_conversation_list_atomic('41111111-1111-4111-8111-111111111111',50)->'conversations') AS item) AS rows WHERE item->>'id'='c0000000-0000-4000-8000-000000000001'"

# An uncommitted message is not partially observed and does not block the
# statement-snapshot reader; after commit, preview and unread advance together.
psql_cmd >"$TMP_ROOT/list-send-owner.out" 2>&1 <<'SQL' &
BEGIN;
INSERT INTO public.direct_messages(
  id, conversation_id, sender_id, receiver_id, content, read, created_at
) VALUES (
  'd0000000-0000-4000-8000-000000000007',
  'c0000000-0000-4000-8000-000000000004',
  '45555555-5555-4555-8555-555555555555',
  '41111111-1111-4111-8111-111111111111',
  'committed send', false, '2026-07-29T13:00:00Z'
);
SELECT pg_catalog.pg_sleep(1) /* dm_list_send_hold */;
COMMIT;
SQL
list_send_pid=$!
wait_for_query 'dm_list_send_hold'
assert_service_scalar 'race baseline|0' "SELECT (item->>'last_message_preview') || '|' || (item->>'unread_count') FROM (SELECT jsonb_array_elements(public.get_direct_message_conversation_list_atomic('41111111-1111-4111-8111-111111111111',50)->'conversations') AS item) AS rows WHERE item->>'id'='c0000000-0000-4000-8000-000000000004'" || { echo 'uncommitted send crossed the conversation-list snapshot' >&2; exit 1; }
wait "$list_send_pid"
assert_service_scalar 'committed send|1' "SELECT (item->>'last_message_preview') || '|' || (item->>'unread_count') FROM (SELECT jsonb_array_elements(public.get_direct_message_conversation_list_atomic('41111111-1111-4111-8111-111111111111',50)->'conversations') AS item) AS rows WHERE item->>'id'='c0000000-0000-4000-8000-000000000004'"

# An uncommitted clear is likewise observed wholly before; after commit the
# conversation disappears because every live message is below the boundary.
psql_cmd >"$TMP_ROOT/list-clear-owner.out" 2>&1 <<'SQL' &
BEGIN;
UPDATE public.conversation_members
SET cleared_before = '2026-07-29T14:00:00Z'
WHERE conversation_id = 'c0000000-0000-4000-8000-000000000003'
  AND user_id = '41111111-1111-4111-8111-111111111111';
SELECT pg_catalog.pg_sleep(1) /* dm_list_clear_hold */;
COMMIT;
SQL
list_clear_pid=$!
wait_for_query 'dm_list_clear_hold'
assert_service_scalar 'true' "SELECT (r->'conversations' @> '[{\"id\":\"c0000000-0000-4000-8000-000000000003\"}]'::jsonb)::text FROM (SELECT public.get_direct_message_conversation_list_atomic('41111111-1111-4111-8111-111111111111',50) AS r) AS result" || { echo 'uncommitted clear crossed the conversation-list snapshot' >&2; exit 1; }
wait "$list_clear_pid"
assert_service_scalar 'false' "SELECT (r->'conversations' @> '[{\"id\":\"c0000000-0000-4000-8000-000000000003\"}]'::jsonb)::text FROM (SELECT public.get_direct_message_conversation_list_atomic('41111111-1111-4111-8111-111111111111',50) AS r) AS result"

# Actor deactivation owns the same lifecycle key. The list waits for that
# decision and then fails closed instead of returning post-deactivation data.
psql_cmd >"$TMP_ROOT/list-lifecycle-owner.out" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:41111111-1111-4111-8111-111111111111',
    0
  )
);
UPDATE public.user_profiles
SET deleted_at = '2026-07-29T15:00:00Z'
WHERE id = '41111111-1111-4111-8111-111111111111';
SELECT pg_catalog.pg_sleep(1) /* dm_list_lifecycle_hold */;
COMMIT;
SQL
list_lifecycle_pid=$!
wait_for_query 'dm_list_lifecycle_hold'
assert_service_scalar 'ACTOR_UNAVAILABLE' "SELECT public.get_direct_message_conversation_list_atomic('41111111-1111-4111-8111-111111111111',50)->>'reason'" || { echo 'actor lifecycle admission failed to serialize' >&2; exit 1; }
wait "$list_lifecycle_pid"

echo 'atomic direct-message conversation-list PostgreSQL 17 checks passed'
