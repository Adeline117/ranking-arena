-- Bind every copier snapshot receipt to one reviewed source/verifier contract.
--
-- This is a forward-only correction after 054500/054600. Copier writers remain
-- stopped before and during this transaction; a green commit/postflight does
-- not authorize restart without the RUNBOOK's app/cache and bounded-canary
-- gates. The registry is deliberately immutable: adding a source, changing a
-- verifier, or introducing a new depth requires another reviewed migration.

BEGIN;

SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260804-bind-copier-snapshot-source-authority',
    0
  )
);

DO $foundation_preflight$
DECLARE
  v_registry regclass := pg_catalog.to_regclass(
    'arena.copier_snapshot_source_authorities'
  );
  v_source_guard regprocedure := pg_catalog.to_regprocedure(
    'arena.enforce_copier_snapshot_source_configuration()'
  );
  v_trader_guard regprocedure := pg_catalog.to_regprocedure(
    'arena.enforce_copier_snapshot_trader_identity()'
  );
  v_publication_guard regprocedure := pg_catalog.to_regprocedure(
    'arena.enforce_copier_snapshot_publication_source_authority()'
  );
  v_immutable_guard regprocedure := pg_catalog.to_regprocedure(
    'arena.reject_copier_snapshot_source_authority_mutation()'
  );
  v_capabilities regprocedure := pg_catalog.to_regprocedure(
    'public.arena_source_capabilities()'
  );
  v_reader regprocedure := pg_catalog.to_regprocedure(
    'public.arena_copier_aggregate(text,text)'
  );
  v_publisher regprocedure := pg_catalog.to_regprocedure(
    'public.publish_copier_snapshot_v2(jsonb)'
  );
  v_legacy_publication_guard regprocedure := pg_catalog.to_regprocedure(
    'arena.reject_copier_snapshot_publication_mutation()'
  );
  v_legacy_row_guard regprocedure := pg_catalog.to_regprocedure(
    'arena.reject_copier_snapshot_row_mutation()'
  );
  v_legacy_reader regprocedure := pg_catalog.to_regprocedure(
    'arena.copier_aggregate_legacy_containment_v1(text,text)'
  );
  v_raw_guard regprocedure := pg_catalog.to_regprocedure(
    'arena.protect_copier_snapshot_raw_object()'
  );
  v_admission_guard regprocedure := pg_catalog.to_regprocedure(
    'arena.guard_copier_snapshot_publication_insert_v1()'
  );
  v_row_normalizer regprocedure := pg_catalog.to_regprocedure(
    'arena.normalize_copier_snapshot_row_source_event_v1()'
  );
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR current_user IS DISTINCT FROM 'postgres'
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass(
          'arena.copier_snapshot_publications'
        ) IS NULL
     OR pg_catalog.to_regclass('arena.mv_source_capabilities') IS NULL
     OR pg_catalog.to_regclass('arena.exchanges') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass('arena.copier_snapshot_rows') IS NULL
     OR v_capabilities IS NULL
     OR v_reader IS NULL
     OR v_legacy_publication_guard IS NULL
     OR v_legacy_row_guard IS NULL
     OR v_legacy_reader IS NULL
     OR v_raw_guard IS NULL
     OR v_admission_guard IS NULL
     OR v_row_normalizer IS NULL THEN
    RAISE EXCEPTION 'copier snapshot source authority requires PG17, postgres, publications, and capability foundations';
  END IF;

  IF pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'copier snapshot source authority requires canonical API roles';
  END IF;

  IF v_publisher IS NULL THEN
    RAISE EXCEPTION 'copier snapshot source authority requires the canonical V2 publisher';
  END IF;

  -- A relation with the registry name is not evidence that the authority was
  -- installed. Reject that partial lineage before choosing any replay-only
  -- function digest, so an arbitrary stub cannot be misclassified as a
  -- completed authority install.
  IF v_registry IS NOT NULL AND (
    v_source_guard IS NULL
    OR v_trader_guard IS NULL
    OR v_publication_guard IS NULL
    OR v_immutable_guard IS NULL
  ) THEN
    RAISE EXCEPTION 'copier snapshot source authority is partially installed';
  END IF;

  -- PostgREST resolves exposed functions by name and arguments. An extra or
  -- defaulted overload is therefore another public RPC, even when the exact
  -- canonical regprocedure remains present.
  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena_copier_aggregate', v_reader::oid),
        ('arena_source_capabilities', v_capabilities::oid),
        ('publish_copier_snapshot_v2', v_publisher::oid)
    ) AS expected(proname, function_oid)
    CROSS JOIN LATERAL (
      SELECT
        pg_catalog.count(*) AS symbol_count,
        pg_catalog.count(*) FILTER (
          WHERE procedure.oid = expected.function_oid
            AND procedure.pronargdefaults = 0
        ) AS canonical_count
      FROM pg_catalog.pg_proc AS procedure
      WHERE procedure.pronamespace = 'public'::pg_catalog.regnamespace
        AND procedure.proname = expected.proname
    ) AS actual
    WHERE actual.symbol_count IS DISTINCT FROM 1
       OR actual.canonical_count IS DISTINCT FROM 1
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.pronamespace = 'arena'::pg_catalog.regnamespace
      AND procedure.proname = 'copier_aggregate_legacy_containment_v1'
      AND procedure.oid = v_legacy_reader::oid
      AND procedure.pronargdefaults = 0
  ) IS DISTINCT FROM 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.pronamespace = 'arena'::pg_catalog.regnamespace
      AND procedure.proname = 'copier_aggregate_legacy_containment_v1'
  ) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'copier authority exposed RPC symbol inventory drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_publisher::oid
      AND procedure.proowner = 'postgres'::pg_catalog.regrole
      AND procedure.prosecdef
      AND procedure.provolatile = 'v'
      AND procedure.proconfig IS NOT DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(
                pg_catalog.pg_get_functiondef(procedure.oid),
                'UTF8'
              )
            ),
            'hex'
          ) = '9dd863f6f0ba59c9cb85b3e262c48e5b25ce057b74f121de817e8ebd59356a5d'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    v_publisher,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    v_publisher,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    v_publisher,
    'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS privilege
    WHERE procedure.oid = v_publisher::oid
      AND privilege.privilege_type = 'EXECUTE'
      AND NOT (
        (
          privilege.grantee = 'postgres'::pg_catalog.regrole::oid
          AND privilege.grantor = 'postgres'::pg_catalog.regrole::oid
          AND NOT privilege.is_grantable
        ) OR (
          privilege.grantee = 'service_role'::pg_catalog.regrole::oid
          AND privilege.grantor = 'postgres'::pg_catalog.regrole::oid
          AND NOT privilege.is_grantable
        )
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS privilege
    WHERE procedure.oid = v_publisher::oid
      AND privilege.privilege_type = 'EXECUTE'
  ) IS DISTINCT FROM 2
  THEN
    RAISE EXCEPTION 'canonical V2 publisher definition or ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN (
      VALUES
        (
          v_legacy_publication_guard::oid,
          'acf7bec862e1b3fe59832679e90288934a830399906ea09724d13a2520ca76c2'
        ),
        (
          v_legacy_row_guard::oid,
          '606531a05dd11e2ff767a2a451c58fd9c23fa72fed6096d2af7684a07632150e'
        ),
        (
          v_raw_guard::oid,
          CASE WHEN v_registry IS NULL
            THEN 'c1928715c82e13dd797afc46b58ded917b61926832e233b0450be36b4f194e40'
            ELSE 'bf8d6ad40386b78d221d911d3a743ff7a597ddd00dcb6c681fe4b4ac8cca1ba2'
          END
        ),
        (
          v_admission_guard::oid,
          CASE WHEN v_registry IS NULL
            THEN '781f23be3a766207fcd98dbc1dd8c44a1e9c70279793b25fd9216a57089c17fe'
            ELSE '781f23be3a766207fcd98dbc1dd8c44a1e9c70279793b25fd9216a57089c17fe'
          END
        ),
        (
          v_row_normalizer::oid,
          CASE WHEN v_registry IS NULL
            THEN 'ac781e999f77a8a300c7062cfe49babc11a737e0f975dbc827a3b2e36527245e'
            ELSE '521da78c8d0a696960cfe02b26a3986c4fb2d10c1295379bb380411115d00285'
          END
        )
    ) AS expected(function_oid, functiondef_sha256)
      ON expected.function_oid = procedure.oid
    WHERE procedure.proowner IS DISTINCT FROM
        'postgres'::pg_catalog.regrole
       OR procedure.prosecdef
       OR procedure.prokind IS DISTINCT FROM 'f'
       OR procedure.prorettype IS DISTINCT FROM
          'trigger'::pg_catalog.regtype
       OR procedure.provolatile IS DISTINCT FROM 'v'
       OR procedure.proisstrict
       OR procedure.proleakproof
       OR procedure.proparallel IS DISTINCT FROM 'u'
       OR procedure.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
       OR pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(
                pg_catalog.pg_get_functiondef(procedure.oid),
                'UTF8'
              )
            ),
            'hex'
          ) IS DISTINCT FROM expected.functiondef_sha256
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS privilege
    WHERE procedure.oid IN (
      v_legacy_publication_guard::oid,
      v_legacy_row_guard::oid,
      v_raw_guard::oid,
      v_admission_guard::oid,
      v_row_normalizer::oid
    )
      AND NOT (
        privilege.privilege_type = 'EXECUTE'
        AND privilege.grantee = procedure.proowner
        AND privilege.grantor = procedure.proowner
        AND NOT privilege.is_grantable
      )
  ) OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (v_legacy_publication_guard::oid),
        (v_legacy_row_guard::oid),
        (v_raw_guard::oid),
        (v_admission_guard::oid),
        (v_row_normalizer::oid)
    ) AS expected(function_oid)
    CROSS JOIN LATERAL (
      SELECT pg_catalog.count(*) AS privilege_count
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner)
        )
      ) AS privilege
      WHERE procedure.oid = expected.function_oid
        AND privilege.privilege_type = 'EXECUTE'
    ) AS actual
    WHERE actual.privilege_count IS DISTINCT FROM 1
  ) THEN
    RAISE EXCEPTION 'canonical copier receipt immutability guard drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_language AS language
      ON language.oid = procedure.prolang
    WHERE procedure.oid = v_legacy_reader::oid
      AND procedure.proowner = 'postgres'::pg_catalog.regrole
      AND procedure.prosecdef
      AND procedure.prokind = 'f'
      AND procedure.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND procedure.provolatile = 's'
      AND NOT procedure.proisstrict
      AND NOT procedure.proleakproof
      AND procedure.proparallel = 'u'
      AND procedure.proargnames IS NOT DISTINCT FROM
          ARRAY['p_source', 'p_trader']::text[]
      AND procedure.pronargdefaults = 0
      AND procedure.proconfig IS NOT DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND language.lanname = 'sql'
      AND pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(
                pg_catalog.pg_get_functiondef(procedure.oid),
                'UTF8'
              )
            ),
            'hex'
          ) = '18b285bc1ff2e2ba29027cd8c192583a54181dac8be4c403c9df95540a98bee9'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS privilege
    WHERE procedure.oid = v_legacy_reader::oid
      AND privilege.privilege_type = 'EXECUTE'
      AND NOT (
        privilege.grantee = 'postgres'::pg_catalog.regrole::oid
        AND privilege.grantor = 'postgres'::pg_catalog.regrole::oid
        AND NOT privilege.is_grantable
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS privilege
    WHERE procedure.oid = v_legacy_reader::oid
      AND privilege.privilege_type = 'EXECUTE'
  ) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'private legacy copier containment reader drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'arena.sources'::pg_catalog.regclass
      AND attribute.attname IN (
        'id',
        'slug',
        'adapter_slug',
        'product_type',
        'trader_kind_scope',
        'currency',
        'copier_table_depth',
        'status',
        'serving_mode',
        'exchange_id',
        'timeframes_native',
        'timeframes_derived'
      )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 12 THEN
    RAISE EXCEPTION 'arena.sources copier authority columns drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
        'arena.copier_snapshot_publications'::pg_catalog.regclass
      AND attribute.attname IN (
        'source_id',
        'trader_id',
        'source_depth',
        'currency',
        'terminal_verifier_contract',
        'evidence_contract',
        'publisher_contract',
        'evidence_state',
        'scan_terminal_state',
        'caller_limited',
        'blocker_reasons'
      )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 11 THEN
    RAISE EXCEPTION 'copier snapshot publication authority columns drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
        'arena.mv_source_capabilities'::pg_catalog.regclass
      AND attribute.attname IN ('slug', 'cap')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 2 THEN
    RAISE EXCEPTION 'materialized source capability projection drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'arena.sources'::pg_catalog.regclass
      AND relation.relkind = 'r'
      AND relation.relowner = 'postgres'::pg_catalog.regrole
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'arena.traders'::pg_catalog.regclass
      AND relation.relkind = 'r'
      AND relation.relowner = 'postgres'::pg_catalog.regrole
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'arena.exchanges'::pg_catalog.regclass
      AND relation.relkind = 'r'
      AND relation.relowner = 'postgres'::pg_catalog.regrole
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid =
        'arena.copier_snapshot_publications'::pg_catalog.regclass
      AND relation.relkind = 'r'
      AND relation.relowner = 'postgres'::pg_catalog.regrole
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid =
        'arena.copier_snapshot_rows'::pg_catalog.regclass
      AND relation.relkind = 'r'
      AND relation.relowner = 'postgres'::pg_catalog.regrole
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid =
        'arena.mv_source_capabilities'::pg_catalog.regclass
      AND relation.relkind = 'm'
      AND relation.relowner = 'postgres'::pg_catalog.regrole
  ) THEN
    RAISE EXCEPTION 'copier source authority foundation owner or RLS drifted';
  END IF;

  -- Every authoritative base relation is a permanent standalone heap. Parent
  -- and child tables would make non-ONLY scans include rows that do not inherit
  -- the parent's constraints, RLS, ACLs, or ALWAYS triggers.
  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('sources', pg_catalog.to_regclass('arena.sources')::oid),
        ('exchanges', pg_catalog.to_regclass('arena.exchanges')::oid),
        ('traders', pg_catalog.to_regclass('arena.traders')::oid),
        ('raw_objects', pg_catalog.to_regclass('arena.raw_objects')::oid),
        (
          'copier_snapshot_publications',
          pg_catalog.to_regclass(
            'arena.copier_snapshot_publications'
          )::oid
        ),
        (
          'copier_snapshot_rows',
          pg_catalog.to_regclass('arena.copier_snapshot_rows')::oid
        ),
        ('copier_snapshot_source_authorities', v_registry::oid)
    ) AS expected(relation_name, relation_oid)
    LEFT JOIN pg_catalog.pg_class AS relation
      ON relation.oid = expected.relation_oid
    WHERE expected.relation_oid IS NOT NULL
      AND (
        relation.oid IS NULL
        OR relation.relkind IS DISTINCT FROM 'r'
        OR relation.relpersistence IS DISTINCT FROM 'p'
        OR relation.relowner IS DISTINCT FROM
            'postgres'::pg_catalog.regrole
        OR relation.relispartition
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_inherits AS inheritance
          WHERE inheritance.inhrelid = expected.relation_oid
             OR inheritance.inhparent = expected.relation_oid
        )
      )
  ) THEN
    RAISE EXCEPTION 'copier authority critical relation inheritance or durability drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('id', 'smallint', true),
        ('slug', 'text', true),
        ('adapter_slug', 'text', true),
        ('product_type', 'text', true),
        ('trader_kind_scope', 'text', true),
        ('currency', 'text', true),
        ('copier_table_depth', 'text', true),
        ('status', 'text', true),
        ('serving_mode', 'text', true),
        ('exchange_id', 'smallint', true),
        ('timeframes_native', 'integer[]', true),
        ('timeframes_derived', 'integer[]', true)
    ) AS expected(attname, type_name, not_null)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = 'arena.sources'::pg_catalog.regclass
     AND attribute.attname = expected.attname
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR pg_catalog.format_type(
            attribute.atttypid,
            attribute.atttypmod
          ) IS DISTINCT FROM expected.type_name
       OR attribute.attnotnull IS DISTINCT FROM expected.not_null
  ) OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('source_id', 'smallint', true),
        ('trader_id', 'bigint', true),
        ('source_depth', 'text', true),
        ('currency', 'text', true),
        ('terminal_verifier_contract', 'text', false),
        ('evidence_contract', 'text', true),
        ('publisher_contract', 'text', true),
        ('evidence_state', 'text', false),
        ('scan_terminal_state', 'text', true),
        ('caller_limited', 'boolean', true),
        ('blocker_reasons', 'jsonb', false)
    ) AS expected(attname, type_name, not_null)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid =
          'arena.copier_snapshot_publications'::pg_catalog.regclass
     AND attribute.attname = expected.attname
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR pg_catalog.format_type(
            attribute.atttypid,
            attribute.atttypmod
          ) IS DISTINCT FROM expected.type_name
       OR attribute.attnotnull IS DISTINCT FROM expected.not_null
  ) OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('id', 'bigint', true),
        ('source_id', 'smallint', true),
        ('exchange_trader_id', 'text', true),
        ('meta', 'jsonb', true)
    ) AS expected(attname, type_name, not_null)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = 'arena.traders'::pg_catalog.regclass
     AND attribute.attname = expected.attname
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR pg_catalog.format_type(
            attribute.atttypid,
            attribute.atttypmod
          ) IS DISTINCT FROM expected.type_name
       OR attribute.attnotnull IS DISTINCT FROM expected.not_null
  ) OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('id', 'smallint', true),
        ('slug', 'text', true),
        ('name', 'text', true)
    ) AS expected(attname, type_name, not_null)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = 'arena.exchanges'::pg_catalog.regclass
     AND attribute.attname = expected.attname
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR pg_catalog.format_type(
            attribute.atttypid,
            attribute.atttypmod
          ) IS DISTINCT FROM expected.type_name
       OR attribute.attnotnull IS DISTINCT FROM expected.not_null
  ) OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('slug', 'text', false),
        ('cap', 'jsonb', false)
    ) AS expected(attname, type_name, not_null)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid =
          'arena.mv_source_capabilities'::pg_catalog.regclass
     AND attribute.attname = expected.attname
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR pg_catalog.format_type(
            attribute.atttypid,
            attribute.atttypmod
          ) IS DISTINCT FROM expected.type_name
       OR attribute.attnotnull IS DISTINCT FROM expected.not_null
  ) THEN
    RAISE EXCEPTION 'copier source authority foundation column shape drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS index_relation
    JOIN pg_catalog.pg_index AS index_row
      ON index_row.indexrelid = index_relation.oid
    WHERE index_relation.oid = pg_catalog.to_regclass(
            'arena.idx_copier_snapshot_publication_latest'
          )
      AND index_relation.relkind = 'i'
      AND index_relation.relowner = 'postgres'::pg_catalog.regrole
      AND index_row.indrelid =
          'arena.copier_snapshot_publications'::pg_catalog.regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indislive
      AND pg_catalog.pg_get_indexdef(index_relation.oid) =
          'CREATE INDEX idx_copier_snapshot_publication_latest ON arena.copier_snapshot_publications USING btree (source_id, trader_id, observed_at DESC, publication_id DESC)'
  ) THEN
    RAISE EXCEPTION 'copier snapshot latest-receipt index drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'arena.traders'::pg_catalog.regclass
      AND constraint_row.contype = 'u'
      AND pg_catalog.pg_get_constraintdef(
            constraint_row.oid,
            true
          ) = 'UNIQUE (source_id, exchange_trader_id)'
  ) THEN
    RAISE EXCEPTION 'copier trader external identity constraint drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    JOIN (
      VALUES
        (
          'arena.copier_snapshot_publications'::pg_catalog.regclass,
          'copier_snapshot_publication_reject_update_delete',
          v_legacy_publication_guard::oid,
          'CREATE TRIGGER copier_snapshot_publication_reject_update_delete BEFORE DELETE OR UPDATE ON arena.copier_snapshot_publications FOR EACH ROW EXECUTE FUNCTION arena.reject_copier_snapshot_publication_mutation()'
        ),
        (
          'arena.copier_snapshot_publications'::pg_catalog.regclass,
          'copier_snapshot_publication_reject_truncate',
          v_legacy_publication_guard::oid,
          'CREATE TRIGGER copier_snapshot_publication_reject_truncate BEFORE TRUNCATE ON arena.copier_snapshot_publications FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_copier_snapshot_publication_mutation()'
        ),
        (
          'arena.copier_snapshot_rows'::pg_catalog.regclass,
          'copier_snapshot_row_reject_update_delete',
          v_legacy_row_guard::oid,
          'CREATE TRIGGER copier_snapshot_row_reject_update_delete BEFORE DELETE OR UPDATE ON arena.copier_snapshot_rows FOR EACH ROW EXECUTE FUNCTION arena.reject_copier_snapshot_row_mutation()'
        ),
        (
          'arena.copier_snapshot_rows'::pg_catalog.regclass,
          'copier_snapshot_row_reject_truncate',
          v_legacy_row_guard::oid,
          'CREATE TRIGGER copier_snapshot_row_reject_truncate BEFORE TRUNCATE ON arena.copier_snapshot_rows FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_copier_snapshot_row_mutation()'
        ),
        (
          'arena.raw_objects'::pg_catalog.regclass,
          'protect_copier_snapshot_raw_before_write',
          v_raw_guard::oid,
          'CREATE TRIGGER protect_copier_snapshot_raw_before_write BEFORE DELETE OR UPDATE ON arena.raw_objects FOR EACH ROW EXECUTE FUNCTION arena.protect_copier_snapshot_raw_object()'
        ),
        (
          'arena.copier_snapshot_publications'::pg_catalog.regclass,
          'copier_snapshot_publication_guard_insert_v1',
          v_admission_guard::oid,
          'CREATE TRIGGER copier_snapshot_publication_guard_insert_v1 BEFORE INSERT ON arena.copier_snapshot_publications FOR EACH ROW EXECUTE FUNCTION arena.guard_copier_snapshot_publication_insert_v1()'
        ),
        (
          'arena.copier_snapshot_rows'::pg_catalog.regclass,
          'copier_snapshot_row_normalize_source_event_v1',
          v_row_normalizer::oid,
          'CREATE TRIGGER copier_snapshot_row_normalize_source_event_v1 BEFORE INSERT ON arena.copier_snapshot_rows FOR EACH ROW EXECUTE FUNCTION arena.normalize_copier_snapshot_row_source_event_v1()'
        )
    ) AS expected(relation_oid, trigger_name, function_oid, definition)
      ON expected.relation_oid = trigger_row.tgrelid
     AND expected.trigger_name = trigger_row.tgname
    WHERE NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = CASE
        WHEN v_registry IS NULL THEN 'O'
        ELSE 'A'
      END
      AND trigger_row.tgfoid = expected.function_oid
      AND pg_catalog.pg_get_triggerdef(trigger_row.oid, true) =
          expected.definition
  ) <> 7 THEN
    RAISE EXCEPTION 'canonical copier receipt immutability triggers drifted';
  END IF;

  IF (
    (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid IN (
        'arena.copier_snapshot_publications'::pg_catalog.regclass,
        'arena.copier_snapshot_rows'::pg_catalog.regclass
      )
        AND NOT trigger_row.tgisinternal
    ) IS DISTINCT FROM (CASE WHEN v_registry IS NULL THEN 6 ELSE 7 END)
    OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid IN (
         'arena.copier_snapshot_publications'::pg_catalog.regclass,
         'arena.copier_snapshot_rows'::pg_catalog.regclass
       )
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgname NOT IN (
           'copier_snapshot_publication_reject_update_delete',
           'copier_snapshot_publication_reject_truncate',
           'copier_snapshot_publication_guard_insert_v1',
           'copier_snapshot_publication_00_source_authority',
           'copier_snapshot_row_reject_update_delete',
           'copier_snapshot_row_reject_truncate',
           'copier_snapshot_row_normalize_source_event_v1'
         )
     )
  ) THEN
    RAISE EXCEPTION 'copier snapshot publication or row trigger inventory drifted';
  END IF;

  -- A later alphabetic BEFORE trigger on RAW can rewrite a value after the
  -- copier guard accepts it.  Permit only the reviewed cross-surface guards;
  -- any new RAW trigger needs an explicit forward authority migration.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgname NOT IN (
        'raw_objects_require_tier_a_execution',
        'zz_raw_objects_verify_tier_a_execution',
        'protect_metric_trust_raw_object_before_write',
        'protect_leaderboard_acquisition_raw_evidence_before_write',
        'protect_record_surface_publication_raw_before_write',
        'admit_position_history_raw_after_insert',
        'protect_position_history_raw_evidence_before_write',
        'reject_position_history_raw_truncate',
        'protect_copier_snapshot_raw_before_write'
      )
  ) THEN
    RAISE EXCEPTION 'copier snapshot RAW trigger inventory drifted';
  END IF;

  -- Publications have been private since 053000. Unlike the legacy public MV,
  -- any first-install publication grant/policy is evidence of a bypass and
  -- must stop deployment rather than being silently revoked and laundered.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS sequence_row
    WHERE sequence_row.oid = pg_catalog.to_regclass(
            'arena.copier_snapshot_publications_publication_id_seq'
          )
      AND sequence_row.relkind = 'S'
      AND sequence_row.relowner = 'postgres'::pg_catalog.regrole
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid IN (
      'arena.copier_snapshot_publications'::pg_catalog.regclass,
      'arena.copier_snapshot_rows'::pg_catalog.regclass
    )
  ) OR EXISTS (
    SELECT 1
    FROM (
      VALUES ('anon'), ('authenticated'), ('service_role')
    ) AS api_role(role_name)
    WHERE pg_catalog.has_table_privilege(
      api_role.role_name,
      'arena.copier_snapshot_publications',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) OR pg_catalog.has_any_column_privilege(
      api_role.role_name,
      'arena.copier_snapshot_publications',
      'SELECT,INSERT,UPDATE,REFERENCES'
    ) OR pg_catalog.has_sequence_privilege(
      api_role.role_name,
      'arena.copier_snapshot_publications_publication_id_seq',
      'SELECT,USAGE,UPDATE'
    ) OR pg_catalog.has_table_privilege(
      api_role.role_name,
      'arena.copier_snapshot_rows',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) OR pg_catalog.has_any_column_privilege(
      api_role.role_name,
      'arena.copier_snapshot_rows',
      'SELECT,INSERT,UPDATE,REFERENCES'
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault(
          CASE relation.relkind
            WHEN 'S' THEN 'S'
            ELSE 'r'
          END::"char",
          relation.relowner
        )
      )
    ) AS privilege
    WHERE relation.oid IN (
      'arena.copier_snapshot_publications'::pg_catalog.regclass,
      'arena.copier_snapshot_rows'::pg_catalog.regclass,
      'arena.copier_snapshot_publications_publication_id_seq'::pg_catalog.regclass
    )
      AND NOT (
        privilege.grantee = relation.relowner
        AND privilege.grantor = relation.relowner
        AND NOT privilege.is_grantable
      )
  ) OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'arena.copier_snapshot_publications'::pg_catalog.regclass,
          8::bigint
        ),
        ('arena.copier_snapshot_rows'::pg_catalog.regclass, 8::bigint),
        (
          'arena.copier_snapshot_publications_publication_id_seq'::pg_catalog.regclass,
          3::bigint
        )
    ) AS expected(relation_oid, privilege_count)
    CROSS JOIN LATERAL (
      SELECT pg_catalog.count(*) AS privilege_count
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault(
            CASE relation.relkind
              WHEN 'S' THEN 'S'
              ELSE 'r'
            END::"char",
            relation.relowner
          )
        )
      ) AS privilege
      WHERE relation.oid = expected.relation_oid
    ) AS actual
    WHERE actual.privilege_count IS DISTINCT FROM
        expected.privilege_count
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid IN (
      'arena.copier_snapshot_publications'::pg_catalog.regclass,
      'arena.copier_snapshot_rows'::pg_catalog.regclass
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attacl IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'private copier publication ACL or policy drifted before source authority';
  END IF;

  -- The legacy MV intentionally arrives with only the three canonical API-role
  -- grants that this forward migration revokes. Any other grantee is drift and
  -- must not be laundered into the new owner-only projection boundary.
  IF v_registry IS NULL AND (
    EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS privilege
      WHERE relation.oid =
          'arena.mv_source_capabilities'::pg_catalog.regclass
        AND privilege.grantee NOT IN (
          relation.relowner,
          0::oid,
          'anon'::pg_catalog.regrole::oid,
          'authenticated'::pg_catalog.regrole::oid,
          'service_role'::pg_catalog.regrole::oid
        )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid =
          'arena.mv_source_capabilities'::pg_catalog.regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND attribute.attacl IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'legacy capability projection has an unreviewed ACL grant';
  END IF;

  IF v_registry IS NULL AND (
    v_source_guard IS NOT NULL
    OR v_trader_guard IS NOT NULL
    OR v_publication_guard IS NOT NULL
    OR v_immutable_guard IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'copier snapshot source authority is partially installed';
  END IF;

  IF v_registry IS NOT NULL AND (
    v_source_guard IS NULL
    OR v_trader_guard IS NULL
    OR v_publication_guard IS NULL
    OR v_immutable_guard IS NULL
  ) THEN
    RAISE EXCEPTION 'copier snapshot source authority replay lineage drifted';
  END IF;

  IF v_registry IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_registry
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND relation.relowner = 'postgres'::pg_catalog.regrole
        AND relation.relrowsecurity
        AND relation.relforcerowsecurity
    ) OR (
      SELECT pg_catalog.count(*)
      FROM (
        SELECT actual.*
        FROM pg_catalog.pg_attribute AS actual
        WHERE actual.attrelid = v_registry
          AND actual.attnum > 0
          AND NOT actual.attisdropped
      ) AS attribute
      FULL JOIN (
        VALUES
          (1, 'source_id', 'smallint', true),
          (2, 'source_slug', 'text', true),
          (3, 'exchange_id', 'smallint', true),
          (4, 'adapter_slug', 'text', true),
          (5, 'product_type', 'text', true),
          (6, 'trader_kind_scope', 'text', true),
          (7, 'currency', 'text', true),
          (8, 'copier_table_depth', 'text', true),
          (9, 'publication_eligible', 'boolean', true),
          (10, 'terminal_verifier_contract', 'text', false),
          (11, 'authority_contract', 'text', true),
          (12, 'contract_version', 'smallint', true)
      ) AS expected(attnum, attname, type_name, not_null)
        ON expected.attnum = attribute.attnum
      WHERE attribute.attnum IS NULL
         OR expected.attnum IS NULL
         OR attribute.attname IS DISTINCT FROM expected.attname
         OR pg_catalog.format_type(
              attribute.atttypid,
              attribute.atttypmod
            ) IS DISTINCT FROM expected.type_name
         OR attribute.attnotnull IS DISTINCT FROM expected.not_null
         OR attribute.atthasdef
         OR attribute.attidentity IS DISTINCT FROM ''
         OR attribute.attgenerated IS DISTINCT FROM ''
         OR attribute.attacl IS NOT NULL
    ) <> 0 OR (
      SELECT pg_catalog.count(*)
      FROM (
        SELECT actual.*
        FROM pg_catalog.pg_constraint AS actual
        WHERE actual.conrelid = v_registry
      ) AS constraint_row
      FULL JOIN (
        VALUES
          (
            'copier_snapshot_source_authorities_authority_contract_check',
            'c'::"char",
            'CHECK (authority_contract = ''arena.copier-snapshot-source-authority@1''::text)'
          ),
          (
            'copier_snapshot_source_authorities_contract_version_check',
            'c'::"char",
            'CHECK (contract_version = 1)'
          ),
          (
            'copier_snapshot_source_authorities_copier_table_depth_check',
            'c'::"char",
            'CHECK (copier_table_depth = ANY (ARRAY[''full''::text, ''top10''::text, ''top3_preview''::text]))'
          ),
          (
            'copier_snapshot_source_authorities_pkey',
            'p'::"char",
            'PRIMARY KEY (source_id)'
          ),
          (
            'copier_snapshot_source_authorities_source_id_fkey',
            'f'::"char",
            'FOREIGN KEY (source_id) REFERENCES arena.sources(id) ON DELETE RESTRICT'
          ),
          (
            'copier_snapshot_source_authorities_exchange_id_fkey',
            'f'::"char",
            'FOREIGN KEY (exchange_id) REFERENCES arena.exchanges(id) ON DELETE RESTRICT'
          ),
          (
            'copier_snapshot_source_authorities_source_slug_key',
            'u'::"char",
            'UNIQUE (source_slug)'
          ),
          (
            'copier_snapshot_source_authority_publication_shape',
            'c'::"char",
            'CHECK ((NOT publication_eligible IS DISTINCT FROM true AND (copier_table_depth = ANY (ARRAY[''full''::text, ''top10''::text])) AND terminal_verifier_contract IS NOT NULL AND (terminal_verifier_contract ~ ''^arena\.ingest\.history-terminal-verifier\.[a-z0-9_]+(?:\.[a-z0-9_]+)*\.copiers@[1-9][0-9]*$''::text) IS TRUE OR NOT publication_eligible IS DISTINCT FROM false AND NOT source_slug IS DISTINCT FROM ''lbank_futures''::text AND NOT adapter_slug IS DISTINCT FROM ''lbank''::text AND NOT product_type IS DISTINCT FROM ''futures''::text AND NOT trader_kind_scope IS DISTINCT FROM ''human''::text AND NOT currency IS DISTINCT FROM ''USDT''::text AND NOT copier_table_depth IS DISTINCT FROM ''top3_preview''::text AND terminal_verifier_contract IS NULL) IS TRUE)'
          )
      ) AS expected(conname, contype, definition)
        ON expected.conname = constraint_row.conname
      WHERE constraint_row.oid IS NULL
         OR expected.conname IS NULL
         OR constraint_row.contype IS DISTINCT FROM expected.contype
         OR pg_catalog.pg_get_constraintdef(
              constraint_row.oid,
              true
            ) IS DISTINCT FROM expected.definition
    ) <> 0 THEN
      RAISE EXCEPTION 'copier snapshot source authority replay catalog shape drifted';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_registry
        AND policy.polname =
          'owner_copier_snapshot_source_authority_read'
        AND policy.polcmd = 'r'
        AND policy.polpermissive
        AND policy.polroles =
          ARRAY['postgres'::pg_catalog.regrole::oid]::oid[]
        AND pg_catalog.pg_get_expr(
          policy.polqual,
          policy.polrelid
        ) = 'true'
        AND policy.polwithcheck IS NULL
    ) OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_registry
    ) <> 1 OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS privilege
      WHERE relation.oid = v_registry
        AND NOT (
          privilege.grantee = relation.relowner
          AND privilege.grantor = relation.relowner
          AND NOT privilege.is_grantable
        )
    ) OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS privilege
      WHERE relation.oid = v_registry
    ) IS DISTINCT FROM 8 OR EXISTS (
      SELECT 1
      FROM (
        VALUES ('anon'), ('authenticated'), ('service_role')
      ) AS api_role(role_name)
      WHERE pg_catalog.has_any_column_privilege(
        api_role.role_name,
        v_registry,
        'SELECT'
      ) OR pg_catalog.has_any_column_privilege(
        api_role.role_name,
        v_registry,
        'INSERT'
      ) OR pg_catalog.has_any_column_privilege(
        api_role.role_name,
        v_registry,
        'UPDATE'
      ) OR pg_catalog.has_any_column_privilege(
        api_role.role_name,
        v_registry,
        'REFERENCES'
      )
    ) THEN
      RAISE EXCEPTION 'copier snapshot source authority replay policy or ACL drifted';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM (
        VALUES ('anon'), ('authenticated'), ('service_role')
      ) AS api_role(role_name)
      CROSS JOIN (
        VALUES
          ('arena.copier_snapshot_publications'::pg_catalog.regclass),
          ('arena.copier_snapshot_rows'::pg_catalog.regclass),
          ('arena.mv_source_capabilities'::pg_catalog.regclass)
      ) AS private_projection(relation_oid)
      WHERE pg_catalog.has_table_privilege(
        api_role.role_name,
        private_projection.relation_oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
      ) OR pg_catalog.has_any_column_privilege(
        api_role.role_name,
        private_projection.relation_oid,
        'SELECT,INSERT,UPDATE,REFERENCES'
      )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault(
            CASE relation.relkind
              WHEN 'S' THEN 'S'
              ELSE 'r'
            END::"char",
            relation.relowner
          )
        )
      ) AS privilege
      WHERE relation.oid IN (
        'arena.copier_snapshot_publications'::pg_catalog.regclass,
        'arena.copier_snapshot_rows'::pg_catalog.regclass,
        'arena.copier_snapshot_publications_publication_id_seq'::pg_catalog.regclass,
        'arena.mv_source_capabilities'::pg_catalog.regclass
      )
        AND NOT (
          privilege.grantee = relation.relowner
          AND privilege.grantor = relation.relowner
          AND NOT privilege.is_grantable
        )
    ) OR EXISTS (
      SELECT 1
      FROM (
        VALUES
          (
            'arena.copier_snapshot_publications'::pg_catalog.regclass,
            8::bigint
          ),
          (
            'arena.copier_snapshot_rows'::pg_catalog.regclass,
            8::bigint
          ),
          (
            'arena.copier_snapshot_publications_publication_id_seq'::pg_catalog.regclass,
            3::bigint
          ),
          (
            'arena.mv_source_capabilities'::pg_catalog.regclass,
            8::bigint
          )
      ) AS expected(relation_oid, privilege_count)
      CROSS JOIN LATERAL (
        SELECT pg_catalog.count(*) AS privilege_count
        FROM pg_catalog.pg_class AS relation
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            relation.relacl,
            pg_catalog.acldefault(
              CASE relation.relkind
                WHEN 'S' THEN 'S'
                ELSE 'r'
              END::"char",
              relation.relowner
            )
          )
        ) AS privilege
        WHERE relation.oid = expected.relation_oid
      ) AS actual
      WHERE actual.privilege_count IS DISTINCT FROM
          expected.privilege_count
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid IN (
        'arena.copier_snapshot_publications'::pg_catalog.regclass,
        'arena.copier_snapshot_rows'::pg_catalog.regclass,
        'arena.mv_source_capabilities'::pg_catalog.regclass
      )
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND attribute.attacl IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'copier snapshot direct projection ACL drifted on replay';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      JOIN (
        VALUES
          (
            v_immutable_guard::oid,
            '86b876a92aebfdd0f8dee778a4d9ea6a1bdbb1a78a83341a409639cc5fcaffef'
          ),
          (
            v_source_guard::oid,
            '61fc1a1140183442c8401258dfbb320ae574d69e9f1f359fb5bf28c8b9c20db9'
          ),
          (
            v_trader_guard::oid,
            '81cf59f7b3f2c8a69659e282d9767d2e4efd918fe15247854ed18c8074b5f5d9'
          ),
          (
            v_publication_guard::oid,
            'a7a88ab9a023d9ce0496649b149b2de411fb3cc9022a56abbc8605d1cb45ae90'
          ),
          (
            v_capabilities::oid,
            '071c2e695828c548a62dd59e06723e11b00c28ff7482ad3352971fb642a3ba57'
          ),
          (
            v_reader::oid,
            'b58d79f1443fa2804e7341e388d519d4e2b0852b8e93376ab0897bcb8e6c804f'
          ),
          (
            v_legacy_publication_guard::oid,
            'acf7bec862e1b3fe59832679e90288934a830399906ea09724d13a2520ca76c2'
          ),
          (
            v_legacy_row_guard::oid,
            '606531a05dd11e2ff767a2a451c58fd9c23fa72fed6096d2af7684a07632150e'
          ),
          (
            v_legacy_reader::oid,
            '18b285bc1ff2e2ba29027cd8c192583a54181dac8be4c403c9df95540a98bee9'
          ),
          (
            v_raw_guard::oid,
            'bf8d6ad40386b78d221d911d3a743ff7a597ddd00dcb6c681fe4b4ac8cca1ba2'
          ),
          (
            v_admission_guard::oid,
            '781f23be3a766207fcd98dbc1dd8c44a1e9c70279793b25fd9216a57089c17fe'
          ),
          (
            v_row_normalizer::oid,
            '521da78c8d0a696960cfe02b26a3986c4fb2d10c1295379bb380411115d00285'
          )
      ) AS expected(function_oid, functiondef_sha256)
        ON expected.function_oid = procedure.oid
      WHERE procedure.proowner IS DISTINCT FROM
          'postgres'::pg_catalog.regrole
         OR (
           procedure.oid IN (
             v_immutable_guard::oid,
             v_source_guard::oid,
             v_trader_guard::oid,
             v_publication_guard::oid,
             v_capabilities::oid,
             v_reader::oid,
             v_legacy_reader::oid
           )
           AND NOT procedure.prosecdef
         )
         OR (
           procedure.oid IN (
             v_legacy_publication_guard::oid,
             v_legacy_row_guard::oid,
             v_raw_guard::oid,
             v_admission_guard::oid,
             v_row_normalizer::oid
           )
           AND procedure.prosecdef
         )
         OR procedure.proconfig IS DISTINCT FROM
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
         OR pg_catalog.encode(
              pg_catalog.sha256(
                pg_catalog.convert_to(
                  pg_catalog.pg_get_functiondef(procedure.oid),
                  'UTF8'
                )
              ),
              'hex'
            ) IS DISTINCT FROM expected.functiondef_sha256
         OR (
           procedure.oid IN (
             v_immutable_guard::oid,
             v_source_guard::oid,
             v_trader_guard::oid,
             v_publication_guard::oid,
             v_legacy_publication_guard::oid,
             v_legacy_row_guard::oid,
             v_raw_guard::oid,
             v_admission_guard::oid,
             v_row_normalizer::oid
           )
           AND procedure.provolatile IS DISTINCT FROM 'v'
         )
         OR (
           procedure.oid IN (
             v_capabilities::oid,
             v_reader::oid,
             v_legacy_reader::oid
           )
           AND procedure.provolatile IS DISTINCT FROM 's'
         )
    ) THEN
      RAISE EXCEPTION 'copier snapshot source authority replay function definition drifted';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner)
        )
      ) AS privilege
      WHERE procedure.oid IN (
        v_immutable_guard::oid,
        v_source_guard::oid,
        v_trader_guard::oid,
        v_publication_guard::oid,
        v_legacy_publication_guard::oid,
        v_legacy_row_guard::oid,
        v_raw_guard::oid,
        v_admission_guard::oid,
        v_row_normalizer::oid,
        v_legacy_reader::oid
      )
        AND NOT (
          privilege.privilege_type = 'EXECUTE'
          AND privilege.grantee = procedure.proowner
          AND privilege.grantor = procedure.proowner
          AND NOT privilege.is_grantable
        )
    ) OR EXISTS (
      SELECT 1
      FROM (
        VALUES
          (v_immutable_guard::oid, 1::bigint),
          (v_source_guard::oid, 1::bigint),
          (v_trader_guard::oid, 1::bigint),
          (v_publication_guard::oid, 1::bigint),
          (v_legacy_publication_guard::oid, 1::bigint),
          (v_legacy_row_guard::oid, 1::bigint),
          (v_raw_guard::oid, 1::bigint),
          (v_admission_guard::oid, 1::bigint),
          (v_row_normalizer::oid, 1::bigint),
          (v_legacy_reader::oid, 1::bigint)
      ) AS expected(function_oid, privilege_count)
      CROSS JOIN LATERAL (
        SELECT pg_catalog.count(*) AS privilege_count
        FROM pg_catalog.pg_proc AS procedure
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            procedure.proacl,
            pg_catalog.acldefault('f', procedure.proowner)
          )
        ) AS privilege
        WHERE procedure.oid = expected.function_oid
          AND privilege.privilege_type = 'EXECUTE'
      ) AS actual
      WHERE actual.privilege_count IS DISTINCT FROM
          expected.privilege_count
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner)
        )
      ) AS privilege
      WHERE procedure.oid IN (v_capabilities::oid, v_reader::oid)
        AND NOT (
          privilege.privilege_type = 'EXECUTE'
          AND privilege.grantor = 'postgres'::pg_catalog.regrole::oid
          AND (
            (
              privilege.grantee = 'postgres'::pg_catalog.regrole::oid
              AND NOT privilege.is_grantable
            ) OR (
              privilege.grantee IN (
                'anon'::pg_catalog.regrole::oid,
                'authenticated'::pg_catalog.regrole::oid,
                'service_role'::pg_catalog.regrole::oid
              )
              AND NOT privilege.is_grantable
            )
          )
        )
    ) OR EXISTS (
      SELECT 1
      FROM (
        VALUES (v_capabilities::oid), (v_reader::oid)
      ) AS expected(function_oid)
      CROSS JOIN LATERAL (
        SELECT pg_catalog.count(*) AS privilege_count
        FROM pg_catalog.pg_proc AS procedure
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            procedure.proacl,
            pg_catalog.acldefault('f', procedure.proowner)
          )
        ) AS privilege
        WHERE procedure.oid = expected.function_oid
          AND privilege.privilege_type = 'EXECUTE'
      ) AS actual
      WHERE actual.privilege_count IS DISTINCT FROM 4
    ) THEN
      RAISE EXCEPTION 'copier snapshot source authority replay function ACL drifted';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM (
        VALUES ('anon'), ('authenticated'), ('service_role')
      ) AS api_role(role_name)
      CROSS JOIN (
        VALUES (v_capabilities), (v_reader)
      ) AS public_function(function_oid)
      WHERE NOT pg_catalog.has_function_privilege(
        api_role.role_name,
        public_function.function_oid,
        'EXECUTE'
      )
    ) THEN
      RAISE EXCEPTION 'copier snapshot source authority replay function ACL drifted';
    END IF;
  END IF;

  IF v_registry IS NOT NULL AND (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    JOIN (
      VALUES
        (
          v_registry,
          'copier_snapshot_source_authority_reject_mutation',
          v_immutable_guard::oid,
          'CREATE TRIGGER copier_snapshot_source_authority_reject_mutation BEFORE INSERT OR DELETE OR UPDATE ON arena.copier_snapshot_source_authorities FOR EACH ROW EXECUTE FUNCTION arena.reject_copier_snapshot_source_authority_mutation()'
        ),
        (
          v_registry,
          'copier_snapshot_source_authority_reject_truncate',
          v_immutable_guard::oid,
          'CREATE TRIGGER copier_snapshot_source_authority_reject_truncate BEFORE TRUNCATE ON arena.copier_snapshot_source_authorities FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_copier_snapshot_source_authority_mutation()'
        ),
        (
          'arena.sources'::pg_catalog.regclass,
          'copier_snapshot_source_configuration_authority',
          v_source_guard::oid,
          'CREATE TRIGGER copier_snapshot_source_configuration_authority BEFORE INSERT OR DELETE OR UPDATE ON arena.sources FOR EACH ROW EXECUTE FUNCTION arena.enforce_copier_snapshot_source_configuration()'
        ),
        (
          'arena.traders'::pg_catalog.regclass,
          'copier_snapshot_trader_identity_authority',
          v_trader_guard::oid,
          'CREATE TRIGGER copier_snapshot_trader_identity_authority BEFORE INSERT OR DELETE OR UPDATE ON arena.traders FOR EACH ROW EXECUTE FUNCTION arena.enforce_copier_snapshot_trader_identity()'
        ),
        (
          'arena.copier_snapshot_publications'::pg_catalog.regclass,
          'copier_snapshot_publication_00_source_authority',
          v_publication_guard::oid,
          'CREATE TRIGGER copier_snapshot_publication_00_source_authority BEFORE INSERT OR UPDATE ON arena.copier_snapshot_publications FOR EACH ROW EXECUTE FUNCTION arena.enforce_copier_snapshot_publication_source_authority()'
        )
    ) AS expected(relation_oid, trigger_name, function_oid, definition)
      ON expected.relation_oid = trigger_row.tgrelid
     AND expected.trigger_name = trigger_row.tgname
    WHERE NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'A'
      AND trigger_row.tgfoid = expected.function_oid
      AND pg_catalog.pg_get_triggerdef(
        trigger_row.oid,
        true
      ) = expected.definition
  ) <> 5 THEN
    RAISE EXCEPTION 'copier snapshot source authority replay triggers drifted';
  END IF;

  IF v_registry IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_capabilities
      AND pg_catalog.strpos(
        procedure.prosrc,
        'arena.copier_snapshot_source_authorities'
      ) > 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        '''copierDepth'', source_row.copier_table_depth'
      ) > 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        '''copiers'', EXISTS'
      ) > 0
  ) THEN
    RAISE EXCEPTION 'copier source capability authority replay drifted';
  END IF;

  IF v_registry IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_reader
      AND pg_catalog.strpos(
        procedure.prosrc,
        'arena.copier-snapshot-receipt-reader@4'
      ) > 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        'arena.copier_snapshot_source_authorities'
      ) > 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        'copier_snapshot_legacy_fallback_enabled'
      ) = 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        'arena.copier-snapshot-publication@1'
      ) = 0
  ) THEN
    RAISE EXCEPTION 'copier aggregate source authority replay drifted';
  END IF;
