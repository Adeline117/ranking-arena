-- Migration: 20260729186500_atomic_post_edit_facets.sql
-- Created: 2026-07-30T02:05:00Z
-- Description: Extend compare-and-swap post edits so canonical language,
--   resolved mentions, hashtag facets, hashtag associations, and cached counts
--   change in the same transaction as rendered title/content/images.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.posts:atomic-post-edit-facets:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic post edit facets migration lock is busy';
  END IF;
END
$migration_lock$;

DO $preflight$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_missing_roles text[];
  v_invalid_columns text[];
  v_old_function regprocedure := pg_catalog.to_regprocedure(
    'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[])'
  );
  v_new_function regprocedure := pg_catalog.to_regprocedure(
    'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[],text,text[],text[])'
  );
  v_create_function regprocedure := pg_catalog.to_regprocedure(
    'public.create_post_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[])'
  );
  v_revision_function regprocedure := pg_catalog.to_regprocedure(
    'public.advance_post_content_version()'
  );
  v_create_source text;
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
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = required_role
  );

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'atomic post edit facet roles are missing: %',
      v_missing_roles;
  END IF;

  IF pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.posts') IS NULL
     OR pg_catalog.to_regclass('public.hashtags') IS NULL
     OR pg_catalog.to_regclass('public.post_hashtags') IS NULL
  THEN
    RAISE EXCEPTION 'canonical post edit facet relations must deploy first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.posts'::regclass,
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass
    )
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.user_profiles'::regclass,
      'public.posts'::regclass,
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.posts'::regclass,
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass
    )
       OR inheritance.inhparent IN (
         'auth.users'::regclass,
         'public.user_profiles'::regclass,
         'public.posts'::regclass,
         'public.hashtags'::regclass,
         'public.post_hashtags'::regclass
       )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.posts'::regclass,
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass
    )
  ) THEN
    RAISE EXCEPTION
      'post edit facets require canonical postgres-owned permanent tables';
  END IF;

  SELECT pg_catalog.array_agg(
    pg_catalog.format(
      '%I.%I.%I expected %s%s',
      required_column.schema_name,
      required_column.relation_name,
      required_column.column_name,
      required_column.type_oid::regtype,
      CASE WHEN required_column.required_not_null THEN ' NOT NULL' ELSE '' END
    )
    ORDER BY required_column.schema_name,
      required_column.relation_name,
      required_column.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      ('auth', 'users', 1, 'id', 'uuid'::regtype, true),
      ('public', 'user_profiles', 1, 'id', 'uuid'::regtype, true),
      ('public', 'user_profiles', 2, 'handle', 'text'::regtype, true),
      ('public', 'user_profiles', 3, 'deleted_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 4, 'banned_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 5, 'is_banned', 'boolean'::regtype, true),
      ('public', 'user_profiles', 6, 'ban_expires_at', 'timestamptz'::regtype, false),
      ('public', 'posts', 1, 'id', 'uuid'::regtype, true),
      ('public', 'posts', 2, 'author_id', 'uuid'::regtype, true),
      ('public', 'posts', 3, 'group_id', 'uuid'::regtype, false),
      ('public', 'posts', 4, 'title', 'text'::regtype, false),
      ('public', 'posts', 5, 'content', 'text'::regtype, false),
      ('public', 'posts', 6, 'images', 'text[]'::regtype, false),
      ('public', 'posts', 7, 'language', 'text'::regtype, false),
      ('public', 'posts', 8, 'mentions', 'text[]'::regtype, false),
      ('public', 'posts', 9, 'hashtags', 'text[]'::regtype, false),
      ('public', 'posts', 10, 'content_version', 'bigint'::regtype, true),
      ('public', 'posts', 11, 'updated_at', 'timestamptz'::regtype, false),
      ('public', 'posts', 12, 'deleted_at', 'timestamptz'::regtype, false),
      ('public', 'posts', 13, 'status', 'public.post_status'::regtype, true),
      ('public', 'hashtags', 1, 'id', 'uuid'::regtype, true),
      ('public', 'hashtags', 2, 'tag', 'text'::regtype, true),
      ('public', 'hashtags', 3, 'post_count', 'integer'::regtype, false),
      ('public', 'post_hashtags', 1, 'post_id', 'uuid'::regtype, true),
      ('public', 'post_hashtags', 2, 'hashtag_id', 'uuid'::regtype, true)
  ) AS required_column(
    schema_name,
    relation_name,
    ordinality,
    column_name,
    type_oid,
    required_not_null
  )
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = pg_catalog.to_regclass(
      pg_catalog.format(
        '%I.%I',
        required_column.schema_name,
        required_column.relation_name
      )
    )
   AND attribute.attname = required_column.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
     OR attribute.atttypid <> required_column.type_oid
     OR (required_column.required_not_null AND NOT attribute.attnotnull);

  IF v_invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION 'post edit facet columns are incompatible: %',
      v_invalid_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indexrelid =
        pg_catalog.to_regclass('public.user_profiles_handle_lower_unique')
      AND index_row.indrelid = 'public.user_profiles'::regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND pg_catalog.pg_get_indexdef(index_row.indexrelid) =
        'CREATE UNIQUE INDEX user_profiles_handle_lower_unique ON public.user_profiles USING btree (lower(handle))'
  ) THEN
    RAISE EXCEPTION
      'canonical case-insensitive profile handle identity is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype IN ('p', 'u')
      AND constraint_row.conrelid = 'public.hashtags'::regclass
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.hashtags'::regclass
          AND attribute.attname = 'tag'
      )]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'p'
      AND constraint_row.conrelid = 'public.post_hashtags'::regclass
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND constraint_row.conkey = ARRAY[
        (SELECT attribute.attnum
         FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = 'public.post_hashtags'::regclass
           AND attribute.attname = 'post_id'),
        (SELECT attribute.attnum
         FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = 'public.post_hashtags'::regclass
           AND attribute.attname = 'hashtag_id')
      ]::smallint[]
  ) THEN
    RAISE EXCEPTION 'canonical hashtag uniqueness constraints are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'public.post_hashtags'::regclass
      AND constraint_row.confrelid = 'public.posts'::regclass
      AND constraint_row.convalidated
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.post_hashtags'::regclass
          AND attribute.attname = 'post_id'
      )]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'public.post_hashtags'::regclass
      AND constraint_row.confrelid = 'public.hashtags'::regclass
      AND constraint_row.convalidated
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.post_hashtags'::regclass
          AND attribute.attname = 'hashtag_id'
      )]::smallint[]
  ) THEN
    RAISE EXCEPTION 'canonical cascading post hashtag foreign keys are missing';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR v_create_function IS NULL
     OR v_revision_function IS NULL
     OR (v_old_function IS NULL AND v_new_function IS NULL)
  THEN
    RAISE EXCEPTION
      'atomic create/edit foundations must deploy before post edit facets';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_create_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_create_function;

  IF pg_catalog.strpos(v_create_source, 'v_sorted_hashtags') = 0
     OR pg_catalog.strpos(
       v_create_source,
       'ORDER BY requested.tag COLLATE "C"'
     ) = 0
     OR pg_catalog.strpos(
       v_create_source,
       'FOR UPDATE'
     ) = 0
  THEN
    RAISE EXCEPTION
      'atomic create hashtag lock contract is incompatible with editing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.posts'::regclass
      AND trigger_row.tgname = 'trg_posts_10_content_version'
      AND trigger_row.tgfoid = v_revision_function
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'canonical post revision trigger must be enabled';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'edit_post_atomic'
      AND function_row.oid NOT IN (
        COALESCE(v_old_function::oid, 0::oid),
        COALESCE(v_new_function::oid, 0::oid)
      )
  ) THEN
    RAISE EXCEPTION 'incompatible edit_post_atomic overload exists';
  END IF;
