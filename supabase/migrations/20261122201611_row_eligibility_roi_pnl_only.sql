-- Migration: row_eligibility_roi_pnl_only
-- Description: the public rank row policy requires ROI and PnL only.
--
-- Why: owner decision 2026-11-22 ("everyone is ranked"). A row is publicly
--   rankable when it has ROI and PnL. Win rate and max drawdown are shown and
--   range-checked when present and left empty when absent. Until now the row
--   policy also required both to be present and score_completeness = 'full',
--   so every trader of a source that does not publish one of them, and every
--   trader whose value lacks board evidence, was kept off the board.
--
-- What changes: ONLY the body of
--   arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks, timestamptz).
--   - win_rate:      NULL, or 0 <= win_rate <= 100        (was: NOT NULL and in range)
--   - max_drawdown:  NULL, or 0 <= max_drawdown < 100     (was: NOT NULL and in range)
--   - score_completeness must say exactly which of the two are present:
--       both -> 'full', one -> 'partial', none -> 'minimal'   (was: = 'full')
--     Only NULL is "absent"; 0 is a value.
--   Unchanged: identity, metrics_estimated = false, is_outlier IS NOT TRUE,
--   0 < arena_score <= 100, ROI and PnL NOT NULL and in range, the 48 hour /
--   5 minute computed_at window. Signature, return type, LANGUAGE sql,
--   IMMUTABLE, PARALLEL SAFE, SECURITY INVOKER, search_path, owner, ACL and
--   comment are unchanged. No table, view, index or other function is touched:
--   rerank, seal, proofs, the public view predicate and the serving authority
--   call this function by reference and follow it.
--
--   Every row the previous policy accepted is still accepted (a 'full' row
--   with both metrics in range), so the currently served cohorts stay valid
--   and an older scoring worker keeps publishing unchanged.
--
-- Safety: refuses to run unless the installed body is the current production
--   body (20261111140053, sha256 aa87e834...f0df) or this migration's own body
--   (replay). The function carries no custom-parameter SET (the Supabase
--   postgres role is not a superuser).
--
-- POSTDEPLOY. Order: this migration -> website -> scoring worker. The scoring
--   worker must not publish 'partial'/'minimal' rows before this is applied:
--   seal rejects them under the previous body and the season rolls back.
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

-- 1. Preflight: exact identity of the object being replaced, snapshotted so
--    the postflight can prove nothing but the body moved.
CREATE TEMPORARY TABLE row_eligibility_roi_pnl_only_before ON COMMIT DROP AS
SELECT
  procedure_row.oid,
  procedure_row.proowner,
  procedure_row.prolang,
  procedure_row.prokind,
  procedure_row.prosecdef,
  procedure_row.proleakproof,
  procedure_row.proisstrict,
  procedure_row.proretset,
  procedure_row.provolatile,
  procedure_row.proparallel,
  procedure_row.prorettype,
  procedure_row.proargtypes::pg_catalog.text AS proargtypes,
  procedure_row.proconfig,
  procedure_row.proacl::pg_catalog.text AS proacl,
  pg_catalog.obj_description(procedure_row.oid, 'pg_proc') AS description,
  pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')),
    'hex'
  ) AS body_sha256
FROM pg_catalog.pg_proc AS procedure_row
WHERE procedure_row.oid = pg_catalog.to_regprocedure(
  'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamp with time zone)'
);

DO $preflight$
DECLARE
  v_before record;
  v_owner pg_catalog.name;
  v_language pg_catalog.name;
BEGIN
  SELECT * INTO v_before FROM pg_temp.row_eligibility_roi_pnl_only_before;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'row_eligibility_roi_pnl_only: arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks, timestamptz) does not exist';
  END IF;

  IF v_before.body_sha256 NOT IN (
    -- current production body (20261111140053, byte-for-byte 20260724235000)
    'aa87e8343569cccdeeea84bee66fbf9cd20b8b75e39b1a6d63e78f110e4bf0df',
    -- this migration's body (replay)
    '1a9fd63c3a986c44bc8cc39a25d4e1962b2f09b34c89cabdc63eba2567601429'
  ) THEN
    RAISE EXCEPTION
      'row_eligibility_roi_pnl_only: unexpected body of arena.leaderboard_rank_row_is_public_eligible (sha256 %); refusing to replace an unreviewed definition',
      v_before.body_sha256;
  END IF;

  SELECT role_row.rolname INTO v_owner
  FROM pg_catalog.pg_roles AS role_row
  WHERE role_row.oid = v_before.proowner;
  SELECT language_row.lanname INTO v_language
  FROM pg_catalog.pg_language AS language_row
  WHERE language_row.oid = v_before.prolang;

  IF v_owner IS DISTINCT FROM 'postgres'
     OR v_language IS DISTINCT FROM 'sql'
     OR v_before.prokind <> 'f'
     OR v_before.prosecdef
     OR v_before.proretset
     OR v_before.provolatile <> 'i'
     OR v_before.proparallel <> 's'
     OR v_before.prorettype <> 'pg_catalog.bool'::pg_catalog.regtype
     OR v_before.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[] THEN
    RAISE EXCEPTION
      'row_eligibility_roi_pnl_only: arena.leaderboard_rank_row_is_public_eligible has unexpected attributes (owner %, language %, kind %, security definer %, volatility %, parallel %, config %)',
      v_owner, v_language, v_before.prokind, v_before.prosecdef,
      v_before.provolatile, v_before.proparallel, v_before.proconfig;
  END IF;

  -- No role other than the owner may hold a privilege on the policy function.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure_row.proacl,
        pg_catalog.acldefault('f', procedure_row.proowner)
      )
    ) AS privilege
    WHERE procedure_row.oid = v_before.oid
      AND privilege.grantee <> procedure_row.proowner
  ) THEN
    RAISE EXCEPTION
      'row_eligibility_roi_pnl_only: arena.leaderboard_rank_row_is_public_eligible is executable by a role other than its owner (acl %)',
      v_before.proacl;
  END IF;
