-- Migration: 20260729184500_atomic_post_create.sql
-- Created: 2026-07-30T01:45:00Z
-- Description: Make post creation an idempotent database transaction. A
--   canonical request creates the post, optional custom poll, resolved mention
--   facets, and hashtag registry/join rows together or creates none of them.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('public.posts:atomic-post-create:migration', 0)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic post create migration lock is busy';
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
  v_expected_function regprocedure := pg_catalog.to_regprocedure(
    'public.create_post_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[])'
  );
  v_group_guard regprocedure := pg_catalog.to_regprocedure(
    'public.enforce_current_group_post_publish()'
  );
  v_revision_guard regprocedure := pg_catalog.to_regprocedure(
    'public.advance_post_content_version()'
  );
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'authenticator', 'service_role', 'postgres']::text[]
  ) AS required_role
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = required_role
  );

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'atomic post create roles are missing: %', v_missing_roles;
  END IF;

  IF pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.posts') IS NULL
     OR pg_catalog.to_regclass('public.polls') IS NULL
     OR pg_catalog.to_regclass('public.groups') IS NULL
     OR pg_catalog.to_regclass('public.group_members') IS NULL
     OR pg_catalog.to_regclass('public.group_bans') IS NULL
     OR pg_catalog.to_regclass('public.group_subscriptions') IS NULL
     OR pg_catalog.to_regclass('public.subscriptions') IS NULL
     OR pg_catalog.to_regclass('public.hashtags') IS NULL
     OR pg_catalog.to_regclass('public.post_hashtags') IS NULL
     OR pg_catalog.to_regtype('public.post_status') IS NULL
  THEN
    RAISE EXCEPTION 'canonical post create relations must deploy first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.posts'::regclass,
      'public.polls'::regclass,
      'public.groups'::regclass,
      'public.group_members'::regclass,
      'public.group_bans'::regclass,
      'public.group_subscriptions'::regclass,
      'public.subscriptions'::regclass,
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
      'public.polls'::regclass,
      'public.groups'::regclass,
      'public.group_members'::regclass,
      'public.group_bans'::regclass,
      'public.group_subscriptions'::regclass,
      'public.subscriptions'::regclass,
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION 'post create requires canonical permanent relation ownership';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.posts'::regclass,
      'public.polls'::regclass,
      'public.groups'::regclass,
      'public.group_members'::regclass,
      'public.group_bans'::regclass,
      'public.group_subscriptions'::regclass,
      'public.subscriptions'::regclass,
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass
    )
       OR inheritance.inhparent IN (
         'auth.users'::regclass,
         'public.user_profiles'::regclass,
         'public.posts'::regclass,
         'public.polls'::regclass,
         'public.groups'::regclass,
         'public.group_members'::regclass,
         'public.group_bans'::regclass,
         'public.group_subscriptions'::regclass,
         'public.subscriptions'::regclass,
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
      'public.polls'::regclass,
      'public.groups'::regclass,
      'public.group_members'::regclass,
      'public.group_bans'::regclass,
      'public.group_subscriptions'::regclass,
      'public.subscriptions'::regclass,
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass
    )
  ) THEN
    RAISE EXCEPTION 'post create relations must not use inheritance or rewrite rules';
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
      ('public', 'user_profiles', 3, 'reputation_score', 'integer'::regtype, false),
      ('public', 'user_profiles', 4, 'is_verified_trader', 'boolean'::regtype, false),
      ('public', 'user_profiles', 5, 'deleted_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 6, 'banned_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 7, 'is_banned', 'boolean'::regtype, true),
      ('public', 'user_profiles', 8, 'ban_expires_at', 'timestamptz'::regtype, false),
      ('public', 'posts', 1, 'id', 'uuid'::regtype, true),
      ('public', 'posts', 2, 'author_id', 'uuid'::regtype, true),
      ('public', 'posts', 3, 'author_handle', 'text'::regtype, false),
      ('public', 'posts', 4, 'author_arena_score', 'integer'::regtype, false),
      ('public', 'posts', 5, 'author_is_verified', 'boolean'::regtype, false),
      ('public', 'posts', 6, 'group_id', 'uuid'::regtype, false),
      ('public', 'posts', 7, 'title', 'text'::regtype, false),
      ('public', 'posts', 8, 'content', 'text'::regtype, false),
      ('public', 'posts', 9, 'images', 'text[]'::regtype, false),
      ('public', 'posts', 10, 'poll_enabled', 'boolean'::regtype, false),
      ('public', 'posts', 11, 'poll_id', 'uuid'::regtype, false),
      ('public', 'posts', 12, 'visibility', 'text'::regtype, true),
      ('public', 'posts', 13, 'is_sensitive', 'boolean'::regtype, false),
      ('public', 'posts', 14, 'content_warning', 'text'::regtype, false),
      ('public', 'posts', 15, 'language', 'text'::regtype, false),
      ('public', 'posts', 16, 'mentions', 'text[]'::regtype, false),
      ('public', 'posts', 17, 'hashtags', 'text[]'::regtype, false),
      ('public', 'posts', 18, 'content_version', 'bigint'::regtype, true),
      ('public', 'posts', 19, 'status', 'public.post_status'::regtype, true),
      ('public', 'posts', 20, 'deleted_at', 'timestamptz'::regtype, false),
      ('public', 'posts', 21, 'created_at', 'timestamptz'::regtype, true),
      ('public', 'posts', 22, 'updated_at', 'timestamptz'::regtype, true),
      ('public', 'polls', 1, 'id', 'uuid'::regtype, true),
      ('public', 'polls', 2, 'post_id', 'uuid'::regtype, false),
      ('public', 'polls', 3, 'question', 'text'::regtype, true),
      ('public', 'polls', 4, 'type', 'text'::regtype, false),
      ('public', 'polls', 5, 'end_at', 'timestamptz'::regtype, false),
      ('public', 'polls', 6, 'created_at', 'timestamptz'::regtype, false),
      ('public', 'polls', 7, 'updated_at', 'timestamptz'::regtype, false),
      ('public', 'hashtags', 1, 'id', 'uuid'::regtype, true),
      ('public', 'hashtags', 2, 'tag', 'text'::regtype, true),
      ('public', 'hashtags', 3, 'post_count', 'integer'::regtype, false),
      ('public', 'post_hashtags', 1, 'post_id', 'uuid'::regtype, true),
      ('public', 'post_hashtags', 2, 'hashtag_id', 'uuid'::regtype, true),
      ('public', 'groups', 1, 'id', 'uuid'::regtype, true),
      ('public', 'groups', 2, 'dissolved_at', 'timestamptz'::regtype, false),
      ('public', 'group_members', 1, 'group_id', 'uuid'::regtype, true),
      ('public', 'group_members', 2, 'user_id', 'uuid'::regtype, true),
      ('public', 'group_members', 3, 'muted_until', 'timestamptz'::regtype, false),
      ('public', 'group_bans', 1, 'group_id', 'uuid'::regtype, true),
      ('public', 'group_bans', 2, 'user_id', 'uuid'::regtype, true),
      ('public', 'group_subscriptions', 1, 'group_id', 'uuid'::regtype, true),
      ('public', 'group_subscriptions', 2, 'user_id', 'uuid'::regtype, true),
      ('public', 'subscriptions', 1, 'user_id', 'uuid'::regtype, true)
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
    RAISE EXCEPTION 'post create has incompatible columns: %', v_invalid_columns;
  END IF;

  -- Supabase's generated Json type does not distinguish json from jsonb, and
  -- the established vote authority explicitly casts polls.options to jsonb.
  -- Accept either physical representation while keeping every RPC comparison
  -- and acknowledgement canonical in jsonb.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.polls'::regclass
      AND attribute.attname = 'options'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.atttypid IN ('json'::regtype, 'jsonb'::regtype)
      AND attribute.attnotnull
  ) THEN
    RAISE EXCEPTION 'public.polls.options must be NOT NULL json or jsonb';
  END IF;

  -- Generated types alone do not prove these relationships. The historical
  -- migration chain references polls before it defines the table, so attest
  -- both sides of the circular post/poll relationship by catalog identity.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'public.posts'::regclass
      AND constraint_row.confrelid = 'public.polls'::regclass
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.posts'::regclass
          AND attribute.attname = 'poll_id'
      )]::smallint[]
      AND constraint_row.confkey = ARRAY[(
        SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.polls'::regclass
          AND attribute.attname = 'id'
      )]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'public.polls'::regclass
      AND constraint_row.confrelid = 'public.posts'::regclass
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.polls'::regclass
          AND attribute.attname = 'post_id'
      )]::smallint[]
      AND constraint_row.confkey = ARRAY[(
        SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.posts'::regclass
          AND attribute.attname = 'id'
      )]::smallint[]
  ) THEN
    RAISE EXCEPTION 'canonical bidirectional post/poll foreign keys are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype IN ('p', 'u')
      AND constraint_row.conrelid = 'public.hashtags'::regclass
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.hashtags'::regclass
          AND attribute.attname = 'tag'
      )]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'p'
      AND constraint_row.conrelid = 'public.post_hashtags'::regclass
      AND constraint_row.conkey = ARRAY[
        (SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = 'public.post_hashtags'::regclass
           AND attribute.attname = 'post_id'),
        (SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
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
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.post_hashtags'::regclass
          AND attribute.attname = 'post_id'
      )]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'public.post_hashtags'::regclass
      AND constraint_row.confrelid = 'public.hashtags'::regclass
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.post_hashtags'::regclass
          AND attribute.attname = 'hashtag_id'
      )]::smallint[]
  ) THEN
    RAISE EXCEPTION 'canonical post hashtag foreign keys are missing';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR v_group_guard IS NULL
     OR v_revision_guard IS NULL
     OR pg_catalog.to_regprocedure(
       'public.has_current_group_entitlement(uuid,uuid)'
     ) IS NULL
  THEN
    RAISE EXCEPTION 'canonical post create authorization functions must deploy first';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.posts'::regclass
      AND trigger_row.tgname = 'trg_posts_15_current_group_publish'
      AND trigger_row.tgfoid = v_group_guard
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.posts'::regclass
      AND trigger_row.tgname = 'trg_posts_10_content_version'
      AND trigger_row.tgfoid = v_revision_guard
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'canonical post create guards must be enabled';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'create_post_atomic'
      AND (
        v_expected_function IS NULL
        OR function_row.oid <> v_expected_function::oid
      )
  ) THEN
    RAISE EXCEPTION 'incompatible create_post_atomic overload exists';
  END IF;
