-- Contract phase for canonical comment writes.
--
-- Deployment order is mandatory:
--   1. Deploy every mutation/moderation bridge, RPC-first with fallback only
--      when PostgREST reports a missing function (PGRST202/42883).
--   2. Apply 20260715091500_atomic_comment_integrity.sql, reload PostgREST, and
--      prove every RPC path without fallback.
--   3. Fully deploy the remaining comment code, remove direct post counter
--      writers, and drain every old instance and maintenance process.
--   4. Only then apply this migration to reject/revoke every legacy direct
--      edit/delete/reaction/counter path.

BEGIN;

-- Acquire table locks in the same post -> comment -> reaction order used by
-- canonical mutations. This both freezes the drift preflight and prevents the
-- DDL below from holding a comment table lock while waiting behind a post
-- writer. Fail instead of creating an unbounded deployment queue.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
LOCK TABLE public.posts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.comments IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.comment_likes IN SHARE ROW EXCLUSIVE MODE;

-- Refuse to contract permissions around a partial or drifted expand deployment.
DO $$
DECLARE
  v_function_signature text;
  v_retired_function_signature text;
  v_trigger_name text;
BEGIN
  FOREACH v_function_signature IN ARRAY ARRAY[
    'public.toggle_comment_reaction(uuid,uuid,uuid,text)',
    'public.update_own_comment(uuid,uuid,uuid,text)',
    'public.delete_own_comment(uuid,uuid,uuid)',
    'public.moderate_comment(uuid,uuid,text,text)'
  ]
  LOOP
    IF to_regprocedure(v_function_signature) IS NULL THEN
      RAISE EXCEPTION 'comment write contract requires missing function %',
        v_function_signature;
    END IF;

    IF NOT has_function_privilege('service_role', v_function_signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'comment write contract requires service_role execute on %',
        v_function_signature;
    END IF;

    IF has_function_privilege('anon', v_function_signature, 'EXECUTE')
       OR has_function_privilege('authenticated', v_function_signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'comment write contract found browser execute on %',
        v_function_signature;
    END IF;
  END LOOP;

  FOREACH v_retired_function_signature IN ARRAY ARRAY[
    'public.increment_comment_count(uuid)',
    'public.decrement_comment_count(uuid)',
    'public.increment_comment_like_count(uuid)',
    'public.decrement_comment_like_count(uuid)'
  ]
  LOOP
    IF to_regprocedure(v_retired_function_signature) IS NOT NULL
       AND (
         has_function_privilege(
           'service_role',
           v_retired_function_signature,
           'EXECUTE'
         )
         OR has_function_privilege(
           'anon',
           v_retired_function_signature,
           'EXECUTE'
         )
         OR has_function_privilege(
           'authenticated',
           v_retired_function_signature,
           'EXECUTE'
         )
       ) THEN
      RAISE EXCEPTION 'comment write contract requires execute revoked on retired function %',
        v_retired_function_signature;
    END IF;
  END LOOP;

  FOREACH v_trigger_name IN ARRAY ARRAY[
    'trg_comments_05_authoritative_reaction_counts',
    'trg_comments_10_validate_integrity',
    'trg_comments_10_cascade_soft_delete',
    'trg_comments_20_sync_post_count'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = 'public.comments'::regclass
        AND trigger_row.tgname = v_trigger_name
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgenabled <> 'D'
    ) THEN
      RAISE EXCEPTION 'comment write contract requires enabled trigger %',
        v_trigger_name;
    END IF;
  END LOOP;

  FOREACH v_trigger_name IN ARRAY ARRAY[
    'trg_comment_likes_10_validate_integrity',
    'trg_comment_likes_20_sync_counts'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = 'public.comment_likes'::regclass
        AND trigger_row.tgname = v_trigger_name
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgenabled <> 'D'
    ) THEN
      RAISE EXCEPTION 'comment write contract requires enabled trigger %',
        v_trigger_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.posts'::regclass
      AND trigger_row.tgname = 'trg_posts_05_authoritative_comment_count'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION
      'comment write contract requires enabled trigger trg_posts_05_authoritative_comment_count';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.posts AS post_row
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::integer AS source_count
      FROM public.comments AS comment_row
      WHERE comment_row.post_id = post_row.id
        AND comment_row.deleted_at IS NULL
    ) AS source_counts ON true
    WHERE post_row.comment_count IS DISTINCT FROM source_counts.source_count
  ) THEN
    RAISE EXCEPTION
      'comment write contract requires drift-free posts.comment_count';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.comments AS comment_row
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) FILTER (WHERE reaction.reaction_type = 'like')::integer AS like_count,
        COUNT(*) FILTER (WHERE reaction.reaction_type = 'dislike')::integer AS dislike_count
      FROM public.comment_likes AS reaction
      WHERE reaction.comment_id = comment_row.id
    ) AS source_counts ON true
    WHERE comment_row.like_count IS DISTINCT FROM source_counts.like_count
       OR comment_row.dislike_count IS DISTINCT FROM source_counts.dislike_count
  ) THEN
    RAISE EXCEPTION
      'comment write contract requires drift-free comment reaction counts';
  END IF;
