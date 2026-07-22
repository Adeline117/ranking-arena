-- Migration: 20260722054000_metric_trust_source_page_lineage.sql
-- Description: Persist the exact source-page ordinal for every observation
-- whose page lineage is verified. Existing append-only observations are never
-- guessed or rewritten. Environments with legacy freshness-verified rows must
-- land a separately reviewed forward quarantine before this migration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_postgres pg_catalog.oid := pg_catalog.to_regrole('postgres');
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'metric-trust source-page lineage requires PostgreSQL 17';
  END IF;

  -- Supabase MCP apply_migration assigns its own server-side version. Bind the
  -- prerequisite to the unique reviewed name and exact immutable SQL bytes,
  -- never to a local filename timestamp or channel-specific created_by value.
  IF (
       SELECT pg_catalog.count(*)
       FROM supabase_migrations.schema_migrations AS ledger
       WHERE ledger.name = 'leaderboard_score_input_manifest_rank_eligible_pnl'
     ) <> 1 THEN
    RAISE EXCEPTION 'source-page lineage requires one immutable 052 ledger body';
  END IF;

  PERFORM 1
  FROM supabase_migrations.schema_migrations AS ledger
  WHERE ledger.name = 'leaderboard_score_input_manifest_rank_eligible_pnl'
    AND pg_catalog.array_length(ledger.statements, 1) = 1
    AND pg_catalog.encode(
          extensions.digest(ledger.statements[1], 'sha256'),
          'hex'
        ) = '34d1af48d66a4b3cedcee548e3438ba81fa9cc3fdca7a00f308d7f768f30150e'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source-page lineage requires exact immutable 20260722052000 ledger';
  END IF;

  IF (
       SELECT pg_catalog.count(*)
       FROM supabase_migrations.schema_migrations AS ledger
       WHERE ledger.name = 'binance_spot_metric_source_contract'
     ) <> 1 THEN
    RAISE EXCEPTION 'source-page lineage requires one immutable 053 ledger body';
  END IF;

  PERFORM 1
  FROM supabase_migrations.schema_migrations AS ledger
  WHERE ledger.name = 'binance_spot_metric_source_contract'
    AND pg_catalog.array_length(ledger.statements, 1) = 1
    AND pg_catalog.encode(
          extensions.digest(ledger.statements[1], 'sha256'),
          'hex'
        ) = '1f4ce27a0a44cfc6f9c1d11c113dc2db7aa5eed170ef3b38b1469c0a1c758abc'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'source-page lineage requires exact immutable 20260722053000 ledger';
  END IF;

  IF pg_catalog.to_regclass('arena.metric_trust_observations') IS NULL
     OR pg_catalog.to_regclass('arena.metric_trust_runs') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass('arena.metric_rankable_observations') IS NULL
     OR pg_catalog.to_regclass('arena.raw_object_gc_queue') IS NULL
     OR pg_catalog.to_regclass('arena.uidx_raw_population_manifest_per_run') IS NULL
     OR pg_catalog.to_regclass('arena.uidx_raw_tier_a_population_per_run') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_attempts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_outcomes') IS NULL
     OR pg_catalog.to_regclass('arena.latest_terminal_leaderboard_acquisitions') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_score_input_manifests') IS NULL THEN
    RAISE EXCEPTION 'metric-trust source-page lineage foundations are missing';
  END IF;

  IF v_postgres IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'metric-trust source-page lineage roles are missing';
  END IF;

  IF pg_catalog.to_regprocedure(
       'arena.validate_metric_trust_attempt_outcome_authority()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.serialize_leaderboard_terminal_publication()'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.verify_leaderboard_score_input_manifest_v1(uuid)'
        ) IS NULL THEN
    RAISE EXCEPTION 'metric-trust source-page lineage authorities are missing';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid =
             'arena.metric_trust_observations'::pg_catalog.regclass
         AND attribute.attname = 'source_page_ordinal'
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
     )
     OR pg_catalog.to_regprocedure(
          'arena.validate_metric_trust_source_page_lineage()'
        ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
          'public.arena_metric_trust_release_readiness()'
        ) IS NOT NULL
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid =
             'arena.metric_trust_observations'::pg_catalog.regclass
         AND trigger_row.tgname =
             'metric_trust_observations_source_page_lineage_before_insert'
         AND NOT trigger_row.tgisinternal
     ) THEN
    RAISE EXCEPTION 'metric-trust source-page lineage objects already exist without ledger';
  END IF;
