#!/usr/bin/env bash

# PostgreSQL 17 executable proof for the atomic direct-message send boundary.
# It owns an isolated temporary cluster and never connects to an application DB.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716114000_atomic_direct_message_send.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl postgres psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "PostgreSQL 17 is required" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/atomic-direct-message-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55487
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -200 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd <<'SQL'
CREATE ROLE postgres SUPERUSER NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE rogue_role NOLOGIN;

CREATE SCHEMA auth;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb
      ->> 'role'
  )::text
$function$;
CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.sub', true),
    ''
  )::uuid
$function$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role(), auth.uid()
  TO anon, authenticated, service_role;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  dm_permission text DEFAULT 'all',
  deleted_at timestamptz,
  banned_at timestamptz,
  handle text,
  notify_message boolean DEFAULT true,
  CONSTRAINT user_profiles_dm_permission_check
    CHECK (dm_permission IN ('all', 'mutual', 'none'))
);

CREATE TABLE public.blocked_users (
  blocker_id uuid NOT NULL,
  blocked_id uuid NOT NULL,
  created_at timestamptz DEFAULT pg_catalog.now(),
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX idx_blocked_users_blocked
  ON public.blocked_users(blocked_id);

CREATE TABLE public.user_follows (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  follower_id uuid NOT NULL,
  following_id uuid NOT NULL,
  created_at timestamptz DEFAULT pg_catalog.now(),
  UNIQUE (follower_id, following_id)
);

-- Start without ordered-pair uniqueness to prove preflight rollback.
CREATE TABLE public.conversations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user1_id uuid NOT NULL,
  user2_id uuid NOT NULL,
  last_message_at timestamptz DEFAULT pg_catalog.now(),
  last_message_preview text,
  created_at timestamptz DEFAULT pg_catalog.now(),
  CONSTRAINT users_ordered CHECK (user1_id < user2_id)
);

CREATE TABLE public.direct_messages (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  conversation_id uuid NOT NULL
    REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL,
  receiver_id uuid NOT NULL,
  content text NOT NULL,
  read boolean DEFAULT false,
  created_at timestamptz DEFAULT pg_catalog.now(),
  media_url text,
  media_type text,
  media_name text,
  read_at timestamptz,
  deleted_at timestamptz,
  reply_to_id uuid REFERENCES public.direct_messages(id) ON DELETE SET NULL
);
CREATE INDEX idx_dm_sender_receiver
  ON public.direct_messages(sender_id, receiver_id);
CREATE INDEX idx_dm_conversation
  ON public.direct_messages(conversation_id);

CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  link text,
  actor_id uuid,
  reference_id uuid,
  created_at timestamptz DEFAULT pg_catalog.now()
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.blocked_users OWNER TO postgres;
ALTER TABLE public.user_follows OWNER TO postgres;
ALTER TABLE public.conversations OWNER TO postgres;
ALTER TABLE public.direct_messages OWNER TO postgres;
ALTER TABLE public.notifications OWNER TO postgres;

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.direct_messages ENABLE ROW LEVEL SECURITY;

GRANT ALL PRIVILEGES
  ON TABLE public.conversations, public.direct_messages
  TO PUBLIC, anon, authenticated, service_role, rogue_role;
GRANT SELECT (user1_id), INSERT (user1_id), UPDATE (user1_id)
  ON TABLE public.conversations
  TO PUBLIC, anon, authenticated, service_role, rogue_role;
GRANT SELECT (content), INSERT (content), UPDATE (content)
  ON TABLE public.direct_messages
  TO PUBLIC, anon, authenticated, service_role, rogue_role;

CREATE POLICY "legacy conversation read"
  ON public.conversations FOR SELECT TO public USING (true);
CREATE POLICY "legacy conversation insert"
  ON public.conversations FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "legacy conversation update"
  ON public.conversations FOR UPDATE TO public USING (true);
CREATE POLICY "legacy message read"
  ON public.direct_messages FOR SELECT TO public USING (true);
CREATE POLICY "legacy message insert"
  ON public.direct_messages FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "legacy message update"
  ON public.direct_messages FOR UPDATE TO public USING (true);

