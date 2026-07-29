-- Dormant, owner-only manifest attestation substrate for atomic rank batches.
--
-- Batch zero will eventually verify the complete scorer manifest once and
-- freeze its positive population into bounded, immutable 1,000-row chunks.
-- This migration deliberately does not replace or modify the current writer.
-- A header cannot commit without its complete chunk plan and batch-zero
-- receipt, while the source manifest remains prunable after that transaction.
-- The future writer must be invoked as one top-level RPC transaction: a
-- SAVEPOINT/subtransaction has a different tuple xmin and is rejected rather
-- than weakening the no-backfill proof for older generation receipts.

BEGIN;

SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL quote_all_identifiers = 'off';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'arena:leaderboard-rank-manifest-attestation-substrate:v1',
    0
  )
);

DO $dependency_preflight$
DECLARE
  v_binding pg_catalog.regclass := pg_catalog.to_regclass(
    'arena.leaderboard_rank_generation_manifest_bindings'
  );
  v_receipt pg_catalog.regclass := pg_catalog.to_regclass(
    'arena.leaderboard_rank_generation_batch_receipts'
  );
  v_manifest pg_catalog.regclass := pg_catalog.to_regclass(
    'arena.leaderboard_score_input_manifests'
  );
  v_reject oid := pg_catalog.to_regprocedure(
    'arena.reject_leaderboard_rank_publication_mutation()'
  );
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR v_binding IS NULL
     OR v_receipt IS NULL
     OR v_manifest IS NULL
     OR v_reject IS NULL
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(
         ARRAY['postgres', 'anon', 'authenticated', 'service_role']::name[]
       ) AS required_role(role_name)
       LEFT JOIN pg_catalog.pg_roles AS role_row
         ON role_row.rolname = required_role.role_name
       WHERE role_row.oid IS NULL
     ) THEN
    RAISE EXCEPTION
      'manifest attestation requires PG17, exact rank proof parents, and API roles';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (v_binding, v_receipt, v_manifest)
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
        OR relation.relowner <> 'postgres'::pg_catalog.regrole
        OR NOT relation.relrowsecurity
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (v_binding, v_receipt, v_manifest)
       OR inheritance.inhparent IN (v_binding, v_receipt, v_manifest)
  ) THEN
    RAISE EXCEPTION 'manifest attestation parent relation contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_binding
      AND constraint_row.conname =
            'rank_generation_manifest_binding_identity_key'
      AND constraint_row.contype = 'u'
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, false) =
            'UNIQUE (season_id, generation_seq, score_cohort_id, score_input_manifest_id, score_input_manifest_digest)'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_receipt
      AND constraint_row.conname = 'rank_generation_batch_receipt_pkey'
      AND constraint_row.contype = 'p'
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, false) =
            'PRIMARY KEY (season_id, generation_seq, batch_index)'
  ) THEN
    RAISE EXCEPTION 'manifest attestation parent identity keys drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_reject
      AND (
        function_row.proowner <> 'postgres'::pg_catalog.regrole
        OR function_row.prokind <> 'f'
        OR NOT function_row.prosecdef
        OR function_row.provolatile <> 'v'
        OR function_row.prorettype <> 'trigger'::pg_catalog.regtype
        OR function_row.proconfig IS DISTINCT FROM
             ARRAY['search_path=pg_catalog, pg_temp']::text[]
        OR pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(function_row.prosrc, 'UTF8')
             ),
             'hex'
           ) <> '3896caded6f9f7062305267ebf4d99f05f8e6299711d00b8a252d5d043b26e2e'
      )
  ) THEN
    RAISE EXCEPTION 'manifest attestation immutable trigger authority drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS required_parent_column
    RIGHT JOIN (
      VALUES
        (v_binding, 'season_id', 'text'::pg_catalog.regtype, true),
        (v_binding, 'generation_seq', 'bigint'::pg_catalog.regtype, true),
        (v_binding, 'score_cohort_id', 'uuid'::pg_catalog.regtype, true),
        (v_binding, 'score_input_manifest_id', 'uuid'::pg_catalog.regtype, true),
        (v_binding, 'score_input_manifest_digest', 'text'::pg_catalog.regtype, true),
        (v_receipt, 'season_id', 'text'::pg_catalog.regtype, true),
        (v_receipt, 'generation_seq', 'bigint'::pg_catalog.regtype, true),
        (v_receipt, 'score_cohort_id', 'uuid'::pg_catalog.regtype, true),
        (v_receipt, 'batch_index', 'integer'::pg_catalog.regtype, true),
        (v_receipt, 'score_input_manifest_id', 'uuid'::pg_catalog.regtype, true),
        (v_receipt, 'score_input_manifest_digest', 'text'::pg_catalog.regtype, true),
        (v_receipt, 'completed_at', 'timestamp with time zone'::pg_catalog.regtype, true),
        (v_manifest, 'manifest_id', 'uuid'::pg_catalog.regtype, true),
        (v_manifest, 'manifest_digest', 'text'::pg_catalog.regtype, true),
        (v_manifest, 'period', 'text'::pg_catalog.regtype, true),
        (v_manifest, 'valid_until', 'timestamp with time zone'::pg_catalog.regtype, true)
    ) AS expected(relation_oid, column_name, type_oid, not_null)
      ON required_parent_column.attrelid = expected.relation_oid
     AND required_parent_column.attname = expected.column_name
     AND required_parent_column.attnum > 0
     AND NOT required_parent_column.attisdropped
    WHERE required_parent_column.attnum IS NULL
       OR required_parent_column.atttypid <> expected.type_oid
       OR required_parent_column.attnotnull <> expected.not_null
       OR required_parent_column.attgenerated <> ''
  ) THEN
    RAISE EXCEPTION 'manifest attestation parent column contract drifted';
  END IF;
END
$dependency_preflight$;

LOCK TABLE ONLY arena.leaderboard_rank_generation_manifest_bindings
  IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_batch_receipts
  IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_score_input_manifests
  IN SHARE MODE;

DO $install_preflight$
DECLARE
  v_relation_count integer;
  v_named_function_count integer;
BEGIN
  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_relation_count
  FROM (
    VALUES
      ('arena.leaderboard_rank_manifest_attestations'),
      ('arena.leaderboard_rank_manifest_attestation_chunks')
  ) AS expected(qualified_name)
  WHERE pg_catalog.to_regclass(expected.qualified_name) IS NOT NULL;

  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_named_function_count
  FROM pg_catalog.pg_proc AS function_row
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = function_row.pronamespace
  WHERE namespace_row.nspname = 'arena'
    AND function_row.proname IN (
      'encode_leaderboard_rank_manifest_fields_v1',
      'build_leaderboard_rank_manifest_field_commitment_v1',
      'build_leaderboard_rank_manifest_chunk_sha256_v1',
      'leaderboard_rank_manifest_attestation_chunk_is_valid_v1',
      'build_leaderboard_rank_manifest_chunks_sha256_v1',
      'guard_leaderboard_rank_manifest_attestation_chunk_insert_v1',
      'validate_leaderboard_rank_manifest_attestation_complete_v1'
    );

  IF v_relation_count <> 0 OR v_named_function_count <> 0 THEN
    IF v_relation_count <> 2 OR v_named_function_count <> 7 THEN
      RAISE EXCEPTION
        'manifest attestation objects are only partially installed';
    END IF;
    RAISE EXCEPTION
      'manifest attestation objects pre-exist without this migration ledger';
  END IF;
END
$install_preflight$;

