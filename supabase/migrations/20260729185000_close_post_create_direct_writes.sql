-- Migration: 20260729185000_close_post_create_direct_writes.sql
-- Created: 2026-07-30T01:50:00Z
-- Description: Postdeploy cutover for post creation. All post, custom-poll,
--   and hashtag writes now cross the service-only atomic creation authority.
--   Historical post/poll relationships are inspected but never guessed or
--   repaired; any ambiguity aborts this migration atomically.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.posts:close-create-direct-writes:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'post create direct-write closure migration lock is busy';
  END IF;
END
$migration_lock$;

DO $relation_preflight$
DECLARE
  v_missing_roles text[];
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
    RAISE EXCEPTION 'post create closure roles are missing: %',
      v_missing_roles;
  END IF;

  IF pg_catalog.to_regclass('public.posts') IS NULL
     OR pg_catalog.to_regclass('public.polls') IS NULL
     OR pg_catalog.to_regclass('public.hashtags') IS NULL
     OR pg_catalog.to_regclass('public.post_hashtags') IS NULL
     OR pg_catalog.to_regclass(
       'public.post_create_operation_results'
     ) IS NULL
  THEN
    RAISE EXCEPTION 'atomic post create relations must deploy first';
  END IF;
END
$relation_preflight$;

-- SHARE prevents a legacy browser write or an in-flight creation authority
-- from changing the rows between the read-only probes and constraint install.
LOCK TABLE public.posts,
  public.polls,
  public.hashtags,
  public.post_hashtags,
  public.post_create_operation_results
  IN SHARE MODE;

