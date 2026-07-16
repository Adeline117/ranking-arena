#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for pending-report uniqueness, storage ACLs,
# target authorization, and concurrent service submission.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716112300_atomic_content_report_submission.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/content-report-submission-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55472
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
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE legacy_app_role NOLOGIN;

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

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  banned_at timestamptz,
  deleted_at timestamptz
);

CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  author_id uuid NOT NULL
);

CREATE TABLE public.comments (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES public.posts(id),
  user_id uuid NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE public.conversations (
  id uuid PRIMARY KEY,
  user1_id uuid NOT NULL,
  user2_id uuid NOT NULL
);

CREATE TABLE public.content_reports (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  reporter_id uuid NOT NULL,
  content_type text NOT NULL,
  content_id text NOT NULL,
  reason text NOT NULL,
  description text,
  images text[] DEFAULT ARRAY[]::text[],
  status text NOT NULL DEFAULT 'pending',
  resolved_by uuid,
  resolved_at timestamptz,
  action_taken text,
  created_at timestamptz DEFAULT pg_catalog.now(),
  CHECK (content_type IN ('post', 'comment', 'message', 'user')),
  CHECK (reason IN ('spam', 'harassment', 'inappropriate', 'misinformation', 'fraud', 'other')),
  CHECK (status IN ('pending', 'resolved', 'dismissed'))
);

CREATE TABLE public.allowed_post_actors (
  actor_id uuid NOT NULL,
  post_id uuid NOT NULL,
  PRIMARY KEY (actor_id, post_id)
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
    FROM public.allowed_post_actors AS access_row
    WHERE access_row.actor_id = p_actor_id
      AND access_row.post_id = p_post_id
  )
$$;
REVOKE ALL ON FUNCTION public.lock_actor_can_interact_with_post(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.content_reports ENABLE ROW LEVEL SECURITY;
GRANT ALL PRIVILEGES ON TABLE public.content_reports
  TO PUBLIC, anon, authenticated, service_role;
GRANT SELECT (reason), INSERT (description), UPDATE (status)
  ON TABLE public.content_reports
  TO PUBLIC, anon, authenticated, service_role;
CREATE POLICY "Users insert reports"
  ON public.content_reports FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "Users read reports"
  ON public.content_reports FOR SELECT TO public USING (true);
CREATE POLICY "Unknown report mutation"
  ON public.content_reports FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

INSERT INTO public.user_profiles(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444');
INSERT INTO public.user_profiles(id, banned_at) VALUES
  ('55555555-5555-5555-5555-555555555555', pg_catalog.now());
INSERT INTO public.user_profiles(id, deleted_at) VALUES
  ('66666666-6666-6666-6666-666666666666', pg_catalog.now());

INSERT INTO public.posts(id, author_id) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '22222222-2222-2222-2222-222222222222'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '11111111-1111-1111-1111-111111111111'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', '33333333-3333-3333-3333-333333333333'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4', '44444444-4444-4444-4444-444444444444');
INSERT INTO public.allowed_post_actors(actor_id, post_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3'),
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4');

INSERT INTO public.comments(id, post_id, user_id) VALUES
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '33333333-3333-3333-3333-333333333333'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '11111111-1111-1111-1111-111111111111');

INSERT INTO public.conversations(id, user1_id, user2_id) VALUES
  ('cccccccc-cccc-cccc-cccc-ccccccccccc1', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'),
  ('cccccccc-cccc-cccc-cccc-ccccccccccc2', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333');

-- Two pending duplicates prove the migration refuses to delete evidence.
INSERT INTO public.content_reports(
  reporter_id, content_type, content_id, reason, description, images
) VALUES
  ('11111111-1111-1111-1111-111111111111', 'post', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'spam', 'duplicate evidence one', ARRAY['https://evidence.test/one.png']),
  ('11111111-1111-1111-1111-111111111111', 'post', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'spam', 'duplicate evidence two', ARRAY['https://evidence.test/two.png']);
SQL

if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/duplicate-preflight.log" 2>&1; then
  echo "report migration unexpectedly discarded pending duplicates" >&2
  exit 1
fi
if ! grep -q 'duplicate pending reporter/content groups' "$TMP_ROOT/duplicate-preflight.log"; then
  cat "$TMP_ROOT/duplicate-preflight.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $duplicate_rollback_proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.content_reports
  ) <> 2 OR NOT pg_catalog.has_table_privilege(
    'authenticated', 'public.content_reports', 'INSERT'
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.content_reports'::regclass
  ) <> 3 THEN
    RAISE EXCEPTION 'duplicate preflight did not roll back without evidence loss';
  END IF;
END
$duplicate_rollback_proof$;

DELETE FROM public.content_reports;

-- A same-named non-unique key must not spoof the semantic index preflight.
CREATE INDEX uniq_content_reports_pending_reporter_content
  ON public.content_reports (content_id);
SQL

if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/fake-index.log" 2>&1; then
  echo "report migration unexpectedly accepted a fake pending index" >&2
  exit 1
fi
if ! grep -q 'has an incompatible definition' "$TMP_ROOT/fake-index.log"; then
  cat "$TMP_ROOT/fake-index.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $fake_index_rollback_proof$
BEGIN
  IF NOT pg_catalog.has_table_privilege(
    'authenticated', 'public.content_reports', 'INSERT'
  ) OR pg_catalog.to_regprocedure(
    'public.submit_content_report(uuid,text,uuid,text,text,text[])'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'fake-index preflight changed authority';
  END IF;
END
$fake_index_rollback_proof$;
DROP INDEX public.uniq_content_reports_pending_reporter_content;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
-- Inject table, column, policy, and overload drift before replay.
GRANT SELECT ON TABLE public.content_reports TO authenticated;
GRANT TRUNCATE ON TABLE public.content_reports TO service_role;
GRANT UPDATE ON TABLE public.content_reports TO legacy_app_role;
GRANT INSERT (description), UPDATE (status)
  ON TABLE public.content_reports TO PUBLIC, authenticated, service_role;
GRANT SELECT (reason), UPDATE (action_taken)
  ON TABLE public.content_reports TO legacy_app_role;
CREATE POLICY "Manual report browser drift"
  ON public.content_reports FOR ALL TO public
  USING (true) WITH CHECK (true);
CREATE FUNCTION public.submit_content_report(p_reporter_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
AS $$ SELECT '{}'::jsonb $$;
GRANT EXECUTE ON FUNCTION public.submit_content_report(uuid)
  TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_content_report(
  uuid, text, uuid, text, text, text[]
) TO legacy_app_role;
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
      RAISE EXCEPTION '% raised %, expected %', p_label, SQLSTATE, p_state;
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
  IF pg_catalog.to_regprocedure(
    'public.submit_content_report(uuid)'
  ) IS NOT NULL OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'submit_content_report'
      AND function_row.prokind = 'f'
  ) <> 1 THEN
    RAISE EXCEPTION 'report RPC overload drift survived replay';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.content_reports'::regclass
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    JOIN pg_catalog.pg_roles AS role_row
      ON policy.polroles = ARRAY[role_row.oid]::oid[]
    WHERE policy.polrelid = 'public.content_reports'::regclass
      AND policy.polname = 'Service role manages content reports'
      AND policy.polcmd = '*'
      AND policy.polpermissive
      AND role_row.rolname = 'service_role'
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
  ) THEN
    RAISE EXCEPTION 'report policy contract did not converge';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
  LOOP
    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE',
      'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(
        v_role, 'public.content_reports', v_privilege
      ) THEN
        RAISE EXCEPTION 'browser report table ACL remains: % %', v_role, v_privilege;
      END IF;
    END LOOP;

    FOR v_column IN
      SELECT attname
      FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.content_reports'::regclass
        AND attnum > 0
        AND NOT attisdropped
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
      ]::text[]
      LOOP
        IF pg_catalog.has_column_privilege(
          v_role,
          'public.content_reports',
          v_column,
          v_privilege
        ) THEN
          RAISE EXCEPTION
            'browser report column ACL remains: % % %',
            v_role,
            v_privilege,
            v_column;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  IF pg_catalog.has_table_privilege(
    'service_role', 'public.content_reports', 'TRUNCATE'
  ) OR pg_catalog.has_table_privilege(
    'legacy_app_role',
    'public.content_reports',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.has_any_column_privilege(
    'legacy_app_role',
    'public.content_reports',
    'SELECT,INSERT,UPDATE,REFERENCES'
  ) OR pg_catalog.has_function_privilege(
    'legacy_app_role',
    'public.submit_content_report(uuid,text,uuid,text,text,text[])',
    'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = 'public.content_reports'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee IN (
        0::oid,
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'anon'),
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'),
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role')
      )
  ) THEN
    RAISE EXCEPTION 'report direct column or excess service ACL survived replay';
  END IF;
