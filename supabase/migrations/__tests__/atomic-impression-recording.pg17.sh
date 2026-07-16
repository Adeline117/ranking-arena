#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for atomic per-user impression recording.
# It owns an isolated temporary cluster and never connects to an application DB.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716112200_atomic_impression_recording.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-impression-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55471
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -180 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
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
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;

CREATE SCHEMA auth;
CREATE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.role', true),
    ''
  )
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;

CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  impression_count integer DEFAULT 0
);

CREATE TABLE public.user_interactions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  action text NOT NULL,
  metadata jsonb,
  created_at timestamptz DEFAULT pg_catalog.now()
);

CREATE TABLE public.authorized_post_actors (
  user_id uuid NOT NULL,
  post_id uuid NOT NULL,
  PRIMARY KEY (user_id, post_id)
);

CREATE FUNCTION public.lock_actor_can_interact_with_post(
  p_post_id uuid,
  p_actor_id uuid
) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.authorized_post_actors AS actor_access
    WHERE actor_access.user_id = p_actor_id
      AND actor_access.post_id = p_post_id
  )
$$;
REVOKE ALL ON FUNCTION public.lock_actor_can_interact_with_post(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Live compatibility signature used by the current /api/track route.
CREATE FUNCTION public.increment_impression_count(post_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.posts
  SET impression_count = COALESCE(impression_count, 0) + 1
  WHERE id = post_id
$$;
REVOKE ALL ON FUNCTION public.increment_impression_count(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_impression_count(uuid)
  TO service_role;

ALTER TABLE public.user_interactions ENABLE ROW LEVEL SECURITY;
GRANT ALL PRIVILEGES ON TABLE public.user_interactions
  TO PUBLIC, anon, authenticated, service_role;
GRANT SELECT (metadata), INSERT (metadata), UPDATE (metadata)
  ON TABLE public.user_interactions
  TO PUBLIC, anon, authenticated, service_role;
CREATE POLICY "Users create interactions"
  ON public.user_interactions FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Users read interactions"
  ON public.user_interactions FOR SELECT TO public USING (true);
CREATE POLICY "Unknown service policy"
  ON public.user_interactions FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- A spoofed name and wrong key must not satisfy the semantic preflight.
CREATE INDEX uniq_user_interactions_impression
  ON public.user_interactions (user_id, target_type, target_id);

CREATE FUNCTION public.record_post_impression(p_post_id text)
RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;

INSERT INTO public.posts(id) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2');
INSERT INTO public.authorized_post_actors(user_id, post_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'),
  -- Deliberately authorize an absent target to prove insert rollback if the
  -- target disappears after authorization.
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3');
SQL

if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/preflight.log" 2>&1; then
  echo "atomic impression migration unexpectedly accepted the wrong index" >&2
  exit 1
fi
if ! grep -q 'requires the valid unique impression key' "$TMP_ROOT/preflight.log"; then
  cat "$TMP_ROOT/preflight.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $rollback_proof$
BEGIN
  IF NOT pg_catalog.has_table_privilege(
    'authenticated',
    'public.user_interactions',
    'INSERT'
  ) OR pg_catalog.to_regprocedure(
    'public.record_post_impression(text)'
  ) IS NULL OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.user_interactions'::regclass
  ) <> 3 THEN
    RAISE EXCEPTION 'preflight failure did not roll back cleanly';
  END IF;
END
$rollback_proof$;

DROP INDEX public.uniq_user_interactions_impression;
CREATE UNIQUE INDEX uniq_user_interactions_impression
  ON public.user_interactions (user_id, target_type, target_id)
  WHERE action = 'impression';
SQL

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
-- Inject every important drift class before replay.
GRANT SELECT ON TABLE public.user_interactions TO authenticated;
GRANT TRUNCATE ON TABLE public.user_interactions TO service_role;
GRANT INSERT (metadata), UPDATE (metadata)
  ON TABLE public.user_interactions TO PUBLIC, authenticated, service_role;
CREATE POLICY "Manual browser drift"
  ON public.user_interactions FOR ALL TO public
  USING (true) WITH CHECK (true);
CREATE FUNCTION public.record_post_impression(p_post_id text)
RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
CREATE FUNCTION public.assert_sqlstate(
  p_sql text,
  p_state text,
  p_label text
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE = p_state THEN
        RETURN;
      END IF;
      RAISE EXCEPTION
        '% raised %, expected %', p_label, SQLSTATE, p_state;
  END;
  RAISE EXCEPTION '% unexpectedly succeeded', p_label;
END
$function$;
GRANT EXECUTE ON FUNCTION public.assert_sqlstate(text, text, text)
  TO anon, authenticated, service_role;

DO $catalog_proof$
DECLARE
  v_role name;
  v_privilege text;
  v_column name;
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'record_post_impression'
      AND function_row.prokind = 'f'
  ) <> 1 OR pg_catalog.to_regprocedure(
    'public.record_post_impression(text)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'legacy impression overload survived replay';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.user_interactions'::regclass
      AND NOT tgisinternal
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.user_interactions'::regclass
      AND tgname = 'trg_record_post_impression_counter'
      AND tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'canonical impression trigger did not converge';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.user_interactions'::regclass
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    JOIN pg_catalog.pg_roles AS role_row
      ON policy.polroles = ARRAY[role_row.oid]::oid[]
    WHERE policy.polrelid = 'public.user_interactions'::regclass
      AND policy.polname = 'Service role manages user interactions'
      AND policy.polcmd = '*'
      AND policy.polpermissive
      AND role_row.rolname = 'service_role'
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
  ) THEN
    RAISE EXCEPTION 'interaction policy contract did not converge';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
  LOOP
    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE',
      'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(
        v_role,
        'public.user_interactions',
        v_privilege
      ) THEN
        RAISE EXCEPTION 'browser table ACL remains: % %', v_role, v_privilege;
      END IF;
    END LOOP;

    FOR v_column IN
      SELECT attname
      FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.user_interactions'::regclass
        AND attnum > 0
        AND NOT attisdropped
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
      ]::text[]
      LOOP
        IF pg_catalog.has_column_privilege(
          v_role,
          'public.user_interactions',
          v_column,
          v_privilege
        ) THEN
          RAISE EXCEPTION
            'browser column ACL remains: % % %',
            v_role,
            v_privilege,
            v_column;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  IF pg_catalog.has_table_privilege(
    'service_role',
    'public.user_interactions',
    'TRUNCATE'
  ) OR pg_catalog.has_column_privilege(
    'service_role',
    'public.user_interactions',
    'metadata',
    'UPDATE'
  ) IS DISTINCT FROM pg_catalog.has_table_privilege(
    'service_role',
    'public.user_interactions',
    'UPDATE'
  ) THEN
    -- has_column_privilege is true through the intended table-level UPDATE;
    -- the migration postflight separately proves no direct column ACL entry.
    RAISE EXCEPTION 'service privilege contract is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = 'public.user_interactions'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee IN (
        0::oid,
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'anon'),
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'),
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role')
      )
  ) THEN
    RAISE EXCEPTION 'direct application-role column ACL survived replay';
  END IF;
