-- Migration: 20260803100500_atomic_ranking_snapshot_create.sql
-- Created: 2026-08-03T10:05:00Z
-- Description: Publish a complete ranking snapshot through one service-only,
--   actor/request-bound transaction. A private replay ledger makes exact
--   response-loss retries stable and rejects changed payloads. Browser writes
--   are closed; direct service writes remain temporarily available only for
--   rolling compatibility with the pre-cutover API deployment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.ranking_snapshots:atomic-create:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic ranking snapshot migration lock is busy';
  END IF;
END
$migration_lock$;

DO $preflight$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_missing_roles text[];
  v_invalid_columns text[];
  v_expected_function regprocedure := pg_catalog.to_regprocedure(
    'public.create_ranking_snapshot_atomic(uuid,text,text,text,jsonb)'
  );
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY[
      'anon',
      'authenticated',
      'authenticator',
      'service_role',
      'postgres'
    ]::text[]
  ) AS required_role
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = required_role
  );

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'atomic ranking snapshot roles are missing: %',
      v_missing_roles;
  END IF;

  IF pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.ranking_snapshots') IS NULL
     OR pg_catalog.to_regclass('public.snapshot_traders') IS NULL
  THEN
    RAISE EXCEPTION
      'canonical auth, profile and ranking snapshot relations must deploy first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.user_profiles'::regclass,
      'public.ranking_snapshots'::regclass,
      'public.snapshot_traders'::regclass
    )
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
        OR relation.relowner <> v_postgres_oid
      )
  ) THEN
    RAISE EXCEPTION
      'atomic ranking snapshot requires canonical permanent relation ownership';
  END IF;

  SELECT pg_catalog.array_agg(
    pg_catalog.format(
      '%I.%I.%I expected %s%s',
      required_column.schema_name,
      required_column.relation_name,
      required_column.column_name,
      required_column.type_oid::regtype,
      CASE WHEN required_column.required_not_null THEN ' NOT NULL' ELSE '' END
    )
    ORDER BY required_column.schema_name,
      required_column.relation_name,
      required_column.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      ('public', 'user_profiles', 1, 'id', 'uuid'::regtype, true),
      ('public', 'ranking_snapshots', 1, 'id', 'uuid'::regtype, true),
      ('public', 'ranking_snapshots', 2, 'created_by', 'uuid'::regtype, false),
      ('public', 'ranking_snapshots', 3, 'share_token', 'text'::regtype, false),
      ('public', 'ranking_snapshots', 4, 'time_range', 'text'::regtype, true),
      ('public', 'ranking_snapshots', 5, 'exchange', 'text'::regtype, false),
      ('public', 'ranking_snapshots', 6, 'total_traders', 'integer'::regtype, true),
      ('public', 'ranking_snapshots', 7, 'top_trader_handle', 'text'::regtype, false),
      ('public', 'ranking_snapshots', 8, 'top_trader_roi', 'numeric'::regtype, false),
      ('public', 'ranking_snapshots', 9, 'data_captured_at', 'timestamptz'::regtype, true),
      ('public', 'ranking_snapshots', 10, 'is_public', 'boolean'::regtype, false),
      ('public', 'ranking_snapshots', 11, 'view_count', 'integer'::regtype, false),
      ('public', 'ranking_snapshots', 12, 'expires_at', 'timestamptz'::regtype, false),
      ('public', 'ranking_snapshots', 13, 'is_expired', 'boolean'::regtype, false),
      ('public', 'snapshot_traders', 1, 'snapshot_id', 'uuid'::regtype, true),
      ('public', 'snapshot_traders', 2, 'rank', 'integer'::regtype, true),
      ('public', 'snapshot_traders', 3, 'trader_id', 'text'::regtype, true),
      ('public', 'snapshot_traders', 4, 'handle', 'text'::regtype, false),
      ('public', 'snapshot_traders', 5, 'source', 'text'::regtype, true),
      ('public', 'snapshot_traders', 6, 'avatar_url', 'text'::regtype, false),
      ('public', 'snapshot_traders', 7, 'roi', 'numeric'::regtype, false),
      ('public', 'snapshot_traders', 8, 'pnl', 'numeric'::regtype, false),
      ('public', 'snapshot_traders', 9, 'win_rate', 'numeric'::regtype, false),
      ('public', 'snapshot_traders', 10, 'max_drawdown', 'numeric'::regtype, false),
      ('public', 'snapshot_traders', 11, 'trades_count', 'integer'::regtype, false),
      ('public', 'snapshot_traders', 12, 'followers', 'integer'::regtype, false),
      ('public', 'snapshot_traders', 13, 'arena_score', 'numeric'::regtype, false),
      ('public', 'snapshot_traders', 14, 'return_score', 'numeric'::regtype, false),
      ('public', 'snapshot_traders', 15, 'drawdown_score', 'numeric'::regtype, false),
      ('public', 'snapshot_traders', 16, 'stability_score', 'numeric'::regtype, false),
      ('public', 'snapshot_traders', 17, 'data_availability', 'jsonb'::regtype, false)
  ) AS required_column(
    schema_name,
    relation_name,
    ordinality,
    column_name,
    type_oid,
    required_not_null
  )
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = pg_catalog.to_regclass(
      pg_catalog.format(
        '%I.%I',
        required_column.schema_name,
        required_column.relation_name
      )
    )
   AND attribute.attname = required_column.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
     OR attribute.atttypid <> required_column.type_oid
     OR (required_column.required_not_null AND NOT attribute.attnotnull);

  IF v_invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION 'atomic ranking snapshot columns are incompatible: %',
      v_invalid_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = index_relation.relam
    JOIN pg_catalog.pg_attribute AS token_attribute
      ON token_attribute.attrelid = index_row.indrelid
     AND token_attribute.attname = 'share_token'
     AND token_attribute.attnum > 0
     AND NOT token_attribute.attisdropped
    WHERE index_row.indrelid = 'public.ranking_snapshots'::regclass
      AND index_relation.relkind = 'i'
      AND index_relation.relpersistence = 'p'
      AND access_method.amname = 'btree'
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indislive
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NULL
      AND index_row.indkey[0] = token_attribute.attnum
  ) THEN
    RAISE EXCEPTION 'ranking snapshot share token lacks an exact unique key';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.snapshot_traders'::regclass
      AND constraint_row.contype = 'u'
      AND constraint_row.convalidated
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.snapshot_traders'::regclass
            AND attribute.attname = 'snapshot_id'
        ),
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.snapshot_traders'::regclass
            AND attribute.attname = 'rank'
        )
      ]::smallint[]
  ) THEN
    RAISE EXCEPTION 'snapshot trader rank uniqueness is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'create_ranking_snapshot_atomic'
      AND function_row.oid IS DISTINCT FROM v_expected_function
  ) THEN
    RAISE EXCEPTION 'incompatible create_ranking_snapshot_atomic overload exists';
  END IF;
