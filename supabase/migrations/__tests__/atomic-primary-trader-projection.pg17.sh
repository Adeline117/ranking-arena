#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for 20260729071000. It owns an isolated
# temporary cluster and never connects to a developer or remote database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729071000_atomic_primary_trader_projection.sql"
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

TMP_ROOT="$(mktemp -d /tmp/atomic-primary-projection-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
FIRST_WRITER_LOG="$TMP_ROOT/first-writer.log"
SECOND_WRITER_LOG="$TMP_ROOT/second-writer.log"
PORT=55493
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    [[ -f "$FIRST_WRITER_LOG" ]] && tail -80 "$FIRST_WRITER_LOG" >&2 || true
    [[ -f "$SECOND_WRITER_LOG" ]] && tail -80 "$SECOND_WRITER_LOG" >&2 || true
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

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  is_verified_trader boolean NOT NULL DEFAULT false,
  verified_trader_id text,
  verified_trader_source text,
  linked_trader_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE TABLE public.user_linked_traders (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  trader_id text NOT NULL,
  source text NOT NULL,
  label text,
  is_primary boolean NOT NULL DEFAULT false,
  display_order integer NOT NULL DEFAULT 0,
  verified_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  verification_method text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (user_id, trader_id, source),
  UNIQUE (trader_id, source)
);
CREATE UNIQUE INDEX user_linked_traders_one_primary_per_user
  ON public.user_linked_traders (user_id)
  WHERE is_primary IS TRUE;

CREATE TABLE public.verified_traders (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  trader_id text NOT NULL,
  source text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (trader_id, source)
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.user_linked_traders OWNER TO postgres;
ALTER TABLE public.verified_traders OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.set_primary_linked_trader(
  p_user_id uuid,
  p_link_id uuid
)
RETURNS public.user_linked_traders
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $stub$
  SELECT linked.*
  FROM public.user_linked_traders AS linked
  WHERE linked.id = p_link_id
    AND linked.user_id = p_user_id
$stub$;
ALTER FUNCTION public.set_primary_linked_trader(uuid, uuid) OWNER TO postgres;

INSERT INTO public.user_profiles (
  id,
  is_verified_trader,
  verified_trader_id,
  verified_trader_source,
  linked_trader_count
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    true,
    'trader-b',
    'bybit',
    99
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    true,
    'missing',
    'missing',
    99
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    true,
    'orphan',
    'drift',
    1
  );

INSERT INTO public.user_linked_traders (
  id,
  user_id,
  trader_id,
  source,
  is_primary,
  display_order,
  verification_method,
  created_at
) VALUES
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    '11111111-1111-4111-8111-111111111111',
    'trader-a',
    'binance_futures',
    true,
    0,
    'api_key',
    '2026-07-01T00:00:00Z'
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    '11111111-1111-4111-8111-111111111111',
    'trader-b',
    'bybit',
    false,
    1,
    'signature',
    '2026-07-02T00:00:00Z'
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    '22222222-2222-4222-8222-222222222222',
    'trader-c',
    'drift',
    false,
    0,
    'signature',
    '2026-07-03T00:00:00Z'
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
    '22222222-2222-4222-8222-222222222222',
    'trader-d',
    'hyperliquid',
    false,
    1,
    'signature',
    '2026-07-04T00:00:00Z'
  );

INSERT INTO public.verified_traders (
  id,
  user_id,
  trader_id,
  source,
  is_primary
) VALUES
  (
    'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1',
    '11111111-1111-4111-8111-111111111111',
    'trader-a',
    'binance_futures',
    false
  ),
  (
    'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa2',
    '11111111-1111-4111-8111-111111111111',
    'trader-b',
    'bybit',
    true
  ),
  (
    'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb1',
    '22222222-2222-4222-8222-222222222222',
    'trader-c',
    'drift',
    true
  ),
  (
    'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2',
    '22222222-2222-4222-8222-222222222222',
    'trader-d',
    'hyperliquid',
    true
  ),
  (
    'cccccccc-3333-4333-8333-ccccccccccc1',
    '33333333-3333-4333-8333-333333333333',
    'orphan',
    'drift',
    true
  );
