-- Migration: 20260803106000_durable_comment_reaction_count_repair.sql
-- Created: 2026-08-03T11:00:00Z
-- Description: Make comments.like_count/dislike_count recoverable from
--   comment_likes without allowing auth/comment/post cascades to lock the
--   comments parent from a child trigger. Canonical legacy toggles keep their
--   synchronous acknowledgement, while every source mutation also leaves a
--   private durable repair obligation. The bounded worker owns the runtime
--   order posts -> comments -> queue.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

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
      MESSAGE = 'comment reaction count repair migration lock is busy';
  END IF;
END
$migration_lock$;

DO $foundations$
DECLARE
  v_missing_roles text[];
  v_relation_name text;
  v_signature text;
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

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'comment reaction count repair roles are missing: %',
      v_missing_roles;
  END IF;

  FOREACH v_relation_name IN ARRAY ARRAY[
    'auth.users',
    'public.posts',
    'public.comments',
    'public.comment_likes'
  ]::text[]
  LOOP
    IF pg_catalog.to_regclass(v_relation_name) IS NULL THEN
      RAISE EXCEPTION 'comment reaction count repair relation is missing: %',
        v_relation_name;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'auth.role()',
    'public.lock_post_interaction_block_edges(uuid,uuid,uuid)',
    'public.toggle_comment_reaction_locked_impl(uuid,uuid,uuid,text)',
    'public.toggle_comment_reaction(uuid,uuid,uuid,text)',
    'public.sync_comment_reaction_counts()',
    'public.guard_canonical_comment_reaction_mutation()',
    'public.guard_contract_comment_reaction_counts()'
  ]::text[]
  LOOP
    IF pg_catalog.to_regprocedure(v_signature) IS NULL THEN
      RAISE EXCEPTION 'comment reaction count repair function is missing: %',
        v_signature;
    END IF;
  END LOOP;

  IF pg_catalog.to_regclass(
       'public.comment_reaction_count_repair_queue'
     ) IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation
       WHERE relation.oid =
         pg_catalog.to_regclass(
           'public.comment_reaction_count_repair_queue'
         )
         AND relation.relkind = 'r'
         AND relation.relpersistence = 'p'
         AND relation.relowner = pg_catalog.to_regrole('postgres')
         AND NOT relation.relispartition
     )
  THEN
    RAISE EXCEPTION
      'existing comment reaction count repair queue is not a canonical permanent table';
  END IF;
END
$foundations$;

-- Freeze the dependency graph in hard-delete parent-to-child order. Runtime
-- repair never takes auth.users and claims Q only after both parent rows.
LOCK TABLE auth.users,
  public.posts,
  public.comments,
  public.comment_likes
IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_postgres_oid oid := pg_catalog.to_regrole('postgres');
  v_relation regclass;
  v_auth_id_attnum smallint;
  v_post_id_attnum smallint;
  v_comment_id_attnum smallint;
  v_comment_post_attnum smallint;
  v_reaction_id_attnum smallint;
  v_reaction_comment_attnum smallint;
  v_reaction_user_attnum smallint;
  v_sync_source text;
  v_wrapper_source text;
  v_internal_source text;
  v_guard_source text;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.posts'::pg_catalog.regclass,
    'public.comments'::pg_catalog.regclass,
    'public.comment_likes'::pg_catalog.regclass
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
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_rewrite AS rewrite_rule
      WHERE rewrite_rule.ev_class = v_relation
    ) THEN
      RAISE EXCEPTION
        'comment reaction count repair requires a canonical permanent relation: %',
        v_relation;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('public.posts'::pg_catalog.regclass, 'id', 'uuid'::pg_catalog.regtype, true),
        ('public.comments'::pg_catalog.regclass, 'id', 'uuid'::pg_catalog.regtype, true),
        ('public.comments'::pg_catalog.regclass, 'post_id', 'uuid'::pg_catalog.regtype, true),
        ('public.comments'::pg_catalog.regclass, 'like_count', 'integer'::pg_catalog.regtype, true),
        ('public.comments'::pg_catalog.regclass, 'dislike_count', 'integer'::pg_catalog.regtype, true),
        ('public.comment_likes'::pg_catalog.regclass, 'id', 'uuid'::pg_catalog.regtype, true),
        ('public.comment_likes'::pg_catalog.regclass, 'comment_id', 'uuid'::pg_catalog.regtype, true),
        ('public.comment_likes'::pg_catalog.regclass, 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('public.comment_likes'::pg_catalog.regclass, 'reaction_type', 'text'::pg_catalog.regtype, true)
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
    RAISE EXCEPTION 'comment reaction count repair source column shape drifted';
  END IF;

  SELECT attribute.attnum
  INTO STRICT v_auth_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'auth.users'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.atttypid = 'uuid'::pg_catalog.regtype
    AND attribute.attnotnull
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_post_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.posts'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_comment_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.comments'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_comment_post_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.comments'::pg_catalog.regclass
    AND attribute.attname = 'post_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_reaction_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.comment_likes'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_reaction_comment_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.comment_likes'::pg_catalog.regclass
    AND attribute.attname = 'comment_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_reaction_user_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.comment_likes'::pg_catalog.regclass
    AND attribute.attname = 'user_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.comment_likes'::pg_catalog.regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.convalidated
      AND constraint_row.conkey = ARRAY[v_reaction_id_attnum]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.comment_likes'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 2
      AND index_row.indnatts = 2
      AND (
        SELECT pg_catalog.array_agg(
          key_column.attnum ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_row.indkey::smallint[])
          WITH ORDINALITY AS key_column(attnum, ordinality)
      ) = ARRAY[
        v_reaction_comment_attnum,
        v_reaction_user_attnum
      ]::smallint[]
  ) THEN
    RAISE EXCEPTION
      'comment_likes requires exact id PK and UNIQUE (comment_id, user_id)';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.comments'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.convalidated
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.confrelid = 'public.posts'::pg_catalog.regclass
      AND constraint_row.conkey = ARRAY[v_comment_post_attnum]::smallint[]
      AND constraint_row.confkey = ARRAY[v_post_id_attnum]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.comment_likes'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.convalidated
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.confrelid = 'public.comments'::pg_catalog.regclass
      AND constraint_row.conkey = ARRAY[v_reaction_comment_attnum]::smallint[]
      AND constraint_row.confkey = ARRAY[v_comment_id_attnum]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.comment_likes'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.convalidated
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.conkey = ARRAY[v_reaction_user_attnum]::smallint[]
      AND constraint_row.confkey = ARRAY[v_auth_id_attnum]::smallint[]
  ) THEN
    RAISE EXCEPTION
      'comment reaction count repair requires exact post/comment/account ON DELETE CASCADE foreign keys';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.comment_likes AS reaction
    WHERE reaction.reaction_type NOT IN ('like', 'dislike')
  ) THEN
    RAISE EXCEPTION 'comment_likes contains an invalid reaction type';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.comment_likes'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_comment_likes_00_guard_canonical_mutation'
      AND trigger_row.tgfoid =
        'public.guard_canonical_comment_reaction_mutation()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.comment_likes'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_comment_likes_20_sync_counts'
      AND trigger_row.tgfoid =
        'public.sync_comment_reaction_counts()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.comments'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_comments_04_contract_reaction_counts'
      AND trigger_row.tgfoid =
        'public.guard_contract_comment_reaction_counts()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'canonical comment reaction trigger boundary drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_sync_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
      'public.sync_comment_reaction_counts()'::pg_catalog.regprocedure
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'trigger'::pg_catalog.regtype
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v';

  IF pg_catalog.strpos(v_sync_source, 'UPDATE public.comments') = 0
     OR pg_catalog.strpos(v_sync_source, 'like_count') = 0
     OR pg_catalog.strpos(v_sync_source, 'dislike_count') = 0
  THEN
    RAISE EXCEPTION 'canonical comment reaction count synchronizer drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_wrapper_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
      'public.toggle_comment_reaction(uuid,uuid,uuid,text)'::pg_catalog.regprocedure
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
    AND NOT function_row.proretset
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.pronargs = 4
    AND function_row.pronargdefaults = 1
    AND function_row.proargnames = ARRAY[
      'p_post_id',
      'p_comment_id',
      'p_user_id',
      'p_reaction_type'
    ]::text[];

  IF pg_catalog.strpos(
       v_wrapper_source,
       'public.lock_post_interaction_block_edges'
     ) = 0
     OR pg_catalog.strpos(
       v_wrapper_source,
       'public.toggle_comment_reaction_locked_impl'
     ) <= pg_catalog.strpos(
       v_wrapper_source,
       'public.lock_post_interaction_block_edges'
     )
  THEN
    RAISE EXCEPTION 'legacy comment reaction wrapper chain drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_internal_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
      'public.toggle_comment_reaction_locked_impl(uuid,uuid,uuid,text)'::pg_catalog.regprocedure
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
    AND NOT function_row.proretset
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND pg_catalog.obj_description(function_row.oid, 'pg_proc') =
      'atomic-comment-block-authorization:v1:'
        || pg_catalog.md5(function_row.prosrc);

  IF pg_catalog.strpos(v_internal_source, 'FROM public.posts') = 0
     OR pg_catalog.strpos(v_internal_source, 'FROM public.comments') = 0
     OR pg_catalog.strpos(v_internal_source, 'FROM public.comment_likes') = 0
     OR pg_catalog.strpos(v_internal_source, 'app.comment_reaction_path') = 0
     OR pg_catalog.strpos(v_internal_source, 'toggle_comment_reaction') = 0
  THEN
    RAISE EXCEPTION 'sealed legacy comment reaction implementation drifted';
  END IF;

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
      AND acl_entry.grantee <> function_row.proowner
  ) THEN
    RAISE EXCEPTION 'sealed legacy comment reaction implementation ACL drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_guard_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
      'public.guard_contract_comment_reaction_counts()'::pg_catalog.regprocedure
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'trigger'::pg_catalog.regtype
    AND function_row.proowner = v_postgres_oid;

  IF pg_catalog.strpos(
       v_guard_source,
       'direct comment reaction counter updates are disabled'
     ) = 0
  THEN
    RAISE EXCEPTION 'comment reaction count write guard drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'authenticator', 'service_role']::text[]
    ) AS role_name
    CROSS JOIN pg_catalog.unnest(
      ARRAY[
        'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ]::text[]
    ) AS privilege_name
    WHERE pg_catalog.has_table_privilege(
      role_name,
      'public.comment_likes',
      privilege_name
    )
  ) THEN
    RAISE EXCEPTION 'comment_likes direct mutation boundary drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'enqueue_comment_reaction_count_repair',
        'repair_comment_reaction_counts_atomic'
      )
      AND function_row.oid NOT IN (
        COALESCE(
          pg_catalog.to_regprocedure(
            'public.enqueue_comment_reaction_count_repair()'
          )::oid,
          0::oid
        ),
        COALESCE(
          pg_catalog.to_regprocedure(
            'public.repair_comment_reaction_counts_atomic(integer)'
          )::oid,
          0::oid
        )
      )
  ) THEN
    RAISE EXCEPTION 'incompatible comment reaction count repair overload exists';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.comment_reaction_count_repair_queue (
  -- Deliberately no FK. Comment/post deletion can retain a stale identity until
  -- the worker observes committed absence and discards the obligation.
  comment_id uuid PRIMARY KEY,
  enqueued_at timestamptz NOT NULL
    DEFAULT pg_catalog.statement_timestamp(),
  next_attempt_at timestamptz NOT NULL
    DEFAULT pg_catalog.statement_timestamp(),
  attempt_count integer NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0 AND attempt_count <= 1000000)
);

ALTER TABLE public.comment_reaction_count_repair_queue OWNER TO postgres;
LOCK TABLE public.comment_reaction_count_repair_queue IN ACCESS EXCLUSIVE MODE;

CREATE INDEX IF NOT EXISTS idx_comment_reaction_count_repair_queue_oldest
  ON public.comment_reaction_count_repair_queue (
    next_attempt_at,
    enqueued_at,
    comment_id
  );

