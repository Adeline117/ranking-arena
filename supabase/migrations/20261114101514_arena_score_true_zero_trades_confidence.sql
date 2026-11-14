-- Migration: 20261114101514_arena_score_true_zero_trades_confidence.sql
-- Description: Arena Score v4/v5 PG17 scorers — trade-count sample confidence
-- (audit 2026-11-12 P1-2, follow-up to 20261113014105):
--   * unknown trade count (NULL, or 0 from a source that uses 0 for "not
--     provided") counts as 1 real trade, 1/(1+50), instead of 5/(5+50): an
--     unknown sample never out-scores a real trader with 1-4 trades;
--   * a 0 from a source whose trade count Arena computes itself from on-chain
--     fills (gmx, gtrade, hyperliquid — their adapters emit NULL when the
--     count is unknown) is a real 0: sample confidence 0, below any real
--     sample.
-- The TypeScript scorer (lib/utils/arena-score.ts TRUE_ZERO_TRADES_SOURCES,
-- UNKNOWN_TRADES_EQUIV) changes in the same commit and the golden vectors were
-- re-issued, so TS/PG17 parity holds.
--
-- THIS IS A SCORING-DEFINITION CHANGE. Ship it together with the TS change
-- and the re-issued golden vectors. NOT applied by the commit that adds it.
--
-- The four definitions below are the reviewed PG17 output of 20261113014105
-- with exactly these deltas (nothing else changed):
--   compute_arena_scores_v4_json / _v5_json: the sample_confidence CASE
--   encode_leaderboard_score_input_manifest_v1: pinned v4 definition digest
--     da0e644623441dfa6e50ca957c607350216175f0e9172ce156f1c3be129b1e33 -> e9b7df87cd33d5c63aebd733f34b57cc0d4b19006c3db2421ddd298e376d4f3c
--   encode_leaderboard_score_input_manifest_v2: pinned v5 definition digest
--     e4c88c9ffb921ac4a66813f9485eaa0ddd353e48f1db51129cf7ed00a3b9d324 -> 88a12a95d593e26a96f421a1269605147f79481e751aa8f82c30dc69747a1450
-- CREATE OR REPLACE keeps owner, ACL, SET clauses and volatility.
-- Score-input manifests sealed under the old definitions no longer verify as
-- valid (their definition digest differs) — intended: the definition changed.
-- Re-running is a verified no-op (every function must be in its old or its
-- new reviewed state; anything else aborts).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_v4 oid := pg_catalog.to_regprocedure('arena.compute_arena_scores_v4_json(text,jsonb)');
  v_v5 oid := pg_catalog.to_regprocedure('arena.compute_arena_scores_v5_json(text,jsonb)');
  v_round2 oid := pg_catalog.to_regprocedure('arena.arena_score_v4_round2(double precision)');
  v_e1 oid := pg_catalog.to_regprocedure('arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)');
  v_e2 oid := pg_catalog.to_regprocedure('arena.encode_leaderboard_score_input_manifest_v2(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)');
  v_v4_src text;
  v_v5_src text;
BEGIN
  IF v_v4 IS NULL OR v_v5 IS NULL OR v_round2 IS NULL THEN
    RAISE EXCEPTION 'Arena Score v4/v5 PG17 scorers must exist before the true-zero-trades change';
  END IF;
  v_v4_src := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((SELECT f.prosrc FROM pg_catalog.pg_proc AS f WHERE f.oid = v_v4), 'UTF8')), 'hex');
  v_v5_src := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((SELECT f.prosrc FROM pg_catalog.pg_proc AS f WHERE f.oid = v_v5), 'UTF8')), 'hex');
  IF NOT (
       (v_v4_src = '916666cd6d6fed9f66e12ba5236928cdea5816c32942524eb4b3a19cd812a686' AND v_v5_src = '45fc5c5c5d20afb7a2d5047ec635b79053a009651f6ea9e2c8c0b76e56b1b84d')
       OR (v_v4_src = '2d411eec5ed8ea49781044137d2b364fa757495e474a19bd05a4a49621971506' AND v_v5_src = '7fd11db674ca4b64d85915aff30b6b15f7e6ef4b481fc19c90bfea307766e11b')
     ) THEN
    RAISE EXCEPTION 'Arena Score v4/v5 scorer source drifted: %, %', v_v4_src, v_v5_src;
  END IF;
  IF v_e1 IS NOT NULL
     AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((SELECT f.prosrc FROM pg_catalog.pg_proc AS f WHERE f.oid = v_e1), 'UTF8')), 'hex') NOT IN ('221c2f61aa0591b5937a4cd4c28b80702b2358809050527d2303577948d98ff9', 'dc3b4e81c9d1b402575458ace2a25984f71e566e3170f72e670bd35563c24d80') THEN
    RAISE EXCEPTION 'score-input manifest v1 encoder drifted before the true-zero-trades change';
  END IF;
  IF v_e2 IS NOT NULL
     AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((SELECT f.prosrc FROM pg_catalog.pg_proc AS f WHERE f.oid = v_e2), 'UTF8')), 'hex') NOT IN ('dbb3dd74c720162cf17a39f20206bdbe9ad446572d422e28b6929a5c965f676f', '8a7b1989797d557b9756213481dcb0663ca6f0598dd7a4293184109fe2032f15') THEN
    RAISE EXCEPTION 'score-input manifest v2 encoder drifted before the true-zero-trades change';
  END IF;
  -- On the old state, the encoders' definition-digest formula must reproduce
  -- the reviewed digests (proves the replacement digests below are the ones
  -- the encoders will compute).
  IF v_v4_src = '916666cd6d6fed9f66e12ba5236928cdea5816c32942524eb4b3a19cd812a686' AND (
       pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'contract', 'arena-score-v4-pg17-definition@1',
      'postgresMajor', 17,
      'round2Definition', pg_catalog.pg_get_functiondef(v_round2),
      'scorerDefinition', pg_catalog.pg_get_functiondef(v_v4)
    )::text, 'UTF8'), 'sha256'), 'hex') <> 'da0e644623441dfa6e50ca957c607350216175f0e9172ce156f1c3be129b1e33'
       OR pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'contract', 'arena-score-v5-pg17-definition@1',
      'postgresMajor', 17,
      'round2Definition', pg_catalog.pg_get_functiondef(v_round2),
      'scorerDefinition', pg_catalog.pg_get_functiondef(v_v5)
    )::text, 'UTF8'), 'sha256'), 'hex') <> 'e4c88c9ffb921ac4a66813f9485eaa0ddd353e48f1db51129cf7ed00a3b9d324'
     ) THEN
    RAISE EXCEPTION 'scorer definition-digest formula no longer reproduces the reviewed digests';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION arena.compute_arena_scores_v4_json(p_period text, p_inputs jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET extra_float_digits TO '3'
AS $function$
DECLARE
  v_allowed_keys constant text[] := ARRAY[
    'source',
    'source_trader_id',
    'roi',
    'pnl',
    'max_drawdown',
    'win_rate',
    'sharpe_ratio',
    'profit_factor',
    'trades_count'
  ]::text[];
  v_numeric_keys constant text[] := ARRAY[
    'roi',
    'pnl',
    'max_drawdown',
    'win_rate',
    'sharpe_ratio',
    'profit_factor',
    'trades_count'
  ]::text[];
  v_input_count integer;
  v_canonical_inputs jsonb;
  v_input_basis jsonb;
  v_input_digest text;
  v_outputs jsonb;
  v_output_basis jsonb;
  v_output_digest text;
BEGIN
  IF p_period IS NULL OR p_period NOT IN ('7D', '30D', '90D') THEN
    RAISE EXCEPTION 'Arena Score v4 period must be 7D, 30D, or 90D'
      USING ERRCODE = '22023';
  END IF;
  IF p_inputs IS NULL OR pg_catalog.jsonb_typeof(p_inputs) <> 'array' THEN
    RAISE EXCEPTION 'Arena Score v4 inputs must be a JSON array'
      USING ERRCODE = '22023';
  END IF;

  -- This contract starts at PostgreSQL's parsed-jsonb boundary. JSONB has
  -- already collapsed duplicate object member spellings to their effective
  -- last value; validation and both digests bind that effective parsed value.

  v_input_count := pg_catalog.jsonb_array_length(p_inputs);
  IF v_input_count > 64000 THEN
    RAISE EXCEPTION 'Arena Score v4 accepts at most 64000 rows'
      USING ERRCODE = '54000';
  END IF;
  IF pg_catalog.octet_length(p_inputs::text) > 67108864 THEN
    RAISE EXCEPTION 'Arena Score v4 accepts at most 67108864 bytes'
      USING ERRCODE = '54000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
    WHERE pg_catalog.jsonb_typeof(input_row.value) <> 'object'
  ) THEN
    RAISE EXCEPTION 'every Arena Score v4 input row must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
    WHERE EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_object_keys(input_row.value) AS actual_key(key)
      WHERE actual_key.key <> ALL(v_allowed_keys)
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(v_allowed_keys) AS required_key(key)
      WHERE NOT input_row.value ? required_key.key
    )
  ) THEN
    RAISE EXCEPTION 'every Arena Score v4 input row must contain exactly the supported keys'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
    WHERE pg_catalog.jsonb_typeof(input_row.value->'source')
            IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(input_row.value->'source_trader_id')
            IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(input_row.value->'roi')
            IS DISTINCT FROM 'number'
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(v_numeric_keys[2:7]) AS nullable_key(key)
         WHERE pg_catalog.jsonb_typeof(input_row.value->nullable_key.key)
           NOT IN ('number', 'null')
       )
  ) THEN
    RAISE EXCEPTION 'one or more Arena Score v4 inputs have invalid scalar types'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
    WHERE input_row.value->>'source'
            IS DISTINCT FROM pg_catalog.btrim(input_row.value->>'source')
       OR input_row.value->>'source_trader_id'
            IS DISTINCT FROM pg_catalog.btrim(input_row.value->>'source_trader_id')
       OR input_row.value->>'source' = ''
       OR input_row.value->>'source_trader_id' = ''
       OR pg_catalog.length(input_row.value->>'source') > 128
       OR pg_catalog.length(input_row.value->>'source_trader_id') > 512
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(v_numeric_keys) AS numeric_key(key)
         WHERE pg_catalog.jsonb_typeof(input_row.value->numeric_key.key) = 'number'
           AND pg_catalog.octet_length(input_row.value->>numeric_key.key) > 320
       )
  ) THEN
    RAISE EXCEPTION 'one or more Arena Score v4 inputs exceed scalar length bounds'
      USING ERRCODE = '22023';
  END IF;

  -- Every continuous input is converted to IEEE-754 float8 below, matching the
  -- JavaScript Number domain. The explicit 1e300 bound keeps that conversion
  -- finite without inheriting any production table's NUMERIC precision.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
    WHERE pg_catalog.abs((input_row.value->>'roi')::numeric) > 1e300::numeric
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(v_numeric_keys[2:6]) AS continuous_key(key)
         WHERE pg_catalog.jsonb_typeof(input_row.value->continuous_key.key) = 'number'
           AND pg_catalog.abs(
             (input_row.value->>continuous_key.key)::numeric
           ) > 1e300::numeric
       )
       OR (
         pg_catalog.jsonb_typeof(input_row.value->'trades_count') = 'number'
         AND (
           (input_row.value->>'trades_count')::numeric < 0
           OR (input_row.value->>'trades_count')::numeric > 9007199254740991::numeric
           OR (input_row.value->>'trades_count')::numeric
              <> pg_catalog.trunc((input_row.value->>'trades_count')::numeric)
         )
       )
  ) THEN
    RAISE EXCEPTION 'one or more Arena Score v4 inputs are outside the finite scorer domain'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
    GROUP BY
      (input_row.value->>'source') COLLATE "C",
      (input_row.value->>'source_trader_id') COLLATE "C"
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate Arena Score v4 input key'
      USING ERRCODE = '22023';
  END IF;

  -- Rebuild from parsed float8/integer values rather than hashing the caller's
  -- numeric spelling. Mathematical equivalents such as 1, 1.0, and 1e0 must
  -- produce the same canonical input digest.
  WITH decoded AS MATERIALIZED (
    SELECT
      input_row.value->>'source' AS source,
      input_row.value->>'source_trader_id' AS source_trader_id,
      (input_row.value->>'roi')::double precision AS roi,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'pnl') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'pnl')::double precision
      END AS pnl,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'max_drawdown') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'max_drawdown')::double precision
      END AS max_drawdown,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'win_rate') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'win_rate')::double precision
      END AS win_rate,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'sharpe_ratio') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'sharpe_ratio')::double precision
      END AS sharpe_ratio,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'profit_factor') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'profit_factor')::double precision
      END AS profit_factor,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'trades_count') = 'null'
        THEN NULL::bigint
        ELSE (input_row.value->>'trades_count')::numeric::bigint
      END AS trades_count
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'source', decoded.source,
        'source_trader_id', decoded.source_trader_id,
        'roi', decoded.roi,
        'pnl', decoded.pnl,
        'max_drawdown', decoded.max_drawdown,
        'win_rate', decoded.win_rate,
        'sharpe_ratio', decoded.sharpe_ratio,
        'profit_factor', decoded.profit_factor,
        'trades_count', decoded.trades_count
      )
      ORDER BY
        decoded.source COLLATE "C",
        decoded.source_trader_id COLLATE "C"
    ),
    '[]'::jsonb
  )
  INTO STRICT v_canonical_inputs
  FROM decoded;

  v_input_basis := pg_catalog.jsonb_build_object(
    'contract', 'arena-score-v4-pg17-input@1',
    'period', p_period,
    'inputs', v_canonical_inputs
  );
  v_input_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_input_basis::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  WITH decoded AS MATERIALIZED (
    SELECT
      input_row.value->>'source' AS source,
      input_row.value->>'source_trader_id' AS source_trader_id,
      (input_row.value->>'roi')::double precision AS roi,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'pnl') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'pnl')::double precision
      END AS pnl,
      CASE
        WHEN pg_catalog.jsonb_typeof(input_row.value->'max_drawdown') = 'null'
          OR (input_row.value->>'max_drawdown')::double precision = 0
          THEN NULL::double precision
        ELSE -pg_catalog.abs(
          (input_row.value->>'max_drawdown')::double precision
        )
      END AS drawdown_rank_value,
      CASE
        WHEN pg_catalog.jsonb_typeof(input_row.value->'win_rate') = 'null'
          OR (input_row.value->>'win_rate')::double precision = 0
          THEN NULL::double precision
        ELSE (input_row.value->>'win_rate')::double precision
      END AS win_rank_value,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'sharpe_ratio') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'sharpe_ratio')::double precision
      END AS sharpe_rank_value,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'profit_factor') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'profit_factor')::double precision
      END AS profit_factor_rank_value,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'trades_count') = 'null'
        THEN NULL::bigint
        ELSE (input_row.value->>'trades_count')::numeric::bigint
      END AS trades_count
    FROM pg_catalog.jsonb_array_elements(v_canonical_inputs) AS input_row(value)
  ), ranked AS MATERIALIZED (
    SELECT
      decoded.*,
      pg_catalog.count(*) OVER () AS roi_count,
      pg_catalog.rank() OVER (ORDER BY decoded.roi) AS roi_rank,
      pg_catalog.count(decoded.drawdown_rank_value) OVER () AS drawdown_count,
      pg_catalog.rank() OVER (
        ORDER BY decoded.drawdown_rank_value NULLS LAST
      ) AS drawdown_rank,
      pg_catalog.count(decoded.sharpe_rank_value) OVER () AS sharpe_count,
      pg_catalog.rank() OVER (
        ORDER BY decoded.sharpe_rank_value NULLS LAST
      ) AS sharpe_rank,
      pg_catalog.count(decoded.win_rank_value) OVER () AS win_count,
      pg_catalog.rank() OVER (
        ORDER BY decoded.win_rank_value NULLS LAST
      ) AS win_rank,
      pg_catalog.count(decoded.profit_factor_rank_value) OVER () AS profit_factor_count,
      pg_catalog.rank() OVER (
        ORDER BY decoded.profit_factor_rank_value NULLS LAST
      ) AS profit_factor_rank
    FROM decoded
  ), percentiles AS MATERIALIZED (
    SELECT
      ranked.*,
      CASE WHEN ranked.roi_count = 1 THEN 1::double precision
        ELSE (ranked.roi_rank - 1)::double precision
          / (ranked.roi_count - 1)::double precision
      END AS factor_roi,
      CASE WHEN ranked.drawdown_rank_value IS NULL THEN NULL::double precision
        WHEN ranked.drawdown_count = 1 THEN 1::double precision
        ELSE (ranked.drawdown_rank - 1)::double precision
          / (ranked.drawdown_count - 1)::double precision
      END AS factor_drawdown,
      CASE WHEN ranked.sharpe_rank_value IS NULL THEN NULL::double precision
        WHEN ranked.sharpe_count = 1 THEN 1::double precision
        ELSE (ranked.sharpe_rank - 1)::double precision
          / (ranked.sharpe_count - 1)::double precision
      END AS factor_sharpe,
      CASE WHEN ranked.win_rank_value IS NULL THEN NULL::double precision
        WHEN ranked.win_count = 1 THEN 1::double precision
        ELSE (ranked.win_rank - 1)::double precision
          / (ranked.win_count - 1)::double precision
      END AS factor_win,
      CASE WHEN ranked.profit_factor_rank_value IS NULL THEN NULL::double precision
        WHEN ranked.profit_factor_count = 1 THEN 1::double precision
        ELSE (ranked.profit_factor_rank - 1)::double precision
          / (ranked.profit_factor_count - 1)::double precision
      END AS factor_profit
    FROM ranked
  ), feature_rows AS MATERIALIZED (
    SELECT
      percentiles.*,
      CASE
        WHEN percentiles.pnl IS NULL OR percentiles.pnl <= 0 THEN 0::double precision
        ELSE LEAST(
          1::double precision,
          GREATEST(
            0::double precision,
            (
              pg_catalog.ln(percentiles.pnl) - pg_catalog.ln(1000::double precision)
            ) / (
              pg_catalog.ln(10000000::double precision)
              - pg_catalog.ln(1000::double precision)
            )
          )
        )
      END AS factor_pnl,
      CASE
        WHEN percentiles.factor_win IS NULL
             AND percentiles.factor_profit IS NULL THEN NULL::double precision
        ELSE (
          CASE WHEN percentiles.factor_win IS NULL
            THEN 0::double precision ELSE 0.6 * percentiles.factor_win END
          + CASE WHEN percentiles.factor_profit IS NULL
            THEN 0::double precision ELSE 0.4 * percentiles.factor_profit END
        ) / (
          CASE WHEN percentiles.factor_win IS NULL THEN 0::double precision ELSE 0.6 END
          + CASE WHEN percentiles.factor_profit IS NULL THEN 0::double precision ELSE 0.4 END
        )
      END AS factor_consistency,
      CASE
        WHEN percentiles.trades_count IS NULL
          OR (
            percentiles.trades_count = 0
            AND percentiles.source NOT IN ('gmx', 'gtrade', 'hyperliquid')
          )
          THEN (1::double precision / (1::double precision + 50::double precision))
        ELSE percentiles.trades_count::double precision
          / (percentiles.trades_count::double precision + 50::double precision)
      END AS sample_confidence,
      GREATEST(
        (
          (percentiles.sharpe_rank_value IS NOT NULL)::integer
          + (percentiles.drawdown_rank_value IS NOT NULL)::integer
          + (percentiles.win_rank_value IS NOT NULL)::integer
          + (percentiles.profit_factor_rank_value IS NOT NULL)::integer
        )::double precision / 4::double precision,
        0.25::double precision
      ) AS completeness_confidence
    FROM percentiles
  ), quality_rows AS MATERIALIZED (
    SELECT
      feature_rows.*,
      LEAST(
        1::double precision,
        GREATEST(
          0::double precision,
          (
            0.3 * feature_rows.factor_pnl
            + 0.2 * feature_rows.factor_roi
            + CASE WHEN feature_rows.factor_drawdown IS NULL
              THEN 0::double precision ELSE 0.2 * feature_rows.factor_drawdown END
            + CASE WHEN feature_rows.factor_sharpe IS NULL
              THEN 0::double precision ELSE 0.2 * feature_rows.factor_sharpe END
            + CASE WHEN feature_rows.factor_consistency IS NULL
              THEN 0::double precision ELSE 0.1 * feature_rows.factor_consistency END
          ) / (
            0.3 + 0.2
            + CASE WHEN feature_rows.factor_drawdown IS NULL THEN 0 ELSE 0.2 END
            + CASE WHEN feature_rows.factor_sharpe IS NULL THEN 0 ELSE 0.2 END
            + CASE WHEN feature_rows.factor_consistency IS NULL THEN 0 ELSE 0.1 END
          )
        )
      ) AS quality,
      0.35 + 0.65 * pg_catalog.cbrt(
        GREATEST(
          0.01::double precision,
          feature_rows.sample_confidence * feature_rows.completeness_confidence
        )
      ) AS confidence
    FROM feature_rows
  ), composite_rows AS MATERIALIZED (
    SELECT
      quality_rows.*,
      quality_rows.quality * quality_rows.confidence AS composite
    FROM quality_rows
  ), display_rows AS MATERIALIZED (
    SELECT
      composite_rows.*,
      CASE WHEN pg_catalog.count(*) OVER () = 1 THEN 1::double precision
        ELSE (pg_catalog.rank() OVER (ORDER BY composite_rows.composite) - 1)::double precision
          / (pg_catalog.count(*) OVER () - 1)::double precision
      END AS composite_percentile,
      GREATEST(
        pg_catalog.max(composite_rows.composite) OVER (),
        1e-9::double precision
      ) AS max_composite
    FROM composite_rows
  ), unrounded_outputs AS MATERIALIZED (
    SELECT
      display_rows.source,
      display_rows.source_trader_id,
      LEAST(
        100::double precision,
        GREATEST(
          0::double precision,
          100 * (
            0.7 * display_rows.composite_percentile
            + 0.3 * (display_rows.composite / display_rows.max_composite)
          )
        )
      ) AS total_score,
      display_rows.quality,
      display_rows.confidence,
      display_rows.factor_roi,
      display_rows.factor_pnl,
      display_rows.factor_drawdown,
      display_rows.factor_sharpe,
      display_rows.factor_consistency
    FROM display_rows
  ), rounded_outputs AS MATERIALIZED (
    SELECT
      unrounded_outputs.source,
      unrounded_outputs.source_trader_id,
      arena.arena_score_v4_round2(unrounded_outputs.total_score) AS total_score,
      arena.arena_score_v4_round2(unrounded_outputs.quality) AS quality,
      arena.arena_score_v4_round2(unrounded_outputs.confidence) AS confidence,
      arena.arena_score_v4_round2(unrounded_outputs.factor_roi) AS factor_roi,
      arena.arena_score_v4_round2(unrounded_outputs.factor_pnl) AS factor_pnl,
      CASE WHEN unrounded_outputs.factor_drawdown IS NULL THEN NULL::double precision
        ELSE arena.arena_score_v4_round2(unrounded_outputs.factor_drawdown)
      END AS factor_drawdown,
      CASE WHEN unrounded_outputs.factor_sharpe IS NULL THEN NULL::double precision
        ELSE arena.arena_score_v4_round2(unrounded_outputs.factor_sharpe)
      END AS factor_sharpe,
      CASE WHEN unrounded_outputs.factor_consistency IS NULL THEN NULL::double precision
        ELSE arena.arena_score_v4_round2(unrounded_outputs.factor_consistency)
      END AS factor_consistency
    FROM unrounded_outputs
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'source', rounded_outputs.source,
        'sourceTraderId', rounded_outputs.source_trader_id,
        'totalScore', rounded_outputs.total_score,
        'quality', rounded_outputs.quality,
        'confidence', rounded_outputs.confidence,
        'factors', pg_catalog.jsonb_build_object(
          'roi', rounded_outputs.factor_roi,
          'pnl', rounded_outputs.factor_pnl,
          'drawdown', rounded_outputs.factor_drawdown,
          'sharpe', rounded_outputs.factor_sharpe,
          'consistency', rounded_outputs.factor_consistency
        )
      )
      ORDER BY
        rounded_outputs.source COLLATE "C",
        rounded_outputs.source_trader_id COLLATE "C"
    ),
    '[]'::jsonb
  )
  INTO STRICT v_outputs
  FROM rounded_outputs;

  v_output_basis := pg_catalog.jsonb_build_object(
    'contract', 'arena-score-v4-pg17-output@1',
    'period', p_period,
    'inputDigest', v_input_digest,
    'outputs', v_outputs
  );
  v_output_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_output_basis::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'arena-score-v4-pg17@1',
    'digestAlgorithm', 'pg17-jsonb-utf8-sha256@1',
    'period', p_period,
    'inputCount', v_input_count,
    'inputDigest', v_input_digest,
    'outputDigest', v_output_digest,
    'outputs', v_outputs
  );