END
$foundation_preflight$;

-- Drain source configuration changes and every publication path. A writer
-- that was already in flight completes before the locked receipt audit.
LOCK TABLE ONLY arena.exchanges IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.sources IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.traders IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.raw_objects IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ONLY arena.copier_snapshot_publications IN ACCESS EXCLUSIVE MODE;
LOCK TABLE ONLY arena.copier_snapshot_rows IN ACCESS EXCLUSIVE MODE;

DO $lock_existing_registry$
BEGIN
  IF pg_catalog.to_regclass(
       'arena.copier_snapshot_source_authorities'
     ) IS NOT NULL THEN
    LOCK TABLE ONLY arena.copier_snapshot_source_authorities
      IN ACCESS EXCLUSIVE MODE;
  END IF;
END
$lock_existing_registry$;

CREATE TEMPORARY TABLE copier_snapshot_expected_authorities (
  source_slug text PRIMARY KEY,
  exchange_slug text NOT NULL,
  adapter_slug text NOT NULL,
  product_type text NOT NULL,
  trader_kind_scope text NOT NULL,
  currency text NOT NULL,
  pre_depth text NOT NULL,
  target_depth text NOT NULL,
  publication_eligible boolean NOT NULL,
  terminal_verifier_contract text
) ON COMMIT DROP;

