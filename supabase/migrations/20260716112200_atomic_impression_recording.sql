-- Record the first per-user post impression and increment the ranking counter
-- in the same transaction. The trigger makes the existing /api/track insert
-- path atomic immediately; its legacy follow-up counter RPC becomes a guarded
-- no-op. A later route cutover may use record_post_impression directly, but it
-- must not be deployed before this migration reaches the production ledger.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'public.user_interactions:atomic-impression-recording',
    0
  )
);

DO $preflight$
DECLARE
  v_interactions regclass := pg_catalog.to_regclass('public.user_interactions');
  v_posts regclass := pg_catalog.to_regclass('public.posts');
  v_invalid_columns text[];
  v_missing_roles text[];
BEGIN
  IF v_interactions IS NULL OR v_posts IS NULL THEN
    RAISE EXCEPTION
      'public.user_interactions and public.posts must exist before impression hardening';
  END IF;

  IF (
    SELECT relation.relkind
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_interactions
  ) NOT IN ('r', 'p') OR (
    SELECT relation.relkind
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_posts
  ) NOT IN ('r', 'p') THEN
    RAISE EXCEPTION
      'impression storage relations must be tables or partitioned tables';
  END IF;

  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'service_role']::text[]
  ) AS required_role
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = required_role
  );

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'impression ACL roles are missing: %', v_missing_roles;
  END IF;

  SELECT pg_catalog.array_agg(
    pg_catalog.format(
      '%I.%I (expected %s%s)',
      required_column.table_name,
      required_column.column_name,
      required_column.type_name,
      CASE WHEN required_column.required_not_null THEN ' NOT NULL' ELSE '' END
    )
    ORDER BY required_column.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      (1, 'user_interactions', 'id', 'uuid', true),
      (2, 'user_interactions', 'user_id', 'uuid', true),
      (3, 'user_interactions', 'target_type', 'text', true),
      (4, 'user_interactions', 'target_id', 'text', true),
      (5, 'user_interactions', 'action', 'text', true),
      (6, 'user_interactions', 'metadata', 'jsonb', false),
      (7, 'posts', 'id', 'uuid', true),
      (8, 'posts', 'impression_count', 'integer', false)
  ) AS required_column(
    ordinality,
    table_name,
    column_name,
    type_name,
    required_not_null
  )
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = pg_catalog.to_regclass(
      'public.' || required_column.table_name
    )
   AND attribute.attname = required_column.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
     OR pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
          <> required_column.type_name
     OR (required_column.required_not_null AND NOT attribute.attnotnull);

  IF v_invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'impression schema has missing or incompatible columns: %',
      v_invalid_columns;
  END IF;

  IF pg_catalog.to_regprocedure(
    'public.lock_actor_can_interact_with_post(uuid,uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION
      'public.lock_actor_can_interact_with_post(uuid,uuid) must exist';
  END IF;

  IF pg_catalog.to_regprocedure(
    'public.increment_impression_count(uuid)'
  ) IS NULL OR (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      'public.increment_impression_count(uuid)'::regprocedure
  ) <> 'void'::regtype THEN
    RAISE EXCEPTION
      'public.increment_impression_count(uuid) compatibility RPC must exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_interactions
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgname <>
        'trg_record_post_impression_counter'
  ) THEN
    RAISE EXCEPTION
      'user_interactions has an unknown trigger; refusing counter overlap';
  END IF;

  -- The partial unique key is the linearization point for concurrent retries.
  -- Check the actual valid index contract, not a spoofable index name.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = v_interactions
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND NOT index_metadata.indisexclusion
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indpred IS NOT NULL
      AND index_metadata.indnkeyatts = 3
      AND index_metadata.indnatts = 3
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['user_id', 'target_type', 'target_id']::name[]
      AND pg_catalog.pg_get_expr(
        index_metadata.indpred,
        index_metadata.indrelid
      ) = '(action = ''impression''::text)'
  ) THEN
    RAISE EXCEPTION
      'user_interactions requires the valid unique impression key';
  END IF;
END
$preflight$;

LOCK TABLE public.user_interactions IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.user_interactions ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.user_interactions
  FROM PUBLIC, anon, authenticated, service_role;

DO $revoke_column_privileges$
DECLARE
  v_column_list text;
BEGIN
  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', ' ORDER BY attribute.attnum
  )
  INTO v_column_list
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.user_interactions'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF v_column_list IS NULL THEN
    RAISE EXCEPTION 'public.user_interactions has no columns to secure';
  END IF;

  EXECUTE pg_catalog.format(
    'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
      || 'ON TABLE public.user_interactions '
      || 'FROM PUBLIC, anon, authenticated, service_role',
    v_column_list
  );
