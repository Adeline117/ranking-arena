-- Replace folder-detail "remove" toggles with an identity-bound, idempotent
-- delete authority. A stale toggle can otherwise recreate the bookmark in the
-- default folder while the UI reports a successful removal.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $prerequisites$
BEGIN
  IF pg_catalog.to_regprocedure('auth.uid()') IS NULL
    OR pg_catalog.to_regprocedure('auth.role()') IS NULL
    OR pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regclass('public.bookmark_folders') IS NULL
    OR pg_catalog.to_regclass('public.post_bookmarks') IS NULL
    OR pg_catalog.to_regclass('public.posts') IS NULL
  THEN
    RAISE EXCEPTION 'bookmark post removal foundations are unavailable';
  END IF;
END
$prerequisites$;

CREATE OR REPLACE FUNCTION public.remove_post_bookmark_from_folder_atomic(
  p_post_id uuid,
  p_bookmark_id uuid,
  p_folder_id uuid
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
  v_bookmark record;
  v_bookmark_count bigint;
  v_deleted integer;
  v_status text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'authenticated role required' USING ERRCODE = '42501';
  END IF;

  IF v_actor_id IS NULL
    OR p_post_id IS NULL
    OR p_bookmark_id IS NULL
    OR p_folder_id IS NULL
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  -- Serialize against account deletion/recovery and stale-JWT write barriers.
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

  -- Coordinate with the existing toggle authority for this actor/post pair.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-bookmark:' || p_post_id::text || ':' || v_actor_id::text,
      0
    )
  );

  SELECT folder.id, COALESCE(folder.is_default, false) AS is_default
  INTO v_folder
  FROM public.bookmark_folders AS folder
  WHERE folder.id = p_folder_id
    AND folder.user_id = v_actor_id
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'folder_not_found');
  END IF;

  SELECT bookmark.id, bookmark.folder_id
  INTO v_bookmark
  FROM public.post_bookmarks AS bookmark
  WHERE bookmark.user_id = v_actor_id
    AND bookmark.post_id = p_post_id
  FOR UPDATE;

  IF NOT FOUND THEN
    v_status := 'already_removed';
  ELSIF v_bookmark.id IS DISTINCT FROM p_bookmark_id
    OR NOT (
      v_bookmark.folder_id IS NOT DISTINCT FROM p_folder_id
      OR (v_folder.is_default AND v_bookmark.folder_id IS NULL)
    )
  THEN
    -- A later move/re-add is a new user intent. Never delete it using a stale
    -- detail row and never turn the mismatch into a toggle.
    RETURN pg_catalog.jsonb_build_object('status', 'conflict');
  ELSE
    DELETE FROM public.post_bookmarks AS bookmark
    WHERE bookmark.id = p_bookmark_id
      AND bookmark.user_id = v_actor_id
      AND bookmark.post_id = p_post_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'bookmark removal mutated an impossible row count';
    END IF;
    v_status := 'removed';
  END IF;

  SELECT pg_catalog.count(*)
  INTO STRICT v_bookmark_count
  FROM public.post_bookmarks AS bookmark
  WHERE bookmark.post_id = p_post_id;

  UPDATE public.posts AS post
  SET bookmark_count = v_bookmark_count
  WHERE post.id = p_post_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_status,
    'user_id', v_actor_id,
    'post_id', p_post_id,
    'bookmark_id', p_bookmark_id,
    'folder_id', p_folder_id,
    'bookmarked', false,
    'bookmark_count', v_bookmark_count
  );
END
$function$;

ALTER FUNCTION public.remove_post_bookmark_from_folder_atomic(uuid, uuid, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_post_bookmark_from_folder_atomic(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.remove_post_bookmark_from_folder_atomic(uuid, uuid, uuid)
  TO authenticated;

COMMENT ON FUNCTION public.remove_post_bookmark_from_folder_atomic(uuid, uuid, uuid) IS
  'Authenticated identity-bound folder bookmark removal; idempotent absence succeeds, while a moved or re-added bookmark conflicts and is never deleted.';

COMMIT;
