#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EDIT_BASE_MIGRATION="$ROOT_DIR/supabase/migrations/20260729183500_atomic_post_edit.sql"
CREATE_MIGRATION="$ROOT_DIR/supabase/migrations/20260729184500_atomic_post_create.sql"
FACET_MIGRATION="$ROOT_DIR/supabase/migrations/20260729186500_atomic_post_edit_facets.sql"
COUNT_MIGRATION="$ROOT_DIR/supabase/migrations/20260729186000_post_hashtag_count_integrity.sql"
CLOSURE_MIGRATION="$ROOT_DIR/supabase/migrations/20260729187000_close_legacy_post_edit_signature.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/atomic-post-edit-facets-pg17.XXXXXX)"
PGDATA="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
PORT="$((57200 + ($$ % 700)))"

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

# This is the 184500 predeploy shape, intentionally without the 185000 direct-
# write closure or the 186000 count trigger. The facet authority must already
# be safe and complete in this phase because the matching application deploys
# before either postdeploy migration.
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
CREATE UNIQUE INDEX user_profiles_handle_lower_unique
  ON public.user_profiles (pg_catalog.lower(handle));

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

GRANT USAGE ON SCHEMA public, auth
  TO anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION auth.role()
  TO service_role, authenticated;
SQL

psql_cmd -f "$EDIT_BASE_MIGRATION"
psql_cmd -f "$CREATE_MIGRATION"
psql_cmd -f "$FACET_MIGRATION"
psql_cmd -f "$FACET_MIGRATION"
echo 'facet authority replay before closure'

ACTOR="11111111-1111-4111-8111-111111111111"
CREATOR="22222222-2222-4222-8222-222222222222"
MENTIONED="33333333-3333-4333-8333-333333333333"
INACTIVE="44444444-4444-4444-8444-444444444444"
POST="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

psql_cmd -v actor="$ACTOR" -v creator="$CREATOR" -v mentioned="$MENTIONED" \
  -v inactive="$INACTIVE" -v post="$POST" <<'SQL'
INSERT INTO auth.users (id)
VALUES (:'actor'), (:'creator'), (:'mentioned'), (:'inactive');
INSERT INTO public.user_profiles (id, handle, deleted_at)
VALUES
  (:'actor', 'Alice', NULL),
  (:'creator', 'Creator', NULL),
  (:'mentioned', 'Bob', NULL),
  (:'inactive', 'Gone', pg_catalog.clock_timestamp());

INSERT INTO public.posts (
  id, author_id, author_handle, title, content, language, mentions, hashtags
) VALUES (
  :'post', :'actor', 'Alice', 'Original', 'Original @Gone #oldtag',
  'en', ARRAY['Gone'], ARRAY['oldtag']
);
INSERT INTO public.hashtags (tag, post_count) VALUES ('oldtag', 0);
INSERT INTO public.post_hashtags (post_id, hashtag_id)
SELECT :'post', hashtag.id
FROM public.hashtags AS hashtag
WHERE hashtag.tag = 'oldtag';
UPDATE public.hashtags SET post_count = 1 WHERE tag = 'oldtag';
SQL

call_edit() {
  local actor="$1"
  local post_id="$2"
  local version="$3"
  local title="$4"
  local content="$5"
  local language="$6"
  local mentions_sql="$7"
  local tags_sql="$8"
  psql_cmd -At -v actor="$actor" -v post_id="$post_id" -v version="$version" \
    -v title="$title" -v content="$content" -v language="$language" <<SQL
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.edit_post_atomic(
  :'actor', :'post_id', :'version'::bigint, :'title', :'content',
  false, NULL, :'language', $mentions_sql, $tags_sql
);
SQL
}

legacy_compatible="$(psql_cmd -At -v actor="$ACTOR" -v post="$POST" <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.edit_post_atomic(
  :'actor', :'post', 0, 'Original', 'Original @Gone #oldtag', false, NULL
);
SQL
)"
grep -q '"status": "unchanged"' <<<"$legacy_compatible"
[[ "$(psql_cmd -At -c "SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'edit_post_atomic'")" == '2' ]]
echo 'predeploy legacy editor compatibility'

