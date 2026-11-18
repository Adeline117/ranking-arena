#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261118135918_trust_evidence_retention.
# The fixture reproduces the production evidence shape that matters here:
# RESTRICT parent edges (20261113105605), CASCADE run->observation->artifact,
# the append-only metric-trust trigger (20260721120000 body), an immutable
# Tier-A receipt, publications/evidence/plans, serving heads and freshness.
#
# Snapshots (source 1 = hyperliquid, source 2 = bybit_copytrade alias bybit):
#   S1  s1/90  passed 40d  trust               -> purge (superseded_success)
#   S2  s1/90  passed 30d  trust, CURRENT pub  -> keep (serving head cohort)
#   S3  s1/90  passed 25d  trust, OLD pub only -> purge (old pub no longer pins)
#   S4  s1/90  passed 20d  trust, Tier-A receipt -> purge body, keep header
#   S5  s1/90  passed 10d  trust, superseded   -> keep (inside 14 days)
#   S6  s1/90  failed 2d                       -> keep (inside 7 days)
#   S7  s1/90  failed 9d                       -> purge (unpublished_failure)
#   S8  s1/90  passed 5d                       -> keep (latest passed)
#   S9  s2/90  passed 60d  trust, only passed  -> keep (latest passed, old)
#   S10 s2/90  failed 50d                      -> purge (unpublished_failure)
#   S11 s2/30  passed 40d, freshness board     -> keep (current freshness pin)
#   S12 s2/30  passed 35d                      -> keep (latest passed)
#   S13 s1/7   passed 30d, recent plan         -> keep (plan planned 3d ago)
#   S14 s1/7   passed 20d                      -> keep (latest passed)
#   S15 s1/30  failed 20d, old plan            -> keep (failed but referenced once)
#   S16 s1/30  passed 1d                       -> keep (latest passed)

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20261118135918_trust_evidence_retention.sql"
DRIVER="$ROOT_DIR/supabase/migrations/__tests__/trust-evidence-retention.driver.mts"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  [[ -x "$PG_BIN/$executable" ]] || { echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2; exit 1; }
done
[[ "$("$PG_BIN/psql" --version)" == psql\ \(PostgreSQL\)\ 17.* ]] || { echo "requires PostgreSQL 17" >&2; exit 1; }

TMP_ROOT="$(mktemp -d /tmp/trust-evidence-retention-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
PORT="${PGPORT_OVERRIDE:-$((50000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"
cleanup() {
  local code=$?
  [[ -s "$DATA_DIR/postmaster.pid" ]] && "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf "$TMP_ROOT"
  exit "$code"
}
trap cleanup EXIT

export PGOPTIONS='-c client_min_messages=warning'
psql_db() { "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"; }
assert_equal() { [[ "$2" == "$3" ]] || { echo "$1: expected '$2', got '$3'" >&2; exit 1; }; }
assert_fails() {
  local label="$1"; shift
  if psql_db -qc "$*" >/dev/null 2>&1; then echo "$label: expected failure" >&2; exit 1; fi
  echo "ok - $label"
}
table_counts() {
  psql_db -Atqc "
    SELECT concat_ws('|',
      (SELECT count(*) FROM arena.leaderboard_snapshots),
      (SELECT count(*) FROM arena.leaderboard_entries),
      (SELECT count(*) FROM arena.metric_trust_runs),
      (SELECT count(*) FROM arena.metric_trust_observations),
      (SELECT count(*) FROM arena.metric_trust_artifacts),
      (SELECT count(*) FROM arena.raw_objects))"
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$TMP_ROOT/postgres.log" -w start >/dev/null

psql_db -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA arena TO service_role;

CREATE TABLE arena.sources (id smallint PRIMARY KEY, slug text NOT NULL, meta jsonb NOT NULL DEFAULT '{}');
CREATE TABLE arena.raw_objects (
  id bigint PRIMARY KEY, storage_path text NOT NULL UNIQUE, content_hash text NOT NULL,
  quarantined boolean NOT NULL DEFAULT false, fetched_at timestamptz NOT NULL
);
CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY, source_id smallint NOT NULL REFERENCES arena.sources(id),
  timeframe smallint NOT NULL, scraped_at timestamptz NOT NULL,
  count_check_passed boolean NOT NULL, raw_object_id bigint
);
CREATE TABLE arena.leaderboard_entries (
  scraped_at timestamptz NOT NULL, snapshot_id bigint NOT NULL, trader_id bigint NOT NULL,
  rank int NOT NULL,
  PRIMARY KEY (scraped_at, snapshot_id, trader_id)
) PARTITION BY RANGE (scraped_at);
CREATE TABLE arena.leaderboard_entries_all PARTITION OF arena.leaderboard_entries
  FOR VALUES FROM ('2000-01-01') TO ('2100-01-01');
