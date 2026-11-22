#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261118135918_trust_evidence_retention.
# The fixture reproduces the production evidence shape that matters here:
# RESTRICT parent edges (20261113105605), CASCADE run->observation->artifact,
# the append-only metric-trust trigger (20260721120000 body), an immutable
# Tier-A receipt, publications/evidence/plans, serving heads and freshness.
#
# Snapshots (source 1 = hyperliquid, source 2 = bybit_copytrade alias bybit).
# "rep" = the day's last passed crawl per source x timeframe (daily
# representative, same selection as snapshotEntryDownsampleSql).
#   S1  s1/90  passed 40d 06:00 trust, OLD pub  -> snapshot (dangling cohort audited)
#   S21 s1/90  passed 40d 20:00 rep, no trust   -> keep (nothing to purge)
#   S2  s1/90  passed 30d rep trust, CURRENT pub -> keep
#   S3  s1/90  passed 25d rep trust             -> runs_only (row + entries kept)
#   S4  s1/90  passed 20d 06:00 trust + receipt -> body_only
#   S24 s1/90  passed 20d 20:00 rep             -> keep
#   S5  s1/90  passed 10d rep trust             -> keep (inside 14 days)
#   S6  s1/90  failed 2d                        -> keep (inside 7 days)
#   S7  s1/90  failed 9d                        -> snapshot (unpublished_failure)
#   S8  s1/90  passed 5d                        -> keep (latest passed)
#   S17 s1/90  passed 200d rep trust            -> snapshot (rep beyond 180 days)
#   S9  s2/90  passed 60d trust, only passed    -> keep (latest passed, old)
#   S10 s2/90  failed 50d                       -> snapshot (unpublished_failure)
#   S11 s2/30  passed 40d, freshness board      -> keep (current freshness pin)
#   S12 s2/30  passed 35d                       -> keep (latest passed)
#   S13 s1/7   passed 30d, recent plan          -> keep (plan planned 3d ago)
#   S14 s1/7   passed 20d                       -> keep (latest passed)
#   S15 s1/30  failed 20d, old plan             -> keep (failed but referenced once)
#   S16 s1/30  passed 1d                        -> keep (latest passed)
#   S18 s2/7   passed 45d 06:00 trust, 1500 traders (4502 rows) -> snapshot, chunked
#   S28 s2/7   passed 45d 20:00 rep             -> keep
#   S19 s2/7   passed 1d                        -> keep (latest passed)

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

export PGOPTIONS='-c client_min_messages=warning -c statement_timeout=180s'
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

CREATE TEMP TABLE fixture (id bigint, source_id smallint, timeframe smallint, at timestamptz, passed boolean, trust boolean, traders int);
INSERT INTO fixture VALUES
  (1, 1, 90, date_trunc('day', now() - interval '40 days') + interval '6 hours', true, true, 2),
  (21, 1, 90, date_trunc('day', now() - interval '40 days') + interval '20 hours', true, false, 2),
  (2, 1, 90, date_trunc('day', now() - interval '30 days') + interval '12 hours', true, true, 2),
  (3, 1, 90, date_trunc('day', now() - interval '25 days') + interval '12 hours', true, true, 2),
  (4, 1, 90, date_trunc('day', now() - interval '20 days') + interval '6 hours', true, true, 2),
  (24, 1, 90, date_trunc('day', now() - interval '20 days') + interval '20 hours', true, false, 2),
  (5, 1, 90, date_trunc('day', now() - interval '10 days') + interval '12 hours', true, true, 2),
  (6, 1, 90, now() - interval '2 days', false, false, 0),
  (7, 1, 90, now() - interval '9 days', false, false, 0),
  (8, 1, 90, now() - interval '5 days', true, false, 2),
  (17, 1, 90, date_trunc('day', now() - interval '200 days') + interval '12 hours', true, true, 2),
  (9, 2, 90, now() - interval '60 days', true, true, 2),
  (10, 2, 90, now() - interval '50 days', false, false, 0),
  (11, 2, 30, now() - interval '40 days', true, false, 2),
  (12, 2, 30, now() - interval '35 days', true, false, 2),
  (13, 1, 7, now() - interval '30 days', true, false, 2),
  (14, 1, 7, now() - interval '20 days', true, false, 2),
  (15, 1, 30, now() - interval '20 days', false, false, 0),
  (16, 1, 30, now() - interval '1 day', true, false, 2),
  (18, 2, 7, date_trunc('day', now() - interval '45 days') + interval '6 hours', true, true, 1500),
  (28, 2, 7, date_trunc('day', now() - interval '45 days') + interval '20 hours', true, false, 2),
  (19, 2, 7, now() - interval '1 day', true, false, 2);

