#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261113110021_leaderboard_snapshot_retention:
# arena.prune_leaderboard_snapshots deletes old snapshots (and their entries)
# but never the latest passed board, a board a sealed publication was built
# from, or a snapshot referenced by trust evidence / Tier-A receipts.
# Isolated cluster on a private socket; minimal fixture of referenced tables.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20261113110021_leaderboard_snapshot_retention.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  [[ -x "$PG_BIN/$executable" ]] || { echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2; exit 1; }
done
[[ "$("$PG_BIN/psql" --version)" == psql\ \(PostgreSQL\)\ 17.* ]] || { echo "requires PostgreSQL 17" >&2; exit 1; }

TMP_ROOT="$(mktemp -d /tmp/snapshot-retention-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
PORT="${PGPORT_OVERRIDE:-$((47000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"
cleanup() {
  local code=$?
  [[ -s "$DATA_DIR/postmaster.pid" ]] && "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$TMP_ROOT"
  exit "$code"
}
trap cleanup EXIT

psql_db() { "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"; }
assert_equal() { [[ "$2" == "$3" ]] || { echo "$1: expected '$2', got '$3'" >&2; exit 1; }; }

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$TMP_ROOT/postgres.log" -w start >/dev/null

psql_db -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA arena;
CREATE TABLE arena.sources (id smallint PRIMARY KEY, slug text NOT NULL, meta jsonb NOT NULL DEFAULT '{}');
CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY, source_id smallint NOT NULL REFERENCES arena.sources(id),
  timeframe smallint NOT NULL, scraped_at timestamptz NOT NULL, count_check_passed boolean NOT NULL
);
CREATE TABLE arena.leaderboard_entries (
  scraped_at timestamptz NOT NULL, snapshot_id bigint NOT NULL, trader_id bigint NOT NULL,
  PRIMARY KEY (scraped_at, snapshot_id, trader_id)
) PARTITION BY RANGE (scraped_at);
CREATE TABLE arena.leaderboard_entries_all PARTITION OF arena.leaderboard_entries
  FOR VALUES FROM ('2000-01-01') TO ('2100-01-01');
CREATE TABLE arena.leaderboard_rank_publications (id uuid PRIMARY KEY, proofs jsonb NOT NULL);
CREATE TABLE public.leaderboard_source_freshness (
  season_id text NOT NULL, source text NOT NULL, source_as_of timestamptz NOT NULL
);
CREATE TABLE arena.metric_trust_runs (
  source_run_id text PRIMARY KEY,
  snapshot_id bigint NOT NULL REFERENCES arena.leaderboard_snapshots(id) ON DELETE RESTRICT
);
CREATE TABLE arena.metric_trust_observations (
  id bigint PRIMARY KEY,
  snapshot_id bigint NOT NULL REFERENCES arena.leaderboard_snapshots(id) ON DELETE RESTRICT
);
CREATE TABLE arena.tier_a_execution_window_receipts (
  id bigint PRIMARY KEY,
  snapshot_id bigint REFERENCES arena.leaderboard_snapshots(id) ON DELETE RESTRICT
);

INSERT INTO arena.sources VALUES
  (1, 'binance_futures', '{}'),
  (2, 'bybit_copytrade', '{"legacy_platform": "bybit"}');

-- 1: old plain (delete)      2: old, sealed board of bybit (keep)
-- 3: old, trust run (keep)   4: old, Tier-A receipt (keep)
-- 5: latest passed binance, old (keep)   6: recent failed (keep, inside window)
-- 7: old failed bybit (delete)
INSERT INTO arena.leaderboard_snapshots VALUES
  (1, 1, 90, '2025-01-01 00:00:00+00', true),
  (2, 2, 90, '2025-01-02 00:00:00+00', true),
  (3, 1, 90, '2025-01-03 00:00:00+00', true),
  (4, 1, 90, '2025-01-04 00:00:00+00', true),
  (5, 1, 90, '2025-01-05 00:00:00+00', true),
  (6, 1, 90, now() - interval '1 day', false),
  (7, 2, 90, '2025-01-06 00:00:00+00', false);
INSERT INTO arena.leaderboard_entries
SELECT snapshot.scraped_at, snapshot.id, trader.id
FROM arena.leaderboard_snapshots AS snapshot CROSS JOIN (VALUES (100), (101)) AS trader(id);
INSERT INTO arena.leaderboard_rank_publications VALUES
  ('00000000-0000-4000-8000-000000000001',
   '[{"source": "bybit", "source_as_of": "2025-01-02T00:00:00.000000Z", "trader_ids": []}]');
INSERT INTO arena.metric_trust_runs VALUES ('run-3', 3);
INSERT INTO arena.tier_a_execution_window_receipts VALUES (1, 4);
SQL

psql_db -q -f "$MIGRATION" >/dev/null

