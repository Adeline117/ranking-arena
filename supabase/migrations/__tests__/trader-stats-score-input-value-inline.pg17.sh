#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for
# 20261127200517_trader_stats_score_input_value_inline.sql. It owns an
# isolated temporary cluster and never connects to a developer or remote DB.
#
# Proves:
#   1. results: the new function returns exactly what the 20261116205144
#      function returns over a matrix of rows and metrics (numbers, zero,
#      JSON null, strings, nested values, extras metrics, absent keys,
#      unknown metric names, SQL NULL arguments);
#   2. triggers: the native-board headline upsert (the production statement)
#      leaves the same evidence on arena.trader_stats before and after, across
#      new, repeated, overwritten, sparse and pointer-less writes;
#   3. inlining: before, the call appears in the plan; after, it does not;
#   4. the function references no table (pg_depend) and keeps its ACL;
#   5. replay is a no-op, a function edited by someone else is refused, and
#      the rollback restores the 20261116205144 definition byte for byte and
#      refuses to run twice;
#   6. timing (informational): the 32,700-row upsert before and after.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SQL_MODULE="$ROOT_DIR/lib/ingest/serving/headline-stats-sql.ts"
EVIDENCE_MIGRATION="$ROOT_DIR/supabase/migrations/20261116205144_trader_stats_score_input_evidence_pointer.sql"
MIGRATION="$ROOT_DIR/supabase/migrations/20261127200517_trader_stats_score_input_value_inline.sql"
ROLLBACK="$ROOT_DIR/scripts/maintenance/rollbacks/20261127200517_trader_stats_score_input_value_inline.rollback.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
ORIGINAL_SHA256='a5d13578432570afcad4ec763326eb0bcf59d505c907526ccf841bc91b347429'

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/score-input-value-inline-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55493
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if (( exit_code != 0 )) && [[ -f "$LOG_FILE" ]]; then
    tail -80 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}
scalar() {
  psql_cmd -At -c "$1"
}
ok() {
  echo "ok: $1"
}
fail() {
  echo "FAIL: $1" >&2
  exit 1
}

"$PG_BIN/initdb" -D "$DATA_DIR" -U postgres --auth-local=trust --auth-host=trust \
  --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

UPSERT_SQL="$(node -e '
const s = require("fs").readFileSync(process.argv[1], "utf8")
const m = s.match(/HEADLINE_STATS_UPSERT_SQL = `([\s\S]*?)`\s*$/)
if (!m) { console.error("HEADLINE_STATS_UPSERT_SQL not found"); process.exit(1) }
process.stdout.write(m[1])
' "$SQL_MODULE")"

psql_cmd <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA arena;
CREATE TABLE arena.traders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL,
  exchange_trader_id text NOT NULL,
  UNIQUE (source_id, exchange_trader_id)
);
CREATE TABLE arena.trader_stats (
  trader_id bigint NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  timeframe smallint NOT NULL CHECK (timeframe IN (0, 7, 30, 90)),
  as_of timestamptz NOT NULL,
  currency text NOT NULL,
  roi numeric, pnl numeric, sharpe numeric, mdd numeric, win_rate numeric,
  win_positions int, total_positions int, copier_pnl numeric, copier_count int,
  aum numeric, volume numeric, profit_share_rate numeric,
  holding_duration_avg interval, trading_preferences jsonb,
  extras jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (trader_id, timeframe)
);
CREATE INDEX ON arena.trader_stats (as_of);
SQL

psql_cmd -f "$EVIDENCE_MIGRATION" >/dev/null

