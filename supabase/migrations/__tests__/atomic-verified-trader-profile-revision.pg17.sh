#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for 20260729070000. It owns an isolated
# temporary cluster and never connects to a developer or remote database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260803170000_atomic_verified_trader_profile_revision.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl postgres psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

PG_VERSION="$("$PG_BIN/postgres" --version)"
if [[ ! "$PG_VERSION" =~ ^postgres\ \(PostgreSQL\)\ 17\. ]]; then
  echo "PostgreSQL 17 is required, found: $PG_VERSION" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/atomic-verified-profile-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
FIRST_WRITER_LOG="$TMP_ROOT/first-writer.log"
STALE_WRITER_LOG="$TMP_ROOT/stale-writer.log"
PORT=55492
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    [[ -f "$FIRST_WRITER_LOG" ]] && tail -80 "$FIRST_WRITER_LOG" >&2 || true
    [[ -f "$STALE_WRITER_LOG" ]] && tail -80 "$STALE_WRITER_LOG" >&2 || true
    [[ -f "$LOG_FILE" ]] && tail -160 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" \
    -X \
    -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" \
    -p "$PORT" \
    -d postgres \
    "$@"
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

SERVER_VERSION_NUM="$(psql_cmd -Atqc 'SHOW server_version_num')"
if ((SERVER_VERSION_NUM < 170000 || SERVER_VERSION_NUM >= 180000)); then
  echo "Isolated server is not PostgreSQL 17: $SERVER_VERSION_NUM" >&2
  exit 1
fi

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

CREATE TABLE public.verified_traders (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  trader_id text NOT NULL,
  source text NOT NULL,
  display_name text,
  bio text,
  avatar_url text,
  twitter_url text,
  telegram_url text,
  discord_url text,
  website_url text,
  verified_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  verification_method text NOT NULL,
  can_pin_posts boolean NOT NULL DEFAULT false,
  can_reply_reviews boolean NOT NULL DEFAULT true,
  can_receive_messages boolean NOT NULL DEFAULT true,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (trader_id, source)
);
ALTER TABLE public.verified_traders OWNER TO postgres;
ALTER TABLE public.verified_traders ENABLE ROW LEVEL SECURITY;
CREATE POLICY public_verified_trader_read
  ON public.verified_traders
  FOR SELECT
  TO anon, authenticated
  USING (true);
CREATE POLICY service_verified_trader_write
  ON public.verified_traders
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON public.verified_traders TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.verified_traders TO service_role;

INSERT INTO public.verified_traders (
  id,
  user_id,
  trader_id,
  source,
  display_name,
  bio,
  verification_method
) VALUES
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'trader-a',
    'binance_futures',
    'Alpha',
    'Original bio',
    'api_key'
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '11111111-1111-4111-8111-111111111111',
    'trader-b',
    'bybit',
    'Sibling',
    'Sibling bio',
    'signature'
  ),
  (
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '22222222-2222-4222-8222-222222222222',
    'trader-c',
    'drift',
    'Other owner',
    'Other bio',
    'signature'
  );
SQL

psql_cmd -f "$MIGRATION" >/dev/null
# Replay must converge rather than resetting live revisions or widening grants.
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $proof$
BEGIN
  IF EXISTS (
       SELECT 1
       FROM public.verified_traders
       WHERE profile_version <> 0
     )
     OR (
       SELECT count(*)
       FROM public.verified_traders
     ) <> 3 THEN
    RAISE EXCEPTION 'historical verified-trader revisions were not normalized';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.update_verified_trader_profile_cas(uuid,text,text,integer,jsonb)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.update_verified_trader_profile_cas(uuid,text,text,integer,jsonb)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.update_verified_trader_profile_cas(uuid,text,text,integer,jsonb)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'verified-trader profile CAS privilege boundary failed';
  END IF;
END
$proof$;

