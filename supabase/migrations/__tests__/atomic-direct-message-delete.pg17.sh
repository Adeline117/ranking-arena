#!/usr/bin/env bash

# PostgreSQL 17 executable proof for the atomic direct-message delete boundary.
# It sources the real 114000 test fixture in fixture-only mode, owns the same
# isolated temporary cluster, and never connects to an application database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SEND_FIXTURE="$ROOT_DIR/supabase/migrations/__tests__/atomic-direct-message-send.pg17.sh"
DELETE_MIGRATION="$ROOT_DIR/supabase/migrations/20260716114200_atomic_direct_message_delete.sql"

export ATOMIC_DM_SEND_FIXTURE_ONLY=1
# shellcheck source=./atomic-direct-message-send.pg17.sh
source "$SEND_FIXTURE"
unset ATOMIC_DM_SEND_FIXTURE_ONLY

# The sourced fixture has applied the real 112100-compatible permission
# function and the complete 114000 migration to its private PostgreSQL 17
# cluster. Seed deliberate summary drift before 114200 calibration.
psql_cmd <<'SQL'
INSERT INTO public.user_profiles(
  id, dm_permission, handle, notify_message, deleted_at, banned_at
) VALUES
  ('11111111-1111-4111-8111-111111111111', 'all', 'one', false, NULL, NULL),
  ('22222222-2222-4222-8222-222222222222', 'all', 'two', false, NULL, NULL),
  ('33333333-3333-4333-8333-333333333333', 'all', 'three', false, NULL, NULL),
  ('44444444-4444-4444-8444-444444444444', 'all', 'four', false, NULL, NULL),
  ('55555555-5555-4555-8555-555555555555', 'all', 'five', false, NULL, NULL),
  ('66666666-6666-4666-8666-666666666666', 'all', 'six', false, NULL, NULL),
  ('77777777-7777-4777-8777-777777777777', 'all', 'seven', false, NULL, NULL),
  ('88888888-8888-4888-8888-888888888888', 'all', 'eight', false, NULL, NULL),
  ('99999999-9999-4999-8999-999999999999', 'all', 'nine', false, NULL, NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'all', 'ten', false, NULL, NULL),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'all', 'eleven', false, NULL, NULL),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'all', 'twelve', false, NULL, NULL),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'all', 'thirteen', false, NULL, NULL),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'all', 'fourteen', false, NULL, NULL),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'all', 'fifteen', false, NULL, NULL),
  ('ffffffff-ffff-4fff-9fff-ffffffffffff', 'all', 'sixteen', false, NULL, NULL),
  ('12121212-1212-4212-8212-121212121212', 'all', 'seventeen', false, NULL, NULL),
  ('23232323-2323-4232-8232-232323232323', 'all', 'eighteen', false, NULL, NULL),
  ('34343434-3434-4434-8434-343434343434', 'all', 'nineteen', false, NULL, NULL),
  ('45454545-4545-4454-8454-454545454545', 'all', 'twenty', false, NULL, NULL);

INSERT INTO public.conversations(
  id, user1_id, user2_id, created_at, last_message_at, last_message_preview
) VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '2024-01-01 00:00:00+00',
    '2030-01-01 00:00:00+00',
    'stale secret'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
    '2024-02-01 00:00:00+00',
    '2030-02-01 00:00:00+00',
    'empty leak'
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    '55555555-5555-4555-8555-555555555555',
    '66666666-6666-4666-8666-666666666666',
    NULL,
    '2030-03-01 00:00:00+00',
    'legacy empty leak'
  ),
  (
    '10000000-0000-4000-8000-000000000004',
    '77777777-7777-4777-8777-777777777777',
    '88888888-8888-4888-8888-888888888888',
    '2024-04-01 00:00:00+00',
    NULL,
    NULL
  ),
  (
    '10000000-0000-4000-8000-000000000005',
    '99999999-9999-4999-8999-999999999999',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '2024-05-01 00:00:00+00',
    NULL,
    NULL
  ),
  (
    '10000000-0000-4000-8000-000000000006',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '2024-06-01 00:00:00+00',
    NULL,
    NULL
  ),
  (
    '10000000-0000-4000-8000-000000000007',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    '2024-07-01 00:00:00+00',
    NULL,
    NULL
  ),
  (
    '10000000-0000-4000-8000-000000000008',
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'ffffffff-ffff-4fff-9fff-ffffffffffff',
    '2024-08-01 00:00:00+00',
    NULL,
    NULL
  ),
  (
    '10000000-0000-4000-8000-000000000009',
    '12121212-1212-4212-8212-121212121212',
    '23232323-2323-4232-8232-232323232323',
    '2024-09-01 00:00:00+00',
    NULL,
    NULL
  ),
  (
    '10000000-0000-4000-8000-000000000010',
    '34343434-3434-4434-8434-343434343434',
    '45454545-4545-4454-8454-454545454545',
    '2024-10-01 00:00:00+00',
    NULL,
    NULL
  );

-- Insert newest first and an older row last, then a deleted secret last. The
-- old INSERT trigger leaves the preview wrong; 114200 must derive it anew.
INSERT INTO public.direct_messages(
  id, conversation_id, sender_id, receiver_id, content, created_at
) VALUES
  (
    '20000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'last live',
    '2024-01-04 00:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'middle live',
    '2024-01-03 00:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'first live',
    '2024-01-02 00:00:00+00'
  );
INSERT INTO public.direct_messages(
  id, conversation_id, sender_id, receiver_id, content, created_at, deleted_at
) VALUES (
  '20000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'deleted newest secret',
  '2024-01-05 00:00:00+00',
  '2024-01-06 00:00:00+00'
);

INSERT INTO public.direct_messages(
  id, conversation_id, sender_id, receiver_id, content, created_at
) VALUES
  (
    '20000000-0000-4000-8000-000000000041',
    '10000000-0000-4000-8000-000000000004',
    '77777777-7777-4777-8777-777777777777',
    '88888888-8888-4888-8888-888888888888',
    'hard delete older',
    '2024-04-02 00:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000042',
    '10000000-0000-4000-8000-000000000004',
    '77777777-7777-4777-8777-777777777777',
    '88888888-8888-4888-8888-888888888888',
    'hard delete newest',
    '2024-04-03 00:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000051',
    '10000000-0000-4000-8000-000000000005',
    '99999999-9999-4999-8999-999999999999',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'rollback me',
    '2024-05-02 00:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000061',
    '10000000-0000-4000-8000-000000000006',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'old before concurrent send',
    '2024-06-02 00:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000071',
    '10000000-0000-4000-8000-000000000007',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'concurrent delete only message',
    '2024-07-02 00:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000081',
    '10000000-0000-4000-8000-000000000008',
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'ffffffff-ffff-4fff-9fff-ffffffffffff',
    'pair integrity probe',
    '2024-08-02 00:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000091',
    '10000000-0000-4000-8000-000000000009',
    '12121212-1212-4212-8212-121212121212',
    '23232323-2323-4232-8232-232323232323',
    'cascade versus delete',
    '2024-09-02 00:00:00+00'
  ),
  (
    '20000000-0000-4000-8000-000000000101',
    '10000000-0000-4000-8000-000000000010',
    '34343434-3434-4434-8434-343434343434',
    '45454545-4545-4454-8454-454545454545',
    'cascade versus send',
    '2024-10-02 00:00:00+00'
  );

-- Seed both self-FK cases before the immutable guard exists. The migration
-- must reject direct reply rewrites while preserving ON DELETE SET NULL for a
-- hard-deleted quoted message and ON DELETE CASCADE for a whole conversation.
UPDATE public.direct_messages
SET reply_to_id = '20000000-0000-4000-8000-000000000042'
WHERE id = '20000000-0000-4000-8000-000000000041';

INSERT INTO public.direct_messages(
  id,
  conversation_id,
  sender_id,
  receiver_id,
  content,
  created_at,
  reply_to_id
) VALUES (
  '20000000-0000-4000-8000-000000000082',
  '10000000-0000-4000-8000-000000000008',
  'ffffffff-ffff-4fff-9fff-ffffffffffff',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  'conversation cascade reply',
  '2024-08-03 00:00:00+00',
  '20000000-0000-4000-8000-000000000081'
);
SQL

psql_cmd -f "$DELETE_MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $calibration_and_catalog$
DECLARE
  v_delete_function regprocedure :=
    'public.delete_direct_message_atomic(uuid,uuid)'::regprocedure;
  v_immutable_guard_function regprocedure :=
    'public.guard_direct_message_immutable_fields()'::regprocedure;
