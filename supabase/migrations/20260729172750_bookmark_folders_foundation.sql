-- Restore the canonical bookmark-folder parent that live code, generated
-- types, child foreign keys, and older conditional migrations already assume.
-- The repository previously had policies and indexes for this relation but no
-- CREATE TABLE, so a recorded migration history could coexist with a missing
-- core favorites table.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('bookmark-folders-foundation-migration', 0)
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
      'public.install_active_authenticated_subject_mutation_barriers()'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.assert_active_authenticated_subject_mutation_barriers()'
    ) IS NULL
    OR pg_catalog.to_regclass('auth.users') IS NULL
    OR pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regclass('public.post_bookmarks') IS NULL
    OR pg_catalog.to_regclass('public.folder_subscriptions') IS NULL
  THEN
    RAISE EXCEPTION 'bookmark folder foundations are unavailable';
  END IF;
END
$foundations$;

CREATE TABLE IF NOT EXISTS public.bookmark_folders (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  avatar_url text,
  is_public boolean DEFAULT false,
  is_default boolean DEFAULT false,
  post_count integer DEFAULT 0,
  created_at timestamptz DEFAULT pg_catalog.now(),
  updated_at timestamptz DEFAULT pg_catalog.now(),
  CONSTRAINT bookmark_folders_user_id_name_key UNIQUE (user_id, name),
  CONSTRAINT bookmark_folders_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

ALTER TABLE public.bookmark_folders OWNER TO postgres;
ALTER TABLE public.bookmark_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookmark_folders
  ALTER COLUMN id SET DEFAULT pg_catalog.gen_random_uuid(),
  ALTER COLUMN id SET NOT NULL,
  ALTER COLUMN user_id SET NOT NULL,
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN is_public SET DEFAULT false,
  ALTER COLUMN is_default SET DEFAULT false,
  ALTER COLUMN post_count SET DEFAULT 0,
  ALTER COLUMN created_at SET DEFAULT pg_catalog.now(),
  ALTER COLUMN updated_at SET DEFAULT pg_catalog.now();

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
        ('post_bookmarks', 'folder_id', 'uuid'::pg_catalog.regtype, false),
        ('folder_subscriptions', 'folder_id', 'uuid'::pg_catalog.regtype, true),
        ('folder_subscriptions', 'user_id', 'uuid'::pg_catalog.regtype, true),
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
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.bookmark_folders'::pg_catalog.regclass
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND relation.relowner = v_postgres
  ) THEN
    RAISE EXCEPTION 'bookmark folder schema is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
        'public.bookmark_folders'::pg_catalog.regclass
      AND index_row.indisprimary
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND (
        SELECT pg_catalog.array_agg(attribute.attname ORDER BY key_column.ordinality)
        FROM pg_catalog.unnest(index_row.indkey)
          WITH ORDINALITY AS key_column(attribute_number, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attribute_number
      ) = ARRAY['id']::name[]
  ) THEN
    RAISE EXCEPTION 'bookmark folders require an exact uuid primary key';
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
    RAISE EXCEPTION 'bookmark folders require exact owner/name uniqueness';
  END IF;
END
$schema_contract$;

-- The old uniqueness migration silently skipped when this parent was absent.
-- Preserve duplicate folders while demoting duplicate defaults, then install
-- the one-default-per-user invariant that ensure_default relies on.
WITH ranked_defaults AS (
  SELECT
    folder.id,
    pg_catalog.row_number() OVER (
      PARTITION BY folder.user_id
      ORDER BY folder.created_at ASC NULLS LAST, folder.id ASC
    ) AS ordinal
  FROM public.bookmark_folders AS folder
  WHERE folder.is_default IS TRUE
)
UPDATE public.bookmark_folders AS folder
SET is_default = false
FROM ranked_defaults AS ranked
WHERE ranked.id = folder.id
  AND ranked.ordinal > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookmark_folders_one_default_per_user
  ON public.bookmark_folders (user_id)
  WHERE is_default IS TRUE;