for bad in "0, 10" "89, 10" "180, 0"; do
  if psql_db -qc "SELECT arena.prune_leaderboard_snapshots($bad)" >/dev/null 2>&1; then
    echo "prune accepted out-of-range arguments ($bad)" >&2
    exit 1
  fi
done
echo "ok - retention window and batch bounds are enforced"

assert_equal "first batch of one deletes the oldest unpinned snapshot" \
  '{"contract": "leaderboard-snapshot-retention@1", "retention_days": 90, "deleted_entries": 2, "deleted_snapshots": 1}' \
  "$(psql_db -Atqc "SELECT arena.prune_leaderboard_snapshots(90, 1)")"
psql_db -Atqc "SELECT arena.prune_leaderboard_snapshots(90, 100)" >/dev/null
assert_equal "only unpinned old snapshots are gone" "2,3,4,5,6" "$(psql_db -Atqc "
  SELECT string_agg(id::text, ',' ORDER BY id) FROM arena.leaderboard_snapshots")"
assert_equal "their entries went with them, pinned ones stayed" "10" "$(psql_db -Atqc "
  SELECT count(*) FROM arena.leaderboard_entries")"
assert_equal "a second run is a no-op" '0' "$(psql_db -Atqc "
  SELECT arena.prune_leaderboard_snapshots(90, 100)->>'deleted_snapshots'")"
assert_equal "service_role may run it, anon may not" "true|false" "$(psql_db -Atqc "
  SELECT has_function_privilege('service_role', 'arena.prune_leaderboard_snapshots(integer,integer)', 'EXECUTE')
    || '|' || has_function_privilege('anon', 'arena.prune_leaderboard_snapshots(integer,integer)', 'EXECUTE')")"

# 20261113110430 later pins snapshots bound as publication evidence. Install
# minimal serving-authority stand-ins, apply it, and prove the pin.
psql_db -q <<'SQL'
ALTER TABLE arena.leaderboard_rank_publications
  ADD COLUMN season_id text NOT NULL DEFAULT '90D',
  ADD CONSTRAINT leaderboard_rank_publications_id_season_id_key UNIQUE (id, season_id);
CREATE TABLE arena.public_ranked_leaderboard_serving_heads (season_id text, score_cohort_id uuid);
CREATE TABLE arena.public_ranked_leaderboard_serving_sources (
  season_id text, source text, score_cohort_id uuid, source_as_of timestamptz
);
CREATE FUNCTION arena.public_ranked_leaderboard_serving_seasons(p_observed_at timestamptz)
RETURNS TABLE (season_id text) LANGUAGE sql STABLE AS $$ SELECT NULL::text WHERE false $$;
INSERT INTO arena.leaderboard_snapshots VALUES (8, 1, 90, '2025-01-07 00:00:00+00', true),
  (9, 1, 90, '2025-01-08 00:00:00+00', true);
SQL
PGOPTIONS='-c client_min_messages=warning' psql_db -q   -f "$ROOT_DIR/supabase/migrations/20261113110430_rank_publication_source_evidence_binding.sql" >/dev/null
psql_db -q <<'SQL'
-- Bypass the in-transaction recorder: the pin only needs an evidence row.
ALTER TABLE arena.leaderboard_rank_publication_source_evidence DISABLE TRIGGER USER;
INSERT INTO arena.leaderboard_rank_publication_source_evidence
  (score_cohort_id, season_id, source, evidence_grade, snapshot_ids)
VALUES ('00000000-0000-4000-8000-000000000001', '90D', 'binance_futures', 'count_check_only', '{8}');
SQL
psql_db -Atqc "SELECT arena.prune_leaderboard_snapshots(90, 100)" >/dev/null
# 9 is now binance's latest passed board, so 5 loses that pin and goes; 8 is
# old and not latest, kept only because a sealed cohort's evidence binds it.
assert_equal "evidence-bound snapshot stays, superseded latest goes" "2,3,4,6,8,9" \
  "$(psql_db -Atqc "SELECT string_agg(id::text, ',' ORDER BY id) FROM arena.leaderboard_snapshots")"


# 20261114102645: bounded retention. Trust runs, receipts and historical
# publication evidence no longer pin a snapshot forever; only the latest passed
# board, the current freshness board and evidence of a serving head (or inside
# the window) do. Give the stand-ins the production append-only triggers.
psql_db -q <<'SQL'
ALTER TABLE arena.leaderboard_snapshots ADD COLUMN raw_object_id bigint;
CREATE FUNCTION arena.fixture_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append-only %', TG_TABLE_NAME; END $$;
CREATE TRIGGER metric_trust_runs_reject_direct_mutation BEFORE UPDATE OR DELETE
  ON arena.metric_trust_runs FOR EACH ROW EXECUTE FUNCTION arena.fixture_reject_mutation();