SQL

psql_cmd -f "$MIGRATION" >/dev/null
# Replay must converge without widening grants or changing the selected rows.
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM public.user_linked_traders
       WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
         AND is_primary
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.verified_traders
       WHERE trader_id = 'trader-a'
         AND source = 'binance_futures'
         AND is_primary
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_profiles
       WHERE id = '11111111-1111-4111-8111-111111111111'
         AND is_verified_trader
         AND verified_trader_id = 'trader-a'
         AND verified_trader_source = 'binance_futures'
         AND linked_trader_count = 2
     ) THEN
    RAISE EXCEPTION 'historical wrong-primary projection was not repaired';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM public.user_linked_traders
       WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
         AND is_primary
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.verified_traders
       WHERE trader_id = 'trader-c'
         AND source = 'drift'
         AND is_primary
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_profiles
       WHERE id = '22222222-2222-4222-8222-222222222222'
         AND verified_trader_id = 'trader-c'
         AND verified_trader_source = 'drift'
         AND linked_trader_count = 2
     ) THEN
    RAISE EXCEPTION 'historical zero-primary projection was not repaired deterministically';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM public.verified_traders
       WHERE trader_id = 'orphan'
         AND source = 'drift'
         AND is_primary
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_profiles
       WHERE id = '33333333-3333-4333-8333-333333333333'
         AND NOT is_verified_trader
         AND verified_trader_id IS NULL
         AND verified_trader_source IS NULL
         AND linked_trader_count = 0
     ) THEN
    RAISE EXCEPTION 'orphan historical ownership stayed primary';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.set_primary_linked_trader(uuid,uuid)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.set_primary_linked_trader(uuid,uuid)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.set_primary_linked_trader(uuid,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'primary projection privilege boundary failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.user_linked_traders
    GROUP BY user_id
    HAVING count(*) FILTER (WHERE is_primary) <> 1
  ) OR EXISTS (
    SELECT 1
    FROM public.verified_traders AS verified
    WHERE verified.is_primary
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_linked_traders AS linked
        WHERE linked.user_id = verified.user_id
          AND linked.trader_id = verified.trader_id
          AND linked.source = verified.source
          AND linked.is_primary
      )
  ) THEN
    RAISE EXCEPTION 'historical exact-one proof failed';
  END IF;
END
$proof$;

SET ROLE anon;
DO $proof$
BEGIN
  BEGIN
    PERFORM public.set_primary_linked_trader(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
    );
    RAISE EXCEPTION 'anonymous primary switch unexpectedly succeeded';
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
    PERFORM public.set_primary_linked_trader(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
    );
    RAISE EXCEPTION 'authenticated primary switch unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END
$proof$;
RESET ROLE;

SET ROLE service_role;
SELECT public.set_primary_linked_trader(
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
);
RESET ROLE;

DO $proof$
BEGIN
  IF (
       SELECT count(*)
       FROM public.user_linked_traders
       WHERE user_id = '11111111-1111-4111-8111-111111111111'
         AND is_primary
     ) <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_linked_traders
       WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
         AND is_primary
     )
     OR (
       SELECT count(*)
       FROM public.verified_traders
       WHERE user_id = '11111111-1111-4111-8111-111111111111'
         AND is_primary
     ) <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM public.verified_traders
       WHERE trader_id = 'trader-b'
         AND source = 'bybit'
         AND is_primary
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_profiles
       WHERE id = '11111111-1111-4111-8111-111111111111'
         AND verified_trader_id = 'trader-b'
         AND verified_trader_source = 'bybit'
         AND linked_trader_count = 2
     ) THEN
    RAISE EXCEPTION 'service primary switch did not update all projections exactly once';
  END IF;