added="$(call_edit "$ACTOR" "$POST" 0 'First facets' 'Hello @Bob @Missing #alpha #oldtag' en "ARRAY['Bob','Missing']::text[]" "ARRAY['alpha','oldtag']::text[]")"
grep -q '"status": "updated"' <<<"$added"
grep -q '"language": "en"' <<<"$added"
grep -q '"mentions": \["Bob"\]' <<<"$added"
grep -q '"hashtags": \["alpha", "oldtag"\]' <<<"$added"
[[ "$(psql_cmd -At -F ':' -c "SELECT tag, post_count FROM public.hashtags WHERE tag IN ('alpha','oldtag') ORDER BY tag")" == $'alpha:1\noldtag:1' ]]

psql_cmd -c "UPDATE public.hashtags SET post_count = 99 WHERE tag = 'alpha'"
count_repaired="$(call_edit "$ACTOR" "$POST" 1 'First facets' 'Hello @Bob @Missing #alpha #oldtag' en "ARRAY['Bob','Missing']::text[]" "ARRAY['alpha','oldtag']::text[]")"
grep -q '"status": "updated"' <<<"$count_repaired"
grep -q '"revision_advanced": false' <<<"$count_repaired"
grep -q '"content_version": 1' <<<"$count_repaired"
[[ "$(psql_cmd -At -c "SELECT post_count FROM public.hashtags WHERE tag = 'alpha'")" == '1' ]]
echo 'unchanged content repaired count drift before trigger'

replaced="$(call_edit "$ACTOR" "$POST" 1 '교체' '@bob #beta' ko "ARRAY['bob']::text[]" "ARRAY['beta']::text[]")"
grep -q '"status": "updated"' <<<"$replaced"
grep -q '"language": "ko"' <<<"$replaced"
[[ "$(psql_cmd -At -F ':' -c "SELECT tag, post_count FROM public.hashtags WHERE tag IN ('alpha','beta','oldtag') ORDER BY tag")" == $'alpha:0\nbeta:1\noldtag:0' ]]

removed="$(call_edit "$ACTOR" "$POST" 2 'No facets' 'Plain body' en "ARRAY[]::text[]" "ARRAY[]::text[]")"
grep -q '"status": "updated"' <<<"$removed"
grep -q '"hashtags": \[\]' <<<"$removed"
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.post_hashtags WHERE post_id = '$POST'::uuid")" == '0' ]]
[[ "$(psql_cmd -At -c "SELECT post_count FROM public.hashtags WHERE tag = 'beta'")" == '0' ]]
echo 'add replace remove facets before count trigger'

unchanged="$(call_edit "$ACTOR" "$POST" 2 'No facets' 'Plain body' en "ARRAY[]::text[]" "ARRAY[]::text[]")"
grep -q '"status": "unchanged"' <<<"$unchanged"
grep -q '"content_version": 3' <<<"$unchanged"
echo 'lost acknowledgement retry'

call_edit "$ACTOR" "$POST" 3 'Concurrent A' '@Bob #gamma' en \
  "ARRAY['Bob']::text[]" "ARRAY['gamma']::text[]" >"$TMP_ROOT/edit-a.out" &
pid_a=$!
call_edit "$ACTOR" "$POST" 3 'Concurrent B' '@Bob #delta' en \
  "ARRAY['Bob']::text[]" "ARRAY['delta']::text[]" >"$TMP_ROOT/edit-b.out" &
pid_b=$!
wait "$pid_a"
wait "$pid_b"
race_output="$(cat "$TMP_ROOT/edit-a.out" "$TMP_ROOT/edit-b.out")"
[[ "$(grep -c '"status": "updated"' <<<"$race_output")" == '1' ]]
[[ "$(grep -c '"status": "conflict"' <<<"$race_output")" == '1' ]]
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.post_hashtags WHERE post_id = '$POST'::uuid")" == '1' ]]
echo 'concurrent facet edit compare-and-swap'

