-- Make bookmark-folder subscription writes a single authenticated database
-- authority. The former folder read -> duplicate read -> insert/delete -> count
-- sequence raced privacy changes and concurrent requests, while direct table
-- grants let clients subscribe to private folders by id.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'atomic-bookmark-folder-subscription-migration',
    0
  )
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
    OR pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regclass('public.bookmark_folders') IS NULL
    OR pg_catalog.to_regclass('public.folder_subscriptions') IS NULL
  THEN
    RAISE EXCEPTION 'atomic bookmark folder subscription foundations are unavailable';
  END IF;
END
$foundations$;

ALTER TABLE public.folder_subscriptions OWNER TO postgres;
ALTER TABLE public.folder_subscriptions ENABLE ROW LEVEL SECURITY;

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
        ('bookmark_folders', 'is_public', 'boolean'::pg_catalog.regtype, false),
        ('folder_subscriptions', 'id', 'uuid'::pg_catalog.regtype, true),
        ('folder_subscriptions', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('folder_subscriptions', 'folder_id', 'uuid'::pg_catalog.regtype, true),
        ('folder_subscriptions', 'created_at', 'timestamptz'::pg_catalog.regtype, true),
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
    RAISE EXCEPTION 'atomic bookmark folder subscription schema is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
        'public.folder_subscriptions'::pg_catalog.regclass
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
      ) = ARRAY['user_id', 'folder_id']::name[]
  ) THEN
    RAISE EXCEPTION 'folder subscriptions require exact actor/folder uniqueness';
  END IF;

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
      AND constraint_row.convalidated
  ) THEN
    RAISE EXCEPTION 'folder subscriptions require the canonical folder cascade';
  END IF;
END
$schema_contract$;

-- Remove rows that the old permissive insert policy allowed clients to create.
-- Folder row locks below and the privacy trigger keep this invariant true after
-- migration commit.
DELETE FROM public.folder_subscriptions AS subscription
USING public.bookmark_folders AS folder
WHERE folder.id = subscription.folder_id
  AND (
    folder.is_public IS DISTINCT FROM true
    OR folder.user_id = subscription.user_id
  );

DROP POLICY IF EXISTS "Users can view own subscriptions"
  ON public.folder_subscriptions;
DROP POLICY IF EXISTS "Users can manage own subscriptions"
  ON public.folder_subscriptions;
DROP POLICY IF EXISTS "Users can subscribe to public folders"
  ON public.folder_subscriptions;
DROP POLICY IF EXISTS "Users can create own subscriptions"
  ON public.folder_subscriptions;
DROP POLICY IF EXISTS "Users can update own subscriptions"
  ON public.folder_subscriptions;
DROP POLICY IF EXISTS "Users can delete own subscriptions"
  ON public.folder_subscriptions;
DROP POLICY IF EXISTS "Subscriptions of public folders are viewable"
  ON public.folder_subscriptions;
DROP POLICY IF EXISTS folder_subscriptions_select_own
  ON public.folder_subscriptions;
DROP POLICY IF EXISTS folder_subscriptions_select_public_folder
  ON public.folder_subscriptions;

-- Remove every mutation policy, including an unknown legacy FOR ALL policy.
DO $drop_mutation_policies$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid =
        'public.folder_subscriptions'::pg_catalog.regclass
      AND policy.polcmd <> 'r'
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.folder_subscriptions',
      v_policy.polname
    );
  END LOOP;
END
$drop_mutation_policies$;

CREATE POLICY folder_subscriptions_select_own
  ON public.folder_subscriptions
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Existing public pages obtain exact subscriber counts through SELECT HEAD.
-- Keep only this read surface; every write is function-owned below.
CREATE POLICY folder_subscriptions_select_public_folder
  ON public.folder_subscriptions
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.bookmark_folders AS folder
      WHERE folder.id = folder_subscriptions.folder_id
        AND folder.is_public IS TRUE
    )
  );

REVOKE ALL ON TABLE public.folder_subscriptions
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT SELECT ON TABLE public.folder_subscriptions
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.purge_bookmark_folder_subscriptions_after_scope_change()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
BEGIN
  IF TG_LEVEL IS DISTINCT FROM 'ROW'
    OR TG_WHEN IS DISTINCT FROM 'AFTER'
    OR TG_OP IS DISTINCT FROM 'UPDATE'
    OR TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
    OR TG_TABLE_NAME IS DISTINCT FROM 'bookmark_folders'
    OR NEW.id IS NULL
    OR NEW.user_id IS NULL
    OR OLD.id IS DISTINCT FROM NEW.id
  THEN
    RAISE EXCEPTION 'bookmark folder subscription purge is attached outside its contract'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.is_public IS DISTINCT FROM true
    OR OLD.user_id IS DISTINCT FROM NEW.user_id
  THEN
    DELETE FROM public.folder_subscriptions AS subscription
    WHERE subscription.folder_id = NEW.id
      AND (
        NEW.is_public IS DISTINCT FROM true
        OR subscription.user_id = NEW.user_id
      );
  END IF;

  RETURN NULL;
