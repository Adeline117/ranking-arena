-- Migration: 20260729171000_atomic_direct_message_search.sql
-- Created: 2026-07-30T10:10:00Z
-- Description: Search an authenticated participant's live, uncleared direct
--   messages with a total (created_at, id) cursor from one MVCC snapshot.
--
-- Forward compensation: roll API readers back before dropping this read-only
-- RPC in a later forward migration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.direct_messages:atomic-conversation-search:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic direct-message search migration lock is busy';
  END IF;
END
$migration_lock$;

DO $preflight$
DECLARE
  v_postgres_oid oid := pg_catalog.to_regrole('postgres')::oid;
  v_missing_roles text[];
  v_invalid_columns text[];
  v_conversation_attnum smallint;
  v_member_user_attnum smallint;
  v_search_function regprocedure := pg_catalog.to_regprocedure(
    'public.search_direct_message_conversation_atomic(uuid,uuid,text,timestamp with time zone,uuid,timestamp with time zone,timestamp with time zone,integer)'
  );
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'service_role', 'postgres']::text[]
  ) AS required_role
  WHERE pg_catalog.to_regrole(required_role) IS NULL;

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'direct-message search roles are missing: %',
      v_missing_roles;
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.conversations') IS NULL
     OR pg_catalog.to_regclass('public.conversation_members') IS NULL
     OR pg_catalog.to_regclass('public.direct_messages') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.install_active_authenticated_subject_mutation_barriers()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.assert_active_authenticated_subject_mutation_barriers()'
     ) IS NULL
  THEN
    RAISE EXCEPTION
      'canonical account and direct-message authorities must deploy first';
  END IF;

  IF (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure('auth.role()')
  ) <> 'text'::regtype THEN
    RAISE EXCEPTION 'auth.role() returning text must exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.conversations'::regclass,
      'public.conversation_members'::regclass,
      'public.direct_messages'::regclass
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
      'public.conversations'::regclass,
      'public.conversation_members'::regclass,
      'public.direct_messages'::regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.conversations'::regclass,
      'public.conversation_members'::regclass,
      'public.direct_messages'::regclass
    )
       OR inheritance.inhparent IN (
         'auth.users'::regclass,
         'public.user_profiles'::regclass,
         'public.conversations'::regclass,
         'public.conversation_members'::regclass,
         'public.direct_messages'::regclass
       )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.conversations'::regclass,
      'public.conversation_members'::regclass,
      'public.direct_messages'::regclass
    )
  ) THEN
    RAISE EXCEPTION
      'direct-message search requires canonical permanent relations';
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
      ('public', 'user_profiles', 2, 'deleted_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 3, 'banned_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 4, 'is_banned', 'boolean'::regtype, true),
      ('public', 'user_profiles', 5, 'ban_expires_at', 'timestamptz'::regtype, false),
      ('public', 'conversations', 1, 'id', 'uuid'::regtype, true),
      ('public', 'conversations', 2, 'user1_id', 'uuid'::regtype, true),
      ('public', 'conversations', 3, 'user2_id', 'uuid'::regtype, true),
      ('public', 'conversation_members', 1, 'conversation_id', 'uuid'::regtype, true),
      ('public', 'conversation_members', 2, 'user_id', 'uuid'::regtype, true),
      ('public', 'conversation_members', 3, 'cleared_before', 'timestamptz'::regtype, false),
      ('public', 'direct_messages', 1, 'id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 2, 'conversation_id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 3, 'sender_id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 4, 'receiver_id', 'uuid'::regtype, true),
      ('public', 'direct_messages', 5, 'content', 'text'::regtype, true),
      ('public', 'direct_messages', 6, 'created_at', 'timestamptz'::regtype, false),
      ('public', 'direct_messages', 7, 'deleted_at', 'timestamptz'::regtype, false)
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
    RAISE EXCEPTION
      'direct-message search has incompatible columns: %',
      v_invalid_columns;
  END IF;

  SELECT attribute.attnum
  INTO STRICT v_conversation_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.conversation_members'::regclass
    AND attribute.attname = 'conversation_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_member_user_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.conversation_members'::regclass
    AND attribute.attname = 'user_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.conversation_members'::regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 2
      AND ARRAY(
        SELECT key_column.attnum
        FROM pg_catalog.unnest(
          index_row.indkey::smallint[]
        ) WITH ORDINALITY AS key_column(attnum, ordinality)
        WHERE key_column.ordinality <= index_row.indnkeyatts
        ORDER BY key_column.ordinality
      ) = ARRAY[v_conversation_attnum, v_member_user_attnum]::smallint[]
  ) THEN
    RAISE EXCEPTION
      'direct-message search requires UNIQUE (conversation_id, user_id) settings';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.conversations AS conversation
    WHERE conversation.user1_id >= conversation.user2_id
  ) OR EXISTS (
    SELECT 1
    FROM public.conversation_members AS member_row
    LEFT JOIN public.conversations AS conversation
      ON conversation.id = member_row.conversation_id
    WHERE conversation.id IS NULL
       OR member_row.user_id NOT IN (
         conversation.user1_id,
         conversation.user2_id
       )
  ) OR EXISTS (
    SELECT 1
    FROM public.direct_messages AS message_row
    LEFT JOIN public.conversations AS conversation
      ON conversation.id = message_row.conversation_id
    WHERE conversation.id IS NULL
       OR conversation.user1_id
            IS DISTINCT FROM LEAST(message_row.sender_id, message_row.receiver_id)
       OR conversation.user2_id
            IS DISTINCT FROM GREATEST(message_row.sender_id, message_row.receiver_id)
  ) THEN
    RAISE EXCEPTION
      'direct-message search found non-canonical participant data';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'search_direct_message_conversation_atomic'
      AND (
        v_search_function IS NULL
        OR function_row.oid <> v_search_function::oid
      )
  ) THEN
    RAISE EXCEPTION 'ambiguous direct-message search overload exists';
  END IF;
