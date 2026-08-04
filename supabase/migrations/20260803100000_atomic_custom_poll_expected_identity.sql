-- Migration: 20260803100000_atomic_custom_poll_expected_identity.sql
-- Created: 2026-08-03T10:00:00Z
-- Description: Add a poll-identity-bound custom-poll vote authority. The
--   wrapper freezes the canonical post/poll link, locks the current poll, and
--   verifies the viewer's expected poll id before delegating to the proven
--   atomic vote implementation. The legacy signature remains available only
--   for rolling-deploy compatibility and can be closed after caller cutover.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.poll_votes:expected-poll-identity:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'expected poll identity migration lock is busy';
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
  v_audience_function regprocedure := pg_catalog.to_regprocedure(
    'public.lock_actor_can_interact_with_post(uuid,uuid)'
  );
  v_vote_function regprocedure := pg_catalog.to_regprocedure(
    'public.cast_post_poll_vote_atomic(uuid,uuid,integer[])'
  );
  v_existing_function regprocedure := pg_catalog.to_regprocedure(
    'public.cast_post_poll_vote_expected_atomic(uuid,uuid,uuid,integer[])'
  );
  v_vote_source text;
  v_poll_lock integer;
  v_delete integer;
  v_insert integer;
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
    RAISE EXCEPTION 'expected poll identity roles are missing: %',
      v_missing_roles;
  END IF;

  IF pg_catalog.to_regclass('public.posts') IS NULL
     OR pg_catalog.to_regclass('public.polls') IS NULL
     OR pg_catalog.to_regclass('public.poll_votes') IS NULL
     OR pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR v_audience_function IS NULL
     OR v_vote_function IS NULL
  THEN
    RAISE EXCEPTION
      'canonical post, poll, vote, auth and audience authorities must deploy first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.posts'::regclass,
      'public.polls'::regclass,
      'public.poll_votes'::regclass
    )
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
        OR relation.relowner <> v_postgres_oid
      )
  ) THEN
    RAISE EXCEPTION
      'expected poll identity requires canonical permanent relation ownership';
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
      ('public', 'posts', 1, 'id', 'uuid'::regtype, true),
      ('public', 'posts', 2, 'poll_id', 'uuid'::regtype, false),
      ('public', 'polls', 1, 'id', 'uuid'::regtype, true),
      ('public', 'polls', 2, 'post_id', 'uuid'::regtype, false),
      ('public', 'polls', 3, 'options', 'jsonb'::regtype, true),
      ('public', 'polls', 4, 'type', 'text'::regtype, false),
      ('public', 'polls', 5, 'end_at', 'timestamptz'::regtype, false),
      ('public', 'polls', 6, 'updated_at', 'timestamptz'::regtype, false),
      ('public', 'poll_votes', 1, 'poll_id', 'uuid'::regtype, true),
      ('public', 'poll_votes', 2, 'user_id', 'uuid'::regtype, true),
      ('public', 'poll_votes', 3, 'option_index', 'integer'::regtype, true)
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
    RAISE EXCEPTION 'expected poll identity has incompatible columns: %',
      v_invalid_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_audience_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'boolean'::regtype
      AND NOT function_row.proretset
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
  ) THEN
    RAISE EXCEPTION 'canonical locked post audience authority drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_vote_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_vote_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'jsonb'::regtype
    AND NOT function_row.proretset
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proargnames = ARRAY[
      'p_actor_id',
      'p_post_id',
      'p_option_indexes'
    ]::text[];

  v_poll_lock := pg_catalog.strpos(v_vote_source, 'FOR UPDATE');
  v_delete := pg_catalog.strpos(
    v_vote_source,
    'DELETE FROM public.poll_votes'
  );
  v_insert := pg_catalog.strpos(
    v_vote_source,
    'INSERT INTO public.poll_votes'
  );
  IF pg_catalog.strpos(
       v_vote_source,
       'public.lock_actor_can_interact_with_post'
     ) = 0
     OR v_poll_lock = 0
     OR v_delete <= v_poll_lock
     OR v_insert <= v_delete
  THEN
    RAISE EXCEPTION 'canonical atomic poll vote authority drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'cast_post_poll_vote_expected_atomic'
      AND function_row.oid IS DISTINCT FROM v_existing_function
  ) THEN
    RAISE EXCEPTION
      'incompatible cast_post_poll_vote_expected_atomic overload exists';
  END IF;
END
$preflight$;

LOCK TABLE public.posts, public.polls, public.poll_votes IN SHARE MODE;