END
$function$;

ALTER FUNCTION public.purge_bookmark_folder_subscriptions_after_scope_change()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.purge_bookmark_folder_subscriptions_after_scope_change()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

DROP TRIGGER IF EXISTS trg_bookmark_folders_80_purge_subscriptions
  ON public.bookmark_folders;
CREATE TRIGGER trg_bookmark_folders_80_purge_subscriptions
  AFTER UPDATE OF is_public, user_id
  ON public.bookmark_folders
  FOR EACH ROW
  EXECUTE FUNCTION public.purge_bookmark_folder_subscriptions_after_scope_change();

CREATE OR REPLACE FUNCTION public.mutate_bookmark_folder_subscription_atomic(
  p_folder_id uuid,
  p_action text
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
  v_mutated integer;
  v_subscriber_count bigint;
  v_status text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'authenticated role required' USING ERRCODE = '42501';
  END IF;

  IF v_actor_id IS NULL
    OR p_folder_id IS NULL
    OR p_action IS NULL
    OR p_action NOT IN ('add', 'remove')
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  -- Coordinate with account deletion, recovery, bans, and the global stale-JWT
  -- write barrier before locking any favorites-domain row.
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

  -- One row lock serializes subscription writes and owner privacy/identity
  -- changes. The returned count therefore belongs to the mutation transaction.
  SELECT folder.id, folder.user_id, folder.is_public
  INTO v_folder
  FROM public.bookmark_folders AS folder
  WHERE folder.id = p_folder_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'folder_not_found');
  END IF;

  IF p_action = 'add' THEN
    IF v_folder.user_id = v_actor_id THEN
      RETURN pg_catalog.jsonb_build_object('status', 'owner_forbidden');
    END IF;
    IF v_folder.is_public IS DISTINCT FROM true THEN
      RETURN pg_catalog.jsonb_build_object('status', 'folder_private');
    END IF;

    INSERT INTO public.folder_subscriptions (user_id, folder_id)
    VALUES (v_actor_id, p_folder_id)
    ON CONFLICT (user_id, folder_id) DO NOTHING;
    GET DIAGNOSTICS v_mutated = ROW_COUNT;

    IF v_mutated = 1 THEN
      v_status := 'added';
    ELSIF v_mutated = 0 THEN
      v_status := 'already_subscribed';
    ELSE
      RAISE EXCEPTION 'folder subscription add mutated an impossible row count';
    END IF;
  ELSE
    DELETE FROM public.folder_subscriptions AS subscription
    WHERE subscription.user_id = v_actor_id
      AND subscription.folder_id = p_folder_id;
    GET DIAGNOSTICS v_mutated = ROW_COUNT;

    IF v_mutated = 1 THEN
      v_status := 'removed';
    ELSIF v_mutated = 0 THEN
      v_status := 'not_subscribed';
    ELSE
      RAISE EXCEPTION 'folder subscription remove mutated an impossible row count';
    END IF;
  END IF;

  SELECT pg_catalog.count(*)
  INTO STRICT v_subscriber_count
  FROM public.folder_subscriptions AS subscription
  WHERE subscription.folder_id = p_folder_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_status,
    'user_id', v_actor_id,
    'folder_id', p_folder_id,
    'is_subscribed', v_status IN ('added', 'already_subscribed'),
    'subscriber_count', v_subscriber_count
  );
END
$function$;

ALTER FUNCTION public.mutate_bookmark_folder_subscription_atomic(uuid, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mutate_bookmark_folder_subscription_atomic(uuid, text)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.mutate_bookmark_folder_subscription_atomic(uuid, text)
  TO authenticated;

SELECT public.install_active_authenticated_subject_mutation_barriers();
SELECT public.assert_active_authenticated_subject_mutation_barriers();

COMMENT ON FUNCTION public.mutate_bookmark_folder_subscription_atomic(uuid, text) IS
  'Authenticated add/remove authority serialized with folder privacy, account lifecycle, idempotency, and exact subscriber counts.';
COMMENT ON FUNCTION public.purge_bookmark_folder_subscriptions_after_scope_change() IS
  'Deletes subscriptions transactionally when a folder becomes private or changes owner.';

COMMIT;
