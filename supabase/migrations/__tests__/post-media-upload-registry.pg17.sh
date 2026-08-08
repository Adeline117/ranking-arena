#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260803110000_post_media_upload_registry.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/post-media-upload-registry-pg17.XXXXXX)"
PGDATA="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT="$((57500 + ($$ % 400)))"

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
"$PG_BIN/initdb" \
  -D "$PGDATA" \
  --auth=trust \
  --username=postgres \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$PGDATA" \
  -l "$LOG_DIR/postgres.log" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

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

reserve_service_to_log() {
  local log_file="$1"
  local upload_id="$2"
  local owner_id="$3"
  local object_name="$4"
  local purpose="$5"
  local mime_type="$6"
  local size_bytes="$7"

  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -q -At \
    -v VERBOSITY=verbose \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres \
    -c "SET statement_timeout = '20s';
        SET ROLE service_role;
        SET request.jwt.claim.role = 'service_role';
        SELECT public.reserve_post_media_upload_atomic(
          '$upload_id', '$owner_id', '$object_name',
          '$purpose', '$mime_type', $size_bytes
        )->>'status'" >"$log_file" 2>&1
}

psql_cmd <<'SQL'
CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE authenticator NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
CREATE ROLE hostile_extension NOLOGIN NOINHERIT;
CREATE ROLE hostile_bridge NOLOGIN NOINHERIT;
CREATE ROLE hostile_bypass NOLOGIN NOINHERIT BYPASSRLS;
CREATE ROLE hostile_super NOLOGIN NOINHERIT SUPERUSER;

-- Canonical Supabase role graph: authenticator may SET ROLE to service_role,
-- but never inherits its BYPASSRLS authority implicitly.
GRANT service_role TO authenticator
  WITH INHERIT FALSE, SET TRUE;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.role', true),
    ''
  )
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
  ('10000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000002');
SQL

psql_cmd -f "$MIGRATION"

# canonical_authenticator_set_edge: PostgreSQL 17 SET-only service access is a
# supported Supabase boundary and must not be confused with browser escalation.
assert_scalar 'false|false|true|false|true' \
  "SELECT membership.admin_option::text || '|' ||
          membership.inherit_option::text || '|' ||
          membership.set_option::text || '|' ||
          authenticator.rolbypassrls::text || '|' ||
          service.rolbypassrls::text
     FROM pg_catalog.pg_auth_members AS membership
     JOIN pg_catalog.pg_roles AS authenticator
       ON authenticator.oid = membership.member
     JOIN pg_catalog.pg_roles AS service
       ON service.oid = membership.roleid
    WHERE authenticator.rolname = 'authenticator'
      AND service.rolname = 'service_role'"

# missing_canonical_authenticator_edge: service authority is not valid unless
# the exact reviewed authenticator membership exists.
psql_cmd -c 'REVOKE service_role FROM authenticator'
expect_failure_matching missing_canonical_authenticator_edge 'role graph is unsafe' \
  "\i $MIGRATION"
psql_cmd -c \
  'GRANT service_role TO authenticator WITH ADMIN FALSE, INHERIT FALSE, SET TRUE'
psql_cmd -f "$MIGRATION"

# authenticator_admin_edge: ADMIN can mint SET or INHERIT authority for other
# roles, so even the canonical member/name pair fails when ADMIN is true.
psql_cmd -c 'REVOKE service_role FROM authenticator'
psql_cmd -c \
  'GRANT service_role TO authenticator WITH ADMIN TRUE, INHERIT FALSE, SET TRUE'
expect_failure_matching authenticator_admin_edge 'role graph is unsafe' \
  "\i $MIGRATION"
psql_cmd -c 'REVOKE service_role FROM authenticator'
psql_cmd -c \
  'GRANT service_role TO authenticator WITH ADMIN FALSE, INHERIT FALSE, SET TRUE'
psql_cmd -f "$MIGRATION"

# unknown_service_member_set_only: direct service_role membership is closed to
# unknown roles even when the edge is SET-only and non-inheriting.
psql_cmd -c \
  'GRANT service_role TO hostile_extension WITH ADMIN FALSE, INHERIT FALSE, SET TRUE'
expect_failure_matching unknown_service_member_set_only 'role graph is unsafe' \
  "\i $MIGRATION"
psql_cmd -c 'REVOKE service_role FROM hostile_extension'
psql_cmd -f "$MIGRATION"

# unknown_service_member_admin_only: direct unknown ADMIN-only membership is
# also rejected even though it grants neither SET nor INHERIT to that member.
psql_cmd -c \
  'GRANT service_role TO hostile_extension WITH ADMIN TRUE, INHERIT FALSE, SET FALSE'
