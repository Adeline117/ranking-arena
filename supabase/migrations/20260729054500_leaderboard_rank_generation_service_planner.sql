-- Service-role planning surface for the dormant leaderboard generation
-- substrate.  These RPCs do not mutate leaderboard_ranks or generation heads:
-- they seal one immutable PG17 scorer manifest and derive the exact typed batch
-- and write-set digests that a later claim/stage/finalize flow must present.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regtype(
          'arena.leaderboard_rank_batch_row_v1'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.seal_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])'
        ) IS NULL THEN
    RAISE EXCEPTION
      'leaderboard generation service planner dependencies are unavailable';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION arena.decode_leaderboard_rank_batch_rows_v1(
  p_rows jsonb
)
RETURNS arena.leaderboard_rank_batch_row_v1[]
LANGUAGE plpgsql
STABLE
CALLED ON NULL INPUT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  v_rows arena.leaderboard_rank_batch_row_v1[];
  v_row_count integer;
BEGIN
  IF p_rows IS NULL
     OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
     OR pg_catalog.jsonb_array_length(p_rows) < 1
     OR pg_catalog.jsonb_array_length(p_rows) > 1000 THEN
    RAISE EXCEPTION 'rank batch rows must be an array with 1..1000 members'
      USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.octet_length(
       pg_catalog.convert_to(p_rows::text, 'UTF8')
     ) > 67108864 THEN
    RAISE EXCEPTION 'rank batch rows exceed 64 MiB'
      USING ERRCODE = '54000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
    WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
       OR NOT item.value ?& ARRAY[
         'source',
         'source_type',
         'source_trader_id',
         'rank',
         'arena_score',
         'roi',
         'pnl',
         'win_rate',
         'max_drawdown',
         'followers',
         'trades_count',
         'handle',
         'avatar_url',
         'profitability_score',
         'risk_control_score',
         'execution_score',
         'score_completeness',
         'trading_style',
         'avg_holding_hours',
         'style_confidence',
         'sharpe_ratio',
         'sortino_ratio',
         'profit_factor',
         'calmar_ratio',
         'trader_type',
         'is_outlier',
         'metrics_estimated',
         'rank_change',
         'is_new',
         'copiers',
         'arena_score_v4',
         'arena_score_v3',
         'score_factors'
       ]
       OR (
         SELECT pg_catalog.count(*)
         FROM pg_catalog.jsonb_object_keys(item.value)
       ) <> 33
  ) THEN
    RAISE EXCEPTION 'rank batch rows have a noncanonical object shape'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.array_agg(
    decoded.row_value ORDER BY item.ordinality
  )
  INTO STRICT v_rows
  FROM pg_catalog.jsonb_array_elements(p_rows)
    WITH ORDINALITY AS item(value, ordinality)
  CROSS JOIN LATERAL (
    SELECT pg_catalog.jsonb_populate_record(
      NULL::arena.leaderboard_rank_batch_row_v1,
      item.value
    ) AS row_value
  ) AS decoded;

  v_row_count := pg_catalog.cardinality(v_rows);
  IF v_row_count IS DISTINCT FROM pg_catalog.jsonb_array_length(p_rows)
     OR pg_catalog.array_ndims(v_rows) IS DISTINCT FROM 1
     OR pg_catalog.array_lower(v_rows, 1) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'rank batch row decoding changed cardinality'
      USING ERRCODE = '55000';
  END IF;

  -- Manifest attestation chunks use this exact bytewise identity order.
  -- Rejecting disorder here prevents a digest that can be planned but can
  -- never later be staged.
  IF EXISTS (
    WITH ordered AS (
      SELECT
        position,
        (v_rows[position]).source AS source,
        (v_rows[position]).source_trader_id AS source_trader_id,
        (v_rows[position - 1]).source AS prior_source,
        (v_rows[position - 1]).source_trader_id AS prior_source_trader_id
      FROM pg_catalog.generate_series(2, v_row_count) AS index_row(position)
    )
    SELECT 1
    FROM ordered
    WHERE ROW(
      ordered.prior_source COLLATE pg_catalog."C",
      ordered.prior_source_trader_id COLLATE pg_catalog."C"
    ) >= ROW(
      ordered.source COLLATE pg_catalog."C",
      ordered.source_trader_id COLLATE pg_catalog."C"
    )
  ) THEN
    RAISE EXCEPTION 'rank batch identities are not in strict bytewise order'
      USING ERRCODE = '22023';
  END IF;

  RETURN v_rows;
END;
$body$;

