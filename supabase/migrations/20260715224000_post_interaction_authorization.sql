-- Canonical authorization primitive for post child resources.
--
-- API middleware intentionally injects a service-role client, so child tables
-- never inherit posts RLS. Read routes use the TypeScript equivalent while
-- every write RPC below this migration calls lock_actor_can_interact_with_post
-- inside the same transaction as its mutation.

BEGIN;

CREATE OR REPLACE FUNCTION public.can_actor_read_post_fields(
  p_viewer_id uuid,
  p_author_id uuid,
  p_group_id uuid,
  p_visibility text,
  p_status public.post_status,
  p_deleted_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH effective_viewer AS (
    SELECT CASE
      WHEN p_viewer_id IS NULL THEN NULL::uuid
      WHEN EXISTS (
        SELECT 1
        FROM public.user_profiles AS current_profile
        WHERE current_profile.id = p_viewer_id
          AND current_profile.banned_at IS NULL
          AND current_profile.deleted_at IS NULL
      ) THEN p_viewer_id
      ELSE NULL::uuid
    END AS id
  )
  SELECT COALESCE(CASE
    WHEN p_author_id IS NULL
      OR p_status IS NULL
      OR p_visibility IS NULL
      OR p_deleted_at IS NOT NULL
      OR p_status NOT IN ('active'::public.post_status, 'locked'::public.post_status)
      OR p_visibility NOT IN ('public', 'followers', 'group')
      OR (p_visibility = 'group' AND p_group_id IS NULL)
      OR (
        (SELECT id FROM effective_viewer) IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public.blocked_users AS block_edge
          WHERE (
            block_edge.blocker_id = (SELECT id FROM effective_viewer)
            AND block_edge.blocked_id = p_author_id
          ) OR (
            block_edge.blocker_id = p_author_id
            AND block_edge.blocked_id = (SELECT id FROM effective_viewer)
          )
        )
      )
      THEN false
    WHEN p_group_id IS NULL THEN
      p_visibility = 'public'
      OR p_author_id = (SELECT id FROM effective_viewer)
      OR (
        p_visibility = 'followers'
        AND EXISTS (
          SELECT 1
          FROM public.user_follows AS follow_edge
          WHERE follow_edge.follower_id = (SELECT id FROM effective_viewer)
            AND follow_edge.following_id = p_author_id
        )
      )
    ELSE EXISTS (
      SELECT 1
      FROM public.groups AS post_group
      WHERE post_group.id = p_group_id
        AND NOT EXISTS (
          SELECT 1
          FROM public.group_bans AS active_ban
          WHERE active_ban.group_id = p_group_id
            AND active_ban.user_id = (SELECT id FROM effective_viewer)
        )
        AND (
          p_author_id = (SELECT id FROM effective_viewer)
          OR (
            (
              post_group.visibility = 'open'::public.group_visibility
              OR EXISTS (
                SELECT 1
                FROM public.group_members AS visible_member
                WHERE visible_member.group_id = p_group_id
                  AND visible_member.user_id = (SELECT id FROM effective_viewer)
              )
            )
            AND (
              p_visibility = 'public'
              OR (
                p_visibility = 'followers'
                AND EXISTS (
                  SELECT 1
                  FROM public.user_follows AS group_follow_edge
                  WHERE group_follow_edge.follower_id = (SELECT id FROM effective_viewer)
                    AND group_follow_edge.following_id = p_author_id
                )
              )
              OR (
                p_visibility = 'group'
                AND EXISTS (
                  SELECT 1
                  FROM public.group_members AS group_only_member
                  WHERE group_only_member.group_id = p_group_id
                    AND group_only_member.user_id = (SELECT id FROM effective_viewer)
                )
              )
            )
          )
        )
    )
  END, false)
$$;