END
$preflight$;

LOCK TABLE auth.users,
  public.user_profiles,
  public.conversations,
  public.conversation_members,
  public.direct_messages
  IN SHARE MODE;

CREATE OR REPLACE FUNCTION public.search_direct_message_conversation_atomic(
  p_conversation_id uuid,
  p_actor_id uuid,
  p_query text,
  p_before_created_at timestamptz,
  p_before_id uuid,
  p_from_created_at timestamptz,
  p_to_created_at timestamptz,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_auth_id uuid;
  v_profile_id uuid;
  v_actor_active boolean := false;
  v_query text;
  v_like_pattern text;
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  v_query := pg_catalog.btrim(p_query);
  IF p_conversation_id IS NULL
     OR p_actor_id IS NULL
     OR v_query IS NULL
     OR pg_catalog.char_length(v_query) NOT BETWEEN 1 AND 100
     OR p_limit IS NULL
     OR p_limit NOT BETWEEN 1 AND 50
     OR ((p_before_created_at IS NULL) <> (p_before_id IS NULL))
     OR (
       p_from_created_at IS NOT NULL
       AND p_to_created_at IS NOT NULL
       AND p_from_created_at > p_to_created_at
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  v_like_pattern := pg_catalog.replace(v_query, E'\\', E'\\\\');
  v_like_pattern := pg_catalog.replace(v_like_pattern, '%', E'\\%');
  v_like_pattern := pg_catalog.replace(v_like_pattern, '_', E'\\_');

  -- Keep the request actor active for the response. The authority CTE,
  -- clear boundary, candidate set, extra-row test, and total cursor below are
  -- one MVCC snapshot, so concurrent clear/send/delete commits never mix.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_actor_id::text,
      0
    )
  );

  SELECT auth_user.id
  INTO v_auth_id
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_actor_id
  FOR KEY SHARE;

  IF v_auth_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;

  SELECT
    profile.id,
    profile.deleted_at IS NULL
      AND profile.banned_at IS NULL
      AND NOT (
        profile.is_banned IS TRUE
        AND (
          profile.ban_expires_at IS NULL
          OR profile.ban_expires_at > pg_catalog.statement_timestamp()
        )
      )
  INTO v_profile_id, v_actor_active
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
  FOR SHARE;

  IF v_profile_id IS NULL OR NOT v_actor_active THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;

  WITH authority AS MATERIALIZED (
    SELECT
      conversation.id,
      CASE
        WHEN p_actor_id = conversation.user1_id THEN conversation.user2_id
        ELSE conversation.user1_id
      END AS participant_id,
      participant.deleted_at IS NULL
        AND participant.banned_at IS NULL
        AND NOT (
          participant.is_banned IS TRUE
          AND (
            participant.ban_expires_at IS NULL
            OR participant.ban_expires_at > pg_catalog.statement_timestamp()
          )
        ) AS participant_active,
      member_row.cleared_before
    FROM public.conversations AS conversation
    JOIN public.user_profiles AS participant
      ON participant.id = CASE
        WHEN p_actor_id = conversation.user1_id THEN conversation.user2_id
        ELSE conversation.user1_id
      END
    LEFT JOIN public.conversation_members AS member_row
      ON member_row.conversation_id = conversation.id
     AND member_row.user_id = p_actor_id
    WHERE conversation.id = p_conversation_id
      AND p_actor_id IN (conversation.user1_id, conversation.user2_id)
  ),
  candidates AS MATERIALIZED (
    SELECT
      message_row.id,
      message_row.sender_id,
      message_row.content,
      message_row.created_at
    FROM authority
    JOIN public.direct_messages AS message_row
      ON message_row.conversation_id = authority.id
    WHERE authority.participant_active
      AND message_row.deleted_at IS NULL
      AND message_row.created_at IS NOT NULL
      AND (
        authority.cleared_before IS NULL
        OR message_row.created_at > authority.cleared_before
      )
      AND (
        p_from_created_at IS NULL
        OR message_row.created_at >= p_from_created_at
      )
      AND (
        p_to_created_at IS NULL
        OR message_row.created_at <= p_to_created_at
      )
      AND (
        p_before_created_at IS NULL
        OR message_row.created_at < p_before_created_at
        OR (
          message_row.created_at = p_before_created_at
          AND message_row.id < p_before_id
        )
      )
      AND message_row.content ILIKE '%' || v_like_pattern || '%' ESCAPE E'\\'
    ORDER BY message_row.created_at DESC, message_row.id DESC
    LIMIT p_limit + 1
  ),
  page AS MATERIALIZED (
    SELECT candidate.id,
      candidate.sender_id,
      candidate.content,
      candidate.created_at
    FROM candidates AS candidate
    ORDER BY candidate.created_at DESC, candidate.id DESC
    LIMIT p_limit
  )
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM authority) THEN
      pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'NOT_FOUND'
      )
    WHEN NOT (
      SELECT authority.participant_active
      FROM authority
    ) THEN
      pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'PARTICIPANT_UNAVAILABLE'
      )
    ELSE
      pg_catalog.jsonb_build_object(
        'success', true,
        'actor_id', p_actor_id,
        'conversation_id', p_conversation_id,
        'query', v_query,
        'from_created_at', p_from_created_at,
        'to_created_at', p_to_created_at,
        'messages', COALESCE(
          (
            SELECT pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'id', page.id,
                'sender_id', page.sender_id,
                'content', page.content,
                'created_at', page.created_at
              )
              ORDER BY page.created_at DESC, page.id DESC
            )
            FROM page
          ),
          '[]'::jsonb
        ),
        'has_more', (
          SELECT pg_catalog.count(*) > p_limit
          FROM candidates
        ),
        'next_cursor', CASE
          WHEN (
            SELECT pg_catalog.count(*) > p_limit
            FROM candidates
          ) THEN (
            SELECT pg_catalog.jsonb_build_object(
              'before', page.created_at,
              'before_id', page.id
            )
            FROM page
            ORDER BY page.created_at, page.id
            LIMIT 1
          )
          ELSE 'null'::jsonb
        END
      )
  END
  INTO STRICT v_result;

  RETURN v_result;
