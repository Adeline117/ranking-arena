#!/usr/bin/env bash

# PostgreSQL 17 proof for rank-bounded and unambiguous score publication
# evidence. It applies the original bundle, strengthens it twice, and verifies
# real rank gaps, NULL-rank exclusion, tied PASSED watermarks, later failures,
# explicit empty/missing boards, catalog identity, legacy compatibility, and
# the service-only execution boundary.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE_BUNDLE="$ROOT_DIR/supabase/migrations/20260721175746_arena_score_inputs_publish_bundle.sql"
STRENGTHENER="$ROOT_DIR/supabase/migrations/20260725012000_strengthen_arena_score_publish_evidence.sql"
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

TMP_ROOT="$(mktemp -d /tmp/strengthen-score-publish-evidence-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((59000 + ($$ % 5000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -200 "$LOG_FILE" >&2 || true
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
  trader_id bigint NOT NULL,
  rank integer
);

CREATE TABLE arena.snapshot_probe (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  marker text NOT NULL,
  pause_before_read boolean NOT NULL
);

INSERT INTO arena.snapshot_probe (singleton, marker, pause_before_read)
VALUES (true, 'initial', false);

CREATE FUNCTION public.arena_score_inputs_json(
  p_window text,
  p_per_platform_limit int DEFAULT 1000,
  p_max_age_hours int DEFAULT 48
)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.pg_sleep(
    CASE WHEN EXISTS (
      SELECT 1
      FROM arena.snapshot_probe AS probe
      WHERE probe.singleton
        AND probe.pause_before_read
    ) THEN 2 ELSE 0 END
  );

  SELECT jsonb_build_array(jsonb_build_object(
    'window', p_window,
    'limit', p_per_platform_limit,
    'max_age', p_max_age_hours,
    'legacy_shape', true,
    'probe', (
      SELECT probe.marker
      FROM arena.snapshot_probe AS probe
      WHERE probe.singleton
    )
  ));
$$;

REVOKE ALL ON FUNCTION public.arena_score_inputs_json(text, int, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arena_score_inputs_json(text, int, int)
  TO service_role;

INSERT INTO arena.sources (
  id, slug, status, serving_mode, meta,
  timeframes_native, timeframes_derived
) VALUES
  (1, 'rank-gap-board', 'active', 'serving', '{}', '{90}', '{}'),
  (2, 'tie-future-board', 'active', 'serving', '{}', '{90}', '{}'),
  (3, 'later-failed-stale-board', 'active', 'serving', '{}', '{90}', '{}'),
  (4, 'missing-board', 'active', 'serving', '{}', '{90}', '{}'),
  (5, 'explicit-empty-board', 'active', 'serving', '{}', '{90}', '{}'),
  (6, 'failed-only-board', 'active', 'serving', '{}', '{90}', '{}');

WITH clock AS (
  SELECT pg_catalog.statement_timestamp() AS now
)
INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, scraped_at, actual_count, count_check_passed
)
SELECT input.id, input.source_id, 90, input.scraped_at, input.actual_count,
       input.count_check_passed
FROM clock
CROSS JOIN LATERAL (
  VALUES
    (101::bigint, 1::smallint, clock.now - interval '1 hour', 10, true),
    (201::bigint, 2::smallint, clock.now + interval '10 minutes', 0, true),
    (202::bigint, 2::smallint, clock.now + interval '10 minutes', 0, true),
    (301::bigint, 3::smallint, clock.now - interval '72 hours', 0, true),
    (302::bigint, 3::smallint, clock.now - interval '1 hour', 0, false),
    (501::bigint, 5::smallint, clock.now - interval '2 hours', 0, true),
    (601::bigint, 6::smallint, clock.now - interval '10 minutes', 0, false)
) AS input(id, source_id, scraped_at, actual_count, count_check_passed);