expect_failure_matching unknown_service_member_admin_only 'role graph is unsafe' \
  "\i $MIGRATION"
psql_cmd -c 'REVOKE service_role FROM hostile_extension'
psql_cmd -f "$MIGRATION"

# anon_set_only_service_path: pg_has_role(..., 'USAGE') is not a complete SET
# ROLE proof. Even INHERIT FALSE browser access to service_role is rejected.
psql_cmd -c \
  'GRANT service_role TO anon WITH INHERIT FALSE, SET TRUE'
expect_failure_matching anon_set_only_service_path 'role graph is unsafe' \
  "\i $MIGRATION"
psql_cmd -c 'REVOKE service_role FROM anon'
psql_cmd -f "$MIGRATION"

# recursive_authenticated_bypass_path: nested membership is traversed until a
# BYPASSRLS target is found, with a visited set preventing recursive loops.
psql_cmd <<'SQL'
GRANT hostile_bypass TO hostile_bridge
  WITH INHERIT TRUE, SET FALSE;
GRANT hostile_bridge TO authenticated
  WITH INHERIT TRUE, SET FALSE;
SQL
expect_failure_matching recursive_authenticated_bypass_path 'role graph is unsafe' \
  "\i $MIGRATION"
psql_cmd <<'SQL'
REVOKE hostile_bridge FROM authenticated;
REVOKE hostile_bypass FROM hostile_bridge;
SQL
psql_cmd -f "$MIGRATION"

# authenticator_high_privilege_path: the one canonical service edge does not
# permit authenticator to reach postgres or an unrelated elevated role.
psql_cmd -c \
  'GRANT postgres TO authenticator WITH INHERIT FALSE, SET TRUE'
expect_failure_matching authenticator_high_privilege_path 'role graph is unsafe' \
  "\i $MIGRATION"
psql_cmd -c 'REVOKE postgres FROM authenticator'
psql_cmd -f "$MIGRATION"

# service_super_path: service_role may itself be BYPASSRLS, but it must remain
# NOSUPER and have no recursive SET/INHERIT path to a superuser.
psql_cmd -c \
  'GRANT hostile_super TO service_role WITH INHERIT FALSE, SET TRUE'
expect_failure_matching service_super_path 'role graph is unsafe' \
  "\i $MIGRATION"
psql_cmd -c 'REVOKE hostile_super FROM service_role'
psql_cmd -f "$MIGRATION"

# private_service_only_shape: the registry is FORCE-RLS private, deliberately
# has no account FK/cascade, grants, policy, cleanup trigger, or GC function.
assert_scalar 'postgres|true|true|0|0|0|3' \
  "SELECT relation.relowner::pg_catalog.regrole::text || '|' ||
          relation.relrowsecurity::text || '|' ||
          relation.relforcerowsecurity::text || '|' ||
          (SELECT count(*) FROM pg_catalog.pg_constraint
            WHERE conrelid = relation.oid AND contype = 'f') || '|' ||
          (SELECT count(*) FROM pg_catalog.pg_policy
            WHERE polrelid = relation.oid) || '|' ||
          (SELECT count(*) FROM pg_catalog.pg_trigger
            WHERE tgrelid = relation.oid AND NOT tgisinternal) || '|' ||
          (SELECT count(*) FROM pg_catalog.pg_index
            WHERE indrelid = relation.oid)
     FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.post_media_uploads'::regclass"
assert_scalar '0|0|0' \
  "SELECT
     (SELECT count(*)
        FROM pg_catalog.pg_class AS relation
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
        ) AS acl_entry
       WHERE relation.oid = 'public.post_media_uploads'::regclass
         AND acl_entry.grantee <> relation.relowner) || '|' ||
     (SELECT count(*)
        FROM pg_catalog.pg_attribute AS attribute
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
       WHERE attribute.attrelid = 'public.post_media_uploads'::regclass
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND acl_entry.grantee <> pg_catalog.to_regrole('postgres')) || '|' ||
     (SELECT count(*)
        FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.pronamespace = 'public'::regnamespace
         AND function_row.proname ~ '(lease|claim|cleanup|delete).*post_media')"

