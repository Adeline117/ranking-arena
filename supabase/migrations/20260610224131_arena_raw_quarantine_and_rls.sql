-- Migration: 20260610224131_arena_raw_quarantine_and_rls.sql
-- Created: 2026-06-11T05:41:31Z
-- Description: ARENA_DATA_SPEC v1.2 — arena schema M5+M6 of 6:
--   M5: RAW layer pointer table (payloads live in Supabase Storage bucket
--       `raw-snapshots`, NOT JSONB — spec §13.3) + staging quarantine
--       (rows failing required-field validation are isolated, never
--       silently NULLed — spec §5.2).
--   M6: RLS posture for every arena.* table — public read for serving
--       data, service_role-only for PII (copier_records), internals
--       (cache/cursors/raw/rejects) and secrets. Writes are exclusively
--       service_role (RLS bypass); zero INSERT/UPDATE policies anywhere.
--
-- Storage deploy note: create private bucket `raw-snapshots` (worker
-- writes via service key). No Storage lifecycle rules exist — the worker
-- maintenance job deletes objects >30d unless raw_objects.quarantined.

-- ============================================================
-- M5: arena.raw_objects — immutable RAW layer pointers
-- ============================================================
CREATE TABLE arena.raw_objects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE CASCADE,
  job_type text NOT NULL,            -- tier_a | tier_b | tier_c | tier_d | history:<kind>
  trader_id bigint,                  -- soft ref (RAW outlives trader churn)
  timeframe smallint,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  -- raw-snapshots/{source_slug}/{job_type}/{yyyy}/{mm}/{dd}/{ts}_{hash}.json.gz
  storage_path text NOT NULL UNIQUE,
  bytes int NOT NULL,
  content_hash text NOT NULL,
  quarantined boolean NOT NULL DEFAULT false,  -- exempt from 30d cleanup (disputes/debug)
  meta jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_arena_raw_objects_cleanup
  ON arena.raw_objects (fetched_at) WHERE NOT quarantined;
CREATE INDEX idx_arena_raw_objects_source
  ON arena.raw_objects (source_id, job_type, fetched_at DESC);

-- ============================================================
-- M5: arena.staging_rejects — quarantined rows from staging validation
-- ============================================================
CREATE TABLE arena.staging_rejects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE CASCADE,
  raw_object_id bigint,              -- soft ref → re-parse the original payload
  reason text NOT NULL,              -- missing_required_field:roi | zod:... | degenerate_page
  row_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_arena_staging_rejects_source
  ON arena.staging_rejects (source_id, created_at DESC);

-- ============================================================
-- M6: RLS — enable on every arena table
-- ============================================================
ALTER TABLE arena.exchanges            ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.sources              ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.source_secrets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.traders              ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.bots                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.profile_cache        ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.ingest_cursors       ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_entries  ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.trader_stats         ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.trader_series        ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.trader_series_weekly ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.positions_current    ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.position_history     ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.order_records        ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.transfer_history     ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.copier_records       ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.raw_objects          ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.staging_rejects      ENABLE ROW LEVEL SECURITY;

-- ---- Public read: serving-layer data ----
CREATE POLICY "Public read exchanges" ON arena.exchanges
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Public read sources" ON arena.sources
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Public read traders" ON arena.traders
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Public read bots" ON arena.bots
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Public read leaderboard_snapshots" ON arena.leaderboard_snapshots
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Public read leaderboard_entries" ON arena.leaderboard_entries
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Public read trader_stats" ON arena.trader_stats
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Public read trader_series" ON arena.trader_series
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Public read trader_series_weekly" ON arena.trader_series_weekly
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Public read positions_current" ON arena.positions_current
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Public read position_history" ON arena.position_history
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Public read order_records" ON arena.order_records
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Public read transfer_history" ON arena.transfer_history
  FOR SELECT TO anon, authenticated USING (true);

-- ---- NO public policy (service_role only, RLS bypass) ----
-- copier_records: PII (masked emails in copier_label) — aggregates are
--   served through our API layer, never direct table reads (spec §6).
-- profile_cache / ingest_cursors / raw_objects / staging_rejects /
--   source_secrets: pipeline internals.
-- Also revoke the schema-default SELECT grant so PostgREST can't even see them.
REVOKE SELECT ON arena.copier_records  FROM anon, authenticated;
REVOKE SELECT ON arena.profile_cache   FROM anon, authenticated;
REVOKE SELECT ON arena.ingest_cursors  FROM anon, authenticated;
REVOKE SELECT ON arena.raw_objects     FROM anon, authenticated;
REVOKE SELECT ON arena.staging_rejects FROM anon, authenticated;
