#!/usr/bin/env bash

# PostgreSQL 17 proof for atomic, participant-bound direct-message read state.
# This owns an isolated temporary cluster and never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729161500_atomic_direct_message_conversation_read.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-dm-read-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((63500 + ($$ % 1000)))
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
  content text NOT NULL,
  read boolean DEFAULT false,
  read_at timestamptz,
  deleted_at timestamptz
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.conversations OWNER TO postgres;
ALTER TABLE public.blocked_users OWNER TO postgres;
ALTER TABLE public.user_follows OWNER TO postgres;
ALTER TABLE public.direct_messages OWNER TO postgres;

GRANT SELECT ON public.user_profiles, public.conversations,
  public.blocked_users, public.user_follows, public.direct_messages
  TO service_role;
GRANT UPDATE ON public.direct_messages TO service_role;
GRANT SELECT ON public.direct_messages TO authenticated;

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
BEFORE INSERT OR DELETE OR UPDATE OF sender_id, receiver_id, deleted_at
ON public.direct_messages
FOR EACH ROW EXECUTE FUNCTION public.serialize_direct_message_pair_edge();

CREATE FUNCTION public.guard_direct_message_immutable_fields()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  IF (
    pg_catalog.to_jsonb(NEW)
      - ARRAY['read', 'read_at', 'deleted_at']::text[]
  ) IS DISTINCT FROM (
    pg_catalog.to_jsonb(OLD)
      - ARRAY['read', 'read_at', 'deleted_at']::text[]
  ) THEN
    RAISE EXCEPTION 'direct-message immutable field changed';
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.guard_direct_message_immutable_fields() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_direct_message_immutable_fields()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_guard_dm_immutable_fields
BEFORE UPDATE ON public.direct_messages
FOR EACH ROW EXECUTE FUNCTION public.guard_direct_message_immutable_fields();
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

expect_failure "SET ROLE authenticated; SET request.jwt.claim.role='authenticated'; SELECT public.mark_direct_message_conversation_read_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111')"
expect_failure "SET ROLE rogue_role; SELECT public.mark_direct_message_conversation_read_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111')"
expect_failure "SET ROLE authenticated; UPDATE public.direct_messages SET read=true"

psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('12222222-2222-4222-8222-222222222222'),
  ('13333333-3333-4333-8333-333333333333'),
  ('21111111-1111-4111-8111-111111111111'),
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
  ('72222222-2222-4222-8222-222222222222');

INSERT INTO public.user_profiles(id)
SELECT auth_user.id FROM auth.users AS auth_user;

INSERT INTO public.conversations(id, user1_id, user2_id) VALUES
  (
    'a0000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '12222222-2222-4222-8222-222222222222'
  ),
  (
    'a0000000-0000-4000-8000-000000000002',
    '21111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222'
  ),
  (
    'a0000000-0000-4000-8000-000000000003',
    '31111111-1111-4111-8111-111111111111',
    '32222222-2222-4222-8222-222222222222'
  ),
  (
    'a0000000-0000-4000-8000-000000000004',
    '41111111-1111-4111-8111-111111111111',
    '42222222-2222-4222-8222-222222222222'
  ),
  (
    'a0000000-0000-4000-8000-000000000005',
    '51111111-1111-4111-8111-111111111111',
    '52222222-2222-4222-8222-222222222222'
  ),
  (
    'a0000000-0000-4000-8000-000000000006',
    '61111111-1111-4111-8111-111111111111',
    '62222222-2222-4222-8222-222222222222'
  ),
  (
    'a0000000-0000-4000-8000-000000000007',
    '71111111-1111-4111-8111-111111111111',
    '72222222-2222-4222-8222-222222222222'
  );