ALTER TABLE public.comment_reaction_count_repair_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comment_reaction_count_repair_queue FORCE ROW LEVEL SECURITY;

-- This trigger is intentionally queue-only. In particular it must not read or
-- lock auth.users/posts/comments and must not acquire an advisory lock.
CREATE OR REPLACE FUNCTION public.enqueue_comment_reaction_count_repair()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_comment_id uuid;
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
     OR TG_TABLE_NAME IS DISTINCT FROM 'comment_likes'
     OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'comment reaction count repair trigger is attached incorrectly';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.comment_id IS DISTINCT FROM NEW.comment_id
  THEN
    INSERT INTO public.comment_reaction_count_repair_queue (comment_id)
    VALUES (OLD.comment_id)
    ON CONFLICT (comment_id) DO NOTHING;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_comment_id := OLD.comment_id;
  ELSE
    v_comment_id := NEW.comment_id;
  END IF;

  INSERT INTO public.comment_reaction_count_repair_queue (comment_id)
  VALUES (v_comment_id)
  ON CONFLICT (comment_id) DO NOTHING;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

-- Preserve synchronous legacy toggle ACKs, but never take comments from a
-- cascade/direct child path. Those paths leave Q for the ordered worker.
CREATE OR REPLACE FUNCTION public.sync_comment_reaction_counts()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_comment_id uuid;
  v_like_delta integer := 0;
  v_dislike_delta integer := 0;
BEGIN
  IF pg_catalog.current_setting('app.comment_reaction_path', true)
       IS DISTINCT FROM 'toggle_comment_reaction'
  THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

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
       AND v_comment_id IS DISTINCT FROM NEW.comment_id
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'comment reaction identity is immutable';
    END IF;

    v_comment_id := NEW.comment_id;
    IF NEW.reaction_type = 'like' THEN
      v_like_delta := v_like_delta + 1;
    ELSIF NEW.reaction_type = 'dislike' THEN
      v_dislike_delta := v_dislike_delta + 1;
    END IF;
  END IF;

  IF v_like_delta <> 0 OR v_dislike_delta <> 0 THEN
    UPDATE public.comments AS target
    SET like_count = GREATEST(
          COALESCE(target.like_count, 0) + v_like_delta,
          0
        ),
        dislike_count = GREATEST(
          COALESCE(target.dislike_count, 0) + v_dislike_delta,
          0
        )
    WHERE target.id = v_comment_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

-- The repair worker performs one marked top-level absolute counter UPDATE.
-- All unmarked top-level cache writes remain contract violations.
CREATE OR REPLACE FUNCTION public.guard_contract_comment_reaction_counts()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.like_count IS DISTINCT FROM 0
       OR NEW.dislike_count IS DISTINCT FROM 0
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'new comments must start with zero reaction counters';
    END IF;
    RETURN NEW;
  END IF;

  IF pg_catalog.pg_trigger_depth() = 1
     AND pg_catalog.current_setting(
       'app.comment_reaction_repair_path',
       true
     ) IS DISTINCT FROM 'repair_comment_reaction_counts_atomic'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'direct comment reaction counter updates are disabled';
  END IF;

  RETURN NEW;
END
$function$;

