-- Bound generation claims to the batch writer's finite receipt contract.
--
-- The claim ledger originally bounded rows but allowed one receipt per row.
-- That admitted up to 250,000 immutable receipts and also allowed claims that
-- no 1,000-row batch writer could ever complete. This forward-only constraint
-- closes both states and matches the authoritative scorer's 64,000-input
-- global cohort. The RPC is tightened in place so direct callers fail before
-- taking the generation-head row lock or attempting an immutable insert.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $dependency_preflight$
BEGIN
  IF pg_catalog.to_regclass(
       'arena.leaderboard_rank_generation_claims'
     ) IS NULL
     OR pg_catalog.to_regclass(
       'arena.leaderboard_rank_generation_heads'
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
    RAISE EXCEPTION 'bounded generation batches require the exact claim substrate and API roles';
  END IF;
END
$dependency_preflight$;

CREATE TEMP TABLE leaderboard_generation_capacity_install_state (
  capacity_constraint_oid oid,
  claim_function_oid oid NOT NULL,
  claim_function_sha256 text NOT NULL
) ON COMMIT DROP;

INSERT INTO leaderboard_generation_capacity_install_state (
  capacity_constraint_oid,
  claim_function_oid,
  claim_function_sha256
)
SELECT
  constraint_row.oid,
  function_row.oid,
  pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(function_row.prosrc, 'UTF8')
    ),
    'hex'
  )
FROM pg_catalog.pg_proc AS function_row
LEFT JOIN pg_catalog.pg_constraint AS constraint_row
  ON constraint_row.conrelid =
      'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
 AND constraint_row.conname =
      'leaderboard_rank_generation_claims_batch_capacity_check'
WHERE function_row.oid =
  'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'
    ::pg_catalog.regprocedure;

-- Match the RPC's durable lock order. SHARE ROW EXCLUSIVE excludes claim DML,
-- trigger changes, inheritance changes, and a concurrent copy of this upgrade.
LOCK TABLE ONLY arena.leaderboard_rank_generation_heads
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.leaderboard_rank_generation_claims
  IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_capacity_constraint oid;
  v_claim_function oid;
  v_claim_function_sha256 text;
  v_expected_claim_function_sha256 text;
  v_expected_claim_constraint_count bigint;