before_rollback="$(psql_cmd -At -F '|' -c "SELECT title, content_version, hashtags::text FROM public.posts WHERE id = '$POST'::uuid")"
before_counts="$(psql_cmd -At -F ':' -c "SELECT tag, post_count FROM public.hashtags ORDER BY tag")"
current_version="$(psql_cmd -At -c "SELECT content_version FROM public.posts WHERE id = '$POST'::uuid")"
psql_cmd -v actor="$ACTOR" -v post="$POST" -v version="$current_version" <<'SQL'
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
SELECT public.edit_post_atomic(
  :'actor', :'post', :'version'::bigint,
  'Rolled back', '@Bob #rollback', false, NULL, 'en',
  ARRAY['Bob']::text[], ARRAY['rollback']::text[]
);
ROLLBACK;
SQL
[[ "$(psql_cmd -At -F '|' -c "SELECT title, content_version, hashtags::text FROM public.posts WHERE id = '$POST'::uuid")" == "$before_rollback" ]]
[[ "$(psql_cmd -At -F ':' -c "SELECT tag, post_count FROM public.hashtags ORDER BY tag")" == "$before_counts" ]]
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.hashtags WHERE tag = 'rollback'")" == '0' ]]
echo 'transaction rollback preserves facets and counts'

# Exercise the actual 184500 create authority against the edit authority with
# the same two parent tags. Different actors avoid profile-row serialization,
# so this specifically proves their common C tag lock order does not deadlock.
latest_version="$(psql_cmd -At -c "SELECT content_version FROM public.posts WHERE id = '$POST'::uuid")"
call_edit "$ACTOR" "$POST" "$latest_version" 'Create edit race' '@Bob #alpha #zulu' en \
  "ARRAY['Bob']::text[]" "ARRAY['alpha','zulu']::text[]" >"$TMP_ROOT/create-edit.out" &
edit_pid=$!
psql_cmd -At -v creator="$CREATOR" <<'SQL' >"$TMP_ROOT/create-create.out" &
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.create_post_atomic(
  :'creator', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'Concurrent create', 'Body #alpha #zulu', NULL, ARRAY[]::text[],
  false, NULL, NULL, NULL, 'public', false, NULL, 'en',
  ARRAY[]::text[], ARRAY['alpha','zulu']::text[]
);
SQL
create_pid=$!
wait "$edit_pid"
wait "$create_pid"
grep -q '"status": "updated"' "$TMP_ROOT/create-edit.out"
grep -q '"status": "created"' "$TMP_ROOT/create-create.out"
[[ "$(psql_cmd -At -F ':' -c "SELECT tag, post_count FROM public.hashtags WHERE tag IN ('alpha','zulu') ORDER BY tag")" == $'alpha:2\nzulu:2' ]]
echo 'concurrent create edit tag lock order'

# Supply the compatibility recount signature and a closed browser DML state,
# then apply the real 186000 postdeploy migration. The facet authority did not
# require this trigger to serve the preceding application phase.
psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.recount_hashtag_posts(hashtag_ids uuid[])
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  UPDATE public.hashtags AS hashtag
  SET post_count = (
    SELECT pg_catalog.count(*)::integer
    FROM public.post_hashtags AS post_hashtag
    WHERE post_hashtag.hashtag_id = hashtag.id
  )
  WHERE hashtag.id = ANY(hashtag_ids);
$function$;
ALTER FUNCTION public.recount_hashtag_posts(uuid[]) OWNER TO postgres;
REVOKE INSERT, UPDATE, DELETE
  ON TABLE public.posts, public.hashtags, public.post_hashtags
  FROM PUBLIC, anon, authenticated, authenticator;
SQL
if psql_cmd -f "$CLOSURE_MIGRATION" >"$TMP_ROOT/early-closure.out" 2>"$TMP_ROOT/early-closure.err"; then
  echo 'legacy edit signature closed before count-trigger cutover' >&2
  exit 1
fi
grep -q 'facet-aware edit and hashtag count authorities must deploy first' "$TMP_ROOT/early-closure.err"
[[ "$(psql_cmd -At -c "SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'edit_post_atomic'")" == '2' ]]
echo 'early legacy closure failed closed'
psql_cmd -f "$COUNT_MIGRATION"
echo 'hashtag count trigger cutover'

