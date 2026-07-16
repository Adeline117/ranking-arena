-- Preserve an author's right to erase their own comment after moderation.
--
-- The expand migration intentionally hides soft-deleted comments from every
-- browser read. Its first delete RPC also required deleted_at IS NULL, which
-- made an auto-hidden or moderator-hidden row impossible for its author to
-- remove once direct table DELETE was revoked. Keep the public RPC signature
-- stable, but hard-delete the owned source row regardless of visibility.
--
-- Deployment order is fail-closed: this migration must follow
-- 20260715091500_atomic_comment_integrity.sql. It may run before the contract
-- phase or be safely replayed after
-- 20260715100000_contract_comment_write_boundary.sql; replay never removes the
-- contract guards and keeps the service-only RPC signature and ACL unchanged.

BEGIN;

-- Do not silently install this replacement over a partial or out-of-order
-- expand deployment. In particular, a successful-looking function without the
-- canonical source/counter triggers could hard-delete data while returning a
-- stale posts.comment_count acknowledgement.
DO $migration_order$
DECLARE
  v_required_function text;
  v_required_trigger record;
  v_contract_function regprocedure :=
    to_regprocedure('public.guard_canonical_comment_mutation()');
  v_contract_trigger regprocedure;
BEGIN
  FOREACH v_required_function IN ARRAY ARRAY[
    'public.validate_comment_integrity()',
    'public.cascade_comment_soft_delete()',
    'public.sync_post_comment_count()',
    'public.bridge_legacy_post_comment_count()',
    'public.validate_comment_reaction_integrity()',
    'public.sync_comment_reaction_counts()',
    'public.bridge_legacy_comment_reaction_counts()',
    'public.toggle_comment_reaction(uuid,uuid,uuid,text)',
    'public.update_own_comment(uuid,uuid,uuid,text)',
    'public.delete_own_comment(uuid,uuid,uuid)',
    'public.moderate_comment(uuid,uuid,text,text)'
  ]
  LOOP
    IF to_regprocedure(v_required_function) IS NULL THEN
      RAISE EXCEPTION
        'hidden comment self-delete requires 20260715091500 before 20260715093000; missing function %',
        v_required_function;
    END IF;
  END LOOP;

  FOR v_required_trigger IN
    SELECT *
    FROM (VALUES
      (
        'public.comments',
        'trg_comments_05_authoritative_reaction_counts',
        'public.bridge_legacy_comment_reaction_counts()',
        19
      ),
      (
        'public.comments',
        'trg_comments_10_validate_integrity',
        'public.validate_comment_integrity()',
        23
      ),
      (
        'public.comments',
        'trg_comments_10_cascade_soft_delete',
        'public.cascade_comment_soft_delete()',
        17
      ),
      (
        'public.comments',
        'trg_comments_20_sync_post_count',
        'public.sync_post_comment_count()',
        29
      ),
      (
        'public.comment_likes',
        'trg_comment_likes_10_validate_integrity',
        'public.validate_comment_reaction_integrity()',
        23
      ),
      (
        'public.comment_likes',
        'trg_comment_likes_20_sync_counts',
        'public.sync_comment_reaction_counts()',
        29
      ),
      (
        'public.posts',
        'trg_posts_05_authoritative_comment_count',
        'public.bridge_legacy_post_comment_count()',
        19
      )
    ) AS required_trigger(
      table_name,
      trigger_name,
      function_name,
      expected_tgtype
    )
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid =
            pg_catalog.to_regclass(v_required_trigger.table_name)
        AND trigger_row.tgname = v_required_trigger.trigger_name
        AND trigger_row.tgfoid =
            pg_catalog.to_regprocedure(v_required_trigger.function_name)
        AND trigger_row.tgtype = v_required_trigger.expected_tgtype
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgenabled = 'O'
    ) THEN
      RAISE EXCEPTION
        'hidden comment self-delete requires canonical trigger %.% -> % with event mask % from 20260715091500',
        v_required_trigger.table_name,
        v_required_trigger.trigger_name,
        v_required_trigger.function_name,
        v_required_trigger.expected_tgtype;
    END IF;
  END LOOP;

  -- The physical-removal acknowledgement depends on both recursive cascades.
  -- Check the referenced column, target table, and ON DELETE action rather than
  -- relying on environment-specific constraint names.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'public.comments'::regclass
      AND constraint_row.confrelid = 'public.comments'::regclass
      AND constraint_row.confdeltype = 'c'
      AND (
        SELECT pg_catalog.array_agg(
          attribute_row.attname ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(constraint_row.conkey) WITH ORDINALITY
          AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute_row
          ON attribute_row.attrelid = constraint_row.conrelid
         AND attribute_row.attnum = key_column.attnum
      ) = ARRAY['parent_id']::name[]
  ) THEN
    RAISE EXCEPTION
      'hidden comment self-delete requires comments.parent_id ON DELETE CASCADE';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'public.comment_likes'::regclass
      AND constraint_row.confrelid = 'public.comments'::regclass
      AND constraint_row.confdeltype = 'c'
      AND (
        SELECT pg_catalog.array_agg(
          attribute_row.attname ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(constraint_row.conkey) WITH ORDINALITY
          AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute_row
          ON attribute_row.attrelid = constraint_row.conrelid
         AND attribute_row.attnum = key_column.attnum
      ) = ARRAY['comment_id']::name[]
  ) THEN
    RAISE EXCEPTION
      'hidden comment self-delete requires comment_likes.comment_id ON DELETE CASCADE';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.delete_own_comment(uuid,uuid,uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    'public.delete_own_comment(uuid,uuid,uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.delete_own_comment(uuid,uuid,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'hidden comment self-delete requires the service-only delete_own_comment ACL from 20260715091500';
  END IF;

  -- A replay after the contract is supported, but a half-installed contract is
  -- not. Confirm that its guard trigger still points at a guard which explicitly
  -- allows this transaction-local mutation path.
  SELECT trigger_row.tgfoid::regprocedure
  INTO v_contract_trigger
  FROM pg_catalog.pg_trigger AS trigger_row
  WHERE trigger_row.tgrelid = 'public.comments'::regclass
    AND trigger_row.tgname = 'trg_comments_00_guard_canonical_mutation'
    AND NOT trigger_row.tgisinternal
    AND trigger_row.tgenabled = 'O';

  IF (v_contract_function IS NULL) IS DISTINCT FROM (v_contract_trigger IS NULL)
  THEN
    RAISE EXCEPTION
      'hidden comment self-delete refuses a partial 20260715100000 contract deployment';
  END IF;

  IF v_contract_function IS NOT NULL
     AND (
       v_contract_trigger IS DISTINCT FROM v_contract_function
       OR pg_catalog.strpos(
         pg_catalog.pg_get_functiondef(v_contract_function),
         'delete_own_comment'
       ) = 0
     ) THEN
    RAISE EXCEPTION
      'comment write contract does not allow the delete_own_comment mutation path';
  END IF;
END
$migration_order$;

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
  v_comment_user_id uuid;
  v_previous_mutation_path text;
  v_deleted_root_count integer;
BEGIN
  IF p_comment_id IS NULL OR p_post_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'comment_id, post_id, and user_id are required'
      USING ERRCODE = '22023';
  END IF;

  -- The source row can be hidden, but its parent post must still exist. Lock
  -- post -> comment so source deletion, FK cascades, and the absolute counter
  -- acknowledgement remain one serialized transaction.
  PERFORM 1
  FROM public.posts AS locked_post
  WHERE locked_post.id = p_post_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'comment not found for post'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT comment_row.user_id
  INTO v_comment_user_id
  FROM public.comments AS comment_row
  WHERE comment_row.id = p_comment_id
    AND comment_row.post_id = p_post_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'comment not found for post'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_comment_user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'users may delete only their own comments'
      USING ERRCODE = '42501';
  END IF;

  -- Count and lock the complete physical FK subtree, not only active rows or
  -- direct replies. UNION (rather than UNION ALL) makes the traversal
  -- cycle-safe for malformed historical data. The materialized, UUID-ordered
  -- row-lock pass makes this count equal the rows the following root DELETE
  -- will physically erase, while the post lock prevents every canonical
  -- same-post insert/delete/restore from racing the snapshot.
  WITH RECURSIVE comment_subtree(id) AS (
    SELECT p_comment_id
    UNION
    SELECT descendant.id
    FROM public.comments AS descendant
    JOIN comment_subtree AS ancestor
      ON descendant.parent_id = ancestor.id
  ),
  locked_subtree AS MATERIALIZED (
    SELECT subtree_comment.id
    FROM public.comments AS subtree_comment
    JOIN comment_subtree
      ON comment_subtree.id = subtree_comment.id
    ORDER BY subtree_comment.id
    FOR UPDATE OF subtree_comment
  )
  SELECT COUNT(*)::integer
  INTO deleted_count
  FROM locked_subtree;

  IF deleted_count IS NULL OR deleted_count < 1 THEN
    RAISE EXCEPTION 'comment subtree disappeared while locking'
      USING ERRCODE = 'P0002';
  END IF;

  v_previous_mutation_path := current_setting('app.comment_mutation_path', true);
  PERFORM set_config('app.comment_mutation_path', 'delete_own_comment', true);

  DELETE FROM public.comments AS removed_comment
  WHERE removed_comment.id = p_comment_id
    AND removed_comment.post_id = p_post_id
    AND removed_comment.user_id = p_user_id;

  GET DIAGNOSTICS v_deleted_root_count = ROW_COUNT;

  PERFORM set_config(
    'app.comment_mutation_path',
    COALESCE(v_previous_mutation_path, ''),
    true
  );

  IF v_deleted_root_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'owned comment changed during deletion'
      USING ERRCODE = 'P0002';
  END IF;

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
  'Hard-deletes one owned comment, including a soft-hidden row, under post-to-comment locks and returns physical removals plus the absolute active count.';

NOTIFY pgrst, 'reload schema';

COMMIT;
