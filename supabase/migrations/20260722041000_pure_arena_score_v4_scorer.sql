-- Migration: 20260722041000_pure_arena_score_v4_scorer.sql
-- Description: Install a private, pure PostgreSQL 17 Arena Score v4 scorer
-- plus its exact round2 helper. PostgreSQL 17 is the future single authoritative
-- scorer after cutover; pg_catalog.ln does not promise bit-exact equivalence
-- with V8 Math.log for every Float64 input. Before cutover, a live-cohort exact
-- output/rank/digest canary must pass; any drift fails closed. This migration is
-- deliberately inert: it reads no production relation, writes no leaderboard
-- row, and grants no API role permission to execute the scorer.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_digest_oid oid := pg_catalog.to_regprocedure('extensions.digest(bytea,text)');
BEGIN
  IF pg_catalog.to_regnamespace('arena') IS NULL THEN
    RAISE EXCEPTION 'arena schema must exist before installing the pure v4 scorer';
  END IF;
  IF pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'PostgREST API roles must exist before installing the pure v4 scorer';
  END IF;
  IF pg_catalog.to_regprocedure(
       'arena.compute_arena_scores_v4_json(text,jsonb)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'pure Arena Score v4 scorer signature already exists; audit before install';
  END IF;
  IF pg_catalog.to_regprocedure(
       'arena.arena_score_v4_round2(double precision)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'Arena Score v4 round2 helper signature already exists; audit before install';
  END IF;
  IF v_digest_oid IS NULL THEN
    RAISE EXCEPTION 'extensions.digest(bytea,text) must exist before installing the pure v4 scorer';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS digest_row
    WHERE digest_row.oid = v_digest_oid
      AND (digest_row.provolatile <> 'i' OR digest_row.proparallel <> 's')
  ) THEN
    RAISE EXCEPTION 'extensions.digest(bytea,text) must be immutable and parallel safe';
  END IF;
END
$preflight$;

-- currency.js 2.0.4 does not round the decimal text produced by PostgreSQL's
-- ordinary float8::numeric cast. It multiplies the IEEE-754 value by 100,
-- applies Number#toFixed(4), then Math.round, then divides by 100. Decode the
-- scaled float's bits to its exact decimal rational before those two rounding
-- steps so values just below a half-cent stay below it.
CREATE FUNCTION arena.arena_score_v4_round2(p_value double precision)
RETURNS double precision
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $round2$
DECLARE
  v_scaled double precision;
  v_bits bytea;
  v_exponent integer;
  v_binary_exponent integer;
  v_mantissa numeric;
  v_exact_scaled numeric;
  v_fixed4 numeric;
BEGIN
  IF p_value < 0
     OR p_value > 100
     OR p_value = 'NaN'::double precision
     OR p_value = 'Infinity'::double precision
     OR p_value = '-Infinity'::double precision THEN
    RAISE EXCEPTION 'Arena Score v4 round2 accepts only finite values between 0 and 100'
      USING ERRCODE = '22023';
  END IF;
  IF p_value = 0 THEN
    RETURN 0::double precision;
  END IF;

  v_scaled := p_value * 100::double precision;
  IF v_scaled = 'Infinity'::double precision THEN
    RAISE EXCEPTION 'Arena Score v4 round2 scaled value must remain finite'
      USING ERRCODE = '22023';
  END IF;

  v_bits := pg_catalog.float8send(v_scaled);
  v_exponent := (
    (pg_catalog.get_byte(v_bits, 0) & 127) << 4
  ) | (pg_catalog.get_byte(v_bits, 1) >> 4);
  v_mantissa :=
      (pg_catalog.get_byte(v_bits, 1) & 15)::numeric * 281474976710656::numeric
    + pg_catalog.get_byte(v_bits, 2)::numeric * 1099511627776::numeric
    + pg_catalog.get_byte(v_bits, 3)::numeric * 4294967296::numeric
    + pg_catalog.get_byte(v_bits, 4)::numeric * 16777216::numeric
    + pg_catalog.get_byte(v_bits, 5)::numeric * 65536::numeric
    + pg_catalog.get_byte(v_bits, 6)::numeric * 256::numeric
    + pg_catalog.get_byte(v_bits, 7)::numeric;

  IF v_exponent = 0 THEN
    v_binary_exponent := -1074;
  ELSE
    v_mantissa := v_mantissa + 4503599627370496::numeric;
    v_binary_exponent := v_exponent - 1075;
  END IF;

  IF v_binary_exponent >= 0 THEN
    v_exact_scaled := v_mantissa * pg_catalog.power(
      2::numeric,
      v_binary_exponent::numeric
    );
  ELSE
    v_exact_scaled := v_mantissa
      * pg_catalog.power(5::numeric, (-v_binary_exponent)::numeric)
      / pg_catalog.power(10::numeric, (-v_binary_exponent)::numeric);
  END IF;

  v_fixed4 := pg_catalog.round(v_exact_scaled, 4);
  RETURN pg_catalog.floor(v_fixed4 + 0.5::numeric)::double precision
    / 100::double precision;
END;
$round2$;

CREATE FUNCTION arena.compute_arena_scores_v4_json(
  p_period text,
  p_inputs jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
SET extra_float_digits = '3'
AS $scorer$
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
        WHEN percentiles.trades_count IS NULL OR percentiles.trades_count <= 0
          THEN 0.3::double precision
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
$scorer$;

REVOKE ALL
  ON FUNCTION arena.compute_arena_scores_v4_json(text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL
  ON FUNCTION arena.arena_score_v4_round2(double precision)
  FROM PUBLIC, anon, authenticated, service_role;

-- A hostile ALTER DEFAULT PRIVILEGES can grant a newly-created function to an
-- arbitrary non-API role. Private means owner-only here, so remove every
-- inherited non-owner EXECUTE grant instead of assuming a closed role list.
DO $owner_only_acl$
DECLARE
  v_signature text;
  v_role record;
BEGIN
  FOR v_signature IN
    SELECT signature.value
    FROM pg_catalog.unnest(ARRAY[
      'arena.arena_score_v4_round2(double precision)',
      'arena.compute_arena_scores_v4_json(text,jsonb)'
    ]::text[]) AS signature(value)
  LOOP
    FOR v_role IN
      SELECT DISTINCT pg_catalog.pg_get_userbyid(privilege_row.grantee) AS role_name
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS privilege_row
      WHERE function_row.oid = pg_catalog.to_regprocedure(v_signature)
        AND privilege_row.privilege_type = 'EXECUTE'
        AND privilege_row.grantee NOT IN (0, function_row.proowner)
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION %s FROM %I',
        v_signature,
        v_role.role_name
      );
    END LOOP;
  END LOOP;
END
$owner_only_acl$;

COMMENT ON FUNCTION arena.arena_score_v4_round2(double precision) IS
  'Private exact currency.js 2.0.4 round2 helper for Arena Score fields in the closed interval [0,100].';
COMMENT ON FUNCTION arena.compute_arena_scores_v4_json(text, jsonb) IS
  'Private immutable Arena Score v4 PG17 math contract. PostgreSQL 17 is the future single authoritative scorer after cutover; arbitrary Float64 inputs are not promised bit-exact V8 Math.log equivalence. Cutover requires an exact live-cohort output/rank/digest canary and fails closed on drift. Pure parameters only; no production relation reads or writes.';

DO $postflight$
DECLARE
  v_function_oid oid := pg_catalog.to_regprocedure(
    'arena.compute_arena_scores_v4_json(text,jsonb)'
  );
  v_round_oid oid := pg_catalog.to_regprocedure(
    'arena.arena_score_v4_round2(double precision)'
  );
BEGIN
  IF v_function_oid IS NULL OR v_round_oid IS NULL THEN
    RAISE EXCEPTION 'pure Arena Score v4 scorer or exact round2 helper was not created';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid IN (v_function_oid, v_round_oid)
      AND (
        function_row.provolatile <> 'i'
        OR function_row.prosecdef
        OR function_row.proparallel <> 's'
        OR function_row.proconfig IS NULL
        OR NOT ('search_path=pg_catalog, pg_temp' = ANY(function_row.proconfig))
      )
  ) THEN
    RAISE EXCEPTION 'pure Arena Score v4 scorer catalog contract drifted';
  END IF;
  IF pg_catalog.has_function_privilege(
       'anon',
       'arena.compute_arena_scores_v4_json(text,jsonb)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'arena.compute_arena_scores_v4_json(text,jsonb)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'arena.compute_arena_scores_v4_json(text,jsonb)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'arena.arena_score_v4_round2(double precision)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'arena.arena_score_v4_round2(double precision)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'arena.arena_score_v4_round2(double precision)',
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS privilege_row
       WHERE function_row.oid IN (v_function_oid, v_round_oid)
         AND privilege_row.grantee <> function_row.proowner
         AND privilege_row.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'pure Arena Score v4 scorer is executable by a non-owner role';
  END IF;
END
$postflight$;

COMMIT;
