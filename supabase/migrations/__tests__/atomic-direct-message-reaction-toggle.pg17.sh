#!/usr/bin/env bash

# PostgreSQL 17 proof for idempotent, transactional direct-message reaction
# toggles. It owns an isolated temporary cluster and never touches application
# data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729158000_atomic_direct_message_reaction_toggle.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-dm-reaction-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((61000 + ($$ % 1500)))
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
  while ((attempts < 100)); do
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

-- The production definitions install and attest the global stale-JWT guard.
-- These isolated stubs prove that every later relation migration invokes both
-- deployment-window hooks without pulling the unrelated full barrier fixture.
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
CREATE TABLE public.direct_messages (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  receiver_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content text NOT NULL,
  deleted_at timestamptz
);
CREATE TABLE public.message_reactions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.direct_messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji text NOT NULL CHECK (pg_catalog.char_length(emoji) BETWEEN 1 AND 10),
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (message_id, user_id, emoji)
);
CREATE TABLE public.blocked_users (
  blocker_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('reaction')),
  title text NOT NULL,
  message text NOT NULL,
  link text,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reference_id text,
  read boolean DEFAULT false,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.conversations OWNER TO postgres;
ALTER TABLE public.direct_messages OWNER TO postgres;
ALTER TABLE public.message_reactions OWNER TO postgres;
ALTER TABLE public.blocked_users OWNER TO postgres;
ALTER TABLE public.notifications OWNER TO postgres;

GRANT SELECT, INSERT, DELETE ON public.message_reactions
  TO authenticated, service_role;
GRANT SELECT ON public.direct_messages, public.conversations,
  public.user_profiles, public.blocked_users, public.notifications
  TO service_role;
GRANT INSERT ON public.notifications TO service_role;

CREATE FUNCTION public.serialize_direct_message_pair_edge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
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
    WHEN 'direct_messages' THEN
      IF TG_OP = 'DELETE' THEN
        v_left := OLD.sender_id;
        v_right := OLD.receiver_id;
      ELSE
        v_left := NEW.sender_id;
        v_right := NEW.receiver_id;
      END IF;
    ELSE
      RAISE EXCEPTION 'unsupported pair table';
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
CREATE TRIGGER trg_serialize_dm_message_pair
BEFORE INSERT OR DELETE OR UPDATE OF sender_id, receiver_id, deleted_at
ON public.direct_messages
FOR EACH ROW EXECUTE FUNCTION public.serialize_direct_message_pair_edge();
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

expect_failure "SET ROLE authenticated; SET request.jwt.claim.role='authenticated'; SELECT public.toggle_direct_message_reaction_atomic('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','20000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','🔥')"
expect_failure "SET ROLE rogue_role; SELECT public.toggle_direct_message_reaction_atomic('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','20000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','🔥')"
expect_failure "SET ROLE authenticated; INSERT INTO public.message_reactions(message_id,user_id,emoji) VALUES ('20000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','🔥')"
expect_failure "SET ROLE service_role; SELECT * FROM public.direct_message_reaction_operations"

psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444'),
  ('55555555-5555-4555-8555-555555555555'),
  ('66666666-6666-4666-8666-666666666666');
INSERT INTO public.user_profiles(id, handle) VALUES
  ('11111111-1111-4111-8111-111111111111', 'actor'),
  ('22222222-2222-4222-8222-222222222222', 'author'),
  ('33333333-3333-4333-8333-333333333333', 'outsider'),
  ('44444444-4444-4444-8444-444444444444', 'delete_actor'),
  ('55555555-5555-4555-8555-555555555555', 'delete_author'),
  ('66666666-6666-4666-8666-666666666666', 'ban_actor');
INSERT INTO public.conversations(id, user1_id, user2_id) VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555'
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    '22222222-2222-4222-8222-222222222222',
    '66666666-6666-4666-8666-666666666666'
  );
INSERT INTO public.direct_messages(
  id, conversation_id, sender_id, receiver_id, content
) VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111',
    'parent message preview'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    '55555555-5555-4555-8555-555555555555',
    '44444444-4444-4444-8444-444444444444',
    'account-delete race'
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000003',
    '22222222-2222-4222-8222-222222222222',
    '66666666-6666-4666-8666-666666666666',
    'ban race'
  );
