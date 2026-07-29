-- Attested owner-only atomic writer for one claimed leaderboard-rank batch.
--
-- This function is deliberately not an API RPC and grants no API role.
-- Batch zero freezes the verified scorer manifest into immutable fixed chunks.
-- Every later batch verifies only its typed chunk while retaining exact prefix,
-- mutation-fence, persisted-evidence, receipt, and head-CAS authority.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL quote_all_identifiers = 'off';

-- The head is the admission gate for every mutable generation writer. EXCLUSIVE
-- waits for an already-running writer to finish before this transaction holds
-- any downstream catalog lock, and blocks a new writer's SELECT FOR UPDATE while
-- still allowing read-only frozen receipt replay. After that quiescence barrier,
-- freeze the recursive rank target before its fence/receipt dependencies.
LOCK TABLE ONLY arena.leaderboard_rank_generation_heads IN EXCLUSIVE MODE;
LOCK TABLE public.leaderboard_ranks IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_claims IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_score_input_manifests IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_mutation_fences IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_manifest_bindings
  IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_batch_receipts
  IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_source_fence_receipts
  IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_manifest_attestations IN SHARE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_manifest_attestation_chunks
  IN SHARE MODE;

DO $dependency_preflight$
DECLARE
  v_writer oid := pg_catalog.to_regprocedure(
    'arena.write_leaderboard_rank_generation_batch_v1(text,bigint,uuid,integer,uuid,text,text[],arena.leaderboard_rank_batch_row_v1[])'
  );
  v_column_count integer;
  v_column_contract_sha256 text;
  v_partition_count integer;
  v_partition_digest text;
  v_dependency_catalog_digest text;
  v_dependency_acl_digest text;
  v_dependency_catalog_count integer;
  v_dependency_acl_count integer;
  v_rank_trigger_count integer;
  v_rank_trigger_digest text;
  v_child_trigger_count integer;
  v_mdd_attnum smallint;
  v_parent_mdd_count integer;
  v_parent_mdd_bad_count integer;
  v_child_mdd_count integer;
  v_child_mdd_bad_count integer;
  v_unique_arbiter_count integer;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regtype(
          'arena.leaderboard_rank_batch_row_v1'
        ) IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL
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
          'arena.leaderboard_rank_mutation_fences'
        ) IS NULL
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION
      'atomic batch writer requires PG17 and the complete rank-generation substrate';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'arena'
      AND function_row.proname =
          'write_leaderboard_rank_generation_batch_v1'
      AND function_row.oid IS DISTINCT FROM v_writer
  ) THEN
    RAISE EXCEPTION 'atomic batch writer has a noncanonical overload';
  END IF;

  IF v_writer IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_writer
      AND pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(function_row.prosrc, 'UTF8')
            ),
            'hex'
          ) =
          '2f31f274ddac524b3de3eac8962fa079414b790807f57e509acc5eb3686d005a'
  ) THEN
    RAISE EXCEPTION 'attested writer requires the exact atomic writer baseline';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)',
          '5ad11771903cd9828c5911c0e534143a4b2d99285864abee63203ec40c1725f2'
        ),
        (
          'arena.validate_leaderboard_rank_generation_manifest_binding()',
          '43d006071c25fe6bfd0d8f3c146594f415f388d2a7607663e5220922d80c5781'
        ),
        (
          'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)',
          '947062aaac0da5bbe9fa62d5194c9f5f3a2e4d6bec55e158ea87ce70a38074cb'
        ),
        (
          'arena.verify_leaderboard_score_input_manifest_v1(uuid)',
          '7b678b4d1c9a6835567040e1240d09b15ce38357e3f40251c8b3786ec65f45fc'
        ),
        (
          'arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks)',
          'e667a6cadd6c0c21ecfa2bb920e6583f511a8e6f1c77e5e92f1a1bec36d6122e'
        ),
        (
          'arena.build_leaderboard_rank_batch_evidence_v1(text,uuid,jsonb)',
          'bdecbbc94ffbfd966122651552c09e3509f7bb1e87a36f5eb31a31315ea0770b'
        ),
        (
          'arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])',
          '7fa1e9f60a7b6cb4072dce842ddd10c367046fcb431a2ae655a9a806172df67e'
        ),
        (
          'arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])',
          'f82b8b26dee4b1b5a92d4750ad42ed65d91bd7972bac0ef0f14f0b94e24f197d'
        ),
        (
          'arena.bump_leaderboard_rank_insert_fences()',
          'cf3808e69052db07cdb4f91b83ee439bf8cf928946937234a1b9fa1ceeb60346'
        ),
        (
          'arena.bump_leaderboard_rank_update_fences()',
          '5fc20077fac67420cf5800ed93d57ebe0ae7973186747c3989122a1ce0f27779'
        ),
        (
          'arena.bump_leaderboard_rank_delete_fences()',
          '4af4b6fc3e30626117570097365e4039251301bcfdb24ca68d4bbef56cb03a2b'
        ),
        (
          'arena.reject_leaderboard_rank_publication_mutation()',
          '3896caded6f9f7062305267ebf4d99f05f8e6299711d00b8a252d5d043b26e2e'
        )
    ) AS expected(signature, body_sha256)
    LEFT JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = pg_catalog.to_regprocedure(expected.signature)
    WHERE function_row.oid IS NULL
       OR function_row.proowner <> 'postgres'::pg_catalog.regrole
       OR function_row.prokind <> 'f'
       OR function_row.prosqlbody IS NOT NULL
       OR function_row.probin IS NOT NULL
       OR pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(function_row.prosrc, 'UTF8')
            ),
            'hex'
          ) IS DISTINCT FROM expected.body_sha256
  ) THEN
    RAISE EXCEPTION 'atomic batch writer dependency catalog drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE (
      (
        namespace_row.nspname = 'public'
        AND function_row.proname = 'claim_leaderboard_rank_generation'
      )
      OR (
        namespace_row.nspname = 'arena'
        AND function_row.proname IN (
          'validate_leaderboard_rank_generation_manifest_binding',
          'encode_leaderboard_score_input_manifest_v1',
          'verify_leaderboard_score_input_manifest_v1',
          'encode_leaderboard_rank_row_v1',
          'build_leaderboard_rank_batch_evidence_v1',
          'build_leaderboard_rank_typed_batch_evidence_v1',
          'build_leaderboard_rank_generation_write_set_sha256_v1',
          'bump_leaderboard_rank_insert_fences',
          'bump_leaderboard_rank_update_fences',
          'bump_leaderboard_rank_delete_fences',
          'reject_leaderboard_rank_publication_mutation'
        )
      )
    )
      AND function_row.oid NOT IN (
        'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'
          ::pg_catalog.regprocedure,
        'arena.validate_leaderboard_rank_generation_manifest_binding()'
          ::pg_catalog.regprocedure,
        'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)'
          ::pg_catalog.regprocedure,
        'arena.verify_leaderboard_score_input_manifest_v1(uuid)'
          ::pg_catalog.regprocedure,
        'arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks)'
          ::pg_catalog.regprocedure,
        'arena.build_leaderboard_rank_batch_evidence_v1(text,uuid,jsonb)'
          ::pg_catalog.regprocedure,
        'arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])'
          ::pg_catalog.regprocedure,
        'arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])'
          ::pg_catalog.regprocedure,
        'arena.bump_leaderboard_rank_insert_fences()'
          ::pg_catalog.regprocedure,
        'arena.bump_leaderboard_rank_update_fences()'
          ::pg_catalog.regprocedure,
        'arena.bump_leaderboard_rank_delete_fences()'
          ::pg_catalog.regprocedure,
        'arena.reject_leaderboard_rank_publication_mutation()'
          ::pg_catalog.regprocedure
      )
  ) THEN
    RAISE EXCEPTION 'atomic batch writer dependency overload drifted';
  END IF;

  WITH expected(signature) AS (
    VALUES
      ('public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'),
      ('arena.validate_leaderboard_rank_generation_manifest_binding()'),
      ('arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)'),
      ('arena.verify_leaderboard_score_input_manifest_v1(uuid)'),
      ('arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks)'),
      ('arena.build_leaderboard_rank_batch_evidence_v1(text,uuid,jsonb)'),
      ('arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])'),
      ('arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])'),
      ('arena.bump_leaderboard_rank_insert_fences()'),
      ('arena.bump_leaderboard_rank_update_fences()'),
      ('arena.bump_leaderboard_rank_delete_fences()'),
      ('arena.reject_leaderboard_rank_publication_mutation()')
  ), resolved AS MATERIALIZED (
    SELECT expected.signature, function_row.*, language_row.lanname
    FROM expected
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = pg_catalog.to_regprocedure(expected.signature)
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
  ), catalog_preimage AS (
    SELECT pg_catalog.jsonb_build_array(
      'leaderboard-rank-atomic-writer-dependency-catalog@1',
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'signature', resolved.signature,
          'owner', pg_catalog.pg_get_userbyid(resolved.proowner),
          'language', resolved.lanname,
          'kind', resolved.prokind,
          'volatility', resolved.provolatile,
          'parallel', resolved.proparallel,
          'securityDefiner', resolved.prosecdef,
          'leakproof', resolved.proleakproof,
          'strict', resolved.proisstrict,
          'returnsSet', resolved.proretset,
          'returnType', pg_catalog.format_type(resolved.prorettype, NULL),
          'argumentTypes', pg_catalog.oidvectortypes(resolved.proargtypes),
          'argumentNames', pg_catalog.to_jsonb(resolved.proargnames),
          'argumentModes', pg_catalog.to_jsonb(resolved.proargmodes),
          'argumentDefaults', resolved.pronargdefaults,
          'config', pg_catalog.to_jsonb(resolved.proconfig),
          'cost', resolved.procost,
          'rows', resolved.prorows,
          'support', resolved.prosupport::integer,
          'sqlBodyIsNull', resolved.prosqlbody IS NULL,
          'bin', resolved.probin,
          'bodySha256', pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(resolved.prosrc, 'UTF8')
            ),
            'hex'
          )
        )
        ORDER BY resolved.signature COLLATE pg_catalog."C"
      )
    ) AS value,
    pg_catalog.count(*)::integer AS entry_count
    FROM resolved
  ), acl_preimage AS (
    SELECT pg_catalog.jsonb_build_array(
      'leaderboard-rank-atomic-writer-dependency-acl@1',
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'signature', resolved.signature,
          'grantor', pg_catalog.pg_get_userbyid(expanded.grantor),
          'grantee', CASE expanded.grantee
            WHEN 0 THEN 'PUBLIC'
            ELSE pg_catalog.pg_get_userbyid(expanded.grantee)
          END,
          'privilege', expanded.privilege_type,
          'grantable', expanded.is_grantable
        )
        ORDER BY
          resolved.signature COLLATE pg_catalog."C",
          expanded.grantee,
          expanded.grantor,
          expanded.privilege_type COLLATE pg_catalog."C",
          expanded.is_grantable
      )
    ) AS value,
    pg_catalog.count(*)::integer AS entry_count
    FROM resolved
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        resolved.proacl,
        pg_catalog.acldefault('f', resolved.proowner)
      )
    ) AS expanded
  )
  SELECT
    catalog_preimage.entry_count,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(catalog_preimage.value::text, 'UTF8')
      ),
      'hex'
    ),
    acl_preimage.entry_count,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(acl_preimage.value::text, 'UTF8')
      ),
      'hex'
    )
  INTO STRICT
    v_dependency_catalog_count,
    v_dependency_catalog_digest,
    v_dependency_acl_count,
    v_dependency_acl_digest
  FROM catalog_preimage
  CROSS JOIN acl_preimage;

  IF v_dependency_catalog_count IS DISTINCT FROM 12
     OR v_dependency_acl_count IS DISTINCT FROM 13
     OR v_dependency_catalog_digest IS DISTINCT FROM
       'cbd7e49f7890141ba10d9f8c90d382ebbfa62e007b073ec5f540a5ed4ef16d89'
     OR v_dependency_acl_digest IS DISTINCT FROM
       'e8d93b0faac5f16601a1b7a3e750fe46345ec2465e67297bb52fefdf005cdd74'
  THEN
    RAISE EXCEPTION
      'atomic batch writer dependency catalog or ACL digest drifted: %, %',
      v_dependency_catalog_count::text || '|' ||
        COALESCE(v_dependency_catalog_digest, '-'),
      v_dependency_acl_count::text || '|' ||
        COALESCE(v_dependency_acl_digest, '-');
  END IF;

  -- Every private dependency is owner-only. The service-only public claim RPC
  -- is pinned by the exact ACL digest above.
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
      'arena.validate_leaderboard_rank_generation_manifest_binding()'
        ::pg_catalog.regprocedure,
      'arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)'
        ::pg_catalog.regprocedure,
      'arena.verify_leaderboard_score_input_manifest_v1(uuid)'
        ::pg_catalog.regprocedure,
      'arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks)'
        ::pg_catalog.regprocedure,
      'arena.build_leaderboard_rank_batch_evidence_v1(text,uuid,jsonb)'
        ::pg_catalog.regprocedure,
      'arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])'
        ::pg_catalog.regprocedure,
      'arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])'
        ::pg_catalog.regprocedure,
      'arena.bump_leaderboard_rank_insert_fences()'
        ::pg_catalog.regprocedure,
      'arena.bump_leaderboard_rank_update_fences()'
        ::pg_catalog.regprocedure,
      'arena.bump_leaderboard_rank_delete_fences()'
        ::pg_catalog.regprocedure,
      'arena.reject_leaderboard_rank_publication_mutation()'
        ::pg_catalog.regprocedure
    )
      AND expanded.grantee <> function_row.proowner
      AND expanded.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'atomic batch writer dependency ACL drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'::pg_catalog.regprocedure,
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'::pg_catalog.regprocedure,
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'::pg_catalog.regprocedure,
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM (
         VALUES ('anon'), ('authenticated'), ('service_role')
       ) AS api(role_name)
       CROSS JOIN (
         VALUES
           ('arena.validate_leaderboard_rank_generation_manifest_binding()'::regprocedure),
           ('arena.encode_leaderboard_score_input_manifest_v1(text,text,text,text,jsonb,text,jsonb,text,jsonb,jsonb,timestamptz)'::regprocedure),
           ('arena.verify_leaderboard_score_input_manifest_v1(uuid)'::regprocedure),
           ('arena.encode_leaderboard_rank_row_v1(public.leaderboard_ranks)'::regprocedure),
           ('arena.build_leaderboard_rank_batch_evidence_v1(text,uuid,jsonb)'::regprocedure),
           ('arena.build_leaderboard_rank_typed_batch_evidence_v1(text,uuid,timestamptz,arena.leaderboard_rank_batch_row_v1[])'::regprocedure),
           ('arena.build_leaderboard_rank_generation_write_set_sha256_v1(text,uuid,text,timestamptz,integer,text[])'::regprocedure),
           ('arena.bump_leaderboard_rank_insert_fences()'::regprocedure),
           ('arena.bump_leaderboard_rank_update_fences()'::regprocedure),
           ('arena.bump_leaderboard_rank_delete_fences()'::regprocedure),
           ('arena.reject_leaderboard_rank_publication_mutation()'::regprocedure)
       ) AS private_dependency(function_oid)
       WHERE pg_catalog.has_function_privilege(
         api.role_name,
         private_dependency.function_oid,
         'EXECUTE'
       )
     ) THEN
    RAISE EXCEPTION 'atomic batch writer dependency effective ACL drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    WHERE table_row.oid = 'public.leaderboard_ranks'::pg_catalog.regclass
      AND table_row.relkind = 'p'
      AND table_row.relpersistence = 'p'
      AND table_row.relowner = 'postgres'::pg_catalog.regrole
      AND pg_catalog.pg_get_partkeydef(table_row.oid) = 'LIST (season_id)'
  ) THEN
    RAISE EXCEPTION 'atomic batch writer rank parent drifted';
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            pg_catalog.format(
              '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
              attribute.attnum,
              attribute.attname,
              pg_catalog.format_type(
                attribute.atttypid,
                attribute.atttypmod
              ),
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
            E'\n' ORDER BY attribute.attnum
          ),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO STRICT v_column_count, v_column_contract_sha256
  FROM pg_catalog.pg_attribute AS attribute
  LEFT JOIN pg_catalog.pg_attrdef AS default_row
    ON default_row.adrelid = attribute.attrelid
   AND default_row.adnum = attribute.attnum
  WHERE attribute.attrelid =
        'public.leaderboard_ranks'::pg_catalog.regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

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

  SELECT attribute.attnum
  INTO STRICT v_mdd_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid =
        'public.leaderboard_ranks'::pg_catalog.regclass
    AND attribute.attname = 'max_drawdown'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) FILTER (
      WHERE NOT constraint_row.convalidated
         OR constraint_row.conname IS DISTINCT FROM
              'leaderboard_ranks_max_drawdown_positive_check'
         OR constraint_row.conkey IS DISTINCT FROM
              ARRAY[v_mdd_attnum]::smallint[]
         OR pg_catalog.pg_get_expr(
              constraint_row.conbin,
              constraint_row.conrelid,
              false
            ) IS DISTINCT FROM
              '((max_drawdown IS NULL) OR ((max_drawdown >= (0)::numeric) AND (max_drawdown <= (100)::numeric)))'
    )::integer
  INTO STRICT v_parent_mdd_count, v_parent_mdd_bad_count
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
        'public.leaderboard_ranks'::pg_catalog.regclass
    AND constraint_row.contype = 'c'
    AND v_mdd_attnum = ANY(constraint_row.conkey);

  WITH RECURSIVE descendants(relation_oid) AS (
    SELECT inheritance.inhrelid
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhparent =
          'public.leaderboard_ranks'::pg_catalog.regclass
    UNION ALL
    SELECT inheritance.inhrelid
    FROM descendants
    JOIN pg_catalog.pg_inherits AS inheritance
      ON inheritance.inhparent = descendants.relation_oid
  )
  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) FILTER (
      WHERE NOT constraint_row.convalidated
         OR pg_catalog.pg_get_expr(
              constraint_row.conbin,
              constraint_row.conrelid,
              false
            ) IS DISTINCT FROM
              '((max_drawdown IS NULL) OR ((max_drawdown >= (0)::numeric) AND (max_drawdown <= (100)::numeric)))'
    )::integer
  INTO STRICT v_child_mdd_count, v_child_mdd_bad_count
  FROM pg_catalog.pg_constraint AS constraint_row
  JOIN descendants
    ON descendants.relation_oid = constraint_row.conrelid
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = constraint_row.conrelid
   AND attribute.attname = 'max_drawdown'
   AND attribute.attnum = ANY(constraint_row.conkey)
  WHERE constraint_row.contype = 'c';

  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_unique_arbiter_count
  FROM pg_catalog.pg_constraint AS constraint_row
  JOIN pg_catalog.pg_index AS index_row
    ON index_row.indexrelid = constraint_row.conindid
  WHERE constraint_row.conrelid =
        'public.leaderboard_ranks'::pg_catalog.regclass
    AND constraint_row.contype = 'u'
    AND constraint_row.convalidated
    AND NOT constraint_row.condeferrable
    AND NOT constraint_row.condeferred
    AND index_row.indisunique
    AND index_row.indisvalid
    AND index_row.indisready
    AND index_row.indislive
    AND index_row.indpred IS NULL
    AND index_row.indexprs IS NULL
    AND pg_catalog.pg_get_constraintdef(
          constraint_row.oid,
          false
        ) = 'UNIQUE (season_id, source, source_trader_id)';

  IF v_column_count <> 37
     OR v_column_contract_sha256 IS DISTINCT FROM
          'df9746fe0917680970f22309413dd082c54d6cb0c43d0f65250ab3bc21c1406a'
     OR v_partition_count <> 4
     OR v_partition_digest IS DISTINCT FROM
          'ef570914223b68d4ce4f9c5e9217a2a6b0b052c79a6e660c71916441b4e4ab25'
     OR v_parent_mdd_count IS DISTINCT FROM 1
     OR v_parent_mdd_bad_count IS DISTINCT FROM 0
     OR v_child_mdd_count IS DISTINCT FROM v_partition_count
     OR v_child_mdd_bad_count IS DISTINCT FROM 0
     OR v_unique_arbiter_count IS DISTINCT FROM 1
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid =
             'public.leaderboard_ranks'::pg_catalog.regclass
         AND constraint_row.conname =
             'leaderboard_ranks_max_drawdown_positive_check'
         AND constraint_row.contype = 'c'
         AND constraint_row.convalidated
         AND pg_catalog.pg_get_expr(
               constraint_row.conbin,
               constraint_row.conrelid,
               false
             ) = '((max_drawdown IS NULL) OR ((max_drawdown >= (0)::numeric) AND (max_drawdown <= (100)::numeric)))'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint AS constraint_row
       JOIN pg_catalog.pg_index AS index_row
         ON index_row.indexrelid = constraint_row.conindid
       WHERE constraint_row.conrelid =
             'public.leaderboard_ranks'::pg_catalog.regclass
         AND constraint_row.contype = 'u'
         AND constraint_row.convalidated
         AND index_row.indisunique
         AND index_row.indisvalid
         AND index_row.indisready
         AND index_row.indislive
         AND pg_catalog.pg_get_constraintdef(
               constraint_row.oid,
               false
             ) = 'UNIQUE (season_id, source, source_trader_id)'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       JOIN pg_catalog.pg_attrdef AS default_row
         ON default_row.adrelid = attribute.attrelid
        AND default_row.adnum = attribute.attnum
       JOIN pg_catalog.pg_class AS sequence_row
         ON sequence_row.oid =
              'public.leaderboard_ranks_id_seq'::pg_catalog.regclass
       JOIN pg_catalog.pg_sequence AS sequence_catalog
         ON sequence_catalog.seqrelid = sequence_row.oid
       WHERE attribute.attrelid =
             'public.leaderboard_ranks'::pg_catalog.regclass
         AND attribute.attnum = 1
         AND attribute.attname = 'id'
         AND attribute.atttypid = 'pg_catalog.int8'::pg_catalog.regtype
         AND attribute.attnotnull
         AND attribute.atthasdef
         AND attribute.attidentity = ''
         AND attribute.attgenerated = ''
         AND pg_catalog.pg_get_expr(
               default_row.adbin,
               default_row.adrelid,
               false
             ) =
             'nextval(''public.leaderboard_ranks_id_seq''::regclass)'
         AND sequence_row.relkind = 'S'
         AND sequence_row.relpersistence = 'p'
         AND sequence_row.relowner = 'postgres'::pg_catalog.regrole
         AND NOT sequence_row.relispartition
         AND sequence_catalog.seqtypid =
             'pg_catalog.int8'::pg_catalog.regtype
         AND sequence_catalog.seqstart = 1
         AND sequence_catalog.seqincrement = 1
         AND sequence_catalog.seqmax = 9223372036854775807
         AND sequence_catalog.seqmin = 1
         AND sequence_catalog.seqcache = 1
         AND NOT sequence_catalog.seqcycle
     ) THEN
    RAISE EXCEPTION 'atomic batch writer rank target catalog drifted';
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
        ('arena.leaderboard_rank_mutation_fences'::regclass, 4)
    ) AS expected(table_oid, column_count)
    JOIN pg_catalog.pg_class AS table_row
      ON table_row.oid = expected.table_oid
    WHERE table_row.relkind <> 'r'
       OR table_row.relpersistence <> 'p'
       OR table_row.relowner <> 'postgres'::pg_catalog.regrole
       OR NOT table_row.relrowsecurity
       OR table_row.relforcerowsecurity
       OR expected.column_count <> (
         SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = expected.table_oid
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
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
      'arena.leaderboard_rank_mutation_fences'::regclass
    )
      AND expanded.grantee <> table_row.relowner
  ) THEN
    RAISE EXCEPTION 'atomic batch writer private table catalog drifted';
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            pg_catalog.format(
              '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
              trigger_row.tgname,
              trigger_row.tgisinternal,
              trigger_row.tgtype,
              trigger_row.tgenabled,
              trigger_row.tgfoid::pg_catalog.regprocedure::text,
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
              trigger_row.tgconstraint,
              trigger_row.tgdeferrable,
              trigger_row.tginitdeferred,
              trigger_row.tgnargs,
              pg_catalog.encode(trigger_row.tgargs, 'hex'),
              trigger_row.tgparentid
            ),
            E'\n' ORDER BY trigger_row.tgname COLLATE pg_catalog."C"
          ),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO STRICT v_rank_trigger_count, v_rank_trigger_digest
  FROM pg_catalog.pg_trigger AS trigger_row
  WHERE trigger_row.tgrelid =
        'public.leaderboard_ranks'::pg_catalog.regclass;

  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_child_trigger_count
  FROM pg_catalog.pg_trigger AS trigger_row
  JOIN pg_catalog.pg_inherits AS inheritance
    ON inheritance.inhrelid = trigger_row.tgrelid
  WHERE inheritance.inhparent =
        'public.leaderboard_ranks'::pg_catalog.regclass;

  IF v_rank_trigger_count IS DISTINCT FROM 3
     OR v_rank_trigger_digest IS DISTINCT FROM
       'f93d0866593dddf4736d0a95a4529973d8ee1c15aa2d53a7e053b04c725c0063'
     OR v_child_trigger_count IS DISTINCT FROM 0
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_inherits AS inheritance
       JOIN pg_catalog.pg_class AS child
         ON child.oid = inheritance.inhrelid
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           child.relacl,
           pg_catalog.acldefault('r', child.relowner)
         )
       ) AS expanded
       WHERE inheritance.inhparent =
             'public.leaderboard_ranks'::pg_catalog.regclass
         AND expanded.grantee <> child.relowner
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_inherits AS inheritance
       JOIN pg_catalog.pg_class AS child
         ON child.oid = inheritance.inhrelid
       JOIN pg_catalog.pg_attribute AS attribute
         ON attribute.attrelid = child.oid
       CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS expanded
       WHERE inheritance.inhparent =
             'public.leaderboard_ranks'::pg_catalog.regclass
         AND expanded.grantee <> child.relowner
     )
     OR EXISTS (
       SELECT 1
       FROM (
         VALUES ('anon'), ('authenticated'), ('service_role')
       ) AS api(role_name)
       CROSS JOIN LATERAL (
         SELECT inheritance.inhrelid AS table_oid
         FROM pg_catalog.pg_inherits AS inheritance
         WHERE inheritance.inhparent =
               'public.leaderboard_ranks'::pg_catalog.regclass
       ) AS child
       WHERE pg_catalog.has_table_privilege(
         api.role_name,
         child.table_oid,
         'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
       ) OR pg_catalog.has_any_column_privilege(
         api.role_name,
         child.table_oid,
         'INSERT,UPDATE,REFERENCES'
       )
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_rewrite AS rule_row
       WHERE rule_row.ev_class =
             'public.leaderboard_ranks'::pg_catalog.regclass
          OR rule_row.ev_class IN (
            SELECT inheritance.inhrelid
            FROM pg_catalog.pg_inherits AS inheritance
            WHERE inheritance.inhparent =
                  'public.leaderboard_ranks'::pg_catalog.regclass
          )
     ) THEN
    RAISE EXCEPTION
      'atomic batch writer mutation trigger or child ACL topology drifted: % % %',
      v_rank_trigger_count,
      v_rank_trigger_digest,
      v_child_trigger_count;
  END IF;