END
$preflight$;

-- Prevent relation replacement while the function row types and association
-- invariants are republished. Runtime DML remains available during this short
-- predeploy migration.
LOCK TABLE auth.users,
  public.user_profiles,
  public.posts,
  public.hashtags,
  public.post_hashtags
  IN SHARE MODE;

-- Facets are rendered/filterable content. A repair that changes a stored facet
-- therefore advances the same database-owned revision as title/content/images.
CREATE OR REPLACE FUNCTION public.advance_post_content_version()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
     OR TG_TABLE_NAME IS DISTINCT FROM 'posts'
     OR TG_OP NOT IN ('INSERT', 'UPDATE')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'post content version trigger is misattached';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.content_version := 0;
    RETURN NEW;
  END IF;

  IF NEW.title IS DISTINCT FROM OLD.title
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.images IS DISTINCT FROM OLD.images
     OR NEW.language IS DISTINCT FROM OLD.language
     OR NEW.mentions IS DISTINCT FROM OLD.mentions
     OR NEW.hashtags IS DISTINCT FROM OLD.hashtags
  THEN
    IF OLD.content_version = 9223372036854775807 THEN
      RAISE EXCEPTION USING
        ERRCODE = '22003',
        MESSAGE = 'post content version exhausted';
    END IF;
    NEW.content_version := OLD.content_version + 1;
    NEW.updated_at := pg_catalog.clock_timestamp();
    IF OLD.updated_at IS NOT NULL AND NEW.updated_at <= OLD.updated_at THEN
      NEW.updated_at := OLD.updated_at + '1 microsecond'::interval;
    END IF;
  ELSE
    NEW.content_version := OLD.content_version;
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.advance_post_content_version() OWNER TO postgres;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.advance_post_content_version()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

