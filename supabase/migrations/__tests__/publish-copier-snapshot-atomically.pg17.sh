#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the atomic copier snapshot writer. The
# disposable cluster never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SUBSTRATE="$ROOT_DIR/supabase/migrations/20260804053000_copier_snapshot_publication_substrate.sql"
WRITER="$ROOT_DIR/supabase/migrations/20260804054000_publish_copier_snapshot_atomically.sql"
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

TMP_ROOT="$(mktemp -d /tmp/copier-snapshot-writer-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((61000 + ($$ % 4000)))}"
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

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "$label changed: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

expect_failure_contains() {
  local label="$1"
  local needle="$2"
  local sql="$3"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"
  if psql_cmd -v VERBOSITY=verbose -c "$sql" >"$failure_log" 2>&1; then
    echo "$label succeeded unexpectedly" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,180p' "$failure_log" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --username=postgres \
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
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE outsider NOLOGIN NOBYPASSRLS;
CREATE SCHEMA arena AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, arena
  TO anon, authenticated, service_role, outsider;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  currency text NOT NULL,
  copier_table_depth text NOT NULL,
  fetch_region text NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL
);

CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE arena.raw_objects (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  job_type text NOT NULL,
  trader_id bigint,
  timeframe smallint,
  fetched_at timestamptz NOT NULL,
  storage_path text NOT NULL UNIQUE,
  bytes integer NOT NULL,
  content_hash text NOT NULL,
  quarantined boolean NOT NULL DEFAULT false,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_run_id text,
  trust_artifact_role text,
  CONSTRAINT raw_objects_metric_trust_binding CHECK (
    (source_run_id IS NULL AND trust_artifact_role IS NULL)
    OR (
      source_run_id ~ '^[0-9a-f]{64}$'
      AND trust_artifact_role IN (
        'source_payload',
        'population_manifest',
        'normalization_components',
        'event_history',
        'price_history',
        'opening_inventory'
      )
    )
  )
);

CREATE TABLE arena.copier_records (
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  ts timestamptz NOT NULL,
  copier_label text,
  copier_pnl numeric,
  copier_invested numeric,
  copy_duration_days integer,
  currency text NOT NULL,
  dedupe_hash text NOT NULL,
  raw jsonb
);

ALTER TABLE arena.sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.traders ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.raw_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.copier_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA arena
  FROM PUBLIC, anon, authenticated, service_role, outsider;

INSERT INTO arena.sources (
  id, slug, currency, copier_table_depth, fetch_region, status, serving_mode
) VALUES
  (1, 'gate_futures', 'USDT', 'top10', 'local', 'active', 'serving'),
  (2, 'shadow_source', 'USDC', 'full', 'vps_sg', 'active', 'shadow');
INSERT INTO arena.traders (id, source_id, exchange_trader_id, meta) VALUES
  (101, 1, 'trader-101', '{}'),
  (102, 1, 'trader-102', '{}'),
  (201, 2, 'trader-201', '{}');
SQL

psql_cmd -q -f "$SUBSTRATE"
psql_cmd -q -f "$WRITER"

psql_cmd -q <<'SQL'
CREATE FUNCTION public.test_copier_meta(
  p_source_run_id text,
  p_source_id integer,
  p_trader_id integer,
  p_lane text,
  p_page_count integer,
  p_observed_at timestamptz,
  p_caller_limited boolean
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'surface', 'copiers',
    'lane', p_lane,
    'page_count', p_page_count,
    'observed_at', p_observed_at,
    'caller_limited', p_caller_limited,
    'fetch_failed', false,
    'data_contract', 'arena.ingest.copier-snapshot-artifact@1',
    'source_run_id', p_source_run_id,
    'source_id', p_source_id,
    'trader_id', p_trader_id,
    'source_slug', CASE p_source_id WHEN 1 THEN 'gate_futures' ELSE 'shadow_source' END,
    'exchange_trader_id', 'trader-' || p_trader_id::text,
    'source_depth', CASE p_source_id WHEN 1 THEN 'top10' ELSE 'full' END,
    'currency', CASE p_source_id WHEN 1 THEN 'USDT' ELSE 'USDC' END,
    'fetch_region', CASE p_source_id WHEN 1 THEN 'local' ELSE 'vps_sg' END,
    'scan_terminal_state', CASE
      WHEN p_caller_limited THEN 'caller_limited'
      ELSE 'stream_exhausted_unverified'
    END,
    'source_reported_row_count', NULL,
    'raw_integrity', pg_catalog.jsonb_build_object(
      'content_type', 'application/json',
      'encoding', 'utf-8',
      'hash_algorithm', 'sha256',
      'hash_scope', 'json_utf8',
      'compression', 'gzip',
      'serialization_contract', 'arena.strict-canonical-json@1',
      'compressed_bytes', 100,
      'uncompressed_bytes', 200
    )
  )
