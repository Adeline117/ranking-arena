#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the post-atomic-mute group-member boundary.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716171000_group_member_read_privacy.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ ! -f "$MIGRATION" ]]; then
  echo "Group-member privacy migration is missing: $MIGRATION" >&2
  exit 1
fi
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/group-member-privacy-forward-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55462
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if (( exit_status != 0 )) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    echo "PostgreSQL 17 integration cluster log:" >&2
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null

"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_DIR/postgres.log" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

PSQL=(
  "$PG_BIN/psql"
  -X
  -v ON_ERROR_STOP=1
  -h "$SOCKET_DIR"
  -p "$PORT"
  -d postgres
)

"${PSQL[@]}" <<'SQL'
CREATE ROLE postgres NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE drifted_reader NOLOGIN;
GRANT drifted_reader TO authenticated;

CREATE SCHEMA auth;
CREATE TYPE public.member_role AS ENUM ('owner', 'admin', 'member');

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
$function$;

CREATE TABLE public.group_members (
  group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role public.member_role NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  notifications_muted boolean DEFAULT false,
  muted_until timestamptz,
  mute_reason text,
  muted_by uuid,
  self_notify_muted boolean NOT NULL DEFAULT false,
  pinned boolean NOT NULL DEFAULT false,
  PRIMARY KEY (group_id, user_id)
);
ALTER TABLE public.group_members OWNER TO postgres;
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL,
  content text NOT NULL
);
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.moderate_group_mute_atomic(
  p_operation_id uuid,
  p_actor_id uuid,
  p_group_id uuid,
  p_target_id uuid,
  p_action text,
  p_muted_until timestamptz,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_action = 'mute' THEN
    UPDATE public.group_members AS member
    SET muted_until = p_muted_until,
        mute_reason = p_reason,
        muted_by = p_actor_id
    WHERE member.group_id = p_group_id
      AND member.user_id = p_target_id;
  ELSIF p_action = 'unmute' THEN
    UPDATE public.group_members AS member
    SET muted_until = NULL,
        mute_reason = NULL,
        muted_by = NULL
    WHERE member.group_id = p_group_id
      AND member.user_id = p_target_id;
  ELSE
    RAISE EXCEPTION 'invalid action';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'operation_id', p_operation_id
  );
END
$function$;
ALTER FUNCTION public.moderate_group_mute_atomic(
  uuid, uuid, uuid, uuid, text, timestamptz, text
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.moderate_group_mute_atomic(
  uuid, uuid, uuid, uuid, text, timestamptz, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.moderate_group_mute_atomic(
  uuid, uuid, uuid, uuid, text, timestamptz, text
) TO service_role;

GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role, drifted_reader;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT ALL ON TABLE public.group_members TO PUBLIC, anon, authenticated, service_role;
GRANT SELECT (muted_by, mute_reason, pinned)
  ON TABLE public.group_members TO drifted_reader;
GRANT SELECT ON TABLE public.posts TO authenticated;

CREATE POLICY unsafe_browser_all
  ON public.group_members
  FOR ALL
  TO PUBLIC
  USING (true)
  WITH CHECK (true);
CREATE POLICY unknown_drifted_read
  ON public.group_members
  FOR SELECT
  TO drifted_reader
  USING (true);
CREATE POLICY posts_member_dependency
  ON public.posts
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.group_members AS member
      WHERE member.group_id = posts.group_id
        AND member.user_id = (SELECT auth.uid())
    )
  );

INSERT INTO public.group_members (
  group_id,
  user_id,
  role,
  muted_until,
  mute_reason,
  muted_by,
  notifications_muted,
  self_notify_muted,
  pinned
) VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'owner',
    NULL,
    NULL,
    NULL,
    false,
    false,
    true
  ),
  (
    '10000000-0000-4000-8000-000000000001',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'admin',
    NULL,
    NULL,
    NULL,
    false,
    false,
    false
  ),
  (
    '10000000-0000-4000-8000-000000000001',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'member',
    pg_catalog.clock_timestamp() + interval '1 day',
    'private moderation reason',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    true,
    true,
    true
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'owner',
    NULL,
    NULL,
    NULL,
    false,
    false,
    false
  );

INSERT INTO public.posts (id, group_id, content) VALUES
  (
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'group one'
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    'group two'
  );

