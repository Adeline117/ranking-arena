-- Register immutable copier snapshot trust envelopes as a distinct RAW role.
--
-- This is storage substrate only. It deliberately does not retarget the v1
-- copier publisher, reinterpret old `copier_snapshot` rows, or grant access to
-- RAW evidence. One outer artifact@2 SHA-256 may identify at most one pointer,
-- regardless of source or Storage path.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $foundations$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regnamespace('supabase_migrations') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL
     OR pg_catalog.to_regclass(
          'supabase_migrations.schema_migrations'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.publish_copier_snapshot(smallint,bigint,text,bigint,text,text,timestamp with time zone,boolean,integer,integer,jsonb)'
        ) IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION
      'copier snapshot trust RAW role requires PG17, the exact v1 copier publisher, migration ledger, and API roles';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute_row
     WHERE attribute_row.attrelid =
           'supabase_migrations.schema_migrations'::pg_catalog.regclass
       AND attribute_row.attname = 'version'
       AND attribute_row.atttypid = 'pg_catalog.text'::pg_catalog.regtype
       AND attribute_row.attnum > 0
       AND NOT attribute_row.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute_row
     WHERE attribute_row.attrelid =
           'supabase_migrations.schema_migrations'::pg_catalog.regclass
       AND attribute_row.attname = 'name'
       AND attribute_row.atttypid = 'pg_catalog.text'::pg_catalog.regtype
       AND attribute_row.attnum > 0
       AND NOT attribute_row.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute_row
     WHERE attribute_row.attrelid =
           'supabase_migrations.schema_migrations'::pg_catalog.regclass
       AND attribute_row.attname = 'statements'
       AND attribute_row.atttypid = 'pg_catalog._text'::pg_catalog.regtype
       AND attribute_row.attnum > 0
       AND NOT attribute_row.attisdropped
  ) THEN
    RAISE EXCEPTION 'Supabase migration ledger identity columns drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation_row
     WHERE relation_row.oid = 'arena.raw_objects'::pg_catalog.regclass
       AND relation_row.relkind IN ('r', 'p')
       AND relation_row.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'private RAW row-security boundary is missing';
  END IF;
END
$foundations$;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260808010000-copier-snapshot-trust-raw-role',
    0
  )
);

LOCK TABLE supabase_migrations.schema_migrations
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.raw_objects IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_predecessor_count bigint;
  v_constraint record;
BEGIN
  SELECT pg_catalog.count(*)
    INTO STRICT v_predecessor_count
    FROM supabase_migrations.schema_migrations AS ledger
   WHERE ledger.name = 'publish_copier_snapshot_atomically';

  -- MCP assigns a server-side version. Bind the prerequisite to its unique
  -- reviewed name and immutable SQL bytes, never the local filename timestamp.
  IF v_predecessor_count <> 1
     OR NOT EXISTS (
       SELECT 1
         FROM supabase_migrations.schema_migrations AS ledger
        WHERE ledger.name = 'publish_copier_snapshot_atomically'
          AND pg_catalog.array_length(ledger.statements, 1) = 1
          AND pg_catalog.encode(
                pg_catalog.sha256(
                  pg_catalog.convert_to(ledger.statements[1], 'UTF8')
                ),
                'hex'
              ) =
              '858623049276963f644749fb0a660910967f1c51ac748dfe4f5556e38d69326b'
     ) THEN
    RAISE EXCEPTION
      'copier trust RAW role requires one exact publish_copier_snapshot_atomically migration ledger name and body';
  END IF;

  SELECT constraint_row.contype,
         constraint_row.convalidated,
         constraint_row.connoinherit,
         pg_catalog.encode(
           pg_catalog.sha256(
             pg_catalog.convert_to(
               pg_catalog.pg_get_constraintdef(constraint_row.oid),
               'UTF8'
             )
           ),
           'hex'
         ) AS definition_sha256
    INTO v_constraint
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = 'arena.raw_objects'::pg_catalog.regclass
     AND constraint_row.conname = 'raw_objects_metric_trust_binding';

  IF NOT FOUND
     OR v_constraint.contype IS DISTINCT FROM 'c'::"char"
     OR v_constraint.convalidated IS DISTINCT FROM true
     OR v_constraint.connoinherit IS DISTINCT FROM false
     OR v_constraint.definition_sha256 IS DISTINCT FROM
        'c8bce3447cb1b4456bb53e5cda9f82e00b4026ab2ed32d4a7305f2172bf5f8bd' THEN
    RAISE EXCEPTION
      'raw_objects_metric_trust_binding has same-name drift or is not the exact copier_snapshot baseline';
  END IF;

  IF pg_catalog.to_regclass(
       'arena.uidx_raw_copier_snapshot_trust_per_run'
     ) IS NOT NULL THEN
    RAISE EXCEPTION
      'copier snapshot trust RAW identity index already exists or has same-name drift';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM arena.raw_objects AS raw_object
     WHERE raw_object.trust_artifact_role = 'copier_snapshot_trust'
  ) THEN
    RAISE EXCEPTION
      'unregistered copier_snapshot_trust RAW rows already exist';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM arena.raw_objects AS raw_object
     WHERE (raw_object.source_run_id IS NULL) <>
           (raw_object.trust_artifact_role IS NULL)
  ) THEN
    RAISE EXCEPTION
      'half-bound legacy RAW trust rows must be quarantined before role registration';
  END IF;