-- Trust snapshots carry RAW 100+id (board payload = population), 200+id
-- (manifest), 300+id (artifacts); all RAW fetched 40 days ago.
INSERT INTO arena.raw_objects
SELECT r.id, 'raw/' || r.id, 'h' || r.id, false, now() - interval '40 days'
FROM fixture f CROSS JOIN LATERAL (VALUES (100 + f.id), (200 + f.id), (300 + f.id)) AS r(id)
WHERE f.trust;
INSERT INTO arena.leaderboard_snapshots
SELECT f.id, f.source_id, f.timeframe, date_trunc('second', f.at), f.passed,
       CASE WHEN f.trust THEN 100 + f.id END
FROM fixture f;
INSERT INTO arena.leaderboard_entries
SELECT s.scraped_at, s.id, 1000 + t.n, t.n + 1
FROM arena.leaderboard_snapshots s JOIN fixture f ON f.id = s.id
CROSS JOIN LATERAL generate_series(0, f.traders - 1) AS t(n);
INSERT INTO arena.metric_trust_runs
SELECT 'run-' || f.id, f.id, 100 + f.id, 200 + f.id FROM fixture f WHERE f.trust;
-- One observation per trust snapshot (trader 1000); S18: one per trader.
INSERT INTO arena.metric_trust_observations
SELECT f.id * 10000 + t.n, 1000 + t.n, f.id, s.scraped_at, 'run-' || f.id
FROM fixture f JOIN arena.leaderboard_snapshots s ON s.id = f.id
CROSS JOIN LATERAL generate_series(0, CASE WHEN f.id = 18 THEN f.traders - 1 ELSE 0 END) AS t(n)
WHERE f.trust;
INSERT INTO arena.metric_trust_artifacts
SELECT o.id, 300 + o.snapshot_id FROM arena.metric_trust_observations o;
INSERT INTO arena.tier_a_execution_window_receipts VALUES (1, 4);

-- CURRENT cohort (serving head; sealed 30 days ago) binds S2. An OLD cohort
-- (sealed 20 days ago, not served) binds S1 by evidence and proof.
INSERT INTO arena.leaderboard_rank_publications VALUES
  ('00000000-0000-4000-8000-0000000000c1', '90D', '[]', now() - interval '30 days'),
  ('00000000-0000-4000-8000-0000000000a1', '90D',
   jsonb_build_array(jsonb_build_object('source', 'hyperliquid',
     'source_as_of', (SELECT scraped_at FROM arena.leaderboard_snapshots WHERE id = 1))),
   now() - interval '20 days');
INSERT INTO arena.leaderboard_rank_publication_source_evidence VALUES
  ('00000000-0000-4000-8000-0000000000c1', 'hyperliquid', '{2}'),
  ('00000000-0000-4000-8000-0000000000a1', 'hyperliquid', '{1}');
INSERT INTO arena.public_ranked_leaderboard_serving_heads VALUES ('90D', '00000000-0000-4000-8000-0000000000c1');
INSERT INTO public.leaderboard_source_freshness VALUES
  ('30D', 'bybit', (SELECT scraped_at FROM arena.leaderboard_snapshots WHERE id = 11), NULL);
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
  "DELETE FROM arena.metric_trust_observations WHERE id = 10000"
assert_fails "the private step cannot run outside retain_trust_evidence" \
  "SELECT arena.trust_evidence_retention_step(1, 'snapshot', 1000)"