CREATE FUNCTION arena.encode_leaderboard_rank_manifest_fields_v1(
  p_source text,
  p_source_trader_id text,
  p_roi numeric,
  p_pnl numeric,
  p_win_rate numeric,
  p_max_drawdown numeric,
  p_sharpe_ratio numeric,
  p_profit_factor numeric,
  p_trades_count integer,
  p_total_score numeric,
  p_score_factors jsonb,
  p_profitability_score numeric,
  p_risk_control_score numeric,
  p_execution_score numeric
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
CALLED ON NULL INPUT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  v_roi numeric(12, 4);
  v_pnl numeric(18, 2);
  v_win_rate numeric(5, 2);
  v_max_drawdown numeric(5, 2);
  v_sharpe_ratio numeric(10, 4);
  v_profit_factor numeric(10, 4);
  v_total_score numeric(10, 2);
  v_profitability_score numeric(6, 2);
  v_risk_control_score numeric(6, 2);
  v_execution_score numeric(6, 2);
  v_factor_roi double precision;
  v_factor_pnl double precision;
  v_factor_drawdown double precision;
  v_factor_sharpe double precision;
  v_factor_consistency double precision;
  v_factor_roi_numeric numeric;
  v_factor_pnl_numeric numeric;
  v_factor_drawdown_numeric numeric;
  v_factor_sharpe_numeric numeric;
  v_factor_consistency_numeric numeric;
  v_expected_profitability numeric(6, 2);
  v_expected_risk numeric(6, 2);
  v_expected_execution numeric(6, 2);
  v_encoded_factors jsonb;
BEGIN
  IF p_source IS NULL
     OR p_source !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
     OR p_source <> pg_catalog.lower(pg_catalog.btrim(p_source))
     OR pg_catalog.char_length(p_source) > 128
     OR p_source_trader_id IS NULL
     OR p_source_trader_id <> pg_catalog.btrim(p_source_trader_id)
     OR p_source_trader_id = ''
     OR pg_catalog.char_length(p_source_trader_id) > 512 THEN
    RAISE EXCEPTION 'manifest field identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF p_roi IS NULL
     OR p_roi::text = ANY (ARRAY['NaN', 'Infinity', '-Infinity'])
     OR p_roi < -10000 OR p_roi > 10000
     OR p_pnl IS NULL
     OR p_pnl::text = ANY (ARRAY['NaN', 'Infinity', '-Infinity'])
     OR p_pnl < -100000000 OR p_pnl > 1000000000
     OR p_win_rate IS NULL
     OR p_win_rate::text = ANY (ARRAY['NaN', 'Infinity', '-Infinity'])
     OR p_win_rate < 0 OR p_win_rate > 100
     OR p_max_drawdown IS NULL
     OR p_max_drawdown::text = ANY (ARRAY['NaN', 'Infinity', '-Infinity'])
     OR p_max_drawdown < 0 OR p_max_drawdown >= 100
     OR p_total_score IS NULL
     OR p_total_score::text = ANY (ARRAY['NaN', 'Infinity', '-Infinity'])
     OR p_total_score <= 0 OR p_total_score > 100
     OR (p_sharpe_ratio IS NOT NULL AND (
       p_sharpe_ratio::text = ANY (ARRAY['NaN', 'Infinity', '-Infinity'])
       OR pg_catalog.abs(p_sharpe_ratio) >= 1000000
     ))
     OR (p_profit_factor IS NOT NULL AND (
       p_profit_factor::text = ANY (ARRAY['NaN', 'Infinity', '-Infinity'])
       OR p_profit_factor < 0
       OR p_profit_factor >= 1000000
     ))
     OR (p_trades_count IS NOT NULL AND p_trades_count < 0) THEN
    RAISE EXCEPTION 'manifest field metric domain is invalid'
      USING ERRCODE = '22023';
  END IF;

  v_roi := p_roi;
  v_pnl := p_pnl;
  v_win_rate := p_win_rate;
  v_max_drawdown := p_max_drawdown;
  v_sharpe_ratio := p_sharpe_ratio;
  v_profit_factor := p_profit_factor;
  v_total_score := p_total_score;
  v_profitability_score := p_profitability_score;
  v_risk_control_score := p_risk_control_score;
  v_execution_score := p_execution_score;

  IF p_roi IS DISTINCT FROM v_roi
     OR p_pnl IS DISTINCT FROM v_pnl
     OR p_win_rate IS DISTINCT FROM v_win_rate
     OR p_max_drawdown IS DISTINCT FROM v_max_drawdown
     OR p_sharpe_ratio IS DISTINCT FROM v_sharpe_ratio
     OR p_profit_factor IS DISTINCT FROM v_profit_factor
     OR p_total_score IS DISTINCT FROM v_total_score
     OR p_profitability_score IS DISTINCT FROM v_profitability_score
     OR p_risk_control_score IS DISTINCT FROM v_risk_control_score
     OR p_execution_score IS DISTINCT FROM v_execution_score THEN
    RAISE EXCEPTION 'manifest fields require their persisted numeric scale'
      USING ERRCODE = '22023';
  END IF;

  IF p_score_factors IS NULL
     OR pg_catalog.pg_column_size(p_score_factors) > 8192
     OR pg_catalog.octet_length(p_score_factors::text) > 8192
     OR pg_catalog.jsonb_typeof(p_score_factors) <> 'object'
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.jsonb_object_keys(p_score_factors)
     ) <> 5
     OR NOT p_score_factors ?&
          ARRAY['roi', 'pnl', 'drawdown', 'sharpe', 'consistency']
     OR pg_catalog.jsonb_typeof(p_score_factors->'roi') <> 'number'
     OR pg_catalog.jsonb_typeof(p_score_factors->'pnl') <> 'number'
     OR pg_catalog.jsonb_typeof(p_score_factors->'drawdown')
          NOT IN ('number', 'null')
     OR pg_catalog.jsonb_typeof(p_score_factors->'sharpe')
          NOT IN ('number', 'null')
     OR pg_catalog.jsonb_typeof(p_score_factors->'consistency')
          NOT IN ('number', 'null') THEN
    RAISE EXCEPTION 'manifest score factors shape is invalid'
      USING ERRCODE = '22023';
  END IF;

  v_factor_roi_numeric := (p_score_factors->>'roi')::numeric;
  v_factor_pnl_numeric := (p_score_factors->>'pnl')::numeric;
  v_factor_drawdown_numeric := (p_score_factors->>'drawdown')::numeric;
  v_factor_sharpe_numeric := (p_score_factors->>'sharpe')::numeric;
  v_factor_consistency_numeric :=
    (p_score_factors->>'consistency')::numeric;
  v_factor_roi := v_factor_roi_numeric::double precision;
  v_factor_pnl := v_factor_pnl_numeric::double precision;
  v_factor_drawdown := v_factor_drawdown_numeric::double precision;
  v_factor_sharpe := v_factor_sharpe_numeric::double precision;
  v_factor_consistency := v_factor_consistency_numeric::double precision;

  IF v_factor_roi_numeric::text = ANY (
       ARRAY['NaN', 'Infinity', '-Infinity']
     )
     OR v_factor_roi_numeric < 0 OR v_factor_roi_numeric > 1
     OR v_factor_pnl_numeric::text = ANY (
       ARRAY['NaN', 'Infinity', '-Infinity']
     )
     OR v_factor_pnl_numeric < 0 OR v_factor_pnl_numeric > 1
     OR (v_factor_drawdown_numeric IS NOT NULL AND (
       v_factor_drawdown_numeric::text = ANY (
         ARRAY['NaN', 'Infinity', '-Infinity']
       )
       OR v_factor_drawdown_numeric < 0 OR v_factor_drawdown_numeric > 1
     ))
     OR (v_factor_sharpe_numeric IS NOT NULL AND (
       v_factor_sharpe_numeric::text = ANY (
         ARRAY['NaN', 'Infinity', '-Infinity']
       )
       OR v_factor_sharpe_numeric < 0 OR v_factor_sharpe_numeric > 1
     ))
     OR (v_factor_consistency_numeric IS NOT NULL AND (
       v_factor_consistency_numeric::text = ANY (
         ARRAY['NaN', 'Infinity', '-Infinity']
       )
       OR v_factor_consistency_numeric < 0
       OR v_factor_consistency_numeric > 1
     )) THEN
    RAISE EXCEPTION 'manifest score factors value is invalid'
      USING ERRCODE = '22023';
  END IF;

  v_expected_profitability := pg_catalog.floor(
    100::double precision * (
      0.3::double precision * v_factor_pnl +
      0.2::double precision * v_factor_roi
    ) / 0.5::double precision + 0.5::double precision
  )::numeric(6, 2);
  v_expected_risk := CASE
    WHEN v_factor_drawdown IS NULL AND v_factor_sharpe IS NULL THEN
      0::numeric(6, 2)
    WHEN v_factor_drawdown IS NULL THEN
      pg_catalog.floor(
        100::double precision * v_factor_sharpe + 0.5::double precision
      )::numeric(6, 2)
    WHEN v_factor_sharpe IS NULL THEN
      pg_catalog.floor(
        100::double precision * v_factor_drawdown + 0.5::double precision
      )::numeric(6, 2)
    ELSE
      pg_catalog.floor(
        100::double precision *
          (v_factor_drawdown + v_factor_sharpe) /
          2::double precision + 0.5::double precision
      )::numeric(6, 2)
  END;
  v_expected_execution := CASE
    WHEN v_factor_consistency IS NULL THEN NULL::numeric(6, 2)
    ELSE pg_catalog.floor(
      100::double precision * v_factor_consistency + 0.5::double precision
    )::numeric(6, 2)
  END;

  IF v_profitability_score IS DISTINCT FROM v_expected_profitability
     OR v_risk_control_score IS DISTINCT FROM v_expected_risk
     OR v_execution_score IS DISTINCT FROM v_expected_execution THEN
    RAISE EXCEPTION 'manifest-derived score commitment is invalid'
      USING ERRCODE = '22023';
  END IF;

  v_encoded_factors := pg_catalog.jsonb_build_array(
    'leaderboard-score-factors@1',
    pg_catalog.trim_scale(v_factor_roi_numeric)::text,
    pg_catalog.trim_scale(v_factor_pnl_numeric)::text,
    CASE WHEN v_factor_drawdown_numeric IS NULL THEN NULL
      ELSE pg_catalog.trim_scale(v_factor_drawdown_numeric)::text END,
    CASE WHEN v_factor_sharpe_numeric IS NULL THEN NULL
      ELSE pg_catalog.trim_scale(v_factor_sharpe_numeric)::text END,
    CASE WHEN v_factor_consistency_numeric IS NULL THEN NULL
      ELSE pg_catalog.trim_scale(v_factor_consistency_numeric)::text END
  );

  RETURN pg_catalog.jsonb_build_array(
    'leaderboard-rank-manifest-fields@1',
    p_source,
    p_source_trader_id,
    pg_catalog.trim_scale(v_roi)::text,
    pg_catalog.trim_scale(v_pnl)::text,
    pg_catalog.trim_scale(v_win_rate)::text,
    pg_catalog.trim_scale(v_max_drawdown)::text,
    CASE WHEN v_sharpe_ratio IS NULL THEN NULL
      ELSE pg_catalog.trim_scale(v_sharpe_ratio)::text END,
    CASE WHEN v_profit_factor IS NULL THEN NULL
      ELSE pg_catalog.trim_scale(v_profit_factor)::text END,
    CASE WHEN p_trades_count IS NULL THEN NULL
      ELSE p_trades_count::text END,
    pg_catalog.trim_scale(v_total_score)::text,
    v_encoded_factors,
    pg_catalog.trim_scale(v_profitability_score)::text,
    pg_catalog.trim_scale(v_risk_control_score)::text,
    CASE WHEN v_execution_score IS NULL THEN NULL
      ELSE pg_catalog.trim_scale(v_execution_score)::text END
  );
