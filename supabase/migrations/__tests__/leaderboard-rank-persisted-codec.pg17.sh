#!/usr/bin/env bash

# PostgreSQL 17 behavioral proof for persisted rank canonical batch evidence.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260725016500_leaderboard_rank_persisted_codec.sql"
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

TMP_ROOT="$(mktemp -d /tmp/rank-persisted-codec-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((59000 + ($$ % 5000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -240 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

expect_failure() {
  local label="$1"
  local pattern="$2"
  local sql="$3"
  if psql_cmd -q -c "$sql" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! rg -q "$pattern" "$ERROR_FILE"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,220p' "$ERROR_FILE" >&2
    exit 1
  fi
}

expect_migration_failure() {
  local label="$1"
  local pattern="$2"
  if psql_cmd -q -f "$MIGRATION" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! rg -q "$pattern" "$ERROR_FILE"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,240p' "$ERROR_FILE" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --username=postgres \
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
CREATE ROLE fixture_rogue NOLOGIN;
CREATE SCHEMA arena;

CREATE TABLE arena.leaderboard_rank_generation_batch_receipts (
  fixture_id integer
);

CREATE SEQUENCE public.leaderboard_ranks_id_seq;
CREATE TABLE public.leaderboard_ranks (
  id bigint NOT NULL DEFAULT pg_catalog.nextval(
    'public.leaderboard_ranks_id_seq'::pg_catalog.regclass
  ),
  season_id text NOT NULL,
  source text NOT NULL,
  source_type text,
  source_trader_id text NOT NULL,
  rank integer,
  arena_score numeric(10, 2),
  roi numeric(12, 4),
  pnl numeric(18, 2),
  win_rate numeric(5, 2),
  max_drawdown numeric(5, 2),
  followers integer,
  trades_count integer,
  handle text,
  avatar_url text,
  computed_at timestamptz,
  profitability_score numeric(6, 2),
  risk_control_score numeric(6, 2),
  execution_score numeric(6, 2),
  score_completeness text,
  trading_style text,
  avg_holding_hours numeric(10, 2),
  style_confidence numeric(6, 4),
  sharpe_ratio numeric(10, 4),
  sortino_ratio numeric(10, 4),
  profit_factor numeric(10, 4),
  calmar_ratio numeric(10, 4),
  trader_type text,
  is_outlier boolean,
  metrics_estimated boolean,
  rank_change integer,
  is_new boolean,
  copiers integer,
  arena_score_v4 numeric,
  arena_score_v3 numeric,
  score_factors jsonb,
  rank_publication_id uuid,
  CONSTRAINT leaderboard_ranks_identity_key
    UNIQUE (season_id, source, source_trader_id)
) PARTITION BY LIST (season_id);

CREATE TABLE public.lr_7d
  PARTITION OF public.leaderboard_ranks FOR VALUES IN ('7D');
CREATE TABLE public.lr_30d
  PARTITION OF public.leaderboard_ranks FOR VALUES IN ('30D');
CREATE TABLE public.lr_90d
  PARTITION OF public.leaderboard_ranks FOR VALUES IN ('90D');
CREATE TABLE public.lr_default
  PARTITION OF public.leaderboard_ranks DEFAULT;
SQL

# Partial installs and same-name overloads must fail without convergence.
psql_cmd -q <<'SQL'
CREATE FUNCTION arena.encode_leaderboard_rank_row_v1(
  p_rank public.leaderboard_ranks
)
RETURNS jsonb LANGUAGE sql STABLE STRICT PARALLEL SAFE
AS 'SELECT NULL::jsonb';
SQL
expect_migration_failure \
  'codec migration accepted a partial install' \
  'persisted rank codec is only partially installed'
psql_cmd -q -c \
  'DROP FUNCTION arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks)'

psql_cmd -q <<'SQL'
CREATE FUNCTION arena.encode_leaderboard_rank_row_v1(p_rank text)
RETURNS jsonb LANGUAGE sql STABLE STRICT PARALLEL SAFE
AS 'SELECT NULL::jsonb';
SQL
expect_migration_failure \
  'codec migration accepted a hostile overload' \
  'persisted rank codec has a noncanonical overload'
psql_cmd -q -c 'DROP FUNCTION arena.encode_leaderboard_rank_row_v1(text)'

psql_cmd -q -c 'ALTER TABLE public.leaderboard_ranks ADD COLUMN hostile text'
expect_migration_failure \
  'codec migration accepted an extra persisted column' \
  '37-column persisted codec contract drifted'
psql_cmd -q -c 'ALTER TABLE public.leaderboard_ranks DROP COLUMN hostile'

psql_cmd -q -c \
  'ALTER TABLE public.leaderboard_ranks ALTER COLUMN arena_score TYPE numeric(10,3)'
expect_migration_failure \
  'codec migration accepted numeric typmod drift' \
  '37-column persisted codec contract drifted'
psql_cmd -q -c \
  'ALTER TABLE public.leaderboard_ranks ALTER COLUMN arena_score TYPE numeric(10,2)'

psql_cmd -q -c \
  'ALTER TABLE public.leaderboard_ranks DETACH PARTITION public.lr_default'
expect_migration_failure \
  'codec migration accepted a detached partition' \
  'partition topology drifted'
psql_cmd -q -c \
  'ALTER TABLE public.leaderboard_ranks ATTACH PARTITION public.lr_default DEFAULT'

psql_cmd -q -f "$MIGRATION"

CATALOG_STATE="$(psql_cmd -At -c "
  SELECT pg_catalog.string_agg(
    function_row.proname || '|' ||
    function_row.proowner::pg_catalog.regrole::text || '|' ||
    function_row.provolatile::text || '|' ||
    function_row.proparallel::text || '|' ||
    function_row.prosecdef::text || '|' ||
    function_row.proisstrict::text || '|' ||
    pg_catalog.array_to_string(function_row.proconfig, ','),
    E'\\n' ORDER BY function_row.proname COLLATE pg_catalog.\"C\"
  )
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid IN (
    'arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks)'::regprocedure,
    'arena.build_leaderboard_rank_batch_evidence_v1(text,uuid,jsonb)'::regprocedure
  );
")"
if [[ "$CATALOG_STATE" != *'build_leaderboard_rank_batch_evidence_v1|postgres|v|u|false|false|search_path=pg_catalog, pg_temp,TimeZone=UTC,lock_timeout=10s'* \
   || "$CATALOG_STATE" != *'encode_leaderboard_rank_row_v1|postgres|s|s|false|true|search_path=pg_catalog, pg_temp,TimeZone=UTC'* ]]; then
  echo "persisted codec catalog state is unexpected" >&2
  printf '%s\n' "$CATALOG_STATE" >&2
  exit 1
fi

QUADRATIC_ACCUMULATOR="$(psql_cmd -At -c "
  SELECT (
    function_row.prosrc LIKE '%v_normalized_identities := v_normalized_identities ||%'
    OR function_row.prosrc LIKE '%v_encoded_rows := v_encoded_rows ||%'
    OR function_row.prosrc LIKE '%v_source_ids := v_source_ids ||%'
    OR function_row.prosrc LIKE '%v_source_proofs := v_source_proofs ||%'
  )::text
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'arena.build_leaderboard_rank_batch_evidence_v1(text,uuid,jsonb)'::regprocedure;
")"
if [[ "$QUADRATIC_ACCUMULATOR" != 'false' ]]; then
  echo "persisted batch builder contains a quadratic JSONB accumulator" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
INSERT INTO public.leaderboard_ranks (
  id,
  season_id,
  source,
  source_type,
  source_trader_id,
  rank,
  rank_change,
  is_new,
  arena_score,
  arena_score_v4,
  arena_score_v3,
  score_factors,
  roi,
  pnl,
  win_rate,
  max_drawdown,
  followers,
  copiers,
  trades_count,
  handle,
  avatar_url,
  computed_at,
  profitability_score,
  risk_control_score,
  execution_score,
  score_completeness,
  trading_style,
  avg_holding_hours,
  style_confidence,
  sharpe_ratio,
  sortino_ratio,
  profit_factor,
  calmar_ratio,
  trader_type,
  is_outlier,
  metrics_estimated,
  rank_publication_id
) VALUES
  (
    101,
    '90D',
    'alpha',
    'web3',
    'trader-1',
    1,
    NULL,
    true,
    90.00,
    90.0000,
    88.0000,
    '{"roi":1.0,"pnl":1.00,"drawdown":0.00,"sharpe":null,"consistency":-0.00}',
    -0.0000,
    0.00,
    55.00,
    5.50,
    0,
    NULL,
    NULL,
    E'Quote " and newline\n',
    NULL,
    '2026-07-28 12:34:56.123456+00',
    90.00,
    80.00,
    70.00,
    'full',
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL,
    false,
    false,
    '11111111-1111-4111-8111-111111111111'
  ),
  (
    102,
    '90D',
    'beta',
    'futures',
    'trader-2',
    2,
    -1,
    false,
    80.000,
    80.0000,
    76.5000,
    '{"consistency":null,"sharpe":0.5800,"drawdown":0.640,"pnl":0.7200,"roi":0.8100}',
    31.5000,
    125000.00,
    68.00,
    14.00,
    1200,
    33,
    410,
    'Alpha',
    '/avatars/a.png',
    '2026-07-28 02:34:56.123456-10',
    75.00,
    68.00,
    NULL,
    'full',
    'swing',
    18.00,
    0.9100,
    1.8000,
    2.1000,
    1.2500,
    NULL,
    'human',
    false,
    false,
    '11111111-1111-4111-8111-111111111111'
  );
SQL

IDENTITIES='[{"source":"beta","source_trader_id":"trader-2"},{"source":"alpha","source_trader_id":"trader-1"}]'
EVIDENCE="$(psql_cmd -At -c "
  SELECT pg_catalog.concat_ws(
    '|',
    evidence->>'contract',
    evidence->>'season_id',
    evidence->>'score_cohort_id',
    evidence->>'row_count',
    evidence->>'source_count',
    evidence->>'first_source',
    evidence->>'first_source_trader_id',
    evidence->>'last_source',
    evidence->>'last_source_trader_id',
    evidence->>'batch_sha256',
    evidence->>'canonical_octet_length'
  )
  FROM (
    SELECT arena.build_leaderboard_rank_batch_evidence_v1(
      '90D',
      '11111111-1111-4111-8111-111111111111',
      '$IDENTITIES'::jsonb
    ) AS evidence
  ) AS built;
")"
EXPECTED_EVIDENCE='leaderboard-rank-persisted-batch-evidence@1|90D|11111111-1111-4111-8111-111111111111|2|2|alpha|trader-1|beta|trader-2|6e36eea539e6854152727597f8791aa80692d90b1d084445b9d4757a38dfd8c6|873'
if [[ "$EVIDENCE" != "$EXPECTED_EVIDENCE" ]]; then
  echo "persisted batch golden evidence changed" >&2
  printf 'actual: %s\n' "$EVIDENCE" >&2
  exit 1
fi

SOURCE_PROOFS="$(psql_cmd -At -c "
  SELECT pg_catalog.string_agg(
    (proof.value->>'source') || '|' ||
    (proof.value->>'source_row_count') || '|' ||
    (proof.value->>'source_identity_sha256'),
    E'\\n' ORDER BY proof.ordinality
  )
  FROM pg_catalog.jsonb_array_elements(
    arena.build_leaderboard_rank_batch_evidence_v1(
      '90D',
      '11111111-1111-4111-8111-111111111111',
      '$IDENTITIES'::jsonb
    )->'source_proofs'
  ) WITH ORDINALITY AS proof(value, ordinality);
")"
EXPECTED_SOURCE_PROOFS="$(printf '%s\n%s' \
  'alpha|1|b38d474a933383e005f93bd93f335826f945b8e2d969a4ab4e5c327ce2d10dbc' \
  'beta|1|003eeeaff31676c753b42d75b50ff3f7de16af9c1c9aa02f18d0b20cc3874974')"
if [[ "$SOURCE_PROOFS" != "$EXPECTED_SOURCE_PROOFS" ]]; then
  echo "persisted batch source proofs changed or lost C order" >&2
  printf 'actual: %s\n' "$SOURCE_PROOFS" >&2
  exit 1
fi

# Caller order, numeric scale, JSON key order, surrogate id, and session display
# settings cannot affect canonical persisted evidence.
BASE_DIGEST="$(psql_cmd -At -c "
  SELECT arena.build_leaderboard_rank_batch_evidence_v1(
    '90D','11111111-1111-4111-8111-111111111111','$IDENTITIES'::jsonb
  )->>'batch_sha256';
")"
ORDERED_DIGEST="$(psql_cmd -At -c "
  SELECT arena.build_leaderboard_rank_batch_evidence_v1(
    '90D','11111111-1111-4111-8111-111111111111',
    '[{\"source\":\"alpha\",\"source_trader_id\":\"trader-1\"},{\"source\":\"beta\",\"source_trader_id\":\"trader-2\"}]'::jsonb
  )->>'batch_sha256';
")"
if [[ "$ORDERED_DIGEST" != "$BASE_DIGEST" ]]; then
  echo "caller identity order changed persisted batch digest" >&2
  exit 1
fi

psql_cmd -q -c \
  "UPDATE public.leaderboard_ranks SET id = id + 10000 WHERE source = 'alpha'"
if [[ "$(psql_cmd -At -c "SELECT arena.build_leaderboard_rank_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','$IDENTITIES'::jsonb)->>'batch_sha256'")" != "$BASE_DIGEST" ]]; then
  echo "surrogate id changed persisted batch digest" >&2
  exit 1
fi

psql_cmd -q -c \
  "UPDATE public.leaderboard_ranks SET score_factors = '{\"pnl\":1e0,\"roi\":1.0000,\"consistency\":0.000,\"sharpe\":null,\"drawdown\":0.0}'::jsonb WHERE source = 'alpha'"
if [[ "$(psql_cmd -At -c "SELECT arena.build_leaderboard_rank_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','$IDENTITIES'::jsonb)->>'batch_sha256'")" != "$BASE_DIGEST" ]]; then
  echo "equivalent score factor scale or key order changed digest" >&2
  exit 1
fi

UTC_ROW="$(psql_cmd -At -c "SET TIME ZONE 'UTC'; SET DateStyle = 'ISO, MDY'; SELECT arena.encode_leaderboard_rank_row_v1(rank_row)::text FROM public.leaderboard_ranks rank_row WHERE source='beta'")"
SHANGHAI_ROW="$(psql_cmd -At -c "SET TIME ZONE 'Asia/Shanghai'; SET DateStyle = 'German, DMY'; SELECT arena.encode_leaderboard_rank_row_v1(rank_row)::text FROM public.leaderboard_ranks rank_row WHERE source='beta'")"
LA_ROW="$(psql_cmd -At -c "SET TIME ZONE 'America/Los_Angeles'; SET DateStyle = 'SQL, DMY'; SELECT arena.encode_leaderboard_rank_row_v1(rank_row)::text FROM public.leaderboard_ranks rank_row WHERE source='beta'")"
if [[ "$UTC_ROW" != "$SHANGHAI_ROW" || "$UTC_ROW" != "$LA_ROW" \
   || "$UTC_ROW" != *'2026-07-28T12:34:56.123456Z'* ]]; then
  echo "session timezone or DateStyle changed persisted row encoding" >&2
  exit 1
fi

psql_cmd -q -c \
  "UPDATE public.leaderboard_ranks SET roi = 0.0001 WHERE source = 'alpha'"
CHANGED_DIGEST="$(psql_cmd -At -c "
  SELECT arena.build_leaderboard_rank_batch_evidence_v1(
    '90D','11111111-1111-4111-8111-111111111111','$IDENTITIES'::jsonb
  )->>'batch_sha256';
")"
if [[ "$CHANGED_DIGEST" == "$BASE_DIGEST" ]]; then
  echo "persisted metric mutation did not change batch digest" >&2
  exit 1
fi
psql_cmd -q -c \
  "UPDATE public.leaderboard_ranks SET roi = 0.0000 WHERE source = 'alpha'"

psql_cmd -q -c \
  "UPDATE public.leaderboard_ranks SET computed_at = computed_at + interval '1 microsecond' WHERE source = 'alpha'"
MICROSECOND_DIGEST="$(psql_cmd -At -c "
  SELECT arena.build_leaderboard_rank_batch_evidence_v1(
    '90D','11111111-1111-4111-8111-111111111111','$IDENTITIES'::jsonb
  )->>'batch_sha256';
")"
if [[ "$MICROSECOND_DIGEST" == "$BASE_DIGEST" ]]; then
  echo "one persisted timestamp microsecond did not change batch digest" >&2
  exit 1
fi
psql_cmd -q -c \
  "UPDATE public.leaderboard_ranks SET computed_at = '2026-07-28 12:34:56.123456+00' WHERE source = 'alpha'"

# Rank trust, numeric specials, time specials, and exact factor structure all
# fail closed even though PostgreSQL numeric/jsonb can physically retain them.
expect_failure \
  'codec accepted partial rank metrics' \
  'core metric or score is invalid' \
  "BEGIN; UPDATE public.leaderboard_ranks SET win_rate=NULL WHERE source='alpha'; SELECT arena.encode_leaderboard_rank_row_v1(rank_row) FROM public.leaderboard_ranks rank_row WHERE source='alpha';"
expect_failure \
  'codec accepted numeric NaN' \
  'core metric or score is invalid' \
  "BEGIN; UPDATE public.leaderboard_ranks SET arena_score='NaN'::numeric WHERE source='alpha'; SELECT arena.encode_leaderboard_rank_row_v1(rank_row) FROM public.leaderboard_ranks rank_row WHERE source='alpha';"
expect_failure \
  'codec accepted numeric infinity' \
  'core metric or score is invalid' \
  "BEGIN; UPDATE public.leaderboard_ranks SET arena_score_v4='Infinity'::numeric WHERE source='alpha'; SELECT arena.encode_leaderboard_rank_row_v1(rank_row) FROM public.leaderboard_ranks rank_row WHERE source='alpha';"
expect_failure \
  'codec accepted infinite computed_at' \
  'computed_at must be finite' \
  "BEGIN; UPDATE public.leaderboard_ranks SET computed_at='infinity'::timestamptz WHERE source='alpha'; SELECT arena.encode_leaderboard_rank_row_v1(rank_row) FROM public.leaderboard_ranks rank_row WHERE source='alpha';"
expect_failure \
  'codec accepted a pre-contract computed_at era' \
  'computed_at must be finite and within 2020-2100' \
  "BEGIN; UPDATE public.leaderboard_ranks SET computed_at='1900-01-01'::timestamptz WHERE source='alpha'; SELECT arena.encode_leaderboard_rank_row_v1(rank_row) FROM public.leaderboard_ranks rank_row WHERE source='alpha';"
expect_failure \
  'codec accepted missing score factor key' \
  'score_factors shape is invalid' \
  "BEGIN; UPDATE public.leaderboard_ranks SET score_factors=score_factors-'sharpe' WHERE source='alpha'; SELECT arena.encode_leaderboard_rank_row_v1(rank_row) FROM public.leaderboard_ranks rank_row WHERE source='alpha';"
expect_failure \
  'codec accepted extra score factor key' \
  'score_factors shape is invalid' \
  "BEGIN; UPDATE public.leaderboard_ranks SET score_factors=score_factors||'{\"extra\":1}'::jsonb WHERE source='alpha'; SELECT arena.encode_leaderboard_rank_row_v1(rank_row) FROM public.leaderboard_ranks rank_row WHERE source='alpha';"
expect_failure \
  'codec accepted string score factor' \
  'score_factors shape is invalid' \
  "BEGIN; UPDATE public.leaderboard_ranks SET score_factors=jsonb_set(score_factors,'{roi}','\"1\"'::jsonb) WHERE source='alpha'; SELECT arena.encode_leaderboard_rank_row_v1(rank_row) FROM public.leaderboard_ranks rank_row WHERE source='alpha';"
expect_failure \
  'codec accepted out-of-range score factor' \
  'score_factors value is invalid' \
  "BEGIN; UPDATE public.leaderboard_ranks SET score_factors=jsonb_set(score_factors,'{roi}','1.01'::jsonb) WHERE source='alpha'; SELECT arena.encode_leaderboard_rank_row_v1(rank_row) FROM public.leaderboard_ranks rank_row WHERE source='alpha';"

expect_failure \
  'batch accepted null identities' \
  'persisted rank batch header is invalid' \
  "SELECT arena.build_leaderboard_rank_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111',NULL)"
expect_failure \
  'batch accepted a scalar identity set' \
  'persisted rank batch header is invalid' \
  "SELECT arena.build_leaderboard_rank_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','{}'::jsonb)"
expect_failure \
  'batch accepted an empty identity set' \
  'outside bounds' \
  "SELECT arena.build_leaderboard_rank_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','[]'::jsonb)"
expect_failure \
  'batch accepted an extra identity key' \
  'identity shape is invalid' \
  "SELECT arena.build_leaderboard_rank_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','[{\"source\":\"alpha\",\"source_trader_id\":\"trader-1\",\"extra\":true}]'::jsonb)"
expect_failure \
  'batch accepted duplicate composite identities' \
  'duplicate identity' \
  "SELECT arena.build_leaderboard_rank_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','[{\"source\":\"alpha\",\"source_trader_id\":\"trader-1\"},{\"source\":\"alpha\",\"source_trader_id\":\"trader-1\"}]'::jsonb)"
expect_failure \
  'batch accepted an unknown persisted identity' \
  'missing from the exact cohort' \
  "SELECT arena.build_leaderboard_rank_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','[{\"source\":\"alpha\",\"source_trader_id\":\"missing\"}]'::jsonb)"

# The same trader id under another source remains a distinct composite identity.
psql_cmd -q <<'SQL'
INSERT INTO public.leaderboard_ranks (
  season_id, source, source_type, source_trader_id, rank,
  arena_score, arena_score_v4, arena_score_v3, score_factors,
  roi, pnl, win_rate, max_drawdown, followers, trades_count,
  computed_at, profitability_score, risk_control_score,
  score_completeness, is_outlier, metrics_estimated, rank_publication_id
)
SELECT
  season_id, 'gamma', source_type, source_trader_id, 3,
  arena_score, arena_score_v4, arena_score_v3, score_factors,
  roi, pnl, win_rate, max_drawdown, followers, trades_count,
  computed_at, profitability_score, risk_control_score,
  score_completeness, is_outlier, metrics_estimated, rank_publication_id
FROM public.leaderboard_ranks
WHERE source = 'alpha';
SQL
if [[ "$(psql_cmd -At -c "
  SELECT arena.build_leaderboard_rank_batch_evidence_v1(
    '90D','11111111-1111-4111-8111-111111111111',
    '[{\"source\":\"gamma\",\"source_trader_id\":\"trader-1\"},{\"source\":\"alpha\",\"source_trader_id\":\"trader-1\"}]'::jsonb
  )->>'row_count';
")" != '2' ]]; then
  echo "batch collapsed same trader id across distinct sources" >&2
  exit 1
fi

# Prove the inclusive 1000-row capacity and exclusive 1001-row bound.
psql_cmd -q <<'SQL'
INSERT INTO public.leaderboard_ranks (
  season_id, source, source_type, source_trader_id,
  arena_score, arena_score_v4, arena_score_v3, score_factors, avatar_url,
  roi, pnl, win_rate, max_drawdown, followers, trades_count,
  computed_at, profitability_score, risk_control_score,
  score_completeness, is_outlier, metrics_estimated, rank_publication_id
)
SELECT
  '30D',
  'bulk',
  'futures',
  'trader-' || pg_catalog.lpad(generated.n::text, 4, '0'),
  50.00,
  50.00,
  49.00,
  '{"roi":0.5,"pnl":0.5,"drawdown":0.5,"sharpe":null,"consistency":null}',
  pg_catalog.repeat(pg_catalog.chr(30028), 8192),
  10.0000,
  1000.00,
  50.00,
  10.00,
  0,
  1,
  '2026-07-28 12:34:56+00',
  50.00,
  50.00,
  'full',
  false,
  false,
  '22222222-2222-4222-8222-222222222222'
FROM pg_catalog.generate_series(1, 1000) AS generated(n);
SQL
if [[ "$(psql_cmd -qAt -c "
  SET statement_timeout = '20s';
  WITH identities AS (
    SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'source','bulk','source_trader_id',source_trader_id
      ) ORDER BY source_trader_id COLLATE pg_catalog.\"C\"
    ) AS value
    FROM public.leaderboard_ranks
    WHERE season_id='30D' AND source='bulk'
  ), evidence AS (
    SELECT arena.build_leaderboard_rank_batch_evidence_v1(
      '30D','22222222-2222-4222-8222-222222222222',identities.value
    ) AS value
    FROM identities
  )
  SELECT
    (value->>'row_count') || '|' ||
    ((value->>'canonical_octet_length')::integer BETWEEN
      24000000 AND 67108864)::text
  FROM evidence;
")" != '1000|true' ]]; then
  echo "batch rejected or timed out on the 1000-row 24 MiB boundary" >&2
  exit 1
fi
psql_cmd -q -c \
  "UPDATE public.leaderboard_ranks SET avatar_url=NULL WHERE season_id='30D' AND source='bulk'"
if [[ "$(psql_cmd -At -c "
  WITH identities AS (
    SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'source','bulk','source_trader_id',source_trader_id
      ) ORDER BY source_trader_id COLLATE pg_catalog.\"C\"
    ) AS value
    FROM public.leaderboard_ranks
    WHERE season_id='30D' AND source='bulk'
  ), evidence AS (
    SELECT arena.build_leaderboard_rank_batch_evidence_v1(
      '30D','22222222-2222-4222-8222-222222222222',identities.value
    ) AS value
    FROM identities
  )
  SELECT
    pg_catalog.jsonb_array_length(value->'source_proofs')::text || '|' ||
    (value#>>'{source_proofs,0,source}') || '|' ||
    (value#>>'{source_proofs,0,source_row_count}') || '|' ||
    ((value#>>'{source_proofs,0,source_identity_sha256}') ~
      '^[0-9a-f]{64}$')::text
  FROM evidence;
")" != '1|bulk|1000|true' ]]; then
  echo "single-source 1000-row proof is malformed" >&2
  exit 1
fi
expect_failure \
  'batch accepted 1001 identities' \
  'outside bounds' \
  "WITH identities AS (SELECT jsonb_agg(jsonb_build_object('source','bulk','source_trader_id','x-'||n)) value FROM generate_series(1,1001) n) SELECT arena.build_leaderboard_rank_batch_evidence_v1('30D','22222222-2222-4222-8222-222222222222',value) FROM identities"

# Block the canonical final row while the builder acquires the first row. This
# proves the evidence is built only after the whole lock set reaches one
# linearization point, including a concurrently committed final-row version.
psql_cmd -q -c \
  'CREATE TABLE arena.codec_concurrency_result (batch_sha256 text NOT NULL)'
PRE_CONCURRENCY_DIGEST="$(psql_cmd -At -c "
  SELECT arena.build_leaderboard_rank_batch_evidence_v1(
    '90D','11111111-1111-4111-8111-111111111111','$IDENTITIES'::jsonb
  )->>'batch_sha256';
")"
BLOCKER_FIFO="$TMP_ROOT/codec-beta-blocker.fifo"
BUILDER_FIFO="$TMP_ROOT/codec-mid-builder.fifo"
mkfifo "$BLOCKER_FIFO" "$BUILDER_FIFO"
exec 8<>"$BLOCKER_FIFO"
exec 9<>"$BUILDER_FIFO"
psql_cmd -q <"$BLOCKER_FIFO" >"$TMP_ROOT/codec-beta-blocker.log" 2>&1 &
BLOCKER_PID=$!
printf '%s\n' \
  "SET application_name='codec_beta_blocker';" \
  'BEGIN;' \
  "UPDATE public.leaderboard_ranks SET pnl=pnl+1 WHERE season_id='90D' AND source='beta';" \
  'SELECT pg_catalog.pg_advisory_lock(4242, 166);' >&8

BLOCKER_READY=false
for _ in $(seq 1 100); do
  if [[ "$(psql_cmd -At -c "
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_locks
    WHERE locktype='advisory' AND classid=4242 AND objid=166 AND granted;
  ")" == '1' ]]; then
    BLOCKER_READY=true
    break
  fi
  if ! kill -0 "$BLOCKER_PID" 2>/dev/null; then
    wait "$BLOCKER_PID" || true
    echo "concurrency blocker exited before readiness" >&2
    sed -n '1,160p' "$TMP_ROOT/codec-beta-blocker.log" >&2 || true
    exit 1
  fi
  sleep 0.05
done
if [[ "$BLOCKER_READY" != true ]]; then
  echo "concurrency blocker never reached readiness" >&2
  exit 1
fi

psql_cmd -q <"$BUILDER_FIFO" >"$TMP_ROOT/codec-mid-builder.log" 2>&1 &
BUILDER_PID=$!
printf '%s\n' \
  "SET application_name='codec_mid_builder';" \
  'BEGIN;' \
  "INSERT INTO arena.codec_concurrency_result SELECT arena.build_leaderboard_rank_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','$IDENTITIES'::jsonb)->>'batch_sha256';" \
  'SELECT pg_catalog.pg_advisory_lock(4242, 167);' >&9

BUILDER_WAITING=false
for _ in $(seq 1 100); do
  if [[ "$(psql_cmd -At -c "
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_stat_activity
    WHERE application_name='codec_mid_builder'
      AND state='active'
      AND wait_event_type='Lock';
  ")" == '1' ]]; then
    BUILDER_WAITING=true
    break
  fi
  if ! kill -0 "$BUILDER_PID" 2>/dev/null; then
    wait "$BUILDER_PID" || true
    echo "concurrency builder exited before blocking on its final row" >&2
    sed -n '1,160p' "$TMP_ROOT/codec-mid-builder.log" >&2 || true
    exit 1
  fi
  sleep 0.05
done
if [[ "$BUILDER_WAITING" != true ]]; then
  echo "concurrency builder never blocked before its final row lock" >&2
  exit 1
fi
expect_failure \
  'builder did not lock its canonical first row before waiting on the final row' \
  'lock timeout|canceling statement due to lock timeout' \
  "SET lock_timeout='200ms'; UPDATE public.leaderboard_ranks SET pnl=pnl+1 WHERE season_id='90D' AND source='alpha'"

printf '%s\n' 'COMMIT;' >&8
BUILDER_READY=false
for _ in $(seq 1 200); do
  if [[ "$(psql_cmd -At -c "
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_locks
    WHERE locktype='advisory' AND classid=4242 AND objid=167 AND granted;
  ")" == '1' ]]; then
    BUILDER_READY=true
    break
  fi
  if ! kill -0 "$BUILDER_PID" 2>/dev/null; then
    wait "$BUILDER_PID" || true
    echo "concurrency builder exited before completing evidence" >&2
    sed -n '1,160p' "$TMP_ROOT/codec-mid-builder.log" >&2 || true
    exit 1
  fi
  sleep 0.05
done
if [[ "$BUILDER_READY" != true ]]; then
  echo "concurrency builder never completed its lock-set evidence" >&2
  exit 1
fi
expect_failure \
  'completed evidence released its first row lock before transaction end' \
  'lock timeout|canceling statement due to lock timeout' \
  "SET lock_timeout='200ms'; UPDATE public.leaderboard_ranks SET pnl=pnl+1 WHERE season_id='90D' AND source='alpha'"
expect_failure \
  'completed evidence released its final row lock before transaction end' \
  'lock timeout|canceling statement due to lock timeout' \
  "SET lock_timeout='200ms'; UPDATE public.leaderboard_ranks SET pnl=pnl+1 WHERE season_id='90D' AND source='beta'"

printf '%s\n' 'COMMIT;' '\q' >&9
printf '%s\n' '\q' >&8
exec 9>&-
exec 8>&-
wait "$BUILDER_PID"
wait "$BLOCKER_PID"
CONCURRENT_DIGEST="$(psql_cmd -At -c \
  'SELECT batch_sha256 FROM arena.codec_concurrency_result')"
FRESH_CONCURRENT_DIGEST="$(psql_cmd -At -c "
  SELECT arena.build_leaderboard_rank_batch_evidence_v1(
    '90D','11111111-1111-4111-8111-111111111111','$IDENTITIES'::jsonb
  )->>'batch_sha256';
")"
if [[ -z "$CONCURRENT_DIGEST" \
   || "$CONCURRENT_DIGEST" == "$PRE_CONCURRENCY_DIGEST" \
   || "$CONCURRENT_DIGEST" != "$FRESH_CONCURRENT_DIGEST" ]]; then
  echo "concurrent final-row commit was not represented by one locked evidence snapshot" >&2
  exit 1
fi
psql_cmd -q -c \
  "UPDATE public.leaderboard_ranks SET pnl=pnl-1 WHERE season_id='90D' AND source='beta'"
psql_cmd -q -c 'DROP TABLE arena.codec_concurrency_result'

# FOR SHARE must retain row stability until the evidence transaction ends.
psql_cmd -q <<SQL >"$TMP_ROOT/lock-holder.log" 2>&1 &
BEGIN;
SELECT arena.build_leaderboard_rank_batch_evidence_v1(
  '90D',
  '11111111-1111-4111-8111-111111111111',
  '$IDENTITIES'::jsonb
);
SELECT pg_catalog.pg_advisory_lock(4242, 165);
SELECT pg_catalog.pg_sleep(3);
COMMIT;
SQL
LOCK_HOLDER_PID=$!
LOCK_READY=false
for _ in $(seq 1 100); do
  if [[ "$(psql_cmd -At -c "
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_locks
    WHERE locktype = 'advisory'
      AND classid = 4242
      AND objid = 165
      AND granted;
  ")" == '1' ]]; then
    LOCK_READY=true
    break
  fi
  if ! kill -0 "$LOCK_HOLDER_PID" 2>/dev/null; then
    wait "$LOCK_HOLDER_PID"
    echo "persisted batch lock holder exited before readiness" >&2
    exit 1
  fi
  sleep 0.05
done
if [[ "$LOCK_READY" != true ]]; then
  kill "$LOCK_HOLDER_PID" 2>/dev/null || true
  wait "$LOCK_HOLDER_PID" 2>/dev/null || true
  echo "persisted batch lock holder never reached readiness" >&2
  exit 1
fi
expect_failure \
  'persisted batch evidence did not retain row locks' \
  'lock timeout|canceling statement due to lock timeout' \
  "SET lock_timeout='200ms'; UPDATE public.leaderboard_ranks SET pnl=pnl+1 WHERE season_id='90D' AND source='alpha'"
wait "$LOCK_HOLDER_PID"

# Private functions remain unavailable to every API/rogue role even when the
# fixture grants schema USAGE so EXECUTE is the decisive boundary.
psql_cmd -q -c \
  'GRANT USAGE ON SCHEMA arena TO anon, authenticated, service_role, fixture_rogue'
if [[ "$(psql_cmd -At -c "
  SELECT pg_catalog.bool_or(
    pg_catalog.has_function_privilege(role_name, function_oid, 'EXECUTE')
  )
  FROM (VALUES
    ('anon'),('authenticated'),('service_role'),('fixture_rogue')
  ) AS roles(role_name)
  CROSS JOIN (VALUES
    ('arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks)'::regprocedure),
    ('arena.build_leaderboard_rank_batch_evidence_v1(text,uuid,jsonb)'::regprocedure)
  ) AS functions(function_oid);
")" != 'f' ]]; then
  echo "persisted rank codec leaked EXECUTE" >&2
  exit 1
fi
expect_failure \
  'service role executed the private persisted codec' \
  'permission denied for function' \
  "SET ROLE service_role; SELECT arena.build_leaderboard_rank_batch_evidence_v1('90D','11111111-1111-4111-8111-111111111111','[]'::jsonb)"

# Exact replay preserves functions, physical rows, and the surrogate sequence.
FUNCTION_STATE_BEFORE="$(psql_cmd -At -c "
  SELECT pg_catalog.string_agg(
    function_row.oid::text || '|' || function_row.xmin::text || '|' ||
    function_row.ctid::text || '|' ||
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc,'UTF8')),
      'hex'
    ),
    E'\\n' ORDER BY function_row.proname COLLATE pg_catalog.\"C\"
  )
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid IN (
    'arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks)'::regprocedure,
    'arena.build_leaderboard_rank_batch_evidence_v1(text,uuid,jsonb)'::regprocedure
  );
")"
ROW_STATE_BEFORE="$(psql_cmd -At -c "
  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.string_agg(
          tableoid::text || '|' || xmin::text || '|' || ctid::text || '|' ||
          pg_catalog.to_jsonb(rank_row)::text,
          E'\\n' ORDER BY source COLLATE pg_catalog.\"C\",
                         source_trader_id COLLATE pg_catalog.\"C\"
        ),
        'UTF8'
      )
    ),
    'hex'
  )
  FROM public.leaderboard_ranks AS rank_row;
