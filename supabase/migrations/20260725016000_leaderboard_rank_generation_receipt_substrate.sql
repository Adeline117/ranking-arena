-- Dormant owner-only write-phase receipts for fenced rank generations.
--
-- This substrate authorizes no leaderboard DML and exposes no API RPC. One
-- immutable binding snapshots every generation's exact scorer-manifest
-- identity without retaining the potentially large manifest payload. Batch
-- receipts then record database-domain digests and per-source mutation-fence
-- windows for a future atomic writer. These are write-phase audit records,
-- never terminal publication proof: cleanup, rerank, zero-row authority
-- sources, and final fences require a later generation-level finalizer.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL quote_all_identifiers = 'off';

DO $dependency_preflight$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regclass(
       'arena.leaderboard_rank_generation_heads'
     ) IS NULL
     OR pg_catalog.to_regclass(
       'arena.leaderboard_rank_generation_claims'
     ) IS NULL
     OR pg_catalog.to_regclass(
       'arena.leaderboard_score_input_manifests'
     ) IS NULL
     OR pg_catalog.to_regclass(
       'arena.leaderboard_rank_mutation_fences'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.reject_leaderboard_rank_publication_mutation()'
     ) IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'generation receipts require PG17 and the exact claim, manifest, fence, and API-role substrate';
  END IF;
END
$dependency_preflight$;

-- Keep the same global lock order as claim and future writer paths. The two
-- mutable parent stores are locked before adding their composite/FK contracts.
LOCK TABLE ONLY arena.leaderboard_rank_generation_heads
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_claims
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE ONLY arena.leaderboard_score_input_manifests
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_mutation_fences
  IN ACCESS EXCLUSIVE MODE;

DO $lock_existing_receipts$
BEGIN
  IF pg_catalog.to_regclass(
       'arena.leaderboard_rank_generation_manifest_bindings'
     ) IS NOT NULL THEN
    LOCK TABLE ONLY arena.leaderboard_rank_generation_manifest_bindings
      IN ACCESS EXCLUSIVE MODE;
  END IF;
  IF pg_catalog.to_regclass(
       'arena.leaderboard_rank_generation_batch_receipts'
     ) IS NOT NULL THEN
    LOCK TABLE ONLY arena.leaderboard_rank_generation_batch_receipts
      IN ACCESS EXCLUSIVE MODE;
  END IF;
  IF pg_catalog.to_regclass(
       'arena.leaderboard_rank_generation_source_fence_receipts'
     ) IS NOT NULL THEN
    LOCK TABLE ONLY arena.leaderboard_rank_generation_source_fence_receipts
      IN ACCESS EXCLUSIVE MODE;
  END IF;
END
$lock_existing_receipts$;

CREATE TEMP TABLE leaderboard_generation_receipt_install_state (
  receipts_existed boolean NOT NULL,
  manifest_binding_oid oid,
  batch_receipt_oid oid,
  source_fence_receipt_oid oid,
  manifest_binding_validator_oid oid,
  sequence_count bigint NOT NULL
) ON COMMIT DROP;

INSERT INTO leaderboard_generation_receipt_install_state (
  receipts_existed,
  manifest_binding_oid,
  batch_receipt_oid,
  source_fence_receipt_oid,
  manifest_binding_validator_oid,
  sequence_count
)
SELECT
  binding_table.oid IS NOT NULL,
  binding_table.oid,
  batch_table.oid,
  source_table.oid,
  validator_function.oid,
  (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_class AS sequence_row
    WHERE sequence_row.relkind = 'S'
  )
FROM (SELECT 1) AS singleton
LEFT JOIN pg_catalog.pg_class AS binding_table
  ON binding_table.oid = pg_catalog.to_regclass(
    'arena.leaderboard_rank_generation_manifest_bindings'
  )
LEFT JOIN pg_catalog.pg_class AS batch_table
  ON batch_table.oid = pg_catalog.to_regclass(
    'arena.leaderboard_rank_generation_batch_receipts'
  )
LEFT JOIN pg_catalog.pg_class AS source_table
  ON source_table.oid = pg_catalog.to_regclass(
    'arena.leaderboard_rank_generation_source_fence_receipts'
  )
LEFT JOIN pg_catalog.pg_proc AS validator_function
  ON validator_function.oid = pg_catalog.to_regprocedure(
    'arena.validate_leaderboard_rank_generation_manifest_binding()'
  );

DO $preflight$
DECLARE
  v_receipts_existed boolean;
  v_binding oid;
  v_batch oid;
  v_source oid;
  v_binding_validator oid;
  v_claim_function oid := pg_catalog.to_regprocedure(
    'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'
  );