INSERT INTO copier_snapshot_expected_authorities (
  source_slug,
  exchange_slug,
  adapter_slug,
  product_type,
  trader_kind_scope,
  currency,
  pre_depth,
  target_depth,
  publication_eligible,
  terminal_verifier_contract
) VALUES
  (
    'binance_futures', 'binance', 'binance', 'futures', 'human', 'USDT',
    'full', 'full', true,
    'arena.ingest.history-terminal-verifier.binance.copiers@2'
  ),
  (
    'binance_spot', 'binance', 'binance', 'spot', 'human', 'USDT',
    'full', 'full', true,
    'arena.ingest.history-terminal-verifier.binance.copiers@2'
  ),
  (
    'bitget_bots_futures', 'bitget', 'bitget_bots', 'futures', 'bot', 'USDT',
    'top10', 'top10', true,
    'arena.ingest.history-terminal-verifier.bitget_bots.copiers@2'
  ),
  (
    'bitget_bots_spot', 'bitget', 'bitget_bots', 'spot', 'bot', 'USDT',
    'top10', 'top10', true,
    'arena.ingest.history-terminal-verifier.bitget_bots.copiers@2'
  ),
  (
    'bitunix_futures', 'bitunix', 'bitunix', 'futures', 'human', 'USDT',
    'full', 'full', true,
    'arena.ingest.history-terminal-verifier.bitunix.copiers@3'
  ),
  (
    'btcc_futures', 'btcc', 'btcc', 'futures', 'human', 'USDT',
    'full', 'full', true,
    'arena.ingest.history-terminal-verifier.btcc.copiers@2'
  ),
  (
    'coinex_futures', 'coinex', 'coinex', 'futures', 'human', 'USDT',
    'full', 'full', true,
    'arena.ingest.history-terminal-verifier.coinex.copiers@2'
  ),
  (
    'gate_futures', 'gate', 'gate', 'futures', 'human', 'USDT',
    'full', 'full', true,
    'arena.ingest.history-terminal-verifier.gate.copiers@2'
  ),
  (
    'kucoin_futures', 'kucoin', 'kucoin', 'futures', 'mixed', 'USDT',
    'full', 'full', true,
    'arena.ingest.history-terminal-verifier.kucoin.copiers@2'
  ),
  (
    'mexc_futures', 'mexc', 'mexc', 'futures', 'mixed', 'USDT',
    'full', 'full', true,
    'arena.ingest.history-terminal-verifier.mexc.copiers@2'
  ),
  (
    'okx_futures', 'okx', 'okx', 'futures', 'human', 'USDT',
    'top10', 'top10', true,
    'arena.ingest.history-terminal-verifier.okx.copiers@2'
  ),
  (
    'toobit_futures', 'toobit', 'toobit', 'futures', 'human', 'USDT',
    'full', 'full', true,
    'arena.ingest.history-terminal-verifier.toobit.copiers@2'
  ),
  (
    'xt_futures', 'xt', 'xt', 'futures', 'human', 'USDT',
    'full', 'full', true,
    'arena.ingest.history-terminal-verifier.xt.copiers@2'
  ),
  -- LBank is retained as a non-publication preview claim. Its official
  -- followers surface is capped and cannot prove an exhaustive full snapshot.
  (
    'lbank_futures', 'lbank', 'lbank', 'futures', 'human', 'USDT',
    'top3_preview', 'top3_preview', false, NULL
  ),
  -- These legacy full claims have no verifier that proves their configured
  -- depth. They are corrected before the immutable source guard is installed.
  (
    'bitget_futures', 'bitget', 'bitget', 'futures', 'human', 'USDT',
    'full', 'none', false, NULL
  ),
  (
    'bitget_spot', 'bitget', 'bitget', 'spot', 'human', 'USDT',
    'full', 'none', false, NULL
  ),
  (
    'bitget_cfd', 'bitget', 'bitget', 'cfd', 'human', 'USDT',
    'full', 'none', false, NULL
  ),
  (
    'xt_spot', 'xt', 'xt', 'spot', 'human', 'USDT',
    'full', 'none', false, NULL
  );