END
$preflight$;

-- Prevent an old writer from slipping an unbound verified row between the
-- catalog preflight and the new constraint/trigger installation.
LOCK TABLE arena.metric_trust_observations IN SHARE ROW EXCLUSIVE MODE;

DO $legacy_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM arena.metric_trust_observations AS observation
    WHERE observation.freshness_state = 'verified'
  ) THEN
    RAISE EXCEPTION 'legacy verified observations require a reviewed forward quarantine before source-page lineage';
  END IF;
END
$legacy_preflight$;

ALTER TABLE arena.metric_trust_observations
  ADD COLUMN source_page_ordinal integer;

ALTER TABLE arena.metric_trust_observations
  ADD CONSTRAINT metric_trust_observations_source_page_ordinal_positive
  CHECK (source_page_ordinal IS NULL OR source_page_ordinal > 0) NOT VALID;

ALTER TABLE arena.metric_trust_observations
  VALIDATE CONSTRAINT metric_trust_observations_source_page_ordinal_positive;

ALTER TABLE arena.metric_trust_observations
  ADD CONSTRAINT metric_trust_observations_verified_source_page_lineage
  CHECK (
    (freshness_state = 'verified') = (source_page_ordinal IS NOT NULL)
  ) NOT VALID;

ALTER TABLE arena.metric_trust_observations
  VALIDATE CONSTRAINT metric_trust_observations_verified_source_page_lineage;

CREATE FUNCTION arena.validate_metric_trust_source_page_lineage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_page_count_text text;
  v_page_count numeric;
  v_parser_page_count_text text;
  v_parser_page_count numeric;
  v_parser_source_page_ordinals jsonb;
BEGIN
  IF NEW.source_page_ordinal IS NULL THEN
    IF NEW.freshness_state = 'verified' THEN
      -- Keep the migration compatible with an already-running pre-lineage
      -- publisher. An omitted ordinal can never stay verified, but the old
      -- writer may finish safely while the exact-main writer is promoted.
      NEW.freshness_state := 'unknown';
      NEW.quality := 'unknown';
      IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(
          COALESCE(NEW.blocking_reasons, '[]'::jsonb)
        ) AS reason(value)
        WHERE reason.value->>'code' = 'source_page_lineage_missing'
      ) THEN
        NEW.blocking_reasons :=
          COALESCE(NEW.blocking_reasons, '[]'::jsonb) ||
          pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'code', 'source_page_lineage_missing',
              'state', 'unknown'
            )
          );
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.source_page_ordinal <= 0
     OR NEW.freshness_state IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION 'source-page ordinal requires verified freshness and a positive ordinal'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    population.meta->>'pageCount',
    population.meta->>'parserPageCount',
    population.meta->'parserSourcePageOrdinals'
    INTO STRICT
      v_page_count_text,
      v_parser_page_count_text,
      v_parser_source_page_ordinals
    FROM arena.metric_trust_runs AS run
    JOIN arena.raw_objects AS population
      ON population.id = run.population_raw_object_id
   WHERE run.source_run_id = NEW.source_run_id
     AND run.source_id = NEW.source_id
     AND run.timeframe = NEW.timeframe
     AND run.snapshot_id = NEW.snapshot_id
     AND population.source_id = NEW.source_id
     AND population.timeframe = NEW.timeframe
     AND population.source_run_id = NEW.source_run_id
     AND population.trust_artifact_role = 'source_payload'
     AND NOT population.quarantined;

  IF v_page_count_text IS NULL
     OR v_page_count_text !~ '^[1-9][0-9]*$'
     OR pg_catalog.length(v_page_count_text) > 10
     OR v_parser_page_count_text IS NULL
     OR v_parser_page_count_text !~ '^[1-9][0-9]*$'
     OR pg_catalog.length(v_parser_page_count_text) > 10
     OR pg_catalog.jsonb_typeof(v_parser_source_page_ordinals) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'source payload has no canonical parser page-lineage bounds'
      USING ERRCODE = '23514';
  END IF;

  v_page_count := v_page_count_text::numeric;
  v_parser_page_count := v_parser_page_count_text::numeric;
  IF v_page_count > 2147483647
     OR v_parser_page_count > 2147483647
     OR v_parser_page_count IS DISTINCT FROM
        pg_catalog.jsonb_array_length(v_parser_source_page_ordinals)::numeric
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements(v_parser_source_page_ordinals)
         AS parser_ordinal(value)
       WHERE pg_catalog.jsonb_typeof(parser_ordinal.value) IS DISTINCT FROM 'number'
          OR parser_ordinal.value::text !~ '^[1-9][0-9]*$'
          OR pg_catalog.length(parser_ordinal.value::text) > 10
     ) THEN
    RAISE EXCEPTION 'source payload parser page-lineage bounds are malformed'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
       SELECT 1
       FROM (
         SELECT
           parser_ordinal.value::text::numeric AS ordinal,
           pg_catalog.lag(parser_ordinal.value::text::numeric) OVER (
             ORDER BY parser_ordinal.position
           ) AS previous_ordinal
         FROM pg_catalog.jsonb_array_elements(v_parser_source_page_ordinals)
           WITH ORDINALITY AS parser_ordinal(value, position)
       ) AS ordered_ordinal
       WHERE ordered_ordinal.ordinal > v_page_count
          OR (
            ordered_ordinal.previous_ordinal IS NOT NULL
            AND ordered_ordinal.ordinal <= ordered_ordinal.previous_ordinal
          )
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements(v_parser_source_page_ordinals)
         AS parser_ordinal(value)
       WHERE parser_ordinal.value::text::numeric = NEW.source_page_ordinal::numeric
     ) THEN
    RAISE EXCEPTION 'source-page ordinal is not present in immutable parser source-page lineage'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
