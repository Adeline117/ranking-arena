-- Migration: public_ranked_leaderboard_window_flags
-- Description: public.public_ranked_leaderboard exposes two boolean flags the
--   scoring worker records in leaderboard_ranks.score_factors.
--
-- Why: under the ROI + PnL row rule (20261122201611) the worker marks two kinds
--   of rows in score_factors (jsonb):
--     idle_window        ROI 0 and PnL 0 in the window: not scored, ranked last
--     mdd_contradiction  a losing window reported a 0% max drawdown: the
--                        drawdown was refused and is written NULL
--   The website reads only the public view, which does not expose
--   score_factors, so the marks could not reach the UI. The release owner
--   decided the view carries them, so the frontend never re-derives the rule.
--
-- What changes: ONLY the column list of public.public_ranked_leaderboard, by
--   appending two columns at the end:
--     idle_window        boolean, never NULL, false unless score_factors
--                        carries the JSON boolean true under that key
--     mdd_contradiction  boolean, same
--   A NULL score_factors, a non-object value, a missing key, or a value that
--   is not the JSON boolean true (a string, a number, null) all give false;
--   nothing in score_factors can make the view raise.
--   The 35 existing columns, their order and types, the row set (FROM / JOIN /
--   WHERE), security_barrier = true, security_invoker = false, owner, ACL and
--   comment are unchanged. CREATE OR REPLACE VIEW appends columns in place;
--   nothing is dropped and no dependent object is recreated.
--
--   While the worker still publishes with the four-metric rule no row carries
--   either mark, so both columns are false on every row.
--
-- Safety: refuses unless the installed definition is the production one
--   (pg_get_viewdef digest e7a040df...d0a7, read-only export 2026-11-23) or
--   this migration's own (replay), with the expected owner and options.
--
-- POSTDEPLOY, after 20261122201611. No application or worker release depends
--   on it: a reader that does not select the new columns is unaffected.
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- pg_get_viewdef qualifies names relative to the search_path. The digests
-- below are taken with public visible and arena not, as in the export.
SET LOCAL search_path = public, pg_temp;

DO $migration$
DECLARE
  v_view pg_catalog.oid := pg_catalog.to_regclass('public.public_ranked_leaderboard');
  v_before record;
  v_after record;
  v_columns_before pg_catalog.text[];
  v_columns_after pg_catalog.text[];
BEGIN
  -- 1. Preflight: exact identity of the view being extended.
  IF v_view IS NULL THEN
    RAISE EXCEPTION
      'public_ranked_leaderboard_window_flags: public.public_ranked_leaderboard does not exist';
  END IF;

  SELECT
    class_row.relkind,
    pg_catalog.pg_get_userbyid(class_row.relowner) AS owner,
    class_row.reloptions,
    class_row.relacl::pg_catalog.text AS acl,
    pg_catalog.obj_description(class_row.oid, 'pg_class') AS description,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(pg_catalog.pg_get_viewdef(class_row.oid, true), 'UTF8')
      ),
      'hex'
    ) AS definition_sha256
  INTO STRICT v_before
  FROM pg_catalog.pg_class AS class_row
  WHERE class_row.oid = v_view;

  SELECT pg_catalog.array_agg(
           attribute.attname || ':' ||
             pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
           ORDER BY attribute.attnum
         )
  INTO v_columns_before
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = v_view
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF v_before.relkind <> 'v'
     OR v_before.owner IS DISTINCT FROM 'postgres'
     OR v_before.reloptions IS DISTINCT FROM
          ARRAY['security_barrier=true', 'security_invoker=false']::pg_catalog.text[] THEN
    RAISE EXCEPTION
      'public_ranked_leaderboard_window_flags: public.public_ranked_leaderboard has unexpected attributes (kind %, owner %, options %)',
      v_before.relkind, v_before.owner, v_before.reloptions;
  END IF;

  IF v_before.definition_sha256 NOT IN (
    -- production definition (20260816184500), read-only export 2026-11-23
    'e7a040df0d437b2885ccad4f31108b260999f8421dd10c737466a756e3b6d0a7',
    -- this migration's definition (replay)
    '452bf1c819abc3b8b5f94405fc9168782dfca445cd6430e8474498b900641140'
  ) THEN
    RAISE EXCEPTION
      'public_ranked_leaderboard_window_flags: unexpected definition of public.public_ranked_leaderboard (sha256 %); refusing to replace an unreviewed view',
      v_before.definition_sha256;
  END IF;

  -- 2. Replace. The statement is the 20260816184500 definition with the two
  --    flag columns appended; everything else is restated unchanged.
  EXECUTE $ddl$
