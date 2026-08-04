-- Hashtag read authority.
--
-- The registry and join table are synchronization substrates, not public read
-- models.  Every public response below is rebuilt from posts accepted by the
-- canonical post audience predicate in one SQL statement/snapshot.  This
-- prevents private/deleted/root-hidden posts from leaking tag names, counts,
-- totals, or offset holes.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('ranking-arena:hashtag-read-authority:v1', 0)
);

DO $preflight$
DECLARE
  v_authority regprocedure :=
    pg_catalog.to_regprocedure('public.can_actor_read_post_id(uuid,uuid)');
  v_viewer_authority regprocedure := pg_catalog.to_regprocedure(
    'public.can_actor_read_post_fields(uuid,uuid,uuid,text,public.post_status,timestamptz)'
  );
BEGIN
  IF EXISTS (
    SELECT required_role.role_name
    FROM (VALUES
      ('anon'::name),
      ('authenticated'::name),
      ('service_role'::name),
      ('postgres'::name)
    ) AS required_role(role_name)
    LEFT JOIN pg_catalog.pg_roles AS installed_role
      ON installed_role.rolname = required_role.role_name
    WHERE installed_role.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'hashtag authority roles are missing';
  END IF;

  IF pg_catalog.to_regclass('public.hashtags') IS NULL
     OR pg_catalog.to_regclass('public.post_hashtags') IS NULL
     OR pg_catalog.to_regclass('public.posts') IS NULL
     OR pg_catalog.to_regclass('public.post_likes') IS NULL
     OR pg_catalog.to_regclass('public.post_votes') IS NULL THEN
    RAISE EXCEPTION 'hashtag authority base tables are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.hashtags'::pg_catalog.regclass,
      'public.post_hashtags'::pg_catalog.regclass,
      'public.posts'::pg_catalog.regclass,
      'public.post_likes'::pg_catalog.regclass,
      'public.post_votes'::pg_catalog.regclass
    )
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'public.hashtags'::pg_catalog.regclass,
      'public.post_hashtags'::pg_catalog.regclass,
      'public.posts'::pg_catalog.regclass,
      'public.post_likes'::pg_catalog.regclass,
      'public.post_votes'::pg_catalog.regclass
    )
       OR inheritance.inhparent IN (
         'public.hashtags'::pg_catalog.regclass,
         'public.post_hashtags'::pg_catalog.regclass,
         'public.posts'::pg_catalog.regclass,
         'public.post_likes'::pg_catalog.regclass,
         'public.post_votes'::pg_catalog.regclass
       )
  ) THEN
    RAISE EXCEPTION 'hashtag authority base tables are incompatible';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR v_authority IS NULL
     OR v_viewer_authority IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS authority
       WHERE authority.oid = v_authority
         AND authority.prokind = 'f'
         AND authority.prorettype = 'boolean'::pg_catalog.regtype
         AND authority.provolatile = 's'
         AND authority.prosecdef
         AND NOT authority.proisstrict
         AND NOT authority.proleakproof
         AND authority.proconfig IS NOT DISTINCT FROM ARRAY[
           'search_path=pg_catalog, pg_temp'
         ]::text[]
         AND pg_catalog.pg_get_userbyid(authority.proowner) = 'postgres'
     )
  THEN
    RAISE EXCEPTION 'canonical post read authority is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS authority
    WHERE authority.oid = v_viewer_authority
      AND authority.prokind = 'f'
      AND authority.prorettype = 'boolean'::pg_catalog.regtype
      AND authority.provolatile = 's'
      AND authority.prosecdef
      AND NOT authority.proisstrict
      AND NOT authority.proleakproof
      AND authority.proconfig IS NOT DISTINCT FROM ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
      AND pg_catalog.pg_get_userbyid(authority.proowner) = 'postgres'
  ) THEN
    RAISE EXCEPTION 'canonical post viewer authority is incompatible';
  END IF;

  IF pg_catalog.to_regcollation('pg_catalog."und-x-icu"') IS NULL THEN
    RAISE EXCEPTION 'Unicode hashtag collation is unavailable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('public.hashtags'::pg_catalog.regclass, 'id'::name, 'uuid'::pg_catalog.regtype),
      ('public.hashtags'::pg_catalog.regclass, 'tag'::name, 'text'::pg_catalog.regtype),
      ('public.hashtags'::pg_catalog.regclass, 'post_count'::name, 'integer'::pg_catalog.regtype),
      ('public.hashtags'::pg_catalog.regclass, 'created_at'::name, 'timestamp with time zone'::pg_catalog.regtype),
      ('public.post_hashtags'::pg_catalog.regclass, 'post_id'::name, 'uuid'::pg_catalog.regtype),
      ('public.post_hashtags'::pg_catalog.regclass, 'hashtag_id'::name, 'uuid'::pg_catalog.regtype),
      ('public.post_likes'::pg_catalog.regclass, 'post_id'::name, 'uuid'::pg_catalog.regtype),
      ('public.post_likes'::pg_catalog.regclass, 'user_id'::name, 'uuid'::pg_catalog.regtype),
      ('public.post_likes'::pg_catalog.regclass, 'reaction_type'::name, 'text'::pg_catalog.regtype),
      ('public.post_votes'::pg_catalog.regclass, 'post_id'::name, 'uuid'::pg_catalog.regtype),
      ('public.post_votes'::pg_catalog.regclass, 'user_id'::name, 'uuid'::pg_catalog.regtype),
      ('public.post_votes'::pg_catalog.regclass, 'choice'::name, 'text'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'id'::name, 'uuid'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'title'::name, 'text'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'content'::name, 'text'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'author_id'::name, 'uuid'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'author_handle'::name, 'text'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'author_avatar_url'::name, 'text'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'author_is_verified'::name, 'boolean'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'group_id'::name, 'uuid'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'poll_enabled'::name, 'boolean'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'poll_id'::name, 'uuid'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'poll_bull'::name, 'integer'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'poll_bear'::name, 'integer'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'poll_wait'::name, 'integer'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'like_count'::name, 'integer'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'dislike_count'::name, 'integer'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'comment_count'::name, 'integer'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'bookmark_count'::name, 'integer'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'repost_count'::name, 'integer'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'view_count'::name, 'integer'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'hot_score'::name, 'double precision'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'is_pinned'::name, 'boolean'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'images'::name, 'text[]'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'created_at'::name, 'timestamp with time zone'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'updated_at'::name, 'timestamp with time zone'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'original_post_id'::name, 'uuid'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'visibility'::name, 'text'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'is_sensitive'::name, 'boolean'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'content_warning'::name, 'text'::pg_catalog.regtype),
      ('public.posts'::pg_catalog.regclass, 'language'::name, 'text'::pg_catalog.regtype)
    ) AS required_column(relation_oid, column_name, type_oid)
    LEFT JOIN pg_catalog.pg_attribute AS installed_column
      ON installed_column.attrelid = required_column.relation_oid
     AND installed_column.attname = required_column.column_name
     AND installed_column.atttypid = required_column.type_oid
     AND installed_column.attnum > 0
     AND NOT installed_column.attisdropped
    WHERE installed_column.attrelid IS NULL
  ) THEN
    RAISE EXCEPTION 'hashtag authority columns are incompatible';
  END IF;

  IF EXISTS (
    SELECT required_relation.relation_oid
    FROM (VALUES
      ('public.post_likes'::pg_catalog.regclass),
      ('public.post_votes'::pg_catalog.regclass)
    ) AS required_relation(relation_oid)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS unique_constraint
      WHERE unique_constraint.conrelid = required_relation.relation_oid
        AND unique_constraint.contype = 'u'
        AND unique_constraint.convalidated
        AND pg_catalog.cardinality(unique_constraint.conkey) = 2
        AND unique_constraint.conkey @> ARRAY[
          (
            SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = required_relation.relation_oid
              AND attribute.attname = 'post_id'
          ),
          (
            SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = required_relation.relation_oid
              AND attribute.attname = 'user_id'
          )
        ]::smallint[]
    )
  ) THEN
    RAISE EXCEPTION 'post interaction identity uniqueness is incompatible';
  END IF;
