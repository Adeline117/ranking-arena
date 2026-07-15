-- Canonical comment integrity and reaction state
--
-- Comments and comment reactions previously used API-side read/modify/write
-- sequences plus fire-and-forget counter RPCs. That left parent relationships,
-- cached counts, and reaction truth vulnerable to races and partial failures.
-- Keep source rows and their cached counters in the same database transaction,
-- and make the service-role API the only public write boundary.

BEGIN;

-- Fail loudly instead of silently rewriting user-authored relationships. The
-- production preflight was clean; drifted environments need owner review.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.comments AS child
    LEFT JOIN public.comments AS parent ON parent.id = child.parent_id
    WHERE child.parent_id IS NOT NULL
      AND child.deleted_at IS NULL
      AND (
        parent.id IS NULL
        OR parent.post_id IS DISTINCT FROM child.post_id
        OR parent.parent_id IS NOT NULL
        OR parent.deleted_at IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION
      'invalid active reply exists (missing/cross-post/nested/deleted parent); reconcile before migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.comments AS comment_row
    LEFT JOIN public.posts AS post_row ON post_row.id = comment_row.post_id
    WHERE comment_row.deleted_at IS NULL
      AND (post_row.id IS NULL OR post_row.deleted_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION
      'active comment references a missing or deleted post; reconcile before migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.comment_likes
    GROUP BY comment_id, user_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'duplicate comment reactions exist for (comment_id, user_id); reconcile before migration';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.comment_likes
    WHERE reaction_type IS NOT NULL
      AND reaction_type NOT IN ('like', 'dislike')
  ) THEN
    RAISE EXCEPTION
      'invalid non-null comment reaction type exists; reconcile before migration';
  END IF;
END
$$;

-- Normalize the reaction domain before making it non-null. Older NULL rows were
-- already interpreted as likes by every reader.
UPDATE public.comment_likes
SET reaction_type = 'like'
WHERE reaction_type IS NULL;

ALTER TABLE public.comment_likes
  ALTER COLUMN reaction_type SET DEFAULT 'like',
  ALTER COLUMN reaction_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.comment_likes'::regclass
      AND constraint_row.conname = 'comment_likes_reaction_type_check'
      AND constraint_row.contype = 'c'
  ) THEN
    ALTER TABLE public.comment_likes
      ADD CONSTRAINT comment_likes_reaction_type_check
      CHECK (reaction_type IN ('like', 'dislike'));
  END IF;
END
$$;

-- Encode the uniqueness required by the toggle RPC even in environments whose
-- historical schema was created outside the checked-in migration chain.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.comment_likes'::regclass
      AND constraint_row.contype IN ('p', 'u')
      AND (
        SELECT array_agg(attribute_row.attname ORDER BY key_column.ordinality)
        FROM unnest(constraint_row.conkey) WITH ORDINALITY
          AS key_column(attnum, ordinality)
        JOIN pg_attribute AS attribute_row
          ON attribute_row.attrelid = constraint_row.conrelid
         AND attribute_row.attnum = key_column.attnum
      ) = ARRAY['comment_id', 'user_id']::name[]
  ) THEN
    ALTER TABLE public.comment_likes
      ADD CONSTRAINT comment_likes_comment_id_user_id_key
      UNIQUE (comment_id, user_id);
  END IF;
END
$$;

-- blocked_users only exposes rows created by the current viewer through its
-- own RLS policy. A policy subquery therefore cannot see the reverse edge
-- (the post author blocked the viewer). Keep that table private and expose
-- only the one bit the content policies need for the current JWT principal.
CREATE OR REPLACE FUNCTION public.has_block_with_current_user(
  p_other_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN (SELECT auth.uid()) IS NULL OR p_other_user_id IS NULL THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.blocked_users AS block_edge
      WHERE (
        block_edge.blocker_id = (SELECT auth.uid())
        AND block_edge.blocked_id = p_other_user_id
      ) OR (
        block_edge.blocker_id = p_other_user_id
        AND block_edge.blocked_id = (SELECT auth.uid())
      )
    )
  END
$$;

REVOKE ALL ON FUNCTION public.has_block_with_current_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_block_with_current_user(uuid)
  TO anon, authenticated;

COMMENT ON FUNCTION public.has_block_with_current_user(uuid) IS
  'Returns only whether the current JWT user and one other user have a block edge in either direction.';

