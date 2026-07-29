-- Activate the private rank-generation staging substrate without exposing its
-- tables.  Batches are durably staged and attested while the current sealed
-- leaderboard remains untouched.  One service-role finalizer then validates
-- the complete generation and performs live upsert, exact cleanup, terminal
-- rerank, proof seal, and head CAS in one PostgreSQL transaction.

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
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_generation_stage_batches'
        ) IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_generation_stage_rows'
        ) IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_generation_batch_receipts'
        ) IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_manifest_attestations'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.decode_leaderboard_rank_batch_rows_v1(jsonb)'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'public.cleanup_leaderboard_rank_publication(text,uuid,jsonb)'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'public.rerank_leaderboard_publication(text,uuid)'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'public.seal_leaderboard_rank_publication(text,uuid,jsonb)'
        ) IS NULL THEN
    RAISE EXCEPTION
      'atomic leaderboard generation publication dependencies are unavailable';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.stage_leaderboard_rank_generation_batch_v1(
  p_season_id text,
  p_generation_seq bigint,
  p_score_cohort_id uuid,
  p_batch_index integer,
  p_score_input_manifest_id uuid,
  p_score_input_manifest_digest text,
  p_batch_sha256_plan text[],
  p_rows jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
SET lock_timeout = '10s'
AS $body$
DECLARE
  v_rows arena.leaderboard_rank_batch_row_v1[];
  v_claim arena.leaderboard_rank_generation_claims%ROWTYPE;
  v_head arena.leaderboard_rank_generation_heads%ROWTYPE;
  v_existing arena.leaderboard_rank_generation_stage_batches%ROWTYPE;
  v_manifest arena.leaderboard_score_input_manifests%ROWTYPE;
  v_verification jsonb;
  v_evidence jsonb;
  v_expected_write_set text;
  v_attestation_chunks jsonb;
  v_attestation_chunk_plan jsonb;
  v_manifest_valid_until timestamptz;
  v_chunks_sha256 text;
  v_positive_count integer;
  v_chunk_count integer;
  v_prior_batch_count integer;
  v_prior_row_count integer;
  v_inserted_count integer;
  v_updated_count integer;
  v_staged_at timestamptz;
  v_expected_phase text;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <>
       'read committed' THEN
    RAISE EXCEPTION 'rank batch staging requires READ COMMITTED isolation'
      USING ERRCODE = '25001';
  END IF;

  IF p_season_id IS NULL
     OR p_season_id NOT IN ('7D', '30D', '90D')
     OR p_generation_seq IS NULL
     OR p_generation_seq <= 0
     OR p_generation_seq > 9007199254740000
     OR p_score_cohort_id IS NULL
     OR p_batch_index IS NULL
     OR p_batch_index < 0
     OR p_batch_index >= 64
     OR p_score_input_manifest_id IS NULL
     OR p_score_input_manifest_digest IS NULL
     OR p_score_input_manifest_digest !~ '^[0-9a-f]{64}$'
     OR p_batch_sha256_plan IS NULL THEN
    RAISE EXCEPTION 'rank batch staging header is invalid'
      USING ERRCODE = '22023';
  END IF;

  v_rows := arena.decode_leaderboard_rank_batch_rows_v1(p_rows);

  SELECT claim.*
  INTO v_claim
  FROM ONLY arena.leaderboard_rank_generation_claims AS claim
  WHERE claim.season_id = p_season_id
    AND claim.generation_seq = p_generation_seq
    AND claim.score_cohort_id = p_score_cohort_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rank batch staging has no exact generation claim'
      USING ERRCODE = '23503';
  END IF;

  v_evidence := arena.build_leaderboard_rank_typed_batch_evidence_v1(
    p_season_id,
    p_score_cohort_id,
    v_claim.computed_at,
    v_rows
  );
  v_expected_write_set :=
    arena.build_leaderboard_rank_generation_write_set_sha256_v1(
      p_season_id,
      p_score_cohort_id,
      p_score_input_manifest_digest,
      v_claim.computed_at,
      v_claim.expected_rank_count,
      p_batch_sha256_plan
    );

  IF pg_catalog.cardinality(p_batch_sha256_plan) IS DISTINCT FROM
       v_claim.expected_batch_count
     OR p_batch_index >= v_claim.expected_batch_count
     OR (v_evidence->>'row_count')::integer IS DISTINCT FROM
          LEAST(
            1000,
            v_claim.expected_rank_count - p_batch_index * 1000
          )
     OR p_batch_sha256_plan[p_batch_index + 1] IS DISTINCT FROM
          v_evidence->>'batch_sha256'
     OR v_expected_write_set IS DISTINCT FROM v_claim.write_set_sha256 THEN
    RAISE EXCEPTION 'rank batch staging disagrees with immutable generation plan'
      USING ERRCODE = '22023';
  END IF;

  -- Response-loss replay is immutable and does not require a still-live lease.
  SELECT staged.*
  INTO v_existing
  FROM ONLY arena.leaderboard_rank_generation_stage_batches AS staged
  WHERE staged.season_id = p_season_id
    AND staged.generation_seq = p_generation_seq
    AND staged.batch_index = p_batch_index;

  IF FOUND THEN
    IF v_existing.score_cohort_id IS DISTINCT FROM p_score_cohort_id
       OR v_existing.score_input_manifest_id IS DISTINCT FROM
            p_score_input_manifest_id
       OR v_existing.score_input_manifest_digest IS DISTINCT FROM
            p_score_input_manifest_digest
       OR v_existing.batch_sha256_plan IS DISTINCT FROM
            p_batch_sha256_plan
       OR v_existing.batch_sha256 IS DISTINCT FROM
            v_evidence->>'batch_sha256'
       OR v_existing.row_count IS DISTINCT FROM
            (v_evidence->>'row_count')::integer
       OR v_existing.source_count IS DISTINCT FROM
            (v_evidence->>'source_count')::integer
       OR v_existing.first_source IS DISTINCT FROM
            v_evidence->>'first_source'
       OR v_existing.first_source_trader_id IS DISTINCT FROM
            v_evidence->>'first_source_trader_id'
       OR v_existing.last_source IS DISTINCT FROM
            v_evidence->>'last_source'
       OR v_existing.last_source_trader_id IS DISTINCT FROM
            v_evidence->>'last_source_trader_id' THEN
      RAISE EXCEPTION 'rank batch staging replay conflicts with immutable stage'
        USING ERRCODE = '55000';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'contract', 'leaderboard-rank-generation-batch-stage@1',
      'season_id', v_existing.season_id,
      'generation_seq', v_existing.generation_seq,
      'score_cohort_id', v_existing.score_cohort_id,
      'phase', 'writing',
      'batch_index', v_existing.batch_index,
      'batch_sha256', v_existing.batch_sha256,
      'row_count', v_existing.row_count,
      'source_count', v_existing.source_count,
      'staged_at', pg_catalog.to_char(
        v_existing.staged_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    );
  END IF;

  SELECT head.*
  INTO STRICT v_head
  FROM ONLY arena.leaderboard_rank_generation_heads AS head
  WHERE head.season_id = p_season_id
  FOR UPDATE;

  SELECT claim.*
  INTO STRICT v_claim
  FROM ONLY arena.leaderboard_rank_generation_claims AS claim
  WHERE claim.season_id = p_season_id
    AND claim.generation_seq = p_generation_seq
    AND claim.score_cohort_id = p_score_cohort_id
  FOR SHARE;

  v_staged_at := pg_catalog.clock_timestamp();
  v_expected_phase := CASE
    WHEN p_batch_index = 0 THEN 'claimed'
    ELSE 'writing'
  END;

  IF v_head.generation_seq IS DISTINCT FROM p_generation_seq
     OR v_head.score_cohort_id IS DISTINCT FROM p_score_cohort_id
     OR v_head.phase IS DISTINCT FROM v_expected_phase
     OR v_head.lease_expires_at IS DISTINCT FROM v_claim.lease_expires_at
     OR v_head.lease_expires_at <= v_staged_at THEN
    RAISE EXCEPTION 'rank batch staging lost its generation lease'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    COALESCE(pg_catalog.sum(staged.row_count), 0)::integer
  INTO STRICT v_prior_batch_count, v_prior_row_count
  FROM ONLY arena.leaderboard_rank_generation_stage_batches AS staged
  WHERE staged.season_id = p_season_id
    AND staged.generation_seq = p_generation_seq;

  IF v_prior_batch_count IS DISTINCT FROM p_batch_index
     OR v_prior_row_count IS DISTINCT FROM p_batch_index * 1000
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.generate_series(0, p_batch_index - 1) AS planned(i)
       LEFT JOIN ONLY arena.leaderboard_rank_generation_stage_batches AS prior
         ON prior.season_id = p_season_id
        AND prior.generation_seq = p_generation_seq
        AND prior.batch_index = planned.i
       WHERE prior.batch_index IS NULL
          OR prior.score_cohort_id IS DISTINCT FROM p_score_cohort_id
          OR prior.batch_sha256 IS DISTINCT FROM
               p_batch_sha256_plan[planned.i + 1]
          OR prior.batch_sha256_plan IS DISTINCT FROM p_batch_sha256_plan
     ) THEN
    RAISE EXCEPTION 'rank batch staging requires a contiguous canonical prefix'
      USING ERRCODE = '22023';
  END IF;

  IF p_batch_index = 0 THEN
    SELECT stored.*
    INTO v_manifest
    FROM ONLY arena.leaderboard_score_input_manifests AS stored
    WHERE stored.manifest_id = p_score_input_manifest_id
      AND stored.manifest_digest = p_score_input_manifest_digest
      AND stored.period = p_season_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'rank batch staging manifest is unavailable'
        USING ERRCODE = '23503';
    END IF;

    v_verification :=
      arena.verify_leaderboard_score_input_manifest_v1(
        p_score_input_manifest_id
      );
    IF v_verification->>'contract' IS DISTINCT FROM
         'leaderboard-score-input-manifest-verification@1'
       OR (v_verification->>'contentValid')::boolean IS DISTINCT FROM true
       OR (v_verification->>'valid')::boolean IS DISTINCT FROM true
       OR v_verification->>'manifestDigest' IS DISTINCT FROM
            p_score_input_manifest_digest
       OR v_manifest.valid_until < v_claim.lease_expires_at
       OR v_manifest.valid_until <= v_staged_at THEN
      RAISE EXCEPTION 'rank batch staging requires one live verified manifest'
        USING ERRCODE = '55000';
    END IF;
    v_manifest_valid_until := v_manifest.valid_until;

    WITH manifest_pairs AS MATERIALIZED (
      SELECT
        COALESCE(
          input_row.ordinality,
          output_row.ordinality
        )::integer AS manifest_position,
        input_row.value AS input_value,
        output_row.value AS output_value
      FROM pg_catalog.jsonb_array_elements(
        v_manifest.manifest->'inputs'
      ) WITH ORDINALITY AS input_row(value, ordinality)
      FULL JOIN pg_catalog.jsonb_array_elements(
        v_manifest.manifest->'outputs'
      ) WITH ORDINALITY AS output_row(value, ordinality)
        USING (ordinality)
    ),
    positive_source AS MATERIALIZED (
      SELECT
        pair.*,
        pg_catalog.row_number() OVER (
          ORDER BY pair.manifest_position
        )::integer AS positive_position,
        (pair.output_value#>>'{factors,roi}')::double precision
          AS factor_roi,
        (pair.output_value#>>'{factors,pnl}')::double precision
          AS factor_pnl,
        (pair.output_value#>>'{factors,drawdown}')::double precision
          AS factor_drawdown,
        (pair.output_value#>>'{factors,sharpe}')::double precision
          AS factor_sharpe,
        (pair.output_value#>>'{factors,consistency}')::double precision
          AS factor_consistency
      FROM manifest_pairs AS pair
      WHERE (pair.output_value->>'totalScore')::numeric > 0
    ),
    positive AS MATERIALIZED (
      SELECT
        source.positive_position,
        source.input_value->>'source' AS source,
        source.input_value->>'source_trader_id' AS source_trader_id,
        arena.build_leaderboard_rank_manifest_field_commitment_v1(
          source.output_value->>'source',
          source.output_value->>'sourceTraderId',
          (source.input_value->>'roi')::numeric,
          (source.input_value->>'pnl')::numeric,
          (source.input_value->>'win_rate')::numeric,
          (source.input_value->>'max_drawdown')::numeric,
          (source.input_value->>'sharpe_ratio')::numeric,
          (source.input_value->>'profit_factor')::numeric,
          (source.input_value->>'trades_count')::integer,
          (source.output_value->>'totalScore')::numeric,
          source.output_value->'factors',
          pg_catalog.floor(
            100::double precision * (
              0.3::double precision * source.factor_pnl +
              0.2::double precision * source.factor_roi
            ) / 0.5::double precision + 0.5::double precision
          )::numeric(6, 2),
          CASE
            WHEN source.factor_drawdown IS NULL
                 AND source.factor_sharpe IS NULL
              THEN 0::numeric(6, 2)
            WHEN source.factor_drawdown IS NULL
              THEN pg_catalog.floor(
                100::double precision * source.factor_sharpe +
                  0.5::double precision
              )::numeric(6, 2)
            WHEN source.factor_sharpe IS NULL
              THEN pg_catalog.floor(
                100::double precision * source.factor_drawdown +
                  0.5::double precision
              )::numeric(6, 2)
            ELSE pg_catalog.floor(
              100::double precision * (
                source.factor_drawdown + source.factor_sharpe
              ) / 2::double precision + 0.5::double precision
            )::numeric(6, 2)
          END,
          CASE
            WHEN source.factor_consistency IS NULL
              THEN NULL::numeric(6, 2)
            ELSE pg_catalog.floor(
              100::double precision * source.factor_consistency +
                0.5::double precision
            )::numeric(6, 2)
          END
        ) AS field_commitment
      FROM positive_source AS source
    ),
    chunked AS MATERIALIZED (
      SELECT
        ((positive.positive_position - 1) / 1000)::integer
          AS chunk_index,
        pg_catalog.min(positive.positive_position)::integer
          AS first_position,
        pg_catalog.count(*)::integer AS row_count,
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_array(
            positive.source,
            positive.source_trader_id
          )
          ORDER BY positive.positive_position
        ) AS identities,
        pg_catalog.jsonb_agg(
          pg_catalog.to_jsonb(positive.field_commitment)
          ORDER BY positive.positive_position
        ) AS field_commitments
      FROM positive
      GROUP BY ((positive.positive_position - 1) / 1000)::integer
    ),
    hashed AS MATERIALIZED (
      SELECT
        chunked.*,
        arena.build_leaderboard_rank_manifest_chunk_sha256_v1(
          p_season_id,
          p_generation_seq,
          p_score_cohort_id,
          p_score_input_manifest_id,
          p_score_input_manifest_digest,
          chunked.chunk_index,
          chunked.first_position,
          chunked.row_count,
          chunked.identities,
          chunked.field_commitments
        ) AS chunk_sha256
      FROM chunked
    )
    SELECT
      pg_catalog.count(*)::integer,
      COALESCE(pg_catalog.sum(hashed.row_count), 0)::integer,
      COALESCE(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'chunk_index', hashed.chunk_index,
            'first_position', hashed.first_position,
            'row_count', hashed.row_count,
            'identities', hashed.identities,
            'field_commitments', hashed.field_commitments,
            'chunk_sha256', hashed.chunk_sha256
          )
          ORDER BY hashed.chunk_index
        ),
        '[]'::jsonb
      ),
      COALESCE(
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_array(
            hashed.chunk_index,
            hashed.first_position,
            hashed.row_count,
            hashed.chunk_sha256
          )
          ORDER BY hashed.chunk_index
        ),
        '[]'::jsonb
      )
    INTO STRICT
      v_chunk_count,
      v_positive_count,
      v_attestation_chunks,
      v_attestation_chunk_plan
    FROM hashed;

    IF v_positive_count IS DISTINCT FROM v_claim.expected_rank_count
       OR v_chunk_count IS DISTINCT FROM v_claim.expected_batch_count
       OR pg_catalog.jsonb_array_length(v_attestation_chunks)
            IS DISTINCT FROM v_chunk_count THEN
      RAISE EXCEPTION
        'rank batch staging manifest positive cohort disagrees with claim'
        USING ERRCODE = '22023';
    END IF;

    v_chunks_sha256 :=
      arena.build_leaderboard_rank_manifest_chunks_sha256_v1(
        p_season_id,
        p_generation_seq,
        p_score_cohort_id,
        p_score_input_manifest_id,
        p_score_input_manifest_digest,
        v_positive_count,
        v_chunk_count,
        v_attestation_chunk_plan
      );

    SET CONSTRAINTS
      arena.rank_manifest_attestation_batch_zero_fkey,
      arena.leaderboard_rank_manifest_attestations_complete
      DEFERRED;

    INSERT INTO arena.leaderboard_rank_generation_manifest_bindings (
      contract,
      season_id,
      generation_seq,
      score_cohort_id,
      score_input_manifest_id,
      score_input_manifest_digest,
      bound_at
    ) VALUES (
      'leaderboard-rank-generation-manifest-binding@1',
      p_season_id,
      p_generation_seq,
      p_score_cohort_id,
      p_score_input_manifest_id,
      p_score_input_manifest_digest,
      v_staged_at
    );
  ELSE
    SELECT header.manifest_valid_until
    INTO v_manifest_valid_until
    FROM ONLY arena.leaderboard_rank_manifest_attestations AS header
    WHERE header.season_id = p_season_id
      AND header.generation_seq = p_generation_seq
      AND header.score_cohort_id = p_score_cohort_id
      AND header.score_input_manifest_id = p_score_input_manifest_id
      AND header.score_input_manifest_digest =
            p_score_input_manifest_digest;
    IF NOT FOUND OR v_manifest_valid_until <= v_staged_at THEN
      RAISE EXCEPTION 'later rank batch has no live manifest attestation'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  INSERT INTO arena.leaderboard_rank_generation_batch_receipts (
    contract,
    season_id,
    generation_seq,
    score_cohort_id,
    batch_index,
    batch_sha256,
    score_input_manifest_id,
    score_input_manifest_digest,
    row_count,
    source_count,
    first_source,
    first_source_trader_id,
    last_source,
    last_source_trader_id,
    completed_at
  ) VALUES (
    'leaderboard-rank-generation-batch-receipt@1',
    p_season_id,
    p_generation_seq,
    p_score_cohort_id,
    p_batch_index,
    v_evidence->>'batch_sha256',
    p_score_input_manifest_id,
    p_score_input_manifest_digest,
    (v_evidence->>'row_count')::integer,
    (v_evidence->>'source_count')::integer,
    v_evidence->>'first_source',
    v_evidence->>'first_source_trader_id',
    v_evidence->>'last_source',
    v_evidence->>'last_source_trader_id',
    v_staged_at
  );

  IF p_batch_index = 0 THEN
    INSERT INTO arena.leaderboard_rank_manifest_attestations (
      contract,
      season_id,
      generation_seq,
      score_cohort_id,
      score_input_manifest_id,
      score_input_manifest_digest,
      batch_index,
      manifest_valid_until,
      positive_count,
      chunk_count,
      chunks_sha256,
      attested_at
    ) VALUES (
      'leaderboard-rank-manifest-attestation@1',
      p_season_id,
      p_generation_seq,
      p_score_cohort_id,
      p_score_input_manifest_id,
      p_score_input_manifest_digest,
      0,
      v_manifest_valid_until,
      v_positive_count,
      v_chunk_count,
      v_chunks_sha256,
      v_staged_at
    );

    INSERT INTO arena.leaderboard_rank_manifest_attestation_chunks (
      contract,
      season_id,
      generation_seq,
      score_cohort_id,
      score_input_manifest_id,
      score_input_manifest_digest,
      chunk_index,
      first_position,
      row_count,
      identities,
      field_commitments,
      chunk_sha256
    )
    SELECT
      'leaderboard-rank-manifest-attestation-chunk@1',
      p_season_id,
      p_generation_seq,
      p_score_cohort_id,
      p_score_input_manifest_id,
      p_score_input_manifest_digest,
      (chunk.value->>'chunk_index')::integer,
      (chunk.value->>'first_position')::integer,
      (chunk.value->>'row_count')::integer,
      chunk.value->'identities',
      chunk.value->'field_commitments',
      chunk.value->>'chunk_sha256'
    FROM pg_catalog.jsonb_array_elements(v_attestation_chunks)
      AS chunk(value)
    ORDER BY (chunk.value->>'chunk_index')::integer;
  END IF;

  INSERT INTO arena.leaderboard_rank_generation_stage_batches (
    contract,
    season_id,
    generation_seq,
    score_cohort_id,
    batch_index,
    score_input_manifest_id,
    score_input_manifest_digest,
    batch_sha256_plan,
    batch_sha256,
    row_count,
    source_count,
    first_source,
    first_source_trader_id,
    last_source,
    last_source_trader_id,
    staged_at
  ) VALUES (
    'leaderboard-rank-generation-stage-batch@1',
    p_season_id,
    p_generation_seq,
    p_score_cohort_id,
    p_batch_index,
    p_score_input_manifest_id,
    p_score_input_manifest_digest,
    p_batch_sha256_plan,
    v_evidence->>'batch_sha256',
    (v_evidence->>'row_count')::integer,
    (v_evidence->>'source_count')::integer,
    v_evidence->>'first_source',
    v_evidence->>'first_source_trader_id',
    v_evidence->>'last_source',
    v_evidence->>'last_source_trader_id',
    v_staged_at
  );

  INSERT INTO arena.leaderboard_rank_generation_stage_rows (
    contract,
    season_id,
    generation_seq,
    score_cohort_id,
    batch_index,
    batch_position,
    source,
    source_trader_id,
    row_payload,
    staged_at
  )
  SELECT
    'leaderboard-rank-generation-stage-row@1',
    p_season_id,
    p_generation_seq,
    p_score_cohort_id,
    p_batch_index,
    position,
    (v_rows[position]).source,
    (v_rows[position]).source_trader_id,
    v_rows[position],
    v_staged_at
  FROM pg_catalog.generate_subscripts(v_rows, 1) AS index_row(position)
  ORDER BY position;
  GET DIAGNOSTICS v_inserted_count = ROW_COUNT;

  IF v_inserted_count IS DISTINCT FROM
       (v_evidence->>'row_count')::integer THEN
    RAISE EXCEPTION 'rank batch staging did not persist the complete typed batch'
      USING ERRCODE = '55000';
  END IF;

  UPDATE ONLY arena.leaderboard_rank_generation_heads AS head
  SET phase = 'writing',
      updated_at = v_staged_at
  WHERE head.season_id = p_season_id
    AND head.generation_seq = p_generation_seq
    AND head.score_cohort_id = p_score_cohort_id
    AND head.phase = v_expected_phase
    AND head.lease_expires_at = v_claim.lease_expires_at
    AND head.lease_expires_at > pg_catalog.clock_timestamp();
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'rank batch staging head compare-and-set failed'
      USING ERRCODE = '55000';
  END IF;

  -- Do not return an acknowledgement while any completeness edge is merely
  -- pending for transaction end. PostgREST normally gives one transaction per
  -- RPC, but forcing and then restoring these named constraints also makes
  -- nested owner-side callers observe the same response boundary.
  SET CONSTRAINTS
    arena.rank_manifest_attestation_batch_zero_fkey,
    arena.leaderboard_rank_manifest_attestations_complete,
    arena.rank_generation_stage_batch_binding_fkey,
    arena.rank_generation_stage_batch_attestation_fkey,
    arena.leaderboard_rank_generation_stage_batches_complete
    IMMEDIATE;
  SET CONSTRAINTS
    arena.rank_manifest_attestation_batch_zero_fkey,
    arena.leaderboard_rank_manifest_attestations_complete,
    arena.rank_generation_stage_batch_binding_fkey,
    arena.rank_generation_stage_batch_attestation_fkey,
    arena.leaderboard_rank_generation_stage_batches_complete
    DEFERRED;

  IF v_manifest_valid_until <= pg_catalog.clock_timestamp()
     OR v_claim.lease_expires_at <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION 'rank batch staging authority expired before commit'
      USING ERRCODE = '55000';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-rank-generation-batch-stage@1',
    'season_id', p_season_id,
    'generation_seq', p_generation_seq,
    'score_cohort_id', p_score_cohort_id,
    'phase', 'writing',
    'batch_index', p_batch_index,
    'batch_sha256', v_evidence->>'batch_sha256',
    'row_count', (v_evidence->>'row_count')::integer,
    'source_count', (v_evidence->>'source_count')::integer,
    'staged_at', pg_catalog.to_char(
      v_staged_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
END;
$body$;

CREATE OR REPLACE FUNCTION public.finalize_leaderboard_rank_generation_v1(
  p_season_id text,
  p_generation_seq bigint,
  p_score_cohort_id uuid,
  p_score_input_manifest_id uuid,
  p_score_input_manifest_digest text,
  p_source_publications jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET "TimeZone" = 'UTC'
SET lock_timeout = '10s'
AS $body$
DECLARE
  v_head arena.leaderboard_rank_generation_heads%ROWTYPE;
  v_claim arena.leaderboard_rank_generation_claims%ROWTYPE;
  v_attestation arena.leaderboard_rank_manifest_attestations%ROWTYPE;
  v_verification jsonb;
  v_cleanup_sources jsonb;
  v_cleanup_result jsonb;
  v_rerank_result jsonb;
  v_seal_result jsonb;
  v_stage_batch_count integer;
  v_stage_row_count integer;
  v_source_count integer;
  v_publication_identity_count integer;
  v_written_count integer;
  v_updated_count integer;
  v_now timestamptz;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <>
       'read committed' THEN
    RAISE EXCEPTION 'rank generation finalization requires READ COMMITTED isolation'
      USING ERRCODE = '25001';
  END IF;

  IF p_season_id IS NULL
     OR p_season_id NOT IN ('7D', '30D', '90D')
     OR p_generation_seq IS NULL
     OR p_generation_seq <= 0
     OR p_generation_seq > 9007199254740000
     OR p_score_cohort_id IS NULL
     OR p_score_input_manifest_id IS NULL
     OR p_score_input_manifest_digest IS NULL
     OR p_score_input_manifest_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'rank generation finalization header is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT head.*
  INTO STRICT v_head
  FROM ONLY arena.leaderboard_rank_generation_heads AS head
  WHERE head.season_id = p_season_id
  FOR UPDATE;

  -- Frozen response-loss replay.  The seal RPC revalidates that this exact
  -- cohort is still the current proof authority before any success response.
  IF v_head.generation_seq IS NOT DISTINCT FROM p_generation_seq
     AND v_head.score_cohort_id IS NOT DISTINCT FROM p_score_cohort_id
     AND v_head.phase = 'sealed'
     AND v_head.lease_expires_at IS NULL THEN
    v_seal_result := public.seal_leaderboard_rank_publication(
      p_season_id,
      p_score_cohort_id,
      p_source_publications
    );
    RETURN pg_catalog.jsonb_build_object(
      'contract', 'leaderboard-rank-generation-finalization@1',
      'season_id', p_season_id,
      'generation_seq', p_generation_seq,
      'score_cohort_id', p_score_cohort_id,
      'phase', 'sealed',
      'is_sealed', true,
      'replayed', true,
      'publication', v_seal_result
    );
  END IF;

  SELECT claim.*
  INTO v_claim
  FROM ONLY arena.leaderboard_rank_generation_claims AS claim
  WHERE claim.season_id = p_season_id
    AND claim.generation_seq = p_generation_seq
    AND claim.score_cohort_id = p_score_cohort_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rank generation finalization has no exact claim'
      USING ERRCODE = '23503';
  END IF;

  v_now := pg_catalog.clock_timestamp();
  IF v_head.generation_seq IS DISTINCT FROM p_generation_seq
     OR v_head.score_cohort_id IS DISTINCT FROM p_score_cohort_id
     OR v_head.phase IS DISTINCT FROM 'writing'
     OR v_head.lease_expires_at IS DISTINCT FROM v_claim.lease_expires_at
     OR v_head.lease_expires_at <= v_now THEN
    RAISE EXCEPTION 'rank generation finalization lost its exact live lease'
      USING ERRCODE = '55000';
  END IF;

  SELECT header.*
  INTO v_attestation
  FROM ONLY arena.leaderboard_rank_manifest_attestations AS header
  WHERE header.season_id = p_season_id
    AND header.generation_seq = p_generation_seq
    AND header.score_cohort_id = p_score_cohort_id
    AND header.score_input_manifest_id = p_score_input_manifest_id
    AND header.score_input_manifest_digest =
          p_score_input_manifest_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rank generation finalization has no exact attestation'
      USING ERRCODE = '23503';
  END IF;

  v_verification :=
    arena.verify_leaderboard_score_input_manifest_v1(
      p_score_input_manifest_id
    );
  IF v_verification->>'contract' IS DISTINCT FROM
       'leaderboard-score-input-manifest-verification@1'
     OR (v_verification->>'contentValid')::boolean IS DISTINCT FROM true
     OR (v_verification->>'valid')::boolean IS DISTINCT FROM true
     OR v_verification->>'manifestDigest' IS DISTINCT FROM
          p_score_input_manifest_digest
     OR v_attestation.manifest_valid_until <= v_now
     OR v_attestation.positive_count IS DISTINCT FROM
          v_claim.expected_rank_count
     OR v_attestation.chunk_count IS DISTINCT FROM
          v_claim.expected_batch_count THEN
    RAISE EXCEPTION 'rank generation finalization manifest authority is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    COALESCE(pg_catalog.sum(staged.row_count), 0)::integer
  INTO STRICT v_stage_batch_count, v_stage_row_count
  FROM ONLY arena.leaderboard_rank_generation_stage_batches AS staged
  WHERE staged.season_id = p_season_id
    AND staged.generation_seq = p_generation_seq
    AND staged.score_cohort_id = p_score_cohort_id;

  IF v_stage_batch_count IS DISTINCT FROM v_claim.expected_batch_count
     OR v_stage_row_count IS DISTINCT FROM v_claim.expected_rank_count
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.generate_series(
         0,
         v_claim.expected_batch_count - 1
       ) AS planned(i)
       LEFT JOIN ONLY arena.leaderboard_rank_generation_stage_batches AS staged
         ON staged.season_id = p_season_id
        AND staged.generation_seq = p_generation_seq
        AND staged.batch_index = planned.i
       LEFT JOIN ONLY arena.leaderboard_rank_generation_batch_receipts AS receipt
         ON receipt.season_id = staged.season_id
        AND receipt.generation_seq = staged.generation_seq
        AND receipt.batch_index = staged.batch_index
       LEFT JOIN ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
         ON chunk.season_id = staged.season_id
        AND chunk.generation_seq = staged.generation_seq
        AND chunk.chunk_index = staged.batch_index
       WHERE staged.batch_index IS NULL
          OR receipt.batch_index IS NULL
          OR chunk.chunk_index IS NULL
          OR staged.score_cohort_id IS DISTINCT FROM p_score_cohort_id
          OR staged.score_input_manifest_id IS DISTINCT FROM
               p_score_input_manifest_id
          OR staged.score_input_manifest_digest IS DISTINCT FROM
               p_score_input_manifest_digest
          OR staged.batch_sha256_plan[planned.i + 1] IS DISTINCT FROM
               staged.batch_sha256
          OR pg_catalog.cardinality(staged.batch_sha256_plan)
               IS DISTINCT FROM v_claim.expected_batch_count
          OR receipt.score_cohort_id IS DISTINCT FROM p_score_cohort_id
          OR receipt.batch_sha256 IS DISTINCT FROM staged.batch_sha256
          OR receipt.row_count IS DISTINCT FROM staged.row_count
          OR chunk.row_count IS DISTINCT FROM staged.row_count
     )
     OR EXISTS (
       SELECT 1
       FROM ONLY arena.leaderboard_rank_generation_stage_batches AS staged
       WHERE staged.season_id = p_season_id
         AND staged.generation_seq = p_generation_seq
         AND arena.build_leaderboard_rank_generation_write_set_sha256_v1(
               p_season_id,
               p_score_cohort_id,
               p_score_input_manifest_digest,
               v_claim.computed_at,
               v_claim.expected_rank_count,
               staged.batch_sha256_plan
             ) IS DISTINCT FROM v_claim.write_set_sha256
     )
     OR (
       SELECT pg_catalog.count(*)::integer
       FROM ONLY arena.leaderboard_rank_generation_stage_rows AS staged
       WHERE staged.season_id = p_season_id
         AND staged.generation_seq = p_generation_seq
         AND staged.score_cohort_id = p_score_cohort_id
     ) IS DISTINCT FROM v_claim.expected_rank_count
     OR EXISTS (
       SELECT 1
       FROM ONLY
         arena.leaderboard_rank_generation_source_fence_receipts AS receipt
       WHERE receipt.season_id = p_season_id
         AND receipt.generation_seq = p_generation_seq
     ) THEN
    RAISE EXCEPTION 'rank generation finalization found an incomplete or live-mutated stage'
      USING ERRCODE = '55000';
  END IF;

  IF p_source_publications IS NULL
     OR pg_catalog.jsonb_typeof(p_source_publications) <> 'array'
     OR pg_catalog.jsonb_array_length(p_source_publications) < 1
     OR pg_catalog.jsonb_array_length(p_source_publications) > 256
     OR pg_catalog.octet_length(
          pg_catalog.convert_to(p_source_publications::text, 'UTF8')
        ) > 67108864 THEN
    RAISE EXCEPTION 'final publication sources are outside resource bounds'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
    WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
       OR NOT item.value ?& ARRAY['source', 'source_as_of', 'trader_ids']
       OR (
         SELECT pg_catalog.count(*)
         FROM pg_catalog.jsonb_object_keys(item.value)
       ) <> 3
       OR pg_catalog.jsonb_typeof(item.value->'source') <> 'string'
       OR pg_catalog.jsonb_typeof(item.value->'source_as_of') <> 'string'
       OR pg_catalog.jsonb_typeof(item.value->'trader_ids') <> 'array'
       OR item.value->>'source' !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
       OR item.value->>'source' IS DISTINCT FROM
            pg_catalog.lower(pg_catalog.btrim(item.value->>'source'))
  ) OR EXISTS (
    SELECT item.value->>'source'
    FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
    GROUP BY item.value->>'source'
    HAVING pg_catalog.count(*) <> 1
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      item.value->'trader_ids'
    ) AS trader(value)
    WHERE pg_catalog.jsonb_typeof(trader.value) <> 'string'
       OR pg_catalog.btrim(trader.value #>> '{}') = ''
       OR trader.value #>> '{}' IS DISTINCT FROM
            pg_catalog.btrim(trader.value #>> '{}')
  ) THEN
    RAISE EXCEPTION 'final publication sources have an invalid shape'
      USING ERRCODE = '22023';
  END IF;

  SELECT
    pg_catalog.jsonb_array_length(p_source_publications),
    COALESCE(
      pg_catalog.sum(
        pg_catalog.jsonb_array_length(item.value->'trader_ids')
      ),
      0
    )::integer,
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'source', item.value->>'source',
        'trader_ids', COALESCE((
          SELECT pg_catalog.jsonb_agg(
            identity.value ORDER BY identity.value COLLATE pg_catalog."C"
          )
          FROM pg_catalog.jsonb_array_elements_text(
            item.value->'trader_ids'
          ) AS identity(value)
        ), '[]'::jsonb)
      )
      ORDER BY item.value->>'source' COLLATE pg_catalog."C"
    )
  INTO STRICT
    v_source_count,
    v_publication_identity_count,
    v_cleanup_sources
  FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value);

  IF v_publication_identity_count IS DISTINCT FROM
       v_claim.expected_rank_count THEN
    RAISE EXCEPTION 'final publication identity count disagrees with claim'
      USING ERRCODE = '22023';
  END IF;

  -- Freeze the registry before proving exact source authority, then take the
  -- same parent-rank lock used by cleanup/rerank/seal.  No live rank mutation
  -- occurs before every generation, manifest, batch, source, and identity
  -- precondition below has passed.
  LOCK TABLE arena.sources, arena.exchanges IN SHARE MODE;

  IF v_source_count IS DISTINCT FROM (
    SELECT pg_catalog.count(DISTINCT authority.filter_source)::integer
    FROM public.arena_freshness_expected_sources() AS authority
    WHERE authority.season_id = p_season_id
  ) OR EXISTS (
    WITH requested AS MATERIALIZED (
      SELECT item.value->>'source' AS source
      FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
    ),
    authority AS MATERIALIZED (
      SELECT DISTINCT expected.filter_source AS source
      FROM public.arena_freshness_expected_sources() AS expected
      WHERE expected.season_id = p_season_id
    ),
    differences AS (
      (SELECT requested.source FROM requested
       EXCEPT
       SELECT authority.source FROM authority)
      UNION ALL
      (SELECT authority.source FROM authority
       EXCEPT
       SELECT requested.source FROM requested)
    )
    SELECT 1 FROM differences
  ) THEN
    RAISE EXCEPTION 'final publication sources do not exactly cover authority'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    WITH expected AS MATERIALIZED (
      SELECT
        item.value->>'source' AS source,
        identity.value AS source_trader_id
      FROM pg_catalog.jsonb_array_elements(p_source_publications) AS item(value)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(
        item.value->'trader_ids'
      ) AS identity(value)
    ),
    staged AS MATERIALIZED (
      SELECT row.source, row.source_trader_id
      FROM ONLY arena.leaderboard_rank_generation_stage_rows AS row
      WHERE row.season_id = p_season_id
        AND row.generation_seq = p_generation_seq
        AND row.score_cohort_id = p_score_cohort_id
    ),
    differences AS (
      (SELECT expected.source, expected.source_trader_id FROM expected
       EXCEPT
       SELECT staged.source, staged.source_trader_id FROM staged)
      UNION ALL
      (SELECT staged.source, staged.source_trader_id FROM staged
       EXCEPT
       SELECT expected.source, expected.source_trader_id FROM expected)
    )
    SELECT 1 FROM differences
  ) THEN
    RAISE EXCEPTION 'final publication identities do not exactly match stage'
      USING ERRCODE = '23514';
  END IF;

  LOCK TABLE public.leaderboard_ranks IN SHARE ROW EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1
    FROM public.leaderboard_ranks AS rank_row
    WHERE rank_row.season_id = p_season_id
      AND rank_row.rank_publication_id = p_score_cohort_id
  ) OR EXISTS (
    SELECT 1
    FROM arena.leaderboard_rank_cleanup_receipts AS cleanup
    WHERE cleanup.score_cohort_id = p_score_cohort_id
  ) OR EXISTS (
    SELECT 1
    FROM arena.leaderboard_rank_publications AS publication
    WHERE publication.id = p_score_cohort_id
  ) THEN
    RAISE EXCEPTION 'active staged cohort already affected live publication state'
      USING ERRCODE = '55000';
  END IF;

  v_now := pg_catalog.clock_timestamp();
  IF v_claim.lease_expires_at <= v_now
     OR v_attestation.manifest_valid_until <= v_now THEN
    RAISE EXCEPTION 'rank generation authority expired before live cutover'
      USING ERRCODE = '55000';
  END IF;

  WITH written AS (
    INSERT INTO public.leaderboard_ranks AS rank_row (
      season_id,
      source,
      source_type,
      source_trader_id,
      rank,
      arena_score,
      roi,
      pnl,
      win_rate,
      max_drawdown,
      followers,
      trades_count,
      handle,
      avatar_url,
      computed_at,
      profitability_score,
      risk_control_score,
      execution_score,
      score_completeness,
      trading_style,
      avg_holding_hours,
      style_confidence,
      sharpe_ratio,
      sortino_ratio,
      profit_factor,
      calmar_ratio,
      trader_type,
      is_outlier,
      metrics_estimated,
      rank_change,
      is_new,
      copiers,
      arena_score_v4,
      arena_score_v3,
      score_factors,
      rank_publication_id
    )
    SELECT
      p_season_id,
      (staged.row_payload).source,
      (staged.row_payload).source_type,
      (staged.row_payload).source_trader_id,
      NULL,
      (staged.row_payload).arena_score,
      (staged.row_payload).roi,
      (staged.row_payload).pnl,
      (staged.row_payload).win_rate,
      (staged.row_payload).max_drawdown,
      (staged.row_payload).followers,
      (staged.row_payload).trades_count,
      (staged.row_payload).handle,
      (staged.row_payload).avatar_url,
      v_claim.computed_at,
      (staged.row_payload).profitability_score,
      (staged.row_payload).risk_control_score,
      (staged.row_payload).execution_score,
      (staged.row_payload).score_completeness,
      (staged.row_payload).trading_style,
      (staged.row_payload).avg_holding_hours,
      (staged.row_payload).style_confidence,
      (staged.row_payload).sharpe_ratio,
      (staged.row_payload).sortino_ratio,
      (staged.row_payload).profit_factor,
      (staged.row_payload).calmar_ratio,
      (staged.row_payload).trader_type,
      (staged.row_payload).is_outlier,
      (staged.row_payload).metrics_estimated,
      NULL,
      NULL,
      (staged.row_payload).copiers,
      (staged.row_payload).arena_score_v4,
      (staged.row_payload).arena_score_v3,
      (staged.row_payload).score_factors,
      p_score_cohort_id
    FROM ONLY arena.leaderboard_rank_generation_stage_rows AS staged
    WHERE staged.season_id = p_season_id
      AND staged.generation_seq = p_generation_seq
      AND staged.score_cohort_id = p_score_cohort_id
    ORDER BY staged.batch_index, staged.batch_position
    ON CONFLICT (season_id, source, source_trader_id)
    DO UPDATE SET
      source_type = EXCLUDED.source_type,
      rank = EXCLUDED.rank,
      arena_score = EXCLUDED.arena_score,
      roi = EXCLUDED.roi,
      pnl = EXCLUDED.pnl,
      win_rate = EXCLUDED.win_rate,
      max_drawdown = EXCLUDED.max_drawdown,
      followers = EXCLUDED.followers,
      trades_count = EXCLUDED.trades_count,
      handle = EXCLUDED.handle,
      avatar_url = EXCLUDED.avatar_url,
      computed_at = EXCLUDED.computed_at,
      profitability_score = EXCLUDED.profitability_score,
      risk_control_score = EXCLUDED.risk_control_score,
      execution_score = EXCLUDED.execution_score,
      score_completeness = EXCLUDED.score_completeness,
      trading_style = EXCLUDED.trading_style,
      avg_holding_hours = EXCLUDED.avg_holding_hours,
      style_confidence = EXCLUDED.style_confidence,
      sharpe_ratio = EXCLUDED.sharpe_ratio,
      sortino_ratio = EXCLUDED.sortino_ratio,
      profit_factor = EXCLUDED.profit_factor,
      calmar_ratio = EXCLUDED.calmar_ratio,
      trader_type = EXCLUDED.trader_type,
      is_outlier = EXCLUDED.is_outlier,
      metrics_estimated = EXCLUDED.metrics_estimated,
      rank_change = EXCLUDED.rank_change,
      is_new = EXCLUDED.is_new,
      copiers = EXCLUDED.copiers,
      arena_score_v4 = EXCLUDED.arena_score_v4,
      arena_score_v3 = EXCLUDED.arena_score_v3,
      score_factors = EXCLUDED.score_factors,
      rank_publication_id = EXCLUDED.rank_publication_id
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_written_count
  FROM written;

  IF v_written_count IS DISTINCT FROM v_claim.expected_rank_count THEN
    RAISE EXCEPTION 'atomic finalizer did not write the complete staged cohort'
      USING ERRCODE = '55000';
  END IF;

  v_cleanup_result := public.cleanup_leaderboard_rank_publication(
    p_season_id,
    p_score_cohort_id,
    v_cleanup_sources
  );

  UPDATE ONLY arena.leaderboard_rank_generation_heads AS head
  SET phase = 'cleaned',
      updated_at = pg_catalog.clock_timestamp()
  WHERE head.season_id = p_season_id
    AND head.generation_seq = p_generation_seq
    AND head.score_cohort_id = p_score_cohort_id
    AND head.phase = 'writing'
    AND head.lease_expires_at = v_claim.lease_expires_at
    AND head.lease_expires_at > pg_catalog.clock_timestamp();
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'atomic finalizer cleanup head compare-and-set failed'
      USING ERRCODE = '55000';
  END IF;

  v_rerank_result := public.rerank_leaderboard_publication(
    p_season_id,
    p_score_cohort_id
  );

  UPDATE ONLY arena.leaderboard_rank_generation_heads AS head
  SET phase = 'reranked',
      updated_at = pg_catalog.clock_timestamp()
  WHERE head.season_id = p_season_id
    AND head.generation_seq = p_generation_seq
    AND head.score_cohort_id = p_score_cohort_id
    AND head.phase = 'cleaned'
    AND head.lease_expires_at = v_claim.lease_expires_at
    AND head.lease_expires_at > pg_catalog.clock_timestamp();
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'atomic finalizer rerank head compare-and-set failed'
      USING ERRCODE = '55000';
  END IF;

  v_seal_result := public.seal_leaderboard_rank_publication(
    p_season_id,
    p_score_cohort_id,
    p_source_publications
  );
  IF v_seal_result->>'contract' IS DISTINCT FROM
       'leaderboard-rank-publication@1'
     OR (v_seal_result->>'is_sealed')::boolean IS DISTINCT FROM true
     OR v_seal_result->>'score_cohort_id' IS DISTINCT FROM
          p_score_cohort_id::text THEN
    RAISE EXCEPTION 'atomic finalizer received an invalid seal result'
      USING ERRCODE = '55000';
  END IF;

  UPDATE ONLY arena.leaderboard_rank_generation_heads AS head
  SET phase = 'sealed',
      lease_expires_at = NULL,
      updated_at = pg_catalog.clock_timestamp()
  WHERE head.season_id = p_season_id
    AND head.generation_seq = p_generation_seq
    AND head.score_cohort_id = p_score_cohort_id
    AND head.phase = 'reranked'
    AND head.lease_expires_at = v_claim.lease_expires_at
    AND head.lease_expires_at > pg_catalog.clock_timestamp();
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'atomic finalizer seal head compare-and-set failed'
      USING ERRCODE = '55000';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-rank-generation-finalization@1',
    'season_id', p_season_id,
    'generation_seq', p_generation_seq,
    'score_cohort_id', p_score_cohort_id,
    'phase', 'sealed',
    'is_sealed', true,
    'replayed', false,
    'cleanup', v_cleanup_result,
    'rerank', v_rerank_result,
    'publication', v_seal_result
  );