END;
$function$;

CREATE OR REPLACE FUNCTION arena.compute_arena_scores_v5_json(p_period text, p_inputs jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET extra_float_digits TO '3'
AS $function$
DECLARE
  v_allowed_keys constant text[] := ARRAY[
    'source',
    'source_trader_id',
    'roi',
    'pnl',
    'max_drawdown',
    'win_rate',
    'sharpe_ratio',
    'profit_factor',
    'trades_count'
  ]::text[];
  v_numeric_keys constant text[] := ARRAY[
    'roi',
    'pnl',
    'max_drawdown',
    'win_rate',
    'sharpe_ratio',
    'profit_factor',
    'trades_count'
  ]::text[];
  v_input_count integer;
  v_canonical_inputs jsonb;
  v_input_basis jsonb;
  v_input_digest text;
  v_outputs jsonb;
  v_output_basis jsonb;
  v_output_digest text;
BEGIN
  IF p_period IS NULL OR p_period NOT IN ('7D', '30D', '90D') THEN
    RAISE EXCEPTION 'Arena Score v5 period must be 7D, 30D, or 90D'
      USING ERRCODE = '22023';
  END IF;
  IF p_inputs IS NULL OR pg_catalog.jsonb_typeof(p_inputs) <> 'array' THEN
    RAISE EXCEPTION 'Arena Score v5 inputs must be a JSON array'
      USING ERRCODE = '22023';
  END IF;

  -- This contract starts at PostgreSQL's parsed-jsonb boundary. JSONB has
  -- already collapsed duplicate object member spellings to their effective
  -- last value; validation and both digests bind that effective parsed value.

  v_input_count := pg_catalog.jsonb_array_length(p_inputs);
  IF v_input_count > 64000 THEN
    RAISE EXCEPTION 'Arena Score v5 accepts at most 64000 rows'
      USING ERRCODE = '54000';
  END IF;
  IF pg_catalog.octet_length(p_inputs::text) > 67108864 THEN
    RAISE EXCEPTION 'Arena Score v5 accepts at most 67108864 bytes'
      USING ERRCODE = '54000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
    WHERE pg_catalog.jsonb_typeof(input_row.value) <> 'object'
  ) THEN
    RAISE EXCEPTION 'every Arena Score v5 input row must be a JSON object'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
    WHERE EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_object_keys(input_row.value) AS actual_key(key)
      WHERE actual_key.key <> ALL(v_allowed_keys)
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(v_allowed_keys) AS required_key(key)
      WHERE NOT input_row.value ? required_key.key
    )
  ) THEN
    RAISE EXCEPTION 'every Arena Score v5 input row must contain exactly the supported keys'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
    WHERE pg_catalog.jsonb_typeof(input_row.value->'source')
            IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(input_row.value->'source_trader_id')
            IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(input_row.value->'roi')
            IS DISTINCT FROM 'number'
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(v_numeric_keys[2:7]) AS nullable_key(key)
         WHERE pg_catalog.jsonb_typeof(input_row.value->nullable_key.key)
           NOT IN ('number', 'null')
       )
  ) THEN
    RAISE EXCEPTION 'one or more Arena Score v5 inputs have invalid scalar types'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
    WHERE input_row.value->>'source'
            IS DISTINCT FROM pg_catalog.btrim(input_row.value->>'source')
       OR input_row.value->>'source_trader_id'
            IS DISTINCT FROM pg_catalog.btrim(input_row.value->>'source_trader_id')
       OR input_row.value->>'source' = ''
       OR input_row.value->>'source_trader_id' = ''
       OR pg_catalog.length(input_row.value->>'source') > 128
       OR pg_catalog.length(input_row.value->>'source_trader_id') > 512
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(v_numeric_keys) AS numeric_key(key)
         WHERE pg_catalog.jsonb_typeof(input_row.value->numeric_key.key) = 'number'
           AND pg_catalog.octet_length(input_row.value->>numeric_key.key) > 320
       )
  ) THEN
    RAISE EXCEPTION 'one or more Arena Score v5 inputs exceed scalar length bounds'
      USING ERRCODE = '22023';
  END IF;

  -- Every continuous input is converted to IEEE-754 float8 below, matching the
  -- JavaScript Number domain. The explicit 1e300 bound keeps that conversion
  -- finite without inheriting any production table's NUMERIC precision.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
    WHERE pg_catalog.abs((input_row.value->>'roi')::numeric) > 1e300::numeric
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(v_numeric_keys[2:6]) AS continuous_key(key)
         WHERE pg_catalog.jsonb_typeof(input_row.value->continuous_key.key) = 'number'
           AND pg_catalog.abs(
             (input_row.value->>continuous_key.key)::numeric
           ) > 1e300::numeric
       )
       OR (
         pg_catalog.jsonb_typeof(input_row.value->'trades_count') = 'number'
         AND (
           (input_row.value->>'trades_count')::numeric < 0
           OR (input_row.value->>'trades_count')::numeric > 9007199254740991::numeric
           OR (input_row.value->>'trades_count')::numeric
              <> pg_catalog.trunc((input_row.value->>'trades_count')::numeric)
         )
       )
  ) THEN
    RAISE EXCEPTION 'one or more Arena Score v5 inputs are outside the finite scorer domain'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
    GROUP BY
      (input_row.value->>'source') COLLATE "C",
      (input_row.value->>'source_trader_id') COLLATE "C"
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate Arena Score v5 input key'
      USING ERRCODE = '22023';
  END IF;

  -- Rebuild from parsed float8/integer values rather than hashing the caller's
  -- numeric spelling. Mathematical equivalents such as 1, 1.0, and 1e0 must
  -- produce the same canonical input digest.
  WITH decoded AS MATERIALIZED (
    SELECT
      input_row.value->>'source' AS source,
      input_row.value->>'source_trader_id' AS source_trader_id,
      (input_row.value->>'roi')::double precision AS roi,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'pnl') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'pnl')::double precision
      END AS pnl,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'max_drawdown') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'max_drawdown')::double precision
      END AS max_drawdown,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'win_rate') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'win_rate')::double precision
      END AS win_rate,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'sharpe_ratio') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'sharpe_ratio')::double precision
      END AS sharpe_ratio,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'profit_factor') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'profit_factor')::double precision
      END AS profit_factor,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'trades_count') = 'null'
        THEN NULL::bigint
        ELSE (input_row.value->>'trades_count')::numeric::bigint
      END AS trades_count
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'source', decoded.source,
        'source_trader_id', decoded.source_trader_id,
        'roi', decoded.roi,
        'pnl', decoded.pnl,
        'max_drawdown', decoded.max_drawdown,
        'win_rate', decoded.win_rate,
        'sharpe_ratio', decoded.sharpe_ratio,
        'profit_factor', decoded.profit_factor,
        'trades_count', decoded.trades_count
      )
      ORDER BY
        decoded.source COLLATE "C",
        decoded.source_trader_id COLLATE "C"
    ),
    '[]'::jsonb
  )
  INTO STRICT v_canonical_inputs
  FROM decoded;

  v_input_basis := pg_catalog.jsonb_build_object(
    'contract', 'arena-score-v5-pg17-input@1',
    'period', p_period,
    'inputs', v_canonical_inputs
  );
  v_input_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_input_basis::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  WITH decoded AS MATERIALIZED (
    SELECT
      input_row.value->>'source' AS source,
      input_row.value->>'source_trader_id' AS source_trader_id,
      (input_row.value->>'roi')::double precision AS roi,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'pnl') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'pnl')::double precision
      END AS pnl,
      CASE
        WHEN pg_catalog.jsonb_typeof(input_row.value->'max_drawdown') = 'null'
          THEN NULL::double precision
        ELSE -pg_catalog.abs(
          (input_row.value->>'max_drawdown')::double precision
        )
      END AS drawdown_rank_value,
      CASE
        WHEN pg_catalog.jsonb_typeof(input_row.value->'win_rate') = 'null'
          THEN NULL::double precision
        ELSE (input_row.value->>'win_rate')::double precision
      END AS win_rank_value,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'sharpe_ratio') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'sharpe_ratio')::double precision
      END AS sharpe_rank_value,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'profit_factor') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'profit_factor')::double precision
      END AS profit_factor_rank_value,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'trades_count') = 'null'
        THEN NULL::bigint
        ELSE (input_row.value->>'trades_count')::numeric::bigint
      END AS trades_count
    FROM pg_catalog.jsonb_array_elements(v_canonical_inputs) AS input_row(value)
  ), ranked AS MATERIALIZED (
    SELECT
      decoded.*,
      pg_catalog.count(*) OVER () AS roi_count,
      pg_catalog.rank() OVER (ORDER BY decoded.roi) AS roi_rank,
      pg_catalog.count(decoded.drawdown_rank_value) OVER () AS drawdown_count,
      pg_catalog.rank() OVER (
        ORDER BY decoded.drawdown_rank_value NULLS LAST
      ) AS drawdown_rank,
      pg_catalog.count(decoded.sharpe_rank_value) OVER () AS sharpe_count,
      pg_catalog.rank() OVER (
        ORDER BY decoded.sharpe_rank_value NULLS LAST
      ) AS sharpe_rank,
      pg_catalog.count(decoded.win_rank_value) OVER () AS win_count,
      pg_catalog.rank() OVER (
        ORDER BY decoded.win_rank_value NULLS LAST
      ) AS win_rank,
      pg_catalog.count(decoded.profit_factor_rank_value) OVER () AS profit_factor_count,
      pg_catalog.rank() OVER (
        ORDER BY decoded.profit_factor_rank_value NULLS LAST
      ) AS profit_factor_rank
    FROM decoded
  ), percentiles AS MATERIALIZED (
    SELECT
      ranked.*,
      CASE WHEN ranked.roi_count = 1 THEN 1::double precision
        ELSE (ranked.roi_rank - 1)::double precision
          / (ranked.roi_count - 1)::double precision
      END AS factor_roi,
      CASE WHEN ranked.drawdown_rank_value IS NULL THEN NULL::double precision
        WHEN ranked.drawdown_count = 1 THEN 1::double precision
        ELSE (ranked.drawdown_rank - 1)::double precision
          / (ranked.drawdown_count - 1)::double precision
      END AS factor_drawdown,
      CASE WHEN ranked.sharpe_rank_value IS NULL THEN NULL::double precision
        WHEN ranked.sharpe_count = 1 THEN 1::double precision
        ELSE (ranked.sharpe_rank - 1)::double precision
          / (ranked.sharpe_count - 1)::double precision
      END AS factor_sharpe,
      CASE WHEN ranked.win_rank_value IS NULL THEN NULL::double precision
        WHEN ranked.win_count = 1 THEN 1::double precision
        ELSE (ranked.win_rank - 1)::double precision
          / (ranked.win_count - 1)::double precision
      END AS factor_win,
      CASE WHEN ranked.profit_factor_rank_value IS NULL THEN NULL::double precision
        WHEN ranked.profit_factor_count = 1 THEN 1::double precision
        ELSE (ranked.profit_factor_rank - 1)::double precision
          / (ranked.profit_factor_count - 1)::double precision
      END AS factor_profit
    FROM ranked
  ), feature_rows AS MATERIALIZED (
    SELECT
      percentiles.*,
      CASE
        WHEN percentiles.pnl IS NULL OR percentiles.pnl <= 0 THEN 0::double precision
        ELSE LEAST(
          1::double precision,
          GREATEST(
            0::double precision,
            (
              pg_catalog.ln(percentiles.pnl) - pg_catalog.ln(1000::double precision)
            ) / (
              pg_catalog.ln(10000000::double precision)
              - pg_catalog.ln(1000::double precision)
            )
          )
        )
      END AS factor_pnl,
      CASE
        WHEN percentiles.factor_win IS NULL
             AND percentiles.factor_profit IS NULL THEN NULL::double precision
        ELSE (
          CASE WHEN percentiles.factor_win IS NULL
            THEN 0::double precision ELSE 0.6 * percentiles.factor_win END
          + CASE WHEN percentiles.factor_profit IS NULL
            THEN 0::double precision ELSE 0.4 * percentiles.factor_profit END
        ) / (
          CASE WHEN percentiles.factor_win IS NULL THEN 0::double precision ELSE 0.6 END
          + CASE WHEN percentiles.factor_profit IS NULL THEN 0::double precision ELSE 0.4 END
        )
      END AS factor_consistency,
      CASE
        WHEN percentiles.trades_count IS NULL
          OR (
            percentiles.trades_count = 0
            AND percentiles.source NOT IN ('gmx', 'gtrade', 'hyperliquid')
          )
          THEN (1::double precision / (1::double precision + 50::double precision))
        ELSE percentiles.trades_count::double precision
          / (percentiles.trades_count::double precision + 50::double precision)
      END AS sample_confidence,
      GREATEST(
        (
          (percentiles.sharpe_rank_value IS NOT NULL)::integer
          + (percentiles.drawdown_rank_value IS NOT NULL)::integer
          + (percentiles.win_rank_value IS NOT NULL)::integer
          + (percentiles.profit_factor_rank_value IS NOT NULL)::integer
        )::double precision / 4::double precision,
        0.25::double precision
      ) AS completeness_confidence
    FROM percentiles
  ), quality_rows AS MATERIALIZED (
    SELECT
      feature_rows.*,
      LEAST(
        1::double precision,
        GREATEST(
          0::double precision,
          (
            0.3 * feature_rows.factor_pnl
            + 0.2 * feature_rows.factor_roi
            + CASE WHEN feature_rows.factor_drawdown IS NULL
              THEN 0::double precision ELSE 0.2 * feature_rows.factor_drawdown END
            + CASE WHEN feature_rows.factor_sharpe IS NULL
              THEN 0::double precision ELSE 0.2 * feature_rows.factor_sharpe END
            + CASE WHEN feature_rows.factor_consistency IS NULL
              THEN 0::double precision ELSE 0.1 * feature_rows.factor_consistency END
          ) / (
            0.3 + 0.2
            + CASE WHEN feature_rows.factor_drawdown IS NULL THEN 0 ELSE 0.2 END
            + CASE WHEN feature_rows.factor_sharpe IS NULL THEN 0 ELSE 0.2 END
            + CASE WHEN feature_rows.factor_consistency IS NULL THEN 0 ELSE 0.1 END
          )
        )
      ) AS quality,
      0.35 + 0.65 * pg_catalog.cbrt(
        GREATEST(
          0.01::double precision,
          feature_rows.sample_confidence * feature_rows.completeness_confidence
        )
      ) AS confidence
    FROM feature_rows
  ), composite_rows AS MATERIALIZED (
    SELECT
      quality_rows.*,
      quality_rows.quality * quality_rows.confidence AS composite
    FROM quality_rows
  ), display_rows AS MATERIALIZED (
    SELECT
      composite_rows.*,
      CASE WHEN pg_catalog.count(*) OVER () = 1 THEN 1::double precision
        ELSE (pg_catalog.rank() OVER (ORDER BY composite_rows.composite) - 1)::double precision
          / (pg_catalog.count(*) OVER () - 1)::double precision
      END AS composite_percentile,
      GREATEST(
        pg_catalog.max(composite_rows.composite) OVER (),
        1e-9::double precision
      ) AS max_composite
    FROM composite_rows
  ), unrounded_outputs AS MATERIALIZED (
    SELECT
      display_rows.source,
      display_rows.source_trader_id,
      LEAST(
        100::double precision,
        GREATEST(
          0::double precision,
          100 * (
            0.7 * display_rows.composite_percentile
            + 0.3 * (display_rows.composite / display_rows.max_composite)
          )
        )
      ) AS total_score,
      display_rows.quality,
      display_rows.confidence,
      display_rows.factor_roi,
      display_rows.factor_pnl,
      display_rows.factor_drawdown,
      display_rows.factor_sharpe,
      display_rows.factor_consistency
    FROM display_rows
  ), rounded_outputs AS MATERIALIZED (
    SELECT
      unrounded_outputs.source,
      unrounded_outputs.source_trader_id,
      arena.arena_score_v4_round2(unrounded_outputs.total_score) AS total_score,
      arena.arena_score_v4_round2(unrounded_outputs.quality) AS quality,
      arena.arena_score_v4_round2(unrounded_outputs.confidence) AS confidence,
      arena.arena_score_v4_round2(unrounded_outputs.factor_roi) AS factor_roi,
      arena.arena_score_v4_round2(unrounded_outputs.factor_pnl) AS factor_pnl,
      CASE WHEN unrounded_outputs.factor_drawdown IS NULL THEN NULL::double precision
        ELSE arena.arena_score_v4_round2(unrounded_outputs.factor_drawdown)
      END AS factor_drawdown,
      CASE WHEN unrounded_outputs.factor_sharpe IS NULL THEN NULL::double precision
        ELSE arena.arena_score_v4_round2(unrounded_outputs.factor_sharpe)
      END AS factor_sharpe,
      CASE WHEN unrounded_outputs.factor_consistency IS NULL THEN NULL::double precision
        ELSE arena.arena_score_v4_round2(unrounded_outputs.factor_consistency)
      END AS factor_consistency
    FROM unrounded_outputs
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'source', rounded_outputs.source,
        'sourceTraderId', rounded_outputs.source_trader_id,
        'totalScore', rounded_outputs.total_score,
        'quality', rounded_outputs.quality,
        'confidence', rounded_outputs.confidence,
        'factors', pg_catalog.jsonb_build_object(
          'roi', rounded_outputs.factor_roi,
          'pnl', rounded_outputs.factor_pnl,
          'drawdown', rounded_outputs.factor_drawdown,
          'sharpe', rounded_outputs.factor_sharpe,
          'consistency', rounded_outputs.factor_consistency
        )
      )
      ORDER BY
        rounded_outputs.source COLLATE "C",
        rounded_outputs.source_trader_id COLLATE "C"
    ),
    '[]'::jsonb
  )
  INTO STRICT v_outputs
  FROM rounded_outputs;

  v_output_basis := pg_catalog.jsonb_build_object(
    'contract', 'arena-score-v5-pg17-output@1',
    'period', p_period,
    'inputDigest', v_input_digest,
    'outputs', v_outputs
  );
  v_output_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_output_basis::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'arena-score-v5-pg17@1',
    'digestAlgorithm', 'pg17-jsonb-utf8-sha256@1',
    'period', p_period,
    'inputCount', v_input_count,
    'inputDigest', v_input_digest,
    'outputDigest', v_output_digest,
    'outputs', v_outputs
  );