INSERT INTO public.direct_messages(
  id, conversation_id, sender_id, receiver_id, content, read, read_at, deleted_at
) VALUES
  (
    'b0000000-0000-4000-8000-000000000001',
    'a0000000-0000-4000-8000-000000000001',
    '12222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    'unread false', false, NULL, NULL
  ),
  (
    'b0000000-0000-4000-8000-000000000002',
    'a0000000-0000-4000-8000-000000000001',
    '12222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    'legacy null', NULL, NULL, NULL
  ),
  (
    'b0000000-0000-4000-8000-000000000003',
    'a0000000-0000-4000-8000-000000000001',
    '12222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    'already read', true, '2026-07-29T00:00:00Z', NULL
  ),
  (
    'b0000000-0000-4000-8000-000000000004',
    'a0000000-0000-4000-8000-000000000001',
    '12222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    'deleted unread', false, NULL, '2026-07-29T00:00:00Z'
  ),
  (
    'b0000000-0000-4000-8000-000000000005',
    'a0000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '12222222-2222-4222-8222-222222222222',
    'outbound unread', false, NULL, NULL
  ),
  (
    'b0000000-0000-4000-8000-000000000021',
    'a0000000-0000-4000-8000-000000000002',
    '22222222-2222-4222-8222-222222222222',
    '21111111-1111-4111-8111-111111111111',
    'concurrent one', false, NULL, NULL
  ),
  (
    'b0000000-0000-4000-8000-000000000022',
    'a0000000-0000-4000-8000-000000000002',
    '22222222-2222-4222-8222-222222222222',
    '21111111-1111-4111-8111-111111111111',
    'concurrent two', false, NULL, NULL
  ),
  (
    'b0000000-0000-4000-8000-000000000031',
    'a0000000-0000-4000-8000-000000000003',
    '32222222-2222-4222-8222-222222222222',
    '31111111-1111-4111-8111-111111111111',
    'conversation delete', false, NULL, NULL
  ),
  (
    'b0000000-0000-4000-8000-000000000041',
    'a0000000-0000-4000-8000-000000000004',
    '42222222-2222-4222-8222-222222222222',
    '41111111-1111-4111-8111-111111111111',
    'ban actor', false, NULL, NULL
  ),
  (
    'b0000000-0000-4000-8000-000000000051',
    'a0000000-0000-4000-8000-000000000005',
    '52222222-2222-4222-8222-222222222222',
    '51111111-1111-4111-8111-111111111111',
    'delete actor', false, NULL, NULL
  ),
  (
    'b0000000-0000-4000-8000-000000000061',
    'a0000000-0000-4000-8000-000000000006',
    '62222222-2222-4222-8222-222222222222',
    '61111111-1111-4111-8111-111111111111',
    'rollback one', false, NULL, NULL
  ),
  (
    'b0000000-0000-4000-8000-000000000062',
    'a0000000-0000-4000-8000-000000000006',
    '62222222-2222-4222-8222-222222222222',
    '61111111-1111-4111-8111-111111111111',
    'rollback two', false, NULL, NULL
  );
SQL

marked="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.mark_direct_message_conversation_read_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111')")"
if [[ "$marked" != *'"success": true'* ]] \
  || [[ "$marked" != *'"actor_id": "11111111-1111-4111-8111-111111111111"'* ]] \
  || [[ "$marked" != *'"conversation_id": "a0000000-0000-4000-8000-000000000001"'* ]] \
  || [[ "$marked" != *'"marked_count": 2'* ]] \
  || [[ "$marked" != *'"read_at":'* ]]; then
  echo "Unexpected mark-read acknowledgement: $marked" >&2
  exit 1
fi
assert_scalar '3|1|1|1' "SELECT (SELECT count(*) FROM public.direct_messages WHERE conversation_id='a0000000-0000-4000-8000-000000000001' AND receiver_id='11111111-1111-4111-8111-111111111111' AND deleted_at IS NULL AND read IS TRUE AND read_at IS NOT NULL) || '|' || (SELECT count(*) FROM public.direct_messages WHERE id='b0000000-0000-4000-8000-000000000004' AND read IS FALSE AND read_at IS NULL) || '|' || (SELECT count(*) FROM public.direct_messages WHERE id='b0000000-0000-4000-8000-000000000005' AND read IS FALSE) || '|' || (SELECT count(DISTINCT read_at) FROM public.direct_messages WHERE id IN ('b0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000002'))"

replayed="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.mark_direct_message_conversation_read_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111')")"
if [[ "$replayed" != *'"success": true'* ]] \
  || [[ "$replayed" != *'"marked_count": 0'* ]]; then
  echo "Mark-read replay was not idempotent: $replayed" >&2
  exit 1
fi

