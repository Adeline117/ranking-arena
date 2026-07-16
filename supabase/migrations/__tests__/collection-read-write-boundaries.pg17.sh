#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for collection privacy and mutation ACLs.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716104500_collection_read_write_boundaries.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ ! -f "$MIGRATION" ]]; then
  echo "Collection boundary migration is missing: $MIGRATION" >&2
  exit 1
fi
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/collection-boundary-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55447
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if (( exit_status != 0 )) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    echo "PostgreSQL 17 integration cluster log:" >&2
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

PSQL=(
  "$PG_BIN/psql"
  -X
  -v ON_ERROR_STOP=1
  -h "$SOCKET_DIR"
  -p "$PORT"
  -d postgres
)

"${PSQL[@]}" <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
$function$;

CREATE TABLE public.user_collections (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  is_public boolean DEFAULT false,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.collection_items (
  id uuid PRIMARY KEY,
  collection_id uuid NOT NULL
    REFERENCES public.user_collections(id) ON DELETE CASCADE,
  item_type text NOT NULL,
  item_id text NOT NULL,
  note text,
  added_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.user_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collection_items ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT ALL ON public.user_collections, public.collection_items
  TO anon, authenticated, service_role;
GRANT INSERT (name), UPDATE (name), REFERENCES (id)
  ON public.user_collections TO anon, authenticated;
GRANT INSERT (item_id), UPDATE (note), REFERENCES (collection_id)
  ON public.collection_items TO anon, authenticated;

-- Deliberately unsafe legacy policies. The migration must replace all of them.
CREATE POLICY unsafe_collections_all
  ON public.user_collections
  FOR ALL
  TO PUBLIC
  USING (true)
  WITH CHECK (true);
CREATE POLICY unsafe_items_all
  ON public.collection_items
  FOR ALL
  TO PUBLIC
  USING (true)
  WITH CHECK (true);

INSERT INTO public.user_collections (
  id, user_id, name, is_public
) VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'public collection',
    true
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'private collection',
    false
  );

INSERT INTO public.collection_items (
  id, collection_id, item_type, item_id, note
) VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'post',
    'public-post',
    'public note'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000002',
    'post',
    'private-post',
    'private note'
  );

CREATE OR REPLACE FUNCTION public.expect_denied(p_statement text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  EXECUTE p_statement;
  RAISE EXCEPTION 'statement unexpectedly succeeded: %', p_statement;
EXCEPTION
  WHEN insufficient_privilege OR check_violation OR unique_violation
    OR not_null_violation OR foreign_key_violation
  THEN
    RETURN;
END
$function$;
GRANT EXECUTE ON FUNCTION public.expect_denied(text)
  TO anon, authenticated, service_role;
SQL

"${PSQL[@]}" -f "$MIGRATION" >"$LOG_DIR/first-replay.log"
"${PSQL[@]}" -f "$MIGRATION" >"$LOG_DIR/second-replay.log"

"${PSQL[@]}" <<'SQL'
SET ROLE anon;
SELECT pg_catalog.set_config('request.jwt.claim.sub', '', false);

DO $anon_read_contract$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.user_collections) <> 1
    OR (SELECT pg_catalog.count(*) FROM public.collection_items) <> 1
    OR EXISTS (
      SELECT 1
      FROM public.collection_items
      WHERE note = 'private note'
    )
  THEN
    RAISE EXCEPTION 'anonymous collection privacy boundary failed';
  END IF;
END
$anon_read_contract$;

SELECT public.expect_denied($statement$
  INSERT INTO public.user_collections (id, user_id, name, is_public)
  VALUES (
    '10000000-0000-4000-8000-000000000003',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'forged',
    true
  )
$statement$);
SELECT public.expect_denied($statement$
  INSERT INTO public.collection_items (id, collection_id, item_type, item_id)
  VALUES (
    '20000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    'post',
    'forged'
  )
$statement$);
SELECT public.expect_denied($statement$
  TRUNCATE public.collection_items, public.user_collections
$statement$);

RESET ROLE;
SET ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  false
);

DO $owner_read_contract$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.user_collections) <> 2
    OR (SELECT pg_catalog.count(*) FROM public.collection_items) <> 2
  THEN
    RAISE EXCEPTION 'collection owner cannot read their private data';
  END IF;
END
$owner_read_contract$;

SELECT public.expect_denied($statement$
  INSERT INTO public.user_collections (id, user_id, name, is_public)
  VALUES (
    '10000000-0000-4000-8000-000000000005',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'browser insert',
    false
  )
$statement$);
SELECT public.expect_denied($statement$
  INSERT INTO public.collection_items (id, collection_id, item_type, item_id)
  VALUES (
    '20000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000002',
    'post',
    'browser insert'
  )
$statement$);

SELECT public.expect_denied($statement$
  UPDATE public.user_collections
  SET name = 'browser bypass'
  WHERE id = '10000000-0000-4000-8000-000000000002'
$statement$);
SELECT public.expect_denied($statement$
  DELETE FROM public.user_collections
  WHERE id = '10000000-0000-4000-8000-000000000002'
$statement$);
SELECT public.expect_denied($statement$
  UPDATE public.collection_items
  SET note = 'browser bypass'
  WHERE id = '20000000-0000-4000-8000-000000000002'
$statement$);
SELECT public.expect_denied($statement$
  DELETE FROM public.collection_items
  WHERE id = '20000000-0000-4000-8000-000000000002'
$statement$);
SELECT public.expect_denied($statement$
  TRUNCATE public.collection_items, public.user_collections
$statement$);

SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  false
);
DO $other_user_read_contract$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.user_collections) <> 1
    OR (SELECT pg_catalog.count(*) FROM public.collection_items) <> 1
  THEN
    RAISE EXCEPTION 'another user can see a private collection';
  END IF;
END
$other_user_read_contract$;

RESET ROLE;
SET ROLE service_role;
INSERT INTO public.user_collections (id, user_id, name, is_public)
VALUES (
  '10000000-0000-4000-8000-000000000004',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'service collection',
  false
);
INSERT INTO public.collection_items (id, collection_id, item_type, item_id)
VALUES (
  '20000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000004',
  'activity',
  'service-item'
);
UPDATE public.collection_items
SET note = 'service update'
WHERE id = '20000000-0000-4000-8000-000000000004';
DELETE FROM public.user_collections
WHERE id = '10000000-0000-4000-8000-000000000004';

RESET ROLE;
DO $final_contract$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.collection_items
    WHERE id = '20000000-0000-4000-8000-000000000004'
  ) THEN
    RAISE EXCEPTION 'service collection cascade did not execute';
  END IF;

  IF pg_catalog.has_table_privilege(
    'authenticated',
    'public.user_collections',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.has_table_privilege(
    'authenticated',
    'public.collection_items',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.has_any_column_privilege(
    'authenticated',
    'public.user_collections',
    'INSERT,UPDATE,REFERENCES'
  ) OR pg_catalog.has_any_column_privilege(
    'authenticated',
    'public.collection_items',
    'INSERT,UPDATE,REFERENCES'
  ) THEN
    RAISE EXCEPTION 'collection browser write ACL survived';
  END IF;
END
$final_contract$;
SQL

echo "collection read/write boundaries PG17 integration proof passed"