assert_scalar 'postgres|postgres|true|true|false|false' \
  "SELECT
     (SELECT proowner::regrole::text
        FROM pg_catalog.pg_proc
       WHERE oid = 'public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)'::regprocedure)
     || '|' ||
     (SELECT proowner::regrole::text
        FROM pg_catalog.pg_proc
       WHERE oid = 'public.finalize_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)'::regprocedure)
     || '|' ||
     has_function_privilege(
       'service_role',
       'public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)',
       'EXECUTE'
     )::text || '|' ||
     has_function_privilege(
       'service_role',
       'public.finalize_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)',
       'EXECUTE'
     )::text || '|' ||
     has_function_privilege(
       'authenticated',
       'public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)',
       'EXECUTE'
     )::text || '|' ||
     has_table_privilege(
       'service_role', 'public.post_media_uploads', 'SELECT'
     )::text"

expect_failure_matching service_direct_table_denied 'permission denied' \
  "SET ROLE service_role; SELECT count(*) FROM public.post_media_uploads"
expect_failure_matching browser_function_denied 'permission denied' \
  "SET ROLE authenticated;
   SET request.jwt.claim.role = 'service_role';
   SELECT public.reserve_post_media_upload_atomic(
     '20000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000001/image.webp',
     'post_image', 'image/webp', 1024
   )"

UPLOAD_ONE='20000000-0000-0000-0000-000000000001'
UPLOAD_TWO='20000000-0000-0000-0000-000000000002'
UPLOAD_THREE='20000000-0000-0000-0000-000000000003'
OWNER_ONE='10000000-0000-0000-0000-000000000001'
OWNER_TWO='10000000-0000-0000-0000-000000000002'
OBJECT_ONE="$OWNER_ONE/30000000-0000-0000-0000-000000000001.webp"
OBJECT_TWO="$OWNER_ONE/videos/30000000-0000-0000-0000-000000000002.mp4"
OBJECT_THREE="$OWNER_TWO/30000000-0000-0000-0000-000000000003.avif"

# null_purpose_no_constraint_oracle: both service entrypoints reject NULL with
# the controlled 22023 validation error before locks, reads, or a raw CHECK.
expect_failure_matching null_reserve_purpose \
  'ERROR:  22023: invalid post media upload reservation' \
  "SET ROLE service_role;
   SET request.jwt.claim.role = 'service_role';
   SELECT public.reserve_post_media_upload_atomic(
     '21000000-0000-0000-0000-000000000001', '$OWNER_ONE', '$OBJECT_ONE',
     NULL, 'image/webp', 1024
   )"
expect_failure_matching null_finalize_purpose \
  'ERROR:  22023: invalid post media upload finalization' \
  "SET ROLE service_role;
   SET request.jwt.claim.role = 'service_role';
   SELECT public.finalize_post_media_upload_atomic(
     '21000000-0000-0000-0000-000000000002', '$OWNER_ONE', '$OBJECT_ONE',
     NULL, 'image/webp', 1024
   )"
assert_scalar '0' 'SELECT count(*) FROM public.post_media_uploads'

# owner_bound_server_paths: new reservations accept only the route-issued,
# owner-prefixed UUID path and the one extension bound to the sniffed MIME.
expect_failure_matching cross_owner_object_path \
  'ERROR:  22023: invalid post media upload reservation' \
  "SET ROLE service_role;
   SET request.jwt.claim.role = 'service_role';
   SELECT public.reserve_post_media_upload_atomic(
     '21000000-0000-0000-0000-000000000003', '$OWNER_ONE',
     '$OWNER_TWO/30000000-0000-0000-0000-000000000004.webp',
     'post_image', 'image/webp', 1024
   )"
expect_failure_matching arbitrary_object_filename \
  'ERROR:  22023: invalid post media upload reservation' \
  "SET ROLE service_role;
   SET request.jwt.claim.role = 'service_role';
   SELECT public.reserve_post_media_upload_atomic(
     '21000000-0000-0000-0000-000000000004', '$OWNER_ONE',
     '$OWNER_ONE/not-a-uuid.webp',
     'post_image', 'image/webp', 1024
   )"
expect_failure_matching suffix_mime_mismatch \
  'ERROR:  22023: invalid post media upload reservation' \
  "SET ROLE service_role;
   SET request.jwt.claim.role = 'service_role';
   SELECT public.reserve_post_media_upload_atomic(
     '21000000-0000-0000-0000-000000000005', '$OWNER_ONE',
     '$OWNER_ONE/30000000-0000-0000-0000-000000000005.png',
     'post_image', 'image/webp', 1024
   )"
assert_scalar '0' 'SELECT count(*) FROM public.post_media_uploads'