END
$catalog_proof$;

SET ROLE authenticated;
SELECT public.assert_sqlstate(
  $$SELECT public.submit_content_report(
    '11111111-1111-1111-1111-111111111111',
    'post',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'spam',
    'enough report detail',
    ARRAY['https://evidence.test/post.png']
  )$$,
  '42501',
  'authenticated report RPC call'
);
SELECT public.assert_sqlstate(
  $$INSERT INTO public.content_reports(
    reporter_id, content_type, content_id, reason
  ) VALUES (
    '11111111-1111-1111-1111-111111111111',
    'post',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'spam'
  )$$,
  '42501',
  'authenticated direct report insert'
);
RESET ROLE;

SET ROLE anon;
SELECT public.assert_sqlstate(
  'SELECT count(*) FROM public.content_reports',
  '42501',
  'anonymous report read'
);
RESET ROLE;

SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT public.assert_sqlstate(
  $$SELECT public.submit_content_report(
    '11111111-1111-1111-1111-111111111111',
    'post',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'spam',
    'enough report detail',
    ARRAY['https://evidence.test/post.png']
  )$$,
  '42501',
  'service database role without service JWT claim'
);

SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.assert_sqlstate(
  $$SELECT public.submit_content_report(
    '55555555-5555-5555-5555-555555555555',
    'post',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'spam',
    'enough report detail',
    ARRAY['https://evidence.test/post.png']
  )$$,
  '42501',
  'banned reporter'
);
SELECT public.assert_sqlstate(
  $$SELECT public.submit_content_report(
    '11111111-1111-1111-1111-111111111111',
    'post',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'spam',
    'too short',
    ARRAY['https://evidence.test/post.png']
  )$$,
  '22023',
  'short report detail'
);
SELECT public.assert_sqlstate(
  $$SELECT public.submit_content_report(
    '11111111-1111-1111-1111-111111111111',
    'post',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'spam',
    'enough report detail',
    ARRAY['data:image/png;base64,AAAA']
  )$$,
  '22023',
  'inline database evidence payload'
);
SELECT public.assert_sqlstate(
  $$SELECT public.submit_content_report(
    '11111111-1111-1111-1111-111111111111',
    'post',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
    'spam',
    'cannot report own post',
    ARRAY['https://evidence.test/own.png']
  )$$,
  '42501',
  'own post report'
);
SELECT public.assert_sqlstate(
  $$SELECT public.submit_content_report(
    '11111111-1111-1111-1111-111111111111',
    'comment',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2',
    'harassment',
    'cannot report own comment',
    ARRAY['https://evidence.test/own-comment.png']
  )$$,
  '42501',
  'own comment report'
);
SELECT public.assert_sqlstate(
  $$SELECT public.submit_content_report(
    '11111111-1111-1111-1111-111111111111',
    'user',
    '11111111-1111-1111-1111-111111111111',
    'harassment',
    'cannot report own profile',
    ARRAY['https://evidence.test/own-user.png']
  )$$,
  '22023',
  'own profile report'
);
SELECT public.assert_sqlstate(
  $$SELECT public.submit_content_report(
    '11111111-1111-1111-1111-111111111111',
    'message',
    'cccccccc-cccc-cccc-cccc-ccccccccccc2',
    'harassment',
    'conversation is inaccessible',
    ARRAY['https://evidence.test/conversation.png']
  )$$,
  '42501',
  'nonparticipant conversation report'
);
RESET ROLE;
SQL

