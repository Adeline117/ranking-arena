#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729185500_post_media_storage.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/post-media-storage-pg17.XXXXXX)"
PGDATA="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT="$((57000 + ($$ % 500)))"

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

psql_db() {
  local database="$1"
  shift
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -q \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d "$database" "$@"
}

psql_owner() {
  psql_db postgres "$@"
}

psql_identity() {
  psql_db identity "$@"
}

psql_managed_root() {
  psql_db managed "$@"
}

psql_managed_deployer() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -q \
    -h "$SOCKET_DIR" -p "$PORT" -U fixture_deployer -d managed "$@"
}

expect_failure_matching() {
  local label="$1"
  local pattern="$2"
  shift 2
  local failure_log="$LOG_DIR/$label.log"
  if "$@" >"$failure_log" 2>&1; then
    echo "Expected failure: $label" >&2
    return 1
  fi
  if ! rg -q "$pattern" "$failure_log"; then
    echo "Failure did not match '$pattern': $label" >&2
    cat "$failure_log" >&2
    return 1
  fi
}

psql_owner <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE authenticator NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE supabase_storage_admin NOLOGIN;
CREATE ROLE fixture_deployer LOGIN BYPASSRLS;

CREATE SCHEMA storage AUTHORIZATION postgres;
CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  public boolean,
  file_size_limit bigint,
  allowed_mime_types text[]
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  bucket_id text,
  name text,
  UNIQUE (bucket_id, name)
);
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA storage
  TO anon, authenticated, authenticator, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.buckets
  TO anon, authenticated, authenticator, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects
  TO anon, authenticated, authenticator, service_role;

CREATE POLICY "Public can read avatars"
  ON storage.objects FOR SELECT TO PUBLIC
  USING (bucket_id = 'avatars');
CREATE POLICY "Authenticated can upload avatars"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND name LIKE 'users/%');

CREATE OR REPLACE FUNCTION storage.corrupt_posts_bucket_contract()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.id = 'posts' THEN
    NEW.public := false;
    NEW.file_size_limit := 1;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER corrupt_posts_bucket_contract
BEFORE INSERT OR UPDATE ON storage.buckets
FOR EACH ROW EXECUTE FUNCTION storage.corrupt_posts_bucket_contract();
SQL

owner_before="$(psql_owner -At -c "SELECT relowner::regrole::text || '|' || COALESCE(relacl::text, '<null>') FROM pg_catalog.pg_class WHERE oid IN ('storage.buckets'::regclass, 'storage.objects'::regclass) ORDER BY oid")"

expect_failure_matching \
  owner_atomic_rollback \
  'post media bucket contract is invalid' \
  psql_owner -f "$MIGRATION"
[[ "$(psql_owner -At -c "SELECT count(*) FROM storage.buckets WHERE id = 'posts'")" == '0' ]]
[[ "$(psql_owner -At -c "SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid = 'storage.objects'::regclass AND polname LIKE '%post media%'")" == '0' ]]
echo 'failed rollout remained atomic'

psql_owner <<'SQL'
DROP TRIGGER corrupt_posts_bucket_contract ON storage.buckets;
DROP FUNCTION storage.corrupt_posts_bucket_contract();
SQL

psql_owner -f "$MIGRATION"
[[ "$(psql_owner -At -c "SELECT count(*) FROM storage.buckets WHERE id = 'posts' AND name = 'posts' AND public IS true AND file_size_limit = 104857600")" == '1' ]]
[[ "$(psql_owner -At -c "SELECT allowed_mime_types::text FROM storage.buckets WHERE id = 'posts'")" == '{image/jpeg,image/png,image/gif,image/webp,image/avif,video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo}' ]]
echo 'missing bucket created'

LEGACY_OBJECT="11111111-1111-4111-8111-111111111111"
psql_owner -v object_id="$LEGACY_OBJECT" <<'SQL'
INSERT INTO storage.objects (id, bucket_id, name)
VALUES (:'object_id', 'posts', 'legacy/keep.webp');
UPDATE storage.buckets
SET name = 'posts-legacy',
    public = false,
    file_size_limit = 1024,
    allowed_mime_types = ARRAY['text/html']::text[]
WHERE id = 'posts';
SQL