END
$preflight$;

LOCK TABLE auth.users,
  public.user_profiles,
  public.posts,
  public.polls,
  public.groups,
  public.group_members,
  public.group_bans,
  public.group_subscriptions,
  public.subscriptions,
  public.hashtags,
  public.post_hashtags
  IN SHARE MODE;

CREATE TABLE IF NOT EXISTS public.post_create_operation_results (
  operation_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  intent_fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT post_create_operation_results_pkey PRIMARY KEY (operation_id),
  CONSTRAINT post_create_operation_fingerprint_check
    CHECK (intent_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT post_create_operation_result_check
    CHECK (
      pg_catalog.jsonb_typeof(result) = 'object'
      AND result ->> 'status' = 'created'
      AND result -> 'applied' = 'true'::jsonb
      AND result ->> 'operation_id' = operation_id::text
      AND result ->> 'actor_id' = actor_id::text
      AND pg_catalog.jsonb_typeof(result -> 'post') = 'object'
  )
);

DO $ledger_preflight$
DECLARE
  v_invalid_columns text[];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.post_create_operation_results'::regclass
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid =
        'public.post_create_operation_results'::regclass
       OR inheritance.inhparent =
        'public.post_create_operation_results'::regclass
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class =
      'public.post_create_operation_results'::regclass
  ) THEN
    RAISE EXCEPTION 'post create replay ledger must be a canonical permanent table';
  END IF;

  SELECT pg_catalog.array_agg(required_column.column_name ORDER BY required_column.ordinality)
  INTO v_invalid_columns
  FROM (
    VALUES
      (1, 'operation_id', 'uuid'::regtype, true),
      (2, 'actor_id', 'uuid'::regtype, true),
      (3, 'intent_fingerprint', 'text'::regtype, true),
      (4, 'result', 'jsonb'::regtype, true),
      (5, 'created_at', 'timestamptz'::regtype, true)
  ) AS required_column(ordinality, column_name, type_oid, required_not_null)
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = 'public.post_create_operation_results'::regclass
   AND attribute.attname = required_column.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
     OR attribute.atttypid <> required_column.type_oid
     OR (required_column.required_not_null AND NOT attribute.attnotnull);

  IF v_invalid_columns IS NOT NULL OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.post_create_operation_results'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attname NOT IN (
        'operation_id', 'actor_id', 'intent_fingerprint', 'result', 'created_at'
      )
  ) THEN
    RAISE EXCEPTION 'post create replay ledger columns are incompatible: %',
      v_invalid_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.post_create_operation_results'::regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid =
            'public.post_create_operation_results'::regclass
          AND attribute.attname = 'operation_id'
      )]::smallint[]
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.post_create_operation_results'::regclass
      AND constraint_row.contype = 'f'
  ) THEN
    RAISE EXCEPTION 'post create replay ledger key authority is incompatible';
  END IF;
