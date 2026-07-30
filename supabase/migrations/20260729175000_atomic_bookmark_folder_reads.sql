-- Read bookmark-folder lists and details through service-only, stable snapshot
-- authorities. The API uses a service client, so raw multi-query reads can
-- otherwise tear across commits and can bypass post audience RLS entirely.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $prerequisites$
BEGIN
  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.can_actor_read_post_id(uuid,uuid)'
    ) IS NULL
    OR pg_catalog.to_regclass('public.bookmark_folders') IS NULL
    OR pg_catalog.to_regclass('public.folder_subscriptions') IS NULL
    OR pg_catalog.to_regclass('public.post_bookmarks') IS NULL
    OR pg_catalog.to_regclass('public.posts') IS NULL
    OR pg_catalog.to_regclass('public.user_profiles') IS NULL
  THEN
    RAISE EXCEPTION 'bookmark folder read foundations are unavailable';
  END IF;
END
$prerequisites$;

CREATE OR REPLACE FUNCTION public.bookmark_folder_profile_is_active(
  p_profile_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles AS profile
    WHERE profile.id = p_profile_id
      AND profile.deleted_at IS NULL
      AND profile.banned_at IS NULL
      AND NOT (
        profile.is_banned IS TRUE
        AND (
          profile.ban_expires_at IS NULL
          OR profile.ban_expires_at > pg_catalog.statement_timestamp()
        )
      )
  )
$function$;

