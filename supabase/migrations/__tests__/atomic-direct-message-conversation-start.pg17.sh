#!/usr/bin/env bash

# PostgreSQL 17 proof for atomic direct-message admission and canonical
# conversation creation. This owns an isolated temporary cluster and never
# touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729159000_atomic_direct_message_conversation_start.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-dm-start-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((62500 + ($$ % 1000)))
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

expect_failure() {
  local sql=$1
  if psql_cmd -c "$sql" >"$TMP_ROOT/expected-failure.out" 2>&1; then
    echo "Expected SQL to fail: $sql" >&2
    return 1
  fi
}

assert_scalar() {
  local expected=$1
  local sql=$2
  local actual
  actual="$(psql_cmd -Atqc "$sql")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Expected [$expected], received [$actual] for: $sql" >&2
    return 1
  fi
}

wait_for_query() {
  local pattern=$1
  local attempts=0
  while ((attempts < 150)); do
    if [[ "$(psql_cmd -Atqc "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query LIKE '%${pattern}%' AND state = 'active')")" == "t" ]]; then
      return 0
    fi
    attempts=$((attempts + 1))
  done
  echo "Timed out waiting for query pattern: $pattern" >&2
  return 1
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
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;

CREATE FUNCTION public.install_active_authenticated_subject_mutation_barriers()
RETURNS integer
LANGUAGE sql
AS $function$ SELECT 1 $function$;
CREATE FUNCTION public.assert_active_authenticated_subject_mutation_barriers()
RETURNS integer
LANGUAGE sql
AS $function$ SELECT 1 $function$;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  handle text NOT NULL,
  dm_permission text,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz
);
CREATE TABLE public.conversations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user1_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user2_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  UNIQUE (user1_id, user2_id),
  CHECK (user1_id < user2_id)
);
CREATE TABLE public.blocked_users (
  blocker_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE TABLE public.user_follows (
  follower_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  following_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (follower_id, following_id)
);
CREATE TABLE public.direct_messages (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  receiver_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content text NOT NULL
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.conversations OWNER TO postgres;
ALTER TABLE public.blocked_users OWNER TO postgres;
ALTER TABLE public.user_follows OWNER TO postgres;
ALTER TABLE public.direct_messages OWNER TO postgres;

CREATE FUNCTION public.serialize_direct_message_pair_edge()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_left uuid;
  v_right uuid;
  v_pair text;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'blocked_users' THEN
      IF TG_OP = 'DELETE' THEN
        v_left := OLD.blocker_id;
        v_right := OLD.blocked_id;
      ELSE
        v_left := NEW.blocker_id;
        v_right := NEW.blocked_id;
      END IF;
    WHEN 'user_follows' THEN
      IF TG_OP = 'DELETE' THEN
        v_left := OLD.follower_id;
        v_right := OLD.following_id;
      ELSE
        v_left := NEW.follower_id;
        v_right := NEW.following_id;
      END IF;
    WHEN 'direct_messages' THEN
      IF TG_OP = 'DELETE' THEN
        v_left := OLD.sender_id;
        v_right := OLD.receiver_id;
      ELSE
        v_left := NEW.sender_id;
        v_right := NEW.receiver_id;
      END IF;
    ELSE
      RAISE EXCEPTION 'unsupported direct-message pair table';
  END CASE;

  v_pair := LEAST(v_left::text, v_right::text)
    || ':' || GREATEST(v_left::text, v_right::text);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('direct-message:pair:' || v_pair, 0)
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
ALTER FUNCTION public.serialize_direct_message_pair_edge() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.serialize_direct_message_pair_edge()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_serialize_dm_block_pair
BEFORE INSERT OR UPDATE OR DELETE ON public.blocked_users
FOR EACH ROW EXECUTE FUNCTION public.serialize_direct_message_pair_edge();
CREATE TRIGGER trg_serialize_dm_follow_pair
BEFORE INSERT OR UPDATE OR DELETE ON public.user_follows
FOR EACH ROW EXECUTE FUNCTION public.serialize_direct_message_pair_edge();
CREATE TRIGGER trg_serialize_dm_message_pair
BEFORE INSERT OR UPDATE OR DELETE ON public.direct_messages
FOR EACH ROW EXECUTE FUNCTION public.serialize_direct_message_pair_edge();

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
  v_is_mutual boolean;
  v_receiver_replied boolean;
  v_sent_count bigint;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_profiles AS sender_profile
    WHERE sender_profile.id = p_sender_id
      AND sender_profile.deleted_at IS NULL
      AND sender_profile.banned_at IS NULL
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false, 'reason', 'SENDER_UNAVAILABLE'
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
      'allowed', false, 'reason', 'USER_NOT_FOUND'
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.blocked_users AS block_edge
    WHERE (block_edge.blocker_id = p_sender_id AND block_edge.blocked_id = p_receiver_id)
       OR (block_edge.blocker_id = p_receiver_id AND block_edge.blocked_id = p_sender_id)
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false, 'reason', 'BLOCKED'
    );
  END IF;

  IF v_dm_permission IS NULL OR v_dm_permission = 'none' THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false, 'reason', 'DM_DISABLED'
    );
  END IF;
  IF v_dm_permission = 'all' THEN
    RETURN pg_catalog.jsonb_build_object('allowed', true);
  END IF;
  IF v_dm_permission <> 'mutual' THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false, 'reason', 'DM_DISABLED'
    );
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.user_follows AS sender_follow
    WHERE sender_follow.follower_id = p_sender_id
      AND sender_follow.following_id = p_receiver_id
  ) AND EXISTS (
    SELECT 1 FROM public.user_follows AS receiver_follow
    WHERE receiver_follow.follower_id = p_receiver_id
      AND receiver_follow.following_id = p_sender_id
  ) INTO v_is_mutual;
  IF v_is_mutual THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', true, 'is_mutual', true
    );
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.direct_messages AS receiver_message
    WHERE receiver_message.sender_id = p_receiver_id
      AND receiver_message.receiver_id = p_sender_id
  ) INTO v_receiver_replied;
  IF v_receiver_replied THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', true, 'receiver_replied', true
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
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

