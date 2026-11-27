-- Migration: clear_gate_cfd_unverified_mdd
-- Description: archive and clear the max drawdown stored for gate_cfd
--   traders in arena.trader_stats.
--
-- Why: what Gate's copy_tradfi max_drawdown means is not established. The CFD
--   board fixture reports 0 for a +38.6%, a -27.8% and a +47.8% window alike,
--   and in production on 2026-11-25 a 7D window that lost 74.9% carried 0
--   while 9% of gate_cfd rows had a drawdown smaller than their loss. #571
--   stops the gate_cfd board and profile parsers from emitting mdd, but the
--   board write keeps a stored value (mdd = COALESCE(EXCLUDED.mdd, stored)),
--   so the values written before stay in trader_stats and the trader page's
--   legacy path (lib/data/serving/legacy-adapter.ts reads stats.mdd) keeps
--   showing them. The public leaderboard is not affected: publication uses a
--   drawdown only when the same board write attested it.
--
-- What changes:
--   * arena.trader_stats_cleared_mdd: an append-only, owner-only archive of
--     every value cleared (trader, timeframe, the row's as_of, the value, when
--     and why).
--   * Every non-NULL trader_stats.mdd of a gate_cfd trader is copied into the
--     archive and set to NULL. Nothing else in the row changes; the two
--     attestation triggers drop 'mdd' from the row's attested metrics, which
--     is what a NULL value means.
--   * Preflight reports the count; postflight asserts that the rows cleared
--     equal the rows archived in this run and that no gate_cfd mdd remains.
--     A replay archives and clears nothing.
--
-- Order: apply only after the collection worker carrying #571 is deployed
--   and no worker without it is running. A worker without #571 writes the
--   CFD board's max_drawdown again (pct("0") is 0, not NULL) and its profile
--   write sets mdd = EXCLUDED.mdd; with #571 the board write keeps the
--   cleared NULL and the profile write writes NULL. After the cleanup the
--   board write's as_of no longer freezes on these rows either (it holds
--   as_of at LEAST(old, new) only while a stored metric is non-NULL and the
--   new one is NULL).
--
-- POSTDEPLOY (after the #571 worker release). Touches no table
-- 20261111192134 guards.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
DECLARE
  v_sources integer;
  v_candidates bigint;
BEGIN
  IF pg_catalog.to_regclass('arena.trader_stats') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL THEN
    RAISE EXCEPTION 'arena.trader_stats, arena.traders and arena.sources are required';
  END IF;

  SELECT pg_catalog.count(*) INTO v_sources
    FROM arena.sources AS source_row
   WHERE source_row.slug = 'gate_cfd';
  IF v_sources <> 1 THEN
    RAISE EXCEPTION 'expected exactly one gate_cfd source, found %', v_sources;
  END IF;

  SELECT pg_catalog.count(*) INTO v_candidates
    FROM arena.trader_stats AS stats
    JOIN arena.traders AS trader ON trader.id = stats.trader_id
    JOIN arena.sources AS source_row ON source_row.id = trader.source_id
   WHERE source_row.slug = 'gate_cfd'
     AND stats.mdd IS NOT NULL;
  RAISE NOTICE 'gate_cfd trader_stats rows with a stored mdd: %', v_candidates;
END
$preflight$;

CREATE TABLE IF NOT EXISTS arena.trader_stats_cleared_mdd (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trader_id bigint NOT NULL,
  timeframe smallint NOT NULL,
  stats_as_of timestamptz NOT NULL,
  cleared_mdd numeric NOT NULL,
  cleared_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  reason text NOT NULL
    CHECK (reason ~ '^[a-z0-9]+(_[a-z0-9]+)*$' AND pg_catalog.char_length(reason) <= 64)
);

CREATE OR REPLACE FUNCTION arena.reject_trader_stats_cleared_mdd_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'arena.trader_stats_cleared_mdd is append-only'
    USING ERRCODE = '42501';
END
$function$;

CREATE OR REPLACE TRIGGER trader_stats_cleared_mdd_append_only
  BEFORE UPDATE OR DELETE ON arena.trader_stats_cleared_mdd
  FOR EACH ROW EXECUTE FUNCTION arena.reject_trader_stats_cleared_mdd_mutation();

ALTER TABLE arena.trader_stats_cleared_mdd OWNER TO postgres;
ALTER FUNCTION arena.reject_trader_stats_cleared_mdd_mutation() OWNER TO postgres;
ALTER TABLE arena.trader_stats_cleared_mdd ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE arena.trader_stats_cleared_mdd
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.reject_trader_stats_cleared_mdd_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE arena.trader_stats_cleared_mdd IS
  'Append-only archive of max drawdown values cleared from arena.trader_stats, with the row as_of and the reason. Owner-only.';

-- Archive and clear in one statement so the two sets are the same rows.
DO $cleanup$
DECLARE
  v_cleared bigint;
  v_archived bigint;
  v_remaining bigint;
BEGIN
  WITH candidate AS (
    SELECT stats.trader_id, stats.timeframe, stats.mdd AS cleared_mdd
      FROM arena.trader_stats AS stats
      JOIN arena.traders AS trader ON trader.id = stats.trader_id
      JOIN arena.sources AS source_row ON source_row.id = trader.source_id
     WHERE source_row.slug = 'gate_cfd'
       AND stats.mdd IS NOT NULL
       FOR UPDATE OF stats
  ),
  cleared AS (
    UPDATE arena.trader_stats AS stats
       SET mdd = NULL
      FROM candidate
     WHERE stats.trader_id = candidate.trader_id
       AND stats.timeframe = candidate.timeframe
    RETURNING stats.trader_id, stats.timeframe, stats.as_of, candidate.cleared_mdd
  ),
  archived AS (
    INSERT INTO arena.trader_stats_cleared_mdd
      (trader_id, timeframe, stats_as_of, cleared_mdd, reason)
    SELECT cleared.trader_id, cleared.timeframe, cleared.as_of, cleared.cleared_mdd,
           'gate_cfd_max_drawdown_unverified'
      FROM cleared
    RETURNING id
  )
  SELECT (SELECT pg_catalog.count(*) FROM cleared),
         (SELECT pg_catalog.count(*) FROM archived)
    INTO STRICT v_cleared, v_archived;

  IF v_cleared IS DISTINCT FROM v_archived THEN
    RAISE EXCEPTION 'cleared % rows but archived %', v_cleared, v_archived;
  END IF;

  SELECT pg_catalog.count(*) INTO v_remaining
    FROM arena.trader_stats AS stats
    JOIN arena.traders AS trader ON trader.id = stats.trader_id
    JOIN arena.sources AS source_row ON source_row.id = trader.source_id
   WHERE source_row.slug = 'gate_cfd'
     AND stats.mdd IS NOT NULL;
  IF v_remaining <> 0 THEN
    RAISE EXCEPTION '% gate_cfd trader_stats rows still hold an mdd', v_remaining;
  END IF;

  RAISE NOTICE 'gate_cfd mdd cleanup: cleared % rows, archived %', v_cleared, v_archived;
END
$cleanup$;

COMMIT;
