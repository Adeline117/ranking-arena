#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for the one-statement score-input publication
# bundle. It covers registry-complete physical boards, trusted empty boards,
# shared aliases, unusable evidence states, ACLs, and legacy RPC compatibility.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260721175746_arena_score_inputs_publish_bundle.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/score-input-publish-bundle-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((57000 + ($$ % 8000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -160 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
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

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA arena;

CREATE TABLE arena.score_inputs (marker text);

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  timeframes_native integer[] NOT NULL DEFAULT '{}',
  timeframes_derived integer[] NOT NULL DEFAULT '{}'
);

CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL,
  actual_count integer NOT NULL,
  count_check_passed boolean NOT NULL
);

CREATE TABLE arena.leaderboard_entries (
  snapshot_id bigint NOT NULL,
  scraped_at timestamptz NOT NULL,
  trader_id bigint NOT NULL
);

CREATE FUNCTION public.arena_score_inputs_json(
  p_window text,
  p_per_platform_limit int DEFAULT 1000,
  p_max_age_hours int DEFAULT 48
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_array(jsonb_build_object(
    'window', p_window,
    'limit', p_per_platform_limit,
    'max_age', p_max_age_hours,
    'legacy_shape', true
  ));
$$;

REVOKE ALL ON FUNCTION public.arena_score_inputs_json(text, int, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arena_score_inputs_json(text, int, int)
  TO service_role;

CREATE TABLE public.legacy_rpc_before AS
SELECT
  procedure.oid,
  procedure.prosrc,
  procedure.proacl,
  public.arena_score_inputs_json('90D', 17, 48) AS payload
FROM pg_catalog.pg_proc AS procedure
WHERE procedure.oid =
  'public.arena_score_inputs_json(text,integer,integer)'::pg_catalog.regprocedure;

INSERT INTO arena.sources (
  id, slug, status, serving_mode, meta,
  timeframes_native, timeframes_derived
) VALUES
  (1, 'shared-fast', 'active', 'serving',
   '{"legacy_platform":"shared"}', '{90}', '{}'),
  (2, 'shared-empty-slow', 'active', 'serving',
   '{"legacy_platform":"shared"}', '{}', '{90}'),
  (3, 'missing-board', 'active', 'serving',
   '{}', '{90}', '{}'),
  (4, 'failed-board', 'active', 'serving',
   '{}', '{90}', '{}'),
  (5, 'future-board', 'active', 'serving',
   '{}', '{90}', '{}'),
  (6, 'stale-board', 'active', 'serving',
   '{}', '{90}', '{}'),
  (7, 'mismatch-board', 'active', 'serving',
   '{}', '{90}', '{}'),
  (8, 'empty-alias-board', 'active', 'serving',
   '{"legacy_platform":"  "}', '{90}', '{}'),
  (9, 'wrong-window', 'active', 'serving',
   '{}', '{7}', '{}'),
  (10, 'inactive-board', 'inactive', 'serving',
   '{}', '{90}', '{}'),
  (11, 'shadow-board', 'active', 'shadow',
   '{}', '{90}', '{}'),
  (12, 'null-sentinel', 'active', 'serving',
   '{"legacy_platform":"null"}', '{90}', '{}'),
  (13, 'last-good-board', 'active', 'serving',
   '{}', '{90}', '{}');

INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, scraped_at, actual_count, count_check_passed
) VALUES
  (101, 1, 90, pg_catalog.statement_timestamp() - interval '1 hour', 1, true),
  (102, 2, 90, pg_catalog.statement_timestamp() - interval '3 hours', 0, true),
  (104, 4, 90, pg_catalog.statement_timestamp() - interval '10 minutes', 2, false),
  (105, 5, 90, pg_catalog.statement_timestamp() + interval '10 minutes', 1, true),
  (106, 6, 90, pg_catalog.statement_timestamp() - interval '72 hours', 1, true),
  (107, 7, 90, pg_catalog.statement_timestamp() - interval '2 hours', 2, true),
  (108, 8, 90, pg_catalog.statement_timestamp() - interval '2 hours', 0, true),
  (109, 9, 7, pg_catalog.statement_timestamp() - interval '1 hour', 0, true),
  (110, 10, 90, pg_catalog.statement_timestamp() - interval '1 hour', 0, true),
  (111, 11, 90, pg_catalog.statement_timestamp() - interval '1 hour', 0, true),
  (112, 12, 90, pg_catalog.statement_timestamp() - interval '1 hour', 0, true),
  (113, 13, 90, pg_catalog.statement_timestamp() - interval '2 hours', 1, true),
  (114, 13, 90, pg_catalog.statement_timestamp() - interval '5 minutes', 2, false);

INSERT INTO arena.leaderboard_entries (snapshot_id, scraped_at, trader_id)
SELECT snapshot.id, snapshot.scraped_at, input.trader_id
FROM (
  VALUES (101::bigint, 1001::bigint),
         (105::bigint, 1005::bigint),
         (106::bigint, 1006::bigint),
         (107::bigint, 1007::bigint),
         (113::bigint, 1013::bigint)
) AS input(snapshot_id, trader_id)
JOIN arena.leaderboard_snapshots AS snapshot ON snapshot.id = input.snapshot_id;
SQL

psql_cmd -q -f "$MIGRATION"

psql_cmd -q <<'SQL'
DO $proof$
DECLARE
  v_bundle jsonb;
  v_boards jsonb;
  v_board jsonb;
  v_shared_min timestamptz;
  v_legacy_unchanged boolean;
BEGIN
  v_bundle := public.arena_score_inputs_publish_bundle_json('90D', 17, 48);
  v_boards := v_bundle->'physicalBoards';

  IF v_bundle->'scoreRows'
     IS DISTINCT FROM public.arena_score_inputs_json('90D', 17, 48) THEN
    RAISE EXCEPTION 'bundle scoreRows changed the legacy RPC payload';
  END IF;

  IF pg_catalog.jsonb_array_length(v_boards) <> 9 THEN
    RAISE EXCEPTION 'registry-complete physical board count drifted: %',
      pg_catalog.jsonb_array_length(v_boards);
  END IF;

  SELECT board INTO STRICT v_board
  FROM pg_catalog.jsonb_array_elements(v_boards) AS board
  WHERE board->>'registry_slug' = 'shared-empty-slow';

  IF v_board->>'filter_source' <> 'shared'
     OR v_board->>'evidence_status' <> 'passed'
     OR (v_board->>'actual_count')::integer <> 0
     OR (v_board->>'entry_count')::bigint <> 0
     OR v_board->>'snapshot_id' <> '102' THEN
    RAISE EXCEPTION 'trusted empty PASSED board was not preserved: %', v_board;
  END IF;

  SELECT pg_catalog.min((board->>'scraped_at')::timestamptz)
    INTO STRICT v_shared_min
  FROM pg_catalog.jsonb_array_elements(v_boards) AS board
  WHERE board->>'filter_source' = 'shared'
    AND board->>'evidence_status' = 'passed';

  IF v_shared_min > pg_catalog.statement_timestamp() - interval '2 hours 59 minutes'
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.jsonb_array_elements(v_boards) AS board
       WHERE board->>'filter_source' = 'shared'
     ) <> 2 THEN
    RAISE EXCEPTION 'shared alias lacks the two physical rows needed for MIN';
  END IF;

  SELECT board INTO STRICT v_board
  FROM pg_catalog.jsonb_array_elements(v_boards) AS board
  WHERE board->>'registry_slug' = 'missing-board';
  IF v_board->>'evidence_status' <> 'missing'
     OR v_board->>'snapshot_id' IS NOT NULL
     OR v_board->>'latest_attempt_id' IS NOT NULL THEN
    RAISE EXCEPTION 'missing PASSED evidence was not explicit: %', v_board;
  END IF;

  SELECT board INTO STRICT v_board
  FROM pg_catalog.jsonb_array_elements(v_boards) AS board
  WHERE board->>'registry_slug' = 'failed-board';
  IF v_board->>'evidence_status' <> 'failed'
     OR v_board->>'snapshot_id' IS NOT NULL
     OR v_board->>'latest_attempt_id' <> '104'
     OR (v_board->>'latest_attempt_passed')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'failed-only evidence was not explicit: %', v_board;
  END IF;

  SELECT board INTO STRICT v_board
  FROM pg_catalog.jsonb_array_elements(v_boards) AS board
  WHERE board->>'registry_slug' = 'future-board';
  IF v_board->>'evidence_status' <> 'future'
     OR v_board->>'snapshot_id' <> '105' THEN
    RAISE EXCEPTION 'future PASSED evidence was not rejected explicitly: %', v_board;
  END IF;

  SELECT board INTO STRICT v_board
  FROM pg_catalog.jsonb_array_elements(v_boards) AS board
  WHERE board->>'registry_slug' = 'stale-board';
  IF v_board->>'evidence_status' <> 'stale' THEN
    RAISE EXCEPTION 'stale PASSED evidence was not explicit: %', v_board;
  END IF;

  SELECT board INTO STRICT v_board
  FROM pg_catalog.jsonb_array_elements(v_boards) AS board
  WHERE board->>'registry_slug' = 'mismatch-board';
  IF v_board->>'evidence_status' <> 'entry_count_mismatch'
     OR (v_board->>'actual_count')::integer <> 2
     OR (v_board->>'entry_count')::bigint <> 1 THEN
    RAISE EXCEPTION 'entry-count mismatch was not fail-closed: %', v_board;
  END IF;

  SELECT board INTO STRICT v_board
  FROM pg_catalog.jsonb_array_elements(v_boards) AS board
  WHERE board->>'registry_slug' = 'last-good-board';
  IF v_board->>'evidence_status' <> 'passed'
     OR v_board->>'snapshot_id' <> '113'
     OR v_board->>'latest_attempt_id' <> '114'
     OR (v_board->>'latest_attempt_passed')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'failed latest attempt displaced last-good PASSED evidence: %', v_board;
  END IF;

  SELECT pg_catalog.bool_and(
    procedure.oid = before.oid
    AND procedure.prosrc = before.prosrc
    AND procedure.proacl IS NOT DISTINCT FROM before.proacl
    AND public.arena_score_inputs_json('90D', 17, 48)
        IS NOT DISTINCT FROM before.payload
  ) INTO STRICT v_legacy_unchanged
  FROM public.legacy_rpc_before AS before
  JOIN pg_catalog.pg_proc AS procedure
    ON procedure.oid =
      'public.arena_score_inputs_json(text,integer,integer)'::pg_catalog.regprocedure;

  IF v_legacy_unchanged IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'legacy arena_score_inputs_json identity, ACL, body, or payload changed';
  END IF;