EXCEPTION
  WHEN NO_DATA_FOUND THEN
    RAISE EXCEPTION 'source-page ordinal has no exact immutable source payload'
      USING ERRCODE = '23503';
  WHEN TOO_MANY_ROWS THEN
    RAISE EXCEPTION 'source-page ordinal source payload identity is ambiguous'
      USING ERRCODE = '23514';
END
$function$;

ALTER FUNCTION arena.validate_metric_trust_source_page_lineage()
  OWNER TO postgres;

CREATE TRIGGER metric_trust_observations_source_page_lineage_before_insert
BEFORE INSERT ON arena.metric_trust_observations
FOR EACH ROW EXECUTE FUNCTION arena.validate_metric_trust_source_page_lineage();

REVOKE ALL ON FUNCTION arena.validate_metric_trust_source_page_lineage()
  FROM PUBLIC, anon, authenticated, service_role;

-- Hostile default privileges may expose a trigger helper to future roles.
DO $owner_only_lineage_acl$
DECLARE
  v_role record;
BEGIN
  FOR v_role IN
    SELECT DISTINCT pg_catalog.pg_get_userbyid(privilege_row.grantee) AS role_name
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS privilege_row
    WHERE function_row.oid = pg_catalog.to_regprocedure(
            'arena.validate_metric_trust_source_page_lineage()'
          )
      AND privilege_row.privilege_type = 'EXECUTE'
      AND privilege_row.grantee NOT IN (0, function_row.proowner)
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION arena.validate_metric_trust_source_page_lineage() FROM %I',
      v_role.role_name
    );
  END LOOP;
END
$owner_only_lineage_acl$;

