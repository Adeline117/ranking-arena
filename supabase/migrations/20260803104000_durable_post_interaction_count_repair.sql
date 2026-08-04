-- Migration: 20260803104000_durable_post_interaction_count_repair.sql
-- Created: 2026-08-03T10:40:00Z
-- Description: Turn post reaction/vote counter drift into a durable repair
--   obligation. Child-table triggers enqueue without taking the post or auth
--   lock, so auth.users cascades cannot invert the live interaction lock order.
--   A service-only worker takes the canonical post-wide advisory lock before
--   claiming queue work and then restores every cached counter from source rows.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.post-interaction-count-repair:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'post interaction count repair migration lock is busy';
  END IF;
END
$migration_lock$;

-- Freeze the dependency graph in the same parent-to-child order used by auth
-- hard deletion. This closes the preflight/DDL gap without introducing the
-- runtime post-advisory -> auth-row order into the migration transaction.
LOCK TABLE auth.users,
  public.posts,
  public.post_likes,
  public.post_votes
IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_missing_roles text[];
  v_relation regclass;
  v_function regprocedure;
  v_source text;
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
    RAISE EXCEPTION
      'post interaction count repair roles are missing: %',
      v_missing_roles;
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL THEN
    RAISE EXCEPTION 'canonical auth.role() authority must deploy first';
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    'public.posts'::pg_catalog.regclass,
    'public.post_likes'::pg_catalog.regclass,
    'public.post_votes'::pg_catalog.regclass
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND relation.relowner = pg_catalog.to_regrole('postgres')
        AND NOT relation.relispartition
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid = v_relation
         OR inheritance.inhparent = v_relation
    ) THEN
      RAISE EXCEPTION
        'post interaction count repair requires a canonical permanent relation: %',
        v_relation;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('public.posts'::pg_catalog.regclass, 'id', 'uuid'::pg_catalog.regtype, true),
        ('public.posts'::pg_catalog.regclass, 'like_count', 'integer'::pg_catalog.regtype, false),
        ('public.posts'::pg_catalog.regclass, 'dislike_count', 'integer'::pg_catalog.regtype, false),
        ('public.posts'::pg_catalog.regclass, 'poll_bull', 'integer'::pg_catalog.regtype, false),
        ('public.posts'::pg_catalog.regclass, 'poll_bear', 'integer'::pg_catalog.regtype, false),
        ('public.posts'::pg_catalog.regclass, 'poll_wait', 'integer'::pg_catalog.regtype, false),
        ('public.post_likes'::pg_catalog.regclass, 'post_id', 'uuid'::pg_catalog.regtype, true),
        ('public.post_likes'::pg_catalog.regclass, 'reaction_type', 'text'::pg_catalog.regtype, true),
        ('public.post_votes'::pg_catalog.regclass, 'post_id', 'uuid'::pg_catalog.regtype, true),
        ('public.post_votes'::pg_catalog.regclass, 'choice', 'text'::pg_catalog.regtype, true)
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
    RAISE EXCEPTION 'post interaction count repair source column shape drifted';
  END IF;

  FOREACH v_function IN ARRAY ARRAY[
    'public.toggle_post_reaction(uuid,uuid,text)'::pg_catalog.regprocedure,
    'public.set_post_reaction_desired_state_atomic(uuid,uuid,text)'::pg_catalog.regprocedure,
    'public.toggle_post_vote_atomic(uuid,uuid,text)'::pg_catalog.regprocedure,
    'public.set_post_vote_desired_state_atomic(uuid,uuid,text)'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.prokind = 'f'
      AND function_row.proowner = pg_catalog.to_regrole('postgres')
      AND function_row.prosecdef;

    IF pg_catalog.strpos(v_source, '''post-reaction-counts:''') = 0
       OR pg_catalog.strpos(v_source, 'UPDATE public.posts') = 0
    THEN
      RAISE EXCEPTION
        'post interaction authority does not share the canonical repair lock: %',
        v_function;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'enqueue_post_interaction_count_repair',
        'repair_post_interaction_counts_atomic'
      )
      AND function_row.oid NOT IN (
        COALESCE(
          pg_catalog.to_regprocedure(
            'public.enqueue_post_interaction_count_repair()'
          )::oid,
          0::oid
        ),
        COALESCE(
          pg_catalog.to_regprocedure(
            'public.repair_post_interaction_counts_atomic(integer)'
          )::oid,
          0::oid
        )
      )
  ) THEN
    RAISE EXCEPTION 'incompatible post interaction count repair overload exists';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.post_interaction_count_repair_queue (
  -- Deliberately no FK. A posts delete can cascade through both source tables;
  -- the queue must be able to retain and later discard that stale identity
  -- without depending on FK trigger order inside the parent delete.
  post_id uuid PRIMARY KEY,
  enqueued_at timestamptz NOT NULL
    DEFAULT pg_catalog.statement_timestamp(),
  next_attempt_at timestamptz NOT NULL
    DEFAULT pg_catalog.statement_timestamp(),
  attempt_count integer NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0 AND attempt_count <= 1000000)
);