END
$catalog_proof$;

SET ROLE authenticated;
SELECT public.assert_sqlstate(
  $$SELECT public.record_post_impression(
    '11111111-1111-1111-1111-111111111111',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    '{}'::jsonb
  )$$,
  '42501',
  'authenticated function execution'
);
SELECT public.assert_sqlstate(
  $$INSERT INTO public.user_interactions(
    user_id, target_type, target_id, action
  ) VALUES (
    '11111111-1111-1111-1111-111111111111',
    'post',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'impression'
  )$$,
  '42501',
  'authenticated direct interaction insert'
);
RESET ROLE;

SET ROLE anon;
SELECT public.assert_sqlstate(
  'SELECT count(*) FROM public.user_interactions',
  '42501',
  'anonymous interaction read'
);
RESET ROLE;

SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT public.assert_sqlstate(
  $$SELECT public.record_post_impression(
    '11111111-1111-1111-1111-111111111111',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    '{}'::jsonb
  )$$,
  '42501',
  'forged database role without service claim'
);

SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.assert_sqlstate(
  $$SELECT public.record_post_impression(
    '11111111-1111-1111-1111-111111111111',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    '[]'::jsonb
  )$$,
  '22023',
  'non-object impression metadata'
);
SELECT public.assert_sqlstate(
  $$SELECT public.record_post_impression(
    '11111111-1111-1111-1111-111111111111',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
    '{}'::jsonb
  )$$,
  '42501',
  'unauthorized impression target'
);
SELECT public.assert_sqlstate(
  $$SELECT public.record_post_impression(
    '11111111-1111-1111-1111-111111111111',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
    '{}'::jsonb
  )$$,
  'P0001',
  'authorized target disappearing before counter update'
);
RESET ROLE;

