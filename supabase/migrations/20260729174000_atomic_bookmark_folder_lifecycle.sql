-- Route every authenticated bookmark-folder create/update/delete through one
-- transaction authority. The former API read a folder and then mutated it in
-- separate statements, while direct table grants let clients bypass default
-- folder protections entirely.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('atomic-bookmark-folder-lifecycle-migration', 0)
);

DO $foundations$
BEGIN
  IF pg_catalog.to_regrole('postgres') IS NULL
    OR pg_catalog.to_regrole('anon') IS NULL
    OR pg_catalog.to_regrole('authenticated') IS NULL
    OR pg_catalog.to_regrole('authenticator') IS NULL
    OR pg_catalog.to_regrole('service_role') IS NULL
    OR pg_catalog.to_regprocedure('auth.uid()') IS NULL
    OR pg_catalog.to_regprocedure('auth.role()') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.ensure_default_bookmark_folder(uuid)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.purge_bookmark_folder_subscriptions_after_scope_change()'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.install_active_authenticated_subject_mutation_barriers()'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.assert_active_authenticated_subject_mutation_barriers()'
    ) IS NULL
    OR pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regclass('public.bookmark_folders') IS NULL
    OR pg_catalog.to_regclass('public.post_bookmarks') IS NULL
    OR pg_catalog.to_regclass('public.folder_subscriptions') IS NULL
  THEN
    RAISE EXCEPTION 'atomic bookmark folder lifecycle foundations are unavailable';
  END IF;
END
$foundations$;

ALTER TABLE public.bookmark_folders OWNER TO postgres;
ALTER TABLE public.bookmark_folders ENABLE ROW LEVEL SECURITY;

DO $schema_contract$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('bookmark_folders', 'id', 'uuid'::pg_catalog.regtype, true),
        ('bookmark_folders', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('bookmark_folders', 'name', 'text'::pg_catalog.regtype, true),
        ('bookmark_folders', 'description', 'text'::pg_catalog.regtype, false),
        ('bookmark_folders', 'avatar_url', 'text'::pg_catalog.regtype, false),
        ('bookmark_folders', 'is_public', 'boolean'::pg_catalog.regtype, false),
        ('bookmark_folders', 'is_default', 'boolean'::pg_catalog.regtype, false),
        ('bookmark_folders', 'post_count', 'integer'::pg_catalog.regtype, false),
        ('bookmark_folders', 'created_at', 'timestamptz'::pg_catalog.regtype, false),
        ('bookmark_folders', 'updated_at', 'timestamptz'::pg_catalog.regtype, false),
        ('user_profiles', 'id', 'uuid'::pg_catalog.regtype, true),
        ('user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype, false),
        ('user_profiles', 'banned_at', 'timestamptz'::pg_catalog.regtype, false),
        ('user_profiles', 'is_banned', 'boolean'::pg_catalog.regtype, false),
        ('user_profiles', 'ban_expires_at', 'timestamptz'::pg_catalog.regtype, false)
    ) AS required_column(table_name, column_name, type_oid, must_be_not_null)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = attribute.attrelid
      WHERE attribute.attrelid = pg_catalog.to_regclass(
          'public.' || required_column.table_name
        )
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND relation.relowner = v_postgres
        AND attribute.attname = required_column.column_name
        AND attribute.atttypid = required_column.type_oid
        AND attribute.atttypmod = -1
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND (
          NOT required_column.must_be_not_null
          OR attribute.attnotnull
        )
    )
  ) THEN
    RAISE EXCEPTION 'atomic bookmark folder lifecycle schema is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
        'public.bookmark_folders'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 2
      AND index_row.indnatts = 2
      AND (
        SELECT pg_catalog.array_agg(attribute.attname ORDER BY key_column.ordinality)
        FROM pg_catalog.unnest(index_row.indkey)
          WITH ORDINALITY AS key_column(attribute_number, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attribute_number
      ) = ARRAY['user_id', 'name']::name[]
  ) THEN
    RAISE EXCEPTION 'bookmark folder lifecycle requires exact owner/name uniqueness';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
        'public.bookmark_folders'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND pg_catalog.pg_get_expr(
        index_row.indpred,
        index_row.indrelid
      ) = '(is_default IS TRUE)'
      AND (
        SELECT pg_catalog.array_agg(attribute.attname ORDER BY key_column.ordinality)
        FROM pg_catalog.unnest(index_row.indkey)
          WITH ORDINALITY AS key_column(attribute_number, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attribute_number
      ) = ARRAY['user_id']::name[]
  ) THEN
    RAISE EXCEPTION 'bookmark folder lifecycle requires exact default uniqueness';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
        'public.bookmark_folders'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_bookmark_folders_80_purge_subscriptions'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgfoid =
        'public.purge_bookmark_folder_subscriptions_after_scope_change()'::regprocedure
      AND trigger_row.tgenabled IN ('O', 'A')
  ) THEN
    RAISE EXCEPTION 'bookmark folder privacy purge trigger is unavailable';
  END IF;