-- A comment's post and parent are immutable identity. New/restored rows must
-- belong to an active post; active replies must point to an active top-level
-- comment in that same post. Locks close the validation-vs-soft-delete race.
CREATE OR REPLACE FUNCTION public.validate_comment_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_parent public.comments%ROWTYPE;
  v_post_author_id uuid;
  v_post_visibility text;
  v_post_group_id uuid;
  v_post_status public.post_status;
  v_member_muted_until timestamptz;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW.post_id IS DISTINCT FROM OLD.post_id
       OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
     ) THEN
    RAISE EXCEPTION 'comment post_id, parent_id, and user_id are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.deleted_at IS NULL THEN
    -- Keep the global lock order post -> comment. This matches post deletion
    -- and prevents a create from validating immediately before a soft delete.
    SELECT author_id, visibility, group_id, status
    INTO v_post_author_id, v_post_visibility, v_post_group_id, v_post_status
    FROM public.posts
    WHERE id = NEW.post_id
      AND deleted_at IS NULL
      AND status <> 'deleted'::public.post_status
    FOR NO KEY UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'comment post must exist and be active'
        USING ERRCODE = '23514';
    END IF;

    -- Enforce the same audience contract for every service-role/direct INSERT.
    -- Restore deliberately skips this check so moderation remains possible
    -- after the original author leaves a group or unfollows the post author.
    IF TG_OP = 'INSERT' THEN
      IF v_post_status IS DISTINCT FROM 'active'::public.post_status THEN
        RAISE EXCEPTION 'comments are disabled for this post'
          USING ERRCODE = '23514';
      END IF;

      IF EXISTS (
        SELECT 1
        FROM public.blocked_users AS interaction_block
        WHERE (
          interaction_block.blocker_id = NEW.user_id
          AND interaction_block.blocked_id = v_post_author_id
        ) OR (
          interaction_block.blocker_id = v_post_author_id
          AND interaction_block.blocked_id = NEW.user_id
        )
      ) THEN
        RAISE EXCEPTION 'a block relationship prevents comments on this post'
          USING ERRCODE = '42501';
      END IF;

      IF v_post_group_id IS NOT NULL THEN
        IF EXISTS (
          SELECT 1
          FROM public.group_bans AS active_ban
          WHERE active_ban.group_id = v_post_group_id
            AND active_ban.user_id = NEW.user_id
        ) THEN
          RAISE EXCEPTION 'banned users cannot comment in this group'
            USING ERRCODE = '42501';
        END IF;

        SELECT muted_until
        INTO v_member_muted_until
        FROM public.group_members
        WHERE group_id = v_post_group_id
          AND user_id = NEW.user_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'group membership required to comment on this post'
            USING ERRCODE = '42501';
        END IF;

        IF v_member_muted_until IS NOT NULL
           AND v_member_muted_until > CURRENT_TIMESTAMP THEN
          RAISE EXCEPTION 'muted users cannot comment in this group'
            USING ERRCODE = '42501';
        END IF;
      ELSIF v_post_visibility = 'followers' THEN
        IF v_post_author_id IS DISTINCT FROM NEW.user_id THEN
          PERFORM 1
          FROM public.user_follows
          WHERE follower_id = NEW.user_id
            AND following_id = v_post_author_id;

          IF NOT FOUND THEN
            RAISE EXCEPTION 'follower access required to comment on this post'
              USING ERRCODE = '42501';
          END IF;
        END IF;
      ELSIF v_post_visibility = 'group' THEN
        RAISE EXCEPTION 'group membership required to comment on this post'
          USING ERRCODE = '42501';
      ELSIF v_post_visibility IS DISTINCT FROM 'public' THEN
        RAISE EXCEPTION 'post audience does not allow comments'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    IF NEW.parent_id IS NOT NULL THEN
      SELECT * INTO v_parent
      FROM public.comments
      WHERE id = NEW.parent_id
      FOR NO KEY UPDATE;

      IF NOT FOUND
         OR v_parent.deleted_at IS NOT NULL
         OR v_parent.parent_id IS NOT NULL
         OR v_parent.post_id IS DISTINCT FROM NEW.post_id THEN
        RAISE EXCEPTION 'reply parent must be an active top-level comment in the same post'
          USING ERRCODE = '23514';
      END IF;

      IF TG_OP = 'INSERT' AND EXISTS (
        SELECT 1
        FROM public.blocked_users AS parent_interaction_block
        WHERE (
          parent_interaction_block.blocker_id = NEW.user_id
          AND parent_interaction_block.blocked_id = v_parent.user_id
        ) OR (
          parent_interaction_block.blocker_id = v_parent.user_id
          AND parent_interaction_block.blocked_id = NEW.user_id
        )
      ) THEN
        RAISE EXCEPTION 'a block relationship prevents replies to this comment'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_comment_integrity()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_comments_00_validate_integrity ON public.comments;
DROP TRIGGER IF EXISTS trg_comments_10_validate_integrity ON public.comments;
CREATE TRIGGER trg_comments_10_validate_integrity
BEFORE INSERT OR UPDATE OF parent_id, post_id, user_id, deleted_at
ON public.comments
FOR EACH ROW
EXECUTE FUNCTION public.validate_comment_integrity();

-- Hiding a top-level comment must not leave visible-count replies that can no
-- longer be reached by the read path. Copy the parent's deletion marker to only
-- active direct replies. On restore, restore only replies carrying that exact
-- marker, so independently moderated replies remain deleted.
CREATE OR REPLACE FUNCTION public.cascade_comment_soft_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    UPDATE public.comments
    SET deleted_at = NEW.deleted_at,
        deleted_by = NEW.deleted_by,
        delete_reason = NEW.delete_reason
    WHERE parent_id = NEW.id
      AND deleted_at IS NULL;
  ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    UPDATE public.comments
    SET deleted_at = NULL,
        deleted_by = NULL,
        delete_reason = NULL
    WHERE parent_id = NEW.id
      AND deleted_at IS NOT DISTINCT FROM OLD.deleted_at
      AND deleted_by IS NOT DISTINCT FROM OLD.deleted_by
      AND delete_reason IS NOT DISTINCT FROM OLD.delete_reason;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.cascade_comment_soft_delete()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_comments_10_cascade_soft_delete ON public.comments;
CREATE TRIGGER trg_comments_10_cascade_soft_delete
AFTER UPDATE OF deleted_at
ON public.comments
FOR EACH ROW
EXECUTE FUNCTION public.cascade_comment_soft_delete();

-- The comments table is the sole owner of posts.comment_count. Arithmetic row
-- updates are serialized by PostgreSQL row locks and remain in the same
-- transaction as INSERT/DELETE/soft-delete, including FK-cascaded replies.
CREATE OR REPLACE FUNCTION public.sync_post_comment_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old_post_id uuid;
  v_new_post_id uuid;
BEGIN
  IF TG_OP <> 'INSERT' AND OLD.deleted_at IS NULL THEN
    v_old_post_id := OLD.post_id;
  END IF;

  IF TG_OP <> 'DELETE' AND NEW.deleted_at IS NULL THEN
    v_new_post_id := NEW.post_id;
  END IF;

  IF v_old_post_id IS NOT DISTINCT FROM v_new_post_id THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- Lock in UUID order so a future controlled post move cannot invert locks.
  PERFORM 1
  FROM public.posts
  WHERE id IN (v_old_post_id, v_new_post_id)
  ORDER BY id
  FOR UPDATE;

  IF v_old_post_id IS NOT NULL THEN
    UPDATE public.posts
    SET comment_count = GREATEST(COALESCE(comment_count, 0) - 1, 0)
    WHERE id = v_old_post_id;
  END IF;

  IF v_new_post_id IS NOT NULL THEN
    UPDATE public.posts
    SET comment_count = COALESCE(comment_count, 0) + 1
    WHERE id = v_new_post_id;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_post_comment_count()
  FROM PUBLIC, anon, authenticated;

