#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for the linked-trader ACL boundary. It owns an
# isolated temporary cluster and never connects to a developer or remote DB.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ATOMIC_MIGRATION="$ROOT_DIR/supabase/migrations/20260715235000_atomic_linked_trader_mutations.sql"
ACL_MIGRATION="$ROOT_DIR/supabase/migrations/20260716093000_user_linked_traders_server_write_only.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/linked-trader-acl-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55462
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -120 "$LOG_FILE" >&2 || true
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
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;

CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  is_verified_trader boolean DEFAULT false,
  verified_trader_id text,
  verified_trader_source text,
  linked_trader_count integer DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.user_linked_traders (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id text NOT NULL,
  source text NOT NULL,
  market_type text DEFAULT 'futures',
  label text,
  is_primary boolean DEFAULT false,
  display_order integer DEFAULT 0,
  verified_at timestamptz NOT NULL DEFAULT now(),
  verification_method text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id, trader_id, source),
  UNIQUE(trader_id, source)
);

ALTER TABLE public.user_linked_traders ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE public.user_linked_traders TO anon, authenticated, service_role;
CREATE POLICY "Users manage own linked traders"
  ON public.user_linked_traders FOR ALL TO public
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY user_linked_traders_service_role_only
  ON public.user_linked_traders FOR ALL TO service_role
  USING (true) WITH CHECK (true);

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
INSERT INTO public.user_profiles(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
INSERT INTO public.user_linked_traders(
  id, user_id, trader_id, source, is_primary, display_order, verification_method
) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '11111111-1111-1111-1111-111111111111', 'a1', 'binance', true, 0, 'api_key'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', '22222222-2222-2222-2222-222222222222', 'b1', 'bybit', true, 0, 'api_key');
SQL

psql_cmd -f "$ATOMIC_MIGRATION" >/dev/null
psql_cmd -f "$ACL_MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $proof$
BEGIN
  IF has_table_privilege('anon', 'public.user_linked_traders', 'SELECT')
     OR has_table_privilege('anon', 'public.user_linked_traders', 'INSERT')
     OR has_table_privilege('authenticated', 'public.user_linked_traders', 'INSERT')
     OR has_table_privilege('authenticated', 'public.user_linked_traders', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.user_linked_traders', 'DELETE')
     OR NOT has_table_privilege('authenticated', 'public.user_linked_traders', 'SELECT')
     OR NOT has_table_privilege(
       'service_role', 'public.user_linked_traders', 'SELECT,INSERT,UPDATE,DELETE'
     ) THEN
    RAISE EXCEPTION 'table privilege boundary failed';
  END IF;

  IF has_function_privilege(
       'authenticated', 'public.set_primary_linked_trader(uuid,uuid)', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'public.unlink_linked_trader(uuid,uuid)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role', 'public.set_primary_linked_trader(uuid,uuid)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role', 'public.unlink_linked_trader(uuid,uuid)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'function privilege boundary failed';
  END IF;
END
$proof$;

SET ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  '11111111-1111-1111-1111-111111111111',
  false
);
DO $proof$
BEGIN
  IF (SELECT count(*) FROM public.user_linked_traders) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.user_linked_traders
       WHERE user_id = '11111111-1111-1111-1111-111111111111'
     ) THEN
    RAISE EXCEPTION 'authenticated own-row SELECT policy failed';
  END IF;

  BEGIN
    UPDATE public.user_linked_traders SET label = 'bypass';
    RAISE EXCEPTION 'authenticated update unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.user_linked_traders;
    RAISE EXCEPTION 'authenticated delete unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.user_linked_traders(
      id, user_id, trader_id, source, verification_method
    ) VALUES (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
      '11111111-1111-1111-1111-111111111111',
      'bypass',
      'mexc',
      'api_key'
    );
    RAISE EXCEPTION 'authenticated insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$proof$;
RESET ROLE;

SET ROLE service_role;
INSERT INTO public.user_linked_traders(
  id, user_id, trader_id, source, is_primary, display_order, verification_method
) VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
  '11111111-1111-1111-1111-111111111111',
  'a2',
  'mexc',
  false,
  1,
  'api_key'
);
SELECT public.set_primary_linked_trader(
  '11111111-1111-1111-1111-111111111111',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'
);
RESET ROLE;

DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_linked_traders
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'
      AND is_primary
  ) THEN
    RAISE EXCEPTION 'service role mutation or RPC failed';
  END IF;
END
$proof$;
SQL

echo "linked-trader server-write-only PG17 proof passed"