expect_failure "SET ROLE authenticated; SET request.jwt.claim.role='authenticated'; SELECT public.start_direct_message_conversation_atomic('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222')"
expect_failure "SET ROLE rogue_role; SELECT public.start_direct_message_conversation_atomic('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222')"

psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('31111111-1111-4111-8111-111111111111'),
  ('32222222-2222-4222-8222-222222222222'),
  ('41111111-1111-4111-8111-111111111111'),
  ('42222222-2222-4222-8222-222222222222'),
  ('51111111-1111-4111-8111-111111111111'),
  ('52222222-2222-4222-8222-222222222222'),
  ('61111111-1111-4111-8111-111111111111'),
  ('62222222-2222-4222-8222-222222222222'),
  ('71111111-1111-4111-8111-111111111111'),
  ('72222222-2222-4222-8222-222222222222'),
  ('81111111-1111-4111-8111-111111111111'),
  ('82222222-2222-4222-8222-222222222222');

INSERT INTO public.user_profiles(id, handle, dm_permission) VALUES
  ('11111111-1111-4111-8111-111111111111', 'sender', 'all'),
  ('22222222-2222-4222-8222-222222222222', 'receiver', 'all'),
  ('31111111-1111-4111-8111-111111111111', 'limit_sender', 'all'),
  ('32222222-2222-4222-8222-222222222222', 'limit_receiver', 'mutual'),
  ('41111111-1111-4111-8111-111111111111', 'race_sender', 'all'),
  ('42222222-2222-4222-8222-222222222222', 'race_receiver', 'all'),
  ('51111111-1111-4111-8111-111111111111', 'block_sender', 'all'),
  ('52222222-2222-4222-8222-222222222222', 'block_receiver', 'all'),
  ('61111111-1111-4111-8111-111111111111', 'privacy_sender', 'all'),
  ('62222222-2222-4222-8222-222222222222', 'privacy_receiver', 'all'),
  ('71111111-1111-4111-8111-111111111111', 'ban_sender', 'all'),
  ('72222222-2222-4222-8222-222222222222', 'ban_receiver', 'all'),
  ('81111111-1111-4111-8111-111111111111', 'delete_sender', 'all'),
  ('82222222-2222-4222-8222-222222222222', 'delete_receiver', 'all');

INSERT INTO public.conversations(id, user1_id, user2_id) VALUES (
  '30000000-0000-4000-8000-000000000001',
  '31111111-1111-4111-8111-111111111111',
  '32222222-2222-4222-8222-222222222222'
);
INSERT INTO public.direct_messages(
  id, conversation_id, sender_id, receiver_id, content
) VALUES
  (
    '30000000-0000-4000-8000-000000000011',
    '30000000-0000-4000-8000-000000000001',
    '31111111-1111-4111-8111-111111111111',
    '32222222-2222-4222-8222-222222222222',
    'one'
  ),
  (
    '30000000-0000-4000-8000-000000000012',
    '30000000-0000-4000-8000-000000000001',
    '31111111-1111-4111-8111-111111111111',
    '32222222-2222-4222-8222-222222222222',
    'two'
  ),
  (
    '30000000-0000-4000-8000-000000000013',
    '30000000-0000-4000-8000-000000000001',
    '31111111-1111-4111-8111-111111111111',
    '32222222-2222-4222-8222-222222222222',
    'three'
  );
