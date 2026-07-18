-- Bind public collection reads to current owner/resource audience and move every
-- API mutation behind a service-only transaction boundary.
-- This migration is standalone so it can safely precede the dependent API deploy.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'collection-current-audience-and-atomic-writes:migration',
    0
  )
);

DO $required_relations$
BEGIN
  IF pg_catalog.to_regclass('public.user_collections') IS NULL
    OR pg_catalog.to_regclass('public.collection_items') IS NULL
    OR pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regclass('public.user_activities') IS NULL
  THEN
    RAISE EXCEPTION 'collection audience dependencies are incomplete';
  END IF;
END
$required_relations$;

LOCK TABLE public.user_collections, public.collection_items
  IN ACCESS EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_anon_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'anon'
  );
  v_authenticated_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticated'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_post_reader pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure('public.can_actor_read_post_id(uuid,uuid)');
BEGIN
  IF v_postgres_oid IS NULL OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS required_role
    RIGHT JOIN pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'service_role']::name[]
    ) AS required(role_name)
      ON required_role.rolname = required.role_name
    WHERE required_role.oid IS NULL
  ) OR pg_catalog.to_regprocedure('auth.uid()') IS NULL
    OR pg_catalog.to_regprocedure('auth.role()') IS NULL
    OR v_post_reader IS NULL
  THEN
    RAISE EXCEPTION 'collection audience roles/functions are incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS browser_role
    WHERE browser_role.oid IN (v_anon_oid, v_authenticated_oid)
      AND (
        browser_role.rolsuper
        OR browser_role.rolbypassrls
      )
  ) OR EXISTS (
    WITH RECURSIVE reachable_role(
      browser_oid,
      role_oid,
      traversed_oids
    ) AS (
      SELECT seed.browser_oid,
        seed.browser_oid,
        ARRAY[seed.browser_oid]::oid[]
      FROM pg_catalog.unnest(
        ARRAY[v_anon_oid, v_authenticated_oid]::oid[]
      ) AS seed(browser_oid)

      UNION ALL

      SELECT reachable_role.browser_oid,
        membership.roleid,
        reachable_role.traversed_oids || membership.roleid
      FROM reachable_role
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = reachable_role.role_oid
      WHERE (
          membership.inherit_option
          OR membership.set_option
        )
        AND NOT (
          membership.roleid =
            ANY(reachable_role.traversed_oids)
        )
    )
    SELECT 1
    FROM reachable_role
    JOIN pg_catalog.pg_roles AS reachable
      ON reachable.oid = reachable_role.role_oid
    WHERE reachable_role.role_oid <>
        reachable_role.browser_oid
      AND (
        reachable.rolsuper
        OR reachable.rolbypassrls
        OR reachable.oid IN (v_postgres_oid, v_service_oid)
      )
  ) THEN
    RAISE EXCEPTION
      'browser collection roles can reach a privileged authority';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('public.user_collections'),
        ('public.collection_items'),
        ('public.user_profiles'),
        ('public.user_activities')
    ) AS required_relation(relation_name)
    LEFT JOIN pg_catalog.pg_class AS relation
      ON relation.oid =
        pg_catalog.to_regclass(required_relation.relation_name)
    WHERE relation.oid IS NULL
       OR relation.relkind <> 'r'
       OR relation.relpersistence <> 'p'
       OR relation.relispartition
       OR relation.relowner <> v_postgres_oid
       OR relation.relforcerowsecurity
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_inherits AS inheritance
         WHERE inheritance.inhrelid = relation.oid
            OR inheritance.inhparent = relation.oid
       )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_rewrite AS rewrite_rule
         WHERE rewrite_rule.ev_class = relation.oid
       )
  ) THEN
    RAISE EXCEPTION
      'collection audience dependency relation ownership/shape is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('public', 'user_collections', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'user_collections', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'user_collections', 'name', 'text'::pg_catalog.regtype, true),
        ('public', 'user_collections', 'description', 'text'::pg_catalog.regtype, false),
        ('public', 'user_collections', 'is_public', 'boolean'::pg_catalog.regtype, false),
        ('public', 'user_collections', 'created_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'user_collections', 'updated_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'collection_items', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'collection_items', 'collection_id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'collection_items', 'item_type', 'text'::pg_catalog.regtype, true),
        ('public', 'collection_items', 'item_id', 'text'::pg_catalog.regtype, true),
        ('public', 'collection_items', 'note', 'text'::pg_catalog.regtype, false),
        ('public', 'collection_items', 'added_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'user_profiles', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'user_profiles', 'banned_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'user_profiles', 'is_banned', 'boolean'::pg_catalog.regtype, false),
        ('public', 'user_profiles', 'ban_expires_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public', 'user_activities', 'id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'user_activities', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('public', 'user_activities', 'target_type', 'text'::pg_catalog.regtype, true),
        ('public', 'user_activities', 'target_id', 'text'::pg_catalog.regtype, true)
    ) AS required_column(
      schema_name,
      relation_name,
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
    WHERE attribute.attnum IS NULL
       OR attribute.atttypid <> required_column.type_oid
       OR attribute.atttypmod <> -1
       OR attribute.attgenerated <> ''
       OR (
         required_column.required_not_null
         AND NOT attribute.attnotnull
       )
  ) THEN
    RAISE EXCEPTION 'collection audience dependency columns are incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'public.user_collections'::pg_catalog.regclass,
          ARRAY['id']::name[]
        ),
        (
          'public.user_collections'::pg_catalog.regclass,
          ARRAY['user_id', 'name']::name[]
        ),
        (
          'public.collection_items'::pg_catalog.regclass,
          ARRAY['id']::name[]
        ),
        (
          'public.collection_items'::pg_catalog.regclass,
          ARRAY['collection_id', 'item_type', 'item_id']::name[]
        ),
        (
          'public.user_profiles'::pg_catalog.regclass,
          ARRAY['id']::name[]
        ),
        (
          'public.user_activities'::pg_catalog.regclass,
          ARRAY['id']::name[]
        )
    ) AS required_key(relation_id, columns)
    WHERE (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_index AS index_row
      WHERE index_row.indrelid = required_key.relation_id
        AND index_row.indisunique
        AND index_row.indisvalid
        AND index_row.indisready
        AND index_row.indimmediate
        AND index_row.indpred IS NULL
        AND index_row.indexprs IS NULL
        AND index_row.indnkeyatts = pg_catalog.array_length(
          required_key.columns,
          1
        )
        AND index_row.indnatts = index_row.indnkeyatts
        AND (
          SELECT pg_catalog.array_agg(
            attribute.attname
            ORDER BY key_column.ordinality
          )
          FROM pg_catalog.unnest(index_row.indkey)
            WITH ORDINALITY AS key_column(attnum, ordinality)
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = index_row.indrelid
           AND attribute.attnum = key_column.attnum
        ) = required_key.columns
    ) <> 1
  ) THEN
    RAISE EXCEPTION 'collection identity/uniqueness contract is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid IN (
      'public.user_collections'::pg_catalog.regclass,
      'public.collection_items'::pg_catalog.regclass
    )
      AND index_row.indisunique
      AND (
        NOT index_row.indisvalid
        OR NOT index_row.indisready
        OR NOT index_row.indimmediate
        OR index_row.indpred IS NOT NULL
        OR index_row.indexprs IS NOT NULL
        OR index_row.indnatts <> index_row.indnkeyatts
        OR (
          index_row.indrelid =
            'public.user_collections'::pg_catalog.regclass
          AND COALESCE(
            (
              SELECT pg_catalog.array_agg(
                attribute.attname
                ORDER BY key_column.ordinality
              )
              FROM pg_catalog.unnest(index_row.indkey)
                WITH ORDINALITY AS key_column(attnum, ordinality)
              LEFT JOIN pg_catalog.pg_attribute AS attribute
                ON attribute.attrelid = index_row.indrelid
               AND attribute.attnum = key_column.attnum
            ),
            ARRAY[]::name[]
          ) NOT IN (
            ARRAY['id']::name[],
            ARRAY['user_id', 'name']::name[]
          )
        )
        OR (
          index_row.indrelid =
            'public.collection_items'::pg_catalog.regclass
          AND COALESCE(
            (
              SELECT pg_catalog.array_agg(
                attribute.attname
                ORDER BY key_column.ordinality
              )
              FROM pg_catalog.unnest(index_row.indkey)
                WITH ORDINALITY AS key_column(attnum, ordinality)
              LEFT JOIN pg_catalog.pg_attribute AS attribute
                ON attribute.attrelid = index_row.indrelid
               AND attribute.attnum = key_column.attnum
            ),
            ARRAY[]::name[]
          ) NOT IN (
            ARRAY['id']::name[],
            ARRAY['collection_id', 'item_type', 'item_id']::name[]
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'unexpected collection unique authority exists';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.collection_items'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid =
        'public.user_collections'::pg_catalog.regclass
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'collection_id'
        )
      ]::smallint[]
      AND constraint_row.confkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.confrelid
            AND attribute.attname = 'id'
        )
      ]::smallint[]
  ) <> 1 THEN
    RAISE EXCEPTION 'collection item parent cascade contract is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.collection_items AS item
    WHERE item.item_type NOT IN ('post', 'activity')
       OR item.item_id !~
          '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
  ) THEN
    RAISE EXCEPTION
      'collection item type/id historical data is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.collection_items AS item
    GROUP BY item.collection_id, item.item_type, item.item_id::uuid
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'collection item canonical identity collision exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.collection_items AS item
    WHERE item.item_id <> (item.item_id::uuid)::text
  ) THEN
    RAISE EXCEPTION
      'collection item id historical data is not canonical lowercase uuid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = procedure.proowner
    WHERE procedure.oid = v_post_reader
      AND owner_role.rolname = 'postgres'
      AND procedure.prokind = 'f'
      AND procedure.prorettype = 'boolean'::pg_catalog.regtype
      AND procedure.provolatile = 's'
      AND procedure.prosecdef
      AND NOT procedure.proleakproof
      AND procedure.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'post audience dependency function is incompatible';
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
    WHERE procedure.oid = v_post_reader
      AND privilege.privilege_type = 'EXECUTE'
      AND privilege.grantee <> procedure.proowner
  ) THEN
    RAISE EXCEPTION
      'post audience dependency function must remain owner-private';
  END IF;