ALTER FUNCTION public.bookmark_folder_profile_is_active(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.bookmark_folder_profile_is_active(uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

CREATE OR REPLACE FUNCTION public.read_bookmark_folder_visible_post_count(
  p_folder_id uuid,
  p_owner_id uuid,
  p_is_default boolean,
  p_actor_id uuid
)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT pg_catalog.count(*)
  FROM public.post_bookmarks AS bookmark
  WHERE bookmark.user_id = p_owner_id
    AND (
      bookmark.folder_id = p_folder_id
      OR (p_is_default IS TRUE AND bookmark.folder_id IS NULL)
    )
    AND public.can_actor_read_post_id(bookmark.post_id, p_actor_id)
$function$;

ALTER FUNCTION public.read_bookmark_folder_visible_post_count(
  uuid,
  uuid,
  boolean,
  uuid
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.read_bookmark_folder_visible_post_count(
  uuid,
  uuid,
  boolean,
  uuid
) FROM PUBLIC, anon, authenticated, authenticator, service_role;

CREATE OR REPLACE FUNCTION public.read_bookmark_folder_snapshot_payload(
  p_folder_id uuid,
  p_actor_id uuid
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
    'post_count', public.read_bookmark_folder_visible_post_count(
      folder.id,
      folder.user_id,
      COALESCE(folder.is_default, false),
      p_actor_id
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

ALTER FUNCTION public.read_bookmark_folder_snapshot_payload(uuid, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.read_bookmark_folder_snapshot_payload(uuid, uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

CREATE OR REPLACE FUNCTION public.read_owned_bookmark_folders_snapshot(
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_folders jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  IF NOT public.bookmark_folder_profile_is_active(p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'actor_inactive');
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      public.read_bookmark_folder_snapshot_payload(folder.id, p_actor_id)
      ORDER BY
        COALESCE(folder.is_default, false) DESC,
        folder.created_at ASC NULLS LAST,
        folder.id ASC
    ),
    '[]'::jsonb
  )
  INTO v_folders
  FROM public.bookmark_folders AS folder
  WHERE folder.user_id = p_actor_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'actor_id', p_actor_id,
    'folders', v_folders
  );
END
$function$;

ALTER FUNCTION public.read_owned_bookmark_folders_snapshot(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.read_owned_bookmark_folders_snapshot(uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.read_owned_bookmark_folders_snapshot(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.read_subscribed_bookmark_folders_snapshot(
  p_actor_id uuid,
  p_limit integer,
  p_offset integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_folders jsonb;
  v_has_more boolean;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL
    OR p_limit IS NULL
    OR p_limit NOT BETWEEN 1 AND 50
    OR p_offset IS NULL
    OR p_offset < 0
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  IF NOT public.bookmark_folder_profile_is_active(p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'actor_inactive');
  END IF;

  WITH lookahead AS MATERIALIZED (
    SELECT
      subscription.id AS subscription_id,
      subscription.created_at AS subscribed_at,
      folder.id AS folder_id,
      folder.user_id AS owner_id,
      owner.handle AS owner_handle,
      owner.avatar_url AS owner_avatar_url
    FROM public.folder_subscriptions AS subscription
    JOIN public.bookmark_folders AS folder
      ON folder.id = subscription.folder_id
    JOIN public.user_profiles AS owner
      ON owner.id = folder.user_id
    WHERE subscription.user_id = p_actor_id
      AND folder.is_public IS TRUE
      AND public.bookmark_folder_profile_is_active(folder.user_id)
    ORDER BY subscription.created_at DESC, subscription.id DESC
    OFFSET p_offset
    LIMIT p_limit + 1
  ),
  page AS (
    SELECT *
    FROM lookahead
    ORDER BY subscribed_at DESC, subscription_id DESC
    LIMIT p_limit
  )
  SELECT
    (SELECT pg_catalog.count(*) > p_limit FROM lookahead),
    COALESCE(
      pg_catalog.jsonb_agg(
        public.read_bookmark_folder_snapshot_payload(page.folder_id, p_actor_id)
        || pg_catalog.jsonb_build_object(
          'owner_id', page.owner_id,
          'owner_handle', page.owner_handle,
          'owner_avatar_url', page.owner_avatar_url,
          'subscribed_at', page.subscribed_at
        )
        ORDER BY page.subscribed_at DESC, page.subscription_id DESC
      ),
      '[]'::jsonb
    )
  INTO v_has_more, v_folders
  FROM page;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'actor_id', p_actor_id,
    'folders', v_folders,
    'pagination', pg_catalog.jsonb_build_object(
      'limit', p_limit,
      'offset', p_offset,
      'has_more', COALESCE(v_has_more, false)
    )
  );
END
$function$;

ALTER FUNCTION public.read_subscribed_bookmark_folders_snapshot(
  uuid,
  integer,
  integer
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.read_subscribed_bookmark_folders_snapshot(
  uuid,
  integer,
  integer
) FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.read_subscribed_bookmark_folders_snapshot(
  uuid,
  integer,
  integer
) TO service_role;

CREATE OR REPLACE FUNCTION public.read_profile_bookmark_folders_snapshot(
  p_actor_id uuid,
  p_profile_id uuid,
  p_include_private boolean
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_folders jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_profile_id IS NULL
    OR p_include_private IS NULL
    OR (p_include_private AND p_actor_id IS DISTINCT FROM p_profile_id)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  IF p_actor_id IS NOT NULL
    AND NOT public.bookmark_folder_profile_is_active(p_actor_id)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'actor_inactive');
  END IF;
  IF NOT public.bookmark_folder_profile_is_active(p_profile_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'profile_not_found');
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      public.read_bookmark_folder_snapshot_payload(folder.id, p_actor_id)
      ORDER BY
        COALESCE(folder.is_default, false) DESC,
        folder.created_at DESC NULLS LAST,
        folder.id ASC
    ),
    '[]'::jsonb
  )
  INTO v_folders
  FROM public.bookmark_folders AS folder
  WHERE folder.user_id = p_profile_id
    AND (p_include_private OR folder.is_public IS TRUE);

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'actor_id', p_actor_id,
    'profile_id', p_profile_id,
    'include_private', p_include_private,
    'folders', v_folders
  );
END
$function$;

ALTER FUNCTION public.read_profile_bookmark_folders_snapshot(
  uuid,
  uuid,
  boolean
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.read_profile_bookmark_folders_snapshot(
  uuid,
  uuid,
  boolean
) FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.read_profile_bookmark_folders_snapshot(
  uuid,
  uuid,
  boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.read_bookmark_folder_detail_snapshot(
  p_actor_id uuid,
  p_folder_id uuid,
  p_limit integer,
  p_offset integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_folder record;
  v_posts jsonb;
  v_post_count bigint;
  v_subscriber_count bigint;
  v_has_more boolean;
  v_is_owner boolean;
  v_is_subscribed boolean;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_folder_id IS NULL
    OR p_limit IS NULL
    OR p_limit NOT BETWEEN 1 AND 50
    OR p_offset IS NULL
    OR p_offset < 0
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  IF p_actor_id IS NOT NULL
    AND NOT public.bookmark_folder_profile_is_active(p_actor_id)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'actor_inactive');
  END IF;

  SELECT
    folder.id,
    folder.user_id,
    folder.name,
    folder.description,
    folder.avatar_url,
    COALESCE(folder.is_public, false) AS is_public,
    COALESCE(folder.is_default, false) AS is_default,
    folder.created_at,
    folder.updated_at,
    owner.handle AS owner_handle,
    owner.avatar_url AS owner_avatar_url
  INTO v_folder
  FROM public.bookmark_folders AS folder
  JOIN public.user_profiles AS owner
    ON owner.id = folder.user_id
  WHERE folder.id = p_folder_id
    AND public.bookmark_folder_profile_is_active(folder.user_id);

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'folder_not_found');
  END IF;

  v_is_owner := p_actor_id IS NOT NULL AND p_actor_id = v_folder.user_id;
  IF NOT v_folder.is_public AND NOT v_is_owner THEN
    RETURN pg_catalog.jsonb_build_object('status', 'folder_forbidden');
  END IF;

  WITH visible_bookmarks AS MATERIALIZED (
    SELECT
      bookmark.id AS bookmark_id,
      COALESCE(bookmark.created_at, post.created_at) AS bookmarked_at,
      post.id,
      post.title,
      post.content,
      post.author_id,
      post.author_handle,
      post.group_id,
      post.like_count,
      post.comment_count,
      post.bookmark_count,
      post.created_at
    FROM public.post_bookmarks AS bookmark
    JOIN public.posts AS post
      ON post.id = bookmark.post_id
    WHERE bookmark.user_id = v_folder.user_id
      AND (
        bookmark.folder_id = v_folder.id
        OR (v_folder.is_default AND bookmark.folder_id IS NULL)
      )
      AND public.can_actor_read_post_id(post.id, p_actor_id)
  ),
  lookahead AS MATERIALIZED (
    SELECT *
    FROM visible_bookmarks
    ORDER BY bookmarked_at DESC NULLS LAST, bookmark_id DESC
    OFFSET p_offset
    LIMIT p_limit + 1
  ),
  page AS (
    SELECT *
    FROM lookahead
    ORDER BY bookmarked_at DESC NULLS LAST, bookmark_id DESC
    LIMIT p_limit
  )
  SELECT
    (SELECT pg_catalog.count(*) FROM visible_bookmarks),
    (SELECT pg_catalog.count(*) > p_limit FROM lookahead),
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'bookmark_id', page.bookmark_id,
          'bookmarked_at', page.bookmarked_at,
          'id', page.id,
          'title', page.title,
          'content', page.content,
          'author_id', page.author_id,
          'author_handle', page.author_handle,
          'group_id', page.group_id,
          'like_count', page.like_count,
          'comment_count', page.comment_count,
          'bookmark_count', page.bookmark_count,
          'created_at', page.created_at
        )
        ORDER BY page.bookmarked_at DESC NULLS LAST, page.bookmark_id DESC
      ),
      '[]'::jsonb
    )
  INTO v_post_count, v_has_more, v_posts
  FROM page;

  SELECT pg_catalog.count(*)
  INTO v_subscriber_count
  FROM public.folder_subscriptions AS subscription
  WHERE subscription.folder_id = v_folder.id;

  v_is_subscribed := NOT v_is_owner
    AND p_actor_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.folder_subscriptions AS subscription
      WHERE subscription.folder_id = v_folder.id
        AND subscription.user_id = p_actor_id
    );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'actor_id', p_actor_id,
    'folder', pg_catalog.jsonb_build_object(
      'id', v_folder.id,
      'user_id', v_folder.user_id,
      'name', v_folder.name,
      'description', v_folder.description,
      'avatar_url', v_folder.avatar_url,
      'is_public', v_folder.is_public,
      'is_default', v_folder.is_default,
      'post_count', v_post_count,
      'subscriber_count', v_subscriber_count,
      'created_at', v_folder.created_at,
      'updated_at', v_folder.updated_at,
      'owner_handle', v_folder.owner_handle,
      'owner_avatar_url', v_folder.owner_avatar_url
    ),
    'posts', v_posts,
    'is_owner', v_is_owner,
    'is_subscribed', v_is_subscribed,
    'pagination', pg_catalog.jsonb_build_object(
      'limit', p_limit,
      'offset', p_offset,
      'has_more', COALESCE(v_has_more, false)
    )
  );
END
$function$;

ALTER FUNCTION public.read_bookmark_folder_detail_snapshot(
  uuid,
  uuid,
  integer,
  integer
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.read_bookmark_folder_detail_snapshot(
  uuid,
  uuid,
  integer,
  integer
) FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.read_bookmark_folder_detail_snapshot(
  uuid,
  uuid,
  integer,
  integer
) TO service_role;

COMMENT ON FUNCTION public.read_owned_bookmark_folders_snapshot(uuid) IS
  'Service-only stable snapshot of an active owner bookmark-folder list with current visible counts.';
COMMENT ON FUNCTION public.read_subscribed_bookmark_folders_snapshot(uuid, integer, integer) IS
  'Service-only stable snapshot of current public subscriptions, owner state, counts, and lookahead pagination.';
COMMENT ON FUNCTION public.read_profile_bookmark_folders_snapshot(uuid, uuid, boolean) IS
  'Service-only stable snapshot of an active profile folder list with server-enforced private scope.';
COMMENT ON FUNCTION public.read_bookmark_folder_detail_snapshot(uuid, uuid, integer, integer) IS
  'Service-only stable folder detail snapshot with current privacy, post audience, counts, subscription state, and lookahead pagination.';

COMMIT;