END;
$preflight$;

-- A prior successful replay leaves postgres with the exact runtime ACL
-- (registry SELECT/UPDATE; mapping SELECT).  DELETE is also sufficient to take
-- the ACCESS EXCLUSIVE maintenance locks below.  Grant it transaction-locally
-- so the constrained table owner can replay and clean poison; the later
-- REVOKE ALL + exact grants remove it before this transaction can commit.
GRANT DELETE ON TABLE public.hashtags, public.post_hashtags TO postgres;

LOCK TABLE public.posts, public.post_likes, public.post_votes
  IN ACCESS SHARE MODE;
LOCK TABLE public.hashtags, public.post_hashtags IN ACCESS EXCLUSIVE MODE;

-- Install the forward registry invariant before replacing policies and ACLs.
-- A previous replay may already have FORCE RLS enabled; temporarily removing
-- FORCE lets a NOSUPERUSER/NOBYPASSRLS table owner delete historical poison.
-- Both tables remain RLS-enabled, the ACCESS EXCLUSIVE locks prevent another
-- session from observing this owner-only maintenance window, and rollback
-- restores the prior FORCE state if any later convergence check fails.
ALTER TABLE public.hashtags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hashtags NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.post_hashtags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_hashtags NO FORCE ROW LEVEL SECURITY;

ALTER TABLE public.hashtags
  DROP CONSTRAINT IF EXISTS hashtags_tag_canonical_check;

ALTER TABLE public.hashtags
  ADD CONSTRAINT hashtags_tag_canonical_check
  CHECK (
    tag IS NOT NULL
    AND tag COLLATE pg_catalog."C" =
      pg_catalog.btrim(tag) COLLATE pg_catalog."C"
    AND tag COLLATE pg_catalog."C" = pg_catalog.lower(
      tag COLLATE pg_catalog."und-x-icu"
    ) COLLATE pg_catalog."C"
    AND pg_catalog.char_length(tag) BETWEEN 1 AND 30
    AND (tag COLLATE pg_catalog."und-x-icu") ~ '^[[:alnum:]_]+$'
  ) NOT VALID;