# The table independently rejects a path that bypasses the reserve validator.
expect_failure_matching table_owner_path_check \
  'post_media_uploads_media_check' \
  "INSERT INTO public.post_media_uploads (
     upload_id, owner_id, object_name, purpose, mime_type, size_bytes,
     expires_at
   ) VALUES (
     '21000000-0000-0000-0000-000000000006', '$OWNER_ONE',
     '$OWNER_TWO/30000000-0000-0000-0000-000000000006.webp',
     'post_image', 'image/webp', 1024,
     statement_timestamp() + interval '1 hour'
   )"
assert_scalar '0' 'SELECT count(*) FROM public.post_media_uploads'

# reservation_idempotency: exact retries return the canonical reservation and
# preserve its server-owned expiry; equivocation cannot rewrite the identity.
assert_service 'reserved|false|5' \
  "SELECT (result->>'status') || '|' || (result->>'replayed') || '|' ||
          (SELECT count(*) FROM jsonb_object_keys(result))
     FROM (SELECT public.reserve_post_media_upload_atomic(
       '$UPLOAD_ONE', '$OWNER_ONE', '$OBJECT_ONE',
       'post_image', 'image/webp', 1024
     ) AS result) AS reservation"
first_expiry="$(psql_cmd -At -c "SELECT expires_at::text FROM public.post_media_uploads WHERE upload_id = '$UPLOAD_ONE'")"
assert_service 'reserved|true' \
  "SELECT (result->>'status') || '|' || (result->>'replayed')
     FROM (SELECT public.reserve_post_media_upload_atomic(
       '$UPLOAD_ONE', '$OWNER_ONE', '$OBJECT_ONE',
       'post_image', 'image/webp', 1024
     ) AS result) AS reservation"
assert_scalar '1' \
  "SELECT count(*) FROM public.post_media_uploads WHERE upload_id = '$UPLOAD_ONE'"
assert_scalar "$first_expiry" \
  "SELECT expires_at::text FROM public.post_media_uploads WHERE upload_id = '$UPLOAD_ONE'"
expect_failure_matching reserve_identity_conflict 'reservation identity conflict' \
  "SET ROLE service_role;
   SET request.jwt.claim.role = 'service_role';
   SELECT public.reserve_post_media_upload_atomic(
     '$UPLOAD_ONE', '$OWNER_ONE', '$OBJECT_ONE',
     'post_image', 'image/webp', 1025
   )"
expect_failure_matching object_identity_conflict 'object identity conflict' \
  "SET ROLE service_role;
   SET request.jwt.claim.role = 'service_role';
   SELECT public.reserve_post_media_upload_atomic(
     '$UPLOAD_TWO', '$OWNER_ONE', '$OBJECT_ONE',
     'post_image', 'image/webp', 1024
   )"
expect_failure_matching unknown_owner_rejected 'owner is unavailable' \
  "SET ROLE service_role;
   SET request.jwt.claim.role = 'service_role';
   SELECT public.reserve_post_media_upload_atomic(
     '$UPLOAD_TWO', '10000000-0000-0000-0000-000000000099',
     '10000000-0000-0000-0000-000000000099/videos/30000000-0000-0000-0000-000000000099.mp4',
     'post_video', 'video/mp4', 2048
   )"

# storage_identity_mismatch: finalize requires the reservation's complete
# identity and an exact storage.objects (bucket_id='posts', name) match.
expect_failure_matching missing_storage_object 'exact posts storage object is unavailable' \
  "SET ROLE service_role;
   SET request.jwt.claim.role = 'service_role';
   SELECT public.finalize_post_media_upload_atomic(
     '$UPLOAD_ONE', '$OWNER_ONE', '$OBJECT_ONE',
     'post_image', 'image/webp', 1024
   )"
psql_cmd -c "INSERT INTO storage.objects (bucket_id, name) VALUES ('avatars', '$OBJECT_ONE')"
expect_failure_matching wrong_storage_bucket 'exact posts storage object is unavailable' \
  "SET ROLE service_role;
   SET request.jwt.claim.role = 'service_role';
   SELECT public.finalize_post_media_upload_atomic(
     '$UPLOAD_ONE', '$OWNER_ONE', '$OBJECT_ONE',
     'post_image', 'image/webp', 1024
   )"
expect_failure_matching finalize_identity_conflict 'finalization identity conflict' \
  "SET ROLE service_role;
   SET request.jwt.claim.role = 'service_role';
   SELECT public.finalize_post_media_upload_atomic(
     '$UPLOAD_ONE', '$OWNER_ONE', '$OBJECT_ONE',
     'group_avatar', 'image/webp', 1024
   )"
