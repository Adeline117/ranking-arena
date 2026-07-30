-- Provide an idempotent "save to this folder" authority for BookmarkModal.
-- Selecting a folder must never inherit toggle semantics: choosing the folder
-- that already contains the post is a successful no-op, not an unbookmark.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $prerequisites$
BEGIN
  IF pg_catalog.to_regprocedure('auth.uid()') IS NULL
    OR pg_catalog.to_regprocedure('auth.role()') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.lock_actor_can_interact_with_post(uuid,uuid)'
    ) IS NULL
    OR pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regclass('public.bookmark_folders') IS NULL
    OR pg_catalog.to_regclass('public.post_bookmarks') IS NULL
    OR pg_catalog.to_regclass('public.posts') IS NULL
  THEN
    RAISE EXCEPTION 'bookmark folder save foundations are unavailable';
  END IF;
END
$prerequisites$;

CREATE OR REPLACE FUNCTION public.save_post_bookmark_to_folder_atomic(
  p_post_id uuid,
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
  v_bookmark_id uuid;
  v_existing_folder_id uuid;
  v_bookmark_count bigint;
  v_status text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'authenticated role required' USING ERRCODE = '42501';
  END IF;

  IF v_actor_id IS NULL OR p_post_id IS NULL OR p_folder_id IS NULL THEN
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

  -- Share the exact lock namespace/order used by the legacy toggle and the
  -- identity-bound removal authority.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-bookmark:' || p_post_id::text || ':' || v_actor_id::text,
      0
    )
  );

  IF NOT public.lock_actor_can_interact_with_post(p_post_id, v_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'post_not_found');
  END IF;

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
  INTO v_bookmark_id, v_existing_folder_id
  FROM public.post_bookmarks AS bookmark
  WHERE bookmark.post_id = p_post_id
    AND bookmark.user_id = v_actor_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.post_bookmarks (post_id, user_id, folder_id)
    VALUES (p_post_id, v_actor_id, p_folder_id)
    RETURNING id INTO v_bookmark_id;
    v_status := 'added';
  ELSIF v_existing_folder_id IS NOT DISTINCT FROM p_folder_id
    OR (v_folder.is_default AND v_existing_folder_id IS NULL)
  THEN
    v_status := 'already_saved';
  ELSE
    UPDATE public.post_bookmarks AS bookmark
    SET folder_id = p_folder_id
    WHERE bookmark.id = v_bookmark_id
      AND bookmark.user_id = v_actor_id
      AND bookmark.post_id = p_post_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'bookmark move mutated an impossible row count';
    END IF;
    v_status := 'moved';
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
    'bookmark_id', v_bookmark_id,
    'folder_id', p_folder_id,
    'bookmarked', true,
    'bookmark_count', v_bookmark_count
  );
END
$function$;

ALTER FUNCTION public.save_post_bookmark_to_folder_atomic(uuid, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.save_post_bookmark_to_folder_atomic(uuid, uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.save_post_bookmark_to_folder_atomic(uuid, uuid)
  TO authenticated;

COMMENT ON FUNCTION public.save_post_bookmark_to_folder_atomic(uuid, uuid) IS
  'Authenticated idempotent save/move of a readable post into an owned bookmark folder; repeated selection never removes the bookmark.';

COMMIT;