END;
$body$;

CREATE FUNCTION arena.build_leaderboard_rank_manifest_field_commitment_v1(
  p_source text,
  p_source_trader_id text,
  p_roi numeric,
  p_pnl numeric,
  p_win_rate numeric,
  p_max_drawdown numeric,
  p_sharpe_ratio numeric,
  p_profit_factor numeric,
  p_trades_count integer,
  p_total_score numeric,
  p_score_factors jsonb,
  p_profitability_score numeric,
  p_risk_control_score numeric,
  p_execution_score numeric
)
RETURNS text
LANGUAGE sql
IMMUTABLE
CALLED ON NULL INPUT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $body$
  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_array(
          'leaderboard-rank-manifest-field-commitment@1',
          arena.encode_leaderboard_rank_manifest_fields_v1(
            p_source,
            p_source_trader_id,
            p_roi,
            p_pnl,
            p_win_rate,
            p_max_drawdown,
            p_sharpe_ratio,
            p_profit_factor,
            p_trades_count,
            p_total_score,
            p_score_factors,
            p_profitability_score,
            p_risk_control_score,
            p_execution_score
          )
        )::text,
        'UTF8'
      )
    ),
    'hex'
  )
$body$;

CREATE FUNCTION arena.build_leaderboard_rank_manifest_chunk_sha256_v1(
  p_season_id text,
  p_generation_seq bigint,
  p_score_cohort_id uuid,
  p_score_input_manifest_id uuid,
  p_score_input_manifest_digest text,
  p_chunk_index integer,
  p_first_position integer,
  p_row_count integer,
  p_identities jsonb,
  p_field_commitments jsonb
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
CALLED ON NULL INPUT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  v_has_invalid_identity boolean;
  v_has_invalid_commitment boolean;
  v_has_nonascending_identity boolean;
BEGIN
  IF p_season_id IS NULL OR p_season_id NOT IN ('7D', '30D', '90D')
     OR p_generation_seq IS NULL
     OR p_generation_seq <= 0
     OR p_generation_seq > 9007199254740000
     OR p_score_cohort_id IS NULL
     OR p_score_input_manifest_id IS NULL
     OR p_score_input_manifest_digest IS NULL
     OR p_score_input_manifest_digest !~ '^[0-9a-f]{64}$'
     OR p_chunk_index IS NULL
     OR p_chunk_index < 0 OR p_chunk_index >= 64
     OR p_first_position IS NULL
     OR p_first_position <> p_chunk_index * 1000 + 1
     OR p_row_count IS NULL
     OR p_row_count < 1 OR p_row_count > 1000
     OR p_identities IS NULL
     OR p_field_commitments IS NULL
     OR pg_catalog.jsonb_typeof(p_identities) <> 'array'
     OR pg_catalog.jsonb_typeof(p_field_commitments) <> 'array' THEN
    RAISE EXCEPTION 'manifest attestation chunk header is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.pg_column_size(p_identities) > 8388608
     OR pg_catalog.pg_column_size(p_field_commitments) > 8388608
     OR pg_catalog.jsonb_array_length(p_identities) <> p_row_count
     OR pg_catalog.jsonb_array_length(p_field_commitments) <> p_row_count THEN
    RAISE EXCEPTION 'manifest attestation chunk arrays are invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.bool_or(
    pg_catalog.jsonb_typeof(identity_row.value) <> 'array'
    OR pg_catalog.jsonb_array_length(identity_row.value) <> 2
    OR pg_catalog.jsonb_typeof(identity_row.value->0) <> 'string'
    OR pg_catalog.jsonb_typeof(identity_row.value->1) <> 'string'
    OR identity_row.value->>0 !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
    OR identity_row.value->>0 <>
         pg_catalog.lower(pg_catalog.btrim(identity_row.value->>0))
    OR pg_catalog.char_length(identity_row.value->>0) > 128
    OR identity_row.value->>1 <> pg_catalog.btrim(identity_row.value->>1)
    OR identity_row.value->>1 = ''
    OR pg_catalog.char_length(identity_row.value->>1) > 512
  )
  INTO STRICT v_has_invalid_identity
  FROM pg_catalog.jsonb_array_elements(p_identities) AS identity_row(value);

  SELECT pg_catalog.bool_or(
    pg_catalog.jsonb_typeof(commitment_row.value) <> 'string'
    OR commitment_row.value#>>'{}' !~ '^[0-9a-f]{64}$'
  )
  INTO STRICT v_has_invalid_commitment
  FROM pg_catalog.jsonb_array_elements(p_field_commitments)
    AS commitment_row(value);

  WITH ordered AS (
    SELECT
      identity_row.ordinality,
      identity_row.value->>0 AS source,
      identity_row.value->>1 AS source_trader_id,
      pg_catalog.lag(identity_row.value->>0) OVER (
        ORDER BY identity_row.ordinality
      ) AS prior_source,
      pg_catalog.lag(identity_row.value->>1) OVER (
        ORDER BY identity_row.ordinality
      ) AS prior_source_trader_id
    FROM pg_catalog.jsonb_array_elements(p_identities) WITH ORDINALITY
      AS identity_row(value, ordinality)
  )
  SELECT pg_catalog.bool_or(
    ordered.prior_source IS NOT NULL
    AND ROW(
      ordered.prior_source COLLATE pg_catalog."C",
      ordered.prior_source_trader_id COLLATE pg_catalog."C"
    ) >= ROW(
      ordered.source COLLATE pg_catalog."C",
      ordered.source_trader_id COLLATE pg_catalog."C"
    )
  )
  INTO STRICT v_has_nonascending_identity
  FROM ordered;

  IF v_has_invalid_identity
     OR v_has_invalid_commitment
     OR v_has_nonascending_identity THEN
    RAISE EXCEPTION 'manifest attestation chunk content is invalid'
      USING ERRCODE = '22023';
  END IF;

  RETURN pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_array(
          'leaderboard-rank-manifest-attestation-chunk@1',
          p_season_id,
          p_generation_seq,
          p_score_cohort_id::text,
          p_score_input_manifest_id::text,
          p_score_input_manifest_digest,
          p_chunk_index,
          p_first_position,
          p_row_count,
          p_identities,
          p_field_commitments
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );
END;
$body$;