END
$preflight$;

LOCK TABLE auth.users,
  public.user_profiles,
  public.ranking_snapshots,
  public.snapshot_traders
  IN SHARE MODE;

CREATE TABLE IF NOT EXISTS public.ranking_snapshot_create_operation_results (
  actor_id uuid NOT NULL,
  request_id text NOT NULL,
  intent_digest text NOT NULL,
  snapshot_id uuid NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT ranking_snapshot_create_operation_results_pkey
    PRIMARY KEY (actor_id, request_id),
  CONSTRAINT ranking_snapshot_create_request_id_check
    CHECK (request_id ~ '^[0-9a-f]{32}$'),
  CONSTRAINT ranking_snapshot_create_intent_digest_check
    CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ranking_snapshot_create_result_check CHECK (
    pg_catalog.jsonb_typeof(result) = 'object'
    AND result ->> 'status' = 'created'
    AND result -> 'applied' = 'true'::jsonb
    AND result ->> 'operation' = 'create_snapshot'
    AND result ->> 'actor_id' = actor_id::text
    AND result ->> 'request_id' = request_id
    AND result #>> '{snapshot,id}' = snapshot_id::text
  ),
  CONSTRAINT ranking_snapshot_create_snapshot_fkey
    FOREIGN KEY (snapshot_id)
    REFERENCES public.ranking_snapshots(id)
    ON DELETE RESTRICT
);