END
$preflight$;

ALTER TABLE public.user_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_collections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.collection_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collection_items NO FORCE ROW LEVEL SECURITY;

DO $replace_collection_policies$
DECLARE
  v_relation pg_catalog.regclass;
  v_policy record;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.user_collections'::pg_catalog.regclass,
    'public.collection_items'::pg_catalog.regclass
  ]
  LOOP
    FOR v_policy IN
      SELECT policy.polname
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation
      ORDER BY policy.polname
    LOOP
      EXECUTE pg_catalog.format(
        'DROP POLICY %I ON %s',
        v_policy.polname,
        v_relation
      );
    END LOOP;
  END LOOP;
END
$replace_collection_policies$;

DO $converge_collection_acl$
DECLARE
  v_relation pg_catalog.regclass;
  v_column_list text;
  v_grantee name;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.user_collections'::pg_catalog.regclass,
    'public.collection_items'::pg_catalog.regclass
  ]
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON %s FROM PUBLIC, anon, authenticated, service_role CASCADE',
      v_relation
    );

    FOR v_grantee IN
      SELECT DISTINCT grantee_role.rolname
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS privilege
      JOIN pg_catalog.pg_roles AS grantee_role
        ON grantee_role.oid = privilege.grantee
      WHERE relation.oid = v_relation
        AND grantee_role.rolname NOT IN (
          'postgres',
          'anon',
          'authenticated',
          'service_role'
        )
      ORDER BY grantee_role.rolname
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON %s FROM %I CASCADE',
        v_relation,
        v_grantee
      );
    END LOOP;

    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute.attname),
      ', '
      ORDER BY attribute.attnum
    )
    INTO v_column_list
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF v_column_list IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), '
          || 'REFERENCES (%1$s) ON %2$s '
          || 'FROM PUBLIC, anon, authenticated, service_role CASCADE',
        v_column_list,
        v_relation
      );

      FOR v_grantee IN
        SELECT DISTINCT grantee_role.rolname
        FROM pg_catalog.pg_attribute AS attribute
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl)
          AS privilege
        JOIN pg_catalog.pg_roles AS grantee_role
          ON grantee_role.oid = privilege.grantee
        WHERE attribute.attrelid = v_relation
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND grantee_role.rolname NOT IN (
            'postgres',
            'anon',
            'authenticated',
            'service_role'
          )
        ORDER BY grantee_role.rolname
      LOOP
        EXECUTE pg_catalog.format(
          'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), '
            || 'REFERENCES (%1$s) ON %2$s FROM %3$I CASCADE',
          v_column_list,
          v_relation,
          v_grantee
        );
      END LOOP;
    END IF;
  END LOOP;
END
$converge_collection_acl$;

