#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
COVERAGE_MIGRATION="$ROOT_DIR/supabase/migrations/20260803112000_post_media_coverage_inventory.sql"
REGISTRY_MIGRATION="$ROOT_DIR/supabase/migrations/20260803110000_post_media_upload_registry.sql"
CLAIM_MIGRATION="$ROOT_DIR/supabase/migrations/20260803111000_post_media_claims.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/post-media-coverage-pg17.XXXXXX)"
PGDATA="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT="$((58200 + ($$ % 200)))"

cleanup() {
  local rc=$?
  if ((rc != 0)) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if [[ -s "$PGDATA/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$PGDATA" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  find "$TMP_ROOT" -depth -delete 2>/dev/null || true
  return "$rc"
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
    "SET ROLE service_role; SET request.jwt.claim.role='service_role'; $query"
}

wait_for_scalar() {
  local expected="$1"
  local query="$2"
  local label="$3"
  local actual=''
  for _ in {1..500}; do
    actual="$(psql_cmd -At -c "$query")"
    if [[ "$actual" == "$expected" ]]; then
      return 0
    fi
    sleep 0.01
  done
  echo "Timed out waiting for $label: expected '$expected', got '$actual'" >&2
  return 1
}

service_sql() {
  psql_cmd -At -c \
    "SET ROLE service_role; SET request.jwt.claim.role='service_role'; $1"
}

expect_failure_matching() {
  local label="$1"
  local pattern="$2"
  local sql="$3"
  local log="$LOG_DIR/$label.log"
  if psql_cmd -v VERBOSITY=verbose -c "$sql" >"$log" 2>&1; then
    echo "Expected failure: $label" >&2
    return 1
  fi
  if ! rg -q "$pattern" "$log"; then
    echo "Failure did not match '$pattern': $label" >&2
    cat "$log" >&2
    return 1
  fi
}

expect_migration_failure_matching() {
  local label="$1"
  local pattern="$2"
  local log="$LOG_DIR/$label.log"
  if psql_cmd -v VERBOSITY=verbose -f "$COVERAGE_MIGRATION" >"$log" 2>&1; then
    echo "Expected migration failure: $label" >&2
    return 1
  fi
  if ! rg -q "$pattern" "$log"; then
    echo "Migration failure did not match '$pattern': $label" >&2
    cat "$log" >&2
    return 1
  fi
}

source_hashes() {
  psql_cmd -At -F '|' -c \
    "SELECT
      md5(COALESCE((SELECT string_agg(row_to_json(p)::text,',' ORDER BY id) FROM public.posts p),'')),
      md5(COALESCE((SELECT string_agg(row_to_json(a)::text,',' ORDER BY id) FROM public.group_applications a),'')),
      md5(COALESCE((SELECT string_agg(row_to_json(g)::text,',' ORDER BY id) FROM public.groups g),'')),
      md5(COALESCE((SELECT string_agg(row_to_json(u)::text,',' ORDER BY upload_id) FROM public.post_media_uploads u),'')),
      md5(COALESCE((SELECT string_agg(row_to_json(s)::text,',' ORDER BY scope,operation_id) FROM public.post_media_claim_sets s),'')),
      md5(COALESCE((SELECT string_agg(row_to_json(c)::text,',' ORDER BY upload_id,target_kind,target_id) FROM public.post_media_claims c),'')),
      md5(COALESCE((SELECT string_agg(row_to_json(o)::text,',' ORDER BY bucket_id,name) FROM storage.objects o),''));"
}

enqueue_to_reconciling() {
  local run_id="$1"
  local limit="${2:-7}"
  local state
  for _ in {1..200}; do
    state="$(assert_service_query_state "$run_id" "$limit")"
    if [[ "$state" == 'reconciling' ]]; then
      return 0
    fi
  done
  echo "enqueue did not reach reconciling: $run_id" >&2
  return 1
}

assert_service_query_state() {
  local run_id="$1"
  local limit="$2"
  service_sql "SELECT public.enqueue_post_media_coverage_inventory_atomic('$run_id',$limit)->>'state';"
}

observe_to_idle() {
  local run_id="$1"
  local observed
  for _ in {1..200}; do
    observed="$(service_sql "SELECT public.observe_post_media_coverage_inventory_atomic('$run_id',25)->>'observed';")"
    if [[ "$observed" == '0' ]]; then
      return 0
    fi
  done
  echo "observe did not become idle: $run_id" >&2
  return 1
}

seal_to_sealed() {
  local run_id="$1"
  local limit="${2:-7}"
  local status
  for _ in {1..500}; do
    status="$(service_sql "SELECT public.seal_post_media_coverage_inventory_atomic('$run_id',$limit)->>'status';")"
    if [[ "$status" == 'sealed' ]]; then
      return 0
    fi
    if [[ "$status" != 'reconciling' ]]; then
      echo "seal returned unexpected status '$status': $run_id" >&2
      return 1
    fi
  done
  echo "seal did not reach sealed: $run_id" >&2
  return 1
}

install_reviewed_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v marker="CREATE OR REPLACE FUNCTION public.$function_name(" '
    index($0,marker) { found=1 }
    found { print }
    found && $0=="$function$;" { exit }
  ' "$source_file" | psql_cmd
}

# Exact minimal 1100/1110 evidence dependencies. Those migrations have their
# own full PG17 proofs; this proof isolates the 1120 publication and runtime.
psql_cmd <<'SQL'
CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE authenticator NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
CREATE ROLE hostile_reader NOLOGIN NOINHERIT;
GRANT service_role TO authenticator WITH INHERIT FALSE, SET TRUE;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.role()
RETURNS text LANGUAGE sql STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role',true),'')
$function$;

CREATE SCHEMA storage AUTHORIZATION postgres;
CREATE TABLE storage.objects(
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  bucket_id text,
  name text,
  UNIQUE(bucket_id,name)
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE TYPE public.post_status AS ENUM ('draft','active','locked','deleted');
CREATE TABLE public.posts(
  id uuid PRIMARY KEY,
  author_id uuid,
  content text,
  images text[],
  content_version bigint NOT NULL,
  deleted_at timestamptz,
  status public.post_status NOT NULL DEFAULT 'active'
);
CREATE TABLE public.group_applications(
  id uuid PRIMARY KEY,
  applicant_id uuid NOT NULL,
  avatar_url text,
  status text NOT NULL,
  group_id uuid
);
CREATE TABLE public.groups(
  id uuid PRIMARY KEY,
  created_by uuid NOT NULL,
  avatar_url text
);
ALTER TABLE public.group_applications
  ADD CONSTRAINT group_applications_group_fkey FOREIGN KEY (group_id)
  REFERENCES public.groups(id) ON UPDATE RESTRICT ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS public.post_media_uploads (
  upload_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  object_name text NOT NULL,
  purpose text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  status text NOT NULL DEFAULT 'reserved',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  gc_admitted_at timestamptz,
  CONSTRAINT post_media_uploads_pkey PRIMARY KEY (upload_id),
  CONSTRAINT post_media_uploads_object_name_key UNIQUE (object_name),
  CONSTRAINT post_media_uploads_purpose_check CHECK (
    purpose IN ('post_image', 'post_video', 'group_avatar', 'legacy_image')
  ),
  CONSTRAINT post_media_uploads_status_check CHECK (
    status IN ('reserved', 'uploaded')
  ),
  CONSTRAINT post_media_uploads_object_name_check CHECK (
    object_name = pg_catalog.btrim(object_name)
    AND pg_catalog.octet_length(object_name) BETWEEN 1 AND 512
    AND object_name !~ '[[:cntrl:]]'
    AND object_name !~ '(^/|/$|//|(^|/)\.{1,2}(/|$))'
  ),
  CONSTRAINT post_media_uploads_media_check CHECK (
    (
      purpose IN ('post_image', 'group_avatar', 'legacy_image')
      AND object_name ~ (
        '^' || pg_catalog.lower(owner_id::text)
          || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
          || '\.(jpg|png|gif|webp|avif)$'
      )
      AND mime_type IN (
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/avif'
      )
      AND (
        (mime_type = 'image/jpeg' AND pg_catalog.right(object_name, 4) = '.jpg')
        OR (mime_type = 'image/png' AND pg_catalog.right(object_name, 4) = '.png')
        OR (mime_type = 'image/gif' AND pg_catalog.right(object_name, 4) = '.gif')
        OR (mime_type = 'image/webp' AND pg_catalog.right(object_name, 5) = '.webp')
        OR (mime_type = 'image/avif' AND pg_catalog.right(object_name, 5) = '.avif')
      )
      AND size_bytes BETWEEN 1 AND 5242880
    ) OR (
      purpose = 'post_video'
      AND object_name ~ (
        '^' || pg_catalog.lower(owner_id::text)
          || '/videos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
          || '\.(mp4|mov|webm|mkv|avi)$'
      )
      AND mime_type IN (
        'video/mp4',
        'video/quicktime',
        'video/webm',
        'video/x-matroska',
        'video/x-msvideo'
      )
      AND (
        (mime_type = 'video/mp4' AND pg_catalog.right(object_name, 4) = '.mp4')
        OR (mime_type = 'video/quicktime' AND pg_catalog.right(object_name, 4) = '.mov')
        OR (mime_type = 'video/webm' AND pg_catalog.right(object_name, 5) = '.webm')
        OR (mime_type = 'video/x-matroska' AND pg_catalog.right(object_name, 4) = '.mkv')
        OR (mime_type = 'video/x-msvideo' AND pg_catalog.right(object_name, 4) = '.avi')
      )
      AND size_bytes BETWEEN 1 AND 104857600
    )
  ),
  CONSTRAINT post_media_uploads_lifecycle_check CHECK (
    pg_catalog.isfinite(expires_at)
    AND pg_catalog.isfinite(created_at)
    AND pg_catalog.isfinite(updated_at)
    AND expires_at > created_at
    AND updated_at >= created_at
    AND gc_admitted_at IS NULL
  )
);

ALTER TABLE public.post_media_uploads OWNER TO postgres;
ALTER TABLE public.post_media_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_media_uploads FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS post_media_uploads_expiry_idx
  ON public.post_media_uploads (status, expires_at, upload_id);


CREATE TABLE IF NOT EXISTS public.post_media_claim_sets (
  scope text NOT NULL,
  operation_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  requested_revision bigint,
  target_revision bigint,
  manifest_fingerprint text NOT NULL,
  intent_fingerprint text NOT NULL,
  object_count integer NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT post_media_claim_sets_pkey PRIMARY KEY (scope, operation_id),
  CONSTRAINT post_media_claim_sets_scope_check CHECK (
    scope IN ('post_create', 'post_edit', 'group_submit', 'group_review')
  ),
  CONSTRAINT post_media_claim_sets_target_check CHECK (
    (
      scope = 'post_create'
      AND target_kind = 'post'
      AND requested_revision IS NULL
      AND target_revision IS NOT NULL
      AND target_revision = 0
    ) OR (
      scope = 'post_edit'
      AND target_kind = 'post'
      AND requested_revision IS NOT NULL
      AND target_revision IS NOT NULL
      AND requested_revision >= 0
      AND target_revision >= requested_revision
    ) OR (
      scope = 'group_submit'
      AND target_kind = 'group_application'
      AND requested_revision IS NULL
      AND target_revision IS NULL
    ) OR (
      scope = 'group_review'
      AND target_kind IN ('group_application', 'group')
      AND requested_revision IS NULL
      AND target_revision IS NULL
    )
  ),
  CONSTRAINT post_media_claim_sets_manifest_check CHECK (
    manifest_fingerprint ~ '^[0-9a-f]{64}$'
    AND intent_fingerprint ~ '^[0-9a-f]{64}$'
    AND object_count BETWEEN 0 AND 64
  ),
  CONSTRAINT post_media_claim_sets_result_check CHECK (
    pg_catalog.jsonb_typeof(result) = 'object'
    AND pg_catalog.pg_column_size(result) BETWEEN 2 AND 262144
    AND result ? 'status'
    AND pg_catalog.jsonb_typeof(result -> 'status') = 'string'
  ),
  CONSTRAINT post_media_claim_sets_created_at_check CHECK (
    pg_catalog.isfinite(created_at)
  )
) USING heap;

CREATE TABLE IF NOT EXISTS public.post_media_claims (
  upload_id uuid NOT NULL,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  reference_kind text NOT NULL,
  first_claim_operation_id uuid NOT NULL,
  first_seen_revision bigint,
  last_seen_revision bigint,
  claimed_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT post_media_claims_pkey
    PRIMARY KEY (upload_id, target_kind, target_id),
  CONSTRAINT post_media_claims_upload_fkey FOREIGN KEY (upload_id)
    REFERENCES public.post_media_uploads(upload_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT post_media_claims_target_check CHECK (
    target_kind IN ('post', 'group_application', 'group')
    AND (
      (
        target_kind = 'post'
        AND reference_kind IN ('post_image', 'post_video')
        AND first_seen_revision IS NOT NULL
        AND last_seen_revision IS NOT NULL
        AND first_seen_revision >= 0
        AND last_seen_revision >= first_seen_revision
      ) OR (
        target_kind IN ('group_application', 'group')
        AND reference_kind = 'group_avatar'
        AND first_seen_revision IS NULL
        AND last_seen_revision IS NULL
      )
    )
  ),
  CONSTRAINT post_media_claims_time_check CHECK (
    pg_catalog.isfinite(claimed_at)
    AND pg_catalog.isfinite(updated_at)
    AND updated_at >= claimed_at
  )
) USING heap;

ALTER TABLE public.post_media_claim_sets OWNER TO postgres;
ALTER TABLE public.post_media_claim_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_media_claim_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE public.post_media_claims OWNER TO postgres;
ALTER TABLE public.post_media_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_media_claims FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS post_media_claim_sets_target_idx
  ON public.post_media_claim_sets (
    target_kind, target_id, target_revision, scope, operation_id
  );
CREATE INDEX IF NOT EXISTS post_media_claims_target_idx
  ON public.post_media_claims (target_kind, target_id, upload_id);

-- Pin the complete PostgreSQL 17 catalog identity. IF NOT EXISTS must never
SQL

# Install the exact reviewed upstream authority bodies. The fixture builds the
# exact evidence tables above, while these definitions are taken byte-for-byte
# from the already-reviewed 1100/1110 migrations so fixed prosrc seals remain
# meaningful rather than blessing test stubs.
for function_name in reserve_post_media_upload_atomic finalize_post_media_upload_atomic; do
  install_reviewed_function "$REGISTRY_MIGRATION" "$function_name"
done
for function_name in claim_post_media_manifest_internal \
  create_post_with_media_claims_atomic edit_post_with_media_claims_atomic \
  submit_group_application_with_media_claims_atomic \
  review_group_application_with_media_claims_atomic; do
  install_reviewed_function "$CLAIM_MIGRATION" "$function_name"
done

psql_cmd <<'SQL'
REVOKE ALL ON FUNCTION public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint) FROM PUBLIC,service_role;
REVOKE ALL ON FUNCTION public.finalize_post_media_upload_atomic(uuid,uuid,text,text,text,bigint) FROM PUBLIC,service_role;
GRANT EXECUTE ON FUNCTION public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_post_media_upload_atomic(uuid,uuid,text,text,text,bigint) TO service_role;
COMMENT ON FUNCTION public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)
  IS 'post-media-upload-registry:reserve-v1:56e6f09a800136a55e4249b2cf1ba9c4';
COMMENT ON FUNCTION public.finalize_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)
  IS 'post-media-upload-registry:finalize-v1:4ff0dbce52d166d77321738991f75250';