BEGIN
  SELECT
    install.receipts_existed,
    install.manifest_binding_oid,
    install.batch_receipt_oid,
    install.source_fence_receipt_oid,
    install.manifest_binding_validator_oid
  INTO STRICT
    v_receipts_existed,
    v_binding,
    v_batch,
    v_source,
    v_binding_validator
  FROM leaderboard_generation_receipt_install_state AS install;

  IF (v_binding IS NULL)::integer
       + (v_batch IS NULL)::integer
       + (v_source IS NULL)::integer
       + (v_binding_validator IS NULL)::integer NOT IN (0, 4) THEN
    RAISE EXCEPTION 'leaderboard generation receipt objects are only partially installed';
  END IF;
  IF v_receipts_existed IS DISTINCT FROM (v_binding IS NOT NULL)
     OR v_receipts_existed IS DISTINCT FROM (v_batch IS NOT NULL)
     OR v_receipts_existed IS DISTINCT FROM (v_source IS NOT NULL)
     OR v_receipts_existed IS DISTINCT FROM
          (v_binding_validator IS NOT NULL) THEN
    RAISE EXCEPTION 'generation receipt tables and manifest validator disagree';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'claim_leaderboard_rank_generation'
      AND function_row.oid IS DISTINCT FROM v_claim_function
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_claim_function
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prokind = 'f'
      AND language_row.lanname = 'plpgsql'
      AND function_row.prosecdef
      AND NOT function_row.proleakproof
      AND NOT function_row.proisstrict
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND NOT function_row.proretset
      AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND function_row.pronargs = 7
      AND function_row.pronargdefaults = 0
      AND function_row.proargtypes = ARRAY[
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.uuid'::pg_catalog.regtype,
        'pg_catalog.text'::pg_catalog.regtype,
        'pg_catalog.int4'::pg_catalog.regtype,
        'pg_catalog.int4'::pg_catalog.regtype,
        'pg_catalog.timestamptz'::pg_catalog.regtype,
        'pg_catalog.int4'::pg_catalog.regtype
      ]::pg_catalog.oidvector
      AND function_row.proargnames = ARRAY[
        'p_season_id',
        'p_score_cohort_id',
        'p_write_set_sha256',
        'p_expected_rank_count',
        'p_expected_batch_count',
        'p_computed_at',
        'p_lease_seconds'
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
        'lock_timeout=10s'
      ]::pg_catalog.text[]
      AND pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(function_row.prosrc, 'UTF8')
        ),
        'hex'
      ) =
        '09f136557ede5e00ef5c519736c81abf44ea7780f336e216591304a746a746a2'
  ) THEN
    RAISE EXCEPTION 'bounded generation claim RPC contract drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', v_claim_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_claim_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_claim_function, 'EXECUTE'
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
       WHERE function_row.oid = v_claim_function
         AND expanded.privilege_type = 'EXECUTE'
         AND expanded.grantee <> function_row.proowner
         AND expanded.grantee <> 'service_role'::pg_catalog.regrole
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS expanded
       WHERE function_row.oid = v_claim_function
         AND expanded.grantee = 'service_role'::pg_catalog.regrole
         AND expanded.privilege_type = 'EXECUTE'
         AND expanded.is_grantable
     ) THEN
    RAISE EXCEPTION 'bounded generation claim RPC EXECUTE ACL drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
      AND constraint_row.conname =
        'leaderboard_rank_generation_claims_batch_capacity_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_expr(
        constraint_row.conbin,
        constraint_row.conrelid,
        false
      ) =
        '((expected_batch_count <= 4096) AND (expected_rank_count <= 64000) AND ((expected_rank_count)::bigint <= ((expected_batch_count)::bigint * 1000)))'
  ) THEN
    RAISE EXCEPTION 'bounded generation claim capacity contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid =
        'arena.reject_leaderboard_rank_publication_mutation()'
          ::pg_catalog.regprocedure
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prokind = 'f'
      AND language_row.lanname = 'plpgsql'
      AND function_row.prosecdef
      AND NOT function_row.proleakproof
      AND NOT function_row.proisstrict
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND function_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 0
      AND function_row.pronargdefaults = 0
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
      AND pg_catalog.btrim(
        pg_catalog.regexp_replace(function_row.prosrc, '[[:space:]]+', ' ', 'g')
      ) =
        'BEGIN RAISE EXCEPTION ''leaderboard publication receipts are immutable'' USING ERRCODE = ''55000''; END;'
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            function_row.proacl,
            pg_catalog.acldefault('f', function_row.proowner)
          )
        ) AS expanded
        WHERE expanded.grantee <> function_row.proowner
      )
  ) THEN
    RAISE EXCEPTION 'leaderboard immutable receipt guard drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        table_row.relacl,
        pg_catalog.acldefault('r', table_row.relowner)
      )
    ) AS expanded
    WHERE table_row.oid IN (
      'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass,
      'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
      'arena.leaderboard_score_input_manifests'::pg_catalog.regclass,
      'arena.leaderboard_rank_mutation_fences'::pg_catalog.regclass
    )
      AND expanded.grantee <> table_row.relowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid IN (
      'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass,
      'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
      'arena.leaderboard_score_input_manifests'::pg_catalog.regclass,
      'arena.leaderboard_rank_mutation_fences'::pg_catalog.regclass
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attacl IS NOT NULL
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass,
      'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
      'arena.leaderboard_score_input_manifests'::pg_catalog.regclass,
      'arena.leaderboard_rank_mutation_fences'::pg_catalog.regclass
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rule_row
    WHERE rule_row.ev_class IN (
      'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass,
      'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
      'arena.leaderboard_score_input_manifests'::pg_catalog.regclass,
      'arena.leaderboard_rank_mutation_fences'::pg_catalog.regclass
    )
  ) THEN
    RAISE EXCEPTION 'generation receipt parent ACL, rule, or policy drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.leaderboard_rank_generation_heads'::regclass, 6),
        ('arena.leaderboard_rank_generation_claims'::regclass, 11),
        ('arena.leaderboard_score_input_manifests'::regclass, 6),
        ('arena.leaderboard_rank_mutation_fences'::regclass, 4)
    ) AS expected(table_oid, column_count)
    JOIN pg_catalog.pg_class AS table_row
      ON table_row.oid = expected.table_oid
    WHERE table_row.relkind <> 'r'
       OR table_row.relpersistence <> 'p'
       OR table_row.relowner <> 'postgres'::pg_catalog.regrole
       OR NOT table_row.relrowsecurity
       OR table_row.relforcerowsecurity
       OR table_row.relispartition
       OR table_row.reloptions IS NOT NULL
       OR table_row.relreplident <> 'd'
       OR table_row.relam IS DISTINCT FROM (
         SELECT access_method.oid
         FROM pg_catalog.pg_am AS access_method
         WHERE access_method.amname = 'heap'
       )
       OR expected.column_count <> (
         SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = expected.table_oid
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
       )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_mutation_fences'::regclass
    )
       OR inheritance.inhparent IN (
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_mutation_fences'::regclass
    )
  ) THEN
    RAISE EXCEPTION 'generation receipt parent table contract drifted';
  END IF;
END
$preflight$;

DO $parent_catalog_preflight$
DECLARE
  v_receipts_existed boolean;
  v_column_count bigint;
  v_constraint_count bigint;
  v_index_count bigint;
  v_trigger_count bigint;
  v_column_digest text;
  v_constraint_digest text;
  v_index_digest text;
  v_trigger_digest text;