DELETE FROM public.hashtags AS hashtag
WHERE NOT (
  hashtag.tag IS NOT NULL
  AND hashtag.tag COLLATE pg_catalog."C" =
    pg_catalog.btrim(hashtag.tag) COLLATE pg_catalog."C"
  AND hashtag.tag COLLATE pg_catalog."C" = pg_catalog.lower(
    hashtag.tag COLLATE pg_catalog."und-x-icu"
  ) COLLATE pg_catalog."C"
  AND pg_catalog.char_length(hashtag.tag) BETWEEN 1 AND 30
  AND (hashtag.tag COLLATE pg_catalog."und-x-icu") ~ '^[[:alnum:]_]+$'
);

ALTER TABLE public.hashtags
  VALIDATE CONSTRAINT hashtags_tag_canonical_check;

-- Converge table policies instead of relying on the permissive policies from
-- 20260319140500.  FORCE RLS protects accidental owner-like sessions; the
-- service policy keeps the existing service-role synchronization path usable
-- even in installations where service_role does not have BYPASSRLS.
DO $policy_convergence$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT
      policy_schema.nspname AS schema_name,
      policy_table.relname AS table_name,
      policy_row.polname AS policy_name
    FROM pg_catalog.pg_policy AS policy_row
    JOIN pg_catalog.pg_class AS policy_table
      ON policy_table.oid = policy_row.polrelid
    JOIN pg_catalog.pg_namespace AS policy_schema
      ON policy_schema.oid = policy_table.relnamespace
    WHERE policy_schema.nspname = 'public'
      AND policy_table.relname IN ('hashtags', 'post_hashtags')
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON %I.%I',
      v_policy.policy_name,
      v_policy.schema_name,
      v_policy.table_name
    );
  END LOOP;

END;
$policy_convergence$;

ALTER TABLE public.hashtags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hashtags FORCE ROW LEVEL SECURITY;
ALTER TABLE public.post_hashtags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_hashtags FORCE ROW LEVEL SECURITY;

CREATE POLICY hashtags_service_sync
  ON public.hashtags
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY post_hashtags_service_sync
  ON public.post_hashtags
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- SECURITY DEFINER changes the effective database role to postgres.  Keep the
-- owner usable even in managed installations where postgres is deliberately
-- NOSUPERUSER/NOBYPASSRLS, while granting only the commands used by these
-- three functions plus referential actions: read both substrates, update the
-- registry recount, and let an ON DELETE CASCADE remove mapping rows.  There
-- is deliberately no postgres DELETE policy, so direct mapping deletion stays
-- default-denied while PostgreSQL's internal referential action can complete.
CREATE POLICY hashtags_postgres_read
  ON public.hashtags
  AS PERMISSIVE
  FOR SELECT
  TO postgres
  USING (true);

CREATE POLICY hashtags_postgres_recount
  ON public.hashtags
  AS PERMISSIVE
  FOR UPDATE
  TO postgres
  USING (true)
  WITH CHECK (true);

CREATE POLICY post_hashtags_postgres_read
  ON public.post_hashtags
  AS PERMISSIVE
  FOR SELECT
  TO postgres
  USING (true);

REVOKE ALL ON TABLE public.hashtags, public.post_hashtags
  FROM PUBLIC, anon, authenticated, service_role, postgres;

DO $revoke_column_privileges$
DECLARE
  v_table regclass;
  v_column_list text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'public.hashtags'::pg_catalog.regclass,
    'public.post_hashtags'::pg_catalog.regclass
  ]
  LOOP
    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute_row.attname),
      ', '
      ORDER BY attribute_row.attnum
    )
    INTO v_column_list
    FROM pg_catalog.pg_attribute AS attribute_row
    WHERE attribute_row.attrelid = v_table
      AND attribute_row.attnum > 0
      AND NOT attribute_row.attisdropped;

    IF v_column_list IS NULL THEN
      RAISE EXCEPTION '% has no columns to secure', v_table;
    END IF;

    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), '
        || 'REFERENCES (%1$s) ON TABLE %2$s '
        || 'FROM PUBLIC, anon, authenticated, service_role, postgres',
      v_column_list,
      v_table
    );
  END LOOP;
END;
$revoke_column_privileges$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.hashtags, public.post_hashtags
  TO service_role;

GRANT SELECT, UPDATE ON TABLE public.hashtags TO postgres;
GRANT SELECT, DELETE ON TABLE public.post_hashtags TO postgres;
GRANT SELECT ON TABLE public.post_likes, public.post_votes TO postgres;

COMMENT ON COLUMN public.hashtags.post_count IS
  'Internal raw post_hashtags cardinality maintained for synchronization only; never public read authority.';

-- Remove every non-canonical overload, rather than merely revoking it.  An
-- inaccessible overload can still make PostgREST argument resolution
-- ambiguous.  DROP is intentionally RESTRICT: a dependency makes this
-- migration fail closed for an explicit repair instead of cascading damage.
DO $converge_old_overloads$
DECLARE
  v_function regprocedure;