END
$dependency_preflight$;

DO $authority_catalog_preflight$
DECLARE
  v_class_count integer;
  v_class_digest text;
  v_internal_column_count integer;
  v_internal_column_digest text;
  v_constraint_count integer;
  v_constraint_digest text;
  v_index_count integer;
  v_index_digest text;
  v_trigger_count integer;
  v_trigger_digest text;
  v_type_oid oid :=
    'arena.leaderboard_rank_batch_row_v1'::pg_catalog.regtype;
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
    AND NOT relation_row.relispartition;

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
         AND expanded.grantee <> 'postgres'::pg_catalog.regrole
     )
     OR EXISTS (
       SELECT 1
       FROM (
         VALUES ('anon'), ('authenticated'), ('service_role')
       ) AS api(role_name)
       WHERE pg_catalog.has_type_privilege(
         api.role_name,
         v_type_oid,
         'USAGE'
       )
     ) THEN
    RAISE EXCEPTION
      'atomic writer typed batch catalog drifted: % %',
      v_type_column_count,
      v_type_column_digest;
  END IF;

  WITH target(table_oid) AS (
    SELECT pg_catalog.unnest(ARRAY[
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_mutation_fences'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
    ]::regclass[])
  )
  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            pg_catalog.format(
              '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s|%s',
              namespace_row.nspname,
              table_row.relname,
              table_row.relkind,
              table_row.relpersistence,
              pg_catalog.pg_get_userbyid(table_row.relowner),
              table_row.relrowsecurity,
              table_row.relforcerowsecurity,
              table_row.relispartition,
              table_row.relreplident,
              access_method.amname,
              COALESCE(table_row.reloptions::text, '')
            ),
            E'\n' ORDER BY
              namespace_row.nspname COLLATE pg_catalog."C",
              table_row.relname COLLATE pg_catalog."C"
          ),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO STRICT v_class_count, v_class_digest
  FROM target
  JOIN pg_catalog.pg_class AS table_row
    ON table_row.oid = target.table_oid
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = table_row.relnamespace
  JOIN pg_catalog.pg_am AS access_method
    ON access_method.oid = table_row.relam;

  WITH target(table_oid) AS (
    SELECT pg_catalog.unnest(ARRAY[
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_mutation_fences'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
    ]::regclass[])
  )
  SELECT
    pg_catalog.count(*)::integer,
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
            E'\n' ORDER BY
              table_row.relname COLLATE pg_catalog."C",
              attribute.attnum
          ),
          'UTF8'
        )
      ),
      'hex'
    )
  INTO STRICT v_internal_column_count, v_internal_column_digest
  FROM target
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = target.table_oid
  JOIN pg_catalog.pg_class AS table_row
    ON table_row.oid = attribute.attrelid
  LEFT JOIN pg_catalog.pg_attrdef AS default_row
    ON default_row.adrelid = attribute.attrelid
   AND default_row.adnum = attribute.attnum
  WHERE attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.encode(
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
            E'\n' ORDER BY
              table_row.relname COLLATE pg_catalog."C",
              constraint_row.conname COLLATE pg_catalog."C"
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
    'arena.leaderboard_rank_generation_heads'::regclass,
    'arena.leaderboard_rank_generation_claims'::regclass,
    'arena.leaderboard_score_input_manifests'::regclass,
    'arena.leaderboard_rank_mutation_fences'::regclass,
    'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
    'arena.leaderboard_rank_generation_batch_receipts'::regclass,
    'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
  );

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.encode(
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
            E'\n' ORDER BY
              table_row.relname COLLATE pg_catalog."C",
              index_class.relname COLLATE pg_catalog."C"
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
  WHERE index_row.indrelid IN (
    'arena.leaderboard_rank_generation_heads'::regclass,
    'arena.leaderboard_rank_generation_claims'::regclass,
    'arena.leaderboard_score_input_manifests'::regclass,
    'arena.leaderboard_rank_mutation_fences'::regclass,
    'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
    'arena.leaderboard_rank_generation_batch_receipts'::regclass,
    'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
  );

  SELECT
    pg_catalog.count(*)::integer,
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
              table_row.relname COLLATE pg_catalog."C",
              COALESCE(constraint_row.conname, '') COLLATE pg_catalog."C",
              trigger_function.proname COLLATE pg_catalog."C",
              trigger_row.tgtype,
              CASE
                WHEN trigger_row.tgisinternal THEN ''
                ELSE trigger_row.tgname
              END COLLATE pg_catalog."C"
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
    'arena.leaderboard_rank_generation_heads'::regclass,
    'arena.leaderboard_rank_generation_claims'::regclass,
    'arena.leaderboard_score_input_manifests'::regclass,
    'arena.leaderboard_rank_mutation_fences'::regclass,
    'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
    'arena.leaderboard_rank_generation_batch_receipts'::regclass,
    'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
  );

  IF v_class_count IS DISTINCT FROM 7
     OR v_class_digest IS DISTINCT FROM
       '702c23f06b92eee8199a4b5fbdb631dfa590b4362f33472724356ddeb08df5f2'
     OR v_internal_column_count IS DISTINCT FROM 58
     OR v_internal_column_digest IS DISTINCT FROM
       '12ad1eb83b64d93eb76d6cf79c230bace3e96a904a9bbd8e71d53899e1badb03'
     OR v_constraint_count IS DISTINCT FROM 67
     OR v_constraint_digest IS DISTINCT FROM
       '3ca12a4bf3676a79159ba7fce02bdf300b5b54c7680afbc334423757fc65265d'
     OR v_index_count IS DISTINCT FROM 15
     OR v_index_digest IS DISTINCT FROM
       '0000a4d62237d0cd9a65f388cbca4c83b7a8795e435a91f38abd3e1df000c89f'
     OR v_trigger_count IS DISTINCT FROM 32
     OR v_trigger_digest IS DISTINCT FROM
       'ecca358051d6585ce6767b0e769eceafebb5016e88f8c8298da46881163637bc'
  THEN
    RAISE EXCEPTION
      'atomic writer authority catalog drifted: class % %, columns % %, constraints % %, indexes % %, triggers % %',
      v_class_count,
      v_class_digest,
      v_internal_column_count,
      v_internal_column_digest,
      v_constraint_count,
      v_constraint_digest,
      v_index_count,
      v_index_digest,
      v_trigger_count,
      v_trigger_digest;
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
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_mutation_fences'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
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
      'arena.leaderboard_rank_mutation_fences'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
    )
      AND expanded.grantee <> (
        SELECT table_row.relowner
        FROM pg_catalog.pg_class AS table_row
        WHERE table_row.oid = attribute.attrelid
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_mutation_fences'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rule_row
    WHERE rule_row.ev_class IN (
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_mutation_fences'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_mutation_fences'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
    ) OR inheritance.inhparent IN (
      'arena.leaderboard_rank_generation_heads'::regclass,
      'arena.leaderboard_rank_generation_claims'::regclass,
      'arena.leaderboard_score_input_manifests'::regclass,
      'arena.leaderboard_rank_mutation_fences'::regclass,
      'arena.leaderboard_rank_generation_manifest_bindings'::regclass,
      'arena.leaderboard_rank_generation_batch_receipts'::regclass,
      'arena.leaderboard_rank_generation_source_fence_receipts'::regclass
    )
  ) OR EXISTS (
    SELECT 1
    FROM (
      VALUES ('anon'), ('authenticated'), ('service_role')
    ) AS api(role_name)
    CROSS JOIN (
      VALUES
        ('arena.leaderboard_rank_generation_heads'::regclass),
        ('arena.leaderboard_rank_generation_claims'::regclass),
        ('arena.leaderboard_score_input_manifests'::regclass),
        ('arena.leaderboard_rank_mutation_fences'::regclass),
        ('arena.leaderboard_rank_generation_manifest_bindings'::regclass),
        ('arena.leaderboard_rank_generation_batch_receipts'::regclass),
        ('arena.leaderboard_rank_generation_source_fence_receipts'::regclass)
    ) AS target(table_oid)
    WHERE pg_catalog.has_table_privilege(
      api.role_name,
      target.table_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) OR pg_catalog.has_any_column_privilege(
      api.role_name,
      target.table_oid,
      'SELECT,INSERT,UPDATE,REFERENCES'
    )
  ) THEN
    RAISE EXCEPTION 'atomic writer authority ACL topology drifted';
  END IF;
