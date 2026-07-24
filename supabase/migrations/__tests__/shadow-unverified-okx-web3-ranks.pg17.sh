#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for the OKX Web3 public-rank quarantine.
# It owns an isolated cluster and never connects to application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260724010000_shadow_unverified_okx_web3_ranks.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi
if [[ ! -f "$MIGRATION" ]]; then
  echo "Required migration not found: $MIGRATION" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/okx-web3-rank-quarantine-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((55000 + ($$ % 2500)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -220 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_postgres() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

psql_db() {
  local database="$1"
  shift
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d "$database" "$@"
}

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "$label changed: $expected -> $actual" >&2
    exit 1
  fi
}

preservation_fingerprint() {
  local database="$1"
  psql_db "$database" -Atqc "
    SELECT pg_catalog.md5(
      (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id), '') FROM arena.leaderboard_snapshots AS row_value)
      || '|' ||
      (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id), '') FROM arena.leaderboard_entries AS row_value)
      || '|' ||
      (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id), '') FROM arena.traders AS row_value)
      || '|' ||
      (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id), '') FROM arena.trader_stats AS row_value)
      || '|' ||
      (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id), '') FROM arena.trader_series AS row_value)
      || '|' ||
      (SELECT COALESCE(pg_catalog.string_agg(pg_catalog.to_jsonb(row_value)::text, E'\\n' ORDER BY row_value.id), '') FROM arena.raw_captures AS row_value)
    );"
}

rank_fingerprint() {
  local database="$1"
  psql_db "$database" -Atqc "
    SELECT pg_catalog.md5(
      COALESCE(
        pg_catalog.string_agg(
          pg_catalog.to_jsonb(rank_row)::text,
          E'\\n' ORDER BY rank_row.season_id, rank_row.id
        ),
        ''
      )
    )
    FROM public.leaderboard_ranks AS rank_row;"
}

setup_case() {
  local database="$1"
  local rank_id_type="$2"
  local okx_7d_id="$3"
  local okx_30d_id="$4"
  local okx_90d_id="$5"
  local other_7d_id="$6"
  local other_30d_id="$7"
  local other_90d_id="$8"
  local okx_extra_id="$9"
  local other_extra_id="${10}"

  psql_db "$database" \
    -v rank_id_type="$rank_id_type" \
    -v okx_7d_id="$okx_7d_id" \
    -v okx_30d_id="$okx_30d_id" \
    -v okx_90d_id="$okx_90d_id" \
    -v other_7d_id="$other_7d_id" \
    -v other_30d_id="$other_30d_id" \
    -v other_90d_id="$other_90d_id" \
    -v okx_extra_id="$okx_extra_id" \
    -v other_extra_id="$other_extra_id" <<'SQL'
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA public, arena TO anon, authenticated, service_role;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  status text NOT NULL,
  serving_mode text NOT NULL,
  currency text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL,
  payload jsonb NOT NULL
);
CREATE TABLE arena.leaderboard_entries (
  id bigint PRIMARY KEY,
  snapshot_id bigint NOT NULL,
  payload jsonb NOT NULL
);
CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL,
  payload jsonb NOT NULL
);
CREATE TABLE arena.trader_stats (
  id bigint PRIMARY KEY,
  trader_id bigint NOT NULL,
  payload jsonb NOT NULL
);
CREATE TABLE arena.trader_series (
  id bigint PRIMARY KEY,
  trader_id bigint NOT NULL,
  payload jsonb NOT NULL
);
CREATE TABLE arena.raw_captures (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL,
  payload jsonb NOT NULL
);

CREATE TABLE public.leaderboard_ranks (
  id :rank_id_type NOT NULL,
  season_id text NOT NULL,
  source text NOT NULL,
  source_trader_id text NOT NULL,
  arena_score numeric,
  is_outlier boolean,
  rank integer,
  rank_change integer,
  computed_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (id, season_id),
  UNIQUE (season_id, source, source_trader_id)
) PARTITION BY LIST (season_id);

CREATE TABLE public.leaderboard_ranks_7d
  PARTITION OF public.leaderboard_ranks FOR VALUES IN ('7D');
