#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the private copier snapshot receipt/row
# substrate. This cluster never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260804053000_copier_snapshot_publication_substrate.sql"
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

TMP_ROOT="$(mktemp -d /tmp/copier-snapshot-substrate-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((60000 + ($$ % 5000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -180 "$LOG_FILE" >&2 || true
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
    sed -n '1,140p' "$failure_log" >&2
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
  slug text UNIQUE NOT NULL
);

CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL
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
  trust_artifact_role text
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

ALTER TABLE arena.raw_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.copier_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA arena
  FROM PUBLIC, anon, authenticated, service_role, outsider;

INSERT INTO arena.sources (id, slug) VALUES (1, 'gate_futures');
INSERT INTO arena.traders (id, source_id, exchange_trader_id)
VALUES (101, 1, 'trader-101');

INSERT INTO arena.raw_objects (
  id, source_id, job_type, trader_id, timeframe, fetched_at,
  storage_path, bytes, content_hash, quarantined, meta
) VALUES
  (
    1, 1, 'tier_c', 101, 0, '2026-08-04 10:01:00+00',
    'gate/tier_c/a.json.gz', 100, repeat('a', 64), false,
    '{"surface":"copiers"}'::jsonb
  ),
  (
    2, 1, 'history:copiers', 101, NULL, '2026-08-04 10:03:00+00',
    'gate/history/b.json.gz', 80, repeat('b', 64), false,
    '{"surface":"copiers"}'::jsonb
  );

INSERT INTO arena.copier_records (
  trader_id, ts, copier_label, copier_pnl, copier_invested,
  copy_duration_days, currency, dedupe_hash, raw
) VALUES (
  101, '2026-01-01 00:00:00+00', 'legacy-private', 1, 2,
  3, 'USDT', 'legacy-1', '{}'::jsonb
);
SQL

LEGACY_BEFORE="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.md5(
      pg_catalog.string_agg(
        pg_catalog.to_jsonb(row_value)::text,
        ',' ORDER BY row_value.dedupe_hash
      )
    )
    FROM arena.copier_records AS row_value;
  "
)"

psql_cmd -q -f "$MIGRATION"

psql_cmd -q <<'SQL'
INSERT INTO arena.copier_snapshot_publications (
  source_id, trader_id, lane, source_run_id, live_raw_object_id,
  raw_object_id_at_publication, raw_storage_path,
  raw_content_hash, raw_fetched_at, observed_at, scan_terminal_state,
  caller_limited, page_count, parsed_row_count, source_depth, currency,
  row_set_sha256, evidence_contract, privacy_contract, data_contract,
  parser_contract, row_hash_contract, publisher_contract
) VALUES (
  1, 101, 'tier_c', repeat('a', 64), 1, 1,
  'gate/tier_c/a.json.gz', repeat('a', 64),
  '2026-08-04 10:01:00+00', '2026-08-04 10:00:00+00',
  'caller_limited', true, 2, 2, 'top10', 'USDT', repeat('c', 64),
  'arena.copier-snapshot-publication@1',
  'arena.copier-histogram-k-anonymity@1',
  'arena.ingest.copier-snapshot-artifact@1',
  'arena.ingest.copier-parser@1',
  'arena.ingest.copier-row-set.strict-canonical-json@1',
  'arena.ingest.copier-snapshot-publisher@1'
);

INSERT INTO arena.copier_snapshot_rows (
  publication_id, row_ordinal, source_event_at, copier_label,
  copier_pnl, copier_invested, copy_duration_days, dedupe_hash, row_sha256
) VALUES
  (1, 0, '2026-01-01 00:00:00+00', 'private-a', 10, 100, 3, 'a', repeat('1', 64)),
  (1, 1, '2026-02-01 00:00:00+00', 'private-b', 20, 200, 4, 'b', repeat('2', 64));

INSERT INTO arena.copier_snapshot_publications (
  source_id, trader_id, lane, source_run_id, live_raw_object_id,
  raw_object_id_at_publication, raw_storage_path,
  raw_content_hash, raw_fetched_at, observed_at, scan_terminal_state,
  caller_limited, page_count, parsed_row_count, source_depth, currency,
  row_set_sha256, evidence_contract, privacy_contract, data_contract,
  parser_contract, row_hash_contract, publisher_contract,
  previous_publication_id
) VALUES (
  1, 101, 'tier_b', repeat('b', 64), 2, 2,
  'gate/history/b.json.gz', repeat('b', 64),
  '2026-08-04 10:03:00+00', '2026-08-04 10:02:00+00',
  'stream_exhausted_unverified', false, 1, 0, 'top10', 'USDT', repeat('d', 64),
  'arena.copier-snapshot-publication@1',
  'arena.copier-histogram-k-anonymity@1',
  'arena.ingest.copier-snapshot-artifact@1',
  'arena.ingest.copier-parser@1',
  'arena.ingest.copier-row-set.strict-canonical-json@1',
  'arena.ingest.copier-snapshot-publisher@1', 1
);
SQL