CREATE FUNCTION public.check_dm_permission(
  p_sender_id uuid,
  p_receiver_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_dm_permission text;
  v_is_mutual boolean := false;
  v_receiver_replied boolean := false;
  v_sent_count bigint := 0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'check_dm_permission is restricted to service_role'
      USING ERRCODE = '42501';
  END IF;

  IF p_sender_id IS NULL OR p_receiver_id IS NULL OR p_sender_id = p_receiver_id THEN
    RAISE EXCEPTION 'invalid sender/receiver IDs' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_profiles AS sender_profile
    WHERE sender_profile.id = p_sender_id
      AND sender_profile.deleted_at IS NULL
      AND sender_profile.banned_at IS NULL
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false,
      'reason', 'SENDER_UNAVAILABLE'
    );
  END IF;

  SELECT receiver_profile.dm_permission
  INTO v_dm_permission
  FROM public.user_profiles AS receiver_profile
  WHERE receiver_profile.id = p_receiver_id
    AND receiver_profile.deleted_at IS NULL
    AND receiver_profile.banned_at IS NULL;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false,
      'reason', 'USER_NOT_FOUND'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.blocked_users AS block_edge
    WHERE (
      block_edge.blocker_id = p_sender_id
      AND block_edge.blocked_id = p_receiver_id
    ) OR (
      block_edge.blocker_id = p_receiver_id
      AND block_edge.blocked_id = p_sender_id
    )
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false,
      'reason', 'BLOCKED'
    );
  END IF;

  IF v_dm_permission IS NULL OR v_dm_permission = 'none' THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false,
      'reason', 'DM_DISABLED'
    );
  END IF;

  IF v_dm_permission = 'all' THEN
    RETURN pg_catalog.jsonb_build_object('allowed', true);
  END IF;

  IF v_dm_permission <> 'mutual' THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false,
      'reason', 'DM_DISABLED'
    );
  END IF;

  SELECT
    EXISTS (
      SELECT 1 FROM public.user_follows AS sender_follow
      WHERE sender_follow.follower_id = p_sender_id
        AND sender_follow.following_id = p_receiver_id
    ) AND EXISTS (
      SELECT 1 FROM public.user_follows AS receiver_follow
      WHERE receiver_follow.follower_id = p_receiver_id
        AND receiver_follow.following_id = p_sender_id
    )
  INTO v_is_mutual;

  IF v_is_mutual THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', true,
      'is_mutual', true
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.direct_messages AS receiver_message
    WHERE receiver_message.sender_id = p_receiver_id
      AND receiver_message.receiver_id = p_sender_id
  ) INTO v_receiver_replied;

  IF v_receiver_replied THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', true,
      'receiver_replied', true
    );
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_sent_count
  FROM public.direct_messages AS sender_message
  WHERE sender_message.sender_id = p_sender_id
    AND sender_message.receiver_id = p_receiver_id;

  RETURN pg_catalog.jsonb_build_object(
    'allowed', v_sent_count < 3,
    'sent_count', v_sent_count,
    'reason', CASE WHEN v_sent_count >= 3 THEN 'LIMIT_REACHED' ELSE NULL END
  );
