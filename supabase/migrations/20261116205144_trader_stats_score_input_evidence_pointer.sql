-- Migration: 20261116205144_trader_stats_score_input_evidence_pointer.sql
-- Description: Score-input evidence binding, step 2a of 3 (PR #476 plan,
--   option B): an evidence pointer on arena.trader_stats.
--
-- A trader_stats row is written by several writers (the Tier-A board headline
-- upsert, Tier-B profile crawls, enrichment, repairs), and every writer merges
-- with COALESCE, so one row mixes values of different origins. A value is
-- publication evidence only when it was parsed from the source payload RAW of
-- an attempt-bound board acquisition. This migration records that, per value:
--
-- * evidence_raw_object_id / evidence_source_run_id: the source payload RAW
--   and the source run (canonical manifest sha256) of the attempt-bound board
--   write that produced the attested values;
-- * evidence_metrics: which score-input metrics that write attested (roi, pnl,
--   win_rate, mdd, sharpe, copier_count, total_positions, and the extras keys
--   sortino, calmar, volatility).
--
-- The plan named two pointer columns. A row-level pointer alone cannot be
-- honest under the COALESCE merges: it would either attest values the board
-- never sent (a profile drawdown retained next to a board ROI), or, if any
-- retained value voided it, void the board's own drawdown whenever a profile
-- crawl had written a trade count. evidence_metrics keeps the attestation per
-- value.
--
-- arena.trader_stats_score_input_evidence (BEFORE INSERT OR UPDATE) keeps the
-- pointer truthful for every writer, including those that never mention it:
-- * a write that sets a new pointer (the board writer) attests only the
--   listed metrics that are non-null in the stored row;
-- * any other write keeps the pointer but drops every attested metric whose
--   value it changed, and clears the pointer once none is left;
-- * a write without a pointer stores none.
-- So a profile crawl, enrichment or repair that overwrites a board value
-- removes that value's attestation, and nothing but a pointer-setting write
-- can add one.
--
-- PREDEPLOY: inert for the deployed worker (it never sets the pointer, so
-- every row keeps NULL); the worker release that stamps board writes needs the
-- columns. Columns are added without a default (catalog-only); the CHECK is
-- added NOT VALID and then validated (every existing row is all-NULL).
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.trader_stats') IS NULL THEN
    RAISE EXCEPTION 'arena.trader_stats must exist';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.trader_stats'::pg_catalog.regclass
      AND attribute.attname IN (
        'evidence_raw_object_id', 'evidence_source_run_id', 'evidence_metrics'
      )
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'arena.trader_stats evidence pointer already exists';
  END IF;
END
$preflight$;

ALTER TABLE arena.trader_stats
  ADD COLUMN evidence_raw_object_id bigint,
  ADD COLUMN evidence_source_run_id text,
  ADD COLUMN evidence_metrics text[];

COMMENT ON COLUMN arena.trader_stats.evidence_raw_object_id IS
  'Source payload RAW of the attempt-bound board write that attested evidence_metrics.';
COMMENT ON COLUMN arena.trader_stats.evidence_source_run_id IS
  'Source run (canonical manifest sha256) of that board acquisition.';
COMMENT ON COLUMN arena.trader_stats.evidence_metrics IS
  'Score-input metrics whose stored values that board write attested.';

ALTER TABLE arena.trader_stats
  ADD CONSTRAINT trader_stats_score_input_evidence_shape CHECK (
    (
      evidence_raw_object_id IS NULL
      AND evidence_source_run_id IS NULL
      AND evidence_metrics IS NULL
    )
    OR (
      evidence_raw_object_id > 0
      AND evidence_source_run_id ~ '^[0-9a-f]{64}$'
      AND pg_catalog.cardinality(evidence_metrics) > 0
      AND evidence_metrics <@ ARRAY[
        'roi', 'pnl', 'win_rate', 'mdd', 'sharpe', 'copier_count',
        'total_positions', 'sortino', 'calmar', 'volatility'
      ]::text[]
    )
  ) NOT VALID;

ALTER TABLE arena.trader_stats
  VALIDATE CONSTRAINT trader_stats_score_input_evidence_shape;

-- One score-input metric of a trader_stats row, as jsonb (SQL NULL when absent
-- or JSON null). Shared by the guard below and the publication reader.
CREATE OR REPLACE FUNCTION arena.trader_stats_score_input_value(
  p_row jsonb,
  p_metric text
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
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

CREATE OR REPLACE FUNCTION arena.trader_stats_score_input_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  -- trader-stats-score-input-evidence@1
  v_new jsonb;
  v_old jsonb;
BEGIN
  IF NEW.evidence_raw_object_id IS NULL OR NEW.evidence_source_run_id IS NULL THEN
    NEW.evidence_raw_object_id := NULL;
    NEW.evidence_source_run_id := NULL;
    NEW.evidence_metrics := NULL;
    RETURN NEW;
  END IF;

  v_new := pg_catalog.to_jsonb(NEW);
  IF TG_OP = 'UPDATE'
     AND NEW.evidence_raw_object_id = OLD.evidence_raw_object_id
     AND NEW.evidence_source_run_id = OLD.evidence_source_run_id THEN
    -- Not a new attestation: keep only the attested values this write left
    -- untouched.
    v_old := pg_catalog.to_jsonb(OLD);
    NEW.evidence_metrics := ARRAY(
      SELECT metric.name
      FROM pg_catalog.unnest(OLD.evidence_metrics) AS metric(name)
      WHERE arena.trader_stats_score_input_value(v_new, metric.name) IS NOT NULL
        AND arena.trader_stats_score_input_value(v_new, metric.name)
          = arena.trader_stats_score_input_value(v_old, metric.name)
      ORDER BY metric.name
    );
  ELSE
    -- A new attestation covers only listed metrics that are stored non-null.
    NEW.evidence_metrics := ARRAY(
      SELECT DISTINCT metric.name
      FROM pg_catalog.unnest(COALESCE(NEW.evidence_metrics, ARRAY[]::text[]))
        AS metric(name)
      WHERE arena.trader_stats_score_input_value(v_new, metric.name) IS NOT NULL
      ORDER BY metric.name
    );
  END IF;

  IF pg_catalog.cardinality(NEW.evidence_metrics) = 0 THEN
    NEW.evidence_raw_object_id := NULL;
    NEW.evidence_source_run_id := NULL;
    NEW.evidence_metrics := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

ALTER FUNCTION arena.trader_stats_score_input_value(jsonb, text) OWNER TO postgres;
ALTER FUNCTION arena.trader_stats_score_input_evidence() OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.trader_stats_score_input_value(jsonb, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.trader_stats_score_input_evidence()
  FROM PUBLIC, anon, authenticated, service_role;

-- No OR REPLACE for triggers; the preflight proves this runs once.
CREATE TRIGGER trader_stats_score_input_evidence
  BEFORE INSERT OR UPDATE ON arena.trader_stats
  FOR EACH ROW EXECUTE FUNCTION arena.trader_stats_score_input_evidence();

NOTIFY pgrst, 'reload schema';

COMMIT;