CREATE TRIGGER metric_trust_observations_reject_direct_mutation BEFORE UPDATE OR DELETE
  ON arena.metric_trust_observations FOR EACH ROW EXECUTE FUNCTION arena.fixture_reject_mutation();
CREATE TRIGGER tier_a_execution_window_receipts_immutable BEFORE UPDATE OR DELETE
  ON arena.tier_a_execution_window_receipts FOR EACH ROW EXECUTE FUNCTION arena.fixture_reject_mutation();
ALTER TABLE arena.leaderboard_rank_publication_source_evidence ENABLE TRIGGER USER;
INSERT INTO arena.metric_trust_observations VALUES (31, 3);
INSERT INTO arena.leaderboard_rank_publications (id, proofs, season_id) VALUES
  ('00000000-0000-4000-8000-000000000002', '[]', '90D'),
  ('00000000-0000-4000-8000-000000000003', '[]', '90D');
INSERT INTO arena.public_ranked_leaderboard_serving_heads
  VALUES ('90D', '00000000-0000-4000-8000-000000000003');
-- 10: old, bound only by 400-day-old evidence of a retired cohort (goes)
-- 11: old, bound by 400-day-old evidence of the serving head (stays)
-- 12: old, named by the current freshness row of binance (stays)
INSERT INTO arena.leaderboard_snapshots (id, source_id, timeframe, scraped_at, count_check_passed) VALUES
  (10, 1, 90, '2024-10-01 00:00:00+00', true),
  (11, 1, 90, '2024-10-02 00:00:00+00', true),
  (12, 1, 90, '2024-10-03 00:00:00+00', true);
INSERT INTO public.leaderboard_source_freshness VALUES ('90D', 'binance_futures', '2024-10-03 00:00:00+00');
ALTER TABLE arena.leaderboard_rank_publication_source_evidence DISABLE TRIGGER USER;
INSERT INTO arena.leaderboard_rank_publication_source_evidence
  (score_cohort_id, season_id, source, evidence_grade, snapshot_ids, recorded_at)
VALUES
  ('00000000-0000-4000-8000-000000000002', '90D', 'binance_futures', 'count_check_only', '{10}',
   now() - interval '400 days'),
  ('00000000-0000-4000-8000-000000000003', '90D', 'binance_futures', 'count_check_only', '{11}',
   now() - interval '400 days');
ALTER TABLE arena.leaderboard_rank_publication_source_evidence ENABLE TRIGGER USER;
SQL
PGOPTIONS='-c client_min_messages=warning' psql_db -q \
  -f "$ROOT_DIR/supabase/migrations/20261114102645_leaderboard_snapshot_bounded_retention.sql" >/dev/null

assert_equal "pruning retires trust runs, observations, receipts and expired evidence with their snapshots" \
  '{"contract": "leaderboard-snapshot-retention@2", "retention_days": 90, "deleted_entries": 4, "deleted_receipts": 1, "deleted_snapshots": 3, "deleted_trust_runs": 1, "deleted_trust_observations": 1, "deleted_publication_evidence": 1}' \
  "$(psql_db -Atqc "SELECT arena.prune_leaderboard_snapshots(90, 100)")"
assert_equal "kept: bybit's latest passed, recent, window evidence, serving-head evidence, freshness board, latest" \
  "2,6,8,9,11,12" \
  "$(psql_db -Atqc "SELECT string_agg(id::text, ',' ORDER BY id) FROM arena.leaderboard_snapshots")"
assert_equal "no evidence row or trust row points at a deleted snapshot" "0" "$(psql_db -Atqc "
  SELECT (SELECT count(*) FROM arena.leaderboard_rank_publication_source_evidence AS evidence
           WHERE NOT evidence.snapshot_ids <@ ARRAY(SELECT id FROM arena.leaderboard_snapshots))
       + (SELECT count(*) FROM arena.metric_trust_runs) + (SELECT count(*) FROM arena.metric_trust_observations)
       + (SELECT count(*) FROM arena.tier_a_execution_window_receipts)")"
assert_equal "the append-only triggers are enabled again" "O,O,O,O" "$(psql_db -Atqc "
  SELECT string_agg(tgenabled::text, ',') FROM pg_trigger
   WHERE tgname IN ('metric_trust_runs_reject_direct_mutation',
     'metric_trust_observations_reject_direct_mutation',
     'tier_a_execution_window_receipts_immutable', 'rank_publication_evidence_immutable')")"
if psql_db -qc "DELETE FROM arena.leaderboard_rank_publication_source_evidence" >/dev/null 2>&1; then
  echo "publication evidence became directly deletable" >&2; exit 1
fi
assert_equal "a second run is a no-op" '0' "$(psql_db -Atqc "
  SELECT arena.prune_leaderboard_snapshots(90, 100)->>'deleted_snapshots'")"

echo "leaderboard snapshot retention PostgreSQL 17 proof passed"
