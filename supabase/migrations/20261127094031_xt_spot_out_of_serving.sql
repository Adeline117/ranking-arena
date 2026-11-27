-- Migration: xt_spot_out_of_serving
-- Description: take xt_spot out of collection and serving (status inactive,
--   serving_mode shadow). Reversible: setting both back restores it.
--
-- Why: Tier-A publication requires attempt-bound capture evidence (#482,
--   20261115160917), and xt_spot was deliberately left unregistered there:
--   XT's spot board (leader-list-v2) does not page, returns the whole board
--   in one response, and pads it with all-zero placeholder leaders that the
--   parser drops by design (spec 5.6). On 2026-11-15 198 of 201 rows were
--   placeholders, so neither completeness mode (accepted rows = reported
--   total, or exhaustion) can hold, and the adapter refuses an attempt-bound
--   capture for the spot board. The source has not published since; every
--   Tier-A run fails before a session with "xt_spot v3 capture contract is
--   not exactly registered". A registration cannot fix it: the capture would
--   fail its own completeness proof.
--
--   The scheduler selects sources by status = 'active' only
--   (lib/ingest/sources.ts getActiveSources), so serving_mode alone would not
--   stop the failing runs. status = 'inactive' removes the tiera / tierb /
--   tierd schedules at the next reconcile; serving_mode = 'shadow' removes it
--   from every serving read (public.arena_serving_sources and the worker's
--   Redis serving_sources mirror).
--
-- Visible effects:
--   * public.arena_publication_unsupported_sources() no longer lists xt_spot
--     (one row per season fewer), so /api/health stops reporting it as
--     unsupported. public.arena_freshness_expected_sources() is unchanged:
--     xt_spot was never in it (no capture contract registration).
--   * the serving_sources mirror loses the name xt_spot (no legacy_platform,
--     no other source shares the name): 41 -> 40 names in production.
--   * no public leaderboard row and no trader page changes: xt_spot has had
--     no published rank since 2026-11-15.
--
-- Guards on arena.sources: sources_reject_guarded_tier_a_transition refuses a
--   status change only inside a transaction that holds a Tier-A execution
--   write guard for the source; this migration holds none.
--   sources_reject_ambiguous_serving_name lets a row that is not active and
--   serving through. No trigger or constraint changes, so the worker startup
--   gate's catalog fingerprint is unchanged.
--
-- POSTDEPLOY. No release depends on it. It touches no table 20261111192134
-- guards.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
DECLARE
  v_rows integer;
  v_status text;
  v_serving_mode text;
BEGIN
  SELECT pg_catalog.count(*) INTO v_rows FROM arena.sources WHERE slug = 'xt_spot';
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'expected exactly one xt_spot source, found %', v_rows;
  END IF;

  -- Locked until COMMIT: the state checked here is the state updated below.
  SELECT source_row.status, source_row.serving_mode
    INTO STRICT v_status, v_serving_mode
    FROM arena.sources AS source_row
   WHERE source_row.slug = 'xt_spot'
     FOR UPDATE;

  -- active + serving is the state this migration was written for; inactive +
  -- shadow is its own result (a replay). Anything else was changed by someone
  -- else and is not overwritten.
  IF NOT (
       (v_status = 'active' AND v_serving_mode = 'serving')
       OR (v_status = 'inactive' AND v_serving_mode = 'shadow')
     ) THEN
    RAISE EXCEPTION 'xt_spot is status % / serving_mode %, not active/serving; refusing',
      v_status, v_serving_mode;
  END IF;
END
$preflight$;

DO $apply$
DECLARE
  v_updated integer;
  v_status text;
  v_serving_mode text;
BEGIN
  UPDATE arena.sources
     SET status = 'inactive',
         serving_mode = 'shadow'
   WHERE slug = 'xt_spot'
     AND status = 'active'
     AND serving_mode = 'serving';
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  SELECT source_row.status, source_row.serving_mode
    INTO STRICT v_status, v_serving_mode
    FROM arena.sources AS source_row
   WHERE source_row.slug = 'xt_spot';
  IF v_status IS DISTINCT FROM 'inactive' OR v_serving_mode IS DISTINCT FROM 'shadow' THEN
    RAISE EXCEPTION 'xt_spot is status % / serving_mode % after the update',
      v_status, v_serving_mode;
  END IF;

  RAISE NOTICE 'xt_spot out of serving: % row(s) updated', v_updated;
END
$apply$;

COMMIT;