END
$authority_catalog_preflight$;

DO $attestation_dependency_preflight$
BEGIN
  IF pg_catalog.to_regprocedure(
       'arena.build_leaderboard_rank_typed_field_commitment_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'
     ) IS NOT NULL OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'arena'
      AND function_row.proname =
          'build_leaderboard_rank_typed_field_commitment_v1'
  ) THEN
    RAISE EXCEPTION 'typed manifest commitment helper already exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.build_leaderboard_rank_manifest_chunk_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb)', '0dddcffebb56d9a51e0869e29cc16ac18f78251d58907764fb02101fa8dad322'),
        ('arena.build_leaderboard_rank_manifest_chunks_sha256_v1(text,bigint,uuid,uuid,text,integer,integer,jsonb)', 'a663274e1a45e06c90f17fecdb646854be6112cb6e22d2af343afd9737d365dd'),
        ('arena.build_leaderboard_rank_manifest_field_commitment_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)', '72c4e558313daec92785722c35788e6490a4d9a2144261d0afe9d96666ea04f6'),
        ('arena.encode_leaderboard_rank_manifest_fields_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)', '504e8b8fc47f023bb9e821b7b6212f4df773cb94e63cfd5613fb2fff01964b16'),
        ('arena.guard_leaderboard_rank_manifest_attestation_chunk_insert_v1()', '21cbd784ed8016f1a3acbe96ff82885d5679dce10697ddb658cb660ef449caa9'),
        ('arena.leaderboard_rank_manifest_attestation_chunk_is_valid_v1(text,bigint,uuid,uuid,text,integer,integer,integer,jsonb,jsonb,text)', 'eaead90785261fd8400748497005d34013d468b5a836a0dbce0be38eaf843d07'),
        ('arena.validate_leaderboard_rank_manifest_attestation_complete_v1()', 'a67d03810591c130b7b6e7dbd63becc9b4d08eb4580fd314a223032e1f187e6b')
    ) AS expected(signature, body_sha256)
    LEFT JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = pg_catalog.to_regprocedure(expected.signature)
    WHERE function_row.oid IS NULL
       OR function_row.proowner <> 'postgres'::pg_catalog.regrole
       OR pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(function_row.prosrc, 'UTF8')
            ),
            'hex'
          ) <> expected.body_sha256
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (
      'arena.leaderboard_rank_manifest_attestations'::regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::regclass
    )
  ) <> 23 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'arena.leaderboard_rank_manifest_attestations'::regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::regclass
    )
      AND NOT trigger_row.tgisinternal
  ) <> 6 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation_row
    WHERE relation_row.oid IN (
      'arena.leaderboard_rank_manifest_attestations'::regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::regclass
    )
      AND (
        relation_row.relowner <> 'postgres'::pg_catalog.regrole
        OR NOT relation_row.relrowsecurity
        OR relation_row.relforcerowsecurity
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      'arena.leaderboard_rank_manifest_attestations'::regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::regclass
    )
  ) OR EXISTS (
    SELECT 1
    FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS api(role_name)
    CROSS JOIN (VALUES
      ('arena.leaderboard_rank_manifest_attestations'::regclass),
      ('arena.leaderboard_rank_manifest_attestation_chunks'::regclass)
    ) AS target(table_oid)
    WHERE pg_catalog.has_table_privilege(
      api.role_name,
      target.table_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) OR pg_catalog.has_any_column_privilege(
      api.role_name,
      target.table_oid,
      'SELECT,INSERT,UPDATE,REFERENCES'
    )
  ) THEN
    RAISE EXCEPTION 'attested writer dependency topology drifted';
  END IF;

  IF EXISTS (
    SELECT legacy.season_id
    FROM (
      SELECT
        binding.season_id,
        binding.generation_seq,
        binding.score_cohort_id,
        binding.score_input_manifest_id,
        binding.score_input_manifest_digest
      FROM ONLY arena.leaderboard_rank_generation_manifest_bindings
        AS binding
      UNION
      SELECT
        receipt.season_id,
        receipt.generation_seq,
        receipt.score_cohort_id,
        receipt.score_input_manifest_id,
        receipt.score_input_manifest_digest
      FROM ONLY arena.leaderboard_rank_generation_batch_receipts AS receipt
    ) AS legacy
    WHERE NOT EXISTS (
      SELECT 1
      FROM ONLY arena.leaderboard_rank_manifest_attestations AS header
      WHERE header.season_id = legacy.season_id
        AND header.generation_seq = legacy.generation_seq
        AND header.score_cohort_id = legacy.score_cohort_id
        AND header.score_input_manifest_id = legacy.score_input_manifest_id
        AND header.score_input_manifest_digest =
              legacy.score_input_manifest_digest
    )
  ) THEN
    RAISE EXCEPTION
      'attested writer refuses any legacy generation receipt without attestation'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ONLY arena.leaderboard_rank_generation_heads AS head
    LEFT JOIN ONLY arena.leaderboard_rank_generation_claims AS claim
      ON claim.season_id = head.season_id
     AND claim.generation_seq = head.generation_seq
     AND claim.score_cohort_id = head.score_cohort_id
    WHERE head.phase IN ('claimed', 'writing')
      AND (
        claim.season_id IS NULL
        OR claim.expected_rank_count NOT BETWEEN 1 AND 64000
        OR claim.expected_batch_count NOT BETWEEN 1 AND 64
        OR claim.expected_batch_count IS DISTINCT FROM
             (claim.expected_rank_count + 999) / 1000
      )
  ) THEN
    RAISE EXCEPTION
      'attested writer refuses an active noncanonical generation plan'
      USING ERRCODE = '55000';
  END IF;