CREATE TABLE arena.metric_trust_runs (
  source_run_id text PRIMARY KEY,
  snapshot_id bigint NOT NULL UNIQUE REFERENCES arena.leaderboard_snapshots(id) ON DELETE RESTRICT,
  population_raw_object_id bigint NOT NULL REFERENCES arena.raw_objects(id) ON DELETE RESTRICT,
  manifest_raw_object_id bigint NOT NULL REFERENCES arena.raw_objects(id) ON DELETE RESTRICT
);
CREATE TABLE arena.metric_trust_observations (
  id bigint PRIMARY KEY,
  trader_id bigint NOT NULL,
  snapshot_id bigint NOT NULL REFERENCES arena.leaderboard_snapshots(id) ON DELETE RESTRICT,
  snapshot_scraped_at timestamptz NOT NULL,
  source_run_id text NOT NULL REFERENCES arena.metric_trust_runs(source_run_id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_scraped_at, snapshot_id, trader_id)
    REFERENCES arena.leaderboard_entries (scraped_at, snapshot_id, trader_id) ON DELETE RESTRICT
);
CREATE TABLE arena.metric_trust_artifacts (
  observation_id bigint NOT NULL REFERENCES arena.metric_trust_observations(id) ON DELETE CASCADE,
  raw_object_id bigint NOT NULL REFERENCES arena.raw_objects(id) ON DELETE RESTRICT,
  PRIMARY KEY (observation_id, raw_object_id)
);

-- 20260721120000 body, verbatim in behavior.
CREATE FUNCTION arena.reject_direct_metric_trust_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $function$
BEGIN
  IF TG_OP = 'TRUNCATE' OR pg_catalog.pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION 'metric trust records are append-only; insert a new run instead';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER metric_trust_runs_reject_direct_mutation BEFORE UPDATE OR DELETE ON arena.metric_trust_runs
  FOR EACH ROW EXECUTE FUNCTION arena.reject_direct_metric_trust_mutation();
CREATE TRIGGER metric_trust_runs_reject_truncate BEFORE TRUNCATE ON arena.metric_trust_runs
  FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_direct_metric_trust_mutation();
CREATE TRIGGER metric_trust_observations_reject_direct_mutation BEFORE UPDATE OR DELETE ON arena.metric_trust_observations
  FOR EACH ROW EXECUTE FUNCTION arena.reject_direct_metric_trust_mutation();
CREATE TRIGGER metric_trust_artifacts_reject_direct_mutation BEFORE UPDATE OR DELETE ON arena.metric_trust_artifacts
  FOR EACH ROW EXECUTE FUNCTION arena.reject_direct_metric_trust_mutation();

CREATE TABLE arena.tier_a_execution_window_receipts (
  id bigint PRIMARY KEY,
  snapshot_id bigint NOT NULL REFERENCES arena.leaderboard_snapshots(id) ON DELETE RESTRICT
);
CREATE FUNCTION arena.reject_receipt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Tier-A execution ledgers are immutable'; END $$;
CREATE TRIGGER receipts_immutable BEFORE UPDATE OR DELETE ON arena.tier_a_execution_window_receipts
  FOR EACH ROW EXECUTE FUNCTION arena.reject_receipt_mutation();