-- Keep the legacy signature and exact locked implementation. The account row
-- now precedes block-edge/post/group/comment/source locks, matching account
-- hard deletion and eliminating the rolling-deploy auth-FK inversion.
CREATE OR REPLACE FUNCTION public.toggle_comment_reaction(
  p_post_id uuid,
  p_comment_id uuid,
  p_user_id uuid,
  p_reaction_type text DEFAULT 'like'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  -- Preserve the locked implementation's validation codes when an identity is
  -- malformed. Only complete identities enter the account/block lock chain.
  IF p_post_id IS NOT NULL
     AND p_comment_id IS NOT NULL
     AND p_user_id IS NOT NULL
  THEN
    PERFORM 1
    FROM auth.users AS actor_account
    WHERE actor_account.id = p_user_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'comment reaction actor account not found';
    END IF;

    IF NOT public.lock_post_interaction_block_edges(
      p_post_id,
      p_user_id,
      p_comment_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0002',
        MESSAGE = 'active comment not found for post';
    END IF;
  END IF;

  RETURN public.toggle_comment_reaction_locked_impl(
    p_post_id,
    p_comment_id,
    p_user_id,
    p_reaction_type
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.repair_comment_reaction_counts_atomic(
  p_limit integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_candidates uuid[];
  v_comment_id uuid;
  v_candidate_post_id uuid;
  v_locked_post_id uuid;
  v_locked_comment_id uuid;
  v_claimed_comment_id uuid;
  v_post_still_exists boolean;
  v_comment_still_exists boolean;
  v_like_count bigint;
  v_dislike_count bigint;
  v_returned_like_count integer;
  v_returned_dislike_count integer;
  v_previous_repair_path text;
  v_selected_count integer := 0;
  v_processed_count integer := 0;
  v_repaired_count integer := 0;
  v_discarded_count integer := 0;
  v_contended_count integer := 0;
  v_updated_count integer := 0;
  v_deferred_count integer := 0;
  v_remaining_count bigint;
  v_oldest_enqueued_at timestamptz;
  v_has_more boolean;
BEGIN
  IF COALESCE((SELECT auth.role()), '')
       IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  -- One comment per transaction bounds every post/comment/queue lock lifetime.
  IF p_limit IS DISTINCT FROM 1 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  -- Candidate discovery is deliberately unlocked. Q cannot be owned before
  -- the posts/comments parent locks without reversing live/cascade order.
  SELECT pg_catalog.array_agg(
           candidate.comment_id
           ORDER BY candidate.enqueued_at, candidate.comment_id
         )
  INTO v_candidates
  FROM (
    SELECT repair_queue.comment_id, repair_queue.enqueued_at
    FROM public.comment_reaction_count_repair_queue AS repair_queue
    WHERE repair_queue.next_attempt_at <= pg_catalog.statement_timestamp()
    ORDER BY repair_queue.next_attempt_at,
             repair_queue.enqueued_at,
             repair_queue.comment_id
    LIMIT 1
  ) AS candidate;

  v_selected_count := COALESCE(
    pg_catalog.cardinality(v_candidates),
    0
  );

  FOREACH v_comment_id IN ARRAY COALESCE(
    v_candidates,
    ARRAY[]::uuid[]
  )
  LOOP
    EXIT WHEN v_processed_count >= p_limit;

    -- Resolve immutable identity without a row lock. It is revalidated after
    -- the post lock, before Q is touched.
    SELECT candidate_comment.post_id
    INTO v_candidate_post_id
    FROM public.comments AS candidate_comment
    WHERE candidate_comment.id = v_comment_id;

    IF NOT FOUND THEN
      SELECT repair_queue.comment_id
      INTO v_claimed_comment_id
      FROM public.comment_reaction_count_repair_queue AS repair_queue
      WHERE repair_queue.comment_id = v_comment_id
      FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN
        v_contended_count := v_contended_count + 1;
        CONTINUE;
      END IF;

      -- Recheck after Q ownership. A concurrent source insert that waits on Q
      -- will recreate the obligation after this transaction commits.
      SELECT EXISTS (
        SELECT 1
        FROM public.comments AS visible_comment
        WHERE visible_comment.id = v_comment_id
      )
      INTO v_comment_still_exists;
      IF v_comment_still_exists THEN
        v_contended_count := v_contended_count + 1;
        CONTINUE;
      END IF;

      DELETE FROM public.comment_reaction_count_repair_queue AS repair_queue
      WHERE repair_queue.comment_id = v_claimed_comment_id;
      v_processed_count := v_processed_count + 1;
      v_discarded_count := v_discarded_count + 1;
      CONTINUE;
    END IF;

    SELECT locked_post.id
    INTO v_locked_post_id
    FROM public.posts AS locked_post
    WHERE locked_post.id = v_candidate_post_id
    FOR SHARE SKIP LOCKED;
    IF NOT FOUND THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.posts AS visible_post
        WHERE visible_post.id = v_candidate_post_id
      )
      INTO v_post_still_exists;

      IF NOT v_post_still_exists THEN
        SELECT EXISTS (
          SELECT 1
          FROM public.comments AS visible_comment
          WHERE visible_comment.id = v_comment_id
        )
        INTO v_comment_still_exists;
        IF v_comment_still_exists THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'comment reaction repair found an orphaned comment';
        END IF;
      END IF;

      WITH retryable AS (
        SELECT repair_queue.comment_id
        FROM public.comment_reaction_count_repair_queue AS repair_queue
        WHERE repair_queue.comment_id = v_comment_id
        FOR UPDATE SKIP LOCKED
      )
      UPDATE public.comment_reaction_count_repair_queue AS repair_queue
      SET attempt_count = LEAST(
            repair_queue.attempt_count + 1,
            1000000
          ),
          next_attempt_at = pg_catalog.statement_timestamp()
            + pg_catalog.make_interval(
              secs => LEAST(
                (repair_queue.attempt_count + 1) * 5,
                300
              )
            )
      FROM retryable
      WHERE repair_queue.comment_id = retryable.comment_id;
      GET DIAGNOSTICS v_deferred_count = ROW_COUNT;
      v_contended_count := v_contended_count + 1;
      CONTINUE;
    END IF;

    SELECT locked_comment.id
    INTO v_locked_comment_id
    FROM public.comments AS locked_comment
    WHERE locked_comment.id = v_comment_id
      AND locked_comment.post_id = v_locked_post_id
    FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.comments AS visible_comment
        WHERE visible_comment.id = v_comment_id
          AND visible_comment.post_id = v_locked_post_id
      )
      INTO v_comment_still_exists;

      IF NOT v_comment_still_exists THEN
        SELECT repair_queue.comment_id
        INTO v_claimed_comment_id
        FROM public.comment_reaction_count_repair_queue AS repair_queue
        WHERE repair_queue.comment_id = v_comment_id
        FOR UPDATE SKIP LOCKED;
        IF NOT FOUND THEN
          v_contended_count := v_contended_count + 1;
          CONTINUE;
        END IF;

        DELETE FROM public.comment_reaction_count_repair_queue AS repair_queue
        WHERE repair_queue.comment_id = v_claimed_comment_id;
        v_processed_count := v_processed_count + 1;
        v_discarded_count := v_discarded_count + 1;
        CONTINUE;
      END IF;

      WITH retryable AS (
        SELECT repair_queue.comment_id
        FROM public.comment_reaction_count_repair_queue AS repair_queue
        WHERE repair_queue.comment_id = v_comment_id
        FOR UPDATE SKIP LOCKED
      )
      UPDATE public.comment_reaction_count_repair_queue AS repair_queue
      SET attempt_count = LEAST(
            repair_queue.attempt_count + 1,
            1000000
          ),
          next_attempt_at = pg_catalog.statement_timestamp()
            + pg_catalog.make_interval(
              secs => LEAST(
                (repair_queue.attempt_count + 1) * 5,
                300
              )
            )
      FROM retryable
      WHERE repair_queue.comment_id = retryable.comment_id;
      GET DIAGNOSTICS v_deferred_count = ROW_COUNT;
      v_contended_count := v_contended_count + 1;
      CONTINUE;
    END IF;

    SELECT claimed_queue.comment_id
    INTO v_claimed_comment_id
    FROM public.comment_reaction_count_repair_queue AS claimed_queue
    WHERE claimed_queue.comment_id = v_comment_id
    FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      v_contended_count := v_contended_count + 1;
      CONTINUE;
    END IF;

    DELETE FROM public.comment_reaction_count_repair_queue AS claimed_queue
    WHERE claimed_queue.comment_id = v_claimed_comment_id;

    SELECT
      pg_catalog.count(*) FILTER (
        WHERE reaction.reaction_type = 'like'
      ),
      pg_catalog.count(*) FILTER (
        WHERE reaction.reaction_type = 'dislike'
      )
    INTO v_like_count, v_dislike_count
    FROM public.comment_likes AS reaction
    WHERE reaction.comment_id = v_comment_id;

    IF v_like_count > 2147483647 OR v_dislike_count > 2147483647 THEN
      RAISE EXCEPTION USING
        ERRCODE = '22003',
        MESSAGE = 'comment reaction counter exceeds integer range';
    END IF;

    v_previous_repair_path := pg_catalog.current_setting(
      'app.comment_reaction_repair_path',
      true
    );
    PERFORM pg_catalog.set_config(
      'app.comment_reaction_repair_path',
      'repair_comment_reaction_counts_atomic',
      true
    );

    UPDATE public.comments AS target
    SET like_count = v_like_count::integer,
        dislike_count = v_dislike_count::integer
    WHERE target.id = v_locked_comment_id
    RETURNING target.like_count, target.dislike_count
    INTO v_returned_like_count, v_returned_dislike_count;

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    IF v_updated_count IS DISTINCT FROM 1
       OR v_returned_like_count IS DISTINCT FROM v_like_count::integer
       OR v_returned_dislike_count IS DISTINCT FROM v_dislike_count::integer
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'locked comment disappeared during reaction count repair';
    END IF;

    PERFORM pg_catalog.set_config(
      'app.comment_reaction_repair_path',
      COALESCE(v_previous_repair_path, ''),
      true
    );

    v_processed_count := v_processed_count + 1;
    v_repaired_count := v_repaired_count + 1;
  END LOOP;

  SELECT pg_catalog.count(*),
         pg_catalog.min(repair_queue.enqueued_at),
         COALESCE(
           pg_catalog.bool_or(
             repair_queue.next_attempt_at <= pg_catalog.statement_timestamp()
           ),
           false
         )
  INTO v_remaining_count, v_oldest_enqueued_at, v_has_more
  FROM public.comment_reaction_count_repair_queue AS repair_queue;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'processed',
    'selected_count', v_selected_count,
    'processed_count', v_processed_count,
    'repaired_count', v_repaired_count,
    'discarded_count', v_discarded_count,
    'contended_count', v_contended_count,
    'has_more', v_has_more,
    'remaining_count', v_remaining_count,
    'oldest_enqueued_at', v_oldest_enqueued_at
  );
END
$function$;

ALTER FUNCTION public.enqueue_comment_reaction_count_repair()
  OWNER TO postgres;
ALTER FUNCTION public.sync_comment_reaction_counts()
  OWNER TO postgres;
ALTER FUNCTION public.guard_contract_comment_reaction_counts()
  OWNER TO postgres;
ALTER FUNCTION public.toggle_comment_reaction(uuid, uuid, uuid, text)
  OWNER TO postgres;
ALTER FUNCTION public.repair_comment_reaction_counts_atomic(integer)
  OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_comment_likes_20_sync_counts
  ON public.comment_likes;
CREATE TRIGGER trg_comment_likes_20_sync_counts
AFTER INSERT OR DELETE OR UPDATE OF comment_id, user_id, reaction_type
ON public.comment_likes
FOR EACH ROW
EXECUTE FUNCTION public.sync_comment_reaction_counts();

DROP TRIGGER IF EXISTS trg_comment_likes_90_enqueue_count_repair
  ON public.comment_likes;
CREATE TRIGGER trg_comment_likes_90_enqueue_count_repair
AFTER INSERT OR DELETE OR UPDATE OF comment_id, reaction_type
ON public.comment_likes
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_comment_reaction_count_repair();

DROP TRIGGER IF EXISTS trg_comments_04_contract_reaction_counts
  ON public.comments;
CREATE TRIGGER trg_comments_04_contract_reaction_counts
BEFORE INSERT OR UPDATE OF like_count, dislike_count
ON public.comments
FOR EACH ROW
EXECUTE FUNCTION public.guard_contract_comment_reaction_counts();

REVOKE ALL ON TABLE public.comment_reaction_count_repair_queue
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

DO $revoke_queue_acl_drift$
DECLARE
  v_owner oid := pg_catalog.to_regrole('postgres');
  v_grantee record;
  v_grantee_sql text;
  v_column record;
BEGIN
  -- Table-level REVOKE does not clear independently granted column ACLs, so
  -- discover both kinds and converge every non-owner grantee (including
  -- historical roles unknown to this migration).
  FOR v_grantee IN
    SELECT DISTINCT grantee_set.grantee, role_row.rolname
    FROM (
      SELECT acl_entry.grantee
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      WHERE relation.oid =
        'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
      UNION
      SELECT acl_entry.grantee
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid =
        'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) AS grantee_set
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = grantee_set.grantee
    WHERE grantee_set.grantee <> v_owner
  LOOP
    v_grantee_sql := CASE
      WHEN v_grantee.grantee = 0 THEN 'PUBLIC'
      ELSE pg_catalog.quote_ident(v_grantee.rolname)
    END;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.comment_reaction_count_repair_queue FROM %s',
      v_grantee_sql
    );

    FOR v_column IN
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid =
        'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES (%I) ON TABLE public.comment_reaction_count_repair_queue FROM %s',
        v_column.attname,
        v_grantee_sql
      );
    END LOOP;
  END LOOP;