INSERT INTO arena.leaderboard_entries (
  snapshot_id, scraped_at, trader_id, rank
)
SELECT snapshot.id, snapshot.scraped_at, input.trader_id, input.rank
FROM (
  VALUES
    (1001::bigint, 1::integer),
    (1002::bigint, 3::integer),
    (1003::bigint, 5::integer),
    (1004::bigint, 6::integer),
    (1005::bigint, 7::integer),
    (1006::bigint, 8::integer),
    (1007::bigint, 9::integer),
    (1008::bigint, 10::integer),
    (1009::bigint, 11::integer),
    (1010::bigint, NULL::integer)
) AS input(trader_id, rank)
CROSS JOIN arena.leaderboard_snapshots AS snapshot
WHERE snapshot.id = 101;
SQL

psql_cmd -q -f "$BASE_BUNDLE"

psql_cmd -q <<'SQL'
CREATE TABLE public.bundle_contract_before AS
SELECT
  function_row.oid,
  function_row.proowner,
  function_row.proacl,
  function_row.prolang,
  function_row.prokind,
  function_row.prorettype,
  function_row.proretset,
  function_row.pronargs,
  function_row.pronargdefaults,
  function_row.proargtypes::text AS proargtypes,
  function_row.proargnames,
  function_row.proargmodes,
  function_row.proargdefaults::text AS proargdefaults,
  function_row.prosecdef,
  function_row.proleakproof,
  function_row.proisstrict,
  function_row.proconfig,
  function_row.provolatile,
  function_row.proparallel
FROM pg_catalog.pg_proc AS function_row
WHERE function_row.oid =
  'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'
    ::pg_catalog.regprocedure;

CREATE TABLE public.legacy_catalog_before AS
SELECT function_row.*
FROM pg_catalog.pg_proc AS function_row
WHERE function_row.oid =
  'public.arena_score_inputs_json(text,integer,integer)'
    ::pg_catalog.regprocedure;

CREATE TABLE public.legacy_payload_before AS
SELECT public.arena_score_inputs_json('90D', 5, 48) AS payload;
SQL

# The second application is intentional: production ledger replay must retain
# the exact same function object and service-only boundary.
psql_cmd -q -f "$STRENGTHENER"
psql_cmd -q -f "$STRENGTHENER"

psql_cmd -q <<'SQL'
DO $proof$
DECLARE
  v_bundle jsonb;
  v_boards jsonb;
  v_board jsonb;
  v_contract_unchanged boolean;
  v_legacy_unchanged boolean;