GRANT SELECT ON public.user_collections TO anon, authenticated;
GRANT SELECT ON public.collection_items TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_collections
  TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.collection_items
  TO service_role;

DO $drop_noncanonical_collection_routines$
DECLARE
  v_routine record;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname IN (
        'can_actor_read_activity_id',
        'can_service_actor_read_activity',
        'can_current_user_read_collection_item',
        'mutate_user_collection_atomic',
        'mutate_collection_item_atomic',
        'ensure_default_collections'
      )
      AND procedure.prokind <> 'f'
  ) THEN
    RAISE EXCEPTION
      'non-function collection routine name collision must be classified';
  END IF;

  FOR v_routine IN
    SELECT procedure.proname,
      pg_catalog.pg_get_function_identity_arguments(procedure.oid)
        AS identity_arguments
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname IN (
        'can_actor_read_activity_id',
        'can_service_actor_read_activity',
        'can_current_user_read_collection_item',
        'mutate_user_collection_atomic',
        'mutate_collection_item_atomic',
        'ensure_default_collections'
      )
      AND procedure.prokind = 'f'
      AND procedure.oid <> ALL(ARRAY[
        COALESCE(
          pg_catalog.to_regprocedure(
            'public.can_actor_read_activity_id(uuid,uuid)'
          )::oid,
          0::oid
        ),
        COALESCE(
          pg_catalog.to_regprocedure(
            'public.can_service_actor_read_activity(uuid,uuid)'
          )::oid,
          0::oid
        ),
        COALESCE(
          pg_catalog.to_regprocedure(
            'public.can_current_user_read_collection_item(text,text)'
          )::oid,
          0::oid
        ),
        COALESCE(
          pg_catalog.to_regprocedure(
            'public.mutate_user_collection_atomic(text,uuid,uuid,text,boolean,boolean,boolean,text,boolean)'
          )::oid,
          0::oid
        ),
        COALESCE(
          pg_catalog.to_regprocedure(
            'public.mutate_collection_item_atomic(text,uuid,uuid,uuid,text,text)'
          )::oid,
          0::oid
        ),
        COALESCE(
          pg_catalog.to_regprocedure(
            'public.ensure_default_collections(uuid)'
          )::oid,
          0::oid
        )
      ]::oid[])
    ORDER BY procedure.proname, procedure.oid
  LOOP
    EXECUTE pg_catalog.format(
      'DROP FUNCTION public.%I(%s)',
      v_routine.proname,
      v_routine.identity_arguments
    );
  END LOOP;
END
$drop_noncanonical_collection_routines$;

CREATE OR REPLACE FUNCTION public.can_actor_read_activity_id(
  p_activity_id uuid,
  p_actor_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_activities AS activity
    JOIN public.user_profiles AS owner_profile
      ON owner_profile.id = activity.user_id
    WHERE activity.id = p_activity_id
      AND owner_profile.deleted_at IS NULL
      AND owner_profile.banned_at IS NULL
      AND NOT (
        COALESCE(owner_profile.is_banned, false)
        AND (
          owner_profile.ban_expires_at IS NULL
          OR owner_profile.ban_expires_at >
            pg_catalog.statement_timestamp()
        )
      )
      AND CASE
        WHEN activity.target_type IS DISTINCT FROM 'post' THEN true
        WHEN activity.target_id ~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN public.can_actor_read_post_id(
          activity.target_id::uuid,
          p_actor_id
        )
        ELSE false
      END
  )
$function$;