END
$revoke_column_privileges$;

DO $drop_interaction_policies$
DECLARE
  v_policy_name name;
BEGIN
  FOR v_policy_name IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_interactions'::regclass
    ORDER BY policy.polname
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.user_interactions',
      v_policy_name
    );
  END LOOP;
END
$drop_interaction_policies$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.user_interactions
  TO service_role;

CREATE POLICY "Service role manages user interactions"
  ON public.user_interactions
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DROP TRIGGER IF EXISTS trg_record_post_impression_counter
  ON public.user_interactions;

DROP FUNCTION IF EXISTS public.apply_post_impression_insert();

CREATE FUNCTION public.apply_post_impression_insert()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $trigger_function$
DECLARE
  v_post_id uuid;
BEGIN
  BEGIN
    v_post_id := NEW.target_id::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'invalid post impression target';
  END;

  IF NEW.metadata IS NOT NULL
     AND (
       pg_catalog.jsonb_typeof(NEW.metadata) <> 'object'
       OR pg_catalog.pg_column_size(NEW.metadata) > 8192
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid post impression metadata';
  END IF;

  IF NOT public.lock_actor_can_interact_with_post(v_post_id, NEW.user_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'post impression is not authorized';
  END IF;

  UPDATE public.posts
  SET impression_count = COALESCE(impression_count, 0) + 1
  WHERE id = v_post_id;

  IF NOT FOUND THEN
    -- Raising aborts the parent INSERT too. The unique dedup fact can never
    -- commit without the matching post counter increment.
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'post disappeared while recording impression';
  END IF;

  RETURN NEW;
END
$trigger_function$;

REVOKE ALL ON FUNCTION public.apply_post_impression_insert()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_record_post_impression_counter
AFTER INSERT ON public.user_interactions
FOR EACH ROW
WHEN (NEW.action = 'impression' AND NEW.target_type = 'post')
EXECUTE FUNCTION public.apply_post_impression_insert();

-- Remove stale or manually-created overloads before publishing the one RPC
-- contract. A dependency on an obsolete overload makes the migration abort.
DO $drop_legacy_record_post_impression$
DECLARE
  v_signature regprocedure;
BEGIN
  FOR v_signature IN
    SELECT function_row.oid::regprocedure
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'record_post_impression'
      AND function_row.prokind = 'f'
  LOOP
    EXECUTE pg_catalog.format('DROP FUNCTION %s', v_signature);
  END LOOP;
END
$drop_legacy_record_post_impression$;

CREATE FUNCTION public.record_post_impression(
  p_user_id uuid,
  p_post_id uuid,
  p_metadata jsonb DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_inserted boolean := false;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_user_id IS NULL
     OR p_post_id IS NULL
     OR (
       p_metadata IS NOT NULL
       AND (
         pg_catalog.jsonb_typeof(p_metadata) <> 'object'
         OR pg_catalog.pg_column_size(p_metadata) > 8192
       )
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid post impression input';
  END IF;

  -- The canonical AFTER INSERT trigger authorizes the active actor/audience,
  -- locks the target facts, and increments the post before this returns.
  INSERT INTO public.user_interactions (
    user_id,
    target_type,
    target_id,
    action,
    metadata
  ) VALUES (
    p_user_id,
    'post',
    p_post_id::text,
    'impression',
    p_metadata
  )
  ON CONFLICT (user_id, target_type, target_id)
    WHERE action = 'impression'
  DO NOTHING
  RETURNING true INTO v_inserted;

  IF NOT COALESCE(v_inserted, false) THEN
    RETURN false;
  END IF;

  RETURN true;
END
$function$;

REVOKE ALL ON FUNCTION public.record_post_impression(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_post_impression(uuid, uuid, jsonb)
  TO service_role;

-- The live route historically calls this after a successful insert. The
-- trigger now owns the increment, so retain the signature as a service-only
-- compatibility no-op until every application instance removes that call.
DO $drop_legacy_increment_impression_count$
DECLARE
  v_signature regprocedure;
BEGIN
  FOR v_signature IN
    SELECT function_row.oid::regprocedure
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'increment_impression_count'
      AND function_row.prokind = 'f'
  LOOP
    EXECUTE pg_catalog.format('DROP FUNCTION %s', v_signature);
  END LOOP;
END
$drop_legacy_increment_impression_count$;

CREATE FUNCTION public.increment_impression_count(post_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $compatibility_function$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  -- Intentionally empty: the interaction INSERT trigger already incremented
  -- the counter in the same transaction as the dedup fact.
END
$compatibility_function$;

REVOKE ALL ON FUNCTION public.increment_impression_count(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.increment_impression_count(uuid)
  TO service_role;

DO $postflight$
DECLARE
  v_relation regclass := 'public.user_interactions'::regclass;
  v_function regprocedure :=
    'public.record_post_impression(uuid,uuid,jsonb)'::regprocedure;
  v_trigger_function regprocedure :=
    'public.apply_post_impression_insert()'::regprocedure;
  v_compatibility_function regprocedure :=
    'public.increment_impression_count(uuid)'::regprocedure;
  v_role name;
  v_privilege text;
  v_column name;
  v_service_role_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
BEGIN
  IF NOT (
    SELECT relation.relrowsecurity
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation
  ) THEN
    RAISE EXCEPTION 'RLS is not enabled on public.user_interactions';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
  LOOP
    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE',
      'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(v_role, v_relation, v_privilege) THEN
        RAISE EXCEPTION
          '% still has % on public.user_interactions',
          v_role,
          v_privilege;
      END IF;
    END LOOP;

    FOR v_column IN
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
      ]::text[]
      LOOP
        IF pg_catalog.has_column_privilege(
          v_role,
          v_relation,
          v_column,
          v_privilege
        ) THEN
          RAISE EXCEPTION
            '% still has column % on public.user_interactions.%',
            v_role,
            v_privilege,
            v_column;
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
    WHERE relation.oid = v_relation
      AND acl_entry.grantee = 0::oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee IN (
        0::oid,
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'anon'),
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'),
        v_service_role_oid
      )
  ) THEN
    RAISE EXCEPTION
      'application-role direct or column ACL remains on public.user_interactions';
  END IF;

  FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]
  LOOP
    IF NOT pg_catalog.has_table_privilege(
      'service_role',
      v_relation,
      v_privilege
    ) THEN
      RAISE EXCEPTION
        'service_role is missing % on public.user_interactions',
        v_privilege;
    END IF;
  END LOOP;

  FOREACH v_privilege IN ARRAY ARRAY['TRUNCATE', 'REFERENCES', 'TRIGGER']::text[]
  LOOP
    IF pg_catalog.has_table_privilege(
      'service_role',
      v_relation,
      v_privilege
    ) THEN
      RAISE EXCEPTION
        'service_role unexpectedly has % on public.user_interactions',
        v_privilege;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_relation
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_relation
      AND policy.polname = 'Service role manages user interactions'
      AND policy.polpermissive
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[v_service_role_oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
  ) THEN
    RAISE EXCEPTION
      'user_interactions RLS policies did not converge to service-only ALL';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'record_post_impression'
      AND function_row.prokind = 'f'
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'boolean'::regtype
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'record_post_impression function contract is invalid';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_relation
      AND NOT trigger_row.tgisinternal
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_relation
      AND trigger_row.tgname = 'trg_record_post_impression_counter'
      AND trigger_row.tgfoid = v_trigger_function
      AND trigger_row.tgenabled = 'O'
      AND pg_catalog.pg_get_triggerdef(trigger_row.oid) LIKE
        '%AFTER INSERT ON public.user_interactions%'
      AND pg_catalog.pg_get_triggerdef(trigger_row.oid) LIKE
        '%WHEN (((new.action = ''impression''::text) AND (new.target_type = ''post''::text)))%'
  ) THEN
    RAISE EXCEPTION 'post impression trigger contract is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname IN ('anon', 'authenticated', 'service_role')
      AND pg_catalog.has_function_privilege(
        role_row.rolname,
        v_trigger_function,
        'EXECUTE'
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid = v_trigger_function
      AND acl_entry.grantee = 0::oid
  ) THEN
    RAISE EXCEPTION 'post impression trigger function is directly executable';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'increment_impression_count'
      AND function_row.prokind = 'f'
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_compatibility_function
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'void'::regtype
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) OR pg_catalog.has_function_privilege(
    'anon', v_compatibility_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_compatibility_function, 'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_compatibility_function, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'increment_impression_count compatibility contract is invalid';
  END IF;

  IF pg_catalog.has_function_privilege(
    'anon', v_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_function, 'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_function, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'record_post_impression EXECUTE ACL is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid = v_function
      AND acl_entry.grantee = 0::oid
  ) THEN
    RAISE EXCEPTION 'PUBLIC can execute record_post_impression';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