BEGIN
  IF (
    SELECT conversation.last_message_preview
    FROM public.conversations AS conversation
    WHERE conversation.id = '10000000-0000-4000-8000-000000000001'
  ) <> 'last live' OR (
    SELECT conversation.last_message_at
    FROM public.conversations AS conversation
    WHERE conversation.id = '10000000-0000-4000-8000-000000000001'
  ) <> '2024-01-04 00:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'install did not remove deleted/backdated preview leakage';
  END IF;

  IF (
    SELECT conversation.last_message_preview IS NOT NULL
        OR conversation.last_message_at <>
          '2024-02-01 00:00:00+00'::timestamptz
    FROM public.conversations AS conversation
    WHERE conversation.id = '10000000-0000-4000-8000-000000000002'
  ) OR (
    SELECT conversation.last_message_preview IS NOT NULL
        OR conversation.last_message_at <>
          '1970-01-01 00:00:00+00'::timestamptz
    FROM public.conversations AS conversation
    WHERE conversation.id = '10000000-0000-4000-8000-000000000003'
  ) THEN
    RAISE EXCEPTION 'empty-thread safe timestamp calibration failed';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role', v_delete_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_delete_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_delete_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    'public.recalculate_direct_message_conversation_summary(uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role', v_immutable_guard_function, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'delete boundary function ACLs are wrong';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.direct_messages'::regclass
      AND attribute.attname = 'updated_at'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_immutable_guard_function
      AND function_row.proowner = 'postgres'::regrole
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'trigger'::regtype
      AND function_row.pronargs = 0
      AND function_row.pronargdefaults = 0
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.strpos(
        function_row.prosrc,
        'identity and payload are immutable after send'
      ) > 0
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'trg_guard_dm_immutable_fields'
      AND trigger_row.tgfoid = v_immutable_guard_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 19
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 0
  ) THEN
    RAISE EXCEPTION 'immutable direct-message guard catalog contract is wrong';
  END IF;
END
$calibration_and_catalog$;

-- Count conversation summary updates to prove an idempotent second delete
-- does not perform a duplicate recalculation.
CREATE TABLE public.dm_summary_update_audit (
  conversation_id uuid NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE FUNCTION public.audit_dm_summary_update()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO public.dm_summary_update_audit(conversation_id) VALUES (NEW.id);
  RETURN NEW;
END
$function$;
CREATE TRIGGER audit_dm_summary_update
AFTER UPDATE OF last_message_at, last_message_preview
ON public.conversations
FOR EACH ROW
EXECUTE FUNCTION public.audit_dm_summary_update();

SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

-- Every identity/payload field is immutable after send. Exercise each current
-- field independently and require the guard's exact failure, so an unrelated
-- constraint cannot make this proof pass accidentally. Read state remains
-- mutable and must not touch the conversation summary.
DO $immutable_field_proof$
DECLARE
  v_assignment text;
  v_error_message text;
  v_audit_before bigint;
BEGIN
  SELECT pg_catalog.count(*)
  INTO v_audit_before
  FROM public.dm_summary_update_audit;

  FOREACH v_assignment IN ARRAY ARRAY[
    $$id = '29999999-9999-4999-8999-999999999951'::uuid$$,
    $$conversation_id = '10000000-0000-4000-8000-000000000001'::uuid$$,
    $$sender_id = '11111111-1111-4111-8111-111111111111'::uuid$$,
    $$receiver_id = '22222222-2222-4222-8222-222222222222'::uuid$$,
    $$content = 'forged edit'$$,
    $$created_at = '2035-05-02 00:00:00+00'::timestamptz$$,
    $$media_url = 'https://example.test/forged'$$,
    $$media_type = 'file'$$,
    $$media_name = 'forged.txt'$$,
    $$reply_to_id = '20000000-0000-4000-8000-000000000001'::uuid$$
  ]::text[]
  LOOP
    BEGIN
      EXECUTE
        'UPDATE public.direct_messages SET ' || v_assignment
          || ' WHERE id = '
          || pg_catalog.quote_literal(
            '20000000-0000-4000-8000-000000000051'::uuid
          );
      RAISE EXCEPTION 'immutable mutation unexpectedly succeeded: %',
        v_assignment;
    EXCEPTION
      WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_error_message = MESSAGE_TEXT;
        IF v_error_message <>
          'direct-message identity and payload are immutable after send'
        THEN
          RAISE EXCEPTION
            'wrong rejection for immutable mutation %: %',
            v_assignment,
            v_error_message;
        END IF;
    END;
  END LOOP;

  BEGIN
    UPDATE public.direct_messages
    SET reply_to_id = NULL
    WHERE id = '20000000-0000-4000-8000-000000000041';
    RAISE EXCEPTION 'direct reply unlink unexpectedly succeeded';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_error_message = MESSAGE_TEXT;
      IF v_error_message <>
        'direct-message identity and payload are immutable after send'
      THEN
        RAISE EXCEPTION 'wrong direct reply-unlink rejection: %',
          v_error_message;
      END IF;
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM public.direct_messages AS message_row
    WHERE message_row.id = '20000000-0000-4000-8000-000000000051'
      AND message_row.conversation_id =
        '10000000-0000-4000-8000-000000000005'
      AND message_row.sender_id =
        '99999999-9999-4999-8999-999999999999'
      AND message_row.receiver_id =
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      AND message_row.content = 'rollback me'
      AND message_row.created_at = '2024-05-02 00:00:00+00'::timestamptz
      AND message_row.media_url IS NULL
      AND message_row.media_type IS NULL
      AND message_row.media_name IS NULL
      AND message_row.reply_to_id IS NULL
      AND message_row.read IS FALSE
      AND message_row.read_at IS NULL
      AND message_row.deleted_at IS NULL
  ) OR (
    SELECT conversation.last_message_preview
    FROM public.conversations AS conversation
    WHERE conversation.id = '10000000-0000-4000-8000-000000000005'
  ) <> 'rollback me' THEN
    RAISE EXCEPTION 'immutable-field rejection changed message or preview';
  END IF;

  UPDATE public.direct_messages
  SET read = true,
      read_at = '2026-07-16 12:00:00+00'::timestamptz
  WHERE id = '20000000-0000-4000-8000-000000000051';

  IF NOT EXISTS (
    SELECT 1
    FROM public.direct_messages AS message_row
    WHERE message_row.id = '20000000-0000-4000-8000-000000000051'
      AND message_row.read IS TRUE
      AND message_row.read_at = '2026-07-16 12:00:00+00'::timestamptz
  ) OR (
    SELECT pg_catalog.count(*)
    FROM public.dm_summary_update_audit
  ) <> v_audit_before THEN
    RAISE EXCEPTION 'allowed read-state update failed or touched summary';
  END IF;

  UPDATE public.direct_messages
  SET read = false,
      read_at = NULL
  WHERE id = '20000000-0000-4000-8000-000000000051';
END
$immutable_field_proof$;

DO $ownership_idempotency_and_order$
DECLARE
  v_result jsonb;
  v_audit_before bigint;