REVOKE ALL ON FUNCTION public.can_actor_read_post_fields(
  uuid, uuid, uuid, text, public.post_status, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.can_actor_read_post_id(
  p_post_id uuid,
  p_viewer_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE((
    SELECT
      public.can_actor_read_post_fields(
        p_viewer_id,
        wrapper.author_id,
        wrapper.group_id,
        wrapper.visibility,
        wrapper.status,
        wrapper.deleted_at
      )
      AND (
        wrapper.original_post_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM public.posts AS root
          WHERE root.id = wrapper.original_post_id
            AND root.original_post_id IS NULL
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
    FROM public.posts AS wrapper
    WHERE wrapper.id = p_post_id
  ), false)
$$;

REVOKE ALL ON FUNCTION public.can_actor_read_post_id(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Service routes may ask for a boolean read decision, but may not call the
-- lower-level field helper with forged row facts.
CREATE OR REPLACE FUNCTION public.can_service_actor_read_post(
  p_post_id uuid,
  p_actor_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  RETURN public.can_actor_read_post_id(p_post_id, p_actor_id);
END;
$$;

REVOKE ALL ON FUNCTION public.can_service_actor_read_post(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_service_actor_read_post(uuid, uuid)
  TO service_role;

-- A wrapper cannot remain visible after its root becomes unreadable. Keep this
-- separate and restrictive so it composes with posts_read_all.
CREATE OR REPLACE FUNCTION public.can_current_user_read_repost_root(
  p_original_post_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_original_post_id IS NULL
    OR public.can_actor_read_post_id(p_original_post_id, (SELECT auth.uid()))
$$;

REVOKE ALL ON FUNCTION public.can_current_user_read_repost_root(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_current_user_read_repost_root(uuid)
  TO anon, authenticated;

DROP POLICY IF EXISTS posts_repost_root_read_contract ON public.posts;
CREATE POLICY posts_repost_root_read_contract
  ON public.posts
  AS RESTRICTIVE
  FOR SELECT
  TO public
  USING (public.can_current_user_read_repost_root(original_post_id));

-- Block creation/deletion must linearize with a child-resource write that is
-- authorizing the same viewer/author pair. A row lock cannot protect the
-- absent-block case, so both paths share this transaction advisory lock.
CREATE OR REPLACE FUNCTION public.serialize_post_audience_block_edge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_blocker uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.blocker_id ELSE NEW.blocker_id END;
  v_blocked uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.blocked_id ELSE NEW.blocked_id END;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-audience:block:' || LEAST(v_blocker::text, v_blocked::text)
        || ':' || GREATEST(v_blocker::text, v_blocked::text),
      0
    )
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION public.serialize_post_audience_block_edge()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_serialize_post_audience_block_edge ON public.blocked_users;
CREATE TRIGGER trg_serialize_post_audience_block_edge
BEFORE INSERT OR DELETE OR UPDATE
ON public.blocked_users
FOR EACH ROW
EXECUTE FUNCTION public.serialize_post_audience_block_edge();

CREATE OR REPLACE FUNCTION public.lock_actor_can_interact_with_post(
  p_post_id uuid,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_wrapper public.posts%ROWTYPE;
  v_root public.posts%ROWTYPE;
  v_author_id uuid;
  v_group_id uuid;
BEGIN
  IF p_actor_id IS NULL THEN
    RETURN false;
  END IF;

  PERFORM 1
  FROM public.user_profiles AS actor_profile
  WHERE actor_profile.id = p_actor_id
    AND actor_profile.banned_at IS NULL
    AND actor_profile.deleted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT * INTO v_wrapper
  FROM public.posts AS wrapper
  WHERE wrapper.id = p_post_id
  FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;

  IF v_wrapper.original_post_id IS NOT NULL THEN
    SELECT * INTO v_root
    FROM public.posts AS root
    WHERE root.id = v_wrapper.original_post_id
      AND root.original_post_id IS NULL
    FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
  END IF;

  -- Sort every viewer/author block lock to keep wrapper/root checks deadlock
  -- free even when the same actors appear in reverse order elsewhere.
  FOR v_author_id IN
    SELECT DISTINCT author_id
    FROM unnest(ARRAY[v_wrapper.author_id, v_root.author_id]) AS author_row(author_id)
    WHERE author_id IS NOT NULL AND author_id <> p_actor_id
    ORDER BY author_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'post-audience:block:' || LEAST(p_actor_id::text, v_author_id::text)
          || ':' || GREATEST(p_actor_id::text, v_author_id::text),
        0
      )
    );
  END LOOP;

  -- Group UPDATE blocks new member/ban rows through their production FKs.
  -- Existing membership rows are SHARE locked so leave/mute cannot cross the
  -- authorization point before the child mutation commits.
  FOR v_group_id IN
    SELECT DISTINCT group_id
    FROM unnest(ARRAY[v_wrapper.group_id, v_root.group_id]) AS group_row(group_id)
    WHERE group_id IS NOT NULL
    ORDER BY group_id
  LOOP
    PERFORM 1
    FROM public.groups AS locked_group
    WHERE locked_group.id = v_group_id
    FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;

    PERFORM 1
    FROM public.group_members AS locked_member
    WHERE locked_member.group_id = v_group_id
      AND locked_member.user_id = p_actor_id
    FOR SHARE;

    PERFORM 1
    FROM public.group_bans AS locked_ban
    WHERE locked_ban.group_id = v_group_id
      AND locked_ban.user_id = p_actor_id
    FOR SHARE;
  END LOOP;

  -- An existing follower edge is SHARE locked so an unfollow cannot authorize
  -- and revoke concurrently. A concurrent new follow can only cause a safe
  -- false-negative before its commit, never an unauthorized interaction.
  PERFORM 1
  FROM public.user_follows AS locked_follow
  WHERE locked_follow.follower_id = p_actor_id
    AND locked_follow.following_id IN (v_wrapper.author_id, v_root.author_id)
  ORDER BY locked_follow.following_id
  FOR SHARE;

  RETURN public.can_actor_read_post_id(p_post_id, p_actor_id);
END;
$$;

REVOKE ALL ON FUNCTION public.lock_actor_can_interact_with_post(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