LOCK TABLE public.post_interaction_count_repair_queue
IN ACCESS EXCLUSIVE MODE;

CREATE INDEX IF NOT EXISTS idx_post_interaction_count_repair_queue_oldest
  ON public.post_interaction_count_repair_queue (
    next_attempt_at,
    enqueued_at,
    post_id
  );

ALTER TABLE public.post_interaction_count_repair_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_interaction_count_repair_queue FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.enqueue_post_interaction_count_repair()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_post_id uuid;
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
     OR TG_TABLE_NAME NOT IN ('post_likes', 'post_votes')
     OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'post interaction count repair trigger is attached incorrectly';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.post_id IS DISTINCT FROM NEW.post_id
  THEN
    INSERT INTO public.post_interaction_count_repair_queue (post_id)
    VALUES (OLD.post_id)
    ON CONFLICT (post_id) DO NOTHING;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_post_id := OLD.post_id;
  ELSE
    v_post_id := NEW.post_id;
  END IF;

  INSERT INTO public.post_interaction_count_repair_queue (post_id)
  VALUES (v_post_id)
  ON CONFLICT (post_id) DO NOTHING;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.repair_post_interaction_counts_atomic(
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
  v_post_id uuid;
  v_locked_post_id uuid;
  v_claimed_post_id uuid;
  v_post_still_exists boolean;
  v_like_count bigint;
  v_dislike_count bigint;
  v_bull_count bigint;
  v_bear_count bigint;
  v_wait_count bigint;
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
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;
  -- Exactly one post per transaction keeps every advisory/row lock lifetime
  -- short. The application may loop bounded RPC calls, each with an independent
  -- commit, but no database caller can create a 500-post lock convoy.
  IF p_limit IS DISTINCT FROM 1 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  -- Read candidates without a queue lock. The canonical post advisory lock
  -- must always precede queue-row ownership, otherwise a live RPC
  -- (post lock -> child trigger -> queue UPSERT) could form Q -> P / P -> Q.
  SELECT pg_catalog.array_agg(candidate.post_id ORDER BY candidate.enqueued_at, candidate.post_id)
  INTO v_candidates
  FROM (
    SELECT repair_queue.post_id, repair_queue.enqueued_at
    FROM public.post_interaction_count_repair_queue AS repair_queue
    WHERE repair_queue.next_attempt_at <= pg_catalog.statement_timestamp()
    ORDER BY repair_queue.next_attempt_at,
             repair_queue.enqueued_at,
             repair_queue.post_id
    LIMIT 1
  ) AS candidate;

  v_selected_count := COALESCE(pg_catalog.cardinality(v_candidates), 0);

  FOREACH v_post_id IN ARRAY COALESCE(v_candidates, ARRAY[]::uuid[])
  LOOP
    EXIT WHEN v_processed_count >= p_limit;

    IF NOT pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'post-reaction-counts:' || v_post_id::text,
        0
      )
    ) THEN
      -- No P lock is held. Move this hot identity behind other due work before
      -- returning, so a permanently busy oldest post cannot starve row 501.
      WITH retryable AS (
        SELECT repair_queue.post_id
        FROM public.post_interaction_count_repair_queue AS repair_queue
        WHERE repair_queue.post_id = v_post_id
        FOR UPDATE SKIP LOCKED
      )
      UPDATE public.post_interaction_count_repair_queue AS repair_queue
      SET attempt_count = LEAST(repair_queue.attempt_count + 1, 1000000),
          next_attempt_at = pg_catalog.statement_timestamp()
            + pg_catalog.make_interval(
              secs => LEAST((repair_queue.attempt_count + 1) * 5, 300)
            )
      FROM retryable
      WHERE repair_queue.post_id = retryable.post_id;
      GET DIAGNOSTICS v_deferred_count = ROW_COUNT;
      v_contended_count := v_contended_count + 1;
      CONTINUE;
    END IF;

    -- Lock the parent row before Q. A concurrent post hard-delete follows the
    -- same posts -> child cascade -> Q order; taking Q first would let the two
    -- transactions deadlock. A live interaction cannot be here concurrently
    -- because it already participates in the shared advisory domain above.
    SELECT locked_post.id
    INTO v_locked_post_id
    FROM public.posts AS locked_post
    WHERE locked_post.id = v_post_id
    FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      -- A regular MVCC read still sees a row hidden only by SKIP LOCKED. Leave
      -- Q untouched in that case. If the post is committed-absent, claim Q in
      -- P -> posts(absent) -> Q order and discard the stale obligation.
      SELECT EXISTS (
        SELECT 1
        FROM public.posts AS visible_post
        WHERE visible_post.id = v_post_id
      )
      INTO v_post_still_exists;
      IF v_post_still_exists THEN
        WITH retryable AS (
          SELECT repair_queue.post_id
          FROM public.post_interaction_count_repair_queue AS repair_queue
          WHERE repair_queue.post_id = v_post_id
          FOR UPDATE SKIP LOCKED
        )
        UPDATE public.post_interaction_count_repair_queue AS repair_queue
        SET attempt_count = LEAST(repair_queue.attempt_count + 1, 1000000),
            next_attempt_at = pg_catalog.statement_timestamp()
              + pg_catalog.make_interval(
                secs => LEAST((repair_queue.attempt_count + 1) * 5, 300)
              )
        FROM retryable
        WHERE repair_queue.post_id = retryable.post_id;
        GET DIAGNOSTICS v_deferred_count = ROW_COUNT;
        v_contended_count := v_contended_count + 1;
        CONTINUE;
      END IF;

      SELECT repair_queue.post_id
      INTO v_claimed_post_id
      FROM public.post_interaction_count_repair_queue AS repair_queue
      WHERE repair_queue.post_id = v_post_id
      FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN
        v_contended_count := v_contended_count + 1;
        CONTINUE;
      END IF;

      DELETE FROM public.post_interaction_count_repair_queue AS repair_queue
      WHERE repair_queue.post_id = v_claimed_post_id;
      v_processed_count := v_processed_count + 1;
      v_discarded_count := v_discarded_count + 1;
      CONTINUE;
    END IF;

    -- A direct child mutation may currently own Q after taking the FK parent
    -- lock. SKIP LOCKED leaves its obligation intact for a later pass.
    SELECT repair_queue.post_id
    INTO v_claimed_post_id
    FROM public.post_interaction_count_repair_queue AS repair_queue
    WHERE repair_queue.post_id = v_post_id
    FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      v_contended_count := v_contended_count + 1;
      CONTINUE;
    END IF;

    DELETE FROM public.post_interaction_count_repair_queue AS repair_queue
    WHERE repair_queue.post_id = v_claimed_post_id;

    SELECT
      pg_catalog.count(*) FILTER (
        WHERE reaction.reaction_type = 'up'
      ),
      pg_catalog.count(*) FILTER (
        WHERE reaction.reaction_type = 'down'
      )
    INTO v_like_count, v_dislike_count
    FROM public.post_likes AS reaction
    WHERE reaction.post_id = v_post_id;

    SELECT
      pg_catalog.count(*) FILTER (
        WHERE vote.choice = 'bull'
      ),
      pg_catalog.count(*) FILTER (
        WHERE vote.choice = 'bear'
      ),
      pg_catalog.count(*) FILTER (
        WHERE vote.choice = 'wait'
      )
    INTO v_bull_count, v_bear_count, v_wait_count
    FROM public.post_votes AS vote
    WHERE vote.post_id = v_post_id;

    IF v_like_count > 2147483647
       OR v_dislike_count > 2147483647
       OR v_bull_count > 2147483647
       OR v_bear_count > 2147483647
       OR v_wait_count > 2147483647
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22003',
        MESSAGE = 'post interaction counter exceeds integer range';
    END IF;

    UPDATE public.posts AS target
    SET like_count = v_like_count::integer,
        dislike_count = v_dislike_count::integer,
        poll_bull = v_bull_count::integer,
        poll_bear = v_bear_count::integer,
        poll_wait = v_wait_count::integer
    WHERE target.id = v_locked_post_id;

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    IF v_updated_count IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'locked post disappeared during interaction count repair';
    END IF;
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
  FROM public.post_interaction_count_repair_queue AS repair_queue;

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

