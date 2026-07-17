-- Atomically make service-role post child writes cross the canonical post audience and
-- current-entitlement decision in the same transaction as their mutation.

BEGIN;

DO $preflight$
DECLARE
  v_table text;
BEGIN
  IF pg_catalog.to_regprocedure(
    'public.lock_actor_can_interact_with_post(uuid,uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'canonical post interaction lock is missing';
  END IF;
  IF pg_catalog.to_regprocedure(
    'public.delete_own_comment(uuid,uuid,uuid)'
  ) IS NULL
    AND pg_catalog.to_regprocedure(
      'public.delete_own_comment_locked_impl(uuid,uuid,uuid)'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'canonical owned-comment delete implementation is missing';
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'posts',
    'post_likes',
    'post_votes',
    'post_bookmarks',
    'post_emoji_reactions',
    'comments',
    'comment_likes',
    'polls',
    'poll_votes'
  ]
  LOOP
    IF pg_catalog.to_regclass('public.' || v_table) IS NULL THEN
      RAISE EXCEPTION 'required post interaction table is missing: %', v_table;
    END IF;
  END LOOP;
END
$preflight$;

-- Defense in depth for direct service writers. Deletions remain possible for
-- privacy cleanup, while every insert/update must hold the current canonical
-- audience and entitlement locks at the actual row mutation boundary.
CREATE OR REPLACE FUNCTION public.enforce_current_post_child_interaction()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.post_id IS NULL
    OR NEW.user_id IS NULL
    OR NOT public.lock_actor_can_interact_with_post(NEW.post_id, NEW.user_id)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'post is not currently interactable';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.enforce_current_post_child_interaction() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_current_post_child_interaction()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_post_likes_15_current_interaction ON public.post_likes;
CREATE TRIGGER trg_post_likes_15_current_interaction
  BEFORE INSERT OR UPDATE ON public.post_likes
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_current_post_child_interaction();

DROP TRIGGER IF EXISTS trg_post_votes_15_current_interaction ON public.post_votes;
CREATE TRIGGER trg_post_votes_15_current_interaction
  BEFORE INSERT OR UPDATE ON public.post_votes
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_current_post_child_interaction();

DROP TRIGGER IF EXISTS trg_post_bookmarks_15_current_interaction ON public.post_bookmarks;
CREATE TRIGGER trg_post_bookmarks_15_current_interaction
  BEFORE INSERT OR UPDATE ON public.post_bookmarks
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_current_post_child_interaction();

DROP TRIGGER IF EXISTS trg_post_emoji_15_current_interaction
  ON public.post_emoji_reactions;
CREATE TRIGGER trg_post_emoji_15_current_interaction
  BEFORE INSERT OR UPDATE ON public.post_emoji_reactions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_current_post_child_interaction();

DO $optional_post_reactions$
BEGIN
  IF pg_catalog.to_regclass('public.post_reactions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_post_reactions_15_current_interaction
      ON public.post_reactions;
    CREATE TRIGGER trg_post_reactions_15_current_interaction
      BEFORE INSERT OR UPDATE ON public.post_reactions
      FOR EACH ROW
      EXECUTE FUNCTION public.enforce_current_post_child_interaction();
  END IF;
END
$optional_post_reactions$;

CREATE OR REPLACE FUNCTION public.enforce_current_comment_interaction()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.post_id IS NULL
    OR NEW.user_id IS NULL
    OR NOT public.lock_actor_can_interact_with_post(NEW.post_id, NEW.user_id)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'comment parent post is not currently interactable';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.enforce_current_comment_interaction() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_current_comment_interaction()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_comments_15_current_interaction ON public.comments;
CREATE TRIGGER trg_comments_15_current_interaction
  BEFORE INSERT OR UPDATE OF content, post_id, user_id ON public.comments
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_current_comment_interaction();

CREATE OR REPLACE FUNCTION public.enforce_current_comment_reaction()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_post_id uuid;
BEGIN
  SELECT comment_row.post_id
  INTO v_post_id
  FROM public.comments AS comment_row
  WHERE comment_row.id = NEW.comment_id
  FOR SHARE;

  IF NOT FOUND
    OR NEW.user_id IS NULL
    OR NOT public.lock_actor_can_interact_with_post(v_post_id, NEW.user_id)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'comment is not currently interactable';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.enforce_current_comment_reaction() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_current_comment_reaction()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_comment_likes_15_current_interaction
  ON public.comment_likes;
CREATE TRIGGER trg_comment_likes_15_current_interaction
  BEFORE INSERT OR UPDATE OF comment_id, user_id, reaction_type
  ON public.comment_likes
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_current_comment_reaction();

CREATE OR REPLACE FUNCTION public.enforce_current_poll_vote_interaction()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_post_id uuid;
BEGIN
  SELECT poll.post_id
  INTO v_post_id
  FROM public.polls AS poll
  WHERE poll.id = NEW.poll_id
  FOR SHARE;

  IF NOT FOUND
    OR v_post_id IS NULL
    OR NEW.user_id IS NULL
    OR NOT public.lock_actor_can_interact_with_post(v_post_id, NEW.user_id)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'poll parent post is not currently interactable';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.enforce_current_poll_vote_interaction() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_current_poll_vote_interaction()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_poll_votes_15_current_interaction ON public.poll_votes;
CREATE TRIGGER trg_poll_votes_15_current_interaction
  BEFORE INSERT OR UPDATE OF poll_id, user_id, option_index ON public.poll_votes
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_current_poll_vote_interaction();

CREATE OR REPLACE FUNCTION public.enforce_current_repost_interaction()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.original_post_id IS NOT NULL
    AND (
      TG_OP = 'INSERT'
      OR NEW.original_post_id IS DISTINCT FROM OLD.original_post_id
      OR NEW.author_id IS DISTINCT FROM OLD.author_id
    )
    AND NOT public.lock_actor_can_interact_with_post(
      NEW.original_post_id,
      NEW.author_id
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'repost target is not currently interactable';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.enforce_current_repost_interaction() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_current_repost_interaction()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_repost_10_current_interaction ON public.posts;
CREATE TRIGGER trg_repost_10_current_interaction
  BEFORE INSERT OR UPDATE OF original_post_id, author_id ON public.posts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_current_repost_interaction();

-- The mature owned-comment delete implementation already owns subtree and
-- counter locks. Preserve it behind a private name, then put the current post
-- audience/entitlement lock in front of it. This closes the final service-role
-- race without duplicating the deletion algorithm.
DO $internalize_owned_comment_delete$
BEGIN
  IF pg_catalog.to_regprocedure(
    'public.delete_own_comment_locked_impl(uuid,uuid,uuid)'
  ) IS NULL THEN
    ALTER FUNCTION public.delete_own_comment(uuid, uuid, uuid)
      RENAME TO delete_own_comment_locked_impl;
  END IF;
END
$internalize_owned_comment_delete$;

ALTER FUNCTION public.delete_own_comment_locked_impl(uuid, uuid, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delete_own_comment_locked_impl(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

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
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_comment_id IS NULL OR p_post_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'comment_id, post_id, and user_id are required'
      USING ERRCODE = '22023';
  END IF;
  IF NOT public.lock_actor_can_interact_with_post(p_post_id, p_user_id) THEN
    RAISE EXCEPTION 'active post not found' USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  SELECT result.deleted_count, result.comment_count
  FROM public.delete_own_comment_locked_impl(
    p_comment_id,
    p_post_id,
    p_user_id
  ) AS result;
END
$function$;

ALTER FUNCTION public.delete_own_comment(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delete_own_comment(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_own_comment(uuid, uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.toggle_post_reaction(
  p_post_id uuid,
  p_user_id uuid,
  p_reaction_type text DEFAULT 'up'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_existing_id uuid;
  v_existing_type text;
  v_action text;
  v_reaction text;
  v_like_count integer;
  v_dislike_count integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_post_id IS NULL
    OR p_user_id IS NULL
    OR p_reaction_type NOT IN ('up', 'down')
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-reaction:' || p_post_id::text || ':' || p_user_id::text,
      0
    )
  );
  IF NOT public.lock_actor_can_interact_with_post(p_post_id, p_user_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT reaction.id, reaction.reaction_type
  INTO v_existing_id, v_existing_type
  FROM public.post_likes AS reaction
  WHERE reaction.post_id = p_post_id
    AND reaction.user_id = p_user_id
  FOR UPDATE;

  IF FOUND AND v_existing_type = p_reaction_type THEN
    DELETE FROM public.post_likes WHERE id = v_existing_id;
    v_action := 'removed';
    v_reaction := NULL;
  ELSIF v_existing_id IS NULL THEN
    INSERT INTO public.post_likes (post_id, user_id, reaction_type)
    VALUES (p_post_id, p_user_id, p_reaction_type);
    v_action := 'added';
    v_reaction := p_reaction_type;
  ELSE
    UPDATE public.post_likes
    SET reaction_type = p_reaction_type
    WHERE id = v_existing_id;
    v_action := 'changed';
    v_reaction := p_reaction_type;
  END IF;

  SELECT
    pg_catalog.count(*) FILTER (WHERE reaction.reaction_type = 'up')::integer,
    pg_catalog.count(*) FILTER (WHERE reaction.reaction_type = 'down')::integer
  INTO v_like_count, v_dislike_count
  FROM public.post_likes AS reaction
  WHERE reaction.post_id = p_post_id;

  UPDATE public.posts
  SET like_count = COALESCE(v_like_count, 0),
      dislike_count = COALESCE(v_dislike_count, 0)
  WHERE id = p_post_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_action,
    'action', v_action,
    'reaction', v_reaction,
    'like_count', COALESCE(v_like_count, 0),
    'dislike_count', COALESCE(v_dislike_count, 0)
  );
END
$function$;

ALTER FUNCTION public.toggle_post_reaction(uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.toggle_post_reaction(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_post_reaction(uuid, uuid, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.toggle_post_vote_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_choice text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_existing_id uuid;
  v_existing_choice text;
  v_action text;
  v_vote text;
  v_bull integer;
  v_bear integer;
  v_wait integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL
    OR p_post_id IS NULL
    OR p_choice NOT IN ('bull', 'bear', 'wait')
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-vote:' || p_post_id::text || ':' || p_actor_id::text,
      0
    )
  );
  IF NOT public.lock_actor_can_interact_with_post(p_post_id, p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT vote.id, vote.choice
  INTO v_existing_id, v_existing_choice
  FROM public.post_votes AS vote
  WHERE vote.post_id = p_post_id
    AND vote.user_id = p_actor_id
  FOR UPDATE;

  IF FOUND AND v_existing_choice = p_choice THEN
    DELETE FROM public.post_votes WHERE id = v_existing_id;
    v_action := 'removed';
    v_vote := NULL;
  ELSIF v_existing_id IS NULL THEN
    INSERT INTO public.post_votes (post_id, user_id, choice)
    VALUES (p_post_id, p_actor_id, p_choice);
    v_action := 'added';
    v_vote := p_choice;
  ELSE
    UPDATE public.post_votes SET choice = p_choice WHERE id = v_existing_id;
    v_action := 'changed';
    v_vote := p_choice;
  END IF;

  SELECT
    pg_catalog.count(*) FILTER (WHERE vote.choice = 'bull')::integer,
    pg_catalog.count(*) FILTER (WHERE vote.choice = 'bear')::integer,
    pg_catalog.count(*) FILTER (WHERE vote.choice = 'wait')::integer
  INTO v_bull, v_bear, v_wait
  FROM public.post_votes AS vote
  WHERE vote.post_id = p_post_id;

  UPDATE public.posts
  SET poll_bull = COALESCE(v_bull, 0),
      poll_bear = COALESCE(v_bear, 0),
      poll_wait = COALESCE(v_wait, 0)
  WHERE id = p_post_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_action,
    'action', v_action,
    'vote', v_vote,
    'poll', pg_catalog.jsonb_build_object(
      'bull', COALESCE(v_bull, 0),
      'bear', COALESCE(v_bear, 0),
      'wait', COALESCE(v_wait, 0)
    )
  );
END
$function$;

ALTER FUNCTION public.toggle_post_vote_atomic(uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.toggle_post_vote_atomic(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_post_vote_atomic(uuid, uuid, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.toggle_post_bookmark_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_folder_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_existing_id uuid;
  v_existing_folder_id uuid;
  v_folder_id uuid := p_folder_id;
  v_action text;
  v_count integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL OR p_post_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-bookmark:' || p_post_id::text || ':' || p_actor_id::text,
      0
    )
  );
  IF NOT public.lock_actor_can_interact_with_post(p_post_id, p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT bookmark.id, bookmark.folder_id
  INTO v_existing_id, v_existing_folder_id
  FROM public.post_bookmarks AS bookmark
  WHERE bookmark.post_id = p_post_id
    AND bookmark.user_id = p_actor_id
  FOR UPDATE;

  IF FOUND
    AND (p_folder_id IS NULL OR p_folder_id IS NOT DISTINCT FROM v_existing_folder_id)
  THEN
    DELETE FROM public.post_bookmarks WHERE id = v_existing_id;
    v_action := 'removed';
    v_folder_id := NULL;
  ELSE
    IF v_folder_id IS NULL THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('bookmark-default:' || p_actor_id::text, 0)
      );
      SELECT folder.id
      INTO v_folder_id
      FROM public.bookmark_folders AS folder
      WHERE folder.user_id = p_actor_id
        AND folder.is_default
      ORDER BY folder.created_at, folder.id
      LIMIT 1
      FOR SHARE;
      IF NOT FOUND THEN
        INSERT INTO public.bookmark_folders (user_id, name, is_default)
        VALUES (p_actor_id, 'Default', true)
        RETURNING id INTO v_folder_id;
      END IF;
    ELSE
      PERFORM 1
      FROM public.bookmark_folders AS folder
      WHERE folder.id = v_folder_id
        AND folder.user_id = p_actor_id
      FOR SHARE;
      IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('status', 'invalid_folder');
      END IF;
    END IF;

    IF v_existing_id IS NULL THEN
      INSERT INTO public.post_bookmarks (post_id, user_id, folder_id)
      VALUES (p_post_id, p_actor_id, v_folder_id);
      v_action := 'added';
    ELSE
      UPDATE public.post_bookmarks
      SET folder_id = v_folder_id
      WHERE id = v_existing_id;
      v_action := 'moved';
    END IF;
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_count
  FROM public.post_bookmarks AS bookmark
  WHERE bookmark.post_id = p_post_id;
  UPDATE public.posts
  SET bookmark_count = COALESCE(v_count, 0)
  WHERE id = p_post_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_action,
    'action', v_action,
    'bookmarked', v_action <> 'removed',
    'bookmark_count', COALESCE(v_count, 0),
    'folder_id', v_folder_id
  );
END
$function$;

ALTER FUNCTION public.toggle_post_bookmark_atomic(uuid, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.toggle_post_bookmark_atomic(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_post_bookmark_atomic(uuid, uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.toggle_post_emoji_reaction_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_emoji text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_existing_id uuid;
  v_counts jsonb := '{}'::jsonb;
  v_user_emojis jsonb := '[]'::jsonb;
  v_action text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL
    OR p_post_id IS NULL
    OR p_emoji IS NULL
    OR NOT (p_emoji = ANY (ARRAY[
      '👍', '🔥', '💎', '🚀', '❤️', '👀',
      '🎯', '💰', '📈', '📉', '🤔', '😂'
    ]::text[]))
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-emoji:' || p_post_id::text || ':' || p_actor_id::text || ':' || p_emoji,
      0
    )
  );
  IF NOT public.lock_actor_can_interact_with_post(p_post_id, p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT reaction.id
  INTO v_existing_id
  FROM public.post_emoji_reactions AS reaction
  WHERE reaction.post_id = p_post_id
    AND reaction.user_id = p_actor_id
    AND reaction.emoji = p_emoji
  FOR UPDATE;

  IF FOUND THEN
    DELETE FROM public.post_emoji_reactions WHERE id = v_existing_id;
    v_action := 'removed';
  ELSE
    INSERT INTO public.post_emoji_reactions (post_id, user_id, emoji)
    VALUES (p_post_id, p_actor_id, p_emoji);
    v_action := 'added';
  END IF;

  SELECT COALESCE(
    pg_catalog.jsonb_object_agg(reaction_count.emoji, reaction_count.total),
    '{}'::jsonb
  )
  INTO v_counts
  FROM (
    SELECT reaction.emoji, pg_catalog.count(*) AS total
    FROM public.post_emoji_reactions AS reaction
    WHERE reaction.post_id = p_post_id
    GROUP BY reaction.emoji
  ) AS reaction_count;

  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      actor_reaction.emoji ORDER BY actor_reaction.created_at, actor_reaction.id
    ),
    '[]'::jsonb
  )
  INTO v_user_emojis
  FROM public.post_emoji_reactions AS actor_reaction
  WHERE actor_reaction.post_id = p_post_id
    AND actor_reaction.user_id = p_actor_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_action,
    'action', v_action,
    'emoji', p_emoji,
    'counts', v_counts,
    'user_emojis', v_user_emojis
  );
END
$function$;

ALTER FUNCTION public.toggle_post_emoji_reaction_atomic(uuid, uuid, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.toggle_post_emoji_reaction_atomic(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_post_emoji_reaction_atomic(uuid, uuid, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.cast_post_poll_vote_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_option_indexes integer[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_poll_id uuid;
  v_options jsonb;
  v_updated_options jsonb;
  v_poll_type text;
  v_end_at timestamptz;
  v_options_count integer;
  v_total_votes bigint;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL
    OR p_post_id IS NULL
    OR COALESCE(pg_catalog.array_length(p_option_indexes, 1), 0) = 0
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(p_option_indexes) AS requested(option_index)
      WHERE requested.option_index IS NULL
    )
    OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.unnest(p_option_indexes) AS requested(option_index)
    ) <> (
      SELECT pg_catalog.count(DISTINCT requested.option_index)
      FROM pg_catalog.unnest(p_option_indexes) AS requested(option_index)
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  IF NOT public.lock_actor_can_interact_with_post(p_post_id, p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT poll.id, poll.options::jsonb, poll.type, poll.end_at
  INTO v_poll_id, v_options, v_poll_type, v_end_at
  FROM public.polls AS poll
  WHERE poll.post_id = p_post_id
  ORDER BY poll.created_at, poll.id
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND
    OR v_options IS NULL
    OR pg_catalog.jsonb_typeof(v_options) <> 'array'
    OR pg_catalog.jsonb_array_length(v_options) = 0
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(v_options) AS candidate(option_value)
      WHERE pg_catalog.jsonb_typeof(candidate.option_value) <> 'object'
        OR pg_catalog.jsonb_typeof(candidate.option_value -> 'text') <> 'string'
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_end_at IS NOT NULL AND v_end_at <= pg_catalog.statement_timestamp() THEN
    RETURN pg_catalog.jsonb_build_object('status', 'ended');
  END IF;

  v_options_count := pg_catalog.jsonb_array_length(v_options);
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(p_option_indexes) AS requested(option_index)
    WHERE requested.option_index < 0
      OR requested.option_index >= v_options_count
  ) OR (
    v_poll_type = 'single'
    AND pg_catalog.array_length(p_option_indexes, 1) <> 1
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  DELETE FROM public.poll_votes AS existing_vote
  WHERE existing_vote.poll_id = v_poll_id
    AND existing_vote.user_id = p_actor_id;

  INSERT INTO public.poll_votes (poll_id, user_id, option_index)
  SELECT v_poll_id, p_actor_id, requested.option_index
  FROM pg_catalog.unnest(p_option_indexes) AS requested(option_index);

  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_set(
      option_row.option_value,
      '{votes}',
      pg_catalog.to_jsonb(COALESCE(vote_count.total, 0)),
      true
    )
    ORDER BY option_row.ordinality
  )
  INTO v_updated_options
  FROM pg_catalog.jsonb_array_elements(v_options)
    WITH ORDINALITY AS option_row(option_value, ordinality)
  LEFT JOIN (
    SELECT vote.option_index, pg_catalog.count(*) AS total
    FROM public.poll_votes AS vote
    WHERE vote.poll_id = v_poll_id
    GROUP BY vote.option_index
  ) AS vote_count
    ON vote_count.option_index = option_row.ordinality - 1;

  SELECT pg_catalog.count(*)
  INTO v_total_votes
  FROM public.poll_votes AS vote
  WHERE vote.poll_id = v_poll_id;

  UPDATE public.polls
  SET options = v_updated_options,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = v_poll_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'voted',
    'poll_id', v_poll_id,
    'options', v_updated_options,
    'total_votes', v_total_votes,
    'user_votes', pg_catalog.to_jsonb(p_option_indexes)
  );
END
$function$;

ALTER FUNCTION public.cast_post_poll_vote_atomic(uuid, uuid, integer[])
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.cast_post_poll_vote_atomic(uuid, uuid, integer[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cast_post_poll_vote_atomic(uuid, uuid, integer[])
  TO service_role;

DO $converge_function_authority$
DECLARE
  v_signature pg_catalog.regprocedure;
  v_owner oid;
  v_grantee record;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.enforce_current_post_child_interaction()'::pg_catalog.regprocedure,
    'public.enforce_current_comment_interaction()'::pg_catalog.regprocedure,
    'public.enforce_current_comment_reaction()'::pg_catalog.regprocedure,
    'public.enforce_current_poll_vote_interaction()'::pg_catalog.regprocedure,
    'public.enforce_current_repost_interaction()'::pg_catalog.regprocedure,
    'public.delete_own_comment_locked_impl(uuid,uuid,uuid)'::pg_catalog.regprocedure,
    'public.delete_own_comment(uuid,uuid,uuid)'::pg_catalog.regprocedure,
    'public.toggle_post_reaction(uuid,uuid,text)'::pg_catalog.regprocedure,
    'public.toggle_post_vote_atomic(uuid,uuid,text)'::pg_catalog.regprocedure,
    'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)'::pg_catalog.regprocedure,
    'public.toggle_post_emoji_reaction_atomic(uuid,uuid,text)'::pg_catalog.regprocedure,
    'public.cast_post_poll_vote_atomic(uuid,uuid,integer[])'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT function_row.proowner
    INTO STRICT v_owner
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_signature;

    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee, role_row.rolname
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_entry
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.oid = acl_entry.grantee
      WHERE function_row.oid = v_signature
        AND acl_entry.grantee <> v_owner
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION %s FROM PUBLIC',
          v_signature
        );
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION %s FROM %I',
          v_signature,
          v_grantee.rolname
        );
      END IF;
    END LOOP;
  END LOOP;
END
$converge_function_authority$;

GRANT EXECUTE ON FUNCTION public.toggle_post_reaction(uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_own_comment(uuid, uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.toggle_post_vote_atomic(uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.toggle_post_bookmark_atomic(uuid, uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.toggle_post_emoji_reaction_atomic(uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.cast_post_poll_vote_atomic(uuid, uuid, integer[])
  TO service_role;

DO $postflight$
DECLARE
  v_signature pg_catalog.regprocedure;
  v_trigger text;
  v_service_oid oid;
BEGIN
  SELECT role_row.oid
  INTO STRICT v_service_oid
  FROM pg_catalog.pg_roles AS role_row
  WHERE role_row.rolname = 'service_role';

  FOREACH v_signature IN ARRAY ARRAY[
    'public.delete_own_comment(uuid,uuid,uuid)'::pg_catalog.regprocedure,
    'public.toggle_post_reaction(uuid,uuid,text)'::pg_catalog.regprocedure,
    'public.toggle_post_vote_atomic(uuid,uuid,text)'::pg_catalog.regprocedure,
    'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)'::pg_catalog.regprocedure,
    'public.toggle_post_emoji_reaction_atomic(uuid,uuid,text)'::pg_catalog.regprocedure,
    'public.cast_post_poll_vote_atomic(uuid,uuid,integer[])'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE')
      OR pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
      OR pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS function_row
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            function_row.proacl,
            pg_catalog.acldefault('f', function_row.proowner)
          )
        ) AS acl_entry
        WHERE function_row.oid = v_signature
          AND acl_entry.privilege_type = 'EXECUTE'
          AND acl_entry.grantee NOT IN (function_row.proowner, v_service_oid)
      )
    THEN
      RAISE EXCEPTION 'post interaction RPC ACL drifted: %', v_signature;
    END IF;
  END LOOP;

  FOREACH v_trigger IN ARRAY ARRAY[
    'trg_post_likes_15_current_interaction',
    'trg_post_votes_15_current_interaction',
    'trg_post_bookmarks_15_current_interaction',
    'trg_post_emoji_15_current_interaction',
    'trg_comments_15_current_interaction',
    'trg_comment_likes_15_current_interaction',
    'trg_poll_votes_15_current_interaction',
    'trg_repost_10_current_interaction'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgname = v_trigger
        AND NOT trigger_row.tgisinternal
    ) THEN
      RAISE EXCEPTION 'post interaction trigger is missing: %', v_trigger;
    END IF;
  END LOOP;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