psql_owner -f "$MIGRATION"
[[ "$(psql_owner -At -c "SELECT count(*) FROM storage.objects WHERE id = '$LEGACY_OBJECT'::uuid AND bucket_id = 'posts' AND name = 'legacy/keep.webp'")" == '1' ]]
[[ "$(psql_owner -At -c "SELECT name = 'posts' AND public IS true AND file_size_limit = 104857600 AND allowed_mime_types = ARRAY['image/jpeg','image/png','image/gif','image/webp','image/avif','video/mp4','video/quicktime','video/webm','video/x-matroska','video/x-msvideo']::text[] FROM storage.buckets WHERE id = 'posts'")" == 't' ]]
echo 'drift converged without object loss'

psql_owner -f "$MIGRATION"
owner_after="$(psql_owner -At -c "SELECT relowner::regrole::text || '|' || COALESCE(relacl::text, '<null>') FROM pg_catalog.pg_class WHERE oid IN ('storage.buckets'::regclass, 'storage.objects'::regclass) ORDER BY oid")"
[[ "$owner_before" == "$owner_after" ]]
echo 'owner migration replay'

for browser_role in anon authenticated authenticator; do
  visible="$(psql_owner -At -v browser_role="$browser_role" <<'SQL'
SELECT pg_catalog.set_config('role', :'browser_role', false);
SELECT count(*) FROM storage.objects WHERE bucket_id = 'posts';
SQL
)"
  [[ "$(tail -1 <<<"$visible")" == '0' ]]
  bucket_visible="$(psql_owner -At -v browser_role="$browser_role" <<'SQL'
SELECT pg_catalog.set_config('role', :'browser_role', false);
SELECT count(*) FROM storage.buckets WHERE id = 'posts';
SQL
)"
  [[ "$(tail -1 <<<"$bucket_visible")" == '0' ]]
done

expect_failure_matching \
  browser_insert \
  'violates row-level security policy' \
  psql_owner -c "SET ROLE authenticated; INSERT INTO storage.objects(bucket_id, name) VALUES ('posts', 'blocked.webp');"

psql_owner <<'SQL'
SET ROLE authenticated;
UPDATE storage.objects
SET name = 'legacy/changed.webp'
WHERE bucket_id = 'posts';
DELETE FROM storage.objects WHERE bucket_id = 'posts';
UPDATE storage.buckets
SET public = false, file_size_limit = 1
WHERE id = 'posts';
DELETE FROM storage.buckets WHERE id = 'posts';
SQL
[[ "$(psql_owner -At -c "SELECT count(*) FROM storage.objects WHERE id = '$LEGACY_OBJECT'::uuid AND name = 'legacy/keep.webp'")" == '1' ]]
[[ "$(psql_owner -At -c "SELECT count(*) FROM storage.buckets WHERE id = 'posts' AND public IS true AND file_size_limit = 104857600")" == '1' ]]
echo 'browser direct storage access denied'

SERVICE_OBJECT="22222222-2222-4222-8222-222222222222"
psql_owner -v object_id="$SERVICE_OBJECT" <<'SQL'
SET ROLE service_role;
INSERT INTO storage.objects (id, bucket_id, name)
VALUES (:'object_id', 'posts', 'service/create.mp4');
UPDATE storage.objects
SET name = 'service/updated.mp4'
WHERE id = :'object_id';
SQL
service_visible="$(psql_owner -At -c "SET ROLE service_role; SELECT count(*) FROM storage.objects WHERE id = '$SERVICE_OBJECT'::uuid AND bucket_id = 'posts' AND name = 'service/updated.mp4'")"
[[ "$(tail -1 <<<"$service_visible")" == '1' ]]
psql_owner -c "SET ROLE service_role; DELETE FROM storage.objects WHERE id = '$SERVICE_OBJECT'::uuid" >/dev/null
[[ "$(psql_owner -At -c "SELECT count(*) FROM storage.objects WHERE id = '$SERVICE_OBJECT'::uuid")" == '0' ]]
echo 'service object CRUD retained'

psql_owner -c 'GRANT service_role TO authenticated' >/dev/null
expect_failure_matching \
  browser_service_escalation \
  'browser role can assume the post media service role' \
  psql_owner -f "$MIGRATION"
psql_owner -c 'REVOKE service_role FROM authenticated' >/dev/null
[[ "$(psql_owner -At -c "SELECT count(*) FROM storage.objects WHERE id = '$LEGACY_OBJECT'::uuid AND name = 'legacy/keep.webp'")" == '1' ]]
echo 'browser service-role escalation failed closed'