")"
SEQUENCE_STATE_BEFORE="$(psql_cmd -At -c \
  'SELECT last_value::text || '\''|'\'' || is_called::text FROM public.leaderboard_ranks_id_seq')"
psql_cmd -q -f "$MIGRATION"
FUNCTION_STATE_AFTER="$(psql_cmd -At -c "
  SELECT pg_catalog.string_agg(
    function_row.oid::text || '|' || function_row.xmin::text || '|' ||
    function_row.ctid::text || '|' ||
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc,'UTF8')),
      'hex'
    ),
    E'\\n' ORDER BY function_row.proname COLLATE pg_catalog.\"C\"
  )
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid IN (
    'arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks)'::regprocedure,
    'arena.build_leaderboard_rank_batch_evidence_v1(text,uuid,jsonb)'::regprocedure
  );
")"
ROW_STATE_AFTER="$(psql_cmd -At -c "
  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.string_agg(
          tableoid::text || '|' || xmin::text || '|' || ctid::text || '|' ||
          pg_catalog.to_jsonb(rank_row)::text,
          E'\\n' ORDER BY source COLLATE pg_catalog.\"C\",
                         source_trader_id COLLATE pg_catalog.\"C\"
        ),
        'UTF8'
      )
    ),
    'hex'
  )
  FROM public.leaderboard_ranks AS rank_row;