DO $locked_contract_preflight$
DECLARE
  v_registry regclass := pg_catalog.to_regclass(
    'arena.copier_snapshot_source_authorities'
  );
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.sources'::pg_catalog.regclass::oid),
        ('arena.exchanges'::pg_catalog.regclass::oid),
        ('arena.traders'::pg_catalog.regclass::oid),
        ('arena.raw_objects'::pg_catalog.regclass::oid),
        ('arena.copier_snapshot_publications'::pg_catalog.regclass::oid),
        ('arena.copier_snapshot_rows'::pg_catalog.regclass::oid),
        (v_registry::oid)
    ) AS expected(relation_oid)
    LEFT JOIN pg_catalog.pg_class AS relation
      ON relation.oid = expected.relation_oid
    WHERE expected.relation_oid IS NOT NULL
      AND (
        relation.oid IS NULL
        OR relation.relkind IS DISTINCT FROM 'r'
        OR relation.relpersistence IS DISTINCT FROM 'p'
        OR relation.relowner IS DISTINCT FROM
            'postgres'::pg_catalog.regrole
        OR relation.relispartition
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.pg_inherits AS inheritance
          WHERE inheritance.inhrelid = expected.relation_oid
             OR inheritance.inhparent = expected.relation_oid
        )
      )
  ) THEN
    RAISE EXCEPTION 'locked copier authority relation inheritance or durability drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM ONLY arena.sources AS source_row
    JOIN copier_snapshot_expected_authorities AS expected
      ON expected.source_slug = source_row.slug
  ) <> (
    SELECT pg_catalog.count(*)
    FROM copier_snapshot_expected_authorities
  ) THEN
    RAISE EXCEPTION 'copier source authority requires exactly one canonical source per reviewed slug';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM copier_snapshot_expected_authorities AS expected
    LEFT JOIN ONLY arena.sources AS source_row
      ON source_row.slug = expected.source_slug
    LEFT JOIN ONLY arena.exchanges AS exchange_row
      ON exchange_row.id = source_row.exchange_id
    WHERE source_row.slug IS NULL
       OR exchange_row.slug IS DISTINCT FROM expected.exchange_slug
       OR source_row.adapter_slug IS DISTINCT FROM expected.adapter_slug
       OR source_row.product_type IS DISTINCT FROM expected.product_type
       OR source_row.trader_kind_scope IS DISTINCT FROM
          expected.trader_kind_scope
       OR source_row.currency IS DISTINCT FROM expected.currency
       OR (
         v_registry IS NULL
         AND source_row.copier_table_depth IS DISTINCT FROM expected.pre_depth
         AND source_row.copier_table_depth IS DISTINCT FROM
            expected.target_depth
       )
       OR (
         v_registry IS NOT NULL
         AND source_row.copier_table_depth IS DISTINCT FROM
            expected.target_depth
       )
  ) THEN
    RAISE EXCEPTION 'copier source identity, currency, or depth contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ONLY arena.sources AS source_row
    LEFT JOIN copier_snapshot_expected_authorities AS expected
      ON expected.source_slug = source_row.slug
    WHERE source_row.copier_table_depth IS DISTINCT FROM 'none'
      AND expected.source_slug IS NULL
  ) THEN
    RAISE EXCEPTION 'an unreviewed source still claims a public copier depth';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM copier_snapshot_expected_authorities AS expected
    JOIN ONLY arena.sources AS source_row
      ON source_row.slug = expected.source_slug
    JOIN ONLY arena.traders AS trader_row
      ON trader_row.source_id = source_row.id
    WHERE expected.target_depth IS DISTINCT FROM 'none'
      AND (
        trader_row.exchange_trader_id IS DISTINCT FROM
          pg_catalog.btrim(trader_row.exchange_trader_id)
        OR trader_row.exchange_trader_id = ''
      )
  ) THEN
    RAISE EXCEPTION 'reviewed copier trader external identity is not canonical';
  END IF;

  -- 0543 accepted any syntactically valid verifier. Before installing the
  -- exact registry, fail closed on every historical receipt that is not an
  -- eligible V2 tuple. No receipt is deleted or rewritten here.
  IF EXISTS (
    SELECT 1
    FROM ONLY arena.copier_snapshot_publications AS publication
    JOIN ONLY arena.sources AS source_row
      ON source_row.id = publication.source_id
    JOIN ONLY arena.exchanges AS exchange_row
      ON exchange_row.id = source_row.exchange_id
    LEFT JOIN copier_snapshot_expected_authorities AS expected
      ON expected.source_slug = source_row.slug
     AND expected.publication_eligible
    WHERE expected.source_slug IS NULL
       OR exchange_row.slug IS DISTINCT FROM expected.exchange_slug
       OR source_row.adapter_slug IS DISTINCT FROM expected.adapter_slug
       OR source_row.product_type IS DISTINCT FROM expected.product_type
       OR source_row.trader_kind_scope IS DISTINCT FROM
          expected.trader_kind_scope
       OR source_row.currency IS DISTINCT FROM expected.currency
       OR source_row.copier_table_depth IS DISTINCT FROM expected.target_depth
       OR publication.source_depth IS DISTINCT FROM expected.target_depth
       OR publication.currency IS DISTINCT FROM expected.currency
       OR publication.terminal_verifier_contract IS DISTINCT FROM
          expected.terminal_verifier_contract
       OR publication.evidence_contract IS DISTINCT FROM
          'arena.copier-snapshot-publication@2'
       OR publication.publisher_contract IS DISTINCT FROM
          'arena.ingest.copier-snapshot-publisher@2'
       OR NOT EXISTS (
         SELECT 1
         FROM ONLY arena.traders AS trader_row
         WHERE trader_row.id = publication.trader_id
           AND trader_row.source_id = publication.source_id
       )
  ) THEN
    RAISE EXCEPTION 'existing copier snapshot receipt is outside the reviewed source authority';
  END IF;

  IF v_registry IS NOT NULL THEN
    IF (
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'sourceSlug', authority.source_slug,
          'exchangeId', authority.exchange_id,
          'adapterSlug', authority.adapter_slug,
          'productType', authority.product_type,
          'traderKindScope', authority.trader_kind_scope,
          'currency', authority.currency,
          'depth', authority.copier_table_depth,
          'publicationEligible', authority.publication_eligible,
          'verifierContract', authority.terminal_verifier_contract,
          'authorityContract', authority.authority_contract,
          'contractVersion', authority.contract_version
        ) ORDER BY authority.source_slug
      )
      FROM ONLY arena.copier_snapshot_source_authorities AS authority
    ) IS DISTINCT FROM (
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'sourceSlug', expected.source_slug,
          'exchangeId', source_row.exchange_id,
          'adapterSlug', expected.adapter_slug,
          'productType', expected.product_type,
          'traderKindScope', expected.trader_kind_scope,
          'currency', expected.currency,
          'depth', expected.target_depth,
          'publicationEligible', expected.publication_eligible,
          'verifierContract', expected.terminal_verifier_contract,
          'authorityContract',
            'arena.copier-snapshot-source-authority@1',
          'contractVersion', 1
        ) ORDER BY expected.source_slug
      )
      FROM copier_snapshot_expected_authorities AS expected
      JOIN ONLY arena.sources AS source_row
        ON source_row.slug = expected.source_slug
      WHERE expected.target_depth IS DISTINCT FROM 'none'
    ) THEN
      RAISE EXCEPTION 'copier snapshot source authority registry replay rows drifted';
    END IF;
  END IF;
END
$locked_contract_preflight$;

UPDATE ONLY arena.sources AS source_row
SET copier_table_depth = expected.target_depth
FROM copier_snapshot_expected_authorities AS expected
WHERE source_row.slug = expected.source_slug
  AND expected.target_depth = 'none'
  AND source_row.copier_table_depth IS DISTINCT FROM expected.target_depth;

CREATE TABLE IF NOT EXISTS arena.copier_snapshot_source_authorities (
  source_id smallint PRIMARY KEY
    REFERENCES arena.sources(id) ON DELETE RESTRICT,
  source_slug text NOT NULL UNIQUE,
  exchange_id smallint NOT NULL
    REFERENCES arena.exchanges(id) ON DELETE RESTRICT,
  adapter_slug text NOT NULL,
  product_type text NOT NULL,
  trader_kind_scope text NOT NULL,
  currency text NOT NULL,
  copier_table_depth text NOT NULL CHECK (
    copier_table_depth IN ('full', 'top10', 'top3_preview')
  ),
  publication_eligible boolean NOT NULL,
  terminal_verifier_contract text,
  authority_contract text NOT NULL CHECK (
    authority_contract = 'arena.copier-snapshot-source-authority@1'
  ),
  contract_version smallint NOT NULL CHECK (contract_version = 1),
  CONSTRAINT copier_snapshot_source_authority_publication_shape CHECK (
    (
      (
        publication_eligible IS NOT DISTINCT FROM true
        AND copier_table_depth IN ('full', 'top10')
        AND terminal_verifier_contract IS NOT NULL
        AND (
          terminal_verifier_contract ~
            '^arena\.ingest\.history-terminal-verifier\.[a-z0-9_]+(?:\.[a-z0-9_]+)*\.copiers@[1-9][0-9]*$'
        ) IS TRUE
      ) OR (
        publication_eligible IS NOT DISTINCT FROM false
        AND source_slug IS NOT DISTINCT FROM 'lbank_futures'
        AND adapter_slug IS NOT DISTINCT FROM 'lbank'
        AND product_type IS NOT DISTINCT FROM 'futures'
        AND trader_kind_scope IS NOT DISTINCT FROM 'human'
        AND currency IS NOT DISTINCT FROM 'USDT'
        AND copier_table_depth IS NOT DISTINCT FROM 'top3_preview'
        AND terminal_verifier_contract IS NULL
      )
    ) IS TRUE
  )
);

