#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261123020207: a RAW object's integrity metadata is
# checked once per statement, with unchanged outcomes.
#
# The 20260721120000 row trigger is installed on a fixture of the relations it
# reads; every case is one INSERT statement whose outcome (rows kept, or
# SQLSTATE + message) is recorded. The migration is applied as written and
# every case is replayed:
#   = every case has the identical outcome before and after: valid payload and
#     manifest references; a RAW object of another run, another source, the
#     wrong role, the wrong hash, quarantined, outside the freshness window;
#     missing or wrong meta.raw_integrity fields; a manifest that is not the
#     run's; a payload that is not the population snapshot; a missing RAW
#     object; a batch with one bad row
#   - a refused statement keeps none of its rows
#   + 20,000 rows against a 2,042-page meta document are at least 5x faster
#   - a replay is refused
# Isolated cluster on a private socket; never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
OLD_MIGRATION="$MIGRATIONS/20260721120000_metric_trust_shadow_gate.sql"
NEW_MIGRATION="$MIGRATIONS/20261123020207_metric_trust_artifact_raw_integrity_per_statement.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/artifact-integrity-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((53000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -40 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_db() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

OLD_FUNCTION="$TMP_ROOT/old-function.sql"
awk '/^CREATE FUNCTION arena.validate_metric_trust_artifact\(\)/ { on = 1 }
     on { print }
     on && /^\$function\$;/ { exit }' "$OLD_MIGRATION" >"$OLD_FUNCTION"
grep -q "raw_integrity" "$OLD_FUNCTION"

psql_db -q >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA arena;
CREATE TABLE arena.metric_source_contracts (
  id bigint PRIMARY KEY, source_payload_scope text NOT NULL, max_freshness interval NOT NULL
);
CREATE TABLE arena.metric_trust_runs (
  source_run_id text PRIMARY KEY, population_raw_object_id bigint, manifest_raw_object_id bigint
);
CREATE TABLE arena.raw_objects (
  id bigint PRIMARY KEY, source_id smallint, timeframe smallint, source_run_id text,
  trust_artifact_role text, fetched_at timestamptz, content_hash text,
  quarantined boolean NOT NULL DEFAULT false, meta jsonb
);
CREATE TABLE arena.metric_trust_observations (
  id bigint PRIMARY KEY, contract_id bigint, source_id smallint, timeframe smallint,
  source_run_id text, source_as_of timestamptz, recorded_at timestamptz
);
CREATE TABLE arena.metric_trust_artifacts (
  observation_id bigint NOT NULL, role text NOT NULL, raw_object_id bigint NOT NULL,
  content_hash text NOT NULL
);

INSERT INTO arena.metric_source_contracts VALUES
  (1, 'population_snapshot', interval '6 hours'), (2, 'trader_profile', interval '6 hours');
INSERT INTO arena.metric_trust_runs VALUES ('run-a', 1, 2), ('run-b', 21, 22);

CREATE FUNCTION public.integrity(p_algorithm text, p_scope text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_catalog.jsonb_build_object('raw_integrity',
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'hash_algorithm', p_algorithm, 'hash_scope', p_scope)))
$$;
INSERT INTO arena.raw_objects VALUES
  -- the run's population payload and manifest
  (1, 1, 7, 'run-a', 'source_payload', now(), repeat('a', 64), false, public.integrity('sha256', 'json_utf8')),
  (2, 1, 7, 'run-a', 'population_manifest', now(), 'run-a', false, public.integrity('sha256', 'json_utf8')),
  -- a second payload of the same run (not the population snapshot)
  (3, 1, 7, 'run-a', 'source_payload', now(), repeat('b', 64), false, public.integrity('sha256', 'json_utf8')),
  -- integrity metadata problems
  (4, 1, 7, 'run-a', 'source_payload', now(), repeat('c', 64), false, public.integrity('md5', 'json_utf8')),
  (5, 1, 7, 'run-a', 'source_payload', now(), repeat('d', 64), false, public.integrity('sha256', 'bytes')),
  (6, 1, 7, 'run-a', 'source_payload', now(), repeat('e', 64), false, '{}'),
  (7, 1, 7, 'run-a', 'source_payload', now(), repeat('f', 64), false, public.integrity(NULL, 'json_utf8')),
  -- other row-level problems
  (8, 1, 7, 'run-a', 'source_payload', now(), repeat('1', 64), true, public.integrity('sha256', 'json_utf8')),
  (9, 2, 7, 'run-a', 'source_payload', now(), repeat('2', 64), false, public.integrity('sha256', 'json_utf8')),
  (10, 1, 30, 'run-a', 'source_payload', now(), repeat('3', 64), false, public.integrity('sha256', 'json_utf8')),
  (11, 1, 7, 'run-a', 'source_payload', now() - interval '1 day', repeat('4', 64), false, public.integrity('sha256', 'json_utf8')),
  (12, 1, 7, 'run-a', 'source_payload', now() + interval '1 day', repeat('5', 64), false, public.integrity('sha256', 'json_utf8')),
  -- another run's objects
  (21, 1, 7, 'run-b', 'source_payload', now(), repeat('6', 64), false, public.integrity('sha256', 'json_utf8')),
  (22, 1, 7, 'run-b', 'population_manifest', now(), 'run-b', false, public.integrity('sha256', 'json_utf8')),
  -- a manifest-role object of run-a that is not the run's manifest
  (23, 1, 7, 'run-a', 'population_manifest', now(), 'run-a', false, public.integrity('sha256', 'json_utf8'));