SET ROLE anon;
DO $proof$
BEGIN
  BEGIN
    PERFORM public.update_verified_trader_profile_cas(
      '11111111-1111-4111-8111-111111111111',
      'trader-a',
      'binance_futures',
      0,
      '{"bio":"anonymous overwrite"}'::jsonb
    );
    RAISE EXCEPTION 'anonymous profile CAS unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END
$proof$;
RESET ROLE;

SET ROLE authenticated;
DO $proof$
BEGIN
  BEGIN
    PERFORM public.update_verified_trader_profile_cas(
      '11111111-1111-4111-8111-111111111111',
      'trader-a',
      'binance_futures',
      0,
      '{"bio":"browser overwrite"}'::jsonb
    );
    RAISE EXCEPTION 'authenticated profile CAS unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END
$proof$;
RESET ROLE;

SET ROLE service_role;
SELECT public.update_verified_trader_profile_cas(
  '11111111-1111-4111-8111-111111111111',
  'trader-a',
  'binance_futures',
  0,
  '{"display_name":"Alpha updated"}'::jsonb
);
RESET ROLE;

DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.verified_traders
    WHERE user_id = '11111111-1111-4111-8111-111111111111'
      AND trader_id = 'trader-a'
      AND source = 'binance_futures'
      AND display_name = 'Alpha updated'
      AND bio = 'Original bio'
      AND profile_version = 1
  ) THEN
    RAISE EXCEPTION 'exact partial profile CAS did not persist its acknowledgement';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.verified_traders
    WHERE trader_id = 'trader-b'
      AND source = 'bybit'
      AND display_name = 'Sibling'
      AND bio = 'Sibling bio'
      AND profile_version = 0
  ) THEN
    RAISE EXCEPTION 'exact profile CAS changed a sibling identity';
  END IF;
END
$proof$;

SET ROLE service_role;
DO $proof$
BEGIN
  BEGIN
    PERFORM public.update_verified_trader_profile_cas(
      '11111111-1111-4111-8111-111111111111',
      'trader-a',
      'binance_futures',
      0,
      '{"bio":"stale overwrite"}'::jsonb
    );
    RAISE EXCEPTION 'stale profile update unexpectedly succeeded';
  EXCEPTION
    WHEN serialization_failure THEN
      IF SQLERRM <> 'verified-trader profile changed since it was loaded' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    PERFORM public.update_verified_trader_profile_cas(
      '22222222-2222-4222-8222-222222222222',
      'trader-a',
      'binance_futures',
      1,
      '{"bio":"cross-owner overwrite"}'::jsonb
    );
    RAISE EXCEPTION 'cross-owner profile update unexpectedly succeeded';
  EXCEPTION
    WHEN no_data_found THEN NULL;
  END;

  BEGIN
    PERFORM public.update_verified_trader_profile_cas(
      '11111111-1111-4111-8111-111111111111',
      'trader-a',
      'bybit',
      1,
      '{"bio":"cross-source overwrite"}'::jsonb
    );
    RAISE EXCEPTION 'cross-source profile update unexpectedly succeeded';
  EXCEPTION
    WHEN no_data_found THEN NULL;
  END;

  BEGIN
    PERFORM public.update_verified_trader_profile_cas(
      '11111111-1111-4111-8111-111111111111',
      'trader-a',
      'binance_futures',
      1,
      '{"profile_version":99}'::jsonb
    );
    RAISE EXCEPTION 'unknown profile field unexpectedly succeeded';
  EXCEPTION
    WHEN invalid_parameter_value THEN NULL;
  END;
END
$proof$;

UPDATE public.verified_traders
SET profile_version = 99
WHERE trader_id = 'trader-a'
  AND source = 'binance_futures';
RESET ROLE;

DO $proof$
BEGIN
  IF (
    SELECT profile_version
    FROM public.verified_traders
    WHERE trader_id = 'trader-a'
      AND source = 'binance_futures'
  ) <> 1 THEN
    RAISE EXCEPTION 'direct profile revision forgery succeeded';
  END IF;
END
$proof$;

SET ROLE service_role;
UPDATE public.verified_traders
SET avatar_url = 'https://cdn.example/avatar.png'
WHERE trader_id = 'trader-a'
  AND source = 'binance_futures';
