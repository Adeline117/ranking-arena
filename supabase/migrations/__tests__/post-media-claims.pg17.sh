#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# post-media-upload-registry.sql is the required 1100 substrate.
REGISTRY_MIGRATION="$ROOT_DIR/supabase/migrations/20260803110000_post_media_upload_registry.sql"
CLAIM_MIGRATION="$ROOT_DIR/supabase/migrations/20260803111000_post_media_claims.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/post-media-claims-pg17.XXXXXX)"
PGDATA="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT="$((57900 + ($$ % 300)))"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if [[ -s "$PGDATA/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$PGDATA" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo 'This integration proof requires PostgreSQL 17' >&2
  exit 1
fi

mkdir -p "$SOCKET_DIR" "$LOG_DIR"
"$PG_BIN/initdb" -D "$PGDATA" --auth=trust --username=postgres \
  --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$PGDATA" -l "$LOG_DIR/postgres.log" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -q \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

assert_scalar() {
  local expected="$1"
  local query="$2"
  local actual
  actual="$(psql_cmd -At -c "$query")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Expected '$expected', got '$actual' for: $query" >&2
    return 1
  fi
}

assert_service() {
  local expected="$1"
  local query="$2"
  assert_scalar "$expected" \
    "SET ROLE service_role;
     SET request.jwt.claim.role = 'service_role';
     $query"
}

expect_failure_matching() {
  local label="$1"
  local pattern="$2"
  local sql="$3"
  local failure_log="$LOG_DIR/$label.log"
  if psql_cmd -v VERBOSITY=verbose -c "$sql" >"$failure_log" 2>&1; then
    echo "Expected failure: $label" >&2
    return 1
  fi
  if ! rg -q "$pattern" "$failure_log"; then
    echo "Failure did not match '$pattern': $label" >&2
    cat "$failure_log" >&2
    return 1
  fi
}

expect_migration_failure_matching() {
  local label="$1"
  local pattern="$2"
  local failure_log="$LOG_DIR/$label.log"
  if psql_cmd -v VERBOSITY=verbose -f "$CLAIM_MIGRATION" \
      >"$failure_log" 2>&1; then
    echo "Expected migration failure: $label" >&2
    return 1
  fi
  if ! rg -q "$pattern" "$failure_log"; then
    echo "Migration failure did not match '$pattern': $label" >&2
    cat "$failure_log" >&2
    return 1
  fi
}

service_sql() {
  psql_cmd -At -c \
    "SET ROLE service_role;
     SET request.jwt.claim.role = 'service_role';
     $1"
}

psql_cmd <<'SQL'
CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE authenticator NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
CREATE ROLE hostile_claim_reader NOLOGIN NOINHERIT;
GRANT service_role TO authenticator WITH INHERIT FALSE, SET TRUE;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;

CREATE SCHEMA storage AUTHORIZATION postgres;
CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  bucket_id text,
  name text,
  UNIQUE (bucket_id, name)
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
INSERT INTO storage.buckets (id, name) VALUES ('posts', 'posts');

INSERT INTO auth.users (id) VALUES
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000099');
SQL

psql_cmd -f "$REGISTRY_MIGRATION"

# Minimal deterministic old authorities. The claim migration composes these
# exact signatures; each ledger makes replay and rollback observable.
psql_cmd <<'SQL'
CREATE TABLE public.posts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  author_id uuid NOT NULL,
  title text,
  content text,
  images text[],
  content_version bigint NOT NULL DEFAULT 0
);
CREATE TABLE public.group_applications (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  applicant_id uuid NOT NULL,
  name text NOT NULL,
  avatar_url text,
  status text NOT NULL DEFAULT 'pending',
  group_id uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp()
);
CREATE TABLE public.groups (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  created_by uuid NOT NULL,
  name text NOT NULL,
  avatar_url text
);
CREATE TABLE public.stub_create_ledger (
  operation_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  images text[] NOT NULL,
  result jsonb NOT NULL
);
CREATE TABLE public.stub_group_ledger (
  operation_id uuid PRIMARY KEY,
  kind text NOT NULL,
  actor_id uuid NOT NULL,
  subject_id uuid,
  decision text,
  result jsonb NOT NULL
);

CREATE FUNCTION public.create_post_atomic(
  p_actor_id uuid, p_operation_id uuid, p_title text, p_content text,
  p_group_id uuid, p_images text[], p_poll_enabled boolean,
  p_poll_option_texts text[], p_poll_type text, p_poll_duration_hours integer,
  p_visibility text, p_is_sensitive boolean, p_content_warning text,
  p_language text, p_mention_handles text[], p_hashtag_tags text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_existing public.stub_create_ledger%ROWTYPE;
  v_post public.posts%ROWTYPE;
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stub-create:' || p_operation_id::text, 0)
  );
  SELECT * INTO v_existing FROM public.stub_create_ledger
  WHERE operation_id = p_operation_id;
  IF FOUND THEN
    IF v_existing.actor_id = p_actor_id
       AND v_existing.title = p_title
       AND v_existing.content = p_content
       AND v_existing.images = p_images
    THEN
      RETURN pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(v_existing.result, '{status}', '"replayed"'),
        '{applied}', 'false'
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'operation_conflict');
  END IF;
  INSERT INTO public.posts(author_id, title, content, images)
  VALUES (p_actor_id, p_title, p_content, p_images)
  RETURNING * INTO v_post;
  v_result := pg_catalog.jsonb_build_object(
    'status', 'created', 'applied', true,
    'post', pg_catalog.jsonb_build_object(
      'id', v_post.id, 'author_id', v_post.author_id,
      'content_version', v_post.content_version, 'images', v_post.images
    )
  );
  INSERT INTO public.stub_create_ledger
  VALUES (p_operation_id, p_actor_id, p_title, p_content, p_images, v_result);
  IF p_title LIKE 'migration lock %' THEN
    PERFORM pg_catalog.pg_sleep(1);
  ELSIF p_title LIKE 'contended %' THEN
    PERFORM pg_catalog.pg_sleep(0.25);
  END IF;
  RETURN v_result;
END
$function$;

CREATE FUNCTION public.edit_post_atomic(
  p_actor_id uuid, p_post_id uuid, p_expected_version bigint, p_title text,
  p_content text, p_update_images boolean, p_images text[], p_language text,
  p_mention_handles text[], p_hashtag_tags text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_post public.posts%ROWTYPE;
  v_status text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;
  SELECT * INTO v_post FROM public.posts
  WHERE id = p_post_id FOR UPDATE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status', 'not_found'); END IF;
  IF v_post.author_id <> p_actor_id THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;
  IF p_title = 'bad revision ack' THEN
    UPDATE public.posts
    SET title = p_title, content = p_content
    WHERE id = p_post_id RETURNING * INTO v_post;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'updated', 'actor_id', p_actor_id,
      'revision_advanced', true,
      'post', pg_catalog.jsonb_build_object(
        'id', v_post.id, 'author_id', v_post.author_id,
        'content_version', v_post.content_version, 'images', v_post.images
      )
    );
  END IF;
  IF v_post.title = p_title AND v_post.content = p_content
     AND (NOT p_update_images OR v_post.images = p_images)
  THEN
    v_status := 'unchanged';
  ELSE
    IF v_post.content_version <> p_expected_version THEN
      RETURN pg_catalog.jsonb_build_object('status', 'conflict');
    END IF;
    UPDATE public.posts
    SET title = p_title, content = p_content,
        images = CASE WHEN p_update_images THEN p_images ELSE images END,
        content_version = content_version + 1
    WHERE id = p_post_id RETURNING * INTO v_post;
    v_status := 'updated';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'status', v_status, 'actor_id', p_actor_id,
    'revision_advanced', v_status = 'updated',
    'post', pg_catalog.jsonb_build_object(
      'id', v_post.id, 'author_id', v_post.author_id,
      'content_version', v_post.content_version, 'images', v_post.images
    )
  );
END
$function$;

-- The known seven-argument rolling overload remains legal until its later
-- postdeploy closure. It is attested but never composed by 1110.
CREATE FUNCTION public.edit_post_atomic(
  p_actor_id uuid, p_post_id uuid, p_expected_version bigint, p_title text,
  p_content text, p_update_images boolean, p_images text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
BEGIN
  RETURN public.edit_post_atomic(
    p_actor_id, p_post_id, p_expected_version, p_title, p_content,
    p_update_images, p_images, NULL, NULL, NULL
  );
END
$function$;

CREATE FUNCTION public.submit_group_application_atomic(
  p_actor_id uuid, p_name text, p_name_en text DEFAULT NULL,
  p_description text DEFAULT NULL, p_description_en text DEFAULT NULL,
  p_avatar_url text DEFAULT NULL, p_role_names jsonb DEFAULT NULL,
  p_rules_json jsonb DEFAULT NULL, p_rules text DEFAULT NULL,
  p_is_premium_only boolean DEFAULT false,
  p_promo_unlocked boolean DEFAULT false, p_operation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_existing public.stub_group_ledger%ROWTYPE;
  v_application_id uuid;
  v_created_at timestamptz;
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stub-group:' || p_operation_id::text, 0)
  );
  SELECT * INTO v_existing FROM public.stub_group_ledger
  WHERE operation_id = p_operation_id;
  IF FOUND THEN
    IF v_existing.kind = 'submit' AND v_existing.actor_id = p_actor_id THEN
      RETURN v_existing.result || pg_catalog.jsonb_build_object('applied', false);
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'operation_conflict');
  END IF;
  INSERT INTO public.group_applications(applicant_id, name, avatar_url)
  VALUES (p_actor_id, p_name, p_avatar_url)
  RETURNING id, created_at INTO v_application_id, v_created_at;
  v_result := pg_catalog.jsonb_build_object(
    'status', 'submitted', 'application_id', v_application_id,
    'created_at', v_created_at, 'operation_id', p_operation_id
  );
  INSERT INTO public.stub_group_ledger
  VALUES (p_operation_id, 'submit', p_actor_id, v_application_id, NULL, v_result);
  RETURN v_result || pg_catalog.jsonb_build_object('applied', true);
END
$function$;

CREATE FUNCTION public.review_group_application_atomic(
  p_reviewer_id uuid, p_application_id uuid, p_decision text,
  p_reject_reason text DEFAULT NULL, p_promo_unlocked boolean DEFAULT false,
  p_operation_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_application public.group_applications%ROWTYPE;
  v_existing public.stub_group_ledger%ROWTYPE;
  v_group_id uuid;
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stub-group:' || p_operation_id::text, 0)
  );
  SELECT * INTO v_existing FROM public.stub_group_ledger
  WHERE operation_id = p_operation_id;
  IF FOUND THEN
    IF v_existing.kind = 'review' AND v_existing.actor_id = p_reviewer_id
       AND v_existing.subject_id = p_application_id
       AND v_existing.decision = p_decision
    THEN
      RETURN v_existing.result || pg_catalog.jsonb_build_object('applied', false);
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'operation_conflict');
  END IF;
  SELECT * INTO v_application FROM public.group_applications
  WHERE id = p_application_id FOR UPDATE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status', 'not_found'); END IF;
  IF v_application.status <> 'pending' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_processed');
  END IF;
  IF p_decision = 'approve' THEN
    INSERT INTO public.groups(created_by, name, avatar_url)
    VALUES (v_application.applicant_id, v_application.name, v_application.avatar_url)
    RETURNING id INTO v_group_id;
    UPDATE public.group_applications SET status = 'approved', group_id = v_group_id
    WHERE id = p_application_id;
    v_result := pg_catalog.jsonb_build_object(
      'status', 'approved', 'application_id', p_application_id,
      'group_id', v_group_id, 'operation_id', p_operation_id,
      'applicant_id', v_application.applicant_id,
      'group_name', v_application.name
    );
  ELSIF p_decision = 'reject' THEN
    UPDATE public.group_applications SET status = 'rejected'
    WHERE id = p_application_id;
    v_result := pg_catalog.jsonb_build_object(
      'status', 'rejected', 'application_id', p_application_id,
      'operation_id', p_operation_id,
      'applicant_id', v_application.applicant_id,
      'group_name', v_application.name, 'reject_reason', p_reject_reason
    );
  ELSE
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  INSERT INTO public.stub_group_ledger
  VALUES (
    p_operation_id, 'review', p_reviewer_id, p_application_id,
    p_decision, v_result
  );
  RETURN v_result || pg_catalog.jsonb_build_object('applied', true);
END
$function$;

DO $seal_stub_authorities$
DECLARE
  v_expected record;
  v_function regprocedure;
  v_source text;
BEGIN
  FOR v_expected IN
    SELECT * FROM (VALUES
      ('public.create_post_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[])', 'atomic-post-create:v1:'),
      ('public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[],text,text[],text[])', 'atomic-post-edit-facets:v2:'),
      ('public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[])', 'atomic-post-edit:v1:'),
      ('public.submit_group_application_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean,uuid)', 'group-application-operation-replay:submit:v1:'),
      ('public.review_group_application_atomic(uuid,uuid,text,text,boolean,uuid)', 'group-application-operation-replay:review:v1:')
    ) AS expected(signature, prefix)
  LOOP
    v_function := v_expected.signature::regprocedure;
    SELECT prosrc INTO STRICT v_source FROM pg_catalog.pg_proc
    WHERE oid = v_function;
    EXECUTE pg_catalog.format(
      'COMMENT ON FUNCTION %s IS %L', v_function,
      v_expected.prefix || pg_catalog.md5(v_source)
    );
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_function
    );
  END LOOP;
