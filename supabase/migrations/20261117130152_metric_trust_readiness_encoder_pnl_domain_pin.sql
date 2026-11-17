-- Forward repair: metric-trust release readiness pinned a stale encoder spelling.
--
-- 20260722055000 required arena.encode_leaderboard_score_input_manifest_v1 to
-- contain the text 'jsonb_path_query_array' (the 20260722052000 spelling of the
-- rank-eligible PnL guard). 20261113014105 / 20261114101514 re-created the
-- encoder with the equivalent fail-closed guard spelled with jsonb_typeof and
-- the error 'leaderboard score-input PnL must be a finite JSON number'. The
-- readiness RPC therefore reports metric_trust_object_contract missing and the
-- ingest worker startup gate fails closed on every start.
--
-- This migration re-creates the readiness RPC with exactly one changed clause:
-- the encoder pin now requires the current PnL-domain guard. Owner, ACL,
-- SECURITY DEFINER, configuration and the @2 contract are unchanged
-- (CREATE OR REPLACE preserves owner and privileges). The table constraint
-- leaderboard_score_input_manifest_rank_eligible_pnl is still pinned as before.

BEGIN;

DO $preflight$
DECLARE
  v_rpc oid := pg_catalog.to_regprocedure(
    'public.arena_metric_trust_release_readiness()'
  );
  v_encoder oid := pg_catalog.to_regprocedure(
    'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
  );