BEGIN
  v_bundle := public.arena_score_inputs_publish_bundle_json('90D', 5, 48);
  v_boards := v_bundle->'physicalBoards';

  IF v_bundle->'scoreRows'
     IS DISTINCT FROM public.arena_score_inputs_json('90D', 5, 48) THEN
    RAISE EXCEPTION 'strengthened bundle changed the legacy scoreRows payload';
  END IF;

  IF pg_catalog.jsonb_array_length(v_boards) <> 6 THEN
    RAISE EXCEPTION 'registry-complete physical board count drifted: %',
      pg_catalog.jsonb_array_length(v_boards);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(v_boards) AS board
    WHERE (board->>'rank_limit')::integer <> 5
  ) THEN
    RAISE EXCEPTION 'a physical board omitted the requested rank_limit';
  END IF;

  SELECT board INTO STRICT v_board
  FROM pg_catalog.jsonb_array_elements(v_boards) AS board
  WHERE board->>'registry_slug' = 'rank-gap-board';

  IF v_board->>'evidence_status' <> 'passed'
     OR (v_board->>'actual_count')::integer <> 10
     OR (v_board->>'entry_count')::bigint <> 10
     OR (v_board->>'rank_limited_entry_count')::bigint <> 3
     OR (v_board->>'latest_passed_tie_count')::bigint <> 1 THEN
    RAISE EXCEPTION 'rank-gap-board rank-limited count drifted: %', v_board;
  END IF;

  SELECT board INTO STRICT v_board
  FROM pg_catalog.jsonb_array_elements(v_boards) AS board
  WHERE board->>'registry_slug' = 'tie-future-board';

  IF v_board->>'evidence_status' <> 'ambiguous_latest'
     OR (v_board->>'latest_passed_tie_count')::bigint <> 2
     OR v_board->>'snapshot_id' <> '202'
     OR (v_board->>'rank_limited_entry_count')::bigint <> 0 THEN
    RAISE EXCEPTION 'ambiguous_latest did not outrank future: %', v_board;
  END IF;

  SELECT board INTO STRICT v_board
  FROM pg_catalog.jsonb_array_elements(v_boards) AS board
  WHERE board->>'registry_slug' = 'later-failed-stale-board';

  IF v_board->>'evidence_status' <> 'latest_attempt_failed'
     OR (v_board->>'latest_passed_tie_count')::bigint <> 1
     OR v_board->>'snapshot_id' <> '301'
     OR v_board->>'latest_attempt_id' <> '302'
     OR (v_board->>'latest_attempt_passed')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'latest_attempt_failed did not outrank stale: %', v_board;
  END IF;

  SELECT board INTO STRICT v_board
  FROM pg_catalog.jsonb_array_elements(v_boards) AS board
  WHERE board->>'registry_slug' = 'missing-board';

  IF v_board->>'evidence_status' <> 'missing'
     OR v_board->>'snapshot_id' IS NOT NULL
     OR v_board->>'entry_count' IS NOT NULL
     OR v_board->>'rank_limited_entry_count' IS NOT NULL
     OR (v_board->>'latest_passed_tie_count')::bigint <> 0 THEN
    RAISE EXCEPTION 'missing board evidence was not explicit: %', v_board;
  END IF;

  SELECT board INTO STRICT v_board
  FROM pg_catalog.jsonb_array_elements(v_boards) AS board
  WHERE board->>'registry_slug' = 'explicit-empty-board';

  IF v_board->>'evidence_status' <> 'passed'
     OR (v_board->>'actual_count')::integer <> 0
     OR (v_board->>'entry_count')::bigint <> 0
     OR (v_board->>'rank_limited_entry_count')::bigint <> 0
     OR (v_board->>'latest_passed_tie_count')::bigint <> 1 THEN
    RAISE EXCEPTION 'explicit empty PASSED board drifted: %', v_board;
  END IF;

  SELECT board INTO STRICT v_board
  FROM pg_catalog.jsonb_array_elements(v_boards) AS board
  WHERE board->>'registry_slug' = 'failed-only-board';

  IF v_board->>'evidence_status' <> 'failed'
     OR v_board->>'snapshot_id' IS NOT NULL
     OR v_board->>'rank_limited_entry_count' IS NOT NULL
     OR (v_board->>'latest_passed_tie_count')::bigint <> 0
     OR (v_board->>'latest_attempt_passed')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'failed-only board evidence drifted: %', v_board;
  END IF;

  SELECT pg_catalog.bool_and(
    after.oid = before.oid
    AND after.proowner = before.proowner
    AND after.proacl IS NOT DISTINCT FROM before.proacl
    AND after.prolang = before.prolang
    AND after.prokind = before.prokind
    AND after.prorettype = before.prorettype
    AND after.proretset = before.proretset
    AND after.pronargs = before.pronargs
    AND after.pronargdefaults = before.pronargdefaults
    AND after.proargtypes::text = before.proargtypes
    AND after.proargnames IS NOT DISTINCT FROM before.proargnames
    AND after.proargmodes IS NOT DISTINCT FROM before.proargmodes
    AND after.proargdefaults::text IS NOT DISTINCT FROM before.proargdefaults
    AND after.prosecdef = before.prosecdef
    AND after.proleakproof = before.proleakproof
    AND after.proisstrict = before.proisstrict
    AND after.proconfig IS NOT DISTINCT FROM before.proconfig
    AND after.provolatile = before.provolatile
    AND after.proparallel = before.proparallel
  ) INTO STRICT v_contract_unchanged
  FROM public.bundle_contract_before AS before
  JOIN pg_catalog.pg_proc AS after
    ON after.oid =
      'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'
        ::pg_catalog.regprocedure;

  IF v_contract_unchanged IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'bundle callable contract changed across replay';
  END IF;

  SELECT pg_catalog.bool_and(
    after.provolatile = 's'
    AND (
      pg_catalog.to_jsonb(after) - 'provolatile'
    ) IS NOT DISTINCT FROM (
      pg_catalog.to_jsonb(before) - 'provolatile'
    )
  ) INTO STRICT v_legacy_unchanged
  FROM public.legacy_catalog_before AS before
  CROSS JOIN pg_catalog.pg_proc AS after
  WHERE after.oid =
    'public.arena_score_inputs_json(text,integer,integer)'
      ::pg_catalog.regprocedure;

  IF v_legacy_unchanged IS DISTINCT FROM true THEN
    RAISE EXCEPTION
      'legacy score-input function changed beyond STABLE across strengthening';
  END IF;

  IF public.arena_score_inputs_json('90D', 5, 48)
     IS DISTINCT FROM (
       SELECT payload
       FROM public.legacy_payload_before
     ) THEN
    RAISE EXCEPTION 'legacy score-input payload changed across strengthening';
  END IF;