DO $default_uniqueness$
BEGIN
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
    RAISE EXCEPTION 'bookmark folders require exact default uniqueness';
  END IF;
END
$default_uniqueness$;

CREATE INDEX IF NOT EXISTS idx_bookmark_folders_user_created
  ON public.bookmark_folders (user_id, created_at, id);

-- Add the parent and child referential contracts that older migrations could
-- not install while bookmark_folders was missing. Broken bookmark folder ids
-- are returned to the default-folder path instead of deleting the bookmark;
-- orphan subscriptions have no meaningful resource and are removed.
DO $foreign_keys$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.bookmark_folders'::pg_catalog.regclass
      AND constraint_row.conname = 'bookmark_folders_user_id_fkey'
      AND NOT (
        constraint_row.contype = 'f'
        AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
        AND constraint_row.conkey = ARRAY[
          (
            SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = constraint_row.conrelid
              AND attribute.attname = 'user_id'
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
        AND constraint_row.confdeltype = 'c'
      )
  ) THEN
    RAISE EXCEPTION 'bookmark_folders_user_id_fkey is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.bookmark_folders'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'user_id'
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
      AND constraint_row.confdeltype = 'c'
  ) THEN
    ALTER TABLE public.bookmark_folders
      ADD CONSTRAINT bookmark_folders_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.post_bookmarks'::pg_catalog.regclass
      AND constraint_row.conname = 'post_bookmarks_folder_id_fkey'
      AND NOT (
        constraint_row.contype = 'f'
        AND constraint_row.confrelid =
          'public.bookmark_folders'::pg_catalog.regclass
        AND constraint_row.conkey = ARRAY[
          (
            SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = constraint_row.conrelid
              AND attribute.attname = 'folder_id'
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
        AND constraint_row.confdeltype = 'c'
      )
  ) THEN
    RAISE EXCEPTION 'post_bookmarks_folder_id_fkey is incompatible';
  END IF;

  UPDATE public.post_bookmarks AS bookmark
  SET folder_id = NULL
  WHERE bookmark.folder_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.bookmark_folders AS folder
      WHERE folder.id = bookmark.folder_id
    );

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.post_bookmarks'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid =
        'public.bookmark_folders'::pg_catalog.regclass
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'folder_id'
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
      AND constraint_row.confdeltype = 'c'
  ) THEN
    ALTER TABLE public.post_bookmarks
      ADD CONSTRAINT post_bookmarks_folder_id_fkey
      FOREIGN KEY (folder_id)
      REFERENCES public.bookmark_folders(id) ON DELETE CASCADE;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.folder_subscriptions'::pg_catalog.regclass
      AND constraint_row.conname = 'folder_subscriptions_folder_id_fkey'
      AND NOT (
        constraint_row.contype = 'f'
        AND constraint_row.confrelid =
          'public.bookmark_folders'::pg_catalog.regclass
        AND constraint_row.conkey = ARRAY[
          (
            SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = constraint_row.conrelid
              AND attribute.attname = 'folder_id'
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
        AND constraint_row.confdeltype = 'c'
      )
  ) THEN
    RAISE EXCEPTION 'folder_subscriptions_folder_id_fkey is incompatible';
  END IF;

  DELETE FROM public.folder_subscriptions AS subscription
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.bookmark_folders AS folder
    WHERE folder.id = subscription.folder_id
  );

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.folder_subscriptions'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid =
        'public.bookmark_folders'::pg_catalog.regclass
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'folder_id'
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
      AND constraint_row.confdeltype = 'c'
  ) THEN
    ALTER TABLE public.folder_subscriptions
      ADD CONSTRAINT folder_subscriptions_folder_id_fkey
      FOREIGN KEY (folder_id)
      REFERENCES public.bookmark_folders(id) ON DELETE CASCADE;
  END IF;
END
$foreign_keys$;

DROP POLICY IF EXISTS "Users can manage own folders"
  ON public.bookmark_folders;
DROP POLICY IF EXISTS "Users can view own and public folders"
  ON public.bookmark_folders;
DROP POLICY IF EXISTS "Users can update own folders"
  ON public.bookmark_folders;