REVOKE ALL ON FUNCTION public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb) FROM PUBLIC,service_role;
REVOKE ALL ON FUNCTION public.create_post_with_media_claims_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[],text[],text) FROM PUBLIC,service_role;
REVOKE ALL ON FUNCTION public.edit_post_with_media_claims_atomic(uuid,uuid,bigint,text,text,boolean,text[],text,text[],text[],text[],uuid,text) FROM PUBLIC,service_role;
REVOKE ALL ON FUNCTION public.submit_group_application_with_media_claims_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean,uuid,text[],text) FROM PUBLIC,service_role;
REVOKE ALL ON FUNCTION public.review_group_application_with_media_claims_atomic(uuid,uuid,text,text,boolean,uuid,text) FROM PUBLIC,service_role;
GRANT EXECUTE ON FUNCTION public.create_post_with_media_claims_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[],text[],text) TO service_role;
GRANT EXECUTE ON FUNCTION public.edit_post_with_media_claims_atomic(uuid,uuid,bigint,text,text,boolean,text[],text,text[],text[],text[],uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_group_application_with_media_claims_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean,uuid,text[],text) TO service_role;
GRANT EXECUTE ON FUNCTION public.review_group_application_with_media_claims_atomic(uuid,uuid,text,text,boolean,uuid,text) TO service_role;
COMMENT ON FUNCTION public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb)
  IS 'post-media-claims:internal-v1:16ce55b402e98e4decb1e044dcd2f881';
COMMENT ON FUNCTION public.create_post_with_media_claims_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[],text[],text)
  IS 'post-media-claims:create-v1:2982332579187d47e5d319e6699e9e91';
COMMENT ON FUNCTION public.edit_post_with_media_claims_atomic(uuid,uuid,bigint,text,text,boolean,text[],text,text[],text[],text[],uuid,text)
  IS 'post-media-claims:edit-v1:4ff2e5691dc27891442df50567a81c7d';
COMMENT ON FUNCTION public.submit_group_application_with_media_claims_atomic(uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,boolean,uuid,text[],text)
  IS 'post-media-claims:group-submit-v1:3e46f03ddfa7bbd89e15b5d619109126';
COMMENT ON FUNCTION public.review_group_application_with_media_claims_atomic(uuid,uuid,text,text,boolean,uuid,text)
  IS 'post-media-claims:group-review-v1:0380908cb6c5ffca0ec86f683ebbbbe7';
SQL

baseline_empty_hashes="$(source_hashes)"

echo 'fresh migration'
psql_cmd -f "$COVERAGE_MIGRATION"
if [[ "${DUMP_COVERAGE_CATALOG:-0}" == '1' ]]; then
  psql_cmd -At -F '|' -c "SELECT conrelid::regclass::text,conname,
    md5(pg_get_constraintdef(oid,true)),contype,conkey::text,
    CASE WHEN confrelid=0 THEN '' ELSE confrelid::regclass::text END,confkey::text,
    connoinherit::text
    FROM pg_constraint
    WHERE conrelid IN ('public.post_media_coverage_config'::regclass,
      'public.post_media_coverage_runs'::regclass,
      'public.post_media_coverage_targets'::regclass,
      'public.post_media_coverage_attempts'::regclass,
      'public.post_media_coverage_references'::regclass)
    ORDER BY conrelid::regclass::text,conname;"
  psql_cmd -At -F '|' -c "SELECT indrelid::regclass::text,index_relation.relname,
    md5(pg_get_indexdef(indexrelid)),indisunique::text,indisprimary::text,
    indnkeyatts::text,indkey::text
    FROM pg_index JOIN pg_class AS index_relation ON index_relation.oid=indexrelid
    WHERE indrelid IN ('public.post_media_coverage_config'::regclass,
      'public.post_media_coverage_runs'::regclass,
      'public.post_media_coverage_targets'::regclass,
      'public.post_media_coverage_attempts'::regclass,
      'public.post_media_coverage_references'::regclass)
    ORDER BY indrelid::regclass::text,index_relation.relname;"
  exit 0
fi
assert_scalar '5' "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('post_media_coverage_config','post_media_coverage_runs','post_media_coverage_targets','post_media_coverage_attempts','post_media_coverage_references');"
assert_scalar '7' "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('install_post_media_coverage_origin_atomic','classify_post_media_reference_lexical_internal','start_post_media_coverage_inventory_atomic','enqueue_post_media_coverage_inventory_atomic','observe_post_media_coverage_inventory_atomic','seal_post_media_coverage_inventory_atomic','read_post_media_coverage_gate_atomic');"
assert_scalar '0' "SELECT count(*) FROM pg_policy WHERE polrelid IN ('public.post_media_coverage_config'::regclass,'public.post_media_coverage_runs'::regclass,'public.post_media_coverage_targets'::regclass,'public.post_media_coverage_attempts'::regclass,'public.post_media_coverage_references'::regclass);"
assert_scalar '0' "SELECT count(*) FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid IN ('public.post_media_coverage_config'::regclass,'public.post_media_coverage_runs'::regclass,'public.post_media_coverage_targets'::regclass,'public.post_media_coverage_attempts'::regclass,'public.post_media_coverage_references'::regclass) AND a.grantee<>c.relowner;"
assert_scalar '0' "SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid IN ('public.post_media_coverage_config'::regclass,'public.post_media_coverage_runs'::regclass,'public.post_media_coverage_targets'::regclass,'public.post_media_coverage_attempts'::regclass,'public.post_media_coverage_references'::regclass) AND a.attnum>0 AND NOT a.attisdropped AND x.grantee<>c.relowner;"
assert_scalar '0' "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('install_post_media_coverage_origin_atomic','classify_post_media_reference_lexical_internal','start_post_media_coverage_inventory_atomic','enqueue_post_media_coverage_inventory_atomic','observe_post_media_coverage_inventory_atomic','seal_post_media_coverage_inventory_atomic','read_post_media_coverage_gate_atomic') AND pronargdefaults<>0;"
assert_scalar "$baseline_empty_hashes" "SELECT '$(source_hashes)';"

echo 'exact replay'
psql_cmd -f "$COVERAGE_MIGRATION"
assert_scalar '7' "SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('install_post_media_coverage_origin_atomic','classify_post_media_reference_lexical_internal','start_post_media_coverage_inventory_atomic','enqueue_post_media_coverage_inventory_atomic','observe_post_media_coverage_inventory_atomic','seal_post_media_coverage_inventory_atomic','read_post_media_coverage_gate_atomic');"
assert_service 'uninitialized|false|false|false|false|true' "SELECT (g->>'status')||'|'||(g->>'snapshot_inventory_complete')||'|'||(g->>'snapshot_scope_complete')||'|'||(g->>'cutover_ready')||'|'||(g->>'authoritative_for_gc')||'|'||(g->>'requires_new_generation_after_source_drain') FROM (SELECT public.read_post_media_coverage_gate_atomic('70000000-0000-4000-8000-000000000000','all') g) s;"

echo 'origin validation'
expect_failure_matching origin-service-owner '42501.*postgres owner required|permission denied for function' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.install_post_media_coverage_origin_atomic('https://project.supabase.co');"
expect_failure_matching origin-default-port '22023.*invalid canonical' \
  "SELECT public.install_post_media_coverage_origin_atomic('https://project.supabase.co:443');"
expect_failure_matching origin-path '22023.*invalid canonical' \
  "SELECT public.install_post_media_coverage_origin_atomic('https://project.supabase.co/path');"
