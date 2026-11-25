-- Migration: hero_stats_exclude_idle_window
-- Description: public.get_hero_stats() counts only rows with idle_window = false,
--   and its statement_timeout goes from 2 to 5 seconds.
--
-- Why: under the ROI + PnL row rule (20261122201611) the public 90D board also
--   carries idle-window rows: accounts with no ROI and no PnL in the period,
--   ranked last at score 0.01 (public_ranked_leaderboard.idle_window,
--   20261123021904). More than half of a full board is of this kind. Counting
--   them made two numbers wrong:
--     - the homepage "N ranked traders / M boards" would jump from about 4,000
--       to about 9,000 while the list shows about 4,000 with performance;
--     - the profile badge "beats X% of traders" divides a trader's rank by
--       this count, so almost every trader with performance would be told it
--       beats most of the field.
--   Both now use the rows that have performance. Idle rows are ranked after
--   every scored row, so a scored trader's rank is already its rank among
--   scored traders; an idle row's rank is greater than the new count and the
--   badge shows nothing for it.
--
-- What changes, on public.get_hero_stats() only:
--   1. the body: one more predicate, AND NOT ranked.idle_window (the column is
--      boolean and never NULL). A source whose served rows are all idle is no
--      longer counted as a board.
--   2. the function's statement_timeout: 2s -> 5s. Measured read-only on
--      production (2026-11-25): this query takes 1,368 ms over 5,419 served
--      rows with every buffer cached, because the view evaluates the row
--      policy once per row. After the roi_pnl switch the board is about 8,400
--      rows, which does not fit in 2 seconds. 5 seconds is a stopgap; the
--      follow-up is to read per-source non-idle row counts recorded at
--      publication instead of evaluating every row (separate change).
--   Signature, return columns, LANGUAGE sql, STABLE, SECURITY DEFINER,
--   search_path, owner, ACL and comment are unchanged. No table, view, index
--   or other function is touched.
--
--   While the scoring worker still publishes with the four-metric rule no row
--   is idle, so the function returns exactly what it returned before.
--
-- Safety: refuses unless the function is exactly the current one (the
--   20261114103025 body, sha256 9462c36f...f944, with search_path and
--   statement_timeout=2s; confirmed read-only on production 2026-11-25) or
--   exactly this migration's own (its body with statement_timeout=5s, replay),
--   with the expected owner and security, and unless the view already has the
--   idle_window column. A mix of the two (one body with the other timeout) is
--   refused. The function carries no custom-parameter SET (the Supabase
--   postgres role is not a superuser); only the built-in search_path and
--   statement_timeout. Nothing is dropped.
--
-- POSTDEPLOY, after 20261123021904 (it reads the column that migration adds).
--   The website does not depend on it either way: the return shape is the
--   same. It must be applied BEFORE the scoring worker is switched to roi_pnl,
--   otherwise the two numbers above are wrong from the first roi_pnl
--   publication until it is applied (and for up to an hour of cache after).
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

-- One block, so the state read before the replace is still in hand after it:
--   1. preflight  - exact identity of the object being replaced
--   2. replace    - CREATE OR REPLACE with the reviewed body
--   3. postflight - the body and configuration are the reviewed ones and
--                   nothing else moved
DO $migration$
DECLARE
  v_before record;
  v_after record;
  v_owner pg_catalog.name;
  v_language pg_catalog.name;