ALTER FUNCTION public.enqueue_post_interaction_count_repair()
  OWNER TO postgres;
ALTER FUNCTION public.repair_post_interaction_counts_atomic(integer)
  OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_post_likes_90_enqueue_count_repair
  ON public.post_likes;
CREATE TRIGGER trg_post_likes_90_enqueue_count_repair
AFTER INSERT OR DELETE OR UPDATE OF post_id, reaction_type
ON public.post_likes
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_post_interaction_count_repair();

DROP TRIGGER IF EXISTS trg_post_votes_90_enqueue_count_repair
  ON public.post_votes;
CREATE TRIGGER trg_post_votes_90_enqueue_count_repair
AFTER INSERT OR DELETE OR UPDATE OF post_id, choice
ON public.post_votes
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_post_interaction_count_repair();

REVOKE ALL ON TABLE public.post_interaction_count_repair_queue
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
DO $revoke_queue_column_acl_drift$
DECLARE
  v_role text;
  v_grantee text;
  v_column record;
BEGIN
  FOREACH v_role IN ARRAY ARRAY[
    'PUBLIC',
    'anon',
    'authenticated',
    'authenticator',
    'service_role'
  ]::text[]
  LOOP
    v_grantee := CASE
      WHEN v_role = 'PUBLIC' THEN 'PUBLIC'
      ELSE pg_catalog.quote_ident(v_role)
    END;

    FOR v_column IN
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid =
        'public.post_interaction_count_repair_queue'::pg_catalog.regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY attribute.attnum
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%I), INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.post_interaction_count_repair_queue FROM %s',
        v_column.attname,
        v_column.attname,
        v_column.attname,
        v_column.attname,
        v_grantee
      );
    END LOOP;
  END LOOP;