BEGIN
  IF v_rpc IS NULL OR v_encoder IS NULL THEN
    RAISE EXCEPTION 'readiness RPC or score-input encoder is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function_row
     WHERE function_row.oid = v_encoder
       AND pg_catalog.strpos(
             function_row.prosrc,
             'leaderboard score-input PnL must be a finite JSON number'
           ) > 0
       AND pg_catalog.strpos(
             function_row.prosrc,
             'IS DISTINCT FROM ''number'''
           ) > 0
  ) THEN
    RAISE EXCEPTION 'score-input encoder lacks the fail-closed PnL domain guard';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function_row
     WHERE function_row.oid = v_rpc
       AND pg_catalog.strpos(
             function_row.prosrc,
             'pg_catalog.strpos(function_row.prosrc, ''jsonb_path_query_array'') > 0'
           ) > 0
  ) THEN
    RAISE EXCEPTION 'readiness RPC is not the 20260722055000 definition';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.arena_metric_trust_release_readiness()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_expected record;
  v_missing text[] := ARRAY[]::text[];
  v_legacy_complete_verified_count bigint;
  v_source_page_lineage_column boolean := false;
  v_object_contract boolean := true;
  v_acl_contract boolean := true;
  v_view_definition text;
  v_release_migration_count bigint := 0;
  v_release_migration_sha256 text := '';
  v_rpc_oid oid := pg_catalog.to_regprocedure(
    'public.arena_metric_trust_release_readiness()'
  );
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service_role oid := pg_catalog.to_regrole('service_role');
BEGIN
  FOR v_expected IN
    SELECT *
      FROM (VALUES
        (
          '20260721120000'::text,
          'metric_trust_shadow_gate'::text,
          '9406636f749318929b9b1b9e2032256a571ec4e8e0246b66dc31c8ed0176fe30'::text
        ),
        (
          '20260721130000',
          'raw_object_gc_outbox',
          '700805755c7daee4b4a1df4a2f65a0d3ab593270f65e112dc1704479a3b91066'
        ),
        (
          '20260721150000',
          'metric_trust_raw_artifact_identity',
          'b4c96ec8123be5dac548962b03834ffd9a0b0e7b4797abe9349ad0bc7bfca48a'
        ),
        (
          '20260722030000',
          'durable_leaderboard_acquisition_attempt_ledger',
          'd60f5e1a3c04088b04f12a883ceae16aefd36b56ad97dd09dd0084c7a758d71e'
        ),
        (
          '20260722040000',
          'leaderboard_acquisition_manifest_v3_compat',
          '9e6dbed7647ca494c928eba573163b2be9fccfd0956df7ab7fbb9c81121a1f2b'
        ),
        (
          '20260722042000',
          'leaderboard_terminal_publication_fence',
          'e5c4c67e6fc822ff38e36d80ffe5770f305de63c7497973ba9b956bca3520b47'
        ),
        (
          '20260722050000',
          'metric_trust_attempt_outcome_authority',
          '3648ac33324eb99e476eb15dc624b37d6d086ac6eef92c9b34dc8e30399dd92f'
        ),
        (
          '20260722051000',
          'leaderboard_score_input_manifest_contract',
          'fdf578522865afc7b81d7f1fedd99e4bf6e007d0460d3ba678babf4414a4829c'
        ),
        (
          '20260722052000',
          'leaderboard_score_input_manifest_rank_eligible_pnl',
          '34d1af48d66a4b3cedcee548e3438ba81fa9cc3fdca7a00f308d7f768f30150e'
        ),
        (
          '20260722053000',
          'binance_spot_metric_source_contract',
          '1f4ce27a0a44cfc6f9c1d11c113dc2db7aa5eed170ef3b38b1469c0a1c758abc'
        )
      ) AS expected(version, name, body_sha256)
  LOOP
    IF (
         SELECT pg_catalog.count(*)
           FROM supabase_migrations.schema_migrations AS ledger
          WHERE ledger.name = v_expected.name
             OR ledger.version = v_expected.version
       ) <> 1
       OR NOT EXISTS (
         SELECT 1
           FROM supabase_migrations.schema_migrations AS ledger
          WHERE ledger.name = v_expected.name
            AND pg_catalog.array_length(ledger.statements, 1) = 1
            AND pg_catalog.encode(
                  extensions.digest(ledger.statements[1], 'sha256'),
                  'hex'
                ) = v_expected.body_sha256
       ) THEN
      v_missing := pg_catalog.array_append(
        v_missing,
        'ledger:' || v_expected.version
      );
    END IF;
  END LOOP;

  IF EXISTS (
       SELECT 1
         FROM supabase_migrations.schema_migrations AS ledger
        WHERE ledger.name = 'metric_trust_source_page_lineage'
           OR ledger.version = '20260722054000'
     ) AND (
       (
         SELECT pg_catalog.count(*)
           FROM supabase_migrations.schema_migrations AS ledger
          WHERE ledger.name = 'metric_trust_source_page_lineage'
             OR ledger.version = '20260722054000'
       ) <> 1
       OR NOT EXISTS (
         SELECT 1
           FROM supabase_migrations.schema_migrations AS ledger
          WHERE ledger.name = 'metric_trust_source_page_lineage'
            AND pg_catalog.array_length(ledger.statements, 1) = 1
            AND pg_catalog.encode(
                  extensions.digest(ledger.statements[1], 'sha256'),
                  'hex'
                ) = '93c512791e8bb7beb00742c7b65c6d79ecdf79ea49e26a3d67c3b3c438ae42cf'
       )
     ) THEN
    v_missing := pg_catalog.array_append(v_missing, 'ledger:20260722054000');
  END IF;

  SELECT
    pg_catalog.count(*),
    COALESCE(
      pg_catalog.max(
        CASE
          WHEN ledger.name = 'metric_trust_source_page_lineage_forward_repair'
           AND pg_catalog.array_length(ledger.statements, 1) = 1
          THEN pg_catalog.encode(
                 extensions.digest(ledger.statements[1], 'sha256'),
                 'hex'
               )
          ELSE NULL
        END
      ),
      ''
    )
  INTO STRICT v_release_migration_count, v_release_migration_sha256
  FROM supabase_migrations.schema_migrations AS ledger
  WHERE ledger.name = 'metric_trust_source_page_lineage_forward_repair'
     OR ledger.version = '20260722055000';

  IF v_release_migration_count <> 1
     OR v_release_migration_sha256 !~ '^[0-9a-f]{64}$' THEN
    v_missing := pg_catalog.array_append(
      v_missing,
      'supabase_migrations.metric_trust_source_page_lineage_forward_repair'
    );
  END IF;

  v_object_contract :=
    pg_catalog.to_regclass('arena.raw_objects') IS NOT NULL
    AND pg_catalog.to_regclass('arena.raw_object_gc_queue') IS NOT NULL
    AND pg_catalog.to_regclass('arena.metric_source_contracts') IS NOT NULL
    AND pg_catalog.to_regclass('arena.metric_trust_runs') IS NOT NULL
    AND pg_catalog.to_regclass('arena.metric_trust_observations') IS NOT NULL
    AND pg_catalog.to_regclass('arena.metric_trust_artifacts') IS NOT NULL
    AND pg_catalog.to_regclass('arena.metric_rankable_observations') IS NOT NULL
    AND pg_catalog.to_regclass('arena.leaderboard_capture_contracts') IS NOT NULL
    AND pg_catalog.to_regclass('arena.leaderboard_acquisition_attempts') IS NOT NULL
    AND pg_catalog.to_regclass('arena.leaderboard_acquisition_outcomes') IS NOT NULL
    AND pg_catalog.to_regclass('arena.leaderboard_acquisition_attempt_states') IS NOT NULL
    AND pg_catalog.to_regclass('arena.latest_terminal_leaderboard_acquisitions') IS NOT NULL
    AND pg_catalog.to_regclass('arena.leaderboard_score_input_manifests') IS NOT NULL
    AND pg_catalog.to_regclass('arena.uidx_raw_population_manifest_per_run') IS NOT NULL
    AND pg_catalog.to_regclass('arena.uidx_raw_tier_a_population_per_run') IS NOT NULL
    AND pg_catalog.to_regprocedure(
          'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'
        ) IS NOT NULL
    AND pg_catalog.to_regprocedure(
          'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)'
        ) IS NOT NULL
    AND pg_catalog.to_regprocedure(
          'arena.serialize_leaderboard_terminal_publication()'
        ) IS NOT NULL
    AND pg_catalog.to_regprocedure(
          'arena.lock_leaderboard_acquisition_source_window(integer,integer)'
        ) IS NOT NULL
    AND pg_catalog.to_regprocedure(
          'arena.validate_metric_trust_attempt_outcome_authority()'
        ) IS NOT NULL
    AND pg_catalog.to_regprocedure(
          'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
        ) IS NOT NULL
    AND pg_catalog.to_regprocedure(
          'arena.seal_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
        ) IS NOT NULL
    AND pg_catalog.to_regprocedure(
          'arena.verify_leaderboard_score_input_manifest_v1(uuid)'
        ) IS NOT NULL
    AND pg_catalog.to_regprocedure(
          'arena.validate_metric_trust_source_page_lineage()'
        ) IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_attribute AS attribute_row
       WHERE attribute_row.attrelid = 'arena.raw_objects'::pg_catalog.regclass
         AND attribute_row.attname = 'source_run_id'
         AND attribute_row.atttypid = 'text'::pg_catalog.regtype
         AND attribute_row.attnum > 0
         AND NOT attribute_row.attisdropped
    )
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_attribute AS attribute_row
       WHERE attribute_row.attrelid = 'arena.raw_objects'::pg_catalog.regclass
         AND attribute_row.attname = 'trust_artifact_role'
         AND attribute_row.atttypid = 'text'::pg_catalog.regtype
         AND attribute_row.attnum > 0
         AND NOT attribute_row.attisdropped
    )
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_index AS index_row
        JOIN pg_catalog.pg_attribute AS attribute_row
          ON attribute_row.attrelid = index_row.indrelid
         AND attribute_row.attname = 'source_run_id'
         AND attribute_row.attnum > 0
         AND NOT attribute_row.attisdropped
       WHERE index_row.indexrelid =
             'arena.uidx_raw_population_manifest_per_run'::pg_catalog.regclass
         AND index_row.indisunique
         AND index_row.indisvalid
         AND index_row.indisready
         AND index_row.indnkeyatts = 1
         AND index_row.indnatts = 1
         AND index_row.indkey[0] = attribute_row.attnum
         AND index_row.indexprs IS NULL
         AND pg_catalog.pg_get_indexdef(index_row.indexrelid, 1, true) =
             'source_run_id'
         AND pg_catalog.pg_get_expr(
               index_row.indpred,
               index_row.indrelid,
               true
             ) =
             'source_run_id IS NOT NULL AND trust_artifact_role = ''population_manifest''::text'
    )
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_index AS index_row
        JOIN pg_catalog.pg_attribute AS attribute_row
          ON attribute_row.attrelid = index_row.indrelid
         AND attribute_row.attname = 'source_run_id'
         AND attribute_row.attnum > 0
         AND NOT attribute_row.attisdropped
       WHERE index_row.indexrelid =
             'arena.uidx_raw_tier_a_population_per_run'::pg_catalog.regclass
         AND index_row.indisunique
         AND index_row.indisvalid
         AND index_row.indisready
         AND index_row.indnkeyatts = 1
         AND index_row.indnatts = 1
         AND index_row.indkey[0] = attribute_row.attnum
         AND index_row.indexprs IS NULL
         AND pg_catalog.pg_get_indexdef(index_row.indexrelid, 1, true) =
             'source_run_id'
         AND pg_catalog.pg_get_expr(
               index_row.indpred,
               index_row.indrelid,
               true
             ) =
             'source_run_id IS NOT NULL AND trust_artifact_role = ''source_payload''::text AND job_type = ''tier_a''::text AND trader_id IS NULL'
    )
    AND EXISTS (
      SELECT 1
        FROM arena.leaderboard_capture_contracts AS capture
       WHERE capture.capture_contract =
             'arena.ingest.leaderboard-acquisition-manifest@3'
         AND capture.attempt_binding_contract =
             'arena.ingest.leaderboard-acquisition-attempt-binding@1'
         AND capture.requires_runner_git_sha
    )
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid =
             'arena.leaderboard_score_input_manifests'::pg_catalog.regclass
         AND constraint_row.conname =
             'leaderboard_score_input_manifest_rank_eligible_pnl'
         AND constraint_row.contype = 'c'
         AND constraint_row.convalidated
         AND pg_catalog.strpos(
               pg_catalog.pg_get_expr(
                 constraint_row.conbin,
                 constraint_row.conrelid,
                 true
               ),
               'jsonb_path_query_array'
             ) > 0
         AND pg_catalog.strpos(
               pg_catalog.pg_get_expr(
                 constraint_row.conbin,
                 constraint_row.conrelid,
                 true
               ),
               'jsonb_typeof'
             ) > 0
         AND pg_catalog.strpos(
               pg_catalog.pg_get_expr(
                 constraint_row.conbin,
                 constraint_row.conrelid,
                 true
               ),
               'manifest -> ''inputs''::text'
             ) > 0
         AND (
               pg_catalog.length(
                 pg_catalog.pg_get_expr(
                   constraint_row.conbin,
                   constraint_row.conrelid,
                   true
                 )
               )
               - pg_catalog.length(
                   pg_catalog.replace(
                     pg_catalog.pg_get_expr(
                       constraint_row.conbin,
                       constraint_row.conrelid,
                       true
                     ),
                     'jsonb_array_length',
                     ''
                   )
                 )
             ) = 2 * pg_catalog.length('jsonb_array_length')
         AND pg_catalog.strpos(
               pg_catalog.pg_get_expr(
                 constraint_row.conbin,
                 constraint_row.conrelid,
                 true
               ),
               '$[*]?(@."pnl".type() == "number")'
             ) > 0
    )
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid =
             'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
         AND trigger_row.tgname =
             'leaderboard_acquisition_outcomes_serialize_terminal_publication'
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         AND trigger_row.tgtype = 7
         AND trigger_row.tgattr = ''::pg_catalog.int2vector
         AND trigger_row.tgqual IS NULL
         AND trigger_row.tgconstraint = 0
         AND NOT trigger_row.tgdeferrable
         AND NOT trigger_row.tginitdeferred
         AND trigger_row.tgnargs = 0
         AND pg_catalog.octet_length(trigger_row.tgargs) = 0
         AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
               'arena.serialize_leaderboard_terminal_publication()'
             )
    )
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid =
             'arena.metric_trust_runs'::pg_catalog.regclass
         AND trigger_row.tgname =
             'metric_trust_runs_attempt_outcome_authority_before_insert'
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         AND trigger_row.tgtype = 7
         AND trigger_row.tgattr = ''::pg_catalog.int2vector
         AND trigger_row.tgqual IS NULL
         AND trigger_row.tgconstraint = 0
         AND NOT trigger_row.tgdeferrable
         AND NOT trigger_row.tginitdeferred
         AND trigger_row.tgnargs = 0
         AND pg_catalog.octet_length(trigger_row.tgargs) = 0
         AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
               'arena.validate_metric_trust_attempt_outcome_authority()'
             )
    )
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = pg_catalog.to_regprocedure(
               'arena.serialize_leaderboard_terminal_publication()'
             )
         AND function_row.proowner = v_postgres
         AND function_row.prosecdef
         AND function_row.provolatile = 'v'
         AND function_row.prorettype = 'trigger'::pg_catalog.regtype
         AND function_row.proconfig @> ARRAY[
               'search_path=pg_catalog, pg_temp'
             ]::text[]
         AND pg_catalog.strpos(
               function_row.prosrc,
               'FROM arena.leaderboard_acquisition_attempts AS attempt'
             ) > 0
         AND pg_catalog.strpos(
               function_row.prosrc,
               'pg_catalog.pg_advisory_xact_lock'
             ) > 0
    )
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = pg_catalog.to_regprocedure(
               'arena.lock_leaderboard_acquisition_source_window(integer,integer)'
             )
         AND function_row.proowner = v_postgres
         AND function_row.prosecdef
         AND function_row.provolatile = 'v'
         AND function_row.prorettype = 'void'::pg_catalog.regtype
         AND function_row.proconfig @> ARRAY[
               'search_path=pg_catalog, pg_temp',
               'lock_timeout=5s'
             ]::text[]
         AND pg_catalog.strpos(
               function_row.prosrc,
               '''arena.leaderboard-acquisition-source:'''
             ) > 0
         AND pg_catalog.strpos(
               function_row.prosrc,
               'pg_catalog.pg_advisory_xact_lock'
             ) > 0
    )
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = pg_catalog.to_regprocedure(
               'arena.validate_metric_trust_attempt_outcome_authority()'
             )
         AND function_row.proowner = v_postgres
         AND function_row.prosecdef
         AND function_row.provolatile = 'v'
         AND function_row.prorettype = 'trigger'::pg_catalog.regtype
         AND function_row.proconfig @> ARRAY[
               'search_path=pg_catalog, pg_temp',
               'lock_timeout=5s'
             ]::text[]
         AND pg_catalog.strpos(
               function_row.prosrc,
               'arena.latest_terminal_leaderboard_acquisitions AS terminal'
             ) > 0
         AND pg_catalog.strpos(
               function_row.prosrc,
               'PERFORM arena.lock_leaderboard_acquisition_source_window'
             ) > 0
    )
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = pg_catalog.to_regprocedure(
               'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
             )
         AND function_row.proowner = v_postgres
         AND NOT function_row.prosecdef
         AND function_row.provolatile = 's'
         AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
         AND function_row.proconfig @> ARRAY[
               'search_path=pg_catalog, pg_temp'
             ]::text[]
         AND pg_catalog.strpos(
               function_row.prosrc,
               'leaderboard score-input PnL must be a finite JSON number'
             ) > 0
         AND pg_catalog.strpos(function_row.prosrc, '''pnl''') > 0
    )
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = pg_catalog.to_regprocedure(
               'arena.seal_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'
             )
         AND function_row.proowner = v_postgres
         AND NOT function_row.prosecdef
         AND function_row.provolatile = 'v'
         AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
         AND function_row.proconfig @> ARRAY[
               'search_path=pg_catalog, pg_temp'
             ]::text[]
         AND pg_catalog.strpos(
               function_row.prosrc,
               'arena.encode_leaderboard_score_input_manifest_v1'
             ) > 0
         AND pg_catalog.strpos(
               function_row.prosrc,
               'INSERT INTO arena.leaderboard_score_input_manifests'
             ) > 0
    )
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = pg_catalog.to_regprocedure(
               'arena.verify_leaderboard_score_input_manifest_v1(uuid)'
             )
         AND function_row.proowner = v_postgres
         AND NOT function_row.prosecdef
         AND function_row.provolatile = 's'
         AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
         AND function_row.proconfig @> ARRAY[
               'search_path=pg_catalog, pg_temp'
             ]::text[]
         AND pg_catalog.strpos(
               function_row.prosrc,
               'arena.encode_leaderboard_score_input_manifest_v1'
             ) > 0
         AND pg_catalog.strpos(
               function_row.prosrc,
               'FROM arena.leaderboard_score_input_manifests AS stored'
             ) > 0
    )
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class AS relation_row
       WHERE relation_row.oid =
             'arena.leaderboard_acquisition_attempt_states'::pg_catalog.regclass
         AND relation_row.relkind = 'v'
         AND 'security_invoker=true' = ANY (relation_row.reloptions)
         AND pg_catalog.strpos(
               pg_catalog.pg_get_viewdef(relation_row.oid, true),
               'leaderboard_acquisition_attempts'
             ) > 0
         AND pg_catalog.strpos(
               pg_catalog.pg_get_viewdef(relation_row.oid, true),
               'leaderboard_acquisition_outcomes'
             ) > 0
    )
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class AS relation_row
       WHERE relation_row.oid =
             'arena.latest_terminal_leaderboard_acquisitions'::pg_catalog.regclass
         AND relation_row.relkind = 'v'
         AND 'security_invoker=true' = ANY (relation_row.reloptions)
         AND pg_catalog.strpos(
               pg_catalog.pg_get_viewdef(relation_row.oid, true),
               'leaderboard_acquisition_attempt_states'
             ) > 0
         AND pg_catalog.strpos(
               pg_catalog.pg_get_viewdef(relation_row.oid, true),
               'attempt_seq DESC'
             ) > 0
    )
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid =
             'arena.metric_trust_observations'::pg_catalog.regclass
         AND trigger_row.tgname =
             'metric_trust_observations_source_page_lineage_before_insert'
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         AND trigger_row.tgtype = 7
         AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
               'arena.validate_metric_trust_source_page_lineage()'
             )
    );

  IF NOT v_object_contract THEN
    v_missing := pg_catalog.array_append(v_missing, 'metric_trust_object_contract');
  END IF;

  SELECT pg_catalog.pg_get_viewdef(
           'arena.metric_rankable_observations'::pg_catalog.regclass,
           true
         )
    INTO STRICT v_view_definition;

  v_source_page_lineage_column := EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute_row
     WHERE attribute_row.attrelid =
           'arena.metric_trust_observations'::pg_catalog.regclass
       AND attribute_row.attname = 'source_page_ordinal'
       AND attribute_row.atttypid = 'integer'::pg_catalog.regtype
       AND NOT attribute_row.attnotnull
       AND NOT attribute_row.atthasdef
       AND attribute_row.attnum > 0
       AND NOT attribute_row.attisdropped
  ) AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid =
           'arena.metric_trust_observations'::pg_catalog.regclass
       AND constraint_row.conname =
           'metric_trust_observations_source_page_ordinal_positive'
       AND constraint_row.contype = 'c'
       AND constraint_row.convalidated
       AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) =
           'CHECK (source_page_ordinal IS NULL OR source_page_ordinal > 0)'
  ) AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid =
           'arena.metric_trust_observations'::pg_catalog.regclass
       AND constraint_row.conname =
           'metric_trust_observations_complete_window_source_page_ordinal'
       AND constraint_row.contype = 'c'
       AND NOT constraint_row.convalidated
       AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) =
           'CHECK (quality <> ''complete''::text OR window_state <> ''verified''::text OR source_page_ordinal IS NOT NULL) NOT VALID'
  ) AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid =
           'arena.metric_trust_observations'::pg_catalog.regclass
       AND constraint_row.conname =
           'metric_trust_observations_verified_source_page_lineage'
       AND constraint_row.contype = 'c'
       AND pg_catalog.strpos(
             pg_catalog.pg_get_constraintdef(constraint_row.oid, true),
             'freshness_state = ''verified''::text'
           ) > 0
       AND pg_catalog.strpos(
             pg_catalog.pg_get_constraintdef(constraint_row.oid, true),
             'source_page_ordinal IS NOT NULL'
           ) > 0
  ) AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation_row
     WHERE relation_row.oid =
           'arena.metric_rankable_observations'::pg_catalog.regclass
       AND relation_row.relkind = 'v'
       AND relation_row.relowner = v_postgres
       AND 'security_invoker=true' = ANY (relation_row.reloptions)
  ) AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function_row
     WHERE function_row.oid = pg_catalog.to_regprocedure(
             'arena.validate_metric_trust_source_page_lineage()'
           )
       AND function_row.proowner = v_postgres
       AND function_row.prosecdef
       AND function_row.provolatile = 'v'
       AND function_row.prorettype = 'trigger'::pg_catalog.regtype
       AND function_row.proconfig @> ARRAY[
             'search_path=pg_catalog, pg_temp'
           ]::text[]
       AND pg_catalog.strpos(
             function_row.prosrc,
             'parserSourcePageOrdinals'
           ) > 0
       AND pg_catalog.strpos(
             function_row.prosrc,
             'v_actual_ordinal <= v_previous_ordinal'
           ) > 0
       AND pg_catalog.strpos(
             function_row.prosrc,
             'v_actual_ordinal = NEW.source_page_ordinal'
           ) > 0
       AND pg_catalog.strpos(
             function_row.prosrc,
             'v_page_count <> v_terminal_page_count'
           ) > 0
  ) AND EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
     WHERE trigger_row.tgrelid =
           'arena.metric_trust_observations'::pg_catalog.regclass
       AND trigger_row.tgname =
           'metric_trust_observations_source_page_lineage_before_insert'
       AND NOT trigger_row.tgisinternal
       AND trigger_row.tgenabled = 'O'
       AND trigger_row.tgtype = 7
       AND trigger_row.tgattr = ''::pg_catalog.int2vector
       AND trigger_row.tgqual IS NULL
       AND trigger_row.tgconstraint = 0
       AND NOT trigger_row.tgdeferrable
       AND NOT trigger_row.tginitdeferred
       AND trigger_row.tgnargs = 0
       AND pg_catalog.octet_length(trigger_row.tgargs) = 0
       AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
             'arena.validate_metric_trust_source_page_lineage()'
           )
  ) AND pg_catalog.strpos(
    v_view_definition,
    'observation.source_page_ordinal IS NOT NULL'
  ) > 0 AND pg_catalog.strpos(
    v_view_definition,
    'observation.source_page_ordinal > 0'
  ) > 0 AND pg_catalog.strpos(
    v_view_definition,
    'observation.source_page_ordinal <= terminal.source_page_count'
  ) > 0 AND pg_catalog.strpos(
    v_view_definition,
    'parserSourcePageOrdinals'
  ) > 0 AND pg_catalog.strpos(
    v_view_definition,
    'parser_lineage.observation_ordinal_is_member IS TRUE'
  ) > 0;

  IF NOT v_source_page_lineage_column THEN
    v_missing := pg_catalog.array_append(v_missing, 'source_page_lineage_contract');
  END IF;

  v_acl_contract :=
    v_rpc_oid IS NOT NULL
    AND v_postgres IS NOT NULL
    AND v_service_role IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_roles AS role_row
       WHERE role_row.oid = v_service_role
         AND role_row.rolbypassrls
    )
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = v_rpc_oid
         AND function_row.proowner = v_postgres
         AND function_row.prosecdef
         AND function_row.provolatile = 's'
         AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
         AND function_row.proconfig @> ARRAY[
               'search_path=pg_catalog, pg_temp',
               'statement_timeout=30s'
             ]::text[]
         AND pg_catalog.strpos(
               function_row.prosrc,
               'arena.metric-trust-release-readiness@2'
             ) > 0
         AND pg_catalog.strpos(
               function_row.prosrc,
               'metric_trust_source_page_lineage_forward_repair'
             ) > 0
         AND pg_catalog.strpos(
               function_row.prosrc,
               'v_legacy_complete_verified_count'
             ) > 0
    )
    AND pg_catalog.has_schema_privilege(v_service_role, 'public', 'USAGE')
    AND pg_catalog.has_schema_privilege(v_service_role, 'arena', 'USAGE')
    AND pg_catalog.has_function_privilege(
          v_service_role,
          v_rpc_oid,
          'EXECUTE'
        )
    AND NOT pg_catalog.has_function_privilege(
          'anon',
          v_rpc_oid,
          'EXECUTE'
        )
    AND NOT pg_catalog.has_function_privilege(
          'authenticated',
          v_rpc_oid,
          'EXECUTE'
        )
    AND NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS function_row
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            function_row.proacl,
            pg_catalog.acldefault('f', function_row.proowner)
          )
        ) AS privilege_row
       WHERE function_row.oid = v_rpc_oid
         AND privilege_row.privilege_type = 'EXECUTE'
         AND privilege_row.grantee NOT IN (function_row.proowner, v_service_role)
    )
    AND pg_catalog.has_table_privilege(
          v_service_role,
          'arena.metric_rankable_observations',
          'SELECT'
        )
    AND pg_catalog.has_table_privilege(
          v_service_role,
          'arena.metric_source_contracts',
          'SELECT'
        )
    AND pg_catalog.has_table_privilege(
          v_service_role,
          'arena.metric_trust_observations',
          'SELECT'
        )
    AND pg_catalog.has_table_privilege(
          v_service_role,
          'arena.metric_trust_runs',
          'SELECT'
        )
    AND pg_catalog.has_table_privilege(
          v_service_role,
          'arena.metric_trust_artifacts',
          'SELECT'
        )
    AND pg_catalog.has_table_privilege(
          v_service_role,
          'arena.sources',
          'SELECT'
        )
    AND pg_catalog.has_table_privilege(
          v_service_role,
          'arena.traders',
          'SELECT'
        )
    AND pg_catalog.has_table_privilege(
          v_service_role,
          'arena.leaderboard_snapshots',
          'SELECT'
        )
    AND pg_catalog.has_table_privilege(
          v_service_role,
          'arena.raw_objects',
          'SELECT'
        )
    AND pg_catalog.has_table_privilege(
          v_service_role,
          'arena.latest_terminal_leaderboard_acquisitions',
          'SELECT'
        )
    AND pg_catalog.has_table_privilege(
          v_service_role,
          'arena.leaderboard_acquisition_attempt_states',
          'SELECT'
        )
    AND pg_catalog.has_table_privilege(
          v_service_role,
          'arena.leaderboard_acquisition_attempts',
          'SELECT'
        )
    AND pg_catalog.has_table_privilege(
          v_service_role,
          'arena.leaderboard_acquisition_outcomes',
          'SELECT'
        )
    AND NOT pg_catalog.has_table_privilege(
          'anon',
          'arena.metric_rankable_observations',
          'SELECT'
        )
    AND NOT pg_catalog.has_table_privilege(
          'authenticated',
          'arena.metric_rankable_observations',
          'SELECT'
        )
    AND NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class AS relation_row
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            relation_row.relacl,
            pg_catalog.acldefault('r', relation_row.relowner)
          )
        ) AS privilege_row
       WHERE relation_row.oid =
             'arena.metric_rankable_observations'::pg_catalog.regclass
         AND privilege_row.privilege_type = 'SELECT'
         AND privilege_row.grantee NOT IN (relation_row.relowner, v_service_role)
    )
    AND NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS function_row
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            function_row.proacl,
            pg_catalog.acldefault('f', function_row.proowner)
          )
        ) AS privilege_row
       WHERE function_row.oid IN (
               'arena.serialize_leaderboard_terminal_publication()'::pg_catalog.regprocedure,
               'arena.lock_leaderboard_acquisition_source_window(integer,integer)'::pg_catalog.regprocedure,
               'arena.validate_metric_trust_attempt_outcome_authority()'::pg_catalog.regprocedure,
               'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'::pg_catalog.regprocedure,
               'arena.seal_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)'::pg_catalog.regprocedure,
               'arena.verify_leaderboard_score_input_manifest_v1(uuid)'::pg_catalog.regprocedure,
               'arena.validate_metric_trust_source_page_lineage()'::pg_catalog.regprocedure
             )
         AND privilege_row.privilege_type = 'EXECUTE'
         AND privilege_row.grantee <> function_row.proowner
    )
    AND EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class AS relation_row
       WHERE relation_row.oid = 'arena.raw_object_gc_queue'::pg_catalog.regclass
         AND relation_row.relrowsecurity
    )
    AND pg_catalog.has_table_privilege(
          v_service_role,
          'arena.raw_object_gc_queue',
          'SELECT'
        )
    AND pg_catalog.has_table_privilege(
          v_service_role,
          'arena.raw_object_gc_queue',
          'DELETE'
        )
    AND NOT pg_catalog.has_table_privilege(
          v_service_role,
          'arena.raw_object_gc_queue',
          'INSERT'
        )
    AND NOT pg_catalog.has_table_privilege(
          v_service_role,
          'arena.raw_object_gc_queue',
          'UPDATE'
        )
    AND NOT pg_catalog.has_table_privilege(
          'anon',
          'arena.raw_object_gc_queue',
          'SELECT'
        )
    AND NOT pg_catalog.has_table_privilege(
          'anon',
          'arena.raw_object_gc_queue',
          'INSERT'
        )
    AND NOT pg_catalog.has_table_privilege(
          'anon',
          'arena.raw_object_gc_queue',
          'UPDATE'
        )
    AND NOT pg_catalog.has_table_privilege(
          'anon',
          'arena.raw_object_gc_queue',
          'DELETE'
        )
    AND NOT pg_catalog.has_table_privilege(
          'authenticated',
          'arena.raw_object_gc_queue',
          'SELECT'
        )
    AND NOT pg_catalog.has_table_privilege(
          'authenticated',
          'arena.raw_object_gc_queue',
          'INSERT'
        )
    AND NOT pg_catalog.has_table_privilege(
          'authenticated',
          'arena.raw_object_gc_queue',
          'UPDATE'
        )
    AND NOT pg_catalog.has_table_privilege(
          'authenticated',
          'arena.raw_object_gc_queue',
          'DELETE'
        )
    AND NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_class AS relation_row
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            relation_row.relacl,
            pg_catalog.acldefault('r', relation_row.relowner)
          )
        ) AS privilege_row
       WHERE relation_row.oid = 'arena.raw_object_gc_queue'::pg_catalog.regclass
         AND privilege_row.grantee NOT IN (relation_row.relowner, v_service_role)
        );

  IF NOT v_acl_contract THEN
    v_missing := pg_catalog.array_append(v_missing, 'metric_trust_acl_contract');
  END IF;

  -- This outward field keeps its compatibility name, but @2 counts every
  -- otherwise complete/verified row whose immutable source-page lineage is
  -- not trustworthy. That includes legacy NULL ordinals, malformed parser
  -- metadata, non-members, and v3 rows that disagree with the exact terminal.
  SELECT pg_catalog.count(*)
    INTO STRICT v_legacy_complete_verified_count
    FROM arena.metric_trust_observations AS observation
    JOIN arena.metric_trust_runs AS acquisition
      ON acquisition.source_run_id = observation.source_run_id
     AND acquisition.source_id = observation.source_id
     AND acquisition.timeframe = observation.timeframe
     AND acquisition.snapshot_id = observation.snapshot_id
     AND acquisition.snapshot_scraped_at = observation.snapshot_scraped_at
    JOIN arena.raw_objects AS population_raw
      ON population_raw.id = acquisition.population_raw_object_id
    JOIN arena.raw_objects AS manifest_raw
      ON manifest_raw.id = acquisition.manifest_raw_object_id
    CROSS JOIN LATERAL (
      SELECT
        CASE
          WHEN lineage_text.page_count_text ~ '^[1-9][0-9]{0,9}$' THEN
            CASE
              WHEN lineage_text.page_count_text::numeric <= 2147483647::numeric
              THEN lineage_text.page_count_text::integer
              ELSE NULL
            END
          ELSE NULL
        END AS page_count,
        CASE
          WHEN lineage_text.parser_page_count_text ~ '^[1-9][0-9]{0,9}$' THEN
            CASE
              WHEN lineage_text.parser_page_count_text::numeric <= 2147483647::numeric
              THEN lineage_text.parser_page_count_text::integer
              ELSE NULL
            END
          ELSE NULL
        END AS parser_page_count,
        pg_catalog.jsonb_typeof(
          population_raw.meta->'parserSourcePageOrdinals'
        ) = 'array' AS parser_ordinals_are_array,
        CASE
          WHEN pg_catalog.jsonb_typeof(
                 population_raw.meta->'parserSourcePageOrdinals'
               ) = 'array'
          THEN population_raw.meta->'parserSourcePageOrdinals'
          ELSE '[]'::jsonb
        END AS parser_source_page_ordinals
      FROM (
        SELECT
          population_raw.meta->>'pageCount' AS page_count_text,
          population_raw.meta->>'parserPageCount' AS parser_page_count_text
      ) AS lineage_text
    ) AS source_lineage
    CROSS JOIN LATERAL (
      SELECT
        pg_catalog.count(*)::integer AS ordinal_count,
        COALESCE(
          pg_catalog.bool_and(ordered.ordinal_value IS NOT NULL),
          false
        ) AS ordinals_are_canonical,
        COALESCE(
          pg_catalog.bool_and(
            ordered.ordinal_value IS NOT NULL
            AND ordered.ordinal_value <= source_lineage.page_count
          ),
          false
        ) AS ordinals_are_in_range,
        COALESCE(
          pg_catalog.bool_and(
            ordered.previous_ordinal IS NULL
            OR ordered.ordinal_value > ordered.previous_ordinal
          ),
          false
        ) AS ordinals_are_strictly_increasing,
        COALESCE(
          pg_catalog.bool_or(
            ordered.ordinal_value = observation.source_page_ordinal
          ),
          false
        ) AS observation_ordinal_is_member
      FROM (
        SELECT
          canonical.ordinal_value,
          pg_catalog.lag(canonical.ordinal_value) OVER (
            ORDER BY canonical.ordinality
          ) AS previous_ordinal
        FROM (
          SELECT
            item.ordinality,
            CASE
              WHEN pg_catalog.jsonb_typeof(item.value) = 'number'
                   AND item.value #>> '{}' ~ '^[1-9][0-9]{0,9}$' THEN
                CASE
                  WHEN (item.value #>> '{}')::numeric <= 2147483647::numeric
                  THEN (item.value #>> '{}')::integer
                  ELSE NULL
                END
              ELSE NULL
            END AS ordinal_value
          FROM pg_catalog.jsonb_array_elements(
                 source_lineage.parser_source_page_ordinals
               ) WITH ORDINALITY AS item(value, ordinality)
        ) AS canonical
      ) AS ordered
    ) AS parser_lineage
   WHERE observation.quality = 'complete'
     AND observation.population_state = 'verified'
     AND observation.window_state = 'verified'
     AND observation.unit_state = 'verified'
     AND observation.freshness_state = 'verified'
     AND observation.blocking_reasons = '[]'::jsonb
     AND NOT population_raw.quarantined
     AND NOT manifest_raw.quarantined
     AND NOT COALESCE(
       population_raw.source_id = observation.source_id
       AND population_raw.timeframe = observation.timeframe
       AND population_raw.source_run_id = observation.source_run_id
       AND population_raw.trust_artifact_role = 'source_payload'
       AND population_raw.content_hash ~ '^[0-9a-f]{64}$'
       AND population_raw.meta->'raw_integrity'->>'hash_algorithm' = 'sha256'
       AND population_raw.meta->'raw_integrity'->>'hash_scope' = 'json_utf8'
       AND manifest_raw.source_id = observation.source_id
       AND manifest_raw.timeframe = observation.timeframe
       AND manifest_raw.source_run_id = observation.source_run_id
       AND manifest_raw.trust_artifact_role = 'population_manifest'
       AND manifest_raw.content_hash = observation.source_run_id
       AND manifest_raw.meta->'raw_integrity'->>'hash_algorithm' = 'sha256'
       AND manifest_raw.meta->'raw_integrity'->>'hash_scope' = 'json_utf8'
       AND observation.source_page_ordinal IS NOT NULL
       AND observation.source_page_ordinal > 0
       AND source_lineage.page_count IS NOT NULL
       AND source_lineage.parser_page_count IS NOT NULL
       AND source_lineage.parser_ordinals_are_array IS TRUE
       AND source_lineage.parser_page_count <= source_lineage.page_count
       AND parser_lineage.ordinal_count = source_lineage.parser_page_count
       AND parser_lineage.ordinals_are_canonical IS TRUE
       AND parser_lineage.ordinals_are_in_range IS TRUE
       AND parser_lineage.ordinals_are_strictly_increasing IS TRUE
       AND parser_lineage.observation_ordinal_is_member IS TRUE
       AND CASE manifest_raw.meta->>'data_contract'
         WHEN 'arena.ingest.leaderboard-acquisition-manifest@2' THEN true
         WHEN 'arena.ingest.leaderboard-acquisition-manifest@3' THEN EXISTS (
           SELECT 1
             FROM arena.leaderboard_acquisition_attempt_states AS terminal
            WHERE terminal.source_id = acquisition.source_id
              AND terminal.timeframe = acquisition.timeframe
              AND terminal.source_status = 'active'
              AND terminal.source_serving_mode = 'serving'
              AND terminal.worker_region IS NOT NULL
              AND terminal.worker_region = terminal.source_fetch_region
              AND terminal.capture_contract =
                  manifest_raw.meta->>'data_contract'
              AND terminal.attempt_binding_contract =
                  'arena.ingest.leaderboard-acquisition-attempt-binding@1'
              AND terminal.attempt_binding_contract =
                  manifest_raw.meta->'acquisition_attempt'->>'binding_contract'
              AND terminal.attempt_id::text =
                  manifest_raw.meta->'acquisition_attempt'->>'attempt_id'
              AND terminal.attempt_seq::text =
                  manifest_raw.meta->'acquisition_attempt'->>'attempt_seq'
              AND terminal.observation_cycle_id IS NOT DISTINCT FROM
                  manifest_raw.meta->>'observation_cycle_id'
              AND terminal.runner_git_sha IS NOT NULL
              AND terminal.runner_git_sha IS NOT DISTINCT FROM
                  manifest_raw.meta->'acquisition_attempt'->>'runner_git_sha'
              AND terminal.recorded_started_at = acquisition.started_at
              AND terminal.terminal_state = 'complete'
              AND terminal.acquisition_state = 'complete'
              AND terminal.acquisition_state = acquisition.acquisition_state
              AND terminal.population_state = 'verified'
              AND terminal.population_state = acquisition.population_state
              AND terminal.capture_evidence_state = 'verified'
              AND terminal.termination_reason IS NOT NULL
              AND terminal.capture_started_at = acquisition.started_at
              AND terminal.capture_completed_at = acquisition.completed_at
              AND terminal.source_run_id = acquisition.source_run_id
              AND terminal.source_payload_raw_object_id =
                  acquisition.population_raw_object_id
              AND terminal.source_payload_content_hash =
                  population_raw.content_hash
              AND terminal.source_payload_storage_path =
                  population_raw.storage_path
              AND terminal.manifest_raw_object_id =
                  acquisition.manifest_raw_object_id
              AND terminal.manifest_content_hash = manifest_raw.content_hash
              AND terminal.manifest_storage_path = manifest_raw.storage_path
              AND terminal.diagnostic_raw_object_id IS NULL
              AND terminal.diagnostic_content_hash IS NULL
              AND terminal.diagnostic_storage_path IS NULL
              AND terminal.reported_population IS NOT DISTINCT FROM
                  acquisition.reported_population
              AND terminal.population_report_state = 'consistent'
              AND terminal.source_page_count IS NOT NULL
              AND terminal.source_page_count > 0
              AND observation.source_page_ordinal <= terminal.source_page_count
              AND source_lineage.page_count = terminal.source_page_count
              AND source_lineage.parser_page_count <= terminal.source_page_count
              AND terminal.observed_population = acquisition.fetched_population
              AND terminal.accepted_population = acquisition.fetched_population
              AND terminal.rejected_row_count = 0
              AND terminal.deduplicated_row_count = 0
              AND NOT terminal.caller_limited
              AND terminal.caller_limited = acquisition.caller_limited
              AND NOT terminal.safety_limited
              AND terminal.failure_stage IS NULL
              AND terminal.reason_code IS NULL
         )
         ELSE false
       END,
       false
     );

  SELECT COALESCE(
           pg_catalog.array_agg(item ORDER BY item),
           ARRAY[]::text[]
         )
    INTO STRICT v_missing
    FROM (
      SELECT DISTINCT pg_catalog.unnest(v_missing) AS item
    ) AS unique_missing;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'arena.metric-trust-release-readiness@2',
    'ready', pg_catalog.cardinality(v_missing) = 0
             AND v_legacy_complete_verified_count = 0,
    'missing', pg_catalog.to_jsonb(v_missing),
    'legacy_complete_verified_count', v_legacy_complete_verified_count,
    'release_migration_sha256', v_release_migration_sha256,
    'source_page_lineage_column', v_source_page_lineage_column
  );
END
$function$;

DO $postflight$
DECLARE
  v_rpc oid := pg_catalog.to_regprocedure(
    'public.arena_metric_trust_release_readiness()'
  );
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS function_row
     WHERE function_row.oid = v_rpc
       AND function_row.proowner = pg_catalog.to_regrole('postgres')
       AND function_row.prosecdef
       AND function_row.provolatile = 's'
       AND function_row.proconfig @> ARRAY[
             'search_path=pg_catalog, pg_temp',
             'statement_timeout=30s'
           ]::text[]
       AND pg_catalog.strpos(
             function_row.prosrc,
             'pg_catalog.strpos(function_row.prosrc, ''jsonb_path_query_array'') > 0'
           ) = 0
       AND pg_catalog.strpos(
             function_row.prosrc,
             'leaderboard score-input PnL must be a finite JSON number'
           ) > 0
       AND pg_catalog.strpos(
             function_row.prosrc,
             'arena.metric-trust-release-readiness@2'
           ) > 0
  ) THEN
    RAISE EXCEPTION 'readiness RPC forward repair did not take effect';
  END IF;
  IF pg_catalog.has_function_privilege(
       'anon', 'public.arena_metric_trust_release_readiness()', 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', 'public.arena_metric_trust_release_readiness()', 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role', 'public.arena_metric_trust_release_readiness()', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'readiness RPC privileges changed unexpectedly';
  END IF;
END
$postflight$;

COMMIT;
