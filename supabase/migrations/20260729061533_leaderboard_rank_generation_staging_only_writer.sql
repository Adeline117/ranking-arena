-- Migration: 20260729061533_leaderboard_rank_generation_staging_only_writer.sql
-- Created: 2026-07-29T06:15:33Z
-- Description: Replace the owner-only rank-generation batch writer with a
--   staging-only implementation. A batch can freeze scorer evidence and append
--   one immutable private version, but cannot alter serving state. Terminal
--   rank fields remain the authority of a later all-generation finalizer.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL quote_all_identifiers = 'off';

DO $bootstrap_preflight$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_generation_heads'
        ) IS NULL THEN
    RAISE EXCEPTION
      'staging-only rank writer requires PG17 and its admission head';
  END IF;
END
$bootstrap_preflight$;

-- This is the first lock by design. It waits for any old writer that already
-- owns a head row and prevents another old call from entering while the body is
-- replaced. Every downstream relation is then frozen in runtime lock order.
LOCK TABLE ONLY arena.leaderboard_rank_generation_heads IN EXCLUSIVE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_claims IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_score_input_manifests IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_manifest_bindings
  IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_batch_receipts
  IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_source_fence_receipts
  IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_manifest_attestations IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_manifest_attestation_chunks
  IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_stage_batches IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_stage_rows IN SHARE MODE;

DO $dependency_preflight$
DECLARE
  v_writer oid := pg_catalog.to_regprocedure(
    'arena.write_leaderboard_rank_generation_batch_v1(text,bigint,uuid,integer,uuid,text,text[],arena.leaderboard_rank_batch_row_v1[])'
  );
  v_constraint_count integer;
  v_constraint_digest text;
  v_index_count integer;
  v_index_digest text;
  v_type_oid oid := pg_catalog.to_regtype(
    'arena.leaderboard_rank_batch_row_v1'
  );
  v_type_relation oid;
  v_type_column_count integer;
  v_type_column_digest text;
