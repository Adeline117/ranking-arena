-- Migration: 20260803107000_set_comment_reaction_desired_state.sql
-- Created: 2026-08-03T11:10:00Z
-- Description: Add an idempotent desired-state authority for comment
--   like/dislike reactions. The legacy toggle remains available during the
--   rolling application cutover. Real transitions retain the sealed mature
--   authority; unchanged receipts mirror its non-removal audience checks
--   without mutating. Acknowledgements are rebuilt from canonical
--   comment_likes rows and every request leaves a coalesced repair obligation
--   for the cached counters.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

-- This is the same exclusive gate used by the 1060 queue migration. Runtime
-- workers and desired-state callers take its shared side before touching Q.
DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.comment-reaction-count-repair:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'comment reaction desired-state migration gate is busy';
  END IF;
END
$migration_lock$;

-- Freeze the complete hard-delete and runtime lock graph while the function
-- boundary is checked, replaced, attested, and published.
LOCK TABLE auth.users,
  public.posts,
  public.groups,
  public.comments,
  public.comment_likes,
  public.blocked_users,
  public.group_members,
  public.group_bans,
  public.user_follows,
  public.comment_reaction_count_repair_queue
IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_postgres_oid oid := pg_catalog.to_regrole('postgres');
  v_service_oid oid := pg_catalog.to_regrole('service_role');
  v_plpgsql_oid oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_missing_roles text[];
  v_relation regclass;
  v_expected record;
  v_function regprocedure;
  v_source text;
  v_comment text;
  v_acquire_source text;
  v_block_lock_source text;
  v_existing_function regprocedure := pg_catalog.to_regprocedure(
    'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)'
  );
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY[
      'anon',
      'authenticated',
      'authenticator',
      'service_role',
      'postgres'
    ]::text[]
  ) AS required_role
  WHERE pg_catalog.to_regrole(required_role) IS NULL;

  IF v_missing_roles IS NOT NULL
     OR v_postgres_oid IS NULL
     OR v_service_oid IS NULL
     OR v_plpgsql_oid IS NULL
  THEN
    RAISE EXCEPTION 'comment reaction desired-state foundations are missing: %',
      v_missing_roles;
  END IF;

  IF NOT COALESCE(
    (
      SELECT role_row.rolbypassrls AND NOT role_row.rolsuper
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_service_oid
    ),
    false
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname IN ('anon', 'authenticated', 'authenticator')
      AND (role_row.rolbypassrls OR role_row.rolsuper)
  ) THEN
    RAISE EXCEPTION 'comment reaction desired-state role boundary drifted';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.acquire_post_audience_block_edges(uuid,uuid[])'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.lock_post_interaction_block_edges(uuid,uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.toggle_comment_reaction_locked_impl(uuid,uuid,uuid,text)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.toggle_comment_reaction(uuid,uuid,uuid,text)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.enqueue_comment_reaction_count_repair()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.guard_canonical_comment_reaction_mutation()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.sync_comment_reaction_counts()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.guard_contract_comment_reaction_counts()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.repair_comment_reaction_counts_atomic(integer)'
     ) IS NULL
  THEN
    RAISE EXCEPTION
      '20260803106000 and canonical comment authorization must deploy first';
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    'public.posts'::pg_catalog.regclass,
    'public.groups'::pg_catalog.regclass,
    'public.comments'::pg_catalog.regclass,
    'public.comment_likes'::pg_catalog.regclass,
    'public.blocked_users'::pg_catalog.regclass,
    'public.group_members'::pg_catalog.regclass,
    'public.group_bans'::pg_catalog.regclass,
    'public.user_follows'::pg_catalog.regclass,
    'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND relation.relowner = v_postgres_oid
        AND NOT relation.relispartition
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid = v_relation
         OR inheritance.inhparent = v_relation
    ) THEN
      RAISE EXCEPTION
        'comment reaction desired-state requires a canonical permanent relation: %',
        v_relation;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('auth.users'::pg_catalog.regclass, 'id', 'uuid'::pg_catalog.regtype, true),
        ('public.posts'::pg_catalog.regclass, 'id', 'uuid'::pg_catalog.regtype, true),
        ('public.posts'::pg_catalog.regclass, 'author_id', 'uuid'::pg_catalog.regtype, true),
        ('public.posts'::pg_catalog.regclass, 'group_id', 'uuid'::pg_catalog.regtype, false),
        ('public.posts'::pg_catalog.regclass, 'original_post_id', 'uuid'::pg_catalog.regtype, false),
        ('public.posts'::pg_catalog.regclass, 'visibility', 'text'::pg_catalog.regtype, true),
        ('public.posts'::pg_catalog.regclass, 'deleted_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public.posts'::pg_catalog.regclass, 'status', 'public.post_status'::pg_catalog.regtype, true),
        ('public.groups'::pg_catalog.regclass, 'id', 'uuid'::pg_catalog.regtype, true),
        ('public.groups'::pg_catalog.regclass, 'dissolved_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public.comments'::pg_catalog.regclass, 'id', 'uuid'::pg_catalog.regtype, true),
        ('public.comments'::pg_catalog.regclass, 'post_id', 'uuid'::pg_catalog.regtype, true),
        ('public.comments'::pg_catalog.regclass, 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('public.comments'::pg_catalog.regclass, 'deleted_at', 'timestamptz'::pg_catalog.regtype, false),
        ('public.comment_likes'::pg_catalog.regclass, 'comment_id', 'uuid'::pg_catalog.regtype, true),
        ('public.comment_likes'::pg_catalog.regclass, 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('public.comment_likes'::pg_catalog.regclass, 'reaction_type', 'text'::pg_catalog.regtype, true),
        ('public.blocked_users'::pg_catalog.regclass, 'blocker_id', 'uuid'::pg_catalog.regtype, true),
        ('public.blocked_users'::pg_catalog.regclass, 'blocked_id', 'uuid'::pg_catalog.regtype, true),
        ('public.group_members'::pg_catalog.regclass, 'group_id', 'uuid'::pg_catalog.regtype, true),
        ('public.group_members'::pg_catalog.regclass, 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('public.group_bans'::pg_catalog.regclass, 'group_id', 'uuid'::pg_catalog.regtype, true),
        ('public.group_bans'::pg_catalog.regclass, 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('public.user_follows'::pg_catalog.regclass, 'follower_id', 'uuid'::pg_catalog.regtype, true),
        ('public.user_follows'::pg_catalog.regclass, 'following_id', 'uuid'::pg_catalog.regtype, true),
        ('public.comment_reaction_count_repair_queue'::pg_catalog.regclass, 'comment_id', 'uuid'::pg_catalog.regtype, true)
    ) AS required_column(relation_oid, column_name, type_oid, required_not_null)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = required_column.relation_oid
        AND attribute.attname = required_column.column_name
        AND attribute.atttypid = required_column.type_oid
        AND (
          NOT required_column.required_not_null
          OR attribute.attnotnull
        )
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  ) THEN
    RAISE EXCEPTION 'comment reaction desired-state column shape drifted';
  END IF;

  -- Refuse same-name overload residue. PostgREST must expose exactly one
  -- unambiguous desired-state authority.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname =
        'set_comment_reaction_desired_state_atomic'
      AND function_row.oid IS DISTINCT FROM v_existing_function
  ) THEN
    RAISE EXCEPTION
      'incompatible set_comment_reaction_desired_state_atomic overload exists';
  END IF;

  -- The advisory helper is part of the authorization boundary, not merely a
  -- convenience call. Pin both layers to the canonical 161145 deployment so
  -- a rewritten helper cannot silently remove absent-edge serialization.
  SELECT function_row.prosrc
  INTO STRICT v_acquire_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
      'public.acquire_post_audience_block_edges(uuid,uuid[])'::pg_catalog.regprocedure
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'void'::pg_catalog.regtype
    AND NOT function_row.proretset
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prolang = v_plpgsql_oid
    AND NOT function_row.proisstrict
    AND function_row.proparallel = 'u'
    AND NOT function_row.proleakproof
    AND function_row.pronargs = 2
    AND function_row.pronargdefaults = 0
    AND function_row.proargnames = ARRAY[
      'p_actor_id',
      'p_author_ids'
    ]::text[]
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  SELECT function_row.prosrc
  INTO STRICT v_block_lock_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
      'public.lock_post_interaction_block_edges(uuid,uuid,uuid)'::pg_catalog.regprocedure
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'boolean'::pg_catalog.regtype
    AND NOT function_row.proretset
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prolang = v_plpgsql_oid
    AND NOT function_row.proisstrict
    AND function_row.proparallel = 'u'
    AND NOT function_row.proleakproof
    AND function_row.pronargs = 3
    AND function_row.pronargdefaults = 1
    AND function_row.proargnames = ARRAY[
      'p_post_id',
      'p_actor_id',
      'p_target_comment_id'
    ]::text[]
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.md5(v_acquire_source) IS DISTINCT FROM
       'ee7b907524e2ad83f81808d6b66b23ef'
     OR pg_catalog.md5(v_block_lock_source) IS DISTINCT FROM
       '10644ff85375d6598d9122eb104bc151'
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
         AND function_row.proname IN (
           'acquire_post_audience_block_edges',
           'lock_post_interaction_block_edges'
         )
     ) <> 2
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid IN (
         'public.acquire_post_audience_block_edges(uuid,uuid[])'::pg_catalog.regprocedure,
         'public.lock_post_interaction_block_edges(uuid,uuid,uuid)'::pg_catalog.regprocedure
       )
         AND acl_entry.grantee <> v_postgres_oid
     )
  THEN
    RAISE EXCEPTION
      'comment reaction block-edge authorization dependency drifted';
  END IF;

  -- 1060 closed every source mutation path. Re-check that boundary here;
  -- row triggers cannot protect the source table from TRUNCATE.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = 'public.comment_likes'::pg_catalog.regclass
      AND acl_entry.grantee <> v_postgres_oid
      AND acl_entry.privilege_type <> 'SELECT'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = 'public.comment_likes'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_postgres_oid
      AND acl_entry.privilege_type <> 'SELECT'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'authenticator', 'service_role']::text[]
    ) AS role_name
    WHERE pg_catalog.has_any_column_privilege(
            role_name,
            'public.comment_likes',
            'INSERT,UPDATE,REFERENCES'
          )
       OR pg_catalog.has_table_privilege(
            role_name,
            'public.comment_likes',
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid =
      'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
      AND acl_entry.grantee <> v_postgres_oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid =
      'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION
      'comment reaction source or repair queue ACL boundary drifted';
  END IF;

  -- Pin the authorities that the new wrapper composes. Their source hashes
  -- were emitted by 1060 (or the block-authorization migration for the sealed
  -- implementation), so a later source rewrite cannot silently enter this
  -- security-definer chain.
  FOR v_expected IN
    SELECT *
    FROM (
      VALUES
        (
          'public.toggle_comment_reaction_locked_impl(uuid,uuid,uuid,text)',
          'atomic-comment-block-authorization:v1:'
        ),
        (
          'public.toggle_comment_reaction(uuid,uuid,uuid,text)',
          'comment-reaction-count-repair:legacy-wrapper-v1:'
        ),
        (
          'public.enqueue_comment_reaction_count_repair()',
          'comment-reaction-count-repair:enqueue-v1:'
        ),
        (
          'public.guard_canonical_comment_reaction_mutation()',
          'comment-reaction-count-repair:source-guard-v1:'
        ),
        (
          'public.sync_comment_reaction_counts()',
          'comment-reaction-count-repair:sync-v1:'
        ),
        (
          'public.guard_contract_comment_reaction_counts()',
          'comment-reaction-count-repair:guard-v1:'
        ),
        (
          'public.repair_comment_reaction_counts_atomic(integer)',
          'comment-reaction-count-repair:worker-v1:'
        )
    ) AS expected(signature, comment_prefix)
  LOOP
    v_function := pg_catalog.to_regprocedure(v_expected.signature);
    SELECT function_row.prosrc,
           pg_catalog.obj_description(function_row.oid, 'pg_proc')
    INTO STRICT v_source, v_comment
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.proowner = v_postgres_oid;

    IF v_comment IS DISTINCT FROM
      v_expected.comment_prefix || pg_catalog.md5(v_source)
    THEN
      RAISE EXCEPTION 'comment reaction dependency source drifted: %',
        v_expected.signature;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid =
      'public.toggle_comment_reaction_locked_impl(uuid,uuid,uuid,text)'::pg_catalog.regprocedure
      AND acl_entry.grantee <> v_postgres_oid
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.toggle_comment_reaction(uuid,uuid,uuid,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'comment reaction composed authority ACL drifted';
  END IF;
END
$preflight$;

-- Leave machine-verifiable seals on the two canonical block-edge primitives
-- after their hard-coded deployment digests have passed preflight.
DO $attest_block_edge_dependencies$
DECLARE
  v_expected record;
  v_source text;
BEGIN
  FOR v_expected IN
    SELECT *
    FROM (
      VALUES
        (
          'public.acquire_post_audience_block_edges(uuid,uuid[])',
          'comment-reaction-desired-state:block-edge-acquire-v1:'
        ),
        (
          'public.lock_post_interaction_block_edges(uuid,uuid,uuid)',
          'comment-reaction-desired-state:block-edge-lock-v1:'
        )
    ) AS expected(signature, comment_prefix)
  LOOP
    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      pg_catalog.to_regprocedure(v_expected.signature);

    EXECUTE pg_catalog.format(
      'COMMENT ON FUNCTION %s IS %L',
      v_expected.signature,
      v_expected.comment_prefix || pg_catalog.md5(v_source)
    );
  END LOOP;
END
$attest_block_edge_dependencies$;

CREATE OR REPLACE FUNCTION public.set_comment_reaction_desired_state_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_comment_id uuid,
  p_desired_reaction text
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
  v_post_author_id uuid;
  v_post_visibility text;
  v_group_id uuid;
  v_group_dissolved_at timestamptz;
  v_original_post_id uuid;
  v_root_author_id uuid;
  v_comment_author_id uuid;
  v_existing_type text;
  v_has_existing boolean;
  v_action text;
  v_final_reaction text;
  v_legacy_result jsonb;
  v_like_count bigint;
  v_dislike_count bigint;
BEGIN
  -- Authentication deliberately precedes argument validation, migration-gate
  -- acquisition, relation access, and every identity observation.
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_actor_id IS NULL
     OR p_post_id IS NULL
     OR p_comment_id IS NULL
     OR (
       p_desired_reaction IS NOT NULL
       AND p_desired_reaction NOT IN ('like', 'dislike')
     )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(
    pg_catalog.hashtextextended(
      'public.comment-reaction-count-repair:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'comment reaction desired-state migration gate is busy';
  END IF;

  -- Freeze the actor lifecycle before block edges and the canonical
  -- post -> group -> comment -> source -> Q row order. A concurrent hard
  -- account deletion either wins first (not_found) or cascades after commit.
  PERFORM 1
  FROM auth.users AS actor_account
  WHERE actor_account.id = p_actor_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF NOT public.lock_post_interaction_block_edges(
    p_post_id,
    p_actor_id,
    p_comment_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT
    target_post.author_id,
    target_post.visibility,
    target_post.group_id,
    target_post.original_post_id
  INTO
    v_post_author_id,
    v_post_visibility,
    v_group_id,
    v_original_post_id
  FROM public.posts AS target_post
  WHERE target_post.id = p_post_id
    AND target_post.deleted_at IS NULL
    AND target_post.status = 'active'::public.post_status
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- author_id/original_post_id are guarded immutable identities. The complete
  -- wrapper/root edge set is already advisory locked, and the wrapper SHARE
  -- lock prevents a root cascade from crossing this authorization snapshot.
  IF v_original_post_id IS NOT NULL THEN
    SELECT root_post.author_id
    INTO v_root_author_id
    FROM public.posts AS root_post
    WHERE root_post.id = v_original_post_id
      AND root_post.original_post_id IS NULL;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('status', 'not_found');
    END IF;
  END IF;

  IF v_group_id IS NOT NULL THEN
    SELECT interaction_group.dissolved_at
    INTO v_group_dissolved_at
    FROM public.groups AS interaction_group
    WHERE interaction_group.id = v_group_id
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('status', 'not_found');
    END IF;
  END IF;

  SELECT target_comment.user_id
  INTO v_comment_author_id
  FROM public.comments AS target_comment
  WHERE target_comment.id = p_comment_id
    AND target_comment.post_id = p_post_id
    AND target_comment.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT reaction.reaction_type
  INTO v_existing_type
  FROM public.comment_likes AS reaction
  WHERE reaction.comment_id = p_comment_id
    AND reaction.user_id = p_actor_id
  FOR UPDATE;
  v_has_existing := FOUND;

  IF NOT v_has_existing THEN
    IF p_desired_reaction IS NULL THEN
      v_action := 'unchanged';
      v_final_reaction := NULL;
    ELSE
      v_action := 'added';
      v_final_reaction := p_desired_reaction;
    END IF;
  ELSIF p_desired_reaction IS NULL THEN
    v_action := 'removed';
    v_final_reaction := NULL;
  ELSIF v_existing_type = p_desired_reaction THEN
    v_action := 'unchanged';
    v_final_reaction := v_existing_type;
  ELSE
    v_action := 'changed';
    v_final_reaction := p_desired_reaction;
  END IF;

  -- The sealed implementation's INSERT/UPDATE trigger protects the repost
  -- root edge, but this RPC owns the check too so desired-state correctness is
  -- not conditional on a later trigger. A real removal remains exempt.
  IF v_action IS DISTINCT FROM 'removed'
     AND v_root_author_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.blocked_users AS root_interaction_block
       WHERE (
         root_interaction_block.blocker_id = p_actor_id
         AND root_interaction_block.blocked_id = v_root_author_id
       ) OR (
         root_interaction_block.blocker_id = v_root_author_id
         AND root_interaction_block.blocked_id = p_actor_id
       )
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'a root-author block prevents this comment interaction';
  END IF;

  -- An unchanged desired-state request is still a current interaction and may
  -- disclose exact source counts. Apply the same non-removal permissions as
  -- the sealed mutator. This block performs no mutation and takes no parent
  -- lock after comment/source, preserving the canonical lock order. A real
  -- removal deliberately bypasses it so users may withdraw after a block,
  -- ban, membership loss, or group dissolution.
  IF v_action = 'unchanged' THEN
    IF v_group_id IS NOT NULL
       AND v_group_dissolved_at IS NOT NULL
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'comment reactions are disabled for dissolved groups';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.blocked_users AS interaction_block
      WHERE (
        interaction_block.blocker_id = p_actor_id
        AND interaction_block.blocked_id = v_post_author_id
      ) OR (
        interaction_block.blocker_id = v_post_author_id
        AND interaction_block.blocked_id = p_actor_id
      )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'a block relationship prevents reactions on this post';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.blocked_users AS target_interaction_block
      WHERE (
        target_interaction_block.blocker_id = p_actor_id
        AND target_interaction_block.blocked_id = v_comment_author_id
      ) OR (
        target_interaction_block.blocker_id = v_comment_author_id
        AND target_interaction_block.blocked_id = p_actor_id
      )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'a block relationship prevents reactions to this comment';
    END IF;

    IF v_group_id IS NOT NULL THEN
      IF EXISTS (
        SELECT 1
        FROM public.group_bans AS active_ban
        WHERE active_ban.group_id = v_group_id
          AND active_ban.user_id = p_actor_id
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '42501',
          MESSAGE = 'banned users cannot react in this group';
      END IF;

      PERFORM 1
      FROM public.group_members AS active_member
      WHERE active_member.group_id = v_group_id
        AND active_member.user_id = p_actor_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '42501',
          MESSAGE = 'group membership required to react to this comment';
      END IF;
    ELSIF v_post_visibility = 'followers' THEN
      IF v_post_author_id IS DISTINCT FROM p_actor_id THEN
        PERFORM 1
        FROM public.user_follows AS active_follow
        WHERE active_follow.follower_id = p_actor_id
          AND active_follow.following_id = v_post_author_id;

        IF NOT FOUND THEN
          RAISE EXCEPTION USING
            ERRCODE = '42501',
            MESSAGE = 'follower access required to react to this comment';
        END IF;
      END IF;
    ELSIF v_post_visibility = 'group' THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'group membership required to react to this comment';
    ELSIF v_post_visibility IS DISTINCT FROM 'public' THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'post audience does not allow this interaction';
    END IF;
  END IF;

  -- The sealed implementation remains the real-transition authorization and
  -- source-mutation authority. It is invoked only for an edge transition;
  -- unchanged retries therefore cannot accidentally toggle the state away.
  IF v_action IS DISTINCT FROM 'unchanged' THEN
    v_legacy_result := public.toggle_comment_reaction_locked_impl(
      p_post_id,
      p_comment_id,
      p_actor_id,
      CASE
        WHEN v_action = 'removed' THEN v_existing_type
        ELSE p_desired_reaction
      END
    );

    IF pg_catalog.jsonb_typeof(v_legacy_result) IS DISTINCT FROM 'object'
       OR (
         SELECT pg_catalog.count(*)
         FROM pg_catalog.jsonb_object_keys(v_legacy_result)
       ) <> 6
       OR NOT v_legacy_result ?& ARRAY[
         'action',
         'reaction',
         'liked',
         'disliked',
         'like_count',
         'dislike_count'
       ]::text[]
       OR v_legacy_result->>'action' IS DISTINCT FROM v_action
       OR v_legacy_result->'reaction' IS DISTINCT FROM (
         CASE
           WHEN v_final_reaction IS NULL THEN 'null'::jsonb
           ELSE pg_catalog.to_jsonb(v_final_reaction)
         END
       )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'sealed comment reaction authority returned an invalid acknowledgement';
    END IF;
  END IF;

  -- Mutation triggers already enqueue, but unchanged retries have no source
  -- event. This explicit coalescing insert makes both paths equally durable and
  -- takes Q only after post/group/comment/source ownership.
  INSERT INTO public.comment_reaction_count_repair_queue (comment_id)
  VALUES (p_comment_id)
  ON CONFLICT (comment_id) DO NOTHING;

  -- Never trust the cached comment counters in the API acknowledgement.
  SELECT
    pg_catalog.count(*) FILTER (
      WHERE reaction.reaction_type = 'like'
    ),
    pg_catalog.count(*) FILTER (
      WHERE reaction.reaction_type = 'dislike'
    )
  INTO v_like_count, v_dislike_count
  FROM public.comment_likes AS reaction
  WHERE reaction.comment_id = p_comment_id;

  IF v_like_count > 2147483647
     OR v_dislike_count > 2147483647
     OR (
       v_final_reaction = 'like'
       AND v_like_count < 1
     )
     OR (
       v_final_reaction = 'dislike'
       AND v_dislike_count < 1
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22003',
      MESSAGE = 'comment reaction canonical count is invalid';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_action,
    'action', v_action,
    'reaction', v_final_reaction,
    'liked', COALESCE(v_final_reaction = 'like', false),
    'disliked', COALESCE(v_final_reaction = 'dislike', false),
    'like_count', v_like_count::integer,
    'dislike_count', v_dislike_count::integer
  );
END
$function$;

ALTER FUNCTION public.set_comment_reaction_desired_state_atomic(
  uuid, uuid, uuid, text
) OWNER TO postgres;

-- CREATE OR REPLACE preserves arbitrary historical grants. Converge every
-- non-owner grantee (including PUBLIC and unknown roles), then publish only the
-- service role without grant option.
DO $converge_function_acl$
DECLARE
  v_function regprocedure :=
    'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)'::regprocedure;
  v_owner oid;
  v_grantee record;
  v_grantee_sql text;
BEGIN
  SELECT function_row.proowner
  INTO STRICT v_owner
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

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
    WHERE function_row.oid = v_function
      AND acl_entry.grantee <> v_owner
  LOOP
    IF v_grantee.grantee <> 0 AND v_grantee.rolname IS NULL THEN
      RAISE EXCEPTION
        'comment reaction desired-state ACL references missing role oid %',
        v_grantee.grantee;
    END IF;

    v_grantee_sql := CASE
      WHEN v_grantee.grantee = 0 THEN 'PUBLIC'
      ELSE pg_catalog.quote_ident(v_grantee.rolname)
    END;
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION %s FROM %s CASCADE',
      v_function,
      v_grantee_sql
    );
  END LOOP;

  GRANT EXECUTE ON FUNCTION
    public.set_comment_reaction_desired_state_atomic(uuid, uuid, uuid, text)
    TO service_role;
END
$converge_function_acl$;

DO $attest_source$
DECLARE
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)'::regprocedure;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text) IS %L',
    'comment-reaction-desired-state:v1:' || pg_catalog.md5(v_source)
  );
END
$attest_source$;

DO $postflight$
DECLARE
  v_postgres_oid oid := pg_catalog.to_regrole('postgres');
  v_service_oid oid := pg_catalog.to_regrole('service_role');
  v_plpgsql_oid oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_function regprocedure :=
    'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)'::regprocedure;
  v_source text;
  v_comment text;
  v_acquire_source text;
  v_acquire_comment text;
  v_block_lock_source text;
  v_block_lock_comment text;
  v_auth integer;
  v_validation integer;
  v_gate integer;
  v_account integer;
  v_block_edges integer;
  v_post integer;
  v_group integer;
  v_comment_lock integer;
  v_source_lock integer;
  v_unchanged_authorization integer;
  v_mutation integer;
  v_queue integer;
  v_recount integer;
BEGIN
  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
    AND NOT function_row.proretset
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prolang = v_plpgsql_oid
    AND NOT function_row.proisstrict
    AND function_row.proparallel = 'u'
    AND NOT function_row.proleakproof
    AND function_row.pronargs = 4
    AND function_row.pronargdefaults = 0
    AND function_row.proargnames = ARRAY[
      'p_actor_id',
      'p_post_id',
      'p_comment_id',
      'p_desired_reaction'
    ]::text[]
    AND pg_catalog.cardinality(function_row.proconfig) = 4
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off',
      'lock_timeout=5s',
      'statement_timeout=15s'
    ]::text[];

  v_auth := pg_catalog.strpos(v_source, 'service role required');
  v_validation := pg_catalog.strpos(
    v_source,
    'p_desired_reaction NOT IN (''like'', ''dislike'')'
  );
  v_gate := pg_catalog.strpos(
    v_source,
    'pg_catalog.pg_try_advisory_xact_lock_shared'
  );
  v_account := pg_catalog.strpos(v_source, 'FROM auth.users AS actor_account');
  v_block_edges := pg_catalog.strpos(
    v_source,
    'public.lock_post_interaction_block_edges'
  );
  v_post := pg_catalog.strpos(v_source, 'FROM public.posts AS target_post');
  v_group := pg_catalog.strpos(v_source, 'FROM public.groups AS interaction_group');
  v_comment_lock := pg_catalog.strpos(
    v_source,
    'FROM public.comments AS target_comment'
  );
  v_source_lock := pg_catalog.strpos(
    v_source,
    'FROM public.comment_likes AS reaction'
  );
  v_unchanged_authorization := pg_catalog.strpos(
    v_source,
    'IF v_action = ''unchanged'' THEN'
  );
  v_mutation := pg_catalog.strpos(
    v_source,
    'public.toggle_comment_reaction_locked_impl'
  );
  v_queue := pg_catalog.strpos(
    v_source,
    'INSERT INTO public.comment_reaction_count_repair_queue'
  );
  v_recount := pg_catalog.strpos(v_source, 'pg_catalog.count(*) FILTER');

  IF v_comment IS DISTINCT FROM
       'comment-reaction-desired-state:v1:' || pg_catalog.md5(v_source)
     OR v_auth = 0
     OR v_validation <= v_auth
     OR v_gate <= v_validation
     OR v_account <= v_gate
     OR v_block_edges <= v_account
     OR v_post <= v_block_edges
     OR v_group <= v_post
     OR v_comment_lock <= v_group
     OR v_source_lock <= v_comment_lock
     OR v_unchanged_authorization <= v_source_lock
     OR v_mutation <= v_unchanged_authorization
     OR v_queue <= v_mutation
     OR v_recount <= v_queue
     OR pg_catalog.strpos(v_source, 'v_action := ''unchanged''') = 0
     OR pg_catalog.strpos(
       v_source,
       'v_action IS DISTINCT FROM ''unchanged'''
     ) = 0
     OR pg_catalog.strpos(
       v_source,
       'a root-author block prevents this comment interaction'
     ) = 0
     OR pg_catalog.strpos(
       v_source,
       'v_action IS DISTINCT FROM ''removed'''
     ) = 0
     OR pg_catalog.strpos(
       v_source,
       'group membership required to react to this comment'
     ) = 0
     OR pg_catalog.strpos(
       v_source,
       'follower access required to react to this comment'
     ) = 0
     OR pg_catalog.strpos(v_source, 'ON CONFLICT (comment_id) DO NOTHING') = 0
     OR pg_catalog.strpos(
       v_source,
       'WHERE reaction.comment_id = p_comment_id'
     ) = 0
     OR pg_catalog.strpos(v_source, 'v_legacy_result->>''action''') = 0
     OR (
       pg_catalog.length(v_source)
       - pg_catalog.length(
         pg_catalog.replace(
           v_source,
           'pg_try_advisory_xact_lock_shared',
           ''
         )
       )
     ) <> pg_catalog.length('pg_try_advisory_xact_lock_shared')
  THEN
    RAISE EXCEPTION
      'comment reaction desired-state source or lock order drifted';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_acquire_source, v_acquire_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
      'public.acquire_post_audience_block_edges(uuid,uuid[])'::pg_catalog.regprocedure
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'void'::pg_catalog.regtype
    AND NOT function_row.proretset
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prolang = v_plpgsql_oid
    AND NOT function_row.proisstrict
    AND function_row.proparallel = 'u'
    AND NOT function_row.proleakproof
    AND function_row.pronargs = 2
    AND function_row.pronargdefaults = 0
    AND function_row.proargnames = ARRAY[
      'p_actor_id',
      'p_author_ids'
    ]::text[]
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_block_lock_source, v_block_lock_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
      'public.lock_post_interaction_block_edges(uuid,uuid,uuid)'::pg_catalog.regprocedure
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'boolean'::pg_catalog.regtype
    AND NOT function_row.proretset
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prolang = v_plpgsql_oid
    AND NOT function_row.proisstrict
    AND function_row.proparallel = 'u'
    AND NOT function_row.proleakproof
    AND function_row.pronargs = 3
    AND function_row.pronargdefaults = 1
    AND function_row.proargnames = ARRAY[
      'p_post_id',
      'p_actor_id',
      'p_target_comment_id'
    ]::text[]
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.md5(v_acquire_source) IS DISTINCT FROM
       'ee7b907524e2ad83f81808d6b66b23ef'
     OR v_acquire_comment IS DISTINCT FROM
       'comment-reaction-desired-state:block-edge-acquire-v1:'
         || pg_catalog.md5(v_acquire_source)
     OR pg_catalog.md5(v_block_lock_source) IS DISTINCT FROM
       '10644ff85375d6598d9122eb104bc151'
     OR v_block_lock_comment IS DISTINCT FROM
       'comment-reaction-desired-state:block-edge-lock-v1:'
         || pg_catalog.md5(v_block_lock_source)
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
         AND function_row.proname IN (
           'acquire_post_audience_block_edges',
           'lock_post_interaction_block_edges'
         )
     ) <> 2
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid IN (
         'public.acquire_post_audience_block_edges(uuid,uuid[])'::pg_catalog.regprocedure,
         'public.lock_post_interaction_block_edges(uuid,uuid,uuid)'::pg_catalog.regprocedure
       )
         AND acl_entry.grantee <> v_postgres_oid
     )
  THEN
    RAISE EXCEPTION
      'comment reaction block-edge dependency postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = 'public.comment_likes'::pg_catalog.regclass
      AND acl_entry.grantee <> v_postgres_oid
      AND acl_entry.privilege_type <> 'SELECT'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = 'public.comment_likes'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_postgres_oid
      AND acl_entry.privilege_type <> 'SELECT'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'authenticator', 'service_role']::text[]
    ) AS role_name
    WHERE pg_catalog.has_any_column_privilege(
            role_name,
            'public.comment_likes',
            'INSERT,UPDATE,REFERENCES'
          )
       OR pg_catalog.has_table_privilege(
            role_name,
            'public.comment_likes',
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid =
      'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
      AND acl_entry.grantee <> v_postgres_oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid =
      'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION
      'comment reaction source or repair queue ACL postflight failed';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname =
        'set_comment_reaction_desired_state_atomic'
  ) <> 1
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticator', v_function, 'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid = v_function
         AND acl_entry.privilege_type = 'EXECUTE'
         AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid = v_function
         AND acl_entry.grantee = v_service_oid
         AND acl_entry.is_grantable
     )
  THEN
    RAISE EXCEPTION 'comment reaction desired-state ACL postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
