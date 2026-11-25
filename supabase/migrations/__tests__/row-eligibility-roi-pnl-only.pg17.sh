#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for 20261122201611_row_eligibility_roi_pnl_only:
# the public rank row policy requires ROI and PnL only.
#
#   1. The fixture installs the production policy function from the migration
#      that last defined it (20261111140053) and checks its body digest.
#   2. Before the migration: partial / minimal rows are refused (the reason the
#      deploy order is database -> website -> scoring worker).
#   3. The migration runs as a NOSUPERUSER postgres role (as on Supabase).
#   4. After: the row matrix in fixtures/row-eligibility-roi-pnl-cases.json,
#      which the TypeScript reader and writer are tested against too.
#   5. Replay changes nothing. Owner, SECURITY, volatility, config, ACL and
#      comment are identical before and after.
#   6. Drift: an unreviewed body, a foreign grant, SECURITY DEFINER or another
#      owner each make the whole migration refuse and leave the function as it was.
#   7. Objects that call the policy by reference follow it without being
#      recreated, and zero-return rows rank after every profitable row under
#      the rerank ordering.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
MIGRATION="$MIGRATIONS/20261122201611_row_eligibility_roi_pnl_only.sql"
BASELINE="$MIGRATIONS/20261111140053_leaderboard_ranks_codec_layout_rebuild.sql"
CASES="$ROOT_DIR/supabase/migrations/__tests__/fixtures/row-eligibility-roi-pnl-cases.json"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

OLD_BODY_SHA256='aa87e8343569cccdeeea84bee66fbf9cd20b8b75e39b1a6d63e78f110e4bf0df'
NEW_BODY_SHA256='1a9fd63c3a986c44bc8cc39a25d4e1962b2f09b34c89cabdc63eba2567601429'
POLICY='arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamp with time zone)'

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

TMP_ROOT="$(mktemp -d /tmp/row-eligibility-roi-pnl-pg17.XXXXXX)"
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
    tail -80 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

psql_admin() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U supabase_admin -d postgres "$@"
}

expect_eq() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label drifted:" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
}

body_sha256() {
  psql_cmd -Atqc "
    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(prosrc, 'UTF8')), 'hex')
    FROM pg_catalog.pg_proc
    WHERE oid = '$POLICY'::pg_catalog.regprocedure;
  "
}

# Everything the migration promises not to move.
policy_attributes() {
  psql_cmd -Atqc "
    SELECT pg_catalog.concat_ws('|',
      procedure_row.oid::pg_catalog.text,
      pg_catalog.pg_get_userbyid(procedure_row.proowner),
      language_row.lanname,
      procedure_row.prokind,
      procedure_row.prosecdef,
      procedure_row.proleakproof,
      procedure_row.proisstrict,
      procedure_row.provolatile,
      procedure_row.proparallel,
      procedure_row.prorettype::pg_catalog.regtype,
      pg_catalog.pg_get_function_identity_arguments(procedure_row.oid),
      procedure_row.proconfig::pg_catalog.text,
      COALESCE(procedure_row.proacl::pg_catalog.text, '<default>'),
      pg_catalog.obj_description(procedure_row.oid, 'pg_proc')
    )
    FROM pg_catalog.pg_proc AS procedure_row
    JOIN pg_catalog.pg_language AS language_row ON language_row.oid = procedure_row.prolang
    WHERE procedure_row.oid = '$POLICY'::pg_catalog.regprocedure;
  "
}