ALTER FUNCTION public.can_actor_read_activity_id(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_actor_read_activity_id(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role CASCADE;

CREATE OR REPLACE FUNCTION public.can_service_actor_read_activity(
  p_activity_id uuid,
  p_actor_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  RETURN public.can_actor_read_activity_id(p_activity_id, p_actor_id);
END
$function$;

ALTER FUNCTION public.can_service_actor_read_activity(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_service_actor_read_activity(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role CASCADE;
GRANT EXECUTE ON FUNCTION public.can_service_actor_read_activity(uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.can_current_user_read_collection_item(
  p_item_type text,
  p_item_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT CASE
    WHEN p_item_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN false
    WHEN p_item_type = 'post'
      THEN public.can_actor_read_post_id(p_item_id::uuid, (SELECT auth.uid()))
    WHEN p_item_type = 'activity'
      THEN public.can_actor_read_activity_id(p_item_id::uuid, (SELECT auth.uid()))
    ELSE false
  END
$function$;

ALTER FUNCTION public.can_current_user_read_collection_item(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_current_user_read_collection_item(text, text)
  FROM PUBLIC, anon, authenticated, service_role CASCADE;
GRANT EXECUTE ON FUNCTION public.can_current_user_read_collection_item(text, text)
  TO anon, authenticated;

DROP POLICY IF EXISTS user_collections_public_or_owner_read ON public.user_collections;
CREATE POLICY user_collections_public_or_owner_read
  ON public.user_collections
  AS PERMISSIVE
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_profiles AS owner_profile
      WHERE owner_profile.id = user_collections.user_id
        AND owner_profile.deleted_at IS NULL
        AND owner_profile.banned_at IS NULL
        AND NOT (
          COALESCE(owner_profile.is_banned, false)
          AND (
            owner_profile.ban_expires_at IS NULL
            OR owner_profile.ban_expires_at >
              pg_catalog.statement_timestamp()
          )
        )
    )
    AND (
      user_id = (SELECT auth.uid())
      OR COALESCE(is_public, false)
    )
  );

DROP POLICY IF EXISTS collection_items_public_or_owner_read ON public.collection_items;
CREATE POLICY collection_items_public_or_owner_read
  ON public.collection_items
  AS PERMISSIVE
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_collections AS collection
      WHERE collection.id = collection_items.collection_id
        AND EXISTS (
          SELECT 1
          FROM public.user_profiles AS owner_profile
          WHERE owner_profile.id = collection.user_id
            AND owner_profile.deleted_at IS NULL
            AND owner_profile.banned_at IS NULL
            AND NOT (
              COALESCE(owner_profile.is_banned, false)
              AND (
                owner_profile.ban_expires_at IS NULL
                OR owner_profile.ban_expires_at >
                  pg_catalog.statement_timestamp()
              )
            )
        )
        AND (
          collection.user_id = (SELECT auth.uid())
          OR COALESCE(collection.is_public, false)
        )
        AND public.can_current_user_read_collection_item(
          collection_items.item_type,
          collection_items.item_id
        )
    )
  );

CREATE POLICY server_role_mutation
  ON public.user_collections
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY server_role_mutation
  ON public.collection_items
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.mutate_user_collection_atomic(
  p_action text,
  p_actor_id uuid,
  p_collection_id uuid,
  p_description text,
  p_description_present boolean,
  p_is_public boolean,
  p_is_public_present boolean,
  p_name text,
  p_name_present boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_collection public.user_collections%ROWTYPE;
  v_actor_id uuid;
  v_constraint_name text;
  v_constraint_schema text;
  v_constraint_table text;
  v_result_code text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_action IS NULL
    OR p_action NOT IN ('create', 'update', 'delete')
  THEN
    RAISE EXCEPTION 'invalid collection action' USING ERRCODE = '22023';
  END IF;
  IF p_actor_id IS NULL
    OR (p_action = 'create' AND p_collection_id IS NOT NULL)
    OR (p_action <> 'create' AND p_collection_id IS NULL)
  THEN
    RAISE EXCEPTION 'invalid collection mutation scope' USING ERRCODE = '22023';
  END IF;
  IF p_description_present IS NULL
    OR p_is_public_present IS NULL
    OR p_name_present IS NULL
    OR (
      p_name_present
      AND (
        p_name IS NULL
        OR pg_catalog.char_length(p_name) NOT BETWEEN 1 AND 50
      )
    )
    OR (p_description_present AND p_description IS NOT NULL AND pg_catalog.char_length(p_description) > 200)
    OR (p_is_public_present AND p_is_public IS NULL)
    OR (p_action = 'create' AND NOT (p_name_present AND p_is_public_present))
  THEN
    RAISE EXCEPTION 'invalid collection mutation payload' USING ERRCODE = '22023';
  END IF;

  SELECT profile.id
  INTO v_actor_id
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
    AND profile.deleted_at IS NULL
    AND profile.banned_at IS NULL
    AND NOT (
      COALESCE(profile.is_banned, false)
      AND (
        profile.ban_expires_at IS NULL
        OR profile.ban_expires_at > pg_catalog.statement_timestamp()
      )
    )
  FOR UPDATE;

  IF v_actor_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'action', p_action,
      'actor_id', p_actor_id,
      'applied', false,
      'collection', NULL,
      'collection_id', p_collection_id,
      'result_code', 'inactive_actor'
    );
  END IF;

  IF p_action = 'create' THEN
    INSERT INTO public.user_collections (
      id,
      user_id,
      name,
      description,
      is_public,
      created_at,
      updated_at
    ) VALUES (
      pg_catalog.gen_random_uuid(),
      p_actor_id,
      p_name,
      CASE WHEN p_description_present THEN p_description ELSE NULL END,
      p_is_public,
      pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp()
    )
    ON CONFLICT (user_id, name) DO NOTHING
    RETURNING * INTO v_collection;

    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'action', p_action,
        'actor_id', p_actor_id,
        'applied', false,
        'collection', NULL,
        'collection_id', NULL,
        'result_code', 'already_exists'
      );
    END IF;
    v_result_code := 'created';
  ELSE
    SELECT collection.*
    INTO v_collection
    FROM public.user_collections AS collection
    WHERE collection.id = p_collection_id
      AND collection.user_id = p_actor_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'action', p_action,
        'actor_id', p_actor_id,
        'applied', false,
        'collection', NULL,
        'collection_id', p_collection_id,
        'result_code', 'not_found'
      );
    END IF;

    IF p_action = 'update' THEN
      BEGIN
        UPDATE public.user_collections AS collection
        SET name = CASE
              WHEN p_name_present THEN p_name
              ELSE collection.name
            END,
            description = CASE
              WHEN p_description_present THEN p_description
              ELSE collection.description
            END,
            is_public = CASE
              WHEN p_is_public_present THEN p_is_public
              ELSE collection.is_public
            END,
            updated_at = pg_catalog.clock_timestamp()
        WHERE collection.id = p_collection_id
          AND collection.user_id = p_actor_id
        RETURNING collection.* INTO STRICT v_collection;
      EXCEPTION
        WHEN unique_violation THEN
          GET STACKED DIAGNOSTICS
            v_constraint_name = CONSTRAINT_NAME,
            v_constraint_schema = SCHEMA_NAME,
            v_constraint_table = TABLE_NAME;
          IF v_constraint_schema IS DISTINCT FROM 'public'
            OR v_constraint_table IS DISTINCT FROM 'user_collections'
            OR NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_index AS index_row
            JOIN pg_catalog.pg_class AS index_relation
              ON index_relation.oid = index_row.indexrelid
            WHERE index_row.indrelid =
                'public.user_collections'::pg_catalog.regclass
              AND index_relation.relname = v_constraint_name
              AND index_row.indisunique
              AND index_row.indisvalid
              AND index_row.indisready
              AND index_row.indimmediate
              AND index_row.indpred IS NULL
              AND index_row.indexprs IS NULL
              AND index_row.indnkeyatts = 2
              AND index_row.indnatts = 2
              AND (
                SELECT pg_catalog.array_agg(
                  attribute.attname
                  ORDER BY key_column.ordinality
                )
                FROM pg_catalog.unnest(index_row.indkey)
                  WITH ORDINALITY AS key_column(attnum, ordinality)
                JOIN pg_catalog.pg_attribute AS attribute
                  ON attribute.attrelid = index_row.indrelid
                 AND attribute.attnum = key_column.attnum
              ) = ARRAY['user_id', 'name']::name[]
            )
          THEN
            RAISE;
          END IF;
          RETURN pg_catalog.jsonb_build_object(
            'action', p_action,
            'actor_id', p_actor_id,
            'applied', false,
            'collection', NULL,
            'collection_id', p_collection_id,
            'result_code', 'already_exists'
          );
      END;
      v_result_code := 'updated';
    ELSE
      DELETE FROM public.user_collections AS collection
      WHERE collection.id = p_collection_id
        AND collection.user_id = p_actor_id
      RETURNING collection.* INTO STRICT v_collection;
      v_result_code := 'deleted';
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'action', p_action,
    'actor_id', p_actor_id,
    'applied', true,
    'collection', CASE
      WHEN p_action = 'delete' THEN NULL
      ELSE pg_catalog.jsonb_build_object(
        'id', v_collection.id,
        'user_id', v_collection.user_id,
        'name', v_collection.name,
        'description', v_collection.description,
        'is_public', v_collection.is_public,
        'created_at', v_collection.created_at,
        'updated_at', v_collection.updated_at
      )
    END,
    'collection_id', v_collection.id,
    'result_code', v_result_code
  );
END
$function$;