END
$seal_stub_authorities$;

GRANT EXECUTE ON FUNCTION public.create_post_atomic(
  uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[]
) TO service_role;
GRANT EXECUTE ON FUNCTION public.edit_post_atomic(
  uuid,uuid,bigint,text,text,boolean,text[],text,text[],text[]
) TO service_role;
GRANT EXECUTE ON FUNCTION public.edit_post_atomic(
  uuid,uuid,bigint,text,text,boolean,text[]
) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_group_application_atomic(
  uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean,uuid
) TO service_role;
GRANT EXECUTE ON FUNCTION public.review_group_application_atomic(
  uuid,uuid,text,text,boolean,uuid
) TO service_role;
SQL

# A partial pre-publication is never overwritten. First installation is legal
# only when all five names are absent.
psql_cmd -c "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO hostile_claim_reader"
psql_cmd <<'SQL'
CREATE FUNCTION public.claim_post_media_manifest_internal(
  p_scope text, p_operation_id uuid, p_actor_id uuid, p_media_owner_id uuid,
  p_target_kind text, p_target_id uuid, p_source_application_id uuid,
  p_requested_revision bigint, p_target_revision bigint,
  p_storage_origin text, p_media_object_names text[],
  p_intent_fingerprint text, p_result jsonb
)
RETURNS jsonb LANGUAGE plpgsql
AS $function$
BEGIN
  -- hostile partial publication marker
  RETURN p_result;
END
$function$;
SQL
expect_migration_failure_matching partial_publication 'post media claim publication is partial or unsafe'
assert_scalar 'true|true' \
  "SELECT (pg_catalog.to_regclass('public.post_media_claim_sets') IS NULL)::text || '|' ||
          (pg_catalog.strpos(prosrc, 'hostile partial publication marker') > 0)::text
   FROM pg_catalog.pg_proc
   WHERE oid='public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb)'::regprocedure"
psql_cmd -c "DROP FUNCTION public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb)"

psql_cmd -f "$CLAIM_MIGRATION"
psql_cmd -c "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE SELECT ON TABLES FROM hostile_claim_reader"
assert_scalar '0|0' \
  "SELECT
    (SELECT count(*) FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl WHERE c.oid='public.post_media_claim_sets'::regclass AND acl.grantee<>c.relowner) || '|' ||
    (SELECT count(*) FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl WHERE c.oid='public.post_media_claims'::regclass AND acl.grantee<>c.relowner)"

OWNER='10000000-0000-4000-8000-000000000001'
REVIEWER='10000000-0000-4000-8000-000000000099'
STORAGE_ORIGIN='https://example.test'
IMAGE_ID='20000000-0000-4000-8000-000000000001'
IMAGE_NAME="$OWNER/30000000-0000-4000-8000-000000000001.jpg"
IMAGE_URL="https://example.test/storage/v1/object/public/posts/$IMAGE_NAME"
SECOND_ID='20000000-0000-4000-8000-000000000002'
SECOND_NAME="$OWNER/30000000-0000-4000-8000-000000000002.png"
SECOND_URL="https://example.test/storage/v1/object/public/posts/$SECOND_NAME"
AVATAR_ID='20000000-0000-4000-8000-000000000003'
AVATAR_NAME="$OWNER/30000000-0000-4000-8000-000000000003.webp"
AVATAR_URL="https://example.test/storage/v1/object/public/posts/$AVATAR_NAME"
VIDEO_ID='20000000-0000-4000-8000-000000000004'
VIDEO_NAME="$OWNER/videos/30000000-0000-4000-8000-000000000004.mp4"
VIDEO_URL="https://example.test/storage/v1/object/public/posts/$VIDEO_NAME"
LEGACY_AVATAR_ID='20000000-0000-4000-8000-000000000005'
LEGACY_AVATAR_NAME="$OWNER/30000000-0000-4000-8000-000000000005.webp"
LEGACY_AVATAR_URL="https://example.test/storage/v1/object/public/posts/$LEGACY_AVATAR_NAME"

reserve_and_finalize() {
  local upload_id="$1"
  local object_name="$2"
  local purpose="$3"
  local mime="$4"
  local size="$5"
  service_sql "SELECT public.reserve_post_media_upload_atomic(
    '$upload_id', '$OWNER', '$object_name', '$purpose', '$mime', $size
  );" >/dev/null
  psql_cmd -c \
    "INSERT INTO storage.objects(bucket_id, name) VALUES ('posts', '$object_name')"
  service_sql "SELECT public.finalize_post_media_upload_atomic(
    '$upload_id', '$OWNER', '$object_name', '$purpose', '$mime', $size
  );" >/dev/null
}

reserve_and_finalize "$IMAGE_ID" "$IMAGE_NAME" post_image image/jpeg 128
reserve_and_finalize "$SECOND_ID" "$SECOND_NAME" post_image image/png 256
reserve_and_finalize "$AVATAR_ID" "$AVATAR_NAME" group_avatar image/webp 512
reserve_and_finalize "$VIDEO_ID" "$VIDEO_NAME" post_video video/mp4 1024
reserve_and_finalize "$LEGACY_AVATAR_ID" "$LEGACY_AVATAR_NAME" legacy_image image/webp 512

# private_acl: browser/service roles cannot inspect either table or invoke the
# owner-only helper. Only the four differently named wrappers are executable.
assert_scalar 'true|true|0|0' \
  "SELECT relrowsecurity::text || '|' || relforcerowsecurity::text || '|' ||
          (SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid = c.oid) || '|' ||
          (SELECT count(*) FROM pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) acl WHERE acl.grantee <> c.relowner)
   FROM pg_catalog.pg_class c
   WHERE c.oid = 'public.post_media_claim_sets'::regclass"
expect_failure_matching private_acl 'permission denied for table post_media_claim_sets' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT * FROM public.post_media_claim_sets"
expect_failure_matching owner_only_helper 'permission denied for function claim_post_media_manifest_internal' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.claim_post_media_manifest_internal('post_create', gen_random_uuid(), '$OWNER', '$OWNER', 'post', gen_random_uuid(), NULL, NULL, 0, '$STORAGE_ORIGIN', ARRAY[]::text[], repeat('a',64), '{\"status\":\"created\"}'::jsonb)"
expect_failure_matching null_intent_fingerprint '22023.*invalid post media claim' \
  "SELECT public.claim_post_media_manifest_internal('post_create', gen_random_uuid(), '$OWNER', '$OWNER', 'post', gen_random_uuid(), NULL, NULL, 0, '$STORAGE_ORIGIN', ARRAY[]::text[], NULL, '{\"status\":\"created\"}'::jsonb)"
assert_scalar '4' \
  "SELECT count(*) FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
   WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE '%with_media_claims_atomic'
     AND acl.grantee='service_role'::regrole AND acl.privilege_type='EXECUTE'"

# Empty manifests are first-class claim sets.
EMPTY_OP='40000000-0000-4000-8000-000000000001'
service_sql "SELECT public.create_post_with_media_claims_atomic(
  '$OWNER','$EMPTY_OP','empty','body',NULL,ARRAY[]::text[],false,NULL,NULL,NULL,
  'public',false,NULL,'en',ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],'$STORAGE_ORIGIN'
)->>'status';" >/dev/null
assert_scalar '0|0' \
  "SELECT object_count || '|' || (SELECT count(*) FROM public.post_media_claims WHERE target_id=claim_set.target_id)
   FROM public.post_media_claim_sets claim_set WHERE scope='post_create' AND operation_id='$EMPTY_OP'"

# Exact create, replay, same-upload/multi-target, and manifest conflict.
CREATE_OP='40000000-0000-4000-8000-000000000002'
CREATE_RESULT="$(service_sql "SELECT public.create_post_with_media_claims_atomic(
  '$OWNER','$CREATE_OP','image','body',NULL,ARRAY['$IMAGE_URL'],false,NULL,NULL,NULL,
  'public',false,NULL,'en',ARRAY[]::text[],ARRAY[]::text[],ARRAY['$IMAGE_NAME'],'$STORAGE_ORIGIN'
);")"
CREATE_FIRST_EXPECTED="$(psql_cmd -At -c "SELECT result FROM public.stub_create_ledger WHERE operation_id='$CREATE_OP'")"
if [[ "$CREATE_RESULT" != "$CREATE_FIRST_EXPECTED" ]]; then
  echo 'create wrapper reshaped the strict old first acknowledgement' >&2
  exit 1
fi
CREATE_POST="$(psql_cmd -At -c "SELECT target_id FROM public.post_media_claim_sets WHERE scope='post_create' AND operation_id='$CREATE_OP'")"
assert_scalar '1|post_image|0|0' \
  "SELECT count(*) || '|' || min(reference_kind) || '|' || min(first_seen_revision) || '|' || max(last_seen_revision)
   FROM public.post_media_claims WHERE upload_id='$IMAGE_ID' AND target_kind='post' AND target_id='$CREATE_POST'"
assert_service 'replayed' "SELECT public.create_post_with_media_claims_atomic(
  '$OWNER','$CREATE_OP','image','body',NULL,ARRAY['$IMAGE_URL'],false,NULL,NULL,NULL,
  'public',false,NULL,'en',ARRAY[]::text[],ARRAY[]::text[],ARRAY['$IMAGE_NAME'],'$STORAGE_ORIGIN'
)->>'status';"
CREATE_REPLAY_EXPECTED="$(service_sql "SELECT public.create_post_atomic(
  '$OWNER','$CREATE_OP','image','body',NULL,ARRAY['$IMAGE_URL'],false,NULL,NULL,
  NULL,'public',false,NULL,'en',ARRAY[]::text[],ARRAY[]::text[]
);")"
CREATE_REPLAY_ACTUAL="$(service_sql "SELECT public.create_post_with_media_claims_atomic(
  '$OWNER','$CREATE_OP','image','body',NULL,ARRAY['$IMAGE_URL'],false,NULL,NULL,
  NULL,'public',false,NULL,'en',ARRAY[]::text[],ARRAY[]::text[],
  ARRAY['$IMAGE_NAME'],'$STORAGE_ORIGIN'
);")"
if [[ "$CREATE_REPLAY_ACTUAL" != "$CREATE_REPLAY_EXPECTED" ]]; then
  echo 'create wrapper reshaped the strict old replay acknowledgement' >&2
  exit 1
fi
expect_failure_matching manifest_conflict '22023.*post media claim operation conflict' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
    '$OWNER','$CREATE_OP','image','body',NULL,ARRAY['$IMAGE_URL'],false,NULL,NULL,NULL,
    'public',false,NULL,'en',ARRAY[]::text[],ARRAY[]::text[],ARRAY['$SECOND_NAME'],'$STORAGE_ORIGIN')"

MULTI_OP='40000000-0000-4000-8000-000000000003'
service_sql "SELECT public.create_post_with_media_claims_atomic(
  '$OWNER','$MULTI_OP','second target','body',NULL,ARRAY['$IMAGE_URL'],false,NULL,NULL,NULL,
  'public',false,NULL,'en',ARRAY[]::text[],ARRAY[]::text[],ARRAY['$IMAGE_NAME'],'$STORAGE_ORIGIN'
);" >/dev/null
assert_scalar '2' \
  "SELECT count(*) FROM public.post_media_claims WHERE upload_id='$IMAGE_ID' AND target_kind='post'"

# Images may be canonical in images[] or Markdown content, with one deduped
# claim when present in both. Videos are content-only and never valid in
# images[], even when also referenced by content.
CONTENT_IMAGE_OP='41000000-0000-4000-8000-000000000001'
assert_service 'created' "SELECT public.create_post_with_media_claims_atomic(
  '$OWNER','$CONTENT_IMAGE_OP','content image','![image]($IMAGE_URL)',NULL,
  ARRAY[]::text[],false,NULL,NULL,NULL,'public',false,NULL,'en',
  ARRAY[]::text[],ARRAY[]::text[],ARRAY['$IMAGE_NAME'],'$STORAGE_ORIGIN'
)->>'status';"
assert_scalar '1|post_image' \
  "SELECT count(*) || '|' || min(reference_kind)
   FROM public.post_media_claims
   WHERE first_claim_operation_id='$CONTENT_IMAGE_OP'"

DEDUP_IMAGE_OP='41000000-0000-4000-8000-000000000002'
assert_service 'created' "SELECT public.create_post_with_media_claims_atomic(
  '$OWNER','$DEDUP_IMAGE_OP','dedup image','![image]($IMAGE_URL)',NULL,
  ARRAY['$IMAGE_URL'],false,NULL,NULL,NULL,'public',false,NULL,'en',
  ARRAY[]::text[],ARRAY[]::text[],ARRAY['$IMAGE_NAME'],'$STORAGE_ORIGIN'
)->>'status';"
assert_scalar '1' \
  "SELECT count(*) FROM public.post_media_claims
   WHERE first_claim_operation_id='$DEDUP_IMAGE_OP'"

CONTENT_VIDEO_OP='41000000-0000-4000-8000-000000000003'
assert_service 'created' "SELECT public.create_post_with_media_claims_atomic(
  '$OWNER','$CONTENT_VIDEO_OP','content video','![video]($VIDEO_URL)',NULL,
  ARRAY[]::text[],false,NULL,NULL,NULL,'public',false,NULL,'en',
  ARRAY[]::text[],ARRAY[]::text[],ARRAY['$VIDEO_NAME'],'$STORAGE_ORIGIN'
)->>'status';"
assert_scalar '1|post_video' \
  "SELECT count(*) || '|' || min(reference_kind)
   FROM public.post_media_claims
   WHERE first_claim_operation_id='$CONTENT_VIDEO_OP'"