CREATE OR REPLACE FUNCTION public.expect_denied(p_statement text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  EXECUTE p_statement;
  RAISE EXCEPTION 'statement unexpectedly succeeded: %', p_statement;
EXCEPTION
  WHEN insufficient_privilege OR check_violation
  THEN
    RETURN;
END
$function$;
GRANT EXECUTE ON FUNCTION public.expect_denied(text)
  TO anon, authenticated, service_role, drifted_reader;
SQL

"${PSQL[@]}" -f "$MIGRATION" >"$LOG_DIR/first-application.log"
"${PSQL[@]}" -f "$MIGRATION" >"$LOG_DIR/second-application.log"

# A real view read locks the view before group_members. Hold that order while a
# replay starts: the migration must release every partial NOWAIT lock before
# retrying, allowing the reader to acquire the base-table lock without deadlock.
"${PSQL[@]}" >"$LOG_DIR/concurrent-reader.log" 2>&1 <<'SQL' &
BEGIN;
LOCK TABLE public.group_member_moderation_directory IN ACCESS SHARE MODE;
\echo RUNTIME_VIEW_LOCKED
SELECT pg_catalog.pg_sleep(0.5);
LOCK TABLE public.group_members IN ACCESS SHARE MODE;
\echo RUNTIME_BASE_LOCKED
SELECT pg_catalog.pg_sleep(0.5);
COMMIT;
SQL
reader_pid=$!

reader_ready=false
for _attempt in {1..100}; do
  if grep -q 'RUNTIME_VIEW_LOCKED' "$LOG_DIR/concurrent-reader.log"; then
    reader_ready=true
    break
  fi
  sleep 0.02
done
if [[ "$reader_ready" != true ]]; then
  echo "Concurrent view reader did not acquire its first lock" >&2
  wait "$reader_pid" || true
  exit 1
fi

"${PSQL[@]}" -f "$MIGRATION" >"$LOG_DIR/concurrent-replay.log"
wait "$reader_pid"
if ! grep -q 'RUNTIME_BASE_LOCKED' "$LOG_DIR/concurrent-reader.log"; then
  echo "Concurrent view reader could not progress to group_members" >&2
  exit 1
fi

"${PSQL[@]}" <<'SQL'
SET ROLE anon;
SELECT pg_catalog.set_config('request.jwt.claim.sub', '', false);
SELECT public.expect_denied($statement$
  SELECT muted_until FROM public.group_members
$statement$);
SELECT public.expect_denied($statement$
  SELECT * FROM public.group_members
$statement$);
SELECT public.expect_denied($statement$
  SELECT * FROM public.own_group_memberships
$statement$);
SELECT public.expect_denied($statement$
  SELECT * FROM public.group_member_moderation_directory
$statement$);
DO $anon_directory_contract$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.group_member_directory) <> 4
    OR (SELECT pg_catalog.count(*) FROM public.group_members) <> 4
  THEN
    RAISE EXCEPTION 'anonymous safe membership directory is incomplete';
  END IF;
END
$anon_directory_contract$;

RESET ROLE;
SET ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  false
);
SELECT public.expect_denied($statement$
  SELECT mute_reason FROM public.group_members
$statement$);
SELECT public.expect_denied($statement$
  SELECT pinned FROM public.group_members
$statement$);
SELECT public.expect_denied($statement$
  UPDATE public.group_members
  SET role = 'admin'
  WHERE user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
$statement$);
DO $member_contract$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.own_group_memberships) <> 1
    OR NOT EXISTS (
      SELECT 1
      FROM public.own_group_memberships
      WHERE user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        AND muted_until > pg_catalog.clock_timestamp()
        AND pinned
    )
    OR EXISTS (
      SELECT 1 FROM public.group_member_moderation_directory
    )
    OR (SELECT pg_catalog.count(*) FROM public.posts) <> 1
    OR NOT EXISTS (
      SELECT 1 FROM public.posts WHERE content = 'group one'
    )
  THEN
    RAISE EXCEPTION 'member projection or dependent RLS policy is incorrect';
  END IF;
END
$member_contract$;

SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  false
);
DO $moderator_contract$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.group_member_moderation_directory) <> 3
    OR NOT EXISTS (
      SELECT 1
      FROM public.group_member_moderation_directory
      WHERE user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        AND mute_reason = 'private moderation reason'
    )
    OR EXISTS (
      SELECT 1
      FROM public.group_member_moderation_directory
      WHERE group_id = '20000000-0000-4000-8000-000000000002'
    )
  THEN
    RAISE EXCEPTION 'moderator projection crossed its authority boundary';
  END IF;
END
$moderator_contract$;

RESET ROLE;
SET ROLE drifted_reader;
SELECT public.expect_denied($statement$
  SELECT muted_by FROM public.group_members
$statement$);

RESET ROLE;
SET ROLE service_role;
SELECT public.moderate_group_mute_atomic(
  '90000000-0000-4000-8000-000000000001',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '10000000-0000-4000-8000-000000000001',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'mute',
  pg_catalog.clock_timestamp() + interval '2 days',
  'forward privacy rpc proof'
);
DO $service_rpc_contract$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.group_members
    WHERE group_id = '10000000-0000-4000-8000-000000000001'
      AND user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      AND mute_reason = 'forward privacy rpc proof'
      AND muted_by = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ) THEN
    RAISE EXCEPTION 'atomic group-mute RPC failed after privacy convergence';
  END IF;
END
$service_rpc_contract$;
SQL

echo "group-member read privacy forward PG17 proof passed"