ALTER FUNCTION public.mutate_user_collection_atomic(
  text, uuid, uuid, text, boolean, boolean, boolean, text, boolean
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mutate_user_collection_atomic(
  text, uuid, uuid, text, boolean, boolean, boolean, text, boolean
) FROM PUBLIC, anon, authenticated, service_role CASCADE;
GRANT EXECUTE ON FUNCTION public.mutate_user_collection_atomic(
  text, uuid, uuid, text, boolean, boolean, boolean, text, boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.mutate_collection_item_atomic(
  p_action text,
  p_actor_id uuid,
  p_collection_id uuid,
  p_item_id uuid,
  p_item_type text,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_actor_id uuid;
  v_collection_id uuid;
  v_item public.collection_items%ROWTYPE;
  v_resource_readable boolean := false;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_action IS NULL
    OR p_action NOT IN ('add', 'remove')
    OR p_actor_id IS NULL
    OR p_collection_id IS NULL
    OR p_item_id IS NULL
    OR p_item_type IS NULL
    OR p_item_type NOT IN ('post', 'activity')
    OR (p_note IS NOT NULL AND pg_catalog.char_length(p_note) > 500)
  THEN
    RAISE EXCEPTION 'invalid collection item mutation' USING ERRCODE = '22023';
  END IF;

  SELECT profile.id
  INTO v_actor_id
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
    AND profile.deleted_at IS NULL
    AND profile.banned_at IS NULL
    AND NOT (
      COALESCE(profile.is_banned, false)
      AND (
        profile.ban_expires_at IS NULL
        OR profile.ban_expires_at > pg_catalog.statement_timestamp()
      )
    )
  FOR UPDATE;

  IF v_actor_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'action', p_action,
      'actor_id', p_actor_id,
      'applied', false,
      'collection_id', p_collection_id,
      'item', NULL,
      'item_id', p_item_id,
      'item_type', p_item_type,
      'result_code', 'inactive_actor'
    );
  END IF;

  SELECT collection.id
  INTO v_collection_id
  FROM public.user_collections AS collection
  WHERE collection.id = p_collection_id
    AND collection.user_id = p_actor_id
  FOR UPDATE;

  IF v_collection_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'action', p_action,
      'actor_id', p_actor_id,
      'applied', false,
      'collection_id', p_collection_id,
      'item', NULL,
      'item_id', p_item_id,
      'item_type', p_item_type,
      'result_code', 'collection_not_found'
    );
  END IF;

  IF p_action = 'add' THEN
    v_resource_readable := CASE p_item_type
      WHEN 'post' THEN public.can_actor_read_post_id(p_item_id, p_actor_id)
      WHEN 'activity' THEN public.can_actor_read_activity_id(p_item_id, p_actor_id)
      ELSE false
    END;
    IF NOT v_resource_readable THEN
      RETURN pg_catalog.jsonb_build_object(
        'action', p_action,
        'actor_id', p_actor_id,
        'applied', false,
        'collection_id', p_collection_id,
        'item', NULL,
        'item_id', p_item_id,
        'item_type', p_item_type,
        'result_code', 'resource_not_found'
      );
    END IF;

    INSERT INTO public.collection_items (
      id,
      collection_id,
      item_type,
      item_id,
      note,
      added_at
    ) VALUES (
      pg_catalog.gen_random_uuid(),
      p_collection_id,
      p_item_type,
      p_item_id::text,
      p_note,
      pg_catalog.clock_timestamp()
    )
    ON CONFLICT (collection_id, item_type, item_id) DO NOTHING
    RETURNING * INTO v_item;

    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'action', p_action,
        'actor_id', p_actor_id,
        'applied', false,
        'collection_id', p_collection_id,
        'item', NULL,
        'item_id', p_item_id,
        'item_type', p_item_type,
        'result_code', 'already_exists'
      );
    END IF;
  ELSE
    SELECT item.*
    INTO v_item
    FROM public.collection_items AS item
    WHERE item.collection_id = p_collection_id
      AND item.item_type = p_item_type
      AND item.item_id = p_item_id::text
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'action', p_action,
        'actor_id', p_actor_id,
        'applied', false,
        'collection_id', p_collection_id,
        'item', NULL,
        'item_id', p_item_id,
        'item_type', p_item_type,
        'result_code', 'not_found'
      );
    END IF;

    DELETE FROM public.collection_items AS item
    WHERE item.id = v_item.id
      AND item.collection_id = p_collection_id
    RETURNING item.* INTO STRICT v_item;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'action', p_action,
    'actor_id', p_actor_id,
    'applied', true,
    'collection_id', p_collection_id,
    'item', pg_catalog.jsonb_build_object(
      'id', v_item.id,
      'collection_id', v_item.collection_id,
      'item_id', v_item.item_id,
      'item_type', v_item.item_type,
      'note', v_item.note,
      'added_at', v_item.added_at
    ),
    'item_id', p_item_id,
    'item_type', p_item_type,
    'result_code', CASE WHEN p_action = 'add' THEN 'inserted' ELSE 'removed' END
  );
END
$function$;

