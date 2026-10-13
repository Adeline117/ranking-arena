-- Quarantine every legacy system-generated arena_bot post until a future
-- receipt-bound publisher can prove the exact payload is safe to release.
--
-- The identity is a fixed system UUID, not a mutable handle/title/body
-- heuristic. This makes the closure deliberately narrow: no ordinary user or
-- same-handle account is selected by the quarantine update or write trigger.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('20260817-arena-bot-legacy-publication-isolation', 0)
);

DO $preflight$
DECLARE
  v_reader pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.can_actor_read_post_fields(uuid,uuid,uuid,text,public.post_status,timestamptz)'
  );
  v_postgres oid := pg_catalog.to_regrole('postgres');
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer < 170000
     OR pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regclass('public.posts') IS NULL
     OR v_reader IS NULL THEN
    RAISE EXCEPTION 'arena_bot publication isolation prerequisites are missing';
  END IF;

  -- These helpers are postgres-owned SECURITY DEFINER functions. Revoke is
  -- not a security boundary if another role can still reach the owner via an
  -- inherited, SET ROLE, or ADMIN-delegation chain.
  IF EXISTS (
    WITH RECURSIVE postgres_authority(member_oid, path) AS (
      SELECT
        membership.member,
        ARRAY[v_postgres, membership.member]::oid[]
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = v_postgres
        AND (
          membership.admin_option
          OR membership.inherit_option
          OR membership.set_option
        )

      UNION ALL

      SELECT
        membership.member,
        authority.path || membership.member
      FROM postgres_authority AS authority
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.roleid = authority.member_oid
      WHERE (
        membership.admin_option
        OR membership.inherit_option
        OR membership.set_option
      )
        AND NOT (membership.member = ANY(authority.path))
    )
    SELECT 1 FROM postgres_authority
  ) THEN
    RAISE EXCEPTION 'arena_bot publication owner authority graph is unsafe';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.posts'::pg_catalog.regclass
      AND attribute.attname = 'author_id'
      AND attribute.atttypid = 'uuid'::pg_catalog.regtype
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.posts'::pg_catalog.regclass
      AND attribute.attname = 'status'
      AND attribute.atttypid = 'public.post_status'::pg_catalog.regtype
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.posts'::pg_catalog.regclass
      AND attribute.attname IN ('deleted_at', 'updated_at')
      AND attribute.atttypid = 'timestamp with time zone'::pg_catalog.regtype
      AND NOT attribute.attisdropped
    GROUP BY attribute.attrelid
    HAVING pg_catalog.count(*) = 2
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.posts'::pg_catalog.regclass
      AND attribute.attname = 'delete_reason'
      AND attribute.atttypid = 'text'::pg_catalog.regtype
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'posts soft-delete substrate drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_enum AS enum_value
    WHERE enum_value.enumtypid = 'public.post_status'::pg_catalog.regtype
      AND enum_value.enumlabel = 'deleted'
  ) THEN
    RAISE EXCEPTION 'posts deleted status is unavailable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_reader
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'boolean'::pg_catalog.regtype
      AND function_row.provolatile = 's'
      AND function_row.prosecdef
      AND function_row.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'canonical post audience reader contract drifted';
  END IF;
END
$preflight$;

-- This serializes every concurrent INSERT/UPDATE/DELETE with the soft-delete
-- update and the new trigger. A writer that started first completes before the
-- update is evaluated; a later writer observes the trigger after commit.
LOCK TABLE public.posts IN SHARE ROW EXCLUSIVE MODE;

UPDATE public.posts
SET
  status = 'deleted'::public.post_status,
  deleted_at = COALESCE(deleted_at, pg_catalog.statement_timestamp()),
  delete_reason = 'unverified_legacy_arena_bot_publication',
  updated_at = pg_catalog.statement_timestamp()
WHERE author_id = '00000000-0000-0000-0000-000000000001'::uuid
  AND (
    status IS DISTINCT FROM 'deleted'::public.post_status
    OR deleted_at IS NULL
  );

-- No live bot post may be inserted, restored, or re-attributed until a later
-- receipt-bound publisher explicitly replaces this fence. Keeping archived
-- rows possible preserves the legacy evidence without making it releasable.
CREATE OR REPLACE FUNCTION public.reject_unverified_arena_bot_publication()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_arena_bot_author_id constant uuid :=
    '00000000-0000-0000-0000-000000000001'::uuid;
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
     OR TG_TABLE_NAME IS DISTINCT FROM 'posts'
     OR TG_OP NOT IN ('INSERT', 'UPDATE')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'arena_bot publication fence is misattached';
  END IF;

  IF NEW.author_id = v_arena_bot_author_id
     OR (TG_OP = 'UPDATE' AND OLD.author_id = v_arena_bot_author_id)
  THEN
    IF NEW.author_id IS DISTINCT FROM v_arena_bot_author_id
       OR NEW.status IS DISTINCT FROM 'deleted'::public.post_status
       OR NEW.deleted_at IS NULL
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'arena_bot publication receipt is required';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.reject_unverified_arena_bot_publication() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_posts_16_reject_unverified_arena_bot_publication ON public.posts;
CREATE TRIGGER trg_posts_16_reject_unverified_arena_bot_publication
BEFORE INSERT OR UPDATE
ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.reject_unverified_arena_bot_publication();