END
$proof$;

-- A foreign link id must fail before touching the caller's current primary.
SET ROLE service_role;
DO $proof$
BEGIN
  BEGIN
    PERFORM public.set_primary_linked_trader(
      '11111111-1111-4111-8111-111111111111',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
    );
    RAISE EXCEPTION 'foreign primary target unexpectedly succeeded';
  EXCEPTION
    WHEN no_data_found THEN NULL;
  END;
END
$proof$;
RESET ROLE;

DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_linked_traders
    WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
      AND is_primary
  ) THEN
    RAISE EXCEPTION 'foreign target changed the existing primary';
  END IF;
END
$proof$;

-- Missing verified and profile projections prove failures roll every earlier
-- row update back rather than exposing a partially switched primary.
INSERT INTO public.user_profiles (id)
VALUES ('44444444-4444-4444-8444-444444444444');
INSERT INTO public.user_linked_traders (
  id,
  user_id,
  trader_id,
  source,
  is_primary,
  display_order,
  verification_method
) VALUES
  (
    'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
    '44444444-4444-4444-8444-444444444444',
    'trader-e',
    'binance_futures',
    true,
    0,
    'api_key'
  ),
  (
    'dddddddd-dddd-4ddd-8ddd-ddddddddddd2',
    '44444444-4444-4444-8444-444444444444',
    'trader-f',
    'bybit',
    false,
    1,
    'signature'
  );
INSERT INTO public.verified_traders (
  id,
  user_id,
  trader_id,
  source,
  is_primary
) VALUES (
  'dddddddd-4444-4444-8444-ddddddddddd1',
  '44444444-4444-4444-8444-444444444444',
  'trader-e',
  'binance_futures',
  true
);

SET ROLE service_role;
DO $proof$
BEGIN
  BEGIN
    PERFORM public.set_primary_linked_trader(
      '44444444-4444-4444-8444-444444444444',
      'dddddddd-dddd-4ddd-8ddd-ddddddddddd2'
    );
    RAISE EXCEPTION 'missing verified projection unexpectedly succeeded';
  EXCEPTION
    WHEN no_data_found THEN NULL;
  END;
END
$proof$;
RESET ROLE;

DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_linked_traders
    WHERE id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
      AND is_primary
  ) THEN
    RAISE EXCEPTION 'missing verified projection changed canonical primary';
  END IF;
END
$proof$;

INSERT INTO public.user_linked_traders (
  id,
  user_id,
  trader_id,
  source,
  is_primary,
  display_order,
  verification_method
) VALUES
  (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
    '55555555-5555-4555-8555-555555555555',
    'trader-g',
    'drift',
    true,
    0,
    'signature'
  ),
  (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
    '55555555-5555-4555-8555-555555555555',
    'trader-h',
    'hyperliquid',
    false,
    1,
    'signature'
  );
INSERT INTO public.verified_traders (
  id,
  user_id,
  trader_id,
  source,
  is_primary
) VALUES
  (
    'eeeeeeee-5555-4555-8555-eeeeeeeeeee1',
    '55555555-5555-4555-8555-555555555555',
    'trader-g',
    'drift',
    true
  ),
  (
    'eeeeeeee-5555-4555-8555-eeeeeeeeeee2',
    '55555555-5555-4555-8555-555555555555',
    'trader-h',
    'hyperliquid',
    false
  );

SET ROLE service_role;
DO $proof$
BEGIN
  BEGIN
    PERFORM public.set_primary_linked_trader(
      '55555555-5555-4555-8555-555555555555',
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2'
    );
    RAISE EXCEPTION 'missing profile unexpectedly succeeded';
  EXCEPTION
    WHEN no_data_found THEN NULL;
  END;
END
$proof$;
RESET ROLE;