END
$preflight$;

ALTER TABLE arena.raw_objects
  DROP CONSTRAINT raw_objects_metric_trust_binding,
  ADD CONSTRAINT raw_objects_metric_trust_binding CHECK (
    (source_run_id IS NULL AND trust_artifact_role IS NULL)
    OR (
      source_run_id IS NOT NULL
      AND trust_artifact_role IS NOT NULL
      AND source_run_id ~ '^[0-9a-f]{64}$'
      AND trust_artifact_role IN (
        'source_payload',
        'population_manifest',
        'normalization_components',
        'event_history',
        'price_history',
        'opening_inventory',
        'copier_snapshot',
        'copier_snapshot_trust'
      )
    )
  );

CREATE UNIQUE INDEX uidx_raw_copier_snapshot_trust_per_run
  ON arena.raw_objects (source_run_id)
  WHERE source_run_id IS NOT NULL
    AND trust_artifact_role = 'copier_snapshot_trust';

COMMENT ON INDEX arena.uidx_raw_copier_snapshot_trust_per_run IS
  'One immutable copier snapshot artifact@2 trust envelope pointer per outer artifact SHA-256; source and Storage path cannot fork that identity.';

DO $postflight$
DECLARE
  v_constraint_sha256 text;
  v_index_predicate text;
BEGIN
  SELECT pg_catalog.encode(
           pg_catalog.sha256(
             pg_catalog.convert_to(
               pg_catalog.pg_get_constraintdef(constraint_row.oid),
               'UTF8'
             )
           ),
           'hex'
         )
    INTO STRICT v_constraint_sha256
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = 'arena.raw_objects'::pg_catalog.regclass
     AND constraint_row.conname = 'raw_objects_metric_trust_binding'
     AND constraint_row.contype = 'c'
     AND constraint_row.convalidated
     AND NOT constraint_row.connoinherit;

  IF v_constraint_sha256 IS DISTINCT FROM
     'b38e9396fc8e7198376dc261f8192fe48b636687796b9bc48f3c23dca24d21d8' THEN
    RAISE EXCEPTION 'copier snapshot trust RAW role constraint postflight failed';
  END IF;

  SELECT pg_catalog.pg_get_expr(
           index_row.indpred,
           index_row.indrelid
         )
    INTO STRICT v_index_predicate
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = index_relation.relam
   WHERE index_row.indexrelid =
         'arena.uidx_raw_copier_snapshot_trust_per_run'::pg_catalog.regclass
     AND index_row.indrelid = 'arena.raw_objects'::pg_catalog.regclass
     AND index_row.indisunique
     AND index_row.indisvalid
     AND index_row.indisready
     AND index_row.indimmediate
     AND index_row.indnkeyatts = 1
     AND index_row.indnatts = 1
     AND access_method.amname = 'btree'
     AND (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.unnest(index_row.indkey) AS indexed_attribute(attnum)
        WHERE indexed_attribute.attnum = (
          SELECT attribute_row.attnum
            FROM pg_catalog.pg_attribute AS attribute_row
           WHERE attribute_row.attrelid = index_row.indrelid
             AND attribute_row.attname = 'source_run_id'
             AND attribute_row.attnum > 0
             AND NOT attribute_row.attisdropped
        )
     ) = 1;

  IF v_index_predicate IS DISTINCT FROM
     '((source_run_id IS NOT NULL) AND (trust_artifact_role = ''copier_snapshot_trust''::text))' THEN
    RAISE EXCEPTION 'copier snapshot trust RAW identity index postflight failed';
  END IF;
END
$postflight$;

COMMIT;