expect_failure_matching origin-host-label '22023.*invalid canonical' \
  "SELECT public.install_post_media_coverage_origin_atomic('https://project.-supabase.co');"
assert_scalar 'installed' "SELECT public.install_post_media_coverage_origin_atomic('https://project.supabase.co')->>'status';"
assert_scalar 'replayed' "SELECT public.install_post_media_coverage_origin_atomic('https://project.supabase.co')->>'status';"
expect_failure_matching origin-immutable '22023.*origin is immutable' \
  "SELECT public.install_post_media_coverage_origin_atomic('https://other.supabase.co');"

echo 'WHATWG-ambiguous lexical cases'
OWNER='10000000-0000-4000-8000-000000000001'
ORIGIN='https://project.supabase.co'
CANONICAL="$ORIGIN/storage/v1/object/public/posts/$OWNER/30000000-0000-4000-8000-000000000001.jpg"
assert_scalar 'canonical_managed' "SELECT public.classify_post_media_reference_lexical_internal('$CANONICAL','$OWNER','post_image','$ORIGIN')->>'classification';"
assert_scalar 'external' "SELECT public.classify_post_media_reference_lexical_internal('https://example.com/a.jpg','$OWNER','post_image','$ORIGIN')->>'classification';"
assert_scalar 'external' "SELECT public.classify_post_media_reference_lexical_internal('https://example.com/a.jpg',NULL,'post_image','$ORIGIN')->>'classification';"
assert_scalar 'malformed_or_ambiguous|managed_owner_unavailable' "SELECT (j->>'classification')||'|'||(j->>'finding') FROM (SELECT public.classify_post_media_reference_lexical_internal('$CANONICAL',NULL,'post_image','$ORIGIN') j) s;"
assert_scalar 'malformed_or_ambiguous' "SELECT public.classify_post_media_reference_lexical_internal(U&'https://cdn.example/a.jpg\00A0$CANONICAL','$OWNER','post_image','$ORIGIN')->>'classification';"
expect_failure_matching classifier-null-kind '22023.*invalid lexical classifier context' \
  "SELECT public.classify_post_media_reference_lexical_internal('https://example.com/a.jpg','$OWNER',NULL,'$ORIGIN');"
assert_scalar 'malformed_or_ambiguous|managed_owner_mismatch' "SELECT (j->>'classification')||'|'||(j->>'finding') FROM (SELECT public.classify_post_media_reference_lexical_internal('$ORIGIN/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000099/x.jpg','$OWNER','post_image','$ORIGIN') j) s;"
for ambiguous in \
  'https://project%2esupabase.co/storage/v1/object/public/posts/x' \
  'https://user@project.supabase.co/storage/v1/object/public/posts/x' \
  'https:\\project.supabase.co\storage\v1\object\public\posts\x' \
  'https:project.supabase.co/storage/v1/object/public/posts/x' \
  'https://project.supabase.co:0443/storage/v1/object/public/posts/x' \
  'http://project.supabase.co/storage/v1/object/public/posts/x' \
  'https://project.supabase.co./storage/v1/object/public/posts/x' \
  'https://project.supabase.co/storage/v1/render/image/public/posts/x' \
  'https://example.com./a.jpg' \
  'https://example.com:0443/a.jpg'; do
  assert_scalar 'malformed_or_ambiguous' \
    "SELECT public.classify_post_media_reference_lexical_internal('$ambiguous','$OWNER','post_image','$ORIGIN')->>'classification';"
done

echo 'official direct Storage host'
for direct_url in \
  "https://project.storage.supabase.co/storage/v1/object/public/posts/$OWNER/direct.jpg" \
  "https://project.storage.supabase.co/storage/v1/render/image/public/posts/$OWNER/direct.jpg"; do
  assert_scalar 'malformed_or_ambiguous|noncanonical_internal_reference' \
    "SELECT (j->>'classification')||'|'||(j->>'finding') FROM (SELECT public.classify_post_media_reference_lexical_internal('$direct_url','$OWNER','post_image','$ORIGIN') j) s;"
done
for delimiter in '{' '}' '|' '^'; do
  assert_scalar 'malformed_or_ambiguous' \
    "SELECT public.classify_post_media_reference_lexical_internal('https://cdn.example/a.jpg${delimiter}$CANONICAL','$OWNER','post_image','$ORIGIN')->>'classification';"
done

psql_cmd <<'SQL'
WITH constants AS (
  SELECT
    '10000000-0000-4000-8000-000000000001'::uuid AS owner_id,
    'https://project.supabase.co/storage/v1/object/public/posts/'::text AS prefix
), post_fixture(id,suffix,content,images) AS (
  VALUES
    ('21000000-0000-4000-8000-000000000001'::uuid,'30000000-0000-4000-8000-000000000001.jpg',NULL::text,
      ARRAY['30000000-0000-4000-8000-000000000001.jpg']::text[]),
    ('21000000-0000-4000-8000-000000000002'::uuid,'videos/30000000-0000-4000-8000-000000000002.mp4','content-video',ARRAY[]::text[]),
    ('21000000-0000-4000-8000-000000000003'::uuid,'30000000-0000-4000-8000-000000000003.png','dedupe',ARRAY['30000000-0000-4000-8000-000000000003.png']::text[]),
    ('21000000-0000-4000-8000-000000000004'::uuid,'videos/30000000-0000-4000-8000-000000000004.mp4',NULL,ARRAY['videos/30000000-0000-4000-8000-000000000004.mp4']::text[]),
    ('21000000-0000-4000-8000-000000000006'::uuid,NULL,NULL,ARRAY[]::text[]),
    ('21000000-0000-4000-8000-000000000007'::uuid,NULL,'https://cdn.example/a.png',ARRAY[]::text[]),
    ('21000000-0000-4000-8000-000000000008'::uuid,NULL,'https://project.supabase.co:0443/storage/v1/object/public/posts/x.png',ARRAY[]::text[]),
    ('21000000-0000-4000-8000-000000000009'::uuid,'30000000-0000-4000-8000-000000000009.jpg',NULL,ARRAY['30000000-0000-4000-8000-000000000009.jpg']::text[]),
    ('21000000-0000-4000-8000-000000000010'::uuid,'30000000-0000-4000-8000-000000000010.jpg',NULL,ARRAY['30000000-0000-4000-8000-000000000010.jpg']::text[]),
    ('21000000-0000-4000-8000-000000000011'::uuid,'30000000-0000-4000-8000-000000000011.jpg',NULL,ARRAY['30000000-0000-4000-8000-000000000011.jpg']::text[]),
    ('21000000-0000-4000-8000-000000000012'::uuid,'30000000-0000-4000-8000-000000000012.jpg',NULL,ARRAY['30000000-0000-4000-8000-000000000012.jpg']::text[]),
    ('21000000-0000-4000-8000-000000000013'::uuid,'30000000-0000-4000-8000-000000000013.jpg',NULL,ARRAY['30000000-0000-4000-8000-000000000013.jpg']::text[]),
    ('21000000-0000-4000-8000-000000000014'::uuid,'30000000-0000-4000-8000-000000000014.jpg',NULL,ARRAY['30000000-0000-4000-8000-000000000014.jpg']::text[])
)
INSERT INTO public.posts(id,author_id,content,images,content_version,deleted_at)
SELECT post_fixture.id,constants.owner_id,
  CASE post_fixture.content
    WHEN 'content-video' THEN constants.prefix || constants.owner_id::text || '/' || post_fixture.suffix
    WHEN 'dedupe' THEN 'same ' || constants.prefix || constants.owner_id::text || '/' || post_fixture.suffix || ' same'
    ELSE post_fixture.content END,
  CASE WHEN post_fixture.suffix IS NULL THEN post_fixture.images ELSE ARRAY(
    SELECT CASE WHEN image_name LIKE 'http%' THEN image_name
      ELSE constants.prefix || constants.owner_id::text || '/' || image_name END
    FROM unnest(post_fixture.images) AS image_name
  ) END,
  0,NULL
FROM post_fixture CROSS JOIN constants;

INSERT INTO public.posts(id,author_id,content,images,content_version,deleted_at,status)
VALUES ('21000000-0000-4000-8000-000000000015',
  '10000000-0000-4000-8000-000000000001','inactive post',ARRAY[]::text[],0,NULL,'draft');

-- Keep the distinct-reference cardinality fixture uncompressed; a separate
-- fixture below proves compressed TOAST arrays fail closed before unnest.
ALTER TABLE public.posts ALTER COLUMN images SET STORAGE EXTERNAL;
INSERT INTO public.posts(id,author_id,content,images,content_version,deleted_at)
SELECT '21000000-0000-4000-8000-000000000005',
  '10000000-0000-4000-8000-000000000001',NULL,
  array_agg('https://cdn.example/' || gen_random_uuid()::text || '.png' ORDER BY value),0,NULL
FROM generate_series(1,70) AS value;

INSERT INTO public.groups(id,created_by,avatar_url) VALUES
  ('51000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001',
   'https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000203.png'),
  ('51000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000099',
   'https://cdn.example/wrong-group.png');
INSERT INTO public.group_applications(id,applicant_id,avatar_url,status,group_id) VALUES
  ('41000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
   'https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000201.png','pending',NULL),
  ('41000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',NULL,'rejected',NULL),
  ('41000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001',
   'https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000203.png','approved','51000000-0000-4000-8000-000000000003'),
  ('41000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001',
   'https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000204.png','approved','51000000-0000-4000-8000-000000000004'),
  ('41000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001',NULL,'pending','51000000-0000-4000-8000-000000000003');

INSERT INTO public.post_media_uploads(
  upload_id,owner_id,object_name,purpose,mime_type,size_bytes,status,
  expires_at,created_at,updated_at,gc_admitted_at
) VALUES
 ('61000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001.jpg','post_image','image/jpeg',1,'uploaded',now()+interval '1 hour',now(),now(),NULL),
 ('61000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001/videos/30000000-0000-4000-8000-000000000002.mp4','post_video','video/mp4',1,'uploaded',now()+interval '1 hour',now(),now(),NULL),
 ('61000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000003.png','post_image','image/png',1,'uploaded',now()+interval '1 hour',now(),now(),NULL),
 ('61000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001/videos/30000000-0000-4000-8000-000000000004.mp4','post_video','video/mp4',1,'uploaded',now()+interval '1 hour',now(),now(),NULL),
 ('61000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000010.jpg','post_image','image/jpeg',1,'reserved',now()+interval '1 hour',now(),now(),NULL),
 ('61000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000099','10000000-0000-4000-8000-000000000099/30000000-0000-4000-8000-000000000011.jpg','post_image','image/jpeg',1,'uploaded',now()+interval '1 hour',now(),now(),NULL),
 ('61000000-0000-4000-8000-000000000012','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000012.jpg','legacy_image','image/jpeg',1,'uploaded',now()+interval '1 hour',now(),now(),NULL),
 ('61000000-0000-4000-8000-000000000013','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000013.jpg','post_image','image/jpeg',1,'uploaded',now()+interval '1 hour',now(),now(),NULL),
 ('61000000-0000-4000-8000-000000000014','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000014.jpg','post_image','image/jpeg',1,'uploaded',now()+interval '1 hour',now(),now(),NULL),
 ('62000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000201.png','group_avatar','image/png',1,'uploaded',now()+interval '1 hour',now(),now(),NULL),
 ('62000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000203.png','legacy_image','image/png',1,'uploaded',now()+interval '1 hour',now(),now(),NULL),
 ('62000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000204.png','group_avatar','image/png',1,'uploaded',now()+interval '1 hour',now(),now(),NULL);