assert_scalar 'reserved' \
  "SELECT status FROM public.post_media_uploads WHERE upload_id = '$UPLOAD_ONE'"

psql_cmd -c "INSERT INTO storage.objects (bucket_id, name) VALUES ('posts', '$OBJECT_ONE')"
assert_service 'uploaded|false|5' \
  "SELECT (result->>'status') || '|' || (result->>'replayed') || '|' ||
          (SELECT count(*) FROM jsonb_object_keys(result))
     FROM (SELECT public.finalize_post_media_upload_atomic(
       '$UPLOAD_ONE', '$OWNER_ONE', '$OBJECT_ONE',
       'post_image', 'image/webp', 1024
     ) AS result) AS finalization"
assert_service 'uploaded|true' \
  "SELECT (result->>'status') || '|' || (result->>'replayed')
     FROM (SELECT public.finalize_post_media_upload_atomic(
       '$UPLOAD_ONE', '$OWNER_ONE', '$OBJECT_ONE',
       'post_image', 'image/webp', 1024
     ) AS result) AS finalization"
assert_scalar '1' \
  "SELECT count(*) FROM public.post_media_uploads
    WHERE upload_id = '$UPLOAD_ONE' AND status = 'uploaded'"

# uploaded_replay_survives_expiry: expiry fences unfinished work only. Once an
# exact identity is uploaded, reserve replay remains a durable receipt.
psql_cmd -c \
  "UPDATE public.post_media_uploads
      SET created_at = statement_timestamp() - interval '2 hours',
          expires_at = statement_timestamp() - interval '1 hour'
    WHERE upload_id = '$UPLOAD_ONE'"
assert_service 'uploaded|true' \
  "SELECT (result->>'status') || '|' || (result->>'replayed')
     FROM (SELECT public.reserve_post_media_upload_atomic(
       '$UPLOAD_ONE', '$OWNER_ONE', '$OBJECT_ONE',
       'post_image', 'image/webp', 1024
     ) AS result) AS reservation"

# expiry_fence: a server-expired reservation remains inert even if an exact
# object exists. Finalize neither uploads nor deletes any Storage row.
assert_service 'reserved|false' \
  "SELECT (result->>'status') || '|' || (result->>'replayed')
     FROM (SELECT public.reserve_post_media_upload_atomic(
       '$UPLOAD_TWO', '$OWNER_ONE', '$OBJECT_TWO',
       'post_video', 'video/mp4', 2048
     ) AS result) AS reservation"
psql_cmd -c \
  "INSERT INTO storage.objects (bucket_id, name) VALUES ('posts', '$OBJECT_TWO');
   UPDATE public.post_media_uploads
      SET created_at = statement_timestamp() - interval '2 hours',
          updated_at = statement_timestamp() - interval '2 hours',
          expires_at = statement_timestamp() - interval '1 hour'
    WHERE upload_id = '$UPLOAD_TWO'"
expect_failure_matching expired_reservation 'reservation expired' \
  "SET ROLE service_role;
   SET request.jwt.claim.role = 'service_role';
   SELECT public.finalize_post_media_upload_atomic(
     '$UPLOAD_TWO', '$OWNER_ONE', '$OBJECT_TWO',
     'post_video', 'video/mp4', 2048
   )"

# expired_reservation_replay_fence: exact reserve replay must not hand the
# caller a server-expired, unusable ticket. It returns controlled 22023.
expect_failure_matching expired_reservation_replay \
  'ERROR:  22023: post media upload reservation expired' \
  "SET ROLE service_role;
   SET request.jwt.claim.role = 'service_role';
   SELECT public.reserve_post_media_upload_atomic(
     '$UPLOAD_TWO', '$OWNER_ONE', '$OBJECT_TWO',
     'post_video', 'video/mp4', 2048
   )"
assert_scalar 'reserved|1' \
  "SELECT status || '|' ||
          (SELECT count(*) FROM storage.objects
            WHERE bucket_id = 'posts' AND name = '$OBJECT_TWO')
     FROM public.post_media_uploads WHERE upload_id = '$UPLOAD_TWO'"

# concurrent_same_upload_different_identity: two real sessions contend on one
# upload id with different exact identities. One inserts, one receives 22023;
# neither deadlocks, times out, nor leaks the raw unique constraint.
CONCURRENT_SAME_UPLOAD='22000000-0000-0000-0000-000000000001'
CONCURRENT_OBJECT_A="$OWNER_ONE/32000000-0000-0000-0000-000000000001.webp"
CONCURRENT_OBJECT_B="$OWNER_ONE/32000000-0000-0000-0000-000000000002.webp"
reserve_service_to_log \
  "$LOG_DIR/concurrent-same-upload-a.log" \
  "$CONCURRENT_SAME_UPLOAD" "$OWNER_ONE" "$CONCURRENT_OBJECT_A" \
  post_image image/webp 3072 &