BEGIN
  -- 1. Preflight.
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
    pg_catalog.pg_get_function_result(procedure_row.oid) AS result_type,
    procedure_row.proconfig,
    procedure_row.proacl::pg_catalog.text AS proacl,
    pg_catalog.obj_description(procedure_row.oid, 'pg_proc') AS description,
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')),
      'hex'
    ) AS body_sha256
  INTO v_before
  FROM pg_catalog.pg_proc AS procedure_row
  WHERE procedure_row.oid = pg_catalog.to_regprocedure('public.get_hero_stats()');
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'hero_stats_exclude_idle_window: public.get_hero_stats() does not exist';
  END IF;

  IF v_before.body_sha256 NOT IN (
    -- current body (20261114103025_hero_stats_sealed_public_cohort)
    '9462c36f5e983078e8e25479aa8ad7235a448d428f7abeaebaa2ab3bfcaaf944',
    -- this migration's body (replay)
    '9cfaca2859c780d4ae0b2c886a4f1c0f5cf48accb5341ff3308710a132528b4b'
  ) THEN
    RAISE EXCEPTION
      'hero_stats_exclude_idle_window: unexpected body of public.get_hero_stats() (sha256 %); refusing to replace an unreviewed definition',
      v_before.body_sha256;
  END IF;

  -- Each accepted body goes with exactly one configuration: the current body
  -- with the 2 second timeout, this migration's body with the 5 second one.
  IF v_before.proconfig IS DISTINCT FROM (
    CASE v_before.body_sha256
      WHEN '9462c36f5e983078e8e25479aa8ad7235a448d428f7abeaebaa2ab3bfcaaf944'
        THEN ARRAY['search_path=pg_catalog, pg_temp', 'statement_timeout=2s']
      ELSE ARRAY['search_path=pg_catalog, pg_temp', 'statement_timeout=5s']
    END
  )::pg_catalog.text[] THEN
    RAISE EXCEPTION
      'hero_stats_exclude_idle_window: public.get_hero_stats() has unexpected configuration (%) for its body; refusing to replace an unreviewed definition',
      v_before.proconfig;
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
     OR NOT v_before.prosecdef
     OR NOT v_before.proretset
     OR v_before.provolatile <> 's'
     OR v_before.result_type IS DISTINCT FROM
          'TABLE(exchange_count bigint, trader_count bigint)' THEN
    RAISE EXCEPTION
      'hero_stats_exclude_idle_window: public.get_hero_stats() has unexpected attributes (owner %, language %, kind %, security definer %, volatility %, result %)',
      v_owner, v_language, v_before.prokind, v_before.prosecdef,
      v_before.provolatile, v_before.result_type;
  END IF;

  -- The body below filters on a column 20261123021904 adds to the view.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = pg_catalog.to_regclass('public.public_ranked_leaderboard')
      AND attribute.attname = 'idle_window'
      AND attribute.atttypid = 'pg_catalog.bool'::pg_catalog.regtype
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION
      'hero_stats_exclude_idle_window: public.public_ranked_leaderboard has no boolean idle_window column; apply 20261123021904 first';
  END IF;

  -- 2. Replace the body and the timeout. The rest of the declaration is the
  --    existing one, restated because CREATE OR REPLACE needs it.
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.get_hero_stats()
RETURNS TABLE(exchange_count bigint, trader_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '5s'
AS $function$
  SELECT pg_catalog.count(DISTINCT ranked.source), pg_catalog.count(*)
  FROM public.public_ranked_leaderboard AS ranked
  WHERE ranked.season_id = '90D'
    AND NOT ranked.idle_window;
$function$;
$ddl$;

  -- 3. Postflight.
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
    pg_catalog.pg_get_function_result(procedure_row.oid) AS result_type,
    procedure_row.proconfig,
    procedure_row.proacl::pg_catalog.text AS proacl,
    pg_catalog.obj_description(procedure_row.oid, 'pg_proc') AS description,
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(procedure_row.prosrc, 'UTF8')),
      'hex'
    ) AS body_sha256
  INTO STRICT v_after
  FROM pg_catalog.pg_proc AS procedure_row
  WHERE procedure_row.oid = pg_catalog.to_regprocedure('public.get_hero_stats()');

  IF v_after.body_sha256 <> '9cfaca2859c780d4ae0b2c886a4f1c0f5cf48accb5341ff3308710a132528b4b' THEN
    RAISE EXCEPTION
      'hero_stats_exclude_idle_window: installed body sha256 % is not the reviewed body',
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
     OR v_after.result_type IS DISTINCT FROM v_before.result_type
     OR v_after.proacl IS DISTINCT FROM v_before.proacl
     OR v_after.description IS DISTINCT FROM v_before.description THEN
    RAISE EXCEPTION
      'hero_stats_exclude_idle_window: an attribute other than the body and the timeout changed (owner, security, volatility, ACL or comment)';
  END IF;

  -- The configuration is exactly search_path and the 5 second timeout: two
  -- built-in parameters, and no custom (dotted) one, which a non-superuser
  -- owner could not attach anyway.
  IF v_after.proconfig IS DISTINCT FROM
       ARRAY['search_path=pg_catalog, pg_temp', 'statement_timeout=5s']::pg_catalog.text[] THEN
    RAISE EXCEPTION
      'hero_stats_exclude_idle_window: installed configuration % is not search_path plus statement_timeout=5s',
      v_after.proconfig;
  END IF;
END
$migration$;

COMMIT;