CREATE FUNCTION arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1(
  p_season_id text,
  p_generation_seq bigint,
  p_score_cohort_id uuid,
  p_score_input_manifest_id uuid,
  p_score_input_manifest_digest text,
  p_chunk_index integer,
  p_first_position integer,
  p_row_count integer,
  p_identities jsonb,
  p_field_commitments jsonb,
  p_chunk_sha256 text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
CALLED ON NULL INPUT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $body$
BEGIN
  IF p_chunk_sha256 IS NULL OR p_chunk_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;
  RETURN p_chunk_sha256 =
    arena.build_leaderboard_rank_manifest_chunk_sha256_v1(
      p_season_id,
      p_generation_seq,
      p_score_cohort_id,
      p_score_input_manifest_id,
      p_score_input_manifest_digest,
      p_chunk_index,
      p_first_position,
      p_row_count,
      p_identities,
      p_field_commitments
    );
EXCEPTION
  WHEN SQLSTATE '22023' THEN
    RETURN false;
END;
$body$;

CREATE FUNCTION arena.build_leaderboard_rank_manifest_chunks_sha256_v1(
  p_season_id text,
  p_generation_seq bigint,
  p_score_cohort_id uuid,
  p_score_input_manifest_id uuid,
  p_score_input_manifest_digest text,
  p_positive_count integer,
  p_chunk_count integer,
  p_chunk_plan jsonb
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
CALLED ON NULL INPUT
PARALLEL SAFE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  v_invalid_plan boolean;
BEGIN
  IF p_season_id IS NULL OR p_season_id NOT IN ('7D', '30D', '90D')
     OR p_generation_seq IS NULL
     OR p_generation_seq <= 0
     OR p_generation_seq > 9007199254740000
     OR p_score_cohort_id IS NULL
     OR p_score_input_manifest_id IS NULL
     OR p_score_input_manifest_digest IS NULL
     OR p_score_input_manifest_digest !~ '^[0-9a-f]{64}$'
     OR p_positive_count IS NULL
     OR p_positive_count < 1 OR p_positive_count > 64000
     OR p_chunk_count IS NULL
     OR p_chunk_count <> (p_positive_count + 999) / 1000
     OR p_chunk_count < 1 OR p_chunk_count > 64
     OR p_chunk_plan IS NULL
     OR pg_catalog.jsonb_typeof(p_chunk_plan) <> 'array' THEN
    RAISE EXCEPTION 'manifest attestation plan header is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.pg_column_size(p_chunk_plan) > 1048576
     OR pg_catalog.jsonb_array_length(p_chunk_plan) <> p_chunk_count THEN
    RAISE EXCEPTION 'manifest attestation plan size is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.bool_or(
    pg_catalog.jsonb_typeof(plan_row.value) <> 'array'
    OR pg_catalog.jsonb_array_length(plan_row.value) <> 4
    OR pg_catalog.jsonb_typeof(plan_row.value->0) <> 'number'
    OR pg_catalog.jsonb_typeof(plan_row.value->1) <> 'number'
    OR pg_catalog.jsonb_typeof(plan_row.value->2) <> 'number'
    OR pg_catalog.jsonb_typeof(plan_row.value->3) <> 'string'
    OR plan_row.value->>0 <> (plan_row.ordinality - 1)::text
    OR plan_row.value->>1 <>
         (((plan_row.ordinality - 1) * 1000) + 1)::text
    OR plan_row.value->>2 <> CASE
      WHEN plan_row.ordinality < p_chunk_count THEN '1000'
      ELSE (p_positive_count - ((p_chunk_count - 1) * 1000))::text
    END
    OR plan_row.value->>3 !~ '^[0-9a-f]{64}$'
  )
  INTO STRICT v_invalid_plan
  FROM pg_catalog.jsonb_array_elements(p_chunk_plan) WITH ORDINALITY
    AS plan_row(value, ordinality);

  IF v_invalid_plan THEN
    RAISE EXCEPTION 'manifest attestation plan topology is invalid'
      USING ERRCODE = '22023';
  END IF;

  RETURN pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_array(
          'leaderboard-rank-manifest-attestation-plan@1',
          p_season_id,
          p_generation_seq,
          p_score_cohort_id::text,
          p_score_input_manifest_id::text,
          p_score_input_manifest_digest,
          p_positive_count,
          p_chunk_count,
          p_chunk_plan
        )::text,
        'UTF8'
      )
    ),
    'hex'
  );
END;
$body$;