expect_failure_contains \
  'browser role read snapshot receipts' \
  'permission denied for table copier_snapshot_publications' \
  "SET ROLE anon; SELECT * FROM arena.copier_snapshot_publications"
expect_failure_contains \
  'browser role read snapshot rows' \
  'permission denied for table copier_snapshot_rows' \
  "SET ROLE authenticated; SELECT * FROM arena.copier_snapshot_rows"
expect_failure_contains \
  'publication receipt mutation succeeded' \
  'copier snapshot publication receipts are immutable' \
  "UPDATE arena.copier_snapshot_publications SET parsed_row_count = 3 WHERE publication_id = 1"
expect_failure_contains \
  'publication receipt deletion succeeded' \
  'copier snapshot publication receipts are immutable' \
  "DELETE FROM arena.copier_snapshot_publications WHERE publication_id = 1"
expect_failure_contains \
  'snapshot row mutation succeeded' \
  'copier snapshot rows are immutable' \
  "UPDATE arena.copier_snapshot_rows SET copier_pnl = 999 WHERE publication_id = 1"
expect_failure_contains \
  'snapshot row truncation succeeded' \
  'copier snapshot rows are immutable' \
  "TRUNCATE arena.copier_snapshot_rows"
expect_failure_contains \
  'protected RAW identity mutation succeeded' \
  'copier snapshot RAW evidence 1 cannot be mutated' \
  "UPDATE arena.raw_objects SET content_hash = repeat('f', 64) WHERE id = 1"

psql_cmd -q -c \
  "UPDATE arena.raw_objects SET quarantined = true WHERE id = 1"
expect_failure_contains \
  'quarantined bound RAW deletion succeeded' \
  'quarantined copier snapshot RAW evidence cannot be deleted' \
  "DELETE FROM arena.raw_objects WHERE id = 1"

# Ordinary RAW retention may remove the object, but the immutable receipt keeps
# its denormalized path/hash/clocks and only the FK pointer is tombstoned.
psql_cmd -q -c "DELETE FROM arena.raw_objects WHERE id = 2"
GC_RESULT="$(
  psql_cmd -Atqc "
    SELECT
      COALESCE(live_raw_object_id::text, 'NULL') || '|' ||
      raw_object_id_at_publication::text || '|' || raw_storage_path || '|' ||
      raw_content_hash || '|' ||
      scan_terminal_state || '|' || parsed_row_count::text
    FROM arena.copier_snapshot_publications
    WHERE publication_id = 2;
  "
)"
assert_equal \
  'ordinary RAW GC did not tombstone only the live pointer' \
  "NULL|2|gate/history/b.json.gz|$(printf 'b%.0s' {1..64})|stream_exhausted_unverified|0" \
  "$GC_RESULT"

PRIVILEGE_RESULT="$(
  psql_cmd -Atqc "
    SELECT
      pg_catalog.has_table_privilege(
        'service_role', 'arena.copier_snapshot_publications', 'SELECT'
      ) || '|' ||
      pg_catalog.has_table_privilege(
        'service_role', 'arena.copier_snapshot_rows', 'SELECT'
      ) || '|' ||
      pg_catalog.has_function_privilege(
        'anon', 'arena.reject_copier_snapshot_row_mutation()', 'EXECUTE'
      );
  "
)"
assert_equal 'snapshot private ACL drifted' 'false|false|false' "$PRIVILEGE_RESULT"

LEGACY_AFTER="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.md5(
      pg_catalog.string_agg(
        pg_catalog.to_jsonb(row_value)::text,
        ',' ORDER BY row_value.dedupe_hash
      )
    )
    FROM arena.copier_records AS row_value;
  "
)"
assert_equal 'legacy copier rows changed during substrate migration' \
  "$LEGACY_BEFORE" "$LEGACY_AFTER"

echo 'copier snapshot publication substrate PostgreSQL 17 proof passed'