END;
$function$;

-- The encoders exist wherever the score-input manifest chain was installed
-- (every launch catalog). A scorer-only catalog has nothing to re-bind.
DO $rebind_manifest_v1_encoder$
BEGIN
  IF pg_catalog.to_regprocedure('arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)') IS NOT NULL THEN
CREATE OR REPLACE FUNCTION arena.encode_leaderboard_score_input_manifest_v1(p_period text, p_source_bundle_digest text, p_score_rows_sha256 text, p_physical_boards_sha256 text, p_source_evidence jsonb, p_enrichment_contract text, p_enrichment_evidence jsonb, p_eligibility_contract text, p_eligibility_evidence jsonb, p_inputs jsonb, p_valid_until timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET extra_float_digits TO '3'
 SET quote_all_identifiers TO 'off'
AS $function$
DECLARE
  v_scorer_oid oid := pg_catalog.to_regprocedure(
    'arena.compute_arena_scores_v4_json(text,jsonb)'
  );
  v_round_oid oid := pg_catalog.to_regprocedure(
    'arena.arena_score_v4_round2(double precision)'
  );
  v_scorer_result jsonb;
  v_canonical_inputs jsonb;
  v_recomputed_input_digest text;
  v_definition_basis jsonb;
  v_definition_digest text;
  v_source_basis jsonb;
  v_source_evidence_digest text;
  v_enrichment_basis jsonb;
  v_enrichment_evidence_digest text;
  v_eligibility_basis jsonb;
  v_eligibility_evidence_digest text;
BEGIN
  IF v_scorer_oid IS NULL OR v_round_oid IS NULL THEN
    RAISE EXCEPTION 'private PG17 Arena Score v4 scorer is unavailable'
      USING ERRCODE = '55000';
  END IF;
  IF p_source_bundle_digest IS NULL
     OR p_source_bundle_digest !~ '^[0-9a-f]{64}$'
     OR p_score_rows_sha256 IS NULL
     OR p_score_rows_sha256 !~ '^[0-9a-f]{64}$'
     OR p_physical_boards_sha256 IS NULL
     OR p_physical_boards_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'source bundle, score-row, and physical-board digests must be lowercase sha256'
      USING ERRCODE = '22023';
  END IF;
  IF p_enrichment_contract IS NULL
     OR p_enrichment_contract IS DISTINCT FROM pg_catalog.btrim(p_enrichment_contract)
     OR p_enrichment_contract !~ '^[a-z0-9][a-z0-9._:@/-]{0,127}$'
     OR p_eligibility_contract IS NULL
     OR p_eligibility_contract IS DISTINCT FROM pg_catalog.btrim(p_eligibility_contract)
     OR p_eligibility_contract !~ '^[a-z0-9][a-z0-9._:@/-]{0,127}$' THEN
    RAISE EXCEPTION 'evidence contract identifiers are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF p_source_evidence IS NULL
     OR pg_catalog.jsonb_typeof(p_source_evidence) <> 'object'
     OR p_enrichment_evidence IS NULL
     OR pg_catalog.jsonb_typeof(p_enrichment_evidence) <> 'object'
     OR p_eligibility_evidence IS NULL
     OR pg_catalog.jsonb_typeof(p_eligibility_evidence) <> 'object' THEN
    RAISE EXCEPTION 'source, enrichment, and eligibility evidence must be JSON objects'
      USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.octet_length(p_source_evidence::text) > 16777216
     OR pg_catalog.octet_length(p_enrichment_evidence::text) > 33554432
     OR pg_catalog.octet_length(p_eligibility_evidence::text) > 16777216
     OR pg_catalog.octet_length(p_source_evidence::text)
        + pg_catalog.octet_length(p_enrichment_evidence::text)
        + pg_catalog.octet_length(p_eligibility_evidence::text) > 67108864 THEN
    RAISE EXCEPTION 'score-input manifest evidence exceeds resource bounds'
      USING ERRCODE = '54000';
  END IF;
  IF p_valid_until IS NULL OR NOT pg_catalog.isfinite(p_valid_until) THEN
    RAISE EXCEPTION 'score-input manifest valid_until must be finite'
      USING ERRCODE = '22023';
  END IF;

  -- The scorer is the validation authority for the exact nine-field input
  -- shape, identity uniqueness, finite numeric domain, and 64k/64MiB bounds.
  v_scorer_result := arena.compute_arena_scores_v4_json(p_period, p_inputs);
  IF v_scorer_result->>'contract' IS DISTINCT FROM 'arena-score-v4-pg17@1'
     OR v_scorer_result->>'digestAlgorithm'
        IS DISTINCT FROM 'pg17-jsonb-utf8-sha256@1'
     OR v_scorer_result->>'inputDigest' !~ '^[0-9a-f]{64}$'
     OR v_scorer_result->>'outputDigest' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'private PG17 scorer returned an invalid envelope'
      USING ERRCODE = '55000';
  END IF;

  -- Ranking requires an observed finite PnL. The private scorer intentionally
  -- accepts null for lower-level experiments, so the leaderboard manifest must
  -- narrow that domain explicitly. JSON number zero and losses remain valid;
  -- missing, null, string, object, array, and boolean PnL fail closed.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
    WHERE pg_catalog.jsonb_typeof(input_row.value->'pnl')
          IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'leaderboard score-input PnL must be a finite JSON number'
      USING ERRCODE = '22023';
  END IF;

  -- Rebuild canonical inputs from the same parsed float8/integer domain as the
  -- scorer. This removes caller array order and numeric-spelling differences.
  WITH decoded AS MATERIALIZED (
    SELECT
      input_row.value->>'source' AS source,
      input_row.value->>'source_trader_id' AS source_trader_id,
      (input_row.value->>'roi')::double precision AS roi,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'pnl') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'pnl')::double precision
      END AS pnl,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'max_drawdown') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'max_drawdown')::double precision
      END AS max_drawdown,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'win_rate') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'win_rate')::double precision
      END AS win_rate,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'sharpe_ratio') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'sharpe_ratio')::double precision
      END AS sharpe_ratio,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'profit_factor') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'profit_factor')::double precision
      END AS profit_factor,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'trades_count') = 'null'
        THEN NULL::bigint
        ELSE (input_row.value->>'trades_count')::numeric::bigint
      END AS trades_count
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'source', decoded.source,
        'source_trader_id', decoded.source_trader_id,
        'roi', decoded.roi,
        'pnl', decoded.pnl,
        'max_drawdown', decoded.max_drawdown,
        'win_rate', decoded.win_rate,
        'sharpe_ratio', decoded.sharpe_ratio,
        'profit_factor', decoded.profit_factor,
        'trades_count', decoded.trades_count
      )
      ORDER BY
        decoded.source COLLATE "C",
        decoded.source_trader_id COLLATE "C"
    ),
    '[]'::jsonb
  )
  INTO STRICT v_canonical_inputs
  FROM decoded;

  IF (v_scorer_result->>'inputCount')::integer
       IS DISTINCT FROM pg_catalog.jsonb_array_length(v_canonical_inputs) THEN
    RAISE EXCEPTION 'canonical input count disagrees with private PG17 scorer'
      USING ERRCODE = '55000';
  END IF;
  v_recomputed_input_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'contract', 'arena-score-v4-pg17-input@1',
          'period', p_period,
          'inputs', v_canonical_inputs
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  IF v_scorer_result->>'inputDigest'
       IS DISTINCT FROM v_recomputed_input_digest THEN
    RAISE EXCEPTION 'canonical inputs disagree with private PG17 input digest'
      USING ERRCODE = '55000';
  END IF;

  v_definition_basis := pg_catalog.jsonb_build_object(
    'contract', 'arena-score-v4-pg17-definition@1',
    'postgresMajor', 17,
    'round2Definition', pg_catalog.pg_get_functiondef(v_round_oid),
    'scorerDefinition', pg_catalog.pg_get_functiondef(v_scorer_oid)
  );
  v_definition_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_definition_basis::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  IF v_definition_digest IS DISTINCT FROM
       'e9b7df87cd33d5c63aebd733f34b57cc0d4b19006c3db2421ddd298e376d4f3c' THEN
    RAISE EXCEPTION 'private PG17 scorer definition digest drifted'
      USING ERRCODE = '55000';
  END IF;

  v_source_basis := pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-score-source-evidence@1',
    'sourceBundleDigest', p_source_bundle_digest,
    'scoreRowsDigest', p_score_rows_sha256,
    'physicalBoardsDigest', p_physical_boards_sha256,
    'evidence', p_source_evidence
  );
  v_source_evidence_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_source_basis::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_enrichment_basis := pg_catalog.jsonb_build_object(
    'contract', p_enrichment_contract,
    'evidence', p_enrichment_evidence
  );
  v_enrichment_evidence_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_enrichment_basis::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_eligibility_basis := pg_catalog.jsonb_build_object(
    'contract', p_eligibility_contract,
    'evidence', p_eligibility_evidence
  );
  v_eligibility_evidence_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_eligibility_basis::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  -- The returned value is the complete digest basis. UUID and insertion time
  -- are intentionally absent so identical evidence content is idempotent.
  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-score-input-manifest@1',
    'digestAlgorithm', 'pg17-jsonb-utf8-sha256@1',
    'period', p_period,
    'scorer', pg_catalog.jsonb_build_object(
      'contract', v_scorer_result->>'contract',
      'definitionContract', 'arena-score-v4-pg17-definition@1',
      'definitionDigest', v_definition_digest,
      'inputDigest', v_scorer_result->>'inputDigest',
      'outputDigest', v_scorer_result->>'outputDigest'
    ),
    'source', v_source_basis || pg_catalog.jsonb_build_object(
      'evidenceDigest', v_source_evidence_digest
    ),
    'enrichment', v_enrichment_basis || pg_catalog.jsonb_build_object(
      'evidenceDigest', v_enrichment_evidence_digest
    ),
    'eligibility', v_eligibility_basis || pg_catalog.jsonb_build_object(
      'evidenceDigest', v_eligibility_evidence_digest
    ),
    'inputCount', pg_catalog.jsonb_array_length(v_canonical_inputs),
    'inputs', v_canonical_inputs,
    'outputs', v_scorer_result->'outputs',
    'validUntil', pg_catalog.to_jsonb(
      pg_catalog.to_char(
        p_valid_until AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    )
  );