END
$attestation_dependency_preflight$;

DO $attestation_exact_preflight$
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
$attestation_exact_preflight$;

DO $attestation_catalog_digest_preflight$
DECLARE
  v_entry_count integer;
  v_digest text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'arena.leaderboard_rank_manifest_attestations'::regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::regclass
    ) OR inheritance.inhparent IN (
      'arena.leaderboard_rank_manifest_attestations'::regclass,
      'arena.leaderboard_rank_manifest_attestation_chunks'::regclass
    )
  ) THEN
    RAISE EXCEPTION 'manifest attestation inheritance topology drifted';
  END IF;

  WITH target(relation_name, relation_oid) AS (
    VALUES
      (
        'leaderboard_rank_manifest_attestations',
        'arena.leaderboard_rank_manifest_attestations'::regclass
      ),
      (
        'leaderboard_rank_manifest_attestation_chunks',
        'arena.leaderboard_rank_manifest_attestation_chunks'::regclass
      )
  ), preimage AS (
    SELECT
      pg_catalog.jsonb_build_array(
        'leaderboard-rank-manifest-attestation-relations@1',
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'relation', target.relation_name,
            'kind', relation_row.relkind,
            'persistence', relation_row.relpersistence,
            'owner', pg_catalog.pg_get_userbyid(relation_row.relowner),
            'accessMethod', access_method.amname,
            'tablespace', relation_row.reltablespace,
            'options', pg_catalog.to_jsonb(relation_row.reloptions),
            'replicaIdentity', relation_row.relreplident,
            'rowSecurity', relation_row.relrowsecurity,
            'forceRowSecurity', relation_row.relforcerowsecurity,
            'isPartition', relation_row.relispartition,
            'partitionKey', pg_catalog.pg_get_partkeydef(relation_row.oid)
          )
          ORDER BY target.relation_name COLLATE pg_catalog."C"
        )
      ) AS value,
      pg_catalog.count(*)::integer AS entry_count
    FROM target
    JOIN pg_catalog.pg_class AS relation_row
      ON relation_row.oid = target.relation_oid
    LEFT JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = relation_row.relam
  )
  SELECT
    preimage.entry_count,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(preimage.value::text, 'UTF8')
      ),
      'hex'
    )
  INTO STRICT v_entry_count, v_digest
  FROM preimage;

  IF v_entry_count IS DISTINCT FROM 2
     OR v_digest IS DISTINCT FROM
          '749c3dec466b805f710cde11b51685773ce1f114a3818994dd4669ee762f0a8d'
  THEN
    RAISE EXCEPTION 'manifest attestation relation digest drifted: %|%',
      v_entry_count, v_digest;
  END IF;

  WITH target(relation_name, relation_oid) AS (
    VALUES
      (
        'leaderboard_rank_manifest_attestations',
        'arena.leaderboard_rank_manifest_attestations'::regclass
      ),
      (
        'leaderboard_rank_manifest_attestation_chunks',
        'arena.leaderboard_rank_manifest_attestation_chunks'::regclass
      )
  ), preimage AS (
    SELECT
      pg_catalog.jsonb_build_array(
        'leaderboard-rank-manifest-attestation-columns@1',
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'relation', target.relation_name,
            'number', attribute.attnum,
            'name', attribute.attname,
            'type', pg_catalog.format_type(
              attribute.atttypid,
              attribute.atttypmod
            ),
            'notNull', attribute.attnotnull,
            'hasDefault', attribute.atthasdef,
            'default', pg_catalog.pg_get_expr(
              default_row.adbin,
              default_row.adrelid,
              false
            ),
            'identity', attribute.attidentity,
            'generated', attribute.attgenerated,
            'dimensions', attribute.attndims,
            'collation', CASE attribute.attcollation
              WHEN 0 THEN NULL
              ELSE attribute.attcollation::regcollation::text
            END,
            'storage', attribute.attstorage,
            'compression', attribute.attcompression,
            'statistics', attribute.attstattarget,
            'options', pg_catalog.to_jsonb(attribute.attoptions),
            'fdwOptions', pg_catalog.to_jsonb(attribute.attfdwoptions)
          )
          ORDER BY
            target.relation_name COLLATE pg_catalog."C",
            attribute.attnum
        )
      ) AS value,
      pg_catalog.count(*)::integer AS entry_count
    FROM target
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = target.relation_oid
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
  )
  SELECT
    preimage.entry_count,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(preimage.value::text, 'UTF8')
      ),
      'hex'
    )
  INTO STRICT v_entry_count, v_digest
  FROM preimage;

  IF v_entry_count IS DISTINCT FROM 24
     OR v_digest IS DISTINCT FROM
          'e996f0bba2e6b64df5e1dbb99543f10f72d29db0d2d40d49b5dbaf923cd3b1fd'
  THEN
    RAISE EXCEPTION 'manifest attestation column digest drifted: %|%',
      v_entry_count, v_digest;
  END IF;

  WITH target(relation_name, relation_oid) AS (
    VALUES
      (
        'leaderboard_rank_manifest_attestations',
        'arena.leaderboard_rank_manifest_attestations'::regclass
      ),
      (
        'leaderboard_rank_manifest_attestation_chunks',
        'arena.leaderboard_rank_manifest_attestation_chunks'::regclass
      )
  ), preimage AS (
    SELECT
      pg_catalog.jsonb_build_array(
        'leaderboard-rank-manifest-attestation-constraints@1',
        pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'relation', target.relation_name,
            'name', constraint_row.conname,
            'type', constraint_row.contype,
            'deferrable', constraint_row.condeferrable,
            'deferred', constraint_row.condeferred,
            'validated', constraint_row.convalidated,
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
  INTO STRICT v_entry_count, v_digest
  FROM preimage;

  IF v_entry_count IS DISTINCT FROM 23
     OR v_digest IS DISTINCT FROM
          'c35d602c1cd83660e2efa8e1e03506bfa747d5fa0e18a29cc1d6e268f71aa9ee'
  THEN
    RAISE EXCEPTION 'manifest attestation constraint digest drifted: %|%',
      v_entry_count, v_digest;
  END IF;

  WITH target(relation_name, relation_oid) AS (
    VALUES
      (
        'leaderboard_rank_manifest_attestations',
        'arena.leaderboard_rank_manifest_attestations'::regclass
      ),
      (
        'leaderboard_rank_manifest_attestation_chunks',
        'arena.leaderboard_rank_manifest_attestation_chunks'::regclass
      )
  ), preimage AS (
    SELECT
      pg_catalog.jsonb_build_array(
        'leaderboard-rank-manifest-attestation-indexes@1',
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
  INTO STRICT v_entry_count, v_digest
  FROM preimage;

  IF v_entry_count IS DISTINCT FROM 4
     OR v_digest IS DISTINCT FROM
          'b22b7e1bbb9f78e0c59f05ca36f0de7368d91d54c55f8e5917031a73dfb3884a'
  THEN
    RAISE EXCEPTION 'manifest attestation index digest drifted: %|%',
      v_entry_count, v_digest;
  END IF;
END
$attestation_catalog_digest_preflight$;

CREATE FUNCTION arena.build_leaderboard_rank_typed_field_commitment_v1(
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
          pg_catalog.jsonb_build_array(
            'leaderboard-rank-manifest-fields@1',
            p_source,
            p_source_trader_id,
            pg_catalog.trim_scale(p_roi)::text,
            pg_catalog.trim_scale(p_pnl)::text,
            pg_catalog.trim_scale(p_win_rate)::text,
            pg_catalog.trim_scale(p_max_drawdown)::text,
            CASE WHEN p_sharpe_ratio IS NULL THEN NULL
              ELSE pg_catalog.trim_scale(p_sharpe_ratio)::text END,
            CASE WHEN p_profit_factor IS NULL THEN NULL
              ELSE pg_catalog.trim_scale(p_profit_factor)::text END,
            CASE WHEN p_trades_count IS NULL THEN NULL
              ELSE p_trades_count::text END,
            pg_catalog.trim_scale(p_total_score)::text,
            pg_catalog.jsonb_build_array(
              'leaderboard-score-factors@1',
              pg_catalog.trim_scale(
                (p_score_factors->>'roi')::numeric
              )::text,
              pg_catalog.trim_scale(
                (p_score_factors->>'pnl')::numeric
              )::text,
              CASE WHEN p_score_factors->>'drawdown' IS NULL THEN NULL
                ELSE pg_catalog.trim_scale(
                  (p_score_factors->>'drawdown')::numeric
                )::text END,
              CASE WHEN p_score_factors->>'sharpe' IS NULL THEN NULL
                ELSE pg_catalog.trim_scale(
                  (p_score_factors->>'sharpe')::numeric
                )::text END,
              CASE WHEN p_score_factors->>'consistency' IS NULL THEN NULL
                ELSE pg_catalog.trim_scale(
                  (p_score_factors->>'consistency')::numeric
                )::text END
            ),
            pg_catalog.trim_scale(p_profitability_score)::text,
            pg_catalog.trim_scale(p_risk_control_score)::text,
            CASE WHEN p_execution_score IS NULL THEN NULL
              ELSE pg_catalog.trim_scale(p_execution_score)::text END
          )
        )::text,
        'UTF8'
      )
    ),
    'hex'
  )
$body$;

ALTER FUNCTION arena.build_leaderboard_rank_typed_field_commitment_v1(
  text, text, numeric, numeric, numeric, numeric, numeric, numeric,
  integer, numeric, jsonb, numeric, numeric, numeric
) OWNER TO postgres;
REVOKE ALL ON FUNCTION
  arena.build_leaderboard_rank_typed_field_commitment_v1(
    text, text, numeric, numeric, numeric, numeric, numeric, numeric,
    integer, numeric, jsonb, numeric, numeric, numeric
  ) FROM PUBLIC, anon, authenticated, service_role;

DO $install$
BEGIN
  IF pg_catalog.to_regprocedure(
       'arena.write_leaderboard_rank_generation_batch_v1(text,bigint,uuid,integer,uuid,text,text[],arena.leaderboard_rank_batch_row_v1[])'
     ) IS NOT NULL THEN
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
    AS $body$
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
      v_verification jsonb;
      v_attestation_chunks jsonb;
      v_attestation_chunk_plan jsonb;
      v_expected_identities jsonb;
      v_expected_commitments jsonb;
      v_supplied_identities jsonb;
      v_supplied_commitments jsonb;
      v_typed_evidence jsonb;
      v_persisted_evidence jsonb;
      v_expected_write_set text;
      v_chunks_sha256 text;
      v_plan_count integer;
      v_chunk_count integer;
      v_attestation_count integer;
      v_current_row_count integer;
      v_current_source_count integer;
      v_prior_batch_count integer;
      v_prior_row_count integer;
      v_remaining_batch_count integer;
      v_mismatch_count integer;
      v_positive_count integer;
      v_written_count integer;
      v_updated_count integer;
      v_binding_count integer;
      v_actual_source_proofs jsonb;
      v_actual_source_count integer;
      v_actual_source_row_count integer;
      v_source_windows_valid boolean;
      v_identities jsonb;
      v_fence_before jsonb;
      v_fence_after jsonb;
      v_expected_fence_delta jsonb;
      v_now timestamptz;
      v_completed_at timestamptz;
      v_manifest_valid_until timestamptz;
      v_expected_phase text;
      v_head_locked boolean := false;
    BEGIN
      IF pg_catalog.current_setting('transaction_isolation') <>
           'read committed' THEN
        RAISE EXCEPTION 'atomic rank batch writes require READ COMMITTED isolation'
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
         OR p_rows IS NULL THEN
        RAISE EXCEPTION 'atomic rank batch header is invalid'
          USING ERRCODE = '22023';
      END IF;

      SELECT claim.*
      INTO v_claim
      FROM ONLY arena.leaderboard_rank_generation_claims AS claim
      WHERE claim.season_id = p_season_id
        AND claim.generation_seq = p_generation_seq
        AND claim.score_cohort_id = p_score_cohort_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'atomic rank batch has no exact generation claim'
          USING ERRCODE = '23503';
      END IF;

      v_typed_evidence :=
        arena.build_leaderboard_rank_typed_batch_evidence_v1(
          p_season_id,
          p_score_cohort_id,
          v_claim.computed_at,
          p_rows
        );
      v_current_row_count :=
        (v_typed_evidence->>'row_count')::integer;
      v_current_source_count :=
        (v_typed_evidence->>'source_count')::integer;
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

      IF v_plan_count IS DISTINCT FROM v_claim.expected_batch_count
         OR v_claim.expected_rank_count < 1
         OR v_claim.expected_batch_count IS DISTINCT FROM
              (v_claim.expected_rank_count + 999) / 1000
         OR p_batch_index >= v_plan_count
         OR v_current_row_count IS DISTINCT FROM
              LEAST(
                1000,
                v_claim.expected_rank_count - p_batch_index * 1000
              )
         OR p_batch_sha256_plan[p_batch_index + 1]
              IS DISTINCT FROM v_typed_evidence->>'batch_sha256'
         OR v_expected_write_set IS DISTINCT FROM v_claim.write_set_sha256 THEN
        RAISE EXCEPTION 'atomic rank batch does not match immutable generation plan'
          USING ERRCODE = '22023';
      END IF;

      -- Frozen response-loss replay is deliberately before head, lease,
      -- manifest, rank, and fence locks. The exact immutable receipt, binding,
      -- attestation header, and current chunk are all required; later rerank,
      -- seal, supersession, or manifest pruning cannot change the byte-identical
      -- response for a previously committed request.
      LOOP
        SELECT receipt.*
        INTO v_existing_receipt
        FROM ONLY arena.leaderboard_rank_generation_batch_receipts AS receipt
        WHERE receipt.season_id = p_season_id
          AND receipt.generation_seq = p_generation_seq
          AND receipt.batch_index = p_batch_index;

        IF FOUND THEN
          SELECT pg_catalog.count(*)::integer
          INTO STRICT v_binding_count
          FROM ONLY arena.leaderboard_rank_generation_manifest_bindings
            AS binding
          WHERE binding.contract =
                'leaderboard-rank-generation-manifest-binding@1'
            AND binding.season_id = p_season_id
            AND binding.generation_seq = p_generation_seq
            AND binding.score_cohort_id = p_score_cohort_id
            AND binding.score_input_manifest_id =
                p_score_input_manifest_id
            AND binding.score_input_manifest_digest =
                p_score_input_manifest_digest;

          SELECT pg_catalog.count(*)::integer
          INTO STRICT v_attestation_count
          FROM ONLY arena.leaderboard_rank_manifest_attestations AS header
          JOIN ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
            ON chunk.season_id = header.season_id
           AND chunk.generation_seq = header.generation_seq
           AND chunk.score_cohort_id = header.score_cohort_id
           AND chunk.score_input_manifest_id =
                header.score_input_manifest_id
           AND chunk.score_input_manifest_digest =
                header.score_input_manifest_digest
          WHERE header.season_id = p_season_id
            AND header.generation_seq = p_generation_seq
            AND header.score_cohort_id = p_score_cohort_id
            AND header.score_input_manifest_id =
                p_score_input_manifest_id
            AND header.score_input_manifest_digest =
                p_score_input_manifest_digest
            AND chunk.chunk_index = p_batch_index;

          IF v_attestation_count <> 1 THEN
            RAISE EXCEPTION
              'generation batch receipt conflicts with manifest attestation replay'
              USING ERRCODE = '55000';
          END IF;

          IF v_attestation_count = 1 THEN
            SELECT chunk.*
            INTO STRICT v_attestation_chunk
            FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks
              AS chunk
            WHERE chunk.season_id = p_season_id
              AND chunk.generation_seq = p_generation_seq
              AND chunk.score_cohort_id = p_score_cohort_id
              AND chunk.score_input_manifest_id =
                    p_score_input_manifest_id
              AND chunk.score_input_manifest_digest =
                    p_score_input_manifest_digest
              AND chunk.chunk_index = p_batch_index;

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

            IF v_supplied_identities IS DISTINCT FROM
                 v_attestation_chunk.identities
               OR v_supplied_commitments IS DISTINCT FROM
                 v_attestation_chunk.field_commitments THEN
              RAISE EXCEPTION
                'generation batch receipt conflicts with manifest attestation replay'
                USING ERRCODE = '55000';
            END IF;
          END IF;

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
             OR v_existing_receipt.row_count IS DISTINCT FROM
                  v_current_row_count
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
             OR v_actual_source_proofs IS DISTINCT FROM
                  v_typed_evidence->'source_proofs'
             OR v_actual_source_count IS DISTINCT FROM
                  v_current_source_count
             OR v_actual_source_row_count IS DISTINCT FROM
                  v_current_row_count
             OR NOT v_source_windows_valid
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
               FROM ONLY arena.leaderboard_rank_generation_batch_receipts
                 AS later
               JOIN ONLY arena.leaderboard_rank_generation_batch_receipts
                 AS earlier
                 ON earlier.season_id = later.season_id
                AND earlier.generation_seq = later.generation_seq
                AND earlier.batch_index = later.batch_index - 1
               WHERE later.season_id = p_season_id
                 AND later.generation_seq = p_generation_seq
                 AND later.batch_index BETWEEN 1 AND p_batch_index
                 AND ROW(
                       earlier.last_source,
                       earlier.last_source_trader_id
                     ) >= ROW(
                       later.first_source,
                       later.first_source_trader_id
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
         OR v_head.lease_expires_at IS DISTINCT FROM
              v_claim.lease_expires_at
         OR v_head.lease_expires_at <= v_now
         OR v_claim.computed_at > v_now + interval '5 minutes' THEN
        RAISE EXCEPTION
          'generation lease expired while atomic batch write was waiting'
          USING ERRCODE = '55000';
      END IF;

      SELECT
        pg_catalog.count(*)::integer,
        COALESCE(pg_catalog.sum(receipt.row_count), 0)::integer
      INTO STRICT v_prior_batch_count, v_prior_row_count
      FROM ONLY arena.leaderboard_rank_generation_batch_receipts AS receipt
      WHERE receipt.season_id = p_season_id
        AND receipt.generation_seq = p_generation_seq;

      IF v_prior_batch_count IS DISTINCT FROM p_batch_index
         OR v_prior_row_count IS DISTINCT FROM p_batch_index * 1000
         OR EXISTS (
           SELECT 1
           FROM pg_catalog.generate_series(
             0,
             p_batch_index - 1
           ) AS planned(i)
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
         ) THEN
        RAISE EXCEPTION 'writer accepted a non-sequential batch index'
          USING ERRCODE = '22023';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM (
          SELECT
            source_receipt.source,
            source_receipt.mutation_seq_before,
            pg_catalog.lag(source_receipt.mutation_seq_after) OVER (
              PARTITION BY source_receipt.source
              ORDER BY source_receipt.batch_index
            ) AS previous_mutation_seq_after
          FROM ONLY
            arena.leaderboard_rank_generation_source_fence_receipts
              AS source_receipt
          WHERE source_receipt.season_id = p_season_id
            AND source_receipt.generation_seq = p_generation_seq
        ) AS continuity
        WHERE continuity.previous_mutation_seq_after IS NOT NULL
          AND continuity.mutation_seq_before IS DISTINCT FROM
              continuity.previous_mutation_seq_after
      ) THEN
        RAISE EXCEPTION 'prior batch source fence does not continue'
          USING ERRCODE = '55000';
      END IF;

      IF p_batch_index > 0 AND EXISTS (
        SELECT 1
        FROM ONLY arena.leaderboard_rank_generation_batch_receipts AS prior
        WHERE prior.season_id = p_season_id
          AND prior.generation_seq = p_generation_seq
          AND prior.batch_index = p_batch_index - 1
          AND ROW(prior.last_source, prior.last_source_trader_id) >=
              ROW(
                v_typed_evidence->>'first_source',
                v_typed_evidence->>'first_source_trader_id'
              )
      ) THEN
        RAISE EXCEPTION 'previous batch identity range overlaps this batch'
          USING ERRCODE = '22023';
      END IF;

      v_remaining_batch_count :=
        v_claim.expected_batch_count - p_batch_index - 1;
      IF v_prior_row_count + v_current_row_count >
           v_claim.expected_rank_count
         OR v_prior_row_count + v_current_row_count +
              v_remaining_batch_count > v_claim.expected_rank_count
         OR v_prior_row_count + v_current_row_count +
              v_remaining_batch_count * 1000 <
              v_claim.expected_rank_count
         OR (
           v_remaining_batch_count = 0
           AND v_prior_row_count + v_current_row_count IS DISTINCT FROM
               v_claim.expected_rank_count
         ) THEN
        RAISE EXCEPTION 'atomic batch row capacity disagrees with generation claim'
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
          RAISE EXCEPTION 'atomic batch manifest identity is unavailable'
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
            'atomic batch requires one live fully verified manifest'
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
            'atomic batch requires one live fully verified manifest'
            USING ERRCODE = '55000';
        END IF;
        v_manifest_valid_until := v_manifest.valid_until;

        -- The scorer manifest proves identities and score-derived fields only.
        -- Publication rank is terminal state and must be attested by the future
        -- all-generation finalizer against its exact serving-order contract.
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
            'manifest positive output count disagrees with canonical generation'
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
        v_expected_identities :=
          (v_attestation_chunks->0)->'identities';
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
          RAISE EXCEPTION 'later batch has no exact manifest attestation'
            USING ERRCODE = '23503';
        END IF;

        IF v_attestation.contract IS DISTINCT FROM
             'leaderboard-rank-manifest-attestation@1'
           OR v_attestation.batch_index <> 0
           OR v_attestation.positive_count IS DISTINCT FROM
                v_claim.expected_rank_count
           OR v_attestation.chunk_count IS DISTINCT FROM
                v_claim.expected_batch_count
           OR v_attestation.manifest_valid_until <
                v_claim.lease_expires_at THEN
          RAISE EXCEPTION 'later batch manifest attestation conflicts with claim'
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
          RAISE EXCEPTION 'later batch has no exact manifest attestation chunk'
            USING ERRCODE = '23503';
        END IF;

        IF v_attestation_chunk.first_position IS DISTINCT FROM
             p_batch_index * 1000 + 1
           OR v_attestation_chunk.row_count IS DISTINCT FROM
                v_current_row_count THEN
          RAISE EXCEPTION 'later batch manifest attestation chunk conflicts'
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
          RAISE EXCEPTION 'later batch has no exact manifest binding'
            USING ERRCODE = '23503';
        END IF;
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

      IF v_supplied_identities IS DISTINCT FROM v_expected_identities
         OR v_supplied_commitments IS DISTINCT FROM v_expected_commitments THEN
        RAISE EXCEPTION 'typed scorer fields disagree with manifest attestation'
          USING ERRCODE = '22023';
      END IF;
      -- Recursive rank lock: using ONLY here would let a direct partition DML
      -- deadlock with the writer's fence-first critical section.
      LOCK TABLE public.leaderboard_ranks IN SHARE ROW EXCLUSIVE MODE;

      PERFORM fence.mutation_seq
      FROM ONLY arena.leaderboard_rank_mutation_fences AS fence
      JOIN (
        SELECT DISTINCT receipt.source
        FROM ONLY arena.leaderboard_rank_generation_source_fence_receipts
          AS receipt
        WHERE receipt.season_id = p_season_id
          AND receipt.generation_seq = p_generation_seq
          AND receipt.batch_index < p_batch_index
      ) AS prior_source
        ON prior_source.source = fence.source
      WHERE fence.season_id = p_season_id
      ORDER BY prior_source.source COLLATE pg_catalog."C"
      FOR UPDATE OF fence;

      IF EXISTS (
        WITH latest AS MATERIALIZED (
          SELECT DISTINCT ON (receipt.source COLLATE pg_catalog."C")
            receipt.source,
            receipt.mutation_seq_after
          FROM ONLY
            arena.leaderboard_rank_generation_source_fence_receipts AS receipt
          WHERE receipt.season_id = p_season_id
            AND receipt.generation_seq = p_generation_seq
            AND receipt.batch_index < p_batch_index
          ORDER BY receipt.source COLLATE pg_catalog."C",
                   receipt.batch_index DESC
        )
        SELECT 1
        FROM latest
        LEFT JOIN ONLY arena.leaderboard_rank_mutation_fences AS fence
          ON fence.season_id = p_season_id
         AND fence.source = latest.source
        WHERE fence.source IS NULL
           OR fence.mutation_seq IS DISTINCT FROM
                latest.mutation_seq_after
      ) THEN
        RAISE EXCEPTION 'prior batch source fence changed before append'
          USING ERRCODE = '55000';
      END IF;

      -- A cohort is server-owned authority. Before appending the next slice, its
      -- durable identity set must be exactly the manifest-positive prefix already
      -- covered by immutable receipts; no owner-side or legacy writer may seed,
      -- remove, or substitute an unreceipted cohort row.
      WITH expected_prefix AS MATERIALIZED (
        SELECT
          identity_row.value->>0 AS source,
          identity_row.value->>1 AS source_trader_id
        FROM ONLY arena.leaderboard_rank_manifest_attestation_chunks AS chunk
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
          chunk.identities
        ) AS identity_row(value)
        WHERE chunk.season_id = p_season_id
          AND chunk.generation_seq = p_generation_seq
          AND chunk.score_cohort_id = p_score_cohort_id
          AND chunk.score_input_manifest_id = p_score_input_manifest_id
          AND chunk.score_input_manifest_digest =
                p_score_input_manifest_digest
          AND chunk.chunk_index < p_batch_index
      ), durable_prefix AS MATERIALIZED (
        SELECT rank_row.source, rank_row.source_trader_id
        FROM public.leaderboard_ranks AS rank_row
        WHERE rank_row.season_id = p_season_id
          AND rank_row.rank_publication_id = p_score_cohort_id
      )
      SELECT pg_catalog.count(*)::integer
      INTO STRICT v_mismatch_count
      FROM expected_prefix
      FULL JOIN durable_prefix
        ON pg_catalog.convert_to(expected_prefix.source, 'UTF8') =
             pg_catalog.convert_to(durable_prefix.source, 'UTF8')
       AND pg_catalog.convert_to(
             expected_prefix.source_trader_id,
             'UTF8'
           ) = pg_catalog.convert_to(
             durable_prefix.source_trader_id,
             'UTF8'
           )
      WHERE expected_prefix.source IS NULL
         OR durable_prefix.source IS NULL;
      IF v_mismatch_count <> 0 THEN
        RAISE EXCEPTION
          'generation cohort contains an unreceipted identity set'
          USING ERRCODE = '55000';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.leaderboard_ranks AS existing
        JOIN pg_catalog.unnest(p_rows) AS input
          ON existing.season_id = p_season_id
         AND existing.source = input.source
         AND existing.source_trader_id = input.source_trader_id
        WHERE existing.rank_publication_id = p_score_cohort_id
      ) THEN
        RAISE EXCEPTION 'unreceipted rows already use this generation cohort'
          USING ERRCODE = '55000';
      END IF;

      WITH supplied AS MATERIALIZED (
        SELECT input.source, input.source_trader_id
        FROM pg_catalog.unnest(p_rows) AS input
      ), row_state AS MATERIALIZED (
        SELECT
          supplied.source,
          existing.id IS NULL AS is_insert,
          existing.id IS NOT NULL AS is_update
        FROM supplied
        LEFT JOIN public.leaderboard_ranks AS existing
          ON existing.season_id = p_season_id
         AND existing.source = supplied.source
         AND existing.source_trader_id = supplied.source_trader_id
      ), source_state AS (
        SELECT
          row_state.source,
          pg_catalog.bool_or(row_state.is_insert) AS has_insert,
          pg_catalog.bool_or(row_state.is_update) AS has_update
        FROM row_state
        GROUP BY row_state.source
      )
      SELECT pg_catalog.jsonb_object_agg(
        source_state.source,
        CASE
          WHEN source_state.has_insert AND source_state.has_update THEN 2
          ELSE 1
        END
        ORDER BY source_state.source COLLATE pg_catalog."C"
      )
      INTO STRICT v_expected_fence_delta
      FROM source_state;

      INSERT INTO arena.leaderboard_rank_mutation_fences (
        season_id,
        source,
        mutation_seq,
        mutated_at
      )
      SELECT
        p_season_id,
        supplied_source.source,
        0,
        pg_catalog.statement_timestamp()
      FROM (
        SELECT DISTINCT input.source COLLATE pg_catalog."C" AS source
        FROM pg_catalog.unnest(p_rows) AS input
      ) AS supplied_source
      ORDER BY supplied_source.source COLLATE pg_catalog."C"
      ON CONFLICT (season_id, source) DO NOTHING;

      PERFORM fence.mutation_seq
      FROM ONLY arena.leaderboard_rank_mutation_fences AS fence
      JOIN (
        SELECT DISTINCT input.source
        FROM pg_catalog.unnest(p_rows) AS input
      ) AS supplied_source
        ON supplied_source.source = fence.source
      WHERE fence.season_id = p_season_id
      ORDER BY supplied_source.source COLLATE pg_catalog."C"
      FOR UPDATE OF fence;

      SELECT pg_catalog.jsonb_object_agg(
        fence.source,
        fence.mutation_seq
        ORDER BY fence.source COLLATE pg_catalog."C"
      )
      INTO STRICT v_fence_before
      FROM ONLY arena.leaderboard_rank_mutation_fences AS fence
      JOIN (
        SELECT DISTINCT input.source
        FROM pg_catalog.unnest(p_rows) AS input
      ) AS supplied_source
        ON supplied_source.source = fence.source
      WHERE fence.season_id = p_season_id;

      IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_object_keys(v_fence_before) AS current(source)
        JOIN LATERAL (
          SELECT source_receipt.mutation_seq_after
          FROM ONLY
            arena.leaderboard_rank_generation_source_fence_receipts
              AS source_receipt
          WHERE source_receipt.season_id = p_season_id
            AND source_receipt.generation_seq = p_generation_seq
            AND source_receipt.source = current.source
          ORDER BY source_receipt.batch_index DESC
          LIMIT 1
        ) AS previous ON true
        WHERE previous.mutation_seq_after IS DISTINCT FROM
              (v_fence_before->>current.source)::bigint
      ) THEN
        RAISE EXCEPTION 'prior batch source fence does not continue'
          USING ERRCODE = '55000';
      END IF;

      v_now := pg_catalog.clock_timestamp();
      IF v_head.lease_expires_at <= v_now
         OR v_manifest_valid_until <= v_now THEN
        RAISE EXCEPTION
          'generation lease expired while atomic batch write was waiting'
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
          input.source,
          input.source_type,
          input.source_trader_id,
          input.rank,
          input.arena_score,
          input.roi,
          input.pnl,
          input.win_rate,
          input.max_drawdown,
          input.followers,
          input.trades_count,
          input.handle,
          input.avatar_url,
          v_claim.computed_at,
          input.profitability_score,
          input.risk_control_score,
          input.execution_score,
          input.score_completeness,
          input.trading_style,
          input.avg_holding_hours,
          input.style_confidence,
          input.sharpe_ratio,
          input.sortino_ratio,
          input.profit_factor,
          input.calmar_ratio,
          input.trader_type,
          input.is_outlier,
          input.metrics_estimated,
          input.rank_change,
          input.is_new,
          input.copiers,
          input.arena_score_v4,
          input.arena_score_v3,
          input.score_factors,
          p_score_cohort_id
        FROM pg_catalog.unnest(p_rows) AS input
        ORDER BY input.source COLLATE pg_catalog."C",
                 input.source_trader_id COLLATE pg_catalog."C"
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
      IF v_written_count IS DISTINCT FROM v_current_row_count THEN
        RAISE EXCEPTION 'atomic rank upsert did not write the complete batch'
          USING ERRCODE = '55000';
      END IF;

      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'source', input.source,
          'source_trader_id', input.source_trader_id
        )
        ORDER BY input.source COLLATE pg_catalog."C",
                 input.source_trader_id COLLATE pg_catalog."C"
      )
      INTO STRICT v_identities
      FROM pg_catalog.unnest(p_rows) AS input;

      v_persisted_evidence :=
        arena.build_leaderboard_rank_batch_evidence_v1(
          p_season_id,
          p_score_cohort_id,
          v_identities
        );
      IF v_persisted_evidence IS DISTINCT FROM v_typed_evidence THEN
        RAISE EXCEPTION 'typed and persisted batch evidence diverged'
          USING ERRCODE = '55000';
      END IF;

      SELECT pg_catalog.jsonb_object_agg(
        fence.source,
        fence.mutation_seq
        ORDER BY fence.source COLLATE pg_catalog."C"
      )
      INTO STRICT v_fence_after
      FROM ONLY arena.leaderboard_rank_mutation_fences AS fence
      JOIN (
        SELECT DISTINCT input.source
        FROM pg_catalog.unnest(p_rows) AS input
      ) AS supplied_source
        ON supplied_source.source = fence.source
      WHERE fence.season_id = p_season_id;

      IF EXISTS (
        SELECT 1
        FROM (
          SELECT
            source.value AS source,
            (v_fence_before->>source.value)::bigint
              AS mutation_seq_before,
            (v_fence_after->>source.value)::bigint
              AS mutation_seq_after,
            (v_expected_fence_delta->>source.value)::integer
              AS expected_delta
          FROM pg_catalog.jsonb_object_keys(v_fence_before) AS source(value)
        ) AS mutation_window
        WHERE mutation_window.mutation_seq_after -
              mutation_window.mutation_seq_before IS DISTINCT FROM
              mutation_window.expected_delta
      ) THEN
        RAISE EXCEPTION 'writer recorded an invalid source mutation delta'
          USING ERRCODE = '55000';
      END IF;

      v_now := pg_catalog.clock_timestamp();
      IF v_head.lease_expires_at <= v_now
         OR v_manifest_valid_until <= v_now THEN
        RAISE EXCEPTION
          'generation lease expired while atomic batch write was waiting'
          USING ERRCODE = '55000';
      END IF;
      v_completed_at := v_now;

      IF p_batch_index = 0 THEN
        -- A caller may have changed every deferrable constraint to IMMEDIATE.
        -- Restore the exact two batch-zero edges before inserting the receipt,
        -- header, and chunks in their canonical durable order.
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

      INSERT INTO
        arena.leaderboard_rank_generation_source_fence_receipts (
          contract,
          season_id,
          generation_seq,
          batch_index,
          source,
          source_row_count,
          source_identity_sha256,
          mutation_seq_before,
          mutation_seq_after
        )
      SELECT
        'leaderboard-rank-generation-source-fence-receipt@1',
        p_season_id,
        p_generation_seq,
        p_batch_index,
        proof.value->>'source',
        (proof.value->>'source_row_count')::integer,
        proof.value->>'source_identity_sha256',
        (v_fence_before->>(proof.value->>'source'))::bigint,
        (v_fence_after->>(proof.value->>'source'))::bigint
      FROM pg_catalog.jsonb_array_elements(
        v_typed_evidence->'source_proofs'
      ) AS proof(value)
      ORDER BY proof.value->>'source' COLLATE pg_catalog."C";

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
        RAISE EXCEPTION 'atomic batch head compare-and-set failed'
          USING ERRCODE = '55000';
      END IF;

      -- Receipt constraints/indexes and the final head CAS can themselves wait.
      -- Recheck authority after every durable statement; an error here rolls the
      -- rank DML, fence increments, receipts, binding, and head update back.
      v_now := pg_catalog.clock_timestamp();
      IF v_head.lease_expires_at <= v_now
         OR v_manifest_valid_until <= v_now THEN
        RAISE EXCEPTION
          'generation lease expired before atomic batch commit'
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
    $body$;

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

    COMMENT ON FUNCTION
      arena.write_leaderboard_rank_generation_batch_v1(
        text,
        bigint,
        uuid,
        integer,
        uuid,
        text,
        text[],
        arena.leaderboard_rank_batch_row_v1[]
      ) IS
      'Owner-only atomic typed rank-batch writer. Batch zero derives immutable scorer-field manifest chunks; later batches verify exact chunks without the raw manifest. Batch ranks are provisional: terminal publication rank requires a separate all-generation finalizer attestation. Rank DML, evidence, fences, receipts, and the head CAS remain atomic.';
  END IF;