-- observation 1/2: population-snapshot contract; observation 3: profile contract.
INSERT INTO arena.metric_trust_observations VALUES
  (1, 1, 1, 7, 'run-a', now(), now()), (2, 1, 1, 7, 'run-a', now(), now()),
  (3, 2, 1, 7, 'run-a', now(), now());

-- One case = one INSERT statement of (observation, role, raw id, hash) rows.
CREATE TABLE public.cases (name text PRIMARY KEY, batch jsonb NOT NULL);
INSERT INTO public.cases
SELECT name, pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(batch,
         'A', pg_catalog.repeat('a', 64)), 'B', pg_catalog.repeat('b', 64)),
         'X', pg_catalog.repeat('9', 64))::jsonb
FROM (VALUES
  ('valid payload and manifest',  '[[1,"source_payload",1,"A"],[1,"population_manifest",2,"run-a"],[2,"source_payload",1,"A"]]'),
  ('valid profile payload',       '[[3,"source_payload",3,"B"]]'),
  ('wrong hash',                  '[[1,"source_payload",1,"X"]]'),
  ('wrong role',                  '[[1,"population_manifest",1,"A"]]'),
  ('hash algorithm is not sha256','[[3,"source_payload",4,"' || repeat('c', 64) || '"]]'),
  ('hash scope is not json_utf8', '[[3,"source_payload",5,"' || repeat('d', 64) || '"]]'),
  ('no integrity metadata',       '[[3,"source_payload",6,"' || repeat('e', 64) || '"]]'),
  ('no hash algorithm',           '[[3,"source_payload",7,"' || repeat('f', 64) || '"]]'),
  ('quarantined object',          '[[3,"source_payload",8,"' || repeat('1', 64) || '"]]'),
  ('object of another source',    '[[3,"source_payload",9,"' || repeat('2', 64) || '"]]'),
  ('object of another timeframe', '[[3,"source_payload",10,"' || repeat('3', 64) || '"]]'),
  ('object fetched too early',    '[[3,"source_payload",11,"' || repeat('4', 64) || '"]]'),
  ('object fetched too late',     '[[3,"source_payload",12,"' || repeat('5', 64) || '"]]'),
  ('object of another run',       '[[1,"source_payload",21,"' || repeat('6', 64) || '"]]'),
  ('manifest is not the run''s',  '[[1,"population_manifest",23,"run-a"]]'),
  ('payload is not the snapshot', '[[1,"source_payload",3,"B"]]'),
  ('missing RAW object',          '[[1,"source_payload",999,"A"]]'),
  ('missing observation',         '[[77,"source_payload",1,"A"]]'),
  ('one bad integrity row in a batch', '[[1,"source_payload",1,"A"],[3,"source_payload",4,"' || repeat('c', 64) || '"],[2,"source_payload",1,"A"]]'),
  ('one bad hash row in a batch', '[[1,"source_payload",1,"A"],[2,"source_payload",1,"X"]]')
) AS listed(name, batch);

CREATE FUNCTION public.run_case(p_name text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_batch jsonb;
  v_result text;
BEGIN
  SELECT batch INTO STRICT v_batch FROM public.cases WHERE name = p_name;
  BEGIN
    INSERT INTO arena.metric_trust_artifacts (observation_id, role, raw_object_id, content_hash)
    SELECT (item.value->>0)::bigint, item.value->>1, (item.value->>2)::bigint, item.value->>3
      FROM pg_catalog.jsonb_array_elements(v_batch) WITH ORDINALITY AS item(value, position)
     ORDER BY item.position;
    SELECT 'kept ' || pg_catalog.count(*) INTO v_result FROM arena.metric_trust_artifacts;
    RAISE EXCEPTION USING ERRCODE = 'P0999', MESSAGE = v_result;
  EXCEPTION
    WHEN SQLSTATE 'P0999' THEN
      RETURN SQLERRM;
    WHEN OTHERS THEN
      IF EXISTS (SELECT 1 FROM arena.metric_trust_artifacts) THEN
        RETURN 'refused but rows were kept';
      END IF;
      RETURN 'refused ' || SQLSTATE || ' ' || SQLERRM;
  END;
END $$;
SQL

psql_db -q -f "$OLD_FUNCTION"
psql_db -q <<'SQL'
ALTER FUNCTION arena.validate_metric_trust_artifact() OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.validate_metric_trust_artifact() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION arena.validate_metric_trust_artifact() TO service_role;
CREATE TRIGGER validate_metric_trust_artifact_before_insert
BEFORE INSERT ON arena.metric_trust_artifacts
FOR EACH ROW EXECUTE FUNCTION arena.validate_metric_trust_artifact();
SQL

outcomes() {
  psql_db -Atq -F $'\t' -c "SELECT name, public.run_case(name) FROM public.cases ORDER BY name"
}
big_batch_ms() {
  psql_db -Atq <<'SQL' | tail -1
BEGIN;
-- a meta document shaped like a 2,042-page capture record
UPDATE arena.raw_objects
   SET meta = meta || pg_catalog.jsonb_build_object('pages',
     (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'ordinal', n, 'request_sha256', pg_catalog.md5(n::text) || pg_catalog.md5((n + 1)::text),
        'response_sha256', pg_catalog.md5((n * 7)::text) || pg_catalog.md5((n * 13)::text),
        'row_keys_sha256', pg_catalog.md5((n * 3)::text) || pg_catalog.md5((n * 5)::text),
        'url', 'https://example.test/board?pageNo=' || n, 'rows', 16))
      FROM pg_catalog.generate_series(1, 2042) AS n))
 WHERE id IN (1, 2);