VIDEO_IMAGES_OP='41000000-0000-4000-8000-000000000004'
expect_failure_matching video_in_images '22023.*post media purpose/reference conflict' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
    '$OWNER','$VIDEO_IMAGES_OP','video in images','![video]($VIDEO_URL)',NULL,
    ARRAY['$VIDEO_URL'],false,NULL,NULL,NULL,'public',false,NULL,'en',
    ARRAY[]::text[],ARRAY[]::text[],ARRAY['$VIDEO_NAME'],'$STORAGE_ORIGIN')"
assert_scalar '0|0|0' \
  "SELECT (SELECT count(*) FROM public.posts WHERE title='video in images') || '|' ||
          (SELECT count(*) FROM public.stub_create_ledger WHERE operation_id='$VIDEO_IMAGES_OP') || '|' ||
          (SELECT count(*) FROM public.post_media_claim_sets WHERE operation_id='$VIDEO_IMAGES_OP')"

# Canonical ownership is origin-bound. A mimicking external origin remains an
# ordinary external URL; a wrong trusted origin or an unregistered canonical
# live reference fails atomically.
EVIL_URL="https://evil.example/storage/v1/object/public/posts/$IMAGE_NAME"
EVIL_EXTERNAL_OP='41000000-0000-4000-8000-000000000005'
assert_service 'created' "SELECT public.create_post_with_media_claims_atomic(
  '$OWNER','$EVIL_EXTERNAL_OP','evil external','body',NULL,ARRAY['$EVIL_URL'],
  false,NULL,NULL,NULL,'public',false,NULL,'en',ARRAY[]::text[],
  ARRAY[]::text[],ARRAY[]::text[],'$STORAGE_ORIGIN'
)->>'status';"
assert_scalar '0|0' \
  "SELECT object_count || '|' ||
          (SELECT count(*) FROM public.post_media_claims WHERE target_id=claim_set.target_id)
   FROM public.post_media_claim_sets AS claim_set
   WHERE operation_id='$EVIL_EXTERNAL_OP'"

WRONG_ORIGIN_OP='41000000-0000-4000-8000-000000000006'
expect_failure_matching wrong_origin '22023.*canonical references' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
    '$OWNER','$WRONG_ORIGIN_OP','wrong origin','body',NULL,ARRAY['$IMAGE_URL'],
    false,NULL,NULL,NULL,'public',false,NULL,'en',ARRAY[]::text[],
    ARRAY[]::text[],ARRAY['$IMAGE_NAME'],'https://other.test')"
assert_scalar '0|0' \
  "SELECT (SELECT count(*) FROM public.posts WHERE title='wrong origin') || '|' ||
          (SELECT count(*) FROM public.stub_create_ledger WHERE operation_id='$WRONG_ORIGIN_OP')"

UNREGISTERED_NAME="$OWNER/30000000-0000-4000-8000-000000000099.jpg"
UNREGISTERED_URL="$STORAGE_ORIGIN/storage/v1/object/public/posts/$UNREGISTERED_NAME"
UNREGISTERED_OP='41000000-0000-4000-8000-000000000007'
expect_failure_matching unregistered_canonical '22023.*canonical references' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
    '$OWNER','$UNREGISTERED_OP','unregistered canonical','body',NULL,
    ARRAY['$UNREGISTERED_URL'],false,NULL,NULL,NULL,'public',false,NULL,'en',
    ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],'$STORAGE_ORIGIN')"
assert_scalar '0|0|0' \
  "SELECT (SELECT count(*) FROM public.posts WHERE title='unregistered canonical') || '|' ||
          (SELECT count(*) FROM public.stub_create_ledger WHERE operation_id='$UNREGISTERED_OP') || '|' ||
          (SELECT count(*) FROM public.post_media_claim_sets WHERE operation_id='$UNREGISTERED_OP')"

MALFORMED_QUERY_OP='41000000-0000-4000-8000-000000000008'
expect_failure_matching malformed_query '22023.*malformed canonical post media reference' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
    '$OWNER','$MALFORMED_QUERY_OP','malformed query','[$IMAGE_URL?token=x]',NULL,
    ARRAY[]::text[],false,NULL,NULL,NULL,'public',false,NULL,'en',
    ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],'$STORAGE_ORIGIN')"
MALFORMED_CASE_OP='41000000-0000-4000-8000-000000000009'
UPPERCASE_URL="https://EXAMPLE.TEST/storage/v1/object/public/posts/$IMAGE_NAME"
expect_failure_matching malformed_case '22023.*malformed canonical post media reference' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
    '$OWNER','$MALFORMED_CASE_OP','malformed case','body',NULL,
    ARRAY['$UPPERCASE_URL'],false,NULL,NULL,NULL,'public',false,NULL,'en',
    ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],'$STORAGE_ORIGIN')"
MALFORMED_STEM_OP='41000000-0000-4000-8000-000000000010'
expect_failure_matching malformed_stem '22023.*malformed canonical post media reference' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
    '$OWNER','$MALFORMED_STEM_OP','malformed stem',
    '$STORAGE_ORIGIN/page?next=/storage/v1/object/public/posts-evil/$IMAGE_NAME',
    NULL,ARRAY[]::text[],false,NULL,NULL,NULL,'public',false,NULL,'en',
    ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],'$STORAGE_ORIGIN')"
MALFORMED_DEFAULT_PORT_OP='41000000-0000-4000-8000-000000000011'
DEFAULT_PORT_URL="https://example.test:443/storage/v1/object/public/posts/$IMAGE_NAME"
expect_failure_matching malformed_default_port '22023.*malformed canonical post media reference' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
    '$OWNER','$MALFORMED_DEFAULT_PORT_OP','malformed default port','body',NULL,
    ARRAY['$DEFAULT_PORT_URL'],false,NULL,NULL,NULL,'public',false,NULL,'en',
    ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],'$STORAGE_ORIGIN')"
MALFORMED_USERINFO_OP='41000000-0000-4000-8000-000000000012'
USERINFO_URL="https://user:pass@example.test/storage/v1/object/public/posts/$IMAGE_NAME"
expect_failure_matching malformed_userinfo '22023.*malformed canonical post media reference' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
    '$OWNER','$MALFORMED_USERINFO_OP','malformed userinfo','body',NULL,
    ARRAY['$USERINFO_URL'],false,NULL,NULL,NULL,'public',false,NULL,'en',
    ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],'$STORAGE_ORIGIN')"
MALFORMED_ENCODED_OP='41000000-0000-4000-8000-000000000013'
ENCODED_POSTS_URL="$STORAGE_ORIGIN/storage/v1/object/public/%70osts/$IMAGE_NAME"
expect_failure_matching malformed_encoded_posts '22023.*malformed canonical post media reference' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
    '$OWNER','$MALFORMED_ENCODED_OP','malformed encoded posts','[$ENCODED_POSTS_URL]',NULL,
    ARRAY[]::text[],false,NULL,NULL,NULL,'public',false,NULL,'en',
    ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],'$STORAGE_ORIGIN')"
assert_scalar '0|0|0' \
  "SELECT (SELECT count(*) FROM public.posts WHERE title IN ('malformed default port','malformed userinfo','malformed encoded posts')) || '|' || (SELECT count(*) FROM public.stub_create_ledger WHERE operation_id IN ('$MALFORMED_DEFAULT_PORT_OP','$MALFORMED_USERINFO_OP','$MALFORMED_ENCODED_OP')) || '|' || (SELECT count(*) FROM public.post_media_claim_sets WHERE operation_id IN ('$MALFORMED_DEFAULT_PORT_OP','$MALFORMED_USERINFO_OP','$MALFORMED_ENCODED_OP'))"
MALFORMED_ENCODED_HOST_OP='41000000-0000-4000-8000-000000000014'
ENCODED_HOST_URL="https://%65xample.test/storage/v1/object/public/posts/$IMAGE_NAME"
expect_failure_matching malformed_encoded_host '22023.*malformed canonical post media reference' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
    '$OWNER','$MALFORMED_ENCODED_HOST_OP','malformed encoded host','body',NULL,
    ARRAY['$ENCODED_HOST_URL'],false,NULL,NULL,NULL,'public',false,NULL,'en',
    ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],'$STORAGE_ORIGIN')"
MALFORMED_PADDED_PORT_OP='41000000-0000-4000-8000-000000000015'
PADDED_PORT_URL="https://example.test:0443/storage/v1/object/public/posts/$IMAGE_NAME"
expect_failure_matching malformed_padded_port '22023.*malformed canonical post media reference' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
    '$OWNER','$MALFORMED_PADDED_PORT_OP','malformed padded port','body',NULL,
    ARRAY['$PADDED_PORT_URL'],false,NULL,NULL,NULL,'public',false,NULL,'en',
    ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],'$STORAGE_ORIGIN')"
MALFORMED_BACKSLASH_OP='41000000-0000-4000-8000-000000000016'
BACKSLASH_URL="https:\\\\example.test\\storage\\v1\\object\\public\\posts\\$IMAGE_NAME"
expect_failure_matching malformed_backslash '22023.*malformed canonical post media reference' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
    '$OWNER','$MALFORMED_BACKSLASH_OP','malformed backslash','body',NULL,
    ARRAY['$BACKSLASH_URL'],false,NULL,NULL,NULL,'public',false,NULL,'en',
    ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],'$STORAGE_ORIGIN')"
assert_scalar '0|0|0' \
  "SELECT (SELECT count(*) FROM public.posts WHERE title IN ('malformed encoded host','malformed padded port','malformed backslash')) || '|' || (SELECT count(*) FROM public.stub_create_ledger WHERE operation_id IN ('$MALFORMED_ENCODED_HOST_OP','$MALFORMED_PADDED_PORT_OP','$MALFORMED_BACKSLASH_OP')) || '|' || (SELECT count(*) FROM public.post_media_claim_sets WHERE operation_id IN ('$MALFORMED_ENCODED_HOST_OP','$MALFORMED_PADDED_PORT_OP','$MALFORMED_BACKSLASH_OP'))"

# claim_failure_rolls_back_create: the old post and its old ledger must both
# disappear when the exact registered reference manifest raises.
ROLLBACK_CREATE_OP='40000000-0000-4000-8000-000000000004'
expect_failure_matching claim_failure_rolls_back_create 'manifest does not exactly match' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
    '$OWNER','$ROLLBACK_CREATE_OP','rollback create','body',NULL,ARRAY['$SECOND_URL'],false,NULL,NULL,NULL,
    'public',false,NULL,'en',ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],'$STORAGE_ORIGIN')"
assert_scalar '0|0|0' \
  "SELECT (SELECT count(*) FROM public.posts WHERE title='rollback create') || '|' ||
          (SELECT count(*) FROM public.stub_create_ledger WHERE operation_id='$ROLLBACK_CREATE_OP') || '|' ||
          (SELECT count(*) FROM public.post_media_claim_sets WHERE operation_id='$ROLLBACK_CREATE_OP')"

# Uploaded reservations remain claimable after expiry; claims never update the
# upload lifecycle row.
psql_cmd -c "UPDATE public.post_media_uploads SET created_at=clock_timestamp()-interval '2 hours', updated_at=clock_timestamp()-interval '2 hours', expires_at=clock_timestamp()-interval '1 hour' WHERE upload_id='$SECOND_ID'"
EXPIRED_OP='40000000-0000-4000-8000-000000000005'
assert_service 'created' "SELECT public.create_post_with_media_claims_atomic(
  '$OWNER','$EXPIRED_OP','expired uploaded','body',NULL,ARRAY['$SECOND_URL'],false,NULL,NULL,NULL,
  'public',false,NULL,'en',ARRAY[]::text[],ARRAY[]::text[],ARRAY['$SECOND_NAME'],'$STORAGE_ORIGIN'
)->>'status';"
assert_scalar 'uploaded|true' \
  "SELECT status || '|' || (expires_at < clock_timestamp())::text FROM public.post_media_uploads WHERE upload_id='$SECOND_ID'"

# A lost create ACK cannot be supplemented at revision zero after the post has
# advanced. The old replay remains intact, but no stale claim evidence is
# written against the current post.
STALE_CREATE_OP='45000000-0000-4000-8000-000000000001'
STALE_POST="$(service_sql "SELECT public.create_post_atomic(
  '$OWNER','$STALE_CREATE_OP','stale original','body',NULL,ARRAY['$IMAGE_URL'],
  false,NULL,NULL,NULL,'public',false,NULL,'en',ARRAY[]::text[],ARRAY[]::text[]
)#>>'{post,id}';")"
service_sql "SELECT public.edit_post_atomic(
  '$OWNER','$STALE_POST',0,'stale advanced','body',true,ARRAY['$IMAGE_URL'],
  'en',ARRAY[]::text[],ARRAY[]::text[]
);" >/dev/null
expect_failure_matching stale_create_revision '40001.*post media claim revision is stale' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
    '$OWNER','$STALE_CREATE_OP','stale original','body',NULL,ARRAY['$IMAGE_URL'],
    false,NULL,NULL,NULL,'public',false,NULL,'en',ARRAY[]::text[],ARRAY[]::text[],
    ARRAY['$IMAGE_NAME'],'$STORAGE_ORIGIN')"
assert_scalar 'stale advanced|1|0|0' \
  "SELECT title || '|' || content_version || '|' ||
          (SELECT count(*) FROM public.post_media_claim_sets WHERE operation_id='$STALE_CREATE_OP') || '|' ||
          (SELECT count(*) FROM public.post_media_claims WHERE target_kind='post' AND target_id='$STALE_POST')
   FROM public.posts WHERE id='$STALE_POST'"

