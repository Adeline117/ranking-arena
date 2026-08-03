#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729184500_atomic_post_create.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/atomic-post-create-pg17.XXXXXX)"
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
"$PG_BIN/initdb" -D "$PGDATA" --auth=trust --username=postgres --no-locale --encoding=UTF8 >/dev/null
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
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text LANGUAGE sql STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;

CREATE TYPE public.post_status AS ENUM ('active', 'locked', 'deleted');

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id),
  handle text NOT NULL UNIQUE,
  reputation_score integer DEFAULT 0,
  is_verified_trader boolean DEFAULT false,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz
);
CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  dissolved_at timestamptz
);
CREATE TABLE public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  muted_until timestamptz,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE public.group_bans (
  group_id uuid NOT NULL REFERENCES public.groups(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE public.group_subscriptions (
  group_id uuid NOT NULL REFERENCES public.groups(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  status text NOT NULL DEFAULT 'active',
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE public.subscriptions (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id),
  status text NOT NULL DEFAULT 'active'
);

CREATE TABLE public.posts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES auth.users(id),
  author_handle text,
  author_arena_score integer DEFAULT 0,
  author_is_verified boolean DEFAULT false,
  group_id uuid REFERENCES public.groups(id),
  title text,
  content text,
  images text[],
  poll_enabled boolean DEFAULT false,
  poll_id uuid,
  visibility text NOT NULL DEFAULT 'public',
  is_sensitive boolean DEFAULT false,
  content_warning text,
  language text DEFAULT 'zh',
  mentions text[] DEFAULT '{}',
  hashtags text[] DEFAULT '{}',
  content_version bigint NOT NULL DEFAULT 0,
  status public.post_status NOT NULL DEFAULT 'active',
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp()
);
CREATE TABLE public.polls (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  post_id uuid REFERENCES public.posts(id) ON DELETE CASCADE,
  question text NOT NULL,
  -- Generated Supabase Json types do not reveal whether production uses json
  -- or jsonb. Exercise the older physical json representation here.
  options json NOT NULL DEFAULT '[]'::json,
  type text,
  end_at timestamptz,
  created_at timestamptz DEFAULT pg_catalog.statement_timestamp(),
  updated_at timestamptz DEFAULT pg_catalog.statement_timestamp()
);
ALTER TABLE public.posts
  ADD CONSTRAINT posts_poll_id_fkey
  FOREIGN KEY (poll_id) REFERENCES public.polls(id) ON DELETE SET NULL;

CREATE TABLE public.hashtags (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tag text NOT NULL UNIQUE,
  post_count integer DEFAULT 0
);
CREATE TABLE public.post_hashtags (
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  hashtag_id uuid NOT NULL REFERENCES public.hashtags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, hashtag_id)
);

CREATE OR REPLACE FUNCTION public.has_current_group_entitlement(uuid, uuid)
RETURNS boolean LANGUAGE sql STABLE
AS $function$ SELECT true $function$;

CREATE OR REPLACE FUNCTION public.enforce_current_group_post_publish()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RETURN NEW;
END
$function$;
CREATE TRIGGER trg_posts_15_current_group_publish
BEFORE INSERT OR UPDATE ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.enforce_current_group_post_publish();

CREATE OR REPLACE FUNCTION public.advance_post_content_version()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.content_version := 0;
  ELSIF NEW.title IS DISTINCT FROM OLD.title
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.images IS DISTINCT FROM OLD.images THEN
    NEW.content_version := OLD.content_version + 1;
  ELSE
    NEW.content_version := OLD.content_version;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER trg_posts_10_content_version
BEFORE INSERT OR UPDATE ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.advance_post_content_version();

GRANT USAGE ON SCHEMA public, auth TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION auth.role() TO service_role, authenticated;
SQL

psql_cmd -f "$MIGRATION"
psql_cmd -f "$MIGRATION"
echo 'migration replay'

ACTOR="11111111-1111-4111-8111-111111111111"
MENTIONED="22222222-2222-4222-8222-222222222222"
OPERATION="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
RACE_OPERATION="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
FAIL_OPERATION="cccccccc-cccc-4ccc-8ccc-cccccccccccc"
PLAIN_OPERATION="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
INVALID_OPERATION="ffffffff-ffff-4fff-8fff-ffffffffffff"

psql_cmd -v actor="$ACTOR" -v mentioned="$MENTIONED" <<'SQL'
INSERT INTO auth.users (id) VALUES (:'actor'), (:'mentioned');
INSERT INTO public.user_profiles (
  id, handle, reputation_score, is_verified_trader
) VALUES
  (:'actor', 'alice', 42, true),
  (:'mentioned', 'Bob', 7, false);
SQL

call_create() {
  local operation_id="$1"
  local title="$2"
  local options_sql="$3"
  local tags_sql="$4"
  psql_cmd -At -v actor="$ACTOR" -v operation="$operation_id" -v title="$title" <<SQL
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.create_post_atomic(
  :'actor',
  :'operation',
  :'title',
  'Body with @Bob and #btc',
  NULL,
  ARRAY['https://cdn.example/post.png']::text[],
  true,
  $options_sql,
  'single',
  24,
  'public',
  false,
  NULL,
  'en',
  ARRAY['bob']::text[],
  $tags_sql
);
SQL
}

created="$(call_create "$OPERATION" 'Atomic post' "ARRAY['Yes','No']::text[]" "ARRAY['btc','web3']::text[]")"
grep -q '"status": "created"' <<<"$created"
grep -q '"applied": true' <<<"$created"
grep -q '"author_handle": "alice"' <<<"$created"
grep -q '"mentions": \["Bob"\]' <<<"$created"
grep -q '"content_version": 0' <<<"$created"
echo 'custom post created'

replayed="$(call_create "$OPERATION" 'Atomic post' "ARRAY['Yes','No']::text[]" "ARRAY['btc','web3']::text[]")"
grep -q '"status": "replayed"' <<<"$replayed"
grep -q '"applied": false' <<<"$replayed"
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.posts")" == '1' ]]
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.polls")" == '1' ]]
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.post_create_operation_results")" == '1' ]]
echo 'lost acknowledgement replay'