INSERT INTO arena.metric_trust_observations
SELECT n, 1, 1, 7, 'run-a', pg_catalog.now(), pg_catalog.now()
  FROM pg_catalog.generate_series(1000, 10999) AS n;
CREATE TEMP TABLE timing AS SELECT pg_catalog.clock_timestamp() AS started;
INSERT INTO arena.metric_trust_artifacts (observation_id, role, raw_object_id, content_hash)
SELECT n, r.role, r.id, r.hash
  FROM pg_catalog.generate_series(1000, 10999) AS n,
       (VALUES ('source_payload', 1, pg_catalog.repeat('a', 64)),
               ('population_manifest', 2, 'run-a')) AS r(role, id, hash);
SELECT pg_catalog.round(1000 * pg_catalog.date_part('epoch',
         pg_catalog.clock_timestamp() - started))::int FROM timing;
ROLLBACK;
SQL
}

BEFORE="$(outcomes)"
BEFORE_MS="$(big_batch_ms)"

for expected in \
  $'valid payload and manifest\tkept 3' \
  $'valid profile payload\tkept 1' \
  $'hash algorithm is not sha256\trefused P0001 metric trust artifact is not immutable evidence from the bound run' \
  $'no integrity metadata\trefused P0001 metric trust artifact is not immutable evidence from the bound run' \
  $'wrong hash\trefused P0001 metric trust artifact is not immutable evidence from the bound run' \
  $'manifest is not the run\'s\trefused P0001 population manifest artifact does not identify the canonical source run' \
  $'payload is not the snapshot\trefused P0001 metric source payload is not the population snapshot payload'; do
  if ! grep -qxF "$expected" <<<"$BEFORE"; then
    echo "baseline outcome missing: $expected" >&2
    echo "$BEFORE" >&2
    exit 1
  fi
done
if [[ "$(grep -c $'\tkept ' <<<"$BEFORE")" != "2" ]]; then
  echo "expected exactly two accepted baseline cases" >&2
  echo "$BEFORE" >&2
  exit 1
fi
echo "ok: baseline (per-row trigger) accepts 2 of 20 cases and refuses the rest"

psql_db -q -f "$NEW_MIGRATION" >/dev/null

AFTER="$(outcomes)"
if [[ "$BEFORE" != "$AFTER" ]]; then
  echo "outcomes changed after the migration:" >&2
  diff <(echo "$BEFORE") <(echo "$AFTER") >&2 || true
  exit 1
fi
echo "ok: all 20 cases have the identical outcome (rows kept, SQLSTATE and message) after the migration"

if [[ "$(psql_db -Atq -c "SELECT pg_catalog.strpos(prosrc, 'v_raw_meta') FROM pg_proc WHERE oid = 'arena.validate_metric_trust_artifact()'::regprocedure")" != "0" ]]; then
  echo "the row trigger still reads the RAW meta document" >&2
  exit 1
fi
echo "ok: the row trigger no longer reads the RAW meta document"

AFTER_MS="$(big_batch_ms)"
if ((AFTER_MS * 5 > BEFORE_MS)); then
  echo "20,000 rows x 2,042-page meta: before ${BEFORE_MS}ms, after ${AFTER_MS}ms (want at least 5x faster)" >&2
  exit 1
fi
echo "ok: 20,000 rows x 2,042-page meta: ${BEFORE_MS}ms -> ${AFTER_MS}ms"

if psql_db -q -f "$NEW_MIGRATION" >/dev/null 2>"$TMP_ROOT/replay.err"; then
  echo "replaying the migration was not refused" >&2
  exit 1
fi
grep -q "is not the 20260721120000 definition" "$TMP_ROOT/replay.err"
echo "ok: a replay is refused"

echo "metric trust artifact raw integrity per statement PostgreSQL 17 proof passed"