END
$revoke_queue_column_acl_drift$;
REVOKE ALL ON FUNCTION public.enqueue_post_interaction_count_repair()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.repair_post_interaction_counts_atomic(integer)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
-- Retire the migration-00021 arithmetic escape hatches. They mutate the cache
-- without changing source rows, so no child trigger could make that write
-- recoverable. Keep the signatures only for schema-cache compatibility and
-- remove every non-owner caller, including maintenance service_role.
DO $close_legacy_like_counter_rpcs$
DECLARE
  v_function regprocedure;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    pg_catalog.to_regprocedure('public.increment_like_count(uuid)'),
    pg_catalog.to_regprocedure('public.decrement_like_count(uuid)')
  ]
  LOOP
    IF v_function IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, authenticator, service_role',
        v_function
      );
    END IF;
  END LOOP;
END
$close_legacy_like_counter_rpcs$;
-- Row triggers cannot make TRUNCATE durable. First-party maintenance retains
-- bounded row DML but must use an explicit postgres break-glass session (plus
-- a full repair backfill) for any destructive bulk reset.
REVOKE TRUNCATE ON TABLE public.post_likes, public.post_votes
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.repair_post_interaction_counts_atomic(integer)
  TO service_role;

COMMENT ON TABLE public.post_interaction_count_repair_queue IS
  'Private durable obligations to restore posts reaction/vote counters from canonical child rows.';
COMMENT ON FUNCTION public.enqueue_post_interaction_count_repair() IS
  'Trigger-only enqueue path that deliberately takes no post or auth locks.';
COMMENT ON FUNCTION public.repair_post_interaction_counts_atomic(integer) IS
  'Service-only bounded repair worker; canonical post advisory lock always precedes queue ownership.';

-- Cover drift that predates this queue without scanning and rewriting every
-- post. A nonzero cached counter or any source row is enough to identify every
-- post whose five absolute values could differ from source truth.
INSERT INTO public.post_interaction_count_repair_queue (post_id)
SELECT candidate.post_id
FROM (
  SELECT target.id AS post_id
  FROM public.posts AS target
  WHERE COALESCE(target.like_count, 0) <> 0
     OR COALESCE(target.dislike_count, 0) <> 0
     OR COALESCE(target.poll_bull, 0) <> 0
     OR COALESCE(target.poll_bear, 0) <> 0
     OR COALESCE(target.poll_wait, 0) <> 0
  UNION
  SELECT reaction.post_id
  FROM public.post_likes AS reaction
  UNION
  SELECT vote.post_id
  FROM public.post_votes AS vote
) AS candidate
ON CONFLICT (post_id) DO NOTHING;