$function$;

INSERT INTO arena.raw_objects (
  id, source_id, job_type, trader_id, timeframe, fetched_at,
  storage_path, bytes, content_hash, quarantined, meta,
  source_run_id, trust_artifact_role
) VALUES
  (
    1, 1, 'tier_c', 101, NULL, '2026-08-04 10:00:00+00',
    'gate/copier/a.json.gz', 100, repeat('a', 64), false,
    public.test_copier_meta(
      repeat('a', 64), 1, 101, 'tier_c', 1,
      '2026-08-04 10:00:00+00', false
    ),
    repeat('a', 64), 'copier_snapshot'
  ),
  (
    2, 1, 'history:copiers', 101, NULL, '2026-08-04 10:05:00+00',
    'gate/copier/b.json.gz', 100, repeat('b', 64), false,
    public.test_copier_meta(
      repeat('b', 64), 1, 101, 'tier_b', 1,
      '2026-08-04 10:05:00+00', false
    ),
    repeat('b', 64), 'copier_snapshot'
  ),
  (
    3, 1, 'tier_c', 101, NULL, '2026-08-04 10:04:00+00',
    'gate/copier/c.json.gz', 100, repeat('c', 64), false,
    public.test_copier_meta(
      repeat('c', 64), 1, 101, 'tier_c', 1,
      '2026-08-04 10:04:00+00', false
    ),
    repeat('c', 64), 'copier_snapshot'
  ),
  (
    4, 1, 'tier_c', 101, NULL, '2026-08-04 10:08:00+00',
    'gate/copier/d.json.gz', 100, repeat('d', 64), false,
    public.test_copier_meta(
      repeat('d', 64), 1, 101, 'tier_c', 1,
      '2026-08-04 10:08:00+00', false
    ),
    repeat('d', 64), 'copier_snapshot'
  ),
  (
    5, 1, 'tier_c', 102, NULL, '2026-08-04 10:09:00+00',
    'gate/copier/e.json.gz', 100, repeat('e', 64), false,
    public.test_copier_meta(
      repeat('e', 64), 1, 102, 'tier_c', 1,
      '2026-08-04 10:09:00+00', false
    ),
    repeat('e', 64), 'copier_snapshot'
  ),
  (
    6, 1, 'tier_c', 101, NULL, '2026-08-04 10:10:00+00',
    'gate/copier/a-later.json.gz', 100, repeat('a', 64), false,
    public.test_copier_meta(
      repeat('a', 64), 1, 101, 'tier_c', 1,
      '2026-08-04 10:10:00+00', false
    ),
    repeat('a', 64), 'copier_snapshot'
  ),
  (
    7, 1, 'history:copiers', 101, NULL, '2026-08-04 10:11:00+00',
    'gate/copier/f.json.gz', 100, repeat('f', 64), false,
    public.test_copier_meta(
      repeat('f', 64), 1, 101, 'tier_b', 1,
      '2026-08-04 10:11:00+00', true
    ),
    repeat('f', 64), 'copier_snapshot'
  );
SQL

ROWS='[{"row_ordinal":0,"source_event_at":null,"copier_label":"private-a","copier_pnl":10,"copier_invested":100,"copy_duration_days":3,"dedupe_hash":"a"},{"row_ordinal":1,"source_event_at":null,"copier_label":"private-b","copier_pnl":20,"copier_invested":200,"copy_duration_days":4,"dedupe_hash":"b"}]'
EMPTY_ROWS='[]'