BEGIN
  v_result := public.delete_direct_message_atomic(
    '20000000-0000-4000-8000-000000000002',
    '22222222-2222-4222-8222-222222222222'
  );
  IF v_result ->> 'reason' <> 'FORBIDDEN' OR EXISTS (
    SELECT 1
    FROM public.direct_messages AS message_row
    WHERE message_row.id = '20000000-0000-4000-8000-000000000002'
      AND message_row.deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'nonowner delete did not fail without mutation: %', v_result;
  END IF;

  v_result := public.delete_direct_message_atomic(
    '29999999-9999-4999-8999-999999999999',
    '11111111-1111-4111-8111-111111111111'
  );
  IF v_result ->> 'reason' <> 'NOT_FOUND' THEN
    RAISE EXCEPTION 'missing message response is wrong: %', v_result;
  END IF;

  -- Deleting the middle message keeps the newest live preview.
  v_result := public.delete_direct_message_atomic(
    '20000000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111'
  );
  IF NOT (v_result ->> 'deleted')::boolean OR (
    SELECT conversation.last_message_preview
    FROM public.conversations AS conversation
    WHERE conversation.id = '10000000-0000-4000-8000-000000000001'
  ) <> 'last live' THEN
    RAISE EXCEPTION 'middle-message delete changed newest preview: %', v_result;
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_audit_before
  FROM public.dm_summary_update_audit AS audit
  WHERE audit.conversation_id = '10000000-0000-4000-8000-000000000001';

  v_result := public.delete_direct_message_atomic(
    '20000000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111'
  );
  IF NOT (v_result ->> 'success')::boolean
     OR (v_result ->> 'deleted')::boolean
     OR NOT (v_result ->> 'already_deleted')::boolean
     OR (
       SELECT pg_catalog.count(*)
       FROM public.dm_summary_update_audit AS audit
       WHERE audit.conversation_id = '10000000-0000-4000-8000-000000000001'
     ) <> v_audit_before
  THEN
    RAISE EXCEPTION 'already-deleted call was not idempotent: %', v_result;
  END IF;

  -- Deleting last then first falls back through history and finally to the
  -- conversation creation time with a cleared preview.
  PERFORM public.delete_direct_message_atomic(
    '20000000-0000-4000-8000-000000000003',
    '11111111-1111-4111-8111-111111111111'
  );
  IF (
    SELECT conversation.last_message_preview
    FROM public.conversations AS conversation
    WHERE conversation.id = '10000000-0000-4000-8000-000000000001'
  ) <> 'first live' THEN
    RAISE EXCEPTION 'last-message delete did not reveal prior live preview';
  END IF;

  PERFORM public.delete_direct_message_atomic(
    '20000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111'
  );
  IF (
    SELECT conversation.last_message_preview IS NOT NULL
        OR conversation.last_message_at <>
          '2024-01-01 00:00:00+00'::timestamptz
    FROM public.conversations AS conversation
    WHERE conversation.id = '10000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'empty thread retained deleted message metadata';
  END IF;
END
$ownership_idempotency_and_order$;

-- A trusted legacy hard delete and soft delete both pass through the same
-- canonical trigger path; neither may retain the removed content preview.
DELETE FROM public.direct_messages
WHERE id = '20000000-0000-4000-8000-000000000042';
DO $legacy_delete_proof$
BEGIN
  IF (
    SELECT conversation.last_message_preview
    FROM public.conversations AS conversation
    WHERE conversation.id = '10000000-0000-4000-8000-000000000004'
  ) <> 'hard delete older' OR (
    SELECT message_row.reply_to_id IS NOT NULL
    FROM public.direct_messages AS message_row
    WHERE message_row.id = '20000000-0000-4000-8000-000000000041'
  ) THEN
    RAISE EXCEPTION
      'legacy hard delete left its preview or blocked FK reply unlink';
  END IF;
END
$legacy_delete_proof$;

UPDATE public.direct_messages
SET deleted_at = pg_catalog.clock_timestamp()
WHERE id = '20000000-0000-4000-8000-000000000041';
DO $legacy_soft_delete_proof$
BEGIN
  IF (
    SELECT conversation.last_message_preview IS NOT NULL
        OR conversation.last_message_at <>
          '2024-04-01 00:00:00+00'::timestamptz
    FROM public.conversations AS conversation
    WHERE conversation.id = '10000000-0000-4000-8000-000000000004'
  ) THEN
    RAISE EXCEPTION 'legacy soft delete left the deleted preview';
  END IF;
END
$legacy_soft_delete_proof$;

DO $soft_delete_irreversibility_proof$
DECLARE
  v_error_message text;
BEGIN
  BEGIN
    UPDATE public.direct_messages
    SET deleted_at = NULL
    WHERE id = '20000000-0000-4000-8000-000000000041';
    RAISE EXCEPTION 'trusted writer resurrected a soft-deleted message';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS v_error_message = MESSAGE_TEXT;
      IF v_error_message <> 'direct-message soft deletion is irreversible' THEN
        RAISE EXCEPTION
          'soft-delete resurrection failed outside the canonical guard: %',
          v_error_message;
      END IF;
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM public.direct_messages AS message_row
    WHERE message_row.id = '20000000-0000-4000-8000-000000000041'
      AND message_row.deleted_at IS NOT NULL
  ) OR (
    SELECT conversation.last_message_preview IS NOT NULL
    FROM public.conversations AS conversation
    WHERE conversation.id = '10000000-0000-4000-8000-000000000004'
  ) THEN
    RAISE EXCEPTION
      'failed resurrection changed the message or restored its preview';
  END IF;
END
$soft_delete_irreversibility_proof$;
SQL

# Browser roles cannot call the service RPC even with a forged actor ID.
for browser_role in anon authenticated; do
  if psql_cmd >"$TMP_ROOT/${browser_role}-delete-rpc.log" 2>&1 <<SQL; then
SET ROLE $browser_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', '$browser_role', false);
SELECT public.delete_direct_message_atomic(
  '20000000-0000-4000-8000-000000000051',
  '99999999-9999-4999-8999-999999999999'
);
SQL
    echo "$browser_role unexpectedly executed atomic DM delete" >&2
    exit 1
  fi
done

# Even a role with the service grant must present the service JWT claim.
if psql_cmd >"$TMP_ROOT/forged-service-claim.log" 2>&1 <<'SQL'; then
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT public.delete_direct_message_atomic(
  '20000000-0000-4000-8000-000000000051',
  '99999999-9999-4999-8999-999999999999'
);
SQL
  echo "non-service JWT claim unexpectedly executed atomic DM delete" >&2
  exit 1
fi

# A failing conversation summary update must roll back the message soft delete.
psql_cmd <<'SQL'
CREATE FUNCTION public.fail_selected_conversation_summary()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.id = '10000000-0000-4000-8000-000000000005'::uuid THEN
    RAISE EXCEPTION 'injected summary failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER fail_selected_conversation_summary
BEFORE UPDATE OF last_message_at, last_message_preview
ON public.conversations
FOR EACH ROW
EXECUTE FUNCTION public.fail_selected_conversation_summary();
SQL

if psql_cmd >"$TMP_ROOT/trigger-rollback.log" 2>&1 <<'SQL'; then
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.delete_direct_message_atomic(
  '20000000-0000-4000-8000-000000000051',
  '99999999-9999-4999-8999-999999999999'
);
SQL
  echo "delete unexpectedly survived injected summary failure" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $trigger_rollback_proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.direct_messages AS message_row
    WHERE message_row.id = '20000000-0000-4000-8000-000000000051'
      AND message_row.deleted_at IS NOT NULL
  ) OR (
    SELECT conversation.last_message_preview
    FROM public.conversations AS conversation
    WHERE conversation.id = '10000000-0000-4000-8000-000000000005'
  ) <> 'rollback me' THEN
    RAISE EXCEPTION 'trigger failure did not roll back message and preview';
  END IF;
END
$trigger_rollback_proof$;
DROP TRIGGER fail_selected_conversation_summary ON public.conversations;
DROP FUNCTION public.fail_selected_conversation_summary();
SQL

# Corrupt the message/conversation edge with replication triggers disabled;
# the RPC must validate the pair after locking and fail closed.
psql_cmd <<'SQL'
SET session_replication_role = replica;
UPDATE public.direct_messages
SET conversation_id = '10000000-0000-4000-8000-000000000002'
WHERE id = '20000000-0000-4000-8000-000000000081';
SET session_replication_role = origin;
SQL

if psql_cmd >"$TMP_ROOT/pair-integrity.log" 2>&1 <<'SQL'; then
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.delete_direct_message_atomic(
  '20000000-0000-4000-8000-000000000081',
  'ffffffff-ffff-4fff-8fff-ffffffffffff'
);
SQL
  echo "RPC unexpectedly accepted a cross-conversation message" >&2
  exit 1
fi

psql_cmd <<'SQL'
SET session_replication_role = replica;
UPDATE public.direct_messages
SET conversation_id = '10000000-0000-4000-8000-000000000008'
WHERE id = '20000000-0000-4000-8000-000000000081';
SET session_replication_role = origin;
SQL

# Deleting an entire conversation must still cascade through a quoted-message
# pair. The summary trigger treats the already-removed conversation as the
# intentional FK-cascade case, and the immutable guard permits only the
# internal reply unlink needed by ON DELETE SET NULL.
psql_cmd <<'SQL'
DELETE FROM public.conversations
WHERE id = '10000000-0000-4000-8000-000000000008';

DO $conversation_cascade_proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.conversations AS conversation
    WHERE conversation.id = '10000000-0000-4000-8000-000000000008'
  ) OR EXISTS (
    SELECT 1
    FROM public.direct_messages AS message_row
    WHERE message_row.id IN (
      '20000000-0000-4000-8000-000000000081',
      '20000000-0000-4000-8000-000000000082'
    )
  ) THEN
    RAISE EXCEPTION 'conversation cascade retained a message or conversation';
  END IF;
END
$conversation_cascade_proof$;
SQL

# Make the historical parent-row -> child-trigger inversion deterministic.
# The pause runs after PostgreSQL has locked the conversation tuple. Canonical
# delete/send work must take pair -> conversation and let this transaction's
# FK cascade skip the pair key, so neither side may be deadlock-aborted.
psql_cmd <<'SQL'
CREATE FUNCTION public.pause_dm_conversation_delete_probe()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.id IN (
    '10000000-0000-4000-8000-000000000009'::uuid,
    '10000000-0000-4000-8000-000000000010'::uuid
  ) AND pg_catalog.current_setting('application_name') LIKE
      'dm-parent-cascade-%'
  THEN
    PERFORM pg_catalog.pg_sleep(2);
  END IF;
  RETURN OLD;
END
$function$;
CREATE TRIGGER aa_pause_dm_conversation_delete_probe
BEFORE DELETE ON public.conversations
FOR EACH ROW
EXECUTE FUNCTION public.pause_dm_conversation_delete_probe();
SQL

psql_cmd -At >"$TMP_ROOT/cascade-vs-delete-parent.log" 2>&1 <<'SQL' &
BEGIN;
SET LOCAL application_name = 'dm-parent-cascade-delete';
DELETE FROM public.conversations
WHERE id = '10000000-0000-4000-8000-000000000009';
COMMIT;
SQL
cascade_delete_parent_pid=$!

cascade_delete_parent_ready=false
for ((attempt = 0; attempt < 100; attempt++)); do
  if [[ "$(psql_cmd -Atc "
    SELECT pg_catalog.count(*) = 1
    FROM pg_catalog.pg_stat_activity
    WHERE application_name = 'dm-parent-cascade-delete'
      AND wait_event = 'PgSleep'
  ")" == "t" ]]; then
    cascade_delete_parent_ready=true
    break
  fi
  sleep 0.02
done
if [[ "$cascade_delete_parent_ready" != true ]]; then
  wait "$cascade_delete_parent_pid" || true
  cat "$TMP_ROOT/cascade-vs-delete-parent.log" >&2
  echo "conversation cascade never reached the delete lock-order probe" >&2
  exit 1
fi