END
$install$;

DO $commitment_helper_postflight$
DECLARE
  v_typed oid := pg_catalog.to_regprocedure(
    'arena.build_leaderboard_rank_typed_field_commitment_v1(text,text,numeric,numeric,numeric,numeric,numeric,numeric,integer,numeric,jsonb,numeric,numeric,numeric)'
  );
  v_typed_digest text;
BEGIN
  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
    'hex'
  )
  INTO v_typed_digest
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_typed;

  IF v_typed IS NULL
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = function_row.pronamespace
       WHERE namespace_row.nspname = 'arena'
         AND function_row.proname =
             'build_leaderboard_rank_typed_field_commitment_v1'
     ) <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_language AS language_row
         ON language_row.oid = function_row.prolang
       WHERE function_row.oid = v_typed
         AND function_row.proowner = 'postgres'::pg_catalog.regrole
         AND function_row.prokind = 'f'
         AND language_row.lanname = 'sql'
         AND function_row.provolatile = 'i'
         AND function_row.proparallel = 's'
         AND NOT function_row.prosecdef
         AND NOT function_row.proleakproof
         AND NOT function_row.proisstrict
         AND NOT function_row.proretset
         AND function_row.prorettype = 'pg_catalog.text'::pg_catalog.regtype
         AND function_row.pronargs = 14
         AND function_row.pronargdefaults = 0
         AND function_row.proargtypes = ARRAY[
           'pg_catalog.text'::pg_catalog.regtype,
           'pg_catalog.text'::pg_catalog.regtype,
           'pg_catalog.numeric'::pg_catalog.regtype,
           'pg_catalog.numeric'::pg_catalog.regtype,
           'pg_catalog.numeric'::pg_catalog.regtype,
           'pg_catalog.numeric'::pg_catalog.regtype,
           'pg_catalog.numeric'::pg_catalog.regtype,
           'pg_catalog.numeric'::pg_catalog.regtype,
           'pg_catalog.int4'::pg_catalog.regtype,
           'pg_catalog.numeric'::pg_catalog.regtype,
           'pg_catalog.jsonb'::pg_catalog.regtype,
           'pg_catalog.numeric'::pg_catalog.regtype,
           'pg_catalog.numeric'::pg_catalog.regtype,
           'pg_catalog.numeric'::pg_catalog.regtype
         ]::pg_catalog.oidvector
         AND function_row.proargnames = ARRAY[
           'p_source',
           'p_source_trader_id',
           'p_roi',
           'p_pnl',
           'p_win_rate',
           'p_max_drawdown',
           'p_sharpe_ratio',
           'p_profit_factor',
           'p_trades_count',
           'p_total_score',
           'p_score_factors',
           'p_profitability_score',
           'p_risk_control_score',
           'p_execution_score'
         ]::text[]
         AND function_row.proargmodes IS NULL
         AND function_row.proallargtypes IS NULL
         AND function_row.prosupport = 0
         AND function_row.prosqlbody IS NULL
         AND function_row.probin IS NULL
         AND function_row.procost = 100
         AND function_row.prorows = 0
         AND function_row.proconfig =
               ARRAY['search_path=pg_catalog, pg_temp']::text[]
         AND pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(function_row.prosrc, 'UTF8')
               ),
               'hex'
             ) =
               'aafce6e95ed4662239a1f84295cc3158dc0011f8bc8948d0161f73767e73dd9a'
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
       WHERE function_row.oid = v_typed
         AND expanded.grantee <> function_row.proowner
         AND expanded.privilege_type = 'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM (VALUES ('anon'), ('authenticated'), ('service_role'))
         AS api(role_name)
       WHERE pg_catalog.has_function_privilege(
         api.role_name,
         v_typed,
         'EXECUTE'
       )
     ) THEN
    RAISE EXCEPTION
      'typed manifest commitment helper postflight drifted: %',
      COALESCE(v_typed_digest, '-');
  END IF;