CREATE TABLE public.leaderboard_ranks_30d
  PARTITION OF public.leaderboard_ranks FOR VALUES IN ('30D');
CREATE TABLE public.leaderboard_ranks_90d
  PARTITION OF public.leaderboard_ranks FOR VALUES IN ('90D');
CREATE TABLE public.leaderboard_ranks_default
  PARTITION OF public.leaderboard_ranks DEFAULT;

CREATE TABLE public.leaderboard_count_cache (
  season_id text NOT NULL,
  source text NOT NULL DEFAULT '_all',
  total_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (season_id, source)
);

CREATE FUNCTION public.refresh_leaderboard_count_cache()
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  LOCK TABLE public.leaderboard_count_cache IN SHARE ROW EXCLUSIVE MODE;
  DELETE FROM public.leaderboard_count_cache;

  INSERT INTO public.leaderboard_count_cache (
    season_id, source, total_count, updated_at
  )
  SELECT season_id, '_all', count(*), pg_catalog.now()
  FROM public.leaderboard_ranks
  WHERE arena_score > 10 AND is_outlier IS NOT TRUE
  GROUP BY season_id
  UNION ALL
  SELECT season_id, source, count(*), pg_catalog.now()
  FROM public.leaderboard_ranks
  WHERE arena_score > 10 AND is_outlier IS NOT TRUE
  GROUP BY season_id, source
  UNION ALL
  SELECT season_id, '_all_gt0', count(*), pg_catalog.now()
  FROM public.leaderboard_ranks
  WHERE arena_score > 0 AND is_outlier IS NOT TRUE
  GROUP BY season_id
  UNION ALL
  SELECT season_id, source || '_gt0', count(*), pg_catalog.now()
  FROM public.leaderboard_ranks
  WHERE arena_score > 0 AND is_outlier IS NOT TRUE
  GROUP BY season_id, source;
END
$function$;

INSERT INTO arena.sources (
  id, slug, status, serving_mode, currency, meta
) VALUES
  (30, 'okx_web3_solana', 'active', 'serving', 'USDC', '{"fixture":"preserve"}'),
  (31, 'hyperliquid', 'active', 'serving', 'USDT', '{}');

INSERT INTO arena.leaderboard_snapshots VALUES
  (1, 30, '{"board":"okx"}'),
  (2, 31, '{"board":"other"}');
INSERT INTO arena.leaderboard_entries VALUES
  (1, 1, '{"rank":1}'),
  (2, 2, '{"rank":1}');
INSERT INTO arena.traders VALUES
  (1, 30, '{"wallet":"okx-a"}'),
  (2, 31, '{"wallet":"other-a"}');
INSERT INTO arena.trader_stats VALUES
  (1, 1, '{"roi":12,"pnl":100}'),
  (2, 2, '{"roi":8,"pnl":80}');
INSERT INTO arena.trader_series VALUES
  (1, 1, '{"point":1}'),
  (2, 2, '{"point":1}');
INSERT INTO arena.raw_captures VALUES
  (1, 30, '{"raw":"okx-payload"}'),
  (2, 31, '{"raw":"other-payload"}');

CREATE VIEW arena.score_inputs AS
SELECT source.slug AS platform
FROM arena.sources AS source
JOIN arena.leaderboard_snapshots AS snapshot
  ON snapshot.source_id = source.id
WHERE source.status = 'active'
  AND source.serving_mode = 'serving';

INSERT INTO public.leaderboard_ranks (
  id, season_id, source, source_trader_id, arena_score, is_outlier, rank, rank_change
) VALUES
  (:'okx_7d_id':: :rank_id_type, '7D', 'okx_web3_solana', 'okx-7d', 50, false, 1, 2),
  (:'okx_30d_id':: :rank_id_type, '30D', 'okx_web3_solana', 'okx-30d', 20, false, 1, 3),
  (:'okx_90d_id':: :rank_id_type, '90D', 'okx_web3_solana', 'okx-90d', 5, false, 2, -1),
  (:'other_7d_id':: :rank_id_type, '7D', 'hyperliquid', 'other-7d', 30, false, 2, -2),
  (:'other_30d_id':: :rank_id_type, '30D', 'hyperliquid', 'other-30d', 9, false, 2, 4),
  (:'other_90d_id':: :rank_id_type, '90D', 'hyperliquid', 'other-90d', 15, false, 1, 1),
  (:'okx_extra_id':: :rank_id_type, '180D', 'okx_web3_solana', 'okx-180d', 80, false, 1, 8),
  (:'other_extra_id':: :rank_id_type, '180D', 'hyperliquid', 'other-180d', 70, false, 2, -8);