BEGIN
  SELECT install.receipts_existed
  INTO STRICT v_receipts_existed
  FROM leaderboard_generation_receipt_install_state AS install;

  SELECT
    pg_catalog.count(*),
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            pg_catalog.format(
              '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
              table_row.relname,
              attribute.attnum,
              attribute.attname,
              attribute.atttypid::pg_catalog.regtype::text,
              attribute.attnotnull,
              attribute.atthasdef,
              COALESCE(
                pg_catalog.pg_get_expr(
                  default_row.adbin,
                  default_row.adrelid,
                  false
                ),
                ''
              ),
              attribute.attgenerated,
              attribute.attidentity,
              attribute.atttypmod,
              attribute.attndims,
              attribute.attcollation::pg_catalog.regcollation::text,
              COALESCE(attribute.attoptions::text, ''),
              COALESCE(attribute.attfdwoptions::text, '')
            ),
            E'\n' ORDER BY table_row.relname, attribute.attnum
          ),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO STRICT v_column_count, v_column_digest
  FROM pg_catalog.pg_attribute AS attribute
  JOIN pg_catalog.pg_class AS table_row
    ON table_row.oid = attribute.attrelid
  LEFT JOIN pg_catalog.pg_attrdef AS default_row
    ON default_row.adrelid = attribute.attrelid
   AND default_row.adnum = attribute.attnum
  WHERE attribute.attrelid IN (
    'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass,
    'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
    'arena.leaderboard_score_input_manifests'::pg_catalog.regclass,
    'arena.leaderboard_rank_mutation_fences'::pg_catalog.regclass
  )
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT
    pg_catalog.count(*),
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            pg_catalog.format(
              '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
              table_row.relname,
              constraint_row.conname,
              constraint_row.contype,
              constraint_row.convalidated,
              constraint_row.condeferrable,
              constraint_row.condeferred,
              constraint_row.connoinherit,
              constraint_row.conkey::text,
              constraint_row.confkey::text,
              CASE
                WHEN constraint_row.confrelid = 0 THEN ''
                ELSE constraint_row.confrelid::pg_catalog.regclass::text
              END,
              constraint_row.confupdtype,
              constraint_row.confdeltype,
              constraint_row.confmatchtype,
              pg_catalog.pg_get_constraintdef(
                constraint_row.oid,
                true
              )
            ),
            E'\n' ORDER BY table_row.relname, constraint_row.conname
          ),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO STRICT v_constraint_count, v_constraint_digest
  FROM pg_catalog.pg_constraint AS constraint_row
  JOIN pg_catalog.pg_class AS table_row
    ON table_row.oid = constraint_row.conrelid
  WHERE constraint_row.conrelid IN (
    'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass,
    'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
    'arena.leaderboard_score_input_manifests'::pg_catalog.regclass,
    'arena.leaderboard_rank_mutation_fences'::pg_catalog.regclass
  );

  SELECT
    pg_catalog.count(*),
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            pg_catalog.format(
              '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
              table_row.relname,
              index_class.relname,
              pg_catalog.pg_get_userbyid(index_class.relowner),
              index_class.relkind,
              access_method.amname,
              index_row.indisunique,
              index_row.indisprimary,
              index_row.indisvalid,
              index_row.indisready,
              index_row.indislive,
              index_row.indimmediate,
              index_row.indisclustered,
              index_row.indisreplident,
              index_row.indnkeyatts,
              index_row.indnatts,
              pg_catalog.pg_get_indexdef(index_row.indexrelid)
            ),
            E'\n' ORDER BY table_row.relname, index_class.relname
          ),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO STRICT v_index_count, v_index_digest
  FROM pg_catalog.pg_index AS index_row
  JOIN pg_catalog.pg_class AS table_row
    ON table_row.oid = index_row.indrelid
  JOIN pg_catalog.pg_class AS index_class
    ON index_class.oid = index_row.indexrelid
  JOIN pg_catalog.pg_am AS access_method
    ON access_method.oid = index_class.relam
  WHERE index_row.indrelid IN (
    'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass,
    'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
    'arena.leaderboard_score_input_manifests'::pg_catalog.regclass,
    'arena.leaderboard_rank_mutation_fences'::pg_catalog.regclass
  );

  SELECT
    pg_catalog.count(*),
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            pg_catalog.format(
              '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
              table_row.relname,
              CASE
                WHEN trigger_row.tgisinternal THEN trigger_function.proname
                ELSE trigger_row.tgname
              END,
              trigger_row.tgisinternal,
              trigger_row.tgtype,
              trigger_row.tgenabled,
              COALESCE(constraint_row.conname, ''),
              CASE
                WHEN trigger_row.tgconstrrelid = 0 THEN ''
                ELSE trigger_row.tgconstrrelid::pg_catalog.regclass::text
              END,
              function_namespace.nspname || '.' || trigger_function.proname,
              COALESCE(
                pg_catalog.pg_get_expr(
                  trigger_row.tgqual,
                  trigger_row.tgrelid,
                  false
                ),
                ''
              ),
              trigger_row.tgattr::text,
              COALESCE(trigger_row.tgoldtable::text, ''),
              COALESCE(trigger_row.tgnewtable::text, ''),
              trigger_row.tgdeferrable,
              trigger_row.tginitdeferred,
              trigger_row.tgnargs,
              pg_catalog.encode(trigger_row.tgargs, 'hex')
            ),
            E'\n' ORDER BY
              table_row.relname,
              COALESCE(constraint_row.conname, ''),
              trigger_function.proname,
              trigger_row.tgtype,
              trigger_row.tgname
          ),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO STRICT v_trigger_count, v_trigger_digest
  FROM pg_catalog.pg_trigger AS trigger_row
  JOIN pg_catalog.pg_class AS table_row
    ON table_row.oid = trigger_row.tgrelid
  JOIN pg_catalog.pg_proc AS trigger_function
    ON trigger_function.oid = trigger_row.tgfoid
  JOIN pg_catalog.pg_namespace AS function_namespace
    ON function_namespace.oid = trigger_function.pronamespace
  LEFT JOIN pg_catalog.pg_constraint AS constraint_row
    ON constraint_row.oid = trigger_row.tgconstraint
  WHERE trigger_row.tgrelid IN (
    'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass,
    'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
    'arena.leaderboard_score_input_manifests'::pg_catalog.regclass,
    'arena.leaderboard_rank_mutation_fences'::pg_catalog.regclass
  );

  IF v_column_count <> 27
     OR v_constraint_count <> 31
     OR v_index_count <> 7
     OR v_column_digest IS DISTINCT FROM
          'a86d50270be11c5b4fe7c7c278669fa54b0c7b38681b462e65f75e6c6845e53c'
     OR v_constraint_digest IS DISTINCT FROM
          '7612338d9f4409da2e38c39157bfa58c74926b57f7f1ec690bed2ebbde4ab5e0'
     OR v_index_digest IS DISTINCT FROM
          '5fcbf76058934ae936d9346a35a4f7dcf6d5a6b34886ffdaf316c99acf4357bf'
     OR (
       NOT v_receipts_existed
       AND (
         v_trigger_count <> 5
         OR v_trigger_digest IS DISTINCT FROM
              '59566c7022705c2c6fcb6f4ef0ef5863f714d518fb924fd4589c0496dbd356be'
       )
     )
     OR (
       v_receipts_existed
       AND (
         v_trigger_count <> 9
         OR v_trigger_digest IS DISTINCT FROM
              '5716431b3dcb4f3b9e41fa6050133c38b6dad27de6237af99ffd5f28e912767f'
       )
     ) THEN
    RAISE EXCEPTION
      'generation receipt exact parent catalog drifted: columns % %, constraints % %, indexes % %, triggers % %',
      v_column_count,
      v_column_digest,
      v_constraint_count,
      v_constraint_digest,
      v_index_count,
      v_index_digest,
      v_trigger_count,
      v_trigger_digest;
  END IF;
END
$parent_catalog_preflight$;

DO $install$
DECLARE
  v_receipts_existed boolean;
  v_table regclass;
  v_grantee oid;
  v_role_name text;