END
$function$;

ALTER FUNCTION public.search_direct_message_conversation_atomic(
  uuid,
  uuid,
  text,
  timestamptz,
  uuid,
  timestamptz,
  timestamptz,
  integer
) OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.search_direct_message_conversation_atomic(uuid,uuid,text,timestamp with time zone,uuid,timestamp with time zone,timestamp with time zone,integer)'::regprocedure;
  v_owner oid;
  v_source text;
  v_grantee record;
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
    ON FUNCTION public.search_direct_message_conversation_atomic(
      uuid, uuid, text, timestamptz, uuid, timestamptz, timestamptz, integer
    )
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.search_direct_message_conversation_atomic(
      uuid, uuid, text, timestamptz, uuid, timestamptz, timestamptz, integer
    )
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-direct-message-conversation-search:v1:'
      || pg_catalog.md5(v_source)
  );

  IF pg_catalog.strpos(v_source, 'account-recovery-admission:') = 0
     OR pg_catalog.strpos(v_source, 'one MVCC snapshot') = 0
     OR pg_catalog.strpos(v_source, 'WITH authority AS MATERIALIZED') = 0
     OR pg_catalog.strpos(v_source, 'message_row.deleted_at IS NULL') = 0
     OR pg_catalog.strpos(
       v_source,
       'message_row.created_at > authority.cleared_before'
     ) = 0
     OR pg_catalog.strpos(v_source, 'message_row.id < p_before_id') = 0
     OR pg_catalog.strpos(v_source, $$ESCAPE E'\\'$$) = 0
     OR pg_catalog.strpos(v_source, 'LIMIT p_limit + 1') = 0
  THEN
    RAISE EXCEPTION
      'atomic direct-message conversation-search function contract drifted';
  END IF;
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.search_direct_message_conversation_atomic(uuid,uuid,text,timestamp with time zone,uuid,timestamp with time zone,timestamp with time zone,integer)'::regprocedure;
  v_service_oid oid := pg_catalog.to_regrole('service_role')::oid;
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function
    AND function_row.prokind = 'f'
    AND function_row.proowner = pg_catalog.to_regrole('postgres')::oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'jsonb'::regtype
    AND NOT function_row.proretset
    AND function_row.pronargs = 8
    AND function_row.pronargdefaults = 0
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.obj_description(v_function, 'pg_proc') IS DISTINCT FROM
       'atomic-direct-message-conversation-search:v1:'
         || pg_catalog.md5(v_source)
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_function, 'EXECUTE'
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
         AND acl_entry.grantee <> function_row.proowner
         AND NOT (
           acl_entry.grantee = v_service_oid
           AND acl_entry.privilege_type = 'EXECUTE'
           AND NOT acl_entry.is_grantable
         )
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_namespace AS function_schema
         ON function_schema.oid = function_row.pronamespace
       WHERE function_schema.nspname = 'public'
         AND function_row.proname =
           'search_direct_message_conversation_atomic'
         AND function_row.oid <> v_function
     )
  THEN
    RAISE EXCEPTION
      'direct-message conversation-search service-only RPC drifted';
  END IF;
END
$postflight$;

SELECT public.install_active_authenticated_subject_mutation_barriers();
SELECT public.assert_active_authenticated_subject_mutation_barriers();

NOTIFY pgrst, 'reload schema';

COMMIT;