END
$schema_contract$;

-- Keep only the existing own/public SELECT surface. Direct writes would race
-- the row-lock authority and bypass the default-folder contract.
DO $drop_mutation_policies$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.bookmark_folders'::pg_catalog.regclass
      AND policy.polcmd <> 'r'
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.bookmark_folders',
      v_policy.polname
    );
  END LOOP;
END
$drop_mutation_policies$;

REVOKE ALL ON TABLE public.bookmark_folders
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT SELECT ON TABLE public.bookmark_folders
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.read_bookmark_folder_mutation_payload(
  p_folder_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'id', folder.id,
    'user_id', folder.user_id,
    'name', folder.name,
    'description', folder.description,
    'avatar_url', folder.avatar_url,
    'is_public', COALESCE(folder.is_public, false),
    'is_default', COALESCE(folder.is_default, false),
    'post_count', (
      SELECT pg_catalog.count(*)
      FROM public.post_bookmarks AS bookmark
      WHERE bookmark.folder_id = folder.id
    ),
    'subscriber_count', (
      SELECT pg_catalog.count(*)
      FROM public.folder_subscriptions AS subscription
      WHERE subscription.folder_id = folder.id
    ),
    'created_at', folder.created_at,
    'updated_at', folder.updated_at
  )
  FROM public.bookmark_folders AS folder
  WHERE folder.id = p_folder_id
$function$;