psql_cmd -At >"$TMP_ROOT/cascade-vs-delete-rpc.log" 2>&1 <<'SQL' &
BEGIN;
SET LOCAL application_name = 'dm-cascade-racing-delete-rpc';
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.delete_direct_message_atomic(
  '20000000-0000-4000-8000-000000000091',
  '12121212-1212-4212-8212-121212121212'
);
COMMIT;
SQL
cascade_delete_rpc_pid=$!

set +e
wait "$cascade_delete_parent_pid"
cascade_delete_parent_status=$?
wait "$cascade_delete_rpc_pid"
cascade_delete_rpc_status=$?
set -e
if ((cascade_delete_parent_status != 0 || cascade_delete_rpc_status != 0)); then
  cat "$TMP_ROOT/cascade-vs-delete-parent.log" >&2
  cat "$TMP_ROOT/cascade-vs-delete-rpc.log" >&2
  echo "conversation cascade and atomic delete did not complete without deadlock" >&2
  exit 1
fi
if ! grep -q '"reason": "NOT_FOUND"' \
  "$TMP_ROOT/cascade-vs-delete-rpc.log"; then
  cat "$TMP_ROOT/cascade-vs-delete-rpc.log" >&2
  echo "racing delete did not observe the completed parent cascade" >&2
  exit 1
fi

psql_cmd -At >"$TMP_ROOT/cascade-vs-send-parent.log" 2>&1 <<'SQL' &
BEGIN;
SET LOCAL application_name = 'dm-parent-cascade-send';
DELETE FROM public.conversations
WHERE id = '10000000-0000-4000-8000-000000000010';
COMMIT;
SQL
cascade_send_parent_pid=$!

cascade_send_parent_ready=false
for ((attempt = 0; attempt < 100; attempt++)); do
  if [[ "$(psql_cmd -Atc "
    SELECT pg_catalog.count(*) = 1
    FROM pg_catalog.pg_stat_activity
    WHERE application_name = 'dm-parent-cascade-send'
      AND wait_event = 'PgSleep'
  ")" == "t" ]]; then
    cascade_send_parent_ready=true
    break
  fi
  sleep 0.02
done
if [[ "$cascade_send_parent_ready" != true ]]; then
  wait "$cascade_send_parent_pid" || true
  cat "$TMP_ROOT/cascade-vs-send-parent.log" >&2
  echo "conversation cascade never reached the send lock-order probe" >&2
  exit 1
fi

psql_cmd -At >"$TMP_ROOT/cascade-vs-send-rpc.log" 2>&1 <<'SQL' &
BEGIN;
SET LOCAL application_name = 'dm-cascade-racing-send-rpc';
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.send_direct_message_atomic(
  '34343434-3434-4434-8434-343434343434',
  '45454545-4545-4454-8454-454545454545',
  'send survives conversation cascade'
);
COMMIT;
SQL
cascade_send_rpc_pid=$!

set +e
wait "$cascade_send_parent_pid"
cascade_send_parent_status=$?
wait "$cascade_send_rpc_pid"
cascade_send_rpc_status=$?
set -e
if ((cascade_send_parent_status != 0 || cascade_send_rpc_status != 0)); then
  cat "$TMP_ROOT/cascade-vs-send-parent.log" >&2
  cat "$TMP_ROOT/cascade-vs-send-rpc.log" >&2
  echo "conversation cascade and atomic send did not complete without deadlock" >&2
  exit 1
fi
if ! grep -q '"success": true' "$TMP_ROOT/cascade-vs-send-rpc.log"; then
  cat "$TMP_ROOT/cascade-vs-send-rpc.log" >&2
  echo "racing send did not recreate its deleted conversation" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $cascade_lock_order_proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.direct_messages AS message_row
    WHERE message_row.id IN (
      '20000000-0000-4000-8000-000000000091'::uuid,
      '20000000-0000-4000-8000-000000000101'::uuid
    )
  ) OR EXISTS (
    SELECT 1
    FROM public.conversations AS conversation
    WHERE conversation.id IN (
      '10000000-0000-4000-8000-000000000009'::uuid,
      '10000000-0000-4000-8000-000000000010'::uuid
    )
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.conversations AS conversation
    JOIN public.direct_messages AS message_row
      ON message_row.conversation_id = conversation.id
    WHERE conversation.user1_id =
        '34343434-3434-4434-8434-343434343434'::uuid
      AND conversation.user2_id =
        '45454545-4545-4454-8454-454545454545'::uuid
      AND conversation.id <>
        '10000000-0000-4000-8000-000000000010'::uuid
      AND message_row.content = 'send survives conversation cascade'
      AND message_row.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'cascade lock-order proof retained old rows or lost the racing send';
  END IF;
END
$cascade_lock_order_proof$;
DROP TRIGGER aa_pause_dm_conversation_delete_probe
  ON public.conversations;
DROP FUNCTION public.pause_dm_conversation_delete_probe();
SQL

# Send-vs-delete: the send holds the pair lock until commit. The delete waits,
# then removes the old message and must leave the newly sent preview.
psql_cmd -At >"$TMP_ROOT/concurrent-send.log" 2>&1 <<'SQL' &
BEGIN;
SET LOCAL application_name = 'atomic-dm-send-lock-holder';
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.send_direct_message_atomic(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'new message wins send-delete race'
);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
send_pid=$!

send_lock_ready=false
for ((attempt = 0; attempt < 100; attempt++)); do
  if [[ "$(psql_cmd -Atc "
    SELECT pg_catalog.count(*) = 1
    FROM pg_catalog.pg_stat_activity
    WHERE application_name = 'atomic-dm-send-lock-holder'
      AND wait_event = 'PgSleep'
  ")" == "t" ]]; then
    send_lock_ready=true
    break
  fi
  sleep 0.02
done
if [[ "$send_lock_ready" != true ]]; then
  wait "$send_pid" || true
  cat "$TMP_ROOT/concurrent-send.log" >&2
  echo "concurrent send never reached its lock-holding probe" >&2
  exit 1
fi

# While send holds the same pair boundary, a payload rewrite must be rejected
# by the immutable guard itself (and before the pair serializer could wait).
if psql_cmd >"$TMP_ROOT/concurrent-payload-rewrite.log" 2>&1 <<'SQL'; then
SET statement_timeout = '500ms';
UPDATE public.direct_messages
SET content = 'forged during concurrent send'
WHERE id = '20000000-0000-4000-8000-000000000061';
SQL
  wait "$send_pid" || true
  echo "payload rewrite unexpectedly succeeded during concurrent send" >&2
  exit 1
fi
if ! grep -q 'identity and payload are immutable after send' \
  "$TMP_ROOT/concurrent-payload-rewrite.log"; then
  wait "$send_pid" || true
  cat "$TMP_ROOT/concurrent-payload-rewrite.log" >&2
  echo "concurrent payload rewrite did not fail at the immutable guard" >&2
  exit 1
fi

psql_cmd -At >"$TMP_ROOT/concurrent-delete.log" 2>&1 <<'SQL' &
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.delete_direct_message_atomic(
  '20000000-0000-4000-8000-000000000061',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
);
COMMIT;
SQL
delete_pid=$!
wait "$send_pid"
wait "$delete_pid"

psql_cmd <<'SQL'
DO $send_delete_concurrency_proof$
BEGIN
  IF (
    SELECT conversation.last_message_preview
    FROM public.conversations AS conversation
    WHERE conversation.id = '10000000-0000-4000-8000-000000000006'
  ) <> 'new message wins send-delete race' OR EXISTS (
    SELECT 1
    FROM public.direct_messages AS message_row
    WHERE message_row.id = '20000000-0000-4000-8000-000000000061'
      AND message_row.deleted_at IS NULL
  ) OR (
    SELECT message_row.content
    FROM public.direct_messages AS message_row
    WHERE message_row.id = '20000000-0000-4000-8000-000000000061'
  ) <> 'old before concurrent send'
  THEN
    RAISE EXCEPTION 'send-vs-delete serialization produced a stale preview';
  END IF;
END
$send_delete_concurrency_proof$;

TRUNCATE public.dm_summary_update_audit;
SQL

# Two concurrent deletes serialize. The first mutates/recalculates once; the
# second observes the committed soft delete and returns idempotently.
psql_cmd -At >"$TMP_ROOT/first-delete.log" 2>&1 <<'SQL' &
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.delete_direct_message_atomic(
  '20000000-0000-4000-8000-000000000071',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
);
SELECT pg_catalog.pg_sleep(1);
COMMIT;
SQL
first_delete_pid=$!
sleep 0.2
psql_cmd -At >"$TMP_ROOT/second-delete.log" 2>&1 <<'SQL' &
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.delete_direct_message_atomic(
  '20000000-0000-4000-8000-000000000071',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
);
COMMIT;
SQL
second_delete_pid=$!
wait "$first_delete_pid"
wait "$second_delete_pid"

if ! grep -q '"deleted": true' "$TMP_ROOT/first-delete.log"; then
  cat "$TMP_ROOT/first-delete.log" >&2
  exit 1
fi
if ! grep -q '"already_deleted": true' "$TMP_ROOT/second-delete.log"; then
  cat "$TMP_ROOT/second-delete.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $two_delete_concurrency_proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.dm_summary_update_audit AS audit
    WHERE audit.conversation_id = '10000000-0000-4000-8000-000000000007'
  ) <> 1 OR (
    SELECT conversation.last_message_preview IS NOT NULL
        OR conversation.last_message_at <>
          '2024-07-01 00:00:00+00'::timestamptz
    FROM public.conversations AS conversation
    WHERE conversation.id = '10000000-0000-4000-8000-000000000007'
  ) THEN
    RAISE EXCEPTION 'concurrent deletes recalculated more than once or leaked preview';
  END IF;