")"
SEQUENCE_STATE_AFTER="$(psql_cmd -At -c \
  'SELECT last_value::text || '\''|'\'' || is_called::text FROM public.leaderboard_ranks_id_seq')"
if [[ "$FUNCTION_STATE_BEFORE" != "$FUNCTION_STATE_AFTER" \
   || "$ROW_STATE_BEFORE" != "$ROW_STATE_AFTER" \
   || "$SEQUENCE_STATE_BEFORE" != "$SEQUENCE_STATE_AFTER" ]]; then
  echo "codec replay changed function identity, physical rows, or sequence state" >&2
  exit 1
fi

# The typed-batch proof reuses this exact persisted-row fixture and clean
# replay point. It is opt-in so the persisted codec proof also remains an
# independently runnable test with no downstream migration dependency.
if [[ "${LEADERBOARD_TYPED_BATCH_PG17_EXTENSION:-}" == '1' ]]; then
  # shellcheck source=/dev/null
  (
    source \
      "$ROOT_DIR/supabase/migrations/__tests__/leaderboard-rank-typed-batch-contract.pg17.sh"
  )
fi

# Replay detects hostile catalog mutations and never silently repairs them.
psql_cmd -q -c \
  'GRANT EXECUTE ON FUNCTION arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks) TO service_role'