CREATE TABLE arena.leaderboard_rank_publications (
  id uuid PRIMARY KEY, season_id text NOT NULL, proofs jsonb NOT NULL,
  published_at timestamptz NOT NULL
);
CREATE TABLE arena.leaderboard_rank_publication_source_evidence (
  score_cohort_id uuid NOT NULL, source text NOT NULL, snapshot_ids bigint[] NOT NULL
);
CREATE TABLE arena.leaderboard_rank_generation_publication_plans (
  season_id text NOT NULL, generation_seq bigint NOT NULL, score_cohort_id uuid NOT NULL,
  planned_at timestamptz NOT NULL, PRIMARY KEY (season_id, generation_seq)
);
CREATE TABLE arena.leaderboard_rank_generation_publication_plan_sources (
  season_id text NOT NULL, generation_seq bigint NOT NULL, score_cohort_id uuid NOT NULL,
  source text NOT NULL, snapshot_ids jsonb NOT NULL
);
CREATE TABLE arena.public_ranked_leaderboard_serving_heads (season_id text PRIMARY KEY, score_cohort_id uuid NOT NULL);
CREATE TABLE arena.public_ranked_leaderboard_serving_sources (
  season_id text NOT NULL, source text NOT NULL, score_cohort_id uuid NOT NULL, source_as_of timestamptz NOT NULL
);
CREATE TABLE public.leaderboard_source_freshness (
  season_id text NOT NULL, source text NOT NULL, source_as_of timestamptz NOT NULL, score_cohort_id uuid
);

INSERT INTO arena.sources VALUES (1, 'hyperliquid', '{}'), (2, 'bybit_copytrade', '{"legacy_platform": "bybit"}');

CREATE TEMP TABLE fixture (id bigint, source_id smallint, timeframe smallint, age interval, passed boolean, trust boolean);
INSERT INTO fixture VALUES
  (1, 1, 90, '40 days', true, true),  (2, 1, 90, '30 days', true, true),
  (3, 1, 90, '25 days', true, true),  (4, 1, 90, '20 days', true, true),
  (5, 1, 90, '10 days', true, true),  (6, 1, 90, '2 days', false, false),
  (7, 1, 90, '9 days', false, false), (8, 1, 90, '5 days', true, false),
  (9, 2, 90, '60 days', true, true),  (10, 2, 90, '50 days', false, false),
  (11, 2, 30, '40 days', true, false), (12, 2, 30, '35 days', true, false),
  (13, 1, 7, '30 days', true, false), (14, 1, 7, '20 days', true, false),
  (15, 1, 30, '20 days', false, false), (16, 1, 30, '1 day', true, false);

-- Trust snapshots carry RAW 100+id (board payload = population), 200+id
-- (manifest), 300+id (artifact); all RAW fetched 40 days ago.
INSERT INTO arena.raw_objects
SELECT r.id, 'raw/' || r.id, 'h' || r.id, false, now() - interval '40 days'
FROM fixture f CROSS JOIN LATERAL (VALUES (100 + f.id), (200 + f.id), (300 + f.id)) AS r(id)
WHERE f.trust;
INSERT INTO arena.leaderboard_snapshots
SELECT f.id, f.source_id, f.timeframe, date_trunc('second', now() - f.age), f.passed,
       CASE WHEN f.trust THEN 100 + f.id END
FROM fixture f;
INSERT INTO arena.leaderboard_entries
SELECT s.scraped_at, s.id, t.trader_id, t.rank
FROM arena.leaderboard_snapshots s CROSS JOIN (VALUES (1000, 1), (1001, 2)) AS t(trader_id, rank)
WHERE s.count_check_passed;
INSERT INTO arena.metric_trust_runs
SELECT 'run-' || f.id, f.id, 100 + f.id, 200 + f.id FROM fixture f WHERE f.trust;
INSERT INTO arena.metric_trust_observations
SELECT f.id, 1000, f.id, s.scraped_at, 'run-' || f.id
FROM fixture f JOIN arena.leaderboard_snapshots s ON s.id = f.id WHERE f.trust;
INSERT INTO arena.metric_trust_artifacts SELECT f.id, 300 + f.id FROM fixture f WHERE f.trust;
INSERT INTO arena.tier_a_execution_window_receipts VALUES (1, 4);