-- Remove every historical owner before installing the one canonical trigger.
DROP TRIGGER IF EXISTS on_comment_change ON public.comments;
DROP TRIGGER IF EXISTS trigger_update_comment_count ON public.comments;
DROP TRIGGER IF EXISTS trigger_update_post_comment_count ON public.comments;
DROP TRIGGER IF EXISTS trg_comments_20_sync_post_count ON public.comments;
CREATE TRIGGER trg_comments_20_sync_post_count
AFTER INSERT OR DELETE OR UPDATE OF post_id, deleted_at
ON public.comments
FOR EACH ROW
EXECUTE FUNCTION public.sync_post_comment_count();

-- Repair every post, including stale non-zero rows that now have no active
-- comments. UPDATE only drifted rows to avoid changing unrelated timestamps.
UPDATE public.posts AS post_row
SET comment_count = counts.comment_count
FROM (
  SELECT
    root_post.id,
    COUNT(comment_row.id) FILTER (WHERE comment_row.deleted_at IS NULL)::integer
      AS comment_count
  FROM public.posts AS root_post
  LEFT JOIN public.comments AS comment_row ON comment_row.post_id = root_post.id
  GROUP BY root_post.id
) AS counts
WHERE post_row.id = counts.id
  AND post_row.comment_count IS DISTINCT FROM counts.comment_count;

-- Reactions cannot change ownership or move between comments. Locking the
-- active comment makes trigger-owned counter deltas safe for every writer,
-- including maintenance inside the canonical API RPC.
CREATE OR REPLACE FUNCTION public.validate_comment_reaction_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_post_id uuid;
  v_comment_author_id uuid;
  v_post_author_id uuid;
  v_post_visibility text;
  v_post_group_id uuid;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (
       NEW.comment_id IS DISTINCT FROM OLD.comment_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
     ) THEN
    RAISE EXCEPTION 'comment reaction identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.reaction_type IS NULL
     OR NEW.reaction_type NOT IN ('like', 'dislike') THEN
    RAISE EXCEPTION 'reaction_type must be like or dislike'
      USING ERRCODE = '22023';
  END IF;

  -- Resolve without a row lock, then acquire locks in post -> comment order and
  -- re-check both active predicates under those locks.
  SELECT post_id INTO v_post_id
  FROM public.comments
  WHERE id = NEW.comment_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'comment reaction requires an active comment'
      USING ERRCODE = '23514';
  END IF;

  SELECT author_id, visibility, group_id
  INTO v_post_author_id, v_post_visibility, v_post_group_id
  FROM public.posts
  WHERE id = v_post_id
    AND deleted_at IS NULL
    AND status = 'active'::public.post_status
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'comment reaction requires an active post'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.blocked_users AS interaction_block
    WHERE (
      interaction_block.blocker_id = NEW.user_id
      AND interaction_block.blocked_id = v_post_author_id
    ) OR (
      interaction_block.blocker_id = v_post_author_id
      AND interaction_block.blocked_id = NEW.user_id
    )
  ) THEN
    RAISE EXCEPTION 'a block relationship prevents reactions on this post'
      USING ERRCODE = '42501';
  END IF;

  IF v_post_group_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.group_bans AS active_ban
      WHERE active_ban.group_id = v_post_group_id
        AND active_ban.user_id = NEW.user_id
    ) THEN
      RAISE EXCEPTION 'banned users cannot react in this group'
        USING ERRCODE = '42501';
    END IF;

    -- A group mute limits authored speech (posts/comments), not lightweight
    -- reactions. Membership and bans still gate every reaction.
    PERFORM 1
    FROM public.group_members
    WHERE group_id = v_post_group_id
      AND user_id = NEW.user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'group membership required for comment reaction'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_post_visibility = 'followers' THEN
    IF v_post_author_id IS DISTINCT FROM NEW.user_id THEN
      PERFORM 1
      FROM public.user_follows
      WHERE follower_id = NEW.user_id
        AND following_id = v_post_author_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'follower access required for comment reaction'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSIF v_post_visibility = 'group' THEN
    RAISE EXCEPTION 'group membership required for comment reaction'
      USING ERRCODE = '42501';
  ELSIF v_post_visibility IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION 'post audience does not allow comment reaction'
      USING ERRCODE = '42501';
  END IF;

  SELECT user_id INTO v_comment_author_id
  FROM public.comments
  WHERE id = NEW.comment_id
    AND post_id = v_post_id
    AND deleted_at IS NULL
  FOR NO KEY UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'comment reaction requires an active comment'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.blocked_users AS target_interaction_block
    WHERE (
      target_interaction_block.blocker_id = NEW.user_id
      AND target_interaction_block.blocked_id = v_comment_author_id
    ) OR (
      target_interaction_block.blocker_id = v_comment_author_id
      AND target_interaction_block.blocked_id = NEW.user_id
    )
  ) THEN
    RAISE EXCEPTION 'a block relationship prevents reactions to this comment'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_comment_reaction_integrity()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_comment_likes_00_validate_integrity ON public.comment_likes;
DROP TRIGGER IF EXISTS trg_comment_likes_10_validate_integrity ON public.comment_likes;
CREATE TRIGGER trg_comment_likes_10_validate_integrity
BEFORE INSERT OR UPDATE OF comment_id, user_id, reaction_type
ON public.comment_likes
FOR EACH ROW
EXECUTE FUNCTION public.validate_comment_reaction_integrity();