DO $ledger_preflight$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_invalid_columns text[];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid =
        'public.ranking_snapshot_create_operation_results'::regclass
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid =
        'public.ranking_snapshot_create_operation_results'::regclass
       OR inheritance.inhparent =
        'public.ranking_snapshot_create_operation_results'::regclass
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class =
      'public.ranking_snapshot_create_operation_results'::regclass
  ) THEN
    RAISE EXCEPTION 'ranking snapshot replay ledger must be a canonical table';
  END IF;

  SELECT pg_catalog.array_agg(required_column.column_name ORDER BY required_column.ordinality)
  INTO v_invalid_columns
  FROM (
    VALUES
      (1, 'actor_id', 'uuid'::regtype, true),
      (2, 'request_id', 'text'::regtype, true),
      (3, 'intent_digest', 'text'::regtype, true),
      (4, 'snapshot_id', 'uuid'::regtype, true),
      (5, 'result', 'jsonb'::regtype, true),
      (6, 'created_at', 'timestamptz'::regtype, true)
  ) AS required_column(ordinality, column_name, type_oid, required_not_null)
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid =
      'public.ranking_snapshot_create_operation_results'::regclass
   AND attribute.attname = required_column.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
     OR attribute.atttypid <> required_column.type_oid
     OR (required_column.required_not_null AND NOT attribute.attnotnull);

  IF v_invalid_columns IS NOT NULL OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
        'public.ranking_snapshot_create_operation_results'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attname NOT IN (
        'actor_id',
        'request_id',
        'intent_digest',
        'snapshot_id',
        'result',
        'created_at'
      )
  ) THEN
    RAISE EXCEPTION 'ranking snapshot replay ledger columns are incompatible: %',
      v_invalid_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.ranking_snapshot_create_operation_results'::regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid =
              'public.ranking_snapshot_create_operation_results'::regclass
            AND attribute.attname = 'actor_id'
        ),
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid =
              'public.ranking_snapshot_create_operation_results'::regclass
            AND attribute.attname = 'request_id'
        )
      ]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.ranking_snapshot_create_operation_results'::regclass
      AND constraint_row.conname = 'ranking_snapshot_create_snapshot_fkey'
      AND constraint_row.contype = 'f'
      AND constraint_row.convalidated
      AND constraint_row.confrelid = 'public.ranking_snapshots'::regclass
      AND constraint_row.confdeltype = 'r'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.ranking_snapshot_create_operation_results'::regclass
      AND constraint_row.conname IN (
        'ranking_snapshot_create_request_id_check',
        'ranking_snapshot_create_intent_digest_check',
        'ranking_snapshot_create_result_check'
      )
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
    GROUP BY constraint_row.conrelid
    HAVING pg_catalog.count(*) = 3
  ) THEN
    RAISE EXCEPTION 'ranking snapshot replay ledger constraints are incompatible';
  END IF;

  ALTER TABLE public.ranking_snapshot_create_operation_results OWNER TO postgres;
  IF (
    SELECT relation.relowner
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid =
      'public.ranking_snapshot_create_operation_results'::regclass
  ) IS DISTINCT FROM v_postgres_oid THEN
    RAISE EXCEPTION 'ranking snapshot replay ledger ownership did not converge';
  END IF;
END
$ledger_preflight$;

ALTER TABLE public.ranking_snapshot_create_operation_results
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ranking_snapshot_create_operation_results
  FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES
  ON TABLE public.ranking_snapshot_create_operation_results
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

DO $converge_ledger_acl$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_grantee record;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee, role_row.rolname
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = acl_entry.grantee
    WHERE relation.oid =
        'public.ranking_snapshot_create_operation_results'::regclass
      AND acl_entry.grantee <> v_postgres_oid
  LOOP
    IF v_grantee.grantee = 0 THEN
      REVOKE ALL PRIVILEGES
        ON TABLE public.ranking_snapshot_create_operation_results
        FROM PUBLIC;
    ELSIF v_grantee.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.ranking_snapshot_create_operation_results FROM %I',
        v_grantee.rolname
      );
    END IF;
  END LOOP;
END
$converge_ledger_acl$;

