-- Dormant owner-only canonical evidence for persisted leaderboard rank batches.
--
-- This migration performs no leaderboard DML and exposes no API RPC. The row
-- encoder gives one PG17-stable representation of every non-surrogate rank
-- field. The batch builder then reads and FOR SHARE-locks an exact, bounded
-- identity set before hashing the rows that PostgreSQL actually persisted.
-- These are write-phase primitives for a future atomic writer, not terminal
-- publication proof: cleanup, rerank, final source coverage, and sealing still
-- require their own generation-aware transactions.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL quote_all_identifiers = 'off';

DO $dependency_preflight$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL
     OR pg_catalog.to_regclass(
       'arena.leaderboard_rank_generation_batch_receipts'
     ) IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION
      'persisted rank codec requires PG17, leaderboard ranks, generation receipts, and exact API roles';
  END IF;
END
$dependency_preflight$;

-- Freeze the composite row type, partition topology, and receipt dependency
-- while the private functions are installed and attested.
LOCK TABLE ONLY public.leaderboard_ranks IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_batch_receipts
  IN SHARE MODE;

DO $rank_table_contract$
DECLARE
  v_column_count integer;
  v_column_mismatch_count integer;
  v_partition_count integer;
  v_partition_digest text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    WHERE table_row.oid = 'public.leaderboard_ranks'::pg_catalog.regclass
      AND table_row.relkind = 'p'
      AND table_row.relpersistence = 'p'
      AND table_row.relowner = 'postgres'::pg_catalog.regrole
      AND pg_catalog.pg_get_partkeydef(table_row.oid) = 'LIST (season_id)'
  ) THEN
    RAISE EXCEPTION 'leaderboard_ranks parent contract drifted';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_column_count
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.leaderboard_ranks'::pg_catalog.regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  WITH expected(column_name, formatted_type, not_null, uses_default_collation) AS (
    VALUES
      ('id', 'bigint', true, false),
      ('season_id', 'text', true, true),
      ('source', 'text', true, true),
      ('source_type', 'text', false, true),
      ('source_trader_id', 'text', true, true),
      ('rank', 'integer', false, false),
      ('arena_score', 'numeric(10,2)', false, false),
      ('roi', 'numeric(12,4)', false, false),
      ('pnl', 'numeric(18,2)', false, false),
      ('win_rate', 'numeric(5,2)', false, false),
      ('max_drawdown', 'numeric(5,2)', false, false),
      ('followers', 'integer', false, false),
      ('trades_count', 'integer', false, false),
      ('handle', 'text', false, true),
      ('avatar_url', 'text', false, true),
      ('computed_at', 'timestamp with time zone', false, false),
      ('profitability_score', 'numeric(6,2)', false, false),
      ('risk_control_score', 'numeric(6,2)', false, false),
      ('execution_score', 'numeric(6,2)', false, false),
      ('score_completeness', 'text', false, true),
      ('trading_style', 'text', false, true),
      ('avg_holding_hours', 'numeric(10,2)', false, false),
      ('style_confidence', 'numeric(6,4)', false, false),
      ('sharpe_ratio', 'numeric(10,4)', false, false),
      ('sortino_ratio', 'numeric(10,4)', false, false),
      ('profit_factor', 'numeric(10,4)', false, false),
      ('calmar_ratio', 'numeric(10,4)', false, false),
      ('trader_type', 'text', false, true),
      ('is_outlier', 'boolean', false, false),
      ('metrics_estimated', 'boolean', false, false),
      ('rank_change', 'integer', false, false),
      ('is_new', 'boolean', false, false),
      ('copiers', 'integer', false, false),
      ('arena_score_v4', 'numeric', false, false),
      ('arena_score_v3', 'numeric', false, false),
      ('score_factors', 'jsonb', false, false),
      ('rank_publication_id', 'uuid', false, false)
  )
  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_column_mismatch_count
  FROM expected
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = 'public.leaderboard_ranks'::pg_catalog.regclass
   AND attribute.attname = expected.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
     OR pg_catalog.format_type(
          attribute.atttypid,
          attribute.atttypmod
        ) IS DISTINCT FROM expected.formatted_type
     OR attribute.attnotnull IS DISTINCT FROM expected.not_null
     OR attribute.attidentity <> ''
     OR attribute.attgenerated <> ''
     OR (
       expected.uses_default_collation
       AND attribute.attcollation IS DISTINCT FROM
             'pg_catalog.default'::pg_catalog.regcollation
     )
     OR (
       NOT expected.uses_default_collation
       AND attribute.attcollation <> 0
     );

  IF v_column_count <> 37 OR v_column_mismatch_count <> 0 THEN
    RAISE EXCEPTION
      'leaderboard_ranks 37-column persisted codec contract drifted: columns %, mismatches %',
      v_column_count,
      v_column_mismatch_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_index AS index_row
      ON index_row.indexrelid = constraint_row.conindid
    WHERE constraint_row.conrelid =
          'public.leaderboard_ranks'::pg_catalog.regclass
      AND constraint_row.contype = 'u'
      AND constraint_row.convalidated
      AND index_row.indrelid = constraint_row.conrelid
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indislive
      AND pg_catalog.pg_get_constraintdef(
            constraint_row.oid,
            false
          ) = 'UNIQUE (season_id, source, source_trader_id)'
  ) THEN
    RAISE EXCEPTION
      'leaderboard_ranks canonical composite identity is not uniquely constrained';
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            child_namespace.nspname || '.' || child.relname || '|' ||
            child.relkind::text || '|' || child.relpersistence::text || '|' ||
            pg_catalog.pg_get_userbyid(child.relowner) || '|' ||
            pg_catalog.pg_get_expr(child.relpartbound, child.oid),
            E'\n'
            ORDER BY child_namespace.nspname COLLATE pg_catalog."C",
                     child.relname COLLATE pg_catalog."C"
          ),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO STRICT v_partition_count, v_partition_digest
  FROM pg_catalog.pg_inherits AS inheritance
  JOIN pg_catalog.pg_class AS child
    ON child.oid = inheritance.inhrelid
  JOIN pg_catalog.pg_namespace AS child_namespace
    ON child_namespace.oid = child.relnamespace
  WHERE inheritance.inhparent =
        'public.leaderboard_ranks'::pg_catalog.regclass;

  IF v_partition_count <> 4
     OR v_partition_digest IS DISTINCT FROM
          'ef570914223b68d4ce4f9c5e9217a2a6b0b052c79a6e660c71916441b4e4ab25' THEN
    RAISE EXCEPTION
      'leaderboard_ranks partition topology drifted: count %, digest %',
      v_partition_count,
      v_partition_digest;
  END IF;