-- comment_likes is the sole owner of comments.like_count/dislike_count. The
-- delta is applied in the source-row transaction; switching reaction type is
-- one comments UPDATE, never a decrement/recount/increment sequence.
CREATE OR REPLACE FUNCTION public.sync_comment_reaction_counts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_comment_id uuid;
  v_like_delta integer := 0;
  v_dislike_delta integer := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_comment_id := OLD.comment_id;
    IF OLD.reaction_type = 'like' THEN
      v_like_delta := v_like_delta - 1;
    ELSIF OLD.reaction_type = 'dislike' THEN
      v_dislike_delta := v_dislike_delta - 1;
    END IF;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    IF v_comment_id IS NOT NULL
       AND v_comment_id IS DISTINCT FROM NEW.comment_id THEN
      RAISE EXCEPTION 'comment reaction identity is immutable'
        USING ERRCODE = '23514';
    END IF;

    v_comment_id := NEW.comment_id;
    IF NEW.reaction_type = 'like' THEN
      v_like_delta := v_like_delta + 1;
    ELSIF NEW.reaction_type = 'dislike' THEN
      v_dislike_delta := v_dislike_delta + 1;
    END IF;
  END IF;

  IF v_like_delta <> 0 OR v_dislike_delta <> 0 THEN
    UPDATE public.comments
    SET like_count = GREATEST(COALESCE(like_count, 0) + v_like_delta, 0),
        dislike_count = GREATEST(COALESCE(dislike_count, 0) + v_dislike_delta, 0)
    WHERE id = v_comment_id;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_comment_reaction_counts()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_comment_likes_10_sync_counts ON public.comment_likes;
DROP TRIGGER IF EXISTS trg_comment_likes_20_sync_counts ON public.comment_likes;
CREATE TRIGGER trg_comment_likes_20_sync_counts
AFTER INSERT OR DELETE OR UPDATE OF comment_id, user_id, reaction_type
ON public.comment_likes
FOR EACH ROW
EXECUTE FUNCTION public.sync_comment_reaction_counts();

-- Repair cached reaction counts from the source table before making them
-- non-null. UPDATE only drifted comments to preserve unrelated updated_at.
UPDATE public.comments AS comment_row
SET like_count = counts.like_count,
    dislike_count = counts.dislike_count
FROM (
  SELECT
    root_comment.id,
    COUNT(reaction.id) FILTER (WHERE reaction.reaction_type = 'like')::integer
      AS like_count,
    COUNT(reaction.id) FILTER (WHERE reaction.reaction_type = 'dislike')::integer
      AS dislike_count
  FROM public.comments AS root_comment
  LEFT JOIN public.comment_likes AS reaction ON reaction.comment_id = root_comment.id
  GROUP BY root_comment.id
) AS counts
WHERE comment_row.id = counts.id
  AND (
    comment_row.like_count IS DISTINCT FROM counts.like_count
    OR comment_row.dislike_count IS DISTINCT FROM counts.dislike_count
  );

ALTER TABLE public.comments
  ALTER COLUMN like_count SET DEFAULT 0,
  ALTER COLUMN like_count SET NOT NULL,
  ALTER COLUMN dislike_count SET DEFAULT 0,
  ALTER COLUMN dislike_count SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.comments'::regclass
      AND conname = 'comments_like_count_nonnegative'
  ) THEN
    ALTER TABLE public.comments
      ADD CONSTRAINT comments_like_count_nonnegative CHECK (like_count >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.comments'::regclass
      AND conname = 'comments_dislike_count_nonnegative'
  ) THEN
    ALTER TABLE public.comments
      ADD CONSTRAINT comments_dislike_count_nonnegative CHECK (dislike_count >= 0);
  END IF;
END
$$;

-- Expand-phase bridge: source rows are the only reaction-count writer, but an
-- already-running legacy handler may still issue its follow-up top-level count
-- UPDATE. Preserve the trigger-maintained OLD values so that write succeeds
-- without overwriting canonical truth. The contract migration later rejects
-- top-level counter writes after RPC adoption is verified.
CREATE OR REPLACE FUNCTION public.bridge_legacy_comment_reaction_counts()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF pg_trigger_depth() = 1 THEN
    NEW.like_count := OLD.like_count;
    NEW.dislike_count := OLD.dislike_count;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.bridge_legacy_comment_reaction_counts()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_comments_05_authoritative_reaction_counts ON public.comments;
CREATE TRIGGER trg_comments_05_authoritative_reaction_counts
BEFORE UPDATE OF like_count, dislike_count
ON public.comments
FOR EACH ROW
EXECUTE FUNCTION public.bridge_legacy_comment_reaction_counts();

-- Persist the exact Wilson lower bound used by "best" sorting so PostgreSQL can
-- globally order before LIMIT/OFFSET. The generated value always follows the
-- trigger-owned counters and removes page-local JavaScript re-ranking.
ALTER TABLE public.comments
  ADD COLUMN IF NOT EXISTS ranking_score double precision
  GENERATED ALWAYS AS (
    public.wilson_score_lower(COALESCE(like_count, 0), COALESCE(dislike_count, 0))
  ) STORED;

