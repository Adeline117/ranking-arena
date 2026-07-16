#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for 20260715235000. It owns an isolated
# temporary cluster and never connects to a developer or remote database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260715235000_atomic_linked_trader_mutations.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/linked-trader-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55461
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if (( exit_code != 0 )) && [[ -f "$LOG_FILE" ]]; then
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
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333');
INSERT INTO public.user_profiles(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
INSERT INTO public.user_linked_traders(
  id, user_id, trader_id, source, is_primary, display_order, verification_method
) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '11111111-1111-1111-1111-111111111111', 'a1', 'binance', true, 0, 'api_key'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '11111111-1111-1111-1111-111111111111', 'a2', 'bybit', true, 1, 'api_key'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', '22222222-2222-2222-2222-222222222222', 'b1', 'okx', false, 0, 'api_key'),
  ('cccccccc-cccc-cccc-cccc-ccccccccccc1', '33333333-3333-3333-3333-333333333333', 'c1', 'mexc', true, 0, 'api_key');
SQL

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $proof$
DECLARE
  v_result record;
BEGIN
  IF EXISTS (
    SELECT user_id
    FROM public.user_linked_traders
    GROUP BY user_id
    HAVING count(*) FILTER (WHERE is_primary) <> 1
  ) THEN
    RAISE EXCEPTION 'primary repair failed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = '11111111-1111-1111-1111-111111111111'
      AND linked_trader_count = 2
      AND verified_trader_id = 'a1'
      AND verified_trader_source = 'binance'
      AND is_verified_trader
  ) THEN
    RAISE EXCEPTION 'profile projection repair failed';
  END IF;

  -- A target owned by another user must fail before B's primary changes.
  BEGIN
    PERFORM public.set_primary_linked_trader(
      '22222222-2222-2222-2222-222222222222',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'
    );
    RAISE EXCEPTION 'cross-owner primary switch unexpectedly succeeded';
  EXCEPTION
    WHEN no_data_found THEN NULL;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_linked_traders
    WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1' AND is_primary
  ) THEN
    RAISE EXCEPTION 'failed cross-owner request cleared B primary';
  END IF;

  PERFORM public.set_primary_linked_trader(
    '11111111-1111-1111-1111-111111111111',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'
  );
  IF (SELECT count(*) FROM public.user_linked_traders
      WHERE user_id = '11111111-1111-1111-1111-111111111111' AND is_primary) <> 1
     OR NOT EXISTS (
       SELECT 1 FROM public.user_profiles
       WHERE id = '11111111-1111-1111-1111-111111111111'
         AND verified_trader_id = 'a2'
         AND verified_trader_source = 'bybit'
     ) THEN
    RAISE EXCEPTION 'atomic primary switch failed';
  END IF;

  SELECT * INTO v_result
  FROM public.unlink_linked_trader(
    '11111111-1111-1111-1111-111111111111',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'
  );
  IF v_result.remaining_count <> 1
     OR v_result.promoted_link_id <> 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
     OR NOT EXISTS (
       SELECT 1 FROM public.user_profiles
       WHERE id = '11111111-1111-1111-1111-111111111111'
         AND linked_trader_count = 1
         AND verified_trader_id = 'a1'
         AND verified_trader_source = 'binance'
         AND is_verified_trader
     ) THEN
    RAISE EXCEPTION 'primary unlink promotion failed';
  END IF;

  PERFORM public.unlink_linked_trader(
    '11111111-1111-1111-1111-111111111111',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = '11111111-1111-1111-1111-111111111111'
      AND linked_trader_count = 0
      AND verified_trader_id IS NULL
      AND verified_trader_source IS NULL
      AND NOT is_verified_trader
  ) THEN
    RAISE EXCEPTION 'last unlink projection clear failed';
  END IF;

  -- A profile projection failure must roll the entire mutation back.
  BEGIN
    PERFORM public.set_primary_linked_trader(
      '33333333-3333-3333-3333-333333333333',
      'cccccccc-cccc-cccc-cccc-ccccccccccc1'
    );
    RAISE EXCEPTION 'missing-profile mutation unexpectedly succeeded';
  EXCEPTION
    WHEN no_data_found THEN NULL;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_linked_traders
    WHERE id = 'cccccccc-cccc-cccc-cccc-ccccccccccc1' AND is_primary
  ) THEN
    RAISE EXCEPTION 'missing-profile rollback failed';
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
SQL