DO $attest_revision_function$
DECLARE
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.advance_post_content_version()'::regprocedure;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION public.advance_post_content_version() IS %L',
    'post-content-version:v2:' || pg_catalog.md5(v_source)
  );
END
$attest_revision_function$;

CREATE OR REPLACE FUNCTION public.edit_post_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_expected_version bigint,
  p_title text,
  p_content text,
  p_update_images boolean,
  p_images text[],
  p_language text,
  p_mention_handles text[],
  p_hashtag_tags text[]
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
  v_now constant timestamptz := pg_catalog.statement_timestamp();
  v_title text := normalize(pg_catalog.btrim(COALESCE(p_title, '')), NFC);
  v_content text := normalize(COALESCE(p_content, ''), NFC);
  v_requested_mentions text[];
  v_mentions text[] := ARRAY[]::text[];
  v_hashtags text[];
  v_sorted_hashtags text[];
  v_join_hashtags text[] := ARRAY[]::text[];
  v_lock_tags text[] := ARRAY[]::text[];
  v_desired_hashtag_ids uuid[] := ARRAY[]::uuid[];
  v_affected_hashtag_ids uuid[] := ARRAY[]::uuid[];
  v_observed_author_id uuid;
  v_observed_group_id uuid;
  v_profile public.user_profiles%ROWTYPE;
  v_post public.posts%ROWTYPE;
  v_updated_post public.posts%ROWTYPE;
  v_hashtag_id uuid;
  v_tag text;
  v_update_count integer := 0;
  v_revision_advanced boolean := false;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  v_requested_mentions := ARRAY(
    SELECT normalize(pg_catalog.btrim(handle), NFC)
    FROM pg_catalog.unnest(
      COALESCE(p_mention_handles, ARRAY[]::text[])
    ) AS requested(handle)
    ORDER BY pg_catalog.lower(
      normalize(pg_catalog.btrim(handle), NFC)
    ), normalize(pg_catalog.btrim(handle), NFC)
  );
  v_hashtags := ARRAY(
    SELECT pg_catalog.lower(normalize(pg_catalog.btrim(tag), NFC))
    FROM pg_catalog.unnest(
      COALESCE(p_hashtag_tags, ARRAY[]::text[])
    ) WITH ORDINALITY AS requested(tag, ordinality)
    ORDER BY requested.ordinality
  );
  v_sorted_hashtags := ARRAY(
    SELECT requested.tag
    FROM pg_catalog.unnest(v_hashtags) AS requested(tag)
    ORDER BY requested.tag COLLATE "C"
  );

  IF p_actor_id IS NULL
     OR p_post_id IS NULL
     OR p_expected_version IS NULL
     OR p_expected_version < 0
     OR p_title IS NULL
     OR p_content IS NULL
     OR p_update_images IS NULL
     OR pg_catalog.char_length(v_title) NOT BETWEEN 1 AND 200
     OR v_title ~ '[[:cntrl:]]'
     OR pg_catalog.char_length(v_content) > 50000
     OR pg_catalog.regexp_replace(v_content, E'[\n\r\t]', '', 'g') ~ '[[:cntrl:]]'
     OR (NOT p_update_images AND p_images IS NOT NULL)
     OR (p_update_images AND p_images IS NULL)
     OR (p_update_images AND pg_catalog.cardinality(p_images) > 9)
     OR (
       p_update_images
       AND EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(p_images) AS image_url
         WHERE image_url IS NULL
            OR pg_catalog.char_length(image_url) NOT BETWEEN 1 AND 2048
            OR image_url IS DISTINCT FROM pg_catalog.btrim(image_url)
            OR image_url !~* '^https?://[^[:space:][:cntrl:]]+$'
       )
     )
     OR (
       p_update_images
       AND (
         SELECT pg_catalog.count(DISTINCT image_url)
         FROM pg_catalog.unnest(p_images) AS image_url
       ) <> pg_catalog.cardinality(p_images)
     )
     OR p_language IS NULL
     OR p_language NOT IN ('zh', 'en', 'ja', 'ko')
     OR p_mention_handles IS NULL
     OR pg_catalog.cardinality(v_requested_mentions) > 50
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(v_requested_mentions) AS handle
       WHERE handle IS NULL
          OR pg_catalog.char_length(handle) NOT BETWEEN 1 AND 30
          OR handle ~ '[[:space:][:cntrl:]]'
          OR handle !~ '^[A-Za-z0-9_.一-龯ぁ-ゟ゠-ヿ가-힣]+$'
     )
     OR (
       SELECT pg_catalog.count(DISTINCT pg_catalog.lower(handle))
       FROM pg_catalog.unnest(v_requested_mentions) AS handle
     ) <> pg_catalog.cardinality(v_requested_mentions)
     OR p_hashtag_tags IS NULL
     OR pg_catalog.cardinality(v_hashtags) > 50
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(v_hashtags) AS tag
       WHERE tag IS NULL
          OR pg_catalog.char_length(tag) NOT BETWEEN 1 AND 30
          OR tag ~ '[[:space:][:cntrl:]#]'
          OR tag !~ '^[[:alnum:]_一-龯ぁ-ゟ゠-ヿ가-힣]+$'
     )
     OR (
       SELECT pg_catalog.count(DISTINCT tag)
       FROM pg_catalog.unnest(v_hashtags) AS tag
     ) <> pg_catalog.cardinality(v_hashtags)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  -- Observe immutable scope before choosing the group membership advisory
  -- lock. The row is re-attested after its canonical lock below.
  SELECT target.author_id,
         target.group_id
  INTO v_observed_author_id,
       v_observed_group_id
  FROM public.posts AS target
  WHERE target.id = p_post_id
    AND target.deleted_at IS NULL
    AND target.status = 'active'::public.post_status;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_observed_group_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'group-membership:' || v_observed_group_id::text || ':' ||
          p_actor_id::text,
        0
      )
    );
  END IF;

  PERFORM auth_user.id
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_actor_id
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_profile.deleted_at IS NOT NULL
     OR v_profile.banned_at IS NOT NULL
     OR (
       COALESCE(v_profile.is_banned, false)
       AND (
         v_profile.ban_expires_at IS NULL
         OR v_profile.ban_expires_at > v_now
       )
     )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  SELECT target.*
  INTO v_post
  FROM public.posts AS target
  WHERE target.id = p_post_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_post.deleted_at IS NOT NULL
     OR v_post.status IS DISTINCT FROM 'active'::public.post_status
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_post.author_id IS DISTINCT FROM v_observed_author_id
     OR v_post.group_id IS DISTINCT FROM v_observed_group_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'post edit scope changed before its canonical lock';
  END IF;

  IF v_post.author_id IS DISTINCT FROM p_actor_id THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(
      resolved.handle ORDER BY pg_catalog.lower(resolved.handle)
    ),
    ARRAY[]::text[]
  )
  INTO v_mentions
  FROM (
    SELECT DISTINCT ON (profile.id) profile.id, profile.handle
    FROM pg_catalog.unnest(v_requested_mentions) AS requested(handle)
    JOIN public.user_profiles AS profile
      ON pg_catalog.lower(profile.handle) = pg_catalog.lower(requested.handle)
    WHERE profile.deleted_at IS NULL
      AND profile.banned_at IS NULL
      AND NOT (
        COALESCE(profile.is_banned, false)
        AND (
          profile.ban_expires_at IS NULL
          OR profile.ban_expires_at > v_now
        )
      )
    ORDER BY profile.id, profile.handle
  ) AS resolved;

  SELECT COALESCE(
    pg_catalog.array_agg(
      hashtag.tag ORDER BY hashtag.tag COLLATE "C"
    ),
    ARRAY[]::text[]
  )
  INTO v_join_hashtags
  FROM public.post_hashtags AS post_hashtag
  JOIN public.hashtags AS hashtag
    ON hashtag.id = post_hashtag.hashtag_id
  WHERE post_hashtag.post_id = p_post_id;

  -- A retry after a lost acknowledgement remains successful even with its old
  -- revision token, but only when both stored facets and normalized joins are
  -- already the exact desired result.
  IF v_post.title IS NOT DISTINCT FROM v_title
     AND v_post.content IS NOT DISTINCT FROM v_content
     AND (
       NOT p_update_images
       OR v_post.images IS NOT DISTINCT FROM p_images
     )
     AND v_post.language IS NOT DISTINCT FROM p_language
     AND v_post.mentions IS NOT DISTINCT FROM v_mentions
     AND v_post.hashtags IS NOT DISTINCT FROM v_hashtags
     AND v_join_hashtags IS NOT DISTINCT FROM v_sorted_hashtags
     AND NOT EXISTS (
       SELECT 1
       FROM public.hashtags AS hashtag
       WHERE hashtag.tag = ANY(v_sorted_hashtags)
         AND hashtag.post_count IS DISTINCT FROM (
           SELECT pg_catalog.count(*)::integer
           FROM public.post_hashtags AS post_hashtag
           WHERE post_hashtag.hashtag_id = hashtag.id
         )
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'unchanged',
      'actor_id', p_actor_id,
      'revision_advanced', false,
      'post', pg_catalog.jsonb_build_object(
        'id', v_post.id,
        'author_id', v_post.author_id,
        'group_id', v_post.group_id,
        'title', v_post.title,
        'content', v_post.content,
        'images', v_post.images,
        'language', v_post.language,
        'mentions', v_post.mentions,
        'hashtags', v_post.hashtags,
        'content_version', v_post.content_version,
        'updated_at', v_post.updated_at
      )
    );
  END IF;

  IF v_post.content_version IS DISTINCT FROM p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object('status', 'conflict');
  END IF;

  -- The promoted create authority locks registry parents in C tag order. Lock
  -- the union of removed/retained/added tags in that same order before adding
  -- a missing registry row, so concurrent create/edit flows cannot invert
  -- parent locks. Transaction advisory locks also serialize identical missing
  -- tags without becoming part of the data model.
  SELECT COALESCE(
    pg_catalog.array_agg(unioned.tag ORDER BY unioned.tag COLLATE "C"),
    ARRAY[]::text[]
  )
  INTO v_lock_tags
  FROM (
    SELECT requested.tag
    FROM pg_catalog.unnest(v_sorted_hashtags) AS requested(tag)
    UNION
    SELECT existing.tag
    FROM pg_catalog.unnest(v_join_hashtags) AS existing(tag)
  ) AS unioned;

  FOREACH v_tag IN ARRAY v_lock_tags
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('post-hashtag-registry:' || v_tag, 0)
    );
  END LOOP;

  -- Pre-lock every existing union parent before INSERT ... ON CONFLICT can
  -- acquire a later tag row. This is the critical create/edit deadlock guard.
  PERFORM hashtag.id
  FROM public.hashtags AS hashtag
  WHERE hashtag.tag = ANY(v_lock_tags)
  ORDER BY hashtag.tag COLLATE "C"
  FOR UPDATE;

  FOREACH v_tag IN ARRAY v_sorted_hashtags
  LOOP
    v_hashtag_id := NULL;
    INSERT INTO public.hashtags (tag)
    VALUES (v_tag)
    ON CONFLICT (tag) DO NOTHING
    RETURNING id INTO v_hashtag_id;

    IF v_hashtag_id IS NULL THEN
      SELECT hashtag.id
      INTO v_hashtag_id
      FROM public.hashtags AS hashtag
      WHERE hashtag.tag = v_tag;
    END IF;
    IF v_hashtag_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'post edit hashtag registry acknowledgement is invalid';
    END IF;
  END LOOP;

  -- Re-lock the same order to cover parents inserted by this transaction or a
  -- concurrent non-overlapping creator. Never switch to UUID order here: the
  -- 184500 create authority intentionally uses tag order.
  PERFORM hashtag.id
  FROM public.hashtags AS hashtag
  WHERE hashtag.tag = ANY(v_lock_tags)
  ORDER BY hashtag.tag COLLATE "C"
  FOR UPDATE;

  SELECT COALESCE(
    pg_catalog.array_agg(hashtag.id ORDER BY hashtag.tag COLLATE "C"),
    ARRAY[]::uuid[]
  )
  INTO v_desired_hashtag_ids
  FROM public.hashtags AS hashtag
  WHERE hashtag.tag = ANY(v_sorted_hashtags);

  IF pg_catalog.cardinality(v_desired_hashtag_ids) IS DISTINCT FROM
       pg_catalog.cardinality(v_sorted_hashtags)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'post edit desired hashtag set is incomplete';
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(affected.id ORDER BY affected.tag COLLATE "C"),
    ARRAY[]::uuid[]
  )
  INTO v_affected_hashtag_ids
  FROM (
    SELECT hashtag.id, hashtag.tag
    FROM public.hashtags AS hashtag
    WHERE hashtag.tag = ANY(v_lock_tags)
  ) AS affected;

  v_revision_advanced :=
    v_post.title IS DISTINCT FROM v_title
    OR v_post.content IS DISTINCT FROM v_content
    OR (
      p_update_images
      AND v_post.images IS DISTINCT FROM p_images
    )
    OR v_post.language IS DISTINCT FROM p_language
    OR v_post.mentions IS DISTINCT FROM v_mentions
    OR v_post.hashtags IS DISTINCT FROM v_hashtags;

  UPDATE public.posts AS target
  SET title = v_title,
      content = v_content,
      images = CASE WHEN p_update_images THEN p_images ELSE v_post.images END,
      language = p_language,
      mentions = v_mentions,
      hashtags = v_hashtags
  WHERE target.id = p_post_id
    AND target.author_id = p_actor_id
    AND target.deleted_at IS NULL
    AND target.status = 'active'::public.post_status
    AND target.content_version = p_expected_version
  RETURNING target.* INTO v_updated_post;
  GET DIAGNOSTICS v_update_count = ROW_COUNT;

  IF v_update_count <> 1
     OR v_updated_post.id IS DISTINCT FROM p_post_id
     OR v_updated_post.author_id IS DISTINCT FROM p_actor_id
     OR v_updated_post.group_id IS DISTINCT FROM v_post.group_id
     OR v_updated_post.title IS DISTINCT FROM v_title
     OR v_updated_post.content IS DISTINCT FROM v_content
     OR v_updated_post.images IS DISTINCT FROM (
       CASE WHEN p_update_images THEN p_images ELSE v_post.images END
     )
     OR v_updated_post.language IS DISTINCT FROM p_language
     OR v_updated_post.mentions IS DISTINCT FROM v_mentions
     OR v_updated_post.hashtags IS DISTINCT FROM v_hashtags
     OR v_updated_post.content_version IS DISTINCT FROM
       (
         v_post.content_version +
         CASE WHEN v_revision_advanced THEN 1 ELSE 0 END
       )
     OR (
       v_revision_advanced
       AND (
         v_updated_post.updated_at IS NULL
         OR v_updated_post.updated_at IS NOT DISTINCT FROM v_post.updated_at
       )
     )
     OR (
       NOT v_revision_advanced
       AND v_updated_post.updated_at IS DISTINCT FROM v_post.updated_at
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'post edit facet acknowledgement is invalid';
  END IF;

  DELETE FROM public.post_hashtags AS post_hashtag
  WHERE post_hashtag.post_id = p_post_id
    AND NOT (
      post_hashtag.hashtag_id = ANY(v_desired_hashtag_ids)
    );

  INSERT INTO public.post_hashtags (post_id, hashtag_id)
  SELECT p_post_id, desired.hashtag_id
  FROM pg_catalog.unnest(v_desired_hashtag_ids) AS desired(hashtag_id)
  ON CONFLICT (post_id, hashtag_id) DO NOTHING;

  -- Before 186000 this exact recount is the count authority. After 186000 its
  -- row trigger applies deltas first; this locked recount converges to the same
  -- exact value and therefore cannot double-count.
  UPDATE public.hashtags AS hashtag
  SET post_count = (
    SELECT pg_catalog.count(*)::integer
    FROM public.post_hashtags AS post_hashtag
    WHERE post_hashtag.hashtag_id = hashtag.id
  )
  WHERE hashtag.id = ANY(v_affected_hashtag_ids);

  SELECT COALESCE(
    pg_catalog.array_agg(
      hashtag.tag ORDER BY hashtag.tag COLLATE "C"
    ),
    ARRAY[]::text[]
  )
  INTO v_join_hashtags
  FROM public.post_hashtags AS post_hashtag
  JOIN public.hashtags AS hashtag
    ON hashtag.id = post_hashtag.hashtag_id
  WHERE post_hashtag.post_id = p_post_id;

  IF v_join_hashtags IS DISTINCT FROM v_sorted_hashtags
     OR EXISTS (
       SELECT 1
       FROM public.hashtags AS hashtag
       WHERE hashtag.id = ANY(v_affected_hashtag_ids)
         AND hashtag.post_count IS DISTINCT FROM (
           SELECT pg_catalog.count(*)::integer
           FROM public.post_hashtags AS post_hashtag
           WHERE post_hashtag.hashtag_id = hashtag.id
         )
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'post edit hashtag synchronization is invalid';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'updated',
    'actor_id', p_actor_id,
    'revision_advanced', v_revision_advanced,
    'post', pg_catalog.jsonb_build_object(
      'id', v_updated_post.id,
      'author_id', v_updated_post.author_id,
      'group_id', v_updated_post.group_id,
      'title', v_updated_post.title,
      'content', v_updated_post.content,
      'images', v_updated_post.images,
      'language', v_updated_post.language,
      'mentions', v_updated_post.mentions,
      'hashtags', v_updated_post.hashtags,
      'content_version', v_updated_post.content_version,
      'updated_at', v_updated_post.updated_at
    )
  );
END
$function$;

ALTER FUNCTION public.edit_post_atomic(
  uuid, uuid, bigint, text, text, boolean, text[], text, text[], text[]
) OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[],text,text[],text[])'::regprocedure;
  v_owner oid;
  v_grantee record;
  v_source text;