outsider="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.mark_direct_message_conversation_read_atomic('a0000000-0000-4000-8000-000000000001','13333333-3333-4333-8333-333333333333')")"
if [[ "$outsider" != *'"reason": "NOT_FOUND"'* ]]; then
  echo "Non-participant was not denied: $outsider" >&2
  exit 1
fi

# Concurrent idempotent requests serialize on the pair. Exactly one marks the
# rows and the retry observes the final state without a second transition.
psql_cmd >"$TMP_ROOT/read-a.out" 2>&1 <<'SQL' &
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.mark_direct_message_conversation_read_atomic(
  'a0000000-0000-4000-8000-000000000002',
  '21111111-1111-4111-8111-111111111111'
);
SELECT pg_catalog.pg_sleep(1) /* dm_read_idempotent_hold */;
COMMIT;
SQL
read_a_pid=$!
wait_for_query 'dm_read_idempotent_hold'
psql_cmd >"$TMP_ROOT/read-b.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.mark_direct_message_conversation_read_atomic(
  'a0000000-0000-4000-8000-000000000002',
  '21111111-1111-4111-8111-111111111111'
);
SQL
read_b_pid=$!
wait "$read_a_pid"
wait "$read_b_pid"
if ! grep -Fq '"marked_count": 2' "$TMP_ROOT/read-a.out" \
  || ! grep -Fq '"marked_count": 0' "$TMP_ROOT/read-b.out"; then
  echo "Concurrent mark-read requests did not linearize" >&2
  cat "$TMP_ROOT/read-a.out" "$TMP_ROOT/read-b.out" >&2
  exit 1
fi
assert_scalar '2' "SELECT count(*) FROM public.direct_messages WHERE conversation_id='a0000000-0000-4000-8000-000000000002' AND read IS TRUE AND read_at IS NOT NULL"

# If conversation deletion wins the parent row, a discovery snapshot cannot
# authorize a stale child update after the waiter resumes.
psql_cmd >"$TMP_ROOT/conversation-delete-owner.out" 2>&1 <<'SQL' &
BEGIN;
DELETE FROM public.conversations
WHERE id = 'a0000000-0000-4000-8000-000000000003';
SELECT pg_catalog.pg_sleep(1) /* dm_read_conversation_delete_hold */;
COMMIT;
SQL
conversation_delete_pid=$!
wait_for_query 'dm_read_conversation_delete_hold'
psql_cmd >"$TMP_ROOT/conversation-delete-waiter.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.mark_direct_message_conversation_read_atomic(
  'a0000000-0000-4000-8000-000000000003',
  '31111111-1111-4111-8111-111111111111'
);
SQL
conversation_delete_waiter_pid=$!
wait "$conversation_delete_pid"
wait "$conversation_delete_waiter_pid"
if ! grep -Fq '"reason": "NOT_FOUND"' "$TMP_ROOT/conversation-delete-waiter.out"; then
  echo "Concurrent conversation deletion was not observed" >&2
  cat "$TMP_ROOT/conversation-delete-waiter.out" >&2
  exit 1
fi
assert_scalar '0' "SELECT count(*) FROM public.direct_messages WHERE conversation_id='a0000000-0000-4000-8000-000000000003'"

# A modern ban that wins lifecycle admission must prevent every read mutation.
psql_cmd >"$TMP_ROOT/ban-owner.out" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:41111111-1111-4111-8111-111111111111',
    0
  )
);
UPDATE public.user_profiles
SET is_banned = true, ban_expires_at = NULL
WHERE id = '41111111-1111-4111-8111-111111111111';
SELECT pg_catalog.pg_sleep(1) /* dm_read_ban_hold */;
COMMIT;
SQL
ban_pid=$!
wait_for_query 'dm_read_ban_hold'
psql_cmd >"$TMP_ROOT/ban-waiter.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.mark_direct_message_conversation_read_atomic(
  'a0000000-0000-4000-8000-000000000004',
  '41111111-1111-4111-8111-111111111111'
);
SQL
ban_waiter_pid=$!
wait "$ban_pid"
wait "$ban_waiter_pid"
if ! grep -Fq '"reason": "ACTOR_UNAVAILABLE"' "$TMP_ROOT/ban-waiter.out"; then
  echo "Concurrent actor ban was not observed" >&2
  cat "$TMP_ROOT/ban-waiter.out" >&2
  exit 1