BEGIN
  IF pg_catalog.to_regtype(
       'arena.leaderboard_rank_batch_row_v1'
     ) IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_generation_claims'
        ) IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_score_input_manifests'
        ) IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_generation_manifest_bindings'
        ) IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_generation_batch_receipts'
        ) IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_generation_source_fence_receipts'
        ) IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_manifest_attestations'
        ) IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_manifest_attestation_chunks'
        ) IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_generation_stage_batches'
        ) IS NULL
     OR pg_catalog.to_regclass(
          'arena.leaderboard_rank_generation_stage_rows'
        ) IS NULL THEN
    RAISE EXCEPTION 'staging-only rank writer dependencies are missing';
  END IF;

  SELECT type_row.typrelid
  INTO STRICT v_type_relation
  FROM pg_catalog.pg_type AS type_row
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = type_row.typnamespace
  JOIN pg_catalog.pg_class AS relation_row
    ON relation_row.oid = type_row.typrelid
  WHERE type_row.oid = v_type_oid
    AND type_row.typtype = 'c'
    AND type_row.typowner = 'postgres'::pg_catalog.regrole
    AND namespace_row.nspname = 'arena'
    AND relation_row.relkind = 'c'
    AND relation_row.relpersistence = 'p'
    AND relation_row.relowner = 'postgres'::pg_catalog.regrole
    AND NOT relation_row.relispartition
    AND relation_row.reloptions IS NULL;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            pg_catalog.format(
              '%s|%s|%s|%s|%s|%s|%s|%s|%s',
              attribute.attnum,
              attribute.attname,
              pg_catalog.format_type(
                attribute.atttypid,
                attribute.atttypmod
              ),
              attribute.attnotnull,
              attribute.attidentity,
              attribute.attgenerated,
              attribute.attcollation::pg_catalog.regcollation::text,
              attribute.atttypmod,
              attribute.attndims
            ),
            E'\n' ORDER BY attribute.attnum
          ),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO STRICT v_type_column_count, v_type_column_digest
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = v_type_relation
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF v_type_column_count IS DISTINCT FROM 33
     OR v_type_column_digest IS DISTINCT FROM
          '83ce5a148aedce9eb29690cbc7181f46c28bbe8ee08e8f64c4caadaad5f23d82'
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_type AS type_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           type_row.typacl,
           pg_catalog.acldefault('T', type_row.typowner)
         )
       ) AS expanded
       WHERE type_row.oid = v_type_oid
         AND expanded.grantee <> type_row.typowner
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS expanded
       WHERE attribute.attrelid = v_type_relation
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND expanded.grantee <> 'postgres'::pg_catalog.regrole
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES ('anon'), ('authenticated'), ('service_role'))
         AS api(role_name)
       WHERE pg_catalog.has_type_privilege(
         api.role_name,
         v_type_oid,
         'USAGE'
       )
     ) THEN
    RAISE EXCEPTION
      'staging-only rank writer typed batch catalog drifted: %|%',
      v_type_column_count,
      v_type_column_digest;
  END IF;

  IF v_writer IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_writer
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prokind = 'f'
      AND language_row.lanname = 'plpgsql'
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND NOT function_row.prosecdef
      AND NOT function_row.proleakproof
      AND NOT function_row.proisstrict
      AND NOT function_row.proretset
      AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND function_row.pronargs = 8
      AND function_row.pronargdefaults = 0
      AND function_row.proargtypes = ARRAY[
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.int8'::pg_catalog.regtype,
        'pg_catalog.uuid'::pg_catalog.regtype,
        'pg_catalog.int4'::pg_catalog.regtype,
        'pg_catalog.uuid'::pg_catalog.regtype,
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.text[]'::pg_catalog.regtype,
        'arena.leaderboard_rank_batch_row_v1[]'::pg_catalog.regtype
      ]::pg_catalog.oidvector
      AND function_row.proargnames = ARRAY[
        'p_season_id',
        'p_generation_seq',
        'p_score_cohort_id',
        'p_batch_index',
        'p_score_input_manifest_id',
        'p_score_input_manifest_digest',
        'p_batch_sha256_plan',
        'p_rows'
      ]::text[]
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
      ]::text[]
      AND pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(function_row.prosrc, 'UTF8')
            ),
            'hex'
          ) =
          'ddb7c25c0c61c1ea70377bc6879e913a07e4529b1e4c8fa35a4b5d9f2c50f548'
  ) THEN
    RAISE EXCEPTION 'staging-only rank writer baseline drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'arena'
      AND function_row.proname =
          'write_leaderboard_rank_generation_batch_v1'
  ) <> 1 THEN
    RAISE EXCEPTION 'staging-only rank writer has a noncanonical overload';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS expanded
    WHERE function_row.oid = v_writer
      AND expanded.grantee <> function_row.proowner
      AND expanded.privilege_type = 'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM (VALUES ('anon'), ('authenticated'), ('service_role'))
      AS api(role_name)
    WHERE pg_catalog.has_function_privilege(
      api.role_name,
      v_writer,
      'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'staging-only rank writer baseline ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'arena.validate_leaderboard_rank_generation_manifest_binding()',
          '43d006071c25fe6bfd0d8f3c146594f415f388d2a7607663e5220922d80c5781',
          'plpgsql'::name,
          'trigger'::pg_catalog.regtype,
          'v'::"char",
          'u'::"char",
          false,
          ''::text,
          NULL::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)',
          '947062aaac0da5bbe9fa62d5194c9f5f3a2e4d6bec55e158ea87ce70a38074cb',
          'plpgsql'::name,
          'jsonb'::pg_catalog.regtype,
          's'::"char",
          'u'::"char",
          false,
          'text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb, timestamp with time zone',
          ARRAY[
            'p_period',
            'p_source_bundle_digest',
            'p_score_rows_sha256',
            'p_physical_boards_sha256',
            'p_source_evidence',
            'p_enrichment_contract',
            'p_enrichment_evidence',
            'p_eligibility_contract',
            'p_eligibility_evidence',
            'p_inputs',
            'p_valid_until'
          ]::text[],
          ARRAY[
            'search_path=pg_catalog, pg_temp',
            'extra_float_digits=3',
            'quote_all_identifiers=off'
          ]::text[]
        ),
        (
          'arena.verify_leaderboard_score_input_manifest_v1(uuid)',
          '7b678b4d1c9a6835567040e1240d09b15ce38357e3f40251c8b3786ec65f45fc',
          'plpgsql'::name,
          'jsonb'::pg_catalog.regtype,
          's'::"char",
          'u'::"char",
          false,
          'uuid',
          ARRAY['p_manifest_id']::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])',
          '7fa1e9f60a7b6cb4072dce842ddd10c367046fcb431a2ae655a9a806172df67e',
          'plpgsql'::name,
          'jsonb'::pg_catalog.regtype,
          's'::"char",
          's'::"char",
          false,
          'text, uuid, timestamp with time zone, arena.leaderboard_rank_batch_row_v1[]',
          ARRAY[
            'p_season_id',
            'p_score_cohort_id',
            'p_computed_at',
            'p_rows'
          ]::text[],
          ARRAY[
            'search_path=pg_catalog, pg_temp',
            'TimeZone=UTC'
          ]::text[]
        ),
        (
          'arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])',
          'f82b8b26dee4b1b5a92d4750ad42ed65d91bd7972bac0ef0f14f0b94e24f197d',
          'plpgsql'::name,
          'text'::pg_catalog.regtype,
          's'::"char",
          's'::"char",
          false,
          'text, uuid, text, timestamp with time zone, integer, text[]',
          ARRAY[
            'p_season_id',
            'p_score_cohort_id',
            'p_score_input_manifest_digest',
            'p_computed_at',
            'p_expected_rank_count',
            'p_batch_sha256_plan'
          ]::text[],
          ARRAY[
            'search_path=pg_catalog, pg_temp',
            'TimeZone=UTC'
          ]::text[]
        ),
        (
          'arena.build_leaderboard_rank_typed_field_commitment_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)',
          'aafce6e95ed4662239a1f84295cc3158dc0011f8bc8948d0161f73767e73dd9a',
          'sql'::name,
          'text'::pg_catalog.regtype,
          'i'::"char",
          's'::"char",
          false,
          'text, text, numeric, numeric, numeric, numeric, numeric, numeric, integer, numeric, jsonb, numeric, numeric, numeric',
          ARRAY[
            'p_source', 'p_source_trader_id', 'p_roi', 'p_pnl',
            'p_win_rate', 'p_max_drawdown', 'p_sharpe_ratio',
            'p_profit_factor', 'p_trades_count', 'p_total_score',
            'p_score_factors', 'p_profitability_score',
            'p_risk_control_score', 'p_execution_score'
          ]::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.encode_leaderboard_rank_manifest_fields_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)',
          '504e8b8fc47f023bb9e821b7b6212f4df773cb94e63cfd5613fb2fff01964b16',
          'plpgsql'::name,
          'jsonb'::pg_catalog.regtype,
          'i'::"char",
          's'::"char",
          false,
          'text, text, numeric, numeric, numeric, numeric, numeric, numeric, integer, numeric, jsonb, numeric, numeric, numeric',
          ARRAY[
            'p_source', 'p_source_trader_id', 'p_roi', 'p_pnl',
            'p_win_rate', 'p_max_drawdown', 'p_sharpe_ratio',
            'p_profit_factor', 'p_trades_count', 'p_total_score',
            'p_score_factors', 'p_profitability_score',
            'p_risk_control_score', 'p_execution_score'
          ]::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.build_leaderboard_rank_manifest_field_commitment_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)',
          '72c4e558313daec92785722c35788e6490a4d9a2144261d0afe9d96666ea04f6',
          'sql'::name,
          'text'::pg_catalog.regtype,
          'i'::"char",
          's'::"char",
          false,
          'text, text, numeric, numeric, numeric, numeric, numeric, numeric, integer, numeric, jsonb, numeric, numeric, numeric',
          ARRAY[
            'p_source', 'p_source_trader_id', 'p_roi', 'p_pnl',
            'p_win_rate', 'p_max_drawdown', 'p_sharpe_ratio',
            'p_profit_factor', 'p_trades_count', 'p_total_score',
            'p_score_factors', 'p_profitability_score',
            'p_risk_control_score', 'p_execution_score'
          ]::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.build_leaderboard_rank_manifest_chunk_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb)',
          '0dddcffebb56d9a51e0869e29cc16ac18f78251d58907764fb02101fa8dad322',
          'plpgsql'::name,
          'text'::pg_catalog.regtype,
          'i'::"char",
          's'::"char",
          false,
          'text, bigint, uuid, uuid, text, integer, integer, integer, jsonb, jsonb',
          ARRAY[
            'p_season_id', 'p_generation_seq', 'p_score_cohort_id',
            'p_score_input_manifest_id', 'p_score_input_manifest_digest',
            'p_chunk_index', 'p_first_position', 'p_row_count',
            'p_identities', 'p_field_commitments'
          ]::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.build_leaderboard_rank_manifest_chunks_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,jsonb)',
          'a663274e1a45e06c90f17fecdb646854be6112cb6e22d2af343afd9737d365dd',
          'plpgsql'::name,
          'text'::pg_catalog.regtype,
          'i'::"char",
          's'::"char",
          false,
          'text, bigint, uuid, uuid, text, integer, integer, jsonb',
          ARRAY[
            'p_season_id', 'p_generation_seq', 'p_score_cohort_id',
            'p_score_input_manifest_id', 'p_score_input_manifest_digest',
            'p_positive_count', 'p_chunk_count', 'p_chunk_plan'
          ]::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.guard_leaderboard_rank_manifest_attestation_chunk_insert_v1()',
          '21cbd784ed8016f1a3acbe96ff82885d5679dce10697ddb658cb660ef449caa9',
          'plpgsql'::name,
          'trigger'::pg_catalog.regtype,
          'v'::"char",
          'u'::"char",
          true,
          ''::text,
          NULL::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb,text)',
          'eaead90785261fd8400748497005d34013d468b5a836a0dbce0be38eaf843d07',
          'plpgsql'::name,
          'boolean'::pg_catalog.regtype,
          'i'::"char",
          's'::"char",
          false,
          'text, bigint, uuid, uuid, text, integer, integer, integer, jsonb, jsonb, text',
          ARRAY[
            'p_season_id', 'p_generation_seq', 'p_score_cohort_id',
            'p_score_input_manifest_id', 'p_score_input_manifest_digest',
            'p_chunk_index', 'p_first_position', 'p_row_count',
            'p_identities', 'p_field_commitments', 'p_chunk_sha256'
          ]::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.validate_leaderboard_rank_manifest_attestation_complete_v1()',
          'a67d03810591c130b7b6e7dbd63becc9b4d08eb4580fd314a223032e1f187e6b',
          'plpgsql'::name,
          'trigger'::pg_catalog.regtype,
          'v'::"char",
          'u'::"char",
          true,
          ''::text,
          NULL::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.guard_leaderboard_rank_generation_stage_row_insert_v1()',
          'ba9030dfdd0431721903561fdfa02c106fcedc66cbb32ab20acf5ebd33958dc9',
          'plpgsql'::name,
          'trigger'::pg_catalog.regtype,
          'v'::"char",
          'u'::"char",
          true,
          ''::text,
          NULL::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.validate_leaderboard_rank_generation_stage_batch_v1()',
          '14063ba832d2bd0a5de0d5975eaf4ea8a68093e63b27f78107770cd8766184b0',
          'plpgsql'::name,
          'trigger'::pg_catalog.regtype,
          'v'::"char",
          'u'::"char",
          true,
          ''::text,
          NULL::text[],
          ARRAY[
            'search_path=pg_catalog, pg_temp',
            'TimeZone=UTC',
            'lock_timeout=10s'
          ]::text[]
        ),
        (
          'arena.reject_leaderboard_rank_publication_mutation()',
          '3896caded6f9f7062305267ebf4d99f05f8e6299711d00b8a252d5d043b26e2e',
          'plpgsql'::name,
          'trigger'::pg_catalog.regtype,
          'v'::"char",
          'u'::"char",
          true,
          ''::text,
          NULL::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        )
    ) AS expected(
      signature,
      body_sha256,
      language_name,
      return_type,
      volatility,
      parallel_safety,
      security_definer,
      input_arg_types,
      arg_names,
      configuration
    )
    LEFT JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = pg_catalog.to_regprocedure(expected.signature)
    LEFT JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid IS NULL
       OR function_row.proowner <> 'postgres'::pg_catalog.regrole
       OR function_row.prokind <> 'f'
       OR language_row.lanname IS DISTINCT FROM expected.language_name
       OR function_row.provolatile IS DISTINCT FROM expected.volatility
       OR function_row.proparallel IS DISTINCT FROM expected.parallel_safety
       OR function_row.prosecdef IS DISTINCT FROM expected.security_definer
       OR function_row.proleakproof
       OR function_row.proisstrict
       OR function_row.proretset
       OR function_row.prorettype IS DISTINCT FROM expected.return_type
       OR pg_catalog.oidvectortypes(function_row.proargtypes)
            IS DISTINCT FROM expected.input_arg_types
       OR function_row.pronargs IS DISTINCT FROM
            COALESCE(pg_catalog.cardinality(expected.arg_names), 0)
       OR function_row.pronargdefaults <> 0
       OR function_row.provariadic <> 0
       OR function_row.proargnames IS DISTINCT FROM expected.arg_names
       OR function_row.proargmodes IS NOT NULL
       OR function_row.proallargtypes IS NOT NULL
       OR function_row.proargdefaults IS NOT NULL
       OR function_row.protrftypes IS NOT NULL
       OR function_row.prosupport <> 0
       OR function_row.prosqlbody IS NOT NULL
       OR function_row.probin IS NOT NULL
       OR function_row.procost <> 100
       OR function_row.prorows <> 0
       OR function_row.proconfig IS DISTINCT FROM expected.configuration
       OR pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(function_row.prosrc, 'UTF8')
            ),
            'hex'
          ) IS DISTINCT FROM expected.body_sha256
  ) THEN
    RAISE EXCEPTION 'staging-only rank writer helper catalog drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'arena'
      AND function_row.proname IN (
        'validate_leaderboard_rank_generation_manifest_binding',
        'encode_leaderboard_score_input_manifest_v1',
        'verify_leaderboard_score_input_manifest_v1',
        'build_leaderboard_rank_typed_batch_evidence_v1',
        'build_leaderboard_rank_generation_write_set_sha256_v1',
        'build_leaderboard_rank_typed_field_commitment_v1',
        'encode_leaderboard_rank_manifest_fields_v1',
        'build_leaderboard_rank_manifest_field_commitment_v1',
        'build_leaderboard_rank_manifest_chunk_sha256_v1',
        'build_leaderboard_rank_manifest_chunks_sha256_v1',
        'guard_leaderboard_rank_manifest_attestation_chunk_insert_v1',
        'leaderboard_rank_manifest_attestation_chunk_is_valid_v1',
        'validate_leaderboard_rank_manifest_attestation_complete_v1',
        'guard_leaderboard_rank_generation_stage_row_insert_v1',
        'validate_leaderboard_rank_generation_stage_batch_v1',
        'reject_leaderboard_rank_publication_mutation'
      )
      AND function_row.oid NOT IN (
        'arena.validate_leaderboard_rank_generation_manifest_binding()'::regprocedure,
        'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)'::regprocedure,
        'arena.verify_leaderboard_score_input_manifest_v1(uuid)'::regprocedure,
        'arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])'::regprocedure,
        'arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])'::regprocedure,
        'arena.build_leaderboard_rank_typed_field_commitment_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'::regprocedure,
        'arena.encode_leaderboard_rank_manifest_fields_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'::regprocedure,
        'arena.build_leaderboard_rank_manifest_field_commitment_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'::regprocedure,
        'arena.build_leaderboard_rank_manifest_chunk_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb)'::regprocedure,
        'arena.build_leaderboard_rank_manifest_chunks_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,jsonb)'::regprocedure,
        'arena.guard_leaderboard_rank_manifest_attestation_chunk_insert_v1()'::regprocedure,
        'arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb,text)'::regprocedure,
        'arena.validate_leaderboard_rank_manifest_attestation_complete_v1()'::regprocedure,
        'arena.guard_leaderboard_rank_generation_stage_row_insert_v1()'::regprocedure,
        'arena.validate_leaderboard_rank_generation_stage_batch_v1()'::regprocedure,
        'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure
      )
  ) THEN
    RAISE EXCEPTION 'staging-only rank writer helper overload drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS expanded
    WHERE function_row.oid IN (
      'arena.validate_leaderboard_rank_generation_manifest_binding()'::regprocedure,
      'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)'::regprocedure,
      'arena.verify_leaderboard_score_input_manifest_v1(uuid)'::regprocedure,
      'arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])'::regprocedure,
      'arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])'::regprocedure,
      'arena.build_leaderboard_rank_typed_field_commitment_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'::regprocedure,
      'arena.encode_leaderboard_rank_manifest_fields_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'::regprocedure,
      'arena.build_leaderboard_rank_manifest_field_commitment_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'::regprocedure,
      'arena.build_leaderboard_rank_manifest_chunk_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb)'::regprocedure,
      'arena.build_leaderboard_rank_manifest_chunks_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,jsonb)'::regprocedure,
      'arena.guard_leaderboard_rank_manifest_attestation_chunk_insert_v1()'::regprocedure,
      'arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb,text)'::regprocedure,
      'arena.validate_leaderboard_rank_manifest_attestation_complete_v1()'::regprocedure,
      'arena.guard_leaderboard_rank_generation_stage_row_insert_v1()'::regprocedure,
      'arena.validate_leaderboard_rank_generation_stage_batch_v1()'::regprocedure,
      'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure
    )
      AND expanded.grantee <> function_row.proowner
      AND expanded.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'staging-only rank writer helper ACL drifted';
  END IF;

  WITH target(relation_name, relation_oid) AS (
    VALUES
      ('leaderboard_rank_generation_heads',
        'arena.leaderboard_rank_generation_heads'::regclass),
      ('leaderboard_rank_generation_claims',
        'arena.leaderboard_rank_generation_claims'::regclass),
      ('leaderboard_score_input_manifests',
        'arena.leaderboard_score_input_manifests'::regclass),
      ('leaderboard_rank_generation_manifest_bindings',
        'arena.leaderboard_rank_generation_manifest_bindings'::regclass),
      ('leaderboard_rank_generation_batch_receipts',
        'arena.leaderboard_rank_generation_batch_receipts'::regclass),
      ('leaderboard_rank_generation_source_fence_receipts',
        'arena.leaderboard_rank_generation_source_fence_receipts'::regclass),
      ('leaderboard_rank_manifest_attestations',
        'arena.leaderboard_rank_manifest_attestations'::regclass),
      ('leaderboard_rank_manifest_attestation_chunks',
        'arena.leaderboard_rank_manifest_attestation_chunks'::regclass),
      ('leaderboard_rank_generation_stage_batches',
        'arena.leaderboard_rank_generation_stage_batches'::regclass),
      ('leaderboard_rank_generation_stage_rows',
        'arena.leaderboard_rank_generation_stage_rows'::regclass)
  ), preimage AS (
    SELECT
      pg_catalog.jsonb_build_array(
        'leaderboard-rank-staging-writer-authority-constraints@1',
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'relation', target.relation_name,
            'name', constraint_row.conname,
            'type', constraint_row.contype,
            'validated', constraint_row.convalidated,
            'deferrable', constraint_row.condeferrable,
            'deferred', constraint_row.condeferred,
            'noInherit', constraint_row.connoinherit,
            'isLocal', constraint_row.conislocal,
            'inheritCount', constraint_row.coninhcount,
            'parentIsLocal', constraint_row.conparentid = 0,
            'key', pg_catalog.to_jsonb(constraint_row.conkey),
            'foreignRelation', CASE constraint_row.confrelid
              WHEN 0 THEN NULL
              ELSE constraint_row.confrelid::regclass::text
            END,
            'foreignKey', pg_catalog.to_jsonb(constraint_row.confkey),
            'foreignUpdate', constraint_row.confupdtype,
            'foreignDelete', constraint_row.confdeltype,
            'foreignMatch', constraint_row.confmatchtype,
            'backingIndex', CASE constraint_row.conindid
              WHEN 0 THEN NULL
              ELSE constraint_row.conindid::regclass::text
            END,
            'definition', pg_catalog.pg_get_constraintdef(
              constraint_row.oid,
              false
            )
          )
          ORDER BY
            target.relation_name COLLATE pg_catalog."C",
            constraint_row.conname COLLATE pg_catalog."C"
        )
      ) AS value,
      pg_catalog.count(*)::integer AS entry_count
    FROM target
    JOIN pg_catalog.pg_constraint AS constraint_row
      ON constraint_row.conrelid = target.relation_oid
  )
  SELECT
    preimage.entry_count,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(preimage.value::text, 'UTF8')
      ),
      'hex'
    )
  INTO STRICT v_constraint_count, v_constraint_digest
  FROM preimage;

  IF v_constraint_count IS DISTINCT FROM 120
     OR v_constraint_digest IS DISTINCT FROM
          '7e07fd96291161b2eca8541b128112dbde33db78fae03e45ee0995908e0f45de'
  THEN
    RAISE EXCEPTION
      'staging-only rank writer authority constraint digest drifted: %|%',
      v_constraint_count,
      v_constraint_digest;
  END IF;

  WITH target(relation_name, relation_oid) AS (
    VALUES
      ('leaderboard_rank_generation_heads',
        'arena.leaderboard_rank_generation_heads'::regclass),
      ('leaderboard_rank_generation_claims',
        'arena.leaderboard_rank_generation_claims'::regclass),
      ('leaderboard_score_input_manifests',
        'arena.leaderboard_score_input_manifests'::regclass),
      ('leaderboard_rank_generation_manifest_bindings',
        'arena.leaderboard_rank_generation_manifest_bindings'::regclass),
      ('leaderboard_rank_generation_batch_receipts',
        'arena.leaderboard_rank_generation_batch_receipts'::regclass),
      ('leaderboard_rank_generation_source_fence_receipts',
        'arena.leaderboard_rank_generation_source_fence_receipts'::regclass),
      ('leaderboard_rank_manifest_attestations',
        'arena.leaderboard_rank_manifest_attestations'::regclass),
      ('leaderboard_rank_manifest_attestation_chunks',
        'arena.leaderboard_rank_manifest_attestation_chunks'::regclass),
      ('leaderboard_rank_generation_stage_batches',
        'arena.leaderboard_rank_generation_stage_batches'::regclass),
      ('leaderboard_rank_generation_stage_rows',
        'arena.leaderboard_rank_generation_stage_rows'::regclass)
  ), preimage AS (
    SELECT
      pg_catalog.jsonb_build_array(
        'leaderboard-rank-staging-writer-authority-indexes@1',
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'relation', target.relation_name,
            'name', index_class.relname,
            'kind', index_class.relkind,
            'persistence', index_class.relpersistence,
            'accessMethod', access_method.amname,
            'tablespace', index_class.reltablespace,
            'options', pg_catalog.to_jsonb(index_class.reloptions),
            'valid', index_row.indisvalid,
            'ready', index_row.indisready,
            'live', index_row.indislive,
            'unique', index_row.indisunique,
            'nullsNotDistinct', index_row.indnullsnotdistinct,
            'primary', index_row.indisprimary,
            'exclusion', index_row.indisexclusion,
            'immediate', index_row.indimmediate,
            'clustered', index_row.indisclustered,
            'replicaIdentity', index_row.indisreplident,
            'keyAttributes', index_row.indnkeyatts,
            'attributes', index_row.indnatts,
            'key', index_row.indkey::text,
            'definition', pg_catalog.pg_get_indexdef(
              index_row.indexrelid,
              0,
              false
            ),
            'predicate', pg_catalog.pg_get_expr(
              index_row.indpred,
              index_row.indrelid,
              false
            ),
            'expressions', pg_catalog.pg_get_expr(
              index_row.indexprs,
              index_row.indrelid,
              false
            )
          )
          ORDER BY
            target.relation_name COLLATE pg_catalog."C",
            index_class.relname COLLATE pg_catalog."C"
        )
      ) AS value,
      pg_catalog.count(*)::integer AS entry_count
    FROM target
    JOIN pg_catalog.pg_index AS index_row
      ON index_row.indrelid = target.relation_oid
    JOIN pg_catalog.pg_class AS index_class
      ON index_class.oid = index_row.indexrelid
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = index_class.relam
  )
  SELECT
    preimage.entry_count,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(preimage.value::text, 'UTF8')
      ),
      'hex'
    )
  INTO STRICT v_index_count, v_index_digest
  FROM preimage;

  IF v_index_count IS DISTINCT FROM 23
     OR v_index_digest IS DISTINCT FROM
          '0d4aef092635571aa1f4004b9e5dc64536b510628d710bb0e3c27af64769fb83'
  THEN
    RAISE EXCEPTION
      'staging-only rank writer authority index digest drifted: %|%',
      v_index_count,
      v_index_digest;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.leaderboard_rank_generation_heads'::regclass, 6),
        ('arena.leaderboard_rank_generation_claims'::regclass, 11),
        ('arena.leaderboard_score_input_manifests'::regclass, 6),
        ('arena.leaderboard_rank_generation_manifest_bindings'::regclass, 7),
        ('arena.leaderboard_rank_generation_batch_receipts'::regclass, 15),
        ('arena.leaderboard_rank_generation_source_fence_receipts'::regclass, 9),
        ('arena.leaderboard_rank_manifest_attestations'::regclass, 12),
        ('arena.leaderboard_rank_manifest_attestation_chunks'::regclass, 12),
        ('arena.leaderboard_rank_generation_stage_batches'::regclass, 16),
        ('arena.leaderboard_rank_generation_stage_rows'::regclass, 10)
    ) AS expected(table_oid, column_count)
    JOIN pg_catalog.pg_class AS table_row
      ON table_row.oid = expected.table_oid
    WHERE table_row.relkind <> 'r'
       OR table_row.relpersistence <> 'p'
       OR table_row.relowner <> 'postgres'::regrole
       OR NOT table_row.relrowsecurity
       OR table_row.relforcerowsecurity
       OR table_row.relispartition
       OR table_row.reloptions IS NOT NULL
       OR expected.column_count <> (
         SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = expected.table_oid
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
       )
  ) THEN
    RAISE EXCEPTION 'staging-only rank writer relation shape drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = ANY (ARRAY[
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass,
      'arena.leaderboard_rank_manifest_attestations'::regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::regclass,
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    ]::regclass[])
       OR inheritance.inhparent = ANY (ARRAY[
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass,
      'arena.leaderboard_rank_manifest_attestations'::regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::regclass,
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    ]::regclass[])
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rule_row
    WHERE rule_row.ev_class = ANY (ARRAY[
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass,
      'arena.leaderboard_rank_manifest_attestations'::regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::regclass,
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    ]::regclass[])
  ) THEN
    RAISE EXCEPTION
      'staging-only rank writer inheritance or rewrite topology drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass,
      'arena.leaderboard_rank_manifest_attestations'::regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::regclass,
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        table_row.relacl,
        pg_catalog.acldefault('r', table_row.relowner)
      )
    ) AS expanded
    WHERE table_row.oid IN (
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass,
      'arena.leaderboard_rank_manifest_attestations'::regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::regclass,
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    )
      AND expanded.grantee <> table_row.relowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS expanded
    WHERE attribute.attrelid IN (
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass,
      'arena.leaderboard_rank_manifest_attestations'::regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::regclass,
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND expanded.grantee <> 'postgres'::regrole
  ) THEN
    RAISE EXCEPTION 'staging-only rank writer relation ACL drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    )
  ) <> 33 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid IN (
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    )
  ) <> 5 THEN
    RAISE EXCEPTION 'staging-only rank writer stage catalog drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass,
      'arena.leaderboard_rank_manifest_attestations'::regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::regclass,
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    )
      AND NOT trigger_row.tgisinternal
  ) <> 20 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'arena.leaderboard_rank_generation_claims'::regclass,
          'leaderboard_rank_generation_claim_immutable'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          27, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
          'leaderboard_rank_generation_manifest_bindings_validate'::name,
          'arena.validate_leaderboard_rank_generation_manifest_binding()'::regprocedure,
          7, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
          'leaderboard_rank_generation_manifest_bindings_immutable'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          27, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
          'leaderboard_rank_generation_manifest_bindings_no_truncate'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          34, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_batch_receipts'::regclass,
          'leaderboard_rank_generation_batch_receipts_immutable'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          27, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_batch_receipts'::regclass,
          'leaderboard_rank_generation_batch_receipts_no_truncate'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          34, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_source_fence_receipts'::regclass,
          'leaderboard_rank_generation_source_fence_receipts_immutable'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          27, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_source_fence_receipts'::regclass,
          'leaderboard_rank_generation_source_fence_receipts_no_truncate'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          34, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_manifest_attestations'::regclass,
          'leaderboard_rank_manifest_attestations_immutable'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          27, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_manifest_attestations'::regclass,
          'leaderboard_rank_manifest_attestations_no_truncate'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          34, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_manifest_attestations'::regclass,
          'leaderboard_rank_manifest_attestations_complete'::name,
          'arena.validate_leaderboard_rank_manifest_attestation_complete_v1()'::regprocedure,
          5, true, true, true, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_manifest_attestation_chunks'::regclass,
          'leaderboard_rank_manifest_attestation_chunks_insert_guard'::name,
          'arena.guard_leaderboard_rank_manifest_attestation_chunk_insert_v1()'::regprocedure,
          7, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_manifest_attestation_chunks'::regclass,
          'leaderboard_rank_manifest_attestation_chunks_immutable'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          27, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_manifest_attestation_chunks'::regclass,
          'leaderboard_rank_manifest_attestation_chunks_no_truncate'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          34, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_stage_batches'::regclass,
          'leaderboard_rank_generation_stage_batches_complete'::name,
          'arena.validate_leaderboard_rank_generation_stage_batch_v1()'::regprocedure,
          5, true, true, true, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_stage_batches'::regclass,
          'leaderboard_rank_generation_stage_batches_immutable'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          27, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_stage_batches'::regclass,
          'leaderboard_rank_generation_stage_batches_no_truncate'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          34, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_stage_rows'::regclass,
          'leaderboard_rank_generation_stage_rows_insert_guard'::name,
          'arena.guard_leaderboard_rank_generation_stage_row_insert_v1()'::regprocedure,
          4, false, false, false, NULL::text, 'new_stage_rows'::text
        ),
        (
          'arena.leaderboard_rank_generation_stage_rows'::regclass,
          'leaderboard_rank_generation_stage_rows_immutable'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          27, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_stage_rows'::regclass,
          'leaderboard_rank_generation_stage_rows_no_truncate'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          34, false, false, false, NULL::text, NULL::text
        )
    ) AS expected(
      relation_oid,
      trigger_name,
      function_oid,
      trigger_type,
      is_constraint,
      is_deferrable,
      is_initially_deferred,
      old_transition_table,
      new_transition_table
    )
    LEFT JOIN pg_catalog.pg_trigger AS trigger_row
      ON trigger_row.tgrelid = expected.relation_oid
     AND trigger_row.tgname = expected.trigger_name
    WHERE trigger_row.oid IS NULL
       OR trigger_row.tgfoid <> expected.function_oid
       OR trigger_row.tgtype <> expected.trigger_type
       OR (trigger_row.tgconstraint <> 0) IS DISTINCT FROM
            expected.is_constraint
       OR trigger_row.tgdeferrable IS DISTINCT FROM expected.is_deferrable
       OR trigger_row.tginitdeferred IS DISTINCT FROM
            expected.is_initially_deferred
       OR trigger_row.tgoldtable::text IS DISTINCT FROM
            expected.old_transition_table
       OR trigger_row.tgnewtable::text IS DISTINCT FROM
            expected.new_transition_table
       OR trigger_row.tgenabled <> 'O'
       OR trigger_row.tgisinternal
       OR trigger_row.tgparentid <> 0
       OR trigger_row.tgnargs <> 0
       OR trigger_row.tgargs <> '\x'::bytea
       OR trigger_row.tgattr <> ''::pg_catalog.int2vector
       OR trigger_row.tgqual IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'staging-only rank writer trigger topology drifted';
  END IF;

  -- A phase left by the old writer may already have exposed a prefix. It cannot
  -- be reinterpreted as a private staged generation. Deployment must first
  -- abort or seal it, then rerun this transaction.
  IF EXISTS (
    SELECT 1
    FROM ONLY arena.leaderboard_rank_generation_heads AS head
    WHERE head.phase IN ('claimed', 'writing', 'cleaned', 'reranked')
  ) THEN
    RAISE EXCEPTION
      'staging-only rank writer requires no active claimed generation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ONLY arena.leaderboard_rank_generation_stage_batches
  ) OR EXISTS (
    SELECT 1
    FROM ONLY arena.leaderboard_rank_generation_stage_rows
  ) THEN
    RAISE EXCEPTION
      'staging-only rank writer refuses pre-activation staged evidence';
  END IF;