SQL

created="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.start_direct_message_conversation_atomic('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222')")"
if [[ "$created" != *'"success": true'* ]] \
  || [[ "$created" != *'"created": true'* ]] \
  || [[ "$created" != *'"can_message": true'* ]] \
  || [[ "$created" != *'"receiver_handle": "receiver"'* ]]; then
  echo "Unexpected direct-message start acknowledgement: $created" >&2
  exit 1
fi

replayed="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.start_direct_message_conversation_atomic('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222')")"
if [[ "$replayed" != *'"success": true'* ]] \
  || [[ "$replayed" != *'"created": false'* ]]; then
  echo "Conversation replay was not idempotent: $replayed" >&2
  exit 1
fi
assert_scalar '1' "SELECT count(*) FROM public.conversations WHERE user1_id='11111111-1111-4111-8111-111111111111' AND user2_id='22222222-2222-4222-8222-222222222222'"

limited="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.start_direct_message_conversation_atomic('31111111-1111-4111-8111-111111111111','32222222-2222-4222-8222-222222222222')")"
if [[ "$limited" != *'"success": true'* ]] \
  || [[ "$limited" != *'"can_message": false'* ]] \
  || [[ "$limited" != *'"reached": true'* ]] \
  || [[ "$limited" != *'"sent": 3'* ]] \
  || [[ "$limited" != *'"created": false'* ]]; then
  echo "Message-limit acknowledgement drifted: $limited" >&2
  exit 1
fi

# Two starts for the same fresh pair must return one canonical row. The first
# transaction retains the pair lock after RPC return so the second is a real
# waiter, not a sequential smoke test.
psql_cmd >"$TMP_ROOT/create-a.out" 2>&1 <<'SQL' &
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.start_direct_message_conversation_atomic(
  '41111111-1111-4111-8111-111111111111',
  '42222222-2222-4222-8222-222222222222'
);
SELECT pg_catalog.pg_sleep(1) /* dm_start_create_hold */;
COMMIT;
SQL
create_a_pid=$!
wait_for_query 'dm_start_create_hold'
psql_cmd >"$TMP_ROOT/create-b.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.start_direct_message_conversation_atomic(
  '41111111-1111-4111-8111-111111111111',
  '42222222-2222-4222-8222-222222222222'
);
SQL
create_b_pid=$!
wait "$create_a_pid"
wait "$create_b_pid"
if ! grep -Fq '"created": true' "$TMP_ROOT/create-a.out" \
  || ! grep -Fq '"created": false' "$TMP_ROOT/create-b.out"; then
  echo "Concurrent conversation start did not linearize" >&2
  cat "$TMP_ROOT/create-a.out" "$TMP_ROOT/create-b.out" >&2
  exit 1
fi
assert_scalar '1' "SELECT count(*) FROM public.conversations WHERE user1_id='41111111-1111-4111-8111-111111111111' AND user2_id='42222222-2222-4222-8222-222222222222'"

# A block that wins the shared pair serializer must be visible before the
# waiter can admit or create a relationship.
psql_cmd >"$TMP_ROOT/block-owner.out" 2>&1 <<'SQL' &
BEGIN;
INSERT INTO public.blocked_users(blocker_id, blocked_id) VALUES (
  '52222222-2222-4222-8222-222222222222',
  '51111111-1111-4111-8111-111111111111'
);
SELECT pg_catalog.pg_sleep(1) /* dm_start_block_hold */;
COMMIT;
SQL
block_pid=$!
wait_for_query 'dm_start_block_hold'
psql_cmd >"$TMP_ROOT/block-waiter.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.start_direct_message_conversation_atomic(
  '51111111-1111-4111-8111-111111111111',
  '52222222-2222-4222-8222-222222222222'
);
SQL
block_waiter_pid=$!
wait "$block_pid"
wait "$block_waiter_pid"
if ! grep -Fq '"reason": "BLOCKED"' "$TMP_ROOT/block-waiter.out"; then
  echo "Concurrent block was not observed" >&2
  cat "$TMP_ROOT/block-waiter.out" >&2
  exit 1
fi
assert_scalar '0' "SELECT count(*) FROM public.conversations WHERE user1_id='51111111-1111-4111-8111-111111111111' AND user2_id='52222222-2222-4222-8222-222222222222'"