CREATE TABLE arena.leaderboard_rank_manifest_attestations (
  contract text NOT NULL,
  season_id text NOT NULL,
  generation_seq bigint NOT NULL,
  score_cohort_id uuid NOT NULL,
  score_input_manifest_id uuid NOT NULL,
  score_input_manifest_digest text NOT NULL,
  batch_index integer NOT NULL DEFAULT 0,
  manifest_valid_until timestamptz NOT NULL,
  positive_count integer NOT NULL,
  chunk_count integer NOT NULL,
  chunks_sha256 text NOT NULL,
  attested_at timestamptz NOT NULL,
  CONSTRAINT rank_manifest_attestation_pkey
    PRIMARY KEY (season_id, generation_seq),
  CONSTRAINT rank_manifest_attestation_identity_key
    UNIQUE (
      season_id,
      generation_seq,
      score_cohort_id,
      score_input_manifest_id,
      score_input_manifest_digest
    ),
  CONSTRAINT rank_manifest_attestation_contract_check
    CHECK (contract = 'leaderboard-rank-manifest-attestation@1'),
  CONSTRAINT rank_manifest_attestation_season_check
    CHECK (season_id IN ('7D', '30D', '90D')),
  CONSTRAINT rank_manifest_attestation_sequence_check
    CHECK (generation_seq > 0 AND generation_seq <= 9007199254740000),
  CONSTRAINT rank_manifest_attestation_digest_check
    CHECK (score_input_manifest_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rank_manifest_attestation_batch_zero_check
    CHECK (batch_index = 0),
  CONSTRAINT rank_manifest_attestation_valid_until_check
    CHECK (pg_catalog.isfinite(manifest_valid_until)),
  CONSTRAINT rank_manifest_attestation_positive_count_check
    CHECK (positive_count >= 1 AND positive_count <= 64000),
  CONSTRAINT rank_manifest_attestation_chunk_count_check
    CHECK (
      chunk_count = (positive_count + 999) / 1000
      AND chunk_count >= 1
      AND chunk_count <= 64
    ),
  CONSTRAINT rank_manifest_attestation_chunks_digest_check
    CHECK (chunks_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rank_manifest_attestation_time_check
    CHECK (
      pg_catalog.isfinite(attested_at)
      AND attested_at <= manifest_valid_until
    ),
  CONSTRAINT rank_manifest_attestation_binding_fkey
    FOREIGN KEY (
      season_id,
      generation_seq,
      score_cohort_id,
      score_input_manifest_id,
      score_input_manifest_digest
    )
    REFERENCES arena.leaderboard_rank_generation_manifest_bindings (
      season_id,
      generation_seq,
      score_cohort_id,
      score_input_manifest_id,
      score_input_manifest_digest
    ),
  CONSTRAINT rank_manifest_attestation_batch_zero_fkey
    FOREIGN KEY (season_id, generation_seq, batch_index)
    REFERENCES arena.leaderboard_rank_generation_batch_receipts (
      season_id,
      generation_seq,
      batch_index
    )
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE arena.leaderboard_rank_manifest_attestation_chunks (
  contract text NOT NULL,
  season_id text NOT NULL,
  generation_seq bigint NOT NULL,
  score_cohort_id uuid NOT NULL,
  score_input_manifest_id uuid NOT NULL,
  score_input_manifest_digest text NOT NULL,
  chunk_index integer NOT NULL,
  first_position integer NOT NULL,
  row_count integer NOT NULL,
  identities jsonb NOT NULL,
  field_commitments jsonb NOT NULL,
  chunk_sha256 text NOT NULL,
  CONSTRAINT rank_manifest_attestation_chunk_pkey
    PRIMARY KEY (season_id, generation_seq, chunk_index),
  CONSTRAINT rank_manifest_attestation_chunk_identity_key
    UNIQUE (
      season_id,
      generation_seq,
      score_cohort_id,
      score_input_manifest_id,
      score_input_manifest_digest,
      chunk_index
    ),
  CONSTRAINT rank_manifest_attestation_chunk_contract_check
    CHECK (contract = 'leaderboard-rank-manifest-attestation-chunk@1'),
  CONSTRAINT rank_manifest_attestation_chunk_index_check
    CHECK (chunk_index >= 0 AND chunk_index < 64),
  CONSTRAINT rank_manifest_attestation_chunk_position_check
    CHECK (first_position = chunk_index * 1000 + 1),
  CONSTRAINT rank_manifest_attestation_chunk_row_count_check
    CHECK (row_count >= 1 AND row_count <= 1000),
  CONSTRAINT rank_manifest_attestation_chunk_content_check
    CHECK (
      arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1(
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
    ),
  CONSTRAINT rank_manifest_attestation_chunk_header_fkey
    FOREIGN KEY (
      season_id,
      generation_seq,
      score_cohort_id,
      score_input_manifest_id,
      score_input_manifest_digest
    )
    REFERENCES arena.leaderboard_rank_manifest_attestations (
      season_id,
      generation_seq,
      score_cohort_id,
      score_input_manifest_id,
      score_input_manifest_digest
    )
);

CREATE FUNCTION arena.guard_leaderboard_rank_manifest_attestation_chunk_insert_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  v_header_xmin xid;
  v_current_xid xid;
BEGIN
  SELECT header.xmin
  INTO STRICT v_header_xmin
  FROM ONLY arena.leaderboard_rank_manifest_attestations AS header
  WHERE header.season_id = NEW.season_id
    AND header.generation_seq = NEW.generation_seq
    AND header.score_cohort_id = NEW.score_cohort_id
    AND header.score_input_manifest_id = NEW.score_input_manifest_id
    AND header.score_input_manifest_digest =
          NEW.score_input_manifest_digest
  FOR KEY SHARE;

  v_current_xid := pg_catalog.pg_current_xact_id()::xid;
  IF v_header_xmin <> v_current_xid THEN
    RAISE EXCEPTION 'manifest attestation chunks are immutable after header commit'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
EXCEPTION
  WHEN no_data_found THEN
    RAISE EXCEPTION 'manifest attestation chunk has no exact current header'
      USING ERRCODE = '23503';
END;
$body$;

CREATE FUNCTION arena.validate_leaderboard_rank_manifest_attestation_complete_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $body$
DECLARE
  v_chunk_count integer;
  v_row_count bigint;
  v_chunk_plan jsonb;
  v_plan_sha256 text;
  v_cross_chunk_disorder boolean;
  v_current_xid xid;
BEGIN
  v_current_xid := pg_catalog.pg_current_xact_id()::xid;

  IF NOT EXISTS (
    SELECT 1
    FROM ONLY arena.leaderboard_rank_generation_batch_receipts AS receipt
    JOIN ONLY arena.leaderboard_rank_generation_manifest_bindings AS binding
      ON binding.season_id = receipt.season_id
     AND binding.generation_seq = receipt.generation_seq
     AND binding.score_cohort_id = receipt.score_cohort_id
     AND binding.score_input_manifest_id = receipt.score_input_manifest_id
     AND binding.score_input_manifest_digest =
           receipt.score_input_manifest_digest
    WHERE receipt.season_id = NEW.season_id
      AND receipt.generation_seq = NEW.generation_seq
      AND receipt.batch_index = 0
      AND receipt.score_cohort_id = NEW.score_cohort_id
      AND receipt.score_input_manifest_id = NEW.score_input_manifest_id
      AND receipt.score_input_manifest_digest =
            NEW.score_input_manifest_digest
      AND receipt.completed_at = NEW.attested_at
      AND receipt.xmin = v_current_xid
      AND binding.xmin = v_current_xid
  ) THEN
    RAISE EXCEPTION
      'manifest attestation lacks current-transaction binding and batch-zero receipt'
      USING ERRCODE = '23503';
  END IF;

  PERFORM manifest.manifest_id
  FROM ONLY arena.leaderboard_score_input_manifests AS manifest
  WHERE manifest.manifest_id = NEW.score_input_manifest_id
    AND manifest.manifest_digest = NEW.score_input_manifest_digest
    AND manifest.period = NEW.season_id
    AND manifest.valid_until = NEW.manifest_valid_until
    AND manifest.valid_until > pg_catalog.clock_timestamp()
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'manifest attestation lacks its exact live source manifest'
      USING ERRCODE = '23503';
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    COALESCE(pg_catalog.sum(chunk.row_count), 0),
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          chunk.chunk_index,
          chunk.first_position,
          chunk.row_count,
          chunk.chunk_sha256
        )
        ORDER BY chunk.chunk_index
      ),
      '[]'::jsonb
    )
  INTO STRICT v_chunk_count, v_row_count, v_chunk_plan
  FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
  WHERE chunk.season_id = NEW.season_id
    AND chunk.generation_seq = NEW.generation_seq
    AND chunk.score_cohort_id = NEW.score_cohort_id
    AND chunk.score_input_manifest_id = NEW.score_input_manifest_id
    AND chunk.score_input_manifest_digest = NEW.score_input_manifest_digest;

  IF v_chunk_count <> NEW.chunk_count
     OR v_row_count <> NEW.positive_count THEN
    RAISE EXCEPTION 'manifest attestation chunk population is incomplete'
      USING ERRCODE = '23514';
  END IF;

  v_plan_sha256 := arena.build_leaderboard_rank_manifest_chunks_sha256_v1(
    NEW.season_id,
    NEW.generation_seq,
    NEW.score_cohort_id,
    NEW.score_input_manifest_id,
    NEW.score_input_manifest_digest,
    NEW.positive_count,
    NEW.chunk_count,
    v_chunk_plan
  );
  IF v_plan_sha256 <> NEW.chunks_sha256 THEN
    RAISE EXCEPTION 'manifest attestation chunk plan digest is invalid'
      USING ERRCODE = '23514';
  END IF;

  WITH flattened AS MATERIALIZED (
    SELECT
      chunk.chunk_index,
      identity_row.ordinality,
      identity_row.value->>0 AS source,
      identity_row.value->>1 AS source_trader_id
    FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      chunk.identities
    ) WITH ORDINALITY AS identity_row(value, ordinality)
    WHERE chunk.season_id = NEW.season_id
      AND chunk.generation_seq = NEW.generation_seq
  ), ordered AS MATERIALIZED (
    SELECT
      flattened.*,
      pg_catalog.lag(flattened.source) OVER (
        ORDER BY flattened.chunk_index, flattened.ordinality
      ) AS prior_source,
      pg_catalog.lag(flattened.source_trader_id) OVER (
        ORDER BY flattened.chunk_index, flattened.ordinality
      ) AS prior_source_trader_id
    FROM flattened
  )
  SELECT pg_catalog.bool_or(
    ordered.prior_source IS NOT NULL
    AND ROW(
      ordered.prior_source COLLATE pg_catalog."C",
      ordered.prior_source_trader_id COLLATE pg_catalog."C"
    ) >= ROW(
      ordered.source COLLATE pg_catalog."C",
      ordered.source_trader_id COLLATE pg_catalog."C"
    )
  )
  INTO STRICT v_cross_chunk_disorder
  FROM ordered;

  IF v_cross_chunk_disorder THEN
    RAISE EXCEPTION 'manifest attestation identity order is not globally strict'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$body$;