CREATE OR REPLACE FUNCTION public.create_ranking_snapshot_atomic(
  p_actor_id uuid,
  p_request_id text,
  p_exchange text,
  p_time_range text,
  p_traders jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_now constant timestamptz := pg_catalog.statement_timestamp();
  v_expires_at constant timestamptz :=
    pg_catalog.statement_timestamp() + pg_catalog.make_interval(days => 7);
  v_expected_keys constant text[] := ARRAY[
    'arena_score',
    'avatar_url',
    'data_availability',
    'drawdown_score',
    'followers',
    'handle',
    'max_drawdown',
    'pnl',
    'rank',
    'return_score',
    'roi',
    'source',
    'stability_score',
    'trader_id',
    'trades_count',
    'win_rate'
  ]::text[];
  v_intent_digest text;
  v_existing_digest text;
  v_existing_result jsonb;
  v_trader jsonb;
  v_trader_keys text[];
  v_rank_numeric numeric;
  v_trader_id text;
  v_handle text;
  v_source text;
  v_avatar_url text;
  v_identity text;
  v_identities text[] := ARRAY[]::text[];
  v_availability_count integer;
  v_ordinality integer;
  v_snapshot_id uuid := pg_catalog.gen_random_uuid();
  v_share_token text := pg_catalog.replace(
    pg_catalog.gen_random_uuid()::text,
    '-',
    ''
  );
  v_snapshot public.ranking_snapshots%ROWTYPE;
  v_persisted_traders jsonb;
  v_total_traders integer;
  v_top_handle text;
  v_top_roi numeric;
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  LOCK TABLE public.ranking_snapshot_create_operation_results
    IN ROW EXCLUSIVE MODE;

  IF p_actor_id IS NULL
     OR p_request_id IS NULL
     OR p_request_id !~ '^[0-9a-f]{32}$'
     OR p_exchange IS NULL
     OR pg_catalog.char_length(p_exchange) NOT BETWEEN 1 AND 64
     OR p_exchange !~ '^[a-z0-9][a-z0-9_-]{0,63}$'
     OR p_exchange IS DISTINCT FROM
       pg_catalog.lower(normalize(pg_catalog.btrim(p_exchange), NFC))
     OR p_time_range IS NULL
     OR p_time_range NOT IN ('7D', '30D', '90D')
     OR p_traders IS NULL
     OR pg_catalog.jsonb_typeof(p_traders) <> 'array'
     OR pg_catalog.jsonb_array_length(p_traders) NOT BETWEEN 1 AND 100
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  FOR v_trader, v_ordinality IN
    SELECT trader_row.value, trader_row.ordinality::integer
    FROM pg_catalog.jsonb_array_elements(p_traders)
      WITH ORDINALITY AS trader_row(value, ordinality)
    ORDER BY trader_row.ordinality
  LOOP
    IF pg_catalog.jsonb_typeof(v_trader) <> 'object' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;

    SELECT pg_catalog.array_agg(key_name ORDER BY key_name)
    INTO v_trader_keys
    FROM pg_catalog.jsonb_object_keys(v_trader) AS key_name;
    IF v_trader_keys IS DISTINCT FROM v_expected_keys THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;

    IF pg_catalog.jsonb_typeof(v_trader -> 'rank') <> 'number'
       OR pg_catalog.jsonb_typeof(v_trader -> 'trader_id') <> 'string'
       OR pg_catalog.jsonb_typeof(v_trader -> 'source') <> 'string'
       OR pg_catalog.jsonb_typeof(v_trader -> 'handle') NOT IN ('string', 'null')
       OR pg_catalog.jsonb_typeof(v_trader -> 'avatar_url') NOT IN ('string', 'null')
       OR pg_catalog.jsonb_typeof(v_trader -> 'data_availability') NOT IN ('object', 'null')
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(ARRAY[
           'roi',
           'pnl',
           'win_rate',
           'max_drawdown',
           'arena_score',
           'return_score',
           'drawdown_score',
           'stability_score'
         ]::text[]) AS metric(field_name)
         WHERE pg_catalog.jsonb_typeof(v_trader -> metric.field_name)
           NOT IN ('number', 'null')
            OR (
              pg_catalog.jsonb_typeof(v_trader -> metric.field_name) = 'number'
              AND pg_catalog.abs(
                (v_trader ->> metric.field_name)::numeric
              ) > 1000000000000::numeric
            )
       ) OR EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(ARRAY[
           'trades_count',
           'followers'
         ]::text[]) AS counter(field_name)
         WHERE pg_catalog.jsonb_typeof(v_trader -> counter.field_name)
           NOT IN ('number', 'null')
            OR (
              pg_catalog.jsonb_typeof(v_trader -> counter.field_name) = 'number'
              AND (
                (v_trader ->> counter.field_name)::numeric < 0
                OR (v_trader ->> counter.field_name)::numeric > 2147483647
                OR (v_trader ->> counter.field_name)::numeric IS DISTINCT FROM
                  pg_catalog.trunc((v_trader ->> counter.field_name)::numeric)
              )
            )
       )
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;

    v_rank_numeric := (v_trader ->> 'rank')::numeric;
    v_trader_id := v_trader ->> 'trader_id';
    v_handle := v_trader ->> 'handle';
    v_source := v_trader ->> 'source';
    v_avatar_url := v_trader ->> 'avatar_url';

    IF v_rank_numeric IS DISTINCT FROM v_ordinality::numeric
       OR v_rank_numeric IS DISTINCT FROM pg_catalog.trunc(v_rank_numeric)
       OR v_rank_numeric NOT BETWEEN 1 AND 100
       OR pg_catalog.char_length(v_trader_id) NOT BETWEEN 1 AND 500
       OR v_trader_id IS DISTINCT FROM
         normalize(pg_catalog.btrim(v_trader_id), NFC)
       OR v_trader_id ~ '[[:cntrl:]]'
       OR pg_catalog.char_length(v_source) NOT BETWEEN 1 AND 100
       OR v_source !~ '^[a-z0-9][a-z0-9_-]{0,99}$'
       OR v_source IS DISTINCT FROM
         pg_catalog.lower(normalize(pg_catalog.btrim(v_source), NFC))
       OR (
         v_handle IS NOT NULL
         AND (
           pg_catalog.char_length(v_handle) NOT BETWEEN 1 AND 300
           OR v_handle IS DISTINCT FROM
             normalize(pg_catalog.btrim(v_handle), NFC)
           OR v_handle ~ '[[:cntrl:]]'
         )
       ) OR (
         v_avatar_url IS NOT NULL
         AND (
           pg_catalog.char_length(v_avatar_url) NOT BETWEEN 1 AND 2048
           OR v_avatar_url IS DISTINCT FROM
             normalize(pg_catalog.btrim(v_avatar_url), NFC)
           OR v_avatar_url !~* '^https?://[^[:space:][:cntrl:]]+$'
         )
       ) OR (
         v_ordinality = 1
         AND (
           v_handle IS NULL
           OR pg_catalog.jsonb_typeof(v_trader -> 'roi') <> 'number'
         )
       )
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;

    IF pg_catalog.jsonb_typeof(v_trader -> 'data_availability') = 'object' THEN
      SELECT pg_catalog.count(*)::integer
      INTO v_availability_count
      FROM pg_catalog.jsonb_each(v_trader -> 'data_availability') AS availability;

      IF v_availability_count > 64 OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_each(v_trader -> 'data_availability')
          AS availability(key_name, field_value)
        WHERE availability.key_name !~ '^[A-Za-z0-9_.:-]{1,64}$'
           OR pg_catalog.jsonb_typeof(availability.field_value) <> 'boolean'
      ) THEN
        RETURN pg_catalog.jsonb_build_object('status', 'invalid');
      END IF;
    END IF;

    v_identity := pg_catalog.jsonb_build_array(v_source, v_trader_id)::text;
    IF v_identity = ANY(v_identities) THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;
    v_identities := pg_catalog.array_append(v_identities, v_identity);
  END LOOP;

  v_intent_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
      'ranking-snapshot-create:v1',
      p_exchange,
      p_time_range,
      p_traders
    )::text, 'UTF8')),
    'hex'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'ranking-snapshot-create:' || p_actor_id::text || ':' || p_request_id,
      0
    )
  );

  SELECT ledger.intent_digest, ledger.result
  INTO v_existing_digest, v_existing_result
  FROM public.ranking_snapshot_create_operation_results AS ledger
  WHERE ledger.actor_id = p_actor_id
    AND ledger.request_id = p_request_id;

  IF FOUND THEN
    IF v_existing_digest IS NOT DISTINCT FROM v_intent_digest THEN
      RETURN pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(
          v_existing_result,
          '{status}',
          pg_catalog.to_jsonb('replayed'::text),
          false
        ),
        '{applied}',
        'false'::jsonb,
        false
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'request_conflict');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_actor_id::text,
      0
    )
  );

  PERFORM auth_user.id
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_actor_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  -- Keep the parent private until every child row and the authoritative
  -- persisted aggregate have been verified inside this same transaction.
  INSERT INTO public.ranking_snapshots (
    id,
    created_by,
    share_token,
    time_range,
    exchange,
    total_traders,
    top_trader_handle,
    top_trader_roi,
    data_captured_at,
    is_public,
    view_count,
    expires_at,
    is_expired
  ) VALUES (
    v_snapshot_id,
    p_actor_id,
    v_share_token,
    p_time_range,
    p_exchange,
    0,
    NULL,
    NULL,
    v_now,
    false,
    0,
    v_expires_at,
    false
  )
  RETURNING * INTO v_snapshot;

  INSERT INTO public.snapshot_traders (
    snapshot_id,
    rank,
    trader_id,
    handle,
    source,
    avatar_url,
    roi,
    pnl,
    win_rate,
    max_drawdown,
    trades_count,
    followers,
    arena_score,
    return_score,
    drawdown_score,
    stability_score,
    data_availability
  )
  SELECT
    v_snapshot_id,
    (trader_row.value ->> 'rank')::integer,
    trader_row.value ->> 'trader_id',
    trader_row.value ->> 'handle',
    trader_row.value ->> 'source',
    trader_row.value ->> 'avatar_url',
    (trader_row.value ->> 'roi')::numeric,
    (trader_row.value ->> 'pnl')::numeric,
    (trader_row.value ->> 'win_rate')::numeric,
    (trader_row.value ->> 'max_drawdown')::numeric,
    (trader_row.value ->> 'trades_count')::integer,
    (trader_row.value ->> 'followers')::integer,
    (trader_row.value ->> 'arena_score')::numeric,
    (trader_row.value ->> 'return_score')::numeric,
    (trader_row.value ->> 'drawdown_score')::numeric,
    (trader_row.value ->> 'stability_score')::numeric,
    CASE
      WHEN pg_catalog.jsonb_typeof(
        trader_row.value -> 'data_availability'
      ) = 'null' THEN NULL
      ELSE trader_row.value -> 'data_availability'
    END
  FROM pg_catalog.jsonb_array_elements(p_traders)
    WITH ORDINALITY AS trader_row(value, ordinality)
  ORDER BY trader_row.ordinality;

  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'rank', persisted.rank,
      'trader_id', persisted.trader_id,
      'handle', persisted.handle,
      'source', persisted.source,
      'avatar_url', persisted.avatar_url,
      'roi', persisted.roi,
      'pnl', persisted.pnl,
      'win_rate', persisted.win_rate,
      'max_drawdown', persisted.max_drawdown,
      'trades_count', persisted.trades_count,
      'followers', persisted.followers,
      'arena_score', persisted.arena_score,
      'return_score', persisted.return_score,
      'drawdown_score', persisted.drawdown_score,
      'stability_score', persisted.stability_score,
      'data_availability', persisted.data_availability
    )
    ORDER BY persisted.rank
  )
  INTO v_persisted_traders
  FROM public.snapshot_traders AS persisted
  WHERE persisted.snapshot_id = v_snapshot_id;

  SELECT pg_catalog.count(*)::integer
  INTO v_total_traders
  FROM public.snapshot_traders AS persisted
  WHERE persisted.snapshot_id = v_snapshot_id;

  SELECT persisted.handle, persisted.roi
  INTO v_top_handle, v_top_roi
  FROM public.snapshot_traders AS persisted
  WHERE persisted.snapshot_id = v_snapshot_id
  ORDER BY persisted.rank
  LIMIT 1;

  IF v_persisted_traders IS DISTINCT FROM p_traders
     OR v_total_traders IS DISTINCT FROM pg_catalog.jsonb_array_length(p_traders)
     OR v_top_handle IS DISTINCT FROM (p_traders -> 0 ->> 'handle')
     OR v_top_roi IS DISTINCT FROM (p_traders -> 0 ->> 'roi')::numeric
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'persisted ranking snapshot traders disagree with intent';
  END IF;

  UPDATE public.ranking_snapshots AS target
  SET total_traders = v_total_traders,
      top_trader_handle = v_top_handle,
      top_trader_roi = v_top_roi,
      is_public = true
  WHERE target.id = v_snapshot_id
    AND target.created_by = p_actor_id
    AND target.is_public IS DISTINCT FROM true
  RETURNING target.* INTO v_snapshot;

  IF NOT FOUND
     OR v_snapshot.created_by IS DISTINCT FROM p_actor_id
     OR v_snapshot.share_token IS DISTINCT FROM v_share_token
     OR v_snapshot.time_range IS DISTINCT FROM p_time_range
     OR v_snapshot.exchange IS DISTINCT FROM p_exchange
     OR v_snapshot.total_traders IS DISTINCT FROM v_total_traders
     OR v_snapshot.top_trader_handle IS DISTINCT FROM v_top_handle
     OR v_snapshot.top_trader_roi IS DISTINCT FROM v_top_roi
     OR v_snapshot.data_captured_at IS DISTINCT FROM v_now
     OR v_snapshot.expires_at IS DISTINCT FROM v_expires_at
     OR v_snapshot.is_public IS DISTINCT FROM true
     OR v_snapshot.is_expired IS DISTINCT FROM false
     OR v_snapshot.view_count IS DISTINCT FROM 0
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'published ranking snapshot disagrees with authoritative rows';
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'status', 'created',
    'applied', true,
    'operation', 'create_snapshot',
    'actor_id', p_actor_id,
    'request_id', p_request_id,
    'snapshot', pg_catalog.jsonb_build_object(
      'id', v_snapshot.id,
      'share_token', v_snapshot.share_token,
      'created_by', v_snapshot.created_by,
      'exchange', v_snapshot.exchange,
      'time_range', v_snapshot.time_range,
      'total_traders', v_snapshot.total_traders,
      'top_trader_handle', v_snapshot.top_trader_handle,
      'top_trader_roi', v_snapshot.top_trader_roi,
      'data_captured_at', v_snapshot.data_captured_at,
      'expires_at', v_snapshot.expires_at
    )
  );

  INSERT INTO public.ranking_snapshot_create_operation_results (
    actor_id,
    request_id,
    intent_digest,
    snapshot_id,
    result
  ) VALUES (
    p_actor_id,
    p_request_id,
    v_intent_digest,
    v_snapshot.id,
    v_result
  );

  RETURN v_result;