same_upload_pid_a=$!
reserve_service_to_log \
  "$LOG_DIR/concurrent-same-upload-b.log" \
  "$CONCURRENT_SAME_UPLOAD" "$OWNER_ONE" "$CONCURRENT_OBJECT_B" \
  post_image image/webp 3072 &
same_upload_pid_b=$!
set +e
wait "$same_upload_pid_a"
same_upload_status_a=$?
wait "$same_upload_pid_b"
same_upload_status_b=$?
set -e
same_upload_successes=0
if ((same_upload_status_a == 0)); then same_upload_successes=$((same_upload_successes + 1)); fi
if ((same_upload_status_b == 0)); then same_upload_successes=$((same_upload_successes + 1)); fi
if ((same_upload_successes != 1)); then
  cat "$LOG_DIR/concurrent-same-upload-a.log" >&2
  cat "$LOG_DIR/concurrent-same-upload-b.log" >&2
  echo 'Expected exactly one same-upload reservation success' >&2
  exit 1
fi
rg -q '^reserved$' \
  "$LOG_DIR/concurrent-same-upload-a.log" \
  "$LOG_DIR/concurrent-same-upload-b.log"
rg -q 'ERROR:  22023: post media upload reservation identity conflict' \
  "$LOG_DIR/concurrent-same-upload-a.log" \
  "$LOG_DIR/concurrent-same-upload-b.log"
if rg -qi 'deadlock detected|duplicate key|unique constraint|statement timeout|lock timeout' \
  "$LOG_DIR/concurrent-same-upload-a.log" \
  "$LOG_DIR/concurrent-same-upload-b.log"; then
  echo 'Same-upload concurrency leaked an uncontrolled database error' >&2
  exit 1
fi
assert_scalar '1|true' \
  "SELECT count(*) || '|' || bool_and(
     owner_id = '$OWNER_ONE'
     AND object_name IN ('$CONCURRENT_OBJECT_A', '$CONCURRENT_OBJECT_B')
     AND purpose = 'post_image'
     AND mime_type = 'image/webp'
     AND size_bytes = 3072
     AND status = 'reserved'
   )::text
   FROM public.post_media_uploads
   WHERE upload_id = '$CONCURRENT_SAME_UPLOAD'"

# concurrent_different_upload_same_object: sessions lock different upload ids
# before converging on one object-name lock. Exactly one canonical row wins;
# the loser receives the controlled object identity conflict, never 23505.
CONCURRENT_UPLOAD_A='22000000-0000-0000-0000-000000000002'
CONCURRENT_UPLOAD_B='22000000-0000-0000-0000-000000000003'
CONCURRENT_SHARED_OBJECT="$OWNER_ONE/32000000-0000-0000-0000-000000000003.jpg"
reserve_service_to_log \
  "$LOG_DIR/concurrent-same-object-a.log" \
  "$CONCURRENT_UPLOAD_A" "$OWNER_ONE" "$CONCURRENT_SHARED_OBJECT" \
  post_image image/jpeg 4096 &
same_object_pid_a=$!
reserve_service_to_log \
  "$LOG_DIR/concurrent-same-object-b.log" \
  "$CONCURRENT_UPLOAD_B" "$OWNER_ONE" "$CONCURRENT_SHARED_OBJECT" \
  post_image image/jpeg 4096 &
same_object_pid_b=$!
set +e
wait "$same_object_pid_a"
same_object_status_a=$?
wait "$same_object_pid_b"
same_object_status_b=$?
set -e
same_object_successes=0
if ((same_object_status_a == 0)); then same_object_successes=$((same_object_successes + 1)); fi
if ((same_object_status_b == 0)); then same_object_successes=$((same_object_successes + 1)); fi
if ((same_object_successes != 1)); then
  cat "$LOG_DIR/concurrent-same-object-a.log" >&2
  cat "$LOG_DIR/concurrent-same-object-b.log" >&2
  echo 'Expected exactly one same-object reservation success' >&2
  exit 1
fi
rg -q '^reserved$' \
  "$LOG_DIR/concurrent-same-object-a.log" \
  "$LOG_DIR/concurrent-same-object-b.log"