-- Preserve the current canonical reader byte-for-byte except for one narrow
-- UUID predicate. Refuse to overwrite a newer implementation whose expected
-- deny branch has drifted instead of silently weakening later audience work.
DO $patch_canonical_post_reader$
DECLARE
  v_reader constant pg_catalog.regprocedure :=
    'public.can_actor_read_post_fields(uuid,uuid,uuid,text,public.post_status,timestamptz)'::pg_catalog.regprocedure;
  v_source text;
  v_definition text;
  v_old_expression constant text := $anchor$WHEN p_author_id IS NULL
      OR p_status IS NULL$anchor$;
  v_new_expression constant text := $anchor$WHEN p_author_id IS NULL
      OR p_author_id = '00000000-0000-0000-0000-000000000001'::uuid
      OR p_status IS NULL$anchor$;
BEGIN
  SELECT function_row.prosrc,
         pg_catalog.pg_get_functiondef(function_row.oid)
  INTO STRICT v_source, v_definition
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_reader;

  IF pg_catalog.strpos(v_source, v_new_expression) = 0 THEN
    IF pg_catalog.strpos(v_source, v_old_expression) = 0
       OR pg_catalog.strpos(
            pg_catalog.replace(v_source, v_old_expression, ''),
            v_old_expression
          ) > 0
       OR pg_catalog.strpos(v_definition, v_old_expression) = 0
       OR pg_catalog.strpos(
            pg_catalog.replace(v_definition, v_old_expression, ''),
            v_old_expression
          ) > 0
    THEN
      RAISE EXCEPTION 'canonical post audience reader source changed under lock';
    END IF;

    EXECUTE pg_catalog.replace(v_definition, v_old_expression, v_new_expression);
  END IF;
END
$patch_canonical_post_reader$;

ALTER FUNCTION public.can_actor_read_post_fields(
  uuid, uuid, uuid, text, public.post_status, timestamptz
) OWNER TO postgres;

-- Converge every pre-existing grantee, including unknown delegated roles, not
-- just the usual PostgREST roles. Both helpers are internal-only: callers use
-- the post-id/service wrappers, and trigger execution needs no EXECUTE grant.
DO $converge_internal_function_acl$
DECLARE
  v_signature pg_catalog.regprocedure;
  v_owner oid;
  v_grantee name;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.can_actor_read_post_fields(uuid,uuid,uuid,text,public.post_status,timestamptz)'::pg_catalog.regprocedure,
    'public.reject_unverified_arena_bot_publication()'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT function_row.proowner
    INTO STRICT v_owner
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_signature;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE',
      v_signature
    );
    FOR v_grantee IN
      SELECT DISTINCT role_row.rolname
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_entry
      JOIN pg_catalog.pg_roles AS role_row
        ON role_row.oid = acl_entry.grantee
      WHERE function_row.oid = v_signature
        AND acl_entry.grantee <> v_owner
      ORDER BY role_row.rolname
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
        v_signature,
        v_grantee
      );
    END LOOP;
  END LOOP;
END
$converge_internal_function_acl$;

-- This legacy RPC returns title/content without the current audience decision.
-- There is no remaining app caller; revoke every overload rather than rely on
-- RLS/service-role behavior to make a raw row safe.
DO $revoke_weighted_post_search$
DECLARE
  v_signature pg_catalog.regprocedure;
  v_owner oid;
  v_grantee name;
BEGIN
  FOR v_signature IN
    SELECT function_row.oid::pg_catalog.regprocedure
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'search_posts_with_weight'
      AND function_row.prokind = 'f'
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER FUNCTION %s OWNER TO postgres',
      v_signature
    );
    SELECT function_row.proowner
    INTO STRICT v_owner
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_signature;
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE',
      v_signature
    );
    FOR v_grantee IN
      SELECT DISTINCT role_row.rolname
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_entry
      JOIN pg_catalog.pg_roles AS role_row
        ON role_row.oid = acl_entry.grantee
      WHERE function_row.oid = v_signature
        AND acl_entry.grantee <> v_owner
      ORDER BY role_row.rolname
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
        v_signature,
        v_grantee
      );
    END LOOP;
  END LOOP;
END
$revoke_weighted_post_search$;

DO $postflight$
DECLARE
  v_reader constant pg_catalog.regprocedure :=
    'public.can_actor_read_post_fields(uuid,uuid,uuid,text,public.post_status,timestamptz)'::pg_catalog.regprocedure;
  v_trigger_function constant pg_catalog.regprocedure :=
    'public.reject_unverified_arena_bot_publication()'::pg_catalog.regprocedure;
  v_signature pg_catalog.regprocedure;
  v_source text;
  v_owner oid;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.posts AS post_row
    WHERE post_row.author_id = '00000000-0000-0000-0000-000000000001'::uuid
      AND (
        post_row.status IS DISTINCT FROM 'deleted'::public.post_status
        OR post_row.deleted_at IS NULL
      )
  ) THEN
    RAISE EXCEPTION 'arena_bot legacy posts remain publicly releasable';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_reader;
  IF pg_catalog.strpos(
       v_source,
       'p_author_id = ''00000000-0000-0000-0000-000000000001''::uuid'
     ) = 0 THEN
    RAISE EXCEPTION 'canonical reader is missing the arena_bot deny';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.posts'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_posts_16_reject_unverified_arena_bot_publication'
      AND trigger_row.tgfoid = v_trigger_function
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'arena_bot publication trigger is not enabled';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[v_reader, v_trigger_function]
  LOOP
    SELECT function_row.proowner
    INTO STRICT v_owner
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_signature
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prosecdef
      AND function_row.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[];

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_entry
      WHERE function_row.oid = v_signature
        AND acl_entry.grantee <> v_owner
    ) THEN
      RAISE EXCEPTION 'arena_bot publication function ACL drifted: %', v_signature;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'search_posts_with_weight'
      AND function_row.prokind = 'f'
      AND acl_entry.grantee <> function_row.proowner
  ) THEN
    RAISE EXCEPTION 'weighted post search ACL remains public';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