CREATE FUNCTION public.arena_metric_trust_release_readiness()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_relation text;
  v_signature text;
  v_lineage_column boolean := false;
  v_legacy_complete integer := 0;
  v_actual_hash text;
  v_ledger record;
  v_postgres pg_catalog.oid := pg_catalog.to_regrole('postgres');
  v_service_role pg_catalog.oid := pg_catalog.to_regrole('service_role');
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'arena.metric_trust_observations',
    'arena.metric_trust_runs',
    'arena.metric_rankable_observations',
    'arena.raw_objects',
    'arena.raw_object_gc_queue',
    'arena.uidx_raw_population_manifest_per_run',
    'arena.uidx_raw_tier_a_population_per_run',
    'arena.leaderboard_acquisition_attempts',
    'arena.leaderboard_acquisition_outcomes',
    'arena.latest_terminal_leaderboard_acquisitions',
    'arena.leaderboard_score_input_manifests'
  ]
  LOOP
    IF pg_catalog.to_regclass(v_relation) IS NULL THEN
      v_missing := pg_catalog.array_append(v_missing, v_relation);
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'arena.validate_metric_trust_attempt_outcome_authority()',
    'arena.serialize_leaderboard_terminal_publication()',
    'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)',
    'arena.seal_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamp with time zone)',
    'arena.verify_leaderboard_score_input_manifest_v1(uuid)',
    'arena.validate_metric_trust_source_page_lineage()'
  ]
  LOOP
    IF pg_catalog.to_regprocedure(v_signature) IS NULL THEN
      v_missing := pg_catalog.array_append(v_missing, v_signature);
    END IF;
  END LOOP;

  IF pg_catalog.to_regclass('arena.metric_trust_observations') IS NOT NULL THEN
    SELECT (
      pg_catalog.count(*) = 1
      AND pg_catalog.bool_and(
        attribute.atttypid = 'integer'::pg_catalog.regtype
        AND NOT attribute.attnotnull
        AND NOT attribute.atthasdef
      )
    )
    INTO STRICT v_lineage_column
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
          'arena.metric_trust_observations'::pg_catalog.regclass
      AND attribute.attname = 'source_page_ordinal'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;
  END IF;

  IF NOT v_lineage_column THEN
    v_missing := pg_catalog.array_append(
      v_missing,
      'arena.metric_trust_observations.source_page_ordinal'
    );
  END IF;

  IF pg_catalog.to_regclass('arena.metric_trust_observations') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid =
             'arena.metric_trust_observations'::pg_catalog.regclass
         AND constraint_row.conname =
             'metric_trust_observations_source_page_ordinal_positive'
         AND constraint_row.contype = 'c'
         AND constraint_row.convalidated
         AND pg_catalog.pg_get_expr(
               constraint_row.conbin,
               constraint_row.conrelid,
               true
             ) = 'source_page_ordinal IS NULL OR source_page_ordinal > 0'
     ) THEN
    v_missing := pg_catalog.array_append(v_missing, 'source_page_ordinal_positive_check');
  END IF;

  IF pg_catalog.to_regclass('arena.metric_trust_observations') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid =
             'arena.metric_trust_observations'::pg_catalog.regclass
         AND constraint_row.conname =
             'metric_trust_observations_verified_source_page_lineage'
         AND constraint_row.contype = 'c'
         AND constraint_row.convalidated
         AND pg_catalog.pg_get_expr(
               constraint_row.conbin,
               constraint_row.conrelid,
               true
             ) = '(freshness_state = ''verified''::text) = (source_page_ordinal IS NOT NULL)'
     ) THEN
    v_missing := pg_catalog.array_append(v_missing, 'verified_source_page_lineage_check');
  END IF;

  IF pg_catalog.to_regclass('arena.metric_trust_observations') IS NOT NULL
     AND NOT EXISTS (
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
     ) THEN
    v_missing := pg_catalog.array_append(v_missing, 'source_page_lineage_insert_trigger');
  END IF;

  IF pg_catalog.to_regclass('arena.metric_trust_runs') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'arena.metric_trust_runs'::pg_catalog.regclass
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
     ) THEN
    v_missing := pg_catalog.array_append(v_missing, 'metric_trust_attempt_authority_trigger');
  END IF;

  IF NOT EXISTS (
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
         AND pg_catalog.strpos(function_row.prosrc, 'parserPageCount') > 0
         AND pg_catalog.strpos(function_row.prosrc, 'parserSourcePageOrdinals') > 0
         AND pg_catalog.strpos(function_row.prosrc, 'WITH ORDINALITY') > 0
         AND pg_catalog.strpos(function_row.prosrc, 'source_page_lineage_missing') > 0
         AND pg_catalog.strpos(
               function_row.prosrc,
               'NEW.freshness_state := ''unknown'''
             ) > 0
         AND pg_catalog.strpos(function_row.prosrc, 'NEW.quality := ''unknown''') > 0
         AND pg_catalog.strpos(
               function_row.prosrc,
               'NEW.source_page_ordinal::numeric'
             ) > 0
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS privilege_row
       WHERE function_row.oid = pg_catalog.to_regprocedure(
               'arena.validate_metric_trust_source_page_lineage()'
             )
         AND privilege_row.privilege_type = 'EXECUTE'
         AND privilege_row.grantee <> function_row.proowner
     ) THEN
    v_missing := pg_catalog.array_append(v_missing, 'source_page_lineage_function_contract');
  END IF;

  IF NOT EXISTS (
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
               'search_path=pg_catalog, pg_temp'
             ]::text[]
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS privilege_row
       WHERE function_row.oid = pg_catalog.to_regprocedure(
               'arena.validate_metric_trust_attempt_outcome_authority()'
             )
         AND privilege_row.privilege_type = 'EXECUTE'
         AND privilege_row.grantee <> function_row.proowner
     ) THEN
    v_missing := pg_catalog.array_append(v_missing, 'metric_trust_authority_function_contract');
  END IF;

  IF pg_catalog.to_regclass('arena.metric_rankable_observations') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation
       WHERE relation.oid =
             'arena.metric_rankable_observations'::pg_catalog.regclass
         AND relation.relkind = 'v'
         AND relation.reloptions @> ARRAY['security_invoker=true']::text[]
     ) THEN
    v_missing := pg_catalog.array_append(v_missing, 'metric_rankable_security_invoker_view');
  END IF;

  IF pg_catalog.to_regclass('arena.leaderboard_score_input_manifests') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid =
             'arena.leaderboard_score_input_manifests'::pg_catalog.regclass
         AND constraint_row.conname =
             'leaderboard_score_input_manifest_rank_eligible_pnl'
         AND constraint_row.contype = 'c'
         AND constraint_row.convalidated
     ) THEN
    v_missing := pg_catalog.array_append(v_missing, 'rank_eligible_pnl_constraint');
  END IF;

  FOR v_ledger IN
    SELECT *
    FROM (VALUES
      (
        'metric_trust_attempt_outcome_authority'::text,
        '3648ac33324eb99e476eb15dc624b37d6d086ac6eef92c9b34dc8e30399dd92f'::text
      ),
      (
        'leaderboard_score_input_manifest_contract'::text,
        'fdf578522865afc7b81d7f1fedd99e4bf6e007d0460d3ba678babf4414a4829c'::text
      ),
      (
        'leaderboard_score_input_manifest_rank_eligible_pnl'::text,
        '34d1af48d66a4b3cedcee548e3438ba81fa9cc3fdca7a00f308d7f768f30150e'::text
      ),
      (
        'binance_spot_metric_source_contract'::text,
        '1f4ce27a0a44cfc6f9c1d11c113dc2db7aa5eed170ef3b38b1469c0a1c758abc'::text
      )
    ) AS required(name, expected_hash)
  LOOP
    IF (
         SELECT pg_catalog.count(*)
         FROM supabase_migrations.schema_migrations AS ledger
         WHERE ledger.name = v_ledger.name
       ) <> 1
       OR NOT EXISTS (
      SELECT 1
      FROM supabase_migrations.schema_migrations AS ledger
      WHERE ledger.name = v_ledger.name
        AND pg_catalog.array_length(ledger.statements, 1) = 1
        AND pg_catalog.encode(
              extensions.digest(ledger.statements[1], 'sha256'),
              'hex'
            ) = v_ledger.expected_hash
    ) THEN
      v_missing := pg_catalog.array_append(
        v_missing,
        'supabase_migrations.' || v_ledger.name
      );
    END IF;
  END LOOP;

  SELECT
    CASE
      WHEN pg_catalog.array_length(ledger.statements, 1) = 1
      THEN pg_catalog.encode(
             extensions.digest(ledger.statements[1], 'sha256'),
             'hex'
           )
      ELSE NULL
    END
    INTO v_actual_hash
    FROM supabase_migrations.schema_migrations AS ledger
   WHERE ledger.name = 'metric_trust_source_page_lineage';

  IF v_actual_hash IS NULL
     OR (
       SELECT pg_catalog.count(*)
       FROM supabase_migrations.schema_migrations AS ledger
       WHERE ledger.name = 'metric_trust_source_page_lineage'
     ) <> 1 THEN
    v_missing := pg_catalog.array_append(
      v_missing,
      'supabase_migrations.metric_trust_source_page_lineage'
    );
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = pg_catalog.to_regprocedure(
               'public.arena_metric_trust_release_readiness()'
             )
         AND function_row.proowner = v_postgres
         AND function_row.prosecdef
         AND function_row.provolatile = 's'
         AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
         AND function_row.proconfig @> ARRAY[
               'search_path=pg_catalog, pg_temp'
             ]::text[]
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS privilege_row
       WHERE function_row.oid = pg_catalog.to_regprocedure(
               'public.arena_metric_trust_release_readiness()'
             )
         AND privilege_row.privilege_type = 'EXECUTE'
         AND privilege_row.grantee NOT IN (function_row.proowner, v_service_role)
     ) OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.arena_metric_trust_release_readiness()',
       'EXECUTE'
     ) THEN
    v_missing := pg_catalog.array_append(v_missing, 'metric_trust_readiness_function_contract');
  END IF;

  SELECT COALESCE(pg_catalog.array_agg(item ORDER BY item), ARRAY[]::text[])
    INTO STRICT v_missing
    FROM (
      SELECT DISTINCT pg_catalog.unnest(v_missing) AS item
    ) AS unique_missing;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'arena.metric-trust-release-readiness@1',
    'ready', pg_catalog.cardinality(v_missing) = 0
             AND v_lineage_column
             AND v_legacy_complete = 0,
    'missing', v_missing,
    'legacy_complete_verified_count', v_legacy_complete,
    'release_migration_sha256', COALESCE(v_actual_hash, ''),
    'source_page_lineage_column', v_lineage_column
  );