# label|eligible for every matrix case, in file order.
matrix() {
  psql_cmd -Atq -v cases="$(cat "$CASES")" <<'SQL'
WITH document AS (
  SELECT :'cases'::pg_catalog.jsonb AS value
), observed AS (
  SELECT '2026-11-22T12:00:00Z'::pg_catalog.timestamptz AS at
), cases AS (
  SELECT
    entry.ordinality,
    entry.value ->> 'label' AS label,
    (document.value -> 'base') || (entry.value -> 'row') AS row_value
  FROM document
  CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(document.value -> 'cases')
    WITH ORDINALITY AS entry(value, ordinality)
)
SELECT
  cases.label || '|' ||
  arena.leaderboard_rank_row_is_public_eligible(
    ROW(
      cases.ordinality,
      '7D',
      cases.row_value ->> 'source',
      cases.row_value ->> 'source_trader_id',
      cases.row_value ->> 'score_completeness',
      (cases.row_value ->> 'metrics_estimated')::pg_catalog.bool,
      (cases.row_value ->> 'is_outlier')::pg_catalog.bool,
      (cases.row_value ->> 'arena_score')::pg_catalog.numeric,
      (cases.row_value ->> 'roi')::pg_catalog.numeric,
      (cases.row_value ->> 'pnl')::pg_catalog.numeric,
      (cases.row_value ->> 'win_rate')::pg_catalog.numeric,
      (cases.row_value ->> 'max_drawdown')::pg_catalog.numeric,
      observed.at - pg_catalog.make_interval(
        secs => ((cases.row_value ->> 'computed_age_hours')::pg_catalog.numeric * 3600)::pg_catalog.float8
      ),
      NULL::pg_catalog.int4
    )::public.leaderboard_ranks,
    observed.at
  )::pg_catalog.text
FROM cases
CROSS JOIN observed
ORDER BY cases.ordinality;
SQL
}