BEGIN
  SELECT function_row.proowner, function_row.prosrc
  INTO STRICT v_owner, v_source
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
    IF v_grantee.grantee = 0 THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC',
        v_function
      );
    ELSIF v_grantee.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I',
        v_function,
        v_grantee.rolname
      );
    END IF;
  END LOOP;

  REVOKE ALL PRIVILEGES
    ON FUNCTION public.edit_post_atomic(
      uuid, uuid, bigint, text, text, boolean, text[], text, text[], text[]
    )
    FROM PUBLIC, anon, authenticated, authenticator, service_role;
  GRANT EXECUTE
    ON FUNCTION public.edit_post_atomic(
      uuid, uuid, bigint, text, text, boolean, text[], text, text[], text[]
    )
    TO service_role;

  -- This migration is additive so old application instances keep editing
  -- during the rolling deploy. The postdeploy closure removes this exact
  -- overload only after every instance sends the new facet arguments.
  IF pg_catalog.to_regprocedure(
       'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[])'
     ) IS NOT NULL
  THEN
    REVOKE ALL PRIVILEGES
      ON FUNCTION public.edit_post_atomic(
        uuid, uuid, bigint, text, text, boolean, text[]
      )
      FROM PUBLIC, anon, authenticated, authenticator, service_role;
    GRANT EXECUTE
      ON FUNCTION public.edit_post_atomic(
        uuid, uuid, bigint, text, text, boolean, text[]
      )
      TO service_role;
  END IF;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-post-edit-facets:v2:' || pg_catalog.md5(v_source)
  );
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[],text,text[],text[])'::regprocedure;
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_old_function regprocedure := pg_catalog.to_regprocedure(
    'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[])'
  );
  v_source text;
  v_comment text;
  v_revision_source text;
  v_revision_comment text;