DO $authority_preflight$
DECLARE
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
  v_create_function regprocedure := pg_catalog.to_regprocedure(
    'public.create_post_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[])'
  );
  v_update_guard regprocedure := pg_catalog.to_regprocedure(
    'public.guard_authenticated_post_update_boundary()'
  );
  v_recount_function regprocedure := pg_catalog.to_regprocedure(
    'public.recount_hashtag_posts(uuid[])'
  );
  v_existing_poll_index oid := pg_catalog.to_regclass(
    'public.polls_one_custom_per_post_idx'
  );
  v_invalid_columns text[];
  v_create_source text;
  v_create_comment text;
  v_guard_source text;
  v_guard_comment text;
  v_recount_source text;
  v_recount_config text[];
  v_legacy_recount_source constant text := $legacy_recount$
    UPDATE hashtags h
    SET post_count = COALESCE(sub.cnt, 0)
    FROM (
      SELECT hashtag_id, count(*)::int AS cnt
      FROM post_hashtags
      WHERE hashtag_id = ANY(hashtag_ids)
      GROUP BY hashtag_id
    ) sub
    WHERE h.id = sub.hashtag_id;
  $legacy_recount$;
  v_canonical_recount_source constant text := $canonical_recount$
    UPDATE public.hashtags AS hashtag
    SET post_count = COALESCE((
      SELECT pg_catalog.count(*)::integer
      FROM public.post_hashtags AS post_hashtag
      WHERE post_hashtag.hashtag_id = hashtag.id
    ), 0)
    WHERE hashtag.id = ANY(hashtag_ids);
  $canonical_recount$;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.posts'::regclass,
      'public.polls'::regclass,
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass,
      'public.post_create_operation_results'::regclass
    )
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
        OR relation.relowner <> v_postgres_oid
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'public.posts'::regclass,
      'public.polls'::regclass,
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass,
      'public.post_create_operation_results'::regclass
    )
       OR inheritance.inhparent IN (
         'public.posts'::regclass,
         'public.polls'::regclass,
         'public.hashtags'::regclass,
         'public.post_hashtags'::regclass,
         'public.post_create_operation_results'::regclass
       )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'public.posts'::regclass,
      'public.polls'::regclass,
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass,
      'public.post_create_operation_results'::regclass
    )
  ) THEN
    RAISE EXCEPTION
      'post create closure requires canonical postgres-owned permanent tables';
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
    ORDER BY required_column.relation_name, required_column.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      ('public', 'posts', 1, 'id', 'uuid'::regtype, true),
      ('public', 'posts', 2, 'poll_id', 'uuid'::regtype, false),
      ('public', 'posts', 3, 'poll_enabled', 'boolean'::regtype, false),
      ('public', 'polls', 1, 'id', 'uuid'::regtype, true),
      ('public', 'polls', 2, 'post_id', 'uuid'::regtype, false),
      ('public', 'hashtags', 1, 'id', 'uuid'::regtype, true),
      ('public', 'hashtags', 2, 'post_count', 'integer'::regtype, false),
      ('public', 'post_hashtags', 1, 'post_id', 'uuid'::regtype, true),
      ('public', 'post_hashtags', 2, 'hashtag_id', 'uuid'::regtype, true),
      ('public', 'post_create_operation_results', 1,
        'operation_id', 'uuid'::regtype, true),
      ('public', 'post_create_operation_results', 2,
        'actor_id', 'uuid'::regtype, true),
      ('public', 'post_create_operation_results', 3,
        'intent_fingerprint', 'text'::regtype, true),
      ('public', 'post_create_operation_results', 4,
        'result', 'jsonb'::regtype, true),
      ('public', 'post_create_operation_results', 5,
        'created_at', 'timestamptz'::regtype, true)
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
    RAISE EXCEPTION 'post create closure has incompatible columns: %',
      v_invalid_columns;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
        'public.post_create_operation_results'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attname NOT IN (
        'operation_id',
        'actor_id',
        'intent_fingerprint',
        'result',
        'created_at'
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.post_create_operation_results'::regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid =
            'public.post_create_operation_results'::regclass
          AND attribute.attname = 'operation_id'
      )]::smallint[]
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.post_create_operation_results'::regclass
      AND constraint_row.contype = 'f'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.post_create_operation_results'::regclass
      AND constraint_row.conname = 'post_create_operation_fingerprint_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.post_create_operation_results'::regclass
      AND constraint_row.conname = 'post_create_operation_result_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.post_create_operation_results'::regclass
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = 'public.post_create_operation_results'::regclass
      AND acl_entry.grantee <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION 'post create replay ledger authority is incompatible';
  END IF;

  IF v_create_function IS NULL OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'create_post_atomic'
      AND function_row.oid <> v_create_function::oid
  ) THEN
    RAISE EXCEPTION 'canonical atomic post create signature is missing';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_create_source, v_create_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_create_function
    AND function_row.prokind = 'f'
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'jsonb'::regtype
    AND NOT function_row.proretset
    AND pg_catalog.cardinality(function_row.proconfig) = 4
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off',
      'lock_timeout=5s',
      'statement_timeout=15s'
    ];

  IF v_create_comment IS DISTINCT FROM
       'atomic-post-create:v1:' || pg_catalog.md5(v_create_source)
     OR pg_catalog.strpos(v_create_source, 'post-create-operation:') = 0
     OR pg_catalog.strpos(
       v_create_source,
       'INSERT INTO public.post_create_operation_results'
     ) = 0
     OR NOT pg_catalog.has_function_privilege(
       v_service_oid,
       v_create_function,
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid = v_create_function
         AND acl_entry.privilege_type = 'EXECUTE'
         AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
     )
  THEN
    RAISE EXCEPTION 'atomic post create authority is incompatible';
  END IF;

  IF v_update_guard IS NULL THEN
    RAISE EXCEPTION 'authenticated post update boundary must deploy first';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_guard_source, v_guard_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_update_guard
    AND function_row.prokind = 'f'
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'trigger'::regtype
    AND pg_catalog.cardinality(function_row.proconfig) = 2
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off'
    ];

  IF v_guard_comment IS DISTINCT FROM
       'authenticated-post-update-boundary:v1:' ||
         pg_catalog.md5(v_guard_source)
     OR pg_catalog.strpos(
       v_guard_source,
       'pg_catalog.to_jsonb(NEW) - ''poll_id'''
     ) = 0
     OR pg_catalog.strpos(
       v_guard_source,
       'poll_row.post_id = OLD.id'
     ) = 0
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid = v_update_guard
         AND acl_entry.privilege_type = 'EXECUTE'
         AND acl_entry.grantee <> v_postgres_oid
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.posts'::regclass
         AND trigger_row.tgname =
           'trg_posts_05_authenticated_update_boundary'
         AND trigger_row.tgfoid = v_update_guard
         AND trigger_row.tgenabled = 'O'
         AND NOT trigger_row.tgisinternal
     )
  THEN
    RAISE EXCEPTION 'authenticated post update boundary is incompatible';
  END IF;

  IF v_recount_function IS NULL OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'recount_hashtag_posts'
      AND function_row.oid <> v_recount_function::oid
  ) THEN
    RAISE EXCEPTION 'canonical hashtag recount signature is missing';
  END IF;

  SELECT function_row.prosrc,
         function_row.proconfig
  INTO STRICT v_recount_source, v_recount_config
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_recount_function
    AND function_row.prokind = 'f'
    AND function_row.prolang = (
      SELECT language_row.oid
      FROM pg_catalog.pg_language AS language_row
      WHERE language_row.lanname = 'sql'
    )
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'void'::regtype
    AND NOT function_row.proretset
    AND function_row.pronargs = 1
    AND function_row.proargtypes =
      pg_catalog.array_to_string(ARRAY['uuid[]'::regtype::oid], ' ')::oidvector
    AND function_row.proargnames = ARRAY['hashtag_ids']::text[];

  IF (
       pg_catalog.regexp_replace(
         pg_catalog.btrim(v_recount_source),
         '[[:space:]]+',
         ' ',
         'g'
       ) IS DISTINCT FROM pg_catalog.regexp_replace(
         pg_catalog.btrim(v_legacy_recount_source),
         '[[:space:]]+',
         ' ',
         'g'
       )
       AND pg_catalog.regexp_replace(
         pg_catalog.btrim(v_recount_source),
         '[[:space:]]+',
         ' ',
         'g'
       ) IS DISTINCT FROM pg_catalog.regexp_replace(
         pg_catalog.btrim(v_canonical_recount_source),
         '[[:space:]]+',
         ' ',
         'g'
       )
     )
     OR NOT (
       v_recount_config = ARRAY['search_path=public']::text[]
       OR (
         pg_catalog.cardinality(v_recount_config) = 2
         AND v_recount_config @> ARRAY[
           'search_path=pg_catalog, pg_temp',
           'row_security=off'
         ]
       )
     )
  THEN
    RAISE EXCEPTION 'hashtag recount authority is incompatible';
  END IF;

  IF v_existing_poll_index IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS index_relation
       JOIN pg_catalog.pg_index AS index_row
         ON index_row.indexrelid = index_relation.oid
       WHERE index_relation.oid = v_existing_poll_index
         AND index_relation.relkind = 'i'
         AND index_relation.relpersistence = 'p'
         AND index_relation.relowner = v_postgres_oid
         AND index_row.indrelid = 'public.polls'::regclass
         AND index_row.indisunique
         AND index_row.indisvalid
         AND index_row.indisready
         AND index_row.indislive
         AND index_row.indnkeyatts = 1
         AND index_row.indnatts = 1
         AND index_row.indkey = (
           SELECT attribute.attnum::text::int2vector
           FROM pg_catalog.pg_attribute AS attribute
           WHERE attribute.attrelid = 'public.polls'::regclass
             AND attribute.attname = 'post_id'
         )
         AND pg_catalog.pg_get_expr(
           index_row.indpred,
           index_row.indrelid,
           false
         ) = '(post_id IS NOT NULL)'
     )
  THEN
    RAISE EXCEPTION 'existing custom poll uniqueness index is incompatible';
  END IF;