[[ "$(scalar "SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') FROM pg_proc WHERE oid = 'arena.trader_stats_score_input_value(jsonb,text)'::regprocedure")" == "$ORIGINAL_SHA256" ]] \
  || fail 'fixture function is not the 20261116205144 definition'

# A frozen copy of the 20261116205144 function, for the result comparison.
psql_cmd <<'SQL'
CREATE FUNCTION arena.score_input_value_before(p_row jsonb, p_metric text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT NULLIF(
    CASE
      WHEN p_metric IN ('sortino', 'calmar', 'volatility')
        THEN p_row->'extras'->p_metric
      ELSE p_row->p_metric
    END,
    'null'::jsonb
  )
$function$;

CREATE TABLE arena.proof_rows (id int PRIMARY KEY, r jsonb);
INSERT INTO arena.proof_rows VALUES
  (1, '{"roi": 12.5, "pnl": -3, "win_rate": 0, "mdd": null, "extras": {"sortino": 1.2, "calmar": null}}'),
  (2, '{"roi": "12.5", "pnl": {"nested": 1}, "sharpe": [1, 2], "extras": {}}'),
  (3, '{"roi": null, "extras": null}'),
  (4, '{}'),
  (5, '{"extras": {"volatility": 0, "sortino": "x", "roi": 99}}'),
  (6, '{"roi": 0, "copier_count": 7, "total_positions": 0, "extras": {"volatility": {"a": null}}}'),
  (7, '[1, 2, 3]'),
  (8, '"scalar"'),
  (9, 'null'),
  (10, NULL);
CREATE TABLE arena.proof_metrics (m text);
INSERT INTO arena.proof_metrics VALUES
  ('roi'), ('pnl'), ('win_rate'), ('mdd'), ('sharpe'), ('copier_count'), ('total_positions'),
  ('sortino'), ('calmar'), ('volatility'), ('extras'), ('unknown_metric'), (''), (NULL);

-- Trigger scenarios through the production upsert; results land in proof_evidence.
CREATE TABLE arena.proof_evidence (
  phase text, scenario text, exchange_trader_id text,
  evidence_raw_object_id bigint, evidence_source_run_id text, evidence_metrics text[]
);
SQL

run_trigger_scenarios() {
  local phase="$1"
  psql_cmd <<SQL
INSERT INTO arena.traders (source_id, exchange_trader_id)
SELECT 9, '${phase}-' || name FROM unnest(ARRAY['full', 'sparse', 'none', 'extras', 'nulls']) AS name;
PREPARE upsert_${phase}(smallint, timestamptz, text, jsonb, smallint, bigint, text) AS
${UPSERT_SQL};

-- 1. first attempt-bound write
EXECUTE upsert_${phase}(30, '2026-11-01T00:00:00Z', 'USDT',
  '[{"exchange_trader_id":"${phase}-full","roi":10,"pnl":100,"win_rate":50,"mdd":5,"sharpe":1.2,"copier_count":3,"total_positions":9},
    {"exchange_trader_id":"${phase}-sparse","roi":10,"pnl":100},
    {"exchange_trader_id":"${phase}-extras","roi":1,"pnl":2,"extras":{"sortino":1.5,"calmar":null,"volatility":0}},
    {"exchange_trader_id":"${phase}-nulls","roi":null,"pnl":null}]'::jsonb, 9, 7001, repeat('a', 64));
INSERT INTO arena.proof_evidence
SELECT '${phase}', 'first', substr(t.exchange_trader_id, length('${phase}') + 2),
       s.evidence_raw_object_id, s.evidence_source_run_id, s.evidence_metrics
  FROM arena.trader_stats s JOIN arena.traders t ON t.id = s.trader_id
 WHERE t.exchange_trader_id LIKE '${phase}-%';

-- 2. a new attempt that sends fewer values (COALESCE retains the rest)
EXECUTE upsert_${phase}(30, '2026-11-02T00:00:00Z', 'USDT',
  '[{"exchange_trader_id":"${phase}-full","roi":11,"pnl":101},
    {"exchange_trader_id":"${phase}-sparse","roi":11,"pnl":101,"mdd":4},
    {"exchange_trader_id":"${phase}-extras","roi":1,"pnl":2,"extras":{"sortino":2.5}}]'::jsonb, 9, 7002, repeat('b', 64));
INSERT INTO arena.proof_evidence
SELECT '${phase}', 'second', substr(t.exchange_trader_id, length('${phase}') + 2),
       s.evidence_raw_object_id, s.evidence_source_run_id, s.evidence_metrics
  FROM arena.trader_stats s JOIN arena.traders t ON t.id = s.trader_id
 WHERE t.exchange_trader_id LIKE '${phase}-%';

-- 3. another writer overwrites values under the same pointer
UPDATE arena.trader_stats s SET roi = 999, extras = s.extras || '{"sortino": 9}'::jsonb
  FROM arena.traders t
 WHERE t.id = s.trader_id AND t.exchange_trader_id IN ('${phase}-full', '${phase}-extras');
UPDATE arena.trader_stats s SET pnl = s.pnl
  FROM arena.traders t
 WHERE t.id = s.trader_id AND t.exchange_trader_id = '${phase}-sparse';
INSERT INTO arena.proof_evidence
SELECT '${phase}', 'overwritten', substr(t.exchange_trader_id, length('${phase}') + 2),
       s.evidence_raw_object_id, s.evidence_source_run_id, s.evidence_metrics
  FROM arena.trader_stats s JOIN arena.traders t ON t.id = s.trader_id
 WHERE t.exchange_trader_id LIKE '${phase}-%';

-- 4. a write without a pointer
EXECUTE upsert_${phase}(30, '2026-11-03T00:00:00Z', 'USDT',
  '[{"exchange_trader_id":"${phase}-full","roi":12,"pnl":102},
    {"exchange_trader_id":"${phase}-none","roi":5,"pnl":6}]'::jsonb, 9, NULL, NULL);
INSERT INTO arena.proof_evidence
SELECT '${phase}', 'no_pointer', substr(t.exchange_trader_id, length('${phase}') + 2),
       s.evidence_raw_object_id, s.evidence_source_run_id, s.evidence_metrics
  FROM arena.trader_stats s JOIN arena.traders t ON t.id = s.trader_id
 WHERE t.exchange_trader_id LIKE '${phase}-%';
SQL
}

timed_upsert() {
  local label="$1" elapsed
  elapsed="$(psql_cmd <<SQL | sed -n 's/^Time: \([0-9.]*\) ms.*/\1/p' | tail -1
TRUNCATE arena.trader_stats;
DELETE FROM arena.traders WHERE exchange_trader_id LIKE 'bench-%';
INSERT INTO arena.traders (source_id, exchange_trader_id)
SELECT 8, 'bench-' || g FROM generate_series(1, 32700) AS g;
SELECT jsonb_agg(jsonb_build_object(
         'exchange_trader_id', 'bench-' || g, 'roi', g % 500 - 100, 'pnl', g * 3.7,
         'win_rate', 50 + g % 40, 'mdd', g % 30, 'aum', 1000 + g, 'copier_count', g % 90)) AS rows_first,
       jsonb_agg(jsonb_build_object(
         'exchange_trader_id', 'bench-' || g, 'roi', g % 500 - 99, 'pnl', g * 3.7,
         'win_rate', 50 + g % 40, 'mdd', g % 30, 'aum', 1000 + g, 'copier_count', g % 90)) AS rows_second
  FROM generate_series(1, 32700) AS g \\gset
PREPARE bench(smallint, timestamptz, text, jsonb, smallint, bigint, text) AS ${UPSERT_SQL};
EXECUTE bench(7, '2026-11-01T00:00:00Z', 'USDT', :'rows_first'::jsonb, 8, 7000, repeat('a', 64));
VACUUM ANALYZE arena.trader_stats;
\\timing on
EXECUTE bench(7, '2026-11-02T00:00:00Z', 'USDT', :'rows_second'::jsonb, 8, 7001, repeat('b', 64));
\\timing off
TRUNCATE arena.trader_stats;
DELETE FROM arena.traders WHERE exchange_trader_id LIKE 'bench-%';
SQL
)"
  [[ -n "$elapsed" ]] || fail "timing for $label was not captured"
  echo "info: 32,700-row board upsert over existing rows, $label: ${elapsed%.*} ms"
}

plan_mentions_function() {
  psql_cmd -At -c "EXPLAIN (VERBOSE, COSTS OFF)
    SELECT arena.trader_stats_score_input_value(p.r, 'roi') FROM arena.proof_rows AS p" \
    | grep -c 'trader_stats_score_input_value' || true
}

# --- before -----------------------------------------------------------------
run_trigger_scenarios before
[[ "$(plan_mentions_function)" -ge 1 ]] || fail 'negative control: the 20261116205144 function should not be inlined'
ok 'before: the call is a function call in the plan (SET search_path prevents inlining)'
timed_upsert 'before (20261116205144)'

# --- migration --------------------------------------------------------------
psql_cmd -f "$MIGRATION" >/dev/null
ok 'migration applies'

[[ "$(plan_mentions_function)" == "0" ]] || fail 'after: the function is still called, not inlined'
ok 'after: the call is inlined (no function call in the plan)'

mismatches="$(scalar "
  SELECT count(*)
    FROM arena.proof_rows AS p CROSS JOIN arena.proof_metrics AS m
   WHERE arena.trader_stats_score_input_value(p.r, m.m)
         IS DISTINCT FROM arena.score_input_value_before(p.r, m.m)")"
cases="$(scalar "SELECT count(*) FROM arena.proof_rows CROSS JOIN arena.proof_metrics")"
non_null="$(scalar "
  SELECT count(*)
    FROM arena.proof_rows AS p CROSS JOIN arena.proof_metrics AS m
   WHERE arena.score_input_value_before(p.r, m.m) IS NOT NULL")"
[[ "$mismatches" == "0" ]] || fail "results differ in $mismatches of $cases cases"
[[ "$non_null" -ge 10 ]] || fail "the matrix exercises too few non-null results ($non_null)"
ok "results: identical in all $cases row x metric cases ($non_null non-null)"

run_trigger_scenarios after
evidence_diff="$(scalar "
  SELECT count(*) FROM (
    (SELECT scenario, exchange_trader_id, evidence_raw_object_id, evidence_source_run_id, evidence_metrics
       FROM arena.proof_evidence WHERE phase = 'before'
     EXCEPT ALL
     SELECT scenario, exchange_trader_id, evidence_raw_object_id, evidence_source_run_id, evidence_metrics
       FROM arena.proof_evidence WHERE phase = 'after')
    UNION ALL
    (SELECT scenario, exchange_trader_id, evidence_raw_object_id, evidence_source_run_id, evidence_metrics
       FROM arena.proof_evidence WHERE phase = 'after'
     EXCEPT ALL
     SELECT scenario, exchange_trader_id, evidence_raw_object_id, evidence_source_run_id, evidence_metrics
       FROM arena.proof_evidence WHERE phase = 'before')
  ) AS d")"
evidence_rows="$(scalar "SELECT count(*) FROM arena.proof_evidence WHERE phase = 'after'")"
attested="$(scalar "SELECT count(*) FROM arena.proof_evidence WHERE phase = 'after' AND evidence_metrics IS NOT NULL")"
stripped="$(scalar "
  SELECT count(*) FROM arena.proof_evidence AS o JOIN arena.proof_evidence AS s USING (phase, exchange_trader_id)
   WHERE phase = 'after' AND s.scenario = 'second' AND o.scenario = 'overwritten'
     AND o.evidence_metrics IS DISTINCT FROM s.evidence_metrics")"
[[ "$evidence_diff" == "0" ]] || fail "trigger evidence differs in $evidence_diff rows"
[[ "$attested" -ge 6 && "$stripped" -ge 2 ]] || fail "trigger scenarios exercise too little (attested $attested, stripped $stripped)"
ok "triggers: identical evidence on all $evidence_rows rows ($attested attested, $stripped stripped by an overwrite)"

table_deps="$(scalar "
  SELECT count(*) FROM pg_depend
   WHERE classid = 'pg_proc'::regclass
     AND objid = 'arena.trader_stats_score_input_value(jsonb,text)'::regprocedure
     AND refclassid = 'pg_class'::regclass")"
[[ "$table_deps" == "0" ]] || fail "the function depends on $table_deps relation(s)"
foreign_grants="$(scalar "
  SELECT count(*) FROM pg_proc AS p,
         LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS a
   WHERE p.oid = 'arena.trader_stats_score_input_value(jsonb,text)'::regprocedure
     AND a.grantee <> p.proowner")"
[[ "$foreign_grants" == "0" ]] || fail "a role other than the owner holds a privilege ($foreign_grants)"
ok 'the function references no table and only its owner holds a privilege'

timed_upsert 'after (20261127200517)'

# --- replay, refusal, rollback -----------------------------------------------
before_def="$(scalar "SELECT pg_get_functiondef('arena.trader_stats_score_input_value(jsonb,text)'::regprocedure)")"
psql_cmd -f "$MIGRATION" >/dev/null
[[ "$(scalar "SELECT pg_get_functiondef('arena.trader_stats_score_input_value(jsonb,text)'::regprocedure)")" == "$before_def" ]] \
  || fail 'replay changed the definition'
ok 'replay: applies again and changes nothing'

psql_cmd -f "$ROLLBACK" >/dev/null
[[ "$(scalar "SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') || '|' || array_to_string(proconfig, ',') || '|' || (prosqlbody IS NULL)::text || '|' || COALESCE(obj_description(oid, 'pg_proc'), '<none>') FROM pg_proc WHERE oid = 'arena.trader_stats_score_input_value(jsonb,text)'::regprocedure")" \
  == "$ORIGINAL_SHA256|search_path=pg_catalog, pg_temp|true|<none>" ]] || fail 'rollback did not restore the 20261116205144 definition'
[[ "$(plan_mentions_function)" -ge 1 ]] || fail 'after rollback the function should be a call again'
if psql_cmd -f "$ROLLBACK" >/dev/null 2>&1; then
  fail 'rollback ran twice'
fi
ok 'rollback: restores the 20261116205144 definition exactly and refuses a second run'

psql_cmd -f "$MIGRATION" >/dev/null
[[ "$(plan_mentions_function)" == "0" ]] || fail 'migration after rollback did not inline'
ok 'migration applies again after the rollback'

psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION arena.trader_stats_score_input_value(p_row jsonb, p_metric text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $function$ SELECT p_row->p_metric $function$;
SQL
if psql_cmd -f "$MIGRATION" >/dev/null 2>&1; then
  fail 'migration overwrote a function edited by someone else'
fi
[[ "$(scalar "SELECT prosrc FROM pg_proc WHERE oid = 'arena.trader_stats_score_input_value(jsonb,text)'::regprocedure")" == " SELECT p_row->p_metric " ]] \
  || fail 'refused migration left a change behind'
if psql_cmd -f "$ROLLBACK" >/dev/null 2>&1; then
  fail 'rollback ran over a function edited by someone else'
fi
ok 'an edited function is refused by both the migration and the rollback, and left as it was'

echo 'trader_stats score-input value inline PostgreSQL 17 proof passed'