END
$two_delete_concurrency_proof$;
SQL

# Duplicate trigger drift must fail before ACL cleanup, then replay must clean
# an arbitrary role grant and recalibrate data after the drift is removed.
psql_cmd <<'SQL'
GRANT EXECUTE ON FUNCTION public.delete_direct_message_atomic(uuid, uuid)
  TO rogue_role;
GRANT EXECUTE ON FUNCTION public.guard_direct_message_immutable_fields()
  TO rogue_role;
CREATE TRIGGER duplicate_dm_delete_summary
AFTER UPDATE OF deleted_at ON public.direct_messages
FOR EACH ROW
EXECUTE FUNCTION public.maintain_direct_message_delete_summary();
SQL

if psql_cmd -f "$DELETE_MIGRATION" >"$TMP_ROOT/duplicate-delete-trigger.log" 2>&1; then
  echo "migration accepted a duplicate delete-summary trigger" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $duplicate_trigger_rollback$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
    'rogue_role',
    'public.delete_direct_message_atomic(uuid,uuid)',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'rogue_role',
    'public.guard_direct_message_immutable_fields()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'duplicate-trigger preflight did not roll back before ACL cleanup';
  END IF;
END
$duplicate_trigger_rollback$;
DROP TRIGGER duplicate_dm_delete_summary ON public.direct_messages;

-- Same-name/same-role policies with the expected text fragments used to pass
-- replay while the leading true made every authenticated user a participant.
-- Add an extra fail-open policy and corrupt the reader helper as well; replay
-- must reconstruct the entire boundary, not merely reject unfamiliar names.
DROP POLICY "Authenticated participants read direct messages"
  ON public.direct_messages;
CREATE POLICY "Authenticated participants read direct messages"
  ON public.direct_messages
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    true OR (
      public.is_current_user_active_for_direct_messages()
      AND direct_messages.deleted_at IS NULL
      AND direct_messages.conversation_id IS NOT NULL
    )
  );
CREATE POLICY "Injected authenticated conversation reader"
  ON public.conversations
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);
CREATE OR REPLACE FUNCTION public.is_current_user_active_for_direct_messages()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RETURN true;
END
$function$;

UPDATE public.conversations
SET last_message_at = '2035-01-01 00:00:00+00',
    last_message_preview = 'manual leaked preview'
WHERE id = '10000000-0000-4000-8000-000000000002';
SQL

psql_cmd -f "$DELETE_MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $replay_convergence$
BEGIN
  IF pg_catalog.has_function_privilege(
    'rogue_role',
    'public.delete_direct_message_atomic(uuid,uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'rogue_role',
    'public.guard_direct_message_immutable_fields()',
    'EXECUTE'
  ) OR (
    SELECT conversation.last_message_preview IS NOT NULL
        OR conversation.last_message_at <>
          '2024-02-01 00:00:00+00'::timestamptz
    FROM public.conversations AS conversation
    WHERE conversation.id = '10000000-0000-4000-8000-000000000002'
  ) THEN
    RAISE EXCEPTION 'replay did not converge ACLs and summaries';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid IN (
      'public.conversations'::regclass,
      'public.direct_messages'::regclass
    )
  ) <> 4 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.direct_messages'::regclass
      AND policy.polname = 'Authenticated participants read direct messages'
      AND pg_catalog.pg_get_expr(
        policy.polqual,
        policy.polrelid,
        true
      ) ~ '(^|[^[:alpha:]_])true[[:space:]]+OR'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid IN (
      'public.conversations'::regclass,
      'public.direct_messages'::regclass
    )
      AND policy.polname = 'Injected authenticated conversation reader'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      'public.is_current_user_active_for_direct_messages()'::regprocedure
      AND pg_catalog.strpos(function_row.prosrc, 'actor_profile.deleted_at') > 0
      AND pg_catalog.strpos(function_row.prosrc, 'actor_profile.banned_at') > 0
  ) THEN
    RAISE EXCEPTION
      'replay retained a fail-open policy or reader-helper definition';
  END IF;
END
$replay_convergence$;
SQL

outsider_message_count="$(psql_cmd -Atq <<'SQL'
SET ROLE authenticated;
SET request.jwt.claim.role = 'authenticated';
SET request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
SELECT pg_catalog.count(*)
FROM public.direct_messages AS message_row
WHERE message_row.id = '20000000-0000-4000-8000-000000000051';
SQL
)"
if [[ "$outsider_message_count" != "0" ]]; then
  echo "nonparticipant authenticated user read another pair's message" >&2
  exit 1
fi

participant_message_count="$(psql_cmd -Atq <<'SQL'
SET ROLE authenticated;
SET request.jwt.claim.role = 'authenticated';
SET request.jwt.claim.sub = '99999999-9999-4999-8999-999999999999';
SELECT pg_catalog.count(*)
FROM public.direct_messages AS message_row
WHERE message_row.id = '20000000-0000-4000-8000-000000000051';
SQL
)"
if [[ "$participant_message_count" != "1" ]]; then
  echo "canonical participant policy denied its live message" >&2
  exit 1
fi

# A route-name overload is ambiguous to PostgREST and must fail closed rather
# than being silently dropped.
psql_cmd <<'SQL'
CREATE FUNCTION public.delete_direct_message_atomic(text, text)
RETURNS jsonb
LANGUAGE sql
AS 'SELECT ''{}''::jsonb';
SQL
if psql_cmd -f "$DELETE_MIGRATION" >"$TMP_ROOT/delete-overload.log" 2>&1; then
  echo "migration accepted a duplicate delete RPC overload" >&2
  exit 1
fi
psql_cmd <<'SQL'
DROP FUNCTION public.delete_direct_message_atomic(text, text);
SQL

# Dependency ACL drift is not owned by 114200 and must stop deployment.
psql_cmd <<'SQL'
GRANT EXECUTE
  ON FUNCTION public.send_direct_message_atomic(uuid,uuid,text,text,text,text,uuid)
  TO authenticated;
SQL
if psql_cmd -f "$DELETE_MIGRATION" >"$TMP_ROOT/dependency-acl.log" 2>&1; then
  echo "migration accepted dependency ACL drift" >&2
  exit 1
fi
psql_cmd <<'SQL'
REVOKE ALL
  ON FUNCTION public.send_direct_message_atomic(uuid,uuid,text,text,text,text,uuid)
  FROM authenticated;
SQL

# Missing required grants are as unsafe as extra grants: replay must not bless
# an authenticated conversation reader or a legacy service writer that was
# silently removed from the 114000 ACL boundary.
psql_cmd <<'SQL'
REVOKE SELECT ON public.conversations FROM authenticated;
REVOKE INSERT ON public.direct_messages FROM service_role;
SQL
if psql_cmd -f "$DELETE_MIGRATION" >"$TMP_ROOT/missing-table-acl.log" 2>&1; then
  echo "migration accepted missing required direct-message table ACLs" >&2
  exit 1
fi
if ! grep -q 'browser read ACL contract drift detected' \
  "$TMP_ROOT/missing-table-acl.log"; then
  cat "$TMP_ROOT/missing-table-acl.log" >&2
  echo "missing table ACLs did not fail the exact grant preflight" >&2
  exit 1
fi
psql_cmd <<'SQL'
GRANT SELECT ON public.conversations TO authenticated;
GRANT INSERT ON public.direct_messages TO service_role;
SQL

# Cascade safety depends on the exact parent FK. A same-column NO ACTION drift
# must fail before the migration installs its cascade-specific lock exception.
psql_cmd <<'SQL'
ALTER TABLE public.direct_messages
DROP CONSTRAINT direct_messages_conversation_id_fkey;
ALTER TABLE public.direct_messages
ADD CONSTRAINT direct_messages_conversation_id_fkey
FOREIGN KEY (conversation_id)
REFERENCES public.conversations(id)
ON DELETE NO ACTION;
SQL
if psql_cmd -f "$DELETE_MIGRATION" >"$TMP_ROOT/conversation-fk-drift.log" 2>&1; then
  echo "migration accepted a non-cascading direct-message conversation FK" >&2
  exit 1
fi
if ! grep -q 'conversation_id ON DELETE CASCADE FK contract drift detected' \
  "$TMP_ROOT/conversation-fk-drift.log"; then
  cat "$TMP_ROOT/conversation-fk-drift.log" >&2
  echo "conversation FK drift did not fail at its exact preflight" >&2
  exit 1
fi
psql_cmd <<'SQL'
ALTER TABLE public.direct_messages
DROP CONSTRAINT direct_messages_conversation_id_fkey;
ALTER TABLE public.direct_messages
ADD CONSTRAINT direct_messages_conversation_id_fkey
FOREIGN KEY (conversation_id)
REFERENCES public.conversations(id)
ON DELETE CASCADE;
SQL