END
$function$;

ALTER FUNCTION public.create_ranking_snapshot_atomic(
  uuid, text, text, text, jsonb
) OWNER TO postgres;

REVOKE ALL PRIVILEGES
  ON FUNCTION public.create_ranking_snapshot_atomic(
    uuid, text, text, text, jsonb
  )
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE
  ON FUNCTION public.create_ranking_snapshot_atomic(
    uuid, text, text, text, jsonb
  )
  TO service_role;

DO $converge_function_acl$
DECLARE
  v_function regprocedure := pg_catalog.to_regprocedure(
    'public.create_ranking_snapshot_atomic(uuid,text,text,text,jsonb)'
  );
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_grantee record;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee, role_row.rolname
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = acl_entry.grantee
    WHERE function_row.oid = v_function
      AND acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
  LOOP
    IF v_grantee.grantee = 0 THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC',
        v_function
      );
    ELSIF v_grantee.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I',
        v_function,
        v_grantee.rolname
      );
    END IF;
  END LOOP;
END
$converge_function_acl$;

-- Browser policies historically admitted direct parent/child writes. Remove
-- table and column DML authority while preserving public snapshot reads.
REVOKE INSERT, UPDATE, DELETE
  ON TABLE public.ranking_snapshots, public.snapshot_traders
  FROM PUBLIC, anon, authenticated, authenticator;