END
$function$;
ALTER FUNCTION public.check_dm_permission(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.check_dm_permission(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_dm_permission(uuid, uuid)
  TO service_role;

-- Reproduce the legacy definer search path that the migration must harden
-- without changing either trigger's one-row side effect.
CREATE FUNCTION public.update_conversation_on_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  UPDATE conversations
  SET last_message_at = NEW.created_at,
      last_message_preview = LEFT(NEW.content, 100)
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.update_conversation_on_message() OWNER TO postgres;

CREATE FUNCTION public.create_message_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  sender_handle text;
  receiver_notify_message boolean;
BEGIN
  SELECT handle INTO sender_handle
  FROM user_profiles WHERE id = NEW.sender_id;
  SELECT COALESCE(notify_message, true) INTO receiver_notify_message
  FROM user_profiles WHERE id = NEW.receiver_id;
  IF receiver_notify_message THEN
    INSERT INTO notifications (
      user_id, type, title, message, link, actor_id, reference_id
    ) VALUES (
      NEW.receiver_id,
      'message',
      '新私信',
      COALESCE(sender_handle, '有人') || ' 给你发送了一条私信',
      '/messages/' || NEW.conversation_id,
      NEW.sender_id,
      NEW.conversation_id
    );
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.create_message_notification() OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.update_conversation_on_message(),
  public.create_message_notification()
  TO PUBLIC, anon, authenticated, service_role, rogue_role;

CREATE TRIGGER on_dm_sent
AFTER INSERT ON public.direct_messages
FOR EACH ROW EXECUTE FUNCTION public.update_conversation_on_message();
CREATE TRIGGER on_dm_received
AFTER INSERT ON public.direct_messages
FOR EACH ROW EXECUTE FUNCTION public.create_message_notification();

CREATE FUNCTION public.send_direct_message_atomic(p_probe uuid)
RETURNS jsonb
LANGUAGE sql
AS $function$
  SELECT pg_catalog.jsonb_build_object('legacy_probe', p_probe)
$function$;
GRANT EXECUTE ON FUNCTION public.send_direct_message_atomic(uuid)
  TO PUBLIC, anon, authenticated, service_role, rogue_role;
SQL

# Missing ordered-pair uniqueness must fail before any ACL/function mutation.
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/preflight.log" 2>&1; then
  echo "atomic DM migration unexpectedly accepted missing conversation uniqueness" >&2
  exit 1
fi
if ! grep -q 'conversations requires a valid unique' "$TMP_ROOT/preflight.log"; then
  cat "$TMP_ROOT/preflight.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $verify_preflight_rollback$
BEGIN
  IF NOT pg_catalog.has_table_privilege(
    'authenticated',
    'public.direct_messages',
    'INSERT'
  ) OR pg_catalog.to_regprocedure(
    'public.send_direct_message_atomic(uuid)'
  ) IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.direct_messages'::regclass
      AND policy.polname = 'legacy message insert'
  ) OR (
    SELECT function_row.proconfig
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = 'public.create_message_notification()'::regprocedure
  ) <> ARRAY['search_path=public']::text[] THEN
    RAISE EXCEPTION 'preflight failure did not roll back cleanly';
  END IF;
END
$verify_preflight_rollback$;

ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_user1_id_user2_id_key
  UNIQUE (user1_id, user2_id);
SQL

psql_cmd -f "$MIGRATION" >/dev/null

# A differently named trigger targeting either historical side-effect function
# would double notifications/previews. Replay must fail before mutating ACLs.
psql_cmd <<'SQL'
CREATE TRIGGER duplicate_dm_notification
AFTER INSERT ON public.direct_messages
FOR EACH ROW EXECUTE FUNCTION public.create_message_notification();
SQL

if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/duplicate-trigger.log" 2>&1; then
  echo "migration accepted a duplicate DM side-effect trigger" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $duplicate_trigger_rollback$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled <> 'D'
      AND trigger_row.tgtype = 5
      AND trigger_row.tgfoid =
        'public.create_message_notification()'::regprocedure
  ) <> 2 OR NOT pg_catalog.has_table_privilege(
    'authenticated',
    'public.direct_messages',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'duplicate-trigger preflight failure did not roll back';
  END IF;
END
$duplicate_trigger_rollback$;

DROP TRIGGER duplicate_dm_notification ON public.direct_messages;
SQL

# Inject arbitrary ACL/policy/overload drift. Replay must converge all of it.
psql_cmd <<'SQL'
GRANT ALL PRIVILEGES
  ON TABLE public.conversations, public.direct_messages
  TO rogue_role;
GRANT UPDATE (last_message_preview)
  ON TABLE public.conversations
  TO rogue_role;
GRANT UPDATE (content)
  ON TABLE public.direct_messages
  TO rogue_role;
CREATE POLICY "rogue write policy"
  ON public.direct_messages FOR ALL TO rogue_role
  USING (true) WITH CHECK (true);
GRANT EXECUTE ON FUNCTION public.update_conversation_on_message(),
  public.create_message_notification(),
  public.serialize_direct_message_pair_edge(),
  public.validate_direct_message_integrity(),
  public.is_current_user_active_for_direct_messages(),
  public.check_dm_permission(uuid, uuid)
  TO rogue_role;
CREATE FUNCTION public.send_direct_message_atomic(p_probe integer)
RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb';
GRANT EXECUTE ON FUNCTION public.send_direct_message_atomic(integer)
  TO rogue_role;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $catalog_proof$
DECLARE
  v_function regprocedure :=
    'public.send_direct_message_atomic(uuid,uuid,text,text,text,text,uuid)'::regprocedure;
BEGIN
  IF pg_catalog.has_table_privilege(
    'rogue_role',
    'public.conversations',
    'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'rogue_role',
    'public.direct_messages',
    'INSERT'
  ) OR pg_catalog.has_column_privilege(
    'rogue_role',
    'public.direct_messages',
    'content',
    'UPDATE'
  ) THEN
    RAISE EXCEPTION 'arbitrary table/column ACL survived replay';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'send_direct_message_atomic'
  ) <> 1 OR pg_catalog.to_regprocedure(
    'public.send_direct_message_atomic(integer)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'legacy atomic DM overload survived replay';
  END IF;

  IF pg_catalog.has_function_privilege(
    'authenticated',
    v_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'rogue_role',
    v_function,
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    v_function,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'atomic DM function ACL is not service-only';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid IN (
      'public.update_conversation_on_message()'::regprocedure,
      'public.create_message_notification()'::regprocedure
    )
      AND (
        NOT function_row.proconfig @> ARRAY[
          'search_path=pg_catalog, pg_temp',
          'lock_timeout=5s'
        ]::text[]
        OR pg_catalog.cardinality(function_row.proconfig) <> 2
      )
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    'public.update_conversation_on_message()',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    'public.create_message_notification()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'side-effect trigger functions were not hardened';
  END IF;

  IF pg_catalog.has_function_privilege(
    'rogue_role',
    'public.validate_direct_message_integrity()',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'rogue_role',
    'public.check_dm_permission(uuid,uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'rogue_role',
    'public.is_current_user_active_for_direct_messages()',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'authenticated',
    'public.is_current_user_active_for_direct_messages()',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.is_current_user_active_for_direct_messages()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'DM boundary function retained rogue EXECUTE';
  END IF;
END
$catalog_proof$;

INSERT INTO public.user_profiles(
  id, dm_permission, handle, notify_message, deleted_at, banned_at
) VALUES
  ('11111111-1111-4111-8111-111111111111', 'all', 'sender', true, NULL, NULL),
  ('22222222-2222-4222-8222-222222222222', 'all', 'open', true, NULL, NULL),
  ('33333333-3333-4333-8333-333333333333', 'mutual', 'mutual', true, NULL, NULL),
  ('44444444-4444-4444-8444-444444444444', 'none', 'closed', true, NULL, NULL),
  ('55555555-5555-4555-8555-555555555555', 'all', 'deleted', true, pg_catalog.now(), NULL),
  ('66666666-6666-4666-8666-666666666666', 'all', 'banned', true, NULL, pg_catalog.now()),
  ('77777777-7777-4777-8777-777777777777', 'mutual', 'mutual-two', true, NULL, NULL),
  ('88888888-8888-4888-8888-888888888888', 'all', 'other-one', true, NULL, NULL),
  ('99999999-9999-4999-8999-999999999999', 'all', 'other-two', true, NULL, NULL);

SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

DO $permission_and_atomicity$
DECLARE
  v_result jsonb;
  v_first_message uuid;
  v_before_messages bigint;
  v_conversation uuid;
BEGIN
  v_result := public.send_direct_message_atomic(
    '11111111-1111-4111-8111-111111111111',
    '44444444-4444-4444-8444-444444444444',
    'closed'
  );
  IF v_result ->> 'reason' <> 'DM_DISABLED' OR (v_result ->> 'success')::boolean THEN
    RAISE EXCEPTION 'none permission did not fail closed: %', v_result;
  END IF;

  v_result := public.send_direct_message_atomic(
    '55555555-5555-4555-8555-555555555555',
    '22222222-2222-4222-8222-222222222222',
    'deleted sender'
  );
  IF v_result ->> 'reason' <> 'SENDER_UNAVAILABLE' THEN
    RAISE EXCEPTION 'deleted sender was not rejected: %', v_result;
  END IF;

  v_result := public.send_direct_message_atomic(
    '11111111-1111-4111-8111-111111111111',
    '66666666-6666-4666-8666-666666666666',
    'banned receiver'
  );
  IF v_result ->> 'reason' <> 'USER_NOT_FOUND' THEN
    RAISE EXCEPTION 'banned receiver was not rejected: %', v_result;
  END IF;

  v_result := public.send_direct_message_atomic(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'missing receiver'
  );
  IF v_result ->> 'reason' <> 'USER_NOT_FOUND' THEN
    RAISE EXCEPTION 'missing receiver was not rejected: %', v_result;
  END IF;

  INSERT INTO public.blocked_users(blocker_id, blocked_id) VALUES
    ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
  v_result := public.send_direct_message_atomic(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'outbound block'
  );
  IF v_result ->> 'reason' <> 'BLOCKED' THEN
    RAISE EXCEPTION 'sender-side block was ignored: %', v_result;
  END IF;
  DELETE FROM public.blocked_users
  WHERE blocker_id = '11111111-1111-4111-8111-111111111111'
    AND blocked_id = '22222222-2222-4222-8222-222222222222';

  INSERT INTO public.blocked_users(blocker_id, blocked_id) VALUES
    ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111');
  v_result := public.send_direct_message_atomic(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    'inbound block'
  );
  IF v_result ->> 'reason' <> 'BLOCKED' THEN
    RAISE EXCEPTION 'receiver-side block was ignored: %', v_result;
  END IF;
  DELETE FROM public.blocked_users
  WHERE blocker_id = '22222222-2222-4222-8222-222222222222'
    AND blocked_id = '11111111-1111-4111-8111-111111111111';

  v_result := public.send_direct_message_atomic(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '  first hello  ',
    'https://example.test/chat/image.png',
    'IMAGE',
    ' photo.png '
  );
  IF NOT (v_result ->> 'success')::boolean
     OR v_result ->> 'conversation_id' IS NULL
     OR v_result #>> '{message,content}' <> 'first hello'
     OR v_result #>> '{message,media_type}' <> 'image'
     OR v_result #>> '{message,media_name}' <> 'photo.png'
     OR v_result #>> '{message,read}' <> 'false'
  THEN
    RAISE EXCEPTION 'route-compatible success result is wrong: %', v_result;
  END IF;

  v_conversation := (v_result ->> 'conversation_id')::uuid;
  v_first_message := (v_result #>> '{message,id}')::uuid;
  IF (
    SELECT conversation.last_message_preview
    FROM public.conversations AS conversation
    WHERE conversation.id = v_conversation
  ) <> 'first hello' OR (
    SELECT pg_catalog.count(*)
    FROM public.notifications AS notification
    WHERE notification.reference_id = v_conversation
  ) <> 1 THEN
    RAISE EXCEPTION 'summary/notification trigger did not fire exactly once';
  END IF;

  v_result := public.send_direct_message_atomic(
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    'reply',
    NULL,
    NULL,
    NULL,
    v_first_message
  );
  IF NOT (v_result ->> 'success')::boolean
     OR (v_result #>> '{message,reply_to_id}')::uuid <> v_first_message
     OR (v_result ->> 'conversation_id')::uuid <> v_conversation
  THEN
    RAISE EXCEPTION 'valid same-thread reply failed: %', v_result;
  END IF;

  v_result := public.send_direct_message_atomic(
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
    'cross-thread reply',
    NULL,
    NULL,
    NULL,
    v_first_message
  );
  IF v_result ->> 'reason' <> 'INVALID_REPLY_TARGET' OR EXISTS (
    SELECT 1
    FROM public.conversations AS conversation
    WHERE conversation.user1_id = '11111111-1111-4111-8111-111111111111'
      AND conversation.user2_id = '33333333-3333-4333-8333-333333333333'
  ) THEN
    RAISE EXCEPTION 'invalid reply created an empty conversation: %', v_result;
  END IF;

  v_before_messages := (
    SELECT pg_catalog.count(*) FROM public.direct_messages
  );
  BEGIN
    PERFORM public.send_direct_message_atomic(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      '   '
    );
    RAISE EXCEPTION 'blank message unexpectedly succeeded';
  EXCEPTION
    WHEN sqlstate '22023' THEN NULL;
  END;
  BEGIN
    PERFORM public.send_direct_message_atomic(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      'bad media',
      'http://example.test/file',
      'file'
    );
    RAISE EXCEPTION 'HTTP media unexpectedly succeeded';
  EXCEPTION
    WHEN sqlstate '22023' THEN NULL;
  END;
  IF (SELECT pg_catalog.count(*) FROM public.direct_messages) <> v_before_messages THEN
    RAISE EXCEPTION 'invalid fields wrote a message';
  END IF;

  BEGIN
    INSERT INTO public.direct_messages(
      conversation_id,
      sender_id,
      receiver_id,
      content
    ) VALUES (
      v_conversation,
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      'wrong conversation'
    );
    RAISE EXCEPTION 'cross-thread service insert unexpectedly succeeded';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;
END
$permission_and_atomicity$;

-- Three cold messages are allowed; the fourth is denied until the receiver
-- replies. Soft deletion is intentionally irrelevant to the lifetime count.
DO $cold_message_limit$
DECLARE
  v_result jsonb;
  v_attempt integer;
BEGIN
  FOR v_attempt IN 1..3 LOOP
    v_result := public.send_direct_message_atomic(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      'cold ' || v_attempt
    );
    IF NOT (v_result ->> 'success')::boolean THEN
      RAISE EXCEPTION 'cold message % failed: %', v_attempt, v_result;
    END IF;
  END LOOP;

  UPDATE public.direct_messages
  SET deleted_at = pg_catalog.now()
  WHERE sender_id = '11111111-1111-4111-8111-111111111111'
    AND receiver_id = '33333333-3333-4333-8333-333333333333'
    AND content = 'cold 1';

  v_result := public.send_direct_message_atomic(
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
    'cold four'
  );
  IF v_result ->> 'reason' <> 'LIMIT_REACHED'
     OR (v_result ->> 'sent_count')::integer <> 3
  THEN
    RAISE EXCEPTION 'cold-message limit failed: %', v_result;
  END IF;

  v_result := public.send_direct_message_atomic(
    '33333333-3333-4333-8333-333333333333',
    '11111111-1111-4111-8111-111111111111',
    'receiver reply'
  );
  IF NOT (v_result ->> 'success')::boolean THEN
    RAISE EXCEPTION 'receiver reply failed: %', v_result;
  END IF;

  v_result := public.send_direct_message_atomic(
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
    'after reply'
  );
  IF NOT (v_result ->> 'success')::boolean THEN
    RAISE EXCEPTION 'reply did not unlock sender: %', v_result;
  END IF;

  INSERT INTO public.user_follows(follower_id, following_id) VALUES
    ('11111111-1111-4111-8111-111111111111', '77777777-7777-4777-8777-777777777777'),
    ('77777777-7777-4777-8777-777777777777', '11111111-1111-4111-8111-111111111111');
  v_result := public.send_direct_message_atomic(
    '11111111-1111-4111-8111-111111111111',
    '77777777-7777-4777-8777-777777777777',
    'mutual follower message'
  );
  IF NOT (v_result ->> 'success')::boolean THEN
    RAISE EXCEPTION 'mutual followers were rejected: %', v_result;
  END IF;
END
$cold_message_limit$;

-- Seed an unrelated thread for participant-only browser read proof.
SELECT public.send_direct_message_atomic(
  '88888888-8888-4888-8888-888888888888',
  '99999999-9999-4999-8999-999999999999',
  'other private thread'
);

-- Trusted rollout writers can still create structurally valid historical rows
-- for inactive participants. Browser RLS, not API middleware, must hide them.
INSERT INTO public.conversations(user1_id, user2_id) VALUES
  ('22222222-2222-4222-8222-222222222222', '55555555-5555-4555-8555-555555555555'),
  ('22222222-2222-4222-8222-222222222222', '66666666-6666-4666-8666-666666666666');
INSERT INTO public.direct_messages(
  conversation_id, sender_id, receiver_id, content
)
SELECT conversation.id,
  '22222222-2222-4222-8222-222222222222',
  conversation.user2_id,
  'inactive account history'
FROM public.conversations AS conversation
WHERE conversation.user1_id = '22222222-2222-4222-8222-222222222222'
  AND conversation.user2_id IN (
    '55555555-5555-4555-8555-555555555555',
    '66666666-6666-4666-8666-666666666666'
  );
SQL

# Browser RPC and base-table writes must fail at ACL before policy conditions.
if psql_cmd >"$TMP_ROOT/browser-rpc.log" 2>&1 <<'SQL'; then
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT public.send_direct_message_atomic(
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'forged browser RPC'
);
SQL
  echo "authenticated unexpectedly executed atomic DM RPC" >&2
  exit 1
fi

if psql_cmd >"$TMP_ROOT/browser-conversation-write.log" 2>&1 <<'SQL'; then
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '11111111-1111-4111-8111-111111111111',
  false
);
INSERT INTO public.conversations(user1_id, user2_id) VALUES
  ('11111111-1111-4111-8111-111111111111', '99999999-9999-4999-8999-999999999999');
SQL
  echo "authenticated unexpectedly inserted a conversation" >&2
  exit 1
fi

if psql_cmd >"$TMP_ROOT/browser-message-write.log" 2>&1 <<'SQL'; then
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '11111111-1111-4111-8111-111111111111',
  false
);
INSERT INTO public.direct_messages(
  conversation_id, sender_id, receiver_id, content
)
SELECT conversation.id,
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  'forged browser insert'
FROM public.conversations AS conversation
WHERE conversation.user1_id = '11111111-1111-4111-8111-111111111111'
  AND conversation.user2_id = '22222222-2222-4222-8222-222222222222';
SQL
  echo "authenticated unexpectedly inserted a direct message" >&2
  exit 1
fi

psql_cmd <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '11111111-1111-4111-8111-111111111111',
  false
);
DO $browser_read_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.conversations AS conversation
    WHERE '11111111-1111-4111-8111-111111111111' IN (
      conversation.user1_id,
      conversation.user2_id
    )
  ) OR EXISTS (
    SELECT 1
    FROM public.conversations AS conversation
    WHERE conversation.user1_id = '88888888-8888-4888-8888-888888888888'
      AND conversation.user2_id = '99999999-9999-4999-8999-999999999999'
  ) OR EXISTS (
    SELECT 1
    FROM public.direct_messages AS message_row
    WHERE message_row.sender_id = '88888888-8888-4888-8888-888888888888'
  ) OR EXISTS (
    SELECT 1
    FROM public.direct_messages AS message_row
    WHERE message_row.deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'participant-only browser read policy failed';
  END IF;
END
$browser_read_proof$;
RESET ROLE;
SQL

psql_cmd <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '55555555-5555-4555-8555-555555555555',
  false
);
DO $deleted_reader_proof$
BEGIN
  IF public.is_current_user_active_for_direct_messages()
     OR EXISTS (SELECT 1 FROM public.conversations)
     OR EXISTS (SELECT 1 FROM public.direct_messages)
  THEN
    RAISE EXCEPTION 'deleted JWT actor retained direct-message reads';
  END IF;
END
$deleted_reader_proof$;

SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '66666666-6666-4666-8666-666666666666',
  false
);
DO $banned_reader_proof$
BEGIN
  IF public.is_current_user_active_for_direct_messages()
     OR EXISTS (SELECT 1 FROM public.conversations)
     OR EXISTS (SELECT 1 FROM public.direct_messages)
  THEN
    RAISE EXCEPTION 'banned JWT actor retained direct-message reads';
  END IF;
