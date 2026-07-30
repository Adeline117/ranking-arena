#!/usr/bin/env bash

# Sourced by the isolated conversation-page PG17 harness.

expect_failure "SET ROLE authenticated; SET request.jwt.claim.role='authenticated'; SELECT public.search_direct_message_conversation_atomic('e0000000-0000-4000-8000-000000000001','51111111-1111-4111-8111-111111111111','needle',NULL,NULL,NULL,NULL,20)"
expect_failure "SET ROLE rogue_role; SELECT public.search_direct_message_conversation_atomic('e0000000-0000-4000-8000-000000000001','51111111-1111-4111-8111-111111111111','needle',NULL,NULL,NULL,NULL,20)"

psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('51111111-1111-4111-8111-111111111111'),
  ('52222222-2222-4222-8222-222222222222'),
  ('53333333-3333-4333-8333-333333333333');
INSERT INTO public.user_profiles(id, handle) VALUES
  ('51111111-1111-4111-8111-111111111111','search-actor'),
  ('52222222-2222-4222-8222-222222222222','search-other'),
  ('53333333-3333-4333-8333-333333333333','search-outsider');
INSERT INTO public.conversations(id, user1_id, user2_id, created_at) VALUES (
  'e0000000-0000-4000-8000-000000000001',
  '51111111-1111-4111-8111-111111111111',
  '52222222-2222-4222-8222-222222222222',
  '2026-07-29T10:00:00Z'
);
INSERT INTO public.conversation_members(
  conversation_id, user_id, cleared_before
) VALUES (
  'e0000000-0000-4000-8000-000000000001',
  '51111111-1111-4111-8111-111111111111',
  '2026-07-29T10:00:30Z'
);
INSERT INTO public.direct_messages(
  id, conversation_id, sender_id, receiver_id, content, created_at, deleted_at
) VALUES
  ('f0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000001','52222222-2222-4222-8222-222222222222','51111111-1111-4111-8111-111111111111','cleared needle secret','2026-07-29T10:00:00Z',NULL),
  ('f0000000-0000-4000-8000-000000000101','e0000000-0000-4000-8000-000000000001','51111111-1111-4111-8111-111111111111','52222222-2222-4222-8222-222222222222','first live Needle','2026-07-29T10:01:00Z',NULL),
  ('f0000000-0000-4000-8000-000000000201','e0000000-0000-4000-8000-000000000001','52222222-2222-4222-8222-222222222222','51111111-1111-4111-8111-111111111111','tie needle one','2026-07-29T10:02:00Z',NULL),
  ('f0000000-0000-4000-8000-000000000202','e0000000-0000-4000-8000-000000000001','51111111-1111-4111-8111-111111111111','52222222-2222-4222-8222-222222222222','tie needle two','2026-07-29T10:02:00Z',NULL),
  ('f0000000-0000-4000-8000-000000000203','e0000000-0000-4000-8000-000000000001','52222222-2222-4222-8222-222222222222','51111111-1111-4111-8111-111111111111','tie needle three','2026-07-29T10:02:00Z',NULL),
  ('f0000000-0000-4000-8000-000000000301','e0000000-0000-4000-8000-000000000001','52222222-2222-4222-8222-222222222222','51111111-1111-4111-8111-111111111111','deleted needle secret','2026-07-29T10:03:00Z','2026-07-29T10:03:01Z'),
  ('f0000000-0000-4000-8000-000000000401','e0000000-0000-4000-8000-000000000001','52222222-2222-4222-8222-222222222222','51111111-1111-4111-8111-111111111111','literal 100%_match\path','2026-07-29T10:03:30Z',NULL);
SQL

assert_service_scalar 'INVALID' "SELECT public.search_direct_message_conversation_atomic('e0000000-0000-4000-8000-000000000001','51111111-1111-4111-8111-111111111111','needle','2026-07-29T10:02:00Z',NULL,NULL,NULL,2)->>'reason'"
assert_service_scalar 'INVALID' "SELECT public.search_direct_message_conversation_atomic('e0000000-0000-4000-8000-000000000001','51111111-1111-4111-8111-111111111111','needle',NULL,NULL,'2026-07-30T00:00:00Z','2026-07-29T00:00:00Z',2)->>'reason'"
assert_service_scalar 'NOT_FOUND' "SELECT public.search_direct_message_conversation_atomic('e0000000-0000-4000-8000-000000000001','53333333-3333-4333-8333-333333333333','needle',NULL,NULL,NULL,NULL,2)->>'reason'"