-- CURRENT cohort (serving head; sealed 30 days ago) binds S2. An OLD cohort
-- (sealed 20 days ago, not served) binds S3 by evidence and proof.
INSERT INTO arena.leaderboard_rank_publications VALUES
  ('00000000-0000-4000-8000-0000000000c1', '90D', '[]', now() - interval '30 days'),
  ('00000000-0000-4000-8000-0000000000a1', '90D',
   jsonb_build_array(jsonb_build_object('source', 'hyperliquid',
     'source_as_of', (SELECT scraped_at FROM arena.leaderboard_snapshots WHERE id = 3))),
   now() - interval '20 days');
INSERT INTO arena.leaderboard_rank_publication_source_evidence VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'hyperliquid', '{2}'),
  ('00000000-0000-4000-8000-0000000000a1', 'hyperliquid', '{3}');
INSERT INTO arena.public_ranked_leaderboard_serving_heads VALUES ('90D', '00000000-0000-4000-8000-0000000000c1');
-- Freshness (current) points at bybit's 30D board S11 by (alias, as_of).
INSERT INTO public.leaderboard_source_freshness VALUES
  ('30D', 'bybit', (SELECT scraped_at FROM arena.leaderboard_snapshots WHERE id = 11), NULL);
-- A plan planned 3 days ago binds S13; a 30-day-old unsealed plan binds S15.
INSERT INTO arena.leaderboard_rank_generation_publication_plans VALUES
  ('7D', 1, '00000000-0000-4000-8000-0000000000b1', now() - interval '3 days'),
  ('30D', 1, '00000000-0000-4000-8000-0000000000b2', now() - interval '30 days');
INSERT INTO arena.leaderboard_rank_generation_publication_plan_sources VALUES
  ('7D', 1, '00000000-0000-4000-8000-0000000000b1', 'hyperliquid', '[13]'),
  ('30D', 1, '00000000-0000-4000-8000-0000000000b2', 'hyperliquid', '["15"]');
SQL

psql_db -q -f "$MIGRATION" >/dev/null
psql_db -q -f "$MIGRATION" >/dev/null # idempotent replay
echo "ok - migration applies and replays"

BEFORE="$(table_counts)"

assert_fails "a direct DELETE of a trust run is still refused" \
  "DELETE FROM arena.metric_trust_runs WHERE source_run_id = 'run-1'"
assert_fails "a direct DELETE of an observation is still refused" \
  "DELETE FROM arena.metric_trust_observations WHERE id = 1"
assert_fails "superseded window below 14 days is refused" "SELECT arena.retain_trust_evidence(false, 13)"
assert_fails "failed window below 7 days is refused" "SELECT arena.retain_trust_evidence(false, 14, 6)"
assert_fails "row cap is bounded" "SELECT arena.retain_trust_evidence(false, 14, 7, 50, 10)"
assert_fails "delete mode is refused while the switch is off" "SET statement_timeout = '60s'; SELECT arena.retain_trust_evidence(true)"

DRY="$(psql_db -Atqc "SELECT arena.retain_trust_evidence()")"
echo "dry run: $DRY"
assert_equal "dry run: eligible = S1,S3,S4 superseded + S7,S10 failed" "count|5|3|2" "$(psql_db -Atqc "
  SELECT concat_ws('|', r->>'mode', r->>'eligible_snapshots_total',
                   r->>'eligible_superseded_success', r->>'eligible_unpublished_failure')
  FROM (SELECT arena.retain_trust_evidence() AS r) AS x")"
assert_equal "dry run: per-table counts of the would-delete batch" \
  '{"snapshots": 5, "snapshot_rows": 4, "metric_trust_runs": 3, "body_only_snapshots": 1, "leaderboard_entries": 6, "metric_trust_artifacts": 3, "raw_object_refs_released": 8, "metric_trust_observations": 3}' \
  "$(psql_db -Atqc "SELECT arena.retain_trust_evidence()->'would_delete'")"