SELECT public.refresh_leaderboard_count_cache();
SQL
}

verify_success_case() {
  local database="$1"

  psql_db "$database" <<'SQL'
DO $proof$
DECLARE
  v_cache_mismatch boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM arena.sources
    WHERE slug = 'okx_web3_solana'
      AND status = 'active'
      AND serving_mode = 'shadow'
      AND meta->>'rank_visibility_contract' = 'okx-web3-ranking-quarantine@1'
      AND meta->'rank_visibility_blockers' ? 'pagination_snapshot_unavailable'
      AND meta->'rank_visibility_blockers' ? 'native_window_boundary_unverified'
      AND meta->'rank_visibility_blockers' ? 'ranking_method_currency_mismatch'
      AND meta->'rank_visibility_blockers' ? 'source_currency_label_mismatch'
  ) THEN
    RAISE EXCEPTION 'source did not retain active ingestion in shadow mode';
  END IF;

  IF EXISTS (
    SELECT 1 FROM arena.score_inputs WHERE platform = 'okx_web3_solana'
  ) THEN
    RAISE EXCEPTION 'shadow source remains in score inputs';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.leaderboard_ranks WHERE source = 'okx_web3_solana'
  ) THEN
    RAISE EXCEPTION 'OKX public ranks remain';
  END IF;

  IF EXISTS (
    WITH ordered AS (
      SELECT
        id,
        season_id,
        ROW_NUMBER() OVER (
          PARTITION BY season_id
          ORDER BY arena_score DESC NULLS LAST, id
        )::integer AS expected_rank
      FROM public.leaderboard_ranks
      WHERE season_id IN ('7D', '30D', '90D', '180D')
    )
    SELECT 1
    FROM public.leaderboard_ranks AS rank_row
    JOIN ordered
      ON ordered.id = rank_row.id
     AND ordered.season_id = rank_row.season_id
    WHERE rank_row.rank IS DISTINCT FROM ordered.expected_rank
  ) THEN
    RAISE EXCEPTION 'remaining public rank order is incorrect';
  END IF;

  IF (SELECT count(*) FROM arena.okx_web3_rank_quarantine_rows) <> 4 THEN
    RAISE EXCEPTION 'archive row count is not four';
  END IF;

  IF (SELECT count(*)
      FROM arena.okx_web3_rank_quarantine_rows AS archive
      CROSS JOIN LATERAL pg_catalog.jsonb_populate_record(
        NULL::public.leaderboard_ranks,
        archive.row_data
      ) AS restored
      WHERE restored.id::text = archive.live_rank_id
        AND restored.season_id = archive.season_id
        AND restored.source_trader_id = archive.source_trader_id) <> 4 THEN
    RAISE EXCEPTION 'full-row archive cannot reconstruct typed rank identities';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM arena.okx_web3_rank_quarantine_batches
    WHERE batch_id = '20260724_okx_web3_unverified_rank_quarantine'
      AND state = 'COMPLETE'
      AND archived_rank_count = 4
      AND source_row_before->>'serving_mode' = 'serving'
      AND source_row_before->>'currency' = 'USDC'
  ) THEN
    RAISE EXCEPTION 'batch ledger is incomplete';
  END IF;

  WITH expected(season_id, source, total_count) AS (
    VALUES
      ('7D', '_all', 1),
      ('7D', 'hyperliquid', 1),
      ('7D', '_all_gt0', 1),
      ('7D', 'hyperliquid_gt0', 1),
      ('30D', '_all_gt0', 1),
      ('30D', 'hyperliquid_gt0', 1),
      ('90D', '_all', 1),
      ('90D', 'hyperliquid', 1),
      ('90D', '_all_gt0', 1),
      ('90D', 'hyperliquid_gt0', 1),
      ('180D', '_all', 1),
      ('180D', 'hyperliquid', 1),
      ('180D', '_all_gt0', 1),
      ('180D', 'hyperliquid_gt0', 1)
  ), differences AS (
    (SELECT season_id, source, total_count FROM expected
     EXCEPT
     SELECT season_id, source, total_count FROM public.leaderboard_count_cache)
    UNION ALL
    (SELECT season_id, source, total_count FROM public.leaderboard_count_cache
     EXCEPT
     SELECT season_id, source, total_count FROM expected)
  )
  SELECT EXISTS (SELECT 1 FROM differences) INTO v_cache_mismatch;

  IF v_cache_mismatch THEN
    RAISE EXCEPTION 'count cache does not exactly match remaining ranks';
  END IF;

  IF (SELECT count(*)
      FROM pg_catalog.pg_constraint
      WHERE conname IN (
        'sources_block_unverified_okx_web3_solana_serving',
        'leaderboard_ranks_block_unverified_okx_web3_solana'
      )
        AND contype = 'c'
        AND convalidated) < 2 THEN
    RAISE EXCEPTION 'validated quarantine guards are missing';
  END IF;

  IF NOT (
    SELECT relrowsecurity
    FROM pg_catalog.pg_class
    WHERE oid = 'arena.okx_web3_rank_quarantine_rows'::pg_catalog.regclass
  ) OR pg_catalog.has_table_privilege(
    'anon', 'arena.okx_web3_rank_quarantine_rows', 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', 'arena.okx_web3_rank_quarantine_rows', 'SELECT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'arena.okx_web3_rank_quarantine_rows', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'archive privacy boundary is incorrect';
  END IF;
END
$proof$;
SQL
}