ALTER FUNCTION public.mutate_collection_item_atomic(text, uuid, uuid, uuid, text, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mutate_collection_item_atomic(text, uuid, uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated, service_role CASCADE;
GRANT EXECUTE ON FUNCTION public.mutate_collection_item_atomic(text, uuid, uuid, uuid, text, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.ensure_default_collections(
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_actor_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user id required' USING ERRCODE = '22023';
  END IF;

  SELECT profile.id
  INTO v_actor_id
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
    AND profile.deleted_at IS NULL
    AND profile.banned_at IS NULL
    AND NOT (
      COALESCE(profile.is_banned, false)
      AND (
        profile.ban_expires_at IS NULL
        OR profile.ban_expires_at > pg_catalog.statement_timestamp()
      )
    )
  FOR UPDATE;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'active user required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.user_collections (
    id,
    user_id,
    name,
    description,
    is_public,
    created_at,
    updated_at
  ) VALUES
    (
      pg_catalog.gen_random_uuid(),
      p_user_id,
      '关注的交易员',
      'My followed traders',
      false,
      v_now,
      v_now
    ),
    (
      pg_catalog.gen_random_uuid(),
      p_user_id,
      '我的书架',
      'My bookshelf',
      false,
      v_now,
      v_now
    )
  ON CONFLICT (user_id, name) DO NOTHING;
END
$function$;

ALTER FUNCTION public.ensure_default_collections(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ensure_default_collections(uuid)
  FROM PUBLIC, anon, authenticated, service_role CASCADE;
GRANT EXECUTE ON FUNCTION public.ensure_default_collections(uuid)
  TO service_role;

DO $converge_collection_function_acl$
DECLARE
  v_signature text;
  v_allowed_roles name[];
  v_grantee name;
BEGIN
  FOR v_signature, v_allowed_roles IN
    SELECT expected.signature, expected.allowed_roles
    FROM (
      VALUES
        (
          'public.can_actor_read_activity_id(uuid,uuid)',
          ARRAY[]::name[]
        ),
        (
          'public.can_service_actor_read_activity(uuid,uuid)',
          ARRAY['service_role']::name[]
        ),
        (
          'public.can_current_user_read_collection_item(text,text)',
          ARRAY['anon', 'authenticated']::name[]
        ),
        (
          'public.mutate_user_collection_atomic(text,uuid,uuid,text,boolean,boolean,boolean,text,boolean)',
          ARRAY['service_role']::name[]
        ),
        (
          'public.mutate_collection_item_atomic(text,uuid,uuid,uuid,text,text)',
          ARRAY['service_role']::name[]
        ),
        (
          'public.ensure_default_collections(uuid)',
          ARRAY['service_role']::name[]
        )
    ) AS expected(signature, allowed_roles)
  LOOP
    FOR v_grantee IN
      SELECT DISTINCT grantee_role.rolname
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner)
        )
      ) AS privilege
      JOIN pg_catalog.pg_roles AS grantee_role
        ON grantee_role.oid = privilege.grantee
      WHERE procedure.oid = pg_catalog.to_regprocedure(v_signature)
        AND privilege.privilege_type = 'EXECUTE'
        AND grantee_role.oid <> procedure.proowner
        AND NOT (grantee_role.rolname = ANY(v_allowed_roles))
      ORDER BY grantee_role.rolname
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE EXECUTE ON FUNCTION %s FROM %I CASCADE',
        v_signature,
        v_grantee
      );
    END LOOP;
  END LOOP;
END
$converge_collection_function_acl$;