ALTER FUNCTION arena.encode_leaderboard_rank_manifest_fields_v1(
  text, text, numeric, numeric, numeric, numeric, numeric, numeric,
  integer, numeric, jsonb, numeric, numeric, numeric
) OWNER TO postgres;
ALTER FUNCTION arena.build_leaderboard_rank_manifest_field_commitment_v1(
  text, text, numeric, numeric, numeric, numeric, numeric, numeric,
  integer, numeric, jsonb, numeric, numeric, numeric
) OWNER TO postgres;
ALTER FUNCTION arena.build_leaderboard_rank_manifest_chunk_sha256_v1(
  text, bigint, uuid, uuid, text, integer, integer, integer, jsonb, jsonb
) OWNER TO postgres;
ALTER FUNCTION arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1(
  text, bigint, uuid, uuid, text, integer, integer, integer, jsonb, jsonb,
  text
) OWNER TO postgres;
ALTER FUNCTION arena.build_leaderboard_rank_manifest_chunks_sha256_v1(
  text, bigint, uuid, uuid, text, integer, integer, jsonb
) OWNER TO postgres;
ALTER FUNCTION arena.guard_leaderboard_rank_manifest_attestation_chunk_insert_v1()
  OWNER TO postgres;
ALTER FUNCTION arena.validate_leaderboard_rank_manifest_attestation_complete_v1()
  OWNER TO postgres;

ALTER TABLE arena.leaderboard_rank_manifest_attestations OWNER TO postgres;
ALTER TABLE arena.leaderboard_rank_manifest_attestation_chunks OWNER TO postgres;
ALTER TABLE arena.leaderboard_rank_manifest_attestations
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_rank_manifest_attestation_chunks
  ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER leaderboard_rank_manifest_attestations_immutable
BEFORE UPDATE OR DELETE
ON arena.leaderboard_rank_manifest_attestations
FOR EACH ROW
EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

CREATE TRIGGER leaderboard_rank_manifest_attestations_no_truncate
BEFORE TRUNCATE
ON arena.leaderboard_rank_manifest_attestations
FOR EACH STATEMENT
EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

CREATE CONSTRAINT TRIGGER leaderboard_rank_manifest_attestations_complete
AFTER INSERT
ON arena.leaderboard_rank_manifest_attestations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION
  arena.validate_leaderboard_rank_manifest_attestation_complete_v1();

CREATE TRIGGER leaderboard_rank_manifest_attestation_chunks_insert_guard
BEFORE INSERT
ON arena.leaderboard_rank_manifest_attestation_chunks
FOR EACH ROW
EXECUTE FUNCTION
  arena.guard_leaderboard_rank_manifest_attestation_chunk_insert_v1();

CREATE TRIGGER leaderboard_rank_manifest_attestation_chunks_immutable
BEFORE UPDATE OR DELETE
ON arena.leaderboard_rank_manifest_attestation_chunks
FOR EACH ROW
EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

CREATE TRIGGER leaderboard_rank_manifest_attestation_chunks_no_truncate
BEFORE TRUNCATE
ON arena.leaderboard_rank_manifest_attestation_chunks
FOR EACH STATEMENT
EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