FIRST_RESULT="$(
  psql_cmd -Atq -c "
      SET ROLE service_role;
      SELECT publication_id::text || '|' || parsed_row_count::text || '|' || replayed::text
        FROM arena.publish_copier_snapshot(
          1::smallint, 101::bigint, 'tier_c', 1::bigint,
          'gate/copier/a.json.gz', repeat('a', 64),
          '2026-08-04 10:00:00+00', false, 1, NULL, '$ROWS'::jsonb
        );
    "
)"
assert_equal 'service role copier publish' '1|2|false' "$FIRST_RESULT"

RETRY_RESULT="$(
  psql_cmd -Atq -c "
      SET ROLE service_role;
      SELECT publication_id::text || '|' || parsed_row_count::text || '|' || replayed::text
        FROM arena.publish_copier_snapshot(
          1::smallint, 101::bigint, 'tier_c', 1::bigint,
          'gate/copier/a.json.gz', repeat('a', 64),
          '2026-08-04 10:00:00+00', false, 1, NULL, '$ROWS'::jsonb
        );
    "
)"
assert_equal 'exact copier retry' '1|2|true' "$RETRY_RESULT"

EMPTY_RESULT="$(
  psql_cmd -Atq -c "
      SET ROLE service_role;
      SELECT publication_id::text || '|' || parsed_row_count::text || '|' || replayed::text
        FROM arena.publish_copier_snapshot(
          1::smallint, 101::bigint, 'tier_b', 2::bigint,
          'gate/copier/b.json.gz', repeat('b', 64),
          '2026-08-04 10:05:00+00', false, 1, NULL, '$EMPTY_ROWS'::jsonb
        );
    "
)"
assert_equal 'evidence-backed empty copier snapshot' '2|0|false' "$EMPTY_RESULT"

expect_failure_contains \
  'stale copier publication succeeded' \
  'stale copier snapshot publication rejected' \
  "SET ROLE service_role; SELECT * FROM arena.publish_copier_snapshot(1::smallint,101::bigint,'tier_c',3::bigint,'gate/copier/c.json.gz',repeat('c',64),'2026-08-04 10:04:00+00',false,1,NULL,'[]'::jsonb)"

BAD_ORDINALS='[{"row_ordinal":1,"source_event_at":null,"copier_label":null,"copier_pnl":null,"copier_invested":null,"copy_duration_days":null,"dedupe_hash":"only"}]'
expect_failure_contains \
  'malformed copier ordinals succeeded' \
  'copier snapshot row conservation or value contract failed' \
  "SET ROLE service_role; SELECT * FROM arena.publish_copier_snapshot(1::smallint,101::bigint,'tier_c',4::bigint,'gate/copier/d.json.gz',repeat('d',64),'2026-08-04 10:08:00+00',false,1,NULL,'$BAD_ORDINALS'::jsonb)"

expect_failure_contains \
  'wrong-subject copier RAW succeeded' \
  'copier snapshot RAW identity or capture metadata mismatch' \
  "SET ROLE service_role; SELECT * FROM arena.publish_copier_snapshot(1::smallint,101::bigint,'tier_c',5::bigint,'gate/copier/e.json.gz',repeat('e',64),'2026-08-04 10:09:00+00',false,1,NULL,'[]'::jsonb)"

psql_cmd -q -c "UPDATE arena.sources SET serving_mode = 'shadow' WHERE id = 1"
expect_failure_contains \
  'demoted source copier publish succeeded' \
  'copier snapshot source is not active serving or has no copier surface' \
  "SET ROLE service_role; SELECT * FROM arena.publish_copier_snapshot(1::smallint,101::bigint,'tier_c',4::bigint,'gate/copier/d.json.gz',repeat('d',64),'2026-08-04 10:08:00+00',false,1,NULL,'[]'::jsonb)"
psql_cmd -q -c "UPDATE arena.sources SET serving_mode = 'serving' WHERE id = 1"