INSERT INTO storage.objects(bucket_id,name)
SELECT 'posts',object_name FROM public.post_media_uploads
WHERE upload_id NOT IN ('61000000-0000-4000-8000-000000000013');
INSERT INTO public.post_media_claims(
  upload_id,target_kind,target_id,reference_kind,first_claim_operation_id,
  first_seen_revision,last_seen_revision
) VALUES
 ('61000000-0000-4000-8000-000000000002','post','21000000-0000-4000-8000-000000000002','post_video','81000000-0000-4000-8000-000000000002',0,0),
 ('61000000-0000-4000-8000-000000000003','post','21000000-0000-4000-8000-000000000003','post_image','81000000-0000-4000-8000-000000000003',0,0),
 ('61000000-0000-4000-8000-000000000004','post','21000000-0000-4000-8000-000000000004','post_video','81000000-0000-4000-8000-000000000004',0,0),
 ('61000000-0000-4000-8000-000000000014','post','21000000-0000-4000-8000-000000000014','post_video','81000000-0000-4000-8000-000000000014',0,0),
 ('62000000-0000-4000-8000-000000000003','group_application','41000000-0000-4000-8000-000000000003','group_avatar','82000000-0000-4000-8000-000000000003',NULL,NULL),
 ('62000000-0000-4000-8000-000000000003','group','51000000-0000-4000-8000-000000000003','group_avatar','82000000-0000-4000-8000-000000000004',NULL,NULL);
SQL

baseline_seeded_hashes="$(source_hashes)"

RUN1="$(service_sql "SELECT public.start_post_media_coverage_inventory_atomic('71000000-0000-4000-8000-000000000001')->>'run_id';")"
assert_service 'replayed' "SELECT public.start_post_media_coverage_inventory_atomic('71000000-0000-4000-8000-000000000001')->>'status';"
expect_failure_matching active-run '55000.*already active' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.start_post_media_coverage_inventory_atomic('71000000-0000-4000-8000-000000000099');"
expect_failure_matching enqueue-zero '22023.*between 1 and 500' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.enqueue_post_media_coverage_inventory_atomic('$RUN1',0);"
expect_failure_matching observe-large '22023.*between 1 and 25' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.observe_post_media_coverage_inventory_atomic('$RUN1',26);"
expect_failure_matching gate-null-scope '22023.*invalid post media coverage gate scope' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.read_post_media_coverage_gate_atomic('$RUN1',NULL);"

echo 'bounded queue and SKIP LOCKED'
enqueue_to_reconciling "$RUN1" 7
assert_service 'work_remaining' "SELECT public.seal_post_media_coverage_inventory_atomic('$RUN1',500)->>'status';"
expect_failure_matching hostile-target-temp '42501.*unsafe post media coverage targets temp relation' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; CREATE TEMP TABLE post_media_coverage_batch_targets(x integer); SELECT public.observe_post_media_coverage_inventory_atomic('$RUN1',1);"
expect_failure_matching hostile-reference-temp '42501.*unsafe post media coverage references temp relation' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; CREATE TEMP TABLE post_media_coverage_batch_references(x integer); SELECT public.observe_post_media_coverage_inventory_atomic('$RUN1',1);"
expect_failure_matching hostile-blocker-temp '42501.*unsafe post media coverage blockers temp relation' \
  "SET ROLE service_role; SET request.jwt.claim.role='service_role'; CREATE TEMP TABLE post_media_coverage_batch_blockers(x integer); SELECT public.observe_post_media_coverage_inventory_atomic('$RUN1',1);"
(
  service_sql "SELECT public.observe_post_media_coverage_inventory_atomic('$RUN1',3);" \
    >"$LOG_DIR/observe-a.log" 2>&1
) &
worker_a=$!
(
  service_sql "SELECT public.observe_post_media_coverage_inventory_atomic('$RUN1',3);" \
    >"$LOG_DIR/observe-b.log" 2>&1
) &
worker_b=$!
wait "$worker_a"
wait "$worker_b"
if rg -q '40P01|deadlock detected' "$LOG_DIR/observe-a.log" "$LOG_DIR/observe-b.log"; then
  cat "$LOG_DIR/observe-a.log" "$LOG_DIR/observe-b.log" >&2
  exit 1
fi
observe_to_idle "$RUN1"
assert_scalar '0' "SELECT count(*) FROM public.post_media_coverage_targets WHERE run_id='$RUN1' AND target_id='21000000-0000-4000-8000-000000000015';"
assert_scalar '3' "SELECT source_mask FROM public.post_media_coverage_references WHERE run_id='$RUN1' AND target_id='21000000-0000-4000-8000-000000000003';"
assert_scalar '0|quarantined|true' "SELECT reference_count||'|'||coverage_state||'|'||(blockers @> ARRAY['reference_limit_exceeded'])::text FROM public.post_media_coverage_targets WHERE run_id='$RUN1' AND target_id='21000000-0000-4000-8000-000000000005';"
assert_scalar 'quarantined|true' "SELECT coverage_state||'|'||(blockers @> ARRAY['video_in_images'])::text FROM public.post_media_coverage_targets WHERE run_id='$RUN1' AND target_id='21000000-0000-4000-8000-000000000004';"
assert_scalar 'covered|claimable' "SELECT coverage_state||'|'||claim_state FROM public.post_media_coverage_targets WHERE run_id='$RUN1' AND target_id='21000000-0000-4000-8000-000000000001';"
assert_scalar 'covered|fully_claimed' "SELECT coverage_state||'|'||claim_state FROM public.post_media_coverage_targets WHERE run_id='$RUN1' AND target_id='21000000-0000-4000-8000-000000000002';"
assert_scalar 'external_only|not_applicable' "SELECT coverage_state||'|'||claim_state FROM public.post_media_coverage_targets WHERE run_id='$RUN1' AND target_id='21000000-0000-4000-8000-000000000007';"
assert_scalar 'quarantined|whatwg_ambiguous' "SELECT coverage_state||'|'||blockers[1] FROM public.post_media_coverage_targets WHERE run_id='$RUN1' AND target_id='21000000-0000-4000-8000-000000000008';"
assert_scalar 'unregistered_object' "SELECT blockers[1] FROM public.post_media_coverage_targets WHERE run_id='$RUN1' AND target_id='21000000-0000-4000-8000-000000000009';"
assert_scalar 'upload_not_finalized' "SELECT blockers[1] FROM public.post_media_coverage_targets WHERE run_id='$RUN1' AND target_id='21000000-0000-4000-8000-000000000010';"
assert_scalar 'unregistered_object' "SELECT blockers[1] FROM public.post_media_coverage_targets WHERE run_id='$RUN1' AND target_id='21000000-0000-4000-8000-000000000011';"
assert_scalar 'covered|claimable' "SELECT coverage_state||'|'||claim_state FROM public.post_media_coverage_targets WHERE run_id='$RUN1' AND target_id='21000000-0000-4000-8000-000000000012';"
assert_scalar 'storage_object_missing' "SELECT blockers[1] FROM public.post_media_coverage_targets WHERE run_id='$RUN1' AND target_id='21000000-0000-4000-8000-000000000013';"
assert_scalar 'conflicting|claim_kind_conflict' "SELECT claim_state||'|'||blockers[1] FROM public.post_media_coverage_targets WHERE run_id='$RUN1' AND target_id='21000000-0000-4000-8000-000000000014';"
assert_scalar 'approved_group_avatar_mismatch|approved_group_owner_mismatch' "SELECT array_to_string(blockers,'|') FROM public.post_media_coverage_targets WHERE run_id='$RUN1' AND target_id='41000000-0000-4000-8000-000000000004';"

assert_scalar 'group_review|application_unexpected_group_link' "SELECT eligibility||'|'||blockers[1] FROM public.post_media_coverage_targets WHERE run_id='$RUN1' AND target_id='41000000-0000-4000-8000-000000000005';"
seal_to_sealed "$RUN1" 7
assert_service 'true|false|false|false|true|1' "SELECT (g->>'snapshot_inventory_complete')||'|'||(g->>'snapshot_scope_complete')||'|'||(g->>'cutover_ready')||'|'||(g->>'authoritative_for_gc')||'|'||(g->>'requires_new_generation_after_source_drain')||'|'||(g->>'blocked_count') FROM (SELECT public.read_post_media_coverage_gate_atomic('$RUN1','group_review') g) s;"
assert_service 'true|false|false' "SELECT (g->>'snapshot_inventory_complete')||'|'||(g->>'snapshot_scope_complete')||'|'||(g->>'cutover_ready') FROM (SELECT public.read_post_media_coverage_gate_atomic('$RUN1','post_edit') g) s;"
echo 'scope-local gate counters'
for scope in post_edit group_review group_avatar_audit; do
  assert_scalar 't' "SET request.jwt.claim.role='service_role'; WITH gate AS (
    SELECT public.read_post_media_coverage_gate_atomic('$RUN1','$scope') AS value
  ), expected AS (
    SELECT count(*) FILTER (WHERE claim_state='claimable')::integer AS claimable_count,
      count(*) FILTER (WHERE claim_state='conflicting')::integer AS conflicting_count,
      count(*) FILTER (WHERE coverage_state='quarantined')::integer AS quarantined_count
    FROM public.post_media_coverage_targets
    WHERE run_id='$RUN1' AND (
      eligibility='$scope'
      OR (eligibility='source_absent' AND target_kind=CASE '$scope'
        WHEN 'post_edit' THEN 'post'
        WHEN 'group_review' THEN 'group_application'
        WHEN 'group_avatar_audit' THEN 'group'
      END)
    )
  ) SELECT (gate.value->>'claimable_count')::integer=expected.claimable_count
      AND (gate.value->>'conflicting_count')::integer=expected.conflicting_count
      AND (gate.value->>'quarantined_count')::integer=expected.quarantined_count
    FROM gate CROSS JOIN expected;"
done
assert_scalar 't' "SET request.jwt.claim.role='service_role'; SELECT
  ROW(post_gate->>'claimable_count',post_gate->>'conflicting_count',post_gate->>'quarantined_count')
    IS DISTINCT FROM
  ROW(review_gate->>'claimable_count',review_gate->>'conflicting_count',review_gate->>'quarantined_count')
  FROM (SELECT public.read_post_media_coverage_gate_atomic('$RUN1','post_edit') AS post_gate,
    public.read_post_media_coverage_gate_atomic('$RUN1','group_review') AS review_gate) AS gates;"
assert_service 'replayed' "SELECT public.seal_post_media_coverage_inventory_atomic('$RUN1',500)->>'status';"
assert_service 'replayed' "SELECT public.observe_post_media_coverage_inventory_atomic('$RUN1',25)->>'status';"

echo 'snapshot-only gate'
after_run1_hashes="$(source_hashes)"
if [[ "$after_run1_hashes" != "$baseline_seeded_hashes" ]]; then
  echo 'source mutation hashes changed during generation 1' >&2
  exit 1
fi
echo 'no claim, GC, release, or Storage mutation'

echo 'renderer grammar, zero UUID keyset, and bounded-source fixtures'
psql_cmd <<'SQL'
INSERT INTO public.groups(id,created_by,avatar_url) VALUES
 ('00000000-0000-0000-0000-000000000000','10000000-0000-4000-8000-000000000001',NULL),
 ('53000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',repeat('g',1048576)),
 ('54000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','https://cdn.example/later-group.png');