END;
$function$;
  END IF;
END
$rebind_manifest_v1_encoder$;

DO $rebind_manifest_v2_encoder$
BEGIN
  IF pg_catalog.to_regprocedure('arena.encode_leaderboard_score_input_manifest_v2(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)') IS NOT NULL THEN
CREATE OR REPLACE FUNCTION arena.encode_leaderboard_score_input_manifest_v2(p_period text, p_source_bundle_digest text, p_score_rows_sha256 text, p_physical_boards_sha256 text, p_source_evidence jsonb, p_enrichment_contract text, p_enrichment_evidence jsonb, p_eligibility_contract text, p_eligibility_evidence jsonb, p_inputs jsonb, p_valid_until timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
 SET extra_float_digits TO '3'
 SET quote_all_identifiers TO 'off'
AS $function$
DECLARE
  v_scorer_oid oid := pg_catalog.to_regprocedure(
    'arena.compute_arena_scores_v5_json(text,jsonb)'
  );
  v_round_oid oid := pg_catalog.to_regprocedure(
    'arena.arena_score_v4_round2(double precision)'
  );
  v_scorer_result jsonb;
  v_canonical_inputs jsonb;
  v_recomputed_input_digest text;
  v_definition_basis jsonb;
  v_definition_digest text;
  v_source_basis jsonb;
  v_source_evidence_digest text;
  v_enrichment_basis jsonb;
  v_enrichment_evidence_digest text;
  v_eligibility_basis jsonb;
  v_eligibility_evidence_digest text;
BEGIN
  IF v_scorer_oid IS NULL OR v_round_oid IS NULL THEN
    RAISE EXCEPTION 'private PG17 Arena Score v5 scorer is unavailable'
      USING ERRCODE = '55000';
  END IF;
  IF p_source_bundle_digest IS NULL
     OR p_source_bundle_digest !~ '^[0-9a-f]{64}$'
     OR p_score_rows_sha256 IS NULL
     OR p_score_rows_sha256 !~ '^[0-9a-f]{64}$'
     OR p_physical_boards_sha256 IS NULL
     OR p_physical_boards_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'source bundle, score-row, and physical-board digests must be lowercase sha256'
      USING ERRCODE = '22023';
  END IF;
  IF p_enrichment_contract IS NULL
     OR p_enrichment_contract IS DISTINCT FROM pg_catalog.btrim(p_enrichment_contract)
     OR p_enrichment_contract !~ '^[a-z0-9][a-z0-9._:@/-]{0,127}$'
     OR p_eligibility_contract IS NULL
     OR p_eligibility_contract IS DISTINCT FROM pg_catalog.btrim(p_eligibility_contract)
     OR p_eligibility_contract !~ '^[a-z0-9][a-z0-9._:@/-]{0,127}$' THEN
    RAISE EXCEPTION 'evidence contract identifiers are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF p_source_evidence IS NULL
     OR pg_catalog.jsonb_typeof(p_source_evidence) <> 'object'
     OR p_enrichment_evidence IS NULL
     OR pg_catalog.jsonb_typeof(p_enrichment_evidence) <> 'object'
     OR p_eligibility_evidence IS NULL
     OR pg_catalog.jsonb_typeof(p_eligibility_evidence) <> 'object' THEN
    RAISE EXCEPTION 'source, enrichment, and eligibility evidence must be JSON objects'
      USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.octet_length(p_source_evidence::text) > 16777216
     OR pg_catalog.octet_length(p_enrichment_evidence::text) > 33554432
     OR pg_catalog.octet_length(p_eligibility_evidence::text) > 16777216
     OR pg_catalog.octet_length(p_source_evidence::text)
        + pg_catalog.octet_length(p_enrichment_evidence::text)
        + pg_catalog.octet_length(p_eligibility_evidence::text) > 67108864 THEN
    RAISE EXCEPTION 'score-input manifest evidence exceeds resource bounds'
      USING ERRCODE = '54000';
  END IF;
  IF p_valid_until IS NULL OR NOT pg_catalog.isfinite(p_valid_until) THEN
    RAISE EXCEPTION 'score-input manifest valid_until must be finite'
      USING ERRCODE = '22023';
  END IF;

  -- The scorer is the validation authority for the exact nine-field input
  -- shape, identity uniqueness, finite numeric domain, and 64k/64MiB bounds.
  v_scorer_result := arena.compute_arena_scores_v5_json(p_period, p_inputs);
  IF v_scorer_result->>'contract' IS DISTINCT FROM 'arena-score-v5-pg17@1'
     OR v_scorer_result->>'digestAlgorithm'
        IS DISTINCT FROM 'pg17-jsonb-utf8-sha256@1'
     OR v_scorer_result->>'inputDigest' !~ '^[0-9a-f]{64}$'
     OR v_scorer_result->>'outputDigest' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'private PG17 scorer returned an invalid envelope'
      USING ERRCODE = '55000';
  END IF;

  -- Ranking requires an observed finite PnL. The private scorer intentionally
  -- accepts null for lower-level experiments, so the leaderboard manifest must
  -- narrow that domain explicitly. JSON number zero and losses remain valid;
  -- missing, null, string, object, array, and boolean PnL fail closed.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
    WHERE pg_catalog.jsonb_typeof(input_row.value->'pnl')
          IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'leaderboard score-input PnL must be a finite JSON number'
      USING ERRCODE = '22023';
  END IF;

  -- V2 ranking inputs require concrete risk observations. A trusted zero is a
  -- number, while null or a 100% drawdown cap remains outside public ranking.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
    WHERE pg_catalog.jsonb_typeof(input_row.value->'win_rate')
            IS DISTINCT FROM 'number'
       OR pg_catalog.jsonb_typeof(input_row.value->'max_drawdown')
            IS DISTINCT FROM 'number'
       OR (input_row.value->>'win_rate')::numeric < 0
       OR (input_row.value->>'win_rate')::numeric > 100
       OR (input_row.value->>'max_drawdown')::numeric < 0
       OR (input_row.value->>'max_drawdown')::numeric >= 100
  ) THEN
    RAISE EXCEPTION 'v2 leaderboard score inputs require win rate in [0,100] and maximum drawdown in [0,100)'
      USING ERRCODE = '22023';
  END IF;

  -- Rebuild canonical inputs from the same parsed float8/integer domain as the
  -- scorer. This removes caller array order and numeric-spelling differences.
  WITH decoded AS MATERIALIZED (
    SELECT
      input_row.value->>'source' AS source,
      input_row.value->>'source_trader_id' AS source_trader_id,
      (input_row.value->>'roi')::double precision AS roi,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'pnl') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'pnl')::double precision
      END AS pnl,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'max_drawdown') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'max_drawdown')::double precision
      END AS max_drawdown,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'win_rate') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'win_rate')::double precision
      END AS win_rate,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'sharpe_ratio') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'sharpe_ratio')::double precision
      END AS sharpe_ratio,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'profit_factor') = 'null'
        THEN NULL::double precision
        ELSE (input_row.value->>'profit_factor')::double precision
      END AS profit_factor,
      CASE WHEN pg_catalog.jsonb_typeof(input_row.value->'trades_count') = 'null'
        THEN NULL::bigint
        ELSE (input_row.value->>'trades_count')::numeric::bigint
      END AS trades_count
    FROM pg_catalog.jsonb_array_elements(p_inputs) AS input_row(value)
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'source', decoded.source,
        'source_trader_id', decoded.source_trader_id,
        'roi', decoded.roi,
        'pnl', decoded.pnl,
        'max_drawdown', decoded.max_drawdown,
        'win_rate', decoded.win_rate,
        'sharpe_ratio', decoded.sharpe_ratio,
        'profit_factor', decoded.profit_factor,
        'trades_count', decoded.trades_count
      )
      ORDER BY
        decoded.source COLLATE "C",
        decoded.source_trader_id COLLATE "C"
    ),
    '[]'::jsonb
  )
  INTO STRICT v_canonical_inputs
  FROM decoded;

  IF (v_scorer_result->>'inputCount')::integer
       IS DISTINCT FROM pg_catalog.jsonb_array_length(v_canonical_inputs) THEN
    RAISE EXCEPTION 'canonical input count disagrees with private PG17 scorer'
      USING ERRCODE = '55000';
  END IF;
  v_recomputed_input_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'contract', 'arena-score-v5-pg17-input@1',
          'period', p_period,
          'inputs', v_canonical_inputs
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  IF v_scorer_result->>'inputDigest'
       IS DISTINCT FROM v_recomputed_input_digest THEN
    RAISE EXCEPTION 'canonical inputs disagree with private PG17 input digest'
      USING ERRCODE = '55000';
  END IF;

  v_definition_basis := pg_catalog.jsonb_build_object(
    'contract', 'arena-score-v5-pg17-definition@1',
    'postgresMajor', 17,
    'round2Definition', pg_catalog.pg_get_functiondef(v_round_oid),
    'scorerDefinition', pg_catalog.pg_get_functiondef(v_scorer_oid)
  );
  v_definition_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_definition_basis::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  IF v_definition_digest IS DISTINCT FROM
       '88a12a95d593e26a96f421a1269605147f79481e751aa8f82c30dc69747a1450' THEN
    RAISE EXCEPTION 'private PG17 scorer definition digest drifted'
      USING ERRCODE = '55000';
  END IF;

  v_source_basis := pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-score-source-evidence@1',
    'sourceBundleDigest', p_source_bundle_digest,
    'scoreRowsDigest', p_score_rows_sha256,
    'physicalBoardsDigest', p_physical_boards_sha256,
    'evidence', p_source_evidence
  );
  v_source_evidence_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_source_basis::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_enrichment_basis := pg_catalog.jsonb_build_object(
    'contract', p_enrichment_contract,
    'evidence', p_enrichment_evidence
  );
  v_enrichment_evidence_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_enrichment_basis::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  v_eligibility_basis := pg_catalog.jsonb_build_object(
    'contract', p_eligibility_contract,
    'evidence', p_eligibility_evidence
  );
  v_eligibility_evidence_digest := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_eligibility_basis::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  -- The returned value is the complete digest basis. UUID and insertion time
  -- are intentionally absent so identical evidence content is idempotent.
  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-score-input-manifest@2',
    'digestAlgorithm', 'pg17-jsonb-utf8-sha256@1',
    'period', p_period,
    'scorer', pg_catalog.jsonb_build_object(
      'contract', v_scorer_result->>'contract',
      'definitionContract', 'arena-score-v5-pg17-definition@1',
      'definitionDigest', v_definition_digest,
      'inputDigest', v_scorer_result->>'inputDigest',
      'outputDigest', v_scorer_result->>'outputDigest'
    ),
    'source', v_source_basis || pg_catalog.jsonb_build_object(
      'evidenceDigest', v_source_evidence_digest
    ),
    'enrichment', v_enrichment_basis || pg_catalog.jsonb_build_object(
      'evidenceDigest', v_enrichment_evidence_digest
    ),
    'eligibility', v_eligibility_basis || pg_catalog.jsonb_build_object(
      'evidenceDigest', v_eligibility_evidence_digest
    ),
    'inputCount', pg_catalog.jsonb_array_length(v_canonical_inputs),
    'inputs', v_canonical_inputs,
    'outputs', v_scorer_result->'outputs',
    'validUntil', pg_catalog.to_jsonb(
      pg_catalog.to_char(
        p_valid_until AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    )
  );