rg -q 'ERROR:  22023: post media upload object identity conflict' \
  "$LOG_DIR/concurrent-same-object-a.log" \
  "$LOG_DIR/concurrent-same-object-b.log"
if rg -qi 'deadlock detected|duplicate key|unique constraint|statement timeout|lock timeout' \
  "$LOG_DIR/concurrent-same-object-a.log" \
  "$LOG_DIR/concurrent-same-object-b.log"; then
  echo 'Same-object concurrency leaked an uncontrolled database error' >&2
  exit 1
fi
assert_scalar '1|true' \
  "SELECT count(*) || '|' || bool_and(
     upload_id IN ('$CONCURRENT_UPLOAD_A', '$CONCURRENT_UPLOAD_B')
     AND owner_id = '$OWNER_ONE'
     AND object_name = '$CONCURRENT_SHARED_OBJECT'
     AND purpose = 'post_image'
     AND mime_type = 'image/jpeg'
     AND size_bytes = 4096
     AND status = 'reserved'
   )::text
   FROM public.post_media_uploads
   WHERE object_name = '$CONCURRENT_SHARED_OBJECT'"

# owner_lifecycle_retention: owner_id deliberately has no cascading FK. A hard
# auth deletion cannot erase the only registry identity for an uploaded blob.
assert_service 'reserved' \
  "SELECT public.reserve_post_media_upload_atomic(
    '$UPLOAD_THREE', '$OWNER_TWO', '$OBJECT_THREE',
    'group_avatar', 'image/avif', 4096
  )->>'status'"
psql_cmd -c "DELETE FROM auth.users WHERE id = '$OWNER_TWO'"
assert_scalar '1|0' \
  "SELECT
     (SELECT count(*) FROM public.post_media_uploads
       WHERE upload_id = '$UPLOAD_THREE' AND owner_id = '$OWNER_TWO') || '|' ||
     (SELECT count(*) FROM auth.users WHERE id = '$OWNER_TWO')"

# hostile_acl_and_ownership_replay: replay discovers unknown relation grants,
# column grants, policies, function grant options, and owner drift, then
# converges them without exposing the private table or changing data.
psql_cmd <<'SQL'
ALTER TABLE public.post_media_uploads OWNER TO hostile_extension;
GRANT SELECT ON TABLE public.post_media_uploads TO hostile_extension;
GRANT UPDATE (status) ON TABLE public.post_media_uploads TO authenticated;
CREATE POLICY "Hostile browser registry read"
  ON public.post_media_uploads FOR SELECT TO authenticated USING (true);
ALTER FUNCTION public.finalize_post_media_upload_atomic(
  uuid, uuid, text, text, text, bigint
) OWNER TO hostile_extension;
GRANT EXECUTE ON FUNCTION public.reserve_post_media_upload_atomic(
  uuid, uuid, text, text, text, bigint
) TO hostile_extension WITH GRANT OPTION;
SQL
psql_cmd -f "$MIGRATION"
assert_scalar 'postgres|postgres|0|0|0|5' \
  "SELECT
     (SELECT relowner::regrole::text FROM pg_catalog.pg_class
       WHERE oid = 'public.post_media_uploads'::regclass) || '|' ||
     (SELECT proowner::regrole::text FROM pg_catalog.pg_proc
       WHERE oid = 'public.finalize_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)'::regprocedure) || '|' ||
     (SELECT count(*) FROM pg_catalog.pg_policy
       WHERE polrelid = 'public.post_media_uploads'::regclass) || '|' ||
     (SELECT count(*)
        FROM pg_catalog.pg_attribute AS attribute
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
       WHERE attribute.attrelid = 'public.post_media_uploads'::regclass
         AND attribute.attnum > 0 AND NOT attribute.attisdropped
         AND acl_entry.grantee <> pg_catalog.to_regrole('postgres')) || '|' ||
     (SELECT count(*)
        FROM pg_catalog.pg_class AS relation
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
        ) AS acl_entry
       WHERE relation.oid = 'public.post_media_uploads'::regclass
         AND acl_entry.grantee <> relation.relowner) || '|' ||
     (SELECT count(*) FROM public.post_media_uploads)"

# hostile_disabled_trigger_drift: every user trigger is forbidden, including a
# disabled trigger. Replay rejects it in table-shape preflight, before either
# SECURITY DEFINER registry function is rebuilt or can perform registry DML.
psql_cmd <<'SQL'
CREATE FUNCTION public.hostile_post_media_registry_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'hostile post media registry trigger fired';
END
$function$;
CREATE TRIGGER hostile_post_media_registry_trigger
BEFORE INSERT OR UPDATE OR DELETE ON public.post_media_uploads
FOR EACH ROW
EXECUTE FUNCTION public.hostile_post_media_registry_trigger();
ALTER TABLE public.post_media_uploads
  DISABLE TRIGGER hostile_post_media_registry_trigger;