# A pre-existing name owned by a different bucket id is not repaired because
# changing bucket ids would require moving storage.objects rows.
psql_owner -c 'CREATE DATABASE identity' >/dev/null
psql_identity <<'SQL'
CREATE SCHEMA storage AUTHORIZATION postgres;
CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  public boolean,
  file_size_limit bigint,
  allowed_mime_types text[]
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  bucket_id text,
  name text,
  UNIQUE (bucket_id, name)
);
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage
  TO anon, authenticated, authenticator, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.buckets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO service_role;
INSERT INTO storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) VALUES ('legacy-posts', 'posts', false, 1, ARRAY['text/html']::text[]);
INSERT INTO storage.objects (bucket_id, name)
VALUES ('legacy-posts', 'legacy/do-not-move.html');
SQL

expect_failure_matching \
  identity_ambiguity \
  'posts bucket name belongs to a different bucket id' \
  psql_identity -f "$MIGRATION"
[[ "$(psql_identity -At -c "SELECT count(*) FROM storage.buckets WHERE id = 'legacy-posts' AND name = 'posts' AND public IS false")" == '1' ]]
[[ "$(psql_identity -At -c "SELECT count(*) FROM storage.objects WHERE bucket_id = 'legacy-posts' AND name = 'legacy/do-not-move.html'")" == '1' ]]
[[ "$(psql_identity -At -c "SELECT count(*) FROM storage.buckets WHERE id = 'posts'")" == '0' ]]
echo 'identity ambiguity failed closed'

# Managed mode retains supabase_storage_admin ownership and all relation ACLs.
# Its browser policy set must be provably exclusive of posts; service_role uses
# the standard Supabase BYPASSRLS attribute.
psql_owner -c 'ALTER ROLE service_role BYPASSRLS' >/dev/null
psql_owner -c 'CREATE DATABASE managed' >/dev/null
psql_managed_root <<'SQL'
CREATE SCHEMA storage AUTHORIZATION supabase_storage_admin;
SET ROLE supabase_storage_admin;
CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  public boolean,
  file_size_limit bigint,
  allowed_mime_types text[]
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  bucket_id text,
  name text,
  UNIQUE (bucket_id, name)
);
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Managed avatar reads"
  ON storage.objects FOR SELECT TO PUBLIC
  USING (bucket_id = 'avatars');
CREATE POLICY "Managed avatar writes"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND name LIKE 'users/%');
INSERT INTO storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) VALUES ('posts', 'posts-old', false, 2048, ARRAY['text/html']::text[]);
INSERT INTO storage.objects (bucket_id, name)
VALUES ('posts', 'legacy/managed.webp');
RESET ROLE;

GRANT USAGE ON SCHEMA storage
  TO anon, authenticated, authenticator, service_role, fixture_deployer;
GRANT SELECT, INSERT, UPDATE ON storage.buckets TO fixture_deployer;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.buckets
  TO anon, authenticated, authenticator, service_role;
GRANT SELECT, UPDATE ON storage.objects TO fixture_deployer;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects
  TO anon, authenticated, authenticator, service_role;
SQL

managed_before="$(psql_managed_root -At -c "SELECT relowner::regrole::text || '|' || COALESCE(relacl::text, '<null>') FROM pg_catalog.pg_class WHERE oid IN ('storage.buckets'::regclass, 'storage.objects'::regclass) ORDER BY oid")"
psql_managed_root -c 'GRANT supabase_storage_admin TO authenticated' >/dev/null
expect_failure_matching \
  managed_owner_escalation \
  'browser role can assume the managed Storage owner' \
  psql_managed_deployer -f "$MIGRATION"
psql_managed_root -c 'REVOKE supabase_storage_admin FROM authenticated' >/dev/null
[[ "$(psql_managed_root -At -c "SELECT count(*) FROM storage.buckets WHERE id = 'posts' AND name = 'posts-old' AND public IS false AND file_size_limit = 2048")" == '1' ]]
echo 'managed owner escalation failed closed'