expected_matrix() {
  # $1 = before | after
  node -e '
    const doc = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
    for (const entry of doc.cases) console.log(`${entry.label}|${entry[process.argv[2]]}`)
  ' "$CASES" "$1"
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U supabase_admin --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

# Like Supabase: the cluster superuser is supabase_admin; every fixture object
# and the migration run as a NOSUPERUSER postgres role.
psql_admin -q <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE NOBYPASSRLS;
CREATE ROLE anon NOLOGIN NOSUPERUSER;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER;
CREATE ROLE service_role NOLOGIN NOSUPERUSER;
CREATE ROLE other_owner NOLOGIN NOSUPERUSER;
GRANT anon, authenticated, service_role, other_owner TO postgres;
GRANT CREATE ON DATABASE postgres TO postgres;
ALTER SCHEMA public OWNER TO postgres;
SQL
if [[ "$(psql_cmd -Atqc "SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user")" != "f" ]]; then
  echo "migrations must run as a non-superuser postgres role" >&2
  exit 1
fi

# The policy reads these columns only; the production table has more.
psql_cmd -q <<'SQL'
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA arena TO other_owner;
GRANT CREATE ON SCHEMA arena TO other_owner;

CREATE TABLE public.leaderboard_ranks (
  id bigint GENERATED BY DEFAULT AS IDENTITY,
  season_id text NOT NULL,
  source text NOT NULL,
  source_trader_id text NOT NULL,
  score_completeness text,
  metrics_estimated boolean,
  is_outlier boolean,
  arena_score numeric(10, 2),
  roi numeric(12, 4),
  pnl numeric(18, 2),
  win_rate numeric(5, 2),
  max_drawdown numeric(5, 2),
  computed_at timestamptz,
  rank integer,
  PRIMARY KEY (id, season_id)
);
SQL

# 1. Install the production definition from the migration that owns it: the
#    CREATE FUNCTION statement through the COMMENT, exactly as written there.
awk '
  /^CREATE FUNCTION arena\.leaderboard_rank_row_is_public_eligible\(/ { printing = 1 }
  printing { print }
  printing && /Canonical database row policy shared by seal/ { exit }
' "$BASELINE" >"$TMP_ROOT/baseline-policy.sql"
if ! grep -q 'FROM PUBLIC, anon, authenticated, service_role;' "$TMP_ROOT/baseline-policy.sql"; then
  echo "could not extract the production policy definition from $BASELINE" >&2
  exit 1
fi
psql_cmd -q -f "$TMP_ROOT/baseline-policy.sql"
expect_eq "production body digest" "$(body_sha256)" "$OLD_BODY_SHA256"

# Dependents that call the policy by reference, as rerank / the public view do.
# The window is the rank assignment of rerank_leaderboard_publication.
psql_cmd -q <<'SQL'
CREATE VIEW public.fixture_ranked AS
SELECT
  rank_row.source,
  rank_row.source_trader_id,
  rank_row.arena_score,
  rank_row.roi,
  pg_catalog.row_number() OVER (
    ORDER BY rank_row.arena_score DESC NULLS LAST, rank_row.id
  ) AS rank
FROM public.leaderboard_ranks AS rank_row
WHERE arena.leaderboard_rank_row_is_public_eligible(rank_row, pg_catalog.statement_timestamp());

CREATE FUNCTION public.fixture_ineligible_count()
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.count(*)
  FROM public.leaderboard_ranks AS rank_row
  WHERE NOT arena.leaderboard_rank_row_is_public_eligible(
    rank_row, pg_catalog.statement_timestamp()
  );
$function$;
SQL
VIEW_OID_BEFORE="$(psql_cmd -Atqc "SELECT 'public.fixture_ranked'::pg_catalog.regclass::pg_catalog.oid")"

# 2. Before: the four-metric policy.
expect_eq "matrix before the migration" "$(matrix)" "$(expected_matrix before)"
ATTRIBUTES_BEFORE="$(policy_attributes)"
expect_eq "production ACL is owner-only" \
  "$(psql_cmd -Atqc "SELECT proacl::text FROM pg_catalog.pg_proc WHERE oid = '$POLICY'::pg_catalog.regprocedure")" \
  "{postgres=X/postgres}"

# A row published by the relaxed scoring worker is NOT eligible on the old
# database: seal would refuse the season. Deploy order: database first.
psql_cmd -q <<'SQL'
INSERT INTO public.leaderboard_ranks (
  season_id, source, source_trader_id, score_completeness, metrics_estimated,
  is_outlier, arena_score, roi, pnl, win_rate, max_drawdown, computed_at
) VALUES
  ('7D', 'bybit', 'full-row',    'full',    false, false, 61.20, 40, 9000, 55, 12, pg_catalog.now()),
  ('7D', 'bybit', 'partial-row', 'partial', false, false, 33.10, 25, 4000, NULL, 9, pg_catalog.now()),
  ('7D', 'bybit', 'minimal-row', 'minimal', false, false, 12.40, 10, 1000, NULL, NULL, pg_catalog.now());
SQL
expect_eq "old database refuses rows of the relaxed writer" \
  "$(psql_cmd -Atqc "SELECT public.fixture_ineligible_count()")" "2"
expect_eq "old database ranks only the full row" \
  "$(psql_cmd -Atqc "SELECT pg_catalog.string_agg(source_trader_id, ',' ORDER BY rank) FROM public.fixture_ranked")" \
  "full-row"

# 3. Apply as the non-superuser postgres role.
psql_cmd -q -f "$MIGRATION"
expect_eq "installed body digest" "$(body_sha256)" "$NEW_BODY_SHA256"
expect_eq "attributes other than the body" "$(policy_attributes)" "$ATTRIBUTES_BEFORE"
expect_eq "no custom-parameter SET on the function" \
  "$(psql_cmd -Atqc "SELECT proconfig::text FROM pg_catalog.pg_proc WHERE oid = '$POLICY'::pg_catalog.regprocedure")" \
  "{\"search_path=pg_catalog, pg_temp\"}"
expect_eq "no temp table is left behind" \
  "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM pg_catalog.pg_class WHERE relname = 'row_eligibility_roi_pnl_only_before'")" \
  "0"

# 4. After: ROI + PnL policy.
expect_eq "matrix after the migration" "$(matrix)" "$(expected_matrix after)"

# 7a. Dependents follow without being recreated.
expect_eq "dependent view was not recreated" \
  "$(psql_cmd -Atqc "SELECT 'public.fixture_ranked'::pg_catalog.regclass::pg_catalog.oid")" \
  "$VIEW_OID_BEFORE"
expect_eq "new database accepts rows of the relaxed writer" \
  "$(psql_cmd -Atqc "SELECT public.fixture_ineligible_count()")" "0"
expect_eq "partial and minimal rows are ranked by score" \
  "$(psql_cmd -Atqc "SELECT pg_catalog.string_agg(source_trader_id, ',' ORDER BY rank) FROM public.fixture_ranked")" \
  "full-row,partial-row,minimal-row"

# Privileges: still nobody but the owner.
expect_eq "privileges" \
  "$(psql_cmd -Atqc "
    SELECT pg_catalog.concat_ws('|',
      pg_catalog.has_function_privilege('anon', '$POLICY', 'EXECUTE'),
      pg_catalog.has_function_privilege('authenticated', '$POLICY', 'EXECUTE'),
      pg_catalog.has_function_privilege('service_role', '$POLICY', 'EXECUTE'),
      pg_catalog.has_function_privilege('postgres', '$POLICY', 'EXECUTE'));
  ")" \
  "f|f|f|t"

# 5. Replay: accepted, and nothing changes.
psql_cmd -q -f "$MIGRATION"
expect_eq "replay body digest" "$(body_sha256)" "$NEW_BODY_SHA256"
expect_eq "replay attributes" "$(policy_attributes)" "$ATTRIBUTES_BEFORE"
expect_eq "matrix after replay" "$(matrix)" "$(expected_matrix after)"

# 7b. Zero-return rows rank after every profitable row, in a stable order.
# Rows arrive in the order the publication writer sends them: display score
# descending, then ROI, then PnL, then identity. Three zero rows share the
# 0.01 floor with nothing else; two share 0.37 with a profitable row.
psql_cmd -q <<'SQL'
DELETE FROM public.leaderboard_ranks;
INSERT INTO public.leaderboard_ranks (
  season_id, source, source_trader_id, score_completeness, metrics_estimated,
  is_outlier, arena_score, roi, pnl, win_rate, max_drawdown, computed_at
) VALUES
  ('7D', 'bybit',  'profit-a',  'full',    false, false, 88.00, 60, 90000, 61, 8, pg_catalog.now()),
  ('7D', 'toobit', 'profit-b',  'minimal', false, false, 41.00, 22, 3000, NULL, NULL, pg_catalog.now()),
  ('7D', 'bybit',  'loss-full', 'full',    false, false, 9.50, -12, -700, 44, 31, pg_catalog.now()),
  ('7D', 'xt',     'profit-c',  'minimal', false, false, 0.37, 0.4, 3, NULL, NULL, pg_catalog.now()),
  ('7D', 'xt',     'zero-1',    'minimal', false, false, 0.37, 0, 0, NULL, NULL, pg_catalog.now()),
  ('7D', 'xt',     'zero-2',    'minimal', false, false, 0.37, 0, 0, NULL, NULL, pg_catalog.now()),
  ('7D', 'xt',     'loss-min',  'minimal', false, false, 0.01, -30, -90, NULL, NULL, pg_catalog.now()),
  ('7D', 'xt',     'zero-3',    'minimal', false, false, 0.01, 0, 0, NULL, NULL, pg_catalog.now());
SQL
ORDER_ONE="$(psql_cmd -Atqc "SELECT pg_catalog.string_agg(source_trader_id, ',' ORDER BY rank) FROM public.fixture_ranked")"
expect_eq "zero-return rows rank after every profitable row" "$ORDER_ONE" \
  "profit-a,profit-b,loss-full,profit-c,zero-1,zero-2,loss-min,zero-3"
# A republication updates rows in place (ON CONFLICT keeps the id): same order.
psql_cmd -q -c "UPDATE public.leaderboard_ranks SET computed_at = pg_catalog.now(), rank = NULL"
expect_eq "the order is reproducible across republications" \
  "$(psql_cmd -Atqc "SELECT pg_catalog.string_agg(source_trader_id, ',' ORDER BY rank) FROM public.fixture_ranked")" \
  "$ORDER_ONE"
expect_eq "ranks are unique and dense when many rows share the floor score" \
  "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) || '|' || pg_catalog.count(DISTINCT rank) || '|' || pg_catalog.max(rank) FROM public.fixture_ranked")" \
  "8|8|8"