BEGIN
  SELECT
    install.capacity_constraint_oid,
    install.claim_function_oid,
    install.claim_function_sha256
  INTO STRICT
    v_capacity_constraint,
    v_claim_function,
    v_claim_function_sha256
  FROM leaderboard_generation_capacity_install_state AS install;

  IF v_capacity_constraint IS NULL THEN
    v_expected_claim_function_sha256 :=
      'a83541a05ec6f642554535006710fc82125ffc595ab26d5b23fc414510886f8b';
    v_expected_claim_constraint_count := 13;
  ELSE
    v_expected_claim_function_sha256 :=
      '09f136557ede5e00ef5c519736c81abf44ea7780f336e216591304a746a746a2';
    v_expected_claim_constraint_count := 14;
  END IF;

  IF v_claim_function_sha256 IS DISTINCT FROM
       v_expected_claim_function_sha256 THEN
    RAISE EXCEPTION 'generation claim RPC body does not match the install state';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_claim_function
      AND pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(function_row.prosrc, 'UTF8')
        ),
        'hex'
      ) = v_claim_function_sha256
  ) THEN
    RAISE EXCEPTION 'generation claim RPC changed during capacity preflight';
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
  ) THEN
    RAISE EXCEPTION 'generation claim RPC catalog or overload contract drifted';
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
    RAISE EXCEPTION 'generation claim RPC EXECUTE ACL drifted';
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
    WHERE table_row.oid IN (
        'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
        'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass
      )
      AND (
        table_row.relkind <> 'r'
        OR table_row.relpersistence <> 'p'
        OR table_row.relowner <> 'postgres'::pg_catalog.regrole
        OR NOT table_row.relrowsecurity
        OR table_row.relforcerowsecurity
        OR table_row.relispartition
        OR table_row.reloptions IS NOT NULL
        OR table_row.relreplident <> 'd'
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
        'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
        'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass
      )
       OR inheritance.inhparent IN (
        'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
        'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        table_row.relacl,
        pg_catalog.acldefault('r', table_row.relowner)
      )
    ) AS privilege_row
    WHERE table_row.oid IN (
        'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
        'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass
      )
      AND privilege_row.grantee <> table_row.relowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS column_row
    JOIN pg_catalog.pg_class AS table_row
      ON table_row.oid = column_row.attrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(column_row.attacl) AS privilege_row
    WHERE column_row.attrelid IN (
        'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
        'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass
      )
      AND column_row.attnum > 0
      AND NOT column_row.attisdropped
      AND column_row.attacl IS NOT NULL
      AND privilege_row.grantee <> table_row.relowner
  ) THEN
    RAISE EXCEPTION 'generation tables owner, RLS, inheritance, or ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.leaderboard_rank_generation_claims'::regclass,
         1, 'contract', 'pg_catalog.text'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         2, 'season_id', 'pg_catalog.text'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         3, 'generation_seq', 'pg_catalog.int8'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         4, 'score_cohort_id', 'pg_catalog.uuid'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         5, 'write_set_sha256', 'pg_catalog.text'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         6, 'expected_rank_count', 'pg_catalog.int4'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         7, 'expected_batch_count', 'pg_catalog.int4'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         8, 'computed_at', 'pg_catalog.timestamptz'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         9, 'lease_seconds', 'pg_catalog.int4'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         10, 'claimed_at', 'pg_catalog.timestamptz'::regtype, true),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         11, 'lease_expires_at', 'pg_catalog.timestamptz'::regtype, true),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         1, 'season_id', 'pg_catalog.text'::regtype, true),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         2, 'generation_seq', 'pg_catalog.int8'::regtype, true),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         3, 'score_cohort_id', 'pg_catalog.uuid'::regtype, false),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         4, 'phase', 'pg_catalog.text'::regtype, true),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         5, 'lease_expires_at', 'pg_catalog.timestamptz'::regtype, false),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         6, 'updated_at', 'pg_catalog.timestamptz'::regtype, true)
    ) AS expected(table_oid, column_number, column_name, type_oid, not_null)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = expected.table_oid
     AND attribute.attname = expected.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attname IS NULL
       OR attribute.attnum IS DISTINCT FROM expected.column_number
       OR attribute.atttypid IS DISTINCT FROM expected.type_oid
       OR attribute.attnotnull IS DISTINCT FROM expected.not_null
       OR attribute.atthasdef
       OR attribute.attgenerated <> ''
       OR attribute.attidentity <> ''
       OR attribute.atttypmod <> -1
       OR attribute.attndims <> 0
       OR attribute.attacl IS NOT NULL
       OR attribute.attoptions IS NOT NULL
       OR attribute.attfdwoptions IS NOT NULL
       OR (
         expected.type_oid = 'pg_catalog.text'::regtype
         AND attribute.attcollation IS DISTINCT FROM
           'pg_catalog."default"'::regcollation
       )
       OR (
         expected.type_oid <> 'pg_catalog.text'::regtype
         AND attribute.attcollation <> 0
       )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
        'arena.leaderboard_rank_generation_claims'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 11 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
        'arena.leaderboard_rank_generation_heads'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 6 THEN
    RAISE EXCEPTION 'generation table column contract drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
  ) IS DISTINCT FROM v_expected_claim_constraint_count OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass
  ) <> 7 THEN
    RAISE EXCEPTION 'generation table constraint count drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_pkey', 'p'::"char",
         'PRIMARY KEY (season_id, generation_seq)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_cohort_key', 'u'::"char",
         'UNIQUE (score_cohort_id)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_identity_key', 'u'::"char",
         'UNIQUE (season_id, generation_seq, score_cohort_id)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_contract_check', 'c'::"char",
         'CHECK (contract = ''leaderboard-rank-generation-claim@1''::text)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_season_check', 'c'::"char",
         'CHECK (season_id = ANY (ARRAY[''7D''::text, ''30D''::text, ''90D''::text]))'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_sequence_check', 'c'::"char",
         'CHECK (generation_seq > 0 AND generation_seq <= ''9007199254740000''::bigint)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_digest_check', 'c'::"char",
         'CHECK (write_set_sha256 ~ ''^[0-9a-f]{64}$''::text)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_rank_count_check', 'c'::"char",
         'CHECK (expected_rank_count >= 0 AND expected_rank_count <= 250000)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_batch_count_check', 'c'::"char",
         'CHECK (expected_rank_count = 0 AND expected_batch_count = 0 OR expected_rank_count > 0 AND expected_batch_count > 0 AND expected_batch_count <= expected_rank_count)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_computed_at_check', 'c'::"char",
         'CHECK (isfinite(computed_at))'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_lease_seconds_check', 'c'::"char",
         'CHECK (lease_seconds >= 15 AND lease_seconds <= 300)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_claimed_at_check', 'c'::"char",
         'CHECK (isfinite(claimed_at))'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_lease_expiry_check', 'c'::"char",
         'CHECK (isfinite(lease_expires_at) AND lease_expires_at = (claimed_at + lease_seconds::double precision * ''00:00:01''::interval))'),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'leaderboard_rank_generation_heads_pkey', 'p'::"char",
         'PRIMARY KEY (season_id)'),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'leaderboard_rank_generation_heads_season_check', 'c'::"char",
         'CHECK (season_id = ANY (ARRAY[''7D''::text, ''30D''::text, ''90D''::text]))'),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'leaderboard_rank_generation_heads_sequence_check', 'c'::"char",
         'CHECK (generation_seq >= 0 AND generation_seq <= ''9007199254740000''::bigint)'),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'leaderboard_rank_generation_heads_phase_check', 'c'::"char",
         'CHECK (phase = ANY (ARRAY[''idle''::text, ''claimed''::text, ''writing''::text, ''cleaned''::text, ''reranked''::text, ''sealed''::text, ''failed''::text]))'),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'leaderboard_rank_generation_heads_state_check', 'c'::"char",
         'CHECK (generation_seq = 0 AND score_cohort_id IS NULL AND phase = ''idle''::text AND lease_expires_at IS NULL OR generation_seq > 0 AND score_cohort_id IS NOT NULL AND ((phase = ANY (ARRAY[''claimed''::text, ''writing''::text, ''cleaned''::text, ''reranked''::text])) AND lease_expires_at IS NOT NULL AND isfinite(lease_expires_at) OR (phase = ANY (ARRAY[''sealed''::text, ''failed''::text])) AND lease_expires_at IS NULL))'),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'leaderboard_rank_generation_heads_updated_at_check', 'c'::"char",
         'CHECK (isfinite(updated_at))'),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'leaderboard_rank_generation_heads_claim_fkey', 'f'::"char",
         'FOREIGN KEY (season_id, generation_seq, score_cohort_id) REFERENCES arena.leaderboard_rank_generation_claims(season_id, generation_seq, score_cohort_id)')
    ) AS expected(
      table_oid,
      constraint_name,
      constraint_type,
      constraint_definition
    )
    LEFT JOIN pg_catalog.pg_constraint AS constraint_row
      ON constraint_row.conrelid = expected.table_oid
     AND constraint_row.conname = expected.constraint_name
    WHERE constraint_row.oid IS NULL
       OR constraint_row.contype IS DISTINCT FROM expected.constraint_type
       OR NOT constraint_row.convalidated
       OR constraint_row.condeferrable
       OR pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
            IS DISTINCT FROM expected.constraint_definition
  ) THEN
    RAISE EXCEPTION 'generation foundational constraint contract drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
        'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
  ) <> 3 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
        'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass
  ) <> 1 THEN
    RAISE EXCEPTION 'generation table index count drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_pkey',
         '2 3'::pg_catalog.int2vector, true, true, 2,
         'CREATE UNIQUE INDEX leaderboard_rank_generation_claims_pkey ON arena.leaderboard_rank_generation_claims USING btree (season_id, generation_seq)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_cohort_key',
         '4'::pg_catalog.int2vector, true, false, 1,
         'CREATE UNIQUE INDEX leaderboard_rank_generation_claims_cohort_key ON arena.leaderboard_rank_generation_claims USING btree (score_cohort_id)'),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'leaderboard_rank_generation_claims_identity_key',
         '2 3 4'::pg_catalog.int2vector, true, false, 3,
         'CREATE UNIQUE INDEX leaderboard_rank_generation_claims_identity_key ON arena.leaderboard_rank_generation_claims USING btree (season_id, generation_seq, score_cohort_id)'),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'leaderboard_rank_generation_heads_pkey',
         '1'::pg_catalog.int2vector, true, true, 1,
         'CREATE UNIQUE INDEX leaderboard_rank_generation_heads_pkey ON arena.leaderboard_rank_generation_heads USING btree (season_id)')
    ) AS expected(
      table_oid,
      index_name,
      key_columns,
      is_unique,
      is_primary,
      key_count,
      index_definition
    )
    LEFT JOIN pg_catalog.pg_class AS catalog_index
      ON catalog_index.relname = expected.index_name
     AND catalog_index.relnamespace = 'arena'::regnamespace
    LEFT JOIN pg_catalog.pg_index AS index_row
      ON index_row.indexrelid = catalog_index.oid
     AND index_row.indrelid = expected.table_oid
    LEFT JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = catalog_index.relam
    WHERE index_row.indexrelid IS NULL
       OR catalog_index.relkind <> 'i'
       OR catalog_index.relowner <> 'postgres'::regrole
       OR access_method.amname IS DISTINCT FROM 'btree'
       OR index_row.indkey IS DISTINCT FROM expected.key_columns
       OR index_row.indisunique IS DISTINCT FROM expected.is_unique
       OR index_row.indisprimary IS DISTINCT FROM expected.is_primary
       OR index_row.indnkeyatts IS DISTINCT FROM expected.key_count
       OR index_row.indnatts IS DISTINCT FROM expected.key_count
       OR NOT index_row.indisvalid
       OR NOT index_row.indisready
       OR NOT index_row.indislive
       OR NOT index_row.indimmediate
       OR index_row.indisclustered
       OR index_row.indisreplident
       OR index_row.indexprs IS NOT NULL
       OR index_row.indpred IS NOT NULL
       OR pg_catalog.pg_get_indexdef(index_row.indexrelid)
            IS DISTINCT FROM expected.index_definition
  ) THEN
    RAISE EXCEPTION 'generation table index contract drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
      'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass
    )
      AND trigger_row.tgisinternal
  ) <> 4 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'RI_FKey_noaction_del', 9::smallint),
        ('arena.leaderboard_rank_generation_claims'::regclass,
         'RI_FKey_noaction_upd', 17::smallint),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'RI_FKey_check_ins', 5::smallint),
        ('arena.leaderboard_rank_generation_heads'::regclass,
         'RI_FKey_check_upd', 17::smallint)
    ) AS expected(table_oid, function_name, trigger_type)
    LEFT JOIN pg_catalog.pg_proc AS trigger_function
      ON trigger_function.proname = expected.function_name
     AND trigger_function.pronamespace = 'pg_catalog'::regnamespace
    LEFT JOIN pg_catalog.pg_trigger AS trigger_row
      ON trigger_row.tgrelid = expected.table_oid
     AND trigger_row.tgisinternal
     AND trigger_row.tgfoid = trigger_function.oid
    WHERE trigger_row.oid IS NULL
       OR trigger_row.tgtype IS DISTINCT FROM expected.trigger_type
       OR trigger_row.tgenabled <> 'O'
       OR trigger_row.tgconstraint IS DISTINCT FROM (
         SELECT constraint_row.oid
         FROM pg_catalog.pg_constraint AS constraint_row
         WHERE constraint_row.conrelid =
             'arena.leaderboard_rank_generation_heads'::regclass
           AND constraint_row.conname =
             'leaderboard_rank_generation_heads_claim_fkey'
       )
       OR trigger_row.tgqual IS NOT NULL
       OR trigger_row.tgattr <> ''::pg_catalog.int2vector
       OR trigger_row.tgoldtable IS NOT NULL
       OR trigger_row.tgnewtable IS NOT NULL
       OR trigger_row.tgdeferrable
       OR trigger_row.tginitdeferred
       OR trigger_row.tgnargs <> 0
       OR trigger_row.tgargs <> '\x'::pg_catalog.bytea
       OR trigger_row.tgparentid <> 0
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
        'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
      AND NOT trigger_row.tgisinternal
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
        'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
      AND trigger_row.tgname =
        'leaderboard_rank_generation_claim_immutable'
      AND trigger_row.tgfoid =
        'arena.reject_leaderboard_rank_publication_mutation()'
          ::pg_catalog.regprocedure
      AND trigger_row.tgtype = 27
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
      AND trigger_row.tgenabled = 'O'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
        'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass
      AND NOT trigger_row.tgisinternal
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rule_row
    WHERE rule_row.ev_class IN (
      'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
      'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
      'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass
    )
  ) THEN
    RAISE EXCEPTION 'generation table trigger, rule, or policy drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS column_row
    JOIN (
      VALUES
        ('expected_rank_count'::text, 'pg_catalog.int4'::pg_catalog.regtype),
        ('expected_batch_count'::text, 'pg_catalog.int4'::pg_catalog.regtype)
    ) AS expected(column_name, column_type)
      ON expected.column_name = column_row.attname
     AND expected.column_type = column_row.atttypid
    WHERE column_row.attrelid =
        'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
      AND column_row.attnum > 0
      AND NOT column_row.attisdropped
      AND column_row.attnotnull
  ) <> 2 THEN
    RAISE EXCEPTION 'generation claim count columns drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
      AND constraint_row.conname =
        'leaderboard_rank_generation_claims_rank_count_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.connoinherit
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) =
        'CHECK (expected_rank_count >= 0 AND expected_rank_count <= 250000)'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
      AND constraint_row.conname =
        'leaderboard_rank_generation_claims_batch_count_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.connoinherit
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) =
        'CHECK (expected_rank_count = 0 AND expected_batch_count = 0 OR expected_rank_count > 0 AND expected_batch_count > 0 AND expected_batch_count <= expected_rank_count)'
  ) THEN
    RAISE EXCEPTION 'generation claim foundational count constraints drifted';
  END IF;

  IF v_capacity_constraint IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.oid = v_capacity_constraint
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND NOT constraint_row.connoinherit
      AND constraint_row.conkey = ARRAY[7, 6]::pg_catalog.int2[]
      AND pg_catalog.pg_get_expr(
        constraint_row.conbin,
        constraint_row.conrelid,
        false
      ) =
        '((expected_batch_count <= 4096) AND (expected_rank_count <= 64000) AND ((expected_rank_count)::bigint <= ((expected_batch_count)::bigint * 1000)))'
  ) THEN
    RAISE EXCEPTION 'generation batch capacity constraint drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ONLY arena.leaderboard_rank_generation_claims AS claim
    WHERE claim.expected_batch_count > 4096
       OR claim.expected_rank_count > 64000
       OR claim.expected_rank_count::bigint >
            claim.expected_batch_count::bigint * 1000
  ) THEN
    RAISE EXCEPTION 'existing generation claim exceeds bounded batch capacity';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.claim_leaderboard_rank_generation(
  p_season_id text,
  p_score_cohort_id uuid,
  p_write_set_sha256 text,
  p_expected_rank_count integer,
  p_expected_batch_count integer,
  p_computed_at timestamptz,
  p_lease_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '10s'
AS $function$
DECLARE
  v_head arena.leaderboard_rank_generation_heads%ROWTYPE;
  v_current arena.leaderboard_rank_generation_claims%ROWTYPE;
  v_existing arena.leaderboard_rank_generation_claims%ROWTYPE;
  v_now timestamptz;
  v_lease_expires_at timestamptz;
  v_next_generation_seq bigint;
  v_updated_count integer;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'generation claims require READ COMMITTED isolation'
      USING ERRCODE = '25001';
  END IF;
  IF p_season_id IS NULL OR p_season_id NOT IN ('7D', '30D', '90D') THEN
    RAISE EXCEPTION 'invalid generation season: %', p_season_id
      USING ERRCODE = '22023';
  END IF;
  IF p_score_cohort_id IS NULL THEN
    RAISE EXCEPTION 'generation score cohort is required'
      USING ERRCODE = '22023';
  END IF;
  IF p_write_set_sha256 IS NULL
     OR p_write_set_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'generation write-set digest must be lowercase sha256'
      USING ERRCODE = '22023';
  END IF;
  IF p_expected_rank_count IS NULL
     OR p_expected_rank_count < 0
     OR p_expected_rank_count > 64000
     OR p_expected_batch_count IS NULL
     OR p_expected_batch_count > 4096
     OR p_expected_rank_count::bigint >
          p_expected_batch_count::bigint * 1000
     OR NOT (
       (p_expected_rank_count = 0 AND p_expected_batch_count = 0)
       OR (
         p_expected_rank_count > 0
         AND p_expected_batch_count > 0
         AND p_expected_batch_count <= p_expected_rank_count
       )
     ) THEN
    RAISE EXCEPTION 'generation rank and batch counts are inconsistent'
      USING ERRCODE = '22023';
  END IF;
  IF p_computed_at IS NULL OR NOT pg_catalog.isfinite(p_computed_at) THEN
    RAISE EXCEPTION 'generation computed_at must be finite'
      USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL
     OR p_lease_seconds < 15
     OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'generation lease must be between 15 and 300 seconds'
      USING ERRCODE = '22023';
  END IF;

  SELECT head.*
  INTO STRICT v_head
  FROM ONLY arena.leaderboard_rank_generation_heads AS head
  WHERE head.season_id = p_season_id
  FOR UPDATE;

  -- Take the one authorization clock only after the potentially blocking row
  -- lock. A waiter that began before expiry must evaluate takeover at lock
  -- acquisition time, never statement-start time.
  v_now := pg_catalog.clock_timestamp();
  IF p_computed_at > v_now + interval '5 minutes' THEN
    RAISE EXCEPTION 'generation computed_at is too far in the future'
      USING ERRCODE = '22023';
  END IF;

  IF v_head.generation_seq > 0 THEN
    SELECT claim.*
    INTO STRICT v_current
    FROM ONLY arena.leaderboard_rank_generation_claims AS claim
    WHERE claim.season_id = v_head.season_id
      AND claim.generation_seq = v_head.generation_seq
      AND claim.score_cohort_id = v_head.score_cohort_id;

    IF v_head.phase IN ('claimed', 'writing', 'cleaned', 'reranked')
       AND v_head.lease_expires_at IS DISTINCT FROM v_current.lease_expires_at THEN
      RAISE EXCEPTION 'active generation head lease disagrees with its claim'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  SELECT claim.*
  INTO v_existing
  FROM ONLY arena.leaderboard_rank_generation_claims AS claim
  WHERE claim.score_cohort_id = p_score_cohort_id;

  IF FOUND THEN
    IF v_existing.season_id IS DISTINCT FROM p_season_id
       OR v_existing.write_set_sha256 IS DISTINCT FROM p_write_set_sha256
       OR v_existing.expected_rank_count IS DISTINCT FROM p_expected_rank_count
       OR v_existing.expected_batch_count IS DISTINCT FROM p_expected_batch_count
       OR v_existing.computed_at IS DISTINCT FROM p_computed_at
       OR v_existing.lease_seconds IS DISTINCT FROM p_lease_seconds THEN
      RAISE EXCEPTION 'generation cohort UUID was reused with different input'
        USING ERRCODE = '23505';
    END IF;

    IF v_head.generation_seq IS DISTINCT FROM v_existing.generation_seq
       OR v_head.score_cohort_id IS DISTINCT FROM v_existing.score_cohort_id
       OR v_head.phase NOT IN ('claimed', 'writing', 'cleaned', 'reranked')
       OR v_head.lease_expires_at IS DISTINCT FROM v_existing.lease_expires_at
       OR v_head.lease_expires_at <= v_now THEN
      RAISE EXCEPTION 'generation claim is expired, terminal, or superseded'
        USING ERRCODE = '55000';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'contract', v_existing.contract,
      'season_id', v_existing.season_id,
      'score_cohort_id', v_existing.score_cohort_id,
      'generation_seq', v_existing.generation_seq,
      'phase', 'claimed',
      'write_set_sha256', v_existing.write_set_sha256,
      'expected_rank_count', v_existing.expected_rank_count,
      'expected_batch_count', v_existing.expected_batch_count,
      'computed_at', pg_catalog.to_char(
        v_existing.computed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'claimed_at', pg_catalog.to_char(
        v_existing.claimed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'lease_expires_at', pg_catalog.to_char(
        v_existing.lease_expires_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )
    );
  END IF;

  IF v_head.phase IN ('claimed', 'writing', 'cleaned', 'reranked')
     AND v_head.lease_expires_at > v_now THEN
    RAISE EXCEPTION 'another leaderboard generation owns the active lease'
      USING ERRCODE = '55P03';
  END IF;
  IF v_head.generation_seq >= 9007199254740000 THEN
    RAISE EXCEPTION 'leaderboard generation sequence exhausted'
      USING ERRCODE = '54000';
  END IF;

  v_next_generation_seq := v_head.generation_seq + 1;
  v_lease_expires_at := v_now + p_lease_seconds * interval '1 second';

  INSERT INTO arena.leaderboard_rank_generation_claims (
    contract,
    season_id,
    generation_seq,
    score_cohort_id,
    write_set_sha256,
    expected_rank_count,
    expected_batch_count,
    computed_at,
    lease_seconds,
    claimed_at,
    lease_expires_at
  ) VALUES (
    'leaderboard-rank-generation-claim@1',
    p_season_id,
    v_next_generation_seq,
    p_score_cohort_id,
    p_write_set_sha256,
    p_expected_rank_count,
    p_expected_batch_count,
    p_computed_at,
    p_lease_seconds,
    v_now,
    v_lease_expires_at
  );

  UPDATE ONLY arena.leaderboard_rank_generation_heads AS head
  SET
    generation_seq = v_next_generation_seq,
    score_cohort_id = p_score_cohort_id,
    phase = 'claimed',
    lease_expires_at = v_lease_expires_at,
    updated_at = v_now
  WHERE head.season_id = p_season_id;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'generation head compare-and-set did not update exactly one row'
      USING ERRCODE = '55000';
  END IF;

  SELECT head.*
  INTO STRICT v_head
  FROM ONLY arena.leaderboard_rank_generation_heads AS head
  WHERE head.season_id = p_season_id;
  IF v_head.generation_seq IS DISTINCT FROM v_next_generation_seq
     OR v_head.score_cohort_id IS DISTINCT FROM p_score_cohort_id
     OR v_head.phase IS DISTINCT FROM 'claimed'
     OR v_head.lease_expires_at IS DISTINCT FROM v_lease_expires_at
     OR v_head.updated_at IS DISTINCT FROM v_now THEN
    RAISE EXCEPTION 'generation head compare-and-set postcondition failed'
      USING ERRCODE = '55000';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'contract', 'leaderboard-rank-generation-claim@1',
    'season_id', p_season_id,
    'score_cohort_id', p_score_cohort_id,
    'generation_seq', v_next_generation_seq,
    'phase', 'claimed',
    'write_set_sha256', p_write_set_sha256,
    'expected_rank_count', p_expected_rank_count,
    'expected_batch_count', p_expected_batch_count,
    'computed_at', pg_catalog.to_char(
      p_computed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'claimed_at', pg_catalog.to_char(
      v_now AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'lease_expires_at', pg_catalog.to_char(
      v_lease_expires_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  );
END;
$function$;

DO $install$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
      AND constraint_row.conname =
        'leaderboard_rank_generation_claims_batch_capacity_check'
  ) THEN
    ALTER TABLE ONLY arena.leaderboard_rank_generation_claims
      ADD CONSTRAINT leaderboard_rank_generation_claims_batch_capacity_check
      CHECK (
        expected_batch_count <= 4096
        AND expected_rank_count <= 64000
        AND expected_rank_count::bigint <=
          expected_batch_count::bigint * 1000
      ) NOT VALID;

    ALTER TABLE ONLY arena.leaderboard_rank_generation_claims
      VALIDATE CONSTRAINT
        leaderboard_rank_generation_claims_batch_capacity_check;
  END IF;
END
$install$;

DO $postflight$
DECLARE
  v_before_function oid;
  v_after_function oid := pg_catalog.to_regprocedure(
    'public.claim_leaderboard_rank_generation(text,uuid,text,integer,integer,timestamptz,integer)'
  );
BEGIN
  SELECT install.claim_function_oid
  INTO STRICT v_before_function
  FROM leaderboard_generation_capacity_install_state AS install;

  IF v_after_function IS NULL
     OR v_after_function IS DISTINCT FROM v_before_function
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_language AS language_row
         ON language_row.oid = function_row.prolang
       WHERE function_row.oid = v_after_function
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
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_after_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_after_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_after_function, 'EXECUTE'
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
       WHERE function_row.oid = v_after_function
         AND expanded.privilege_type = 'EXECUTE'
         AND expanded.grantee <> function_row.proowner
         AND expanded.grantee <> 'service_role'::pg_catalog.regrole
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS expanded
       WHERE function_row.oid = v_after_function
         AND expanded.grantee = 'service_role'::pg_catalog.regrole
         AND expanded.privilege_type = 'EXECUTE'
         AND expanded.is_grantable
     ) THEN
    RAISE EXCEPTION 'generation claim RPC postflight failed';
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
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND NOT constraint_row.connoinherit
      AND constraint_row.conkey = ARRAY[7, 6]::pg_catalog.int2[]
      AND pg_catalog.pg_get_expr(
        constraint_row.conbin,
        constraint_row.conrelid,
        false
      ) =
        '((expected_batch_count <= 4096) AND (expected_rank_count <= 64000) AND ((expected_rank_count)::bigint <= ((expected_batch_count)::bigint * 1000)))'
  ) OR EXISTS (
    SELECT 1
    FROM ONLY arena.leaderboard_rank_generation_claims AS claim
    WHERE claim.expected_batch_count > 4096
       OR claim.expected_rank_count > 64000
       OR claim.expected_rank_count::bigint >
            claim.expected_batch_count::bigint * 1000
  ) THEN
    RAISE EXCEPTION 'generation batch capacity postflight failed';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
  ) <> 14 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
        'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
      AND NOT trigger_row.tgisinternal
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
        'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass
      AND trigger_row.tgname =
        'leaderboard_rank_generation_claim_immutable'
      AND trigger_row.tgfoid =
        'arena.reject_leaderboard_rank_publication_mutation()'
          ::pg_catalog.regprocedure
      AND trigger_row.tgtype = 27
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
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
        'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass
      AND NOT trigger_row.tgisinternal
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rule_row
    WHERE rule_row.ev_class IN (
      'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
      'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid IN (
      'arena.leaderboard_rank_generation_claims'::pg_catalog.regclass,
      'arena.leaderboard_rank_generation_heads'::pg_catalog.regclass
    )
  ) THEN
    RAISE EXCEPTION 'generation capacity catalog postflight failed';
  END IF;
END
$postflight$;

COMMIT;
