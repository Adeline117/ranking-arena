#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for the trader identity ACL boundary. It owns
# an isolated temporary cluster and never connects to a developer or remote DB.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ACL_MIGRATION="$ROOT_DIR/supabase/migrations/20260716103000_trader_identity_server_write_only.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/trader-identity-acl-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55464
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
CREATE TABLE public.trader_claims (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id text NOT NULL,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  verification_method text NOT NULL
);
CREATE TABLE public.verified_traders (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trader_id text NOT NULL,
  source text NOT NULL,
  display_name text,
  verification_method text NOT NULL,
  UNIQUE(trader_id, source)
);

ALTER TABLE public.trader_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verified_traders ENABLE ROW LEVEL SECURITY;

-- Reproduce the broad grants and historical policy-backed browser writes that
-- this migration must close without breaking either read contract.
GRANT ALL ON TABLE public.trader_claims, public.verified_traders
  TO anon, authenticated, service_role;
CREATE POLICY "Users can view their own claims"
  ON public.trader_claims FOR SELECT TO public
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can insert their own claims"
  ON public.trader_claims FOR INSERT TO public
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can delete their own pending claims"
  ON public.trader_claims FOR DELETE TO public
  USING ((SELECT auth.uid()) = user_id AND status = 'pending');
CREATE POLICY "Service role can manage all claims"
  ON public.trader_claims FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "Anyone can view verified traders"
  ON public.verified_traders FOR SELECT TO public USING (true);
CREATE POLICY "Users can update their own verified profile"
  ON public.verified_traders FOR UPDATE TO public
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Service role can manage verified traders"
  ON public.verified_traders FOR ALL TO service_role
  USING (true) WITH CHECK (true);

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
INSERT INTO public.trader_claims(
  id, user_id, trader_id, source, status, verification_method
) VALUES
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    '11111111-1111-1111-1111-111111111111',
    'alice-trader',
    'binance',
    'pending',
    'api_key'
  ),
  (
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
    '22222222-2222-2222-2222-222222222222',
    'bob-trader',
    'bybit',
    'verified',
    'signature'
  );
INSERT INTO public.verified_traders(
  id, user_id, trader_id, source, display_name, verification_method
) VALUES
  (
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
    '11111111-1111-1111-1111-111111111111',
    'alice-trader',
    'binance',
    'Alice',
    'api_key'
  ),
  (
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2',
    '22222222-2222-2222-2222-222222222222',
    'bob-trader',
    'bybit',
    'Bob',
    'signature'
  );
SQL

# The migration must fail closed and roll back before touching ACLs when the
# atomic activation boundary is absent.
if psql_cmd -f "$ACL_MIGRATION" >"$TMP_ROOT/preflight.log" 2>&1; then
  echo "identity ACL migration unexpectedly passed without activation RPC" >&2
  exit 1
fi
if ! grep -q \
  'atomic trader-claim activation must exist before identity ACL hardening' \
  "$TMP_ROOT/preflight.log"; then
  cat "$TMP_ROOT/preflight.log" >&2
  exit 1
fi

psql_cmd <<'SQL'
CREATE FUNCTION public.activate_trader_claim(uuid, uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT pg_catalog.jsonb_build_object('activated', $1, 'reviewer', $2) $$;
SQL

psql_cmd -f "$ACL_MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $proof$
BEGIN
  IF has_table_privilege('anon', 'public.trader_claims', 'SELECT')
     OR has_table_privilege('anon', 'public.trader_claims', 'INSERT')
     OR has_table_privilege('authenticated', 'public.trader_claims', 'INSERT')
     OR has_table_privilege('authenticated', 'public.trader_claims', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.trader_claims', 'DELETE')
     OR NOT has_table_privilege('authenticated', 'public.trader_claims', 'SELECT')
     OR has_table_privilege('anon', 'public.verified_traders', 'INSERT')
     OR has_table_privilege('authenticated', 'public.verified_traders', 'INSERT')
     OR has_table_privilege('authenticated', 'public.verified_traders', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.verified_traders', 'DELETE')
     OR NOT has_table_privilege('anon', 'public.verified_traders', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.verified_traders', 'SELECT')
     OR NOT has_table_privilege(
       'service_role', 'public.trader_claims', 'SELECT,INSERT,UPDATE,DELETE'
     )
     OR NOT has_table_privilege(
       'service_role', 'public.verified_traders', 'SELECT,INSERT,UPDATE,DELETE'
     ) THEN
    RAISE EXCEPTION 'identity table privilege boundary failed';
  END IF;

  IF has_function_privilege(
       'anon', 'public.activate_trader_claim(uuid,uuid)', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'public.activate_trader_claim(uuid,uuid)', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role', 'public.activate_trader_claim(uuid,uuid)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'activation function privilege boundary failed';
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
  IF (SELECT count(*) FROM public.trader_claims) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.trader_claims
       WHERE user_id = '11111111-1111-1111-1111-111111111111'
     ) THEN
    RAISE EXCEPTION 'authenticated own-claim SELECT contract failed';
  END IF;

  IF (SELECT count(*) FROM public.verified_traders) <> 2 THEN
    RAISE EXCEPTION 'authenticated verified-identity SELECT contract failed';
  END IF;

  BEGIN
    INSERT INTO public.trader_claims(
      id, user_id, trader_id, source, status, verification_method
    ) VALUES (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
      '11111111-1111-1111-1111-111111111111',
      'forged-claim',
      'mexc',
      'verified',
      'social'
    );
    RAISE EXCEPTION 'authenticated claim forgery unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.verified_traders
    SET trader_id = 'stolen-identity', display_name = 'Forged';
    RAISE EXCEPTION 'authenticated identity update unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    DELETE FROM public.verified_traders;
    RAISE EXCEPTION 'authenticated identity delete unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.activate_trader_claim(
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
      '11111111-1111-1111-1111-111111111111'
    );
    RAISE EXCEPTION 'authenticated activation unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$proof$;
RESET ROLE;

SET ROLE anon;
DO $proof$
BEGIN
  IF (SELECT count(*) FROM public.verified_traders) <> 2 THEN
    RAISE EXCEPTION 'anonymous verified-identity SELECT contract failed';
  END IF;

  BEGIN
    PERFORM 1 FROM public.trader_claims;
    RAISE EXCEPTION 'anonymous claim read unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$proof$;
RESET ROLE;

SET ROLE service_role;
INSERT INTO public.trader_claims(
  id, user_id, trader_id, source, verification_method
) VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4',
  '11111111-1111-1111-1111-111111111111',
  'service-claim',
  'okx',
  'api_key'
);
UPDATE public.trader_claims
SET status = 'reviewing'
WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4';
INSERT INTO public.verified_traders(
  id, user_id, trader_id, source, display_name, verification_method
) VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5',
  '11111111-1111-1111-1111-111111111111',
  'service-trader',
  'okx',
  'Service Trader',
  'api_key'
);
UPDATE public.verified_traders
SET display_name = 'Service Updated'
WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5';

SELECT public.activate_trader_claim(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4',
  '22222222-2222-2222-2222-222222222222'
);

DELETE FROM public.verified_traders
WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5';
DELETE FROM public.trader_claims
WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4';
RESET ROLE;

DO $proof$
BEGIN
  IF EXISTS (
       SELECT 1 FROM public.trader_claims
       WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4'
     )
     OR EXISTS (
       SELECT 1 FROM public.verified_traders
       WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5'
     ) THEN
    RAISE EXCEPTION 'service identity CRUD contract failed';
  END IF;
END
$proof$;
SQL

echo "trader identity server-write-only PG17 proof passed"