END
$authority_preflight$;

-- Historical integrity probes are deliberately read-only. A duplicate or
-- ambiguous relationship requires an operator-reviewed repair migration.
DO $historical_integrity_probe$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.polls AS poll_row
    WHERE poll_row.post_id IS NOT NULL
    GROUP BY poll_row.post_id
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'duplicate custom polls exist for one post';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.posts AS post_row
    LEFT JOIN public.polls AS poll_row
      ON poll_row.id = post_row.poll_id
    WHERE post_row.poll_id IS NOT NULL
      AND poll_row.post_id IS DISTINCT FROM post_row.id
  ) OR EXISTS (
    SELECT 1
    FROM public.polls AS poll_row
    LEFT JOIN public.posts AS post_row
      ON post_row.id = poll_row.post_id
    WHERE poll_row.post_id IS NOT NULL
      AND post_row.poll_id IS DISTINCT FROM poll_row.id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'post and custom poll links are not bidirectionally consistent';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.posts AS post_row
    WHERE post_row.poll_id IS NOT NULL
      AND post_row.poll_enabled IS DISTINCT FROM true
  ) OR EXISTS (
    SELECT 1
    FROM public.polls AS poll_row
    JOIN public.posts AS post_row
      ON post_row.id = poll_row.post_id
    WHERE poll_row.post_id IS NOT NULL
      AND post_row.poll_enabled IS DISTINCT FROM true
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'custom poll exists for a post that is not poll-enabled';
  END IF;
END
$historical_integrity_probe$;

CREATE UNIQUE INDEX IF NOT EXISTS polls_one_custom_per_post_idx
  ON public.polls (post_id)
  WHERE post_id IS NOT NULL;
ALTER INDEX public.polls_one_custom_per_post_idx OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.enforce_post_poll_bidirectional_integrity()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_post_ids uuid[] := ARRAY[]::uuid[];
  v_poll_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
     OR TG_TABLE_NAME NOT IN ('posts', 'polls')
     OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'post/poll integrity authority is misattached';
  END IF;

  IF TG_TABLE_NAME = 'posts' THEN
    IF TG_OP <> 'INSERT' THEN
      v_post_ids := pg_catalog.array_append(v_post_ids, OLD.id);
      v_poll_ids := pg_catalog.array_append(v_poll_ids, OLD.poll_id);
    END IF;
    IF TG_OP <> 'DELETE' THEN
      v_post_ids := pg_catalog.array_append(v_post_ids, NEW.id);
      v_poll_ids := pg_catalog.array_append(v_poll_ids, NEW.poll_id);
    END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN
      v_post_ids := pg_catalog.array_append(v_post_ids, OLD.post_id);
      v_poll_ids := pg_catalog.array_append(v_poll_ids, OLD.id);
    END IF;
    IF TG_OP <> 'DELETE' THEN
      v_post_ids := pg_catalog.array_append(v_post_ids, NEW.post_id);
      v_poll_ids := pg_catalog.array_append(v_poll_ids, NEW.id);
    END IF;
  END IF;

  v_post_ids := pg_catalog.array_remove(v_post_ids, NULL);
  v_poll_ids := pg_catalog.array_remove(v_poll_ids, NULL);

  IF EXISTS (
    SELECT 1
    FROM public.posts AS post_row
    LEFT JOIN public.polls AS poll_row
      ON poll_row.id = post_row.poll_id
    WHERE (
      post_row.id = ANY(v_post_ids)
      OR post_row.poll_id = ANY(v_poll_ids)
    )
      AND post_row.poll_id IS NOT NULL
      AND (
        post_row.poll_enabled IS DISTINCT FROM true
        OR poll_row.post_id IS DISTINCT FROM post_row.id
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.polls AS poll_row
    LEFT JOIN public.posts AS post_row
      ON post_row.id = poll_row.post_id
    WHERE (
      poll_row.id = ANY(v_poll_ids)
      OR poll_row.post_id = ANY(v_post_ids)
    )
      AND poll_row.post_id IS NOT NULL
      AND (
        post_row.poll_enabled IS DISTINCT FROM true
        OR post_row.poll_id IS DISTINCT FROM poll_row.id
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'post and custom poll must be bidirectionally consistent';
  END IF;

  RETURN NULL;
END
$function$;

ALTER FUNCTION public.enforce_post_poll_bidirectional_integrity()
  OWNER TO postgres;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.enforce_post_poll_bidirectional_integrity()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

DO $attest_integrity_function$
DECLARE
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.enforce_post_poll_bidirectional_integrity()'::regprocedure;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION public.enforce_post_poll_bidirectional_integrity() IS %L',
    'post-poll-bidirectional-integrity:v1:' || pg_catalog.md5(v_source)
  );
END
$attest_integrity_function$;

DROP TRIGGER IF EXISTS trg_posts_90_poll_bidirectional_integrity
  ON public.posts;
CREATE CONSTRAINT TRIGGER trg_posts_90_poll_bidirectional_integrity
AFTER INSERT OR UPDATE OR DELETE ON public.posts
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.enforce_post_poll_bidirectional_integrity();

DROP TRIGGER IF EXISTS trg_polls_90_post_bidirectional_integrity
  ON public.polls;
CREATE CONSTRAINT TRIGGER trg_polls_90_post_bidirectional_integrity
AFTER INSERT OR UPDATE OR DELETE ON public.polls
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.enforce_post_poll_bidirectional_integrity();

CREATE OR REPLACE FUNCTION public.recount_hashtag_posts(hashtag_ids uuid[])
RETURNS void
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  UPDATE public.hashtags AS hashtag
  SET post_count = COALESCE((
    SELECT pg_catalog.count(*)::integer
    FROM public.post_hashtags AS post_hashtag
    WHERE post_hashtag.hashtag_id = hashtag.id
  ), 0)
  WHERE hashtag.id = ANY(hashtag_ids);
$function$;

ALTER FUNCTION public.recount_hashtag_posts(uuid[]) OWNER TO postgres;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.recount_hashtag_posts(uuid[])
  FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE
  ON FUNCTION public.recount_hashtag_posts(uuid[])
  TO service_role;

DO $attest_recount_function$
DECLARE
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.recount_hashtag_posts(uuid[])'::regprocedure;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION public.recount_hashtag_posts(uuid[]) IS %L',
    'recount-hashtag-posts:v2:' || pg_catalog.md5(v_source)
  );
END
$attest_recount_function$;

-- Reassert the service-only creation boundary even if a browser grant was
-- added between the predeploy and postdeploy phases.
REVOKE ALL PRIVILEGES ON FUNCTION public.create_post_atomic(
  uuid, uuid, text, text, uuid, text[], boolean, text[], text, integer,
  text, boolean, text, text, text[], text[]
) FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION public.create_post_atomic(
  uuid, uuid, text, text, uuid, text[], boolean, text[], text, integer,
  text, boolean, text, text, text[], text[]
) TO service_role;

REVOKE INSERT, UPDATE, DELETE
  ON TABLE public.posts,
    public.polls,
    public.hashtags,
    public.post_hashtags
  FROM PUBLIC, anon, authenticated, authenticator;

-- Table-level REVOKE does not clear historical column grants.
DO $revoke_browser_column_dml$
DECLARE
  v_role text;
  v_relation record;
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

    FOR v_relation IN
      SELECT relation.schema_name, relation.relation_name
      FROM (
        VALUES
          ('public', 'posts'),
          ('public', 'polls'),
          ('public', 'hashtags'),
          ('public', 'post_hashtags')
      ) AS relation(schema_name, relation_name)
    LOOP
      FOR v_column IN
        SELECT attribute.attname
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = pg_catalog.to_regclass(
          pg_catalog.format(
            '%I.%I',
            v_relation.schema_name,
            v_relation.relation_name
          )
        )
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
        ORDER BY attribute.attnum
      LOOP
        EXECUTE pg_catalog.format(
          'REVOKE INSERT (%I), UPDATE (%I) ON TABLE %I.%I FROM %s',
          v_column.attname,
          v_column.attname,
          v_relation.schema_name,
          v_relation.relation_name,
          v_grantee
        );
      END LOOP;
    END LOOP;
  END LOOP;
END
$revoke_browser_column_dml$;

DO $postflight$
DECLARE
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
  v_create_function regprocedure :=
    'public.create_post_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[])'::regprocedure;
  v_integrity_function regprocedure :=
    'public.enforce_post_poll_bidirectional_integrity()'::regprocedure;
  v_recount_function regprocedure :=
    'public.recount_hashtag_posts(uuid[])'::regprocedure;
  v_source text;
  v_comment text;
  v_role text;
  v_relation record;
  v_column record;
BEGIN
  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_integrity_function
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'trigger'::regtype
    AND pg_catalog.cardinality(function_row.proconfig) = 2
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off'
    ];

  IF v_comment IS DISTINCT FROM
       'post-poll-bidirectional-integrity:v1:' || pg_catalog.md5(v_source)
     OR pg_catalog.strpos(v_source, 'post_row.poll_id = ANY(v_poll_ids)') = 0
     OR pg_catalog.strpos(v_source, 'poll_row.post_id = ANY(v_post_ids)') = 0
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid = v_integrity_function
         AND acl_entry.privilege_type = 'EXECUTE'
         AND acl_entry.grantee <> v_postgres_oid
     )
  THEN
    RAISE EXCEPTION 'post/poll integrity authority postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.posts'::regclass
      AND trigger_row.tgname = 'trg_posts_90_poll_bidirectional_integrity'
      AND trigger_row.tgfoid = v_integrity_function
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgdeferrable
      AND trigger_row.tginitdeferred
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.polls'::regclass
      AND trigger_row.tgname = 'trg_polls_90_post_bidirectional_integrity'
      AND trigger_row.tgfoid = v_integrity_function
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgdeferrable
      AND trigger_row.tginitdeferred
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'post/poll constraint triggers are incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indexrelid =
        'public.polls_one_custom_per_post_idx'::regclass
      AND index_row.indrelid = 'public.polls'::regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indislive
      AND pg_catalog.pg_get_expr(
        index_row.indpred,
        index_row.indrelid,
        false
      ) = '(post_id IS NOT NULL)'
  ) THEN
    RAISE EXCEPTION 'custom poll uniqueness postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.posts AS post_row
    LEFT JOIN public.polls AS poll_row
      ON poll_row.id = post_row.poll_id
    WHERE post_row.poll_id IS NOT NULL
      AND (
        post_row.poll_enabled IS DISTINCT FROM true
        OR poll_row.post_id IS DISTINCT FROM post_row.id
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.polls AS poll_row
    LEFT JOIN public.posts AS post_row
      ON post_row.id = poll_row.post_id
    WHERE poll_row.post_id IS NOT NULL
      AND (
        post_row.poll_enabled IS DISTINCT FROM true
        OR post_row.poll_id IS DISTINCT FROM poll_row.id
      )
  ) THEN
    RAISE EXCEPTION 'post/poll integrity postflight failed';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'anon',
    'authenticated',
    'authenticator'
  ]::text[]
  LOOP
    FOR v_relation IN
      SELECT relation.schema_name, relation.relation_name
      FROM (
        VALUES
          ('public', 'posts'),
          ('public', 'polls'),
          ('public', 'hashtags'),
          ('public', 'post_hashtags')
      ) AS relation(schema_name, relation_name)
    LOOP
      IF pg_catalog.has_table_privilege(
        v_role,
        pg_catalog.format(
          '%I.%I',
          v_relation.schema_name,
          v_relation.relation_name
        ),
        'INSERT,UPDATE,DELETE'
      ) THEN
        RAISE EXCEPTION 'browser table DML remains exposed: %.% to %',
          v_relation.schema_name,
          v_relation.relation_name,
          v_role;
      END IF;

      FOR v_column IN
        SELECT attribute.attname
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = pg_catalog.to_regclass(
          pg_catalog.format(
            '%I.%I',
            v_relation.schema_name,
            v_relation.relation_name
          )
        )
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      LOOP
        IF pg_catalog.has_column_privilege(
          v_role,
          pg_catalog.format(
            '%I.%I',
            v_relation.schema_name,
            v_relation.relation_name
          ),
          v_column.attname,
          'INSERT,UPDATE'
        ) THEN
          RAISE EXCEPTION 'browser column DML remains exposed: %.%.% to %',
            v_relation.schema_name,
            v_relation.relation_name,
            v_column.attname,
            v_role;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid IN (
      'public.posts'::regclass,
      'public.polls'::regclass,
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass
    )
      AND acl_entry.grantee = 0
      AND acl_entry.privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid IN (
      'public.posts'::regclass,
      'public.polls'::regclass,
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attacl IS NOT NULL
      AND acl_entry.grantee = 0
      AND acl_entry.privilege_type IN ('INSERT', 'UPDATE')
  ) THEN
    RAISE EXCEPTION 'post creation DML remains exposed to PUBLIC';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_recount_function
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'void'::regtype
    AND pg_catalog.cardinality(function_row.proconfig) = 2
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off'
    ];

  IF v_comment IS DISTINCT FROM
       'recount-hashtag-posts:v2:' || pg_catalog.md5(v_source)
     OR NOT pg_catalog.has_function_privilege(
       v_service_oid,
       v_recount_function,
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid = v_recount_function
         AND acl_entry.privilege_type = 'EXECUTE'
         AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
     )
  THEN
    RAISE EXCEPTION 'hashtag recount authority postflight failed';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       v_service_oid,
       v_create_function,
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
       WHERE function_row.oid = v_create_function
         AND acl_entry.privilege_type = 'EXECUTE'
         AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
     )
  THEN
    RAISE EXCEPTION 'atomic post create execution boundary postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