# Canonical service submissions, duplicate behavior, and resolved-then-report
# behavior execute in a single session so the JWT role claim is explicit.
psql_cmd <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

DO $canonical_submission_proof$
DECLARE
  v_first jsonb;
  v_duplicate jsonb;
  v_second_pending jsonb;
  v_comment jsonb;
  v_user jsonb;
  v_message jsonb;
BEGIN
  v_first := public.submit_content_report(
    '11111111-1111-1111-1111-111111111111',
    'post',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'spam',
    'first canonical post report',
    ARRAY['https://evidence.test/post-first.png']
  );
  v_duplicate := public.submit_content_report(
    '11111111-1111-1111-1111-111111111111',
    'post',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'fraud',
    'duplicate canonical report',
    ARRAY['https://evidence.test/post-duplicate.png']
  );

  IF v_first ->> 'created' <> 'true'
     OR v_duplicate ->> 'created' <> 'false'
     OR v_duplicate ->> 'reason' <> 'DUPLICATE_PENDING'
     OR v_duplicate ->> 'report_id' <> v_first ->> 'report_id'
  THEN
    RAISE EXCEPTION 'stable duplicate result failed: % / %', v_first, v_duplicate;
  END IF;

  UPDATE public.content_reports
  SET status = 'resolved', resolved_at = pg_catalog.now()
  WHERE id = (v_first ->> 'report_id')::uuid;

  v_second_pending := public.submit_content_report(
    '11111111-1111-1111-1111-111111111111',
    'post',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    'harassment',
    'new abuse after prior resolution',
    ARRAY['https://evidence.test/post-second.png']
  );

  v_comment := public.submit_content_report(
    '11111111-1111-1111-1111-111111111111',
    'comment',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
    'harassment',
    'canonical visible comment report',
    ARRAY['https://evidence.test/comment.png']
  );
  v_user := public.submit_content_report(
    '11111111-1111-1111-1111-111111111111',
    'user',
    '22222222-2222-2222-2222-222222222222',
    'fraud',
    'canonical visible user report',
    ARRAY['https://evidence.test/user.png']
  );
  v_message := public.submit_content_report(
    '11111111-1111-1111-1111-111111111111',
    'message',
    'cccccccc-cccc-cccc-cccc-ccccccccccc1',
    'harassment',
    'canonical conversation report',
    ARRAY['https://evidence.test/message.png']
  );

  IF v_second_pending ->> 'created' <> 'true'
     OR v_comment ->> 'created' <> 'true'
     OR v_user ->> 'created' <> 'true'
     OR v_message ->> 'created' <> 'true'
  THEN
    RAISE EXCEPTION
      'canonical target submission failed: % % % %',
      v_second_pending,
      v_comment,
      v_user,
      v_message;
  END IF;