END
$banned_reader_proof$;
RESET ROLE;
SQL

if psql_cmd >"$TMP_ROOT/anon-reader-helper.log" 2>&1 <<'SQL'; then
SET ROLE anon;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'anon', false);
SELECT public.is_current_user_active_for_direct_messages();
SQL
  echo "anon unexpectedly executed active DM reader helper" >&2
  exit 1
fi

# Concurrent third-message attack: two calls start with sent_count=2. Exactly
# one may commit, and the other must observe LIMIT_REACHED after the pair lock.
psql_cmd <<'SQL'
INSERT INTO public.user_profiles(id, dm_permission, handle) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'all', 'race-sender'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'mutual', 'race-receiver'),
  ('cccccccc-0000-4000-8000-000000000003', 'all', 'dedup-sender'),
  ('dddddddd-0000-4000-8000-000000000004', 'all', 'dedup-receiver'),
  ('eeeeeeee-0000-4000-8000-000000000005', 'all', 'block-sender'),
  ('ffffffff-0000-4000-8000-000000000006', 'all', 'block-receiver'),
  ('12121212-1212-4212-8212-121212121212', 'all', 'rollback-sender'),
  ('34343434-3434-4434-8434-343434343434', 'all', 'rollback-receiver');

INSERT INTO public.conversations(user1_id, user2_id) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000002');
INSERT INTO public.direct_messages(
  conversation_id, sender_id, receiver_id, content
)
SELECT conversation.id,
  'aaaaaaaa-0000-4000-8000-000000000001',
  'bbbbbbbb-0000-4000-8000-000000000002',
  seed.content