# exact_edit_replay stores and returns the complete first old-RPC ACK. A
# different manifest or non-media intent with the same operation raises.
EDIT_POST="$(psql_cmd -At -c "SELECT target_id FROM public.post_media_claim_sets WHERE scope='post_create' AND operation_id='$EMPTY_OP'")"
EDIT_OP='40000000-0000-4000-8000-000000000007'
EDIT_RESULT="$(service_sql "SELECT public.edit_post_with_media_claims_atomic(
  '$OWNER','$EDIT_POST',0,'empty edited','body',true,ARRAY['$SECOND_URL'],'en',ARRAY[]::text[],ARRAY[]::text[],ARRAY['$SECOND_NAME'],'$EDIT_OP','$STORAGE_ORIGIN'
);")"
EDIT_RESULT_REPLAY="$(service_sql "SELECT public.edit_post_with_media_claims_atomic(
  '$OWNER','$EDIT_POST',0,'empty edited','body',true,ARRAY['$SECOND_URL'],'en',ARRAY[]::text[],ARRAY[]::text[],ARRAY['$SECOND_NAME'],'$EDIT_OP','$STORAGE_ORIGIN'
);")"
if [[ "$EDIT_RESULT" != "$EDIT_RESULT_REPLAY" ]]; then
  echo 'exact_edit_replay did not return the stored ACK' >&2
  exit 1
fi
assert_scalar '1|0|1' \
  "SELECT count(*) || '|' || min(requested_revision) || '|' || max(target_revision)
   FROM public.post_media_claim_sets WHERE scope='post_edit' AND operation_id='$EDIT_OP'"
expect_failure_matching edit_manifest_conflict '22023.*post media claim operation conflict' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.edit_post_with_media_claims_atomic(
    '$OWNER','$EDIT_POST',0,'empty edited','body',true,ARRAY['$SECOND_URL'],'en',ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],'$EDIT_OP','$STORAGE_ORIGIN')"
expect_failure_matching edit_intent_conflict '22023.*post media claim operation conflict' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.edit_post_with_media_claims_atomic(
    '$OWNER','$EDIT_POST',0,'changed replay intent','body',true,ARRAY['$SECOND_URL'],'en',ARRAY[]::text[],ARRAY[]::text[],ARRAY['$SECOND_NAME'],'$EDIT_OP','$STORAGE_ORIGIN')"

ROLLBACK_EDIT_OP='40000000-0000-4000-8000-000000000008'
expect_failure_matching claim_failure_rolls_back_edit 'manifest does not exactly match' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.edit_post_with_media_claims_atomic(
    '$OWNER','$EDIT_POST',1,'rollback edit','body',true,ARRAY['$IMAGE_URL'],'en',ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],'$ROLLBACK_EDIT_OP','$STORAGE_ORIGIN')"
assert_scalar 'empty edited|1|0' \
  "SELECT title || '|' || content_version || '|' ||
          (SELECT count(*) FROM public.post_media_claim_sets WHERE operation_id='$ROLLBACK_EDIT_OP')
   FROM public.posts WHERE id='$EDIT_POST'"

# Lost old-edit ACK: the authority already advanced expected revision 0 to 1.
# Repeating the identical edit is unchanged at expected+1, and the new wrapper
# may atomically supplement that exact final state with the missing claim.
LOST_EDIT_CREATE_OP='49000000-0000-4000-8000-000000000001'
LOST_EDIT_POST="$(service_sql "SELECT public.create_post_atomic(
  '$OWNER','$LOST_EDIT_CREATE_OP','lost before','body',NULL,ARRAY[]::text[],
  false,NULL,NULL,NULL,'public',false,NULL,'en',ARRAY[]::text[],ARRAY[]::text[]
)#>>'{post,id}';")"
assert_service 'updated' "SELECT public.edit_post_atomic(
  '$OWNER','$LOST_EDIT_POST',0,'lost after','body',true,ARRAY['$IMAGE_URL'],
  'en',ARRAY[]::text[],ARRAY[]::text[]
)->>'status';"
LOST_EDIT_CLAIM_OP='49000000-0000-4000-8000-000000000002'
assert_service 'unchanged' "SELECT public.edit_post_with_media_claims_atomic(
  '$OWNER','$LOST_EDIT_POST',0,'lost after','body',true,ARRAY['$IMAGE_URL'],
  'en',ARRAY[]::text[],ARRAY[]::text[],ARRAY['$IMAGE_NAME'],
  '$LOST_EDIT_CLAIM_OP','$STORAGE_ORIGIN'
)->>'status';"
assert_scalar '0|1|1|1' \
  "SELECT requested_revision || '|' || target_revision || '|' || (SELECT content_version FROM public.posts WHERE id='$LOST_EDIT_POST') || '|' || (SELECT count(*) FROM public.post_media_claims WHERE target_kind='post' AND target_id='$LOST_EDIT_POST' AND upload_id='$IMAGE_ID') FROM public.post_media_claim_sets WHERE operation_id='$LOST_EDIT_CLAIM_OP'"

BAD_ACK_CREATE_OP='48000000-0000-4000-8000-000000000001'
BAD_ACK_POST="$(service_sql "SELECT public.create_post_atomic(
  '$OWNER','$BAD_ACK_CREATE_OP','before bad ack','body',NULL,ARRAY[]::text[],
  false,NULL,NULL,NULL,'public',false,NULL,'en',ARRAY[]::text[],ARRAY[]::text[]
)#>>'{post,id}';")"
BAD_ACK_EDIT_OP='48000000-0000-4000-8000-000000000002'
expect_failure_matching bad_updated_revision_ack '55000.*post edit media claim acknowledgement is invalid' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.edit_post_with_media_claims_atomic(
    '$OWNER','$BAD_ACK_POST',0,'bad revision ack','changed',true,ARRAY[]::text[],
    'en',ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],'$BAD_ACK_EDIT_OP','$STORAGE_ORIGIN')"
assert_scalar 'before bad ack|body|0|0' \
  "SELECT title || '|' || content || '|' || content_version || '|' || (SELECT count(*) FROM public.post_media_claim_sets WHERE operation_id='$BAD_ACK_EDIT_OP') FROM public.posts WHERE id='$BAD_ACK_POST'"

# Claims are append-only evidence, not a live-reference table. Removing media
# writes an empty set but preserves the historical row; a later re-add advances
# only last_seen_revision and retains first operation/revision identity.
REMOVE_MEDIA_OP='44000000-0000-4000-8000-000000000001'
assert_service 'updated' "SELECT public.edit_post_with_media_claims_atomic(
  '$OWNER','$CREATE_POST',0,'image removed','body',true,ARRAY[]::text[],'en',
  ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],'$REMOVE_MEDIA_OP',
  '$STORAGE_ORIGIN'
)->>'status';"
assert_scalar '0|1|0|0' \
  "SELECT
    (SELECT object_count FROM public.post_media_claim_sets WHERE operation_id='$REMOVE_MEDIA_OP') || '|' ||
    count(*) || '|' || min(first_seen_revision) || '|' || max(last_seen_revision)
   FROM public.post_media_claims
   WHERE upload_id='$IMAGE_ID' AND target_kind='post' AND target_id='$CREATE_POST'"
READD_MEDIA_OP='44000000-0000-4000-8000-000000000002'
assert_service 'updated' "SELECT public.edit_post_with_media_claims_atomic(
  '$OWNER','$CREATE_POST',1,'image readded','body',true,ARRAY['$IMAGE_URL'],'en',
  ARRAY[]::text[],ARRAY[]::text[],ARRAY['$IMAGE_NAME'],'$READD_MEDIA_OP',
  '$STORAGE_ORIGIN'
)->>'status';"
assert_scalar "1|$CREATE_OP|0|2" \
  "SELECT count(*) || '|' || min(first_claim_operation_id::text) || '|' ||
          min(first_seen_revision) || '|' || max(last_seen_revision)
   FROM public.post_media_claims
   WHERE upload_id='$IMAGE_ID' AND target_kind='post' AND target_id='$CREATE_POST'"

# Registry state alone is never durable evidence. Removing the exact
# storage.objects row rolls back each composed old authority, its ledger and
# every claim write; restoring the row makes the same evidence claimable.
MISSING_IMAGE_ID='20000000-0000-4000-8000-000000000006'
MISSING_IMAGE_NAME="$OWNER/30000000-0000-4000-8000-000000000006.jpg"
MISSING_IMAGE_URL="$STORAGE_ORIGIN/storage/v1/object/public/posts/$MISSING_IMAGE_NAME"
reserve_and_finalize "$MISSING_IMAGE_ID" "$MISSING_IMAGE_NAME" post_image image/jpeg 333
psql_cmd -c "DELETE FROM storage.objects WHERE bucket_id='posts' AND name='$MISSING_IMAGE_NAME'"
MISSING_CREATE_OP='43000000-0000-4000-8000-000000000001'
expect_failure_matching storage_missing_create '22023.*Storage object is unavailable' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
    '$OWNER','$MISSING_CREATE_OP','missing storage create','body',NULL,
    ARRAY['$MISSING_IMAGE_URL'],false,NULL,NULL,NULL,'public',false,NULL,'en',
    ARRAY[]::text[],ARRAY[]::text[],ARRAY['$MISSING_IMAGE_NAME'],'$STORAGE_ORIGIN')"
assert_scalar '0|0|0|0' \
  "SELECT (SELECT count(*) FROM public.posts WHERE title='missing storage create') || '|' ||
          (SELECT count(*) FROM public.stub_create_ledger WHERE operation_id='$MISSING_CREATE_OP') || '|' ||
          (SELECT count(*) FROM public.post_media_claim_sets WHERE operation_id='$MISSING_CREATE_OP') || '|' ||
          (SELECT count(*) FROM public.post_media_claims WHERE first_claim_operation_id='$MISSING_CREATE_OP')"
psql_cmd -c "INSERT INTO storage.objects(bucket_id,name) VALUES ('posts','$MISSING_IMAGE_NAME')"
assert_service 'created' "SELECT public.create_post_with_media_claims_atomic(
  '$OWNER','$MISSING_CREATE_OP','missing storage create','body',NULL,
  ARRAY['$MISSING_IMAGE_URL'],false,NULL,NULL,NULL,'public',false,NULL,'en',
  ARRAY[]::text[],ARRAY[]::text[],ARRAY['$MISSING_IMAGE_NAME'],'$STORAGE_ORIGIN'
)->>'status';"

psql_cmd -c "DELETE FROM storage.objects WHERE bucket_id='posts' AND name='$MISSING_IMAGE_NAME'"
MISSING_EDIT_OP='43000000-0000-4000-8000-000000000002'
expect_failure_matching storage_missing_edit '22023.*Storage object is unavailable' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.edit_post_with_media_claims_atomic(
    '$OWNER','$EDIT_POST',1,'storage edit rollback','body',true,
    ARRAY['$MISSING_IMAGE_URL'],'en',ARRAY[]::text[],ARRAY[]::text[],
    ARRAY['$MISSING_IMAGE_NAME'],'$MISSING_EDIT_OP','$STORAGE_ORIGIN')"
assert_scalar 'empty edited|1|0|0' \
  "SELECT title || '|' || content_version || '|' ||
          (SELECT count(*) FROM public.post_media_claim_sets WHERE operation_id='$MISSING_EDIT_OP') || '|' ||
          (SELECT count(*) FROM public.post_media_claims WHERE first_claim_operation_id='$MISSING_EDIT_OP')
   FROM public.posts WHERE id='$EDIT_POST'"
psql_cmd -c "INSERT INTO storage.objects(bucket_id,name) VALUES ('posts','$MISSING_IMAGE_NAME')"

# A durable edit operation replay is independent of later post revisions.
# After an unrelated legacy edit advances the post again, the original claim
# operation still returns its byte-exact stored ACK without calling legacy.
assert_service 'updated' "SELECT public.edit_post_atomic(
  '$OWNER','$EDIT_POST',1,'advanced after claim','later',true,
  ARRAY['$SECOND_URL'],'en',ARRAY[]::text[],ARRAY[]::text[]
)->>'status';"
EDIT_RESULT_AFTER_ADVANCE="$(service_sql "SELECT public.edit_post_with_media_claims_atomic(
  '$OWNER','$EDIT_POST',0,'empty edited','body',true,ARRAY['$SECOND_URL'],'en',
  ARRAY[]::text[],ARRAY[]::text[],ARRAY['$SECOND_NAME'],'$EDIT_OP','$STORAGE_ORIGIN'
);")"
if [[ "$EDIT_RESULT_AFTER_ADVANCE" != "$EDIT_RESULT" ]]; then
  echo 'advanced edit replay did not return the durable stored ACK' >&2
  exit 1
fi
assert_scalar 'advanced after claim|later|2|1' \
  "SELECT title || '|' || content || '|' || content_version || '|' || (SELECT count(*) FROM public.post_media_claim_sets WHERE operation_id='$EDIT_OP') FROM public.posts WHERE id='$EDIT_POST'"