END
$proof$;

DO $invalid_arguments$
DECLARE
  v_sql text;
BEGIN
  FOREACH v_sql IN ARRAY ARRAY[
    $$SELECT public.arena_score_inputs_publish_bundle_json('1D', 17, 48)$$,
    $$SELECT public.arena_score_inputs_publish_bundle_json('90D', 0, 48)$$,
    $$SELECT public.arena_score_inputs_publish_bundle_json('90D', 17, 0)$$
  ] LOOP
    BEGIN
      EXECUTE v_sql;
      RAISE EXCEPTION 'invalid publish-bundle arguments returned a bundle: %', v_sql;
    EXCEPTION
      WHEN invalid_parameter_value THEN
        NULL;
    END;
  END LOOP;
END
$invalid_arguments$;
SQL

PRIVILEGES="$(
  psql_cmd -Atqc "
    SELECT
      pg_catalog.has_function_privilege(
        'service_role',
        'public.arena_score_inputs_publish_bundle_json(text,integer,integer)',
        'EXECUTE'
      ) || '|' ||
      pg_catalog.has_function_privilege(
        'anon',
        'public.arena_score_inputs_publish_bundle_json(text,integer,integer)',
        'EXECUTE'
      ) || '|' ||
      pg_catalog.has_function_privilege(
        'authenticated',
        'public.arena_score_inputs_publish_bundle_json(text,integer,integer)',
        'EXECUTE'
      );
  "
)"

if [[ "$PRIVILEGES" != "true|false|false" ]]; then
  echo "score-input publish bundle privileges drifted: $PRIVILEGES" >&2
  exit 1
fi

SERVICE_ROLE_BOARD_COUNT="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT pg_catalog.jsonb_array_length(
      public.arena_score_inputs_publish_bundle_json('90D', 17, 48)
      ->'physicalBoards'
    );
    RESET ROLE;
  "
)"

if [[ "$SERVICE_ROLE_BOARD_COUNT" != "9" ]]; then
  echo "service_role could not read the complete definer bundle: $SERVICE_ROLE_BOARD_COUNT" >&2
  exit 1
fi

echo "score-input publish bundle PostgreSQL 17 proof passed"