INSERT INTO arena.copier_snapshot_source_authorities (
  source_id,
  source_slug,
  exchange_id,
  adapter_slug,
  product_type,
  trader_kind_scope,
  currency,
  copier_table_depth,
  publication_eligible,
  terminal_verifier_contract,
  authority_contract,
  contract_version
)
SELECT
  source_row.id,
  expected.source_slug,
  source_row.exchange_id,
  expected.adapter_slug,
  expected.product_type,
  expected.trader_kind_scope,
  expected.currency,
  expected.target_depth,
  expected.publication_eligible,
  expected.terminal_verifier_contract,
  'arena.copier-snapshot-source-authority@1',
  1
FROM copier_snapshot_expected_authorities AS expected
JOIN ONLY arena.sources AS source_row
  ON source_row.slug = expected.source_slug
WHERE expected.target_depth IS DISTINCT FROM 'none'
  AND NOT EXISTS (
    SELECT 1
    FROM ONLY arena.copier_snapshot_source_authorities
  );

CREATE OR REPLACE FUNCTION
  arena.reject_copier_snapshot_source_authority_mutation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'copier snapshot source authority registry is immutable'
    USING ERRCODE = '55000';
END
$function$;

CREATE OR REPLACE FUNCTION
  arena.enforce_copier_snapshot_source_configuration()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1
      FROM ONLY arena.copier_snapshot_source_authorities AS authority
      WHERE authority.source_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'registered copier source identity is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND EXISTS (
       SELECT 1
       FROM ONLY arena.copier_snapshot_source_authorities AS authority
       WHERE authority.source_id = OLD.id
     )
     AND (
       NEW.id IS DISTINCT FROM OLD.id
       OR NEW.slug IS DISTINCT FROM OLD.slug
       OR NEW.exchange_id IS DISTINCT FROM OLD.exchange_id
       OR NEW.adapter_slug IS DISTINCT FROM OLD.adapter_slug
       OR NEW.product_type IS DISTINCT FROM OLD.product_type
       OR NEW.trader_kind_scope IS DISTINCT FROM OLD.trader_kind_scope
       OR NEW.currency IS DISTINCT FROM OLD.currency
     ) THEN
    RAISE EXCEPTION 'registered copier source identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.copier_table_depth IS NOT DISTINCT FROM 'none' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM ONLY arena.copier_snapshot_source_authorities AS authority
    WHERE authority.source_id = NEW.id
      AND authority.source_slug IS NOT DISTINCT FROM NEW.slug
      AND authority.exchange_id IS NOT DISTINCT FROM NEW.exchange_id
      AND authority.adapter_slug IS NOT DISTINCT FROM NEW.adapter_slug
      AND authority.product_type IS NOT DISTINCT FROM NEW.product_type
      AND authority.trader_kind_scope IS NOT DISTINCT FROM
          NEW.trader_kind_scope
      AND authority.currency IS NOT DISTINCT FROM NEW.currency
      AND authority.copier_table_depth IS NOT DISTINCT FROM
          NEW.copier_table_depth
      AND authority.authority_contract =
          'arena.copier-snapshot-source-authority@1'
      AND authority.contract_version = 1
  ) THEN
    RAISE EXCEPTION 'source has no exact copier snapshot source authority'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION
  arena.enforce_copier_snapshot_trader_identity()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1
      FROM ONLY arena.copier_snapshot_source_authorities AS authority
      WHERE authority.source_id = NEW.source_id
    ) AND (
      NEW.exchange_trader_id IS DISTINCT FROM
        pg_catalog.btrim(NEW.exchange_trader_id)
      OR NEW.exchange_trader_id = ''
    ) THEN
      RAISE EXCEPTION 'registered copier trader identity must be canonical'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id
     AND NEW.exchange_trader_id IS NOT DISTINCT FROM
         OLD.exchange_trader_id THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ONLY arena.copier_snapshot_source_authorities AS authority
    WHERE authority.source_id = OLD.source_id
       OR (
         TG_OP = 'UPDATE'
         AND authority.source_id = NEW.source_id
       )
  ) THEN
    RAISE EXCEPTION 'registered copier trader identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION
  arena.enforce_copier_snapshot_publication_source_authority()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  -- Preserve the 053000 RAW-GC tombstone contract. The existing immutable
  -- publication trigger runs after this alphabetically early guard and
  -- independently proves that this is the sole nested FK change.
  IF TG_OP = 'UPDATE'
     AND pg_catalog.pg_trigger_depth() > 1
     AND OLD.live_raw_object_id IS NOT NULL
     AND NEW.live_raw_object_id IS NULL
     AND (pg_catalog.to_jsonb(NEW) - 'live_raw_object_id') =
         (pg_catalog.to_jsonb(OLD) - 'live_raw_object_id') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'copier snapshot publication receipts are immutable under source authority'
      USING ERRCODE = '55000';
  END IF;

  IF pg_catalog.current_setting('session_replication_role') IS DISTINCT FROM
       'origin' THEN
    RAISE EXCEPTION 'copier snapshot publication INSERT is forbidden outside origin replication mode'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.evidence_contract IS DISTINCT FROM
       'arena.copier-snapshot-publication@2'
     OR NEW.publisher_contract IS DISTINCT FROM
       'arena.ingest.copier-snapshot-publisher@2' THEN
    RAISE EXCEPTION 'copier snapshot publication has no exact active-serving source authority'
      USING ERRCODE = '55000';
  END IF;

  -- Lock the mutable source lifecycle row in the same ALWAYS trigger that
  -- validates it. A concurrent demotion and receipt INSERT serialize rather
  -- than producing a time-of-check/time-of-use publication.
  PERFORM 1
  FROM ONLY arena.copier_snapshot_source_authorities AS authority
  JOIN ONLY arena.sources AS source_row
    ON source_row.id = authority.source_id
   AND source_row.slug = authority.source_slug
   AND source_row.exchange_id = authority.exchange_id
   AND source_row.adapter_slug = authority.adapter_slug
   AND source_row.product_type = authority.product_type
   AND source_row.trader_kind_scope = authority.trader_kind_scope
   AND source_row.currency = authority.currency
   AND source_row.copier_table_depth = authority.copier_table_depth
  JOIN ONLY arena.traders AS trader_row
    ON trader_row.id = NEW.trader_id
   AND trader_row.source_id = NEW.source_id
  WHERE authority.source_id = NEW.source_id
    AND authority.publication_eligible
    AND authority.authority_contract =
        'arena.copier-snapshot-source-authority@1'
    AND authority.contract_version = 1
    AND source_row.status = 'active'
    AND source_row.serving_mode = 'serving'
    AND trader_row.meta->>'claimed' IS DISTINCT FROM 'true'
    AND NEW.source_depth IS NOT DISTINCT FROM
        authority.copier_table_depth
    AND NEW.currency IS NOT DISTINCT FROM authority.currency
    AND NEW.terminal_verifier_contract IS NOT DISTINCT FROM
        authority.terminal_verifier_contract
  FOR SHARE OF source_row, trader_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'copier snapshot publication has no exact active-serving source authority'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.live_raw_object_id IS NULL THEN
    RAISE EXCEPTION 'copier snapshot publication requires live exact RAW evidence at INSERT'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1
  FROM ONLY arena.raw_objects AS raw_object
  WHERE raw_object.id = NEW.live_raw_object_id
    AND NOT raw_object.quarantined
    AND raw_object.source_id = NEW.source_id
    AND raw_object.trader_id = NEW.trader_id
    AND raw_object.job_type = CASE NEW.lane
      WHEN 'tier_b' THEN 'history:copiers'
      WHEN 'tier_c' THEN 'tier_c'
    END
    AND raw_object.timeframe IS NULL
    AND raw_object.source_run_id = NEW.source_run_id
    AND raw_object.content_hash = NEW.raw_content_hash
    AND raw_object.trust_artifact_role =
        NEW.raw_trust_artifact_role_at_publication
    AND raw_object.storage_path = NEW.raw_storage_path
    AND raw_object.fetched_at = NEW.raw_fetched_at
    AND raw_object.meta->>'source_run_id' = NEW.source_run_id
    AND raw_object.meta->>'publication_lane' = NEW.lane
    AND raw_object.meta->>'acquisition_source_run_id' =
        NEW.acquisition_source_run_id
    AND raw_object.meta->>'data_contract' = NEW.data_contract
    AND raw_object.meta->>'publication_evidence_contract' =
        NEW.raw_evidence_contract_at_publication
  FOR SHARE OF raw_object;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'copier snapshot publication requires live exact RAW evidence at INSERT'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$function$;

-- Harden the retained 053000 RAW guard for replica mode and inheritance. It
-- remains SECURITY INVOKER but its ALWAYS trigger protects immutable evidence
-- even when PostgreSQL's ordinary FK and ORIGIN triggers are disabled.
CREATE OR REPLACE FUNCTION arena.protect_copier_snapshot_raw_object()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM ONLY arena.copier_snapshot_publications AS publication
    WHERE publication.live_raw_object_id = OLD.id
  ) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('session_replication_role') IS DISTINCT FROM
         'origin'
       OR OLD.quarantined THEN
      RAISE EXCEPTION 'quarantined copier snapshot RAW evidence cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.job_type IS DISTINCT FROM OLD.job_type
     OR NEW.trader_id IS DISTINCT FROM OLD.trader_id
     OR NEW.timeframe IS DISTINCT FROM OLD.timeframe
     OR NEW.fetched_at IS DISTINCT FROM OLD.fetched_at
     OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
     OR NEW.bytes IS DISTINCT FROM OLD.bytes
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.meta IS DISTINCT FROM OLD.meta
     OR NEW.source_run_id IS DISTINCT FROM OLD.source_run_id
     OR NEW.trust_artifact_role IS DISTINCT FROM OLD.trust_artifact_role
     OR (
       NEW.quarantined IS DISTINCT FROM OLD.quarantined
       AND NOT (NOT OLD.quarantined AND NEW.quarantined)
     ) THEN
    RAISE EXCEPTION 'copier snapshot RAW evidence % cannot be mutated', OLD.id
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$function$;

-- The row normalizer remains the only BEFORE INSERT transformer, but replica
-- mode may not synthesize receipt rows while FK/admission triggers are off.
CREATE OR REPLACE FUNCTION
  arena.normalize_copier_snapshot_row_source_event_v1()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF pg_catalog.current_setting('session_replication_role') IS DISTINCT FROM
       'origin' THEN
    RAISE EXCEPTION 'copier snapshot row INSERT is forbidden outside origin replication mode'
      USING ERRCODE = '55000';
  END IF;
  NEW.source_event_at := NULL;
  RETURN NEW;
END
$function$;

ALTER TABLE arena.copier_snapshot_source_authorities OWNER TO postgres;
ALTER TABLE arena.copier_snapshot_source_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.copier_snapshot_source_authorities FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE arena.copier_snapshot_source_authorities
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE arena.copier_snapshot_publications
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE arena.mv_source_capabilities
  FROM PUBLIC, anon, authenticated, service_role;

-- Table-level REVOKE does not erase an older per-column grant. Clear every
-- explicit column ACL, including redundant owner entries, so service roles
-- with BYPASSRLS cannot read either private receipts or the stale MV directly.
DO $revoke_projection_column_acl$
DECLARE
  v_relation regclass;
  v_column name;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'arena.copier_snapshot_publications'::pg_catalog.regclass,
    'arena.mv_source_capabilities'::pg_catalog.regclass
  ] LOOP
    FOR v_column IN
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES (%I) ON TABLE %s FROM PUBLIC, anon, authenticated, service_role, postgres',
        v_column,
        v_relation
      );
    END LOOP;
  END LOOP;
END
$revoke_projection_column_acl$;

ALTER FUNCTION arena.reject_copier_snapshot_source_authority_mutation()
  OWNER TO postgres;
ALTER FUNCTION arena.enforce_copier_snapshot_source_configuration()
  OWNER TO postgres;
ALTER FUNCTION arena.enforce_copier_snapshot_trader_identity()
  OWNER TO postgres;
ALTER FUNCTION
  arena.enforce_copier_snapshot_publication_source_authority()
  OWNER TO postgres;
ALTER FUNCTION arena.protect_copier_snapshot_raw_object()
  OWNER TO postgres;
ALTER FUNCTION arena.normalize_copier_snapshot_row_source_event_v1()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION
  arena.reject_copier_snapshot_source_authority_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  arena.enforce_copier_snapshot_source_configuration()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.enforce_copier_snapshot_trader_identity()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  arena.enforce_copier_snapshot_publication_source_authority()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.protect_copier_snapshot_raw_object()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  arena.normalize_copier_snapshot_row_source_event_v1()
  FROM PUBLIC, anon, authenticated, service_role;

DO $install_policy$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid =
        'arena.copier_snapshot_source_authorities'::pg_catalog.regclass
      AND policy.polname = 'owner_copier_snapshot_source_authority_read'
  ) THEN
    CREATE POLICY owner_copier_snapshot_source_authority_read
      ON arena.copier_snapshot_source_authorities
      FOR SELECT TO postgres USING (true);
  END IF;
END
$install_policy$;

DO $install_triggers$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid =
        'arena.copier_snapshot_source_authorities'::pg_catalog.regclass
      AND tgname = 'copier_snapshot_source_authority_reject_mutation'
  ) THEN
    CREATE TRIGGER copier_snapshot_source_authority_reject_mutation
    BEFORE INSERT OR UPDATE OR DELETE
    ON arena.copier_snapshot_source_authorities
    FOR EACH ROW EXECUTE FUNCTION
      arena.reject_copier_snapshot_source_authority_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid =
        'arena.copier_snapshot_source_authorities'::pg_catalog.regclass
      AND tgname = 'copier_snapshot_source_authority_reject_truncate'
  ) THEN
    CREATE TRIGGER copier_snapshot_source_authority_reject_truncate
    BEFORE TRUNCATE ON arena.copier_snapshot_source_authorities
    FOR EACH STATEMENT EXECUTE FUNCTION
      arena.reject_copier_snapshot_source_authority_mutation();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'arena.sources'::pg_catalog.regclass
      AND tgname = 'copier_snapshot_source_configuration_authority'
  ) THEN
    CREATE TRIGGER copier_snapshot_source_configuration_authority
    BEFORE INSERT OR UPDATE OR DELETE ON arena.sources
    FOR EACH ROW EXECUTE FUNCTION
      arena.enforce_copier_snapshot_source_configuration();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'arena.traders'::pg_catalog.regclass
      AND tgname = 'copier_snapshot_trader_identity_authority'
  ) THEN
    CREATE TRIGGER copier_snapshot_trader_identity_authority
    BEFORE INSERT OR UPDATE OR DELETE ON arena.traders
    FOR EACH ROW EXECUTE FUNCTION
      arena.enforce_copier_snapshot_trader_identity();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid =
        'arena.copier_snapshot_publications'::pg_catalog.regclass
      AND tgname = 'copier_snapshot_publication_00_source_authority'
  ) THEN
    CREATE TRIGGER copier_snapshot_publication_00_source_authority
    BEFORE INSERT OR UPDATE ON arena.copier_snapshot_publications
    FOR EACH ROW EXECUTE FUNCTION
      arena.enforce_copier_snapshot_publication_source_authority();
  END IF;
END
$install_triggers$;

ALTER TABLE ONLY arena.copier_snapshot_source_authorities
  ENABLE ALWAYS TRIGGER copier_snapshot_source_authority_reject_mutation;
ALTER TABLE ONLY arena.copier_snapshot_source_authorities
  ENABLE ALWAYS TRIGGER copier_snapshot_source_authority_reject_truncate;