END
$ledger_preflight$;

ALTER TABLE public.post_create_operation_results OWNER TO postgres;
ALTER TABLE public.post_create_operation_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_create_operation_results FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.post_create_operation_results
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

CREATE OR REPLACE FUNCTION public.create_post_atomic(
  p_actor_id uuid,
  p_operation_id uuid,
  p_title text,
  p_content text,
  p_group_id uuid,
  p_images text[],
  p_poll_enabled boolean,
  p_poll_option_texts text[],
  p_poll_type text,
  p_poll_duration_hours integer,
  p_visibility text,
  p_is_sensitive boolean,
  p_content_warning text,
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
  v_warning text := NULLIF(
    normalize(pg_catalog.btrim(COALESCE(p_content_warning, '')), NFC),
    ''
  );
  v_images text[];
  v_options text[];
  v_requested_mentions text[];
  v_mentions text[] := ARRAY[]::text[];
  v_hashtags text[];
  v_sorted_hashtags text[];
  v_hashtag_ids uuid[] := ARRAY[]::uuid[];
  v_intent_fingerprint text;
  v_existing_actor_id uuid;
  v_existing_fingerprint text;
  v_existing_result jsonb;
  v_profile public.user_profiles%ROWTYPE;
  v_group public.groups%ROWTYPE;
  v_muted_until timestamptz;
  v_post public.posts%ROWTYPE;
  v_poll public.polls%ROWTYPE;
  v_poll_options jsonb;
  v_poll_end_at timestamptz;
  v_hashtag_id uuid;
  v_tag text;
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  -- This relation lock is a deployment barrier shared by every promoted
  -- runtime. It prevents an old function body from racing a future ledger DDL.
  LOCK TABLE public.post_create_operation_results IN ROW EXCLUSIVE MODE;

  v_images := ARRAY(
    SELECT normalize(pg_catalog.btrim(image_url), NFC)
    FROM pg_catalog.unnest(COALESCE(p_images, ARRAY[]::text[]))
      WITH ORDINALITY AS requested(image_url, ordinality)
    ORDER BY requested.ordinality
  );
  v_options := CASE WHEN p_poll_option_texts IS NULL THEN NULL ELSE ARRAY(
    SELECT normalize(pg_catalog.btrim(option_text), NFC)
    FROM pg_catalog.unnest(p_poll_option_texts)
      WITH ORDINALITY AS requested(option_text, ordinality)
    ORDER BY requested.ordinality
  ) END;
  v_requested_mentions := ARRAY(
    SELECT normalize(pg_catalog.btrim(handle), NFC)
    FROM pg_catalog.unnest(COALESCE(p_mention_handles, ARRAY[]::text[]))
      AS requested(handle)
    ORDER BY pg_catalog.lower(normalize(pg_catalog.btrim(handle), NFC)),
      normalize(pg_catalog.btrim(handle), NFC)
  );
  v_hashtags := ARRAY(
    SELECT pg_catalog.lower(normalize(pg_catalog.btrim(tag), NFC))
    FROM pg_catalog.unnest(COALESCE(p_hashtag_tags, ARRAY[]::text[]))
      WITH ORDINALITY AS requested(tag, ordinality)
    ORDER BY requested.ordinality
  );
  -- Preserve the API's exact facet order in posts/ACK. Use a separate C-order
  -- lock sequence for registry rows so distinct concurrent posts cannot take
  -- shared hashtag locks in opposite orders.
  v_sorted_hashtags := ARRAY(
    SELECT tag
    FROM pg_catalog.unnest(v_hashtags) AS requested(tag)
    ORDER BY requested.tag COLLATE "C"
  );

  IF p_actor_id IS NULL
     OR p_operation_id IS NULL
     OR pg_catalog.char_length(v_title) NOT BETWEEN 1 AND 200
     OR v_title ~ '[[:cntrl:]]'
     OR pg_catalog.char_length(v_content) NOT BETWEEN 1 AND 10000
     OR pg_catalog.regexp_replace(v_content, E'[\n\r\t]', '', 'g') ~ '[[:cntrl:]]'
     OR p_images IS NULL
     OR pg_catalog.cardinality(v_images) > 9
     OR EXISTS (
       SELECT 1 FROM pg_catalog.unnest(v_images) AS image_url
       WHERE image_url IS NULL
          OR pg_catalog.char_length(image_url) NOT BETWEEN 1 AND 2048
          OR image_url !~* '^https?://[^[:space:][:cntrl:]]+$'
     )
     OR (
       SELECT pg_catalog.count(DISTINCT image_url)
       FROM pg_catalog.unnest(v_images) AS image_url
     ) <> pg_catalog.cardinality(v_images)
     OR p_poll_enabled IS NULL
     OR p_visibility IS NULL
     OR p_visibility NOT IN ('public', 'followers', 'group')
     OR (p_group_id IS NULL AND p_visibility = 'group')
     OR (p_group_id IS NOT NULL AND p_visibility <> 'group')
     OR p_is_sensitive IS NULL
     OR (NOT p_is_sensitive AND v_warning IS NOT NULL)
     OR pg_catalog.char_length(COALESCE(v_warning, '')) > 200
     OR COALESCE(v_warning, '') ~ '[[:cntrl:]]'
     OR p_language IS NULL
     OR p_language NOT IN ('zh', 'en', 'ja', 'ko')
     OR p_mention_handles IS NULL
     OR pg_catalog.cardinality(v_requested_mentions) > 50
     OR EXISTS (
       SELECT 1 FROM pg_catalog.unnest(v_requested_mentions) AS handle
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
       SELECT 1 FROM pg_catalog.unnest(v_hashtags) AS tag
       WHERE tag IS NULL
          OR pg_catalog.char_length(tag) NOT BETWEEN 1 AND 30
          OR tag ~ '[[:space:][:cntrl:]#]'
          OR tag !~ '^[[:alnum:]_一-龯ぁ-ゟ゠-ヿ가-힣]+$'
     )
     OR (
       SELECT pg_catalog.count(DISTINCT tag)
       FROM pg_catalog.unnest(v_hashtags) AS tag
     ) <> pg_catalog.cardinality(v_hashtags)
     OR (
       NOT p_poll_enabled
       AND (
         v_options IS NOT NULL
         OR p_poll_type IS NOT NULL
         OR p_poll_duration_hours IS NOT NULL
       )
     )
     OR (
       p_poll_enabled
       AND v_options IS NULL
       AND (p_poll_type IS NOT NULL OR p_poll_duration_hours IS NOT NULL)
     )
     OR (
       v_options IS NOT NULL
       AND (
         NOT p_poll_enabled
         OR pg_catalog.cardinality(v_options) NOT BETWEEN 2 AND 6
         OR p_poll_type IS NULL
         OR p_poll_type NOT IN ('single', 'multiple')
         OR p_poll_duration_hours IS NULL
         OR p_poll_duration_hours NOT BETWEEN 0 AND 168
         OR EXISTS (
           SELECT 1 FROM pg_catalog.unnest(v_options) AS option_text
           WHERE option_text IS NULL
              OR pg_catalog.char_length(option_text) NOT BETWEEN 1 AND 200
              OR option_text ~ '[[:cntrl:]]'
         )
         OR (
           SELECT pg_catalog.count(DISTINCT pg_catalog.lower(option_text))
           FROM pg_catalog.unnest(v_options) AS option_text
         ) <> pg_catalog.cardinality(v_options)
       )
     )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  v_intent_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(
      'post-create:v1',
      p_actor_id,
      v_title,
      v_content,
      p_group_id,
      v_images,
      p_poll_enabled,
      v_options,
      p_poll_type,
      p_poll_duration_hours,
      p_visibility,
      p_is_sensitive,
      v_warning,
      p_language,
      v_requested_mentions,
      v_hashtags
    )::text, 'UTF8')),
    'hex'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-create-operation:' || p_operation_id::text,
      0
    )
  );

  SELECT ledger.actor_id,
         ledger.intent_fingerprint,
         ledger.result
  INTO v_existing_actor_id,
       v_existing_fingerprint,
       v_existing_result
  FROM public.post_create_operation_results AS ledger
  WHERE ledger.operation_id = p_operation_id;

  IF FOUND THEN
    IF v_existing_actor_id IS NOT DISTINCT FROM p_actor_id
       AND v_existing_fingerprint IS NOT DISTINCT FROM v_intent_fingerprint
    THEN
      RETURN pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(
          v_existing_result,
          '{status}',
          pg_catalog.to_jsonb('replayed'::text),
          false
        ),
        '{applied}',
        'false'::jsonb,
        false
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'operation_conflict');
  END IF;

  -- Group membership writers and the group publication trigger use this as
  -- their first business lock. Keep it before all profile and relation locks.
  IF p_group_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'group-membership:' || p_group_id::text || ':' || p_actor_id::text,
        0
      )
    );
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_actor_id::text,
      0
    )
  );

  PERFORM auth_user.id
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_actor_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
  FOR SHARE;
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

  IF p_group_id IS NOT NULL THEN
    SELECT target_group.*
    INTO v_group
    FROM public.groups AS target_group
    WHERE target_group.id = p_group_id
    FOR SHARE;
    IF NOT FOUND OR v_group.dissolved_at IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object('status', 'group_unavailable');
    END IF;

    SELECT member.muted_until
    INTO v_muted_until
    FROM public.group_members AS member
    WHERE member.group_id = p_group_id
      AND member.user_id = p_actor_id
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('status', 'membership_required');
    END IF;
    IF v_muted_until IS NOT NULL AND v_muted_until > v_now THEN
      RETURN pg_catalog.jsonb_build_object('status', 'group_muted');
    END IF;

    PERFORM 1
    FROM public.group_bans AS active_ban
    WHERE active_ban.group_id = p_group_id
      AND active_ban.user_id = p_actor_id
    FOR SHARE;
    IF FOUND THEN
      RETURN pg_catalog.jsonb_build_object('status', 'group_banned');
    END IF;

    PERFORM 1
    FROM public.group_subscriptions AS group_pass
    WHERE group_pass.group_id = p_group_id
      AND group_pass.user_id = p_actor_id
    FOR SHARE;
    PERFORM 1
    FROM public.subscriptions AS global_subscription
    WHERE global_subscription.user_id = p_actor_id
    FOR SHARE;

    IF NOT public.has_current_group_entitlement(p_actor_id, p_group_id) THEN
      RETURN pg_catalog.jsonb_build_object('status', 'entitlement_required');
    END IF;
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(resolved.handle ORDER BY pg_catalog.lower(resolved.handle)),
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

  INSERT INTO public.posts (
    title,
    content,
    author_id,
    author_handle,
    author_arena_score,
    author_is_verified,
    group_id,
    images,
    poll_enabled,
    poll_id,
    visibility,
    is_sensitive,
    content_warning,
    language,
    mentions,
    hashtags
  ) VALUES (
    v_title,
    v_content,
    p_actor_id,
    v_profile.handle,
    COALESCE(v_profile.reputation_score, 0),
    COALESCE(v_profile.is_verified_trader, false),
    p_group_id,
    v_images,
    p_poll_enabled,
    NULL,
    p_visibility,
    p_is_sensitive,
    v_warning,
    p_language,
    v_mentions,
    v_hashtags
  )
  RETURNING * INTO v_post;

  IF v_post.id IS NULL
     OR v_post.author_id IS DISTINCT FROM p_actor_id
     OR v_post.content_version <> 0
     OR v_post.status IS DISTINCT FROM 'active'::public.post_status
     OR v_post.poll_id IS NOT NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'initial post create acknowledgement is invalid';
  END IF;

  IF v_options IS NOT NULL THEN
    SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'text', option_row.option_text,
        'votes', 0,
        'index', option_row.ordinality - 1
      )
      ORDER BY option_row.ordinality
    )
    INTO v_poll_options
    FROM pg_catalog.unnest(v_options)
      WITH ORDINALITY AS option_row(option_text, ordinality);

    v_poll_end_at := CASE
      WHEN p_poll_duration_hours = 0 THEN NULL
      ELSE v_now + pg_catalog.make_interval(hours => p_poll_duration_hours)
    END;

    INSERT INTO public.polls (
      post_id,
      question,
      options,
      type,
      end_at
    ) VALUES (
      v_post.id,
      v_title,
      v_poll_options,
      p_poll_type,
      v_poll_end_at
    )
    RETURNING * INTO v_poll;

    UPDATE public.posts AS target
    SET poll_id = v_poll.id
    WHERE target.id = v_post.id
      AND target.author_id = p_actor_id
      AND target.poll_id IS NULL
      AND target.content_version = 0
    RETURNING target.* INTO v_post;

    IF v_post.poll_id IS DISTINCT FROM v_poll.id
       OR v_poll.post_id IS DISTINCT FROM v_post.id
       OR v_poll.options::jsonb IS DISTINCT FROM v_poll_options
       OR v_post.content_version <> 0
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'custom poll binding acknowledgement is invalid';
    END IF;
  END IF;

  FOREACH v_tag IN ARRAY v_sorted_hashtags
  LOOP
    INSERT INTO public.hashtags (tag)
    VALUES (v_tag)
    ON CONFLICT (tag) DO NOTHING
    RETURNING id INTO v_hashtag_id;

    IF v_hashtag_id IS NULL THEN
      SELECT hashtag.id
      INTO v_hashtag_id
      FROM public.hashtags AS hashtag
      WHERE hashtag.tag = v_tag
      FOR UPDATE;
    END IF;
    IF v_hashtag_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'hashtag registry acknowledgement is invalid';
    END IF;

    INSERT INTO public.post_hashtags (post_id, hashtag_id)
    VALUES (v_post.id, v_hashtag_id)
    ON CONFLICT (post_id, hashtag_id) DO NOTHING;
    v_hashtag_ids := pg_catalog.array_append(v_hashtag_ids, v_hashtag_id);
    v_hashtag_id := NULL;
  END LOOP;

  IF pg_catalog.cardinality(v_hashtag_ids) > 0 THEN
    UPDATE public.hashtags AS hashtag
    SET post_count = (
      SELECT pg_catalog.count(*)::integer
      FROM public.post_hashtags AS post_hashtag
      WHERE post_hashtag.hashtag_id = hashtag.id
    )
    WHERE hashtag.id = ANY(v_hashtag_ids);
  END IF;

  v_result := pg_catalog.jsonb_build_object(
    'status', 'created',
    'applied', true,
    'operation_id', p_operation_id,
    'actor_id', p_actor_id,
    'post', pg_catalog.jsonb_build_object(
      'id', v_post.id,
      'author_id', v_post.author_id,
      'author_handle', v_post.author_handle,
      'author_arena_score', v_post.author_arena_score,
      'author_is_verified', v_post.author_is_verified,
      'group_id', v_post.group_id,
      'title', v_post.title,
      'content', v_post.content,
      'images', v_post.images,
      'poll_enabled', v_post.poll_enabled,
      'poll_id', v_post.poll_id,
      'visibility', v_post.visibility,
      'is_sensitive', v_post.is_sensitive,
      'content_warning', v_post.content_warning,
      'language', v_post.language,
      'mentions', v_post.mentions,
      'hashtags', v_post.hashtags,
      'content_version', v_post.content_version,
      'status', v_post.status,
      'created_at', v_post.created_at,
      'updated_at', v_post.updated_at
    ),
    'poll', CASE WHEN v_poll.id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
      'id', v_poll.id,
      'post_id', v_poll.post_id,
      'question', v_poll.question,
      'options', v_poll.options,
      'type', v_poll.type,
      'end_at', v_poll.end_at
    ) END
  );

  IF v_result ->> 'operation_id' IS DISTINCT FROM p_operation_id::text
     OR v_result #>> '{post,id}' IS DISTINCT FROM v_post.id::text
     OR (v_poll.id IS NOT NULL AND v_result #>> '{poll,id}' IS DISTINCT FROM v_poll.id::text)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'post create result acknowledgement is invalid';
  END IF;

  INSERT INTO public.post_create_operation_results (
    operation_id,
    actor_id,
    intent_fingerprint,
    result
  ) VALUES (
    p_operation_id,
    p_actor_id,
    v_intent_fingerprint,
    v_result
  );

  RETURN v_result;
END
$function$;

ALTER FUNCTION public.create_post_atomic(
  uuid, uuid, text, text, uuid, text[], boolean, text[], text, integer,
  text, boolean, text, text, text[], text[]
) OWNER TO postgres;
REVOKE ALL PRIVILEGES ON FUNCTION public.create_post_atomic(
  uuid, uuid, text, text, uuid, text[], boolean, text[], text, integer,
  text, boolean, text, text, text[], text[]
) FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION public.create_post_atomic(
  uuid, uuid, text, text, uuid, text[], boolean, text[], text, integer,
  text, boolean, text, text, text[], text[]
) TO service_role;

DO $attest_function$
DECLARE
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.create_post_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[])'::regprocedure;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION public.create_post_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[]) IS %L',
    'atomic-post-create:v1:' || pg_catalog.md5(v_source)
  );
END
$attest_function$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.create_post_atomic(uuid,uuid,text,text,uuid,text[],boolean,text[],text,integer,text,boolean,text,text,text[],text[])'::regprocedure;
  v_postgres_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'jsonb'::regtype
      AND NOT function_row.proretset
  )
     OR pg_catalog.strpos(v_source, 'post-create-operation:') = 0
     OR pg_catalog.strpos(v_source, 'group-membership:') = 0
     OR pg_catalog.strpos(v_source, 'account-recovery-admission:') = 0
     OR pg_catalog.strpos(v_source, 'INSERT INTO public.post_create_operation_results') = 0
     OR NOT pg_catalog.has_function_privilege(v_service_oid, v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticator', v_function, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'atomic post create authority postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