DO $revoke_browser_column_dml$
DECLARE
  v_role text;
  v_relation text;
  v_column record;
  v_grantee text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY[
    'PUBLIC',
    'anon',
    'authenticated',
    'authenticator'
  ]::text[]
  LOOP
    v_grantee := CASE
      WHEN v_role = 'PUBLIC' THEN 'PUBLIC'
      ELSE pg_catalog.quote_ident(v_role)
    END;

    FOREACH v_relation IN ARRAY ARRAY[
      'ranking_snapshots',
      'snapshot_traders'
    ]::text[]
    LOOP
      FOR v_column IN
        SELECT attribute.attname
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = pg_catalog.to_regclass(
          pg_catalog.format('public.%I', v_relation)
        )
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      LOOP
        EXECUTE pg_catalog.format(
          'REVOKE INSERT (%I), UPDATE (%I) ON TABLE public.%I FROM %s',
          v_column.attname,
          v_column.attname,
          v_relation,
          v_grantee
        );
      END LOOP;
    END LOOP;
  END LOOP;
END
$revoke_browser_column_dml$;

DO $attest_function$
DECLARE
  v_function regprocedure := pg_catalog.to_regprocedure(
    'public.create_ranking_snapshot_atomic(uuid,text,text,text,jsonb)'
  );
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-ranking-snapshot-create:v1:' || pg_catalog.md5(v_source)
  );
