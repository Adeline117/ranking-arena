#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for private post reactions/votes, exact ACL
# convergence, FORCE RLS owner compatibility, and replay repair.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260803183000_post_interaction_read_privacy.sql"
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

TMP_ROOT="$(mktemp -d /tmp/post-interaction-read-privacy-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=$((50000 + $$ % 10000))
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    echo "PostgreSQL 17 post interaction privacy cluster log:" >&2
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if ((exit_status != 0)); then
    for proof_log in "$LOG_DIR"/*.log; do
      [[ -f "$proof_log" ]] || continue
      [[ "$proof_log" == "$LOG_DIR/postgres.log" ]] && continue
      echo "PostgreSQL 17 post interaction privacy command log: $proof_log" >&2
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

role_scalar() {
  local role_name="$1"
  local subject="$2"
  local statement="$3"

  "${PSQL[@]}" -Atq <<SQL | tail -n 1
SET ROLE $role_name;
SELECT pg_catalog.set_config('request.jwt.claim.role', '$role_name', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', '$subject', false);
$statement
SQL
}

assert_role_scalar() {
  local label="$1"
  local role_name="$2"
  local subject="$3"
  local expected="$4"
  local statement="$5"
  local actual

  actual="$(role_scalar "$role_name" "$subject" "$statement")"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

expect_role_sqlstate() {
  local label="$1"
  local role_name="$2"
  local subject="$3"
  local expected_sqlstate="$4"
  local statement="$5"

  if "${PSQL[@]}" >"$LOG_DIR/$label.log" 2>&1 <<SQL
\set VERBOSITY verbose
SET ROLE $role_name;
SELECT pg_catalog.set_config('request.jwt.claim.role', '$role_name', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', '$subject', false);
$statement
SQL
  then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi

  if ! grep -Fq "ERROR:  $expected_sqlstate:" "$LOG_DIR/$label.log"; then
    echo "$label did not fail with SQLSTATE $expected_sqlstate" >&2
    cat "$LOG_DIR/$label.log" >&2
    exit 1
  fi
}

dml_policy_digest() {
  "${PSQL[@]}" -Atqc "
    SELECT pg_catalog.md5(COALESCE(pg_catalog.string_agg(
      policy_table.relname || ':' || policy_row.polname || ':' ||
      policy_row.polcmd::text || ':' || policy_row.polroles::text || ':' ||
      COALESCE(pg_catalog.pg_get_expr(
        policy_row.polqual, policy_row.polrelid
      ), '') || ':' || COALESCE(pg_catalog.pg_get_expr(
        policy_row.polwithcheck, policy_row.polrelid
      ), ''),
      '|' ORDER BY policy_table.relname, policy_row.polname
    ), ''))
    FROM pg_catalog.pg_policy AS policy_row
    JOIN pg_catalog.pg_class AS policy_table
      ON policy_table.oid = policy_row.polrelid
    WHERE policy_table.oid IN (
      'public.post_likes'::pg_catalog.regclass,
      'public.post_votes'::pg_catalog.regclass
    )
      AND policy_row.polcmd IN ('a'::\"char\", 'w'::\"char\", 'd'::\"char\");
  "
}

dml_acl_digest() {
  "${PSQL[@]}" -Atqc "
    SELECT pg_catalog.md5(COALESCE(pg_catalog.string_agg(
      relation.relname || ':' || acl_entry.grantee::text || ':' ||
      acl_entry.grantor::text || ':' || acl_entry.privilege_type || ':' ||
      acl_entry.is_grantable::text,
      '|' ORDER BY relation.relname, acl_entry.grantee,
        acl_entry.privilege_type, acl_entry.grantor
    ), ''))
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid IN (
      'public.post_likes'::pg_catalog.regclass,
      'public.post_votes'::pg_catalog.regclass
    )
      AND acl_entry.privilege_type IN ('INSERT', 'UPDATE', 'DELETE');
  "
}

catalog_digest() {
  "${PSQL[@]}" -Atqc "
    WITH policy_state AS (
      SELECT pg_catalog.string_agg(
        policy_table.relname || ':' || policy_row.polname || ':' ||
        policy_row.polcmd::text || ':' || policy_row.polroles::text || ':' ||
        policy_row.polpermissive::text || ':' ||
        COALESCE(pg_catalog.pg_get_expr(
          policy_row.polqual, policy_row.polrelid
        ), '') || ':' || COALESCE(pg_catalog.pg_get_expr(
          policy_row.polwithcheck, policy_row.polrelid
        ), ''),
        '|' ORDER BY policy_table.relname, policy_row.polname
      ) AS value
      FROM pg_catalog.pg_policy AS policy_row
      JOIN pg_catalog.pg_class AS policy_table
        ON policy_table.oid = policy_row.polrelid
      WHERE policy_table.oid IN (
        'public.post_likes'::pg_catalog.regclass,
        'public.post_votes'::pg_catalog.regclass
      )
    ), relation_state AS (
      SELECT pg_catalog.string_agg(
        relation.relname || ':' || relation.relrowsecurity::text || ':' ||
        relation.relforcerowsecurity::text || ':' ||
        COALESCE(relation.relacl::text, ''),
        '|' ORDER BY relation.relname
      ) AS value
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid IN (
        'public.post_likes'::pg_catalog.regclass,
        'public.post_votes'::pg_catalog.regclass
      )
    ), column_state AS (
      SELECT pg_catalog.string_agg(
        attribute_row.attrelid::pg_catalog.regclass::text || ':' ||
        attribute_row.attnum::text || ':' || COALESCE(attribute_row.attacl::text, ''),
        '|' ORDER BY attribute_row.attrelid, attribute_row.attnum
      ) AS value
      FROM pg_catalog.pg_attribute AS attribute_row
      WHERE attribute_row.attrelid IN (
        'public.post_likes'::pg_catalog.regclass,
        'public.post_votes'::pg_catalog.regclass
      )
        AND attribute_row.attnum > 0
        AND NOT attribute_row.attisdropped
    )
    SELECT pg_catalog.md5(
      COALESCE(policy_state.value, '') || '#' ||
      COALESCE(relation_state.value, '') || '#' ||
      COALESCE(column_state.value, '')
    )
    FROM policy_state, relation_state, column_state;
  "
}

"${PSQL[@]}" <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE hostile_reader NOLOGIN NOSUPERUSER NOBYPASSRLS;

-- Match the managed PostgREST bridge: authenticator may SET the JWT roles but
-- must not inherit their privileges in its login session.
GRANT anon, authenticated, service_role TO authenticator
  WITH INHERIT FALSE, SET TRUE;

CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA public, auth
  TO postgres, anon, authenticated, service_role, authenticator, hostile_reader;

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

GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO PUBLIC;

CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  like_count integer NOT NULL DEFAULT 0,
  dislike_count integer NOT NULL DEFAULT 0,
  poll_bull integer NOT NULL DEFAULT 0,
  poll_bear integer NOT NULL DEFAULT 0,
  poll_wait integer NOT NULL DEFAULT 0
);
ALTER TABLE public.posts OWNER TO postgres;

CREATE TABLE public.post_likes (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  reaction_type text NOT NULL,
  UNIQUE (post_id, user_id)
);
ALTER TABLE public.post_likes OWNER TO postgres;

CREATE TABLE public.post_votes (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  choice text NOT NULL,
  UNIQUE (post_id, user_id)
);
ALTER TABLE public.post_votes OWNER TO postgres;

ALTER TABLE public.post_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_votes ENABLE ROW LEVEL SECURITY;

-- Reproduce the current leak and the canonical pure DML policies that the
-- privacy migration must preserve byte-for-byte in catalog semantics.
CREATE POLICY "Post likes are viewable by everyone"
  ON public.post_likes FOR SELECT TO PUBLIC USING (true);
CREATE POLICY "Users can insert their own likes"
  ON public.post_likes FOR INSERT TO PUBLIC
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can update their own likes"
  ON public.post_likes FOR UPDATE TO PUBLIC
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can delete their own likes"
  ON public.post_likes FOR DELETE TO PUBLIC
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Post votes are viewable by everyone"
  ON public.post_votes FOR SELECT TO PUBLIC USING (true);
CREATE POLICY "Users can insert their own votes"
  ON public.post_votes FOR INSERT TO PUBLIC
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can update their own votes"
  ON public.post_votes FOR UPDATE TO PUBLIC
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can delete their own votes"
  ON public.post_votes FOR DELETE TO PUBLIC
  USING ((SELECT auth.uid()) = user_id);

GRANT SELECT ON public.post_likes, public.post_votes
  TO PUBLIC, anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.post_likes, public.post_votes
  TO authenticated, service_role;
GRANT SELECT (reaction_type) ON public.post_likes TO hostile_reader;
GRANT SELECT (choice) ON public.post_votes TO anon;

CREATE FUNCTION public.refresh_post_interaction_counts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_post_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.post_id ELSE NEW.post_id END;
BEGIN
  UPDATE public.posts AS post
  SET like_count = (
        SELECT pg_catalog.count(*)::integer
        FROM public.post_likes AS reaction
        WHERE reaction.post_id = v_post_id
          AND reaction.reaction_type = 'up'
      ),
      dislike_count = (
        SELECT pg_catalog.count(*)::integer
        FROM public.post_likes AS reaction
        WHERE reaction.post_id = v_post_id
          AND reaction.reaction_type = 'down'
      ),
      poll_bull = (
        SELECT pg_catalog.count(*)::integer
        FROM public.post_votes AS vote
        WHERE vote.post_id = v_post_id
          AND vote.choice = 'bull'
      ),
      poll_bear = (
        SELECT pg_catalog.count(*)::integer
        FROM public.post_votes AS vote
        WHERE vote.post_id = v_post_id
          AND vote.choice = 'bear'
      ),
      poll_wait = (
        SELECT pg_catalog.count(*)::integer
        FROM public.post_votes AS vote
        WHERE vote.post_id = v_post_id
          AND vote.choice = 'wait'
      )
  WHERE post.id = v_post_id;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.refresh_post_interaction_counts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refresh_post_interaction_counts() FROM PUBLIC;

CREATE TRIGGER fixture_post_likes_count
AFTER INSERT OR UPDATE OR DELETE ON public.post_likes
FOR EACH ROW EXECUTE FUNCTION public.refresh_post_interaction_counts();

CREATE TRIGGER fixture_post_votes_count
AFTER INSERT OR UPDATE OR DELETE ON public.post_votes
FOR EACH ROW EXECUTE FUNCTION public.refresh_post_interaction_counts();

CREATE FUNCTION public.owner_interaction_projection(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'likes', (
      SELECT pg_catalog.count(*)
      FROM public.post_likes AS reaction
      WHERE reaction.user_id = p_user_id
    ),
    'votes', (
      SELECT pg_catalog.count(*)
      FROM public.post_votes AS vote
      WHERE vote.user_id = p_user_id
    )
  )
$function$;
ALTER FUNCTION public.owner_interaction_projection(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.owner_interaction_projection(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.owner_interaction_projection(uuid)
  TO service_role;

CREATE FUNCTION public.toggle_post_reaction(
  p_post_id uuid,
  p_user_id uuid,
  p_reaction_type text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_id uuid;
  v_existing text;
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  SELECT reaction.id, reaction.reaction_type
  INTO v_id, v_existing
  FROM public.post_likes AS reaction
  WHERE reaction.post_id = p_post_id
    AND reaction.user_id = p_user_id
  FOR UPDATE;

  IF FOUND AND v_existing = p_reaction_type THEN
    DELETE FROM public.post_likes WHERE id = v_id;
    RETURN 'removed';
  ELSIF v_id IS NULL THEN
    INSERT INTO public.post_likes (id, post_id, user_id, reaction_type)
    VALUES (pg_catalog.gen_random_uuid(), p_post_id, p_user_id, p_reaction_type);
    RETURN 'added';
  ELSE
    UPDATE public.post_likes
    SET reaction_type = p_reaction_type
    WHERE id = v_id;
    RETURN 'changed';
  END IF;
END
$function$;
ALTER FUNCTION public.toggle_post_reaction(uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.toggle_post_reaction(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.toggle_post_reaction(uuid, uuid, text)
  TO service_role;

CREATE FUNCTION public.toggle_post_vote_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_choice text
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_id uuid;
  v_existing text;
BEGIN
  IF (SELECT auth.role()) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  SELECT vote.id, vote.choice
  INTO v_id, v_existing
  FROM public.post_votes AS vote
  WHERE vote.post_id = p_post_id
    AND vote.user_id = p_actor_id
  FOR UPDATE;

  IF FOUND AND v_existing = p_choice THEN
    DELETE FROM public.post_votes WHERE id = v_id;
    RETURN 'removed';
  ELSIF v_id IS NULL THEN
    INSERT INTO public.post_votes (id, post_id, user_id, choice)
    VALUES (pg_catalog.gen_random_uuid(), p_post_id, p_actor_id, p_choice);
    RETURN 'added';
  ELSE
    UPDATE public.post_votes SET choice = p_choice WHERE id = v_id;
    RETURN 'changed';
  END IF;
END
$function$;
ALTER FUNCTION public.toggle_post_vote_atomic(uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.toggle_post_vote_atomic(uuid, uuid, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.toggle_post_vote_atomic(uuid, uuid, text)
  TO service_role;

-- Minimal executable copy of the active hashtag projection dependency. The
-- privacy migration preflights this exact signature/owner because it reads
-- viewer reaction and vote state under FORCE RLS.
CREATE FUNCTION public.get_hashtag_posts_page(
  p_viewer_id uuid,
  p_tag text,
  p_limit integer,
  p_offset integer,
  p_sort_by text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'viewer_id', p_viewer_id,
    'tag', p_tag,
    'limit', p_limit,
    'offset', p_offset,
    'sort_by', p_sort_by,
    'reaction', (
      SELECT reaction.reaction_type
      FROM public.post_likes AS reaction
      WHERE reaction.user_id = p_viewer_id
      ORDER BY reaction.id
      LIMIT 1
    ),
    'vote', (
      SELECT vote.choice
      FROM public.post_votes AS vote
      WHERE vote.user_id = p_viewer_id
      ORDER BY vote.id
      LIMIT 1
    )
  )
$function$;
ALTER FUNCTION public.get_hashtag_posts_page(
  uuid, text, integer, integer, text
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_hashtag_posts_page(
  uuid, text, integer, integer, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_hashtag_posts_page(
  uuid, text, integer, integer, text
) TO service_role;

INSERT INTO public.posts (id)
VALUES ('10000000-0000-4000-8000-000000000001');

INSERT INTO public.post_likes (id, post_id, user_id, reaction_type)
VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'up'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'down'
  );

INSERT INTO public.post_votes (id, post_id, user_id, choice)
VALUES
  (
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bull'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'bear'
  );
SQL

# migration-before-anon-leak: the legacy PUBLIC policies and grants expose all
# identities and choices, not just aggregate counters.
assert_role_scalar \
  migration-before-anon-leak \
  anon \
  '' \
  '2:2' \
  "SELECT (SELECT pg_catalog.count(*) FROM public.post_likes)::text || ':' || (SELECT pg_catalog.count(*) FROM public.post_votes)::text;"

# migration-before-authenticated-leak: viewer A can enumerate viewer B.
assert_role_scalar \
  migration-before-authenticated-leak \
  authenticated \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  '2:2:1' \
  "SELECT (SELECT pg_catalog.count(*) FROM public.post_likes)::text || ':' || (SELECT pg_catalog.count(*) FROM public.post_votes)::text || ':' || (SELECT pg_catalog.count(*) FROM public.post_votes WHERE user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')::text;"

DML_POLICY_BEFORE="$(dml_policy_digest)"
DML_ACL_BEFORE="$(dml_acl_digest)"

# A function-owner drift must abort in preflight, before the migration changes
# the still-leaky table catalog. Restore the reviewed dependency, then install.
"${PSQL[@]}" -c \
  'ALTER FUNCTION public.get_hashtag_posts_page(uuid, text, integer, integer, text) OWNER TO cluster_admin' \
  >/dev/null
if run_migration prerequisite_owner_drift; then
  echo 'migration accepted a drifted interaction dependency owner' >&2
  exit 1
fi
if ! grep -Fq \
  'post interaction owner functions are incompatible' \
  "$LOG_DIR/prerequisite_owner_drift.log"; then
  echo 'owner-drift preflight failed for an unexpected reason' >&2
  cat "$LOG_DIR/prerequisite_owner_drift.log" >&2
  exit 1
fi
"${PSQL[@]}" -c \
  'ALTER FUNCTION public.get_hashtag_posts_page(uuid, text, integer, integer, text) OWNER TO postgres' \
  >/dev/null

run_migration initial

CATALOG_BEFORE_REPLAY="$(catalog_digest)"
run_migration idempotent_replay
CATALOG_AFTER_REPLAY="$(catalog_digest)"
if [[ "$CATALOG_BEFORE_REPLAY" != "$CATALOG_AFTER_REPLAY" ]]; then
  echo 'idempotent replay changed the converged catalog state' >&2
  exit 1
fi

# migration-after-anon-denied: ACL denial, rather than a misleading empty set,
# proves that PostgREST's anon role has no direct table read authority.
expect_role_sqlstate \
  migration-after-anon-denied-likes \
  anon \
  '' \
  42501 \
  'SELECT post_id, user_id, reaction_type FROM public.post_likes;'
expect_role_sqlstate \
  migration-after-anon-denied-votes \
  anon \
  '' \
  42501 \
  'SELECT post_id, user_id, choice FROM public.post_votes;'

assert_role_scalar \
  authenticated-own-only \
  authenticated \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  '1:1:0:0' \
  "SELECT (SELECT pg_catalog.count(*) FROM public.post_likes)::text || ':' || (SELECT pg_catalog.count(*) FROM public.post_votes)::text || ':' || (SELECT pg_catalog.count(*) FROM public.post_likes WHERE user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')::text || ':' || (SELECT pg_catalog.count(*) FROM public.post_votes WHERE user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')::text;"

if [[ "$(role_scalar authenticated aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa "SELECT pg_catalog.count(*) FROM public.post_likes WHERE user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND post_id IN ('10000000-0000-4000-8000-000000000001');")" != '1' ]]; then
  echo 'authenticated own-only read proof failed' >&2
  exit 1
fi

if [[ "$(role_scalar service_role '' "SELECT (SELECT pg_catalog.count(*) FROM public.post_likes)::text || ':' || (SELECT pg_catalog.count(*) FROM public.post_votes)::text;")" != '2:2' ]]; then
  echo 'service_role NOBYPASSRLS full read proof failed' >&2
  exit 1
fi

if [[ "$(role_scalar postgres '' "SELECT (SELECT pg_catalog.count(*) FROM public.post_likes)::text || ':' || (SELECT pg_catalog.count(*) FROM public.post_votes)::text;")" != '2:2' ]]; then
  echo 'postgres NOBYPASSRLS FORCE policy proof failed' >&2
  exit 1
fi

if [[ "$(role_scalar service_role '' "SELECT (public.owner_interaction_projection('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')->>'likes') || ':' || (public.owner_interaction_projection('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')->>'votes');")" != '1:1' ]]; then
  echo 'postgres owner SECURITY DEFINER read proof failed' >&2
  exit 1
fi

if [[ "$(role_scalar service_role '' "SELECT (public.get_hashtag_posts_page('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'btc', 20, 0, 'created_at')->>'reaction') || ':' || (public.get_hashtag_posts_page('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'btc', 20, 0, 'created_at')->>'vote');")" != 'up:bull' ]]; then
  echo 'hashtag projection interaction read proof failed' >&2
  exit 1
fi

# The real interaction shape is service invocation of postgres-owned SECURITY
# DEFINER functions.  Add/change/remove exercises SELECT FOR UPDATE plus all
# three DML commands, while the owner trigger re-reads both forced-RLS tables.
assert_role_scalar owner-reaction-add service_role '' added \
  "SELECT public.toggle_post_reaction('10000000-0000-4000-8000-000000000001', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'up');"
assert_role_scalar owner-reaction-change service_role '' changed \
  "SELECT public.toggle_post_reaction('10000000-0000-4000-8000-000000000001', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'down');"
assert_role_scalar owner-reaction-remove service_role '' removed \
  "SELECT public.toggle_post_reaction('10000000-0000-4000-8000-000000000001', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'down');"

assert_role_scalar owner-vote-add service_role '' added \
  "SELECT public.toggle_post_vote_atomic('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '10000000-0000-4000-8000-000000000001', 'wait');"
assert_role_scalar owner-vote-change service_role '' changed \
  "SELECT public.toggle_post_vote_atomic('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '10000000-0000-4000-8000-000000000001', 'bull');"
assert_role_scalar owner-vote-remove service_role '' removed \
  "SELECT public.toggle_post_vote_atomic('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '10000000-0000-4000-8000-000000000001', 'bull');"

if [[ "$("${PSQL[@]}" -Atqc "SELECT like_count::text || ':' || dislike_count::text || ':' || poll_bull::text || ':' || poll_bear::text || ':' || poll_wait::text FROM public.posts WHERE id = '10000000-0000-4000-8000-000000000001';")" != '1:1:1:1:0' ]]; then
  echo 'postgres owner interaction write proof failed' >&2
  exit 1
fi

# Existing authenticated pure DML policy/grant behavior remains intact.
assert_role_scalar authenticated-own-update authenticated \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa down \
  "UPDATE public.post_likes SET reaction_type = 'down' WHERE user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' RETURNING reaction_type;"
assert_role_scalar authenticated-other-update-filtered authenticated \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa 0 \
  "WITH changed AS (UPDATE public.post_likes SET reaction_type = 'up' WHERE user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' RETURNING 1) SELECT pg_catalog.count(*) FROM changed;"
expect_role_sqlstate \
  authenticated-foreign-insert-denied \
  authenticated \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  42501 \
  "INSERT INTO public.post_likes (id, post_id, user_id, reaction_type) VALUES ('20000000-0000-4000-8000-000000000099', '10000000-0000-4000-8000-000000000001', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'up');"
assert_role_scalar authenticated-own-update-restore authenticated \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa up \
  "UPDATE public.post_likes SET reaction_type = 'up' WHERE user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' RETURNING reaction_type;"

# Parent deletion must still cascade through both forced-RLS child tables.
"${PSQL[@]}" <<'SQL'
SET ROLE postgres;
INSERT INTO public.posts (id)
VALUES ('10000000-0000-4000-8000-000000000099');
INSERT INTO public.post_likes (id, post_id, user_id, reaction_type)
VALUES (
  '20000000-0000-4000-8000-000000000099',
  '10000000-0000-4000-8000-000000000099',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'up'
);
INSERT INTO public.post_votes (id, post_id, user_id, choice)
VALUES (
  '30000000-0000-4000-8000-000000000099',
  '10000000-0000-4000-8000-000000000099',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'wait'
);
DELETE FROM public.posts
WHERE id = '10000000-0000-4000-8000-000000000099';
RESET ROLE;
SQL

if [[ "$("${PSQL[@]}" -Atqc "SELECT (SELECT pg_catalog.count(*) FROM public.post_likes WHERE post_id = '10000000-0000-4000-8000-000000000099')::text || ':' || (SELECT pg_catalog.count(*) FROM public.post_votes WHERE post_id = '10000000-0000-4000-8000-000000000099')::text;")" != '0:0' ]]; then
  echo 'post interaction cascade proof failed' >&2
  exit 1
fi

if [[ "$(dml_policy_digest)" != "$DML_POLICY_BEFORE" ]]; then
  echo 'pure authenticated DML policy contract changed' >&2
  exit 1
fi
if [[ "$(dml_acl_digest)" != "$DML_ACL_BEFORE" ]]; then
  echo 'table DML ACL contract changed' >&2
  exit 1
fi

# Inject both policy classes and both ACL classes after the first convergence.
# The managed authenticator has SET-only memberships in the API roles; a later
# direct grant to that login bridge must still be removed dynamically.
"${PSQL[@]}" <<'SQL'
CREATE POLICY drift_public_select
  ON public.post_likes FOR SELECT TO PUBLIC USING (true);
CREATE POLICY drift_anon_all
  ON public.post_votes FOR ALL TO anon USING (true) WITH CHECK (true);

GRANT SELECT ON public.post_likes TO PUBLIC, authenticator, hostile_reader;
GRANT SELECT ON public.post_votes TO anon;
GRANT SELECT (reaction_type) ON public.post_likes
  TO authenticator, hostile_reader;
GRANT SELECT (choice) ON public.post_votes TO authenticator, hostile_reader;
SQL

assert_role_scalar drift-anon-leak anon '' 2 \
  'SELECT pg_catalog.count(*) FROM public.post_likes;'
assert_role_scalar drift-authenticator-leak authenticator '' 2 \
  'SELECT pg_catalog.count(*) FROM public.post_likes;'

run_migration drift_repair

expect_role_sqlstate drift-repair-anon-denied anon '' 42501 \
  'SELECT * FROM public.post_likes;'
expect_role_sqlstate drift-repair-authenticator-denied authenticator '' 42501 \
  'SELECT * FROM public.post_likes;'
expect_role_sqlstate drift-repair-hostile-denied hostile_reader '' 42501 \
  'SELECT reaction_type FROM public.post_likes;'
expect_role_sqlstate drift-repair-hostile-column-denied hostile_reader '' 42501 \
  'SELECT choice FROM public.post_votes;'

if [[ "$(role_scalar service_role '' "SELECT (SELECT pg_catalog.count(*) FROM public.post_likes)::text || ':' || (SELECT pg_catalog.count(*) FROM public.post_votes)::text;")" != '2:2' ]]; then
  echo 'service read changed after drift repair' >&2
  exit 1
fi

if [[ "$(dml_policy_digest)" != "$DML_POLICY_BEFORE" ]]; then
  echo 'drift repair changed pure authenticated DML policies' >&2
  exit 1
fi
if [[ "$(dml_acl_digest)" != "$DML_ACL_BEFORE" ]]; then
  echo 'drift repair changed table DML ACLs' >&2
  exit 1
fi

"${PSQL[@]}" <<'SQL'
DO $catalog_contract$
DECLARE
  v_authenticated_oid oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'
  );
  v_service_oid oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role'
  );
  v_postgres_oid oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
  );
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname IN ('postgres', 'service_role')
      AND (role_row.rolsuper OR role_row.rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'fixture no longer proves NOBYPASSRLS authorities';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.post_likes'::pg_catalog.regclass,
      'public.post_votes'::pg_catalog.regclass
    )
      AND (
        NOT relation.relrowsecurity
        OR NOT relation.relforcerowsecurity
        OR pg_catalog.pg_get_userbyid(relation.relowner) <> 'postgres'
      )
  ) THEN
    RAISE EXCEPTION 'FORCE RLS or owner contract drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      'public.post_likes'::pg_catalog.regclass,
      'public.post_votes'::pg_catalog.regclass
    )
      AND policy_row.polcmd IN ('r'::"char", '*'::"char")
  ) <> 6 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      'public.post_likes'::pg_catalog.regclass,
      'public.post_votes'::pg_catalog.regclass
    )
      AND policy_row.polcmd IN ('r'::"char", '*'::"char")
      AND (
        NOT policy_row.polpermissive
        OR policy_row.polname NOT IN (
          'post_likes_authenticated_own_read',
          'post_likes_service_read',
          'post_likes_postgres_access',
          'post_votes_authenticated_own_read',
          'post_votes_service_read',
          'post_votes_postgres_access'
        )
        OR policy_row.polroles NOT IN (
          ARRAY[v_authenticated_oid]::oid[],
          ARRAY[v_service_oid]::oid[],
          ARRAY[v_postgres_oid]::oid[]
        )
      )
  ) THEN
    RAISE EXCEPTION 'exact read-capable policy catalog proof failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute_row.attacl) AS acl_entry
    WHERE attribute_row.attrelid IN (
      'public.post_likes'::pg_catalog.regclass,
      'public.post_votes'::pg_catalog.regclass
    )
      AND attribute_row.attnum > 0
      AND NOT attribute_row.attisdropped
      AND acl_entry.privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'direct column SELECT ACL survived convergence';
  END IF;

  IF pg_catalog.has_table_privilege(
       'anon', 'public.post_likes', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'authenticator', 'public.post_likes', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'hostile_reader', 'public.post_likes', 'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'authenticated', 'public.post_likes', 'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'public.post_likes', 'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'postgres', 'public.post_likes', 'SELECT'
     )
  THEN
    RAISE EXCEPTION 'effective table SELECT ACL proof failed';
  END IF;
END
$catalog_contract$;
SQL

echo 'post interaction read privacy PostgreSQL 17 checks passed'