SQL

added="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.toggle_direct_message_reaction_atomic('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','20000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','🔥')")"
if [[ "$added" != *'"success": true'* ]] \
  || [[ "$added" != *'"action": "added"'* ]] \
  || [[ "$added" != *'"applied": true'* ]] \
  || [[ "$added" != *'"notification_created": true'* ]] \
  || [[ "$added" != *'"🔥": 1'* ]]; then
  echo "Unexpected add acknowledgement: $added" >&2
  exit 1
fi
assert_scalar '1|1|1' "SELECT (SELECT count(*) FROM public.message_reactions WHERE message_id='20000000-0000-4000-8000-000000000001' AND user_id='11111111-1111-4111-8111-111111111111' AND emoji='🔥') || '|' || (SELECT count(*) FROM public.direct_message_reaction_operations WHERE operation_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1') || '|' || (SELECT count(*) FROM public.notifications WHERE reference_id='20000000-0000-4000-8000-000000000001' AND actor_id='11111111-1111-4111-8111-111111111111')"

replay="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.toggle_direct_message_reaction_atomic('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','20000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','🔥')")"
if [[ "$replay" != *'"action": "added"'* ]] \
  || [[ "$replay" != *'"applied": false'* ]]; then
  echo "Replay toggled or returned an invalid acknowledgement: $replay" >&2
  exit 1
fi
assert_scalar '1|1|1' "SELECT (SELECT count(*) FROM public.message_reactions WHERE message_id='20000000-0000-4000-8000-000000000001' AND emoji='🔥') || '|' || (SELECT count(*) FROM public.direct_message_reaction_operations WHERE operation_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1') || '|' || (SELECT count(*) FROM public.notifications WHERE reference_id='20000000-0000-4000-8000-000000000001')"

conflict="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.toggle_direct_message_reaction_atomic('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','20000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','👍')")"
if [[ "$conflict" != *'"reason": "OPERATION_CONFLICT"'* ]]; then
  echo "Operation collision was not rejected: $conflict" >&2
  exit 1
fi

removed="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.toggle_direct_message_reaction_atomic('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2','20000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','🔥')")"
if [[ "$removed" != *'"action": "removed"'* ]] \
  || [[ "$removed" != *'"applied": true'* ]]; then
  echo "Unexpected remove acknowledgement: $removed" >&2
  exit 1
fi
assert_scalar '0|2|1' "SELECT (SELECT count(*) FROM public.message_reactions WHERE message_id='20000000-0000-4000-8000-000000000001' AND emoji='🔥') || '|' || (SELECT count(*) FROM public.direct_message_reaction_operations WHERE message_id='20000000-0000-4000-8000-000000000001') || '|' || (SELECT count(*) FROM public.notifications WHERE reference_id='20000000-0000-4000-8000-000000000001')"

deduped="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.toggle_direct_message_reaction_atomic('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3','20000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','🔥')")"
if [[ "$deduped" != *'"action": "added"'* ]] \
  || [[ "$deduped" != *'"notification_created": false'* ]]; then
  echo "One-hour notification dedup drifted: $deduped" >&2
  exit 1
fi
assert_scalar '1' "SELECT count(*) FROM public.notifications WHERE reference_id='20000000-0000-4000-8000-000000000001'"

self_reaction="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.toggle_direct_message_reaction_atomic('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4','20000000-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222','👍')")"
if [[ "$self_reaction" != *'"action": "added"'* ]] \
  || [[ "$self_reaction" != *'"notification_id": null'* ]]; then
  echo "Self reaction unexpectedly notified: $self_reaction" >&2
  exit 1
fi

outsider="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.toggle_direct_message_reaction_atomic('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5','20000000-0000-4000-8000-000000000001','33333333-3333-4333-8333-333333333333','💎')")"
if [[ "$outsider" != *'"reason": "FORBIDDEN"'* ]]; then
  echo "Outsider was not denied: $outsider" >&2
  exit 1
fi
assert_scalar '0' "SELECT count(*) FROM public.direct_message_reaction_operations WHERE operation_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'"