END;
$body$;

ALTER FUNCTION public.stage_leaderboard_rank_generation_batch_v1(
  text, bigint, uuid, integer, uuid, text, text[], jsonb
) OWNER TO postgres;
ALTER FUNCTION public.finalize_leaderboard_rank_generation_v1(
  text, bigint, uuid, uuid, text, jsonb
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.stage_leaderboard_rank_generation_batch_v1(
  text, bigint, uuid, integer, uuid, text, text[], jsonb
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.finalize_leaderboard_rank_generation_v1(
  text, bigint, uuid, uuid, text, jsonb
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.stage_leaderboard_rank_generation_batch_v1(
  text, bigint, uuid, integer, uuid, text, text[], jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_leaderboard_rank_generation_v1(
  text, bigint, uuid, uuid, text, jsonb
) TO service_role;

COMMENT ON FUNCTION public.stage_leaderboard_rank_generation_batch_v1(
  text, bigint, uuid, integer, uuid, text, text[], jsonb
) IS
  'Service-role attempt-bound typed batch stage. It creates immutable manifest/batch attestations but never mutates live leaderboard rows or public proofs.';
COMMENT ON FUNCTION public.finalize_leaderboard_rank_generation_v1(
  text, bigint, uuid, uuid, text, jsonb
) IS
  'Single-transaction live cutover for one complete staged generation: validate, upsert, exact cleanup, terminal rerank, proof seal, and terminal head CAS. Any error rolls back every live/public mutation.';

NOTIFY pgrst, 'reload schema';

COMMIT;