BEGIN
  SELECT install.receipts_existed
  INTO STRICT v_receipts_existed
  FROM leaderboard_generation_receipt_install_state AS install;

  IF NOT v_receipts_existed THEN
    EXECUTE $validator_function$
      CREATE FUNCTION
        arena.validate_leaderboard_rank_generation_manifest_binding()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY INVOKER
      SET search_path = pg_catalog, pg_temp
      AS $body$
      DECLARE
        v_manifest_digest text;
        v_period text;
        v_manifest jsonb;
        v_valid_until timestamptz;
        v_expected_digest text;
      BEGIN
        SELECT
          stored.manifest_digest,
          stored.period,
          stored.manifest,
          stored.valid_until
        INTO STRICT
          v_manifest_digest,
          v_period,
          v_manifest,
          v_valid_until
        FROM arena.leaderboard_score_input_manifests AS stored
        WHERE stored.manifest_id = NEW.score_input_manifest_id
        FOR SHARE;

        IF v_manifest_digest IS DISTINCT FROM
             NEW.score_input_manifest_digest
           OR v_period IS DISTINCT FROM NEW.season_id THEN
          RAISE EXCEPTION
            'generation manifest binding does not match one stored manifest'
            USING ERRCODE = '23503';
        END IF;

        v_expected_digest := pg_catalog.encode(
          pg_catalog.sha256(
            pg_catalog.convert_to(
              (v_manifest - 'manifestDigest')::text,
              'UTF8'
            )
          ),
          'hex'
        );
        IF v_manifest_digest IS DISTINCT FROM v_expected_digest
           OR v_manifest->>'manifestDigest' IS DISTINCT FROM
                v_manifest_digest
           OR v_manifest->>'period' IS DISTINCT FROM v_period
           OR (v_manifest->>'validUntil')::timestamptz IS DISTINCT FROM
                v_valid_until THEN
          RAISE EXCEPTION
            'generation manifest binding found invalid content addressing'
            USING ERRCODE = '55000';
        END IF;
        IF v_valid_until <= pg_catalog.statement_timestamp() THEN
          RAISE EXCEPTION
            'generation manifest binding requires a live manifest'
            USING ERRCODE = '55000';
        END IF;

        RETURN NEW;
      EXCEPTION
        WHEN no_data_found THEN
          RAISE EXCEPTION
            'generation manifest binding references an unknown manifest'
            USING ERRCODE = '23503';
      END;
      $body$
    $validator_function$;

    ALTER FUNCTION
      arena.validate_leaderboard_rank_generation_manifest_binding()
      OWNER TO postgres;
    REVOKE ALL ON FUNCTION
      arena.validate_leaderboard_rank_generation_manifest_binding()
      FROM PUBLIC, anon, authenticated, service_role;

    EXECUTE $binding_table$
      CREATE TABLE arena.leaderboard_rank_generation_manifest_bindings (
        contract text NOT NULL,
        season_id text NOT NULL,
        generation_seq bigint NOT NULL,
        score_cohort_id uuid NOT NULL,
        score_input_manifest_id uuid NOT NULL,
        score_input_manifest_digest text NOT NULL,
        bound_at timestamptz NOT NULL,
        CONSTRAINT rank_generation_manifest_binding_pkey
          PRIMARY KEY (season_id, generation_seq),
        CONSTRAINT rank_generation_manifest_binding_identity_key
          UNIQUE (
            season_id,
            generation_seq,
            score_cohort_id,
            score_input_manifest_id,
            score_input_manifest_digest
          ),
        CONSTRAINT rank_generation_manifest_binding_contract_check
          CHECK (contract = 'leaderboard-rank-generation-manifest-binding@1'),
        CONSTRAINT rank_generation_manifest_binding_season_check
          CHECK (season_id IN ('7D', '30D', '90D')),
        CONSTRAINT rank_generation_manifest_binding_sequence_check
          CHECK (
            generation_seq > 0
            AND generation_seq <= 9007199254740000
          ),
        CONSTRAINT rank_generation_manifest_binding_digest_check
          CHECK (score_input_manifest_digest ~ '^[0-9a-f]{64}$'),
        CONSTRAINT rank_generation_manifest_binding_bound_at_check
          CHECK (pg_catalog.isfinite(bound_at)),
        CONSTRAINT rank_generation_manifest_binding_claim_fkey
          FOREIGN KEY (season_id, generation_seq, score_cohort_id)
          REFERENCES arena.leaderboard_rank_generation_claims (
            season_id,
            generation_seq,
            score_cohort_id
          )
      )
    $binding_table$;

    EXECUTE $binding_manifest_index$
      CREATE INDEX rank_generation_manifest_binding_manifest_idx
      ON arena.leaderboard_rank_generation_manifest_bindings
      USING btree (
        score_input_manifest_id,
        score_input_manifest_digest,
        season_id
      )
    $binding_manifest_index$;

    EXECUTE $batch_table$
      CREATE TABLE arena.leaderboard_rank_generation_batch_receipts (
        contract text NOT NULL,
        season_id text NOT NULL,
        generation_seq bigint NOT NULL,
        score_cohort_id uuid NOT NULL,
        batch_index integer NOT NULL,
        batch_sha256 text NOT NULL,
        score_input_manifest_id uuid NOT NULL,
        score_input_manifest_digest text NOT NULL,
        row_count integer NOT NULL,
        source_count integer NOT NULL,
        first_source text COLLATE pg_catalog."C" NOT NULL,
        first_source_trader_id text COLLATE pg_catalog."C" NOT NULL,
        last_source text COLLATE pg_catalog."C" NOT NULL,
        last_source_trader_id text COLLATE pg_catalog."C" NOT NULL,
        completed_at timestamptz NOT NULL,
        CONSTRAINT rank_generation_batch_receipt_pkey
          PRIMARY KEY (season_id, generation_seq, batch_index),
        CONSTRAINT rank_generation_batch_receipt_cohort_batch_key
          UNIQUE (score_cohort_id, batch_index),
        CONSTRAINT rank_generation_batch_receipt_cohort_digest_key
          UNIQUE (score_cohort_id, batch_sha256),
        CONSTRAINT rank_generation_batch_receipt_contract_check
          CHECK (contract = 'leaderboard-rank-generation-batch-receipt@1'),
        CONSTRAINT rank_generation_batch_receipt_season_check
          CHECK (season_id IN ('7D', '30D', '90D')),
        CONSTRAINT rank_generation_batch_receipt_sequence_check
          CHECK (
            generation_seq > 0
            AND generation_seq <= 9007199254740000
          ),
        CONSTRAINT rank_generation_batch_receipt_batch_index_check
          CHECK (batch_index >= 0 AND batch_index < 4096),
        CONSTRAINT rank_generation_batch_receipt_batch_digest_check
          CHECK (batch_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT rank_generation_batch_receipt_manifest_digest_check
          CHECK (score_input_manifest_digest ~ '^[0-9a-f]{64}$'),
        CONSTRAINT rank_generation_batch_receipt_row_count_check
          CHECK (row_count > 0 AND row_count <= 1000),
        CONSTRAINT rank_generation_batch_receipt_source_count_check
          CHECK (
            source_count > 0
            AND source_count <= row_count
          ),
        CONSTRAINT rank_generation_batch_receipt_first_identity_check
          CHECK (
            first_source ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
            AND pg_catalog.char_length(first_source) <= 128
            AND first_source_trader_id =
                pg_catalog.btrim(first_source_trader_id)
            AND first_source_trader_id <> ''
            AND pg_catalog.char_length(first_source_trader_id) <= 512
          ),
        CONSTRAINT rank_generation_batch_receipt_last_identity_check
          CHECK (
            last_source ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
            AND pg_catalog.char_length(last_source) <= 128
            AND last_source_trader_id =
                pg_catalog.btrim(last_source_trader_id)
            AND last_source_trader_id <> ''
            AND pg_catalog.char_length(last_source_trader_id) <= 512
          ),
        CONSTRAINT rank_generation_batch_receipt_identity_order_check
          CHECK (
            (
              row_count = 1
              AND ROW(first_source, first_source_trader_id) =
                  ROW(last_source, last_source_trader_id)
            )
            OR (
              row_count > 1
              AND ROW(first_source, first_source_trader_id) <
                  ROW(last_source, last_source_trader_id)
            )
          ),
        CONSTRAINT rank_generation_batch_receipt_completed_at_check
          CHECK (pg_catalog.isfinite(completed_at)),
        CONSTRAINT rank_generation_batch_receipt_binding_fkey
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
          )
      )
    $batch_table$;

    EXECUTE $source_table$
      CREATE TABLE arena.leaderboard_rank_generation_source_fence_receipts (
        contract text NOT NULL,
        season_id text NOT NULL,
        generation_seq bigint NOT NULL,
        batch_index integer NOT NULL,
        source text COLLATE pg_catalog."C" NOT NULL,
        source_row_count integer NOT NULL,
        source_identity_sha256 text NOT NULL,
        mutation_seq_before bigint NOT NULL,
        mutation_seq_after bigint NOT NULL,
        CONSTRAINT rank_generation_source_fence_receipt_pkey
          PRIMARY KEY (season_id, generation_seq, batch_index, source),
        CONSTRAINT rank_generation_source_fence_receipt_after_key
          UNIQUE (season_id, source, mutation_seq_after),
        CONSTRAINT rank_generation_source_fence_receipt_contract_check
          CHECK (
            contract =
              'leaderboard-rank-generation-source-fence-receipt@1'
          ),
        CONSTRAINT rank_generation_source_fence_receipt_season_check
          CHECK (season_id IN ('7D', '30D', '90D')),
        CONSTRAINT rank_generation_source_fence_receipt_sequence_check
          CHECK (
            generation_seq > 0
            AND generation_seq <= 9007199254740000
          ),
        CONSTRAINT rank_generation_source_fence_receipt_batch_index_check
          CHECK (batch_index >= 0 AND batch_index < 4096),
        CONSTRAINT rank_generation_source_fence_receipt_source_check
          CHECK (
            source ~ '^[a-z0-9]+(_[a-z0-9]+)*$'
            AND pg_catalog.char_length(source) <= 128
          ),
        CONSTRAINT rank_generation_source_fence_receipt_row_count_check
          CHECK (source_row_count > 0 AND source_row_count <= 1000),
        CONSTRAINT rank_generation_source_fence_receipt_identity_digest_check
          CHECK (source_identity_sha256 ~ '^[0-9a-f]{64}$'),
        CONSTRAINT rank_generation_source_fence_receipt_mutation_window_check
          CHECK (
            mutation_seq_before >= 0
            AND mutation_seq_after > mutation_seq_before
            AND mutation_seq_after <= 9007199254740000
            AND mutation_seq_after - mutation_seq_before IN (1, 2)
          ),
        CONSTRAINT rank_generation_source_fence_receipt_batch_fkey
          FOREIGN KEY (season_id, generation_seq, batch_index)
          REFERENCES arena.leaderboard_rank_generation_batch_receipts (
            season_id,
            generation_seq,
            batch_index
          ),
        CONSTRAINT rank_generation_source_fence_receipt_fence_fkey
          FOREIGN KEY (season_id, source)
          REFERENCES arena.leaderboard_rank_mutation_fences (
            season_id,
            source
          )
      )
    $source_table$;

    ALTER TABLE arena.leaderboard_rank_generation_manifest_bindings
      OWNER TO postgres;
    ALTER TABLE arena.leaderboard_rank_generation_batch_receipts
      OWNER TO postgres;
    ALTER TABLE arena.leaderboard_rank_generation_source_fence_receipts
      OWNER TO postgres;

    ALTER TABLE arena.leaderboard_rank_generation_manifest_bindings
      ENABLE ROW LEVEL SECURITY;
    ALTER TABLE arena.leaderboard_rank_generation_batch_receipts
      ENABLE ROW LEVEL SECURITY;
    ALTER TABLE arena.leaderboard_rank_generation_source_fence_receipts
      ENABLE ROW LEVEL SECURITY;

    CREATE TRIGGER leaderboard_rank_generation_manifest_bindings_validate
    BEFORE INSERT
    ON arena.leaderboard_rank_generation_manifest_bindings
    FOR EACH ROW
    EXECUTE FUNCTION
      arena.validate_leaderboard_rank_generation_manifest_binding();

    CREATE TRIGGER leaderboard_rank_generation_manifest_bindings_immutable
    BEFORE UPDATE OR DELETE
    ON arena.leaderboard_rank_generation_manifest_bindings
    FOR EACH ROW
    EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

    CREATE TRIGGER leaderboard_rank_generation_manifest_bindings_no_truncate
    BEFORE TRUNCATE
    ON arena.leaderboard_rank_generation_manifest_bindings
    FOR EACH STATEMENT
    EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

    CREATE TRIGGER leaderboard_rank_generation_batch_receipts_immutable
    BEFORE UPDATE OR DELETE
    ON arena.leaderboard_rank_generation_batch_receipts
    FOR EACH ROW
    EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

    CREATE TRIGGER leaderboard_rank_generation_batch_receipts_no_truncate
    BEFORE TRUNCATE
    ON arena.leaderboard_rank_generation_batch_receipts
    FOR EACH STATEMENT
    EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

    CREATE TRIGGER leaderboard_rank_generation_source_fence_receipts_immutable
    BEFORE UPDATE OR DELETE
    ON arena.leaderboard_rank_generation_source_fence_receipts
    FOR EACH ROW
    EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

    CREATE TRIGGER leaderboard_rank_generation_source_fence_receipts_no_truncate
    BEFORE TRUNCATE
    ON arena.leaderboard_rank_generation_source_fence_receipts
    FOR EACH STATEMENT
    EXECUTE FUNCTION arena.reject_leaderboard_rank_publication_mutation();

    FOREACH v_table IN ARRAY ARRAY[
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
    ]
    LOOP
      FOR v_grantee IN
        SELECT DISTINCT expanded.grantee
        FROM pg_catalog.pg_class AS table_row
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            table_row.relacl,
            pg_catalog.acldefault('r', table_row.relowner)
          )
        ) AS expanded
        WHERE table_row.oid = v_table
          AND expanded.grantee <> table_row.relowner
        ORDER BY expanded.grantee
      LOOP
        IF v_grantee = 0 THEN
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON TABLE %s FROM PUBLIC CASCADE',
            v_table
          );
        ELSE
          SELECT role_row.rolname
          INTO STRICT v_role_name
          FROM pg_catalog.pg_roles AS role_row
          WHERE role_row.oid = v_grantee;
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES ON TABLE %s FROM %I CASCADE',
            v_table,
            v_role_name
          );
        END IF;
      END LOOP;
    END LOOP;

    REVOKE ALL ON TABLE
      arena.leaderboard_rank_generation_manifest_bindings,
      arena.leaderboard_rank_generation_batch_receipts,
      arena.leaderboard_rank_generation_source_fence_receipts
    FROM PUBLIC, anon, authenticated, service_role;

    COMMENT ON TABLE
      arena.leaderboard_rank_generation_manifest_bindings IS
      'Immutable compact one-generation/one-manifest identity snapshots. Insert validation locks one exact live manifest row, but no FK pins the large payload after commit. Owner-only and dormant until the database evidence builder exists.';
    COMMENT ON TABLE
      arena.leaderboard_rank_generation_batch_receipts IS
      'Immutable database-domain batch write receipts. Write-phase audit only; never terminal publication authority.';
    COMMENT ON TABLE
      arena.leaderboard_rank_generation_source_fence_receipts IS
      'Immutable per-batch mutation-fence windows. Not source authority and not the final post-cleanup/rerank fence.';
    COMMENT ON FUNCTION
      arena.validate_leaderboard_rank_generation_manifest_binding() IS
      'Owner-only trigger validator. FOR SHARE binds id, digest, and period atomically while allowing later pruning of the large expired manifest payload; the future writer and finalizer must still rerun full manifest content verification.';
  END IF;