psql_cmd -q -c "UPDATE arena.traders SET meta = '{\"claimed\":true}' WHERE id = 101"
expect_failure_contains \
  'claimed trader copier publish succeeded' \
  'copier snapshot trader is not an unclaimed source subject' \
  "SET ROLE service_role; SELECT * FROM arena.publish_copier_snapshot(1::smallint,101::bigint,'tier_c',4::bigint,'gate/copier/d.json.gz',repeat('d',64),'2026-08-04 10:08:00+00',false,1,NULL,'[]'::jsonb)"
psql_cmd -q -c "UPDATE arena.traders SET meta = '{}' WHERE id = 101"

expect_failure_contains \
  'caller-limited Tier-B copier publish succeeded' \
  'Tier-B copier publication cannot be caller-limited' \
  "SET ROLE service_role; SELECT * FROM arena.publish_copier_snapshot(1::smallint,101::bigint,'tier_b',7::bigint,'gate/copier/f.json.gz',repeat('f',64),'2026-08-04 10:11:00+00',true,1,NULL,'[]'::jsonb)"

SAME_CONTENT_RESULT="$(
  psql_cmd -Atq \
    -c "
      SET ROLE service_role;
      SELECT publication_id::text || '|' || parsed_row_count::text || '|' || replayed::text
        FROM arena.publish_copier_snapshot(
          1::smallint, 101::bigint, 'tier_c', 6::bigint,
          'gate/copier/a-later.json.gz', repeat('a', 64),
          '2026-08-04 10:10:00+00', false, 1, NULL, '[]'::jsonb
        );
    "
)"
assert_equal 'same-content later copier observation' '3|0|false' "$SAME_CONTENT_RESULT"

AUTHORITY_RESULT="$(
  psql_cmd -Atqc "
    SELECT
      pg_catalog.count(*)::text || '|' ||
      (SELECT pg_catalog.count(*) FROM arena.copier_snapshot_rows)::text || '|' ||
      pg_catalog.string_agg(
        publication_id::text || ':' ||
        COALESCE(previous_publication_id::text, 'NULL') || ':' ||
        parsed_row_count::text,
        ',' ORDER BY publication_id
      )
    FROM arena.copier_snapshot_publications;
  "
)"
assert_equal \
  'failed copier publications leaked rows' \
  '3|2|1:NULL:2,2:1:0,3:2:0' \
  "$AUTHORITY_RESULT"

HASH_RESULT="$(
  psql_cmd -Atqc "
    SELECT
      pg_catalog.bool_and(snapshot_row.source_event_at IS NULL)::text || '|' ||
      receipt.row_set_sha256 || '|' ||
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            pg_catalog.string_agg(
              snapshot_row.row_sha256,
              '' ORDER BY snapshot_row.row_ordinal
            ),
            'UTF8'
          )
        ),
        'hex'
      )
    FROM arena.copier_snapshot_publications AS receipt
    JOIN arena.copier_snapshot_rows AS snapshot_row
      ON snapshot_row.publication_id = receipt.publication_id
    WHERE receipt.publication_id = 1
    GROUP BY receipt.row_set_sha256;
  "
)"
IFS='|' read -r all_event_times_null receipt_hash recomputed_hash <<<"$HASH_RESULT"
assert_equal 'copier source-event provenance was fabricated' 'true' "$all_event_times_null"
assert_equal 'copier row-set hash is not reproducible' "$receipt_hash" "$recomputed_hash"

expect_failure_contains \
  'browser copier writer execution succeeded' \
  'permission denied for function publish_copier_snapshot' \
  "SET ROLE anon; SELECT * FROM arena.publish_copier_snapshot(1::smallint,101::bigint,'tier_c',1::bigint,'gate/copier/a.json.gz',repeat('a',64),'2026-08-04 10:00:00+00',false,1,NULL,'[]'::jsonb)"
expect_failure_contains \
  'service role read snapshot rows succeeded' \
  'permission denied for table copier_snapshot_rows' \
  "SET ROLE service_role; SELECT * FROM arena.copier_snapshot_rows"

echo 'atomic copier snapshot publisher PostgreSQL 17 proof passed'