RESET ROLE;

DO $proof$
BEGIN
  IF (
    SELECT profile_version
    FROM public.verified_traders
    WHERE trader_id = 'trader-a'
      AND source = 'binance_futures'
  ) <> 2 THEN
    RAISE EXCEPTION 'out-of-band editable profile write did not invalidate stale forms';
  END IF;
END
$proof$;

SET ROLE service_role;
SELECT public.update_verified_trader_profile_cas(
  '11111111-1111-4111-8111-111111111111',
  'trader-a',
  'binance_futures',
  2,
  '{"avatar_url":null}'::jsonb
);

INSERT INTO public.verified_traders (
  id,
  user_id,
  trader_id,
  source,
  display_name,
  verification_method,
  profile_version
) VALUES (
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  '33333333-3333-4333-8333-333333333333',
  'trader-d',
  'hyperliquid',
  'Inserted',
  'signature',
  99
);
RESET ROLE;

DO $proof$
BEGIN
  IF (
    SELECT profile_version
    FROM public.verified_traders
    WHERE trader_id = 'trader-d'
      AND source = 'hyperliquid'
  ) <> 0 THEN
    RAISE EXCEPTION 'insert forged a nonzero profile revision';
  END IF;
END
$proof$;
SQL

CURRENT_VERSION="$(
  psql_cmd -Atqc \
    "SELECT profile_version FROM public.verified_traders WHERE trader_id = 'trader-a' AND source = 'binance_futures'"
)"

psql_cmd >"$FIRST_WRITER_LOG" 2>&1 <<SQL &
BEGIN;
SET ROLE service_role;
SELECT public.update_verified_trader_profile_cas(
  '11111111-1111-4111-8111-111111111111',
  'trader-a',
  'binance_futures',
  $CURRENT_VERSION,
  '{"bio":"concurrent winner"}'::jsonb
);
SELECT pg_catalog.pg_advisory_xact_lock(70000);
SELECT pg_catalog.pg_sleep(1.5);
COMMIT;
SQL
FIRST_WRITER_PID=$!

writer_ready=false
for _attempt in {1..100}; do
  if [[ "$(psql_cmd -Atqc \
    "SELECT pg_catalog.count(*) FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND objid = 70000 AND granted")" == "1" ]]; then
    writer_ready=true
    break
  fi
  if ! kill -0 "$FIRST_WRITER_PID" 2>/dev/null; then
    break
  fi
  sleep 0.05
done

if [[ "$writer_ready" != true ]]; then
  echo "first concurrent profile writer never reached its held row lock" >&2
  wait "$FIRST_WRITER_PID" || true
  exit 1
fi

if psql_cmd >"$STALE_WRITER_LOG" 2>&1 <<SQL
BEGIN;
SET ROLE service_role;
SELECT public.update_verified_trader_profile_cas(
  '11111111-1111-4111-8111-111111111111',
  'trader-a',
  'binance_futures',
  $CURRENT_VERSION,
  '{"display_name":"concurrent stale overwrite"}'::jsonb
);
COMMIT;
SQL
then
  echo "concurrent stale profile update unexpectedly succeeded" >&2
  wait "$FIRST_WRITER_PID" || true
  exit 1
fi

wait "$FIRST_WRITER_PID"

if ! grep -Fq 'verified-trader profile changed since it was loaded' "$STALE_WRITER_LOG"; then
  echo "concurrent stale profile update failed without the conflict contract" >&2
  exit 1
fi

psql_cmd <<SQL
DO \$proof\$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.verified_traders
    WHERE trader_id = 'trader-a'
      AND source = 'binance_futures'
      AND bio = 'concurrent winner'
      AND display_name = 'Alpha updated'
      AND profile_version = $((CURRENT_VERSION + 1))
  ) THEN
    RAISE EXCEPTION 'concurrent stale writer overwrote the committed winner';
  END IF;
END
\$proof\$;
SQL

echo "atomic verified-trader profile revision PostgreSQL 17 proof passed"