conflict="$(call_create "$OPERATION" 'Different post' "ARRAY['Yes','No']::text[]" "ARRAY['btc','web3']::text[]")"
[[ "$conflict" == *'"status": "operation_conflict"'* ]]
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.posts")" == '1' ]]
echo 'operation intent conflict'

plain="$(psql_cmd -At -v actor="$ACTOR" -v operation="$PLAIN_OPERATION" <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.create_post_atomic(
  :'actor', :'operation', 'Plain post', 'No poll body', NULL,
  ARRAY[]::text[], false, NULL, NULL, NULL, 'public', false, NULL, 'en',
  ARRAY[]::text[], ARRAY[]::text[]
);
SQL
)"
grep -q '"status": "created"' <<<"$plain"
grep -q '"poll": null' <<<"$plain"
grep -q '"poll_enabled": false' <<<"$plain"
echo 'plain post nullable poll contract'

invalid_option="$(call_create "$INVALID_OPERATION" 'Invalid options' "ARRAY[pg_catalog.repeat('x', 101),'No']::text[]" "ARRAY[]::text[]")"
[[ "$invalid_option" == *'"status": "invalid"'* ]]
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.posts WHERE title = 'Invalid options'")" == '0' ]]
echo 'poll option length boundary'

links="$(psql_cmd -At -c "SELECT count(*) FROM public.posts AS p JOIN public.polls AS q ON q.id = p.poll_id AND q.post_id = p.id WHERE p.title = 'Atomic post' AND p.content_version = 0")"
[[ "$links" == '1' ]]
option_contract="$(psql_cmd -At -c "SELECT options::text FROM public.polls")"
grep -q '"votes": 0' <<<"$option_contract"
grep -q '"index": 0' <<<"$option_contract"
[[ "$(psql_cmd -At -c "SELECT post_count FROM public.hashtags WHERE tag = 'btc'")" == '1' ]]
echo 'poll links and hashtag facets'

call_create "$RACE_OPERATION" 'Concurrent post' "ARRAY['Up','Down']::text[]" "ARRAY['race']::text[]" >"$TMP_ROOT/race-a.out" &
pid_a=$!
call_create "$RACE_OPERATION" 'Concurrent post' "ARRAY['Up','Down']::text[]" "ARRAY['race']::text[]" >"$TMP_ROOT/race-b.out" &
pid_b=$!
wait "$pid_a"
wait "$pid_b"
race_output="$(cat "$TMP_ROOT/race-a.out" "$TMP_ROOT/race-b.out")"
[[ "$(grep -c '"status": "created"' <<<"$race_output")" == '1' ]]
[[ "$(grep -c '"status": "replayed"' <<<"$race_output")" == '1' ]]
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.posts WHERE title = 'Concurrent post'")" == '1' ]]
echo 'concurrent identical operation serialized'

psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.reject_fault_poll()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.question = 'FAIL POLL' THEN
    RAISE EXCEPTION 'injected poll failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER reject_fault_poll
BEFORE INSERT ON public.polls
FOR EACH ROW EXECUTE FUNCTION public.reject_fault_poll();
SQL

if call_create "$FAIL_OPERATION" 'FAIL POLL' "ARRAY['One','Two']::text[]" "ARRAY['rollbacktag']::text[]" \
  >"$TMP_ROOT/failure.out" 2>"$TMP_ROOT/failure.err"; then
  echo 'injected poll failure unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'injected poll failure' "$TMP_ROOT/failure.err"
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.posts WHERE title = 'FAIL POLL'")" == '0' ]]
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.hashtags WHERE tag = 'rollbacktag'")" == '0' ]]
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.post_create_operation_results WHERE operation_id = '$FAIL_OPERATION'::uuid")" == '0' ]]
echo 'poll failure rolled back entire operation'

if psql_cmd -v actor="$ACTOR" >/dev/null 2>"$TMP_ROOT/authenticated.err" <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT public.create_post_atomic(
  :'actor',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'Bypass',
  'Bypass body',
  NULL,
  ARRAY[]::text[],
  false,
  NULL,
  NULL,
  NULL,
  'public',
  false,
  NULL,
  'en',
  ARRAY[]::text[],
  ARRAY[]::text[]
);
SQL
then
  echo 'authenticated RPC execution unexpectedly succeeded' >&2
  exit 1
fi
grep -qi 'permission denied' "$TMP_ROOT/authenticated.err"
echo 'authenticated RPC execution revoked'

echo 'atomic post create PostgreSQL 17 proof passed'