FROM public.conversations AS conversation
CROSS JOIN (VALUES ('seed one'), ('seed two')) AS seed(content)
WHERE conversation.user1_id = 'aaaaaaaa-0000-4000-8000-000000000001'
  AND conversation.user2_id = 'bbbbbbbb-0000-4000-8000-000000000002';
SQL

for attempt in 1 2; do
  PGAPPNAME="dm_limit_race_$attempt" psql_cmd -At \
    >"$TMP_ROOT/limit-$attempt.log" 2>&1 <<SQL &
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT COALESCE(result ->> 'success', '') || ':' || COALESCE(result ->> 'reason', '')
FROM (
  SELECT public.send_direct_message_atomic(
    'aaaaaaaa-0000-4000-8000-000000000001',
    'bbbbbbbb-0000-4000-8000-000000000002',
    'concurrent $attempt'
  ) AS result
) AS call;
SQL
  limit_pids[$attempt]=$!
done
wait "${limit_pids[1]}"
wait "${limit_pids[2]}"

if [[ "$(cat "$TMP_ROOT/limit-1.log" "$TMP_ROOT/limit-2.log" | grep -E '^(true:|false:LIMIT_REACHED)$' | sort | tr '\n' ' ')" != "false:LIMIT_REACHED true: " ]]; then
  cat "$TMP_ROOT/limit-1.log" "$TMP_ROOT/limit-2.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $limit_concurrency_proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.direct_messages AS message_row
    WHERE message_row.sender_id = 'aaaaaaaa-0000-4000-8000-000000000001'
      AND message_row.receiver_id = 'bbbbbbbb-0000-4000-8000-000000000002'
  ) <> 3 THEN
    RAISE EXCEPTION 'concurrent cold-message limit exceeded three';
  END IF;