END
$function$;

ALTER FUNCTION public.arena_metric_trust_release_readiness()
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.arena_metric_trust_release_readiness()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_metric_trust_release_readiness()
  TO service_role;

DO $readiness_acl$
DECLARE
  v_role record;
  v_service_role pg_catalog.oid := pg_catalog.to_regrole('service_role');
BEGIN
  FOR v_role IN
    SELECT DISTINCT pg_catalog.pg_get_userbyid(privilege_row.grantee) AS role_name
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS privilege_row
    WHERE function_row.oid = pg_catalog.to_regprocedure(
            'public.arena_metric_trust_release_readiness()'
          )
      AND privilege_row.privilege_type = 'EXECUTE'
      AND privilege_row.grantee NOT IN (
            0,
            function_row.proowner,
            v_service_role
          )
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION public.arena_metric_trust_release_readiness() FROM %I',
      v_role.role_name
    );
  END LOOP;
END
$readiness_acl$;

COMMENT ON COLUMN arena.metric_trust_observations.source_page_ordinal IS
  'One-based ordinal of the exact immutable source page that supplied this metric; NULL means lineage was not verified or predates this contract.';
COMMENT ON FUNCTION arena.validate_metric_trust_source_page_lineage() IS
  'Private INSERT guard binding verified observation ordinals to the immutable parser source-page lineage.';