END
$install$;

-- Exact catalog postflight follows below. It also serves as a fail-closed
-- replay attestation because the install block is a strict no-op on replay.

DO $table_postflight$
DECLARE
  v_receipts_existed boolean;
  v_binding_before oid;
  v_batch_before oid;
  v_source_before oid;
  v_binding_validator_before oid;
  v_sequence_count_before bigint;
  v_binding_validator_sha256 text;
  v_binding_after oid := pg_catalog.to_regclass(
    'arena.leaderboard_rank_generation_manifest_bindings'
  );
  v_batch_after oid := pg_catalog.to_regclass(
    'arena.leaderboard_rank_generation_batch_receipts'
  );
  v_source_after oid := pg_catalog.to_regclass(
    'arena.leaderboard_rank_generation_source_fence_receipts'
  );
  v_binding_validator_after oid := pg_catalog.to_regprocedure(
    'arena.validate_leaderboard_rank_generation_manifest_binding()'
  );
BEGIN
  SELECT
    install.receipts_existed,
    install.manifest_binding_oid,
    install.batch_receipt_oid,
    install.source_fence_receipt_oid,
    install.manifest_binding_validator_oid,
    install.sequence_count
  INTO STRICT
    v_receipts_existed,
    v_binding_before,
    v_batch_before,
    v_source_before,
    v_binding_validator_before,
    v_sequence_count_before
  FROM leaderboard_generation_receipt_install_state AS install;

  IF v_binding_after IS NULL
     OR v_batch_after IS NULL
     OR v_source_after IS NULL
     OR v_binding_validator_after IS NULL
     OR (
       v_receipts_existed
       AND (
         v_binding_after IS DISTINCT FROM v_binding_before
         OR v_batch_after IS DISTINCT FROM v_batch_before
         OR v_source_after IS DISTINCT FROM v_source_before
         OR v_binding_validator_after IS DISTINCT FROM
              v_binding_validator_before
       )
     ) THEN
    RAISE EXCEPTION 'generation receipt object identity postflight failed';
  END IF;

  IF v_sequence_count_before IS DISTINCT FROM (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_class AS sequence_row
    WHERE sequence_row.relkind = 'S'
  ) THEN
    RAISE EXCEPTION 'generation receipt substrate created an implicit sequence';
  END IF;

  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(function_row.prosrc, 'UTF8')
    ),
    'hex'
  )
  INTO STRICT v_binding_validator_sha256
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_binding_validator_after;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'arena'
      AND function_row.proname =
          'validate_leaderboard_rank_generation_manifest_binding'
      AND function_row.oid IS DISTINCT FROM v_binding_validator_after
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_binding_validator_after
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prokind = 'f'
      AND language_row.lanname = 'plpgsql'
      AND NOT function_row.prosecdef
      AND NOT function_row.proleakproof
      AND NOT function_row.proisstrict
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND function_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 0
      AND function_row.pronargdefaults = 0
      AND function_row.proargmodes IS NULL
      AND function_row.proallargtypes IS NULL
      AND function_row.prosupport = 0
      AND function_row.prosqlbody IS NULL
      AND function_row.probin IS NULL
      AND function_row.procost = 100
      AND function_row.prorows = 0
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            function_row.proacl,
            pg_catalog.acldefault('f', function_row.proowner)
          )
        ) AS expanded
        WHERE expanded.grantee <> function_row.proowner
      )
  ) OR v_binding_validator_sha256 IS DISTINCT FROM
       '43d006071c25fe6bfd0d8f3c146594f415f388d2a7607663e5220922d80c5781' THEN
    RAISE EXCEPTION 'generation manifest binding validator drifted: %',
      v_binding_validator_sha256;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (v_binding_after, 7),
        (v_batch_after, 15),
        (v_source_after, 9)
    ) AS expected(table_oid, column_count)
    JOIN pg_catalog.pg_class AS table_row
      ON table_row.oid = expected.table_oid
    WHERE table_row.relkind <> 'r'
       OR table_row.relpersistence <> 'p'
       OR table_row.relowner <> 'postgres'::pg_catalog.regrole
       OR NOT table_row.relrowsecurity
       OR table_row.relforcerowsecurity
       OR table_row.relispartition
       OR table_row.reloptions IS NOT NULL
       OR table_row.relreplident <> 'd'
       OR table_row.relam IS DISTINCT FROM (
         SELECT access_method.oid
         FROM pg_catalog.pg_am AS access_method
         WHERE access_method.amname = 'heap'
       )
       OR expected.column_count <> (
         SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = expected.table_oid
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
       )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      v_binding_after,
      v_batch_after,
      v_source_after
    )
       OR inheritance.inhparent IN (
      v_binding_after,
      v_batch_after,
      v_source_after
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
      v_binding_after,
      v_batch_after,
      v_source_after
    )
      AND expanded.grantee <> table_row.relowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid IN (
      v_binding_after,
      v_batch_after,
      v_source_after,
      'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass,
      'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
      'arena.leaderboard_score_input_manifests'::pg_catalog.regclass,
      'arena.leaderboard_rank_mutation_fences'::pg_catalog.regclass
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attacl IS NOT NULL
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      v_binding_after,
      v_batch_after,
      v_source_after
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rule_row
    WHERE rule_row.ev_class IN (
      v_binding_after,
      v_batch_after,
      v_source_after
    )
  ) THEN
    RAISE EXCEPTION 'generation receipt table owner, RLS, ACL, inheritance, rule, or policy postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (v_binding_after, 1, 'contract', 'pg_catalog.text'::regtype,
         'pg_catalog."default"'::regcollation),
        (v_binding_after, 2, 'season_id', 'pg_catalog.text'::regtype,
         'pg_catalog."default"'::regcollation),
        (v_binding_after, 3, 'generation_seq', 'pg_catalog.int8'::regtype, 0),
        (v_binding_after, 4, 'score_cohort_id', 'pg_catalog.uuid'::regtype, 0),
        (v_binding_after, 5, 'score_input_manifest_id', 'pg_catalog.uuid'::regtype, 0),
        (v_binding_after, 6, 'score_input_manifest_digest', 'pg_catalog.text'::regtype,
         'pg_catalog."default"'::regcollation),
        (v_binding_after, 7, 'bound_at', 'pg_catalog.timestamptz'::regtype, 0),
        (v_batch_after, 1, 'contract', 'pg_catalog.text'::regtype,
         'pg_catalog."default"'::regcollation),
        (v_batch_after, 2, 'season_id', 'pg_catalog.text'::regtype,
         'pg_catalog."default"'::regcollation),
        (v_batch_after, 3, 'generation_seq', 'pg_catalog.int8'::regtype, 0),
        (v_batch_after, 4, 'score_cohort_id', 'pg_catalog.uuid'::regtype, 0),
        (v_batch_after, 5, 'batch_index', 'pg_catalog.int4'::regtype, 0),
        (v_batch_after, 6, 'batch_sha256', 'pg_catalog.text'::regtype,
         'pg_catalog."default"'::regcollation),
        (v_batch_after, 7, 'score_input_manifest_id', 'pg_catalog.uuid'::regtype, 0),
        (v_batch_after, 8, 'score_input_manifest_digest', 'pg_catalog.text'::regtype,
         'pg_catalog."default"'::regcollation),
        (v_batch_after, 9, 'row_count', 'pg_catalog.int4'::regtype, 0),
        (v_batch_after, 10, 'source_count', 'pg_catalog.int4'::regtype, 0),
        (v_batch_after, 11, 'first_source', 'pg_catalog.text'::regtype,
         'pg_catalog."C"'::regcollation),
        (v_batch_after, 12, 'first_source_trader_id', 'pg_catalog.text'::regtype,
         'pg_catalog."C"'::regcollation),
        (v_batch_after, 13, 'last_source', 'pg_catalog.text'::regtype,
         'pg_catalog."C"'::regcollation),
        (v_batch_after, 14, 'last_source_trader_id', 'pg_catalog.text'::regtype,
         'pg_catalog."C"'::regcollation),
        (v_batch_after, 15, 'completed_at', 'pg_catalog.timestamptz'::regtype, 0),
        (v_source_after, 1, 'contract', 'pg_catalog.text'::regtype,
         'pg_catalog."default"'::regcollation),
        (v_source_after, 2, 'season_id', 'pg_catalog.text'::regtype,
         'pg_catalog."default"'::regcollation),
        (v_source_after, 3, 'generation_seq', 'pg_catalog.int8'::regtype, 0),
        (v_source_after, 4, 'batch_index', 'pg_catalog.int4'::regtype, 0),
        (v_source_after, 5, 'source', 'pg_catalog.text'::regtype,
         'pg_catalog."C"'::regcollation),
        (v_source_after, 6, 'source_row_count', 'pg_catalog.int4'::regtype, 0),
        (v_source_after, 7, 'source_identity_sha256', 'pg_catalog.text'::regtype,
         'pg_catalog."default"'::regcollation),
        (v_source_after, 8, 'mutation_seq_before', 'pg_catalog.int8'::regtype, 0),
        (v_source_after, 9, 'mutation_seq_after', 'pg_catalog.int8'::regtype, 0)
    ) AS expected(
      table_oid,
      column_number,
      column_name,
      type_oid,
      collation_oid
    )
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = expected.table_oid
     AND attribute.attnum = expected.column_number
     AND NOT attribute.attisdropped
    WHERE attribute.attname IS DISTINCT FROM expected.column_name
       OR attribute.atttypid IS DISTINCT FROM expected.type_oid
       OR NOT attribute.attnotnull
       OR attribute.atthasdef
       OR attribute.attgenerated <> ''
       OR attribute.attidentity <> ''
       OR attribute.atttypmod <> -1
       OR attribute.attndims <> 0
       OR attribute.attcollation IS DISTINCT FROM expected.collation_oid
       OR attribute.attacl IS NOT NULL
       OR attribute.attoptions IS NOT NULL
       OR attribute.attfdwoptions IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'generation receipt column contract postflight failed';
  END IF;