# A second FK on the same source column changes referential actions even when
# the canonical FK still exists. Exact-definition count alone is insufficient.
psql_cmd <<'SQL'
ALTER TABLE public.direct_messages
ADD CONSTRAINT injected_conversation_id_restrict_fkey
FOREIGN KEY (conversation_id)
REFERENCES public.conversations(id)
ON DELETE RESTRICT;
SQL
if psql_cmd -f "$DELETE_MIGRATION" >"$TMP_ROOT/extra-conversation-fk.log" 2>&1; then
  echo "migration accepted an extra conversation_id FK" >&2
  exit 1
fi
if ! grep -q 'conversation_id ON DELETE CASCADE FK contract drift detected' \
  "$TMP_ROOT/extra-conversation-fk.log"; then
  cat "$TMP_ROOT/extra-conversation-fk.log" >&2
  echo "extra conversation FK did not fail the one-source-FK contract" >&2
  exit 1
fi
psql_cmd <<'SQL'
ALTER TABLE public.direct_messages
DROP CONSTRAINT injected_conversation_id_restrict_fkey;
SQL

psql_cmd <<'SQL'
ALTER TABLE public.direct_messages
ADD CONSTRAINT injected_reply_to_id_cascade_fkey
FOREIGN KEY (reply_to_id)
REFERENCES public.direct_messages(id)
ON DELETE CASCADE;
SQL
if psql_cmd -f "$DELETE_MIGRATION" >"$TMP_ROOT/extra-reply-fk.log" 2>&1; then
  echo "migration accepted an extra reply_to_id FK" >&2
  exit 1
fi
if ! grep -q 'reply_to_id ON DELETE SET NULL FK contract drift detected' \
  "$TMP_ROOT/extra-reply-fk.log"; then
  cat "$TMP_ROOT/extra-reply-fk.log" >&2
  echo "extra reply FK did not fail the one-source-FK contract" >&2
  exit 1
fi
psql_cmd <<'SQL'
ALTER TABLE public.direct_messages
DROP CONSTRAINT injected_reply_to_id_cascade_fkey;
SQL

# A composite FK can still change the parent-delete action without having the
# exact single-column conkey. Create it before rebuilding the canonical FK so
# its RESTRICT trigger fires first and demonstrably blocks conversation delete.
psql_cmd <<'SQL'
INSERT INTO public.user_profiles(
  id, dm_permission, handle, notify_message, deleted_at, banned_at
) VALUES
  (
    '56565656-5656-4656-8656-565656565656',
    'all',
    'composite-one',
    false,
    NULL,
    NULL
  ),
  (
    '67676767-6767-4767-8767-676767676767',
    'all',
    'composite-two',
    false,
    NULL,
    NULL
  );
SET request.jwt.claim.role = 'service_role';
SELECT public.send_direct_message_atomic(
  '56565656-5656-4656-8656-565656565656',
  '67676767-6767-4767-8767-676767676767',
  'composite FK recovery proof'
);
RESET request.jwt.claim.role;

ALTER TABLE public.conversations
  ADD CONSTRAINT injected_conversation_triplet_unique
  UNIQUE (id, user1_id, user2_id);
ALTER TABLE public.direct_messages
  ADD COLUMN injected_user1_id uuid
    GENERATED ALWAYS AS (LEAST(sender_id, receiver_id)) STORED,
  ADD COLUMN injected_user2_id uuid
    GENERATED ALWAYS AS (GREATEST(sender_id, receiver_id)) STORED;
ALTER TABLE public.direct_messages
  DROP CONSTRAINT direct_messages_conversation_id_fkey;
ALTER TABLE public.direct_messages
  ADD CONSTRAINT injected_composite_conversation_restrict_fkey
  FOREIGN KEY (conversation_id, injected_user1_id, injected_user2_id)
  REFERENCES public.conversations(id, user1_id, user2_id)
  ON DELETE RESTRICT;
ALTER TABLE public.direct_messages
  ADD CONSTRAINT direct_messages_conversation_id_fkey
  FOREIGN KEY (conversation_id)
  REFERENCES public.conversations(id)
  ON DELETE CASCADE;
SQL
if psql_cmd -f "$DELETE_MIGRATION" >"$TMP_ROOT/composite-conversation-fk.log" 2>&1; then
  echo "migration accepted an extra composite conversation FK" >&2
  exit 1
fi
if ! grep -q 'conversation_id ON DELETE CASCADE FK contract drift detected' \
  "$TMP_ROOT/composite-conversation-fk.log"; then
  cat "$TMP_ROOT/composite-conversation-fk.log" >&2
  echo "composite conversation FK did not fail the authority inventory" >&2
  exit 1
fi
psql_cmd <<'SQL'
DO $composite_fk_changes_delete_proof$
DECLARE
  v_constraint_name text;
BEGIN
  BEGIN
    DELETE FROM public.conversations AS conversation
    WHERE conversation.user1_id =
        '56565656-5656-4656-8656-565656565656'::uuid
      AND conversation.user2_id =
        '67676767-6767-4767-8767-676767676767'::uuid;
    RAISE EXCEPTION 'composite RESTRICT FK did not change conversation delete';
  EXCEPTION
    WHEN foreign_key_violation THEN
      GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
      IF v_constraint_name <>
        'injected_composite_conversation_restrict_fkey'
      THEN
        RAISE EXCEPTION
          'conversation delete failed at unexpected FK: %',
          v_constraint_name;
      END IF;
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM public.direct_messages AS message_row
    WHERE message_row.content = 'composite FK recovery proof'
  ) THEN
    RAISE EXCEPTION 'failed composite-FK delete did not roll back its cascade';
  END IF;
END
$composite_fk_changes_delete_proof$;

ALTER TABLE public.direct_messages
  DROP CONSTRAINT injected_composite_conversation_restrict_fkey;
ALTER TABLE public.direct_messages
  DROP COLUMN injected_user1_id,
  DROP COLUMN injected_user2_id;
ALTER TABLE public.conversations
  DROP CONSTRAINT injected_conversation_triplet_unique;
SQL

psql_cmd -f "$DELETE_MIGRATION" >/dev/null
psql_cmd <<'SQL'
DELETE FROM public.conversations AS conversation
WHERE conversation.user1_id =
    '56565656-5656-4656-8656-565656565656'::uuid
  AND conversation.user2_id =
    '67676767-6767-4767-8767-676767676767'::uuid;
DO $composite_fk_recovery_proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.direct_messages AS message_row
    WHERE message_row.content = 'composite FK recovery proof'
  ) THEN
    RAISE EXCEPTION
      'canonical conversation cascade failed after composite-FK recovery';
  END IF;
END
$composite_fk_recovery_proof$;
SQL

# ON CONFLICT cannot use a deferrable unique arbiter. Replay must reject the
# same ordered columns when the backing constraint/index is not immediate.
psql_cmd <<'SQL'
ALTER TABLE public.conversations
ADD CONSTRAINT injected_reverse_pair_deferrable_key
UNIQUE (user2_id, user1_id)
DEFERRABLE INITIALLY DEFERRED;
SQL
if psql_cmd -f "$DELETE_MIGRATION" >"$TMP_ROOT/reverse-deferrable-pair-unique.log" 2>&1; then
  echo "migration accepted an extra reversed deferrable pair arbiter" >&2
  exit 1
fi
if ! grep -q 'immediate nondeferrable ordered conversation-pair contract' \
  "$TMP_ROOT/reverse-deferrable-pair-unique.log"; then
  cat "$TMP_ROOT/reverse-deferrable-pair-unique.log" >&2
  echo "reversed deferrable pair authority escaped unordered inventory" >&2
  exit 1
fi
psql_cmd <<'SQL'
ALTER TABLE public.conversations
DROP CONSTRAINT injected_reverse_pair_deferrable_key;
SQL

psql_cmd <<'SQL'
ALTER TABLE public.conversations
DROP CONSTRAINT conversations_user1_id_user2_id_key;
ALTER TABLE public.conversations
ADD CONSTRAINT conversations_user1_id_user2_id_key
UNIQUE (user1_id, user2_id)
DEFERRABLE INITIALLY DEFERRED;
SQL
if psql_cmd -f "$DELETE_MIGRATION" >"$TMP_ROOT/deferrable-pair-unique.log" 2>&1; then
  echo "migration accepted a deferrable conversation pair constraint" >&2
  exit 1
fi
if ! grep -q 'immediate nondeferrable ordered conversation-pair contract' \
  "$TMP_ROOT/deferrable-pair-unique.log"; then
  cat "$TMP_ROOT/deferrable-pair-unique.log" >&2
  echo "deferrable pair uniqueness did not fail its catalog preflight" >&2
  exit 1
fi
psql_cmd <<'SQL'
ALTER TABLE public.conversations
DROP CONSTRAINT conversations_user1_id_user2_id_key;
ALTER TABLE public.conversations
ADD CONSTRAINT conversations_user1_id_user2_id_key
UNIQUE (user1_id, user2_id);
SQL

psql_cmd -f "$DELETE_MIGRATION" >/dev/null