END
$proof$;

DO $invalid_arguments$
BEGIN
  BEGIN
    PERFORM public.arena_score_inputs_publish_bundle_json('90D', 0, 48);
    RAISE EXCEPTION 'non-positive rank limit returned a bundle';
  EXCEPTION
    WHEN invalid_parameter_value THEN
      NULL;
  END;
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
  echo "strengthened score-input bundle privileges drifted: $PRIVILEGES" >&2
  exit 1
fi

# A VOLATILE SQL function takes a fresh snapshot for each statement in its
# body. The first statement below sleeps while another session commits a new
# marker; STABLE must keep the second statement on the outer bundle query's
# original snapshot and therefore return "before".
psql_cmd -q -c "
  UPDATE arena.snapshot_probe
  SET marker = 'before', pause_before_read = true
  WHERE singleton;
"

SNAPSHOT_RESULT="$TMP_ROOT/snapshot-result.txt"
PGAPPNAME=score_publish_snapshot_probe \
  psql_cmd -Atq -c "
    SELECT public.arena_score_inputs_publish_bundle_json('90D', 5, 48)
      ->'scoreRows'->0->>'probe';
  " >"$SNAPSHOT_RESULT" &
SNAPSHOT_PID=$!
OBSERVED_SLEEP=false

for _attempt in {1..100}; do
  WAIT_EVENT="$(
    psql_cmd -Atqc "
      SELECT COALESCE(activity.wait_event, '')
      FROM pg_catalog.pg_stat_activity AS activity
      WHERE activity.application_name = 'score_publish_snapshot_probe'
      LIMIT 1;
    "
  )"
  if [[ "$WAIT_EVENT" == "PgSleep" ]]; then
    OBSERVED_SLEEP=true
    break
  fi
  if ! kill -0 "$SNAPSHOT_PID" 2>/dev/null; then
    break
  fi
  sleep 0.05
done

if [[ "$OBSERVED_SLEEP" != "true" ]]; then
  wait "$SNAPSHOT_PID" || true
  echo "snapshot proof never observed the legacy RPC sleep" >&2
  exit 1
fi

psql_cmd -q -c "
  UPDATE arena.snapshot_probe
  SET marker = 'after', pause_before_read = false
  WHERE singleton;
"
wait "$SNAPSHOT_PID"

SNAPSHOT_MARKER="$(tr -d '\r\n' <"$SNAPSHOT_RESULT")"
if [[ "$SNAPSHOT_MARKER" != "before" ]]; then
  echo "nested scoreRows escaped the caller statement snapshot: $SNAPSHOT_MARKER" >&2
  exit 1
fi

SERVICE_ROLE_BOARD_COUNT="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT pg_catalog.jsonb_array_length(
      public.arena_score_inputs_publish_bundle_json('90D', 5, 48)
      ->'physicalBoards'
    );
    RESET ROLE;
  "
)"

if [[ "$SERVICE_ROLE_BOARD_COUNT" != "6" ]]; then
  echo "service_role could not read the complete strengthened bundle: $SERVICE_ROLE_BOARD_COUNT" >&2
  exit 1
fi

echo "strengthened score-input publication evidence PostgreSQL 17 proof passed"