ALTER TABLE ONLY arena.sources
  ENABLE ALWAYS TRIGGER copier_snapshot_source_configuration_authority;
ALTER TABLE ONLY arena.traders
  ENABLE ALWAYS TRIGGER copier_snapshot_trader_identity_authority;
ALTER TABLE ONLY arena.copier_snapshot_publications
  ENABLE ALWAYS TRIGGER copier_snapshot_publication_00_source_authority;
ALTER TABLE ONLY arena.copier_snapshot_publications
  ENABLE ALWAYS TRIGGER copier_snapshot_publication_reject_update_delete;
ALTER TABLE ONLY arena.copier_snapshot_publications
  ENABLE ALWAYS TRIGGER copier_snapshot_publication_reject_truncate;
ALTER TABLE ONLY arena.copier_snapshot_rows
  ENABLE ALWAYS TRIGGER copier_snapshot_row_reject_update_delete;
ALTER TABLE ONLY arena.copier_snapshot_rows
  ENABLE ALWAYS TRIGGER copier_snapshot_row_reject_truncate;
ALTER TABLE ONLY arena.raw_objects
  ENABLE ALWAYS TRIGGER protect_copier_snapshot_raw_before_write;
ALTER TABLE ONLY arena.copier_snapshot_publications
  ENABLE ALWAYS TRIGGER copier_snapshot_publication_guard_insert_v1;
ALTER TABLE ONLY arena.copier_snapshot_rows
  ENABLE ALWAYS TRIGGER copier_snapshot_row_normalize_source_event_v1;