END
$dependency_preflight$;

CREATE OR REPLACE FUNCTION arena.write_leaderboard_rank_generation_batch_v1(
  p_season_id text,
  p_generation_seq bigint,
  p_score_cohort_id uuid,
  p_batch_index integer,
  p_score_input_manifest_id uuid,
  p_score_input_manifest_digest text,
  p_batch_sha256_plan text[],
  p_rows arena.leaderboard_rank_batch_row_v1[]
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
AS $writer_body$
DECLARE
  v_claim arena.leaderboard_rank_generation_claims%ROWTYPE;
  v_locked_claim arena.leaderboard_rank_generation_claims%ROWTYPE;
  v_head arena.leaderboard_rank_generation_heads%ROWTYPE;
  v_existing_receipt
    arena.leaderboard_rank_generation_batch_receipts%ROWTYPE;
  v_manifest arena.leaderboard_score_input_manifests%ROWTYPE;
  v_attestation arena.leaderboard_rank_manifest_attestations%ROWTYPE;
  v_attestation_chunk
    arena.leaderboard_rank_manifest_attestation_chunks%ROWTYPE;
  v_stage_batch arena.leaderboard_rank_generation_stage_batches%ROWTYPE;
  v_verification jsonb;
  v_attestation_chunks jsonb;
  v_attestation_chunk_plan jsonb;
  v_expected_identities jsonb;
  v_expected_commitments jsonb;
  v_supplied_identities jsonb;
  v_supplied_commitments jsonb;
  v_actual_source_proofs jsonb;
  v_typed_evidence jsonb;
  v_staged_evidence jsonb;
  v_expected_write_set text;
  v_chunks_sha256 text;
  v_staged_rows arena.leaderboard_rank_batch_row_v1[];
  v_plan_count integer;
  v_chunk_count integer;
  v_positive_count integer;
  v_current_row_count integer;
  v_current_source_count integer;
  v_actual_source_count integer;
  v_actual_source_row_count integer;
  v_prior_batch_count integer;
  v_prior_stage_batch_count integer;
  v_prior_row_count integer;
  v_prior_stage_row_count integer;
  v_remaining_batch_count integer;
  v_binding_count integer;
  v_staged_row_count integer;
  v_min_stage_position integer;
  v_max_stage_position integer;
  v_updated_count integer;
  v_now timestamptz;
  v_completed_at timestamptz;
  v_manifest_valid_until timestamptz;
  v_expected_phase text;
  v_source_windows_valid boolean;
  v_has_stage boolean;
  v_head_locked boolean := false;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <>
       'read committed' THEN
    RAISE EXCEPTION 'staged rank batch writes require READ COMMITTED isolation'
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
     OR p_batch_sha256_plan IS NULL
     OR p_rows IS NULL THEN
    RAISE EXCEPTION 'staged rank batch header is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.array_ndims(p_batch_sha256_plan) IS DISTINCT FROM 1
     OR pg_catalog.array_lower(p_batch_sha256_plan, 1) IS DISTINCT FROM 1
     OR pg_catalog.cardinality(p_batch_sha256_plan) < 1
     OR pg_catalog.cardinality(p_batch_sha256_plan) > 64
     OR pg_catalog.pg_column_size(p_batch_sha256_plan) > 1048576
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(p_batch_sha256_plan) AS digest(value)
       WHERE digest.value IS NULL
          OR digest.value !~ '^[0-9a-f]{64}$'
     ) THEN
    RAISE EXCEPTION 'staged rank batch digest plan is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.array_ndims(p_rows) IS DISTINCT FROM 1
     OR pg_catalog.array_lower(p_rows, 1) IS DISTINCT FROM 1
     OR pg_catalog.cardinality(p_rows) < 1
     OR pg_catalog.cardinality(p_rows) > 1000
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.generate_subscripts(p_rows, 1) AS position(i)
       WHERE p_rows[position.i] IS NULL
     ) THEN
    RAISE EXCEPTION 'staged rank row array is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT claim.*
  INTO v_claim
  FROM ONLY arena.leaderboard_rank_generation_claims AS claim
  WHERE claim.season_id = p_season_id
    AND claim.generation_seq = p_generation_seq
    AND claim.score_cohort_id = p_score_cohort_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'staged rank batch has no exact generation claim'
      USING ERRCODE = '23503';
  END IF;

  v_typed_evidence :=
    arena.build_leaderboard_rank_typed_batch_evidence_v1(
      p_season_id,
      p_score_cohort_id,
      v_claim.computed_at,
      p_rows
    );
  v_current_row_count := (v_typed_evidence->>'row_count')::integer;
  v_current_source_count := (v_typed_evidence->>'source_count')::integer;
  v_plan_count := pg_catalog.cardinality(p_batch_sha256_plan);
  v_expected_write_set :=
    arena.build_leaderboard_rank_generation_write_set_sha256_v1(
      p_season_id,
      p_score_cohort_id,
      p_score_input_manifest_digest,
      v_claim.computed_at,
      v_claim.expected_rank_count,
      p_batch_sha256_plan
    );

  IF v_claim.expected_rank_count < 1
     OR v_claim.expected_rank_count > 64000
     OR v_claim.expected_batch_count IS DISTINCT FROM
          (v_claim.expected_rank_count + 999) / 1000
     OR v_plan_count IS DISTINCT FROM v_claim.expected_batch_count
     OR p_batch_index >= v_plan_count
     OR v_current_row_count IS DISTINCT FROM
          LEAST(
            1000,
            v_claim.expected_rank_count - p_batch_index * 1000
          )
     OR p_batch_sha256_plan[p_batch_index + 1] IS DISTINCT FROM
          v_typed_evidence->>'batch_sha256'
     OR v_expected_write_set IS DISTINCT FROM v_claim.write_set_sha256 THEN
    RAISE EXCEPTION 'staged rank batch does not match immutable generation plan'
      USING ERRCODE = '22023';
  END IF;

  WITH supplied AS MATERIALIZED (
    SELECT
      p_rows[position.ordinality] AS rank_row,
      position.ordinality
    FROM pg_catalog.generate_subscripts(p_rows, 1)
      AS position(ordinality)
  )
  SELECT
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_array(
        (supplied.rank_row).source,
        (supplied.rank_row).source_trader_id
      )
      ORDER BY supplied.ordinality
    ),
    pg_catalog.jsonb_agg(
      pg_catalog.to_jsonb(
        arena.build_leaderboard_rank_typed_field_commitment_v1(
          (supplied.rank_row).source,
          (supplied.rank_row).source_trader_id,
          (supplied.rank_row).roi,
          (supplied.rank_row).pnl,
          (supplied.rank_row).win_rate,
          (supplied.rank_row).max_drawdown,
          (supplied.rank_row).sharpe_ratio,
          (supplied.rank_row).profit_factor,
          (supplied.rank_row).trades_count,
          (supplied.rank_row).arena_score,
          (supplied.rank_row).score_factors,
          (supplied.rank_row).profitability_score,
          (supplied.rank_row).risk_control_score,
          (supplied.rank_row).execution_score
        )
      )
      ORDER BY supplied.ordinality
    )
  INTO STRICT v_supplied_identities, v_supplied_commitments
  FROM supplied;

  -- A committed receipt is the response-loss replay key. It is accepted only
  -- when its immutable binding, chunk, private header, and full typed payload
  -- still describe this exact request. The head and lease are intentionally
  -- absent so later sealing or supersession cannot change the response.
  LOOP
    SELECT receipt.*
    INTO v_existing_receipt
    FROM ONLY arena.leaderboard_rank_generation_batch_receipts AS receipt
    WHERE receipt.season_id = p_season_id
      AND receipt.generation_seq = p_generation_seq
      AND receipt.batch_index = p_batch_index;

    IF FOUND THEN
      SELECT batch.*
      INTO v_stage_batch
      FROM ONLY arena.leaderboard_rank_generation_stage_batches AS batch
      WHERE batch.season_id = p_season_id
        AND batch.generation_seq = p_generation_seq
        AND batch.batch_index = p_batch_index;
      v_has_stage := FOUND;

      IF v_has_stage THEN
        SELECT
          pg_catalog.count(*)::integer,
          pg_catalog.min(staged.batch_position)::integer,
          pg_catalog.max(staged.batch_position)::integer,
          pg_catalog.array_agg(
            staged.row_payload ORDER BY staged.batch_position
          )
        INTO STRICT
          v_staged_row_count,
          v_min_stage_position,
          v_max_stage_position,
          v_staged_rows
        FROM ONLY arena.leaderboard_rank_generation_stage_rows AS staged
        WHERE staged.season_id = p_season_id
          AND staged.generation_seq = p_generation_seq
          AND staged.batch_index = p_batch_index
          AND staged.score_cohort_id = p_score_cohort_id;

        v_staged_evidence :=
          arena.build_leaderboard_rank_typed_batch_evidence_v1(
            p_season_id,
            p_score_cohort_id,
            v_claim.computed_at,
            v_staged_rows
          );
      ELSE
        -- Historical receipts predate private staging. Preserve their exact
        -- frozen replay acceptance set without allowing this evidence to
        -- authorize any new append. This is the only legacy source-window read
        -- in the function; the staged replay and write paths never reach it.
        SELECT
          COALESCE(
            pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'source', source_receipt.source,
                'source_row_count', source_receipt.source_row_count,
                'source_identity_sha256',
                  source_receipt.source_identity_sha256
              )
              ORDER BY source_receipt.source COLLATE pg_catalog."C"
            ),
            '[]'::jsonb
          ),
          pg_catalog.count(*)::integer,
          COALESCE(
            pg_catalog.sum(source_receipt.source_row_count),
            0
          )::integer,
          COALESCE(
            pg_catalog.bool_and(
              source_receipt.mutation_seq_after -
                source_receipt.mutation_seq_before IN (1, 2)
            ),
            false
          )
        INTO STRICT
          v_actual_source_proofs,
          v_actual_source_count,
          v_actual_source_row_count,
          v_source_windows_valid
        FROM ONLY
          arena.leaderboard_rank_generation_source_fence_receipts
            AS source_receipt
        WHERE source_receipt.season_id = p_season_id
          AND source_receipt.generation_seq = p_generation_seq
          AND source_receipt.batch_index = p_batch_index;
      END IF;

      SELECT pg_catalog.count(*)::integer
      INTO STRICT v_binding_count
      FROM ONLY arena.leaderboard_rank_generation_manifest_bindings
        AS binding
      WHERE binding.contract =
            'leaderboard-rank-generation-manifest-binding@1'
        AND binding.season_id = p_season_id
        AND binding.generation_seq = p_generation_seq
        AND binding.score_cohort_id = p_score_cohort_id
        AND binding.score_input_manifest_id = p_score_input_manifest_id
        AND binding.score_input_manifest_digest =
            p_score_input_manifest_digest;

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
        RAISE EXCEPTION
          'generation batch receipt has no manifest attestation replay'
          USING ERRCODE = '55000';
      END IF;

      SELECT chunk.*
      INTO v_attestation_chunk
      FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
      WHERE chunk.season_id = p_season_id
        AND chunk.generation_seq = p_generation_seq
        AND chunk.score_cohort_id = p_score_cohort_id
        AND chunk.score_input_manifest_id = p_score_input_manifest_id
        AND chunk.score_input_manifest_digest =
            p_score_input_manifest_digest
        AND chunk.chunk_index = p_batch_index;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'generation batch receipt has no manifest chunk replay'
          USING ERRCODE = '55000';
      END IF;

      IF v_binding_count <> 1
         OR v_existing_receipt.contract IS DISTINCT FROM
              'leaderboard-rank-generation-batch-receipt@1'
         OR v_existing_receipt.score_cohort_id IS DISTINCT FROM
              p_score_cohort_id
         OR v_existing_receipt.batch_sha256 IS DISTINCT FROM
              v_typed_evidence->>'batch_sha256'
         OR v_existing_receipt.score_input_manifest_id IS DISTINCT FROM
              p_score_input_manifest_id
         OR v_existing_receipt.score_input_manifest_digest IS DISTINCT FROM
              p_score_input_manifest_digest
         OR v_existing_receipt.row_count IS DISTINCT FROM v_current_row_count
         OR v_existing_receipt.source_count IS DISTINCT FROM
              v_current_source_count
         OR v_existing_receipt.first_source IS DISTINCT FROM
              v_typed_evidence->>'first_source'
         OR v_existing_receipt.first_source_trader_id IS DISTINCT FROM
              v_typed_evidence->>'first_source_trader_id'
         OR v_existing_receipt.last_source IS DISTINCT FROM
              v_typed_evidence->>'last_source'
         OR v_existing_receipt.last_source_trader_id IS DISTINCT FROM
              v_typed_evidence->>'last_source_trader_id'
         OR v_attestation.contract IS DISTINCT FROM
              'leaderboard-rank-manifest-attestation@1'
         OR v_attestation.batch_index <> 0
         OR v_attestation.positive_count IS DISTINCT FROM
              v_claim.expected_rank_count
         OR v_attestation.chunk_count IS DISTINCT FROM
              v_claim.expected_batch_count
         OR v_attestation_chunk.first_position IS DISTINCT FROM
              p_batch_index * 1000 + 1
         OR v_attestation_chunk.row_count IS DISTINCT FROM
              v_current_row_count
         OR v_attestation_chunk.identities IS DISTINCT FROM
              v_supplied_identities
         OR v_attestation_chunk.field_commitments IS DISTINCT FROM
              v_supplied_commitments
         OR NOT arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1(
              v_attestation_chunk.season_id,
              v_attestation_chunk.generation_seq,
              v_attestation_chunk.score_cohort_id,
              v_attestation_chunk.score_input_manifest_id,
              v_attestation_chunk.score_input_manifest_digest,
              v_attestation_chunk.chunk_index,
              v_attestation_chunk.first_position,
              v_attestation_chunk.row_count,
              v_attestation_chunk.identities,
              v_attestation_chunk.field_commitments,
              v_attestation_chunk.chunk_sha256
            )
         OR EXISTS (
           SELECT 1
           FROM pg_catalog.generate_series(0, p_batch_index) AS planned(i)
           LEFT JOIN ONLY
             arena.leaderboard_rank_generation_batch_receipts AS prior
             ON prior.season_id = p_season_id
            AND prior.generation_seq = p_generation_seq
            AND prior.batch_index = planned.i
           WHERE prior.batch_index IS NULL
              OR prior.score_cohort_id IS DISTINCT FROM p_score_cohort_id
              OR prior.batch_sha256 IS DISTINCT FROM
                   p_batch_sha256_plan[planned.i + 1]
              OR prior.score_input_manifest_id IS DISTINCT FROM
                   p_score_input_manifest_id
              OR prior.score_input_manifest_digest IS DISTINCT FROM
                   p_score_input_manifest_digest
         )
         OR EXISTS (
           SELECT 1
           FROM ONLY arena.leaderboard_rank_generation_batch_receipts AS later
           JOIN ONLY arena.leaderboard_rank_generation_batch_receipts AS earlier
             ON earlier.season_id = later.season_id
            AND earlier.generation_seq = later.generation_seq
            AND earlier.batch_index = later.batch_index - 1
           WHERE later.season_id = p_season_id
             AND later.generation_seq = p_generation_seq
             AND later.batch_index BETWEEN 1 AND p_batch_index
             AND ROW(
                   earlier.last_source COLLATE pg_catalog."C",
                   earlier.last_source_trader_id COLLATE pg_catalog."C"
                 ) >= ROW(
                   later.first_source COLLATE pg_catalog."C",
                   later.first_source_trader_id COLLATE pg_catalog."C"
                 )
         )
         OR (
           v_has_stage AND (
             v_stage_batch.contract IS DISTINCT FROM
               'leaderboard-rank-generation-stage-batch@1'
             OR v_stage_batch.score_cohort_id IS DISTINCT FROM
                  p_score_cohort_id
             OR v_stage_batch.score_input_manifest_id IS DISTINCT FROM
                  p_score_input_manifest_id
             OR v_stage_batch.score_input_manifest_digest IS DISTINCT FROM
                  p_score_input_manifest_digest
             OR v_stage_batch.batch_sha256_plan IS DISTINCT FROM
                  p_batch_sha256_plan
             OR v_stage_batch.batch_sha256 IS DISTINCT FROM
                  v_typed_evidence->>'batch_sha256'
             OR v_stage_batch.row_count IS DISTINCT FROM v_current_row_count
             OR v_stage_batch.source_count IS DISTINCT FROM
                  v_current_source_count
             OR v_stage_batch.first_source IS DISTINCT FROM
                  v_typed_evidence->>'first_source'
             OR v_stage_batch.first_source_trader_id IS DISTINCT FROM
                  v_typed_evidence->>'first_source_trader_id'
             OR v_stage_batch.last_source IS DISTINCT FROM
                  v_typed_evidence->>'last_source'
             OR v_stage_batch.last_source_trader_id IS DISTINCT FROM
                  v_typed_evidence->>'last_source_trader_id'
             OR v_stage_batch.staged_at IS DISTINCT FROM
                  v_existing_receipt.completed_at
             OR v_staged_row_count IS DISTINCT FROM v_current_row_count
             OR v_min_stage_position IS DISTINCT FROM 1
             OR v_max_stage_position IS DISTINCT FROM v_current_row_count
             OR v_staged_rows IS DISTINCT FROM p_rows
             OR v_staged_evidence IS DISTINCT FROM v_typed_evidence
             OR EXISTS (
               SELECT 1
               FROM pg_catalog.generate_series(0, p_batch_index)
                 AS planned(i)
               LEFT JOIN ONLY
                 arena.leaderboard_rank_generation_batch_receipts AS prior
                 ON prior.season_id = p_season_id
                AND prior.generation_seq = p_generation_seq
                AND prior.batch_index = planned.i
               LEFT JOIN ONLY
                 arena.leaderboard_rank_generation_stage_batches AS staged
                 ON staged.season_id = p_season_id
                AND staged.generation_seq = p_generation_seq
                AND staged.batch_index = planned.i
               WHERE staged.batch_index IS NULL
                  OR staged.score_cohort_id IS DISTINCT FROM p_score_cohort_id
                  OR staged.batch_sha256 IS DISTINCT FROM prior.batch_sha256
                  OR staged.batch_sha256_plan IS DISTINCT FROM
                       p_batch_sha256_plan
                  OR staged.score_input_manifest_id IS DISTINCT FROM
                       p_score_input_manifest_id
                  OR staged.score_input_manifest_digest IS DISTINCT FROM
                       p_score_input_manifest_digest
                  OR staged.row_count IS DISTINCT FROM prior.row_count
                  OR staged.source_count IS DISTINCT FROM prior.source_count
                  OR staged.first_source IS DISTINCT FROM prior.first_source
                  OR staged.first_source_trader_id IS DISTINCT FROM
                       prior.first_source_trader_id
                  OR staged.last_source IS DISTINCT FROM prior.last_source
                  OR staged.last_source_trader_id IS DISTINCT FROM
                       prior.last_source_trader_id
                  OR staged.staged_at IS DISTINCT FROM prior.completed_at
             )
             OR EXISTS (
               SELECT 1
               FROM ONLY
                 arena.leaderboard_rank_generation_stage_batches AS later
               JOIN ONLY
                 arena.leaderboard_rank_generation_stage_batches AS earlier
                 ON earlier.season_id = later.season_id
                AND earlier.generation_seq = later.generation_seq
                AND earlier.batch_index = later.batch_index - 1
               WHERE later.season_id = p_season_id
                 AND later.generation_seq = p_generation_seq
                 AND later.batch_index BETWEEN 1 AND p_batch_index
                 AND ROW(
                       earlier.last_source COLLATE pg_catalog."C",
                       earlier.last_source_trader_id COLLATE pg_catalog."C"
                     ) >= ROW(
                       later.first_source COLLATE pg_catalog."C",
                       later.first_source_trader_id COLLATE pg_catalog."C"
                     )
             )
           )
         )
         OR (
           NOT v_has_stage AND (
             v_actual_source_proofs IS DISTINCT FROM
               v_typed_evidence->'source_proofs'
             OR v_actual_source_count IS DISTINCT FROM
                  v_current_source_count
             OR v_actual_source_row_count IS DISTINCT FROM
                  v_current_row_count
             OR NOT v_source_windows_valid
             OR EXISTS (
               SELECT 1
               FROM ONLY arena.leaderboard_rank_generation_stage_batches
                 AS staged
               WHERE staged.season_id = p_season_id
                 AND staged.generation_seq = p_generation_seq
             )
             OR EXISTS (
               SELECT 1
               FROM ONLY arena.leaderboard_rank_generation_stage_rows
                 AS staged
               WHERE staged.season_id = p_season_id
                 AND staged.generation_seq = p_generation_seq
             )
           )
         ) THEN
        RAISE EXCEPTION
          'generation batch receipt conflicts with immutable replay'
          USING ERRCODE = '55000';
      END IF;

      RETURN pg_catalog.jsonb_build_object(
        'contract', 'leaderboard-rank-generation-batch-write@1',
        'season_id', v_existing_receipt.season_id,
        'generation_seq', v_existing_receipt.generation_seq,
        'score_cohort_id', v_existing_receipt.score_cohort_id,
        'phase', 'writing',
        'batch_index', v_existing_receipt.batch_index,
        'batch_sha256', v_existing_receipt.batch_sha256,
        'row_count', v_existing_receipt.row_count,
        'source_count', v_existing_receipt.source_count,
        'completed_at', pg_catalog.to_char(
          v_existing_receipt.completed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
      );
    END IF;

    EXIT WHEN v_head_locked;

    SELECT head.*
    INTO STRICT v_head
    FROM ONLY arena.leaderboard_rank_generation_heads AS head
    WHERE head.season_id = p_season_id
    FOR UPDATE;
    v_head_locked := true;
  END LOOP;

  -- Exact legacy receipt replay above can carry the historical terminal fields
  -- that its digest froze. Every new private version must leave them unset.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.generate_subscripts(p_rows, 1) AS position(i)
    WHERE (p_rows[position.i]).rank IS NOT NULL
       OR (p_rows[position.i]).rank_change IS NOT NULL
       OR (p_rows[position.i]).is_new IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'staged rank rows cannot carry terminal rank authority'
      USING ERRCODE = '22023';
  END IF;

  SELECT claim.*
  INTO STRICT v_locked_claim
  FROM ONLY arena.leaderboard_rank_generation_claims AS claim
  WHERE claim.season_id = p_season_id
    AND claim.generation_seq = p_generation_seq
    AND claim.score_cohort_id = p_score_cohort_id
  FOR SHARE;
  IF pg_catalog.to_jsonb(v_locked_claim) IS DISTINCT FROM
       pg_catalog.to_jsonb(v_claim) THEN
    RAISE EXCEPTION 'immutable generation claim changed while writer waited'
      USING ERRCODE = '55000';
  END IF;

  v_expected_phase := CASE
    WHEN p_batch_index = 0 THEN 'claimed'
    ELSE 'writing'
  END;
  v_now := pg_catalog.clock_timestamp();
  IF v_head.generation_seq IS DISTINCT FROM p_generation_seq
     OR v_head.score_cohort_id IS DISTINCT FROM p_score_cohort_id
     OR v_head.phase IS DISTINCT FROM v_expected_phase
     OR v_head.phase NOT IN ('claimed', 'writing')
     OR v_head.lease_expires_at IS DISTINCT FROM v_claim.lease_expires_at
     OR v_head.lease_expires_at <= v_now
     OR v_claim.computed_at > v_now + interval '5 minutes' THEN
    RAISE EXCEPTION
      'generation lease expired while staged batch write was waiting'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    COALESCE(pg_catalog.sum(receipt.row_count), 0)::integer
  INTO STRICT v_prior_batch_count, v_prior_row_count
  FROM ONLY arena.leaderboard_rank_generation_batch_receipts AS receipt
  WHERE receipt.season_id = p_season_id
    AND receipt.generation_seq = p_generation_seq;

  SELECT
    pg_catalog.count(*)::integer,
    COALESCE(pg_catalog.sum(batch.row_count), 0)::integer
  INTO STRICT v_prior_stage_batch_count, v_prior_stage_row_count
  FROM ONLY arena.leaderboard_rank_generation_stage_batches AS batch
  WHERE batch.season_id = p_season_id
    AND batch.generation_seq = p_generation_seq;

  IF v_prior_batch_count IS DISTINCT FROM p_batch_index
     OR v_prior_stage_batch_count IS DISTINCT FROM p_batch_index
     OR v_prior_row_count IS DISTINCT FROM p_batch_index * 1000
     OR v_prior_stage_row_count IS DISTINCT FROM v_prior_row_count
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.generate_series(0, p_batch_index - 1) AS planned(i)
       LEFT JOIN ONLY arena.leaderboard_rank_generation_batch_receipts
         AS prior
         ON prior.season_id = p_season_id
        AND prior.generation_seq = p_generation_seq
        AND prior.batch_index = planned.i
       LEFT JOIN ONLY arena.leaderboard_rank_generation_stage_batches
         AS staged
         ON staged.season_id = p_season_id
        AND staged.generation_seq = p_generation_seq
        AND staged.batch_index = planned.i
       WHERE prior.batch_index IS NULL
          OR staged.batch_index IS NULL
          OR prior.score_cohort_id IS DISTINCT FROM p_score_cohort_id
          OR staged.score_cohort_id IS DISTINCT FROM p_score_cohort_id
          OR prior.batch_sha256 IS DISTINCT FROM
               p_batch_sha256_plan[planned.i + 1]
          OR staged.batch_sha256 IS DISTINCT FROM prior.batch_sha256
          OR staged.batch_sha256_plan IS DISTINCT FROM p_batch_sha256_plan
          OR prior.score_input_manifest_id IS DISTINCT FROM
               p_score_input_manifest_id
          OR staged.score_input_manifest_id IS DISTINCT FROM
               p_score_input_manifest_id
          OR prior.score_input_manifest_digest IS DISTINCT FROM
               p_score_input_manifest_digest
          OR staged.score_input_manifest_digest IS DISTINCT FROM
               p_score_input_manifest_digest
          OR staged.row_count IS DISTINCT FROM prior.row_count
          OR staged.source_count IS DISTINCT FROM prior.source_count
          OR staged.first_source IS DISTINCT FROM prior.first_source
          OR staged.first_source_trader_id IS DISTINCT FROM
               prior.first_source_trader_id
          OR staged.last_source IS DISTINCT FROM prior.last_source
          OR staged.last_source_trader_id IS DISTINCT FROM
               prior.last_source_trader_id
          OR staged.staged_at IS DISTINCT FROM prior.completed_at
     )
     OR (
       SELECT pg_catalog.count(*)::integer
       FROM ONLY arena.leaderboard_rank_generation_stage_rows AS staged
       WHERE staged.season_id = p_season_id
         AND staged.generation_seq = p_generation_seq
         AND staged.batch_index < p_batch_index
     ) IS DISTINCT FROM v_prior_row_count THEN
    RAISE EXCEPTION 'writer accepted a non-sequential staged batch prefix'
      USING ERRCODE = '22023';
  END IF;

  IF p_batch_index > 0 AND EXISTS (
    SELECT 1
    FROM ONLY arena.leaderboard_rank_generation_stage_batches AS prior
    WHERE prior.season_id = p_season_id
      AND prior.generation_seq = p_generation_seq
      AND prior.batch_index = p_batch_index - 1
      AND ROW(
            prior.last_source COLLATE pg_catalog."C",
            prior.last_source_trader_id COLLATE pg_catalog."C"
          ) >= ROW(
            (v_typed_evidence->>'first_source') COLLATE pg_catalog."C",
            (v_typed_evidence->>'first_source_trader_id')
              COLLATE pg_catalog."C"
          )
  ) THEN
    RAISE EXCEPTION 'previous staged identity range overlaps this batch'
      USING ERRCODE = '22023';
  END IF;

  v_remaining_batch_count :=
    v_claim.expected_batch_count - p_batch_index - 1;
  IF v_prior_row_count + v_current_row_count >
       v_claim.expected_rank_count
     OR v_prior_row_count + v_current_row_count +
          v_remaining_batch_count > v_claim.expected_rank_count
     OR v_prior_row_count + v_current_row_count +
          v_remaining_batch_count * 1000 < v_claim.expected_rank_count
     OR (
       v_remaining_batch_count = 0
       AND v_prior_row_count + v_current_row_count IS DISTINCT FROM
           v_claim.expected_rank_count
     ) THEN
    RAISE EXCEPTION 'staged batch row capacity disagrees with generation claim'
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
      RAISE EXCEPTION 'staged batch manifest identity is unavailable'
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
       OR v_verification->>'manifestId' IS DISTINCT FROM
            p_score_input_manifest_id::text
       OR v_verification->>'manifestDigest' IS DISTINCT FROM
            p_score_input_manifest_digest THEN
      RAISE EXCEPTION
        'staged batch requires one live fully verified manifest'
        USING ERRCODE = '55000';
    END IF;

    v_now := pg_catalog.clock_timestamp();
    IF v_manifest.manifest_digest IS DISTINCT FROM
            pg_catalog.encode(
              pg_catalog.sha256(
                pg_catalog.convert_to(
                  (v_manifest.manifest - 'manifestDigest')::text,
                  'UTF8'
                )
              ),
              'hex'
            )
       OR v_manifest.manifest->>'manifestDigest' IS DISTINCT FROM
            v_manifest.manifest_digest
       OR v_manifest.manifest->>'period' IS DISTINCT FROM p_season_id
       OR v_manifest.valid_until <= v_now
       OR v_manifest.valid_until < v_claim.lease_expires_at THEN
      RAISE EXCEPTION
        'staged batch requires one live fully verified manifest'
        USING ERRCODE = '55000';
    END IF;
    v_manifest_valid_until := v_manifest.valid_until;

    -- Only identities and score-derived fields are frozen here. Terminal rank,
    -- movement, and novelty are deliberately absent from this attestation.
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
    ), positive_source AS MATERIALIZED (
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
    ), positive AS MATERIALIZED (
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
    ), chunked AS MATERIALIZED (
      SELECT
        ((positive.positive_position - 1) / 1000)::integer AS chunk_index,
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
    ), hashed AS MATERIALIZED (
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
       OR pg_catalog.jsonb_array_length(v_attestation_chunks) IS DISTINCT
            FROM v_chunk_count THEN
      RAISE EXCEPTION
        'manifest positive output count disagrees with staged generation'
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
    v_expected_identities := (v_attestation_chunks->0)->'identities';
    v_expected_commitments :=
      (v_attestation_chunks->0)->'field_commitments';

    SELECT pg_catalog.count(*)::integer
    INTO STRICT v_binding_count
    FROM ONLY arena.leaderboard_rank_generation_manifest_bindings
      AS binding
    WHERE binding.season_id = p_season_id
      AND binding.generation_seq = p_generation_seq;
    IF v_binding_count <> 0 THEN
      RAISE EXCEPTION 'batch zero found a pre-existing manifest binding'
        USING ERRCODE = '55000';
    END IF;
  ELSE
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
      RAISE EXCEPTION 'later staged batch has no exact manifest attestation'
        USING ERRCODE = '23503';
    END IF;

    IF v_attestation.contract IS DISTINCT FROM
         'leaderboard-rank-manifest-attestation@1'
       OR v_attestation.batch_index <> 0
       OR v_attestation.positive_count IS DISTINCT FROM
            v_claim.expected_rank_count
       OR v_attestation.chunk_count IS DISTINCT FROM
            v_claim.expected_batch_count
       OR v_attestation.manifest_valid_until < v_claim.lease_expires_at THEN
      RAISE EXCEPTION 'later staged batch attestation conflicts with claim'
        USING ERRCODE = '55000';
    END IF;
    v_manifest_valid_until := v_attestation.manifest_valid_until;

    SELECT chunk.*
    INTO v_attestation_chunk
    FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
    WHERE chunk.season_id = p_season_id
      AND chunk.generation_seq = p_generation_seq
      AND chunk.score_cohort_id = p_score_cohort_id
      AND chunk.score_input_manifest_id = p_score_input_manifest_id
      AND chunk.score_input_manifest_digest =
          p_score_input_manifest_digest
      AND chunk.chunk_index = p_batch_index;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'later staged batch has no exact attestation chunk'
        USING ERRCODE = '23503';
    END IF;

    IF v_attestation_chunk.first_position IS DISTINCT FROM
         p_batch_index * 1000 + 1
       OR v_attestation_chunk.row_count IS DISTINCT FROM
            v_current_row_count
       OR NOT arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1(
            v_attestation_chunk.season_id,
            v_attestation_chunk.generation_seq,
            v_attestation_chunk.score_cohort_id,
            v_attestation_chunk.score_input_manifest_id,
            v_attestation_chunk.score_input_manifest_digest,
            v_attestation_chunk.chunk_index,
            v_attestation_chunk.first_position,
            v_attestation_chunk.row_count,
            v_attestation_chunk.identities,
            v_attestation_chunk.field_commitments,
            v_attestation_chunk.chunk_sha256
          ) THEN
      RAISE EXCEPTION 'later staged batch attestation chunk conflicts'
        USING ERRCODE = '55000';
    END IF;
    v_expected_identities := v_attestation_chunk.identities;
    v_expected_commitments := v_attestation_chunk.field_commitments;

    SELECT pg_catalog.count(*)::integer
    INTO STRICT v_binding_count
    FROM ONLY arena.leaderboard_rank_generation_manifest_bindings
      AS binding
    WHERE binding.season_id = p_season_id
      AND binding.generation_seq = p_generation_seq
      AND binding.score_cohort_id = p_score_cohort_id
      AND binding.score_input_manifest_id = p_score_input_manifest_id
      AND binding.score_input_manifest_digest =
          p_score_input_manifest_digest;
    IF v_binding_count <> 1 THEN
      RAISE EXCEPTION 'later staged batch has no exact manifest binding'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  IF v_supplied_identities IS DISTINCT FROM v_expected_identities
     OR v_supplied_commitments IS DISTINCT FROM v_expected_commitments THEN
    RAISE EXCEPTION 'typed scorer fields disagree with manifest attestation'
      USING ERRCODE = '22023';
  END IF;

  v_now := pg_catalog.clock_timestamp();
  IF v_head.lease_expires_at <= v_now
     OR v_manifest_valid_until <= v_now THEN
    RAISE EXCEPTION
      'generation lease expired before private stage append'
      USING ERRCODE = '55000';
  END IF;
  v_completed_at := v_now;

  IF p_batch_index = 0 THEN
    -- Callers can alter constraint mode. Restore the two cyclic batch-zero
    -- edges before binding, receipt, header, and chunks are inserted.
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
      v_completed_at
    );
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
    v_typed_evidence->>'batch_sha256',
    p_score_input_manifest_id,
    p_score_input_manifest_digest,
    v_current_row_count,
    v_current_source_count,
    v_typed_evidence->>'first_source',
    v_typed_evidence->>'first_source_trader_id',
    v_typed_evidence->>'last_source',
    v_typed_evidence->>'last_source_trader_id',
    v_completed_at
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
      v_completed_at
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

  SET CONSTRAINTS
    arena.leaderboard_rank_generation_stage_batches_complete DEFERRED;

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
    v_typed_evidence->>'batch_sha256',
    v_current_row_count,
    v_current_source_count,
    v_typed_evidence->>'first_source',
    v_typed_evidence->>'first_source_trader_id',
    v_typed_evidence->>'last_source',
    v_typed_evidence->>'last_source_trader_id',
    v_completed_at
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
    position.ordinality,
    (p_rows[position.ordinality]).source,
    (p_rows[position.ordinality]).source_trader_id,
    p_rows[position.ordinality],
    v_completed_at
  FROM pg_catalog.generate_subscripts(p_rows, 1)
    AS position(ordinality)
  ORDER BY position.ordinality;
  GET DIAGNOSTICS v_staged_row_count = ROW_COUNT;
  IF v_staged_row_count IS DISTINCT FROM v_current_row_count THEN
    RAISE EXCEPTION 'private stage append did not write the complete batch'
      USING ERRCODE = '55000';
  END IF;

  UPDATE ONLY arena.leaderboard_rank_generation_heads AS head
  SET phase = 'writing',
      updated_at = v_completed_at
  WHERE head.season_id = p_season_id
    AND head.generation_seq = p_generation_seq
    AND head.score_cohort_id = p_score_cohort_id
    AND head.phase = v_expected_phase
    AND head.lease_expires_at = v_claim.lease_expires_at;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'staged batch head compare-and-set failed'
      USING ERRCODE = '55000';
  END IF;

  -- Indexes, immutable evidence triggers, and the CAS can all wait. This final
  -- check makes a late lease loss roll back every private append and receipt.
  v_now := pg_catalog.clock_timestamp();
  IF v_head.lease_expires_at <= v_now
     OR v_manifest_valid_until <= v_now THEN
    RAISE EXCEPTION 'generation lease expired before staged batch commit'
      USING ERRCODE = '55000';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-rank-generation-batch-write@1',
    'season_id', p_season_id,
    'generation_seq', p_generation_seq,
    'score_cohort_id', p_score_cohort_id,
    'phase', 'writing',
    'batch_index', p_batch_index,
    'batch_sha256', v_typed_evidence->>'batch_sha256',
    'row_count', v_current_row_count,
    'source_count', v_current_source_count,
    'completed_at', pg_catalog.to_char(
      v_completed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
END;
$writer_body$;

ALTER FUNCTION arena.write_leaderboard_rank_generation_batch_v1(
  text,
  bigint,
  uuid,
  integer,
  uuid,
  text,
  text[],
  arena.leaderboard_rank_batch_row_v1[]
) OWNER TO postgres;

DO $revoke_writer_acl$
DECLARE
  v_writer regprocedure :=
    'arena.write_leaderboard_rank_generation_batch_v1(text,bigint,uuid,integer,uuid,text,text[],arena.leaderboard_rank_batch_row_v1[])'::regprocedure;
  v_grantee oid;
  v_role_name text;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT expanded.grantee
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS expanded
    WHERE function_row.oid = v_writer
      AND expanded.grantee <> function_row.proowner
    ORDER BY expanded.grantee
  LOOP
    IF v_grantee = 0 THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE',
        v_writer
      );
    ELSE
      SELECT role_row.rolname
      INTO STRICT v_role_name
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_grantee;
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
        v_writer,
        v_role_name
      );
    END IF;
  END LOOP;