END
$rank_table_contract$;

DO $codec_install_preflight$
DECLARE
  v_encoder oid := pg_catalog.to_regprocedure(
    'arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks)'
  );
  v_batch oid := pg_catalog.to_regprocedure(
    'arena.build_leaderboard_rank_batch_evidence_v1(text,uuid,jsonb)'
  );
BEGIN
  IF (v_encoder IS NULL) IS DISTINCT FROM (v_batch IS NULL) THEN
    RAISE EXCEPTION 'persisted rank codec is only partially installed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'arena'
      AND function_row.proname IN (
        'encode_leaderboard_rank_row_v1',
        'build_leaderboard_rank_batch_evidence_v1'
      )
      AND function_row.oid <> ALL (
        ARRAY_REMOVE(ARRAY[v_encoder, v_batch], NULL)::oid[]
      )
  ) THEN
    RAISE EXCEPTION 'persisted rank codec has a noncanonical overload';
  END IF;
END
$codec_install_preflight$;

DO $install_codec$
BEGIN
  IF pg_catalog.to_regprocedure(
       'arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks)'
     ) IS NULL THEN
    EXECUTE $encoder_ddl$
      CREATE FUNCTION arena.encode_leaderboard_rank_row_v1(
        p_rank public.leaderboard_ranks
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      STABLE
      STRICT
      PARALLEL SAFE
      SECURITY INVOKER
      SET search_path = pg_catalog, pg_temp
      SET "TimeZone" = 'UTC'
      AS $body$
      DECLARE
        v_factors jsonb := (p_rank).score_factors;
        v_factor_roi numeric;
        v_factor_pnl numeric;
        v_factor_drawdown numeric;
        v_factor_sharpe numeric;
        v_factor_consistency numeric;
        v_encoded_factors jsonb;
      BEGIN
        -- A leaderboard row is rankable only when its identity, metric basis,
        -- score, and publication cohort are all concrete. Partial/estimated/
        -- outlier observations remain profile data and are rejected here.
        IF (p_rank).season_id IS NULL
           OR (p_rank).season_id NOT IN ('7D', '30D', '90D')
           OR (p_rank).source IS NULL
           OR (p_rank).source !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
           OR (p_rank).source <> pg_catalog.lower(
                pg_catalog.btrim((p_rank).source)
              )
           OR pg_catalog.char_length((p_rank).source) > 128
           OR (p_rank).source_trader_id IS NULL
           OR (p_rank).source_trader_id <> pg_catalog.btrim(
                (p_rank).source_trader_id
              )
           OR (p_rank).source_trader_id = ''
           OR pg_catalog.char_length((p_rank).source_trader_id) > 512
           OR (p_rank).source_type IS NULL
           OR (p_rank).source_type NOT IN ('futures', 'spot', 'web3')
           OR (p_rank).rank_publication_id IS NULL
           OR (p_rank).score_completeness IS DISTINCT FROM 'full'
           OR (p_rank).metrics_estimated IS DISTINCT FROM false
           OR (p_rank).is_outlier IS DISTINCT FROM false THEN
          RAISE EXCEPTION
            'persisted leaderboard rank identity or trust state is not rank-eligible'
            USING ERRCODE = '22023';
        END IF;

        IF ((p_rank).rank IS NOT NULL AND (
              (p_rank).rank <= 0 OR (p_rank).rank > 64000
            ))
           OR ((p_rank).followers IS NOT NULL AND (p_rank).followers < 0)
           OR ((p_rank).copiers IS NOT NULL AND (p_rank).copiers < 0)
           OR ((p_rank).trades_count IS NOT NULL AND (p_rank).trades_count < 0)
           OR ((p_rank).handle IS NOT NULL AND
               pg_catalog.char_length((p_rank).handle) > 512)
           OR ((p_rank).avatar_url IS NOT NULL AND
               pg_catalog.char_length((p_rank).avatar_url) > 8192)
           OR ((p_rank).trading_style IS NOT NULL AND
               pg_catalog.char_length((p_rank).trading_style) > 128)
           OR ((p_rank).trader_type IS NOT NULL AND
               pg_catalog.char_length((p_rank).trader_type) > 128) THEN
          RAISE EXCEPTION
            'persisted leaderboard rank bounded field is invalid'
            USING ERRCODE = '22023';
        END IF;

        IF (p_rank).arena_score IS NULL
           OR (p_rank).arena_score::text = ANY (
                ARRAY['NaN', 'Infinity', '-Infinity']
              )
           OR (p_rank).arena_score <= 0
           OR (p_rank).arena_score > 100
           OR (p_rank).arena_score_v4 IS NULL
           OR (p_rank).arena_score_v4::text = ANY (
                ARRAY['NaN', 'Infinity', '-Infinity']
              )
           OR (p_rank).arena_score_v4 < 0
           OR (p_rank).arena_score_v4 > 100
           OR (p_rank).arena_score_v4 IS DISTINCT FROM
                (p_rank).arena_score
           OR (p_rank).arena_score_v3 IS NULL
           OR (p_rank).arena_score_v3::text = ANY (
                ARRAY['NaN', 'Infinity', '-Infinity']
              )
           OR (p_rank).arena_score_v3 < 0
           OR (p_rank).arena_score_v3 > 100
           OR (p_rank).roi IS NULL
           OR (p_rank).roi::text = ANY (
                ARRAY['NaN', 'Infinity', '-Infinity']
              )
           OR (p_rank).roi < -10000
           OR (p_rank).roi > 10000
           OR (p_rank).pnl IS NULL
           OR (p_rank).pnl::text = ANY (
                ARRAY['NaN', 'Infinity', '-Infinity']
              )
           OR (p_rank).pnl < -100000000
           OR (p_rank).pnl > 1000000000
           OR (p_rank).win_rate IS NULL
           OR (p_rank).win_rate::text = ANY (
                ARRAY['NaN', 'Infinity', '-Infinity']
              )
           OR (p_rank).win_rate < 0
           OR (p_rank).win_rate > 100
           OR (p_rank).max_drawdown IS NULL
           OR (p_rank).max_drawdown::text = ANY (
                ARRAY['NaN', 'Infinity', '-Infinity']
              )
           OR (p_rank).max_drawdown < 0
           OR (p_rank).max_drawdown >= 100 THEN
          RAISE EXCEPTION
            'persisted leaderboard rank core metric or score is invalid'
            USING ERRCODE = '22023';
        END IF;

        IF (p_rank).profitability_score IS NULL
           OR (p_rank).profitability_score::text = ANY (
                ARRAY['NaN', 'Infinity', '-Infinity']
              )
           OR (p_rank).profitability_score < 0
           OR (p_rank).profitability_score > 100
           OR (p_rank).risk_control_score IS NULL
           OR (p_rank).risk_control_score::text = ANY (
                ARRAY['NaN', 'Infinity', '-Infinity']
              )
           OR (p_rank).risk_control_score < 0
           OR (p_rank).risk_control_score > 100
           OR ((p_rank).execution_score IS NOT NULL AND (
             (p_rank).execution_score::text = ANY (
               ARRAY['NaN', 'Infinity', '-Infinity']
             )
             OR (p_rank).execution_score < 0
             OR (p_rank).execution_score > 100
           ))
           OR ((p_rank).avg_holding_hours IS NOT NULL AND (
             (p_rank).avg_holding_hours::text = ANY (
               ARRAY['NaN', 'Infinity', '-Infinity']
             )
             OR (p_rank).avg_holding_hours < 0
           ))
           OR ((p_rank).style_confidence IS NOT NULL AND (
             (p_rank).style_confidence::text = ANY (
               ARRAY['NaN', 'Infinity', '-Infinity']
             )
             OR (p_rank).style_confidence < 0
             OR (p_rank).style_confidence > 1
           ))
           OR ((p_rank).sharpe_ratio IS NOT NULL AND
               (p_rank).sharpe_ratio::text = ANY (
                 ARRAY['NaN', 'Infinity', '-Infinity']
               ))
           OR ((p_rank).sortino_ratio IS NOT NULL AND
               (p_rank).sortino_ratio::text = ANY (
                 ARRAY['NaN', 'Infinity', '-Infinity']
               ))
           OR ((p_rank).profit_factor IS NOT NULL AND (
             (p_rank).profit_factor::text = ANY (
               ARRAY['NaN', 'Infinity', '-Infinity']
             )
             OR (p_rank).profit_factor < 0
           ))
           OR ((p_rank).calmar_ratio IS NOT NULL AND
               (p_rank).calmar_ratio::text = ANY (
                 ARRAY['NaN', 'Infinity', '-Infinity']
               )) THEN
          RAISE EXCEPTION
            'persisted leaderboard rank secondary metric is invalid'
            USING ERRCODE = '22023';
        END IF;

        IF (p_rank).computed_at IS NULL
           OR NOT pg_catalog.isfinite((p_rank).computed_at)
           OR (p_rank).computed_at <
                '2020-01-01 00:00:00+00'::timestamptz
           OR (p_rank).computed_at >=
                '2100-01-01 00:00:00+00'::timestamptz THEN
          RAISE EXCEPTION
            'persisted leaderboard rank computed_at must be finite and within 2020-2100'
            USING ERRCODE = '22023';
        END IF;

        IF v_factors IS NULL
           OR pg_catalog.pg_column_size(v_factors) > 8192
           OR pg_catalog.octet_length(v_factors::text) > 8192
           OR pg_catalog.jsonb_typeof(v_factors) <> 'object'
           OR (
             SELECT pg_catalog.count(*)
             FROM pg_catalog.jsonb_object_keys(v_factors)
           ) <> 5
           OR NOT v_factors ?& ARRAY[
             'roi', 'pnl', 'drawdown', 'sharpe', 'consistency'
           ]
           OR pg_catalog.jsonb_typeof(v_factors->'roi') <> 'number'
           OR pg_catalog.jsonb_typeof(v_factors->'pnl') <> 'number'
           OR pg_catalog.jsonb_typeof(v_factors->'drawdown')
                NOT IN ('number', 'null')
           OR pg_catalog.jsonb_typeof(v_factors->'sharpe')
                NOT IN ('number', 'null')
           OR pg_catalog.jsonb_typeof(v_factors->'consistency')
                NOT IN ('number', 'null') THEN
          RAISE EXCEPTION
            'persisted leaderboard score_factors shape is invalid'
            USING ERRCODE = '22023';
        END IF;

        v_factor_roi := (v_factors->>'roi')::numeric;
        v_factor_pnl := (v_factors->>'pnl')::numeric;
        v_factor_drawdown := (v_factors->>'drawdown')::numeric;
        v_factor_sharpe := (v_factors->>'sharpe')::numeric;
        v_factor_consistency := (v_factors->>'consistency')::numeric;

        IF v_factor_roi::text = ANY (
             ARRAY['NaN', 'Infinity', '-Infinity']
           )
           OR v_factor_roi < 0 OR v_factor_roi > 1
           OR v_factor_pnl::text = ANY (
             ARRAY['NaN', 'Infinity', '-Infinity']
           )
           OR v_factor_pnl < 0 OR v_factor_pnl > 1
           OR (v_factor_drawdown IS NOT NULL AND (
             v_factor_drawdown::text = ANY (
               ARRAY['NaN', 'Infinity', '-Infinity']
             )
             OR v_factor_drawdown < 0 OR v_factor_drawdown > 1
           ))
           OR (v_factor_sharpe IS NOT NULL AND (
             v_factor_sharpe::text = ANY (
               ARRAY['NaN', 'Infinity', '-Infinity']
             )
             OR v_factor_sharpe < 0 OR v_factor_sharpe > 1
           ))
           OR (v_factor_consistency IS NOT NULL AND (
             v_factor_consistency::text = ANY (
               ARRAY['NaN', 'Infinity', '-Infinity']
             )
             OR v_factor_consistency < 0 OR v_factor_consistency > 1
           )) THEN
          RAISE EXCEPTION
            'persisted leaderboard score_factors value is invalid'
            USING ERRCODE = '22023';
        END IF;

        v_encoded_factors := pg_catalog.jsonb_build_array(
          'leaderboard-score-factors@1',
          pg_catalog.trim_scale(v_factor_roi)::text,
          pg_catalog.trim_scale(v_factor_pnl)::text,
          CASE WHEN v_factor_drawdown IS NULL THEN NULL
            ELSE pg_catalog.trim_scale(v_factor_drawdown)::text END,
          CASE WHEN v_factor_sharpe IS NULL THEN NULL
            ELSE pg_catalog.trim_scale(v_factor_sharpe)::text END,
          CASE WHEN v_factor_consistency IS NULL THEN NULL
            ELSE pg_catalog.trim_scale(v_factor_consistency)::text END
        );

        RETURN pg_catalog.jsonb_build_array(
          'leaderboard-rank-persisted-row@1',
          (p_rank).season_id,
          (p_rank).source,
          (p_rank).source_trader_id,
          (p_rank).rank_publication_id::text,
          (p_rank).source_type,
          CASE WHEN (p_rank).rank IS NULL THEN NULL
            ELSE (p_rank).rank::text END,
          CASE WHEN (p_rank).rank_change IS NULL THEN NULL
            ELSE (p_rank).rank_change::text END,
          (p_rank).is_new,
          pg_catalog.trim_scale((p_rank).arena_score)::text,
          pg_catalog.trim_scale((p_rank).arena_score_v4)::text,
          pg_catalog.trim_scale((p_rank).arena_score_v3)::text,
          v_encoded_factors,
          pg_catalog.trim_scale((p_rank).roi)::text,
          pg_catalog.trim_scale((p_rank).pnl)::text,
          pg_catalog.trim_scale((p_rank).win_rate)::text,
          pg_catalog.trim_scale((p_rank).max_drawdown)::text,
          CASE WHEN (p_rank).followers IS NULL THEN NULL
            ELSE (p_rank).followers::text END,
          CASE WHEN (p_rank).copiers IS NULL THEN NULL
            ELSE (p_rank).copiers::text END,
          CASE WHEN (p_rank).trades_count IS NULL THEN NULL
            ELSE (p_rank).trades_count::text END,
          (p_rank).handle,
          (p_rank).avatar_url,
          pg_catalog.to_char(
            (p_rank).computed_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
          pg_catalog.trim_scale((p_rank).profitability_score)::text,
          pg_catalog.trim_scale((p_rank).risk_control_score)::text,
          CASE WHEN (p_rank).execution_score IS NULL THEN NULL
            ELSE pg_catalog.trim_scale((p_rank).execution_score)::text END,
          (p_rank).score_completeness,
          (p_rank).trading_style,
          CASE WHEN (p_rank).avg_holding_hours IS NULL THEN NULL
            ELSE pg_catalog.trim_scale((p_rank).avg_holding_hours)::text END,
          CASE WHEN (p_rank).style_confidence IS NULL THEN NULL
            ELSE pg_catalog.trim_scale((p_rank).style_confidence)::text END,
          CASE WHEN (p_rank).sharpe_ratio IS NULL THEN NULL
            ELSE pg_catalog.trim_scale((p_rank).sharpe_ratio)::text END,
          CASE WHEN (p_rank).sortino_ratio IS NULL THEN NULL
            ELSE pg_catalog.trim_scale((p_rank).sortino_ratio)::text END,
          CASE WHEN (p_rank).profit_factor IS NULL THEN NULL
            ELSE pg_catalog.trim_scale((p_rank).profit_factor)::text END,
          CASE WHEN (p_rank).calmar_ratio IS NULL THEN NULL
            ELSE pg_catalog.trim_scale((p_rank).calmar_ratio)::text END,
          (p_rank).trader_type,
          (p_rank).is_outlier,
          (p_rank).metrics_estimated
        );
      END;
      $body$
    $encoder_ddl$;

    EXECUTE $batch_ddl$
      CREATE FUNCTION arena.build_leaderboard_rank_batch_evidence_v1(
        p_season_id text,
        p_score_cohort_id uuid,
        p_identities jsonb
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      VOLATILE
      CALLED ON NULL INPUT
      PARALLEL UNSAFE
      SECURITY INVOKER
      SET search_path = pg_catalog, pg_temp
      SET "TimeZone" = 'UTC'
      SET lock_timeout = '10s'
      AS $body$
      DECLARE
        v_identity jsonb;
        v_source text;
        v_source_trader_id text;
        v_sorted_identities jsonb;
        v_row_count integer;
        v_distinct_identity_count integer;
        v_rank public.leaderboard_ranks%ROWTYPE;
        v_encoded_rows jsonb;
        v_encoded_row_count integer;
        v_source_proofs jsonb;
        v_source_count integer := 0;
        v_batch_preimage jsonb;
        v_canonical_octet_length integer;
        v_first_source text;
        v_first_source_trader_id text;
        v_last_source text;
        v_last_source_trader_id text;
      BEGIN
        IF p_season_id IS NULL
           OR p_season_id NOT IN ('7D', '30D', '90D')
           OR p_score_cohort_id IS NULL
           OR p_identities IS NULL
           OR pg_catalog.jsonb_typeof(p_identities) <> 'array' THEN
          RAISE EXCEPTION 'persisted rank batch header is invalid'
            USING ERRCODE = '22023';
        END IF;

        v_row_count := pg_catalog.jsonb_array_length(p_identities);
        IF v_row_count < 1 OR v_row_count > 1000
           OR pg_catalog.pg_column_size(p_identities) > 4194304
           OR pg_catalog.octet_length(p_identities::text) > 4194304 THEN
          RAISE EXCEPTION 'persisted rank batch identity set is outside bounds'
            USING ERRCODE = '54000';
        END IF;

        FOR v_identity IN
          SELECT element.value
          FROM pg_catalog.jsonb_array_elements(p_identities) AS element(value)
        LOOP
          IF pg_catalog.jsonb_typeof(v_identity) <> 'object'
             OR (
               SELECT pg_catalog.count(*)
               FROM pg_catalog.jsonb_object_keys(v_identity)
             ) <> 2
             OR NOT v_identity ?& ARRAY['source', 'source_trader_id']
             OR pg_catalog.jsonb_typeof(v_identity->'source') <> 'string'
             OR pg_catalog.jsonb_typeof(
                  v_identity->'source_trader_id'
                ) <> 'string' THEN
            RAISE EXCEPTION 'persisted rank batch identity shape is invalid'
              USING ERRCODE = '22023';
          END IF;

          v_source := v_identity->>'source';
          v_source_trader_id := v_identity->>'source_trader_id';
          IF v_source !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
             OR v_source <> pg_catalog.lower(pg_catalog.btrim(v_source))
             OR pg_catalog.char_length(v_source) > 128
             OR v_source_trader_id <> pg_catalog.btrim(v_source_trader_id)
             OR v_source_trader_id = ''
             OR pg_catalog.char_length(v_source_trader_id) > 512 THEN
            RAISE EXCEPTION 'persisted rank batch identity is not canonical'
              USING ERRCODE = '22023';
          END IF;

        END LOOP;

        SELECT
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'source', identity.value->>'source',
              'source_trader_id', identity.value->>'source_trader_id'
            )
            ORDER BY (identity.value->>'source') COLLATE pg_catalog."C",
                     (identity.value->>'source_trader_id')
                       COLLATE pg_catalog."C"
          ),
          pg_catalog.count(DISTINCT ROW(
            (identity.value->>'source') COLLATE pg_catalog."C",
            (identity.value->>'source_trader_id')
              COLLATE pg_catalog."C"
          ))::integer
        INTO STRICT v_sorted_identities, v_distinct_identity_count
        FROM pg_catalog.jsonb_array_elements(
          p_identities
        ) AS identity(value);

        IF v_distinct_identity_count <> v_row_count THEN
          RAISE EXCEPTION 'persisted rank batch contains a duplicate identity'
            USING ERRCODE = '22023';
        END IF;

        -- Lock every exact persisted row in canonical order before encoding.
        -- When the final lock is acquired all rows coexist at one linearization
        -- point, and the retained locks keep that set stable through return.
        FOR v_identity IN
          SELECT element.value
          FROM pg_catalog.jsonb_array_elements(
            v_sorted_identities
          ) AS element(value)
        LOOP
          v_source := v_identity->>'source';
          v_source_trader_id := v_identity->>'source_trader_id';

          SELECT rank_row.*
          INTO v_rank
          FROM public.leaderboard_ranks AS rank_row
          WHERE rank_row.season_id = p_season_id
            AND rank_row.source = v_source
            AND rank_row.source_trader_id = v_source_trader_id
            AND rank_row.rank_publication_id = p_score_cohort_id
          FOR SHARE OF rank_row;

          IF NOT FOUND THEN
            RAISE EXCEPTION
              'persisted rank batch identity is missing from the exact cohort: %/%',
              v_source,
              v_source_trader_id
              USING ERRCODE = '22023';
          END IF;

          -- Default-collation equality may use the attested unique index. A
          -- second UTF-8 byte comparison prevents nondeterministic collations
          -- from binding caller proof metadata to a different persisted key.
          IF pg_catalog.convert_to(v_rank.season_id, 'UTF8')
               IS DISTINCT FROM pg_catalog.convert_to(p_season_id, 'UTF8')
             OR pg_catalog.convert_to(v_rank.source, 'UTF8')
               IS DISTINCT FROM pg_catalog.convert_to(v_source, 'UTF8')
             OR pg_catalog.convert_to(v_rank.source_trader_id, 'UTF8')
               IS DISTINCT FROM pg_catalog.convert_to(
                 v_source_trader_id,
                 'UTF8'
               )
             OR v_rank.rank_publication_id IS DISTINCT FROM
               p_score_cohort_id THEN
            RAISE EXCEPTION
              'persisted rank batch identity is not byte-exact: %/%',
              v_source,
              v_source_trader_id
              USING ERRCODE = '22023';
          END IF;
        END LOOP;

        -- Aggregate once after the complete lock set is held. This keeps the
        -- bounded 1000-row path linear rather than repeatedly copying JSONB.
        SELECT
          pg_catalog.jsonb_agg(
            arena.encode_leaderboard_rank_row_v1(rank_row)
            ORDER BY identity.ordinality
          ),
          pg_catalog.count(*)::integer
        INTO STRICT v_encoded_rows, v_encoded_row_count
        FROM pg_catalog.jsonb_array_elements(
          v_sorted_identities
        ) WITH ORDINALITY AS identity(value, ordinality)
        JOIN public.leaderboard_ranks AS rank_row
         ON rank_row.season_id = p_season_id
         AND rank_row.source = (identity.value->>'source')
         AND rank_row.source_trader_id =
               (identity.value->>'source_trader_id')
         AND rank_row.rank_publication_id = p_score_cohort_id
         AND pg_catalog.convert_to(rank_row.season_id, 'UTF8') =
               pg_catalog.convert_to(p_season_id, 'UTF8')
         AND pg_catalog.convert_to(rank_row.source, 'UTF8') =
               pg_catalog.convert_to(identity.value->>'source', 'UTF8')
         AND pg_catalog.convert_to(rank_row.source_trader_id, 'UTF8') =
               pg_catalog.convert_to(
                 identity.value->>'source_trader_id',
                 'UTF8'
               );

        IF v_encoded_row_count <> v_row_count
           OR pg_catalog.jsonb_array_length(v_encoded_rows) <> v_row_count THEN
          RAISE EXCEPTION
            'persisted rank batch changed after its lock set was acquired'
            USING ERRCODE = '40001';
        END IF;

        v_first_source := (v_encoded_rows->0)->>2;
        v_first_source_trader_id := (v_encoded_rows->0)->>3;
        v_last_source := (v_encoded_rows->(v_row_count - 1))->>2;
        v_last_source_trader_id := (v_encoded_rows->(v_row_count - 1))->>3;

        WITH encoded_identity AS MATERIALIZED (
          SELECT
            ((encoded.value->>2) COLLATE pg_catalog."C") AS source,
            ((encoded.value->>3) COLLATE pg_catalog."C") AS source_trader_id
          FROM pg_catalog.jsonb_array_elements(v_encoded_rows)
            AS encoded(value)
        ),
        source_group AS (
          SELECT
            encoded_identity.source,
            pg_catalog.count(*)::integer AS source_row_count,
            pg_catalog.jsonb_agg(
              encoded_identity.source_trader_id
              ORDER BY encoded_identity.source_trader_id
            ) AS source_ids
          FROM encoded_identity
          GROUP BY encoded_identity.source
        ),
        source_proof AS (
          SELECT
            source_group.source,
            pg_catalog.jsonb_build_object(
              'source', source_group.source,
              'source_row_count', source_group.source_row_count,
              'source_identity_sha256', pg_catalog.encode(
                pg_catalog.sha256(
                  pg_catalog.convert_to(
                    pg_catalog.jsonb_build_array(
                      'leaderboard-rank-source-identities@1',
                      p_season_id,
                      source_group.source,
                      source_group.source_ids
                    )::text,
                    'UTF8'
                  )
                ),
                'hex'
              )
            ) AS proof
          FROM source_group
        )
        SELECT
          pg_catalog.jsonb_agg(
            source_proof.proof ORDER BY source_proof.source
          ),
          pg_catalog.count(*)::integer
        INTO STRICT v_source_proofs, v_source_count
        FROM source_proof;

        v_batch_preimage := pg_catalog.jsonb_build_array(
          'leaderboard-rank-persisted-batch@1',
          v_encoded_rows
        );
        v_canonical_octet_length := pg_catalog.octet_length(
          pg_catalog.convert_to(v_batch_preimage::text, 'UTF8')
        );
        IF v_canonical_octet_length > 67108864 THEN
          RAISE EXCEPTION
            'persisted rank batch canonical encoding exceeds 67108864 bytes'
            USING ERRCODE = '54000';
        END IF;

        RETURN pg_catalog.jsonb_build_object(
          'contract', 'leaderboard-rank-persisted-batch-evidence@1',
          'season_id', p_season_id,
          'score_cohort_id', p_score_cohort_id::text,
          'row_count', v_row_count,
          'source_count', v_source_count,
          'first_source', v_first_source,
          'first_source_trader_id', v_first_source_trader_id,
          'last_source', v_last_source,
          'last_source_trader_id', v_last_source_trader_id,
          'batch_sha256', pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(v_batch_preimage::text, 'UTF8')
            ),
            'hex'
          ),
          'canonical_octet_length', v_canonical_octet_length,
          'source_proofs', v_source_proofs
        );
      END;
      $body$
    $batch_ddl$;

    EXECUTE
      'ALTER FUNCTION arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks) OWNER TO postgres';
    EXECUTE
      'ALTER FUNCTION arena.build_leaderboard_rank_batch_evidence_v1(text,uuid,jsonb) OWNER TO postgres';
    EXECUTE
      'REVOKE ALL ON FUNCTION arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks) FROM PUBLIC, anon, authenticated, service_role';
    EXECUTE
      'REVOKE ALL ON FUNCTION arena.build_leaderboard_rank_batch_evidence_v1(text,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