END
$$;

-- Raw comment mutation bypasses interaction authorization and the global
-- post -> group -> comment lock order. Fail closed before validation takes a
-- post lock. Nested FK/source/soft-delete cascades are already under a canonical
-- parent lock; RPCs mark their transaction-local path explicitly.
CREATE OR REPLACE FUNCTION public.guard_canonical_comment_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_mutation_path text := current_setting('app.comment_mutation_path', true);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.deleted_at IS NOT NULL
       OR NEW.deleted_by IS NOT NULL
       OR NEW.delete_reason IS NOT NULL THEN
      RAISE EXCEPTION 'new comments must start active without moderation metadata'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  IF pg_trigger_depth() > 1
     OR v_mutation_path IN (
       'delete_own_comment',
       'moderate_comment',
       'update_own_comment'
     ) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'direct comment deletion is disabled; use the canonical RPC'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'direct comment deletion state changes are disabled; use the canonical RPC'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.deleted_by IS DISTINCT FROM OLD.deleted_by
     OR NEW.delete_reason IS DISTINCT FROM OLD.delete_reason THEN
    RAISE EXCEPTION 'direct comment moderation metadata changes are disabled; use the canonical RPC'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.content IS DISTINCT FROM OLD.content
     OR NEW.updated_at IS DISTINCT FROM OLD.updated_at THEN
    RAISE EXCEPTION 'direct comment content changes are disabled; use the canonical RPC'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_canonical_comment_mutation()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_comments_00_guard_canonical_delete ON public.comments;
DROP TRIGGER IF EXISTS trg_comments_00_guard_canonical_mutation ON public.comments;
CREATE TRIGGER trg_comments_00_guard_canonical_mutation
BEFORE INSERT OR DELETE OR UPDATE OF deleted_at, deleted_by, delete_reason, content, updated_at
ON public.comments
FOR EACH ROW
EXECUTE FUNCTION public.guard_canonical_comment_mutation();

-- A direct source-row lock inverts toggle's post -> group -> comment -> source
-- order. Only the marked toggle RPC may begin a top-level source mutation;
-- nested FK cascades are allowed because their parent is already locked.
CREATE OR REPLACE FUNCTION public.guard_canonical_comment_reaction_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF pg_trigger_depth() > 1
     OR current_setting('app.comment_reaction_path', true) = 'toggle_comment_reaction' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION 'direct comment reaction mutation is disabled; use toggle_comment_reaction'
    USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.guard_canonical_comment_reaction_mutation()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_comment_likes_00_guard_canonical_mutation
  ON public.comment_likes;
CREATE TRIGGER trg_comment_likes_00_guard_canonical_mutation
BEFORE INSERT OR UPDATE OR DELETE
ON public.comment_likes
FOR EACH ROW
EXECUTE FUNCTION public.guard_canonical_comment_reaction_mutation();

-- The expand bridges ignored top-level legacy counter values. With every direct
-- service writer retired, turn those attempts into explicit contract failures.
CREATE OR REPLACE FUNCTION public.guard_contract_post_comment_count()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.comment_count IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'new posts must start with a zero comment counter'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  IF pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'direct post comment counter updates are disabled'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_contract_post_comment_count()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_posts_04_contract_comment_count ON public.posts;
CREATE TRIGGER trg_posts_04_contract_comment_count
BEFORE INSERT OR UPDATE OF comment_count
ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.guard_contract_post_comment_count();

CREATE OR REPLACE FUNCTION public.guard_contract_comment_reaction_counts()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.like_count IS DISTINCT FROM 0
       OR NEW.dislike_count IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'new comments must start with zero reaction counters'
        USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
  END IF;

  IF pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'direct comment reaction counter updates are disabled'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_contract_comment_reaction_counts()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_comments_04_contract_reaction_counts ON public.comments;
CREATE TRIGGER trg_comments_04_contract_reaction_counts
BEFORE INSERT OR UPDATE OF like_count, dislike_count
ON public.comments
FOR EACH ROW
EXECUTE FUNCTION public.guard_contract_comment_reaction_counts();

-- service_role keeps comment INSERT for creation. Every edit/delete and every
-- comment_likes mutation must cross a SECURITY DEFINER canonical RPC.
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.comments
  FROM service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.comment_likes
  FROM service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