MISSING_AVATAR_ID='20000000-0000-4000-8000-000000000007'
MISSING_AVATAR_NAME="$OWNER/30000000-0000-4000-8000-000000000007.webp"
MISSING_AVATAR_URL="$STORAGE_ORIGIN/storage/v1/object/public/posts/$MISSING_AVATAR_NAME"
reserve_and_finalize "$MISSING_AVATAR_ID" "$MISSING_AVATAR_NAME" group_avatar image/webp 444
psql_cmd -c "DELETE FROM storage.objects WHERE bucket_id='posts' AND name='$MISSING_AVATAR_NAME'"
MISSING_SUBMIT_OP='43000000-0000-4000-8000-000000000003'
expect_failure_matching storage_missing_submit '22023.*Storage object is unavailable' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.submit_group_application_with_media_claims_atomic(
    '$OWNER','missing storage submit',NULL,NULL,NULL,'$MISSING_AVATAR_URL',
    NULL,NULL,NULL,false,false,'$MISSING_SUBMIT_OP',ARRAY['$MISSING_AVATAR_NAME'],
    '$STORAGE_ORIGIN')"
assert_scalar '0|0|0|0' \
  "SELECT (SELECT count(*) FROM public.group_applications WHERE name='missing storage submit') || '|' ||
          (SELECT count(*) FROM public.stub_group_ledger WHERE operation_id='$MISSING_SUBMIT_OP') || '|' ||
          (SELECT count(*) FROM public.post_media_claim_sets WHERE operation_id='$MISSING_SUBMIT_OP') || '|' ||
          (SELECT count(*) FROM public.post_media_claims WHERE first_claim_operation_id='$MISSING_SUBMIT_OP')"
psql_cmd -c "INSERT INTO storage.objects(bucket_id,name) VALUES ('posts','$MISSING_AVATAR_NAME')"

MISSING_REVIEW_SUBMIT_OP='43000000-0000-4000-8000-000000000004'
MISSING_REVIEW_APP="$(service_sql "SELECT public.submit_group_application_atomic(
  '$OWNER','missing storage review',NULL,NULL,NULL,'$MISSING_AVATAR_URL',
  NULL,NULL,NULL,false,false,'$MISSING_REVIEW_SUBMIT_OP'
)->>'application_id';")"
psql_cmd -c "DELETE FROM storage.objects WHERE bucket_id='posts' AND name='$MISSING_AVATAR_NAME'"
MISSING_REVIEW_OP='43000000-0000-4000-8000-000000000005'
expect_failure_matching storage_missing_review '22023.*Storage object is unavailable' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.review_group_application_with_media_claims_atomic(
    '$REVIEWER','$MISSING_REVIEW_APP','approve',NULL,false,'$MISSING_REVIEW_OP','$STORAGE_ORIGIN')"
assert_scalar 'pending|0|0|0|0' \
  "SELECT status || '|' ||
          (SELECT count(*) FROM public.groups WHERE name='missing storage review') || '|' ||
          (SELECT count(*) FROM public.stub_group_ledger WHERE operation_id='$MISSING_REVIEW_OP') || '|' ||
          (SELECT count(*) FROM public.post_media_claim_sets WHERE operation_id='$MISSING_REVIEW_OP') || '|' ||
          (SELECT count(*) FROM public.post_media_claims WHERE target_kind='group_application' AND target_id='$MISSING_REVIEW_APP')
   FROM public.group_applications WHERE id='$MISSING_REVIEW_APP'"
psql_cmd -c "INSERT INTO storage.objects(bucket_id,name) VALUES ('posts','$MISSING_AVATAR_NAME')"

# Group submit claims the application. Approval copies the same upload claim to
# the group while preserving the application target; exact replay adds none.
GROUP_SUBMIT_OP='40000000-0000-4000-8000-000000000009'
GROUP_RESULT="$(service_sql "SELECT public.submit_group_application_with_media_claims_atomic(
  '$OWNER','claimed group',NULL,NULL,NULL,'$AVATAR_URL',NULL,NULL,NULL,false,false,
  '$GROUP_SUBMIT_OP',ARRAY['$AVATAR_NAME'],'$STORAGE_ORIGIN'
);")"
GROUP_FIRST_EXPECTED="$(psql_cmd -At -c "SELECT result || pg_catalog.jsonb_build_object('applied',true) FROM public.stub_group_ledger WHERE operation_id='$GROUP_SUBMIT_OP'")"
if [[ "$GROUP_RESULT" != "$GROUP_FIRST_EXPECTED" ]]; then
  echo 'group submit wrapper reshaped the strict old first acknowledgement' >&2
  exit 1
fi
APPLICATION_ID="$(psql_cmd -At -c "SELECT target_id FROM public.post_media_claim_sets WHERE scope='group_submit' AND operation_id='$GROUP_SUBMIT_OP'")"
GROUP_SUBMIT_REPLAY_EXPECTED="$(service_sql "SELECT public.submit_group_application_atomic(
  '$OWNER','claimed group',NULL,NULL,NULL,'$AVATAR_URL',NULL,NULL,NULL,false,false,
  '$GROUP_SUBMIT_OP'
);")"
GROUP_SUBMIT_REPLAY_ACTUAL="$(service_sql "SELECT public.submit_group_application_with_media_claims_atomic(
  '$OWNER','claimed group',NULL,NULL,NULL,'$AVATAR_URL',NULL,NULL,NULL,false,false,
  '$GROUP_SUBMIT_OP',ARRAY['$AVATAR_NAME'],'$STORAGE_ORIGIN'
);")"
if [[ "$GROUP_SUBMIT_REPLAY_ACTUAL" != "$GROUP_SUBMIT_REPLAY_EXPECTED" ]]; then
  echo 'group submit wrapper reshaped the strict old replay acknowledgement' >&2
  exit 1
fi
assert_scalar '1' \
  "SELECT count(*) FROM public.post_media_claims WHERE upload_id='$AVATAR_ID' AND target_kind='group_application' AND target_id='$APPLICATION_ID'"
GROUP_REVIEW_OP='40000000-0000-4000-8000-000000000010'
GROUP_REVIEW_RESULT="$(service_sql "SELECT public.review_group_application_with_media_claims_atomic(
  '$REVIEWER','$APPLICATION_ID','approve',NULL,false,'$GROUP_REVIEW_OP','$STORAGE_ORIGIN'
);")"
GROUP_REVIEW_FIRST_EXPECTED="$(psql_cmd -At -c "SELECT result || pg_catalog.jsonb_build_object('applied',true) FROM public.stub_group_ledger WHERE operation_id='$GROUP_REVIEW_OP'")"
if [[ "$GROUP_REVIEW_RESULT" != "$GROUP_REVIEW_FIRST_EXPECTED" ]]; then
  echo 'group review wrapper reshaped the strict old first acknowledgement' >&2
  exit 1
fi
GROUP_ID="$(psql_cmd -At -c "SELECT target_id FROM public.post_media_claim_sets WHERE scope='group_review' AND operation_id='$GROUP_REVIEW_OP'")"
assert_scalar '2|1|1|approved' \
  "SELECT (SELECT count(*) FROM public.post_media_claims WHERE upload_id='$AVATAR_ID') || '|' ||
          (SELECT count(*) FROM public.post_media_claims WHERE upload_id='$AVATAR_ID' AND target_kind='group_application' AND target_id='$APPLICATION_ID') || '|' ||
          (SELECT count(*) FROM public.post_media_claims WHERE upload_id='$AVATAR_ID' AND target_kind='group' AND target_id='$GROUP_ID') || '|' ||
          (SELECT status FROM public.group_applications WHERE id='$APPLICATION_ID')"
GROUP_REVIEW_REPLAY_EXPECTED="$(service_sql "SELECT public.review_group_application_atomic(
  '$REVIEWER','$APPLICATION_ID','approve',NULL,false,'$GROUP_REVIEW_OP'
);")"
GROUP_REVIEW_REPLAY_ACTUAL="$(service_sql "SELECT public.review_group_application_with_media_claims_atomic(
  '$REVIEWER','$APPLICATION_ID','approve',NULL,false,'$GROUP_REVIEW_OP','$STORAGE_ORIGIN'
);")"
if [[ "$GROUP_REVIEW_REPLAY_ACTUAL" != "$GROUP_REVIEW_REPLAY_EXPECTED" ]]; then
  echo 'group review wrapper reshaped the strict old replay acknowledgement' >&2
  exit 1
fi
assert_scalar '2' "SELECT count(*) FROM public.post_media_claims WHERE upload_id='$AVATAR_ID'"

# Rolling old-submit/new-review supplements exact registered evidence. Approve
# writes one review claim-set plus application+group claims; reject writes one
# review claim-set plus only the application claim.
OLD_APPROVE_SUBMIT_OP='40000000-0000-4000-8000-000000000011'
OLD_APPROVE_APP="$(service_sql "SELECT public.submit_group_application_atomic(
  '$OWNER','old approve',NULL,NULL,NULL,'$LEGACY_AVATAR_URL',NULL,NULL,NULL,false,false,
  '$OLD_APPROVE_SUBMIT_OP'
)->>'application_id';")"
OLD_APPROVE_REVIEW_OP='40000000-0000-4000-8000-000000000012'
assert_service 'approved' "SELECT public.review_group_application_with_media_claims_atomic(
  '$REVIEWER','$OLD_APPROVE_APP','approve',NULL,false,'$OLD_APPROVE_REVIEW_OP','$STORAGE_ORIGIN'
)->>'status';"
OLD_APPROVE_GROUP="$(psql_cmd -At -c "SELECT target_id FROM public.post_media_claim_sets WHERE scope='group_review' AND operation_id='$OLD_APPROVE_REVIEW_OP'")"
assert_scalar '1|1|1' \
  "SELECT
    (SELECT count(*) FROM public.post_media_claim_sets WHERE scope='group_review' AND operation_id='$OLD_APPROVE_REVIEW_OP') || '|' ||
    (SELECT count(*) FROM public.post_media_claims WHERE upload_id='$LEGACY_AVATAR_ID' AND target_kind='group_application' AND target_id='$OLD_APPROVE_APP') || '|' ||
    (SELECT count(*) FROM public.post_media_claims WHERE upload_id='$LEGACY_AVATAR_ID' AND target_kind='group' AND target_id='$OLD_APPROVE_GROUP')"

OLD_REJECT_SUBMIT_OP='40000000-0000-4000-8000-000000000013'
OLD_REJECT_APP="$(service_sql "SELECT public.submit_group_application_atomic(
  '$OWNER','old reject',NULL,NULL,NULL,'$LEGACY_AVATAR_URL',NULL,NULL,NULL,false,false,
  '$OLD_REJECT_SUBMIT_OP'
)->>'application_id';")"
OLD_REJECT_REVIEW_OP='40000000-0000-4000-8000-000000000014'
OLD_REJECT_FIRST_ACTUAL="$(service_sql "SELECT public.review_group_application_with_media_claims_atomic(
  '$REVIEWER','$OLD_REJECT_APP','reject','no',false,'$OLD_REJECT_REVIEW_OP','$STORAGE_ORIGIN'
);")"
OLD_REJECT_FIRST_EXPECTED="$(psql_cmd -At -c "SELECT result || pg_catalog.jsonb_build_object('applied',true) FROM public.stub_group_ledger WHERE operation_id='$OLD_REJECT_REVIEW_OP'")"
if [[ "$OLD_REJECT_FIRST_ACTUAL" != "$OLD_REJECT_FIRST_EXPECTED" ]]; then
  echo 'group reject wrapper reshaped the strict old first acknowledgement' >&2
  exit 1
fi
assert_scalar '1|1|0' \
  "SELECT
    (SELECT count(*) FROM public.post_media_claim_sets WHERE scope='group_review' AND operation_id='$OLD_REJECT_REVIEW_OP') || '|' ||
    (SELECT count(*) FROM public.post_media_claims WHERE upload_id='$LEGACY_AVATAR_ID' AND target_kind='group_application' AND target_id='$OLD_REJECT_APP') || '|' ||
    (SELECT count(*) FROM public.post_media_claims WHERE upload_id='$LEGACY_AVATAR_ID' AND target_kind='group' AND first_claim_operation_id='$OLD_REJECT_REVIEW_OP')"
OLD_REJECT_REPLAY_EXPECTED="$(service_sql "SELECT public.review_group_application_atomic(
  '$REVIEWER','$OLD_REJECT_APP','reject','no',false,'$OLD_REJECT_REVIEW_OP'
);")"
OLD_REJECT_REPLAY_ACTUAL="$(service_sql "SELECT public.review_group_application_with_media_claims_atomic(
  '$REVIEWER','$OLD_REJECT_APP','reject','no',false,'$OLD_REJECT_REVIEW_OP','$STORAGE_ORIGIN'
);")"
if [[ "$OLD_REJECT_REPLAY_ACTUAL" != "$OLD_REJECT_REPLAY_EXPECTED" ]]; then
  echo 'group reject wrapper reshaped the strict old replay acknowledgement' >&2
  exit 1
fi