# Receiver privacy owns its profile row. If privacy commits first, the start
# waiter must report DM_DISABLED without an empty conversation.
psql_cmd >"$TMP_ROOT/privacy-owner.out" 2>&1 <<'SQL' &
BEGIN;
UPDATE public.user_profiles
SET dm_permission = 'none'
WHERE id = '62222222-2222-4222-8222-222222222222';
SELECT pg_catalog.pg_sleep(1) /* dm_start_privacy_hold */;
COMMIT;
SQL
privacy_pid=$!
wait_for_query 'dm_start_privacy_hold'
psql_cmd >"$TMP_ROOT/privacy-waiter.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.start_direct_message_conversation_atomic(
  '61111111-1111-4111-8111-111111111111',
  '62222222-2222-4222-8222-222222222222'
);
SQL
privacy_waiter_pid=$!
wait "$privacy_pid"
wait "$privacy_waiter_pid"
if ! grep -Fq '"reason": "DM_DISABLED"' "$TMP_ROOT/privacy-waiter.out"; then
  echo "Concurrent privacy change was not observed" >&2
  cat "$TMP_ROOT/privacy-waiter.out" >&2
  exit 1
fi
assert_scalar '0' "SELECT count(*) FROM public.conversations WHERE user1_id='61111111-1111-4111-8111-111111111111' AND user2_id='62222222-2222-4222-8222-222222222222'"

# Modern ban transitions share the lifecycle admission key. A winning ban can
# never be bypassed by the older check_dm_permission definition.
psql_cmd >"$TMP_ROOT/ban-owner.out" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:72222222-2222-4222-8222-222222222222',
    0
  )
);
UPDATE public.user_profiles
SET is_banned = true, ban_expires_at = NULL
WHERE id = '72222222-2222-4222-8222-222222222222';
SELECT pg_catalog.pg_sleep(1) /* dm_start_ban_hold */;
COMMIT;
SQL
ban_pid=$!
wait_for_query 'dm_start_ban_hold'
psql_cmd >"$TMP_ROOT/ban-waiter.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.start_direct_message_conversation_atomic(
  '71111111-1111-4111-8111-111111111111',
  '72222222-2222-4222-8222-222222222222'
);
SQL
ban_waiter_pid=$!
wait "$ban_pid"
wait "$ban_waiter_pid"
if ! grep -Fq '"reason": "USER_NOT_FOUND"' "$TMP_ROOT/ban-waiter.out"; then
  echo "Concurrent modern ban was not observed" >&2
  cat "$TMP_ROOT/ban-waiter.out" >&2
  exit 1
fi
assert_scalar '0' "SELECT count(*) FROM public.conversations WHERE user1_id='71111111-1111-4111-8111-111111111111' AND user2_id='72222222-2222-4222-8222-222222222222'"

# Hard deletion owns the same admission key and removes the auth parent before
# the waiter takes KEY SHARE. No orphan relationship can be inserted.
psql_cmd >"$TMP_ROOT/delete-owner.out" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:82222222-2222-4222-8222-222222222222',
    0
  )
);
DELETE FROM auth.users
WHERE id = '82222222-2222-4222-8222-222222222222';
SELECT pg_catalog.pg_sleep(1) /* dm_start_account_delete_hold */;
COMMIT;
SQL
delete_pid=$!
wait_for_query 'dm_start_account_delete_hold'
psql_cmd >"$TMP_ROOT/delete-waiter.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.start_direct_message_conversation_atomic(
  '81111111-1111-4111-8111-111111111111',
  '82222222-2222-4222-8222-222222222222'
);
SQL
delete_waiter_pid=$!
wait "$delete_pid"
wait "$delete_waiter_pid"
if ! grep -Fq '"reason": "USER_NOT_FOUND"' "$TMP_ROOT/delete-waiter.out"; then
  echo "Concurrent account deletion was not observed" >&2
  cat "$TMP_ROOT/delete-waiter.out" >&2
  exit 1
fi
assert_scalar '0' "SELECT count(*) FROM public.conversations WHERE user1_id='81111111-1111-4111-8111-111111111111' AND user2_id='82222222-2222-4222-8222-222222222222'"

# A dependency exception must roll back the entire start call. The pair below
# is fresh so zero rows is direct rollback evidence.
psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.check_dm_permission(
  p_sender_id uuid,
  p_receiver_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'injected permission failure';
END
$function$;
ALTER FUNCTION public.check_dm_permission(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.check_dm_permission(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_dm_permission(uuid, uuid)
  TO service_role;
SQL
expect_failure "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.start_direct_message_conversation_atomic('11111111-1111-4111-8111-111111111111','31111111-1111-4111-8111-111111111111')"
assert_scalar '0' "SELECT count(*) FROM public.conversations WHERE user1_id='11111111-1111-4111-8111-111111111111' AND user2_id='31111111-1111-4111-8111-111111111111'"

echo "atomic direct-message conversation-start PostgreSQL 17 checks passed"