INSERT INTO public.group_applications(id,applicant_id,avatar_url,status,group_id) VALUES
 ('00000000-0000-0000-0000-000000000000','10000000-0000-4000-8000-000000000001',NULL,'rejected',NULL),
 ('43000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',repeat('a',1048576),'pending',NULL),
 ('44000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','https://cdn.example/later-app.png','rejected',NULL),
 ('45000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',NULL,repeat('s',8192),NULL);

INSERT INTO public.posts(id,author_id,content,images,content_version,deleted_at,status) VALUES
 ('00000000-0000-0000-0000-000000000000','10000000-0000-4000-8000-000000000001','zero post',ARRAY[]::text[],0,NULL,'active'),
 ('22000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','![alt](https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001.jpg)',ARRAY[]::text[],0,NULL,'active'),
 ('22000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','[video](https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/videos/30000000-0000-4000-8000-000000000002.mp4) [视频](https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/videos/30000000-0000-4000-8000-000000000002.mp4) [動画](https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/videos/30000000-0000-4000-8000-000000000002.mp4) [동영상](https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/videos/30000000-0000-4000-8000-000000000002.mp4)',ARRAY[]::text[],0,NULL,'active'),
 ('22000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','[https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001.jpg](https://cdn.example/destination.png)',ARRAY[]::text[],0,NULL,'active'),
 ('22000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','![https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001.jpg](https://cdn.example/alt-destination.png)',ARRAY[]::text[],0,NULL,'active'),
 ('22000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','[x](https://cdn.example/a.png|https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001.jpg)',ARRAY[]::text[],0,NULL,'active'),
 ('22000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001','https://project.storage.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/direct.jpg',ARRAY[]::text[],0,NULL,'active'),
 ('22000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000001','https://cdn.example/'||repeat('r',4096)||'.png',ARRAY[]::text[],0,NULL,'active'),
 ('22000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000001',U&'https://cdn.example/unicode-space.jpg\00A0https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001.jpg',ARRAY[]::text[],0,NULL,'active'),
 ('22000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000001',U&'![x](https://cdn.example/unicode-marker.jpg\00A0https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001.jpg)',ARRAY[]::text[],0,NULL,'active'),
 ('23000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',repeat('c',1048576),ARRAY[]::text[],0,NULL,'active'),
 ('23500000-0000-4000-8000-000000000001',NULL,'https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/ownerless.jpg',ARRAY[]::text[],0,NULL,'active'),
 ('24000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','later normal target',ARRAY[]::text[],0,NULL,'active'),
 ('ffffffff-ffff-ffff-ffff-fffffffffffe','10000000-0000-4000-8000-000000000001','active after inactive tail',ARRAY[]::text[],0,NULL,'active');

INSERT INTO public.posts(id,author_id,content,images,content_version,deleted_at,status)
SELECT ('e0000000-0000-4000-8000-'||lpad(to_hex(value),12,'0'))::uuid,
 '10000000-0000-4000-8000-000000000001','inactive tail',ARRAY[]::text[],0,NULL,'draft'
FROM generate_series(1,120) AS value;

INSERT INTO public.posts(id,author_id,content,images,content_version,deleted_at,status)
SELECT '22000000-0000-4000-8000-000000000064','10000000-0000-4000-8000-000000000001',NULL,
 array_agg('https://cdn.example/'||gen_random_uuid()::text||'.png'),0,NULL,'active'
FROM generate_series(1,64);
INSERT INTO public.posts(id,author_id,content,images,content_version,deleted_at,status)
SELECT '22000000-0000-4000-8000-000000000065','10000000-0000-4000-8000-000000000001',NULL,
 array_agg('https://cdn.example/'||gen_random_uuid()::text||'.png'),0,NULL,'active'
FROM generate_series(1,65);

INSERT INTO public.posts(id,author_id,content,images,content_version,deleted_at,status) VALUES
 ('22000000-0000-4000-8000-000000000070','10000000-0000-4000-8000-000000000001',NULL,
  '[0:0]={"https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001.jpg"}'::text[],0,NULL,'active'),
 ('22000000-0000-4000-8000-000000000071','10000000-0000-4000-8000-000000000001',NULL,
  '[-2:-2]={"https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001.jpg"}'::text[],0,NULL,'active'),
 ('22000000-0000-4000-8000-000000000072','10000000-0000-4000-8000-000000000001',NULL,
  '[0:0][0:1]={{"https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001.jpg","https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000003.png"}}'::text[],0,NULL,'active'),
 ('22000000-0000-4000-8000-000000000073','10000000-0000-4000-8000-000000000001',NULL,
  ARRAY[NULL]::text[],0,NULL,'active');

ALTER TABLE public.posts ALTER COLUMN images SET STORAGE EXTENDED;
INSERT INTO public.posts(id,author_id,content,images,content_version,deleted_at,status)
VALUES ('23000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',NULL,
 ARRAY[repeat('z',4194304)]::text[],0,NULL,'active');
ALTER TABLE public.posts ALTER COLUMN images SET STORAGE EXTERNAL;
SQL

assert_scalar 'pglz' "SELECT pg_column_compression(images) FROM public.posts WHERE id='23000000-0000-4000-8000-000000000001';"
assert_scalar 'pglz|pglz|pglz' "SELECT
  (SELECT pg_column_compression(avatar_url) FROM public.group_applications WHERE id='43000000-0000-4000-8000-000000000001')||'|'||
  (SELECT pg_column_compression(avatar_url) FROM public.groups WHERE id='53000000-0000-4000-8000-000000000001')||'|'||
  (SELECT pg_column_compression(content) FROM public.posts WHERE id='23000000-0000-4000-8000-000000000002');"

RUN2="$(service_sql "SELECT public.start_post_media_coverage_inventory_atomic('71000000-0000-4000-8000-000000000002')->>'run_id';")"
echo 'inactive-tail bounded scan and zero UUID keyset'
enqueue_to_reconciling "$RUN2" 2
assert_scalar '3|3' "SELECT count(*)||'|'||count(DISTINCT target_kind) FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='00000000-0000-0000-0000-000000000000';"
assert_scalar '1|0' "SELECT count(*) FILTER (WHERE target_id='ffffffff-ffff-ffff-ffff-fffffffffffe')||'|'||count(*) FILTER (WHERE target_id::text LIKE 'e0000000-%') FROM public.post_media_coverage_targets WHERE run_id='$RUN2';"
assert_scalar 'true' "SELECT (target_count=(SELECT count(*) FROM public.post_media_coverage_targets WHERE run_id='$RUN2'))::text FROM public.post_media_coverage_runs WHERE run_id='$RUN2';"

echo 'NOWAIT group FK delete and no 40P01'
group_delete_fifo="$TMP_ROOT/group-delete-holder.in"
mkfifo "$group_delete_fifo"
exec 9<>"$group_delete_fifo"
psql_cmd <"$group_delete_fifo" >"$LOG_DIR/group-delete-holder.log" 2>&1 &
delete_holder=$!
printf '%s\n' 'BEGIN;' \
  "DELETE FROM public.groups WHERE id='51000000-0000-4000-8000-000000000003';" \
  '\echo GROUP_DELETE_READY' >&9
wait_for_scalar '1' "SELECT count(*) FROM pg_catalog.pg_locks WHERE locktype='relation' AND relation='public.groups'::regclass AND mode='RowExclusiveLock' AND granted" 'group delete holder relation lock'
for _ in {1..500}; do
  rg -q '^GROUP_DELETE_READY$' "$LOG_DIR/group-delete-holder.log" && break
  sleep 0.01
done
rg -q '^GROUP_DELETE_READY$' "$LOG_DIR/group-delete-holder.log" || {
  echo 'group delete holder did not reach its deterministic barrier' >&2
  exit 1
}
if service_sql "SELECT public.observe_post_media_coverage_inventory_atomic('$RUN2',25);" \
  >"$LOG_DIR/group-delete-coverage.log" 2>&1; then
  echo 'coverage unexpectedly waited through conflicting group delete' >&2
  exit 1
fi
printf '%s\n' 'ROLLBACK;' '\q' >&9
exec 9>&-
wait "$delete_holder"
if ! rg -q '55P03|could not obtain lock' "$LOG_DIR/group-delete-coverage.log"; then
  cat "$LOG_DIR/group-delete-coverage.log" >&2
  exit 1
fi
if rg -q '40P01|deadlock detected' "$LOG_DIR/group-delete-holder.log" "$LOG_DIR/group-delete-coverage.log"; then
  cat "$LOG_DIR/group-delete-holder.log" "$LOG_DIR/group-delete-coverage.log" >&2
  exit 1
fi

echo 'bounded queue concurrency and renderer grammar'
(
  service_sql "SELECT public.observe_post_media_coverage_inventory_atomic('$RUN2',7);" >"$LOG_DIR/observe-c.log" 2>&1
) &
worker_c=$!
(
  service_sql "SELECT public.observe_post_media_coverage_inventory_atomic('$RUN2',7);" >"$LOG_DIR/observe-d.log" 2>&1
) &
worker_d=$!
wait "$worker_c"
wait "$worker_d"
observe_to_idle "$RUN2"
if rg -q '40P01|deadlock detected' "$LOG_DIR/observe-c.log" "$LOG_DIR/observe-d.log"; then
  cat "$LOG_DIR/observe-c.log" "$LOG_DIR/observe-d.log" >&2
  exit 1
fi

assert_scalar '1|2|1' "SELECT reference_count||'|'||(SELECT source_mask FROM public.post_media_coverage_references r WHERE r.run_id=t.run_id AND r.target_kind=t.target_kind AND r.target_id=t.target_id)||'|'||(SELECT occurrences FROM public.post_media_coverage_references r WHERE r.run_id=t.run_id AND r.target_kind=t.target_kind AND r.target_id=t.target_id) FROM public.post_media_coverage_targets t WHERE run_id='$RUN2' AND target_id='22000000-0000-4000-8000-000000000001';"
assert_scalar '1|4' "SELECT reference_count||'|'||(SELECT occurrences FROM public.post_media_coverage_references r WHERE r.run_id=t.run_id AND r.target_kind=t.target_kind AND r.target_id=t.target_id) FROM public.post_media_coverage_targets t WHERE run_id='$RUN2' AND target_id='22000000-0000-4000-8000-000000000002';"
assert_scalar '2|1|1' "SELECT reference_count||'|'||managed_count||'|'||external_count FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='22000000-0000-4000-8000-000000000003';"
assert_scalar '1|0|1' "SELECT reference_count||'|'||managed_count||'|'||external_count FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='22000000-0000-4000-8000-000000000004';"
assert_scalar 'true' "SELECT (t.coverage_state='quarantined' AND
  (SELECT count(*) FROM public.post_media_coverage_references r WHERE r.run_id=t.run_id AND r.target_kind=t.target_kind AND r.target_id=t.target_id AND r.classification='malformed_or_ambiguous')>=1 AND
  (SELECT count(*) FROM public.post_media_coverage_references r WHERE r.run_id=t.run_id AND r.target_kind=t.target_kind AND r.target_id=t.target_id AND r.classification='canonical_managed')>=1)::text
 FROM public.post_media_coverage_targets t WHERE run_id='$RUN2' AND target_id='22000000-0000-4000-8000-000000000005';"