DO $proof$
BEGIN
  IF NOT EXISTS (
       SELECT 1
       FROM public.user_linked_traders
       WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1'
         AND is_primary
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.verified_traders
       WHERE trader_id = 'trader-g'
         AND source = 'drift'
         AND is_primary
     ) THEN
    RAISE EXCEPTION 'missing profile did not roll the primary switch back';
  END IF;
END
$proof$;

-- Restore user one to A before the concurrent last-writer proof.
SET ROLE service_role;
SELECT public.set_primary_linked_trader(
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
);
RESET ROLE;
SQL

psql_cmd >"$FIRST_WRITER_LOG" 2>&1 <<'SQL' &
\set ON_ERROR_STOP on
SET application_name = 'primary-first-writer';
BEGIN;
SET ROLE service_role;
SELECT public.set_primary_linked_trader(
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
);
SELECT pg_catalog.pg_advisory_xact_lock(71000);
SELECT pg_catalog.pg_sleep(3);
COMMIT;
SQL
FIRST_WRITER_PID=$!

first_writer_ready=false
for _attempt in {1..100}; do
  if [[ "$(psql_cmd -Atqc \
    "SELECT pg_catalog.count(*) FROM pg_catalog.pg_locks WHERE locktype = 'advisory' AND objid = 71000 AND granted")" == "1" ]]; then
    first_writer_ready=true
    break
  fi
  if ! kill -0 "$FIRST_WRITER_PID" 2>/dev/null; then
    break
  fi
  sleep 0.05
done

if [[ "$first_writer_ready" != true ]]; then
  echo "first primary writer never reached its held transaction" >&2
  wait "$FIRST_WRITER_PID" || true
  exit 1
fi

psql_cmd >"$SECOND_WRITER_LOG" 2>&1 <<'SQL' &
\set ON_ERROR_STOP on
SET application_name = 'primary-second-writer';
BEGIN;
SET ROLE service_role;
SELECT public.set_primary_linked_trader(
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
);
COMMIT;
SQL
SECOND_WRITER_PID=$!

second_writer_blocked=false
for _attempt in {1..100}; do
  if [[ "$(psql_cmd -Atqc \
    "SELECT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_stat_activity AS activity
       WHERE activity.application_name = 'primary-second-writer'
         AND activity.wait_event_type = 'Lock'
         AND pg_catalog.cardinality(pg_catalog.pg_blocking_pids(activity.pid)) > 0
     )")" == "t" ]]; then
    second_writer_blocked=true
    break
  fi
  if ! kill -0 "$SECOND_WRITER_PID" 2>/dev/null; then
    break
  fi
  sleep 0.05
done

if [[ "$second_writer_blocked" != true ]]; then
  echo "concurrent primary writer did not block on serialized user authority" >&2
  wait "$FIRST_WRITER_PID" || true
  wait "$SECOND_WRITER_PID" || true
  exit 1
fi

wait "$FIRST_WRITER_PID"
wait "$SECOND_WRITER_PID"

psql_cmd <<'SQL'
DO $proof$
BEGIN
  IF (
       SELECT count(*)
       FROM public.user_linked_traders
       WHERE user_id = '11111111-1111-4111-8111-111111111111'
         AND is_primary
     ) <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_linked_traders
       WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
         AND is_primary
     )
     OR (
       SELECT count(*)
       FROM public.verified_traders
       WHERE user_id = '11111111-1111-4111-8111-111111111111'
         AND is_primary
     ) <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM public.verified_traders
       WHERE trader_id = 'trader-a'
         AND source = 'binance_futures'
         AND is_primary
     )
     OR NOT EXISTS (
       SELECT 1
       FROM public.user_profiles
       WHERE id = '11111111-1111-4111-8111-111111111111'
         AND verified_trader_id = 'trader-a'
         AND verified_trader_source = 'binance_futures'
         AND linked_trader_count = 2
     ) THEN
    RAISE EXCEPTION 'concurrent primary switches exposed a split or lost update';
  END IF;
END
$proof$;
SQL

echo "atomic primary trader projection PostgreSQL 17 proof passed"