DO $postflight$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_anon_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'anon'
  );
  v_authenticated_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticated'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_collection_read_source text;
  v_item_read_source text;
  v_collection_mutation_source text;
  v_item_mutation_source text;
  v_default_collection_source text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_roles AS owner_role
      ON owner_role.oid = relation.relowner
    WHERE relation.oid IN (
      'public.user_collections'::pg_catalog.regclass,
      'public.collection_items'::pg_catalog.regclass
    )
      AND (
        owner_role.rolname <> 'postgres'
        OR NOT relation.relrowsecurity
        OR relation.relforcerowsecurity
      )
  ) THEN
    RAISE EXCEPTION 'collection relation owner/RLS postflight failed';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
    'anon',
    'public.user_collections',
    'SELECT'
  ) OR NOT pg_catalog.has_table_privilege(
    'authenticated',
    'public.user_collections',
    'SELECT'
  ) OR NOT pg_catalog.has_table_privilege(
    'anon',
    'public.collection_items',
    'SELECT'
  ) OR NOT pg_catalog.has_table_privilege(
    'authenticated',
    'public.collection_items',
    'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'anon',
    'public.user_collections',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.has_table_privilege(
    'authenticated',
    'public.user_collections',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.has_table_privilege(
    'anon',
    'public.collection_items',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.has_table_privilege(
    'authenticated',
    'public.collection_items',
    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.has_any_column_privilege(
    'anon',
    'public.user_collections',
    'INSERT,UPDATE,REFERENCES'
  ) OR pg_catalog.has_any_column_privilege(
    'authenticated',
    'public.user_collections',
    'INSERT,UPDATE,REFERENCES'
  ) OR pg_catalog.has_any_column_privilege(
    'anon',
    'public.collection_items',
    'INSERT,UPDATE,REFERENCES'
  ) OR pg_catalog.has_any_column_privilege(
    'authenticated',
    'public.collection_items',
    'INSERT,UPDATE,REFERENCES'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role',
    'public.user_collections',
    'SELECT,INSERT,UPDATE,DELETE'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role',
    'public.collection_items',
    'SELECT,INSERT,UPDATE,DELETE'
  ) OR pg_catalog.has_table_privilege(
    'service_role',
    'public.user_collections',
    'TRUNCATE,REFERENCES,TRIGGER'
  ) OR pg_catalog.has_table_privilege(
    'service_role',
    'public.collection_items',
    'TRUNCATE,REFERENCES,TRIGGER'
  ) THEN
    RAISE EXCEPTION 'collection table/column ACL postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS privilege
    WHERE relation.oid IN (
      'public.user_collections'::pg_catalog.regclass,
      'public.collection_items'::pg_catalog.regclass
    )
      AND (
        privilege.grantee = 0
        OR privilege.grantee <> ALL(ARRAY[
          v_postgres_oid,
          v_anon_oid,
          v_authenticated_oid,
          v_service_oid
        ]::oid[])
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    WHERE attribute.attrelid IN (
      'public.user_collections'::pg_catalog.regclass,
      'public.collection_items'::pg_catalog.regclass
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND (
        privilege.grantee = 0
        OR privilege.grantee <> ALL(ARRAY[
          v_postgres_oid,
          v_anon_oid,
          v_authenticated_oid,
          v_service_oid
        ]::oid[])
      )
  ) THEN
    RAISE EXCEPTION 'unexpected collection ACL grantee survived convergence';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid =
        'public.user_collections'::pg_catalog.regclass
  ) <> 2 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid =
        'public.collection_items'::pg_catalog.regclass
  ) <> 2 THEN
    RAISE EXCEPTION 'collection policy set did not converge';
  END IF;

  SELECT pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
  INTO v_collection_read_source
  FROM pg_catalog.pg_policy AS policy
  WHERE policy.polrelid =
      'public.user_collections'::pg_catalog.regclass
    AND policy.polname = 'user_collections_public_or_owner_read'
    AND policy.polpermissive
    AND policy.polcmd = 'r'
    AND policy.polroles @>
      ARRAY[v_anon_oid, v_authenticated_oid]::oid[]
    AND policy.polroles <@
      ARRAY[v_anon_oid, v_authenticated_oid]::oid[]
    AND policy.polwithcheck IS NULL;

  SELECT pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
  INTO v_item_read_source
  FROM pg_catalog.pg_policy AS policy
  WHERE policy.polrelid =
      'public.collection_items'::pg_catalog.regclass
    AND policy.polname = 'collection_items_public_or_owner_read'
    AND policy.polpermissive
    AND policy.polcmd = 'r'
    AND policy.polroles @>
      ARRAY[v_anon_oid, v_authenticated_oid]::oid[]
    AND policy.polroles <@
      ARRAY[v_anon_oid, v_authenticated_oid]::oid[]
    AND policy.polwithcheck IS NULL;

  IF v_collection_read_source IS NULL
    OR pg_catalog.strpos(
      pg_catalog.lower(v_collection_read_source),
      'owner_profile.id = user_collections.user_id'
    ) = 0
    OR pg_catalog.strpos(
      pg_catalog.lower(v_collection_read_source),
      'deleted_at is null'
    ) = 0
    OR pg_catalog.strpos(
      pg_catalog.lower(v_collection_read_source),
      'banned_at is null'
    ) = 0
    OR pg_catalog.strpos(
      pg_catalog.lower(v_collection_read_source),
      'is_banned'
    ) = 0
    OR pg_catalog.strpos(
      pg_catalog.lower(v_collection_read_source),
      'ban_expires_at'
    ) = 0
    OR pg_catalog.strpos(
      pg_catalog.lower(v_collection_read_source),
      'statement_timestamp()'
    ) = 0
    OR pg_catalog.strpos(
      pg_catalog.lower(v_collection_read_source),
      'auth.uid()'
    ) = 0
    OR pg_catalog.strpos(
      pg_catalog.lower(v_collection_read_source),
      'is_public'
    ) = 0
  THEN
    RAISE EXCEPTION 'collection read policy expression is incompatible';
  END IF;

  IF v_item_read_source IS NULL
    OR pg_catalog.strpos(
      pg_catalog.lower(v_item_read_source),
      'owner_profile.id = collection.user_id'
    ) = 0
    OR pg_catalog.strpos(
      pg_catalog.lower(v_item_read_source),
      'deleted_at is null'
    ) = 0
    OR pg_catalog.strpos(
      pg_catalog.lower(v_item_read_source),
      'banned_at is null'
    ) = 0
    OR pg_catalog.strpos(
      pg_catalog.lower(v_item_read_source),
      'ban_expires_at'
    ) = 0
    OR pg_catalog.strpos(
      pg_catalog.lower(v_item_read_source),
      'auth.uid()'
    ) = 0
    OR pg_catalog.strpos(
      pg_catalog.lower(v_item_read_source),
      'can_current_user_read_collection_item'
    ) = 0
  THEN
    RAISE EXCEPTION 'collection item read policy expression is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid =
        'public.user_collections'::pg_catalog.regclass
      AND policy.polname = 'server_role_mutation'
      AND policy.polpermissive
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[v_service_oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND pg_catalog.pg_get_expr(
        policy.polwithcheck,
        policy.polrelid
      ) = 'true'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid =
        'public.collection_items'::pg_catalog.regclass
      AND policy.polname = 'server_role_mutation'
      AND policy.polpermissive
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[v_service_oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND pg_catalog.pg_get_expr(
        policy.polwithcheck,
        policy.polrelid
      ) = 'true'
  ) THEN
    RAISE EXCEPTION 'service collection policy expression is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'public.can_actor_read_activity_id(uuid,uuid)',
          'boolean'::pg_catalog.regtype,
          's'::"char"
        ),
        (
          'public.can_service_actor_read_activity(uuid,uuid)',
          'boolean'::pg_catalog.regtype,
          's'::"char"
        ),
        (
          'public.can_current_user_read_collection_item(text,text)',
          'boolean'::pg_catalog.regtype,
          's'::"char"
        ),
        (
          'public.mutate_user_collection_atomic(text,uuid,uuid,text,boolean,boolean,boolean,text,boolean)',
          'jsonb'::pg_catalog.regtype,
          'v'::"char"
        ),
        (
          'public.mutate_collection_item_atomic(text,uuid,uuid,uuid,text,text)',
          'jsonb'::pg_catalog.regtype,
          'v'::"char"
        ),
        (
          'public.ensure_default_collections(uuid)',
          'void'::pg_catalog.regtype,
          'v'::"char"
        )
    ) AS expected_function(signature, return_type, volatility)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_roles AS owner_role
        ON owner_role.oid = procedure.proowner
      WHERE procedure.oid =
          pg_catalog.to_regprocedure(expected_function.signature)
        AND owner_role.rolname = 'postgres'
        AND procedure.prokind = 'f'
        AND procedure.prorettype = expected_function.return_type
        AND procedure.provolatile = expected_function.volatility
        AND procedure.prosecdef
        AND NOT procedure.proleakproof
        AND procedure.proparallel = 'u'
        AND procedure.proconfig =
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
    )
  ) THEN
    RAISE EXCEPTION
      'collection function owner/security/search_path postflight failed';
  END IF;

  IF pg_catalog.has_function_privilege(
    'anon',
    'public.can_actor_read_activity_id(uuid,uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.can_actor_read_activity_id(uuid,uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    'public.can_actor_read_activity_id(uuid,uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    'public.can_service_actor_read_activity(uuid,uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.can_service_actor_read_activity(uuid,uuid)',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.can_service_actor_read_activity(uuid,uuid)',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'anon',
    'public.can_current_user_read_collection_item(text,text)',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'authenticated',
    'public.can_current_user_read_collection_item(text,text)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    'public.can_current_user_read_collection_item(text,text)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    'public.mutate_user_collection_atomic(text,uuid,uuid,text,boolean,boolean,boolean,text,boolean)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.mutate_user_collection_atomic(text,uuid,uuid,text,boolean,boolean,boolean,text,boolean)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    'public.mutate_collection_item_atomic(text,uuid,uuid,uuid,text,text)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.mutate_collection_item_atomic(text,uuid,uuid,uuid,text,text)',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.mutate_user_collection_atomic(text,uuid,uuid,text,boolean,boolean,boolean,text,boolean)',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.mutate_collection_item_atomic(text,uuid,uuid,uuid,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'collection function ACL postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'public.can_actor_read_activity_id(uuid,uuid)',
          ARRAY[]::name[]
        ),
        (
          'public.can_service_actor_read_activity(uuid,uuid)',
          ARRAY['service_role']::name[]
        ),
        (
          'public.can_current_user_read_collection_item(text,text)',
          ARRAY['anon', 'authenticated']::name[]
        ),
        (
          'public.mutate_user_collection_atomic(text,uuid,uuid,text,boolean,boolean,boolean,text,boolean)',
          ARRAY['service_role']::name[]
        ),
        (
          'public.mutate_collection_item_atomic(text,uuid,uuid,uuid,text,text)',
          ARRAY['service_role']::name[]
        )
    ) AS expected_function(signature, allowed_roles)
    JOIN pg_catalog.pg_proc AS procedure
      ON procedure.oid =
        pg_catalog.to_regprocedure(expected_function.signature)
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) AS privilege
    LEFT JOIN pg_catalog.pg_roles AS grantee_role
      ON grantee_role.oid = privilege.grantee
    WHERE privilege.privilege_type = 'EXECUTE'
      AND (
        privilege.grantee = 0
        OR (
          privilege.grantee <> procedure.proowner
          AND (
            grantee_role.oid IS NULL
            OR NOT (
              grantee_role.rolname =
                ANY(expected_function.allowed_roles)
            )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION
      'unexpected collection function ACL grantee survived convergence';
  END IF;

  IF pg_catalog.to_regprocedure(
    'public.ensure_default_collections(uuid)'
  ) IS NULL OR (
    pg_catalog.has_function_privilege(
      'anon',
      'public.ensure_default_collections(uuid)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'authenticated',
      'public.ensure_default_collections(uuid)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'service_role',
      'public.ensure_default_collections(uuid)',
      'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'default collection function ACL postflight failed';
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
    LEFT JOIN pg_catalog.pg_roles AS grantee_role
      ON grantee_role.oid = privilege.grantee
    WHERE procedure.oid = pg_catalog.to_regprocedure(
      'public.ensure_default_collections(uuid)'
    )
      AND privilege.privilege_type = 'EXECUTE'
      AND (
        privilege.grantee = 0
        OR (
          privilege.grantee <> procedure.proowner
          AND (
            grantee_role.oid IS NULL
            OR grantee_role.rolname <> 'service_role'
          )
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname IN (
        'can_actor_read_activity_id',
        'can_service_actor_read_activity',
        'can_current_user_read_collection_item',
        'mutate_user_collection_atomic',
        'mutate_collection_item_atomic',
        'ensure_default_collections'
      )
      AND procedure.oid <> ALL(ARRAY[
        pg_catalog.to_regprocedure(
          'public.can_actor_read_activity_id(uuid,uuid)'
        )::oid,
        pg_catalog.to_regprocedure(
          'public.can_service_actor_read_activity(uuid,uuid)'
        )::oid,
        pg_catalog.to_regprocedure(
          'public.can_current_user_read_collection_item(text,text)'
        )::oid,
        pg_catalog.to_regprocedure(
          'public.mutate_user_collection_atomic(text,uuid,uuid,text,boolean,boolean,boolean,text,boolean)'
        )::oid,
        pg_catalog.to_regprocedure(
          'public.mutate_collection_item_atomic(text,uuid,uuid,uuid,text,text)'
        )::oid,
        COALESCE(
          pg_catalog.to_regprocedure(
            'public.ensure_default_collections(uuid)'
          )::oid,
          0::oid
        )
      ]::oid[])
  ) THEN
    RAISE EXCEPTION
      'collection function overload/ACL postflight failed';
  END IF;

  SELECT pg_catalog.regexp_replace(
    pg_catalog.lower(procedure.prosrc),
    '\s+',
    ' ',
    'g'
  )
  INTO v_collection_mutation_source
  FROM pg_catalog.pg_proc AS procedure
  WHERE procedure.oid = pg_catalog.to_regprocedure(
    'public.mutate_user_collection_atomic(text,uuid,uuid,text,boolean,boolean,boolean,text,boolean)'
  );

  SELECT pg_catalog.regexp_replace(
    pg_catalog.lower(procedure.prosrc),
    '\s+',
    ' ',
    'g'
  )
  INTO v_item_mutation_source
  FROM pg_catalog.pg_proc AS procedure
  WHERE procedure.oid = pg_catalog.to_regprocedure(
    'public.mutate_collection_item_atomic(text,uuid,uuid,uuid,text,text)'
  );

  SELECT pg_catalog.regexp_replace(
    pg_catalog.lower(procedure.prosrc),
    '\s+',
    ' ',
    'g'
  )
  INTO v_default_collection_source
  FROM pg_catalog.pg_proc AS procedure
  WHERE procedure.oid = pg_catalog.to_regprocedure(
    'public.ensure_default_collections(uuid)'
  );

  IF v_collection_mutation_source IS NULL
    OR pg_catalog.strpos(
      v_collection_mutation_source,
      'auth.role()'
    ) = 0
    OR pg_catalog.strpos(
      v_collection_mutation_source,
      'p_action is null'
    ) = 0
    OR pg_catalog.strpos(
      v_collection_mutation_source,
      'on conflict (user_id, name) do nothing'
    ) = 0
    OR pg_catalog.strpos(
      v_collection_mutation_source,
      '''result_code'', ''already_exists'''
    ) = 0
  THEN
    RAISE EXCEPTION 'collection mutation function expression is incompatible';
  END IF;

  IF v_item_mutation_source IS NULL
    OR pg_catalog.strpos(
      v_item_mutation_source,
      'auth.role()'
    ) = 0
    OR pg_catalog.strpos(
      v_item_mutation_source,
      'p_action is null'
    ) = 0
    OR pg_catalog.strpos(
      v_item_mutation_source,
      'on conflict (collection_id, item_type, item_id) do nothing'
    ) = 0
    OR pg_catalog.strpos(
      v_item_mutation_source,
      'can_actor_read_post_id'
    ) = 0
    OR pg_catalog.strpos(
      v_item_mutation_source,
      'can_actor_read_activity_id'
    ) = 0
  THEN
    RAISE EXCEPTION
      'collection item mutation function expression is incompatible';
  END IF;

  IF v_default_collection_source IS NULL
    OR pg_catalog.strpos(
      v_default_collection_source,
      'auth.role()'
    ) = 0
    OR pg_catalog.strpos(
      v_default_collection_source,
      'active user required'
    ) = 0
    OR pg_catalog.strpos(
      v_default_collection_source,
      'for update'
    ) = 0
    OR pg_catalog.strpos(
      v_default_collection_source,
      'on conflict (user_id, name) do nothing'
    ) = 0
    OR pg_catalog.strpos(
      v_default_collection_source,
      '关注的交易员'
    ) = 0
    OR pg_catalog.strpos(
      v_default_collection_source,
      '我的书架'
    ) = 0
  THEN
    RAISE EXCEPTION
      'default collection function expression is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = pg_catalog.to_regprocedure(
      'public.can_actor_read_activity_id(uuid,uuid)'
    )
      AND pg_catalog.strpos(
        pg_catalog.lower(procedure.prosrc),
        'public.can_actor_read_post_id'
      ) > 0
      AND pg_catalog.strpos(
        pg_catalog.lower(procedure.prosrc),
        'statement_timestamp()'
      ) > 0
  ) THEN
    RAISE EXCEPTION 'activity audience function expression is incompatible';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