CREATE OR REPLACE FUNCTION public.cast_post_poll_vote_expected_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_expected_poll_id uuid,
  p_option_indexes integer[]
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
  v_linked_poll_id uuid;
  v_locked_poll_id uuid;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_actor_id IS NULL
     OR p_post_id IS NULL
     OR p_expected_poll_id IS NULL
     OR COALESCE(pg_catalog.array_length(p_option_indexes, 1), 0) = 0
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  -- This freezes the actor/post audience and holds a SHARE lock on the post.
  -- Poll-link writers cannot cross this point before this transaction ends.
  IF NOT public.lock_actor_can_interact_with_post(p_post_id, p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT target.poll_id
  INTO v_linked_poll_id
  FROM public.posts AS target
  WHERE target.id = p_post_id
  FOR SHARE;

  IF NOT FOUND OR v_linked_poll_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- Lock the canonical current poll before comparing viewer intent. A poll
  -- switch that committed first is observed as poll_changed; one that starts
  -- later waits until the delegated vote transaction has completed.
  SELECT poll.id
  INTO v_locked_poll_id
  FROM public.polls AS poll
  WHERE poll.id = v_linked_poll_id
    AND poll.post_id = p_post_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_locked_poll_id IS DISTINCT FROM p_expected_poll_id THEN
    RETURN pg_catalog.jsonb_build_object('status', 'poll_changed');
  END IF;

  -- The post SHARE lock and poll UPDATE lock remain held while the proven
  -- implementation validates options and performs its DELETE/INSERT cycle.
  RETURN public.cast_post_poll_vote_atomic(
    p_actor_id,
    p_post_id,
    p_option_indexes
  );
END
$function$;

ALTER FUNCTION public.cast_post_poll_vote_expected_atomic(
  uuid, uuid, uuid, integer[]
) OWNER TO postgres;

REVOKE ALL PRIVILEGES
  ON FUNCTION public.cast_post_poll_vote_expected_atomic(
    uuid, uuid, uuid, integer[]
  )
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE
  ON FUNCTION public.cast_post_poll_vote_expected_atomic(
    uuid, uuid, uuid, integer[]
  )
  TO service_role;

DO $converge_acl$
DECLARE
  v_function regprocedure := pg_catalog.to_regprocedure(
    'public.cast_post_poll_vote_expected_atomic(uuid,uuid,uuid,integer[])'
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
$converge_acl$;

DO $attest_comment$
DECLARE
  v_function regprocedure := pg_catalog.to_regprocedure(
    'public.cast_post_poll_vote_expected_atomic(uuid,uuid,uuid,integer[])'
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
    'atomic-custom-poll-expected-identity:v1:' || pg_catalog.md5(v_source)
  );
END
$attest_comment$;

DO $postflight$
DECLARE
  v_function regprocedure := pg_catalog.to_regprocedure(
    'public.cast_post_poll_vote_expected_atomic(uuid,uuid,uuid,integer[])'
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
  v_poll_lock integer;
  v_expected_check integer;
  v_delegate integer;
BEGIN
  IF v_function IS NULL OR v_postgres_oid IS NULL OR v_service_oid IS NULL THEN
    RAISE EXCEPTION 'expected poll identity postflight objects are missing';
  END IF;

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
    AND function_row.pronargs = 4
    AND function_row.pronargdefaults = 0
    AND function_row.proargnames = ARRAY[
      'p_actor_id',
      'p_post_id',
      'p_expected_poll_id',
      'p_option_indexes'
    ]::text[]
    AND pg_catalog.cardinality(function_row.proconfig) = 4
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off',
      'lock_timeout=5s',
      'statement_timeout=15s'
    ]::text[];

  v_poll_lock := pg_catalog.strpos(v_source, 'FOR UPDATE');
  v_expected_check := pg_catalog.strpos(
    v_source,
    'v_locked_poll_id IS DISTINCT FROM p_expected_poll_id'
  );
  v_delegate := pg_catalog.strpos(
    v_source,
    'public.cast_post_poll_vote_atomic'
  );

  IF v_comment IS DISTINCT FROM
       'atomic-custom-poll-expected-identity:v1:' || pg_catalog.md5(v_source)
     OR pg_catalog.strpos(
       v_source,
       'public.lock_actor_can_interact_with_post'
     ) = 0
     OR v_poll_lock = 0
     OR v_expected_check <= v_poll_lock
     OR v_delegate <= v_expected_check
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
    RAISE EXCEPTION 'expected poll identity authority postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