CREATE OR REPLACE FUNCTION public.prepare_leaderboard_score_input_manifest_v1(
  p_period text,
  p_source_bundle_digest text,
  p_score_rows_sha256 text,
  p_physical_boards_sha256 text,
  p_source_evidence jsonb,
  p_enrichment_contract text,
  p_enrichment_evidence jsonb,
  p_eligibility_contract text,
  p_eligibility_evidence jsonb,
  p_inputs jsonb,
  p_valid_until timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  RETURN arena.seal_leaderboard_score_input_manifest_v1(
    p_period,
    p_source_bundle_digest,
    p_score_rows_sha256,
    p_physical_boards_sha256,
    p_source_evidence,
    p_enrichment_contract,
    p_enrichment_evidence,
    p_eligibility_contract,
    p_eligibility_evidence,
    p_inputs,
    p_valid_until
  );
END;
$body$;

CREATE OR REPLACE FUNCTION public.plan_leaderboard_rank_generation_batch_v1(
  p_season_id text,
  p_score_cohort_id uuid,
  p_computed_at timestamptz,
  p_rows jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
CALLED ON NULL INPUT
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
AS $body$
DECLARE
  v_rows arena.leaderboard_rank_batch_row_v1[];
BEGIN
  v_rows := arena.decode_leaderboard_rank_batch_rows_v1(p_rows);
  RETURN arena.build_leaderboard_rank_typed_batch_evidence_v1(
    p_season_id,
    p_score_cohort_id,
    p_computed_at,
    v_rows
  );
END;
$body$;

CREATE OR REPLACE FUNCTION public.plan_leaderboard_rank_generation_write_set_v1(
  p_season_id text,
  p_score_cohort_id uuid,
  p_score_input_manifest_digest text,
  p_computed_at timestamptz,
  p_expected_rank_count integer,
  p_batch_sha256_plan text[]
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
CALLED ON NULL INPUT
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
AS $body$
DECLARE
  v_write_set_sha256 text;
BEGIN
  v_write_set_sha256 :=
    arena.build_leaderboard_rank_generation_write_set_sha256_v1(
      p_season_id,
      p_score_cohort_id,
      p_score_input_manifest_digest,
      p_computed_at,
      p_expected_rank_count,
      p_batch_sha256_plan
    );

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-rank-generation-write-set-plan@1',
    'season_id', p_season_id,
    'score_cohort_id', p_score_cohort_id,
    'expected_rank_count', p_expected_rank_count,
    'expected_batch_count', pg_catalog.cardinality(p_batch_sha256_plan),
    'write_set_sha256', v_write_set_sha256
  );
END;
$body$;

ALTER FUNCTION arena.decode_leaderboard_rank_batch_rows_v1(jsonb)
  OWNER TO postgres;
ALTER FUNCTION public.prepare_leaderboard_score_input_manifest_v1(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb, timestamptz
) OWNER TO postgres;
ALTER FUNCTION public.plan_leaderboard_rank_generation_batch_v1(
  text, uuid, timestamptz, jsonb
) OWNER TO postgres;
ALTER FUNCTION public.plan_leaderboard_rank_generation_write_set_v1(
  text, uuid, text, timestamptz, integer, text[]
) OWNER TO postgres;

REVOKE ALL ON FUNCTION arena.decode_leaderboard_rank_batch_rows_v1(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prepare_leaderboard_score_input_manifest_v1(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.plan_leaderboard_rank_generation_batch_v1(
  text, uuid, timestamptz, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.plan_leaderboard_rank_generation_write_set_v1(
  text, uuid, text, timestamptz, integer, text[]
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.prepare_leaderboard_score_input_manifest_v1(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb, timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.plan_leaderboard_rank_generation_batch_v1(
  text, uuid, timestamptz, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.plan_leaderboard_rank_generation_write_set_v1(
  text, uuid, text, timestamptz, integer, text[]
) TO service_role;

COMMENT ON FUNCTION arena.decode_leaderboard_rank_batch_rows_v1(jsonb) IS
  'Owner-only strict JSON decoder for one canonical 1..1000 row typed rank-generation batch.';
COMMENT ON FUNCTION public.prepare_leaderboard_score_input_manifest_v1(
  text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb, timestamptz
) IS
  'Service-role wrapper that seals immutable source/enrichment/eligibility evidence and PG17 scorer outputs. It performs no rank publication.';
COMMENT ON FUNCTION public.plan_leaderboard_rank_generation_batch_v1(
  text, uuid, timestamptz, jsonb
) IS
  'Service-role planner for the exact persisted typed-batch digest later required by staging.';
COMMENT ON FUNCTION public.plan_leaderboard_rank_generation_write_set_v1(
  text, uuid, text, timestamptz, integer, text[]
) IS
  'Service-role planner for the immutable generation write-set digest required by claim.';

NOTIFY pgrst, 'reload schema';

COMMIT;
