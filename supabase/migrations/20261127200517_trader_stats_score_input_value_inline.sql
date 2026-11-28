-- Migration: 20261127200517_trader_stats_score_input_value_inline.sql
-- Description: arena.trader_stats_score_input_value can be inlined into the
--   two arena.trader_stats evidence triggers instead of being called per row.
--
-- Why: on 2026-11-27 the bybit_mt5 7D board (32,7xx rows) failed to publish
--   twice: the Tier-A publication transaction ran into its write deadline
--   (write_deadline_exceeded at 119 s, then a query read timeout). Normally it
--   takes 78-95 s against a deadline of 80-120 s. Its slowest statement is the
--   headline stats upsert into arena.trader_stats (up to 58.8 s in
--   pg_stat_statements). Both row triggers of that table
--   (trader_stats_score_input_evidence, trader_stats_profile_evidence) call
--   this function once or twice per metric per row. It carries
--   SET search_path, so PostgreSQL cannot inline it: every call is a real
--   function call with a configuration switch. On PostgreSQL 17, upserting
--   32,700 existing rows with the trigger takes 1.78 s; with this function
--   inlined it takes 1.12 s; with no trigger 0.24 s. This is one part of
--   the fix; the trust-evidence writes in the same transaction are separate
--   work.
--
-- What changes: only the definition of
--   arena.trader_stats_score_input_value(jsonb, text). The expression is the
--   20261116205144 expression, unchanged, written as a SQL-standard body
--   (RETURN ...). Such a body is parsed when the function is created, with
--   this migration's search_path (pg_catalog, pg_temp), so its operators stay
--   bound to pg_catalog without a SET clause and it does not depend on any
--   caller's search_path. It stays LANGUAGE sql, IMMUTABLE (every operator in
--   it is immutable), not STRICT, owned by postgres, and keeps its ACL: no
--   role but the owner holds a privilege on it. Its only callers are the two
--   trigger functions, which are SECURITY DEFINER and owned by postgres, so
--   they may execute it, which inlining requires. It reads no table.
--   Signature, argument names, return type and every result are unchanged:
--   the PostgreSQL 17 proof compares old and new over a matrix of rows and
--   metrics and replays the trigger scenarios.
--
-- Safety: refuses unless the function is the 20261116205144 definition
--   (body sha256 a5d13578...7429, SET search_path = pg_catalog, pg_temp) or this
--   migration's own (replay, compared as deparsed by the same server). Any
--   other edit is refused, not overwritten. No trigger, constraint or table
--   changes, and nothing the worker startup gate pins
--   (worker/src/ingest/attempt-bound-capture-readiness.ts).
--
-- Rollback: scripts/maintenance/rollbacks/20261127200517_trader_stats_score_input_value_inline.rollback.sql
--
-- POSTDEPLOY. No application or worker release depends on it.
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

-- This migration's definition, created in pg_temp so the server deparses it
-- for the replay comparison below.
CREATE OR REPLACE FUNCTION pg_temp.expected_score_input_value_20261127200517(
  p_row jsonb,
  p_metric text
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
RETURN NULLIF(
  CASE
    WHEN p_metric IN ('sortino', 'calmar', 'volatility')
      THEN p_row->'extras'->p_metric
    ELSE p_row->p_metric
  END,
  'null'::jsonb
);

DO $preflight$
DECLARE
  v_fn regprocedure :=
    pg_catalog.to_regprocedure('arena.trader_stats_score_input_value(jsonb,text)');
  v_row record;
  v_is_original boolean;
  v_is_replay boolean;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'arena.trader_stats_score_input_value(jsonb, text) is missing';
  END IF;

  SELECT p.prosrc, p.proconfig, p.prosqlbody IS NOT NULL AS standard_body,
         pg_catalog.pg_get_userbyid(p.proowner) AS owner, p.provolatile,
         p.prosecdef, p.proisstrict, p.prorettype::regtype::text AS rettype,
         l.lanname, p.proargnames, p.proacl
    INTO v_row
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_language AS l ON l.oid = p.prolang
   WHERE p.oid = v_fn;

  IF v_row.owner <> 'postgres'
     OR v_row.lanname <> 'sql'
     OR v_row.provolatile <> 'i'
     OR v_row.prosecdef
     OR v_row.proisstrict
     OR v_row.rettype <> 'jsonb'
     OR v_row.proargnames IS DISTINCT FROM ARRAY['p_row', 'p_metric']::text[] THEN
    RAISE EXCEPTION 'arena.trader_stats_score_input_value has unexpected attributes; refusing';
  END IF;

  v_is_original :=
    NOT v_row.standard_body
    AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_row.prosrc, 'UTF8')), 'hex')
        = 'a5d13578432570afcad4ec763326eb0bcf59d505c907526ccf841bc91b347429'
    AND v_row.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[];

  v_is_replay :=
    v_row.standard_body
    AND v_row.proconfig IS NULL
    AND pg_catalog.pg_get_function_sqlbody(v_fn)
        = pg_catalog.pg_get_function_sqlbody(
            'pg_temp.expected_score_input_value_20261127200517(jsonb,text)'::regprocedure
          );

  IF NOT (v_is_original OR v_is_replay) THEN
    RAISE EXCEPTION 'arena.trader_stats_score_input_value is neither the 20261116205144 definition nor this migration''s; refusing';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION arena.trader_stats_score_input_value(
  p_row jsonb,
  p_metric text
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
RETURN NULLIF(
  CASE
    WHEN p_metric IN ('sortino', 'calmar', 'volatility')
      THEN p_row->'extras'->p_metric
    ELSE p_row->p_metric
  END,
  'null'::jsonb
);

COMMENT ON FUNCTION arena.trader_stats_score_input_value(jsonb, text) IS
  'One score-input metric of a trader_stats row, as jsonb (SQL NULL when absent or JSON null). '
  'SQL-standard body without SET so the trader_stats evidence triggers inline it (20261127200517); '
  'it reads no table. Keep it a single expression with no SET, STRICT or table reference, or it '
  'stops being inlined.';

DO $postflight$
DECLARE
  v_fn regprocedure :=
    pg_catalog.to_regprocedure('arena.trader_stats_score_input_value(jsonb,text)');
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS p
     WHERE p.oid = v_fn
       AND p.prosqlbody IS NOT NULL
       AND p.proconfig IS NULL
       AND p.provolatile = 'i'
       AND NOT p.prosecdef
       AND NOT p.proisstrict
       AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
       AND pg_catalog.pg_get_function_sqlbody(p.oid)
           = pg_catalog.pg_get_function_sqlbody(
               'pg_temp.expected_score_input_value_20261127200517(jsonb,text)'::regprocedure
             )
  ) THEN
    RAISE EXCEPTION 'arena.trader_stats_score_input_value is not the expected definition after replace';
  END IF;

  -- No role but the owner may hold a privilege on it (20261116205144).
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS p,
           LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) AS acl
     WHERE p.oid = v_fn
       AND acl.grantee <> p.proowner
  ) THEN
    RAISE EXCEPTION 'arena.trader_stats_score_input_value grants a privilege to a role other than its owner';
  END IF;
END
$postflight$;

COMMIT;