END
$table_postflight$;

DO $constraint_index_postflight$
DECLARE
  v_constraint_digest text;
  v_index_digest text;
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'arena.leaderboard_rank_generation_heads'::regclass
  ) <> 7 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'arena.leaderboard_rank_generation_claims'::regclass
  ) <> 14 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'arena.leaderboard_score_input_manifests'::regclass
  ) <> 7 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'arena.leaderboard_rank_mutation_fences'::regclass
  ) <> 3 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass
  ) <> 8 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'arena.leaderboard_rank_generation_batch_receipts'::regclass
  ) <> 16 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
  ) <> 12 THEN
    RAISE EXCEPTION 'generation receipt constraint counts drifted';
  END IF;

  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.string_agg(
          pg_catalog.format(
            '%s|%s|%s|%s|%s|%s|%s|%s|%s',
            table_row.relname,
            constraint_row.conname,
            constraint_row.contype,
            constraint_row.convalidated,
            constraint_row.condeferrable,
            constraint_row.condeferred,
            constraint_row.connoinherit,
            constraint_row.conkey::text,
            pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
          ),
          E'\n' ORDER BY table_row.relname, constraint_row.conname
        ),
        'UTF8'
      )
    ),
    'hex'
  )
  INTO STRICT v_constraint_digest
  FROM pg_catalog.pg_constraint AS constraint_row
  JOIN pg_catalog.pg_class AS table_row
    ON table_row.oid = constraint_row.conrelid
  WHERE constraint_row.conrelid IN (
    'arena.leaderboard_rank_generation_heads'::regclass,
    'arena.leaderboard_rank_generation_claims'::regclass,
    'arena.leaderboard_score_input_manifests'::regclass,
    'arena.leaderboard_rank_mutation_fences'::regclass,
    'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
    'arena.leaderboard_rank_generation_batch_receipts'::regclass,
    'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
  );

  IF v_constraint_digest IS DISTINCT FROM
       'f8d3d164f4385f81dfe942b3d0fe85cfe3207e3783e6fc51f5705ee3ef319926' THEN
    RAISE EXCEPTION 'generation receipt constraint contract drifted: %',
      v_constraint_digest;
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
      'arena.leaderboard_rank_generation_heads'::regclass
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
      'arena.leaderboard_rank_generation_claims'::regclass
  ) <> 3 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
      'arena.leaderboard_score_input_manifests'::regclass
  ) <> 2 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
      'arena.leaderboard_rank_mutation_fences'::regclass
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass
  ) <> 3 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
      'arena.leaderboard_rank_generation_batch_receipts'::regclass
  ) <> 3 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
  ) <> 2 THEN
    RAISE EXCEPTION 'generation receipt index counts drifted';
  END IF;

  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.string_agg(
          pg_catalog.format(
            '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
            table_row.relname,
            index_class.relname,
            index_row.indisunique,
            index_row.indisprimary,
            index_row.indisvalid,
            index_row.indisready,
            index_row.indislive,
            index_row.indimmediate,
            index_row.indisclustered,
            index_row.indisreplident,
            index_row.indnkeyatts,
            index_row.indnatts,
            index_row.indkey::text,
            pg_catalog.pg_get_indexdef(index_row.indexrelid)
          ),
          E'\n' ORDER BY table_row.relname, index_class.relname
        ),
        'UTF8'
      )
    ),
    'hex'
  )
  INTO STRICT v_index_digest
  FROM pg_catalog.pg_index AS index_row
  JOIN pg_catalog.pg_class AS table_row
    ON table_row.oid = index_row.indrelid
  JOIN pg_catalog.pg_class AS index_class
    ON index_class.oid = index_row.indexrelid
  WHERE index_row.indrelid IN (
    'arena.leaderboard_rank_generation_heads'::regclass,
    'arena.leaderboard_rank_generation_claims'::regclass,
    'arena.leaderboard_score_input_manifests'::regclass,
    'arena.leaderboard_rank_mutation_fences'::regclass,
    'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
    'arena.leaderboard_rank_generation_batch_receipts'::regclass,
    'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
  );

  IF v_index_digest IS DISTINCT FROM
       '0000a4d62237d0cd9a65f388cbca4c83b7a8795e435a91f38abd3e1df000c89f' THEN
    RAISE EXCEPTION 'generation receipt index contract drifted: %',
      v_index_digest;
  END IF;