psql_managed_deployer -f "$MIGRATION"
psql_managed_deployer -f "$MIGRATION"
managed_after="$(psql_managed_root -At -c "SELECT relowner::regrole::text || '|' || COALESCE(relacl::text, '<null>') FROM pg_catalog.pg_class WHERE oid IN ('storage.buckets'::regclass, 'storage.objects'::regclass) ORDER BY oid")"
[[ "$managed_before" == "$managed_after" ]]
[[ "$(psql_managed_root -At -c "SELECT count(*) FROM storage.buckets WHERE id = 'posts' AND name = 'posts' AND public IS true AND file_size_limit = 104857600")" == '1' ]]
[[ "$(psql_managed_root -At -c "SELECT count(*) FROM storage.objects WHERE bucket_id = 'posts' AND name = 'legacy/managed.webp'")" == '1' ]]
[[ "$(psql_managed_root -At -c "SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid = 'storage.objects'::regclass AND polname LIKE '%post media%'")" == '0' ]]
echo 'managed ownership and grants retained'

managed_browser_visible="$(psql_managed_root -At <<'SQL'
SET ROLE authenticated;
SELECT count(*) FROM storage.objects WHERE bucket_id = 'posts';
SQL
)"
[[ "$(tail -1 <<<"$managed_browser_visible")" == '0' ]]
expect_failure_matching \
  managed_browser_insert \
  'violates row-level security policy' \
  psql_managed_root -c "SET ROLE authenticated; INSERT INTO storage.objects(bucket_id, name) VALUES ('posts', 'browser/blocked.webp');"
psql_managed_root <<'SQL'
SET ROLE authenticated;
UPDATE storage.objects
SET name = 'legacy/browser-changed.webp'
WHERE bucket_id = 'posts';
DELETE FROM storage.objects WHERE bucket_id = 'posts';
UPDATE storage.buckets
SET public = false, file_size_limit = 1
WHERE id = 'posts';
DELETE FROM storage.buckets WHERE id = 'posts';
SQL
[[ "$(psql_managed_root -At -c "SELECT count(*) FROM storage.objects WHERE bucket_id = 'posts' AND name = 'legacy/managed.webp'")" == '1' ]]
[[ "$(psql_managed_root -At -c "SELECT count(*) FROM storage.buckets WHERE id = 'posts' AND public IS true AND file_size_limit = 104857600")" == '1' ]]
psql_managed_root <<'SQL'
SET ROLE service_role;
INSERT INTO storage.objects (bucket_id, name)
VALUES ('posts', 'service/managed.webp');
DELETE FROM storage.objects
WHERE bucket_id = 'posts' AND name = 'service/managed.webp';
SQL
echo 'managed browser boundary retained'

psql_managed_root <<'SQL'
SET ROLE supabase_storage_admin;
CREATE POLICY "Unsafe generic bucket writes"
  ON storage.buckets FOR ALL TO authenticated
  USING (id IS NOT NULL)
  WITH CHECK (id IS NOT NULL);
UPDATE storage.buckets
SET public = false, file_size_limit = 6
WHERE id = 'posts';
RESET ROLE;
SQL
expect_failure_matching \
  managed_unsafe_bucket_policy \
  'can mutate posts' \
  psql_managed_deployer -f "$MIGRATION"
[[ "$(psql_managed_root -At -c "SELECT public IS false AND file_size_limit = 6 FROM storage.buckets WHERE id = 'posts'")" == 't' ]]
psql_managed_root <<'SQL'
SET ROLE supabase_storage_admin;
DROP POLICY "Unsafe generic bucket writes" ON storage.buckets;
RESET ROLE;
SQL
psql_managed_deployer -f "$MIGRATION"
echo 'unsafe managed bucket policy failed closed'

psql_managed_root <<'SQL'
SET ROLE supabase_storage_admin;
CREATE POLICY "Unsafe generic post writes"
  ON storage.objects FOR ALL TO authenticated
  USING (name IS NOT NULL)
  WITH CHECK (name IS NOT NULL);
UPDATE storage.buckets
SET public = false, file_size_limit = 7
WHERE id = 'posts';
RESET ROLE;
SQL
expect_failure_matching \
  managed_unsafe_policy \
  'can authorize posts' \
  psql_managed_deployer -f "$MIGRATION"
[[ "$(psql_managed_root -At -c "SELECT public IS false AND file_size_limit = 7 FROM storage.buckets WHERE id = 'posts'")" == 't' ]]
[[ "$(psql_managed_root -At -c "SELECT count(*) FROM storage.objects WHERE bucket_id = 'posts' AND name = 'legacy/managed.webp'")" == '1' ]]
echo 'unsafe managed write policy failed closed'
echo 'unsafe managed policy failed closed'

echo 'post media storage PostgreSQL 17 proof passed'