assert_fails "superseded window below 14 days is refused" "SELECT arena.retain_trust_evidence(false, 100000, 13)"
assert_fails "failed window below 7 days is refused" "SELECT arena.retain_trust_evidence(false, 100000, 14, 6)"
assert_fails "daily window below the superseded window is refused" "SELECT arena.retain_trust_evidence(false, 100000, 30, 7, 20)"
assert_fails "row cap is bounded" "SELECT arena.retain_trust_evidence(false, 10)"
assert_fails "an unbounded statement_timeout is refused" "SET statement_timeout = 0; SELECT arena.retain_trust_evidence()"
assert_fails "delete mode is refused while the switch is off" "SELECT arena.retain_trust_evidence(true)"
assert_fails "a delete batch under the migration's 30min statement_timeout is refused" \
  "UPDATE arena.trust_evidence_retention_settings SET delete_enabled = true; SET statement_timeout = '30min'; SELECT arena.retain_trust_evidence(true)"
assert_equal "no retention function carries its own statement_timeout (the batch inherits only the caller's 3min)" "0" "$(psql_db -Atqc "
  SELECT count(*) FROM pg_proc
   WHERE pronamespace = 'arena'::regnamespace
     AND (proname LIKE 'trust_evidence_retention%' OR proname IN ('retain_trust_evidence', 'metric_trust_run_purge_authorized'))
     AND EXISTS (SELECT 1 FROM unnest(proconfig) AS c WHERE c LIKE 'statement_timeout=%')")"
assert_equal "the migration's 30min statement_timeout did not leak into later sessions" "3min" "$(psql_db -Atqc "SHOW statement_timeout")"

DRY="$(psql_db -Atqc "SELECT arena.retain_trust_evidence() - 'would_delete'")"
echo "dry run: $DRY"
assert_equal "dry run: 7 eligible (5 superseded, 2 failed; 5 snapshot, 1 body_only, 1 runs_only)" \
  "count|7|5|2|5|1|1|0" "$(psql_db -Atqc "
  SELECT concat_ws('|', r->>'mode', r->>'eligible_snapshots_total', r->>'eligible_superseded_success',
                   r->>'eligible_unpublished_failure', r->>'eligible_disposition_snapshot',
                   r->>'eligible_disposition_body_only', r->>'eligible_disposition_runs_only',
                   r->>'in_progress_purges')
  FROM (SELECT arena.retain_trust_evidence() AS r) AS x")"
assert_equal "dry run: dispositions per snapshot, oldest first, up to the row cap" \
  "17:snapshot,10:snapshot,18:snapshot,1:snapshot,3:runs_only,4:body_only,7:snapshot" "$(psql_db -Atqc "
  SELECT string_agg((item->>'snapshot_id') || ':' || (item->>'disposition'), ',' ORDER BY ord)
  FROM jsonb_array_elements(arena.retain_trust_evidence()->'would_delete'->'snapshots') WITH ORDINALITY AS t(item, ord)")"
assert_equal "dry run: per-table rows in scope (S18 = 1500 obs + 1500 artifacts + 1500 entries)" \
  "1504|1504|5|1506|5|4524" "$(psql_db -Atqc "
  SELECT concat_ws('|', w->>'metric_trust_observations', w->>'metric_trust_artifacts', w->>'metric_trust_runs',
                   w->>'leaderboard_entries', w->>'snapshot_rows', w->>'rows_in_scope')
  FROM (SELECT arena.retain_trust_evidence()->'would_delete' AS w) AS x")"
assert_equal "dry run with the minimum cap stops its scope at the big snapshot" "17,10,18" "$(psql_db -Atqc "
  SELECT string_agg(item->>'snapshot_id', ',' ORDER BY ord)
  FROM jsonb_array_elements(arena.retain_trust_evidence(false, 1000)->'would_delete'->'snapshots') WITH ORDINALITY AS t(item, ord)")"
assert_equal "dry run deletes nothing" "$BEFORE" "$(table_counts)"

psql_db -qc "UPDATE arena.trust_evidence_retention_settings SET delete_enabled = true"

# A batch that times out rolls back whole: hold S18's row lock so the purge
# waits past a 1s statement_timeout after it already purged S17 and S10.
"$PG_BIN/psql" -X -q -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres -c "
  BEGIN; SELECT 1 FROM arena.leaderboard_snapshots WHERE id = 18 FOR UPDATE; SELECT pg_sleep(4); COMMIT;" \
  >/dev/null 2>&1 &
