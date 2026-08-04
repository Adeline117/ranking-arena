#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for hashtag read authority, privacy-safe
# counts/pages, service-only synchronization, and migration convergence.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260803180000_hashtag_read_authority.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/hashtag-read-authority-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=$((57000 + $$ % 7000))
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if (( exit_status != 0 )) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    echo "PostgreSQL 17 hashtag proof cluster log:" >&2
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if (( exit_status != 0 )); then
    for proof_log in "$LOG_DIR"/*.log; do
      [[ -f "$proof_log" ]] || continue
      [[ "$proof_log" == "$LOG_DIR/postgres.log" ]] && continue
      echo "PostgreSQL 17 hashtag proof command log: $proof_log" >&2
      tail -120 "$proof_log" >&2 || true
    done
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop \
      >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --username=cluster_admin \
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
  -U cluster_admin
  -d postgres
)

PSQL_POSTGRES=(
  "$PG_BIN/psql"
  -X
  -v ON_ERROR_STOP=1
  -h "$SOCKET_DIR"
  -p "$PORT"
  -U postgres
  -d postgres
)

run_migration() {
  local label="$1"
  "${PSQL_POSTGRES[@]}" -f "$MIGRATION" \
    >"$LOG_DIR/$label.log" 2>&1
}

expect_migration_failure() {
  local label="$1"
  local expected="$2"
  if run_migration "$label"; then
    echo "Migration unexpectedly succeeded: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" "$LOG_DIR/$label.log"; then
    echo "Migration failure did not contain '$expected': $label" >&2
    cat "$LOG_DIR/$label.log" >&2
    exit 1
  fi
}

expect_sql_failure() {
  local label="$1"
  local expected="$2"
  local statement="$3"
  if "${PSQL[@]}" -c "$statement" >"$LOG_DIR/$label.log" 2>&1; then
    echo "SQL unexpectedly succeeded: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" "$LOG_DIR/$label.log"; then
    echo "SQL failure did not contain '$expected': $label" >&2
    cat "$LOG_DIR/$label.log" >&2
    exit 1
  fi
}

"${PSQL[@]}" <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOSUPERUSER NOBYPASSRLS;

CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA public, auth
  TO postgres, anon, authenticated, service_role;
GRANT CREATE ON SCHEMA public TO postgres;

CREATE TYPE public.post_status AS ENUM ('active', 'locked', 'deleted');

CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.role', true),
    ''
  )
$function$;

GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  deleted_at timestamptz,
  banned_at timestamptz
);

CREATE TABLE public.blocked_users (
  blocker_id uuid NOT NULL,
  blocked_id uuid NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  title text,
  content text,
  author_id uuid NOT NULL,
  author_handle text,
  author_avatar_url text,
  author_is_verified boolean,
  group_id uuid,
  poll_enabled boolean,
  poll_id uuid,
  poll_bull integer,
  poll_bear integer,
  poll_wait integer,
  like_count integer,
  dislike_count integer,
  comment_count integer,
  bookmark_count integer,
  repost_count integer,
  view_count integer,
  hot_score double precision,
  is_pinned boolean,
  images text[],
  created_at timestamptz,
  updated_at timestamptz,
  original_post_id uuid REFERENCES public.posts(id) ON DELETE SET NULL,
  visibility text NOT NULL,
  is_sensitive boolean,
  content_warning text,
  language text,
  status public.post_status NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE public.post_likes (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  reaction_type text,
  UNIQUE (post_id, user_id)
);

CREATE TABLE public.post_votes (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  choice text NOT NULL,
  UNIQUE (post_id, user_id)
);

CREATE TABLE public.hashtags (
  id uuid PRIMARY KEY,
  tag text NOT NULL UNIQUE,
  post_count integer DEFAULT 0,
  created_at timestamptz DEFAULT pg_catalog.now()
);

CREATE TABLE public.post_hashtags (
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  hashtag_id uuid NOT NULL REFERENCES public.hashtags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, hashtag_id)
);

ALTER TABLE public.posts OWNER TO postgres;
ALTER TABLE public.post_likes OWNER TO postgres;
ALTER TABLE public.post_votes OWNER TO postgres;
ALTER TABLE public.hashtags OWNER TO postgres;
ALTER TABLE public.post_hashtags OWNER TO postgres;

ALTER TABLE public.hashtags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_hashtags ENABLE ROW LEVEL SECURITY;

-- Reproduce the vulnerable legacy table boundary.
CREATE POLICY legacy_hashtags_public_read
  ON public.hashtags FOR SELECT TO PUBLIC USING (true);
CREATE POLICY legacy_hashtags_authenticated_insert
  ON public.hashtags FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY legacy_post_hashtags_public_read
  ON public.post_hashtags FOR SELECT TO PUBLIC USING (true);
CREATE POLICY legacy_post_hashtags_authenticated_insert
  ON public.post_hashtags FOR INSERT TO authenticated WITH CHECK (true);
GRANT SELECT ON public.hashtags, public.post_hashtags TO PUBLIC, anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.hashtags, public.post_hashtags
  TO authenticated;

-- Minimal executable model of the already-installed canonical authority.  It
-- owns active-viewer and bidirectional-block semantics; the hashtag RPC must
-- compose this helper instead of copying those rules.
CREATE FUNCTION public.can_actor_read_post_fields(
  p_viewer_id uuid,
  p_author_id uuid,
  p_group_id uuid,
  p_visibility text,
  p_status public.post_status,
  p_deleted_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH effective_viewer AS MATERIALIZED (
    SELECT CASE
      WHEN EXISTS (
        SELECT 1
        FROM public.user_profiles AS profile
        WHERE profile.id = p_viewer_id
          AND profile.deleted_at IS NULL
          AND profile.banned_at IS NULL
      ) THEN p_viewer_id
      ELSE NULL::uuid
    END AS id
  )
  SELECT COALESCE(
    p_author_id IS NOT NULL
    AND p_group_id IS NULL
    AND p_deleted_at IS NULL
    AND p_status IN ('active', 'locked')
    AND NOT EXISTS (
      SELECT 1
      FROM public.blocked_users AS block_edge
      WHERE (
        block_edge.blocker_id = (SELECT viewer.id FROM effective_viewer AS viewer)
        AND block_edge.blocked_id = p_author_id
      ) OR (
        block_edge.blocker_id = p_author_id
        AND block_edge.blocked_id = (SELECT viewer.id FROM effective_viewer AS viewer)
      )
    )
    AND (
      p_visibility = 'public'
      OR p_author_id = (SELECT viewer.id FROM effective_viewer AS viewer)
    ),
    false
  )
$function$;

-- A wrapper is readable only if both it and its ordinary root are readable.
CREATE FUNCTION public.can_actor_read_post_id(
  p_post_id uuid,
  p_viewer_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE((
    SELECT public.can_actor_read_post_fields(
      p_viewer_id,
      wrapper.author_id,
      wrapper.group_id,
      wrapper.visibility,
      wrapper.status,
      wrapper.deleted_at
    )
      AND (
        wrapper.original_post_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.posts AS root
          WHERE root.id = wrapper.original_post_id
            AND root.original_post_id IS NULL
            AND public.can_actor_read_post_fields(
              p_viewer_id,
              root.author_id,
              root.group_id,
              root.visibility,
              root.status,
              root.deleted_at
            )
        )
      )
    FROM public.posts AS wrapper
    WHERE wrapper.id = p_post_id
  ), false)
$function$;

ALTER FUNCTION public.can_actor_read_post_fields(
  uuid, uuid, uuid, text, public.post_status, timestamptz
) OWNER TO postgres;
ALTER FUNCTION public.can_actor_read_post_id(uuid, uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.can_actor_read_post_fields(
  uuid, uuid, uuid, text, public.post_status, timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_actor_read_post_id(uuid, uuid) FROM PUBLIC;

GRANT SELECT ON TABLE public.posts, public.user_profiles, public.blocked_users,
  public.post_likes, public.post_votes TO postgres;

-- Legacy recount plus executable phantom overloads reproduce upgrade drift.
CREATE FUNCTION public.recount_hashtag_posts(hashtag_ids uuid[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $function$
  UPDATE public.hashtags AS hashtag
  SET post_count = 999
  WHERE hashtag.id = ANY(hashtag_ids)
$function$;

CREATE FUNCTION public.recount_hashtag_posts(hashtag_ids text[])
RETURNS void
LANGUAGE sql
AS $function$
  SELECT NULL::void
$function$;

CREATE FUNCTION public.get_trending_hashtags_public(p_limit text)
RETURNS jsonb
LANGUAGE sql
AS $function$
  SELECT '{"leaked":true}'::jsonb
$function$;

CREATE FUNCTION public.get_hashtag_posts_page(
  p_viewer_id text,
  p_tag text,
  p_limit bigint,
  p_offset bigint,
  p_sort_by text
)
RETURNS jsonb
LANGUAGE sql
AS $function$
  SELECT '{"leaked":true}'::jsonb
$function$;

ALTER FUNCTION public.recount_hashtag_posts(uuid[]) OWNER TO postgres;
ALTER FUNCTION public.recount_hashtag_posts(text[]) OWNER TO postgres;
ALTER FUNCTION public.get_trending_hashtags_public(text) OWNER TO postgres;
ALTER FUNCTION public.get_hashtag_posts_page(
  text, text, bigint, bigint, text
) OWNER TO postgres;

GRANT EXECUTE ON FUNCTION public.recount_hashtag_posts(uuid[]),
  public.recount_hashtag_posts(text[]),
  public.get_trending_hashtags_public(text),
  public.get_hashtag_posts_page(text,text,bigint,bigint,text)
TO PUBLIC, anon, authenticated, service_role;

INSERT INTO public.user_profiles (id, deleted_at, banned_at)
VALUES
  ('10000000-0000-0000-0000-000000000001', NULL, NULL),
  ('20000000-0000-0000-0000-000000000002', NULL, NULL),
  ('30000000-0000-0000-0000-000000000003', NULL, NULL),
  ('40000000-0000-0000-0000-000000000004', NULL, '2026-01-01 00:00:00+00'),
  ('50000000-0000-0000-0000-000000000005', '2026-01-01 00:00:00+00', NULL);

INSERT INTO public.blocked_users (blocker_id, blocked_id)
VALUES (
  '20000000-0000-0000-0000-000000000002',
  '30000000-0000-0000-0000-000000000003'
);

INSERT INTO public.posts (
  id, title, content, author_id, author_handle, author_avatar_url,
  author_is_verified, poll_enabled, poll_bull, poll_bear, poll_wait,
  like_count, dislike_count, comment_count, bookmark_count, repost_count,
  view_count, hot_score, is_pinned, images, created_at, updated_at,
  original_post_id, visibility, is_sensitive, content_warning, language,
  status, deleted_at
)
VALUES
  -- Anonymous-readable BTC rows.  The first two tie on time, proving id DESC.
  ('00000000-0000-0000-0000-000000000101',
   'public-a #btc #eth', '#123456789012345678901234567890x',
   '30000000-0000-0000-0000-000000000003', 'public', '/a.png', true,
   false, 0, 0, 0, 1, 0, 0, 0, 0, 1, 10, false, ARRAY[]::text[],
   '2026-01-09 00:00:00+00', '2026-01-09 00:00:00+00', NULL,
   'public', false, NULL, 'en', 'active', NULL),
  ('00000000-0000-0000-0000-000000000102', 'public-b #BTC #eth', 'b',
   '30000000-0000-0000-0000-000000000003', 'public', '/b.png', false,
   true, 2, 1, 0, 2, 0, 1, 0, 0, 2, 10, false, ARRAY['/b.jpg'],
   '2026-01-09 00:00:00+00', '2026-01-09 00:00:00+00', NULL,
   'public', false, NULL, 'en', 'active', NULL),
  ('00000000-0000-0000-0000-000000000103', 'public-c #btc #zero', 'c',
   '30000000-0000-0000-0000-000000000003', 'public', '/c.png', false,
   false, 0, 0, 0, 3, 1, 2, 1, 1, 3, 20, true, ARRAY[]::text[],
   '2026-01-07 00:00:00+00', '2026-01-07 00:00:00+00', NULL,
   'public', true, 'warning', 'zh', 'locked', NULL),
  -- Owner-only direct row sits ahead of the public page and used to make a hole.
  ('00000000-0000-0000-0000-000000000104',
   'private #btc #privateonly', 'private',
   '10000000-0000-0000-0000-000000000001', 'owner', '/owner.png', true,
   false, 0, 0, 0, 0, 0, 0, 0, 0, 0, 999, false, NULL,
   '2026-01-10 00:00:00+00', '2026-01-10 00:00:00+00', NULL,
   'followers', false, NULL, 'en', 'active', NULL),
  -- Deleted rows never pass the canonical authority.
  ('00000000-0000-0000-0000-000000000105', 'deleted #btc', 'deleted',
   '30000000-0000-0000-0000-000000000003', 'public', NULL, false,
   false, 0, 0, 0, 0, 0, 0, 0, 0, 0, 500, false, NULL,
   '2026-01-08 00:00:00+00', '2026-01-08 00:00:00+00', NULL,
   'public', false, NULL, 'en', 'active', '2026-01-11 00:00:00+00'),
  -- Hidden roots themselves need not carry the hashtag.
  ('00000000-0000-0000-0000-000000000110', 'private-root', 'root',
   '10000000-0000-0000-0000-000000000001', 'owner', NULL, true,
   false, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, NULL,
   '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', NULL,
   'followers', false, NULL, 'en', 'active', NULL),
  ('00000000-0000-0000-0000-000000000111',
   'private-root-repost #btc', 'wrapper',
   '30000000-0000-0000-0000-000000000003', 'public', NULL, false,
   false, 0, 0, 0, 0, 0, 0, 0, 0, 0, 800, false, NULL,
   '2026-01-12 00:00:00+00', '2026-01-12 00:00:00+00',
   '00000000-0000-0000-0000-000000000110',
   'public', false, NULL, 'en', 'active', NULL),
  ('00000000-0000-0000-0000-000000000112', 'deleted-root', 'root',
   '30000000-0000-0000-0000-000000000003', 'public', NULL, false,
   false, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, NULL,
   '2026-01-01 00:00:00+00', '2026-01-01 00:00:00+00', NULL,
   'public', false, NULL, 'en', 'active', '2026-01-02 00:00:00+00'),
  ('00000000-0000-0000-0000-000000000113',
   'deleted-root-repost #btc', 'wrapper',
   '30000000-0000-0000-0000-000000000003', 'public', NULL, false,
   false, 0, 0, 0, 0, 0, 0, 0, 0, 0, 700, false, NULL,
   '2026-01-11 00:00:00+00', '2026-01-11 00:00:00+00',
   '00000000-0000-0000-0000-000000000112',
   'public', false, NULL, 'en', 'active', NULL);

INSERT INTO public.hashtags (id, tag, post_count)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'btc', 999),
  ('a0000000-0000-0000-0000-000000000002', 'eth', 999),
  ('a0000000-0000-0000-0000-000000000003', 'privateonly', 999),
  ('a0000000-0000-0000-0000-000000000004', 'zero', 999),
  ('a0000000-0000-0000-0000-000000000005', 'forged', 999),
  ('a0000000-0000-0000-0000-000000000006', '123456789012345678901234567890', 999),
  ('a0000000-0000-0000-0000-000000000007', 'UPPER', 999),
  ('a0000000-0000-0000-0000-000000000008', '1234567890123456789012345678901', 999);

INSERT INTO public.post_hashtags (post_id, hashtag_id)
VALUES
  ('00000000-0000-0000-0000-000000000101', 'a0000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000102', 'a0000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000103', 'a0000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000104', 'a0000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000105', 'a0000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000111', 'a0000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000113', 'a0000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000101', 'a0000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000102', 'a0000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000104', 'a0000000-0000-0000-0000-000000000003'),
  ('00000000-0000-0000-0000-000000000103', 'a0000000-0000-0000-0000-000000000004'),
  -- Canonical-looking but forged/stale mappings must not become read authority.
  ('00000000-0000-0000-0000-000000000101', 'a0000000-0000-0000-0000-000000000005'),
  ('00000000-0000-0000-0000-000000000101', 'a0000000-0000-0000-0000-000000000006'),
  -- Historical invalid registry rows are removed before constraint validation.
  ('00000000-0000-0000-0000-000000000101', 'a0000000-0000-0000-0000-000000000007'),
  ('00000000-0000-0000-0000-000000000101', 'a0000000-0000-0000-0000-000000000008');

INSERT INTO public.post_likes (id, post_id, user_id, reaction_type)
VALUES (
  'b0000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000104',
  '10000000-0000-0000-0000-000000000001',
  'up'
);

INSERT INTO public.post_votes (id, post_id, user_id, choice)
VALUES (
  'c0000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000104',
  '10000000-0000-0000-0000-000000000001',
  'bull'
);
SQL

# The migration itself, including historical-tag deletion, runs as the table
# owner while that role remains NOSUPERUSER/NOBYPASSRLS.  This catches ordering
# bugs that a cluster superuser would silently bypass.
"${PSQL_POSTGRES[@]}" <<'SQL'
DO $topology$
BEGIN
  IF current_user IS DISTINCT FROM 'postgres'
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_roles AS role_row
       WHERE role_row.rolname = current_user
         AND (role_row.rolsuper OR role_row.rolbypassrls)
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation
       WHERE relation.oid IN (
         'public.hashtags'::pg_catalog.regclass,
         'public.post_hashtags'::pg_catalog.regclass,
         'public.posts'::pg_catalog.regclass,
         'public.post_likes'::pg_catalog.regclass,
         'public.post_votes'::pg_catalog.regclass
       )
         AND pg_catalog.pg_get_userbyid(relation.relowner)
           IS DISTINCT FROM 'postgres'
     )
  THEN
    RAISE EXCEPTION 'migration proof is not running as postgres table owner without bypass';
  END IF;
END;
$topology$;
SQL

run_migration first_install

# Parent/child tables have independently addressable ACL/RLS surfaces.  The
# migration must reject either side of inheritance rather than securing only
# the named parent.
"${PSQL[@]}" -c \
  'CREATE TABLE public.hashtags_inheritance_probe () INHERITS (public.hashtags)' \
  >/dev/null
expect_migration_failure \
  inherited_hashtag_surface \
  "hashtag authority base tables are incompatible"
"${PSQL[@]}" -c 'DROP TABLE public.hashtags_inheritance_probe' >/dev/null

# Deliberately reintroduce ACL, policy, and phantom-overload drift.  Re-entry
# must converge all of it without changing data or failing on existing objects.
"${PSQL_POSTGRES[@]}" <<'SQL'
GRANT SELECT ON public.hashtags TO anon;
GRANT TRUNCATE ON public.hashtags TO anon;
GRANT REFERENCES ON public.post_hashtags TO authenticated;
GRANT TRIGGER ON public.hashtags TO service_role;
GRANT SELECT (tag) ON public.hashtags TO PUBLIC;
GRANT UPDATE (post_id) ON public.post_hashtags TO authenticated;
CREATE POLICY drift_public_hashtag_read
  ON public.hashtags FOR SELECT TO PUBLIC USING (true);
CREATE FUNCTION public.recount_hashtag_posts(hashtag_ids text[])
RETURNS void LANGUAGE sql AS 'SELECT NULL::void';
CREATE FUNCTION public.get_trending_hashtags_public(p_limit text)
RETURNS jsonb LANGUAGE sql AS 'SELECT ''{"leaked":true}''::jsonb';
CREATE FUNCTION public.get_hashtag_posts_page(
  p_viewer_id text,
  p_tag text,
  p_limit bigint,
  p_offset bigint,
  p_sort_by text
)
RETURNS jsonb LANGUAGE sql AS 'SELECT ''{"leaked":true}''::jsonb';
GRANT EXECUTE ON FUNCTION public.recount_hashtag_posts(text[]),
  public.get_trending_hashtags_public(text),
  public.get_hashtag_posts_page(text,text,bigint,bigint,text)
TO PUBLIC, anon, authenticated, service_role;
SQL

run_migration replay_after_drift

expect_sql_failure \
  anon_direct_hashtag_read \
  "permission denied for table hashtags" \
  "SET ROLE anon; SELECT tag FROM public.hashtags"

expect_sql_failure \
  authenticated_direct_mapping_insert \
  "permission denied for table post_hashtags" \
  "SET ROLE authenticated; INSERT INTO public.post_hashtags(post_id, hashtag_id) VALUES ('00000000-0000-0000-0000-000000000101', 'a0000000-0000-0000-0000-000000000004') ON CONFLICT DO NOTHING"

expect_sql_failure \
  postgres_delete_is_not_runtime_authority \
  "permission denied for table hashtags" \
  "SET ROLE postgres; DELETE FROM public.hashtags WHERE tag = 'btc'"

expect_sql_failure \
  canonical_tag_constraint \
  "violates check constraint \"hashtags_tag_canonical_check\"" \
  "SET ROLE service_role; INSERT INTO public.hashtags(id, tag, post_count) VALUES ('a0000000-0000-0000-0000-000000000098', 'UPPER', 0)"

expect_sql_failure \
  anon_rpc_execute \
  "permission denied for function get_trending_hashtags_public" \
  "SET ROLE anon; SELECT public.get_trending_hashtags_public(20)"

expect_sql_failure \
  service_claim_required \
  "service role required" \
  "SET ROLE service_role; SELECT public.get_trending_hashtags_public(20)"

expect_sql_failure \
  definer_internal_role_guard \
  "service role required" \
  "SELECT pg_catalog.set_config('request.jwt.claim.role', 'anon', false); SELECT public.get_trending_hashtags_public(20)"

expect_sql_failure \
  invalid_trending_limit \
  "invalid hashtag trending input" \
  "SET ROLE service_role; SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false); SELECT public.get_trending_hashtags_public(0)"

expect_sql_failure \
  invalid_page_tag \
  "invalid hashtag posts page input" \
  "SET ROLE service_role; SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false); SELECT public.get_hashtag_posts_page(NULL, ' btc ', 20, 0, 'created_at')"

expect_sql_failure \
  invalid_page_offset \
  "invalid hashtag posts page input" \
  "SET ROLE service_role; SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false); SELECT public.get_hashtag_posts_page(NULL, 'btc', 20, 10001, 'created_at')"

expect_sql_failure \
  invalid_page_sort \
  "invalid hashtag posts page input" \
  "SET ROLE service_role; SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false); SELECT public.get_hashtag_posts_page(NULL, 'btc', 20, 0, 'likes')"

expect_sql_failure \
  invalid_recount_null_element \
  "invalid hashtag recount input" \
  "SET ROLE service_role; SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false); SELECT public.recount_hashtag_posts(ARRAY[NULL]::uuid[])"

"${PSQL[@]}" <<'SQL'
SET ROLE service_role;

-- Full service synchronization remains possible under FORCE RLS without a
-- JWT claim because the policy itself is scoped TO service_role.
INSERT INTO public.hashtags (id, tag, post_count)
VALUES ('a0000000-0000-0000-0000-000000000099', 'sync', 0);
UPDATE public.hashtags SET tag = 'sync2'
WHERE id = 'a0000000-0000-0000-0000-000000000099';
DELETE FROM public.hashtags
WHERE id = 'a0000000-0000-0000-0000-000000000099';

SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

DO $assertions$
DECLARE
  v_trending jsonb;
  v_page jsonb;
  v_owner_page jsonb;
  v_other_page jsonb;
  v_banned_page jsonb;
  v_deleted_page jsonb;
  v_missing_viewer_page jsonb;
  v_hot_page jsonb;
  v_empty_page jsonb;
  v_post_keys text[];
BEGIN
  v_trending := public.get_trending_hashtags_public(20);

  IF v_trending - ARRAY['contract', 'viewer_id', 'limit', 'hashtags']::text[]
       <> '{}'::jsonb
     OR v_trending->>'contract' IS DISTINCT FROM 'hashtag_trending_v1'
     OR pg_catalog.jsonb_typeof(v_trending->'viewer_id') IS DISTINCT FROM 'null'
     OR (v_trending->>'limit')::integer IS DISTINCT FROM 20
  THEN
    RAISE EXCEPTION 'trending acknowledgement is not exact: %', v_trending;
  END IF;

  IF pg_catalog.jsonb_array_length(v_trending->'hashtags') <> 3
     OR v_trending->'hashtags'->0->>'tag' IS DISTINCT FROM 'btc'
     OR (v_trending->'hashtags'->0->>'post_count')::integer IS DISTINCT FROM 3
     OR v_trending->'hashtags'->1->>'tag' IS DISTINCT FROM 'eth'
     OR (v_trending->'hashtags'->1->>'post_count')::integer IS DISTINCT FROM 2
     OR v_trending->'hashtags'->2->>'tag' IS DISTINCT FROM 'zero'
     OR (v_trending->'hashtags'->2->>'post_count')::integer IS DISTINCT FROM 1
     OR v_trending::text LIKE '%privateonly%'
     OR v_trending::text LIKE '%forged%'
     OR v_trending::text LIKE '%123456789012345678901234567890%'
     OR v_trending::text LIKE '%UPPER%'
  THEN
    RAISE EXCEPTION 'trending leaked unreadable tags/counts: %', v_trending;
  END IF;

  v_page := public.get_hashtag_posts_page(
    NULL, 'BTC', 2, 0, 'created_at'
  );

  IF v_page - ARRAY[
     'contract', 'viewer_state', 'request', 'posts', 'total', 'has_more',
     'next_cursor'
     ]::text[] <> '{}'::jsonb
     OR v_page->>'contract' IS DISTINCT FROM 'hashtag_posts_page_v1'
     OR v_page->>'viewer_state' IS DISTINCT FROM 'anonymous'
     OR v_page->'request' IS DISTINCT FROM pg_catalog.jsonb_build_object(
       'viewer_id', NULL::uuid,
       'tag', 'btc',
       'limit', 2,
       'offset', 0,
       'sort_by', 'created_at'
     )
     OR (v_page->>'total')::integer IS DISTINCT FROM 3
     OR (v_page->>'has_more')::boolean IS DISTINCT FROM true
     OR pg_catalog.jsonb_typeof(v_page->'next_cursor') IS DISTINCT FROM 'null'
  THEN
    RAISE EXCEPTION 'page acknowledgement is not exact: %', v_page;
  END IF;

  -- The unreadable newest/private and deleted rows do not create page holes;
  -- equal timestamps are deterministically ordered by id DESC.
  IF pg_catalog.jsonb_array_length(v_page->'posts') <> 2
     OR v_page->'posts'->0->>'id'
          IS DISTINCT FROM '00000000-0000-0000-0000-000000000102'
     OR v_page->'posts'->1->>'id'
          IS DISTINCT FROM '00000000-0000-0000-0000-000000000101'
     OR pg_catalog.jsonb_typeof(v_page->'posts'->0->'user_reaction')
          IS DISTINCT FROM 'null'
     OR pg_catalog.jsonb_typeof(v_page->'posts'->0->'user_vote')
          IS DISTINCT FROM 'null'
  THEN
    RAISE EXCEPTION 'created-at page order/shape is wrong: %', v_page;
  END IF;

  SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
  INTO v_post_keys
  FROM pg_catalog.jsonb_object_keys(v_page->'posts'->0) AS key_row(key_name);

  IF v_post_keys IS DISTINCT FROM ARRAY[
    'author_avatar_url', 'author_handle', 'author_id', 'author_is_verified',
    'bookmark_count', 'comment_count', 'content', 'content_warning',
    'created_at', 'dislike_count', 'group_id', 'hot_score', 'id', 'images',
    'is_pinned', 'is_sensitive', 'language', 'like_count', 'original_post_id',
    'poll_bear', 'poll_bull', 'poll_enabled', 'poll_id', 'poll_wait',
    'repost_count', 'title', 'updated_at', 'user_reaction', 'user_vote',
    'view_count', 'visibility'
  ]::text[] THEN
    RAISE EXCEPTION 'post projection drifted: %', v_post_keys;
  END IF;

  v_page := public.get_hashtag_posts_page(
    NULL, 'btc', 2, 2, 'created_at'
  );
  IF (v_page->>'total')::integer IS DISTINCT FROM 3
     OR (v_page->>'has_more')::boolean IS DISTINCT FROM false
     OR pg_catalog.jsonb_array_length(v_page->'posts') <> 1
     OR v_page->'posts'->0->>'id'
          IS DISTINCT FROM '00000000-0000-0000-0000-000000000103'
  THEN
    RAISE EXCEPTION 'readable-first offset page has a hole: %', v_page;
  END IF;

  v_owner_page := public.get_hashtag_posts_page(
    '10000000-0000-0000-0000-000000000001',
    'btc', 20, 0, 'created_at'
  );
  v_other_page := public.get_hashtag_posts_page(
    '20000000-0000-0000-0000-000000000002',
    'btc', 20, 0, 'created_at'
  );
  v_banned_page := public.get_hashtag_posts_page(
    '40000000-0000-0000-0000-000000000004',
    'btc', 20, 0, 'created_at'
  );
  v_deleted_page := public.get_hashtag_posts_page(
    '50000000-0000-0000-0000-000000000005',
    'btc', 20, 0, 'created_at'
  );
  v_missing_viewer_page := public.get_hashtag_posts_page(
    '60000000-0000-0000-0000-000000000006',
    'btc', 20, 0, 'created_at'
  );

  IF (v_owner_page->>'total')::integer IS DISTINCT FROM 5
     OR v_owner_page->>'viewer_state' IS DISTINCT FROM 'active'
     OR v_owner_page->'request'->>'viewer_id'
          IS DISTINCT FROM '10000000-0000-0000-0000-000000000001'
     OR v_owner_page::text NOT LIKE '%000000000104%'
     OR v_owner_page::text NOT LIKE '%000000000111%'
     OR v_owner_page::text LIKE '%000000000105%'
     OR v_owner_page::text LIKE '%000000000113%'
     OR v_owner_page->'posts'->1->>'id'
          IS DISTINCT FROM '00000000-0000-0000-0000-000000000104'
     OR v_owner_page->'posts'->1->>'user_reaction' IS DISTINCT FROM 'up'
     OR v_owner_page->'posts'->1->>'user_vote' IS DISTINCT FROM 'bull'
     OR v_other_page->>'viewer_state' IS DISTINCT FROM 'active'
     OR (v_other_page->>'total')::integer IS DISTINCT FROM 0
     OR v_other_page->'posts' IS DISTINCT FROM '[]'::jsonb
  THEN
    RAISE EXCEPTION 'viewer/block/repost-root authority drifted: owner=%, other=%',
      v_owner_page, v_other_page;
  END IF;

  IF v_banned_page->>'viewer_state' IS DISTINCT FROM 'invalid'
     OR v_banned_page->'request'->>'viewer_id'
          IS DISTINCT FROM '40000000-0000-0000-0000-000000000004'
     OR v_banned_page->'posts' IS DISTINCT FROM '[]'::jsonb
     OR (v_banned_page->>'total')::integer IS DISTINCT FROM 0
     OR (v_banned_page->>'has_more')::boolean IS DISTINCT FROM false
     OR v_deleted_page->>'viewer_state' IS DISTINCT FROM 'invalid'
     OR v_deleted_page->'posts' IS DISTINCT FROM '[]'::jsonb
     OR (v_deleted_page->>'total')::integer IS DISTINCT FROM 0
     OR v_missing_viewer_page->>'viewer_state' IS DISTINCT FROM 'invalid'
     OR v_missing_viewer_page->'posts' IS DISTINCT FROM '[]'::jsonb
     OR (v_missing_viewer_page->>'total')::integer IS DISTINCT FROM 0
  THEN
    RAISE EXCEPTION 'invalid viewer did not fail closed: banned=%, deleted=%, missing=%',
      v_banned_page, v_deleted_page, v_missing_viewer_page;
  END IF;

  v_hot_page := public.get_hashtag_posts_page(
    NULL, 'btc', 20, 0, 'hot_score'
  );
  IF v_hot_page->'posts'->0->>'id'
       IS DISTINCT FROM '00000000-0000-0000-0000-000000000103'
     OR v_hot_page->'posts'->1->>'id'
       IS DISTINCT FROM '00000000-0000-0000-0000-000000000102'
     OR v_hot_page->'posts'->2->>'id'
       IS DISTINCT FROM '00000000-0000-0000-0000-000000000101'
  THEN
    RAISE EXCEPTION 'hot-score full ordering drifted: %', v_hot_page;
  END IF;

  v_empty_page := public.get_hashtag_posts_page(
    NULL, 'missing', 20, 0, 'created_at'
  );
  IF (v_empty_page->>'total')::integer IS DISTINCT FROM 0
     OR v_empty_page->'posts' IS DISTINCT FROM '[]'::jsonb
     OR (v_empty_page->>'has_more')::boolean IS DISTINCT FROM false
  THEN
    RAISE EXCEPTION 'valid absent tag did not return an exact empty page: %',
      v_empty_page;
  END IF;

  v_empty_page := public.get_hashtag_posts_page(
    NULL, '比特币', 20, 0, 'created_at'
  );
  IF v_empty_page->'request'->>'tag' IS DISTINCT FROM '比特币'
     OR v_empty_page->'posts' IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'Unicode hashtag validation/canonicalization drifted: %',
      v_empty_page;
  END IF;

  v_empty_page := public.get_hashtag_posts_page(
    NULL, 'БИТКОИН', 20, 0, 'created_at'
  );
  IF v_empty_page->'request'->>'tag' IS DISTINCT FROM 'биткоин'
     OR v_empty_page->'posts' IS DISTINCT FROM '[]'::jsonb THEN
    RAISE EXCEPTION 'Unicode lowercase canonicalization drifted: %',
      v_empty_page;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.hashtags AS hashtag
    WHERE hashtag.tag IN ('UPPER', '1234567890123456789012345678901')
  ) OR NOT EXISTS (
    SELECT 1 FROM public.hashtags AS hashtag WHERE hashtag.tag = 'forged'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.hashtags AS hashtag
    WHERE hashtag.tag = '123456789012345678901234567890'
  ) THEN
    RAISE EXCEPTION 'historical canonical tag convergence drifted';
  END IF;

  v_empty_page := public.get_hashtag_posts_page(
    NULL, 'forged', 20, 0, 'created_at'
  );
  IF v_empty_page->'posts' IS DISTINCT FROM '[]'::jsonb
     OR (v_empty_page->>'total')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'forged mapping became page authority: %', v_empty_page;
  END IF;

  v_empty_page := public.get_hashtag_posts_page(
    NULL, '123456789012345678901234567890', 20, 0, 'created_at'
  );
  IF v_empty_page->'posts' IS DISTINCT FROM '[]'::jsonb
     OR (v_empty_page->>'total')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'overlong token prefix became page authority: %', v_empty_page;
  END IF;

  -- Recount is raw internal synchronization state, resets zero, and is not the
  -- authority used by either public response.
  PERFORM public.recount_hashtag_posts(ARRAY[
    'a0000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000004'
  ]::uuid[]);

  IF (SELECT hashtag.post_count FROM public.hashtags AS hashtag
      WHERE hashtag.tag = 'btc') IS DISTINCT FROM 7
     OR (SELECT hashtag.post_count FROM public.hashtags AS hashtag
         WHERE hashtag.tag = 'zero') IS DISTINCT FROM 1
  THEN
    RAISE EXCEPTION 'exact raw recount failed';
  END IF;

  DELETE FROM public.post_hashtags
  WHERE hashtag_id = 'a0000000-0000-0000-0000-000000000004';
  PERFORM public.recount_hashtag_posts(ARRAY[
    'a0000000-0000-0000-0000-000000000004'
  ]::uuid[]);
  IF (SELECT hashtag.post_count FROM public.hashtags AS hashtag
      WHERE hashtag.tag = 'zero') IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'zero-reset recount failed';
  END IF;
END;
$assertions$;

RESET ROLE;

DO $acl_assertions$
BEGIN
  IF pg_catalog.to_regprocedure('public.recount_hashtag_posts(text[])') IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'public.get_trending_hashtags_public(text)'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'public.get_hashtag_posts_page(text,text,bigint,bigint,text)'
     ) IS NOT NULL
  THEN
    RAISE EXCEPTION 'phantom hashtag overload survived convergence';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
      AND (role_row.rolsuper OR role_row.rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'postgres topology no longer proves forced NOBYPASSRLS';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
       'postgres', 'public.hashtags', 'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'postgres', 'public.hashtags', 'UPDATE'
     )
     OR pg_catalog.has_table_privilege(
       'postgres', 'public.hashtags', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'postgres', 'public.hashtags', 'DELETE'
     )
     OR NOT pg_catalog.has_table_privilege(
       'postgres', 'public.post_hashtags', 'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'postgres', 'public.post_hashtags', 'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'postgres', 'public.post_hashtags', 'INSERT'
     )
     OR pg_catalog.has_table_privilege(
       'postgres', 'public.post_hashtags', 'UPDATE'
     )
     OR NOT pg_catalog.has_table_privilege(
       'postgres', 'public.post_likes', 'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'postgres', 'public.post_votes', 'SELECT'
     )
  THEN
    RAISE EXCEPTION 'postgres hashtag ACL is not minimal';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    JOIN pg_catalog.pg_class AS policy_table
      ON policy_table.oid = policy_row.polrelid
    WHERE policy_table.oid IN (
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass
    )
      AND policy_row.polroles NOT IN (
        ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role')]::oid[],
        ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres')]::oid[]
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass
    )
  ) <> 5 THEN
    RAISE EXCEPTION 'hashtag policy inventory drifted';
  END IF;
END;
$acl_assertions$;
SQL

echo "hashtag read authority PG17 proof passed"