CREATE OR REPLACE VIEW public.public_ranked_leaderboard
WITH (security_barrier = true, security_invoker = false)
AS
WITH observed AS MATERIALIZED (
  SELECT pg_catalog.statement_timestamp() AS observed_at
),
serving_seasons AS MATERIALIZED (
  SELECT serving.season_id
  FROM observed
  CROSS JOIN LATERAL arena.public_ranked_leaderboard_serving_seasons(
    observed.observed_at
  ) AS serving
)
SELECT
  rank_row.id,
  rank_row.season_id,
  rank_row.source,
  rank_row.source_type,
  rank_row.source_trader_id,
  rank_row.rank,
  rank_row.arena_score,
  rank_row.arena_score_v3,
  rank_row.arena_score_v4,
  rank_row.roi,
  rank_row.pnl,
  rank_row.win_rate,
  rank_row.max_drawdown,
  rank_row.followers,
  rank_row.copiers,
  rank_row.trades_count,
  rank_row.handle,
  rank_row.avatar_url,
  rank_row.computed_at,
  rank_row.profitability_score,
  rank_row.risk_control_score,
  rank_row.execution_score,
  rank_row.score_completeness,
  rank_row.trading_style,
  rank_row.avg_holding_hours,
  rank_row.style_confidence,
  rank_row.sharpe_ratio,
  rank_row.sortino_ratio,
  rank_row.profit_factor,
  rank_row.calmar_ratio,
  rank_row.trader_type,
  rank_row.is_outlier,
  rank_row.metrics_estimated,
  rank_row.rank_change,
  rank_row.is_new,
  COALESCE(
    (rank_row.score_factors -> 'idle_window') = 'true'::pg_catalog.jsonb,
    false
  ) AS idle_window,
  COALESCE(
    (rank_row.score_factors -> 'mdd_contradiction') = 'true'::pg_catalog.jsonb,
    false
  ) AS mdd_contradiction
FROM public.leaderboard_ranks AS rank_row
JOIN serving_seasons AS serving
  ON serving.season_id = rank_row.season_id
JOIN ONLY arena.public_ranked_leaderboard_serving_heads AS head
  ON head.season_id = rank_row.season_id
 AND head.score_cohort_id = rank_row.rank_publication_id
JOIN ONLY arena.public_ranked_leaderboard_serving_sources AS source_witness
  ON source_witness.season_id = rank_row.season_id
 AND source_witness.source = rank_row.source
 AND source_witness.score_cohort_id = rank_row.rank_publication_id
CROSS JOIN observed
WHERE rank_row.rank IS NOT NULL
  AND arena.public_ranked_leaderboard_row_is_eligible(
    rank_row,
    observed.observed_at
  );
$ddl$;

  -- 3. Postflight: the definition is the reviewed one, the two columns are
  --    appended, and nothing else moved.
  SELECT
    class_row.relkind,
    pg_catalog.pg_get_userbyid(class_row.relowner) AS owner,
    class_row.reloptions,
    class_row.relacl::pg_catalog.text AS acl,
    pg_catalog.obj_description(class_row.oid, 'pg_class') AS description,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(pg_catalog.pg_get_viewdef(class_row.oid, true), 'UTF8')
      ),
      'hex'
    ) AS definition_sha256
  INTO STRICT v_after
  FROM pg_catalog.pg_class AS class_row
  WHERE class_row.oid = v_view;

  SELECT pg_catalog.array_agg(
           attribute.attname || ':' ||
             pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
           ORDER BY attribute.attnum
         )
  INTO v_columns_after
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = v_view
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF v_after.definition_sha256 <> '452bf1c819abc3b8b5f94405fc9168782dfca445cd6430e8474498b900641140' THEN
    RAISE EXCEPTION
      'public_ranked_leaderboard_window_flags: installed definition sha256 % is not the reviewed definition',
      v_after.definition_sha256;
  END IF;

  IF v_after.relkind IS DISTINCT FROM v_before.relkind
     OR v_after.owner IS DISTINCT FROM v_before.owner
     OR v_after.reloptions IS DISTINCT FROM v_before.reloptions
     OR v_after.acl IS DISTINCT FROM v_before.acl
     OR v_after.description IS DISTINCT FROM v_before.description THEN
    RAISE EXCEPTION
      'public_ranked_leaderboard_window_flags: an attribute other than the column list changed (owner, options, ACL or comment)';
  END IF;

  IF pg_catalog.cardinality(v_columns_after) <> 37
     OR v_columns_after[1:35] IS DISTINCT FROM v_columns_before[1:35]
     OR v_columns_after[36] <> 'idle_window:boolean'
     OR v_columns_after[37] <> 'mdd_contradiction:boolean' THEN
    RAISE EXCEPTION
      'public_ranked_leaderboard_window_flags: the column list is not the previous 35 columns followed by idle_window and mdd_contradiction (%)',
      v_columns_after;
  END IF;
END
$migration$;

COMMIT;