DO $rollback_gap_proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.user_interactions
    WHERE target_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3'
  ) THEN
    RAISE EXCEPTION 'failed counter update left an interaction dedup gap';
  END IF;
END
$rollback_gap_proof$;

-- Prove the currently deployed route shape: direct service INSERT followed by
-- the legacy RPC. The trigger increments once and the compatibility RPC is a
-- no-op, so no application rollout ordering can double count or undercount.
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
INSERT INTO public.user_interactions(
  user_id,
  target_type,
  target_id,
  action,
  metadata
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  'post',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  'impression',
  '{"source":"legacy-route"}'::jsonb
);
SELECT public.increment_impression_count(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
);
RESET ROLE;

DO $legacy_route_atomicity_proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.user_interactions
    WHERE user_id = '11111111-1111-1111-1111-111111111111'
      AND target_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
      AND action = 'impression'
  ) <> 1 OR (
    SELECT impression_count
    FROM public.posts
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
  ) <> 1 THEN
    RAISE EXCEPTION 'legacy route shape did not atomically count once';
  END IF;
END
$legacy_route_atomicity_proof$;
SQL

# Two first-impression requests race on the same unique key. Exactly one must
# return true and exactly one counter increment must commit.
for attempt in one two; do
  (
    psql_cmd -At <<'SQL' >"$TMP_ROOT/concurrent-$attempt.log"
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.record_post_impression(
  '11111111-1111-1111-1111-111111111111',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
  '{"source":"race"}'::jsonb
);
SQL
  ) &
done
wait

if [[ "$(grep -hE '^(t|f)$' "$TMP_ROOT"/concurrent-*.log | sort | tr '\n' ' ')" != "f t " ]]; then
  echo "concurrent impression calls did not return one false and one true" >&2
  cat "$TMP_ROOT"/concurrent-*.log >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $atomicity_proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.user_interactions
    WHERE user_id = '11111111-1111-1111-1111-111111111111'
      AND target_type = 'post'
      AND target_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'
      AND action = 'impression'
  ) <> 1 OR (
    SELECT impression_count
    FROM public.posts
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'
  ) <> 1 THEN
    RAISE EXCEPTION 'concurrent impression did not commit one fact and one count';
  END IF;
END
$atomicity_proof$;

SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $retry_proof$
DECLARE
  v_recorded boolean;
BEGIN
  SELECT public.record_post_impression(
    '11111111-1111-1111-1111-111111111111',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
    '{"source":"retry"}'::jsonb
  ) INTO v_recorded;
  IF v_recorded THEN
    RAISE EXCEPTION 'deduplicated retry returned true';
  END IF;
END
$retry_proof$;
RESET ROLE;

DO $retry_count_proof$
BEGIN
  IF (
    SELECT impression_count
    FROM public.posts
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'
  ) <> 1 THEN
    RAISE EXCEPTION 'deduplicated retry incremented the post counter';
  END IF;
END
$retry_count_proof$;
SQL

echo "atomic impression recording PG17 proof passed"