END
$revoke_queue_acl_drift$;

-- CREATE OR REPLACE preserves arbitrary historical function grants. Converge
-- all non-owner ACLs, then publish only the legacy route and repair worker.
DO $converge_function_acls$
DECLARE
  v_function regprocedure;
  v_owner oid;
  v_grantee record;
  v_grantee_sql text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.enqueue_comment_reaction_count_repair()'::regprocedure,
    'public.sync_comment_reaction_counts()'::regprocedure,
    'public.guard_contract_comment_reaction_counts()'::regprocedure,
    'public.toggle_comment_reaction(uuid,uuid,uuid,text)'::regprocedure,
    'public.repair_comment_reaction_counts_atomic(integer)'::regprocedure
  ]
  LOOP
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
      v_grantee_sql := CASE
        WHEN v_grantee.grantee = 0 THEN 'PUBLIC'
        ELSE pg_catalog.quote_ident(v_grantee.rolname)
      END;
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION %s FROM %s',
        v_function,
        v_grantee_sql
      );
    END LOOP;
  END LOOP;
END
$converge_function_acls$;

GRANT EXECUTE ON FUNCTION public.toggle_comment_reaction(
  uuid, uuid, uuid, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.repair_comment_reaction_counts_atomic(integer)
  TO service_role;

-- Row triggers cannot make TRUNCATE durable. Keep it break-glass postgres-only.
REVOKE TRUNCATE ON TABLE public.comment_likes
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

-- Retire historical arithmetic cache writers again in case an ACL drifted
-- after the canonical comment write contract was deployed.
DO $close_legacy_comment_counter_rpcs$
DECLARE
  v_function regprocedure;
  v_owner oid;
  v_grantee record;
  v_grantee_sql text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    pg_catalog.to_regprocedure('public.increment_comment_like_count(uuid)'),
    pg_catalog.to_regprocedure('public.decrement_comment_like_count(uuid)')
  ]
  LOOP
    CONTINUE WHEN v_function IS NULL;

    EXECUTE pg_catalog.format(
      'ALTER FUNCTION %s OWNER TO postgres',
      v_function
    );
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
      v_grantee_sql := CASE
        WHEN v_grantee.grantee = 0 THEN 'PUBLIC'
        ELSE pg_catalog.quote_ident(v_grantee.rolname)
      END;
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION %s FROM %s',
        v_function,
        v_grantee_sql
      );
    END LOOP;
  END LOOP;