BEGIN
  FOR v_function IN
    SELECT function_row.oid::pg_catalog.regprocedure
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname IN (
        'recount_hashtag_posts',
        'get_trending_hashtags_public',
        'get_hashtag_posts_page'
      )
      AND function_row.prokind = 'f'
  LOOP
    IF v_function IN (
      SELECT canonical_function
      FROM pg_catalog.unnest(ARRAY[
        pg_catalog.to_regprocedure('public.recount_hashtag_posts(uuid[])'),
        pg_catalog.to_regprocedure('public.get_trending_hashtags_public(integer)'),
        pg_catalog.to_regprocedure(
          'public.get_hashtag_posts_page(uuid,text,integer,integer,text)'
        )
      ]::pg_catalog.regprocedure[]) AS canonical(canonical_function)
      WHERE canonical_function IS NOT NULL
    ) THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',
        v_function
      );
    ELSE
      EXECUTE pg_catalog.format('DROP FUNCTION %s RESTRICT', v_function);
    END IF;
  END LOOP;
END;
$converge_old_overloads$;

-- Preserve the existing PostgREST argument name (hashtag_ids) and void return
-- contract.  Unlike the previous UPDATE ... FROM aggregate, the correlated
-- recount also resets requested tags to zero when their final mapping is gone.
CREATE OR REPLACE FUNCTION public.recount_hashtag_posts(
  hashtag_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF hashtag_ids IS NULL
     OR pg_catalog.cardinality(hashtag_ids) NOT BETWEEN 1 AND 500
     OR pg_catalog.array_position(hashtag_ids, NULL::uuid) IS NOT NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid hashtag recount input';
  END IF;

  WITH requested AS MATERIALIZED (
    SELECT DISTINCT requested_id.id
    FROM pg_catalog.unnest(hashtag_ids) AS requested_id(id)
  )
  UPDATE public.hashtags AS hashtag
  SET post_count = (
    SELECT pg_catalog.count(*)::integer
    FROM public.post_hashtags AS mapping
    WHERE mapping.hashtag_id = hashtag.id
  )
  WHERE hashtag.id IN (SELECT requested.id FROM requested);
END;
$function$;

-- Anonymous trending is derived from anonymous-readable mappings.  Stored
-- post_count remains an internal synchronization statistic and is never used
-- as public authority.
CREATE OR REPLACE FUNCTION public.get_trending_hashtags_public(
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid hashtag trending input';
  END IF;

  -- This is the function's only business-data statement.  Readability,
  -- aggregation, ordering, and the acknowledgement share one snapshot.
  WITH readable_mappings AS MATERIALIZED (
    SELECT
      hashtag.id,
      hashtag.tag,
      mapping.post_id
    FROM public.hashtags AS hashtag
    JOIN public.post_hashtags AS mapping
      ON mapping.hashtag_id = hashtag.id
    JOIN public.posts AS post
      ON post.id = mapping.post_id
    WHERE hashtag.tag COLLATE pg_catalog."C" =
        pg_catalog.btrim(hashtag.tag) COLLATE pg_catalog."C"
      AND hashtag.tag COLLATE pg_catalog."C" = pg_catalog.lower(
        hashtag.tag COLLATE pg_catalog."und-x-icu"
      ) COLLATE pg_catalog."C"
      AND pg_catalog.char_length(hashtag.tag) BETWEEN 1 AND 30
      AND (hashtag.tag COLLATE pg_catalog."und-x-icu") ~
        '^[[:alnum:]_]+$'
      AND public.can_actor_read_post_id(post.id, NULL::uuid)
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.regexp_matches(
          pg_catalog.concat_ws(' ', post.title, post.content)
            COLLATE pg_catalog."und-x-icu",
          '#([[:alnum:]_]{1,30})(?![[:alnum:]_])',
          'g'
        ) AS extracted(tag_match)
        WHERE pg_catalog.lower(
          extracted.tag_match[1] COLLATE pg_catalog."und-x-icu"
        ) COLLATE pg_catalog."C" = hashtag.tag COLLATE pg_catalog."C"
      )
  ),
  visible_hashtags AS MATERIALIZED (
    SELECT
      readable.id,
      readable.tag,
      pg_catalog.count(*)::integer AS post_count
    FROM readable_mappings AS readable
    GROUP BY readable.id, readable.tag
  ),
  trending_page AS MATERIALIZED (
    SELECT
      visible.id,
      visible.tag,
      visible.post_count
    FROM visible_hashtags AS visible
    ORDER BY
      visible.post_count DESC,
      visible.tag COLLATE pg_catalog."C" ASC,
      visible.id ASC
    LIMIT p_limit
  )
  SELECT pg_catalog.jsonb_build_object(
    'contract', 'hashtag_trending_v1',
    'viewer_id', NULL::uuid,
    'limit', p_limit,
    'hashtags', COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', page.id,
          'tag', page.tag,
          'post_count', page.post_count
        )
        ORDER BY
          page.post_count DESC,
          page.tag COLLATE pg_catalog."C" ASC,
          page.id ASC
      )
      FROM trending_page AS page
    ), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$function$;