BEGIN
  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'jsonb'::regtype
    AND pg_catalog.cardinality(function_row.proconfig) = 4
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off',
      'lock_timeout=5s',
      'statement_timeout=15s'
    ];

  IF v_comment IS DISTINCT FROM
       'atomic-post-edit-facets:v2:' || pg_catalog.md5(v_source)
     OR pg_catalog.strpos(v_source, 'FOR UPDATE') = 0
     OR pg_catalog.strpos(
       v_source,
       'v_post.content_version IS DISTINCT FROM p_expected_version'
     ) = 0
     OR pg_catalog.strpos(
       v_source,
       'target.content_version = p_expected_version'
     ) = 0
     OR pg_catalog.strpos(v_source, 'v_update_count <> 1') = 0
     OR pg_catalog.strpos(
       v_source,
       'UPDATE public.hashtags AS hashtag'
     ) = 0
     OR pg_catalog.strpos(
       v_source,
       'ORDER BY hashtag.tag COLLATE "C"'
     ) = 0
  THEN
    RAISE EXCEPTION 'atomic post edit facet source is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.aclexplode(
      COALESCE(
        (SELECT function_row.proacl
         FROM pg_catalog.pg_proc AS function_row
         WHERE function_row.oid = v_function),
        pg_catalog.acldefault('f', v_postgres_oid)
      )
    ) AS acl_entry
    WHERE acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
  ) OR NOT pg_catalog.has_function_privilege(
    v_service_oid,
    v_function,
    'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'edit_post_atomic'
      AND function_row.oid NOT IN (
        v_function::oid,
        COALESCE(v_old_function::oid, 0::oid)
      )
  ) THEN
    RAISE EXCEPTION 'atomic post edit facet function ACL/signature is invalid';
  END IF;

  IF v_old_function IS NOT NULL AND (
    NOT pg_catalog.has_function_privilege(
      v_service_oid,
      v_old_function,
      'EXECUTE'
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_entry
      WHERE function_row.oid = v_old_function
        AND acl_entry.privilege_type = 'EXECUTE'
        AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
    )
  ) THEN
    RAISE EXCEPTION 'legacy post edit compatibility ACL is invalid';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_revision_source, v_revision_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
      'public.advance_post_content_version()'::regprocedure
    AND function_row.proowner = v_postgres_oid
    AND NOT function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'trigger'::regtype
    AND pg_catalog.cardinality(function_row.proconfig) = 1
    AND function_row.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'];

  IF v_revision_comment IS DISTINCT FROM
       'post-content-version:v2:' || pg_catalog.md5(v_revision_source)
     OR pg_catalog.strpos(
       v_revision_source,
       'NEW.language IS DISTINCT FROM OLD.language'
     ) = 0
     OR pg_catalog.strpos(
       v_revision_source,
       'NEW.mentions IS DISTINCT FROM OLD.mentions'
     ) = 0
     OR pg_catalog.strpos(
       v_revision_source,
       'NEW.hashtags IS DISTINCT FROM OLD.hashtags'
     ) = 0
  THEN
    RAISE EXCEPTION 'post facet revision function attestation is invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.posts'::regclass
      AND trigger_row.tgname = 'trg_posts_10_content_version'
      AND trigger_row.tgfoid =
        'public.advance_post_content_version()'::regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'post facet revision trigger is invalid';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