assert_equal "dry run deletes nothing" "$BEFORE" "$(table_counts)"
assert_equal "snapshot limit 1 counts only the oldest eligible (S10)" "1|0" "$(psql_db -Atqc "
  SELECT concat_ws('|', r->'would_delete'->>'snapshots', r->'would_delete'->>'leaderboard_entries')
  FROM (SELECT arena.retain_trust_evidence(false, 14, 7, 1) AS r) AS x")"
assert_equal "a 14-day window larger than every age keeps all of them" "0" "$(psql_db -Atqc "
  SELECT arena.retain_trust_evidence(false, 3650, 3650)->>'eligible_snapshots_total'")"

psql_db -qc "UPDATE arena.trust_evidence_retention_settings SET delete_enabled = true"
assert_fails "delete mode needs a bounded statement_timeout" \
  "SET statement_timeout = 0; SELECT arena.retain_trust_evidence(true)"

DELETED="$(psql_db -Atqc "SET statement_timeout = '60s'; SELECT arena.retain_trust_evidence(true)->'deleted'")"
assert_equal "delete mode removes exactly what the dry run counted" \
  '{"snapshots": 5, "snapshot_rows": 4, "metric_trust_runs": 3, "body_only_snapshots": 1, "leaderboard_entries": 6, "metric_trust_artifacts": 3, "raw_object_refs_released": 8, "metric_trust_observations": 3}' \
  "$DELETED"

assert_equal "surviving snapshots" "2,4,5,6,8,9,11,12,13,14,15,16" "$(psql_db -Atqc "
  SELECT string_agg(id::text, ',' ORDER BY id) FROM arena.leaderboard_snapshots")"
assert_equal "current-publication evidence (S2) is intact" "2|1|1|1" "$(psql_db -Atqc "
  SELECT concat_ws('|',
    (SELECT count(*) FROM arena.leaderboard_entries WHERE snapshot_id = 2),
    (SELECT count(*) FROM arena.metric_trust_runs WHERE snapshot_id = 2),
    (SELECT count(*) FROM arena.metric_trust_observations WHERE snapshot_id = 2),
    (SELECT count(*) FROM arena.metric_trust_artifacts WHERE observation_id = 2))")"
assert_equal "latest successful snapshot (S9, 60 days old) keeps all evidence" "2|1|1|1" "$(psql_db -Atqc "
  SELECT concat_ws('|',
    (SELECT count(*) FROM arena.leaderboard_entries WHERE snapshot_id = 9),
    (SELECT count(*) FROM arena.metric_trust_runs WHERE snapshot_id = 9),
    (SELECT count(*) FROM arena.metric_trust_observations WHERE snapshot_id = 9),
    (SELECT count(*) FROM arena.metric_trust_artifacts WHERE observation_id = 9))")"
assert_equal "inside the 14-day window (S5) nothing is deleted" "2|1|1" "$(psql_db -Atqc "
  SELECT concat_ws('|',
    (SELECT count(*) FROM arena.leaderboard_entries WHERE snapshot_id = 5),
    (SELECT count(*) FROM arena.metric_trust_runs WHERE snapshot_id = 5),
    (SELECT count(*) FROM arena.metric_trust_observations WHERE snapshot_id = 5))")"
assert_equal "receipt-bound S4 keeps header and receipt, loses its body" "1|1|0|0|0" "$(psql_db -Atqc "
  SELECT concat_ws('|',
    (SELECT count(*) FROM arena.leaderboard_snapshots WHERE id = 4),
    (SELECT count(*) FROM arena.tier_a_execution_window_receipts WHERE snapshot_id = 4),
    (SELECT count(*) FROM arena.leaderboard_entries WHERE snapshot_id = 4),
    (SELECT count(*) FROM arena.metric_trust_runs WHERE snapshot_id = 4),
    (SELECT count(*) FROM arena.metric_trust_observations WHERE snapshot_id = 4))")"