END
$limit_concurrency_proof$;
SQL

# Concurrent first sends must create one ordered conversation and two messages.
for attempt in 1 2; do
  PGAPPNAME="dm_conversation_race_$attempt" psql_cmd -At \
    >"$TMP_ROOT/conversation-$attempt.log" 2>&1 <<SQL &
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT result ->> 'success'
FROM (
  SELECT public.send_direct_message_atomic(
    'cccccccc-0000-4000-8000-000000000003',
    'dddddddd-0000-4000-8000-000000000004',
    'first-send race $attempt'
  ) AS result
) AS call;
SQL
  conversation_pids[$attempt]=$!
done
wait "${conversation_pids[1]}"
wait "${conversation_pids[2]}"

if [[ "$(cat "$TMP_ROOT/conversation-1.log" "$TMP_ROOT/conversation-2.log" | grep -c '^true$')" != "2" ]]; then
  cat "$TMP_ROOT/conversation-1.log" "$TMP_ROOT/conversation-2.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $conversation_concurrency_proof$
DECLARE
  v_conversation_id uuid;
BEGIN
  SELECT conversation.id
  INTO STRICT v_conversation_id
  FROM public.conversations AS conversation
  WHERE conversation.user1_id = 'cccccccc-0000-4000-8000-000000000003'
    AND conversation.user2_id = 'dddddddd-0000-4000-8000-000000000004';

  IF (
    SELECT pg_catalog.count(*)
    FROM public.direct_messages AS message_row
    WHERE message_row.conversation_id = v_conversation_id
  ) <> 2 OR (
    SELECT pg_catalog.count(*)
    FROM public.conversations AS conversation
    WHERE conversation.user1_id = 'cccccccc-0000-4000-8000-000000000003'
      AND conversation.user2_id = 'dddddddd-0000-4000-8000-000000000004'
  ) <> 1 THEN
    RAISE EXCEPTION 'concurrent first send duplicated conversation state';
  END IF;