# Two concurrent transport attempts with the same operation ID must linearize
# to one add, not add then remove.
psql_cmd >"$TMP_ROOT/double-a.out" 2>&1 <<'SQL' &
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.toggle_direct_message_reaction_atomic(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  '20000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '🎯'
);
SELECT pg_catalog.pg_sleep(1) /* dm_reaction_double_hold */;
COMMIT;
SQL
double_pid=$!
wait_for_query 'dm_reaction_double_hold'
psql_cmd >"$TMP_ROOT/double-b.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.toggle_direct_message_reaction_atomic(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  '20000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '🎯'
);
SQL
retry_pid=$!
wait "$double_pid"
wait "$retry_pid"
if ! grep -Fq '"action": "added"' "$TMP_ROOT/double-a.out" \
  || ! grep -Fq '"applied": true' "$TMP_ROOT/double-a.out" \
  || ! grep -Fq '"action": "added"' "$TMP_ROOT/double-b.out" \
  || ! grep -Fq '"applied": false' "$TMP_ROOT/double-b.out"; then
  echo "Concurrent same-operation replay drifted" >&2
  cat "$TMP_ROOT/double-a.out" "$TMP_ROOT/double-b.out" >&2
  exit 1
fi
assert_scalar '1|1' "SELECT (SELECT count(*) FROM public.message_reactions WHERE message_id='20000000-0000-4000-8000-000000000001' AND user_id='11111111-1111-4111-8111-111111111111' AND emoji='🎯') || '|' || (SELECT count(*) FROM public.direct_message_reaction_operations WHERE operation_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1')"

# A block that wins the canonical pair key must be observed after the waiter
# resumes; no reaction or replay row may slip across the block boundary.
psql_cmd >"$TMP_ROOT/block-owner.out" 2>&1 <<'SQL' &
BEGIN;
INSERT INTO public.blocked_users(blocker_id, blocked_id)
VALUES (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111'
);
SELECT pg_catalog.pg_sleep(1) /* dm_reaction_block_hold */;
COMMIT;
SQL
block_pid=$!
wait_for_query 'dm_reaction_block_hold'
psql_cmd >"$TMP_ROOT/block-waiter.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.toggle_direct_message_reaction_atomic(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
  '20000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '💰'
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
assert_scalar '0|0' "SELECT (SELECT count(*) FROM public.message_reactions WHERE message_id='20000000-0000-4000-8000-000000000001' AND emoji='💰') || '|' || (SELECT count(*) FROM public.direct_message_reaction_operations WHERE operation_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2')"
psql_cmd -c "DELETE FROM public.blocked_users WHERE blocker_id='22222222-2222-4222-8222-222222222222' AND blocked_id='11111111-1111-4111-8111-111111111111'" >/dev/null

# A soft delete that owns the pair key wins before the reaction's locked
# message revalidation.
psql_cmd >"$TMP_ROOT/message-delete-owner.out" 2>&1 <<'SQL' &
BEGIN;
UPDATE public.direct_messages
SET deleted_at = pg_catalog.clock_timestamp()
WHERE id = '20000000-0000-4000-8000-000000000001';
SELECT pg_catalog.pg_sleep(1) /* dm_reaction_delete_hold */;
COMMIT;
SQL
delete_pid=$!
wait_for_query 'dm_reaction_delete_hold'
psql_cmd >"$TMP_ROOT/message-delete-waiter.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.toggle_direct_message_reaction_atomic(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
  '20000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '📈'
);
SQL
delete_waiter_pid=$!
wait "$delete_pid"
wait "$delete_waiter_pid"
if ! grep -Fq '"reason": "MESSAGE_NOT_FOUND"' "$TMP_ROOT/message-delete-waiter.out"; then
  echo "Concurrent message delete was not observed" >&2
  cat "$TMP_ROOT/message-delete-waiter.out" >&2
  exit 1
fi
assert_scalar '0|0' "SELECT (SELECT count(*) FROM public.message_reactions WHERE message_id='20000000-0000-4000-8000-000000000001' AND emoji='📈') || '|' || (SELECT count(*) FROM public.direct_message_reaction_operations WHERE operation_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3')"