LOCKER=$!
sleep 1
assert_fails "a purge batch that hits statement_timeout fails" \
  "SET statement_timeout = '1s'; SELECT arena.retain_trust_evidence(true, 100000)"
wait "$LOCKER"
assert_equal "the timed-out batch left every row in place (whole rollback)" "$BEFORE" "$(table_counts)"
assert_equal "and opened no purge" "0" "$(psql_db -Atqc "SELECT count(*) FROM arena.trust_evidence_retention_purges")"

# Row-budgeted batches at the minimum cap: S18 (4502 rows) spans batches, and
# every batch makes progress (no batch is stuck on the same snapshot).
FIRST="$(psql_db -Atqc "SELECT arena.retain_trust_evidence(true, 1000)->'deleted'")"
echo "first batch: $FIRST"
assert_equal "first batch: S17 and S10 complete, S18 in progress, within (and near) the 1000-row cap" "t|3|2|3" "$(psql_db -Atqc "
  SELECT concat_ws('|', (d->>'rows')::int BETWEEN 990 AND 1000, d->>'purges_started', d->>'purges_completed', d->>'snapshots_touched')
  FROM (SELECT '$FIRST'::jsonb AS d) AS x")"
assert_equal "S18 is in progress with its header still present" "in_progress|1" "$(psql_db -Atqc "
  SELECT concat_ws('|', (SELECT state FROM arena.trust_evidence_retention_purges WHERE snapshot_id = 18),
                   (SELECT count(*) FROM arena.leaderboard_snapshots WHERE id = 18))")"
BATCHES=1
PREVIOUS=""
while :; do
  STATE="$(psql_db -Atqc "SELECT concat_ws('|', r->>'eligible_snapshots_total', r->>'in_progress_purges')
                          FROM (SELECT arena.retain_trust_evidence() AS r) AS x")"
  [[ "$STATE" == "0|0" ]] && break
  REMAINING="$(table_counts)"
  [[ "$REMAINING" != "$PREVIOUS" ]] || { echo "a batch made no progress: $REMAINING" >&2; exit 1; }
  PREVIOUS="$REMAINING"
  psql_db -Atqc "SELECT arena.retain_trust_evidence(true, 1000)" >/dev/null
  BATCHES=$((BATCHES + 1))
  (( BATCHES < 20 )) || { echo "purge did not converge" >&2; exit 1; }
done
echo "ok - converged in $BATCHES batches of 1000 rows"
(( BATCHES >= 5 )) || { echo "expected S18 to span several batches, got $BATCHES" >&2; exit 1; }

assert_equal "surviving snapshots" "2,3,4,5,6,8,9,11,12,13,14,15,16,19,21,24,28" "$(psql_db -Atqc "
  SELECT string_agg(id::text, ',' ORDER BY id) FROM arena.leaderboard_snapshots")"
assert_equal "current-publication evidence (S2) is intact" "2|1|1|1" "$(psql_db -Atqc "
  SELECT concat_ws('|',
    (SELECT count(*) FROM arena.leaderboard_entries WHERE snapshot_id = 2),
    (SELECT count(*) FROM arena.metric_trust_runs WHERE snapshot_id = 2),
    (SELECT count(*) FROM arena.metric_trust_observations WHERE snapshot_id = 2),
    (SELECT count(*) FROM arena.metric_trust_artifacts WHERE observation_id = 20000))")"
assert_equal "latest successful snapshot (S9, 60 days old) keeps all evidence" "2|1|1|1" "$(psql_db -Atqc "
  SELECT concat_ws('|',
    (SELECT count(*) FROM arena.leaderboard_entries WHERE snapshot_id = 9),
    (SELECT count(*) FROM arena.metric_trust_runs WHERE snapshot_id = 9),
    (SELECT count(*) FROM arena.metric_trust_observations WHERE snapshot_id = 9),
    (SELECT count(*) FROM arena.metric_trust_artifacts WHERE observation_id = 90000))")"