# A new submit followed by an old review can be replayed through the new
# wrapper to add the previously missing group claim without a second set.
MIXED_SUBMIT_OP='40000000-0000-4000-8000-000000000015'
MIXED_APP="$(service_sql "SELECT public.submit_group_application_with_media_claims_atomic(
  '$OWNER','mixed review',NULL,NULL,NULL,'$LEGACY_AVATAR_URL',NULL,NULL,NULL,false,false,
  '$MIXED_SUBMIT_OP',ARRAY['$LEGACY_AVATAR_NAME'],'$STORAGE_ORIGIN'
)->>'application_id';")"
MIXED_REVIEW_OP='40000000-0000-4000-8000-000000000016'
MIXED_GROUP="$(service_sql "SELECT public.review_group_application_atomic(
  '$REVIEWER','$MIXED_APP','approve',NULL,false,'$MIXED_REVIEW_OP'
)->>'group_id';")"
assert_service 'approved' "SELECT public.review_group_application_with_media_claims_atomic(
  '$REVIEWER','$MIXED_APP','approve',NULL,false,'$MIXED_REVIEW_OP','$STORAGE_ORIGIN'
)->>'status';"
assert_scalar '1|1|1' \
  "SELECT
    (SELECT count(*) FROM public.post_media_claim_sets WHERE scope='group_review' AND operation_id='$MIXED_REVIEW_OP') || '|' ||
    (SELECT count(*) FROM public.post_media_claims WHERE upload_id='$LEGACY_AVATAR_ID' AND target_kind='group_application' AND target_id='$MIXED_APP') || '|' ||
    (SELECT count(*) FROM public.post_media_claims WHERE upload_id='$LEGACY_AVATAR_ID' AND target_kind='group' AND target_id='$MIXED_GROUP')"

# Foreign-origin mimics stay external, while canonical unregistered or
# purpose-incompatible avatars fail closed and roll the old review back.
EVIL_GROUP_SUBMIT_OP='42000000-0000-4000-8000-000000000001'
EVIL_GROUP_APP="$(service_sql "SELECT public.submit_group_application_atomic(
  '$OWNER','evil external group',NULL,NULL,NULL,
  'https://evil.example/storage/v1/object/public/posts/$AVATAR_NAME',
  NULL,NULL,NULL,false,false,'$EVIL_GROUP_SUBMIT_OP'
)->>'application_id';")"
EVIL_GROUP_REVIEW_OP='42000000-0000-4000-8000-000000000002'
assert_service 'approved' "SELECT public.review_group_application_with_media_claims_atomic(
  '$REVIEWER','$EVIL_GROUP_APP','approve',NULL,false,'$EVIL_GROUP_REVIEW_OP','$STORAGE_ORIGIN'
)->>'status';"
assert_scalar '0|0' \
  "SELECT object_count || '|' ||
          (SELECT count(*) FROM public.post_media_claims
           WHERE first_claim_operation_id='$EVIL_GROUP_REVIEW_OP')
   FROM public.post_media_claim_sets
   WHERE scope='group_review' AND operation_id='$EVIL_GROUP_REVIEW_OP'"

BAD_PURPOSE_SUBMIT_OP='42000000-0000-4000-8000-000000000003'
BAD_PURPOSE_APP="$(service_sql "SELECT public.submit_group_application_atomic(
  '$OWNER','bad purpose group',NULL,NULL,NULL,'$IMAGE_URL',NULL,NULL,NULL,
  false,false,'$BAD_PURPOSE_SUBMIT_OP'
)->>'application_id';")"
BAD_PURPOSE_REVIEW_OP='42000000-0000-4000-8000-000000000004'
expect_failure_matching group_purpose_mismatch '22023.*group media purpose/reference conflict' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.review_group_application_with_media_claims_atomic(
    '$REVIEWER','$BAD_PURPOSE_APP','approve',NULL,false,'$BAD_PURPOSE_REVIEW_OP','$STORAGE_ORIGIN')"
assert_scalar 'pending|0|0|0' \
  "SELECT status || '|' ||
          (SELECT count(*) FROM public.groups WHERE name='bad purpose group') || '|' ||
          (SELECT count(*) FROM public.stub_group_ledger WHERE operation_id='$BAD_PURPOSE_REVIEW_OP') || '|' ||
          (SELECT count(*) FROM public.post_media_claim_sets WHERE operation_id='$BAD_PURPOSE_REVIEW_OP')
   FROM public.group_applications WHERE id='$BAD_PURPOSE_APP'"

UNREGISTERED_GROUP_SUBMIT_OP='42000000-0000-4000-8000-000000000005'
UNREGISTERED_GROUP_APP="$(service_sql "SELECT public.submit_group_application_atomic(
  '$OWNER','unregistered group',NULL,NULL,NULL,'$UNREGISTERED_URL',NULL,NULL,NULL,
  false,false,'$UNREGISTERED_GROUP_SUBMIT_OP'
)->>'application_id';")"
UNREGISTERED_GROUP_REVIEW_OP='42000000-0000-4000-8000-000000000006'
expect_failure_matching unregistered_group_review '22023.*Storage object is unavailable' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.review_group_application_with_media_claims_atomic(
    '$REVIEWER','$UNREGISTERED_GROUP_APP','reject','no',false,'$UNREGISTERED_GROUP_REVIEW_OP','$STORAGE_ORIGIN')"
assert_scalar 'pending|0|0' \
  "SELECT status || '|' ||
          (SELECT count(*) FROM public.stub_group_ledger WHERE operation_id='$UNREGISTERED_GROUP_REVIEW_OP') || '|' ||
          (SELECT count(*) FROM public.post_media_claim_sets WHERE operation_id='$UNREGISTERED_GROUP_REVIEW_OP')
   FROM public.group_applications WHERE id='$UNREGISTERED_GROUP_APP'"

MISMATCH_SUBMIT_OP='42000000-0000-4000-8000-000000000007'
MISMATCH_APP="$(service_sql "SELECT public.submit_group_application_atomic(
  '$OWNER','mismatched final avatar',NULL,NULL,NULL,'$LEGACY_AVATAR_URL',NULL,
  NULL,NULL,false,false,'$MISMATCH_SUBMIT_OP'
)->>'application_id';")"
MISMATCH_REVIEW_OP='42000000-0000-4000-8000-000000000008'
MISMATCH_GROUP="$(service_sql "SELECT public.review_group_application_atomic(
  '$REVIEWER','$MISMATCH_APP','approve',NULL,false,'$MISMATCH_REVIEW_OP'
)->>'group_id';")"
psql_cmd -c "UPDATE public.groups SET avatar_url='$AVATAR_URL' WHERE id='$MISMATCH_GROUP'"
expect_failure_matching mismatched_application_group '22023.*application and group media references conflict' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.review_group_application_with_media_claims_atomic(
    '$REVIEWER','$MISMATCH_APP','approve',NULL,false,'$MISMATCH_REVIEW_OP','$STORAGE_ORIGIN')"
assert_scalar '0' \
  "SELECT count(*) FROM public.post_media_claim_sets WHERE operation_id='$MISMATCH_REVIEW_OP'"

# A replay ACK cannot redirect an approved application claim to another group
# owned by the same applicant with the same avatar. The durable application
# status/group_id link is re-read under lock and binds the exact target.
WRONG_GROUP_SUBMIT_OP='42000000-0000-4000-8000-000000000009'
WRONG_GROUP_APP="$(service_sql "SELECT public.submit_group_application_atomic(
  '$OWNER','wrong group link',NULL,NULL,NULL,'$LEGACY_AVATAR_URL',NULL,NULL,NULL,
  false,false,'$WRONG_GROUP_SUBMIT_OP'
)->>'application_id';")"
WRONG_GROUP_REVIEW_OP='42000000-0000-4000-8000-000000000010'
RIGHT_LINKED_GROUP="$(service_sql "SELECT public.review_group_application_atomic(
  '$REVIEWER','$WRONG_GROUP_APP','approve',NULL,false,'$WRONG_GROUP_REVIEW_OP'
)->>'group_id';")"
WRONG_ACK_GROUP="$(psql_cmd -At -c "INSERT INTO public.groups(created_by,name,avatar_url) VALUES ('$OWNER','wrong ack target','$LEGACY_AVATAR_URL') RETURNING id")"
psql_cmd -c "UPDATE public.stub_group_ledger SET result=pg_catalog.jsonb_set(result,'{group_id}',pg_catalog.to_jsonb('$WRONG_ACK_GROUP'::text)) WHERE operation_id='$WRONG_GROUP_REVIEW_OP'"
expect_failure_matching wrong_group_ack '22023.*approved group application link conflict' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.review_group_application_with_media_claims_atomic(
    '$REVIEWER','$WRONG_GROUP_APP','approve',NULL,false,'$WRONG_GROUP_REVIEW_OP','$STORAGE_ORIGIN')"
assert_scalar "approved|$RIGHT_LINKED_GROUP|0" \
  "SELECT status || '|' || group_id || '|' || (SELECT count(*) FROM public.post_media_claim_sets WHERE operation_id='$WRONG_GROUP_REVIEW_OP') FROM public.group_applications WHERE id='$WRONG_GROUP_APP'"

# RESTRICT means a claim can never disappear through an upload deletion.
expect_failure_matching restrict_upload_delete '23503.*post_media_claims_upload_fkey' \
  "DELETE FROM public.post_media_uploads WHERE upload_id='$IMAGE_ID'"

# concurrent_same_operation: the wrapper operation advisory serializes both
# calls; old ledger replay and one exact claim set survive without duplicates.
CONCURRENT_OP='40000000-0000-4000-8000-000000000017'
CONCURRENT_SQL="SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
  '$OWNER','$CONCURRENT_OP','concurrent same operation','body',NULL,ARRAY[]::text[],false,NULL,NULL,NULL,
  'public',false,NULL,'en',ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],'$STORAGE_ORIGIN')->>'status';"
"$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -qAt -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres \
  -c "$CONCURRENT_SQL" >"$LOG_DIR/concurrent-1.out" 2>"$LOG_DIR/concurrent-1.err" &
pid_one=$!
"$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -qAt -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres \
  -c "$CONCURRENT_SQL" >"$LOG_DIR/concurrent-2.out" 2>"$LOG_DIR/concurrent-2.err" &
pid_two=$!
wait "$pid_one"
wait "$pid_two"
sort "$LOG_DIR/concurrent-1.out" "$LOG_DIR/concurrent-2.out" >"$LOG_DIR/concurrent.out"
if [[ "$(tr '\n' ' ' <"$LOG_DIR/concurrent.out")" != 'created replayed ' ]]; then
  cat "$LOG_DIR/concurrent.out" >&2
  exit 1
fi
assert_scalar '1|1' \
  "SELECT (SELECT count(*) FROM public.post_media_claim_sets WHERE scope='post_create' AND operation_id='$CONCURRENT_OP') || '|' ||
          (SELECT count(*) FROM public.stub_create_ledger WHERE operation_id='$CONCURRENT_OP')"

# Distinct operations overlap after their old authorities, then serialize on
# the shared upload-id/object locks. Reversed caller manifests normalize to one
# lock order: both finish, each upload has two target claims, and no timeout or
# deadlock/unique error leaks.
CONTENDED_OP_A='46000000-0000-4000-8000-000000000001'
CONTENDED_OP_B='46000000-0000-4000-8000-000000000002'
CONTENDED_SQL_A="SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
  '$OWNER','$CONTENDED_OP_A','contended a','body',NULL,ARRAY['$IMAGE_URL','$SECOND_URL'],
  false,NULL,NULL,NULL,'public',false,NULL,'en',ARRAY[]::text[],ARRAY[]::text[],
  ARRAY['$IMAGE_NAME','$SECOND_NAME'],'$STORAGE_ORIGIN')->>'status';"
CONTENDED_SQL_B="SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
  '$OWNER','$CONTENDED_OP_B','contended b','body',NULL,ARRAY['$SECOND_URL','$IMAGE_URL'],
  false,NULL,NULL,NULL,'public',false,NULL,'en',ARRAY[]::text[],ARRAY[]::text[],
  ARRAY['$SECOND_NAME','$IMAGE_NAME'],'$STORAGE_ORIGIN')->>'status';"
# A third backend owns the first canonical upload advisory. Both wrapper
# backends must finish their legacy writes and visibly queue on that exact key
# before it is released; this makes overlap an executable fact, not timing.
PGAPPNAME=media_claim_lock_holder "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -qAt \
  -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres \
  -c "BEGIN; SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('post-media-upload-id:$IMAGE_ID',0)); SELECT pg_catalog.pg_sleep(30); COMMIT;" \
  >"$LOG_DIR/contended-holder.out" 2>"$LOG_DIR/contended-holder.err" &
holder_pid=$!
holder_ready=false
for _ in {1..100}; do
  if [[ "$(psql_cmd -At -c "WITH lock_key AS (SELECT pg_catalog.hashtextextended('post-media-upload-id:$IMAGE_ID',0)::bigint AS value) SELECT count(*) FROM pg_catalog.pg_locks AS held JOIN pg_catalog.pg_stat_activity AS activity USING (pid) CROSS JOIN lock_key WHERE activity.application_name='media_claim_lock_holder' AND held.locktype='advisory' AND held.classid::bigint=((lock_key.value >> 32) & 4294967295) AND held.objid::bigint=(lock_key.value & 4294967295) AND held.objsubid=1 AND held.granted")" == '1' ]]; then
    holder_ready=true
    break
  fi
  sleep 0.02
done
if [[ "$holder_ready" != true ]]; then
  cat "$LOG_DIR/contended-holder.err" >&2
  kill "$holder_pid" 2>/dev/null || true
  exit 1
fi
"$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -qAt -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres \
  -c "$CONTENDED_SQL_A" >"$LOG_DIR/contended-a.out" 2>"$LOG_DIR/contended-a.err" &
pid_one=$!
"$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -qAt -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres \
  -c "$CONTENDED_SQL_B" >"$LOG_DIR/contended-b.out" 2>"$LOG_DIR/contended-b.err" &