END
$install_codec$;

COMMENT ON FUNCTION arena.encode_leaderboard_rank_row_v1(
  public.leaderboard_ranks
) IS
  'Owner-only PG17 canonical encoder for all 36 persisted non-surrogate rank fields. Encoding a supplied composite alone is not proof that the row exists.';
COMMENT ON FUNCTION arena.build_leaderboard_rank_batch_evidence_v1(
  text,
  uuid,
  jsonb
) IS
  'Owner-only bounded evidence builder. Canonically sorts identities, FOR SHARE-locks exact persisted cohort rows, and emits batch/source SHA256 proofs. No DML and not terminal publication authority.';

DO $codec_postflight$
DECLARE
  v_encoder oid := pg_catalog.to_regprocedure(
    'arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks)'
  );
  v_batch oid := pg_catalog.to_regprocedure(
    'arena.build_leaderboard_rank_batch_evidence_v1(text,uuid,jsonb)'
  );
BEGIN
  IF v_encoder IS NULL OR v_batch IS NULL
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = function_row.pronamespace
       WHERE namespace_row.nspname = 'arena'
         AND function_row.proname IN (
           'encode_leaderboard_rank_row_v1',
           'build_leaderboard_rank_batch_evidence_v1'
         )
         AND function_row.oid NOT IN (v_encoder, v_batch)
     ) THEN
    RAISE EXCEPTION 'persisted rank codec object identity postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_encoder
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prokind = 'f'
      AND language_row.lanname = 'plpgsql'
      AND NOT function_row.prosecdef
      AND NOT function_row.proleakproof
      AND function_row.proisstrict
      AND function_row.provolatile = 's'
      AND function_row.proparallel = 's'
      AND NOT function_row.proretset
      AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND function_row.pronargs = 1
      AND function_row.pronargdefaults = 0
      AND function_row.proargtypes = ARRAY[
        'public.leaderboard_ranks'::pg_catalog.regtype
      ]::pg_catalog.oidvector
      AND function_row.proargnames = ARRAY['p_rank']::pg_catalog.text[]
      AND function_row.proargmodes IS NULL
      AND function_row.proallargtypes IS NULL
      AND function_row.prosupport = 0
      AND function_row.prosqlbody IS NULL
      AND function_row.probin IS NULL
      AND function_row.procost = 100
      AND function_row.prorows = 0
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'TimeZone=UTC'
      ]::pg_catalog.text[]
      AND pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(function_row.prosrc, 'UTF8')
        ),
        'hex'
      ) = 'e667a6cadd6c0c21ecfa2bb920e6583f511a8e6f1c77e5e92f1a1bec36d6122e'
  ) THEN
    RAISE EXCEPTION 'persisted rank row encoder catalog drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_batch
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prokind = 'f'
      AND language_row.lanname = 'plpgsql'
      AND NOT function_row.prosecdef
      AND NOT function_row.proleakproof
      AND NOT function_row.proisstrict
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND NOT function_row.proretset
      AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND function_row.pronargs = 3
      AND function_row.pronargdefaults = 0
      AND function_row.proargtypes = ARRAY[
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.uuid'::pg_catalog.regtype,
        'pg_catalog.jsonb'::pg_catalog.regtype
      ]::pg_catalog.oidvector
      AND function_row.proargnames = ARRAY[
        'p_season_id',
        'p_score_cohort_id',
        'p_identities'
      ]::pg_catalog.text[]
      AND function_row.proargmodes IS NULL
      AND function_row.proallargtypes IS NULL
      AND function_row.prosupport = 0
      AND function_row.prosqlbody IS NULL
      AND function_row.probin IS NULL
      AND function_row.procost = 100
      AND function_row.prorows = 0
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'TimeZone=UTC',
        'lock_timeout=10s'
      ]::pg_catalog.text[]
      AND pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(function_row.prosrc, 'UTF8')
        ),
        'hex'
      ) = 'bdecbbc94ffbfd966122651552c09e3509f7bb1e87a36f5eb31a31315ea0770b'
  ) THEN
    RAISE EXCEPTION 'persisted rank batch evidence builder catalog drifted';
  END IF;

  IF pg_catalog.has_function_privilege('anon', v_encoder, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
          'authenticated', v_encoder, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'service_role', v_encoder, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege('anon', v_batch, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
          'authenticated', v_batch, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'service_role', v_batch, 'EXECUTE'
        )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS expanded
       WHERE function_row.oid IN (v_encoder, v_batch)
         AND expanded.privilege_type = 'EXECUTE'
         AND expanded.grantee <> function_row.proowner
     ) THEN
    RAISE EXCEPTION 'persisted rank codec EXECUTE ACL drifted';
  END IF;
END
$codec_postflight$;

COMMIT;