latest_version="$(psql_cmd -At -c "SELECT content_version FROM public.posts WHERE id = '$POST'::uuid")"
after_trigger="$(call_edit "$ACTOR" "$POST" "$latest_version" 'After trigger' '@Bob #aftertrigger' en "ARRAY['Bob']::text[]" "ARRAY['aftertrigger']::text[]")"
grep -q '"status": "updated"' <<<"$after_trigger"
[[ "$(psql_cmd -At -c "SELECT post_count FROM public.hashtags WHERE tag = 'aftertrigger'")" == '1' ]]
[[ "$(psql_cmd -At -c "SELECT post_count FROM public.hashtags WHERE tag = 'alpha'")" == '1' ]]
[[ "$(psql_cmd -At -c "SELECT post_count FROM public.hashtags WHERE tag = 'zulu'")" == '1' ]]
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.hashtags AS h WHERE h.post_count IS DISTINCT FROM (SELECT count(*)::integer FROM public.post_hashtags AS ph WHERE ph.hashtag_id = h.id)")" == '0' ]]
echo 'facet edits after count trigger avoid double count'

psql_cmd -f "$FACET_MIGRATION"
post_trigger_version="$(psql_cmd -At -c "SELECT content_version FROM public.posts WHERE id = '$POST'::uuid")"
replayed_after_trigger="$(call_edit "$ACTOR" "$POST" "$post_trigger_version" 'After replay' '@Bob #afterreplay' en "ARRAY['Bob']::text[]" "ARRAY['afterreplay']::text[]")"
grep -q '"status": "updated"' <<<"$replayed_after_trigger"
[[ "$(psql_cmd -At -c "SELECT post_count FROM public.hashtags WHERE tag = 'afterreplay'")" == '1' ]]
[[ "$(psql_cmd -At -c "SELECT post_count FROM public.hashtags WHERE tag = 'aftertrigger'")" == '0' ]]
echo 'facet authority replay after count trigger'

psql_cmd -f "$CLOSURE_MIGRATION"
psql_cmd -f "$CLOSURE_MIGRATION"
[[ "$(psql_cmd -At -c "SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'edit_post_atomic'")" == '1' ]]
if psql_cmd -v actor="$ACTOR" -v post="$POST" >/dev/null 2>"$TMP_ROOT/legacy-closed.err" <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.edit_post_atomic(
  :'actor', :'post', 0, 'Legacy bypass', 'Legacy bypass', false, NULL
);
SQL
then
  echo 'legacy edit signature unexpectedly remained callable' >&2
  exit 1
fi
grep -qi 'function public.edit_post_atomic.*does not exist' "$TMP_ROOT/legacy-closed.err"
echo 'legacy edit signature postdeploy closure'

closed_version="$(psql_cmd -At -c "SELECT content_version FROM public.posts WHERE id = '$POST'::uuid")"
closed_available="$(call_edit "$ACTOR" "$POST" "$closed_version" 'After replay' '@Bob #afterreplay' en "ARRAY['Bob']::text[]" "ARRAY['afterreplay']::text[]")"
grep -q '"status": "unchanged"' <<<"$closed_available"
echo 'facet edit remains available after closure'

if psql_cmd -v actor="$ACTOR" -v post="$POST" -v version="$post_trigger_version" \
  >/dev/null 2>"$TMP_ROOT/authenticated.err" <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT public.edit_post_atomic(
  :'actor', :'post', :'version'::bigint,
  'Bypass', 'Bypass', false, NULL, 'en', ARRAY[]::text[], ARRAY[]::text[]
);
SQL
then
  echo 'authenticated facet edit unexpectedly succeeded' >&2
  exit 1
fi
grep -qi 'permission denied' "$TMP_ROOT/authenticated.err"
[[ "$(psql_cmd -At -c "SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'edit_post_atomic'")" == '1' ]]
echo 'service-only facet edit ACL'

echo 'atomic post edit facets PostgreSQL 17 proof passed'