# 6. Drift: each case must make the migration refuse and change nothing.
refuses() {
  local label="$1" expected_message="$2" output
  local digest_before attributes_before
  digest_before="$(body_sha256)"
  attributes_before="$(policy_attributes)"
  if output="$(psql_cmd -q -f "$MIGRATION" 2>&1)"; then
    echo "$label: the migration ran against a drifted function" >&2
    exit 1
  fi
  if [[ "$output" != *"$expected_message"* ]]; then
    echo "$label: refused for an unexpected reason:" >&2
    echo "$output" >&2
    exit 1
  fi
  expect_eq "$label left the body alone" "$(body_sha256)" "$digest_before"
  expect_eq "$label left the attributes alone" "$(policy_attributes)" "$attributes_before"
}

# 6a. An unreviewed body (one token differs from production).
sed 's/interval '"'"'48 hours'"'"'/interval '"'"'72 hours'"'"'/' "$TMP_ROOT/baseline-policy.sql" \
  | sed 's/^CREATE FUNCTION /CREATE OR REPLACE FUNCTION /' \
  | awk '{ print } /^\$function\$;/ { exit }' >"$TMP_ROOT/drifted-policy.sql"
psql_cmd -q -f "$TMP_ROOT/drifted-policy.sql"
if [[ "$(body_sha256)" == "$OLD_BODY_SHA256" || "$(body_sha256)" == "$NEW_BODY_SHA256" ]]; then
  echo "the drift fixture did not change the body" >&2
  exit 1