END
$conversation_concurrency_proof$;
SQL

# A block edge must wait on the same advisory key used by a send.
PGAPPNAME=dm_pair_gate psql_cmd >/dev/null 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'direct-message:pair:'
      || 'eeeeeeee-0000-4000-8000-000000000005'
      || ':'
      || 'ffffffff-0000-4000-8000-000000000006',
    0
  )
);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
gate_pid=$!

for _ in {1..50}; do
  if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE application_name='dm_pair_gate' AND state='active'")" == "1" ]]; then
    break
  fi
  sleep 0.05
done

PGAPPNAME=dm_block_writer psql_cmd >/dev/null 2>&1 <<'SQL' &
INSERT INTO public.blocked_users(blocker_id, blocked_id) VALUES
  ('ffffffff-0000-4000-8000-000000000006', 'eeeeeeee-0000-4000-8000-000000000005');
SQL
block_pid=$!

block_wait_seen=false
for _ in {1..50}; do
  if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE application_name='dm_block_writer' AND wait_event_type='Lock' AND wait_event='advisory'")" == "1" ]]; then
    block_wait_seen=true
    break
  fi
  sleep 0.05
done

wait "$gate_pid"
wait "$block_pid"
if [[ "$block_wait_seen" != true ]]; then
  echo "block edge did not wait on the direct-message pair lock" >&2
  exit 1
