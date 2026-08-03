#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729183500_atomic_post_edit.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/atomic-post-edit-pg17.XXXXXX)"
PGDATA="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
PORT="$((55800 + ($$ % 700)))"

cleanup() {
  if [[ -d "$PGDATA" ]]; then
    "$PG_BIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

if [[ ! -x "$PG_BIN/initdb" || ! -x "$PG_BIN/pg_ctl" || ! -x "$PG_BIN/psql" ]]; then
  echo "PostgreSQL 17 binaries not found at $PG_BIN" >&2
  exit 1
fi

mkdir -p "$SOCKET_DIR"
"$PG_BIN/initdb" -D "$PGDATA" --auth=trust --username=postgres --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$PGDATA" -o "-F -k $SOCKET_DIR -p $PORT" -w start >/dev/null

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -q -h "$SOCKET_DIR" -p "$PORT" -U postgres postgres "$@"
}

psql_cmd <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;
GRANT USAGE ON SCHEMA auth TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION auth.role() TO service_role, authenticated;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id),
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz
);

CREATE TYPE public.post_status AS ENUM ('active', 'locked', 'deleted');
CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  author_id uuid NOT NULL REFERENCES auth.users(id),
  group_id uuid,
  title text,
  content text,
  images text[],
  updated_at timestamptz,
  deleted_at timestamptz,
  status public.post_status NOT NULL DEFAULT 'active'
);

GRANT USAGE ON SCHEMA public TO service_role, authenticated;
GRANT SELECT, UPDATE ON public.posts TO authenticated;
SQL

psql_cmd -f "$MIGRATION"
psql_cmd -f "$MIGRATION"
echo 'migration replay'

ACTOR="11111111-1111-4111-8111-111111111111"
OTHER="22222222-2222-4222-8222-222222222222"
INACTIVE="33333333-3333-4333-8333-333333333333"
POST="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
DELETED_POST="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
INITIAL_REVISION="2026-07-30T01:00:00+00"

psql_cmd -v actor="$ACTOR" -v other="$OTHER" -v inactive="$INACTIVE" \
  -v post="$POST" -v deleted_post="$DELETED_POST" -v revision="$INITIAL_REVISION" <<'SQL'
INSERT INTO auth.users (id) VALUES (:'actor'), (:'other'), (:'inactive');
INSERT INTO public.user_profiles (id, deleted_at)
VALUES (:'actor', NULL), (:'other', NULL), (:'inactive', pg_catalog.clock_timestamp());
INSERT INTO public.posts (id, author_id, title, content, images, updated_at)
VALUES (:'post', :'actor', 'Original', 'Original body', ARRAY['https://cdn.example/old.png'], :'revision');
INSERT INTO public.posts (id, author_id, title, content, updated_at, deleted_at)
VALUES (
  :'deleted_post', :'actor', 'Deleted', 'Deleted body', :'revision', pg_catalog.clock_timestamp()
);
SQL

call_edit() {
  local actor="$1"
  local post_id="$2"
  local version="$3"
  local title="$4"
  local content="$5"
  psql_cmd -At -v actor="$actor" -v post_id="$post_id" -v version="$version" \
    -v title="$title" -v content="$content" <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.edit_post_atomic(
  :'actor',
  :'post_id',
  :'version'::bigint,
  :'title',
  :'content',
  false,
  NULL
);
SQL
}

updated="$(call_edit "$ACTOR" "$POST" 0 'First edit' 'First body')"
grep -q '"status": "updated"' <<<"$updated"
grep -q '"title": "First edit"' <<<"$updated"
grep -q '"content_version": 1' <<<"$updated"

unchanged="$(call_edit "$ACTOR" "$POST" 0 'First edit' 'First body')"
grep -q '"status": "unchanged"' <<<"$unchanged"

stale="$(call_edit "$ACTOR" "$POST" 0 'Stale edit' 'Stale body')"
grep -q '"status": "conflict"' <<<"$stale"
stored_title="$(psql_cmd -At -c "SELECT title FROM public.posts WHERE id = '$POST'::uuid")"
[[ "$stored_title" == 'First edit' ]]
echo 'stale revision conflict'

current_version="$(psql_cmd -At -c "SELECT content_version FROM public.posts WHERE id = '$POST'::uuid")"
call_edit "$ACTOR" "$POST" "$current_version" 'Concurrent A' 'Body A' >"$TMP_ROOT/a.out" &
pid_a=$!
call_edit "$ACTOR" "$POST" "$current_version" 'Concurrent B' 'Body B' >"$TMP_ROOT/b.out" &
pid_b=$!
wait "$pid_a"
wait "$pid_b"
race_output="$(cat "$TMP_ROOT/a.out" "$TMP_ROOT/b.out")"
[[ "$(grep -c '"status": "updated"' <<<"$race_output")" == '1' ]]
[[ "$(grep -c '"status": "conflict"' <<<"$race_output")" == '1' ]]
echo 'concurrent edit compare-and-swap'

latest_version="$(psql_cmd -At -c "SELECT content_version FROM public.posts WHERE id = '$POST'::uuid")"
forbidden="$(call_edit "$OTHER" "$POST" "$latest_version" 'Wrong author' 'Wrong body')"
grep -q '"status": "forbidden"' <<<"$forbidden"
deleted="$(call_edit "$ACTOR" "$DELETED_POST" 0 'Deleted edit' 'Deleted body')"
grep -q '"status": "not_found"' <<<"$deleted"
inactive_post="cccccccc-cccc-4ccc-8ccc-cccccccccccc"
psql_cmd -v post="$inactive_post" -v inactive="$INACTIVE" -v revision="$INITIAL_REVISION" <<'SQL'
INSERT INTO public.posts (id, author_id, title, content, updated_at)
VALUES (:'post', :'inactive', 'Inactive', 'Inactive body', :'revision');
SQL
inactive="$(call_edit "$INACTIVE" "$inactive_post" 0 'Inactive edit' 'Body')"
grep -q '"status": "account_inactive"' <<<"$inactive"
echo 'author and lifecycle isolation'

if psql_cmd -v actor="$ACTOR" -v post="$POST" -v version="$latest_version" \
  >/dev/null 2>"$TMP_ROOT/authenticated.err" <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT public.edit_post_atomic(
  :'actor', :'post', :'version', 'Bypass', 'Bypass', false, NULL
);
SQL
then
  echo 'authenticated RPC execution unexpectedly succeeded' >&2
  exit 1
fi
grep -qi 'permission denied' "$TMP_ROOT/authenticated.err"
echo 'authenticated RPC execution revoked'

echo 'atomic post edit PostgreSQL 17 proof passed'