fi
refuses "unreviewed body" "unexpected body of arena.leaderboard_rank_row_is_public_eligible"

# Back to the exact production body for the attribute cases.
awk '{ print } /^\$function\$;/ { exit }' "$TMP_ROOT/baseline-policy.sql" \
  | sed 's/^CREATE FUNCTION /CREATE OR REPLACE FUNCTION /' >"$TMP_ROOT/restore-policy.sql"
psql_cmd -q -f "$TMP_ROOT/restore-policy.sql"
expect_eq "restored production body" "$(body_sha256)" "$OLD_BODY_SHA256"

# 6b. A foreign grant.
psql_cmd -q -c "GRANT EXECUTE ON FUNCTION $POLICY TO anon"
refuses "foreign grant" "executable by a role other than its owner"
psql_cmd -q -c "REVOKE EXECUTE ON FUNCTION $POLICY FROM anon"

# 6c. SECURITY DEFINER.
psql_cmd -q -c "ALTER FUNCTION $POLICY SECURITY DEFINER"
refuses "security definer" "unexpected attributes"
psql_cmd -q -c "ALTER FUNCTION $POLICY SECURITY INVOKER"

# 6d. Volatility.
psql_cmd -q -c "ALTER FUNCTION $POLICY STABLE"
refuses "volatility" "unexpected attributes"
psql_cmd -q -c "ALTER FUNCTION $POLICY IMMUTABLE"

# 6e. An extra function-level setting.
psql_cmd -q -c "ALTER FUNCTION $POLICY SET statement_timeout = '5s'"
refuses "extra function setting" "unexpected attributes"
psql_cmd -q -c "ALTER FUNCTION $POLICY RESET statement_timeout"

# 6f. Another owner.
psql_cmd -q -c "ALTER FUNCTION $POLICY OWNER TO other_owner"
refuses "another owner" "unexpected attributes"
psql_cmd -q -c "ALTER FUNCTION $POLICY OWNER TO postgres"

# 6g. The function is missing.
psql_cmd -q <<'SQL'
BEGIN;
DROP VIEW public.fixture_ranked;
DROP FUNCTION public.fixture_ineligible_count();
ALTER FUNCTION arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks, timestamptz)
  RENAME TO leaderboard_rank_row_is_public_eligible_moved;
COMMIT;
SQL
if output="$(psql_cmd -q -f "$MIGRATION" 2>&1)"; then
  echo "missing function: the migration created a new policy function" >&2
  exit 1
fi
if [[ "$output" != *"does not exist"* ]]; then
  echo "missing function: refused for an unexpected reason:" >&2
  echo "$output" >&2
  exit 1
fi
expect_eq "missing function: nothing was created" \
  "$(psql_cmd -Atqc "SELECT pg_catalog.to_regprocedure('$POLICY') IS NULL")" "t"
psql_cmd -q -c "ALTER FUNCTION arena.leaderboard_rank_row_is_public_eligible_moved(public.leaderboard_ranks, timestamptz) RENAME TO leaderboard_rank_row_is_public_eligible"

# After every drift is undone the migration applies again from production state.
expect_eq "undone drift is the production state" "$(policy_attributes)" "$ATTRIBUTES_BEFORE"
psql_cmd -q -f "$MIGRATION"
expect_eq "final body digest" "$(body_sha256)" "$NEW_BODY_SHA256"
expect_eq "final attributes" "$(policy_attributes)" "$ATTRIBUTES_BEFORE"
expect_eq "final matrix" "$(matrix)" "$(expected_matrix after)"

echo "row eligibility ROI + PnL PostgreSQL 17 proof passed"