# Page one and two prove total tie ordering, cursor identity, no duplicates,
# case-insensitive matching, and clear/delete privacy.
assert_service_scalar '2|true|f0000000-0000-4000-8000-000000000203|f0000000-0000-4000-8000-000000000202|f0000000-0000-4000-8000-000000000202|needle' "SELECT jsonb_array_length(r->'messages') || '|' || (r->>'has_more') || '|' || (r#>>'{messages,0,id}') || '|' || (r#>>'{messages,1,id}') || '|' || (r#>>'{next_cursor,before_id}') || '|' || (r->>'query') FROM (SELECT public.search_direct_message_conversation_atomic('e0000000-0000-4000-8000-000000000001','51111111-1111-4111-8111-111111111111',' needle ',NULL,NULL,NULL,NULL,2) AS r) AS result"
assert_service_scalar '2|false|f0000000-0000-4000-8000-000000000201|f0000000-0000-4000-8000-000000000101|true' "SELECT jsonb_array_length(r->'messages') || '|' || (r->>'has_more') || '|' || (r#>>'{messages,0,id}') || '|' || (r#>>'{messages,1,id}') || '|' || ((r->'next_cursor') = 'null'::jsonb)::text FROM (SELECT public.search_direct_message_conversation_atomic('e0000000-0000-4000-8000-000000000001','51111111-1111-4111-8111-111111111111','needle','2026-07-29T10:02:00Z','f0000000-0000-4000-8000-000000000202',NULL,NULL,2) AS r) AS result"
assert_service_scalar '0' "WITH page_one AS (SELECT public.search_direct_message_conversation_atomic('e0000000-0000-4000-8000-000000000001','51111111-1111-4111-8111-111111111111','needle',NULL,NULL,NULL,NULL,2) AS r), page_two AS (SELECT public.search_direct_message_conversation_atomic('e0000000-0000-4000-8000-000000000001','51111111-1111-4111-8111-111111111111','needle','2026-07-29T10:02:00Z','f0000000-0000-4000-8000-000000000202',NULL,NULL,2) AS r) SELECT count(*) FROM (SELECT jsonb_array_elements(page_one.r->'messages')->>'id' AS id FROM page_one INTERSECT SELECT jsonb_array_elements(page_two.r->'messages')->>'id' AS id FROM page_two) AS duplicate" || { echo 'same-timestamp search pagination skipped or duplicated messages' >&2; exit 1; }
assert_service_scalar 'false|false' "SELECT (r::text LIKE '%cleared needle secret%')::text || '|' || (r::text LIKE '%deleted needle secret%')::text FROM (SELECT public.search_direct_message_conversation_atomic('e0000000-0000-4000-8000-000000000001','51111111-1111-4111-8111-111111111111','needle',NULL,NULL,NULL,NULL,50) AS r) AS result" || { echo 'cleared or deleted search history leaked' >&2; exit 1; }

# Wildcards and backslashes are literals, not caller-controlled LIKE syntax.
assert_service_scalar '1|literal 100%_match\path' "SELECT jsonb_array_length(r->'messages') || '|' || (r#>>'{messages,0,content}') FROM (SELECT public.search_direct_message_conversation_atomic('e0000000-0000-4000-8000-000000000001','51111111-1111-4111-8111-111111111111','100%_match\path',NULL,NULL,NULL,NULL,50) AS r) AS result" || { echo 'search LIKE metacharacters were not literal' >&2; exit 1; }

# Date range is inclusive and participates in the same snapshot.
assert_service_scalar '3' "SELECT jsonb_array_length(public.search_direct_message_conversation_atomic('e0000000-0000-4000-8000-000000000001','51111111-1111-4111-8111-111111111111','needle',NULL,NULL,'2026-07-29T10:02:00Z','2026-07-29T10:02:00Z',50)->'messages')"

