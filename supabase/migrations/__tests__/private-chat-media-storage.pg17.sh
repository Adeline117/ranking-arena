#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729162000_private_chat_media_storage.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

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

TMP_ROOT="$(mktemp -d /tmp/private-chat-media-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55629
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_DIR/postgres.log" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

psql_managed_root() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d managed "$@"
}

psql_managed_deployer() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d managed -U fixture_deployer "$@"
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

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE supabase_storage_admin NOLOGIN;
CREATE ROLE fixture_deployer LOGIN BYPASSRLS;

CREATE SCHEMA storage;
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
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects
  TO anon, authenticated, service_role;

CREATE POLICY "Public can view avatars"
  ON storage.objects FOR SELECT TO PUBLIC
  USING (bucket_id = 'avatars');
CREATE POLICY "Users upload avatars"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    (bucket_id = 'avatars' AND name LIKE 'folder/%')
    OR (bucket_id = 'avatars' AND name LIKE 'flat-%')
  );

INSERT INTO storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) VALUES (
  'chat', 'chat', true, 999999999, ARRAY['text/html']::text[]
);
INSERT INTO storage.objects (bucket_id, name)
VALUES ('chat', '33333333-3333-4333-8333-333333333333/file/legacy.txt');
SQL

# Owner mode installs a restrictive policy, converges a previously public
# bucket, and remains replay-safe.
psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd -Atqc "
  SELECT public IS false
    AND file_size_limit = 52428800
    AND 'text/html' <> ALL(allowed_mime_types)
  FROM storage.buckets
  WHERE id = 'chat';
" | rg -qx 't'

psql_cmd -Atqc "
  SELECT count(*) = 2
  FROM pg_catalog.pg_policy
  WHERE polrelid = 'storage.objects'::regclass
    AND polname IN (
      'Non-service roles cannot access chat media',
      'Service role manages chat media'
    );
" | rg -qx 't'

psql_cmd -Atqc "
  SET ROLE anon;
  SELECT count(*) FROM storage.objects WHERE bucket_id = 'chat';
" | tail -1 | rg -qx '0'

expect_failure_matching \
  owner_browser_insert \
  'violates row-level security policy' \
  psql_cmd -c "SET ROLE authenticated; INSERT INTO storage.objects(bucket_id, name) VALUES ('chat', 'blocked.txt');"

psql_cmd -Atqc "
  SET ROLE service_role;
  INSERT INTO storage.objects(bucket_id, name) VALUES ('chat', 'service.txt');
  SELECT count(*) FROM storage.objects WHERE bucket_id = 'chat';
" | tail -1 | rg -qx '2'

# Build the managed-ownership fixture in a separate database. The deployer has
# BYPASSRLS table privileges but cannot assume the Storage owner role.
psql_cmd -c 'CREATE DATABASE managed' >/dev/null
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
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Managed avatar reads"
  ON storage.objects FOR SELECT TO PUBLIC
  USING (bucket_id = 'avatars');
CREATE POLICY "Managed avatar writes"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    (bucket_id = 'avatars' AND name LIKE 'folder/%')
    OR (bucket_id = 'avatars' AND name LIKE 'flat-%')
  );
RESET ROLE;

GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role, fixture_deployer;
GRANT SELECT, INSERT, UPDATE ON storage.buckets TO fixture_deployer;
GRANT SELECT, UPDATE ON storage.objects TO fixture_deployer;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO service_role;
SQL

psql_managed_deployer -f "$MIGRATION" >/dev/null
psql_managed_deployer -f "$MIGRATION" >/dev/null

psql_managed_root -Atqc "
  SELECT public IS false AND file_size_limit = 52428800
  FROM storage.buckets WHERE id = 'chat';
" | rg -qx 't'
psql_managed_root -Atqc "
  SELECT count(*)
  FROM pg_catalog.pg_policy
  WHERE polrelid = 'storage.objects'::regclass
    AND polname LIKE '%chat media%';
" | rg -qx '0'

psql_managed_root <<'SQL'
SET ROLE supabase_storage_admin;
CREATE POLICY "Unsafe generic browser read"
  ON storage.objects FOR SELECT TO authenticated
  USING (name IS NOT NULL);
RESET ROLE;
SQL

expect_failure_matching \
  managed_unsafe_policy \
  'can authorize chat' \
  psql_managed_deployer -f "$MIGRATION"

echo 'private chat media PostgreSQL 17 proof passed'