fi

psql_cmd <<'SQL'
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $blocked_after_serialization$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.send_direct_message_atomic(
    'eeeeeeee-0000-4000-8000-000000000005',
    'ffffffff-0000-4000-8000-000000000006',
    'must be blocked'
  );
  IF v_result ->> 'reason' <> 'BLOCKED' OR EXISTS (
    SELECT 1
    FROM public.conversations AS conversation
    WHERE conversation.user1_id = 'eeeeeeee-0000-4000-8000-000000000005'
      AND conversation.user2_id = 'ffffffff-0000-4000-8000-000000000006'
  ) THEN
    RAISE EXCEPTION 'serialized block did not prevent send/empty conversation: %', v_result;
  END IF;
END
$blocked_after_serialization$;

CREATE FUNCTION public.force_atomic_dm_rollback()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.content = 'force rollback' THEN
    RAISE EXCEPTION 'forced downstream DM failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER zz_force_atomic_dm_rollback
AFTER INSERT ON public.direct_messages
FOR EACH ROW EXECUTE FUNCTION public.force_atomic_dm_rollback();

DO $rollback_proof$
DECLARE
  v_failed boolean := false;
BEGIN
  BEGIN
    PERFORM public.send_direct_message_atomic(
      '12121212-1212-4212-8212-121212121212',
      '34343434-3434-4434-8434-343434343434',
      'force rollback'
    );
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM = 'forced downstream DM failure' THEN
        v_failed := true;
      ELSE
        RAISE;
      END IF;
  END;

  IF NOT v_failed OR EXISTS (
    SELECT 1
    FROM public.conversations AS conversation
    WHERE conversation.user1_id = '12121212-1212-4212-8212-121212121212'
      AND conversation.user2_id = '34343434-3434-4434-8434-343434343434'
  ) OR EXISTS (
    SELECT 1
    FROM public.direct_messages AS message_row
    WHERE message_row.sender_id = '12121212-1212-4212-8212-121212121212'
      AND message_row.receiver_id = '34343434-3434-4434-8434-343434343434'
  ) OR EXISTS (
    SELECT 1
    FROM public.notifications AS notification
    WHERE notification.actor_id = '12121212-1212-4212-8212-121212121212'
      AND notification.user_id = '34343434-3434-4434-8434-343434343434'
  ) THEN
    RAISE EXCEPTION 'downstream trigger failure did not roll back all DM state';
  END IF;
END
$rollback_proof$;

DROP TRIGGER zz_force_atomic_dm_rollback ON public.direct_messages;
DROP FUNCTION public.force_atomic_dm_rollback();
SQL

echo "atomic direct-message PostgreSQL 17 proof passed"