assert_equal "inside the 14-day window (S5) nothing is deleted" "2|1|1" "$(psql_db -Atqc "
  SELECT concat_ws('|',
    (SELECT count(*) FROM arena.leaderboard_entries WHERE snapshot_id = 5),
    (SELECT count(*) FROM arena.metric_trust_runs WHERE snapshot_id = 5),
    (SELECT count(*) FROM arena.metric_trust_observations WHERE snapshot_id = 5))")"
assert_equal "daily representative S3 (25d) keeps row + entries, loses runs/observations/artifacts" \
  "1|2|0|0|0" "$(psql_db -Atqc "
  SELECT concat_ws('|',
    (SELECT count(*) FROM arena.leaderboard_snapshots WHERE id = 3),
    (SELECT count(*) FROM arena.leaderboard_entries WHERE snapshot_id = 3),
    (SELECT count(*) FROM arena.metric_trust_runs WHERE snapshot_id = 3),
    (SELECT count(*) FROM arena.metric_trust_observations WHERE snapshot_id = 3),
    (SELECT count(*) FROM arena.metric_trust_artifacts WHERE observation_id = 30000))")"
assert_equal "daily representatives without trust (S21, S24, S28) keep their entries" "2|2|2" "$(psql_db -Atqc "
  SELECT concat_ws('|',
    (SELECT count(*) FROM arena.leaderboard_entries WHERE snapshot_id = 21),
    (SELECT count(*) FROM arena.leaderboard_entries WHERE snapshot_id = 24),
    (SELECT count(*) FROM arena.leaderboard_entries WHERE snapshot_id = 28))")"
assert_equal "receipt-bound S4 keeps header and receipt, loses its body" "1|1|0|0|0" "$(psql_db -Atqc "
  SELECT concat_ws('|',
    (SELECT count(*) FROM arena.leaderboard_snapshots WHERE id = 4),
    (SELECT count(*) FROM arena.tier_a_execution_window_receipts WHERE snapshot_id = 4),
    (SELECT count(*) FROM arena.leaderboard_entries WHERE snapshot_id = 4),
    (SELECT count(*) FROM arena.metric_trust_runs WHERE snapshot_id = 4),
    (SELECT count(*) FROM arena.metric_trust_observations WHERE snapshot_id = 4))")"

# Read paths: a kept representative without runs is never a trusted current
# board. Publication boards are the latest passed snapshot per source x
# timeframe (20261116215329 latest_passed); rankable observations come from
# observations JOIN runs (20261118112703 metric_rankable_observations).
assert_equal "the publication board for hyperliquid 90D is the latest passed (S8), not S3" "8" "$(psql_db -Atqc "
  SELECT DISTINCT ON (source_id) id FROM arena.leaderboard_snapshots
   WHERE count_check_passed AND source_id = 1 AND timeframe = 90
   ORDER BY source_id, scraped_at DESC, id DESC")"
assert_equal "no rankable observation (observations JOIN runs) remains for S3" "0" "$(psql_db -Atqc "
  SELECT count(*) FROM arena.metric_trust_observations AS observation
    JOIN arena.metric_trust_runs AS acquisition ON acquisition.source_run_id = observation.source_run_id
   WHERE observation.snapshot_id = 3")"

assert_equal "publication rows and evidence digests are untouched" "2|2|2|2" "$(psql_db -Atqc "
  SELECT concat_ws('|',
    (SELECT count(*) FROM arena.leaderboard_rank_publications),
    (SELECT count(*) FROM arena.leaderboard_rank_publication_source_evidence),
    (SELECT count(*) FROM arena.leaderboard_rank_generation_publication_plans),
    (SELECT count(*) FROM arena.leaderboard_rank_generation_publication_plan_sources))")"
assert_equal "no RAW row was deleted by the purge" "24" "$(psql_db -Atqc "SELECT count(*) FROM arena.raw_objects")"
assert_equal "audit ledger: one complete row per purge" \
  "1:snapshot:superseded_success,3:runs_only:superseded_success,4:body_only:superseded_success,7:snapshot:unpublished_failure,10:snapshot:unpublished_failure,17:snapshot:superseded_success,18:snapshot:superseded_success|0" \
  "$(psql_db -Atqc "
  SELECT (SELECT string_agg(snapshot_id || ':' || disposition || ':' || reason, ',' ORDER BY snapshot_id)
            FROM arena.trust_evidence_retention_purges)
      || '|' || (SELECT count(*) FROM arena.trust_evidence_retention_purges WHERE state <> 'complete')")"