run_success_case() {
  local database="$1"
  local rank_id_type="$2"
  local guard_id="$3"
  local before_fingerprint
  local after_fingerprint
  local archive_fingerprint
  local replay_fingerprint

  before_fingerprint="$(preservation_fingerprint "$database")"
  psql_db "$database" -f "$MIGRATION" >/dev/null
  verify_success_case "$database"
  assert_equal \
    "$database first-run rank changes reset" \
    '0' \
    "$(psql_db "$database" -Atqc "SELECT count(*) FROM public.leaderboard_ranks WHERE rank_change IS NOT NULL")"
  after_fingerprint="$(preservation_fingerprint "$database")"
  assert_equal "$database preserved source evidence" "$before_fingerprint" "$after_fingerprint"

  archive_fingerprint="$(psql_db "$database" -Atqc "SELECT archived_rank_count::text || ':' || archived_rank_digest FROM arena.okx_web3_rank_quarantine_batches WHERE batch_id = '20260724_okx_web3_unverified_rank_quarantine'")"
  psql_db "$database" -c \
    "UPDATE public.leaderboard_ranks SET rank_change = 7 WHERE source = 'hyperliquid' AND season_id = '7D'" \
    >/dev/null
  psql_db "$database" -f "$MIGRATION" >/dev/null
  verify_success_case "$database"
  assert_equal \
    "$database replay preserves later organic rank changes" \
    '7' \
    "$(psql_db "$database" -Atqc "SELECT rank_change FROM public.leaderboard_ranks WHERE source = 'hyperliquid' AND season_id = '7D'")"
  replay_fingerprint="$(psql_db "$database" -Atqc "SELECT archived_rank_count::text || ':' || archived_rank_digest FROM arena.okx_web3_rank_quarantine_batches WHERE batch_id = '20260724_okx_web3_unverified_rank_quarantine'")"
  assert_equal "$database replay archive" "$archive_fingerprint" "$replay_fingerprint"

  if psql_db "$database" -c \
    "UPDATE arena.sources SET serving_mode = 'serving' WHERE slug = 'okx_web3_solana'" \
    >/dev/null 2>&1; then
    echo "$database source promotion guard accepted an unreviewed serving update" >&2
    exit 1
  fi

  psql_db "$database" -c \
    "CREATE TABLE public.leaderboard_ranks_1d PARTITION OF public.leaderboard_ranks FOR VALUES IN ('1D')" \
    >/dev/null
  if psql_db "$database" \
    -v rank_id_type="$rank_id_type" \
    -v guard_id="$guard_id" <<'SQL' >/dev/null 2>&1
INSERT INTO public.leaderboard_ranks (
  id, season_id, source, source_trader_id, arena_score, is_outlier
) VALUES (
  :'guard_id':: :rank_id_type,
  '1D',
  'okx_web3_solana',
  'stale-writer',
  99,
  false
);
SQL
  then
    echo "$database rank guard accepted a stale OKX writer" >&2
    exit 1
  fi

  assert_equal \
    "$database source remains shadow" \
    'shadow' \
    "$(psql_db "$database" -Atqc "SELECT serving_mode FROM arena.sources WHERE slug = 'okx_web3_solana'")"
  assert_equal \
    "$database public OKX rank count" \
    '0' \
    "$(psql_db "$database" -Atqc "SELECT count(*) FROM public.leaderboard_ranks WHERE source = 'okx_web3_solana'")"
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

psql_postgres <<'SQL'
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE DATABASE integer_case;
CREATE DATABASE uuid_case;
CREATE DATABASE rollback_case;
SQL

setup_case integer_case integer \
  101 102 103 201 202 203 104 204
setup_case uuid_case uuid \
  00000000-0000-0000-0000-000000000101 \
  00000000-0000-0000-0000-000000000102 \
  00000000-0000-0000-0000-000000000103 \
  00000000-0000-0000-0000-000000000201 \
  00000000-0000-0000-0000-000000000202 \
  00000000-0000-0000-0000-000000000203 \
  00000000-0000-0000-0000-000000000104 \
  00000000-0000-0000-0000-000000000204
setup_case rollback_case integer \
  301 302 303 401 402 403 304 404

run_success_case integer_case integer 999
run_success_case uuid_case uuid 00000000-0000-0000-0000-000000000999

# Force a failure after the migration has already reached its destructive
# phase. PostgreSQL must roll back archive DDL, source shadowing, rank deletion,
# cache changes, and guard creation as one transaction.
ROLLBACK_FINGERPRINT_BEFORE="$(preservation_fingerprint rollback_case)"
ROLLBACK_RANK_FINGERPRINT_BEFORE="$(rank_fingerprint rollback_case)"
psql_db rollback_case <<'SQL' >/dev/null
CREATE OR REPLACE FUNCTION public.refresh_leaderboard_count_cache()
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'fixture cache refresh failure';
END
$function$;
SQL

if psql_db rollback_case -f "$MIGRATION" >/dev/null 2>&1; then
  echo 'rollback fixture unexpectedly accepted a failed cache refresh' >&2
  exit 1
fi

assert_equal \
  'failed migration preserved source mode' \
  'serving' \
  "$(psql_db rollback_case -Atqc "SELECT serving_mode FROM arena.sources WHERE slug = 'okx_web3_solana'")"
assert_equal \
  'failed migration preserved OKX ranks' \
  '4' \
  "$(psql_db rollback_case -Atqc "SELECT count(*) FROM public.leaderboard_ranks WHERE source = 'okx_web3_solana'")"
assert_equal \
  'failed migration rolled back rank order and movement' \
  "$ROLLBACK_RANK_FINGERPRINT_BEFORE" \
  "$(rank_fingerprint rollback_case)"
assert_equal \
  'failed migration rolled back archive DDL' \
  '' \
  "$(psql_db rollback_case -Atqc "SELECT pg_catalog.to_regclass('arena.okx_web3_rank_quarantine_rows')")"
assert_equal \
  'failed migration rolled back guards' \
  '0' \
  "$(psql_db rollback_case -Atqc "SELECT count(*) FROM pg_catalog.pg_constraint WHERE conname IN ('sources_block_unverified_okx_web3_solana_serving','leaderboard_ranks_block_unverified_okx_web3_solana')")"
assert_equal \
  'failed migration preserved source evidence' \
  "$ROLLBACK_FINGERPRINT_BEFORE" \
  "$(preservation_fingerprint rollback_case)"

echo 'OKX Web3 rank quarantine PostgreSQL 17 proof passed'