END
$commitment_helper_postflight$;

DO $postflight$
DECLARE
  v_writer oid := pg_catalog.to_regprocedure(
    'arena.write_leaderboard_rank_generation_batch_v1(text,bigint,uuid,integer,uuid,text,text[],arena.leaderboard_rank_batch_row_v1[])'
  );
  v_writer_body_digest text;
BEGIN
  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(function_row.prosrc, 'UTF8')
    ),
    'hex'
  )
  INTO v_writer_body_digest
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_writer;

  IF v_writer IS NULL
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = function_row.pronamespace
       WHERE namespace_row.nspname = 'arena'
         AND function_row.proname =
             'write_leaderboard_rank_generation_batch_v1'
         AND function_row.oid IS DISTINCT FROM v_writer
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_language AS language_row
         ON language_row.oid = function_row.prolang
       WHERE function_row.oid = v_writer
         AND function_row.proowner = 'postgres'::pg_catalog.regrole
         AND function_row.prokind = 'f'
         AND language_row.lanname = 'plpgsql'
         AND NOT function_row.prosecdef
         AND NOT function_row.proleakproof
         AND NOT function_row.proisstrict
         AND function_row.provolatile = 'v'
         AND function_row.proparallel = 'u'
         AND NOT function_row.proretset
         AND function_row.prorettype =
             'pg_catalog.jsonb'::pg_catalog.regtype
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
         AND v_writer_body_digest =
             'ddb7c25c0c61c1ea70377bc6879e913a07e4529b1e4c8fa35a4b5d9f2c50f548'
     ) THEN
    RAISE EXCEPTION 'atomic attested batch writer body drifted: %',
      COALESCE(v_writer_body_digest, '-');
  END IF;

  IF pg_catalog.has_function_privilege('anon', v_writer, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
          'authenticated', v_writer, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'service_role', v_writer, 'EXECUTE'
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
       WHERE function_row.oid = v_writer
         AND expanded.grantee <> function_row.proowner
         AND expanded.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'atomic batch writer ACL drifted';
  END IF;
END
$postflight$;

COMMIT;