assert_equal "publication rows and evidence digests are untouched" "2|2|2|2" "$(psql_db -Atqc "
  SELECT concat_ws('|',
    (SELECT count(*) FROM arena.leaderboard_rank_publications),
    (SELECT count(*) FROM arena.leaderboard_rank_publication_source_evidence),
    (SELECT count(*) FROM arena.leaderboard_rank_generation_publication_plans),
    (SELECT count(*) FROM arena.leaderboard_rank_generation_publication_plan_sources))")"
assert_equal "no RAW row was deleted by the purge" "18" "$(psql_db -Atqc "SELECT count(*) FROM arena.raw_objects")"
assert_equal "audit ledger: one row per purged snapshot" \
  "1:superseded_success:snapshot,3:superseded_success:snapshot,4:superseded_success:body_only,7:unpublished_failure:snapshot,10:unpublished_failure:snapshot|3" \
  "$(psql_db -Atqc "
  SELECT (SELECT string_agg(snapshot_id || ':' || reason || ':' || disposition, ',' ORDER BY snapshot_id)
            FROM arena.trust_evidence_retention_purges)
      || '|' || (SELECT count(*) FROM arena.trust_evidence_retention_purged_runs)")"

assert_equal "a second run is a no-op (idempotent)" "0|0" "$(psql_db -Atqc "
  SET statement_timeout = '60s';
  SELECT concat_ws('|', r->'deleted'->>'snapshots', r->>'eligible_snapshots_total')
  FROM (SELECT arena.retain_trust_evidence(true) AS r) AS x")"
assert_fails "an authorization does not outlive its transaction" \
  "DELETE FROM arena.metric_trust_runs WHERE source_run_id = 'run-2'"

OUT="$(cd "$ROOT_DIR" && PGHOST="$SOCKET_DIR" PGPORT="$PORT" npx --no-install tsx "$DRIVER" | sed -n 's/^RESULT //p' | tail -1)"
assert_equal "RAW GC: only RAW released by purged snapshots becomes a candidate" \
  '{"present":true,"rawCandidates":[101,103,201,203,204,301,303,304]}' "$OUT"

# Fail-stop: a batch whose evidence changed underneath aborts as a whole.
psql_db -q <<'SQL'
INSERT INTO arena.leaderboard_snapshots VALUES (20, 2, 7, now() - interval '30 days', true, NULL),
  (21, 2, 7, now() - interval '1 day', true, NULL);
INSERT INTO arena.leaderboard_entries
SELECT s.scraped_at, s.id, 1000, 1 FROM arena.leaderboard_snapshots s WHERE s.id IN (20, 21);
INSERT INTO arena.raw_objects VALUES (420, 'raw/420', 'h', false, now()), (520, 'raw/520', 'h', false, now());
INSERT INTO arena.metric_trust_runs VALUES ('run-20', 20, 420, 520);
-- An observation of run-20 bound to the kept latest board S21: purging run-20
-- would cascade it away, so the batch must refuse.
INSERT INTO arena.metric_trust_observations
SELECT 21, 1000, 21, scraped_at, 'run-20' FROM arena.leaderboard_snapshots WHERE id = 21;
SQL
COUNTS_BEFORE_ABORT="$(table_counts)"
assert_fails "a run bound outside the batch aborts the whole batch" \
  "SET statement_timeout = '60s'; SELECT arena.retain_trust_evidence(true)"
assert_equal "the aborted batch left every row in place" "$COUNTS_BEFORE_ABORT" "$(table_counts)"

assert_equal "service_role may execute; API roles hold no ledger writes" "t|f|f|f" "$(psql_db -Atqc "
  SELECT concat_ws('|',
    has_function_privilege('service_role', 'arena.retain_trust_evidence(boolean,integer,integer,integer,integer)', 'EXECUTE'),
    has_function_privilege('anon', 'arena.retain_trust_evidence(boolean,integer,integer,integer,integer)', 'EXECUTE'),
    has_table_privilege('service_role', 'arena.trust_evidence_retention_settings', 'UPDATE'),
    has_table_privilege('service_role', 'arena.trust_evidence_retention_purged_runs', 'INSERT'))")"

echo "trust evidence retention PostgreSQL 17 proof passed"