COMMENT ON FUNCTION public.arena_metric_trust_release_readiness() IS
  'Service-role-only release gate for the exact metric-trust authority, score-input, and source-page-lineage contracts.';

-- PostgREST receives this only after COMMIT and reloads the newly exposed RPC
-- before the exact-main deployment gate probes it.
NOTIFY pgrst, 'reload schema';

DO $postflight$
DECLARE
  v_lineage pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'arena.validate_metric_trust_source_page_lineage()'
  );
  v_readiness pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.arena_metric_trust_release_readiness()'
  );
  v_postgres pg_catalog.oid := pg_catalog.to_regrole('postgres');
  v_service_role pg_catalog.oid := pg_catalog.to_regrole('service_role');
BEGIN
  IF v_lineage IS NULL OR v_readiness IS NULL THEN
    RAISE EXCEPTION 'metric-trust source-page lineage functions are missing';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = v_lineage
         AND function_row.proowner = v_postgres
         AND function_row.prosecdef
         AND function_row.provolatile = 'v'
         AND function_row.prorettype = 'trigger'::pg_catalog.regtype
         AND function_row.proconfig @> ARRAY[
               'search_path=pg_catalog, pg_temp'
             ]::text[]
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS privilege_row
       WHERE function_row.oid = v_lineage
         AND privilege_row.privilege_type = 'EXECUTE'
         AND privilege_row.grantee <> function_row.proowner
     ) THEN
    RAISE EXCEPTION 'metric-trust source-page lineage trigger function drifted';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = v_readiness
         AND function_row.proowner = v_postgres
         AND function_row.prosecdef
         AND function_row.provolatile = 's'
         AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
         AND function_row.proconfig @> ARRAY[
               'search_path=pg_catalog, pg_temp'
             ]::text[]
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS privilege_row
       WHERE function_row.oid = v_readiness
         AND privilege_row.privilege_type = 'EXECUTE'
         AND privilege_row.grantee NOT IN (function_row.proowner, v_service_role)
     ) OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.arena_metric_trust_release_readiness()',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'metric-trust release-readiness RPC privileges drifted';
  END IF;
END
$postflight$;

COMMIT;