-- The hashtag page filters all mappings through can_actor_read_post_id before
-- computing either total or OFFSET/LIMIT.  That ordering is the privacy and
-- pagination contract: unreadable rows cannot contribute totals or page holes.
CREATE OR REPLACE FUNCTION public.get_hashtag_posts_page(
  p_viewer_id uuid,
  p_tag text,
  p_limit integer,
  p_offset integer,
  p_sort_by text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_result jsonb;
  v_tag text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  v_tag := pg_catalog.lower(
    pg_catalog.btrim(p_tag) COLLATE pg_catalog."und-x-icu"
  );

  IF p_tag IS NULL
     OR p_tag IS DISTINCT FROM pg_catalog.btrim(p_tag)
     OR pg_catalog.char_length(v_tag) NOT BETWEEN 1 AND 30
     OR (v_tag COLLATE pg_catalog."und-x-icu") !~ '^[[:alnum:]_]+$'
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 10000
     OR p_sort_by IS NULL OR p_sort_by NOT IN ('created_at', 'hot_score')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid hashtag posts page input';
  END IF;

  -- This is the function's only business-data statement.  The materialized
  -- readable relation is the sole input to both page_rows and page_state.
  WITH effective_viewer AS MATERIALIZED (
    SELECT CASE
      WHEN p_viewer_id IS NOT NULL
       AND public.can_actor_read_post_fields(
         p_viewer_id,
         p_viewer_id,
         NULL::uuid,
         'followers'::text,
         'active'::public.post_status,
         NULL::timestamptz
       )
      THEN p_viewer_id
      ELSE NULL::uuid
    END AS id
  ),
  readable AS MATERIALIZED (
    SELECT
      post.id,
      post.title,
      post.content,
      post.author_id,
      post.author_handle,
      post.author_avatar_url,
      post.author_is_verified,
      post.group_id,
      post.poll_enabled,
      post.poll_id,
      post.poll_bull,
      post.poll_bear,
      post.poll_wait,
      post.like_count,
      post.dislike_count,
      post.comment_count,
      post.bookmark_count,
      post.repost_count,
      post.view_count,
      post.hot_score,
      post.is_pinned,
      post.images,
      post.created_at,
      post.updated_at,
      post.original_post_id,
      post.visibility,
      post.is_sensitive,
      post.content_warning,
      post.language
    FROM public.hashtags AS hashtag
    JOIN public.post_hashtags AS mapping
      ON mapping.hashtag_id = hashtag.id
    JOIN public.posts AS post
      ON post.id = mapping.post_id
    CROSS JOIN effective_viewer AS viewer
    WHERE hashtag.tag COLLATE pg_catalog."C" = v_tag COLLATE pg_catalog."C"
      AND hashtag.tag COLLATE pg_catalog."C" =
        pg_catalog.btrim(hashtag.tag) COLLATE pg_catalog."C"
      AND hashtag.tag COLLATE pg_catalog."C" = pg_catalog.lower(
        hashtag.tag COLLATE pg_catalog."und-x-icu"
      ) COLLATE pg_catalog."C"
      AND pg_catalog.char_length(hashtag.tag) BETWEEN 1 AND 30
      AND (hashtag.tag COLLATE pg_catalog."und-x-icu") ~
        '^[[:alnum:]_]+$'
      AND (p_viewer_id IS NULL OR viewer.id IS NOT NULL)
      AND public.can_actor_read_post_id(post.id, viewer.id)
      AND EXISTS (
        SELECT 1
        FROM pg_catalog.regexp_matches(
          pg_catalog.concat_ws(' ', post.title, post.content)
            COLLATE pg_catalog."und-x-icu",
          '#([[:alnum:]_]{1,30})(?![[:alnum:]_])',
          'g'
        ) AS extracted(tag_match)
        WHERE pg_catalog.lower(
          extracted.tag_match[1] COLLATE pg_catalog."und-x-icu"
        ) COLLATE pg_catalog."C" = hashtag.tag COLLATE pg_catalog."C"
      )
  ),
  page_rows AS MATERIALIZED (
    SELECT
      readable.id,
      readable.title,
      readable.content,
      readable.author_id,
      readable.author_handle,
      readable.author_avatar_url,
      readable.author_is_verified,
      readable.group_id,
      readable.poll_enabled,
      readable.poll_id,
      readable.poll_bull,
      readable.poll_bear,
      readable.poll_wait,
      readable.like_count,
      readable.dislike_count,
      readable.comment_count,
      readable.bookmark_count,
      readable.repost_count,
      readable.view_count,
      readable.hot_score,
      readable.is_pinned,
      readable.images,
      readable.created_at,
      readable.updated_at,
      readable.original_post_id,
      readable.visibility,
      readable.is_sensitive,
      readable.content_warning,
      readable.language
    FROM readable
    ORDER BY
      CASE WHEN p_sort_by = 'hot_score' THEN readable.hot_score END DESC NULLS LAST,
      readable.created_at DESC NULLS LAST,
      readable.id DESC
    OFFSET p_offset
    LIMIT p_limit
  ),
  enriched_page AS MATERIALIZED (
    SELECT
      page.id,
      page.title,
      page.content,
      page.author_id,
      page.author_handle,
      page.author_avatar_url,
      page.author_is_verified,
      page.group_id,
      page.poll_enabled,
      page.poll_id,
      page.poll_bull,
      page.poll_bear,
      page.poll_wait,
      page.like_count,
      page.dislike_count,
      page.comment_count,
      page.bookmark_count,
      page.repost_count,
      page.view_count,
      page.hot_score,
      page.is_pinned,
      page.images,
      page.created_at,
      page.updated_at,
      page.original_post_id,
      page.visibility,
      page.is_sensitive,
      page.content_warning,
      page.language,
      CASE
        WHEN viewer.id IS NULL THEN NULL::text
        ELSE (
          SELECT reaction.reaction_type
          FROM public.post_likes AS reaction
          WHERE reaction.post_id = page.id
            AND reaction.user_id = viewer.id
        )
      END AS user_reaction,
      CASE
        WHEN viewer.id IS NULL THEN NULL::text
        ELSE (
          SELECT vote.choice
          FROM public.post_votes AS vote
          WHERE vote.post_id = page.id
            AND vote.user_id = viewer.id
        )
      END AS user_vote
    FROM page_rows AS page
    CROSS JOIN effective_viewer AS viewer
  ),
  page_state AS MATERIALIZED (
    SELECT pg_catalog.count(*)::integer AS total
    FROM readable
  )
  SELECT pg_catalog.jsonb_build_object(
    'contract', 'hashtag_posts_page_v1',
    'viewer_state', CASE
      WHEN p_viewer_id IS NULL THEN 'anonymous'
      WHEN (SELECT viewer.id FROM effective_viewer AS viewer) IS NULL
        THEN 'invalid'
      ELSE 'active'
    END,
    'request', pg_catalog.jsonb_build_object(
      'viewer_id', p_viewer_id,
      'tag', v_tag,
      'limit', p_limit,
      'offset', p_offset,
      'sort_by', p_sort_by
    ),
    'posts', COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', page.id,
          'title', page.title,
          'content', page.content,
          'author_id', page.author_id,
          'author_handle', page.author_handle,
          'author_avatar_url', page.author_avatar_url,
          'author_is_verified', page.author_is_verified,
          'group_id', page.group_id,
          'poll_enabled', page.poll_enabled,
          'poll_id', page.poll_id,
          'poll_bull', page.poll_bull,
          'poll_bear', page.poll_bear,
          'poll_wait', page.poll_wait,
          'like_count', page.like_count,
          'dislike_count', page.dislike_count,
          'comment_count', page.comment_count,
          'bookmark_count', page.bookmark_count,
          'repost_count', page.repost_count,
          'view_count', page.view_count,
          'hot_score', page.hot_score,
          'is_pinned', page.is_pinned,
          'images', page.images,
          'created_at', page.created_at,
          'updated_at', page.updated_at,
          'original_post_id', page.original_post_id,
          'visibility', page.visibility,
          'is_sensitive', page.is_sensitive,
          'content_warning', page.content_warning,
          'language', page.language,
          'user_reaction', page.user_reaction,
          'user_vote', page.user_vote
        )
        ORDER BY
          CASE WHEN p_sort_by = 'hot_score' THEN page.hot_score END DESC NULLS LAST,
          page.created_at DESC NULLS LAST,
          page.id DESC
      )
      FROM enriched_page AS page
    ), '[]'::jsonb),
    'total', (SELECT state.total FROM page_state AS state),
    'has_more', (
      SELECT state.total > (p_offset + p_limit)
      FROM page_state AS state
    ),
    'next_cursor', NULL::jsonb
  )
  INTO v_result;

  RETURN v_result;