# Account deletion takes the same lifecycle admission key. The reaction may
# observe a discovery snapshot, but after waiting it must fail closed without a
# child write or durable success acknowledgement.
psql_cmd >"$TMP_ROOT/account-delete-owner.out" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:44444444-4444-4444-8444-444444444444',
    0
  )
);
DELETE FROM auth.users
WHERE id = '44444444-4444-4444-8444-444444444444';
SELECT pg_catalog.pg_sleep(1) /* dm_reaction_account_delete_hold */;
COMMIT;
SQL
account_delete_pid=$!
wait_for_query 'dm_reaction_account_delete_hold'
psql_cmd >"$TMP_ROOT/account-delete-waiter.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.toggle_direct_message_reaction_atomic(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
  '20000000-0000-4000-8000-000000000002',
  '44444444-4444-4444-8444-444444444444',
  '📉'
);
SQL
account_waiter_pid=$!
wait "$account_delete_pid"
wait "$account_waiter_pid"
if ! grep -Eq '"reason": "(ACTOR_UNAVAILABLE|MESSAGE_NOT_FOUND)"' "$TMP_ROOT/account-delete-waiter.out"; then
  echo "Concurrent account deletion was not observed" >&2
  cat "$TMP_ROOT/account-delete-waiter.out" >&2
  exit 1
fi
assert_scalar '0|0' "SELECT (SELECT count(*) FROM public.message_reactions WHERE emoji='📉') || '|' || (SELECT count(*) FROM public.direct_message_reaction_operations WHERE operation_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4')"

# A ban transition that wins account admission must be visible before any
# reaction write.
psql_cmd >"$TMP_ROOT/ban-owner.out" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:66666666-6666-4666-8666-666666666666',
    0
  )
);
UPDATE public.user_profiles
SET is_banned = true, ban_expires_at = NULL
WHERE id = '66666666-6666-4666-8666-666666666666';
SELECT pg_catalog.pg_sleep(1) /* dm_reaction_ban_hold */;
COMMIT;
SQL
ban_pid=$!
wait_for_query 'dm_reaction_ban_hold'
psql_cmd >"$TMP_ROOT/ban-waiter.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.toggle_direct_message_reaction_atomic(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5',
  '20000000-0000-4000-8000-000000000003',
  '66666666-6666-4666-8666-666666666666',
  '👀'
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
assert_scalar '0|0' "SELECT (SELECT count(*) FROM public.message_reactions WHERE message_id='20000000-0000-4000-8000-000000000003') || '|' || (SELECT count(*) FROM public.direct_message_reaction_operations WHERE operation_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5')"

# Inject a notification failure on a fresh live message. The reaction row and
# ledger must roll back with the notification insert.
psql_cmd <<'SQL'
UPDATE public.direct_messages
SET deleted_at = NULL
WHERE id = '20000000-0000-4000-8000-000000000001';
DELETE FROM public.notifications
WHERE reference_id = '20000000-0000-4000-8000-000000000001';
CREATE FUNCTION public.fail_test_reaction_notification()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF pg_catalog.current_setting('test.fail_reaction_notification', true) = 'on'
     AND NEW.type = 'reaction'
  THEN
    RAISE EXCEPTION 'injected reaction notification failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER zzz_fail_test_reaction_notification
BEFORE INSERT ON public.notifications
FOR EACH ROW EXECUTE FUNCTION public.fail_test_reaction_notification();
SQL

expect_failure "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SET test.fail_reaction_notification='on'; SELECT public.toggle_direct_message_reaction_atomic('cccccccc-cccc-4ccc-8ccc-ccccccccccc1','20000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','🚀')"
assert_scalar '0|0|0' "SELECT (SELECT count(*) FROM public.message_reactions WHERE message_id='20000000-0000-4000-8000-000000000001' AND emoji='🚀') || '|' || (SELECT count(*) FROM public.direct_message_reaction_operations WHERE operation_id='cccccccc-cccc-4ccc-8ccc-ccccccccccc1') || '|' || (SELECT count(*) FROM public.notifications WHERE reference_id='20000000-0000-4000-8000-000000000001' AND title LIKE '%🚀%')"

echo "atomic direct-message reaction toggle pg17 proof passed"
