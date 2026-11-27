-- Migration: 20261127103322_score_bundle_columnar_rows.sql
-- Description: public.arena_score_inputs_publish_bundle_columnar_json returns
--   the score bundle with its score rows as column arrays instead of objects.
--
-- Why: the 90D bundle is 7.5 MB, 7.51 MB of it the 11,682 score rows, each an
--   object that repeats the same 21 key names. The publisher reads it inside a
--   30 s deadline (25.1 s on 2026-11-27) and the per-source row cap is about
--   to be lifted (several times as many rows). Sending the key names once
--   removes roughly 40% of the bytes the publisher receives and decodes.
--
-- What it is: a wrapper. It calls the unchanged
--   public.arena_score_inputs_publish_bundle_json once (one statement
--   snapshot, the same evidence) and returns
--     { scoreRowColumns: [21 names], scoreRowValues: [[21 values] per row],
--       physicalBoards: unchanged }
--   with the rows in the original order. Values are the original JSON values
--   (jsonb -> key), so decoding a row back gives exactly the original object;
--   the score-input digest (arena-score-input-set@1) is unchanged. A row whose
--   key set is not exactly the 21 columns raises instead of being reshaped, so
--   a later change to the row shape cannot be dropped silently.
--   arena.publication_score_rows_json and the object-form bundle are not
--   changed; audits that re-read them keep working.
--
-- Rollout: additive. Apply before the scoring worker release that reads this
--   function (that worker calls only this function). Applying it earlier
--   changes nothing for the running worker. It touches no table
--   20261111192134 guards and adds no trigger or constraint.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'
     ) IS NULL THEN
    RAISE EXCEPTION 'public.arena_score_inputs_publish_bundle_json(text, int, int) is missing';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.arena_score_inputs_publish_bundle_columnar_json(
  p_window text,
  p_per_platform_limit integer DEFAULT 1000,
  p_max_age_hours integer DEFAULT 48
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  -- The score row shape, in the order arena.publication_score_rows_json builds it.
  c_columns constant pg_catalog.text[] := ARRAY[
    'platform', 'market_type', 'trader_key', 'board_rank', 'roi_pct', 'pnl_usd',
    'win_rate', 'max_drawdown', 'copiers', 'trades_count', 'sharpe_ratio',
    'sortino_ratio', 'calmar_ratio', 'volatility_pct', 'unevidenced_metrics',
    'trader_kind', 'handle', 'avatar_url', 'currency', 'as_of', 'board_as_of'
  ]::pg_catalog.text[];
  v_bundle pg_catalog.jsonb;
  v_rows pg_catalog.jsonb;
  v_mismatched bigint;
  v_values pg_catalog.jsonb;
BEGIN
  -- The wrapped function validates the arguments.
  v_bundle := public.arena_score_inputs_publish_bundle_json(
    p_window, p_per_platform_limit, p_max_age_hours
  );
  v_rows := v_bundle->'scoreRows';
  IF v_rows IS NULL OR pg_catalog.jsonb_typeof(v_rows) <> 'array' THEN
    RAISE EXCEPTION 'score bundle has no scoreRows array'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT pg_catalog.count(*)
    INTO v_mismatched
    FROM pg_catalog.jsonb_array_elements(v_rows) AS score_row(value)
   WHERE pg_catalog.jsonb_typeof(score_row.value) <> 'object'
      OR (SELECT pg_catalog.array_agg(key ORDER BY key)
            FROM pg_catalog.jsonb_object_keys(score_row.value) AS key)
         IS DISTINCT FROM
         (SELECT pg_catalog.array_agg(name ORDER BY name)
            FROM pg_catalog.unnest(c_columns) AS name);
  IF v_mismatched > 0 THEN
    RAISE EXCEPTION '% score row(s) do not have exactly the % columnar keys',
      v_mismatched, pg_catalog.cardinality(c_columns)
      USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(
           pg_catalog.jsonb_agg(
             (SELECT pg_catalog.jsonb_agg(score_row.value->name ORDER BY position)
                FROM pg_catalog.unnest(c_columns) WITH ORDINALITY AS columns(name, position))
             ORDER BY row_position
           ),
           '[]'::pg_catalog.jsonb
         )
    INTO v_values
    FROM pg_catalog.jsonb_array_elements(v_rows) WITH ORDINALITY AS score_row(value, row_position);

  RETURN pg_catalog.jsonb_build_object(
    'scoreRowColumns', pg_catalog.to_jsonb(c_columns),
    'scoreRowValues', v_values,
    'physicalBoards', v_bundle->'physicalBoards'
  );
END;
$function$;

ALTER FUNCTION public.arena_score_inputs_publish_bundle_columnar_json(text, int, int)
  OWNER TO postgres;
REVOKE ALL
  ON FUNCTION public.arena_score_inputs_publish_bundle_columnar_json(text, int, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
  ON FUNCTION public.arena_score_inputs_publish_bundle_columnar_json(text, int, int)
  TO service_role;

COMMIT;