END
$preflight$;

-- 2. Replace the body. Everything outside AS $function$ ... $function$ is the
--    existing declaration, restated because CREATE OR REPLACE requires it.
CREATE OR REPLACE FUNCTION arena.leaderboard_rank_row_is_public_eligible(
  p_rank public.leaderboard_ranks,
  p_observed_at timestamptz
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(
    (p_rank).source ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
    AND (p_rank).source = pg_catalog.lower(pg_catalog.btrim((p_rank).source))
    AND pg_catalog.btrim((p_rank).source_trader_id) <> ''
    AND (p_rank).source_trader_id = pg_catalog.btrim((p_rank).source_trader_id)
    AND (p_rank).score_completeness IS NOT DISTINCT FROM (
      CASE
        WHEN (p_rank).win_rate IS NOT NULL AND (p_rank).max_drawdown IS NOT NULL
          THEN 'full'
        WHEN (p_rank).win_rate IS NULL AND (p_rank).max_drawdown IS NULL
          THEN 'minimal'
        ELSE 'partial'
      END
    )
    AND (p_rank).metrics_estimated IS NOT DISTINCT FROM false
    AND (p_rank).is_outlier IS NOT TRUE
    AND (p_rank).arena_score IS NOT NULL
    AND (p_rank).arena_score > 0
    AND (p_rank).arena_score <= 100
    AND (p_rank).roi IS NOT NULL
    AND (p_rank).roi >= -10000
    AND (p_rank).roi <= 10000
    AND (p_rank).pnl IS NOT NULL
    AND (p_rank).pnl >= -100000000
    AND (p_rank).pnl <= 1000000000
    AND (
      (p_rank).win_rate IS NULL
      OR ((p_rank).win_rate >= 0 AND (p_rank).win_rate <= 100)
    )
    AND (
      (p_rank).max_drawdown IS NULL
      OR ((p_rank).max_drawdown >= 0 AND (p_rank).max_drawdown < 100)
    )
    AND (p_rank).computed_at IS NOT NULL
    AND (p_rank).computed_at >= p_observed_at - interval '48 hours'
    AND (p_rank).computed_at <= p_observed_at + interval '5 minutes',
    false
  );
$function$;

-- 3. Postflight: the body is exactly the reviewed one and nothing else moved.
DO $postflight$
DECLARE
  v_before record;
  v_after record;
BEGIN
  SELECT * INTO STRICT v_before FROM pg_temp.row_eligibility_roi_pnl_only_before;

  SELECT
    procedure_row.oid,
    procedure_row.proowner,
    procedure_row.prolang,
    procedure_row.prokind,
    procedure_row.prosecdef,
    procedure_row.proleakproof,
    procedure_row.proisstrict,
    procedure_row.proretset,
    procedure_row.provolatile,
    procedure_row.proparallel,
    procedure_row.prorettype,
    procedure_row.proargtypes::pg_catalog.text AS proargtypes,
    procedure_row.proconfig,
    procedure_row.proacl::pg_catalog.text AS proacl,
    pg_catalog.obj_description(procedure_row.oid, 'pg_proc') AS description,
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')),
      'hex'
    ) AS body_sha256
  INTO STRICT v_after
  FROM pg_catalog.pg_proc AS procedure_row
  WHERE procedure_row.oid = pg_catalog.to_regprocedure(
    'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamp with time zone)'
  );

  IF v_after.body_sha256 <> '1a9fd63c3a986c44bc8cc39a25d4e1962b2f09b34c89cabdc63eba2567601429' THEN
    RAISE EXCEPTION
      'row_eligibility_roi_pnl_only: installed body sha256 % is not the reviewed body',
      v_after.body_sha256;
  END IF;

  IF v_after.oid IS DISTINCT FROM v_before.oid
     OR v_after.proowner IS DISTINCT FROM v_before.proowner
     OR v_after.prolang IS DISTINCT FROM v_before.prolang
     OR v_after.prokind IS DISTINCT FROM v_before.prokind
     OR v_after.prosecdef IS DISTINCT FROM v_before.prosecdef
     OR v_after.proleakproof IS DISTINCT FROM v_before.proleakproof
     OR v_after.proisstrict IS DISTINCT FROM v_before.proisstrict
     OR v_after.proretset IS DISTINCT FROM v_before.proretset
     OR v_after.provolatile IS DISTINCT FROM v_before.provolatile
     OR v_after.proparallel IS DISTINCT FROM v_before.proparallel
     OR v_after.prorettype IS DISTINCT FROM v_before.prorettype
     OR v_after.proargtypes IS DISTINCT FROM v_before.proargtypes
     OR v_after.proconfig IS DISTINCT FROM v_before.proconfig
     OR v_after.proacl IS DISTINCT FROM v_before.proacl
     OR v_after.description IS DISTINCT FROM v_before.description THEN
    RAISE EXCEPTION
      'row_eligibility_roi_pnl_only: an attribute other than the body changed (owner, security, volatility, config, ACL or comment)';
  END IF;
END
$postflight$;

COMMIT;