ALTER FUNCTION public.read_bookmark_folder_mutation_payload(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.read_bookmark_folder_mutation_payload(uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

CREATE OR REPLACE FUNCTION public.mutate_bookmark_folder_atomic(
  p_action text,
  p_folder_id uuid,
  p_name text,
  p_description text,
  p_avatar_url text,
  p_is_public boolean,
  p_set_name boolean,
  p_set_description boolean,
  p_set_avatar_url boolean,
  p_set_is_public boolean
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
  v_actor_id uuid := (SELECT auth.uid());
  v_folder record;
  v_payload jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'authenticated role required' USING ERRCODE = '42501';
  END IF;

  IF v_actor_id IS NULL
    OR p_action IS NULL
    OR p_action NOT IN ('create', 'update', 'delete')
    OR p_set_name IS NULL
    OR p_set_description IS NULL
    OR p_set_avatar_url IS NULL
    OR p_set_is_public IS NULL
    OR (NOT p_set_name AND p_name IS NOT NULL)
    OR (NOT p_set_description AND p_description IS NOT NULL)
    OR (NOT p_set_avatar_url AND p_avatar_url IS NOT NULL)
    OR (NOT p_set_is_public AND p_is_public IS NOT NULL)
    OR (
      p_set_name
      AND (
        p_name IS NULL
        OR pg_catalog.length(p_name) NOT BETWEEN 1 AND 50
        OR p_name IS DISTINCT FROM pg_catalog.btrim(p_name)
        OR p_name ~ '[[:cntrl:]]'
      )
    )
    OR (
      p_set_description
      AND p_description IS NOT NULL
      AND (
        pg_catalog.length(p_description) NOT BETWEEN 1 AND 200
        OR p_description IS DISTINCT FROM pg_catalog.btrim(p_description)
        OR p_description ~ '[[:cntrl:]]'
      )
    )
    OR (
      p_set_avatar_url
      AND p_avatar_url IS NOT NULL
      AND (
        pg_catalog.length(p_avatar_url) NOT BETWEEN 1 AND 500
        OR p_avatar_url IS DISTINCT FROM pg_catalog.btrim(p_avatar_url)
        OR p_avatar_url ~ '[[:cntrl:]]'
      )
    )
    OR (p_set_is_public AND p_is_public IS NULL)
    OR (
      p_action = 'create'
      AND (
        p_folder_id IS NOT NULL
        OR NOT p_set_name
        OR NOT p_set_description
        OR NOT p_set_avatar_url
        OR NOT p_set_is_public
      )
    )
    OR (
      p_action = 'update'
      AND (
        p_folder_id IS NULL
        OR NOT (
          p_set_name
          OR p_set_description
          OR p_set_avatar_url
          OR p_set_is_public
        )
      )
    )
    OR (
      p_action = 'delete'
      AND (
        p_folder_id IS NULL
        OR p_set_name
        OR p_set_description
        OR p_set_avatar_url
        OR p_set_is_public
      )
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || v_actor_id::text,
      0
    )
  );

  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id = v_actor_id
    AND profile.deleted_at IS NULL
    AND profile.banned_at IS NULL
    AND NOT (
      profile.is_banned IS TRUE
      AND (
        profile.ban_expires_at IS NULL
        OR profile.ban_expires_at > pg_catalog.clock_timestamp()
      )
    )
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  IF p_action = 'create' THEN
    BEGIN
      INSERT INTO public.bookmark_folders (
        user_id,
        name,
        description,
        avatar_url,
        is_public,
        is_default,
        post_count,
        created_at,
        updated_at
      ) VALUES (
        v_actor_id,
        p_name,
        p_description,
        p_avatar_url,
        p_is_public,
        false,
        0,
        pg_catalog.now(),
        pg_catalog.now()
      )
      RETURNING id INTO p_folder_id;
    EXCEPTION
      WHEN unique_violation THEN
        RETURN pg_catalog.jsonb_build_object('status', 'name_conflict');
    END;

    v_payload := public.read_bookmark_folder_mutation_payload(p_folder_id);
    IF v_payload IS NULL THEN
      RAISE EXCEPTION 'created bookmark folder acknowledgement is unavailable';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'created',
      'user_id', v_actor_id,
      'folder', v_payload
    );
  END IF;

  SELECT
    folder.id,
    folder.user_id,
    folder.name,
    COALESCE(folder.is_default, false) AS is_default
  INTO v_folder
  FROM public.bookmark_folders AS folder
  WHERE folder.id = p_folder_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'folder_not_found');
  END IF;
  IF v_folder.user_id IS DISTINCT FROM v_actor_id THEN
    RETURN pg_catalog.jsonb_build_object('status', 'folder_forbidden');
  END IF;

  IF p_action = 'delete' THEN
    IF v_folder.is_default THEN
      RETURN pg_catalog.jsonb_build_object('status', 'default_protected');
    END IF;

    DELETE FROM public.bookmark_folders AS folder
    WHERE folder.id = p_folder_id
      AND folder.user_id = v_actor_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'locked bookmark folder disappeared before delete';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'status', 'deleted',
      'user_id', v_actor_id,
      'folder_id', p_folder_id
    );
  END IF;

  IF v_folder.is_default
    AND p_set_name
    AND p_name IS DISTINCT FROM v_folder.name
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'default_protected');
  END IF;

  BEGIN
    UPDATE public.bookmark_folders AS folder
    SET name = CASE WHEN p_set_name THEN p_name ELSE folder.name END,
        description = CASE
          WHEN p_set_description THEN p_description
          ELSE folder.description
        END,
        avatar_url = CASE
          WHEN p_set_avatar_url THEN p_avatar_url
          ELSE folder.avatar_url
        END,
        is_public = CASE
          WHEN p_set_is_public THEN p_is_public
          ELSE folder.is_public
        END,
        updated_at = pg_catalog.now()
    WHERE folder.id = p_folder_id
      AND folder.user_id = v_actor_id;
  EXCEPTION
    WHEN unique_violation THEN
      RETURN pg_catalog.jsonb_build_object('status', 'name_conflict');
  END;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'locked bookmark folder disappeared before update';
  END IF;

  v_payload := public.read_bookmark_folder_mutation_payload(p_folder_id);
  IF v_payload IS NULL THEN
    RAISE EXCEPTION 'updated bookmark folder acknowledgement is unavailable';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'updated',
    'user_id', v_actor_id,
    'folder', v_payload
  );
END
$function$;

ALTER FUNCTION public.mutate_bookmark_folder_atomic(
  text,
  uuid,
  text,
  text,
  text,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mutate_bookmark_folder_atomic(
  text,
  uuid,
  text,
  text,
  text,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean
) FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.mutate_bookmark_folder_atomic(
  text,
  uuid,
  text,
  text,
  text,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean
) TO authenticated;

SELECT public.install_active_authenticated_subject_mutation_barriers();
SELECT public.assert_active_authenticated_subject_mutation_barriers();

COMMENT ON FUNCTION public.mutate_bookmark_folder_atomic(
  text,
  uuid,
  text,
  text,
  text,
  boolean,
  boolean,
  boolean,
  boolean,
  boolean
) IS
  'Authenticated create/update/delete authority with account admission, exact ownership, default protection, privacy serialization, and same-transaction acknowledgements.';

COMMIT;