END
$revoke_writer_acl$;

REVOKE ALL ON FUNCTION arena.write_leaderboard_rank_generation_batch_v1(
  text,
  bigint,
  uuid,
  integer,
  uuid,
  text,
  text[],
  arena.leaderboard_rank_batch_row_v1[]
) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION arena.write_leaderboard_rank_generation_batch_v1(
  text,
  bigint,
  uuid,
  integer,
  uuid,
  text,
  text[],
  arena.leaderboard_rank_batch_row_v1[]
) IS
  'Owner-only staging writer. Batch zero freezes canonical manifest chunks; every batch appends one immutable private typed version plus its receipt. It never grants serving authority. rank, rank_change, and is_new must be NULL for a later generation finalizer.';

DO $postflight$
DECLARE
  v_writer oid := pg_catalog.to_regprocedure(
    'arena.write_leaderboard_rank_generation_batch_v1(text,bigint,uuid,integer,uuid,text,text[],arena.leaderboard_rank_batch_row_v1[])'
  );
  v_writer_body_digest text;
  v_constraint_count integer;
  v_constraint_digest text;
  v_index_count integer;
  v_index_digest text;
  v_type_oid oid := pg_catalog.to_regtype(
    'arena.leaderboard_rank_batch_row_v1'
  );
  v_type_relation oid;
  v_type_column_count integer;
  v_type_column_digest text;