-- Replace the rolling @3 reader with a V2-only, registry-bound @4 reader.
-- The symbol and browser ACL remain stable, but no V1/legacy fallback or
-- syntactically plausible verifier can cross this forward authority boundary.
CREATE OR REPLACE FUNCTION public.arena_copier_aggregate(
  p_source text,
  p_trader text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  -- arena.copier-snapshot-receipt-reader@4
  WITH resolved AS (
    SELECT
      source_row.id AS source_id,
      trader_row.id AS trader_id,
      authority.copier_table_depth,
      authority.currency,
      authority.terminal_verifier_contract
    FROM ONLY arena.sources AS source_row
    JOIN ONLY arena.copier_snapshot_source_authorities AS authority
      ON authority.source_id = source_row.id
     AND authority.source_slug = source_row.slug
     AND authority.exchange_id = source_row.exchange_id
     AND authority.adapter_slug = source_row.adapter_slug
     AND authority.product_type = source_row.product_type
     AND authority.trader_kind_scope = source_row.trader_kind_scope
     AND authority.currency = source_row.currency
     AND authority.copier_table_depth = source_row.copier_table_depth
     AND authority.publication_eligible
     AND authority.authority_contract =
         'arena.copier-snapshot-source-authority@1'
     AND authority.contract_version = 1
    JOIN ONLY arena.traders AS trader_row
      ON trader_row.source_id = source_row.id
    WHERE source_row.slug = p_source
      AND trader_row.exchange_trader_id = p_trader
      AND source_row.status = 'active'
      AND source_row.serving_mode = 'serving'
  ), latest_receipt_candidate AS (
    SELECT publication.*
    FROM ONLY arena.copier_snapshot_publications AS publication
    CROSS JOIN resolved
    WHERE publication.source_id = resolved.source_id
      AND publication.trader_id = resolved.trader_id
    ORDER BY publication.observed_at DESC, publication.publication_id DESC
    LIMIT 1
  ), latest_receipt AS (
    SELECT publication.*
    FROM latest_receipt_candidate AS publication
    CROSS JOIN resolved
    WHERE publication.evidence_state = 'verified'
      AND publication.scan_terminal_state = 'exhausted'
      AND NOT publication.caller_limited
      AND publication.blocker_reasons = '[]'::pg_catalog.jsonb
      AND publication.terminal_verifier_contract =
          resolved.terminal_verifier_contract
      AND publication.source_depth = resolved.copier_table_depth
      AND publication.currency = resolved.currency
      AND publication.request_sha256 ~ '^[0-9a-f]{64}$'
      AND publication.copier_count IS NOT NULL
      AND publication.copier_count = publication.parsed_row_count
      AND publication.pnl_distribution IS NOT NULL
      AND pg_catalog.jsonb_typeof(publication.pnl_distribution) = 'array'
      AND publication.evidence_contract =
          'arena.copier-snapshot-publication@2'
      AND publication.publisher_contract =
          'arena.ingest.copier-snapshot-publisher@2'
      AND publication.data_contract =
          'arena.ingest.copier-publication-lane-artifact@1'
      AND publication.lane IN ('tier_b', 'tier_c')
      AND publication.acquisition_source_run_id ~ '^[0-9a-f]{64}$'
      AND publication.acquisition_source_run_id <>
          pg_catalog.repeat('0', 64)
      AND publication.acquisition_source_run_id <>
          publication.source_run_id
      AND publication.raw_trust_artifact_role_at_publication =
          'copier_snapshot'
      AND publication.raw_evidence_contract_at_publication =
          'arena.ingest.copier-publication-lane-raw-evidence@1'
      AND (
        publication.live_raw_object_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM ONLY arena.raw_objects AS raw_object
          WHERE raw_object.id = publication.live_raw_object_id
            AND NOT raw_object.quarantined
            AND raw_object.source_id = publication.source_id
            AND raw_object.trader_id = publication.trader_id
            AND raw_object.job_type = CASE publication.lane
              WHEN 'tier_b' THEN 'history:copiers'
              WHEN 'tier_c' THEN 'tier_c'
            END
            AND raw_object.timeframe IS NULL
            AND raw_object.source_run_id = publication.source_run_id
            AND raw_object.content_hash = publication.raw_content_hash
            AND raw_object.trust_artifact_role =
                publication.raw_trust_artifact_role_at_publication
            AND raw_object.storage_path = publication.raw_storage_path
            AND raw_object.fetched_at = publication.raw_fetched_at
            AND raw_object.meta->>'source_run_id' =
                publication.source_run_id
            AND raw_object.meta->>'publication_lane' = publication.lane
            AND raw_object.meta->>'acquisition_source_run_id' =
                publication.acquisition_source_run_id
            AND raw_object.meta->>'data_contract' = publication.data_contract
            AND raw_object.meta->>'publication_evidence_contract' =
                publication.raw_evidence_contract_at_publication
        )
      )
  )
  SELECT pg_catalog.jsonb_build_object(
    'copierCount', receipt.copier_count,
    'copierCountMax', NULL,
    'totalCopierPnl', receipt.total_copier_pnl,
    'currency', receipt.currency,
    'depth', receipt.source_depth,
    'asOf', pg_catalog.to_char(
      receipt.observed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'sourceAsOf', NULL,
    'observedAt', pg_catalog.to_char(
      receipt.observed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'publishedAt', pg_catalog.to_char(
      receipt.published_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'pnlDistribution', receipt.pnl_distribution,
    'receiptBound', true,
    'receiptId', receipt.publication_id,
    'sourceRunId', receipt.source_run_id,
    'receiptReaderContract',
      'arena.copier-snapshot-receipt-reader@4',
    'evidenceState', receipt.evidence_state,
    'scanTerminalState', receipt.scan_terminal_state,
    'blockerReasons', receipt.blocker_reasons
  )
  FROM latest_receipt AS receipt;
$function$;

ALTER FUNCTION public.arena_copier_aggregate(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_copier_aggregate(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_copier_aggregate(text, text)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.arena_copier_aggregate(text, text) IS
  'Registry-bound V2-only copier aggregate reader; exact current source, depth, currency, verifier, terminal, and immutable RAW receipt evidence are required.';

-- Keep the materialized view as the expensive metric/surface cache, but never
-- trust its stale copier depth or its legacy copier_records-derived boolean.
-- A current exact V2 receipt makes the B2C Copiers tab visible immediately;
-- demotion, contract drift, and unregistered previews fail closed immediately.
CREATE OR REPLACE FUNCTION public.arena_source_capabilities()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(
    pg_catalog.jsonb_object_agg(
      source_row.slug,
      CASE
        WHEN pg_catalog.jsonb_typeof(capability.cap) = 'object'
        THEN capability.cap
        ELSE
        pg_catalog.jsonb_build_object(
          'exchangeName', exchange_row.name,
          'currency', source_row.currency,
          'productType', source_row.product_type,
          'isOnchain', source_row.product_type = 'onchain',
          'copierDepth', source_row.copier_table_depth,
          'timeframesNative', source_row.timeframes_native,
          'timeframesDerived', source_row.timeframes_derived,
          'servingMode', source_row.serving_mode,
          'metrics', '[]'::pg_catalog.jsonb,
          'surfaces', pg_catalog.jsonb_build_object(
            'positions', false,
            'position_history', false,
            'orders', false,
            'transfers', false,
            'copiers', false
          )
        )
      END || pg_catalog.jsonb_build_object(
        'servingMode', source_row.serving_mode,
        'copierDepth', source_row.copier_table_depth,
        'copierAuthorityContract',
          'arena.copier-snapshot-source-authority@1',
        'surfaces',
          CASE
            WHEN pg_catalog.jsonb_typeof(capability.cap) = 'object'
             AND pg_catalog.jsonb_typeof(
                   capability.cap->'surfaces'
                 ) = 'object'
            THEN capability.cap->'surfaces'
            ELSE '{}'::pg_catalog.jsonb
          END || pg_catalog.jsonb_build_object(
            'copiers', EXISTS (
              SELECT 1
              FROM ONLY arena.copier_snapshot_source_authorities AS authority
              JOIN ONLY arena.copier_snapshot_publications AS publication
                ON publication.source_id = authority.source_id
              JOIN ONLY arena.traders AS trader_row
                ON trader_row.id = publication.trader_id
               AND trader_row.source_id = publication.source_id
              WHERE authority.source_id = source_row.id
                AND authority.source_slug = source_row.slug
                AND authority.exchange_id = source_row.exchange_id
                AND authority.adapter_slug = source_row.adapter_slug
                AND authority.product_type = source_row.product_type
                AND authority.trader_kind_scope =
                    source_row.trader_kind_scope
                AND authority.currency = source_row.currency
                AND authority.copier_table_depth =
                    source_row.copier_table_depth
                AND authority.publication_eligible
                AND authority.authority_contract =
                    'arena.copier-snapshot-source-authority@1'
                AND authority.contract_version = 1
                AND publication.source_depth =
                    authority.copier_table_depth
                AND publication.currency = authority.currency
                AND publication.terminal_verifier_contract =
                    authority.terminal_verifier_contract
                AND publication.evidence_contract =
                    'arena.copier-snapshot-publication@2'
                AND publication.publisher_contract =
                    'arena.ingest.copier-snapshot-publisher@2'
                AND publication.evidence_state = 'verified'
                AND publication.scan_terminal_state = 'exhausted'
                AND NOT publication.caller_limited
                AND publication.blocker_reasons = '[]'::pg_catalog.jsonb
                AND NOT EXISTS (
                  SELECT 1
                  FROM ONLY arena.copier_snapshot_publications AS newer
                  WHERE newer.source_id = publication.source_id
                    AND newer.trader_id = publication.trader_id
                    AND (
                      newer.observed_at,
                      newer.publication_id
                    ) > (
                      publication.observed_at,
                      publication.publication_id
                    )
                )
                AND publication.request_sha256 ~ '^[0-9a-f]{64}$'
                AND publication.copier_count IS NOT NULL
                AND publication.copier_count =
                    publication.parsed_row_count
                AND publication.pnl_distribution IS NOT NULL
                AND pg_catalog.jsonb_typeof(
                  publication.pnl_distribution
                ) = 'array'
                AND publication.data_contract =
                    'arena.ingest.copier-publication-lane-artifact@1'
                AND publication.lane IN ('tier_b', 'tier_c')
                AND publication.acquisition_source_run_id ~
                    '^[0-9a-f]{64}$'
                AND publication.acquisition_source_run_id <>
                    pg_catalog.repeat('0', 64)
                AND publication.acquisition_source_run_id <>
                    publication.source_run_id
                AND publication.raw_trust_artifact_role_at_publication =
                    'copier_snapshot'
                AND publication.raw_evidence_contract_at_publication =
                    'arena.ingest.copier-publication-lane-raw-evidence@1'
                AND (
                  publication.live_raw_object_id IS NULL
                  OR EXISTS (
                    SELECT 1
                    FROM ONLY arena.raw_objects AS raw_object
                    WHERE raw_object.id = publication.live_raw_object_id
                      AND NOT raw_object.quarantined
                      AND raw_object.source_id = publication.source_id
                      AND raw_object.trader_id = publication.trader_id
                      AND raw_object.job_type = CASE publication.lane
                        WHEN 'tier_b' THEN 'history:copiers'
                        WHEN 'tier_c' THEN 'tier_c'
                      END
                      AND raw_object.timeframe IS NULL
                      AND raw_object.source_run_id =
                          publication.source_run_id
                      AND raw_object.content_hash =
                          publication.raw_content_hash
                      AND raw_object.trust_artifact_role =
                          publication.raw_trust_artifact_role_at_publication
                      AND raw_object.storage_path =
                          publication.raw_storage_path
                      AND raw_object.fetched_at =
                          publication.raw_fetched_at
                      AND raw_object.meta->>'source_run_id' =
                          publication.source_run_id
                      AND raw_object.meta->>'publication_lane' =
                          publication.lane
                      AND raw_object.meta->>'acquisition_source_run_id' =
                          publication.acquisition_source_run_id
                      AND raw_object.meta->>'data_contract' =
                          publication.data_contract
                      AND raw_object.meta->>
                            'publication_evidence_contract' =
                          publication.raw_evidence_contract_at_publication
                  )
                )
            )
          )
      )
    ),
    '{}'::pg_catalog.jsonb
  )
  FROM ONLY arena.sources AS source_row
  JOIN ONLY arena.exchanges AS exchange_row
    ON exchange_row.id = source_row.exchange_id
  LEFT JOIN arena.mv_source_capabilities AS capability
    ON capability.slug = source_row.slug
  WHERE source_row.status = 'active'
    AND source_row.serving_mode = 'serving';
$function$;

ALTER FUNCTION public.arena_source_capabilities() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_source_capabilities()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_source_capabilities()
  TO anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_registry regclass :=
    'arena.copier_snapshot_source_authorities'::pg_catalog.regclass;
  v_source_guard regprocedure := pg_catalog.to_regprocedure(
    'arena.enforce_copier_snapshot_source_configuration()'
  );
  v_trader_guard regprocedure := pg_catalog.to_regprocedure(
    'arena.enforce_copier_snapshot_trader_identity()'
  );
  v_publication_guard regprocedure := pg_catalog.to_regprocedure(
    'arena.enforce_copier_snapshot_publication_source_authority()'
  );
  v_immutable_guard regprocedure := pg_catalog.to_regprocedure(
    'arena.reject_copier_snapshot_source_authority_mutation()'
  );
  v_capabilities regprocedure := pg_catalog.to_regprocedure(
    'public.arena_source_capabilities()'
  );
  v_reader regprocedure := pg_catalog.to_regprocedure(
    'public.arena_copier_aggregate(text,text)'
  );
  v_publisher regprocedure := pg_catalog.to_regprocedure(
    'public.publish_copier_snapshot_v2(jsonb)'
  );
  v_legacy_publication_guard regprocedure := pg_catalog.to_regprocedure(
    'arena.reject_copier_snapshot_publication_mutation()'
  );
  v_legacy_row_guard regprocedure := pg_catalog.to_regprocedure(
    'arena.reject_copier_snapshot_row_mutation()'
  );
  v_legacy_reader regprocedure := pg_catalog.to_regprocedure(
    'arena.copier_aggregate_legacy_containment_v1(text,text)'
  );
  v_raw_guard regprocedure := pg_catalog.to_regprocedure(
    'arena.protect_copier_snapshot_raw_object()'
  );
  v_admission_guard regprocedure := pg_catalog.to_regprocedure(
    'arena.guard_copier_snapshot_publication_insert_v1()'
  );
  v_row_normalizer regprocedure := pg_catalog.to_regprocedure(
    'arena.normalize_copier_snapshot_row_source_event_v1()'
  );
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM (
      SELECT actual.*
      FROM pg_catalog.pg_attribute AS actual
      WHERE actual.attrelid = v_registry
        AND actual.attnum > 0
        AND NOT actual.attisdropped
    ) AS attribute
    FULL JOIN (
      VALUES
        (1, 'source_id', 'smallint', true),
        (2, 'source_slug', 'text', true),
        (3, 'exchange_id', 'smallint', true),
        (4, 'adapter_slug', 'text', true),
        (5, 'product_type', 'text', true),
        (6, 'trader_kind_scope', 'text', true),
        (7, 'currency', 'text', true),
        (8, 'copier_table_depth', 'text', true),
        (9, 'publication_eligible', 'boolean', true),
        (10, 'terminal_verifier_contract', 'text', false),
        (11, 'authority_contract', 'text', true),
        (12, 'contract_version', 'smallint', true)
    ) AS expected(attnum, attname, type_name, not_null)
      ON expected.attnum = attribute.attnum
    WHERE attribute.attnum IS NULL
       OR expected.attnum IS NULL
       OR attribute.attname IS DISTINCT FROM expected.attname
       OR pg_catalog.format_type(
            attribute.atttypid,
            attribute.atttypmod
          ) IS DISTINCT FROM expected.type_name
       OR attribute.attnotnull IS DISTINCT FROM expected.not_null
       OR attribute.atthasdef
       OR attribute.attidentity IS DISTINCT FROM ''
       OR attribute.attgenerated IS DISTINCT FROM ''
       OR attribute.attacl IS NOT NULL
  ) <> 0 OR (
    SELECT pg_catalog.count(*)
    FROM (
      SELECT actual.*
      FROM pg_catalog.pg_constraint AS actual
      WHERE actual.conrelid = v_registry
    ) AS constraint_row
    FULL JOIN (
      VALUES
        (
          'copier_snapshot_source_authorities_authority_contract_check',
          'c'::"char",
          'CHECK (authority_contract = ''arena.copier-snapshot-source-authority@1''::text)'
        ),
        (
          'copier_snapshot_source_authorities_contract_version_check',
          'c'::"char",
          'CHECK (contract_version = 1)'
        ),
        (
          'copier_snapshot_source_authorities_copier_table_depth_check',
          'c'::"char",
          'CHECK (copier_table_depth = ANY (ARRAY[''full''::text, ''top10''::text, ''top3_preview''::text]))'
        ),
        (
          'copier_snapshot_source_authorities_pkey',
          'p'::"char",
          'PRIMARY KEY (source_id)'
        ),
        (
          'copier_snapshot_source_authorities_source_id_fkey',
          'f'::"char",
          'FOREIGN KEY (source_id) REFERENCES arena.sources(id) ON DELETE RESTRICT'
        ),
        (
          'copier_snapshot_source_authorities_exchange_id_fkey',
          'f'::"char",
          'FOREIGN KEY (exchange_id) REFERENCES arena.exchanges(id) ON DELETE RESTRICT'
        ),
        (
          'copier_snapshot_source_authorities_source_slug_key',
          'u'::"char",
          'UNIQUE (source_slug)'
        ),
        (
          'copier_snapshot_source_authority_publication_shape',
          'c'::"char",
          'CHECK ((NOT publication_eligible IS DISTINCT FROM true AND (copier_table_depth = ANY (ARRAY[''full''::text, ''top10''::text])) AND terminal_verifier_contract IS NOT NULL AND (terminal_verifier_contract ~ ''^arena\.ingest\.history-terminal-verifier\.[a-z0-9_]+(?:\.[a-z0-9_]+)*\.copiers@[1-9][0-9]*$''::text) IS TRUE OR NOT publication_eligible IS DISTINCT FROM false AND NOT source_slug IS DISTINCT FROM ''lbank_futures''::text AND NOT adapter_slug IS DISTINCT FROM ''lbank''::text AND NOT product_type IS DISTINCT FROM ''futures''::text AND NOT trader_kind_scope IS DISTINCT FROM ''human''::text AND NOT currency IS DISTINCT FROM ''USDT''::text AND NOT copier_table_depth IS DISTINCT FROM ''top3_preview''::text AND terminal_verifier_contract IS NULL) IS TRUE)'
        )
    ) AS expected(conname, contype, definition)
      ON expected.conname = constraint_row.conname
    WHERE constraint_row.oid IS NULL
       OR expected.conname IS NULL
       OR constraint_row.contype IS DISTINCT FROM expected.contype
       OR pg_catalog.pg_get_constraintdef(
            constraint_row.oid,
            true
          ) IS DISTINCT FROM expected.definition
  ) <> 0 THEN
    RAISE EXCEPTION 'copier snapshot source authority catalog postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('sources', 'arena.sources'::pg_catalog.regclass::oid),
        ('exchanges', 'arena.exchanges'::pg_catalog.regclass::oid),
        ('traders', 'arena.traders'::pg_catalog.regclass::oid),
        ('raw_objects', 'arena.raw_objects'::pg_catalog.regclass::oid),
        (
          'copier_snapshot_publications',
          'arena.copier_snapshot_publications'::pg_catalog.regclass::oid
        ),
        (
          'copier_snapshot_rows',
          'arena.copier_snapshot_rows'::pg_catalog.regclass::oid
        ),
        ('copier_snapshot_source_authorities', v_registry::oid)
    ) AS expected(relation_name, relation_oid)
    LEFT JOIN pg_catalog.pg_class AS relation
      ON relation.oid = expected.relation_oid
    WHERE relation.oid IS NULL
       OR relation.relkind IS DISTINCT FROM 'r'
       OR relation.relpersistence IS DISTINCT FROM 'p'
       OR relation.relowner IS DISTINCT FROM
          'postgres'::pg_catalog.regrole
       OR relation.relispartition
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_inherits AS inheritance
         WHERE inheritance.inhrelid = expected.relation_oid
            OR inheritance.inhparent = expected.relation_oid
       )
  ) THEN
    RAISE EXCEPTION 'copier authority critical relation inheritance or durability postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN (
      VALUES
        (
          v_immutable_guard::oid,
          '86b876a92aebfdd0f8dee778a4d9ea6a1bdbb1a78a83341a409639cc5fcaffef'
        ),
        (
          v_source_guard::oid,
          '61fc1a1140183442c8401258dfbb320ae574d69e9f1f359fb5bf28c8b9c20db9'
        ),
        (
          v_trader_guard::oid,
          '81cf59f7b3f2c8a69659e282d9767d2e4efd918fe15247854ed18c8074b5f5d9'
        ),
        (
          v_publication_guard::oid,
          'a7a88ab9a023d9ce0496649b149b2de411fb3cc9022a56abbc8605d1cb45ae90'
        ),
        (
          v_capabilities::oid,
          '071c2e695828c548a62dd59e06723e11b00c28ff7482ad3352971fb642a3ba57'
        ),
        (
          v_reader::oid,
          'b58d79f1443fa2804e7341e388d519d4e2b0852b8e93376ab0897bcb8e6c804f'
        ),
        (
          v_publisher::oid,
          '9dd863f6f0ba59c9cb85b3e262c48e5b25ce057b74f121de817e8ebd59356a5d'
        ),
        (
          v_legacy_publication_guard::oid,
          'acf7bec862e1b3fe59832679e90288934a830399906ea09724d13a2520ca76c2'
        ),
        (
          v_legacy_row_guard::oid,
          '606531a05dd11e2ff767a2a451c58fd9c23fa72fed6096d2af7684a07632150e'
        ),
        (
          v_legacy_reader::oid,
          '18b285bc1ff2e2ba29027cd8c192583a54181dac8be4c403c9df95540a98bee9'
        ),
        (
          v_raw_guard::oid,
          'bf8d6ad40386b78d221d911d3a743ff7a597ddd00dcb6c681fe4b4ac8cca1ba2'
        ),
        (
          v_admission_guard::oid,
          '781f23be3a766207fcd98dbc1dd8c44a1e9c70279793b25fd9216a57089c17fe'
        ),
        (
          v_row_normalizer::oid,
          '521da78c8d0a696960cfe02b26a3986c4fb2d10c1295379bb380411115d00285'
        )
    ) AS expected(function_oid, functiondef_sha256)
      ON expected.function_oid = procedure.oid
    WHERE pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.pg_get_functiondef(procedure.oid),
          'UTF8'
        )
      ),
      'hex'
    ) IS DISTINCT FROM expected.functiondef_sha256
  ) THEN
    RAISE EXCEPTION 'copier snapshot source authority definition digest postflight failed';
  END IF;

  IF v_publisher IS NULL
     OR v_legacy_publication_guard IS NULL
     OR v_legacy_row_guard IS NULL
     OR v_legacy_reader IS NULL
     OR v_raw_guard IS NULL
     OR v_admission_guard IS NULL
     OR v_row_normalizer IS NULL
     OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_publisher::oid
      AND procedure.proowner = 'postgres'::pg_catalog.regrole
      AND procedure.prosecdef
      AND procedure.provolatile = 'v'
      AND procedure.proconfig IS NOT DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_publisher, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_publisher, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_publisher, 'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS privilege
    WHERE procedure.oid = v_publisher::oid
      AND privilege.privilege_type = 'EXECUTE'
      AND NOT (
        (
          privilege.grantee = 'postgres'::pg_catalog.regrole::oid
          AND privilege.grantor = 'postgres'::pg_catalog.regrole::oid
          AND NOT privilege.is_grantable
        ) OR (
          privilege.grantee = 'service_role'::pg_catalog.regrole::oid
          AND privilege.grantor = 'postgres'::pg_catalog.regrole::oid
          AND NOT privilege.is_grantable
        )
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS privilege
    WHERE procedure.oid = v_publisher::oid
      AND privilege.privilege_type = 'EXECUTE'
  ) IS DISTINCT FROM 2
  THEN
    RAISE EXCEPTION 'canonical V2 publisher postflight drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM copier_snapshot_expected_authorities AS expected
    JOIN ONLY arena.sources AS source_row
      ON source_row.slug = expected.source_slug
    JOIN ONLY arena.exchanges AS exchange_row
      ON exchange_row.id = source_row.exchange_id
    WHERE exchange_row.slug IS DISTINCT FROM expected.exchange_slug
       OR source_row.copier_table_depth IS DISTINCT FROM
        expected.target_depth
  ) OR EXISTS (
    SELECT 1
    FROM ONLY arena.sources AS source_row
    LEFT JOIN ONLY arena.copier_snapshot_source_authorities AS authority
      ON authority.source_id = source_row.id
     AND authority.source_slug = source_row.slug
     AND authority.exchange_id = source_row.exchange_id
     AND authority.adapter_slug = source_row.adapter_slug
     AND authority.product_type = source_row.product_type
     AND authority.trader_kind_scope = source_row.trader_kind_scope
     AND authority.currency = source_row.currency
     AND authority.copier_table_depth = source_row.copier_table_depth
    WHERE source_row.copier_table_depth IS DISTINCT FROM 'none'
      AND authority.source_id IS NULL
  ) THEN
    RAISE EXCEPTION 'copier source depth or registry binding postflight failed';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM ONLY arena.copier_snapshot_source_authorities
  ) <> 14 OR EXISTS (
    SELECT 1
    FROM ONLY arena.copier_snapshot_source_authorities AS authority
    JOIN ONLY arena.sources AS source_row
      ON source_row.id = authority.source_id
    JOIN ONLY arena.exchanges AS exchange_row
      ON exchange_row.id = source_row.exchange_id
    LEFT JOIN copier_snapshot_expected_authorities AS expected
      ON expected.source_slug = authority.source_slug
     AND expected.target_depth IS DISTINCT FROM 'none'
    WHERE expected.source_slug IS NULL
       OR authority.source_slug IS DISTINCT FROM source_row.slug
       OR authority.exchange_id IS DISTINCT FROM source_row.exchange_id
       OR exchange_row.slug IS DISTINCT FROM expected.exchange_slug
       OR authority.adapter_slug IS DISTINCT FROM source_row.adapter_slug
       OR authority.product_type IS DISTINCT FROM source_row.product_type
       OR authority.trader_kind_scope IS DISTINCT FROM
          source_row.trader_kind_scope
       OR authority.currency IS DISTINCT FROM source_row.currency
       OR authority.copier_table_depth IS DISTINCT FROM
          source_row.copier_table_depth
       OR authority.adapter_slug IS DISTINCT FROM expected.adapter_slug
       OR authority.product_type IS DISTINCT FROM expected.product_type
       OR authority.trader_kind_scope IS DISTINCT FROM
          expected.trader_kind_scope
       OR authority.currency IS DISTINCT FROM expected.currency
       OR authority.copier_table_depth IS DISTINCT FROM
          expected.target_depth
       OR authority.publication_eligible IS DISTINCT FROM
          expected.publication_eligible
       OR authority.terminal_verifier_contract IS DISTINCT FROM
          expected.terminal_verifier_contract
       OR authority.authority_contract IS DISTINCT FROM
          'arena.copier-snapshot-source-authority@1'
       OR authority.contract_version IS DISTINCT FROM 1
  ) THEN
    RAISE EXCEPTION 'copier snapshot source authority rows postflight failed';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid =
        'arena.copier_snapshot_source_authorities'::pg_catalog.regclass
      AND relation.relowner = 'postgres'::pg_catalog.regrole
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) <> 1 OR EXISTS (
    SELECT 1
    FROM (
      VALUES ('anon'), ('authenticated'), ('service_role')
    ) AS api_role(role_name)
    WHERE pg_catalog.has_table_privilege(
      api_role.role_name,
      'arena.copier_snapshot_source_authorities',
      'SELECT'
    ) OR pg_catalog.has_table_privilege(
      api_role.role_name,
      'arena.copier_snapshot_source_authorities',
      'INSERT'
    ) OR pg_catalog.has_table_privilege(
      api_role.role_name,
      'arena.copier_snapshot_source_authorities',
      'UPDATE'
    ) OR pg_catalog.has_table_privilege(
      api_role.role_name,
      'arena.copier_snapshot_source_authorities',
      'DELETE'
    ) OR pg_catalog.has_any_column_privilege(
      api_role.role_name,
      'arena.copier_snapshot_source_authorities',
      'SELECT'
    ) OR pg_catalog.has_any_column_privilege(
      api_role.role_name,
      'arena.copier_snapshot_source_authorities',
      'INSERT'
    ) OR pg_catalog.has_any_column_privilege(
      api_role.role_name,
      'arena.copier_snapshot_source_authorities',
      'UPDATE'
    ) OR pg_catalog.has_any_column_privilege(
      api_role.role_name,
      'arena.copier_snapshot_source_authorities',
      'REFERENCES'
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS privilege
    WHERE relation.oid = v_registry
      AND NOT (
        privilege.grantee = relation.relowner
        AND privilege.grantor = relation.relowner
        AND NOT privilege.is_grantable
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS privilege
    WHERE relation.oid = v_registry
  ) IS DISTINCT FROM 8
  THEN
    RAISE EXCEPTION 'copier snapshot source authority privacy boundary drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES ('anon'), ('authenticated'), ('service_role')
    ) AS api_role(role_name)
    CROSS JOIN (
      VALUES
        ('arena.copier_snapshot_publications'::pg_catalog.regclass),
        ('arena.mv_source_capabilities'::pg_catalog.regclass)
    ) AS private_projection(relation_oid)
    WHERE pg_catalog.has_table_privilege(
      api_role.role_name,
      private_projection.relation_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) OR pg_catalog.has_any_column_privilege(
      api_role.role_name,
      private_projection.relation_oid,
      'SELECT,INSERT,UPDATE,REFERENCES'
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault(
          CASE relation.relkind
            WHEN 'S' THEN 'S'
            ELSE 'r'
          END::"char",
          relation.relowner
        )
      )
    ) AS privilege
    WHERE relation.oid IN (
      'arena.copier_snapshot_publications'::pg_catalog.regclass,
      'arena.copier_snapshot_publications_publication_id_seq'::pg_catalog.regclass,
      'arena.mv_source_capabilities'::pg_catalog.regclass
    )
      AND NOT (
        privilege.grantee = relation.relowner
        AND privilege.grantor = relation.relowner
        AND NOT privilege.is_grantable
      )
  ) OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'arena.copier_snapshot_publications'::pg_catalog.regclass,
          8::bigint
        ),
        (
          'arena.copier_snapshot_publications_publication_id_seq'::pg_catalog.regclass,
          3::bigint
        ),
        (
          'arena.mv_source_capabilities'::pg_catalog.regclass,
          8::bigint
        )
    ) AS expected(relation_oid, privilege_count)
    CROSS JOIN LATERAL (
      SELECT pg_catalog.count(*) AS privilege_count
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault(
            CASE relation.relkind
              WHEN 'S' THEN 'S'
              ELSE 'r'
            END::"char",
            relation.relowner
          )
        )
      ) AS privilege
      WHERE relation.oid = expected.relation_oid
    ) AS actual
    WHERE actual.privilege_count IS DISTINCT FROM
        expected.privilege_count
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid IN (
      'arena.copier_snapshot_publications'::pg_catalog.regclass,
      'arena.mv_source_capabilities'::pg_catalog.regclass
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attacl IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'copier snapshot direct projection ACL postflight failed';
  END IF;

  IF v_source_guard IS NULL
     OR v_trader_guard IS NULL
     OR v_publication_guard IS NULL
     OR v_immutable_guard IS NULL
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure
       WHERE procedure.oid IN (
         v_source_guard::oid,
         v_trader_guard::oid,
         v_publication_guard::oid,
         v_immutable_guard::oid
       )
         AND (
           procedure.proowner IS DISTINCT FROM
             'postgres'::pg_catalog.regrole
           OR NOT procedure.prosecdef
           OR procedure.provolatile IS DISTINCT FROM 'v'
           OR procedure.proconfig IS DISTINCT FROM
             ARRAY['search_path=pg_catalog, pg_temp']::text[]
         )
     ) OR EXISTS (
       SELECT 1
       FROM (
         VALUES ('anon'), ('authenticated'), ('service_role')
       ) AS api_role(role_name)
       CROSS JOIN (
         VALUES
           (v_source_guard),
           (v_trader_guard),
           (v_publication_guard),
           (v_immutable_guard)
       ) AS guarded_function(function_oid)
       WHERE pg_catalog.has_function_privilege(
         api_role.role_name,
         guarded_function.function_oid,
         'EXECUTE'
       )
  ) THEN
    RAISE EXCEPTION 'copier snapshot source authority function boundary drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_legacy_publication_guard::oid
      AND procedure.proowner = 'postgres'::pg_catalog.regrole
      AND NOT procedure.prosecdef
      AND procedure.provolatile = 'v'
      AND procedure.proconfig IS NOT DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_legacy_row_guard::oid
      AND procedure.proowner = 'postgres'::pg_catalog.regrole
      AND NOT procedure.prosecdef
      AND procedure.provolatile = 'v'
      AND procedure.proconfig IS NOT DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_legacy_reader::oid
      AND procedure.proowner = 'postgres'::pg_catalog.regrole
      AND procedure.prosecdef
      AND procedure.provolatile = 's'
      AND procedure.pronargdefaults = 0
      AND procedure.proconfig IS NOT DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid IN (
      v_raw_guard::oid,
      v_admission_guard::oid,
      v_row_normalizer::oid
    )
      AND procedure.proowner = 'postgres'::pg_catalog.regrole
      AND NOT procedure.prosecdef
      AND procedure.provolatile = 'v'
      AND procedure.proconfig IS NOT DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) IS DISTINCT FROM 3 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS privilege
    WHERE procedure.oid IN (
      v_immutable_guard::oid,
      v_source_guard::oid,
      v_trader_guard::oid,
      v_publication_guard::oid,
      v_legacy_publication_guard::oid,
      v_legacy_row_guard::oid,
      v_legacy_reader::oid,
      v_raw_guard::oid,
      v_admission_guard::oid,
      v_row_normalizer::oid
    )
      AND NOT (
        privilege.privilege_type = 'EXECUTE'
        AND privilege.grantee = procedure.proowner
        AND privilege.grantor = procedure.proowner
        AND NOT privilege.is_grantable
      )
  ) OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (v_immutable_guard::oid),
        (v_source_guard::oid),
        (v_trader_guard::oid),
        (v_publication_guard::oid),
        (v_legacy_publication_guard::oid),
        (v_legacy_row_guard::oid),
        (v_legacy_reader::oid),
        (v_raw_guard::oid),
        (v_admission_guard::oid),
        (v_row_normalizer::oid)
    ) AS expected(function_oid)
    CROSS JOIN LATERAL (
      SELECT pg_catalog.count(*) AS privilege_count
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner)
        )
      ) AS privilege
      WHERE procedure.oid = expected.function_oid
        AND privilege.privilege_type = 'EXECUTE'
    ) AS actual
    WHERE actual.privilege_count IS DISTINCT FROM 1
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS privilege
    WHERE procedure.oid IN (v_capabilities::oid, v_reader::oid)
      AND NOT (
        privilege.privilege_type = 'EXECUTE'
        AND privilege.grantor = 'postgres'::pg_catalog.regrole::oid
        AND (
          (
            privilege.grantee = 'postgres'::pg_catalog.regrole::oid
            AND NOT privilege.is_grantable
          ) OR (
            privilege.grantee IN (
              'anon'::pg_catalog.regrole::oid,
              'authenticated'::pg_catalog.regrole::oid,
              'service_role'::pg_catalog.regrole::oid
            )
            AND NOT privilege.is_grantable
          )
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM (
      VALUES (v_capabilities::oid), (v_reader::oid)
    ) AS expected(function_oid)
    CROSS JOIN LATERAL (
      SELECT pg_catalog.count(*) AS privilege_count
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner)
        )
      ) AS privilege
      WHERE procedure.oid = expected.function_oid
        AND privilege.privilege_type = 'EXECUTE'
    ) AS actual
    WHERE actual.privilege_count IS DISTINCT FROM 4
  ) THEN
    RAISE EXCEPTION 'copier authority exact function ACL postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena_copier_aggregate', v_reader::oid),
        ('arena_source_capabilities', v_capabilities::oid),
        ('publish_copier_snapshot_v2', v_publisher::oid)
    ) AS expected(proname, function_oid)
    CROSS JOIN LATERAL (
      SELECT
        pg_catalog.count(*) AS symbol_count,
        pg_catalog.count(*) FILTER (
          WHERE procedure.oid = expected.function_oid
            AND procedure.pronargdefaults = 0
        ) AS canonical_count
      FROM pg_catalog.pg_proc AS procedure
      WHERE procedure.pronamespace = 'public'::pg_catalog.regnamespace
        AND procedure.proname = expected.proname
    ) AS actual
    WHERE actual.symbol_count IS DISTINCT FROM 1
       OR actual.canonical_count IS DISTINCT FROM 1
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.pronamespace = 'arena'::pg_catalog.regnamespace
      AND procedure.proname = 'copier_aggregate_legacy_containment_v1'
      AND procedure.oid = v_legacy_reader::oid
      AND procedure.pronargdefaults = 0
  ) IS DISTINCT FROM 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.pronamespace = 'arena'::pg_catalog.regnamespace
      AND procedure.proname = 'copier_aggregate_legacy_containment_v1'
  ) IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'copier authority exposed RPC symbol inventory postflight failed';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    JOIN (
      VALUES
        (
          v_registry,
          'copier_snapshot_source_authority_reject_mutation',
          v_immutable_guard::oid,
          'CREATE TRIGGER copier_snapshot_source_authority_reject_mutation BEFORE INSERT OR DELETE OR UPDATE ON arena.copier_snapshot_source_authorities FOR EACH ROW EXECUTE FUNCTION arena.reject_copier_snapshot_source_authority_mutation()'
        ),
        (
          v_registry,
          'copier_snapshot_source_authority_reject_truncate',
          v_immutable_guard::oid,
          'CREATE TRIGGER copier_snapshot_source_authority_reject_truncate BEFORE TRUNCATE ON arena.copier_snapshot_source_authorities FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_copier_snapshot_source_authority_mutation()'
        ),
        (
          'arena.sources'::pg_catalog.regclass,
          'copier_snapshot_source_configuration_authority',
          v_source_guard::oid,
          'CREATE TRIGGER copier_snapshot_source_configuration_authority BEFORE INSERT OR DELETE OR UPDATE ON arena.sources FOR EACH ROW EXECUTE FUNCTION arena.enforce_copier_snapshot_source_configuration()'
        ),
        (
          'arena.traders'::pg_catalog.regclass,
          'copier_snapshot_trader_identity_authority',
          v_trader_guard::oid,
          'CREATE TRIGGER copier_snapshot_trader_identity_authority BEFORE INSERT OR DELETE OR UPDATE ON arena.traders FOR EACH ROW EXECUTE FUNCTION arena.enforce_copier_snapshot_trader_identity()'
        ),
        (
          'arena.copier_snapshot_publications'::pg_catalog.regclass,
          'copier_snapshot_publication_00_source_authority',
          v_publication_guard::oid,
          'CREATE TRIGGER copier_snapshot_publication_00_source_authority BEFORE INSERT OR UPDATE ON arena.copier_snapshot_publications FOR EACH ROW EXECUTE FUNCTION arena.enforce_copier_snapshot_publication_source_authority()'
        ),
        (
          'arena.copier_snapshot_publications'::pg_catalog.regclass,
          'copier_snapshot_publication_reject_update_delete',
          v_legacy_publication_guard::oid,
          'CREATE TRIGGER copier_snapshot_publication_reject_update_delete BEFORE DELETE OR UPDATE ON arena.copier_snapshot_publications FOR EACH ROW EXECUTE FUNCTION arena.reject_copier_snapshot_publication_mutation()'
        ),
        (
          'arena.copier_snapshot_publications'::pg_catalog.regclass,
          'copier_snapshot_publication_reject_truncate',
          v_legacy_publication_guard::oid,
          'CREATE TRIGGER copier_snapshot_publication_reject_truncate BEFORE TRUNCATE ON arena.copier_snapshot_publications FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_copier_snapshot_publication_mutation()'
        ),
        (
          'arena.copier_snapshot_rows'::pg_catalog.regclass,
          'copier_snapshot_row_reject_update_delete',
          v_legacy_row_guard::oid,
          'CREATE TRIGGER copier_snapshot_row_reject_update_delete BEFORE DELETE OR UPDATE ON arena.copier_snapshot_rows FOR EACH ROW EXECUTE FUNCTION arena.reject_copier_snapshot_row_mutation()'
        ),
        (
          'arena.copier_snapshot_rows'::pg_catalog.regclass,
          'copier_snapshot_row_reject_truncate',
          v_legacy_row_guard::oid,
          'CREATE TRIGGER copier_snapshot_row_reject_truncate BEFORE TRUNCATE ON arena.copier_snapshot_rows FOR EACH STATEMENT EXECUTE FUNCTION arena.reject_copier_snapshot_row_mutation()'
        )
    ) AS expected(relation_oid, trigger_name, function_oid, definition)
      ON expected.relation_oid = trigger_row.tgrelid
     AND expected.trigger_name = trigger_row.tgname
    WHERE NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'A'
      AND trigger_row.tgfoid = expected.function_oid
      AND pg_catalog.pg_get_triggerdef(trigger_row.oid, true) =
          expected.definition
  ) <> 9 THEN
    RAISE EXCEPTION 'copier snapshot source authority trigger postflight failed';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'arena.copier_snapshot_publications'::pg_catalog.regclass,
      'arena.copier_snapshot_rows'::pg_catalog.regclass
    )
      AND NOT trigger_row.tgisinternal
  ) IS DISTINCT FROM 7 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'arena.copier_snapshot_publications'::pg_catalog.regclass,
      'arena.copier_snapshot_rows'::pg_catalog.regclass
    )
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgname NOT IN (
        'copier_snapshot_publication_reject_update_delete',
        'copier_snapshot_publication_reject_truncate',
        'copier_snapshot_publication_guard_insert_v1',
        'copier_snapshot_publication_00_source_authority',
        'copier_snapshot_row_reject_update_delete',
        'copier_snapshot_row_reject_truncate',
        'copier_snapshot_row_normalize_source_event_v1'
      )
  ) THEN
    RAISE EXCEPTION 'copier snapshot publication or row trigger inventory postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'arena.raw_objects'::pg_catalog.regclass
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgname NOT IN (
        'raw_objects_require_tier_a_execution',
        'zz_raw_objects_verify_tier_a_execution',
        'protect_metric_trust_raw_object_before_write',
        'protect_leaderboard_acquisition_raw_evidence_before_write',
        'protect_record_surface_publication_raw_before_write',
        'admit_position_history_raw_after_insert',
        'protect_position_history_raw_evidence_before_write',
        'reject_position_history_raw_truncate',
        'protect_copier_snapshot_raw_before_write'
      )
  ) THEN
    RAISE EXCEPTION 'copier snapshot RAW trigger inventory postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_capabilities
      AND procedure.proowner = 'postgres'::pg_catalog.regrole
      AND procedure.prosecdef
      AND procedure.provolatile = 's'
      AND procedure.proconfig IS NOT DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND pg_catalog.strpos(
        procedure.prosrc,
        'arena.copier_snapshot_source_authorities'
      ) > 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        '''copierDepth'', source_row.copier_table_depth'
      ) > 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        '''copiers'', EXISTS'
      ) > 0
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS privilege
    WHERE procedure.oid = v_capabilities
      AND privilege.grantee = 0::oid
      AND privilege.privilege_type = 'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'anon', v_capabilities, 'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'authenticated', v_capabilities, 'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_capabilities, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'copier source capability authority postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_reader
      AND procedure.proowner = 'postgres'::pg_catalog.regrole
      AND procedure.prosecdef
      AND procedure.provolatile = 's'
      AND procedure.proconfig IS NOT DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
      AND pg_catalog.strpos(
        procedure.prosrc,
        'arena.copier-snapshot-receipt-reader@4'
      ) > 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        'arena.copier_snapshot_source_authorities'
      ) > 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        'copier_snapshot_legacy_fallback_enabled'
      ) = 0
      AND pg_catalog.strpos(
        procedure.prosrc,
        'arena.copier-snapshot-publication@1'
      ) = 0
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS privilege
    WHERE procedure.oid = v_reader
      AND privilege.grantee = 0::oid
      AND privilege.privilege_type = 'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'anon', v_reader, 'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'authenticated', v_reader, 'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_reader, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'copier aggregate source authority postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ONLY arena.copier_snapshot_publications AS publication
    JOIN ONLY arena.sources AS source_row
      ON source_row.id = publication.source_id
    LEFT JOIN ONLY arena.traders AS trader_row
      ON trader_row.id = publication.trader_id
     AND trader_row.source_id = publication.source_id
    LEFT JOIN ONLY arena.copier_snapshot_source_authorities AS authority
      ON authority.source_id = source_row.id
     AND authority.source_slug = source_row.slug
     AND authority.exchange_id = source_row.exchange_id
     AND authority.adapter_slug = source_row.adapter_slug
     AND authority.product_type = source_row.product_type
     AND authority.trader_kind_scope = source_row.trader_kind_scope
     AND authority.currency = source_row.currency
     AND authority.copier_table_depth = source_row.copier_table_depth
     AND authority.publication_eligible
     AND authority.copier_table_depth = publication.source_depth
     AND authority.currency = publication.currency
     AND authority.terminal_verifier_contract =
         publication.terminal_verifier_contract
    WHERE trader_row.id IS NULL
       OR authority.source_id IS NULL
       OR publication.evidence_contract IS DISTINCT FROM
          'arena.copier-snapshot-publication@2'
       OR publication.publisher_contract IS DISTINCT FROM
          'arena.ingest.copier-snapshot-publisher@2'
  ) THEN
    RAISE EXCEPTION 'copier snapshot receipt source authority postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
