#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EDIT_MIGRATION="$ROOT_DIR/supabase/migrations/20260729183500_atomic_post_edit.sql"
CLOSURE_MIGRATION="$ROOT_DIR/supabase/migrations/20260729184000_close_post_direct_writes.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/close-post-writes-pg17.XXXXXX)"
PGDATA="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
PORT="$((56500 + ($$ % 700)))"

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
CREATE ROLE authenticator NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
$function$;
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;
GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO authenticated, service_role;

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
  is_pinned boolean DEFAULT false,
  poll_id uuid,
  updated_at timestamptz,
  deleted_at timestamptz,
  status public.post_status NOT NULL DEFAULT 'active'
);
CREATE TABLE public.polls (
  id uuid PRIMARY KEY,
  post_id uuid REFERENCES public.posts(id)
);

GRANT USAGE ON SCHEMA public TO authenticated, service_role;
GRANT SELECT, UPDATE ON public.posts TO authenticated, service_role;
GRANT SELECT ON public.polls TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_post_pin_state_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_is_pinned boolean
)
RETURNS jsonb
LANGUAGE sql
AS $function$
  SELECT pg_catalog.jsonb_build_object('success', false)
$function$;
ALTER FUNCTION public.set_post_pin_state_atomic(uuid, uuid, boolean) OWNER TO postgres;
SQL

psql_cmd -f "$EDIT_MIGRATION"
psql_cmd -f "$CLOSURE_MIGRATION"
psql_cmd -f "$CLOSURE_MIGRATION"
echo 'migration replay'

ACTOR="11111111-1111-4111-8111-111111111111"
OTHER="22222222-2222-4222-8222-222222222222"
POST="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
OTHER_POST="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
POLL="cccccccc-cccc-4ccc-8ccc-cccccccccccc"
OTHER_POLL="dddddddd-dddd-4ddd-8ddd-dddddddddddd"
RELINK_POLL="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"

psql_cmd -v actor="$ACTOR" -v other="$OTHER" -v post="$POST" \
  -v other_post="$OTHER_POST" -v poll="$POLL" -v other_poll="$OTHER_POLL" \
  -v relink_poll="$RELINK_POLL" <<'SQL'
INSERT INTO auth.users (id) VALUES (:'actor'), (:'other');
INSERT INTO public.user_profiles (id) VALUES (:'actor'), (:'other');
INSERT INTO public.posts (id, author_id, title, content, updated_at)
VALUES
  (:'post', :'actor', 'Original', 'Original body', '2026-07-30T01:00:00+00'),
  (:'other_post', :'other', 'Other', 'Other body', '2026-07-30T01:00:00+00');
INSERT INTO public.polls (id, post_id)
VALUES
  (:'poll', :'post'),
  (:'other_poll', :'other_post'),
  (:'relink_poll', :'post');
SQL

if psql_cmd -v actor="$ACTOR" -v post="$POST" >/dev/null 2>"$TMP_ROOT/title.err" <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', :'actor', false);
UPDATE public.posts SET title = 'Bypass' WHERE id = :'post';
SQL
then
  echo 'authenticated title update unexpectedly succeeded' >&2
  exit 1
fi
grep -qi 'permission denied' "$TMP_ROOT/title.err"

if psql_cmd -v actor="$ACTOR" -v post="$POST" >/dev/null 2>"$TMP_ROOT/pin.err" <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', :'actor', false);
UPDATE public.posts SET is_pinned = true WHERE id = :'post';
SQL
then
  echo 'authenticated pin update unexpectedly succeeded' >&2
  exit 1
fi
grep -qi 'permission denied' "$TMP_ROOT/pin.err"
echo 'authenticated content and pin updates revoked'

psql_cmd -v actor="$ACTOR" -v post="$POST" -v poll="$POLL" <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', :'actor', false);
UPDATE public.posts SET poll_id = :'poll' WHERE id = :'post';
SQL
linked_poll="$(psql_cmd -At -c "SELECT poll_id FROM public.posts WHERE id = '$POST'::uuid")"
[[ "$linked_poll" == "$POLL" ]]
echo 'author-owned poll compatibility'

if psql_cmd -v other="$OTHER" -v post="$POST" -v poll="$POLL" \
  >/dev/null 2>"$TMP_ROOT/other-author.err" <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', :'other', false);
UPDATE public.posts SET poll_id = :'poll' WHERE id = :'post';
SQL
then
  echo 'cross-author poll link unexpectedly succeeded' >&2
  exit 1
fi
grep -qi 'only the post author' "$TMP_ROOT/other-author.err"

if psql_cmd -v other="$OTHER" -v other_post="$OTHER_POST" -v poll="$POLL" \
  >/dev/null 2>"$TMP_ROOT/cross-post.err" <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', :'other', false);
UPDATE public.posts SET poll_id = :'poll' WHERE id = :'other_post';
SQL
then
  echo 'cross-post poll link unexpectedly succeeded' >&2
  exit 1
fi
grep -qi 'poll must already belong' "$TMP_ROOT/cross-post.err"

if psql_cmd -v actor="$ACTOR" -v post="$POST" -v poll="$RELINK_POLL" \
  >/dev/null 2>"$TMP_ROOT/relink.err" <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', :'actor', false);
UPDATE public.posts SET poll_id = :'poll' WHERE id = :'post';
SQL
then
  echo 'poll relink unexpectedly succeeded' >&2
  exit 1
fi
grep -qi 'immutable once assigned' "$TMP_ROOT/relink.err"
echo 'cross-author and cross-post poll isolation'

service_edit="$(psql_cmd -At -v actor="$ACTOR" -v post="$POST" <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.edit_post_atomic(
  :'actor', :'post', 0, 'Service edit', 'Service body', false, NULL
);
SQL
)"
grep -q '"status": "updated"' <<<"$service_edit"
grep -q '"title": "Service edit"' <<<"$service_edit"
echo 'service atomic edit retained'

if psql_cmd -v actor="$ACTOR" -v post="$POST" >/dev/null 2>"$TMP_ROOT/rpc.err" <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', :'actor', false);
SELECT public.edit_post_atomic(:'actor', :'post', 1, 'RPC bypass', 'Body', false, NULL);
SQL
then
  echo 'authenticated atomic RPC unexpectedly succeeded' >&2
  exit 1
fi
grep -qi 'permission denied' "$TMP_ROOT/rpc.err"
echo 'authenticated atomic RPC execution revoked'

echo 'post direct-write closure PostgreSQL 17 proof passed'