BEGIN
  SELECT type_row.typrelid
  INTO STRICT v_type_relation
  FROM pg_catalog.pg_type AS type_row
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = type_row.typnamespace
  JOIN pg_catalog.pg_class AS relation_row
    ON relation_row.oid = type_row.typrelid
  WHERE type_row.oid = v_type_oid
    AND type_row.typtype = 'c'
    AND type_row.typowner = 'postgres'::pg_catalog.regrole
    AND namespace_row.nspname = 'arena'
    AND relation_row.relkind = 'c'
    AND relation_row.relpersistence = 'p'
    AND relation_row.relowner = 'postgres'::pg_catalog.regrole
    AND NOT relation_row.relispartition
    AND relation_row.reloptions IS NULL;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            pg_catalog.format(
              '%s|%s|%s|%s|%s|%s|%s|%s|%s',
              attribute.attnum,
              attribute.attname,
              pg_catalog.format_type(
                attribute.atttypid,
                attribute.atttypmod
              ),
              attribute.attnotnull,
              attribute.attidentity,
              attribute.attgenerated,
              attribute.attcollation::pg_catalog.regcollation::text,
              attribute.atttypmod,
              attribute.attndims
            ),
            E'\n' ORDER BY attribute.attnum
          ),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO STRICT v_type_column_count, v_type_column_digest
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = v_type_relation
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF v_type_column_count IS DISTINCT FROM 33
     OR v_type_column_digest IS DISTINCT FROM
          '83ce5a148aedce9eb29690cbc7181f46c28bbe8ee08e8f64c4caadaad5f23d82'
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_type AS type_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           type_row.typacl,
           pg_catalog.acldefault('T', type_row.typowner)
         )
       ) AS expanded
       WHERE type_row.oid = v_type_oid
         AND expanded.grantee <> type_row.typowner
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS expanded
       WHERE attribute.attrelid = v_type_relation
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND expanded.grantee <> 'postgres'::pg_catalog.regrole
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES ('anon'), ('authenticated'), ('service_role'))
         AS api(role_name)
       WHERE pg_catalog.has_type_privilege(
         api.role_name,
         v_type_oid,
         'USAGE'
       )
     ) THEN
    RAISE EXCEPTION
      'staging-only rank writer typed batch catalog changed during install: %|%',
      v_type_column_count,
      v_type_column_digest;
  END IF;

  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
    'hex'
  )
  INTO v_writer_body_digest
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_writer;

  IF v_writer IS NULL
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = function_row.pronamespace
       WHERE namespace_row.nspname = 'arena'
         AND function_row.proname =
             'write_leaderboard_rank_generation_batch_v1'
     ) <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_language AS language_row
         ON language_row.oid = function_row.prolang
       WHERE function_row.oid = v_writer
         AND function_row.proowner = 'postgres'::pg_catalog.regrole
         AND function_row.prokind = 'f'
         AND language_row.lanname = 'plpgsql'
         AND function_row.provolatile = 'v'
         AND function_row.proparallel = 'u'
         AND NOT function_row.prosecdef
         AND NOT function_row.proleakproof
         AND NOT function_row.proisstrict
         AND NOT function_row.proretset
         AND function_row.prorettype = 'pg_catalog.jsonb'::regtype
         AND function_row.pronargs = 8
         AND function_row.pronargdefaults = 0
         AND function_row.proargtypes = ARRAY[
           'pg_catalog.text'::regtype,
           'pg_catalog.int8'::regtype,
           'pg_catalog.uuid'::regtype,
           'pg_catalog.int4'::regtype,
           'pg_catalog.uuid'::regtype,
           'pg_catalog.text'::regtype,
           'pg_catalog.text[]'::regtype,
           'arena.leaderboard_rank_batch_row_v1[]'::regtype
         ]::pg_catalog.oidvector
         AND function_row.proargnames = ARRAY[
           'p_season_id',
           'p_generation_seq',
           'p_score_cohort_id',
           'p_batch_index',
           'p_score_input_manifest_id',
           'p_score_input_manifest_digest',
           'p_batch_sha256_plan',
           'p_rows'
         ]::text[]
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
         ]::text[]
         AND v_writer_body_digest =
             '7247740feba0f910aa010f7d9d0f79230a8438944742027a7e699240cfe7a89f'
     ) THEN
    RAISE EXCEPTION 'staging-only rank writer postflight drifted: %',
      COALESCE(v_writer_body_digest, '-');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS expanded
    WHERE function_row.oid = v_writer
      AND expanded.grantee <> function_row.proowner
      AND expanded.privilege_type = 'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM (VALUES ('anon'), ('authenticated'), ('service_role'))
      AS api(role_name)
    WHERE pg_catalog.has_function_privilege(
      api.role_name,
      v_writer,
      'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'staging-only rank writer postflight ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'arena.validate_leaderboard_rank_generation_manifest_binding()',
          '43d006071c25fe6bfd0d8f3c146594f415f388d2a7607663e5220922d80c5781',
          'plpgsql'::name,
          'trigger'::pg_catalog.regtype,
          'v'::"char",
          'u'::"char",
          false,
          ''::text,
          NULL::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)',
          '947062aaac0da5bbe9fa62d5194c9f5f3a2e4d6bec55e158ea87ce70a38074cb',
          'plpgsql'::name,
          'jsonb'::pg_catalog.regtype,
          's'::"char",
          'u'::"char",
          false,
          'text, text, text, text, jsonb, text, jsonb, text, jsonb, jsonb, timestamp with time zone',
          ARRAY[
            'p_period',
            'p_source_bundle_digest',
            'p_score_rows_sha256',
            'p_physical_boards_sha256',
            'p_source_evidence',
            'p_enrichment_contract',
            'p_enrichment_evidence',
            'p_eligibility_contract',
            'p_eligibility_evidence',
            'p_inputs',
            'p_valid_until'
          ]::text[],
          ARRAY[
            'search_path=pg_catalog, pg_temp',
            'extra_float_digits=3',
            'quote_all_identifiers=off'
          ]::text[]
        ),
        (
          'arena.verify_leaderboard_score_input_manifest_v1(uuid)',
          '7b678b4d1c9a6835567040e1240d09b15ce38357e3f40251c8b3786ec65f45fc',
          'plpgsql'::name,
          'jsonb'::pg_catalog.regtype,
          's'::"char",
          'u'::"char",
          false,
          'uuid',
          ARRAY['p_manifest_id']::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])',
          '7fa1e9f60a7b6cb4072dce842ddd10c367046fcb431a2ae655a9a806172df67e',
          'plpgsql'::name,
          'jsonb'::pg_catalog.regtype,
          's'::"char",
          's'::"char",
          false,
          'text, uuid, timestamp with time zone, arena.leaderboard_rank_batch_row_v1[]',
          ARRAY[
            'p_season_id',
            'p_score_cohort_id',
            'p_computed_at',
            'p_rows'
          ]::text[],
          ARRAY[
            'search_path=pg_catalog, pg_temp',
            'TimeZone=UTC'
          ]::text[]
        ),
        (
          'arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])',
          'f82b8b26dee4b1b5a92d4750ad42ed65d91bd7972bac0ef0f14f0b94e24f197d',
          'plpgsql'::name,
          'text'::pg_catalog.regtype,
          's'::"char",
          's'::"char",
          false,
          'text, uuid, text, timestamp with time zone, integer, text[]',
          ARRAY[
            'p_season_id',
            'p_score_cohort_id',
            'p_score_input_manifest_digest',
            'p_computed_at',
            'p_expected_rank_count',
            'p_batch_sha256_plan'
          ]::text[],
          ARRAY[
            'search_path=pg_catalog, pg_temp',
            'TimeZone=UTC'
          ]::text[]
        ),
        (
          'arena.build_leaderboard_rank_typed_field_commitment_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)',
          'aafce6e95ed4662239a1f84295cc3158dc0011f8bc8948d0161f73767e73dd9a',
          'sql'::name,
          'text'::pg_catalog.regtype,
          'i'::"char",
          's'::"char",
          false,
          'text, text, numeric, numeric, numeric, numeric, numeric, numeric, integer, numeric, jsonb, numeric, numeric, numeric',
          ARRAY[
            'p_source', 'p_source_trader_id', 'p_roi', 'p_pnl',
            'p_win_rate', 'p_max_drawdown', 'p_sharpe_ratio',
            'p_profit_factor', 'p_trades_count', 'p_total_score',
            'p_score_factors', 'p_profitability_score',
            'p_risk_control_score', 'p_execution_score'
          ]::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.encode_leaderboard_rank_manifest_fields_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)',
          '504e8b8fc47f023bb9e821b7b6212f4df773cb94e63cfd5613fb2fff01964b16',
          'plpgsql'::name,
          'jsonb'::pg_catalog.regtype,
          'i'::"char",
          's'::"char",
          false,
          'text, text, numeric, numeric, numeric, numeric, numeric, numeric, integer, numeric, jsonb, numeric, numeric, numeric',
          ARRAY[
            'p_source', 'p_source_trader_id', 'p_roi', 'p_pnl',
            'p_win_rate', 'p_max_drawdown', 'p_sharpe_ratio',
            'p_profit_factor', 'p_trades_count', 'p_total_score',
            'p_score_factors', 'p_profitability_score',
            'p_risk_control_score', 'p_execution_score'
          ]::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.build_leaderboard_rank_manifest_field_commitment_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)',
          '72c4e558313daec92785722c35788e6490a4d9a2144261d0afe9d96666ea04f6',
          'sql'::name,
          'text'::pg_catalog.regtype,
          'i'::"char",
          's'::"char",
          false,
          'text, text, numeric, numeric, numeric, numeric, numeric, numeric, integer, numeric, jsonb, numeric, numeric, numeric',
          ARRAY[
            'p_source', 'p_source_trader_id', 'p_roi', 'p_pnl',
            'p_win_rate', 'p_max_drawdown', 'p_sharpe_ratio',
            'p_profit_factor', 'p_trades_count', 'p_total_score',
            'p_score_factors', 'p_profitability_score',
            'p_risk_control_score', 'p_execution_score'
          ]::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.build_leaderboard_rank_manifest_chunk_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb)',
          '0dddcffebb56d9a51e0869e29cc16ac18f78251d58907764fb02101fa8dad322',
          'plpgsql'::name,
          'text'::pg_catalog.regtype,
          'i'::"char",
          's'::"char",
          false,
          'text, bigint, uuid, uuid, text, integer, integer, integer, jsonb, jsonb',
          ARRAY[
            'p_season_id', 'p_generation_seq', 'p_score_cohort_id',
            'p_score_input_manifest_id', 'p_score_input_manifest_digest',
            'p_chunk_index', 'p_first_position', 'p_row_count',
            'p_identities', 'p_field_commitments'
          ]::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.build_leaderboard_rank_manifest_chunks_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,jsonb)',
          'a663274e1a45e06c90f17fecdb646854be6112cb6e22d2af343afd9737d365dd',
          'plpgsql'::name,
          'text'::pg_catalog.regtype,
          'i'::"char",
          's'::"char",
          false,
          'text, bigint, uuid, uuid, text, integer, integer, jsonb',
          ARRAY[
            'p_season_id', 'p_generation_seq', 'p_score_cohort_id',
            'p_score_input_manifest_id', 'p_score_input_manifest_digest',
            'p_positive_count', 'p_chunk_count', 'p_chunk_plan'
          ]::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.guard_leaderboard_rank_manifest_attestation_chunk_insert_v1()',
          '21cbd784ed8016f1a3acbe96ff82885d5679dce10697ddb658cb660ef449caa9',
          'plpgsql'::name,
          'trigger'::pg_catalog.regtype,
          'v'::"char",
          'u'::"char",
          true,
          ''::text,
          NULL::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb,text)',
          'eaead90785261fd8400748497005d34013d468b5a836a0dbce0be38eaf843d07',
          'plpgsql'::name,
          'boolean'::pg_catalog.regtype,
          'i'::"char",
          's'::"char",
          false,
          'text, bigint, uuid, uuid, text, integer, integer, integer, jsonb, jsonb, text',
          ARRAY[
            'p_season_id', 'p_generation_seq', 'p_score_cohort_id',
            'p_score_input_manifest_id', 'p_score_input_manifest_digest',
            'p_chunk_index', 'p_first_position', 'p_row_count',
            'p_identities', 'p_field_commitments', 'p_chunk_sha256'
          ]::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.validate_leaderboard_rank_manifest_attestation_complete_v1()',
          'a67d03810591c130b7b6e7dbd63becc9b4d08eb4580fd314a223032e1f187e6b',
          'plpgsql'::name,
          'trigger'::pg_catalog.regtype,
          'v'::"char",
          'u'::"char",
          true,
          ''::text,
          NULL::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.guard_leaderboard_rank_generation_stage_row_insert_v1()',
          'ba9030dfdd0431721903561fdfa02c106fcedc66cbb32ab20acf5ebd33958dc9',
          'plpgsql'::name,
          'trigger'::pg_catalog.regtype,
          'v'::"char",
          'u'::"char",
          true,
          ''::text,
          NULL::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        ),
        (
          'arena.validate_leaderboard_rank_generation_stage_batch_v1()',
          '14063ba832d2bd0a5de0d5975eaf4ea8a68093e63b27f78107770cd8766184b0',
          'plpgsql'::name,
          'trigger'::pg_catalog.regtype,
          'v'::"char",
          'u'::"char",
          true,
          ''::text,
          NULL::text[],
          ARRAY[
            'search_path=pg_catalog, pg_temp',
            'TimeZone=UTC',
            'lock_timeout=10s'
          ]::text[]
        ),
        (
          'arena.reject_leaderboard_rank_publication_mutation()',
          '3896caded6f9f7062305267ebf4d99f05f8e6299711d00b8a252d5d043b26e2e',
          'plpgsql'::name,
          'trigger'::pg_catalog.regtype,
          'v'::"char",
          'u'::"char",
          true,
          ''::text,
          NULL::text[],
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
        )
    ) AS expected(
      signature,
      body_sha256,
      language_name,
      return_type,
      volatility,
      parallel_safety,
      security_definer,
      input_arg_types,
      arg_names,
      configuration
    )
    LEFT JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = pg_catalog.to_regprocedure(expected.signature)
    LEFT JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid IS NULL
       OR function_row.proowner <> 'postgres'::pg_catalog.regrole
       OR function_row.prokind <> 'f'
       OR language_row.lanname IS DISTINCT FROM expected.language_name
       OR function_row.provolatile IS DISTINCT FROM expected.volatility
       OR function_row.proparallel IS DISTINCT FROM expected.parallel_safety
       OR function_row.prosecdef IS DISTINCT FROM expected.security_definer
       OR function_row.proleakproof
       OR function_row.proisstrict
       OR function_row.proretset
       OR function_row.prorettype IS DISTINCT FROM expected.return_type
       OR pg_catalog.oidvectortypes(function_row.proargtypes)
            IS DISTINCT FROM expected.input_arg_types
       OR function_row.pronargs IS DISTINCT FROM
            COALESCE(pg_catalog.cardinality(expected.arg_names), 0)
       OR function_row.pronargdefaults <> 0
       OR function_row.provariadic <> 0
       OR function_row.proargnames IS DISTINCT FROM expected.arg_names
       OR function_row.proargmodes IS NOT NULL
       OR function_row.proallargtypes IS NOT NULL
       OR function_row.proargdefaults IS NOT NULL
       OR function_row.protrftypes IS NOT NULL
       OR function_row.prosupport <> 0
       OR function_row.prosqlbody IS NOT NULL
       OR function_row.probin IS NOT NULL
       OR function_row.procost <> 100
       OR function_row.prorows <> 0
       OR function_row.proconfig IS DISTINCT FROM expected.configuration
       OR pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(function_row.prosrc, 'UTF8')
            ),
            'hex'
          ) IS DISTINCT FROM expected.body_sha256
  ) THEN
    RAISE EXCEPTION 'staging-only rank writer helper catalog changed during install';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'arena'
      AND function_row.proname IN (
        'validate_leaderboard_rank_generation_manifest_binding',
        'encode_leaderboard_score_input_manifest_v1',
        'verify_leaderboard_score_input_manifest_v1',
        'build_leaderboard_rank_typed_batch_evidence_v1',
        'build_leaderboard_rank_generation_write_set_sha256_v1',
        'build_leaderboard_rank_typed_field_commitment_v1',
        'encode_leaderboard_rank_manifest_fields_v1',
        'build_leaderboard_rank_manifest_field_commitment_v1',
        'build_leaderboard_rank_manifest_chunk_sha256_v1',
        'build_leaderboard_rank_manifest_chunks_sha256_v1',
        'guard_leaderboard_rank_manifest_attestation_chunk_insert_v1',
        'leaderboard_rank_manifest_attestation_chunk_is_valid_v1',
        'validate_leaderboard_rank_manifest_attestation_complete_v1',
        'guard_leaderboard_rank_generation_stage_row_insert_v1',
        'validate_leaderboard_rank_generation_stage_batch_v1',
        'reject_leaderboard_rank_publication_mutation'
      )
      AND function_row.oid NOT IN (
        'arena.validate_leaderboard_rank_generation_manifest_binding()'::regprocedure,
        'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)'::regprocedure,
        'arena.verify_leaderboard_score_input_manifest_v1(uuid)'::regprocedure,
        'arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])'::regprocedure,
        'arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])'::regprocedure,
        'arena.build_leaderboard_rank_typed_field_commitment_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'::regprocedure,
        'arena.encode_leaderboard_rank_manifest_fields_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'::regprocedure,
        'arena.build_leaderboard_rank_manifest_field_commitment_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'::regprocedure,
        'arena.build_leaderboard_rank_manifest_chunk_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb)'::regprocedure,
        'arena.build_leaderboard_rank_manifest_chunks_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,jsonb)'::regprocedure,
        'arena.guard_leaderboard_rank_manifest_attestation_chunk_insert_v1()'::regprocedure,
        'arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb,text)'::regprocedure,
        'arena.validate_leaderboard_rank_manifest_attestation_complete_v1()'::regprocedure,
        'arena.guard_leaderboard_rank_generation_stage_row_insert_v1()'::regprocedure,
        'arena.validate_leaderboard_rank_generation_stage_batch_v1()'::regprocedure,
        'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure
      )
  ) THEN
    RAISE EXCEPTION 'staging-only rank writer helper overload changed during install';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS expanded
    WHERE function_row.oid IN (
      'arena.validate_leaderboard_rank_generation_manifest_binding()'::regprocedure,
      'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)'::regprocedure,
      'arena.verify_leaderboard_score_input_manifest_v1(uuid)'::regprocedure,
      'arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])'::regprocedure,
      'arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])'::regprocedure,
      'arena.build_leaderboard_rank_typed_field_commitment_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'::regprocedure,
      'arena.encode_leaderboard_rank_manifest_fields_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'::regprocedure,
      'arena.build_leaderboard_rank_manifest_field_commitment_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'::regprocedure,
      'arena.build_leaderboard_rank_manifest_chunk_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb)'::regprocedure,
      'arena.build_leaderboard_rank_manifest_chunks_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,jsonb)'::regprocedure,
      'arena.guard_leaderboard_rank_manifest_attestation_chunk_insert_v1()'::regprocedure,
      'arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb,text)'::regprocedure,
      'arena.validate_leaderboard_rank_manifest_attestation_complete_v1()'::regprocedure,
      'arena.guard_leaderboard_rank_generation_stage_row_insert_v1()'::regprocedure,
      'arena.validate_leaderboard_rank_generation_stage_batch_v1()'::regprocedure,
      'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure
    )
      AND expanded.grantee <> function_row.proowner
      AND expanded.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'staging-only rank writer helper ACL changed during install';
  END IF;

  WITH target(relation_name, relation_oid) AS (
    VALUES
      ('leaderboard_rank_generation_heads',
        'arena.leaderboard_rank_generation_heads'::regclass),
      ('leaderboard_rank_generation_claims',
        'arena.leaderboard_rank_generation_claims'::regclass),
      ('leaderboard_score_input_manifests',
        'arena.leaderboard_score_input_manifests'::regclass),
      ('leaderboard_rank_generation_manifest_bindings',
        'arena.leaderboard_rank_generation_manifest_bindings'::regclass),
      ('leaderboard_rank_generation_batch_receipts',
        'arena.leaderboard_rank_generation_batch_receipts'::regclass),
      ('leaderboard_rank_generation_source_fence_receipts',
        'arena.leaderboard_rank_generation_source_fence_receipts'::regclass),
      ('leaderboard_rank_manifest_attestations',
        'arena.leaderboard_rank_manifest_attestations'::regclass),
      ('leaderboard_rank_manifest_attestation_chunks',
        'arena.leaderboard_rank_manifest_attestation_chunks'::regclass),
      ('leaderboard_rank_generation_stage_batches',
        'arena.leaderboard_rank_generation_stage_batches'::regclass),
      ('leaderboard_rank_generation_stage_rows',
        'arena.leaderboard_rank_generation_stage_rows'::regclass)
  ), preimage AS (
    SELECT
      pg_catalog.jsonb_build_array(
        'leaderboard-rank-staging-writer-authority-constraints@1',
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'relation', target.relation_name,
            'name', constraint_row.conname,
            'type', constraint_row.contype,
            'validated', constraint_row.convalidated,
            'deferrable', constraint_row.condeferrable,
            'deferred', constraint_row.condeferred,
            'noInherit', constraint_row.connoinherit,
            'isLocal', constraint_row.conislocal,
            'inheritCount', constraint_row.coninhcount,
            'parentIsLocal', constraint_row.conparentid = 0,
            'key', pg_catalog.to_jsonb(constraint_row.conkey),
            'foreignRelation', CASE constraint_row.confrelid
              WHEN 0 THEN NULL
              ELSE constraint_row.confrelid::regclass::text
            END,
            'foreignKey', pg_catalog.to_jsonb(constraint_row.confkey),
            'foreignUpdate', constraint_row.confupdtype,
            'foreignDelete', constraint_row.confdeltype,
            'foreignMatch', constraint_row.confmatchtype,
            'backingIndex', CASE constraint_row.conindid
              WHEN 0 THEN NULL
              ELSE constraint_row.conindid::regclass::text
            END,
            'definition', pg_catalog.pg_get_constraintdef(
              constraint_row.oid,
              false
            )
          )
          ORDER BY
            target.relation_name COLLATE pg_catalog."C",
            constraint_row.conname COLLATE pg_catalog."C"
        )
      ) AS value,
      pg_catalog.count(*)::integer AS entry_count
    FROM target
    JOIN pg_catalog.pg_constraint AS constraint_row
      ON constraint_row.conrelid = target.relation_oid
  )
  SELECT
    preimage.entry_count,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(preimage.value::text, 'UTF8')
      ),
      'hex'
    )
  INTO STRICT v_constraint_count, v_constraint_digest
  FROM preimage;

  IF v_constraint_count IS DISTINCT FROM 120
     OR v_constraint_digest IS DISTINCT FROM
          '7e07fd96291161b2eca8541b128112dbde33db78fae03e45ee0995908e0f45de'
  THEN
    RAISE EXCEPTION
      'staging-only rank writer authority constraint digest changed during install: %|%',
      v_constraint_count,
      v_constraint_digest;
  END IF;

  WITH target(relation_name, relation_oid) AS (
    VALUES
      ('leaderboard_rank_generation_heads',
        'arena.leaderboard_rank_generation_heads'::regclass),
      ('leaderboard_rank_generation_claims',
        'arena.leaderboard_rank_generation_claims'::regclass),
      ('leaderboard_score_input_manifests',
        'arena.leaderboard_score_input_manifests'::regclass),
      ('leaderboard_rank_generation_manifest_bindings',
        'arena.leaderboard_rank_generation_manifest_bindings'::regclass),
      ('leaderboard_rank_generation_batch_receipts',
        'arena.leaderboard_rank_generation_batch_receipts'::regclass),
      ('leaderboard_rank_generation_source_fence_receipts',
        'arena.leaderboard_rank_generation_source_fence_receipts'::regclass),
      ('leaderboard_rank_manifest_attestations',
        'arena.leaderboard_rank_manifest_attestations'::regclass),
      ('leaderboard_rank_manifest_attestation_chunks',
        'arena.leaderboard_rank_manifest_attestation_chunks'::regclass),
      ('leaderboard_rank_generation_stage_batches',
        'arena.leaderboard_rank_generation_stage_batches'::regclass),
      ('leaderboard_rank_generation_stage_rows',
        'arena.leaderboard_rank_generation_stage_rows'::regclass)
  ), preimage AS (
    SELECT
      pg_catalog.jsonb_build_array(
        'leaderboard-rank-staging-writer-authority-indexes@1',
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'relation', target.relation_name,
            'name', index_class.relname,
            'kind', index_class.relkind,
            'persistence', index_class.relpersistence,
            'accessMethod', access_method.amname,
            'tablespace', index_class.reltablespace,
            'options', pg_catalog.to_jsonb(index_class.reloptions),
            'valid', index_row.indisvalid,
            'ready', index_row.indisready,
            'live', index_row.indislive,
            'unique', index_row.indisunique,
            'nullsNotDistinct', index_row.indnullsnotdistinct,
            'primary', index_row.indisprimary,
            'exclusion', index_row.indisexclusion,
            'immediate', index_row.indimmediate,
            'clustered', index_row.indisclustered,
            'replicaIdentity', index_row.indisreplident,
            'keyAttributes', index_row.indnkeyatts,
            'attributes', index_row.indnatts,
            'key', index_row.indkey::text,
            'definition', pg_catalog.pg_get_indexdef(
              index_row.indexrelid,
              0,
              false
            ),
            'predicate', pg_catalog.pg_get_expr(
              index_row.indpred,
              index_row.indrelid,
              false
            ),
            'expressions', pg_catalog.pg_get_expr(
              index_row.indexprs,
              index_row.indrelid,
              false
            )
          )
          ORDER BY
            target.relation_name COLLATE pg_catalog."C",
            index_class.relname COLLATE pg_catalog."C"
        )
      ) AS value,
      pg_catalog.count(*)::integer AS entry_count
    FROM target
    JOIN pg_catalog.pg_index AS index_row
      ON index_row.indrelid = target.relation_oid
    JOIN pg_catalog.pg_class AS index_class
      ON index_class.oid = index_row.indexrelid
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = index_class.relam
  )
  SELECT
    preimage.entry_count,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(preimage.value::text, 'UTF8')
      ),
      'hex'
    )
  INTO STRICT v_index_count, v_index_digest
  FROM preimage;

  IF v_index_count IS DISTINCT FROM 23
     OR v_index_digest IS DISTINCT FROM
          '0d4aef092635571aa1f4004b9e5dc64536b510628d710bb0e3c27af64769fb83'
  THEN
    RAISE EXCEPTION
      'staging-only rank writer authority index digest changed during install: %|%',
      v_index_count,
      v_index_digest;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = ANY (ARRAY[
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass,
      'arena.leaderboard_rank_manifest_attestations'::regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::regclass,
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    ]::regclass[])
       OR inheritance.inhparent = ANY (ARRAY[
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass,
      'arena.leaderboard_rank_manifest_attestations'::regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::regclass,
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    ]::regclass[])
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rule_row
    WHERE rule_row.ev_class = ANY (ARRAY[
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass,
      'arena.leaderboard_rank_manifest_attestations'::regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::regclass,
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    ]::regclass[])
  ) THEN
    RAISE EXCEPTION
      'staging-only rank writer inheritance or rewrite topology changed during install';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    )
  ) <> 33 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid IN (
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    )
  ) <> 5 THEN
    RAISE EXCEPTION 'staging-only rank writer stage changed during install';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass,
      'arena.leaderboard_rank_manifest_attestations'::regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::regclass,
      'arena.leaderboard_rank_generation_stage_batches'::regclass,
      'arena.leaderboard_rank_generation_stage_rows'::regclass
    )
      AND NOT trigger_row.tgisinternal
  ) <> 20 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'arena.leaderboard_rank_generation_claims'::regclass,
          'leaderboard_rank_generation_claim_immutable'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          27, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
          'leaderboard_rank_generation_manifest_bindings_validate'::name,
          'arena.validate_leaderboard_rank_generation_manifest_binding()'::regprocedure,
          7, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
          'leaderboard_rank_generation_manifest_bindings_immutable'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          27, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
          'leaderboard_rank_generation_manifest_bindings_no_truncate'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          34, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_batch_receipts'::regclass,
          'leaderboard_rank_generation_batch_receipts_immutable'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          27, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_batch_receipts'::regclass,
          'leaderboard_rank_generation_batch_receipts_no_truncate'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          34, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_source_fence_receipts'::regclass,
          'leaderboard_rank_generation_source_fence_receipts_immutable'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          27, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_source_fence_receipts'::regclass,
          'leaderboard_rank_generation_source_fence_receipts_no_truncate'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          34, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_manifest_attestations'::regclass,
          'leaderboard_rank_manifest_attestations_immutable'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          27, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_manifest_attestations'::regclass,
          'leaderboard_rank_manifest_attestations_no_truncate'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          34, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_manifest_attestations'::regclass,
          'leaderboard_rank_manifest_attestations_complete'::name,
          'arena.validate_leaderboard_rank_manifest_attestation_complete_v1()'::regprocedure,
          5, true, true, true, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_manifest_attestation_chunks'::regclass,
          'leaderboard_rank_manifest_attestation_chunks_insert_guard'::name,
          'arena.guard_leaderboard_rank_manifest_attestation_chunk_insert_v1()'::regprocedure,
          7, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_manifest_attestation_chunks'::regclass,
          'leaderboard_rank_manifest_attestation_chunks_immutable'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          27, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_manifest_attestation_chunks'::regclass,
          'leaderboard_rank_manifest_attestation_chunks_no_truncate'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          34, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_stage_batches'::regclass,
          'leaderboard_rank_generation_stage_batches_complete'::name,
          'arena.validate_leaderboard_rank_generation_stage_batch_v1()'::regprocedure,
          5, true, true, true, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_stage_batches'::regclass,
          'leaderboard_rank_generation_stage_batches_immutable'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          27, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_stage_batches'::regclass,
          'leaderboard_rank_generation_stage_batches_no_truncate'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          34, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_stage_rows'::regclass,
          'leaderboard_rank_generation_stage_rows_insert_guard'::name,
          'arena.guard_leaderboard_rank_generation_stage_row_insert_v1()'::regprocedure,
          4, false, false, false, NULL::text, 'new_stage_rows'::text
        ),
        (
          'arena.leaderboard_rank_generation_stage_rows'::regclass,
          'leaderboard_rank_generation_stage_rows_immutable'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          27, false, false, false, NULL::text, NULL::text
        ),
        (
          'arena.leaderboard_rank_generation_stage_rows'::regclass,
          'leaderboard_rank_generation_stage_rows_no_truncate'::name,
          'arena.reject_leaderboard_rank_publication_mutation()'::regprocedure,
          34, false, false, false, NULL::text, NULL::text
        )
    ) AS expected(
      relation_oid,
      trigger_name,
      function_oid,
      trigger_type,
      is_constraint,
      is_deferrable,
      is_initially_deferred,
      old_transition_table,
      new_transition_table
    )
    LEFT JOIN pg_catalog.pg_trigger AS trigger_row
      ON trigger_row.tgrelid = expected.relation_oid
     AND trigger_row.tgname = expected.trigger_name
    WHERE trigger_row.oid IS NULL
       OR trigger_row.tgfoid <> expected.function_oid
       OR trigger_row.tgtype <> expected.trigger_type
       OR (trigger_row.tgconstraint <> 0) IS DISTINCT FROM
            expected.is_constraint
       OR trigger_row.tgdeferrable IS DISTINCT FROM expected.is_deferrable
       OR trigger_row.tginitdeferred IS DISTINCT FROM
            expected.is_initially_deferred
       OR trigger_row.tgoldtable::text IS DISTINCT FROM
            expected.old_transition_table
       OR trigger_row.tgnewtable::text IS DISTINCT FROM
            expected.new_transition_table
       OR trigger_row.tgenabled <> 'O'
       OR trigger_row.tgisinternal
       OR trigger_row.tgparentid <> 0
       OR trigger_row.tgnargs <> 0
       OR trigger_row.tgargs <> '\x'::bytea
       OR trigger_row.tgattr <> ''::pg_catalog.int2vector
       OR trigger_row.tgqual IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'staging-only rank writer trigger topology changed during install';
  END IF;
END
$postflight$;

COMMIT;