pid_two=$!
waiters_ready=false
for _ in {1..200}; do
  if [[ "$(psql_cmd -At -c "WITH lock_key AS (SELECT pg_catalog.hashtextextended('post-media-upload-id:$IMAGE_ID',0)::bigint AS value) SELECT count(*) FROM pg_catalog.pg_locks AS waiting CROSS JOIN lock_key WHERE waiting.locktype='advisory' AND waiting.classid::bigint=((lock_key.value >> 32) & 4294967295) AND waiting.objid::bigint=(lock_key.value & 4294967295) AND waiting.objsubid=1 AND NOT waiting.granted")" == '2' ]]; then
    waiters_ready=true
    break
  fi
  sleep 0.02
done
if [[ "$waiters_ready" != true ]]; then
  cat "$LOG_DIR/contended-a.err" "$LOG_DIR/contended-b.err" >&2
  psql_cmd -At -c "SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE application_name='media_claim_lock_holder' AND pid<>pg_catalog.pg_backend_pid()" >/dev/null || true
  wait "$holder_pid" 2>/dev/null || true
  exit 1
fi
psql_cmd -At -c "SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE application_name='media_claim_lock_holder' AND pid<>pg_catalog.pg_backend_pid()" >/dev/null
wait "$holder_pid" 2>/dev/null || true
wait "$pid_one"
wait "$pid_two"
sort "$LOG_DIR/contended-a.out" "$LOG_DIR/contended-b.out" >"$LOG_DIR/contended.out"
if [[ "$(tr '\n' ' ' <"$LOG_DIR/contended.out")" != 'created created ' ]]; then
  cat "$LOG_DIR/contended-a.err" "$LOG_DIR/contended-b.err" >&2
  cat "$LOG_DIR/contended.out" >&2
  exit 1
fi
if rg -q '40P01|55P03|57014|23505' \
    "$LOG_DIR/contended-a.err" "$LOG_DIR/contended-b.err"; then
  cat "$LOG_DIR/contended-a.err" "$LOG_DIR/contended-b.err" >&2
  exit 1
fi
assert_scalar '2|2|2' \
  "SELECT
    (SELECT count(*) FROM public.post_media_claim_sets WHERE operation_id IN ('$CONTENDED_OP_A','$CONTENDED_OP_B')) || '|' ||
    (SELECT count(*) FROM public.post_media_claims WHERE upload_id='$IMAGE_ID' AND first_claim_operation_id IN ('$CONTENDED_OP_A','$CONTENDED_OP_B')) || '|' ||
    (SELECT count(*) FROM public.post_media_claims WHERE upload_id='$SECOND_ID' AND first_claim_operation_id IN ('$CONTENDED_OP_A','$CONTENDED_OP_B'))"

# Runtime and migration table locks share the same business->registry->claim
# topology. A holder stops the wrapper at the legacy authority advisory before
# any business write. The wrapper must have zero claim-relation locks while it
# waits. Its shared migration advisory makes replay fail immediately with a
# controlled 55P03 instead of entering a table-lock cycle; after the wrapper
# commits, the exact migration replay succeeds.
MIGRATION_RUNTIME_OP='47000000-0000-4000-8000-000000000001'
MIGRATION_RUNTIME_SQL="SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.create_post_with_media_claims_atomic(
  '$OWNER','$MIGRATION_RUNTIME_OP','migration lock runtime','body',NULL,
  ARRAY[]::text[],false,NULL,NULL,NULL,'public',false,NULL,'en',
  ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],'$STORAGE_ORIGIN')->>'status';"
PGAPPNAME=media_claim_legacy_holder "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -qAt \
  -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres \
  -c "BEGIN; SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('stub-create:$MIGRATION_RUNTIME_OP',0)); SELECT pg_catalog.pg_sleep(30); COMMIT;" \
  >"$LOG_DIR/migration-holder.out" 2>"$LOG_DIR/migration-holder.err" &
holder_pid=$!
holder_ready=false
for _ in {1..100}; do
  if [[ "$(psql_cmd -At -c "SELECT count(*) FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_stat_activity a USING(pid) WHERE a.application_name='media_claim_legacy_holder' AND l.locktype='advisory' AND l.granted")" == '1' ]]; then
    holder_ready=true
    break
  fi
  sleep 0.02
done
if [[ "$holder_ready" != true ]]; then
  cat "$LOG_DIR/migration-holder.err" >&2
  kill "$holder_pid" 2>/dev/null || true
  exit 1
fi
PGAPPNAME=media_claim_runtime "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -qAt \
  -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres \
  -c "$MIGRATION_RUNTIME_SQL" \
  >"$LOG_DIR/migration-runtime.out" 2>"$LOG_DIR/migration-runtime.err" &
runtime_pid=$!
runtime_waiting=false
for _ in {1..200}; do
  if [[ "$(psql_cmd -At -c "WITH global_key AS (SELECT pg_catalog.hashtextextended('public-post-media-claims@1',0)::bigint AS value), runtime_locks AS (SELECT l.* FROM pg_catalog.pg_locks l JOIN pg_catalog.pg_stat_activity a USING(pid) WHERE a.application_name='media_claim_runtime') SELECT (SELECT count(*) FROM runtime_locks WHERE locktype='advisory' AND NOT granted) || '|' || (SELECT count(*) FROM runtime_locks WHERE locktype='relation' AND relation IN ('public.post_media_claim_sets'::regclass,'public.post_media_claims'::regclass)) || '|' || (SELECT count(*) FROM runtime_locks CROSS JOIN global_key WHERE locktype='advisory' AND mode='ShareLock' AND granted AND classid::bigint=((global_key.value >> 32) & 4294967295) AND objid::bigint=(global_key.value & 4294967295) AND objsubid=1)")" == '1|0|1' ]]; then
    runtime_waiting=true
    break
  fi
  sleep 0.02
done
if [[ "$runtime_waiting" != true ]]; then
  cat "$LOG_DIR/migration-runtime.err" >&2
  psql_cmd -At -c "SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE application_name='media_claim_legacy_holder' AND pid<>pg_catalog.pg_backend_pid()" >/dev/null || true
  wait "$holder_pid" 2>/dev/null || true
  kill "$runtime_pid" 2>/dev/null || true
  exit 1
fi
expect_migration_failure_matching active_runtime_migration_lock \
  '55P03.*post media claims migration lock is busy'
psql_cmd -At -c "SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE application_name='media_claim_legacy_holder' AND pid<>pg_catalog.pg_backend_pid()" >/dev/null
wait "$holder_pid" 2>/dev/null || true
wait "$runtime_pid"
if [[ "$(tr -d '\n' <"$LOG_DIR/migration-runtime.out")" != 'created' ]]; then
  cat "$LOG_DIR/migration-runtime.out" >&2
  exit 1
fi
if rg -q '40P01|55P03|57014|23505' "$LOG_DIR/migration-runtime.err"; then
  cat "$LOG_DIR/migration-runtime.err" >&2
  exit 1
fi
assert_scalar '1|1' \
  "SELECT (SELECT count(*) FROM public.stub_create_ledger WHERE operation_id='$MIGRATION_RUNTIME_OP') || '|' || (SELECT count(*) FROM public.post_media_claim_sets WHERE operation_id='$MIGRATION_RUNTIME_OP')"
psql_cmd -f "$CLAIM_MIGRATION"

# One-table/five-function state is partial and must fail before replacing any
# public authority or altering the surviving table.
psql_cmd -c "ALTER TABLE public.post_media_claims RENAME TO post_media_claims_partial"
expect_migration_failure_matching partial_table_publication 'post media claim table publication is partial'
assert_scalar 'true|5' \
  "SELECT (pg_catalog.to_regclass('public.post_media_claim_sets') IS NOT NULL)::text || '|' ||
          (SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('claim_post_media_manifest_internal','create_post_with_media_claims_atomic','edit_post_with_media_claims_atomic','submit_group_application_with_media_claims_atomic','review_group_application_with_media_claims_atomic'))"
psql_cmd -c "ALTER TABLE public.post_media_claims_partial RENAME TO post_media_claims"
psql_cmd -f "$CLAIM_MIGRATION"

# Existing private ledgers fail closed on any ACL/policy drift: grants may have
# allowed forged rows before replay. The operator must restore authority before
# the exact publication can run again.
CLAIM_FINGERPRINT="$(psql_cmd -At -c "SELECT md5((SELECT string_agg(row(scope,operation_id,actor_id,target_kind,target_id,requested_revision,target_revision,manifest_fingerprint,intent_fingerprint,object_count,result,created_at)::text,'' ORDER BY scope,operation_id) FROM public.post_media_claim_sets) || '|' || (SELECT string_agg(row(upload_id,target_kind,target_id,reference_kind,first_claim_operation_id,first_seen_revision,last_seen_revision,claimed_at,updated_at)::text,'' ORDER BY upload_id,target_kind,target_id) FROM public.post_media_claims))")"
psql_cmd <<'SQL'
GRANT SELECT, UPDATE ON public.post_media_claim_sets TO hostile_claim_reader WITH GRANT OPTION;
GRANT SELECT (result), UPDATE (result)
  ON public.post_media_claim_sets TO hostile_claim_reader WITH GRANT OPTION;
GRANT SELECT, UPDATE ON public.post_media_claims TO hostile_claim_reader WITH GRANT OPTION;
GRANT SELECT (reference_kind), UPDATE (reference_kind)
  ON public.post_media_claims TO hostile_claim_reader WITH GRANT OPTION;
CREATE POLICY hostile_claim_policy ON public.post_media_claims
  FOR SELECT TO hostile_claim_reader USING (true);
SQL
expect_migration_failure_matching claim_acl_drift 'post media claim existing table contract is unsafe'
assert_scalar "$CLAIM_FINGERPRINT" \
  "SELECT md5((SELECT string_agg(row(scope,operation_id,actor_id,target_kind,target_id,requested_revision,target_revision,manifest_fingerprint,intent_fingerprint,object_count,result,created_at)::text,'' ORDER BY scope,operation_id) FROM public.post_media_claim_sets) || '|' || (SELECT string_agg(row(upload_id,target_kind,target_id,reference_kind,first_claim_operation_id,first_seen_revision,last_seen_revision,claimed_at,updated_at)::text,'' ORDER BY upload_id,target_kind,target_id) FROM public.post_media_claims))"
assert_scalar 'true|true|1' \
  "SELECT
    EXISTS (SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl WHERE c.oid='public.post_media_claim_sets'::regclass AND acl.grantee='hostile_claim_reader'::regrole) || '|' ||
    EXISTS (SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl WHERE c.oid='public.post_media_claims'::regclass AND acl.grantee='hostile_claim_reader'::regrole) || '|' ||
    (SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid='public.post_media_claims'::regclass)"
psql_cmd <<'SQL'
DROP POLICY hostile_claim_policy ON public.post_media_claims;
REVOKE ALL PRIVILEGES ON TABLE public.post_media_claim_sets
  FROM hostile_claim_reader CASCADE;
REVOKE SELECT (result), UPDATE (result)
  ON public.post_media_claim_sets FROM hostile_claim_reader CASCADE;
REVOKE ALL PRIVILEGES ON TABLE public.post_media_claims
  FROM hostile_claim_reader CASCADE;
REVOKE SELECT (reference_kind), UPDATE (reference_kind)
  ON public.post_media_claims FROM hostile_claim_reader CASCADE;
SQL
psql_cmd -f "$CLAIM_MIGRATION"

# Registry ACL drift is different: service_role bypasses RLS, so revoking a
# leaked write grant cannot prove rows were not forged. Publication fails
# before trusting the registry, leaves data unchanged, and succeeds only after
# an operator explicitly restores the dependency ACL.
REGISTRY_FINGERPRINT="$(psql_cmd -At -c "SELECT md5(string_agg(row(upload_id,owner_id,object_name,purpose,mime_type,size_bytes,status,expires_at,created_at,updated_at,gc_admitted_at)::text, '' ORDER BY upload_id)) FROM public.post_media_uploads")"
psql_cmd <<'SQL'
GRANT SELECT, UPDATE ON public.post_media_uploads
  TO hostile_claim_reader WITH GRANT OPTION;
GRANT SELECT (object_name), UPDATE (status)
  ON public.post_media_uploads TO hostile_claim_reader WITH GRANT OPTION;
SQL
expect_migration_failure_matching registry_acl_drift 'post media upload registry dependency is unsafe'
assert_scalar "$REGISTRY_FINGERPRINT" \
  "SELECT md5(string_agg(row(upload_id,owner_id,object_name,purpose,mime_type,size_bytes,status,expires_at,created_at,updated_at,gc_admitted_at)::text, '' ORDER BY upload_id)) FROM public.post_media_uploads"
psql_cmd <<'SQL'
REVOKE ALL PRIVILEGES ON TABLE public.post_media_uploads
  FROM hostile_claim_reader CASCADE;
REVOKE SELECT (object_name), UPDATE (status)
  ON public.post_media_uploads FROM hostile_claim_reader CASCADE;
SQL
psql_cmd -f "$CLAIM_MIGRATION"
assert_scalar '0|0' \
  "SELECT
    (SELECT count(*) FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) acl WHERE c.oid='public.post_media_uploads'::regclass AND acl.grantee<>c.relowner) || '|' ||
    (SELECT count(*) FROM pg_catalog.pg_attribute a CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) acl WHERE a.attrelid='public.post_media_uploads'::regclass AND a.attnum>0 AND acl.grantee<>'postgres'::regrole)"

# Published authority drift is never silently healed on replay. A leaked
# executable grant remains visible after the failed migration until an
# operator revokes it explicitly.
psql_cmd -c "GRANT EXECUTE ON FUNCTION public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb) TO hostile_claim_reader WITH GRANT OPTION"
expect_migration_failure_matching publication_acl_drift 'post media claim publication is partial or unsafe'
assert_scalar 't' \
  "SELECT pg_catalog.bool_or(acl.is_grantable) FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl WHERE p.oid='public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb)'::regprocedure AND acl.grantee='hostile_claim_reader'::regrole AND acl.privilege_type='EXECUTE'"