DO $postflight$
DECLARE
  v_postgres_oid oid := pg_catalog.to_regrole('postgres');
  v_service_oid oid := pg_catalog.to_regrole('service_role');
  v_plpgsql_oid oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_enqueue_function regprocedure :=
    'public.enqueue_post_interaction_count_repair()'::pg_catalog.regprocedure;
  v_repair_function regprocedure :=
    'public.repair_post_interaction_counts_atomic(integer)'::pg_catalog.regprocedure;
  v_enqueue_source text;
  v_repair_source text;
  v_post_lock_position integer;
  v_post_row_lock_position integer;
  v_queue_lock_position integer;
  v_queue_delete_position integer;
  v_count_position integer;
  v_post_update_position integer;
  v_trigger record;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
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
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
       OR inheritance.inhparent =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION 'post interaction count repair queue relation drifted';
  END IF;

  IF (
    SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY attribute.attnum)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) IS DISTINCT FROM ARRAY[
    'post_id',
    'enqueued_at',
    'next_attempt_at',
    'attempt_count'
  ]::text[] THEN
    RAISE EXCEPTION 'post interaction count repair queue column set drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
      AND attribute.attname = 'post_id'
      AND attribute.atttypid = 'uuid'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
      AND attribute.attname = 'enqueued_at'
      AND attribute.atttypid = 'timestamptz'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND pg_catalog.pg_get_expr(
            default_row.adbin,
            default_row.adrelid
          ) = 'statement_timestamp()'
  ) THEN
    RAISE EXCEPTION 'post interaction count repair queue column shape drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
      AND attribute.attname = 'next_attempt_at'
      AND attribute.atttypid = 'timestamptz'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND pg_catalog.pg_get_expr(
            default_row.adbin,
            default_row.adrelid
          ) = 'statement_timestamp()'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
      AND attribute.attname = 'attempt_count'
      AND attribute.atttypid = 'integer'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND pg_catalog.pg_get_expr(
            default_row.adbin,
            default_row.adrelid
          ) = '0'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_constraintdef(
            constraint_row.oid,
            true
          ) = 'CHECK (attempt_count >= 0 AND attempt_count <= 1000000)'
  ) THEN
    RAISE EXCEPTION 'post interaction count repair retry shape drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.convalidated
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum::smallint
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'post_id'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )
      ]::smallint[]
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
  ) THEN
    RAISE EXCEPTION 'post interaction count repair queue key contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS index_relation
    JOIN pg_catalog.pg_index AS index_row
      ON index_row.indexrelid = index_relation.oid
    WHERE index_relation.relnamespace = 'public'::pg_catalog.regnamespace
      AND index_relation.relname =
        'idx_post_interaction_count_repair_queue_oldest'
      AND index_relation.relkind = 'i'
      AND index_relation.relpersistence = 'p'
      AND index_relation.relowner = v_postgres_oid
      AND index_row.indrelid =
        'public.post_interaction_count_repair_queue'::pg_catalog.regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND NOT index_row.indisunique
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnatts = 3
      AND index_row.indnkeyatts = 3
      AND (
        SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY key_column.ordinality)
        FROM pg_catalog.unnest(index_row.indkey::smallint[])
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['next_attempt_at', 'enqueued_at', 'post_id']::text[]
  ) THEN
    RAISE EXCEPTION 'post interaction count repair queue index drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION 'post interaction count repair queue must not expose RLS policies';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'authenticator', 'service_role']::text[]
    ) AS role_name
    WHERE pg_catalog.has_any_column_privilege(
            role_name,
            'public.post_interaction_count_repair_queue',
            'SELECT,INSERT,UPDATE,REFERENCES'
          )
       OR pg_catalog.has_table_privilege(
            role_name,
            'public.post_interaction_count_repair_queue',
            'DELETE,TRUNCATE,TRIGGER'
          )
  ) THEN
    RAISE EXCEPTION 'post interaction count repair queue ACL leaked';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'authenticator', 'service_role']::text[]
    ) AS role_name
    CROSS JOIN pg_catalog.unnest(
      ARRAY['public.post_likes', 'public.post_votes']::text[]
    ) AS relation_name
    WHERE pg_catalog.has_table_privilege(
      role_name,
      relation_name,
      'TRUNCATE'
    )
  ) THEN
    RAISE EXCEPTION 'post interaction source TRUNCATE authority leaked';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_enqueue_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_enqueue_function
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

  IF pg_catalog.strpos(v_enqueue_source, 'pg_advisory') <> 0
     OR pg_catalog.strpos(v_enqueue_source, 'auth.users') <> 0
     OR pg_catalog.strpos(v_enqueue_source, 'UPDATE public.posts') <> 0
     OR pg_catalog.strpos(
          v_enqueue_source,
          'INSERT INTO public.post_interaction_count_repair_queue'
        ) = 0
  THEN
    RAISE EXCEPTION 'post interaction count repair enqueue lock contract drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_repair_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_repair_function
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

  v_post_lock_position := pg_catalog.strpos(
    v_repair_source,
    'pg_try_advisory_xact_lock'
  );
  v_post_row_lock_position := pg_catalog.strpos(
    v_repair_source,
    'FROM public.posts AS locked_post'
  );
  v_queue_lock_position := pg_catalog.strpos(
    v_repair_source,
    'INTO v_claimed_post_id'
  );
  v_queue_delete_position := pg_catalog.strpos(
    v_repair_source,
    'DELETE FROM public.post_interaction_count_repair_queue'
  );
  v_count_position := pg_catalog.strpos(v_repair_source, 'count(*) FILTER');
  v_post_update_position := pg_catalog.strpos(
    v_repair_source,
    'UPDATE public.posts'
  );
  IF v_post_lock_position = 0
     OR v_post_row_lock_position <= v_post_lock_position
     OR v_queue_lock_position <= v_post_row_lock_position
     OR v_queue_delete_position <= v_queue_lock_position
     OR v_count_position <= v_queue_delete_position
     OR v_post_update_position <= v_count_position
     OR pg_catalog.strpos(v_repair_source, 'service role required') = 0
  THEN
    RAISE EXCEPTION 'post interaction count repair worker lock order drifted';
  END IF;

  FOR v_trigger IN
    SELECT *
    FROM (
      VALUES
        (
          'public.post_likes'::pg_catalog.regclass,
          'trg_post_likes_90_enqueue_count_repair'
        ),
        (
          'public.post_votes'::pg_catalog.regclass,
          'trg_post_votes_90_enqueue_count_repair'
        )
    ) AS expected_trigger(relation_oid, trigger_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_trigger.relation_oid
        AND trigger_row.tgname = v_trigger.trigger_name
        AND trigger_row.tgfoid = v_enqueue_function
        AND trigger_row.tgenabled = 'O'
        AND NOT trigger_row.tgisinternal
        AND (trigger_row.tgtype & 1) = 1
        AND (trigger_row.tgtype & 2) = 0
        AND (trigger_row.tgtype & 4) = 4
        AND (trigger_row.tgtype & 8) = 8
        AND (trigger_row.tgtype & 16) = 16
    ) THEN
      RAISE EXCEPTION
        'post interaction count repair trigger drifted: %',
        v_trigger.trigger_name;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', v_repair_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_repair_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_repair_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticator', v_repair_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role', v_enqueue_function, 'EXECUTE'
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
       WHERE function_row.oid IN (v_enqueue_function, v_repair_function)
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
       WHERE function_row.oid = v_repair_function
         AND acl_entry.privilege_type = 'EXECUTE'
         AND acl_entry.grantee = v_service_oid
         AND acl_entry.is_grantable
     )
  THEN
    RAISE EXCEPTION 'post interaction count repair function ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY[
        pg_catalog.to_regprocedure('public.increment_like_count(uuid)'),
        pg_catalog.to_regprocedure('public.decrement_like_count(uuid)')
      ]::regprocedure[]
    ) AS legacy_function
    CROSS JOIN pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'authenticator', 'service_role']::text[]
    ) AS role_name
    WHERE legacy_function IS NOT NULL
      AND pg_catalog.has_function_privilege(
        role_name,
        legacy_function,
        'EXECUTE'
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid IN (
      pg_catalog.to_regprocedure('public.increment_like_count(uuid)'),
      pg_catalog.to_regprocedure('public.decrement_like_count(uuid)')
    )
      AND acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee = 0
  ) THEN
    RAISE EXCEPTION 'legacy arithmetic like counter RPC remains callable';
  END IF;
END
$postflight$;

COMMIT;