assert_scalar 'quarantined|noncanonical_internal_reference' "SELECT coverage_state||'|'||blockers[1] FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='22000000-0000-4000-8000-000000000006';"
echo 'oversized reference hash key and bounded status sentinel'
assert_scalar 'quarantined|malformed_reference|true|true' "SELECT t.coverage_state||'|'||t.blockers[1]||'|'||(r.classification='malformed_or_ambiguous')::text||'|'||(r.raw_length>2048 AND r.raw_sha256~'^[0-9a-f]{64}$')::text FROM public.post_media_coverage_targets t JOIN public.post_media_coverage_references r USING(run_id,target_kind,target_id) WHERE t.run_id='$RUN2' AND t.target_id='22000000-0000-4000-8000-000000000007';"
echo 'Unicode whitespace tokenizer parity'
assert_scalar '2|1|1|covered' "SELECT reference_count||'|'||managed_count||'|'||external_count||'|'||coverage_state FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='22000000-0000-4000-8000-000000000008';"
assert_scalar '3|1|1|quarantined|true' "SELECT reference_count||'|'||managed_count||'|'||external_count||'|'||coverage_state||'|'||EXISTS(
  SELECT 1 FROM public.post_media_coverage_references r
  WHERE r.run_id=t.run_id AND r.target_kind=t.target_kind AND r.target_id=t.target_id
    AND r.raw_sha256=encode(sha256(convert_to(U&'https://cdn.example/unicode-marker.jpg\00A0https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001.jpg','UTF8')),'hex')
)::text FROM public.post_media_coverage_targets t WHERE run_id='$RUN2' AND target_id='22000000-0000-4000-8000-000000000009';"
assert_scalar 'quarantined|true|true|true' "SELECT coverage_state||'|'||(blockers @> ARRAY['application_status_unsupported'])::text||'|'||(blockers @> ARRAY['source_reference_budget_exceeded'])::text||'|'||(source_status LIKE 'oversized-status:%' AND octet_length(source_status)<64)::text FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='45000000-0000-4000-8000-000000000001';"
assert_scalar '64|external_only|false' "SELECT reference_count||'|'||coverage_state||'|'||(blockers @> ARRAY['reference_limit_exceeded'])::text FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='22000000-0000-4000-8000-000000000064';"
assert_scalar '0|quarantined|true' "SELECT reference_count||'|'||coverage_state||'|'||(blockers @> ARRAY['reference_limit_exceeded'])::text FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='22000000-0000-4000-8000-000000000065';"
assert_scalar '1|1' "SELECT (SELECT reference_count FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='22000000-0000-4000-8000-000000000070')||'|'||(SELECT reference_count FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='22000000-0000-4000-8000-000000000071');"
assert_scalar 'quarantined|true|quarantined|true' "SELECT
 (SELECT coverage_state||'|'||(blockers @> ARRAY['post_images_shape_unsupported'])::text FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='22000000-0000-4000-8000-000000000072')||'|'||
 (SELECT coverage_state||'|'||(blockers @> ARRAY['post_images_shape_unsupported'])::text FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='22000000-0000-4000-8000-000000000073');"

echo 'compressed TOAST array budget and later-target progress'
assert_scalar 'quarantined|true|0' "SELECT coverage_state||'|'||(blockers @> ARRAY['source_reference_budget_exceeded'])::text||'|'||reference_count FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='23000000-0000-4000-8000-000000000001';"
assert_scalar 'quarantined|true' "SELECT coverage_state||'|'||(blockers @> ARRAY['source_reference_budget_exceeded'])::text FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='23000000-0000-4000-8000-000000000002';"
assert_scalar 'observed|empty' "SELECT queue_state||'|'||coverage_state FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='24000000-0000-4000-8000-000000000001';"
echo 'compressed TOAST avatar budget and later-target progress'
assert_scalar 'quarantined|true|0' "SELECT coverage_state||'|'||(blockers @> ARRAY['source_reference_budget_exceeded'])::text||'|'||reference_count FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='43000000-0000-4000-8000-000000000001';"
assert_scalar 'quarantined|true|0' "SELECT coverage_state||'|'||(blockers @> ARRAY['source_reference_budget_exceeded'])::text||'|'||reference_count FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='53000000-0000-4000-8000-000000000001';"
assert_scalar 'observed|external_only' "SELECT queue_state||'|'||coverage_state FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='44000000-0000-4000-8000-000000000001';"
assert_scalar 'observed|external_only' "SELECT queue_state||'|'||coverage_state FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='54000000-0000-4000-8000-000000000001';"
echo 'ownerless retained post quarantine and later-target progress'
assert_scalar 'quarantined|managed_owner_unavailable|1|true' "SELECT coverage_state||'|'||blockers[1]||'|'||reference_count||'|'||(source_owner_id IS NULL)::text FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='23500000-0000-4000-8000-000000000001';"
assert_scalar 'observed|empty' "SELECT queue_state||'|'||coverage_state FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='24000000-0000-4000-8000-000000000001';"
assert_scalar 'true' "SELECT ((SELECT count(*) FROM public.post_media_coverage_attempts WHERE run_id='$RUN2')=(SELECT target_count FROM public.post_media_coverage_runs WHERE run_id='$RUN2'))::text;"
assert_scalar '0' "SELECT count(*) FROM public.post_media_coverage_references r LEFT JOIN public.post_media_coverage_attempts a USING(run_id,target_kind,target_id,attempt) WHERE r.run_id='$RUN2' AND a.run_id IS NULL;"

echo 'cross-TimeZone fingerprint and mixed seal batch sizes'
assert_service 'reconciling' "SET TimeZone='Asia/Tokyo'; SELECT public.seal_post_media_coverage_inventory_atomic('$RUN2',1)->>'status';"
seal_to_sealed "$RUN2" 7
RUN2_FINGERPRINT="$(service_sql "SET TimeZone='America/Los_Angeles'; SELECT public.read_post_media_coverage_gate_atomic('$RUN2','all')->>'population_fingerprint';")"
assert_service "$RUN2_FINGERPRINT" "SET TimeZone='UTC'; SELECT public.seal_post_media_coverage_inventory_atomic('$RUN2',500)->>'population_fingerprint';"
assert_service 'true|false|false|true' "SELECT (g->>'snapshot_inventory_complete')||'|'||(g->>'cutover_ready')||'|'||(g->>'authoritative_for_gc')||'|'||(g->'observed_at_min' IS NOT NULL AND g->'observed_at_max' IS NOT NULL)::text FROM (SELECT public.read_post_media_coverage_gate_atomic('$RUN2','all') g) s;"
if [[ "$(source_hashes)" != "$baseline_seeded_hashes" ]]; then
  # The new fixtures were deliberate source writes; coverage itself must not add any.
  run2_source_hashes="$(source_hashes)"
else
  echo 'source fixture hash unexpectedly unchanged' >&2
  exit 1
fi

echo 'snapshot drift requires a new generation'
RUN2_GATE_BEFORE="$(service_sql "SELECT public.read_post_media_coverage_gate_atomic('$RUN2','all')::text;")"
psql_cmd <<'SQL'
UPDATE public.posts SET content='source changed after sealed snapshot',content_version=content_version+1
WHERE id='21000000-0000-4000-8000-000000000007';
DELETE FROM storage.objects WHERE bucket_id='posts'
  AND name='10000000-0000-4000-8000-000000000001/videos/30000000-0000-4000-8000-000000000002.mp4';
INSERT INTO public.post_media_claims(
 upload_id,target_kind,target_id,reference_kind,first_claim_operation_id,first_seen_revision,last_seen_revision
) VALUES ('61000000-0000-4000-8000-000000000001','post','22000000-0000-4000-8000-000000000001','post_image',
 '83000000-0000-4000-8000-000000000001',0,0);
SQL
deliberate_drift_hashes="$(source_hashes)"
assert_service "$RUN2_FINGERPRINT" "SELECT public.read_post_media_coverage_gate_atomic('$RUN2','all')->>'population_fingerprint';"
assert_service "$RUN2_GATE_BEFORE" "SELECT public.read_post_media_coverage_gate_atomic('$RUN2','all')::text;"

RUN3="$(service_sql "SELECT public.start_post_media_coverage_inventory_atomic('71000000-0000-4000-8000-000000000003')->>'run_id';")"
enqueue_to_reconciling "$RUN3" 11
observe_to_idle "$RUN3"
seal_to_sealed "$RUN3" 13
assert_scalar 'true|true' "SELECT
 ((SELECT manifest_fingerprint FROM public.post_media_coverage_targets WHERE run_id='$RUN3' AND target_id='22000000-0000-4000-8000-000000000001')<>(SELECT manifest_fingerprint FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='22000000-0000-4000-8000-000000000001'))::text||'|'||
 ((SELECT manifest_fingerprint FROM public.post_media_coverage_targets WHERE run_id='$RUN3' AND target_id='21000000-0000-4000-8000-000000000003')=(SELECT manifest_fingerprint FROM public.post_media_coverage_targets WHERE run_id='$RUN2' AND target_id='21000000-0000-4000-8000-000000000003'))::text;"
if [[ "$(source_hashes)" != "$deliberate_drift_hashes" ]]; then
  echo 'source mutation hashes changed during snapshot inventory' >&2
  exit 1
fi

echo 'SKIP LOCKED busy then rollback retry'
psql_cmd -c 'DELETE FROM public.group_applications; DELETE FROM public.groups; DELETE FROM public.posts;'
psql_cmd -c "INSERT INTO public.posts(id,author_id,content,images,content_version,deleted_at,status) VALUES ('25000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','![x](https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001.jpg)',ARRAY[]::text[],0,NULL,'active');"
RUN4="$(service_sql "SELECT public.start_post_media_coverage_inventory_atomic('71000000-0000-4000-8000-000000000004')->>'run_id';")"
enqueue_to_reconciling "$RUN4" 2
psql_cmd -c "UPDATE public.posts SET content='updated ![x](https://project.supabase.co/storage/v1/object/public/posts/10000000-0000-4000-8000-000000000001/30000000-0000-4000-8000-000000000001.jpg)',content_version=1 WHERE id='25000000-0000-4000-8000-000000000001';"
target_holder_fifo="$TMP_ROOT/target-holder.in"
mkfifo "$target_holder_fifo"
exec 9<>"$target_holder_fifo"
psql_cmd <"$target_holder_fifo" >"$LOG_DIR/target-holder.log" 2>&1 &
target_holder=$!
printf '%s\n' 'BEGIN;' \
  "SELECT target_id FROM public.post_media_coverage_targets WHERE run_id='$RUN4' FOR UPDATE;" \
  '\echo TARGET_HOLDER_READY' >&9
for _ in {1..500}; do
  rg -q '^TARGET_HOLDER_READY$' "$LOG_DIR/target-holder.log" && break
  sleep 0.01
done
if ! rg -q '^TARGET_HOLDER_READY$' "$LOG_DIR/target-holder.log"; then
  echo 'target holder did not reach its deterministic barrier' >&2
  exit 1
fi
assert_service 'busy' "SELECT public.observe_post_media_coverage_inventory_atomic('$RUN4',1)->>'status';"
printf '%s\n' 'ROLLBACK;' '\q' >&9
exec 9>&-
wait "$target_holder"
assert_service '1' "SELECT public.observe_post_media_coverage_inventory_atomic('$RUN4',1)->>'observed';"
assert_service 'idle' "SELECT public.observe_post_media_coverage_inventory_atomic('$RUN4',1)->>'status';"
echo 'attempt provenance'
assert_scalar '2|2|1|1' "SELECT t.attempt||'|'||a.attempt||'|'||a.source_revision||'|'||(SELECT count(*) FROM public.post_media_coverage_references r WHERE r.run_id=t.run_id AND r.target_kind=t.target_kind AND r.target_id=t.target_id AND r.attempt=a.attempt) FROM public.post_media_coverage_targets t JOIN public.post_media_coverage_attempts a USING(run_id,target_kind,target_id,attempt) WHERE t.run_id='$RUN4';"
seal_to_sealed "$RUN4" 1