psql_cmd -c "REVOKE ALL ON FUNCTION public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb) FROM hostile_claim_reader CASCADE"
psql_cmd -f "$CLAIM_MIGRATION"

# The source seal is a fixed reviewed literal, not a self-seal. Updating both
# prosrc and COMMENT to a hostile matching md5 still fails before CREATE OR
# REPLACE and leaves the hostile bytes untouched for operator inspection.
psql_cmd <<'SQL'
UPDATE pg_catalog.pg_proc
SET prosrc = prosrc || E'\n-- hostile synchronized publication source'
WHERE oid = 'public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb)'::regprocedure;
SELECT pg_catalog.format(
  'COMMENT ON FUNCTION public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb) IS %L',
  'post-media-claims:internal-v1:' || pg_catalog.md5(prosrc)
)
FROM pg_catalog.pg_proc
WHERE oid = 'public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb)'::regprocedure
\gexec
SQL
expect_migration_failure_matching publication_synchronized_source_drift 'post media claim publication is partial or unsafe'
assert_scalar 'true|true' \
  "SELECT (pg_catalog.strpos(prosrc,'hostile synchronized publication source')>0)::text || '|' || (pg_catalog.obj_description(oid,'pg_proc')='post-media-claims:internal-v1:'||pg_catalog.md5(prosrc))::text FROM pg_catalog.pg_proc WHERE oid='public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb)'::regprocedure"
psql_cmd <<'SQL'
UPDATE pg_catalog.pg_proc
SET prosrc = pg_catalog.left(
  prosrc,
  pg_catalog.length(prosrc) -
    pg_catalog.length(E'\n-- hostile synchronized publication source')
)
WHERE oid = 'public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb)'::regprocedure;
COMMENT ON FUNCTION public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb)
  IS 'post-media-claims:internal-v1:16ce55b402e98e4decb1e044dcd2f881';
SQL
psql_cmd -f "$CLAIM_MIGRATION"

# A changed PostgREST-visible default is part of the function identity even
# when signature, source and comment stay byte-identical. Copying a hostile
# pg_node_tree from a same-shaped template gives a deterministic catalog drift
# and a canonical template restores it after the fail-closed proof.
psql_cmd <<'SQL'
CREATE FUNCTION public.hostile_review_defaults(
  p_reviewer_id uuid, p_application_id uuid, p_decision text,
  p_reject_reason text DEFAULT NULL, p_promo_unlocked boolean DEFAULT false,
  p_operation_id uuid DEFAULT NULL,
  p_storage_origin text DEFAULT 'https://drift.test'::text
) RETURNS jsonb LANGUAGE sql AS $function$ SELECT '{}'::jsonb $function$;
CREATE FUNCTION public.canonical_review_defaults(
  p_reviewer_id uuid, p_application_id uuid, p_decision text,
  p_reject_reason text DEFAULT NULL, p_promo_unlocked boolean DEFAULT false,
  p_operation_id uuid DEFAULT NULL, p_storage_origin text DEFAULT NULL::text
) RETURNS jsonb LANGUAGE sql AS $function$ SELECT '{}'::jsonb $function$;
UPDATE pg_catalog.pg_proc AS target
SET proargdefaults = source.proargdefaults
FROM pg_catalog.pg_proc AS source
WHERE target.oid = 'public.review_group_application_with_media_claims_atomic(uuid,uuid,text,text,boolean,uuid,text)'::regprocedure
  AND source.oid = 'public.hostile_review_defaults(uuid,uuid,text,text,boolean,uuid,text)'::regprocedure;
SQL
expect_migration_failure_matching publication_default_drift 'post media claim publication is partial or unsafe'
assert_scalar 'true' \
  "SELECT (pg_catalog.md5(pg_catalog.pg_get_function_arguments(oid))<>'7f94fd69c3a26b14e14ebbd49ecda2dd')::text FROM pg_catalog.pg_proc WHERE oid='public.review_group_application_with_media_claims_atomic(uuid,uuid,text,text,boolean,uuid,text)'::regprocedure"
psql_cmd <<'SQL'
UPDATE pg_catalog.pg_proc AS target
SET proargdefaults = source.proargdefaults
FROM pg_catalog.pg_proc AS source
WHERE target.oid = 'public.review_group_application_with_media_claims_atomic(uuid,uuid,text,text,boolean,uuid,text)'::regprocedure
  AND source.oid = 'public.canonical_review_defaults(uuid,uuid,text,text,boolean,uuid,text)'::regprocedure;
DROP FUNCTION public.hostile_review_defaults(uuid,uuid,text,text,boolean,uuid,text);
DROP FUNCTION public.canonical_review_defaults(uuid,uuid,text,text,boolean,uuid,text);
SQL
psql_cmd -f "$CLAIM_MIGRATION"

# FK constraint text does not encode its four internal RI triggers. Disabling
# the registry-side RESTRICT action triggers must therefore be detected by the
# dedicated trigger identity seal and must not be auto-enabled by replay.
psql_cmd -c "ALTER TABLE public.post_media_uploads DISABLE TRIGGER ALL"
expect_migration_failure_matching disabled_fk_trigger 'post media claim existing table contract is unsafe'
assert_scalar '2' \
  "SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_constraint c ON c.oid=t.tgconstraint WHERE c.conname='post_media_claims_upload_fkey' AND c.conrelid='public.post_media_claims'::regclass AND t.tgrelid='public.post_media_uploads'::regclass AND t.tgenabled='D'"
psql_cmd -c "ALTER TABLE public.post_media_uploads ENABLE TRIGGER ALL"
psql_cmd -f "$CLAIM_MIGRATION"

# IF NOT EXISTS never blesses hostile catalog drift. Each failed replay is one
# transaction, so existing claim data remains byte-for-byte present; restoring
# the reviewed catalog shape makes replay succeed again.
BASE_SET_COUNT="$(psql_cmd -At -c 'SELECT count(*) FROM public.post_media_claim_sets')"
psql_cmd -c "ALTER TABLE public.post_media_claim_sets ALTER COLUMN result SET STORAGE PLAIN"
expect_migration_failure_matching claim_storage_drift 'post media claim existing table contract is unsafe'
psql_cmd -c "ALTER TABLE public.post_media_claim_sets ALTER COLUMN result SET STORAGE EXTENDED"
psql_cmd -f "$CLAIM_MIGRATION"

psql_cmd -c "ALTER TABLE public.post_media_claim_sets ADD CONSTRAINT hostile_claim_check CHECK (true)"
expect_migration_failure_matching claim_extra_constraint 'post media claim existing table contract is unsafe'
psql_cmd -c "ALTER TABLE public.post_media_claim_sets DROP CONSTRAINT hostile_claim_check"

psql_cmd -c "ALTER TABLE public.post_media_claim_sets ALTER COLUMN actor_id SET DEFAULT pg_catalog.gen_random_uuid()"
expect_migration_failure_matching claim_default_drift 'post media claim existing table contract is unsafe'
psql_cmd -c "ALTER TABLE public.post_media_claim_sets ALTER COLUMN actor_id DROP DEFAULT"

psql_cmd -c "ALTER TABLE public.post_media_claim_sets ALTER COLUMN result DROP NOT NULL"
expect_migration_failure_matching claim_nullability_drift 'post media claim existing table contract is unsafe'
psql_cmd -c "ALTER TABLE public.post_media_claim_sets ALTER COLUMN result SET NOT NULL"

psql_cmd -c "CREATE INDEX hostile_claim_extra_idx ON public.post_media_claims(updated_at)"
expect_migration_failure_matching claim_extra_index 'post media claim existing table contract is unsafe'
psql_cmd -c "DROP INDEX public.hostile_claim_extra_idx"
assert_scalar "$BASE_SET_COUNT" "SELECT count(*) FROM public.post_media_claim_sets"

# The exact 1100 dependency is re-attested: extra constraints/indexes, even a
# disabled user trigger, source-seal drift, and unknown authority overloads all
# fail before any new authority can be republished.
psql_cmd -c "ALTER TABLE public.post_media_uploads ADD CONSTRAINT hostile_registry_check CHECK (true)"
expect_migration_failure_matching registry_constraint_drift 'post media upload registry dependency is unsafe'
psql_cmd -c "ALTER TABLE public.post_media_uploads DROP CONSTRAINT hostile_registry_check"

psql_cmd -c "CREATE INDEX hostile_registry_extra_idx ON public.post_media_uploads(updated_at)"
expect_migration_failure_matching registry_index_drift 'post media upload registry dependency is unsafe'
psql_cmd -c "DROP INDEX public.hostile_registry_extra_idx"

psql_cmd <<'SQL'
CREATE FUNCTION public.hostile_registry_trigger()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RETURN NEW;
END
$function$;
CREATE TRIGGER hostile_registry_trigger
AFTER INSERT ON public.post_media_uploads
FOR EACH ROW EXECUTE FUNCTION public.hostile_registry_trigger();
ALTER TABLE public.post_media_uploads DISABLE TRIGGER hostile_registry_trigger;
SQL
expect_migration_failure_matching registry_trigger_drift 'post media upload registry dependency is unsafe'
psql_cmd -c "DROP TRIGGER hostile_registry_trigger ON public.post_media_uploads"
psql_cmd -c "DROP FUNCTION public.hostile_registry_trigger()"

psql_cmd <<'SQL'
UPDATE pg_catalog.pg_proc
SET prosrc=prosrc || E'\n-- hostile synchronized registry source'
WHERE oid='public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)'::regprocedure;
SELECT pg_catalog.format(
  'COMMENT ON FUNCTION public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint) IS %L',
  'post-media-upload-registry:reserve-v1:' || pg_catalog.md5(prosrc)
)
FROM pg_catalog.pg_proc
WHERE oid='public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)'::regprocedure
\gexec
SQL
expect_migration_failure_matching registry_source_drift 'post media upload registry dependency is unsafe'
assert_scalar 'true|true' \
  "SELECT (pg_catalog.strpos(prosrc,'hostile synchronized registry source')>0)::text || '|' || (pg_catalog.obj_description(oid,'pg_proc')='post-media-upload-registry:reserve-v1:'||pg_catalog.md5(prosrc))::text FROM pg_catalog.pg_proc WHERE oid='public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)'::regprocedure"
psql_cmd <<'SQL'
UPDATE pg_catalog.pg_proc
SET prosrc=pg_catalog.left(
  prosrc,
  pg_catalog.length(prosrc)-
    pg_catalog.length(E'\n-- hostile synchronized registry source')
)
WHERE oid='public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)'::regprocedure;
COMMENT ON FUNCTION public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)
  IS 'post-media-upload-registry:reserve-v1:56e6f09a800136a55e4249b2cf1ba9c4';
SQL

psql_cmd <<'SQL'
CREATE FUNCTION public.create_post_atomic(p_unknown integer)
RETURNS jsonb LANGUAGE sql VOLATILE
AS $function$ SELECT pg_catalog.jsonb_build_object('status','hostile') $function$;
REVOKE ALL ON FUNCTION public.create_post_atomic(integer) FROM PUBLIC;
SQL
expect_migration_failure_matching unknown_atomic_overload 'composed post media claim authority is unsafe'
psql_cmd -c "DROP FUNCTION public.create_post_atomic(integer)"

# The complete PostgreSQL 17 membership graph is checked on every replay.
psql_cmd -c "REVOKE service_role FROM authenticator"
expect_migration_failure_matching missing_authenticator_edge 'post media claim role graph is unsafe'
psql_cmd -c "GRANT service_role TO authenticator WITH INHERIT FALSE, SET TRUE"

psql_cmd -c "GRANT service_role TO hostile_claim_reader WITH INHERIT FALSE, SET TRUE, ADMIN FALSE"
expect_migration_failure_matching unknown_set_member 'post media claim role graph is unsafe'
psql_cmd -c "REVOKE service_role FROM hostile_claim_reader"

psql_cmd -c "GRANT service_role TO hostile_claim_reader WITH INHERIT FALSE, SET FALSE, ADMIN TRUE"
expect_migration_failure_matching unknown_admin_member 'post media claim role graph is unsafe'
psql_cmd -c "REVOKE service_role FROM hostile_claim_reader"

psql_cmd -f "$CLAIM_MIGRATION"
assert_scalar "$BASE_SET_COUNT" "SELECT count(*) FROM public.post_media_claim_sets"

# ADD/DROP leaves a physical pg_attribute tombstone that IF NOT EXISTS cannot
# repair. The exact replay refuses that irreversible operator drift while
# preserving every authoritative row; this ephemeral database is discarded
# immediately after the proof.
psql_cmd -c "ALTER TABLE public.post_media_claim_sets ADD COLUMN hostile_tombstone text"
psql_cmd -c "ALTER TABLE public.post_media_claim_sets DROP COLUMN hostile_tombstone"
expect_migration_failure_matching claim_dropped_tombstone \
  'post media claim existing table contract is unsafe'
assert_scalar "1|$BASE_SET_COUNT" \
  "SELECT (SELECT count(*) FROM pg_catalog.pg_attribute WHERE attrelid='public.post_media_claim_sets'::regclass AND attnum>0 AND attisdropped) || '|' || (SELECT count(*) FROM public.post_media_claim_sets)"

echo 'post media claims PostgreSQL 17 integration proof passed'