SQL
expect_failure_matching hostile_disabled_trigger_drift 'registry table shape drifted' \
  "\i $MIGRATION"
assert_scalar 'D|5' \
  "SELECT trigger_row.tgenabled::text || '|' ||
          (SELECT count(*) FROM public.post_media_uploads)
     FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.post_media_uploads'::regclass
      AND trigger_row.tgname = 'hostile_post_media_registry_trigger'
      AND NOT trigger_row.tgisinternal"
psql_cmd <<'SQL'
DROP TRIGGER hostile_post_media_registry_trigger
  ON public.post_media_uploads;
DROP FUNCTION public.hostile_post_media_registry_trigger();
SQL
psql_cmd -f "$MIGRATION"

# table_shape_drift: IF NOT EXISTS cannot silently accept extra columns.
psql_cmd -c 'ALTER TABLE public.post_media_uploads ADD COLUMN hostile_text text'
expect_failure_matching table_shape_drift 'registry table shape drifted' \
  "\i $MIGRATION"
psql_cmd -c 'ALTER TABLE public.post_media_uploads DROP COLUMN hostile_text'
psql_cmd -f "$MIGRATION"

# same_name_check_body_drift: an attacker cannot retain the reviewed name while
# replacing the status predicate with a permissive body.
psql_cmd <<'SQL'
ALTER TABLE public.post_media_uploads
  DROP CONSTRAINT post_media_uploads_status_check;
ALTER TABLE public.post_media_uploads
  ADD CONSTRAINT post_media_uploads_status_check
  CHECK (status IN ('reserved', 'uploaded') OR true);
SQL
expect_failure_matching same_name_check_body_drift 'registry table shape drifted' \
  "\i $MIGRATION"
psql_cmd <<'SQL'
ALTER TABLE public.post_media_uploads
  DROP CONSTRAINT post_media_uploads_status_check;
ALTER TABLE public.post_media_uploads
  ADD CONSTRAINT post_media_uploads_status_check
  CHECK (status IN ('reserved', 'uploaded'));
SQL
psql_cmd -f "$MIGRATION"

# expiry_index_definition_drift: the column list alone is not a definition;
# explicit hostile NULL ordering is rejected by the reviewed index digest.
psql_cmd <<'SQL'
DROP INDEX public.post_media_uploads_expiry_idx;
CREATE INDEX post_media_uploads_expiry_idx
  ON public.post_media_uploads (
    status ASC NULLS FIRST,
    expires_at,
    upload_id
  );
SQL
expect_failure_matching expiry_index_definition_drift 'registry index shape drifted' \
  "\i $MIGRATION"
psql_cmd <<'SQL'
DROP INDEX public.post_media_uploads_expiry_idx;
CREATE INDEX post_media_uploads_expiry_idx
  ON public.post_media_uploads (status, expires_at, upload_id);
SQL
psql_cmd -f "$MIGRATION"

# function_source_seal_drift: a body edit retaining the old comment is rejected
# before CREATE OR REPLACE can erase evidence of the drift.
psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.reserve_post_media_upload_atomic(
  p_upload_id uuid,
  p_owner_id uuid,
  p_object_name text,
  p_purpose text,
  p_mime_type text,
  p_size_bytes bigint
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
BEGIN
  RETURN '{}'::jsonb;
END
$function$;
SQL
expect_failure_matching function_source_seal_drift 'function source seal drifted' \
  "\i $MIGRATION"
psql_cmd -c \
  'DROP FUNCTION public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)'
psql_cmd -f "$MIGRATION"

# migration_replay_with_data: canonical replay preserves all reservations and
# the exact finalized state; the substrate still has no GC admission.
psql_cmd -f "$MIGRATION"
assert_scalar '5|1|4|0|0' \
  "SELECT count(*) || '|' ||
          count(*) FILTER (WHERE status = 'uploaded') || '|' ||
          count(*) FILTER (WHERE status = 'reserved') || '|' ||
          count(*) FILTER (WHERE gc_admitted_at IS NOT NULL) || '|' ||
          (SELECT count(*) FROM pg_catalog.pg_policy
            WHERE polrelid = 'public.post_media_uploads'::regclass)
     FROM public.post_media_uploads"

echo 'post media upload registry PostgreSQL 17 proof passed'