ALTER TABLE public.comments
  ALTER COLUMN ranking_score SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_comments_active_top_level_ranking
  ON public.comments (post_id, ranking_score DESC, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND parent_id IS NULL;

-- One transaction now owns: route-resource validation, toggle semantics, source
-- mutation, trigger-owned cached counters, and the final acknowledged truth.
CREATE OR REPLACE FUNCTION public.toggle_comment_reaction(
  p_post_id uuid,
  p_comment_id uuid,
  p_user_id uuid,
  p_reaction_type text DEFAULT 'like'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_comment_post_id uuid;
  v_comment_author_id uuid;
  v_post_author_id uuid;
  v_post_visibility text;
  v_post_group_id uuid;
  v_existing_id uuid;
  v_existing_type text;
  v_has_existing boolean;
  v_is_removal boolean;
  v_action text;
  v_reaction text;
  v_like_count integer;
  v_dislike_count integer;
  v_previous_reaction_path text;
BEGIN
  IF p_post_id IS NULL OR p_comment_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'post_id, comment_id, and user_id are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_reaction_type IS NULL
     OR p_reaction_type NOT IN ('like', 'dislike') THEN
    RAISE EXCEPTION 'reaction_type must be like or dislike'
      USING ERRCODE = '22023';
  END IF;

  -- Keep the global lock order post -> comment. A shared post lock allows
  -- unrelated reactions to proceed together while blocking hard/soft delete.
  SELECT author_id, visibility, group_id
  INTO v_post_author_id, v_post_visibility, v_post_group_id
  FROM public.posts
  WHERE id = p_post_id
    AND deleted_at IS NULL
    AND status = 'active'::public.post_status
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active comment not found for post'
      USING ERRCODE = 'P0002';
  END IF;

  -- The comment lock serializes every reaction on this comment, including the
  -- no-existing-row case that SELECT ... FOR UPDATE on comment_likes cannot lock.
  SELECT post_id, user_id INTO v_comment_post_id, v_comment_author_id
  FROM public.comments
  WHERE id = p_comment_id
    AND post_id = p_post_id
    AND deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active comment not found for post'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT id, reaction_type
  INTO v_existing_id, v_existing_type
  FROM public.comment_likes
  WHERE comment_id = p_comment_id
    AND user_id = p_user_id
  FOR UPDATE;

  v_has_existing := FOUND;
  v_is_removal := v_has_existing AND v_existing_type = p_reaction_type;

  -- A user may always withdraw their own existing reaction after either side
  -- blocks the other (or after audience membership is revoked). Adding or
  -- changing a reaction remains a new interaction and requires every current
  -- post/comment permission below.
  IF NOT v_is_removal THEN
    IF EXISTS (
      SELECT 1
      FROM public.blocked_users AS interaction_block
      WHERE (
        interaction_block.blocker_id = p_user_id
        AND interaction_block.blocked_id = v_post_author_id
      ) OR (
        interaction_block.blocker_id = v_post_author_id
        AND interaction_block.blocked_id = p_user_id
      )
    ) THEN
      RAISE EXCEPTION 'a block relationship prevents reactions on this post'
        USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.blocked_users AS target_interaction_block
      WHERE (
        target_interaction_block.blocker_id = p_user_id
        AND target_interaction_block.blocked_id = v_comment_author_id
      ) OR (
        target_interaction_block.blocker_id = v_comment_author_id
        AND target_interaction_block.blocked_id = p_user_id
      )
    ) THEN
      RAISE EXCEPTION 'a block relationship prevents reactions to this comment'
        USING ERRCODE = '42501';
    END IF;

    IF v_post_group_id IS NOT NULL THEN
      IF EXISTS (
        SELECT 1
        FROM public.group_bans AS active_ban
        WHERE active_ban.group_id = v_post_group_id
          AND active_ban.user_id = p_user_id
      ) THEN
        RAISE EXCEPTION 'banned users cannot react in this group'
          USING ERRCODE = '42501';
      END IF;

      PERFORM 1
      FROM public.group_members
      WHERE group_id = v_post_group_id
        AND user_id = p_user_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'group membership required to react to this comment'
          USING ERRCODE = '42501';
      END IF;
    ELSIF v_post_visibility = 'followers' THEN
      IF v_post_author_id IS DISTINCT FROM p_user_id THEN
        PERFORM 1
        FROM public.user_follows
        WHERE follower_id = p_user_id
          AND following_id = v_post_author_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION 'follower access required to react to this comment'
            USING ERRCODE = '42501';
        END IF;
      END IF;
    ELSIF v_post_visibility = 'group' THEN
      RAISE EXCEPTION 'group membership required to react to this comment'
        USING ERRCODE = '42501';
    ELSIF v_post_visibility IS DISTINCT FROM 'public' THEN
      RAISE EXCEPTION 'post audience does not allow this interaction'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  v_previous_reaction_path := current_setting('app.comment_reaction_path', true);
  PERFORM set_config(
    'app.comment_reaction_path',
    'toggle_comment_reaction',
    true
  );

  IF v_is_removal THEN
    DELETE FROM public.comment_likes
    WHERE id = v_existing_id;
    v_action := 'removed';
    v_reaction := NULL;
  ELSIF v_has_existing THEN
    UPDATE public.comment_likes
    SET reaction_type = p_reaction_type
    WHERE id = v_existing_id;
    v_action := 'changed';
    v_reaction := p_reaction_type;
  ELSE
    INSERT INTO public.comment_likes (comment_id, user_id, reaction_type)
    VALUES (p_comment_id, p_user_id, p_reaction_type);
    v_action := 'added';
    v_reaction := p_reaction_type;
  END IF;

  SELECT like_count, dislike_count
  INTO v_like_count, v_dislike_count
  FROM public.comments
  WHERE id = p_comment_id;

  PERFORM set_config(
    'app.comment_reaction_path',
    COALESCE(v_previous_reaction_path, ''),
    true
  );

  RETURN jsonb_build_object(
    'action', v_action,
    'reaction', v_reaction,
    'liked', COALESCE(v_reaction = 'like', false),
    'disliked', COALESCE(v_reaction = 'dislike', false),
    'like_count', v_like_count,
    'dislike_count', v_dislike_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.toggle_comment_reaction(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_comment_reaction(uuid, uuid, uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.toggle_comment_reaction(uuid, uuid, uuid, text) IS
  'Atomically toggles one active comment reaction and returns trigger-maintained counts.';

-- Editing is an interaction, so its authorization must be checked under the
-- same locked post snapshot as the write. This closes the API preflight race
-- where a follow/membership/block edge changed between two database calls.
CREATE OR REPLACE FUNCTION public.update_own_comment(
  p_comment_id uuid,
  p_post_id uuid,
  p_user_id uuid,
  p_content text
)
RETURNS SETOF public.comments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_post_author_id uuid;
  v_post_visibility text;
  v_post_group_id uuid;
  v_comment_user_id uuid;
  v_member_muted_until timestamptz;
  v_previous_mutation_path text;
  v_updated_count integer;
BEGIN
  IF p_comment_id IS NULL OR p_post_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'comment_id, post_id, and user_id are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_content IS NULL
     OR btrim(p_content) = ''
     OR char_length(p_content) > 2000 THEN
    RAISE EXCEPTION 'comment content must contain 1 to 2000 characters'
      USING ERRCODE = '22023';
  END IF;

  SELECT author_id, visibility, group_id
  INTO v_post_author_id, v_post_visibility, v_post_group_id
  FROM public.posts
  WHERE id = p_post_id
    AND deleted_at IS NULL
    AND status = 'active'::public.post_status
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active post not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.blocked_users AS interaction_block
    WHERE (
      interaction_block.blocker_id = p_user_id
      AND interaction_block.blocked_id = v_post_author_id
    ) OR (
      interaction_block.blocker_id = v_post_author_id
      AND interaction_block.blocked_id = p_user_id
    )
  ) THEN
    RAISE EXCEPTION 'a block relationship prevents comment edits on this post'
      USING ERRCODE = '42501';
  END IF;

  IF v_post_group_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.group_bans AS active_ban
      WHERE active_ban.group_id = v_post_group_id
        AND active_ban.user_id = p_user_id
    ) THEN
      RAISE EXCEPTION 'banned users cannot edit comments in this group'
        USING ERRCODE = '42501';
    END IF;

    SELECT muted_until
    INTO v_member_muted_until
    FROM public.group_members
    WHERE group_id = v_post_group_id
      AND user_id = p_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'group membership required to edit this comment'
        USING ERRCODE = '42501';
    END IF;

    IF v_member_muted_until IS NOT NULL
       AND v_member_muted_until > CURRENT_TIMESTAMP THEN
      RAISE EXCEPTION 'muted users cannot edit comments in this group'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_post_visibility = 'followers' THEN
    IF v_post_author_id IS DISTINCT FROM p_user_id THEN
      PERFORM 1
      FROM public.user_follows
      WHERE follower_id = p_user_id
        AND following_id = v_post_author_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'follower access required to edit this comment'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  ELSIF v_post_visibility = 'group' THEN
    RAISE EXCEPTION 'group membership required to edit this comment'
      USING ERRCODE = '42501';
  ELSIF v_post_visibility IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION 'post audience does not allow comment edits'
      USING ERRCODE = '42501';
  END IF;

  SELECT comment_row.user_id
  INTO v_comment_user_id
  FROM public.comments AS comment_row
  WHERE comment_row.id = p_comment_id
    AND comment_row.post_id = p_post_id
    AND comment_row.deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active comment not found for post'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_comment_user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'users may edit only their own comments'
      USING ERRCODE = '42501';
  END IF;

  v_previous_mutation_path := current_setting('app.comment_mutation_path', true);
  PERFORM set_config('app.comment_mutation_path', 'update_own_comment', true);

  RETURN QUERY
  UPDATE public.comments AS edited_comment
  SET content = p_content,
      updated_at = clock_timestamp()
  WHERE edited_comment.id = p_comment_id
    AND edited_comment.post_id = p_post_id
    AND edited_comment.user_id = p_user_id
    AND edited_comment.deleted_at IS NULL
  RETURNING edited_comment.*;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  PERFORM set_config(
    'app.comment_mutation_path',
    COALESCE(v_previous_mutation_path, ''),
    true
  );

  IF v_updated_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'active owned comment changed during update'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.update_own_comment(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_own_comment(uuid, uuid, uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.update_own_comment(uuid, uuid, uuid, text) IS
  'Updates one active owned comment after locked post audience, block, ban, membership, and mute checks.';

-- Self-deletion is a hard delete so FK cascades remove replies/reactions and no
-- personal content remains. Lock post -> comment before mutation, matching the
-- reaction path and keeping the absolute post counter in the same transaction.
CREATE OR REPLACE FUNCTION public.delete_own_comment(
  p_comment_id uuid,
  p_post_id uuid,
  p_user_id uuid
)
RETURNS TABLE (
  deleted_count integer,
  comment_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_comment_parent_id uuid;
  v_comment_user_id uuid;
  v_previous_mutation_path text;
BEGIN
  IF p_comment_id IS NULL OR p_post_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'comment_id, post_id, and user_id are required'
      USING ERRCODE = '22023';
  END IF;

  -- FOR UPDATE is intentional: deleting comments changes the post counter and
  -- must exclude reaction transactions that already hold a shared post lock.
  PERFORM 1
  FROM public.posts AS locked_post
  WHERE locked_post.id = p_post_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'comment not found for post'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT comment_row.parent_id, comment_row.user_id
  INTO v_comment_parent_id, v_comment_user_id
  FROM public.comments AS comment_row
  WHERE comment_row.id = p_comment_id
    AND comment_row.post_id = p_post_id
    AND comment_row.deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active comment not found for post'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_comment_user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'users may delete only their own comments'
      USING ERRCODE = '42501';
  END IF;

  IF v_comment_parent_id IS NULL THEN
    SELECT COUNT(*)::integer
    INTO deleted_count
    FROM public.comments AS removed_comment
    WHERE (
      removed_comment.id = p_comment_id
      OR removed_comment.parent_id = p_comment_id
    )
      AND removed_comment.deleted_at IS NULL;
  ELSE
    deleted_count := 1;
  END IF;

  v_previous_mutation_path := current_setting('app.comment_mutation_path', true);
  PERFORM set_config('app.comment_mutation_path', 'delete_own_comment', true);

  DELETE FROM public.comments AS removed_comment
  WHERE removed_comment.id = p_comment_id
    AND removed_comment.post_id = p_post_id;

  PERFORM set_config(
    'app.comment_mutation_path',
    COALESCE(v_previous_mutation_path, ''),
    true
  );

  SELECT COALESCE(locked_post.comment_count, 0)::integer
  INTO comment_count
  FROM public.posts AS locked_post
  WHERE locked_post.id = p_post_id;

  deleted_count := COALESCE(deleted_count, 0);
  comment_count := COALESCE(comment_count, 0);
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_own_comment(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_own_comment(uuid, uuid, uuid)
  TO service_role;

COMMENT ON FUNCTION public.delete_own_comment(uuid, uuid, uuid) IS
  'Hard-deletes one active comment owned by the supplied user under post-to-comment locks and returns absolute counts.';

-- Every administrative/report/group moderation path uses this RPC. Business
-- role authorization remains in the API; the database function is executable
-- only by service_role and guarantees one lock order plus recoverable soft
-- deletion semantics. actor_id may be NULL for automated report hiding.
CREATE OR REPLACE FUNCTION public.moderate_comment(
  p_comment_id uuid,
  p_actor_id uuid,
  p_action text,
  p_reason text DEFAULT NULL
)
RETURNS TABLE (
  post_id uuid,
  affected_count integer,
  comment_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_post_id uuid;
  v_comment public.comments%ROWTYPE;
  v_previous_mutation_path text;
  v_deleted_at timestamptz;
BEGIN
  IF p_comment_id IS NULL OR p_action IS NULL THEN
    RAISE EXCEPTION 'comment_id and action are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_action NOT IN ('hard_delete', 'soft_delete', 'restore') THEN
    RAISE EXCEPTION 'action must be hard_delete, soft_delete, or restore'
      USING ERRCODE = '22023';
  END IF;

  -- Resolve the immutable post identity without a row lock, then acquire every
  -- lock in the global post -> comment order. Re-check after both locks close
  -- the resolve-vs-delete race.
  SELECT comment_row.post_id
  INTO v_post_id
  FROM public.comments AS comment_row
  WHERE comment_row.id = p_comment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'comment not found'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM 1
  FROM public.posts AS locked_post
  WHERE locked_post.id = v_post_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'comment post not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT comment_row.*
  INTO v_comment
  FROM public.comments AS comment_row
  WHERE comment_row.id = p_comment_id
    AND comment_row.post_id = v_post_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'comment not found'
      USING ERRCODE = 'P0002';
  END IF;

  affected_count := 0;
  v_previous_mutation_path := current_setting('app.comment_mutation_path', true);
  PERFORM set_config('app.comment_mutation_path', 'moderate_comment', true);

  IF p_action = 'hard_delete' THEN
    IF v_comment.parent_id IS NULL THEN
      SELECT COUNT(*) FILTER (WHERE removed_comment.deleted_at IS NULL)::integer
      INTO affected_count
      FROM public.comments AS removed_comment
      WHERE removed_comment.id = p_comment_id
         OR removed_comment.parent_id = p_comment_id;
    ELSE
      affected_count := CASE WHEN v_comment.deleted_at IS NULL THEN 1 ELSE 0 END;
    END IF;

    DELETE FROM public.comments AS removed_comment
    WHERE removed_comment.id = p_comment_id;
  ELSIF p_action = 'soft_delete' THEN
    IF v_comment.deleted_at IS NULL THEN
      IF v_comment.parent_id IS NULL THEN
        SELECT COUNT(*)::integer
        INTO affected_count
        FROM public.comments AS hidden_comment
        WHERE (
          hidden_comment.id = p_comment_id
          OR hidden_comment.parent_id = p_comment_id
        )
          AND hidden_comment.deleted_at IS NULL;
      ELSE
        affected_count := 1;
      END IF;

      v_deleted_at := clock_timestamp();
      UPDATE public.comments AS hidden_comment
      SET deleted_at = v_deleted_at,
          deleted_by = p_actor_id,
          delete_reason = p_reason
      WHERE hidden_comment.id = p_comment_id
        AND hidden_comment.deleted_at IS NULL;
    END IF;
  ELSE
    IF v_comment.deleted_at IS NOT NULL THEN
      IF v_comment.parent_id IS NULL THEN
        SELECT COUNT(*)::integer
        INTO affected_count
        FROM public.comments AS restored_comment
        WHERE restored_comment.id = p_comment_id
           OR (
             restored_comment.parent_id = p_comment_id
             AND restored_comment.deleted_at IS NOT DISTINCT FROM v_comment.deleted_at
             AND restored_comment.deleted_by IS NOT DISTINCT FROM v_comment.deleted_by
             AND restored_comment.delete_reason IS NOT DISTINCT FROM v_comment.delete_reason
           );
      ELSE
        affected_count := 1;
      END IF;

      UPDATE public.comments AS restored_comment
      SET deleted_at = NULL,
          deleted_by = NULL,
          delete_reason = NULL
      WHERE restored_comment.id = p_comment_id
        AND restored_comment.deleted_at IS NOT NULL;
    END IF;
  END IF;

  PERFORM set_config(
    'app.comment_mutation_path',
    COALESCE(v_previous_mutation_path, ''),
    true
  );

  post_id := v_post_id;
  SELECT COALESCE(locked_post.comment_count, 0)::integer
  INTO comment_count
  FROM public.posts AS locked_post
  WHERE locked_post.id = v_post_id;

  affected_count := COALESCE(affected_count, 0);
  comment_count := COALESCE(comment_count, 0);
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.moderate_comment(uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.moderate_comment(uuid, uuid, text, text)
  TO service_role;

COMMENT ON FUNCTION public.moderate_comment(uuid, uuid, text, text) IS
  'Hard-deletes, soft-deletes, or restores one comment under post-to-comment locks and returns absolute counts.';

-- The browser has no direct comment write path. Keep public reads, but require
-- all mutations to cross authenticated server APIs where resource and product
-- policy checks are enforced. This also closes the stale author_id RLS bypass.
DROP POLICY IF EXISTS "Authenticated users can create comments" ON public.comments;
DROP POLICY IF EXISTS "Users can update their own comments" ON public.comments;
DROP POLICY IF EXISTS "Users can delete their own comments" ON public.comments;
DROP POLICY IF EXISTS "Users can insert their own comment likes" ON public.comment_likes;
DROP POLICY IF EXISTS "Users can delete their own comment likes" ON public.comment_likes;

-- The production posts_read_all policy had regressed to status-only and made
-- follower/group posts directly readable through PostgREST. Restore the same
-- active + audience boundary at the post, comment, and reaction layers.
DROP POLICY IF EXISTS "Posts are viewable by everyone" ON public.posts;
DROP POLICY IF EXISTS "Posts are viewable based on visibility" ON public.posts;
DROP POLICY IF EXISTS posts_read_all ON public.posts;
CREATE POLICY posts_read_all
  ON public.posts
  FOR SELECT
  TO public
  USING (
    deleted_at IS NULL
    AND status <> 'deleted'::public.post_status
    AND NOT public.has_block_with_current_user(author_id)
    AND (
      visibility = 'public'
      OR author_id = (SELECT auth.uid())
      OR (
        visibility = 'followers'
        AND EXISTS (
          SELECT 1
          FROM public.user_follows AS visible_follow
          WHERE visible_follow.follower_id = (SELECT auth.uid())
            AND visible_follow.following_id = posts.author_id
        )
      )
      OR (
        visibility = 'group'
        AND EXISTS (
          SELECT 1
          FROM public.group_members AS visible_member
          WHERE visible_member.group_id = posts.group_id
            AND visible_member.user_id = (SELECT auth.uid())
        )
      )
    )
  );

-- Public readers must never recover content or reaction identities hidden by a
-- comment/post soft delete or by the parent post's audience. Service-role
-- moderation reads bypass RLS.
DROP POLICY IF EXISTS "Comments are viewable by everyone" ON public.comments;
CREATE POLICY "Comments are viewable by everyone"
  ON public.comments
  FOR SELECT
  TO public
  USING (
    deleted_at IS NULL
    AND NOT public.has_block_with_current_user(user_id)
    AND EXISTS (
      SELECT 1
      FROM public.posts AS active_post
      WHERE active_post.id = comments.post_id
        AND active_post.deleted_at IS NULL
        AND active_post.status <> 'deleted'::public.post_status
        AND NOT public.has_block_with_current_user(active_post.author_id)
        AND (
          active_post.visibility = 'public'
          OR active_post.author_id = (SELECT auth.uid())
          OR (
            active_post.visibility = 'followers'
            AND EXISTS (
              SELECT 1
              FROM public.user_follows AS visible_follow
              WHERE visible_follow.follower_id = (SELECT auth.uid())
                AND visible_follow.following_id = active_post.author_id
            )
          )
          OR (
            active_post.visibility = 'group'
            AND EXISTS (
              SELECT 1
              FROM public.group_members AS visible_member
              WHERE visible_member.group_id = active_post.group_id
                AND visible_member.user_id = (SELECT auth.uid())
            )
          )
        )
    )
  );

DROP POLICY IF EXISTS "Comment likes are viewable by everyone" ON public.comment_likes;
CREATE POLICY "Comment likes are viewable by everyone"
  ON public.comment_likes
  FOR SELECT
  TO public
  USING (
    EXISTS (
      SELECT 1
      FROM public.comments AS active_comment
      JOIN public.posts AS active_post ON active_post.id = active_comment.post_id
      WHERE active_comment.id = comment_likes.comment_id
        AND active_comment.deleted_at IS NULL
        AND NOT public.has_block_with_current_user(active_comment.user_id)
        AND NOT public.has_block_with_current_user(comment_likes.user_id)
        AND active_post.deleted_at IS NULL
        AND active_post.status <> 'deleted'::public.post_status
        AND NOT public.has_block_with_current_user(active_post.author_id)
        AND (
          active_post.visibility = 'public'
          OR active_post.author_id = (SELECT auth.uid())
          OR (
            active_post.visibility = 'followers'
            AND EXISTS (
              SELECT 1
              FROM public.user_follows AS visible_follow
              WHERE visible_follow.follower_id = (SELECT auth.uid())
                AND visible_follow.following_id = active_post.author_id
            )
          )
          OR (
            active_post.visibility = 'group'
            AND EXISTS (
              SELECT 1
              FROM public.group_members AS visible_member
              WHERE visible_member.group_id = active_post.group_id
                AND visible_member.user_id = (SELECT auth.uid())
            )
          )
        )
    )
  );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.comments, public.comment_likes
  FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.comments, public.comment_likes TO anon, authenticated;

-- Retire the callable counter escape hatches. The triggers above are the sole
-- counter owners, so even service-role callers must not double-write them.
DO $$
DECLARE
  v_function regprocedure;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    to_regprocedure('public.increment_comment_count(uuid)'),
    to_regprocedure('public.decrement_comment_count(uuid)'),
    to_regprocedure('public.increment_comment_like_count(uuid)'),
    to_regprocedure('public.decrement_comment_like_count(uuid)')
  ]
  LOOP
    IF v_function IS NOT NULL THEN
      EXECUTE format(
        'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',
        v_function
      );
    END IF;
  END LOOP;
END
$$;

-- PostgREST learns the three new mutation RPCs immediately after commit,
-- minimizing the schema-cache fallback window in the two-phase rollout.
NOTIFY pgrst, 'reload schema';

COMMIT;