expect_migration_failure \
  'codec replay silently repaired a rogue grant' \
  'EXECUTE ACL drifted'
psql_cmd -q -c \
  'REVOKE EXECUTE ON FUNCTION arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks) FROM service_role'

psql_cmd -q <<'SQL'
CREATE FUNCTION arena.build_leaderboard_rank_batch_evidence_v1(p_value text)
RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
SQL
expect_migration_failure \
  'codec replay accepted a rogue overload' \
  'noncanonical overload'
psql_cmd -q -c \
  'DROP FUNCTION arena.build_leaderboard_rank_batch_evidence_v1(text)'

psql_cmd -q -c \
  'ALTER FUNCTION arena.build_leaderboard_rank_batch_evidence_v1(text,uuid,jsonb) STABLE'
expect_migration_failure \
  'codec replay accepted volatility drift' \
  'batch evidence builder catalog drifted'
psql_cmd -q -c \
  'ALTER FUNCTION arena.build_leaderboard_rank_batch_evidence_v1(text,uuid,jsonb) VOLATILE'

psql_cmd -q -c 'ALTER TABLE public.leaderboard_ranks ADD COLUMN hostile_replay text'
expect_migration_failure \
  'codec replay accepted parent schema drift' \
  '37-column persisted codec contract drifted'
psql_cmd -q -c 'ALTER TABLE public.leaderboard_ranks DROP COLUMN hostile_replay'

psql_cmd -q -c \
  'ALTER TABLE public.leaderboard_ranks DROP CONSTRAINT leaderboard_ranks_identity_key'
expect_migration_failure \
  'codec replay accepted a missing composite identity constraint' \
  'canonical composite identity is not uniquely constrained'
psql_cmd -q -c \
  'ALTER TABLE public.leaderboard_ranks ADD CONSTRAINT leaderboard_ranks_identity_key UNIQUE (season_id, source, source_trader_id)'

# Function body replacement is checked last because replay intentionally does
# not converge or recreate a drifted exact routine.
psql_cmd -q <<'SQL'
CREATE OR REPLACE FUNCTION arena.encode_leaderboard_rank_row_v1(
  p_rank public.leaderboard_ranks
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
STRICT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
AS $body$
BEGIN
  RETURN '{}'::jsonb;
END;
$body$;
SQL
expect_migration_failure \
  'codec replay accepted a replaced encoder body' \
  'persisted rank row encoder catalog drifted'

echo 'leaderboard persisted rank codec PG17 proof passed'