echo 'true zero-population snapshot'
psql_cmd -c 'DELETE FROM public.posts;'
empty_source_hashes="$(source_hashes)"
RUN5="$(service_sql "SELECT public.start_post_media_coverage_inventory_atomic('71000000-0000-4000-8000-000000000005')->>'run_id';")"
enqueue_to_reconciling "$RUN5" 1
seal_to_sealed "$RUN5" 1
assert_service 'true|true|false|false|0' "SELECT (g->>'snapshot_inventory_complete')||'|'||(g->>'snapshot_scope_complete')||'|'||(g->>'cutover_ready')||'|'||(g->>'authoritative_for_gc')||'|'||(g->>'target_count') FROM (SELECT public.read_post_media_coverage_gate_atomic('$RUN5','all') g) s;"
if [[ "$(source_hashes)" != "$empty_source_hashes" ]]; then
  echo 'source mutation hashes changed during empty snapshot' >&2
  exit 1
fi

echo 'missing-source reinsertion snapshot barrier'
psql_cmd -c "INSERT INTO public.posts(id,author_id,content,images,content_version,deleted_at,status) VALUES
  ('26000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','original source',ARRAY[]::text[],0,NULL,'active'),
  ('26000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','stable barrier source',ARRAY[]::text[],0,NULL,'active');"
RUN6="$(service_sql "SELECT public.start_post_media_coverage_inventory_atomic('71000000-0000-4000-8000-000000000006')->>'run_id';")"
enqueue_to_reconciling "$RUN6" 2
psql_cmd -c "DELETE FROM public.posts WHERE id='26000000-0000-4000-8000-000000000001';"
psql_cmd <<'SQL'
CREATE FUNCTION public.inventory_gap_barrier_trigger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $barrier$
BEGIN
  IF NEW.target_id='26000000-0000-4000-8000-000000000002'::uuid
     AND OLD.eligibility='post_edit' AND NEW.eligibility='post_edit'
  THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(987654321::bigint);
  END IF;
  RETURN NEW;
END
$barrier$;
CREATE TRIGGER inventory_gap_barrier
AFTER UPDATE ON public.post_media_coverage_targets
FOR EACH ROW EXECUTE FUNCTION public.inventory_gap_barrier_trigger();
SQL
gap_holder_fifo="$TMP_ROOT/gap-holder.in"
mkfifo "$gap_holder_fifo"
exec 9<>"$gap_holder_fifo"
psql_cmd <"$gap_holder_fifo" >"$LOG_DIR/gap-holder.log" 2>&1 &
gap_holder=$!
printf '%s\n' 'BEGIN;' 'SELECT pg_catalog.pg_advisory_xact_lock(987654321::bigint);' \
  '\echo GAP_HOLDER_READY' >&9
for _ in {1..500}; do
  rg -q '^GAP_HOLDER_READY$' "$LOG_DIR/gap-holder.log" && break
  sleep 0.01
done
if ! rg -q '^GAP_HOLDER_READY$' "$LOG_DIR/gap-holder.log"; then
  echo 'gap holder did not reach its deterministic barrier' >&2
  exit 1
fi
service_sql "SELECT public.observe_post_media_coverage_inventory_atomic('$RUN6',2);" \
  >"$LOG_DIR/gap-observer.log" 2>&1 &
gap_observer=$!
wait_for_scalar '1' "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE wait_event_type='Lock' AND wait_event='advisory' AND query LIKE '%observe_post_media_coverage_inventory_atomic%$RUN6%'" 'gap observer advisory wait'
psql_cmd -c "INSERT INTO public.posts(id,author_id,content,images,content_version,deleted_at,status) VALUES
  ('26000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000099','https://cdn.example/late-source.png',ARRAY[]::text[],1,NULL,'active');"
printf '%s\n' 'COMMIT;' '\q' >&9
exec 9>&-
wait "$gap_holder"
wait "$gap_observer"
psql_cmd -c 'DROP TRIGGER inventory_gap_barrier ON public.post_media_coverage_targets; DROP FUNCTION public.inventory_gap_barrier_trigger();'
assert_scalar 'source_absent|source_absent|0|true|2' "SELECT eligibility||'|'||coverage_state||'|'||reference_count||'|'||(source_owner_id IS NULL)::text||'|'||attempt FROM public.post_media_coverage_targets WHERE run_id='$RUN6' AND target_id='26000000-0000-4000-8000-000000000001';"
assert_scalar '0' "SELECT count(*) FROM public.post_media_coverage_references WHERE run_id='$RUN6' AND target_id='26000000-0000-4000-8000-000000000001';"
assert_scalar 'observed|empty' "SELECT queue_state||'|'||coverage_state FROM public.post_media_coverage_targets WHERE run_id='$RUN6' AND target_id='26000000-0000-4000-8000-000000000002';"
seal_to_sealed "$RUN6" 1
psql_cmd -c "DELETE FROM public.posts WHERE id IN ('26000000-0000-4000-8000-000000000001','26000000-0000-4000-8000-000000000002');"
if [[ "$(source_hashes)" != "$empty_source_hashes" ]]; then
  echo 'source fixture did not return to the empty baseline after gap proof' >&2
  exit 1
fi

echo 'partial publication and hostile catalog drift'
psql_cmd -c "CREATE FUNCTION public.start_post_media_coverage_inventory_atomic(text) RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb';"
expect_migration_failure_matching partial-overload 'publication is partial'
psql_cmd -c 'DROP FUNCTION public.start_post_media_coverage_inventory_atomic(text);'

psql_cmd -c 'GRANT SELECT ON public.post_media_coverage_targets TO hostile_reader;'
expect_migration_failure_matching hostile-table-acl 'existing publication drifted'
psql_cmd -c 'REVOKE ALL ON public.post_media_coverage_targets FROM hostile_reader;'

psql_cmd -c 'GRANT SELECT(reference_count) ON public.post_media_coverage_targets TO hostile_reader WITH GRANT OPTION;'
expect_migration_failure_matching hostile-column-acl 'existing publication drifted'
psql_cmd -c 'REVOKE SELECT(reference_count) ON public.post_media_coverage_targets FROM hostile_reader;'

psql_cmd -c 'CREATE POLICY hostile_policy ON public.post_media_coverage_targets FOR SELECT TO hostile_reader USING (true);'
expect_migration_failure_matching hostile-policy 'existing publication drifted'
psql_cmd -c 'DROP POLICY hostile_policy ON public.post_media_coverage_targets;'

psql_cmd -c 'CREATE INDEX hostile_coverage_index ON public.post_media_coverage_targets(target_id);'
expect_migration_failure_matching hostile-index 'existing publication drifted'
psql_cmd -c 'DROP INDEX public.hostile_coverage_index;'

psql_cmd -c 'ALTER TABLE public.post_media_coverage_targets ADD CONSTRAINT hostile_coverage_check CHECK (true);'
expect_migration_failure_matching hostile-constraint 'existing publication drifted'
psql_cmd -c 'ALTER TABLE public.post_media_coverage_targets DROP CONSTRAINT hostile_coverage_check;'

psql_cmd -c 'ALTER TABLE public.post_media_coverage_targets ALTER COLUMN reference_count SET DEFAULT 0;'
expect_migration_failure_matching hostile-column-default 'existing publication drifted'
psql_cmd -c 'ALTER TABLE public.post_media_coverage_targets ALTER COLUMN reference_count DROP DEFAULT;'

psql_cmd -c "ALTER TABLE public.post_media_coverage_targets DROP CONSTRAINT post_media_coverage_targets_kind_check; ALTER TABLE public.post_media_coverage_targets ADD CONSTRAINT post_media_coverage_targets_kind_check CHECK (target_kind IN ('post','group_application','group') AND true);"
expect_migration_failure_matching same-name-constraint-definition 'existing publication drifted'
psql_cmd -c "ALTER TABLE public.post_media_coverage_targets DROP CONSTRAINT post_media_coverage_targets_kind_check; ALTER TABLE public.post_media_coverage_targets ADD CONSTRAINT post_media_coverage_targets_kind_check CHECK (target_kind IN ('post','group_application','group'));"

psql_cmd -c 'DROP INDEX public.post_media_coverage_targets_gate_idx; CREATE INDEX post_media_coverage_targets_gate_idx ON public.post_media_coverage_targets(run_id,target_id);'
expect_migration_failure_matching same-name-index-definition 'existing publication drifted'
psql_cmd -c 'DROP INDEX public.post_media_coverage_targets_gate_idx; CREATE INDEX post_media_coverage_targets_gate_idx ON public.post_media_coverage_targets(run_id,eligibility,coverage_state,claim_state,target_id);'

psql_cmd -c 'ALTER TABLE public.post_media_coverage_references DROP CONSTRAINT post_media_coverage_references_attempt_fkey; ALTER TABLE public.post_media_coverage_references ADD CONSTRAINT post_media_coverage_references_attempt_fkey FOREIGN KEY(run_id,target_kind,target_id,attempt) REFERENCES public.post_media_coverage_attempts(run_id,target_kind,target_id,attempt) ON UPDATE NO ACTION ON DELETE NO ACTION;'
expect_migration_failure_matching same-name-fk-action 'existing publication drifted'
psql_cmd -c 'ALTER TABLE public.post_media_coverage_references DROP CONSTRAINT post_media_coverage_references_attempt_fkey; ALTER TABLE public.post_media_coverage_references ADD CONSTRAINT post_media_coverage_references_attempt_fkey FOREIGN KEY(run_id,target_kind,target_id,attempt) REFERENCES public.post_media_coverage_attempts(run_id,target_kind,target_id,attempt) ON UPDATE RESTRICT ON DELETE RESTRICT;'

psql_cmd -c 'GRANT EXECUTE ON FUNCTION public.classify_post_media_reference_lexical_internal(text,uuid,text,text) TO service_role;'
expect_migration_failure_matching hostile-internal-execute 'existing publication drifted'
psql_cmd -c 'REVOKE EXECUTE ON FUNCTION public.classify_post_media_reference_lexical_internal(text,uuid,text,text) FROM service_role;'

echo 'dependency catalog drift'
psql_cmd -c 'GRANT SELECT ON public.post_media_uploads TO service_role WITH GRANT OPTION;'
expect_migration_failure_matching dependency-table-grant-option 'dependency catalog or authority drifted'
psql_cmd -c 'REVOKE ALL ON public.post_media_uploads FROM service_role;'

psql_cmd -c 'GRANT SELECT(upload_id) ON public.post_media_claims TO service_role WITH GRANT OPTION;'
expect_migration_failure_matching dependency-column-grant-option 'dependency catalog or authority drifted'
psql_cmd -c 'REVOKE SELECT(upload_id) ON public.post_media_claims FROM service_role;'

psql_cmd -c 'CREATE POLICY hostile_upload_policy ON public.post_media_uploads FOR SELECT TO service_role USING (true);'
expect_migration_failure_matching dependency-policy 'dependency catalog or authority drifted'
psql_cmd -c 'DROP POLICY hostile_upload_policy ON public.post_media_uploads;'

psql_cmd -c 'ALTER TABLE public.post_media_uploads ADD CONSTRAINT hostile_upload_check CHECK (true);'
expect_migration_failure_matching dependency-constraint 'dependency catalog or authority drifted'
psql_cmd -c 'ALTER TABLE public.post_media_uploads DROP CONSTRAINT hostile_upload_check;'