END;
$function$;
  END IF;
END
$rebind_manifest_v2_encoder$;

DO $postflight$
DECLARE
  v_v4 oid := 'arena.compute_arena_scores_v4_json(text,jsonb)'::pg_catalog.regprocedure;
  v_v5 oid := 'arena.compute_arena_scores_v5_json(text,jsonb)'::pg_catalog.regprocedure;
  v_round2 oid := 'arena.arena_score_v4_round2(double precision)'::pg_catalog.regprocedure;
  v_e1 oid := pg_catalog.to_regprocedure('arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)');
  v_e2 oid := pg_catalog.to_regprocedure('arena.encode_leaderboard_score_input_manifest_v2(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)');
BEGIN
  IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((SELECT f.prosrc FROM pg_catalog.pg_proc AS f WHERE f.oid = v_v4), 'UTF8')), 'hex') <> '2d411eec5ed8ea49781044137d2b364fa757495e474a19bd05a4a49621971506'
     OR pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((SELECT f.prosrc FROM pg_catalog.pg_proc AS f WHERE f.oid = v_v5), 'UTF8')), 'hex') <> '7fd11db674ca4b64d85915aff30b6b15f7e6ef4b481fc19c90bfea307766e11b'
     OR (v_e1 IS NOT NULL AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((SELECT f.prosrc FROM pg_catalog.pg_proc AS f WHERE f.oid = v_e1), 'UTF8')), 'hex') <> 'dc3b4e81c9d1b402575458ace2a25984f71e566e3170f72e670bd35563c24d80')
     OR (v_e2 IS NOT NULL AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((SELECT f.prosrc FROM pg_catalog.pg_proc AS f WHERE f.oid = v_e2), 'UTF8')), 'hex') <> '8a7b1989797d557b9756213481dcb0663ca6f0598dd7a4293184109fe2032f15') THEN
    RAISE EXCEPTION 'true-zero-trades scorer change did not install the reviewed sources';
  END IF;
  IF pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'contract', 'arena-score-v4-pg17-definition@1',
      'postgresMajor', 17,
      'round2Definition', pg_catalog.pg_get_functiondef(v_round2),
      'scorerDefinition', pg_catalog.pg_get_functiondef(v_v4)
    )::text, 'UTF8'), 'sha256'), 'hex') <> 'e9b7df87cd33d5c63aebd733f34b57cc0d4b19006c3db2421ddd298e376d4f3c'
     OR pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object(
      'contract', 'arena-score-v5-pg17-definition@1',
      'postgresMajor', 17,
      'round2Definition', pg_catalog.pg_get_functiondef(v_round2),
      'scorerDefinition', pg_catalog.pg_get_functiondef(v_v5)
    )::text, 'UTF8'), 'sha256'), 'hex') <> '88a12a95d593e26a96f421a1269605147f79481e751aa8f82c30dc69747a1450' THEN
    RAISE EXCEPTION 'new scorer definition digests differ from the encoder pins';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS f
    WHERE f.pronamespace IN (
        pg_catalog.to_regnamespace('arena'), pg_catalog.to_regnamespace('public')
      )
      AND (
        pg_catalog.strpos(f.prosrc, 'da0e644623441dfa6e50ca957c607350216175f0e9172ce156f1c3be129b1e33') > 0
        OR pg_catalog.strpos(f.prosrc, 'e4c88c9ffb921ac4a66813f9485eaa0ddd353e48f1db51129cf7ed00a3b9d324') > 0
      )
  ) THEN
    RAISE EXCEPTION 'a function still pins an old Arena Score definition digest';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS f
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))
    ) AS privilege_row
    WHERE f.oid IN (v_v4, v_v5, v_round2)
      AND privilege_row.privilege_type = 'EXECUTE'
      AND privilege_row.grantee <> f.proowner
  ) THEN
    RAISE EXCEPTION 'Arena Score scorers must stay owner-only after the true-zero-trades change';
  END IF;
END
$postflight$;

COMMIT;