# An uncommitted send never crosses the snapshot, then appears after commit.
psql_cmd >"$TMP_ROOT/search-send-owner.out" 2>&1 <<'SQL' &
BEGIN;
INSERT INTO public.direct_messages(
  id, conversation_id, sender_id, receiver_id, content, created_at
) VALUES (
  'f0000000-0000-4000-8000-000000000501',
  'e0000000-0000-4000-8000-000000000001',
  '52222222-2222-4222-8222-222222222222',
  '51111111-1111-4111-8111-111111111111',
  'uncommitted needle', '2026-07-29T10:04:00Z'
);
SELECT pg_catalog.pg_sleep(1) /* dm_search_send_hold */;
COMMIT;
SQL
search_send_pid=$!
wait_for_query 'dm_search_send_hold'
assert_service_scalar 'false' "SELECT (r::text LIKE '%uncommitted needle%')::text FROM (SELECT public.search_direct_message_conversation_atomic('e0000000-0000-4000-8000-000000000001','51111111-1111-4111-8111-111111111111','needle',NULL,NULL,NULL,NULL,50) AS r) AS result" || { echo 'uncommitted send crossed search snapshot' >&2; exit 1; }
wait "$search_send_pid"
assert_service_scalar 'true' "SELECT (r::text LIKE '%uncommitted needle%')::text FROM (SELECT public.search_direct_message_conversation_atomic('e0000000-0000-4000-8000-000000000001','51111111-1111-4111-8111-111111111111','needle',NULL,NULL,NULL,NULL,50) AS r) AS result"

# An uncommitted clear is wholly before the snapshot; after commit it removes
# every result at or below its database boundary.
psql_cmd >"$TMP_ROOT/search-clear-owner.out" 2>&1 <<'SQL' &
BEGIN;
UPDATE public.conversation_members
SET cleared_before = '2026-07-29T10:03:00Z'
WHERE conversation_id = 'e0000000-0000-4000-8000-000000000001'
  AND user_id = '51111111-1111-4111-8111-111111111111';
SELECT pg_catalog.pg_sleep(1) /* dm_search_clear_hold */;
COMMIT;
SQL
search_clear_pid=$!
wait_for_query 'dm_search_clear_hold'
assert_service_scalar '5' "SELECT jsonb_array_length(public.search_direct_message_conversation_atomic('e0000000-0000-4000-8000-000000000001','51111111-1111-4111-8111-111111111111','needle',NULL,NULL,NULL,NULL,50)->'messages')" || { echo 'uncommitted clear crossed search snapshot' >&2; exit 1; }
wait "$search_clear_pid"
assert_service_scalar '1|f0000000-0000-4000-8000-000000000501' "SELECT jsonb_array_length(r->'messages') || '|' || (r#>>'{messages,0,id}') FROM (SELECT public.search_direct_message_conversation_atomic('e0000000-0000-4000-8000-000000000001','51111111-1111-4111-8111-111111111111','needle',NULL,NULL,NULL,NULL,50) AS r) AS result"

# Actor lifecycle decisions serialize before search admission.
psql_cmd >"$TMP_ROOT/search-lifecycle-owner.out" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:51111111-1111-4111-8111-111111111111',
    0
  )
);
UPDATE public.user_profiles
SET deleted_at = '2026-07-29T11:00:00Z'
WHERE id = '51111111-1111-4111-8111-111111111111';
SELECT pg_catalog.pg_sleep(1) /* dm_search_lifecycle_hold */;
COMMIT;
SQL
search_lifecycle_pid=$!
wait_for_query 'dm_search_lifecycle_hold'
assert_service_scalar 'ACTOR_UNAVAILABLE' "SELECT public.search_direct_message_conversation_atomic('e0000000-0000-4000-8000-000000000001','51111111-1111-4111-8111-111111111111','needle',NULL,NULL,NULL,NULL,50)->>'reason'" || { echo 'actor lifecycle admission failed to serialize search' >&2; exit 1; }
wait "$search_lifecycle_pid"

echo 'atomic direct-message search PostgreSQL 17 checks passed'