psql_cmd -c 'ALTER TABLE public.post_media_claims DISABLE TRIGGER ALL;'
expect_migration_failure_matching dependency-ri-disabled 'dependency catalog or authority drifted'
psql_cmd -c 'ALTER TABLE public.post_media_claims ENABLE TRIGGER ALL;'

psql_cmd -c 'ALTER TABLE storage.objects DROP CONSTRAINT objects_bucket_id_name_key; CREATE UNIQUE INDEX objects_bucket_id_name_key ON storage.objects(bucket_id text_pattern_ops,name text_pattern_ops);'
expect_migration_failure_matching storage-identity-opclass 'dependency catalog or authority drifted'
psql_cmd -c 'DROP INDEX storage.objects_bucket_id_name_key; ALTER TABLE storage.objects ADD CONSTRAINT objects_bucket_id_name_key UNIQUE(bucket_id,name);'

psql_cmd -c 'CREATE TABLE public.hostile_posts_child() INHERITS (public.posts);'
expect_migration_failure_matching source-inheritance 'dependency catalog or authority drifted'
psql_cmd -c 'DROP TABLE public.hostile_posts_child;'

psql_cmd -c 'CREATE TABLE storage.hostile_objects_child() INHERITS (storage.objects);'
expect_migration_failure_matching storage-inheritance 'dependency catalog or authority drifted'
psql_cmd -c 'DROP TABLE storage.hostile_objects_child;'

psql_cmd -c 'ALTER TABLE public.posts DROP CONSTRAINT posts_pkey;'
expect_migration_failure_matching source-primary-key 'dependency catalog or authority drifted'
psql_cmd -c 'ALTER TABLE public.posts ADD CONSTRAINT posts_pkey PRIMARY KEY(id);'

psql_cmd -c 'ALTER TABLE public.group_applications ALTER COLUMN status TYPE text COLLATE "C" USING status::text;'
expect_migration_failure_matching source-status-collation 'dependency catalog or authority drifted'
psql_cmd -c 'ALTER TABLE public.group_applications ALTER COLUMN status TYPE text COLLATE pg_catalog."default" USING status::text;'

psql_cmd -c 'ALTER TABLE storage.objects ALTER COLUMN name TYPE text COLLATE "C" USING name::text;'
expect_migration_failure_matching storage-column-collation 'dependency catalog or authority drifted'
psql_cmd -c 'ALTER TABLE storage.objects ALTER COLUMN name TYPE text COLLATE pg_catalog."default" USING name::text;'

echo 'hostile role graph'
psql_cmd -c 'GRANT postgres TO authenticator WITH INHERIT FALSE, SET TRUE;'
expect_migration_failure_matching hostile-role-membership 'role graph is unsafe'
psql_cmd -c 'REVOKE postgres FROM authenticator;'

echo 'upstream authority ACL, overload, default, and source syncseal'
psql_cmd -c "CREATE FUNCTION public.reserve_post_media_upload_atomic(text) RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb';"
expect_migration_failure_matching upstream-overload 'dependency catalog or authority drifted'
psql_cmd -c 'DROP FUNCTION public.reserve_post_media_upload_atomic(text);'

psql_cmd -c 'GRANT EXECUTE ON FUNCTION public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb) TO service_role WITH GRANT OPTION;'
expect_migration_failure_matching upstream-authority-acl 'dependency catalog or authority drifted'
psql_cmd -c 'REVOKE EXECUTE ON FUNCTION public.claim_post_media_manifest_internal(text,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text,text[],text,jsonb) FROM service_role;'

reserve_definition="$TMP_ROOT/reserve-definition.sql"
reserve_tampered_definition="$TMP_ROOT/reserve-tampered-definition.sql"
psql_cmd -At -c "SELECT pg_get_functiondef('public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)'::regprocedure);" >"$reserve_definition"
psql_cmd -At >"$reserve_tampered_definition" <<'SQL'
SELECT replace(
  pg_get_functiondef('public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)'::regprocedure),
  'MESSAGE = ''service role required'';',
  'MESSAGE = ''service role is required'';'
);
SQL
reserve_digest="$(psql_cmd -At -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)'::regprocedure;")"
psql_cmd -f "$reserve_tampered_definition"
tampered_reserve_digest="$(psql_cmd -At -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)'::regprocedure;")"
if [[ "$tampered_reserve_digest" == "$reserve_digest" ]]; then
  echo 'upstream reserve body tamper did not change source' >&2
  exit 1
fi
psql_cmd -c "COMMENT ON FUNCTION public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint) IS 'post-media-upload-registry:reserve-v1:$tampered_reserve_digest';"
expect_migration_failure_matching upstream-body-syncseal 'dependency catalog or authority drifted'
install_reviewed_function "$REGISTRY_MIGRATION" reserve_post_media_upload_atomic
psql_cmd -c 'REVOKE ALL ON FUNCTION public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint) FROM PUBLIC,service_role; GRANT EXECUTE ON FUNCTION public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint) TO service_role;'
psql_cmd -c "COMMENT ON FUNCTION public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint) IS 'post-media-upload-registry:reserve-v1:$reserve_digest';"

review_definition="$TMP_ROOT/review-definition.sql"
review_hostile_default="$TMP_ROOT/review-hostile-default.sql"
psql_cmd -At -c "SELECT pg_get_functiondef('public.review_group_application_with_media_claims_atomic(uuid,uuid,text,text,boolean,uuid,text)'::regprocedure);" >"$review_definition"
psql_cmd -At >"$review_hostile_default" <<'SQL'
SELECT replace(
  pg_get_functiondef('public.review_group_application_with_media_claims_atomic(uuid,uuid,text,text,boolean,uuid,text)'::regprocedure),
  'p_storage_origin text DEFAULT NULL::text)',
  'p_storage_origin text DEFAULT ''https://hostile.invalid''::text)'
);
SQL
review_arguments="$(psql_cmd -At -c "SELECT pg_get_function_arguments('public.review_group_application_with_media_claims_atomic(uuid,uuid,text,text,boolean,uuid,text)'::regprocedure);")"
psql_cmd -f "$review_hostile_default"
hostile_review_arguments="$(psql_cmd -At -c "SELECT pg_get_function_arguments('public.review_group_application_with_media_claims_atomic(uuid,uuid,text,text,boolean,uuid,text)'::regprocedure);")"
if [[ "$hostile_review_arguments" == "$review_arguments" ]]; then
  echo 'upstream default tamper did not change function arguments' >&2
  exit 1
fi
expect_migration_failure_matching upstream-default-metadata 'dependency catalog or authority drifted'
psql_cmd -f "$review_definition"

gate_digest="$(psql_cmd -At -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.read_post_media_coverage_gate_atomic(uuid,text)'::regprocedure;")"
gate_definition="$TMP_ROOT/gate-definition.sql"
gate_tampered_definition="$TMP_ROOT/gate-tampered-definition.sql"
gate_default_definition="$TMP_ROOT/gate-default-definition.sql"
psql_cmd -At -c "SELECT pg_get_functiondef('public.read_post_media_coverage_gate_atomic(uuid,text)'::regprocedure);" >"$gate_definition"
psql_cmd -At >"$gate_tampered_definition" <<'SQL'
SELECT replace(
  pg_get_functiondef('public.read_post_media_coverage_gate_atomic(uuid,text)'::regprocedure),
  'v_snapshot_inventory_complete := v_run.state=''sealed'';',
  'v_snapshot_inventory_complete := false;'
);
SQL
psql_cmd -f "$gate_tampered_definition"
tampered_gate_digest="$(psql_cmd -At -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.read_post_media_coverage_gate_atomic(uuid,text)'::regprocedure;")"
if [[ "$tampered_gate_digest" == "$gate_digest" ]]; then
  echo 'gate body tamper did not change reviewed source' >&2
  exit 1
fi
psql_cmd -c "COMMENT ON FUNCTION public.read_post_media_coverage_gate_atomic(uuid,text) IS 'post-media-coverage:gate-v1:$tampered_gate_digest';"
expect_migration_failure_matching source-body-syncseal-drift 'existing publication drifted'
psql_cmd -f "$gate_definition"
psql_cmd -c "COMMENT ON FUNCTION public.read_post_media_coverage_gate_atomic(uuid,text) IS 'post-media-coverage:gate-v1:$gate_digest';"

psql_cmd -At >"$gate_default_definition" <<'SQL'
SELECT replace(
  pg_get_functiondef('public.read_post_media_coverage_gate_atomic(uuid,text)'::regprocedure),
  'p_scope text)',
  'p_scope text DEFAULT ''all''::text)'
);
SQL
psql_cmd -f "$gate_default_definition"
expect_migration_failure_matching function-default-metadata 'existing publication drifted'
psql_cmd -c 'DROP FUNCTION public.read_post_media_coverage_gate_atomic(uuid,text);'
psql_cmd -f "$gate_definition"
psql_cmd -c 'ALTER FUNCTION public.read_post_media_coverage_gate_atomic(uuid,text) OWNER TO postgres; REVOKE ALL ON FUNCTION public.read_post_media_coverage_gate_atomic(uuid,text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.read_post_media_coverage_gate_atomic(uuid,text) TO service_role;'
psql_cmd -c "COMMENT ON FUNCTION public.read_post_media_coverage_gate_atomic(uuid,text) IS 'post-media-coverage:gate-v1:$gate_digest';"

psql_cmd -c "COMMENT ON FUNCTION public.read_post_media_coverage_gate_atomic(uuid,text) IS 'hostile';"
expect_migration_failure_matching source-comment-drift 'existing publication drifted'
psql_cmd -c "COMMENT ON FUNCTION public.read_post_media_coverage_gate_atomic(uuid,text) IS 'post-media-coverage:gate-v1:$gate_digest';"

psql_cmd -c 'ALTER TABLE public.post_media_coverage_targets DISABLE TRIGGER ALL;'
expect_migration_failure_matching ri-trigger-disabled 'RI trigger seal failed'
psql_cmd -c 'ALTER TABLE public.post_media_coverage_targets ENABLE TRIGGER ALL;'

echo 'rollback and final exact replay'
psql_cmd -f "$COVERAGE_MIGRATION"
assert_scalar '5|7|0|0' "SELECT
  (SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname LIKE 'post_media_coverage_%' AND relkind='r')||'|'||
  (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('install_post_media_coverage_origin_atomic','classify_post_media_reference_lexical_internal','start_post_media_coverage_inventory_atomic','enqueue_post_media_coverage_inventory_atomic','observe_post_media_coverage_inventory_atomic','seal_post_media_coverage_inventory_atomic','read_post_media_coverage_gate_atomic'))||'|'||
  (SELECT count(*) FROM pg_policy WHERE polrelid IN ('public.post_media_coverage_config'::regclass,'public.post_media_coverage_runs'::regclass,'public.post_media_coverage_targets'::regclass,'public.post_media_coverage_attempts'::regclass,'public.post_media_coverage_references'::regclass))||'|'||
  (SELECT count(*) FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('install_post_media_coverage_origin_atomic','classify_post_media_reference_lexical_internal') AND a.grantee<>p.proowner);"
if [[ "$(source_hashes)" != "$empty_source_hashes" ]]; then
  echo 'source mutation hashes changed during drift/replay proofs' >&2
  exit 1
fi

echo 'source mutation hashes'
echo 'POST MEDIA COVERAGE PG17: PASS'
