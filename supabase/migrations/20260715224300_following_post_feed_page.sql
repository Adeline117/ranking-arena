-- Replace the live-only, client-callable get_following_feed(actor) function
-- with one service-only page query. Following membership, canonical wrapper
-- and root audience, filtering, ordering, look-ahead, and cursor derivation
-- are evaluated by one SQL statement/snapshot. No followed-ID expansion is
-- sent through PostgREST URLs.

BEGIN;

-- Retire every phantom overload from all API roles. The application switches
-- to get_following_posts_page below; keeping service EXECUTE would make an
-- accidental legacy call silently bypass the new contract.
DO $$
DECLARE
  v_signature regprocedure;
BEGIN
  FOR v_signature IN
    SELECT function_row.oid::regprocedure
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'get_following_feed'
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',
      v_signature
    );
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION public.get_following_posts_page(
  p_viewer_id uuid,
  p_limit integer DEFAULT 20,
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_group_id uuid DEFAULT NULL,
  p_group_ids uuid[] DEFAULT NULL,
  p_author_handle text DEFAULT NULL,
  p_language text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'service role required';
  END IF;

  IF p_viewer_id IS NULL
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR ((p_before_created_at IS NULL) <> (p_before_id IS NULL))
     OR (p_group_ids IS NOT NULL AND cardinality(p_group_ids) > 100)
     OR (p_author_handle IS NOT NULL AND length(p_author_handle) > 64)
     OR (p_language IS NOT NULL AND length(p_language) > 16)
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid following feed page input';
  END IF;

  -- This SELECT is the only business-data statement in the function.
  -- Under READ COMMITTED it receives one statement snapshot, so follow/block/
  -- group/root facts cannot come from different points in time.
  WITH active_viewer AS MATERIALIZED (
    SELECT viewer_profile.id
    FROM public.user_profiles AS viewer_profile
    WHERE viewer_profile.id = p_viewer_id
      AND viewer_profile.banned_at IS NULL
      AND viewer_profile.deleted_at IS NULL
  ),
  following_total AS MATERIALIZED (
    SELECT count(*)::integer AS value
    FROM public.user_follows AS follow_count
    WHERE follow_count.follower_id = p_viewer_id
      AND EXISTS (SELECT 1 FROM active_viewer)
  ),
  candidates AS MATERIALIZED (
    SELECT
      wrapper.id,
      wrapper.title,
      wrapper.content,
      wrapper.author_id,
      COALESCE(author_profile.handle, wrapper.author_handle) AS author_handle,
      author_profile.avatar_url AS author_avatar_url,
      COALESCE(author_profile.subscription_tier = 'pro', false) AS author_is_pro,
      COALESCE(author_profile.show_pro_badge, true) AS author_show_pro_badge,
      wrapper.group_id,
      post_group.name AS group_name,
      post_group.name_en AS group_name_en,
      COALESCE(wrapper.poll_enabled, false) AS poll_enabled,
      wrapper.poll_id,
      COALESCE(wrapper.poll_bull, 0) AS poll_bull,
      COALESCE(wrapper.poll_bear, 0) AS poll_bear,
      COALESCE(wrapper.poll_wait, 0) AS poll_wait,
      COALESCE(wrapper.like_count, 0) AS like_count,
      COALESCE(wrapper.dislike_count, 0) AS dislike_count,
      COALESCE(wrapper.comment_count, 0) AS comment_count,
      COALESCE(wrapper.bookmark_count, 0) AS bookmark_count,
      COALESCE(wrapper.repost_count, 0) AS repost_count,
      COALESCE(wrapper.view_count, 0) AS view_count,
      COALESCE(wrapper.hot_score, 0) AS hot_score,
      COALESCE(wrapper.is_pinned, false) AS is_pinned,
      wrapper.images,
      wrapper.created_at,
      wrapper.updated_at,
      wrapper.original_post_id,
      wrapper.visibility,
      (
        COALESCE(wrapper.is_sensitive, false)
        OR (
          wrapper.original_post_id IS NOT NULL
          AND COALESCE(root.is_sensitive, false)
        )
      ) AS is_sensitive,
      CASE
        WHEN wrapper.original_post_id IS NOT NULL AND root.is_sensitive IS TRUE
          THEN COALESCE(wrapper.content_warning, root.content_warning)
        ELSE wrapper.content_warning
      END AS content_warning,
      COALESCE(wrapper.language, 'zh') AS language,
      CASE
        WHEN wrapper.original_post_id IS NULL THEN NULL::jsonb
        ELSE jsonb_build_object(
          'id', root.id,
          'title', root.title,
          'content', root.content,
          'author_handle', COALESCE(root_profile.handle, root.author_handle),
          'author_avatar_url', root_profile.avatar_url,
          'author_is_pro', COALESCE(root_profile.subscription_tier = 'pro', false),
          'author_show_pro_badge', COALESCE(root_profile.show_pro_badge, true),
          'images', root.images,
          'created_at', root.created_at
        )
      END AS original_post
    FROM public.posts AS wrapper
    LEFT JOIN public.groups AS post_group
      ON post_group.id = wrapper.group_id
    LEFT JOIN public.user_profiles AS author_profile
      ON author_profile.id = wrapper.author_id
    LEFT JOIN public.posts AS root
      ON root.id = wrapper.original_post_id
      AND root.original_post_id IS NULL
    LEFT JOIN public.user_profiles AS root_profile
      ON root_profile.id = root.author_id
    WHERE EXISTS (SELECT 1 FROM active_viewer)
      AND EXISTS (
        SELECT 1
        FROM public.user_follows AS followed_author
        WHERE followed_author.follower_id = p_viewer_id
          AND followed_author.following_id = wrapper.author_id
      )
      AND public.can_actor_read_post_fields(
        p_viewer_id,
        wrapper.author_id,
        wrapper.group_id,
        wrapper.visibility,
        wrapper.status,
        wrapper.deleted_at
      )
      AND (
        wrapper.original_post_id IS NULL
        OR (
          root.id IS NOT NULL
          AND public.can_actor_read_post_fields(
            p_viewer_id,
            root.author_id,
            root.group_id,
            root.visibility,
            root.status,
            root.deleted_at
          )
        )
      )
      AND (p_group_id IS NULL OR wrapper.group_id = p_group_id)
      -- Preserve the legacy single-group precedence when both filters arrive.
      AND (
        p_group_id IS NOT NULL
        OR p_group_ids IS NULL
        OR wrapper.group_id = ANY(p_group_ids)
      )
      AND (
        p_author_handle IS NULL
        OR COALESCE(author_profile.handle, wrapper.author_handle) = p_author_handle
      )
      AND (p_language IS NULL OR wrapper.language = p_language)
      AND (
        p_before_created_at IS NULL
        OR (wrapper.created_at, wrapper.id) < (p_before_created_at, p_before_id)
      )
    ORDER BY wrapper.created_at DESC, wrapper.id DESC
    LIMIT p_limit + 1
  ),
  page_rows AS MATERIALIZED (
    SELECT *
    FROM candidates
    ORDER BY created_at DESC, id DESC
    LIMIT p_limit
  ),
  page_tail AS (
    SELECT page_row.created_at, page_row.id
    FROM page_rows AS page_row
    ORDER BY page_row.created_at ASC, page_row.id ASC
    LIMIT 1
  ),
  page_state AS (
    SELECT (SELECT count(*) FROM candidates) > p_limit AS has_more
  )
  SELECT jsonb_build_object(
    'posts', COALESCE((
      SELECT jsonb_agg(to_jsonb(page_row) ORDER BY page_row.created_at DESC, page_row.id DESC)
      FROM page_rows AS page_row
    ), '[]'::jsonb),
    'following_count', (SELECT value FROM following_total),
    'has_more', (SELECT has_more FROM page_state),
    'next_cursor', CASE
      WHEN (SELECT has_more FROM page_state) THEN (
        SELECT jsonb_build_object('created_at', page_tail.created_at, 'id', page_tail.id)
        FROM page_tail
      )
      ELSE NULL::jsonb
    END
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_following_posts_page(
  uuid, integer, timestamptz, uuid, uuid, uuid[], text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_following_posts_page(
  uuid, integer, timestamptz, uuid, uuid, uuid[], text, text
) TO service_role;

COMMENT ON FUNCTION public.get_following_posts_page(
  uuid, integer, timestamptz, uuid, uuid, uuid[], text, text
) IS
  'Service-only keyset page of followed-author posts. Follow, canonical wrapper/root audience, filters, ordering, look-ahead, and cursor share one SQL snapshot; returns a minimal UI projection.';

NOTIFY pgrst, 'reload schema';

COMMIT;