END
$constraint_index_postflight$;

DO $trigger_postflight$
DECLARE
  v_trigger_digest text;
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_mutation_fences'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
    )
      AND trigger_row.tgisinternal
  ) <> 20 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.leaderboard_rank_generation_claims'::regclass, 4),
        ('arena.leaderboard_rank_generation_heads'::regclass, 2),
        ('arena.leaderboard_score_input_manifests'::regclass, 0),
        ('arena.leaderboard_rank_mutation_fences'::regclass, 2),
        ('arena.leaderboard_rank_generation_manifest_bindings'::regclass, 4),
        ('arena.leaderboard_rank_generation_batch_receipts'::regclass, 4),
        ('arena.leaderboard_rank_generation_source_fence_receipts'::regclass, 4)
    ) AS expected(table_oid, trigger_count)
    WHERE expected.trigger_count <> (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = expected.table_oid
        AND trigger_row.tgisinternal
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_mutation_fences'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
    )
      AND trigger_row.tgisinternal
      AND (
        trigger_row.tgenabled <> 'O'
        OR trigger_row.tgqual IS NOT NULL
        OR trigger_row.tgattr <> ''::pg_catalog.int2vector
        OR trigger_row.tgoldtable IS NOT NULL
        OR trigger_row.tgnewtable IS NOT NULL
        OR trigger_row.tgnargs <> 0
        OR trigger_row.tgargs <> '\x'::pg_catalog.bytea
        OR trigger_row.tgparentid <> 0
      )
  ) THEN
    RAISE EXCEPTION 'generation receipt foreign-key trigger contract drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_mutation_fences'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
    )
      AND NOT trigger_row.tgisinternal
  ) <> 8 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claim_immutable', 27::smallint),
        ('arena.leaderboard_rank_generation_manifest_bindings'::regclass,
         'leaderboard_rank_generation_manifest_bindings_immutable', 27::smallint),
        ('arena.leaderboard_rank_generation_manifest_bindings'::regclass,
         'leaderboard_rank_generation_manifest_bindings_no_truncate', 34::smallint),
        ('arena.leaderboard_rank_generation_batch_receipts'::regclass,
         'leaderboard_rank_generation_batch_receipts_immutable', 27::smallint),
        ('arena.leaderboard_rank_generation_batch_receipts'::regclass,
         'leaderboard_rank_generation_batch_receipts_no_truncate', 34::smallint),
        ('arena.leaderboard_rank_generation_source_fence_receipts'::regclass,
         'leaderboard_rank_generation_source_fence_receipts_immutable', 27::smallint),
        ('arena.leaderboard_rank_generation_source_fence_receipts'::regclass,
         'leaderboard_rank_generation_source_fence_receipts_no_truncate', 34::smallint)
    ) AS expected(table_oid, trigger_name, trigger_type)
    LEFT JOIN pg_catalog.pg_trigger AS trigger_row
      ON trigger_row.tgrelid = expected.table_oid
     AND trigger_row.tgname = expected.trigger_name
     AND NOT trigger_row.tgisinternal
    WHERE trigger_row.oid IS NULL
       OR trigger_row.tgfoid IS DISTINCT FROM
          'arena.reject_leaderboard_rank_publication_mutation()'
            ::pg_catalog.regprocedure
       OR trigger_row.tgtype IS DISTINCT FROM expected.trigger_type
       OR trigger_row.tgenabled <> 'O'
       OR trigger_row.tgqual IS NOT NULL
       OR trigger_row.tgattr <> ''::pg_catalog.int2vector
       OR trigger_row.tgoldtable IS NOT NULL
       OR trigger_row.tgnewtable IS NOT NULL
       OR trigger_row.tgconstraint <> 0
       OR trigger_row.tgdeferrable
       OR trigger_row.tginitdeferred
       OR trigger_row.tgnargs <> 0
       OR trigger_row.tgargs <> '\x'::pg_catalog.bytea
       OR trigger_row.tgparentid <> 0
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
        'arena.leaderboard_rank_generation_manifest_bindings'::regclass
      AND trigger_row.tgname =
          'leaderboard_rank_generation_manifest_bindings_validate'
      AND trigger_row.tgfoid =
          'arena.validate_leaderboard_rank_generation_manifest_binding()'
            ::pg_catalog.regprocedure
      AND trigger_row.tgtype = 7
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgqual IS NULL
      AND trigger_row.tgattr = ''::pg_catalog.int2vector
      AND trigger_row.tgoldtable IS NULL
      AND trigger_row.tgnewtable IS NULL
      AND trigger_row.tgconstraint = 0
      AND NOT trigger_row.tgdeferrable
      AND NOT trigger_row.tginitdeferred
      AND trigger_row.tgnargs = 0
      AND trigger_row.tgargs = '\x'::pg_catalog.bytea
      AND trigger_row.tgparentid = 0
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'generation receipt immutable trigger contract drifted';
  END IF;

  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.string_agg(
          pg_catalog.format(
            '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
            table_row.relname,
            CASE
              WHEN trigger_row.tgisinternal THEN trigger_function.proname
              ELSE trigger_row.tgname
            END,
            trigger_row.tgisinternal,
            trigger_row.tgtype,
            trigger_row.tgenabled,
            COALESCE(constraint_row.conname, ''),
            CASE
              WHEN trigger_row.tgconstrrelid = 0 THEN ''
              ELSE trigger_row.tgconstrrelid::pg_catalog.regclass::text
            END,
            function_namespace.nspname || '.' || trigger_function.proname,
            COALESCE(
              pg_catalog.pg_get_expr(
                trigger_row.tgqual,
                trigger_row.tgrelid,
                false
              ),
              ''
            ),
            trigger_row.tgattr::text,
            COALESCE(trigger_row.tgoldtable::text, ''),
            COALESCE(trigger_row.tgnewtable::text, ''),
            trigger_row.tgdeferrable,
            trigger_row.tginitdeferred,
            trigger_row.tgnargs,
            pg_catalog.encode(trigger_row.tgargs, 'hex')
          ),
          E'\n' ORDER BY
            table_row.relname,
            COALESCE(constraint_row.conname, ''),
            trigger_function.proname,
            trigger_row.tgtype,
            CASE
              WHEN trigger_row.tgisinternal THEN ''
              ELSE trigger_row.tgname
            END
        ),
        'UTF8'
      )
    ),
    'hex'
  )
  INTO STRICT v_trigger_digest
  FROM pg_catalog.pg_trigger AS trigger_row
  JOIN pg_catalog.pg_class AS table_row
    ON table_row.oid = trigger_row.tgrelid
  JOIN pg_catalog.pg_proc AS trigger_function
    ON trigger_function.oid = trigger_row.tgfoid
  JOIN pg_catalog.pg_namespace AS function_namespace
    ON function_namespace.oid = trigger_function.pronamespace
  LEFT JOIN pg_catalog.pg_constraint AS constraint_row
    ON constraint_row.oid = trigger_row.tgconstraint
  WHERE trigger_row.tgrelid IN (
    'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass,
    'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
    'arena.leaderboard_score_input_manifests'::pg_catalog.regclass,
    'arena.leaderboard_rank_mutation_fences'::pg_catalog.regclass,
    'arena.leaderboard_rank_generation_manifest_bindings'::pg_catalog.regclass,
    'arena.leaderboard_rank_generation_batch_receipts'::pg_catalog.regclass,
    'arena.leaderboard_rank_generation_source_fence_receipts'::pg_catalog.regclass
  );

  IF v_trigger_digest IS DISTINCT FROM
       '212d8a20f2bf2dbeb1c20396e1630d8ebeb87b0fa082ce1b1bed658f42850b8d' THEN
    RAISE EXCEPTION 'generation receipt exact trigger contract drifted: %',
      v_trigger_digest;
  END IF;
END
$trigger_postflight$;

COMMIT;