END
$close_legacy_comment_counter_rpcs$;

COMMENT ON TABLE public.comment_reaction_count_repair_queue IS
  'Private durable obligations to restore comment reaction counters from canonical comment_likes rows.';

DO $attest_sources$
DECLARE
  v_function regprocedure;
  v_prefix text;
  v_source text;
BEGIN
  FOR v_function, v_prefix IN
    SELECT *
    FROM (
      VALUES
        (
          'public.enqueue_comment_reaction_count_repair()'::regprocedure,
          'comment-reaction-count-repair:enqueue-v1:'
        ),
        (
          'public.sync_comment_reaction_counts()'::regprocedure,
          'comment-reaction-count-repair:sync-v1:'
        ),
        (
          'public.guard_contract_comment_reaction_counts()'::regprocedure,
          'comment-reaction-count-repair:guard-v1:'
        ),
        (
          'public.toggle_comment_reaction(uuid,uuid,uuid,text)'::regprocedure,
          'comment-reaction-count-repair:legacy-wrapper-v1:'
        ),
        (
          'public.repair_comment_reaction_counts_atomic(integer)'::regprocedure,
          'comment-reaction-count-repair:worker-v1:'
        )
    ) AS expected(function_oid, comment_prefix)
  LOOP
    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function;

    EXECUTE pg_catalog.format(
      'COMMENT ON FUNCTION %s IS %L',
      v_function,
      v_prefix || pg_catalog.md5(v_source)
    );
  END LOOP;
END
$attest_sources$;

-- Enqueue only proven cache/source mismatches. A replay over canonical data is
-- a no-op; p_limit = 1 therefore drains real repair work instead of repeatedly
-- walking every historically reacted-to comment.
INSERT INTO public.comment_reaction_count_repair_queue (comment_id)
SELECT target.id
FROM public.comments AS target
LEFT JOIN (
  SELECT
    reaction.comment_id,
    pg_catalog.count(*) FILTER (
      WHERE reaction.reaction_type = 'like'
    ) AS like_count,
    pg_catalog.count(*) FILTER (
      WHERE reaction.reaction_type = 'dislike'
    ) AS dislike_count
  FROM public.comment_likes AS reaction
  GROUP BY reaction.comment_id
) AS source_counts
  ON source_counts.comment_id = target.id
WHERE target.like_count IS DISTINCT FROM COALESCE(source_counts.like_count, 0)
   OR target.dislike_count IS DISTINCT FROM COALESCE(
     source_counts.dislike_count,
     0
   )
ON CONFLICT (comment_id) DO NOTHING;