REVOKE ALL ON TABLE arena.leaderboard_rank_manifest_attestations
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE arena.leaderboard_rank_manifest_attestation_chunks
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION arena.encode_leaderboard_rank_manifest_fields_v1(
  text, text, numeric, numeric, numeric, numeric, numeric, numeric,
  integer, numeric, jsonb, numeric, numeric, numeric
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.build_leaderboard_rank_manifest_field_commitment_v1(
  text, text, numeric, numeric, numeric, numeric, numeric, numeric,
  integer, numeric, jsonb, numeric, numeric, numeric
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.build_leaderboard_rank_manifest_chunk_sha256_v1(
  text, bigint, uuid, uuid, text, integer, integer, integer, jsonb, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1(
  text, bigint, uuid, uuid, text, integer, integer, integer, jsonb, jsonb,
  text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.build_leaderboard_rank_manifest_chunks_sha256_v1(
  text, bigint, uuid, uuid, text, integer, integer, jsonb
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.guard_leaderboard_rank_manifest_attestation_chunk_insert_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.validate_leaderboard_rank_manifest_attestation_complete_v1()
  FROM PUBLIC, anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_header pg_catalog.regclass := pg_catalog.to_regclass(
    'arena.leaderboard_rank_manifest_attestations'
  );
  v_chunks pg_catalog.regclass := pg_catalog.to_regclass(
    'arena.leaderboard_rank_manifest_attestation_chunks'
  );
BEGIN
  IF v_header IS NULL OR v_chunks IS NULL THEN
    RAISE EXCEPTION 'manifest attestation postflight relation is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    WHERE table_row.oid IN (v_header, v_chunks)
      AND (
        table_row.relkind <> 'r'
        OR table_row.relpersistence <> 'p'
        OR table_row.relispartition
        OR table_row.relowner <> 'postgres'::pg_catalog.regrole
        OR NOT table_row.relrowsecurity
        OR table_row.relforcerowsecurity
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid IN (v_header, v_chunks)
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rule_row
    WHERE rule_row.ev_class IN (v_header, v_chunks)
      AND rule_row.rulename <> '_RETURN'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(table_row.relacl, pg_catalog.acldefault('r', table_row.relowner))
    ) AS expanded
    WHERE table_row.oid IN (v_header, v_chunks)
      AND expanded.grantee <> table_row.relowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS expanded
    WHERE attribute.attrelid IN (v_header, v_chunks)
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'manifest attestation owner, RLS, policy, or ACL drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_header
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 12 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_chunks
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 12 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (v_header::oid, 'contract'::name, 'text'::pg_catalog.regtype),
        (v_header::oid, 'season_id'::name, 'text'::pg_catalog.regtype),
        (v_header::oid, 'generation_seq'::name, 'bigint'::pg_catalog.regtype),
        (v_header::oid, 'score_cohort_id'::name, 'uuid'::pg_catalog.regtype),
        (v_header::oid, 'score_input_manifest_id'::name, 'uuid'::pg_catalog.regtype),
        (v_header::oid, 'score_input_manifest_digest'::name, 'text'::pg_catalog.regtype),
        (v_header::oid, 'batch_index'::name, 'integer'::pg_catalog.regtype),
        (v_header::oid, 'manifest_valid_until'::name, 'timestamp with time zone'::pg_catalog.regtype),
        (v_header::oid, 'positive_count'::name, 'integer'::pg_catalog.regtype),
        (v_header::oid, 'chunk_count'::name, 'integer'::pg_catalog.regtype),
        (v_header::oid, 'chunks_sha256'::name, 'text'::pg_catalog.regtype),
        (v_header::oid, 'attested_at'::name, 'timestamp with time zone'::pg_catalog.regtype),
        (v_chunks::oid, 'contract'::name, 'text'::pg_catalog.regtype),
        (v_chunks::oid, 'season_id'::name, 'text'::pg_catalog.regtype),
        (v_chunks::oid, 'generation_seq'::name, 'bigint'::pg_catalog.regtype),
        (v_chunks::oid, 'score_cohort_id'::name, 'uuid'::pg_catalog.regtype),
        (v_chunks::oid, 'score_input_manifest_id'::name, 'uuid'::pg_catalog.regtype),
        (v_chunks::oid, 'score_input_manifest_digest'::name, 'text'::pg_catalog.regtype),
        (v_chunks::oid, 'chunk_index'::name, 'integer'::pg_catalog.regtype),
        (v_chunks::oid, 'first_position'::name, 'integer'::pg_catalog.regtype),
        (v_chunks::oid, 'row_count'::name, 'integer'::pg_catalog.regtype),
        (v_chunks::oid, 'identities'::name, 'jsonb'::pg_catalog.regtype),
        (v_chunks::oid, 'field_commitments'::name, 'jsonb'::pg_catalog.regtype),
        (v_chunks::oid, 'chunk_sha256'::name, 'text'::pg_catalog.regtype)
    ) AS expected(relation_oid, column_name, type_oid)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = expected.relation_oid
     AND attribute.attname = expected.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR attribute.atttypid <> expected.type_oid
       OR NOT attribute.attnotnull
       OR attribute.attidentity <> ''
       OR attribute.attgenerated <> ''
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attrdef AS default_row
    WHERE default_row.adrelid IN (v_header, v_chunks)
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attrdef AS default_row
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = default_row.adrelid
     AND attribute.attnum = default_row.adnum
    WHERE default_row.adrelid = v_header
      AND attribute.attname = 'batch_index'
      AND pg_catalog.pg_get_expr(
            default_row.adbin,
            default_row.adrelid,
            false
          ) = '0'
  ) THEN
    RAISE EXCEPTION 'manifest attestation exact column catalog drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (v_header, v_chunks)
  ) <> 23 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (v_header, v_chunks)
      AND NOT constraint_row.convalidated
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (v_header, v_chunks)
      AND constraint_row.confrelid =
            'arena.leaderboard_score_input_manifests'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION
      'manifest attestation constraint catalog drifted: count %, invalid %, raw manifest FK %',
      (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid IN (v_header, v_chunks)
      ),
      (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid IN (v_header, v_chunks)
          AND NOT constraint_row.convalidated
      ),
      (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid IN (v_header, v_chunks)
          AND constraint_row.confrelid =
                'arena.leaderboard_score_input_manifests'::pg_catalog.regclass
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_header
      AND constraint_row.conname = 'rank_manifest_attestation_binding_fkey'
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid =
            'arena.leaderboard_rank_generation_manifest_bindings'::pg_catalog.regclass
      AND NOT constraint_row.condeferrable
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, false) =
            'FOREIGN KEY (season_id, generation_seq, score_cohort_id, score_input_manifest_id, score_input_manifest_digest) REFERENCES arena.leaderboard_rank_generation_manifest_bindings(season_id, generation_seq, score_cohort_id, score_input_manifest_id, score_input_manifest_digest)'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_header
      AND constraint_row.conname = 'rank_manifest_attestation_batch_zero_fkey'
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid =
            'arena.leaderboard_rank_generation_batch_receipts'::pg_catalog.regclass
      AND constraint_row.condeferrable
      AND constraint_row.condeferred
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_chunks
      AND constraint_row.conname =
            'rank_manifest_attestation_chunk_header_fkey'
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = v_header
      AND NOT constraint_row.condeferrable
  ) THEN
    RAISE EXCEPTION 'manifest attestation foreign-key topology drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_header
      AND NOT trigger_row.tgisinternal
  ) <> 3 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_chunks
      AND NOT trigger_row.tgisinternal
  ) <> 3 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_header
      AND trigger_row.tgname =
            'leaderboard_rank_manifest_attestations_complete'
      AND trigger_row.tgconstraint <> 0
      AND trigger_row.tgdeferrable
      AND trigger_row.tginitdeferred
      AND pg_catalog.pg_get_triggerdef(trigger_row.oid, false) LIKE
            '%AFTER INSERT%DEFERRABLE INITIALLY DEFERRED%'
  ) THEN
    RAISE EXCEPTION 'manifest attestation trigger catalog drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          v_header::oid,
          'leaderboard_rank_manifest_attestations_immutable'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::pg_catalog.regprocedure::oid,
          27::smallint,
          false,
          false,
          false
        ),
        (
          v_header::oid,
          'leaderboard_rank_manifest_attestations_no_truncate'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::pg_catalog.regprocedure::oid,
          34::smallint,
          false,
          false,
          false
        ),
        (
          v_header::oid,
          'leaderboard_rank_manifest_attestations_complete'::name,
          'arena.validate_leaderboard_rank_manifest_attestation_complete_v1()'::pg_catalog.regprocedure::oid,
          5::smallint,
          true,
          true,
          true
        ),
        (
          v_chunks::oid,
          'leaderboard_rank_manifest_attestation_chunks_insert_guard'::name,
          'arena.guard_leaderboard_rank_manifest_attestation_chunk_insert_v1()'::pg_catalog.regprocedure::oid,
          7::smallint,
          false,
          false,
          false
        ),
        (
          v_chunks::oid,
          'leaderboard_rank_manifest_attestation_chunks_immutable'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::pg_catalog.regprocedure::oid,
          27::smallint,
          false,
          false,
          false
        ),
        (
          v_chunks::oid,
          'leaderboard_rank_manifest_attestation_chunks_no_truncate'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::pg_catalog.regprocedure::oid,
          34::smallint,
          false,
          false,
          false
        )
    ) AS expected(
      relation_oid,
      trigger_name,
      function_oid,
      trigger_type,
      is_constraint,
      is_deferrable,
      is_initially_deferred
    )
    LEFT JOIN pg_catalog.pg_trigger AS trigger_row
      ON trigger_row.tgrelid = expected.relation_oid
     AND trigger_row.tgname = expected.trigger_name
    WHERE trigger_row.oid IS NULL
       OR trigger_row.tgfoid <> expected.function_oid
       OR trigger_row.tgtype <> expected.trigger_type
       OR (trigger_row.tgconstraint <> 0) <> expected.is_constraint
       OR trigger_row.tgdeferrable <> expected.is_deferrable
       OR trigger_row.tginitdeferred <> expected.is_initially_deferred
       OR trigger_row.tgenabled <> 'O'
       OR trigger_row.tgisinternal
       OR trigger_row.tgparentid <> 0
       OR trigger_row.tgnargs <> 0
       OR trigger_row.tgqual IS NOT NULL
       OR trigger_row.tgoldtable IS NOT NULL
       OR trigger_row.tgnewtable IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'manifest attestation exact trigger definition drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'arena'
      AND function_row.proname IN (
        'encode_leaderboard_rank_manifest_fields_v1',
        'build_leaderboard_rank_manifest_field_commitment_v1',
        'build_leaderboard_rank_manifest_chunk_sha256_v1',
        'leaderboard_rank_manifest_attestation_chunk_is_valid_v1',
        'build_leaderboard_rank_manifest_chunks_sha256_v1',
        'guard_leaderboard_rank_manifest_attestation_chunk_insert_v1',
        'validate_leaderboard_rank_manifest_attestation_complete_v1'
      )
  ) <> 7 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'arena'
      AND function_row.proname IN (
        'encode_leaderboard_rank_manifest_fields_v1',
        'build_leaderboard_rank_manifest_field_commitment_v1',
        'build_leaderboard_rank_manifest_chunk_sha256_v1',
        'leaderboard_rank_manifest_attestation_chunk_is_valid_v1',
        'build_leaderboard_rank_manifest_chunks_sha256_v1',
        'guard_leaderboard_rank_manifest_attestation_chunk_insert_v1',
        'validate_leaderboard_rank_manifest_attestation_complete_v1'
      )
      AND (
        function_row.proowner <> 'postgres'::pg_catalog.regrole
        OR function_row.prokind <> 'f'
        OR function_row.prosqlbody IS NOT NULL
        OR function_row.probin IS NOT NULL
        OR function_row.proconfig IS DISTINCT FROM
             ARRAY['search_path=pg_catalog, pg_temp']::text[]
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS expanded
    WHERE function_row.oid IN (
      'arena.encode_leaderboard_rank_manifest_fields_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'::pg_catalog.regprocedure,
      'arena.build_leaderboard_rank_manifest_field_commitment_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'::pg_catalog.regprocedure,
      'arena.build_leaderboard_rank_manifest_chunk_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb)'::pg_catalog.regprocedure,
      'arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb,text)'::pg_catalog.regprocedure,
      'arena.build_leaderboard_rank_manifest_chunks_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,jsonb)'::pg_catalog.regprocedure,
      'arena.guard_leaderboard_rank_manifest_attestation_chunk_insert_v1()'::pg_catalog.regprocedure,
      'arena.validate_leaderboard_rank_manifest_attestation_complete_v1()'::pg_catalog.regprocedure
    )
      AND expanded.grantee <> function_row.proowner
  ) THEN
    RAISE EXCEPTION 'manifest attestation function catalog or ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'arena.encode_leaderboard_rank_manifest_fields_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)',
          'plpgsql'::name,
          'jsonb'::pg_catalog.regtype,
          'i'::"char",
          's'::"char",
          false,
          '504e8b8fc47f023bb9e821b7b6212f4df773cb94e63cfd5613fb2fff01964b16'
        ),
        (
          'arena.build_leaderboard_rank_manifest_field_commitment_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)',
          'sql'::name,
          'text'::pg_catalog.regtype,
          'i'::"char",
          's'::"char",
          false,
          '72c4e558313daec92785722c35788e6490a4d9a2144261d0afe9d96666ea04f6'
        ),
        (
          'arena.build_leaderboard_rank_manifest_chunk_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb)',
          'plpgsql'::name,
          'text'::pg_catalog.regtype,
          'i'::"char",
          's'::"char",
          false,
          '0dddcffebb56d9a51e0869e29cc16ac18f78251d58907764fb02101fa8dad322'
        ),
        (
          'arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb,text)',
          'plpgsql'::name,
          'boolean'::pg_catalog.regtype,
          'i'::"char",
          's'::"char",
          false,
          'eaead90785261fd8400748497005d34013d468b5a836a0dbce0be38eaf843d07'
        ),
        (
          'arena.build_leaderboard_rank_manifest_chunks_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,jsonb)',
          'plpgsql'::name,
          'text'::pg_catalog.regtype,
          'i'::"char",
          's'::"char",
          false,
          'a663274e1a45e06c90f17fecdb646854be6112cb6e22d2af343afd9737d365dd'
        ),
        (
          'arena.guard_leaderboard_rank_manifest_attestation_chunk_insert_v1()',
          'plpgsql'::name,
          'trigger'::pg_catalog.regtype,
          'v'::"char",
          'u'::"char",
          true,
          '21cbd784ed8016f1a3acbe96ff82885d5679dce10697ddb658cb660ef449caa9'
        ),
        (
          'arena.validate_leaderboard_rank_manifest_attestation_complete_v1()',
          'plpgsql'::name,
          'trigger'::pg_catalog.regtype,
          'v'::"char",
          'u'::"char",
          true,
          'a67d03810591c130b7b6e7dbd63becc9b4d08eb4580fd314a223032e1f187e6b'
        )
    ) AS expected(
      signature,
      language_name,
      return_type,
      volatility,
      parallel_safety,
      security_definer,
      body_sha256
    )
    LEFT JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = pg_catalog.to_regprocedure(expected.signature)
    LEFT JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid IS NULL
       OR language_row.lanname <> expected.language_name
       OR function_row.prorettype <> expected.return_type
       OR function_row.provolatile <> expected.volatility
       OR function_row.proparallel <> expected.parallel_safety
       OR function_row.prosecdef <> expected.security_definer
       OR function_row.proisstrict
       OR function_row.proleakproof
       OR function_row.prosupport <> 0
       OR function_row.procost <> 100
       OR function_row.prorows <> 0
       OR pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(function_row.prosrc, 'UTF8')
            ),
            'hex'
          ) <> expected.body_sha256
  ) THEN
    RAISE EXCEPTION 'manifest attestation exact function definition drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      'arena.encode_leaderboard_rank_manifest_fields_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'::pg_catalog.regprocedure
      AND function_row.provolatile = 'i'
      AND function_row.proparallel = 's'
      AND NOT function_row.prosecdef
      AND NOT function_row.proisstrict
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      'arena.validate_leaderboard_rank_manifest_attestation_complete_v1()'::pg_catalog.regprocedure
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND function_row.prosecdef
      AND function_row.prorettype = 'trigger'::pg_catalog.regtype
  ) THEN
    RAISE EXCEPTION 'manifest attestation function shape drifted';
  END IF;
END
$postflight$;

COMMIT;