END
$canonical_submission_proof$;
RESET ROLE;

DO $partial_unique_proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.content_reports
    WHERE reporter_id = '11111111-1111-1111-1111-111111111111'
      AND content_type = 'post'
      AND content_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
  ) <> 2 OR (
    SELECT pg_catalog.count(*)
    FROM public.content_reports
    WHERE reporter_id = '11111111-1111-1111-1111-111111111111'
      AND content_type = 'post'
      AND content_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
      AND status = 'pending'
  ) <> 1 THEN
    RAISE EXCEPTION 'pending-only uniqueness contract failed';
  END IF;
END
$partial_unique_proof$;
SQL

# Two concurrent canonical requests for a fresh target serialize on the
# per-reporter advisory lock. Exactly one creates and one reports duplicate.
for attempt in one two; do
  (
    psql_cmd -At <<'SQL' >"$TMP_ROOT/concurrent-$attempt.log"
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.submit_content_report(
  '11111111-1111-1111-1111-111111111111',
  'post',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
  'misinformation',
  'concurrent canonical report detail',
  ARRAY['https://evidence.test/concurrent.png']
) ->> 'created';
SQL
  ) &
done
wait

if [[ "$(grep -hE '^(true|false)$' "$TMP_ROOT"/concurrent-*.log | sort | tr '\n' ' ')" != "false true " ]]; then
  echo "concurrent report RPCs did not produce one create and one duplicate" >&2
  cat "$TMP_ROOT"/concurrent-*.log >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $concurrent_count_proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.content_reports
    WHERE reporter_id = '11111111-1111-1111-1111-111111111111'
      AND content_type = 'post'
      AND content_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3'
      AND status = 'pending'
  ) <> 1 THEN
    RAISE EXCEPTION 'concurrent RPC created duplicate pending reports';
  END IF;
END
$concurrent_count_proof$;
SQL

# Force a legacy direct insert into the narrow window after the RPC duplicate
# check but before its INSERT. The unique_violation handler must return the
# direct row as DUPLICATE_PENDING rather than fail the request.
psql_cmd <<'SQL'
CREATE FUNCTION public.pause_canonical_report_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF pg_catalog.current_setting('application_name', true) = 'rpc-race' THEN
    PERFORM pg_catalog.pg_sleep(1);
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER pause_canonical_report_insert
BEFORE INSERT ON public.content_reports
FOR EACH ROW EXECUTE FUNCTION public.pause_canonical_report_insert();
SQL

(
  psql_cmd -At <<'SQL' >"$TMP_ROOT/legacy-race-rpc.log"
SET application_name = 'rpc-race';
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.submit_content_report(
  '11111111-1111-1111-1111-111111111111',
  'post',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4',
  'spam',
  'canonical side of legacy race',
  ARRAY['https://evidence.test/rpc-race.png']
) ->> 'created';
SQL
) &
rpc_pid=$!

sleep 0.25
psql_cmd <<'SQL'
SET ROLE service_role;
INSERT INTO public.content_reports(
  reporter_id,
  content_type,
  content_id,
  reason,
  description,
  images,
  status
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  'post',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4',
  'spam',
  'legacy direct insert wins race',
  ARRAY['https://evidence.test/legacy-race.png'],
  'pending'
);
RESET ROLE;
SQL
wait "$rpc_pid"

if [[ "$(grep -E '^(true|false)$' "$TMP_ROOT/legacy-race-rpc.log" | tail -1)" != "false" ]]; then
  echo "RPC did not convert legacy unique race into a duplicate result" >&2
  cat "$TMP_ROOT/legacy-race-rpc.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
DROP TRIGGER pause_canonical_report_insert ON public.content_reports;
DROP FUNCTION public.pause_canonical_report_insert();

DO $legacy_race_count_proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.content_reports
    WHERE reporter_id = '11111111-1111-1111-1111-111111111111'
      AND content_type = 'post'
      AND content_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4'
      AND status = 'pending'
  ) <> 1 THEN
    RAISE EXCEPTION 'legacy/RPC race left duplicate pending reports';
  END IF;
END
$legacy_race_count_proof$;
SQL

echo "atomic content report submission PG17 proof passed"