END
$attest_function$;

COMMENT ON TABLE public.ranking_snapshot_create_operation_results IS
  'Private actor/request replay ledger for atomic public ranking snapshot creation.';

DO $postflight$
DECLARE
  v_function regprocedure := pg_catalog.to_regprocedure(
    'public.create_ranking_snapshot_atomic(uuid,text,text,text,jsonb)'
  );
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_source text;
  v_comment text;
  v_parent_insert integer;
  v_child_insert integer;
  v_authoritative_read integer;
  v_publish integer;
  v_ledger_insert integer;
  v_role text;
  v_relation text;
  v_column record;
BEGIN
  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'jsonb'::regtype
    AND NOT function_row.proretset
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.pronargs = 5
    AND function_row.pronargdefaults = 0
    AND function_row.proargnames = ARRAY[
      'p_actor_id',
      'p_request_id',
      'p_exchange',
      'p_time_range',
      'p_traders'
    ]::text[]
    AND pg_catalog.cardinality(function_row.proconfig) = 4
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off',
      'lock_timeout=5s',
      'statement_timeout=15s'
    ]::text[];

  v_parent_insert := pg_catalog.strpos(
    v_source,
    'INSERT INTO public.ranking_snapshots'
  );
  v_child_insert := pg_catalog.strpos(
    v_source,
    'INSERT INTO public.snapshot_traders'
  );
  v_authoritative_read := pg_catalog.strpos(
    v_source,
    'INTO v_persisted_traders'
  );
  v_publish := pg_catalog.strpos(
    v_source,
    'UPDATE public.ranking_snapshots AS target'
  );
  v_ledger_insert := pg_catalog.strpos(
    v_source,
    'INSERT INTO public.ranking_snapshot_create_operation_results'
  );

  IF v_comment IS DISTINCT FROM
       'atomic-ranking-snapshot-create:v1:' || pg_catalog.md5(v_source)
     OR pg_catalog.strpos(v_source, 'p_actor_id::text || '':'' || p_request_id') = 0
     OR pg_catalog.strpos(v_source, '''ranking-snapshot-create:v1''') = 0
     OR v_parent_insert = 0
     OR v_child_insert <= v_parent_insert
     OR v_authoritative_read <= v_child_insert
     OR v_publish <= v_authoritative_read
     OR v_ledger_insert <= v_publish
     OR NOT pg_catalog.has_function_privilege(
       v_service_oid,
       v_function,
       'EXECUTE'
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid = v_function
         AND acl_entry.privilege_type = 'EXECUTE'
         AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
     )
  THEN
    RAISE EXCEPTION 'atomic ranking snapshot authority postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid =
        'public.ranking_snapshot_create_operation_results'::regclass
      AND relation.relowner = v_postgres_oid
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid =
      'public.ranking_snapshot_create_operation_results'::regclass
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid =
        'public.ranking_snapshot_create_operation_results'::regclass
      AND acl_entry.grantee <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION 'ranking snapshot replay ledger privacy postflight failed';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'anon',
    'authenticated',
    'authenticator'
  ]::text[]
  LOOP
    FOREACH v_relation IN ARRAY ARRAY[
      'ranking_snapshots',
      'snapshot_traders'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(
        v_role,
        pg_catalog.format('public.%I', v_relation),
        'INSERT'
      ) OR pg_catalog.has_table_privilege(
        v_role,
        pg_catalog.format('public.%I', v_relation),
        'UPDATE'
      ) OR pg_catalog.has_table_privilege(
        v_role,
        pg_catalog.format('public.%I', v_relation),
        'DELETE'
      ) THEN
        RAISE EXCEPTION 'browser ranking snapshot table DML remains for %.%',
          v_role,
          v_relation;
      END IF;

      FOR v_column IN
        SELECT attribute.attname
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = pg_catalog.to_regclass(
          pg_catalog.format('public.%I', v_relation)
        )
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      LOOP
        IF pg_catalog.has_column_privilege(
          v_role,
          pg_catalog.format('public.%I', v_relation),
          v_column.attname,
          'INSERT'
        ) OR pg_catalog.has_column_privilege(
          v_role,
          pg_catalog.format('public.%I', v_relation),
          v_column.attname,
          'UPDATE'
        ) THEN
          RAISE EXCEPTION 'browser ranking snapshot column DML remains for %.%.%',
            v_role,
            v_relation,
            v_column.attname;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