psql_cmd <<'SQL'
INSERT INTO public.user_profiles(
  id, dm_permission, handle, notify_message, deleted_at, banned_at
) VALUES
  (
    '01010101-0101-4101-8101-010101010101',
    'all',
    'twenty-one',
    false,
    NULL,
    NULL
  ),
  (
    '02020202-0202-4202-8202-020202020202',
    'all',
    'twenty-two',
    false,
    NULL,
    NULL
  );
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $immediate_unique_send_proof$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.send_direct_message_atomic(
    '01010101-0101-4101-8101-010101010101',
    '02020202-0202-4202-8202-020202020202',
    'immediate unique arbiter send proof'
  );
  IF (v_result ->> 'success')::boolean IS NOT TRUE OR NOT EXISTS (
    SELECT 1
    FROM public.direct_messages AS message_row
    WHERE message_row.content = 'immediate unique arbiter send proof'
      AND message_row.sender_id =
        '01010101-0101-4101-8101-010101010101'::uuid
      AND message_row.receiver_id =
        '02020202-0202-4202-8202-020202020202'::uuid
  ) THEN
    RAISE EXCEPTION
      'restored immediate conversation uniqueness did not support send';
  END IF;
END
$immediate_unique_send_proof$;
SQL

# Signature/config/ACL equality is not function-definition authority. Replace
# all three behavior-bearing dependencies with metadata-compatible bypasses;
# replay must restore their canonical bodies before any write is accepted.
psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.check_dm_permission(
  p_sender_id uuid,
  p_receiver_id uuid
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.jsonb_build_object('allowed', true)
$function$;

CREATE OR REPLACE FUNCTION public.validate_direct_message_integrity()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.create_message_notification()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  RETURN NEW;
END
$function$;
SQL

psql_cmd -f "$DELETE_MIGRATION" >/dev/null
psql_cmd <<'SQL'
DO $canonical_dependency_hash_proof$
BEGIN
  IF (
    SELECT pg_catalog.md5(function_row.prosrc)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      'public.check_dm_permission(uuid,uuid)'::regprocedure
  ) <> '1bc16d1d61dc83b45e9fe4d7796949c1' OR (
    SELECT pg_catalog.md5(function_row.prosrc)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      'public.create_message_notification()'::regprocedure
  ) <> '8cede0f9d7aa6ec34e9212e69e4311c6' OR (
    SELECT pg_catalog.md5(function_row.prosrc)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      'public.validate_direct_message_integrity()'::regprocedure
  ) <> '9a0170f32101b7994e983a2b43dd52c7'
  THEN
    RAISE EXCEPTION 'replay did not restore canonical dependency bodies';
  END IF;
END
$canonical_dependency_hash_proof$;

INSERT INTO public.user_profiles(
  id, dm_permission, handle, notify_message, deleted_at, banned_at
) VALUES
  (
    '69696969-6969-4696-8696-696969696969',
    'all',
    'blocked-sender',
    true,
    NULL,
    NULL
  ),
  (
    '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a',
    'all',
    'blocking-receiver',
    true,
    NULL,
    NULL
  ),
  (
    '8b8b8b8b-8b8b-48b8-88b8-8b8b8b8b8b8b',
    'all',
    'allowed-sender',
    true,
    NULL,
    NULL
  ),
  (
    '9c9c9c9c-9c9c-49c9-89c9-9c9c9c9c9c9c',
    'all',
    'allowed-receiver',
    true,
    NULL,
    NULL
  );
INSERT INTO public.blocked_users(blocker_id, blocked_id)
VALUES (
  '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a',
  '69696969-6969-4696-8696-696969696969'
);

SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $canonical_dependency_behavior_proof$
DECLARE
  v_blocked_result jsonb;
  v_allowed_result jsonb;
  v_allowed_conversation_id uuid;
  v_cross_insert_rejected boolean := false;
BEGIN
  v_blocked_result := public.send_direct_message_atomic(
    '69696969-6969-4696-8696-696969696969',
    '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a',
    'body drift must not bypass block'
  );
  IF v_blocked_result ->> 'reason' <> 'BLOCKED' OR EXISTS (
    SELECT 1
    FROM public.conversations AS conversation
    WHERE conversation.user1_id =
        '69696969-6969-4696-8696-696969696969'::uuid
      AND conversation.user2_id =
        '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a'::uuid
  ) THEN
    RAISE EXCEPTION
      'canonical permission body did not restore block enforcement: %',
      v_blocked_result;
  END IF;

  v_allowed_result := public.send_direct_message_atomic(
    '8b8b8b8b-8b8b-48b8-88b8-8b8b8b8b8b8b',
    '9c9c9c9c-9c9c-49c9-89c9-9c9c9c9c9c9c',
    'canonical dependency recovery message'
  );
  IF (v_allowed_result ->> 'success')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION
      'canonical dependency recovery send failed: %',
      v_allowed_result;
  END IF;
  v_allowed_conversation_id :=
    (v_allowed_result ->> 'conversation_id')::uuid;

  IF NOT EXISTS (
    SELECT 1
    FROM public.notifications AS notification
    WHERE notification.user_id =
        '9c9c9c9c-9c9c-49c9-89c9-9c9c9c9c9c9c'::uuid
      AND notification.actor_id =
        '8b8b8b8b-8b8b-48b8-88b8-8b8b8b8b8b8b'::uuid
      AND notification.reference_id = v_allowed_conversation_id
  ) THEN
    RAISE EXCEPTION
      'canonical notification body did not restore its one-row side effect';
  END IF;

  BEGIN
    INSERT INTO public.direct_messages(
      id,
      conversation_id,
      sender_id,
      receiver_id,
      content
    ) VALUES (
      '2d2d2d2d-2d2d-4d2d-8d2d-2d2d2d2d2d2d',
      v_allowed_conversation_id,
      '69696969-6969-4696-8696-696969696969',
      '7a7a7a7a-7a7a-47a7-87a7-7a7a7a7a7a7a',
      'cross-conversation body bypass probe'
    );
  EXCEPTION
    WHEN check_violation THEN
      IF SQLERRM =
        'direct message must use its participants canonical conversation'
      THEN
        v_cross_insert_rejected := true;
      ELSE
        RAISE;
      END IF;
  END;

  IF NOT v_cross_insert_rejected OR EXISTS (
    SELECT 1
    FROM public.direct_messages AS message_row
    WHERE message_row.id =
      '2d2d2d2d-2d2d-4d2d-8d2d-2d2d2d2d2d2d'::uuid
  ) OR (
    SELECT conversation.last_message_preview
    FROM public.conversations AS conversation
    WHERE conversation.id = v_allowed_conversation_id
  ) <> 'canonical dependency recovery message' THEN
    RAISE EXCEPTION
      'canonical integrity body did not reject cross-conversation pollution';
  END IF;
END
$canonical_dependency_behavior_proof$;
SQL

# A same-name/same-function trigger with WHEN(false) has all historical tokens
# but disables the integrity boundary. Replay must reject tgqual drift.
psql_cmd <<'SQL'
DROP TRIGGER trg_validate_direct_message_integrity
  ON public.direct_messages;
CREATE TRIGGER trg_validate_direct_message_integrity
BEFORE INSERT OR UPDATE OF
  conversation_id,
  sender_id,
  receiver_id,
  content,
  media_url,
  media_type,
  media_name,
  reply_to_id
ON public.direct_messages
FOR EACH ROW
WHEN (false)
EXECUTE FUNCTION public.validate_direct_message_integrity();
SQL
if psql_cmd -f "$DELETE_MIGRATION" >"$TMP_ROOT/conditional-integrity-trigger.log" 2>&1; then
  echo "migration accepted a conditional integrity trigger" >&2
  exit 1
fi
if ! grep -q 'exact user-trigger catalog drift detected' \
  "$TMP_ROOT/conditional-integrity-trigger.log"; then
  cat "$TMP_ROOT/conditional-integrity-trigger.log" >&2
  echo "conditional integrity trigger did not fail exact preflight" >&2
  exit 1
fi
psql_cmd <<'SQL'
DROP TRIGGER trg_validate_direct_message_integrity
  ON public.direct_messages;
CREATE TRIGGER trg_validate_direct_message_integrity
BEFORE INSERT OR UPDATE OF
  conversation_id,
  sender_id,
  receiver_id,
  content,
  media_url,
  media_type,
  media_name,
  reply_to_id
ON public.direct_messages
FOR EACH ROW
EXECUTE FUNCTION public.validate_direct_message_integrity();
SQL

psql_cmd -f "$DELETE_MIGRATION" >/dev/null

if psql_cmd >"$TMP_ROOT/cross-conversation-insert.log" 2>&1 <<'SQL'; then
INSERT INTO public.direct_messages(
  id,
  conversation_id,
  sender_id,
  receiver_id,
  content
) VALUES (
  '29999999-9999-4999-8999-999999999952',
  '10000000-0000-4000-8000-000000000005',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'cross-conversation trigger bypass probe'
);
SQL
  echo "exact integrity trigger accepted a cross-conversation message" >&2
  exit 1
fi
if ! grep -q 'direct message must use its participants canonical conversation' \
  "$TMP_ROOT/cross-conversation-insert.log"; then
  cat "$TMP_ROOT/cross-conversation-insert.log" >&2
  echo "cross-conversation insert failed outside the integrity boundary" >&2
  exit 1
fi

# PostgreSQL rewrite rules run before row triggers and can suppress the atomic
# UPDATE entirely. Replay must reject them, then a clean replay must restore a
# working delete plus canonical empty-thread summary.
psql_cmd <<'SQL'
CREATE RULE injected_suppress_dm_soft_delete AS
ON UPDATE TO public.direct_messages
WHERE NEW.deleted_at IS NOT NULL
DO INSTEAD NOTHING;
SQL
if psql_cmd -f "$DELETE_MIGRATION" >"$TMP_ROOT/direct-message-rewrite-rule.log" 2>&1; then
  echo "migration accepted a direct-message UPDATE rewrite rule" >&2
  exit 1
fi
if ! grep -q 'direct-message relations must not have rewrite rules' \
  "$TMP_ROOT/direct-message-rewrite-rule.log"; then
  cat "$TMP_ROOT/direct-message-rewrite-rule.log" >&2
  echo "rewrite-rule drift did not fail before atomic delete installation" >&2
  exit 1
fi
psql_cmd <<'SQL'
DROP RULE injected_suppress_dm_soft_delete ON public.direct_messages;
SQL
psql_cmd -f "$DELETE_MIGRATION" >/dev/null
psql_cmd <<'SQL'
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $rewrite_rule_recovery_proof$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.delete_direct_message_atomic(
    (
      SELECT message_row.id
      FROM public.direct_messages AS message_row
      WHERE message_row.content = 'canonical dependency recovery message'
    ),
    '8b8b8b8b-8b8b-48b8-88b8-8b8b8b8b8b8b'
  );
  IF (v_result ->> 'deleted')::boolean IS NOT TRUE OR EXISTS (
    SELECT 1
    FROM public.direct_messages AS message_row
    WHERE message_row.content = 'canonical dependency recovery message'
      AND message_row.deleted_at IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.conversations AS conversation
    WHERE conversation.id = (v_result ->> 'conversation_id')::uuid
      AND conversation.last_message_preview IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'atomic delete/summary did not recover after rewrite-rule removal: %',
      v_result;
  END IF;
END
$rewrite_rule_recovery_proof$;
SQL

# Message durability and root-table trigger/RLS authority require permanent,
# ordinary, non-inherited relations. Replay must reject both unlogged storage
# and either side of a legacy inheritance edge.
psql_cmd <<'SQL'
ALTER TABLE public.direct_messages SET UNLOGGED;
ALTER TABLE public.conversations SET UNLOGGED;
SQL
if psql_cmd -f "$DELETE_MIGRATION" >"$TMP_ROOT/unlogged-dm-relations.log" 2>&1; then
  echo "migration accepted unlogged direct-message relations" >&2
  exit 1
fi
if ! grep -q 'permanent ordinary postgres-owned RLS table contract' \
  "$TMP_ROOT/unlogged-dm-relations.log"; then
  cat "$TMP_ROOT/unlogged-dm-relations.log" >&2
  echo "unlogged relation drift did not fail the exact shape preflight" >&2
  exit 1
fi
psql_cmd <<'SQL'
ALTER TABLE public.conversations SET LOGGED;
ALTER TABLE public.direct_messages SET LOGGED;
CREATE TABLE public.injected_dm_inheritance_parent (id uuid);
ALTER TABLE public.direct_messages
  INHERIT public.injected_dm_inheritance_parent;
SQL
if psql_cmd -f "$DELETE_MIGRATION" >"$TMP_ROOT/dm-inheritance-child.log" 2>&1; then
  echo "migration accepted direct_messages as an inheritance child" >&2
  exit 1
fi
if ! grep -q 'must not participate in inheritance or partitioning' \
  "$TMP_ROOT/dm-inheritance-child.log"; then
  cat "$TMP_ROOT/dm-inheritance-child.log" >&2
  echo "direct_messages inheritance drift escaped preflight" >&2
  exit 1
fi
psql_cmd <<'SQL'
ALTER TABLE public.direct_messages
  NO INHERIT public.injected_dm_inheritance_parent;
DROP TABLE public.injected_dm_inheritance_parent;
CREATE TABLE public.injected_conversation_inheritance_child ()
  INHERITS (public.conversations);
SQL
if psql_cmd -f "$DELETE_MIGRATION" >"$TMP_ROOT/conversation-inheritance-parent.log" 2>&1; then
  echo "migration accepted conversations as an inheritance parent" >&2
  exit 1
fi
if ! grep -q 'must not participate in inheritance or partitioning' \
  "$TMP_ROOT/conversation-inheritance-parent.log"; then
  cat "$TMP_ROOT/conversation-inheritance-parent.log" >&2
  echo "conversation inheritance drift escaped preflight" >&2
  exit 1
fi
psql_cmd <<'SQL'
DROP TABLE public.injected_conversation_inheritance_child;
SQL
psql_cmd -f "$DELETE_MIGRATION" >/dev/null

# The live schema has no updated_at. If a later migration adds it, 114200 must
# stop until that field is deliberately classified as state or immutable.
psql_cmd <<'SQL'
ALTER TABLE public.direct_messages
ADD COLUMN updated_at timestamptz;
SQL
if psql_cmd -f "$DELETE_MIGRATION" >"$TMP_ROOT/updated-at-decision.log" 2>&1; then
  echo "migration silently classified a future direct_messages.updated_at" >&2
  exit 1
fi
if ! grep -q 'updated_at requires an explicit mutability decision' \
  "$TMP_ROOT/updated-at-decision.log"; then
  cat "$TMP_ROOT/updated-at-decision.log" >&2
  echo "updated_at drift did not fail at its explicit-decision preflight" >&2
  exit 1
fi
psql_cmd <<'SQL'
ALTER TABLE public.direct_messages
DROP COLUMN updated_at;
SQL

psql_cmd -f "$DELETE_MIGRATION" >/dev/null

# Production may carry sender/receiver Auth FKs even though they are not part
# of the two protected conversation/reply authorities. They must remain valid
# inputs to 114200, and an Auth-user cascade must use the hard-delete trigger
# path directly (never the service RPC) while recalculating the surviving
# conversation summary.
psql_cmd <<'SQL'
CREATE TABLE auth.users (id uuid PRIMARY KEY);
INSERT INTO auth.users(id)
SELECT profile.id
FROM public.user_profiles AS profile;
INSERT INTO auth.users(id) VALUES
  ('adadadad-adad-4ada-8ada-adadadadadad'),
  ('bebebebe-bebe-4beb-8beb-bebebebebebe');

ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_id_auth_users_fkey
  FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.direct_messages
  ADD CONSTRAINT direct_messages_sender_id_fkey
  FOREIGN KEY (sender_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  ADD CONSTRAINT direct_messages_receiver_id_fkey
  FOREIGN KEY (receiver_id) REFERENCES auth.users(id) ON DELETE CASCADE;
SQL
psql_cmd -f "$DELETE_MIGRATION" >/dev/null
psql_cmd <<'SQL'
INSERT INTO public.user_profiles(
  id, dm_permission, handle, notify_message, deleted_at, banned_at
) VALUES
  (
    'adadadad-adad-4ada-8ada-adadadadadad',
    'all',
    'auth-cascade-sender',
    false,
    NULL,
    NULL
  ),
  (
    'bebebebe-bebe-4beb-8beb-bebebebebebe',
    'all',
    'auth-cascade-receiver',
    false,
    NULL,
    NULL
  );
SET request.jwt.claim.role = 'service_role';
SELECT public.send_direct_message_atomic(
  'adadadad-adad-4ada-8ada-adadadadadad',
  'bebebebe-bebe-4beb-8beb-bebebebebebe',
  'Auth cascade summary proof root'
);
SELECT public.send_direct_message_atomic(
  'bebebebe-bebe-4beb-8beb-bebebebebebe',
  'adadadad-adad-4ada-8ada-adadadadadad',
  'Auth cascade summary proof reply',
  NULL,
  NULL,
  NULL,
  (
    SELECT message_row.id
    FROM public.direct_messages AS message_row
    WHERE message_row.content = 'Auth cascade summary proof root'
  )
);
RESET request.jwt.claim.role;

DELETE FROM auth.users
WHERE id = 'adadadad-adad-4ada-8ada-adadadadadad';

DO $auth_user_cascade_proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.user_profiles AS profile
    WHERE profile.id = 'adadadad-adad-4ada-8ada-adadadadadad'
  ) OR EXISTS (
    SELECT 1
    FROM public.direct_messages AS message_row
    WHERE message_row.content IN (
      'Auth cascade summary proof root',
      'Auth cascade summary proof reply'
    )
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.conversations AS conversation
    WHERE conversation.user1_id =
        'adadadad-adad-4ada-8ada-adadadadadad'::uuid
      AND conversation.user2_id =
        'bebebebe-bebe-4beb-8beb-bebebebebebe'::uuid
      AND conversation.last_message_preview IS NULL
      AND conversation.last_message_at = COALESCE(
        conversation.created_at,
        '1970-01-01 00:00:00+00'::timestamptz
      )
  ) THEN
    RAISE EXCEPTION
      'Auth-user FK cascade blocked or left a stale direct-message summary';
  END IF;
END
$auth_user_cascade_proof$;

ALTER TABLE public.direct_messages
  DROP CONSTRAINT direct_messages_sender_id_fkey,
  DROP CONSTRAINT direct_messages_receiver_id_fkey;
ALTER TABLE public.user_profiles
  DROP CONSTRAINT user_profiles_id_auth_users_fkey;
DROP TABLE auth.users;
SQL

psql_cmd -f "$DELETE_MIGRATION" >/dev/null

echo "atomic direct-message delete PostgreSQL 17 tests passed"