fi
assert_scalar 'false|' "SELECT read::text || '|' || COALESCE(read_at::text, '') FROM public.direct_messages WHERE id='b0000000-0000-4000-8000-000000000041'"

# Hard deletion uses the same lifecycle admission key and removes the auth
# parent before the waiter can obtain KEY SHARE.
psql_cmd >"$TMP_ROOT/account-delete-owner.out" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:51111111-1111-4111-8111-111111111111',
    0
  )
);
DELETE FROM auth.users
WHERE id = '51111111-1111-4111-8111-111111111111';
SELECT pg_catalog.pg_sleep(1) /* dm_read_account_delete_hold */;
COMMIT;
SQL
account_delete_pid=$!
wait_for_query 'dm_read_account_delete_hold'
psql_cmd >"$TMP_ROOT/account-delete-waiter.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.mark_direct_message_conversation_read_atomic(
  'a0000000-0000-4000-8000-000000000005',
  '51111111-1111-4111-8111-111111111111'
);
SQL
account_delete_waiter_pid=$!
wait "$account_delete_pid"
wait "$account_delete_waiter_pid"
if ! grep -Fq '"reason": "ACTOR_UNAVAILABLE"' "$TMP_ROOT/account-delete-waiter.out"; then
  echo "Concurrent actor deletion was not observed" >&2
  cat "$TMP_ROOT/account-delete-waiter.out" >&2
  exit 1
fi
assert_scalar '0|0' "SELECT (SELECT count(*) FROM public.conversations WHERE id='a0000000-0000-4000-8000-000000000005') || '|' || (SELECT count(*) FROM public.direct_messages WHERE conversation_id='a0000000-0000-4000-8000-000000000005')"

# An inbound insert that wins the pair key is included in the subsequent read
# transition; inserts that lose the key linearize after it and remain unread.
psql_cmd >"$TMP_ROOT/insert-owner.out" 2>&1 <<'SQL' &
BEGIN;
INSERT INTO public.direct_messages(
  id, conversation_id, sender_id, receiver_id, content, read
) VALUES (
  'b0000000-0000-4000-8000-000000000071',
  'a0000000-0000-4000-8000-000000000007',
  '72222222-2222-4222-8222-222222222222',
  '71111111-1111-4111-8111-111111111111',
  'insert before read',
  false
);
SELECT pg_catalog.pg_sleep(1) /* dm_read_insert_hold */;
COMMIT;
SQL
insert_pid=$!
wait_for_query 'dm_read_insert_hold'
psql_cmd >"$TMP_ROOT/insert-waiter.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.mark_direct_message_conversation_read_atomic(
  'a0000000-0000-4000-8000-000000000007',
  '71111111-1111-4111-8111-111111111111'
);
SQL
insert_waiter_pid=$!
wait "$insert_pid"
wait "$insert_waiter_pid"
if ! grep -Fq '"marked_count": 1' "$TMP_ROOT/insert-waiter.out"; then
  echo "Winning inbound insert was not included" >&2
  cat "$TMP_ROOT/insert-waiter.out" >&2
  exit 1
fi
assert_scalar 'true|true' "SELECT read::text || '|' || (read_at IS NOT NULL)::text FROM public.direct_messages WHERE id='b0000000-0000-4000-8000-000000000071'"

# A row-trigger exception during a multi-row update must roll back every read
# transition and withhold a success acknowledgement.
psql_cmd <<'SQL'
CREATE FUNCTION public.fail_second_read_for_test()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.id = 'b0000000-0000-4000-8000-000000000062' THEN
    RAISE EXCEPTION 'injected read update failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER trg_fail_second_read_for_test
BEFORE UPDATE OF read, read_at ON public.direct_messages
FOR EACH ROW EXECUTE FUNCTION public.fail_second_read_for_test();
SQL
expect_failure "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.mark_direct_message_conversation_read_atomic('a0000000-0000-4000-8000-000000000006','61111111-1111-4111-8111-111111111111')"
assert_scalar '2|0' "SELECT count(*) FILTER (WHERE read IS FALSE) || '|' || count(*) FILTER (WHERE read IS TRUE) FROM public.direct_messages WHERE conversation_id='a0000000-0000-4000-8000-000000000006'"

echo "atomic direct-message conversation-read PostgreSQL 17 checks passed"