assert_equal "S18 audit row adds up across its batches" "1500|1500|1|1500|1" "$(psql_db -Atqc "
  SELECT concat_ws('|', deleted_observations, deleted_artifacts, deleted_runs, deleted_entries, deleted_snapshot_rows)
  FROM arena.trust_evidence_retention_purges WHERE snapshot_id = 18")"
assert_equal "the old publication that still names S1 is recorded as dangling" \
  "{00000000-0000-4000-8000-0000000000a1}" "$(psql_db -Atqc "
  SELECT dangling_publication_cohorts FROM arena.trust_evidence_retention_purges WHERE snapshot_id = 1")"
assert_equal "no transaction stays registered as active" "0" "$(psql_db -Atqc "
  SELECT count(*) FROM arena.trust_evidence_retention_active_xacts")"

assert_equal "a further run is a no-op (idempotent)" "0|0" "$(psql_db -Atqc "
  SELECT concat_ws('|', r->'deleted'->>'rows', r->>'eligible_snapshots_total')
  FROM (SELECT arena.retain_trust_evidence(true) AS r) AS x")"
assert_fails "a committed-for-purge run stays undeletable outside the function" \
  "DELETE FROM arena.metric_trust_runs WHERE source_run_id = 'run-2'"

OUT="$(cd "$ROOT_DIR" && PGHOST="$SOCKET_DIR" PGPORT="$PORT" npx --no-install tsx "$DRIVER" | sed -n 's/^RESULT //p' | tail -1)"
assert_equal "RAW GC: only RAW released by purged evidence becomes a candidate" \
  '{"present":true,"rawCandidates":[101,117,118,201,203,204,217,218,301,303,304,317,318]}' "$OUT"

# Fail-stop: a snapshot whose run also feeds another snapshot is refused and
# the whole batch rolls back.
psql_db -q <<'SQL'
INSERT INTO arena.leaderboard_snapshots VALUES (40, 2, 30, now() - interval '45 days', true, NULL);
INSERT INTO arena.leaderboard_entries
SELECT s.scraped_at, s.id, 1000, 1 FROM arena.leaderboard_snapshots s WHERE s.id = 40;
INSERT INTO arena.raw_objects VALUES (440, 'raw/440', 'h', false, now()), (540, 'raw/540', 'h', false, now());
INSERT INTO arena.metric_trust_runs VALUES ('run-40', 40, 440, 540);
INSERT INTO arena.metric_trust_observations
SELECT 400001, 1000, 12, scraped_at, 'run-40' FROM arena.leaderboard_snapshots WHERE id = 12;
SQL
COUNTS_BEFORE_ABORT="$(table_counts)"
assert_fails "a run bound outside its snapshot aborts the whole batch" \
  "SELECT arena.retain_trust_evidence(true)"
assert_equal "the aborted batch left every row in place" "$COUNTS_BEFORE_ABORT" "$(table_counts)"

assert_equal "service_role may execute the entry point only; no ledger writes" "t|f|f|f|f" "$(psql_db -Atqc "
  SELECT concat_ws('|',
    has_function_privilege('service_role', 'arena.retain_trust_evidence(boolean,integer,integer,integer,integer)', 'EXECUTE'),
    has_function_privilege('service_role', 'arena.trust_evidence_retention_step(bigint,text,bigint)', 'EXECUTE'),
    has_function_privilege('anon', 'arena.retain_trust_evidence(boolean,integer,integer,integer,integer)', 'EXECUTE'),
    has_table_privilege('service_role', 'arena.trust_evidence_retention_settings', 'UPDATE'),
    has_table_privilege('service_role', 'arena.trust_evidence_retention_purged_runs', 'INSERT'))")"

echo "trust evidence retention PostgreSQL 17 proof passed"