DO $postflight$
DECLARE
  v_postgres_oid oid := pg_catalog.to_regrole('postgres');
  v_service_oid oid := pg_catalog.to_regrole('service_role');
  v_plpgsql_oid oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_function regprocedure;
  v_source text;
  v_comment text;
  v_enqueue_source text;
  v_sync_source text;
  v_guard_source text;
  v_wrapper_source text;
  v_worker_source text;
  v_post_lock integer;
  v_comment_lock integer;
  v_queue_lock integer;
  v_queue_delete integer;
  v_count integer;
  v_comment_update integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid =
      'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND relation.relowner = v_postgres_oid
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
      AND NOT relation.relispartition
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid =
      'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
       OR inheritance.inhparent =
      'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
  ) OR (
    SELECT pg_catalog.array_agg(
      attribute.attname::text ORDER BY attribute.attnum
    )
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
      'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) IS DISTINCT FROM ARRAY[
    'comment_id',
    'enqueued_at',
    'next_attempt_at',
    'attempt_count'
  ]::text[] THEN
    RAISE EXCEPTION 'comment reaction count repair queue relation/column shape drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.convalidated
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum::smallint
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'comment_id'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )
      ]::smallint[]
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) =
        'CHECK (attempt_count >= 0 AND attempt_count <= 1000000)'
  ) THEN
    RAISE EXCEPTION 'comment reaction count repair queue PK/FK/backoff drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid =
      'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
      AND attribute.attname = 'enqueued_at'
      AND attribute.atttypid = 'timestamptz'::pg_catalog.regtype
      AND attribute.attnotnull
      AND pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) =
        'statement_timestamp()'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid =
      'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
      AND attribute.attname = 'next_attempt_at'
      AND attribute.atttypid = 'timestamptz'::pg_catalog.regtype
      AND attribute.attnotnull
      AND pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) =
        'statement_timestamp()'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid =
      'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
      AND attribute.attname = 'attempt_count'
      AND attribute.atttypid = 'integer'::pg_catalog.regtype
      AND attribute.attnotnull
      AND pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) = '0'
  ) THEN
    RAISE EXCEPTION 'comment reaction count repair queue defaults drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS index_relation
    JOIN pg_catalog.pg_index AS index_row
      ON index_row.indexrelid = index_relation.oid
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = index_relation.relam
    WHERE index_relation.relnamespace = 'public'::pg_catalog.regnamespace
      AND index_relation.relname =
        'idx_comment_reaction_count_repair_queue_oldest'
      AND index_relation.relkind = 'i'
      AND index_relation.relpersistence = 'p'
      AND index_relation.relowner = v_postgres_oid
      AND access_method.amname = 'btree'
      AND index_row.indrelid =
        'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indislive
      AND NOT index_row.indisunique
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 3
      AND index_row.indnatts = 3
      AND index_row.indoption = '0 0 0'::pg_catalog.int2vector
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname::text ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_row.indkey::smallint[])
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['next_attempt_at', 'enqueued_at', 'comment_id']::text[]
  ) THEN
    RAISE EXCEPTION 'comment reaction count repair queue index drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid =
      'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
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
      AND acl_entry.grantee <> relation.relowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = attribute.attrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid =
      'public.comment_reaction_count_repair_queue'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> relation.relowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'authenticator', 'service_role']::text[]
    ) AS role_name
    WHERE pg_catalog.has_any_column_privilege(
            role_name,
            'public.comment_reaction_count_repair_queue',
            'SELECT,INSERT,UPDATE,REFERENCES'
          )
       OR pg_catalog.has_table_privilege(
            role_name,
            'public.comment_reaction_count_repair_queue',
            'DELETE,TRUNCATE,TRIGGER'
          )
  ) THEN
    RAISE EXCEPTION 'comment reaction count repair queue ACL/RLS policy leaked';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.comments AS target
    LEFT JOIN (
      SELECT
        reaction.comment_id,
        pg_catalog.count(*) FILTER (
          WHERE reaction.reaction_type = 'like'
        ) AS like_count,
        pg_catalog.count(*) FILTER (
          WHERE reaction.reaction_type = 'dislike'
        ) AS dislike_count
      FROM public.comment_likes AS reaction
      GROUP BY reaction.comment_id
    ) AS source_counts
      ON source_counts.comment_id = target.id
    WHERE (
      target.like_count IS DISTINCT FROM COALESCE(source_counts.like_count, 0)
      OR target.dislike_count IS DISTINCT FROM COALESCE(
        source_counts.dislike_count,
        0
      )
    )
      AND NOT EXISTS (
        SELECT 1
        FROM public.comment_reaction_count_repair_queue AS repair_queue
        WHERE repair_queue.comment_id = target.id
      )
  ) THEN
    RAISE EXCEPTION
      'comment reaction cache mismatch is missing a durable repair obligation';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_enqueue_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
      'public.enqueue_comment_reaction_count_repair()'::pg_catalog.regprocedure
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'trigger'::pg_catalog.regtype
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prolang = v_plpgsql_oid
    AND NOT function_row.proisstrict
    AND function_row.proparallel = 'u'
    AND NOT function_row.proleakproof
    AND function_row.pronargs = 0
    AND function_row.pronargdefaults = 0
    AND pg_catalog.cardinality(function_row.proconfig) = 2
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off'
    ]::text[];

  IF v_comment IS DISTINCT FROM
       'comment-reaction-count-repair:enqueue-v1:'
         || pg_catalog.md5(v_enqueue_source)
     OR pg_catalog.strpos(v_enqueue_source, 'pg_advisory') <> 0
     OR pg_catalog.strpos(v_enqueue_source, 'auth.users') <> 0
     OR pg_catalog.strpos(v_enqueue_source, 'public.posts') <> 0
     OR pg_catalog.strpos(v_enqueue_source, 'public.comments') <> 0
     OR pg_catalog.strpos(v_enqueue_source, 'UPDATE public.comments') <> 0
     OR pg_catalog.strpos(
       v_enqueue_source,
       'INSERT INTO public.comment_reaction_count_repair_queue'
     ) = 0
  THEN
    RAISE EXCEPTION 'comment reaction count repair enqueue contract drifted';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_sync_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
      'public.sync_comment_reaction_counts()'::pg_catalog.regprocedure
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'trigger'::pg_catalog.regtype
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prolang = v_plpgsql_oid
    AND pg_catalog.cardinality(function_row.proconfig) = 2
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off'
    ]::text[];

  IF v_comment IS DISTINCT FROM
       'comment-reaction-count-repair:sync-v1:' || pg_catalog.md5(v_sync_source)
     OR pg_catalog.strpos(v_sync_source, 'app.comment_reaction_path') = 0
     OR pg_catalog.strpos(v_sync_source, 'toggle_comment_reaction') = 0
     OR pg_catalog.strpos(v_sync_source, 'UPDATE public.comments') <=
        pg_catalog.strpos(v_sync_source, 'app.comment_reaction_path')
  THEN
    RAISE EXCEPTION 'cascade-safe comment reaction synchronizer drifted';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_guard_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
      'public.guard_contract_comment_reaction_counts()'::pg_catalog.regprocedure
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'trigger'::pg_catalog.regtype
    AND function_row.proowner = v_postgres_oid
    AND NOT function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prolang = v_plpgsql_oid
    AND function_row.proconfig =
      ARRAY['search_path=pg_catalog, pg_temp']::text[];

  IF v_comment IS DISTINCT FROM
       'comment-reaction-count-repair:guard-v1:' || pg_catalog.md5(v_guard_source)
     OR pg_catalog.strpos(v_guard_source, 'app.comment_reaction_repair_path') = 0
     OR pg_catalog.strpos(
       v_guard_source,
       'repair_comment_reaction_counts_atomic'
     ) = 0
  THEN
    RAISE EXCEPTION 'comment reaction count repair guard drifted';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_wrapper_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
      'public.toggle_comment_reaction(uuid,uuid,uuid,text)'::pg_catalog.regprocedure
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
    AND NOT function_row.proretset
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prolang = v_plpgsql_oid
    AND function_row.pronargs = 4
    AND function_row.pronargdefaults = 1
    AND function_row.proargnames = ARRAY[
      'p_post_id',
      'p_comment_id',
      'p_user_id',
      'p_reaction_type'
    ]::text[]
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF v_comment IS DISTINCT FROM
       'comment-reaction-count-repair:legacy-wrapper-v1:'
         || pg_catalog.md5(v_wrapper_source)
     OR pg_catalog.strpos(v_wrapper_source, 'FROM auth.users AS actor_account') = 0
     OR pg_catalog.strpos(
       v_wrapper_source,
       'public.lock_post_interaction_block_edges'
     ) <= pg_catalog.strpos(v_wrapper_source, 'FROM auth.users AS actor_account')
     OR pg_catalog.strpos(
       v_wrapper_source,
       'public.toggle_comment_reaction_locked_impl'
     ) <= pg_catalog.strpos(
       v_wrapper_source,
       'public.lock_post_interaction_block_edges'
     )
  THEN
    RAISE EXCEPTION 'auth-first legacy comment reaction wrapper drifted';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_worker_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
      'public.repair_comment_reaction_counts_atomic(integer)'::pg_catalog.regprocedure
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
    AND function_row.pronargs = 1
    AND function_row.pronargdefaults = 1
    AND function_row.proargnames = ARRAY['p_limit']::text[]
    AND pg_catalog.cardinality(function_row.proconfig) = 4
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off',
      'lock_timeout=5s',
      'statement_timeout=30s'
    ]::text[];

  v_post_lock := pg_catalog.strpos(
    v_worker_source,
    'INTO v_locked_post_id'
  );
  v_comment_lock := pg_catalog.strpos(
    v_worker_source,
    'INTO v_locked_comment_id'
  );
  v_queue_lock := pg_catalog.strpos(
    v_worker_source,
    'FROM public.comment_reaction_count_repair_queue AS claimed_queue'
  );
  v_queue_delete := pg_catalog.strpos(
    v_worker_source,
    'DELETE FROM public.comment_reaction_count_repair_queue AS claimed_queue'
  );
  v_count := pg_catalog.strpos(
    v_worker_source,
    'pg_catalog.count(*) FILTER'
  );
  v_comment_update := pg_catalog.strpos(
    v_worker_source,
    'UPDATE public.comments AS target'
  );

  IF v_comment IS DISTINCT FROM
       'comment-reaction-count-repair:worker-v1:'
         || pg_catalog.md5(v_worker_source)
     OR v_post_lock = 0
     OR v_comment_lock <= v_post_lock
     OR v_queue_lock <= v_comment_lock
     OR v_queue_delete <= v_queue_lock
     OR v_count <= v_queue_delete
     OR v_comment_update <= v_count
     OR pg_catalog.strpos(v_worker_source, 'FOR SHARE SKIP LOCKED') = 0
     OR pg_catalog.strpos(v_worker_source, 'FOR UPDATE SKIP LOCKED') = 0
     OR pg_catalog.strpos(v_worker_source, 'p_limit IS DISTINCT FROM 1') = 0
     OR pg_catalog.strpos(v_worker_source, 'LIMIT 1') = 0
     OR pg_catalog.strpos(v_worker_source, 'service role required') = 0
     OR pg_catalog.strpos(v_worker_source, 'pg_advisory') <> 0
  THEN
    RAISE EXCEPTION 'comment reaction count repair worker lock order drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.comment_likes'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_comment_likes_20_sync_counts'
      AND trigger_row.tgfoid =
        'public.sync_comment_reaction_counts()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 29
      AND trigger_row.tgqual IS NULL
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname::text ORDER BY trigger_column.ordinality
        )
        FROM pg_catalog.unnest(trigger_row.tgattr::smallint[])
          WITH ORDINALITY AS trigger_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = trigger_row.tgrelid
         AND attribute.attnum = trigger_column.attnum
      ) = ARRAY['comment_id', 'user_id', 'reaction_type']::text[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.comment_likes'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_comment_likes_90_enqueue_count_repair'
      AND trigger_row.tgfoid =
        'public.enqueue_comment_reaction_count_repair()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 29
      AND trigger_row.tgqual IS NULL
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname::text ORDER BY trigger_column.ordinality
        )
        FROM pg_catalog.unnest(trigger_row.tgattr::smallint[])
          WITH ORDINALITY AS trigger_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = trigger_row.tgrelid
         AND attribute.attnum = trigger_column.attnum
      ) = ARRAY['comment_id', 'reaction_type']::text[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.comments'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_comments_04_contract_reaction_counts'
      AND trigger_row.tgfoid =
        'public.guard_contract_comment_reaction_counts()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 23
      AND trigger_row.tgqual IS NULL
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname::text ORDER BY trigger_column.ordinality
        )
        FROM pg_catalog.unnest(trigger_row.tgattr::smallint[])
          WITH ORDINALITY AS trigger_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = trigger_row.tgrelid
         AND attribute.attnum = trigger_column.attnum
      ) = ARRAY['like_count', 'dislike_count']::text[]
  ) THEN
    RAISE EXCEPTION 'comment reaction count repair trigger set drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.toggle_comment_reaction(uuid,uuid,uuid,text)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.repair_comment_reaction_counts_atomic(integer)',
       'EXECUTE'
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
       WHERE function_row.oid IN (
         'public.enqueue_comment_reaction_count_repair()'::regprocedure,
         'public.sync_comment_reaction_counts()'::regprocedure,
         'public.guard_contract_comment_reaction_counts()'::regprocedure,
         'public.toggle_comment_reaction(uuid,uuid,uuid,text)'::regprocedure,
         'public.repair_comment_reaction_counts_atomic(integer)'::regprocedure
       )
         AND acl_entry.privilege_type = 'EXECUTE'
         AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'public.enqueue_comment_reaction_count_repair()',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'public.sync_comment_reaction_counts()',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'public.guard_contract_comment_reaction_counts()',
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION 'comment reaction count repair function ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'authenticator', 'service_role']::text[]
    ) AS role_name
    WHERE pg_catalog.has_table_privilege(
      role_name,
      'public.comment_likes',
      'TRUNCATE'
    )
  ) THEN
    RAISE EXCEPTION 'comment reaction source TRUNCATE authority leaked';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