END;
$function$;

ALTER FUNCTION public.recount_hashtag_posts(uuid[]) OWNER TO postgres;
ALTER FUNCTION public.get_trending_hashtags_public(integer) OWNER TO postgres;
ALTER FUNCTION public.get_hashtag_posts_page(uuid, text, integer, integer, text)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.recount_hashtag_posts(uuid[])
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_trending_hashtags_public(integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_hashtag_posts_page(
  uuid, text, integer, integer, text
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.recount_hashtag_posts(uuid[])
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_trending_hashtags_public(integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_hashtag_posts_page(
  uuid, text, integer, integer, text
) TO service_role;

COMMENT ON FUNCTION public.recount_hashtag_posts(uuid[]) IS
  'Service-only exact recount of requested hashtag mappings, including zero reset.';
COMMENT ON FUNCTION public.get_trending_hashtags_public(integer) IS
  'Service-only anonymous-readable hashtag ranking; returns hashtag_trending_v1.';
COMMENT ON FUNCTION public.get_hashtag_posts_page(
  uuid, text, integer, integer, text
) IS
  'Service-only viewer-bound hashtag page; canonical readability precedes total and offset pagination.';

-- Repeat the destructive convergence after installation so replay also
-- removes any drifted overload.  Dependencies still fail the transaction.
DO $drop_phantom_overloads$
DECLARE
  v_function regprocedure;
BEGIN
  FOR v_function IN
    SELECT function_row.oid::regprocedure
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.prokind = 'f'
      AND function_row.proname IN (
        'recount_hashtag_posts',
        'get_trending_hashtags_public',
        'get_hashtag_posts_page'
      )
      AND function_row.oid NOT IN (
        'public.recount_hashtag_posts(uuid[])'::pg_catalog.regprocedure,
        'public.get_trending_hashtags_public(integer)'::pg_catalog.regprocedure,
        'public.get_hashtag_posts_page(uuid,text,integer,integer,text)'::pg_catalog.regprocedure
      )
  LOOP
    EXECUTE pg_catalog.format('DROP FUNCTION %s RESTRICT', v_function);
  END LOOP;
END;
$drop_phantom_overloads$;

-- Fail the migration if the installed authority differs from the contract.
DO $postflight$
DECLARE
  v_role name;
  v_table regclass;
  v_privilege text;
  v_function regprocedure;
  v_expected_function regprocedure;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'public.hashtags'::pg_catalog.regclass,
    'public.post_hashtags'::pg_catalog.regclass
  ]
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS table_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          table_row.relacl,
          pg_catalog.acldefault('r', table_row.relowner)
        )
      ) AS privilege_row
      WHERE table_row.oid = v_table
        AND privilege_row.grantee = 0
    ) THEN
      RAISE EXCEPTION 'PUBLIC retains table authority on %', v_table;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        attribute_row.attacl
      ) AS privilege_row
      WHERE attribute_row.attrelid = v_table
        AND attribute_row.attnum > 0
        AND NOT attribute_row.attisdropped
        AND privilege_row.grantee = 0
        AND privilege_row.privilege_type IN (
          'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
        )
    ) THEN
      RAISE EXCEPTION 'PUBLIC retains column authority on %', v_table;
    END IF;

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER'
      ]::text[]
      LOOP
        IF pg_catalog.has_table_privilege(v_role, v_table, v_privilege) THEN
          RAISE EXCEPTION '% retains % on %', v_role, v_privilege, v_table;
        END IF;
      END LOOP;

      IF pg_catalog.has_any_column_privilege(
        v_role, v_table, 'SELECT,INSERT,UPDATE,REFERENCES'
      ) THEN
        RAISE EXCEPTION '% retains column authority on %', v_role, v_table;
      END IF;
    END LOOP;

    FOREACH v_privilege IN ARRAY ARRAY[
      'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(
        'service_role', v_table, v_privilege
      ) THEN
        RAISE EXCEPTION 'service_role unexpectedly has % on %',
          v_privilege, v_table;
      END IF;
    END LOOP;

    FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]
    LOOP
      IF NOT pg_catalog.has_table_privilege(
        'service_role', v_table, v_privilege
      ) THEN
        RAISE EXCEPTION 'service_role lacks % on %', v_privilege, v_table;
      END IF;
    END LOOP;

    IF NOT (
      SELECT table_row.relrowsecurity AND table_row.relforcerowsecurity
      FROM pg_catalog.pg_class AS table_row
      WHERE table_row.oid = v_table
    ) THEN
      RAISE EXCEPTION '% does not force row security', v_table;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_table_privilege(
    'postgres', 'public.post_likes', 'SELECT'
  ) OR NOT pg_catalog.has_table_privilege(
    'postgres', 'public.post_votes', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'postgres lacks hashtag interaction projection authority';
  END IF;

  IF EXISTS (
    WITH installed_policy AS (
      SELECT
        policy_table.relname AS table_name,
        policy_row.polname AS policy_name,
        policy_row.polpermissive,
        policy_row.polcmd,
        policy_row.polroles,
        pg_catalog.pg_get_expr(
          policy_row.polqual, policy_row.polrelid
        ) AS using_expression,
        pg_catalog.pg_get_expr(
          policy_row.polwithcheck, policy_row.polrelid
        ) AS check_expression
      FROM pg_catalog.pg_policy AS policy_row
      JOIN pg_catalog.pg_class AS policy_table
        ON policy_table.oid = policy_row.polrelid
      JOIN pg_catalog.pg_namespace AS policy_schema
        ON policy_schema.oid = policy_table.relnamespace
      WHERE policy_schema.nspname = 'public'
        AND policy_table.relname IN ('hashtags', 'post_hashtags')
    ),
    expected_policy AS (
      SELECT *
      FROM (VALUES
        (
          'hashtags'::name,
          'hashtags_service_sync'::name,
          '*'::"char",
          ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role')]::oid[],
          'true'::text,
          'true'::text
        ),
        (
          'post_hashtags'::name,
          'post_hashtags_service_sync'::name,
          '*'::"char",
          ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role')]::oid[],
          'true'::text,
          'true'::text
        ),
        (
          'hashtags'::name,
          'hashtags_postgres_read'::name,
          'r'::"char",
          ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres')]::oid[],
          'true'::text,
          NULL::text
        ),
        (
          'hashtags'::name,
          'hashtags_postgres_recount'::name,
          'w'::"char",
          ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres')]::oid[],
          'true'::text,
          'true'::text
        ),
        (
          'post_hashtags'::name,
          'post_hashtags_postgres_read'::name,
          'r'::"char",
          ARRAY[(SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres')]::oid[],
          'true'::text,
          NULL::text
        )
      ) AS expected(
        table_name,
        policy_name,
        command,
        roles,
        using_expression,
        check_expression
      )
    )
    SELECT 1
    FROM (
      ((SELECT
         table_name, policy_name, polcmd, polroles,
         using_expression, check_expression
       FROM installed_policy
       WHERE polpermissive)
      EXCEPT
      (SELECT
         table_name, policy_name, command, roles,
         using_expression, check_expression
       FROM expected_policy))
      UNION ALL
      ((SELECT
         table_name, policy_name, command, roles,
         using_expression, check_expression
       FROM expected_policy)
      EXCEPT
      (SELECT
         table_name, policy_name, polcmd, polroles,
         using_expression, check_expression
       FROM installed_policy
       WHERE polpermissive))
    ) AS unexpected
  ) OR EXISTS (
    WITH installed_policy AS (
      SELECT policy_table.relname AS table_name, policy_row.polname AS policy_name
      FROM pg_catalog.pg_policy AS policy_row
      JOIN pg_catalog.pg_class AS policy_table
        ON policy_table.oid = policy_row.polrelid
      WHERE policy_table.oid IN (
        'public.hashtags'::pg_catalog.regclass,
        'public.post_hashtags'::pg_catalog.regclass
      )
    )
    SELECT 1
    FROM installed_policy
    HAVING pg_catalog.count(*) <> 5
       OR pg_catalog.count(*) FILTER (
         WHERE policy_name IN (
           'hashtags_service_sync',
           'post_hashtags_service_sync',
           'hashtags_postgres_read',
           'hashtags_postgres_recount',
           'post_hashtags_postgres_read'
         )
       ) <> 5
  ) THEN
    RAISE EXCEPTION 'hashtag policy convergence is incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.hashtags'::pg_catalog.regclass
      AND constraint_row.conname = 'hashtags_tag_canonical_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) LIKE
        '%char_length(tag) >= 1%char_length(tag) <= 30%'
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) LIKE
        '%btrim(tag) COLLATE "C"%'
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) LIKE
        '%lower(tag COLLATE "und-x-icu") COLLATE "C"%'
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) LIKE
        '%^[[:alnum:]_]+$%'
  ) THEN
    RAISE EXCEPTION 'canonical hashtag constraint is incomplete';
  END IF;

  FOREACH v_expected_function IN ARRAY ARRAY[
    'public.recount_hashtag_posts(uuid[])'::pg_catalog.regprocedure,
    'public.get_trending_hashtags_public(integer)'::pg_catalog.regprocedure,
    'public.get_hashtag_posts_page(uuid,text,integer,integer,text)'::pg_catalog.regprocedure
  ]
  LOOP
    IF (
      SELECT pg_catalog.pg_get_userbyid(function_row.proowner)
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_expected_function
    ) IS DISTINCT FROM 'postgres' THEN
      RAISE EXCEPTION '% has an unexpected owner', v_expected_function;
    END IF;

    IF NOT pg_catalog.has_function_privilege(
      'service_role', v_expected_function, 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'service_role cannot execute %', v_expected_function;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS privilege_row
      WHERE function_row.oid = v_expected_function
        AND privilege_row.grantee = 0
        AND privilege_row.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'PUBLIC can execute %', v_expected_function;
    END IF;

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
    LOOP
      IF pg_catalog.has_function_privilege(
        v_role, v_expected_function, 'EXECUTE'
      ) THEN
        RAISE EXCEPTION '% can execute %', v_role, v_expected_function;
      END IF;
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_expected_function
        AND function_row.prokind = 'f'
        AND function_row.prosecdef
        AND NOT function_row.proisstrict
        AND NOT function_row.proleakproof
        AND function_row.proparallel = 'u'
        AND function_row.provolatile = CASE
          WHEN function_row.proname = 'recount_hashtag_posts' THEN 'v'::"char"
          ELSE 's'::"char"
        END
        AND function_row.prorettype = CASE
          WHEN function_row.proname = 'recount_hashtag_posts'
            THEN 'void'::pg_catalog.regtype
          ELSE 'jsonb'::pg_catalog.regtype
        END
        AND function_row.pronargdefaults = CASE
          WHEN function_row.proname = 'get_trending_hashtags_public' THEN 1
          ELSE 0
        END
        AND function_row.proargnames IS NOT DISTINCT FROM CASE
          WHEN function_row.proname = 'recount_hashtag_posts'
            THEN ARRAY['hashtag_ids']::text[]
          WHEN function_row.proname = 'get_trending_hashtags_public'
            THEN ARRAY['p_limit']::text[]
          ELSE ARRAY[
            'p_viewer_id', 'p_tag', 'p_limit', 'p_offset', 'p_sort_by'
          ]::text[]
        END
        AND function_row.proconfig IS NOT DISTINCT FROM ARRAY[
          'search_path=pg_catalog, pg_temp'
        ]::text[]
    ) THEN
      RAISE EXCEPTION '% lacks the fixed security-definer contract',
        v_expected_function;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.prokind = 'f'
      AND function_row.proname IN (
        'recount_hashtag_posts',
        'get_trending_hashtags_public',
        'get_hashtag_posts_page'
      )
      AND function_row.oid NOT IN (
        'public.recount_hashtag_posts(uuid[])'::pg_catalog.regprocedure,
        'public.get_trending_hashtags_public(integer)'::pg_catalog.regprocedure,
        'public.get_hashtag_posts_page(uuid,text,integer,integer,text)'::pg_catalog.regprocedure
      )
  ) THEN
    RAISE EXCEPTION 'phantom hashtag function overload remains';
  END IF;
END;
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