DROP POLICY IF EXISTS "Users can delete own folders"
  ON public.bookmark_folders;
DROP POLICY IF EXISTS bookmark_folders_select_visible
  ON public.bookmark_folders;
DROP POLICY IF EXISTS bookmark_folders_insert_own
  ON public.bookmark_folders;
DROP POLICY IF EXISTS bookmark_folders_update_own
  ON public.bookmark_folders;
DROP POLICY IF EXISTS bookmark_folders_delete_own
  ON public.bookmark_folders;

CREATE POLICY bookmark_folders_select_visible
  ON public.bookmark_folders
  FOR SELECT
  TO anon, authenticated
  USING (user_id = (SELECT auth.uid()) OR is_public IS TRUE);

CREATE POLICY bookmark_folders_insert_own
  ON public.bookmark_folders
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY bookmark_folders_update_own
  ON public.bookmark_folders
  FOR UPDATE
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY bookmark_folders_delete_own
  ON public.bookmark_folders
  FOR DELETE
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

REVOKE ALL ON TABLE public.bookmark_folders
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT SELECT ON TABLE public.bookmark_folders
  TO anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.bookmark_folders
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ensure_default_bookmark_folder(
  p_user_id uuid
)
RETURNS uuid
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
  v_folder_id uuid;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'authenticated'
    OR v_actor_id IS NULL
    OR p_user_id IS NULL
    OR p_user_id IS DISTINCT FROM v_actor_id
  THEN
    RAISE EXCEPTION 'authenticated folder owner required'
      USING ERRCODE = '42501';
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
    RAISE EXCEPTION 'authenticated folder owner is inactive'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'bookmark-default:' || v_actor_id::text,
      0
    )
  );

  SELECT folder.id
  INTO v_folder_id
  FROM public.bookmark_folders AS folder
  WHERE folder.user_id = v_actor_id
    AND folder.is_default IS TRUE
  ORDER BY folder.created_at ASC NULLS LAST, folder.id ASC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    SELECT folder.id
    INTO v_folder_id
    FROM public.bookmark_folders AS folder
    WHERE folder.user_id = v_actor_id
      AND folder.name = 'Default'
    ORDER BY folder.created_at ASC NULLS LAST, folder.id ASC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
      UPDATE public.bookmark_folders AS folder
      SET is_default = true,
          is_public = false,
          updated_at = pg_catalog.now()
      WHERE folder.id = v_folder_id;
    ELSE
    INSERT INTO public.bookmark_folders (
      user_id,
      name,
      is_public,
      is_default
    ) VALUES (
      v_actor_id,
      'Default',
      false,
      true
    )
    ON CONFLICT (user_id) WHERE is_default IS TRUE DO NOTHING
    RETURNING id INTO v_folder_id;

    END IF;

    IF v_folder_id IS NULL THEN
      SELECT folder.id
      INTO STRICT v_folder_id
      FROM public.bookmark_folders AS folder
      WHERE folder.user_id = v_actor_id
        AND folder.is_default IS TRUE
      ORDER BY folder.created_at ASC NULLS LAST, folder.id ASC
      LIMIT 1
      FOR UPDATE;
    END IF;
  END IF;

  RETURN v_folder_id;
END
$function$;

ALTER FUNCTION public.ensure_default_bookmark_folder(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ensure_default_bookmark_folder(uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.ensure_default_bookmark_folder(uuid)
  TO authenticated;

-- The global barrier predates this restored relation, so explicitly reinstall
-- and assert coverage instead of leaving the new write surface unguarded.
SELECT public.install_active_authenticated_subject_mutation_barriers();
SELECT public.assert_active_authenticated_subject_mutation_barriers();

COMMENT ON TABLE public.bookmark_folders IS
  'Canonical favorites folders; restored because earlier repository migrations only referenced this table conditionally.';
COMMENT ON FUNCTION public.ensure_default_bookmark_folder(uuid) IS
  'Authenticated idempotent default-folder authority serialized with account lifecycle transitions.';

COMMIT;
